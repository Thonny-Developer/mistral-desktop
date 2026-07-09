'use strict';

/**
 * Agent tool layer (main process).
 *
 * Each tool takes a parsed action object + a `ctx` ({ store, getWindow,
 * appendMemory }) and returns a uniform result:
 *   { ok, summary, output, error?, todosChanged?, workspaceChanged? }
 *     - summary : short human string for the chat UI
 *     - output  : text fed back to the model as the tool result
 *
 * All filesystem access is sandboxed to the user's chosen working folder;
 * paths that escape it are rejected.
 */

const { dialog } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { exec: execCommand } = require('child_process');
const skills = require('./skills');
const extract = require('./extract');
const fileSearch = require('./fileSearch');

const MAX_READ_CHARS = 40_000; // guard against a pathological file (e.g. minified single line)
const MAX_EXTRACT_CHARS = 40_000; // extracted document text is the payload, so allow more
const IGNORE = new Set(['node_modules', '.git', '.DS_Store']);

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** Resolve a relative path inside the working folder, or throw. */
function resolveInWork(ctx, rel) {
  const work = ctx.store.get('workingDir');
  if (!work) throw new Error('No working folder set — call set_working_folder first.');
  const root = path.resolve(work);
  const abs = path.resolve(root, rel || '.');
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('Path escapes the working folder.');
  }
  return abs;
}

/* ---------------- filesystem tools ---------------- */
async function pickFolder(ctx) {
  const win = ctx.getWindow();
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a working folder',
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths[0]) {
    return { ok: false, summary: 'folder selection cancelled', output: 'User cancelled folder selection.' };
  }
  ctx.store.set('workingDir', res.filePaths[0]);
  return {
    ok: true,
    summary: `working folder set · ${res.filePaths[0]}`,
    output: `OK: working folder is now ${res.filePaths[0]}`,
    workspaceChanged: true
  };
}

async function listFiles(a, ctx) {
  // Glob mode: recursive listing of files matching a pattern (e.g. "**/*.js").
  if (a.glob) {
    const files = await fileSearch.globFiles({ pattern: a.glob, path: a.path || '.' }, ctx.store.get('workingDir'));
    const truncated = files.length > 300;
    const shown = truncated ? files.slice(0, 300) : files;
    const note = truncated ? `\n…(${files.length} files matched — showing first 300; narrow the glob)` : '';
    return {
      ok: true,
      summary: `glob ${a.glob} · ${files.length} file(s)`,
      output: (shown.join('\n') || `(no files match ${a.glob})`) + note
    };
  }
  // Directory mode: one level of entries.
  const abs = resolveInWork(ctx, a.path || '.');
  const entries = (await fsp.readdir(abs, { withFileTypes: true }))
    .filter((e) => !IGNORE.has(e.name))
    .sort((x, y) => (x.isDirectory() === y.isDirectory() ? x.name.localeCompare(y.name) : x.isDirectory() ? -1 : 1));
  const lines = entries.map((e) => (e.isDirectory() ? `[dir]  ${e.name}/` : `       ${e.name}`));
  return {
    ok: true,
    summary: `listed ${entries.length} item(s) in ${a.path || '.'}`,
    output: lines.join('\n') || '(empty folder)'
  };
}

// Grep across the workspace: find where something is before reading it, so the
// agent pulls in only the lines it needs instead of whole files.
async function searchFiles(a, ctx) {
  if (!a.pattern) throw new Error('search_files requires "pattern".');
  const { matches, truncated } = await fileSearch.searchFiles(a, ctx.store.get('workingDir'));
  if (!matches.length) {
    return { ok: true, summary: `поиск · ${a.pattern} (0)`, output: `Совпадений по /${a.pattern}/ не найдено. Попробуйте другой паттерн, path или glob.` };
  }
  const body = matches.map((m) => {
    const c = m.content.length > 300 ? m.content.slice(0, 300) + '…' : m.content;
    return `${m.file}:${m.line}: ${c.trimEnd()}`;
  }).join('\n');
  const note = truncated
    ? `\n…(результатов больше ${matches.length} — вывод обрезан; уточните паттерн, чтобы сузить поиск.)`
    : '';
  return {
    ok: true,
    summary: `поиск · ${a.pattern} (${matches.length}${truncated ? '+' : ''})`,
    output: body + note
  };
}

async function readFile(a, ctx) {
  if (!a.path) throw new Error('read_file requires "path".');
  const abs = resolveInWork(ctx, a.path);
  // Documents (PDF/DOCX/PPTX/…) and binaries are not UTF-8 text — reading them
  // raw would dump garbage into the context. Route them through extract_file so
  // only the pulled-out text enters the window.
  if (extract.isBinaryDoc(abs)) {
    return extractFile(a, ctx);
  }
  // Line-numbered, range-aware read: small files come back whole, large ones are
  // head/tail-trimmed unless offset/limit is given — so the model reads targeted
  // ranges (after search_files) instead of flooding context with whole files.
  const r = await fileSearch.readFileRanged(a, ctx.store.get('workingDir'));
  let out = r.text || '(empty file)';
  if (out.length > MAX_READ_CHARS) out = out.slice(0, MAX_READ_CHARS) + '\n…(truncated — use offset/limit to read the rest)';
  const range = r.shownFrom
    ? ` [строки ${r.shownFrom}-${r.shownTo}/${r.total}]`
    : ` (${r.total} строк${r.truncated ? ', обрезан' : ''})`;
  return { ok: true, summary: `read ${a.path}${range}`, output: out };
}

