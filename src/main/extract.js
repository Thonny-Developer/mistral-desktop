'use strict';

/**
 * Document extraction (main process).
 *
 * Pulls *plain text* out of binary / container document formats so that only
 * the extracted data — never the raw bytes — ever enters the model's context.
 *
 * Everything here is pure Node (Buffer + zlib): no extra dependencies, in line
 * with the project's vanilla stack. Each format has a small dedicated method;
 * formats without one are reported as unsupported so the agent can write its
 * own extractor and feed back only what it pulled out.
 */

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

/** Extensions we have a built-in extractor for (used for discovery + read_file routing). */
const EXTRACTABLE = new Set([
  'pdf',
  'docx', 'pptx', 'xlsx', // OOXML (zip + xml)
  'odt', 'odp', 'ods',     // OpenDocument (zip + xml)
  'zip', 'epub'            // generic containers
]);

/** Plain-text-ish extensions read_file can handle directly (no extractor needed). */
const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'rst', 'log', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml',
  'xml', 'html', 'htm', 'css', 'svg', 'ini', 'toml', 'env', 'cfg', 'conf',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h',
  'cpp', 'hpp', 'cc', 'cs', 'php', 'sh', 'bash', 'fish', 'zsh', 'sql', 'lua', 'pl',
  'r', 'kt', 'swift', 'dart', 'vue', 'gradle', 'dockerfile', 'makefile', 'gitignore'
]);

const extOf = (p) => (path.extname(p || '').replace(/^\./, '') || '').toLowerCase();

/* ============================== ZIP reader ============================== */
/**
 * Minimal ZIP reader. OOXML (docx/pptx/xlsx) and OpenDocument files are just
 * ZIP archives of XML, so we read the central directory and inflate the
 * entries we need — no external unzip binary required (works the same on
 * Windows and Linux).
 *
 * @returns {Map<string, Buffer>} entry name → decompressed bytes
 */
function readZip(buf) {
  const entries = new Map();
  // Find the End Of Central Directory record (PK\x05\x06), scanning back from
  // the tail (it sits before an optional, rarely-used comment).
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a valid zip archive');

  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // offset of central directory

  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break; // central dir header sig
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    // Jump to the local header to find where the data actually starts (its
    // extra-field length can differ from the central directory's).
    if (buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    try {
      entries.set(name, method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw));
    } catch {
      // Skip entries we can't inflate rather than failing the whole archive.
    }
  }
  return entries;
}

/* ============================== XML helpers ============================== */
const decodeEntities = (s) => (s || '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
  .replace(/&amp;/g, '&');

/** Collect the inner text of every <tag>…</tag> (namespace-agnostic). */
function textOfTags(xml, tag) {
  const re = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(decodeEntities(m[1].replace(/<[^>]+>/g, '')));
  return out;
}

/* ============================== OOXML ============================== */
function extractDocx(zip) {
  const xml = bufStr(zip.get('word/document.xml'));
  if (!xml) return '';
  // Paragraph boundaries → newlines; <w:t> runs → text.
  return xml
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .split(/(?=<w:t[\s>])/)
    .map((chunk) => {
      const m = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/.exec(chunk);
      return m ? decodeEntities(m[1]) + chunk.slice(m.index + m[0].length).replace(/<[^>]+>/g, '') : (chunk.includes('\n') ? '\n' : '');
    })
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractPptx(zip) {
  // One section per slide, in slide order.
  const slides = [...zip.keys()]
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => slideNum(a) - slideNum(b));
  const out = [];
  for (const key of slides) {
    const xml = bufStr(zip.get(key));
    const runs = textOfTags(xml, 't'); // <a:t>
    const body = runs.map((s) => s.trim()).filter(Boolean).join('\n');
    if (body) out.push(`--- Слайд ${slideNum(key)} ---\n${body}`);
  }
  return out.join('\n\n').trim();
}

function extractXlsx(zip) {
  // Shared strings table (cells reference it by index).
  const sst = [];
  const sstXml = bufStr(zip.get('xl/sharedStrings.xml'));
  if (sstXml) {
    for (const m of sstXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      const parts = [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeEntities(x[1]));
      sst.push(parts.join(''));
    }
  }
  const sheets = [...zip.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => sheetNum(a) - sheetNum(b));
  const out = [];
  for (const key of sheets) {
    const xml = bufStr(zip.get(key));
    const rows = [];
    for (const rowM of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cM of rowM[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const isStr = /\bt="s"/.test(cM[1]);
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cM[2]);
        const inline = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(cM[2]);
        let val = '';
        if (v) val = isStr ? (sst[parseInt(v[1], 10)] ?? '') : decodeEntities(v[1]);
        else if (inline) val = decodeEntities(inline[1]);
        cells.push(val);
      }
      if (cells.some((c) => c !== '')) rows.push(cells.join('\t'));
    }
    if (rows.length) out.push(`--- Лист ${sheetNum(key)} ---\n${rows.join('\n')}`);
  }
  return out.join('\n\n').trim();
}

