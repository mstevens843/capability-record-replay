import { chromium } from 'playwright';
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1200, height: 800 } });
await page.goto('http://127.0.0.1:8731/');
await page.waitForTimeout(400);

console.log('===== page.ariaSnapshot({ mode: "ai", boxes: true }) on the FRAMESET root =====');
const ai = await page.ariaSnapshot({ mode: 'ai', boxes: true });
console.log(ai);
console.log('===== end =====');
console.log('bytes:', ai.length, ' lines:', ai.split('\n').length);
await b.close();