// Pull plain text out of a document/binary (PDF, DOCX, PPTX, XLSX, ODF, EPUB,
// ZIP). Only the extracted text — never the raw bytes — enters the context.
// For formats without a built-in extractor, the agent is told to write its own
// (a small script via a console) and feed back only what it extracted.
async function extractFile(a, ctx) {
  if (!a.path) throw new Error('extract_file requires "path".');
  const abs = resolveInWork(ctx, a.path);
  if (!fs.existsSync(abs)) {
    return { ok: false, summary: `not found: ${a.path}`, output: `Error: ${a.path} does not exist.` };
  }
  const r = extract.extractFile(abs);
  if (!r.ok) {
    return {
      ok: false,
      summary: `Нет извлекателя для .${r.ext} · ${a.path}`,
      output: `Не удалось извлечь "${a.path}" (${r.error}). Для этого формата нет встроенного метода. ` +
        `Напишите свой извлекатель: откройте консоль (console_open) и небольшим скриптом (например на Python/Node, ` +
        `используя то, что есть в системе) превратите файл в обычный текст, выведите ТОЛЬКО извлечённый текст и работайте с ним. ` +
        `Не загружайте в контекст сырые байты файла.`
    };
  }
  const text = r.text || '';
  if (!text.trim()) {
    return {
      ok: true,
      summary: `Извлечено пусто · ${a.path}`,
      output: `Файл "${a.path}" (.${r.ext}) разобран, но текста в нём не нашлось ` +
        `(возможно, это сканы/изображения или нестандартная структура). Если нужен текст — извлеките его другим способом.`
    };
  }
  const out = text.length > MAX_EXTRACT_CHARS
    ? text.slice(0, MAX_EXTRACT_CHARS) + '\n…(извлечённый текст обрезан)'
    : text;
  return {
    ok: true,
    summary: `Извлёк текст из ${a.path} (.${r.ext}, ${text.length} симв.)`,
    output: out
  };
}

async function writeFile(a, ctx) {
  if (!a.path) throw new Error('write_file requires "path".');
  const abs = resolveInWork(ctx, a.path);
  const existed = fs.existsSync(abs);
  let oldText = '';
  if (existed) {
    try { oldText = await fsp.readFile(abs, 'utf-8'); } catch {}
  }
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, a.content ?? '', 'utf-8');
  const newText = a.content ?? '';
  const oldLines = oldText.split(/\r?\n/).length;
  const newLines = newText.split(/\r?\n/).length;
  const added = Math.max(0, newLines - oldLines);
  const removed = Math.max(0, oldLines - newLines);
  if (!existed) {
    return {
      ok: true,
      summary: `Создал файл ${a.path}`,
      output: `Создал файл ${a.path}`
    };
  }
  return {
    ok: true,
    summary: `Редактирование файла ${a.path} +${added} -${removed}`,
    output: `Редактирование файла ${a.path} +${added} -${removed}`
  };
}

// Targeted edit: replace an exact snippet. Safer than write_file because it
// can only touch the matched region and refuses ambiguous/missing matches —
// this is what keeps edits predictable and prevents whole-file clobbering.
async function editFile(a, ctx) {
  if (!a.path) throw new Error('edit_file requires "path".');
  if (a.old_string == null) throw new Error('edit_file requires "old_string".');
  const abs = resolveInWork(ctx, a.path);
  if (!fs.existsSync(abs)) {
    return { ok: false, summary: `not found: ${a.path}`, output: `Error: ${a.path} does not exist. Use write_file to create it.` };
  }
  const text = await fsp.readFile(abs, 'utf-8');
  const oldStr = String(a.old_string);
  const newStr = a.new_string == null ? '' : String(a.new_string);
  const occurrences = oldStr ? text.split(oldStr).length - 1 : 0;
  if (occurrences === 0) {
    return { ok: false, summary: `Фрагмент не найден в ${a.path}`, output: `Error: old_string не найден в ${a.path}. Прочитайте файл (read_file) и используйте точный, дословный фрагмент.` };
  }
  if (occurrences > 1 && !a.replace_all) {
    return { ok: false, summary: `Неоднозначная замена в ${a.path} (${occurrences})`, output: `Error: old_string встречается ${occurrences} раз. Добавьте контекст, чтобы сделать его уникальным, или передайте replace_all: true.` };
  }
  const next = a.replace_all ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr);
  await fsp.writeFile(abs, next, 'utf-8');
  const delta = next.split(/\r?\n/).length - text.split(/\r?\n/).length;
  const sign = delta > 0 ? `+${delta}` : `${delta}`;
  return {
    ok: true,
    summary: `Редактирование ${a.path} (${occurrences > 1 ? occurrences + '×, ' : ''}${sign} строк)`,
    output: `OK: отредактирован ${a.path} (заменено ${occurrences > 1 && a.replace_all ? occurrences : 1})`,
    workspaceChanged: true
  };
}

