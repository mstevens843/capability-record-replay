# FINAL-STATUS — the true state of `capability-record-replay`

**This document feeds `/REPORT.md`. Nothing in it is a claim; every number is followed by the command
that produced it, and every command in it was run in this working tree on 2026-08-27** — except
where a line says otherwise, in which case it says who ran it and when. **No live model API call was
made by this pass, to any provider.** Where an earlier revision asserted something this pass could
not reproduce, the discrepancy is stated rather than smoothed over — §11.

**Read §7 (what does not work) before §1 (the green board).** The board is green and the live
discovery run happened; §7 is why neither of those is the same as "done".

---

## 0. The one-paragraph version

A model drove a hostile legacy back-office fixture over the Anthropic Messages API, reached a goal
in **9 turns for $0.14**, and the recording it produced was synthesized into a typed, parameterized,
content-addressed capability that then **replayed itself with the model out of the loop** and became
a `draft`. That is the whole thesis of the assignment, executed once, end to end, with the evidence
in `evidence/discovery-live/`. It took **three attempts**; the first two failed on defects that only
a real provider could have found, and both of those defects are now pinned by tests. The single
biggest threat to everything else in this document is that **the application it all ran against is
one we built ourselves**, and a fixture you control cannot surprise you the way a vendor's product
will.

---

## 1. Headline

```
$ TURBO_FORCE=1 pnpm build          →  Tasks: 8 successful, 8 total     5.488s   exit 0
$ TURBO_FORCE=1 pnpm typecheck      →  Tasks: 14 successful, 14 total   5.77s    exit 0
$ pnpm lint                         →  Checked 316 files in 84ms. No fixes applied.  exit 0

$ env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY \
      -u CLAUDE_CODE_OAUTH_TOKEN TURBO_FORCE=1 pnpm test
                                    →  1,843 passed, Tasks: 14 successful, 14 total  exit 0

$ env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY \
      -u CLAUDE_CODE_OAUTH_TOKEN pnpm demo
                                    →  7/7 exhibits PASS, 67 files, 10s,
                                       whole-bundle canary CLEAN, 0 hits          exit 0
```

**1,843 tests across 103 files in 8 workspace members. All pass with every credential variable
unset.** `pnpm demo` needs no credential of any kind — one local Chromium and one free TCP port.

> **One caveat on `pnpm lint`, and it is this pass's own fault.** The 316 above was measured before
> this pass wrote two throwaway drivers — `packages/conformance/.corpora.mts` (to re-run the
> terminal and combined kill matrices, §5.2) and `packages/runtime/.ovcount.mts`. `rm` is denied to
> every agent in this tree, so neither could be removed; both had their bodies replaced with
> `export {}` and a delete instruction, and lint is green at **`Checked 318 files`**. Deleting them
> returns the count to 316. **One of the two was swept into commit `0cd98f9` by a concurrent agent
> before it could be reported.** See §9 — this is the first thing to fix before pushing.

### The live discovery run — it happened

```
$ pnpm discover --yes        (the author's command, run 2026-08-28T02:24:10.144Z)
```

Everything below is read out of `evidence/discovery-live/provenance.json`, `spend.json` and
`discovery.log` in this working tree, not from memory:

| | |
|---|---|
| adapter / model | `anthropic` / **`claude-opus-5`**, effort `high`, `max_tokens` 2,000 |
| turns | **9** |
| billed tokens | **42,368** (18,220 input + 1,540 output + 22,608 cache read + 0 cache write) |
| cache hit rate | **55.4%** |
| measured spend | **$0.140904** against a $2.00 run cap and a $10 project cap |
| outcome | `reached-goal`, 3 steps recorded, 3 outputs noted |
| verification replay | `verified` / grade `full`, covered through the last step, arm `ok` |
| lifecycle | `proposed → draft`, **because a replay succeeded, not because a field was set** |
| redaction canary | passes 1–3 **CLEAN and gating**; pass 4 (the recording) **reported, 49 hits, all the member number** |

The **verification replay is the load-bearing half**: the same artifact synthesis had just emitted
was executed with no model anywhere in the decision path, against the same live fixture, seconds
later. Read out of `evidence/discovery-live/verification-journal.jsonl` this pass:

```
$ python3 <count events by type in verification-journal.jsonl>
  link.completed 1 (checksRun 28, errors [])   step.entered 4   settled 4   checkpoint 4
  resolved 3   policy.decided 3   acted 3   extracted 3   classified 8   observed 8
  budget.charged 20   run.finished 1 (status "ok")
```

- **3 targets, 3 `resolved` events, every one `agreed: true`**, with 2, 3 and 4 independently
  computed descriptors respectively and no `disagreed` verdict.
- **4 checkpoints, 4 passed.**
- **3 policy decisions, all `allow: true`**, each naming the allowlist rule it matched
  (`route:corebank/search`, `route:corebank/search/results`).
- The one action carrying the caller's argument journals
  `"valueRef": "taint:memberId-1", "valueLength": 5` — **a handle and a length, never the value.**

---

## 2. Per package

| Package | Tests | Test files | `src` | What it establishes |
|---|---:|---:|---|---|
| `@crr/core` | 788 | 36 | 39 files / 15,293 lines | Schema, canonical JSON + digest, the **28-check linker**, the classifier, the target resolver, the extractor, overlay merge, the policy chokepoint, the prose renderers. Pure — no clock, no I/O, no randomness, no driver import, enforced by a source-scanning contract test verified by injection. |
| `@crr/runtime` | 314 | 21 | 29 / 9,942 | Interpreter, settle loop, budget ledgers, control lease, journal writer, evidence sink, file store, catalog/`invoke`, ed25519 approval verification, operator console, the `crr` CLI, the redaction canary, `pnpm demo`. |
| `@crr/discovery` | 305 | 15 | 20 / 7,953 | Provider port, manual Anthropic loop, OpenAI adapter, VCR transcript record/replay, synthesis, parameter naming, **prose withholding**. The only package that may import a model SDK. |
| `@crr/surface-browser` | 107 | 12 | 11 / 2,501 | Per-frame CDP `Accessibility.getFullAXTree` stitch → `Observation`, dialog ownership, `perceive` deadline, PNG mask. |
| `@crr/surface-terminal` | 125 | 9 | 10 / 2,446 | `@xterm/headless` over a `TerminalTransport` port → `Observation` from an 80×24 character grid. |
| `@crr/conformance` | 102 | 8 | 16 / 5,039 | 25 browser + 14 terminal scenarios × 10 engines (1 reference, 9 mutants), the meta-test, multi-run stability, the `stableSamples` sweep, the cross-workspace name ledger. |
| `fixtures/corebank-web` | 66 | 1 | 1,971 lines | Frameset, nested layout tables, generated ids, `<font>`, no test ids, two confirmation channels, a real non-idempotent commit, 8 injectable faults, 2 tenant variants. |
| `fixtures/corebank-tui` | 36 | 1 | 970 lines | 80×24 green screen, 4 fault modes in 2 families, 2 tenant variants. |
| **Total** | **1,843** | **103** | | |

Command for every count: `env -u … TURBO_FORCE=1 pnpm test` (per-member `Tests N passed (N)` and
`Test Files N passed (N)` lines); `find packages/<p>/src -name '*.ts' | wc -l` and
`cat $(find …) | wc -l` for the sizes.

`@crr/discovery` moved **282 → 305 tests** and **7,468 → 7,953 `src` lines** since the previous
revision, and all 23 of the new tests are in one file: `test/synthesis-prose.test.ts` (§3.4). The
other changes of §3 are edits to tests that already existed — `tool-schema.test.ts`'s digest pin,
which *failed* and had to be updated, and the synthetic transcript fixture that carries the tool
schema — so the count moved by exactly the size of the new file.

**Nothing was weakened, skipped or deleted to make room**, and that is mechanical rather than
promised:

```
$ grep -rn 'it\.skip\|test\.skip\|describe\.skip\|\.todo(' packages/*/test fixtures/*/test \
      --include='*.ts' | wc -l
  14
```

All fourteen are the Chromium guard (`const describeBrowser = CHROMIUM ? describe : describe.skip`,
`describe.skipIf(!chromiumAvailable())`). There is no unconditional skip and no `.todo` in the suite.

### Four files outside `src/`, on purpose

`packages/discovery/tools/` holds the entry points. They are not on any barrel, not in the built
library, not counted above; `tsconfig.json` includes `tools/**/*.ts` so `pnpm typecheck` reads them,
and biome reads the whole tree so `pnpm lint` covers them.

| File | Lines | What it is |
|---|---:|---|
| `discover.ts` | 1,641 | `pnpm discover` — the runner that performed the live run. |
| `preflight.ts` | 1,121 | `pnpm preflight` — the readiness check that makes no model call. |
| `bundle.ts` | 350 | The four files a run must not lose, written by one function with no status check. |
| `live-run.ts` | 291 | Goal, tenant, allowlist, `MODEL_RATES`, budgets, and the hand-authored capability prose. |

Build output, `TURBO_FORCE=1 pnpm build`:

```
core             ESM 325.39 KB   declarations 287,298 bytes across 39 files (tsc, per-file)
runtime          ESM  84.07 KB   (+ cli.js 12.62 KB, codegen-cli.js 3.06 KB)   DTS  96.02 KB
discovery        ESM 145.44 KB   DTS  92.35 KB      (was 137.99 / 85.70 before prose.ts)
conformance      ESM 116.82 KB   DTS  54.56 KB
surface-browser  ESM  55.39 KB   DTS  24.08 KB
surface-terminal ESM  50.74 KB   DTS  21.95 KB
```

`packages/core/dist/index.d.ts` is **1,229 bytes** over **39** per-file declarations, measured this
pass (`ls -la packages/core/dist/index.d.ts`; `find packages/core/dist -name '*.d.ts' | wc -l`).
It was 14.42 MB when tsup rolled the declarations up into one file.
`core/test/declaration-size.test.ts` (5 tests) is what keeps it there.

### The board without a browser

```
$ env -u ANTHROPIC_API_KEY … PLAYWRIGHT_BROWSERS_PATH=<empty dir> TURBO_FORCE=1 pnpm test
    @crr/surface-browser   Tests   78 passed |  29 skipped (107)
    @crr/runtime           Tests  298 passed |  16 skipped (314)
    @crr/conformance       Tests  101 passed |   1 skipped (102)
    (the other five members unchanged)      Tasks: 14 successful, 14 total     exit 0
```

