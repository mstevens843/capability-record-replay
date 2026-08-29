# REPORT — `capability-record-replay`

A model drives a legacy back-office application once. What it learned becomes a typed, versioned,
content-addressed capability document. Everything after that is a deterministic interpreter with no
model anywhere in the decision path.

**What is *not* proven, first.**

- **The target application is my own fixture.** It cannot surprise me the way a real vendor product
  would, and that is the main threat to every robustness number below. A 0.0% flake rate over a
  corpus I wrote bounds hidden state in the engine, not flake in production.
- **One live discovery run**, nine turns, one surface — and no live model has ever been refused by
  the policy gate, got stuck, or raised an intervention. Those paths have hermetic tests only.
- **Desktop (AX/UIA) is a documented seam, not code**, and **approval signs an ed25519 digest and
  stops** — no key custody, identity, expiry or revocation.

| Claim | Result | Command / receipt |
|---|---|---|
| Builds and passes with **zero credentials** | **1,843 tests**, 8 members, exit 0 | `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN pnpm test` |
| A real model reached a real goal | `claude-opus-5`, 9 turns, 42,368 billed tokens, **$0.14** | `evidence/discovery-live/provenance.json` |
| Its artifact replayed with the model out of the loop | `full`, `proposed → draft`, canary passes 1–3 CLEAN | `evidence/discovery-live/verification.json` |
| Replay tells a good engine from a broken one | reference engine **0 false successes**; **9/9 mutants killed**, 13 of the 17 kills false successes | `pnpm -F @crr/conformance stability` |
| A reviewer can run it with no key | 65 files, whole-bundle canary CLEAN, exit 0 | `pnpm demo` |

---

## 1. Architecture

There is **one seam**: a `Surface` port. `perceive(): Observation` returns a normalized tree of typed
`UINode`s — role, accessible name, value, state, bounds, container path — and `act(Action, lease)`
takes a closed set of typed actions. Nothing above that port knows what a browser or a pixel is.

The package line is drawn on **purity**: `@crr/core` cannot do I/O, read a clock or generate a random
number. That is not a comment — contract tests read the repository off disk and fail on core
impurity, on CSS/XPath vocabulary or a driver import above the drivers, and on any `Surface.act` call
site not immediately preceded by a policy `check`. **Each was verified by injecting a real violation
and watching it fail.**

**The discovery loop is hand-written against the Messages API, not an SDK helper**: every tool call
must pass the policy chokepoint and be journaled. `disable_parallel_tool_use: true`, because a
computer-use loop must observe the consequence of each action before choosing the next. Every run
records its transcript to a VCR fixture a `replay` adapter serves back — which is why `pnpm test`
passes with no credentials.

The live run took three attempts; the README has both failures. Two things belong here. **At least
one turn was billed that this repository's ledger recorded as $0.00** — attempt 2 threw parsing a
response the provider had already produced, and the arithmetic cannot see a turn it failed to parse,
so the provider's console is the authority. And that attempt left the cache warm: the successful run
pays **zero cache-write tokens** on all nine turns, so its 55.4% hit rate is a warm-start figure.

## 2. Artifact schema

**Three documents, three readers.**

| Document | Reader | Contains |
|---|---|---|
| `contract` | the calling agent, the product owner | typed `inputs`/`outputs`, outcome *names*, `whenToUse`/`whenNotToUse`, effect class. **Zero surface detail.** |
| `artifact` | the interpreter, the security reviewer | the program: routes, vocabulary, steps, descriptors, checkpoints, detectors, budgets, effect summary. |
| `overlay` | the linker, per tenant | additive, non-semantic overrides only. |

**Detectors live on the artifact's steps, never on the contract.** That is what lets one contract be
implemented by two programs: "how you tell that this screen means *no such member*" is a property of
a surface; "the caller may receive `MEMBER_NOT_FOUND`" is not.

