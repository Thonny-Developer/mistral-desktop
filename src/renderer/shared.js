/* Shared renderer utilities: store access, toasts, modals, markdown,
 * and small formatting helpers. Imported by every page. */
import { marked, hljs } from './vendor/libs.js';

const api = window.api;

/* ---------------- persistent store helpers ---------------- */
export const store = {
  get: (key) => api.store.get(key),
  set: (key, value) => api.store.set(key, value),
  del: (key) => api.store.delete(key)
};

/* default settings mirror main.js so the renderer never reads `undefined`. */
export const DEFAULT_SETTINGS = {
  endpoint: 'https://api.mistral.ai/v1',
  model: 'mistral-large-latest',
  temperature: 0.7,
  topP: 1,
  maxTokens: 0,
  stream: true,
  renderMarkdown: true,
  outputFormat: 'markdown',
  theme: 'dark',
  fontSize: 14,
  collapseSidebar: false,
  reasoningLevel: 'medium',
  aiPermissionMode: 'default',
  activePresetId: 'general'
};

export async function getSettings() {
  const s = await store.get('settings');
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await store.set('settings', next);
  return next;
}

/* ---------------- misc helpers ---------------- */
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** Cheap token estimate used in the UI (chars / 4). */
export const estimateTokens = (text) => Math.max(0, Math.ceil((text || '').length / 4));

export function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Human-friendly relative time (e.g. "2m ago", "Yesterday", "Apr 12"). */
export function formatRelative(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const diff = Date.now() - d.getTime();
  const min = 60_000, hr = 3_600_000, day = 86_400_000;
  if (diff < min) return 'just now';
  if (diff < hr) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hr)}h ago`;
  if (diff < 2 * day) return 'Yesterday';
  if (diff < 7 * day) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/* ---------------- markdown rendering ---------------- */
// marked v12 dropped the inline `highlight` option — we highlight code
// blocks ourselves after parsing (below), which also keeps us version-proof.
marked.setOptions({ breaks: true, gfm: true });

/**
 * Render markdown to HTML. Code fences get a wrapper + copy button and are
 * syntax-highlighted with highlight.js. Returns an HTML string; the caller
 * assigns it to innerHTML (model output is escaped by marked's defaults).
 */
/**
 * Strip agent directives (<action> / <remember>) from text, including a
 * trailing unclosed tag still streaming in. Used for live display.
 */
export function stripAgentTags(text) {
  return (text || '')
    .replace(/<action>[\s\S]*?<\/action>/gi, '')
    .replace(/<action>[\s\S]*$/i, '')
    .replace(/<remember>[\s\S]*?<\/remember>/gi, '')
    .replace(/<remember>[\s\S]*$/i, '');
}

export function renderMarkdown(text) {
  // Hide agent directives from the UI; their effects are shown as tool lines
  // and their persistence happens in the main process.
  const tmp = document.createElement('div');
  tmp.innerHTML = marked.parse(stripAgentTags(text));

  tmp.querySelectorAll('pre > code').forEach((code) => {
    // Detect the language from the `language-xxx` class marked emits.
    const langClass = [...code.classList].find((c) => c.startsWith('language-'));
    const lang = langClass ? langClass.slice('language-'.length) : '';
    try {
      const result = lang && hljs.getLanguage(lang)
        ? hljs.highlight(code.textContent, { language: lang })
        : hljs.highlightAuto(code.textContent);
      code.innerHTML = result.value;
      code.classList.add('hljs');
    } catch {
      // leave plain text on failure
    }

    // Wrap <pre> in .codeblock and add a copy button.
    const pre = code.parentElement;
    const wrap = document.createElement('div');
    wrap.className = 'codeblock';
    pre.replaceWith(wrap);
    wrap.appendChild(pre);
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.type = 'button';
    btn.textContent = 'copy';
    wrap.appendChild(btn);
  });
  return tmp.innerHTML;
}

/** Wire up copy buttons inside a rendered-markdown container (idempotent). */
export function bindCopyButtons(container) {
  container.querySelectorAll('.copy-btn:not([data-bound])').forEach((btn) => {
    btn.dataset.bound = '1';
    btn.addEventListener('click', async () => {
      const code = btn.closest('.codeblock')?.querySelector('code');
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code.innerText);
        btn.textContent = 'copied';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'copy'; btn.classList.remove('copied'); }, 1400);
      } catch {
        toast('Could not copy to clipboard', 'error');
      }
    });
  });
}

/* ---------------- toasts ---------------- */
export function toast(message, type = 'info', timeout = 4200) {
  const host = document.getElementById('toastHost');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="dot"></span><span class="msg"></span>`;
  el.querySelector('.msg').textContent = message;
  host.appendChild(el);
  const remove = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 180);
  };
  el.addEventListener('click', remove);
  if (timeout) setTimeout(remove, timeout);
}

/* ---------------- confirm modal ---------------- */
export function confirmDialog({ title, body, confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const host = document.getElementById('overlayHost');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3></h3>
        <p></p>
        <div class="actions">
          <button class="btn ghost sm" data-act="cancel">Cancel</button>
          <button class="btn ${danger ? 'danger primary' : 'primary'} sm" data-act="ok"></button>
        </div>
      </div>`;
    overlay.querySelector('h3').textContent = title;
    overlay.querySelector('p').textContent = body;
    overlay.querySelector('[data-act="ok"]').textContent = confirmText;
    host.appendChild(overlay);

    const close = (val) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
    const onKey = (e) => { if (e.key === 'Escape') close(false); };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
    overlay.querySelector('[data-act="ok"]').addEventListener('click', () => close(true));
  });
}

/* ---------------- nav / page icons ---------------- */
export const ICONS = {
  chat: '<path d="M3 5.5h14v8H9l-3 3v-3H3z"/>',
  settings: '<path d="M4 6h12M4 10h12M4 14h12"/><circle cx="8" cy="6" r="2"/><circle cx="13" cy="10" r="2"/><circle cx="7" cy="14" r="2"/>',
  history: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4l3 2"/>',
  prompt: '<path d="M4 6l3.5 3L4 12"/><path d="M10 13h6"/>',
  about: '<circle cx="10" cy="10" r="7"/><path d="M10 9v4.5"/><circle cx="10" cy="6.4" r=".5" fill="currentColor" stroke="none"/>'
};
export const navSvg = (k) => `<svg viewBox="0 0 20 20" aria-hidden="true">${ICONS[k]}</svg>`;

export { marked, hljs };
