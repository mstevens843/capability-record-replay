# outcome-promotion

**A business outcome, promoted onto the artifact a live model actually produced.**

`evidence/discovery-live/synthesized/contract.json` ships with `outcomes: []` and a `review`-severity
note saying why: synthesis will not write a detector for a screen the run never observed, because a
generated detector can turn an unknown screen into a false `MEMBER_NOT_FOUND`. This directory is the
review path: read the note, capture the screen, write the detector, and prove it before shipping.

Nothing here was produced by a model. `crr` has no discovery verb and reaches no provider; every
command below ran with `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY` and
`CLAUDE_CODE_OAUTH_TOKEN` unset, against `fixtures/corebank-web` on an ephemeral loopback port.

```
$ pnpm build && bash evidence/outcome-promotion/reproduce.sh
```

---

## Who wrote what

Read this before anything else, because it is the only part of this directory that cannot be
re-derived.

| Author | What they produced |
|---|---|
| **The discovery model** (`claude-opus-5`, live, 2026-08-28) | `before/contract.json` and `before/artifact.json` - byte-identical copies of `evidence/discovery-live/synthesized/`. **Nothing else in this directory.** The model proposed a candidate outcome named `MEMBER_FOUND_ACTIVE` and synthesis refused to write a detector for it; that refusal stands, and no part of it was used here. |
| **The reviewer** | `review/promotion.template.json` - the outcome code, the caller-facing prose, the `stableUnderRetryBecause` judgement, the detector predicate, the vocabulary token, and the choice of step. Plus the decisions: which screen is the positive, which member numbers to probe, and which corpus bundles to prove against. |
| **Deterministic code** | Everything else: every observation, journal, result document, console log, the promoted contract and artifact, the promotion receipt, the signatures, and the canary reports. |

**The reviewer here was the coding agent that performed this exercise, working under the
repository author's direction.** It is written into the documents as
`reviewedBy: "reviewer:agent-acting-as-reviewer"` and `approver:agent-acting-as-approver` rather
than as a person's name. Pretending a human signed this would weaken the control this directory is
trying to prove. A real deployment requires a named human in both roles, and the design says so:
`promotion.ts`'s own header records that *"nothing here defends against the reviewer or the
approver: a person who can write the review, fabricate a consistent capture and sign the result is
inside the trust boundary."* That sentence describes this exercise exactly.

What is *not* claimed by that admission: none of the semantics here came out of a model in a
decision loop, none of it was inferred from the recording, and none of it was copied from the
model's candidate. The detector is a `text-present` predicate over one vocabulary token, written in
the artifact's own language, and it had to survive a proof it could have failed - and did fail, the
first time (below).

---

## What happened, in order

Every line below is copied from the file named beside it.

### 0. Before: a legitimate answer, reported as a hard failure

`invocation-before/` - `crr replay` of artifact v1 against a well-formed member number the core
holds no record for.

```text
arm failed - checkpoint-failed at read-membername-sharebalance-membershipstatus     (exit 1)
```

The caller is told the run broke. It did not break: the search ran, the application answered, and
the answer was "no members matched the search criteria". v1 has no detector, so `classify` falls
through band B3, the checkpoint fails, and a fact about the *record* is reported as a fact about the
*system*. That is the mistake OPEN-QUESTIONS Q1 exists to prevent, and it is the state the live
artifact shipped in.

### 1. Capture the outcome screen, honestly

Six `crr probe --capture-every` runs plus the failing replay above. **These are real captures of
real screens** - `Surface.perceive()` through the Playwright/CDP accessibility-tree driver, redacted
by the taint model, content-addressed by the evidence sink. Nobody authored a byte of them.

