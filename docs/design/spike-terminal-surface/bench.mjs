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

const grids = JSON.parse(fs.readFileSync('./grids.json', 'utf8'));
const g = grids.detail;

// 1. detect() over a frozen grid
let t = process.hrtime.bigint();
const N = 2000;
for (let i = 0; i < N; i++) detect(g);
let ns = Number(process.hrtime.bigint() - t) / N;
console.log(`detect(grid)          ${(ns / 1000).toFixed(1)} us/call   (${N} iterations)`);

// 2. snapshot() out of a live emulator
const term = makeTerm();
await writeTerm(term, '\x1b[2J\x1b[H' + 'x'.repeat(79) + '\r\n'.repeat(1));
t = process.hrtime.bigint();
for (let i = 0; i < N; i++) snapshot(term);
ns = Number(process.hrtime.bigint() - t) / N;
console.log(`snapshot(term)        ${(ns / 1000).toFixed(1)} us/call   (${N} iterations)`);

// 3. full repaint parse: 503 bytes, the size of one screen from the fixture
const paint = await capturePaint();
t = process.hrtime.bigint();
for (let i = 0; i < 500; i++) await writeTerm(term, paint);
ns = Number(process.hrtime.bigint() - t) / 500;
console.log(`term.write(1 repaint) ${(ns / 1000).toFixed(1)} us/call   (${paint.length} bytes x 500)`);

// memory
const m = process.memoryUsage();
console.log(`rss=${(m.rss / 1048576).toFixed(1)}MB heapUsed=${(m.heapUsed / 1048576).toFixed(1)}MB (one 80x24 emulator, scrollback 0)`);