**A reviewer who runs `pnpm install && pnpm test` without `pnpm exec playwright install chromium`
gets 1,797 passing tests and a green board**, and every test that has ever touched a real browser is
among the 46 skipped — including the four that execute a synthesized artifact (§7.3) and the four
that open a real sub-account (§7.4). The guards print to stderr and the seam test prints a second,
more specific line. That is still the only signal, and it is why `/README.md`'s setup section says
`playwright install chromium` is not optional.

---

## 3. The live run, in full — including the two attempts that failed

This is the section that did not exist in the previous revision, whose §7.1 opened *"There is no
live discovery run."*

### 3.1 Three attempts, and what the first two bought

The runner writes into one `--out` directory, so **no bundle from either failed attempt survives on
disk**. What survives is three source comments naming them and the regression pins that were added
because of them — which is the right thing to have kept, and is checkable:

**Attempt 1 — the provider refused our tool schema, before a single token was billed.**

```
packages/discovery/src/tools.ts:170
  //   tools.1.custom: Invalid schema: Enum value 'Enter' does not match declared type
  //   '['string', 'null']'
  // A union `type` array is accepted on its own … but not in combination with an `enum` …
  // Found on the first live run (req_011CeUK5RB1g), which no local test could have caught:
  // this shape is only ever judged by the provider.
```

`act.key` was `{ type: ["string","null"], enum: [...KEYS, null] }` — valid JSON Schema, and refused
under `strict: true`. It is now
`{ anyOf: [{ type: "string", enum: [...KEYS] }, { type: "null" }] }`. The tool-surface digest pin in
`test/tool-schema.test.ts` **failed, which is what it is for**, and was updated with the reason
written next to it:
`sha256:0421eff6… → sha256:d8f50803…`.

**Attempt 2 — we were strict-validating a schema we do not own.**

```
packages/discovery/src/transcript.ts:79
  // Found on the second live run: Anthropic returned a `tool_use` block carrying a `caller` key
  // (programmatic tool calling) and `z.strictObject` rejected it AFTER the turn had been paid for.
  // Strict-validating someone else's schema converts their additive, backwards-compatible change
  // into our outage — and it fails on a path where the money is already spent.
```

Four response block schemas — `text`, `thinking`, `redacted_thinking`, `tool_use` — moved from
`z.strictObject` to `z.looseObject`. **The blocks we author stayed strict**, and the asymmetry is
the point: we may forbid a stray key in our own documents and may not forbid the provider growing a
field in theirs. The field is real and is in the committed evidence:

```
$ grep -c '"caller"' evidence/discovery-live/transcript.json
  9                     # one per turn, e.g.  "caller": { "type": "direct" }
```

**Be precise about what the two failures cost.** Attempt 1's request was rejected by the provider,
so nothing was billed for it. Attempt 2's parse threw on a response the provider had already
produced, so **the run's ledger recorded $0.00 while at least one turn had in fact been billed** —
this repository's arithmetic cannot see a turn it failed to parse, and the authority on what was
charged is the provider's console, not `spend.json`. Both attempts exited non-zero **and wrote their
transcript, ledger, provenance and README anyway**, because the durability fix (§3.3) was built
before the money was spent rather than after.

### 3.2 The cost model met reality, and was wrong in the direction that matters

`pnpm preflight` prices a run before it happens. Every input to that estimate is read from the
shipping source; exactly one symbol is assumed — `U`, output tokens per turn,
`DEFAULT_ASSUMED_OUTPUT_TOKENS = 800` at `tools/preflight.ts:110`, overridable with
`CRR_PREFLIGHT_OUTPUT_TOKENS`. The previous revision recorded that as "the only symbol in its model
that is not measured". **It is measured now:**

```
$ python3 <sum outputTokens over the 9 turns in evidence/discovery-live/spend.json>
  1,540 output tokens / 9 turns = 171 per turn
```

**171, against an assumed 800.** The assumption was 4.7× high, which is the safe direction for a
guard and the wrong direction for a plan: it is why the printed "realistic expectation" of
$0.30–$0.80 for an 8-turn opus-5 run overshot the actual **$0.14 for nine turns** by a factor of
two to six. The estimate was a ceiling that read like a forecast.

**And the cache prediction was wrong in the other direction.** The previous revision reported, from
preflight's table, that *"prompt caching saves almost nothing on this loop"* — because only the
system prompt and the tool definitions carry a breakpoint, so the growing message history is
re-billed at full input price every turn. **The structural half of that is confirmed by the run**:
input tokens grew 180 → 423 → 900 → 1,995 → 2,147 → 2,272 → 2,399 → 3,464 → 4,440 across the nine
turns, none of it cached. **The dollar half was wrong for a run this short.** Using the shipped
constants (`CACHE_READ_MULTIPLIER = 0.1`, `rate.input = 5`, `tools/live-run.ts`) and the shipped
`costOf()`:

```
measured                                             $0.140904
the same usage with cacheRead re-priced at 1x input  $0.242640
                                                     ─────────
saved by the 2,512-token cached prefix, read 9x      $0.101736   (42% of the no-cache cost)
```

That is this repository's arithmetic over the provider's own token counts, not an invoice. It is
large here because the static prefix is 2,512 tokens against a history that only reaches 4,440;
on the 24-turn full-budget run preflight was pricing, history dominates and the saving is small.
**Both statements are true of different runs, and the previous revision stated the second as though
it were general.**

> **The honest caveat on 55.4%, and it is not small.** Every one of the nine turns reports
> `cacheCreationInputTokens: 0` and `cacheReadInputTokens: 2512` — **including turn 1**. A cold
> first turn would have *written* the prefix and read nothing. So the prefix was already warm when
> this run started, paid for by an attempt inside the cache's TTL, and **a first-ever run of this
> loop would show both a lower hit rate and a cache-creation charge.** The 55.4% is a real measured
> number for the run that produced the evidence and is not the number a reviewer would see on a
> cold start.

### 3.3 Why both failed attempts still wrote the evidence they had paid for

This is the reason attempts 1 and 2 are a paragraph in this document rather than a hole in it, and
it was built **before** the money was spent.

`runDiscoveryLoop` used not to catch a `DiscoveryModelError`. A rate limit, a 400 or a dropped
connection propagated out to `discover.ts`'s outer `catch`, which printed `FAILED:` and exited 1 —
at which point `transcript.json`, `spend.json`, `provenance.json`, `README.md` and `discovery.log`
**had not been written**, because every one of them is written after the loop returns. The only
durable record of a partly-paid run was `journal.jsonl`. The loop's own budget probe already stated
the principle — *"a budget guard that throws away the transcript it was protecting has spent the
money and kept nothing"* — and the budget path honoured it while the exception path did not.

`src/loop.ts` now wraps the turn cycle and ends the run with status **`failed`** carrying a
`DiscoveryFailure { name, message, adapter, turn, stack }`. The catch is deliberately **not**
narrowed to `DiscoveryModelError`: a dropped socket, a journal sink that could not write and a bug
in the file are all *"the run ended and here is what it had"*. It is **opt-in**
(`onUnexpectedError: "keep-the-run"`, `tools/discover.ts:1199`) because the VCR's strict digest check
exists to be loud when a fixture stops matching the prompt — so only the caller that *paid* for the
turns may say that keeping them beats failing loudly, and that caller says it at the call site. A
test reads `discover.ts` off disk and fails if it ever stops saying it.

`tools/bundle.ts` is the other half: the four files a run must not lose are written by one named
function with **no status check and no early return anywhere in it**. They used to be forty lines of
`writeJson` in the middle of the `try` a provider error jumped straight out of, and a script with
top-level `await` and `process.exit` in it cannot be imported, so nothing could assert the bytes
reached the disk.

```
$ env -u … pnpm -F @crr/discovery exec vitest run test/loop-failure.test.ts
   ✓ test/loop-failure.test.ts (18 tests) 46ms                                   exit 0
```

It injects a `DiscoveryModelError` at turn 3 of a scripted run through the real recorder and the
real loop, then writes the bundle through the same function the runner calls, and asserts — **in the
order the money leaves** — that the run comes back `failed` naming the adapter and the turn; that
the step turn 2 recorded is still there; that `transcript.json` is **on disk** holding turns 1 and 2
with the provider's per-turn usage; that `spend.json`'s `totalUsd` equals `costOf()` over exactly
those two turns; that `provenance.json` says `"status": "failed"` and carries **no stack** (a stack
has absolute paths in it and `discovery.log` is committed); that `README.md` opens with *"This run
ended on an error"*; that `discoveryExitCode()` is **1** even with `verified: true` and a clean
canary; and that a value bound to a sensitive parameter appears in none of the four files.

One accounting point those files make visible, and it is the same one §3.1 has to be careful about:
**the transcript holds the turns the provider *answered*.** A request that raised returns no
response and no `usage`, so the failing turn is in `run.turns` and in `provenance.run.failure.turn`
but **not** in `transcript.turns` and not in the ledger. `provenance.json` carries both numbers side
by side so the gap is something you can read rather than infer — which is exactly why attempt 2's
`$0.00` is a statement about our ledger and not about the invoice.

### 3.4 The canary caught a third leak, and `artifact.json` and `contract.json` were clean

The first live run's redaction canary **failed pass 1** on `synthesized/report.json`. The two
content-addressed, signed documents were clean, and that distinction is the finding:

```
packages/discovery/src/synthesis/prose.ts  (header)
  // `artifact.json` and `contract.json` were clean - every value in them is derived, and the one
  // place model wording reaches them goes through `parameterizeText`. The report was the document
  // that carried the model's `finish` prose VERBATIM:
  //     "title": "Member 10043 found and active"
  //     "why":   "The search results row showed 10043 / <a member's name> / <their balance> / ACTIVE"
```

**Parameterization is structurally incapable of catching this**, and that is the point worth
carrying into `/REPORT.md` §6. `values.ts` replaces values that were **bound** — the member number
came from the goal, so it was bound, and a substitution would have found it. **The member's name and
their balance were never arguments.** `inferParameters` never saw them; `parameterizeText` walks
straight past them. That is the boundary of what a substitution can do, and it is only visible in
prose the model wrote about what it *saw*.

