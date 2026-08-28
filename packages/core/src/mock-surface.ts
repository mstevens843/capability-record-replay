// An in-memory `Surface`, driven by a list of frozen Observations.
//
// This is not a convenience. SPEC section 0.1 claims the classifier is a pure total function from a
// frozen `Observation` to a `Verdict`, and section 4.8 claims the entire error taxonomy is testable
// with no browser running. Those claims are only worth something if there is a real implementation
// of the port that a test can drive, and if it is strict enough that a scenario cannot accidentally
// prove something the machinery would never have allowed. So this driver ENFORCES the port rather
// than merely satisfying its signature:
//
//   · the lease is checked before anything else, so a stale controller learns nothing about the
//     session it no longer holds;
//   · a disabled, invisible or zero-size node is refused with `not-actionable` no matter what the
//     script says, because a real driver would never have dispatched it;
//   · a native dialog blocks every other action, because a blocked renderer is not a surface you
//     can click through;
//   · `type` truncates at the node's `capacity`, which is precisely how a legacy input with a
//     length limit silently produces MEMBER_NOT_FOUND for a member who exists.
//
// It also lives in `@crr/core` rather than in a test folder, and that is deliberate: the
// conformance suite, the interpreter tests and the discovery-loop tests are all in other packages,
// and a mock that cannot cross a package boundary is a mock that gets copied. It is pure - no
// clock, no randomness, no I/O - so it costs the purity contract test nothing.

import { DescriptorKindSchema } from "./descriptor-kinds.js";
import { digestOf } from "./digest.js";
import {
  type ActFault,
  type ActResult,
  type Action,
  ActionKindSchema,
  type Capture,
  type CaptureRequest,
  ContainerKindSchema,
  type Key,
  KeySchema,
  type NativeDialog,
  type Observation,
  ObservationSchema,
  type PerceiveFault,
  type PerceiveResult,
  type SurfaceCapabilities,
  type UINode,
} from "./observation.js";
import {
  type EvidenceRef,
  type LeaseToken,
  LeaseTokenSchema,
  type NodeId,
  RoleSchema,
} from "./primitives.js";
import { type Surface, skeletonDigestOf } from "./surface.js";

// ---------------------------------------------------------------------------------------------
// Script types
// ---------------------------------------------------------------------------------------------

/**
 * A pattern over one `Action`. Every field beyond `kind` is optional and an omitted field is a
 * wildcard, so `{ kind: "click" }` matches any click and `{ kind: "click", target }` matches one.
 */
export interface MockActionPattern {
  readonly kind: Action["kind"];
  readonly target?: NodeId;
  readonly key?: Key;
  readonly option?: string;
  readonly checked?: boolean;
  readonly text?: string;
  /** `navigate` only: the canonicalized path the route resolves to. */
  readonly path?: string;
}

/**
 * What perception sees on the way to the destination screen, one entry per `perceive()` call.
 *
 * This is where the two conditions that make a settle loop worth having get scripted:
 *
 *   · `stall` repeats forever, so the destination never arrives. That is a step that does not
 *     settle, and note that nothing here ends it - the settle BUDGET upstairs does, which is the
 *     only honest way to model it in a package with no clock.
 *   · a screen built by `tearObservation` is a torn read: a snapshot taken mid-repaint that claims
 *     to be settled and is not. The terminal spike measured one - three nodes instead of eight,
 *     with the screen id missing - after waiting twice the quiet window.
 */
export type MockPerceiveStep =
  | { readonly kind: "screen"; readonly screen: string; readonly times?: number }
  | { readonly kind: "fault"; readonly fault: PerceiveFault; readonly times?: number }
  | { readonly kind: "stall"; readonly screen: string };

export interface MockTransition {
  /** The screen(s) this fires on. Omitted means any screen, which is how an ambient condition -
   *  a session timeout, a system notice - is scripted. */
  readonly from?: string | readonly string[];
  readonly on: MockActionPattern;
  /** Refuse the action mechanically instead of performing it. Nothing else on the transition runs. */
  readonly fault?: ActFault;
  /** The screen the surface is on afterwards. Omitted means it stays where it is. */
  readonly to?: string;
  readonly via?: readonly MockPerceiveStep[];
  /** Fire at most once, then fall through to the next matching transition. How "the interstitial
   *  appears the first time and not the second" is expressed. */
  readonly once?: boolean;
  /**
   * Default `true`. Set `false` for the action that dispatched and changed nothing - SPEC section
   * 4.5's W6, the case that is otherwise indistinguishable from success and that only the delta
   * assertion catches.
   */
  readonly bumpsGeneration?: boolean;
}

