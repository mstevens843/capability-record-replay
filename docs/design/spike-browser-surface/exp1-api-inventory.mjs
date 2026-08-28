import { chromium } from 'playwright';

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8731/');
await page.waitForTimeout(500);

console.log('playwright version:', (await import('playwright/package.json', { with: { type: 'json' } })).default.version);
console.log('chromium version :', b.version());
console.log('');
console.log('--- legacy APIs ---');
console.log('typeof page.accessibility        :', typeof page.accessibility);
console.log('typeof page.accessibility?.snapshot:', typeof page.accessibility?.snapshot);
console.log('typeof page._snapshotForAI       :', typeof page._snapshotForAI);
console.log('typeof page.ariaSnapshot         :', typeof page.ariaSnapshot);
console.log('typeof page.mainFrame().ariaSnapshot:', typeof page.mainFrame().ariaSnapshot);
console.log('');
console.log('--- frames seen by Playwright ---');
for (const f of page.frames()) console.log(`  name=${JSON.stringify(f.name())} url=${f.url()}`);

await b.close();
