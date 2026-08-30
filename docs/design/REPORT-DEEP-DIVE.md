# REPORT - `capability-record-replay`

A model drives a legacy back-office application once. What it learned becomes a typed, versioned,
content-addressed capability document. Everything after is a deterministic interpreter with no model
in the decision path. For a reviewer command path, start with
`docs/FINAL-REVIEWER-GUIDE.md`; for assignment traceability, read `docs/REQUIREMENT-TRACE.md`.

**What is *not* proven, first.**

- **The target application is my own fixture.** It cannot surprise me the way a real vendor product
  would, and that is the main threat to every reliability number below. A 0.0% flake rate over a
  corpus I wrote bounds hidden state in the engine, not flake in production.
- **One live discovery run**, nine turns, one surface - and no live model has ever been refused by
  the policy gate, got stuck, or raised an intervention. Those paths have hermetic tests only.
- **Desktop (AX/UIA) is a seam, not code**, and approval still has no external KMS/HSM custody.
  Artifact approval signs the artifact digest; invocation approval now adds signer identity,
  expiry, request binding and revocation checks at the irreversible runtime gate.

| Claim | Result | Command / receipt |
|---|---|---|
| Builds and passes with **zero credentials** | **2,032 tests**, 8 members, exit 0 | `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN TURBO_FORCE=1 pnpm test` |
| A real model reached a real goal | `claude-opus-5`, 9 turns, 42,368 billed tokens, **$0.14** | `evidence/discovery-live/provenance.json` |
| Its artifact replayed with the model out of the loop | `full`, `proposed → draft`, every gating canary pass CLEAN | `evidence/discovery-live/verification.json` |
| Replay tells a good engine from a broken one | reference engine **0 false successes**; **9/9 mutants killed**, 13 of the 17 kills false successes | `pnpm -F @crr/conformance stability` |
| A reviewer can run the main demo with no key | 278 files on the latest credential-unset reviewer-script run, whole-bundle canary CLEAN, exit 0 | `pnpm demo` |

---

## 1. Architecture

There is **one seam**: a `Surface` port. `perceive(): Observation` returns a normalized tree of typed
`UINode`s - role, accessible name, value, state, bounds, container path - and `act(Action, lease)`
takes a closed set of typed actions. Nothing above it knows what a browser or a pixel is.

The package line is drawn on **purity**: `@crr/core` cannot do I/O, read a clock or generate a random
number. That is not a comment - contract tests read the repository off disk and fail on core
impurity, on CSS/XPath vocabulary or a driver import above the drivers, and on any `Surface.act` call
site not immediately preceded by a policy `check`. **Each was verified by injecting a real
violation.**

**The discovery loop is hand-written against the Messages API, not an SDK helper**: every tool call
must pass the policy chokepoint and be journaled. `disable_parallel_tool_use: true`, because a
computer-use loop must observe each action's consequence before choosing the next. Every run records
its transcript to a VCR fixture a `replay` adapter serves back - which is why `pnpm test` passes with
no credentials.

The live run took three attempts; the README has both failures. **At least one turn was billed that
this repository's ledger recorded as $0.00** - attempt 2 threw parsing a response the provider had
already produced, and the arithmetic cannot see a turn it failed to parse, so the provider's console
is the authority. That attempt also left the cache warm: the successful run pays **zero cache-write
tokens** on all nine turns, so its 55.4% hit rate is a warm-start figure.

## 2. Artifact schema

**Three documents, three readers.**

| Document | Reader | Contains |
|---|---|---|
| `contract` | the calling agent, the product owner | typed `inputs`/`outputs`, outcome *names*, `whenToUse`/`whenNotToUse`, effect class. **Zero surface detail.** |
| `artifact` | the interpreter, the security reviewer | the program: routes, vocabulary, steps, descriptors, checkpoints, detectors, budgets, effects, and one **promotion receipt** per human-authored outcome (§7). |
| `overlay` | the linker, per tenant | additive, non-semantic overrides only. |

**Detectors live on the artifact's steps, never on the contract.** That is what lets one contract be
implemented by two programs: how you tell that a screen means *no such member* is a property of a
surface; that the caller may receive `MEMBER_NOT_FOUND` is not.

