/* Shared renderer utilities: store access, toasts, modals, markdown,
 * and small formatting helpers. Imported by every page. */
import { marked, hljs } from './vendor/libs.js';

const api = window.api;

export const DEFAULT_LOCALE = 'ru';
export const LANGUAGE_OPTIONS = [
  { id: 'ru', label: 'Русский' },
  { id: 'en', label: 'English' }
];

export const LOCALES = {
  en: {
    'Mistral Desktop': 'Mistral Desktop',
    Chat: 'Chat',
    Settings: 'Settings',
    History: 'History',
    About: 'About',
    Menu: 'Menu',
    'New chat': 'New chat',
    'No chats yet': 'No chats yet',
    Untitled: 'Untitled',
    'Something went wrong': 'Something went wrong',
    'Type a command…': 'Type a command…',
    'Search sessions…': 'Search sessions…',
    'No history yet': 'No history yet',
    'Conversations you have are saved here automatically.': 'Conversations you have are saved here automatically.',
    'No sessions match “%s”.': 'No sessions match “%s”.',
    Open: 'Open',
    Export: 'Export',
    Delete: 'Delete',
    'No matching commands': 'No matching commands',
    'No API key set — open Settings to connect to Mistral.': 'No API key set — open Settings to connect to Mistral.',
    msgs: 'msgs',
    'session(s) will be permanently removed.': 'session(s) will be permanently removed.',
    'Session deleted': 'Session deleted',
    'Sessions deleted': 'Sessions deleted',
    'Exported to %s': 'Exported to %s',
    'Export failed': 'Export failed',
    'Exported %s session(s)': 'Exported %s session(s)',
    'Start a conversation': 'Start a conversation',
    'Ask Mistral anything. Your messages stream back token-by-token, with markdown and syntax highlighting.': 'Ask Mistral anything. Your messages stream back token-by-token, with markdown and syntax highlighting.',
    'Message Mistral…  (Enter to send · Shift+Enter for newline)': 'Message Mistral…  (Enter to send · Shift+Enter for newline)',
    'Working folder': 'Working folder',
    'Choose a working folder': 'Choose a working folder',
    Todos: 'Todos',
    'No todos yet. The assistant will add them as it works.': 'No todos yet. The assistant will add them as it works.',
    working: 'working',
    'Stop ⎋': 'Stop ⎋',
    'Send ↵': 'Send ↵',
    API: 'API',
    'Connection & authentication': 'Connection & authentication',
    'API key': 'API key',
    'Encrypted in system keychain': 'Encrypted in system keychain',
    'Stored locally': 'Stored locally',
    'Paste your Mistral API key': 'Paste your Mistral API key',
    'Save key': 'Save key',
    Remove: 'Remove',
    'Endpoint URL': 'Endpoint URL',
    Connection: 'Connection',
    'Test connection': 'Test connection',
    'connected · %sms': 'connected · %sms',
    failed: 'failed',
    Model: 'Model',
    'Sampling & limits': 'Sampling & limits',
    Reasoning: 'Reasoning',
    'low = token-savvy · medium = balanced · high = detailed reasoning': 'low = token-savvy · medium = balanced · high = detailed reasoning',
    Temperature: 'Temperature',
    'Top-p': 'Top-p',
    'Max tokens': 'Max tokens',
    '0 = model default': '0 = model default',
    Output: 'Output',
    'How responses are produced & displayed': 'How responses are produced & displayed',
    'Stream responses': 'Stream responses',
    'Render tokens as they arrive': 'Render tokens as they arrive',
    'Render markdown': 'Render markdown',
    'Output format': 'Output format',
    markdown: 'markdown',
    text: 'text',
    Memory: 'Memory',
    Interface: 'Interface',
    Theme: 'Theme',
    System: 'System',
    Light: 'Light',
    Dark: 'Dark',
    Auto: 'Auto',
    'Collapse sidebar': 'Collapse sidebar',
    'Font size': 'Font size',
    'Keyboard reference': 'Keyboard reference',
    Shortcuts: 'Shortcuts',
    Skills: 'Skills',
    Plugins: 'Plugins',
    Language: 'Language',
    'App interface language': 'App interface language',
    'API key saved': 'API key saved',
    'API key removed': 'API key removed',
    'Enter an API key first': 'Enter an API key first',
    'Endpoint must be a valid URL': 'Endpoint must be a valid URL',
    'Preset saved': 'Preset saved',
    'Name the preset first': 'Name the preset first',
    'New preset': 'New preset',
    active: 'active',
    'Set active': 'Set active',
    'Active system prompt updated': 'Active system prompt updated',
    'Keep at least one preset': 'Keep at least one preset',
    'Delete preset?': 'Delete preset?',
    'will be removed.': 'will be removed.',
    'Discard changes?': 'Discard changes?',
    'You have unsaved edits to this preset.': 'You have unsaved edits to this preset.',
    Cancel: 'Cancel',
    'Continue without key': 'Continue without key',
    Save: 'Save',
    'Welcome to Mistral Desktop': 'Welcome to Mistral Desktop',
    'Choose your language and paste your API key to start.': 'Choose your language and paste your API key to start.'
  },
  ru: {
    'Mistral Desktop': 'Mistral Desktop',
    Chat: 'Чат',
    Settings: 'Настройки',
    History: 'История',
    About: 'О приложении',
    Menu: 'Меню',
    'New chat': 'Новый чат',
    'No chats yet': 'Пока нет чатов',
    Untitled: 'Без названия',
    'Something went wrong': 'Что-то пошло не так',
    'Type a command…': 'Введите команду…',
    'Search sessions…': 'Поиск по сессиям…',
    'No history yet': 'История пуста',
    'Conversations you have are saved here automatically.': 'Разговоры сохраняются здесь автоматически.',
    'No sessions match “%s”.': 'Нет сессий, соответствующих «%s».',
    Open: 'Открыть',
    Export: 'Экспорт',
    Delete: 'Удалить',
    'No matching commands': 'Команды не найдены',
    'No API key set — open Settings to connect to Mistral.': 'API ключ не установлен — откройте Настройки.',
    msgs: 'сообщ.',
    'session(s) will be permanently removed.': 'сессии будут удалены навсегда.',
    'Session deleted': 'Сессия удалена',
    'Sessions deleted': 'Сессии удалены',
    'Exported to %s': 'Экспортировано в %s',
    'Export failed': 'Не удалось экспортировать',
    'Exported %s session(s)': 'Экспортировано %s сессий',
    'Start a conversation': 'Начните разговор',
    'Ask Mistral anything. Your messages stream back token-by-token, with markdown and syntax highlighting.': 'Спросите Mistral о чём угодно. Сообщения отображаются по токенам с поддержкой Markdown и подсветкой.',
    'Message Mistral…  (Enter to send · Shift+Enter for newline)': 'Сообщение Mistral…  (Enter — отправить · Shift+Enter — новая строка)',
    'Working folder': 'Рабочая папка',
    'Choose a working folder': 'Выберите рабочую папку',
    Todos: 'Задачи',
    'No todos yet. The assistant will add them as it works.': 'Пока нет задач. Ассистент добавит их в процессе работы.',
    working: 'работает',
    'Stop ⎋': 'Остановить ⎋',
    'Send ↵': 'Отправить ↵',
    API: 'API',
    'Connection & authentication': 'Подключение и авторизация',
    'API key': 'API ключ',
    'Encrypted in system keychain': 'Зашифровано в системном хранилище',
    'Stored locally': 'Хранится локально',
    'Paste your Mistral API key': 'Вставьте ключ Mistral API',
    'Save key': 'Сохранить ключ',
    Remove: 'Удалить',
    'Endpoint URL': 'URL эндпоинта',
    Connection: 'Соединение',
    'Test connection': 'Проверить соединение',
    'connected · %sms': 'подключено · %sms',
    failed: 'ошибка',
    Model: 'Модель',
    'Sampling & limits': 'Сэмплинг и лимиты',
    Reasoning: 'Рассуждение',
    'low = token-savvy · medium = balanced · high = detailed reasoning': 'low = экономно · medium = сбалансировано · high = подробно',
    Temperature: 'Температура',
    'Top-p': 'Top-p',
    'Max tokens': 'Максимум токенов',
    '0 = model default': '0 = по умолчанию модели',
    Output: 'Вывод',
    'How responses are produced & displayed': 'Как формируются и отображаются ответы',
    'Stream responses': 'Потоковый вывод',
    'Render tokens as they arrive': 'Отображать токены по мере поступления',
    'Render markdown': 'Рендер Markdown',
    'Output format': 'Формат вывода',
    markdown: 'Markdown',
    plain: 'Простой текст',
    json: 'JSON',
    chars: 'симв.',
    'Memory saved': 'Память сохранена',
    'Memory cleared': 'Память очищена',
    'Save memory': 'Сохранить память',
    Clear: 'Очистить',
    Memory: 'Память',
    Interface: 'Интерфейс',
    Theme: 'Тема',
    System: 'Системный',
    Light: 'Светлая',
    Dark: 'Тёмная',
    Auto: 'Авто',
    'Collapse sidebar': 'Свернуть панель',
    'Font size': 'Размер шрифта',
    'Keyboard reference': 'Справочник клавиш',
    Shortcuts: 'Сочетания клавиш',
    Skills: 'Скиллы',
    Plugins: 'Плагины',
    Language: 'Язык',
    'App interface language': 'Язык интерфейса',
    'API key saved': 'API ключ сохранён',
    'API key removed': 'API ключ удалён',
    'Enter an API key first': 'Сначала введите API ключ',
    'Endpoint must be a valid URL': 'Эндпоинт должен быть действительным URL',
    'Preset saved': 'Пресет сохранён',
    'Name the preset first': 'Сначала дайте пресету имя',
    'New preset': 'Новый пресет',
    active: 'активно',
    'Set active': 'Сделать активным',
    'Active system prompt updated': 'Активный системный промпт обновлён',
    'Keep at least one preset': 'Оставьте хотя бы один пресет',
    'Delete preset?': 'Удалить пресет?',
    'will be removed.': 'будет удалён.',
    'Discard changes?': 'Отменить изменения?',
    'You have unsaved edits to this preset.': 'Есть несохранённые изменения в этом пресете.',
    Cancel: 'Отмена',
    'Continue without key': 'Продолжить без ключа',
    Save: 'Сохранить',
    'Welcome to Mistral Desktop': 'Добро пожаловать в Mistral Desktop',
    'Choose your language and paste your API key to start.': 'Выберите язык и вставьте API ключ, чтобы начать.'
  }
};

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

