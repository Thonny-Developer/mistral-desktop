'use strict';

/**
 * Agentic file-search primitives (main process).
 *
 * Pure implementation behind the search_files / list_files(glob) / read_file
 * tools. Prefers ripgrep (rg) for speed and .gitignore handling; falls back to a
 * plain Node walker when rg is not on PATH (the warning is logged once, at
 * startup, never per call).
 *
 * Every function takes an absolute, already-trusted `root` (the working folder)
 * plus a relative sub-path, resolves inside `root`, and refuses to escape it —
 * so `../../etc/passwd` style traversal is rejected here too, independently of
 * the caller.
 */

const fsp = require('fs/promises');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const DEFAULT_IGNORE = ['node_modules', '.git', 'dist', 'build', '.DS_Store'];
const MAX_MATCHES = 100;       // search_files result cap
const RG_MAXBUFFER = 8 * 1024 * 1024;
const NUL = String.fromCharCode(0);

// read_file behaviour
const LARGE_FILE = 300;        // files longer than this are head/tail-trimmed by default
const HEAD_LINES = 150;
const TAIL_LINES = 50;
const DEFAULT_LIMIT = 200;

/* ---------------- ripgrep detection (once) ---------------- */
let _rgChecked = false;
let _rgAvailable = false;
function hasRipgrep() {
  if (_rgChecked) return _rgAvailable;
  _rgChecked = true;
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' });
    _rgAvailable = true;
  } catch {
    _rgAvailable = false;
    console.warn('[fileSearch] ripgrep (rg) not found on PATH — using the slower Node fallback for search_files / list_files.');
  }
  return _rgAvailable;
}

/* ---------------- path + glob helpers ---------------- */
const toPosix = (p) => p.split(path.sep).join('/');

/** Resolve `rel` inside `root`, throwing if it escapes the working folder. */
function resolveWithin(root, rel) {
  if (!root) throw new Error('No working folder set.');
  const base = path.resolve(root);
  const abs = path.resolve(base, rel || '.');
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error('Path escapes the working folder.');
  }
  return abs;
}

/** Split file text into lines with wc -l semantics (a trailing newline is not a line). */
function splitLines(raw) {
  if (raw === '') return [];
  const lines = raw.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Minimal glob → RegExp (supports **, *, ?). Used only by the Node fallback. */
function globToRegExp(glob) {
  const g = toPosix(glob);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if ('/.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

/** Recursively collect absolute file paths under `dir`, skipping ignored folders. */
async function walk(dir, acc = []) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (DEFAULT_IGNORE.includes(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await walk(abs, acc);
    else if (e.isFile()) acc.push(abs);
  }
  return acc;
}

/* ==================================================================== *
 *  search_files — grep for a regex across the working folder
 * ==================================================================== */
async function searchFiles(args, root) {
  const pattern = args.pattern;
  if (!pattern) throw new Error('search_files requires "pattern".');
  const searchDir = resolveWithin(root, args.path || '.');
  const caseSensitive = !!args.case_sensitive;
  const glob = args.glob ? String(args.glob) : '';

  const matches = hasRipgrep()
    ? await rgSearch({ pattern, searchDir, caseSensitive, glob, root })
    : await jsSearch({ pattern, searchDir, caseSensitive, glob, root });

  const truncated = matches.length > MAX_MATCHES;
  return { matches: truncated ? matches.slice(0, MAX_MATCHES) : matches, truncated };
}

function rgSearch({ pattern, searchDir, caseSensitive, glob, root }) {
  const rgArgs = ['--line-number', '--no-heading', '--with-filename', '--color=never'];
  if (!caseSensitive) rgArgs.push('--ignore-case');
  for (const ig of ['node_modules', 'dist', 'build']) rgArgs.push('--glob', `!${ig}/**`);
  if (glob) rgArgs.push('--glob', glob);
  rgArgs.push('--regexp', pattern, '--', '.');
  return new Promise((resolve, reject) => {
    execFile('rg', rgArgs, { cwd: searchDir, maxBuffer: RG_MAXBUFFER }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 1) return resolve(parseRgLines(stdout || '', searchDir, root)); // no matches
        if (err.code === 2 && !stdout) return reject(new Error(`ripgrep: ${(stderr || '').trim() || err.message}`));
        if (stdout) return resolve(parseRgLines(stdout, searchDir, root)); // e.g. maxBuffer overflow — use partial
        return reject(err);
      }
      resolve(parseRgLines(stdout || '', searchDir, root));
    });
  });
}

// rg output (run with cwd = searchDir, path ".") is "relpath:line:content".
// Splitting on the first two colons is safe because the path is relative, so it
// carries no Windows drive-letter colon.
function parseRgLines(stdout, searchDir, root) {
  const out = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const a = line.indexOf(':');
    const b = line.indexOf(':', a + 1);
    if (a === -1 || b === -1) continue;
    const ln = parseInt(line.slice(a + 1, b), 10);
    if (!Number.isFinite(ln)) continue;
    const file = toPosix(path.relative(root, path.resolve(searchDir, line.slice(0, a))));
    out.push({ file, line: ln, content: line.slice(b + 1) });
  }
  return out;
}

