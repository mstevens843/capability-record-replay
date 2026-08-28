# REPORT — `capability-record-replay`

A model drives a legacy back-office application once. What it learned becomes a typed, versioned,
content-addressed capability document. Everything after that is a deterministic interpreter with no
model anywhere in the decision path.

**What is *not* proven, first.**

- **The target application is my own fixture.** It cannot surprise me the way a real vendor product
  would, and that is the main threat to every robustness number below. A 0.0% flake rate over a
  corpus I wrote bounds hidden state in the engine, not flake in production.
- **One live discovery run.** Nine turns, one flow, one surface. An existence proof, not a sample.
- **Desktop (AX/UIA) is a documented seam, not code.**
- **Approval signs a digest with ed25519 and stops.** No key custody, identity, expiry or revocation.

| Claim | Result | Command |
|---|---|---|
| Builds and passes with **zero credentials** | **1,843 tests**, 8 workspace members, exit 0 | `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN pnpm test` |
| A real model reached a real goal | `claude-opus-5`, **9 turns, 42,368 billed tokens, $0.14**, 55.4% cache hits | `evidence/discovery-live/provenance.json` |
| Its artifact replays with the model out of the loop | verified `full`, `proposed → draft`, canary CLEAN | `evidence/discovery-live/verification.json` |
| Replay tells a good engine from a broken one | **25 scenarios × 9 mutants, 0 survivors, 0 false successes** | `pnpm -F @crr/conformance stability` |
| A reviewer can run it with no key | 67 files, canary CLEAN, 0 hits, exit 0 | `pnpm demo` |

---

## 1. Architecture

There is **one seam**: a `Surface` port. `perceive(): Observation` returns a normalized tree of typed
`UINode`s — role, accessible name, value, state, bounds, container path. `act(Action, lease)` takes a
closed set of typed actions. Nothing above that port knows what a browser or a pixel is.

The package line is drawn on **purity**: `@crr/core` holds the schema, the linker, the classifier,
the resolver and the policy predicate, and cannot do I/O, read a clock or generate a random number.
That is not a comment. Contract tests read the repository off disk and fail on core impurity, on
CSS/XPath vocabulary above the drivers, on a driver import above the drivers, and on any
`Surface.act` call site not immediately preceded by a policy `check` on the same action. **Each was
verified by injecting a real violation into a real module and watching it fail.**

**The discovery loop is hand-written against the Messages API, not an SDK helper**: every tool call
must pass the policy chokepoint and be journaled, and I did not want a beta dependency in the
critical path. It sets `disable_parallel_tool_use: true` — a computer-use loop must observe the
consequence of each action before choosing the next, and interleaved actions would make the recorded
step order meaningless. The stable prompt and tool defs are `cache_control`-marked ahead of the
changing observation payload; the run measured **55.4% cache hits**.

Every run records its transcript to a VCR fixture a `replay` adapter serves back, which is why
`pnpm test` passes with no credentials. **The live run took three attempts and the first two cost
$0.00**, both dying at the provider boundary — `Enum value 'Enter' does not match declared type
'['string','null']'` (valid JSON Schema, but a union `type` array plus an `enum` is refused under
`strict: true`), then a `ZodError` from strict-validating the provider's *response* schema, which I
do not own. Both still wrote their transcript and spend ledger and exited non-zero, because the
durability path was built before the run rather than after it.

## 2. Artifact schema

**Three documents, three readers.**

| Document | Reader | Contains |
|---|---|---|
| `contract` | the calling agent, the product owner | typed `inputs`/`outputs`, outcome *names*, `whenToUse`/`whenNotToUse`, effect class. **Zero surface detail.** |
| `artifact` | the interpreter, the security reviewer | the program: routes, vocabulary, steps, descriptors, checkpoints, detectors, budgets, effect summary. |
| `overlay` | the linker, per tenant | additive, non-semantic overrides only. |

