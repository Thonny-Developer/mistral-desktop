'use strict';

const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const mistral = require('./mistral');
const agent = require('./agent');
const tools = require('./tools');
const skills = require('./skills');
const extract = require('./extract');
const plugins = require('./plugins');
const { createConsoleManager } = require('./consoles');
const { initAutoUpdater, checkForUpdatesManually } = require('./updater');

const isDev = process.argv.includes('--dev');

/* ------------------------------------------------------------------ *
 *  Persistent store
 *  - `settings`  : user preferences (model, sliders, theme, ...)
 *  - `sessions`  : chat history [{id,title,model,createdAt,...,messages}]
 *  - `presets`   : system-prompt presets
 *  - `windowState`: last size/position
 *  The API key is stored separately, encrypted with safeStorage when available.
 * ------------------------------------------------------------------ */
const store = new Store({
  name: 'mistral-desktop',
  defaults: {
    settings: {
      provider: 'mistral', // 'mistral' | 'lmstudio' (local OpenAI-compatible)
      endpoint: mistral.DEFAULT_ENDPOINT,
      lmstudioEndpoint: mistral.LMSTUDIO_ENDPOINT,
      model: mistral.DEFAULT_MODEL,
      temperature: 0.7,
      topP: 1,
      maxTokens: 0, // 0 = unlimited
      stream: true,
      renderMarkdown: true,
      theme: 'dark',
      fontSize: 14,
      collapseSidebar: false,
      reasoningLevel: 'medium',
      aiPermissionMode: 'default',
      activePresetId: 'general',
      locale: 'ru',
      devMode: false,            // developer mode: per-message "what went to the API" inspector
      devPeekFormat: 'pretty',   // inspector view: 'pretty' | 'json'
      // Proactive rate limiter (see mistral.js rateGate): cap simultaneous
      // requests and space their starts so bursts glide under Mistral's limit
      // instead of tripping 429s. Defaults suit the free tier (serialise, no
      // artificial spacing); raise the interval if you still hit limits.
      maxConcurrentRequests: 1,
      minRequestIntervalMs: 0
    },
    firstRunCompleted: false,
    sessions: [],
    presets: defaultPresets(),
    workingDir: '',
    todos: [],
    windowState: { width: 1180, height: 760, x: undefined, y: undefined, maximized: false }
  }
});

/** Built-in system-prompt presets shipped on first run. */
function defaultPresets() {
  return [
    {
      id: 'general',
      name: 'General',
      content: 'You are a helpful, concise assistant. Answer clearly and accurately.'
    },
    {
      id: 'code',
      name: 'Code Assistant',
      content:
        'You are a senior software engineer.\nAnswer concisely. Prefer code over prose.\n\n- Always use modern syntax (ES2022+, async/await).\n- When refactoring, preserve public APIs.\n- Explain trade-offs only when asked.'
    },
    {
      id: 'translator',
      name: 'Translator',
      content:
        'You are a professional translator. Translate the user\'s text faithfully, preserving tone and formatting. Do not add commentary unless asked.'
    },
    {
      id: 'analyst',
      name: 'Analyst',
      content:
        'You are a rigorous data and business analyst. Break problems down, state assumptions explicitly, and support conclusions with reasoning.'
    }
  ];
}

let mainWindow = null;
// Tracks the in-flight streaming request so it can be aborted.
let activeController = null;
// When the agent pauses for a user decision (plan/tool/bash approval), this
// holds the resolver for the pending promise. Resolved by 'agent:respond'.
let pendingApproval = null;

/** Resolve any pending approval with the given answer and clear it. */
function settleApproval(approved) {
  if (pendingApproval) {
    const resolve = pendingApproval;
    pendingApproval = null;
    resolve(approved);
  }
}

/* ------------------------------------------------------------------ *
 *  Long-term memory
 *  A plain Markdown file in the app's userData dir that the assistant can
 *  append to (via <remember>…</remember> blocks) and the user can edit in
 *  Settings. Injected into every request as a leading system message.
 * ------------------------------------------------------------------ */
