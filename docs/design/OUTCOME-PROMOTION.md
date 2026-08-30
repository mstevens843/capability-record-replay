# Outcome promotion — the path from `needs-detector` to a trusted business outcome

**Status: BUILT, with three deviations recorded below.** This paragraph is the only edit made to the
document after implementation; everything under it is the design as it was written, kept unamended so
that what was designed and what was built can be compared. `packages/core/src/promotion.ts`,
`packages/core/src/linker.ts` (check 29), `packages/runtime/src/promote.ts` and `crr probe` /
`crr promote` are the implementation; `packages/core/test/promotion.test.ts` and
`packages/runtime/test/promote.test.ts` are the tests.

**Three things did not survive contact.**

1. **§4.1's two-member enum needed a third member, `hand-authored`.** The design assumes an outcome
   either came out of synthesis or came through this path. Every detector in this repository predates
   this path — §0 says so itself about `evidence/artifact/contract.json` — and calling those
   `reviewer-authored` would make check 29 demand a discrimination receipt for them, which could only
   be supplied by fabricating a proof that never ran or by running the green probe §5.3.1 correctly
   observes nobody has. `hand-authored` names the state they are actually in: legal, unproven, and
   printed as `UNPROVEN` by `crr show` and `crr link`. It is the state a capability migrates out of,
   and `crr promote` never writes it.
2. **§6.3 is wrong about which control catches a mis-scoped detector.** The claim is that the proof
   catches it because the positive is bound to a step. Measured: relabel the positive to follow the
   mis-scoped detector and the proof returns `discriminates`, correctly — the predicate really does
   fire on that screen and really is silent on the green one at the other step. What catches it is the
   journal cross-check §5.2 specifies, reading `evidence.captured.stepId` instead of believing the
   review document. The proof refuses only when the review's own claim and the journal disagree, or
   when the positive is genuinely at another step. Both halves are asserted, in the two test files
   named above.
3. **`evidence.captured` needed `phase` as well as `stepId`**, because §5.5's mandatory negative is
   "phase `post`" and nothing else in the journal could say so. `proveDiscrimination` also takes the
   tenant being proven, which §5.1's signature omits and §5.5 and §5.6 both require.

Everything else landed as specified, including the parts nobody has exercised in anger: **no
promotion has been performed against the shipped bundle**, because the green capture at the declared
step that §5.3.1 identifies as the missing screen is still missing.

---

**Original status line, as written before implementation.** Nothing in this document has been
implemented and nothing in it has been measured. Where it names a file or a line of behaviour that exists today, that is a citation;
where it names a field, a check number or a verb, that is work an implementer owes. Section 10 is
the ledger of what becomes false in `REPORT.md` and `docs/SPEC.md` on the day it lands.

**It supersedes nothing.** `docs/SPEC.md` is still the build contract and
`docs/design/OPEN-QUESTIONS-RESOLVED.md` still governs Q1–Q7; this is the resolution of a gap
neither of them addressed, because neither of them asked how a human gets a detector into a
document that refuses to let a model write one.

---

## 0. The gap, precisely

`evidence/discovery-live/synthesized/contract.json` ships with `outcomes: []`. That is not a bug and
it is not an omission. `packages/discovery/src/synthesis/emit.ts` says so at the site it happens
(`contractDraftOf`, ~line 1257):

```text
// EMPTY, deliberately. A business outcome needs a declared detector, and a detector for a
// screen the run never observed would be inferred rather than declared. See `report.ts`.
outcomes: [],
```

and the run carries the refusal forward as a `review`-severity note
(`packages/discovery/src/synthesis/report.ts`, `outcome-candidate-needs-detector`):

```text
the model proposed 1 business outcome(s); no detector was written for any of them, because a
detector for a screen the run never observed is exactly how a false MEMBER_NOT_FOUND is emitted
```

**That refusal is correct and this design does not touch it.** Synthesis must never author business
semantics. What is missing is the other half: `NoteSeverity`'s own doc comment already promises that
`review` "means the artifact exists and cannot be approved until a person has read the note", and
there is today **no mechanism by which a person reading it can do anything about it.** The note is a
dead end. `evidence/artifact/contract.json` declares `MEMBER_NOT_FOUND` only because a human typed
the whole document by hand, outside the lifecycle, with nothing checking the detector at all.

This document specifies the missing edge:

```text
   artifact@v1 (draft, verified full, outcomes = [])
        +  a reviewer-authored declaration          <- section 2
        +  a captured observation of the outcome screen
        =  artifact@v2 (proposed)                   <- section 3
             |
             +-- discrimination proof (pure, frozen corpus)   GATE  <- section 5
             +-- verification replay of the happy path (live) GATE  <- section 3.3
             |
             v
           artifact@v2 (draft) -> approved
```

Two gates, neither trusted alone, and the second one already exists and needs no change.

---

## 1. The rule this whole document is derived from

> BRIEF §3.4 — **recording is not a claim until it replays.**

The system already applies that to the model. `packages/runtime/src/lifecycle.ts` opens with it, and
`packages/runtime/src/verify.ts` is the enforcement: a synthesized artifact is `proposed`, and the
only path to `draft` is `recordVerification`, which is only reachable from a `VerificationReport`
that a real replay produced.

**A reviewer is not exempt from that rule.** A detector is a claim about what a screen means. A
human typing it is exactly as unverified as a model emitting it — more dangerous, in fact, because
the model's output is routed through a refusal and the human's output arrives with the authority of
having been reviewed. So the whole design is one sentence: *the reviewer's detector faces the same
gate the model's flow did, and the gate is stricter because a detector is provable in a way a step
list is not.*

---

## 2. Decision 1 — the review document is an **input**, not a fourth document

### 2.1 The decision

A reviewer authors one file, `promotion.json`. It is consumed once, at promotion time, and leaves
**no third artefact in the runtime path**. Everything it says ends up in exactly two places:

