import { openTransport, makeTerm, writeTerm, snapshot, renderDebug } from './harness.mjs';
const FIX = './teller.mjs';
const TRANSPORT = process.env.TRANSPORT || 'pipe';
const t0 = Date.now();
const tr = openTransport(TRANSPORT, process.execPath, [FIX]);
const term = makeTerm();

let bytes = 0, lastAt = Date.now(), pending = Promise.resolve();
tr.onData((d) => { bytes += d.length; lastAt = Date.now(); pending = pending.then(() => writeTerm(term, d)); });

/** Wait for the app to repaint: at least one new byte, then `quiet` ms of silence. */
async function settle(minBytes, quiet = 50, timeout = 4000) {
  const start = Date.now();
  for (;;) {
    if (bytes > minBytes && Date.now() - lastAt >= quiet) break;
    if (Date.now() - start > timeout) throw new Error(`settle timeout (bytes=${bytes} want>${minBytes})`);
    await new Promise((r) => setTimeout(r, 5));
  }
  await pending;
}
async function step(label, keys, opts = {}) {
  const before = bytes;
  if (keys !== undefined) tr.write(keys);
  await settle(keys === undefined ? 0 : before);
  const g = snapshot(term);
  console.log(`\n=== ${label}   [transport=${TRANSPORT}] (t+${Date.now() - t0}ms, ${bytes} bytes total) ===`);
  console.log(opts.short ? shortDump(g) : renderDebug(g));
  return g;
}
function shortDump(g) {
  const lines = [];
  for (let y = 0; y < 24; y++) {
    const t = g.cells[y].map((c) => c.ch).join('').replace(/\s+$/, '');
    if (t) lines.push(String(y).padStart(3) + ' |' + t);
  }
  lines.push('    cursor = (row ' + g.cursor.y + ', col ' + g.cursor.x + ')');
  return lines.join('\n');
}
const grids = {};
grids.initial = await step('1. initial screen');
grids.typed = await step('2. type "12345" into the focused field', '12345', { short: true });
grids.tabbed = await step('3. TAB (focus moves to Name Search)', '\t', { short: true });
grids.detail = await step('4. TAB back + ENTER -> member detail', '\t\r');
grids.arrowed = await step('5. cursor-down x2 (list selection moves)', '\x1b[B\x1b[B', { short: true });
grids.opened = await step('6. ENTER on the selected suffix', '\r', { short: true });
await step('7. F3 back to inquiry', '\x1bOR', { short: true });
grids.notfound = await step('8. type 77777 + ENTER -> business outcome', '77777\r', { short: true });
grids.denied  = await step('9. clear, 99999 + ENTER -> permission denial', '\x7f\x7f\x7f\x7f\x7f99999\r', { short: true });
grids.invalid = await step('10. clear, ABC + ENTER -> validation error', '\x7f\x7f\x7f\x7f\x7fABC\r', { short: true });
const fs = await import('node:fs');
fs.writeFileSync(process.env.OUT || './grids.json', JSON.stringify(grids));
console.log('\nTOTAL bytes from app:', bytes);
tr.kill(); process.exit(0);
