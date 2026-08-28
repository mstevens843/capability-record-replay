import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8731/');
await page.waitForTimeout(500);
const cdp = await ctx.newCDPSession(page);
await cdp.send('Accessibility.enable'); await cdp.send('DOM.enable'); await cdp.send('Page.enable');

const { nodes: root } = await cdp.send('Accessibility.getFullAXTree');
console.log('=== the 7 root-document nodes, flattened ===');
for (const n of root) console.log(`  id=${n.nodeId} role=${n.role?.value} ignored=${n.ignored} name=${JSON.stringify(n.name?.value ?? '')} backend=${n.backendDOMNodeId} children=[${n.childIds}] frameId=${n.frameId ? n.frameId.slice(0,8) : '-'}`);

const { frameTree } = await cdp.send('Page.getFrameTree');
const frames = [];
(function walk(ft) { frames.push({ id: ft.frame.id, name: ft.frame.name ?? '', url: ft.frame.url }); (ft.childFrames ?? []).forEach(walk); })(frameTree);

console.log('\n=== OPTION 1: Accessibility.getFullAXTree({ frameId }) per frame, same page CDP session ===');
let total = 0;
for (const f of frames) {
  try {
    const { nodes } = await cdp.send('Accessibility.getFullAXTree', { frameId: f.id });
    total += nodes.length;
    const names = nodes.filter(n => n.name?.value && !n.ignored).map(n => n.name.value).slice(0, 3);
    console.log(`  frame ${JSON.stringify(f.name).padEnd(10)} ${f.url.padEnd(46)} nodes=${String(nodes.length).padStart(4)}  e.g. ${JSON.stringify(names)}`);
  } catch (e) { console.log(`  frame ${JSON.stringify(f.name).padEnd(10)} THREW ${String(e).split('\n')[0]}`); }
}
console.log('  TOTAL nodes across all frames:', total);

console.log('\n=== OPTION 2: ctx.newCDPSession(frame) for a same-process child frame ===');
for (const pf of page.frames()) {
  if (pf === page.mainFrame()) continue;
  try {
    const s = await ctx.newCDPSession(pf);
    await s.send('Accessibility.enable');
    const { nodes } = await s.send('Accessibility.getFullAXTree');
    console.log(`  newCDPSession(frame ${JSON.stringify(pf.name())}) OK nodes=${nodes.length}`);
    await s.detach();
  } catch (e) { console.log(`  newCDPSession(frame ${JSON.stringify(pf.name())}) THREW: ${String(e).split('\n')[0].slice(0,120)}`); }
}

console.log('\n=== OPTION 3: does the AX iframe node point into the child tree? ===');
console.log('  Accessibility.getRootAXNode({frameId}) per frame:');
for (const f of frames.slice(0, 3)) {
  try {
    const r = await cdp.send('Accessibility.getRootAXNode', { frameId: f.id });
    console.log(`    ${JSON.stringify(f.name).padEnd(10)} rootNodeId=${r.node.nodeId} role=${r.node.role?.value} backend=${r.node.backendDOMNodeId}`);
  } catch (e) { console.log(`    ${JSON.stringify(f.name)} THREW ${String(e).split('\n')[0].slice(0,110)}`); }
}
await b.close();
