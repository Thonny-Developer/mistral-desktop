// Unit test for src/main/fileSearch.js — no test framework required.
// Run: node test/fileSearch.test.mjs   (exits non-zero on any failure)
//
// fileSearch.js is CommonJS but pulls in only fs/path/child_process (no
// electron), so it imports cleanly here. Exercises the real ripgrep path when
// rg is on PATH, otherwise the Node fallback — the results should match either
// way.

import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fileSearch = require('../src/main/fileSearch.js');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

// --- build a throwaway workspace ---
const root = await mkdtemp(path.join(tmpdir(), 'fsearch-'));
await mkdir(path.join(root, 'src'), { recursive: true });
await mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
await writeFile(path.join(root, 'a.js'), 'const x = 1;\nfunction hello() {}\n');
await writeFile(path.join(root, 'src', 'b.js'), 'export function hello() { return 2; }\n');
await writeFile(path.join(root, 'src', 'notes.txt'), 'nothing here\n');
await writeFile(path.join(root, 'node_modules', 'dep', 'c.js'), 'function hello() {}\n'); // must be ignored
// 400-line file for the read_file truncation test
await writeFile(path.join(root, 'big.txt'), Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');

try {
  console.log(`(ripgrep ${fileSearch.hasRipgrep() ? 'available' : 'NOT available — testing Node fallback'})`);

  // 1. search_files finds the pattern in tracked files, not in node_modules.
  const s = await fileSearch.searchFiles({ pattern: 'function hello' }, root);
  const files = s.matches.map((m) => m.file).sort();
  check('search finds a.js + src/b.js', files.includes('a.js') && files.includes('src/b.js'));
  check('search ignores node_modules', !files.some((f) => f.includes('node_modules')));
  check('search reports line numbers', s.matches.every((m) => Number.isFinite(m.line) && m.line >= 1));

  // 2. glob filter narrows search_files by file type.
  const sTxt = await fileSearch.searchFiles({ pattern: 'nothing', glob: '*.txt' }, root);
  check('glob filter matches only .txt', sTxt.matches.length === 1 && sTxt.matches[0].file === 'src/notes.txt');

  // 3. list_files glob mode.
  const g = await fileSearch.globFiles({ pattern: '**/*.js' }, root);
  check('glob lists both js files', g.includes('a.js') && g.includes('src/b.js'));
  check('glob excludes node_modules', !g.some((f) => f.includes('node_modules')));

  // 4. read_file: big file truncated to head+tail unless a range is given.
  const rBig = await fileSearch.readFileRanged({ path: 'big.txt' }, root);
  check('big file reports 400 total lines', rBig.total === 400);
  check('big file is truncated by default', rBig.truncated === true);
  check('big file shows numbered head line 1', rBig.text.includes('1: line 1'));
  check('big file shows numbered tail line 400', rBig.text.includes('400: line 400'));
  check('big file omits a middle line', !rBig.text.includes('200: line 200'));

  // 5. read_file with offset/limit reads exactly the window.
  const rRange = await fileSearch.readFileRanged({ path: 'big.txt', offset: 10, limit: 3 }, root);
  check('range starts at line 10', rRange.text.includes('10: line 10'));
  check('range ends at line 12', rRange.text.includes('12: line 12'));
  check('range excludes line 13', !rRange.text.includes('13: line 13'));
  check('range reports shownFrom/shownTo', rRange.shownFrom === 10 && rRange.shownTo === 12);

  // 6. small file returned whole, line-numbered.
  const rSmall = await fileSearch.readFileRanged({ path: 'a.js' }, root);
  check('small file not truncated', !rSmall.truncated && rSmall.total === 2);
  check('small file line-numbered', rSmall.text.includes('2: function hello() {}'));

  // 7. path traversal is refused.
  let threw = false;
  try { await fileSearch.readFileRanged({ path: '../../../etc/passwd' }, root); }
  catch { threw = true; }
  check('path traversal rejected', threw);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`\nfileSearch: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
