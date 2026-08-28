import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8731/');
await page.waitForTimeout(400);
const cdp = await ctx.newCDPSession(page);
for (const d of ['Accessibility','DOM','Page','Runtime']) await cdp.send(`${d}.enable`);
const { frameTree } = await cdp.send('Page.getFrameTree');
const frames = []; (function w(ft){frames.push({id:ft.frame.id,name:ft.frame.name??'',url:ft.frame.url});(ft.childFrames??[]).forEach(w);})(frameTree);
const contentFrameId = frames.find(f => f.name === 'content').id;
const { nodes } = await cdp.send('Accessibility.getFullAXTree', { frameId: contentFrameId });
const target = nodes.find(n => n.role?.value === 'textbox');   // the Member ID input
console.log('target AX node:', target.role.value, 'backendDOMNodeId=', target.backendDOMNodeId);

console.log('\n--- ROUTE A: DOM.resolveNode -> Runtime.callFunctionOn (JS-level manipulation) ---');
const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: target.backendDOMNodeId });
const res = await cdp.send('Runtime.callFunctionOn', {
  objectId: object.objectId,
  functionDeclaration: 'function () { this.value = "JS-SET"; return this.id + "|" + this.value; }',
  returnByValue: true,
});
console.log('  callFunctionOn ->', res.result.value);
console.log('  VERDICT: works, but this is a scripted mutation, NOT a real input event.');
console.log('           No focus, no keydown/keypress, no change event ordering a legacy app may depend on.');

console.log('\n--- ROUTE B: DOM.getBoxModel -> page.mouse / page.keyboard (real trusted input) ---');
const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: target.backendDOMNodeId });
const cx = (model.content[0]+model.content[4])/2, cy = (model.content[1]+model.content[5])/2;
await page.mouse.click(cx, cy);
await page.keyboard.type('10043');
const v = await page.frames().find(f=>f.name()==='content').evaluate(() => document.getElementById('ctl00_ctl32_g_9a1_txtMemberId').value);
console.log(`  clicked (${cx.toFixed(1)},${cy.toFixed(1)}) then typed -> input value = ${JSON.stringify(v)}`);
console.log('  VERDICT: real trusted input, cross-frame, no DOM mutation. No actionability checks though.');

console.log('\n--- ROUTE C: stamp a temp attribute via CDP, hand to Playwright, then unstamp ---');
const ATTR = 'data-crr-handle';
await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: `function(){ this.setAttribute('${ATTR}','1'); }` });
const handle = await page.frames().find(f=>f.name()==='content').waitForSelector(`[${ATTR}="1"]`, { timeout: 2000 });
await handle.fill('99999');
await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: `function(){ this.removeAttribute('${ATTR}'); }` });
const v2 = await page.frames().find(f=>f.name()==='content').evaluate(() => document.getElementById('ctl00_ctl32_g_9a1_txtMemberId').value);
console.log('  after fill via real ElementHandle ->', JSON.stringify(v2));
console.log('  VERDICT: gives a genuine ElementHandle with Playwright actionability + auto-wait.');
console.log('           Cost: it MUTATES the page under test. On a legacy app with MutationObservers or');
console.log('           attribute-driven server postbacks that is a real (if small) risk, and it is a write.');

console.log('\n--- ROUTE D: re-resolve by role+accessible name using Playwright locators ---');
const t0 = Date.now();
const link = page.frames().find(f=>f.name()==='content').getByRole('link', { name: 'Open' });
console.log('  getByRole("link",{name:"Open"}) count =', await link.count(), '(ambiguous: 3 rows)');
const rowScoped = page.frames().find(f=>f.name()==='content')
  .getByRole('row').filter({ has: page.getByRole('cell', { name: '10042', exact: true }) })
  .getByRole('link', { name: 'Open' });
console.log('  row-scoped by cell "10042" -> count =', await rowScoped.count(), `(${Date.now()-t0}ms)`);
await rowScoped.click(); await page.waitForTimeout(500);
console.log('  clicked -> detail frame url =', page.frames().find(f=>f.name()==='detail')?.url());
console.log('  VERDICT: durable across sessions, no DOM mutation, no coordinates. Requires the AX tree to');
console.log('           expose row/cell roles (it does here — see exp9).');
await b.close();
