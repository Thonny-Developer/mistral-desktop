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
/* Developer mode: read fresh on each render/send. When on, every user message
 * carries a terminal button that opens the exact payload sent to the API. */
let devMode = false;
let peekFormat = 'pretty'; // dev inspector view: 'pretty' | 'json'

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
 * Map a stored message to what the API receives: UI-only metadata is dropped,
 * and any attached-document text is folded into the content so the model sees
 * it on every turn (the bubble itself only shows a file chip).
 */
function apiMessage(m, reasoningModel = false) {
  let content = m.content;
  // Assistant turns store their reasoning inside our <details> blocks. Replay it
  // to reasoning-capable models as structured `thinking` chunks (Mistral degrades
  // if the trace is dropped between turns); strip it to plain text for the rest.
  if (m.role === 'assistant' && typeof content === 'string' && /<details\b/i.test(content)) {
    const chunks = reasoningToChunks(content);
    content = (reasoningModel && chunks.some((c) => c.type === 'thinking'))
      ? chunks
      : chunks.filter((c) => c.type === 'text').map((c) => c.text).join('\n\n');
  } else {
    content = stripReasonMeta(content);
  }
  if (!m.docs || !m.docs.length) return { role: m.role, content };
  const blocks = m.docs.map((d) => `[Вложенный файл: ${d.name}]\n${d.text}`).join('\n\n');
  if (Array.isArray(content)) {
    return { role: m.role, content: [{ type: 'text', text: blocks }, ...content] };
  }
  const base = typeof content === 'string' ? content : '';
  return { role: m.role, content: base ? `${base}\n\n${blocks}` : blocks };
}

/** Strip our render-only data-secs attribute so the model never sees (and then
 *  imitates) it in its own reasoning blocks. */
function stripReasonMeta(content) {
  if (typeof content !== 'string') return content;
  return content.replace(/<details\b[^>]*>/gi, '<details>');
}

/** Model families that emit native reasoning (thinking) chunks — small/medium via
 *  reasoning_effort, magistral always. Only these get the reasoning trace replayed
 *  as structured chunks; everything else receives the answer as plain text. */
const REASONING_MODEL_RE = /^(mistral-(small|medium)|magistral)/i;
function modelSupportsReasoning(model) {
  return REASONING_MODEL_RE.test(model || '');
}

/**
 * Turn a stored assistant string carrying reasoning `<details>` blocks into
 * Mistral's structured content chunks: each block becomes a `thinking` chunk, the
 * surrounding answer/tool text becomes `text` chunks, order preserved so an
 * interleaved tool-loop turn (thinking → tool → thinking → answer) round-trips
 * faithfully — which is what keeps the reasoning trace across turns.
 * Robust to a truncated stream: an unclosed <details> (no matching </details>)
 * treats the remainder as reasoning rather than dropping it; empty blocks and
 * whitespace-only gaps produce no chunk.
 * NOTE: mirrored by test/reasoning.test.mjs — keep the two in sync.
 */