async function deleteFile(a, ctx) {
  if (!a.path) throw new Error('delete_file requires "path".');
  const abs = resolveInWork(ctx, a.path);
  if (!fs.existsSync(abs)) return { ok: false, summary: `not found: ${a.path}`, output: `Error: ${a.path} does not exist.` };
  await fsp.rm(abs, { recursive: true, force: true });
  return { ok: true, summary: `Удалил файл ${a.path}`, output: `Удалил файл ${a.path}`, workspaceChanged: true };
}

/* ---------------- todo tools ---------------- */
function addTodo(a, ctx) {
  if (!a.text) throw new Error('add_todo requires "text".');
  const todos = ctx.store.get('todos') || [];
  const item = { id: uid(), text: String(a.text), done: false, createdAt: Date.now() };
  todos.push(item);
  ctx.store.set('todos', todos);
  return { ok: true, summary: `todo added · ${item.text}`, output: `OK: added todo ${item.id} — "${item.text}"`, todosChanged: true };
}

function completeTodo(a, ctx) {
  const todos = ctx.store.get('todos') || [];
  const t = todos.find((x) => x.id === a.id || x.text === a.text);
  if (!t) return { ok: false, summary: 'todo not found', output: 'Error: no matching todo.' };
  t.done = true;
  ctx.store.set('todos', todos);
  return { ok: true, summary: `todo done · ${t.text}`, output: `OK: completed "${t.text}"`, todosChanged: true };
}

function listTodos(ctx) {
  const todos = ctx.store.get('todos') || [];
  const out = todos.length
    ? todos.map((t) => `[${t.done ? 'x' : ' '}] (${t.id}) ${t.text}`).join('\n')
    : '(no todos)';
  return { ok: true, summary: `${todos.length} todo(s)`, output: out };
}

/* ---------------- memory tool ---------------- */
function remember(a, ctx) {
  if (!a.text) throw new Error('remember requires "text".');
  ctx.appendMemory([String(a.text)]);
  return { ok: true, summary: `remembered · ${a.text}`, output: 'OK: saved to long-term memory.' };
}

/* ---------------- bash tool ---------------- */
// Async so the command runs off the main thread — the UI stays responsive and
// the Stop button can kill a long-running command via ctx.signal.
function execBash(a, ctx) {
  if (!a.command) throw new Error('exec_bash requires "command".');
  const workDir = ctx.store.get('workingDir');
  if (!workDir) throw new Error('No working folder set — call set_working_folder first.');

  const label = a.command.slice(0, 50);
  return new Promise((resolve) => {
    execCommand(a.command, {
      cwd: workDir,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024, // 10 MB buffer
      timeout: 30000, // 30 sec timeout
      signal: ctx.signal // killed if the user stops generation
    }, (err, stdout, stderr) => {
      const out = (stdout || '') + (stderr ? `\n${stderr}` : '');
      if (err) {
        if (err.code === 'ABORT_ERR' || err.name === 'AbortError') {
          resolve({ ok: false, summary: `Команда прервана · ${label}`, error: 'aborted', output: 'Выполнение прервано пользователем.' });
          return;
        }
        const detail = (stderr || err.message || '').trim();
        resolve({
          ok: false,
          summary: `Ошибка bash · ${label}`,
          error: detail,
          output: `Ошибка: ${detail}${stdout ? `\n${stdout}` : ''}`
        });
        return;
      }
      resolve({
        ok: true,
        summary: `Выполнил bash · ${label}`,
        output: out.trim() || '(no output)',
        workspaceChanged: true
      });
    });
  });
}

/* ---------------- console (persistent shell) tools ---------------- */
function consoleOpen(a, ctx) {
  if (!ctx.consoles) throw new Error('Console manager unavailable.');
  const work = ctx.store.get('workingDir');
  if (!work) throw new Error('No working folder set — call set_working_folder first.');
  const cwd = a.cwd ? resolveInWork(ctx, a.cwd) : work;
  const s = ctx.consoles.open(cwd);
  return {
    ok: true,
    summary: `Открыл консоль ${s.id}`,
    output: `OK: открыта консоль ${s.id} (${cwd}). Запускайте команды через console_exec с id "${s.id}"; рабочая папка и окружение сохраняются между командами.`
  };
}