export interface MockSurfaceConfig {
  /** The frozen corpus, by screen name. Every one is validated against `ObservationSchema` at
   *  construction: a mock that hands out an invalid Observation lets a downstream bug hide. */
  readonly screens: Readonly<Record<string, Observation>>;
  readonly start: string;
  readonly transitions?: readonly MockTransition[];
  /** Merged over `MOCK_SURFACE_CAPABILITIES`. A surface that cannot resolve `table-cell` or cannot
   *  press a key is exactly what the linker's load-time refusal needs to be tested against. */
  readonly capabilities?: Partial<SurfaceCapabilities>;
  /** The token `act` accepts. `null` means no controller holds the session and every action is
   *  refused, which is the correct fail-closed default but a noisy one, so it is opt-in. */
  readonly lease?: LeaseToken | null;
  /** What an action no transition matches does. Throwing is the default because a mock that
   *  silently no-ops is how a test passes for the wrong reason. */
  readonly unscripted?: "throw" | { readonly fault: ActFault };
}

export interface MockDispatch {
  readonly action: Action;
  /** The screen the surface was really on when the action arrived. */
  readonly screen: string;
  readonly result: ActResult;
}

export interface MockCaptureRecord {
  readonly request: CaptureRequest;
  readonly screen: string;
  readonly capture: Capture;
}

/** Raised when the script cannot answer what the caller just did. Never a surface condition: this
 *  is the fixture being wrong, and it should read like it. */
export class MockSurfaceScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MockSurfaceScriptError";
  }
}

// ---------------------------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------------------------

/** A well-known token so the common case is one argument rather than a ceremony, while the port's
 *  enforcement stays real: any other token is refused. */
export const MOCK_LEASE_TOKEN: LeaseToken = LeaseTokenSchema.parse("mock-lease");

/**
 * A maximal surface: it can do everything, so a test that fails does so for a reason in the code
 * under test. Narrow it per scenario with `config.capabilities` when the point IS the narrowing.
 */
export const MOCK_SURFACE_CAPABILITIES: SurfaceCapabilities = {
  kind: "web-legacy",
  driver: "mock-surface@0.1.0",
  // Copied, not aliased. `.options` hands back the enum's own array, and a caller that reached in
  // and edited one of these would be editing the schema every other module validates against.
  supportedActions: [...ActionKindSchema.options],
  supportedKeys: [...KeySchema.options],
  supportedRoles: [...RoleSchema.options],
  resolvableDescriptors: [...DescriptorKindSchema.options],
  containerKinds: [...ContainerKindSchema.options],
  boundsUnit: "px",
  confidenceFloor: 1,
  canCapture: ["image", "text-grid"],
};

// ---------------------------------------------------------------------------------------------
// Observation surgery, for building a corpus
// ---------------------------------------------------------------------------------------------

/**
 * Derive a torn read from a complete one: the snapshot a driver takes while the surface is halfway
 * through repainting.
 *
 * `keep` is the set of nodes that had already painted; everything else is dropped and every
 * dangling parent, child and `labelledBy` link with it, because a driver reading a half-painted
 * screen produces a CONSISTENT tree of the wrong size, not a corrupt one. That is what makes a torn
 * read dangerous: it looks like a perfectly good observation of a different screen.
 *
 * `stability` is deliberately left exactly as it was. If the source said settled, the tear says
 * settled - which is the entire point. Quiescence proposed and was wrong; only the checkpoint
 * catches it.
 */
export function tearObservation(
  observation: Observation,
  opts: { readonly keep: readonly NodeId[]; readonly route?: "keep" | "drop" },
): Observation {
  const keep = new Set<NodeId>(opts.keep);
  const survives = (id: NodeId): boolean => keep.has(id);
  const nodes: UINode[] = [];
  for (const node of observation.nodes) {
    if (!keep.has(node.id)) continue;
    nodes.push({
      ...node,
      parent: node.parent !== null && survives(node.parent) ? node.parent : null,
      children: node.children.filter(survives),
      labelledBy: node.labelledBy.filter(survives),
    });
  }
  return {
    ...observation,
    nodes,
    roots: observation.roots.filter(survives),
    skeletonDigest: skeletonDigestOf(nodes),
    route: opts.route === "drop" ? null : observation.route,
  };
}

// ---------------------------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------------------------

interface NodePatch {
  readonly value?: string;
  readonly checked?: boolean;
  readonly selected?: boolean;
}

type PendingStep =
  | { readonly kind: "screen"; readonly screen: string }
  | { readonly kind: "fault"; readonly fault: PerceiveFault }
  | { readonly kind: "stall"; readonly screen: string };

