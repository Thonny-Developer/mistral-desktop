'use strict';

/**
 * Mistral API service (main process).
 *
 * Uses Node's native `fetch` (Node 18+ / Electron 22+) — no third-party HTTP client.
 * Streaming responses are parsed from the `text/event-stream` (SSE) body and pushed
 * back to the renderer one delta at a time via the supplied `onToken` callback.
 *
 * All public methods throw `Error` instances with a `.code` property so the caller
 * can map failures to user-friendly toasts (network, auth, rate-limit, etc.).
 */

const DEFAULT_ENDPOINT = 'https://api.mistral.ai/v1';

// Models the client officially supports (see Settings page). These are the
// official `-latest` aliases from https://docs.mistral.ai/getting-started/models —
// the API always resolves them to the current dated snapshot.
const SUPPORTED_MODELS = [
  'mistral-large-latest',
  'mistral-medium-latest',
  'mistral-small-latest',
  'magistral-medium-latest',
  'magistral-small-latest',
  'codestral-latest',
  'devstral-medium-latest',
  'ministral-8b-latest',
  'pixtral-large-latest',
  'open-mistral-nemo'
];

/** Fallback model when settings don't specify one. */
const DEFAULT_MODEL = 'codestral-latest';

/** LM Studio's default local OpenAI-compatible server endpoint. */
const LMSTUDIO_ENDPOINT = 'http://localhost:1234/v1';

/**
 * Resolve the active provider's connection config from settings.
 *
 * LM Studio exposes a local OpenAI-compatible API, so the same request/SSE code
 * works against it — it just needs no API key and has its own endpoint, kept
 * separate (`lmstudioEndpoint`) so switching providers never clobbers the
 * Mistral endpoint.
 */
function providerConfig(settings) {
  if (settings && settings.provider === 'lmstudio') {
    return {
      provider: 'lmstudio',
      endpoint: settings.lmstudioEndpoint || LMSTUDIO_ENDPOINT,
      requiresKey: false
    };
  }
  return {
    provider: 'mistral',
    endpoint: (settings && settings.endpoint) || DEFAULT_ENDPOINT,
    requiresKey: true
  };
}

/** Build request headers, attaching auth only when a key is actually present. */
function authHeaders(apiKey, extra) {
  const h = { ...(extra || {}) };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

/**
 * Normalise a message/delta `content` into plain text.
 *
 * Older Mistral models stream `content` as a plain string, but newer ones
 * (and the reasoning "magistral" family) return it as structured content
 * chunks — an array of, or a single, object like `{type:'text', text:'…'}` or
 * `{type:'thinking', thinking:[…]}`. Appending those objects directly is what
 * produced the "[object Object][object Object]…" output, so we flatten any
 * shape down to text here, at the single point where content enters the app.
 */
function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(contentToText).join('');
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content !== 'undefined') return contentToText(content.content);
    if (typeof content.thinking !== 'undefined') return contentToText(content.thinking);
    return '';
  }
  return String(content);
}

// The reasoning ("magistral") family returns its thought process as structured
// `{type:'thinking'}` content chunks, separate from the `{type:'text'}` answer.
// We wrap that thinking stream in a collapsible block right here so the
// reasoning is ALWAYS captured in the foldable "Думает" panel — never leaked
// into the plain answer — regardless of whether the model also emits the HTML
// the system prompt asks non-reasoning models for. The plain `<details>` tag
// (no attributes) matches what the renderer expects: it manages the `open`
// state and bakes in the measured duration itself.
const THINK_OPEN = '<details><summary>Думает</summary>';
const THINK_CLOSE = '</details>';

/** Walk a content value into ordered chunks, each tagged thinking-or-not. */
function* contentChunks(content) {
  if (content == null) return;
  if (typeof content === 'string') { yield { thinking: false, text: content }; return; }
  if (Array.isArray(content)) { for (const c of content) yield* contentChunks(c); return; }
  if (typeof content === 'object') {
    const thinking = typeof content.thinking !== 'undefined';
    yield { thinking, text: thinking ? contentToText(content.thinking) : contentToText(content) };
  }
}

/**
 * Stateful flattener: turns a stream of content deltas into text, wrapping any
 * `thinking` chunks in a `<details>` block. The "are we inside a thinking block"
 * flag is kept across deltas, so the block opens on the first thinking chunk and
 * closes the instant the answer text starts. `flush()` closes a block left open
 * if the stream ends (or is aborted) mid-thought.
 */
