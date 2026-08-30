# Judging record

**Internal. Not part of the submission.** This file exists so that every decision in
[`../SPEC.md`](../SPEC.md) can be traced back to the argument that produced it - including the
decisions that went *against* the winning proposal.

Three design proposals were written independently against the same brief. Three judges scored all
three against the same four axes and were asked, separately, to name the best overall, the
mechanisms worth grafting from the losers, and the fatal flaws in each. `SPEC.md` is the
reconciliation.

---

## 1. What was proposed

| Proposal | Thesis in one line |
|---|---|
| [`proposal-failure-first`](./proposal-failure-first.md) | A replay engine is a **classifier with an actuator attached**; derive the schema backwards from `classify(Observation) → Verdict`, and enumerate every runtime condition first. |
| [`proposal-interpreter-first`](./proposal-interpreter-first.md) | Design the **interpreter** first; the artifact is a straight-line typed program, and every language refusal must purchase a checkable safety property. |
| [`proposal-agent-contract-first`](./proposal-agent-contract-first.md) | Start at the **call site**; the artifact exists to make one typed, exhaustive `switch (r.status) / switch (r.outcome)` true for the calling agent. |

Two spikes were run first and both were **executed**, not recollected:
[`spike-browser-surface`](./spike-browser-surface.md) (20 experiments, 1238 lines, against a hostile
frameset fixture) and [`spike-terminal-surface`](./spike-terminal-surface.md) (574 lines, an 80×24
green-screen fixture with two tenant variants). Several of their findings overruled all three
proposals; those are listed in §5.

---

## 2. Scores

| Axis | failure-first | interpreter-first | agent-contract-first |
|---|---|---|---|
| Judge A total | **84** | 78.5 | 67 |
| Judge B total | **83** | 81 | 79 |
| Judge C total | **81** | 68 | 69 |
| Schema quality (A/B/C) | 8.5 / 8 / 8 | 8.5 / 8 / 7 | 7 / 8 / 7 |
| Error taxonomy | 9.5 / 9 / 9 | 8 / 9 / 7 | 6 / 7 / 6 |
| Generalization | 6.5 / 7 / 6 | **9 / 9 / 8** | 6.5 / 9 / 7 |
| Simplicity | 8.5 / 9 / 9 | 5.5 / 6 / 5 | 7.5 / 8 / 8 |

**All three judges independently named `failure-first` best overall.** They did not agree on second
place - Judge A and Judge B ranked `interpreter-first` second, Judge C ranked it last - which is
itself informative: the thing that separates them is how heavily you weigh a rigorous language
design against a document a CTO has to read beside twenty others.

---

## 3. Why `failure-first` became the spine

Judge B stated the argument the other two implied:

> Four of the five on-call questions are taxonomy questions… §2.1's 28-row enumeration, §3.2's
> defended band ordering and §4's W1-W7 decomposition are original analysis that cannot be
> reconstructed from the other two documents… Crucially, everything failure-first lacks is
> **additive** - a typed result union, a termination argument, distinct evidence sources, generated
> failure prose, vocabulary tokens - whereas adopting interpreter-first as the spine means importing
> eight packages, a 520-line artifact format and a closed `FormatId` registry, and then retrofitting
> delta, continuity, effect-in-doubt and the band model into a precedence order that is already fixed.

Three of its rows were called out by more than one judge as insights the rivals simply do not have:

- **Row 2 vs row 3** - the identical validation banner is a business outcome when the rejected value
  was *param*-bound and a hard failure when it was *artifact-literal*-bound, decidable only because
  binding provenance is a classifier input. Judge C: *"the sharpest observation in the set."*
- **Row 26 `effect-in-doubt`** - irreversible dispatched, result never observed, `retriable: no`.
  *"The row that opens two sub-accounts."* Neither rival taxonomy has a counterpart.
- **Rows 5 vs 6** - permission denial split by *scope*, with an undeclared denial defaulting to the
  failure.

Plus one structural control no rival had: `OutcomeDef.requiresSettled: true` typed as a
non-configurable literal - the only defence in any of the three against a false `MEMBER_NOT_FOUND`
returned off a half-painted page.

---

## 4. What was grafted, and from where

Every graft below was named explicitly by at least one judge. `SPEC.md` section references are where
it landed.

