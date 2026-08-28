import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
// 127.0.0.1:8731 page embedding an iframe from localhost:8732 -> different origin -> OOPIF candidate
await page.goto('http://127.0.0.1:8731/xorigin.html');
await page.waitForTimeout(700);
console.log('frames:', page.frames().map(f => f.url()));

const cdp = await ctx.newCDPSession(page);
for (const d of ['Accessibility','DOM','Page']) await cdp.send(`${d}.enable`);
const { frameTree } = await cdp.send('Page.getFrameTree');
const frames=[];(function w(ft){frames.push({id:ft.frame.id,name:ft.frame.name??'',url:ft.frame.url});(ft.childFrames??[]).forEach(w);})(frameTree);
console.log('\nPage.getFrameTree from the PAGE session:');
frames.forEach(f => console.log(`  ${f.id.slice(0,8)} ${f.url}`));

console.log('\n1) getFullAXTree({frameId}) for the CROSS-ORIGIN frame, from the page session:');
for (const f of frames) {
  try { const { nodes } = await cdp.send('Accessibility.getFullAXTree', { frameId: f.id });
    console.log(`   ${f.url.padEnd(48)} nodes=${nodes.length}  names=${JSON.stringify(nodes.filter(n=>n.name?.value&&!n.ignored).map(n=>n.name.value).slice(0,3))}`); }
  catch (e) { console.log(`   ${f.url.padEnd(48)} THREW: ${String(e).split('\n')[0].slice(0,110)}`); }
}

console.log('\n2) is the cross-origin frame a separate CDP target (OOPIF)?');
for (const pf of page.frames()) {
  if (pf === page.mainFrame()) continue;
  try { const s = await ctx.newCDPSession(pf); await s.send('Accessibility.enable');
    const { nodes } = await s.send('Accessibility.getFullAXTree');
    console.log(`   newCDPSession(${pf.url()}) OK -> OOPIF, own session, nodes=${nodes.length}`); await s.detach(); }
  catch (e) { console.log(`   newCDPSession(${pf.url()}) THREW: ${String(e).split('\n')[0].slice(0,110)}`); }
}

console.log('\n3) does ariaSnapshot(mode:"ai") cross the cross-origin boundary?');
const snap = await page.ariaSnapshot({ mode: 'ai' });
console.log(snap.split('\n').map(l => '   ' + l).join('\n'));

console.log('\n4) does DOM.getBoxModel give MAIN-FRAME coords for a node inside the cross-origin frame?');
const xf = frames.find(f => f.url.includes('8732'));
try {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree', { frameId: xf.id });
  const btn = nodes.find(n => n.role?.value === 'button');
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: btn.backendDOMNodeId });
  console.log(`   CDP box   : x=${model.content[0]} y=${model.content[1]}`);
  const gt = await page.frameLocator('#xo').getByRole('button', { name: 'Open Sub-Account' }).boundingBox();
  console.log(`   Playwright: x=${gt.x.toFixed(1)} y=${gt.y.toFixed(1)}   MATCH=${Math.abs(model.content[0]-gt.x)<2 && Math.abs(model.content[1]-gt.y)<2}`);
} catch (e) { console.log('   THREW:', String(e).split('\n')[0].slice(0,140)); }
await b.close();
