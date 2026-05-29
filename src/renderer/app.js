/* App shell: nav rail, router/page-manager, window controls,
 * global keyboard shortcuts, command palette, theme application. */
import { getSettings, saveSettings, navSvg, toast, store, formatRelative, escapeHtml } from './shared.js';

import chatPage from './pages/chat.js';
import settingsPage from './pages/settings.js';
import historyPage from './pages/history.js';
import systemPromptPage from './pages/system-prompt.js';
import aboutPage from './pages/about.js';

const api = window.api;

async function loadSessions() {
  return (await store.get('sessions')) || [];
}

async function drawNavSessions() {
  const container = els.nav.querySelector('#navSessions');
  if (!container) return;

  const sessions = await loadSessions();
  if (!sessions.length) {
    container.innerHTML = `<div class="nav-sessions-empty">No chats yet</div>`;
    return;
  }

  container.innerHTML = sessions.map((s) => `
      <button class="nav-ses" type="button" data-id="${s.id}" title="${escapeHtml(s.title || 'Untitled')}">
        <span class="nav-ses-title">${escapeHtml(s.title || 'Untitled')}</span>
        <span class="nav-ses-meta">${formatRelative(s.updatedAt)} · ${Math.max(0, s.messageCount || 0)} msgs</span>
      </button>`).join('');

  container.querySelectorAll('.nav-ses').forEach((btn) =>
    btn.addEventListener('click', () => navigate('chat', { openSession: btn.dataset.id })));
}

document.addEventListener('sessions-changed', () => drawNavSessions());

const PAGES = {
  chat: { mod: chatPage, label: 'Chat' },
  settings: { mod: settingsPage, label: 'Settings' },
  history: { mod: historyPage, label: 'History' },
  prompt: { mod: systemPromptPage, label: 'System Prompt' },
  about: { mod: aboutPage, label: 'About' }
};

const els = {
  body: document.getElementById('body'),
  nav: document.getElementById('nav'),
  content: document.getElementById('content'),
  winTitle: document.getElementById('winTitle')
};

let current = null;       // { name, instance }
let settings = null;      // cached settings

/* ---------------- routing ---------------- */
async function navigate(name, params = {}) {
  const page = PAGES[name];
  if (!page) return;

  // Let the outgoing page clean up listeners/timers.
  if (current?.instance?.destroy) {
    try { current.instance.destroy(); } catch { /* noop */ }
  }

  els.content.innerHTML = '';
  const mount = document.createElement('div');
  mount.className = 'page page-enter';
  els.content.appendChild(mount);
  // Restart the enter animation each navigation.
  void mount.offsetWidth;

  const ctx = { navigate, getSettings, refreshNav: renderNav, openPalette, toggleSidebar };
  current = { name, instance: page.mod };
  els.winTitle.textContent = page.label;
  setActiveNav(name);

  try {
    await page.mod.render(mount, { ...ctx, params });
  } catch (e) {
    console.error(e);
    mount.innerHTML = `<div class="empty"><div class="title">Something went wrong</div><div class="sub">${e.message}</div></div>`;
  }
}

/* Marks the active item inside the (popup) menu if it's open. */
function setActiveNav(name) {
  els.nav.querySelectorAll('.nav-menu-item').forEach((b) =>
    b.classList.toggle('active', b.dataset.page === name));
}

/* The pages reachable from the bottom "Mist Desktop" menu (chat is home). */
const MENU_ITEMS = [
  ['settings', 'Settings'],
  ['history', 'History'],
  ['prompt', 'System Prompt'],
  ['about', 'About']
];

/* ---------------- nav rail ---------------- */
function renderNav() {
  els.nav.innerHTML = `
    <div class="nav-head">
      <div class="nav-brand">
        <span class="name">✦ Mistral<span class="cli">Desktop</span></span>
      </div>
      <button class="btn primary nav-newchat" id="navNew"><span class="label">+ New Chat</span></button>
      <div class="nav-sessions" id="navSessions"></div>
    </div>
    <div class="spacer"></div>
    <div class="nav-foot">
      <button class="nav-menu-trigger" id="navMenu" title="Menu">
        <div class="meta">
          <div class="l1">Mistral Desktop</div>
          <div class="l2">menu</div>
        </div>
        <svg class="caret" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 10l4-4 4 4"/></svg>
      </button>
    </div>`;

  els.nav.querySelector('#navNew').addEventListener('click', () => startNewChat());
  els.nav.querySelector('#navMenu').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleNavMenu();
  });
  drawNavSessions();
}

/* ---------------- bottom "Mist Desktop" popup menu ---------------- */
function closeNavMenu() {
  els.nav.querySelector('.nav-menu-pop')?.remove();
  document.removeEventListener('click', onDocClickForMenu);
}
function onDocClickForMenu(e) {
  if (!e.target.closest('.nav-foot')) closeNavMenu();
}
function toggleNavMenu() {
  const existing = els.nav.querySelector('.nav-menu-pop');
  if (existing) { closeNavMenu(); return; }

  const pop = document.createElement('div');
  pop.className = 'nav-menu-pop';
  pop.innerHTML = MENU_ITEMS.map(([k, label]) =>
    `<button class="nav-menu-item ${current?.name === k ? 'active' : ''}" data-page="${k}">${navSvg(k)}<span>${label}</span></button>`
  ).join('');
  els.nav.querySelector('.nav-foot').appendChild(pop);

  pop.querySelectorAll('.nav-menu-item').forEach((b) =>
    b.addEventListener('click', () => { closeNavMenu(); navigate(b.dataset.page); }));

  // Close on outside click / Escape.
  setTimeout(() => document.addEventListener('click', onDocClickForMenu), 0);
}