**The artifact stores shapes, never values.** A value from the goal is bound as a typed parameter,
routes canonicalize (`/member/12345` → `/member/:memberId`), and detector text uses template holes.
One mechanism is both the reuse story — a capability, not a macro — and the primary PII control (§6).
The live contract offers `memberId: {kind:"string", charset:"digits"}`; the member number the model
typed is nowhere in it, and the parameter's *name* came from the label anchor the locator itself
uses, not from the model and not from the value's shape.

The artifact is **data, not code**: a non-Turing-complete DSL, canonical-JSON digested, approval
signing over the digest. Playwright output is a *secondary export* — generated code cannot be diffed
by a non-programmer, linked against an overlay, or refused by a linker.

## 3. Determinism & error handling

**Replay is a classifier with an actuator attached**, and the step list is the easy part. `classify`
is a **pure total function from a frozen `Observation` to a `Verdict`**, so the entire error taxonomy
is unit-testable from snapshots with no browser running.

Two rules do most of the work. **Fail closed toward `failed`**: promotion to a business outcome
requires an explicit declared detector, never string similarity, because a false `MEMBER_NOT_FOUND`
is the worst thing this system can emit. And **"not yet" is not "not so"**: no negative outcome may
be classified against a surface that has not demonstrably settled. Each step declares `expect` (a
checkpoint), `outcomes` (business results with detectors) and `recoveries` (bounded remedies with
budgets); outcomes and recoveries are evaluated *before* the checkpoint, and anything else is a hard
failure naming the step, the expectation and the observation. Four arms:
`ok | outcome | suspended | failed`.

The model **never authors a locator**: it picks a node id from the observation it was shown, and
deterministic code derives independently computed descriptors (role+name, label-anchored, table
row/column relative to a header, ordinal-within-landmark, geometric) that resolve separately on
replay and are compared. **Disagreement is a detected condition, never a fallback chain** — a
fallback chain is a machine for turning an ambiguity into a confident wrong click.

```text
$ pnpm -F @crr/conformance stability   # lines verbatim; blank lines, rules, 8 matrix rows elided
25 scenarios: 25 passed, 0 failed, 0 FALSE SUCCESSES
kill matrix: 9 mutants x 25 scenarios
mutant            killed by                          of which false successes
nearestMatch      04,06,08,09,15,21                  04,06,08,09,15,21
every mutant was killed by at least one scenario
```

The mutants are the **real `replay()`** — same linker, lease, budgets, journal — with exactly one
pure decision function swapped through an injection seam, enforced by function identity, not stubs.
**17 kills, 13 of them false successes**: the mutant told a caller `ok`, or a business outcome, for a
broken run. The suite was itself checked — deleting scenario 21 produced `SURVIVORS: noContinuity`.
Drift is the secondary concern the assignment says it is; an abstaining descriptor is a signal on a
successful run, never a verdict.

## 4. Heterogeneity & multi-tenant

I will not assert that the abstraction generalizes. Here is what happened when I built a second
surface: an 80×24 green screen over `@xterm/headless`, which is what a Symitar-class teller app is.

The 25-scenario browser corpus kills all nine mutants; the 14-scenario green-screen corpus kills
five, and **one of the four survivors is the most useful result in the repository.** `noSettleGate` —
the mutant that classifies against a screen the driver called unsettled — is *indistinguishable from
the reference engine* there, because a green screen's readiness signal is silence and a torn repaint
is silent: the driver reports `settled: true` on a half-painted frame, so no observation exists where
the flag is false and a verdict hangs on it. **On that surface the settle gate cannot be the gate,
which is why the checkpoint has to be.** Each survivor's reason is a property of the surface and is
asserted in both directions by the test.

Multi-tenant is **base artifact + per-tenant overlay**, overrides only: vocabulary tokens, route base
paths, wait budgets, extra recoveries. One artifact replays green on both fixture tenants through a
12-token vocabulary overlay with **no step override, no detector, no instruction and no outcome**;
without it the run fails `target-underdetermined` and names the descriptor that abstained. The
vocabulary token is the hinge: "Member ID" at one institution and "Member Number" at another is a
*labelling* difference, and labelling differences must not require a new program. On the terminal the
same artifact makes the driver write `\x1bOR` (F3) at one tenant and `\x1b[24~` (F12) at the other
while containing no F-key. Each resolution records a fingerprint, and drift is reported (33.8%
Jaccard between the two) rather than absorbed. Overlays **cannot add outcomes**: an outcome a caller
has never heard of, at one institution only, is worse than a contract bump. The cross-*surface* half
is not proved — §7.