**Detectors live on the artifact's steps, never on the contract.** That placement is what lets one
contract be implemented by two programs, a browser one and a green-screen one: "how you tell that
this screen means *no such member*" is a property of a surface; "the caller may receive
`MEMBER_NOT_FOUND`" is not.

**The artifact stores shapes, never values.** A concrete value that came from the goal is bound as a
typed parameter; routes canonicalize (`/member/12345` → `/member/:memberId`); detector text uses
template holes. One mechanism is simultaneously the reuse story — a capability, not a macro — and the
primary PII control (§6). The live contract offers `memberId: {kind:"string", charset:"digits"}` and
`shareBalance: {kind:"money", currency:"USD"}`; the member number the model typed is nowhere in it.
Parameter *names* come from a deterministic chain ending at the label anchor the locator itself uses
— never from a model, and never from the value's shape, which would put a member number in the
caller's public API.

The artifact is **data, not code**: a non-Turing-complete DSL, canonical-JSON digested, approval
signing over the digest. Playwright output is a *secondary export*; generated code cannot be diffed
by a non-programmer, linked against a tenant overlay, or refused by a linker.

## 3. Determinism & error handling

**Replay is a classifier with an actuator attached.** The step list is the easy part. `classify` is a
**pure total function from a frozen `Observation` to a `Verdict`**, so the entire error taxonomy is
unit-testable from snapshots with no browser running — which is why it is worth trusting.

Two rules do most of the work. **Fail closed toward `failed`**: promotion to a business outcome
requires an explicit declared detector, never string similarity or "the page looks empty", because a
false `MEMBER_NOT_FOUND` is the worst thing this system can emit. And **"not yet" is not "not so"**:
no negative outcome may be classified against a surface that has not demonstrably settled. Each step
declares `expect` (a checkpoint), `outcomes` (business results with detectors) and `recoveries`
(bounded remedies with budgets); outcomes and recoveries are evaluated *before* the checkpoint, and
anything else is a hard failure naming the step, the expectation and the observation. The result
contract has four arms: `ok | outcome | suspended | failed`. A confirmation dialog is not an interruption but the
*postcondition of the click that raised it*, so a step declares `expect.dialog` and the interception
band stands down to the checkpoint for that dialog alone.

The model **never authors a locator**. It picks a node id from the observation it was shown, and
deterministic code derives independently computed descriptors (role+name, label-anchored, table
row/column relative to a header, ordinal-within-landmark, geometric). On replay they resolve
separately and are compared. **Disagreement is a detected condition, never a fallback chain** — a
fallback chain is a machine for turning an ambiguity into a confident wrong click.

```
$ pnpm -F @crr/conformance stability
25 scenarios: 25 passed, 0 failed, 0 FALSE SUCCESSES
kill matrix: 9 mutants x 25 scenarios — every mutant killed, 0 survivors      exit 0
```

The mutants are the **real `replay()`** — same linker, lease, budgets, journal — with exactly one
pure decision function swapped through an injection seam, enforced by function identity, so the suite
is not merely telling a real engine from a stub. **17 kills, 13 of them false successes**: the mutant
told a caller `ok`, or a business outcome, for a broken run. `nearestMatch`, the fallback-chain
mutant, is killed by six scenarios and **all six are false successes**. The suite was itself checked:
deleting scenario 21 produced `SURVIVORS: noContinuity`. Drift is the secondary concern the
assignment says it is — an abstaining descriptor is a signal on success, never a verdict.

## 4. Heterogeneity & multi-tenant

I will not assert that the abstraction generalizes. Here is what happened when I built a second
surface — an 80×24 green screen over `@xterm/headless`, which is what a Symitar-class teller app is.

Five of the nine mutants die on the terminal corpus. **Four survive, and one of them is the most
useful result in the repository.** `noSettleGate` — the mutant that classifies against a screen the
driver called unsettled — is *indistinguishable from the reference engine* there, because a green
screen's readiness signal is silence and a torn repaint is silent: the driver reports `settled: true`
on a half-painted frame. There is no observation where the flag is false and a verdict hangs on it.
**On that surface the settle gate cannot be the gate, which is why the checkpoint has to be.**
Quiescence proposes; the checkpoint disposes. The union of both corpora kills all nine: the *suite*
discriminates; the green-screen corpus alone does not, for four reasons each a property of the
surface. Where the port bent is recorded too — `detect()` emits no node for unlabelled prose, so the
terminal declares its own contract rather than publish one it cannot meet.

