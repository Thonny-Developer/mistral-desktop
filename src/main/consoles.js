'use strict';

/**
 * Persistent shell sessions ("consoles") for the agent.
 *
 * Unlike one-shot exec_bash, a console is a long-lived shell process: the
 * working directory, environment and shell state carry over between commands.
 * The agent can open several, run commands in any of them, and close the ones
 * it no longer needs.
 *
 * Capturing a single command's output from a long-lived shell is done with a
 * unique end-marker: after the command we print `MARKER:<exit code>` and read
 * stdout until that marker appears. A non-interactive shell does not echo its
 * input, so the captured buffer is just the command's own output.
 *
 * A manager instance is scoped to one agent run and `closeAll()`-ed afterwards,
 * so no shells leak between requests.
 */

const { spawn } = require('child_process');
const fs = require('fs');

const DEFAULT_TIMEOUT = 120_000; // 2 min per command

function pickShell() {
  if (process.platform === 'win32') return { cmd: process.env.COMSPEC || 'cmd.exe', args: [] };
  return fs.existsSync('/bin/bash') ? { cmd: '/bin/bash', args: [] } : { cmd: '/bin/sh', args: [] };
}

function createConsoleManager() {
  const sessions = new Map();
  let counter = 0;

  function open(cwd) {
    const { cmd, args } = pickShell();
    const proc = spawn(cmd, args, { cwd: cwd || undefined, env: process.env });
    const id = `console-${++counter}`;
    const s = { id, proc, cwd: cwd || '', alive: true };
    proc.on('exit', () => { s.alive = false; });
    proc.on('error', () => { s.alive = false; });
    sessions.set(id, s);
    return s;
  }

  function exec(id, command, { signal, timeout = DEFAULT_TIMEOUT } = {}) {
    const s = sessions.get(id);
    if (!s) return Promise.resolve({ error: 'not_found', output: `Консоль ${id} не найдена.` });
    if (!s.alive) return Promise.resolve({ error: 'dead', output: `Консоль ${id} уже закрыта.` });
    if (signal?.aborted) return Promise.resolve({ aborted: true, output: '' });

    return new Promise((resolve) => {
      const marker = `__MIST_${id}_${Date.now().toString(36)}__`;
      const markerRe = new RegExp(`${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(-?\\d+)`);
      let buf = '';
      let settled = false;

      const onData = (chunk) => {
        buf += chunk.toString('utf8');
        if (markerRe.test(buf)) settle();
      };
      const settle = (extra) => {
        if (settled) return;
        settled = true;
        s.proc.stdout.off('data', onData);
        s.proc.stderr.off('data', onData);
        clearTimeout(timer);
        if (signal) { try { signal.removeEventListener('abort', onAbort); } catch { /* noop */ } }
        const m = markerRe.exec(buf);
        const code = m ? parseInt(m[1], 10) : null;
        const output = (m ? buf.slice(0, m.index) : buf).replace(/\s+$/, '');
        resolve({ code, output, ...(extra || {}) });
      };
      const onAbort = () => settle({ aborted: true });
      const timer = setTimeout(() => settle({ timedOut: true }), timeout);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      s.proc.stdout.on('data', onData);
      s.proc.stderr.on('data', onData);

      const line = process.platform === 'win32'
        ? `${command}\r\necho ${marker}:%errorlevel%\r\n`
        : `${command}\nprintf '\\n${marker}:%s\\n' "$?"\n`;
      try { s.proc.stdin.write(line); } catch (e) { settle({ error: e.message }); }
    });
  }

  function close(id) {
    const s = sessions.get(id);
    if (!s) return false;
    try { s.proc.kill(); } catch { /* already gone */ }
    s.alive = false;
    sessions.delete(id);
    return true;
  }

  function list() {
    return [...sessions.values()].map((s) => ({ id: s.id, cwd: s.cwd, alive: s.alive }));
  }

  function closeAll() {
    for (const s of sessions.values()) { try { s.proc.kill(); } catch { /* noop */ } }
    sessions.clear();
  }

  return { open, exec, close, list, closeAll };
}

module.exports = { createConsoleManager };
