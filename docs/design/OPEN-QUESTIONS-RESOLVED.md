# Resolutions to SPEC §13

The spec correctly refused to decide these alone. Resolved here by the author. Implementation agents
must follow these; `docs/SPEC.md` §13 is superseded by this file.

---

## Q1. Is `MEMBER_RESTRICTED` an outcome or a failure? → **Outcome.**

The spec was right, but for a weaker reason than the one that should govern. The deciding rule, which
generalizes to every future capability and is the thing to state in REPORT §3:

> **An outcome is a fact about the request or the record that will still be true on the next
> attempt. A failure is a fact about the system that might not be.**

"This member's account is restricted" is stable under retry — replaying the capability a second time
produces the same answer, and it is an answer, not an absence of one. "The session expired" is not:
it is a property of this attempt. That rule places `MEMBER_NOT_FOUND`, `MEMBER_RESTRICTED` and
`ACCOUNT_CLOSED` on the outcome side and every transport, timeout, permission-of-the-*automation*,
and resolution condition on the failure side, without anyone having to relitigate each one.

The spec's counter-argument — that the agent's next move is a human handoff either way — is a fact
about *this* caller, not about the result. A batch reconciliation caller does something entirely
different with `MEMBER_RESTRICTED` than a live chat turn does, and that is exactly why the
distinction belongs in the result and not in the caller's reaction to it.

**Note the asymmetry deliberately**: a permission denial that is a fact about the *record* is an
outcome; a permission denial that is a fact about the *automation's own session* is
`failed / policy-denied`. The classifier must be able to tell these apart, and if a detector cannot,
it fails closed to `failed` per SPEC §0.2.

## Q2. Per-step outcome scoping, or global? → **Per-step, as the spec ships.**

Scoping catches "MEMBER_NOT_FOUND was detected at a step where it is impossible", which is a real
artifact bug and exactly the class of silent wrongness this system exists to prevent. The maintenance
cost is real but bounded, and the failure mode the spec worried about — a scoping mistake silently
disabling a detector — is mitigated by linker check: **every declared outcome must be reachable from
at least one step, or the artifact fails to link.** Add that as a linker check if it is not already
among the 28.

## Q3. Is the no-branching cut too aggressive? → **Keep it for v1. Name it as a cut.**

No branching is what buys the static effect analysis, `restartSafeUpToPc`, and the dry-run
verification mode — all load-bearing, all things the assignment's §3.3 and §3.4 grade directly. A
straight-line program is also the reason a human reviewer can read an artifact and know what it will
do, which is the "reviewable" requirement in assignment §3.2.

The optional-interstitial case is handled as a **recovery**, which the language already has. The spec
calls that "a slight abuse of the concept" and it is, mildly — but a recovery is precisely "a
condition that may or may not appear, with a bounded remedy", which is what an optional terms screen
is.

**Write this up in REPORT §7 as a named cut, with the trigger for revisiting it**: if real flows turn
out to need a genuine either/or, the answer is `skipIf` guarded to a single declared predicate over
the current observation — a deliberate language change, not something added under pressure.

## Q4. Divergence threshold for `needsSpecialization`? → **Measure it; ship no number.**

Correct as flagged. The threshold is tuned against the conformance corpus in build unit 19/22. Until
there is a measurement, the field is reported and **no threshold is enforced** — the report says what
diverged and by how much, and a human decides. Inventing a number and defending it in the write-up
would be exactly the kind of unearned precision this repo does not do.

## Q5. Approval key custody and rotation? → **Out of scope. Name the limit.**

The spec signs the digest with ed25519 and stops. That is the right place to stop for this project.
REPORT §6 must state plainly: *approval is only as strong as the custody of the signing key, and this
implementation has no custody story — a production deployment needs a KMS or HSM, an approver
identity, and a revocation path for a compromised key.* Naming the limit is worth more than a
half-built key manager.

## Q6. `SettlePolicy.stableSamples` = 2 or 3? → **Placeholder 2; decided by measurement.**

As flagged. The slow-load and torn-read conformance scenarios decide it in unit 17. Whatever the
corpus says, the README records the command that produced the number.

## Q7. `agentDisclosure` on the output or the caller? → **On the output, as the spec ships.**

One person reviewing one contract should decide once what a model may see. The counter-argument —
that a batch reconciliation caller has different needs than a chat turn — is real, and the answer is
that such a caller should invoke with an explicit, policy-checked elevation, not that every caller
should get to choose its own disclosure by default. Safe default, explicit escalation. Note the
tension in REPORT §6 rather than hiding it.

---

## One addition not in §13

**Adopt the Q1 rule as a linter, not just a doctrine.** The artifact validator should require every
`OutcomeDecl` to carry a one-line `stableUnderRetry: true` assertion authored by whoever declared it.
It is cheap, it forces the author through the rule, and a reviewer reading the contract sees the
claim being made. If someone declares a transient condition as an outcome, the claim is at least
visible and wrong rather than invisible and wrong.
