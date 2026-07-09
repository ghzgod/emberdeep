import { Game } from './game.js';

const game = new Game();
if (import.meta.env.DEV) window.__game = game; // dev-only debug handle; stripped from prod build
game.boot();

// title screen: platform-appropriate controls + build stamp
try {
  if (game.touch.enabled) {
    // touch devices have their own button drawer, no desktop action bar
    document.getElementById('action-bar')?.classList.add('hidden');
  }
  if (typeof __BUILD_DATE__ !== 'undefined') {
    // Human-readable "how long ago this build was made", computed at page load
    // from the baked-in build timestamp.
    const timeAgo = (ms) => {
      const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
      const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
      for (const [name, size] of units) {
        const n = Math.floor(secs / size);
        if (n >= 1) return `${n} ${name}${n === 1 ? '' : 's'} ago`;
      }
      return 'just now';
    };
    const id = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev';
    const ago = typeof __BUILD_TIME__ !== 'undefined' ? ` (${timeAgo(__BUILD_TIME__)})` : '';
    document.getElementById('build-info').textContent =
      `Updated ${__BUILD_DATE__}${ago} · build ${id}`;
  }
} catch { /* cosmetic */ }

// GitHub Pages caches index.html for up to 10 minutes and mobile browsers
// cache harder still. version.json is fetched cache-bypassing; if its build id
// differs from the one baked into this bundle, reload with a fresh query so
// the phone picks up the new deploy immediately.
// Runs ONCE at startup only. It must never force a reload mid-session: on
// mobile the app regains focus constantly (audio start, overlays, glancing
// away), and if a stale cached bundle keeps mismatching a fresh version.json
// (common right after a deploy) a visibilitychange re-check would reload the
// player on every foreground — the "loading loop after talking to a vendor".
// Players pick up new deploys on their next manual refresh instead.
async function checkForUpdate() {
  try {
    const res = await fetch(import.meta.env.BASE_URL + 'version.json', { cache: 'no-store' });
    if (!res.ok) return;
    const { id } = await res.json();
    if (id && typeof __BUILD_ID__ !== 'undefined' && id !== __BUILD_ID__) {
      const url = new URL(location.href);
      if (url.searchParams.get('u') !== id) { // one-shot, loop-guarded
        url.searchParams.set('u', id);
        location.replace(url.toString());
      }
    }
  } catch { /* offline or dev server — ignore */ }
}
checkForUpdate();