### From `agent-contract-first`

| Graft | Where | Why the judges wanted it |
|---|---|---|
| `ReplayResult<C>` / `ReplayOutcome<C>` as a distributive conditional over `C["outcomes"][number]` | §2.6 | The only typed outcome payload in the set. `switch (r.outcome)` narrows `r.data`; adding an outcome is a compile error at every call site, correctly, because a new possible answer *is* a breaking change. The spine shipped `code: string` + `Record<string, unknown>`. |
| The `suspended` arm - `intervention{}`, `resume{token, pollAfterMs}`, `partialOutputs` | §2.6, §7 | The spine argued against a fourth status and was right about `recoverable` and wrong about escalation. A suspended run is not terminal. |
| `onIntervention: "suspend" \| "fail"` supplied by the **caller** | §2.6 | *"A batch job says fail and goes home; a live conversational turn says suspend. The engine must not guess this, because the right answer depends entirely on who is waiting."* |
| `renderForAgent` - the two-audience split | §2.7 | Judge C: *"the single best idea in the three documents."* The model gets a deliberately poorer projection with step ids, descriptors, expected/observed and digests removed, and `guidance` copied verbatim from a human-reviewed field. |
| `WithApproval<C>` | §2.6 | The approval token required **by the type** for `WRITE_IRREVERSIBLE` and `approval?: never` otherwise. |
| `vocabulary` / `LabelToken` indirection | §2.4, §9.3 | Strictly better than the spine's `oneOf` widening, which accumulates every tenant's wording into the base matcher and degrades discrimination as tenants are added. |
| Decimal-as-string, no IEEE-754 at any depth | §2.1 | Argued from canonical-JSON digest reproducibility as well as from money: a float makes the approval signature platform-dependent. |
| `SurfaceBinding.requires` + refusal at driver load | §2.4, §10 check 17 | The spine had no capability negotiation at all. |
| `Invocation.idempotencyKey`, `post_mutation` verification gated on `idempotent` | §2.6, §6.6 | Retries at the agent layer are inevitable. |
| `OutcomeSpec.scope`, and *session expiry is not an ambient outcome* | §4.4 | The keep-alive **dialog** is an ambient recovery; the expiry itself is not something a caller can act on. |
| Reliability stats joined at catalog-render time, never inside the digest | §2.3 note | Stats inside a signed document make the signature meaningless. |

### From `interpreter-first`