function createReasoningFlattener() {
  let inThink = false;
  return {
    push(content) {
      let out = '';
      for (const { thinking, text } of contentChunks(content)) {
        if (thinking && !inThink) { out += THINK_OPEN; inThink = true; }
        else if (!thinking && inThink) { out += THINK_CLOSE; inThink = false; }
        out += text;
      }
      return out;
    },
    flush() { const out = inThink ? THINK_CLOSE : ''; inThink = false; return out; }
  };
}

/** Build a tagged error so the renderer can branch on `.code`. */
function apiError(message, code) {
  const err = new Error(message);
  err.code = code || 'unknown';
  return err;
}

/** Normalise the endpoint (strip a trailing slash) and join a path. */
function url(endpoint, path) {
  const base = (endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  return `${base}${path}`;
}

/** Translate an HTTP status into a coded, human error. */
function errorForStatus(status, bodyText, headers) {
  let detail = '';
  try {
    const parsed = JSON.parse(bodyText);
    detail = parsed?.message || parsed?.error?.message || '';
  } catch {
    detail = (bodyText || '').slice(0, 200);
  }
  if (status === 401 || status === 403) {
    return apiError(detail || 'Invalid or missing API key.', 'auth');
  }
  if (status === 429) {
    const err = apiError(detail || 'Rate limit exceeded. Slow down and retry.', 'rate_limit');
    err.retryAfterMs = retryAfterMsFrom(headers); // when the API says we can retry
    err.rateLimit = extractRateLimitInfo(headers);
    return err;
  }
  if (status >= 500) {
    return apiError(detail || `Mistral server error (${status}).`, 'server');
  }
  return apiError(detail || `Request failed (${status}).`, 'http');
}

/**
 * How long to wait before retrying, taken straight from the API's response:
 * the standard `Retry-After` header (seconds or an HTTP date), falling back to
 * `x-ratelimit-reset` (epoch seconds). Returns null when the API gives no hint.
 */
function retryAfterMsFrom(headers) {
  if (!headers) return null;
  const ra = headers.get('retry-after');
  if (ra) {
    const secs = parseInt(ra, 10);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const date = Date.parse(ra);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const reset = parseInt(headers.get('x-ratelimit-reset'), 10);
  if (Number.isFinite(reset)) {
    // Large values look like an absolute epoch; small ones like a delay.
    const ms = reset > 1e6 ? reset * 1000 - Date.now() : reset * 1000;
    if (ms > 0) return ms;
  }
  return null;
}

/** Pick the wait before the next attempt: honour the API's hint, else back off
 *  exponentially. Always clamped to a sane [1s, 60s] window, plus a little
 *  jitter so parallel retries don't all fire at once. */
function backoffMs(retryAfterMs, attempt) {
  let ms = Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? retryAfterMs
    : 1000 * 2 ** Math.max(0, attempt - 1); // 1s, 2s, 4s, 8s, …
  ms = Math.min(60000, Math.max(1000, ms));
  return Math.round(ms + Math.random() * 400);
}

/** A timeout that also rejects (with code 'aborted') the moment the signal fires. */
function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(apiError('Generation stopped.', 'aborted'));
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    const onAbort = () => { cleanup(); reject(apiError('Generation stopped.', 'aborted')); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const MAX_RATE_LIMIT_RETRIES = 5;
// Transient failures (a dropped connection, a 5xx from the gateway) are usually
// momentary — we back off and retry a few times before surfacing the error,
// instead of failing the whole turn on the first blip.
const MAX_TRANSIENT_RETRIES = 3;

/**
 * Staged loading reporter for local models.
 *
 * A local server (LM Studio) loads the model into memory on first use ("JIT
 * loading"): the request to `/chat/completions` blocks until the model is
 * resident, then streams. There's no progress channel over the OpenAI-compatible
 * API, so we surface where we are by timing the request instead:
 *
 *   • `loading` — fired only if waiting on the response headers exceeds a short
 *      threshold (the model is being read into RAM/VRAM).
 *   • `warming` — the server answered; the model is resident and now processing
 *      the prompt / producing the first token.
 *
 * Because the first event is deferred behind a threshold, a fast turn (model
 * already loaded) reports nothing — no loader ever flashes. Disabled entirely
 * for the cloud provider, which has no such load step.
 *
 * @param {Function} onLoading  called with `{ stage, startedAt }`.
 * @param {boolean}  enabled    only true for the local provider.
 */
function createLoadWatch(onLoading, enabled) {
  if (!enabled || typeof onLoading !== 'function') {
    return { ready() {}, stop() {} };
  }
  const startedAt = Date.now();
  let timer = null;
  let shown = false;
  const fire = (stage) => { shown = true; onLoading({ stage, startedAt }); };
  const arm = (stage, delay) => { clearTimeout(timer); timer = setTimeout(() => fire(stage), delay); };
  arm('loading', 500); // only surfaces when the load actually takes a moment
  return {
    // Headers arrived → model resident, prompt being processed. Advance to
    // "warming" immediately if we already showed "loading", else keep the
    // threshold so a quick turn still shows nothing.
    ready() { arm('warming', shown ? 0 : 600); },
    stop() { clearTimeout(timer); timer = null; }
  };
}

/** Extract rate limit information from response headers. */
function extractRateLimitInfo(headers) {
  if (!headers) return null;
  const limit = parseInt(headers.get('x-ratelimit-limit'), 10);
  const remaining = parseInt(headers.get('x-ratelimit-remaining'), 10);
  const reset = parseInt(headers.get('x-ratelimit-reset'), 10);
  if (!Number.isFinite(limit) && !Number.isFinite(remaining) && !Number.isFinite(reset)) {
    return null;
  }
  return {
    limit: Number.isFinite(limit) ? limit : null,
    remaining: Number.isFinite(remaining) ? remaining : null,
    resetAt: Number.isFinite(reset) ? reset * 1000 : null // convert to milliseconds
  };
}

/**
 * Proactive request limiter (process-global).
 *
 * The Mistral limit is enforced on two axes — requests/second and tokens/minute
 * — and it is cheaper to glide under it than to recover from a 429. This gate
 * sits in front of every outgoing request and does two things:
 *   • caps how many requests may be in flight at once (`maxConcurrent`; 1 is the
 *     right default for the free tier),
 *   • spaces consecutive request starts by at least `minIntervalMs`.
 * So a burst — the agent's rapid tool-loop, or the in-app chat racing a plugin —
 * is smoothed out instead of colliding into retries. Config is applied live from
 * settings, so tuning it in the UI takes effect on the very next request. There
 * is never a deadlock: a request always releases its slot before any nested one
 * (a subagent, the next turn) is issued.
 */
const rateGate = (() => {
  let active = 0;
  let lastStart = 0;
  let timer = null;
  const waiters = [];
  const cfg = { maxConcurrent: 1, minIntervalMs: 0 };

  function pump() {
    timer = null;
    while (waiters.length && active < cfg.maxConcurrent) {
      const wait = lastStart + cfg.minIntervalMs - Date.now();
      if (wait > 0) { timer = setTimeout(pump, wait); return; } // hold for spacing
      active++;
      lastStart = Date.now();
      waiters.shift()(); // grant the slot
    }
  }

  return {
    configure(maxConcurrent, minIntervalMs) {
      cfg.maxConcurrent = Math.max(1, Math.floor(maxConcurrent) || 1);
      cfg.minIntervalMs = Math.max(0, Math.floor(minIntervalMs) || 0);
      if (!timer) pump(); // a looser config may unblock queued waiters at once
    },
    // Resolves with a one-shot release() to call when the request is done.
    acquire() {
      return new Promise((resolve) => {
        waiters.push(() => resolve(() => { active = Math.max(0, active - 1); pump(); }));
        pump();
      });
    }
  };
})();

/** Derive the gate's config from user settings (safe defaults for the free tier). */
function gateConfigFromSettings(settings) {
  return {
    maxConcurrent: clampNum(settings && settings.maxConcurrentRequests, 1, 16, 1),
    minIntervalMs: clampNum(settings && settings.minRequestIntervalMs, 0, 60000, 0)
  };
}

/**
 * Fire one POST and hand back the live (successful) response, transparently
 * retrying the two failure classes that are worth retrying:
 *   • 429 (rate limit)  — honour Retry-After, up to MAX_RATE_LIMIT_RETRIES.
 *   • network drop / 5xx — back off exponentially, up to MAX_TRANSIENT_RETRIES.
 * Everything else throws its coded error straight away. A retry is always clean
 * here: we only ever retry before any body byte has been read, so no partial
 * output can leak. Rate-limit and transient budgets are counted separately so a
 * burst of one kind can't exhaust the other's allowance.
 *
 * @returns {Promise<{res: Response, watch: {ready:Function, stop:Function}}>}
 *          The caller owns the body and must drive `watch.ready()/stop()`.
 */
async function requestWithRetries({ endpoint, path, apiKey, body, signal, stream, onRetry, onLoading, isLocal, gate }) {
  if (gate) rateGate.configure(gate.maxConcurrent, gate.minIntervalMs);
  let rateLimitAttempts = 0;
  let transientAttempts = 0;
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    // Staged local-model load reporter for this attempt (no-op for cloud).
    const watch = createLoadWatch(onLoading, isLocal);
    // Wait for a slot: enforces the min interval between starts and the cap on
    // concurrent requests. Released the moment headers land so the slot frees up
    // while the body streams. Retries pass through the gate too, so a backoff
    // never fires a burst.
    const release = await rateGate.acquire();
    let res;
    try {
      res = await fetch(url(endpoint, path), {
        method: 'POST',
        headers: authHeaders(apiKey, {
          'Content-Type': 'application/json',
          Accept: stream ? 'text/event-stream' : 'application/json'
        }),
        body: JSON.stringify(body),
        signal
      });
    } catch (e) {
      release();
      watch.stop();
      if (e.name === 'AbortError') throw apiError('Generation stopped.', 'aborted');
      // A dropped/refused connection — momentary in most cases. Back off and retry.
      if (transientAttempts < MAX_TRANSIENT_RETRIES && !signal?.aborted) {
        transientAttempts++;
        const waitMs = backoffMs(null, transientAttempts);
        if (onRetry) onRetry({ attempt: transientAttempts, maxRetries: MAX_TRANSIENT_RETRIES, waitMs, reason: 'network' });
        await abortableDelay(waitMs, signal); // throws 'aborted' if the user stops
        continue;
      }
      throw apiError(`Network error: ${e.message}`, 'network');
    }
    // Headers are in — free the slot so the next request can start while this
    // one's body is still streaming.
    release();

    if (!res.ok) {
      watch.stop();
      const text = await res.text().catch(() => '');
      const err = errorForStatus(res.status, text, res.headers);
      if (err.code === 'rate_limit' && rateLimitAttempts < MAX_RATE_LIMIT_RETRIES && !signal?.aborted) {
        rateLimitAttempts++;
        const waitMs = backoffMs(err.retryAfterMs, rateLimitAttempts);
        if (onRetry) onRetry({ attempt: rateLimitAttempts, maxRetries: MAX_RATE_LIMIT_RETRIES, waitMs, rateLimit: err.rateLimit });
        await abortableDelay(waitMs, signal);
        continue;
      }
      // 5xx from the API/gateway — treat like a transient blip and retry.
      if (err.code === 'server' && transientAttempts < MAX_TRANSIENT_RETRIES && !signal?.aborted) {
        transientAttempts++;
        const waitMs = backoffMs(err.retryAfterMs, transientAttempts);
        if (onRetry) onRetry({ attempt: transientAttempts, maxRetries: MAX_TRANSIENT_RETRIES, waitMs, reason: 'server' });
        await abortableDelay(waitMs, signal);
        continue;
      }
      throw err;
    }

    return { res, watch };
  }
}

/**
 * Stream a chat completion.
 *
 * @param {Object}   opts
 * @param {Array}    opts.messages       Full conversation [{role, content}, ...].
 * @param {Object}   opts.settings       Resolved settings (model, temperature, etc.).
 * @param {string}   opts.apiKey         Decrypted API key.
 * @param {Function} opts.onToken        Called with each text delta.
 * @param {AbortSignal} opts.signal      Abort signal for the Stop button.
 * @param {Array}    opts.tools          Optional tool/function schemas for native tool-calling.
 * @returns {Promise<{content:string, toolCalls:Array, usage:Object|null}>}
 */
async function sendMessage({ messages, settings, apiKey, onToken, signal, tools, onRetry, onLoading, responseFormat }) {
  const prov = providerConfig(settings);
  if (prov.requiresKey && !apiKey) throw apiError('No API key configured. Add one in Settings.', 'auth');

  const isLocal = prov.provider === 'lmstudio'; // only the local server has a load step
  const endpoint = prov.endpoint;
  const stream = settings.stream !== false;
  const qualityMode = settings.reasoningLevel || 'medium';
  const QUALITY_SAMPLING = {
    low: { temperature: 0.2, top_p: 0.5 },
    medium: { temperature: 0.7, top_p: 0.9 },
    high: { temperature: 0.4, top_p: 1 }
  };
  const qualitySettings = QUALITY_SAMPLING[qualityMode] || QUALITY_SAMPLING.medium;

  const hasTools = Array.isArray(tools) && tools.length > 0;
  // Tool-using turns want determinism over creativity — cap the temperature so
  // file paths, edits and commands come out predictable run-to-run.
  const temperature = hasTools
    ? Math.min(clampNum(qualitySettings.temperature, 0, 1.5, 0.7), 0.3)
    : clampNum(qualitySettings.temperature, 0, 1.5, 0.7);

  // Use exactly the model the user selected. Only fall back when it's missing
  // entirely — never silently swap a valid choice for a different model.
  const model = (typeof settings.model === 'string' && settings.model.trim())
    ? settings.model.trim()
    : DEFAULT_MODEL;
  const body = {
    model,
    messages,
    temperature,
    top_p: clampNum(qualitySettings.top_p, 0, 1, 1),
    stream
  };
  if (hasTools) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  // max_tokens is optional — only send a positive integer.
  const maxTokens = parseInt(settings.maxTokens, 10);
  if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;

  // Server-side prompt caching (Mistral cloud only): a stable per-conversation
  // key lets the API reuse the fixed instruction+tools prefix across turns and
  // messages at ~10% of the input price. LM Studio has no such feature.
  if (prov.provider === 'mistral' && settings.promptCacheKey) {
    body.prompt_cache_key = String(settings.promptCacheKey);
  }
  // Structured outputs: pin the reply to a JSON schema when the caller asks.
  if (responseFormat) body.response_format = responseFormat;

  // Rate limits and transient blips (network drop / 5xx) are retried inside the
  // helper without rolling the turn back — nothing has streamed yet, so it is
  // clean. Any other failure throws a coded error for the caller to surface.
  const { res, watch } = await requestWithRetries({
    endpoint, path: '/chat/completions', apiKey, body, signal, stream, onRetry, onLoading, isLocal,
    gate: gateConfigFromSettings(settings)
  });

  // Headers in → model resident, prompt being processed (first token next).
  watch.ready();

  // Non-streaming path: parse a single JSON payload.
  if (!stream) {
    watch.stop();
    const data = await res.json();
    const msg = data?.choices?.[0]?.message || {};
    const flat = createReasoningFlattener();
    const content = flat.push(msg.content) + flat.flush();
    if (onToken && content) onToken(content);
    const toolCalls = (msg.tool_calls || []).map((tc, i) => parseToolCall(tc.id || `call_${i}`, tc.function?.name, tc.function?.arguments));
    const rateLimit = extractRateLimitInfo(res.headers);
    return { content, toolCalls, usage: data?.usage || null, rateLimit };
  }

  // Streaming path: parse SSE frames as they arrive. The watch is cleared the
  // moment the first body chunk lands (model has begun producing output).
  return await parseSSE(res, onToken, watch);
}

/** Finalise an accumulated tool call: parse its JSON arguments (or flag error). */
function parseToolCall(id, name, rawArgs) {
  const raw = (rawArgs == null || rawArgs === '') ? '{}' : String(rawArgs);
  let args = {};
  let error = null;
  try { args = JSON.parse(raw); } catch (e) { error = e.message; }
  return { id, name, args, rawArguments: raw, error };
}

/** Read the SSE body, emit text deltas via onToken, accumulate tool calls. */
async function parseSSE(res, onToken, watch) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let full = '';
  let usage = null;
  const flat = createReasoningFlattener(); // wraps streamed `thinking` chunks in <details>
  // tool_calls stream in fragments keyed by index: id/name arrive once, the
  // JSON `arguments` string is concatenated across deltas.
  const toolAcc = new Map();

  const finalize = () => [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, s]) => parseToolCall(s.id || `call_${s.index}`, s.name, s.args))
    .filter((tc) => tc.name);

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      // First body chunk → the model is producing output; drop the load watch
      // so no late "warming" stage fires once tokens (or tool calls) start.
      if (watch) { watch.stop(); watch = null; }
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line.
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        for (const line of frame.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const json = JSON.parse(payload);
            const delta = json?.choices?.[0]?.delta;
            const piece = flat.push(delta?.content);
            if (piece) {
              full += piece;
              if (onToken) onToken(piece);
            }
            if (Array.isArray(delta?.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                const slot = toolAcc.get(idx) || { index: idx, id: '', name: '', args: '' };
                if (tc.id) slot.id = tc.id;
                if (tc.function?.name) slot.name = tc.function.name;
                if (tc.function?.arguments) slot.args += tc.function.arguments;
                toolAcc.set(idx, slot);
              }
            }
            if (json?.usage) usage = json.usage;
          } catch {
            // Ignore malformed/keep-alive frames.
          }
        }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      // Caller treats a partial result as success — return what we have, but
      // close any reasoning block we were mid-way through so it isn't orphaned.
      const tail = flat.flush();
      if (tail) { full += tail; if (onToken) onToken(tail); }
      const rateLimit = extractRateLimitInfo(res.headers);
      return { content: full, toolCalls: finalize(), usage, aborted: true, rateLimit };
    }
    throw apiError(`Stream error: ${e.message}`, 'network');
  }

  const tail = flat.flush(); // close a block left open if the stream ended mid-thought
  if (tail) { full += tail; if (onToken) onToken(tail); }
  const rateLimit = extractRateLimitInfo(res.headers);
  return { content: full, toolCalls: finalize(), usage, rateLimit };
}

