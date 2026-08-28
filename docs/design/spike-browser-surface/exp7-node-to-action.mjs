import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8731/');
await page.waitForTimeout(500);
const cdp = await ctx.newCDPSession(page);
for (const d of ['Accessibility', 'DOM', 'Page']) await cdp.send(`${d}.enable`);

const { frameTree } = await cdp.send('Page.getFrameTree');
const frames = []; (function w(ft){ frames.push({id: ft.frame.id, name: ft.frame.name ?? '', url: ft.frame.url}); (ft.childFrames??[]).forEach(w); })(frameTree);

console.log('=== 1. do AX nodeIds COLLIDE across frames? ===');
const perFrame = {};
for (const f of frames) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree', { frameId: f.id });
  perFrame[f.name || '(root)'] = nodes;
  console.log(`  ${(f.name||'(root)').padEnd(9)} nodeIds ${nodes[0].nodeId} .. ${nodes[nodes.length-1].nodeId}`);
}
const all = Object.values(perFrame).flat();
const ids = all.map(n => n.nodeId);
console.log(`  total nodes=${ids.length} distinct nodeIds=${new Set(ids).size}  -> COLLIDE=${new Set(ids).size !== ids.length}`);
const backends = all.map(n => n.backendDOMNodeId).filter(Boolean);
console.log(`  distinct backendDOMNodeIds=${new Set(backends).size} of ${backends.length} -> COLLIDE=${new Set(backends).size !== backends.length}`);

console.log('\n=== 2. AX Iframe leaf -> child frameId, via DOM.describeNode ===');
const { nodes: rootNodes } = await cdp.send('Accessibility.getFullAXTree');
for (const n of rootNodes.filter(x => x.role?.value === 'Iframe')) {
  const d = await cdp.send('DOM.describeNode', { backendNodeId: n.backendDOMNodeId });
  console.log(`  AX Iframe backend=${n.backendDOMNodeId} -> <${d.node.nodeName.toLowerCase()} name=${JSON.stringify(d.node.attributes?.[d.node.attributes.indexOf('name')+1] ?? '')}> frameId=${d.node.frameId?.slice(0,8)} (${frames.find(f=>f.id===d.node.frameId)?.url})`);
}

console.log('\n=== 3. backendDOMNodeId -> geometry. Which coordinate space? ===');
const content = perFrame['content'];
const openLink = content.find(n => n.role?.value === 'link' && n.name?.value === 'Open');
const memberCell = content.find(n => n.name?.value === '10041' && n.role?.value === 'cell');
for (const [label, n] of [['content-frame link "Open" (row 10041)', openLink], ['content-frame cell "10041"', memberCell]]) {
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: n.backendDOMNodeId });
  const q = model.content;
  console.log(`  ${label}`);
  console.log(`     DOM.getBoxModel content quad : x=${q[0].toFixed(1)} y=${q[1].toFixed(1)} w=${(q[2]-q[0]).toFixed(1)} h=${(q[7]-q[1]).toFixed(1)}`);
}
// ground truth: Playwright boundingBox() is documented as relative to the MAIN frame viewport
await page.ariaSnapshot({ mode: 'ai' });
const gt = await page.locator('aria-ref=f3e37').boundingBox();
console.log(`     Playwright boundingBox (main-frame space) : x=${gt.x.toFixed(1)} y=${gt.y.toFixed(1)} w=${gt.width.toFixed(1)} h=${gt.height.toFixed(1)}`);
const local = await page.frames().find(f=>f.name()==='content').evaluate(() => {
  const a = [...document.querySelectorAll('a')].find(a => a.href.includes('m=10041'));
  const r = a.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };
});
console.log(`     getBoundingClientRect INSIDE the frame    : x=${local.x.toFixed(1)} y=${local.y.toFixed(1)} w=${local.w.toFixed(1)} h=${local.h.toFixed(1)}`);

console.log('\n=== 4. DOM.resolveNode -> can we act? ===');
const r = await cdp.send('DOM.resolveNode', { backendNodeId: openLink.backendDOMNodeId });
console.log('  DOM.resolveNode ->', JSON.stringify(r.object));
console.log('  NOTE: this is a CDP RemoteObject. Playwright exposes no public API to lift it to an ElementHandle.');

console.log('\n=== 5. coordinate click via CDP box model + page.mouse ===');
const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: openLink.backendDOMNodeId });
const cx = (model.content[0] + model.content[4]) / 2, cy = (model.content[1] + model.content[5]) / 2;
console.log(`  clicking main-frame viewport point (${cx.toFixed(1)}, ${cy.toFixed(1)})`);
await page.mouse.click(cx, cy);
await page.waitForTimeout(600);
console.log('  detail frame url after coordinate click:', page.frames().find(f => f.name()==='detail')?.url());
await b.close();
