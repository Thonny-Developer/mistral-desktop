/* Boot splash controller.
 *
 * The markup lives in index.html (#splash) so it paints on the very first
 * frame — no module has to load first. This module just drives it: it
 * crossfades the status line through the boot phases, advances the progress
 * bar, then reveals the app underneath and fades the splash away.
 *
 * The screen is a single flat fill in the user's theme color (var(--bg)); all
 * the life comes from the pulsing mark, the crossfading status text and the
 * progress bar — see the `.splash*` rules in base.css. */

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createSplash() {
  const root = document.getElementById('splash');
  const statusEl = document.getElementById('splashStatus');
  const barEl = document.getElementById('splashBar');
  let pct = 0;

  // Crossfade the status line to a new phrase: fade the old text out, swap the
  // text while invisible, fade the new text in.
  async function setStatus(text) {
    if (!statusEl) return;
    statusEl.classList.add('swap');
    await wait(170);
    statusEl.textContent = text;
    statusEl.classList.remove('swap');
  }

  // The bar only ever moves forward, so phases can report progress freely.
  function setProgress(p) {
    pct = Math.max(pct, Math.min(100, p));
    if (barEl) barEl.style.width = pct + '%';
  }

  return {
    setProgress,

    /**
     * Show a boot phase: crossfade to `text`, advance the bar to `targetPct`
     * and hold for at least `minDwell` ms so the phase is actually readable
     * even when the underlying work finishes instantly.
     */
    async phase(text, targetPct, minDwell = 460) {
      const started = Date.now();
      await setStatus(text);
      if (typeof targetPct === 'number') setProgress(targetPct);
      const rest = minDwell - (Date.now() - started);
      if (rest > 0) await wait(rest);
    },

    /** Fill the bar, reveal the app with its entrance animation, then fade the
     *  splash out and drop it from the DOM. */
    async finish() {
      setProgress(100);
      await wait(260);
      const app = document.querySelector('.app');
      if (app) {
        app.classList.remove('pre-boot');
        app.classList.add('booted');
      }
      root?.classList.add('leaving');
      await wait(480);
      root?.remove();
    }
  };
}
