/* Settings page — two-pane (section list + form pane).
 * Everything persists to electron-store and applies immediately. */
import { getSettings, saveSettings, toast, escapeHtml, t, LANGUAGE_OPTIONS } from '../shared.js';
import { SUPPORTED_MODELS, MODEL_GROUPS, MODEL_INFO } from '../models.js';

const api = window.api;

const SECTIONS = [
  ['api', 'API'],
  ['model', 'Model'],
  ['output', 'Output'],
  ['memory', 'Memory'],
  ['skills', 'Skills'],
  ['interface', 'Interface'],
  ['shortcuts', 'Shortcuts']
];

const SHORTCUTS = [
  ['New chat', 'Ctrl+N'],
  ['Command palette', 'Ctrl+K'],
  ['History', 'Ctrl+H'],
  ['Settings', 'Ctrl+,'],
  ['Focus input', 'Ctrl+/'],
  ['Send message', 'Enter'],
  ['Stop generation', 'Escape']
];

let activeSection = 'api';

async function render(container) {
  const settings = await getSettings();
  const locale = settings.locale || 'ru';

  container.innerHTML = `
    <div class="settings">
      <aside class="set-nav">
        <div class="set-nav-head"><span class="lbl">${t('Settings', locale)}</span></div>
        <div class="set-nav-items">
          ${SECTIONS.map(([k, label]) =>
            `<button class="setnav ${k === activeSection ? 'active' : ''}" data-sec="${k}">${t(label, locale)}</button>`).join('')}
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
    skills: drawSkills, interface: drawInterface, shortcuts: drawShortcuts
  }[activeSection])(pane, settings);
}

/* ---------------- API section ---------------- */
async function drawApi(pane, settings) {
  const locale = settings.locale || 'ru';
  const hasKey = await api.apiKey.has();
  const encrypted = await api.apiKey.isEncrypted();

  pane.innerHTML = `
    <div class="set-section">
      <div class="set-h">${t('API', locale)}</div>
      <div class="set-sub">${t('Connection & authentication', locale)}</div>

      <div class="setrow">
        <div class="setlbl">
          <div class="l1">${t('API key', locale)}</div>
          <div class="l2">${encrypted ? t('Encrypted in system keychain', locale) : t('Stored locally', locale)}</div>
        </div>
        <div class="setctl">
          <div style="display:flex;align-items:center;gap:8px">
            <input class="field-box" id="apiKey" style="flex:1" type="password"
                   placeholder="${hasKey ? '••••••••••••••••  (saved)' : t('Paste your Mistral API key', locale)}" />
            <button class="icon-btn" id="revealKey" title="${t('Show/hide', locale)}">
              <svg viewBox="0 0 16 16"><path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z"/><circle cx="8" cy="8" r="1.8"/></svg>
            </button>
          </div>
          <div style="margin-top:10px;display:flex;gap:10px">
            <button class="btn primary sm" id="saveKey">${t('Save key', locale)}</button>
            ${hasKey ? `<button class="btn ghost sm danger" id="clearKey">${t('Remove', locale)}</button>` : ''}
          </div>
        </div>
      </div>

      <div class="setrow">
        <div class="setlbl"><div class="l1">${t('Endpoint URL', locale)}</div></div>
        <div class="setctl">
          <input class="field" id="endpoint" type="text" value="${escapeHtml(settings.endpoint)}" />
        </div>
      </div>

      <div class="setrow">
        <div class="setlbl"><div class="l1">${t('Connection', locale)}</div></div>
        <div class="setctl wide" style="display:flex;align-items:center;gap:14px">
          <button class="btn" id="testBtn">${t('Test connection', locale)}</button>
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
    toast(t('API key saved', locale), 'success');
    drawApi(pane, settings);
  });
  pane.querySelector('#clearKey')?.addEventListener('click', async () => {
    await api.apiKey.set('');
    toast(t('API key removed', locale), 'info');
    drawApi(pane, settings);
  });

  const endpoint = pane.querySelector('#endpoint');
  endpoint.addEventListener('change', async () => {
    const val = endpoint.value.trim();
    if (!/^https?:\/\//.test(val)) { endpoint.classList.add('invalid'); toast(t('Endpoint must be a valid URL', locale), 'error'); return; }
    endpoint.classList.remove('invalid');
    await saveSettings({ endpoint: val });
    settings.endpoint = val;
  });

  pane.querySelector('#testBtn').addEventListener('click', async () => {
    const result = pane.querySelector('#testResult');
    result.innerHTML = `<span class="streaming"><span class="pulse"></span>${t('testing…', locale)}</span>`;
    try {
      const { latency } = await api.mistral.test();
      result.innerHTML = `<span class="streaming ok"><span class="pulse"></span>${t('connected · %sms', locale).replace('%s', latency)}</span>`;
    } catch (e) {
      result.innerHTML = `<span class="streaming err"><span class="pulse"></span>${escapeHtml(e.message || t('failed', locale))}</span>`;
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
  const locale = settings.locale || 'ru';
  pane.innerHTML = `
    <div class="set-section">
      <div class="set-h">${t('Model', locale)}</div>
      <div class="set-sub">${t('Sampling & limits', locale)}</div>

      <div class="setrow">
        <div class="setlbl"><div class="l1">${t('Model', locale)}</div><div class="l2" id="modelCtx">${escapeHtml((MODEL_INFO[settings.model] || {}).context || '')}</div></div>
        <div class="setctl" style="max-width:300px">
          <select class="field-box" id="model" style="width:100%">
            ${modelOptions(settings.model)}
          </select>
        </div>
      </div>

      <div class="setrow">
        <div class="setlbl"><div class="l1">${t('Reasoning', locale)}</div><div class="l2">${t('low = token-savvy · medium = balanced · high = detailed reasoning', locale)}</div></div>
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
  const locale = settings.locale || 'ru';
  pane.innerHTML = `
    <div class="set-section">
      <div class="set-h">${t('Output', locale)}</div>
      <div class="set-sub">${t('How responses are produced & displayed', locale)}</div>

      <div class="setrow">
        <div class="setlbl"><div class="l1">${t('Stream responses', locale)}</div><div class="l2">${t('Render tokens as they arrive', locale)}</div></div>
        <div class="toggle ${settings.stream ? 'on' : ''}" id="tgStream"></div>
      </div>
      <div class="setrow">
        <div class="setlbl"><div class="l1">${t('Render markdown', locale)}</div></div>
        <div class="toggle ${settings.renderMarkdown ? 'on' : ''}" id="tgMd"></div>
      </div>
      <div class="setrow">
        <div class="setlbl"><div class="l1">${t('Output format', locale)}</div></div>
        <div class="seg-group" id="fmt">
          ${['markdown', 'plain', 'json'].map((f) =>
            `<button class="seg ${settings.outputFormat === f ? 'active' : ''}" data-v="${f}">${t(f, locale)}</button>`).join('')}
        </div>
      </div>
    </div>`;

  bindToggle(pane.querySelector('#tgStream'), settings.stream, (v) => saveSettings({ stream: v }));
  bindToggle(pane.querySelector('#tgMd'), settings.renderMarkdown, (v) => saveSettings({ renderMarkdown: v }));
  bindSeg(pane.querySelector('#fmt'), (v) => saveSettings({ outputFormat: v }));
}

/* ---------------- Memory section ---------------- */
async function drawMemory(pane, settings) {
  const locale = settings.locale || 'ru';
  const content = await api.memory.get();
  const filePath = await api.memory.path();

  pane.innerHTML = `
    <div class="set-section">
      <div class="set-h">${t('Memory', locale)}</div>
      <div class="set-sub">${t('Durable facts the assistant remembers across chats. It appends here automatically; edit freely.', locale)}</div>

      <textarea class="field-box" id="memArea"
        style="width:100%;min-height:300px;resize:vertical;line-height:1.7;white-space:pre"></textarea>

      <div style="display:flex;align-items:center;gap:12px;margin-top:14px">
        <button class="btn primary sm" id="memSave">${t('Save memory', locale)}</button>
        <button class="btn ghost sm danger" id="memClear">${t('Clear', locale)}</button>
        <span class="spacer"></span>
        <span class="meta mono" id="memMeta" style="font-size:11px;color:var(--ink-3)"></span>
      </div>
      <div class="meta mono" style="font-size:10.5px;color:var(--ink-4);margin-top:10px">${escapeHtml(filePath)}</div>
    </div>`;

  const area = pane.querySelector('#memArea');
  const meta = pane.querySelector('#memMeta');
  area.value = content || '';

  const updateMeta = () => { meta.textContent = `${area.value.length.toLocaleString()} ${t('chars', locale)}`; };
  area.addEventListener('input', updateMeta);
  updateMeta();

  pane.querySelector('#memSave').addEventListener('click', async () => {
    await api.memory.set(area.value);
    toast(t('Memory saved', locale), 'success', 1600);
  });
  pane.querySelector('#memClear').addEventListener('click', async () => {
    area.value = '';
    updateMeta();
    await api.memory.set('');
    toast(t('Memory cleared', locale), 'info', 1600);
  });
}

/* ---------------- Skills section ---------------- */
const SKILL_SOURCE_LABEL = { bundled: 'встроенный', user: 'пользовательский', project: 'проект' };

async function drawSkills(pane, settings) {
  const locale = settings.locale || 'ru';
  let items = [];
  try { items = await api.skills.list(); } catch { items = []; }
  const dir = await api.skills.dir();

  const rows = items.length
    ? items.map((s) => `
      <div class="setrow">
        <div class="setlbl">
          <div class="l1">/${escapeHtml(s.name)}
            <span class="meta mono" style="font-size:10.5px;color:var(--ink-4);margin-left:6px">${SKILL_SOURCE_LABEL[s.source] || s.source}</span>
          </div>
          <div class="l2">${escapeHtml(s.description || '')}${s.argumentHint ? ` · ${escapeHtml(s.argumentHint)}` : ''}</div>
        </div>
        <div class="setctl" style="display:flex;align-items:center;gap:10px;justify-content:flex-end">
          ${s.allowedTools && s.allowedTools.length
            ? `<span class="meta mono" style="font-size:10.5px;color:var(--ink-3)">${escapeHtml(s.allowedTools.join(', '))}</span>`
            : '<span class="meta mono" style="font-size:10.5px;color:var(--ink-4)">все инструменты</span>'}
          ${s.source === 'user' ? `<button class="btn ghost sm danger skill-del" data-name="${escapeHtml(s.name)}">Удалить</button>` : ''}
        </div>
      </div>`).join('')
    : '<div class="set-sub">Пока нет скиллов. Создайте ниже или положите .md в пользовательскую папку.</div>';

  pane.innerHTML = `
    <div class="set-section">
      <div class="set-h">${t('Skills', locale)}</div>
      <div class="set-sub">Переиспользуемые Markdown-плейбуки. Вызывайте их как /команду в чате; ассистент тоже может применять их сам.</div>
      ${rows}
      <div style="display:flex;gap:10px;margin-top:16px">
        <button class="btn ghost sm" id="skillsOpen">Открыть папку скиллов</button>
        <button class="btn ghost sm" id="skillsRefresh">Обновить</button>
      </div>
      <div class="meta mono" style="font-size:10.5px;color:var(--ink-4);margin-top:10px">${escapeHtml(dir)}</div>

      <div class="set-h" style="margin-top:26px">Новый скилл</div>
      <div class="set-sub">Опишите шаги — или попросите ассистента в чате: <span class="mono">/skill-creator …</span></div>

      <div class="setrow">
        <div class="setlbl"><div class="l1">Имя</div><div class="l2">kebab-case, без слеша</div></div>
        <div class="setctl"><input class="field-box" id="skName" placeholder="my-skill" style="width:100%" /></div>
      </div>
      <div class="setrow">
        <div class="setlbl"><div class="l1">Описание</div></div>
        <div class="setctl"><input class="field-box" id="skDesc" placeholder="Что делает скилл" style="width:100%" /></div>
      </div>
      <div class="setrow">
        <div class="setlbl"><div class="l1">Подсказка аргументов</div><div class="l2">необязательно</div></div>
        <div class="setctl"><input class="field-box" id="skHint" placeholder="[путь или фокус]" style="width:100%" /></div>
      </div>
      <div class="setrow">
        <div class="setlbl"><div class="l1">Разрешённые инструменты</div><div class="l2">через запятую · пусто = все</div></div>
        <div class="setctl"><input class="field-box" id="skTools" placeholder="read_file, list_files, edit_file" style="width:100%" /></div>
      </div>
      <textarea class="field-box" id="skBody" placeholder="Инструкции ассистенту. Используйте $ARGUMENTS там, где подставляется ввод пользователя."
        style="width:100%;min-height:180px;resize:vertical;line-height:1.6;margin-top:6px"></textarea>
      <div style="display:flex;gap:10px;margin-top:12px">
        <button class="btn primary sm" id="skSave">Создать скилл</button>
      </div>
    </div>`;

  pane.querySelector('#skillsOpen').addEventListener('click', () => api.skills.openDir());
  pane.querySelector('#skillsRefresh').addEventListener('click', () => drawSkills(pane, settings));
  pane.querySelectorAll('.skill-del').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api.skills.remove(btn.dataset.name);
      toast('Скилл удалён', 'info', 1600);
      drawSkills(pane, settings);
    }));

  pane.querySelector('#skSave').addEventListener('click', async () => {
    const name = pane.querySelector('#skName').value.trim();
    const body = pane.querySelector('#skBody').value.trim();
    if (!name) { pane.querySelector('#skName').classList.add('invalid'); toast('Укажите имя скилла', 'error'); return; }
    if (!body) { pane.querySelector('#skBody').classList.add('invalid'); toast('Заполните тело скилла', 'error'); return; }
    const r = await api.skills.save({
      name,
      description: pane.querySelector('#skDesc').value.trim(),
      argumentHint: pane.querySelector('#skHint').value.trim(),
      allowedTools: pane.querySelector('#skTools').value.trim(),
      body
    });
    toast(`Скилл /${r.name} создан`, 'success', 2000);
    drawSkills(pane, settings);
  });
}

/* ---------------- Interface section ---------------- */
async function drawInterface(pane, settings) {
  const locale = settings.locale || 'ru';
  pane.innerHTML = `
    <div class="set-section">
      <div class="set-h">${t('Interface', locale)}</div>
      <div class="set-sub">${t('Appearance & layout', locale)}</div>

      <div class="setrow">
        <div class="setlbl"><div class="l1">${t('Theme', locale)}</div><div class="l2">${t('Applies immediately', locale)}</div></div>
        <div class="seg-group" id="theme">
          ${[['dark', t('Dark', locale)], ['oled', 'OLED'], ['dim', t('Dim', locale)], ['solarized-light', 'Solarized'], ['gruvbox', 'Gruvbox'], ['nord', 'Nord']].map(([v, l]) =>
            `<button class="seg ${settings.theme === v ? 'active' : ''}" data-v="${v}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="setrow">
        <div class="setlbl"><div class="l1">${t('Language', locale)}</div><div class="l2">${t('App interface language', locale)}</div></div>
        <div class="setctl" style="max-width:260px">
          <select class="field-box" id="language" style="width:100%">
            ${LANGUAGE_OPTIONS.map((opt) => `<option value="${opt.id}" ${settings.locale === opt.id ? 'selected' : ''}>${escapeHtml(opt.label)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="setrow" id="fsRow">
        <div class="setlbl"><div class="l1">${t('Font size', locale)}</div></div>
        <div class="setctl" style="max-width:260px"></div>
      </div>
      <div class="setrow">
        <div class="setlbl"><div class="l1">${t('Collapse sidebar', locale)}</div></div>
        <div class="toggle ${settings.collapseSidebar ? 'on' : ''}" id="tgCollapse"></div>
      </div>
    </div>`;

  bindSeg(pane.querySelector('#theme'), async (v) => {
    await saveSettings({ theme: v });
    window.dispatchEvent(new Event('settings-changed'));
  });
  const langSelect = pane.querySelector('#language');
  langSelect.addEventListener('change', async (e) => {
    await saveSettings({ locale: e.target.value });
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
function drawShortcuts(pane, settings) {
  const locale = settings.locale || 'ru';
  pane.innerHTML = `
    <div class="set-section">
      <div class="set-h">${t('Shortcuts', locale)}</div>
      <div class="set-sub">${t('Keyboard reference', locale)}</div>
      ${SHORTCUTS.map(([label, key]) =>
        `<div class="kbrow"><span>${t(label, locale)}</span><span class="k mono">${key}</span></div>`).join('')}
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