const memoryPath = path.join(app.getPath('userData'), 'memory.md');
const MEMORY_HEADER =
  '# Mist Desktop - Memory\n\nDurable facts about the user and ongoing work. Edit freely.\n';

function ensureMemory() {
  if (!fs.existsSync(memoryPath)) fs.writeFileSync(memoryPath, MEMORY_HEADER, 'utf-8');
}
function readMemory() {
  try { ensureMemory(); return fs.readFileSync(memoryPath, 'utf-8'); }
  catch { return ''; }
}
function writeMemory(content) {
  try { fs.writeFileSync(memoryPath, content ?? '', 'utf-8'); return true; }
  catch { return false; }
}
function appendMemory(items) {
  if (!items || !items.length) return;
  const current = readMemory().replace(/\s*$/, '');
  const lines = items.map((i) => `- ${i.replace(/\s+/g, ' ').trim()}`).join('\n');
  writeMemory(`${current}\n${lines}\n`);
}

function projectFilePath() {
  const root = store.get('workingDir');
  return path.join(root || app.getPath('userData'), 'MISTRAL.md');
}

function readProjectFile() {
  const file = projectFilePath();
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
}

function initProjectFile() {
  const file = projectFilePath();
  if (fs.existsSync(file)) return { ok: false, path: file };
  const content = `# MISTRAL Project Notes\n\n` +
    `This file contains the project essence and ongoing development notes for the current workspace.\n\n` +
    `Use it to capture the project goal, architecture, and key implementation details.\n`;
  fs.writeFileSync(file, content, 'utf-8');
  return { ok: true, path: file };
}

function appendProjectFile(notes) {
  const file = projectFilePath();
  if (!fs.existsSync(file)) fs.writeFileSync(file, '# MISTRAL Project Notes\n\n', 'utf-8');
  fs.appendFileSync(file, `\n\n${notes.trim()}\n`, 'utf-8');
  return file;
}

/* ------------------------------------------------------------------ *
 *  Agent system prompt
 * ------------------------------------------------------------------ */
