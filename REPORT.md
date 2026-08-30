# REPORT - `capability-record-replay`

## 1. Architecture

The system uses an LLM once, during discovery, to operate a legacy back-office UI and produce a
recording. Production execution is a deterministic interpreter over a typed capability artifact; no
model is in the replay decision path.

The load-bearing seam is `Surface`: drivers expose `perceive(): Observation` and
`act(Action, lease)`. Everything above that seam sees normalized `UINode`s, typed actions, a lease,
an allowlist, and a journal. Browser and terminal drivers are surface-specific, but replay results
share one contract: `ok | outcome | suspended | failed`.

The repo includes one live LLM discovery run in `evidence/discovery-live/`; all reviewer commands in
`docs/FINAL-REVIEWER-GUIDE.md` run without provider credentials. The local fixture limitation is
real: the main target is a synthetic CoreBank-style app, so the evidence proves the architecture and
failure handling, not vendor diversity in the wild.

## 2. Artifact schema

Artifacts are data, not generated executable code. The contract names typed inputs, typed outputs,
business outcome codes, effects, and caller guidance. The artifact contains surface-specific steps,
descriptors, checkpoints, recoveries, outcome detectors, budgets, provenance, and lifecycle approval.
Per-tenant overlays carry non-semantic overrides only.

The model does not author final business semantics. `MEMBER_NOT_FOUND` and `MEMBER_RESTRICTED` are
reviewer-authored and proven with frozen observations before promotion. Detectors live on the
artifact, not the contract, so one contract can be implemented by surface-specific artifacts without
guessing from screen text.

Inputs are typed and tainted. The artifact stores parameter shapes and template holes, not caller
values. Evidence canaries scan for supplied member IDs and write inputs after generation.

## 3. Determinism & error handling

Replay is model-free. Each step re-perceives, classifies, resolves targets from independent
descriptors, checks policy, acts, then verifies checkpoints and declared outcomes. Locator
disagreement is a refusal, not a fallback chain.

Expected business outcomes are separate from failures. `MEMBER_NOT_FOUND` and `MEMBER_RESTRICTED`
return typed `outcome` results; role-scoped permission denial remains `failed /
entitlement-denied`. Post-dispatch uncertainty is not retried away: an irreversible dispatch followed
by failed observation returns `effect-in-doubt` and requires reconciliation.

The conformance package mutates the replay engine and proves the corpus catches false successes. The
browser corpus kills all nine mutants; the terminal survivor exhibit preserves the honest green-screen
limit where four mutants are observationally indistinguishable on that surface.

## 4. Heterogeneity & multi-tenant

The final claim is not browser-terminal parity. It is narrower and stronger: one deterministic
runtime supports surface-specific artifacts under a shared typed result model.

Browser support is exercised against a frameset-era fixture with hostile markup. Terminal support is
exercised through a green-screen fixture and terminal conformance corpus. Desktop automation is
design-only in `docs/design/DESKTOP-AUTOMATION.md`; there is no verified AX/UIA driver.

Multi-tenant reuse is base artifact plus overlay. `evidence/multi-tenant-overlay/` shows the base
browser artifact running at Riverbend, the same artifact running at Summit through an overlay, and a
no-overlay Summit invocation failing before execution. The overlay changes vocabulary, route base
paths, and settle budgets; it does not add steps, instructions, effects, extractors, or outcomes.

## 5. Escalation & handoff

Human handoff is implemented as a control-plane lease, not a UI-only pause. A stuck run raises an
intervention with capability, goal template, step, reason, observed state, evidence reference, tenant,
app instance, session, and resume token. A human claims the same live session under a new lease epoch.
Stale automation is refused before dispatch; direct stale-token port refusal is covered by the
runtime test. The human action still passes the policy chokepoint.

Handback does not continue blindly. The runtime re-acquires the lease, re-perceives the current
screen, re-classifies, re-checks the step precondition, verifies continuity, re-checks the effect
gate, and re-runs the suspended step from the top. `evidence/handoff/` includes a successful
handoff/resume and a refused handback where the operator navigated away and replay stopped with
`precondition-not-met`.

The operator console is intentionally minimal: server-rendered, polling, no SSO, no production
co-browsing stream. The lease, policy check, journal attribution, masked capture seam, and resume
precheck are real.

## 6. Safety

Policy and approval are separate gates. Policy enforces lease holder, origin/route/action allowlists,
effect ceiling, artifact lifecycle, and taint restrictions. Invocation approval authorizes a specific
irreversible execution at the dispatch boundary.

`WRITE_IRREVERSIBLE` requires scoped invocation approval covering artifact digest, contract digest,
effect ceiling, signer/key identity, authority, tenant, app instance, policy version, expiry, args
hash, and idempotency key. Rejections are typed and journaled. Evidence covers wrong artifact digest,
wrong contract digest, expiry, tenant/app mismatch, policy version mismatch, insufficient ceiling,
untrusted signer, revoked key, revoked approval id, args hash mismatch, idempotency mismatch, and
reversible approval attempting to authorize irreversible write.

External KMS/HSM custody is not implemented. The repo has a signer seam and local ed25519 helper for
tests and evidence; production would replace that with enterprise custody.

## 7. Cuts

The project deliberately does not implement full desktop automation, production co-browsing, SSO,
durable intervention storage, a distributed idempotency store, queues, real bank connectivity, or
external KMS/HSM signing.

The live discovery evidence is one successful model run against one local fixture, plus hermetic
tests and deterministic replay evidence. Browser write confirmation outputs are limited by fixture
surface extraction, so the write-boundary exhibit proves dispatch/no-dispatch and fixture state
rather than rich typed commit output.

Start with `docs/FINAL-REVIEWER-GUIDE.md`, then `docs/REQUIREMENT-TRACE.md`. The deeper historical
report content was preserved in `docs/design/REPORT-DEEP-DIVE.md`.
