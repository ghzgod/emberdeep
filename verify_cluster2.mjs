import { chromium } from 'playwright';

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const page = await context.newPage();
page.on('pageerror', (err) => console.log('[pageerror]', err.message));

await page.goto('http://localhost:5173/?touch=1', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => {
  const mute = () => document.querySelectorAll('audio').forEach(a => { a.muted = true; a.volume = 0; });
  mute(); setInterval(mute, 500);
});
await page.waitForFunction(() => window.__game, { timeout: 30000 }).catch(() => {});
await page.waitForFunction(() => document.getElementById('title-screen').classList.contains('visible'), { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(300);

const dismiss = async () => {
  const cancel = page.locator('#btn-confirm-cancel');
  if (await cancel.isVisible().catch(() => false)) { await cancel.click({ force: true }); await page.waitForTimeout(200); return true; }
  return false;
};
for (let i = 0; i < 5; i++) { if (!(await dismiss())) break; }

await page.click('#btn-single', { force: true }).catch(e => console.log('single err', e.message));
await page.waitForTimeout(500);
for (let i = 0; i < 5; i++) { if (!(await dismiss())) break; }

const newCharBtn = page.locator('#btn-new-character');
if (await newCharBtn.isVisible().catch(() => false)) { await newCharBtn.click({ force: true }); await page.waitForTimeout(500); }
for (let i = 0; i < 5; i++) { if (!(await dismiss())) break; }

await page.locator('#cs-name').fill('Tester').catch(() => {});
const card = page.locator('#class-cards .class-card').first();
if (await card.count()) { await card.click({ force: true }).catch(()=>{}); await page.waitForTimeout(200); }
const confirmBtn = page.locator('#btn-charselect-confirm');
if (await confirmBtn.isVisible().catch(() => false)) { await confirmBtn.click({ force: true }).catch(()=>{}); }
await page.waitForTimeout(2000);
for (let i = 0; i < 5; i++) { if (!(await dismiss())) break; }

const info = await page.evaluate(() => {
  const g = window.__game;
  return g ? { hasPlayer: !!g.player, state: g.state, inTown: document.body.classList.contains('in-town') } : { hasPlayer: false };
});
console.log('game state after char creation:', JSON.stringify(info));
await page.screenshot({ path: '.playwright-mcp/verify-town-390.png' });

await browser.close();
