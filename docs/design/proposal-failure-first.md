# Proposal: a failure-first realization of record → replay

**Status:** design proposal, nothing implemented. Every type in here is a proposal for
`packages/core`, not a description of code that exists. Numbers do not appear in this document
because nothing has been measured yet; where a threshold is named it is a *default to be tuned
against the conformance corpus*, and it says so.

**Scope:** this document takes the nine decisions in `.private/BRIEF.md §3` as given and proposes
the concrete realization of them, derived from one starting point: the enumeration of everything
that can happen during a replay step. §12 says where I think one of those nine decisions is wrong
and what I would change.

---

## 1. Thesis

A replay engine is not an automation script with error handling bolted on; it is **a classifier with
an actuator attached**. The valuable, hard-to-get-right artifact is not the step list - with a stable
UI, the step list is close to trivial - it is the declared, reviewable mapping from *what the screen
shows* to *what the caller is told*, and the code that evaluates that mapping is a pure total
function from a frozen `Observation` to a `Verdict`. So the schema is designed backwards from that
function: every field exists because the classifier, the pre-act target assertion, or the human
reviewing the artifact needs it, and anything the classifier cannot read is not in the artifact.
Three consequences fall straight out and drive the rest of this document. First, **the taxonomy is
declared data with a fail-closed default** - an unrecognized screen is a hard failure, never an
inferred business outcome, because a false `MEMBER_NOT_FOUND` is the single worst thing this system
can emit: it launders a broken automation into a confident answer a member hears. Second, **"not
yet" is not "not so"** - no negative outcome may be classified against a surface that has not
demonstrably settled, which is the same conflation error the brief warns about, running in the
opposite direction. Third, **acting on the wrong target is a targeting problem to be prevented, not
a failure to be detected**, so identity is re-derived from the caller's own input at the moment of
the click rather than from position, and the residual cases that survive that are exactly the reason
irreversible actions need a human.

---

## 2. The failure taxonomy

Everything below is derived from this table. It is the design.

### 2.1 The enumeration

`Band` is the detector precedence band from §3.2. `Decided by` says who owns the decision: `schema`
means the artifact author declared it, `engine` means it is built in and not configurable,
`pre-flight` means it is decided before the surface is touched at all.

| # | What happened | Disposition | Band | Code / class | Decided by |
|---|---|---|---|---|---|
| 1 | Caller's argument fails a declared param constraint | **outcome** `INVALID_INPUT` | - | `callerAction: retry-different-input` | pre-flight |
| 2 | App shows a validation error, and the offending value is **param-bound** | **outcome** e.g. `INVALID_MEMBER_ID` | B3 | `callerAction: retry-different-input` | schema |
| 3 | App shows a validation error, and the offending value is **artifact-literal-bound** | **hard failure** | B6 | `checkpoint-failed` | engine |
| 4 | Record not found | **outcome** `MEMBER_NOT_FOUND` | B3 | `callerAction: inform-user` | schema |
| 5 | Permission denial scoped to the **record** ("this account is restricted") | **outcome** `MEMBER_RESTRICTED` | B3 | `callerAction: escalate-human` | schema |
| 6 | Permission denial scoped to the **session/role** ("your role lacks OPEN_SUBACCOUNT") | **hard failure** | B1 | `entitlement-denied`, `retriable: after-human-action` | schema |
| 7 | Unexpected dialog / interstitial, **declared** | **recoverable** | B2 | remedy `dismiss`, budgeted | schema |
| 8 | Blocking overlay present, **undeclared** | **hard failure** | B2 | `undeclared-dialog` | engine |
| 9 | Session expiry, resume point exists and no irreversible step was crossed | **recoverable** | B1 | remedy `reauthenticate` + `restart-from-checkpoint` | schema |
| 10 | Session expiry, otherwise | **hard failure** | B1 | `session-expired-unrecoverable` | engine |
| 11 | Transient slowness | **recoverable** | B0→B4 | `pending` then remedy `wait`, budgeted | engine + schema |
| 12 | Surface never settles within the settle budget | **hard failure** | B0 | `did-not-settle` | engine |
| 13 | App error page / 5xx / stack trace | **hard failure** (one retry only if `effectClass: READ`) | B1 | `app-error` | schema |
| 14 | Locator: descriptors resolve to **different** nodes | **hard failure** | G (pre-act) | `target-ambiguous` | engine |
| 15 | Locator: fewer descriptors resolve than the quorum requires | **hard failure** | G (pre-act) | `target-not-found` | engine |
| 16 | Pre-act target assertion fails (role/name/rowKey mismatch) | **hard failure** | G (pre-act) | `target-assert-failed` | engine |
| 17 | Checkpoint predicate false and nothing above matched | **hard failure** | B6 | `checkpoint-failed` | engine |
| 18 | Action dispatched, no observable delta | **hard failure** | B5 | `no-observable-effect` | engine |
| 19 | Checkpoint true but the continuity value is absent or different | **hard failure** | B5 | `continuity-broken` | engine |
| 20 | Checkpoint true, required output missing or untypeable | **hard failure** | post-B5 | `output-extraction-failed` | engine |
| 21 | Action or navigation outside the allowlist | **hard failure** | G (pre-act) | `policy-denied` | engine |
| 22 | Human took the control lease mid-run | **hard failure** unless handoff-resume | control plane | `lease-lost` | engine |
| 23 | Entry precondition false at step 0 | **hard failure** | G | `precondition-not-met` | schema |
| 24 | Recovery budget exhausted | **hard failure** | B4 | `recovery-exhausted` | engine |
| 25 | Run deadline or total remediation budget exhausted | **hard failure** | any | `budget-exhausted` | engine |
| 26 | **Irreversible action dispatched, result never observed** | **hard failure**, auto-escalate | terminal | `effect-in-doubt`, `retriable: no` | engine |
| 27 | Two detectors in the same band match one Observation | rejected at save time; at runtime, first-declared wins **and the run is flagged** | lint | `detector-overlap` (journal flag) | lint + engine |
| 28 | Artifact fails schema validation or an invariant | **hard failure** before step 0 | pre-flight | `artifact-invalid` | pre-flight |

Rows 1, 3, 6, 12, 18, 19, 20, 26, 27 are the ones I would defend hardest in a review, because they
are the rows a happy-path design silently gets wrong.

### 2.2 Four things the table asserts that are not obvious

**Row 2 vs row 3 - the same red banner means two different things.** "Member ID must be 5 digits" is
a legitimate business answer when the value the app rejected came from the *caller's* argument: the
agent supplied a bad member id and needs to be told so it can ask the member again. The identical
banner is a hard failure when the rejected value was a literal baked into the artifact, because then
the artifact is wrong and no caller can fix it. The classifier can tell these apart only because
binding provenance is an input to it (`ResolvedBindings`), which is a second, unadvertised return on
the parameterization decision in `BRIEF §3.6`: parameterization is what makes validation errors
classifiable at all.

**Row 1 - the cheapest classification touches no surface.** Declared param constraints
(`charset`, length, `enum`) are evaluated before `perceive()` is ever called. Driving four steps of a
legacy UI to learn that `"abc"` is not a member id is slower, flakier, and produces a worse error
message than rejecting it in a nanosecond. `INVALID_INPUT` is a first-class outcome with no step
attached.

**Rows 5 vs 6 - permission denial is polymorphic and must be declared.** A denial that is a property
of *the record* is an answer ("this member's account is flagged; a supervisor must service it"). A
denial that is a property of *the session's role* is an environment fault: it will fail identically
for every input forever, retrying is pointless, and the fix is a person changing an entitlement.
These render as almost the same screen. The artifact author declares which detector means which, and
**an undeclared denial defaults to row 6, the failure**, never to row 5. That is the fail-closed rule
in its most consequential instance.

**Row 26 - the row the brief does not list.** If an irreversible action is dispatched and the session
dies before its effect is observed, there is no honest classification available locally. It did not
"fail" and it did not succeed. The only correct behavior is to stop, return `effect-in-doubt` with
`retriable: 'no'`, raise an intervention, and let a person reconcile against the system of record. A
replay engine that retries here opens two sub-accounts. This is the same discipline as
`../durable-agent-outbox`'s `IN_DOUBT` status, and it is why `effectClass` is a schema field rather
than a comment.

### 2.3 Three dispositions, and why not four

The result contract has exactly three top-level statuses: `ok`, `outcome`, `failed`. Rows 5, 6, 22
and 26 all argue for a fourth - `blocked` or `escalated` - and I am rejecting it, on the grounds that
the caller is an AI agent and the union should be shaped by **the branches the caller actually
takes**, not by our internal categories:

- `ok` → use the outputs.
- `outcome` → tell the user this answer. Read `callerAction` for whether to re-ask for input.
- `failed` → tell the user nothing about the domain, and raise an incident.

A fourth status would subdivide the third without changing what the agent does. What the *operator*
needs - is this a bad artifact, a bad environment, or an in-doubt write - is carried inside
`failed` as `class`, `retriable`, and `escalation`, where it can be exhaustive without inflating the
contract every caller must switch on. Adding a status is a breaking change to every caller; adding a
`FailureClass` member is not. That asymmetry is the whole argument.

### 2.4 The two rules that do most of the work

1. **Fail closed toward `failed`.** Promotion to `outcome` requires an explicit declared detector.
   Nothing is inferred into an outcome - not by string similarity, not by an LLM, not by "the page
   looks empty." The cost of this rule is that a new legitimate business outcome shows up as a hard
   failure the first time and needs a human to add a detector and cut a new artifact version. That is
   the correct cost: it is a one-time review, and the alternative is a wrong answer at scale.
2. **Never classify a negative outcome against an unsettled surface.** `requiresSettled` is `true`
   and is not configurable on `OutcomeDef`. The failure mode this prevents is the exact inverse of the
   brief's warning: classifying "the results table has not rendered yet" as `MEMBER_NOT_FOUND`. Only
   environment-band detectors (rows 10, 13) may fire unsettled, because an error page is *why* the
   surface will never settle.

---

## 3. The classifier

### 3.1 Signature, and what makes it pure

```ts
/**
 * The entire runtime error taxonomy, as one total function.
 * No I/O, no clock, no randomness, no driver import, no mutation of inputs.
 */
export function classify(input: ClassifierInput): Verdict;

export interface ClassifierInput {
  /** The frozen, surface-independent snapshot. Plain JSON. */
  readonly observation: Observation;

  /**
   * Digests of the last N observations, newest last, supplied BY THE EXECUTOR.
   * WHY: quiescence is a property of a sequence, but polling is I/O. The
   * executor polls; the classifier is handed the sequence and decides.
   */
  readonly recentDigests: readonly string[];

  /** The step after overlay merge and parameter binding. Plain JSON. */
  readonly step: ResolvedStep;

  /**
   * Parameter values AND their provenance/taint. Provenance is what lets the
   * classifier tell taxonomy row 2 from row 3. Sensitive values are carried as
   * opaque handles, so a classifier trace can be logged without redaction work.
   */
  readonly bindings: ResolvedBindings;

  /** Plain integers. Not read from anywhere; incremented by the executor. */
  readonly counters: AttemptCounters;

  /**
   * Elapsed wall time as a NUMBER. This is the only way time enters the
   * classifier, and it is why `classify` has no `Date.now()` in it.
   */
  readonly elapsedMs: number;

  /** Set by the executor when act() returned a mechanical fault. */
  readonly actFault?: ActFault;
}
```

The six purity conditions, each mechanically checkable:

1. **Every input is serializable JSON.** `classify` is therefore `(json) => json`, which is the whole
   reason a frozen `Observation` on disk is a complete test case.
