// The browser `Surface`: Chromium, over raw CDP, Chromium only.
//
// The honest caveat belongs at the top rather than in a footnote. `newCDPSession` is documented
// "only supported on Chromium-based browsers", and Firefox and WebKit have no CDP at all, so this
// driver trades browser breadth for depth of perception. For a fleet of internal bank applications
// that is the right trade; it is still a trade.
//
// Five decisions, each forced by something that was measured rather than assumed (the browser
// spike, sections 1.4, 2.1-2.4, 4.1-4.4, 7.1):
//
//   1. `Page.getFrameTree` -> one `Accessibility.getFullAXTree({frameId})` per frame -> stitch it
//      ourselves. A single call returns SEVEN nodes on a frameset. `newCDPSession(frame)` THROWS for
//      a same-process child frame, so there is no per-frame session to take instead.
//   2. `role.type === "role"` is the target filter (see `roles.ts`). This is the decision that makes
//      "the row whose Member ID is X" resolve to one row on a page built of nested layout tables.
//   3. `backendDOMNodeId` is the within-session identity; the frame NAME chain is the durable
//      container reference. Node ids and frame ordinals are valid within ONE observation.
//   4. Coordinates are `scrollIntoViewIfNeeded` -> RE-READ `model.border` -> validate -> click.
//      Never the `content` quad, never a frame-local box.
//   5. This driver owns `page.on('dialog')` and puts a deadline on perception. With no handler
//      registered Playwright silently DISMISSES a confirm - the click succeeds, the confirmation the
//      flow depended on never happens, and the checkpoint fails three steps later with the cause
//      nowhere in sight. With a handler that never answers, an open dialog blocks the renderer and
//      `getFullAXTree` NEVER RETURNS: no CDP error, no timeout of its own. A call with no timeout is
//      a hang, and a hang has no failure class.

import {
  type ActFault,
  type ActResult,
  type Action,
  ActionKindSchema,
  type Bounds,
  type Capture,
  type CaptureRequest,
  type ContainerKind,
  type Digest,
  KeySchema,
  type LeaseToken,
  type NativeDialog,
  type NodeId,
  type Observation,
  type PerceiveResult,
  type RouteLocation,
  type RoutePattern,
  type Surface,
  type SurfaceCapabilities,
  type SurfaceKind,
  type UINode,
  sha256Bytes,
  skeletonDigestOf,
} from "@crr/core";
import type { CDPSession, Dialog, Page } from "playwright";
import { type CaptureSink, MemoryCaptureSink } from "./capture-sink.js";
import type { AxNode, BoxModel } from "./cdp.js";
import { BrowserSurfaceError } from "./errors.js";
import { type FrameInfo, flattenFrameTree, unperceivableFrameDetail } from "./frames.js";
import { type Viewport, boundsFromBoxModel, centreOf, unclickableReason } from "./geometry.js";
import { type BrowserNode, normalizeObservationNodes } from "./normalize.js";
import { blankRegions, decodePng, encodePng } from "./png.js";
import { BROWSER_SUPPORTED_ROLES, IFRAME_ROLE, STATIC_TEXT_ROLE } from "./roles.js";
import {
  type RouteConfig,
  canonicalizeLocation,
  navigationTargetOf,
  resolveOrigins,
} from "./routes.js";

export const BROWSER_DRIVER = "surface-browser@0.1.0";

/** How much of the tree gets measured. Geometry is one CDP round trip per node - about a fifth of a
 *  millisecond each - so it is worth choosing rather than always paying for the whole tree. */
export type GeometryPolicy = "none" | "actionable" | "all";

export interface BrowserSurfaceOptions {
  readonly page: Page;
  /** Origin alias -> base url at this tenant. The artifact names the alias and never the host,
   *  which is what lets one artifact run at every credit union. */
  readonly origins: Readonly<Record<string, string>>;
  /** The routes this capability declares. A location outside them canonicalizes to `null`. */
  readonly routes?: readonly RoutePattern[];
  /** Whose url becomes `Observation.route`. In a frameset the top document's url never changes, so
   *  reporting it would mean the route never moved; the CONTENT frame is where the flow happens. */
  readonly primaryFrame?: string;
  readonly lease?: LeaseToken | null;
  readonly surfaceKind?: SurfaceKind;
  readonly geometry?: GeometryPolicy;
  /** Ceiling on one `act`. A click that opens a native dialog never resolves until the dialog is
   *  answered, so without this the port's second method hangs exactly the way its first one would. */
  readonly actTimeoutMs?: number;
  readonly captureSink?: CaptureSink;
  readonly driver?: string;
}

