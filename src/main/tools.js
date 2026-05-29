'use strict';

/**
 * Agent tool layer (main process).
 *
 * Each tool takes a parsed action object + a `ctx` ({ store, getWindow,
 * appendMemory }) and returns a uniform result:
 *   { ok, summary, output, error?, todosChanged?, workspaceChanged? }
 *     - summary : short human string for the chat UI
 *     - output  : text fed back to the model as the tool result
 *
 * All filesystem access is sandboxed to the user's chosen working folder;
 * paths that escape it are rejected.
 */

const { dialog } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { exec: execCommand } = require('child_process');

const MAX_READ_BYTES = 20_000; // keep file reads from blowing the context window
const IGNORE = new Set(['node_modules', '.git', '.DS_Store']);

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** Resolve a relative path inside the working folder, or throw. */
function resolveInWork(ctx, rel) {
  const work = ctx.store.get('workingDir');
  if (!work) throw new Error('No working folder set — call set_working_folder first.');
  const root = path.resolve(work);
  const abs = path.resolve(root, rel || '.');
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('Path escapes the working folder.');
  }
  return abs;
}

/* ---------------- filesystem tools ---------------- */
async function pickFolder(ctx) {
  const win = ctx.getWindow();
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a working folder',
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths[0]) {
    return { ok: false, summary: 'folder selection cancelled', output: 'User cancelled folder selection.' };
  }
  ctx.store.set('workingDir', res.filePaths[0]);
  return {
    ok: true,
    summary: `working folder set · ${res.filePaths[0]}`,
    output: `OK: working folder is now ${res.filePaths[0]}`,
    workspaceChanged: true
  };
}

async function listFiles(a, ctx) {
  const abs = resolveInWork(ctx, a.path || '.');
  const entries = (await fsp.readdir(abs, { withFileTypes: true }))
    .filter((e) => !IGNORE.has(e.name))
    .sort((x, y) => (x.isDirectory() === y.isDirectory() ? x.name.localeCompare(y.name) : x.isDirectory() ? -1 : 1));
  const lines = entries.map((e) => (e.isDirectory() ? `[dir]  ${e.name}/` : `       ${e.name}`));
  return {
    ok: true,
    summary: `listed ${entries.length} item(s) in ${a.path || '.'}`,
    output: lines.join('\n') || '(empty folder)'
  };
}

async function readFile(a, ctx) {
  if (!a.path) throw new Error('read_file requires "path".');
  const abs = resolveInWork(ctx, a.path);
  const buf = await fsp.readFile(abs, 'utf-8');
  const out = buf.length > MAX_READ_BYTES ? buf.slice(0, MAX_READ_BYTES) + '\n…(truncated)' : buf;
  return { ok: true, summary: `read ${a.path} (${buf.length} B)`, output: out || '(empty file)' };
}

async function writeFile(a, ctx) {
  if (!a.path) throw new Error('write_file requires "path".');
  const abs = resolveInWork(ctx, a.path);
  const existed = fs.existsSync(abs);
  let oldText = '';
  if (existed) {
    try { oldText = await fsp.readFile(abs, 'utf-8'); } catch {}
  }
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, a.content ?? '', 'utf-8');
  const newText = a.content ?? '';
  const oldLines = oldText.split(/\r?\n/).length;
  const newLines = newText.split(/\r?\n/).length;
  const added = Math.max(0, newLines - oldLines);
  const removed = Math.max(0, oldLines - newLines);
  if (!existed) {
    return {
      ok: true,
      summary: `Создал файл ${a.path}`,
      output: `Создал файл ${a.path}`
    };
  }
  return {
    ok: true,
    summary: `Редактирование файла ${a.path} +${added} -${removed}`,
    output: `Редактирование файла ${a.path} +${added} -${removed}`
  };
}

