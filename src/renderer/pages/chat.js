/* Chat page — the core feature.
 * Conversation state, SSE streaming with a live cursor, markdown rendering,
 * abortable generation, token counter, smart auto-scroll, and history
 * persistence. */
import {
  store, getSettings, saveSettings, renderMarkdown, bindCopyButtons, escapeHtml,
  estimateTokens, formatRelative, uid, toast, stripAgentTags, confirmDialog
} from '../shared.js';
import { MODEL_INFO } from '../models.js';

/* AI permission modes — labels + descriptions shown in the picker. */
const PERM_MODES = [
  { id: 'default', label: 'Default', desc: 'Подтверждение плана и важных инструментов' },
  { id: 'tools-bypass', label: 'Tools Bypass', desc: 'Инструменты без подтверждения, bash — с подтверждением' },
  { id: 'autopilot', label: 'Autopilot (Beta)', desc: 'Без подтверждений · ранний доступ' }
];
const permLabel = (id) => (PERM_MODES.find((m) => m.id === id) || PERM_MODES[0]).label;
/* Built-in commands handled by the app itself (not the model). */
const SLASH_COMMANDS = [
  { name: '/clear', desc: 'Удаляет чат и создаёт новый' },
  { name: '/compact', desc: 'Сжимает динамический контекст в короткую сводку' },
  { name: '/create-promt', desc: 'Генерирует максимально качественный промпт и отдаёт его вам' },
  { name: '/create-prompt', desc: 'Генерирует максимально качественный промпт и отдаёт его вам' },
  { name: '/init', desc: 'Инициализирует MISTRAL.md в рабочей папке' }
];

/* Skill commands discovered from Markdown playbooks (bundled/user/project).
 * Loaded on render and merged into the slash menu alongside the built-ins. */
let skillCommands = [];
function allSlashCommands() { return SLASH_COMMANDS.concat(skillCommands); }
async function loadSkillCommands() {
  try {
    const items = await window.api.skills.list();
    skillCommands = (items || []).map((s) => ({
      name: `/${s.name}`,
      desc: `${s.description || 'Скилл'}${s.argumentHint ? ` · ${s.argumentHint}` : ''}`,
      skill: true
    }));
  } catch { skillCommands = []; }
}

/* Approximate context-window sizes (in tokens) per model */
const CONTEXT_LIMITS = {
  // flagship
  'mistral-large-latest': 262144,

  // new merged flagship line
  'mistral-medium-latest': 262144,
  'mistral-small-latest': 262144,

  // reasoning variants
  'magistral-medium-latest': 131072,
  'magistral-small-latest': 131072,

  // coding
  'codestral-latest': 262144,
  'devstral-medium-latest': 131072,

  // lightweight
  'ministral-8b-latest': 131072,

  // multimodal
  'pixtral-large-latest': 131072,

  // open models
  'open-mistral-nemo': 131072
}
const ctxLimitFor = (model) => CONTEXT_LIMITS[model] || 131072;
/* Token counts of the fixed context parts (system prompt + tool schemas). */
let ctxBaseline = { system: 0, tools: 0 };

const api = window.api;

/* Module-level live conversation so it survives page navigation. */
let convo = freshConvo('mistral-large-latest');
let streaming = false;
let unsubStream = null;
let autoScroll = true;

function freshConvo(model) {
  return { id: uid(), title: '', model, createdAt: Date.now(), messages: [], savedId: null, workingDir: '', todos: [] };
}

/* ---------------- image attachments (vision) ---------------- */
const MAX_IMG_W = 1920, MAX_IMG_H = 1080; // downscale ceiling (Full HD)
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|tiff|heic|heif)$/i;

function isImageFile(file) {
  return !!file && (file.type?.startsWith('image/') || IMAGE_EXT_RE.test(file.name || ''));
}

/** Text of a message whose `content` may be a plain string or a parts array. */
function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((p) => p.type === 'text').map((p) => p.text || '').join(' ').trim();
  return '';
}
/** Image data-URLs from a parts-array message. */
function contentImages(c) {
  if (!Array.isArray(c)) return [];
  return c.filter((p) => p.type === 'image_url')
    .map((p) => (typeof p.image_url === 'string' ? p.image_url : p.image_url?.url))
    .filter(Boolean);
}

/**
 * Read an image File, downscale it to fit within Full HD (aspect preserved),
 * and re-encode as a JPEG data-URL. Done in the renderer with a canvas so the
 * full-size original never has to be handled — only the FHD copy enters context.
 */
function downscaleImage(file) {
  return new Promise((resolve, reject) => {
    let triedDataUrl = false;

    const rejectReadError = (reason) => {
      reject(new Error(`Не удалось прочитать изображение${file.name ? ` "${file.name}"` : ''}. ${reason}`.trim()));
    };

    const loadImage = (src, revoke) => {
      const img = new Image();
      img.onload = () => {
        if (revoke) URL.revokeObjectURL(src);
        const scale = Math.min(1, MAX_IMG_W / img.width, MAX_IMG_H / img.height);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.85), w, h });
      };
      img.onerror = () => {
        if (revoke) URL.revokeObjectURL(src);
        if (!triedDataUrl) {
          triedDataUrl = true;
          readAsDataUrl();
          return;
        }
        rejectReadError('Проверьте формат файла и повторите попытку.');
      };
      img.src = src;
    };

    const readAsDataUrl = () => {
      const reader = new FileReader();
      reader.onload = () => loadImage(reader.result, false);
      reader.onerror = () => rejectReadError('Файл не может быть прочитан.');
      reader.readAsDataURL(file);
    };

    try {
      const url = URL.createObjectURL(file);
      loadImage(url, true);
    } catch {
      triedDataUrl = true;
      readAsDataUrl();
    }
  });
}

/** Rough pre-send token estimate for a Pixtral-style image (16px patches). */
function estimateImageTokens(w, h) {
  return Math.ceil(w / 16) * Math.ceil(h / 16);
}

/* ---------------- session persistence ---------------- */
async function loadSessions() {
  return (await store.get('sessions')) || [];
}

/** Persist the current conversation into the sessions array (insert or update). */
async function persistConvo() {
  if (!convo.messages.length) return;
  const firstUser = convo.messages.find((m) => m.role === 'user');
  const title = (contentText(firstUser?.content) || 'New chat').replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat';
  const record = {
    id: convo.savedId || convo.id,
    title,
    model: convo.model,
    createdAt: convo.createdAt,
    updatedAt: Date.now(),
    messageCount: convo.messages.length,
    messages: convo.messages,
    workingDir: convo.workingDir || '',
    todos: convo.todos || []
  };
  const sessions = await loadSessions();
  const idx = sessions.findIndex((s) => s.id === record.id);
  if (idx >= 0) sessions[idx] = record;
  else sessions.unshift(record);
  convo.savedId = record.id;
  convo.title = title;
  await store.set('sessions', sessions);
  document.dispatchEvent(new Event('sessions-changed'));
}