| Graft | Where | Why the judges wanted it |
|---|---|---|
| The **three-document split**, and specifically **detectors out of the contract** | §0.4, §2.3, §2.4 | This is the fix for the spine's contract carrying frame names *and* for `agent-contract-first`'s fatal flaw, and it is what makes "one contract, two programs" expressible at all. |
| One contract, **two programs** (resolver picks by `surfaceKind`) | §9.1 | Judge A: *"the best answer to assignment §3.7 that any of the three produces."* |
| `quorum.distinctEvidenceSources` + the `EvidenceSource` union, with geometry+ordinal unable to carry a quorum between them | §5.1 | Judge B: *"the most important single graft in the list."* A quorum of three descriptors deriving from the same evidence is a quorum of one - and on a character grid, role, name and label anchoring all derive from the same label token. |
| `SurfaceCapabilities` + link check 17 | §2.2, §10 | Turns "this program needs a descriptor kind this surface cannot resolve" into a load-time error with a clear message. |
| The restart gate: no backward edge in the interpreter, one budgeted edge in the supervisor, gated on `steps[0..pc-1].every(s => s.effect !== "WRITE_IRREVERSIBLE")`, publishing `restartSafeUpToPc` | §3.6 | *"The cleanest example in the whole set of a refusal buying a safety property."* |
| Named, **versioned** registries (`std.text@1`) instead of inline option objects | §2.1 | Fixes the spine's 40-times-repeated `normalize` object *and* stops engine code silently changing what an approved artifact means while the digest keeps matching. Shipped as a golden-vector test, not a convention. |
| `LINK_ERROR` / `ARGUMENT_INVALID` as the only classes guaranteeing zero actions | §2.6 `sideEffects`, §10.1 | *"In a regulated environment 'we definitely did not touch anything' is materially different from 'we stopped partway'."* Promoted into an explicit `sideEffects` field so the caller does not infer it. |
| `TARGET_UNDERDETERMINED` as its own class | §2.6, §5.3 | "This tenant needs specialization" is a different human action from "the control is gone". |
| `AMBIGUOUS_CLASSIFICATION` as a hard stop | §4.6 | Replaces the spine's runtime first-declared-wins, which resolved a taxonomy tie by array index and shipped the answer. |
| Generated `ExpectationTrace` via `renderTarget`/`renderPredicate`/`renderVerdict` | §4.7 | Authored prose drifts from the predicate it claims to describe; a fold cannot. Also the design *criterion*: a construct earns its place partly because the interpreter can explain it at 2am. |
| The linker as a numbered list of checks run before any action, incl. the budget check | §10.1 | Extended to 28 checks. *(28 is what this judging round produced; the linker has run **29** since `docs/design/OUTCOME-PROMOTION.md` added `outcome-unproven` on 2026-08-29.)* |
| `afterRemedy: "reverify"` as a field with exactly one legal value | §2.4 | Makes "a remedy can never set the pc" visible in the document a human reviews. |
| `readTable` with `minRows`/`maxRows`/`onTruncate: "fail"` | §2.4, §3 | The spine had no bounded-read construct; silent truncation of a share list is the quiet wrongness the design exists to prevent. |
| Keeping `NodeQuery` (existential) a different type from `TargetRef` (quorum) | §2.4 | Stops a detector's looseness leaking into an action. |
| Overlay `addDescriptor` as additive, with abstention recorded in the fingerprint | §2.5 | An overlay that edited the base would erase the divergence signal the fingerprint exists to produce. |
| `INTERNAL_INVARIANT` | §2.6 | *"A system that cannot say 'I am broken' says 'you are' instead."* |
| `effectiveDigest = sha256(artifactDigest ‖ overlayDigest ‖ linkerVersion)` | §2.6, §9.2 | Base ⊕ overlay means the base digest alone cannot answer "which bytes actually ran". |
| The explicit **lowering rule**: the program says what the operator meant, the surface says how | §3, §9.4 | The spine depends on this rule and never states it. |
| Execution mode `full` / `dry` with `coveredThroughStep` | §6.6 | Merged with the spine's `grade` field. |

### From both spikes - findings that overruled all three proposals

All three judges flagged these as mandatory, and none of the proposals had absorbed them.

| Finding | Where it landed |
|---|---|
| `UINode.ariaRole: Role \| null`, `null` for Chromium `internalRole` nodes; only non-null nodes are candidate targets. Folding layout roles into data roles makes "the row whose Member ID is X" resolve to **3 elements**. All three proposals nominated `table-cell` as the workhorse for exactly that surface. | §2.2, D2 |
| `headerProvenance: "columnheader-role" \| "first-row-heuristic"` recorded on the artifact and correctable by overlay. The legacy grid has no `<th>`: we get structure for free and headers only by heuristic. | §2.2, §5.1, §2.5 |
| Native dialogs are a **separate Observation channel**, `perceive()` needs its own deadline, and the driver must own `page.on('dialog')`. An open `confirm()` blocks the renderer so `getFullAXTree` never returns - a hang, not an error - and with no handler registered Playwright silently dismisses it, so the click succeeds and the checkpoint fails three steps downstream. | §2.2, D5-D6 |
| `containerPath` is the frame **name** chain, never an ordinal. | §2.2, D3 |
| The coordinate-fallback protocol as a written rule: `scrollIntoViewIfNeeded` → re-read `model.border` → validate → click. | D4 |
| Field `capacity` from the character grid becomes the `maxLength` of the typed parameter. | §2.2, §6.3 |
| The pty is a `TerminalTransport` **port**, not the architecture - real green screens are sockets, and the two transports produced byte-identical grids. | D8 |
| Readiness is the checkpoint, not quiescence (the torn-read measurement). | §3.3 |
| `button:exit` identical across tenants with F3 vs F12 - a per-tenant difference that needs **no overlay**. | §3, §9.4 |

---

## 5. Fatal flaws, and what was done about each

### `agent-contract-first`