| what the review document carries | where it lands |
|---|---|
| the `OutcomeDecl` (code, title, summary, payload, `stableUnderRetry`, `callerAction`, `retryable`, `agentGuidance`) | `contract@v2.outcomes[]` |
| the detector (`atStep`, `detect`, `priority`, `phase`, `requiresSettled`, `capture`) | `artifact@v2.flow.steps[atStep].outcomes[]` |
| any new vocabulary tokens the detector needs | `artifact@v2.flow.vocabulary` |
| the evidence it was authored from, the reviewer, the justification | `artifact@v2.promotions[]` (a **receipt**, §3.4) and the archived input under `evidence/promotions/` |

**Rejected: a fourth document type beside `contract` / `artifact` / `overlay`.** SPEC §0.4 is "three
documents, three readers", and a fourth document has no fourth reader — at runtime the linker,
interpreter and classifier read the detector off `artifact.flow.steps[].outcomes[]` and would never
open a `promotion` document at all. Keeping it live would mean two stored copies of one detector and
a linker that has to decide which of them wins, which is precisely the version skew SPEC §1.2
refuses `@crr/schema` in order to avoid ("a version skew between a validator and its only
consumer").

**Rejected: an overlay-borne detector.** `packages/core/src/overlay.ts` has no `outcomes` slot and
says why at line 174 — an outcome a caller has never heard of, at one institution only, is worse
than a contract bump. A per-tenant promotion path would reintroduce it through the back door.

### 2.2 The trade-off, in one sentence

An input leaves the runtime with one source of truth for every detector, at the cost that the review
document is not content-addressed *by the runtime*: the binding runs one way only, from
`artifact.promotions[].reviewDigest` to bytes archived in `evidence/promotions/`, so if those bytes
are lost the receipt names a document nobody can read.

### 2.3 The shape

```jsonc
{
  "schemaVersion": "capability.promotion/v1",
  "promotes": {                     // which artifact this review is against
    "capability": "corebank.member.find",
    "contractVersion": "1.0.0",
    "artifactDigest": "sha256:…"    // artifact@v1's own digest, exactly
  },
  "reviewedBy": "approver-handle",  // an identity handle, not a mailbox — matches ApproveOptions.approvedBy
  "reviewedAt": "2026-…",           // NOT digested; see §3.4

  "outcome": {                      // becomes contract@v2.outcomes[n], minus `origin`
    "code": "MEMBER_NOT_FOUND",
    "kind": "business_outcome",
    "title": "No member with that number",
    "summary": "The core system holds no member with the number supplied.",
    "terminal": true,
    "payload": [],
    "stableUnderRetry": true,
    "stableUnderRetryBecause":      // REVIEW DOCUMENT ONLY — see §2.4
      "the core holding no such member is a fact about the record; the next attempt with the same number returns the same answer",
    "callerAction": "retry-different-input",
    "retryable": "with_different_inputs",
    "agentGuidance": "Tell the member that number is not on file and ask them to read it again…"
  },

  "detector": {                     // becomes artifact@v2.flow.steps[atStep].outcomes[n], minus `code`/`origin`
    "atStep": "submit-search",
    "priority": 10,
    "phase": "post",                // z.literal("post") — unchanged
    "requiresSettled": true,        // z.literal(true) — unchanged
    "capture": [],
    "detect": {                     // the SAME declared-predicate language, unchanged
      "kind": "text-present",
      "scope": { "path": [{ "kind": "frame", "name": { "mode": "exact", "value": "content", "normalize": "std.text@1" } }] },
      "text": { "mode": "token", "token": "not-found-banner", "normalize": "std.label@1" }
    }
  },

  "vocabulary": {                   // merged into artifact@v2.flow.vocabulary; additive only
    "not-found-banner": ["No members matched the search criteria"]
  },

  "evidence": {
    "positives": [                  // >= 1. Content addresses, plus the run that produced them.
      { "observation": "sha256:…", "fromRun": "run_…", "atStep": "submit-search",
        "tenantId": "riverbend", "appInstanceId": "riverbend-fixture" }
    ],
    "corpusRefs": ["evidence/discovery-live/verification-evidence", "evidence/probe-not-found/observations"]
  }
}
```

**The detector is written in the language the artifact already uses.** `BoundedPredicateSchema` from
`packages/core/src/matchers.ts`, `SafeTextMatcherSchema` from `packages/core/src/text-safety.ts`, the
same `ContainerMatcher` scope, the same `NodeQuery`, the same `MAX_PREDICATE_DEPTH = 4`. There is no
second predicate language and there must never be one — the four criteria that decided the first
one's membership (diffable, reviewable by a non-engineer, cost-bounded, renderable into prose) are
*more* important for a human-authored detector, not less, because this one is not backed by a
recording. The reviewer therefore inherits every refusal for free: no regex, no stylesheet selector,
no path expression, no URL, no node id, no member number, no matcher that constrains only its scope.

### 2.4 `stableUnderRetryBecause` lives on the review document and nowhere else

OPEN-QUESTIONS Q1's addendum asks for "a one-line `stableUnderRetry: true` assertion authored by
whoever declared it", and today the field is a bare `z.literal(true)` that costs nothing to type. The
justification is added here, to the review document, and is **not** promoted onto the contract: the
contract is what a calling agent reads, and a rationale for a taxonomy decision is not routing
information (`packages/runtime/src/tools.ts`, `describeCapability`, assembles "reviewed fields and
NOTHING ELSE"). `crr approve` prints it, resolved through `reviewDigest`, so the approver reads the
claim at the moment they accept it.

Trade-off: the justification is one dereference away from the document it justifies, which is worth
it because the alternative puts un-routing prose into the one document whose entire discipline is
that it contains only what a router needs.

---

## 3. Decision 2 — promotion is a **revision**, and re-verification means two different things

### 3.1 What is produced

`artifact@v1 (draft)` + `promotion.json` → **`contract@v2` and `artifact@v2 (proposed)`**.

Nothing is mutated. Specifically:

- **Contract version bumps MAJOR**: `1.0.0` → `2.0.0`. `packages/core/src/contract.ts` says an
  outcome code is "public API a caller switches on. Renaming one is a breaking change, and the
  shouting is a reminder of that." Adding one is the same kind of change from the caller's side: an
  exhaustive `switch (r.outcome)` that compiled yesterday does not compile tomorrow. A MINOR bump
  would leave a pinned caller (`ContractPin`, linker check 4) silently entitled to receive an arm its
  generated types have never heard of, which is the exact failure SPEC §2.6's pin exists to prevent.
- **Artifact version bumps**: `version: 2`, `lifecycle.supersedes: 1`. Both fields already exist.
- **`artifact@v2.lifecycle.status = "proposed"`**, `approval: null`, `signatures: []`.
- `artifact@v2.implements.contractDigest` names `contract@v2`.
- `artifact@v1` is left exactly where it is. It is still a valid, verified, approvable draft that
  answers `ok | failed` and never `MEMBER_NOT_FOUND` — which is a *true* description of a program
  with no detector, and a deployment that has not finished its review is better served by it than by
  a half-promoted v2.

**Rejected: patching artifact@v1 in place.** `recordVerification` already refuses to re-verify an
approved artifact ("re-verifying an approved artifact would change the digest its approval signs,
which is the same thing as revoking the approval; verify the next version instead"), and the same
argument applies one step earlier: a draft's digest is the address a reviewer has been reading and an
approver may be about to sign. Editing it in place makes "which program did I approve" a question
about timing.

### 3.2 Why it must re-verify, and why that is not a formality

The naive objection is that promotion touches no step, no target and no instruction, so the happy
path cannot have changed and re-running it is theatre. **It is not, and the reason is the single
most important thing in this section.**

`packages/core/src/classify.ts` evaluates band **B3 (declared business outcomes) before band B5 (the
checkpoint)**, and B3 is terminal. A detector that matches something present on the *successful*
search-results screen therefore does not produce a wrong-looking run — it produces a confident,
green-looking `outcome` arm on a run that in fact succeeded, and the caller is told
`MEMBER_NOT_FOUND` about a member who exists. **Adding a detector to a step changes the meaning of
every successful run through that step.** That is precisely why the flow has to be replayed again.

### 3.3 What re-verification *is*, given the outcome screen is not on the happy path

Three obligations. Two are gates. One is evidence and must never be a gate.

**V1 — the happy-path replay. A gate. Already implemented; needs no change.**
`verifyArtifact(artifact@v2)` in `packages/runtime/src/verify.ts`, mode chosen by
`chooseVerificationMode` exactly as before, grade read off the run by `gradeVerification`. If the new
detector fires anywhere on the happy path, `replay()` returns the `outcome` arm, and
`gradeVerification` fails closed on it with the reason it already carries:

```text
the replay returned the business outcome MEMBER_NOT_FOUND at step submit-search; the recording
reached the end of the flow, so the surface no longer holds the state it was recorded against
```

`grade` is `null`, `verification` is `null`, `verifyAndDraft` returns `artifact: null`, and v2 stays
`proposed` for ever. **The existing engine already refuses a hijacking detector, with no new code at
all**, and it refuses it in a live session against a real driver with real settle timing — which the
pure proof of §5 cannot do. The two gates are not redundant; they fail differently.

**V2 — the discrimination proof. A gate. New, pure, over frozen observations.** Section 5.

**V3 — the probe re-run. Evidence, never a gate.** After promotion, re-run the condition that
produced the positive observation, now linked against v2, and confirm the run returns
`outcome: MEMBER_NOT_FOUND` at the declared step. Recorded on the receipt as `probeConfirmed`.

**It cannot be a gate, for two independent reasons.** First, `gradeVerification` deliberately refuses
to grade a run that returned an outcome, and reversing that for this one case would mean an artifact
could reach `draft` without its happy path ever having replayed — the exact hole §3.2 is about.
Second, and more operationally: our fixture can be made to produce `not-found` on cue and a real core
banking system cannot be made to produce every condition on demand. This is the same asymmetry
`EnvironmentReset` names in `verify.ts` ("OUR FIXTURE HAS ONE AND REAL CORE BANKING DOES NOT, and
that asymmetry is the honest operational cost of the whole design rather than a gap in it"), and the
answer is the same: report it, do not pretend it is universally available.

Trade-off: making V3 evidence rather than a gate means a promotion can ship whose detector has never
fired in a live session — which is tolerable only because V2 proves it fires on a real captured
screen, and is the reason `probeConfirmed: false` is printed at approval time rather than hidden.

### 3.4 The receipt

`artifact@v2` gains a top-level `promotions` array, one entry per reviewer-authored outcome:

```jsonc
"promotions": [{
  "code": "MEMBER_NOT_FOUND",
  "atStep": "submit-search",
  "reviewDigest": "sha256:…",        // over the canonical JSON of promotion.json
  "reviewedBy": "approver-handle",
  "supersedesArtifactVersion": 1,
  "proof": {
    "verdict": "discriminates",      // z.literal — a receipt for a failed proof is unrepresentable
    "proverVersion": "crr-prover/1",
    "positives": [{ "observation": "sha256:…", "atStep": "submit-search" }],
    "negatives": {
      "corpusDigest": "sha256:…",    // over the sorted list of member observation digests
      "total": 41,
      "happyPathAtStep": 6,
      "otherAbnormalAtStep": 2,
      "otherSteps": 33
    },
    "provenAt": ["riverbend", "summit"]
  },
  "probeConfirmed": true
}]
```

**`verdict` is `z.literal("discriminates")`.** There is no representation for a promotion that did
not prove out, for the same reason `Verification` has no "record that it failed" path and
`OutcomeDecl.stableUnderRetry` is `z.literal(true)`: the failure case leaves the previous document
exactly where it was, and `PromotionReport` carries the reason for a human to read.

**The receipt is inside the artifact digest, and it contains no clock and no run id.** It is
digested because an approver must sign *this program with this proof*, and `lifecycle` is the only
mutable-state field excluded (`packages/core/src/documents.ts`,
`ARTIFACT_DIGEST_EXCLUDED_FIELDS`). It excludes timestamps and run ids **deliberately**, and this is
a decision made in direct response to a gap the submission already names: REPORT §7 records that
`verification.runId` and `at` are non-deterministic, so the shipped artifact's content address is not
reproducible from the recording. `promotions` does not repeat that mistake — every field in it is
either a content address, an identity, or a count, so **artifact@v2's digest is reproducible from
promotion.json plus the observation corpus.** The non-reproducible facts (when, which run) live in
the archived review document and the probe journal, both reachable by `reviewDigest`.

---

## 4. Decision 3 — provenance is structural, not documentary

### 4.1 The field

`origin: z.enum(["synthesized", "reviewer-authored"])` on **both** halves of an outcome:

- `OutcomeDecl` in `packages/core/src/contract.ts` — required, no default;
- `OutcomeRule` in `packages/core/src/artifact.ts` — required, no default.

Required-with-no-default is doing real work here and is house rule 3 of `artifact.ts`: "NO FIELD HAS
A PARSE-TIME DEFAULT. The artifact is content-addressed and an approval signature is taken over that
address; a schema that filled in `stableSamples: 2` on parse would give the same file two digests
depending on which side of the validator you stood on." An `origin` with a default would be an
`origin` that can be silently absent, and both containing objects are `strictObject`s, so the field
can neither be omitted nor smuggled in under another name.

`"synthesized"` is **unreachable today** — `emit.ts` emits `outcomes: []` and a contract test should
assert it stays that way. It is in the enum anyway, and that is the decision: the day synthesis
learns to derive a detector from an outcome screen the discovery run *itself* observed (which is
reachable — `DiscoveryRun.observations` holds every screen the model saw), the distinction has to
already exist in the type and in every stored document. Adding the member later means every artifact
written before that day is `origin: undefined`, and a provenance field with a hole in its history is
a provenance field nobody can rely on.

Trade-off: an enum member nothing can currently produce is dead weight in exchange for never having
to backfill provenance across signed documents.

### 4.2 How the linker makes it impossible to lose

Four mechanisms, in increasing order of what they cost an attacker:

1. **Parse.** Required field on a `strictObject`. A document that drops it does not parse, so it
   cannot be stored, linked, verified or approved.
2. **Digest.** `origin` is inside both digests. Changing `reviewer-authored` to `synthesized` after
   approval breaks the signature three ways — `checkArtifactIntegrity` in `lifecycle.ts` reports all
   three in one pass.
3. **Linker check 8, extended.** `checkOutcomes` today closes the outcome vocabulary in both
   directions (`outcome-undeclared`, `outcome-unreachable`). It gains a third finding,
   `outcome-origin-mismatch`: for every code, the `OutcomeDecl.origin` and every matching
   `OutcomeRule.origin` must be equal. A contract that claims a detector was derived while the
   artifact says a human wrote it is a link error, not a warning.
4. **New linker check 29, `outcome-unproven`.** Every `OutcomeRule` with
   `origin: "reviewer-authored"` must be named by a `promotions[]` entry whose `code` and `atStep`
   match, whose `proof.verdict` is present, and — in `mode: "replay"` only — whose `proof.provenAt`
   contains the tenant being linked. In `discovery` and `verification` mode the tenant clause is
   skipped, exactly as check 27 skips the approval requirement in `verification` mode, because
   otherwise the first promotion could never be verified at all.

Check 29 is what makes §5.5's tenant scoping enforceable rather than advisory, and it is the reason
this design adds a numbered check rather than a save-time invariant: the interesting failure is a
*stored, signed* artifact linked at a tenant nobody proved it at, and only the linker sees that.

### 4.3 What the contract renderer shows a calling agent: **nothing**

`describeCapability` and `catalogEntryOf` in `packages/runtime/src/tools.ts` are **unchanged**.
`renderForAgent` in `packages/runtime/src/agent-view.ts` is **unchanged**. The `origin` never reaches
a model, and neither does it reach the `ReplayResultDocument`'s outcome arm.

The argument is `agent-view.ts`'s own, applied one field further: a model handed a pedigree will
start weighing outcomes by it — treating a human-authored `MEMBER_NOT_FOUND` as softer than a derived
one, or the reverse — and that is a routing decision nobody reviewed, made by the component with the
least context. An outcome is either in the contract or it is not; "in the contract, but by a human"
is not a third state a caller is entitled to act on, because the entire point of the approval gate is
to make that distinction *already resolved* by the time a caller sees the code.

Where it **is** shown: `crr show` (the reviewer's and security reviewer's view, which already prints
the program), the `link` report, the journal's `run.started`/`classified` lines, and `crr approve`,
which now requires the approver to tick the promoted codes by hand:

```
--ack-promotions MEMBER_NOT_FOUND
```

refused on mismatch, exactly as `acknowledgedGrade` and `acknowledgedEffects` are refused today in
`approve()`. `lifecycle.approval` gains `acknowledgedPromotions: readonly OutcomeCode[]`.

Trade-off: a caller loses the ability to treat a human-authored outcome as lower-confidence, which is
the treatment the approval gate exists to make unnecessary — if the pedigree still matters at the
call site, the approval did not do its job.

---

## 5. Decision 4 — THE CENTRAL MECHANISM: a detector must be **proven to discriminate**

A reviewer-authored detector is not trusted because a human typed it. It is trusted because it
**fires on a captured observation of the outcome screen and is silent on every other observation the
system has recorded.** That is the mutant meta-test's logic
(`packages/conformance/src/engines/mutants.ts`, `packages/conformance/test/suite-discriminates.test.ts`)
turned on detectors: a suite that cannot tell a good engine from a subtly wrong one has proved
nothing, and a detector that cannot tell the outcome screen from every other screen has detected
nothing.

### 5.1 The proof

A **pure function in `@crr/core`**. No clock, no I/O, no randomness, no driver import — it must live
in the package the purity contract test guards, because a proof that needed a browser could not be
re-run by a reviewer, by CI, or by the postmortem six months later.

```ts
proveDiscrimination(input: {
  detect: Predicate;            // the candidate detector
  atStep: StepId;
  positives: readonly CorpusEntry[];
  negatives: readonly CorpusEntry[];
  facts: ProgramFacts;          // from the linked program: vocabulary, branding tokens, routes
  bindings: ResolvedBindings;   // the same bindings the linker produced
}): ProofResult
```

Every evaluation is `evaluatePredicate(detect, { observation, program: facts, bindings })` — the
**same function the classifier calls** (`packages/core/src/evaluate.ts`, used by `bandB3` in
`classify.ts`). Not a re-implementation. If the proof and the runtime could disagree about what a
predicate means, the proof would be worthless, and the only way to guarantee they cannot is to make
it the same call.

`ProofResult` has four arms:

| verdict | condition | consequence |
|---|---|---|
| `discriminates` | fires on **every** positive, silent on **every** negative | the only verdict that permits a receipt |
| `does-not-fire` | silent on some positive | refuse; name the observation digest |
| `over-fires` | fires on some negative | refuse; name the observation digest and the step it was captured at |
| `corpus-too-thin` | the minimum corpus (§5.4) is not met | refuse; say which class is missing |

`over-fires` carries a sub-class, because one negative matters more than all the others:
**`fires-on-happy-path`** when the offending negative was captured on a run that reached `ok`. That
is not a stronger warning, it is a different bug — it means shipping this detector converts every
successful run through that step into a false `MEMBER_NOT_FOUND`, and the report says so in those
words rather than printing a digest.

There is no `warn` arm and no override flag. A gate with a bypass is not a gate.

### 5.2 Where the positive observation legitimately comes from

**It is perceived, never written.** Three legitimate sources, in ascending order of strength:

1. **A production capture.** `packages/runtime/src/evidence.ts` exists for exactly this: SPEC §2.6
   puts an `observationRef` on the failed arm and calls it "the file that turns a production failure
   into a `classify()` unit test with no reproduction step". A real run that hit an unclassified
   screen and returned `failed` has already frozen it, content-addressed and redacted. A reviewer
   promoting from that capture is the strongest case there is, and the proof below runs on it
   unchanged. **This is the intended steady state**: the failure taxonomy is how you find out an
   outcome exists, and the promotion path is how you close it.
2. **A promotion probe run.** A real replay of the real artifact, through the real driver, the real
   settle gate, the real policy chokepoint and `redactObservation`, against a real application
   instance in the condition. **For `MEMBER_NOT_FOUND` this needs no fault injection at all** — it
   needs a member number that is not on file, which every institution can produce. Where a condition
   cannot be produced by argument alone, the environment arms it: our fixture's
   `fixtures/corebank-web/src/faults.js` arms `not-found` sticky at the `results` screen against one
   `CBSESSIONID`, which is a per-session hook that exists precisely because BRIEF §4 observes that a
   public demo site cannot be made to deny an entitlement on cue.
3. **The discovery run's own observations.** `DiscoveryRun.observations` holds every screen the model
   perceived. If the model happened to search for a number the core did not hold, the screen is
   already in the recording.

**This is not fabrication and the distinction is precise:** in all three cases nobody authored the
observation. It came out of `Surface.perceive()`, through the driver's own normalization, with the
driver's own `skeletonDigest` and `stability` on it. The reviewer chooses *which capture is the
outcome*; they do not get to say *what the screen said*.

**What is refused as a source:** a hand-written JSON observation. The review document names the
positive by content address and by the run it came from, and the promotion tool re-derives the digest
from bytes on disk and cross-checks the run's journal that this digest was captured **at the declared
step**. That last check needs one schema change: `evidence.captured` in
`packages/core/src/journal.ts` carries `ref`, `kind` and `maskedRegions` but **no `stepId`**, so the
binding from observation to step is positional today. Add `stepId`. A security-relevant binding
inferred from line ordering is exactly the quiet wrongness this repository refuses everywhere else.

**Be honest about what that stops.** A reviewer with commit access can fabricate a consistent
observation *and* a consistent journal. The digest check raises forgery from "edit one line" to
"fabricate an internally consistent run", and the control that actually stands behind it is that the
receipt is inside a digest an identified approver signs. This design does not claim to defend against
the approver.

### 5.3 What the negative corpus is

Every frozen `Observation` the system holds for this `(capability, surfaceKind, tenant)`, minus the
designated positives. Concretely, four sources, and the third is the sharpest:

1. **A green probe of artifact@v1** — a successful replay run with `--capture-every`. Every step,
   phase `post`, on a run that reached `ok`. This is the corpus's spine, and §5.3.1 below is why it
   has to be produced on purpose rather than found lying around.
2. **The discovery run** — `DiscoveryRun.observations`, every screen the model saw while it was
   figuring the flow out.
3. **The condition probe's *other* observations.** Every screen from the same session, the same
   tenant, the same branding, the same member, differing from the positive only in the condition.
   These are the negatives that catch a detector keyed on the branding band, the frame name, the nav
   menu or the institution's name — because those are all present on the positive too, and only a
   same-session negative can tell "the not-found banner" from "anything on a Riverbend page".
4. **Existing evidence bundles for that tenant** — `evidence/replay-0*/observations/`.

Cross-tenant observations are admitted as negatives (a detector must be silent at Summit too) but
never satisfy the minimum on their own, per §5.5.

#### 5.3.1 What the repository actually holds today, and why `--capture-every` is not optional

Every step of both shipped artifacts declares `evidence.captureOn: ["failure"]` — the hand-authored
`submit-search` adds `"outcome"` and nothing anywhere declares `"always"`. `#captureIf` in
`packages/runtime/src/interpreter.ts` therefore freezes an observation only when a run goes wrong, so
**a green run writes no observations at all.** The committed corpus is:

| bundle | observations |
|---|---|
| `evidence/replay-01-green/observations/` | **none** (journal blob only) |
| `evidence/replay-02-outcome-member-not-found/observations/` | 1 — the not-found screen |
| `evidence/replay-03-recovered-interstitial/observations/` | **none** (the run recovered) |
| `evidence/replay-04-failed-app-error/observations/` | 1 |
| `evidence/replay-05-failed-session-expired/observations/` | 1 |
| `evidence/discovery-live/verification-evidence/` | **none** — the verification replay passed |

So the one thing §5.5 makes mandatory — a happy-path negative at the declared step — **is the one
thing the repository does not have**, precisely because the system only keeps screens from runs that
failed. That is not an argument for relaxing the minimum; it is the argument for `crr probe
--capture-every`, and it is why the workflow in §7 runs *two* probes: one in the condition, and one
green.

Trade-off, stated where it will be read: `captureOn: ["failure"]` is the right default for
production, because freezing every screen of every run writes regulated data to disk at a rate nobody
wants, and the promotion path is the one place that trade is worth reversing — deliberately, for one
run, against a synthetic member, into a directory the redaction canary covers.

**Corpus identity is a digest over the sorted member observation digests** (`corpusDigest` on the
receipt), so "proven against which corpus" is answerable years later and a corpus that grew after the
proof is visibly a different corpus.

One measured caveat, taken from `evidence.ts`'s own header rather than assumed: content addressing
deduplicates *within* a browser session and **not across** sessions, because a `UINode` id embeds a
CDP per-document counter — the same application-error screen produced four different digests across
five `pnpm demo` runs. So `negatives.total` overcounts near-duplicates and must be read as "how many
observations", never as "how many distinct screens". The receipt's `negativesByClass` breakdown is
the number worth reading.

### 5.4 What happens when a detector fires on the happy path

It is **refused**, twice, by two mechanisms that fail differently:

- at promotion, by the proof, as `over-fires / fires-on-happy-path`, naming the observation and the
  step, with no document written;
- at verification, by `gradeVerification` in `verify.ts` (§3.3), in a live session, with v2 left
  `proposed` for ever.

Neither is trusted alone. The proof can only see screens somebody froze; the replay can only see the
one path it walks. A detector keyed on a value that is stable in the corpus and varies at runtime is
caught by the second and not the first; a detector keyed on a screen the happy path never reaches is
caught by the first and not the second.

### 5.5 What happens when the corpus is too thin to decide

**The proof refuses.** `corpus-too-thin` is a refusal, not a warning, and no receipt is written.

The minimum, and it is deliberately small:

- `|positives| >= 1`;
- **`negatives` contains at least one observation captured at the same step, phase `post`, on a run
  that reached `ok`** — at the tenant being proven.

That second clause is the whole minimum and it is not negotiable: without a happy-path negative at
the declared step, "fires on the outcome screen" is unfalsifiable at the only place it matters. It is
always *obtainable* — artifact@v1 could not have become a draft without a verification replay that
passed through that step successfully, so the screen exists and can be re-perceived — but per §5.3.1
it is never already *stored*, because that run succeeded and a successful run freezes nothing.

**No other threshold is enforced, and no number is invented.** OPEN-QUESTIONS Q4 settles this
precedent for `needsSpecialization` — "Measure it; ship no number… Inventing a number and defending
it in the write-up would be exactly the kind of unearned precision this repo does not do" — and the
same rule governs here. Everything else is *reported* on the receipt as `negativesByClass`: how many
happy-path negatives at the step, how many other abnormal screens at the step (a session-expired
banner, an app-error banner), how many at other steps, how many at other tenants. A promotion proven
against six happy-path negatives and zero other-abnormal negatives at the step is a promotion nobody
has shown can tell "no member found" from "the server threw", and the approver reads that fact rather
than a threshold's opinion of it.

### 5.6 The proof runs once per tenant, and the promotion is scoped to the tenants it was proven at

A detector uses a `token` matcher; a token resolves through `flow.vocabulary`, which an overlay
overrides per tenant (REPORT §4: "one artifact replays green on both fixture tenants through a
12-token vocabulary overlay"). So `not-found-banner` is *different text* at Riverbend and Summit, and
a proof at one says nothing about the other. The proof therefore runs against the **merged** program
for each `(tenant, overlay)` pair, and `proof.provenAt` records the tenants that passed. Linker check
29 refuses, in `mode: "replay"`, to link an artifact carrying a reviewer-authored outcome at a tenant
`provenAt` does not name.

Trade-off, and it is a real operational cost: onboarding a new tenant to a capability with a promoted
outcome now requires a probe and a re-proof at that tenant, rather than being a pure overlay change —
which is the price of never shipping a detector that is silent at the institution nobody tested.

---

## 6. Decision 5 — the failure modes this is built against

Four attacks, and where each dies. In every case a reviewer with commit access and approver
credentials is out of scope (§5.2); these are the mistakes a competent, well-intentioned reviewer
actually makes.

### 6.1 A detector that matches the empty string

The naive form is already unrepresentable: every text arm of `TextMatcherSchema` in
`packages/core/src/primitives.ts` is `z.string().min(1)`, and `NodeQuerySchema` in `matchers.ts`
refuses a query that constrains only its scope — "a node query must constrain something about the
node - a scope alone matches every node in the container" — for the reason its doc comment gives,
which is that "a detector that is trivially true is a machine for emitting a business outcome that
was never observed."

The form that *survives* today is a matcher whose **normalized** value is empty: `{ mode: "exact",
value: "  ", normalize: "std.text@1" }` passes `min(1)` and matches everything under containment.
Two catches, and the design wants both:

- a **static triviality lint** at parse: reject a matcher whose value normalizes to the empty string,
  and reject `{ kind: "count", op: "gte", n: 0 }`, which is true on every observation because `n` is
  `nonnegative()`;
- the **proof**, which is the general answer: a trivially-true detector fires on every negative and
  comes back `over-fires / fires-on-happy-path` on the first one it hits.

### 6.2 A detector matching a substring present on every screen

The institution's name, the frame name, the nav menu, the footer, "Riverbend Credit Union". This is
the one the schema cannot catch, because the string is a perfectly legitimate piece of surface
vocabulary — it is *where* it appears that is wrong.

**Killed by the negative corpus, and specifically by §5.3's third source.** The probe's own
same-session negatives carry the identical branding, identical chrome and identical member, so a
detector keyed on any of it fires on them and the proof returns `over-fires` naming the screen. The
branding case has a second, partial defence that already exists: `ProgramFacts.brandingTokens` feeds
the normalizer context in `evaluate.ts`, so the branding-stripping normalizers remove the most common
instance before matching — partial, because it only covers tokens somebody declared.

### 6.3 A detector scoped to a step where the condition is impossible

`MEMBER_NOT_FOUND` declared on `fill-member-id`, before the search has been dispatched.

Linker check 8 does **not** catch this: it proves the code is reachable from *some* step, not that the
step is plausible. OPEN-QUESTIONS Q2 chose per-step scoping precisely to catch "MEMBER_NOT_FOUND was
detected at a step where it is impossible", and check 8's `outcome-unreachable` is the mitigation for
the *cost* of scoping, not the enforcement of its benefit.

**The proof is the enforcement, and the mechanism is that the positive is bound to a step.** The
review document names `atStep`, the promotion tool verifies against the probe journal that the
positive observation was captured at that step (§5.2, which is why `evidence.captured` needs
`stepId`), and the proof evaluates the detector only against observations captured there. A
mis-scoped detector therefore has **no positive at all** and returns `does-not-fire`. There is no
path where a reviewer can move the positive to follow a mis-scoped detector, because the journal says
where the screen was captured and the reviewer does not write the journal.

One class of mis-scoping is already refused before the proof runs: linker check 25 forbids a step
whose checkpoint expects a dialog to be open from declaring any outcome at all — "a terminal business
outcome read off the screen behind a modal is history."

### 6.4 A detector that fires on the *wrong abnormal* screen

Not in the brief's list but it is the one that worries me most: a detector that fires on both the
not-found banner and the app-error banner, because both are red boxes in the same frame. It returns
`MEMBER_NOT_FOUND` for a 500 — a *stable* answer about a *transient* system fact, which is Q1's rule
inverted and is worse than either arm alone.

Caught only if the corpus holds an abnormal-but-different observation **at that step**. The
repository has two candidates already frozen — `evidence/replay-04-failed-app-error/observations/`
and `evidence/replay-05-failed-session-expired/observations/`, one each — and whether either was
captured at the step a given detector is scoped to is a fact the proof reports rather than assumes.
When the count is zero the proof still passes, and the receipt records `otherAbnormalAtStep: 0` — the
gap is **reported and not smoothed over**, per §5.5, and the approver decides. Naming a hole in the
control is worth more than a threshold that pretends there isn't one.

---

## 7. The workflow, end to end

A person can follow this list. Nothing in it is automated across a step boundary, deliberately: every
transition is somebody deciding something.

1. **Read the note.** `evidence/discovery-live/synthesized/report.json` carries
   `outcome-candidate-needs-detector` at severity `review` and, next to it, the model's scrubbed
   candidate — a code and two sentences. The candidate is a *prompt to a human*, never an input to
   the machine, and nothing downstream reads it.
2. **Obtain the screen (the positive).** Either find a production `failed` run whose
   `observationRef` is the screen (best), or run a condition probe:
   `crr probe <contract@v1> <artifact@v1> --surface <m> --args '{"memberId":"00000"}' --capture-every --evidence evidence/probe-not-found/`
   using a member number the core does not hold. Where the condition cannot be produced by argument
   alone, arm it in the environment first (for our fixture, `_fault=not-found`).
3. **Obtain the happy path (the negatives).** Run the *same* probe with an argument that succeeds:
   `crr probe … --args '{"memberId":"10041"}' --capture-every --evidence evidence/probe-green/`.
   This step is not optional and is easy to skip, because a green run normally freezes nothing
   (§5.3.1) — so the observation the proof most needs is the one nobody has. Run it at every tenant
   the promotion will name.
4. **Identify the positive.** Read the condition probe's journal, find the `evidence.captured` line
   at the step in question, take its ref. `crr probe` prints the step-to-digest table so this is one
   line of reading, not a JSON hunt.
5. **Write `promotion.json`** (§2.3): the outcome declaration, the detector in the artifact's own
   predicate language, any new vocabulary token, the positive's digest, and the corpus directories.
6. **Iterate against the proof, writing nothing:**
   `crr promote <contract@v1> <artifact@v1> --review promotion.json --corpus <dirs…> --dry-run`
   prints the proof table — every positive with fires/silent, every negative class with counts, and
   for a refusal the exact observation and step. This is where a detector gets fixed, and it costs no
   session and no document.
7. **Promote.** The same command without `--dry-run`, plus `--tenant riverbend --tenant summit`,
   writes `contract@2.0.0` and `artifact@v2 (proposed)` and archives the review document to
   `evidence/promotions/<reviewDigest>.json`. It refuses if the proof does not return
   `discriminates` at every named tenant.
8. **Verify.** `crr verify <contract@v2> <artifact@v2> --surface <m> --out artifact-v2.json` — the
   existing command, unchanged, replaying the **happy path**. If the new detector hijacks it, this
   fails and v2 stays `proposed` (§3.3).
9. **Confirm the probe (evidence, not a gate).** Re-run step 2's condition against v2 and check the
   run returns the outcome. `crr promote --confirm <artifact@v2> --result <result.json>` stamps
   `probeConfirmed`. If it is skipped, `probeConfirmed` is `false` and approval says so.
10. **Approve.** `crr approve artifact-v2.json --sign-key … --approver … --ack-grade full
   --ack-effects READ --ack-promotions MEMBER_NOT_FOUND`. The approver ticks the promoted codes by
   hand; `approve()` refuses on mismatch, exactly as it does for the grade and the effects today.
   The command prints `stableUnderRetryBecause` and `probeConfirmed` from the archived review, so the
   claim and the gap are both in front of the person signing.
11. **Republish the contract.** Callers pinned to `1.0.0` keep working against artifact@v1; callers
    that want the outcome regenerate their tool definitions against `2.0.0` and get a new arm in
    their `switch`.

### 7.1 CLI surface implied

| verb | new? | what it does |
|---|---|---|
| `crr probe` | **new** | `crr replay` with `--capture-every`: forces `putObservation` at every step regardless of the step's declared `evidence.captureOn`, and prints a step-to-digest table. Changes no decision and spends no budget. |
| `crr promote` | **new** | runs the discrimination proof and, only if it returns `discriminates`, emits `contract@vN+1` and `artifact@vN+1 (proposed)`. `--dry-run` prints and writes nothing. `--confirm` stamps `probeConfirmed`. |
| `crr verify` | unchanged | |
| `crr approve` | `--ack-promotions` | ticks the reviewer-authored codes; prints the review's justification and `probeConfirmed`. |
| `crr show` | extended | prints each outcome's `origin` and its receipt. |
| `crr link` | extended | reports check 29. |

`--capture-every` is a **runtime option on `replay()`**, not an artifact edit. `evidence.captureOn`
is a recording policy inside the digest; overriding it from the CLI must not move the program's
content address, and it does not, because it never touches the document. Trade-off: a probe writes
many more observations of member data to disk, which is why the probe's evidence directory is subject
to the same `redactObservation` path and the same redaction canary as every other bundle, and why the
probe should be run with an obviously synthetic member.

`crr promote` reaches no model. Neither does `crr probe`. The whole promotion path runs with zero
credentials, which is the same property the rest of the replay path already has.

---

## 8. The implementer's checklist

Schema (`@crr/core`):

- `contract.ts` — `OutcomeDeclSchema` gains `origin`.
- `artifact.ts` — `OutcomeRuleSchema` gains `origin`; new `PromotionReceiptSchema`; artifact gains
  `promotions: z.array(PromotionReceiptSchema).max(32).readonly()`; `LifecycleSchema.approval` gains
  `acknowledgedPromotions`.
- `text-safety.ts` / `primitives.ts` — the triviality lint of §6.1 (normalized-empty matcher,
  `count/gte/0`).
- `journal.ts` — `evidence.captured` gains `stepId`.
- **new** `promotion.ts` — the review-document schema and `proveDiscrimination`, pure.
- `linker.ts` — `checkOutcomes` gains `outcome-origin-mismatch`; **new check 29**
  `outcome-unproven`; `LINK_CHECK_COUNT` 28 → 29.

Runtime (`@crr/runtime`):

- `replay.ts` / `interpreter.ts` — `captureEvery` option threading into `#captureIf`.
- **new** `promote.ts` — read the review, resolve the corpus, run the proof, emit v2, archive.
- `lifecycle.ts` — `approve()` checks `acknowledgedPromotions` against the artifact's receipts.
- `cli.ts` — `probe`, `promote`, and the new `approve` / `show` output.

Tests the implementer owes, in the shape this repo already uses:

- one test per new linker check, with a fixture that must fail it and one that must pass —
  `packages/core/test/linker.test.ts` line 924 asserts every check number `1..LINK_CHECK_COUNT` is
  covered, so bumping the constant without a test **fails an existing test**;
- a proof test per failure mode of §6, each asserting the *verdict and the named observation*, both
  ways — the pattern `heterogeneity.test.ts` uses for its mutant survivors;
- a test that a detector proven to discriminate, injected onto the happy path's step, is refused by
  `gradeVerification` — the §3.3 gate, asserted rather than assumed;
- a contract test that `emit.ts` never emits `origin: "synthesized"`, so §4.1's dead enum member
  stays dead until somebody deliberately revives it.

---

## 9. What this does **not** establish

- **A promoted outcome is only as good as the corpus it was proven against.** The proof's claim is
  exactly "fires on these captures, silent on those" and nothing larger. A screen nobody froze is a
  screen the proof did not consider, and the most likely such screen is the one that arrives after
  the next vendor upgrade.
- **A fixture-captured screen is not a production screen.** Our not-found banner reads "No members
  matched the search criteria" because I wrote that string. A real Symitar-class core will render
  something else, in a different frame, possibly with a code rather than a sentence, and possibly
  differently per institution. A promotion proven against `fixtures/corebank-web` proves the
  *mechanism*, not the detector — this is REPORT's first bullet ("the target application is my own
  fixture") applied to the one place where it bites hardest, because a detector is the artefact most
  specific to the real surface.
- **The proof does not prove the taxonomy.** It proves a predicate discriminates between screens. It
  cannot tell you that the screen *means* "no such member" rather than "your search timed out and we
  rendered an empty grid" — that is the reviewer's judgement, recorded in
  `stableUnderRetryBecause` and signed for, and it is exactly the kind of judgement Q1 exists to
  discipline rather than to automate.
- **`negatives.total` is not a count of distinct screens.** Content addressing deduplicates within a
  browser session and not across sessions (§5.3, measured and already documented in `evidence.ts`),
  so a corpus of 41 observations may hold rather fewer distinct screens.
- **Nothing here defends against the reviewer or the approver.** A person who can write the review
  document, fabricate a consistent capture and sign the result is inside the trust boundary. The
  controls raise the cost of an accident, not of an attack.
- **The `synthesized` origin is unreachable and untested against reality.** The enum member exists so
  that provenance never has to be backfilled; no code produces it, and no claim is made about what
  synthesized detectors would look like.
- **Nothing in this document has been run.** It is a design. The measured claims it cites — the
  cross-session digest instability, the two-tenant vocabulary overlay, the mutant kill matrix — are
  measurements the repository already made and recorded; the mechanism described here has made none
  of its own.

---

## 10. What lands false when this is built

Flagged now so nobody has to notice later:

- **`docs/SPEC.md` §1.1** — the production box said "LINK … 28 checks". Check 29 made that number
  wrong. **Resolved 2026-08-30:** current `docs/SPEC.md` says 29 in §1.1, §10 and §11.
- **`docs/SPEC.md` §0.4 and §2.3** — "three documents, three readers" stays true (§2.1 is why), but
  the sentence "the contract carries outcome *names* and their payload types" acquires `origin`, and
  the `strictObject` argument in `contract.ts`'s header now has a second field to explain.
- **`REPORT.md` §7** — "**No outcome detectors are synthesized.** … `contract.outcomes` comes out
  `[]`" stays true and becomes *incomplete*: the cut is still real for synthesis, but the sentence
  currently reads as though `[]` is the end of the story, and after this it is the beginning of one.
  The write-up needs the second half — that a human can promote one, and what the promotion has to
  prove.
- **`REPORT.md` §2** — the three-document table gains no row (§2.1), but the artifact's "Contains"
  cell gains the promotion receipt.
- **`REPORT.md`'s claims table** — "1,921 tests" changes. Every number in that table must come from a
  command that was actually run, so it gets re-run, not adjusted.
- **`evidence/discovery-live/`** — untouched. It is the record of a run that happened, and a
  promotion performed later against it does not retroactively change what the model produced. The
  promoted documents belong in a **new** directory beside it, with their own README saying which
  parts a model produced and which parts a person did.
