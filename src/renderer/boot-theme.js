/* Runs synchronously in <head> before the first paint. Applies the persisted
 * theme and font size so the boot splash (and the app) render in the user's
 * theme from the very first frame — no dark-to-light flash on startup.
 *
 * Plain (non-module) script on purpose: it must execute during head parsing,
 * before <body> is painted. The real settings still come from electron-store in
 * applyTheme(); this is just the synchronous mirror kept in localStorage. */
(function () {
  try {
    var theme = localStorage.getItem('theme');
    if (theme) document.documentElement.dataset.theme = theme;
    var fontSize = localStorage.getItem('fontSize');
    if (fontSize) document.documentElement.style.setProperty('--font-size', fontSize + 'px');
  } catch (e) {
    /* localStorage unavailable — fall back to the default theme in the markup */
  }
})();