/**
 * One-shot structured completion: force the reply into a JSON schema and hand
 * back the parsed object. No tools, no streaming — this is the reliable path
 * for extraction/classification/anything that must be machine-readable.
 *
 * @param {Object} opts
 * @param {Array}  opts.messages     Conversation [{role, content}, ...].
 * @param {Object} opts.schema       A JSON Schema object the reply must satisfy.
 * @param {string} [opts.schemaName] Name for the schema (defaults to 'response').
 * @returns {Promise<{data:Object|null, raw:string, usage:Object|null, parseError:string|null}>}
 */
async function sendStructured({ messages, settings, apiKey, schema, schemaName, signal }) {
  const prov = providerConfig(settings);
  if (prov.requiresKey && !apiKey) throw apiError('No API key configured. Add one in Settings pls X_X', 'auth');
  if (!schema || typeof schema !== 'object') throw apiError('sendStructured requires a JSON schema object.', 'bad_request');

  const model = (settings && typeof settings.model === 'string' && settings.model.trim())
    ? settings.model.trim()
    : DEFAULT_MODEL;
  const body = {
    model,
    messages,
    temperature: 0, // deterministic — extraction should be reproducible
    stream: false,
    response_format: {
      type: 'json_schema',
      json_schema: { name: schemaName || 'response', schema, strict: true }
    }
  };
  if (prov.provider === 'mistral' && settings && settings.promptCacheKey) {
    body.prompt_cache_key = String(settings.promptCacheKey);
  }

  const { res, watch } = await requestWithRetries({
    endpoint: prov.endpoint, path: '/chat/completions', apiKey, body, signal, stream: false, isLocal: false,
    gate: gateConfigFromSettings(settings)
  });
  watch.stop();
  const data = await res.json();
  const raw = contentToText(data?.choices?.[0]?.message?.content);
  let parsed = null;
  let parseError = null;
  try { parsed = JSON.parse(raw); } catch (e) { parseError = e.message; }
  return { data: parsed, raw, usage: data?.usage || null, parseError };
}

