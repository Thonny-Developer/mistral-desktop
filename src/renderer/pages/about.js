/* About page — single centered column: app id, live API status ping,
 * current model + capabilities, keyboard reference, external links. */
import { getSettings, escapeHtml } from '../shared.js';
import { MODEL_INFO } from '../models.js';

const api = window.api;

const APP_VERSION = '1.4.0';

const SHORTCUTS = [
  ['New chat', 'Ctrl+N'],
  ['Command palette', 'Ctrl+K'],
  ['History', 'Ctrl+H'],
  ['System prompt', 'Ctrl+P'],
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
  const model = settings.model || 'mistral-large-latest';
  const info = MODEL_INFO[model] || { context: '32k context', caps: [] };

  container.innerHTML = `
    <div class="about scroll">
      <div class="about-inner">
        <div class="about-id">
          <div>
            <div class="name">Mistral Desktop</div>
            <div class="ver mono">v${APP_VERSION} · electron</div>
          </div>
        </div>
        <hr class="hr" style="margin:24px 0" />

        <div class="about-block">
          <span class="lbl">API status</span>
          <div id="apiStatus"><span class="streaming"><span class="pulse"></span>checking…</span></div>
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
}

async function pingStatus(container, settings) {
  const el = container.querySelector('#apiStatus');
  const host = (() => { try { return new URL(settings.endpoint).host; } catch { return 'api.mistral.ai'; } })();
  const hasKey = await api.apiKey.has();
  if (!hasKey) {
    el.innerHTML = `<span class="streaming err"><span class="pulse"></span>no API key · add one in Settings</span>`;
    return;
  }
  try {
    const { latency } = await api.mistral.test();
    el.innerHTML = `<span class="streaming ok"><span class="pulse"></span>operational</span>
      <span class="mono txt-d" style="font-size:11px;margin-left:10px">· ${escapeHtml(host)} · ${latency}ms</span>`;
  } catch (e) {
    el.innerHTML = `<span class="streaming err"><span class="pulse"></span>${escapeHtml(e.message || 'unreachable')}</span>`;
  }
}

export default { render };