const AGENT_INSTRUCTIONS = [
  'You are Mistral Desktop, an agentic assistant that runs on the user\'s computer and can take real actions. You have native function tools for files, the todo list, shell commands, and long-term memory. Call them through the API\'s tool-calling — never write tool calls as plain text.',
  '',
  'Operating procedure — follow it every time you do real work:',
  '1. Understand the request. Ask only if you are genuinely blocked.',
  '2. Explore before changing: use search_files to locate the relevant code, list_files to see the structure, and read_file to read just the lines you need. Learn the actual current state — never write or edit a file you have not read this session.',
  '3. Plan: for multi-step work, create todos (add_todo) describing concrete, verifiable steps.',
  '4. Act in small steps. Prefer edit_file (a targeted snippet replace) over write_file; use write_file only for new files or a full rewrite, and always pass the COMPLETE content.',
  '5. Verify: after changes, check your work — re-read the file, and when the project supports it, run its tests / build / lint (in a console) and fix any failures. Treat the task as done only once it is verified.',
  '6. Keep the plan honest: complete_todo each item as you finish it.',
  '',
  'Tools at a glance:',
  '- set_working_folder — pick the project folder. Only relevant when the task actually needs files (working on a project, reading/editing local files); never for a plain question or chat. If you begin any file/shell action without a folder set, the app automatically asks the user to choose the project directory first, then runs the action.',
  '- search_files — grep the workspace by regex to find where something is (returns file:line: content). list_files — list a directory, or pass a glob (e.g. **/*.js) for a recursive match. read_file — read a file with line numbers; pass offset/limit to read a specific range. read_file auto-extracts text from documents (PDF, DOCX, PPTX, XLSX, …).',
  '- extract_file — pull plain text out of a document/binary (PDF, presentations, spreadsheets, ODF, EPUB, ZIP). Only the extracted text enters the context, never the raw bytes.',
  '- write_file — create or fully overwrite a file (full content).',
  '- edit_file — replace an exact, unique snippet (old_string → new_string) in an existing file. Preferred for edits.',
  '- delete_file — delete a file or folder.',
  '- exec_bash — run a single one-shot shell command (fresh process, no state kept).',
  '- console_open / console_exec / console_close / console_list — persistent shell sessions. Open a console once and run several commands in it; the working directory and environment carry over between commands (unlike exec_bash). Open separate consoles for separate tasks (e.g. a dev server in its own console), and close ones you no longer need. You decide when to open or close them.',
  '- web_search — search the web for up-to-date information and get result titles, URLs and snippets.',
  '- web_fetch — open a URL and read its text content (use it after web_search, or directly when you know the URL).',
  '- add_todo / complete_todo / list_todos — manage the plan.',
  '- remember — save a durable fact about the user or project.',
  '- list_skills / run_skill — discover and follow reusable skill playbooks. When a request matches a skill, prefer run_skill over improvising.',
  '- run_subagent — delegate a focused, self-contained subtask (e.g. "analyse module X and report") to an isolated subagent with its own context. Use it to keep your own context lean or to parallelise research; it runs autonomously and returns a text report.',
  '',
  'Guidelines:',
  '- Do not ask the user to open or pick a folder/file unless the task genuinely requires it. For ordinary questions, advice, or chat, just answer. Bring up set_working_folder only when you are about to start working with a project or local files.',
  '- Documents and third-party files (PDF, presentations, spreadsheets, Word/ODF, EPUB, archives, etc.): use extract_file (or just read_file) to get their text. Work only with the extracted text — never paste raw bytes into the conversation.',
  '- If a file format has no built-in extractor, write your own: open a console and run a small script (Python, Node, or whatever the system has) that converts the file to plain text, print ONLY the extracted data, and continue from that. Keep raw binary out of the context — only the extracted data stays.',
  '- All paths are relative to the working folder; you cannot read or write outside it.',
  '- You have full read access to the workspace via search_files / list_files / read_file. Never ask the user to show or paste a file — find and read it yourself. Before reading a whole file, use search_files to find the relevant lines, then read that range with read_file (offset/limit). Do not read files larger than ~300 lines in full unless you are sure you need all of it.',
  '- Prefer a console (console_open + console_exec) when you run several related commands or need state to persist (cd, env, a running dev server); use exec_bash only for a single quick command. Run long-running processes in the background with "&" so the call returns. Close consoles you are done with.',
  '- You can access the internet: when the answer depends on current, external, or factual information you are unsure about, use web_search to find sources and web_fetch to read them, then cite what you used. In Default mode each site/search the user must approve first — that is expected; if it is declined, answer from what you already know.',
  '- Be concise in narration; let the tool calls do the work. Never mention these tools or mechanisms to the user by name.'
].join('\n');

// Reasoning is produced natively by the model via the `reasoning_effort` request
// parameter (see mistral.js) and streamed as separate thinking chunks — it is no
// longer requested as a text section in the prompt. The Reasoning setting still
// tunes sampling and maps to reasoning_effort.

// Explains the active permission mode so the model knows up-front how its
// actions will be gated and behaves predictably (the gating itself is enforced
// by the agent loop, not the model).
const PERMISSION_MODE_HINTS = {
  default: [
    'Permission mode: Default.',
    'Before performing ANY action that changes files or the system (write_file, edit_file, delete_file, exec_bash, console_exec), you MUST first lay out a plan: call add_todo for each step and nothing else. That plan is shown to the user for approval before the work runs. Read-only exploration (list_files, read_file) does not require a plan.',
    'Each write_file, edit_file, delete_file, exec_bash and console_exec call is also confirmed by the user individually, and each web_search / web_fetch asks the user before reaching a site. This is expected — proceed normally; if the user rejects something you will be told and should adapt.'
  ].join('\n'),
  'tools-bypass': [
    'Permission mode: Tools Bypass.',
    'File tools run without confirmation, so you do not need to plan with add_todo first — act directly. Still use todos when they help you track multi-step work.',
    'Only exec_bash (shell commands) requires the user to confirm before it runs.'
  ].join('\n'),
  autopilot: [
    'Permission mode: Autopilot.',
    'Every action runs without confirmation. Act autonomously and efficiently, but be careful with irreversible operations (delete_file, overwriting files with write_file, destructive shell commands) — only do them when clearly necessary, and prefer edit_file for changes.'
  ].join('\n')
};