// Targeted edit: replace an exact snippet. Safer than write_file because it
// can only touch the matched region and refuses ambiguous/missing matches —
// this is what keeps edits predictable and prevents whole-file clobbering.
async function editFile(a, ctx) {
  if (!a.path) throw new Error('edit_file requires "path".');
  if (a.old_string == null) throw new Error('edit_file requires "old_string".');
  const abs = resolveInWork(ctx, a.path);
  if (!fs.existsSync(abs)) {
    return { ok: false, summary: `not found: ${a.path}`, output: `Error: ${a.path} does not exist. Use write_file to create it.` };
  }
  const text = await fsp.readFile(abs, 'utf-8');
  const oldStr = String(a.old_string);
  const newStr = a.new_string == null ? '' : String(a.new_string);
  const occurrences = oldStr ? text.split(oldStr).length - 1 : 0;
  if (occurrences === 0) {
    return { ok: false, summary: `Фрагмент не найден в ${a.path}`, output: `Error: old_string не найден в ${a.path}. Прочитайте файл (read_file) и используйте точный, дословный фрагмент.` };
  }
  if (occurrences > 1 && !a.replace_all) {
    return { ok: false, summary: `Неоднозначная замена в ${a.path} (${occurrences})`, output: `Error: old_string встречается ${occurrences} раз. Добавьте контекст, чтобы сделать его уникальным, или передайте replace_all: true.` };
  }
  const next = a.replace_all ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr);
  await fsp.writeFile(abs, next, 'utf-8');
  const delta = next.split(/\r?\n/).length - text.split(/\r?\n/).length;
  const sign = delta > 0 ? `+${delta}` : `${delta}`;
  return {
    ok: true,
    summary: `Редактирование ${a.path} (${occurrences > 1 ? occurrences + '×, ' : ''}${sign} строк)`,
    output: `OK: отредактирован ${a.path} (заменено ${occurrences > 1 && a.replace_all ? occurrences : 1})`,
    workspaceChanged: true
  };
}

async function deleteFile(a, ctx) {
  if (!a.path) throw new Error('delete_file requires "path".');
  const abs = resolveInWork(ctx, a.path);
  if (!fs.existsSync(abs)) return { ok: false, summary: `not found: ${a.path}`, output: `Error: ${a.path} does not exist.` };
  await fsp.rm(abs, { recursive: true, force: true });
  return { ok: true, summary: `Удалил файл ${a.path}`, output: `Удалил файл ${a.path}`, workspaceChanged: true };
}

/* ---------------- todo tools ---------------- */
function addTodo(a, ctx) {
  if (!a.text) throw new Error('add_todo requires "text".');
  const todos = ctx.store.get('todos') || [];
  const item = { id: uid(), text: String(a.text), done: false, createdAt: Date.now() };
  todos.push(item);
  ctx.store.set('todos', todos);
  return { ok: true, summary: `todo added · ${item.text}`, output: `OK: added todo ${item.id} — "${item.text}"`, todosChanged: true };
}

function completeTodo(a, ctx) {
  const todos = ctx.store.get('todos') || [];
  const t = todos.find((x) => x.id === a.id || x.text === a.text);
  if (!t) return { ok: false, summary: 'todo not found', output: 'Error: no matching todo.' };
  t.done = true;
  ctx.store.set('todos', todos);
  return { ok: true, summary: `todo done · ${t.text}`, output: `OK: completed "${t.text}"`, todosChanged: true };
}

function listTodos(ctx) {
  const todos = ctx.store.get('todos') || [];
  const out = todos.length
    ? todos.map((t) => `[${t.done ? 'x' : ' '}] (${t.id}) ${t.text}`).join('\n')
    : '(no todos)';
  return { ok: true, summary: `${todos.length} todo(s)`, output: out };
}

/* ---------------- memory tool ---------------- */
function remember(a, ctx) {
  if (!a.text) throw new Error('remember requires "text".');
  ctx.appendMemory([String(a.text)]);
  return { ok: true, summary: `remembered · ${a.text}`, output: 'OK: saved to long-term memory.' };
}

