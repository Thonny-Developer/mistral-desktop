/* Settings page — two-pane (section list + form pane).
 * Everything persists to electron-store and applies immediately. */
import { getSettings, saveSettings, toast, escapeHtml } from '../shared.js';
import { SUPPORTED_MODELS, MODEL_GROUPS, MODEL_INFO } from '../models.js';

const api = window.api;

const SECTIONS = [
  ['api', 'API'],
  ['model', 'Model'],
  ['output', 'Output'],
  ['memory', 'Memory'],
  ['interface', 'Interface'],
  ['shortcuts', 'Shortcuts']
];

const SHORTCUTS = [
  ['New chat', 'Ctrl+N'],
  ['Command palette', 'Ctrl+K'],
  ['History', 'Ctrl+H'],
  ['System prompt', 'Ctrl+P'],
  ['Settings', 'Ctrl+,'],
  ['Focus input', 'Ctrl+/'],
  ['Send message', 'Enter'],
  ['Stop generation', 'Escape']
];

let activeSection = 'api';

async function render(container) {
  const settings = await getSettings();

  container.innerHTML = `
    <div class="settings">
      <aside class="set-nav">
        <div class="set-nav-head"><span class="lbl">Settings</span></div>
        <div class="set-nav-items">
          ${SECTIONS.map(([k, label]) =>
            `<button class="setnav ${k === activeSection ? 'active' : ''}" data-sec="${k}">${label}</button>`).join('')}
        </div>
      </aside>
      <div class="set-pane scroll" id="setPane"></div>
    </div>`;

  const pane = container.querySelector('#setPane');
  container.querySelectorAll('.setnav').forEach((b) =>
    b.addEventListener('click', () => {
      activeSection = b.dataset.sec;
      container.querySelectorAll('.setnav').forEach((x) => x.classList.toggle('active', x === b));
      drawSection(pane, settings);
    }));

  drawSection(pane, settings);
}

function drawSection(pane, settings) {
  ({
    api: drawApi, model: drawModel, output: drawOutput, memory: drawMemory,
    interface: drawInterface, shortcuts: drawShortcuts
  }[activeSection])(pane, settings);
}