Multi-tenant is **base artifact + per-tenant overlay**, overrides only: vocabulary tokens, route base
paths, wait budgets, extra recoveries. One artifact replays green on both fixture tenants through a
12-token vocabulary overlay with **no step override, no detector, no instruction and no outcome**;
without it the run fails `target-underdetermined` and names the descriptor that abstained. The
vocabulary token is the hinge — "Member ID" at one institution and "Member Number" at another is a
*labelling* difference, and labelling differences must not require a new program. On the terminal,
one such artifact makes the driver write `\x1bOR` (F3) for one tenant and `\x1b[24~` (F12) for the
other while containing no F-key. Each resolution records a fingerprint, and divergence is reported
(33.8% Jaccard between the fixture tenants) rather than absorbed. Overlays deliberately **cannot add
outcomes**: a caller receiving an outcome it has never heard of, at one institution only, is worse
than a contract bump.

## 5. Escalation & handoff

**Control is a lease, not a pause.** A session has exactly one controller under a lease with a
monotonic epoch, and the executor **rejects** an action presented without the current token and
epoch; `Surface.act` rejects it again at the driver. Two gates, because the interesting failure is an
automation run that believes it still holds a session a human has taken.

"Stuck" is a decided property of the failure class, not a heuristic. A verdict carries a
`SuspensionReason` only where a person at a terminal could plausibly finish the job:
`unclassified-state`, `recovery-exhausted`, `approval-required`, `target-ambiguous`, `session-lost`,
`effect-in-doubt`. A bad artifact, an invalid argument or a policy denial is **never** escalatable —
a human at the app cannot fix those by clicking. A test asserts a decision for *every* failure class,
so a new one cannot arrive undecided, and `effect-in-doubt` escalates whatever the caller asked for:
nobody says "fail and go home" about an irreversible action whose result was never seen.

The operator console is four routes and no build step: claim the lease at epoch+1, render
`Surface.capture()` (masked PNG, or masked grid dump for the terminal), inject typed `Action`s
**into the same live session** — policy-checked like any automation action and journaled by *title*,
never by value, with the operator's id.

Hand-back is where most designs put a TODO. Resume is not "continue at pc": re-acquire at epoch+1,
re-`perceive`, re-classify at `phase:"pre"`, re-verify the precondition, re-verify continuity,
re-check the effect gate, then re-run the step from the top. The acceptance cases are the refusals —
`packages/runtime/test/escalation.test.ts`, **31 tests, re-run here** — among them *refuses when the
human navigated away*, *refuses on continuity when the human left the session on a different member*,
and *terminates on a declared business outcome rather than resuming into it*.

**Mocked:** the console polls captures rather than streaming them (production wants CDP screencast),
and the operator in the tests is a harness. The lease, both enforcement points, the policy check on
the human's action and the seven-step resume are real code.

## 6. Safety

**One chokepoint**: every action — discovery, replay, operator console — passes through one pure
`check(action, ctx)` over lease, allowlisted origin and canonicalized route, action kind, both effect
ceilings, approval state and taint sink, first refusal winning. It is not a package, because a
package boundary does not make something the *only* chokepoint; the contract test does. **Effect
classes** `READ | WRITE_REVERSIBLE | WRITE_IRREVERSIBLE`: irreversible requires an approval token *by
the type*, forbids retries and restarts across it, and turns unobserved dispatch into an
auto-escalation. **A taint model**: a `sensitive` parameter produces a handle at bind time, and the
handle — never the value — is what the policy engine, the journal, the classifier trace and every
capture hold.

A safety section listing no failures is not credible. These checks caught three real leaks, and I
would not have found any of them by reading the code.

