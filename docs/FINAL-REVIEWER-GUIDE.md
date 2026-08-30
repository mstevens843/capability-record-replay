# Final Reviewer Guide

Open this first. It is the shortest path to judge the project without trusting narration.

## 60-Second Summary

This is not "an LLM clicks a website." A model performed one live discovery run against a hostile
legacy banking fixture. The recording became typed capability data. Production replay then runs that
artifact through a deterministic interpreter with no model in the decision path.

The runtime returns a typed result: `ok`, declared business `outcome`, `suspended`, or `failed`.
Business outcomes are not guessed from similar-looking text; a reviewer declares detectors and the
proof checks them against frozen observations. Irreversible effects have two independent gates:
policy allowlist/effect ceilings, and scoped invocation approval verified immediately before
`WRITE_IRREVERSIBLE` dispatch.

## Business Problem

Banks and credit unions often need agents to operate back-office systems with no API: framesets,
layout tables, green screens, native apps, generated ids, no test ids. The useful product is not a
happy-path macro. It is a reusable, reviewable capability that can be invoked cheaply and safely,
reports business answers distinctly from failures, and refuses to improvise around risky states.

## Architectural Thesis

- AI discovers or proposes.
- The artifact is typed data, not generated executable code.
- Replay is deterministic, model-free, typed, journaled and policy checked.
- Business outcomes are declared and proven, not inferred by string similarity.
- Irreversible writes require scoped invocation approval at the dispatch boundary.
- Browser and terminal are different surfaces under a shared result model; the project does not
  claim fake parity.

## Five-Minute Quick Path

Run from the repository root. These commands do not call live model providers.

```sh
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN TURBO_FORCE=1 pnpm test
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN pnpm demo
pnpm -F @crr/runtime exec tsx demo/write-boundary.ts
pnpm -F @crr/runtime exec tsx test/evidence/semantic-denials.ts
pnpm -F @crr/conformance exec tsx test/evidence/terminal-survivors.ts
rg -n '10041|250\.00|50001' evidence
```

Expected current receipts:

| Command | Proves | Current receipt |
|---|---|---|
| `pnpm test` with provider env vars unset and `TURBO_FORCE=1` | Full workspace still passes without credentials or cached logs | 2,032 tests, 14/14 tasks, 0 cached |
| `pnpm demo` with provider env vars unset | Main replay bundle runs without a model, evidence integrity passes, whole-bundle canary passes | 241 files, seven PASS lines, `DEMO OK` |
| `demo/write-boundary.ts` | Irreversible boundary and approval negatives | 18 scenarios, canary clean |
| `test/evidence/semantic-denials.ts` | Record denial and role denial have different declared semantics | 3 scenarios, canary clean |
| `terminal-survivors.ts` | Terminal survivor matrix is generated and asserted | 14 scenarios, 4 documented survivors |
| `rg` canary grep | Current write/semantic sensitive literals are absent from evidence | no matches, exit 1 |

`rg` returning exit 1 is the expected "no matches" result.

## Thirty-Minute Deep Path

```sh
pnpm -F @crr/core typecheck
pnpm -F @crr/runtime typecheck
pnpm -F @crr/conformance typecheck
pnpm -F @crr/core test approval.test.ts classifier.test.ts
pnpm -F @crr/runtime test write-boundary.test.ts browser-write.test.ts demo-contract.test.ts
pnpm -F @crr/conformance test terminal-conformance.test.ts
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN TURBO_FORCE=1 pnpm test
```

Current full-suite receipt: 2,032 tests, 14/14 tasks, 0 cached, exit 0.

If a sandbox blocks loopback or browser launch, browser-backed tests may fail with `EPERM`. That is
an environment failure, not a pass. Rerun in an environment that permits local loopback before
quoting the result.

## Files To Inspect

| Area | Start here |
|---|---|
| Assignment mapping | `docs/REQUIREMENT-TRACE.md` |
| Architecture and cuts | `REPORT.md` |
| Spec and result model | `docs/SPEC.md` |
| Approval model | `docs/design/APPROVAL-MODEL.md`, `packages/core/src/approval.ts`, `packages/runtime/src/approval.ts` |
| Interpreter gate | `packages/runtime/src/interpreter.ts`, method `#authorizeStep` |
| Model-free replay | `packages/runtime/src/replay.ts`, `packages/runtime/src/invoke.ts`, `packages/runtime/src/catalog.ts` |
| Business outcome proof | `packages/core/src/promotion.ts`, `packages/core/src/classify.ts` |
| Role-vs-record denial | `packages/runtime/test/fixtures/corebank-write.ts`, `packages/runtime/test/browser-write.test.ts` |
| Write boundary tests | `packages/runtime/test/write-boundary.test.ts` |
| Terminal limits | `packages/conformance/test/terminal-conformance.test.ts`, `packages/conformance/test/evidence/terminal-survivors.ts` |
| Desktop design only | `docs/design/DESKTOP-AUTOMATION.md` |

