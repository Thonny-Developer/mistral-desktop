'use strict';

/**
 * Telegram plugin — a remote frontend to the agent engine.
 *
 * Flow:
 *   1. The user opens the bot and sends /start → the bot asks for the access
 *      password configured in Settings (host.config.password).
 *   2. Once the password matches, the chat is authorized (per chat_id) and a
 *      menu of permission levels + a folder picker is shown.
 *   3. Any text the authorized user sends is run through host.runAgent — the
 *      same engine the in-app chat uses — and the final answer is sent back.
 *   4. When the agent needs a confirmation (default mode: plan / file / shell /
 *      web), the bot sends an inline ✅/❌ button; the answer resolves the
 *      pending approval and the button message is deleted.
 *
 * No third-party dependency: the Telegram Bot API is driven with the global
 * fetch via long polling (getUpdates).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const API = 'https://api.telegram.org/bot';
const PERMISSION_MODES = ['default', 'tools-bypass', 'autopilot'];
const PERMISSION_LABELS = {
  default: 'Default · с подтверждениями',
  'tools-bypass': 'Tools Bypass · спрашивает только команды',
  autopilot: 'Autopilot · без подтверждений'
};
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;
const TG_LIMIT = 3900; // Telegram hard limit is 4096; leave headroom
const MAX_HISTORY = 20;

module.exports = (host) => {
  const token = String(host.config.botToken || '').trim();
  const password = String(host.config.password || '').trim();

  let running = false;
  let pollController = null;
  let offset = 0;

  // chat_id → conversation/auth state
  const chats = new Map();
  const chatState = (id) => {
    if (!chats.has(id)) {
      chats.set(id, {
        authorized: false, awaitingPassword: false,
        permissionMode: 'default', busy: false, history: [], runController: null
      });
    }
    return chats.get(id);
  };

  // pending confirmations: token → { resolve, chatId, messageId, timer }
  const pendingConfirm = new Map();
  let confirmSeq = 0;

  // folder-picker token map (callback_data is capped at 64 bytes, so we can't
  // put absolute paths in it — map short ids to real paths instead)
  const pickerPaths = new Map();
  let pickerSeq = 0;
  const tokenForPath = (p) => {
    if (pickerPaths.size > 4000) pickerPaths.clear(); // guard against unbounded growth
    const t = String(++pickerSeq);
    pickerPaths.set(t, p);
    return t;
  };

  /* ---------------- Telegram API ---------------- */
  async function tg(method, params, signal) {
    const res = await fetch(`${API}${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {}),
      signal
    });
    const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    // deleteMessage often legitimately fails (can't delete user msgs / already
    // gone); editMessageText "not modified" fires when a menu is re-tapped with
    // the same state — neither is worth logging.
    const benign = method === 'deleteMessage' || /not modified/i.test(data.description || '');
    if (!data.ok && !benign) host.log(`Telegram ${method}: ${data.description || res.status}`);
    return data;
  }

  const send = (chatId, text, extra = {}) => tg('sendMessage', { chat_id: chatId, text, ...extra });
  const editText = (chatId, messageId, text, extra = {}) =>
    tg('editMessageText', { chat_id: chatId, message_id: messageId, text, ...extra });
  const deleteMsg = (chatId, messageId) => tg('deleteMessage', { chat_id: chatId, message_id: messageId });
  const answerCb = (id, text) => tg('answerCallbackQuery', { callback_query_id: id, text: text || '' });

  async function sendLong(chatId, text) {
    const body = (text || '').trim() || '(пустой ответ)';
    for (let i = 0; i < body.length; i += TG_LIMIT) {
      await send(chatId, body.slice(i, i + TG_LIMIT));
    }
  }

  /** Drop the collapsible reasoning block so Telegram users see only the answer. */
  const stripReasoning = (s) => String(s || '').replace(/<details[\s\S]*?<\/details>/gi, '').replace(/^\s+/, '');

  /* ---------------- menus ---------------- */
  function mainMenuKeyboard(st) {
    const dot = (m) => (st.permissionMode === m ? '🟢 ' : '⚪ ');
    return {
      inline_keyboard: PERMISSION_MODES.map((m) => [{ text: dot(m) + PERMISSION_LABELS[m], callback_data: `perm:${m}` }])
    };
  }

  function menuText(st) {
    const wd = host.getWorkingDir();
    return [
      '⚙️ Меню управления',
      '',
      `Уровень прав: ${PERMISSION_LABELS[st.permissionMode]}`,
      `Рабочая папка: ${wd || '(не выбрана — задайте командой /folder)'}`,
      '',
      wd
        ? 'Просто напишите задачу — я выполню её на компьютере и отвечу здесь.'
        : '⚠️ Пока папка не выбрана, действия на компьютере недоступны. Выберите её командой /folder.'
    ].join('\n');
  }

  function dirKeyboard(absPath) {
    const rows = [];
    let entries = [];
    try {
      entries = fs.readdirSync(absPath, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .slice(0, 30);
    } catch { /* unreadable dir → just offer nav */ }
    for (const e of entries) {
      rows.push([{ text: `📂 ${e.name}`, callback_data: `dir:${tokenForPath(path.join(absPath, e.name))}` }]);
    }
    const parent = path.dirname(absPath);
    const nav = [];
    if (parent && parent !== absPath) nav.push({ text: '⬆ Наверх', callback_data: `dir:${tokenForPath(parent)}` });
    nav.push({ text: '✅ Выбрать эту', callback_data: `dirpick:${tokenForPath(absPath)}` });
    rows.push(nav);
    return { inline_keyboard: rows };
  }

  /* ---------------- approvals (inline confirm buttons) ---------------- */
  function approvalText(payload) {
    switch (payload.type) {
      case 'bash-confirmation-required': return `🖥 Выполнить команду в терминале?\n\n${payload.command || ''}`;
      case 'web-confirmation-required': return `🌐 Разрешить доступ в интернет?\n\n${payload.target || ''}`;
      case 'tool-confirmation-required': return `✏️ Выполнить «${payload.toolName}»?${payload.path ? `\n\n${payload.path}` : ''}`;
      case 'plan-review-required': return `📋 Утвердить план из ${payload.todoCount} шаг(ов)?`;
      default: return 'Подтвердить действие?';
    }
  }

  function makeApproval(chatId) {
    return (payload) => new Promise((resolve) => {
      const tk = String(++confirmSeq);
      const entry = { resolve, chatId, messageId: null, timer: null };
      entry.timer = setTimeout(() => {
        if (pendingConfirm.delete(tk)) {
          if (entry.messageId) deleteMsg(chatId, entry.messageId);
          send(chatId, '⌛ Время на подтверждение истекло — действие отклонено.');
          resolve(false);
        }
      }, CONFIRM_TIMEOUT_MS);
      pendingConfirm.set(tk, entry);
      const reply_markup = {
        inline_keyboard: [[
          { text: '✅ Да', callback_data: `confirm:${tk}:y` },
          { text: '❌ Нет', callback_data: `confirm:${tk}:n` }
        ]]
      };
      send(chatId, approvalText(payload), { reply_markup }).then((res) => {
        entry.messageId = res?.result?.message_id || null;
      });
    });
  }

  /* ---------------- running a task ---------------- */
  async function runTask(chatId, st, text) {
    st.busy = true;
    const controller = new AbortController();
    st.runController = controller;
    st.history.push({ role: 'user', content: text });
    if (st.history.length > MAX_HISTORY) st.history = st.history.slice(-MAX_HISTORY);

    tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    const typing = setInterval(
      () => tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}), 4000);

    let r;
    try {
      r = await host.runAgent({
        messages: st.history.slice(),
        permissionMode: st.permissionMode,
        requestApproval: makeApproval(chatId),
        onEvent: (ev) => {
          if (ev.type === 'tool' && ev.summary) host.log(`[${chatId}] 🔧 ${ev.name}: ${ev.summary}`);
        },
        signal: controller.signal
      });
    } catch (e) {
      r = { ok: false, error: e.message };
    } finally {
      clearInterval(typing);
      st.busy = false;
      st.runController = null;
    }

    if (!r || !r.ok) {
      if (r && r.error === 'no-workdir') {
        await send(chatId, '📁 Сначала выберите рабочую папку:', { reply_markup: dirKeyboard(os.homedir()) });
        return;
      }
      await send(chatId, `⚠️ Ошибка: ${(r && r.error) || 'неизвестно'}`);
      return;
    }
    const answer = stripReasoning(r.content) || '(пустой ответ)';
    st.history.push({ role: 'assistant', content: r.content || answer });
    await sendLong(chatId, answer);
  }

  /* ---------------- update handlers ---------------- */
  async function onMessage(msg) {
    const chatId = msg.chat?.id;
    if (chatId == null) return;
    const text = String(msg.text || '').trim();
    const st = chatState(chatId);

    if (!password) { await send(chatId, '⚠️ Плагин не настроен: в приложении не задан пароль доступа.'); return; }

    if (text === '/start') {
      if (st.authorized) { await send(chatId, menuText(st), { reply_markup: mainMenuKeyboard(st) }); return; }
      st.awaitingPassword = true;
      await send(chatId, '🔒 Введите пароль для доступа к боту:');
      return;
    }

    if (!st.authorized) {
      if (st.awaitingPassword && text) {
        deleteMsg(chatId, msg.message_id); // hide the password (best-effort; bots can't delete user msgs in all chats)
        if (text === password) {
          st.authorized = true;
          st.awaitingPassword = false;
          await send(chatId, '✅ Доступ открыт.\n\n' + menuText(st), { reply_markup: mainMenuKeyboard(st) });
        } else {
          await send(chatId, '❌ Неверный пароль. Отправьте /start, чтобы попробовать снова.');
        }
      } else {
        st.awaitingPassword = true;
        await send(chatId, '🔒 Введите пароль для доступа к боту (или /start):');
      }
      return;
    }

    // authorized
    if (!text) return;
    if (st.busy) { await send(chatId, '⏳ Дождитесь завершения текущей задачи.'); return; }
    if (text === '/folder') {
      await send(chatId, '📁 Выберите рабочую папку:', { reply_markup: dirKeyboard(host.getWorkingDir() || os.homedir()) });
      return;
    }
    // Until a folder is chosen, everything that touches the computer is gated off.
    if (!host.getWorkingDir()) {
      await send(chatId, '📁 Сначала выберите рабочую папку командой /folder — без неё действия на компьютере недоступны.');
      return;
    }
    await runTask(chatId, st, text);
  }

  async function onCallback(cb) {
    const data = String(cb.data || '');
    const chatId = cb.message?.chat?.id;
    const messageId = cb.message?.message_id;
    const st = chatState(chatId);

    // Confirmations are handled first — they only ever arise from an authorized run.
    if (data.startsWith('confirm:')) {
      const [, tk, yn] = data.split(':');
      const entry = pendingConfirm.get(tk);
      await answerCb(cb.id, yn === 'y' ? 'Подтверждено' : 'Отклонено');
      if (entry) {
        pendingConfirm.delete(tk);
        clearTimeout(entry.timer);
        await deleteMsg(chatId, messageId);
        entry.resolve(yn === 'y');
      }
      return;
    }

    if (!st.authorized) { await answerCb(cb.id, 'Сначала /start и пароль'); return; }

    if (data.startsWith('perm:')) {
      const mode = data.slice(5);
      if (PERMISSION_MODES.includes(mode)) st.permissionMode = mode;
      await answerCb(cb.id, `Режим: ${PERMISSION_LABELS[st.permissionMode]}`);
      await editText(chatId, messageId, menuText(st), { reply_markup: mainMenuKeyboard(st) });
      return;
    }

    if (data.startsWith('dirpick:')) {
      const p = pickerPaths.get(data.slice(8));
      await answerCb(cb.id, 'Папка выбрана');
      if (p) {
        host.setWorkingDir(p);
        await deleteMsg(chatId, messageId);
        await send(chatId, `📁 Рабочая папка установлена:\n${p}`);
      }
      return;
    }

    if (data.startsWith('dir:')) {
      const p = pickerPaths.get(data.slice(4));
      await answerCb(cb.id, '');
      if (p) await editText(chatId, messageId, `📁 ${p}\n\nВыберите подпапку или подтвердите выбор:`, { reply_markup: dirKeyboard(p) });
      return;
    }

    await answerCb(cb.id, '');
  }

  /* ---------------- polling loop ---------------- */
  async function poll() {
    while (running) {
      pollController = new AbortController();
      try {
        const data = await tg('getUpdates',
          { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] },
          pollController.signal);
        if (data?.ok && Array.isArray(data.result)) {
          for (const u of data.result) {
            offset = u.update_id + 1;
            try {
              if (u.message) await onMessage(u.message);
              else if (u.callback_query) await onCallback(u.callback_query);
            } catch (e) { host.log(`Ошибка обработки обновления: ${e.message}`); }
          }
        }
      } catch (e) {
        if (!running || e.name === 'AbortError') break;
        host.log(`Сбой опроса: ${e.message}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  /* ---------------- lifecycle ---------------- */
  async function start() {
    if (!token) throw new Error('Не задан Bot Token (откройте настройки плагина).');
    const me = await tg('getMe');
    if (!me?.ok) throw new Error('Неверный Bot Token или нет подключения к Telegram.');
    running = true;
    tg('setMyCommands', { commands: [
      { command: 'start', description: 'Меню и уровень прав' },
      { command: 'folder', description: 'Выбрать рабочую папку' }
    ] }).catch(() => {});
    host.log(`Бот @${me.result.username} запущен. Отправьте /start в Telegram.`);
    if (!password) host.log('Внимание: пароль доступа не задан — задайте его в настройках.');
    poll();
  }

  async function stop() {
    running = false;
    if (pollController) { try { pollController.abort(); } catch { /* noop */ } }
    for (const st of chats.values()) { if (st.runController) { try { st.runController.abort(); } catch { /* noop */ } } }
    host.log('Бот остановлен.');
  }

  return { start, stop };
};