2. **No clock.** `elapsedMs` is an argument. Budgets compare integers.
3. **No I/O, no randomness, no driver import.** Enforced the same way `../durable-agent-outbox`
   enforces it on its reducer: a contract test reads the classifier's module set off disk and fails
   if `Date`, `Math.random`, `fetch(`, `node:`, `process.env`, `setTimeout`, `setInterval` or any
   `surface-*` import appears. It also fails on the CSS vocabulary (`querySelector`, `css`, `xpath`,
   `getElementById`, `[data-`), which is the `BRIEF §3.1` contract test.
4. **No mutation.** Inputs are deep-frozen in dev builds; a property test asserts
   `deepEqual(input, structuredClone(inputBefore))` after every call.
5. **Total.** Band B6 is a built-in default that returns a `Verdict` for every input. There is no
   `undefined` return and no throw path except `artifact-invalid`, which is a pre-flight condition
   the classifier never sees.
6. **Deterministic.** Band order is fixed in code, within-band order is declaration order, matcher
   normalization is a pure string pipeline. A property test asserts `classify(x)` twice is
   `deepEqual`.

The seam this buys: **the classifier decides, the executor acts.** `Verdict` is data. Everything that
touches a browser, a clock, or a file lives on the other side of it.

```ts
export type Verdict =
  | { kind: 'pending'; reason: 'not-settled'; settleElapsedMs: number }
  | { kind: 'advance'; outputs: ExtractedOutput[] }
  | { kind: 'outcome'; code: string; data: ExtractedOutput[] }
  | { kind: 'recover'; recoveryId: string; remedy: Remedy; attempt: number }
  | { kind: 'fail'; failure: FailureClass; detail: FailureDetail };
```

Note `advance` carries outputs. **Output extraction is a pure read from the same Observation the
checkpoint validated** - it is not a surface operation. That makes extraction, including its type
coercions and its `output-extraction-failed` path, testable from the same frozen snapshot with no
browser. It also removes a race that is otherwise very hard to see: extracting from a *later*
observation than the one you verified means you can verify the right page and read the next one.

### 3.2 Detector bands: the evaluation order

Evaluated top to bottom; **the first band that produces a verdict wins and no lower band runs.**

| Band | Contents | Source | Typical verdict |
|---|---|---|---|
| **G** | step precondition, lease held, policy allows the action, target resolves under quorum and passes its assertion | engine, pre-act | `fail` |
| **B0** | quiescence gate | engine | `pending`, or fall through with `settled=false` |
| **B1** | environment: session expiry, app error page, off-flow route | declared + engine | `recover` or `fail` |
| **B2** | interception: any modal/dialog/blocking overlay | declared + engine | `recover` or `fail(undeclared-dialog)` |
| **B3** | declared business outcomes | declared only | `outcome` |
| **B4** | declared recoverable conditions | declared only | `recover` |
| **B5** | checkpoint: predicate ∧ delta ∧ continuity | declared | `advance` |
| **B6** | default | engine | `fail(checkpoint-failed)` |

Four ordering choices that are load-bearing and that I would expect to be challenged:

**B0 before everything.** A negative classification against a half-rendered page is the failure mode
that makes a replay engine untrustworthy while looking like it works. Quiescence is not a `sleep`; see
§3.5.

**B1 before B3 (environment beats declared outcomes).** A logged-out page and an error page both
render text that trips content detectors - a session-expiry screen often has an empty content region
that looks exactly like "no results." Environment truth is a fact about whether the surface is
showing us the application at all; a declared outcome is a claim about what the application said.
The first has to win, or a session timeout becomes `MEMBER_NOT_FOUND`.

**B2 before B3 (interception beats declared outcomes).** When a modal is up, what is visible behind
it is stale by construction - it is the state *before* whatever prompted the modal. Reading an
outcome off it is reading history. Equally important, a blocking overlay makes every subsequent
locator resolution suspect, which is why B2 is also a *pre-act* guard (band G consults it) and not
only a post-act classification.

**B3 before B4 (outcomes beat recoveries).** The brief fixes both above the checkpoint but not
relative to each other. Outcomes win because an outcome is terminal and already true: burning a
recovery budget on a page that has given you the final answer wastes attempts and, worse, risks a
remedy navigating away from it. Concretely: a search result page showing both "No member found for
12345" and a "Your session will expire in 2 minutes - click to extend" nudge should return
`MEMBER_NOT_FOUND`, not dismiss the nudge and re-search. The nudge is a real recovery for a step that
has not finished; this step has.

### 3.3 Within a band: order is defined so the function is total, and lint makes sure order is never load-bearing

Within a band, declared detectors are evaluated in **declaration order, first match wins**. That
makes `classify` total and deterministic, and it makes detector reordering a visible semantic diff in
review.

But relying on order is a bug waiting to happen, so it is checked rather than trusted. **The save-time
overlap lint** replays every frozen Observation in the capability's snapshot corpus through each band
and fails the artifact if two detectors in one band match the same Observation. An artifact cannot
reach `verified(draft)` with an overlap. At runtime the same condition is still possible against a
screen the corpus never saw; when it happens, first-declared wins **and the run journal carries a
`detector-overlap` flag naming both detectors**, which is the signal that the corpus needs that
snapshot added. Order is therefore defined, never relied upon, and violations are observable.

The complementary lint is **coverage**: every fault the fixture can inject must be matched by exactly
one detector or must land on B6. A fault that lands on B6 is not a lint failure - hard failure is a
legitimate answer - but the lint reports it, so "we never declared a detector for permission denial"
is visible at review time rather than discovered in production.

### 3.4 Attempt budgets

Three nested budgets, all monotonically decrementing integers, all in the artifact, all passed to the
classifier as `counters`:

```ts
export interface StepBudgets {
  /** Per named recovery, per step. Stops a dismiss-loop on a dialog that keeps returning. */
  perRecoveryMaxAttempts: Record<string, number>;
  /**
   * Total remedies applied to THIS step across all recoveries.
   * WHY separate: two recoveries can ping-pong (dismiss dialog -> triggers reload ->
   * triggers dialog) with neither exceeding its own budget.
   */
  maxRemediationCycles: number;
  /** Quiescence budget for this step. */
  settle: SettlePolicy;
}

export interface RunBudgets {
  maxTotalRemediations: number;
  deadlineMs: number;
  /** Optional: fail the run if any single step consumed more than this share. */
  maxStepShareOfDeadline?: number;
}
```

The rule that matters: **no budget resets on progress within a step.** `maxRemediationCycles` resets
only when the step's checkpoint is reached and the run advances. A budget that resets whenever
"something changed" is how you build an infinite loop that reports progress the whole way. The run
budget never resets at all.

Exhaustion is a classification, not a timeout: `recovery-exhausted` carries which recovery, the
attempt count, and the Observation digest at each attempt, so the debug question "why did dismissing
this dialog not work" is answerable from the journal without a reproduction.

**Interaction with `effectClass`** - a schema invariant, checked at save time:

- `effectClass: 'WRITE_IRREVERSIBLE'` forces `retryPolicy: 'never'` on the step.
- Recoveries on such a step may only carry remedies of kind `wait` or `dismiss`, and only in the
  pre-dispatch window.
- Once dispatch has begun on an irreversible step, the only verdicts the classifier may return are
  terminal: an `outcome`, `advance`, or a `fail` with `retriable: 'no'`. `recover` is unreachable by
  construction, because a recovery implies a retry and a retry implies knowing the action did not
  take effect, which is precisely what is unknown.

### 3.5 Quiescence: what "settled" means

```ts
export interface SettlePolicy {
  /** Observation digest must be unchanged across this many consecutive polls. */
  stableSamples: number;      // default 2, to be tuned against the conformance corpus
  pollIntervalMs: number;     // default 150
  maxWaitMs: number;          // default 8000
  /** Declared busy indicators: while any matches, we are not settled regardless of digest. */
  busyWhen?: Predicate;
}
```

The digest is over the **structural skeleton** of the Observation - `role`, accessible name,
`containerPath`, and the enabled/checked/expanded state of every node - deliberately excluding
geometry and excluding the text of nodes marked live-updating, so a clock in the page header does not
make the surface permanently unsettled. `busyWhen` exists because a legacy app that swaps a frame's
contents can be digest-stable for one poll interval mid-swap.

On `maxWaitMs` exhaustion the classifier does not give up silently: it re-runs bands B1 and B2 with
`settled: false` (only detectors with `allowUnsettled: true` may fire, and `OutcomeDef` may never set
it), and if nothing matches it returns `fail(did-not-settle)` carrying the last three digests. A
"spinner forever" and a "500 page" are different answers and the run says which.

### 3.6 How the whole taxonomy is tested with no browser running

The loop closes on itself, which is the point:

1. The fixture (`fixtures/corebank-web`) injects a fault per session - validation error, not found,
   permission denied, interstitial, session timeout, slow load, app 500.
2. The executor journals **every** `perceive()` result, redacted per taint, to
   `evidence/observations/<runId>/<seq>.json`.
3. Those files are the conformance corpus. A classifier test is
   `expect(classify(load(snapshot), fixtures.step, fixtures.counters)).toEqual(expectedVerdict)` -
   no Playwright, no fixture server, milliseconds.
4. The conformance package runs each scenario against **deliberately weakened engines**: one with no
   quiescence gate (must fail the slow-load scenario by returning `MEMBER_NOT_FOUND`), one that
   evaluates the checkpoint before outcomes (must misreport not-found as `checkpoint-failed`), one
   that takes the first matching locator instead of requiring descriptor agreement (must fail the
   duplicate-name scenario), one with no `targetAssert`, one with no continuity assertion, one that
   promotes unmatched screens to a nearest-string-match outcome (must produce a false success).
5. A **meta-test fails if every mutant passes** - i.e. if the suite has stopped discriminating.

That last step is what turns "my replay handles errors" into a claim with a receipt. The specific
assertion the whole suite exists to make is **zero false successes**: no scenario may return `ok` or
an `outcome` when the fixture injected a fault that should have produced a `failed`.

---

## 4. The hard case: an action that silently succeeded against the wrong target

This is the failure with no error message, and it is the reason `targetAssert` and `continuity`
are in the schema. Decompose it, because "wrong target" is seven different bugs:

| | Sub-case | Caught by | Verdict |
|---|---|---|---|
| **W1** | Right control kind, wrong row - two members named *J. Alvarez*, we clicked the second | C1 `rowKeyEquals` bound to the caller's param; C2 continuity | `target-assert-failed` (pre-act) |
| **W2** | Right row, wrong column - "Close" sits where "Select" used to | C1 `targetAssert.role` + `name` | `target-assert-failed` (pre-act) |
| **W3** | Right label, wrong frame - a "Search" button exists in the nav frame and the content frame | C3 `scope` container + C4 descriptor agreement | `target-not-found` or `target-ambiguous` |
| **W4** | Stale geometry after a re-layout - coordinates now land on a neighbour | C4 descriptor agreement (geometric disagrees with role-name) | `target-ambiguous` |
| **W5** | Click landed on a transparent overlay | B2 interception guard, pre-act; C5 effect delta | `undeclared-dialog` / `no-observable-effect` |
| **W6** | Action dispatched, nothing happened (control disabled but not marked disabled) | C5 effect delta | `no-observable-effect` |
| **W7** | Everything on screen is correct and the backend acted on a different record | **nothing here** | - see below |

### 4.1 The five controls

**C1 - pre-act target assertion. The strongest one.** Before dispatch, assert invariants about the
*resolved node itself*: its role, its accessible name against a `TextMatcher`, its enabled state, and
for row-scoped targets `rowKeyEquals: { columnHeader: "Member ID", value: { from: 'param',
param: 'memberId' } }`. The principle: **the identity of the thing we act on is re-derived from data
we already know, not from where it sits.** You cannot click the wrong member's row when the row is
selected by the member id the caller asked about. This converts W1 and W2 from silent to loud, and it
costs one predicate evaluation.