export class MockSurface implements Surface {
  readonly #screens: ReadonlyMap<string, Observation>;
  readonly #transitions: readonly MockTransition[];
  readonly #capabilities: SurfaceCapabilities;
  readonly #unscripted: "throw" | { readonly fault: ActFault };

  #current: string;
  #pending: PendingStep[] = [];
  #seq = 0;
  #generation = 0;
  #dialog: NativeDialog | null;
  #lease: LeaseToken | null;
  #focused: NodeId | null = null;
  #patches = new Map<NodeId, NodePatch>();
  #uses = new Map<number, number>();

  readonly #dispatched: MockDispatch[] = [];
  readonly #captures: MockCaptureRecord[] = [];
  readonly #deadlines: number[] = [];

  constructor(config: MockSurfaceConfig) {
    const screens = new Map<string, Observation>();
    for (const [name, observation] of Object.entries(config.screens)) {
      // Parse, do not trust. The corpus is the thing every downstream unit reasons from, and a
      // typo in it would otherwise surface as a classifier bug three units away.
      screens.set(name, deepFreeze(ObservationSchema.parse(observation) as Observation));
    }
    this.#screens = screens;
    this.#transitions = config.transitions ?? [];
    this.#capabilities = deepFreeze({ ...MOCK_SURFACE_CAPABILITIES, ...config.capabilities });
    this.#unscripted = config.unscripted ?? "throw";
    this.#lease = config.lease === undefined ? MOCK_LEASE_TOKEN : config.lease;
    this.#current = config.start;
    this.#dialog = this.#screen(config.start).nativeDialog;
  }

  // ------------------------------------------------------------------------------------------
  // The port
  // ------------------------------------------------------------------------------------------

