import { chromium } from 'playwright';
import { decodePng } from './png.mjs';
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
const tree = async () => (await cdp.send('Accessibility.getFullAXTree', { frameId: cid })).nodes;
const cf = page.frames().find(f => f.name() === 'content');
const boxOf = async (n) => { try { const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: n.backendDOMNodeId });
  return { x: model.border[0], y: model.border[1], w: model.border[2]-model.border[0], h: model.border[7]-model.border[1] }; }
  catch (e) { return { error: String(e.message ?? e).split('\n')[0] }; } };

console.log('=== 1. hidden / zero-size nodes: does getBoxModel fail, and how? ===');
await cf.evaluate(() => {
  document.body.insertAdjacentHTML('beforeend',
    '<div id="hidden1" style="display:none">display none</div>' +
    '<div id="hidden2" style="visibility:hidden">visibility hidden</div>' +
    '<span id="zero"></span>' +
    '<div id="far" style="position:absolute;top:4000px">far below the fold</div>');
});
await page.waitForTimeout(200);
// Walk the pierced DOM tree ourselves: gives nodeId + backendNodeId for nodes inside child frames.
const { root: pierced } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
const domById = new Map();
(function walk(n) {
  const a = n.attributes ?? [];
  for (let i = 0; i < a.length; i += 2) if (a[i] === 'id') domById.set(a[i+1], n);
  (n.children ?? []).forEach(walk);
  if (n.contentDocument) walk(n.contentDocument);
})(pierced);
let ns = await tree();
for (const [id, label] of [['hidden1','display:none'],['hidden2','visibility:hidden'],['zero','zero-size <span>'],['far','4000px below the fold']]) {
  const dn = domById.get(id);
  const box = await boxOf({ backendDOMNodeId: dn.backendNodeId });
  const axNode = ns.find(n => n.backendDOMNodeId === dn.backendNodeId);
  console.log(`  ${label.padEnd(24)} in-AX-tree=${String(!!axNode).padEnd(5)} ignored=${axNode?.ignored ?? '-'} box=${JSON.stringify(box)}`);
}

console.log('\n=== 2. does the box track a SCROLLED frame? ===');
ns = await tree();
const cell = ns.find(n => n.role?.value === 'cell' && n.name?.value === '10043');
console.log('  before scroll:', JSON.stringify(await boxOf(cell)));
await cf.evaluate(() => window.scrollTo(0, 300));
await page.waitForTimeout(200);
console.log('  after frame scrollTo(0,300):', JSON.stringify(await boxOf(cell)));
const pwAfter = await cf.getByRole('cell', { name: '10043', exact: true }).boundingBox();
console.log('  Playwright bbox after scroll:', JSON.stringify({x:+pwAfter.x.toFixed(1),y:+pwAfter.y.toFixed(1),w:+pwAfter.width.toFixed(1),h:+pwAfter.height.toFixed(1)}));
await cf.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(200);

console.log('\n=== 3. DOM.scrollIntoViewIfNeeded before a coordinate click ===');
try {
  const bid = domById.get('far').backendNodeId;
  console.log('  box before scrollIntoView:', JSON.stringify(await boxOf({ backendDOMNodeId: bid })));
  await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: bid });
  await page.waitForTimeout(200);
  console.log('  box after  scrollIntoView:', JSON.stringify(await boxOf({ backendDOMNodeId: bid })));
} catch (e) { console.log('  THREW:', String(e).split('\n')[0].slice(0,120)); }
await cf.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(250);

console.log('\n=== 4. screenshot region masking of a sensitive field, across a frameset ===');
ns = await tree();
const lastName = ns.filter(n => n.role?.value === 'textbox')[1];
const box = await boxOf(lastName);
console.log('  sensitive field main-frame box:', JSON.stringify(box));
await cf.evaluate(() => { document.getElementById('ctl00_ctl32_g_9a1_txtLast').value = 'SECRET-PII'; });
const plain = decodePng(await page.screenshot());
await page.ariaSnapshot({ mode: 'ai' });
const masked = decodePng(await page.screenshot({ mask: [page.locator('aria-ref=f3e14')] }));
const at = (img) => img.px(Math.round(box.x + box.w/2), Math.round(box.y + box.h/2)).slice(0,3).join(',');
console.log(`  pixel at field centre, unmasked = rgb(${at(plain)})`);
console.log(`  pixel at field centre, masked   = rgb(${at(masked)})   <- Playwright default mask colour is #FF00FF`);
console.log(`  masking took effect: ${at(plain) !== at(masked)}`);
console.log(`  pixel far from the field unchanged: ${plain.px(5,5).join(',')} vs ${masked.px(5,5).join(',')}`);

console.log('\n=== 5. clip a screenshot to a CDP-derived box in a DEEP frame (evidence capture) ===');
const dcid = frames.find(f=>f.name==='detail').id;
const dn2 = (await cdp.send('Accessibility.getFullAXTree', { frameId: dcid })).nodes.find(n => n.role?.value === 'button');
const dbox = await boxOf(dn2);
const clip = await page.screenshot({ clip: { x: dbox.x, y: dbox.y, width: dbox.w, height: dbox.h } });
const img = decodePng(clip);
console.log(`  CDP box for "Open Sub-Account" in the nested iframe: ${JSON.stringify(dbox)}`);
console.log(`  clipped PNG dimensions: ${img.w}x${img.h}  (matches box: ${img.w === Math.round(dbox.w) && img.h === Math.round(dbox.h)})`);
console.log(`  centre pixel of clip: rgb(${img.px(Math.round(img.w/2), Math.round(img.h/2)).slice(0,3).join(',')})  (button face, not page background)`);
await b.close();
