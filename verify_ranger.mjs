import { chromium } from 'playwright';

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
page.on('console', (msg) => console.log('[console]', msg.type(), msg.text()));
page.on('pageerror', (err) => console.log('[pageerror]', err.message));

await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => {
  const mute = () => { document.querySelectorAll('audio').forEach(a => { a.muted = true; a.volume = 0; }); };
  mute();
  setInterval(mute, 500);
});

await page.waitForFunction(() => window.__game, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1000);

const dismissModal = async () => {
  const cancel = page.locator('#btn-confirm-cancel');
  if (await cancel.isVisible().catch(() => false)) { await cancel.click({ force: true }); return true; }
  return false;
};

for (let i = 0; i < 8; i++) {
  if (await dismissModal()) { await page.waitForTimeout(300); continue; }
  const btn = page.locator('text=Single Player');
  if (await btn.count() && await btn.first().isVisible().catch(() => false)) {
    await btn.first().click({ force: true }).catch(() => {});
    break;
  }
  await page.waitForTimeout(500);
}
await page.waitForTimeout(1000);
await page.screenshot({ path: '.playwright-mcp/verify-ranger-01-charselect.png' });

const info = await page.evaluate(() => {
  const g = window.__game;
  return g ? { hasPlayer: !!g.player, classId: g.player?.classId } : { hasPlayer: false };
});
console.log('game state:', JSON.stringify(info));

await browser.close();
