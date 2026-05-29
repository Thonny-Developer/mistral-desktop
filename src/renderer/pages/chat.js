/* Chat page — the core feature.
 * Conversation state, SSE streaming with a live cursor, markdown rendering,
 * abortable generation, token counter, smart auto-scroll, and history
 * persistence. */
import {
  store, getSettings, saveSettings, renderMarkdown, bindCopyButtons, escapeHtml,
  estimateTokens, formatRelative, uid, toast, stripAgentTags, confirmDialog
} from '../shared.js';

/* AI permission modes — labels + descriptions shown in the picker. */
const PERM_MODES = [
  { id: 'default', label: 'Default', desc: 'Подтверждение плана и важных инструментов' },
  { id: 'tools-bypass', label: 'Tools Bypass', desc: 'Инструменты без подтверждения, bash — с подтверждением' },
  { id: 'autopilot', label: 'Autopilot (Beta)', desc: 'Без подтверждений · ранний доступ' }
];
const permLabel = (id) => (PERM_MODES.find((m) => m.id === id) || PERM_MODES[0]).label;

/* Approximate context-window sizes (in tokens) per model, for the usage gauge. */
const CONTEXT_LIMITS = {
  'mistral-large-latest': 262144,
  'mistral-medium-latest': 131072,
  'mistral-small-latest': 131072,
  'magistral-medium-latest': 131072,
  'magistral-small-latest': 131072,
  'codestral-latest': 262144,
  'devstral-medium-latest': 131072,
  'ministral-8b-latest': 131072,
  'pixtral-large-latest': 131072,
  'open-mistral-nemo': 131072
};
const ctxLimitFor = (model) => CONTEXT_LIMITS[model] || 131072;
/* Token counts of the fixed context parts (system prompt + tool schemas). */
let ctxBaseline = { system: 0, tools: 0 };

const api = window.api;

/* Module-level live conversation so it survives page navigation. */
let convo = freshConvo('mistral-large-latest');
let streaming = false;
let unsubStream = null;
let autoScroll = true;

function freshConvo(model) {
  return { id: uid(), title: '', model, createdAt: Date.now(), messages: [], savedId: null, workingDir: '', todos: [] };
}

/* ---------------- session persistence ---------------- */
async function loadSessions() {
  return (await store.get('sessions')) || [];
}

