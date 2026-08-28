// The terminal `Surface`: an 80x24 character grid behind the same four methods a browser sits
// behind, and nothing above the port can tell which one it is talking to.
//
// This driver exists to FALSIFY the port. A port that has only ever had a Playwright implementation
// behind it is a claim; a port with a character grid behind it - no DOM, no accessibility tree, no
// selectors, focus expressed solely as a cursor position and readiness expressed solely as silence
// - is a demonstrated boundary. Where the port fitted, `observe.ts` marks the place [P1]-[P4].
// Where it fitted BADLY, the three places are here, and they are stated rather than smoothed over:
//
//   (a) FOCUS IS NOT ADDRESSABLE. A browser focuses a node by naming it. A green screen has one
//       cursor and one way to move it: Tab. So `focus` is a bounded search - press Tab, look, press
//       Tab - and it can fail. The port already allowed for this ("making a node actionable is the
//       SURFACE's obligation before it acts") but the closest `ActFault` reason is
//       `off-screen-unscrollable`, which is a browser word for a grid condition. It is the right
//       ARM and the wrong NOUN, and the honest fix is a `why: "unreachable"` member rather than
//       pretending the fit is exact.
//   (b) `click` HAS NO MEANING HERE, and that is fine. `activate` lowers to `click` at the port
//       (linker `actionKindsFor`), so this driver interprets a click on a control as "press the key
//       its legend binds" and a click on a row as "walk the selection onto it". That is the port
//       working as designed - the program says what the operator meant - but it does mean the
//       action's NAME is browser-flavoured where its semantics are not.
//   (c) THERE IS NO NATIVE DIALOG CHANNEL and nothing to navigate to. Both are reported absent
//       rather than faked, which the linker turns into a load-time refusal instead of a mystery six
//       steps in. A LOCATION is a different question and this surface does have one - the screen-id
//       band - which it reports as a route once `originAlias` says which system it is attached to.
//       Unit 21 learned the hard way that these two must be separated: the policy chokepoint
//       refuses every action whose route is null, so a driver that conflated "cannot navigate" with
//       "has no location" could observe a green screen forever and never press a key.
//
// Everything else - Observation, UINode, the descriptor kinds, the classifier, the checkpoint -
// needed no widening at all.

import {
  type ActFault,
  type ActResult,
  type Action,
  type Capture,
  type CaptureRequest,
  type Digest,
  type LeaseToken,
  type NodeId,
  type PerceiveResult,
  type Role,
  type Surface,
  type SurfaceCapabilities,
  type SurfaceKind,
  sha256Bytes,
} from "@crr/core";
import { type CaptureSink, MemoryGridSink } from "./capture-sink.js";
import { detect } from "./detect.js";
import { DEFAULT_COLS, DEFAULT_ROWS, TerminalEmulator } from "./emulator.js";
import { type Grid, type GridCell, renderGridText } from "./grid.js";
import { TERMINAL_SUPPORTED_KEYS, bytesForKey, typableText } from "./keys.js";
import { type TerminalObservation, type TerminalTarget, observationOf } from "./observe.js";
import type { TerminalTransport } from "./transport.js";

export const TERMINAL_DRIVER = "surface-terminal@0.1.0";

/** Computed from what the mapping in `observe.ts` can actually emit, so the advertisement cannot
 *  drift away from the driver's behaviour. */
export const TERMINAL_SUPPORTED_ROLES: readonly Role[] = Object.freeze([
  "heading",
  "textbox",
  "button",
  "text",
  "status",
  "table",
  "row",
  "cell",
] satisfies Role[]);

export class TerminalSurfaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalSurfaceError";
  }
}