/* ---------------- render ---------------- */
async function render(container, ctx) {
  const settings = await getSettings();
  convo.model = settings.model || convo.model;
  await loadSkillCommands(); // populate the slash menu with available skills

  // Handle navigation intents.
  if (ctx.params?.newChat) await newChat(false);
  if (ctx.params?.openSession) {
    const openSessionParam = ctx.params.openSession;
    if (typeof openSessionParam === 'string') {
      const sessions = await loadSessions();
      const session = sessions.find((s) => s.id === openSessionParam);
      if (session) await openSession(session, false);
    } else {
      await openSession(openSessionParam, false);
    }
  }

  // Bind the working folder + todos to the current chat: make the active state
  // match this conversation (empty for a fresh chat, restored for a saved one).
  await api.workspace.set(convo.workingDir || '');
  await api.todos.set(convo.todos || []);

  const preset = await activePreset(settings);

  container.innerHTML = `
    <div class="chat">
      <section class="thread-pane">
        <header class="thread-head">
          <span class="model mono" id="thModel">${escapeHtml(convo.model)}</span>
          <span class="streaming hidden" id="thStreaming"><span class="pulse"></span>working</span>
          <span class="spacer"></span>
          <button class="head-chip" id="folderBtn" title="Working folder">
            <svg viewBox="0 0 16 16"><path d="M2 4.5h4l1.5 1.5H14v6H2z"/></svg>
            <span id="folderLabel">Set folder</span>
          </button>
          <button class="head-chip" id="todosBtn" title="Todos">
            <svg viewBox="0 0 16 16"><path d="M3 5l2 2 3-3M3 11l2 2 3-3M10 5h4M10 11h4"/></svg>
            <span id="todosLabel">Todos</span>
          </button>
          <span class="preset-name mono" id="thPreset">${escapeHtml(preset?.name || 'General')}</span>
          <button class="icon-btn" id="thNew" title="New chat (Ctrl+N)">
            <svg viewBox="0 0 16 16"><path d="M3 8h10M8 3v10"/></svg>
          </button>
        </header>

        <div class="thread" id="thread"></div>

        <div class="composer">
          <div class="composer-atts" id="atts" hidden></div>
          <textarea id="composer" placeholder="Message Mistral…  (Enter to send · Shift+Enter for newline)"></textarea>
          <div class="composer-bar">
            <input type="file" id="fileInput" accept="image/*" multiple hidden />
            <button class="icon-btn" id="attachBtn" title="Прикрепить изображение (до Full HD)">
              <svg viewBox="0 0 16 16"><path d="M9.6 5.4 5.9 9a1.5 1.5 0 0 0 2.1 2.1l3.7-3.6a3 3 0 1 0-4.2-4.3L3.7 7.1a4.5 4.5 0 0 0 6.4 6.4l2.9-3"/></svg>
            </button>
            <span class="meta mono">↵ send</span>
            <span class="meta mono">·  ${escapeHtml((convo.model || '').replace('-latest', ''))}</span>
            <span class="meta mono" id="tokMeta">·  0 tok</span>
            <span class="meta mono" id="rateMeta"></span>
            <button class="ctx-gauge" id="ctxGauge" title="Контекстное окно">
              <svg viewBox="0 0 18 18" aria-hidden="true">
                <circle class="track" cx="9" cy="9" r="7"></circle>
                <circle class="fill" cx="9" cy="9" r="7"></circle>
              </svg>
              <span class="ctx-pct mono" id="ctxPct">0%</span>
            </button>
            <button class="perm-chip mono" id="aiPermBtn" title="Права ИИ">
              <span class="dot"></span><span id="aiPermLabel">${escapeHtml(permLabel(settings.aiPermissionMode))}</span>
            </button>
            <span class="spacer"></span>
            <button class="btn ghost sm hidden" id="stopBtn">Stop ⎋</button>
            <button class="btn primary sm" id="sendBtn">Send ↵</button>
          </div>
        </div>
      </section>
    </div>`;

  // refs
  const thread = container.querySelector('#thread');
  const composer = container.querySelector('#composer');
  const sendBtn = container.querySelector('#sendBtn');
  const stopBtn = container.querySelector('#stopBtn');
  const tokMeta = container.querySelector('#tokMeta');
  const rateMeta = container.querySelector('#rateMeta');
  const ctxGauge = container.querySelector('#ctxGauge');
  const ctxPct = container.querySelector('#ctxPct');
  const ctxFill = ctxGauge.querySelector('.fill');
  const RING = 2 * Math.PI * 7; // circumference of the gauge ring (r=7)
  let lastUserMessage = ''; // save for error recovery
  // Real token usage from the API's latest response (prompt_tokens = true
  // context size). Null until the first response; falls back to estimation.
  let lastUsage = null;

  // Rate limit info from the API (remaining requests, reset time, etc.)
  let lastRateLimit = null;

  // ---- image attachments ----
  const atts = container.querySelector('#atts');
  const fileInput = container.querySelector('#fileInput');
  const composerEl = container.querySelector('.composer');
  let pendingImages = []; // [{ id, dataUrl, name, w, h, tokens }]

  function renderAtts() {
    atts.hidden = pendingImages.length === 0;
    atts.innerHTML = pendingImages.map((im) =>
      `<div class="att-thumb" title="${escapeHtml(im.name)} · ${im.w}×${im.h}">
         <img src="${im.dataUrl}" alt="" />
         <button class="att-del" data-id="${im.id}" title="Убрать">×</button>
       </div>`).join('');
    atts.querySelectorAll('.att-del').forEach((b) =>
      b.addEventListener('click', () => {
        pendingImages = pendingImages.filter((x) => x.id !== b.dataset.id);
        renderAtts();
        updateTokens();
      }));
  }

  async function addImageFiles(fileList) {
    const files = [...(fileList || [])].filter((f) => isImageFile(f));
    if (!files.length) return;
    for (const f of files) {
      try {
        const { dataUrl, w, h } = await downscaleImage(f);
        pendingImages.push({ id: uid(), dataUrl, name: f.name || 'image', w, h, tokens: estimateImageTokens(w, h) });
      } catch (e) {
        toast(e.message || 'Не удалось добавить изображение', 'error');
      }
    }
    renderAtts();
    updateTokens();
    composer.focus();
  }

  container.querySelector('#attachBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { addImageFiles(fileInput.files); fileInput.value = ''; });
  composer.addEventListener('paste', (e) => {
    const imgs = [...(e.clipboardData?.items || [])].filter((it) => it.type.startsWith('image/'));
    if (imgs.length) { e.preventDefault(); addImageFiles(imgs.map((it) => it.getAsFile()).filter(Boolean)); }
  });
  composerEl.addEventListener('dragover', (e) => { e.preventDefault(); composerEl.classList.add('dragover'); });
  composerEl.addEventListener('dragleave', (e) => { if (e.target === composerEl) composerEl.classList.remove('dragover'); });
  composerEl.addEventListener('drop', (e) => {
    e.preventDefault();
    composerEl.classList.remove('dragover');
    if (e.dataTransfer?.files?.length) addImageFiles(e.dataTransfer.files);
  });

  let slashPopup = null;
  let slashMatches = [];
  let slashActive = 0;

  function closeSlashSuggestions() {
    if (slashPopup) {
      slashPopup.remove();
      slashPopup = null;
      slashMatches = [];
      slashActive = 0;
    }
  }

  function applySlashSelection() {
    if (!slashMatches.length) return;
    const selected = slashMatches[slashActive];
    if (!selected) return;
    const value = composer.value;
    const rest = value.includes(' ') ? value.slice(value.indexOf(' ')) : ' ';
    composer.value = `${selected.name}${rest}`.trimEnd();
    composer.focus();
    updateSlashSuggestions();
  }

  function updateSlashSuggestions() {
    const value = composer.value;
    if (!value.startsWith('/')) { closeSlashSuggestions(); return; }
    const query = value.slice(1).toLowerCase();
    const matches = allSlashCommands().filter((cmd) =>
      cmd.name.slice(1).startsWith(query) || cmd.desc.toLowerCase().includes(query)
    );
    if (!matches.length) { closeSlashSuggestions(); return; }
    slashMatches = matches;
    slashActive = Math.min(slashActive, matches.length - 1);

    const rect = composer.getBoundingClientRect();
    if (!slashPopup) {
      slashPopup = document.createElement('div');
      slashPopup.className = 'slash-suggestions';
      document.getElementById('overlayHost').appendChild(slashPopup);
    }
    // Show the suggestions ABOVE the composer (anchored to its top edge).
    slashPopup.style.left = `${rect.left + 6}px`;
    slashPopup.style.top = 'auto';
    slashPopup.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    slashPopup.style.minWidth = `${Math.max(rect.width, 280)}px`;
    slashPopup.innerHTML = matches.map((cmd, idx) =>
      `<div class="slash-suggestion ${idx === slashActive ? 'active' : ''}" data-i="${idx}">` +
        `<span class="cmd">${escapeHtml(cmd.name)}</span>` +
        `<span class="desc">${escapeHtml(cmd.desc)}</span>` +
      `</div>`
    ).join('');

    slashPopup.querySelectorAll('.slash-suggestion').forEach((el) =>
      el.addEventListener('click', () => {
        slashActive = Number(el.dataset.i);
        applySlashSelection();
      })
    );
  }

  // Track manual scrolling so streaming doesn't yank the view down.
  thread.addEventListener('scroll', () => {
    const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60;
    autoScroll = nearBottom;
  });

  // Break the current context window into buckets (tokens). Tool result lines
  // in assistant messages render as `> \`tool\` — summary` blockquotes, so we
  // split assistant text into "messages" vs "tool results".
  const contextBreakdown = () => {
    let msgChars = composer.value.length;
    let lineToolChars = 0;  // estimate from the inline tool summary lines
    let realToolChars = 0;  // measured tool-result sizes (file reads, output…)
    let imgTokens = 0;      // attached images (rough estimate; real usage corrects it)
    for (const m of convo.messages) {
      if (m.role === 'assistant') {
        realToolChars += m.toolChars || 0;
        for (const ln of (m.content || '').split('\n')) {
          if (/^>\s*`[^`]+`/.test(ln.trim())) lineToolChars += ln.length + 1;
          else msgChars += ln.length + 1;
        }
      } else {
        msgChars += contentText(m.content).length;
        imgTokens += m.imageTokens || 0;
      }
    }
    imgTokens += pendingImages.reduce((s, i) => s + i.tokens, 0); // not sent yet, but about to be
    const tok = (c) => Math.ceil(c / 4);
    const system = ctxBaseline.system;
    const tools = ctxBaseline.tools;
    // Prefer measured tool-result sizes (they capture file reads the chat only
    // shows as a one-line summary); fall back to the summary-line estimate.
    let toolResults = realToolChars ? tok(realToolChars) : tok(lineToolChars);
    let messages = tok(msgChars) + imgTokens;
    let total = system + tools + messages + toolResults;

    // When the API has reported real usage, trust prompt_tokens as the true
    // context size — it already includes tool results and reasoning — and fit
    // the buckets to it. Add the unsent composer text on top (next request).
    if (lastUsage && lastUsage.prompt_tokens) {
      const pendingImgTok = pendingImages.reduce((s, i) => s + i.tokens, 0);
      total = lastUsage.prompt_tokens + tok(composer.value.length) + pendingImgTok;
      toolResults = Math.min(toolResults, Math.max(0, total - system - tools));
      messages = Math.max(0, total - system - tools - toolResults);
    }
    return { system, tools, messages, toolResults, total };
  };

  // Global contextBreakdown (when not streaming)
  const globalContextBreakdown = () => {
    let msgChars = composer.value.length;
    let lineToolChars = 0;
    let realToolChars = 0;
    let imgTokens = 0;
    for (const m of convo.messages) {
      if (m.role === 'assistant') {
        realToolChars += m.toolChars || 0;
        for (const ln of (m.content || '').split('\n')) {
          if (/^>\s*`[^`]+`/.test(ln.trim())) lineToolChars += ln.length + 1;
          else msgChars += ln.length + 1;
        }
      } else {
        msgChars += contentText(m.content).length;
        imgTokens += m.imageTokens || 0;
      }
    }
    imgTokens += pendingImages.reduce((s, i) => s + i.tokens, 0);
    const tok = (c) => Math.ceil(c / 4);
    const system = ctxBaseline.system;
    const tools = ctxBaseline.tools;
    let toolResults = realToolChars ? tok(realToolChars) : tok(lineToolChars);
    let messages = tok(msgChars) + imgTokens;
    let total = system + tools + messages + toolResults;
    if (lastUsage && lastUsage.prompt_tokens) {
      const pendingImgTok = pendingImages.reduce((s, i) => s + i.tokens, 0);
      total = lastUsage.prompt_tokens + tok(composer.value.length) + pendingImgTok;
      toolResults = Math.min(toolResults, Math.max(0, total - system - tools));
      messages = Math.max(0, total - system - tools - toolResults);
    }
    return { system, tools, messages, toolResults, total };
  };

  // Composer behaviour: Enter sends, Shift+Enter newlines; autosize; token count.
  const updateTokens = () => {
    const b = globalContextBreakdown();
    tokMeta.textContent = `·  ${b.total.toLocaleString()} tok`;
    const pct = Math.min(1, b.total / ctxLimitFor(convo.model));
    ctxFill.style.strokeDasharray = RING.toFixed(2);
    ctxFill.style.strokeDashoffset = (RING * (1 - pct)).toFixed(2);
    ctxPct.textContent = `${Math.round(pct * 100)}%`;
    ctxGauge.classList.toggle('warn', pct >= 0.8 && pct < 0.95);
    ctxGauge.classList.toggle('crit', pct >= 0.95);
  };

  const displayRateLimit = () => {
    if (!lastRateLimit) {
      rateMeta.textContent = '';
      return;
    }
    const { remaining, limit, resetAt } = lastRateLimit;
    let text = '';
    if (Number.isFinite(remaining) && Number.isFinite(limit)) {
      text = `·  ${remaining}/${limit} req`;
    }
    if (Number.isFinite(resetAt)) {
      const resetMin = Math.ceil((resetAt - Date.now()) / 1000 / 60);
      if (resetMin > 0) text += ` (${resetMin}m)`;
    }
    rateMeta.textContent = text;
    rateMeta.title = text ? `Rate Limit: ${remaining}/${limit} requests remaining, resets in ${Math.ceil((resetAt - Date.now()) / 1000)}s` : '';
  };

  // System prompt + tool schemas are fixed parts of the window; fetch their
  // sizes from main and refresh the gauge.
  async function refreshCtxBaseline() {
    try {
      const s = await api.context.stats();
      ctxBaseline = { system: Math.ceil((s.systemChars || 0) / 4), tools: Math.ceil((s.toolsChars || 0) / 4) };
    } catch { /* keep previous baseline */ }
    updateTokens();
  }
  composer.addEventListener('input', () => {
    composer.style.height = 'auto';
    composer.style.height = Math.min(220, composer.scrollHeight) + 'px';
    updateTokens();
    updateSlashSuggestions();
  });
  composer.addEventListener('keydown', (e) => {
    if (slashMatches.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        slashActive = Math.min(slashMatches.length - 1, slashActive + 1);
        updateSlashSuggestions();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        slashActive = Math.max(0, slashActive - 1);
        updateSlashSuggestions();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        applySlashSelection();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && composer.value.startsWith('/') && !composer.value.includes(' ')) {
        e.preventDefault();
        applySlashSelection();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  sendBtn.addEventListener('click', () => send());
  stopBtn.addEventListener('click', () => stop());
  container.querySelector('#thNew').addEventListener('click', () => ctx.navigate('chat', { newChat: true }));

  // Escape stops generation while this page is mounted.
  const onKey = (e) => { if (e.key === 'Escape' && streaming) { e.preventDefault(); stop(); } };
  document.addEventListener('keydown', onKey);
  chatPage._onKey = onKey;

  // ---- working folder + todos chips ----
  const folderLabel = container.querySelector('#folderLabel');
  const todosLabel = container.querySelector('#todosLabel');

  async function refreshFolder() {
    const dir = await api.workspace.get();
    // Keep the conversation's folder in sync (e.g. when the agent picks one).
    convo.workingDir = dir || '';
    folderLabel.textContent = dir ? dir.split(/[\\/]/).pop() : 'Set folder';
    container.querySelector('#folderBtn').classList.toggle('set', !!dir);
    container.querySelector('#folderBtn').title = dir || 'Choose a working folder';
  }
  async function refreshTodos() {
    const todos = await api.todos.get();
    // Keep the conversation's todos in sync (the agent mutates them mid-run).
    convo.todos = todos;
    const done = todos.filter((t) => t.done).length;
    todosLabel.textContent = todos.length ? `Todos ${done}/${todos.length}` : 'Todos';
    container.querySelector('#todosBtn').classList.toggle('set', todos.length > 0);
  }

  container.querySelector('#folderBtn').addEventListener('click', async () => {
    const dir = await api.workspace.pick();
    convo.workingDir = dir || '';
    await refreshFolder();
    await persistConvo(); // remember the folder on this chat
  });
  container.querySelector('#todosBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleTodosPopover(container, refreshTodos);
  });

  // AI Permission Mode button
  container.querySelector('#aiPermBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAiPermPopover(container);
  });

  // Context-window gauge → usage breakdown popover.
  ctxGauge.addEventListener('click', (e) => {
    e.stopPropagation();
    const b = globalContextBreakdown();
    toggleCtxPopover(container, b, ctxLimitFor(convo.model));
  });

  // Initial paint.
  paintThread(thread);
  await refreshFolder();
  await refreshTodos();
  await refreshCtxBaseline();
  updateTokens();
  reflectStreamingUI();
  setTimeout(() => composer.focus(), 60);

  /* ---- send / stream ---- */
  // opts.allowedTools — restrict this turn's toolset (set by a skill invocation).
  async function send(opts = {}) {
    const text = composer.value.trim();
    const imgs = pendingImages.slice();
    if ((!text && !imgs.length) || streaming) return;

    if (text.startsWith('/') && !imgs.length) {
      const handled = await handleSlashCommand(text);
      if (handled) {
        closeSlashSuggestions();
        return;
      }
    }

    lastUserMessage = text; // save for error recovery
    const settings = await getSettings();
    convo.model = settings.model || convo.model;

    // Warn (don't block) if images are attached but the model can't see them.
    if (imgs.length) {
      const caps = (MODEL_INFO[convo.model] || {}).caps || [];
      if (!caps.includes('vision')) {
        toast('Текущая модель не работает с изображениями — выберите pixtral или mistral large/medium/small', 'info', 5000);
      }
    }

    // Build the user turn: a parts array when images are attached (text +
    // image_url data-URLs, the format Mistral's vision API expects), else a
    // plain string as before.
    let userContent = text;
    if (imgs.length) {
      const parts = [];
      if (text) parts.push({ type: 'text', text });
      for (const im of imgs) parts.push({ type: 'image_url', image_url: im.dataUrl });
      userContent = parts;
    }
    const userMsg = { role: 'user', content: userContent };
    if (imgs.length) userMsg.imageTokens = imgs.reduce((s, i) => s + i.tokens, 0);
    convo.messages.push(userMsg);

    pendingImages = [];
    renderAtts();
    composer.value = '';
    composer.style.height = 'auto';
    updateTokens();
    paintThread(thread);
    forceScroll(thread);
    await persistConvo();

    // Build the message array (prepend system prompt if set).
    const preset = await activePreset(settings);
    const outgoing = [];
    if (preset?.content?.trim()) outgoing.push({ role: 'system', content: preset.content });
    // Send only what the API understands — strip UI-only metadata (skillUsed,
    // toolChars, imageTokens). content may be a string or a vision parts array.
    outgoing.push(...convo.messages.map((m) => ({ role: m.role, content: m.content })));

    // Assistant placeholder. The agent loop streams multiple turns into this
    // one message: `committed` holds finalised visible text + tool lines from
    // previous turns; `rawTurn` is the current turn's raw tokens.
    const asstMsg = { role: 'assistant', content: '' };
    if (opts.skillName) asstMsg.skillUsed = opts.skillName; // tag for the "Skill … was used" badge
    convo.messages.push(asstMsg);
    streaming = true;
    autoScroll = true;
    reflectStreamingUI();
    paintThread(thread, /*streamingLast*/ true);
    forceScroll(thread);

    let committed = '';
    let rawTurn = '';
    let rafPending = false;
    let outputTokens = 0; // real-time token count of the streamed output

    // Local contextBreakdown for this send() closure to access outputTokens
    const contextBreakdown = () => {
      let msgChars = composer.value.length;
      let lineToolChars = 0;  // estimate from the inline tool summary lines
      let realToolChars = 0;  // measured tool-result sizes (file reads, output…)
      let imgTokens = 0;      // attached images (rough estimate; real usage corrects it)
      for (const m of convo.messages) {
        if (m.role === 'assistant') {
          realToolChars += m.toolChars || 0;
          for (const ln of (m.content || '').split('\n')) {
            if (/^>\s*`[^`]+`/.test(ln.trim())) lineToolChars += ln.length + 1;
            else msgChars += ln.length + 1;
          }
        } else {
          msgChars += contentText(m.content).length;
          imgTokens += m.imageTokens || 0;
        }
      }
      imgTokens += pendingImages.reduce((s, i) => s + i.tokens, 0); // not sent yet, but about to be
      const tok = (c) => Math.ceil(c / 4);
      const system = ctxBaseline.system;
      const tools = ctxBaseline.tools;
      // Prefer measured tool-result sizes (they capture file reads the chat only
      // shows as a one-line summary); fall back to the summary-line estimate.
      let toolResults = realToolChars ? tok(realToolChars) : tok(lineToolChars);
      let messages = tok(msgChars) + imgTokens + outputTokens; // include real-time output tokens
      let total = system + tools + messages + toolResults;

      // When the API has reported real usage, trust prompt_tokens as the true
      // context size — it already includes tool results and reasoning — and fit
      // the buckets to it. Add the unsent composer text on top (next request).
      if (lastUsage && lastUsage.prompt_tokens) {
        const pendingImgTok = pendingImages.reduce((s, i) => s + i.tokens, 0);
        total = lastUsage.prompt_tokens + tok(composer.value.length) + pendingImgTok + outputTokens;
        toolResults = Math.min(toolResults, Math.max(0, total - system - tools - outputTokens));
        messages = Math.max(0, total - system - tools - toolResults - outputTokens) + outputTokens;
      }
      return { system, tools, messages, toolResults, total };
    };

    // Live streaming view: finalised turns + tool lines render as markdown,
    // while the current turn's text streams in as fade-in spans so letters
    // reveal smoothly the instant tokens arrive — without re-rendering (and
    // re-animating / reflowing) the whole message every frame.
    const live = createLiveView(thread, () => { if (autoScroll) forceScroll(thread); });
    const flush = () => {
      rafPending = false;
      asstMsg.content = committed + rawTurn; // renderMarkdown strips action tags
      if (live) { const { head, typed } = splitTurn(rawTurn); live.update(committed, head, typed); }
      else { updateLastAssistant(thread, asstMsg.content, true); if (autoScroll) forceScroll(thread); }
      updateTokens(); // keep the context gauge live as tokens stream in
    };
    const scheduleFlush = () => { if (!rafPending) { rafPending = true; requestAnimationFrame(flush); } };

    // Commit the current turn's visible text before tool lines are appended.
    const commitTurn = () => {
      const visible = stripAgentTags(rawTurn).replace(/\s+$/, '');
      if (visible) committed += (committed ? '\n\n' : '') + visible;
      rawTurn = '';
    };

    unsubStream = api.mistral.onStream((msg) => {
      if (msg.type === 'token') {
        rawTurn += msg.delta;
        outputTokens += estimateTokens(msg.delta);
        updateTokens(); // update gauge immediately on each token
        scheduleFlush();
      } else if (msg.type === 'turn') {
        commitTurn();
        scheduleFlush();
      } else if (msg.type === 'tool-start') {
        // Optimistic "running" line could go here; we render the result line below.
      } else if (msg.type === 'tool') {
        // Append a tool line as a markdown blockquote.
        const mark = msg.ok === false ? '⚠' : '✓';
        committed += `\n\n> \`${escapeHtml(msg.name)}\` — ${escapeHtml(msg.summary || (msg.ok ? 'done' : 'failed'))} ${mark}`;
        // The model can pick a skill on its own via run_skill — surface it as
        // the "Skill … was used" badge too (summary is "Скилл · <name>").
        if (msg.name === 'run_skill' && msg.ok !== false) {
          const m = /·\s*(.+?)\s*$/.exec(msg.summary || '');
          if (m) asstMsg.skillUsed = m[1];
        }
        // Remember how much this tool result added to the context (e.g. a file
        // read) so the gauge reflects it even before the next API response.
        asstMsg.toolChars = (asstMsg.toolChars || 0) + (msg.outputChars || 0);
        if (msg.todosChanged) refreshTodos();
        if (msg.workspaceChanged) refreshFolder();
        scheduleFlush();
      } else if (msg.type === 'usage') {
        lastUsage = msg.usage;
        updateTokens();
      } else if (msg.type === 'rate-limit') {
        lastRateLimit = msg.rateLimit;
        displayRateLimit();
      } else if (msg.type === 'subagent-start') {
        committed += `\n\n> \`субагент\` ▸ ${escapeHtml(msg.task || '')}${msg.mode === 'read' ? ' · только чтение' : ''}`;
        scheduleFlush();
      } else if (msg.type === 'subagent-tool') {
        const mark = msg.ok === false ? '⚠' : '✓';
        committed += `\n> ↳ \`${escapeHtml(msg.name)}\` — ${escapeHtml(msg.summary || '')} ${mark}`;
        if (msg.workspaceChanged) refreshFolder();
        scheduleFlush();
      } else if (msg.type === 'subagent-done') {
        if (msg.truncated) committed += `\n> ↳ _субагент достиг предела шагов_`;
        else if (msg.aborted) committed += `\n> ↳ _субагент прерван_`;
        scheduleFlush();
      } else if (msg.type === 'plan-review-required') {
        showApprovalCard(thread, {
          kind: 'plan',
          title: 'Утвердить план?',
          body: `ИИ составил план из ${msg.todoCount} шаг(ов). Откройте «Todos» сверху, чтобы посмотреть детали.`,
          okText: 'Выполнить план'
        });
      } else if (msg.type === 'bash-confirmation-required') {
        showApprovalCard(thread, {
          kind: 'bash',
          title: 'Выполнить команду?',
          code: msg.command,
          okText: 'Выполнить'
        });
      } else if (msg.type === 'web-confirmation-required') {
        showApprovalCard(thread, {
          kind: 'web',
          title: 'Выйти в интернет?',
          body: `ИИ хочет обратиться к интернету: <code>${escapeHtml(msg.target || '')}</code>`,
          okText: 'Разрешить'
        });
      } else if (msg.type === 'tool-confirmation-required') {
        showApprovalCard(thread, {
          kind: 'tool',
          title: 'Разрешить действие?',
          body: `ИИ хочет выполнить <code>${escapeHtml(msg.toolName)}</code>${msg.path ? ` · ${escapeHtml(msg.path)}` : ''}`,
          okText: 'Разрешить'
        });
      } else if (msg.type === 'done') {
        finish(msg.aborted, msg.content);
      } else if (msg.type === 'error') {
        finishError(msg.message, msg.receivedChars);
      }
    });

    api.mistral.send({ messages: outgoing, allowedTools: opts.allowedTools });

    function finish(aborted, content) {
      cleanupStream();
      commitTurn(); // fold in any trailing final-turn text
      asstMsg.content = committed.trim();
      // Fall back to the loop's closing message (e.g. plan rejected) when no
      // visible text streamed in this turn.
      if (!asstMsg.content && content) asstMsg.content = content.trim();
      if (!asstMsg.content && aborted) convo.messages.pop(); // nothing produced
      paintThread(thread);
      persistConvo();
      refreshTodos();
      refreshCtxBaseline(); // todos/folder may have changed → system prompt size too
      if (aborted) toast('Generation stopped', 'info', 2000);
    }
    function finishError(message, receivedChars) {
      cleanupStream();
      // Remove both assistant and user messages; restore user text to composer
      if (convo.messages[convo.messages.length - 1]?.role === 'assistant') {
        convo.messages.pop();
      }
      if (convo.messages[convo.messages.length - 1]?.role === 'user') {
        convo.messages.pop();
      }
      composer.value = lastUserMessage;
      composer.style.height = 'auto';
      composer.style.height = Math.min(220, composer.scrollHeight) + 'px';
      paintThread(thread);
      updateTokens();
      // Track partial context received from server
      if (receivedChars) ctxBaseline.received = Math.ceil(receivedChars / 4);
      toast(message || 'Request failed', 'error');
      composer.focus();
    }
  }

  function stop() {
    if (!streaming) return;
    api.mistral.abort();
  }

  function cleanupStream() {
    streaming = false;
    removeApprovalCard();
    if (unsubStream) { unsubStream(); unsubStream = null; }
    reflectStreamingUI();
    composer.focus();
  }

  function reflectStreamingUI() {
    const head = container.querySelector('#thStreaming');
    head?.classList.toggle('hidden', !streaming);
    sendBtn.classList.toggle('hidden', streaming);
    stopBtn.classList.toggle('hidden', !streaming);
  }

  async function handleSlashCommand(text) {
    const raw = text.slice(1).trim();
    const [cmd, ...parts] = raw.split(/\s+/);
    const arg = parts.join(' ').trim();
    switch (cmd?.toLowerCase()) {
      case 'clear':
        await newChat(true);
        toast('Chat cleared', 'success', 1600);
        return true;
      case 'init':
        await initMistralFile();
        return true;
      case 'compact':
        await compactContext(arg);
        return true;
      case 'create-promt':
      case 'create-prompt':
        await createPrompt(arg);
        return true;
      default: {
        // Not a built-in → maybe a skill playbook.
        const match = skillCommands.find((s) => s.name.slice(1).toLowerCase() === (cmd || '').toLowerCase());
        if (match) { await runSkillCommand(cmd, arg); return true; }
        return false;
      }
    }
  }

  // Expand a skill into its rendered playbook and run it, restricting the
  // turn to the skill's allowed-tools (if it declared any).
  async function runSkillCommand(name, arg) {
    let rendered;
    try { rendered = await api.skills.render(name, arg); }
    catch { rendered = null; }
    if (!rendered) { toast(`Скилл /${name} не найден`, 'error'); return; }
    composer.value = rendered.prompt;
    await send({ allowedTools: rendered.allowedTools, skillName: rendered.name });
  }

  async function initMistralFile() {
    try {
      const result = await api.project.init();
      if (result.ok) {
        toast(`MISTRAL.md created at ${result.path}`, 'success', 2600);
      } else {
        toast(`MISTRAL.md already exists at ${result.path}`, 'info', 2600);
      }
    } catch (err) {
      toast(err?.message || 'Could not initialize MISTRAL.md', 'error');
    }
  }

  async function compactContext(arg) {
    const goal = arg || 'Compress the entire conversation history into a compact summary that preserves the key facts, decisions, tasks, and project context. Respond only with the compact summary.';
    composer.value = `You are a prompt engineer. ${goal}`;
    await send();
  }

  async function createPrompt(arg) {
    const lastUser = contentText(convo.messages.slice().reverse().find((m) => m.role === 'user')?.content);
    const objective = arg || lastUser || 'Create a high-quality prompt for the current project or task.';
    composer.value = `You are a prompt engineer. Create the best possible prompt for this objective: ${objective}. Output only the prompt text.`;
    await send();
  }

}

/* ---------------- thread painting ---------------- */
function paintThread(thread, streamingLast = false) {
  if (!convo.messages.length) {
    thread.innerHTML = `
      <div class="empty">
        <div class="title">Start a conversation</div>
        <div class="sub">Ask Mistral anything. Your messages stream back token-by-token, with markdown and syntax highlighting.</div>
      </div>`;
    return;
  }
  thread.innerHTML = convo.messages.map((m, i) => {
    if (m.role === 'user') {
      const utext = contentText(m.content);
      const uimgs = contentImages(m.content);
      const imgsHtml = uimgs.length
        ? `<div class="bubble-imgs">${uimgs.map((u) => `<img class="bubble-img" src="${u}" alt="" />`).join('')}</div>`
        : '';
      return `<div class="msg-row user"><div class="bubble user">${imgsHtml}${utext ? escapeHtml(utext) : ''}</div></div>`;
    }
    const isLast = i === convo.messages.length - 1;
    const cursor = streamingLast && isLast ? '<span class="stream-cursor">▏</span>' : '';
    const skillBadge = m.skillUsed
      ? `<div class="skill-used">✦ Skill <b>/${escapeHtml(m.skillUsed)}</b> was used</div>`
      : '';
    return `<div class="msg-row asst-row"><div class="asst">
        ${skillBadge}
        <div class="who">Assistant</div>
        <div class="msg-content">${renderMarkdown(m.content)}${cursor}</div>
      </div></div>`;
  }).join('');
  thread.querySelectorAll('.msg-content').forEach(bindCopyButtons);
}

/** Fallback updater (no incremental view): re-render the whole message. */
function updateLastAssistant(thread, text, withCursor) {
  const last = thread.querySelector('.asst-row:last-child .msg-content');
  if (!last) { paintThread(thread, true); return; }
  last.innerHTML = renderMarkdown(text) + (withCursor ? '<span class="stream-cursor">▏</span>' : '');
  bindCopyButtons(last);
}

/**
 * Split a streaming turn into a rendered reasoning header and the answer text
 * that gets typed out. The model wraps its reasoning in a collapsible
 * `<details><summary>Рассуждает</summary>…</details>` block (raw HTML); typing
 * that out as literal tags looks broken, so we render it as a real collapsible
 * — open while it's still streaming, collapsed once the answer begins — and
 * only typewrite the answer that follows.
 */
function splitTurn(raw) {
  const t = stripAgentTags(raw);
  const i = t.search(/<details>/i);
  if (i === -1) return { head: '', typed: t };
  const before = t.slice(0, i);
  const rest = t.slice(i + '<details>'.length);
  const end = rest.search(/<\/details>/i);
  if (end === -1) {
    // Reasoning still streaming → show it open, nothing to type yet.
    return { head: renderMarkdown('<details open>' + rest + '</details>'), typed: before };
  }
  const inner = rest.slice(0, end);
  const after = rest.slice(end + '</details>'.length);
  return {
    head: renderMarkdown('<details>' + inner + '</details>'),
    typed: (before + after).replace(/^\s+/, '')
  };
}

/**
 * Incremental renderer for the live (last) assistant message.
 *
 * - `committed` text (finalised turns + tool lines) is markdown-rendered into
 *   its own block, and only re-rendered when it actually changes.
 * - The current turn's `visible` text is the *target*; a steady rАF ticker
 *   reveals characters from what's shown toward that target, each in its own
 *   fade-in span. Because the network delivers tokens in bursts, the ticker
 *   decouples reveal cadence from arrival: letters appear at a smooth pace,
 *   and it speeds up automatically as the backlog grows so it never lags
 *   behind nor stalls the app. Spans already on screen are never touched, so
 *   their CSS animations finish independently on the compositor.
 * - Revealed spans are coalesced into a single text node, so a long answer
 *   never accumulates thousands of DOM nodes.
 *
 * @param {() => void} onReveal called after each reveal (e.g. to auto-scroll)
 */
function createLiveView(thread, onReveal) {
  const root = thread.querySelector('.asst-row:last-child .msg-content');
  if (!root) return null;
  root.innerHTML = '';
  const committedEl = document.createElement('div');
  committedEl.className = 'md-committed';
  const headEl = document.createElement('div'); // live reasoning (<details>) block
  headEl.className = 'md-head';
  const liveEl = document.createElement('span');
  liveEl.className = 'md-live';
  const settled = document.createTextNode(''); // already-revealed plain text
  liveEl.appendChild(settled);
  const cursor = document.createElement('span');
  cursor.className = 'stream-cursor';
  cursor.textContent = '▏';
  root.append(committedEl, headEl, liveEl, cursor);

  let committedShown = null;
  let headShown = null;
  let target = '';     // full visible text that has arrived so far
  let shown = '';      // visible plain text already revealed on screen
  let spans = [];      // recently-revealed fade spans, oldest → newest
  let raf = 0;

  const resetLive = (prefix) => {
    spans = [];
    settled.data = prefix;
    liveEl.textContent = '';
    liveEl.appendChild(settled);
    shown = prefix;
  };

  const tick = () => {
    raf = 0;
    if (!liveEl.isConnected) return; // thread was repainted → view is dead
    const backlog = target.length - shown.length;
    if (backlog <= 0) return; // caught up; ticker restarts on the next update
    // Reveal a few chars per frame, faster when we're further behind so big
    // bursts (and the final dump) flush quickly without ever blocking.
    const step = Math.max(1, Math.ceil(backlog / 8));
    for (let i = 0; i < step; i++) {
      const span = document.createElement('span');
      span.className = 'tok';
      span.textContent = target[shown.length];
      liveEl.appendChild(span);
      spans.push(span);
      shown += span.textContent;
    }
    while (spans.length > 80) {
      const s = spans.shift();
      settled.appendData(s.textContent);
      s.remove();
    }
    onReveal?.();
    raf = requestAnimationFrame(tick);
  };
  const ensureTicking = () => { if (!raf) raf = requestAnimationFrame(tick); };

  return {
    update(committed, head, typed) {
      if (committed !== committedShown) {
        committedEl.innerHTML = renderMarkdown(committed);
        bindCopyButtons(committedEl);
        committedShown = committed;
        target = '';
        resetLive(''); // the previous turn was folded into `committed`
      }
      // Reasoning block: already-rendered HTML, refreshed only when it changes.
      if (head !== headShown) {
        headEl.innerHTML = head;
        bindCopyButtons(headEl);
        headShown = head;
      }
      // Divergence (typed shrank) happens only when a tag starts streaming and
      // gets stripped back out — drop the revealed tail past the agreed prefix
      // so we don't keep characters that vanished from the source.
      let p = 0;
      const n = Math.min(shown.length, typed.length);
      while (p < n && shown[p] === typed[p]) p++;
      if (p < shown.length) resetLive(typed.slice(0, p));
      target = typed;
      ensureTicking();
    }
  };
}

function forceScroll(thread) { thread.scrollTop = thread.scrollHeight; }

/* ---------------- approval card (plan / tool / bash confirmation) ---------------- */
let approvalCard = null;
function removeApprovalCard() {
  approvalCard?.remove();
  approvalCard = null;
}
/** Render an inline approval prompt and resolve via api.mistral.respond(). */
function showApprovalCard(thread, { kind, title, body, code, okText }) {
  removeApprovalCard(); // only one decision at a time
  const card = document.createElement('div');
  card.className = `approval-card ${kind}`;
  card.innerHTML = `
    <div class="approval-head">
      <span class="approval-glyph"></span>
      <span class="approval-title">${escapeHtml(title)}</span>
    </div>
    ${code ? `<pre class="approval-code"><code>${escapeHtml(code)}</code></pre>` : ''}
    ${body ? `<div class="approval-body">${body}</div>` : ''}
    <div class="approval-actions">
      <button class="btn ghost sm" data-act="reject">Отклонить</button>
      <button class="btn primary sm" data-act="approve">${escapeHtml(okText || 'Разрешить')}</button>
    </div>`;
  thread.appendChild(card);
  approvalCard = card;
  forceScroll(thread);

  const respond = (approved) => {
    removeApprovalCard();
    api.mistral.respond(approved);
  };
  card.querySelector('[data-act="approve"]').addEventListener('click', () => respond(true));
  card.querySelector('[data-act="reject"]').addEventListener('click', () => respond(false));
}

/* ---------------- conversation transitions ---------------- */
async function newChat(repaint = true) {
  await persistConvo();
  const settings = await getSettings();
  convo = freshConvo(settings.model || 'mistral-large-latest');
  // A new chat starts with no working folder and no todos bound to it.
  await api.workspace.set('');
  await api.todos.set([]);
  if (repaint) {
    const thread = document.querySelector('#thread');
    if (thread) paintThread(thread);
  }
}

async function openSession(session, repaint = true) {
  await persistConvo();
  convo = {
    id: session.id,
    savedId: session.id,
    title: session.title,
    model: session.model,
    createdAt: session.createdAt,
    messages: session.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.skillUsed ? { skillUsed: m.skillUsed } : {}),
      ...(m.toolChars ? { toolChars: m.toolChars } : {}),
      ...(m.imageTokens ? { imageTokens: m.imageTokens } : {})
    })),
    workingDir: session.workingDir || '',
    todos: session.todos || []
  };
  // Restore this chat's working folder + todos as the active state.
  await api.workspace.set(convo.workingDir);
  await api.todos.set(convo.todos);
  if (repaint) {
    const thread = document.querySelector('#thread');
    if (thread) paintThread(thread);
  }
}