**The artifact stores shapes, never values.** A value from the goal is bound as a typed parameter,
routes canonicalize (`/member/12345` → `/member/:memberId`), and detector text uses template holes.
One mechanism is both the reuse story - a capability, not a macro - and the primary PII control (§6).
The live contract offers `memberId: {kind:"string", charset:"digits"}`; the number the model typed is
nowhere in it, and the parameter's *name* came from the label anchor the locator uses, not from the
model and not from the value's shape.

The artifact is **data, not code**: a non-Turing-complete DSL, canonical-JSON digested, with approval
signing over the digest. Playwright output is a *secondary export* - generated code cannot be diffed
by a non-programmer, linked against an overlay, or refused by a linker.

## 3. Determinism & error handling

**Replay is a classifier with an actuator attached**; the step list is the easy part. `classify` is a
**pure total function from a frozen `Observation` to a `Verdict`**, so the entire error taxonomy is
unit-testable from snapshots with no browser running.

Two rules do most of the work. **Fail closed toward `failed`**: promotion to a business outcome
requires an explicit declared detector, never string similarity, because a false `MEMBER_NOT_FOUND`
is the worst thing this system can emit. And **"not yet" is not "not so"**: no negative outcome may
be classified against a surface that has not demonstrably settled. Each step declares `expect` (a
checkpoint), `outcomes` (detectors) and `recoveries` (bounded, budgeted remedies); the first two
are evaluated *before* the checkpoint, and anything else is a hard failure naming the step, the
expectation and the observation. Four arms: `ok | outcome | suspended | failed`.

The model **never authors a locator**: it picks a node id from the observation it was shown, and
deterministic code derives independently computed descriptors (role+name, label-anchored, table
row/column relative to a header, ordinal-within-landmark, geometric) that resolve separately on
replay and are compared. **Disagreement is a detected condition, never a fallback chain** - a chain
is a machine for turning ambiguity into a confident wrong click.

```text
$ pnpm -F @crr/conformance stability   # lines verbatim; blank lines, rules, 8 matrix rows elided
25 scenarios: 25 passed, 0 failed, 0 FALSE SUCCESSES
kill matrix: 9 mutants x 25 scenarios
mutant            killed by                          of which false successes
nearestMatch      04,06,08,09,15,21                  04,06,08,09,15,21
every mutant was killed by at least one scenario
```

The mutants are the **real `replay()`** - same linker, lease, budgets, journal - with exactly one
pure decision function swapped through an injection seam, enforced by function identity, not stubs.
**17 kills, 13 of them false successes**: the mutant told a caller `ok`, or a business outcome, for a
broken run. The suite was itself checked - deleting scenario 21 produced `SURVIVORS: noContinuity`.
An abstaining descriptor is a signal on a successful run, never a verdict.

## 4. Heterogeneity & multi-tenant

I will not assert that the abstraction generalizes. Here is what happened when I built a second
surface: an 80×24 green screen over `@xterm/headless`, which is what a Symitar-class teller app is.

The 25-scenario browser corpus kills all nine mutants; the 14-scenario green-screen corpus kills
five, and **one of the four survivors is the most useful result in the repository.** `noSettleGate` -
the mutant that classifies against a screen the driver called unsettled - is *indistinguishable from
the reference engine* there, because a green screen's readiness signal is silence and a torn repaint
is silent: the driver reports `settled: true` on a half-painted frame, so no observation exists where
the flag is false and a verdict turns on it. **On that surface the settle gate cannot be the gate,
which is why the checkpoint has to be.** Each survivor's reason is asserted both ways by the test.

Multi-tenant is **base artifact + per-tenant overlay**, overrides only: vocabulary tokens, route base
paths, wait budgets, extra recoveries. One artifact replays green on both fixture tenants through a
12-token vocabulary overlay with **no step override, no detector, no instruction and no outcome**;
without it the run fails `target-underdetermined` and names the descriptor that abstained. The
vocabulary token is the hinge: "Member ID" at one institution and "Member Number" at another is a
*labelling* difference, and labelling differences must not require a new program. On the terminal the
same artifact makes the driver write `\x1bOR` (F3) at one tenant and `\x1b[24~` (F12) at the other
while containing no F-key. Each resolution records a fingerprint, and drift is reported (33.8%
Jaccard) rather than absorbed. Overlays **cannot add outcomes**: an outcome a caller has never heard
of, at one institution only, is worse than a contract bump. The cross-*surface* half is not proved
- §7.