`packages/discovery/src/synthesis/prose.ts` (263 lines, 23 tests) is the answer, and its rule is
**withhold, never edit**:

1. `parameterizeText` first, with the run's bindings — exact, and it handles every caller argument.
2. Then test the result against **every value the run declared as an output**. A `note_output` call
   is the model saying "the caller needs this back"; it is member data by definition.
3. If anything survives, replace the **whole field** with a marker naming which output *class* it
   carried and never the value.

There is no honest third option. Replacing the spans you can find leaves the ones you cannot — a
paraphrase, a partial quote, `15,900.00` reformatted to `15900` — and produces a sentence that
*looks* scrubbed, which is worse than one that is visibly incomplete, because a reviewer stops
reading it.

It is applied at four sites, and the type system enforces the fourth:
`SynthesisReport.outcomeCandidates` is now `ReportedOutcomeCandidate[]`, structurally **not** an
`OutcomeCandidate`, because `withheld` is required — so
`report: { outcomeCandidates: run.outcomeCandidates }`, which is exactly the assignment that
shipped the defect, no longer compiles.

Read out of the live run's own `synthesized/report.json` in this working tree:

```
"code": "MEMBER_FOUND_ACTIVE",
"title": "WITHHELD: the model's wording here quoted a value this run recorded as the output
          \"membershipStatus\" …",
"why":   "WITHHELD: … the output \"memberName\", \"shareBalance\", \"membershipStatus\" …",
"withheld": [ { "field": "title",  "outputs": ["membershipStatus"] },
              { "field": "why", "outputs": ["memberName","shareBalance","membershipStatus"] } ]
```

The **symbolic code survives**. `MEMBER_FOUND_ACTIVE` is `SCREAMING_SNAKE` by regex and is the
machine-readable half a reviewer needs in order to go and write the detector; withholding it to hide
a word that is also ordinary English would throw away the candidate to protect nothing. Instead an
`outcome-code-carries-recorded-value` note at `review` severity says so. Two distinct cases are
handled differently, and the reasoning is at the site: a **bound** value spelled into a code
(`MEMBER_10043_FOUND`) is substituted, because it can be; an **observed** one (`ACTIVE`) cannot be
substituted into anything that is still a legal outcome code, so it is kept and flagged.

`provenance.json`'s `run.summary` gets the same treatment, from `tools/bundle.ts`, and the live
bundle shows it working — that file's `summary` field is a `WITHHELD:` marker. **It is also the one
file no gating canary pass searches for values; see §7.2.**

### 3.5 Money was being serialized as a float, and a redaction canary cried wolf 14 times

The spend ledger recorded `turnUsd: this.spentUsd - before`. That is IEEE-754 subtraction over rates
like `5/1e6`, and it produces values like **`0.014200999999999998`**.

That is not a rounding nit. `pnpm demo`'s whole-bundle canary greps `evidence/` for the fixture's
`ABSENT_MEMBER_ID`, `"99999"` — and `0.0142009999999999_98` contains it. **A run of nines from float
representation was reported as a leak of a member id, 14 times.** A redaction check that cries wolf
gets ignored, and an ignored canary is worse than none.

Fixed at `tools/discover.ts:588` by rounding to the microdollar **at record time, not at print
time**, with both reasons written at the site. Every `turnUsd` and `runUsd` in the committed
`spend.json` is now six decimal places or fewer.

### 3.6 What the live run did *not* establish

- **One goal, one application, one tenant, one surface.** A single 9-turn run on a fixture we wrote.
  It establishes that the composition root works end to end against a real model; it establishes
  nothing about how the loop behaves on an application it has not been tuned against.
- **No OpenAI run.** BRIEF §6 wanted one additional discovery run through the OpenAI adapter so that
  "the loop is not provider-coupled" would be a *measured* result. It has not been done. The adapter
  is real and has 26 tests over an injected `fetch`; the claim remains structural.
- **The spend cap never bound.** $0.14 against a $2.00 ceiling. See §7.5.
- **No `stuck` run, no escalation, no refusal.** The model never hit the policy gate, never got
  refused, never asked for help. Every one of those paths is covered by hermetic tests and by the
  conformance corpus; none has been exercised by a live model.

---

## 4. The five contract tests that hold the architecture up

All five scan the repository off disk, all five carry a discrimination suite, and all five have had
their file selection verified by injecting a violation into a **real** module.

| Test | Scope | Enforces | This pass |
|---|---|---|---|
| `core/test/purity.test.ts` | `packages/core/src` | No `Date`, `Math.random`, `fetch(`, `node:`, `process.env`, `setTimeout`, `setInterval`; allowlisted imports only. | `15 passed` |
| `core/test/no-locator-vocabulary.test.ts` | `core`, `runtime`, `discovery`, `conformance` | No `querySelector`, `css`, `xpath`, `getElementById`, `innerHTML`, `[data-`; **and** no import of any driver or driver library. Checks its own package list against the workspace. | `14 passed` |
| `core/test/policy-chokepoint.test.ts` | the whole repository | Every `Surface.act` call site is immediately preceded by a `check` on the same action whose decision is read. | `15 passed` |
| six `test/barrel.test.ts` | one per package | Every module reachable; no name owned by two modules; every value live at runtime. | green in the full run |
| `conformance/test/barrel.test.ts` | all six `packages/*` | No exported name owned by two packages except four ledgered ones. | `12 passed` |

**The four real dispatch sites, re-derived off disk this pass** (`grep -n` for `.act(`):

```
packages/runtime/src/interpreter.ts:578      the interpreter's own action
packages/runtime/src/interpreter.ts:1090     the remedy path
packages/runtime/src/intervention.ts:532     a HUMAN's action through the operator console
packages/discovery/src/loop.ts:546           the MODEL's action during discovery
```

All four guarded. **The model's action during a live discovery run and a human's action through the
operator console pass the same gate as the interpreter's**, and the live run's journal is where that
stops being a design claim: `policy.decided` appears 3 times in `evidence/discovery-live/journal.jsonl`
and 3 times in `verification-journal.jsonl`, once per dispatch on each side.

`packages/core/src/linker.ts:86` still reads `LINK_CHECK_COUNT = 28`, and the live verification
replay journals `link.completed { checksRun: 28, errors: [] }`.

**The `src/` scan does not read `packages/discovery/tools/`**, and that is worth being exact about
because the runner is the file that drove the browser. `packageSources` filters to
`packages/<p>/src/`. Two consequences: the **chokepoint** test does cover it (it uses `repoSources`,
which walks every non-test `.ts` under `packages/`, `apps/`, `examples/`, `fixtures/`); and the
runner keeps the `src/` scan's claim true by **depending on nothing** — `@crr/discovery` declares
neither `playwright` nor `@crr/surface-browser` nor `@crr/runtime`, so `tools/discover.ts` resolves
all four by path at runtime. The cost of that is named at §7.13.

---

## 5. The conformance result, in full

Everything in this section was re-run this pass with the shipped command.

### 5.1 The browser corpus — the headline claim

```
$ env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY \
      -u CLAUDE_CODE_OAUTH_TOKEN pnpm -F @crr/conformance stability

25 scenarios: 25 passed, 0 failed, 0 FALSE SUCCESSES

kill matrix: 9 mutants x 25 scenarios
mutant            killed by                     of which false successes
firstMatch        16,17                         17
countQuorum       17                            17
noAssert          18                            -
noSettleGate      13                            13
checkpointFirst   02,03,05                      05
noContinuity      21                            21
noDelta           20                            20
nearestMatch      04,06,08,09,15,21             04,06,08,09,15,21
noProvenance      04                            04
every mutant was killed by at least one scenario                              exit 0
```

**25 scenarios, 0 failures, 0 false successes for the reference engine. 9 mutants, 0 survivors.**
17 kills, **13 of them false successes** — the mutant told a caller `ok`, or told it a business
outcome, for a run that was broken — and 4 misclassifications. **Eight of the nine mutants are
caught by at least one false success**; only `noAssert` is caught purely by the class it reported.
(The previous revision said six. It was wrong; see §11.4.)

`nearestMatch` — the "fallback chain" mutant, the one that converts an ambiguity into a confident
wrong click — is killed by six scenarios and **every one of the six is a false success**. That is
the single most load-bearing row in the table, because a fallback chain is what most locator stacks
ship by default.

The CLI's exit code is gated on
`report.passed && matrix.survivors.length === 0 && flakeRate === 0 && nonDeterministic === [] &&
unstableDescriptors === []`, so `exit 0` above **is** the zero-survivors assertion.

The mutants are the **real** `replay()` — same linker, lease, budgets, journal, session broker —
with exactly one pure decision function replaced through an injection seam. A meta-test enforces
that by function identity: each mutant must weaken exactly one of `classify` / `resolveTarget` and
share `@crr/core`'s own function object for the other. Without that seam they would be stubs, and a
suite that can only tell a real engine from a stub proves nothing.

```
$ env -u … pnpm -F @crr/conformance exec vitest run test/suite-discriminates.test.ts
  ✓ FAILS IF ANY MUTANT SURVIVES THE WHOLE SUITE                            1241ms
  ✓ catches most of them by the answer they give a caller, not by the class  1109ms
    Tests  16 passed (16)
```

The meta-test was verified to fail against a real gap: deleting scenario 21 (the only scenario that
kills `noContinuity`) produced `SURVIVORS (a gap in the suite): noContinuity` and 4 failing tests.
**That injection was not re-run this pass** and stands on the unit that ran it; the tests it
describes are the 16 that just passed.

### 5.2 The terminal corpus — four mutants survive, and that is reported, not hidden

```
$ cd packages/conformance && pnpm exec tsx <runConformance + buildKillMatrix over TERMINAL_SCENARIOS>

14 scenarios: 14 passed, 0 failed, 0 FALSE SUCCESSES

mutant            killed by        of which false successes
firstMatch        T13,T14          T13,T14
countQuorum       T14              T14
noAssert          SURVIVED         -
noSettleGate      SURVIVED         -
checkpointFirst   T03,T04          -
noContinuity      SURVIVED         -
noDelta           T08              -
nearestMatch      T06,T08          T06,T08
noProvenance      SURVIVED         -
SURVIVORS (a gap in the suite): noAssert, noSettleGate, noContinuity, noProvenance
```

