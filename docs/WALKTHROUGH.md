# Reviewer Walkthrough

This is the shortest path through the project without relying on narration. Re-run the commands
before quoting numbers; the evidence files are generated artifacts, not hand-written receipts.

## 60-second explanation

Capability Record Replay separates discovery from execution.

An AI/model may discover or propose a workflow. Production replay does not call a model. It loads a
typed contract, an approved artifact, and a deployment allowlist; links them through deterministic
checks; then drives a surface through typed actions. Business outcomes are not guessed from prose:
they are declared in the artifact and must prove discrimination against negative observations.

Irreversible writes have a second gate. Artifact approval says "this procedure may exist."
Invocation approval says "this exact irreversible execution is authorized now." The interpreter
verifies invocation approval immediately before `WRITE_IRREVERSIBLE` dispatch, journals the exact
accept/refusal reason, and refuses without dispatch when the approval is absent, stale, wrong, or
out of scope.

## 10-minute command path

Run from the repository root:

```sh
pnpm -F @crr/core typecheck
pnpm -F @crr/runtime typecheck
pnpm -F @crr/core test approval.test.ts classifier.test.ts
pnpm -F @crr/runtime test write-boundary.test.ts browser-write.test.ts
pnpm -F @crr/conformance test terminal-conformance.test.ts
pnpm -F @crr/runtime exec tsx demo/write-boundary.ts
pnpm -F @crr/runtime exec tsx test/evidence/semantic-denials.ts
pnpm -F @crr/conformance exec tsx test/evidence/terminal-survivors.ts
```

Those commands cover the approval model, the irreversible write boundary, the role-vs-record denial
split, the terminal mutant ledger, and the generated evidence bundle paths used below.

## 45-minute deep review path

1. Read the result model and linker controls in `docs/SPEC.md`, especially the 29 link checks,
   outcome proof, policy gate, and `effect-in-doubt` row.
2. Read the executable approval model in `packages/core/src/approval.ts` and the runtime signer seam
   in `packages/runtime/src/approval.ts`.
3. Read the interpreter gate in `packages/runtime/src/interpreter.ts` around `#authorizeStep`.
4. Read the write-boundary tests in `packages/runtime/test/write-boundary.test.ts`.
5. Read the browser write fixture and semantic split tests:
   `packages/runtime/test/fixtures/corebank-write.ts` and
   `packages/runtime/test/browser-write.test.ts`.
6. Read terminal coverage in `packages/conformance/test/terminal/scenarios.ts` and
   `packages/conformance/test/terminal-conformance.test.ts`.
7. Open generated evidence:
   `evidence/outcome-promotion/`, `evidence/write-boundary/`,
   `evidence/semantic-denials/`, `evidence/terminal-survivors/`, and
   `evidence/redaction-canary/`.
8. Run `pnpm test` only after the targeted checks are clean.

## Traceability Matrix

| Requirement | Primary files | Evidence or tests |
|---|---|---|
| AI discovers/proposes, replay is model-free | `packages/runtime/src/replay.ts`, `packages/runtime/test/demo-contract.test.ts` | `evidence/discovery-live/`, `evidence/README.md` |
| Typed outcomes are declared, not guessed | `packages/core/src/promotion.ts`, `packages/core/src/classify.ts` | `evidence/outcome-promotion/`, `packages/runtime/test/browser-write.test.ts` |
| Record denial is a business outcome | `packages/runtime/test/fixtures/corebank-write.ts` | `evidence/semantic-denials/record-denial-business-outcome/` |
| Role denial is entitlement/operator failure | `packages/runtime/test/fixtures/corebank-write.ts`, `packages/core/src/classify.ts` | `evidence/semantic-denials/role-denial-entitlement-failure/` |
| Over-broad detectors are rejected | `packages/core/src/promotion.ts` | `evidence/semantic-denials/proof.json` |
| Irreversible writes require scoped approval | `packages/core/src/approval.ts`, `packages/runtime/src/interpreter.ts` | `packages/runtime/test/write-boundary.test.ts`, `evidence/write-boundary/` |
| Policy and approval are separate gates | `packages/core/src/policy-engine.ts`, `packages/runtime/src/interpreter.ts` | `evidence/write-boundary/policy-read-ceiling/` |
| Double-write safety is explicit | `packages/runtime/src/invoke.ts`, `packages/runtime/src/interpreter.ts` | `evidence/write-boundary/idempotency-repeat/`, `evidence/write-boundary/effect-in-doubt/` |
| Sensitive inputs stay tainted/redacted | `packages/runtime/src/evidence.ts`, `packages/runtime/src/canary.ts` | `evidence/redaction-canary/`, evidence canary fields |
| Browser and terminal support are honest | `packages/surface-browser`, `packages/surface-terminal`, `packages/conformance` | `evidence/terminal-survivors/`, `packages/conformance/test/heterogeneity.test.ts` |
| Desktop support is not overclaimed | `docs/design/DESKTOP-AUTOMATION.md` | design only, no production claim |