## 5. Escalation & handoff

**Control is a lease, not a pause.** A session has exactly one controller under a lease with a
monotonic epoch; the executor **rejects** an action presented without the current token and epoch,
and `Surface.act` rejects it again at the driver. Two gates, because the interesting failure is an
automation run that believes it still holds a session a human has taken.

"Stuck" is a decided property of the failure class, not a heuristic. A verdict carries a
`SuspensionReason` only where a person at a terminal could plausibly finish the job - seven of them,
from `unclassified-state` to `effect-in-doubt`. A bad artifact, an invalid argument or a policy
denial is **never** escalatable: a human at the app cannot fix those by clicking. A test asserts a
decision for *every* failure class, so a new one cannot arrive undecided.

The operator console is server-rendered HTML with no build step: claim the lease at epoch+1, render
`Surface.capture()` (masked PNG, or masked grid dump on the terminal), inject typed `Action`s **into
the same live session** - policy-checked like any automation action and journaled by *title*, never
by value - then hand back, or abort.

Hand-back is where most designs put a TODO. Resume is not "continue at pc": re-acquire at epoch+1,
re-`perceive`, re-classify at `phase:"pre"`, re-verify the precondition, re-verify continuity,
re-check the effect gate, then re-run the step from the top. The acceptance cases are the refusals -
`escalation.test.ts`, **31 tests**, among them *refuses when the human navigated away*. **Mocked:**
the console polls captures rather than streaming them, and the operator in the tests is a harness;
the lease, both enforcement points, the policy check on the human's action and the seven-step resume
are real.

## 6. Safety

**One chokepoint**: every action - discovery, replay, operator console - passes through one pure
`check(action, ctx)` over lease, allowlisted origin and canonicalized route, action kind, both effect
ceilings, approval state and taint sink, first refusal winning. It is not a package, because a
package boundary does not make something the *only* chokepoint; the contract test does. **Effect
classes** `READ | WRITE_REVERSIBLE | WRITE_IRREVERSIBLE`: irreversible requires scoped invocation
approval at the dispatch boundary, forbids retries and restarts across it, and turns unobserved
dispatch into an auto-escalation. **A taint model**: a `sensitive` parameter yields a handle at bind time, and the
handle - never the value - reaches the policy engine, the journal and every capture.

A safety section listing no failures is not credible. **Four real leaks were caught by these
controls and none by reading the code.** `deriveOutputs` folded a table cell's accessible name into
the query it derived, and on a legacy grid a cell's name *is* the value, so a member's name and
balance reached `flow.vocabulary` - the document that is committed, diffed and signed. `std.text@1`
case-folded every delivered string output. The canary caught the live run's synthesis *report*
quoting the results row the model had read. And `observedSummaryOf` **passed the observed route's
query straight through**, so a failure verdict carried the caller's member number into the journal,
into the result document and onto the operator console - while the frozen observation beside it had
that exact field blanked. The fourth hid behind the fixture for five clean demo runs: it only fires
when a route pattern declares a query binding, which the *live* artifact does (the search form is a
GET form) and the hand-authored one does not, so nothing short of walking the live artifact through
the promotion path reached the code at all. Fixed in `evaluate.ts`, with a regression test that
asserts the input really carried the value before asserting the summary does not.

`artifact.json` and `contract.json` were CLEAN throughout, so parameterization held on the signed
documents - but free-form prose about observed data cannot be redacted, only withheld, and now it
is. Parameterization could not have caught the first: the name was never in the goal, so it was
never bound.

**The canary's scopes are the argument, not its existence.** Five passes, four gating, because two
classes of value differ. The **caller's argument** is in the recording by construction, so that pass
lists every occurrence with a line number and gates on nothing - gating there would make it
unpassable. **Recorded member data** was never an argument, so parameterization has nothing to
substitute: legitimate in the recording and in the replay *result*, nowhere else. The fifth pass
greps every file the run writes *about* itself for exactly that, gated, its scope the **complement**
of the other four, so a file added later is covered by default. Injecting the pre-fix
`finish.summary` back into `provenance.json` fails it by file and needle.