| bundle | how the screen was produced | frozen |
|---|---|---|
| `probe-green/` | a member the fixture holds (`GREEN_MEMBER=10043`, the member the live discovery run itself used). No fault. Run ends `ok`. | 4 |
| `probe-absent/` | `ABSENT_MEMBER=10099` - five digits, **no record in the fixture's seed data**. No fault injected: this is the application's own empty-result path, `rows.length === 0` in `fixtures/corebank-web/src/server.js`. | 3 |
| `probe-app-error/` | fixture fault `app-error` armed at the results screen - HTTP 500 and a vendor-style unhandled-exception page. | 2 |
| `probe-session-expired/` | fixture fault `session-timeout` armed at the results screen. | 2 |
| `probe-interstitial/` | fixture fault `interstitial` armed at the results screen - a blocking modal over the grid. | 2 |
| `probe-validation-error/` | `MALFORMED_MEMBER=7777` - four digits. The application's own validation banner, no fault injected. | 2 |
| `invocation-before/` | the failing replay above. `captureOn: ["failure"]`, so it froze exactly one screen: the one the run failed on. **This is the positive.** | 1 |

The four abnormal probes exist because the proof is only worth what its negatives are worth. A
detector proven against "the happy path and the outcome" has been shown to tell an answer from a
success and from nothing else. `crr probe` had no way to arm a fault, so
`packages/runtime/demo/surface-entry.mjs` gained a `CRR_DEMO_FAULT` hook - see *Changes to shipped
code* below.

### 2. The reviewer's first attempt, and the prover's refusal

The obvious step for the detector is `activate-search` - it is the step that submits the search, and
it is where the hand-authored example artifact puts the same detector (`submit-search`). The prover
refused (`review/promote-attempt-1-refused.txt`):

```text
proof   riverbend: OVER-FIRES - the detector fires on sha256:c33a647a…, captured at step
        read-membername-sharebalance-membershipstatus on a run that ended failed at tenant
        riverbend; it does not tell the outcome screen apart from that one
riverbend  over-fires  green@step 1, other-abnormal@step 4, other steps 8, other tenants 0
```

**The refusal is correct and the finding is real.** `probe-absent` was run with `--capture-every`,
and the run does not stop at the outcome screen: `activate-search`'s checkpoint *passes* there,
because the empty grid still renders its header row. So the run walks on to the read step and
freezes **the same screen a second time**. The reviewer may designate only the capture at the
detector's own step as a positive (`PromotionReviewSchema` refuses the other), and the second copy
is then a negative that the detector necessarily fires on. No detector can pass: the two
observations are the same screen, and nothing a pure function of a frozen `Observation` can see
distinguishes them.

Stated as a property of the tool: **a `--capture-every` probe of the run that produced the outcome
screen cannot be its own corpus, whenever the flow continues past that screen.** The prover has no
way to say "these two frozen observations are the same screen"; `corpusDigestOf` deduplicates by
content address, and the addresses differ. The proof rule was left intact, and the reviewer moved
the detector to the step where production replay actually stops.

### 3. The reviewer's second attempt

The detector is declared at `read-membername-sharebalance-membershipstatus`, the step the run
actually stops at, and the positive is the one screen the *production* recording policy froze on its
own. `promoted/console.txt`:

```text
review    MEMBER_NOT_FOUND at read-membername-sharebalance-membershipstatus,
          by reviewer:agent-acting-as-reviewer, sha256:47ebed5e…
corpus    12 observations from 6 bundle(s), 0 problem(s)
positive  sha256:394ed4f0… - the journal says step read-membername-sharebalance-membershipstatus
proof     riverbend: DISCRIMINATES - fires on 1 designated positive(s) at step
          read-membername-sharebalance-membershipstatus and is silent on all 11 negative(s),
          of which 1 were captured at that step on a successful run and 0 were other screens
          at that step
emitted   contract@2.0.0, artifact@2 sha256:8df36d28…
```

`probe-absent/` is **deliberately not in this corpus**, and that is the one place a reader should be
suspicious, so it is said plainly: including it makes the proof fail, for the reason in §2, and it
would fail for a reason that is about the corpus rather than about the detector. The bundle is
shipped here so anyone can put it back and watch the refusal happen -
`--corpus evidence/outcome-promotion/probe-absent` added to the `crr promote` line in
`reproduce.sh` step 7 is the whole change.

