'use strict';

/**
 * Agentic loop (main process)
 *
 * Each turn we stream a completion from the model with the tool schemas
 * attached. The model answers with optional visible text plus native
 * `tool_calls`. We execute the calls through the tool layer (applying the
 * permission-mode gates), feed one `tool` result message back per call, and
 * loop — until the model replies with no tool calls (the final answer).
 *
 * All progress is reported through `emit` as structured stream events the
 * renderer assembles into one assistant message.
 */

const mistral = require('./mistral');
const tools = require('./tools');

const MAX_TURNS = 16; // hard cap so a misbehaving model can't loop forever

/** Tools that run shell commands — confirmed in `default` and `tools-bypass`. */
const SHELL_TOOLS = new Set(['exec_bash', 'console_exec']);
/** Tools that change files or the system (need a plan in `default` mode). */
const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'exec_bash', 'console_exec']);
/** Tools that need explicit approval in `default` mode. */
const IMPORTANT_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'exec_bash', 'console_exec']);
/** Tools that reach the internet — confirmed per-site in `default` mode. */
const WEB_TOOLS = new Set(['web_search', 'web_fetch']);

/** Strip any stray agent directives a model might still emit as text. */
function stripTags(text) {
  return (text || '')
    .replace(/<action>[\s\S]*?<\/action>/gi, '')
    .replace(/<action>[\s\S]*$/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Which confirmation a tool needs in the given mode (or null). */
function confirmKindFor(tool, mode) {
  if (SHELL_TOOLS.has(tool) && (mode === 'default' || mode === 'tools-bypass')) return 'bash';
  if (mode === 'default' && WEB_TOOLS.has(tool)) return 'web';
  if (mode === 'default' && IMPORTANT_TOOLS.has(tool)) return 'tool';
  return null;
}

/**
 * Build a copy of the transcript for sending, eliding large outputs from older
 * tool results so the context doesn't balloon over many turns. The last few
 * tool results (recent grounding) are kept intact.
 */
function pruneForSend(work) {
  const toolIdx = [];
  work.forEach((m, i) => { if (m.role === 'tool') toolIdx.push(i); });
  const keep = new Set(toolIdx.slice(-8));
  return work.map((m, i) => {
    if (m.role === 'tool' && !keep.has(i) && (m.content || '').length > 1500) {
      return { ...m, content: '[прежний вывод инструмента свёрнут для экономии контекста]' };
    }
    return m;
  });
}

/**
 * Run the loop.
 * @param {Object}   o
 * @param {Array}    o.baseMessages    Full message array (incl. system prompts).
 * @param {Object}   o.settings
 * @param {string}   o.apiKey
 * @param {AbortSignal} o.signal
 * @param {Function} o.emit            Stream-event sink.
 * @param {Function} o.requestApproval (payload) => Promise<boolean>.
 * @param {Object}   o.ctx             Tool context ({ store, getWindow, appendMemory, signal }).
 */
async function run({ baseMessages, settings, apiKey, signal, emit, requestApproval, ctx }) {
  const work = [...baseMessages];
  const mode = settings.aiPermissionMode || 'default';
  const ask = requestApproval || (async () => true);

  /**
   * Execute one tool call, applying the mode's confirmation gates. Always
   * records a result (every tool_call must be answered for the API). Returns
   * false if the run must abort.
   */
  async function runCall(call, results) {
    const record = (output) => results.push({ id: call.id, tool: call.name, output });

    if (call.error) {
      emit({ type: 'tool', name: call.name || '(invalid)', ok: false, summary: `неверные аргументы: ${call.error}` });
      record(`Error: не удалось разобрать аргументы — ${call.error}. Повторите вызов с валидным JSON.`);
      return true;
    }

    const action = { tool: call.name, ...(call.args || {}) };
    const kind = confirmKindFor(call.name, mode);

    if (kind === 'bash') {
      const ok = await ask({ type: 'bash-confirmation-required', command: action.command || '' });
      if (signal?.aborted) return false;
      if (!ok) {
        emit({ type: 'tool', name: call.name, ok: false, summary: `команда отклонена · ${(action.command || '').slice(0, 50)}` });
        record('Пользователь отклонил выполнение этой команды.');
        return true;
      }
    } else if (kind === 'web') {
      const target = action.url || (action.query ? `поиск: ${action.query}` : 'интернет');
      const ok = await ask({ type: 'web-confirmation-required', target });
      if (signal?.aborted) return false;
      if (!ok) {
        emit({ type: 'tool', name: call.name, ok: false, summary: `доступ запрещён · ${target.slice(0, 50)}` });
        record('Пользователь запретил доступ к интернету для этого запроса.');
        return true;
      }
    } else if (kind === 'tool') {
      const ok = await ask({ type: 'tool-confirmation-required', toolName: call.name, path: action.path || '' });
      if (signal?.aborted) return false;
      if (!ok) {
        emit({ type: 'tool', name: call.name, ok: false, summary: 'действие отклонено пользователем' });
        record('Пользователь отклонил это действие.');
        return true;
      }
    }

    emit({ type: 'tool-start', name: call.name });
    const r = await tools.exec(action, ctx);
    emit({
      type: 'tool',
      name: call.name,
      ok: r.ok,
      summary: r.summary,
      error: r.error,
      todosChanged: !!r.todosChanged,
      workspaceChanged: !!r.workspaceChanged
    });
    record(r.output);
    return !signal?.aborted;
  }

  /** Append one `tool` message per recorded result (API requires answering all). */
  function pushToolResults(results) {
    for (const r of results) {
      work.push({ role: 'tool', tool_call_id: r.id, name: r.tool, content: String(r.output ?? '') });
    }
  }

  let planningDone = false;
  let requestedPlanning = false;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let text = '';
    let result;
    try {
      result = await mistral.sendMessage({
        messages: pruneForSend(work),
        settings,
        apiKey,
        signal,
        tools: tools.TOOL_SCHEMAS,
        onToken: (delta) => { text += delta; emit({ type: 'token', delta }); }
      });
    } catch (e) {
      if (e.code === 'aborted') { emit({ type: 'done', content: '', aborted: true }); return; }
      emit({ type: 'error', message: e.message, code: e.code || 'unknown' });
      return;
    }

    text = result.content ?? text;
    const calls = result.toolCalls || [];

    if (result.aborted) {
      emit({ type: 'done', content: stripTags(text), aborted: true, usage: result.usage });
      return;
    }

    // No tool calls → this is the final answer.
    if (!calls.length) {
      emit({ type: 'done', content: stripTags(text), usage: result.usage });
      return;
    }

    // The model wants to act. Record its assistant turn (text + the tool_calls
    // it issued) — the API requires the calls to be present before their
    // results — and mark the boundary so the renderer commits visible text.
    work.push({
      role: 'assistant',
      content: text || '',
      tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArguments } }))
    });
    emit({ type: 'turn' });

    const results = [];

    // --- Planning + plan approval (default mode, only for mutating work) ---
    if (mode === 'default' && !planningDone) {
      const todoCalls = calls.filter((c) => c.name === 'add_todo');
      const mutating = calls.filter((c) => MUTATING_TOOLS.has(c.name));

      if (!todoCalls.length && mutating.length && !requestedPlanning) {
        // Answer every pending call (API requirement) without executing, asking
        // the model to lay out a plan first.
        for (const c of calls) results.push({ id: c.id, tool: c.name, output: 'Сначала составьте план: вызовите add_todo для каждого шага. Действие пока не выполнено.' });
        pushToolResults(results);
        requestedPlanning = true;
        continue;
      }

      if (todoCalls.length) {
        // Record the plan (todos never need confirmation)…
        const others = calls.filter((c) => c.name !== 'add_todo');
        for (const c of todoCalls) {
          if (!(await runCall(c, results))) { emit({ type: 'done', content: stripTags(text), aborted: true }); return; }
        }
        // …defer everything else to the next turn…
        for (const c of others) results.push({ id: c.id, tool: c.name, output: 'Отложено: дождитесь утверждения плана пользователем.' });
        planningDone = true;
        pushToolResults(results);

        // …and ask the user to approve the plan before any work runs.
        const approved = await ask({ type: 'plan-review-required', todoCount: todoCalls.length });
        if (signal?.aborted) { emit({ type: 'done', content: stripTags(text), aborted: true }); return; }
        if (!approved) { emit({ type: 'done', content: '_План отклонён. Выполнение остановлено._' }); return; }
        work.push({ role: 'user', content: 'План утверждён пользователем. Продолжайте выполнение плана.' });
        continue;
      }
      // No todos and none needed (read-only calls) or planning already
      // requested → fall through and execute.
    }

    // --- Execute the calls (with per-tool confirmation gates) ---
    for (const c of calls) {
      if (!(await runCall(c, results))) { emit({ type: 'done', content: stripTags(text), aborted: true }); return; }
    }
    pushToolResults(results);
  }

  emit({ type: 'done', content: '_Достигнут предел шагов для одного запроса. Напишите «продолжай», чтобы я довёл задачу до конца._' });
}

module.exports = { run, stripTags };
