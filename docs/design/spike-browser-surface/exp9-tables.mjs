import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8731/');
await page.waitForTimeout(400);
const cdp = await ctx.newCDPSession(page);
for (const d of ['Accessibility','DOM','Page']) await cdp.send(`${d}.enable`);
const { frameTree } = await cdp.send('Page.getFrameTree');
const frames=[];(function w(ft){frames.push({id:ft.frame.id,name:ft.frame.name??''});(ft.childFrames??[]).forEach(w);})(frameTree);
const { nodes } = await cdp.send('Accessibility.getFullAXTree', { frameId: frames.find(f=>f.name==='content').id });
const byId = new Map(nodes.map(n => [n.nodeId, n]));
const kids = n => (n.childIds ?? []).map(i => byId.get(i)).filter(Boolean);
const parent = n => byId.get(n.parentId);

console.log('=== every table-ish node in the "content" frame ===');
for (const n of nodes) {
  const r = n.role?.value;
  if (!['table','LayoutTable','row','LayoutTableRow','cell','LayoutTableCell','columnheader','rowheader','rowgroup'].includes(r)) continue;
  const props = (n.properties ?? []).map(p => `${p.name}=${JSON.stringify(p.value?.value)}`).join(' ');
  console.log(`  role=${String(r).padEnd(14)} type=${n.role.type.padEnd(12)} chromeRole=${n.chromeRole?.value} ignored=${n.ignored} name=${JSON.stringify((n.name?.value??'').slice(0,44))} ${props}`);
}

console.log('\n=== is there ANY colindex / rowindex / colcount property? ===');
const propNames = new Set();
for (const n of nodes) for (const p of n.properties ?? []) propNames.add(p.name);
console.log('  all AX property names present in this frame:', [...propNames].sort().join(', '));

console.log('\n=== the ambiguity, quantified ===');
const rows = nodes.filter(n => n.role?.value === 'row' && !n.ignored);
console.log(`  nodes with role="row": ${rows.length}`);
rows.forEach((r,i) => console.log(`    row[${i}] cells=${kids(r).filter(c=>/cell|header/i.test(c.role?.value??'')).length} name=${JSON.stringify((r.name?.value??'').slice(0,60))}`));

console.log('\n=== CORRECT strategy: nearest-ancestor row of the cell whose name is the key ===');
function nearestAncestorRow(n) { let c = parent(n); while (c) { if (c.role?.value === 'row') return c; c = parent(c); } return null; }
function cellsOf(row) { const out = []; (function w(n){ for (const k of kids(n)) { if (/^(cell|columnheader|rowheader)$/.test(k.role?.value ?? '')) out.push(k); else w(k); } })(row); return out; }

for (const key of ['10041','10042','10043','20001','10099']) {
  const keyCells = nodes.filter(n => n.role?.value === 'cell' && n.name?.value === key);
  if (!keyCells.length) { console.log(`  key=${key}: NOT FOUND -> business outcome, not a crash`); continue; }
  if (keyCells.length > 1) { console.log(`  key=${key}: ${keyCells.length} matching cells -> AMBIGUOUS, refuse`); continue; }
  const row = nearestAncestorRow(keyCells[0]);
  const cells = cellsOf(row);
  const idx = cells.indexOf(keyCells[0]);
  console.log(`  key=${key}: row has ${cells.length} cells, key is at column index ${idx}`);
  console.log(`     cells -> ${JSON.stringify(cells.map(c => (c.name?.value ?? '').slice(0,26)))}`);
}

console.log('\n=== column headers: can we name the columns of the LEGACY grid? ===');
function headerRowOf(row) { const tbl = (()=>{let c=parent(row); while(c){ if(c.role?.value==='table') return c; c=parent(c);} })();
  const allRows=[]; (function w(n){for(const k of kids(n)){ if(k.role?.value==='row') allRows.push(k); else w(k);} })(tbl); return { table: tbl, rows: allRows }; }
for (const key of ['10041','20001']) {
  const kc = nodes.filter(n => n.role?.value === 'cell' && n.name?.value === key)[0];
  const row = nearestAncestorRow(kc);
  const { rows: allRows } = headerRowOf(row);
  const first = allRows[0];
  const hdrCells = cellsOf(first);
  console.log(`  key=${key}: table has ${allRows.length} rows; first row roles=${JSON.stringify(hdrCells.map(c=>c.role.value))}`);
  console.log(`             first-row names=${JSON.stringify(hdrCells.map(c=>c.name?.value))}`);
  const real = nodes.filter(n => n.role?.value === 'columnheader');
  console.log(`             role="columnheader" nodes anywhere in frame: ${real.length}`);
}
await b.close();
