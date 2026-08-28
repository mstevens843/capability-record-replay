/* Does quiescence alone give a sound "screen ready" signal? No. */
import fs from 'node:fs';
import { makeTerm, writeTerm, snapshot } from './harness.mjs';
import { detect } from './detect.mjs';
import { spawn } from 'node:child_process';
/** Capture one full repaint from the fixture (503 bytes) if it is not on disk yet. */
async function capturePaint() {
  if (fs.existsSync('./paint.bin')) return fs.readFileSync('./paint.bin');
  const c = spawn(process.execPath, ['./teller.mjs'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const bufs = [];
  c.stdout.on('data', (d) => bufs.push(d));
  await new Promise((r) => setTimeout(r, 400));
  c.kill();
  const b = Buffer.concat(bufs);
  fs.writeFileSync('./paint.bin', b);
  return b;
}

const paint = await capturePaint();
const term = makeTerm();
const cut = Math.floor(paint.length * 0.55);
await writeTerm(term, paint.subarray(0, cut));   // server stalls mid-repaint
await new Promise((r) => setTimeout(r, 120));    // longer than the 60ms quiet window
const torn = snapshot(term);
const o = detect(torn);
console.log('--- snapshot taken after 120ms of silence, mid-repaint ---');
for (let y = 0; y < 24; y++) { const t = torn.cells[y].map((c) => c.ch).join('').replace(/\s+$/, ''); if (t) console.log(String(y).padStart(3) + ' |' + t); }
console.log('  screenId:', JSON.stringify(o.screenId));
console.log('  nodes:', o.nodes.map((n) => n.id).join(', ') || '(none)');
await writeTerm(term, paint.subarray(cut));
const whole = detect(snapshot(term));
console.log('\n--- after the rest of the repaint arrives ---');
console.log('  screenId:', JSON.stringify(whole.screenId));
console.log('  nodes:', whole.nodes.map((n) => n.id).join(', '));
console.log('\nVERDICT: quiescence alone yielded a DIFFERENT observation ->', JSON.stringify(o.screenId) !== JSON.stringify(whole.screenId) || o.nodes.length !== whole.nodes.length);