`other-abnormal@step 0` is the honest weak spot in this proof, and it is **reported, not
threshold-ed** - the design's rule from OPEN-QUESTIONS Q4, "measure it, ship no number". The reason
the number is zero is visible in the four abnormal probes: every one of them fails
`activate-search`'s checkpoint and never reaches the read step, so no app-error, session-expiry,
interstitial or validation screen exists at the step the detector guards. What that argument does
**not** cover is a screen that passes `activate-search`'s checkpoint and is still abnormal - a torn
repaint, or an interstitial that the accessibility tree still shows the grid behind. Neither was
probed. The detector's claim is exactly "fires on this frozen screen, is silent on those eleven",
and nothing larger.

### 4. Promote, re-verify, invoke

| stage | file | result |
|---|---|---|
| promote | `promoted/` | `contract@2.0.0` `sha256:e92f2faf…`, `artifact@2 (proposed)` `sha256:8df36d28…`, receipt archived under `promoted/promotions/` |
| re-verify, model out of the loop | `verified/` | `VERIFIED replay-dry grade full`, covered through `activate-open`; draft `sha256:21f298ec…` |
| approve | `approved/` | signed; prints `probe NOT confirmed - this detector has never fired in a live session` |
| **invoke against a member that does not exist** | `invocation-after-outcome/` | `OUTCOME MEMBER_NOT_FOUND`, 2/4 steps, **exit 2** |
| invoke against a member that does exist | `invocation-after-green/` | `OK`, 4/4 steps, exit 0 |
| confirm the probe | `confirm/` | `CONFIRMED MEMBER_NOT_FOUND`; final artifact `sha256:c4869528…` |

```text
OUTCOME  run run-… 2/4 steps  1119ms
  outcome  MEMBER_NOT_FOUND
  guidance Tell the member that number is not on file and ask them to read it again from their
           card or statement. Do not guess a different number on their behalf.
```

The guidance is copied verbatim from the reviewed contract; nothing generated it at runtime. The
re-verification matters and is not a formality: `classify` evaluates declared outcomes **before** the
checkpoint, so adding a detector changes the meaning of every *successful* run through that step. A
detector that hijacked the happy path would make `replay()` return the `outcome` arm and
`gradeVerification` would fail closed on it. `invocation-after-green/` is the same check again in
production mode, against the signed artifact.

`link.txt` runs the linker over both revisions:

```text
before                            link ok - 4 steps, 29 checks
after,  --tenant riverbend        link ok - 4 steps, 29 checks
  outcome MEMBER_NOT_FOUND at read-… [reviewer-authored] proven at riverbend, probe confirmed
after,  --tenant summit           link REFUSED
  check 29 outcome-unproven: … was proven at riverbend and this run is at summit; its detector
  reads a vocabulary token an overlay overrides per tenant, so a proof elsewhere says nothing
  about here
```

---

## Every file, and what produced it

