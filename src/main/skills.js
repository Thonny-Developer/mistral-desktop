'use strict';

/**
 * Skill system (main process).
 *
 * A skill is a Markdown file with YAML-ish frontmatter that packages a reusable
 * prompt ("playbook") plus optional metadata. Skills are the user-extensible
 * layer on top of the built-in tools: a `/review` or `/debug` expands into a
 * carefully written instruction set the model then executes with the normal
 * agent loop.
 *
 *   ---
 *   name: review
 *   description: Review recent changes for bugs and improvements
 *   allowed-tools: read_file, list_files, exec_bash
 *   argument-hint: [path or focus]
 *   ---
 *   You are a senior reviewer. Review $ARGUMENTS ...
 *
 * Discovery layers (later layers override earlier ones by name):
 *   1. bundled  — shipped with the app (src/main/skills/*.md)
 *   2. user     — <userData>/skills/*.md      (editable in Settings)
 *   3. project  — <workingDir>/.mist/skills/*.md
 *
 * Body substitutions:
 *   $ARGUMENTS  → the full argument string
 *   $1 … $9     → individual whitespace-separated arguments
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const BUNDLED_DIR = path.join(__dirname, 'skills');

/** Per-user skills directory (created on demand). */
function userDir() {
  return path.join(app.getPath('userData'), 'skills');
}
/** Per-project skills directory for a working folder (or null). */
function projectDir(workingDir) {
  return workingDir ? path.join(workingDir, '.mist', 'skills') : null;
}

function ensureUserDir() {
  const dir = userDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* noop */ }
  return dir;
}

/* ---------------- frontmatter parsing ---------------- */
/**
 * Split a `---`-fenced frontmatter block from the body and parse a small
 * subset of YAML (flat `key: value`, plus `- item` lists and inline
 * `[a, b]` / `a, b` lists). Good enough for skill metadata without a dep.
 */
function parseFrontmatter(raw) {
  const text = raw.replace(/^﻿/, '');
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text.trim() };

  const meta = {};
  let key = null;
  for (const line of m[1].split('\n')) {
    if (!line.trim()) continue;
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && key) {
      if (!Array.isArray(meta[key])) meta[key] = [];
      meta[key].push(stripQuotes(listItem[1].trim()));
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    key = kv[1].trim();
    const val = kv[2].trim();
    if (val === '') { meta[key] = []; continue; } // list will follow on next lines
    meta[key] = stripQuotes(val);
  }
  return { meta, body: m[2].trim() };
}

function stripQuotes(s) {
  return s.replace(/^['"]/, '').replace(/['"]$/, '');
}

/** Normalise the `allowed-tools` field into an array of tool names (or null). */
function parseAllowedTools(value) {
  if (value == null) return null;
  const arr = Array.isArray(value)
    ? value
    : String(value).split(',');
  const list = arr.map((s) => s.trim()).filter(Boolean);
  return list.length ? list : null;
}

/* ---------------- discovery ---------------- */
function readDir(dir, source) {
  const out = [];
  if (!dir) return out;
  let names;
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const file of names) {
    if (!file.endsWith('.md')) continue;
    const full = path.join(dir, file);
    let raw;
    try { raw = fs.readFileSync(full, 'utf-8'); } catch { continue; }
    const { meta, body } = parseFrontmatter(raw);
    const name = (meta.name || file.replace(/\.md$/, '')).toLowerCase();
    out.push({
      name,
      description: meta.description || '',
      allowedTools: parseAllowedTools(meta['allowed-tools'] || meta.allowedTools),
      argumentHint: meta['argument-hint'] || meta.argumentHint || '',
      model: meta.model || '',
      body,
      source,
      path: full
    });
  }
  return out;
}

/**
 * Load every skill, with project > user > bundled precedence by name.
 * @param {string} [workingDir]
 * @returns {Map<string, Object>}
 */
function loadAll(workingDir) {
  const map = new Map();
  for (const s of readDir(BUNDLED_DIR, 'bundled')) map.set(s.name, s);
  for (const s of readDir(userDir(), 'user')) map.set(s.name, s);
  for (const s of readDir(projectDir(workingDir), 'project')) map.set(s.name, s);
  return map;
}

/** Public metadata list for the UI / tool discovery (no body). */
function listSkills(workingDir) {
  return [...loadAll(workingDir).values()]
    .map(({ body, ...meta }) => meta) // eslint-disable-line no-unused-vars
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getSkill(name, workingDir) {
  return loadAll(workingDir).get(String(name || '').toLowerCase()) || null;
}

/* ---------------- rendering ---------------- */
function substitute(body, argString) {
  const args = String(argString || '').trim();
  const parts = args ? args.split(/\s+/) : [];
  let out = body.replace(/\$ARGUMENTS\b/g, args);
  out = out.replace(/\$([1-9])\b/g, (_, n) => parts[Number(n) - 1] || '');
  // If the skill never referenced $ARGUMENTS/$N but the user passed args,
  // append them so they're not silently dropped.
  if (args && !/\$ARGUMENTS\b|\$[1-9]\b/.test(body)) out += `\n\n${args}`;
  return out.trim();
}

/**
 * Render a skill into the prompt to send plus its execution constraints.
 * @returns {{name, prompt, allowedTools: string[]|null, model: string}|null}
 */
function renderSkill(name, argString, workingDir) {
  const skill = getSkill(name, workingDir);
  if (!skill) return null;
  return {
    name: skill.name,
    prompt: substitute(skill.body, argString),
    allowedTools: skill.allowedTools,
    model: skill.model || ''
  };
}

/* ---------------- authoring (user skills) ---------------- */
/** Turn an arbitrary name into a safe kebab-case file slug. */
function slugify(name) {
  return String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'skill';
}

/**
 * Create or overwrite a skill in the per-user folder.
 * @param {{name, description?, allowedTools?, argumentHint?, body?}} skill
 * @returns {{ok:boolean, name:string, path:string}}
 */
function saveSkill(skill) {
  const dir = ensureUserDir();
  const slug = slugify(skill.name);
  const allowed = Array.isArray(skill.allowedTools)
    ? skill.allowedTools.join(', ')
    : (skill.allowedTools ? String(skill.allowedTools).trim() : '');
  const oneLine = (s) => String(s || '').replace(/\s*\n\s*/g, ' ').trim();

  const lines = ['---', `name: ${slug}`];
  if (skill.description) lines.push(`description: ${oneLine(skill.description)}`);
  if (allowed) lines.push(`allowed-tools: ${oneLine(allowed)}`);
  if (skill.argumentHint) lines.push(`argument-hint: ${oneLine(skill.argumentHint)}`);
  lines.push('---', '', String(skill.body || '').trim(), '');

  const file = path.join(dir, `${slug}.md`);
  fs.writeFileSync(file, lines.join('\n'), 'utf-8');
  return { ok: true, name: slug, path: file };
}

/** Delete a user skill (bundled skills live elsewhere and are never touched). */
function deleteSkill(name) {
  const file = path.join(userDir(), `${slugify(name)}.md`);
  if (!fs.existsSync(file)) return { ok: false, error: 'not_found' };
  fs.rmSync(file);
  return { ok: true };
}

module.exports = {
  listSkills,
  getSkill,
  renderSkill,
  saveSkill,
  deleteSkill,
  slugify,
  userDir,
  ensureUserDir,
  BUNDLED_DIR
};