## 5. Escalation & handoff

**Control is a lease, not a pause.** A session has exactly one controller under a lease with a
monotonic epoch; the executor **rejects** an action presented without the current token and epoch,
and `Surface.act` rejects it again at the driver. Two gates, because the interesting failure is an
automation run that believes it still holds a session a human has taken.

"Stuck" is a decided property of the failure class, not a heuristic. A verdict carries a
`SuspensionReason` only where a person at a terminal could plausibly finish the job — seven of them
(`unclassified-state`, `recovery-exhausted`, `approval-required`, `target-ambiguous`,
`target-underdetermined`, `session-lost`, `effect-in-doubt`). A bad artifact, an invalid argument or
a policy denial is **never** escalatable: a human at the app cannot fix those by clicking. A test
asserts a decision for *every* failure class, so a new one cannot arrive undecided.

The operator console is server-rendered HTML with no build step: claim the lease at epoch+1, render
`Surface.capture()` (masked PNG, or masked grid dump for the terminal), inject typed `Action`s **into
the same live session** — policy-checked like any automation action and journaled by *title*, never
by value, with the operator's id — then hand back, or abort.

Hand-back is where most designs put a TODO. Resume is not "continue at pc": re-acquire at epoch+1,
re-`perceive`, re-classify at `phase:"pre"`, re-verify the precondition, re-verify continuity,
re-check the effect gate, then re-run the step from the top. The acceptance cases are the refusals —
`escalation.test.ts`, **31 tests**, among them *refuses when the human navigated away*. **Mocked:**
the console polls captures rather than streaming them (production wants CDP screencast), and the
operator in the tests is a harness; the lease, both enforcement points, the policy check on the
human's action and the seven-step resume are real.

## 6. Safety

**One chokepoint**: every action — discovery, replay, operator console — passes through one pure
`check(action, ctx)` over lease, allowlisted origin and canonicalized route, action kind, both effect
ceilings, approval state and taint sink, first refusal winning. It is not a package, because a
package boundary does not make something the *only* chokepoint; the contract test does. **Effect
classes** `READ | WRITE_REVERSIBLE | WRITE_IRREVERSIBLE`: irreversible requires an approval token *by
the type*, forbids retries and restarts across it, and turns unobserved dispatch into an
auto-escalation. **A taint model**: a `sensitive` parameter yields a handle at bind time, and the
handle — never the value — reaches the policy engine, the journal, the trace and every capture.

A safety section listing no failures is not credible. Three real leaks were caught by these controls
and none by reading the code: `deriveOutputs` folded a table cell's accessible name into the query it
derived, and on a legacy grid a cell's accessible name *is* the value, so a member's name and balance
reached `flow.vocabulary` — the one document that is committed, diffed and signed; `std.text@1`
case-folded every delivered string output; and on the live run the canary caught the synthesis
*report* quoting the results row the model had read. `artifact.json` and `contract.json` were CLEAN
throughout, so parameterization held on the signed documents, but free-form prose about observed data
cannot be redacted, only withheld, and now it is. Parameterization could not have caught the first
one — the name was never in the goal, so it was never bound to anything. The README has each in
full, plus the canary's one instructive false positive.

**Limits.** `effect` is *declared, never proven* — a step marked `READ` that posts an audit row is
invisible to the chokepoint, the restart gate and the approval blast radius alike. The PII lint is
shape-based and will both miss and over-trigger. The canary that gates the build has a length floor
synthesis does not share (§7). And fail-closed decays toward "everything is a hard failure" if nobody
staffs the review that adds rules.

## 7. Cuts

**Cut deliberately.**

