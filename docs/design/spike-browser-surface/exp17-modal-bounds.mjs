import { chromium } from 'playwright';
import { attach, perceive } from './perceive.mjs';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 900, height: 600 } });
const p = await ctx.newPage(); await p.goto('http://127.0.0.1:8731/dialog.html'); await p.waitForTimeout(200);
const cdp = await attach(ctx, p);
await p.locator('#d2').click(); await p.waitForTimeout(250);
const o = await perceive(cdp, { geometry: 'all' });
const dlg = o.nodes.find(n => n.ariaRole === 'dialog');
console.log('role=dialog bounds (geometry:"all"):', JSON.stringify(dlg.bounds));
console.log('state:', JSON.stringify(dlg.state));
const inside = o.nodes.filter(n => n.ariaRole === 'button' && n.bounds &&
  n.bounds.y >= dlg.bounds.y && n.bounds.y + n.bounds.h <= dlg.bounds.y + dlg.bounds.h);
console.log('buttons geometrically inside it:', JSON.stringify(inside.map(n => n.name)));
console.log('descendants of it by AX parentage:', JSON.stringify(
  o.nodes.filter(n => { let c = n; let d = 0; while (c && d++ < 20) { if (c.id === dlg.id) return n !== dlg && n.ariaRole === 'button'; c = o.byGlobalId.get(c.parentId); } return false; }).map(n => n.name)));
console.log('\nNOTE: aria-modal is NOT surfaced as an AX property here. Present properties:',
  JSON.stringify(Object.keys(dlg.state)));
await b.close();