export interface TerminalSurfaceOptions {
  readonly transport: TerminalTransport;
  readonly cols?: number;
  readonly rows?: number;
  readonly lease?: LeaseToken | null;
  readonly driver?: string;
  readonly surfaceKind?: SurfaceKind;
  /**
   * The symbolic name of the system on the other end of the transport, e.g. `corebank-green`.
   *
   * WITHOUT IT THIS SURFACE CANNOT ACT THROUGH THE INTERPRETER, and that is by design rather than
   * an oversight: `@crr/core`'s policy chokepoint denies every action whose route is null, so an
   * unconfigured driver is one that observes and refuses. The grid cannot supply this - an 80x24
   * screen says which PROGRAM you are in and never which HOST - so it is deployment configuration,
   * resolved per tenant exactly like a browser origin alias. See `routeOfScreen`.
   */
  readonly originAlias?: string | null;
  /**
   * How long the byte stream must be silent before this surface calls itself settled.
   *
   * A CHEAP TRIGGER, never evidence. The spike delivered 55% of a repaint and then stopped: after
   * this window the surface reports `settled: true` and the observation is a torn read with three
   * nodes instead of eight and no screen id. That is not a bug to be tuned away by raising the
   * window - no window is sound, because the application can always pause for longer than it. The
   * readiness gate is the step's checkpoint, and the torn read fails it.
   */
  readonly quietMs?: number;
  /** Ceiling on one internal settle inside `act`, e.g. between two Tab presses while focusing. */
  readonly actSettleMs?: number;
  readonly captureSink?: CaptureSink;
}

export class TerminalSurface implements Surface {
  readonly #transport: TerminalTransport;
  readonly #emulator: TerminalEmulator;
  readonly #capabilities: SurfaceCapabilities;
  readonly #quietMs: number;
  readonly #actSettleMs: number;
  readonly #sink: CaptureSink;
  readonly #originAlias: string | null;
  readonly #detach: () => void;

  #lease: LeaseToken | null;
  #closed = false;
  #seq = 0;
  #generation = 0;
  #bytes = 0;
  #lastByteAt = Date.now();
  /** Applied writes, chained: xterm's parser is asynchronous, so a snapshot taken before the queue
   *  drains would be a torn read of OUR making rather than the application's. */
  #applied: Promise<void> = Promise.resolve();
  #targets: ReadonlyMap<NodeId, TerminalTarget> = new Map();
  readonly #maskedIds = new Set<string>();