**5 of 9 mutants die on the green screen, not 9**, and `terminal-conformance.test.ts` asserts that
number *in both directions* with a written reason (>60 characters, asserted) for each survivor.
Forcing all nine would have meant a fixture that lies.

- **`noSettleGate` — the one that matters.** It classifies against a screen the driver called
  unsettled. A green screen's readiness signal is *silence*, and a torn repaint is silent: the
  driver reports `settled: true` on a half-painted frame. There is no observation where the settle
  flag is false and a verdict hangs on it, so the mutant is **indistinguishable from the reference
  engine**. Scenario T06 makes the same measurement from the other side. **On that surface band B0
  cannot be the gate, which is why the checkpoint has to be.** This is the strongest argument in the
  repository for why quiescence is not readiness, and it is a result rather than an opinion.
- **`noAssert`** needs a target that resolves correctly and is still the wrong thing; this fixture's
  account list is keyed by suffix and every row is the member's own.
- **`noContinuity`** needs the application to land on a different member's record; the fixture echoes
  back the account number it was given.
- **`noProvenance`** needs the same validation banner over a caller's argument *and* over an artifact
  literal; this flow fills exactly one field and it is the caller's.

**The union of the two corpora kills all nine, and this pass ran the union rather than asserting
it:**

```
$ cd packages/conformance && pnpm exec tsx <buildKillMatrix over [...ALL_SCENARIOS, ...TERMINAL_SCENARIOS]>

kill matrix: 9 mutants x 39 scenarios
firstMatch        16,17,T13,T14                of which false successes  17,T13,T14
countQuorum       17,T14                                                 17,T14
noAssert          18                                                     -
noSettleGate      13                                                     13
checkpointFirst   02,03,05,T03,T04                                       05
noContinuity      21                                                     21
noDelta           20,T08                                                 20
nearestMatch      04,06,08,09,15,21,T06,T08                              04,06,08,09,15,21,T06,T08
noProvenance      04                                                     04
every mutant was killed by at least one scenario
COMBINED SURVIVORS (browser + terminal): []
```

25 kills over 39 scenarios, 18 of them false successes. The honest statement: **the suite**
discriminates; **the green-screen corpus alone** does not, for four reasons each of which is a
property of the surface rather than a gap in the effort.

```
$ env -u … pnpm -F @crr/conformance exec vitest run test/terminal-conformance.test.ts
    Tests  10 passed (10)     82.16s
```

### 5.3 Stability, and the `stableSamples` sweep

```
$ env -u … pnpm -F @crr/conformance stability
  25 scenarios x 20 runs: flake rate 0.0%, 0 with a result document that was not byte-identical
  no descriptor changed its verdict between runs of the same scenario
```

- **Flake rate 0.0%** — the proportion of scenarios that were *inconsistent* across runs, not the
  proportion that passed.
- **Result determinism, stricter:** 0 of 25 scenarios produced a `ReplayResultDocument` that was not
  byte-identical across all 20 runs (digest of the whole document, not just the arm).
- **Descriptor instability: 0**, across 15 descriptors and 5,300 consultations. The per-descriptor
  contribution table (re-read this pass) shows `open-link-by-row` carrying 82.4% of 340
  consultations and silent in scenarios 16/18/19; `member-id-field-by-ordinal` 96.0% of 500, silent
  in 17; nine of the fifteen at 100.0%, silent nowhere.

**What this number is not.** The report prints its own caveat and it is the right one: *this
measures the engine over a frozen corpus on a manual clock. A fixture you control cannot surprise
you the way a real vendor app does; it bounds hidden state in the engine, not flake in production.*
Zero over 20 runs is not a reliability claim.

The sweep re-derives `SETTLE_POLICY_DEFAULTS.stableSamples`, which reads **3** at
`packages/core/src/artifact.ts:248` in this tree:

```
case               expected                        n=1        n=2        n=3        n=4
happy              ok                            ok 7p     ok 14p     ok 21p     ok 28p
never-settles      failed:did-not-settle        ok 44p     ok 47p     ok 50p     ok 53p
tear-1             ok                         WRONG 4p     ok 15p     ok 22p     ok 29p
tear-2             ok                         WRONG 4p   WRONG 8p     ok 23p     ok 30p
tear-3             ok                         WRONG 4p   WRONG 8p  WRONG 12p     ok 31p
tear-persistent    failed:checkpoint-failed      ok 4p      ok 8p     ok 12p     ok 16p

LAW: stableSamples = n rejects a tear of up to n-1 consecutive polls, and no more.
measured tear width: 2 consecutive polls
THE EVIDENCE SUPPORTS stableSamples = 3.
AND THE LIMIT: `tear-persistent` is caught at EVERY value, by the CHECKPOINT rather than by the
     settle loop. Raising stableSamples buys one more poll of tear rejected per extra poll per
     step; it does not turn quiescence into a readiness signal, and no value of it would.
```

This constant has been silently reverted once already — a concurrent rewrite of `artifact.ts`
restored the placeholder `2` and **nothing failed**, because the constant is applied by a *recorder*
at emission and never by a validator, so no digest moved. The guard that was missing now exists:
three tests pin **the agreement between the shipped constant and whatever the matrix currently
derives**, not the conclusion. Verified by injection (setting it back to `2` produces
`× is the value this matrix derives … → expected 2 to be 3`) and reverted. The live run's own
verification replay spent `stableSamples: 3` on every step.

---

## 6. The evidence bundle

```
$ env -u ANTHROPIC_API_KEY … pnpm demo

7/7 exhibits PASS
  replay-01-green                    ok        green
  replay-02-outcome-member-not-found outcome   expected business outcome
  replay-03-recovered-interstitial   ok        recoverable condition
  replay-04-failed-app-error         failed    hard failure
  replay-05-failed-session-expired   failed    hard failure
  masked-capture                     3 region(s) blanked
  cli-replay                         exit 0

REDACTION CANARY  CLEAN
  scanned       63 files, 1,205,897 bytes
  searched for  3 value(s) x 14 encodings = 26 distinct needles
  self-test     PASSED - 26/26 planted needles were found
  hits          0     suppressed  0     credentials  0

   67 files in the bundle, produced in 10s
   discovery-live/  a LIVE model run is present - see its own README.md and provenance.json
   whole-bundle canary pass: CLEAN - 67 files, 0 hits                        exit 0
```

**67 files, 1,219,442 bytes on disk** (`find evidence -type f | wc -l`, plus a `os.path.getsize`
sum). All three arms of the taxonomy are exhibited, which is the assignment's specific ask ("at
least one replay that hits an exceptional state and shows how it was classified") answered four
times over.

**`discovery-live/` is now populated and `pnpm demo` leaves it alone.** The line
`── discovery-live ─ a live run is present; PENDING.md not written` is the guard reporting that it
worked. `discoverySlot()` used to write `PENDING.md` (*"This directory holds nothing."*)
unconditionally, on top of a real run, while the runner's own closing message tells you to run
`pnpm demo` next; it is now behind `liveRunPresent()`, and `test/demo-contract.test.ts` (9 tests)
reads `demo/main.ts` off disk and fails if the call is ever unguarded — plus runs the same scanner
against three sources that *do* break the rule, so it is a scanner that can fail.

The canary was verified against planted leaks — plain UTF-8 in a log, percent-encoded bytes in a
JSON result, UTF-16LE appended to a PNG, and a value in a **file name** — 4/4 caught, then reverted.
The `self-test PASSED - 26/26` line is the standing version: it plants every needle in a scratch
corpus on every run and fails if it cannot find them, so the scanner cannot pass by scanning
nothing.

**One thing a reviewer will notice and should not be surprised by.**
`evidence/discovery-live/verification.json` contains `"CHEN, MIN (SYNTHETIC)"` and `"15900.00"`.
That is correct: a replay **result** is the outputs the caller asked for, and canary pass 2 searches
that file for the *caller's argument*, not for the values the capability exists to return. Every one
of them is synthetic fixture data (`fixtures/corebank-web/src/data.js`). What must never carry them
is `synthesized/`, and pass 1 searches there for all three.

---

## 7. What does **not** work, is not proved, or is unresolved

Ordered by how much it costs the submission.

### 7.1 The fixture is our own construction, and that is the main threat to every robustness number here

`fixtures/corebank-web` is a hostile surface *we* wrote: framesets, nested layout tables, generated
ids, `<font>` tags, no test IDs, a modal confirm, eight injectable faults, two tenant variants. The
brief explicitly permits it, and there is a real argument for it — a public demo site **cannot** be
made to time out a session or deny permission on cue, which would make half of assignment §3.3
undemonstrable.

**Say the cost plainly. A fixture you control cannot surprise you.** Every screen the descriptors
were derived against, every fault the classifier is graded on, every tear the settle sweep measured,
and the flake rate itself, are properties of an application whose author also wrote the engine. The
0.0% flake rate bounds hidden state in the engine; it says nothing about a vendor product. The
0-false-success result grades the taxonomy against the faults **we thought to inject**. The one
thing in this repository that was not shaped by that circularity is the *provider*, and the provider
found two defects on the first two live attempts (§3.1) that 1,843 local tests could not.

The honest generalisation claim is narrower than the numbers look: **the engine is correct on the
conditions it was shown, the abstraction survived a second surface that is not a browser, and the
suite can tell a good replay engine from nine bad ones.** Not: this will hold on Symitar.

### 7.2 `provenance.json` is covered by no gating canary pass that searches for values

The runner runs four canary passes. Their scopes, read off `runCanaries()` in `tools/discover.ts`
and confirmed against the live run's own `canary/report.txt`:

| pass | scope | searches for | gates exit code |
|---|---|---|---|
| 1 documents | `synthesized/` (4 files, 71,114 B) | the caller's argument **and every observed output value above the floor** — 3 values × 14 encodings = 34 needles on this run (§7.3) | **yes** |
| 2 replay | `verification*` (5 files, 105,632 B) | the caller's argument — 1 value, 7 needles | **yes** |
| 3 credentials | the whole bundle (20 files, 276,609 B) | credential *shapes* only, 0 value needles | **yes** |
| 4 recording | `transcript.json`, `journal.jsonl`, `discovery.log` (3 files, 58,713 B) | the caller's argument — 49 hits, every one listed with its line number | no — reported |

