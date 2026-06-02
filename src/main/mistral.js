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
async function sendMessage({ messages, settings, apiKey, onToken, signal, tools, onRetry }) {
  if (!apiKey) throw apiError('No API key configured. Add one in Settings.', 'auth');

  const endpoint = settings.endpoint || DEFAULT_ENDPOINT;
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

  // On a rate limit (429) we don't fail the turn — we wait the time the API
  // tells us to (or back off) and retry, so the conversation keeps going
  // instead of being rolled back. Nothing has streamed yet at this point (the
  // error is raised before the body is read), so a retry is clean.
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url(endpoint, '/chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: stream ? 'text/event-stream' : 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal
      });
    } catch (e) {
      if (e.name === 'AbortError') throw apiError('Generation stopped.', 'aborted');
      throw apiError(`Network error: ${e.message}`, 'network');
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = errorForStatus(res.status, text, res.headers);
      if (err.code === 'rate_limit' && attempt < MAX_RATE_LIMIT_RETRIES && !signal?.aborted) {
        const waitMs = backoffMs(err.retryAfterMs, attempt + 1);
        if (onRetry) onRetry({ attempt: attempt + 1, maxRetries: MAX_RATE_LIMIT_RETRIES, waitMs, rateLimit: err.rateLimit });
        await abortableDelay(waitMs, signal); // throws 'aborted' if the user stops
        continue;
      }
      throw err;
    }

    // Non-streaming path: parse a single JSON payload.
    if (!stream) {
      const data = await res.json();
      const msg = data?.choices?.[0]?.message || {};
      const content = contentToText(msg.content);
      if (onToken && content) onToken(content);
      const toolCalls = (msg.tool_calls || []).map((tc, i) => parseToolCall(tc.id || `call_${i}`, tc.function?.name, tc.function?.arguments));
      const rateLimit = extractRateLimitInfo(res.headers);
      return { content, toolCalls, usage: data?.usage || null, rateLimit };
    }

    // Streaming path: parse SSE frames as they arrive.
    return await parseSSE(res, onToken);
  }
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
async function parseSSE(res, onToken) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let full = '';
  let usage = null;
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
            const piece = contentToText(delta?.content);
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
      // Caller treats a partial result as success — return what we have.
      const rateLimit = extractRateLimitInfo(res.headers);
      return { content: full, toolCalls: finalize(), usage, aborted: true, rateLimit };
    }
    throw apiError(`Stream error: ${e.message}`, 'network');
  }

  const rateLimit = extractRateLimitInfo(res.headers);
  return { content: full, toolCalls: finalize(), usage, rateLimit };
}

/** List available models (used by Settings to validate/refresh). */
async function listModels({ settings, apiKey }) {
  if (!apiKey) throw apiError('No API key configured.', 'auth');
  const endpoint = settings.endpoint || DEFAULT_ENDPOINT;
  let res;
  try {
    res = await fetch(url(endpoint, '/models'), {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
  } catch (e) {
    throw apiError(`Network error: ${e.message}`, 'network');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw errorForStatus(res.status, text);
  }
  const data = await res.json();
  const ids = Array.isArray(data?.data) ? data.data.map((m) => m.id) : [];
  return ids.length ? ids : SUPPORTED_MODELS;
}

/**
 * Ping the API and measure latency.
 * @returns {Promise<{ok:true, latency:number}>}
 */
async function testConnection({ settings, apiKey }) {
  if (!apiKey) throw apiError('No API key configured.', 'auth');
  const endpoint = settings.endpoint || DEFAULT_ENDPOINT;
  const started = Date.now();

  // 8s timeout so a dead endpoint doesn't hang the UI.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url(endpoint, '/models'), {
      headers: { Authorization: `Bearer ${apiKey}` },
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
  SUPPORTED_MODELS,
  sendMessage,
  listModels,
  testConnection
};