/**
 * Static half of the agent system prompt: the instructions, permission hint and
 * skill list. These stay byte-identical across a whole chat, so Mistral can
 * serve this prefix (plus the transcript that follows it) from its prompt cache.
 * Anything that changes mid-run lives in buildLiveState instead, appended AFTER
 * the transcript so editing it never invalidates the cached prefix.
 */
function buildStaticSystem(settings) {
  const permMode = (settings && settings.aiPermissionMode) || 'default';
  const permHint = PERMISSION_MODE_HINTS[permMode] || PERMISSION_MODE_HINTS.default;
  const skillList = skills.listSkills(store.get('workingDir') || '');
  const skillStr = skillList.length
    ? skillList.map((s) => `- ${s.name}${s.argumentHint ? ` ${s.argumentHint}` : ''} — ${s.description || ''}`.trimEnd()).join('\n')
    : '(none)';
  return [
    AGENT_INSTRUCTIONS,
    '',
    permHint,
    '',
    'Available skills (invoke with run_skill):',
    skillStr
  ].join('\n');
}

/**
 * Live half of the agent system prompt: working folder, todos, memory and
 * project notes. Rebuilt on every turn and appended to the very end of the
 * message array, so the agent mutating todos/memory/folder mid-run only
 * reprices this small tail — the instruction + history prefix stays cached.
 */
function buildLiveState() {
  const work = store.get('workingDir') || '';
  const todos = store.get('todos') || [];
  const todoStr = todos.length
    ? todos.map((t) => `[${t.done ? 'x' : ' '}] (${t.id}) ${t.text}`).join('\n')
    : '(none)';
  const mem = readMemory().trim();
  const projectNotes = readProjectFile().trim();
  return [
    'Current live state (refreshed every step):',
    `Working folder: ${work || '(none — set one with set_working_folder only when the task needs local files)'}`,
    '',
    'Open todos:',
    todoStr,
    '',
    'Current long-term memory:',
    mem || '(empty)',
    projectNotes ? ['', 'Project notes from MISTRAL.md:', projectNotes] : []
  ].flat().join('\n');
}

/** Full agent system text (static + live) — used for the context-size gauge. */
function buildAgentSystem(settings) {
  return `${buildStaticSystem(settings)}\n\n${buildLiveState()}`;
}

/* ------------------------------------------------------------------ *
 *  Window lifecycle
 * ------------------------------------------------------------------ */