**`provenance.json` is in pass 3's scope and no other**, so it is checked for keys and never for
member data. That exemption was designed around the *caller's argument* — the file states the member
number the goal supplied as a plain field, deliberately — and it was never meant to cover the
member's **name and balance**, which is exactly what a `finish.summary` like *"the results table
returned one match: <name>, share balance <amount>"* puts there.

The writer was fixed: `tools/bundle.ts` now passes `run.summary` through `scrubProse`, and the live
bundle's `provenance.json` carries a `WITHHELD:` marker rather than the model's sentence. **A fifth
gating pass was deliberately not added**, because at the time it could not have been tested without
spending money on a live run. That reason has now expired — there is a real bundle to test it
against — and the pass still does not exist. It is the highest-value item on the "what I would do
next" list.

### 7.3 Two different needle floors, and the shorter one is not the one that gates

- `packages/discovery/src/synthesis/prose.ts` → `MIN_OBSERVED_NEEDLE_LENGTH = 4`
- `packages/discovery/tools/discover.ts:189` → `MIN_NEEDLE_LENGTH = 8`

Synthesis will withhold prose that carries a 4-character observed value. **The canary that gates the
exit code will not look for one shorter than 8.** On the live run that gap was real and is printed
in the evidence:

```
evidence/discovery-live/canary/report.txt
  NOT SEARCHED, and why:
    membershipStatus: 6 characters, under the 8-character floor for a distinctive needle
```

`ACTIVE` was below the canary's floor. It happens that synthesis's own withholding covered it — both
`title` and `why` were withheld naming `membershipStatus` — so nothing leaked. But the belt is 4 and
the braces are 8, and **a short observed value in a document synthesis did not scrub would ship
CLEAN.** Both floors are judgement calls, both are printed rather than hidden, and they should be
the same number.

### 7.4 The artifact's digest moves when the verification stamp is written, and the bundle records both

`ARTIFACT_DIGEST_EXCLUDED_FIELDS` is `["digest", "signatures", "lifecycle"]`
(`packages/core/src/documents.ts:158`), with a good argument for each: an approval signs the digest
and then lives in `lifecycle.approval`, and deprecating an artifact months later flips
`lifecycle.status` without changing the program. **`verification` is not on that list**, and
`verifyAndDraft` writes `{ mode, status, coveredThroughStep, grade, runId, at }` into the artifact.
So the live bundle names two digests for one document:

```
$ grep -n '923ab02f\|32e56a6f' evidence/discovery-live/*.log evidence/discovery-live/*.json \
        evidence/discovery-live/synthesized/*.json
  discovery.log:71                    artifact digest sha256:923ab02f…   (as synthesized, `proposed`)
  verification.json:42  result.run.artifact.digest sha256:923ab02f…
  synthesized/artifact.json:10                     sha256:32e56a6f…      (as written, `draft`)

$ node <artifactDigestOf() over the file on disk>
  stored     sha256:32e56a6f…
  recomputed sha256:32e56a6f…      intact: true      parses: … lifecycle draft
```

**Nothing is broken** — the file on disk is self-consistent, it parses, and an approval would sign
`32e56a6f…`, which is stable thereafter. But two things follow that are worth writing down:

1. A reviewer comparing the run log to the shipped file sees two content addresses for one artifact
   and nothing in the bundle explains it.
2. `verification.runId` and `verification.at` are **non-deterministic**, so the shipped artifact's
   content address is not reproducible from the recording — even though
   `synthesized/README.md` correctly says synthesis is. By the same argument that excludes
   `lifecycle`, `verification` is mutable state *about* the program rather than the program, and
   belongs on the excluded list. That is a one-line change plus a re-emit, and it was not made here
   because it moves every committed artifact's digest.

### 7.5 The spend ledger's mid-run cap binding has still never executed

The live run **did** exercise the ledger's `record()` path over real provider numbers, nine times,
and produced a per-turn `spend.json` that agrees with `costOf()` to the microdollar. That is new and
it is the thing §7.1 of the previous revision most wanted.

What still has not happened: **the cap binding at turn *n***. The run cost $0.14 against a $2.00
ceiling, so `projectNext()` never returned a stop. Both guards have only ever been *observed* firing
at the turn-0 → turn-1 boundary, under `--dry-run`, where the scripted model reports `ZERO_USAGE` so
the ledger's inputs never move:

```
$ pnpm discover --dry-run --force --max-usd 0.05 --out .scratch/budget-usd
      status  budget-exhausted   turns 0                                        exit 1
$ pnpm discover --dry-run --force --max-total-tokens 100 --out .scratch/budget-tokens
      status  budget-exhausted   turns 0                                        exit 1
```

(Those two are the previous pass's output; this pass did not re-run them, because BRIEF §11 makes
every `pnpm discover` invocation the author's. The bundles are still in `.scratch/`.)

There is also **no unit test for `stopBeforeTurn`**. Re-grepped this pass: the only caller anywhere
in the tree is `tools/discover.ts:1202`. It is the one addition to `src/loop.ts` that the 305
discovery tests do not touch.

### 7.6 `pnpm preflight` has no automated test, and its one assumption was wrong

It is verified by running it, which earlier passes did in three configurations. What keeps it from
drifting is not a test but its inputs: every budget, model id, prompt, tool schema, allowlist and
route it prints is **read from the shipping source** — `DEFAULT_LIMITS`, `DEFAULT_MAX_TOKENS`,
`DEFAULT_MODEL_ID`, `DISCOVERY_SYSTEM_PROMPT`, `DISCOVERY_TOOLS`, `ALLOWLIST`, `ENTRY_ROUTE`, `GOAL`
— not copied into it. The only hand-written numbers are the published rates and the cache
multipliers.

Its one assumed symbol, `U = 800` output tokens per turn, is now measured at **171** (§3.2). The
table it prints was never re-derived against that, and **this pass did not run `pnpm preflight`** —
BRIEF §11 makes every command in that family the author's, and its cost projections are in any case
superseded by a measured run. Its structural findings still stand and one of them is now confirmed
from the other side: the cacheable prefix clears both models' minimum (a previous pass measured it
locally at 2,034 tokens; the provider billed **2,512 cache-read tokens on every one of the nine
turns**, so the breakpoint is doing work rather than silently doing nothing), and the message
history carries no breakpoint.

### 7.7 `resume: "continue"` — a known gap, pinned by a scenario that says so

There is no recovery mode that re-verifies without re-dispatching. Measured consequence: **an
interstitial that appears AFTER a step has acted cannot be recovered.** `retry-step` re-resolves a
target the action already navigated away from, and the engine reports `target-not-found` for a run
that in fact recovered. **Conformance scenario 25 deliberately pins the wrong behaviour** and its
title says so — `KNOWN GAP: an interstitial that appears AFTER the step acted cannot be resumed
today`, `PASS 4/4` in this pass's run — so that the day the mode exists, a test fails and somebody
comes back to it.

`Checkpoint.dialog` (§7.8) did not close this, deliberately: that field is about a dialog a step
**declared** as its own postcondition; this is about one nobody declared, arriving after the act.
They look alike and they are opposites. A single mechanism serving both would have to decide at
runtime which it was looking at, and the whole point of the taxonomy is that a declaration decides
that.

### 7.8 The confirmation dialog — closed, and the argument is worth keeping

**A real sub-account is opened, through the real interpreter, against the real fixture, in a real
browser — and the modal confirmation is what authorizes it.**

```
$ env -u … pnpm -F @crr/runtime exec vitest run test/browser-write.test.ts
  ✓ raises the confirmation, accepts it as the postcondition, and commits exactly once  1901ms
  ✓ dry-runs to the irreversible boundary and does not perform it                       1340ms
  ✓ verifies, drafts, and then invokes - and opens exactly ONE account across both       2872ms
  ✓ still refuses an UNDECLARED dialog on the same widget, and posts nothing             1316ms
    Tests  6 passed (6)
$ env -u … pnpm -F @crr/core exec vitest run test/expected-dialog.test.ts
    Tests  19 passed (19)
```

The decision was `Checkpoint.dialog?: ExpectedDialog` (`{ where: NodeQuery; present: boolean }`)
rather than a `resume: "continue"` recovery mode. **Optional, not `| null`**, so no existing
document's digest moves. `present` carries the licence (B2 stands down) and the obligation (B5
asserts) in one field, so a step cannot claim the first without paying the second.

The stand-down is **four refusals, not a permission**: a step that declared nothing gets none; a
native dialog vetoes it outright; an interception no visible dialog node explains is refused; and
**every** open dialog must be the declared one, not one of them. Refusal 2 is a property of the
channel rather than a cut corner — a native dialog blocks the renderer, so there is no post-act
`Observation` to check a postcondition against, and a postcondition that cannot be checked is not a
postcondition. Measured, not assumed: `surface-browser/test/browser-act.test.ts` drives the
fixture's `?dialog=native` mode and records `perceive` returning `perceive-timeout`.

Closing it uncovered a second real defect that nothing else could have found, because it needs a
dialog to be a *postcondition* before it does any harm: **18 ms after the click that raises the
panel, one `perceive` returned the accessibility tree of the NEW document stitched to the frame tree
of the OLD one** — the driver reads `Page.getFrameTree` before `Accessibility.getFullAXTree` and the
navigation committed in between — so `route` said `/subaccount/new` on the `/subaccount/confirm`
screen and the checkpoint failed a step that had succeeded. `settle()` now short-circuits for a
**native** dialog only; an in-page modal goes through the ordinary quiescence loop where
`stableSamples` catches the tear. Guarded hermetically as well as against the browser
(`runtime/test/cycle.test.ts` has both halves of rule 3).

**The write flow is deliberately not in `pnpm demo`**, and that is a decision rather than a wiring
gap: an irreversible capability's arguments include an amount the application prints back on its own
confirmation screen, and the canary greps every byte of the bundle for parameter values.

