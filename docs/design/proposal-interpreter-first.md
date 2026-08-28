# Proposal: design the artifact by designing its interpreter first

**Status: proposal. Nothing described here is built yet.** No line of this document is a claim about
running code. Where it says "the linker refuses X", read "the linker is specified to refuse X, and
the check is listed in §6.7 so a reviewer can grade the implementation against it later."

This is one of several competing design proposals for `capability-record-replay`. It takes a single
angle deliberately: **the recorded artifact is a small typed program, and the replay engine is its
interpreter.** Every schema decision below is derived from that, and where the derivation produces an
uncomfortable answer, the answer is kept and the discomfort is documented rather than smoothed over.

### Where to find each required item

| # | Required item | Section |
|---|---|---|
| 1 | Organizing thesis | [§1](#1-thesis) |
| 2 | Full artifact schema as real TypeScript + filled-in example | [§6](#6-the-artifact-schema), [§7](#7-a-real-artifact-member-savings-lookup) |
| 3 | Replay result contract | [§8](#8-the-replay-result-contract) |
| 4 | Observation / Action port types | [§4](#4-the-ports-observation-and-action) |
| 5 | Locator / target representation and its reasoning | [§5](#5-targets-how-a-step-names-a-control) |
| 6 | Workspace package layout | [§10](#10-workspace-layout) |
| 7 | What was deliberately left out of the schema, and why | [§11](#11-refusals-what-is-not-in-the-language) |
| — | Where I think a settled decision needs amending | [§12](#12-one-settled-decision-i-would-amend) |
| — | Risks and honest limits | [§13](#13-risks-and-limits) |

---

## 1. Thesis

**Determinism is a property you get by refusing to express nondeterminism, not a property you get by
writing careful engine code.** So design the interpreter first and let the artifact schema be exactly
the serialized form of what that interpreter can execute — no more. The artifact is a program in
`CRR/1`: a straight-line, total, single-assignment, effect-annotated instruction sequence with no
loops, no conditionals, no expression language, no regexes, no selectors, no sleeps, and no clock.
Every place where a real-world UI automation system would normally reach for a runtime decision —
"which selector wins", "how long to wait", "is this an error or an answer", "should I retry" — is
pushed into *declared data* that the interpreter evaluates by one fixed rule, or is removed from the
language entirely. The payoff is not aesthetic: because the language is straight-line and every step
declares its effect class, **the complete set of side effects a capability can perform is computable
by static analysis before the first action fires**, which is what makes a signed approval over a
content digest mean something in a regulated environment. The cost is real too, and it is paid in one
currency: flows that genuinely branch must be decomposed into several capabilities, and the branching
lives in the calling agent. That is the correct place for it. **The calling agent is a Turing machine.
The capability must not be.**

---

## 2. The machine

### 2.1 What the interpreter carries

Nine fields. Nothing else is state; everything else is derived from the program text or from the
current `Observation`.

```ts
interface MachineState {
  /** Program counter. Monotonically increasing. There is no instruction that can lower it. */
  pc: number;

  /** Single-assignment binding environment. A name is written by exactly one `read`/`readTable`
   *  step and never overwritten. No mutation ⇒ no order-dependent value ⇒ no aliasing bugs. */
  env: ReadonlyMap<BindingName, BoundValue>;

  /** Per-(step, recovery) attempt counters. Keyed `${StepId}/${recoveryName}`. Only ever grows,
   *  and is checked against the rule's `maxAttempts` before a remedy runs. */
  attempts: ReadonlyMap<string, number>;

  /** Monotonically decreasing. Actions, observations, wall-clock ms, recovery excursions.
   *  Nothing refills a ledger; exhaustion is a typed terminal result, never a hang. */
  ledger: BudgetLedger;

  /** Who is permitted to act right now. The executor rejects any action presented without the
   *  current lease token, including its own. Enforcement, not convention. */
  lease: LeaseSnapshot;

  /** Monotonic sequence for observations. The journal orders by this, not by wall clock, so two
   *  replays of the same program produce byte-comparable journals modulo timing fields. */
  observationSeq: number;

  /** Accumulating record of how every descriptor voted at every resolution. Hashed at the end and
   *  compared against the artifact's recorded fingerprint to produce the drift signal. */
  fingerprint: FingerprintAccumulator;

  /** Program-attempt counter, owned by the supervisor rather than the interpreter (see §2.5). */
  attempt: number;

  /** Append-only. The only impure thing in the loop besides the Surface. */
  journal: JournalWriter;
}
```

The decision core is a pure function in the same shape the sibling repo uses for its outbox reducer:

```ts
function decide(state: MachineState, obs: Observation, nowMs: number): Decision;
```

`nowMs` is an argument, not a call to `Date.now()`. `Math.random` does not appear. There is no
`fetch`, no `setTimeout`, no filesystem access anywhere in the decision module, and that is meant to
be enforced by a source-scanning contract test rather than asserted in a README — the same move as
`durable-agent-outbox`'s `test_engine_has_no_web_or_llm_imports`.

### 2.2 The cycle

```text
                              ┌──────────────────────────────────────────┐
  pc ──────────────────────►  │  step = program.steps[pc]                │
                              └──────────────────────────────────────────┘
                                                │
        ┌───────────────────────────────────────┼───────────────────────────────────────┐
        │  1. LEASE      lease.holder === 'automation' ?          no → CONTROL_LOST      │
        │  2. OBSERVE    obs ← surface.observe()                  (charges observations) │
        │  3. CLASSIFY   classify(obs, step, env, phase='pre')                           │
        │                    ├─ Outcome  → terminal, return outcome                      │
        │                    ├─ Recovery → run remedy (budgeted) → goto 2                │
        │                    └─ None     → continue                                      │
        │  4. PRECOND    eval(step.precondition, obs, env) ?      no → PRECONDITION_FAILED│
        │  5. RESOLVE    node ← resolve(step.target, obs)   ← ONE snapshot, all descriptors│
        │                    ├─ disagree → TARGET_AMBIGUOUS      (refuse to act)          │
        │                    ├─ nothing  → TARGET_NOT_FOUND                               │
        │                    └─ thin     → TARGET_UNDERDETERMINED                         │
        │  6. LOWER      action ← lower(step, node, env)                                  │
        │  7. POLICY     policy.check(action, ctx) ?              no → POLICY_DENIED      │
        │  8. ACT        r ← surface.act(action)                  (charges actions)       │
        │  9. SETTLE     until step.expect.settleMs exhausted:                            │
        │                    obs' ← surface.observe()                                     │
        │                    classify(obs', step, env, phase='post')                       │
        │                       ├─ Outcome  → terminal                                     │
        │                       ├─ Recovery → remedy → re-verify this step from 2          │
        │                       └─ None     → expect.predicate(obs') ? done : poll         │
        │                 exhausted → CHECKPOINT_UNMET{reason:'timeout'}                   │
        │ 10. BIND       read/readTable only: extract → normalize → typecheck → env        │
        │ 11. JOURNAL    append; fold fingerprint                                          │
        └────────────────────────────────────────────────────────────────────────────────┘
                                                │
                                          pc ← pc + 1
```

Steps 5–8 are skipped for the instructions that do not act (`assert`, `read`, `readTable`); those
steps go straight from the precondition to the settle loop and then to binding. `navigate` resolves a
route rather than a node. Everything else in the cycle runs for every instruction, including the
lease check and the pre-action classification.

Two things in that diagram are load-bearing and are the parts most designs get wrong.

**Classification runs before the action, not only after it.** A session-expiry banner or a
maintenance interstitial that is already on screen when the step begins must be handled, not clicked
through. Post-only classification produces the exact failure mode this project exists to prevent: a
click that lands on the wrong thing because the screen was not the screen the program thought it was.
Rules carry a `phase` (`'pre' | 'post' | 'both'`) so a `MEMBER_NOT_FOUND` detector does not fire
before the search that would produce it. Defaults: outcomes `'post'`, recoveries `'both'`.

**All descriptors resolve against one observation snapshot.** If the resolver re-observed between
descriptors, two descriptors could legitimately disagree because the page changed underneath them,
and the whole quorum mechanism would be measuring latency instead of ambiguity.

### 2.3 The one branch in the entire system

There is exactly one conditional in the design, it lives in the interpreter rather than in the
program, and its shape is fixed:

```ts
type Classification =
  | { kind: 'outcome';  rule: OutcomeRule;  matched: PredicateTrace }
  | { kind: 'recovery'; rule: RecoveryRule; matched: PredicateTrace }
  | { kind: 'none' };

function classify(
  obs: Observation, step: Step, env: Bindings, phase: 'pre' | 'post'
): Classification | AmbiguityError;
```

`classify` is pure over one `Observation`. That single fact is what makes the entire error taxonomy
unit-testable from frozen JSON snapshots with no browser and no pty running, which is in turn what
makes the mutant conformance suite in the build brief buildable at all.

**Precedence: outcomes → recoveries → checkpoint.** Outcomes go first because a business outcome is
strictly more specific than a checkpoint and the checkpoint may well pass anyway. "The results page
loaded" is true on a page that says *no member found*; the checkpoint would happily proceed and the
next step would fail with a confusing target error instead of returning the answer the caller needed.

**Multiple matches are an error, not a race.** `classify` evaluates every rule at the step and
collects all matches. If more than one matches, it consults the declared `priority` (lower wins). If
the matched rules do not form a total order — a tie — the interpreter returns
`AMBIGUOUS_CLASSIFICATION` and stops. It never resolves ambiguity by array order. This is the same
principle §3.2 of the build brief applies to locators, applied to detectors: **disagreement is a
signal, not something to silently break.**

### 2.4 How control flow is bounded

| Mechanism | Bound | What exhaustion produces |
|---|---|---|
| Straight-line program | `steps.length`, fixed at link time | — (program simply ends) |
| Checkpoint settling | `expect.settleMs` per step, polled at engine cadence | `CHECKPOINT_UNMET{timeout}` |
| Recovery excursion | `maxAttempts` per (step, rule) | `RECOVERY_EXHAUSTED` |
| Recovery remedy body | ≤ 4 instructions, non-recursive, no `read`, no nested recoveries | link error if violated |
| Global recovery count | `budgets.maxRecoveryExcursions` | `BUDGET_EXHAUSTED` |
| Actions | `budgets.maxActions` | `BUDGET_EXHAUSTED` |
| Observations | `budgets.maxObservations` | `BUDGET_EXHAUSTED` |
| Wall clock | `budgets.maxWallClockMs` | `BUDGET_EXHAUSTED` |
| Program restart | `budgets.maxProgramAttempts`, default `1` (off) | `RECOVERY_EXHAUSTED` at the triggering step |

Termination argument, stated plainly so it can be checked: `pc` strictly increases and is bounded by
`steps.length`; every excursion from a step is bounded by `maxAttempts` and by the global excursion
budget; every wait is bounded by a finite `settleMs`; every ledger is monotonically decreasing and
never refilled. There is no construct in the language that can lower `pc`, and no construct that can
increase a budget. Therefore every program terminates, and it terminates with a typed result. **There
is no code path in the interpreter that hangs.**

### 2.5 The one backward edge, and why it is not in the language

Session timeout is the case that tempts every designer into a jump. You are at step 7, the session
dies, you log back in, and now you are on the dashboard, not on step 7's screen. You need steps 1–6
again.

The design refuses to give the *interpreter* a backward edge. Instead, a recovery rule may declare
`remedy: { kind: 'restart', scope: 'program' }`. That is not a jump; it is the interpreter returning
`RestartRequested` to its supervisor, which **discards the machine entirely and constructs a new one
at `pc = 0`** with the same arguments, a fresh session, and `attempt + 1` — subject to two gates:

1. `budgets.maxProgramAttempts` has room, and
2. **a static, pc-indexed effect check**: `steps[0 .. pc-1].every(s => s.effect !== 'WRITE_IRREVERSIBLE')`.

Gate 2 is only possible because effects are declared statically and the program is straight-line. A
program that has already opened a sub-account cannot be restarted, and the linker can tell you which
steps make that true before you ever run it. If the gate fails, the recovery degrades to
`escalate` — a human, not a retry.

So: **the interpreter has no backward edge; the supervisor has exactly one, it is budgeted, and it is
gated on a static analysis the language makes possible.** The straight-line property is what buys the
gate. This is the clearest example in the design of a refusal paying for a safety property.

### 2.6 Waiting

**There is no `sleep` instruction, and there never will be.** Fixed delays are the single largest
source of both flake and wasted wall-clock in recorded automation, and a recorded sleep encodes the
recording machine's load into the artifact forever.

Waiting is a property of a checkpoint: poll until the declared predicate holds, or until `settleMs`
is spent. Transient slowness is therefore **not a recovery** — it needs no remedy, it is simply the
settle budget doing its job. A recovery exists only for a condition that requires you to *do*
something. Keeping "wait and retry" out of the recovery vocabulary removes the most common
degenerate recovery rule, the one that turns into an unbounded retry loop in every system that
allows it.

"Settled" itself is surface-owned, not program-owned: `Observation.stability.quiescent`. The browser
surface computes it from navigation/network idleness plus two identical consecutive accessibility
generations; the terminal surface computes it from a quiet pty and a parked cursor. The program says
*how long it is willing to wait*; the surface says *what settled means*. That split is what lets one
budget number mean something on both.

---

## 3. The instruction set

Nine instructions. Each one exists because it has a *distinct postcondition* — that is the admission
criterion, and it is the reason `fill` / `select` / `setToggle` are not collapsed into one `setValue`
opcode despite the temptation. The interpreter's job is to verify what it just did; an opcode with
three different postconditions is an opcode that cannot be checked.

| Instruction | Effect class | Acts? | Writes `env`? | Postcondition the interpreter verifies |
|---|---|---|---|---|
| `navigate` | `READ` \| `WRITE_REVERSIBLE` | yes | no | location matches the declared route **and** `expect` |
| `click` | any | yes | no | `expect` |
| `fill` | any | yes | no | the target's `value` matches the written value (normalized) **and** `expect` |
| `select` | any | yes | no | the target's selected option name matches **and** `expect` |
| `setToggle` | any | yes | no | the target's `checked` state equals the declared boolean **and** `expect` |
| `pressKey` | any | yes | no | `expect` |
| `read` | `READ` | no | yes | value extracts, normalizes and typechecks **and** `expect` |
| `readTable` | `READ` | no | yes | row count within `[minRows, maxRows]` **and** `expect` |
| `assert` | `READ` | no | no | `expect` (this instruction is nothing but a checkpoint) |

Notes on the individual choices:

- **`setToggle` sets a state; it does not toggle.** `toggle` is order-dependent and therefore not
  replayable — replaying a toggle against a screen that already remembered the user's last choice
  produces the opposite result. `setToggle{checked:true}` is idempotent by construction, and its
  postcondition is checkable.
- **`fill` replaces; it does not append.** `mode: 'replace'` is the only value in v1. Appending
  depends on the field's prior content, which is exactly the kind of hidden input a deterministic
  language must not have. The field exists so that a future `'append'` is a schema change rather
  than a surprise.
- **`pressKey` takes a closed key enum, not characters.** Typing text is `fill`. `pressKey` covers
  `Enter`, `Tab`, `Escape`, arrows, `Home/End/PageUp/PageDown`, and `F1`–`F12`. The function keys
  are not decoration: on a green-screen surface the PF keys *are* the submit mechanism, and without
  this instruction the terminal surface is inexpressible. This is the one instruction most likely to
  be abused as an escape hatch, so it is constrained the same way every other acting instruction is
  — it needs a target (or an explicit `null` target meaning "the surface's focused control"), an
  effect class, and a postcondition.
- **`readTable` is bounded iteration and is therefore allowed.** This is the one place the design
  bends and it is worth being precise about why it is not a loop: an `Observation` contains finitely
  many nodes, `readTable` walks that finite set once, and `maxRows` caps the result. It performs no
  actions and cannot re-observe. Iterating over *observations* — "for each row, click it and come
  back" — is the thing that is refused, because that iteration is unbounded in actions and destroys
  the static effect analysis. **Iteration over one observation is finite by construction; iteration
  over actions is not.**
- **There is no `switchFrame` / `focusWindow` / `enterScreen` instruction.** A mode-setting
  instruction gives the interpreter carried state that every subsequent instruction implicitly reads,
  and implicit carried state is where determinism dies — a step's meaning would then depend on
  instructions arbitrarily far above it. Instead, every `Target` names its container **absolutely**
  from the root (`ContainerRef`, §5.4). Frames on a legacy frameset, dialogs, native windows, and
  drawn boxes on a character grid all address the same way.
- **There is no `scroll` or `hover`.** Making a node actionable is the *surface's* obligation before
  it performs an action; if it cannot, it returns `NODE_NOT_ACTIONABLE` and the step fails with a
  clear reason. Scrolling as an instruction would hardcode a browser assumption into a language that
  also has to run on a 24×80 grid that pages with PF7/PF8.

### 3.1 Preconditions and postconditions

Every step carries both:

- **`precondition: Predicate | null`** — must hold *before* the action is lowered. Its job is not
  belt-and-braces: it is what makes a step safe to **resume**. When a human takes the control lease,
  does something, and hands it back, the interpreter re-verifies the current step's precondition
  rather than blindly continuing (build brief §3.5). Preconditions are also what makes a recovery
  remedy safe — after any excursion, control returns to the triggering step and its precondition is
  re-checked. A language whose steps declare what they require is a language whose execution can be
  interrupted.
- **`expect: Checkpoint`** — must hold *after*, within a declared settle budget. This is the
  brief's "checkpoint or success condition", except it is on **every** step rather than only at the
  end. A final-only checkpoint tells you the flow failed; a per-step checkpoint tells you *where*.

### 3.2 Recoveries: a restricted sublanguage, one level deep

```ts
type Remedy =
  /** ≤ 4 acting instructions drawn from the same instruction set, minus `read`/`readTable`/`assert`,
   *  and unable to declare recoveries of their own. Non-recursive by construction. */
  | { kind: 'actions'; instructions: RemedyInstruction[] }
  /** This condition is only fixable by a person. Raise an intervention with context. */
  | { kind: 'escalate'; reason: string; brief: string }
  /** Ask the supervisor to discard the machine and start over. Gated per §2.5. */
  | { kind: 'restart'; scope: 'program' };

interface RecoveryRule {
  name: string;                  // 'DISMISS_MAINTENANCE_NOTICE'
  phase: 'pre' | 'post' | 'both';
  priority: number;              // lower wins; ties at the same step are a link error
  detector: Predicate;
  remedy: Remedy;
  maxAttempts: number;
  /** The only legal value. It exists as a field so the constraint is visible in the artifact
   *  a human reviews, rather than buried in engine source: a remedy can never set the pc. */
  afterRemedy: 'reverify';
}

/** The restricted sublanguage a remedy may use. Note what is absent: `read`, `readTable`, `assert`,
 *  nested `recoveries`, and `outcomes`. A remedy cannot bind a value, cannot classify, and cannot
 *  recurse — it can only clear an obstacle and hand control back. */
type RemedyInstruction =
  | { kind: 'click';      target: Target }
  | { kind: 'pressKey';   target: Target | null; key: Key }
  | { kind: 'setToggle';  target: Target; checked: boolean }
  | { kind: 'select';     target: Target; optionName: TextMatcher }
  | { kind: 'fill';       target: Target; value: ValueRef; mode: 'replace' }
  | { kind: 'navigate';   routeId: RouteId };
```

`afterRemedy: 'reverify'` is the rule that keeps recoveries from being `goto` in disguise. A remedy
runs, and then control returns to the step that triggered it, which re-checks its precondition from a
fresh observation. A remedy cannot choose where execution continues.

### 3.3 What the interpreter can prove before it runs anything

Because the program is straight-line and each step declares an effect class, this is computable at
link time, not discovered at runtime:

```ts
interface EffectSummary {
  maxEffect: EffectClass;
  irreversibleSteps: StepId[];
  routesTouched: RouteId[];
  reads: { field: string; sensitivity: Sensitivity }[];
  requiresApproval: boolean;      // maxEffect === 'WRITE_IRREVERSIBLE'
  restartSafeUpToPc: number;      // largest pc from which §2.5's restart gate still passes
}
function analyzeEffects(program: Program): EffectSummary;
```

Three consumers, and each of them is a requirement in the brief:

1. **The policy chokepoint** can refuse a whole invocation up front instead of discovering the
   irreversible step halfway through, with three writes already applied.
2. **The approval UI** shows a reviewer the complete blast radius of what they are signing.
3. **The agent-facing capability catalog** publishes `maxEffect` and `reads[].sensitivity`, so a
   calling agent knows a capability writes — and what class of data it returns — *before* calling it.

**This is the single strongest argument against putting conditionals in the language.** With an `if`,
every one of those three becomes "somewhere between this and that, depending", and a signed approval
over a digest stops meaning anything precise.

---

## 4. The ports: `Observation` and `Action`

Everything above this boundary — the interpreter, the classifier, the resolver, the policy engine,
the recorder, the operator console — is written against these types and has never heard of a browser,
a pty, Playwright, CDP, or a DOM.

```ts
// ─────────────────────────────────────────────────────────────────────────────
// Observation — what the world looks like right now
// ─────────────────────────────────────────────────────────────────────────────

type SurfaceKind = 'browser' | 'terminal' | 'desktop';

interface Observation {
  surface: SurfaceKind;

  /** Monotonic within a session. Journals order by this, not by wall clock, so two replays of the
   *  same program produce comparable journals. */
  seq: number;

  /** Wall clock is carried for humans and for budget accounting only. Nothing in the decision
   *  core may branch on it. */
  capturedAtMs: number;

  /** Surface-computed settledness. The program declares how long it will wait; the SURFACE decides
   *  what "settled" means, because that differs completely between a page and a pty. */
  stability: {
    /** Increments whenever the surface believes the visible state changed. Two consecutive
     *  observations with the same generation are strong evidence of quiescence. */
    generation: number;
    quiescent: boolean;
    /** Why not, when false. Renders straight into a CHECKPOINT_UNMET failure. */
    pendingReason?: 'navigating' | 'network' | 'animating' | 'pty-active' | 'unknown';
  };

  /** Canonicalized identity of "where we are". Never a raw URL: a route pattern plus the concrete
   *  values that filled it, so /member/12345 and /member/99 are the same location with different
   *  params. This is where the canonicalization stretch goal lives structurally. */
  location: Location;

  /** Frames, windows, dialogs, drawn screen regions. Flat with parent links, addressed by path. */
  containers: Container[];

  /** FLAT, not a tree. Classifiers and resolvers are pure functions that scan; a flat array with
   *  parent links is both faster to scan and vastly easier to write a total predicate over than a
   *  recursive structure. Tree shape is recoverable from `parentId` when it is genuinely needed. */
  nodes: UINode[];

  /** Pointer to a screenshot / grid dump / AX dump in the evidence store. Never inlined: an
   *  Observation is passed to pure functions and must stay cheap to clone and to snapshot in a
   *  fixture file. */
  raw: EvidenceRef | null;

  /** Region masks already applied to `raw` because they are bound to sensitive values. Carried so
   *  the operator console and the journal writer cannot forget to honour them. */
  masked: Bounds[];
}

interface Location {
  /** Browser: a canonicalized path pattern, e.g. '/members/:memberId/accounts'.
   *  Terminal: a screen identity, e.g. 'MEMB01'.
   *  Desktop: a window class / view identifier. */
  route: string;
  /** The concrete values that were canonicalized out. Tainted if bound to a sensitive param. */
  params: Record<string, string>;
  /** Origin is NOT part of a route and NOT part of an artifact. It is per-tenant, per-app-instance
   *  configuration supplied at invocation and allowlisted by policy. This is precisely what lets
   *  one artifact serve hundreds of tenants without edit. */
  origin: string;
  title: string;
}

interface Container {
  id: ContainerId;
  parentId: ContainerId | null;
  kind: 'root' | 'frame' | 'window' | 'dialog' | 'region';
  /** Frame name / window title / dialog heading / detected box caption. */
  name: string;
  /** Index among same-kind siblings, for the ordinal descriptor of last resort. */
  ordinal: number;
  bounds: Bounds;
}

interface UINode {
  /** Valid ONLY within this observation. Deliberately not stable across observations, so that it is
   *  impossible to accidentally persist one into an artifact. The linker treats a NodeId-shaped
   *  string inside a Target as a link error (§6.7 check 10). */
  id: NodeId;

  containerId: ContainerId;
  parentId: NodeId | null;

  /** Closed, normalized role enum — a subset both a browser AX tree and a synthesized grid tree can
   *  produce. Not the full ARIA vocabulary; anything outside it maps to 'unknown'. */
  role: Role;

  /** Accessible name (browser) or detected label (grid). */
  name: string;

  /** WHY we believe that is the name. Feeds descriptor derivation, and feeds drift detection: a
   *  name whose source silently changed from a <label> to adjacent text is a real signal. */
  nameSource: NameSource;

  value?: string;
  textContent?: string;

  state: NodeState;

  /** Browser: CSS pixels. Terminal: character cells. One type, two units — declared, so nothing
   *  downstream can accidentally compare a pixel distance to a cell distance. */
  bounds: Bounds;
  boundsUnit: 'px' | 'cell';

  /** Index among same-role siblings within the same container. Deterministic, and the input to the
   *  lowest-ranked descriptor. */
  ordinal: number;

  /** Surface confidence that role/name were derived correctly. 1.0 for a browser AX node with an
   *  explicit label; lower for a grid heuristic. Descriptors below the surface's declared floor do
   *  not count toward quorum. */
  confidence: number;
}

type Role =
  | 'button' | 'link' | 'textbox' | 'searchbox' | 'combobox' | 'listbox' | 'option'
  | 'checkbox' | 'radio' | 'menuitem' | 'tab' | 'tabpanel'
  | 'table' | 'row' | 'cell' | 'columnheader' | 'rowheader' | 'grid' | 'gridcell'
  | 'heading' | 'text' | 'label' | 'alert' | 'status' | 'dialog' | 'form'
  | 'region' | 'navigation' | 'main' | 'banner' | 'progressbar' | 'image'
  /** Legacy <font>-soup and unlabelled grid runs genuinely have no defensible role. Forcing a guess
   *  would be worse than admitting it — but a Target may not carry role 'unknown' (link error). */
  | 'unknown';

type NameSource =
  | 'ariaLabel' | 'labelElement' | 'ariaLabelledBy' | 'title' | 'placeholder'
  | 'textContent' | 'columnHeader' | 'adjacentText' | 'legendKey' | 'none';

interface NodeState {
  disabled: boolean; focused: boolean; readonly: boolean; required: boolean;
  checked: boolean | 'mixed' | null; expanded: boolean | null;
  selected: boolean | null; invalid: boolean; busy: boolean; visible: boolean;
}

interface Bounds { x: number; y: number; w: number; h: number }

// ─────────────────────────────────────────────────────────────────────────────
// Action — the closed set of things anything is ever allowed to do
// ─────────────────────────────────────────────────────────────────────────────

type Action =
  | { kind: 'navigate'; location: { route: string; params: Record<string, string> } }
  | { kind: 'click';    node: NodeId }
  | { kind: 'setText';  node: NodeId; text: string; mode: 'replace' }
  | { kind: 'selectOption'; node: NodeId; optionName: string }
  | { kind: 'setChecked';   node: NodeId; checked: boolean }
  | { kind: 'pressKey'; node: NodeId | null; key: Key }
  | { kind: 'capture';  scope: 'viewport' | 'container'; containerId?: ContainerId; mask: Bounds[] };

type Key =
  | 'Enter' | 'Tab' | 'ShiftTab' | 'Escape' | 'Backspace' | 'Delete'
  | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'
  | 'Home' | 'End' | 'PageUp' | 'PageDown'
  | 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6' | 'F7' | 'F8' | 'F9' | 'F10' | 'F11' | 'F12';

type ActResult =
  /** The post-action observation comes back WITH the result. observe→act→observe is one
   *  transactional unit at the port, which removes a race the caller would otherwise have to
   *  handle: something can always change between an act() returning and a separate observe(). */
  | { ok: true;  observation: Observation }
  | { ok: false; reason: ActFailure; observation: Observation | null };

type ActFailure =
  | 'NODE_STALE'          // the node id came from an older observation generation
  | 'NODE_NOT_ACTIONABLE' // present but obscured / offscreen / disabled and could not be made ready
  | 'CONTAINER_GONE'      // the frame/window/dialog disappeared
  | 'KEY_UNSUPPORTED'     // should be impossible: the linker checks capabilities up front
  | 'SURFACE_ERROR';      // driver-level fault; carries a detail string in the journal

// ─────────────────────────────────────────────────────────────────────────────
// The port itself
// ─────────────────────────────────────────────────────────────────────────────

interface Surface {
  readonly kind: SurfaceKind;

  /** Static declaration of what this driver can do. The linker typechecks a program against this
   *  BEFORE execution, so "this program presses F5 and this surface has no function keys" is a
   *  load-time link error, not a runtime surprise. */
  capabilities(): SurfaceCapabilities;

  /** `minGeneration` lets the caller say "give me something newer than what I last saw", which is
   *  how polling avoids busy-looping on a stale snapshot. */
  observe(opts?: { minGeneration?: number; timeoutMs?: number }): Promise<Observation>;

  /** Every action carries the lease token. The executor rejects a token that is not the current
   *  holder's — including automation's own token after a handoff. Enforcement, not convention. */
  act(action: Action, lease: LeaseToken): Promise<ActResult>;

  /** Sensitive regions are masked by the surface, at capture time, before bytes exist. */
  capture(scope: 'viewport' | 'container', mask: Bounds[]): Promise<EvidenceRef>;

  dispose(): Promise<void>;
}

interface SurfaceCapabilities {
  navigateByRoute: boolean;
  supportedKeys: readonly Key[];
  supportedRoles: readonly Role[];
  supportsContainers: readonly Container['kind'][];
  boundsUnit: 'px' | 'cell';
  /** Descriptors below this confidence are ineligible for quorum on this surface (§5.3). */
  confidenceFloor: number;
  /** Which descriptor kinds this surface can actually resolve. A program whose targets rely on a
   *  kind the surface cannot resolve is refused at link time rather than failing at step 6. */
  resolvableDescriptors: readonly DescriptorKind[];
}
```

Three deliberate choices in there worth defending:

- **`act` returns the next `Observation`.** Making observe→act→observe one port call removes an
  entire class of race that would otherwise be the caller's problem, and makes a recorded journal an
  exact alternating sequence.
- **`nodes` is flat.** Every consumer is a pure scan (`classify`, `resolve`, `derive`), and a flat
  array with `parentId` is easier to write a total predicate over, cheaper to freeze into a test
  fixture, and diffable when a fixture changes.
- **`NodeId` is observation-scoped by design.** Making it deliberately unstable is what makes
  "the model never authors a locator" a *type* rule instead of a code-review rule: there is nothing
  durable for a model to have persisted.

---

## 5. Targets: how a step names a control

### 5.1 The problem, stated honestly

The brief has deliberately removed selector drift as the headline problem — these are stable
enterprise apps. So this section is not about self-healing selectors, and building an elaborate
healing engine here would be answering a question nobody asked. What targets have to survive is
different and harder to fake:

1. There is **no clean DOM, no test IDs, and generated ids** (`ctl00_ctl32_g_9a1`) that are
   scoped to a vendor build, not to a control.
2. The same target expression has to be **interpretable on a character grid**, where there is no
   markup at all — only 24×80 cells.
3. Getting it *subtly* wrong is worse than failing. A locator that silently matches the wrong row of
   a member table and then reads a balance is a compliance incident, not a bug.

### 5.2 A target is a descriptor set with a quorum rule, not a selector

```ts
interface Target {
  /** Required, and may never be 'unknown'. Role is the cheapest, most surface-portable filter and
   *  it eliminates the most dangerous class of mis-hit: acting on a node of the wrong kind. */
  role: Role;

  /** Absolute container path from the root. No interpreter "current frame" mode exists (§3). */
  container: ContainerRef;

  /** Independently computed. Derived by the recorder from the node the model selected — the model
   *  never writes one of these (build brief §3.2). ≥ 2 required at link time. */
  descriptors: Descriptor[];

  quorum: {
    /** Minimum number of descriptors that must independently resolve to the SAME node. ≥ 2. */
    min: number;
    /** Minimum number of DISTINCT evidence sources among those agreeing descriptors. ≥ 2.
     *  This is the field that makes quorum mean something (see §5.3). */
    distinctEvidenceSources: number;
  };

  /** Constant `true`. Present as data so the rule is visible to a human reviewing the artifact:
   *  a descriptor that matches several nodes ABSTAINS. It never picks the first. */
  expectUnique: true;
}
```

Resolution is one fixed algorithm and it has no fallback chain:

1. Evaluate every descriptor **against a single observation snapshot**. Each returns
   `Resolved(nodeId)` | `NonUnique(count)` | `Abstain(reason)`.
2. `NonUnique` counts as an abstention for quorum, but is recorded distinctly in the fingerprint —
   it is the strongest available drift signal, because it means the screen grew a second thing that
   looks like the thing.
3. Let `S` = the set of distinct node ids that were resolved.
   - `|S| > 1` → **`TARGET_AMBIGUOUS`**. Two independent descriptions of "the control" disagree
     about which control it is. **Refuse to act.** This is not a case for a fallback ranking; it is
     the case a ranking would hide.
   - `|S| === 0` → **`TARGET_NOT_FOUND`**.
   - `|S| === 1` but fewer than `quorum.min` descriptors agreed, or fewer than
     `quorum.distinctEvidenceSources` distinct sources are represented among them, or every agreeing
     descriptor is below the surface's `confidenceFloor` → **`TARGET_UNDERDETERMINED`**.
   - otherwise → resolved.

`TARGET_UNDERDETERMINED` deserves its own failure class rather than being folded into `NOT_FOUND`,
because it means something completely different operationally: *we found a plausible node, but not on
enough independent evidence to touch it.* That is a "this tenant needs specialization" signal, and it
is the one a rank-ordered fallback chain converts into a silent misclick.

### 5.3 Why "distinct evidence sources" and not just a count

This is the part I would expect to be challenged on, so it is stated up front: **a quorum of three
descriptors that all derive from the same underlying evidence is a quorum of one.**

On a browser AX tree, `roleName` (accessible name) and `labelAnchored` (nearest label text) usually
come from the *same* `<label>` element. If the vendor renames the label, both fail together and the
"quorum" never fires. On a character grid it is worse: role synthesis, name synthesis, and label
anchoring all derive from the same label token on the same row, so three descriptors can look
independent and be perfectly correlated.

So each descriptor declares its evidence source, and quorum requires **≥ 2 distinct sources**:

```ts
type EvidenceSource =
  | 'accessibleName'  // the AX name computation / synthesized grid name
  | 'labelText'       // an adjacent label token, spatially related
  | 'columnHeader'    // a table's own header row — structural, not cosmetic
  | 'ordinal'         // position among same-role siblings in a landmark
  | 'geometry';       // spatial relation to another resolved node
```

`geometry` is never sufficient on its own: a resolution whose only agreeing sources are `geometry`
and `ordinal` fails `TARGET_UNDERDETERMINED` by policy, because both of those are properties of
*layout*, and layout is the one thing that legitimately changes when a tenant rebrands.

Taking the character grid seriously is what produced this field. It is the clearest case in the
design where designing for the hostile surface improved the design for the easy one.

### 5.4 The descriptor kinds

Five. Each names an **intent**; each `Surface` implements how that intent becomes a node. That split
is the whole reason one target expression works on two very different surfaces.

```ts
type DescriptorKind =
  'roleName' | 'labelAnchored' | 'tableCell' | 'ordinalInRegion' | 'boxAnchored';

type Descriptor =
  | { id: DescriptorId; kind: 'roleName'; evidenceSource: 'accessibleName';
      role: Role;
      name: TextMatcher;
      /** Which name computations are acceptable. A name that starts resolving from a different
       *  source than at record time still resolves, but is flagged in the fingerprint. */
      nameSource: NameSource[]; }

  | { id: DescriptorId; kind: 'labelAnchored'; evidenceSource: 'labelText';
      label: TextMatcher;
      controlRole: Role;
      relation: 'rightOf' | 'below' | 'leftOf' | 'above';
      /** In the surface's own bounds unit. 240px on a page; 40 cells on a grid. */
      maxDistance: { unit: 'px' | 'cell'; value: number }; }

  | { id: DescriptorId; kind: 'tableCell'; evidenceSource: 'columnHeader';
      table: NodeQuery;
      /** "the row whose <Member ID> column matches <param.memberId>" — SEMANTIC row identity,
       *  parameterized. This is the descriptor that carries table-based legacy layouts, and the
       *  reason `TextMatcher.value` is a ValueRef rather than a string. */
      rowWhere: { columnHeader: TextMatcher; cellMatches: TextMatcher };
      columnHeader: TextMatcher;
      /** e.g. the link inside the matched cell rather than the cell itself. */
      childRole?: Role; }

  | { id: DescriptorId; kind: 'ordinalInRegion'; evidenceSource: 'ordinal';
      region: NodeQuery; role: Role; index: number; }

  | { id: DescriptorId; kind: 'boxAnchored'; evidenceSource: 'geometry';
      /** An INLINE anchor descriptor, not a reference to a sibling — the other descriptors in a
       *  Target all resolve the same node, so there is no sibling that resolves the anchor. The
       *  anchor may not itself be `boxAnchored`, which makes cycles impossible by construction
       *  rather than by a graph check. */
      anchor: Exclude<Descriptor, { kind: 'boxAnchored' }>;
      role: Role;
      direction: 'rightOf' | 'below' | 'leftOf' | 'above';
      maxDistance: { unit: 'px' | 'cell'; value: number }; };

interface ContainerRef {
  path: {
    kind: Container['kind'];
    name?: TextMatcher;
    ordinal?: number;
  }[];
}
```

Derivation is a pure function the recorder runs, and it is unit-testable from frozen observations
with nothing running:

```ts
function deriveDescriptors(obs: Observation, nodeId: NodeId): Descriptor[];
```

The model's contribution to a locator is **a node id from the observation it was shown**, and
nothing else. It never sees, writes, or edits a descriptor.

### 5.5 What is refused, and the interpreter-first reason

**No CSS selectors. No XPath. No raw coordinates as a primary target.** The usual argument is
robustness. From this proposal's angle there is a sharper one: **a CSS selector is an expression in a
second language that the interpreter cannot reason about.** It cannot be typechecked, its failure
mode is silent (`querySelector` cheerfully returns the first match), it cannot be re-interpreted on a
surface that has no markup, and it cannot be rendered into a human-readable "expected" line in a
failure report. A `tableCell` descriptor renders as *"the link in the Member column of the row whose
Member ID cell equals `param.memberId`, inside the frame named `main`"*. `#ctl00_g_9a1 > td:nth-child(3) a`
renders as nothing at all. **Everything the language keeps, it keeps because the interpreter can
explain it.**

Raw coordinates are refused as a *primary* target for a narrower reason: pixel positions are
viewport-, zoom-, and font-dependent, which is a determinism hole the language can simply not have.
Geometry survives only as a *relational* descriptor anchored to another resolved node, and never as a
quorum of one.

### 5.6 Drift is a signal on success, never a failure

Every resolution folds into a fingerprint: for each `(stepId, descriptorId)`, the verdict
(`resolved` / `abstained` / `non-unique` / `disagreed`) and, when it resolved, a hash of the observed
name and its source. The artifact carries the fingerprint recorded at verification time.

```ts
interface DriftSignal {
  fingerprint: Sha256;
  expected: Sha256;
  divergence: number;                        // 0..1, fraction of descriptor verdicts that changed
  changed: { stepId: StepId; descriptorId: DescriptorId;
             was: DescriptorVerdict; now: DescriptorVerdict }[];
  /** Crossing the threshold means "this tenant has diverged enough to need its own overlay",
   *  NOT "this run failed". */
  needsSpecialization: boolean;
}
```

`DriftSignal` is present on **every** arm of the result contract, including `success`. A run that
succeeded on two of four descriptors succeeded — and the operator should know the margin is thinning
before the day it hits zero. Failing a correct run because a label changed would be exactly the
"elaborate self-healing selectors called robustness" the brief warns against, in reverse.

---

## 6. The artifact schema

### 6.0 Three documents, not one

The build brief settles the shape as `capability → flow → overlay`. Interpreter-first thinking says
the same thing for its own reason: **three different readers need three different documents, and
conflating them is what makes an artifact unreviewable.**

| Document | Reader | Contains | Changes when |
|---|---|---|---|
| `CapabilityContract` | the **calling AI agent** and a product owner | id, typed params, typed returns, named outcomes. Zero surface detail. | the capability's meaning changes |
| `CapabilityArtifact` | the **interpreter** and a security reviewer | the program: steps, targets, detectors, budgets, effect annotations, provenance, approvals | the app changes or the flow is re-recorded |
| `CapabilityOverlay` | the **linker**, per tenant | additive, non-semantic overrides only | a tenant diverges |

The contract is separately addressed and separately versioned because the same contract can be
implemented by **more than one artifact** — a browser program for tenants on the web core and a
terminal program for tenants still on the green screen. One agent-facing tool; two programs. That is
the honest answer to "how does this extend across surfaces", and it falls out of separating the three
readers.

### 6.1 Primitives

```ts
/** Version of the LANGUAGE, not of the capability. The interpreter refuses to load a program whose
 *  major it was not built for, rather than trying to interpret a construct it has never seen. */
type LanguageVersion = `crr/${number}.${number}`;

type ContractId   = string;   // 'cu.member.lookup_savings_balance' — reverse-dotted, tenant-free
type StepId       = string;   // 's04_verify_results' — stable across edits; overlays address it
type BindingName  = string;   // a single-assignment slot in the interpreter's env
type ParamName    = string;
type LiteralId    = string;   // addressable so an overlay can retarget branded text
type RouteId      = string;
type DescriptorId = string;
type Sha256       = string;   // 'sha256:…'

/** Registry ids carry a MAJOR version. Without this, engine code could silently change what an
 *  approved artifact means, which would quietly void the whole "artifact is data" claim. */
type NormalizerId = 'trim@1' | 'collapseWhitespace@1' | 'lower@1' | 'upper@1'
                  | 'stripPunctuation@1' | 'digitsOnly@1' | 'stripCurrency@1';

type ExtractorId  = 'verbatimText@1' | 'integer@1' | 'decimal@1' | 'currencyUSD@1'
                  | 'iso8601Date@1'  | 'usDate@1'  | 'lastFour@1' | 'boolean@1';

/** Named, total validators. NOT a regex field — see §11. */
type FormatId     = 'memberNumber@1' | 'accountNumber@1' | 'usPhone@1' | 'usDate@1'
                  | 'nonEmpty@1' | 'digits@1';

type ValueType    = 'string' | 'integer' | 'decimal' | 'boolean' | 'date' | 'enum';

type EffectClass  = 'READ' | 'WRITE_REVERSIBLE' | 'WRITE_IRREVERSIBLE';

/** `sensitive` = PII: returned to the caller, never journaled, never in a screenshot.
 *  `secret`    = credentials: never returned to the caller either, and only ever consumable by a
 *                `fill` inside a login preamble or a recovery remedy. Resolved from a credential
 *                provider at invocation; a `secret` may not appear in a contract's `returns`. */
type Sensitivity  = 'public' | 'internal' | 'sensitive' | 'secret';
```

### 6.2 Values, predicates, checkpoints

```ts
type ValueRef =
  | { from: 'param';   name: ParamName }
  | { from: 'binding'; name: BindingName }     // written by an EARLIER read step; linker enforces
  /** Literals are ALWAYS `public`. This is the PII control expressed as a type rule: a value the
   *  recorder classified as derived-from-the-goal cannot be stored as a literal, so it must be a
   *  parameter. One mechanism, three requirements satisfied — reuse, no-PII-at-rest, and the
   *  route-canonicalization stretch goal (build brief §3.6). */
  | { from: 'literal'; id: LiteralId; value: string; sensitivity: 'public' };

interface TextMatcher {
  mode: 'equals' | 'contains' | 'startsWith' | 'endsWith';
  /** A ValueRef, not a string — this is what lets a detector or a table-row descriptor compare
   *  against an invocation parameter. */
  value: ValueRef;
  /** Applied to BOTH the observed text and the matcher's value before comparison, so the
   *  comparison is symmetric and cannot depend on which side was normalized. */
  normalize: NormalizerId[];
}

/** Existential query used for CLASSIFYING ("is anything like this on screen?"). Deliberately NOT a
 *  Target: it carries no quorum, because a detector is not about to act on what it finds. Targets
 *  demand quorum; NodeQueries are existential. Keeping these two types apart is what stops a
 *  detector's looseness from leaking into an action. */
interface NodeQuery {
  role?: Role | Role[];
  name?: TextMatcher;
  text?: TextMatcher;
  value?: TextMatcher;
  state?: Partial<Record<keyof NodeState, boolean>>;
  container?: ContainerRef;
  within?: { role: Role; name?: TextMatcher };
}

/** Propositional logic over one finite Observation. Total and decidable — this is not computation,
 *  and it is deliberately not an expression language: no arithmetic, no concatenation, no
 *  comparison operators, no regex. Nesting depth is capped at 4 by the linker, which bounds
 *  evaluation cost and keeps the prose renderer (§8.4) tractable. */
type Predicate =
  | { op: 'nodeExists';      where: NodeQuery }
  | { op: 'nodeAbsent';      where: NodeQuery }
  | { op: 'matches';         where: NodeQuery; field: 'name' | 'value' | 'text'; matcher: TextMatcher }
  | { op: 'nodeState';       where: NodeQuery; state: keyof NodeState; is: boolean }
  | { op: 'countAtLeast';    where: NodeQuery; n: number }
  | { op: 'countEquals';     where: NodeQuery; n: number }
  | { op: 'locationMatches'; routeId: RouteId }
  | { op: 'quiescent' }
  | { op: 'all'; of: Predicate[] }
  | { op: 'any'; of: Predicate[] }
  | { op: 'not'; of: Predicate };

interface Checkpoint {
  predicate: Predicate;
  /** How long the interpreter will poll for the predicate to become true. 0 = must already hold.
   *  There is no `sleep` in the language; this is the only way to express waiting (§2.6). */
  settleMs: number;
  /** Also require Observation.stability.quiescent. Off by default because on a busy legacy page
   *  quiescence can be genuinely unreachable, and a checkpoint that can never pass is worse than
   *  one that passes slightly early. */
  requireQuiescent: boolean;
  /** Optional prose. When absent, failure reports render the predicate itself (§8.4). */
  description?: string;
}
```

### 6.3 The contract document

```ts
interface CapabilityContract {
  schemaVersion: LanguageVersion;
  kind: 'contract';

  id: ContractId;
  /** Semver. MAJOR = the agent-visible shape changed (params/returns/outcome codes).
   *  MINOR/PATCH = description or docs only. An agent pins a major. */
  version: string;
  title: string;
  /** Written for the calling agent's tool description. Says what it does and what it does NOT. */
  description: string;
  tags: string[];

  parameters: ParamDecl[];
  returns: ReturnDecl;
  outcomes: OutcomeDecl[];

  /** Copied from analyzeEffects() of the implementing artifact at approval time and re-checked by
   *  the linker. Published in the agent catalog so a calling agent knows a capability writes —
   *  and what class of data it hands back — BEFORE it calls it. */
  effectSummary: { maxEffect: EffectClass; readsSensitivity: Sensitivity };

  integrity: Integrity;
}

interface ParamDecl {
  name: ParamName;
  type: ValueType;
  enumValues?: string[];
  /** A named validator, not a regex. See §11 for the argument. */
  format?: FormatId;
  required: boolean;
  default?: string;
  sensitivity: Sensitivity;
  /** The agent reads this. It is the difference between a capability an agent uses correctly and
   *  one it guesses at. */
  description: string;
  /** Must be synthetic. The linter refuses an `example` on any param whose sensitivity is not
   *  'public', because an example is exactly where real PII gets pasted by accident. */
  example?: string;
}

interface ReturnDecl { fields: ReturnField[] }

interface ReturnField {
  name: string;
  type: ValueType;
  /** The binding a `read` step writes. Linker: exactly one read must write it, and its declared
   *  type must match. This is how "typed outputs" is enforced rather than hoped for. */
  from: BindingName;
  /** Only legal when the producing read declares `onAbsent: 'bindNull'`. Linker checks the pair. */
  optional: boolean;
  sensitivity: Sensitivity;
  description: string;
}

interface OutcomeDecl {
  /** SCREAMING_SNAKE. This is the string the calling agent switches on, so it is part of the
   *  contract's public API and changing it is a MAJOR version bump. */
  code: string;
  title: string;
  description: string;
  /** Always true in v1. The field exists so that a future non-terminal outcome is a visible schema
   *  change rather than a silent behaviour change. */
  terminal: true;
  /** Outcome-specific typed payload. NOT the success returns: a MEMBER_NOT_FOUND does not carry a
   *  balance, and the type system should say so. */
  payload: ReturnField[];
  /** Guidance to the caller: is retrying with different arguments sensible? MEMBER_NOT_FOUND yes,
   *  MEMBER_RESTRICTED no. Saves every calling agent from re-deriving this. */
  retriable: boolean;
}
```

### 6.4 The artifact document

```ts
interface CapabilityArtifact {
  schemaVersion: LanguageVersion;
  kind: 'artifact';

  id: string;                     // 'corebank-web/cu.member.lookup_savings_balance'
  version: string;                // semver of THIS implementation

  /** Pinned by digest. An artifact implements one exact contract; if the contract is edited, the
   *  digest stops matching and the linker refuses rather than running a program against a contract
   *  it was not recorded for. */
  implements: { contractId: ContractId; contractVersion: string; contractDigest: Sha256 };

  target: {
    surfaceKind: SurfaceKind;
    /** The vendor product, NOT the tenant. This is the axis reuse happens along. */
    appId: string;
    appVersionRange: string;
    /** Checked against Surface.capabilities() at link time (§6.7 check 17). */
    requiredCapabilities: {
      navigateByRoute: boolean;
      keys: Key[];
      roles: Role[];
      descriptorKinds: DescriptorKind[];
      containers: Container['kind'][];
    };
  };

  program: Program;
  provenance: Provenance;
  lifecycle: Lifecycle;
  integrity: Integrity;
}

interface Program {
  entry: RouteId;
  /** Addressable so an overlay can retarget a tenant's route without touching a step (§6.6). */
  routes: RouteDecl[];
  steps: Step[];
  budgets: ProgramBudgets;
  /** Recorded at verification time; the drift signal compares against it (§5.6). */
  expectedFingerprint: Sha256;
}

interface RouteDecl {
  id: RouteId;
  /** Browser: a canonical path pattern with named segments, '/members/:memberId/accounts'.
   *  Terminal: a screen id, 'MEMB01'.
   *  NEVER an origin. Origin is per-tenant invocation config, allowlisted by policy — which is
   *  exactly what lets one artifact serve hundreds of institutions unmodified. */
  pattern: string;
  /** ':memberId' → param.memberId. The linker checks every named segment is bound. */
  bind: Record<string, ValueRef>;
}

interface ProgramBudgets {
  maxWallClockMs: number;
  /** Linker checks this is ≥ acting steps + Σ(remedy length × maxAttempts): a program whose budget
   *  cannot cover its own declared recoveries is a link error, not a runtime surprise. */
  maxActions: number;
  maxObservations: number;
  maxRecoveryExcursions: number;
  /** Supervisor-level restarts (§2.5). Default 1 = no restart. */
  maxProgramAttempts: number;
}
```

### 6.5 Steps

```ts
interface StepBase {
  id: StepId;
  /** Rendered in journals, failure reports and the operator console brief. Not decoration —
   *  this is what a human on-call reads at 2am. */
  title: string;

  /** DECLARED, not inferred. See §13 for the honest limitation this carries. */
  effect: EffectClass;

  /** Must hold BEFORE acting. This is what makes a step safe to resume after a human handoff and
   *  after any recovery excursion (§3.1). */
  precondition: Predicate | null;

  /** Must hold AFTER, within its settle budget. Every step, not just the last one — a final-only
   *  checkpoint tells you the flow failed; a per-step checkpoint tells you where. */
  expect: Checkpoint;

  /** Terminal business results detectable at this step. Evaluated BEFORE recoveries and BEFORE
   *  the checkpoint (§2.3). */
  outcomes: OutcomeRule[];

  /** Bounded, budgeted remedies for known recoverable conditions. */
  recoveries: RecoveryRule[];

  evidence: EvidencePolicy;

  /** The model's stated reason for this step, captured at discovery. This is how the artifact stays
   *  reviewable while being decoupled from the raw transcript: a human reviewer gets the rationale
   *  without the engine ever depending on the transcript existing. */
  note?: string;
}

interface OutcomeRule {
  code: string;                  // must name a declared OutcomeDecl on the contract
  phase: 'pre' | 'post' | 'both';   // default 'post'
  priority: number;              // lower wins; a tie among MATCHED rules is AMBIGUOUS_CLASSIFICATION
  detector: Predicate;
  /** Writes the outcome's typed payload into bindings, which the contract's `payload[].from`
   *  names. Bindings written earlier in the program are NOT leaked into an outcome payload unless
   *  the outcome captures them here — a deliberate privacy and typing rule. Capture bindings are
   *  single-assignment like every other binding, and because outcomes are terminal, nothing can
   *  read them afterwards. */
  capture: { binding: BindingName; read: ExtractSpec }[];
}

interface ExtractSpec {
  from: { query: NodeQuery } | { target: Target };
  source: 'text' | 'value' | 'name' | 'state';
  extractor: ExtractorId;
  normalize: NormalizerId[];
  type: ValueType;
  sensitivity: Sensitivity;
}

interface EvidencePolicy {
  onEnter: 'none' | 'tree' | 'screenshot' | 'both';
  onExit:  'none' | 'tree' | 'screenshot' | 'both';
  /** Always at least 'both' in practice; the field exists so a step handling `secret` values can
   *  downgrade to 'tree' and never produce pixels at all. */
  onFailure: 'none' | 'tree' | 'screenshot' | 'both';
  /** Targets whose rendered region is masked before capture. Populated automatically for every
   *  target bound to a sensitive/secret value; may be extended by hand. */
  maskTargets: DescriptorId[];
}

// ── the nine instructions ────────────────────────────────────────────────────

interface NavigateStep extends StepBase {
  kind: 'navigate';
  effect: 'READ' | 'WRITE_REVERSIBLE';
  routeId: RouteId;
}

interface ClickStep extends StepBase { kind: 'click'; target: Target }

interface FillStep extends StepBase {
  kind: 'fill';
  target: Target;
  value: ValueRef;
  /** Only value in v1: appending depends on prior field content, which is hidden input. */
  mode: 'replace';
  /** Some legacy fields reformat on blur (12345 → 12-345). The postcondition compares through
   *  these normalizers, so reformatting does not become a false failure. */
  verifyNormalize: NormalizerId[];
}

interface SelectStep extends StepBase {
  kind: 'select';
  target: Target;
  /** By accessible OPTION NAME, never by index. Option order is a rendering detail; option text is
   *  the thing a human operator actually used. */
  optionName: TextMatcher;
}

interface ToggleStep extends StepBase {
  kind: 'setToggle';
  target: Target;
  /** Sets an absolute state. There is no `toggle` (§3). */
  checked: boolean;
}

interface PressKeyStep extends StepBase {
  kind: 'pressKey';
  /** null = the surface's currently focused control. Allowed but discouraged; the linker warns. */
  target: Target | null;
  key: Key;
}

interface ReadStep extends StepBase {
  kind: 'read';
  effect: 'READ';
  binding: BindingName;          // single assignment; linker enforces uniqueness
  extract: ExtractSpec;
  /** 'bindNull' is the ONLY way a contract return field may be `optional`. */
  onAbsent: 'fail' | 'bindNull';
}

interface ReadTableStep extends StepBase {
  kind: 'readTable';
  effect: 'READ';
  binding: BindingName;
  table: NodeQuery;
  rowRole: Role;                 // 'row' | 'gridcell' container role
  columns: { name: string; columnHeader: TextMatcher; extract: Omit<ExtractSpec, 'from'> }[];
  minRows: number;
  maxRows: number;
  /** Default 'fail'. Silent truncation of a member's account list is exactly the kind of quiet
   *  wrongness this whole design exists to prevent. */
  onTruncate: 'fail' | 'flag';
}

interface AssertStep extends StepBase { kind: 'assert'; effect: 'READ' }

type Step =
  | NavigateStep | ClickStep | FillStep | SelectStep | ToggleStep
  | PressKeyStep | ReadStep | ReadTableStep | AssertStep;
```

### 6.6 Provenance, lifecycle, integrity, and the overlay

```ts
interface Provenance {
  discoveredAt: string;
  discoveredBy: {
    provider: 'anthropic' | 'openai';
    model: string;
    promptVersion: string;
    recorderVersion: string;
  };
  /** DIGEST ONLY. The transcript lives in the evidence store; the artifact points at it and does
   *  not embed it. The artifact must be reviewable without the transcript existing, and a
   *  transcript is the single most likely place for raw PII to hide. */
  transcriptRef: { evidenceRef: EvidenceRef; digest: Sha256 } | null;
  goalTemplate: string;          // the goal with concrete values already replaced by :params
  appInstanceRecordedAgainst: { appId: string; appVersion: string; tenantIdHash: Sha256 };
}

interface Lifecycle {
  /** proposed → verified → approved → deprecated. `verified` is only reachable by the
   *  record-then-immediately-replay gate (build brief §3.4), amended per §12. */
  state: 'proposed' | 'verified' | 'approved' | 'deprecated';
  verification: {
    at: string;
    /** 'full' replayed every step. 'dry' skipped WRITE_IRREVERSIBLE steps, resolving their targets
     *  and checking their preconditions without acting — see §12. */
    mode: 'full' | 'dry';
    replayJournalDigest: Sha256;
    fingerprint: Sha256;
  } | null;
  approvals: {
    by: string;
    at: string;
    /** Signs over `integrity.digest`, so an approved artifact cannot be silently edited: any edit
     *  changes the digest and orphans every approval. */
    digest: Sha256;
    signature: string;
    scope: 'attended' | 'unattended';
    /** An approval may permit unattended replay only up to a given effect class. */
    maxEffect: EffectClass;
    expiresAt: string | null;
  }[];
  supersededBy: string | null;
}

interface Integrity {
  canonicalization: 'jcs';       // RFC 8785, so the digest is stable across serializers
  digest: Sha256;                // over the document with `integrity` removed
  languageVersion: LanguageVersion;
}

// ── overlay ──────────────────────────────────────────────────────────────────

interface CapabilityOverlay {
  schemaVersion: LanguageVersion;
  kind: 'overlay';
  tenantId: string;
  appInstanceId: string;
  /** Pinned to an exact base. A base bump leaves overlays in `needs-reverification` rather than
   *  silently applying to a program they were never checked against. */
  overlayFor: { artifactId: string; artifactVersion: string; artifactDigest: Sha256 };
  patches: OverlayPatch[];
  integrity: Integrity;
}

/** ADD-ONLY and NON-SEMANTIC. An overlay may not add, remove, or reorder steps; may not change an
 *  effect class; may not remove a descriptor, a detector, or a checkpoint. If a tenant needs a
 *  different sequence of actions, that is a different artifact — because otherwise the signature
 *  over the base digest would be a signature over something the tenant never runs. Overlays widen
 *  tolerances and add evidence. They never change what a capability does. */
type OverlayPatch =
  | { op: 'setSettleBudget'; stepId: StepId; settleMs: number }
  | { op: 'setBudget'; field: keyof ProgramBudgets; value: number }
  /** Additive: the base's descriptors still vote. A renamed tenant label makes the base's
   *  roleName descriptor ABSTAIN, which is fine as long as quorum is still met by others. */
  | { op: 'addDescriptor'; stepId: StepId; descriptor: Descriptor }
  | { op: 'addRecovery'; stepId: StepId; rule: RecoveryRule }
  | { op: 'setRoutePattern'; routeId: RouteId; pattern: string }
  /** Branded strings inside DETECTORS only — never inside a Target descriptor, never a route,
   *  never a `fill` value. Retargeting a detector's wording cannot change which control the
   *  program acts on; retargeting a descriptor's wording could, which is why a tenant that renamed
   *  a button uses `addDescriptor` instead and lets the base descriptor abstain. */
  | { op: 'setLiteral'; literalId: LiteralId; value: string };

/** Deterministic and total. The merged program is re-typechecked and re-digested; every result and
 *  every journal line carries `effectiveDigest` so you always know exactly which program ran. */
function merge(base: CapabilityArtifact, overlay: CapabilityOverlay | null): LinkedProgram;
```

### 6.6.1 Supporting types referenced above

Small, but listed so nothing in this document is hand-waved.

```ts
type NodeId       = string;   // observation-scoped ONLY; never persisted (§4)
type ContainerId  = string;
type EvidenceRef  = string;   // 'ev:run/2026-08-24/inv_01JQ7Y3M2K/s05.png' — a pointer, never bytes

type BoundValue   = { value: string | null; type: ValueType; sensitivity: Sensitivity;
                      /** Taint. A tainted value may not be journaled, rendered into a failure
                       *  report, or written to an artifact — enforced at the sink, not by
                       *  remembering to redact at every call site. */
                      tainted: boolean };
type Bindings     = ReadonlyMap<BindingName, BoundValue>;

interface BudgetLedger { actions: number; observations: number;
                         wallClockMsRemaining: number; recoveryExcursions: number }

type LeaseToken   = string;
interface LeaseSnapshot { token: LeaseToken; holder: 'automation' | 'human';
                          actorId: string; expiresAtMs: number }

type DescriptorVerdict = 'resolved' | 'abstained' | 'nonUnique' | 'disagreed';
interface FingerprintAccumulator {
  fold(stepId: StepId, descriptorId: DescriptorId,
       verdict: DescriptorVerdict, observedNameDigest: Sha256 | null): void;
  digest(): Sha256;
}

/** Every predicate evaluation is traceable because predicates are data. This is what makes
 *  `expected` in a failure report a rendered structure rather than a hand-written string. */
interface PredicateTrace { op: Predicate['op']; verdict: boolean;
                           satisfiedBy?: { role: Role; name: string; textDigest: Sha256 }[];
                           children?: PredicateTrace[]; [k: string]: unknown }

interface ExpectationTrace { rendered: string;
                             clauses: { descriptorId?: DescriptorId; evidenceSource?: EvidenceSource;
                                        verdict: string; node?: string }[] }

/** Redacted rendering of an Observation for a failure report. Never the raw tree, never PII. */
interface ObservationDigest { route: string; containerPath: string; nodeCount: number;
                              salientNodes: { role: Role; name: string; [k: string]: unknown }[];
                              screenTextDigest: Sha256 }

/** The output of a successful link: a flattened, merged, argument-bound, surface-checked program
 *  plus everything the interpreter needs and nothing it does not. */
interface LinkedProgram { effectiveDigest: Sha256; program: Program; contract: CapabilityContract;
                          effects: EffectSummary; args: Bindings }
interface LinkError { check: number; path: string; message: string }

type Decision =
  | { kind: 'act'; action: Action }
  | { kind: 'observeAgain' }
  | { kind: 'advance'; bind?: { name: BindingName; value: BoundValue } }
  | { kind: 'runRemedy'; rule: RecoveryRule }
  | { kind: 'requestRestart'; rule: RecoveryRule }
  | { kind: 'escalate'; rule: RecoveryRule }
  | { kind: 'terminate'; result: ReplayResult };
```

### 6.7 The linker: twenty checks that run before anything executes

`linkProgram(contract, artifact, overlay, surfaceCapabilities, args) → LinkedProgram | LinkError[]`.
This is where "typed program" stops being a metaphor. A `LINK_ERROR` result has performed **zero**
actions, which is the difference between a bad artifact and a half-applied one.

| # | Check |
|---|---|
| 1 | `schemaVersion` major matches the engine's; unknown constructs are refused, never ignored |
| 2 | `integrity.digest` matches the JCS canonicalization of the document |
| 3 | `implements.contractDigest` matches the contract document actually loaded |
| 4 | every `ValueRef` resolves: param declared, or binding written by a **strictly earlier** step |
| 5 | every binding is written exactly once (single assignment); outcome `capture` bindings live in their own terminal namespace and may not be referenced by any step |
| 6 | every `returns[].from` binding exists and its declared type matches the read's `type` |
| 7 | every `returns[].optional` field's producing read declares `onAbsent: 'bindNull'` |
| 8 | every `OutcomeRule.code` names a declared `OutcomeDecl` on the pinned contract |
| 9 | rule priorities are unique within a step (a tie is a link error, not a runtime coin-flip) |
| 10 | no `Target`/`Descriptor` string looks like a CSS selector, an XPath, a URL, or a `NodeId` |
| 11 | every `Target` has ≥ 2 descriptors, ≥ 2 distinct evidence sources, and `role !== 'unknown'` |
| 12 | `boxAnchored.anchor` is not itself a `boxAnchored` (anchors nest at most one level) |
| 13 | effect class is legal for the step kind; `EffectSummary` is computed and matches the contract |
| 14 | a `fill` value is a literal only when that literal is `sensitivity: 'public'` — the `literal` variant cannot express any other sensitivity, so this is a type-level guarantee the linker re-checks. Whether a value *should* have been a parameter is a **recorder-side** lint (`valueAppearsInGoal`, `valueMatchesAKnownPIIFormat`), not something the linker can re-derive; §13 records that limit |
| 15 | `budgets.maxActions ≥ actingSteps + Σ(remedy.length × maxAttempts)`; all budgets finite and > 0 |
| 16 | remedies: ≤ 4 instructions, no `read`/`readTable`/`assert`, no nested recoveries |
| 17 | every instruction, `Key`, `Role`, container kind and descriptor kind is in `Surface.capabilities()` |
| 18 | predicate depth ≤ 4; every `NormalizerId` / `ExtractorId` / `FormatId` exists at that major |
| 19 | `restart` remedies appear only at steps where every prior step is not `WRITE_IRREVERSIBLE` |
| 20 | overlay patches address existing ids, are add-only, change no effect class, and `setLiteral` targets a literal referenced only from detectors |

Plus an argument bind check: supplied arguments satisfy `type`, `format`, `enumValues` and
`required` **before** a browser is launched. A caller's bad member number costs zero actions.

---

## 7. A real artifact: member savings lookup

The goal, as an agent would state it: *"look up member 40001234 and read their current savings
balance."* Recorded once against `fixtures/corebank-web` — framesets, table layout, generated ids, no
test IDs — and thereafter replayed with no model in the loop.

Three documents follow: the contract the agent calls, the program the interpreter runs, and one
tenant overlay. Note what is **absent** from all three: no host, no URL, no member number, no member
name, no credential, no CSS selector, no XPath, no node id, no regex, no sleep, and no timestamp the
program reads.

### 7.1 The contract (what the calling agent sees)

```json
{
  "schemaVersion": "crr/1.0",
  "kind": "contract",
  "id": "cu.member.lookup_savings_balance",
  "version": "1.2.0",
  "title": "Look up a member's savings balance",
  "description": "Given a member number, open the member record in the core back office and return the primary savings account's current balance. Read-only. Returns MEMBER_NOT_FOUND when the member number does not exist, MEMBER_RESTRICTED when the operating role may not view the record, and INPUT_REJECTED_BY_APP when the application itself rejects the member number format.",
  "tags": ["member", "balance", "read-only", "core-banking"],
  "parameters": [
    {
      "name": "memberId",
      "type": "string",
      "format": "memberNumber@1",
      "required": true,
      "sensitivity": "internal",
      "description": "The credit union member number as printed on a statement. Digits only, 5 to 9 characters."
    }
  ],
  "returns": {
    "fields": [
      { "name": "memberName", "type": "string", "from": "b_member_name", "optional": false, "sensitivity": "sensitive", "description": "Primary member's display name as shown on the member record." },
      { "name": "savingsBalanceUsd", "type": "decimal", "from": "b_savings_balance", "optional": false, "sensitivity": "internal", "description": "Current balance of the primary savings share, in USD, as a decimal string." },
      { "name": "savingsAccountTail4", "type": "string", "from": "b_savings_tail4", "optional": false, "sensitivity": "internal", "description": "Last four characters of the savings share suffix, for caller-side disambiguation." },
      { "name": "asOf", "type": "date", "from": "b_as_of", "optional": true, "sensitivity": "public", "description": "The 'balances as of' date printed on the member record, when the screen shows one." }
    ]
  },
  "outcomes": [
    {
      "code": "MEMBER_NOT_FOUND",
      "title": "No member with that number",
      "description": "The search completed and the application reported no matching member. This is a legitimate answer, not a failure.",
      "terminal": true,
      "payload": [
        { "name": "searchedMemberId", "type": "string", "from": "b_out_searched_id", "optional": false, "sensitivity": "internal", "description": "Echo of the member number that was searched." }
      ],
      "retriable": true
    },
    {
      "code": "MEMBER_RESTRICTED",
      "title": "Record exists but this role may not view it",
      "description": "The application returned a permission denial for this member record. Modelled as an outcome rather than a failure because the caller needs to know the record exists and is withheld; retrying will not change it.",
      "terminal": true,
      "payload": [],
      "retriable": false
    },
    {
      "code": "INPUT_REJECTED_BY_APP",
      "title": "The application rejected the member number",
      "description": "The application's own field validation rejected the supplied member number even though it passed our declared format. The application is authoritative; the disagreement is also emitted as a drift signal because it means our declared format is wrong.",
      "terminal": true,
      "payload": [
        { "name": "appMessage", "type": "string", "from": "b_out_app_message", "optional": false, "sensitivity": "public", "description": "The validation message the application displayed, verbatim." }
      ],
      "retriable": true
    }
  ],
  "effectSummary": { "maxEffect": "READ", "readsSensitivity": "sensitive" },
  "integrity": {
    "canonicalization": "jcs",
    "digest": "sha256:5f1c0d9e2b7a4438a6f0c1d2e3b4a5968778695a4b3c2d1e0f9a8b7c6d5e4f30",
    "languageVersion": "crr/1.0"
  }
}
```

This is the entire agent-facing surface. It serialises directly into a tool definition; the outcome
codes become the values the agent switches on. **`MEMBER_NOT_FOUND` is a return value with a typed
payload, not an exception** — that is the single most important line in this document, because the
brief's glossary names conflating the two as the most common design mistake in this problem.

Two judgment calls worth defending here:

- **`MEMBER_RESTRICTED` is an outcome, not a failure.** A permission denial is a fact about the
  world that the caller needs and that no retry will change. Classifying it as a hard failure would
  send an operator to debug a system that is working correctly. It carries `retriable: false` so the
  agent does not helpfully try again.
- **`INPUT_REJECTED_BY_APP` is an outcome even though we validated the input ourselves.** Our
  `format: memberNumber@1` and the application's field validation can disagree, and when they do
  **the application is authoritative** — it is the system of record. So the caller gets the app's own
  message verbatim, and the disagreement is *also* emitted as a drift signal, because it means our
  declared format is wrong and someone should fix the contract.

### 7.2 The artifact (what the interpreter runs)

```json
{
  "schemaVersion": "crr/1.0",
  "kind": "artifact",
  "id": "corebank-web/cu.member.lookup_savings_balance",
  "version": "1.4.1",
  "implements": {
    "contractId": "cu.member.lookup_savings_balance",
    "contractVersion": "1.2.0",
    "contractDigest": "sha256:5f1c0d9e2b7a4438a6f0c1d2e3b4a5968778695a4b3c2d1e0f9a8b7c6d5e4f30"
  },
  "target": {
    "surfaceKind": "browser",
    "appId": "corebank-web",
    "appVersionRange": ">=8.2.0 <9.0.0",
    "requiredCapabilities": {
      "navigateByRoute": true,
      "keys": [],
      "roles": ["textbox", "button", "link", "table", "row", "cell", "columnheader", "heading", "alert", "dialog", "region", "text"],
      "descriptorKinds": ["roleName", "labelAnchored", "tableCell", "ordinalInRegion", "boxAnchored"],
      "containers": ["root", "frame", "dialog"]
    }
  },
  "program": {
    "entry": "r_member_search",
    "expectedFingerprint": "sha256:9a2b47c1e05d3f68b4a1c7d9e2f0834657b8c9d0a1e2f3b4c5d6e7f8091a2b3c",
    "routes": [
      { "id": "r_member_search",  "pattern": "/corebank/member/search",         "bind": {} },
      { "id": "r_member_results", "pattern": "/corebank/member/search/results", "bind": {} },
      { "id": "r_member_detail",  "pattern": "/corebank/member/:memberId",      "bind": { "memberId": { "from": "param", "name": "memberId" } } },
      { "id": "r_login",          "pattern": "/corebank/login",                 "bind": {} }
    ],
    "budgets": {
      "maxWallClockMs": 120000,
      "maxActions": 16,
      "maxObservations": 240,
      "maxRecoveryExcursions": 3,
      "maxProgramAttempts": 2
    },
    "steps": [
      {
        "id": "s01_open_member_search",
        "kind": "navigate",
        "title": "Open the Member Search screen",
        "effect": "READ",
        "routeId": "r_member_search",
        "precondition": null,
        "expect": {
          "predicate": {
            "op": "all",
            "of": [
              { "op": "locationMatches", "routeId": "r_member_search" },
              { "op": "nodeExists", "where": { "role": "textbox", "name": { "mode": "equals", "value": { "from": "literal", "id": "lit_member_id_label", "value": "Member ID", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "trim@1", "lower@1"] } } }
            ]
          },
          "settleMs": 8000,
          "requireQuiescent": true,
          "description": "Member Search is loaded and the Member ID field is present."
        },
        "outcomes": [],
        "recoveries": [
          {
            "name": "SESSION_EXPIRED",
            "phase": "both",
            "priority": 1,
            "detector": {
              "op": "any",
              "of": [
                { "op": "locationMatches", "routeId": "r_login" },
                { "op": "matches", "where": { "role": "alert" }, "field": "text", "matcher": { "mode": "contains", "value": { "from": "literal", "id": "lit_session_expired", "value": "Your session has expired", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "lower@1"] } }
              ]
            },
            "remedy": { "kind": "restart", "scope": "program" },
            "maxAttempts": 1,
            "afterRemedy": "reverify"
          },
          {
            "name": "DISMISS_MAINTENANCE_NOTICE",
            "phase": "both",
            "priority": 20,
            "detector": {
              "op": "all",
              "of": [
                { "op": "nodeExists", "where": { "role": "dialog", "name": { "mode": "contains", "value": { "from": "literal", "id": "lit_notice_title", "value": "Scheduled Maintenance", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "lower@1"] } } },
                { "op": "nodeExists", "where": { "role": "button", "name": { "mode": "equals", "value": { "from": "literal", "id": "lit_ok", "value": "OK", "sensitivity": "public" }, "normalize": ["trim@1", "lower@1"] }, "container": { "path": [{ "kind": "dialog" }] } } }
              ]
            },
            "remedy": {
              "kind": "actions",
              "instructions": [
                {
                  "kind": "click",
                  "target": {
                    "role": "button",
                    "container": { "path": [{ "kind": "dialog", "name": { "mode": "contains", "value": { "from": "literal", "id": "lit_notice_title", "value": "Scheduled Maintenance", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "lower@1"] } }] },
                    "quorum": { "min": 2, "distinctEvidenceSources": 2 },
                    "expectUnique": true,
                    "descriptors": [
                      { "id": "d_ok_name", "kind": "roleName", "evidenceSource": "accessibleName", "role": "button", "name": { "mode": "equals", "value": { "from": "literal", "id": "lit_ok", "value": "OK", "sensitivity": "public" }, "normalize": ["trim@1", "lower@1"] }, "nameSource": ["textContent", "ariaLabel"] },
                      { "id": "d_ok_ordinal", "kind": "ordinalInRegion", "evidenceSource": "ordinal", "region": { "role": "dialog" }, "role": "button", "index": 0 }
                    ]
                  }
                }
              ]
            },
            "maxAttempts": 2,
            "afterRemedy": "reverify"
          }
        ],
        "evidence": { "onEnter": "none", "onExit": "none", "onFailure": "both", "maskTargets": [] },
        "note": "Model reached this screen from the portal home page by clicking 'Member Services'. The recorder replaced that traversal with a direct route because the route canonicalized cleanly and contained no parameters."
      },

      {
        "id": "s02_enter_member_id",
        "kind": "fill",
        "title": "Type the member number into Member ID",
        "effect": "READ",
        "target": {
          "role": "textbox",
          "container": { "path": [{ "kind": "frame", "name": { "mode": "equals", "value": { "from": "literal", "id": "lit_frame_main", "value": "main", "sensitivity": "public" }, "normalize": ["lower@1"] }, "ordinal": 0 }] },
          "quorum": { "min": 2, "distinctEvidenceSources": 2 },
          "expectUnique": true,
          "descriptors": [
            { "id": "d_mid_name", "kind": "roleName", "evidenceSource": "accessibleName", "role": "textbox", "name": { "mode": "equals", "value": { "from": "literal", "id": "lit_member_id_label", "value": "Member ID", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "trim@1", "lower@1"] }, "nameSource": ["labelElement", "adjacentText"] },
            { "id": "d_mid_label", "kind": "labelAnchored", "evidenceSource": "labelText", "label": { "mode": "startsWith", "value": { "from": "literal", "id": "lit_member_id_label", "value": "Member ID", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "stripPunctuation@1", "lower@1"] }, "controlRole": "textbox", "relation": "rightOf", "maxDistance": { "unit": "px", "value": 260 } },
            { "id": "d_mid_ordinal", "kind": "ordinalInRegion", "evidenceSource": "ordinal", "region": { "role": "form", "name": { "mode": "contains", "value": { "from": "literal", "id": "lit_search_form", "value": "Member Search", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "lower@1"] } }, "role": "textbox", "index": 0 }
          ]
        },
        "value": { "from": "param", "name": "memberId" },
        "mode": "replace",
        "verifyNormalize": ["trim@1", "digitsOnly@1"],
        "precondition": { "op": "nodeState", "where": { "role": "textbox", "name": { "mode": "equals", "value": { "from": "literal", "id": "lit_member_id_label", "value": "Member ID", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "trim@1", "lower@1"] } }, "state": "disabled", "is": false },
        "expect": {
          "predicate": { "op": "matches", "where": { "role": "textbox", "name": { "mode": "equals", "value": { "from": "literal", "id": "lit_member_id_label", "value": "Member ID", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "trim@1", "lower@1"] } }, "field": "value", "matcher": { "mode": "equals", "value": { "from": "param", "name": "memberId" }, "normalize": ["trim@1", "digitsOnly@1"] } },
          "settleMs": 1500,
          "requireQuiescent": false,
          "description": "The Member ID field now holds the supplied member number (compared through digitsOnly, because this field reformats on blur)."
        },
        "outcomes": [],
        "recoveries": [],
        "evidence": { "onEnter": "none", "onExit": "none", "onFailure": "both", "maskTargets": [] },
        "note": "memberId came from the goal text, so the recorder bound it as a parameter rather than storing 40001234. The artifact therefore contains no member number."
      },

      {
        "id": "s03_submit_search",
        "kind": "click",
        "title": "Run the member search",
        "effect": "READ",
        "target": {
          "role": "button",
          "container": { "path": [{ "kind": "frame", "name": { "mode": "equals", "value": { "from": "literal", "id": "lit_frame_main", "value": "main", "sensitivity": "public" }, "normalize": ["lower@1"] }, "ordinal": 0 }] },
          "quorum": { "min": 2, "distinctEvidenceSources": 2 },
          "expectUnique": true,
          "descriptors": [
            { "id": "d_search_name", "kind": "roleName", "evidenceSource": "accessibleName", "role": "button", "name": { "mode": "equals", "value": { "from": "literal", "id": "lit_search_button", "value": "Search", "sensitivity": "public" }, "normalize": ["trim@1", "lower@1"] }, "nameSource": ["textContent", "title"] },
            { "id": "d_search_box", "kind": "boxAnchored", "evidenceSource": "geometry", "role": "button", "anchor": { "id": "d_search_anchor", "kind": "roleName", "evidenceSource": "accessibleName", "role": "textbox", "name": { "mode": "equals", "value": { "from": "literal", "id": "lit_member_id_label", "value": "Member ID", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "trim@1", "lower@1"] }, "nameSource": ["labelElement"] }, "direction": "rightOf", "maxDistance": { "unit": "px", "value": 320 } },
            { "id": "d_search_ordinal", "kind": "ordinalInRegion", "evidenceSource": "ordinal", "region": { "role": "form", "name": { "mode": "contains", "value": { "from": "literal", "id": "lit_search_form", "value": "Member Search", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "lower@1"] } }, "role": "button", "index": 0 }
          ]
        },
        "precondition": { "op": "matches", "where": { "role": "textbox", "name": { "mode": "equals", "value": { "from": "literal", "id": "lit_member_id_label", "value": "Member ID", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "trim@1", "lower@1"] } }, "field": "value", "matcher": { "mode": "equals", "value": { "from": "param", "name": "memberId" }, "normalize": ["trim@1", "digitsOnly@1"] } },
        "expect": {
          "predicate": { "op": "any", "of": [ { "op": "locationMatches", "routeId": "r_member_results" }, { "op": "nodeExists", "where": { "role": "alert" } } ] },
          "settleMs": 15000,
          "requireQuiescent": true,
          "description": "The search resolved: either the results screen rendered, or the application raised a banner that the outcome rules below classify."
        },
        "outcomes": [
          {
            "code": "MEMBER_NOT_FOUND",
            "phase": "post",
            "priority": 10,
            "detector": { "op": "matches", "where": { "role": ["alert", "status", "text"] }, "field": "text", "matcher": { "mode": "contains", "value": { "from": "literal", "id": "lit_not_found_text", "value": "No member found", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "stripPunctuation@1", "lower@1"] } },
            "capture": [
              { "binding": "b_out_searched_id", "read": { "from": { "query": { "role": "textbox", "name": { "mode": "equals", "value": { "from": "literal", "id": "lit_member_id_label", "value": "Member ID", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "trim@1", "lower@1"] } } }, "source": "value", "extractor": "verbatimText@1", "normalize": ["trim@1"], "type": "string", "sensitivity": "internal" } }
            ]
          },
          {
            "code": "MEMBER_RESTRICTED",
            "phase": "post",
            "priority": 20,
            "detector": { "op": "matches", "where": { "role": ["alert", "status", "text"] }, "field": "text", "matcher": { "mode": "contains", "value": { "from": "literal", "id": "lit_restricted_text", "value": "You are not authorized to view this member", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "stripPunctuation@1", "lower@1"] } },
            "capture": []
          },
          {
            "code": "INPUT_REJECTED_BY_APP",
            "phase": "post",
            "priority": 30,
            "detector": { "op": "all", "of": [ { "op": "locationMatches", "routeId": "r_member_search" }, { "op": "nodeState", "where": { "role": "textbox", "name": { "mode": "equals", "value": { "from": "literal", "id": "lit_member_id_label", "value": "Member ID", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "trim@1", "lower@1"] } }, "state": "invalid", "is": true } ] },
            "capture": [
              { "binding": "b_out_app_message", "read": { "from": { "query": { "role": "alert" } }, "source": "text", "extractor": "verbatimText@1", "normalize": ["collapseWhitespace@1", "trim@1"], "type": "string", "sensitivity": "public" } }
            ]
          }
        ],
        "recoveries": [
          {
            "name": "SESSION_EXPIRED",
            "phase": "both",
            "priority": 1,
            "detector": { "op": "any", "of": [ { "op": "locationMatches", "routeId": "r_login" }, { "op": "matches", "where": { "role": "alert" }, "field": "text", "matcher": { "mode": "contains", "value": { "from": "literal", "id": "lit_session_expired", "value": "Your session has expired", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "lower@1"] } } ] },
            "remedy": { "kind": "restart", "scope": "program" },
            "maxAttempts": 1,
            "afterRemedy": "reverify"
          },
          {
            "name": "APP_ERROR_PAGE",
            "phase": "post",
            "priority": 5,
            "detector": { "op": "matches", "where": { "role": ["heading", "alert"] }, "field": "text", "matcher": { "mode": "contains", "value": { "from": "literal", "id": "lit_app_error", "value": "An unexpected error has occurred", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "lower@1"] } },
            "remedy": { "kind": "escalate", "reason": "The application returned its generic error page. There is no safe automated remedy: the search may or may not have executed server-side.", "brief": "Member search returned the application error page. Confirm whether the search ran, then either complete the lookup manually or abandon the invocation." },
            "maxAttempts": 1,
            "afterRemedy": "reverify"
          }
        ],
        "evidence": { "onEnter": "none", "onExit": "tree", "onFailure": "both", "maskTargets": [] },
        "note": "The three outcomes were derived from fault-injected discovery passes, not guessed: each was observed once during recording and its detector written against the observation that was actually captured."
      },

      {
        "id": "s04_verify_results",
        "kind": "assert",
        "title": "Confirm exactly one matching member row",
        "effect": "READ",
        "precondition": null,
        "expect": {
          "predicate": { "op": "countEquals", "where": { "role": "row", "within": { "role": "table", "name": { "mode": "contains", "value": { "from": "literal", "id": "lit_results_table", "value": "Search Results", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "lower@1"] } } }, "n": 1 },
          "settleMs": 3000,
          "requireQuiescent": true,
          "description": "The results table contains exactly one member row. More than one means the member number was not unique, which this capability does not model."
        },
        "outcomes": [],
        "recoveries": [],
        "evidence": { "onEnter": "none", "onExit": "none", "onFailure": "both", "maskTargets": [] },
        "note": "countEquals rather than countAtLeast on purpose: a second row means the app matched on something other than the exact member number, and continuing would read a balance off an arbitrary row."
      },

      {
        "id": "s05_open_member_record",
        "kind": "click",
        "title": "Open the matching member's record",
        "effect": "READ",
        "target": {
          "role": "link",
          "container": { "path": [{ "kind": "frame", "name": { "mode": "equals", "value": { "from": "literal", "id": "lit_frame_main", "value": "main", "sensitivity": "public" }, "normalize": ["lower@1"] }, "ordinal": 0 }] },
          "quorum": { "min": 2, "distinctEvidenceSources": 2 },
          "expectUnique": true,
          "descriptors": [
            {
              "id": "d_row_cell",
              "kind": "tableCell",
              "evidenceSource": "columnHeader",
              "table": { "role": "table", "name": { "mode": "contains", "value": { "from": "literal", "id": "lit_results_table", "value": "Search Results", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "lower@1"] } },
              "rowWhere": {
                "columnHeader": { "mode": "equals", "value": { "from": "literal", "id": "lit_col_member_id", "value": "Member ID", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "trim@1", "lower@1"] },
                "cellMatches": { "mode": "equals", "value": { "from": "param", "name": "memberId" }, "normalize": ["trim@1", "digitsOnly@1"] }
              },
              "columnHeader": { "mode": "equals", "value": { "from": "literal", "id": "lit_col_member", "value": "Member", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "trim@1", "lower@1"] },
              "childRole": "link"
            },
            {
              "id": "d_row_geo",
              "kind": "boxAnchored",
              "evidenceSource": "geometry",
              "role": "link",
              "anchor": {
                "id": "d_row_geo_anchor",
                "kind": "tableCell",
                "evidenceSource": "columnHeader",
                "table": { "role": "table", "name": { "mode": "contains", "value": { "from": "literal", "id": "lit_results_table", "value": "Search Results", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "lower@1"] } },
                "rowWhere": {
                  "columnHeader": { "mode": "equals", "value": { "from": "literal", "id": "lit_col_member_id", "value": "Member ID", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "trim@1", "lower@1"] },
                  "cellMatches": { "mode": "equals", "value": { "from": "param", "name": "memberId" }, "normalize": ["trim@1", "digitsOnly@1"] }
                },
                "columnHeader": { "mode": "equals", "value": { "from": "literal", "id": "lit_col_member_id", "value": "Member ID", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "trim@1", "lower@1"] }
              },
              "direction": "rightOf",
              "maxDistance": { "unit": "px", "value": 420 }
            }
          ]
        },
        "precondition": { "op": "countEquals", "where": { "role": "row", "within": { "role": "table", "name": { "mode": "contains", "value": { "from": "literal", "id": "lit_results_table", "value": "Search Results", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "lower@1"] } } }, "n": 1 },
        "expect": {
          "predicate": { "op": "all", "of": [ { "op": "locationMatches", "routeId": "r_member_detail" }, { "op": "nodeExists", "where": { "role": "heading", "text": { "mode": "contains", "value": { "from": "literal", "id": "lit_member_record_heading", "value": "Member Record", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "lower@1"] } } }, { "op": "nodeExists", "where": { "role": "table", "name": { "mode": "contains", "value": { "from": "literal", "id": "lit_shares_table", "value": "Shares", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "lower@1"] } } } ] },
          "settleMs": 15000,
          "requireQuiescent": true,
          "description": "The member record for :memberId is open and the Shares table has rendered."
        },
        "outcomes": [
          {
            "code": "MEMBER_RESTRICTED",
            "phase": "post",
            "priority": 20,
            "detector": { "op": "matches", "where": { "role": ["alert", "status", "text"] }, "field": "text", "matcher": { "mode": "contains", "value": { "from": "literal", "id": "lit_restricted_text", "value": "You are not authorized to view this member", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "stripPunctuation@1", "lower@1"] } },
            "capture": []
          }
        ],
        "recoveries": [
          {
            "name": "SESSION_EXPIRED",
            "phase": "both",
            "priority": 1,
            "detector": { "op": "any", "of": [ { "op": "locationMatches", "routeId": "r_login" }, { "op": "matches", "where": { "role": "alert" }, "field": "text", "matcher": { "mode": "contains", "value": { "from": "literal", "id": "lit_session_expired", "value": "Your session has expired", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "lower@1"] } } ] },
            "remedy": { "kind": "restart", "scope": "program" },
            "maxAttempts": 1,
            "afterRemedy": "reverify"
          }
        ],
        "evidence": { "onEnter": "none", "onExit": "tree", "onFailure": "both", "maskTargets": [] },
        "note": "The row is identified by the very value the caller asked about. A mis-hit would require the wrong row to contain the right member number, which is a stronger identity guarantee than any selector could give."
      },

      {
        "id": "s06_read_member_name",
        "kind": "read",
        "title": "Read the member's name",
        "effect": "READ",
        "binding": "b_member_name",
        "onAbsent": "fail",
        "extract": {
          "from": {
            "target": {
              "role": "text",
              "container": { "path": [{ "kind": "frame", "name": { "mode": "equals", "value": { "from": "literal", "id": "lit_frame_main", "value": "main", "sensitivity": "public" }, "normalize": ["lower@1"] }, "ordinal": 0 }] },
              "quorum": { "min": 2, "distinctEvidenceSources": 2 },
              "expectUnique": true,
              "descriptors": [
                { "id": "d_name_label", "kind": "labelAnchored", "evidenceSource": "labelText", "label": { "mode": "startsWith", "value": { "from": "literal", "id": "lit_name_label", "value": "Name", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "stripPunctuation@1", "lower@1"] }, "controlRole": "text", "relation": "rightOf", "maxDistance": { "unit": "px", "value": 300 } },
                { "id": "d_name_ordinal", "kind": "ordinalInRegion", "evidenceSource": "ordinal", "region": { "role": "region", "name": { "mode": "contains", "value": { "from": "literal", "id": "lit_member_summary", "value": "Member Summary", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "lower@1"] } }, "role": "text", "index": 0 }
              ]
            }
          },
          "source": "text",
          "extractor": "verbatimText@1",
          "normalize": ["collapseWhitespace@1", "trim@1"],
          "type": "string",
          "sensitivity": "sensitive"
        },
        "precondition": { "op": "locationMatches", "routeId": "r_member_detail" },
        "expect": { "predicate": { "op": "locationMatches", "routeId": "r_member_detail" }, "settleMs": 0, "requireQuiescent": false },
        "outcomes": [],
        "recoveries": [],
        "evidence": { "onEnter": "none", "onExit": "none", "onFailure": "tree", "maskTargets": ["d_name_label", "d_name_ordinal"] },
        "note": "Sensitivity 'sensitive': this value is returned to the caller but never journaled, and its rendered region is masked out of every screenshot this step could produce. onFailure is 'tree' rather than 'both' so this step cannot generate pixels containing a member name at all."
      },

      {
        "id": "s07_read_savings_balance",
        "kind": "read",
        "title": "Read the primary savings balance",
        "effect": "READ",
        "binding": "b_savings_balance",
        "onAbsent": "fail",
        "extract": {
          "from": {
            "target": {
              "role": "cell",
              "container": { "path": [{ "kind": "frame", "name": { "mode": "equals", "value": { "from": "literal", "id": "lit_frame_main", "value": "main", "sensitivity": "public" }, "normalize": ["lower@1"] }, "ordinal": 0 }] },
              "quorum": { "min": 2, "distinctEvidenceSources": 2 },
              "expectUnique": true,
              "descriptors": [
                {
                  "id": "d_bal_cell",
                  "kind": "tableCell",
                  "evidenceSource": "columnHeader",
                  "table": { "role": "table", "name": { "mode": "contains", "value": { "from": "literal", "id": "lit_shares_table", "value": "Shares", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "lower@1"] } },
                  "rowWhere": {
                    "columnHeader": { "mode": "equals", "value": { "from": "literal", "id": "lit_col_type", "value": "Type", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "trim@1", "lower@1"] },
                    "cellMatches": { "mode": "contains", "value": { "from": "literal", "id": "lit_savings_type", "value": "Regular Savings", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "lower@1"] }
                  },
                  "columnHeader": { "mode": "equals", "value": { "from": "literal", "id": "lit_col_balance", "value": "Balance", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "trim@1", "lower@1"] }
                },
                {
                  "id": "d_bal_geo",
                  "kind": "boxAnchored",
                  "evidenceSource": "geometry",
                  "role": "cell",
                  "anchor": { "id": "d_bal_anchor", "kind": "roleName", "evidenceSource": "accessibleName", "role": "columnheader", "name": { "mode": "equals", "value": { "from": "literal", "id": "lit_col_balance", "value": "Balance", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "trim@1", "lower@1"] }, "nameSource": ["textContent"] },
                  "direction": "below",
                  "maxDistance": { "unit": "px", "value": 90 }
                }
              ]
            }
          },
          "source": "text",
          "extractor": "currencyUSD@1",
          "normalize": ["collapseWhitespace@1", "trim@1", "stripCurrency@1"],
          "type": "decimal",
          "sensitivity": "internal"
        },
        "precondition": { "op": "nodeExists", "where": { "role": "table", "name": { "mode": "contains", "value": { "from": "literal", "id": "lit_shares_table", "value": "Shares", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "lower@1"] } } },
        "expect": { "predicate": { "op": "locationMatches", "routeId": "r_member_detail" }, "settleMs": 0, "requireQuiescent": false },
        "outcomes": [],
        "recoveries": [],
        "evidence": { "onEnter": "none", "onExit": "none", "onFailure": "both", "maskTargets": [] },
        "note": "The geometry descriptor deliberately anchors to the Balance COLUMN HEADER and takes the first cell below it, which is independent evidence of 'the balance column' from the header-driven descriptor's row logic."
      },

      {
        "id": "s08_read_savings_tail4",
        "kind": "read",
        "title": "Read the savings share suffix",
        "effect": "READ",
        "binding": "b_savings_tail4",
        "onAbsent": "fail",
        "extract": {
          "from": {
            "target": {
              "role": "cell",
              "container": { "path": [{ "kind": "frame", "name": { "mode": "equals", "value": { "from": "literal", "id": "lit_frame_main", "value": "main", "sensitivity": "public" }, "normalize": ["lower@1"] }, "ordinal": 0 }] },
              "quorum": { "min": 2, "distinctEvidenceSources": 2 },
              "expectUnique": true,
              "descriptors": [
                {
                  "id": "d_sfx_cell",
                  "kind": "tableCell",
                  "evidenceSource": "columnHeader",
                  "table": { "role": "table", "name": { "mode": "contains", "value": { "from": "literal", "id": "lit_shares_table", "value": "Shares", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "lower@1"] } },
                  "rowWhere": {
                    "columnHeader": { "mode": "equals", "value": { "from": "literal", "id": "lit_col_type", "value": "Type", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "trim@1", "lower@1"] },
                    "cellMatches": { "mode": "contains", "value": { "from": "literal", "id": "lit_savings_type", "value": "Regular Savings", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "lower@1"] }
                  },
                  "columnHeader": { "mode": "equals", "value": { "from": "literal", "id": "lit_col_suffix", "value": "Suffix", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "trim@1", "lower@1"] }
                },
                {
                  "id": "d_sfx_geo",
                  "kind": "boxAnchored",
                  "evidenceSource": "geometry",
                  "role": "cell",
                  "anchor": { "id": "d_sfx_anchor", "kind": "roleName", "evidenceSource": "accessibleName", "role": "columnheader", "name": { "mode": "equals", "value": { "from": "literal", "id": "lit_col_suffix", "value": "Suffix", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "trim@1", "lower@1"] }, "nameSource": ["textContent"] },
                  "direction": "below",
                  "maxDistance": { "unit": "px", "value": 90 }
                }
              ]
            }
          },
          "source": "text",
          "extractor": "lastFour@1",
          "normalize": ["trim@1", "digitsOnly@1"],
          "type": "string",
          "sensitivity": "internal"
        },
        "precondition": null,
        "expect": { "predicate": { "op": "locationMatches", "routeId": "r_member_detail" }, "settleMs": 0, "requireQuiescent": false },
        "outcomes": [],
        "recoveries": [],
        "evidence": { "onEnter": "none", "onExit": "none", "onFailure": "both", "maskTargets": ["d_sfx_cell", "d_sfx_geo"] },
        "note": "lastFour@1 runs inside the engine, so the full account suffix never leaves the surface boundary. Truncation is a property of the extractor, not of a downstream formatter that someone might forget to apply."
      },

      {
        "id": "s09_read_as_of",
        "kind": "read",
        "title": "Read the 'balances as of' date, if the screen shows one",
        "effect": "READ",
        "binding": "b_as_of",
        "onAbsent": "bindNull",
        "extract": {
          "from": {
            "target": {
              "role": "text",
              "container": { "path": [{ "kind": "frame", "name": { "mode": "equals", "value": { "from": "literal", "id": "lit_frame_main", "value": "main", "sensitivity": "public" }, "normalize": ["lower@1"] }, "ordinal": 0 }] },
              "quorum": { "min": 2, "distinctEvidenceSources": 2 },
              "expectUnique": true,
              "descriptors": [
                { "id": "d_asof_label", "kind": "labelAnchored", "evidenceSource": "labelText", "label": { "mode": "startsWith", "value": { "from": "literal", "id": "lit_as_of_label", "value": "Balances as of", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "stripPunctuation@1", "lower@1"] }, "controlRole": "text", "relation": "rightOf", "maxDistance": { "unit": "px", "value": 200 } },
                { "id": "d_asof_name", "kind": "roleName", "evidenceSource": "accessibleName", "role": "text", "name": { "mode": "startsWith", "value": { "from": "literal", "id": "lit_as_of_label", "value": "Balances as of", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "stripPunctuation@1", "lower@1"] }, "nameSource": ["adjacentText", "textContent"] }
              ]
            }
          },
          "source": "text",
          "extractor": "usDate@1",
          "normalize": ["collapseWhitespace@1", "trim@1"],
          "type": "date",
          "sensitivity": "public"
        },
        "precondition": null,
        "expect": { "predicate": { "op": "locationMatches", "routeId": "r_member_detail" }, "settleMs": 0, "requireQuiescent": false },
        "outcomes": [],
        "recoveries": [],
        "evidence": { "onEnter": "none", "onExit": "none", "onFailure": "both", "maskTargets": [] },
        "note": "The only step allowed to produce nothing. onAbsent 'bindNull' is what makes the contract's asOf field legally optional; the linker rejects an optional return field whose producing read says 'fail'. Note the two descriptors here share an evidence root (the same label token) even though their declared sources differ - see the honest caveat in section 7.4."
      }
    ]
  },
  "provenance": {
    "discoveredAt": "2026-08-21T15:04:11.882Z",
    "discoveredBy": {
      "provider": "anthropic",
      "model": "<model id resolved via the claude-api skill at build time; not asserted from memory here>",
      "promptVersion": "discovery/2026-08-19",
      "recorderVersion": "0.4.0"
    },
    "transcriptRef": { "evidenceRef": "ev:run/2026-08-21/d41f9c/transcript.jsonl", "digest": "sha256:c3a0be1f77d24e8bb59a02f4e6d17c8390ab54d216f7e0c9b8a7d6e5f4c3b2a1" },
    "goalTemplate": "look up member :memberId and read their current savings balance",
    "appInstanceRecordedAgainst": { "appId": "corebank-web", "appVersion": "8.4.2", "tenantIdHash": "sha256:7b1e4d2a9c0f38561e2d4c6b8a0f9e7d5c3b1a0f9e8d7c6b5a4938271605f4e3" }
  },
  "lifecycle": {
    "state": "approved",
    "verification": {
      "at": "2026-08-21T15:06:02.114Z",
      "mode": "full",
      "replayJournalDigest": "sha256:2e9d7c4b1a0f8e6d5c3b2a190807f6e5d4c3b2a1908f7e6d5c4b3a2190f8e7d6",
      "fingerprint": "sha256:9a2b47c1e05d3f68b4a1c7d9e2f0834657b8c9d0a1e2f3b4c5d6e7f8091a2b3c"
    },
    "approvals": [
      {
        "by": "ops.reviewer@example-cu.invalid",
        "at": "2026-08-22T09:12:44.001Z",
        "digest": "sha256:1d0c9b8a7f6e5d4c3b2a1908f7e6d5c4b3a21908f7e6d5c4b3a21908f7e6d5c4",
        "signature": "<detached ed25519 signature over the digest above>",
        "scope": "unattended",
        "maxEffect": "READ",
        "expiresAt": "2027-08-22T00:00:00.000Z"
      }
    ],
    "supersededBy": null
  },
  "integrity": {
    "canonicalization": "jcs",
    "digest": "sha256:1d0c9b8a7f6e5d4c3b2a1908f7e6d5c4b3a21908f7e6d5c4b3a21908f7e6d5c4",
    "languageVersion": "crr/1.0"
  }
}
```

### 7.3 One tenant overlay

Summit Federal runs the same vendor product at a different mount path, on a slower host, with a
renamed search button and one extra interstitial. Nothing about the flow changed, so nothing about
the program changes:

```json
{
  "schemaVersion": "crr/1.0",
  "kind": "overlay",
  "tenantId": "summit-federal-cu",
  "appInstanceId": "summit/corebank-web/prod",
  "overlayFor": {
    "artifactId": "corebank-web/cu.member.lookup_savings_balance",
    "artifactVersion": "1.4.1",
    "artifactDigest": "sha256:1d0c9b8a7f6e5d4c3b2a1908f7e6d5c4b3a21908f7e6d5c4b3a21908f7e6d5c4"
  },
  "patches": [
    {
      "op": "setRoutePattern",
      "routeId": "r_member_detail",
      "pattern": "/cb/members/:memberId/summary"
    },
    {
      "op": "setSettleBudget",
      "stepId": "s03_submit_search",
      "settleMs": 30000
    },
    {
      "op": "addDescriptor",
      "stepId": "s03_submit_search",
      "descriptor": {
        "id": "d_search_name_summit",
        "kind": "roleName",
        "evidenceSource": "accessibleName",
        "role": "button",
        "name": { "mode": "equals", "value": { "from": "literal", "id": "lit_search_button_summit", "value": "Find Member", "sensitivity": "public" }, "normalize": ["trim@1", "lower@1"] },
        "nameSource": ["textContent", "title"]
      }
    },
    {
      "op": "setLiteral",
      "literalId": "lit_not_found_text",
      "value": "No matching member on file"
    },
    {
      "op": "addRecovery",
      "stepId": "s05_open_member_record",
      "rule": {
        "name": "DISMISS_PRIVACY_ACKNOWLEDGEMENT",
        "phase": "both",
        "priority": 30,
        "detector": { "op": "nodeExists", "where": { "role": "dialog", "name": { "mode": "contains", "value": { "from": "literal", "id": "lit_privacy_ack_summit", "value": "Member Privacy Acknowledgement", "sensitivity": "public" }, "normalize": ["collapseWhitespace@1", "lower@1"] } } },
        "remedy": {
          "kind": "actions",
          "instructions": [
            {
              "kind": "click",
              "target": {
                "role": "button",
                "container": { "path": [{ "kind": "dialog" }] },
                "quorum": { "min": 2, "distinctEvidenceSources": 2 },
                "expectUnique": true,
                "descriptors": [
                  { "id": "d_ack_name", "kind": "roleName", "evidenceSource": "accessibleName", "role": "button", "name": { "mode": "equals", "value": { "from": "literal", "id": "lit_ack_button", "value": "I Acknowledge", "sensitivity": "public" }, "normalize": ["trim@1", "lower@1"] }, "nameSource": ["textContent"] },
                  { "id": "d_ack_ordinal", "kind": "ordinalInRegion", "evidenceSource": "ordinal", "region": { "role": "dialog" }, "role": "button", "index": 0 }
                ]
              }
            }
          ]
        },
        "maxAttempts": 1,
        "afterRemedy": "reverify"
      }
    }
  ],
  "integrity": {
    "canonicalization": "jcs",
    "digest": "sha256:8f7e6d5c4b3a21908f7e6d5c4b3a21908f7e6d5c4b3a21908f7e6d5c4b3a2190",
    "languageVersion": "crr/1.0"
  }
}
```

Note what the overlay does with the renamed button. It does **not** rewrite the base's `Search`
descriptor. It **adds** a `Find Member` descriptor, and the base's `d_search_name` descriptor simply
abstains at Summit. Quorum is still met — `d_search_name_summit` (`accessibleName`) plus
`d_search_box` (`geometry`) — and the abstention shows up in the fingerprint as a permanent,
visible record that this tenant has diverged. An overlay that *edited* the base would have erased
that signal, and would have made the approval signature over the base digest a signature over
something Summit never runs.

### 7.4 What this artifact admits about itself

Three things I would rather state than have a reviewer find:

1. **`s09_read_as_of` has a weak quorum.** Its two descriptors declare different evidence sources
   (`labelText` and `accessibleName`) but in practice both derive from the same "Balances as of"
   token on the page. The `distinctEvidenceSources` check passes on the letter and not the spirit.
   The mitigation is that this is the one `optional` read in the flow: if it degrades, it binds null
   and the capability still returns. Declaring `evidenceSource` per-descriptor makes this
   *inspectable*; it does not make it impossible.
2. **`s05_open_member_record` has two descriptors with a shared root** — both find the row by its
   Member ID cell. But this is the good case, and it is worth being explicit about why: the row is
   identified by *the very value the caller asked about*. A mis-hit would require the wrong row to
   contain the right member number. **Parameterized row identity is a stronger guarantee than any
   selector can give**, because it is checked against the invocation's own argument rather than
   against a recording of last month's page.
3. **`effect: "READ"` on every step here is a declaration, not a proof.** The linker checks it is
   *consistent*; nothing verifies that clicking `Search` does not write an audit row server-side. See
   §13.

---

## 8. The replay result contract

### 8.1 Four arms, and why "recoverable" is not one of them

The brief asks replay to distinguish three things: expected business outcomes, recoverable
conditions, and hard failures. **Only two of those three are results.** A recoverable condition is a
*transition*, not a terminus: if the remedy works, the run's result is `success`; if the remedy
exhausts its budget, the result is a `failure` whose class is `RECOVERY_EXHAUSTED` and which names
the recovery that gave up. Modelling "recoverable" as a result arm would force every caller to handle
a state that, by definition, the system was supposed to handle for them.

What *is* a fourth arm is **escalation**, because the caller's next move genuinely differs: on
`escalated` an agent should wait on or surface an intervention id; on `failure` it should stop.

```ts
type ReplayResult<TOut = Record<string, unknown>> =
  | ReplaySuccess<TOut>
  | ReplayOutcome
  | ReplayEscalated
  | ReplayFailure;

/** Present on EVERY arm. A caller must always be able to answer "which exact program ran, against
 *  which tenant, with which overlay, and what did it cost" without consulting a log. */
interface ReplayEnvelope {
  invocationId: string;
  idempotencyKey: string | null;   // supplied by the caller; never generated inside the program

  contractId: ContractId;
  contractVersion: string;
  artifactId: string;
  artifactDigest: Sha256;
  overlayDigest: Sha256 | null;
  /** sha256(artifactDigest ‖ overlayDigest ‖ linkerVersion). The identity of the program that
   *  actually executed, after merge. This, not artifactDigest, is what a postmortem needs. */
  effectiveDigest: Sha256;

  languageVersion: LanguageVersion;
  engineVersion: string;
  surface: SurfaceKind;
  tenantId: string;
  appInstanceId: string;

  startedAt: string;
  endedAt: string;
  durationMs: number;

  /** Every ledger, used vs. limit. An operator tuning budgets should never have to guess. */
  budgets: Record<'actions' | 'observations' | 'wallClockMs' | 'recoveryExcursions' | 'programAttempts',
                  { used: number; limit: number }>;

  stepsExecuted: number;
  stepsTotal: number;

  /** Every recovery that fired, whether or not it helped. Silent recoveries are how a system rots
   *  quietly: the interstitial that appears on 3% of runs today appears on 40% next quarter, and
   *  nobody notices because the runs still pass. */
  recoveriesApplied: { stepId: StepId; name: string; attempts: number; outcome: 'resolved' | 'exhausted' }[];

  /** Every human takeover, attributed. Preserved across the handoff, per brief §3.6. */
  controlTransfers: {
    at: string; from: 'automation' | 'human'; to: 'automation' | 'human';
    actorId: string; interventionId: string | null;
    actionsPerformed: { kind: Action['kind']; targetTitle: string }[];
  }[];

  /** Present on success too. Drift is a signal, never a verdict (§5.6). */
  drift: DriftSignal;

  journalRef: EvidenceRef;
}

interface ReplaySuccess<T> extends ReplayEnvelope {
  status: 'success';
  outputs: T;
  /** Parallel to `outputs`. The caller is told which fields are PII so it can decide what to log,
   *  rather than being trusted to remember. */
  outputsSensitivity: Record<string, Sensitivity>;
}

interface ReplayOutcome extends ReplayEnvelope {
  status: 'outcome';
  outcome: {
    code: string;
    title: string;
    /** Typed by the OUTCOME's payload declaration, not by the success returns. A MEMBER_NOT_FOUND
     *  does not carry a balance, and the type says so. */
    payload: Record<string, unknown>;
    detectedAt: { stepId: StepId; stepIndex: number; phase: 'pre' | 'post' };
    /** Which detector fired and which nodes satisfied it. Possible because detectors are DATA. */
    matched: PredicateTrace;
    /** Rules that also matched but lost on priority. Empty is the normal case; non-empty is a
     *  quiet warning that this step's taxonomy is getting muddy. */
    alsoMatched: { code: string; priority: number }[];
    retriable: boolean;
    evidence: EvidenceRef | null;
  };
}

interface ReplayEscalated extends ReplayEnvelope {
  status: 'escalated';
  intervention: {
    id: string;
    reason: string;
    raisedAt: { stepId: StepId; stepIndex: number };
    /** What a human needs to act, in one screen: goal, capability, step title, what was expected,
     *  what was seen, and the masked evidence. */
    brief: {
      capabilityTitle: string; stepTitle: string;
      expected: ExpectationTrace; observed: ObservationDigest;
      evidence: EvidenceRef | null;
    };
    lease: { holder: 'human' | 'automation'; expiresAt: string };
    /** Presenting this token, plus the lease, resumes THIS machine at THIS step — which then
     *  re-verifies its precondition rather than blindly continuing. */
    resumeToken: string;
    consoleUrl: string;
  };
}

interface ReplayFailure extends ReplayEnvelope {
  status: 'failure';
  failure: {
    class: FailureClass;
    stepId: StepId | null;          // null only for LINK_ERROR / POLICY_DENIED pre-flight
    stepIndex: number | null;
    stepTitle: string | null;
    message: string;                // generated, not hand-written — see §8.4
    /** The declared expectation, rendered clause by clause with each clause's verdict. */
    expected: ExpectationTrace;
    /** What was actually there, redacted. */
    observed: ObservationDigest;
    evidence: EvidenceRef | null;
    /** Would retrying the same call plausibly behave differently? A SURFACE_ERROR yes;
     *  a TARGET_AMBIGUOUS emphatically no. */
    retriable: boolean;
    /** One line telling a human what to actually do. Derived from the class, not free text. */
    operatorAction: string;
  };
}
```

### 8.2 The failure taxonomy

Sixteen classes, closed. Each one exists because it implies a **different human action** — that is
the admission test, and it is why there is no `UNKNOWN_ERROR`.

```ts
type FailureClass =
  | 'LINK_ERROR' | 'ARGUMENT_INVALID' | 'POLICY_DENIED' | 'PRECONDITION_FAILED'
  | 'TARGET_NOT_FOUND' | 'TARGET_AMBIGUOUS' | 'TARGET_UNDERDETERMINED' | 'ACTION_REJECTED'
  | 'CHECKPOINT_UNMET' | 'AMBIGUOUS_CLASSIFICATION' | 'EXTRACTION_FAILED'
  | 'RECOVERY_EXHAUSTED' | 'BUDGET_EXHAUSTED' | 'CONTROL_LOST' | 'SURFACE_ERROR'
  | 'INTERNAL_INVARIANT';
```

| Class | Meaning | What a human should do |
|---|---|---|
| `LINK_ERROR` | the program did not typecheck against the contract, surface, or arguments. **Zero actions performed.** | fix the artifact or the call; nothing happened |
| `ARGUMENT_INVALID` | supplied arguments failed `type` / `format` / `required`. Zero actions performed. | fix the caller |
| `POLICY_DENIED` | the policy chokepoint refused an action or the whole invocation | review the allowlist, or get an approval token |
| `PRECONDITION_FAILED` | the screen was not what this step requires before acting | usually means a prior step's checkpoint was too weak |
| `TARGET_NOT_FOUND` | no descriptor resolved | the control is gone: the app changed, or the tenant needs an overlay |
| `TARGET_AMBIGUOUS` | descriptors resolved to **different** nodes | do **not** loosen the target; a second thing on screen looks like the thing |
| `TARGET_UNDERDETERMINED` | one node, but too little independent evidence to touch it | this tenant needs specialization |
| `ACTION_REJECTED` | the surface refused (`NODE_NOT_ACTIONABLE`, `CONTAINER_GONE`, …) | usually a settling problem; check `stability.pendingReason` |
| `CHECKPOINT_UNMET` | the postcondition never held (`reason: 'timeout' \| 'contradicted'`) | the action did not do what the recording said it did |
| `AMBIGUOUS_CLASSIFICATION` | two rules matched with no declared priority order | the taxonomy is wrong; a human must decide which wins |
| `EXTRACTION_FAILED` | a value was found but failed its extractor or its declared type | the field's format changed |
| `RECOVERY_EXHAUSTED` | a known recoverable condition would not clear | the condition is now chronic, not transient |
| `BUDGET_EXHAUSTED` | a ledger ran out | the app got slower, or the budget was always wrong |
| `CONTROL_LOST` | the lease was taken or expired mid-run | a human intervened, or the operator console dropped |
| `SURFACE_ERROR` | driver-level fault (browser crash, pty died) | infrastructure |
| `INTERNAL_INVARIANT` | the interpreter violated its own invariant | **file a bug.** This class exists because a system that cannot say "I am broken" says "you are" instead |

`LINK_ERROR` and `ARGUMENT_INVALID` are worth separating from everything below them: they are the
only two classes that guarantee **nothing happened**. In a regulated environment "we definitely did
not touch anything" is a materially different answer from "we stopped partway", and the result
contract should not make a caller infer it.

### 8.3 The three arms, in the flow above

```json
{
  "status": "success",
  "invocationId": "inv_01JQ7Y3M2K",
  "contractId": "cu.member.lookup_savings_balance",
  "contractVersion": "1.2.0",
  "artifactDigest": "sha256:1d0c9b8a…",
  "overlayDigest": "sha256:8f7e6d5c…",
  "effectiveDigest": "sha256:b4e2a719…",
  "surface": "browser",
  "tenantId": "summit-federal-cu",
  "durationMs": 4820,
  "stepsExecuted": 9,
  "stepsTotal": 9,
  "budgets": {
    "actions": { "used": 4, "limit": 16 },
    "observations": { "used": 21, "limit": 240 },
    "wallClockMs": { "used": 4820, "limit": 120000 },
    "recoveryExcursions": { "used": 1, "limit": 3 },
    "programAttempts": { "used": 1, "limit": 2 }
  },
  "recoveriesApplied": [
    { "stepId": "s05_open_member_record", "name": "DISMISS_PRIVACY_ACKNOWLEDGEMENT", "attempts": 1, "outcome": "resolved" }
  ],
  "controlTransfers": [],
  "drift": {
    "fingerprint": "sha256:c1d0e9f8…",
    "expected": "sha256:9a2b47c1…",
    "divergence": 0.083,
    "changed": [
      { "stepId": "s03_submit_search", "descriptorId": "d_search_name",
        "was": "resolved", "now": "abstained" }
    ],
    "needsSpecialization": false
  },
  "outputs": {
    "memberName": "DELORES A. SYNTHETIC",
    "savingsBalanceUsd": "4182.77",
    "savingsAccountTail4": "0001",
    "asOf": "2026-08-21"
  },
  "outputsSensitivity": {
    "memberName": "sensitive",
    "savingsBalanceUsd": "internal",
    "savingsAccountTail4": "internal",
    "asOf": "public"
  },
  "journalRef": "ev:run/2026-08-24/inv_01JQ7Y3M2K/journal.jsonl"
}
```

```json
{
  "status": "outcome",
  "invocationId": "inv_01JQ7Y41BW",
  "effectiveDigest": "sha256:b4e2a719…",
  "stepsExecuted": 3,
  "stepsTotal": 9,
  "outcome": {
    "code": "MEMBER_NOT_FOUND",
    "title": "No member with that number",
    "payload": { "searchedMemberId": "40009999" },
    "detectedAt": { "stepId": "s03_submit_search", "stepIndex": 2, "phase": "post" },
    "matched": {
      "op": "matches",
      "verdict": true,
      "field": "text",
      "matcherValue": "no matching member on file",
      "satisfiedBy": [{ "role": "alert", "name": "", "textDigest": "sha256:6a1f…" }]
    },
    "alsoMatched": [],
    "retriable": true,
    "evidence": "ev:run/2026-08-24/inv_01JQ7Y41BW/s03.png"
  },
  "drift": { "divergence": 0.083, "needsSpecialization": false },
  "journalRef": "ev:run/2026-08-24/inv_01JQ7Y41BW/journal.jsonl"
}
```

Three things to notice. `stepsExecuted: 3` of 9 — the run stopped early and that is **correct
behaviour**, not truncation. The payload is the outcome's own type: there is no `savingsBalanceUsd`
key set to null, because a not-found member does not have a balance to be null. And the literal that
fired is Summit's overridden `"No matching member on file"`, so the same program returned the same
typed outcome on a tenant whose wording differs — which is the entire multi-tenant claim, in one
field.

```json
{
  "status": "failure",
  "invocationId": "inv_01JQ7Y5C7T",
  "effectiveDigest": "sha256:b4e2a719…",
  "stepsExecuted": 4,
  "stepsTotal": 9,
  "failure": {
    "class": "TARGET_AMBIGUOUS",
    "stepId": "s05_open_member_record",
    "stepIndex": 4,
    "stepTitle": "Open the matching member's record",
    "message": "Two independent descriptions of the target selected different controls. Refusing to act.",
    "expected": {
      "rendered": "the link in the \"Member\" column of the row whose \"Member ID\" cell equals param.memberId, inside the table named \"Search Results\", inside frame \"main\"",
      "clauses": [
        { "descriptorId": "d_row_cell", "evidenceSource": "columnHeader", "verdict": "resolved", "node": "row 1 / column \"Member\" / link" },
        { "descriptorId": "d_row_geo",  "evidenceSource": "geometry",     "verdict": "resolved", "node": "row 1 / column \"Alias\" / link" }
      ]
    },
    "observed": {
      "route": "/cb/members/search/results",
      "containerPath": "root › frame[main]",
      "nodeCount": 214,
      "salientNodes": [
        { "role": "columnheader", "name": "Member ID" },
        { "role": "columnheader", "name": "Alias" },
        { "role": "columnheader", "name": "Member" },
        { "role": "row", "name": "", "cells": 5 }
      ],
      "screenTextDigest": "sha256:d90c…"
    },
    "evidence": "ev:run/2026-08-24/inv_01JQ7Y5C7T/s05.png",
    "retriable": false,
    "operatorAction": "Do not loosen the target. The results table gained an \"Alias\" column, so the geometric descriptor now lands one cell short. Add a tenant descriptor via overlay, or re-record."
  },
  "drift": { "divergence": 0.25, "needsSpecialization": true }
}
```

That failure is the design working. A first-match locator strategy would have clicked *something*,
landed on a member record, and returned a balance — the wrong member's. **The system's most valuable
behaviour is refusing to act**, and this is what refusing looks like when it is written down.

### 8.4 Failure messages are generated, not written

`expected.rendered` above was not authored by anyone. It is a fold over the declared descriptor:

```ts
function renderTarget(t: Target): string;      // Target      → prose
function renderPredicate(p: Predicate): string; // Predicate   → prose
function renderVerdict(p: Predicate, o: Observation): ExpectationTrace; // + per-clause verdicts
```

This is the concrete payoff of refusing an expression language, refusing regexes, and refusing CSS.
Every construct the language kept, it kept partly because **the interpreter can explain it to a
human at 2am**. A design that stored `#ctl00_g_9a1 > td:nth-child(3) a` could print the string and
nothing more. A design that stored an arbitrary predicate lambda could not even do that.

---

## 9. Two surfaces, one language

The build brief includes a pty-driven character-grid surface specifically to prove the abstraction is
real. Interpreter-first design makes a precise claim about what "real" means here, and it is narrower
than "the same file runs everywhere".

### 9.1 What is genuinely shared, and what is not

| Layer | Shared across browser and character grid? |
|---|---|
| `CapabilityContract` — params, returns, outcome codes | **Yes, identically.** One agent-facing tool. |
| The instruction set, predicate language, extractors, normalizers | **Yes.** Same nine opcodes, same eleven predicate ops. |
| The error taxonomy — outcome and recovery *detectors* | **Mostly.** Detectors read normalized text and roles, so `contains "NO MEMBER ON FILE"` works on both. Wording differs; that is what `setLiteral` is for. |
| Descriptor *kinds* | **Yes.** `labelAnchored` and `tableCell` are the two idioms that carry both. |
| The `Program` — the actual step sequence | **No, and I will not pretend otherwise.** Green-screen flows have different screen counts and different field orders. |

So: **one contract, one language, one taxonomy, two programs.** The `CapabilityContract` is a
separate document precisely so this is expressible without a lie (§6.0). A tenant on the web core and
a tenant still on the green screen call the identical agent-facing capability; the resolver picks the
artifact whose `target.surfaceKind` matches the app instance.

### 9.2 How each construct is realized

This table is the actual test of whether the ports in §4 are an abstraction or a browser API with
extra steps.

| Construct | Browser (`surface-browser`) | Character grid (`surface-terminal`) |
|---|---|---|
| `Observation.nodes` | CDP `Accessibility.getFullAXTree`, merged with `DOM.getBoxModel` geometry. **Not `querySelector`.** | Synthesized from the VT screen buffer: a run of `_` or reverse-video cells following a `Label:` token becomes `role:'textbox', name:'Label'`; the PF-key legend line (`F3=Exit  F5=Search`) becomes `role:'button'` nodes named by their legend text |
| `UINode.confidence` | 1.0 for an AX node with an explicit label; lower for a computed name | derived from the synthesis heuristic that produced the node — a bracketed `[ Search ]` scores higher than a bare label guess |
| `containers` | the frame tree | screen id plus detected drawn boxes (`┌─┐` runs) as `dialog` regions |
| `bounds` / `boundsUnit` | CSS pixels | character cells |
| `stability.quiescent` | no in-flight navigation or fetch, plus two consecutive identical AX generations | no bytes from the pty for `settleQuietMs`, cursor parked, no pending screen-clear |
| `Location.route` | canonicalized path pattern | the screen/transaction id read from the fixed header field |
| `navigate` | `page.goto(origin + route)` | type the transaction code into the command line and send |
| `click{role:'button', name:'Search'}` | element click | **`pressKey(F5)`** — the legend line said `F5=Search`, so the synthesized button node carries the key that activates it |
| `fill` | focus, then set value | move the cursor to the field origin, clear its declared width, type |
| `labelAnchored{relation:'rightOf'}` | `<label for>` / `aria-labelledby` / nearest preceding text | the next non-blank cell run on the same row |
| `tableCell` | `table`/`row`/`cell`/`columnheader` roles | column boundaries inferred from the header row, then row scan |
| `pressKey('F3')` | dispatched as a key event; usually meaningless | the primary submit and back mechanism |
| Sensitive-region masking | overpaint the node's box before PNG encode | blank the cell range before the grid dump is written |

The row that carries the argument is `click{role:'button', name:'Search'}` → `pressKey(F5)`. **The
program says what the operator meant; the surface says how that is done here.** That is the seam the
brief asks about, and it is only expressible because the language has no `pressKey('F5')` hardcoded
into a "click search" step and no CSS selector to make it browser-only.

### 9.3 What does not survive, stated plainly

- **`hover` and `scroll` do not exist** as instructions, and would not have ported. Paging on a grid
  is `pressKey(F7/F8)`; that is a *step* on a grid program and simply absent on a web program.
- **Role synthesis on a grid is a heuristic**, so grid observations carry lower `confidence` and
  descriptors abstain more often. This is why `SurfaceCapabilities.confidenceFloor` exists and why
  the linker refuses a program whose targets need descriptor kinds the surface cannot resolve
  (§6.7 check 17) — the failure lands at load time with a clear message rather than at step 6 with a
  mysterious `TARGET_NOT_FOUND`.
- **Quorum independence is weaker on a grid** (§5.3). Role, name, and label anchoring can all derive
  from the same label token. `evidenceSource` makes this visible; it does not make it go away.
- **Desktop (AX/UIA) is a documented seam, not built.** It fits the same ports — `Observation.nodes`
  from the platform accessibility API, `containers` as windows — and would need one new `Container`
  kind and a `navigate` that means "activate this view". Nothing in the language changes.

---

## 10. Workspace layout

Eight packages and two fixtures. The brief says architecture theatre earns nothing, so the rule
applied here is: **a package exists only if something outside it would import it, or if it must be
excludable from a build.** Everything else is a directory.

Published scope follows the house convention of the sibling repos (the full repo name as the npm
scope); `@crr/` is used below purely to keep the table readable.

| Package | One-line justification |
|---|---|
| `@crr/schema` | **The language.** Types, zod schemas, the `Observation`/`Action`/`Surface` port declarations, JCS canonicalization + digest, the linker's twenty checks, the normalizer/extractor/format registries, and the prose renderers. Zero runtime dependencies beyond zod, so a reviewer's tooling or a tenant's CI can validate and diff an artifact without pulling an engine or a browser. |
| `@crr/core` | **The trusted kernel** shared by both execution paths: the single `PolicyEngine.check` chokepoint, the control lease, the append-only journal, the taint/redaction model, and the file-backed `ArtifactStore`. Discovery and replay must enforce the *same* policy, so it cannot live inside either. |
| `@crr/replay` | **The interpreter.** Machine state, the step semantics, the classifier, the target resolver, budgets, the fingerprint. Contains no I/O and no clock read; a source-scanning contract test enforces that, and a second one enforces that it imports no driver and contains no CSS-selector vocabulary. |
| `@crr/discovery` | The LLM observe→decide→act loop, the descriptor deriver, the parameterizer, the route canonicalizer, and the record-then-immediately-replay verification gate. Separate because the no-live-services demo path must not pull a model SDK. |
| `@crr/surface-browser` | Playwright + CDP driver: builds `Observation` from `Accessibility.getFullAXTree` merged with box geometry. The only package allowed to know what a DOM is. |
| `@crr/surface-terminal` | Pty + VT-buffer driver that synthesizes an accessibility tree from a character grid. **This package's whole reason to exist is to make the port falsifiable** — if it cannot be written, the abstraction was aspirational. |
| `@crr/conformance` | Fault scenarios × replay engines, asserting correct three-way classification and zero false successes — plus **deliberately weakened engines** (first-match locators, no checkpoint verification, no outcome classifier, no quorum) and a meta-test that fails if the suite stops discriminating between them. Separate so the broken engines can never ship inside `@crr/replay`. |
| `@crr/cli` | `discover`, `replay`, `verify`, `approve`, `diff`, `catalog`, `stability`, plus the bare operator console. The console is a directory here, not a package: nothing imports it. |
| `fixtures/corebank-web` | The intentionally hostile web surface: framesets, table layout, generated ids, `<font>` tags, no test IDs, a modal step, per-request fault injection, and two tenant variants of the same vendor product. |
| `fixtures/corebank-tui` | The green-screen variant, so the terminal surface has something to drive. |

### Packages deliberately **not** created

| Not created | Why |
|---|---|
| `@crr/policy` | Policy is ~300 lines and has exactly one meaningful property — that it is the *only* chokepoint. A package boundary does not add that; the contract test that fails if any `Surface.act` call site bypasses it does. |
| `@crr/llm` | Its only consumer is `@crr/discovery`. **A port is a file, not a package.** |
| `@crr/operator-console` | Nothing imports it. It is a directory in `@crr/cli`. |
| `@crr/store` | One interface and one fs-backed implementation, used by three packages that already depend on `@crr/core`. |
| `@crr/types` | A types-only package is the canonical symptom of a boundary nobody could name. The types belong with the language that gives them meaning. |
| `@crr/multitenant` | Overlay merge is a pure function over two documents. It belongs in `@crr/schema` next to the linker that re-checks its output. Building "multi-tenant plumbing" is explicitly listed in the brief as something that earns nothing. |

---

## 11. Refusals: what is not in the language

Every entry below was considered, has a real use case, and was still refused. The cost is stated
next to the refusal, because a refusal whose cost you cannot name is a preference, not a decision.

| Refused | Real use case it would serve | Why it is out | What it costs, honestly |
|---|---|---|---|
| **Conditionals (`if`)** | the app sometimes lands on a detail page and sometimes on a results list | With a branch, `analyzeEffects` degrades from an exact set to an upper bound, so a signed approval over a digest stops describing what will actually happen — and the fingerprint gains a degree of freedom that makes drift undetectable | Genuinely branching flows must be decomposed into several capabilities, and the branch lives in the calling agent. **The calling agent is a Turing machine. The capability must not be.** |
| **Loops over actions** | "for each of the member's shares, open it and read the rate" | Unbounded in actions; destroys the budget guarantee and the effect analysis; and a loop that runs 3 times in recording and 700 times in production is a denial-of-service against a bank's core | `readTable` covers the read-only fan-out case. True per-row *action* fan-out is the calling agent's job: it calls `list_shares`, then calls `read_share_rate` N times, with its own budget |
| **An expression language** (arithmetic, concatenation, comparison operators) | "search for `lastName + ', ' + firstName`" | It is a Turing tarpit, an injection surface, and it puts semantics in the artifact that no reviewer and no static analysis can audit | Composition happens in the caller, which passes the composed value as a parameter. Slightly more parameters; vastly more reviewable |
| **Artifact-authored regex** | extracting `$4,182.77` out of `Balance: $4,182.77 (avail $4,100.00)` | It is an expression language wearing a disguise: unreviewable, ReDoS-prone, and it makes an artifact's meaning depend on a regex engine's dialect | A missing extractor is a PR to the registry, reviewed once and then reused across hundreds of tenants. That is leverage, not friction — but it *is* a release, and a flow can be blocked on one |
| **CSS selectors / XPath** | it is what every recorder in the world emits | A second language the interpreter cannot typecheck, cannot re-interpret on a grid, and cannot render into an "expected" line. `querySelector` silently returning the first match is the exact failure this system exists to prevent | Descriptor derivation is real work, and there are controls with no accessible name that a CSS selector would have found in one line |
| **Raw coordinates as a primary target** | a screenshot-only surface with no tree at all | Viewport-, zoom-, and font-dependent: a determinism hole the language can simply not have | A pure-pixel surface (a Citrix window, say) would need a new descriptor kind and honest degradation, not a coordinate field bolted onto this one |
| **`sleep` / fixed delays** | "wait 3 seconds after clicking, it always works" | The single largest source of both flake and wasted wall clock; a recorded sleep encodes the recording machine's load into the artifact forever | A screen with no observable settling signal needs a `Surface` that computes quiescence properly. That is real work pushed onto the driver, deliberately |
| **`toggle`** | "click the checkbox" | Order-dependent, therefore not replayable | none |
| **Sub-flow calls / `include`** | shared login preamble across 40 capabilities | Recursion risk, and it makes the approval digest cover something the reviewer did not read | Duplication across artifacts today. The seam: `include` would be a **linker** feature — statically resolved, acyclic, depth-capped, and flattened before the interpreter ever sees it. **Composition is a linker feature, not an interpreter feature.** |
| **Clock reads inside the program** | "if it is after 5pm, use the next-business-day screen" | A program that reads a clock is not a pure function of `(program, args, observations)` and cannot be replayed for a postmortem | Any date the flow needs arrives as a parameter. The caller owns the calendar |
| **Random / UUID generation** | generating a reference number | Same reason; also makes idempotency impossible to reason about | Comes from the invocation (`idempotencyKey` on the envelope) |
| **A model call at replay time** | "the screen changed a bit, let the LLM figure it out" | It would void the one property the whole system is for. A capability whose behaviour depends on a model is not a capability, it is another agent | The brief's "assisted fallback" stretch goal is still reachable — but as a **supervisor** action that produces a *proposed overlay patch* for human review, never as an instruction the interpreter can execute |
| **`customStep` / a JS hook** | the universal escape hatch | It converts the artifact from data into code and voids every guarantee at once: the digest stops meaning anything, the effect analysis stops being sound, and the language stops being reviewable | Some flow, somewhere, will need something the nine instructions cannot express. The answer is a tenth instruction with a declared postcondition, argued for on its merits — not a hole |
| **Whole-program retry** | "just try again" | Hides the difference between transient and chronic, and re-executes writes | Only the gated restart of §2.5, which refuses outright once an irreversible step is behind the pc |
| **PII values of any kind** | it would make the example artifact more readable | Structural, not a lint: a `fill` value may be a literal only when the recorder classified it as non-goal-derived, and literals are typed `sensitivity: 'public'`. Enforced at link time | Nothing. This is the rare case where the safe design is also the reusable one — it is the same mechanism as parameterization (build brief §3.6) |
| **Credentials or session state** | replay needs to log in | Never in the artifact. `secret` params resolve from a credential provider at invocation and may not appear in `returns` | Some coupling to a credential provider at deploy time |
| **Inline screenshots / transcripts** | self-contained artifacts | An `Observation` is passed to pure functions and must stay cheap to clone and to freeze into a fixture; a transcript is the likeliest place for raw PII to hide | Evidence lives in a store and is referenced by `EvidenceRef` |
| **Cosmetic assertions** (colour, font, pixel position) | "the error text is red" | Not semantics. It would fail correct runs on a rebrand | A genuinely colour-encoded state (a red row meaning "frozen") needs the surface to expose it as `NodeState`, not the language to grow a colour predicate |
| **Per-tenant values in the base artifact** | expedience | It is the thing that turns one artifact into 400 | Overlays, and the operational cost of pinning them (§13) |

### 11.1 The one conditional I would add first, and what it would cost

`skipIf: Predicate` on a step — the step becomes a no-op when the predicate holds. This is the
minimal branch, and it is worth being explicit that it would *not* break the core properties: the
program stays straight-line, `pc` still only increases, termination is unaffected, and it is still
statically analyzable. It would solve real problems immediately, starting with "this tenant's build
shows a confirmation dialog and that one does not."

It is still not in v1, for three specific costs:

1. `analyzeEffects` degrades from an **exact** effect set to an **upper bound**, so an approval says
   "may write" instead of "writes". In a regulated environment that is a meaningful downgrade of what
   a signature means.
2. A skipped step's postcondition goes unverified, so the checkpoint chain — the thing that tells you
   *where* a flow went wrong rather than merely that it did — develops holes.
3. The fingerprint gains a degree of freedom. "This descriptor abstained" and "this step was skipped"
   become hard to tell apart, and drift detection gets noisier exactly where it matters.

The v1 answer to the confirmation-dialog case is a **recovery** with an `actions` remedy, which is
already bounded, budgeted, counted in `recoveriesApplied`, and visible in the result. That covers the
overwhelming majority of what `skipIf` would be used for, and it covers it with better observability.
Knowing precisely where the line is — and what crossing it costs — matters more than where it is
drawn.

---

## 12. One settled decision I would amend

I agree with all nine of the decisions in build brief §3. One of them has a hole that only shows up
once you think about the interpreter, and one has an internal tension worth naming.

### 12.1 §3.4 "recording is not a claim until it replays" is unsound for irreversible flows

The gate is right and it is the best idea in the brief: after discovery, immediately replay the
artifact with the model out of the loop, and only save it as `draft` if that succeeds. It closes the
gap between "the model did it" and "the recording faithfully describes what it did."

But taken literally it cannot be applied to the flows that need it most. *"Open a new sub-account for
this member and reach the confirmation screen"* — the brief's own second example goal — cannot be
verified by replaying it, because replaying it opens a second sub-account. And an unverifiable
capability is exactly the class where a mistake is expensive.

There is a second, quieter problem: immediate replay runs against the session state the discovery run
left behind — already authenticated, caches warm, and the record possibly now *changed by* the
discovery run. It verifies the flow in the one condition it will never be replayed in.

**The amendment, and it costs almost nothing because the language already supports it:** verification
runs against a **fresh session and a reset fixture**, and the interpreter gains one mode.

```ts
type ExecutionMode =
  /** Every instruction executes. The only mode allowed in production. */
  | { mode: 'full' }
  /** Every instruction executes EXCEPT those declared WRITE_IRREVERSIBLE. For those, the
   *  interpreter resolves the target (proving the descriptors work and quorum holds), evaluates the
   *  precondition, evaluates the outcome and recovery detectors — and does not act. It then stops
   *  at the first such step and reports `verified(partial)` naming the steps it did not execute. */
  | { mode: 'dry' };
```

This is expressible *only* because effects are declared statically and the program is straight-line:
the interpreter can know which steps to skip before it starts, and can tell you exactly which ones
they were. The resulting lifecycle is honest rather than binary:

| Verification result | Lifecycle state | Unattended replay? |
|---|---|---|
| `full` replay succeeded end to end | `verified` | yes, once approved |
| `dry` replay reached the first irreversible step with every target resolved | `verified(partial)` | **no** — `attended` approval only, until a human has watched one live run |
| replay failed | stays `proposed`, with the failure attached | no |

`verified(partial)` is a weaker claim than `verified`, and the design should say so in the artifact
rather than let an operator assume otherwise. That is the whole amendment: **do not let a gate that
cannot run on the risky case silently report the same thing it reports on the safe one.**

### 12.2 §3.2's "ranked set of descriptors" and "disagreement is not a fallback chain" are in tension

Taken literally, a *rank* implies a preference, a preference implies a winner, and a winner is a
fallback chain — which is precisely what the same sentence forbids. The two halves cannot both be
literal.

This proposal resolves it as **quorum with abstention** (§5.2): rank determines nothing about who
wins. Every descriptor is evaluated, all results are compared, agreement is required, and
disagreement is a hard stop. Rank survives only as two things it can honestly be:

- **eligibility** — `geometry` and `ordinal` cannot carry a quorum between them, and
- **evidence independence** — quorum requires ≥ 2 distinct `evidenceSource` values (§5.3).

I read this as sharpening §3.2 rather than contradicting it, but it is a real change to what "ranked"
means and it should be visible rather than quietly implemented.

---

## 13. Risks and limits

Stated here rather than discovered by a reviewer.

1. **`effect` is declared, not proven.** Nothing verifies that a step marked `READ` does not write
   server-side. The linker checks consistency; a human checks truth, at approval time. A partial
   mitigation exists for the browser surface — cross-check the declaration against observed request
   methods during discovery and flag a `READ` step that issued a `POST` — but that is a heuristic,
   it does not exist for the terminal surface at all, and it must not be sold as a guarantee. **This
   is the load-bearing assumption under the entire safety story.**

2. **Quorum only helps when descriptors are independent.** `evidenceSource` makes correlation
   *visible* and lets the linker demand two distinct sources; it cannot make two descriptors that
   both read the same label token genuinely independent. §7.4 shows a case in this very artifact
   where the check passes on the letter. On a character grid this is systematically worse.

3. **The straight-line refusal will meet a flow that genuinely branches**, and the answer —
   decompose into several capabilities — pushes complexity into the calling agent and increases the
   number of artifacts to maintain. §11.1 names the escape hatch I would add first and what it costs.

4. **The closed extractor/normalizer registry will block a flow.** A capability that needs a shape
   the registry lacks cannot ship until the registry does. That is a release-cadence coupling between
   an artifact and the engine, and it is the direct price of refusing inline regex.

5. **Registry versioning is what keeps "artifact is data" true, and it is easy to get wrong.** Ids
   carry a major (`currencyUSD@1`) precisely so engine code cannot silently change what an approved
   artifact means. If anyone ever "fixes" a registry entry in place, the digest keeps matching while
   the behaviour changes — the exact failure the content-addressing was for. This needs a test, not a
   convention.

6. **Overlay pinning is real operational cost at hundreds of tenants.** An overlay pins a base
   digest, so bumping a base artifact leaves every overlay in `needs-reverification`. That is the
   correct default — the alternative is overlays silently applying to a program they were never
   checked against — but at 400 tenants it is a queue someone has to work, and this design does not
   solve that. It only makes the backlog visible instead of invisible.

7. **Restart-from-entry doubles wall clock and re-executes every read.** It is gated on effects, but
   nothing bounds the *cost* beyond `maxProgramAttempts` and the global budgets. On a slow legacy app
   a session timeout at step 8 turns a 5-second capability into a 60-second one.

8. **`readTable` truncation defaults to failing**, which is right, but it means a member with more
   shares than `maxRows` fails a read-only lookup. The alternative — silent truncation — is worse,
   and `onTruncate: 'flag'` exists for callers who genuinely want a prefix. It is still a sharp edge.

9. **The predicate depth cap of 4 will bite** on some legacy screen whose error banner is only
   distinguishable by a genuinely gnarly condition. The workaround is a `NodeQuery` doing more work
   inside one clause, which is less readable, not more.

10. **`AMBIGUOUS_CLASSIFICATION` will fire in production** the first time a permission-denied banner
    and an app-error banner appear together on a screen where the recording only ever saw one. That
    is the design working — it refuses to guess which answer the caller gets — but it is a hard
    failure on a run that a sloppier system would have completed, and someone will file it as a bug.

11. **The "no PII in artifacts" guarantee has a typed half and a heuristic half.** The typed half is
    solid: a literal can only be `public`, so a sensitive value structurally cannot be stored as one.
    The heuristic half is the recorder deciding that `40001234` in the goal text is the same
    `40001234` it just typed into a field, and therefore should become a parameter rather than a
    literal. That inference is good but not perfect, and the linker cannot re-derive it. A value the
    recorder failed to recognise as goal-derived would be stored as a `public` literal and would be
    wrong. The mitigation is a recorder-side lint plus human review at approval — not a proof.

12. **None of this is measured.** No benchmark, no flake rate, no replay-success rate is claimed
    anywhere in this document, because nothing has been built. The conformance suite in build brief
    §5 is where those numbers would come from, and until it runs, every performance and reliability
    statement here is a design intention.

---

## 14. Build order, if this proposal is adopted

The interpreter-first framing implies its own build order, and it front-loads the parts the
assignment says are central.

1. `@crr/schema` — the types, the linker, the registries, the digest, and the prose renderers. It has
   no dependencies and it makes everything downstream typecheckable. Ship it with the twenty linker
   checks as twenty tests.
2. `@crr/replay`'s classifier and resolver, tested entirely against **frozen `Observation` JSON** —
   no browser, no pty. This is where the three-way taxonomy is proven, and it can be proven before a
   single driver exists. It is also the largest source of the code-quality signal the brief asks for.
3. `@crr/surface-browser` and the `fixtures/corebank-web` hostile app with its fault injection,
   because the fault injection is what makes step 2's tests real rather than imagined.
4. The interpreter loop, the budgets, the lease, and the policy chokepoint.
5. `@crr/discovery` and the record-then-replay gate — including the `dry` mode of §12.1.
6. `@crr/conformance` with the weakened engines and the meta-test.
7. `@crr/surface-terminal` and `fixtures/corebank-tui` last, because their job is to **falsify** the
   port. If they cannot be written against the ports as specified in §4, that is the most valuable
   result this project can produce, and it is worth discovering with everything else already working.