## What the evidence proves

`evidence/outcome-promotion/` shows a live model-discovered artifact promoted with a
reviewer-authored `MEMBER_NOT_FOUND` outcome and then replayed model-free.

`evidence/semantic-denials/` shows the harder semantic split: two similar refusal screens at the
same final write boundary. Record denial returns `MEMBER_RESTRICTED`; role denial returns
`entitlement-denied`; an over-broad `Request Refused` detector is rejected by proof.

`evidence/write-boundary/` shows no approval, dry run, valid approval, rejected approvals, policy
refusal, idempotency repeat, and effect-in-doubt. The summaries include final dispatch counts and
approval journal counts.

`evidence/terminal-survivors/` shows the terminal mutant matrix. Some mutants die on observable
terminal facts; four survive because this terminal surface cannot distinguish them from the
reference engine. That survivor set is reported, not hidden.

## Known limitations

The browser write fixture returns no typed output values for the real CoreBank sub-account commit.
The screen prints account/reference text as unlabelled layout runs, so the artifact honestly declares
no outputs there. The mock write fixture has typed confirmation output and is used for the pure
write-boundary evidence.

Artifact approval and invocation approval are distinct. Invocation approval is rich and enforced at
the write boundary. Artifact lifecycle approval remains the older digest signature receipt; it is
not a per-execution authorization.

Resume precheck re-verifies rich invocation approval when one is present. Legacy approval-token
handoff remains only as a compatibility fallback, and the interpreter still re-verifies before any
irreversible dispatch.

The terminal fixture does not expose every browser mutant condition. The terminal claim is therefore
not "browser and terminal are equivalent"; it is that one deterministic runtime supports
surface-specific artifacts under a shared result model, and the survivor matrix states the limits.

Desktop automation is a design document only. No production desktop surface is implemented.

## Questions They May Ask

**Does a model ever decide approval?**
No. Approval is a signed document plus trust-store data checked by pure verifier functions and the
runtime interpreter.

**Can a READ or WRITE_REVERSIBLE approval authorize the final commit?**
No. `irreversibleApprovalOf` refuses it with `effect-class-escalation`, and runtime tests prove the
final action is not dispatched.

**What prevents retrying after a commit when the next observation fails?**
The interpreter reports `effect-in-doubt` with `sideEffects: in-doubt` and `retriable: no`.

**How do you know record denial is not guessed from the shared refusal heading?**
The detector requires record-specific text and reference code, and `proof.json` shows a broader
`Request Refused` detector over-fires on role denial.

**Why do terminal mutants survive?**
Because the terminal surface lacks an observation that distinguishes those defects from the
reference engine. The survivor list is measured and asserted by the terminal conformance test.

**What is the strongest final project claim?**
One deterministic, model-free runtime supports surface-specific artifacts under a shared typed
result model. Business outcomes are declared and proven, policy and approval are separate gates, and
irreversible effects require scoped invocation approval at the dispatch boundary.