**Limits.** `effect` is *declared, never proven* - a step marked `READ` that posts an audit row is
invisible to the chokepoint, the restart gate and the approval blast radius alike. The PII lint is
shape-based and will both miss and over-trigger. The gating canary has a length floor synthesis does
not share (§7). And fail-closed decays toward "everything is a hard failure" if nobody staffs the
review that adds rules.

## 7. Cuts

**Cut deliberately.**

- **No branching, no loops, no conditionals.** Steps are a straight line; the only branch is a
  terminal outcome. With an `if`, "which steps are irreversible" and "what is a human signing" both
  become *"depending"*, and a signature over a digest stops meaning anything precise. A flow needing
  a branch is two capabilities composed by the caller. **The trigger to revisit**: an "accept terms"
  interstitial is modelled today as a *recovery*, which abuses the concept; on the second one, the
  fix is an `optional-step` marker with a declared skip predicate.
- **No outcome detectors are synthesized.** Candidates ride in the synthesis report with a
  `needs-detector` note and `contract.outcomes` comes out `[]`. A generated detector for a screen
  the run never observed is how a false `MEMBER_NOT_FOUND` ships. **`[]` is now the beginning of a
  story rather than the end of one**: a human can promote one, and `crr promote` makes them prove
  it. A reviewer writes a `promotion.json` in the artifact's own predicate language; a **pure
  function in `@crr/core` calls the same `evaluatePredicate` the classifier's band B3 calls** and
  admits the detector only if it fires on a captured observation of the outcome screen and is
  silent on every other frozen screen - refusing `over-fires / fires-on-happy-path` when it would
  turn a successful run into a confident `MEMBER_NOT_FOUND`, `does-not-fire` when it is scoped to a
  step the condition cannot reach, and `corpus-too-thin` when nobody froze a green capture at that
  step. There is one enforced minimum and no invented threshold: at least one positive, and at
  least one happy-path negative at the same step at the tenant being proven. Everything else is
  reported on the receipt. The promotion is a **revision** - `contract@2.0.0` (MAJOR: an added
  outcome breaks an exhaustive `switch`) plus `artifact@v2 (proposed)`, with v1 left untouched -
  and it must still pass the live verification replay, because `classify` evaluates declared
  outcomes **before** the checkpoint, so adding a detector changes the meaning of every *successful*
  run through that step. `pnpm -F @crr/core exec vitest run test/promotion.test.ts` and
  `pnpm -F @crr/runtime exec vitest run test/promote.test.ts`.
- **No routing prose is generated.** `whenToUse`/`whenNotToUse` are hand-authored or stamped
  `NEEDS AN AUTHOR`. Models mis-route far more often than they mis-fill arguments.
- **No queue, database, auth service, admin SPA, or desktop driver.**

**Gaps, named rather than smoothed over.**

- **The gating canary's needle floor is 8 characters; synthesis's own is 4.** `membershipStatus`
  was `ACTIVE` - six - printed under `NOT SEARCHED, and why`. Nothing leaked, because synthesis's
  4-character rule withheld the prose carrying it, but the control that *gates* is the looser one.
  One number is not the fix, and that is measured: at a floor of 4 the gating document pass fails
  with 4 hits, all `MEMBER_FOUND_ACTIVE` - a symbolic code the report deliberately keeps and flags,
  because an observed value cannot be substituted into a code and leave a legal one. Exempt a
  flagged `SCREAMING_SNAKE` token first, then drop the floor.
- **The canary's own report republishes what it quoted.** Excerpts blank all *known* values, and
  "known" means known to that pass; the recording pass searches for the caller's argument alone, so
  a hit straddling the results row prints the member's name and balance into `canary/report.txt`.
  Every byte is a quotation of `transcript.json`, where the row legitimately lives, so nothing new
  reaches the bundle - what is violated is the rule that file states about itself, in the document a
  reviewer reads to decide whether to trust the others. The fix is a blank-list separate from the
  needle-list, which means another live run.
