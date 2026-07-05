import { Game } from './game.js';

const game = new Game();
window.__game = game; // handy for debugging/tests
game.boot();

// title screen: platform-appropriate controls + build stamp
try {
  if (game.touch.enabled) {
    document.getElementById('title-controls').textContent =
      'Left thumb to move · right thumb to aim & attack · tap the hotbar for abilities';
  }
  if (typeof __BUILD_DATE__ !== 'undefined') {
    document.getElementById('build-info').textContent =
      `Updated ${__BUILD_DATE__} · build ${typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev'}`;
  }
} catch { /* cosmetic */ }

// GitHub Pages caches index.html for up to 10 minutes and mobile browsers
// cache harder still. version.json is fetched cache-bypassing; if its build id
// differs from the one baked into this bundle, reload with a fresh query so
// the phone picks up the new deploy immediately.
async function checkForUpdate() {
  try {
    const res = await fetch(import.meta.env.BASE_URL + 'version.json', { cache: 'no-store' });
    if (!res.ok) return;
    const { id } = await res.json();
    if (id && typeof __BUILD_ID__ !== 'undefined' && id !== __BUILD_ID__) {
      const url = new URL(location.href);
      if (url.searchParams.get('u') !== id) { // guard against reload loops
        url.searchParams.set('u', id);
        location.replace(url.toString());
      }
    }
  } catch { /* offline or dev server — ignore */ }
}
checkForUpdate();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkForUpdate();
});
