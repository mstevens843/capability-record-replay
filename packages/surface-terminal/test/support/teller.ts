// Wiring the green-screen fixture to the driver, entirely in this process.
//
// The fixture app knows nothing about processes: it takes bytes and emits frames. So the whole
// stack - keystroke, application, ANSI frame, VT parser, grid, detector, Observation - runs with no
// child process, no socket and no clock beyond the quiet window. That is what makes the terminal
// branch of this suite cost nothing in CI, and it is only possible because the transport is a port.
//
// `test/transport.test.ts` runs the same fixture the other way, as a spawned child behind the pipe
// transport, and asserts the two produce the same grid. Without that second test this file would be
// proving the driver works against a fake.

import type { LeaseToken, Observation } from "@crr/core";
import { type TellerApp, type TellerAppOptions, createTellerApp } from "@crr/fixture-corebank-tui";
import type { Grid } from "../../src/grid.js";
import { TerminalSurface } from "../../src/surface.js";
import { type MemoryTransport, createMemoryTransport } from "../../src/transport.js";

/** A lease this harness holds for the whole run. Real ones are minted by the runtime. */
export const TEST_LEASE = "lease-terminal-test" as LeaseToken;

export interface TellerHarness {
  readonly app: TellerApp;
  readonly transport: MemoryTransport;
  readonly surface: TerminalSurface;
  /** Send keystrokes and wait for the byte stream to go quiet. */
  send(keys: string): Promise<void>;
  /** Wait for quiet without sending anything - for a delayed or a torn repaint. */
  quiet(ms?: number): Promise<void>;
  /** The raw grid, with the parser drained first. */
  grid(): Promise<Grid>;
  observe(): Promise<Observation>;
  close(): Promise<void>;
}

export interface HarnessOptions extends TellerAppOptions {
  /** Short by default: these tests are not measuring the fixture's latency. */
  readonly quietMs?: number;
  /** How long `quiet()` waits by default. Normally a multiple of `quietMs`; a test that wants to
   *  observe an UNSETTLED surface sets it below `quietMs` on purpose. */
  readonly settleWaitMs?: number;
}

export async function openTeller(options: HarnessOptions = {}): Promise<TellerHarness> {
  const quietMs = options.quietMs ?? 15;
  const transport = createMemoryTransport();
  const app = createTellerApp(options);
  // Both directions, and the order matters: the surface must be listening before the app paints,
  // or the first frame is delivered to nobody and every later assertion is about a blank screen.
  app.onOutput((chunk) => transport.emit(chunk));
  transport.onWrite((chunk) => app.write(chunk));
  const surface = new TerminalSurface({ transport, quietMs, lease: TEST_LEASE });
  app.start();

  const defaultWait = options.settleWaitMs ?? quietMs * 4;
  const quiet = async (ms = defaultWait): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await surface.drain();
  };

  await quiet();
  return {
    app,
    transport,
    surface,
    async send(keys) {
      transport.write(keys);
      await quiet();
    },
    quiet,
    async grid() {
      await surface.drain();
      return surface.snapshot();
    },
    async observe() {
      const result = await surface.perceive({ deadlineMs: 2_000 });
      if (!result.ok) throw new Error(`perceive failed: ${result.fault.kind}`);
      return result.observation;
    },
    async close() {
      app.close();
      await surface.close();
    },
  };
}