**C2 - continuity assertions.** A named value flows through the run and must be re-observed at
declared waypoints. `subjectMember` is bound from the `memberId` parameter and must appear inside the
member-detail region at the detail step and again at the balance step. The checkpoint therefore is
not "a member detail page loaded" but "*the* member detail page for the member we were asked about."
This catches the landing-on-the-wrong-record class even when the click itself was unambiguous - for
example when the app's own search silently corrected the id.

**C3 - scoped resolution.** Every `TargetRef` carries a `scope: ContainerMatcher`. Resolution never
searches the whole Observation. On a frameset app this is the difference between finding the right
"Search" button and finding a "Search" button.

**C4 - descriptor agreement, per `BRIEF §3.2`.** At least two independently computed descriptors must
resolve, and they must resolve to the **same node id**. Disagreement is `target-ambiguous`, a hard
failure. This is not a fallback chain and the difference is the whole point: a fallback chain
*silences* the disagreement, which is exactly the signal. `AgreementPolicy.requireIdentical` is typed
as the literal `true` so nobody can configure it away.

**C5 - effect delta.** At record time we capture a structural summary of the change the action caused
(did navigation occur, which containers changed, where focus went). At replay, the checkpoint asserts
the delta matches. The default is deliberately the weakest useful form - `{ mustChange: true }`,
*something observable must have changed* - because a strict delta assertion overfits to the recording
and turns benign rendering differences into failures. Weak as it is, it catches W6, which is
otherwise indistinguishable from success on a page that looks similar before and after.

### 4.2 What survives, and why it is the safety model's problem

**W7 is not detectable from the UI**, by construction: if the surface carries no evidence that the
wrong record was touched, no pure function over the surface can find out. This is the honest limit of
this whole approach and I would rather say it plainly than imply the taxonomy is complete. Three
things follow, and they are the actual mitigation:

1. `WRITE_IRREVERSIBLE` requires an approved artifact plus a per-invocation approval token. The
   residual undetectable-wrong-target risk is precisely why that gate exists, and this is the
   argument for it - not a generic "writes are scary."
2. Continuity assertions should be declared on the **confirmation** screen of a write flow, because a
   confirmation screen is usually where the app finally prints the identity of what it did. If the
   confirmation names the record, W7 collapses into W1 and becomes detectable.
3. Reconciliation against the system of record is out of scope here and belongs in the calling
   product. Saying so is more useful than pretending replay can close it.

---

## 5. The artifact schema

Written as plain TypeScript for readability. The runtime definition is `zod` with identical names, and
the exported `.d.ts` is `z.infer`'d from it, so there is one source of truth and no drift between the
validator and the types. Every field carries the reason it exists; a field with no reason is a field
that should be cut.

### 5.0 Primitives

```ts
/** `sha256:<64 hex>` over canonical JSON. WHY: approval must sign over content, not a name. */
export type Digest = `sha256:${string}`;
export type StepId = string;          // stable within a capability, never reused across versions
export type Timestamp = string;       // ISO-8601 UTC, set only by the runtime, never by the model

/**
 * Closed role vocabulary, normalized ACROSS surfaces.
 * WHY closed: an open string set lets the terminal driver and the browser driver disagree
 * silently, so a descriptor recorded on one would never resolve on the other. A closed union
 * makes that a compile error in the driver instead of a mystery at replay.
 */
export type Role =
  | 'button' | 'link' | 'textbox' | 'combobox' | 'listbox' | 'option' | 'checkbox' | 'radio'
  | 'table' | 'row' | 'cell' | 'columnheader' | 'rowheader' | 'heading' | 'dialog' | 'alert'
  | 'status' | 'form' | 'region' | 'navigation' | 'main' | 'group' | 'text' | 'image' | 'unknown';

/**
 * Text comparison. NO REGEX ANYWHERE - see §9. `template` holes are parameter names, which
 * is also what keeps PII out of detector literals: you write "No member found for {memberId}",
 * never the id itself.
 */
export interface TextMatcher {
  mode: 'exact' | 'template' | 'oneOf';
  value: string | string[];           // `oneOf` is how a tenant overlay widens a label
  normalize: NormalizeOpts;
}
export interface NormalizeOpts {
  trim: boolean;
  collapseWhitespace: boolean;        // legacy table markup is full of stray whitespace
  caseFold: boolean;
  stripPunctuation: boolean;
  /** Tenant branding tokens removed before comparison; supplied by the overlay, not the base. */
  stripTokens?: string[];
}

/**
 * Where a value comes from. Provenance is not decoration: it is what lets the classifier
 * tell taxonomy row 2 (param-bound -> business outcome) from row 3 (literal-bound -> failure).
 */
export type ValueRef =
  | { from: 'param'; param: string }
  | { from: 'literal'; value: string }                    // linted against the PII rules
  | { from: 'output'; step: StepId; output: string }      // a value read earlier in this run
  | { from: 'credential'; key: string };                  // resolved by the broker at act time,
                                                          // never stored, always tainted

/** Small closed type system. WHY closed: it must project losslessly to a JSON Schema for the
 *  agent-facing tool surface, and it must be comparable for continuity assertions. */
export type ValueType =
  | { kind: 'string'; charset?: 'digits' | 'alnum' | 'any'; minLength?: number; maxLength?: number }
  | { kind: 'integer'; min?: number; max?: number }
  | { kind: 'decimal'; scale: number }
  | { kind: 'money'; currency: 'USD' }                    // never a float; string minor units
  | { kind: 'date'; format: 'YYYY-MM-DD' }
  | { kind: 'boolean' }
  | { kind: 'enum'; values: string[] };

/**
 * Canonicalized route. NEVER a literal URL.
 * WHY: (a) `/member/12345` in an artifact is persisted PII; (b) the origin differs per tenant,
 * so a literal URL makes the artifact single-tenant by accident.
 */
export interface RoutePattern {
  originAlias: string;                                    // 'corebank' -> resolved per tenant
  path: string;                                           // '/members/:memberId/accounts'
  query?: Record<string, ValueRef | ':any'>;
  frame?: string;                                         // frameset target, when the route lands
                                                          // inside a frame rather than at top level
}
```

### 5.1 Containers - how a region of the surface is named

```ts
/**
 * A breadcrumb, not a selector. Every segment must match. This is the unit of SCOPE for
 * locator resolution and for detector evaluation, and it is the reason "the Search button in
 * the nav frame" and "the Search button in the content frame" are different things.
 */
export interface ContainerMatcher { path: ContainerSegment[] }

export type ContainerSegment =
  | { kind: 'frame'; name: TextMatcher }
  | { kind: 'landmark'; role: 'main' | 'navigation' | 'form' | 'region' | 'dialog'; name?: TextMatcher }
  | { kind: 'heading-section'; heading: TextMatcher; level?: 1 | 2 | 3 | 4 | 5 | 6 }
  /**
   * Identifying a table by its COLUMN HEADER SET.
   * WHY: in table-soup layouts there is no caption, no id and no class worth trusting, but the
   * set of column headings is exactly what a human uses to know which table they are looking at,
   * and it is the thing that would have to change for the human workflow to change.
   */
  | { kind: 'table'; caption?: TextMatcher; headers: TextMatcher[] };
```

### 5.2 Target and descriptors - §9 argues for these

```ts
export interface TargetRef {
  /** Resolution NEVER searches the whole Observation. */
  scope: ContainerMatcher;
  /** >= 2, and at least one must be non-positional. Enforced by a schema invariant. */
  descriptors: Descriptor[];
  agreement: AgreementPolicy;
  /** Control C1 in §4.1: the pre-act identity check. */
  assert: TargetAssertion;
}

export type Descriptor =
  /** Rank 1. Accessible name is the identity a HUMAN uses; it survives markup churn. */
  | { kind: 'role-name'; role: Role; name: TextMatcher }
  /** Rank 2. "the field whose label is X", incl. spatial label association for legacy tables. */
  | { kind: 'label-anchored'; label: TextMatcher; relation: 'labelled-by' | 'right-of' | 'below'; role?: Role }
  /** Rank 3. "the Select link on the row whose Member ID cell is :memberId" - how a human does it. */
  | { kind: 'table-cell'; table: ContainerMatcher; columnHeader: TextMatcher; rowKey: RowKey; cellRole?: Role }
  /** Rank 4. Positional. NEVER permitted as the only descriptor - see §9 and invariant 2. */
  | { kind: 'ordinal-in-container'; container: ContainerMatcher; role: Role; index: number }
  /** Rank 5. Last resort, always anchored to visible text, always scoped, never absolute. */
  | { kind: 'geometric'; container: ContainerMatcher; anchor: TextMatcher; direction: 'right' | 'below' | 'left' | 'above'; maxDistance: number };

/** Rank is a property of the KIND and lives in `core`, not in the artifact.
 *  WHY: otherwise a tenant overlay could promote `ordinal` and quietly re-introduce the
 *  positional targeting this design exists to avoid. */

export interface RowKey { columnHeader: TextMatcher; value: ValueRef }

export interface AgreementPolicy {
  minResolved: number;                 // default 2
  /** Literal `true`: not configurable. Disagreement is a signal, never a fallback. */
  requireIdentical: true;
  /** Literal `'fail'`: not configurable. */
  onUnderQuorum: 'fail';
}

export interface TargetAssertion {
  role: Role;
  name?: TextMatcher;
  enabled?: boolean;
  visible?: boolean;
  /** The wrong-row killer. Binds the row's identity to the caller's own argument. */
  rowKeyEquals?: RowKey;
}
```

### 5.3 The predicate DSL - the only thing a detector can say

```ts
/**
 * Non-Turing-complete by construction: no loops, no arithmetic beyond a count comparison,
 * no user-defined functions, depth-bounded (max 4, checked at save time).
 * WHY: it must be diffable in a pull request, reviewable by a person who is not an engineer,
 * and cost-bounded so a malformed artifact cannot hang a replay.
 */
export type Predicate =
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate }
  | { kind: 'node-exists'; where: NodeQuery }
  | { kind: 'node-absent'; where: NodeQuery }
  | { kind: 'text-present'; scope?: ContainerMatcher; text: TextMatcher }
  | { kind: 'node-state'; where: NodeQuery; state: keyof NodeState; equals: boolean }
  | { kind: 'value-matches'; where: NodeQuery; matcher: TextMatcher }
  | { kind: 'count'; where: NodeQuery; op: 'eq' | 'gte' | 'lte'; n: number }
  | { kind: 'route-matches'; pattern: RoutePattern }
  /** Control C2 in §4.1. */
  | { kind: 'continuity'; ref: string; scope?: ContainerMatcher };

export interface NodeQuery { scope?: ContainerMatcher; role?: Role; name?: TextMatcher; state?: Partial<NodeState> }
```

### 5.4 Contract - the agent-facing half

