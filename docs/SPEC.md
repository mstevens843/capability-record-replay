# SPEC - `capability-record-replay`

**Status: canonical. This document is the build contract.** Every implementation agent builds from
this file. Where it conflicts with a proposal in `docs/design/`, this file wins. Where it conflicts
with `.private/BRIEF.md`, this file wins and §12 records why.

**Provenance.** Three design proposals were written and scored by three independent judges. This
spec adopts `proposal-failure-first` as the spine and grafts the mechanisms the judges named from the
other two. Every fatal flaw the judges raised is either fixed here or accepted in §12 with a
justification. The audit trail is `docs/design/JUDGING.md`.

**Nothing in this document is measured.** No latency, no success rate, no flake rate. Two spikes
*were* run (`docs/design/spike-browser-surface.md`, `docs/design/spike-terminal-surface.md`) and
every measured fact from them is marked **[spike]** where it forces a decision. Synthetic digests in
examples are written `sha256:<synthetic>` so they can never be mistaken for real ones.

---

## 0. The six decisions everything else follows from

1. **Replay is a classifier with an actuator attached.** The step list is the easy part; the declared
   mapping from *what the screen shows* to *what the caller is told* is the product. `classify` is a
   pure total function from a frozen `Observation` to a `Verdict`, so the entire error taxonomy is
   unit-testable with no browser running.
2. **Fail closed toward `failed`.** Promotion to a business outcome requires an explicit declared
   detector. Nothing is inferred into an outcome - not by string similarity, not by a model, not by
   "the page looks empty." A false `MEMBER_NOT_FOUND` is the worst thing this system can emit.
3. **"Not yet" is not "not so."** No negative business outcome may be classified against a surface
   that has not demonstrably settled. `requiresSettled: true` is a non-configurable literal.
4. **Three documents, three readers.** `contract` (the calling agent + product owner: types and
   outcome *names*, zero surface detail), `artifact` (the interpreter + security reviewer: the
   program, targets, detectors), `overlay` (the linker, per tenant: additive non-semantic overrides).
   **Detectors live on the artifact's steps, never on the contract.** That is what lets one contract
   be implemented by two programs - a browser one and a green-screen one.
5. **Disagreement is a detected condition, never a fallback chain.** Descriptors resolve
   independently and are compared. Different nodes → refuse. Too little *independent* evidence →
   refuse. A fallback chain is a machine for converting an ambiguity into a confident wrong click.
6. **The result contract has four arms and the caller declares its own escalation tolerance.**
   `ok | outcome | suspended | failed`. `suspended` is not terminal; telling an agent `failed` about
   a run a human is forty seconds from finishing makes it apologise for something about to succeed.

---

## 1. System overview

### 1.1 Goal → capability → production invocation

