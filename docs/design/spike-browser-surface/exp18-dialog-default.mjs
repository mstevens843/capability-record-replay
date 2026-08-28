import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext()).newPage();
await p.goto('http://127.0.0.1:8731/dialog.html'); await p.waitForTimeout(200);
console.log('no dialog handler registered at all:');
await p.locator('#d1').click();               // resolves => Playwright dismissed it for us
await p.waitForTimeout(200);
console.log('  click resolved; #out =', JSON.stringify(await p.locator('#out').textContent()),
            '  => confirm() was DISMISSED (returned false), the branch never ran');
await b.close();