```ts
export interface CapabilityContract {
  params: ParamDef[];
  outputs: OutputDef[];
  outcomes: OutcomeDef[];
  /** The JSON-Schema projection an AI agent sees is DERIVED from the above, never authored.
   *  WHY: two hand-maintained descriptions of the same contract diverge; this one cannot. */
}

export interface ParamDef {
  name: string;
  type: ValueType;
  required: boolean;
  /** Drives the taint model: `sensitive` values never reach logs, artifacts, or screenshots,
   *  and their screenshot regions are masked. */
  sensitivity: 'public' | 'internal' | 'sensitive';
  /** Evaluated BEFORE perceive(). Taxonomy row 1: the cheapest classification touches no surface. */
  constraints?: { charset?: 'digits' | 'alnum' | 'any'; minLength?: number; maxLength?: number; enum?: string[] };
  description: string;                 // read by the calling agent; must not contain examples
                                       // with real-looking PII (linted)
  /** WHY: evidence that this parameter was DISCOVERED from the goal rather than invented,
   *  which is what makes `parameterization-as-PII-control` auditable rather than asserted. */
  discoveredFrom: { goalSpan: string } | { operator: true };
}

export interface OutputDef {
  name: string;
  type: ValueType;
  required: boolean;
  /** The step whose checkpoint-verified Observation this is read from.
   *  WHY: extraction is a pure read from a VERIFIED observation, not a later one (§3.1). */
  atStep: StepId;
  from:
    | { kind: 'node-value'; target: TargetRef }
    | { kind: 'node-name'; target: TargetRef }
    | { kind: 'table-cell'; table: ContainerMatcher; rowKey: RowKey; columnHeader: TextMatcher };
  /** Closed enum. No expressions. */
  transform: Array<'trim' | 'collapseWhitespace' | 'stripCurrencySymbol' | 'stripThousandsSep' | 'parseDecimal' | 'parseDate' | 'upperCase'>;
  /** Default `'fail'`. Returning `{ balance: undefined }` to an agent is how a member is told
   *  their balance is nothing; a missing required output is a hard failure, not a partial success. */
  onMissing: 'fail' | 'null';
  sensitivity: 'public' | 'internal' | 'sensitive';
}

export interface OutcomeDef {
  code: string;                        // SCREAMING_SNAKE; part of the public contract, stable
  summary: string;                     // for the calling agent AND the human reviewer
  detect: Predicate;
  data?: OutputDef[];                  // typed payload the caller receives with the outcome
  /** Literal `true`: outcomes are always terminal. A non-terminal outcome is a recovery. */
  terminal: true;
  /** What the CALLER should do. This is the field that makes the three-way split actionable
   *  rather than merely descriptive. */
  callerAction: 'inform-user' | 'retry-different-input' | 'escalate-human';
  /** Literal `true`: not configurable. Rule 2 of §2.4 - no negative outcome on an unsettled surface. */
  requiresSettled: true;
}
```

### 5.5 Flow and step

```ts
export interface Flow {
  entry: { route: RoutePattern; precondition: Predicate };
  /**
   * Steps that are safe idempotent re-entry points. A `restart-from-checkpoint` recovery may
   * only target one of these, and only if no WRITE_IRREVERSIBLE step lies between it and the
   * current step. Checked at save time, which is how session-expiry recovery is prevented
   * from replaying a write.
   */
  resumePoints: StepId[];
  steps: Step[];                       // a straight line. No branching - see §11.
}

export type EffectClass = 'READ' | 'WRITE_REVERSIBLE' | 'WRITE_IRREVERSIBLE';

export interface Step {
  id: StepId;
  /** HUMAN-ONLY prose. The engine must not read it; a contract test asserts `label` is never
   *  referenced outside serialization and rendering. WHY: if the engine reads prose, the model
   *  is back in the decision loop through the side door. */
  label: string;
  effectClass: EffectClass;
  precondition?: Predicate;
  action: ActionSpec;
  settle: SettlePolicy;
  expect: Checkpoint;
  /** References into `contract.outcomes`, ordered; band B3 for this step.
   *  WHY references and not inline definitions: an outcome is part of the capability's public
   *  contract, so it must be declared once at the top and merely *reachable* from steps. */
  outcomes: string[];
  recoveries: Recovery[];
  budgets: StepBudgets;
  evidence: { captureOn: Array<'never' | 'failure' | 'outcome' | 'always'>; maskRegionsFor: string[] };
}

export interface Checkpoint {
  predicate: Predicate;
  delta: DeltaAssertion;               // control C5
  continuity: string[];                // control C2: ids that must hold here
  /** What a human reads when it fails. Goes verbatim into `FailureDetail.expected`. */
  describes: string;
}

export interface DeltaAssertion {
  /** Default true, and deliberately the weakest useful assertion - see §4.1 C5. */
  mustChange: boolean;
  navigatedTo?: RoutePattern;
  changedContainers?: ContainerMatcher[];
  focusMovedInto?: ContainerMatcher;
}

export interface Recovery {
  id: string;
  band: 'environment' | 'interception' | 'recoverable';   // which of B1 / B2 / B4 it sits in
  when: Predicate;
  remedy: Remedy;
  maxAttempts: number;
  /** Only `band: 'environment'` may set this true; enforced at save time. */
  allowUnsettled: boolean;
  resume: 'retry-step' | 'restart-from-checkpoint' | 'restart-flow';
  /** Which resume point, when `restart-from-checkpoint`. Must be in `flow.resumePoints`. */
  resumeAt?: StepId;
}

export type Remedy =
  | { kind: 'wait'; additionalMs: number }
  | { kind: 'dismiss'; target: TargetRef }                 // still policy-checked, still asserted
  | { kind: 'act'; action: ActionSpec }
  | { kind: 'reauthenticate'; using: Array<{ from: 'credential'; key: string }> };
```

### 5.6 Envelope, provenance, verification, overlays

```ts
export interface CapabilityArtifact {
  schemaVersion: 1;
  /** Stable across versions. This is the name an AI agent invokes. */
  capabilityId: string;                                    // 'corebank.member.read-savings-balance'
  version: number;                                         // monotonic per capabilityId
  /** Over canonical JSON with `digest` and `signatures` removed.
   *  WHY: approval signs the digest, so an approved artifact cannot be silently edited. */
  digest: Digest;
  vendor: VendorTarget;
  lifecycle: Lifecycle;
  contract: CapabilityContract;
  continuity: ContinuityDef[];
  flow: Flow;
  provenance: Provenance;
  verification: Verification;
  policy: PolicyRequirements;
  signatures: Signature[];
}

export interface VendorTarget {
  /** The vendor PRODUCT, not the tenant. This is the unit of reuse across hundreds of tenants. */
  product: string;
  productVersionRange: string;                             // semver range, advisory not enforced
  surfaceKind: 'web-modern' | 'web-legacy' | 'terminal' | 'desktop';
}

export interface Lifecycle {
  state: 'proposed' | 'draft' | 'approved' | 'deprecated';
  supersedes?: number;
  approvedBy?: string;
  approvedAt?: Timestamp;
}

export interface ContinuityDef {
  id: string;                                              // 'subjectMember'
  source: ValueRef;                                        // usually { from:'param' }
  /** Comparison is normalized, not identity: "12345" on the search box and "Member #12345"
   *  in the detail heading are the same subject. */
  compare: { via: TextMatcher; type: ValueType };
}

export interface Provenance {
  discoveryRunId: string;
  /** The goal, PII-linted and redacted. WHY it is here at all: a reviewer needs to know what
   *  this was recorded to do; WHY it is redacted: the goal is where the PII entered. */
  goal: string;
  model: { provider: string; modelId: string };
  /** A POINTER to the transcript, never the transcript. The brief requires the artifact to be
   *  decoupled from the raw model transcript, and an embedded transcript is also an unbounded
   *  PII surface. */
  transcriptRef: string;
  recordedAt: Timestamp;
  recordedAgainst: { tenantId: string; originAlias: string; fingerprint: SurfaceFingerprint };
}

/** See §12: this is the shape after my one disagreement with the brief. */
export interface Verification {
  mode: 'replay-live' | 'replay-dry' | 'replay-reset';
  status: 'verified' | 'unverified';
  /** For `replay-dry`, the last step actually executed before the irreversible boundary. */
  coveredThroughStep: StepId;
  runId: string;
  at: Timestamp;
  /** The grade a reviewer should read. `partial-*` is not a lesser bug; it is a different claim. */
  grade: 'full' | 'partial-up-to-irreversible';
}

export interface PolicyRequirements {
  originAliases: string[];
  maxEffectClass: EffectClass;
  /** Derived, not authored: true iff any step is WRITE_IRREVERSIBLE. */
  requiresApprovalToken: boolean;
  redaction: { maskScreenshotRegions: boolean; taintedParams: string[] };
}

/**
 * Structural skeleton hash per step: the multiset of (role, containerPath, accessible-name-shape).
 * WHY: cross-tenant drift detection that is cheap, deterministic, and REPORTED rather than
 * acted on. A divergence above threshold sets `needsSpecialization` on the result; it never
 * triggers self-repair.
 */
export interface SurfaceFingerprint { perStep: Record<StepId, string> }

export interface Signature { over: Digest; by: string; alg: 'ed25519'; sig: string; at: Timestamp }
```

```ts
export interface TenantOverlay {
  schemaVersion: 1;
  capabilityId: string;
  appliesToVersion: { min: number; max?: number };
  tenantId: string;
  originAliases: Record<string, string>;                   // 'corebank' -> the tenant's host
  /**
   * OVERRIDES ONLY, and only of the widening kind.
   * An overlay may: add `oneOf` alternatives to a TextMatcher, raise a budget, add a recovery,
   * add branding tokens to strip.
   * An overlay may NOT: change an action, an effectClass, a checkpoint, an outcome set, the
   * step order, or the contract.
   * WHY: those are the capability's MEANING. A per-tenant file that can change what a
   * capability does is a supply-chain hole with a config file's review standard.
   */
  steps: Record<StepId, StepOverride>;
  extraRecoveries: Record<StepId, Recovery[]>;
  normalize?: { stripTokens: string[] };
  digest: Digest;
}

export interface StepOverride {
  /** Keyed by a path into the step's matchers; values are merged into `oneOf`, never replaced. */
  nameAlternatives?: Record<string, string[]>;
  budgets?: Partial<StepBudgets>;
}

/** The merge is deterministic and total, and the merged result gets its own digest, which the
 *  run journal records alongside the base digest. WHY: "which bytes actually ran" must be
 *  answerable after the fact for a regulated environment, and base+overlay means the base
 *  digest alone does not answer it. */
export declare function resolve(base: CapabilityArtifact, overlay?: TenantOverlay):
  { resolved: CapabilityArtifact; resolvedDigest: Digest };
```

### 5.7 Schema invariants (checked at save time, before `draft`)

These are the parts of the design that are not expressible in the type system. Each is a lint that
blocks the `proposed → draft` transition.

1. Every `TargetRef` has `descriptors.length >= 2` and at least one of rank ≤ 3.
2. No `TargetRef` has `ordinal-in-container` as its only or highest-ranked descriptor.
3. No step with `effectClass: 'WRITE_IRREVERSIBLE'` carries a recovery whose remedy is `act` or
   whose `resume` is anything other than terminal.
4. Every `restart-from-checkpoint` recovery names a `resumeAt` in `flow.resumePoints` with no
   `WRITE_IRREVERSIBLE` step between it and the recovery's step.
5. `allowUnsettled: true` only on `band: 'environment'`.
6. Detector non-overlap within each band, over the capability's frozen snapshot corpus (§3.3).
7. Predicate depth ≤ 4; no predicate references a `param` that does not exist.
8. **PII lint:** no `literal` ValueRef and no `TextMatcher.value` may (a) equal any value observed
   bound to a `sensitive` parameter during discovery, or (b) match the shapes for SSN, full account
   number, card PAN, email, or phone. Detector text must use `template` holes instead.
9. `policy.requiresApprovalToken` is derived and must match the steps.
10. Every declared `OutputDef.atStep` names a step that exists and precedes or equals the last step.

---

## 6. A filled-in artifact: credit-union member lookup

Goal recorded from: *"look up member 12345 and read their current savings balance."* Recorded against
the `riverbend` tenant of the fixture vendor product. **All values are synthetic.** Note what is
absent: no member id anywhere, no URL, no CSS, no transcript, no timings copied from the recording.