| path | produced by |
|---|---|
| `README.md` | the reviewer, by hand. |
| `reproduce.sh` | the reviewer, by hand. Runs the whole chain; it is the only thing here that has to be trusted to read the rest. |
| `allowlist.json` | the reviewer, by hand - transcribed from `packages/discovery/test/fixtures/corebank-web.ts`, the deployment allowlist the live discovery run was performed under. |
| `before/contract.json`, `before/artifact.json` | **the live `claude-opus-5` discovery run**, via `@crr/discovery` synthesis. Byte-identical copies of `evidence/discovery-live/synthesized/`. |
| `before/artifact-approved-for-probe.json`, `before/approve-console.txt` | `crr approve` (deterministic code), signed by the reviewer's throwaway key. |
| `probe-*/journal.jsonl`, `probe-*/observations/**` | `crr probe --capture-every` over `@crr/surface-browser`. Real perception of a real browser; no model. |
| `probe-*/console.txt` | the `crr probe` process's own stdout+stderr. |
| `invocation-before/**`, `invocation-after-*/**`, `confirm/journal.jsonl`, `confirm/observations/**`, `confirm/result.json` | `crr replay`. No model. |
| `review/promotion.template.json` | **the reviewer, by hand.** The only business semantics in this directory. |
| `review/build-review.mjs` | the reviewer, by hand - a deterministic filler that substitutes the positive's content address, the run id and the step into the template, **reading all three off the run journal** rather than taking them from a person. |
| `review/promotion.json`, `review/promotion-attempt-1-refused.json` | `build-review.mjs` (deterministic code) over the reviewer's template and the journals. |
| `review/promote-attempt-1-refused.txt`, `promoted/console*.txt` | the `crr promote` process's own stdout. |
| `promoted/contract.json`, `promoted/artifact.json`, `promoted/promotions/*.json` | `crr promote` (deterministic code), only after `proveDiscrimination` returned `discriminates`. |
| `verified/**` | `crr verify` - a replay of the promoted artifact with the model out of the loop. |
| `approved/**`, `confirm/artifact.json`, `confirm/artifact-approved.json`, `confirm/*console*.txt` | `crr approve` and `crr promote --confirm`. |
| `keys/reviewer.spki.pem` | `node:crypto`, generated per run of `reproduce.sh`. The private half is written to a `mktemp -d` outside the repository and deleted on exit. |
| `link.txt` | the `crr link` process's own stdout, three invocations. |
| `canary/run-canary.mjs` | the reviewer, by hand. |
| `canary/documents.json`, `canary/reproduction.json`, `canary/report.txt` | `runRedactionCanary()` from `@crr/runtime` - the same function `pnpm demo` runs over the whole bundle. |

---

## The redaction canary

`canary/report.txt`, two scopes, complements of each other so a file added later is covered by one of
them by default.

```text
pass documents  GATING
  files      73        self-test PASSED (21/21 planted needles found)
  hits       0         forbidden 0         verdict CLEAN

pass reproduction  reporting only
  files      2         hits 6
    README.md:76      green probe … / args.memberId  [utf8]
    README.md:77      absent-member probe … / args.memberId  [utf8]
    README.md:81      malformed-number probe / args.memberId  [utf8]
    reproduce.sh:37   green probe … / args.memberId  [utf8]
    reproduce.sh:38   absent-member probe … / args.memberId  [utf8]
    reproduce.sh:39   malformed-number probe / args.memberId  [utf8]
```

73 of the directory's 79 files: the gating pass reads everything except `README.md`,
`reproduce.sh` and the canary's own four files.

The gating pass covers every document and record this exercise wrote: no caller argument may appear
in any of them, in any of fourteen encodings, because `memberId` is declared `sensitive` on the
contract and the taint model substitutes a handle before a byte is written. The reporting pass
covers `README.md` and `reproduce.sh`, where the argument appears because the **command** is the
deliverable - BRIEF §0 requires the command next to the claim, and a command with its argument
removed is not a command. That split is the one the live discovery bundle already uses.

Two things the canary does not search for, said rather than left implicit. **Member data** -
`CHEN, MIN (SYNTHETIC)`, `15,900.00` - is in `probe-green/`, `verified/` and
`invocation-after-green/`, legitimately: it was never an argument, so parameterization has nothing to
substitute, and it is what the capability *returns*. And a byte scan cannot see through compression;
there are no images in this directory, so that limit does not bite here.

**The gating pass failed the first time it ran, on a real leak.** See below.

---

## What this exercise found in the shipped code

Four defects, all of them found by doing this rather than by reading anything.

**1. The observed route's query reached the journal in clear. Fixed.**
`observedSummaryOf` redacted salient node names and the native dialog's message and passed
`observation.route` straight through. The live artifact's route table declares `search-results` with
a query key bound to `param.memberId` - the fixture's search form is a GET form, and that is what
synthesis derived - so the member number travelled into the journal's `classified` line, into the
result document's failure trace, and onto the operator console, **while the frozen observation
beside it had the same field blanked to `<taint:memberId-1>`**. Five clean `pnpm demo` canary runs
said nothing about it, because the hand-authored demo artifact declares no query on any route.
Fixed in `packages/core/src/evaluate.ts`; regression test in `packages/core/test/render.test.ts`
(*"scrubs a value that reached the observed route's QUERY"*), which asserts the input really carries
the value before asserting the summary does not.