## Evidence To Inspect

| Evidence path | What it proves |
|---|---|
| `evidence/discovery-live/` | One real LLM-driven run happened and produced a recording. |
| `evidence/discovery-live/verification.json` | The synthesized artifact replayed with `modelInTheLoop: false`. |
| `evidence/artifact/` | The approved hand-authored replay artifact and typed contract used by `pnpm demo`. |
| `evidence/replay-02-outcome-member-not-found/` | `MEMBER_NOT_FOUND` is a typed outcome, not a crash. |
| `evidence/outcome-promotion/` | A reviewer promoted `MEMBER_NOT_FOUND`; the first broad attempt was refused; v2 replayed. |
| `evidence/semantic-denials/` | `MEMBER_RESTRICTED` record denial differs from role `entitlement-denied`. |
| `evidence/write-boundary/` | Approval refusal, dry run, valid approval, rejected approvals, policy refusal, idempotency, effect-in-doubt. |
| `evidence/terminal-survivors/` | Five terminal-reachable mutants killed; four survivors documented as observationally indistinguishable. |
| `evidence/redaction-canary/` | Main bundle redaction canary scope, searched encodings, and limitations. |

## What The Hard Cases Prove

Record denial and role denial are intentionally similar refusal screens. The runtime does not guess.
The artifact declares `MEMBER_RESTRICTED` using record-specific text and reference code. Role denial
is an ambient entitlement failure. The evidence proof rejects a detector that only says "Request
Refused" because it also fires on the role-denial screen.

The write boundary is enforced by runtime code, not UI text. The interpreter verifies invocation
approval before the final irreversible action. Rejected approvals journal exact refusal reasons and
show zero final dispatches. A valid approval dispatches once. If dispatch happens and the next
observation fails, the result is `effect-in-doubt`, not a retryable generic failure.

Policy and approval are separate. A valid approval can still be stopped by `maxEffect` or action
allowlists; policy refusal is not approval refusal.

## Known Limitations

- The main target applications are local fixtures, not vendor systems.
- There is one committed live discovery run, not a statistical sample.
- The live discovery run used Anthropic; the OpenAI adapter is tested at the port but not wired to
  the CLI or demonstrated live.
- Browser tests require local Chromium.
- The browser write fixture does not expose typed commit outputs cleanly; the evidence states that.
- External KMS/HSM approval custody is not implemented. The local signer and external signer seam
  exist; production custody does not.
- The idempotency store used in tests is in memory. A deployment needs durable storage.
- Terminal support is surface-specific. The project does not claim browser and terminal contracts
  are identical where observations differ.
- Desktop automation is design-only.
- Generated evidence is meant to be committed, but content-addressed observation blob names change
  when `pnpm demo` is rerun.

## Interview Questions

**Does a model ever decide approval?**  
No. Approval is a signed document plus trust-store facts verified by deterministic code. The model
does not choose whether an irreversible write is authorized.

**What is the difference between artifact approval and invocation approval?**  
Artifact approval says a reviewed procedure may exist. Invocation approval says this exact
irreversible execution is authorized now, with scope, expiry, signer authority, request hash and
idempotency binding.

**Can a reversible approval authorize an irreversible write?**  
No. The verifier refuses with `effect-class-escalation`, and tests/evidence show zero final
dispatches.

**Why is record denial an outcome but role denial a failure?**  
Record denial is a business fact about the member record and the caller can act on it. Role denial
is an operator/session entitlement problem; retrying the same member with the same role is not a
business answer.

**How do you prevent double writes?**  
The host-level idempotency store returns the prior result for a repeated key. If an irreversible
dispatch occurs and the postcondition is not observable, the runtime returns `effect-in-doubt` and
does not confidently retry.

**Why do terminal mutants survive?**  
Some browser defects are not observable on the terminal fixture. For example, the terminal readiness
signal is silence, and a torn repaint can also be silent, so `noSettleGate` is not distinguishable
there. The survivor list is generated evidence, not a hidden gap.

**What should I inspect first?**  
`docs/REQUIREMENT-TRACE.md`, then `packages/runtime/test/write-boundary.test.ts`, then
`packages/runtime/test/browser-write.test.ts`, then `evidence/write-boundary/MANIFEST.json` and
`evidence/semantic-denials/proof.json`.