async function consoleExec(a, ctx) {
  if (!ctx.consoles) throw new Error('Console manager unavailable.');
  if (!a.id) throw new Error('console_exec requires "id".');
  if (!a.command) throw new Error('console_exec requires "command".');
  const label = String(a.command).slice(0, 40);
  const r = await ctx.consoles.exec(a.id, a.command, { signal: ctx.signal });
  if (r.error === 'not_found' || r.error === 'dead') {
    return { ok: false, summary: `Консоль ${a.id} недоступна`, output: r.output };
  }
  if (r.aborted) {
    return { ok: false, summary: `Прервано · ${a.id}`, error: 'aborted', output: `${r.output || ''}\n[прервано пользователем]`.trim() };
  }
  const note = r.timedOut
    ? '\n[превышено время ожидания — команда могла остаться запущенной. Долгие процессы (серверы) запускайте в фоне через "&".]'
    : '';
  const code = r.code == null ? '?' : r.code;
  const ok = !r.timedOut && (r.code == null || r.code === 0);
  return {
    ok,
    summary: `${a.id} · ${label} (exit ${code})`,
    output: (r.output || '(нет вывода)') + note,
    workspaceChanged: true
  };
}

function consoleClose(a, ctx) {
  if (!ctx.consoles) throw new Error('Console manager unavailable.');
  if (!a.id) throw new Error('console_close requires "id".');
  const closed = ctx.consoles.close(a.id);
  return {
    ok: closed,
    summary: closed ? `Закрыл консоль ${a.id}` : `Консоль ${a.id} не найдена`,
    output: closed ? `OK: консоль ${a.id} закрыта.` : `Консоль ${a.id} не найдена.`
  };
}

function consoleList(ctx) {
  if (!ctx.consoles) throw new Error('Console manager unavailable.');
  const items = ctx.consoles.list();
  const out = items.length
    ? items.map((s) => `${s.id} — ${s.alive ? 'активна' : 'закрыта'}${s.cwd ? ` · ${s.cwd}` : ''}`).join('\n')
    : '(нет открытых консолей)';
  return { ok: true, summary: `Консолей: ${items.length}`, output: out };
}

/* ---------------- web tools ---------------- */
const MAX_FETCH_BYTES = 30_000; // keep page text from blowing the context window
const UA = 'Mozilla/5.0 (Mist Desktop; +agent)';

function hostOf(u) { try { return new URL(u).host; } catch { return u; } }

/** Strip HTML down to readable text. */
function htmlToText(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n')
    .trim();
}

/** Decode DuckDuckGo's redirect wrapper (…/l/?uddg=<encoded real url>). */
function decodeDdgUrl(href) {
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (m) { try { return decodeURIComponent(m[1]); } catch { /* fallthrough */ } }
  return href.startsWith('//') ? `https:${href}` : href;
}

async function webSearch(a, ctx) {
  if (!a.query) throw new Error('web_search requires "query".');
  const q = encodeURIComponent(String(a.query));
  let res;
  try {
    res = await fetch(`https://html.duckduckgo.com/html/?q=${q}`, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: ctx.signal
    });
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, summary: 'поиск прерван', error: 'aborted', output: 'Прервано пользователем.' };
    return { ok: false, summary: `Ошибка поиска · ${a.query}`, error: e.message, output: `Ошибка сети: ${e.message}` };
  }
  if (!res.ok) return { ok: false, summary: `Поиск: HTTP ${res.status}`, output: `Error: поисковик ответил HTTP ${res.status}.` };
  const html = await res.text();
  const titles = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((x) => ({ url: decodeDdgUrl(x[1]), title: htmlToText(x[2]) }));
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)].map((x) => htmlToText(x[1]));
  const results = titles.slice(0, 8).map((t, i) => ({ ...t, snippet: snippets[i] || '' }));
  if (!results.length) {
    return { ok: true, summary: `Поиск · ${a.query} (0)`, output: 'Ничего не найдено. Уточните запрос или попробуйте web_fetch конкретного URL.' };
  }
  const out = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`).join('\n\n');
  return { ok: true, summary: `Поиск · ${a.query} (${results.length})`, output: out };
}

async function webFetch(a, ctx) {
  if (!a.url) throw new Error('web_fetch requires "url".');
  let url = String(a.url).trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA }, signal: ctx.signal });
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, summary: 'запрос прерван', error: 'aborted', output: 'Прервано пользователем.' };
    return { ok: false, summary: `Ошибка сети · ${hostOf(url)}`, error: e.message, output: `Ошибка: ${e.message}` };
  }
  if (!res.ok) return { ok: false, summary: `HTTP ${res.status} · ${hostOf(url)}`, output: `Error: ${url} ответил HTTP ${res.status}.` };
  const ctype = res.headers.get('content-type') || '';
  const raw = await res.text();
  const text = /html|xml/i.test(ctype) ? htmlToText(raw) : raw;
  const out = text.length > MAX_FETCH_BYTES ? `${text.slice(0, MAX_FETCH_BYTES)}\n…(truncated)` : text;
  return { ok: true, summary: `Загрузил ${hostOf(url)} (${text.length} симв.)`, output: out || '(пустая страница)' };
}

/* ---------------- skill tools ---------------- */
// Skills are user-extensible Markdown playbooks. list_skills lets the model
// discover them; run_skill returns the rendered playbook text for the model to
// follow next (its actions still go through the normal tool gates).
function listSkillsTool(_a, ctx) {
  const work = ctx.store.get('workingDir') || '';
  const items = skills.listSkills(work);
  const out = items.length
    ? items.map((s) => `/${s.name} — ${s.description || '(no description)'}${s.argumentHint ? ` · ${s.argumentHint}` : ''}`).join('\n')
    : '(нет доступных скиллов)';
  return { ok: true, summary: `Скиллов: ${items.length}`, output: out };
}

function createSkillTool(a) {
  if (!a.name) throw new Error('create_skill requires "name".');
  if (!a.body) throw new Error('create_skill requires "body".');
  const r = skills.saveSkill({
    name: a.name,
    description: a.description || '',
    allowedTools: a.allowed_tools || a.allowedTools || null,
    argumentHint: a.argument_hint || a.argumentHint || '',
    body: a.body
  });
  return {
    ok: true,
    summary: `Создан скилл /${r.name}`,
    output: `OK: skill "/${r.name}" saved to ${r.path}. It is now available as a slash command and via run_skill.`
  };
}

function runSkillTool(a, ctx) {
  if (!a.name) throw new Error('run_skill requires "name".');
  const work = ctx.store.get('workingDir') || '';
  const r = skills.renderSkill(a.name, a.arguments || '', work);
  if (!r) {
    return { ok: false, summary: `Скилл не найден: ${a.name}`, output: `Error: skill "${a.name}" not found. Call list_skills to see available skills.` };
  }
  const note = r.allowedTools ? `\n\n(Skill's recommended tools: ${r.allowedTools.join(', ')}.)` : '';
  return {
    ok: true,
    summary: `Скилл · ${r.name}`,
    output: `Follow this skill playbook now, then continue the task:\n\n${r.prompt}${note}`
  };
}