**The capability returns no outputs.** The confirmation screen prints the new account number and the
posting reference as unlabelled `<font>` runs inside a LAYOUT table; measured through
`@crr/surface-browser`, every one of those nodes comes back `ariaRole: null` with no `tablePosition`,
so no `NodeQuery` can name them. Returning nothing is the honest answer; inventing an ordinal into a
layout table would be a locator, which is the one thing this design refuses. It is the same driver
gap §7.10 records on the green screen: **two surfaces, one fix — an unlabelled run of body text
should become a `text` node** — and doing it changes node counts that `browser-overlay.test.ts`
asserts, so it is a decision with a blast radius rather than a one-liner. Written down twice, made
nowhere.

### 7.9 The discovery → replay seam — closed, and here is exactly how far it goes

```
$ env -u … pnpm -F @crr/runtime exec vitest run test/synthesized-replay.test.ts
  ✓ parses as a contract and an artifact with no help from the package that wrote it
  ✓ offers a caller an argument named after the screen, not a positional placeholder
  ✓ arrives `proposed` and `unverified`, because a recording is not a claim
  ✓ is refused by the linker in production mode until somebody has approved it
  ✓ verifies itself with the model out of the loop, and only then becomes a draft   2011ms
  ✓ executes every descriptor, checkpoint, budget and effect synthesis derived      1751ms
  ✓ is a capability, not a macro: approved, then invoked for a member the recording
    never saw                                                                       3514ms
  ✓ reports a member the core has no record of as a hard failure, because nobody
    declared an outcome                                                             1241ms
    Tests  9 passed (9)

$ env -u … pnpm -F @crr/discovery exec vitest run test/synthesis-corebank-web.test.ts
    Tests  27 passed (27)
```

**The connection is a file, not a dependency**, and that is the design working: BRIEF §3.9 says the
artifact is data, not code, and a document that needs a function call to cross a package boundary is
not a document. `@crr/discovery` emits to `test/fixtures/corebank-web.capability.json`;
`@crr/runtime` reads it off disk through `parseContract` / `parseArtifact` with no import of
`@crr/discovery` and no shared type. A shared type would make *structural* incompatibility
impossible while leaving **semantic** incompatibility untouched, and semantic incompatibility is
what this was always about.

**Executing what synthesis emits found three real defects, none reachable by any test that only
linked the document.** All three are fixed and guarded:

1. **Recorded member data reached a signed document.** `deriveOutputs` folded a cell's accessible
   name into the query it derived — and on a legacy grid a cell's accessible name **is the value
   being read**. The emitted artifact carried `"ALVAREZ, DANA (SYNTHETIC)"` and `"1,204.55"` in
   `flow.vocabulary`: a member's name and balance in the one document that is committed, diffed and
   **signed**. Parameterization could not catch it — the name was never in the goal, so it was never
   bound to anything. Fixed in `synthesis/outputs.ts`: when row-and-column addressing is available
   it is used **alone**. Re-checked here:
   `grep -c 'ALVAREZ\|1,204.55' packages/discovery/test/fixtures/corebank-web.capability.json` → `0`.
2. **Every delivered string output was case-folded.** `readingOf` returned `normalize: "std.text@1"`,
   which lowercases — right for matching a label against a screen, wrong for a value handed to a
   caller, who would have been read their own name back as `alvarez, dana (synthetic)`. Fixed:
   `std.identity@1` is the default on the delivery path.
3. **The parameter was called `value1`.** Closed before the live run; see §7.11 and §11.1.

**Drift is a red test, not a surprise.** `synthesis-corebank-web.test.ts` rebuilds the committed
capability in process, from the same function the emit script calls, and compares the **bytes** — so
any change under `src/synthesis/` fails the build naming the command that fixes it. There is no path
from "synthesis emits something the interpreter cannot run" to a green board.

**The one honest caveat.** The four executing tests are among the 46 that skip silently without a
Chromium build. Without one, the synthesized artifact is still parsed, digest-checked and linked —
and the file prints a stderr line saying exactly that.

### 7.10 One artifact, two tenants — proved. One contract, two surfaces — **not** proved

```
$ env -u … pnpm -F @crr/runtime exec vitest run test/browser-overlay.test.ts
cross-tenant divergence  riverbend -> summit
screen                    band          left  right  shared  union  divergence
member-search             all              99    103      83    119      30.3%
                          interactive       7      7       6      8      25.0%
member-results            all             130    138     103    165      37.6%
                          interactive       8      9       7     10      30.0%
member-detail             all             159    163     131    191      31.4%
                          interactive       5      5       4      6      33.3%
subaccount-new            all             118    122      94    146      35.6%
                          interactive      11     11       7     15      53.3%
OVERALL                   all             506    526     411    621      33.8%
                          interactive      31     32      24     39      38.5%
needsSpecialization: null (no threshold ships; see OPEN-QUESTIONS-RESOLVED Q4)
      Tests  4 passed (4)
```

One artifact replays green on both tenants through a 12-token vocabulary overlay (of 21 declared),
4 `routeBasePath` entries, 2 `stripTokens`, 2 `settle` overrides — and **no step override, no
detector, no instruction, no outcome**. Without the overlay's vocabulary the run fails
`target-underdetermined` and the drift signal names the exact descriptor that abstained. The metric
is **Jaccard** distance (1 − shared/union), not the terminal spike's 1 − shared/|left|, because the
spike's version reports 0% when one tenant is a strict superset of the other; the departure is
pinned by a test that computes the spike's worked example both ways.

**The cross-surface claim is weaker than "one contract, two programs".** The browser contract
declares a required `memberName` output. The green screen prints the member's name as an unlabelled
plain run (`Member:  12345   AVERY SYNTHETIC`), and `detect()` emits nodes for headings, labelled
fields, legend controls, status bands and tables — **not for prose**. There is nothing for an
`ExtractSpec` to name. Rather than publish a contract the terminal program cannot satisfy, the
terminal declares its own, and `conformance/test/heterogeneity.test.ts` (14 tests, green this pass)
compares the two `activate` steps field by field instead. They are identical: both
`{kind:"activate"}`, both a `role: "button"` + `role-name` descriptor on a vocabulary token. The
same gap forced both ambient detectors to read a screen-id band and a banner heading rather than the
sentences `SESSION HAS ENDED` and `*** ABEND 0C7`, and **a taxonomy that cannot see the sentence
explaining the failure is weaker than one that can.**

What *is* proved, and it is the port-falsification result the terminal surface exists for: one
artifact, one `activate` step, two tenants, and the bytes the driver wrote to the transport were
`"12345\r\x1bOR"` (F3) at riverbend and `"12345\r\x1b[24~"` (F12) at summit. The artifact contains
no F-key and no escape byte. Verified by injection three ways by an earlier pass (driver hardcodes
F3 → 2 tests fail; harness passes `originAlias: null` → the policy chokepoint denies every action on
a routeless surface; linker check 21 short-circuited → the `GATE TWO` test fails). **Those byte
strings are quoted from the previous revision and were not re-printed by this pass**; the 14 tests
that assert them are the ones that just passed.

### 7.11 Parameter naming — closed before the live run, and the live run is the proof

The capability once offered a calling agent an argument named **`value1`**, described as *"The value
to use for `value1`"*, because `inferParameters` named a parameter after the accessible name of the
field it was typed into and **this product's search inputs have no accessible name at all** — which
is the legacy reality the whole project is about, so the `value${n}` fallback fired.

Naming is now a deterministic five-rung chain over evidence the system already had —
`accessible-name` → `labelled-by` → `adjacent-label` → `taint-handle` → `positional`. No model is
asked; nothing is inferred from the *shape* of the value, because a name derived from a value would
put a member number in the caller's public API. Rungs 2 and 3 walk `labelAnchorsOf`, the same
function the `label-anchored` descriptor uses, so **a parameter cannot be named after a label the
locator does not use**. **Rung 5 is no longer silent**: reaching it emits a
`parameter-name-underived` note at `review` severity and stamps `NEEDS A NAME:` into the parameter's
description.

**The live run settles it.** Read out of `evidence/discovery-live/synthesized/contract.json` and
`report.json` in this working tree:

```
"inputs": [ { "name": "memberId",
              "type": { "kind": "string", "charset": "digits" },
              "sensitivity": "sensitive",
              "discoveredFrom": { "goalSpan": "Look up member {memberId} in the riverbend core b" } } ]

"parameters": [ { "name": "memberId", "discoveredFrom": "goal", "namedFrom": "adjacent-label" } ]
```

Fixing it **before** the live run rather than after is what cost nothing: doing it afterwards would
have moved the live artifact's digest and invalidated any approval signed over it.

### 7.12 The `JournalEvent` type does not discriminate

`packages/core/src/journal.ts:65`:

```ts
const event = <T extends z.core.$ZodShape>(type: string, shape: T) =>
  z.strictObject({ ...envelope, type: z.literal(type), ...shape });
```

`type` is typed `string`, so `z.literal(type)` infers `ZodLiteral<string>` and every union member's
discriminant widens. **The wire format is fine** — it really is a `z.discriminatedUnion` and every
event is parsed before it is written — but `event.type === "resolved"` narrows nothing. Knock-on:
`@crr/runtime`'s `JournalEventInput` collapses to a string index signature, and `@crr/conformance`
works around it in one commented place with a test driving a real run so the workaround cannot go
stale silently. The fix is to make the helper generic over the literal (`<const N extends string>`),
and it will surface real errors across `@crr/runtime`.

### 7.13 The runner's view of `@crr/runtime` is a hand-written structural type

`@crr/discovery` must not depend on an interpreter or a driver (§4), so `tools/discover.ts` resolves
`playwright`, `@crr/surface-browser`, the fixture and `@crr/runtime` **by path** at runtime and
hand-types the slice of `@crr/runtime` it uses. `tsc` therefore checks that slice against nothing.
**The only thing that catches a drift between the slice and the real package is running the
runner** — which is what `pnpm discover --dry-run` is for, and why it is worth running before a paid
one. The reasoning is written at the site (`discover.ts:48–56`).

### 7.14 A dry run aimed at `evidence/` is refused, but not before it litters

`assertRealRecording` fires on the destination, so `--dry-run --out evidence/discovery-live` is
correctly refused — but `journal.jsonl` is created in the destination *before* the loop runs and the
refusal happens *after* it returns, so a refused rehearsal leaves a `journal.jsonl` inside the
protected directory. Don't aim a dry run at `evidence/`.

