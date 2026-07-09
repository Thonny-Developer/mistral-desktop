// Standalone unit test for reasoningToChunks — no test framework required.
// Run: node test/reasoning.test.mjs   (exits non-zero on any failure)
//
// The function below is a VERBATIM MIRROR of reasoningToChunks in
// src/renderer/pages/chat.js (that file is a browser ESM module full of DOM
// imports and can't be imported by node). Keep the two copies in sync — if you
// edit one, edit the other.

function reasoningToChunks(text) {
  const chunks = [];
  const OPEN = /<details\b[^>]*>/i;
  let rest = String(text);
  while (true) {
    const open = rest.match(OPEN);
    if (!open) break;
    const before = rest.slice(0, open.index);
    if (before.trim()) chunks.push({ type: 'text', text: before });
    const after = rest.slice(open.index + open[0].length);
    const closeIdx = after.search(/<\/details>/i);
    const inner = closeIdx === -1 ? after : after.slice(0, closeIdx);
    const think = inner.replace(/<summary\b[^>]*>[\s\S]*?<\/summary>/i, '').trim();
    if (think) chunks.push({ type: 'thinking', thinking: [{ type: 'text', text: think }] });
    if (closeIdx === -1) { rest = ''; break; }
    rest = after.slice(closeIdx + '</details>'.length);
  }
  if (rest.trim()) chunks.push({ type: 'text', text: rest });
  return chunks;
}

// Convenience builders for expected output.
const T = (text) => ({ type: 'text', text });
const K = (text) => ({ type: 'thinking', thinking: [{ type: 'text', text }] });

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n    expected: ' + e + '\n    actual:   ' + a); }
}

// 1. Normal: one reasoning block then the answer. <summary> is stripped.
check('normal block + answer',
  reasoningToChunks('<details><summary>Думает</summary>plan it</details>The answer'),
  [K('plan it'), T('The answer')]);

// 2. Truncated stream: unclosed <details> — remainder must survive as reasoning,
//    NOT be lost or crash the parser.
check('unclosed <details> keeps remainder as thinking',
  reasoningToChunks('<details><summary>Думает</summary>half a thou'),
  [K('half a thou')]);

// 3. Empty block must NOT produce an empty thinking chunk.
check('empty block yields no chunk',
  reasoningToChunks('<details><summary>Думает</summary></details>answer only'),
  [T('answer only')]);

// 3b. Truly empty <details></details> (no summary) also yields nothing.
check('bare empty block yields no chunk',
  reasoningToChunks('before<details></details>after'),
  [T('before'), T('after')]);

// 4. Interleaved agent turn: thinking → tool line → thinking → answer, order kept.
check('interleaved thinking/tool/answer preserves order',
  reasoningToChunks('<details><summary>Думает</summary>step1</details>> ran tool\n<details><summary>Думает</summary>step2</details>Final'),
  [K('step1'), T('> ran tool\n'), K('step2'), T('Final')]);

// 5. No reasoning at all: a single text chunk.
check('plain text, no details',
  reasoningToChunks('just an answer'),
  [T('just an answer')]);

// 6. data-secs attribute on the tag (render metadata) is tolerated by [^>]*.
check('tag with attributes',
  reasoningToChunks('<details data-secs="3"><summary>Думает</summary>attr ok</details>done'),
  [K('attr ok'), T('done')]);

// 7. Nested/garbled input must not throw and must not drop the visible answer.
check('nested does not crash and keeps answer text',
  (() => {
    const out = reasoningToChunks('<details><summary>Думает</summary>outer<details>inner</details></details>answer');
    // We only assert robustness: it returns chunks and the answer survives somewhere.
    const flat = JSON.stringify(out);
    return { ok: Array.isArray(out) && flat.includes('answer') };
  })(),
  { ok: true });

console.log(`\nreasoningToChunks: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