```json
{
  "schemaVersion": 1,
  "capabilityId": "corebank.member.read-savings-balance",
  "version": 3,
  "digest": "sha256:4b1d0c7a9e2f5518a3c6d40b7e91f2ac8d5b6e0f3a7c1d94e28b5f6072c1a3d8e",
  "vendor": {
    "product": "CoreBank Back Office",
    "productVersionRange": ">=8.2.0 <9.0.0",
    "surfaceKind": "web-legacy"
  },
  "lifecycle": {
    "state": "approved",
    "supersedes": 2,
    "approvedBy": "ops-lead@example-cu.invalid",
    "approvedAt": "2026-08-19T14:02:11Z"
  },

  "contract": {
    "params": [
      {
        "name": "memberId",
        "type": { "kind": "string", "charset": "digits", "minLength": 5, "maxLength": 5 },
        "required": true,
        "sensitivity": "sensitive",
        "constraints": { "charset": "digits", "minLength": 5, "maxLength": 5 },
        "description": "The institution's internal member number. Five digits.",
        "discoveredFrom": { "goalSpan": "member <VALUE>" }
      }
    ],
    "outputs": [
      {
        "name": "savingsBalance",
        "type": { "kind": "money", "currency": "USD" },
        "required": true,
        "atStep": "open-accounts",
        "from": {
          "kind": "table-cell",
          "table": { "path": [
            { "kind": "frame", "name": { "mode": "exact", "value": "content", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } } },
            { "kind": "table", "headers": [
              { "mode": "exact", "value": "Account Type", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } },
              { "mode": "exact", "value": "Current Balance", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } }
            ] }
          ] },
          "rowKey": {
            "columnHeader": { "mode": "exact", "value": "Account Type", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } },
            "value": { "from": "literal", "value": "Savings" }
          },
          "columnHeader": { "mode": "exact", "value": "Current Balance", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } }
        },
        "transform": ["trim", "stripCurrencySymbol", "stripThousandsSep", "parseDecimal"],
        "onMissing": "fail",
        "sensitivity": "internal"
      },
      {
        "name": "accountStatus",
        "type": { "kind": "enum", "values": ["OPEN", "DORMANT", "FROZEN", "CLOSED"] },
        "required": true,
        "atStep": "open-accounts",
        "from": {
          "kind": "table-cell",
          "table": { "path": [
            { "kind": "frame", "name": { "mode": "exact", "value": "content", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } } },
            { "kind": "table", "headers": [
              { "mode": "exact", "value": "Account Type", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } },
              { "mode": "exact", "value": "Status", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } }
            ] }
          ] },
          "rowKey": {
            "columnHeader": { "mode": "exact", "value": "Account Type", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } },
            "value": { "from": "literal", "value": "Savings" }
          },
          "columnHeader": { "mode": "exact", "value": "Status", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } }
        },
        "transform": ["trim", "upperCase"],
        "onMissing": "fail",
        "sensitivity": "internal"
      }
    ],
    "outcomes": [
      {
        "code": "MEMBER_NOT_FOUND",
        "summary": "No member exists with the supplied member number.",
        "detect": {
          "all": [
            { "kind": "text-present",
              "scope": { "path": [ { "kind": "frame", "name": { "mode": "exact", "value": "content", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } } } ] },
              "text": { "mode": "oneOf", "value": ["No member found for {memberId}", "0 records returned"], "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": true } } },
            { "kind": "node-absent", "where": { "role": "table", "name": { "mode": "exact", "value": "Search Results", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } } } }
          ]
        },
        "terminal": true,
        "callerAction": "inform-user",
        "requiresSettled": true
      },
      {
        "code": "INVALID_MEMBER_ID",
        "summary": "The application rejected the supplied member number as malformed.",
        "detect": {
          "kind": "text-present",
          "scope": { "path": [ { "kind": "landmark", "role": "form", "name": { "mode": "exact", "value": "Member Search", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } } } ] },
          "text": { "mode": "oneOf", "value": ["Member ID must be 5 digits", "Invalid member number format"], "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": true } }
        },
        "terminal": true,
        "callerAction": "retry-different-input",
        "requiresSettled": true
      },
      {
        "code": "MEMBER_RESTRICTED",
        "summary": "The member record exists but is flagged restricted; a supervisor must service it.",
        "detect": {
          "kind": "text-present",
          "scope": { "path": [ { "kind": "frame", "name": { "mode": "exact", "value": "content", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } } } ] },
          "text": { "mode": "oneOf", "value": ["This member record is restricted", "Restricted account - supervisor override required"], "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": true } }
        },
        "terminal": true,
        "callerAction": "escalate-human",
        "requiresSettled": true
      }
    ]
  },

  "continuity": [
    {
      "id": "subjectMember",
      "source": { "from": "param", "param": "memberId" },
      "compare": { "via": { "mode": "template", "value": "{memberId}", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": true } }, "type": { "kind": "string", "charset": "digits" } }
    }
  ],

  "flow": {
    "entry": {
      "route": { "originAlias": "corebank", "path": "/backoffice/members/search", "frame": "content" },
      "precondition": { "kind": "node-exists", "where": { "role": "form", "name": { "mode": "exact", "value": "Member Search", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } } } }
    },
    "resumePoints": ["enter-member-id"],
    "steps": [
      {
        "id": "enter-member-id",
        "label": "Type the member number into the Member ID field.",
        "effectClass": "READ",
        "action": {
          "kind": "type",
          "mode": "replace",
          "text": { "from": "param", "param": "memberId" },
          "target": {
            "scope": { "path": [
              { "kind": "frame", "name": { "mode": "exact", "value": "content", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } } },
              { "kind": "landmark", "role": "form", "name": { "mode": "exact", "value": "Member Search", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } } }
            ] },
            "descriptors": [
              { "kind": "label-anchored", "label": { "mode": "oneOf", "value": ["Member ID", "Member Number", "Mbr #"], "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": true } }, "relation": "right-of", "role": "textbox" },
              { "kind": "role-name", "role": "textbox", "name": { "mode": "oneOf", "value": ["Member ID", "Member Number"], "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": true } } }
            ],
            "agreement": { "minResolved": 2, "requireIdentical": true, "onUnderQuorum": "fail" },
            "assert": { "role": "textbox", "enabled": true, "visible": true }
          }
        },
        "settle": { "stableSamples": 2, "pollIntervalMs": 150, "maxWaitMs": 3000 },
        "expect": {
          "predicate": { "kind": "value-matches", "where": { "role": "textbox", "name": { "mode": "oneOf", "value": ["Member ID", "Member Number"], "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": true } } }, "matcher": { "mode": "template", "value": "{memberId}", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": false, "stripPunctuation": false } } },
          "delta": { "mustChange": true },
          "continuity": [],
          "describes": "The Member ID field contains the supplied member number."
        },
        "outcomes": [],
        "recoveries": [],
        "budgets": { "perRecoveryMaxAttempts": {}, "maxRemediationCycles": 0, "settle": { "stableSamples": 2, "pollIntervalMs": 150, "maxWaitMs": 3000 } },
        "evidence": { "captureOn": ["failure"], "maskRegionsFor": ["memberId"] }
      },

      {
        "id": "submit-search",
        "label": "Click Search and wait for the results table.",
        "effectClass": "READ",
        "action": {
          "kind": "click",
          "target": {
            "scope": { "path": [
              { "kind": "frame", "name": { "mode": "exact", "value": "content", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } } },
              { "kind": "landmark", "role": "form", "name": { "mode": "exact", "value": "Member Search", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } } }
            ] },
            "descriptors": [
              { "kind": "role-name", "role": "button", "name": { "mode": "oneOf", "value": ["Search", "Find Member"], "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": true } } },
              { "kind": "label-anchored", "label": { "mode": "oneOf", "value": ["Member ID", "Member Number"], "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": true } }, "relation": "right-of", "role": "button" }
            ],
            "agreement": { "minResolved": 2, "requireIdentical": true, "onUnderQuorum": "fail" },
            "assert": { "role": "button", "name": { "mode": "oneOf", "value": ["Search", "Find Member"], "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": true } }, "enabled": true, "visible": true }
          }
        },
        "settle": { "stableSamples": 3, "pollIntervalMs": 200, "maxWaitMs": 12000,
          "busyWhen": { "kind": "text-present", "text": { "mode": "oneOf", "value": ["Loading...", "Please wait"], "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": true } } } },
        "expect": {
          "predicate": { "all": [
            { "kind": "node-exists", "where": { "scope": { "path": [ { "kind": "table", "headers": [ { "mode": "exact", "value": "Member ID", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } } ] } ] }, "role": "cell", "name": { "mode": "template", "value": "{memberId}", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": true } } } },
            { "kind": "count", "where": { "scope": { "path": [ { "kind": "table", "headers": [ { "mode": "exact", "value": "Member ID", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } } ] } ] }, "role": "link", "name": { "mode": "oneOf", "value": ["Select", "Open", "View"], "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": true } } }, "op": "eq", "n": 1 }
          ] },
          "delta": { "mustChange": true, "changedContainers": [ { "path": [ { "kind": "frame", "name": { "mode": "exact", "value": "content", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } } } ] } ] },
          "continuity": ["subjectMember"],
          "describes": "Exactly one result row, and it is the member we searched for."
        },
        "outcomes": ["MEMBER_NOT_FOUND", "INVALID_MEMBER_ID", "MEMBER_RESTRICTED"],
        "recoveries": [
          {
            "id": "dismiss-maintenance-notice",
            "band": "interception",
            "when": { "kind": "node-exists", "where": { "role": "dialog", "name": { "mode": "oneOf", "value": ["Scheduled Maintenance", "System Notice"], "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": true } } } },
            "remedy": { "kind": "dismiss", "target": {
              "scope": { "path": [ { "kind": "landmark", "role": "dialog" } ] },
              "descriptors": [
                { "kind": "role-name", "role": "button", "name": { "mode": "oneOf", "value": ["OK", "Close", "Acknowledge"], "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": true } } },
                { "kind": "ordinal-in-container", "container": { "path": [ { "kind": "landmark", "role": "dialog" } ] }, "role": "button", "index": 0 }
              ],
              "agreement": { "minResolved": 2, "requireIdentical": true, "onUnderQuorum": "fail" },
              "assert": { "role": "button", "enabled": true, "visible": true }
            } },
            "maxAttempts": 2,
            "allowUnsettled": false,
            "resume": "retry-step"
          },
          {
            "id": "reauthenticate",
            "band": "environment",
            "when": { "any": [
              { "kind": "route-matches", "pattern": { "originAlias": "corebank", "path": "/backoffice/login" } },
              { "kind": "text-present", "text": { "mode": "oneOf", "value": ["Your session has expired", "Please sign in to continue"], "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": true } } }
            ] },
            "remedy": { "kind": "reauthenticate", "using": [ { "from": "credential", "key": "corebank.serviceAccount" } ] },
            "maxAttempts": 1,
            "allowUnsettled": true,
            "resume": "restart-from-checkpoint",
            "resumeAt": "enter-member-id"
          },
          {
            "id": "wait-out-slow-load",
            "band": "recoverable",
            "when": { "kind": "text-present", "text": { "mode": "oneOf", "value": ["Loading...", "Please wait"], "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": true } } },
            "remedy": { "kind": "wait", "additionalMs": 5000 },
            "maxAttempts": 2,
            "allowUnsettled": false,
            "resume": "retry-step"
          }
        ],
        "budgets": {
          "perRecoveryMaxAttempts": { "dismiss-maintenance-notice": 2, "reauthenticate": 1, "wait-out-slow-load": 2 },
          "maxRemediationCycles": 3,
          "settle": { "stableSamples": 3, "pollIntervalMs": 200, "maxWaitMs": 12000 }
        },
        "evidence": { "captureOn": ["failure", "outcome"], "maskRegionsFor": ["memberId"] }
      },

      {
        "id": "open-member",
        "label": "Open the member record from the result row keyed by the member number.",
        "effectClass": "READ",
        "action": {
          "kind": "click",
          "target": {
            "scope": { "path": [
              { "kind": "frame", "name": { "mode": "exact", "value": "content", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } } },
              { "kind": "table", "headers": [
                { "mode": "exact", "value": "Member ID", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } },
                { "mode": "exact", "value": "Name", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } }
              ] }
            ] },
            "descriptors": [
              { "kind": "table-cell",
                "table": { "path": [ { "kind": "table", "headers": [ { "mode": "exact", "value": "Member ID", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } } ] } ] },
                "columnHeader": { "mode": "oneOf", "value": ["Action", ""], "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": true } },
                "rowKey": { "columnHeader": { "mode": "exact", "value": "Member ID", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } }, "value": { "from": "param", "param": "memberId" } },
                "cellRole": "link" },
              { "kind": "role-name", "role": "link", "name": { "mode": "oneOf", "value": ["Select", "Open", "View"], "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": true } } }
            ],
            "agreement": { "minResolved": 2, "requireIdentical": true, "onUnderQuorum": "fail" },
            "assert": {
              "role": "link",
              "name": { "mode": "oneOf", "value": ["Select", "Open", "View"], "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": true } },
              "enabled": true,
              "visible": true,
              "rowKeyEquals": { "columnHeader": { "mode": "exact", "value": "Member ID", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } }, "value": { "from": "param", "param": "memberId" } }
            }
          }
        },
        "settle": { "stableSamples": 2, "pollIntervalMs": 200, "maxWaitMs": 10000 },
        "expect": {
          "predicate": { "kind": "node-exists", "where": { "role": "heading", "name": { "mode": "oneOf", "value": ["Member Detail", "Member Profile"], "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": true } } } },
          "delta": { "mustChange": true, "navigatedTo": { "originAlias": "corebank", "path": "/backoffice/members/:memberId", "frame": "content" } },
          "continuity": ["subjectMember"],
          "describes": "The member detail screen for the member we were asked about is open."
        },
        "outcomes": ["MEMBER_RESTRICTED"],
        "recoveries": [],
        "budgets": { "perRecoveryMaxAttempts": {}, "maxRemediationCycles": 1, "settle": { "stableSamples": 2, "pollIntervalMs": 200, "maxWaitMs": 10000 } },
        "evidence": { "captureOn": ["failure"], "maskRegionsFor": ["memberId"] }
      },

      {
        "id": "open-accounts",
        "label": "Open the Accounts tab, where the savings balance is listed.",
        "effectClass": "READ",
        "action": {
          "kind": "click",
          "target": {
            "scope": { "path": [ { "kind": "landmark", "role": "navigation", "name": { "mode": "exact", "value": "Member Tabs", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } } } ] },
            "descriptors": [
              { "kind": "role-name", "role": "link", "name": { "mode": "oneOf", "value": ["Accounts", "Share Accounts"], "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": true } } },
              { "kind": "ordinal-in-container", "container": { "path": [ { "kind": "landmark", "role": "navigation", "name": { "mode": "exact", "value": "Member Tabs", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } } } ] }, "role": "link", "index": 1 }
            ],
            "agreement": { "minResolved": 2, "requireIdentical": true, "onUnderQuorum": "fail" },
            "assert": { "role": "link", "name": { "mode": "oneOf", "value": ["Accounts", "Share Accounts"], "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": true } }, "enabled": true, "visible": true }
          }
        },
        "settle": { "stableSamples": 2, "pollIntervalMs": 200, "maxWaitMs": 10000 },
        "expect": {
          "predicate": { "all": [
            { "kind": "node-exists", "where": { "role": "table", "name": { "mode": "oneOf", "value": ["Accounts", "Share Accounts"], "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": true } } } },
            { "kind": "count", "where": { "scope": { "path": [ { "kind": "table", "headers": [ { "mode": "exact", "value": "Account Type", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } } ] } ] }, "role": "row" }, "op": "gte", "n": 1 }
          ] },
          "delta": { "mustChange": true },
          "continuity": ["subjectMember"],
          "describes": "The accounts table for this member is showing at least one account row."
        },
        "outcomes": [],
        "recoveries": [],
        "budgets": { "perRecoveryMaxAttempts": {}, "maxRemediationCycles": 1, "settle": { "stableSamples": 2, "pollIntervalMs": 200, "maxWaitMs": 10000 } },
        "evidence": { "captureOn": ["failure"], "maskRegionsFor": ["memberId"] }
      }
    ]
  },

  "provenance": {
    "discoveryRunId": "disc_01JB4W7Q2K9YV3N8",
    "goal": "look up member {memberId} and read their current savings balance",
    "model": { "provider": "anthropic", "modelId": "<recorded at run time>" },
    "transcriptRef": "evidence/discovery/disc_01JB4W7Q2K9YV3N8/transcript.jsonl",
    "recordedAt": "2026-08-19T13:47:52Z",
    "recordedAgainst": {
      "tenantId": "riverbend",
      "originAlias": "corebank",
      "fingerprint": { "perStep": {
        "enter-member-id": "sha256:1c9a...",
        "submit-search":   "sha256:7d02...",
        "open-member":     "sha256:b415...",
        "open-accounts":   "sha256:e6f8..."
      } }
    }
  },

  "verification": {
    "mode": "replay-live",
    "status": "verified",
    "coveredThroughStep": "open-accounts",
    "runId": "rep_01JB4W8A5T1XC0M2",
    "at": "2026-08-19T13:48:40Z",
    "grade": "full"
  },

  "policy": {
    "originAliases": ["corebank"],
    "maxEffectClass": "READ",
    "requiresApprovalToken": false,
    "redaction": { "maskScreenshotRegions": true, "taintedParams": ["memberId"] }
  },

  "signatures": [
    { "over": "sha256:4b1d0c7a9e2f5518a3c6d40b7e91f2ac8d5b6e0f3a7c1d94e28b5f6072c1a3d8e",
      "by": "ops-lead@example-cu.invalid", "alg": "ed25519",
      "sig": "<base64>", "at": "2026-08-19T14:02:11Z" }
  ]
}
```