/* ---------------- subagent tool ---------------- */
// Spawns an isolated worker with its own context and a restricted toolset.
// Lazy-require of ./agent avoids the tools<->agent circular dependency.
async function runSubagentTool(a, ctx) {
  if (!a.task) throw new Error('run_subagent requires "task".');
  const agent = require('./agent');
  const depth = ctx.subagentDepth || 0;
  if (depth >= agent.SUBAGENT_MAX_DEPTH) {
    return { ok: false, summary: 'предел вложенности субагентов', output: 'Error: subagent nesting limit reached — do this work directly instead.' };
  }
  // In Default mode a subagent must stay read-only (its inner actions run
  // without per-step confirmation, so we never let it mutate the workspace
  // unless the user has chosen a more permissive mode).
  const parentMode = (ctx.settings && ctx.settings.aiPermissionMode) || 'default';
  const mode = (a.mode === 'write' && parentMode !== 'default') ? 'write' : 'read';

  const r = await agent.runSubagent({
    task: String(a.task),
    focus: a.context ? String(a.context) : '',
    mode,
    settings: ctx.settings,
    apiKey: ctx.apiKey,
    signal: ctx.signal,
    emit: ctx.emit,
    ctx,
    depth: depth + 1
  });
  if (r.aborted) return { ok: false, summary: 'субагент прерван', error: 'aborted', output: r.text || 'Прервано пользователем.' };
  return { ok: true, summary: `Субагент завершил · ${String(a.task).slice(0, 40)}`, output: r.text || '(субагент не вернул отчёт)' };
}

/* ==================================================================== *
 *  Tool registry
 *
 *  Each tool is described exactly once — its schema, its permission
 *  metadata and its implementation. Everything else is derived from this
 *  table: the function-calling schemas sent to the model, the permission
 *  gates the agent loop applies, the tool-discovery list shown in the UI,
 *  and the read-only subset a subagent is allowed to use.
 *
 *  This replaces the old hand-maintained switch + parallel schema array,
 *  so a tool can never drift between "registered", "described" and
 *  "gated" — they all come from one source.
 * ------------------------------------------------------------------------ */
const str = (description) => ({ type: 'string', description });
const bool = (description) => ({ type: 'boolean', description });
const int = (description) => ({ type: 'integer', description });

/**
 * @typedef {Object} ToolDef
 * @property {string}   name
 * @property {string}   description       Sent to the model AND shown as `prompt()`.
 * @property {Object}   [parameters]      JSON-schema `properties` map.
 * @property {string[]} [required]
 * @property {'fs'|'shell'|'web'|'todo'|'memory'|'agent'} group
 * @property {boolean}  [readOnly]        No side effects → never needs confirmation.
 * @property {boolean}  [mutating]        Changes files/system → planned + gated in default mode.
 * @property {boolean}  [destructive]     Can irreversibly lose data.
 * @property {boolean}  [shell]           Runs an arbitrary shell command.
 * @property {boolean}  [web]             Reaches the network.
 * @property {boolean}  [concurrencySafe] Safe to run in parallel (default true).
 * @property {boolean}  [defer]           Excluded from the default schema set (lazy/loaded on demand).
 * @property {(action, ctx) => any} run
 */

