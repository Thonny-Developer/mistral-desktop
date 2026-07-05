'use strict';

/**
 * Context bridge — the ONLY surface the renderer can touch.
 *
 * Everything is funnelled through namespaced IPC channels:
 *   store:*     persistent settings/history
 *   apikey:*    secure API key (never exposes the encrypted blob)
 *   mistral:*   streaming chat + connection test + model list
 *   window:*    custom titlebar controls
 *   session:*   export to disk
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /* ---- persistent store ---- */
  store: {
    get: (key) => ipcRenderer.invoke('store:get', key),
    set: (key, value) => ipcRenderer.invoke('store:set', key, value),
    delete: (key) => ipcRenderer.invoke('store:delete', key)
  },

  /* ---- long-term memory (memory.md) ---- */
  memory: {
    get: () => ipcRenderer.invoke('memory:get'),
    set: (content) => ipcRenderer.invoke('memory:set', content),
    path: () => ipcRenderer.invoke('memory:path')
  },

  /* ---- agent working folder ---- */
  workspace: {
    get: () => ipcRenderer.invoke('workspace:get'),
    pick: () => ipcRenderer.invoke('workspace:pick'),
    clear: () => ipcRenderer.invoke('workspace:clear'),
    set: (dir) => ipcRenderer.invoke('workspace:set', dir)
  },

  /* ---- agent todo list ---- */
  todos: {
    get: () => ipcRenderer.invoke('todos:get'),
    toggle: (id) => ipcRenderer.invoke('todos:toggle', id),
    clear: () => ipcRenderer.invoke('todos:clear'),
    set: (todos) => ipcRenderer.invoke('todos:set', todos)
  },

  /* ---- secure API key ---- */
  apiKey: {
    get: () => ipcRenderer.invoke('apikey:get'),
    has: () => ipcRenderer.invoke('apikey:has'),
    set: (key) => ipcRenderer.invoke('apikey:set', key),
    isEncrypted: () => ipcRenderer.invoke('apikey:encrypted')
  },

  /* ---- Mistral API ---- */
  mistral: {
    // Fire a streaming request; deltas/done/error arrive via onStream().
    send: (payload) => ipcRenderer.send('mistral:send', payload),
    abort: () => ipcRenderer.send('mistral:abort'),
    // Answer a pending plan/tool/bash approval request from the agent loop.
    respond: (approved) => ipcRenderer.send('agent:respond', approved),
    test: () => ipcRenderer.invoke('mistral:test'),
    models: () => ipcRenderer.invoke('mistral:models'),
    // Returns an unsubscribe fn so pages can clean up listeners.
    onStream: (cb) => {
      const handler = (_e, msg) => cb(msg);
      ipcRenderer.on('mistral:stream', handler);
      return () => ipcRenderer.removeListener('mistral:stream', handler);
    }
  },

  /* ---- skills (Markdown playbooks) ---- */
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    render: (name, args) => ipcRenderer.invoke('skills:render', name, args),
    save: (skill) => ipcRenderer.invoke('skills:save', skill),
    remove: (name) => ipcRenderer.invoke('skills:delete', name),
    dir: () => ipcRenderer.invoke('skills:dir'),
    openDir: () => ipcRenderer.invoke('skills:openDir')
  },

  /* ---- plugins (background integrations, e.g. Telegram bot) ---- */
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    start: (id) => ipcRenderer.invoke('plugins:start', id),
    stop: (id) => ipcRenderer.invoke('plugins:stop', id),
    getConfig: (id) => ipcRenderer.invoke('plugins:getConfig', id),
    setConfig: (id, config) => ipcRenderer.invoke('plugins:setConfig', id, config),
    openDir: () => ipcRenderer.invoke('plugins:openDir'),
    // Live log/status events; returns an unsubscribe fn.
    onEvent: (cb) => {
      const handler = (_e, ev) => cb(ev);
      ipcRenderer.on('plugins:event', handler);
      return () => ipcRenderer.removeListener('plugins:event', handler);
    }
  },

  /* ---- attachment text extraction (docs/binaries dropped in the composer) ---- */
  docs: {
    extract: (payload) => ipcRenderer.invoke('docs:extract', payload)
  },

  /* ---- project file support ---- */
  project: {
    read: () => ipcRenderer.invoke('project:read'),
    init: () => ipcRenderer.invoke('project:init'),
    exists: () => ipcRenderer.invoke('project:exists'),
    append: (notes) => ipcRenderer.invoke('project:append', notes)
  },

  /* ---- context-window usage ---- */
  context: {
    stats: () => ipcRenderer.invoke('context:stats')
  },

  /* ---- window controls (custom titlebar) ---- */
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximizeToggle: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onMaximizeChange: (cb) => {
      const handler = (_e, val) => cb(val);
      ipcRenderer.on('window:maximized', handler);
      return () => ipcRenderer.removeListener('window:maximized', handler);
    }
  },

  /* ---- export ---- */
  session: {
    export: (session, format) => ipcRenderer.invoke('session:export', { session, format })
  },

  /* ---- app info + auto-update ---- */
  app: {
    version: () => ipcRenderer.invoke('app:version')
  },
  updates: {
    check: () => ipcRenderer.invoke('updates:check')
  }
});