| Flaw | Disposition |
|---|---|
| The thesis fails on its own example: the contract is claimed surface-independent but `OutcomeSpec.detector` carries `container: "frame:main"` and `scope: StepId[]`, so re-recording dangles every reference. | **Fixed** by the three-document split - detectors moved to the step (§2.4). |
| No declared mechanism to detect session expiry **anywhere**; every timeout lands in `UNCLASSIFIED_STATE` forever. | **Fixed**: §4.2 rows 11-13, with a brokered fresh session on restart (§3.6, §7.6). |
| Precedence has no quiescence band; outcomes are evaluated above `WAIT_OUT_TRANSIENT_LOAD`. | **Fixed** by adopting the spine's B0 band and non-configurable `requiresSettled` (§4.4). |
| `grid_region{screen,row,col,width}` offered as the portability credential; the spike measured that not one coordinate matched across two tenants. | **Rejected.** No `grid_region` descriptor exists (§5.1). |
| Regex retained in `TextMatchMode` and `ParseSpec` while its own risk register conceded the safest version drops it. | **Rejected.** No regex anywhere (§5.6). |
| `agreement: quorum` on READ steps - "act on the majority, record the dissent as drift" - inside a section headed *"disagreement is a detected condition, not a fallback chain."* | **Rejected.** No majority-vote mode on any step class (§5.1). |
| No run-level remediation budget; two ambient recoveries can ping-pong across every step. | **Fixed** by the spine's `maxRemediationCycles` + `maxTotalRemediations` (§3.4). |
| Exhaustiveness degrades **silently** if the generated `.d.ts` is stale or `C["outcomes"]` widens. | **Fixed** by pinning `contractDigest` in `Invocation` and returning `contract-stale` - a loud failure at exactly the moment the type mechanism would fail silently (§2.6). |
| `sensitive` outputs delivered into the model transcript under "taint controls persistence, not delivery". | **Fixed** by `OutputSpec.agentDisclosure`, enforced in `renderForAgent` (§2.3, §2.7). |
| `memberId` classified `internal` with a committed example. | **Fixed**: `sensitive`, and no `example` permitted on a sensitive field (§2.3, §6.3). |

### `interpreter-first`

| Flaw | Disposition |
|---|---|
| No `EFFECT_IN_DOUBT` class; the case implying the most distinctive human action is absent. | **Fixed** by keeping the spine's row 26 and promoting it into a `sideEffects` field (§2.6, §3.5). |
| `OutcomeRule` has `phase` but no `requiresSettled`; `classify` runs inside the settle poll loop, so an outcome can return off a half-painted screen. | **Fixed**: `requiresSettled: true` is a non-configurable literal on every `OutcomeRule`, checked by linker check 22. |
| `SESSION_EXPIRED → restart: program` restarts at pc=0 and **nothing logs back in**; there is no login preamble and `include` was explicitly refused. | **Fixed**: the program never logs in. A `SessionBroker` establishes and re-establishes the session (§7.6). |
| `readTable` binds a value no `ReturnField` can consume - `ValueType` is scalar-only. | **Fixed**: `ValueType` gained a `table` member (§2.1). |
| Link check 20 forbids retargeting a literal referenced from both a descriptor and a detector, so the most common per-tenant change is inexpressible via overlay. | **Fixed** by vocabulary tokens, which reach descriptors and detectors through the same indirection (§9.3). |
| `AMBIGUOUS_CLASSIFICATION` is unreachable (check 9 makes priorities unique) yet risk 10 predicts it firing. | **Fixed** by scoping check 9 to a step's *own declared* rules, so ambient and overlay-added rules can still tie - which is the reachable path (§4.6). |
| `pressKey` with F1-F12 in the language, contradicted by its own lowering table and by the spike. | **Split**: F-keys at the port, `activate` in the artifact, linker check 21 (§2.2, §3). |
| `Checkpoint.requireQuiescent` defaults to **false**, undermining the determinism claim. | **Rejected.** Quiescence is a band, not a per-checkpoint flag (§4.4). |
| `FormatId` as a closed union of per-institution field shapes inside the engine binary. | **Rejected.** `ValueType.constraints` needs no engine release (§2.1). |
| Overlay `setRoutePattern` retargets where a `navigate` goes - a semantic change in an "add-only, non-semantic" document. | **Narrowed** to `routeBasePath`, a prefix only (§2.5). |
| 2,799 lines / 163 KB for a submission whose REPORT must be 1-3 pages. | **Noted.** `SPEC.md` is an internal build contract, not the submission document; `REPORT.md` stays at seven headings and 1-3 pages. |

