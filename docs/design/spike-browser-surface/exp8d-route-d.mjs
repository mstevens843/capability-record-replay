import { chromium } from 'playwright';
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1200, height: 800 } });
await page.goto('http://127.0.0.1:8731/');
await page.waitForTimeout(400);
const cf = page.frames().find(f => f.name() === 'content');

console.log('--- ROUTE D: re-resolve by role + accessible name, scoped by row content ---');
console.log('  NOTE: filter({has}) requires the inner locator to be built from the SAME Frame object.');
console.log('        page.getByRole(...) as `has` throws: "Inner \\"has\\" locator must belong to the same frame."');

for (const memberId of ['10041', '10042', '10043', '10099']) {
  const t0 = Date.now();
  const row = cf.getByRole('row').filter({ has: cf.getByRole('cell', { name: memberId, exact: true }) });
  const n = await row.count();
  const open = row.getByRole('link', { name: 'Open' });
  const openN = await open.count();
  console.log(`  memberId=${memberId}: rows=${n} openLinks=${openN} (${Date.now()-t0}ms)`);
  if (openN === 1) {
    // read the sibling cells of that row = the "cell in the row whose Member ID is X" strategy
    const cells = await row.getByRole('cell').allInnerTexts();
    console.log(`     row cells -> ${JSON.stringify(cells.map(s => s.trim()))}`);
  }
}

console.log('\n--- and it acts, cross-frame, with no coordinates and no DOM mutation ---');
await cf.getByRole('row').filter({ has: cf.getByRole('cell', { name: '10043', exact: true }) })
        .getByRole('link', { name: 'Open' }).click();
await page.waitForTimeout(500);
console.log('  detail frame url =', page.frames().find(f => f.name() === 'detail')?.url());
await b.close();
