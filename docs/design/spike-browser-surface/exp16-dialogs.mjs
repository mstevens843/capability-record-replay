import { chromium } from 'playwright';
import { attach, perceive } from './perceive.mjs';
const withTimeout = (p, ms, tag) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(`TIMEOUT after ${ms}ms: ${tag}`)), ms)).catch(e => { throw e; })]);

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 900, height: 600 } });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8731/dialog.html');
await page.waitForTimeout(300);
const cdp = await attach(ctx, page);

console.log('=== 1. native confirm() held open: does perception still work? ===');
let seen = null;
page.on('dialog', d => { seen = { type: d.type(), message: d.message() }; });   // handler present => Playwright will NOT auto-dismiss
page.locator('#d1').click().catch(() => {});
await new Promise(r => setTimeout(r, 800));
console.log('  page.on("dialog") fired:', JSON.stringify(seen));
try { const o = await withTimeout(perceive(cdp), 4000, 'perceive'); console.log('  perceive() returned', o.nodes.length, 'nodes'); }
catch (e) { console.log(' ', e.message); }
console.log('  => an OPEN native dialog blocks the renderer; Accessibility.getFullAXTree never returns.');
console.log('     The Surface driver must own page.on("dialog") and must put its own deadline on perceive().');

const dlgs = []; page.removeAllListeners('dialog');
page.on('dialog', async d => { dlgs.push({ type: d.type(), message: d.message() }); await d.accept(); });
await new Promise(r => setTimeout(r, 300));

console.log('\n=== 2. same click with a handler that ACCEPTS ===');
const p2 = await ctx.newPage(); await p2.goto('http://127.0.0.1:8731/dialog.html'); await p2.waitForTimeout(200);
const cdp2 = await attach(ctx, p2);
const seen2 = [];
p2.on('dialog', async d => { seen2.push({ type: d.type(), message: d.message() }); await d.accept(); });
await p2.locator('#d1').click();
await p2.waitForTimeout(300);
console.log('  dialog observed:', JSON.stringify(seen2));
console.log('  #out ->', await p2.locator('#out').textContent());
const o2 = await perceive(cdp2);
console.log('  AX nodes after dismissal:', o2.nodes.length, '| any node named "Post this transaction?":',
  o2.nodes.some(n => n.name.includes('Post this transaction')));

console.log('\n=== 3. in-page role="dialog" modal ===');
await p2.locator('#d2').click(); await p2.waitForTimeout(250);
const o3 = await perceive(cdp2);
const dlg = o3.nodes.find(n => n.ariaRole === 'dialog');
console.log('  role=dialog found:', !!dlg, 'name=', JSON.stringify(dlg?.name), 'bounds=', JSON.stringify(dlg?.bounds));
const inside = o3.nodes.filter(n => n.ariaRole === 'button' && n.bounds && dlg?.bounds && n.bounds.y >= dlg.bounds.y && n.bounds.y <= dlg.bounds.y + dlg.bounds.h);
console.log('  buttons inside it:', JSON.stringify(inside.map(n => n.name)));
console.log('  => in-page modals ARE in the Observation, so a pure detector can classify them.');
await b.close();