- **A promoted detector is only as good as the corpus it was proven against**, and the corpus is
  mine. The proof's claim is exactly "fires on these captures, silent on those": a screen nobody
  froze is a screen it did not consider, and it cannot tell you the screen *means* "no such member"
  rather than "the search timed out and we rendered an empty grid" - that judgement is the
  reviewer's, recorded in `stableUnderRetryBecause` and signed for. Two further limits are
  structural rather than incidental. The proof does **not** catch a mis-scoped detector on its own
  - relabel the positive to follow it and the proof passes, measured in `promotion.test.ts`; what
  catches it is the run journal's `evidence.captured.stepId`, which the promotion tool reads instead
  of believing the review. And nothing here defends against the reviewer or the approver: a person
  who can write the review, fabricate a consistent capture *and* sign the result is inside the trust
  boundary, and the controls raise the cost of an accident rather than of an attack.
- **A promotion has now been performed end to end**, against the live run's own artifact rather than
  a fixture: `evidence/outcome-promotion/` - six `crr probe --capture-every` runs, `contract@2.0.0`
  + `artifact@2`, a re-verification at grade `full`, and an invocation returning
  `OUTCOME MEMBER_NOT_FOUND` (exit 2) where v1 returned `failed / checkpoint-failed`. Three things
  it exposed, none of them flattering. **The proof refused the reviewer's first attempt**, and the
  reason is a limit of the tool rather than of the detector: a `--capture-every` probe of the run
  that produced the outcome screen freezes that screen *again* at every later step the flow reaches,
  and the copy the reviewer may not designate as a positive is then a negative the detector must be
  silent on and cannot be. The prover was left exactly as it is; the reviewer moved the detector to
  the step the run stops at, and the corpus that passes therefore **excludes that probe**,
  deliberately and visibly. `otherAbnormalAtStep` is `0`: no competing abnormal screen exists at the
  proven step, because all four abnormal probes are caught by the previous step's checkpoint first,
  and the two screens that would test it - a torn repaint, an interstitial the grid shows through -
  were not probed. And `crr link` had never once linked a promoted artifact: it parsed `--tenant`
  and did not pass it, so linker check 29's tenant clause refused every promotion at every tenant.
  One line, and only the first real promotion could have found it. `evidence/artifact/` is untouched
  and its outcome is still `origin: "hand-authored"` - **UNPROVEN**.
- **The live bundle names two content addresses for one artifact.** `verification` is not on
  `ARTIFACT_DIGEST_EXCLUDED_FIELDS`, so writing the stamp moves the digest: the run log says
  `sha256:923ab02f…`, the shipped `synthesized/artifact.json` says `sha256:32e56a6f…`. The file is
  self-consistent and an approval signs the stable one, but `verification.runId` and `at` are
  non-deterministic, so the shipped address is not reproducible from the recording. `verification`
  belongs on that list beside `lifecycle`; the fix moves every committed digest and was not made.
- **"One contract, two surfaces" is not proved.** One artifact across two tenants is (§4). The
  green screen prints the member's name as unlabelled prose and `detect()` emits no node for prose,
  so nothing exists for an `ExtractSpec` to name; rather than publish a contract the terminal cannot
  satisfy, it declares its own, and the heterogeneity test compares the two `activate` steps instead.
- **The spend ledger's mid-run cap has never bound at turn *n***, only at the turn-0 boundary; a $2
  cap over a $0.14 run is not the test that matters. `pnpm preflight` - the command the README tells
  a reviewer to run first - likewise has no automated test.
- **`resume: "continue"` does not exist.** An interstitial arriving *after* a step has acted cannot
  be recovered: `retry-step` re-resolves a target the action already navigated away from. Scenario 25
  pins the wrong behaviour deliberately, so the day the mode lands a test fails.
- **A measured constant was silently reverted.** `stableSamples` was swept to 3, a refactor restored
  the placeholder 2, and nothing failed, because it is applied by a recorder at emission and never by
  a validator. A guard now pins it; the class of gap is not systematically closed.
- **No concurrency story.** A hundred simultaneous invocations against a core sized for forty tellers
  is the first production incident.

**Next, in order.** (1) A blank-list for canary context excerpts, so a pass cannot republish a value
another pass owns, and a `SCREAMING_SNAKE` exemption so the gating floor can drop to 4. (2) `text`
nodes for unlabelled prose in both drivers - one fix, two surfaces: it stops the write flow's
confirmation screen returning no outputs and lets the terminal satisfy the browser's contract, and it
moves node counts the divergence report asserts, so it has a blast radius. (3) A second live run
against a surface I did not build, because until then the first claim in this document stands.
