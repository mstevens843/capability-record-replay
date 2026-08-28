import { chromium } from 'playwright';

async function run(label, launchOpts) {
  console.log(`\n================ ${label} ================`);
  const b = await chromium.launch(launchOpts);
  const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:8731/xorigin.html');
  await page.waitForTimeout(800);
  const cdp = await ctx.newCDPSession(page);
  for (const d of ['Accessibility','DOM','Page']) await cdp.send(`${d}.enable`);
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const frames=[];(function w(ft){frames.push({id:ft.frame.id,url:ft.frame.url});(ft.childFrames??[]).forEach(w);})(frameTree);
  console.log(' Page.getFrameTree (page session) sees:', frames.map(f=>f.url));
  console.log(' page.frames() sees               :', page.frames().map(f=>f.url()));

  const child = page.frames()[1];
  let sess = null;
  try { sess = await ctx.newCDPSession(child); await sess.send('Accessibility.enable'); await sess.send('DOM.enable');
        console.log(' newCDPSession(childFrame): OK  -> this IS a true OOPIF'); }
  catch (e) { console.log(' newCDPSession(childFrame): THREW -> same-process frame'); }

  const useSess = sess ?? cdp;
  const args = sess ? {} : { frameId: frames.find(f=>f.url.includes('8732')).id };
  const { nodes } = await useSess.send('Accessibility.getFullAXTree', args);
  console.log(` AX nodes for the cross-origin document: ${nodes.length}`);
  const btn = nodes.find(n => n.role?.value === 'button');
  const { model } = await useSess.send('DOM.getBoxModel', { backendNodeId: btn.backendDOMNodeId });
  const q = k => ({ x: model[k][0], y: model[k][1], w: model[k][2]-model[k][0], h: model[k][7]-model[k][1] });
  const pw = await page.frameLocator('#xo').getByRole('button', { name: 'Open Sub-Account' }).boundingBox();
  const localRect = await child.evaluate(() => { const r = document.getElementById('ctl00_ctl77_btnOpenSub').getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; });
  const f = o => `x=${o.x.toFixed(1)} y=${o.y.toFixed(1)} w=${o.w.toFixed(1)} h=${o.h.toFixed(1)}`;
  console.log(` CDP content quad : ${f(q('content'))}`);
  console.log(` CDP border  quad : ${f(q('border'))}`);
  console.log(` Playwright bbox  : ${f({x:pw.x,y:pw.y,w:pw.width,h:pw.height})}`);
  console.log(` frame-local rect : ${f({x:localRect.x,y:localRect.y,w:localRect.w,h:localRect.h})}`);
  console.log(` border quad == Playwright bbox ? ${Math.abs(q('border').x-pw.x)<1 && Math.abs(q('border').y-pw.y)<1 && Math.abs(q('border').w-pw.width)<1}`);

  const hit = async (x,y,tag) => {
    await child.evaluate(() => { window.__hit=false; document.getElementById('ctl00_ctl77_btnOpenSub').onclick=()=>window.__hit=true; });
    await page.mouse.click(x,y); await page.waitForTimeout(120);
    console.log(`   click ${tag} at (${x.toFixed(1)},${y.toFixed(1)}) -> hit button = ${await child.evaluate(()=>window.__hit===true)}`);
  };
  const bq = q('border');
  await hit(bq.x+bq.w/2, bq.y+bq.h/2, 'CDP border-quad centre  ');
  await hit(localRect.x+localRect.w/2, localRect.y+localRect.h/2, 'frame-LOCAL rect centre ');
  await b.close();
}
await run('default Chromium (site isolation as shipped)', {});
await run('--site-per-process (forces a true OOPIF)', { args: ['--site-per-process'] });