function createWindow() {
  const state = store.get('windowState');

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0e0e10',
    frame: false, // custom titlebar drawn in the renderer
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false // preload uses Node (electron-store via IPC stays in main)
    }
  });

  if (state.maximized) mainWindow.maximize();

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    // Forward renderer console + load failures to the terminal during dev.
    mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
      console.log(`[renderer:${level}] ${message} (${source}:${line})`);
    });
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.log(`[did-fail-load] ${code} ${desc} ${url}`);
    });
  }

  // Persist window geometry on resize/move (debounced) and on close.
  const persist = debounce(saveWindowState, 400);
  mainWindow.on('resize', persist);
  mainWindow.on('move', persist);
  mainWindow.on('close', saveWindowState);

  // Keep maximize state in sync for the renderer's titlebar button.
  mainWindow.on('maximize', () => mainWindow.webContents.send('window:maximized', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:maximized', false));

  // Open external links in the system browser, never in-app.
  // `setWindowOpenHandler` covers window.open / target=_blank; `will-navigate`
  // covers ordinary <a href> clicks, which would otherwise replace the app UI
  // with the remote page.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (/^https?:|^mailto:/i.test(url)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function saveWindowState() {
  if (!mainWindow) return;
  const maximized = mainWindow.isMaximized();
  // When maximized, keep the previous restored bounds so unmaximize is sane.
  if (!maximized) {
    const b = mainWindow.getBounds();
    store.set('windowState', { ...b, maximized: false });
  } else {
    store.set('windowState', { ...store.get('windowState'), maximized: true });
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ------------------------------------------------------------------ *
 *  Secure API key storage (safeStorage with plaintext fallback)
 * ------------------------------------------------------------------ */
function setApiKey(key) {
  if (!key) {
    store.delete('apiKey');
    store.delete('apiKeyEnc');
    return;
  }
  if (safeStorage.isEncryptionAvailable()) {
    const enc = safeStorage.encryptString(key);
    store.set('apiKeyEnc', enc.toString('base64'));
    store.delete('apiKey'); // never keep a plaintext copy
  } else {
    store.set('apiKey', key);
    store.delete('apiKeyEnc');
  }
}

function getApiKey() {
  const enc = store.get('apiKeyEnc');
  if (enc && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'));
    } catch {
      return '';
    }
  }
  return store.get('apiKey', '');
}

/* ------------------------------------------------------------------ *
 *  Plugins
 *  Background integrations (e.g. the Telegram bot) that drive the SAME
 *  agent engine the in-app chat uses. `runPluginAgent` is the bridge: it
 *  mirrors the `mistral:send` handler but is parameterised by the plugin
 *  (its own messages, permission mode, approval callback and abort signal),
 *  and returns the final answer instead of streaming to the renderer.
 * ------------------------------------------------------------------ */
async function runPluginAgent({ messages, permissionMode, requestApproval, onEvent, signal }) {
  const apiKey = getApiKey();
  const settings = { ...store.get('settings'), aiPermissionMode: permissionMode || 'default' };
  // LM Studio runs locally without a key; only Mistral needs one.
  if (settings.provider !== 'lmstudio' && !apiKey) {
    return { ok: false, error: 'API-ключ Mistral не задан в настройках приложения.' };
  }
  // The folder is shared with the in-app chat; require it up-front so a
  // file/shell action never pops a desktop folder dialog from a remote trigger.
  if (!store.get('workingDir')) return { ok: false, error: 'no-workdir' };

  const baseMessages = [{ role: 'system', content: buildStaticSystem(settings) }, ...messages];
  const consoles = createConsoleManager();
  let finalContent = '';
  let errored = null;
  const emit = (msg) => {
    if (msg.type === 'done') finalContent = msg.content || '';
    if (msg.type === 'error') errored = msg.message;
    try { onEvent?.(msg); } catch { /* plugin sink errors are not fatal */ }
  };
  const ctx = {
    store, getWindow: () => mainWindow, appendMemory, signal, consoles,
    settings, apiKey, emit, subagentDepth: 0
  };
  try {
    await agent.run({ baseMessages, liveState: buildLiveState, settings, apiKey, signal, emit, requestApproval, ctx });
    if (errored) return { ok: false, error: errored };
    return { ok: true, content: finalContent };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    consoles.closeAll();
  }
}

const pluginManager = plugins.createManager({
  store,
  userDataDir: app.getPath('userData'),
  runAgent: runPluginAgent,
  getWindow: () => mainWindow
});
// Forward plugin log/status events to the renderer (Settings → Plugins).
pluginManager.on((ev) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('plugins:event', ev);
});

/* ------------------------------------------------------------------ *
 *  IPC: persistent store
 * ------------------------------------------------------------------ */
ipcMain.handle('store:get', (_e, key) => store.get(key));
ipcMain.handle('store:set', (_e, key, value) => {
  store.set(key, value);
  return true;
});
ipcMain.handle('store:delete', (_e, key) => {
  store.delete(key);
  return true;
});

// Long-term memory channels.
ipcMain.handle('memory:get', () => readMemory());
ipcMain.handle('memory:set', (_e, content) => writeMemory(content));
ipcMain.handle('memory:path', () => memoryPath);

// Working folder (agent file sandbox).
ipcMain.handle('workspace:get', () => store.get('workingDir') || '');
ipcMain.handle('workspace:pick', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a working folder',
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths[0]) return store.get('workingDir') || '';
  store.set('workingDir', res.filePaths[0]);
  return res.filePaths[0];
});
ipcMain.handle('workspace:clear', () => { store.set('workingDir', ''); return ''; });
// Set the active working folder to a specific path (used to bind a folder to a
// chat — restored when a saved session is opened).
ipcMain.handle('workspace:set', (_e, dir) => {
  store.set('workingDir', dir || '');
  return store.get('workingDir') || '';
});