/**
 * Fill-in-the-middle completion (Codestral). Given the code BEFORE the cursor
 * (`prompt`) and, optionally, the code AFTER it (`suffix`), the model generates
 * the missing middle. This is Codestral's native completion mode, exposed at a
 * dedicated endpoint — great for inserting code at a known location without
 * rewriting the whole file.
 *
 * FIM is a Mistral-cloud capability: the OpenAI-compatible LM Studio server has
 * no `/fim/completions` route, so this refuses the local provider.
 *
 * @param {Object}   opts
 * @param {string}   opts.prompt        Code before the insertion point.
 * @param {string}   [opts.suffix]      Code after the insertion point.
 * @param {Function} [opts.onToken]     If given (and stream !== false), streams deltas.
 * @param {string[]} [opts.stop]        Optional stop sequences.
 * @returns {Promise<{content:string, usage:Object|null}>}
 */
async function fimComplete({ prompt, suffix, settings, apiKey, signal, onToken, stream, stop, maxTokens, temperature }) {
  const prov = providerConfig(settings);
  if (prov.provider !== 'mistral') throw apiError('Дополнение кода (FIM) доступно только с облачной моделью Codestral X_X', 'unsupported');
  if (!apiKey) throw apiError('No API key configured. Add one in Settings pls X_X', 'auth');
  if (prompt == null) throw apiError('fimComplete requires "prompt".', 'bad_request');

  // FIM only works on the Codestral family. Honour the user's model if it is a
  // Codestral variant, else fall back to the latest Codestral.
  const selected = (settings && typeof settings.model === 'string') ? settings.model.trim() : '';
  const model = /codestral/i.test(selected) ? selected : 'codestral-latest';

  const doStream = stream !== false && typeof onToken === 'function';
  const body = { model, prompt: String(prompt), stream: doStream };
  if (suffix != null) body.suffix = String(suffix);
  const mt = parseInt(maxTokens, 10);
  if (Number.isFinite(mt) && mt > 0) body.max_tokens = mt;
  const temp = parseFloat(temperature);
  if (Number.isFinite(temp)) body.temperature = clampNum(temp, 0, 1.5, 0.2);
  if (Array.isArray(stop) && stop.length) body.stop = stop;

  const { res, watch } = await requestWithRetries({
    endpoint: prov.endpoint, path: '/fim/completions', apiKey, body, signal, stream: doStream, isLocal: false,
    gate: gateConfigFromSettings(settings)
  });
  watch.ready();

  if (!doStream) {
    watch.stop();
    const data = await res.json();
    const choice = data?.choices?.[0] || {};
    const content = contentToText(choice.message?.content ?? choice.text ?? '');
    return { content, usage: data?.usage || null };
  }
  // Streaming FIM frames carry the same `choices[].delta.content` shape as chat,
  // so the shared SSE parser handles them (there are never tool calls here).
  const r = await parseSSE(res, onToken, watch);
  return { content: r.content, usage: r.usage };
}

