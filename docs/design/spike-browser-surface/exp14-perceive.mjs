import { chromium } from 'playwright';
import { attach, perceive, cellInRowWhere } from './perceive.mjs';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8731/');
await page.waitForTimeout(400);
const cdp = await attach(ctx, page);

const t0 = Date.now(); const obs = await perceive(cdp); const t1 = Date.now();
console.log(`perceive(): ${obs.nodes.length} nodes across ${obs.frames.length} frames in ${t1-t0}ms`);
console.log('frames:', obs.frames.map(f => f.path.join('/') + ' ' + f.url.replace('http://127.0.0.1:8731','')).join('  |  '));
const withBounds = obs.nodes.filter(n => n.bounds);
console.log(`geometry attached to ${withBounds.length} nodes (mode "actionable")`);
console.log(`serialised observation: ${JSON.stringify(obs.nodes).length} bytes for all nodes,`,
            `${JSON.stringify(obs.nodes.filter(n => n.ariaRole && !n.ignored)).length} bytes for ARIA-role nodes only`);

const t2 = Date.now(); await perceive(cdp, { geometry: 'all' }); const t3 = Date.now();
console.log(`perceive({geometry:"all"}): ${t3-t2}ms`);
const t4 = Date.now(); await page.ariaSnapshot({ mode: 'ai', boxes: true }); const t5 = Date.now();
console.log(`page.ariaSnapshot({mode:"ai",boxes:true}): ${t5-t4}ms  (frame-local boxes)`);

console.log('\n--- containerPath tells us which frame a node lives in ---');
for (const nm of ['Sign Off','Member Search','Search','Open Sub-Account']) {
  const n = obs.nodes.find(x => x.name === nm && x.ariaRole);
  console.log(`  ${nm.padEnd(18)} role=${String(n?.ariaRole).padEnd(8)} frame=${JSON.stringify(n?.containerPath)} bounds=${JSON.stringify(n?.bounds && {x:+n.bounds.x.toFixed(0),y:+n.bounds.y.toFixed(0)})}`);
}

console.log('\n--- "the cell in the row whose Member ID is X" ---');
for (const [k, col] of [['10042','Share Balance'],['10043','Status'],['20001','Share Balance'],['10099','Share Balance'],['10042','Nonexistent Column']]) {
  const r = cellInRowWhere(obs, { keyValue: k, columnLabel: col });
  console.log(`  key=${k} col=${JSON.stringify(col)} -> ${r.kind}` +
    (r.kind === 'OK' ? ` value=${JSON.stringify(r.cell.name)} headers=${r.headerProvenance} row=${JSON.stringify(r.rowCells)}` : ` ${JSON.stringify({...r, kind: undefined})}`));
}

console.log('\n--- act on the resolved node by coordinates, cross-frame ---');
const r = cellInRowWhere(obs, { keyValue: '10043', columnLabel: 'Action' });
const link = obs.nodes.find(n => n.parentId === r.cell.id && n.ariaRole === 'link');
console.log(`  target: role=${link.ariaRole} name=${JSON.stringify(link.name)} frame=${JSON.stringify(link.containerPath)} bounds=${JSON.stringify(link.bounds)}`);
await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: link.backendDOMNodeId });
const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: link.backendDOMNodeId });
await page.mouse.click((model.border[0]+model.border[4])/2, (model.border[1]+model.border[5])/2);
await page.waitForTimeout(600);
console.log('  detail frame url after click:', page.frames().find(f => f.name()==='detail')?.url());
await b.close();