// Skills (Markdown playbooks). Discovery is re-read on every call so edits in
// the user/project folders show up without a restart.
ipcMain.handle('skills:list', () => skills.listSkills(store.get('workingDir') || ''));
ipcMain.handle('skills:render', (_e, name, args) =>
  skills.renderSkill(name, args || '', store.get('workingDir') || ''));
ipcMain.handle('skills:save', (_e, skill) => skills.saveSkill(skill || {}));
ipcMain.handle('skills:delete', (_e, name) => skills.deleteSkill(name));
ipcMain.handle('skills:dir', () => skills.ensureUserDir());
ipcMain.handle('skills:openDir', async () => {
  const dir = skills.ensureUserDir();
  await shell.openPath(dir);
  return dir;
});

// Plugins (background integrations). State/config live in the store; running
// instances live in the manager. Log/status events are pushed on 'plugins:event'.
ipcMain.handle('plugins:list', () => pluginManager.list());
ipcMain.handle('plugins:start', (_e, id) => pluginManager.start(id));
ipcMain.handle('plugins:stop', (_e, id) => pluginManager.stop(id));
ipcMain.handle('plugins:getConfig', (_e, id) => pluginManager.getConfig(id));
ipcMain.handle('plugins:setConfig', (_e, id, config) => { pluginManager.setConfig(id, config); return true; });
ipcMain.handle('plugins:openDir', async () => {
  const dir = pluginManager.openDir();
  await shell.openPath(dir);
  return dir;
});