async function activePreset(settings) {
  const presets = (await store.get('presets')) || [];
  return presets.find((p) => p.id === settings.activePresetId) || presets[0] || null;
}

/* ---------------- todos popover ---------------- */
let todosPop = null;
function closeTodosPopover() {
  todosPop?.remove();
  todosPop = null;
  document.removeEventListener('click', onDocClickTodos);
}
function onDocClickTodos(e) {
  if (!e.target.closest('#todosPop') && !e.target.closest('#todosBtn')) closeTodosPopover();
}
async function toggleTodosPopover(container, onChange) {
  if (todosPop) { closeTodosPopover(); return; }
  const anchor = container.querySelector('#todosBtn');
  const todos = await api.todos.get();

  todosPop = document.createElement('div');
  todosPop.id = 'todosPop';
  todosPop.className = 'todos-pop';
  const list = todos.length
    ? todos.map((t) => `
        <div class="todo-item ${t.done ? 'done' : ''}" data-id="${t.id}">
          <span class="cbox ${t.done ? 'on' : ''}"></span>
          <span class="todo-text">${escapeHtml(t.text)}</span>
        </div>`).join('')
    : '<div class="todo-empty">No todos yet. The assistant will add them as it works.</div>';
  todosPop.innerHTML = `
    <div class="todos-head"><span class="lbl">Todos</span>${todos.length ? '<button class="btn ghost sm" id="todosClear">Clear all</button>' : ''}</div>
    <div class="todos-list">${list}</div>`;

  // Position under the anchor.
  const r = anchor.getBoundingClientRect();
  document.getElementById('overlayHost').appendChild(todosPop);
  todosPop.style.top = `${r.bottom + 6}px`;
  todosPop.style.right = `${window.innerWidth - r.right}px`;

  todosPop.querySelectorAll('.todo-item').forEach((el) =>
    el.addEventListener('click', async () => {
      await api.todos.toggle(el.dataset.id);
      closeTodosPopover();
      await onChange();
      toggleTodosPopover(container, onChange); // reopen with fresh state
    }));
  todosPop.querySelector('#todosClear')?.addEventListener('click', async () => {
    await api.todos.clear();
    closeTodosPopover();
    await onChange();
  });

  setTimeout(() => document.addEventListener('click', onDocClickTodos), 0);
}

