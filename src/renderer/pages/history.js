/* History page — dense, searchable table of saved sessions with row
 * selection, bulk export/delete, per-row open/export/delete. */
import { store, escapeHtml, formatRelative, toast, confirmDialog } from '../shared.js';

const api = window.api;

let query = '';
const selected = new Set();

async function render(container, ctx) {
  let sessions = [];
  let loaded = false;

  container.innerHTML = `
    <div class="history">
      <div class="hist-toolbar">
        <div class="searchbox">
          <svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5"/><path d="M11 11l3 3"/></svg>
          <input type="text" id="histSearch" placeholder="Search sessions…" value="${escapeHtml(query)}" />
        </div>
        <span class="spacer"></span>
        <button class="btn ghost sm danger" id="deleteAllBtn" title="Delete all chats">Delete all</button>
        <span class="hist-count" id="histCount"></span>
      </div>

      <div class="bulk-bar hidden" id="bulkBar">
        <span class="sel" id="bulkCount">0 selected</span>
        <button class="btn ghost sm" id="bulkExport">Export</button>
        <button class="btn ghost sm danger" id="bulkDelete">Delete</button>
        <span class="spacer"></span>
        <button class="btn ghost sm" id="bulkClear">Clear</button>
      </div>

      <div class="hist-cols">
        <span></span>
        <span class="lbl">Title</span><span class="lbl">Model</span>
        <span class="lbl">Date</span><span class="lbl">Msgs</span>
        <span class="lbl" style="text-align:right">Actions</span>
      </div>

      <div class="hist-rows scroll" id="histRows"></div>
    </div>`;

  const rowsEl = container.querySelector('#histRows');
  const search = container.querySelector('#histSearch');
  const deleteAllBtn = container.querySelector('#deleteAllBtn');

  const renderLoading = () => {
    container.querySelector('#histCount').textContent = 'Loading…';
    deleteAllBtn.disabled = true;
    rowsEl.innerHTML = `
      <div class="hist-loading">
        ${Array.from({ length: 6 }).map(() => `
          <div class="hist-loading-row">
            <div class="bars"><div class="bar w90 shimmer"></div></div>
            <div class="bars"><div class="bar w60 shimmer"></div></div>
          </div>
        `).join('')}
      </div>`;
  };

  const draw = () => {
    const filtered = sessions.filter((s) => (s.title || '').toLowerCase().includes(query.toLowerCase()));
    const countLabel = loaded ? `${sessions.length} session${sessions.length === 1 ? '' : 's'}` : 'Loading…';
    container.querySelector('#histCount').textContent = countLabel;
    deleteAllBtn.disabled = !loaded || !sessions.length;

    if (!loaded) {
      renderLoading();
      return;
    }
    if (!sessions.length) {
      rowsEl.innerHTML = `<div class="empty"><div class="glyph"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M8 5v3l2 1"/></svg></div>
        <div class="title">No history yet</div><div class="sub">Conversations you have are saved here automatically.</div></div>`;
      return;
    }
    if (!filtered.length) {
      rowsEl.innerHTML = `<div class="empty"><div class="sub">No sessions match “${escapeHtml(query)}”.</div></div>`;
      return;
    }

    rowsEl.innerHTML = filtered.map((s) => `
      <div class="hrow" data-id="${s.id}">
        <span class="cbox ${selected.has(s.id) ? 'on' : ''}" data-act="select"></span>
        <span class="h-title" data-act="open">${escapeHtml(s.title || 'Untitled')}</span>
        <span><span class="chip">${escapeHtml((s.model || '').replace('-latest', '').replace('mistral-', '') || 'chat')}</span></span>
        <span class="h-date">${formatRelative(s.updatedAt)}</span>
        <span class="h-msgs">${s.messageCount}</span>
        <span class="h-actions">
          <span class="icon-btn" data-act="open" title="Open"><svg viewBox="0 0 16 16"><path d="M3 8h10M9 4l4 4-4 4"/></svg></span>
          <span class="icon-btn" data-act="export" title="Export"><svg viewBox="0 0 16 16"><path d="M8 2v8M5 7l3 3 3-3M3 13h10"/></svg></span>
          <span class="icon-btn" data-act="delete" title="Delete"><svg viewBox="0 0 16 16"><path d="M3 5h10M6 5V3h4v2M5 5l1 9h4l1-9"/></svg></span>
        </span>
      </div>`).join('');

    rowsEl.querySelectorAll('.hrow').forEach((row) => {
      const id = row.dataset.id;
      row.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'select') { toggleSelect(id); }
        else if (act === 'export') { exportOne(id); }
        else if (act === 'delete') { deleteOne(id); }
        else { open(id); } // title or open icon, or row body
      });
    });
    updateBulkBar();
  };

  const toggleSelect = (id) => {
    selected.has(id) ? selected.delete(id) : selected.add(id);
    draw();
  };

  const open = async (id) => {
    const s = sessions.find((x) => x.id === id);
    if (s) ctx.navigate('chat', { openSession: s });
  };

  const exportOne = async (id) => {
    const s = sessions.find((x) => x.id === id);
    if (!s) return;
    const fmt = await pickFormat();
    if (!fmt) return;
    const r = await api.session.export(s, fmt);
    if (r.ok) toast(`Exported to ${r.filePath}`, 'success');
    else if (!r.canceled) toast('Export failed', 'error');
  };

  const deleteOne = async (id) => {
    const s = sessions.find((x) => x.id === id);
    const ok = await confirmDialog({
      title: 'Delete session?',
      body: `“${s?.title || 'Untitled'}” will be permanently removed.`,
      confirmText: 'Delete', danger: true
    });
    if (!ok) return;
    const i = sessions.findIndex((x) => x.id === id);
    if (i >= 0) sessions.splice(i, 1);
    selected.delete(id);
    await store.set('sessions', sessions);
    document.dispatchEvent(new Event('sessions-changed'));
    toast('Session deleted', 'info', 2000);
    draw();
  };

  /* ---- bulk ---- */
  const updateBulkBar = () => {
    const bar = container.querySelector('#bulkBar');
    bar.classList.toggle('hidden', selected.size === 0);
    container.querySelector('#bulkCount').textContent = `${selected.size} selected`;
  };
  container.querySelector('#bulkClear').addEventListener('click', () => { selected.clear(); draw(); });
  container.querySelector('#bulkDelete').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Delete selected?',
      body: `${selected.size} session(s) will be permanently removed.`,
      confirmText: 'Delete', danger: true
    });
    if (!ok) return;
    const remaining = sessions.filter((s) => !selected.has(s.id));
    sessions.length = 0; sessions.push(...remaining);
    selected.clear();
    await store.set('sessions', sessions);
    document.dispatchEvent(new Event('sessions-changed'));
    toast('Sessions deleted', 'info', 2000);
    draw();
  });

  deleteAllBtn.addEventListener('click', async () => {
    if (!sessions.length) return;
    const ok = await confirmDialog({
      title: 'Delete all chats?',
      body: `This will permanently remove all ${sessions.length} saved conversations.`,
      confirmText: 'Delete all', danger: true
    });
    if (!ok) return;
    sessions.length = 0;
    selected.clear();
    await store.set('sessions', sessions);
    document.dispatchEvent(new Event('sessions-changed'));
    toast('All chats deleted', 'info', 2000);
    draw();
  });
  container.querySelector('#bulkExport').addEventListener('click', async () => {
    const fmt = await pickFormat();
    if (!fmt) return;
    let okCount = 0;
    for (const id of selected) {
      const s = sessions.find((x) => x.id === id);
      if (!s) continue;
      const r = await api.session.export(s, fmt);
      if (r.ok) okCount++;
    }
    toast(`Exported ${okCount} session(s)`, 'success');
  });

  search.addEventListener('input', (e) => { query = e.target.value; draw(); });

  draw();
  setTimeout(() => search.focus(), 60);

  sessions = (await store.get('sessions')) || [];
  loaded = true;
  draw();
}

/* Ask md vs json via the confirm modal pattern (two-button choice). */
function pickFormat() {
  return new Promise((resolve) => {
    const host = document.getElementById('overlayHost');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <h3>Export format</h3>
        <p>Choose how to save the session file.</p>
        <div class="actions">
          <button class="btn ghost sm" data-f="cancel">Cancel</button>
          <button class="btn ghost sm" data-f="json">JSON</button>
          <button class="btn primary sm" data-f="md">Markdown</button>
        </div>
      </div>`;
    host.appendChild(overlay);
    const done = (v) => { overlay.remove(); resolve(v); };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) return done(null);
      const f = e.target.closest('[data-f]')?.dataset.f;
      if (f) done(f === 'cancel' ? null : f);
    });
  });
}

export default { render };