/* ---------------- API section ---------------- */
async function drawApi(pane, settings) {
  const hasKey = await api.apiKey.has();
  const encrypted = await api.apiKey.isEncrypted();

  pane.innerHTML = `
    <div class="set-section">
      <div class="set-h">API</div>
      <div class="set-sub">Connection &amp; authentication</div>

      <div class="setrow">
        <div class="setlbl">
          <div class="l1">API key</div>
          <div class="l2">${encrypted ? 'Encrypted in system keychain' : 'Stored locally'}</div>
        </div>
        <div class="setctl">
          <div style="display:flex;align-items:center;gap:8px">
            <input class="field-box" id="apiKey" style="flex:1" type="password"
                   placeholder="${hasKey ? '••••••••••••••••  (saved)' : 'Paste your Mistral API key'}" />
            <button class="icon-btn" id="revealKey" title="Show/hide">
              <svg viewBox="0 0 16 16"><path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z"/><circle cx="8" cy="8" r="1.8"/></svg>
            </button>
          </div>
          <div style="margin-top:10px;display:flex;gap:10px">
            <button class="btn primary sm" id="saveKey">Save key</button>
            ${hasKey ? '<button class="btn ghost sm danger" id="clearKey">Remove</button>' : ''}
          </div>
        </div>
      </div>

      <div class="setrow">
        <div class="setlbl"><div class="l1">Endpoint URL</div></div>
        <div class="setctl">
          <input class="field" id="endpoint" type="text" value="${escapeHtml(settings.endpoint)}" />
        </div>
      </div>

      <div class="setrow">
        <div class="setlbl"><div class="l1">Connection</div></div>
        <div class="setctl wide" style="display:flex;align-items:center;gap:14px">
          <button class="btn" id="testBtn">Test connection</button>
          <span id="testResult"></span>
        </div>
      </div>
    </div>`;

  const keyInput = pane.querySelector('#apiKey');
  pane.querySelector('#revealKey').addEventListener('click', () => {
    keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
  });
  pane.querySelector('#saveKey').addEventListener('click', async () => {
    const val = keyInput.value.trim();
    if (!val) { keyInput.classList.add('invalid'); toast('Enter an API key first', 'error'); return; }
    keyInput.classList.remove('invalid');
    await api.apiKey.set(val);
    keyInput.value = '';
    keyInput.type = 'password';
    toast('API key saved', 'success');
    drawApi(pane, settings);
  });
  pane.querySelector('#clearKey')?.addEventListener('click', async () => {
    await api.apiKey.set('');
    toast('API key removed', 'info');
    drawApi(pane, settings);
  });

  const endpoint = pane.querySelector('#endpoint');
  endpoint.addEventListener('change', async () => {
    const val = endpoint.value.trim();
    if (!/^https?:\/\//.test(val)) { endpoint.classList.add('invalid'); toast('Endpoint must be a valid URL', 'error'); return; }
    endpoint.classList.remove('invalid');
    await saveSettings({ endpoint: val });
    settings.endpoint = val;
  });

  pane.querySelector('#testBtn').addEventListener('click', async () => {
    const result = pane.querySelector('#testResult');
    result.innerHTML = `<span class="streaming"><span class="pulse"></span>testing…</span>`;
    try {
      const { latency } = await api.mistral.test();
      result.innerHTML = `<span class="streaming ok"><span class="pulse"></span>connected · ${latency}ms</span>`;
    } catch (e) {
      result.innerHTML = `<span class="streaming err"><span class="pulse"></span>${escapeHtml(e.message || 'failed')}</span>`;
    }
  });
}

/* ---------------- Model section ---------------- */
/** Build grouped <optgroup> markup; any model missing from a group is appended. */
function modelOptions(current) {
  const grouped = new Set(MODEL_GROUPS.flatMap(([, ids]) => ids));
  const opt = (m) => `<option value="${m}" ${m === current ? 'selected' : ''}>${m}</option>`;
  let html = MODEL_GROUPS
    .map(([label, ids]) => `<optgroup label="${label}">${ids.filter((m) => SUPPORTED_MODELS.includes(m)).map(opt).join('')}</optgroup>`)
    .join('');
  const ungrouped = SUPPORTED_MODELS.filter((m) => !grouped.has(m));
  if (ungrouped.length) html += `<optgroup label="Other">${ungrouped.map(opt).join('')}</optgroup>`;
  return html;
}

async function drawModel(pane, settings) {
  pane.innerHTML = `
    <div class="set-section">
      <div class="set-h">Model</div>
      <div class="set-sub">Sampling &amp; limits</div>

      <div class="setrow">
        <div class="setlbl"><div class="l1">Model</div><div class="l2" id="modelCtx">${escapeHtml((MODEL_INFO[settings.model] || {}).context || '')}</div></div>
        <div class="setctl" style="max-width:300px">
          <select class="field-box" id="model" style="width:100%">
            ${modelOptions(settings.model)}
          </select>
        </div>
      </div>

      <div class="setrow">
        <div class="setlbl"><div class="l1">Reasoning</div><div class="l2">low = token-savvy · medium = balanced · high = detailed reasoning</div></div>
        <div class="setctl" style="max-width:360px">
          <div class="seg-group" id="reasoningLevel">
            ${['low', 'medium', 'high'].map((v) =>
              `<button class="seg ${settings.reasoningLevel === v ? 'active' : ''}" data-v="${v}">${v}</button>`).join('')}
          </div>
        </div>
      </div>

      <div class="setrow" id="tempRow">
        <div class="setlbl"><div class="l1">Temperature</div><div class="l2">Randomness · 0–1.5</div></div>
        <div class="setctl" style="max-width:300px"></div>
      </div>

      <div class="setrow" id="toppRow">
        <div class="setlbl"><div class="l1">Top-p</div><div class="l2">Nucleus sampling · 0–1</div></div>
        <div class="setctl" style="max-width:300px"></div>
      </div>

      <div class="setrow">
        <div class="setlbl"><div class="l1">Max tokens</div><div class="l2">0 = model default</div></div>
        <div class="setctl" style="max-width:200px">
          <input class="field" id="maxTokens" type="number" min="0" step="64" value="${settings.maxTokens || 0}" />
        </div>
      </div>
    </div>`;

  pane.querySelector('#model').addEventListener('change', async (e) => {
    settings.model = e.target.value; // keep the in-memory copy in sync so the
    const ctx = pane.querySelector('#modelCtx'); // dropdown reflects the choice
    if (ctx) ctx.textContent = (MODEL_INFO[e.target.value] || {}).context || ''; // on re-render
    await saveSettings({ model: e.target.value });
    toast(`Model set to ${e.target.value}`, 'success', 1600);
  });
  bindSeg(pane.querySelector('#reasoningLevel'), async (v) => {
    settings.reasoningLevel = v;
    await saveSettings({ reasoningLevel: v });
    toast('Reasoning quality updated', 'success', 1600);
  });
  pane.querySelector('#maxTokens').addEventListener('change', async (e) => {
    const n = Math.max(0, parseInt(e.target.value, 10) || 0);
    e.target.value = n;
    settings.maxTokens = n;
    await saveSettings({ maxTokens: n });
  });

  mountSlider(pane.querySelector('#tempRow .setctl'), settings.temperature, 0, 1.5, 0.01,
    (v) => { settings.temperature = v; return saveSettings({ temperature: v }); }, (v) => v.toFixed(2));
  mountSlider(pane.querySelector('#toppRow .setctl'), settings.topP, 0, 1, 0.01,
    (v) => { settings.topP = v; return saveSettings({ topP: v }); }, (v) => v.toFixed(2));
}

/* ---------------- Output section ---------------- */
async function drawOutput(pane, settings) {
  pane.innerHTML = `
    <div class="set-section">
      <div class="set-h">Output</div>
      <div class="set-sub">How responses are produced &amp; displayed</div>

      <div class="setrow">
        <div class="setlbl"><div class="l1">Stream responses</div><div class="l2">Render tokens as they arrive</div></div>
        <div class="toggle ${settings.stream ? 'on' : ''}" id="tgStream"></div>
      </div>
      <div class="setrow">
        <div class="setlbl"><div class="l1">Render markdown</div></div>
        <div class="toggle ${settings.renderMarkdown ? 'on' : ''}" id="tgMd"></div>
      </div>
      <div class="setrow">
        <div class="setlbl"><div class="l1">Output format</div></div>
        <div class="seg-group" id="fmt">
          ${['markdown', 'plain', 'json'].map((f) =>
            `<button class="seg ${settings.outputFormat === f ? 'active' : ''}" data-v="${f}">${f}</button>`).join('')}
        </div>
      </div>
    </div>`;

  bindToggle(pane.querySelector('#tgStream'), settings.stream, (v) => saveSettings({ stream: v }));
  bindToggle(pane.querySelector('#tgMd'), settings.renderMarkdown, (v) => saveSettings({ renderMarkdown: v }));
  bindSeg(pane.querySelector('#fmt'), (v) => saveSettings({ outputFormat: v }));
}

/* ---------------- Memory section ---------------- */
async function drawMemory(pane) {
  const content = await api.memory.get();
  const filePath = await api.memory.path();

  pane.innerHTML = `
    <div class="set-section">
      <div class="set-h">Memory</div>
      <div class="set-sub">Durable facts the assistant remembers across chats. It appends here automatically; edit freely.</div>

      <textarea class="field-box" id="memArea"
        style="width:100%;min-height:300px;resize:vertical;line-height:1.7;white-space:pre"></textarea>

      <div style="display:flex;align-items:center;gap:12px;margin-top:14px">
        <button class="btn primary sm" id="memSave">Save memory</button>
        <button class="btn ghost sm danger" id="memClear">Clear</button>
        <span class="spacer"></span>
        <span class="meta mono" id="memMeta" style="font-size:11px;color:var(--ink-3)"></span>
      </div>
      <div class="meta mono" style="font-size:10.5px;color:var(--ink-4);margin-top:10px">${escapeHtml(filePath)}</div>
    </div>`;

  const area = pane.querySelector('#memArea');
  const meta = pane.querySelector('#memMeta');
  area.value = content || '';

  const updateMeta = () => { meta.textContent = `${area.value.length.toLocaleString()} chars`; };
  area.addEventListener('input', updateMeta);
  updateMeta();

  pane.querySelector('#memSave').addEventListener('click', async () => {
    await api.memory.set(area.value);
    toast('Memory saved', 'success', 1600);
  });
  pane.querySelector('#memClear').addEventListener('click', async () => {
    area.value = '';
    updateMeta();
    await api.memory.set('');
    toast('Memory cleared', 'info', 1600);
  });
}

/* ---------------- Interface section ---------------- */
async function drawInterface(pane, settings) {
  pane.innerHTML = `
    <div class="set-section">
      <div class="set-h">Interface</div>
      <div class="set-sub">Appearance &amp; layout</div>

      <div class="setrow">
        <div class="setlbl"><div class="l1">Theme</div><div class="l2">Applies immediately</div></div>
        <div class="seg-group" id="theme">
          ${[['dark', 'Dark'], ['oled', 'OLED'], ['dim', 'Dim']].map(([v, l]) =>
            `<button class="seg ${settings.theme === v ? 'active' : ''}" data-v="${v}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="setrow" id="fsRow">
        <div class="setlbl"><div class="l1">Font size</div></div>
        <div class="setctl" style="max-width:260px"></div>
      </div>
      <div class="setrow">
        <div class="setlbl"><div class="l1">Collapse sidebar by default</div></div>
        <div class="toggle ${settings.collapseSidebar ? 'on' : ''}" id="tgCollapse"></div>
      </div>
    </div>`;

  bindSeg(pane.querySelector('#theme'), async (v) => {
    await saveSettings({ theme: v });
    window.dispatchEvent(new Event('settings-changed'));
  });
  bindToggle(pane.querySelector('#tgCollapse'), settings.collapseSidebar, async (v) => {
    await saveSettings({ collapseSidebar: v });
    window.dispatchEvent(new Event('settings-changed'));
  });
  mountSlider(pane.querySelector('#fsRow .setctl'), settings.fontSize, 12, 18, 1,
    async (v) => { await saveSettings({ fontSize: v }); window.dispatchEvent(new Event('settings-changed')); },
    (v) => `${Math.round(v)}px`);
}

/* ---------------- Shortcuts section ---------------- */
function drawShortcuts(pane) {
  pane.innerHTML = `
    <div class="set-section">
      <div class="set-h">Shortcuts</div>
      <div class="set-sub">Keyboard reference</div>
      ${SHORTCUTS.map(([label, key]) =>
        `<div class="kbrow"><span>${label}</span><span class="k mono">${key}</span></div>`).join('')}
    </div>`;
}

/* ---------------- control helpers ---------------- */
function bindToggle(el, initial, onChange) {
  let on = !!initial;
  el.classList.toggle('on', on);
  el.addEventListener('click', () => { on = !on; el.classList.toggle('on', on); onChange(on); });
}

function bindSeg(group, onChange) {
  group.querySelectorAll('.seg').forEach((seg) =>
    seg.addEventListener('click', () => {
      group.querySelectorAll('.seg').forEach((s) => s.classList.toggle('active', s === seg));
      onChange(seg.dataset.v);
    }));
}

/** Build a custom drag slider into `host`. */
function mountSlider(host, value, min, max, step, onChange, fmt) {
  host.innerHTML = `
    <div class="slider-wrap">
      <div class="slider"><div class="fill"></div><div class="knob"></div></div>
      <span class="slider-val mono"></span>
    </div>`;
  const track = host.querySelector('.slider');
  const fill = host.querySelector('.fill');
  const knob = host.querySelector('.knob');
  const valEl = host.querySelector('.slider-val');
  let val = clamp(value, min, max);

  const paint = () => {
    const pct = ((val - min) / (max - min)) * 100;
    fill.style.width = pct + '%';
    knob.style.left = pct + '%';
    valEl.textContent = fmt(val);
  };
  const setFromX = (clientX) => {
    const r = track.getBoundingClientRect();
    let pct = (clientX - r.left) / r.width;
    pct = Math.min(1, Math.max(0, pct));
    let raw = min + pct * (max - min);
    raw = Math.round(raw / step) * step;
    val = clamp(parseFloat(raw.toFixed(4)), min, max);
    paint();
  };

  let dragging = false;
  const onMove = (e) => { if (dragging) setFromX(e.clientX); };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    track.classList.remove('dragging');
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    onChange(val);
  };
  track.addEventListener('pointerdown', (e) => {
    dragging = true;
    track.classList.add('dragging');
    setFromX(e.clientX);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });

  paint();
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, Number.isFinite(+v) ? +v : min));

export default { render };