**2. `crr link` could not link a promoted artifact at all. Fixed.**
The CLI parsed `--tenant` and never passed it to `link()`. Linker check 29 refuses a
reviewer-authored outcome whose proof does not name *this* tenant, and a link naming no tenant can
never satisfy it - so every artifact carrying a promotion was refused at every tenant, including the
one it was proven at. One line in `packages/runtime/src/cli.ts`. `link.txt` is the before/after.

**3. The artifact-derived allowlist cannot verify anything above `READ`. Not fixed.**
`allowlistFromArtifact` hard-codes `discoveryMaxEffect: "READ"`, and `crr verify` runs the policy
chokepoint in `discovery` mode. So `crr verify` on this `WRITE_REVERSIBLE` artifact fails at step
one with `policy-denied … discovery may not exceed READ` unless an explicit `--allowlist` is passed.
That is arguably correct - the CLI's own comment says *"a program that authorizes itself is not
authorized"* - but the failure names the effect ceiling rather than the missing flag, and the
promotion path's second gate is unreachable without knowing that. `reproduce.sh` passes
`--allowlist`, and this paragraph is the documentation.

**4. `probeConfirmed` can only be stamped in one order, and the order is not obvious. Not fixed.**
`confirmProbe` refuses an artifact that carries an approval - correctly, because stamping the
receipt moves the digest the signature covers. But the result document it needs can only come from
`crr replay`, and linker check 27 refuses to replay anything that is not approved. So the sequence
is necessarily: approve, replay, confirm the *pre-approval draft* with that result, re-approve. Both
halves are in `confirm/console.txt`, the refusal first. Two consequences worth naming: the first
approval is a throwaway that existed only to make the replay legal, and the re-approval signs a
digest no replay ever produced, because the stamp moved it after the verification.

Also observed, and already named in REPORT §7 rather than new: writing the verification stamp moves
the artifact's content address (`proposed sha256:8df36d28…` → `verified sha256:21f298ec…`), because
`verification` is not on `ARTIFACT_DIGEST_EXCLUDED_FIELDS`.

---

## Changes to shipped code that this evidence depends on

- `packages/core/src/evaluate.ts` - the redaction fix above, plus its test.
- `packages/runtime/src/cli.ts` - `crr link` now passes `--tenant`.
- `packages/runtime/demo/surface-entry.mjs` - a `CRR_DEMO_FAULT` environment hook that arms one of
  the fixture's faults for the browser session before the surface is handed over. Unset, which is
  every `pnpm demo` run, it arms nothing and makes no request. It exists because a discrimination
  proof is only as good as its negatives, and the abnormal screens a real corpus needs are ones a
  fixture only produces on cue.

## What is not established

- **The corpus is mine, and so is the fixture.** The proof's claim is "fires on this capture, silent
  on those eleven". A screen nobody froze is a screen it did not consider.
- **`otherAbnormalAtStep: 0`.** No competing abnormal screen exists at the detector's step in this
  corpus. §3 explains why, and names the two screens that would test it and were not probed.
- **One tenant.** `provenAt: ["riverbend"]`. The same detector at `summit` is refused by check 29
  and would need its own probe and its own proof, which is the operational cost the design chose.
- **The reviewer and the approver are the same agent**, and neither is a person. Every control here
  raises the cost of an *accident*. None of them defends against the reviewer.
- **Numbers move between runs.** Run ids, timestamps, and observation content addresses (which cover
  a driver-assigned repaint generation) all differ on a re-run, so the review digest, artifact@2's
  digest and every signature differ too. The corpus size varies for the same reason: two probes that
  froze a byte-identical screen deduplicate, and whether they do is timing-dependent. Read the
  digests above as *this run's*.
