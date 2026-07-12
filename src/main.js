import { Game } from './game.js';

const game = new Game();
if (import.meta.env.DEV) window.__game = game; // dev-only debug handle; stripped from prod build
game.boot();

// title screen: platform-appropriate controls + build stamp
try {
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
async function checkForUpdate(silent = false) {
  try {
    const res = await fetch(import.meta.env.BASE_URL + 'version.json', { cache: 'no-store' });
    if (!res.ok) return;
    const { id } = await res.json();
    if (id && typeof __BUILD_ID__ !== 'undefined' && id !== __BUILD_ID__) {
      const url = new URL(location.href);
      if (url.searchParams.get('u') === id) return; // loop guard
      url.searchParams.set('u', id);
      if (!silent) { location.replace(url.toString()); return; }
      // Mid-session (foreground re-check): never auto-reload - offer a tap.
      // A long-lived tab otherwise plays stale builds forever, since the
      // startup check above only runs once.
      if (document.getElementById('update-toast')) return;
      const toast = document.createElement('button');
      toast.id = 'update-toast';
      toast.textContent = 'Update ready — tap to reload';
      toast.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:200;'
        + 'background:rgba(24,20,34,0.95);color:#e8c05a;border:1px solid #4a3b5c;border-radius:10px;'
        + 'padding:10px 18px;font:14px Georgia,serif;letter-spacing:0.5px;cursor:pointer;'
        + 'box-shadow:0 2px 16px rgba(0,0,0,0.8)';
      // Stamp a same-tab resume intent (Obsidian 730) so boot() drops the
      // player straight back into their most recent session after the reload
      // instead of parking them at the title menu.
      toast.onclick = () => {
        // Only auto-resume into the game if the player was IN a session when
        // they updated (Obsidian 779); clicking update from the menu returns
        // to the menu. game._markInSession maintains 'emberdeep-in-game'.
        try {
          if (sessionStorage.getItem('emberdeep-in-game')) sessionStorage.setItem('emberdeep-resume-v1', '1');
        } catch { /* private mode */ }
        location.replace(url.toString());
      };
      document.body.appendChild(toast);
    }
  } catch { /* offline or dev server — ignore */ }
}
checkForUpdate();
// Foreground re-checks surface a non-disruptive toast (never an auto-reload,
// which caused the historical "loading loop after talking to a vendor").
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkForUpdate(true);
});