  async perceive(opts: { readonly deadlineMs: number }): Promise<PerceiveResult> {
    if (!Number.isInteger(opts.deadlineMs) || opts.deadlineMs <= 0) {
      // Not a fault. A driver whose deadline is nonsense has been misused by its caller, and the
      // whole reason the deadline is in the signature is that an unbounded perceive hangs.
      throw new MockSurfaceScriptError(
        `perceive needs a positive integer deadlineMs, got ${String(opts.deadlineMs)}`,
      );
    }
    this.#deadlines.push(opts.deadlineMs);

    const head = this.#pending[0];
    if (head === undefined) return { ok: true, observation: this.#snapshot(this.#current) };
    if (head.kind === "fault") {
      this.#pending.shift();
      return { ok: false, fault: this.#withElapsed(head.fault, opts.deadlineMs) };
    }
    if (head.kind === "screen") this.#pending.shift();
    return { ok: true, observation: this.#snapshot(head.screen) };
  }

  async act(action: Action, lease: LeaseToken): Promise<ActResult> {
    // The lease is checked before the action is even looked at. A driver that validates the target
    // first has already told a controller it does not recognise whether that node exists.
    if (this.#lease === null || lease !== this.#lease) {
      return this.#record(action, { ok: false, fault: { kind: "lease-not-held" } });
    }

    const blocked = this.#dialogBlocks(action);
    if (blocked !== null) return this.#record(action, { ok: false, fault: blocked });

    const targetFault = this.#targetFault(action);
    if (targetFault !== null) return this.#record(action, { ok: false, fault: targetFault });

    const match = this.#match(action);
    if (match === null) {
      if (this.#unscripted === "throw") {
        throw new MockSurfaceScriptError(
          `no transition for ${JSON.stringify(action)} on screen "${this.#current}"; ` +
            `scripted screens: ${[...this.#screens.keys()].join(", ")}`,
        );
      }
      return this.#record(action, { ok: false, fault: this.#unscripted.fault });
    }

    const [index, transition] = match;
    this.#uses.set(index, (this.#uses.get(index) ?? 0) + 1);
    if (transition.fault !== undefined) {
      return this.#record(action, { ok: false, fault: transition.fault });
    }

    this.#echo(action);
    if (action.kind === "acceptDialog" || action.kind === "dismissDialog") this.#dialog = null;
    // Entering a screen opens whatever dialog that screen declares, so a transition that stays put
    // must not re-enter: dismissing a dialog and staying on the screen that raised it would
    // otherwise raise it again, and the remedy would look like it had done nothing.
    if (transition.to !== undefined && transition.to !== this.#current) this.#enter(transition.to);
    for (const step of transition.via ?? []) {
      const times = step.kind === "stall" ? 1 : (step.times ?? 1);
      for (let i = 0; i < times; i++) this.#pending.push(step);
    }
    if (transition.bumpsGeneration !== false) this.#generation += 1;

    return this.#record(action, { ok: true, dispatched: true });
  }

  async capture(req: CaptureRequest): Promise<Capture> {
    if (!this.#capabilities.canCapture.includes(req.format)) {
      throw new MockSurfaceScriptError(
        `this surface cannot capture "${req.format}" (it advertises ${this.#capabilities.canCapture.join(", ")})`,
      );
    }
    // Synthetic, but a real content address: masking a region changes the digest, so a test can
    // prove the mask reached the bytes rather than the metadata.
    const capture: Capture = {
      ref: `mock-capture-${this.#captures.length}` as EvidenceRef,
      digest: digestOf({ screen: this.#current, format: req.format, mask: req.maskRegions }),
      maskedRegions: req.maskRegions.length,
    };
    this.#captures.push({ request: req, screen: this.#current, capture });
    return capture;
  }

  capabilities(): SurfaceCapabilities {
    return this.#capabilities;
  }

  // ------------------------------------------------------------------------------------------
  // Inspection and out-of-band control
  // ------------------------------------------------------------------------------------------

  /** The screen the surface is really on, which is not always the one perception last returned. */
  get screen(): string {
    return this.#current;
  }
  get dispatched(): readonly MockDispatch[] {
    return this.#dispatched;
  }
  get captures(): readonly MockCaptureRecord[] {
    return this.#captures;
  }
  /** Every deadline `perceive` was asked for, so a test can assert perception was bounded. */
  get deadlines(): readonly number[] {
    return this.#deadlines;
  }

  /** Move the surface without an action having caused it: a human acting in the same live session
   *  during an intervention, which is what makes the resume precondition re-check worth having. */
  goto(screen: string): void {
    this.#pending = [];
    this.#enter(screen);
    this.#generation += 1;
  }

  grantLease(token: LeaseToken): void {
    this.#lease = token;
  }
  revokeLease(): void {
    this.#lease = null;
  }

  // ------------------------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------------------------

  #screen(name: string): Observation {
    const observation = this.#screens.get(name);
    if (observation === undefined) {
      throw new MockSurfaceScriptError(
        `unknown screen "${name}"; the script has ${[...this.#screens.keys()].join(", ")}`,
      );
    }
    return observation;
  }

  #snapshot(name: string): Observation {
    const base = this.#screen(name);
    const nodes = base.nodes.map((each) => this.#patch(each));
    return deepFreeze({
      ...base,
      seq: this.#seq++,
      nodes,
      // Recomputed on the way out, never copied from the fixture. The settle loop asks "is this
      // the same skeleton as last time"; if that answer came from a hand-maintained field the
      // question would be about the fixture's upkeep rather than about the screen.
      skeletonDigest: skeletonDigestOf(nodes),
      stability: { ...base.stability, generation: this.#generation },
      nativeDialog: this.#dialog,
      inputIntercepted: base.inputIntercepted || this.#dialog !== null,
    });
  }

  #patch(target: UINode): UINode {
    const patch = this.#patches.get(target.id);
    const focus = this.#focused === null ? null : target.id === this.#focused;
    if (patch === undefined && (focus === null || focus === target.state.focused)) return target;
    return {
      ...target,
      value: patch?.value ?? target.value,
      state: {
        ...target.state,
        focused: focus ?? target.state.focused,
        checked: patch?.checked ?? target.state.checked,
        selected: patch?.selected ?? target.state.selected,
      },
    };
  }

  #enter(screen: string): void {
    const observation = this.#screen(screen);
    this.#current = screen;
    this.#dialog = observation.nativeDialog;
    // A value survives a re-render of the screen it is on and dies with the node it was typed
    // into. Dropping every patch on any screen change would lose the member number the moment a
    // keep-alive dialog interrupted the form.
    const present = new Set<NodeId>(observation.nodes.map((node) => node.id));
    for (const id of [...this.#patches.keys()]) if (!present.has(id)) this.#patches.delete(id);
    if (this.#focused !== null && !present.has(this.#focused)) this.#focused = null;
  }

  #echo(action: Action): void {
    const nodes = this.#screen(this.#current).nodes;
    const find = (id: NodeId): UINode | undefined => nodes.find((node) => node.id === id);
    switch (action.kind) {
      case "type": {
        const node = find(action.target);
        // Truncation at `capacity` is not a detail. A legacy field with a length limit silently
        // keeps the first n characters and the search then reports no member on file for a member
        // who exists - which is exactly why `fill` has a postcondition at all.
        const text =
          node?.capacity == null ? action.text : action.text.slice(0, Math.max(0, node.capacity));
        this.#patches.set(action.target, { ...this.#patches.get(action.target), value: text });
        this.#focused = action.target;
        return;
      }
      case "setChecked":
        this.#patches.set(action.target, {
          ...this.#patches.get(action.target),
          checked: action.checked,
        });
        return;
      case "select": {
        this.#patches.set(action.target, {
          ...this.#patches.get(action.target),
          value: action.option,
        });
        for (const child of find(action.target)?.children ?? []) {
          const option = find(child);
          if (option?.ariaRole !== "option") continue;
          this.#patches.set(child, {
            ...this.#patches.get(child),
            selected: option.name === action.option,
          });
        }
        return;
      }
      case "focus":
        this.#focused = action.target;
        return;
      default:
        return;
    }
  }