function reasoningToChunks(text) {
  const chunks = [];
  const OPEN = /<details\b[^>]*>/i;
  let rest = String(text);
  while (true) {
    const open = rest.match(OPEN);
    if (!open) break;
    const before = rest.slice(0, open.index);
    if (before.trim()) chunks.push({ type: 'text', text: before });
    const after = rest.slice(open.index + open[0].length);
    const closeIdx = after.search(/<\/details>/i);
    const inner = closeIdx === -1 ? after : after.slice(0, closeIdx);
    const think = inner.replace(/<summary\b[^>]*>[\s\S]*?<\/summary>/i, '').trim();
    if (think) chunks.push({ type: 'thinking', thinking: [{ type: 'text', text: think }] });
    if (closeIdx === -1) { rest = ''; break; } // truncated: nothing valid left after
    rest = after.slice(closeIdx + '</details>'.length);
  }
  if (rest.trim()) chunks.push({ type: 'text', text: rest });
  return chunks;
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
  devMode = !!settings.devMode;
  peekFormat = settings.devPeekFormat === 'json' ? 'json' : 'pretty';
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
          <span class="streaming hidden" id="thStreaming"><span class="pulse"></span><span id="thStreamingTxt">working</span></span>
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
            <input type="file" id="fileInput" multiple hidden />
            <button class="icon-btn" id="attachBtn" title="Прикрепить файл (изображение, PDF, документ, текст…)">
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
  // Dev inspector: the terminal button lives inside repainted message rows, so
  // open the peek via delegation on the stable thread container.
  thread.addEventListener('click', (e) => {
    const btn = e.target.closest('.dev-peek');
    if (!btn) return;
    const msg = convo.messages[parseInt(btn.dataset.idx, 10)];
    if (msg && msg.request) openDevPeek(btn, msg.request);
  });
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
  let pendingDocs = [];   // [{ id, name, ext, text, chars, tokens, truncated }]

  function renderAtts() {
    atts.hidden = pendingImages.length === 0 && pendingDocs.length === 0;
    const imgHtml = pendingImages.map((im) =>
      `<div class="att-thumb" title="${escapeHtml(im.name)} · ${im.w}×${im.h}">
         <img src="${im.dataUrl}" alt="" />
         <button class="att-del" data-id="${im.id}" title="Убрать">×</button>
       </div>`).join('');
    const docHtml = pendingDocs.map((d) =>
      `<div class="att-doc" title="${escapeHtml(d.name)} · ${d.chars} симв.${d.truncated ? ' · обрезано' : ''}">
         <span class="att-doc-ext">${escapeHtml((d.ext || 'file').toUpperCase())}</span>
         <span class="att-doc-name">${escapeHtml(d.name)}</span>
         <button class="att-del" data-doc="${d.id}" title="Убрать">×</button>
       </div>`).join('');
    atts.innerHTML = imgHtml + docHtml;
    atts.querySelectorAll('.att-del[data-id]').forEach((b) =>
      b.addEventListener('click', () => {
        pendingImages = pendingImages.filter((x) => x.id !== b.dataset.id);
        renderAtts();
        updateTokens();
      }));
    atts.querySelectorAll('.att-del[data-doc]').forEach((b) =>
      b.addEventListener('click', () => {
        pendingDocs = pendingDocs.filter((x) => x.id !== b.dataset.doc);
        renderAtts();
        updateTokens();
      }));
  }

  // Route attachments: images keep the downscale-to-FHD path; everything else
  // is sent to main for text extraction so only the extracted text enters context.
  async function addFiles(fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    await addImageFiles(files.filter(isImageFile));
    for (const f of files.filter((f) => !isImageFile(f))) await addDocFile(f);
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

  async function addDocFile(file) {
    try {
      const buf = await file.arrayBuffer();
      const res = await api.docs.extract({ name: file.name, data: new Uint8Array(buf) });
      if (!res?.ok) {
        toast(`«${file.name}»: ${res?.error || 'не удалось прочитать файл'}`, 'error', 5000);
        return;
      }
      if (!res.text || !res.text.trim()) {
        toast(`В «${file.name}» не нашлось текста для извлечения`, 'info', 4000);
        return;
      }
      const chars = res.chars || res.text.length;
      pendingDocs.push({
        id: uid(), name: file.name || 'file', ext: res.ext || '', text: res.text,
        chars, tokens: Math.ceil(chars / 4), truncated: !!res.truncated
      });
      if (res.truncated) toast(`«${file.name}» большой — взял первую часть текста`, 'info', 4000);
      renderAtts();
      updateTokens();
      composer.focus();
    } catch (e) {
      toast(`Ошибка чтения «${file.name}»`, 'error');
    }
  }

  container.querySelector('#attachBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
  composer.addEventListener('paste', (e) => {
    const imgs = [...(e.clipboardData?.items || [])].filter((it) => it.type.startsWith('image/'));
    if (imgs.length) { e.preventDefault(); addImageFiles(imgs.map((it) => it.getAsFile()).filter(Boolean)); }
  });
  composerEl.addEventListener('dragover', (e) => { e.preventDefault(); composerEl.classList.add('dragover'); });
  composerEl.addEventListener('dragleave', (e) => { if (e.target === composerEl) composerEl.classList.remove('dragover'); });
  composerEl.addEventListener('drop', (e) => {
    e.preventDefault();
    composerEl.classList.remove('dragover');
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
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
        imgTokens += (m.imageTokens || 0) + (m.docTokens || 0);
      }
    }
    imgTokens += pendingImages.reduce((s, i) => s + i.tokens, 0) + pendingDocs.reduce((s, d) => s + d.tokens, 0); // not sent yet, but about to be
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
        imgTokens += (m.imageTokens || 0) + (m.docTokens || 0);
      }
    }
    imgTokens += pendingImages.reduce((s, i) => s + i.tokens, 0) + pendingDocs.reduce((s, d) => s + d.tokens, 0);
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
    // When Mistral serves part of the prefix from its cache, show how much — those
    // tokens are billed at a fraction of the price, so it's the real prefix cost.
    const cached = lastUsage?.prompt_tokens_details?.cached_tokens || 0;
    tokMeta.textContent = cached > 0
      ? `·  ${b.total.toLocaleString()} tok · ${cached.toLocaleString()} из кэша`
      : `·  ${b.total.toLocaleString()} tok`;
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

  // Rate limited — surface the wait (toast + streaming pill) without rolling
  // anything back; the request is retried automatically in the background.
  const setStreamLabel = (txt) => {
    const el = container.querySelector('#thStreamingTxt');
    if (el && el.textContent !== txt) el.textContent = txt;
  };
  const noteRateLimitWait = (msg) => {
    const secs = Math.max(1, Math.round((msg.waitMs || 0) / 1000));
    // The same retry channel now also carries transient network / 5xx waits.
    const label = msg.reason === 'network' ? 'сеть' : msg.reason === 'server' ? 'сервер' : 'лимит';
    setStreamLabel(`${label} · повтор через ${secs}s`);
    const human = msg.reason === 'network'
      ? `Проблема с сетью. Повтор через ${secs} с… (попытка ${msg.attempt}/${msg.maxRetries})`
      : msg.reason === 'server'
        ? `Сервер Mistral недоступен. Повтор через ${secs} с… (попытка ${msg.attempt}/${msg.maxRetries})`
        : `Достигнут лимит запросов. Жду ${secs} с и продолжаю… (попытка ${msg.attempt}/${msg.maxRetries})`;
    toast(human, 'info', Math.min(6000, Math.max(2500, msg.waitMs || 3000)));
  };

  // --- Local model loading indicator ---------------------------------------
  // A local server (LM Studio) loads the model into memory on first use, so the
  // first reply can take a while with nothing on screen. The main process
  // reports `model-loading` stages (see mistral.js) and we render a staged
  // panel inside the pending assistant bubble so the wait is legible.
  let loadingTimer = null;
  const LOAD_STAGES = [
    { k: 'connect', label: 'Подключение к локальному серверу' },
    { k: 'load', label: 'Загрузка модели в память' },
    { k: 'warm', label: 'Обработка запроса :3' }
  ];
  function showModelLoading(msg) {
    const slot = container.querySelector('.asst-row:last-child .msg-content');
    if (!slot) return;
    let el = slot.querySelector('#modelLoading');
    // Full staged panel only while the model is actually initialising into
    // memory (`loading`). If the model is already resident and we're merely
    // waiting on prompt processing (`warming`) with no prior load shown, use a
    // compact one-line spinner instead.
    const compact = !el && msg.stage === 'warming';
    if (!el) {
      slot.classList.add('is-loading');
      el = document.createElement('div');
      el.className = compact ? 'model-loading compact' : 'model-loading';
      el.id = 'modelLoading';
      el.innerHTML = compact
        ? `
        <div class="ml-head">
          <span class="ml-spin"></span>
          <span class="ml-title">Обработка запроса :3</span>
          <span class="ml-elapsed" id="mlElapsed">0&nbsp;с</span>
        </div>`
        : `
        <div class="ml-head">
          <span class="ml-spin"></span>
          <span class="ml-title">Подготовка модели</span>
          <span class="ml-elapsed" id="mlElapsed">0&nbsp;с</span>
        </div>
        <ul class="ml-stages">
          ${LOAD_STAGES.map((s) => `<li class="ml-stage" data-k="${s.k}"><span class="ml-dot"></span><span>${s.label}</span></li>`).join('')}
        </ul>
        <div class="ml-hint" id="mlHint"></div>`;
      slot.prepend(el);
    }
    // 'warming' = model resident, prompt processing (stage 3); else loading (2).
    if (!el.classList.contains('compact')) {
      const activeIdx = msg.stage === 'warming' ? 2 : 1;
      el.querySelectorAll('.ml-stage').forEach((li, i) => {
        li.classList.toggle('done', i < activeIdx);
        li.classList.toggle('active', i === activeIdx);
      });
    }
    setStreamLabel(msg.stage === 'warming' ? 'почти готово…' : 'загрузка модели…');
    el.dataset.startedAt = String(msg.startedAt || Date.now());
    if (!loadingTimer) {
      const tick = () => {
        const node = container.querySelector('#mlElapsed');
        if (!node) { hideModelLoading(); return; } // bubble gone → stop ticking
        const secs = Math.max(0, Math.round((Date.now() - Number(el.dataset.startedAt)) / 1000));
        node.innerHTML = `${secs}&nbsp;с`;
        const hint = container.querySelector('#mlHint');
        if (hint) hint.textContent = secs >= 10
          ? 'Крупная модель грузится дольше — идёт чтение весов с диска.'
          : '';
      };
      tick();
      loadingTimer = setInterval(tick, 1000);
    }
  }
  function hideModelLoading() {
    if (loadingTimer) { clearInterval(loadingTimer); loadingTimer = null; }
    const el = container.querySelector('#modelLoading');
    if (el) {
      const slot = el.closest('.msg-content');
      el.remove();
      slot?.classList.remove('is-loading');
    }
  }

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
        // A fully typed command name is submitted on Enter; a partial one is
        // completed to the highlighted suggestion first.
        const typed = composer.value.toLowerCase();
        const exact = allSlashCommands().some((c) => c.name.toLowerCase() === typed);
        if (!exact) {
          e.preventDefault();
          applySlashSelection();
          return;
        }
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
    const docs = pendingDocs.slice();
    if ((!text && !imgs.length && !docs.length) || streaming) return;

    if (text.startsWith('/') && !imgs.length && !docs.length) {
      const handled = await handleSlashCommand(text);
      if (handled) {
        composer.value = '';
        composer.style.height = 'auto';
        updateTokens();
        closeSlashSuggestions();
        return;
      }
    }

    lastUserMessage = text; // save for error recovery
    const settings = await getSettings();
    devMode = !!settings.devMode; // pick up a mid-session toggle before this send
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
    // A /skill invocation carries the whole playbook as its content, but we
    // show a compact pill instead of the full text (see paintThread).
    if (opts.skillInvoke) userMsg.skillInvoke = opts.skillInvoke;
    if (imgs.length) userMsg.imageTokens = imgs.reduce((s, i) => s + i.tokens, 0);
    // Attached documents: keep the extracted text as message metadata (shown as
    // a file chip, folded into the outgoing content at send time) so the model
    // sees the text on every turn while the chat bubble stays clean.
    if (docs.length) {
      userMsg.docs = docs.map((d) => ({ name: d.name, ext: d.ext, text: d.text, chars: d.chars }));
      userMsg.docTokens = docs.reduce((s, d) => s + d.tokens, 0);
    }
    convo.messages.push(userMsg);

    pendingImages = [];
    pendingDocs = [];
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
    // toolChars, imageTokens). content may be a string or a vision parts array;
    // attached-document text is folded into the content here.
    const reasoningModel = modelSupportsReasoning(settings.model);
    outgoing.push(...convo.messages.map((m) => apiMessage(m, reasoningModel)));

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
    let reasonStart = 0;  // wall-clock when the current turn's reasoning opened
    let reasonSecs = 0;   // measured reasoning duration (0 until the block closes)

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
          imgTokens += (m.imageTokens || 0) + (m.docTokens || 0);
        }
      }
      imgTokens += pendingImages.reduce((s, i) => s + i.tokens, 0) + pendingDocs.reduce((s, d) => s + d.tokens, 0); // not sent yet, but about to be
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
      if (live) { const { head, typed } = splitTurn(rawTurn, reasonSecs); live.update(committed, head, typed); }
      else { updateLastAssistant(thread, asstMsg.content, true); if (autoScroll) forceScroll(thread); }
      updateTokens(); // keep the context gauge live as tokens stream in
    };
    const scheduleFlush = () => { if (!rafPending) { rafPending = true; requestAnimationFrame(flush); } };

    // Commit the current turn's visible text before tool lines are appended.
    // Bake the measured reasoning duration into the block so "Думал N сек"
    // survives re-render and history reload.
    const commitTurn = () => {
      let visible = stripAgentTags(rawTurn).replace(/\s+$/, '');
      if (visible && reasonSecs) {
        // Normalize the opening tag (whatever attributes the model emitted) to
        // carry exactly our measured duration.
        visible = visible.replace(/<details\b[^>]*>/i, `<details data-secs="${reasonSecs}">`);
      }
      if (visible) committed += (committed ? '\n\n' : '') + visible;
      rawTurn = '';
      reasonStart = 0; reasonSecs = 0; // reset for the next turn's reasoning
    };

    unsubStream = api.mistral.onStream((msg) => {
      // Local model load progress — render it and wait for real output.
      if (msg.type === 'model-loading') { showModelLoading(msg); return; }
      // Dev inspector: the exact payload sent to the API for this user turn.
      // Attach it to the user message and, in dev mode, drop the terminal button
      // into the already-painted user row without disturbing the live stream.
      if (msg.type === 'request') {
        userMsg.request = msg.body;
        persistConvo();
        if (devMode) injectDevPeek(thread, convo.messages.indexOf(userMsg));
        return;
      }
      // Anything else means output (or an end state) has begun → drop the loader.
      if (loadingTimer) hideModelLoading();
      if (msg.type === 'token') {
        rawTurn += msg.delta;
        setStreamLabel('working'); // tokens flowing again → clear any "wait" label
        outputTokens += estimateTokens(msg.delta);
        // Time the reasoning block: it opens at the first <details> and the
        // duration is fixed the moment </details> arrives.
        if (!reasonStart && /<details>/i.test(rawTurn)) reasonStart = Date.now();
        if (reasonStart && !reasonSecs && /<\/details>/i.test(rawTurn)) {
          reasonSecs = Math.max(1, Math.round((Date.now() - reasonStart) / 1000));
        }
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
      } else if (msg.type === 'rate-limit-wait') {
        // Hit the API rate limit — we wait and retry instead of rolling back.
        if (msg.rateLimit) { lastRateLimit = msg.rateLimit; displayRateLimit(); }
        noteRateLimitWait(msg);
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

    api.mistral.send({ messages: outgoing, allowedTools: opts.allowedTools, sessionId: convo.savedId || convo.id });

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
    hideModelLoading(); // clear any loader left if the turn ended without output
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
    await send({
      allowedTools: rendered.allowedTools,
      skillName: rendered.name,
      // fold the playbook body into a compact pill in the UI; the model still
      // receives the full prompt from composer.value
      skillInvoke: { name: rendered.name, arg: arg || '' }
    });
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
      const peek = devMode && m.request ? devPeekButton(i) : '';
      // Skill invocation: fold the full playbook into a compact pill.
      if (m.skillInvoke) {
        const argHtml = m.skillInvoke.arg
          ? ` <span class="skill-invoke-arg">${escapeHtml(m.skillInvoke.arg)}</span>`
          : '';
        return `<div class="msg-row user">${peek}<div class="skill-invoke">✦ Скилл <b>/${escapeHtml(m.skillInvoke.name)}</b>${argHtml}</div></div>`;
      }
      const utext = contentText(m.content);
      const uimgs = contentImages(m.content);
      const imgsHtml = uimgs.length
        ? `<div class="bubble-imgs">${uimgs.map((u) => `<img class="bubble-img" src="${u}" alt="" />`).join('')}</div>`
        : '';
      const docsHtml = (m.docs && m.docs.length)
        ? `<div class="bubble-docs">${m.docs.map((d) =>
            `<span class="bubble-doc"><span class="bubble-doc-ext">${escapeHtml((d.ext || 'file').toUpperCase())}</span>${escapeHtml(d.name)}</span>`).join('')}</div>`
        : '';
      return `<div class="msg-row user">${peek}<div class="bubble user">${imgsHtml}${docsHtml}${utext ? escapeHtml(utext) : ''}</div></div>`;
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
function splitTurn(raw, reasonSecs = 0) {
  const t = stripAgentTags(raw);
  // Match the opening tag with ANY attributes (open, data-secs, …) so the
  // reasoning block is never mistaken for answer text and leaked as raw markup.
  const open = /<details\b[^>]*>/i.exec(t);
  if (!open) return { head: '', typed: t };
  const i = open.index;
  const before = t.slice(0, i);
  const rest = t.slice(i + open[0].length);
  const end = rest.search(/<\/details>/i);
  if (end === -1) {
    // Reasoning still streaming → collapsed pill ("Думает… · N токенов"); the
    // thoughts stay hidden (data-live drives the live spinner/counter), and
    // there's nothing to type out yet.
    return { head: renderMarkdown('<details data-live="1">' + rest + '</details>'), typed: before };
  }
  const inner = rest.slice(0, end);
  const after = rest.slice(end + '</details>'.length);
  // Reasoning finished → closed block carries its measured duration.
  const tag = reasonSecs ? `<details data-secs="${reasonSecs}">` : '<details>';
  return {
    head: renderMarkdown(tag + inner + '</details>'),
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
      // Preserve a mid-stream peek — if the user expanded the pill to watch the
      // thoughts, keep it open across the re-render instead of snapping shut.
      if (head !== headShown) {
        const wasOpen = headEl.querySelector('details')?.open;
        headEl.innerHTML = head;
        if (wasOpen) headEl.querySelector('details')?.setAttribute('open', '');
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
      ...(m.imageTokens ? { imageTokens: m.imageTokens } : {}),
      ...(m.docs ? { docs: m.docs } : {}),
      ...(m.docTokens ? { docTokens: m.docTokens } : {})
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

/* ---------------- developer inspector (dev mode) ---------------- */
const TERM_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M4.5 6.3 6.6 8.4 4.5 10.5"/><path d="M8 10.5h3.6"/></svg>';
const COPY_SVG = '<svg viewBox="0 0 16 16"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M3 10.3V3.5a1 1 0 0 1 1-1h6.8"/></svg>';

/** Terminal button that opens the "what went to the API" inspector. */
function devPeekButton(i) {
  return `<button class="dev-peek" data-idx="${i}" title="Что ушло в API">${TERM_SVG}</button>`;
}

/** Insert the terminal button into an already-painted user row (mid-stream),
 *  without repainting the thread and killing the live view. */
function injectDevPeek(thread, idx) {
  if (idx < 0) return;
  const row = thread.children[idx];
  if (!row || !row.classList.contains('user') || row.querySelector('.dev-peek')) return;
  row.insertAdjacentHTML('afterbegin', devPeekButton(idx));
}

let devPeekPop = null;
function closeDevPeek() {
  devPeekPop?.remove();
  devPeekPop = null;
  document.removeEventListener('click', onDocClickPeek);
}
function onDocClickPeek(e) {
  if (!e.target.closest('.dev-peek-pop') && !e.target.closest('.dev-peek')) closeDevPeek();
}

/** Open the request inspector anchored to `anchor`, opening to its left. */
function openDevPeek(anchor, body) {
  const same = devPeekPop && devPeekPop._anchor === anchor;
  if (devPeekPop) closeDevPeek();
  if (same) return; // clicking the same button toggles it closed

  devPeekPop = document.createElement('div');
  devPeekPop.className = 'dev-peek-pop';
  devPeekPop._anchor = anchor;
  devPeekPop.innerHTML = `
    <div class="peek-head">
      <span class="lbl">Запрос к API</span>
      <div class="seg-group peek-fmt">
        <button class="seg ${peekFormat === 'pretty' ? 'active' : ''}" data-fmt="pretty">Красиво</button>
        <button class="seg ${peekFormat === 'json' ? 'active' : ''}" data-fmt="json">JSON</button>
      </div>
      <button class="peek-copy icon-btn" title="Скопировать JSON">${COPY_SVG}</button>
    </div>
    <div class="peek-body"></div>`;
  document.getElementById('overlayHost').appendChild(devPeekPop);

  const bodyEl = devPeekPop.querySelector('.peek-body');
  const paint = () => { bodyEl.innerHTML = peekFormat === 'json' ? renderPeekJson(body) : renderPeekPretty(body); };
  paint();

  devPeekPop.querySelectorAll('.peek-fmt .seg').forEach((seg) =>
    seg.addEventListener('click', () => {
      peekFormat = seg.dataset.fmt === 'json' ? 'json' : 'pretty';
      saveSettings({ devPeekFormat: peekFormat });
      devPeekPop.querySelectorAll('.peek-fmt .seg').forEach((s) => s.classList.toggle('active', s === seg));
      paint();
    }));
  devPeekPop.querySelector('.peek-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(body, null, 2)); toast('Скопировано', 'success', 1400); }
    catch { toast('Не удалось скопировать', 'error'); }
  });

  // Position to the LEFT of the button, clamped to the viewport.
  const r = anchor.getBoundingClientRect();
  const w = devPeekPop.offsetWidth;
  let left = r.left - 8 - w;
  if (left < 8) left = 8;
  devPeekPop.style.left = `${left}px`;
  const top = Math.max(8, Math.min(r.top, window.innerHeight - devPeekPop.offsetHeight - 8));
  devPeekPop.style.top = `${top}px`;

  setTimeout(() => document.addEventListener('click', onDocClickPeek), 0);
}

/** Human-readable request breakdown: params, tool list, and the message array. */
function renderPeekPretty(body) {
  const rows = [];
  const add = (k, v) => { if (v !== undefined && v !== null && v !== '') rows.push([k, v]); };
  add('model', body.model);
  add('temperature', body.temperature);
  add('top_p', body.top_p);
  add('max_tokens', body.max_tokens);
  add('stream', String(body.stream));
  add('tool_choice', body.tool_choice);
  add('prompt_cache_key', body.prompt_cache_key);
  if (body.response_format) add('response_format', body.response_format.type || 'json_schema');
  const params = rows.map(([k, v]) =>
    `<div class="peek-kv"><span class="k mono">${escapeHtml(k)}</span><span class="v mono">${escapeHtml(String(v))}</span></div>`).join('');

  const toolNames = (body.tools || []).map((t) => t.function?.name).filter(Boolean);
  const msgs = (body.messages || []).map((m) => {
    const meta = [];
    if (m.name) meta.push(m.name);
    if (m.tool_call_id) meta.push(m.tool_call_id);
    const calls = (m.tool_calls || []).map((tc) =>
      `<div class="peek-toolcall mono">→ ${escapeHtml(tc.function?.name || '?')}(${escapeHtml(tc.function?.arguments || '')})</div>`).join('');
    return `
      <div class="peek-msg peek-role-${escapeHtml(m.role)}">
        <div class="peek-msg-head">
          <span class="peek-role">${escapeHtml(m.role)}</span>
          ${meta.length ? `<span class="peek-meta mono">${escapeHtml(meta.join(' · '))}</span>` : ''}
        </div>
        ${m.content ? peekContent(m.content) : ''}
        ${calls}
      </div>`;
  }).join('');

  return `
    <div class="peek-sec-title">Параметры</div>
    <div class="peek-params">${params}</div>
    ${toolNames.length ? `
      <div class="peek-sec-title">Инструменты · ${toolNames.length}</div>
      <div class="peek-tools mono">${toolNames.map((n) => escapeHtml(n)).join(', ')}</div>` : ''}
    <div class="peek-sec-title">Сообщения · ${(body.messages || []).length}</div>
    ${msgs}`;
}

/** Render one message's content (string or vision parts array). */
function peekContent(content) {
  if (typeof content === 'string') return `<pre class="peek-pre">${escapeHtml(content)}</pre>`;
  if (Array.isArray(content)) {
    return content.map((p) => {
      if (p.type === 'text') return `<pre class="peek-pre">${escapeHtml(p.text || '')}</pre>`;
      if (p.type === 'image_url') {
        const u = typeof p.image_url === 'string' ? p.image_url : (p.image_url?.url || '');
        return `<div class="peek-img mono">🖼 ${escapeHtml(u)}</div>`;
      }
      return `<pre class="peek-pre">${escapeHtml(JSON.stringify(p))}</pre>`;
    }).join('');
  }
  return `<pre class="peek-pre">${escapeHtml(JSON.stringify(content))}</pre>`;
}

/** Raw request body as pretty-printed JSON. */
function renderPeekJson(body) {
  return `<pre class="peek-pre peek-json">${escapeHtml(JSON.stringify(body, null, 2))}</pre>`;
}

/* ---------------- lifecycle ---------------- */
function destroy() {
  if (chatPage._onKey) { document.removeEventListener('keydown', chatPage._onKey); chatPage._onKey = null; }
  closeTodosPopover();
  closeAiPermPopover();
  closeCtxPopover();
  closeDevPeek();
  // Note: we intentionally keep an active stream alive so it survives a quick
  // page switch; the subscription closes itself on done/error.
}

const chatPage = { render, destroy, _onKey: null };
export default chatPage;