/** List available models (used by Settings to validate/refresh). */
async function listModels({ settings, apiKey }) {
  const prov = providerConfig(settings);
  if (prov.requiresKey && !apiKey) throw apiError('No API key configured.', 'auth');
  let res;
  try {
    res = await fetch(url(prov.endpoint, '/models'), { headers: authHeaders(apiKey) });
  } catch (e) {
    throw apiError(`Network error: ${e.message}`, 'network');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw errorForStatus(res.status, text);
  }
  const data = await res.json();
  const ids = Array.isArray(data?.data) ? data.data.map((m) => m.id) : [];
  if (ids.length) return ids;
  // LM Studio shows exactly what's currently loaded — no static fallback there;
  // an empty list means "no model loaded". Mistral keeps its known catalogue.
  return prov.provider === 'lmstudio' ? [] : SUPPORTED_MODELS;
}

/**
 * Ping the API and measure latency.
 * @returns {Promise<{ok:true, latency:number}>}
 */
async function testConnection({ settings, apiKey }) {
  const prov = providerConfig(settings);
  if (prov.requiresKey && !apiKey) throw apiError('No API key configured.', 'auth');
  const endpoint = prov.endpoint;
  const started = Date.now();

  // 8s timeout so a dead endpoint doesn't hang the UI.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url(endpoint, '/models'), {
      headers: authHeaders(apiKey),
      signal: controller.signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw errorForStatus(res.status, text);
    }
    return { ok: true, latency: Date.now() - started };
  } catch (e) {
    if (e.name === 'AbortError') throw apiError('Connection timed out.', 'timeout');
    if (e.code) throw e;
    throw apiError(`Network error: ${e.message}`, 'network');
  } finally {
    clearTimeout(timer);
  }
}

/** Clamp a numeric setting, falling back to a default when unparseable. */
function clampNum(value, min, max, fallback) {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

module.exports = {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  LMSTUDIO_ENDPOINT,
  SUPPORTED_MODELS,
  providerConfig,
  sendMessage,
  sendStructured,
  fimComplete,
  listModels,
  testConnection
};