### 6.1 The write flow differs in four places

The sibling capability `corebank.member.open-subaccount` is the same shape. The delta is worth
showing because it is where the safety model and the taxonomy meet:

```jsonc
{
  "id": "confirm-open-subaccount",
  "label": "Click Confirm on the sub-account confirmation dialog.",
  "effectClass": "WRITE_IRREVERSIBLE",   // (1) forces retryPolicy 'never'; no `act` recoveries
  "action": { "kind": "click", "target": { /* ...assert.name is 'Confirm', not 'OK' or 'Yes'... */ } },
  "expect": {
    "predicate": { "kind": "node-exists", "where": { "role": "heading", "name": { "mode": "exact", "value": "Sub-account Opened", "normalize": { "trim": true, "collapseWhitespace": true, "caseFold": true, "stripPunctuation": false } } } },
    "delta": { "mustChange": true },
    // (2) continuity on the CONFIRMATION screen - this is where W7 collapses into W1 (§4.2)
    "continuity": ["subjectMember", "subjectAccountType"],
    "describes": "The confirmation screen names the member and the account type we asked for."
  },
  "recoveries": []                        // (3) empty by invariant 3
}
```

and at the envelope: `policy.requiresApprovalToken: true`, and
`verification: { mode: "replay-dry", grade: "partial-up-to-irreversible", coveredThroughStep: "review-subaccount" }`
- **(4)**, which is §12.

### 6.2 Four details in that JSON I would expect to be asked about

**The `submit-search` checkpoint counts *action links*, not rows.** Counting nodes with role `row`
would include the header row, so `n: 1` would be wrong and `n: 2` would be a magic number that
breaks the moment a tenant renders a footer row. Counting the `Select` links is exactly one per data
row by construction, header rows have none, and it asserts uniqueness of *the control we are about
to click* rather than of the layout around it. Checkpoints should assert the thing the next step
depends on.

**`columnHeader: oneOf ["Action", ""]` in the `open-member` descriptor is not sloppiness.** Legacy
back-office tables routinely leave the action column's header cell empty. The empty-string
alternative is the honest encoding of "this column has no heading here, and is called *Action* at the
other tenant," and it is exactly the kind of thing an overlay would otherwise have to bodge.

**`enter-member-id` is a step with a checkpoint, not a free action.** It would be tempting to treat
typing as fire-and-forget. Asserting the field actually contains the value catches a real and
otherwise-silent class: a legacy input with a maxlength or an input mask that truncated or reformatted
what we typed, which then produces `MEMBER_NOT_FOUND` for a member who exists.

**`memberId` is `sensitivity: "sensitive"` while `savingsBalance` is only `"internal"`.** The member
number is the identifier that links a balance to a person; the balance on its own is far less
dangerous in a log. Taint follows the identifier, which is why the screenshot region masked on every
step is the search field and not the balance cell.

---

## 7. The replay result contract

This is the type an AI agent - or the operator console, or a test - receives. Three statuses, for the
reason in §2.3.

```ts
export type ReplayResult<TOutputs = Record<string, unknown>> =
  | ReplayOk<TOutputs>
  | ReplayOutcome
  | ReplayFailed;

/** Present on all three. WHY on all three: a failed run and a business outcome need exactly the
 *  same provenance to be debuggable, and putting it only on failures guarantees someone later
 *  cannot answer "which artifact returned MEMBER_NOT_FOUND last Tuesday". */
export interface ReplayEnvelope {
  runId: string;
  capabilityId: string;
  capabilityVersion: number;
  /** Both digests: the base artifact, and the base⊕overlay actually executed (§5.6). */
  artifactDigest: Digest;
  resolvedDigest: Digest;
  tenantId: string;
  startedAt: Timestamp;
  endedAt: Timestamp;
  /** Who actually performed the work. `human-assisted` when a lease was handed over mid-run. */
  attribution: { by: 'automation' | 'human-assisted'; leaseEvents: LeaseEvent[] };
  /** One entry per step attempted, including retried attempts. The debug story. */
  steps: StepTrace[];
  budgets: { remediationsUsed: number; remediationsAllowed: number; elapsedMs: number; deadlineMs: number };
  /** Drift signal from the fingerprint comparison. REPORTED, never acted on (§5.6). */
  drift: { maxStepDivergence: number; needsSpecialization: boolean; divergentSteps: StepId[] };
  /** Out-of-band pointers. Never inline blobs, never unredacted. */
  evidence: EvidenceRef[];
  /** Non-fatal integrity warnings, e.g. `detector-overlap` (taxonomy row 27). */
  warnings: RunWarning[];
}

export interface ReplayOk<T> extends ReplayEnvelope {
  status: 'ok';
  /** Typed per `contract.outputs`. Every required output present and coerced, or this is not `ok`. */
  outputs: T;
}

export interface ReplayOutcome extends ReplayEnvelope {
  status: 'outcome';
  outcome: {
    code: string;                        // 'MEMBER_NOT_FOUND'
    summary: string;                     // copied from the artifact, so the caller need not load it
    /** Whatever the outcome declared; typed like outputs. */
    data: Record<string, unknown>;
    /** The instruction to the calling agent. This is the field that makes the split useful. */
    callerAction: 'inform-user' | 'retry-different-input' | 'escalate-human';
    /** Which step produced it and which detector matched - so a wrong outcome is debuggable. */
    atStep: StepId;
    detectorId: string;
  };
}

export interface ReplayFailed extends ReplayEnvelope {
  status: 'failed';
  failure: {
    class: FailureClass;
    atStep: StepId | null;               // null for pre-flight failures
    /** Verbatim from `Checkpoint.describes` or the engine's own message. */
    expected: string;
    /** What was actually there. Redacted per taint before it is written anywhere. */
    observed: ObservedSummary;
    /** For target-ambiguous: every candidate, per descriptor, with why each was chosen. */
    candidates?: TargetCandidate[];
    attempts: { recoveryId: string; attempts: number; lastObservationDigest: string }[];
    /**
     * The single most useful field for the caller.
     * 'same-inputs'        -> transient; the agent may retry now.
     * 'after-human-action' -> a person must change the environment first (entitlement, data fix).
     * 'no'                 -> do not retry. Includes every `effect-in-doubt`.
     */
    retriable: 'same-inputs' | 'after-human-action' | 'no';
    escalation?: { interventionId: string; raisedAt: Timestamp; state: 'open' | 'resolved' | 'abandoned' };
    /** The frozen Observation that produced this verdict, by reference. This is the file that
     *  turns a production failure into a classifier unit test with no reproduction step. */
    observationRef: string;
  };
}

export type FailureClass =
  | 'artifact-invalid' | 'precondition-not-met' | 'policy-denied' | 'lease-lost'
  | 'target-not-found' | 'target-ambiguous' | 'target-assert-failed' | 'action-faulted'
  | 'no-observable-effect' | 'checkpoint-failed' | 'continuity-broken'
  | 'output-extraction-failed' | 'undeclared-dialog' | 'session-expired-unrecoverable'
  | 'entitlement-denied' | 'app-error' | 'did-not-settle' | 'recovery-exhausted'
  | 'budget-exhausted' | 'effect-in-doubt';

export interface StepTrace {
  stepId: StepId;
  attempt: number;
  verdict: Verdict;                      // the classifier's own output, verbatim
  observationDigest: string;
  observationRef?: string;               // present when captured per the evidence policy
  elapsedMs: number;
  /** Which descriptors resolved to what. Present even on success; this is how you notice a
   *  descriptor has been quietly failing for a month while the others carried the target. */
  resolution?: { descriptorKind: string; resolvedNodeId: string | null; agreed: boolean }[];
}
```