  constructor(options: TerminalSurfaceOptions) {
    this.#transport = options.transport;
    this.#emulator = new TerminalEmulator({
      cols: options.cols ?? DEFAULT_COLS,
      rows: options.rows ?? DEFAULT_ROWS,
    });
    this.#quietMs = options.quietMs ?? 60;
    this.#actSettleMs = options.actSettleMs ?? 2_000;
    this.#sink = options.captureSink ?? new MemoryGridSink();
    this.#originAlias = options.originAlias ?? null;
    this.#lease = options.lease ?? null;
    this.#capabilities = Object.freeze({
      kind: options.surfaceKind ?? "terminal",
      driver: options.driver ?? TERMINAL_DRIVER,
      // No `navigate`: there is no route. No `select`/`setChecked`: a green screen has neither
      // widget. No dialog actions: there is no native dialog channel. Every absence is a load-time
      // refusal (linker check 17) instead of a runtime surprise.
      supportedActions: ["click", "type", "pressKey", "focus"],
      supportedKeys: TERMINAL_SUPPORTED_KEYS,
      supportedRoles: TERMINAL_SUPPORTED_ROLES,
      resolvableDescriptors: [
        "role-name",
        "label-anchored",
        "table-cell",
        "ordinal-in-container",
        "geometric",
      ],
      containerKinds: ["screen", "table"],
      boundsUnit: "cell",
      // Below 1.0 because this driver INFERS every role it reports. `detect.ts` scores each node on
      // whether its identity was read off the screen or guessed from position, and 0.6 sits between
      // the two clusters - so a descriptor resting on an unanchored reverse-video run abstains
      // rather than voting. On a real accessibility tree there is nothing to be unsure about and
      // the browser driver reports 1.0.
      confidenceFloor: 0.6,
      canCapture: ["text-grid"],
    } satisfies SurfaceCapabilities);

    this.#detach = this.#transport.onData((chunk) => {
      this.#bytes += chunk.length;
      this.#lastByteAt = Date.now();
      this.#generation += 1;
      this.#applied = this.#applied.then(() => this.#emulator.write(chunk));
    });
  }

  // -------------------------------------------------------------------------------------------
  // The port
  // -------------------------------------------------------------------------------------------

  /**
   * A snapshot, bounded by a deadline this driver honours with its own timer.
   *
   * It does NOT block until the screen is ready, and that is deliberate: `stability.settled` is the
   * surface's report, and an executor that never sees an unsettled observation cannot run a settle
   * loop. The browser driver behaves the same way for the same reason.
   */
  async perceive(opts: { readonly deadlineMs: number }): Promise<PerceiveResult> {
    this.#assertOpen("perceive");
    if (!Number.isInteger(opts.deadlineMs) || opts.deadlineMs <= 0) {
      throw new TerminalSurfaceError(
        `perceive needs a positive integer deadlineMs, got ${String(opts.deadlineMs)}`,
      );
    }
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), opts.deadlineMs);
    });
    try {
      const drained = await Promise.race([this.#applied.then(() => "drained" as const), expiry]);
      if (drained === "timeout") {
        return { ok: false, fault: { kind: "perceive-timeout", elapsedMs: Date.now() - started } };
      }
      return { ok: true, observation: this.#observe().observation };
    } catch (error) {
      return { ok: false, fault: { kind: "surface-error", message: messageOf(error) } };
    } finally {
      clearTimeout(timer);
    }
  }

  /** One action, with the control lease enforced at the port rather than upstairs. */
  async act(action: Action, lease: LeaseToken): Promise<ActResult> {
    this.#assertOpen("act");
    if (this.#lease === null || lease !== this.#lease) {
      return { ok: false, fault: { kind: "lease-not-held" } };
    }
    // Everything below reads the buffer to decide what to send - where the cursor is, what a field
    // currently holds - so the parser queue has to be empty first. Acting on a half-applied buffer
    // is the same torn read `perceive` is careful about, one method over.
    await this.#applied;

    switch (action.kind) {
      case "focus": {
        const found = this.#lookup(action.target);
        if ("fault" in found) return { ok: false, fault: found.fault };
        return this.#reach(found.target, action.target);
      }
      case "click": {
        const found = this.#lookup(action.target);
        if ("fault" in found) return { ok: false, fault: found.fault };
        return this.#activate(found.target, action.target);
      }
      case "pressKey": {
        if (action.target !== null) {
          const found = this.#lookup(action.target);
          if ("fault" in found) return { ok: false, fault: found.fault };
          const reached = await this.#reach(found.target, action.target);
          if (!reached.ok) return reached;
        }
        this.#send(bytesForKey(action.key));
        return { ok: true, dispatched: true };
      }
      case "type": {
        const found = this.#lookup(action.target);
        if ("fault" in found) return { ok: false, fault: found.fault };
        if (found.target.kind !== "field") {
          return {
            ok: false,
            fault: { kind: "not-actionable", nodeId: action.target, why: "disabled" },
          };
        }
        const reached = await this.#reach(found.target, action.target);
        if (!reached.ok) return reached;
        return this.#type(action.target, found.target, action.text, action.sensitive);
      }
      default:
        // Not advertised, so the linker refuses a program that needs one before this driver is
        // ever asked. Reaching here means something bypassed the linker, which is worth saying.
        return {
          ok: false,
          fault: {
            kind: "surface-error",
            message: `the terminal surface does not implement "${action.kind}"; it is not in supportedActions`,
          },
        };
    }
  }

  /**
   * Evidence only. This surface's screenshot is a text dump of the grid, and nothing upstream
   * notices - which is the clearest single demonstration that keeping `capture` off the decision
   * path was the right call.
   *
   * Masking is applied to the GRID, before the text exists. A dump that was ever unmasked in memory
   * is a dump that can leak.
   */
  async capture(req: CaptureRequest): Promise<Capture> {
    this.#assertOpen("capture");
    if (!this.#capabilities.canCapture.includes(req.format)) {
      throw new TerminalSurfaceError(
        `this surface cannot capture "${req.format}" (it advertises ${this.#capabilities.canCapture.join(", ")})`,
      );
    }
    await this.#applied;
    const grid = this.#emulator.snapshot();
    const { masked, count } = blankGridRegions(grid, req.maskRegions);
    const bytes = new TextEncoder().encode(renderGridText(masked));
    const digest = `sha256:${sha256Bytes(bytes)}` as Digest;
    const ref = await this.#sink.put(bytes, "text/plain");
    return { ref, digest, maskedRegions: count };
  }

  capabilities(): SurfaceCapabilities {
    return this.#capabilities;
  }

  // -------------------------------------------------------------------------------------------
  // Driver-level control, below the port
  // -------------------------------------------------------------------------------------------

  grantLease(token: LeaseToken): void {
    this.#lease = token;
  }

  revokeLease(): void {
    this.#lease = null;
  }

  /** The last detection, for a test or an operator console that wants the grid behind the nodes. */
  snapshot(): Grid {
    return this.#emulator.snapshot();
  }

  /** Resolve once every byte received so far has been applied to the buffer. Exposed because a
   *  caller that wants the raw grid rather than an `Observation` still has to wait for the parser,
   *  and reaching into `snapshot()` without this is the torn read we are here to prevent. */
  drain(): Promise<void> {
    return this.#applied;
  }

  get bytesReceived(): number {
    return this.#bytes;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach();
    await this.#transport.close();
    this.#emulator.dispose();
  }

  // -------------------------------------------------------------------------------------------
  // Perception
  // -------------------------------------------------------------------------------------------

  #observe(): TerminalObservation {
    const grid = this.#emulator.snapshot();
    const quiet = Date.now() - this.#lastByteAt >= this.#quietMs;
    const built = observationOf(detect(grid), {
      seq: this.#seq++,
      driver: this.#capabilities.driver,
      surfaceKind: this.#capabilities.kind,
      stability: {
        settled: quiet,
        generation: this.#generation,
        // `pty-active` is the vocabulary SPEC section 2.2 reserved for exactly this: bytes are
        // still arriving. It is the only pending reason a character surface can honestly report -
        // there is no navigation event and no network to be waiting on.
        pendingReason: quiet ? null : "pty-active",
      },
      maskedIds: this.#maskedIds,
      originAlias: this.#originAlias,
    });
    this.#targets = built.targets;
    return built;
  }

  /** A detection taken for the driver's own use - focusing, selecting - without advancing `seq`.
   *  Perception the executor sees is a numbered event; looking at the screen to steer a Tab loop is
   *  not, and conflating the two would put phantom observations in the journal. */
  #peek(): ReturnType<typeof detect> {
    return detect(this.#emulator.snapshot());
  }

  // -------------------------------------------------------------------------------------------
  // Action
  // -------------------------------------------------------------------------------------------

  #lookup(id: NodeId): { target: TerminalTarget } | { fault: ActFault } {
    const target = this.#targets.get(id);
    if (target === undefined) return { fault: { kind: "node-gone", nodeId: id } };
    return { target };
  }

  /**
   * Put the hardware cursor inside a field. Limitation (a) at the top of this file.
   *
   * There is no addressable focus on a character surface: the only portable way to move the cursor
   * is Tab, so this is a bounded walk rather than a command. It is bounded by the number of fields
   * on screen plus a margin, because a Tab cycle that does not contain the target would otherwise
   * loop forever, and "the automation hung" has no failure class.
   */
  async #reach(target: TerminalTarget, id: NodeId): Promise<ActResult> {
    if (target.kind === "row") return this.#selectRow(target, id);
    if (target.kind !== "field") {
      // A heading or a status line has no cursor position. Refusing is the correct answer: the
      // alternative is dispatching Tabs forever looking for something that can never hold focus.
      return { ok: false, fault: { kind: "not-actionable", nodeId: id, why: "disabled" } };
    }
    const fields = this.#peek().nodes.filter((n) => n.role === "textbox").length;
    const budget = Math.min(12, Math.max(2, fields + 1));
    for (let attempt = 0; attempt <= budget; attempt++) {
      const grid = this.#emulator.snapshot();
      const inField =
        grid.cursor.y === target.bounds.row0 &&
        grid.cursor.x >= target.bounds.col0 &&
        grid.cursor.x <= target.bounds.col1 + 1;
      if (inField) return { ok: true, dispatched: true };
      if (attempt === budget) break;
      this.#send(bytesForKey("Tab"));
      await this.#settle();
    }
    return {
      ok: false,
      // The right ARM, the wrong NOUN. See limitation (a): the port's `why` vocabulary is
      // browser-shaped, and "the Tab cycle does not visit this field" is genuinely a different
      // condition from "it is off screen and cannot be scrolled to".
      fault: { kind: "not-actionable", nodeId: id, why: "off-screen-unscrollable" },
    };
  }

  /** Walk a list selection onto a row with the arrow keys. Bounded by the row count. */
  async #selectRow(target: TerminalTarget, id: NodeId): Promise<ActResult> {
    const wanted = target.rowIndex;
    if (wanted === null) {
      return { ok: false, fault: { kind: "not-actionable", nodeId: id, why: "disabled" } };
    }
    for (let attempt = 0; attempt <= 24; attempt++) {
      const grid = this.#emulator.snapshot();
      if (grid.cursor.y === target.bounds.row0) return { ok: true, dispatched: true };
      const key = grid.cursor.y < target.bounds.row0 ? "ArrowDown" : "ArrowUp";
      this.#send(bytesForKey(key));
      await this.#settle();
      // No progress means the selection has hit an end stop and the row is not reachable this way.
      if (this.#emulator.snapshot().cursor.y === grid.cursor.y) break;
    }
    return {
      ok: false,
      fault: { kind: "not-actionable", nodeId: id, why: "off-screen-unscrollable" },
    };
  }

  /**
   * Activate a control. Limitation (b): the port calls this `click`, and on this surface it means
   * "press the key this tenant's legend binds the control to".
   *
   * This is the single most important line in the driver for the multi-tenant claim. The artifact
   * says `activate` the control named "Exit". The node is `button:exit` at both credit unions. The
   * key is F3 at one and F12 at the other, and it is READ OFF THE LEGEND at replay time - so the
   * per-tenant difference needs no overlay, no descriptor and no artifact change at all.
   */
  #activate(target: TerminalTarget, id: NodeId): ActResult | Promise<ActResult> {
    if (target.kind === "control") {
      if (target.portKey === null) {
        return {
          ok: false,
          fault: {
            kind: "surface-error",
            message: `the control "${target.node.name}" is bound to a key this port has no name for`,
          },
        };
      }
      this.#send(bytesForKey(target.portKey));
      return { ok: true, dispatched: true };
    }
    if (target.kind === "row") return this.#selectRow(target, id);
    if (target.kind === "field") return this.#reach(target, id);
    return { ok: false, fault: { kind: "not-actionable", nodeId: id, why: "disabled" } };
  }

  /**
   * `mode: "replace"`, spelled out in keystrokes: erase what is there, then type.
   *
   * The erase is exactly as long as the value the grid currently shows, not the field's capacity.
   * Sending capacity-many backspaces would work on this fixture and would be wrong on a real one,
   * where a backspace past the start of a field is a key the application gets to interpret.
   */
  async #type(
    id: NodeId,
    target: TerminalTarget,
    text: string,
    sensitive: boolean,
  ): Promise<ActResult> {
    const current = this.#valueAt(target);
    for (let i = 0; i < current.length; i++) this.#send(bytesForKey("Backspace"));
    if (current.length > 0) await this.#settle();

    const typed = typableText(text);
    const capacity = target.capacity;
    if (capacity !== null && typed.length > capacity) {
      // The field's declared width came off the grid, so this refusal is the APPLICATION's limit,
      // not a policy we invented. Silently truncating is how a member number becomes a different
      // member number.
      return {
        ok: false,
        fault: {
          kind: "surface-error",
          message: `the field "${target.node.name}" holds ${capacity} characters and was given ${typed.length}`,
        },
      };
    }
    this.#send(typed);
    // Perception reports what the driver did: a value typed from a sensitive parameter is blanked
    // in every later observation. The taint model decided it was sensitive; this only records it.
    if (sensitive) this.#maskedIds.add(id);
    else this.#maskedIds.delete(id);
    return { ok: true, dispatched: true };
  }

  /** What the grid currently shows in a field's span. */
  #valueAt(target: TerminalTarget): string {
    const grid = this.#emulator.snapshot();
    let text = "";
    for (let x = target.bounds.col0; x <= target.bounds.col1; x++) {
      text += grid.cells[target.bounds.row0]?.[x]?.ch ?? " ";
    }
    return text.trim();
  }

  /**
   * Write to the transport AND start an activity window.
   *
   * The second half is the load-bearing one, and unit 21 is what found it: without it this surface
   * reports `settled: true` the instant it is asked after an action, because the only thing it
   * measures is silence since the last byte and an application that has not answered yet is
   * perfectly silent. A settle loop then finishes before the repaint arrives, every time, and every
   * slow screen in the world classifies as `no-observable-effect` - which makes the fixture's
   * documented "recoverable inside the budget, did-not-settle outside it" split unreachable.
   *
   * A browser driver has a navigation event to tell it that something is in flight. A green screen
   * has exactly one such signal and this is it: WE JUST SENT KEYSTROKES, so bytes are owed. Treating
   * a write as the start of the window is the terminal's honest analogue, and it is still only a
   * cheap trigger - the checkpoint remains the readiness gate, which is why the torn-repaint case
   * still fails at the checkpoint and not here.
   */
  #send(data: string | Uint8Array): void {
    this.#lastByteAt = Date.now();
    this.#transport.write(data);
  }

  /** Wait for the byte stream to go quiet, bounded. Used only inside `act`; the executor runs its
   *  own settle loop through `perceive`, which is where the budget that matters lives. */
  async #settle(): Promise<void> {
    const deadline = Date.now() + this.#actSettleMs;
    for (;;) {
      await this.#applied;
      if (Date.now() - this.#lastByteAt >= this.#quietMs) return;
      if (Date.now() > deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  #assertOpen(operation: string): void {
    if (this.#closed) throw new TerminalSurfaceError(`the surface is closed; ${operation} refused`);
  }
}

/**
 * Blank the named cell regions in a copy of the grid. Returns the copy and how many regions were
 * applied, so a caller can assert that masking happened rather than assume it.
 *
 * NAMED `blankGridRegions`, NOT `blankRegions`. `@crr/surface-browser` exports a `blankRegions` that
 * takes a `Raster` and a colour, mutates it IN PLACE and returns a bare `number`. This one takes a
 * `Grid`, mutates nothing and returns `{ masked, count }`. Two drivers, one name, two signatures,
 * and - because no engine package may import a driver - nothing in the workspace that imports both
 * to notice. That is the `ReplayOptions` collision of RUNTIME-STATUS section 3.1 in its exact shape;
 * the first consumer to hold both drivers at once (the `--surface <module>` factory `examples/` is
 * meant to ship) would have had to alias one, and would have had a one-in-two chance of aliasing it
 * to the wrong semantics. The name matches this package's other grid-flavoured spellings,
 * `gridRefOf` and `MemoryGridSink`.
 */
export function blankGridRegions(
  grid: Grid,
  regions: CaptureRequest["maskRegions"],
): { masked: Grid; count: number } {
  if (regions.length === 0) return { masked: grid, count: 0 };
  const cells: GridCell[][] = grid.cells.map((row) => row.map((cell) => ({ ...cell })));
  let count = 0;
  for (const region of regions) {
    let touched = false;
    for (let y = region.y; y < region.y + region.h; y++) {
      for (let x = region.x; x < region.x + region.w; x++) {
        const row = cells[y];
        if (row === undefined || row[x] === undefined) continue;
        row[x] = { ...(row[x] as GridCell), ch: " " };
        touched = true;
      }
    }
    if (touched) count += 1;
  }
  return { masked: { ...grid, cells }, count };
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
