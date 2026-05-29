# Mistral CLI

A dark, terminal-native desktop client for the Mistral AI API — built with
Electron and vanilla JavaScript. Inspired by thonny_dev:
monospace type, minimal chrome, amber (`#FF8205`) used sparingly.

![Chat](../design_bundle/mistral-cli/project/screenshots/chat-a.png)

## Features

- **Chat** — streaming SSE responses rendered token-by-token with a live
  cursor, GitHub-flavored markdown, and syntax-highlighted code blocks with
  copy buttons. Smart auto-scroll (pauses when you scroll up), abortable
  generation, and a live token counter.
- **Settings** — two-pane layout (API / Model / Output / Interface / Shortcuts).
  Secure API-key storage (`safeStorage`), connection test with latency, custom
  range sliders for temperature & top-p, theme switching (Dark / OLED / Dim),
  and adjustable font size — all applied immediately.
- **History** — dense, searchable table of saved sessions with row selection,
  bulk export/delete, and per-row open/export (`.md` / `.json`) / delete.
- **System Prompt** — preset sidebar + monospace editor with a synced
  line-number gutter and live char/token counts. Ships with General, Code
  Assistant, Translator, and Analyst presets.
- **About** — live API status ping, current model + capabilities, keyboard
  reference, and external links.
- **Command palette** (`Ctrl+K`) and global keyboard shortcuts throughout.
- **Agent tools** — the model receives a tool catalogue in
  its context and acts in a loop: pick a working folder, list/read/write/delete
  files (sandboxed to the chosen folder), create and complete todos, and write
  to long-term memory. Tool calls are parsed from `<action>{…}</action>` blocks,
  executed in the main process, and their results are fed back to the model
  until it produces a final answer. Tool activity renders inline in the chat;
  the working folder and a `todos N/M` chip live in the chat header.

### Agent protocol

The model emits actions like:

```
<action>{"tool":"write_file","path":"src/app.js","content":"…"}</action>
```

Tools: `set_working_folder`, `list_files`, `read_file`, `write_file`,
`delete_file`, `add_todo`, `complete_todo`, `list_todos`, `remember`.
All file paths are sandboxed to the selected working folder. The loop is
capped at 10 tool turns per request.

## Architecture

```
src/
├── main/
│   ├── main.js      Electron main: frameless window, window-state persistence,
│   │                electron-store IPC, safeStorage API key, export dialog
│   ├── preload.js   Context bridge — the only IPC surface (contextIsolation)
│   └── mistral.js   Mistral API service: native fetch, SSE streaming, abort
└── renderer/
    ├── index.html   App shell (custom titlebar + nav rail + content)
    ├── app.js       Router / page manager, shortcuts, command palette
    ├── shared.js    Store helpers, toasts, modals, markdown rendering
    ├── models.js    Model catalogue + capabilities
    ├── pages/       chat · settings · history · system-prompt · about
    ├── styles/      base · layout · components (CSS custom properties)
    └── vendor/      bundled marked + highlight.js (built by esbuild)
```

Security: `contextIsolation: true`, `nodeIntegration: false`, a strict CSP, and
all Node/API access funnelled through namespaced IPC channels
(`store:*`, `apikey:*`, `mistral:*`, `window:*`, `session:*`).

## Getting started

```bash
npm install        # also bundles vendor libs via the postinstall hook
npm start          # launch the app
npm run dev        # launch with DevTools + renderer console forwarding
```

Add your Mistral API key in **Settings → API**, then **Test connection**.

## Building (Windows)

```bash
npm run dist:win   # NSIS installer + portable .exe in dist/
```

Optionally drop a `build/icon.ico` first (see `build/README.md`).

### Vendor bundle

`marked` and a curated set of `highlight.js` languages are bundled into
`src/renderer/vendor/libs.js` by esbuild (highlight.js's ESM entry chains to
CommonJS internals a browser ESM loader can't consume directly). This runs
automatically on `postinstall`; rebuild manually with:

```bash
npm run build:vendor
```

## Auto-update

`electron-updater` is a dependency and the `publish` block in
`electron-builder.config.js` is stubbed for a generic provider. Wire up a real
feed URL and call `autoUpdater.checkForUpdatesAndNotify()` in `main.js` to
enable updates.

npm run dist:win
npm run dist:linux