### 7.15 Limits inside the engine, each named at its site

- **Table cells are not coerced to their declared per-column `ValueType`.** `readTable` rows come
  back as `Record<string, string>`, so `accounts[].balance` is the string the grid printed
  (`"1,204.55"`). The terminal flow works around it by reading the share balance a second time as a
  scalar `table-cell` extract, which *is* typed.
- **Classifier rows 8, 13 and 16 infer a failure class from the remedy** (`reauthenticate` →
  `session-expired-unrecoverable`, `escalate` → `entitlement-denied`, else `app-error`) because
  `RecoveryRuleSchema` has no field naming one. Works, tested, but an inference where the spec
  implies a declaration. One optional `classifyAs` field fixes it; `src/classify.ts` names the site.
- **`maxRemediationCycles: 0` makes ambient recoveries inert**, and four of the five fixture steps
  declare exactly that. The linker check an earlier unit asked for — "an artifact declaring ambient
  recoveries has at least one step that can spend one" — **was never added**; the list is still 28.
  Synthesis works around it from the recorder side by deriving non-zero step budgets when it lifts a
  dialog into an ambient rule, so the hazard is **half-mitigated and still unchecked**. The live
  run's artifact has `flow.ambient: []` and a matching `remediations {used: 0, limit: 0}`, which is
  the consistent case rather than the dangerous one.
- **A `fill` bound to a sensitive parameter has no read-back postcondition.** The driver blanks
  `value` for a masked field, so the truncation defence SPEC §3 asks for does not exist for
  sensitive fills. Resolved in favour of the taint model: the check passes and emits a warning — and
  because `RunWarningSchema`'s enum is closed, that warning rides on the `checkpoint` journal event's
  trace rather than on `RunEnvelope.warnings`, **where a caller would actually see it**. The fix is
  one field on the port: a driver reporting the masked field's *length*.
- **`slow-repaint` outside the budget classifies as `no-observable-effect`, not `did-not-settle`.**
  The terminal surface genuinely does settle — it is perfectly quiet — it just settles on the screen
  that was already there.
- **`@crr/runtime` lists `@crr/surface-browser` in `dependencies` and `src/` never imports it.**
  Re-checked this pass: the manifest still carries it, and the only three matches for
  `@crr/surface-browser` under `packages/runtime/src/` are prose in comments. The *code* is clean
  (the contract test enforces it); the *manifest* contradicts the design claim `cli.ts` makes in its
  own header. It belongs in `devDependencies` — a one-line change plus a `pnpm install`, which no
  pass has been permitted to run.
- **`evidence/MANIFEST.json` excludes three things and names two.** Its note says it excludes itself
  and `redaction-canary/`; it also excludes `README.md`. 62 rows against 67 files on disk. Harmless,
  and exactly the kind of imprecision a document about accuracy should not carry.

---

## 8. What is stubbed, and why

Every one is stubbed at a clean seam and says so at the seam. Every row re-checked against the tree
this pass.

| Stub | Where | Why, and what it costs |
|---|---|---|
| **`agent-sdk` adapter** | named in `DISCOVERY_ADAPTERS` (`src/model-port.ts:33`), no implementation | Dev-only by design and must never produce evidence. It runs Claude Code's loop, not ours, so it validates none of our prompt shape, tool schemas, observation serialization or stopping conditions. The live run proves the point from the other side: the two defects that mattered were in our schemas, and only the real API found them. |
| **`openai` model id has no default** | `adapters/openai.ts` | Deliberate. BRIEF §9 forbids writing a model id from memory and there is no OpenAI counterpart to the `claude-api` skill, so `createOpenAIModel` throws unless `modelId` or `CRR_OPENAI_MODEL` is supplied, with an error that says why. The adapter itself is real and has 26 tests. **No live OpenAI run was made**, so provider independence is a structural claim, not a measured one. |
| **No outcome detectors are synthesized** | `synthesis/emit.ts` | SPEC §0.2 forbids inferring one. `contract.outcomes` comes out `[]` — including on the live run — and the model's `finish` candidates ride in `SynthesisReport` with an `outcome-candidate-needs-detector` note at `review`. A generated `detect` predicate for a screen the run never observed is exactly how a false `MEMBER_NOT_FOUND` gets emitted. |
| **`whenToUse` / `whenNotToUse` / `title` / `summary` are not generated** | `synthesis/emit.ts:1253` | Synthesis never writes routing prose; it accepts prose a **person** wrote and otherwise stamps `"NEEDS AN AUTHOR: …"` plus a `prose-needs-author` note. **The live bundle's contract carries real prose because `tools/live-run.ts`'s `LIVE_CAPABILITY` passed hand-written lines in.** Models mis-route far more often than they mis-fill arguments, so a generated line there is a generated routing decision. |
| **`effect-in-doubt` escalates and journals but is not parked** | `interpreter.ts` | It does not appear in the operator console queue; the arm stays `failed`, which is correct (the caller must not retry). Wiring it needs a second kind of parked entry — a live session a human may look at and may never hand back. Seam named in a comment at the site. |
| **Approval key custody does not exist** | `runtime/approval.ts` | Deliberately out of scope. `ApprovalSigner` is a port so a KMS or HSM substitutes cleanly; `ed25519Signer` holds a private key in process memory with **no approver identity, no expiry and no revocation**. Signature *verification* is real (`ed25519Trust`), and the linker compares `approval.over` to the artifact's digest and refuses an unverifiable approval (checks 26/27). **Approval signs a digest and stops.** |
| **No branching in the artifact language** | `artifact.ts` | The flow is a straight line. An optional interstitial is modelled as a *recovery*, not as a branch. That is right for the flows here and it is a real ceiling: a capability whose path genuinely forks on what the application shows cannot be expressed. |
| **`examples/` does not exist** | `pnpm-workspace.yaml:12` lists it | Creating a workspace member needs a `pnpm install`. The demo lives in `packages/runtime/demo/` instead, covered by `test/demo-contract.test.ts` (9 tests). |
| **Desktop (AX/UIA) surface** | not built | A documented seam. The `Surface` port is two operations and the terminal driver is the proof they are not browser-shaped. |

---

## 9. Repository hygiene — no secrets, and five files that must not ship

**`.env` and `.private/` are gitignored, verified rather than assumed:**

```
$ git check-ignore -q .env                     && echo IGNORED   →  IGNORED
$ git check-ignore -q .private                 && echo IGNORED   →  IGNORED
$ git check-ignore -q .private/ASSIGNMENT.txt  && echo IGNORED   →  IGNORED
$ git check-ignore -q .private/BRIEF.md        && echo IGNORED   →  IGNORED
```

**No credential-shaped string appears in any tracked file:**

```
$ git ls-files -z | xargs -0 grep -lE 'sk-ant-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}'
  (no output)
$ git ls-files | grep -c DS_Store    →  0
```

`.env.example` ships variable names and `sk-ant-...` as a placeholder. `.DS_Store` exists in six
directories; all are gitignored and none is tracked. `evidence/discovery-live/canary/report.txt`
records `credentials 0` over all 20 files of the live bundle.

### What is committed, and what still is not

A concurrent agent committed most of the tree at **20:06:55** while this pass was measuring:

```
$ git log --oneline
  0cd98f9 LLM-discovered UI capabilities that replay without a model    ← 71 files
  7d8f052 delete stray file export.mjs
  3d8a5c4 first commit
```

That commit **did** capture the live run (`evidence/discovery-live/`, all 20 files),
`packages/discovery/src/synthesis/prose.ts`, `test/synthesis-prose.test.ts`, `/REPORT.md`, and every
source change of §3. Two things it got wrong, and both are still true of the tree right now:

- **`/README.md` is not committed.** `git ls-files README.md` returns nothing; it is untracked. It
  is the first of the three deliverable paths BRIEF §7 names, and it was written one minute *after*
  the commit. **`git add README.md` before pushing.**
- **`packages/conformance/.corpora.mts` was committed.** That is this pass's throwaway kill-matrix
  driver (§1). `git ls-files` now lists it. **`git rm packages/conformance/.corpora.mts`.**

This document itself and `/REPORT.md` are modified on top of that commit.

### Files that must be deleted, and could not be

`rm` and `mv` are denied to every agent that has worked in this tree, re-confirmed this pass:

```
$ rm -f packages/conformance/.corpora.mts .scratch/corpora.mts
  Permission to use Bash with command `rm -f …` has been denied.
```

None of these affects any test, the build, `pnpm typecheck` or `pnpm lint`. All four are **tracked
and would ship**; `git ls-files | grep -E 'corpora|probe|cost-check'` names all four.

```
git rm packages/conformance/probe.ts             #  474 B. `export {}` + a "DELETE THIS FILE" header.
git rm packages/conformance/src/__probe.ts       #  511 B. Same. On the conformance barrel test's
                                                 #  NOT_ON_THE_BARREL ledger as a DEFECT, boxed in by
                                                 #  two assertions (zero exports, under 800 B) so it
                                                 #  cannot quietly grow back into a module. Delete the
                                                 #  ledger entry with it; the test tolerates absence.
git rm packages/discovery/.cost-check.scratch.ts # 1,565 B, the §7.5 spend arithmetic check. Outside
                                                 #  tsconfig's include; lint-clean; not a deliverable.
git rm packages/conformance/.corpora.mts         #  430 B. THIS PASS created it and the concurrent
                                                 #  commit tracked it. Runnable copy in `.scratch/`.
rm     packages/runtime/.ovcount.mts             #  Also this pass's. UNTRACKED — do not `git add -A`
                                                 #  before deleting it.
```

Gitignored, so they will not ship, but they are on disk:

```
rm -rf packages/core/.scratch/           # probe.ts (1,326 B) + probe2.ts (798 B). Playwright/CDP
                                         # spike code sitting inside the package whose entire claim
                                         # is that it is pure.
rm -rf .scratch/ packages/conformance/.scratch/   # 107 + 1 working files, read by no test, lint or
                                         # contract scan. Includes three `pnpm discover --dry-run`
                                         # bundles, all `adapter: "replay"`, `synthetic: true`,
                                         # `$0.00` — none of them a live call.
```