/** @type {ToolDef[]} */
const DEFS = [
  { name: 'set_working_folder', group: 'fs', concurrencySafe: false,
    description: 'Open a dialog asking the user to pick the project folder to work in. If you start a file or shell action without a folder set, the app prompts for it automatically — so you only need this to set or change the folder explicitly.',
    run: (_a, ctx) => pickFolder(ctx) },

  { name: 'list_files', group: 'fs', readOnly: true, needsWork: true,
    description: 'List the workspace. Without "glob" it lists one directory level; with a glob (e.g. "**/*.js") it returns a recursive list of files matching the pattern. Ignores node_modules/.git/dist/build and respects .gitignore.',
    parameters: {
      path: str('Relative path; defaults to the folder root.'),
      glob: str('Optional glob for a recursive file listing (e.g. "**/*.js", "src/**/*.ts").')
    },
    run: listFiles },

  { name: 'search_files', group: 'fs', readOnly: true, needsWork: true,
    description: 'Grep file contents by regular expression across the working folder (ripgrep under the hood). Returns matching "file:line: content". Use this FIRST to locate the relevant code, then read only that range with read_file — do not read whole files to find something. Ignores node_modules/.git/dist/build.',
    parameters: {
      pattern: str('Regular expression to search for.'),
      path: str('Sub-directory to search in (relative to the working folder). Defaults to the whole folder.'),
      glob: str('Optional file filter, e.g. "*.ts" or "src/**/*.js".'),
      case_sensitive: bool('Match case exactly. Default false (case-insensitive).')
    }, required: ['pattern'],
    run: searchFiles },

  { name: 'read_file', group: 'fs', readOnly: true, needsWork: true,
    description: 'Read a text file, with line numbers. Files under 300 lines come back whole; larger files return the first 150 + last 50 lines unless you pass offset/limit. Prefer search_files first to find the exact lines, then read just that window with offset/limit — do not read a large file in full unless you truly need all of it. Always read a file before editing it. For documents (PDF, DOCX, PPTX, XLSX, …) it auto-extracts the text instead of raw bytes.',
    parameters: {
      path: str('Relative path to the file.'),
      offset: int('Line number to start reading from (1-based).'),
      limit: int('How many lines to read from offset (default 200).')
    }, required: ['path'],
    run: readFile },

  { name: 'extract_file', group: 'fs', readOnly: true, needsWork: true,
    description: 'Extract plain text from a document or binary file (PDF, DOCX, PPTX, XLSX, ODT/ODP/ODS, EPUB, ZIP). Only the extracted text enters the context, never the raw bytes. If a format has no built-in extractor it tells you so — then write your own extractor (a small script in a console) and feed back only the extracted text.',
    parameters: { path: str('Relative path to the document.') }, required: ['path'],
    run: extractFile },

  { name: 'write_file', group: 'fs', mutating: true, concurrencySafe: false, needsWork: true,
    description: 'Create a new file or fully overwrite an existing one. Provide the COMPLETE file content. Prefer edit_file for changing part of an existing file.',
    parameters: { path: str('Relative path.'), content: str('Full file content.') }, required: ['path', 'content'],
    run: writeFile },

  { name: 'edit_file', group: 'fs', mutating: true, concurrencySafe: false, needsWork: true,
    description: 'Replace an exact snippet in an existing file. old_string must match the file exactly and be unique (add surrounding context to disambiguate), or set replace_all to replace every occurrence. Preferred way to change existing files.',
    parameters: {
      path: str('Relative path.'),
      old_string: str('Exact text to find (verbatim, including whitespace).'),
      new_string: str('Replacement text. Empty string deletes the snippet.'),
      replace_all: bool('Replace every occurrence instead of requiring a unique match.')
    }, required: ['path', 'old_string', 'new_string'],
    run: editFile },

  { name: 'delete_file', group: 'fs', mutating: true, destructive: true, concurrencySafe: false, needsWork: true,
    description: 'Delete a file or folder.',
    parameters: { path: str('Relative path.') }, required: ['path'],
    run: deleteFile },

  { name: 'add_todo', group: 'todo',
    description: 'Add a concrete, verifiable step to the plan.',
    parameters: { text: str('What the step does.') }, required: ['text'],
    run: addTodo },

  { name: 'complete_todo', group: 'todo',
    description: 'Mark a todo done.',
    parameters: { id: str('Todo id from list_todos.'), text: str('Or match by text.') },
    run: completeTodo },

  { name: 'list_todos', group: 'todo', readOnly: true,
    description: 'List the current todos with their ids and status.',
    run: (_a, ctx) => listTodos(ctx) },

  { name: 'remember', group: 'memory',
    description: 'Save a durable fact about the user or project to long-term memory.',
    parameters: { text: str('The fact to remember.') }, required: ['text'],
    run: remember },

  { name: 'exec_bash', group: 'shell', shell: true, mutating: true, concurrencySafe: false, needsWork: true,
    description: 'Run a single, one-shot shell command inside the working folder. Each call is a fresh process (no state carries over). For several related commands or anything needing state, use a console instead.',
    parameters: { command: str('The shell command.') }, required: ['command'],
    run: execBash },

  { name: 'console_open', group: 'shell', concurrencySafe: false, needsWork: true,
    description: 'Open a persistent shell session (console) in the working folder. The working directory and environment persist across commands run in it. Returns a console id.',
    parameters: { cwd: str('Optional starting sub-folder (relative to the working folder).') },
    run: consoleOpen },

  { name: 'console_exec', group: 'shell', shell: true, mutating: true, concurrencySafe: false, needsWork: true,
    description: 'Run a command in an open console. State (cwd, env, etc.) carries over between commands. Run long-running processes in the background with "&".',
    parameters: { id: str('Console id from console_open.'), command: str('The shell command.') }, required: ['id', 'command'],
    run: consoleExec },

  { name: 'console_close', group: 'shell',
    description: 'Close a console you no longer need.',
    parameters: { id: str('Console id.') }, required: ['id'],
    run: consoleClose },

  { name: 'console_list', group: 'shell', readOnly: true,
    description: 'List the currently open consoles and their state.',
    run: (_a, ctx) => consoleList(ctx) },

  { name: 'web_search', group: 'web', web: true,
    description: 'Search the web and get a list of result titles, URLs and snippets. Use it to find sources, then web_fetch the most relevant URL to read it.',
    parameters: { query: str('Search query.') }, required: ['query'],
    run: webSearch },

  { name: 'web_fetch', group: 'web', web: true,
    description: 'Fetch a web page (or text resource) and return its readable text content. Use after web_search, or directly when you already know the URL.',
    parameters: { url: str('Absolute URL to fetch.') }, required: ['url'],
    run: webFetch },

  { name: 'list_skills', group: 'agent', readOnly: true,
    description: 'List the available skills (reusable Markdown playbooks) with their descriptions, so you can pick one to follow.',
    run: listSkillsTool },

  { name: 'run_skill', group: 'agent',
    description: 'Load a skill playbook by name and follow its instructions. Use it when a task matches an available skill (see list_skills). The returned text is the playbook you should then execute.',
    parameters: { name: str('Skill name (without the leading slash).'), arguments: str('Optional arguments / focus for the skill.') }, required: ['name'],
    run: runSkillTool },

  { name: 'create_skill', group: 'agent',
    description: 'Create (or overwrite) a reusable skill — a Markdown playbook saved to the user skills folder, immediately available as a slash command. Use it when asked to make a new skill.',
    parameters: {
      name: str('Short kebab-case skill name (no leading slash).'),
      description: str('One-line description shown in the skill list.'),
      body: str('The playbook: imperative instructions for the assistant. Use $ARGUMENTS where the user input belongs.'),
      argument_hint: str('Optional hint about expected arguments, e.g. "[path or focus]".'),
      allowed_tools: str('Optional comma-separated list of tools the skill is allowed to use.')
    }, required: ['name', 'body'],
    run: createSkillTool },

  { name: 'run_subagent', group: 'agent', concurrencySafe: false,
    description: 'Delegate a focused, self-contained subtask to an isolated subagent with its own context. Best for parallelisable research/analysis ("examine module X and report"), to keep the main context lean. The subagent runs autonomously, read-only by default, and returns a text report. It cannot ask the user questions.',
    parameters: {
      task: str('The single, focused task for the subagent, written as a clear instruction.'),
      context: str('Optional extra context/constraints the subagent needs.'),
      mode: str('"read" (default, analysis only) or "write" (may edit files; only honoured outside Default permission mode).')
    }, required: ['task'],
    run: runSubagentTool }
];