Three properties of this contract worth defending:

**`ReplayOk` is total or it is not `ok`.** There is no partial success. A run that reached the
checkpoint but could not extract a required output is `failed / output-extraction-failed`, not `ok`
with a missing field. The reason is the same as taxonomy row 3: a caller that receives `ok` must be
able to use the outputs without checking each one, or the type has bought nothing.

**Every status carries `steps` and `evidence`.** The temptation is to make failures verbose and
successes terse. But the run you most want a trace for is the one that returned `ok` and should not
have, and `StepTrace.resolution` on a successful run is how a silently degrading descriptor becomes
visible before it becomes an incident.

**`observationRef` closes the loop from production to test.** A failure in production hands you the
exact JSON input to `classify` that produced the verdict. Reproducing it requires no browser, no
fixture, and no session - which is the practical payoff of §3.1 and the reason purity was worth
designing for rather than merely claiming.

---

## 8. The Observation / Action ports

This is the seam from `BRIEF §3.1`, made concrete. Nothing above this line knows what a browser is;
nothing below it classifies anything.

```ts
/** BRIEF §3.1 fixes this at two operations. Evidence capture is a SEPARATE optional interface
 *  (below), so a surface that cannot screenshot is still a legal Surface. */
export interface Surface {
  perceive(): Promise<Observation>;
  act(action: Action): Promise<ActResult>;
}

/** Optional capability, feature-detected by the runtime. The terminal driver implements it by
 *  dumping the VT cell grid; the browser driver by screenshot. Both go through region masking. */
export interface SurfaceCapture { capture(kind: 'image' | 'grid'): Promise<Uint8Array> }
```

```ts
export interface Observation {
  /** Monotonic within a session. Not a timestamp - the classifier gets no clock. */
  seq: number;
  /** Canonicalized. NEVER the raw URL; the driver applies the tenant's route canonicalization. */
  route: { originAlias: string; path: string; query: Record<string, string>; frame?: string };
  nodes: UINode[];
  /** Root ids, plural: a frameset has several. */
  roots: UINodeId[];
  /**
   * Digest of the STRUCTURAL SKELETON only (role + name + containerPath + state), excluding
   * geometry and nodes marked `live`. This is the quiescence signal (§3.5) and it is computed
   * by the driver so the classifier never hashes anything.
   */
  skeletonDigest: string;
  /** True when the driver knows a modal/overlay is intercepting input. Drives band B2's
   *  pre-act guard, which cannot wait for a post-act classification. */
  inputIntercepted: boolean;
  surface: { kind: 'web-modern' | 'web-legacy' | 'terminal' | 'desktop'; driver: string };
}

/**
 * Opaque, and stable ONLY within one Observation.
 * WHY that is stated so loudly: it is what stops anyone from putting a node id in the artifact.
 * A node id is an index into a snapshot, not an identity.
 */
export type UINodeId = string;

export interface UINode {
  id: UINodeId;
  role: Role;
  /** Accessible name. On the terminal driver, the detected label text for the field. */
  name: string;
  value?: string;
  description?: string;
  state: NodeState;
  /** px on web, character cells on the terminal driver. Optional: a surface may have no geometry. */
  bounds?: { x: number; y: number; w: number; h: number; unit: 'px' | 'cell' };
  /** The breadcrumb §5.1 matches against. Computed by the driver, not by the engine. */
  containerPath: ContainerSegment[];
  parent?: UINodeId;
  children: UINodeId[];
  /** Marks a node whose text changes on its own (clocks, tickers). Excluded from the skeleton
   *  digest so it cannot make a surface permanently unsettled. */
  live?: boolean;
}

export interface NodeState {
  disabled: boolean; focused: boolean; checked?: boolean; expanded?: boolean;
  selected?: boolean; required?: boolean; invalid?: boolean; visible: boolean;
}
```

```ts
/** Closed set. Adding a kind is a deliberate, reviewed change to the policy engine's classifier. */
export type Action =
  | { kind: 'click'; target: UINodeId }
  | { kind: 'type'; target: UINodeId; text: string; mode: 'replace' | 'append' }
  | { kind: 'select'; target: UINodeId; option: string }
  | { kind: 'setChecked'; target: UINodeId; checked: boolean }
  | { kind: 'pressKey'; target?: UINodeId; key: 'Enter' | 'Tab' | 'Escape' | 'ArrowUp' | 'ArrowDown' | 'PageDown' | 'PageUp' }
  | { kind: 'navigate'; route: { originAlias: string; path: string; query?: Record<string, string>; frame?: string } }
  | { kind: 'scrollTo'; target: UINodeId };

/**
 * Note what is NOT here: no `wait`, no `screenshot`, no `read`.
 * Waiting is the executor's quiescence loop, not an action. Reading is a pure function over an
 * Observation, so extraction never touches the surface (§3.1) and is testable frozen.
 */

export type ActResult =
  | { ok: true; dispatched: true }
  | { ok: false; fault: ActFault };

/** MECHANICAL faults only. The driver reports what the machinery did; it never classifies.
 *  The classifier turns these into `FailureClass` values with the artifact's context. */
export type ActFault =
  | { kind: 'node-gone'; nodeId: UINodeId }            // the Observation went stale between
                                                        // resolution and dispatch
  | { kind: 'not-actionable'; nodeId: UINodeId; why: 'disabled' | 'invisible' | 'zero-size' }
  | { kind: 'intercepted'; nodeId: UINodeId }          // something else received the input
  | { kind: 'navigation-blocked'; route: string }
  | { kind: 'surface-error'; message: string };
```

Note the `ActionSpec` in the artifact (§5.5) is not this `Action`. The artifact carries a
`TargetRef`; the port carries a resolved `UINodeId`. **Resolution happens in `core`, between them**,
and that is precisely the boundary where descriptor agreement and `targetAssert` run. A driver is
never handed a descriptor and never resolves anything, which is what keeps the CSS vocabulary
contract test enforceable.

`ActFault.intercepted` is worth its own line: it is the driver telling us the click went somewhere
else, which is the one wrong-target case the machinery can see directly (§4, W5).

---

## 9. Locator / target representation, and why

The constraint that shapes this: `BRIEF §2.2` says selector drift has been deliberately removed as the
problem, and `§3.7` of the assignment says bias toward what works with no clean DOM. So this section
is **not** self-healing selectors. It is: pick identities that a human would use, compute several of
them independently, and treat disagreement as information.

**Why accessible name is the primary identity.** In a legacy back-office app, `ctl00_ctl32_g_9a1`
changes when a developer reorders a control tree; the visible caption "Search" does not, because
changing it retrains every teller in the credit union. The accessible name is downstream of the thing
the business is actually committed to. That is a stronger stability argument than "ARIA is a
standard," and it is why it survives the move to a green-screen surface where there is no markup at
all: the label text is still there on the character grid, and `surface-terminal` derives `name` from
label detection in the VT buffer. A CSS selector has no meaning on that surface. An accessible name
does. That is the test of whether the abstraction is real.

**Why not one descriptor.** Accessible name alone is not unique - a results table has ten "Select"
links with identical names, and that is exactly the W1 wrong-row case. So:

| Rank | Descriptor | What it encodes | Fails when |
|---|---|---|---|
| 1 | `role-name` | the caption a human reads | duplicated within scope |
| 2 | `label-anchored` | "the box next to *Member ID*", incl. spatial association | the label moves relative to the field |
| 3 | `table-cell` | "the *Select* link on the row whose *Member ID* is `:memberId`" | column headings are renamed |
| 4 | `ordinal-in-container` | position | anything is inserted |
| 5 | `geometric` | scoped offset from an anchor's text | re-layout, theming |

Rank is a property of the kind and lives in `core`, never in the artifact - otherwise a tenant
overlay could promote `ordinal` and quietly reintroduce positional targeting. **`ordinal` may never
be the only or highest-ranked descriptor** (invariant 2), because it is the descriptor that hits the
wrong target without complaining. It earns its place as a *second opinion*: when `role-name` and
`ordinal` agree, we have positive evidence the layout is what we recorded; when they disagree we have
`target-ambiguous`, which is better than either being right alone.

**Why `table-cell` is the important one for this domain.** Back-office banking screens are
search-result tables, and the human's actual algorithm is "find the row where Member ID is 12345,
then click Select on that row." Encoding *that* - header text plus a row key bound to the caller's
own parameter - is both the most stable descriptor and the strongest wrong-target control (§4.1 C1).
The two goals turn out to be the same goal, which is the nicest thing about this design.

**Why agreement rather than fallback.** A fallback chain converts a disagreement into a silent
choice, and the disagreement is the only evidence we will ever get that the surface has changed
underneath us. `requireIdentical: true` is typed as a literal so it cannot be configured away, and
`onUnderQuorum: 'fail'` likewise. The cost is real and I will state it: on a genuinely drifted screen
this design **stops** where a fallback chain would have carried on and probably done the right thing.
That is the trade I want in a bank, and it is the trade the brief's "stable UIs" premise makes cheap -
if drift were constant, this would be the wrong call.

**Why no regex, anywhere.** `TextMatcher` has `exact`, `template`, `oneOf` and nothing else. Three
reasons: a regex in an artifact is not reviewable by the operations person who has to approve it; it
is a denial-of-service surface (catastrophic backtracking) in a file that crosses a trust boundary
from a discovery run; and the one thing people reach for regex to do here - "the message with the id
in it" - is better served by `template` holes, which additionally keep the id out of the file
(§5.7 invariant 8). Matching is a linear pass over normalized text with named holes.

**Multi-tenant.** Label variation between two tenants running the same vendor product is handled by
`oneOf` alternatives, added by the overlay, never replacing the base. Branding words are handled by
`normalize.stripTokens`. Both are *widening* operations, which is why an overlay cannot change what a
capability means (§5.6). What this does not survive is a tenant that translates the UI into another
language: every `TextMatcher` breaks at once and the honest answer is a separate recorded artifact,
not an overlay. §13 lists that.

---

## 10. Workspace package layout

Six packages and two fixtures. The line I drew is **purity**, not subject matter: one package that
cannot do I/O and one that owns all of it, because that boundary is the one this design's central
claim depends on, and it is the one a contract test can actually enforce. Every other boundary I
considered, I merged.