/** What a capture is masked with and where its bytes went. Exposed so a test can fetch them back. */
export interface BrowserSurfaceHandles {
  readonly sink: CaptureSink;
}

interface Collected {
  readonly nodes: readonly BrowserNode[];
  readonly roots: readonly NodeId[];
  readonly route: RouteLocation | null;
}

type CollectOutcome =
  | { readonly ok: true; readonly collected: Collected }
  | { readonly ok: false; readonly detail: string };

/** Open a driver on an existing page. Async because the CDP session and the two domains it needs
 *  are established once, at attach time, rather than on every perception. */
export async function attachBrowserSurface(
  options: BrowserSurfaceOptions,
): Promise<BrowserSurface> {
  let cdp: CDPSession;
  try {
    cdp = await options.page.context().newCDPSession(options.page);
  } catch (error) {
    // The Chromium-only constraint, said once and clearly. `newCDPSession` is documented "only
    // supported on Chromium-based browsers", and Firefox and WebKit have no CDP at all - so this is
    // the one place a wrong browser choice can be reported as what it is rather than as a stack
    // trace six frames deep in a perception path.
    throw new BrowserSurfaceError(
      [
        "this driver requires a Chromium-based browser: it perceives through the raw CDP",
        "accessibility domain, which Firefox and WebKit do not implement.",
        `The session could not be opened (${messageOf(error)}).`,
      ].join(" "),
    );
  }
  await cdp.send("DOM.enable");
  // Not required for `getFullAXTree` - it enables the domain implicitly - but it IS required for
  // `getRootAXNode`, and being explicit about which domains a driver depends on costs one call.
  await cdp.send("Accessibility.enable");
  return new BrowserSurface(options, cdp);
}

export class BrowserSurface implements Surface {
  readonly #page: Page;
  readonly #cdp: CDPSession;
  readonly #routeConfig: RouteConfig;
  readonly #origins: ReturnType<typeof resolveOrigins>;
  readonly #primaryFrame: string | null;
  readonly #geometry: GeometryPolicy;
  readonly #actTimeoutMs: number;
  readonly #sink: CaptureSink;
  readonly #capabilities: SurfaceCapabilities;

  #lease: LeaseToken | null;
  #closed = false;
  #seq = 0;
  #generation = 0;
  #inflight = 0;
  #inflightDocuments = 0;
  #dialog: { readonly info: NativeDialog; readonly handle: Dialog } | null = null;
  #nodes = new Map<NodeId, BrowserNode>();
  readonly #sensitiveBackendIds = new Set<number>();
  readonly #dialogWaiters = new Set<(value: "dialog") => void>();
  readonly #detach: (() => void)[] = [];

