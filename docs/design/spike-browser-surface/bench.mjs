import { chromium } from 'playwright';
import { attach, perceive } from './perceive.mjs';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8731/'); await page.waitForTimeout(500);
const cdp = await attach(ctx, page);
const time = async (fn, n) => { const t = []; for (let i=0;i<n;i++){ const s=performance.now(); await fn(); t.push(performance.now()-s);} t.sort((a,b)=>a-b); return { first: t[0], median: t[Math.floor(n/2)], max: t[n-1] }; };
const f = o => `min ${o.first.toFixed(1)}ms / median ${o.median.toFixed(1)}ms / max ${o.max.toFixed(1)}ms`;
// one cold call first, reported separately
let s = performance.now(); await perceive(cdp); const cold = performance.now()-s;
console.log(`cold first perceive()                     : ${cold.toFixed(1)}ms`);
console.log(`perceive() geometry:"actionable"  n=20    : ${f(await time(()=>perceive(cdp), 20))}`);
console.log(`perceive() geometry:"all"         n=20    : ${f(await time(()=>perceive(cdp,{geometry:'all'}), 20))}`);
console.log(`perceive() geometry:"none" (AX tree only) : ${f(await time(()=>perceive(cdp,{geometry:"none"}), 20))}`);
console.log(`page.ariaSnapshot({mode:"ai"})    n=20    : ${f(await time(()=>page.ariaSnapshot({mode:'ai'}), 20))}`);
console.log(`page.ariaSnapshot({...,boxes:true}) n=20  : ${f(await time(()=>page.ariaSnapshot({mode:'ai',boxes:true}), 20))}`);
console.log(`page.screenshot()                 n=10    : ${f(await time(()=>page.screenshot(), 10))}`);
await b.close();