/* ============================== OpenDocument ============================== */
function extractOpenDocument(zip) {
  const xml = bufStr(zip.get('content.xml'));
  if (!xml) return '';
  return xml
    .replace(/<text:tab\b[^>]*\/>/g, '\t')
    .replace(/<text:line-break\b[^>]*\/>/g, '\n')
    .replace(/<\/text:(?:p|h)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .split('\n').map((l) => decodeEntities(l).trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ============================== EPUB / generic zip ============================== */
function extractEpub(zip) {
  const chapters = [...zip.keys()]
    .filter((k) => /\.x?html?$/i.test(k))
    .sort();
  const out = [];
  for (const key of chapters) {
    const html = bufStr(zip.get(key));
    const text = htmlToText(html);
    if (text) out.push(text);
  }
  return out.join('\n\n').trim();
}

function listZip(zip) {
  const names = [...zip.keys()];
  const head = names.slice(0, 200).map((n) => `  ${n}`).join('\n');
  return `Архив содержит ${names.length} файл(ов):\n${head}${names.length > 200 ? '\n  …' : ''}\n\n(Чтобы прочитать содержимое — распакуйте нужный файл и извлеките данные из него.)`;
}

/* ============================== PDF ============================== */
/**
 * Best-effort PDF text extraction with no external library: inflate every
 * FlateDecode content stream and pull text out of the PDF text-showing
 * operators (Tj and TJ), treating the line-positioning operators as line
 * breaks. Good enough for ordinary, non-scanned PDFs; scanned image-only PDFs
 * yield little, which the agent is told to handle by other means.
 */
function extractPdf(buf) {
  const pieces = [];
  let idx = 0;
  while (true) {
    const s = buf.indexOf('stream', idx);
    if (s < 0) break;
    // Data begins right after the EOL that follows the `stream` keyword.
    let dataStart = s + 6;
    if (buf[dataStart] === 0x0d) dataStart++;
    if (buf[dataStart] === 0x0a) dataStart++;
    const e = buf.indexOf('endstream', dataStart);
    if (e < 0) break;
    const chunk = buf.subarray(dataStart, e);
    idx = e + 9;
    let decoded = null;
    try { decoded = zlib.inflateSync(chunk); }
    catch { try { decoded = zlib.inflateRawSync(chunk); } catch { decoded = null; } }
    if (decoded) pieces.push(decoded.toString('latin1'));
  }
  // Some PDFs keep content uncompressed — fall back to the raw text if we
  // inflated nothing usable.
  const content = pieces.length ? pieces.join('\n') : buf.toString('latin1');
  const text = pdfContentToText(content);
  return text;
}

function pdfContentToText(content) {
  const out = [];
  // Walk text objects (BT … ET) and emit the strings they show.
  for (const block of content.split(/BT\b/).slice(1)) {
    const body = block.split(/\bET\b/)[0];
    let line = '';
    // Match string-showing operators and positioning ops that imply newlines.
    const re = /\((?:\\.|[^\\()])*\)|\[((?:[^\][]|\\.)*)\]\s*TJ|\bT\*|\bTd\b|\bTD\b|'|"/g;
    let m;
    while ((m = re.exec(body))) {
      const tok = m[0];
      if (tok === 'T*' || tok === 'Td' || tok === 'TD' || tok === "'" || tok === '"') {
        if (line.trim()) { out.push(line.trim()); line = ''; }
      } else if (tok.startsWith('[')) {
        line += [...m[1].matchAll(/\((?:\\.|[^\\()])*\)/g)].map((x) => pdfString(x[0])).join('');
      } else if (tok.startsWith('(')) {
        line += pdfString(tok);
      }l
    }
    if (line.trim()) out.push(line.trim());
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Decode a PDF literal string `(…)` including escape sequences. */
function pdfString(tok) {
  const s = tok.slice(1, -1);
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c) => {
    switch (c) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'b': return '\b';
      case 'f': return '\f';
      case '(': return '(';
      case ')': return ')';
      case '\\': return '\\';
      default: return String.fromCharCode(parseInt(c, 8) & 0xff);
    }
  });
}

/* ============================== shared utils ============================== */
const bufStr = (b) => (b ? b.toString('utf8') : '');
const slideNum = (k) => parseInt((/(\d+)\.xml$/.exec(k) || [])[1] || '0', 10);
const sheetNum = slideNum;

function htmlToText(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .split('\n').map((l) => decodeEntities(l).replace(/[ \t]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ============================== public API ============================== */
/** Does a byte buffer look like plain text (no NUL in the first 4 KB)? */
function looksLikeText(buf) {
  return !buf.subarray(0, 4096).includes(0);
}

/**
 * Extract plain text from a document held in memory.
 * @param {string} ext  Lower-case extension (no dot).
 * @param {Buffer} buf  Raw file bytes.
 * @returns {{ ok: boolean, ext: string, text?: string, error?: string }}
 */
function extractBuffer(ext, buf) {
  try {
    switch (ext) {
      case 'pdf':
        return { ok: true, ext, text: extractPdf(buf) };
      case 'docx':
        return { ok: true, ext, text: extractDocx(readZip(buf)) };
      case 'pptx':
        return { ok: true, ext, text: extractPptx(readZip(buf)) };
      case 'xlsx':
        return { ok: true, ext, text: extractXlsx(readZip(buf)) };
      case 'odt':
      case 'odp':
      case 'ods':
        return { ok: true, ext, text: extractOpenDocument(readZip(buf)) };
      case 'epub':
        return { ok: true, ext, text: extractEpub(readZip(buf)) };
      case 'zip':
        return { ok: true, ext, text: listZip(readZip(buf)) };
      default:
        return { ok: false, ext, error: `no built-in extractor for ".${ext}"` };
    }
  } catch (e) {
    return { ok: false, ext, error: e.message };
  }
}

/**
 * Extract plain text from a document file on disk.
 * @param {string} absPath  Absolute path (already sandbox-checked by the caller).
 */
function extractFile(absPath) {
  return extractBuffer(extOf(absPath), fs.readFileSync(absPath));
}

/**
 * Extract text from an attached file (any not-too-heavy file the user drops in
 * the composer). Documents go through their dedicated extractor; anything else
 * that is plain text (by extension or by sniffing for NUL bytes) is returned as
 * UTF-8. Truly binary files with no extractor are reported as unsupported.
 * @param {string} name  Original file name (for the extension).
 * @param {Buffer} buf   Raw file bytes.
 */
function extractAttachment(name, buf) {
  const ext = extOf(name);
  if (EXTRACTABLE.has(ext)) return extractBuffer(ext, buf);
  if (TEXT_EXT.has(ext) || looksLikeText(buf)) {
    return { ok: true, ext: ext || 'txt', text: buf.toString('utf8') };
  }
  return { ok: false, ext, error: `no built-in extractor for ".${ext || '?'}" (binary file)` };
}

/** Heuristic: does this path look like a binary/document file (not plain text)? */
function isBinaryDoc(absPath) {
  const ext = extOf(absPath);
  if (EXTRACTABLE.has(ext)) return true;
  if (TEXT_EXT.has(ext)) return false;
  // Unknown extension → sniff the first bytes for NUL (a strong binary signal).
  try {
    const fd = fs.openSync(absPath, 'r');
    const chunk = Buffer.alloc(4096);
    const n = fs.readSync(fd, chunk, 0, 4096, 0);
    fs.closeSync(fd);
    return chunk.subarray(0, n).includes(0);
  } catch {
    return false;
  }
}

module.exports = { extractFile, extractAttachment, isBinaryDoc, EXTRACTABLE, extOf };