  constructor(options: BrowserSurfaceOptions, cdp: CDPSession) {
    this.#page = options.page;
    this.#cdp = cdp;
    this.#routeConfig = { origins: options.origins, routes: options.routes ?? [] };
    this.#origins = resolveOrigins(options.origins);
    this.#primaryFrame = options.primaryFrame ?? null;
    this.#geometry = options.geometry ?? "actionable";
    this.#actTimeoutMs = options.actTimeoutMs ?? 15_000;
    this.#sink = options.captureSink ?? new MemoryCaptureSink();
    this.#lease = options.lease ?? null;
    this.#capabilities = Object.freeze({
      kind: options.surfaceKind ?? "web-legacy",
      driver: options.driver ?? BROWSER_DRIVER,
      supportedActions: [...ActionKindSchema.options],
      supportedKeys: [...KeySchema.options],
      // Computed from the role table, so this list cannot drift away from what the driver emits.
      supportedRoles: BROWSER_SUPPORTED_ROLES,
      resolvableDescriptors: [
        "role-name",
        "label-anchored",
        "table-cell",
        "ordinal-in-container",
        "geometric",
      ],
      // No `heading-section`: an accessibility tree makes a heading a SIBLING of the content it
      // introduces, not an ancestor of it, so this driver has no honest way to say a node is "under"
      // a heading. Advertising it and guessing would turn a load-time refusal into a wrong scope.
      containerKinds: ["frame", "landmark", "table"] satisfies ContainerKind[],
      boundsUnit: "px",
      // Chromium computes the role and the name; this driver infers neither, so there is nothing for
      // it to be less than certain about. The floor exists for surfaces that synthesize a role out
      // of a reverse-video run on a character grid.
      confidenceFloor: 1,
      canCapture: ["image"],
    } satisfies SurfaceCapabilities);

    this.#listen();
  }

  // -------------------------------------------------------------------------------------------
  // The port
  // -------------------------------------------------------------------------------------------

  /**
   * Driver rule D6: the deadline is honoured with OUR timer, not the transport's.
   *
   * The race is not defensive programming. An open native `confirm()` blocks the renderer, so
   * `Accessibility.getFullAXTree` never returns at all - the spike's first attempt at that
   * experiment deadlocked and was killed at two minutes. On expiry the in-flight CDP call is
   * abandoned (its rejection is already handled) and the caller gets a fault it can classify.
   */
  async perceive(opts: { readonly deadlineMs: number }): Promise<PerceiveResult> {
    this.#assertOpen("perceive");
    if (!Number.isInteger(opts.deadlineMs) || opts.deadlineMs <= 0) {
      throw new BrowserSurfaceError(
        `perceive needs a positive integer deadlineMs, got ${String(opts.deadlineMs)}`,
      );
    }
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), opts.deadlineMs);
    });
    const work = this.#collect().then(
      (outcome) => outcome,
      (error): CollectOutcome => ({ ok: false, detail: `SURFACE ${messageOf(error)}` }),
    );
    try {
      const outcome = await Promise.race([work, expiry]);
      if (outcome === "timeout") {
        return { ok: false, fault: { kind: "perceive-timeout", elapsedMs: Date.now() - started } };
      }
      if (!outcome.ok) {
        return outcome.detail.startsWith("SURFACE ")
          ? { ok: false, fault: { kind: "surface-error", message: outcome.detail.slice(8) } }
          : { ok: false, fault: { kind: "unperceivable-container", detail: outcome.detail } };
      }
      return { ok: true, observation: this.#assemble(outcome.collected) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One action, with the control lease enforced AT the port.
   *
   * The interesting failure is not a human and an automation racing for a click. It is an automation
   * that still believes it holds a session a human took forty seconds ago, and a gate upstairs
   * cannot see that at all - so the token is checked here, before the action is even looked at.
   */
  async act(action: Action, lease: LeaseToken): Promise<ActResult> {
    this.#assertOpen("act");
    if (this.#lease === null || lease !== this.#lease) {
      return { ok: false, fault: { kind: "lease-not-held" } };
    }

    const isDialogAction = action.kind === "acceptDialog" || action.kind === "dismissDialog";
    if (isDialogAction) return this.#answerDialog(action);
    const blocked = this.#dialogBlocks(action);
    if (blocked !== null) return { ok: false, fault: blocked };
    if (action.kind === "navigate") return this.#navigate(action.route);

    const target = targetOf(action);
    let point: { x: number; y: number } | null = null;
    let found: BrowserNode | undefined;
    if (target !== null) {
      found = this.#nodes.get(target);
      if (found === undefined) return { ok: false, fault: { kind: "node-gone", nodeId: target } };
      const refusal = await this.#actionability(found, target);
      if ("fault" in refusal) return { ok: false, fault: refusal.fault };
      point = refusal.point;
    }

    switch (action.kind) {
      case "click":
        return this.#dispatch(() => this.#page.mouse.click(point?.x ?? 0, point?.y ?? 0));
      case "setChecked": {
        // Already in the wanted state: do nothing and say so. A checkbox is a TOGGLE - clicking one
        // that is already checked unchecks it - so "make sure this is checked" has to be able to be
        // a no-op or the second replay of an idempotent step undoes the first.
        if (found?.node.state.checked === action.checked) return { ok: true, dispatched: true };
        return this.#dispatch(() => this.#page.mouse.click(point?.x ?? 0, point?.y ?? 0));
      }
      case "focus":
        return this.#dispatch(() => this.#focus(found as BrowserNode));
      case "pressKey":
        return this.#dispatch(async () => {
          if (found !== undefined) await this.#focus(found);
          await this.#page.keyboard.press(action.key);
        });
      case "type":
        return this.#dispatch(() =>
          this.#type(found as BrowserNode, action.text, action.sensitive),
        );
      case "select":
        return this.#dispatch(() => this.#select(found as BrowserNode, action.option));
      default:
        return {
          ok: false,
          fault: { kind: "surface-error", message: `unsupported action ${String(action)}` },
        };
    }
  }

  /**
   * Evidence only, and never read by the decision path.
   *
   * Masking is applied to the raster before anything leaves this method: the unmasked buffer is a
   * local that is never returned, never digested, never written and never logged. `png.ts` explains
   * at length why it is not `page.screenshot({ mask })`. If decoding fails the whole capture fails -
   * returning the unmasked bytes because the mask could not be applied is the one outcome that must
   * not be reachable.
   */
  async capture(req: CaptureRequest): Promise<Capture> {
    this.#assertOpen("capture");
    if (!this.#capabilities.canCapture.includes(req.format)) {
      throw new BrowserSurfaceError(
        `this surface cannot capture "${req.format}" (it advertises ${this.#capabilities.canCapture.join(", ")})`,
      );
    }
    if (this.#dialog !== null) {
      throw new BrowserSurfaceError(
        `a native ${this.#dialog.info.type} dialog is open; the renderer is blocked and a screenshot would hang`,
      );
    }
    const raw = await withTimeout(
      this.#page.screenshot({ type: "png", animations: "disabled", caret: "hide" }),
      this.#actTimeoutMs,
      "screenshot",
    );
    let bytes: Uint8Array = raw;
    let maskedRegions = 0;
    if (req.maskRegions.length > 0) {
      const raster = decodePng(raw);
      maskedRegions = blankRegions(raster, req.maskRegions);
      bytes = encodePng(raster);
    }
    const digest = `sha256:${sha256Bytes(bytes)}` as Digest;
    const ref = await this.#sink.put(bytes, "image/png");
    return { ref, digest, maskedRegions };
  }

  capabilities(): SurfaceCapabilities {
    return this.#capabilities;
  }

  // -------------------------------------------------------------------------------------------
  // Driver-level control, below the port
  // -------------------------------------------------------------------------------------------

  /**
   * The dialog the driver is holding open, if any.
   *
   * Off the port on purpose: a native dialog reaches the classifier as `Observation.nativeDialog`,
   * and there is no observation while one is open because the renderer is blocked. SPEC section 4.2
   * row 21 wants `undeclared-dialog` rather than a bare `surface-error` "when a dialog is known",
   * and this is how the executor knows.
   */
  get pendingNativeDialog(): NativeDialog | null {
    return this.#dialog?.info ?? null;
  }

  /** Where captures went, so a caller can fetch the bytes back by ref. */
  get handles(): BrowserSurfaceHandles {
    return { sink: this.#sink };
  }

  grantLease(token: LeaseToken): void {
    this.#lease = token;
  }

  revokeLease(): void {
    this.#lease = null;
  }

  /**
   * Detach. Deliberately does NOT answer a pending dialog: accepting or dismissing one is a decision
   * about whether a transaction posts, and a teardown path is the last place that decision should be
   * taken silently. The caller answers it, or closes the browser.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const off of this.#detach) off();
    this.#detach.length = 0;
    try {
      await this.#cdp.detach();
    } catch {
      // The session is already gone if the page closed first, which is not an error here.
    }
  }

  // -------------------------------------------------------------------------------------------
  // Perception
  // -------------------------------------------------------------------------------------------

  async #collect(): Promise<CollectOutcome> {
    const { frameTree } = await this.#cdp.send("Page.getFrameTree");
    const frames = flattenFrameTree(frameTree);

    // Driver rule D7. A frame the page knows about and this session cannot see is an out-of-process
    // iframe: it needs its own CDP session and reports FRAME-LOCAL geometry, so a coordinate click
    // computed from it misses - measured, not inferred. Refusing to perceive is louder and safer
    // than returning a screen that is missing a third of itself.
    const detail = unperceivableFrameDetail(
      frames,
      this.#page.frames().map((frame) => frame.name()),
    );
    if (detail !== null) return { ok: false, detail };

    const trees: (readonly AxNode[])[] = [];
    for (const frame of frames) {
      try {
        const { nodes } = await this.#cdp.send("Accessibility.getFullAXTree", {
          frameId: frame.id,
        });
        const typed: readonly AxNode[] = nodes;
        trees.push(typed);
      } catch (error) {
        return {
          ok: false,
          detail:
            `the accessibility tree of frame "${frame.path.join("/")}" could not be read ` +
            `(${messageOf(error)}); perceiving the rest would report a screen that is missing it`,
        };
      }
    }

    const childFrameOfIframeBackendId = await this.#stitchEdges(frames, trees);
    const normalized = normalizeObservationNodes({
      frames,
      trees,
      childFrameOfIframeBackendId,
      sensitiveBackendIds: this.#sensitiveBackendIds,
    });
    const measured = await this.#measure(normalized.nodes);
    return {
      ok: true,
      collected: { nodes: measured, roots: normalized.roots, route: this.#routeOf(frames) },
    };
  }

  /**
   * The stitch edge: an `Iframe` accessibility leaf in one document is the parent of another
   * document's root, and `DOM.describeNode({backendNodeId}).node.frameId` is what says which.
   *
   * There is no other link. Only frame ROOT nodes carry `frameId`, and the AX parent chain does not
   * cross a document boundary either, so "walk up until you find a frameId" answers nothing.
   */
  async #stitchEdges(
    frames: readonly FrameInfo[],
    trees: readonly (readonly AxNode[])[],
  ): Promise<ReadonlyMap<number, number>> {
    const frameIndexById = new Map(frames.map((frame, index) => [frame.id, index]));
    const edges = new Map<number, number>();
    for (const tree of trees) {
      for (const node of tree) {
        if (node.role?.value !== IFRAME_ROLE || node.backendDOMNodeId === undefined) continue;
        try {
          const described = await this.#cdp.send("DOM.describeNode", {
            backendNodeId: node.backendDOMNodeId,
          });
          const childIndex =
            described.node.frameId === undefined
              ? undefined
              : frameIndexById.get(described.node.frameId);
          if (childIndex !== undefined) edges.set(node.backendDOMNodeId, childIndex);
        } catch {
          // A frame that went away between the tree read and this call. The child document is then
          // simply not stitched, its root stays a root, and `Observation.roots` says so.
        }
      }
    }
    return edges;
  }

  /**
   * Geometry, one CDP round trip per node.
   *
   * `"actionable"` measures every real target plus every run of page text, and the second half is
   * not padding: a legacy form has no `<label for>` at all, so a `label-anchored` descriptor anchors
   * on a `StaticText` node and needs ITS box to know what sits to the right of it.
   */
  async #measure(nodes: readonly BrowserNode[]): Promise<readonly BrowserNode[]> {
    if (this.#geometry === "none") return nodes;
    const wanted = new Set<number>();
    for (const node of nodes) {
      if (this.#geometry === "all") wanted.add(node.backendId);
      else if (node.node.ariaRole !== null) wanted.add(node.backendId);
      else if (node.node.rawRole === STATIC_TEXT_ROLE && node.node.name.trim().length > 0) {
        wanted.add(node.backendId);
      }
    }
    const boxes = new Map<number, Bounds>();
    const ids = [...wanted];
    for (let start = 0; start < ids.length; start += 32) {
      await Promise.all(
        ids.slice(start, start + 32).map(async (backendId) => {
          const bounds = await this.#boxOf(backendId);
          if (bounds !== null) boxes.set(backendId, bounds);
        }),
      );
    }
    return nodes.map((node) => {
      const bounds = boxes.get(node.backendId);
      return bounds === undefined ? node : { ...node, node: { ...node.node, bounds } };
    });
  }

  async #boxOf(backendId: number): Promise<Bounds | null> {
    try {
      const { model } = await this.#cdp.send("DOM.getBoxModel", { backendNodeId: backendId });
      const typed: BoxModel = model;
      return boundsFromBoxModel(typed);
    } catch {
      // `display:none` and a detached node both throw "Could not compute box model". Absence of a
      // box is the answer; note that the converse does NOT hold - `visibility:hidden` returns a
      // perfectly ordinary box, which is why visibility is read off the tree and never off geometry.
      return null;
    }
  }

  /** The location the flow is at, canonicalized. In a frameset the top document's url never changes,
   *  so `primaryFrame` names the frame whose url actually moves. */
  #routeOf(frames: readonly FrameInfo[]): RouteLocation | null {
    const frame =
      (this.#primaryFrame === null
        ? undefined
        : frames.find((candidate) => candidate.name === this.#primaryFrame)) ?? frames[0];
    if (frame === undefined) return null;
    return canonicalizeLocation(frame.url, frame.name, this.#routeConfig, this.#origins);
  }

  #assemble(collected: Collected): Observation {
    this.#nodes = new Map(collected.nodes.map((node) => [node.node.id, node]));
    const nodes: readonly UINode[] = collected.nodes.map((node) => node.node);
    const dialog = this.#dialog?.info ?? null;
    return {
      seq: this.#seq++,
      surface: { kind: this.#capabilities.kind, driver: this.#capabilities.driver },
      route: collected.route,
      nodes,
      roots: collected.roots,
      skeletonDigest: skeletonDigestOf(nodes),
      stability: {
        settled: this.#inflight === 0,
        generation: this.#generation,
        pendingReason:
          this.#inflightDocuments > 0 ? "navigating" : this.#inflight > 0 ? "network" : null,
      },
      nativeDialog: dialog,
      // `aria-modal` is NOT surfaced as an accessibility property - a `<div role=dialog
      // aria-modal=true>` comes back with an EMPTY property set - so "is this modal" has to be
      // inferred from the role. Inferring it generously is the fail-closed direction: an undeclared
      // interception is a hard failure, and calling a non-modal dialog an interception costs a run
      // that a declared recovery would have covered, while missing a real one costs a wrong click.
      inputIntercepted: dialog !== null || nodes.some(isVisibleDialog),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Acting
  // -------------------------------------------------------------------------------------------

  #dialogBlocks(action: Action): ActFault | null {
    if (this.#dialog === null) return null;
    const target = targetOf(action);
    if (target !== null) return { kind: "intercepted", nodeId: target };
    return {
      kind: "surface-error",
      message: `a native ${this.#dialog.info.type} dialog is open; the renderer is blocked`,
    };
  }

  async #answerDialog(action: Action): Promise<ActResult> {
    const pending = this.#dialog;
    if (pending === null) {
      return { ok: false, fault: { kind: "surface-error", message: "no native dialog is open" } };
    }
    this.#dialog = null;
    this.#generation += 1;
    try {
      if (action.kind === "acceptDialog") await pending.handle.accept(action.text ?? undefined);
      else await pending.handle.dismiss();
      return { ok: true, dispatched: true };
    } catch (error) {
      return { ok: false, fault: { kind: "surface-error", message: messageOf(error) } };
    }
  }

  async #navigate(route: RouteLocation): Promise<ActResult> {
    const target = navigationTargetOf(route, this.#routeConfig, this.#origins);
    if (target === "unknown-origin") {
      // The concrete path is deliberately NOT echoed into a fault: a fault is journalled, a journal
      // is evidence, and `/member/10041` in a journal is persisted member data.
      return {
        ok: false,
        fault: {
          kind: "navigation-blocked",
          route: `${route.originAlias} (origin alias is not configured for this tenant)`,
        },
      };
    }
    if (target === "uncanonicalized-path") {
      return {
        ok: false,
        fault: {
          kind: "navigation-blocked",
          route: `${route.path} (still a pattern; its arguments were never substituted)`,
        },
      };
    }
    const frame =
      target.frame === null
        ? this.#page.mainFrame()
        : this.#page.frames().find((candidate) => candidate.name() === target.frame);
    if (frame === undefined) {
      return {
        ok: false,
        fault: { kind: "navigation-blocked", route: `frame "${target.frame}" is not on this page` },
      };
    }
    return this.#dispatch(async () => {
      await frame.goto(target.url, { timeout: this.#actTimeoutMs });
    });
  }

  /**
   * Driver rule D4, plus the interception guard.
   *
   * Scroll, RE-READ the box, validate it, then check that a real mouse arriving at that point would
   * reach this node and not something painted over it. The last step is SPEC section 4.5's W5 - the
   * one wrong-target case the machinery can see directly - and it is what stops a click that lands
   * on a full-page dim layer from being reported as a successful click on the button underneath.
   */
  async #actionability(
    node: BrowserNode,
    target: NodeId,
  ): Promise<{ point: { x: number; y: number } } | { fault: ActFault }> {
    if (node.node.state.disabled) {
      return { fault: { kind: "not-actionable", nodeId: target, why: "disabled" } };
    }
    if (!node.node.state.visible) {
      return { fault: { kind: "not-actionable", nodeId: target, why: "invisible" } };
    }
    try {
      await this.#cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node.backendId });
    } catch {
      // Not fatal on its own: a node already in view can still refuse to scroll. The box read below
      // is the real test, and it is the one that has to happen AFTER this.
    }
    const bounds = await this.#boxOf(node.backendId);
    if (bounds === null) return { fault: { kind: "node-gone", nodeId: target } };
    const reason = unclickableReason(bounds, await this.#viewport());
    if (reason !== null) return { fault: { kind: "not-actionable", nodeId: target, why: reason } };
    const point = centreOf(bounds);
    if (!(await this.#reaches(node.backendId, point))) {
      return { fault: { kind: "intercepted", nodeId: target } };
    }
    return { point };
  }

  /**
   * Would a click at this point land on this node?
   *
   * A POSITIVE test for interception, not a proof of reachability: when the hit test itself cannot
   * be performed - a cross-document overlay, a released context - the action proceeds. Turning the
   * guard's own failure into a refusal would make the driver reject actions for reasons that have
   * nothing to do with the page.
   */
  async #reaches(backendId: number, point: { x: number; y: number }): Promise<boolean> {
    try {
      const hit = await this.#cdp.send("DOM.getNodeForLocation", {
        x: point.x,
        y: point.y,
        includeUserAgentShadowDOM: false,
      });
      if (hit.backendNodeId === backendId) return true;
      return await this.#related(backendId, hit.backendNodeId);
    } catch {
      return true;
    }
  }

  /** Exact DOM containment, in both directions. The accessibility tree folds `<font>` and `<b>` away,
   *  so an ancestor test done over AX parentage would report a false interception on every legacy
   *  page; this asks the document itself. */
  async #related(backendId: number, otherBackendId: number): Promise<boolean> {
    let mine: string | undefined;
    let theirs: string | undefined;
    try {
      mine = (await this.#cdp.send("DOM.resolveNode", { backendNodeId: backendId })).object
        .objectId;
      theirs = (await this.#cdp.send("DOM.resolveNode", { backendNodeId: otherBackendId })).object
        .objectId;
      if (mine === undefined || theirs === undefined) return true;
      const { result } = await this.#cdp.send("Runtime.callFunctionOn", {
        objectId: mine,
        functionDeclaration:
          "function (other) { return this === other || this.contains(other) || other.contains(this); }",
        arguments: [{ objectId: theirs }],
        returnByValue: true,
      });
      return result.value !== false;
    } catch {
      return true;
    } finally {
      for (const objectId of [mine, theirs]) {
        if (objectId === undefined) continue;
        await this.#cdp.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
      }
    }
  }

  async #focus(node: BrowserNode): Promise<void> {
    await this.#cdp.send("DOM.focus", { backendNodeId: node.backendId });
  }

  /**
   * Real key events, never an assignment to `.value`.
   *
   * Setting the property directly works and is a lie: no focus, no `keydown`, no `change` ordering.
   * A 2006-era page with an `onchange` postback does not notice it at all, and "the field looked
   * filled and the application never saw it" is the most expensive kind of false success.
   */
  async #type(node: BrowserNode, text: string, sensitive: boolean): Promise<void> {
    await this.#focus(node);
    // `mode` is always `replace` at this port, so the existing content is selected first. On an
    // empty field this selects nothing and the Delete is harmless.
    await this.#page.keyboard.press("ControlOrMeta+a");
    if (text.length === 0) await this.#page.keyboard.press("Delete");
    else await this.#page.keyboard.type(text);
    // The taint model, closed at the driver: from here on this node's value is blanked in every
    // observation and `masked: true` is what makes `deriveMaskRegions` blank its pixels too.
    if (sensitive) this.#sensitiveBackendIds.add(node.backendId);
  }

  /**
   * The one place this driver synthesizes an event instead of dispatching a real one, and it is a
   * deliberate, bounded exception.
   *
   * A closed `<select>` can be driven from the keyboard, and Chromium fires `change` on EVERY arrow
   * press - so walking to the fifth option on a page whose select has an `onchange` postback
   * navigates four times on the way there. Chromium's own dropdown is not part of the page and
   * cannot be clicked. So the selection is set once and `input`/`change` are dispatched once, which
   * is what every browser automation library does and is the only shape that produces exactly one
   * postback. The function body is a constant; the option text is passed as an ARGUMENT, never
   * concatenated into it.
   */
  async #select(node: BrowserNode, option: string): Promise<void> {
    const resolved = await this.#cdp.send("DOM.resolveNode", { backendNodeId: node.backendId });
    const objectId = resolved.object.objectId;
    if (objectId === undefined) throw new Error("the select element could not be resolved");
    try {
      const { result } = await this.#cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: SELECT_OPTION_FN,
        arguments: [{ value: option }],
        returnByValue: true,
      });
      if (result.value !== "ok") {
        throw new Error(`select: ${String(result.value)} for option "${option}"`);
      }
    } finally {
      await this.#cdp.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
    }
  }

  /**
   * Bound one dispatch, and treat "a native dialog opened" as a completed dispatch.
   *
   * That second half is the subtle one. `page.mouse.click` does not resolve while a `confirm()` is
   * open - the renderer is blocked inside the click handler - but the click HAS happened and the
   * dialog is its consequence. Waiting for the promise would hang; reporting a fault would say the
   * click never landed, and the executor would retry it. Both are wrong; the dialog is the answer.
   */
  async #dispatch(run: () => Promise<unknown>): Promise<ActResult> {
    let notify!: (value: "dialog") => void;
    const dialogOpened = new Promise<"dialog">((resolve) => {
      notify = resolve;
    });
    this.#dialogWaiters.add(notify);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.#actTimeoutMs);
    });
    const work = run().then(
      () => "done" as const,
      (error) => ({ error: messageOf(error) }),
    );
    try {
      const outcome = await Promise.race([work, dialogOpened, expiry]);
      if (outcome === "done" || outcome === "dialog") {
        this.#generation += 1;
        return { ok: true, dispatched: true };
      }
      if (outcome === "timeout") {
        return {
          ok: false,
          fault: {
            kind: "surface-error",
            message: `the action did not complete within ${this.#actTimeoutMs}ms`,
          },
        };
      }
      return { ok: false, fault: { kind: "surface-error", message: outcome.error } };
    } finally {
      clearTimeout(timer);
      this.#dialogWaiters.delete(notify);
    }
  }

  async #viewport(): Promise<Viewport> {
    const size = this.#page.viewportSize();
    if (size !== null) return size;
    const metrics = await this.#cdp.send("Page.getLayoutMetrics");
    return {
      width: metrics.cssLayoutViewport.clientWidth,
      height: metrics.cssLayoutViewport.clientHeight,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Page events
  // -------------------------------------------------------------------------------------------

  #listen(): void {
    const on = <T>(event: string, handler: (payload: T) => void): void => {
      // Playwright's `Page.on` is a big overload set keyed on the event name; this driver registers
      // by name from a table, so the registration is done through the EventEmitter shape they all
      // share rather than by spelling out six near-identical calls.
      const emitter = this.#page as unknown as {
        on(name: string, handler: (payload: T) => void): void;
        off(name: string, handler: (payload: T) => void): void;
      };
      emitter.on(event, handler);
      this.#detach.push(() => emitter.off(event, handler));
    };

    // Driver rule D5. With NO handler registered Playwright silently dismisses the dialog: the click
    // resolves, the confirmation never happens, and the checkpoint fails somewhere else entirely.
    // This handler records and does not answer - never auto-accept, never auto-dismiss.
    on<Dialog>("dialog", (dialog) => {
      const defaultValue = dialog.defaultValue();
      this.#dialog = {
        handle: dialog,
        info: {
          type: dialog.type() as NativeDialog["type"],
          message: dialog.message(),
          defaultValue: defaultValue.length > 0 ? defaultValue : null,
        },
      };
      this.#generation += 1;
      for (const waiter of this.#dialogWaiters) waiter("dialog");
    });

    // Quiescence, surface-owned. The program says how long it will wait; the SURFACE says what
    // settled means, and on a page that means "nothing is still on the wire". A document request
    // outstanding is a navigation; anything else is a resource. Note what this gets right for free:
    // a chunked response whose body has not finished arriving is NOT settled, which is exactly the
    // condition a torn read is taken during.
    on<{ resourceType(): string }>("request", (request) => {
      this.#inflight += 1;
      if (request.resourceType() === "document") this.#inflightDocuments += 1;
    });
    const finished = (request: { resourceType(): string }): void => {
      this.#inflight = Math.max(0, this.#inflight - 1);
      if (request.resourceType() === "document") {
        this.#inflightDocuments = Math.max(0, this.#inflightDocuments - 1);
      }
    };
    on<{ resourceType(): string }>("requestfinished", finished);
    on<{ resourceType(): string }>("requestfailed", finished);

    // `generation` is monotonic and means "the surface moved underneath us for a reason the driver
    // knows about". It is not a change detector - `skeletonDigest` is - it is the counter a settle
    // loop uses to notice that something happened between two polls.
    on("framenavigated", () => {
      this.#generation += 1;
    });
    on("load", () => {
      this.#generation += 1;
    });
  }

  #assertOpen(what: string): void {
    if (this.#closed) throw new BrowserSurfaceError(`${what} on a closed surface`);
  }
}

