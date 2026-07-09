// Unit test for recoverLeakedToolCalls in src/main/mistral.js — no framework.
// Run: node test/toolLeak.test.mjs   (exits non-zero on any failure)
//
// Covers the "model leaked a tool call into the text" failure mode that showed
// up as raw `search_files<glyph>{…}` in the chat: the call must be pulled out
// (so it runs) and the garbage stripped from the content.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { recoverLeakedToolCalls } = require('../src/main/mistral.js');

const TOOLS = new Set(['search_files', 'read_file', 'list_files']);
const GLYPH = String.fromCharCode(0x624); // ؤ — a detokenised [ARGS] special token

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

// 1. The exact reported case: bare "name<glyph>{json}".
{
  const raw = `search_files${GLYPH}{"pattern": "function.*execute", "glob": "**/*.js"}`;
  const { content, calls } = recoverLeakedToolCalls(raw, TOOLS);
  check('glyph form: one call recovered', calls.length === 1);
  check('glyph form: right name', calls[0]?.name === 'search_files');
  check('glyph form: args parsed', calls[0]?.args?.pattern === 'function.*execute' && calls[0]?.args?.glob === '**/*.js');
  check('glyph form: content stripped clean', content === '');
}

// 2. Prose before the leaked call is kept; only the call is stripped.
{
  const raw = `Sure, searching now.\n\nsearch_files${GLYPH}{"pattern": "todo"}`;
  const { content, calls } = recoverLeakedToolCalls(raw, TOOLS);
  check('glyph form: keeps leading prose', content === 'Sure, searching now.');
  check('glyph form: still recovers call', calls.length === 1 && calls[0].args.pattern === 'todo');
}

// 3. Canonical Mistral markers: [TOOL_CALLS]name[ARGS]{json}.
{
  const raw = `[TOOL_CALLS]read_file[ARGS]{"path": "src/main.js", "offset": 10}`;
  const { content, calls } = recoverLeakedToolCalls(raw, TOOLS);
  check('marker form: recovered', calls.length === 1 && calls[0].name === 'read_file');
  check('marker form: args parsed', calls[0].args.path === 'src/main.js' && calls[0].args.offset === 10);
  check('marker form: content empty', content === '');
}

// 4. Two calls chained after the marker.
{
  const raw = `[TOOL_CALLS]list_files[ARGS]{"glob": "**/*.ts"}read_file[ARGS]{"path": "a.ts"}`;
  const { calls } = recoverLeakedToolCalls(raw, TOOLS);
  check('marker form: two calls recovered', calls.length === 2 && calls[0].name === 'list_files' && calls[1].name === 'read_file');
}

// 5. JSON-array form: [TOOL_CALLS][{name, arguments}].
{
  const raw = `[TOOL_CALLS][{"name": "search_files", "arguments": {"pattern": "x"}}]`;
  const { content, calls } = recoverLeakedToolCalls(raw, TOOLS);
  check('array form: recovered', calls.length === 1 && calls[0].name === 'search_files' && calls[0].args.pattern === 'x');
  check('array form: content empty', content === '');
}

// 5b. The reasoning-model "startname{json}" DSL (the magistral-medium case):
//     several calls glued together, "start" prepended to each.
{
  const raw = 'Начнём с поиска.start' +
    'search_files{"pattern": "tool", "path": "."}start' +
    'list_files{"path": "src", "glob": "**/*.ts"}';
  const { content, calls } = recoverLeakedToolCalls(raw, TOOLS);
  check('start DSL: both calls recovered', calls.length === 2 && calls[0].name === 'search_files' && calls[1].name === 'list_files');
  check('start DSL: args parsed', calls[0].args.pattern === 'tool' && calls[1].args.glob === '**/*.ts');
  check('start DSL: prose kept, junk stripped', content === 'Начнём с поиска.');
}

// 5c. Runaway loop: hundreds of duplicate calls collapse to unique + capped.
{
  const raw = 'start' + Array.from({ length: 400 }, () => 'list_files{"path": "src", "glob": "**/*.ts"}start').join('');
  const { calls } = recoverLeakedToolCalls(raw, TOOLS);
  check('runaway: deduped to a single unique call', calls.length === 1);
}

// 6. Ordinary prose is NEVER touched (no false positives).
{
  const raw = 'The function read_file reads a file. Use it like read_file(path).';
  const { content, calls } = recoverLeakedToolCalls(raw, TOOLS);
  check('prose: no calls', calls.length === 0);
  check('prose: content unchanged', content === raw);
}

// 7. A JSON code block in prose must not be mistaken for a call.
{
  const raw = 'Config example:\n\n```json\n{"path": "x"}\n```';
  const { content, calls } = recoverLeakedToolCalls(raw, TOOLS);
  check('json block: not a call', calls.length === 0 && content === raw);
}

// 8. Empty / no-marker content is a no-op.
{
  const { content, calls } = recoverLeakedToolCalls('just a normal answer', TOOLS);
  check('plain answer: unchanged', calls.length === 0 && content === 'just a normal answer');
}

console.log(`\nrecoverLeakedToolCalls: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