/**
 * One tool. Mirrors the `Tool` abstraction: schema generation, input
 * validation, permission checking and read-only/destructive/concurrency
 * predicates all derive from the {@link ToolDef} it wraps.
 */
class Tool {
  constructor(def) {
    this.def = def;
    this.name = def.name;
    this.description = def.description;
    this.group = def.group;
  }
  /** JSON-schema for the tool's arguments. */
  get inputSchema() {
    return { type: 'object', properties: this.def.parameters || {}, required: this.def.required || [] };
  }
  /** Native function-calling schema sent to the model. */
  schema() {
    return { type: 'function', function: { name: this.name, description: this.description, parameters: this.inputSchema } };
  }
  prompt() { return this.description; }
  isEnabled() { return this.def.enabled !== false; }
  isReadOnly() { return !!this.def.readOnly; }
  isMutating() { return !!this.def.mutating; }
  isDestructive() { return !!this.def.destructive; }
  isShell() { return !!this.def.shell; }
  isWeb() { return !!this.def.web; }
  isConcurrencySafe() { return this.def.concurrencySafe !== false; }
  needsWorkingFolder() { return !!this.def.needsWork; }
  shouldDefer() { return !!this.def.defer; }
  /** Return a human error string for missing required args, or null. */
  validateInput(action) {
    for (const key of (this.def.required || [])) {
      if (action[key] == null || action[key] === '') return `Missing required argument "${key}".`;
    }
    return null;
  }
  /** Which confirmation this tool needs in the given mode, or null. */
  checkPermissions(mode) { return confirmKindFor(this.name, mode); }
  execute(action, ctx) { return this.def.run(action, ctx); }
}