`/.exports.mjs`, the fifth entry on the previous revision's list, was removed by commit `7d8f052`
and is gone. `.env`, `.private/`, `.scratch/`, `.turbo/`, `node_modules/`, `dist/` and `.DS_Store`
are all gitignored and none is tracked.

### `evidence/` churn, and one thing that is not churn

`evidence/` shows deletions and additions under `<scenario>/observations/` on every `pnpm demo`,
because those files are named by the digest of a journal carrying that run's own timestamps. That is
expected; `git status` after a clean run shows 8 of each.

**What is not expected, and cost this pass half an hour:** running two `pnpm demo` processes
concurrently interleaves `clearOwned()` with the writes and leaves *both* runs' observation files
behind. It happened in this tree today — a bundle reported 73 files, then 75, with up to four
journals in a directory that should hold one. A single clean run reports **67**, and
`find evidence -type f | wc -l` agrees. **Run the demo once, alone, immediately before committing**,
and check that number.

Two files in the live bundle are from the same class of accident and should go:
`evidence/discovery-live/verification-evidence/journal-a3351e3f….json` and `journal-f43258ec….json`
are left over from earlier attempts of the run — `verification.json` references only
`journal-e95e0286….json`. They are clean (canary pass 2 scanned all five files, 0 hits) and they are
enumerated in `MANIFEST.json`, so they are inert. They are also two observation dumps that nothing
in the bundle points at, in the one directory a reviewer will read most carefully. They are now
committed, so removing them means `git rm` and a re-run of `pnpm demo` to rewrite `MANIFEST.json`.

---

## 10. Deliverables

BRIEF §7 names three paths. **All three now exist on disk. Only two of them are committed.**

- **`/README.md` — PRESENT, and UNTRACKED (§9).** Must cover setup, config/keys, how to run without
  live services, and a demo path. Non-negotiable content from this pass:
  `pnpm install` → `pnpm exec playwright install chromium` (**once, and not optional — §1: 46 tests
  silently skip without it**) → `pnpm demo`, which produces all of `/evidence/` with no live service
  and exits non-zero if any scenario misses its declared arm or the canary finds a parameter value.
  Plus the `agent-sdk`-is-dev-only warning, and the two commands that bracket the one that costs
  money: `pnpm preflight`, then `pnpm discover --dry-run`, and only then `pnpm discover --yes`.
- **`/REPORT.md` — PRESENT** and committed. Seven headings, exactly.
- **`/evidence/` — PRESENT** and committed, 67 files, 1,219,442 bytes, **including the live
  discovery run**.

---

## 11. Corrections

Where a claim in the previous revision of this document could not be reproduced, this is what was
found instead.

1. **THE LARGE ONE. The previous revision's §7.1, §7.2, §6 and §12 all rested on "there is no live
   discovery run", and that is false.** `evidence/discovery-live/` holds one: `anthropic`,
   `claude-opus-5`, 9 turns, $0.140904, verified, drafted, canary-clean. Every limitation the old
   §7.1 recorded that is **still** true has been kept and is now spread across §3.6, §7.5 and §7.6:
   no OpenAI run, the spend cap has never bound mid-run, `stopBeforeTurn` has no unit test,
   `preflight` has no automated test. The ones that are no longer true are corrected here rather
   than deleted.
2. **"The synthesized parameter is named `value1`, not `memberId`" is stale and was carried into
   this pass's brief as a live gap.** It was closed before the live run. The live contract offers
   `memberId`, and `report.json` records `"namedFrom": "adjacent-label"`. §7.11.
3. **"`U` is assumed rather than measured" is closed.** 171 output tokens per turn, measured. And
   the assumption it replaces was 800 — 4.7× high. §3.2.
4. **"Six of the nine mutants are caught by at least one false success" is wrong; it is eight of
   nine.** Recounted off this pass's matrix: only `noAssert` is caught purely by a
   misclassification. The 17/13 split is unchanged.
5. **"Prompt caching saves almost nothing on this loop" was stated as general and is not.** It is
   true of the 24-turn full-budget run preflight prices, where history dominates. On the 9-turn run
   that happened, the cached prefix saved $0.10 of a $0.24 no-cache cost. §3.2.
6. **The 55.4% cache hit rate is flattered by a prior attempt.** Turn 1 reports
   `cacheCreationInputTokens: 0`, so the prefix was already warm. A cold first run would show a
   lower rate and a write charge. §3.2.
7. **Per-package counts moved**: `@crr/discovery` 282 → **305** tests and 7,468 → **7,953** `src`
   lines, 14 → **15** test files; total 1,820 → **1,843** across 102 → **103** files.
   `discovery` ESM 137.99 → **145.44 KB**, DTS 85.70 → **92.35 KB**.
8. **`pnpm lint` reads 316 files, not 314.** `prose.ts` and `synthesis-prose.test.ts` are the
   difference. It reads **318** in this working tree because of this pass's own two stray drivers (§1, §9); deleting them returns it to 316.
9. **`pnpm demo` produces 67 files, not 48**, because the live bundle's 20 files are now inside it.
   `934,441` → **1,219,442** bytes. The whole-bundle canary covers all 67.
10. **The "46 tests skip without Chromium" figure holds**, re-measured with
    `PLAYWRIGHT_BROWSERS_PATH` at an empty directory: 29 + 16 + 1. The green-without-a-browser total
    moved 1,774 → **1,797**.
11. **`createAnthropicModel`'s call site moved** `tools/discover.ts:1102` → **`:1113`**, and
    `stopBeforeTurn`'s only caller `:1191` → **`:1202`**. Both are inside the `--yes` branch, and
    the branch order was re-read off the source this pass: transcript-overwrite guard at `:1067`
    (`--force` required, because *"a live transcript is the one file in this repository that cannot
    be regenerated for free"*), fixture boot `:1082`, refusal `:1089`, Chromium `:1103`, client
    `:1113`.
12. **The four chokepoint dispatch line numbers reproduce**: `interpreter.ts:578`, `:1090`,
    `intervention.ts:532`, `loop.ts:546`.
13. **New findings this pass, not in any previous revision**: the artifact's digest moves when the
    verification stamp is written and the bundle records both (§7.4); the canary's needle floor (8)
    is twice synthesis's (4) and it is the canary that gates (§7.3); two concurrent `pnpm demo`
    runs interleave `clearOwned()` and leave both runs' observation files behind (§9);
    `MANIFEST.json` names two of its three exclusions (§7.15).
14. **The tree was committed underneath this pass**, at 20:06:55, by a concurrent agent —
    `0cd98f9`, 71 files. It captured the live run and every source change of §3; it also captured
    one of this pass's throwaway drivers and missed `/README.md`. Both are §9's first two items. A
    consequence for anyone reading the numbers here: `pnpm lint` reports 318 rather than 316, and
    the demo bundle briefly reported 73 and 75 files before a clean single run settled it at 67.
    Every number in this document was taken from a command run in this tree; where a concurrent
    process moved one, the discrepancy is named at the site rather than averaged away.
15. **Everything else in §§1–8 that this pass re-ran, reproduced cell for cell.** 1,843 tests green
    with the four credential variables unset; `pnpm build` 8/8; `pnpm typecheck` 14/14; `pnpm demo`
    7/7 with both canary passes CLEAN; the browser kill matrix, the terminal kill matrix, the
    combined matrix, the flake rate, the per-descriptor table, the settle sweep and the cross-tenant
    divergence table all identical to the previous revision's. What this pass did **not** re-verify
    is the injection experiments §§4–7 describe — the mutant-deletion meta-test, the four-way dialog
    matrix, the three heterogeneity injections, the `stableSamples` revert — nor `pnpm preflight`
    and `pnpm discover --dry-run`, which are the author's commands. Where a section leans on one, it
    says so.

---

## 12. What a reviewer should take from this

**Proved, by a command in this document:** the classifier's three-way split; descriptor agreement as
a detected condition rather than a fallback chain; the single policy chokepoint, covering the
interpreter, the model's own action during a live discovery run and a human's action through the
operator console alike; the typed four-arm result contract; the escalation path; **a conformance
suite with nine weakened engines, zero survivors over the combined 39-scenario corpus, zero false
successes for the reference engine, and a meta-test verified to fail when the suite stops
discriminating**; one artifact replaying green on two tenants of one vendor product through a
non-semantic overlay; and one `activate` step lowering to a click on a browser and to `F3`/`F12` on
two tenants of a green screen.

**And the cycle itself, end to end, with a real model at the start of it.** A model was called over
the network, drove a hostile fixture through the accessibility tree for nine turns, and reached the
goal for **$0.14**. Deterministic synthesis turned that recording into a typed, parameterized,
content-addressed capability that offers a calling agent an argument named `memberId` and returns
three typed outputs. That artifact **replayed itself with no model in the decision path**, three
descriptor sets agreeing on every target, four checkpoints holding, three policy decisions granted,
and the caller's argument reaching the surface as `taint:memberId-1` with a length and no value.
Only then did it become a `draft`. **The promotion is the result of a replay, not a field somebody
set** — that one sentence is the whole design.

**And the things that only reality could teach.** Two of the three live attempts failed, and both
failures were in code 1,843 local tests declared correct: a tool schema that is valid JSON Schema
and refused under `strict: true`, and our own `z.strictObject` applied to a schema we do not own, on
a path where the money was already spent. A third defect — the model's prose about a member's name
and balance landing in a committed report — was caught by the canary, and its fix
(`withhold, never edit`) is the most interesting piece of data handling in the repository, because
it marks the exact boundary where parameterization stops working. A fourth was a redaction check
crying wolf fourteen times over `0.014200999999999998`.

**Not proved, and it is the honest headline:** any of this on an application we did not write. The
fixture is ours, the faults are the ones we thought to inject, and the flake rate is measured
against a clock we control. The provider is the one thing in the loop that was not — and it broke us
twice.

**Do not read the green board as completeness.** 46 of 1,843 tests are browser-conditional and skip
silently; four of nine mutants survive the green-screen corpus for reasons that are properties of
the surface and are written down rather than papered over; `provenance.json` is searched for
credentials and never for member data; the canary cannot see a leaked value shorter than eight
characters; the spend cap has never bound mid-run; approval signs a digest and there is no key
custody story; the artifact language has no branch; and `pnpm preflight` has no test.
