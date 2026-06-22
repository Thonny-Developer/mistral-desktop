/* App shell: nav rail, router/page-manager, window controls,
 * global keyboard shortcuts, command palette, theme application. */
import { getSettings, saveSettings, navSvg, toast, store, formatRelative, escapeHtml, t, getLocale, localeLabel, LANGUAGE_OPTIONS } from './shared.js';

import chatPage from './pages/chat.js';
import settingsPage from './pages/settings.js';
import historyPage from './pages/history.js';
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
    container.innerHTML = `<div class="nav-sessions-empty">${t('No chats yet', locale)}</div>`;
    return;
  }

  container.innerHTML = sessions.map((s) => `
      <button class="nav-ses" type="button" data-id="${s.id}" title="${escapeHtml(s.title || t('Untitled', locale))}">
        <span class="nav-ses-title">${escapeHtml(s.title || t('Untitled', locale))}</span>
        <span class="nav-ses-meta">${formatRelative(s.updatedAt)} · ${Math.max(0, s.messageCount || 0)} ${t('msgs', locale)}</span>
      </button>`).join('');

  container.querySelectorAll('.nav-ses').forEach((btn) =>
    btn.addEventListener('click', () => navigate('chat', { openSession: btn.dataset.id })));
}

document.addEventListener('sessions-changed', () => drawNavSessions());

const PAGES = {
  chat: { mod: chatPage, labelKey: 'Chat' },
  settings: { mod: settingsPage, labelKey: 'Settings' },
  history: { mod: historyPage, labelKey: 'History' },
  about: { mod: aboutPage, labelKey: 'About' }
};

const els = {
  body: document.getElementById('body'),
  nav: document.getElementById('nav'),
  content: document.getElementById('content'),
  winTitle: document.getElementById('winTitle'),
  back: document.getElementById('tbBack')
};

let current = null;       // { name, instance }
let settings = null;      // cached settings
let locale = 'ru';

async function refreshLocale() {
  locale = await getLocale();
  return locale;
}

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
  els.winTitle.textContent = t(page.labelKey, locale);
  // The nav rail only belongs on the home (chat) page. On the standalone
  // pages (Settings/History/About) hide it and surface a titlebar "back"
  // button so the user can return to the chat.
  const standalone = name !== 'chat';
  els.body.classList.toggle('no-nav', standalone);
  els.back.hidden = !standalone;
  els.back.querySelector('.lbl').textContent = t('Chat', locale);
  setActiveNav(name);

  try {
    await page.mod.render(mount, { ...ctx, params });
  } catch (e) {
    console.error(e);
    mount.innerHTML = `<div class="empty"><div class="title">${t('Something went wrong', locale)}</div><div class="sub">${e.message}</div></div>`;
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
  ['about', 'About']
];