async function jsSearch({ pattern, searchDir, caseSensitive, glob, root }) {
  let re;
  try { re = new RegExp(pattern, caseSensitive ? '' : 'i'); }
  catch (e) { throw new Error(`Invalid regex: ${e.message}`); }
  const globRe = glob ? globToRegExp(glob) : null;
  const out = [];
  for (const abs of await walk(searchDir)) {
    const rel = toPosix(path.relative(root, abs));
    const relToSearch = toPosix(path.relative(searchDir, abs));
    if (globRe && !globRe.test(path.basename(abs)) && !globRe.test(relToSearch)) continue;
    let text;
    try { text = await fsp.readFile(abs, 'utf-8'); } catch { continue; }
    if (text.includes(NUL)) continue; // NUL byte → binary, skip
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        out.push({ file: rel, line: i + 1, content: lines[i] });
        if (out.length > MAX_MATCHES) return out; // enough to know it's truncated
      }
    }
  }
  return out;
}

/* ==================================================================== *
 *  list_files (glob mode) — recursive file listing matching a pattern
 * ==================================================================== */
async function globFiles(args, root) {
  const glob = args.pattern || args.glob;
  if (!glob) throw new Error('glob listing requires a pattern.');
  const searchDir = resolveWithin(root, args.path || '.');
  const files = hasRipgrep()
    ? await rgListFiles({ glob, searchDir, root })
    : await jsListFiles({ glob, searchDir, root });
  files.sort();
  return files;
}

function rgListFiles({ glob, searchDir, root }) {
  const rgArgs = ['--files', '--color=never'];
  for (const ig of ['node_modules', 'dist', 'build']) rgArgs.push('--glob', `!${ig}/**`);
  rgArgs.push('--glob', glob);
  return new Promise((resolve, reject) => {
    execFile('rg', rgArgs, { cwd: searchDir, maxBuffer: RG_MAXBUFFER }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 1) return resolve([]); // nothing matched
        if (err.code === 2 && !stdout) return reject(new Error(`ripgrep: ${(stderr || '').trim() || err.message}`));
        if (!stdout) return resolve([]);
      }
      const out = [];
      for (const line of (stdout || '').split('\n')) {
        if (!line) continue;
        out.push(toPosix(path.relative(root, path.resolve(searchDir, line))));
      }
      resolve(out);
    });
  });
}

async function jsListFiles({ glob, searchDir, root }) {
  const globRe = globToRegExp(glob);
  const out = [];
  for (const abs of await walk(searchDir)) {
    const rel = toPosix(path.relative(root, abs));
    const relToSearch = toPosix(path.relative(searchDir, abs));
    if (globRe.test(rel) || globRe.test(relToSearch) || globRe.test(path.basename(abs))) out.push(rel);
  }
  return out;
}

/* ==================================================================== *
 *  read_file — line-numbered, range-aware reading
 * ==================================================================== */
function numberLines(lines, startLineNo) {
  return lines.map((l, i) => `${startLineNo + i}: ${l}`).join('\n');
}

async function readFileRanged(args, root) {
  if (!args.path) throw new Error('read_file requires "path".');
  const abs = resolveWithin(root, args.path);
  const raw = await fsp.readFile(abs, 'utf-8');
  const lines = splitLines(raw);
  const total = lines.length;

  const hasRange = args.offset != null || args.limit != null;

  // Explicit range: read exactly the requested window, with markers for the rest.
  if (hasRange) {
    const offset = Math.max(1, parseInt(args.offset ?? 1, 10) || 1);
    const limit = Math.max(1, parseInt(args.limit ?? DEFAULT_LIMIT, 10) || DEFAULT_LIMIT);
    const start = offset - 1;
    const slice = lines.slice(start, start + limit);
    const shownTo = start + slice.length;
    const head = start > 0 ? `…(${start} line(s) above; ${total} total)\n` : '';
    const body = slice.length ? numberLines(slice, offset) : '(no lines in that range)';
    const tail = shownTo < total
      ? `\n…(${total - shownTo} more line(s) below; ${total} total — continue with offset ${shownTo + 1})`
      : '';
    return { total, shownFrom: offset, shownTo, text: head + body + tail };
  }

  // Big file, no range asked for: give a head + tail preview and tell the model
  // how to read the rest, so a large file never silently floods the context.
  if (total > LARGE_FILE) {
    const head = numberLines(lines.slice(0, HEAD_LINES), 1);
    const tail = numberLines(lines.slice(total - TAIL_LINES), total - TAIL_LINES + 1);
    const text = head +
      `\n…(файл обрезан — показаны строки 1-${HEAD_LINES} и ${total - TAIL_LINES + 1}-${total} из ${total}; ` +
      'используйте offset/limit чтобы прочитать нужный диапазон)…\n' +
      tail;
    return { total, truncated: true, text };
  }

  // Small file: return it whole.
  return { total, text: total ? numberLines(lines, 1) : '' };
}

// Warm the ripgrep check at startup so the "not found" warning (if any) is
// printed once, when the app loads — not on the first tool call mid-chat.
hasRipgrep();

module.exports = {
  searchFiles,
  globFiles,
  readFileRanged,
  hasRipgrep,
  // exported for unit tests
  _internal: { resolveWithin, splitLines, globToRegExp }
};
