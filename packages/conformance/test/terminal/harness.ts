// One green-screen run: fixture, transport, driver, broker, interpreter.
//
// IN `test/` AND NOT IN `src/`, and the reason is a contract test rather than taste. `@crr/core`'s
// `no-locator-vocabulary.test.ts` reads every `packages/*/src` module off disk and fails on an
// import of any driver, because `crr`'s central claim is that the driver is a PARAMETER
// (`--surface <module>`) and one convenience import would end it while breaking nothing. This file
// imports `@crr/surface-terminal` for real, so it belongs where `@crr/runtime`'s own
// browser-driving support already lives: beside the tests that use it. The DOCUMENTS it runs -
// contract, artifact, overlay, allowlist - stay in `src/corpus/terminal.ts` and ship, because they
// are data and a reader should be able to import them.
//
// The whole stack runs in this process. `fixtures/corebank-tui` is a byte-in / frame-out state
// machine that knows nothing about processes, so keystroke -> application -> ANSI frame -> VT parser
// -> grid -> detector -> Observation -> classifier -> verdict happens with no child process, no
// socket and no clock beyond a quiet window. That is why the terminal half of this suite costs
// milliseconds, and `@crr/surface-terminal`'s `transport.test.ts` is what keeps it honest: it runs
// the same fixture as a spawned child behind the pipe transport and asserts the grids are identical.
//
// TWO THINGS THIS HARNESS DOES NOT DO, both deliberate.
//
// It does not use a manual clock. The browser corpus can, because `MockSurface` replays frozen
// observations and time is a fiction there. Here the surface's readiness signal IS elapsed silence,
// so a manual clock would have to drive the settle loop and the quiet window in lock step and would
// end up measuring itself. The budgets are wall-clock and the settle windows are milliseconds; the
// suite still runs in under a second.
//
// It does not let the program sign on. `TellerBroker.refresh` types the operator id, which is the
// division SPEC section 7.6 asks for and which a green screen makes unusually easy to get wrong -
// the sign-on screen is right there and turning it into two steps would put a credential in an
// artifact.

import { type TellerApp, type TellerAppOptions, createTellerApp } from "@crr/fixture-corebank-tui";
import {
  MemoryEvidenceSink,
  MemoryJournal,
  type ReplayOutput,
  type SessionBroker,
  type TenantRef,
  replay,
  sequentialIds,
  systemClock,
} from "@crr/runtime";
import {
  type MemoryTransport,
  TerminalSurface,
  createMemoryTransport,
} from "@crr/surface-terminal";
import {
  TERMINAL_ORIGIN,
  type TerminalFlowOptions,
  riverbendOverlay,
  summitOverlay,
  terminalAllowlist,
  terminalArtifact,
  terminalContract,
  terminalTrust,
} from "../../src/corpus/terminal.js";
import type { ReplayEngine } from "../../src/types.js";

/** The account numbers the fixture holds, and the three conditions that are facts about the
 *  ARGUMENT rather than injected faults. */
export const MEMBER_ON_FILE = "12345";
export const MEMBER_NOT_ON_FILE = "77777";
export const MEMBER_RESTRICTED = "99999";

/**
 * A broker that owns the operator credential.
 *
 * `open` hands over a session somebody else established - here, a transport that is already
 * attached and a screen that is already painted. `refresh` types an operator id and presses Enter,
 * which is what actually clears the fixture's sticky `session-timeout` fault. A broker that reported
 * `refreshed` without doing that would make `session-expired-unrecoverable` unreachable and a dead
 * session look recoverable forever, which is the failure `StaticSessionBroker`'s default guards
 * against by reporting `failed`.
 */
class TellerBroker implements SessionBroker {
  #refreshes = 0;

  constructor(
    private readonly surface: TerminalSurface,
    private readonly transport: MemoryTransport,
    private readonly settle: () => Promise<void>,
    private readonly canRefresh: boolean,
  ) {}

  get refreshes(): number {
    return this.#refreshes;
  }

  async open(_profile: string, _tenant: TenantRef) {
    return { sessionId: "green-session", surface: this.surface };
  }

  async refresh(): Promise<"refreshed" | "reopened" | "failed"> {
    this.#refreshes += 1;
    if (!this.canRefresh) return "failed";
    // The operator id is the broker's, never the artifact's.
    this.transport.write("TLR04\r");
    await this.settle();
    return "refreshed";
  }

