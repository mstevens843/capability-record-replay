import { chromium } from 'playwright';
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1200, height: 800 } });
await page.goto('http://127.0.0.1:8731/');
await page.waitForTimeout(400);

const nameOf = async (ref) => {
  try { return (await page.locator(`aria-ref=${ref}`).evaluate(el => (el.textContent||'').trim().slice(0,32))); }
  catch (e) { return 'ERR: ' + String(e).split('\n')[0].slice(0, 90); }
};

console.log('A) two refs from ONE snapshot, no navigation between uses');
await page.ariaSnapshot({ mode: 'ai' });
console.log('   f3e32 ->', await nameOf('f3e32'));
console.log('   f3e39 ->', await nameOf('f3e39'), '(second use of same snapshot, no re-snapshot)');

console.log('');
console.log('B) DOM mutation in that frame WITHOUT navigation — do old refs survive?');
await page.frames().find(f => f.name() === 'content').evaluate(() => {
  const t = document.getElementById('ctl00_ctl32_g_9a1_grdResults');
  const tr = t.insertRow(1);
  tr.innerHTML = '<td>99999</td><td>INSERTED, ROW</td><td>0.00</td><td>NEW</td><td>-</td>';
});
await page.waitForTimeout(200);
console.log('   f3e32 (was "10041") ->', await nameOf('f3e32'));
console.log('   f3e39 (was "10042") ->', await nameOf('f3e39'));

console.log('');
console.log('C) RE-SNAPSHOT after the mutation — does ref f3e32 now point at a DIFFERENT element?');
const snap = await page.ariaSnapshot({ mode: 'ai' });
console.log('   f3e32 ->', await nameOf('f3e32'));
console.log('   snapshot rows now:');
for (const line of snap.split('\n')) if (/cell "(10041|10042|10043|99999)"/.test(line)) console.log('     ', line.trim());

console.log('');
console.log('D) after a frame NAVIGATION, are that frame\'s refs invalid?');
await page.frames().find(f => f.name() === 'content').goto('http://127.0.0.1:8731/members.html');
await page.waitForTimeout(400);
console.log('   f3e32 (no re-snapshot after nav) ->', await nameOf('f3e32'));

console.log('');
console.log('E) are refs in OTHER frames still valid after that navigation?');
console.log('   f1e9 (banner "Sign Off") ->', await nameOf('f1e9'));

console.log('');
console.log('F) does a ref from an OLD snapshot resolve after a NEW snapshot renumbers?');
await page.ariaSnapshot({ mode: 'ai' });
console.log('   f3e32 ->', await nameOf('f3e32'));
await b.close();