- **No branching, no loops, no conditionals.** Steps are a straight line; the only branch is a
  terminal outcome. With an `if`, "which steps are irreversible" and "what blast radius is a human
  signing" both become *"depending"*, and a signature over a digest stops meaning anything precise. A
  flow needing a branch is two capabilities composed by the calling agent. **The trigger to
  revisit**: an "accept terms" interstitial is modelled today as a *recovery*, which abuses the
  concept. On the second one, the fix is an `optional-step` marker with a declared skip predicate,
  not general branching.
- **No outcome detectors are synthesized.** The model's candidates ride in the synthesis report with
  a `needs-detector` note and `contract.outcomes` comes out `[]`. A generated detector for a screen
  the run never observed is how a false `MEMBER_NOT_FOUND` ships.
- **No routing prose is generated.** `whenToUse`/`whenNotToUse` are hand-authored or stamped
  `NEEDS AN AUTHOR`. Models mis-route far more often than they mis-fill arguments.
- **No queue, database, auth service, admin SPA, or desktop driver.** The anti-goals are explicit.

**Gaps, named rather than smoothed over.**

- **The gating canary's needle floor is 8 characters; synthesis's own is 4.** On the live run
  `membershipStatus` was `ACTIVE`, six characters, and `canary/report.txt` prints it under
  `NOT SEARCHED, and why`. Nothing leaked, because synthesis's 4-character rule withheld the prose
  carrying it — but the control that *gates the build* is the looser of the two. Both floors are
  judgement calls; they should be one judgement.
- **`provenance.json` is covered by no gating canary pass.** Its writer was fixed to withhold the
  model's observed-output prose, but a fifth pass was not added because it could not be tested
  without spending another live run. It is scanned for credential shapes only.
- **The live bundle names two content addresses for one artifact.** `verification` is not on
  `ARTIFACT_DIGEST_EXCLUDED_FIELDS`, so writing the verification stamp moves the digest: the run log
  says `sha256:923ab02f…`, the shipped `synthesized/artifact.json` says `sha256:32e56a6f…`. The file
  on disk is self-consistent and an approval signs the stable one, but `verification.runId` and `at`
  are non-deterministic, so the shipped artifact's address is not reproducible from the recording.
  `verification` belongs on the excluded list beside `lifecycle`; that fix moves every committed
  digest, and was not made here.
- **"One contract, two surfaces" is not proved.** One artifact across two tenants is (§4). The green
  screen prints the member's name as unlabelled prose and `detect()` emits no node for prose, so
  there is nothing for an `ExtractSpec` to name; rather than publish a contract the terminal cannot
  satisfy, it declares its own, and the heterogeneity test compares the two `activate` steps field by
  field instead.
- **No live run has exercised the spend ledger's mid-run cap binding at turn *n***, only the turn-0
  boundary; a $2 cap over a $0.14 run is not the test that matters. `pnpm preflight` — the command
  the README tells a reviewer to run first — likewise has no automated test.
- **`resume: "continue"` does not exist.** An interstitial arriving *after* a step has acted cannot
  be recovered: `retry-step` re-resolves a target the action already navigated away from. Scenario 25
  pins the wrong behaviour deliberately and says so in its title, so the day the mode lands a test
  fails.
- **A measured constant was silently reverted.** `stableSamples` was swept to 3, a refactor restored
  the placeholder 2, and nothing failed, because it is applied by a recorder at emission and never by
  a validator. A guard now pins it to the sweep; the class of gap is not systematically closed.
- **No concurrency story.** A hundred simultaneous invocations against a legacy core sized for forty
  tellers is the first production incident.

**Next, in order.** (1) The fifth canary pass over `provenance.json`, gated, with a planted-needle
self-test like the other four, and one needle floor rather than two. (2) `text` nodes for unlabelled
prose in both drivers — one fix, two surfaces: it stops the write flow's confirmation screen
returning no outputs and lets the terminal satisfy the browser's contract, and it moves node counts
the divergence report asserts, so it has a blast radius rather than being a one-liner. (3) A second
live run against a surface I did not build, because until then the first claim in this document
stands.