/** Persist the current conversation into the sessions array (insert or update). */
async function persistConvo() {
  if (!convo.messages.length) return;
  const firstUser = convo.messages.find((m) => m.role === 'user');
  const title = (firstUser?.content || 'New chat').replace(/\s+/g, ' ').trim().slice(0, 60);
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
  convo.model = settings.model || convo.model;

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
          <span class="streaming hidden" id="thStreaming"><span class="pulse"></span>working</span>
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
          <textarea id="composer" placeholder="Message Mistral…  (Enter to send · Shift+Enter for newline)"></textarea>
          <div class="composer-bar">
            <span class="meta mono">↵ send</span>
            <span class="meta mono">·  ${escapeHtml((convo.model || '').replace('-latest', ''))}</span>
            <span class="meta mono" id="tokMeta">·  0 tok</span>
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
  const composer = container.querySelector('#composer');
  const sendBtn = container.querySelector('#sendBtn');
  const stopBtn = container.querySelector('#stopBtn');
  const tokMeta = container.querySelector('#tokMeta');
  const ctxGauge = container.querySelector('#ctxGauge');
  const ctxPct = container.querySelector('#ctxPct');
  const ctxFill = ctxGauge.querySelector('.fill');
  const RING = 2 * Math.PI * 7; // circumference of the gauge ring (r=7)

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
    let toolChars = 0;
    for (const m of convo.messages) {
      if (m.role === 'assistant') {
        for (const ln of (m.content || '').split('\n')) {
          if (/^>\s*`[^`]+`/.test(ln.trim())) toolChars += ln.length + 1;
          else msgChars += ln.length + 1;
        }
      } else {
        msgChars += (m.content || '').length;
      }
    }
    const tok = (c) => Math.ceil(c / 4);
    const messages = tok(msgChars);
    const toolResults = tok(toolChars);
    const total = ctxBaseline.system + ctxBaseline.tools + messages + toolResults;
    return { system: ctxBaseline.system, tools: ctxBaseline.tools, messages, toolResults, total };
  };

  // Composer behaviour: Enter sends, Shift+Enter newlines; autosize; token count.
  const updateTokens = () => {
    const b = contextBreakdown();
    tokMeta.textContent = `·  ${b.total.toLocaleString()} tok`;
    const pct = Math.min(1, b.total / ctxLimitFor(convo.model));
    ctxFill.style.strokeDasharray = RING.toFixed(2);
    ctxFill.style.strokeDashoffset = (RING * (1 - pct)).toFixed(2);
    ctxPct.textContent = `${Math.round(pct * 100)}%`;
    ctxGauge.classList.toggle('warn', pct >= 0.8 && pct < 0.95);
    ctxGauge.classList.toggle('crit', pct >= 0.95);
  };

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
  });
  composer.addEventListener('keydown', (e) => {
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
    toggleCtxPopover(container, contextBreakdown(), ctxLimitFor(convo.model));
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
  async function send() {
    const text = composer.value.trim();
    if (!text || streaming) return;
    const settings = await getSettings();
    convo.model = settings.model || convo.model;

    convo.messages.push({ role: 'user', content: text });
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
    outgoing.push(...convo.messages);

    // Assistant placeholder. The agent loop streams multiple turns into this
    // one message: `committed` holds finalised visible text + tool lines from
    // previous turns; `rawTurn` is the current turn's raw tokens.
    const asstMsg = { role: 'assistant', content: '' };
    convo.messages.push(asstMsg);
    streaming = true;
    autoScroll = true;
    reflectStreamingUI();
    paintThread(thread, /*streamingLast*/ true);
    forceScroll(thread);

    let committed = '';
    let rawTurn = '';
    let rafPending = false;

    const display = () => committed + rawTurn; // renderMarkdown strips action tags
    const flush = () => {
      rafPending = false;
      asstMsg.content = display();
      updateLastAssistant(thread, asstMsg.content, true);
      updateTokens(); // keep the context gauge live as tokens stream in
      if (autoScroll) forceScroll(thread);
    };
    const scheduleFlush = () => { if (!rafPending) { rafPending = true; requestAnimationFrame(flush); } };

    // Commit the current turn's visible text before tool lines are appended.
    const commitTurn = () => {
      const visible = stripAgentTags(rawTurn).replace(/\s+$/, '');
      if (visible) committed += (committed ? '\n\n' : '') + visible;
      rawTurn = '';
    };

    unsubStream = api.mistral.onStream((msg) => {
      if (msg.type === 'token') {
        rawTurn += msg.delta;
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
        if (msg.todosChanged) refreshTodos();
        if (msg.workspaceChanged) refreshFolder();
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
        finishError(msg.message);
      }
    });

    api.mistral.send({ messages: outgoing });

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
    function finishError(message) {
      cleanupStream();
      commitTurn();
      asstMsg.content = committed.trim();
      if (!asstMsg.content) convo.messages.pop();
      paintThread(thread);
      toast(message || 'Request failed', 'error');
      persistConvo();
    }
  }

  function stop() {
    if (!streaming) return;
    api.mistral.abort();
  }

  function cleanupStream() {
    streaming = false;
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
      return `<div class="msg-row user"><div class="bubble user">${escapeHtml(m.content)}</div></div>`;
    }
    const isLast = i === convo.messages.length - 1;
    const cursor = streamingLast && isLast ? '<span class="stream-cursor">▏</span>' : '';
    return `<div class="msg-row asst-row"><div class="asst">
        <div class="who">Assistant</div>
        <div class="msg-content">${renderMarkdown(m.content)}${cursor}</div>
      </div></div>`;
  }).join('');
  thread.querySelectorAll('.msg-content').forEach(bindCopyButtons);
}

/** Update just the streaming assistant message without rebuilding the thread. */
function updateLastAssistant(thread, text, withCursor) {
  const last = thread.querySelector('.asst-row:last-child .msg-content');
  if (!last) { paintThread(thread, true); return; }
  last.innerHTML = renderMarkdown(text) + (withCursor ? '<span class="stream-cursor">▏</span>' : '');
  bindCopyButtons(last);
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
    messages: session.messages.map((m) => ({ role: m.role, content: m.content })),
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

/* ---------------- lifecycle ---------------- */
function destroy() {
  if (chatPage._onKey) { document.removeEventListener('keydown', chatPage._onKey); chatPage._onKey = null; }
  closeTodosPopover();
  closeAiPermPopover();
  closeCtxPopover();
  // Note: we intentionally keep an active stream alive so it survives a quick
  // page switch; the subscription closes itself on done/error.
}

const chatPage = { render, destroy, _onKey: null };
export default chatPage;