function startNewChat() {
  navigate('chat', { newChat: true });
}

function toggleSidebar(force) {
  const collapsed = typeof force === 'boolean' ? force : !els.body.classList.contains('collapsed');
  els.body.classList.toggle('collapsed', collapsed);
}

/* ---------------- theme + window state ---------------- */
async function applyTheme() {
  settings = await getSettings();
  document.documentElement.dataset.theme = settings.theme || 'dark';
  document.documentElement.style.setProperty('--font-size', `${settings.fontSize || 14}px`);
  toggleSidebar(!!settings.collapseSidebar);
}

/* Re-apply theme when settings change elsewhere. */
window.addEventListener('settings-changed', applyTheme);

/* ---------------- window controls ---------------- */
function wireWindowControls() {
  document.getElementById('winMin').addEventListener('click', () => api.window.minimize());
  document.getElementById('winMax').addEventListener('click', () => api.window.maximizeToggle());
  document.getElementById('winClose').addEventListener('click', () => api.window.close());
}

/* ---------------- command palette (Ctrl+K) ---------------- */
const PALETTE_CMDS = [
  { label: '＋ New chat', key: 'Ctrl+N', run: () => startNewChat() },
  { label: '⎘ Open history', key: 'Ctrl+H', run: () => navigate('history') },
  { label: '✎ Edit system prompt', key: 'Ctrl+P', run: () => navigate('prompt') },
  { label: '⚙ Settings', key: 'Ctrl+,', run: () => navigate('settings') },
  { label: 'ⓘ About', key: '', run: () => navigate('about') }
];

let paletteEl = null;
function openPalette() {
  if (paletteEl) return;
  const host = document.getElementById('overlayHost');
  paletteEl = document.createElement('div');
  paletteEl.className = 'palette-overlay';
  paletteEl.innerHTML = `
    <div class="palette" role="dialog" aria-modal="true">
      <div class="palette-input">
        <span class="prompt">›</span>
        <input type="text" placeholder="Type a command…" autofocus />
      </div>
      <div class="palette-list"></div>
    </div>`;
  host.appendChild(paletteEl);

  const input = paletteEl.querySelector('input');
  const list = paletteEl.querySelector('.palette-list');
  let active = 0;
  let filtered = PALETTE_CMDS.slice();

  const draw = () => {
    list.innerHTML = filtered.map((c, i) =>
      `<div class="pcmd ${i === active ? 'active' : ''}" data-i="${i}">${c.label}<span class="key mono">${c.key}</span></div>`
    ).join('') || `<div class="pcmd">No matching commands</div>`;
    list.querySelectorAll('.pcmd[data-i]').forEach((el) => {
      el.addEventListener('click', () => choose(parseInt(el.dataset.i, 10)));
      el.addEventListener('mousemove', () => { active = parseInt(el.dataset.i, 10); paint(); });
    });
  };
  const paint = () => list.querySelectorAll('.pcmd[data-i]').forEach((el, i) =>
    el.classList.toggle('active', i === active));
  const choose = (i) => { const c = filtered[i]; closePalette(); c?.run(); };

  input.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    filtered = PALETTE_CMDS.filter((c) => c.label.toLowerCase().includes(q));
    active = 0; draw();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(filtered.length - 1, active + 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  });
  paletteEl.addEventListener('click', (e) => { if (e.target === paletteEl) closePalette(); });

  draw();
  setTimeout(() => input.focus(), 0);
}
function closePalette() {
  paletteEl?.remove();
  paletteEl = null;
}

/* ---------------- global keyboard shortcuts ---------------- */
function wireShortcuts() {
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;

    // Ctrl+K — command palette (toggles)
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); paletteEl ? closePalette() : openPalette(); return; }
    if (!mod) {
      // Escape — close transient overlays (chat page also stops generation)
      if (e.key === 'Escape') { if (paletteEl) closePalette(); closeNavMenu(); }
      return;
    }

    switch (e.key.toLowerCase()) {
      case 'n': e.preventDefault(); startNewChat(); break;
      case 'h': e.preventDefault(); navigate('history'); break;
      case 'p': e.preventDefault(); navigate('prompt'); break;
      case ',': e.preventDefault(); navigate('settings'); break;
      case '/':
        // Ctrl+/ — focus chat input (navigate to chat if needed)
        e.preventDefault();
        if (current?.name !== 'chat') navigate('chat').then(focusComposer);
        else focusComposer();
        break;
      default: break;
    }
  });
}

function focusComposer() {
  setTimeout(() => document.querySelector('.composer textarea')?.focus(), 80);
}

/* ---------------- boot ---------------- */
async function boot() {
  await applyTheme();
  renderNav();
  wireWindowControls();
  wireShortcuts();

  // Warn (once) if no API key is configured yet.
  const hasKey = await api.apiKey.has();
  if (!hasKey) {
    setTimeout(() => toast('No API key set — open Settings to connect to Mistral.', 'info', 6000), 600);
  }

  navigate('chat');
}

boot();