export function t(key, locale = DEFAULT_LOCALE) {
  const translation = LOCALES[locale]?.[key] ?? LOCALES[DEFAULT_LOCALE]?.[key];
  if (translation !== undefined) return translation;
  return key;
}

export async function getLocale() {
  const settings = await getSettings();
  return settings.locale || DEFAULT_LOCALE;
}

export function localeLabel(id) {
  return LANGUAGE_OPTIONS.find((item) => item.id === id)?.label || id;
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

  // Reasoning blocks (`<details><summary>…</summary>…`) get a normalized label.
  // While the model is still thinking the block streams in open — show an
  // animated, per-letter "Думает". Once it's closed, show "Думал N сек
  // (M токенов)" — the duration is baked into the tag as data-secs during
  // streaming, the token count is estimated from the body length. Runs on every
  // render path (live, committed, history).
  tmp.querySelectorAll('details').forEach((d) => {
    const summary = d.querySelector('summary');
    if (!summary) return;
    const bodyLen = Math.max(0, (d.textContent || '').length - (summary.textContent || '').length);
    const toks = Math.ceil(bodyLen / 4);
    const thinking = d.hasAttribute('open'); // open === still streaming in
    summary.classList.add('think');
    summary.innerHTML = '';
    if (thinking) {
      summary.classList.add('think-live');
      // Per-letter highlight wave so it reads as "loading".
      [...'Думает'].forEach((ch, idx) => {
        const s = document.createElement('span');
        s.className = 'think-ch';
        s.style.animationDelay = `${idx * 0.09}s`;
        s.textContent = ch;
        summary.appendChild(s);
      });
    } else {
      const secs = parseInt(d.getAttribute('data-secs') || '0', 10);
      let label = 'Думал';
      if (secs > 0) label += ` ${secs} сек`;
      if (toks > 0) label += ` (${toks.toLocaleString()} ток.)`;
      summary.textContent = label;
    }
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
export function confirmDialog({ title, body, confirmText = 'Confirm', cancelText = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const host = document.getElementById('overlayHost');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3></h3>
        <p></p>
        <div class="actions">
          <button class="btn ghost sm" data-act="cancel"></button>
          <button class="btn ${danger ? 'danger primary' : 'primary'} sm" data-act="ok"></button>
        </div>
      </div>`;
    overlay.querySelector('h3').textContent = title;
    overlay.querySelector('p').textContent = body;
    overlay.querySelector('[data-act="ok"]').textContent = confirmText;
    overlay.querySelector('[data-act="cancel"]').textContent = cancelText;
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
  about: '<circle cx="10" cy="10" r="7"/><path d="M10 9v4.5"/><circle cx="10" cy="6.4" r=".5" fill="currentColor" stroke="none"/>'
};
export const navSvg = (k) => `<svg viewBox="0 0 20 20" aria-hidden="true">${ICONS[k]}</svg>`;

export { marked, hljs };
