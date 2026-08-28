import { openTransport, makeTerm, writeTerm, snapshot } from './harness.mjs';
import { detect } from './detect.mjs';
const tenant = process.env.TENANT || 'riverbend';
const tr = openTransport('pipe', process.execPath, ['./teller.mjs']);
tr.proc.stdin.on('error', () => {});
const term = makeTerm();
let bytes = 0, lastAt = Date.now(), pending = Promise.resolve();
tr.onData((d) => { bytes += d.length; lastAt = Date.now(); pending = pending.then(() => writeTerm(term, d)); });
async function settle(min) { const t = Date.now(); for (;;) { if (bytes > min && Date.now() - lastAt >= 60) break; if (Date.now() - t > 4000) throw new Error('settle timeout'); await new Promise((r) => setTimeout(r, 5)); } await pending; }
await settle(0);
const g = snapshot(term);
for (let y = 0; y < 24; y++) { const t = g.cells[y].map((c) => c.ch).join('').replace(/\s+$/, ''); if (t) console.log(String(y).padStart(3) + ' |' + t); }
console.log('    cursor=(' + g.cursor.y + ',' + g.cursor.x + ')');
const o = detect(g);
console.log('  screenId: ' + JSON.stringify(o.screenId));
for (const n of o.nodes) console.log('   ' + JSON.stringify({ id: n.id, role: n.role, name: n.name, value: n.value, key: n.key, cap: n.capacity, focused: n.state?.focused }));
tr.kill(); process.exit(0);