/* ---------------- nav rail ---------------- */
function renderNav() {
  els.nav.innerHTML = `
    <div class="nav-head">
      <div class="nav-brand">
        <span class="name">✦ ${t('Mistral Desktop', locale)}</span>
      </div>
      <button class="btn primary nav-newchat" id="navNew"><span class="label">+ ${t('New chat', locale)}</span></button>
      <div class="nav-sessions" id="navSessions"></div>
    </div>
    <div class="spacer"></div>
    <div class="nav-foot">
      <button class="nav-menu-trigger" id="navMenu" title="${t('Menu', locale)}">
        <div class="meta">
          <div class="l1">${t('Mistral Desktop', locale)}</div>
          <div class="l2">${t('Menu', locale).toLowerCase()}</div>
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
  pop.innerHTML = MENU_ITEMS.map(([k, labelKey]) =>
    `<button class="nav-menu-item ${current?.name === k ? 'active' : ''}" data-page="${k}">${navSvg(k)}<span>${t(labelKey, locale)}</span></button>`
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

async function showFirstRunDialog() {
  const firstRunDone = await store.get('firstRunCompleted');
  if (firstRunDone) return;

  const settings = await getSettings();
  let selectedLang = settings.locale || locale;
  const host = document.getElementById('overlayHost');
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <h3>${t('Welcome to Mistral Desktop', selectedLang)}</h3>
      <p>${t('Choose your language and paste your API key to start.', selectedLang)}</p>
      <div class="setrow">
        <div class="setlbl"><div class="l1">${t('Language', selectedLang)}</div></div>
        <div class="setctl" style="display:flex;gap:10px;flex-wrap:wrap">
          ${LANGUAGE_OPTIONS.map((opt) => `
            <button class="btn ${opt.id === selectedLang ? 'primary' : 'ghost'} sm lang-btn" data-lang="${opt.id}">${escapeHtml(opt.label)}</button>
          `).join('')}
        </div>
      </div>
      <div class="setrow" style="margin-top:16px">
        <div class="setlbl"><div class="l1">${t('API key', selectedLang)}</div></div>
        <div class="setctl"><input class="field-box" id="firstRunKey" type="password" placeholder="${t('Paste your Mistral API key', selectedLang)}" style="width:100%" /></div>
      </div>
      <div class="actions" style="justify-content:flex-end;margin-top:18px">
        <button class="btn ghost sm" id="skipFirstRun">${t('Continue without key', selectedLang)}</button>
        <button class="btn primary sm" id="saveFirstRun">${t('Save', selectedLang)}</button>
      </div>
    </div>`;
  host.appendChild(overlay);

  const setActiveLanguage = (lang) => {
    selectedLang = lang;
    overlay.querySelectorAll('.lang-btn').forEach((btn) => {
      btn.classList.toggle('primary', btn.dataset.lang === lang);
      btn.classList.toggle('ghost', btn.dataset.lang !== lang);
    });
    overlay.querySelector('h3').textContent = t('Welcome to Mistral Desktop', selectedLang);
    overlay.querySelector('p').textContent = t('Choose your language and paste your API key to start.', selectedLang);
    overlay.querySelector('#saveFirstRun').textContent = t('Save', selectedLang);
    overlay.querySelector('#skipFirstRun').textContent = t('Continue without key', selectedLang);
  };

  overlay.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.addEventListener('click', () => setActiveLanguage(btn.dataset.lang));
  });

  const close = async () => {
    overlay.remove();
    await store.set('firstRunCompleted', true);
    await saveSettings({ locale: selectedLang });
    locale = selectedLang;
    renderNav();
  };

  overlay.querySelector('#saveFirstRun').addEventListener('click', async () => {
    const keyInput = overlay.querySelector('#firstRunKey');
    const key = keyInput.value.trim();
    if (key) {
      await api.apiKey.set(key);
      toast(t('API key saved', selectedLang), 'success');
    } else {
      toast(t('Continue without key', selectedLang), 'info', 3000);
    }
    await close();
  });

  overlay.querySelector('#skipFirstRun').addEventListener('click', async () => {
    toast(t('Continue without key', selectedLang), 'info', 3000);
    await close();
  });
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
  els.back.addEventListener('click', () => navigate('chat'));
}

/* ---------------- command palette (Ctrl+K) ---------------- */
function paletteCommands() {
  return [
    { label: `＋ ${t('New chat', locale)}`, key: 'Ctrl+N', run: () => startNewChat() },
    { label: `⎘ ${t('Open', locale)} ${t('History', locale)}`, key: 'Ctrl+H', run: () => navigate('history') },
    { label: `⚙ ${t('Settings', locale)}`, key: 'Ctrl+,', run: () => navigate('settings') },
    { label: `ⓘ ${t('About', locale)}`, key: '', run: () => navigate('about') }
  ];
}

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
        <input type="text" placeholder="${t('Type a command…', locale)}" autofocus />
      </div>
      <div class="palette-list"></div>
    </div>`;
  host.appendChild(paletteEl);

  const input = paletteEl.querySelector('input');
  const list = paletteEl.querySelector('.palette-list');
  let active = 0;
  let filtered = paletteCommands().slice();

  const draw = () => {
    list.innerHTML = filtered.map((c, i) =>
      `<div class="pcmd ${i === active ? 'active' : ''}" data-i="${i}">${c.label}<span class="key mono">${c.key}</span></div>`
    ).join('') || `<div class="pcmd">${t('No matching commands', locale)}</div>`;
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
    filtered = paletteCommands().filter((c) => c.label.toLowerCase().includes(q));
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
  await refreshLocale();
  await applyTheme();
  renderNav();
  wireWindowControls();
  wireShortcuts();

  await showFirstRunDialog();

  // Warn (once) if no API key is configured yet — but not for LM Studio, which
  // runs locally without one.
  const bootSettings = await getSettings();
  const hasKey = await api.apiKey.has();
  if (!hasKey && (bootSettings.provider || 'mistral') !== 'lmstudio') {
    setTimeout(() => toast(t('No API key set — open Settings to connect to Mistral.', locale), 'info', 6000), 600);
  }

  navigate('chat');
}

boot();
