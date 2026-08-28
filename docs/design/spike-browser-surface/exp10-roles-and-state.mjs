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
const cid = frames.find(f=>f.name==='content').id;
const { nodes } = await cdp.send('Accessibility.getFullAXTree', { frameId: cid });
const byId=new Map(nodes.map(n=>[n.nodeId,n])), kids=n=>(n.childIds??[]).map(i=>byId.get(i)).filter(Boolean), parent=n=>byId.get(n.parentId);

console.log('=== A. THE DECISIVE COMPARISON: same DOM, two APIs ===');
const snap = await page.ariaSnapshot({ mode: 'ai' });
const pwRows = snap.split('\n').filter(l => /- (row|table|cell) /.test(l) || /- (row|table):/.test(l));
console.log(`  page.ariaSnapshot(mode:"ai")  -> nodes with role table/row/cell : ${snap.split('\n').filter(l=>/^\s*- (table|row|cell)\b/.test(l)).length}`);
const cdpCounts = {};
for (const n of nodes) { const r = n.role?.value; if (/table|row|cell/i.test(r??'')) cdpCounts[r] = (cdpCounts[r]??0)+1; }
console.log('  CDP getFullAXTree             -> role histogram :', JSON.stringify(cdpCounts));
console.log('  => Playwright collapses LayoutTable/LayoutTableRow/LayoutTableCell into table/row/cell.');
console.log('     CDP keeps them distinct via role.type === "internalRole".');
console.log('');
console.log('  Consequence, measured in exp8d: getByRole("row").filter({has: cell "10043"}) matched 2 rows');
console.log('  (the real data row AND the outer layout row that contains it) and Playwright strict mode');
console.log('  refused with "resolved to 3 elements". The CDP tree has no such ambiguity.');

console.log('\n=== B. column-header reconstruction for the legacy grid (no <th>, no scope) ===');
function nearestRow(n){let c=parent(n);while(c){if(c.role?.value==='row')return c;c=parent(c);}return null;}
function ancestorTable(n){let c=parent(n);while(c){if(c.role?.value==='table')return c;c=parent(c);}return null;}
function collect(n,pred,out=[]){for(const k of kids(n)){if(pred(k))out.push(k);else collect(k,pred,out);}return out;}
const isCell=k=>/^(cell|columnheader|rowheader)$/.test(k.role?.value??'');
for (const key of ['10041','20001']) {
  const kc = nodes.find(n=>n.role?.value==='cell' && n.name?.value===key);
  const row = nearestRow(kc), tbl = ancestorTable(row);
  const allRows = collect(tbl, k=>k.role?.value==='row');
  const hdr = collect(allRows[0], isCell);
  const cells = collect(row, isCell);
  const col = cells.indexOf(kc);
  console.log(`  key=${key}`);
  console.log(`     table rows=${allRows.length}  header-row roles=${JSON.stringify(hdr.map(c=>c.role.value))}`);
  console.log(`     header labels (positional)  =${JSON.stringify(hdr.map(c=>c.name?.value))}`);
  console.log(`     this row cells              =${JSON.stringify(cells.map(c=>c.name?.value))}`);
  console.log(`     "Share Balance" for key ${key} -> ${JSON.stringify(cells[hdr.findIndex(h=>h.name?.value==='Share Balance')]?.name?.value)}`);
  console.log(`     header row is TRUE headers? ${hdr.every(h=>h.role.value==='columnheader')}  (else: heuristic on row 0)`);
}

console.log('\n=== C. AX state properties available (disabled/checked/expanded/selected/...) ===');
const p2 = await ctx.newPage();
await p2.goto('http://127.0.0.1:8731/states.html');
await p2.waitForTimeout(300);
const c2 = await ctx.newCDPSession(p2);
await c2.send('Accessibility.enable');
const { nodes: sn } = await c2.send('Accessibility.getFullAXTree');
for (const n of sn) {
  if (n.ignored || !n.role || n.role.type === 'internalRole' && !['StaticText'].includes(n.role.value)) {
    if (n.role?.type !== 'role') continue;
  }
  const props = (n.properties ?? []).map(p => `${p.name}=${JSON.stringify(p.value?.value)}`).join(' ');
  if (props) console.log(`  role=${n.role.value.padEnd(14)} name=${JSON.stringify((n.name?.value??'').slice(0,16)).padEnd(18)} ${props}`);
}
await b.close();
