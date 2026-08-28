// `TerminalTransport` - the driver's lowest layer, and the reason there is no native dependency.
//
// The question the spike started with was "which pty library". That turned out to be the wrong
// question. A pty exists to convince a THIRD-PARTY binary that it is talking to a terminal so that
// it will emit escape sequences; it is not what a terminal surface is made of. And the real targets
// are not local subprocesses at all - Symitar Episys, AS/400 5250 and 3270 are reached over
// telnet/SSH/TN3270, which is a SOCKET with no client-side pty anywhere in the picture. A driver
// whose only transport is a pty models the demo, not the target.
//
// So the bottom of this driver is "something that takes bytes and emits bytes", and everything
// above it is unaware. The spike measured that this costs nothing: the same ten-step script through
// a pipe and through `node-pty` serialised to byte-identical grids - the same sha256 over 1.28 MB
// of JSON, all nine screens SAME. Transport is not observable above the emulator.
//
// Three implementations, in the order they matter:
//
//   memory  in-process. No child, no socket, no clock. This is what the test suite uses, and it is
//           why the terminal branch of this repo's tests costs nothing in CI.
//   pipe    `child_process.spawn` with stdio pipes. The shipping default; needs no toolchain.
//   socket  not built. It is ~20 lines over `net.Socket` and the seam is exactly this interface;
//           what it would additionally need is telnet option negotiation (WILL SGA / WILL ECHO),
//           which is the socket-shaped version of the `stty raw -echo` a pty needs.
//
// A pty implementation would slot in here too and is deliberately NOT a dependency of this package.

import { type ChildProcess, spawn } from "node:child_process";

export interface TerminalTransport {
  /** Send operator keystrokes. Raw bytes: the transport does not know what a key is. */
  write(data: string | Uint8Array): void;
  /** Subscribe to application output. Returns an unsubscribe function. */
  onData(listener: (chunk: Uint8Array) => void): () => void;
  /** Release whatever this is holding. Idempotent. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// In-memory
// ---------------------------------------------------------------------------------------------

/** A transport with both ends exposed, for driving an application that lives in this process. */
export interface MemoryTransport extends TerminalTransport {
  /** Everything the driver has written, in order. The application side reads this. */
  readonly written: readonly string[];
  /** Deliver application output to the driver. */
  emit(chunk: string | Uint8Array): void;
  /** Called with each keystroke chunk the driver writes. */
  onWrite(listener: (chunk: string) => void): () => void;
}

export function createMemoryTransport(): MemoryTransport {
  const dataListeners = new Set<(chunk: Uint8Array) => void>();
  const writeListeners = new Set<(chunk: string) => void>();
  const written: string[] = [];
  let closed = false;

  return {
    written,
    write(data) {
      if (closed) return;
      // latin1 throughout: a green screen is a byte-oriented surface, and round-tripping through
      // utf-8 would turn a single 0x9b byte into two.
      const text = typeof data === "string" ? data : Buffer.from(data).toString("latin1");
      written.push(text);
      for (const listener of writeListeners) listener(text);
    },
    emit(chunk) {
      if (closed) return;
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "latin1") : Buffer.from(chunk);
      for (const listener of dataListeners) listener(bytes);
    },
    onData(listener) {
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    },
    onWrite(listener) {
      writeListeners.add(listener);
      return () => writeListeners.delete(listener);
    },
    async close() {
      closed = true;
      dataListeners.clear();
      writeListeners.clear();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Child process over pipes
// ---------------------------------------------------------------------------------------------

export interface PipeTransportOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly cols?: number;
  readonly rows?: number;
}

export interface PipeTransport extends TerminalTransport {
  readonly child: ChildProcess;
}

/**
 * Spawn a process and speak to it over stdio pipes.
 *
 * `stderr` is merged into the data stream on purpose. On a character surface a diagnostic printed
 * to stderr lands on the operator's screen, corrupts the repaint and is exactly the kind of thing
 * the checkpoint must catch; routing it somewhere the driver cannot see would hide a real failure
 * mode behind a cleaner-looking grid.
 *
 * Two line-discipline facts a pty forces on you and a pipe does not, recorded because a socket
 * transport meets both again in telnet's vocabulary: a pty has ECHO on by default (every keystroke
 * written is echoed back into the grid) and ICANON on by default (input is line-buffered, so the
 * application receives nothing until Enter). `stty raw -echo` clears both. A pipe has neither
 * problem, which is a second reason it is the shipping default.
 */
export function createPipeTransport(options: PipeTransportOptions): PipeTransport {
  const child = spawn(options.command, [...(options.args ?? [])], {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ...options.env,
      TERM: "xterm-256color",
      COLUMNS: String(options.cols ?? 80),
      LINES: String(options.rows ?? 24),
    },
  });

  const listeners = new Set<(chunk: Uint8Array) => void>();
  const fanOut = (chunk: Buffer): void => {
    for (const listener of listeners) listener(chunk);
  };
  child.stdout?.on("data", fanOut);
  child.stderr?.on("data", fanOut);

  let closed = false;
  return {
    child,
    write(data) {
      if (closed) return;
      child.stdin?.write(
        typeof data === "string" ? Buffer.from(data, "latin1") : Buffer.from(data),
      );
    },
    onData(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      listeners.clear();
      return new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.stdin?.end();
        child.kill();
        // A child that ignores SIGTERM must not hold the process open forever. Resolving anyway is
        // the right call here: `close` is teardown, and a teardown that can hang is a hung test.
        setTimeout(() => resolve(), 500).unref?.();
      });
    },
  };
}
