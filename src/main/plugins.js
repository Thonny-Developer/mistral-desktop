'use strict';

/**
 * Plugin system (main process).
 *
 * A plugin is a folder with a `plugin.json` manifest and an `index.js` entry
 * that exports a factory:  `module.exports = (host) => ({ start(), stop() })`.
 * Plugins are the integration layer on top of the agent: a background worker
 * (e.g. a Telegram bot) that drives the SAME engine the in-app chat uses — by
 * calling `host.runAgent(...)` — and lives entirely in the main process so it
 * has network access, Node builtins and the store.
 *
 * Discovery layers (user overrides bundled by id):
 *   1. bundled — shipped with the app (src/main/plugins/<id>/)
 *   2. user    — <userData>/plugins/<id>/   (drop-in folder)
 *
 * Persisted in electron-store under `plugins`:
 *   { [id]: { config: {...}, enabled: boolean } }
 * `enabled` doubles as the autostart flag — a plugin the user started is
 * brought back up on the next launch.
 */

const fs = require('fs');
const path = require('path');

const BUNDLED_DIR = path.join(__dirname, 'plugins');

/**
 * @param {Object} o
 * @param {Object} o.store        electron-store instance
 * @param {string} o.userDataDir  app.getPath('userData')
 * @param {Function} o.runAgent   injected bridge to the agent engine (avoids a
 *                                 circular require of ./agent here)
 * @param {Function} o.getWindow  () => BrowserWindow|null
 */
function createManager({ store, userDataDir, runAgent, getWindow }) {
  const USER_DIR = path.join(userDataDir, 'plugins');
  const listeners = new Set();
  // id → { instance, running, error }
  const live = new Map();

  const emit = (ev) => { for (const cb of listeners) { try { cb(ev); } catch { /* noop */ } } };
  const on = (cb) => { listeners.add(cb); return () => listeners.delete(cb); };

  function ensureUserDir() {
    try { fs.mkdirSync(USER_DIR, { recursive: true }); } catch { /* noop */ }
    return USER_DIR;
  }

  /* ---------------- discovery ---------------- */
  function readDir(dir) {
    const out = [];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const folder = path.join(dir, e.name);
      const manifestPath = path.join(folder, 'plugin.json');
      const indexPath = path.join(folder, 'index.js');
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')); } catch { continue; }
      if (!fs.existsSync(indexPath)) continue;
      out.push({ id: String(manifest.id || e.name), manifest, dir: folder, indexPath });
    }
    return out;
  }

  /** id → {id, manifest, dir, indexPath} — user folder overrides bundled. */
  function scan() {
    const map = new Map();
    for (const p of readDir(BUNDLED_DIR)) map.set(p.id, p);
    for (const p of readDir(USER_DIR)) map.set(p.id, p);
    return map;
  }

  /* ---------------- persisted state ---------------- */
  const allState = () => store.get('plugins') || {};
  const getState = (id) => allState()[id] || { config: {}, enabled: false };
  function setState(id, patch) {
    const all = allState();
    all[id] = { ...getState(id), ...patch };
    store.set('plugins', all);
    return all[id];
  }
  const getConfig = (id) => getState(id).config || {};
  const setConfig = (id, config) => { setState(id, { config: config || {} }); return getConfig(id); };

  const status = (id) => {
    const l = live.get(id);
    return { running: !!(l && l.running), error: (l && l.error) || null };
  };

  /* ---------------- host bridge handed to a plugin ---------------- */
  function buildHost(id) {
    return {
      id,
      config: getConfig(id),
      log: (line) => emit({ id, type: 'log', line: String(line), at: Date.now() }),
      getWorkingDir: () => store.get('workingDir') || '',
      setWorkingDir: (dir) => { store.set('workingDir', dir || ''); return store.get('workingDir') || ''; },
      runAgent: (opts) => runAgent(opts),
      getWindow
    };
  }

  /* ---------------- lifecycle ---------------- */
  async function start(id) {
    const reg = scan().get(id);
    if (!reg) return { ok: false, error: 'плагин не найден' };
    if (live.get(id)?.running) return { ok: true };
    let instance;
    try {
      // Drop the cached module so config edits are picked up on a restart.
      delete require.cache[require.resolve(reg.indexPath)];
      const factory = require(reg.indexPath);
      instance = typeof factory === 'function' ? factory(buildHost(id)) : factory;
      await instance.start?.();
    } catch (e) {
      live.set(id, { instance: null, running: false, error: e.message });
      emit({ id, type: 'status', running: false, error: e.message });
      emit({ id, type: 'log', line: `Ошибка запуска: ${e.message}`, at: Date.now() });
      return { ok: false, error: e.message };
    }
    live.set(id, { instance, running: true, error: null });
    setState(id, { enabled: true });
    emit({ id, type: 'status', running: true, error: null });
    return { ok: true };
  }

  async function stop(id) {
    const l = live.get(id);
    setState(id, { enabled: false });
    if (l?.instance) {
      try { await l.instance.stop?.(); }
      catch (e) { emit({ id, type: 'log', line: `Ошибка остановки: ${e.message}`, at: Date.now() }); }
    }
    live.set(id, { instance: null, running: false, error: null });
    emit({ id, type: 'status', running: false, error: null });
    return { ok: true };
  }

  function list() {
    return [...scan().values()].map(({ id, manifest }) => ({
      id,
      name: manifest.name || id,
      description: manifest.description || '',
      version: manifest.version || '',
      settings: Array.isArray(manifest.settings) ? manifest.settings : [],
      config: getConfig(id),
      enabled: getState(id).enabled,
      ...status(id)
    }));
  }

  /** Bring back up every plugin the user had enabled (autostart). */
  function initAutostart() {
    ensureUserDir();
    for (const id of scan().keys()) {
      if (getState(id).enabled) start(id);
    }
  }

  async function stopAll() {
    for (const id of [...live.keys()]) {
      const l = live.get(id);
      if (l?.instance) { try { await l.instance.stop?.(); } catch { /* noop */ } }
    }
  }

  const openDir = () => ensureUserDir();

  return { on, list, start, stop, getConfig, setConfig, initAutostart, stopAll, openDir, USER_DIR };
}

module.exports = { createManager, BUNDLED_DIR };
