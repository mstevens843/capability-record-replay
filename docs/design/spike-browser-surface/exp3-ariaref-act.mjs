import { chromium } from 'playwright';
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1200, height: 800 } });
await page.goto('http://127.0.0.1:8731/');
await page.waitForTimeout(400);
await page.ariaSnapshot({ mode: 'ai' });   // refs are minted by the snapshot; must snapshot first

async function probe(ref, label) {
  try {
    const loc = page.locator(`aria-ref=${ref}`);
    const n = await loc.count();
    const box = await loc.boundingBox();
    const txt = (await loc.textContent().catch(() => null) || '').trim().slice(0, 40);
    console.log(`  ${label.padEnd(34)} ref=${ref.padEnd(7)} count=${n} box=${JSON.stringify(box)} text=${JSON.stringify(txt)}`);
    return loc;
  } catch (e) {
    console.log(`  ${label.padEnd(34)} ref=${ref.padEnd(7)} THREW: ${String(e).split('\n')[0]}`);
    return null;
  }
}

console.log('--- resolving refs from a page-level locator ---');
await probe('e1',    'root generic (main frame)');
await probe('f1e9',  'Sign Off link (frame "banner")');
await probe('f3e37', 'Open link row 10041 (frame "content")');
await probe('f3e11', 'Member ID textbox (frame "content")');
await probe('f4e13', 'Open Sub-Account btn (nested iframe)');
await probe('f9e99', 'nonexistent ref');

console.log('');
console.log('--- can we ACT through a cross-frame aria-ref? ---');
await page.locator('aria-ref=f3e11').fill('10043');
console.log('  filled f3e11 ->', await page.locator('aria-ref=f3e11').inputValue());

const framesBefore = page.frames().map(f => f.url());
await page.locator('aria-ref=f3e37').click();       // link in frame "content", target=detail iframe
await page.waitForTimeout(600);
console.log('  clicked f3e37 (Open, member 10041) in nested-frame document');
console.log('  detail frame url now:', page.frames().find(f => f.name() === 'detail')?.url());

console.log('');
console.log('--- select/typed action in the deepest frame ---');
await page.locator('aria-ref=f4e10').selectOption('S9');
console.log('  selected S9 in f4e10; value =', await page.locator('aria-ref=f4e10').inputValue());

console.log('');
console.log('--- which Frame does a ref belong to? (owner discovery) ---');
for (const ref of ['e1', 'f1e9', 'f3e37', 'f4e13']) {
  const owner = await page.locator(`aria-ref=${ref}`).evaluate(el => ({
    frameUrl: el.ownerDocument.defaultView.location.href,
    frameName: el.ownerDocument.defaultView.name,
    tag: el.tagName,
  }));
  console.log(`  ${ref.padEnd(6)} -> frameName=${JSON.stringify(owner.frameName)} tag=${owner.tag} url=${owner.frameUrl}`);
}

console.log('');
console.log('--- do refs survive a re-snapshot / navigation? ---');
const snapA = await page.ariaSnapshot({ mode: 'ai' });
await page.locator('aria-ref=f3e16').click();  // "Search" submit in content frame -> reload
await page.waitForTimeout(700);
try {
  const c = await page.locator('aria-ref=f3e37').count();
  console.log('  after content-frame reload, old ref f3e37 count =', c);
} catch (e) {
  console.log('  after content-frame reload, old ref f3e37 THREW:', String(e).split('\n')[0]);
}
await b.close();
