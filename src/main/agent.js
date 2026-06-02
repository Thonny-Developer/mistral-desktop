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

// Permission metadata now lives with the tools themselves (single source of
// truth). The agent loop only asks the registry which confirmation a call
// needs and which tools count as "mutating" for the planning gate.
const { confirmKindFor, MUTATING_TOOLS } = tools;

/** Strip any stray agent directives a model might still emit as text. */
function stripTags(text) {
  return (text || '')
    .replace(/<action>[\s\S]*?<\/action>/gi, '')
    .replace(/<action>[\s\S]*$/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
async function run({ baseMessages, settings, apiKey, signal, emit, requestApproval, ctx, allowedTools }) {
  const work = [...baseMessages];
  const mode = settings.aiPermissionMode || 'default';
  const ask = requestApproval || (async () => true);
  // A skill can restrict the turn to a subset of tools; otherwise the full set.
  // The todo tools are always kept available so the Default-mode planning gate
  // (which asks the model to add_todo before mutating) can never deadlock a
  // restricted skill that uses, say, edit_file but didn't list add_todo.
  const CONTROL_TOOLS = ['add_todo', 'complete_todo', 'list_todos'];
  const toolSchemas = (Array.isArray(allowedTools) && allowedTools.length)
    ? tools.buildSchemas(new Set([...allowedTools, ...CONTROL_TOOLS]))
    : tools.TOOL_SCHEMAS;

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
      // How much text this result fed back into the context (file reads, command
      // output, etc.) — so the UI's context gauge can account for it.
      outputChars: (r.output == null ? '' : String(r.output)).length,
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
        tools: toolSchemas,
        onToken: (delta) => { text += delta; emit({ type: 'token', delta }); },
        // Rate limited → tell the UI we're waiting and will retry (no rollback).
        onRetry: (info) => emit({ type: 'rate-limit-wait', ...info })
      });
    } catch (e) {
      if (e.code === 'aborted') { emit({ type: 'done', content: '', aborted: true }); return; }
      emit({ type: 'error', message: e.message, code: e.code || 'unknown' });
      return;
    }

    text = result.content ?? text;
    const calls = result.toolCalls || [];

    // Report the real token usage for this request. The latest prompt_tokens is
    // the true size of the context window (it already includes the system
    // prompt, tool schemas, every message AND every tool result like file reads
    // and reasoning), so the UI can show an accurate gauge instead of an estimate.
    if (result.usage) emit({ type: 'usage', usage: result.usage });
    if (result.rateLimit) emit({ type: 'rate-limit', rateLimit: result.rateLimit });

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

/* ==================================================================== *
 *  Subagents
 *
 *  A subagent is an isolated worker the main loop spawns (via the
 *  run_subagent tool) to carry out one focused task. It has its OWN
 *  conversation/context (separate from the parent transcript) but shares
 *  the workspace, runs autonomously with no user approval, and is limited
 *  to a restricted, mostly read-only toolset. Its single output is a final
 *  text report, which becomes the tool result fed back to the parent.
 * ------------------------------------------------------------------------ */
const SUBAGENT_MAX_TURNS = 8;
const SUBAGENT_MAX_DEPTH = 2;

/** Focused system prompt for a subagent run. */
function buildSubagentSystem(mode, allowed) {
  return [
    'You are a subagent — an isolated worker spawned by the main assistant to carry out ONE focused task and report back.',
    'You run fully autonomously: there is no user to talk to. Never ask questions; make reasonable assumptions and proceed.',
    `Tools available to you: ${[...allowed].join(', ')}. You cannot use any other tool.`,
    mode === 'read'
      ? 'You are READ-ONLY: explore, read and analyze, but do not modify anything.'
      : 'You may read and edit files, but you cannot delete files or run shell commands.',
    'All paths are relative to the shared working folder.',
    'When finished, reply with a concise, self-contained report (plain text, no tool call). That report is your ONLY output to the main assistant — include every conclusion it needs.'
  ].join('\n');
}

/**
 * Run an isolated subagent loop.
 * @returns {Promise<{text:string, aborted?:boolean}>}
 */
async function runSubagent({ task, focus, mode, settings, apiKey, signal, emit, ctx, depth }) {
  const allowed = new Set(tools.READONLY_TOOLS);
  if (mode === 'write') { allowed.add('write_file'); allowed.add('edit_file'); }
  // The subagent may itself discover/follow skills, but never spawn more agents.
  allowed.add('list_skills'); allowed.add('run_skill');

  const schemas = tools.buildSchemas(allowed);
  const work = [
    { role: 'system', content: buildSubagentSystem(mode, allowed) },
    { role: 'user', content: focus ? `Task: ${task}\n\nContext: ${focus}` : `Task: ${task}` }
  ];
  // Subagents share the workspace but get a fresh depth counter so they can't
  // recurse without bound.
  const subCtx = { ...ctx, subagentDepth: depth };

  emit?.({ type: 'subagent-start', task, mode });
  let finalText = '';

  for (let turn = 0; turn < SUBAGENT_MAX_TURNS; turn++) {
    let text = '';
    let result;
    try {
      result = await mistral.sendMessage({
        messages: work, settings, apiKey, signal, tools: schemas,
        onToken: (d) => { text += d; }, // accumulate only — never leak to the main stream
        onRetry: (info) => emit?.({ type: 'rate-limit-wait', ...info, subagent: true })
      });
    } catch (e) {
      if (e.code === 'aborted') { emit?.({ type: 'subagent-done', aborted: true }); return { text: finalText, aborted: true }; }
      emit?.({ type: 'subagent-done', error: e.message });
      return { text: `Subagent error: ${e.message}` };
    }

    text = result.content ?? text;
    const calls = result.toolCalls || [];
    if (result.aborted) { emit?.({ type: 'subagent-done', aborted: true }); return { text: stripTags(text), aborted: true }; }

    if (!calls.length) {
      finalText = stripTags(text);
      emit?.({ type: 'subagent-done', task });
      return { text: finalText };
    }

    work.push({
      role: 'assistant', content: text || '',
      tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArguments } }))
    });

    for (const c of calls) {
      if (signal?.aborted) { emit?.({ type: 'subagent-done', aborted: true }); return { text: finalText, aborted: true }; }
      let output;
      if (c.error) {
        emit?.({ type: 'subagent-tool', name: c.name, ok: false, summary: `неверные аргументы: ${c.error}` });
        output = `Error: invalid arguments — ${c.error}. Retry with valid JSON.`;
      } else {
        emit?.({ type: 'subagent-tool-start', name: c.name });
        const r = await tools.exec({ tool: c.name, ...(c.args || {}) }, subCtx, allowed);
        emit?.({ type: 'subagent-tool', name: c.name, ok: r.ok, summary: r.summary, workspaceChanged: !!r.workspaceChanged });
        output = r.output;
      }
      work.push({ role: 'tool', tool_call_id: c.id, name: c.name, content: String(output ?? '') });
    }
  }

  emit?.({ type: 'subagent-done', task, truncated: true });
  return { text: finalText || '(субагент достиг предела шагов, не завершив задачу)' };
}

module.exports = { run, stripTags, runSubagent, SUBAGENT_MAX_DEPTH };