  #dialogBlocks(action: Action): ActFault | null {
    const isDialogAction = action.kind === "acceptDialog" || action.kind === "dismissDialog";
    if (this.#dialog === null) {
      return isDialogAction ? { kind: "surface-error", message: "no native dialog is open" } : null;
    }
    if (isDialogAction) return null;
    // A native dialog blocks the renderer outright - the browser spike could not even read the
    // accessibility tree while one was open. Letting a click through here would let a test prove
    // something no browser would have done.
    const target = targetOf(action);
    if (target !== null) return { kind: "intercepted", nodeId: target };
    return {
      kind: "surface-error",
      message: `a native ${this.#dialog.type} dialog is open; the renderer is blocked`,
    };
  }

  #targetFault(action: Action): ActFault | null {
    const target = targetOf(action);
    if (target === null) return null;
    const node = this.#screen(this.#current).nodes.find((candidate) => candidate.id === target);
    if (node === undefined) return { kind: "node-gone", nodeId: target };
    if (node.state.disabled) return { kind: "not-actionable", nodeId: target, why: "disabled" };
    if (!node.state.visible) return { kind: "not-actionable", nodeId: target, why: "invisible" };
    if (node.bounds !== null && (node.bounds.w === 0 || node.bounds.h === 0)) {
      return { kind: "not-actionable", nodeId: target, why: "zero-size" };
    }
    return null;
  }

  #match(action: Action): readonly [number, MockTransition] | null {
    for (const [index, transition] of this.#transitions.entries()) {
      if (transition.once === true && (this.#uses.get(index) ?? 0) > 0) continue;
      if (!scopeMatches(transition.from, this.#current)) continue;
      if (!patternMatches(transition.on, action)) continue;
      return [index, transition];
    }
    return null;
  }

  #record(action: Action, result: ActResult): ActResult {
    this.#dispatched.push({ action, screen: this.#current, result });
    return result;
  }

  /** A driver that honours its own timer reports the deadline it actually waited out, so a
   *  scripted `elapsedMs` is a placeholder and this replaces it with the real one. */
  #withElapsed(fault: PerceiveFault, deadlineMs: number): PerceiveFault {
    return fault.kind === "perceive-timeout"
      ? { kind: "perceive-timeout", elapsedMs: deadlineMs }
      : fault;
  }
}

// ---------------------------------------------------------------------------------------------
// Free functions
// ---------------------------------------------------------------------------------------------

function targetOf(action: Action): NodeId | null {
  if (action.kind === "navigate" || action.kind === "acceptDialog") return null;
  if (action.kind === "dismissDialog") return null;
  return action.target;
}

function scopeMatches(from: MockTransition["from"], screen: string): boolean {
  if (from === undefined) return true;
  return typeof from === "string" ? from === screen : from.includes(screen);
}

function patternMatches(pattern: MockActionPattern, action: Action): boolean {
  if (pattern.kind !== action.kind) return false;
  const target = targetOf(action);
  if (pattern.target !== undefined && pattern.target !== target) return false;
  if (pattern.key !== undefined && !(action.kind === "pressKey" && action.key === pattern.key)) {
    return false;
  }
  if (
    pattern.option !== undefined &&
    !(action.kind === "select" && action.option === pattern.option)
  ) {
    return false;
  }
  if (
    pattern.checked !== undefined &&
    !(action.kind === "setChecked" && action.checked === pattern.checked)
  ) {
    return false;
  }
  if (pattern.text !== undefined) {
    const text =
      action.kind === "type" ? action.text : action.kind === "acceptDialog" ? action.text : null;
    if (text !== pattern.text) return false;
  }
  if (
    pattern.path !== undefined &&
    !(action.kind === "navigate" && action.route.path === pattern.path)
  ) {
    return false;
  }
  return true;
}

/**
 * Freeze what is handed out. An Observation is a VALUE - a snapshot of a moment that has already
 * passed - and code that mutates one has misunderstood the model badly enough that it should fail
 * loudly rather than subtly.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}
