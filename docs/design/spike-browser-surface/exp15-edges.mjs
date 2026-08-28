import { chromium } from 'playwright';
import { attach, perceive, cellInRowWhere } from './perceive.mjs';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } });

console.log('=== is Accessibility.enable required for getFullAXTree? ===');
{
  const p = await ctx.newPage(); await p.goto('http://127.0.0.1:8731/members.html'); await p.waitForTimeout(300);
  const s = await ctx.newCDPSession(p);
  try { const { nodes } = await s.send('Accessibility.getFullAXTree'); console.log(`  without Accessibility.enable: OK, ${nodes.length} nodes (the domain is enabled implicitly by the call)`); }
  catch (e) { console.log('  without Accessibility.enable THREW:', String(e).split('\n')[0]); }
  await p.close();
}

const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8731/');
await page.waitForTimeout(400);
const cdp = await attach(ctx, page);

console.log('\n=== duplicate key -> AMBIGUOUS, not a silent wrong pick ===');
await page.frames().find(f=>f.name()==='content').evaluate(() => {
  const t = document.getElementById('ctl00_ctl32_g_9a1_grdResults');
  const tr = t.insertRow(-1);
  tr.innerHTML = '<td><font>10042</font></td><td><font>DUPLICATE, ROW</font></td><td><font>0.00</font></td><td><font>ACTIVE</font></td><td><a href="detail.html?m=10042x" target="detail"><font>Open</font></a></td>';
});
await page.waitForTimeout(250);
let obs = await perceive(cdp);
console.log('  key=10042 ->', JSON.stringify(cellInRowWhere(obs, { keyValue: '10042', columnLabel: 'Status' })));

console.log('\n=== what happens if you DO NOT distinguish LayoutTable from table? ===');
function naiveCellInRow(obs, keyValue) {
  const isCell = n => n.role === 'cell' || n.role === 'LayoutTableCell';
  const isRow  = n => n.role === 'row'  || n.role === 'LayoutTableRow';
  const cells = obs.nodes.filter(n => isCell(n) && n.name.trim() === keyValue);
  const rows = [];
  for (const c of cells) { let p = obs.byGlobalId.get(c.parentId); while (p) { if (isRow(p)) { rows.push(p); break; } p = obs.byGlobalId.get(p.parentId); } }
  // ancestor rows, the way a Playwright `filter({has:…})` walks
  const ancestors = [];
  for (const c of cells) { let p = obs.byGlobalId.get(c.parentId); while (p) { if (isRow(p)) ancestors.push(p); p = obs.byGlobalId.get(p.parentId); } }
  return { matchingCells: cells.length, nearestRows: rows.length, ALL_ancestorRows: ancestors.length };
}
await page.frames().find(f=>f.name()==='content').goto('http://127.0.0.1:8731/members.html'); await page.waitForTimeout(400);
obs = await perceive(cdp);
console.log('  strict (ariaRole only)         key=10043 ->', cellInRowWhere(obs, { keyValue: '10043', columnLabel: 'Status' }).kind);
console.log('  naive  (layout roles folded in) key=10043 ->', JSON.stringify(naiveCellInRow(obs, '10043')));
console.log('  => folding layout tables into `table/row/cell` gives 2 ancestor rows for one data cell.');
console.log('     That is precisely the ambiguity Playwright strict mode reported in exp8d.');

console.log('\n=== frame ordinals across a frame navigation ===');
console.log('  before:', obs.frames.map((f,i) => `f${i}=${f.path.join('/')}`).join(' '));
await page.frames().find(f=>f.name()==='content').goto('http://127.0.0.1:8731/detail.html?m=1'); await page.waitForTimeout(400);
const obs2 = await perceive(cdp);
console.log('  after :', obs2.frames.map((f,i) => `f${i}=${f.path.join('/')}`).join(' '));
console.log('  => ordinals shift when the frame tree changes shape (the nested iframe went away).');
console.log('     Node ids must therefore be treated as valid only within ONE Observation.');
await b.close();