### `failure-first` (the spine)

| Flaw | Disposition |
|---|---|
| Escalation and handoff effectively missing - a lease-lost class and an `escalation{}` stub, against an assignment that gives HITL its own core requirement and its own REPORT heading. | **Fixed**: §7 is a full protocol - states, transitions, the intervention brief, the console seam, and the seven-step resume re-check. |
| §2.3 argues against a fourth status, so the contract cannot express a non-terminal run. | **Overruled**: `suspended` ships (§2.6). |
| `Surface.act(action)` takes no lease token, so `lease-lost` classifies something nothing prevents. | **Fixed**: `act(action, lease)`, rejected at the port with `ActFault.lease-not-held` (§2.2). |
| A write flow with zero continuity assertions is called "a review finding, not a valid artifact" and then no invariant is added. | **Fixed**: save-time invariant 11. |
| `INVALID_INPUT` shipped as a business outcome; its own open question doubted it. | **Overruled**: `failed / argument-invalid` with `sideEffects: "none-guaranteed"` (§4.2 row 1). |
| Untyped result: `outcome.code: string`, `data: Record<string, unknown>`. | **Fixed** by the graft from `agent-contract-first` (§2.6). |
| `pressKey` has no F-keys at all, so the terminal submit mechanism is inexpressible - while §10 ships `surface-terminal` "to falsify the abstraction". | **Fixed** at the port; the artifact uses `activate` (§2.2, §3). |
| No `Surface.capabilities()`; a browser-derived artifact dies at step 3 rather than at load. | **Fixed** (§2.2, check 17). |
| `wait-out-slow-load` is a sleep with a different name, stacked on a step that already has `settle.maxWaitMs`. | **Fixed**: there is no `wait` remedy (§2.4). |
| Runtime `detector-overlap` resolved by declaration order, answer shipped, run flagged. | **Fixed**: `ambiguous-classification` is a hard stop (§4.6). |
| The fully-expanded `normalize` object repeated 40+ times in a 370-line artifact. | **Fixed** by named versioned registries (§2.1). |
| `StepOverride` widens only `nameAlternatives` and `budgets`; no `addDescriptor`, no way to fix an ordinal. | **Fixed**: `addDescriptors` + `disableDescriptors` (§2.5). |
| No pre/post phase on detectors, so a stale banner is classifiable as this step's outcome. | **Fixed**: `phase` on both rule kinds, outcomes pinned to `post` (§2.4, check 22). |
| `failure.expected` is "verbatim from `Checkpoint.describes`" while `memberId` is sensitive and is a template hole - so the report either leaks the value or is too vague to identify a run. | **Fixed**: `describes` deleted; prose is generated, `ValueRef` renders by *name*, template holes render *unresolved*, runs correlate by `runId` (§4.7). |
| `inputIntercepted: boolean` cannot carry `{type, message}` for the one failure that hangs. | **Fixed**: `Observation.nativeDialog` (§2.2). |
| Example artifact carries a synthetic digest with only a general disclaimer. | **Fixed** repo-wide: synthetic digests are written `sha256:<synthetic>` where they appear. |

### Raised against all three

| Flaw | Disposition |
|---|---|
| `effect` / `effectClass` is **declared, never proven**. The policy chokepoint, the restart gate and the approval blast radius all rest on a field the recorder wrote. | **Accepted, named** - `SPEC.md` §12.3 limit 1, with a browser-only heuristic, a human tick, and an audit record as partial mitigations. Only `interpreter-first` had raised it. |
| No concurrency story. | **Accepted, named** - §12.3 limit 8. Out of scope per the anti-goals; silence would be worse than the gap. |
| The native-dialog hang. | **Fixed** - see §5 spike table above. |

---

## 6. What this record is for

Two things. First, so that a reviewer who disagrees with a decision can find the argument on both
sides rather than reverse-engineering it from the type. Second, so that the decisions taken
*against* the winning proposal - a fourth status, `argument-invalid` as a failure, no `oneOf`
widening, no `wait` remedy, no first-declared-wins - are on the record as deliberate overrules with
a named reason, rather than looking like drift.