/* ---------------- bash tool ---------------- */
// Async so the command runs off the main thread — the UI stays responsive and
// the Stop button can kill a long-running command via ctx.signal.
function execBash(a, ctx) {
  if (!a.command) throw new Error('exec_bash requires "command".');
  const workDir = ctx.store.get('workingDir');
  if (!workDir) throw new Error('No working folder set — call set_working_folder first.');

  const label = a.command.slice(0, 50);
  return new Promise((resolve) => {
    execCommand(a.command, {
      cwd: workDir,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024, // 10 MB buffer
      timeout: 30000, // 30 sec timeout
      signal: ctx.signal // killed if the user stops generation
    }, (err, stdout, stderr) => {
      const out = (stdout || '') + (stderr ? `\n${stderr}` : '');
      if (err) {
        if (err.code === 'ABORT_ERR' || err.name === 'AbortError') {
          resolve({ ok: false, summary: `Команда прервана · ${label}`, error: 'aborted', output: 'Выполнение прервано пользователем.' });
          return;
        }
        const detail = (stderr || err.message || '').trim();
        resolve({
          ok: false,
          summary: `Ошибка bash · ${label}`,
          error: detail,
          output: `Ошибка: ${detail}${stdout ? `\n${stdout}` : ''}`
        });
        return;
      }
      resolve({
        ok: true,
        summary: `Выполнил bash · ${label}`,
        output: out.trim() || '(no output)',
        workspaceChanged: true
      });
    });
  });
}

/* ---------------- console (persistent shell) tools ---------------- */
function consoleOpen(a, ctx) {
  if (!ctx.consoles) throw new Error('Console manager unavailable.');
  const work = ctx.store.get('workingDir');
  if (!work) throw new Error('No working folder set — call set_working_folder first.');
  const cwd = a.cwd ? resolveInWork(ctx, a.cwd) : work;
  const s = ctx.consoles.open(cwd);
  return {
    ok: true,
    summary: `Открыл консоль ${s.id}`,
    output: `OK: открыта консоль ${s.id} (${cwd}). Запускайте команды через console_exec с id "${s.id}"; рабочая папка и окружение сохраняются между командами.`
  };
}

async function consoleExec(a, ctx) {
  if (!ctx.consoles) throw new Error('Console manager unavailable.');
  if (!a.id) throw new Error('console_exec requires "id".');
  if (!a.command) throw new Error('console_exec requires "command".');
  const label = String(a.command).slice(0, 40);
  const r = await ctx.consoles.exec(a.id, a.command, { signal: ctx.signal });
  if (r.error === 'not_found' || r.error === 'dead') {
    return { ok: false, summary: `Консоль ${a.id} недоступна`, output: r.output };
  }
  if (r.aborted) {
    return { ok: false, summary: `Прервано · ${a.id}`, error: 'aborted', output: `${r.output || ''}\n[прервано пользователем]`.trim() };
  }
  const note = r.timedOut
    ? '\n[превышено время ожидания — команда могла остаться запущенной. Долгие процессы (серверы) запускайте в фоне через "&".]'
    : '';
  const code = r.code == null ? '?' : r.code;
  const ok = !r.timedOut && (r.code == null || r.code === 0);
  return {
    ok,
    summary: `${a.id} · ${label} (exit ${code})`,
    output: (r.output || '(нет вывода)') + note,
    workspaceChanged: true
  };
}

function consoleClose(a, ctx) {
  if (!ctx.consoles) throw new Error('Console manager unavailable.');
  if (!a.id) throw new Error('console_close requires "id".');
  const closed = ctx.consoles.close(a.id);
  return {
    ok: closed,
    summary: closed ? `Закрыл консоль ${a.id}` : `Консоль ${a.id} не найдена`,
    output: closed ? `OK: консоль ${a.id} закрыта.` : `Консоль ${a.id} не найдена.`
  };
}