```text
  ┌── DISCOVERY (model in the loop, once) ─────────────────────────────────────────────┐
  │                                                                                    │
  │  goal (NL) + target (tenant, app instance, entry route)                             │
  │        │                                                                            │
  │        ▼                                                                            │
  │  observe → decide → act loop                                                        │
  │    · model is shown a FILTERED Observation and picks a NODE ID from it               │
  │    · model never authors a locator, never sees a descriptor                          │
  │    · every tool call passes PolicyEngine.check and is journaled                      │
  │        │                                                                            │
  │        ▼                                                                            │
  │  SYNTHESIS (deterministic, no model)                                                 │
  │    · deriveDescriptors(obs, nodeId)      → ranked, independent descriptor sets        │
  │    · parameterize(goal, values)          → typed params; artifact stores SHAPES        │
  │    · canonicalizeRoutes(urls)            → /member/:memberId                          │
  │    · deriveEffects(steps)                → EffectSummary, restartSafeUpToPc           │
  │        │                                                                            │
  │        ▼                                                                            │
  │  VERIFICATION REPLAY - model out of the loop, immediately, same session boundary      │
  │    · mode full  (READ capabilities)          → grade 'full'                           │
  │    · mode dry   (any WRITE_IRREVERSIBLE)     → grade 'partial-up-to-irreversible'     │
  │    · mode reset (fixture exposes a reset)    → grade 'full'                           │
  │        │  fails → artifact stays `proposed`, never saved as draft                     │
  │        ▼                                                                            │
  │  contract@v + artifact@v  →  lifecycle: proposed → verified(draft) → approved         │
  │                              approval SIGNS THE DIGEST                                │
  └────────────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
  ┌── PRODUCTION (no model anywhere in the decision path) ─────────────────────────────┐
  │                                                                                    │
  │  agent calls catalog.invoke(contract, { args, tenant, onIntervention, approval? })   │
  │        │                                                                            │
  │        ├─ LINK   contract ⊕ artifact ⊕ overlay ⊕ SurfaceCapabilities ⊕ args          │
  │        │         29 checks, ZERO actions performed. link-error / argument-invalid.   │
  │        │                                                                            │
  │        ├─ SESSION broker establishes an authenticated session for the profile        │
  │        │         (the program never logs in; see §7.6)                               │
  │        │                                                                            │
  │        ├─ RUN    straight-line interpreter over the Surface port                     │
  │        │         each step: lease → observe → classify(pre) → precondition →         │
  │        │                    resolve → policy → act → settle → classify(post) →       │
  │        │                    checkpoint → extract → journal                           │
  │        │                                                                            │
  │        └─ RESULT ok | outcome | suspended | failed        + renderForAgent(...)      │
  └────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Packages

Six packages and two fixture apps. The line is drawn on **purity**, not subject matter: one
package that cannot do I/O and one that owns all of it, because that is the boundary this design's
central claim depends on and the only one a contract test can enforce.

| Package | One-line justification |
|---|---|
| `@crr/core` | Schema + zod validators, canonical JSON + digest, the **linker**, the **classifier**, the target resolver, the extractor, the overlay merge, the policy predicate, the prose renderers. **Zero I/O, zero clock, zero driver imports, checked by a source-scanning contract test.** This is the package the conformance suite grades. |
| `@crr/runtime` | The impure half: session broker, control lease, quiescence polling, budget clocks, journal writer, evidence sink, file-backed artifact store, the catalog/`invoke` host, the operator console, and the `crr` CLI. One place where time, disk and sockets live, so "core is pure" is a statement about a directory. |
| `@crr/surface-browser` | Playwright + CDP `Accessibility.getFullAXTree` per frame → `Observation`. The only package that may know what a frame or a pixel is. |
| `@crr/surface-terminal` | `@xterm/headless` over a `TerminalTransport` port → `Observation` from a character grid. Exists **to falsify the port**: if the ports only fit a browser, this is where that becomes obvious rather than aspirational. |
| `@crr/discovery` | The LLM provider port (Anthropic primary), the observe→decide→act loop, the VCR transcript record/replay adapter, and artifact synthesis. The only package that may import a model SDK. |
| `@crr/conformance` | Fault scenarios × replay engines asserting three-way classification and **zero false successes**, plus deliberately weakened engines and a meta-test that fails when the suite stops discriminating. Separate so the broken engines can never ship inside `@crr/core`. |
| `fixtures/corebank-web` | The hostile surface: frameset, nested layout tables, generated ids, `<font>` tags, no test IDs, a modal confirm, per-session fault injection, two tenant variants of one vendor product. |
| `fixtures/corebank-tui` | The 80×24 green-screen variant, so `surface-terminal` has something to drive. |

**Not created, deliberately.** `@crr/schema` (the schema and the classifier change together - every
field exists for the classifier; splitting them buys a version skew between a validator and its only
consumer). `@crr/policy` (~300 lines whose only meaningful property is being the *sole* chokepoint -
a package boundary does not add that; the contract test that fails if any `Surface.act` call site
bypasses it does). `@crr/store` (a package for `readFile` is the definition of theatre).
`apps/cli` and `apps/console` (a package whose entire content is a `main()`). `@crr/types` (the
canonical monorepo mistake: a leaf package everyone depends on and nobody owns, which becomes where
fields go to avoid a design conversation). `@crr/multitenant` (overlay merge is a pure function over
two documents; it lives next to the linker that re-checks its output).

### 1.3 The two contract tests that hold the architecture up

1. **Purity.** `@crr/core`'s modules are read off disk; the test fails if `Date`, `Math.random`,
   `fetch(`, `node:`, `process.env`, `setTimeout`, `setInterval`, or any `surface-*` import appears.
2. **No CSS vocabulary anywhere above the drivers.** `@crr/core`, `@crr/runtime`, `@crr/discovery`
   are read off disk; the test fails on `querySelector`, `css`, `xpath`, `getElementById`,
   `innerHTML`, `[data-`. The artifact validator separately rejects any string in a descriptor
   position that looks like a selector, an XPath, a URL, or a `NodeId`.

---

## 2. The canonical types

Written as TypeScript with `readonly` throughout. The runtime definition is `zod` with identical
names and the exported `.d.ts` is `z.infer`'d from it, so there is one source of truth and no drift
between the validator and the types.

### 2.1 Primitives

```ts
declare const BRAND: unique symbol;
type Branded<T, B extends string> = T & { readonly [BRAND]: B };

export type CapabilityName  = Branded<string, "CapabilityName">;  // "corebank.member.read_savings_balance"
export type ContractVersion = Branded<string, "ContractVersion">; // semver "1.2.0"
export type ArtifactId      = Branded<string, "ArtifactId">;
export type StepId          = Branded<string, "StepId">;
export type LabelToken      = Branded<string, "LabelToken">;      // §9: the multi-tenant hinge
export type RouteId         = Branded<string, "RouteId">;
export type TenantId        = Branded<string, "TenantId">;
export type AppInstanceId   = Branded<string, "AppInstanceId">;
export type RunId           = Branded<string, "RunId">;
export type NodeId          = Branded<string, "NodeId">;          // PER-OBSERVATION ONLY. Never stored.
export type Digest          = Branded<string, "Digest">;          // "sha256:<64 hex>" over canonical JSON
export type LeaseToken      = Branded<string, "LeaseToken">;
export type ApprovalToken   = Branded<string, "ApprovalToken">;
export type InterventionId  = Branded<string, "InterventionId">;
export type EvidenceRef     = Branded<string, "EvidenceRef">;     // content-addressed blob key
export type Timestamp       = string;                             // ISO-8601 UTC, set only by runtime

/**
 * Decimal-as-string. There is no IEEE-754 anywhere in this schema, at any depth, ever.
 *   1. The artifact is content-addressed with canonical JSON (JCS). Float serialization is not
 *      canonical across languages, so a float makes the digest - and therefore the approval
 *      SIGNATURE - platform-dependent.
 *   2. This is money in a bank. 0.1 + 0.2 is a defect, not a rounding style.
 * Every other number in this schema is an integer: milliseconds, counts, indices, cells, pixels.
 */
export type Decimal = Branded<string, "Decimal">;
export interface Money { readonly amount: Decimal; readonly currency: "USD" }

/**
 * Closed role vocabulary, normalized ACROSS surfaces. Closed because an open string set lets the
 * terminal driver and the browser driver disagree silently, so a descriptor recorded on one would
 * never resolve on the other. A closed union makes that a compile error in the driver instead of a
 * mystery at replay.
 */
export type Role =
  | "button" | "link" | "textbox" | "combobox" | "listbox" | "option" | "checkbox" | "radio"
  | "table" | "row" | "cell" | "columnheader" | "rowheader" | "heading" | "dialog" | "alert"
  | "status" | "form" | "region" | "navigation" | "main" | "group" | "list" | "listitem"
  | "tab" | "text" | "image";
// NOTE: there is no "unknown" member. A node the driver cannot classify carries ariaRole: null
// and is structure, never a target. See §2.2 and browser spike §1.4.

export type Sensitivity = "public" | "internal" | "sensitive";
export type EffectClass = "READ" | "WRITE_REVERSIBLE" | "WRITE_IRREVERSIBLE";
export type SurfaceKind = "web-modern" | "web-legacy" | "terminal" | "desktop";
```

```ts
/**
 * Text comparison. NO REGEX ANYWHERE - see §5.6. Three reasons: a regex in an artifact is not
 * reviewable by the operations person who approves it; it is a ReDoS surface in a file that crosses
 * a trust boundary from a model-authored document; and the one thing people reach for it to do here
 * ("the message with the id in it") is better served by `template` holes, which additionally keep
 * the id out of the file.
 */
export type TextMatcher =
  | { readonly mode: "exact";    readonly value: string;   readonly normalize: NormalizerId }
  | { readonly mode: "contains"; readonly value: string;   readonly normalize: NormalizerId }
  /** Holes are PARAMETER NAMES, never values: "No member found for {memberId}". */
  | { readonly mode: "template"; readonly value: string;   readonly normalize: NormalizerId }
  /** The multi-tenant form. Resolved through `flow.vocabulary`; an overlay REPLACES the list. */
  | { readonly mode: "token";    readonly token: LabelToken; readonly normalize: NormalizerId };

/**
 * Named, VERSIONED registries instead of inline option objects. Two payoffs: an artifact stops
 * repeating a four-field normalize object at forty use sites (a reviewability defect in a schema
 * whose whole point is human review), and engine code cannot silently change what an approved
 * artifact means while the digest keeps matching. The major is part of the id, and there is a test
 * - not a convention - that freezes each registered function's behaviour against golden vectors.
 */
export type NormalizerId = "std.text@1" | "std.label@1" | "std.money@1" | "std.identity@1";
export type ExtractorId  = "text@1" | "value@1" | "name@1" | "cell@1";
export type ParserId     = "string@1" | "integer@1" | "moneyUSD@1" | "dateUS@1" | "dateISO@1" | "enum@1";
// std.text@1  = trim + collapse whitespace + case-fold
// std.label@1 = std.text@1 + strip trailing ":", ".", "_" + strip tenant branding tokens
// std.money@1 = trim + strip currency symbol + strip thousands separators
// A tenant's branding tokens are supplied by the OVERLAY, not baked into the registry.

/**
 * Where a value comes from. Provenance is not decoration: it is the input that lets the classifier
 * tell "the app rejected the CALLER's value" (a business outcome the agent can fix) from "the app
 * rejected a value baked into the ARTIFACT" (a hard failure no caller can fix). See §4.2 row 3.
 */
export type ValueRef =
  | { readonly from: "param";      readonly param: string }
  | { readonly from: "literal";    readonly value: string; readonly sensitivity: "public" }
  | { readonly from: "output";     readonly step: StepId; readonly output: string }
  | { readonly from: "credential"; readonly key: string };
// The `literal` variant is TYPED sensitivity: "public". A non-public literal is not expressible,
// which makes the PII rule a type-level guarantee rather than a lint the linker re-checks (it does
// re-check it - check 14 - but the type is the primary control).

export type ValueType =
  | { readonly kind: "string"; readonly charset?: "digits" | "alnum" | "any";
      readonly minLength?: number; readonly maxLength?: number }
  | { readonly kind: "integer"; readonly min?: number; readonly max?: number }
  | { readonly kind: "decimal"; readonly scale: number }
  | { readonly kind: "money"; readonly currency: "USD" }
  | { readonly kind: "date"; readonly format: "YYYY-MM-DD" }
  | { readonly kind: "boolean" }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  /** Bounded table read. Exists so `readTable` has a representable output type - the one thing the
   *  interpreter-first proposal could not express. Rows are capped at the ARTIFACT's maxRows. */
  | { readonly kind: "table"; readonly columns: readonly { readonly name: string; readonly type: ValueType }[] };

/** Canonicalized route. NEVER a literal URL: `/member/12345` in an artifact is persisted PII, and a
 *  literal origin makes an artifact accidentally single-tenant. */
export interface RoutePattern {
  readonly id: RouteId;
  readonly originAlias: string;              // "corebank" → resolved per tenant by the overlay
  readonly path: string;                     // "/members/:memberId/accounts"
  readonly query?: Readonly<Record<string, ValueRef | ":any">>;
  readonly frame?: string;                   // frameset target name, when the route lands in a frame
}
```

### 2.2 The `Surface` port - Observation, UINode, Action, ActResult

Everything above this line is written in a vocabulary that has never heard of a browser. These types
are the only place surfaces and flows meet.

```ts
export interface Surface {
  /**
   * Normalized snapshot. Takes a DEADLINE and nothing else - perception is not parameterized by
   * what you hope to find, but it must be bounded.
   *
   * WHY the deadline is non-negotiable [spike, browser §7.1]: an open native `confirm()` blocks the
   * renderer, so `Accessibility.getFullAXTree` NEVER RETURNS - no CDP error, no timeout of its own.
   * The spike deadlocked and was killed at two minutes. A CDP call with no timeout is a hang, not
   * an error. On expiry the driver returns `{ ok: false, fault: { kind: "perceive-timeout" } }`.
   */
  perceive(opts: { readonly deadlineMs: number }): Promise<PerceiveResult>;

  /**
   * Perform one action. TAKES THE LEASE TOKEN, so the driver enforces the control model too: a
   * stale automation lease cannot act on a session a human has taken, and that is a rejection at
   * the port rather than a convention upstairs.
   */
  act(action: Action, lease: LeaseToken): Promise<ActResult>;

  /**
   * Evidence only. A capture is NEVER read by the decision path - no detector, no descriptor and no
   * checkpoint may consume pixels. Separating it from `perceive` is what keeps that honest, and it
   * is what lets the terminal surface be a real driver: its "screenshot" is a text dump of the
   * character grid and nothing upstream notices.
   */
  capture(req: CaptureRequest): Promise<Capture>;

  /** Advertised at LOAD time. The linker refuses a program this surface cannot run. §10 check 17. */
  capabilities(): SurfaceCapabilities;
}

export interface SurfaceCapabilities {
  readonly kind: SurfaceKind;
  readonly driver: string;                              // "surface-browser@0.1.0"
  readonly supportedActions: readonly Action["kind"][];
  readonly supportedKeys: readonly Key[];
  readonly supportedRoles: readonly Role[];
  readonly resolvableDescriptors: readonly DescriptorKind[];
  readonly containerKinds: readonly ContainerSegment["kind"][];
  readonly boundsUnit: "px" | "cell" | null;
  /** Minimum synthesis confidence a descriptor must clear on this surface to count toward quorum.
   *  1.0 on a real AX tree; lower on a character grid where roles are inferred. */
  readonly confidenceFloor: number;
  readonly canCapture: readonly ("image" | "text-grid")[];
}

export type PerceiveResult =
  | { readonly ok: true; readonly observation: Observation }
  | { readonly ok: false; readonly fault: PerceiveFault };

export type PerceiveFault =
  | { readonly kind: "perceive-timeout"; readonly elapsedMs: number }
  | { readonly kind: "unperceivable-container"; readonly detail: string }  // OOPIF, browser spike §2.4
  | { readonly kind: "surface-error"; readonly message: string };
```

```ts
export interface Observation {
  /** Monotonic within a session. NOT a timestamp - the classifier gets no clock. */
  readonly seq: number;
  readonly surface: { readonly kind: SurfaceKind; readonly driver: string };

  /** Canonicalized. NEVER the raw URL; the driver applies the tenant's route canonicalization, so
   *  an Observation never carries a member number in a path. */
  readonly route: { readonly originAlias: string; readonly path: string;
                    readonly query: Readonly<Record<string, string>>; readonly frame?: string } | null;

  /** FLAT with parent links, not a tree. Classifiers and resolvers are pure functions that scan;
   *  a flat array is both faster to scan and far easier to write a TOTAL predicate over. */
  readonly nodes: readonly UINode[];
  readonly roots: readonly NodeId[];               // plural: a frameset has several

  /**
   * Digest of the STRUCTURAL SKELETON only - role + accessible name + containerPath + state for
   * every node - deliberately EXCLUDING geometry and excluding nodes marked `live`, so a clock in
   * the page header cannot make the surface permanently unsettled. Computed by the DRIVER, so the
   * classifier never hashes anything.
   */
  readonly skeletonDigest: string;

  /** Surface-owned. The program says how long it will wait; the SURFACE says what settled means,
   *  because that differs completely between a page and a pty. */
  readonly stability: {
    readonly settled: boolean;
    readonly generation: number;
    readonly pendingReason: "navigating" | "network" | "animating" | "pty-active" | "unknown" | null;
  };

  /**
   * Native dialogs are a SEPARATE CHANNEL, not a node.
   * [spike, browser §7.1] Native `confirm()`/`alert()`/`prompt()` are invisible to the accessibility
   * tree entirely - they cannot be modelled as a `UINode`. A boolean `inputIntercepted` cannot carry
   * `{type:"confirm", message:"Post this transaction?"}`, which is exactly what you need to decide
   * accept-versus-dismiss. The DRIVER owns `page.on('dialog')`: with no handler registered
   * Playwright silently DISMISSES the confirm, the click succeeds, and the checkpoint fails three
   * steps downstream with the cause nowhere in sight.
   */
  readonly nativeDialog: {
    readonly type: "alert" | "confirm" | "prompt" | "beforeunload";
    readonly message: string;
    readonly defaultValue: string | null;
  } | null;

  /** In-page modals ARE perceivable and appear as `role: "dialog"` nodes. True when the driver knows
   *  something is intercepting input - drives band B2's pre-act guard. */
  readonly inputIntercepted: boolean;
}

/**
 * Opaque, and stable ONLY within one Observation. Stated loudly because it is what stops anyone
 * putting a node id in an artifact: a node id is an index into a snapshot, not an identity. The
 * artifact validator rejects any NodeId-shaped string.
 */
export interface UINode {
  readonly id: NodeId;

  /**
   * The driver's raw role name, INCLUDING structural/internal roles.
   * [spike, browser §1.4] Chromium's AX tree distinguishes `LayoutTable`/`LayoutTableRow`/
   * `LayoutTableCell` (`AXValue.type === "internalRole"`) from `table`/`row`/`cell`
   * (`type === "role"`). Playwright's `ariaSnapshot` folds them together, and on a page of nested
   * layout tables that fold makes "the row whose Member ID is X" resolve to THREE elements -
   * measured, with Playwright strict mode refusing: *"resolved to 3 elements"*.
   */
  readonly rawRole: string;

  /**
   * The normalized role, or `null` for a structural/presentational node.
   * **Only `ariaRole !== null` nodes are candidate targets.** This single field is what makes a
   * table-anchored descriptor work on a table-based layout, and it is the difference between
   * "resolved to 3 elements" and `OK`. No proposal had it; the spike forced it.
   */
  readonly ariaRole: Role | null;

  /** Accessible name. On the terminal driver, the label text detected to the left of the field. */
  readonly name: string;
  readonly value: string | null;
  readonly text: string | null;
  readonly description: string | null;
  readonly state: NodeState;

  /** px on a browser, character cells on a grid. `null` when the surface has no geometry for it. */
  readonly bounds: { readonly x: number; readonly y: number; readonly w: number; readonly h: number;
                     readonly unit: "px" | "cell" } | null;

  /**
   * The breadcrumb §2.4 matches against, computed by the driver.
   * [spike, browser §2.3] The frame NAME chain, never an ordinal: navigating one frame away removed
   * a nested iframe and shifted every subsequent ordinal (`f3=content/detail` → gone). Names in a
   * frameset are author-assigned and stable; ordinals are not.
   */
  readonly containerPath: readonly ContainerSegment[];
  readonly parent: NodeId | null;
  readonly children: readonly NodeId[];
  readonly labelledBy: readonly NodeId[];

  /** Present iff the driver advertises the `table-position` feature. The reason `table-cell` works. */
  readonly tablePosition: {
    readonly rowIndex: number;
    readonly colIndex: number;
    readonly rowHeader: string | null;
    readonly colHeader: string | null;
    /**
     * [spike, browser §5.2] The legacy grid has no `<th>`, no `scope=`, no `<caption>`: every cell
     * in row 0 is `role=cell`, not `columnheader`. We get STRUCTURE for free and HEADERS only by
     * heuristic. This field is the difference between "the app told us this column is Share Balance"
     * and "we guessed from row 0" - and a per-tenant overlay is exactly where a wrong guess gets
     * corrected. It is recorded on the artifact at record time and compared at replay.
     */
    readonly headerProvenance: "columnheader-role" | "first-row-heuristic";
  } | null;

  /** Field width in cells on a character grid; `null` on a browser.
   *  [spike, terminal §3.3] `capacity` falls straight out of the grid and becomes the `maxLength` of
   *  the capability's typed parameter. The browser surface has to work for that. */
  readonly capacity: number | null;

  /** Driver's confidence in its own synthesis. 1.0 for an AX node with an explicit label; lower on a
   *  character grid where the role was inferred from a reverse-video run. Compared against
   *  `SurfaceCapabilities.confidenceFloor` during quorum. */
  readonly confidence: number;

  /** Text that changes on its own (clocks, tickers). Excluded from the skeleton digest. */
  readonly live: boolean;

  /** True when the driver blanked this node's value because it is bound to a sensitive parameter. */
  readonly masked: boolean;
}

export interface NodeState {
  readonly disabled: boolean;
  readonly focused: boolean;
  readonly visible: boolean;
  readonly checked: boolean | null;    // tristate on a browser; [spike §5.4] CDP returns "true"/"false"
  readonly expanded: boolean | null;
  readonly selected: boolean | null;
  readonly required: boolean | null;
  readonly invalid: boolean | null;
  readonly readonly: boolean | null;
}

export type ContainerSegment =
  | { readonly kind: "frame"; readonly name: string }
  | { readonly kind: "landmark"; readonly role: "main" | "navigation" | "form" | "region" | "dialog";
      readonly name: string | null }
  | { readonly kind: "heading-section"; readonly heading: string; readonly level: 1|2|3|4|5|6 }
  /** A table identified by its COLUMN HEADER SET. In table-soup layouts there is no caption, no id
   *  and no class worth trusting, but the set of column headings is exactly what a human uses to
   *  know which table they are looking at - and it is what would have to change for the human
   *  workflow to change. */
  | { readonly kind: "table"; readonly headers: readonly string[] }
  /** Terminal: the screen id read from the fixed header/footer band. This surface's URL. */
  | { readonly kind: "screen"; readonly id: string };
```

```ts
/**
 * Closed set. Adding a kind is a deliberate, reviewed change to the policy engine's classifier.
 * This is the DRIVER-FACING action, below the seam - it names a resolved NodeId, never a descriptor.
 */
export type Action =
  | { readonly kind: "click";      readonly target: NodeId }
  | { readonly kind: "type";       readonly target: NodeId; readonly text: string;
      readonly mode: "replace"; readonly sensitive: boolean }
  | { readonly kind: "select";     readonly target: NodeId; readonly option: string }
  | { readonly kind: "setChecked"; readonly target: NodeId; readonly checked: boolean }
  | { readonly kind: "pressKey";   readonly target: NodeId | null; readonly key: Key }
  | { readonly kind: "focus";      readonly target: NodeId }
  | { readonly kind: "navigate";   readonly route: { readonly originAlias: string; readonly path: string;
                                    readonly query: Readonly<Record<string, string>>; readonly frame?: string } }
  | { readonly kind: "acceptDialog";  readonly text: string | null }   // native dialog channel only
  | { readonly kind: "dismissDialog" };

/**
 * F1-F12 ARE HERE, at the PORT, and are NOT in the artifact's instruction set (§3).
 * The judges split on this and both halves were right. On a green screen the PF keys are the submit
 * mechanism, so a port without them cannot express the terminal surface. But [spike, terminal §3.4]
 * the Exit control is F3 at riverbend and F12 at summit while the synthesized node `button:exit` is
 * IDENTICAL across both - so a program that hardcodes `pressKey(F3)` is correct at one tenant and
 * wrong at the next. Resolution: the artifact says `activate` the control named "Exit"; the terminal
 * driver reads the legend line and lowers that to F3 or F12. The program says what the operator
 * MEANT; the surface says how that is done here. Linker check 21 rejects an F-key in an artifact.
 */
export type Key =
  | "Enter" | "Tab" | "Escape" | "Backspace" | "Delete"
  | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"
  | "Home" | "End" | "PageUp" | "PageDown"
  | "F1"|"F2"|"F3"|"F4"|"F5"|"F6"|"F7"|"F8"|"F9"|"F10"|"F11"|"F12";

/**
 * Note what is NOT an Action: no `wait`, no `screenshot`, no `read`, no `scroll`, no `evaluate`.
 *   · Waiting is the executor's quiescence loop, not an action (§3.6).
 *   · Reading is a pure function over an Observation, so extraction never touches the surface and is
 *     testable from a frozen snapshot.
 *   · Making a node actionable is the SURFACE's obligation before it acts; scrolling as an
 *     instruction hardcodes a browser assumption into a language that also runs on a 24x80 grid
 *     that pages with PF7/PF8. The driver scrolls; the artifact never says so.
 *   · `evaluate`/`script`/`exec` would be a hole straight through the surface abstraction AND the
 *     single policy chokepoint.
 */

export type ActResult =
  | { readonly ok: true; readonly dispatched: true }
  | { readonly ok: false; readonly fault: ActFault };

/** MECHANICAL faults only. The driver reports what the machinery did; it never classifies.
 *  The classifier turns these into a `FailureClass` using the artifact's context. */
export type ActFault =
  | { readonly kind: "lease-not-held" }                                    // enforced AT the port
  | { readonly kind: "node-gone"; readonly nodeId: NodeId }
  | { readonly kind: "not-actionable"; readonly nodeId: NodeId;
      readonly why: "disabled" | "invisible" | "zero-size" | "off-screen-unscrollable" }
  | { readonly kind: "intercepted"; readonly nodeId: NodeId }              // §4.5 W5: the one
  | { readonly kind: "navigation-blocked"; readonly route: string }        // wrong-target case the
  | { readonly kind: "surface-error"; readonly message: string };          // machinery sees directly

export interface CaptureRequest {
  /** Regions blanked BEFORE the bytes exist, derived from resolved sensitive targets. Not applied
   *  after: a screenshot that was ever unmasked in memory is a screenshot that can leak. */
  readonly maskRegions: readonly { readonly x: number; readonly y: number;
                                   readonly w: number; readonly h: number }[];
  readonly format: "image" | "text-grid";
}
export interface Capture { readonly ref: EvidenceRef; readonly digest: Digest; readonly maskedRegions: number }
```

**Driver obligations, written as rules because both spikes produced a trap that no careful code
would have caught on its own.**

| # | Rule | Source |
|---|---|---|
| D1 | Build the tree with `Page.getFrameTree` → one `Accessibility.getFullAXTree({frameId})` per frame → stitch via `DOM.describeNode`. A single call returns **7 nodes** on a frameset; the whole tree is 205. | browser §2.1-2.2 |
| D2 | `ariaRole` is `null` unless `role.type === "role"`. Only non-null nodes are candidate targets. | browser §1.4 |
| D3 | `containerPath` is the frame **name** chain. Never an ordinal. | browser §2.3 |
| D4 | Coordinate fallback is: `scrollIntoViewIfNeeded` → **re-read** `model.border` → validate `w>0 && h>0` and centre inside the viewport → click. Never the `content` quad, never a frame-local box. | browser §4.1-4.3 |
| D5 | The driver registers `page.on('dialog')` and surfaces it on `Observation.nativeDialog`. It never auto-accepts and never auto-dismisses. | browser §7.1 |
| D6 | `perceive` honours its deadline with its own timer, not CDP's. | browser §7.1 |
| D7 | When `Page.getFrameTree` and `page.frames()` disagree, return `unperceivable-container` rather than silently skipping the frame. | browser §2.4 |
| D8 | The terminal driver's lowest layer is a `TerminalTransport` port (`write`/`onData`/`close`), with `child_process` pipes as the shipping implementation and `node-pty` an **optional peer**. Real green screens are reached over telnet/SSH/TN3270 - a socket, with no client-side pty at all - so a pty-only driver models the demo, not the target. The two transports produced **byte-identical** grids (same sha256 over 1.28 MB), so the port costs nothing in fidelity; and `node-pty@1.1.0` ships `spawn-helper` without the executable bit and is broken out of the box on darwin-arm64. | terminal §1.3, §1.5, §2.3 |
| D9 | The terminal driver reports structure and **never business meaning**. `*** NO MEMBER ON FILE FOR 77777` becomes `{role:"status", value:"…", name:null}` and stops. Deciding that means `MEMBER_NOT_FOUND` belongs to the artifact's declared detector, where it can be reviewed, versioned and overlaid per tenant. | terminal §3.2 |
| D10 | Terminal node ids are name-derived, never coordinate-derived (`textbox:account-number`, not `textbox:5,21`). A grid coordinate is that surface's CSS selector. | terminal §3.2 |

### 2.3 The contract document - what the calling agent sees

The contract is **surface-free and tenant-free**. It carries outcome *names* and their payload
types; it carries **no detector**, no container path, no frame name, no step id. That single
factoring is what lets one contract be implemented by two artifacts (a browser program and a
green-screen program) and it is what stops re-recording a flow from dangling every reference in the
caller's public API.

```ts
export interface CapabilityContract {
  readonly schemaVersion: "capability.contract/v1";
  readonly name: CapabilityName;
  readonly version: ContractVersion;              // semver; see the prose-patch rule below
  readonly title: string;
  readonly summary: string;                       // one line, for a catalog list view
  /** Routing hints. Models mis-route far more often than they mis-fill arguments. */
  readonly whenToUse: readonly string[];
  readonly whenNotToUse: readonly string[];

  readonly inputs: readonly ParamSpec[];
  readonly outputs: readonly OutputSpec[];
  readonly outcomes: readonly OutcomeDecl[];

  /** Rolled up from the artifact at approval time and re-checked by the linker (check 13). */
  readonly effect: EffectClass;
  readonly requiresApproval: boolean;             // derived: effect === "WRITE_IRREVERSIBLE"
  readonly idempotent: boolean;
  readonly digest: Digest;                        // over canonical JSON with `digest` removed
}

export interface FieldSpec {
  readonly name: string;
  readonly type: ValueType;
  readonly required: boolean;
  readonly description: string;                   // model-facing
  readonly sensitivity: Sensitivity;
  /**
   * A synthetic example for the catalog. MUST be absent when sensitivity is `sensitive`; the
   * validator enforces it, because "here is an example member number" in a committed schema file is
   * exactly the failure mode the taint model exists to prevent.
   */
  readonly example?: string;
}

export interface ParamSpec extends FieldSpec {
  /**
   * Evaluated BEFORE any surface is touched. The cheapest classification touches nothing: driving
   * four steps of a legacy UI to learn that "abc" is not a member id is slower, flakier, and gives a
   * worse message than rejecting it in a nanosecond. Failure here is `argument-invalid` with
   * `sideEffects: "none-guaranteed"` - NOT a business outcome. See §12 decision 5.
   */
  readonly constraints?: {
    readonly charset?: "digits" | "alnum" | "any";
    readonly minLength?: number; readonly maxLength?: number;
    readonly enum?: readonly string[];
  };
  /** Evidence the parameter was DISCOVERED from the goal rather than invented, which is what makes
   *  "parameterization is the PII control" auditable rather than asserted. */
  readonly discoveredFrom: { readonly goalSpan: string } | { readonly operator: true };
}

export interface OutputSpec extends FieldSpec {
  /**
   * How much of this output the MODEL is allowed to see. Distinct from `sensitivity`, which governs
   * persistence. A tool result is itself a persisted artifact - it lands in the provider transcript
   * and the agent's conversation history - so "taint controls persistence, not delivery" is not
   * sufficient on its own. The balance is `deliver` (reading it is the point of the call); a member
   * name may be `mask`. `renderForAgent` enforces this; the typed `ReplayOk.outputs` handed to the
   * PROGRAM is never masked.
   */
  readonly agentDisclosure: "deliver" | "mask" | "withhold";
}

/**
 * The contract's half of an outcome: a NAME, a payload type, and reviewed prose. NO DETECTOR.
 * The detector is an `OutcomeRule` on a step of the artifact (§2.4), linked by `code` (check 8).
 */
export interface OutcomeDecl {
  readonly code: string;                          // SCREAMING_SNAKE. Public API: renaming is breaking.
  /** A literal discriminant that is never the string "error", on a type with no error field. */
  readonly kind: "business_outcome";
  readonly title: string;
  readonly summary: string;                       // verbatim into the generated tool description
  readonly terminal: true;                        // v1: an outcome ends the run
  readonly payload: readonly FieldSpec[];
  /** WHO WROTE THIS. Required, no default, inside the digest, and matched against the detector's
   *  own `origin` by check 8. Added by `docs/design/OUTCOME-PROMOTION.md`; `hand-authored` names
   *  the state every outcome in this repository was already in - typed into the document outside
   *  any lifecycle and never proven - and `reviewer-authored` is the only value `crr promote`
   *  writes, behind a discrimination proof (check 29). NOT rendered to a calling agent: a model
   *  handed a pedigree starts weighing outcomes by it, which is a routing decision nobody reviewed. */
  readonly origin: "synthesized" | "hand-authored" | "reviewer-authored";

  /**
   * What the CALLER should do. This is the field that makes the three-way split actionable rather
   * than merely descriptive.
   *   inform-user           → say this answer to the member.
   *   retry-different-input → the value the caller supplied was rejected; ask again.
   *   refer-to-specialist   → the ANSWER is "a person at the institution must service this record".
   * Note `refer-to-specialist` is a business fact about the record, not an engine escalation. Engine
   * escalation is the `suspended` arm and never travels on an outcome.
   */
  readonly callerAction: "inform-user" | "retry-different-input" | "refer-to-specialist";
  readonly retryable: "never" | "after_delay" | "with_different_inputs";

  /**
   * The reviewed playbook. Written by a human at approval time, copied VERBATIM into the tool
   * result, never generated at runtime. The whole argument for a closed outcome set is that
   * somebody thought about each member of it once, in advance, calmly.
   */
  readonly agentGuidance: string;
}
```

**The prose-patch rule.** `title`, `summary`, `description`, `whenToUse`, `whenNotToUse` and
`agentGuidance` are the only fields a **patch** version bump may change. A patch changes the digest
and therefore requires re-approval and re-signing - but it does not change any generated type, so it
is not a breaking change at a call site. Anything else - an input, an output, an outcome code, an
effect class - is a **minor or major** bump and is a compile error at every call site, correctly,
because a new possible answer *is* a breaking change for the caller.

### 2.4 The artifact document - what the interpreter runs

```ts
export interface CapabilityArtifact {
  readonly schemaVersion: "capability.artifact/v1";
  readonly artifactId: ArtifactId;
  readonly implements: { readonly name: CapabilityName; readonly version: ContractVersion;
                         readonly contractDigest: Digest };
  readonly version: number;                       // monotonic per (capability, surfaceKind)
  readonly digest: Digest;                        // canonical JSON with digest+signatures removed

  readonly target: VendorTarget;
  readonly lifecycle: Lifecycle;
  readonly flow: Flow;
  readonly continuity: readonly ContinuityDef[];
  readonly provenance: Provenance;
  readonly verification: Verification;
  readonly policy: PolicyRequirements;
  readonly effects: EffectSummary;                // DERIVED at save time, re-derived by the linker
  readonly budgets: RunBudgets;
  /** One receipt per reviewer-authored outcome. INSIDE the digest, so an approver signs this
   *  program WITH this proof; carries no clock and no run id, so the address stays reproducible
   *  from the review document plus the observation corpus. §2.4 of OUTCOME-PROMOTION.md. */
  readonly promotions: readonly PromotionReceipt[];
  readonly signatures: readonly Signature[];
}

export interface VendorTarget {
  /** The vendor PRODUCT, not the tenant. This is the unit of reuse across hundreds of tenants. */
  readonly product: string;
  readonly productVersionRange: string;           // semver range, advisory
  readonly surfaceKind: SurfaceKind;
  /** Surface features this program REQUIRES. Refused at LOAD time by the linker against
   *  `Surface.capabilities()`, with a clear message, rather than dying at step 6 with a mysterious
   *  target-not-found. */
  readonly requires: readonly SurfaceFeature[];
  /** Named credential/session profile. The artifact names the profile; it never carries material. */
  readonly sessionProfile: string;
}

export type SurfaceFeature =
  | "accessibility-tree" | "table-position" | "containers" | "geometry"
  | "character-grid" | "route" | "native-dialog-channel";

export interface Flow {
  readonly entry: { readonly route: RouteId; readonly precondition: Predicate };
  readonly routes: readonly RoutePattern[];

  /**
   * THE MULTI-TENANT HINGE. Label synonyms declared ONCE and referenced by token from every
   * descriptor, detector, row key and checkpoint. An overlay REPLACES a token's list, so a tenant
   * that says "Member #" and "Find" needs a nine-line overlay rather than an edit at forty matchers.
   * Resolution: the first synonym that resolves a UNIQUE node wins; if two synonyms resolve
   * DIFFERENT nodes that is an ambiguity, not a preference.
   */
  readonly vocabulary: Readonly<Record<LabelToken, readonly string[]>>;

  /** Steps that are safe idempotent re-entry points. A `restart-from-checkpoint` recovery may only
   *  target one of these, and only if no WRITE_IRREVERSIBLE step lies between it and the current
   *  step. Checked at save time AND re-derived by the linker as `restartSafeUpToPc`. */
  readonly resumePoints: readonly StepId[];

  /** A straight line. No branching, no loops, no conditionals - see §3.7. */
  readonly steps: readonly Step[];

  /** Evaluated at EVERY step. Session expiry does not respect step boundaries. Ambient rules are
   *  RECOVERIES and environment conditions only - never business outcomes (§4.4). */
  readonly ambient: readonly RecoveryRule[];
}

export interface Step {
  readonly id: StepId;
  /** HUMAN-ONLY prose, from the model's own words at discovery. The engine must not read it; a
   *  contract test asserts `title` and `intent` are referenced nowhere outside serialization and
   *  rendering. An engine that reads prose has put the model back in the decision loop by the side
   *  door. */
  readonly title: string;
  readonly intent: string;

  readonly effect: EffectClass;
  readonly instruction: Instruction;              // §3
  readonly target: TargetRef | null;              // null for navigate / key-to-focused / assert
  readonly precondition: Predicate | null;
  readonly settle: SettlePolicy;
  /** NON-OPTIONAL. A step with no postcondition cannot be recorded - the recorder refuses and the
   *  schema has no way to express it. Strongest single anti-"blindly proceeding" mechanism
   *  available, and it costs one required field. */
  readonly expect: Checkpoint;

  readonly outcomes: readonly OutcomeRule[];      // detectors live HERE, not on the contract
  readonly recoveries: readonly RecoveryRule[];
  readonly extract: readonly ExtractSpec[];
  readonly budgets: StepBudgets;
  readonly evidence: { readonly captureOn: readonly ("failure" | "outcome" | "always")[] };
}

export interface Checkpoint {
  readonly predicate: Predicate;
  readonly delta: DeltaAssertion;                 // control C5, §4.5
  readonly continuity: readonly string[];         // control C2 ids that must hold here
  /**
   * A DECLARED, EXPECTED dialog - §4.4's amendment. OPTIONAL, and absent means what its absence has
   * always meant: this step expects no dialog and any dialog is an interception.
   *
   * Optional and not `| null` because the artifact is content-addressed and an approval signs the
   * address: a required `dialog: null` would move the digest of every artifact ever recorded in
   * order to say the thing their absence already says.
   */
  readonly dialog?: ExpectedDialog;
  /** NOTE: there is no `describes` string. Failure prose is GENERATED by a fold over the predicate
   *  and the target (`renderPredicate`/`renderTarget`/`renderVerdict`, §4.7). Authored prose drifts
   *  from the predicate it claims to describe; a fold cannot. */
}

/**
 * The dialog a step transacts with. §4.4's amendment; the classifier reads it in exactly two
 * places and both are named there.
 */
export interface ExpectedDialog {
  /** WHICH dialog. A `NodeQuery` and not a `TargetRef`: this names a thing to be RECOGNISED, not a
   *  thing to be acted on, so it is existential and carries no quorum. Linker check 25 requires it
   *  to constrain `role: "dialog"`. */
  readonly where: NodeQuery;
  /** `true` when this step's action RAISES the dialog - the dialog is the postcondition. `false`
   *  when this step's action ANSWERS it - its ABSENCE is the postcondition, and the declaration
   *  exists so the dialog already on screen when the step BEGINS is not read as an interception.
   *  The licence (band B2 stands down) and the obligation (band B5 asserts) are one field, so a
   *  step cannot claim the first without paying the second. */
  readonly present: boolean;
}

export interface DeltaAssertion {
  /** Default true, and deliberately the WEAKEST useful assertion: something observable must have
   *  changed. A strict delta overfits the recording and turns benign rendering differences into
   *  failures. Weak as it is, this is the only thing that catches "the click dispatched and nothing
   *  happened" (§4.5 W6), which is otherwise indistinguishable from success. */
  readonly mustChange: boolean;
  readonly navigatedTo?: RouteId;
  readonly changedContainers?: readonly ContainerMatcher[];
  readonly focusMovedInto?: ContainerMatcher;
}

/** A named value that flows through the run and must be RE-OBSERVED at declared waypoints. Turns
 *  "a member detail page loaded" into "THE member detail page for the member we were asked about". */
export interface ContinuityDef {
  readonly id: string;                            // "subjectMember"
  readonly source: ValueRef;                      // usually { from: "param" }
  /** Comparison is NORMALIZED, not identity: "12345" in the search box and "Member #12345" in the
   *  detail heading are the same subject. */
  readonly compare: { readonly via: NormalizerId; readonly type: ValueType };
}
```

```ts
/** A breadcrumb, not a selector. Every segment must match. The unit of SCOPE for both locator
 *  resolution and detector evaluation, and the reason "the Search button in the nav frame" and
 *  "the Search button in the content frame" are different things. */
export interface ContainerMatcher { readonly path: readonly ContainerSegmentMatcher[] }

export type ContainerSegmentMatcher =
  | { readonly kind: "frame"; readonly name: TextMatcher }
  | { readonly kind: "landmark"; readonly role: "main" | "navigation" | "form" | "region" | "dialog";
      readonly name?: TextMatcher }
  | { readonly kind: "heading-section"; readonly heading: TextMatcher; readonly level?: 1|2|3|4|5|6 }
  | { readonly kind: "table"; readonly headers: readonly TextMatcher[] }
  | { readonly kind: "screen"; readonly id: TextMatcher };

/**
 * The predicate language. Non-Turing-complete by construction: no loops, no arithmetic beyond a
 * count comparison, no user-defined functions, depth-bounded at 4 and checked at save time. It must
 * be diffable in a pull request, reviewable by someone who is not an engineer, cost-bounded so a
 * malformed artifact cannot hang a replay, and - the criterion that actually decided the member
 * list - RENDERABLE INTO PROSE, because the interpreter has to explain it to a human at 2am.
 */
export type Predicate =
  | { readonly all: readonly Predicate[] }
  | { readonly any: readonly Predicate[] }
  | { readonly not: Predicate }
  | { readonly kind: "node-exists"; readonly where: NodeQuery }
  | { readonly kind: "node-absent"; readonly where: NodeQuery }
  | { readonly kind: "text-present"; readonly scope?: ContainerMatcher; readonly text: TextMatcher }
  | { readonly kind: "node-state"; readonly where: NodeQuery; readonly state: keyof NodeState;
      readonly equals: boolean }
  | { readonly kind: "value-matches"; readonly where: NodeQuery; readonly matcher: TextMatcher }
  | { readonly kind: "count"; readonly where: NodeQuery; readonly op: "eq" | "gte" | "lte";
      readonly n: number }
  | { readonly kind: "route-matches"; readonly route: RouteId }
  | { readonly kind: "settled" }
  | { readonly kind: "native-dialog"; readonly dialogType?: "alert" | "confirm" | "prompt" }
  | { readonly kind: "continuity"; readonly ref: string; readonly scope?: ContainerMatcher };

/**
 * `NodeQuery` is EXISTENTIAL and has no quorum: it is how a detector asks "is something like this on
 * screen". It is a DIFFERENT TYPE from `TargetRef`, which requires a quorum and is how a step says
 * "act on exactly this". Keeping the two apart is what stops a detector's looseness leaking into an
 * action.
 */
export interface NodeQuery {
  readonly scope?: ContainerMatcher;
  readonly role?: Role;
  readonly name?: TextMatcher;
  readonly text?: TextMatcher;
  readonly state?: Partial<NodeState>;
  /** Row-and-column addressing keyed by VALUES, never indices - so READING a cell is as precise as
   *  clicking one. Without it, extraction on a legacy accounts grid degrades to "some cell in this
   *  table", which is how a checking balance gets reported as a savings balance. */
  readonly cell?: { readonly table: ContainerMatcher; readonly rowKey: RowKey;
                    readonly columnHeader: TextMatcher };
}

export interface RowKey { readonly columnHeader: TextMatcher; readonly value: ValueRef }
```

```ts
/** The step's half of an outcome: the detector, linked to a contract `OutcomeDecl` by `code`. */
export interface OutcomeRule {
  readonly code: string;                          // must name a declared OutcomeDecl (check 8)
  readonly detect: Predicate;
  /** Lower wins. Unique within a step's own declared rules (check 9). A tie that survives - because
   *  an ambient rule or an overlay-added rule reached this step - is `ambiguous-classification`,
   *  a hard stop. §4.6. */
  readonly priority: number;
  /** Outcomes default to `post`: a MEMBER_NOT_FOUND detector must not fire BEFORE the search that
   *  would produce it, and a stale banner from a previous submit must not be read as this step's
   *  answer. */
  readonly phase: "post";
  /** Literal `true`, NOT CONFIGURABLE. Rule 3 of §0: no negative outcome against an unsettled
   *  surface. This is the one structural defence any of the three proposals had against a false
   *  MEMBER_NOT_FOUND on a half-painted page, and [spike, terminal §4] measured the torn read that
   *  vindicates it: a snapshot taken after 120 ms of silence mid-repaint yielded screenId `null`
   *  and 3 nodes instead of 8. */
  readonly requiresSettled: true;
  /** The other half of `OutcomeDecl.origin`; check 8 requires the two to agree per code, and
   *  check 29 demands a `promotions[]` receipt for every `reviewer-authored` one. */
  readonly origin: "synthesized" | "hand-authored" | "reviewer-authored";
  /** Extraction for the outcome's OWN payload, read from the SAME observation that matched. */
  readonly capture: readonly ExtractSpec[];
}

export interface RecoveryRule {
  readonly name: string;                          // "DISMISS_KEEPALIVE_DIALOG"
  readonly band: "environment" | "interception" | "recoverable";
  readonly detect: Predicate;
  readonly priority: number;
  /** Recoveries default to `both`: a session-expiry banner already on screen when the step begins
   *  must be handled, not clicked through. */
  readonly phase: "pre" | "post" | "both";
  readonly remedy: Remedy;
  readonly maxAttempts: number;
  /** Only `band: "environment"` may set this true (invariant 5). An error page is WHY the surface
   *  will never settle, so an environment detector must be able to fire on an unsettled screen. */
  readonly allowUnsettled: boolean;
  /** The ONLY legal value. Present as a field so the constraint is visible in the artifact a human
   *  reviews rather than buried in engine source: a remedy can never set the program counter. */
  readonly afterRemedy: "reverify";
  readonly resume: "retry-step" | "restart-from-checkpoint" | "restart-program" | "escalate";
  readonly resumeAt?: StepId;                     // required for restart-from-checkpoint
}

export type Remedy =
  | { readonly kind: "actions"; readonly instructions: readonly RemedyInstruction[] }  // <= 4
  | { readonly kind: "dismiss-native-dialog"; readonly accept: boolean }
  | { readonly kind: "reauthenticate" }           // delegated to the session broker; §7.6
  | { readonly kind: "escalate"; readonly reason: string; readonly brief: string };
/**
 * THERE IS NO `wait` REMEDY. Transient slowness needs no remedy - it is the settle budget doing its
 * job. "Wait and retry" is the degenerate recovery rule that becomes an unbounded retry loop in
 * every system that permits it, and stacking a 5000 ms wait remedy on a step that already declares
 * `settle.maxWaitMs: 12000` gives one step two independent waiting knobs and 22 seconds of stall.
 * `SettlePolicy` is the only way to express waiting.
 */

/** A remedy may only clear an obstacle and hand control back. Note what is absent: no read, no
 *  extract, no assert, no nested recovery, no outcome. A remedy cannot bind a value, cannot
 *  classify, and cannot recurse. */
export type RemedyInstruction =
  | { readonly kind: "activate"; readonly target: TargetRef }
  | { readonly kind: "pressKey"; readonly target: TargetRef | null; readonly key: ArtifactKey }
  | { readonly kind: "setToggle"; readonly target: TargetRef; readonly checked: boolean }
  | { readonly kind: "select"; readonly target: TargetRef; readonly option: TextMatcher }
  | { readonly kind: "fill"; readonly target: TargetRef; readonly value: ValueRef }
  | { readonly kind: "navigate"; readonly route: RouteId };

export interface SettlePolicy {
  readonly stableSamples: number;                 // default 2; a default to TUNE against the corpus
  readonly pollIntervalMs: number;                // default 150
  readonly maxWaitMs: number;                     // default 8000
  /** Declared busy indicators: while any matches, we are not settled regardless of digest. Exists
   *  because a legacy app that swaps a frame's contents can be digest-stable for one poll interval
   *  mid-swap. */
  readonly busyWhen?: Predicate;
}

export interface StepBudgets {
  readonly perRecoveryMaxAttempts: Readonly<Record<string, number>>;
  /** Total remedies applied to THIS step across all recoveries. Separate from the per-recovery
   *  budget because two recoveries can ping-pong (dismiss dialog → triggers reload → triggers
   *  dialog) with neither exceeding its own. */
  readonly maxRemediationCycles: number;
}

export interface RunBudgets {
  readonly maxActions: number;
  readonly maxObservations: number;
  readonly maxTotalRemediations: number;
  readonly maxProgramAttempts: number;            // default 1 (restart off)
  readonly deadlineMs: number;
}

export interface ExtractSpec {
  readonly output: string;                        // must name a declared contract output or payload field
  readonly from: ExtractorId;
  readonly where: NodeQuery;
  readonly parse: ParserId;
  readonly normalize: NormalizerId;
  /** Default "fail". Returning `{ balance: null }` to an agent is how a member is told their balance
   *  is nothing. A missing required output is `output-extraction-failed`, not a partial success. */
  readonly onMissing: "fail" | "null";
  /** readTable only. `onTruncate` defaults to "fail": silent truncation of a member's share list is
   *  exactly the quiet wrongness this design exists to prevent. */
  readonly rows?: { readonly minRows: number; readonly maxRows: number;
                    readonly onTruncate: "fail" };
}
```

```ts
export interface EffectSummary {
  readonly maxEffect: EffectClass;
  readonly irreversibleSteps: readonly StepId[];
  readonly routesTouched: readonly RouteId[];
  readonly reads: readonly { readonly field: string; readonly sensitivity: Sensitivity }[];
  readonly requiresApproval: boolean;
  /** Largest pc from which a program restart is still safe: steps[0..pc-1] contains no
   *  WRITE_IRREVERSIBLE. Computed STATICALLY before the first action, because the program is
   *  straight-line. This is the clearest case in the design of a refusal (no branching) buying a
   *  safety property (a provable restart gate). */
  readonly restartSafeUpToPc: number;
}

export interface Verification {
  readonly mode: "replay-full" | "replay-dry" | "replay-reset";
  readonly status: "verified" | "unverified";
  /** For replay-dry: the last step actually executed before the irreversible boundary. */
  readonly coveredThroughStep: StepId;
  /** The grade an approver MUST read. `partial-*` is not a lesser bug; it is a different claim, and
   *  flattening it into a boolean `verified` would hide exactly the risk the gate exists to weigh. */
  readonly grade: "full" | "partial-up-to-irreversible";
  readonly runId: RunId;
  readonly at: Timestamp;
}

export interface Provenance {
  readonly discoveryRunId: RunId;
  /** The goal, PARAMETERIZED: "look up member {memberId} and read their current savings balance".
   *  The same mechanism that makes the capability reusable makes the provenance safe to commit -
   *  the goal string is one of the easiest places to accidentally persist a real member number, and
   *  here it structurally cannot hold one. */
  readonly goalTemplate: string;
  readonly model: { readonly adapter: "anthropic" | "openai" | "agent-sdk" | "replay";
                    readonly modelId: string; readonly promptVersion: string };
  /** A POINTER, never the transcript. The brief requires the artifact be decoupled from the raw
   *  transcript, and an embedded one is also an unbounded PII surface. */
  readonly transcriptRef: { readonly digest: Digest; readonly uri: string } | null;
  readonly recordedAt: Timestamp;
  readonly recordedAgainst: { readonly tenantId: TenantId; readonly appInstanceId: AppInstanceId;
                              readonly fingerprint: SurfaceFingerprint };
}

export interface Lifecycle {
  readonly status: "proposed" | "draft" | "approved" | "deprecated";
  readonly supersedes: number | null;
  readonly approval: {
    readonly approvedBy: string; readonly approvedAt: Timestamp;
    readonly signature: string; readonly keyId: string; readonly alg: "ed25519";
    /** Signs the DIGEST, not the file. An approved artifact cannot be silently edited. */
    readonly over: Digest;
    /** The human ticked these. "Who approved the irreversible one" is an audit answer. */
    readonly acknowledgedEffects: readonly EffectClass[];
    readonly acknowledgedGrade: Verification["grade"];
    /** Same move, third instance: the approver ticks each reviewer-authored outcome code by hand
     *  and `approve()` refuses on mismatch in both directions. A detector a human wrote is the one
     *  thing in the document that no replay established. */
    readonly acknowledgedPromotions: readonly string[];
  } | null;
}

export interface PolicyRequirements {
  readonly originAliases: readonly string[];
  readonly maxEffect: EffectClass;
  readonly requiresApprovalToken: boolean;        // derived; must match the steps (invariant 9)
  readonly redaction: { readonly taintedParams: readonly string[];
                        readonly maskScreenshotRegions: boolean };
}

/** Structural skeleton hash per step: the multiset of (ariaRole, containerPath, name-shape) over
 *  INTERACTIVE nodes plus the screen/route id, deliberately EXCLUDING the branding band.
 *  [spike, terminal §3.4] What you fingerprint matters: the same two tenants diverged 63% over all
 *  nodes and 40% over interactive nodes only. */
export interface SurfaceFingerprint { readonly perStep: Readonly<Record<StepId, string>> }

export interface Signature { readonly over: Digest; readonly by: string; readonly alg: "ed25519";
                             readonly sig: string; readonly at: Timestamp }
```

### 2.5 The overlay document - per-tenant, additive, non-semantic

```ts
/**
 * The rule that makes multi-tenancy safe is one sentence:
 *
 *     AN OVERLAY MAY NOT CHANGE WHAT A CAPABILITY MEANS.
 *
 * Not the contract, not an outcome CODE, not an effect class, not a step's instruction, not the
 * step order, not a checkpoint predicate. An overlay may change how a control is FOUND, what a
 * label is called locally, how long to wait, where the app is mounted, and it may ADD recoveries.
 * A per-tenant file that can change what a capability does is a supply-chain hole reviewed to a
 * config file's standard.
 */
export interface CapabilityOverlay {
  readonly schemaVersion: "capability.overlay/v1";
  readonly appliesTo: { readonly artifactId: ArtifactId;
                        readonly version: { readonly min: number; readonly max?: number } };
  readonly tenantId: TenantId;
  readonly appInstanceId: AppInstanceId;

  /** Host mapping per origin alias: "corebank" → "https://riverbend-cb.example.invalid". */
  readonly originAliases: Readonly<Record<string, string>>;

  /**
   * Route BASE PATH only - a prefix, never the path template. This covers the real case (the same
   * vendor product mounted at /cb here and /corebank there) without letting an overlay retarget
   * where a `navigate` goes, which would be a semantic change in the one document reviewed to a
   * config-file standard.
   */
  readonly routeBasePath?: Readonly<Record<RouteId, string>>;

  /** THE HINGE. Replaces a token's synonym list wholesale. One entry usually fixes a whole tenant,
   *  and because descriptors, detectors, row keys and checkpoints all reference the same token, one
   *  edit reaches all of them. */
  readonly vocabulary?: Readonly<Record<LabelToken, readonly string[]>>;

  /** Branding words removed by `std.label@1` before comparison, per tenant. */
  readonly stripTokens?: readonly string[];

  readonly steps?: Readonly<Record<StepId, StepOverride>>;

  /** ADD-only, and RECOVERIES only. The type has no slot for an outcome: adding an outcome would
   *  widen the union every caller switches on, and a caller compiled against
   *  MEMBER_NOT_FOUND | MEMBER_RESTRICTED must not silently receive a third value at Summit and not
   *  at Riverbend. A genuinely unique tenant answer is a contract bump for everyone - visible,
   *  reviewed, and correct. §12 accepts the cost. */
  readonly addRecoveries?: Readonly<Record<StepId, readonly RecoveryRule[]>>;

  readonly digest: Digest;
}

export interface StepOverride {
  /**
   * ADD a descriptor rather than editing the base one. A base descriptor that no longer resolves
   * simply ABSTAINS, and that abstention is recorded permanently in the fingerprint - which is a
   * visible record of divergence. An overlay that EDITED the base would erase the very signal the
   * fingerprint exists to produce, and would make the approval signature over the base digest a
   * signature over something the tenant never runs.
   */
  readonly addDescriptors?: readonly Descriptor[];
  /**
   * Mark a base descriptor as abstaining at this tenant. This is how the one thing an add-only
   * overlay otherwise cannot repair gets repaired: an `ordinal-in-container index: 1` on a nav bar
   * that gained a tab is permanently ambiguous, and no amount of adding fixes it. Disabling is
   * recorded in the fingerprint exactly like an abstention, and check 11 still requires the
   * surviving set to meet quorum.
   */
  readonly disableDescriptors?: readonly string[];      // descriptor ids
  readonly settle?: Partial<SettlePolicy>;
  readonly budgets?: Partial<StepBudgets>;
  /** Only the `headerProvenance` correction: a tenant whose grid DOES emit `columnheader` roles, or
   *  one where row 0 is a filter bar and the heuristic guessed wrong. Browser spike §5.2. */
  readonly tableHeaders?: Readonly<Record<string, readonly string[]>>;
}

/** Deterministic, total, pure. The merged result gets its own digest, and the run journal records
 *  it alongside the base - "which bytes actually ran" must be answerable after the fact in a
 *  regulated environment, and base ⊕ overlay means the base digest alone does not answer it. */
export declare function resolve(
  base: CapabilityArtifact, overlay: CapabilityOverlay | null,
): { readonly resolved: CapabilityArtifact; readonly effectiveDigest: Digest };
// effectiveDigest = sha256(artifactDigest ‖ overlayDigest ‖ linkerVersion)
```

### 2.6 The replay result contract

This is the load-bearing agent-facing type. The assignment names the replay contract as central; the
spine proposal's `outcome.code: string` + `data: Record<string, unknown>` is the one place it was
weakest, and it does not ship.

```ts
export interface Invocation<C extends CapabilityContract> {
  /**
   * Exact pin, INCLUDING the contract digest the caller's generated types were built from.
   * This closes the one silent-degradation hole in the typed-outcome mechanism: if the generated
   * `.d.ts` is stale, or `C["outcomes"]` widened to `readonly OutcomeDecl[]` instead of a literal
   * tuple, the exhaustive `switch` quietly becomes a string comparison and the runtime can hand a
   * caller an outcome its types have never heard of. The host compares this digest against the
   * contract it loads and returns `failed / contract-stale` - a LOUD failure at exactly the moment
   * the type-level mechanism would otherwise fail silently.
   */
  readonly capability: { readonly name: C["name"]; readonly version: ContractVersion;
                         readonly contractDigest: Digest };
  readonly tenant: { readonly tenantId: TenantId; readonly appInstanceId: AppInstanceId };
  readonly args: ArgsOf<C>;

  /** Caller-supplied dedupe key. The host returns the PRIOR RESULT for a repeat key rather than
   *  re-driving the UI. Exists because retries at the agent layer are inevitable and a retried
   *  WRITE against a legacy screen is how a member gets two sub-accounts. */
  readonly idempotencyKey?: string;

  /**
   * What THIS caller can tolerate when the run gets stuck. A batch job says "fail" and goes home;
   * a live conversational turn says "suspend" and picks the run back up. The engine must not guess
   * this, because the right answer depends entirely on who is waiting.
   */
  readonly onIntervention: "suspend" | "fail";

  readonly budget?: { readonly wallClockMs: number; readonly maxRemediations: number };
  readonly correlation: { readonly agentSessionId: string;
                          readonly requestedBy: "agent" | "human" | "schedule" };
}

/** The low-level policy approval grant is required BY THE TYPE when the capability is irreversible,
 *  and forbidden when it is not. The runtime mints that grant only after rich invocation approval
 *  verifies at the irreversible dispatch boundary. */
export type WithApproval<C extends CapabilityContract> =
  C["requiresApproval"] extends true
    ? Invocation<C> & { readonly approval: ApprovalToken }
    : Invocation<C> & { readonly approval?: never };

/** `invoke` NEVER REJECTS. No thrown outcome, no thrown failure, no thrown validation error. A
 *  rejected promise from `invoke` is a bug in the host. The caller is frequently an LLM harness, and
 *  a thrown exception at a tool boundary is a crash the model cannot see, reason about, or report
 *  honestly to a member. */
export declare function invoke<C extends CapabilityContract>(
  contract: C, inv: WithApproval<C>,
): Promise<ReplayResult<C>>;
```

```ts
export type ReplayResult<C extends CapabilityContract> =
  | ReplayOk<C> | ReplayOutcomeArm<C> | ReplaySuspended<C> | ReplayFailed;

/**
 * Carried IDENTICALLY by all four arms. The temptation is to make failures verbose and successes
 * terse; but the run you most want a trace for is the one that returned `ok` and should not have,
 * and `StepTrace.resolution` on a successful run is how a silently degrading descriptor becomes
 * visible before it becomes an incident.
 */
export interface RunEnvelope {
  readonly runId: RunId;
  readonly capability: { readonly name: CapabilityName; readonly version: ContractVersion };
  readonly artifact: { readonly artifactId: ArtifactId; readonly version: number;
                       readonly digest: Digest; readonly overlayDigest: Digest | null;
                       /** sha256(artifactDigest ‖ overlayDigest ‖ linkerVersion). THIS, not the base
                        *  digest, is what a postmortem needs. */
                       readonly effectiveDigest: Digest };
  readonly tenant: { readonly tenantId: TenantId; readonly appInstanceId: AppInstanceId };
  readonly surface: SurfaceKind;
  readonly engineVersion: string;
  readonly startedAt: Timestamp;
  readonly endedAt: Timestamp;
  readonly durationMs: number;
  readonly stepsExecuted: number;
  readonly stepsTotal: number;

  readonly budgets: Readonly<Record<"actions" | "observations" | "remediations" | "programAttempts"
                                    | "wallClockMs", { readonly used: number; readonly limit: number }>>;

  /** Every recovery that fired, whether or not it helped. Silent recoveries are how a system rots
   *  quietly: the interstitial that appears on 3% of runs today appears on 40% next quarter, and
   *  nobody notices because the runs still pass. */
  readonly recoveriesApplied: readonly { readonly stepId: StepId; readonly name: string;
                                         readonly attempts: number;
                                         readonly result: "cleared" | "exhausted" }[];

  /** Who actually performed the work, and which steps a human owned. */
  readonly attribution: { readonly by: "automation" | "human-assisted";
                          readonly transfers: readonly ControlTransfer[] };

  /** One entry per step ATTEMPT, including retried attempts. The debug story. */
  readonly steps: readonly StepTrace[];

  /** Present on EVERY arm including `ok`. Drift is a signal, never a verdict. */
  readonly drift: DriftSignal;

  readonly evidence: readonly EvidenceRef[];
  readonly journalRef: EvidenceRef;
  /** Non-fatal integrity warnings, e.g. a base descriptor that has been abstaining for a month. */
  readonly warnings: readonly RunWarning[];
}

export interface ReplayOk<C extends CapabilityContract> {
  readonly status: "ok";
  /** TOTAL or it is not `ok`. There is no partial success: a run that reached the checkpoint but
   *  could not extract a required output is `failed / output-extraction-failed`. A caller that
   *  receives `ok` must be able to use the outputs without checking each one, or the type has
   *  bought nothing. */
  readonly outputs: OutputsOf<C>;
  readonly run: RunEnvelope;
}

/**
 * A DECLARED business outcome. Distributive over the contract's outcome tuple, so `switch (r.outcome)`
 * narrows `r.data` to that outcome's own payload.
 *   · it is a different ARM of the union than `failed`, with a different discriminant;
 *   · there is no `error` field anywhere on it to read;
 *   · the engine reaches it by a RETURN, never a throw, so no catch block can ever observe it;
 *   · its code is a literal type from the contract, so the switch is exhaustive and adding an
 *     outcome is a compile error at every existing call site.
 */
export type ReplayOutcomeArm<C extends CapabilityContract> =
  C["outcomes"][number] extends infer O
    ? O extends OutcomeDecl
      ? {
          readonly status: "outcome";
          readonly outcome: O["code"];
          readonly data: FieldsOf<O["payload"]>;
          readonly terminal: true;
          readonly callerAction: O["callerAction"];
          readonly retryable: O["retryable"];
          /** Copied verbatim from the reviewed OutcomeDecl. The agent may quote it; it did not
           *  invent it, and it was not generated at render time. */
          readonly guidance: string;
          /** Which step produced it and which rule matched, so a WRONG outcome is debuggable. */
          readonly detectedAt: { readonly stepId: StepId; readonly stepIndex: number;
                                 readonly priority: number };
          /** Rules that also matched but lost on priority. Empty is normal; non-empty is a quiet
           *  warning that this step's taxonomy is getting muddy. */
          readonly alsoMatched: readonly { readonly code: string; readonly priority: number }[];
          readonly run: RunEnvelope;
        }
      : never
    : never;

/** Automation stopped and a human was asked to take the live session. NOT TERMINAL. */
export interface ReplaySuspended<C extends CapabilityContract> {
  readonly status: "suspended";
  readonly intervention: {
    readonly id: InterventionId;
    readonly reason: SuspensionReason;
    readonly atStep: StepId;
    /** One sentence an operator can triage from without opening anything. */
    readonly summary: string;
    readonly consoleUrl: string;
    /** After this the lease expires and the run converts to `failed`. Sessions do not wait forever. */
    readonly expiresAt: Timestamp;
  };
  readonly resume: { readonly token: LeaseToken; readonly pollAfterMs: number };
  /** Everything already extracted and validated. Usually enough for the agent to say something TRUE
   *  ("I found your account, I'm checking the balance") instead of something vague. */
  readonly partialOutputs: Partial<OutputsOf<C>>;
  readonly run: RunEnvelope;
}

export type SuspensionReason =
  | "unclassified-state" | "recovery-exhausted" | "approval-required"
  | "target-ambiguous" | "target-underdetermined" | "session-lost" | "effect-in-doubt";

export interface ReplayFailed {
  readonly status: "failed";
  readonly failure: {
    readonly class: FailureClass;
    readonly atStep: StepId | null;               // null for pre-flight
    readonly stepIndex: number | null;

    /**
     * THE FIELD A CALLER SHOULD NOT HAVE TO INFER. In a regulated environment "we definitely did
     * not touch anything" is a materially different answer from "we stopped partway", and
     * "an irreversible action was dispatched and we never saw its result" is a third thing again.
     *   none-guaranteed → link-error, argument-invalid, contract-stale, policy-denied pre-flight.
     *   possible        → we stopped partway; reversible or read work may have happened.
     *   in-doubt        → an irreversible action was dispatched and its result was never observed.
     *                     Go reconcile against the system of record. NEVER retry.
     */
    readonly sideEffects: "none-guaranteed" | "possible" | "in-doubt";

    /** GENERATED by a fold over the declared predicate and target - never hand-authored, never
     *  carrying a parameter VALUE. `param.memberId` renders as `param.memberId`; a template hole
     *  renders as `{memberId}`. §4.7. */
    readonly expected: ExpectationTrace;
    /** What was actually there, redacted per taint before it is written anywhere. */
    readonly observed: ObservedSummary;
    /** For target-ambiguous / underdetermined: every candidate, per descriptor, with each
     *  descriptor's evidence source and verdict. */
    readonly candidates?: readonly TargetCandidate[];
    readonly attempts: readonly { readonly recoveryId: string; readonly attempts: number;
                                  readonly lastSkeletonDigest: string }[];
    /**
     * 'same-inputs'        → transient; the agent may retry now.
     * 'after-human-action' → a person must change the environment first (entitlement, data fix).
     * 'no'                 → do not retry. Includes every `effect-in-doubt`.
     */
    readonly retriable: "same-inputs" | "after-human-action" | "no";
    /** One line telling a human what to actually do. Derived from the class, not free text. */
    readonly operatorAction: string;
    readonly escalation?: { readonly interventionId: InterventionId; readonly raisedAt: Timestamp;
                            readonly state: "open" | "resolved" | "abandoned" };
    /**
     * The frozen Observation that produced this verdict, by reference. This is the file that turns
     * a production failure into a `classify()` unit test with NO reproduction step: no browser, no
     * fixture, no session. It is the practical payoff of designing the classifier for purity rather
     * than merely claiming it.
     */
    readonly observationRef: EvidenceRef;
  };
  readonly run: RunEnvelope;
}

/**
 * Closed. Each member exists because it implies a DIFFERENT HUMAN ACTION - that is the admission
 * test, and it is why there is no UNKNOWN_ERROR.
 */
export type FailureClass =
  // zero actions performed, guaranteed
  | "link-error" | "argument-invalid" | "contract-stale" | "artifact-invalid"
  // pre-act gates
  | "precondition-not-met" | "policy-denied" | "approval-required" | "lease-lost"
  // targeting
  | "target-not-found" | "target-ambiguous" | "target-underdetermined" | "target-assert-failed"
  // acting and verifying
  | "action-rejected" | "no-observable-effect" | "checkpoint-failed" | "continuity-broken"
  | "output-extraction-failed"
  // environment
  | "undeclared-dialog" | "session-expired-unrecoverable" | "entitlement-denied" | "app-error"
  | "did-not-settle" | "surface-error"
  // taxonomy and budget
  | "ambiguous-classification" | "recovery-exhausted" | "budget-exhausted"
  // the one that must never be retried
  | "effect-in-doubt"
  // "a system that cannot say 'I am broken' says 'you are' instead"
  | "internal-invariant";

export interface StepTrace {
  readonly stepId: StepId;
  readonly attempt: number;
  readonly verdict: Verdict;                      // the classifier's own output, verbatim
  readonly skeletonDigest: string;
  readonly observationRef: EvidenceRef | null;
  readonly elapsedMs: number;
  /** Which descriptors resolved to what, and by which evidence source. Present even on SUCCESS. */
  readonly resolution?: readonly { readonly descriptorId: string; readonly kind: DescriptorKind;
                                   readonly evidenceSource: EvidenceSource;
                                   readonly verdict: DescriptorVerdict;
                                   readonly resolvedNodeId: NodeId | null }[];
}

export type DescriptorVerdict = "resolved" | "abstained" | "non-unique" | "disabled" | "disagreed";

export interface DriftSignal {
  readonly fingerprint: string;
  readonly expected: string;
  readonly divergence: number;                    // 0..1, share of descriptor verdicts that changed
  readonly changed: readonly { readonly stepId: StepId; readonly descriptorId: string;
                               readonly was: DescriptorVerdict; readonly now: DescriptorVerdict }[];
  /** Crossing the threshold means "this tenant has diverged enough to need its own overlay", NOT
   *  "this run failed". Nothing automatically acts on it. */
  readonly needsSpecialization: boolean;
}
```

**The type mappers.**

```ts
export type TsTypeOf<T extends ValueType> =
  T extends { kind: "string" }  ? string  :
  T extends { kind: "integer" } ? number  :
  T extends { kind: "boolean" } ? boolean :
  T extends { kind: "enum"; values: readonly (infer V)[] } ? V :
  T extends { kind: "money" }   ? Money   :
  T extends { kind: "decimal" } ? Decimal :
  T extends { kind: "date" }    ? string  :
  T extends { kind: "table" }   ? readonly Readonly<Record<string, string>>[] :
  never;

export type FieldsOf<S extends readonly FieldSpec[]> = {
  readonly [F in S[number] as F["name"]]:
    F["required"] extends true ? TsTypeOf<F["type"]> : TsTypeOf<F["type"]> | null
};
export type ArgsOf<C extends CapabilityContract>    = FieldsOf<C["inputs"]>;
export type OutputsOf<C extends CapabilityContract> = FieldsOf<C["outputs"]>;
```

`pnpm codegen` emits, per approved contract, a `.d.ts` declaring the contract `as const` plus its
`contractDigest`, so these mappers resolve to literal types at the call site. The digest pin in
`Invocation` is what makes the mechanism fail loudly rather than silently when the generated file is
stale.

### 2.7 The agent-facing projection - two audiences, one result

`ReplayResult` is for a **program**. A model does not receive a discriminated union; it receives
text. So the host renders a second, deliberately **poorer** view.

```ts
export interface AgentToolResult {
  /** Four values, and "outcome" is not a synonym for "error". The model reads this first. */
  readonly status: "ok" | "outcome" | "pending" | "error";
  readonly outcome?: string;
  readonly data?: Readonly<Record<string, unknown>>;
  /** Reviewed guidance from the contract, or a static per-FailureClass table. Never generated. */
  readonly guidance: string;
  readonly retryable: "never" | "after_delay" | "with_different_inputs";
  readonly runId: string;
  /** For "error"/"pending": the string a member can quote to a human. */
  readonly reference?: string;
}

export declare function renderForAgent<C extends CapabilityContract>(
  r: ReplayResult<C>, c: C,
): AgentToolResult;
```

What it **removes**, and why:

- **Step ids, descriptors, `expected`/`observed`, observation digests, drift, budgets.** A model
  handed a locator will try to route around it, and a model handed "expected heading Member Detail"
  will try to navigate there directly. Diagnostics are for the operator console and the journal.
- **`suspended` becomes `pending`.** The model has no session; from its side the run has not
  finished. Same fact, the model's vocabulary.
- **Outputs whose `agentDisclosure` is `mask` or `withhold`.** The tool result is a persisted
  artifact under BRIEF §10 and lands in a third-party transcript. This is the control that stops
  "taint governs persistence, not delivery" from quietly meaning "regulated data leaves the
  perimeter". `ReplayOk.outputs` handed to the calling *program* is unmasked; the model's view is not.
- **Nothing is added.** `guidance` is copied, never generated at render time. The playbook for "the
  member does not exist" was reviewed by a person once; it is not re-derived on every call by the
  thing most likely to get it wrong.

### 2.8 Policy types

```ts
/** ONE chokepoint. Every action, in BOTH discovery and replay, passes through this and nothing
 *  else. Pure: no I/O, no clock. A contract test fails if any `Surface.act` call site in the repo
 *  is not immediately preceded by a `PolicyEngine.check` on the same action. */
export declare function check(action: Action, ctx: PolicyContext): PolicyDecision;

export interface PolicyContext {
  readonly mode: "discovery" | "replay" | "operator";
  readonly allowlist: Allowlist;
  /** The RESOLVED step (post-overlay, post-binding), or null during free discovery. */
  readonly step: ResolvedStep | null;
  /** Where the action would land, canonicalized by the driver before the check. */
  readonly route: { readonly originAlias: string; readonly path: string } | null;
  readonly effect: EffectClass;
  readonly lease: LeaseSnapshot;
  readonly approval: ApprovalToken | null;
  readonly artifact: { readonly lifecycle: Lifecycle["status"]; readonly digestVerified: boolean } | null;
  /** Values bound to sensitive params, as OPAQUE HANDLES. The policy engine can tell that an action
   *  carries tainted text without ever holding the text. */
  readonly taint: readonly TaintHandle[];
}

export interface Allowlist {
  readonly originAliases: readonly string[];
  /** Route patterns, never hosts-as-strings - so "the allowlist" survives a tenant on a different
   *  host and cannot be satisfied by a lookalike domain. */
  readonly routes: readonly { readonly originAlias: string; readonly pathPattern: string;
                              readonly maxEffect: EffectClass }[];
  readonly actionKinds: readonly Action["kind"][];
  readonly maxEffect: EffectClass;
  /** Discovery only: the model may not act outside these even before an artifact exists. */
  readonly discoveryMaxEffect: EffectClass;
}

export type PolicyDecision =
  | { readonly allow: true; readonly effect: EffectClass; readonly ruleId: string }
  | { readonly allow: false; readonly reason: PolicyDenialReason; readonly ruleId: string;
      readonly detail: string };

export type PolicyDenialReason =
  | "origin-not-allowed" | "route-not-allowed" | "action-kind-not-allowed"
  | "effect-exceeds-allowlist" | "effect-exceeds-artifact"
  | "irreversible-requires-approval" | "artifact-not-approved" | "artifact-digest-mismatch"
  | "lease-not-held" | "tainted-value-to-disallowed-sink";

/** Action risk classes are DECLARED on the step and re-derived by the linker from the instruction
 *  kind and the route's declared maxEffect. Where the two disagree, the HIGHER wins and the linker
 *  reports it. §12 accepts that `effect` is ultimately declared, not proven. */
export type TaintHandle = Branded<string, "TaintHandle">;
```

### 2.9 Session, lease, and intervention types

```ts
export type Controller = "automation" | "human";

/** A session has EXACTLY ONE controller, held under a lease. The executor rejects actions from a
 *  non-holder - enforcement, not convention - and so does the DRIVER, because `Surface.act` takes
 *  the token (§2.2). Two gates, because the interesting failure is an automation run that thinks it
 *  still holds a session a human has taken. */
export interface Lease {
  readonly sessionId: string;
  readonly token: LeaseToken;
  readonly holder: Controller;
  readonly actorId: string;                       // "run:<runId>" or "operator:<id>"
  readonly acquiredAt: Timestamp;
  readonly expiresAt: Timestamp;
  /** Monotonic. Every acquire increments it; a token minted under an older epoch is dead even if
   *  its string was somehow replayed. */
  readonly epoch: number;
}

export type LeaseSnapshot = Pick<Lease, "holder" | "actorId" | "epoch" | "expiresAt">;

export interface ControlTransfer {
  readonly at: Timestamp;
  readonly from: Controller;
  readonly to: Controller;
  readonly actorId: string;
  readonly interventionId: InterventionId | null;
  /** What the human did, attributed. Titles only - never values, never coordinates. */
  readonly actionsPerformed: readonly { readonly kind: Action["kind"];
                                        readonly targetTitle: string }[];
}

export interface Intervention {
  readonly id: InterventionId;
  readonly runId: RunId;
  readonly sessionId: string;
  readonly reason: SuspensionReason;
  readonly raisedAt: Timestamp;
  readonly expiresAt: Timestamp;
  readonly state: "open" | "claimed" | "resolved" | "abandoned" | "expired";

  /** EVERYTHING a human needs to act, on one screen, without opening anything else. This is the
   *  "route an intervention request with context" requirement made concrete. */
  readonly brief: {
    readonly capabilityTitle: string;
    readonly goalTemplate: string;                // parameterized, never a member number
    readonly stepIndex: number;
    readonly stepTitle: string;
    readonly whatWasExpected: ExpectationTrace;   // generated
    readonly whatWasObserved: ObservedSummary;    // redacted
    readonly evidence: EvidenceRef | null;        // masked screenshot or masked grid dump
    readonly whyStopped: string;                  // from the FailureClass table, not free text
    readonly suggestedAction: string;
  };

  /** Presenting this token resumes THIS run at THIS step - which then re-verifies its precondition
   *  rather than blindly continuing. §7.4. */
  readonly resumeToken: LeaseToken;
  readonly consoleUrl: string;
  readonly resolution: { readonly by: string; readonly at: Timestamp;
                         readonly disposition: "resume" | "abort" } | null;
}
```

### 2.10 Journal event types

The journal is append-only JSONL, one file per run, written by `@crr/runtime`. It is ordered by
`seq`, not by wall clock, so two replays of the same program produce comparable journals modulo the
timing fields. It is the input to the evidence bundle and to the conformance corpus.

```ts
export type JournalEvent = { readonly seq: number; readonly runId: RunId; readonly at: Timestamp }
  & JournalBody;

export type JournalBody =
  | { readonly type: "run.started"; readonly mode: "discovery" | "replay" | "verify";
      readonly capability: CapabilityName; readonly artifactDigest: Digest;
      readonly effectiveDigest: Digest; readonly tenantId: TenantId;
      readonly argsShape: Readonly<Record<string, string>> }   // SHAPES, never values
  | { readonly type: "link.completed"; readonly checksRun: number; readonly errors: readonly LinkError[] }
  | { readonly type: "session.opened"; readonly sessionId: string; readonly sessionProfile: string }
  | { readonly type: "lease.acquired"; readonly holder: Controller; readonly actorId: string;
      readonly epoch: number }
  | { readonly type: "lease.released"; readonly holder: Controller; readonly reason: string }
  | { readonly type: "step.entered"; readonly stepId: StepId; readonly index: number;
      readonly attempt: number; readonly effect: EffectClass }
  | { readonly type: "observed"; readonly stepId: StepId | null; readonly obsSeq: number;
      readonly skeletonDigest: string; readonly settled: boolean;
      readonly nodeCount: number; readonly observationRef: EvidenceRef | null }
  | { readonly type: "classified"; readonly stepId: StepId; readonly phase: "pre" | "post";
      readonly verdict: Verdict; readonly alsoMatched: readonly string[] }
  | { readonly type: "resolved"; readonly stepId: StepId;
      readonly descriptors: readonly { readonly id: string; readonly kind: DescriptorKind;
                                       readonly evidenceSource: EvidenceSource;
                                       readonly verdict: DescriptorVerdict;
                                       readonly nodeId: NodeId | null }[];
      readonly agreed: boolean; readonly distinctSources: number }
  | { readonly type: "policy.decided"; readonly decision: PolicyDecision;
      readonly actionKind: Action["kind"]; readonly effect: EffectClass }
  /** Values are NEVER journaled. A `type` action logs a taint handle and a length. */
  | { readonly type: "acted"; readonly stepId: StepId; readonly actionKind: Action["kind"];
      readonly targetTitle: string; readonly valueRef: TaintHandle | null;
      readonly valueLength: number | null; readonly result: "dispatched" | ActFault["kind"] }
  | { readonly type: "settled"; readonly stepId: StepId; readonly polls: number;
      readonly elapsedMs: number; readonly settled: boolean }
  | { readonly type: "checkpoint"; readonly stepId: StepId; readonly passed: boolean;
      readonly trace: ExpectationTrace }
  | { readonly type: "extracted"; readonly stepId: StepId; readonly output: string;
      readonly sensitivity: Sensitivity; readonly present: boolean }  // never the VALUE
  | { readonly type: "recovery.applied"; readonly stepId: StepId; readonly name: string;
      readonly attempt: number; readonly remedy: Remedy["kind"] }
  | { readonly type: "budget.charged"; readonly ledger: string; readonly used: number;
      readonly limit: number }
  | { readonly type: "intervention.raised"; readonly interventionId: InterventionId;
      readonly reason: SuspensionReason }
  | { readonly type: "intervention.resolved"; readonly interventionId: InterventionId;
      readonly disposition: "resume" | "abort"; readonly by: string }
  | { readonly type: "human.acted"; readonly actorId: string; readonly actionKind: Action["kind"];
      readonly targetTitle: string }
  | { readonly type: "restart.requested"; readonly fromPc: number; readonly gate: "passed" | "refused";
      readonly restartSafeUpToPc: number }
  | { readonly type: "evidence.captured"; readonly ref: EvidenceRef; readonly kind: "image" | "text-grid"
      | "observation"; readonly maskedRegions: number }
  | { readonly type: "run.finished"; readonly status: ReplayResult<never>["status"];
      readonly failureClass?: FailureClass; readonly outcomeCode?: string };
```

**Two journal rules that are tests, not conventions.** (1) No journal event may contain a value bound
to a `sensitive` parameter or output - a redaction test replays a run with a known canary value and
greps the whole journal, evidence directory and artifact for it. (2) Every `acted` event has a
matching preceding `policy.decided` with the same action kind at the same step; a contract test over
the journal schema plus a runtime assertion enforce it, which is how "one chokepoint" is proven
rather than asserted.

---

## 3. The step instruction set

Ten instructions. The admission criterion is that each has a **distinct postcondition the
interpreter can verify** - that is why `fill`/`select`/`setToggle` are not collapsed into one
`setValue`. An opcode with three different postconditions is an opcode that cannot be checked.

```ts
export type Instruction =
  | { readonly kind: "navigate";  readonly route: RouteId }
  | { readonly kind: "activate" }                       // click / press the control's own activator
  | { readonly kind: "fill";      readonly value: ValueRef; readonly mode: "replace" }
  | { readonly kind: "select";    readonly option: TextMatcher }
  | { readonly kind: "setToggle"; readonly checked: boolean }
  | { readonly kind: "pressKey";  readonly key: ArtifactKey }
  | { readonly kind: "read" }
  | { readonly kind: "readTable" }
  | { readonly kind: "assert" }
  | { readonly kind: "dialog";    readonly accept: boolean; readonly text: string | null };

/**
 * The ARTIFACT's key vocabulary. Note what is absent: F1-F12.
 * The Action PORT has them (§2.2) because the terminal driver emits them. The ARTIFACT does not,
 * because [spike, terminal §3.4] the Exit control is F3 at riverbend and F12 at summit while the
 * node `button:exit` is identical across both. A program that hardcodes F3 is correct at one tenant
 * and wrong at the next, and no overlay should be needed to fix a difference the driver can absorb.
 * Linker check 21 rejects an F-key in an artifact. `PageUp`/`PageDown` lower to PF7/PF8 on a grid.
 */
export type ArtifactKey =
  | "Enter" | "Tab" | "Escape" | "Backspace" | "Delete"
  | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"
  | "Home" | "End" | "PageUp" | "PageDown";
```

| Instruction | Effect | Acts? | Target | Precondition (beyond `step.precondition`) | Postcondition the interpreter verifies |
|---|---|---|---|---|---|
| `navigate` | READ or WRITE_REVERSIBLE | yes | none | route is in the allowlist; every `:param` in the pattern binds | location matches the declared route **and** `expect` |
| `activate` | any | yes | required | target resolves under quorum, passes `assert`, `state.disabled === false` | `expect` **and** `delta` |
| `fill` | any | yes | required | target role ∈ {textbox, combobox}; `state.readonly !== true`; value length ≤ `node.capacity` when the surface reports one | the target's `value` equals the written value after `normalize` **and** `expect` |
| `select` | any | yes | required | target role ∈ {combobox, listbox}; the option exists | the selected option's name matches **and** `expect` |
| `setToggle` | any | yes | required | target role ∈ {checkbox, radio} | the target's `checked` equals the declared boolean **and** `expect` |
| `pressKey` | any | yes | optional (`null` = the focused control) | key ∈ `SurfaceCapabilities.supportedKeys` | `expect` **and** `delta` |
| `read` | READ | no | none | - | every `extract` yields, parses and typechecks **and** `expect` |
| `readTable` | READ | no | none | - | row count ∈ `[minRows, maxRows]`, else `output-extraction-failed` **and** `expect` |
| `assert` | READ | no | none | - | `expect` (this instruction is nothing but a checkpoint) |
| `dialog` | any | yes | none | `Observation.nativeDialog !== null` | the dialog is gone from `nativeDialog` **and** `expect` |

**Four choices worth defending.**

- **`activate`, not `click`.** The artifact says what the operator meant; the surface says how that is
  done here. On a browser it lowers to `click`. On a character grid the synthesized button node
  carries the key from the F-key legend line, so it lowers to `pressKey(F5)` - measured [spike,
  terminal §3.2, §3.4]. This one rename is the whole cross-surface claim, and it is why the F-keys
  live at the port and not in the program.
- **`setToggle` sets a state; it does not toggle.** `toggle` is order-dependent and therefore not
  replayable: replaying it against a screen that remembered the user's last choice produces the
  opposite result. `setToggle{checked:true}` is idempotent by construction and its postcondition is
  checkable.
- **`fill` replaces; it does not append.** Appending depends on the field's prior content, which is
  exactly the hidden input a deterministic language must not have. `mode` exists so a future
  `"append"` is a schema change rather than a surprise. Typing has a *checkpoint* for a real and
  otherwise-silent reason: a legacy input with a `maxlength` or an input mask silently truncates or
  reformats what you typed, and then produces `MEMBER_NOT_FOUND` for a member who exists.
- **`readTable` is bounded iteration, and that is why it is allowed.** An `Observation` contains
  finitely many nodes; `readTable` walks that finite set once, performs no actions, and cannot
  re-observe. Iteration over *observations* - "for each row, click it and come back" - is refused,
  because that iteration is unbounded in actions and destroys the static effect analysis. Iteration
  over one observation is finite by construction; iteration over actions is not.

### 3.1 The interpreter cycle

```text
  pc ──►  step = program.steps[pc]
   │
   ├─ 1  LEASE       lease.holder === "automation" && epoch matches ?   no → lease-lost
   ├─ 2  OBSERVE     perceive({ deadlineMs })                            charges observations
   ├─ 3  CLASSIFY    classify(obs, step, bindings, phase: "pre")
   │                     outcome  → (only if the rule's phase permits pre; outcomes never do) 
   │                     recover  → run remedy (budgeted) → goto 2
   │                     fail     → terminal
   │                     none     → continue
   ├─ 4  PRECOND     eval(step.precondition, obs, bindings) ?            no → precondition-not-met
   ├─ 5  RESOLVE     resolve(step.target, obs)   ← ALL descriptors against ONE snapshot
   │                     disagree → target-ambiguous       (refuse to act)
   │                     nothing  → target-not-found
   │                     thin     → target-underdetermined
   │                     assert   → target-assert-failed   (§4.5 C1)
   ├─ 6  LOWER       action = lower(step.instruction, node, bindings)    surface-specific
   ├─ 7  POLICY      check(action, ctx) ?                                no → policy-denied
   ├─ 8  ACT         act(action, lease)                                  charges actions
   ├─ 9  SETTLE      poll perceive() until settle.stableSamples consecutive identical
   │                 skeletonDigests, or settle.maxWaitMs is spent
   ├─10  CLASSIFY    classify(obs', step, bindings, phase: "post")       ← the only place an
   │                     outcome  → TERMINAL                                outcome can be returned
   │                     recover  → remedy → re-verify this step from 2
   │                     none     → continue
   ├─11  CHECKPOINT  expect.predicate ∧ expect.delta ∧ expect.continuity ?  no → checkpoint-failed
   │                                                                          / no-observable-effect
   │                                                                          / continuity-broken
   ├─12  EXTRACT     pure read from THE SAME Observation the checkpoint verified
   └─13  JOURNAL     append; fold the fingerprint
                     pc ← pc + 1
```

Three things in that cycle are load-bearing.

**Step 5 resolves all descriptors against ONE snapshot.** If the resolver re-observed between
descriptors, two descriptors could legitimately disagree because the page changed underneath them,
and the whole quorum mechanism would be measuring latency instead of ambiguity.

**Step 12 extracts from the observation step 11 verified.** Extracting from a *later* observation
than the one you checked means you can verify the right page and read the next one. That race is
invisible in a demo and produces a wrong balance in production.

**Steps 5-8 are skipped** for `read`, `readTable` and `assert`, which go from the precondition
straight to settle. `navigate` resolves a route rather than a node.

### 3.2 There is no `sleep`, and waiting is not a recovery

Fixed delays are the largest single source of both flake and wasted wall-clock in recorded
automation, and a recorded sleep encodes the recording machine's load into the artifact forever.
Waiting is a property of a checkpoint: poll until the predicate holds or the settle budget is spent.
Transient slowness therefore needs no remedy - it *is* the settle budget doing its job.

### 3.3 Quiescence proposes; the checkpoint disposes

`settle()` is a **cheap trigger for taking an observation**, never evidence that the screen is ready.
Readiness is `expect.predicate` plus continuity. [spike, terminal §4] measured why: delivering 55% of
a repaint and then waiting 120 ms - twice the quiet window - produced a torn read with `screenId:
null` and 3 nodes instead of 8. The torn snapshot **fails the checkpoint**, which is why it is a
detected condition rather than a silent misread. A character grid has no load event to hide behind,
so it forces the checkpoint to be the real readiness gate; the browser case is the easy one.

On `maxWaitMs` exhaustion the classifier does not give up silently: it re-runs bands B1 and B2 with
`settled: false` (only detectors with `allowUnsettled: true` may fire, and an `OutcomeRule` may never
set it), and if nothing matches returns `did-not-settle` carrying the last three skeleton digests.
A spinner-forever and a 500 page are different answers, and the run says which.

**One interception short-circuits the loop, and only one.** `settle()` returns on the first poll that
sees `Observation.nativeDialog`, because a native dialog blocks the renderer and polling for
quiescence behind one is waiting on a renderer that is blocked precisely because nobody has answered
yet - the classifier needs the dialog's *message* in hand, which is the fact that decides accept
versus dismiss. An **in-page** modal blocks nothing: it is nodes in a document that is still
rendering, and it goes through the ordinary quiescence loop like every other screen.

That distinction did not exist until the §4.4 amendment, and it was harmless without it: a torn read
and a settled one produce the same verdict when the verdict is always "stop". It stopped being
harmless the moment a declared dialog became a *postcondition*, because a postcondition is checked
against a settled screen. **Measured, on a browser this time** - 18 ms after the click that raises
`fixtures/corebank-web`'s confirmation panel, one `perceive` returned the accessibility tree of the
NEW document (137 nodes, the panel among them) stitched to the frame tree of the OLD one, because the
driver reads `Page.getFrameTree` before `Accessibility.getFullAXTree` and the navigation committed in
between. `route` therefore said `/subaccount/new` on the `/subaccount/confirm` screen and the
checkpoint failed a step that had in fact succeeded. Same hazard as the terminal spike's torn
repaint, different surface, same fix: `stableSamples` consecutive identical skeletons.

### 3.4 Budgets

Three nested ledgers, all monotonically decreasing integers, all in the artifact, all passed to the
classifier as plain counters:

- **per (step, recovery)** - `perRecoveryMaxAttempts`. Stops a dismiss-loop on a dialog that returns.
- **per step** - `maxRemediationCycles`. Separate because two recoveries can ping-pong (dismiss
  dialog → triggers reload → triggers dialog) with neither exceeding its own budget.
- **per run** - `maxActions`, `maxObservations`, `maxTotalRemediations`, `maxProgramAttempts`,
  `deadlineMs`.

**No budget resets on progress within a step.** `maxRemediationCycles` resets only when the step's
checkpoint is reached and the run advances; the run ledgers never reset at all. A budget that resets
whenever "something changed" is how you build an infinite loop that reports progress the whole way.

Exhaustion is a *classification*, not a timeout: `recovery-exhausted` carries which recovery, the
attempt count, and the skeleton digest at each attempt, so "why did dismissing this dialog not work"
is answerable from the journal with no reproduction.

**Termination argument, stated so it can be checked.** `pc` strictly increases and is bounded by
`steps.length`; no instruction can lower it. Every excursion from a step is bounded by `maxAttempts`
and by the run remediation ledger. Every wait is bounded by a finite `maxWaitMs`. Every ledger
decreases monotonically and nothing refills one. Therefore every program terminates, with a typed
result. There is no code path in the interpreter that hangs - and `perceive`'s own deadline (§2.2 D6)
is what makes that true in the presence of a native dialog.

### 3.5 Effect-class interaction - the rules that stop a retry opening two sub-accounts

Checked at save time and re-checked by the linker:

- `effect: "WRITE_IRREVERSIBLE"` forces `retriable` on the step to `never`.
- A recovery on such a step may only carry a `dismiss-native-dialog` remedy, and only **before**
  dispatch.
- **Once dispatch has begun on an irreversible step, the only verdicts the classifier may return are
  terminal**: an `outcome`, `advance`, or a `fail` with `retriable: "no"`. `recover` is unreachable
  by construction, because a recovery implies a retry and a retry implies knowing the action did not
  take effect - which is precisely what is unknown.
- If the session dies or perception faults between dispatch and the post-act observation, the verdict
  is `effect-in-doubt`, `sideEffects: "in-doubt"`, `retriable: "no"`, and an intervention is raised
  automatically regardless of `onIntervention`. It did not fail and it did not succeed; the only
  correct behaviour is to stop and let a person reconcile against the system of record.

### 3.6 The one backward edge, and where it lives

The interpreter has **no** backward edge. A recovery may declare `resume: "restart-program"`, which
is not a jump: the interpreter returns `RestartRequested` to its supervisor, which discards the
machine entirely and constructs a new one at `pc = 0` with the same arguments, `attempt + 1`, and a
**freshly brokered session** - subject to two gates:

1. `budgets.maxProgramAttempts` has room, and
2. the static, pc-indexed check `steps[0..pc-1].every(s => s.effect !== "WRITE_IRREVERSIBLE")`,
   published as `EffectSummary.restartSafeUpToPc`.

Gate 2 is only possible because effects are declared statically and the program is straight-line. A
program that has already opened a sub-account cannot be restarted, and the linker can say which steps
make that true before anything runs. If the gate fails the recovery degrades to `escalate` - a human,
not a retry.

**What logs back in.** Nothing in the program does, and the program has no `secret` parameter, no
login preamble and no auth step. The **session broker** (`@crr/runtime`, §7.6) establishes an
authenticated session for `target.sessionProfile` before `pc = 0` and re-establishes it on restart.
Credentials resolve through `{ from: "credential" }` at act time, tainted, never stored, never
logged. This is the answer to "a restart into the same expired session burns its budget and fails":
the restart does not reuse the session.

### 3.7 No branching, no loops, no conditionals

Steps are a straight line; the only branch is a terminal outcome. This is the largest scope cut in
the spec and it is deliberate. Branching turns the artifact into a program, destroys the
reviewability that justifies "data, not code", and makes the totality argument much harder - but the
decisive reason is §3.6 gate 2 and §2.4 `EffectSummary`. With an `if`, "which steps are irreversible",
"what is the blast radius a human is signing", and "is a restart safe from here" all become
"somewhere between this and that, depending", and a signed approval over a digest stops meaning
anything precise.

If a flow genuinely needs a branch, that is **two capabilities** and the calling agent - already a
general-purpose branching machine - composes them. A branch is a decision, and decisions belong to
the agent. The cost is real: an optional "accept terms" screen is not really a decision, and modelling
it as a recovery is a slight abuse of the concept. §12 records it as the cut least certain.

---

## 4. The failure classifier

### 4.1 Signature and the six purity conditions

```ts
/** The entire runtime error taxonomy, as one total function. */
export declare function classify(input: ClassifierInput): Verdict;

export interface ClassifierInput {
  readonly observation: Observation;              // frozen, surface-independent, plain JSON
  /** Skeleton digests of the last N observations, newest last, supplied BY THE EXECUTOR.
   *  Quiescence is a property of a sequence, but polling is I/O: the executor polls, the classifier
   *  is handed the sequence and decides. */
  readonly recentDigests: readonly string[];
  readonly step: ResolvedStep;                    // post-overlay, post-binding, plain JSON
  readonly ambient: readonly RecoveryRule[];
  readonly phase: "pre" | "post";
  /**
   * Parameter values AND their provenance/taint. Provenance is what lets the classifier tell
   * §4.2 row 2 from row 3. Sensitive values are carried as opaque handles, so a classifier trace
   * can be logged without redaction work.
   */
  readonly bindings: ResolvedBindings;
  readonly counters: AttemptCounters;             // plain integers, incremented by the executor
  /** Elapsed wall time as a NUMBER. The only way time enters, and why `classify` has no Date.now(). */
  readonly elapsedMs: number;
  readonly actFault?: ActFault;
  readonly perceiveFault?: PerceiveFault;
  /** True once dispatch has begun on an irreversible step. Gates §3.5. */
  readonly irreversibleDispatched: boolean;
}

export type Verdict =
  | { readonly kind: "pending"; readonly reason: "not-settled"; readonly settleElapsedMs: number }
  | { readonly kind: "advance"; readonly outputs: readonly ExtractedOutput[] }
  | { readonly kind: "outcome"; readonly code: string; readonly data: readonly ExtractedOutput[];
      readonly priority: number; readonly alsoMatched: readonly { code: string; priority: number }[] }
  | { readonly kind: "recover"; readonly recoveryName: string; readonly remedy: Remedy;
      readonly attempt: number }
  | { readonly kind: "fail"; readonly failure: FailureClass; readonly detail: FailureDetail };
```

1. **Every input is serializable JSON**, so `classify` is `(json) => json` and a frozen `Observation`
   on disk is a complete test case.
2. **No clock.** `elapsedMs` is an argument; budgets compare integers.
3. **No I/O, no randomness, no driver import** - enforced by the source-scanning contract test in
   §1.3, which also fails on CSS vocabulary.
4. **No mutation.** Inputs are deep-frozen in dev builds; a property test asserts
   `deepEqual(input, structuredClone(before))` after every call.
5. **Total.** Band B6 is a built-in default that returns a `Verdict` for every input. There is no
   `undefined` return and no throw path.
6. **Deterministic.** Band order is fixed in code; within-band order is by declared `priority`;
   matcher normalization is a pure string pipeline. A property test asserts `classify(x)` twice is
   `deepEqual`.

**`advance` carries the outputs.** Extraction is a pure read from the same Observation the checkpoint
validated (§3.1 step 12) - it is not a surface operation. That makes extraction, its coercions, and
its `output-extraction-failed` path testable from the same frozen snapshot with no browser.

### 4.2 The enumeration - every condition, mapped to exactly one of {outcome, recoverable, hard failure}

This table is the design. `Band` is the precedence band from §4.3. `Decided by` says who owns it:
`schema` = the artifact author declared it, `engine` = built in and not configurable, `pre-flight` =
decided before the surface is touched at all.

| # | What happened | Disposition | Band | Class / code | Decided by |
|---|---|---|---|---|---|
| 1 | Caller's argument fails a declared param constraint | **hard failure** `argument-invalid`, `sideEffects: none-guaranteed` | - | `retriable: same-inputs` after the caller fixes the arg | pre-flight |
| 2 | Artifact/overlay/surface fails a linker check | **hard failure** `link-error`, `sideEffects: none-guaranteed` | - | - | pre-flight |
| 3 | Caller's pinned `contractDigest` ≠ the loaded contract | **hard failure** `contract-stale` | - | regenerate types | pre-flight |
| 4 | App shows a validation error and the offending value is **param-bound** | **outcome** e.g. `INVALID_MEMBER_ID` | B3 | `callerAction: retry-different-input` | schema |
| 5 | App shows a validation error and the offending value is **artifact-literal-bound** | **hard failure** | B6 | `checkpoint-failed` | engine |
| 6 | Record not found | **outcome** `MEMBER_NOT_FOUND` | B3 | `callerAction: inform-user` | schema |
| 7 | Permission denial scoped to the **record** ("this account is restricted") | **outcome** `MEMBER_RESTRICTED` | B3 | `callerAction: refer-to-specialist` | schema |
| 8 | Permission denial scoped to the **session/role** ("your role lacks OPEN_SUBACCOUNT") | **hard failure** | B1 | `entitlement-denied`, `retriable: after-human-action` | schema |
| 9 | Unexpected dialog / interstitial, **declared** | **recoverable** | B2 | remedy `actions`, budgeted | schema |
| 10 | Blocking overlay or native dialog present, **undeclared** | **hard failure** | B2 | `undeclared-dialog` | engine |
| 11 | Session expiry, a resume point exists and no irreversible step was crossed | **recoverable** | B1 | remedy `reauthenticate` + `restart-from-checkpoint` | schema |
| 12 | Session expiry, restart gate passes at pc | **recoverable** | B1 | `restart-program` (fresh brokered session) | schema |
| 13 | Session expiry, neither gate passes | **hard failure** | B1 | `session-expired-unrecoverable` | engine |
| 14 | Transient slowness | **recoverable → no remedy** | B0 | `pending` until the settle budget is spent | engine |
| 15 | Surface never settles within the budget | **hard failure** | B0 | `did-not-settle` | engine |
| 16 | App error page / 5xx / stack trace | **hard failure** (one restart only if the run's `maxEffect` is READ) | B1 | `app-error` | schema |
| 17 | Descriptors resolve to **different** nodes | **hard failure** | G, pre-act | `target-ambiguous` | engine |
| 18 | Fewer descriptors resolve than quorum requires, or too few distinct evidence sources | **hard failure** | G, pre-act | `target-underdetermined` | engine |
| 19 | No descriptor resolves | **hard failure** | G, pre-act | `target-not-found` | engine |
| 20 | Pre-act target assertion fails (role / name / rowKey mismatch) | **hard failure** | G, pre-act | `target-assert-failed` | engine |
| 21 | `perceive` exceeded its deadline (an open native dialog) | **hard failure** | B0 | `surface-error` + `undeclared-dialog` when a dialog is known | engine |
| 22 | Driver refused the action (`node-gone`, `not-actionable`, `intercepted`) | **hard failure** | post-act | `action-rejected` | engine |
| 23 | Action dispatched, no observable delta | **hard failure** | B5 | `no-observable-effect` | engine |
| 24 | Checkpoint predicate false and nothing above matched | **hard failure** | B6 | `checkpoint-failed` | engine |
| 25 | Checkpoint true but a continuity value is absent or different | **hard failure** | B5 | `continuity-broken` | engine |
| 26 | Checkpoint true, a required output is missing or untypeable, or a table read truncated | **hard failure** | post-B5 | `output-extraction-failed` | engine |
| 27 | Action or navigation outside the allowlist; irreversible without valid invocation approval | **hard failure** | G, pre-act | `policy-denied` / `approval-required` | engine |
| 28 | Human took the control lease mid-run | **hard failure** unless it is a handoff resume | G | `lease-lost` | engine |
| 29 | Entry precondition false at step 0 | **hard failure** | G | `precondition-not-met` | schema |
| 30 | Two rules match in one band with no total order | **hard failure** | any | `ambiguous-classification` | engine |
| 31 | Recovery budget exhausted | **hard failure** | B4 | `recovery-exhausted` | engine |
| 32 | Run ledger or deadline exhausted | **hard failure** | any | `budget-exhausted` | engine |
| 33 | **Irreversible action dispatched, result never observed** | **hard failure**, auto-escalate | terminal | `effect-in-doubt`, `sideEffects: in-doubt`, `retriable: no` | engine |
| 34 | The interpreter violated its own invariant | **hard failure** | any | `internal-invariant` - file a bug | engine |

Rows 4-vs-5, 7-vs-8, 15, 23, 25, 26, 30 and 33 are the rows a happy-path design silently gets wrong.

### 4.3 The four assertions in that table that are not obvious

**Rows 4 vs 5 - the same red banner means two different things.** "Member ID must be 5 digits" is a
legitimate business answer when the value the app rejected came from the **caller's** argument: the
agent supplied a bad member id and needs to be told so it can ask again. The identical banner is a
hard failure when the rejected value was a **literal baked into the artifact**, because then the
artifact is wrong and no caller can fix it - and telling an agent "retry with different input" for an
artifact bug sends it into a loop it can never exit. The classifier can tell these apart only because
binding provenance is one of its inputs (`ResolvedBindings`), which is a second, unadvertised return
on parameterization: **parameterization is what makes validation errors classifiable at all.**

**Rows 7 vs 8 - permission denial is polymorphic and must be declared.** A denial that is a property
of *the record* is an answer ("this member's account is flagged; a supervisor must service it"). A
denial that is a property of *the session's role* is an environment fault: it will fail identically
for every input forever, retrying is pointless, and the fix is a person changing an entitlement.
These render as almost the same screen. The author declares which detector means which, and **an
undeclared denial defaults to row 8, the failure** - never to row 7. That is fail-closed in its most
consequential instance.

**Row 33 - the row the brief does not list.** If an irreversible action is dispatched and the session
dies before its effect is observed, there is no honest local classification. It did not fail and it
did not succeed. The only correct behaviour is to stop, return `effect-in-doubt` with
`sideEffects: "in-doubt"` and `retriable: "no"`, raise an intervention, and let a person reconcile
against the system of record. A replay engine that retries here opens two sub-accounts. This is the
same discipline as `../durable-agent-outbox`'s `IN_DOUBT`, and it is why `effect` is a schema field
rather than a comment.

**Row 1 - the cheapest classification touches no surface, and it is not an outcome.** Declared param
constraints are evaluated before `perceive()` is ever called, and the result is
`failed / argument-invalid` with `sideEffects: "none-guaranteed"`, not a business outcome. The spine
proposal made it an outcome and its own open question doubted it. It is a failure because mixing "the
core has never heard of this member" with "you put letters in a digits field" in the same `outcome`
arm asks the caller to distinguish two things the union should distinguish for it - and because
"we definitely did not touch anything" is a materially different answer that deserves to be said out
loud rather than inferred.

### 4.4 Detector bands: the evaluation order

Evaluated top to bottom. **The first band that produces a verdict wins and no lower band runs.**

| Band | Contents | Source | Typical verdict |
|---|---|---|---|
| **G** | step precondition, lease held, policy allows the action, target resolves under quorum and passes its assertion | engine, pre-act | `fail` |
| **B0** | quiescence gate | engine | `pending`, or fall through with `settled: false` |
| **B1** | environment: session expiry, app error page, off-flow route | declared + engine | `recover` or `fail` |
| **B2** | interception: any modal, native dialog, or blocking overlay **that this step did not declare** | declared + engine | `recover`, `fail(undeclared-dialog)`, or stand down to B5 |
| **B3** | declared business outcomes (`OutcomeRule`, phase `post` only) | declared only | `outcome` |
| **B4** | declared recoverable conditions | declared only | `recover` |
| **B5** | checkpoint: predicate ∧ delta ∧ continuity | declared | `advance` |
| **B6** | default | engine | `fail(checkpoint-failed)` |

Four ordering choices that are load-bearing.

**B0 before everything.** A negative classification against a half-rendered page is the failure mode
that makes a replay engine untrustworthy *while looking like it works*. All three proposals had a
hole here in some form; the spine's non-configurable `requiresSettled: true` is the only structural
close, and the torn-read measurement [spike, terminal §4] is why it is not paranoia.

**B1 before B3 - environment beats declared outcomes.** A logged-out page and an error page both
render text that trips content detectors; a session-expiry screen often has an empty content region
that looks exactly like "no results". Environment truth is a fact about whether the surface is
showing us the application at all; a declared outcome is a claim about what the application said. The
first has to win, or a session timeout becomes `MEMBER_NOT_FOUND`. This is the single most important
precedence call in the problem.

**B2 before B3 - interception beats declared outcomes.** When a modal is up, what is visible behind
it is stale by construction - it is the state *before* whatever prompted the modal. Reading an
outcome off it is reading history. B2 is therefore also a *pre-act* guard consulted by band G, not
only a post-act classification, because a blocking overlay makes every locator resolution suspect.

**AMENDMENT - a declared dialog is a postcondition, not an interruption.** The paragraph above is
true and stays. The sentence it used to imply - *every* dialog is an interruption - is false, and
the cost of that conflation was concrete: `fixtures/corebank-web`'s confirmation is a modal, so its
sub-account commit could not be expressed at all. The only shape the language could reach was an
interception recovery whose remedy performed the write, and §3.5 forbids that (a remedy may clear an
obstacle and hand control back; it may not bind a value, classify, or be a postcondition).

A confirmation dialog is the postcondition of the click that raised it. So `Checkpoint.dialog`
(§2.4) declares it, and B2 **stands down to B5 for that dialog and for nothing else**. Four
conditions, each a refusal rather than a permission, and together they are why the fail-closed
guarantee is untouched *structurally* rather than by discipline:

1. **The step declared one.** No `expect.dialog`, no stand-down - every artifact written before the
   clause keeps its behaviour byte for byte.
2. **The channel is one a postcondition can be checked on.** A native dialog blocks the renderer, so
   there is no post-act `Observation` to verify anything against, and a postcondition that cannot be
   checked is not a postcondition. `Observation.nativeDialog` vetoes the stand-down outright: a
   `window.confirm` stays an interception, which is what it is.
3. **Something is actually open.** An `inputIntercepted` the driver could not name as a dialog node
   is not covered by a declaration that names one.
4. **EVERY open dialog is the declared one** - not "one of them is". The fixture raises its
   maintenance interstitial with the *same widget* as its confirmation panel, so two modals at once
   is not the dialog this step declared even though one of them is.

Band **B3 does not run when the stand-down fires**, whichever way `present` points. The stand-down
is about the *dialog*; it says nothing about the screen behind it, which is still the state before
whatever raised it. That is the half of "B2 before B3" that is true and it survives intact. Linker
check 25 refuses such a step at load time for the same reason, so the rule is a document error as
well as a structural one.

The dialog **outlives the step boundary** - it is one step's postcondition and the next step's
starting screen - which is why `present` is a field rather than an inference. The raising step
declares `present: true`; the step that answers it declares the same dialog with `present: false`
and is held to its absence. A clause covering only the raising step would move the refusal one step
to the right and change nothing.

**One thing this amendment does NOT do.** It does not close §7.4's `resume: "continue"` gap. An
interstitial that appears *after* a step has acted is a different problem - an unmodelled
interruption that must be cleared and re-verified, not a declared postcondition - and giving one
mechanism both jobs would make it right for neither.

**B3 before B4 - outcomes beat recoveries.** An outcome is terminal and already true; burning a
recovery budget on a page that has given you the final answer wastes attempts and risks a remedy
navigating away from it. Concretely: a results page showing both "No member found for 12345" and a
"Your session will expire in 2 minutes" nudge returns `MEMBER_NOT_FOUND`, rather than dismissing the
nudge and re-searching. The nudge is a real recovery for a step that has not finished; this step has.

**Ambient rules are recoveries and environment conditions only - never business outcomes.** Session
expiry is not an ambient *outcome*: the caller cannot act on it and the member should not hear about
it. The keep-alive **dialog** is an ambient recovery. That distinction is the taxonomy doing real work.

### 4.5 The hard case: an action that silently succeeded against the wrong target

This is the failure with no error message, and it is why `assert` and `continuity` are in the schema.
"Wrong target" is seven different bugs and they need different controls.

| | Sub-case | Caught by | Verdict |
|---|---|---|---|
| **W1** | Right control kind, wrong row - two members named *J. Alvarez*, we clicked the second | C1 `rowKeyEquals` bound to the caller's own param; C2 continuity | `target-assert-failed` (pre-act) |
| **W2** | Right row, wrong column - "Close" sits where "Select" used to | C1 `assert.role` + `assert.name` | `target-assert-failed` (pre-act) |
| **W3** | Right label, wrong frame - a "Search" button in the nav frame and in the content frame | C3 container scope + C4 descriptor agreement | `target-not-found` / `target-ambiguous` |
| **W4** | Stale geometry after a re-layout - coordinates now land on a neighbour | C4 agreement (geometric disagrees with role-name) | `target-ambiguous` |
| **W5** | Click landed on a transparent overlay | B2 interception guard, pre-act; `ActFault.intercepted`; C5 delta | `undeclared-dialog` / `action-rejected` / `no-observable-effect` |
| **W6** | Action dispatched, nothing happened (control dead but not marked disabled) | C5 effect delta | `no-observable-effect` |
| **W7** | Everything on screen is correct and the backend acted on a different record | **nothing here** - see §4.5.2 | - |

#### 4.5.1 The five controls

**C1 - pre-act target assertion. The strongest one.** Before dispatch, assert invariants about the
*resolved node itself*: role, accessible name against a `TextMatcher`, enabled state, and for
row-scoped targets `rowKeyEquals: { columnHeader: <token "memberIdColumn">, value: { from: "param",
param: "memberId" } }`. The principle: **the identity of the thing we act on is re-derived from data
we already know, not from where it sits.** You cannot click the wrong member's row when the row is
selected by the member id the caller asked about. It converts W1 and W2 from silent to loud and costs
one predicate evaluation.

```ts
export interface TargetAssertion {
  readonly role: Role;
  readonly name?: TextMatcher;
  readonly enabled?: boolean;
  readonly visible?: boolean;
  readonly rowKeyEquals?: RowKey;                 // the wrong-row killer
}
```

**C2 - continuity assertions.** A named value flows through the run and must be re-observed at
declared waypoints. `subjectMember` is bound from the `memberId` parameter and must appear inside the
member-detail region at the detail step and again at the balance step. The checkpoint is therefore not
"a member detail page loaded" but "**the** member detail page for the member we were asked about".
This catches landing-on-the-wrong-record even when the click was unambiguous - for example when the
app's own search silently corrected the id.

**C3 - scoped resolution.** Every `TargetRef` carries a `scope: ContainerMatcher`. Resolution never
searches the whole Observation. On a frameset app this is the difference between finding *the right*
"Search" button and finding *a* "Search" button.

**C4 - descriptor agreement with distinct evidence sources.** §5.

**C5 - effect delta.** At record time a structural summary of the change the action caused is
captured (did navigation occur, which containers changed, where focus went). At replay the checkpoint
asserts the delta. The default is deliberately the weakest useful form, `{ mustChange: true }`,
because a strict delta overfits the recording and turns benign rendering differences into failures.
Weak as it is, it is the only thing that catches W6 - which is otherwise indistinguishable from
success on a page that looks similar before and after, and which neither rival proposal caught at all.

#### 4.5.2 What survives, and why it is the safety model's problem

**W7 is not detectable from the UI, by construction.** If the surface carries no evidence that the
wrong record was touched, no pure function over the surface can find out. This is the honest limit of
the whole approach. Three things follow, and they are the actual mitigation:

1. `WRITE_IRREVERSIBLE` requires an approved artifact **and** scoped invocation approval. The
   residual undetectable-wrong-target risk is precisely why that gate exists - not a generic "writes
   are scary."
2. **Continuity assertions are mandatory on the confirmation screen of a write flow** (invariant 11),
   because a confirmation screen is usually where the app finally prints the identity of what it did.
   If the confirmation names the record, **W7 collapses into W1** and becomes detectable. The spine
   proposal called a write flow with zero continuity assertions "a review finding, not a valid
   artifact" and then declined to add the invariant. It is added here: the strongest control in the
   document must not be optional on exactly the flows it exists to protect.
3. Reconciliation against the system of record is out of scope and belongs in the calling product.
   Saying so is more useful than pretending replay can close it.

### 4.6 Two rules matching at once is a refusal, not a coin flip

Within a band, rules are evaluated by declared `priority`, lower wins. The linker makes priorities
unique **within a step's own declared rule set** (check 9). A tie can still reach a step by two
routes: an **ambient** rule colliding with a step rule, or an **overlay-added** recovery colliding
with a base one. When that happens the classifier returns `ambiguous-classification` and stops.

It does not resolve a taxonomy tie by array index and then ship the answer to a member. The spine
proposal did (first-declared wins, flag the run) and its own risk register admitted "it catches it
after the run has already returned an answer chosen by declaration order" - which contradicts its own
fail-closed rule. This is the fix, and it is why the class is reachable rather than dead.

Two lints back it up:

- **Overlap lint (save time).** Every frozen Observation in the capability's snapshot corpus is
  replayed through each band; the artifact cannot reach `draft` if two rules in one band match the
  same Observation.
- **Coverage lint (save time).** Every fault the fixture can inject must be matched by exactly one
  rule or must land on B6. Landing on B6 is *not* a lint failure - hard failure is a legitimate
  answer - but the lint reports it, so "we never declared a detector for permission denial" is
  visible at review time rather than discovered in production.

### 4.7 Failure prose is generated, never authored

```ts
export declare function renderTarget(t: TargetRef): string;
export declare function renderPredicate(p: Predicate): string;
export declare function renderVerdict(p: Predicate, o: Observation): ExpectationTrace;

export interface ExpectationTrace {
  readonly rendered: string;
  readonly clauses: readonly { readonly rendered: string; readonly verdict: boolean;
                               readonly descriptorId?: string;
                               readonly evidenceSource?: EvidenceSource;
                               readonly node?: string }[];
}
```

`renderTarget` produces *"the link in the Member column of the row whose Member ID cell equals
`param.memberId`, inside the table with headers [Member ID, Name, Share Balance, Status], inside
frame `content`"*. `#ctl00_g_9a1 > td:nth-child(3) a` renders as nothing at all. This is the concrete
payoff of refusing regex, CSS and an expression language: **every construct the language kept, it
kept partly because the interpreter can explain it to a human at 2am.**

**Two rules the renderer must obey, and they close a real PII hole.** A `ValueRef` renders **by
name** - `param.memberId`, never the value. A `template` hole renders **unresolved** - `{memberId}`.
The `observed` side is redacted per taint. So neither half of a failure report ever carries a member
number, and runs are correlated by `runId`, not by the parameter value. The alternative - "expected
is verbatim from the authored `describes` string" - either leaks the tainted value into every hard
failure or produces a message too vague to tell one run from another.

### 4.8 Testing the whole taxonomy with no browser running

The loop closes on itself, which is the point.

1. `fixtures/corebank-web` injects a fault per session: validation error, not found, permission
   denied (record-scoped **and** role-scoped, separately), interstitial, native dialog, session
   timeout, slow load, app 500.
2. The executor journals **every** `perceive()` result, redacted per taint, to
   `evidence/observations/<runId>/<seq>.json`.
3. Those files are the conformance corpus. A classifier test is
   `expect(classify(load(snapshot), step, counters)).toEqual(expectedVerdict)` - no Playwright, no
   fixture server, milliseconds.
4. The conformance package runs each scenario against **deliberately weakened engines**:
   - no quiescence gate → must fail the slow-load scenario by returning `MEMBER_NOT_FOUND`;
   - checkpoint before outcomes → must misreport not-found as `checkpoint-failed`;
   - first-matching-descriptor instead of agreement → must fail the duplicate-name scenario;
   - descriptor *count* instead of distinct evidence sources → must fail the correlated-descriptor
     scenario on the character grid;
   - no `assert` → must fail the wrong-row scenario;
   - no continuity → must pass a run that landed on the wrong member;
   - no delta assertion → must pass a dead-control click (W6);
   - nearest-string-match promotion of unmatched screens → must produce a false success;
   - no provenance in the classifier → must report row 5 as `retry-different-input`.
5. A **meta-test fails if every mutant passes** - i.e. if the suite has stopped discriminating.

The specific assertion the whole suite exists to make is **zero false successes**: no scenario may
return `ok` or an `outcome` when the fixture injected a fault that should have produced a `failed`.

---

## 5. Locator descriptors

The starting constraint is **not** "selectors drift" - the brief has deliberately removed that
problem. It is "assume no clean DOM, no test IDs, and possibly no DOM at all", and separately that
the model must never author a locator. So this section is not self-healing selectors. It is: pick
identities a human would use, compute several of them **independently**, and treat disagreement as
information.

### 5.1 The types

```ts
export interface TargetRef {
  /** Resolution NEVER searches the whole Observation. */
  readonly scope: ContainerMatcher;
  /** Required and may never be absent: role is the cheapest, most surface-portable filter and it
   *  eliminates the most dangerous class of mis-hit - acting on a node of the wrong KIND. */
  readonly role: Role;
  readonly descriptors: readonly Descriptor[];    // >= 2, derived, never model-authored
  readonly quorum: Quorum;
  readonly assert: TargetAssertion;               // control C1
  /** What was matched at record time. Compared on replay to produce the drift signal. */
  readonly recordedNode: NodeFingerprint;
}

export interface Quorum {
  /** Minimum descriptors that must independently resolve to the SAME node. >= 2. */
  readonly min: number;
  /**
   * Minimum DISTINCT EVIDENCE SOURCES among the agreeing descriptors. >= 2.
   * THE MOST IMPORTANT FIELD IN THIS SECTION. A quorum of three descriptors that all derive from
   * the same underlying evidence is a quorum of one. On a browser AX tree, `role-name` and
   * `label-anchored` usually come from the same `<label>`; if the vendor renames it both fail
   * together and the "quorum" never fires. On a character grid it is worse - [spike, terminal §3.2]
   * role synthesis, name synthesis and label anchoring all derive from the same label token on the
   * same row, so three descriptors can look independent and be perfectly correlated. Counting
   * SOURCES, not descriptors, is what makes the quorum mean anything.
   */
  readonly distinctEvidenceSources: number;
  /** Literal `true`, not configurable. Disagreement is a signal, never a fallback. */
  readonly requireIdentical: true;
  /** Literal `"fail"`, not configurable. There is no majority-vote mode, on READ steps or any
   *  other. Reading the wrong member's balance and speaking it to a member on the phone is a
   *  compliance incident, not a soft signal. */
  readonly onUnderQuorum: "fail";
  /** Constant `true`. A descriptor that matches several nodes ABSTAINS; it never picks the first. */
  readonly expectUnique: true;
}

export type EvidenceSource =
  | "accessibleName"   // the AX name computation, or the synthesized grid name
  | "labelText"        // an adjacent label token, spatially related
  | "columnHeader"     // a table's own header row - structural, not cosmetic
  | "ordinal"          // position among same-role siblings in a container
  | "geometry";        // spatial relation to another resolved node

export type DescriptorKind =
  | "role-name" | "label-anchored" | "table-cell" | "ordinal-in-container" | "geometric";

export type Descriptor =
  /** Rank 1. The accessible name is the identity a HUMAN uses; it survives markup churn. */
  | { readonly id: string; readonly kind: "role-name"; readonly evidenceSource: "accessibleName";
      readonly role: Role; readonly name: TextMatcher }

  /** Rank 2. "the box next to Member ID", including spatial label association on legacy tables. */
  | { readonly id: string; readonly kind: "label-anchored"; readonly evidenceSource: "labelText";
      readonly label: TextMatcher; readonly role: Role;
      readonly relation: "labelled-by" | "right-of" | "below" | "left-of" | "above" | "same-cell";
      readonly maxDistance: { readonly unit: "px" | "cell"; readonly value: number } }

  /** Rank 3. "the Select link on the row whose Member ID is :memberId" - how a human does it. */
  | { readonly id: string; readonly kind: "table-cell"; readonly evidenceSource: "columnHeader";
      readonly table: ContainerMatcher; readonly rowKey: RowKey;
      readonly columnHeader: TextMatcher; readonly childRole?: Role;
      /** Recorded, compared, and correctable by overlay. [spike, browser §5.2] */
      readonly headerProvenance: "columnheader-role" | "first-row-heuristic" }

  /** Rank 4. Positional. NEVER the only or highest-ranked descriptor (invariant 2). */
  | { readonly id: string; readonly kind: "ordinal-in-container"; readonly evidenceSource: "ordinal";
      readonly container: ContainerMatcher; readonly role: Role; readonly index: number }

  /** Rank 5. Last resort. Always anchored to another descriptor, always scoped, never absolute. */
  | { readonly id: string; readonly kind: "geometric"; readonly evidenceSource: "geometry";
      /** An INLINE anchor, not a reference to a sibling - the other descriptors in a Target all
       *  resolve the SAME node, so there is no sibling that resolves the anchor. The anchor may not
       *  itself be geometric, which makes cycles impossible by construction rather than by a graph
       *  check. */
      readonly anchor: Exclude<Descriptor, { kind: "geometric" }>;
      readonly role: Role;
      readonly direction: "right-of" | "below" | "left-of" | "above";
      readonly maxDistance: { readonly unit: "px" | "cell"; readonly value: number } };

/** Rank is a property of the KIND and lives in `@crr/core`, never in the artifact - otherwise a
 *  tenant overlay could promote `ordinal` and quietly reintroduce the positional targeting this
 *  design exists to avoid. */

/** For COMPARISON and DIAGNOSTICS only, never for lookup. Two descriptors "agree" iff they select
 *  nodes with equal fingerprints. */
export interface NodeFingerprint {
  readonly ariaRole: Role;
  readonly name: string | null;
  readonly containerPath: readonly ContainerSegment[];
  readonly tablePosition: { readonly rowHeader: string | null; readonly colHeader: string | null } | null;
  readonly boundsBucket: string | null;           // quantised; survives font rendering, not redesigns
}
```

**There is no `grid_region { screen, row, col, width }` descriptor.** One proposal offered it as "the
proof that the port is not browser-shaped"; [spike, terminal §3.4] measured the summit tenant of the
same vendor product with fields moved two columns left and one row down and widths changed 12→10 and
28→24: *"Not one coordinate matched."* The descriptor presented as the portability credential is the
least portable construct available, and the spike says outright that a grid coordinate is that
surface's CSS selector. Grid coordinates live in `UINode.bounds` and reach a descriptor only through
`geometric`, anchored and scoped.

### 5.2 How descriptors are derived at record time

```ts
export declare function deriveDescriptors(obs: Observation, nodeId: NodeId): readonly Descriptor[];
```

Pure, deterministic, unit-testable from frozen observations with nothing running. The model's entire
contribution to a locator is **a node id from the observation it was shown**. It never sees, writes
or edits a descriptor.

Two derivation rules do the work:

> **A descriptor is emitted only if it resolves to exactly one node in the recorded Observation.**
> Uniqueness is a *verified property at record time*, not a hope at replay time.

> **The emitted set must cover at least two distinct `EvidenceSource` values**, and `geometry` +
> `ordinal` cannot satisfy that between them - both are properties of *layout*, and layout is the one
> thing that legitimately changes when a tenant rebrands.

If the recorder cannot find two independent descriptors, it says so on the artifact and blocks
approval. It does not invent a sixth strategy. On a `<font>`-tag frameset the AX tree does not lie,
it just says very little - roles collapse toward structure and names go null - which is precisely why
there are five kinds and why the recorder's job is to find *two independent* ones rather than the
best one.

### 5.3 How they are resolved and cross-checked at replay time

One fixed algorithm, no fallback chain:

1. Evaluate every descriptor **against a single Observation snapshot**. Each returns
   `Resolved(nodeId)` | `NonUnique(count)` | `Abstain(reason)`. A descriptor disabled by the overlay
   returns `Disabled` and counts as an abstention.
2. `NonUnique` counts as an abstention for quorum but is recorded **distinctly** in the fingerprint -
   it is the strongest available drift signal, because it means the screen grew a second thing that
   looks like the thing.
3. Discard any resolution whose node's `confidence` is below `SurfaceCapabilities.confidenceFloor`.
4. Let `S` = the set of distinct node ids resolved.
   - `|S| > 1` → **`target-ambiguous`**. Two independent descriptions of "the control" disagree about
     which control it is. **Refuse to act.** This is not a case for a fallback ranking; it is the case
     a ranking would hide.
   - `|S| === 0` → **`target-not-found`**.
   - `|S| === 1` but fewer than `quorum.min` descriptors agreed, or fewer than
     `quorum.distinctEvidenceSources` distinct sources are represented among them →
     **`target-underdetermined`**.
   - otherwise → resolved; run `assert` (C1); on mismatch → **`target-assert-failed`**.

`target-underdetermined` earns its own class rather than folding into `not-found` because it means
something operationally different: *we found a plausible node, but not on enough independent evidence
to touch it.* That is a "this tenant needs specialization" signal, and it is exactly the case a
rank-ordered fallback chain converts into a silent misclick.

### 5.4 The disagreement policy, and its cost

A fallback chain converts a disagreement into a silent choice, and the disagreement is the only
evidence we will ever get that the surface changed underneath us. `requireIdentical` and
`onUnderQuorum` are typed as literals so neither can be configured away, and there is no quorum mode
on any step class.

**The cost is real and stated:** on a genuinely drifted screen this design **stops** where a fallback
chain would have carried on and probably done the right thing. That is the trade to want in a bank,
and it is the trade the brief's "stable UIs" premise makes cheap. If that premise turns out to be
false for a given tenant, this is the wrong call - and the fingerprint divergence signal is the early
warning, with nothing acting on it automatically.

### 5.5 Drift is a signal on success, never a verdict

Every resolution folds into a fingerprint: per `(stepId, descriptorId)`, the verdict and, when it
resolved, a hash of the observed name and its evidence source. `DriftSignal` is present on **every**
arm of the result contract, including `ok`. A run that succeeded on two of four descriptors succeeded
- and the operator should know the margin is thinning before the day it hits zero. Crossing the
threshold sets `needsSpecialization`, which is a ticket, not an outage. Nothing self-heals: a replay
engine that edits its own locators has no determinism claim left, and determinism is the entire
product.

The fingerprint covers **interactive nodes plus the screen/route id and deliberately excludes the
branding band** - [spike, terminal §3.4] the same two tenants diverged 63% over all nodes and 40%
over interactive nodes only, so *what you fingerprint* is itself a design decision and writing it
down is worth more than the number.

### 5.6 What is refused, and why

| Refused | Why |
|---|---|
| **CSS selectors, XPath, DOM ids, attribute matchers.** Not even as an escape hatch. | An artifact holding `#ctl00_ctl32_g_9a1` has already failed "would still work with no clean DOM", and is unportable to terminal and desktop by construction. An escape hatch becomes the default within one sprint because it is always the fastest way to fix today's bug. Enforced by the §1.3 contract test, not encouraged. |
| **Regex, everywhere.** No `regex` mode in `TextMatcher`, no `regex_capture` extractor. | It is not reviewable by the operations person who approves it; it is a ReDoS surface in a document a model can author, crossing a trust boundary; and the thing people reach for it to do - "the message with the id in it" - is better served by `template` holes, which additionally keep the id out of the file. Two of the three proposals banned it; the third conceded in its own risk register that the safest version would drop it and shipped it anyway, which is worse than either choice. |
| **Node ids from any Observation.** | They are per-observation handles. Storing one produces a flow that replays perfectly exactly once. The validator rejects NodeId-shaped strings. |
| **Confidence scores and thresholds on a match.** | A score invites a threshold, a threshold invites tuning, and tuning a match threshold is how a wrong-target click becomes policy. Matching is boolean; disagreement is a named failure. (`UINode.confidence` is the *driver's* statement about its own synthesis and is compared against a floor the driver publishes - it is never a per-match tunable in the artifact.) |
| **Self-healing / locator repair on replay.** | Drift is detected via the fingerprint and reported. Repair belongs in a review loop that produces a new signed artifact version. |
| **`expectedScreenshot` / visual diff checkpoints.** | The least stable signal on a multi-tenant, multi-theme surface, and it would make the classifier impure - it needs pixels, not an Observation - costing the frozen-snapshot testability the whole design is organised around. |
| **Whole-page expected-text snapshots.** | They embed PII, break on branding, and turn every cosmetic change into a hard failure, which trains people to ignore hard failures. |
| **Recorded timings used as replay budgets.** | Recording that the page took 840 ms and setting an 840 ms timeout is the classic way to manufacture flake. Budgets are declared policy with round numbers, tuned against the conformance corpus, overridable per tenant. |

### 5.7 What breaks it, stated plainly

Every `TextMatcher` breaks under UI **translation**. A `vocabulary` token handles a relabelled field;
it does not handle a Spanish-language tenant, where every matcher fails at once. That is a re-record,
not an overlay, and the design should say so rather than imply the overlay covers it.

On the terminal surface `role` is a **heuristic** - "this is a textbox" is inferred from a field's
rendering, not read from a tree. The port fits, but the *fidelity* differs. **The claim this spec
makes is cross-surface engine reuse, not cross-surface artifact reuse**: one contract, one language,
one taxonomy, two programs (§9.1).

---

## 6. Discovery loop design

### 6.1 The tool surface exposed to the model

Five tools, all `strict: true`, all passing the policy chokepoint, all journaled. `disable_parallel_tool_use: true` on
`tool_choice`: a computer-use loop must observe the consequence of each action before choosing the
next, and interleaved actions would make the recorded step order meaningless.

| Tool | Input | Returns |
|---|---|---|
| `observe` | `{}` | the rendered Observation (§6.2) |
| `act` | `{ nodeRef: string, action: "activate" \| "fill" \| "select" \| "setToggle" \| "pressKey", value?: string, key?: ArtifactKey, why: string }` | `{ ok, faultKind?, observation }` |
| `go` | `{ routeHint: string, why: string }` | `{ ok, observation }` - policy-checked against the allowlist before the navigation |
| `note_output` | `{ nodeRef: string, outputName: string, meaning: string }` | `{ ok }` - marks a node as a value the caller should receive |
| `finish` | `{ status: "reached-goal" \| "stuck", summary: string, outcomeCandidates?: {code, title, why}[] }` | ends the loop |

Three things the model **cannot** do, by the absence of a tool: it cannot write a selector, it cannot
read raw HTML or the DOM, and it cannot set a wait or a timeout. `why` is required on every acting
tool and becomes `Step.intent` - human-only prose the engine never reads.

### 6.2 How the model references nodes

The model is shown a **filtered projection** of the Observation, never the whole thing:

```text
[n7]  textbox  "Member ID"        value=""      frame=content   capacity=12
[n8]  button   "Search"                         frame=content
[n21] link     "Select"           row: Member ID=10041 | Name=ALVAREZ, DANA (SYNTHETIC)
[n34] cell     "1,204.55"         table[Member ID,Name,Share Balance,Status] col=Share Balance
```

- Only nodes with `ariaRole !== null` and `state.visible === true` appear. [spike, browser §6.2] 205
  nodes serialise to 50 KB; filtered to `ariaRole && !ignored` it is 14 KB. The model gets the
  filtered view.
- `nodeRef` is `n<k>`, an index into **this turn's** Observation. It is not a `NodeId`, it is not
  stable across turns, and it never reaches an artifact. The host maps `n7 → NodeId` inside the turn
  and discards the map.
- Values bound to `sensitive` parameters are shown as `value=<masked:12>`.
- Table cells carry their row-key/column-header context in the rendering, because that is the
  vocabulary the model should be thinking in - and it is the descriptor the deriver will emit.

The stable system prompt + tool definitions come **first** in the request and are marked
`cache_control: { type: "ephemeral" }`; the observation payload changes every turn, so the cacheable
prefix must precede it. The measured `usage.cache_read_input_tokens` hit rate goes in `/evidence/`.

### 6.3 How parameters are inferred and bound

Deterministic, after the run, with no model involved:

1. **Collect** every literal the model typed or selected, plus every concrete segment of every route
   visited.
2. **Match against the goal.** A value that appears in the goal text becomes a candidate parameter,
   with `discoveredFrom: { goalSpan: "member <VALUE>" }`.
3. **Type it** from the surface: a `capacity: 12` field on the grid becomes `maxLength: 12` [spike,
   terminal §3.3]; a `digits`-only field becomes `charset: "digits"`; an enumerated `select` becomes
   `{ kind: "enum", values }`.
4. **Canonicalize routes.** `/member/12345` → `/members/:memberId` with the concrete value bound to
   the parameter.
5. **Classify sensitivity.** A member number is `sensitive` - it is the identifier that links a
   balance to a person, and getting this backwards means the "no example on a sensitive field"
   validator is not protecting the field it exists for. A balance is `internal`. Anything matching an
   SSN, PAN, email or phone shape is `sensitive` and blocks approval until a human confirms the
   parameterization.
6. **Refuse to store the value.** Every candidate that becomes a parameter is replaced by
   `{ from: "param" }` in the artifact. A residual literal survives only if it is
   `sensitivity: "public"` - which is a *type-level* guarantee, since the `literal` variant of
   `ValueRef` cannot express any other sensitivity - and linker check 14 re-checks it.

**One mechanism, three requirements.** Parameterization is simultaneously "reusable capability",
"never persist PII", and the route-canonicalization stretch goal. It is also, per §4.3, what makes
validation errors classifiable at all. Four returns on one decision is why it is the mechanism and
not a lint.

**The gap the lint exists to cover.** Whether a value *should* have been a parameter is a
recorder-side judgement (`valueAppearsInGoal`, `valueMatchesAKnownPIIFormat`), not something the
linker can re-derive from the artifact. The PII lint is shape-based and will both miss and
over-trigger: it will not catch a member number that looks like an order number, and it will flag a
legitimate literal that happens to look like a phone number. It is a backstop for parameterization,
not a substitute for it. §12 records this.

### 6.4 How the transcript is kept out of the artifact

The artifact carries `provenance.transcriptRef: { digest, uri } | null` - a **pointer**, never the
text. Three reasons: the assignment requires the artifact be decoupled from the raw model transcript;
an embedded transcript is an unbounded PII surface; and a transcript is a different document with a
different retention policy.

`Step.intent` and `Step.title` are the only model-authored prose in the artifact, they are
human-only, and a contract test asserts no executable path reads them. An engine that reads prose has
put the model back in the decision loop through the side door.

**Redaction applies to transcripts too.** A recorded VCR transcript is a persisted artifact under the
same taint model as everything else.

### 6.5 The provider port and the zero-cost build

`DiscoveryModel` is a port with four adapters. This is a cost decision that is also a correctness
decision, and it must be wired in from the start.

| Adapter | Role |
|---|---|
| `anthropic` | **Primary, ships.** A manual tool-use loop against the Messages API - not the SDK's `toolRunner`, because the loop is one of the things being evaluated, every tool call must pass the chokepoint and be journaled, and a beta dependency does not belong in the critical path. Produces every artifact in `/evidence/`. Model id from `CRR_MODEL`, default `claude-opus-5`. |
| `replay` | **The VCR.** Every run through any adapter records requests, responses, tool calls, timings and token usage to a fixture; `replay` serves them back deterministically. This is what makes `pnpm test` pass with **no credentials**, makes the loop exercisable hundreds of times during development with no API calls, and catches prompt/tool-schema regressions deterministically. |
| `agent-sdk` | **Dev only**, clearly marked. Runs Claude Code's loop, not ours - it therefore does **not** validate our prompt shape, tool schemas, observation serialization or stopping conditions. Do not claim the dev path de-risks the shipping path. |
| `openai` | Optional, wired only if a key exists. Proves the loop is not provider-coupled. |

**Provenance honesty rules.** Every file in `/evidence/` states which adapter produced it and with
which model id. A transcript replayed from a VCR fixture is **never** presented as a live model run.
A run driven by a human or a coding agent through a manual driver is a debugging aid, not evidence.

### 6.6 Immediate self-replay verification

After a successful discovery run the system **immediately replays its own artifact with the model out
of the loop**, and only saves it as `draft` if that succeeds. This closes the gap between "the model
did it" and "the recording faithfully describes what it did", and it yields the
`proposed → verified(draft) → approved` lifecycle for free.

**The brief is wrong as written for write flows, and this is the fix.** The verification replay runs
against a surface the discovery run just mutated. For a read capability that is fine. For
`corebank.member.open-subaccount`, verification **opens a second sub-account** - the mechanism that
proves the artifact is faithful is itself an unapproved, unattended, duplicated irreversible write
against a bank system, which is the thing the safety model exists to prevent. All three proposals
amended the brief here independently, which is itself evidence the brief is wrong. Three modes:

| Mode | What runs | Grade | May reach `draft`? |
|---|---|---|---|
| `replay-full` | the whole flow; the run's `maxEffect` is `READ` | `full` | yes |
| `replay-dry` | every step up to the first `WRITE_IRREVERSIBLE`, then at that step do **everything except dispatch**: resolve the descriptors, require quorum, run `assert`, evaluate the precondition - and stop | `partial-up-to-irreversible`, with `coveredThroughStep` naming exactly where it stopped | yes |
| `replay-reset` | the whole flow, when the environment exposes a reset hook. Our fixture does; real core banking does not | `full` | yes |
| *(none)* | no replay was run | - | never - stays `proposed` |

`replay-dry` still verifies the part of the artifact most likely to be wrong - locators, checkpoints,
parameter binding - without performing the write a second time. It is independently useful as a
production dry-run: a way to check an artifact against a tenant after a vendor upgrade without
touching their data.

`Verification.grade` becomes a field a human approver **must** read and tick
(`approval.acknowledgedGrade`): a `partial-up-to-irreversible` draft is a different claim from a
`full` one, and flattening them into a boolean `verified` would hide precisely the risk the approval
gate exists to weigh. **The operational cost is named rather than papered over: write capabilities
need a resettable environment to reach a `full` grade.**

---

## 7. Control lease + escalation protocol

The assignment gives human-in-the-loop its own core requirement (§3.6), its own REPORT heading, and
an evaluation bullet demanding "a real, well-reasoned mechanism… not just a TODO". The spine proposal
had a visible hole here; this section is the fix and it is not optional depth.

### 7.1 States and transitions

A session has **exactly one controller** at any time, held under a lease with a monotonic epoch.

```text
                    ┌──────────────────────────────────────────────────┐
                    │                                                   │
   [run starts]     ▼                                                   │
  ──────────► AUTOMATION_HELD ──── raise intervention ────► RELEASING ──┤
                  │  ▲                                          │       │
                  │  │                                          ▼       │
    lease expires │  │ resume accepted                     HUMAN_OFFERED
    or is revoked │  │ (precondition re-verified)                │
                  │  │                                     operator claims
                  ▼  │                                           │
              ORPHANED│                                           ▼
                  │  └──────────── hand back ◄────────────── HUMAN_HELD
                  │                                               │
                  ▼                                    abandon / expire
              TERMINATED ◄──────────────────────────────────┘
```

| From | Event | To | Who may act after |
|---|---|---|---|
| `AUTOMATION_HELD` | classifier returns a verdict whose `SuspensionReason` is escalatable **and** `onIntervention === "suspend"` | `RELEASING` | nobody |
| `AUTOMATION_HELD` | same, but `onIntervention === "fail"` | `TERMINATED` | nobody - returns `failed` |
| `RELEASING` | lease released, intervention written, `ReplaySuspended` returned to the caller | `HUMAN_OFFERED` | nobody yet |
| `HUMAN_OFFERED` | operator claims the intervention in the console | `HUMAN_HELD` (epoch+1) | **human only** |
| `HUMAN_HELD` | operator presses *Hand back* | `AUTOMATION_HELD` (epoch+1) | automation, after §7.4 |
| `HUMAN_HELD` | operator presses *Abort* | `TERMINATED` | nobody - returns `failed` |
| `HUMAN_OFFERED` / `HUMAN_HELD` | `intervention.expiresAt` passes | `TERMINATED` | nobody - the suspended run converts to `failed / recovery-exhausted` |
| any | lease TTL passes with no heartbeat | `ORPHANED` → `TERMINATED` | nobody |

**Enforcement, not convention, in two places.** The executor rejects any action presented without the
current lease token *and* the current epoch; and `Surface.act(action, lease)` rejects it again at the
driver with `ActFault.lease-not-held`. The second gate exists because the interesting failure is an
automation run that believes it still holds a session a human has taken - and a design that classifies
`lease-lost` without a port that can produce it is classifying a condition nothing prevents.

### 7.2 What is escalatable

Not every failure is. A `SuspensionReason` is raised only where **a human at a terminal could
plausibly finish the job**:

| `SuspensionReason` | Raised when |
|---|---|
| `unclassified-state` | the observation matched no rule and failed the checkpoint. The growth mechanism, not an embarrassment (§7.7) |
| `recovery-exhausted` | a declared recovery gave up and its `resume` is `escalate` |
| `approval-required` | the next action is irreversible and no valid invocation approval was presented |
| `target-ambiguous` / `target-underdetermined` | we refuse to guess which control to click |
| `session-lost` | the authenticated context is gone and re-establishing it is a human act |
| `effect-in-doubt` | **auto-escalates regardless of `onIntervention`.** Nobody gets to say "fail and go home" about an irreversible action whose result was never observed |

`link-error`, `argument-invalid`, `contract-stale`, `artifact-invalid`, `policy-denied` and
`internal-invariant` are **never** escalatable: a human at the app cannot fix a bad artifact by
clicking, and offering them a session would waste an operator's time.

### 7.3 What the operator console needs

Deliberately bare - the anti-goals forbid a React admin app - but real. A local HTTP surface in
`@crr/runtime` with six routes and no build step:

| Route | What it does |
|---|---|
| `GET /interventions` | open interventions, newest first: capability title, tenant, reason, step index, age, expiry countdown |
| `GET /interventions/:id` | the full `Intervention.brief` - goal template (parameterized, never a member number), step title, the **generated** `whatWasExpected`, the redacted `whatWasObserved`, the masked evidence capture, `whyStopped` from the FailureClass table, and `suggestedAction` |
| `POST /interventions/:id/claim` | acquires the lease at epoch+1, returns a live view |
| `POST /interventions/:id/act` | injects one `Action` **into the same live session**, policy-checked exactly like an automation action, journaled as `human.acted` with the operator's id |
| `POST /interventions/:id/handback` | §7.4: release the lease and let automation resume |
| `POST /interventions/:id/abort` | terminate the run rather than resume it |

The live view is **surface-agnostic because it speaks the same ports**: it renders
`Surface.capture()` output - a masked PNG for the browser, a masked character-grid dump for the
terminal - plus the filtered node list, and it posts back typed `Action`s. It works for the green
screen without a line of terminal-specific console code, which is the strongest available evidence
that the port is real. Production would use CDP screencast or WebRTC for a continuous stream; that is
a documented seam and the polling capture is the thin-but-real version.

### 7.4 The resume precondition re-check - the part that is usually a TODO

Resume is **not** "continue at pc". On hand-back, in this order:

1. **Lease.** Automation re-acquires at epoch+1. Any token minted under an older epoch is dead.
2. **Re-observe.** A fresh `perceive()` with its own deadline. The screen the human left is not
   assumed to be the screen they were given.
3. **Re-classify at `phase: "pre"`.** The human may have cleared the obstacle *and* landed somewhere
   the taxonomy already understands - including on a business outcome, which terminates the run
   correctly rather than resuming into it.
4. **Re-verify `step.precondition`.** If it fails, the run does **not** continue: it returns
   `failed / precondition-not-met` naming the step. This is the whole point of preconditions being a
   declared field rather than belt-and-braces - a language whose steps declare what they require is a
   language whose execution can be interrupted.
5. **Re-verify continuity.** Every `ContinuityDef` in scope at this step must still hold. A human who
   navigated to a different member's record while investigating must not have the run resume into
   that member's account. Failure here is `continuity-broken`, not a resume.
6. **Re-check the effect gate.** If the step is `WRITE_IRREVERSIBLE`, rich invocation approval is
   re-validated at epoch+1 when present; the legacy policy token fallback is only a compatibility
   path, and the interpreter still re-verifies before dispatch.
7. **Re-run the step from the top of the cycle** (§3.1 step 1), not from the middle.

The journal carries a `ControlTransfer` with the operator's id and the titles - never values, never
coordinates - of every action they performed, and `RunEnvelope.attribution.by` becomes
`"human-assisted"` for the rest of the run's life. A run a human touched is never reported as a
purely automated success.

### 7.5 What the caller sees

`ReplaySuspended` carries `partialOutputs`, so the agent can say something **true** ("I found your
account, I'm checking the balance") instead of something vague, and `resume.pollAfterMs` so it knows
when to look again. `renderForAgent` maps it to `status: "pending"` - the model has no session, and
from its side the run has not finished.

**Suspension holds a live session across an agent turn**, which costs a browser or a pty per parked
run and adds a way to fail: the underlying session can expire while suspended. `lease.expiresAt` and
`intervention.expiresAt` bound it, and a long human response time converts a suspension into a
failure. Callers must be told that, and §12 records it.

### 7.6 The session broker

The program never logs in. `@crr/runtime` owns a `SessionBroker` keyed by
`(tenantId, appInstanceId, sessionProfile)`:

```ts
export interface SessionBroker {
  open(profile: string, tenant: TenantRef): Promise<{ sessionId: string; surface: Surface }>;
  /** Re-establishes authentication on the SAME surface where the app supports it, or opens a fresh
   *  one. Called by the `reauthenticate` remedy and before every program restart (§3.6). */
  refresh(sessionId: string): Promise<"refreshed" | "reopened" | "failed">;
  close(sessionId: string): Promise<void>;
}
```

Credentials resolve through `{ from: "credential", key }` at act time, tainted, never stored in an
artifact, never written to a journal, never present in an evidence capture. There is no field in the
artifact schema a credential could be written into even by accident.

### 7.7 `unclassified-state` is the growth mechanism

Every occurrence freezes the Observation into evidence and raises an intervention. A human either
recognises it as a business answer (→ a new `OutcomeDecl`, a contract bump, a new `OutcomeRule`, a new
fixture fault) or as a nuisance (→ a new `RecoveryRule`, which an **overlay** can add without touching
the contract). Either way the frozen snapshot becomes a conformance-suite case, so **the taxonomy
grows by regression test rather than by patch.** That is the loop that makes a closed outcome set
survivable - and the cost is stated in §12: fail-closed means the first N replays of a new capability
produce a lot of interventions, and if nobody staffs that review the capability degrades into one that
fails a lot and gets turned off. The share of runs ending in `checkpoint-failed` is that review
queue's SLA.

---

## 8. Policy & redaction

### 8.1 The chokepoint

Every action, in **both** discovery and replay and in the operator console, passes through one
`check(action, ctx)` and nothing else. It is a pure function, ~300 lines, living beside the classifier
that shares its vocabulary. It is not a package: a package boundary does not make it the *only*
chokepoint. **The contract test does** - it reads the repo off disk and fails if any `Surface.act`
call site is not immediately preceded by a `check` on the same action, and the journal schema
requires a `policy.decided` event before every `acted` event at the same step.

Order of evaluation inside `check`, first refusal wins:

1. lease held at the current epoch → else `lease-not-held`
2. origin alias in the allowlist → else `origin-not-allowed`
3. canonicalized route matches an allowlisted pattern → else `route-not-allowed`
4. action kind allowed → else `action-kind-not-allowed`
5. effect ≤ allowlist `maxEffect` → else `effect-exceeds-allowlist`
6. effect ≤ artifact `policy.maxEffect` → else `effect-exceeds-artifact`
7. in replay: artifact `lifecycle.status === "approved"` and its digest verifies → else
   `artifact-not-approved` / `artifact-digest-mismatch`
8. if effect is `WRITE_IRREVERSIBLE`: scoped invocation approval is present and valid for this
   artifact, contract, tenant, app instance, policy version, argument hash and idempotency key
   -> else `irreversible-requires-approval`
9. no tainted handle flows to a disallowed sink → else `tainted-value-to-disallowed-sink`

In discovery the allowlist's `discoveryMaxEffect` applies and an irreversible action additionally
requires an **explicit interactive human approval** at the moment it is attempted; there is no
"approve everything for this run" mode.

### 8.2 Action risk classes

`READ | WRITE_REVERSIBLE | WRITE_IRREVERSIBLE`, declared per step and re-derived by the linker from
the instruction kind and the route's declared `maxEffect`. Where the declaration and the derivation
disagree, **the higher wins** and the linker reports it.

What each class buys:

- `READ` - no approval, retriable, may be restarted from any resume point, eligible for
  `replay-full` verification.
- `WRITE_REVERSIBLE` - no irreversible approval, but the step is excluded from a `restart-from-checkpoint`
  that would cross it unless the artifact declares the step idempotent.
- `WRITE_IRREVERSIBLE` - invocation approval required at the dispatch boundary, `retriable`
  forced to `never`, no `act` recoveries, no restart across it, `replay-dry` verification,
  mandatory continuity assertion on the confirmation step (invariant 11), and auto-escalating
  `effect-in-doubt` if dispatch is not followed by an observation.

**`effect` is declared, not proven.** The policy chokepoint, the restart gate, the approval blast
radius and the irreversibility invariants all rest on a field the recorder wrote. Only one of the
three proposals said so. It is stated here as an accepted limit (§12) with three partial mitigations:
the browser driver records whether a step's action produced a non-GET request and the linker warns
when a step marked `READ` did (a heuristic, and one that does not exist for the terminal surface);
`EffectSummary` is rendered in the approval UI as the complete blast radius a human ticks; and the
`acknowledgedEffects` list is retained so "who approved the irreversible one" is an audit answer.

### 8.3 The taint model

Redaction is not a log filter applied at the end; it is a **type-level property that follows the
value**.

- A `sensitive` `ParamSpec` produces a `TaintHandle` at bind time. The handle, not the value, is what
  the policy engine, the classifier trace and the journal ever hold.
- The value reaches exactly two places: the `Action.type.text` field handed to the driver (with
  `sensitive: true`, so the driver knows to mask its region), and - for outputs - the caller's typed
  `ReplayOk.outputs`.
- It reaches **none** of: the artifact, the journal, an evidence capture, a screenshot, a classifier
  trace, an `ExpectationTrace`, a VCR transcript fixture, or a tool result whose `agentDisclosure` is
  not `deliver`.
- `ValueRef`'s `literal` variant is typed `sensitivity: "public"`. A non-public literal is not
  expressible in the schema; that is the primary control, and linker check 14 is the backstop.
- Detector text uses `template` holes, never values. **A detector that says "No member found for
  12345" has stored a member number just as surely as a step value would** - this is the gap
  parameterization alone does not close, and invariant 8 is what closes it.
- `ExtractSpec` journals `{ output, sensitivity, present: boolean }` - never the value.

**The redaction canary test.** A run is executed with a known distinctive value bound to a sensitive
parameter, then the whole `evidence/` tree, the journal, the artifact, the overlay and the VCR
fixture are grepped for it. The test fails on a single hit. This is the only way this control is
worth claiming.

### 8.4 Screenshot region masking

Masking happens **before the bytes exist**, not after: a capture that was ever unmasked in memory is a
capture that can leak. `CaptureRequest.maskRegions` is computed from the resolved bounds of every node
bound to a `sensitive` parameter at that step.

[spike, browser §4.4] This was verified at the pixel by decoding the PNG rather than by eyeballing
it: the masked field's centre pixel changed from `rgb(255,255,255)` to `rgb(255,0,255)` while a pixel
far from the field was unchanged, on a field three levels into a frameset. One API constraint to
design around: **Playwright's `mask` takes `Locator[]`, not rectangles** - there is no coordinate-only
masking - so the browser driver keeps a `UINode → Locator` bridge used *purely for redaction*, at the
cost of one `ariaSnapshot()` call alongside the CDP tree whenever a masked screenshot is taken. The
terminal driver blanks the cell range before the grid dump is written.

`evidence.captureOn` defaults to `["failure", "outcome"]`. `"always"` is available and is what the
conformance corpus uses, because the corpus is the point.

---

## 9. Multi-tenant resolution

### 9.1 The shape

`contract` (stable id + typed API, shared by every tenant and every surface) → `artifact` (per vendor
product **and** surface kind) → `overlay` (per tenant app instance, overrides only).

```text
  contract  corebank.member.read_savings_balance @1.2.0
      ├── artifact  web-legacy  v3   (CoreBank Back Office >=8.2 <9)
      │       ├── overlay  riverbend/prod   (vocabulary: 2 tokens; originAlias)
      │       └── overlay  summit/prod      (vocabulary: 3 tokens; routeBasePath; +1 recovery)
      └── artifact  terminal    v1   (CoreBank Teller green screen)
              └── overlay  lakeside/prod    (vocabulary: 1 token; fieldAttr hint)
```

**One contract, two programs.** A tenant on the web core and a tenant still on the green screen call
the *identical* agent-facing capability; the resolver picks the artifact whose `target.surfaceKind`
matches the app instance's registered surface. This is the best available answer to assignment §3.7,
and it is only expressible because detectors live on the artifact rather than on the contract (§0
decision 4). It is also the honest limit: what is shared is the contract, the language, the taxonomy
and the engine - **not the step sequence**, because green-screen flows have different screen counts
and different field orders.

### 9.2 Merge semantics

`resolve(base, overlay)` is deterministic, total and pure, and its output is hashed.

| Field | Merge rule |
|---|---|
| `originAliases` | overlay **replaces** per alias; an alias the overlay does not name keeps the base's |
| `routeBasePath` | overlay prepends a prefix to the route's `path`. It cannot change the path template |
| `vocabulary` | overlay **replaces** a token's synonym list wholesale. A token the overlay does not name keeps the base's |
| `stripTokens` | **union** of base and overlay |
| `steps[].addDescriptors` | **appended** to the base descriptor list |
| `steps[].disableDescriptors` | listed ids are marked `Disabled`; they resolve to nothing and are recorded as such in the fingerprint |
| `steps[].settle`, `steps[].budgets` | field-wise override; a value the overlay omits keeps the base's |
| `steps[].tableHeaders` | overlay **replaces** the header set for a named table container |
| `addRecoveries` | **appended** to the step's recovery list, and re-checked for priority collisions |
| everything else | **not addressable.** The overlay type has no slot for it |

After merge, **the linker runs again over the merged program** - every check, including quorum
(check 11), so an overlay that disabled one descriptor too many is a `link-error` at load with a
clear message rather than a `target-underdetermined` at step 6 in production.

`effectiveDigest = sha256(artifactDigest ‖ overlayDigest ‖ linkerVersion)` goes on every arm of every
result. Base ⊕ overlay means the base digest alone cannot answer "which bytes actually ran", and in a
regulated environment that question has to be answerable after the fact.

### 9.3 Why the vocabulary token is the hinge

The single most common per-tenant difference is a renamed label: "Member ID" vs "Member Number" vs
"Member #". Declared once as a token and referenced from every descriptor, detector, row key,
container matcher and checkpoint, **a nine-line overlay fixes a whole tenant**. Two alternatives were
rejected:

- **`oneOf` widening on each matcher** (the spine's original mechanism) accumulates every tenant's
  wording into the **base** matcher, so discrimination degrades monotonically as tenants are added -
  the opposite of its own fail-closed rule - and the same alternative has to be added at the
  descriptor, the assert, the checkpoint and the row key separately.
- **Per-site descriptor addition alone** cannot reach detectors at all. In one rival design a literal
  referenced from both a descriptor and four detectors was, by its own linker rule, un-retargetable -
  so the most common per-tenant change was inexpressible via overlay on its own showcase artifact.

Resolution keeps the spine's rule: **the first synonym that resolves a unique node wins; if two
synonyms resolve DIFFERENT nodes, that is an ambiguity, not a preference.**

### 9.4 The fingerprint drift signal

Per `(stepId, descriptorId)` the run records the descriptor's verdict and, when it resolved, a hash of
the observed name and its evidence source. That folds into a per-step fingerprint over **interactive
nodes plus the screen/route id, excluding the branding band** (§5.5). Divergence is the fraction of
descriptor verdicts that changed against the artifact's recorded fingerprint.

- Below the threshold: reported on every result arm, including `ok`, and nothing happens.
- Above: `needsSpecialization: true`. **A ticket, not an outage.** The run still completes or fails on
  its own merits; nothing self-repairs, nothing loosens a target, nothing falls back.

[spike, terminal §3.4] measured what this looks like across two tenants of one vendor product: fields
moved two columns left and one row down, widths 12→10 and 28→24, labels shortened, the exit key F3→F12
- and the detector recovered the same two fields, the same three controls, the same roles and the same
capacities. `button:exit` was **identical across both tenants although the keystroke changed**, so an
artifact step that says *activate the control named Exit* replays unmodified on both and the driver
resolves F3 vs F12 from the legend at replay time. **That is a per-tenant difference that needs no
overlay at all** - and it is why the artifact says `activate` and the F-keys live at the port (§3).
The two label changes are precisely what an overlay is for.

---

## 10. The linker and the save-time invariants

### 10.1 The linker

`link(contract, artifact, overlay, surfaceCapabilities, args) → LinkedProgram | LinkError[]`

Runs **before a browser is launched or a pty is spawned**. A `link-error` result has performed
**zero** actions, which is the difference between a bad artifact and a half-applied one - and it is
why `link-error` and `argument-invalid` carry `sideEffects: "none-guaranteed"` rather than leaving a
caller to infer it.

| # | Check |
|---|---|
| 1 | `schemaVersion` majors match the engine's. Unknown constructs are refused, never ignored |
| 2 | `artifact.digest` matches the JCS canonicalization of the document; ditto the overlay |
| 3 | `implements.contractDigest` matches the contract actually loaded |
| 4 | `Invocation.capability.contractDigest` matches it too → else `contract-stale` |
| 5 | every `ValueRef` resolves: a declared param, or an output written by a **strictly earlier** step |
| 6 | every output is written exactly once; an outcome's `capture` bindings live in a terminal namespace no step may reference |
| 7 | every `contract.outputs[]` has exactly one producing `ExtractSpec`, and their `ValueType`s match |
| 8 | every `OutcomeRule.code` names a declared `OutcomeDecl` on the pinned contract, and every `OutcomeDecl` is reachable from at least one step |
| 9 | rule priorities are unique within each step's own declared set (a tie there is a link error, not a runtime coin-flip) |
| 10 | no `Descriptor`, `ContainerMatcher` or `TextMatcher` string looks like a CSS selector, an XPath, a URL, or a `NodeId` |
| 11 | every `TargetRef` has ≥ 2 descriptors **after overlay merge**, ≥ `quorum.distinctEvidenceSources` distinct sources available, at least one descriptor of rank ≤ 3, and no `ordinal-in-container` as the only or highest-ranked one |
| 12 | a `geometric` descriptor's anchor is not itself `geometric` |
| 13 | `EffectSummary` is recomputed and matches both the artifact's stored copy and `contract.effect`; `contract.requiresApproval` matches |
| 14 | every `fill` literal is `sensitivity: "public"`; no `TextMatcher.value` matches an SSN, PAN, email or phone shape |
| 15 | `budgets.maxActions ≥ actingSteps + Σ(remedy.length × maxAttempts)`; every ledger finite and > 0. A program whose budget cannot cover its own declared recoveries is a link error, not a runtime surprise |
| 16 | remedies: ≤ 4 instructions, no `read`/`readTable`/`assert`, no nested recoveries, `afterRemedy === "reverify"` |
| 17 | every instruction kind, `ArtifactKey`, `Role`, container kind, descriptor kind and `SurfaceFeature` the program needs is present in `Surface.capabilities()`. "This program needs a descriptor kind this surface cannot resolve" is a **load-time error with a clear message**, not a mysterious `target-not-found` at step 6 |
| 18 | predicate depth ≤ 4; every `NormalizerId` / `ExtractorId` / `ParserId` exists at that major |
| 19 | every `restart-from-checkpoint` names a `resumeAt` in `flow.resumePoints` with no `WRITE_IRREVERSIBLE` between it and the recovery's step; every `restart-program` remedy sits at a pc ≤ `restartSafeUpToPc` |
| 20 | overlay patches address existing ids, are add-only or disable-only, change no effect class, no instruction, no checkpoint predicate and no outcome code |
| 21 | no artifact instruction uses an F-key (§3) |
| 22 | every `OutcomeRule` has `phase: "post"`, `requiresSettled: true`, and `allowUnsettled` is absent |
| 23 | `allowUnsettled: true` appears only on `band: "environment"` recoveries |
| 24 | every `readTable` `ExtractSpec` declares `rows` with `onTruncate: "fail"` and `maxRows` ≥ `minRows` ≥ 1 |
| 25 | `Step.expect` is present on every step (the type requires it; this is the JSON-level re-check). **And, where a step declares `expect.dialog`:** its `where` constrains `role: "dialog"` (a query that cannot select a dialog would leave a step declared on paper and undeclared in fact); a step whose postcondition is an OPEN dialog declares no `outcomes` and no `extract` (everything behind a modal is the state before it was raised - this is the half of "B2 before B3" the §4.4 amendment must not spend); and no program's LAST step ends with a dialog open, because the final postcondition is the state the automation hands back and a blocked screen is not one |
| 26 | `flow.entry.route` and every `navigate` route are in `policy.originAliases` and the caller's allowlist |
| 27 | in replay mode: `lifecycle.status === "approved"`, the signature verifies over the digest, and the signing key is trusted |
| 28 | **arguments bind**: every supplied argument satisfies `type`, `constraints` and `required` → else `argument-invalid`. A caller's bad member number costs zero actions |
| 29 | **`outcome-unproven`**: every `OutcomeRule` with `origin: "reviewer-authored"` is named by a `promotions[]` receipt whose `code` and `atStep` match and whose `proof.verdict` is present - and, in `replay` mode only, whose `proof.provenAt` contains the tenant being linked. Added by `docs/design/OUTCOME-PROMOTION.md`; a detector resolves its text through a vocabulary an overlay overrides per tenant, so a proof at one tenant says nothing about another. `discovery` and `verification` skip the tenant clause, as check 27 skips approval in `verification`, or the first promotion could never be verified at all |

### 10.2 Save-time invariants - the `proposed → draft` gate

These are the parts of the design not expressible in the type system. Each blocks the transition.

1. Every `TargetRef` has ≥ 2 descriptors and at least one of rank ≤ 3.
2. No `TargetRef` has `ordinal-in-container` as its only or highest-ranked descriptor.
3. No `WRITE_IRREVERSIBLE` step carries a recovery whose remedy is `actions`, or whose `resume` is
   anything other than `escalate`.
4. Every `restart-from-checkpoint` names a `resumeAt` in `flow.resumePoints` with no
   `WRITE_IRREVERSIBLE` between.
5. `allowUnsettled: true` only on `band: "environment"`.
6. Rule non-overlap within each band over the capability's frozen snapshot corpus (§4.6).
7. Predicate depth ≤ 4; no predicate references a param that does not exist.
8. **PII lint.** No `literal` `ValueRef` and no `TextMatcher.value` may (a) equal any value observed
   bound to a `sensitive` parameter during discovery, or (b) match the shapes for SSN, full account
   number, card PAN, email or phone. **Detector text must use `template` holes.**
9. `policy.requiresApprovalToken` is derived and matches the steps; `contract.effect` matches
   `EffectSummary.maxEffect`.
10. Every `ExtractSpec.output` names a declared contract output or outcome payload field, and is read
    at a step that exists.
11. **Every flow containing a `WRITE_IRREVERSIBLE` step declares at least one `ContinuityDef` and
    asserts it on that step's checkpoint.** The strongest control in the document must not be
    optional on exactly the flows it exists to protect (§4.5.2). If the confirmation screen genuinely
    does not name the record, the artifact cannot reach `draft` and a human must decide - which is
    the correct place for that decision, not a silent gap.
12. `verification.status === "verified"` with a recorded `grade`, and an approver who ticked
    `acknowledgedGrade` before `approved`.

---

## 11. Build order

Dependency-ordered work units. Each is independently implementable and testable; each has an
acceptance test that does not depend on the next one existing. **CP** marks the critical path to a
demonstrable end-to-end thread. **CUT-n** marks the cut order under time pressure - cut the highest
number first, and never cut a whole capability, only its depth.

| # | Unit | Package | Depends on | Acceptance test | CP | Cut |
|---|---|---|---|---|---|---|
| 1 | **Primitives + canonical JSON + digest.** JCS canonicalization, `sha256`, `Decimal`, branded ids, the normalizer/extractor/parser registries with golden vectors. | `core` | - | Registry golden-vector test; a digest-stability test that fails if any registered function's behaviour changes at the same major. | **CP** | - |
| 2 | **Schema.** Every type in §2.3-2.6 as zod, with `z.infer`'d `.d.ts`. Contract, artifact, overlay, result, policy, lease, journal. | `core` | 1 | Round-trip parse of a hand-written example of each document; every rejection case in §10 has a failing fixture. | **CP** | - |
| 3 | **Ports + a `MockSurface`.** `Surface`, `Observation`, `UINode`, `Action`, `ActResult`, `SurfaceCapabilities`, and an in-memory surface driven by a list of frozen Observations. | `core` | 2 | The mock satisfies the port; a scripted 9-step run drives it end to end. | **CP** | - |
| 4 | **The classifier.** Bands G/B0-B6, `Verdict`, provenance-aware rows 4-vs-5, phase, `requiresSettled`, `ambiguous-classification`, budgets as counters. | `core` | 3 | ~40 frozen-Observation cases, one per row of §4.2, asserting the exact `Verdict`. **No browser.** | **CP** | - |
| 5 | **Target resolver.** Descriptors, `EvidenceSource`, quorum, `assert`, `NodeFingerprint`, the four resolution outcomes. | `core` | 3 | Frozen-Observation cases for resolve / not-found / ambiguous / underdetermined / assert-failed, including a correlated-descriptor case that must return `underdetermined`. | **CP** | - |
| 6 | **Extractor + prose renderers.** `ExtractSpec` evaluation, `readTable` bounds, `renderTarget` / `renderPredicate` / `renderVerdict`. | `core` | 4, 5 | Extraction cases incl. truncation → `output-extraction-failed`; a renderer snapshot test asserting **no parameter value** appears in any rendered string. | **CP** | - |
| 7 | **The linker.** All 29 checks, `analyzeEffects`, `restartSafeUpToPc`, overlay merge + re-link. | `core` | 2, 5 | 29 tests, one per check, each with a fixture that must fail it and one that must pass. | **CP** | - |
| 8 | **Policy engine + taint.** `check`, allowlist, risk classes, `TaintHandle`, mask-region derivation. | `core` | 2 | Refusal case per `PolicyDenialReason`; the chokepoint contract test; the `WithApproval<C>` type test. | **CP** | - |
| 9 | **`fixtures/corebank-web`.** Frameset, nested layout tables, generated ids, `<font>`, no test IDs, a native `confirm()`, an in-page modal, two tenant variants, and **per-session fault injection for all eight faults**. | fixture | - | Each fault reachable by a documented header/query; two variants serve materially different labels. | **CP** | - |
| 10 | **`surface-browser`.** CDP per-frame AX stitch, `ariaRole` null for internal roles, frame-name `containerPath`, geometry on actionable nodes, `page.on('dialog')` ownership, `perceive` deadline, masked capture. Driver rules D1-D7. | `surface-browser` | 3, 9 | A `perceive()` over the fixture returns the expected node count and roles; the layout-table case resolves to exactly one row; a held-open `confirm()` returns `perceive-timeout` rather than hanging; the **PNG-decode** mask test. | **CP** | - |
| 11 | **The interpreter + runtime.** The §3.1 cycle, settle loop, budget ledgers, lease, journal writer, evidence sink, file-backed store, `crr replay`. | `runtime` | 4-8, 10 | The happy-path 9-step flow returns `ok` with typed outputs against the fixture; three fault scenarios return the right arm. | **CP** | - |
| 12 | **Result contract + catalog + `renderForAgent` + codegen.** `invoke`, the digest pin, the four arms, the tool-definition projection, `pnpm codegen`. | `runtime` | 11 | A type test that adding an `OutcomeDecl` breaks a call-site `switch`; a stale-digest test returning `contract-stale`; a `renderForAgent` test asserting no step id, descriptor or `withhold` output appears. | **CP** | - |
| 13 | **Discovery loop + VCR.** Five tools, the filtered projection, the manual Anthropic loop, transcript record/replay, prompt caching. | `discovery` | 3, 8 | The loop completes the fixture goal **from a VCR fixture with no API key**; a tool-schema regression test. | **CP** | - |
| 14 | **Synthesis.** `deriveDescriptors`, parameterization, route canonicalization, `analyzeEffects`, artifact emission. | `discovery` | 5, 7, 13 | Frozen-Observation derivation tests; a parameterization test asserting the recorded value appears **nowhere** in the emitted artifact. | **CP** | - |
| 15 | **Verification replay + lifecycle.** `replay-full` / `replay-dry` / `replay-reset`, grade, signing over the digest, `approve`. | `runtime` | 11, 14 | A write flow reaches `partial-up-to-irreversible` and **does not** perform the write twice; an edited approved artifact fails the digest check. | **CP** | - |
| 16 | **Lease + escalation + operator console.** States, transitions, intervention brief, the six routes, action injection, the seven-step resume re-check. | `runtime` | 11 | A suspend → claim → human action → hand-back → resume run, with the precondition re-check failing correctly when the human navigates away. | **CP** | - |
| 17 | **Conformance suite + mutants.** Fault scenarios × engines, the nine weakened engines of §4.8, the meta-test. | `conformance` | 4-6, 11 | Every mutant fails at least one scenario; the meta-test fails if they all pass. | **CP** | - |
| 18 | **Evidence bundle.** Discovery log, replay log, an error-state replay, the example artifact, the redaction canary. | `runtime` | 11, 13, 15 | `pnpm demo` produces the bundle with no live services; the canary grep finds nothing. | **CP** | - |
| 19 | **Overlay + second tenant.** The second fixture variant end to end with a vocabulary overlay, plus the drift/fingerprint report. | `core`, fixture | 7, 11 | One artifact replays green on both tenants; divergence is reported and `needsSpecialization` is not set. | - | CUT-5 |
| 20 | **`fixtures/corebank-tui`** at two screens with four fault modes, `TerminalTransport` (pipe), `@xterm/headless`, `detect()` ported to TS. | fixture, `surface-terminal` | 3 | 31 detector assertions over frozen grids; the torn-read case fails the checkpoint. | - | CUT-4 |
| 21 | **Terminal `act()` + one recorded terminal artifact** through the same engine and the same conformance scenarios. | `surface-terminal` | 20, 11 | The same `activate` step lowers to `pressKey(F5)` on the grid and to a click on the browser; both replay green. | - | CUT-3 |
| 22 | **Multi-run stability.** N replays, flake rate, per-descriptor degradation report. | `conformance` | 17 | A stability report with the command that produced it. | - | CUT-2 |
| 23 | **`openai` adapter** + one cross-provider discovery run. | `discovery` | 13 | The same loop completes against a second provider. | - | CUT-1 |

**The demonstrable end-to-end thread is units 1-18.** It touches every core requirement of the
assignment: goal-driven loop (13), structured artifact (14), deterministic replay with typed
outputs and three-way error handling (4, 11, 12), safety (8, 15), evidence (18), and escalation
(16).

**Cut order, and what each cut costs.** CUT-1 (`openai`) costs the "not provider-coupled" claim,
which becomes a design assertion rather than a measured one. CUT-2 (stability) costs a number, not a
capability. CUT-3 (terminal `act`) reduces the terminal surface from *the port is falsified* to *the
port is falsified for perception*, which is still worth more than a paragraph. CUT-4 (the terminal
fixture entirely) means §3.7 of the assignment is answered by design only, and it is the first cut
that makes a claim in REPORT §4 weaker rather than absent - take it only if 1-18 are at risk. CUT-5
(the second tenant) is the last thing to cut because a single overlay demonstration is the entire
multi-tenant answer and it costs about a day given that the fixture variant already exists.

**What must never be cut, at any depth:** the classifier's three-way split (4), descriptor agreement
(5), the policy chokepoint (8), the typed result contract (12), the escalation path (16), and the
conformance meta-test (17). Those are the six things the assignment's evaluation criteria weigh
first, and each already has a thin version in the list.

---

## 12. Decisions, amendments, and accepted limits

### 12.1 Where the judges disagreed - the call, and the trade-off in one sentence

1. **Spine: `failure-first`.** Four of five on-call questions are taxonomy questions, and its 34-row
   enumeration, defended band order and W1-W7 decomposition are original analysis the other two
   cannot reconstruct - the trade is that everything it lacked (a typed result, evidence sources,
   generated prose, escalation) is *additive*, whereas adopting either rival as the spine means
   retrofitting delta, continuity, effect-in-doubt and the band model into a fixed precedence order.
2. **Four result arms, not three.** `suspended` ships, against the spine's own argument - the trade
   is one more branch every caller must handle, bought by never telling an agent `failed` about a run
   a human is about to finish.
3. **Detectors move out of the contract onto the step.** The trade is a link check (8) joining two
   documents by code, bought by a contract that can be published surface-free and implemented by two
   programs.
4. **Typed outcomes with a runtime digest pin.** The trade is a `pnpm codegen` step and a pinned
   digest in every `Invocation`, bought by making a stale generated type a **loud** `contract-stale`
   failure instead of a silently degraded string comparison.
5. **`INVALID_INPUT` is `failed / argument-invalid`, not a business outcome.** The trade is that the
   caller reads two arms instead of one for "why didn't I get outputs", bought by not mixing "the core
   has never heard of this member" with "you put letters in a digits field", and by being able to say
   `sideEffects: "none-guaranteed"` out loud.
6. **F-keys at the port, `activate` in the artifact.** The trade is one extra lowering rule in each
   driver, bought by a program that is correct at both riverbend (F3) and summit (F12) with no
   overlay - which the terminal spike measured.
7. **Vocabulary tokens replace `oneOf` widening.** The trade is one indirection between a matcher and
   its text, bought by an overlay that fixes a tenant in nine lines and by base matchers that do not
   accumulate every tenant's wording until they discriminate nothing.
8. **No majority-vote quorum, on any step class.** The trade is refusing runs a fallback would have
   completed, bought by never speaking a wrong member's balance to a member on the phone.
9. **No `wait` remedy.** The trade is losing an obvious-looking recovery, bought by removing the one
   rule that becomes an unbounded retry loop in every system that permits it - `SettlePolicy` already
   expresses waiting, and stacking both gives one step two knobs and 22 seconds of stall.
10. **`ambiguous-classification` is a hard stop, not declaration order.** The trade is a run that
    refuses where a rival would have answered, bought by never settling a taxonomy tie by array index
    and shipping the result to a member.
11. **No `grid_region` descriptor.** The trade is that the terminal surface has one fewer descriptor
    kind, bought by not shipping the least portable construct available as the portability credential
    - the spike measured that not one coordinate matched across two tenants of one product.
12. **Six packages, purity as the boundary.** The trade is a large `core` and a large `runtime`,
    bought by "core is pure" being a statement about a directory that a contract test can enforce.
13. **A DECLARED dialog is a postcondition; every other dialog is still an interruption**
    (`Checkpoint.dialog`, §2.4 and §4.4). The trade is one optional field, one stand-down in band B2
    and one clause in band B5, bought by a modal confirmation being expressible at all - without it
    the only reachable shape was an interception recovery whose remedy performed the irreversible
    write, which §3.5 forbids and should. The alternative considered and rejected was a
    `resume: "continue"` recovery mode: it is a larger language change (a new control-flow edge in
    the interpreter, a new case for the restart gate and the remediation ledger), it labels the most
    consequential act in the flow as "a recoverable condition was remedied", and it puts the write
    inside a construct whose entire contract is *clear an obstacle and hand control back*. §7.4's
    gap is real and stays open, because it is a different problem.

### 12.2 Amendments to `.private/BRIEF.md`

- **§3.4 (record-then-immediately-replay) is unsound as written for irreversible flows.** The
  verification replay would perform the write a second time - the mechanism proving the artifact is
  faithful would itself be an unapproved, unattended, duplicated irreversible write. §6.6 replaces it
  with three declared modes and a `grade` an approver must tick. All three proposals reached this
  amendment independently, which is the evidence that the brief is wrong there and not that the spec
  is being convenient.
- **§3.1's two-operation `Surface` port grows to four.** `perceive` takes a deadline, `act` takes the
  lease token, `capture` is separate, and `capabilities()` is advertised. Each addition is forced:
  a native dialog makes `perceive` hang rather than fail; a lease the driver does not check is a
  control model nothing enforces; a capture inside `perceive` puts pixels in the decision path; and
  without `capabilities()` a browser-derived artifact dies at step 6 instead of at load.
- **§3.8's overlay is narrowed and widened at once.** Narrowed: no `oneOf` widening of base matchers.
  Widened: `disableDescriptors`, because an add-only overlay cannot repair an `ordinal-in-container`
  that a new tab made ambiguous, and the alternative is a re-record for a benign tenant difference.

### 12.3 Accepted limits - the things that would make me uncomfortable in a review

1. **`effect` is declared, never proven.** The policy chokepoint, the restart gate, the approval blast
   radius and every irreversibility invariant rest on a field the recorder wrote. A step marked
   `READ` that posts an audit row is invisible to all of it. Mitigations in §8.2 are a browser-only
   heuristic, a human tick, and an audit record - none of them a proof.
2. **W7 is undetectable by construction.** If the surface carries no evidence that the wrong record
   was touched, no pure function over the surface can find out. The approval gate and the mandatory
   confirmation-screen continuity assertion are the mitigation; reconciliation belongs in the calling
   product.
3. **Fail-closed decays toward "everything is a hard failure."** Every unrecognised screen needs a
   human to add a rule and cut a version. If nobody staffs that review the capability degrades into
   one that fails a lot and gets turned off. The mitigation is a metric, not a mechanism.
4. **Non-overlap is verified against a corpus the same person wrote.** Two rules can be provably
   non-overlapping over 40 frozen snapshots and overlap on snapshot 41. `ambiguous-classification`
   catches it at runtime - before returning an answer, which is the improvement - but the corpus is
   still the author's.
5. **Continuity requires the identifying value to be visible.** Many back-office screens show a name
   and not an id. Where identity is not on screen, invariant 11 blocks a write artifact from reaching
   `draft` and a human must decide. That is the correct place for the decision and it is also a real
   operational cost.
6. **Suspension holds a live session across an agent turn.** One browser or pty per parked run, and
   the underlying session can expire while suspended, converting a suspension into a failure. Bounded
   by two TTLs; callers must be told.
7. **The PII lint is shape-based and will both miss and over-trigger.** It is a backstop for
   parameterization, not a substitute for it.
8. **No concurrency story.** A hundred simultaneous invocations of one capability against a legacy
   core sized for forty tellers is the first production incident. Legitimately out of scope per the
   anti-goals, and a real gap in a real deployment - named here so silence is not mistaken for
   coverage.
9. **Chromium-only browser perception.** CDP is not available on Firefox or WebKit. Depth of
   perception over browser breadth is the right trade for a fleet of internal bank apps; it is a
   trade, not a free lunch.
10. **Overlays cannot add outcomes.** One tenant with a genuinely unique business answer forces a
    contract bump that ripples to every other tenant's callers. Accepted because the alternative - a
    caller receiving an outcome it has never heard of, at one institution only - is worse. It is the
    constraint most likely to be relitigated in production.
11. **`effect-in-doubt` hands a human a problem with no tooling attached.** It correctly refuses to
    guess and then stops. Better than guessing; not good enough.
12. **`replay-dry` is a weaker claim than `replay-full`, and the grade is doing real work.** If an
    approver treats `partial-up-to-irreversible` as "verified", the §6.6 fix is decorative.

---

## 13. Open questions - flagged for a human decision

These are genuinely unresolved. An implementation agent should **not** decide them alone.

1. **Is `MEMBER_RESTRICTED` an outcome or a failure?** It ships as an outcome with
   `callerAction: "refer-to-specialist"` on the argument that a record-scoped denial is a *fact about
   the record* the member should hear. The counter-argument is that the agent's next move -
   hand off to a human - is the same one a failure would trigger, and that outcomes should be
   reserved for answers the agent can act on itself. Getting this wrong in either direction is
   survivable; getting it *inconsistent* across capabilities is not.
2. **Should every declared outcome be evaluated at every step, or only where scoped?** Per-step
   scoping is tighter and catches "MEMBER_NOT_FOUND appeared at a step where it is impossible", which
   is a genuine artifact bug. It is also more to maintain and more to get wrong, and a scoping mistake
   silently disables a detector. The spec ships per-step; this needs a second opinion.
3. **Is the no-branching cut too aggressive?** It is the cut with the weakest defence. It buys the
   static effect analysis and the restart gate (§3.7), which are load-bearing - but a flow with an
   optional "accept terms" screen is not really a decision, and modelling it as a recovery is a
   slight abuse of the concept. If it turns out that half of real flows need one optional screen, the
   answer is a `skipIf` guarded to a single declared predicate over the *current* observation, and
   that is a language change that should be decided deliberately rather than added under pressure.
4. **What is the divergence threshold for `needsSpecialization`?** The spec deliberately names none.
   The terminal spike measured 63% over all nodes and 40% over interactive nodes for two tenants of
   one product that a single overlay handles comfortably - so the honest answer is that the threshold
   must be tuned against the conformance corpus, and any number written now would be invented.
5. **Who holds the approval signing key, and what is the rotation story?** The spec signs a digest
   with ed25519 and stops there. Approval is only as good as the key custody around it, and this
   design does not build one. A production answer needs an HSM or a KMS and a revocation path for a
   compromised approver.
6. **Should `SettlePolicy.stableSamples` default to 2 or 3?** Named as a default *to be tuned against
   the conformance corpus*, and there is no measurement yet. Two is cheaper and racier; three costs a
   poll interval on every step of every run. The slow-load and torn-read scenarios will decide it,
   and until they run, 2 is a placeholder rather than a decision.
7. **Does `agentDisclosure` belong on the output, or on the caller?** It ships on the `OutputSpec`
   because one person reviewing the contract should decide once what a model may see. The counter is
   that the same capability serves a live chat turn (where masking a member name is right) and an
   internal batch reconciliation (where it is obstructive), and that this is therefore a
   caller-declared policy like `onIntervention`. Both are defensible; the spec picks the safer one.

---

## 14. Provenance of this document

`docs/design/JUDGING.md` records what each of the three proposals argued, what each of the three
judges scored and criticised, which proposal became the spine, and which mechanism was grafted from
where. It is internal and not part of the submission; it exists so that every decision above can be
traced to the argument that produced it, including the ones that went against the spine.
