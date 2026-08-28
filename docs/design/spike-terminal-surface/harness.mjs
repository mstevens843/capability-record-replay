import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/*
 * Pure-JS terminal surface harness.
 *   transport: how bytes get to/from the app  (pipe | script | node-pty)
 *   emulator:  @xterm/headless, pure JS, zero deps
 * Produces an 80x24 grid + cursor + per-cell attributes.
 */
import { spawn } from 'node:child_process';
import xtermPkg from '@xterm/headless';
const { Terminal } = xtermPkg; // v6.0.0 has no "exports" map and no working ESM entry; named ESM import fails.

export const COLS = 80, ROWS = 24;

export function openTransport(kind, cmd, args, cwd) {
  if (kind === 'pipe') {
    const c = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TERM: 'xterm-256color', COLUMNS: String(COLS), LINES: String(ROWS) } });
    return { write: (d) => c.stdin.write(d), onData: (f) => { c.stdout.on('data', f); c.stderr.on('data', f); }, kill: () => c.kill(), proc: c };
  }
  if (kind === 'script') {
    // BSD script(1) allocates a real pty. `stty` inside sets the winsize on the slave.
    const inner = `stty rows ${ROWS} cols ${COLS} -echo -onlcr 2>/dev/null; exec ${cmd} ${args.map(a => `'${a}'`).join(' ')}`;
    const c = spawn('/usr/bin/script', ['-q', '/dev/null', '/bin/sh', '-c', inner], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TERM: 'xterm-256color' } });
    return { write: (d) => c.stdin.write(d), onData: (f) => { c.stdout.on('data', f); }, kill: () => c.kill(), proc: c };
  }
  if (kind === 'node-pty') {
    // Native module. Requires a working install; see the spike notes on spawn-helper.
    const pty = require('node-pty');
    // Two pty line-discipline facts a driver must handle, neither of which exists on a pipe:
    //   ECHO  - on by default; every keystroke written is echoed back into the grid.
    //   ICANON- on by default; input is line-buffered, so 'stty -echo' alone delivers
    //           nothing to the app until ENTER. `stty raw` clears both (and opost).
    const inner = `stty raw -echo 2>/dev/null; exec ${cmd} ${args.map((a) => `'${a}'`).join(' ')}`;
    const p = pty.spawn('/bin/sh', ['-c', inner], { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd, env: { ...process.env, TERM: 'xterm-256color' } });
    return { write: (d) => p.write(d), onData: (f) => p.onData((s) => f(Buffer.from(s, 'utf8'))), kill: () => p.kill(), proc: p };
  }
  throw new Error('unknown transport ' + kind);
}

export function makeTerm() {
  return new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 0 });
}

export const writeTerm = (term, data) => new Promise((res) => term.write(data, res));

/** Snapshot the emulator into a plain, serializable grid. This is the ONLY thing
 *  the field detector is allowed to see. */
export function snapshot(term) {
  const buf = term.buffer.active;
  const rows = [];
  for (let y = 0; y < ROWS; y++) {
    const line = buf.getLine(buf.baseY + y);
    const cells = [];
    for (let x = 0; x < COLS; x++) {
      const c = line?.getCell(x);
      const chars = c?.getChars() ?? '';
      cells.push({
        ch: chars === '' ? ' ' : chars,
        inverse: !!c?.isInverse(),
        bold: !!c?.isBold(),
        underline: !!c?.isUnderline(),
        fg: c?.getFgColor() ?? -1,
        bg: c?.getBgColor() ?? -1,
      });
    }
    rows.push(cells);
  }
  return { cols: COLS, rows: ROWS, cells: rows, cursor: { x: buf.cursorX, y: buf.cursorY } };
}

export const textRow = (g, y) => g.cells[y].map((c) => c.ch).join('');

export function renderDebug(g) {
  const out = [];
  out.push('    +' + '-'.repeat(COLS) + '+');
  for (let y = 0; y < ROWS; y++) {
    const t = textRow(g, y).replace(/\s+$/, '');
    out.push(String(y).padStart(3) + ' |' + t.padEnd(COLS) + '|');
  }
  out.push('    +' + '-'.repeat(COLS) + '+');
  out.push(`    cursor = (row ${g.cursor.y}, col ${g.cursor.x})`);
  // attribute map: R=inverse, B=bold, .=plain (only rows that have any attr)
  out.push('    attribute map (R = reverse video, B = bold):');
  for (let y = 0; y < ROWS; y++) {
    const m = g.cells[y].map((c) => (c.inverse ? 'R' : c.bold ? 'B' : c.ch === ' ' ? ' ' : '.')).join('').replace(/\s+$/, '');
    if (/[RB]/.test(m)) out.push(String(y).padStart(3) + ' |' + m + '|');
  }
  return out.join('\n');
}

/** settle(): wait until the byte stream has been quiet for `quietMs`.
 *  A green screen has no load event; quiescence is the only readiness signal
 *  the transport gives you. */
export function makeSettler(onBytes) {
  let last = Date.now();
  onBytes(() => { last = Date.now(); });
  return async function settle(quietMs = 60, timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - last < quietMs) {
      if (Date.now() - start > timeoutMs) throw new Error('settle timeout');
      await new Promise((r) => setTimeout(r, 10));
    }
  };
}
