# Requirement Trace

This trace maps the assignment PDF to the repository. The PDF text was extracted with `pypdf`
because Poppler tools were not installed in this environment; no visual PDF review was performed.

The final claim is deliberately narrow:

One deterministic, model-free runtime supports surface-specific artifacts under a shared typed result
model. Business outcomes are declared and proven, policy and approval are separate gates, and
irreversible effects require scoped invocation approval at the dispatch boundary.

## Verification Summary

| Receipt | Current observed result |
|---|---|
| Full no-key test | `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN TURBO_FORCE=1 pnpm test` -> 2,032 tests, 14/14 tasks, 0 cached |
| Main demo | `env -u ... pnpm demo` -> 241 files, seven PASS lines, whole-bundle canary CLEAN |
| Write boundary | `pnpm -F @crr/runtime exec tsx demo/write-boundary.ts` -> 18 scenarios, canary clean |
| Semantic denials | `pnpm -F @crr/runtime exec tsx test/evidence/semantic-denials.ts` -> 3 scenarios, canary clean |
| Terminal survivors | `pnpm -F @crr/conformance exec tsx test/evidence/terminal-survivors.ts` -> 14 scenarios, 4 documented survivors |

## Matrix

| Requirement / Review Question | Implementation Files | Tests | Evidence | Verify | Limit |
|---|---|---|---|---|---|
| No clean API / UI automation surface | `fixtures/corebank-web`, `packages/surface-browser/src`, `packages/surface-terminal/src` | `packages/surface-browser/test/*`, `packages/surface-terminal/test/*` | `evidence/discovery-live/`, `evidence/replay-*` | `pnpm test` | Targets are local fixtures, not vendor systems. |
| Goal-driven LLM discovery loop | `packages/discovery/src/loop.ts`, `packages/discovery/tools/discover.ts` | `packages/discovery/test/loop.test.ts`, `packages/discovery/test/vcr.test.ts` | `evidence/discovery-live/transcript.json`, `evidence/discovery-live/provenance.json` | `pnpm discover --dry-run` | Only one live model run is committed; do not rerun without intent to spend. |
| Typed capability contract | `packages/core/src/contract.ts`, `packages/core/src/schema.ts`, `packages/runtime/src/codegen.ts` | `packages/core/test/*contract*`, `packages/runtime/test/typed-outcomes.test.ts` | `evidence/artifact/contract.json`, `evidence/outcome-promotion/promoted/contract.json` | `pnpm -F @crr/core typecheck` | Contracts name outcomes; surface-specific detectors live in artifacts. |
| Structured artifact as data, not code | `packages/core/src/artifact.ts`, `packages/core/src/linker.ts` | `packages/core/test/linker.test.ts`, `packages/runtime/test/demo-contract.test.ts` | `evidence/artifact/artifact.json` | `pnpm -F @crr/runtime test demo-contract.test.ts` | Generated code is a secondary export, not the runtime source of truth. |
| Model-free replay | `packages/runtime/src/replay.ts`, `packages/runtime/src/interpreter.ts` | `packages/runtime/test/browser-replay.test.ts`, `packages/runtime/test/synthesized-replay.test.ts` | `evidence/replay-*`, `evidence/cli-replay/` | `pnpm demo` | Replay still depends on the target surface being reachable. |
| Observation normalization | `packages/core/src/observation.ts`, `packages/surface-browser/src`, `packages/surface-terminal/src` | `packages/surface-browser/test/browser-perceive.test.ts`, `packages/surface-terminal/test/observe.test.ts` | Frozen observations under `evidence/*/observations/` | `pnpm test` | Desktop observations are design-only. |
| Locator / descriptor strategy | `packages/core/src/target.ts`, `packages/core/src/resolve.ts`, `packages/discovery/src/synthesis/descriptors.ts` | `packages/core/test/target-resolver.test.ts`, `packages/conformance/test/suite-discriminates.test.ts` | Conformance kill matrix output | `pnpm -F @crr/conformance stability` | Descriptor strength is only proven over the fixture corpus. |
| Policy gate / allowlist | `packages/core/src/policy-engine.ts`, `packages/runtime/src/interpreter.ts` | `packages/core/test/policy-check.test.ts`, `packages/runtime/test/write-boundary.test.ts` | `evidence/write-boundary/policy-read-ceiling/` | `pnpm -F @crr/runtime test write-boundary.test.ts` | Effect class is declared and linked, not externally proven. |
| Artifact approval | `packages/runtime/src/lifecycle.ts`, `packages/core/src/approval.ts` | `packages/core/test/approval.test.ts`, `packages/runtime/test/approval.test.ts` | `evidence/artifact/artifact.json`, `evidence/outcome-promotion/approved/` | `pnpm -F @crr/core test approval.test.ts` | Lifecycle approval says the procedure may exist; it is not per-execution authorization. |
| Invocation approval gate | `packages/core/src/approval.ts`, `packages/runtime/src/approval.ts`, `packages/runtime/src/interpreter.ts` | `packages/runtime/test/write-boundary.test.ts`, `packages/runtime/test/browser-write.test.ts` | `evidence/write-boundary/valid-approval/`, rejected approval directories | `pnpm -F @crr/runtime test write-boundary.test.ts browser-write.test.ts` | Local ed25519 signer has no production key custody. |
| Irreversible effect boundary | `packages/runtime/src/interpreter.ts`, `packages/core/src/effects.ts` | `packages/core/test/effects.test.ts`, `packages/runtime/test/write-boundary.test.ts` | `evidence/write-boundary/no-approval/`, `valid-approval/` | `pnpm -F @crr/runtime exec tsx demo/write-boundary.ts` | Browser write fixture does not expose typed commit outputs. |
| Dry-run behavior | `packages/runtime/src/replay.ts`, `packages/runtime/src/interpreter.ts` | `packages/runtime/test/write-boundary.test.ts`, `packages/runtime/test/verify.test.ts` | `evidence/write-boundary/dry-run/` | `pnpm -F @crr/runtime test write-boundary.test.ts` | Dry run proves the boundary, not downstream app behavior. |
| Business outcomes vs failures | `packages/core/src/classify.ts`, `packages/core/src/promotion.ts` | `packages/core/test/classifier.test.ts`, `packages/core/test/promotion.test.ts` | `evidence/replay-02-outcome-member-not-found/`, `evidence/outcome-promotion/` | `pnpm -F @crr/core test classifier.test.ts` | A new outcome needs a reviewer and a captured corpus. |
| No-such-member / member-not-found | `packages/runtime/test/fixtures/corebank.ts`, `packages/runtime/src/promote.ts` | `packages/runtime/test/promote.test.ts`, `packages/runtime/test/browser-replay.test.ts` | `evidence/outcome-promotion/`, `evidence/replay-02-outcome-member-not-found/` | `pnpm demo` | Live synthesized artifact originally had `outcomes: []`; promotion is a later human-authored revision. |
| Role denial vs record denial | `packages/runtime/test/fixtures/corebank-write.ts`, `packages/core/src/classify.ts` | `packages/runtime/test/browser-write.test.ts` | `evidence/semantic-denials/` | `pnpm -F @crr/runtime exec tsx test/evidence/semantic-denials.ts` | The distinction is fixture-backed, not inferred from arbitrary prose. |
| Idempotency / double-write safety | `packages/runtime/src/invoke.ts`, `packages/runtime/src/interpreter.ts` | `packages/runtime/test/write-boundary.test.ts` | `evidence/write-boundary/idempotency-repeat/` | `pnpm -F @crr/runtime test write-boundary.test.ts` | The store here is in memory; production needs durable storage. |
| Effect-in-doubt | `packages/core/src/classify.ts`, `packages/runtime/src/interpreter.ts` | `packages/core/test/classifier.test.ts`, `packages/runtime/test/write-boundary.test.ts` | `evidence/write-boundary/effect-in-doubt/` | `pnpm -F @crr/runtime test write-boundary.test.ts` | It stops and surfaces reconciliation work; it does not reconcile automatically. |
| Redaction / canary | `packages/runtime/src/evidence.ts`, `packages/runtime/src/canary.ts`, `packages/discovery/tools/canaries.ts` | `packages/runtime/test/canary.test.ts`, `packages/discovery/test/canary-scopes.test.ts` | `evidence/redaction-canary/`, canary fields in supplemental manifests | `rg -n '10041|250\.00|50001' evidence` | Live discovery recording intentionally contains the argument shown to the model; the canary documents its scopes. |
| Evidence journal | `packages/runtime/src/journal.ts`, `packages/runtime/src/evidence.ts` | `packages/runtime/test/demo-integrity.test.ts`, `packages/runtime/test/browser-write.test.ts` | `evidence/*/journal.*`, `evidence/MANIFEST.json` | `pnpm demo` | Content-addressed blob names churn per run. |
| Conformance / mutants | `packages/conformance/src`, `packages/conformance/test` | `packages/conformance/test/*.test.ts` | `evidence/terminal-survivors/` | `pnpm -F @crr/conformance test terminal-conformance.test.ts` | Terminal kills 5/9; browser corpus kills all 9. |
| Browser surface | `packages/surface-browser/src`, `fixtures/corebank-web` | `packages/surface-browser/test/*`, `packages/runtime/test/browser-*.test.ts` | `evidence/replay-*`, `evidence/semantic-denials/` | `pnpm -F @crr/runtime test browser-write.test.ts` | Requires local Chromium. |
| Terminal / green-screen surface | `packages/surface-terminal/src`, `fixtures/corebank-tui`, `packages/conformance/test/terminal` | `packages/conformance/test/terminal-conformance.test.ts`, `packages/conformance/test/heterogeneity.test.ts` | `evidence/terminal-survivors/` | `pnpm -F @crr/conformance test terminal-conformance.test.ts` | Surface-specific artifacts under a shared result model, not browser-terminal parity. |
| Human escalation and handoff | `packages/runtime/src/intervention.ts`, `packages/runtime/src/resume.ts`, `packages/runtime/src/escalation.ts` | `packages/runtime/test/escalation.test.ts` | Journals produced by escalation tests, docs in `REPORT.md` | `pnpm -F @crr/runtime test escalation.test.ts` | Operator UI is minimal and polling, not production co-browsing. |
| Multi-tenant reuse | `packages/core/src/overlay.ts`, `packages/runtime/src/overlay-link.ts` | `packages/runtime/test/browser-overlay.test.ts`, `packages/conformance/test/heterogeneity.test.ts` | Cross-tenant divergence output in test logs | `pnpm -F @crr/runtime test browser-overlay.test.ts` | One artifact across two tenants is proved; one contract across browser and terminal is not. |
| Desktop automation status | `docs/design/DESKTOP-AUTOMATION.md` | None | Design document only | Read the doc | No desktop driver is implemented. |

## Known Limits To Preserve

- The target applications are local fixtures.
- There is one live discovery run, not a reliability sample.
- Terminal support is honest surface-specific support, not parity with browser evidence.
- External KMS/HSM custody is not implemented.
- Desktop automation is design-only.
- Generated evidence is committed, but content-addressed observation blob names move when `pnpm demo`
  is rerun.