/** name → Tool */
const REGISTRY = new Map(DEFS.map((d) => [d.name, new Tool(d)]));

const getTool = (name) => REGISTRY.get(name);
/** Discovery list (name + metadata) for the UI / subagents. */
const listTools = () => [...REGISTRY.values()].map((t) => ({
  name: t.name, description: t.description, group: t.group,
  readOnly: t.isReadOnly(), mutating: t.isMutating(), destructive: t.isDestructive(),
  shell: t.isShell(), web: t.isWeb(), concurrencySafe: t.isConcurrencySafe(), defer: t.shouldDefer()
}));

/** Names of read-only tools — the default toolset a subagent may use. */
const READONLY_TOOLS = DEFS.filter((d) => d.readOnly).map((d) => d.name);

/**
 * Permission gate for a tool in a given mode — the single source of truth
 * the agent loop consults (it no longer keeps its own hardcoded sets):
 *   'bash' → shell command confirmation (default + tools-bypass)
 *   'web'  → network-access confirmation (default)
 *   'tool' → file-mutation confirmation (default)
 *   null   → runs without confirmation
 */
function confirmKindFor(name, mode) {
  const t = REGISTRY.get(name);
  if (!t) return null;
  if (t.isShell() && (mode === 'default' || mode === 'tools-bypass')) return 'bash';
  if (mode === 'default' && t.isWeb()) return 'web';
  if (mode === 'default' && t.isMutating()) return 'tool';
  return null;
}

/** Set of tools that change files/system — used by the planning gate. */
const MUTATING_TOOLS = new Set(DEFS.filter((d) => d.mutating).map((d) => d.name));

/**
 * Build the function-calling schema list.
 * @param {Set<string>} [allowed] Restrict to these tool names (for subagents).
 * @param {boolean} [includeDeferred] Include tools flagged `defer`.
 */
function buildSchemas(allowed, includeDeferred = false) {
  return [...REGISTRY.values()]
    .filter((t) => t.isEnabled() && (includeDeferred || !t.shouldDefer()))
    .filter((t) => !allowed || allowed.has(t.name))
    .map((t) => t.schema());
}

/** Default schema set sent to the model (all enabled, non-deferred tools). */
const TOOL_SCHEMAS = buildSchemas();

/* ---------------- dispatcher ---------------- */
/**
 * Execute one tool call.
 * @param {Object} action  { tool, ...args }
 * @param {Object} ctx
 * @param {Set<string>} [allowed]  If given, reject tools outside this set.
 */
async function exec(action, ctx, allowed) {
  const tool = REGISTRY.get(action.tool);
  if (!tool) return { ok: false, summary: `unknown tool: ${action.tool}`, output: `Error: unknown tool "${action.tool}".` };
  if (allowed && !allowed.has(action.tool)) {
    return { ok: false, summary: `tool not allowed: ${action.tool}`, output: `Error: tool "${action.tool}" is not permitted in this context.` };
  }
  const invalid = tool.validateInput(action);
  if (invalid) return { ok: false, summary: `${action.tool}: ${invalid}`, output: `Error: ${invalid}` };
  // Before ANY file/shell action, make sure a project folder is chosen. If none
  // is set yet, prompt the user to pick the project directory (native dialog)
  // and only then run the action — so the assistant never touches files without
  // a folder, and the user is asked exactly once, when it first matters.
  if (tool.needsWorkingFolder() && !ctx.store.get('workingDir')) {
    const picked = await pickFolder(ctx);
    if (!picked.ok) {
      return {
        ok: false,
        summary: 'папка проекта не выбрана',
        output: 'Для работы с файлами нужно выбрать папку проекта, но выбор отменён. Действие не выполнено — попросите пользователя указать папку или повторите, когда она будет выбрана.'
      };
    }
    // Surface the folder choice in the chat (and refresh the folder chip).
    ctx.emit?.({ type: 'tool', name: 'set_working_folder', ok: true, summary: picked.summary, workspaceChanged: true });
  }
  try {
    return await tool.execute(action, ctx);
  } catch (e) {
    return { ok: false, summary: `${action.tool || 'tool'} failed`, error: e.message, output: `Error: ${e.message}` };
  }
}

module.exports = {
  exec,
  TOOL_SCHEMAS,
  buildSchemas,
  confirmKindFor,
  MUTATING_TOOLS,
  READONLY_TOOLS,
  getTool,
  listTools
};