// Extract text from a file attached in the composer. The renderer sends the
// raw bytes (ArrayBuffer); we pull out plain text so only the extracted data —
// never the raw bytes — travels into the conversation/context.
const MAX_ATTACH_BYTES = 25 * 1024 * 1024; // 25 MB — "not too heavy"
const MAX_ATTACH_CHARS = 60_000;           // cap extracted text per attachment
ipcMain.handle('docs:extract', (_e, { name, data } = {}) => {
  try {
    const buf = Buffer.from(data || []);
    if (!buf.length) return { ok: false, error: 'пустой файл' };
    if (buf.length > MAX_ATTACH_BYTES) {
      return { ok: false, error: `файл слишком большой (${(buf.length / 1048576).toFixed(1)} МБ, лимит 25 МБ)` };
    }
    const r = extract.extractAttachment(name || 'file', buf);
    if (!r.ok) return { ok: false, ext: r.ext, error: r.error };
    let text = r.text || '';
    const truncated = text.length > MAX_ATTACH_CHARS;
    if (truncated) text = text.slice(0, MAX_ATTACH_CHARS) + '\n…(текст обрезан)';
    return { ok: true, ext: r.ext, text, chars: text.length, truncated };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('project:read', () => readProjectFile());
ipcMain.handle('project:init', () => initProjectFile());
ipcMain.handle('project:exists', () => fs.existsSync(projectFilePath()));
ipcMain.handle('project:append', (_e, notes) => {
  appendProjectFile(notes);
  return { ok: true };
});

// Todos (shared between the agent and the UI).
ipcMain.handle('todos:get', () => store.get('todos') || []);
ipcMain.handle('todos:toggle', (_e, id) => {
  const todos = store.get('todos') || [];
  const t = todos.find((x) => x.id === id);
  if (t) t.done = !t.done;
  store.set('todos', todos);
  return todos;
});
ipcMain.handle('todos:clear', () => { store.set('todos', []); return []; });
// Replace the active todo list (used to bind todos to a chat — restored when a
// saved session is opened, cleared for a new chat).
ipcMain.handle('todos:set', (_e, todos) => {
  store.set('todos', Array.isArray(todos) ? todos : []);
  return store.get('todos') || [];
});

// API key gets its own channels so the encrypted value never leaves main verbatim.
ipcMain.handle('apikey:get', () => getApiKey());
ipcMain.handle('apikey:has', () => Boolean(getApiKey()));
ipcMain.handle('apikey:set', (_e, key) => {
  setApiKey(key);
  return true;
});
ipcMain.handle('apikey:encrypted', () => safeStorage.isEncryptionAvailable());

/* ------------------------------------------------------------------ *
 *  IPC: window controls
 * ------------------------------------------------------------------ */
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());
ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false);

/* ---- app / updates ---- */
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('updates:check', () => checkForUpdatesManually());

/* ------------------------------------------------------------------ *
 *  IPC: Mistral API
 *  Streaming uses fire-and-forget `send` + push events on 'mistral:stream'.
 * ------------------------------------------------------------------ */
ipcMain.on('mistral:send', async (event, { messages, allowedTools, sessionId }) => {
  const stored = store.get('settings');
  // A stable per-conversation cache key lets Mistral reuse the fixed
  // instruction+tools prefix across this chat's turns and messages (billed at a
  // fraction of the input price). Scoped by chat so unrelated chats stay isolated.
  const settings = sessionId ? { ...stored, promptCacheKey: `chat:${sessionId}` } : stored;
  const apiKey = getApiKey();

  // Abort any prior in-flight request before starting a new one.
  if (activeController) activeController.abort();
  settleApproval(false); // drop any approval left dangling by the previous run
  activeController = new AbortController();
  const controller = activeController;

  const reply = (msg) => {
    if (!event.sender.isDestroyed()) event.sender.send('mistral:stream', msg);
  };

  // Pause the agent loop until the renderer answers the approval request.
  // Resolved by the 'agent:respond' channel (or false on abort/new request).
  const requestApproval = (payload) => {
    reply(payload);
    return new Promise((resolve) => { pendingApproval = resolve; });
  };

  // Lead with the STATIC agent system message (instructions + skills) so the
  // whole instruction+transcript prefix stays cacheable. Live state (folder,
  // todos, memory) is appended as a trailing message on every turn by the loop.
  const baseMessages = [{ role: 'system', content: buildStaticSystem(settings) }, ...messages];
  // Persistent shell sessions scoped to this request — closed when it finishes
  // so no shells leak between messages.
  const consoles = createConsoleManager();
  // ctx carries everything the tool layer (incl. the subagent tool) needs:
  // the store, the active window, memory append, the abort signal, the
  // console manager, and — for spawning subagents — the resolved settings,
  // API key, event sink and the current subagent depth (0 at the top level).
  const ctx = {
    store, getWindow: () => mainWindow, appendMemory, signal: controller.signal, consoles,
    settings, apiKey, emit: reply, subagentDepth: 0
  };

  try {
    await agent.run({
      baseMessages,
      liveState: buildLiveState,
      settings,
      apiKey,
      signal: controller.signal,
      emit: reply,
      requestApproval,
      ctx,
      allowedTools
    });
  } catch (err) {
    reply({ type: 'error', message: err.message, code: err.code || 'unknown' });
  } finally {
    consoles.closeAll();
    if (activeController === controller) activeController = null;
  }
});

ipcMain.on('mistral:abort', () => {
  if (activeController) activeController.abort();
  settleApproval(false); // unblock the loop if it's waiting on approval
});

// Renderer's answer to a pending plan/tool/bash approval request.
ipcMain.on('agent:respond', (_e, approved) => settleApproval(Boolean(approved)));

// Sizes (in characters) of the fixed parts of the context window — the system
// prompt and the tool schemas — so the renderer can show a usage breakdown.
ipcMain.handle('context:stats', () => {
  const settings = store.get('settings');
  return {
    systemChars: buildAgentSystem(settings).length,
    toolsChars: JSON.stringify(tools.TOOL_SCHEMAS).length
  };
});

ipcMain.handle('mistral:test', async () => {
  const settings = store.get('settings');
  return mistral.testConnection({ settings, apiKey: getApiKey() });
});

ipcMain.handle('mistral:models', async () => {
  const settings = store.get('settings');
  try {
    return await mistral.listModels({ settings, apiKey: getApiKey() });
  } catch {
    // LM Studio has no static catalogue — surface an empty list instead of
    // Mistral names the local server can't serve.
    return settings.provider === 'lmstudio' ? [] : mistral.SUPPORTED_MODELS;
  }
});

// Structured output: force the reply into a JSON schema and return the parsed
// object. For extraction/classification and anything that must be machine-read.
ipcMain.handle('mistral:structured', async (_e, { messages, schema, schemaName } = {}) => {
  const settings = store.get('settings');
  try {
    return await mistral.sendStructured({
      messages: Array.isArray(messages) ? messages : [],
      schema, schemaName, settings, apiKey: getApiKey()
    });
  } catch (e) {
    return { error: e.message, code: e.code || 'unknown' };
  }
});

// Fill-in-the-middle (Codestral): generate the code between `prompt` and
// `suffix`. Non-streaming over IPC — returns the completed middle in one shot.
ipcMain.handle('mistral:fim', async (_e, { prompt, suffix, stop, maxTokens, temperature } = {}) => {
  const settings = store.get('settings');
  try {
    return await mistral.fimComplete({
      prompt, suffix, stop, maxTokens, temperature,
      settings, apiKey: getApiKey(), stream: false
    });
  } catch (e) {
    return { error: e.message, code: e.code || 'unknown' };
  }
});

/* ------------------------------------------------------------------ *
 *  IPC: export a session to disk (.md / .json)
 * ------------------------------------------------------------------ */
ipcMain.handle('session:export', async (_e, { session, format }) => {
  const ext = format === 'json' ? 'json' : 'md';
  const safeTitle = (session.title || 'session').replace(/[^\w\- ]+/g, '').slice(0, 60).trim() || 'session';

  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export session',
    defaultPath: `${safeTitle}.${ext}`,
    filters:
      ext === 'json'
        ? [{ name: 'JSON', extensions: ['json'] }]
        : [{ name: 'Markdown', extensions: ['md'] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  const content = ext === 'json' ? JSON.stringify(session, null, 2) : sessionToMarkdown(session);
  await fs.promises.writeFile(filePath, content, 'utf-8');
  return { ok: true, filePath };
});

function formatSessionContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part.type === 'text') return part.text || '';
      if (part.type === 'image_url') {
        const imageRef = part.image_url || part.imageUrl;
        if (typeof imageRef === 'string') {
          return imageRef.startsWith('data:') ? '![attached image]' : `![image](${imageRef})`;
        }
        return '![attached image]';
      }
      return typeof part.text === 'string' ? part.text : '';
    }).filter(Boolean).join(' ');
  }
  if (typeof content === 'object') {
    return formatSessionContent(content.content || content.text);
  }
  return String(content);
}

function sessionToMarkdown(session) {
  const lines = [];
  lines.push(`# ${session.title || 'Untitled session'}`, '');
  lines.push(`- **Model:** ${session.model || 'unknown'}`);
  lines.push(`- **Created:** ${new Date(session.createdAt).toLocaleString()}`);
  lines.push(`- **Messages:** ${session.messageCount ?? session.messages?.length ?? 0}`, '', '---', '');
  for (const m of session.messages || []) {
    const who = m.role === 'user' ? '## You' : m.role === 'assistant' ? '## Mistral' : `## ${m.role}`;
    lines.push(who, '', formatSessionContent(m.content), '');
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 *  App lifecycle
 * ------------------------------------------------------------------ */
app.whenReady().then(() => {
  createWindow();
  pluginManager.initAutostart(); // bring back up any plugin the user had enabled
  initAutoUpdater(() => mainWindow); // check GitHub Releases for a newer version
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
