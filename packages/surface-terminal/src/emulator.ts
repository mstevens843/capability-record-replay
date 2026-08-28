// The VT emulator: bytes in, `Grid` out.
//
// `@xterm/headless` is the parser and screen buffer out of VS Code's terminal. Pure JavaScript,
// zero runtime dependencies, 1.9 MB, no native build and therefore no toolchain a reviewer has to
// have installed. The spike measured the alternative and the alternative loses badly (see
// `docs/design/spike-terminal-surface.md` section 1.3): `node-pty@1.1.0` ships `spawn-helper`
// without the executable bit, is broken out of the box on darwin-arm64, is not fixed by
// `pnpm approve-builds`, loses a manual `chmod +x` on the next unrelated install, and has no Linux
// prebuilds at all.
//
// One packaging wart, and it costs ten minutes if you have not seen it:
//
//   import { Terminal } from "@xterm/headless";   // SyntaxError: Named export 'Terminal' not found
//
// v6.0.0 ships NO `exports` map and its `module` field points at `lib/xterm.mjs`, which is not in
// the tarball. Node therefore resolves the bare specifier through `main` to the CommonJS build, and
// a named ESM import fails at load. The default import below goes through the same `main` and will
// keep working if the package later gains an `exports` map. Do not "fix" it back.

import xtermPkg from "@xterm/headless";
import type { Grid, GridCell } from "./grid.js";

const { Terminal } = xtermPkg;

export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

export interface EmulatorOptions {
  readonly cols?: number;
  readonly rows?: number;
}

/**
 * A screen buffer with no I/O attached.
 *
 * `write` is asynchronous because xterm's parser is: it queues, and a snapshot taken before the
 * queue drains is a torn read of our own making rather than the application's. Every caller awaits.
 */
export class TerminalEmulator {
  readonly #term: InstanceType<typeof Terminal>;
  readonly #cols: number;
  readonly #rows: number;

  constructor(options: EmulatorOptions = {}) {
    this.#cols = options.cols ?? DEFAULT_COLS;
    this.#rows = options.rows ?? DEFAULT_ROWS;
    this.#term = new Terminal({
      cols: this.#cols,
      rows: this.#rows,
      allowProposedApi: true,
      // No scrollback. An inquiry screen does not scroll, and a scrollback buffer would let a
      // repaint push the previous screen's rows into history where `baseY` arithmetic gets them
      // back into the grid - a whole class of phantom nodes that simply cannot occur at 0.
      scrollback: 0,
    });
  }

  get cols(): number {
    return this.#cols;
  }

  get rows(): number {
    return this.#rows;
  }

  /** Feed bytes to the parser and resolve once they have been applied to the buffer. */
  write(data: string | Uint8Array): Promise<void> {
    return new Promise((resolve) => {
      this.#term.write(typeof data === "string" ? data : Buffer.from(data), () => resolve());
    });
  }

  /**
   * The buffer as plain data. This is the ONLY thing the detector is allowed to see, and it is the
   * boundary that makes the detector testable from a JSON file with nothing running.
   */
  snapshot(): Grid {
    const buffer = this.#term.buffer.active;
    const cells: GridCell[][] = [];
    for (let y = 0; y < this.#rows; y++) {
      const line = buffer.getLine(buffer.baseY + y);
      const row: GridCell[] = [];
      for (let x = 0; x < this.#cols; x++) {
        const cell = line?.getCell(x);
        const chars = cell?.getChars() ?? "";
        row.push({
          // xterm reports "" for a cell that has never been written and for the continuation half
          // of a double-width character. Both read as a space here; double-width handling is a
          // stated gap (spike section 3.5) rather than a silent one.
          ch: chars === "" ? " " : chars,
          // NOT `=== 1`. These predicates return the masked ATTRIBUTE BIT, not a boolean and not
          // one: `isInverse()` is `fg & 0x400000`, so an inverse cell answers 4194304. Comparing
          // against 1 compiles, typechecks, and reports every field on the screen as plain text -
          // which is a driver that perceives nothing while looking like it works.
          inverse: (cell?.isInverse() ?? 0) !== 0,
          bold: (cell?.isBold() ?? 0) !== 0,
          underline: (cell?.isUnderline() ?? 0) !== 0,
          fg: cell?.getFgColor() ?? -1,
          bg: cell?.getBgColor() ?? -1,
        });
      }
      cells.push(row);
    }
    return {
      cols: this.#cols,
      rows: this.#rows,
      cells,
      cursor: { x: buffer.cursorX, y: buffer.cursorY },
    };
  }

  dispose(): void {
    this.#term.dispose();
  }
}
