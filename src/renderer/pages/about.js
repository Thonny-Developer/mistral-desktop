/* About page — single centered column: app id, live API status ping,
 * current model + capabilities, keyboard reference, external links. */
import { getSettings, escapeHtml } from '../shared.js';
import { MODEL_INFO } from '../models.js';

const api = window.api;

const APP_VERSION = '1.4.1'; // fallback only — real version comes from api.app.version()

const SHORTCUTS = [
  ['New chat', 'Ctrl+N'],
  ['Command palette', 'Ctrl+K'],
  ['History', 'Ctrl+H'],
  ['Settings', 'Ctrl+,'],
  ['Focus input', 'Ctrl+/'],
  ['Send', 'Enter'],
  ['Stop', 'Escape']
];

const LINKS = [
  ['Docs ↗', 'https://docs.mistral.ai/'],
  ['GitHub ↗', 'https://github.com/Thonny-Developer'],
  ['Changelog ↗', 'https://docs.mistral.ai/getting-started/changelog/']
];

async function render(container) {
  const settings = await getSettings();
  const ru = (settings.locale || 'ru') === 'ru';
  const model = settings.model || 'mistral-large-latest';
  const info = MODEL_INFO[model] || { context: '32k context', caps: [] };
  const version = await getVersion();

  container.innerHTML = `
    <div class="about scroll">
      <div class="about-inner">
        <div class="about-id">
          <div>
            <div class="name">Mistral Desktop</div>
            <div class="ver mono">v${version} · electron</div>
          </div>
        </div>
        <hr class="hr" style="margin:24px 0" />

        <div class="about-block">
          <span class="lbl">API status</span>
          <div id="apiStatus"><span class="streaming"><span class="pulse"></span>checking…</span></div>
        </div>

        <div class="about-block">
          <span class="lbl">${ru ? 'Обновления' : 'Updates'}</span>
          <div class="row" style="gap:12px;align-items:center">
            <button class="btn ghost sm" id="checkUpdates">${ru ? 'Проверить обновления' : 'Check for updates'}</button>
            <span id="updateStatus" class="mono txt-d" style="font-size:11px"></span>
          </div>
        </div>

        <div class="about-block">
          <span class="lbl">Current model</span>
          <div class="box box-2" style="padding:14px 16px">
            <div class="txt-hi mono" style="font-size:13px;margin-bottom:10px">${escapeHtml(model)}</div>
            <div class="row" style="gap:8px;flex-wrap:wrap">
              <span class="chip">${info.context}</span>
              ${info.caps.map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join('')}
            </div>
          </div>
        </div>

        <div class="about-block">
          <span class="lbl">Shortcuts</span>
          ${SHORTCUTS.map(([l, k]) => `<div class="kbrow"><span>${l}</span><span class="k mono">${k}</span></div>`).join('')}
        </div>

        <div class="row" style="gap:10px">
          ${LINKS.map(([l, href]) => `<a class="btn ghost sm" href="${href}" target="_blank" rel="noreferrer">${l}</a>`).join('')}
        </div>
      </div>
    </div>`;

  // Live ping (best-effort).
  pingStatus(container, settings);
  wireUpdates(container, ru);
}

async function getVersion() {
  try { return (await api.app?.version?.()) || APP_VERSION; } catch { return APP_VERSION; }
}

/** Wire the "Check for updates" button to the main-process updater. */
function wireUpdates(container, ru) {
  const btn = container.querySelector('#checkUpdates');
  const status = container.querySelector('#updateStatus');
  if (!btn || !status || !api.updates) return;

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    status.textContent = ru ? 'Проверка…' : 'Checking…';
    try {
      status.textContent = updateMessage(await api.updates.check(), ru);
    } catch {
      status.textContent = ru ? 'Не удалось проверить' : 'Check failed';
    } finally {
      btn.disabled = false;
    }
  });
}

function updateMessage(res, ru) {
  switch (res && res.status) {
    case 'available': return ru ? `Доступна версия ${res.version} — начинаю загрузку` : `Version ${res.version} available — downloading`;
    case 'latest':    return ru ? `У вас последняя версия (v${res.version})` : `You're up to date (v${res.version})`;
    case 'dev':       return ru ? 'Доступно только в установленной версии' : 'Only available in the installed app';
    case 'error':     return ru ? 'Не удалось проверить обновления' : 'Could not check for updates';
    default:          return '';
  }
}

async function pingStatus(container, settings) {
  const el = container.querySelector('#apiStatus');
  const host = (() => { try { return new URL(settings.endpoint).host; } catch { return 'api.mistral.ai'; } })();
  const ru = (settings.locale || 'ru') === 'ru';
  const hasKey = await api.apiKey.has();
  if (!hasKey) {
    el.innerHTML = `<span class="streaming err"><span class="pulse"></span>${ru ? 'нет API-ключа · добавьте его в настройках' : 'no API key · add one in Settings'}</span>`;
    return;
  }
  try {
    const { latency } = await api.mistral.test();
    el.innerHTML = `<span class="streaming ok"><span class="pulse"></span>${ru ? 'в норме' : 'operational'}</span>
      <span class="mono txt-d" style="font-size:11px;margin-left:10px">· ${escapeHtml(host)} · ${latency}ms</span>`;
  } catch (e) {
    el.innerHTML = `<span class="streaming err"><span class="pulse"></span>${escapeHtml(friendlyError(e, ru))}</span>`;
  }
}

/** Map a raw API/IPC error into one short, human-readable line. */
function friendlyError(e, ru) {
  const raw = ((e && e.message) || '').toLowerCase();
  const hit = (...needles) => needles.some((n) => raw.includes(n));

  if (hit('fetch failed', 'network error', 'enotfound', 'econnrefused', 'getaddrinfo', 'dns', 'offline'))
    return ru ? 'Нет подключения к интернету' : 'No internet connection';
  if (hit('timeout', 'etimedout', 'timed out'))
    return ru ? 'Сервер не отвечает' : 'Server not responding';
  if (hit('401', 'unauthorized', 'invalid api key', 'invalid_api_key', 'authentication'))
    return ru ? 'Неверный API-ключ' : 'Invalid API key';
  if (hit('429', 'rate limit', 'too many'))
    return ru ? 'Слишком много запросов' : 'Too many requests';
  if (hit('500', '502', '503', '504', 'server error', 'bad gateway'))
    return ru ? 'Сервис временно недоступен' : 'Service temporarily unavailable';
  return ru ? 'Не удалось подключиться' : 'Could not connect';
}

export default { render };