1. **A member's name and balance reached a signed document.** `deriveOutputs` folded a table cell's
   accessible name into the query it derived — and on a legacy grid a cell's accessible name *is* the
   value. The artifact carried both in `flow.vocabulary`, the one document that is committed, diffed
   and signed. Parameterization could not have caught it: the name was never in the goal, so it was
   never bound to anything. Found by *executing* what synthesis emits.
2. **Every delivered string output was case-folded**, so a caller would have been read their own name
   back in lower case.
3. **On the live run, the canary caught the model's own prose.** The synthesis *report* quoted the
   results row the model had read, verbatim, member number and balance included. `artifact.json` and
   `contract.json` were CLEAN — parameterization held on the signed documents — but free-form prose
   about observed data cannot be redacted, only withheld, and now it is.

One false positive was a different real bug: 14 reported leaks in `spend.json` were IEEE-754 noise,
`"turnUsd": 0.014200999999999998`. Money was being serialized as a float; it is now rounded to the
microdollar at record time.

**Limits.** `effect` is *declared, never proven* — a step marked `READ` that posts an audit row is
invisible to the chokepoint, the restart gate and the approval blast radius alike. The PII lint is
shape-based and will both miss and over-trigger. And fail-closed decays toward "everything is a hard
failure" if nobody staffs the review that adds rules.

## 7. Cuts

**Cut deliberately.**

- **No branching, no loops, no conditionals.** Steps are a straight line; the only branch is a
  terminal outcome. With an `if`, "which steps are irreversible" and "what blast radius is a human
  signing" both become *"depending"*, and a signature over a digest stops meaning anything precise. A
  flow needing a branch is two capabilities composed by the calling agent. **The trigger to
  revisit**: an optional interstitial that is not really a decision — an "accept terms" screen — is
  modelled today as a *recovery*, which abuses the concept. When a second one appears, the fix is an
  `optional-step` marker with a declared skip predicate — not general branching.
- **No outcome detectors are synthesized.** The model's candidates ride in the synthesis report with
  a `needs-detector` note and `contract.outcomes` comes out `[]`. A generated detector for a screen
  the run never observed is how a false `MEMBER_NOT_FOUND` ships.
- **No routing prose is generated.** `whenToUse`/`whenNotToUse` are hand-authored or stamped
  `NEEDS AN AUTHOR`. Models mis-route far more often than they mis-fill arguments.
- **No queue, database, auth service, admin SPA, or desktop driver.** The anti-goals are explicit.

**Gaps, named rather than smoothed over.**

- **`provenance.json` is covered by no gating canary pass.** Its writer was fixed to withhold the
  model's observed-output prose, but a fifth pass was deliberately not added because it could not be
  tested without spending another live run. It is scanned for credential shapes only.
- **No live run has exercised the spend ledger's mid-run cap binding at turn *n***, only the turn-0
  boundary. A $2 cap over a $0.14 run is not the test that matters.
- **`resume: "continue"` does not exist.** An interstitial arriving *after* a step has acted cannot
  be recovered: `retry-step` re-resolves a target the action already navigated away from. Scenario 25
  pins the wrong behaviour deliberately and says so in its title, so the day the mode lands, a test
  fails.
- **A measured constant was silently reverted.** `stableSamples` was swept to 3, a refactor restored
  the placeholder 2, and nothing failed, because it is applied by a recorder at emission and never by
  a validator. A guard now pins it to the sweep; that whole class of gap is not systematically closed.
- **No concurrency story.** A hundred simultaneous invocations against a legacy core sized for forty
  tellers is the first production incident.

**Next, in order.** (1) The fifth canary pass over `provenance.json`, gated, with a planted-needle
self-test like the other four. (2) `text` nodes for unlabelled prose in both drivers — one fix, two
surfaces: it stops the write flow's confirmation screen returning no outputs and lets the terminal
satisfy the browser's contract. It moves node counts the divergence report asserts, so it is a
decision with a blast radius rather than a one-liner. (3) A second live run against a surface I did
not build, because until then the first claim in this document stands.