/* ---------------- ai permission mode popover ---------------- */
let aiPermPop = null;
function closeAiPermPopover() {
  aiPermPop?.remove();
  aiPermPop = null;
  document.removeEventListener('click', onDocClickAiPerm);
}
function onDocClickAiPerm(e) {
  if (!e.target.closest('#aiPermPop') && !e.target.closest('#aiPermBtn')) closeAiPermPopover();
}
async function toggleAiPermPopover(container) {
  if (aiPermPop) { closeAiPermPopover(); return; }
  const anchor = container.querySelector('#aiPermBtn');
  const settings = await getSettings();

  aiPermPop = document.createElement('div');
  aiPermPop.id = 'aiPermPop';
  aiPermPop.className = 'ai-perm-pop';
  aiPermPop.innerHTML = `
    <div class="ai-perm-head"><span class="lbl">Права ИИ</span></div>
    <div class="ai-perm-list">
      ${PERM_MODES.map((m) => `
        <div class="ai-perm-item ${m.id === settings.aiPermissionMode ? 'active' : ''}" data-mode="${m.id}">
          <div class="ai-perm-label">${escapeHtml(m.label)}</div>
          <div class="ai-perm-desc">${escapeHtml(m.desc)}</div>
        </div>`).join('')}
    </div>`;

  // Position above the anchor (the chip sits at the bottom of the screen).
  const r = anchor.getBoundingClientRect();
  document.getElementById('overlayHost').appendChild(aiPermPop);
  aiPermPop.style.bottom = `${window.innerHeight - r.top + 6}px`;
  aiPermPop.style.left = `${r.left}px`;

  aiPermPop.querySelectorAll('.ai-perm-item').forEach((el) =>
    el.addEventListener('click', async () => {
      const mode = el.dataset.mode;
      // Autopilot is an early-access mode — warn before enabling it.
      if (mode === 'autopilot') {
        const ok = await confirmDialog({
          title: 'Включить Autopilot (Beta)?',
          body: 'В этом режиме ИИ выполняет действия и команды без подтверждения. Это ранний доступ — используйте на свой риск.',
          confirmText: 'Включить',
          danger: true
        });
        if (!ok) return;
      }
      await saveSettings({ aiPermissionMode: mode });
      const label = container.querySelector('#aiPermLabel');
      if (label) label.textContent = permLabel(mode);
      toast(`Режим: ${permLabel(mode)}`, 'info', 1800);
      closeAiPermPopover();
    }));

  setTimeout(() => document.addEventListener('click', onDocClickAiPerm), 0);
}

