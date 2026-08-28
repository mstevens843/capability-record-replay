import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8731/');
await page.waitForTimeout(500);

const cdp = await ctx.newCDPSession(page);
await cdp.send('Accessibility.enable');
await cdp.send('DOM.enable');

const { nodes } = await cdp.send('Accessibility.getFullAXTree');
console.log('Accessibility.getFullAXTree -> nodes:', nodes.length);

// what fields does a node actually carry?
const sample = nodes.find(n => n.role?.value === 'link') || nodes[0];
console.log('\nsample node keys:', Object.keys(sample).join(', '));
console.log(JSON.stringify(sample, null, 1));

// frameId coverage: does the flat tree span the frameset?
const byFrame = new Map();
for (const n of nodes) {
  const k = n.frameId ?? '(no frameId on node)';
  byFrame.set(k, (byFrame.get(k) ?? 0) + 1);
}
console.log('\nnodes carrying a frameId (only frame ROOT nodes do, in Chromium):');
for (const [k, v] of byFrame) console.log(`  ${k}  x${v}`);

// map frameId -> url via Page.getFrameTree
await cdp.send('Page.enable');
const { frameTree } = await cdp.send('Page.getFrameTree');
const frameUrl = new Map();
(function walk(ft, depth) {
  frameUrl.set(ft.frame.id, ft.frame.url);
  console.log(`${'  '.repeat(depth + 1)}frame ${ft.frame.id.slice(0,8)} name=${JSON.stringify(ft.frame.name ?? '')} url=${ft.frame.url}`);
  (ft.childFrames ?? []).forEach(c => walk(c, depth + 1));
})(frameTree, 0);
console.log('\nPage.getFrameTree frames:', frameUrl.size);

// Does the AX tree actually contain nodes from EVERY frame?
console.log('\n--- do frame contents appear in the single flat tree? ---');
for (const probe of ['Sign Off', 'Member Search', 'ALVAREZ, DANA (SYNTHETIC)', 'Open Sub-Account']) {
  const hit = nodes.find(n => n.name?.value === probe);
  console.log(`  ${JSON.stringify(probe).padEnd(30)} found=${!!hit} role=${hit?.role?.value ?? '-'} backendDOMNodeId=${hit?.backendDOMNodeId ?? '-'}`);
}

// Which frame does an arbitrary node belong to? Walk up parentId to a node bearing frameId.
const byId = new Map(nodes.map(n => [n.nodeId, n]));
function owningFrame(n) {
  let cur = n;
  const seen = new Set();
  while (cur && !seen.has(cur.nodeId)) {
    seen.add(cur.nodeId);
    if (cur.frameId) return cur.frameId;
    cur = byId.get(cur.parentId);
  }
  return null;
}
console.log('\n--- owning frame by walking parentId up to the nearest node bearing frameId ---');
for (const probe of ['Sign Off', 'Member Search', 'ALVAREZ, DANA (SYNTHETIC)', 'Open Sub-Account']) {
  const hit = nodes.find(n => n.name?.value === probe);
  const fid = hit ? owningFrame(hit) : null;
  console.log(`  ${JSON.stringify(probe).padEnd(30)} frame=${fid ? frameUrl.get(fid) : 'UNRESOLVED'}`);
}
await b.close();