| Package | One-line justification |
|---|---|
| `packages/core` | Schema, ports, resolver, classifier, extractor, policy predicate - **zero I/O, zero clock, zero driver imports, checked by contract test**. This is the package the conformance suite grades and the one the whole thesis rests on. |
| `packages/runtime` | The impure half: session, control lease, quiescence polling, budgets, evidence sink, file-backed artifact store, operator console, and the `crr` CLI. One place where time, disk and sockets live, so "core is pure" is a statement about a directory. |
| `packages/surface-browser` | Playwright + CDP `Accessibility.getFullAXTree` → `Observation`; the only package that may know what a frame or a pixel is. |
| `packages/surface-terminal` | pty character-grid driver. Exists **to falsify the abstraction**: if the ports only fit a browser, this package is where that becomes obvious rather than aspirational. |
| `packages/discovery` | LLM provider port (Anthropic primary, OpenAI adapter), the observe→decide→act loop, and artifact synthesis: descriptor derivation, parameterization, route canonicalization, verification replay. The only package that may import a model SDK. |
| `packages/conformance` | Fault scenarios × mutant engines + the meta-test that fails when the suite stops discriminating. Separate because it must be able to import broken engines without shipping them. |
| `fixtures/corebank-web` | The hostile surface: framesets, table layout, generated ids, no test IDs, per-session fault injection, two tenant variants of one vendor product. |
| `fixtures/corebank-tui` | The green-screen variant, so `surface-terminal` has something to drive. |

**What I deliberately did not make a package**, and why, because the assignment says architecture
theatre is not rewarded:

- **No `@crr/schema`.** The schema and the classifier change together - every new field exists for the
  classifier. Splitting them creates a version skew between a validator and its only consumer, and
  buys a dependency arrow nobody reads.
- **No `@crr/policy`.** The policy engine is one pure `check(action, ctx)` chokepoint. It is ~200
  lines and it belongs next to the classifier that shares its vocabulary.
- **No `@crr/store`.** It is a file-backed content-addressed directory. A package for `readFile` is
  the definition of theatre.
- **No `apps/cli` and no `apps/console`.** A package whose entire content is a `main()` is a
  package that exists to be counted. Both are `bin`/route entries in `runtime`.
- **No `@crr/types`.** The classic monorepo mistake: a leaf package everyone depends on and nobody
  owns, which becomes the place fields go to avoid a design conversation.

---

## 11. What is deliberately not in the schema

Each of these was considered and cut. The cut is the design.

1. **No CSS selector, XPath, or DOM id. Not even as an escape hatch.** An escape hatch becomes the
   default within one sprint, because it is always the fastest way to fix today's bug. The contract
   test that greps `core` for CSS vocabulary is what makes this a rule rather than a preference.
2. **No branching, loops, or conditionals in the flow.** Steps are a straight line; the only branch
   is a terminal outcome. This is the single biggest scope cut in the document and it is deliberate:
   branching turns the artifact into a program, destroys the reviewability that justifies "data, not
   code," and makes the classifier's totality argument much harder. If a flow genuinely needs a
   branch, that is **two capabilities** and the calling agent composes them - which is also the
   honest answer, because a branch is a decision and decisions belong to the agent.
3. **No timings observed during discovery, used as replay budgets.** Recording that the page took
   840ms and setting an 840ms timeout is the classic way to manufacture flake. Budgets are declared
   policy with round numbers, tuned against the conformance corpus, and overridable per tenant.
4. **No raw model transcript, and no model-authored prose the engine reads.** `provenance.transcriptRef`
   is a pointer. `Step.label` exists for humans and a contract test asserts the engine never reads it -
   because an engine that reads prose has put the model back in the decision loop through a side door.
5. **No credentials, session tokens, cookies, or storage state.** Re-authentication resolves
   `{ from: 'credential' }` through a broker at act time, tainted, never stored, never logged.
6. **No screenshots or pixel data inline.** Evidence is out-of-band, referenced, and region-masked
   for anything bound to a `sensitive` parameter.
7. **No absolute URLs.** `originAlias` + canonicalized path only. A literal URL makes an artifact
   accidentally single-tenant and persists PII in the path.
8. **No PII in detector literals.** `TextMatcher` uses `template` holes; the save-time lint rejects
   literals matching sensitive values or PII shapes. This is the gap in "the artifact stores shapes,
   not values" that parameterization alone does not close: a detector that says
   `"No member found for 12345"` has stored a member number just as surely as a step value would.
9. **No whole-page expected-text snapshots.** They embed PII, they break on branding, and they turn
   every cosmetic change into a hard failure - which trains people to ignore hard failures.
10. **No confidence scores or thresholds on locator matches.** A score invites a threshold, a
    threshold invites tuning, and tuning a match threshold is how a wrong-target click becomes
    policy. Matching is boolean; disagreement is a named failure.
11. **No self-healing / locator repair on replay.** Drift is *detected* via the fingerprint and
    *reported* as `needsSpecialization`. Repair belongs in a review loop that produces a new signed
    artifact version. A replay engine that edits its own locators has no determinism claim left, and
    determinism is the entire product.
12. **No per-artifact retry counts learned from the model.** Budgets are authored and reviewed.
13. **No `expectedScreenshot` / visual diff checkpoint.** Tempting for the wrong-target problem, and
    rejected: it is the least stable signal on a multi-tenant, multi-theme surface, and it would make
    the classifier impure (it needs pixels, not an Observation) - which would cost the frozen-snapshot
    testability that this whole design is organized around.

---

## 12. Where I think the brief is wrong

`BRIEF §3.4` - "recording is not a claim until it replays" - is right in intent and unsound as
written for exactly the flows that matter most.

The problem: the immediate verification replay runs against a surface the discovery run just mutated.
For a read-only capability that is fine. For `corebank.member.open-subaccount`, **verification opens a
second sub-account.** The mechanism that proves the artifact is faithful is itself an unapproved,
unattended, duplicated irreversible write against a bank system - which is the thing the entire safety
model in `§3.7` exists to prevent. Nothing in the brief notices that §3.4 and §3.7 are in direct
conflict for write flows.

The fix is small and it improves the design rather than weakening it. Verification gets a declared
mode, and the artifact records which one it got:

- **`replay-live`** - the whole flow, for capabilities whose net `effectClass` is `READ`. Grade `full`.
- **`replay-dry`** - for write flows. Replay every step up to the first `WRITE_IRREVERSIBLE`, then at
  that step do everything except dispatch: resolve the descriptors, require agreement, run
  `targetAssert`, evaluate the precondition - and stop. Grade `partial-up-to-irreversible`, with
  `coveredThroughStep` naming exactly where it stopped. This still verifies the part of the artifact
  most likely to be wrong (locators, checkpoints, parameter binding) without performing the write a
  second time.
- **`replay-reset`** - the whole flow, when the environment exposes a reset hook. Our fixture does.
  Real core banking does not, and pretending otherwise in the design would be the kind of thing that
  reads fine in a document and fails in the first customer deployment.

Two things follow that are worth more than the fix itself. `Verification.grade` becomes a field a
human approver *must* read: a `partial-up-to-irreversible` draft is a different claim from a `full`
one, and flattening them into a boolean `verified` would hide precisely the risk the approval gate
exists to weigh. And "resolve-but-do-not-dispatch" turns out to be independently useful - it is a
dry-run mode for production, a way to check an artifact against a tenant after an upgrade without
touching their data.

I would keep the other eight decisions in `BRIEF §3` unchanged. Two I want to record explicit
agreement on, because they are the ones I would have argued for anyway: `§3.2` (the model never
authors a locator, and disagreement is a signal rather than a fallback) is the decision that makes
§4 of this document possible at all; and `§3.3` (taxonomy as declared data, classifier as a pure
function) is the one that turns "we handle errors" into something a test suite can grade.

---

## 13. Risks and known weaknesses

Stated at the same standard the sibling repos use: these are the things that would make me
uncomfortable defending this design, listed before anyone has to find them.

1. **The taxonomy is only as good as the detector corpus, and it decays toward "everything is a hard
   failure."** Fail-closed means every unrecognized screen needs a human to add a detector and cut a
   version. If nobody staffs that review, the capability degrades into one that fails a lot and gets
   turned off. The mitigation is a metric, not a mechanism: the share of runs ending in
   `checkpoint-failed` is the review queue's SLA, and if it climbs, the taxonomy is stale.
2. **Non-overlap is verified against a corpus the same person wrote.** Two detectors can be provably
   non-overlapping over 40 frozen snapshots and overlap in production on snapshot 41. The runtime
   `detector-overlap` warning is what catches that, and it catches it *after* the run has already
   returned an answer chosen by declaration order.
3. **Continuity assertions require the identifying value to be visible.** Many back-office screens
   show a name and not an id, or an internal key the caller never supplied. Where the identity is not
   on screen, C2 is unavailable and W7 is unmitigated. This is a per-capability property, and the
   schema should probably surface it - a capability with zero continuity assertions on a write flow
   is a review finding, not a valid artifact. I have not added that invariant because I am not sure
   it is always achievable.
4. **`replay-dry` is a weaker claim than `replay-live` and the grade is doing real work.** If an
   approver treats `partial-up-to-irreversible` as "verified," the whole §12 fix is decorative.
5. **Descriptor agreement makes the system stop where a fallback would have continued.** On a genuinely
   drifted screen this design refuses. That is the right trade under the brief's "stable UIs" premise
   and it is the wrong trade if that premise turns out to be false for a given tenant. The
   fingerprint drift signal is the early warning, and nothing automatically acts on it.
6. **The terminal surface makes `role` a heuristic.** On a character grid, "this is a textbox" is
   inferred from a field's rendering, not read from a tree. The port fits, but the *fidelity* differs,
   and a descriptor set derived on the web surface will not necessarily port to the green-screen
   variant of the same product. I would not claim cross-surface artifact reuse; I would claim
   cross-surface *engine* reuse.
7. **Every `TextMatcher` breaks under UI translation.** `oneOf` handles a relabelled field; it does
   not handle a Spanish-language tenant. That is a re-record, and the design should say so rather
   than imply the overlay covers it.
8. **The PII lint is shape-based and will both miss and over-trigger.** It will not catch a member
   number that looks like an order number, and it will flag a legitimate literal that happens to look
   like a phone number. It is a backstop for parameterization, not a substitute for it.
9. **Budgets are per-run.** Nothing here prevents a hundred concurrent invocations of one capability
   from stampeding a legacy app that was sized for forty tellers. Concurrency control is deliberately
   out of scope per the anti-goals, and it is a real gap in a real deployment.
10. **`effect-in-doubt` needs a reconciliation story this system does not have.** It correctly refuses
    to guess, and then hands a human a problem with no tooling attached. That is better than guessing
    and it is not good enough.

---

## 14. Open questions I would want a reviewer's opinion on

1. **Should `INVALID_INPUT` (row 1) really be an `outcome` rather than a rejected call?** It never
   touches the surface, so calling it a "business outcome" is a stretch. I chose `outcome` so a
   calling agent has exactly one place to look for "why didn't I get outputs," but a thrown
   `TypeError`-shaped rejection is defensible and simpler.
2. **Is B3-before-B4 right in every case?** I argued outcomes beat recoveries because outcomes are
   terminal truth. The counter-case is an outcome detector that matches on a page which *also* has a
   dismissible overlay covering part of it - B2 catches most of those, but not one where the overlay
   is non-blocking.
3. **Should `Step.outcomes` be per-step at all,** or should every declared outcome be evaluated at
   every step? Per-step is tighter and catches "MEMBER_NOT_FOUND appeared at a step where it is
   impossible," which is a genuine artifact bug. It is also more to maintain and more to get wrong.
4. **Is the no-branching cut too aggressive?** It is the cut I am least certain about. It forces
   composition into the calling agent, which is where I think decisions belong - but a flow with an
   optional "accept terms" screen is not really a decision, and modelling it as a recovery is a
   slight abuse of the recovery concept.