/* ---------------- context-window usage popover ---------------- */
let ctxPop = null;
function closeCtxPopover() {
  ctxPop?.remove();
  ctxPop = null;
  document.removeEventListener('click', onDocClickCtx);
}
function onDocClickCtx(e) {
  if (!e.target.closest('#ctxPop') && !e.target.closest('#ctxGauge')) closeCtxPopover();
}
function toggleCtxPopover(container, b, limit) {
  if (ctxPop) { closeCtxPopover(); return; }
  const anchor = container.querySelector('#ctxGauge');
  const pct = Math.min(100, Math.round((b.total / limit) * 100));
  const tk = (n) => `${n.toLocaleString()} ток.`;
  const row = (label, value) => `<div class="ctx-row"><span>${label}</span><span class="mono">${tk(value)}</span></div>`;

  ctxPop = document.createElement('div');
  ctxPop.id = 'ctxPop';
  ctxPop.className = 'ctx-pop';
  ctxPop.innerHTML = `
    <div class="ctx-head"><span class="lbl">Контекстное окно</span></div>
    <div class="ctx-body">
      <div class="ctx-bar"><div class="fill ${pct >= 95 ? 'crit' : pct >= 80 ? 'warn' : ''}" style="width:${pct}%"></div></div>
      <div class="ctx-total mono">${b.total.toLocaleString()} / ${limit.toLocaleString()} ток. · ${pct}%</div>
      <div class="ctx-group-title">Система</div>
      ${row('Системные инструкции', b.system)}
      ${row('Объяснение инструментов', b.tools)}
      <div class="ctx-group-title">Пользовательский контекст</div>
      ${row('Сообщений', b.messages)}
      ${row('Результат инструментов', b.toolResults)}
    </div>`;

  // Position above the gauge.
  const r = anchor.getBoundingClientRect();
  document.getElementById('overlayHost').appendChild(ctxPop);
  ctxPop.style.bottom = `${window.innerHeight - r.top + 6}px`;
  ctxPop.style.left = `${r.left}px`;

  setTimeout(() => document.addEventListener('click', onDocClickCtx), 0);
}

/* ---------------- lifecycle ---------------- */
function destroy() {
  if (chatPage._onKey) { document.removeEventListener('keydown', chatPage._onKey); chatPage._onKey = null; }
  closeTodosPopover();
  closeAiPermPopover();
  closeCtxPopover();
  // Note: we intentionally keep an active stream alive so it survives a quick
  // page switch; the subscription closes itself on done/error.
}

const chatPage = { render, destroy, _onKey: null };
export default chatPage;
