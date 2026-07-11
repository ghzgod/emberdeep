import { chromium } from 'playwright';

const browser = await chromium.launch();

async function measure(viewport, label, opts = {}) {
  const context = await browser.newContext({ viewport, hasTouch: true, isMobile: viewport.width < 800, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto('http://localhost:5173/?touch=1', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { const m=()=>document.querySelectorAll('audio').forEach(a=>{a.muted=true;a.volume=0;}); m(); setInterval(m,500); });
  await page.waitForFunction(() => window.__game, { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => document.getElementById('title-screen').classList.contains('visible'), { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(300);
  const dismiss = async () => {
    const cancel = page.locator('#btn-confirm-cancel');
    if (await cancel.isVisible().catch(() => false)) { await cancel.click({ force: true }); await page.waitForTimeout(200); return true; }
    return false;
  };
  for (let i = 0; i < 5; i++) { if (!(await dismiss())) break; }
  await page.click('#btn-single', { force: true }).catch(() => {});
  await page.waitForTimeout(400);
  for (let i = 0; i < 5; i++) { if (!(await dismiss())) break; }
  const newCharBtn = page.locator('#btn-new-character');
  if (await newCharBtn.isVisible().catch(() => false)) { await newCharBtn.click({ force: true }); await page.waitForTimeout(400); }
  for (let i = 0; i < 5; i++) { if (!(await dismiss())) break; }
  await page.locator('#cs-name').fill('Tester').catch(() => {});
  const card = page.locator('#class-cards .class-card').first();
  if (await card.count()) { await card.click({ force: true }).catch(() => {}); await page.waitForTimeout(200); }
  const confirmBtn = page.locator('#btn-charselect-confirm');
  if (await confirmBtn.isVisible().catch(() => false)) { await confirmBtn.click({ force: true }).catch(() => {}); }
  await page.waitForTimeout(1500);
  for (let i = 0; i < 5; i++) { if (!(await dismiss())) break; }
  // dismiss story card
  const storyBtn = page.locator('#btn-story-continue');
  if (await storyBtn.isVisible().catch(() => false)) { await storyBtn.click({ force: true }).catch(() => {}); await page.waitForTimeout(800); }
  for (let i = 0; i < 5; i++) { if (!(await dismiss())) break; }
  await page.waitForTimeout(1000);

  const state = await page.evaluate(() => ({
    state: window.__game?.state, inTown: document.body.classList.contains('in-town'),
  }));
  console.log(label, 'state:', JSON.stringify(state));

  await page.screenshot({ path: `.playwright-mcp/verify-${label}-town.png` });

  // bbox measurement helper
  const bboxes = await page.evaluate(() => {
    const ids = ['touch-inv', 'touch-mic', 'touch-pause'];
    const out = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) out[id] = el.getBoundingClientRect();
    }
    document.querySelectorAll('.act-basic, .act-ability, .act-potion').forEach((el, i) => {
      const key = el.className.includes('act-basic') ? 'act-basic' : el.className.includes('act-potion') ? 'act-potion' : 'act-slot-' + [...el.classList].find(c=>c.startsWith('act-slot-'))?.replace('act-slot-','');
      out[key] = el.getBoundingClientRect();
    });
    const hl = document.getElementById('hud-topleft')?.getBoundingClientRect();
    const hr = document.getElementById('hud-topright')?.getBoundingClientRect();
    const mm = document.getElementById('minimap')?.getBoundingClientRect();
    out['hud-topleft'] = hl; out['hud-topright'] = hr; out['minimap'] = mm;
    return out;
  });
  const j = (r) => r ? { l: +r.left.toFixed(1), t: +r.top.toFixed(1), r: +r.right.toFixed(1), b: +r.bottom.toFixed(1) } : null;
  console.log(label, 'bboxes:', JSON.stringify(Object.fromEntries(Object.entries(bboxes).map(([k,v])=>[k,j(v)])), null, 1));

  function overlap(a, b) {
    if (!a || !b) return false;
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }
  const keys = Object.keys(bboxes).filter(k => k.startsWith('act-') || k.startsWith('touch-'));
  const problems = [];
  for (let i = 0; i < keys.length; i++) {
    for (let jx = i + 1; jx < keys.length; jx++) {
      if (overlap(bboxes[keys[i]], bboxes[keys[jx]])) problems.push(keys[i] + ' <-> ' + keys[jx]);
    }
  }
  if (overlap(bboxes['hud-topleft'], bboxes['hud-topright'])) problems.push('hud-topleft <-> hud-topright');
  if (overlap(bboxes['hud-topleft'], bboxes['minimap'])) problems.push('hud-topleft <-> minimap');
  console.log(label, 'CLUSTER OVERLAPS:', problems.length ? problems : 'NONE');

  // now go into the dungeon: click the portal / minimap? try pressing 'F' interact near portal is unclear;
  // just take dungeon-state screenshot attempt by checking for an interact prompt near spawn, skip if unavailable.
  await context.close();
  return { bboxes, problems };
}

await measure({ width: 390, height: 844 }, '390x844');
await measure({ width: 844, height: 390 }, '844x390');
await measure({ width: 1024, height: 768 }, '1024x768');

await browser.close();