function consoleList(ctx) {
  if (!ctx.consoles) throw new Error('Console manager unavailable.');
  const items = ctx.consoles.list();
  const out = items.length
    ? items.map((s) => `${s.id} — ${s.alive ? 'активна' : 'закрыта'}${s.cwd ? ` · ${s.cwd}` : ''}`).join('\n')
    : '(нет открытых консолей)';
  return { ok: true, summary: `Консолей: ${items.length}`, output: out };
}

/* ---------------- web tools ---------------- */
const MAX_FETCH_BYTES = 30_000; // keep page text from blowing the context window
const UA = 'Mozilla/5.0 (Mist Desktop; +agent)';

function hostOf(u) { try { return new URL(u).host; } catch { return u; } }

/** Strip HTML down to readable text. */
function htmlToText(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n')
    .trim();
}

/** Decode DuckDuckGo's redirect wrapper (…/l/?uddg=<encoded real url>). */
function decodeDdgUrl(href) {
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (m) { try { return decodeURIComponent(m[1]); } catch { /* fallthrough */ } }
  return href.startsWith('//') ? `https:${href}` : href;
}

async function webSearch(a, ctx) {
  if (!a.query) throw new Error('web_search requires "query".');
  const q = encodeURIComponent(String(a.query));
  let res;
  try {
    res = await fetch(`https://html.duckduckgo.com/html/?q=${q}`, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: ctx.signal
    });
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, summary: 'поиск прерван', error: 'aborted', output: 'Прервано пользователем.' };
    return { ok: false, summary: `Ошибка поиска · ${a.query}`, error: e.message, output: `Ошибка сети: ${e.message}` };
  }
  if (!res.ok) return { ok: false, summary: `Поиск: HTTP ${res.status}`, output: `Error: поисковик ответил HTTP ${res.status}.` };
  const html = await res.text();
  const titles = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((x) => ({ url: decodeDdgUrl(x[1]), title: htmlToText(x[2]) }));
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)].map((x) => htmlToText(x[1]));
  const results = titles.slice(0, 8).map((t, i) => ({ ...t, snippet: snippets[i] || '' }));
  if (!results.length) {
    return { ok: true, summary: `Поиск · ${a.query} (0)`, output: 'Ничего не найдено. Уточните запрос или попробуйте web_fetch конкретного URL.' };
  }
  const out = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`).join('\n\n');
  return { ok: true, summary: `Поиск · ${a.query} (${results.length})`, output: out };
}

async function webFetch(a, ctx) {
  if (!a.url) throw new Error('web_fetch requires "url".');
  let url = String(a.url).trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA }, signal: ctx.signal });
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, summary: 'запрос прерван', error: 'aborted', output: 'Прервано пользователем.' };
    return { ok: false, summary: `Ошибка сети · ${hostOf(url)}`, error: e.message, output: `Ошибка: ${e.message}` };
  }
  if (!res.ok) return { ok: false, summary: `HTTP ${res.status} · ${hostOf(url)}`, output: `Error: ${url} ответил HTTP ${res.status}.` };
  const ctype = res.headers.get('content-type') || '';
  const raw = await res.text();
  const text = /html|xml/i.test(ctype) ? htmlToText(raw) : raw;
  const out = text.length > MAX_FETCH_BYTES ? `${text.slice(0, MAX_FETCH_BYTES)}\n…(truncated)` : text;
  return { ok: true, summary: `Загрузил ${hostOf(url)} (${text.length} симв.)`, output: out || '(пустая страница)' };
}

/* ---------------- dispatcher ---------------- */
async function exec(action, ctx) {
  try {
    switch (action.tool) {
      case 'set_working_folder': return await pickFolder(ctx);
      case 'list_files': return await listFiles(action, ctx);
      case 'read_file': return await readFile(action, ctx);
      case 'write_file': return await writeFile(action, ctx);
      case 'edit_file': return await editFile(action, ctx);
      case 'delete_file': return await deleteFile(action, ctx);
      case 'add_todo': return addTodo(action, ctx);
      case 'complete_todo': return completeTodo(action, ctx);
      case 'list_todos': return listTodos(ctx);
      case 'remember': return remember(action, ctx);
      case 'exec_bash': return await execBash(action, ctx);
      case 'console_open': return consoleOpen(action, ctx);
      case 'console_exec': return await consoleExec(action, ctx);
      case 'console_close': return consoleClose(action, ctx);
      case 'console_list': return consoleList(ctx);
      case 'web_search': return await webSearch(action, ctx);
      case 'web_fetch': return await webFetch(action, ctx);
      default:
        return { ok: false, summary: `unknown tool: ${action.tool}`, output: `Error: unknown tool "${action.tool}".` };
    }
  } catch (e) {
    return { ok: false, summary: `${action.tool || 'tool'} failed`, error: e.message, output: `Error: ${e.message}` };
  }
}

/* ---------------- tool schemas (native function-calling) ---------------- *
 * Sent to the model with each request so it calls tools with guaranteed-valid
 * JSON arguments instead of free-form text we have to parse.
 * ------------------------------------------------------------------------ */
const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } }
});
const str = (description) => ({ type: 'string', description });

const TOOL_SCHEMAS = [
  fn('set_working_folder', 'Open a dialog asking the user to pick the folder to work in. Call first if no working folder is set and you need files.'),
  fn('list_files', 'List files and directories at a path (relative to the working folder).', { path: str('Relative path; defaults to the folder root.') }),
  fn('read_file', 'Read a file. Always read a file before editing or overwriting it.', { path: str('Relative path to the file.') }, ['path']),
  fn('write_file', 'Create a new file or fully overwrite an existing one. Provide the COMPLETE file content. Prefer edit_file for changing part of an existing file.', { path: str('Relative path.'), content: str('Full file content.') }, ['path', 'content']),
  fn('edit_file', 'Replace an exact snippet in an existing file. old_string must match the file exactly and be unique (add surrounding context to disambiguate), or set replace_all to replace every occurrence. Preferred way to change existing files.', {
    path: str('Relative path.'),
    old_string: str('Exact text to find (verbatim, including whitespace).'),
    new_string: str('Replacement text. Empty string deletes the snippet.'),
    replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' }
  }, ['path', 'old_string', 'new_string']),
  fn('delete_file', 'Delete a file or folder.', { path: str('Relative path.') }, ['path']),
  fn('add_todo', 'Add a concrete, verifiable step to the plan.', { text: str('What the step does.') }, ['text']),
  fn('complete_todo', 'Mark a todo done.', { id: str('Todo id from list_todos.'), text: str('Or match by text.') }),
  fn('list_todos', 'List the current todos with their ids and status.'),
  fn('remember', 'Save a durable fact about the user or project to long-term memory.', { text: str('The fact to remember.') }, ['text']),
  fn('exec_bash', 'Run a single, one-shot shell command inside the working folder. Each call is a fresh process (no state carries over). For several related commands or anything needing state, use a console instead.', { command: str('The shell command.') }, ['command']),
  fn('console_open', 'Open a persistent shell session (console) in the working folder. The working directory and environment persist across commands run in it. Returns a console id.', { cwd: str('Optional starting sub-folder (relative to the working folder).') }),
  fn('console_exec', 'Run a command in an open console. State (cwd, env, etc.) carries over between commands. Run long-running processes in the background with "&".', { id: str('Console id from console_open.'), command: str('The shell command.') }, ['id', 'command']),
  fn('console_close', 'Close a console you no longer need.', { id: str('Console id.') }, ['id']),
  fn('console_list', 'List the currently open consoles and their state.'),
  fn('web_search', 'Search the web and get a list of result titles, URLs and snippets. Use it to find sources, then web_fetch the most relevant URL to read it.', { query: str('Search query.') }, ['query']),
  fn('web_fetch', 'Fetch a web page (or text resource) and return its readable text content. Use after web_search, or directly when you already know the URL.', { url: str('Absolute URL to fetch.') }, ['url'])
];

module.exports = { exec, TOOL_SCHEMAS };
