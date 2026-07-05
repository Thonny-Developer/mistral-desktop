// Auto-update through GitHub Releases (electron-updater).
// Flow: check on startup → ask before downloading → offer to restart when ready.
const { app, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

let initialized = false;

// getWindow() lets dialogs attach to the main window so they show modally.
function initAutoUpdater(getWindow) {
  // Nothing to update in dev: there's no packaged build and no update metadata.
  if (!app.isPackaged || initialized) return;
  initialized = true;

  autoUpdater.autoDownload = false;        // wait for the user to confirm
  autoUpdater.autoInstallOnAppQuit = true; // safety net if they pick "Позже"

  const win = () => (typeof getWindow === 'function' ? getWindow() : undefined);

  autoUpdater.on('update-available', async (info) => {
    const { response } = await dialog.showMessageBox(win(), {
      type: 'info',
      buttons: ['Скачать', 'Позже'],
      defaultId: 0,
      cancelId: 1,
      title: 'Доступно обновление',
      message: `Вышла новая версия Mistral Desktop (${info.version})`,
      detail: 'Скачать обновление сейчас? Установка произойдёт при перезапуске.'
    });
    if (response === 0) autoUpdater.downloadUpdate().catch(logError);
  });

  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox(win(), {
      type: 'info',
      buttons: ['Перезапустить', 'Позже'],
      defaultId: 0,
      cancelId: 1,
      title: 'Обновление готово',
      message: `Версия ${info.version} загружена`,
      detail: 'Перезапустить приложение, чтобы установить обновление?'
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on('error', logError);

  autoUpdater.checkForUpdates().catch(logError);
}

// Manual "check for updates" triggered from the About page. Resolves with a
// status the renderer can show inline. If an update exists, the listeners set up
// in initAutoUpdater() still pop the download dialog — this just reports back.
function checkForUpdatesManually() {
  if (!app.isPackaged) return Promise.resolve({ status: 'dev' });
  initAutoUpdater(); // make sure dialog listeners exist (no-op once initialized)

  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      autoUpdater.off('update-available', onAvailable);
      autoUpdater.off('update-not-available', onNone);
      autoUpdater.off('error', onError);
      clearTimeout(timer);
      resolve(val);
    };
    const onAvailable = (info) => finish({ status: 'available', version: info.version });
    const onNone = (info) => finish({ status: 'latest', version: (info && info.version) || app.getVersion() });
    const onError = (err) => finish({ status: 'error', message: (err && err.message) || String(err) });

    autoUpdater.once('update-available', onAvailable);
    autoUpdater.once('update-not-available', onNone);
    autoUpdater.once('error', onError);
    const timer = setTimeout(() => finish({ status: 'error', message: 'timeout' }), 30000);

    autoUpdater.checkForUpdates().catch(onError);
  });
}

function logError(err) {
  console.error('[updater]', err == null ? 'unknown error' : (err.stack || err).toString());
}

module.exports = { initAutoUpdater, checkForUpdatesManually };