  async close(): Promise<void> {
    await this.surface.close();
  }
}

export interface TerminalHarnessOptions extends TerminalFlowOptions {
  readonly tenant?: "riverbend" | "summit";
  readonly memberNumber?: string;
  /** One of `fixtures/corebank-tui`'s four injectable faults. */
  readonly fault?: TellerAppOptions["fault"];
  readonly faultAt?: string;
  readonly delayMs?: number;
  readonly tearAt?: number;
  /** How long the byte stream must be silent before the driver calls itself settled. */
  readonly quietMs?: number;
  /** A broker that cannot really re-authenticate, for the unrecoverable-session case. */
  readonly brokerCanRefresh?: boolean;
  readonly onIntervention?: "suspend" | "fail";
}

export interface TerminalRun {
  readonly out: ReplayOutput;
  readonly app: TellerApp;
  readonly surface: TerminalSurface;
  /** Every byte the driver wrote to the transport, concatenated. This is where an F-key shows up. */
  readonly keystrokes: string;
  readonly refreshes: number;
  close(): Promise<void>;
}

/**
 * Run the terminal capability once, through `@crr/runtime`'s real `replay()`.
 *
 * `engine` is the same `ReplayEngine` the browser scenarios take, so a weakened engine drives the
 * green screen through this identical host - the same linker, lease, budget ledgers, session broker,
 * policy chokepoint and journal - and "the suite discriminates" means the same thing on both
 * surfaces.
 */
export async function runTerminalFlow(
  engine: ReplayEngine,
  options: TerminalHarnessOptions = {},
): Promise<TerminalRun> {
  const tenantId = options.tenant ?? "riverbend";
  const quietMs = options.quietMs ?? 15;
  const transport = createMemoryTransport();
  const app = createTellerApp({
    tenant: tenantId,
    ...(options.fault === undefined ? {} : { fault: options.fault }),
    ...(options.faultAt === undefined ? {} : { faultAt: options.faultAt }),
    ...(options.delayMs === undefined ? {} : { delayMs: options.delayMs }),
    ...(options.tearAt === undefined ? {} : { tearAt: options.tearAt }),
  });
  // Both directions, and the order matters: the surface has to be listening before the app paints,
  // or the first frame goes nowhere and every later assertion is about a blank screen.
  app.onOutput((chunk) => transport.emit(chunk));
  transport.onWrite((chunk) => app.write(chunk));

  const surface = new TerminalSurface({
    transport,
    quietMs,
    // No `lease` here on purpose. `TerminalSurface` exposes `grantLease`/`revokeLease`, so the
    // runtime's `LeaseAuthority` recognises it as a lease sink and pushes every minted token down
    // to the port itself - which is what makes "the driver checks the lease" a fact rather than a
    // convention, and what makes a token minted under an older epoch stop validating AT the port.
    //
    // Without this the driver reports `route: null` and the policy chokepoint denies every action
    // it is asked about. See `routeOfScreen`.
    originAlias: TERMINAL_ORIGIN,
  });
  app.start();

  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, quietMs * 4));
    await surface.drain();
  };
  await settle();

  const broker = new TellerBroker(surface, transport, settle, options.brokerCanRefresh ?? true);

  const out = await replay({
    contract: terminalContract,
    artifact: terminalArtifact(options),
    overlay: tenantId === "summit" ? summitOverlay : riverbendOverlay,
    args: { memberNumber: options.memberNumber ?? MEMBER_ON_FILE },
    tenant: { tenantId, appInstanceId: `${tenantId}-green` },
    allowlist: terminalAllowlist,
    broker,
    trust: terminalTrust,
    clock: systemClock(),
    ids: sequentialIds("tui"),
    evidence: new MemoryEvidenceSink(),
    journal: (runId, clock) => new MemoryJournal({ runId, clock }),
    onIntervention: options.onIntervention ?? "fail",
    ...(engine.decisions === undefined ? {} : { decisions: engine.decisions }),
  });

  return {
    out,
    app,
    surface,
    keystrokes: transport.written.join(""),
    refreshes: broker.refreshes,
    async close() {
      app.close();
      await surface.close();
    },
  };
}