// ---------------------------------------------------------------------------------------------
// Free functions
// ---------------------------------------------------------------------------------------------

/** The one script this driver injects, hoisted to a constant so it is reviewable in one place and
 *  can never be built out of caller-supplied text. */
const SELECT_OPTION_FN = `function (wanted) {
  if (!this || this.tagName !== "SELECT") return "not-a-select";
  var fold = function (s) { return String(s == null ? "" : s).replace(/\\s+/g, " ").trim().toLowerCase(); };
  var want = fold(wanted);
  for (var i = 0; i < this.options.length; i++) {
    var option = this.options[i];
    if (fold(option.label) !== want && fold(option.text) !== want && fold(option.value) !== want) continue;
    if (this.selectedIndex !== i) {
      this.selectedIndex = i;
      this.dispatchEvent(new Event("input", { bubbles: true }));
      this.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return "ok";
  }
  return "no-such-option";
}`;

function targetOf(action: Action): NodeId | null {
  switch (action.kind) {
    case "navigate":
    case "acceptDialog":
    case "dismissDialog":
      return null;
    case "pressKey":
      return action.target;
    default:
      return action.target;
  }
}

const isVisibleDialog = (node: UINode): boolean => node.ariaRole === "dialog" && node.state.visible;

function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.length > 2048 ? raw.slice(0, 2048) : raw;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new BrowserSurfaceError(`${what} did not complete within ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
