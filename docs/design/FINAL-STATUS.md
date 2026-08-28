# FINAL-STATUS — the true state of `capability-record-replay`

**This document feeds `REPORT.md`. Nothing in it is a claim; every number is followed by the command
that produced it, and every command in it was run in this working tree on 2026-08-27.** Where a unit
report claimed something this pass could not reproduce, the discrepancy is stated rather than
smoothed over — see §11.

Read §7 (what does not work) and §8 (what is stubbed) before §2 (the green board). The board is
green; §7 is why that is not the same as "done".

---

## 1. Headline

```
$ TURBO_FORCE=1 pnpm build          →  Tasks: 8 successful, 8 total     6.103s   exit 0
$ TURBO_FORCE=1 pnpm typecheck      →  Tasks: 14 successful, 14 total   6.210s   exit 0
$ pnpm lint                         →  Checked 310 files in 91ms. No fixes applied.  exit 0

$ env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY \
      -u CLAUDE_CODE_OAUTH_TOKEN TURBO_FORCE=1 pnpm test
                                    →  Tasks: 14 successful, 14 total   1m33.667s exit 0

$ env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY \
      -u CLAUDE_CODE_OAUTH_TOKEN pnpm demo
                                    →  7/7 exhibits PASS, 48 files, 10.3s, canary CLEAN, exit 0

$ pnpm preflight                    →  NOT READY, 2 blockers, 11 checks passed  exit 1
      (no credential in this shell; with a well-formed key exported it is 1 blocker, 12 passed)
```

**`pnpm preflight` is new in this pass and its non-zero exit is the finding, not a fault** — see
§7.1. It is the live-run readiness check: it boots the fixture, builds the exact request the
discovery loop would send, prices it on two models, prints the policy allowlist, and makes **no
model call of any kind**. Its blocker on a machine that HAS a key is that nothing in the repository
can make the call — see §7.1.

**1,785 tests across 101 files in 8 workspace members. All pass. No live model API call was made at
any point in this pass, to any provider.**

The count moved 1,726 → 1,759 when §7.2 was closed (25 tests in
`packages/discovery/test/synthesis-corebank-web.test.ts`, 8 in
`packages/runtime/test/synthesized-replay.test.ts`), and 1,759 → 1,785 when §7.3 was closed: 19 in
`packages/core/test/expected-dialog.test.ts`, 6 in `packages/runtime/test/browser-write.test.ts`,
and one added to `test/cycle.test.ts` for the settle-loop defect that closing it uncovered.
Nothing was weakened, skipped or deleted to make room for any of them. **The verification pass that
added `pnpm preflight` added no tests either, and weakened none: the suite was run before and after
its changes and returned 1,785 both times**, at the same per-package counts in §2's table.

**One honesty caveat on the credential-unset run, which no earlier unit report stated.** This
machine had **no credentials in the shell to begin with** —

```
$ echo "${ANTHROPIC_API_KEY:+YES}${ANTHROPIC_API_KEY:-NO}"   →  NO   (same for the other three)
$ env | grep -ci "api_key\|auth_token"                       →  0
```

— so `env -u …` was a no-op relative to a plain run, and on its own it proves nothing a plain run
would not. (Re-confirmed independently this pass from the other side: `pnpm preflight`'s first check
reads `ANTHROPIC_API_KEY` and reported it unset — which is also why its verdict carries a
credential blocker. Only the credential-unset variant was run this pass; no plain `pnpm test` number
is quoted above because none was produced.) What *does* carry the claim is structural, and it is
checkable:

- **Nothing loads `.env`.** `grep -rn dotenv` over `packages/` and `fixtures/` returns nothing.
- **Only two shipped modules read `process.env` for a credential**, and both do it inside a factory
  whose `env` is an injectable parameter — `packages/discovery/src/adapters/anthropic.ts:133` and
  `adapters/openai.ts:420`, both spelled `options.env ?? process.env`. (The three other
  `process.env` reads in shipped source are a fixture's `PORT`, a fixture's TTY setup and the
  terminal transport's child-process env.)
- **Every adapter construction in the test suite injects both.** Measured, not asserted:

  ```
  $ cd packages/discovery && python3 <scan of create{Anthropic,OpenAI}Model call sites in test/>
    adapter factory call sites in tests: 27
    without BOTH an injected env and an injected transport: 3
      test/anthropic-adapter.test.ts:130  env=True transport=False   ← asserts the refusal
      test/anthropic-adapter.test.ts:131  env=True transport=False   ← asserts the refusal
      test/openai-adapter.test.ts:132     env=True transport=False   ← asserts the refusal
  ```

  All 27 pass an explicit `env`; the three without a transport are the tests that assert the factory
  *throws* when no key is present. A real key in the environment therefore cannot reach a client.

**A second caveat on the board, which matters more than it looks.** 46 of the 1,785 tests are
skipped when no Chromium build is installed, and **every suite still reports green**:

```
$ PLAYWRIGHT_BROWSERS_PATH=<empty dir> npx vitest run --root packages/runtime
    Tests  295 passed | 16 skipped (311)
$ PLAYWRIGHT_BROWSERS_PATH=<empty dir> npx vitest run --root packages/surface-browser
    Tests  78 passed | 29 skipped (107)
$ PLAYWRIGHT_BROWSERS_PATH=<empty dir> npx vitest run --root packages/conformance
    Tests  101 passed | 1 skipped (102)
```

A reviewer who runs `pnpm install && pnpm test` without `pnpm exec playwright install chromium` gets
1,739 passing tests and a green board, and **every test that has ever touched a real browser is
among the 46 — including the four that execute a synthesized artifact (§7.2) and the four that open
a real sub-account (§7.3).** The guards print a
warning to stderr (`[@crr/runtime] SKIPPING every browser replay test: no Chromium build was
found`), and the seam test prints a second, more specific one naming itself and saying that the
synthesized artifact was parsed and linked but never executed. That is still the only signal. This
must be in the README's setup section, not left to be discovered.

---

## 2. Per package

| Package | Tests | Files | src | What it establishes |
|---|---:|---:|---|---|
| `@crr/core` | 788 | 36 | 39 files / 15,293 lines | Schema, canonical JSON + digest, the **28-check linker**, the classifier, the target resolver, the extractor, overlay merge, the policy chokepoint, the prose renderers. Pure — no clock, no I/O, no randomness, no driver import, enforced by a source-scanning contract test verified by injection. |
| `@crr/runtime` | 311 | 21 | 29 / 9,942 | Interpreter, settle loop, budget ledgers, control lease, journal writer, evidence sink, file store, catalog/`invoke`, ed25519 approval verification, operator console, the `crr` CLI, the redaction canary, `pnpm demo`. |
| `@crr/discovery` | 250 | 13 | 19 / 6,965 | Provider port, manual Anthropic loop, **OpenAI adapter** (HTTP shape over an injected `fetch`), VCR transcript record/replay, synthesis. The only package that may import a model SDK. |
| `@crr/surface-browser` | 107 | 12 | 11 / 2,501 | Per-frame CDP `Accessibility.getFullAXTree` stitch → `Observation`, dialog ownership, `perceive` deadline, PNG mask. |
| `@crr/surface-terminal` | 125 | 9 | 10 / 2,446 | `@xterm/headless` over a `TerminalTransport` port → `Observation` from an 80×24 character grid, `detect()`, `act()` with F-key lowering, screen-id → route canonicalization. |
| `@crr/conformance` | 102 | 8 | 16 / 5,039 | 25 browser scenarios + 14 terminal scenarios × 10 engines (1 reference, 9 mutants), the meta-test, multi-run stability, the `stableSamples` sweep, the cross-workspace name ledger. |
| `fixtures/corebank-web` | 66 | 1 | 1,971 lines | Frameset, nested layout tables, generated ids, `<font>`, no test ids, **two confirmation channels** (an in-page modal and a native `confirm()`), a real non-idempotent sub-account commit, 8 injectable faults, 2 tenant variants. |
| `fixtures/corebank-tui` | 36 | 1 | 970 lines | 80×24 green screen, 4 fault modes in 2 families, 2 tenant variants. |
| **Total** | **1,785** | **101** | | |

Command for every count in the table:
`TURBO_FORCE=1 pnpm test` (per-package `Tests N passed (N)` lines), and
`find packages/<p>/src -name '*.ts' | wc -l` / `cat $(…) | wc -l` for the sizes.

**One file is in none of those numbers, on purpose.** `packages/discovery/tools/preflight.ts` is
the live-run readiness check (§7.1). It is outside `src/`, so it is not on the barrel, not in the
built library, not read by the barrel test's module-coverage invariant, and not counted in the
`src` column above; `tsconfig.json` was widened to `tools/**/*.ts` so `pnpm typecheck` still reads
it, and `pnpm lint` covers it because biome reads the whole tree (309 → 310 files). It contributes
**no tests**, which is why the total is unchanged at 1,785.

Build output, `TURBO_FORCE=1 pnpm build`:

```
core            ESM 325.39 KB   declarations 287,298 bytes across 39 files (tsc, per-file)
runtime         ESM  84.07 KB   DTS  96.02 KB
discovery       ESM 132.20 KB   DTS  77.33 KB
conformance     ESM 116.82 KB   DTS  54.56 KB
surface-browser ESM  55.39 KB   DTS  24.08 KB
surface-terminal ESM 50.74 KB   DTS  21.95 KB
```

---

## 3. What this integration pass changed

Four tasks. All four are done; the work each one turned up is below.

### 3.1 Cross-package conflicts — the `ReplayOptions` class, hunted again

The historical defect (RUNTIME-STATUS §3.1): `ReplayOptions` was declared in `@crr/runtime` (the
argument to `replay()`, twenty-odd fields) and in `@crr/discovery` (the argument to
`createReplayModel()`, one optional boolean). Each read correctly in its own file. No test could see
it, because nothing in the workspace imported both.

A whole-workspace AST scan of every exported name in every `packages/*/src` found **six** names
owned by more than one package. Three were already on `@crr/runtime`'s ledger. Three were not:

| Name | Where | Verdict |
|---|---|---|
| `check` | `conformance/support.ts` + `core/policy-engine.ts` | **RENAMED** → `checkResult` |
| `blankRegions` | `surface-terminal/surface.ts` + `surface-browser/png.ts` | **RENAMED** → `blankGridRegions` |
| `CaptureSink` | both drivers | **KEPT**, ledgered, and pinned by a compile-time seam |

**`check` was the dangerous one, and not for style reasons.** `check` is the name of `@crr/core`'s
**policy chokepoint** — the single gate every `Surface.act` in the workspace must pass, which is why
SPEC §1.2 declines to create a `@crr/policy` package. The contract test that enforces it
(`packages/core/test/chokepoint-scan.ts`) is a lexical scan:

```ts
const CHECK_CALL = /(?<![\w$?.])check\s*\(/g;
```

Any bare `check(` within twelve lines of a dispatch, whose first argument text matches, counts as
the gate. A second exported `check` in a package that already imports `@crr/core` is an alibi
waiting to be handed to the one test the architecture leans on hardest. The rename is documented at
the declaration with that reasoning.

**`blankRegions`** is the `ReplayOptions` shape exactly: two drivers, one name, two signatures
(`(Raster, Rect[], colour) → number`, mutating in place, versus `(Grid, regions) → { masked, count }`,
mutating nothing). No engine package may import a driver, so nothing in the workspace holds both to
notice. The first consumer that would have — the `--surface <module>` factory `examples/` is meant
to ship — would have had to alias one, with a one-in-two chance of aliasing the wrong semantics.

**`CaptureSink` is a different failure and gets a different fix.** The two declarations are
*structurally identical* (`put(bytes, contentType): Promise<EvidenceRef>`) and the duplication is
deliberate: no driver may import another, and the shared home would have to be `@crr/core`, which
would put a `Promise`-returning port in the package whose entire claim is that it does no I/O. So
the two stay, and drift is caught by a bidirectional-assignability seam checked by `tsc`, not by a
comment. **Verified by injection:** adding a required `describe(): string` to the terminal driver's
`CaptureSink` produced

```
test/barrel.test.ts(353,86): error TS2741: Property 'describe' is missing in type
  '…surface-browser…CaptureSink' but required in type '…surface-terminal…CaptureSink'.
```

and was reverted.

**A second form of the same class, found and closed:** `@crr/core`'s
`ProvenanceSchema.model.adapter` is `z.enum(["anthropic","openai","agent-sdk","replay"])`;
`@crr/discovery`'s `DISCOVERY_ADAPTERS` has a fifth member, `"scripted"`. RUNTIME-STATUS §7.7
recorded that "the two vocabularies simply disagree and nothing but a thrown error connects them."
Three tests in `packages/discovery/test/synthesis-emit.test.ts` now connect them, reading the enum
off the live schema rather than retyping it, and pinning the difference **in both directions**.
Verified by injection in both directions:

```
# "gemini" appended to DISCOVERY_ADAPTERS:
×  differs by exactly one member, and that member is `scripted`      + "gemini",
# "bedrock" appended to core's enum:
×  names no adapter in an artifact that this package cannot drive    + "bedrock",
```

Both reverted.

**Manifest ↔ lockfile consistency, checked because a previous unit hand-edited `pnpm-lock.yaml`.**
Every `dependencies` / `devDependencies` entry in all nine manifests, and every specifier, matches
the corresponding `importers` entry in `pnpm-lock.yaml`. `0 problems` from a full comparison. The
two `link:` entries unit 20 wrote by hand are in pnpm's own emitted form. `pnpm install
--frozen-lockfile` should therefore succeed; `node_modules/.modules.yaml` was not re-derived, but it
has `pendingBuilds: []` and the tree resolves.

### 3.2 The architecture contract tests, over the new packages

`ABOVE_THE_DRIVERS` in `packages/core/test/no-locator-vocabulary.test.ts` is
`["core", "runtime", "discovery", "conformance"]`. The task expected this to be failing; it had
already been fixed, and this pass verified it is **doing work** rather than merely present:

```
# appended to packages/conformance/src/run.ts and src/stability.ts, then reverted:
×  the packages above the drivers > speak no locator vocabulary
     packages/conformance/src/run.ts:237  querySelector  -  a descriptor names a role and an
       accessible name; a query names a document
     packages/conformance/src/run.ts:236  [data-  -  the target applications have no test ids,
       which is the premise of the whole assignment
×  the packages above the drivers > import no driver …
     packages/conformance/src/stability.ts:362  @crr/surface-terminal  -  the driver is a
       parameter (`--surface <module>`), not a dependency of the engine
```

`@crr/surface-terminal` is exempt, like `surface-browser`, and that was verified from the other
side: the same selector appended to `packages/surface-terminal/src/grid.ts` leaves the suite green
(`14 passed`). A driver is precisely the layer allowed to know what a stylesheet is.

The per-package floor assertion covers conformance (`counted.get("conformance") > 5`), so the scan
cannot silently stop reading it. `DRIVER_LIBRARIES` already includes `@xterm/headless`, so reaching
for the emulator directly is caught as well as importing the driver package.

### 3.3 A barrel test for `@crr/conformance` (new: `packages/conformance/test/barrel.test.ts`)

`@crr/surface-terminal` already had one. `@crr/conformance` did not; it does now, 12 tests, and it
carries a second job.

Its barrel is **curated** (hand-written named re-exports, not `export *`), so the ambiguous-star
failure cannot occur by construction and the module-coverage invariant changes shape: every module
is either on the barrel or on a `NOT_ON_THE_BARREL` ledger with a reason. Two entries —
`stability-cli.ts` (an entry point, kept out of the library graph for the same reason
`@crr/runtime` keeps `cli.ts` out) and `__probe.ts` (a leftover scratch file; see §9).

**The second job is the workspace-wide name ledger.** `@crr/runtime`'s barrel test carries a
three-package version and says in its own header that "`@crr/conformance` will depend on both and is
the better home". The new one reads **all six** packages off disk. That extension is not cosmetic —
it is the only thing in the repository that can see a collision between the two drivers, which are
the packages with the *least* chance of any test noticing, because no engine package may import
them. Measured:

```
# `export type Raster` appended to packages/surface-terminal/src/keys.ts:
$ cd packages/conformance && npx vitest run test/barrel.test.ts
  ×  export no name twice across the whole workspace, except the ones on the ledger
     + "surface-browser / surface-terminal  Raster: surface-browser/png.ts and surface-terminal/keys.ts"
$ cd packages/runtime && npx vitest run test/barrel.test.ts
     Tests  10 passed (10)          ← the three-package ledger passes clean on the same violation
```

And the historical defect itself, reproduced:

```
# `export interface ReplayOptions` appended to packages/discovery/src/transcript.ts:
  + "discovery / runtime  ReplayOptions: discovery/transcript.ts and runtime/replay.ts"
```

Both reverted. A module added to `src/` and left off the barrel also fails
(`+ "__injected.ts"`), verified and reverted.

### 3.4 A measured number that had been silently lost, and the guard that was missing

**`SETTLE_POLICY_DEFAULTS.stableSamples` was `2`, and it should not have been.**

SPEC shipped `2` as an explicit placeholder (OPEN-QUESTIONS-RESOLVED Q6: "decided by measurement").
SPEC §11 unit 22 built the measurement — `packages/conformance/src/settle-sweep.ts` — concluded `3`,
and raised the constant. A concurrent rewrite of `packages/core/src/artifact.ts` (the
declaration-size refactor, which re-emitted every schema constant with a named interface type)
restored the placeholder. **Nothing failed.** The constant is applied by a *recorder* at emission
and never by the validator (SPEC §2.4 rule 3), so no digest moved and no test noticed. The entire
deliverable of unit 22 was a `2` becoming a `3` in one file, and it went back to being a `2`.

This pass re-applied it and **added the guard that was missing**. The sweep, re-run here:

```
$ pnpm -F @crr/conformance stability
  SettlePolicy.stableSamples sweep - engine: reference
  case               expected                          n=1        n=2        n=3        n=4
  happy              ok                              ok 7p     ok 14p     ok 21p     ok 28p
  slow-load          ok                              ok 9p     ok 16p     ok 23p     ok 30p
  never-settles      failed:did-not-settle          ok 44p     ok 47p     ok 50p     ok 53p
  tear-1             ok                           WRONG 4p     ok 15p     ok 22p     ok 29p
  tear-2             ok                           WRONG 4p   WRONG 8p     ok 23p     ok 30p
  tear-3             ok                           WRONG 4p   WRONG 8p  WRONG 12p     ok 31p
  tear-persistent    failed:checkpoint-failed        ok 4p      ok 8p     ok 12p     ok 16p

  LAW: stableSamples = n rejects a tear of up to n-1 consecutive polls, and no more.
       Every swept value obeyed it.
  measured tear width: 2 consecutive polls
       evidence: docs/design/spike-terminal-surface.md §4 — a repaint delivered 55% complete then
       120 ms of silence (two 60 ms quiet windows) produced a snapshot claiming settled with 3
       nodes where the screen has 8.
  THE EVIDENCE SUPPORTS stableSamples = 3: the smallest value correct on every control case and
       rejecting a tear as wide as the one actually measured.
  AND THE LIMIT: `tear-persistent` is caught at EVERY value, by the CHECKPOINT rather than by the
       settle loop. Raising stableSamples buys one more poll of tear rejected per extra poll per
       step; it does not turn quiescence into a readiness signal.
```

Cost of `2 → 3`, measured from the same matrix: **+7 polls per 7-step run** (14p → 21p), i.e. one
extra `perceive()` and one extra observation-ledger charge per settled step. On a stall the
increment is negligible (44/47/50/53 polls at n=1/2/3/4, where `maxWaitMs` dominates).

The existing `settle-sweep.test.ts` deliberately refuses to pin the conclusion (`3`), and it is
right to: pinning a conclusion freezes it. The three tests added instead pin **the agreement between
the shipped constant and whatever the matrix currently derives** — `supportedByEvidence` is computed
from the cells, so if a scenario changes and the answer moves, the default must move with it.
Verified by injection: setting the constant back to `2` produces
`× is the value this matrix derives … → expected 2 to be 3`, and it was restored.

**If you disagree with `3`, the revert is one line** — `packages/core/src/artifact.ts:248` — and the
guard will then tell you the sweep disagrees, which is the conversation worth having.

---

## 4. The five contract tests that hold the architecture up

All five are scan → discrimination-suite → ledger-asserted-empty, all five read the repository off
disk, and all five have had their file selection verified by injecting a violation into a **real**
module rather than a synthetic string.

| Test | Scope | Enforces |
|---|---|---|
| `core/test/purity.test.ts` | `packages/core/src` | No `Date`, `Math.random`, `fetch(`, `node:`, `process.env`, `setTimeout`, `setInterval`; allowlisted imports only. |
| `core/test/no-locator-vocabulary.test.ts` | `core`, `runtime`, `discovery`, **`conformance`** | No `querySelector`, `css`, `xpath`, `getElementById`, `innerHTML`, `[data-`; **and** no import of any driver or driver library. Checks its own package list against the workspace, so a new package fails it until somebody decides. |
| `core/test/policy-chokepoint.test.ts` | the whole repository | Every `Surface.act` call site is immediately preceded by a `check` on the same action whose decision is read. Four real dispatch sites, all guarded: `runtime/interpreter.ts:543`, `:1054`, `runtime/intervention.ts:532` (the human's own action), `discovery/loop.ts:432` (the model's own action). **The model's action during discovery and a human's action through the operator console pass the same gate as the interpreter's.** |
| six `test/barrel.test.ts` files | one per package | Every module reachable; no name owned by two modules; every value live at runtime, not merely in the types. |
| `conformance/test/barrel.test.ts` (new) | all six `packages/*` | No exported name owned by two packages except four ledgered ones, each with a written reason and — for `CaptureSink` — a compile-time identity seam. |
| `core/test/declaration-size.test.ts` | `packages/core/dist` | Per-file and total `.d.ts` budgets, so the 15 MB regression cannot come back. |

---

## 5. The conformance result, in full

### 5.1 The browser corpus — the headline claim

```
$ cd packages/conformance && npx tsx <buildKillMatrix over ALL_SCENARIOS>

BROWSER CORPUS reference engine: total=25 passed=25 failed=0 falseSuccesses=0
kill matrix: 9 mutants x 25 scenarios
mutant            killed by                    of which false successes
firstMatch        16,17                        17
countQuorum       17                           17
noAssert          18                           -
noSettleGate      13                           13
checkpointFirst   02,03,05                     05
noContinuity      21                           21
noDelta           20                           20
nearestMatch      04,06,08,09,15,21            04,06,08,09,15,21
noProvenance      04                           04
every mutant was killed by at least one scenario
BROWSER SURVIVORS: []
```

**25 scenarios, 0 failures, 0 false successes for the reference engine. 9 mutants, 0 survivors.**
17 kills in total, **13 of them false successes** (the mutant told a caller `ok`, or told it a
business outcome, for a run that was broken) and 4 misclassifications. Six of the nine mutants are
caught by at least one false success. `nearestMatch` — the "fallback chain" mutant, the one that
converts an ambiguity into a confident wrong click — is killed by six scenarios and **every one of
the six is a false success**, which is the single most load-bearing row in this table.

The mutants are the **real** `replay()` — same linker, lease, budgets, journal, session broker —
with exactly one pure decision function replaced through an injection seam
(`DecisionFunctions` on `InterpreterOptions`/`ReplayOptions`). A meta-test enforces that by function
identity: each mutant must weaken exactly one of `classify` / `resolveTarget` and share `@crr/core`'s
own function object for the other. Without that seam the mutants would be stubs, and a suite that
can only tell a real engine from a stub proves nothing.

The meta-test was verified to fail against a real gap: deleting scenario 21 (the only scenario that
kills `noContinuity`) produced `SURVIVORS (a gap in the suite): noContinuity` and 4 failing tests.

### 5.2 The terminal corpus — **four mutants survive, and that is reported, not hidden**

```
TERMINAL CORPUS reference engine: total=14 passed=14 failed=0 falseSuccesses=0
mutant            killed by      of which false successes
firstMatch        T13,T14        T13,T14
countQuorum       T14            T14
noAssert          SURVIVED       -
noSettleGate      SURVIVED       -
checkpointFirst   T03,T04        -
noContinuity      SURVIVED       -
noDelta           T08            -
nearestMatch      T06,T08        T06,T08
noProvenance      SURVIVED       -
SURVIVORS (a gap in the suite): noAssert, noSettleGate, noContinuity, noProvenance

COMBINED SURVIVORS (browser + terminal): []
```

**5 of 9 mutants die on the green screen, not 9**, and `terminal-conformance.test.ts` asserts that
number *in both directions* with a written reason (>60 characters, asserted) for each of the four
survivors. Forcing all nine would have meant a fixture that lies. The reasons, from
`OUT_OF_REACH` in that file:

- **`noSettleGate` — the interesting one.** It classifies against a screen the driver called
  unsettled. A green screen's readiness signal is *silence*, and a torn repaint is silent: the
  driver reports `settled: true` on a half-painted frame. There is no observation where the settle
  flag is false and a verdict hangs on it, so the mutant is indistinguishable from the reference
  engine. That is the same measurement scenario T06 makes from the other side — **on this surface
  band B0 cannot be the gate, which is why the checkpoint has to be.** This is a real result about
  the design, and it is the strongest argument in the repo for why quiescence is not readiness.
- **`noAssert`** needs a target that resolves correctly and is still the wrong thing. This fixture's
  account list is keyed by suffix and every row is the member's own.
- **`noContinuity`** needs the application to land on a different member's record; the fixture echoes
  back the account number it was given, always.
- **`noProvenance`** needs the same validation banner over a caller's argument *and* over an artifact
  literal (SPEC §4.2 rows 4 vs 5). This flow fills exactly one field and it is the caller's.

The union of the two corpora kills all nine. That is the honest statement: *the suite* discriminates;
*the green-screen corpus alone* does not, for four reasons each of which is a property of the surface
rather than a gap in the effort.

### 5.3 Stability

```
$ env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY \
      -u CLAUDE_CODE_OAUTH_TOKEN pnpm -F @crr/conformance stability
  25 scenarios x 20 runs: flake rate 0.0%, 0 with a result document that was not byte-identical
```

- **Flake rate 0.0%** — proportion of scenarios that were *inconsistent* across runs, not the
  proportion that failed.
- **Result determinism, stricter:** 0 of 25 scenarios produced a `ReplayResultDocument` that was not
  byte-identical across all 20 runs (digest of the whole document, not just the arm).
- **Descriptor instability: 0** descriptors changed verdict between runs of the same scenario, across
  15 descriptors and 5,300 consultations.
- Per-descriptor contribution rates (20 × 25): `open-link-by-row` 340 consultations / 82.4% carried /
  silent in scenarios 16, 18, 19; `open-link-by-name` 340 / 88.2% / 16, 19; `open-link-by-ordinal`
  340 / 88.2% / 16, 19; `search-button-by-name` and `-by-ordinal` 440 / 95.5% / none;
  `member-id-field-by-ordinal` 500 / 96.0% / 17; the remaining nine at 100.0%, silent nowhere.

**What this number is not.** The report prints its own caveat and it is the right one: *this
measures the engine over a frozen corpus on a manual clock. A fixture you control cannot surprise
you the way a real vendor app does; it bounds hidden state in the engine, not flake in production.*
Zero over 20 runs is not a reliability claim.

---

## 6. The evidence bundle

`pnpm demo` — no live service, one local Chromium, one ephemeral loopback port, 9.8s, exit 0.

```
7/7 exhibits PASS
  replay-01-green                    ok        green
  replay-02-outcome-member-not-found outcome   expected business outcome
  replay-03-recovered-interstitial   ok        recoverable condition
  replay-04-failed-app-error         failed    hard failure
  replay-05-failed-session-expired   failed    hard failure
  masked-capture                     3 region(s) blanked
  cli-replay                         exit 0
48 files, 1,016 KB
redaction canary: 3 values × 14 encodings = 26 distinct needles, self-test 26/26, 0 hits,
  0 suppressed, 0 credential shapes.  Whole-bundle second pass gates the exit code: CLEAN.
```

All three arms of the taxonomy are exhibited, which is BRIEF §5's specific ask ("at least one replay
that hits an exceptional state and shows how it was classified") answered four times over.

The canary was verified against planted leaks: plain UTF-8 in a log, percent-encoded bytes in a
JSON result, UTF-16LE appended to a PNG, and a value in a **file name** — 4/4 caught, then reverted.

**What the bundle does not contain, and why — see §7.1.** `evidence/discovery-live/` holds only
`PENDING.md`. No transcript was fabricated and no VCR fixture is presented as a live run.

---

## 7. What does **not** work, is not proved, or is unresolved

Ordered by how much it costs the submission.

### 7.1 There is no live discovery run, and there cannot be one without the author's approval

BRIEF §5 requires "logs from a real discovery run" in `evidence/`. **They are not there.** BRIEF §11
forbids every agent on this repo from making a live model API call, so this is a deliberate hole
with a documented shape, not an oversight:

- `evidence/discovery-live/PENDING.md` names every file that will land there
  (`transcript.json`, `discovery.log`, `journal.jsonl`, `synthesized/`, `verification.json`,
  `provenance.json`), and names what may **never** be put there in its place: a VCR-replayed
  transcript, a human- or coding-agent-driven run, an `agent-sdk` run.
- `pnpm demo` deliberately never deletes that directory.
- The "saved example artifact" in `evidence/artifact/` is the **hand-authored**
  `sharePositionArtifact` from `packages/runtime/test/fixtures/corebank.ts`. Both `evidence/README.md`
  and `evidence/artifact/README.md` say so plainly, and say that
  `provenance.model.adapter: "replay"` is the enum's least-dishonest value for "a person wrote this".

**CORRECTION, THIS PASS. Earlier revisions of this section said the gap was "one command away from
closing". It is not, and the difference matters: THE COMMAND IS THE THING THAT IS MISSING.**

```
$ grep -rn createAnthropicModel packages/ --include='*.ts' | grep -v '/test/'
  packages/discovery/src/adapters/anthropic.ts:132     ← the declaration. Nothing else.
```

The shipping adapter has no caller anywhere outside its own unit tests. There is no `pnpm
discover`, no CLI subcommand, and no script that composes
`createAnthropicModel` → `createRecordingModel` → `runDiscoveryLoop` → synthesis → `writeFileSync`.
Every piece exists, every piece is tested, and nothing joins them — which means that today the
author **cannot** spend the money even deliberately, because there is nothing to approve.
`docs/design/RUNTIME-STATUS.md:572` recorded this ("the only live-model path in the repo
(`createAnthropicModel`) has no CLI in front of it") and it was never picked up here.

#### `pnpm preflight` — the readiness check, new this pass

`packages/discovery/tools/preflight.ts`. A human runs it **before** authorising a paid call, and it
answers the question that decision actually needs answered: what would go out, how big is it, what
would it cost, what would the safety gate permit while it ran, and where would the recording land.

**It makes no model call, and that is a property rather than a promise.** It never constructs
`createAnthropicModel`; it reads `ANTHROPIC_API_KEY` only to check its *shape* and never prints,
logs or transmits the value; and it counts tokens **locally from character counts** because
`messages.countTokens` is itself a billed round trip to the provider. The only sockets it opens are
to `127.0.0.1` — the fixture it boots and a local Chromium driving it.

Measured, in this working tree, with no credential in the shell:

```
$ pnpm preflight
  1. CREDENTIAL   BLOCK  ANTHROPIC_API_KEY is not set in this shell
  2. TARGET       ok     fixture up on http://127.0.0.1:59371; /search, /search/results
                         and /member/10041 all answer 200
  3. THE REQUEST         system prompt      2,265 chars  ~   687 tok
                         tool definitions   4,447 chars  ~ 1,348 tok
                         ─ cacheable prefix 6,712 chars  ~ 2,034 tok
                         task message         331 chars  ~   101 tok
                         ═ TURN 1 INPUT     7,043 chars  ~ 2,135 tok
                         first observation    407 chars  ~   124 tok  (8 of 99 nodes shown)
                         PERCEIVED LIVE through @crr/surface-browser over CDP
  4. COST         model claude-opus-5, effort high, maxTurns 24, max_tokens 16,000
  5. ALLOWLIST    ok     one alias ("corebank"), 3 explicit routes, no wildcard,
                         discoveryMaxEffect WRITE_REVERSIBLE, and the real `check()`
                         DENIES /admin/settings and a foreign origin, run just now
  6. RECORDING    BLOCK  no runner exists
  VERDICT         NOT READY — 1 blocker, 2 warnings, 12 checks passed        exit 1
```

**The cost table it prints, at the published rates** (verified against the `claude-api` skill, not
written from memory: opus-5 $5/$25 per Mtok, sonnet-5 $2/$10; ephemeral cache writes at 1.25×
input and reads at 0.1×). `U` is output tokens per turn and is the one symbol that is **assumed**
rather than measured — there has never been a live run to measure it from — so it is an input to
the estimate, printed as such, and overridable with `CRR_PREFLIGHT_OUTPUT_TOKENS`:

| turns | scenario | opus-5 | sonnet-5 |
|---:|---|---:|---:|
| 8 | typical (U = 800) | **$0.31** | $0.13 |
| 8 | ceiling (U = 16,000) | $5.48 | $2.19 |
| 24 | typical (U = 800) | $1.80 | $0.72 |
| 24 | ceiling (U = 16,000) | $31.90 | $12.76 |

8 turns is the length of the hand-authored `SCRIPT` that reaches this goal through this loop; 24 is
`DEFAULT_LIMITS.maxTurns`, the hard budget. **A worst-case run on either model would exceed the
whole $10 cap**, and the preflight warns about exactly that. The realistic figure is the top row.

Two results from building it that are worth more than the dollar amounts:

- **Prompt caching saves almost nothing on this loop, and the report says so.** Only the system
  prompt and the tool definitions carry a breakpoint; the message history does not, so every
  observation and every assistant turn is re-billed at full input price on every subsequent turn.
  Measured from the same table: caching saves **$0.21** on a full-budget 24-turn opus-5 run, while
  the growing history drives input from 30,646 tokens at 8 turns to 264,669 at 24. BRIEF §9 asks
  for the cache hit rate as reported evidence; this is the number that will make it look small.
- **The 2,034-token prefix clears both models' minimum cacheable prefix** (512 on opus-5, 1,024 on
  sonnet-5). Below the floor a breakpoint silently does nothing — no error, just
  `cache_creation_input_tokens: 0` forever — so this is checked rather than assumed.

**What the preflight is NOT.** It has **no automated test**; it is verified by running it, and it
was run three ways in this pass (no credential; a syntactically valid fake key, which exercises the
shape branch and leaks nothing but a length; and with `PLAYWRIGHT_BROWSERS_PATH` pointed at an empty
directory, which exercises the frozen-corpus fallback). What keeps it from drifting is not a test
but its inputs: every budget, model id, prompt, tool schema, allowlist and route in the report is
**read from the shipping source** — `DEFAULT_LIMITS`, `DEFAULT_MAX_TOKENS`, `DEFAULT_MODEL_ID`,
`DISCOVERY_SYSTEM_PROMPT`, `DISCOVERY_TOOLS`, `ALLOWLIST`, `ENTRY_ROUTE`, `GOAL` — not copied into
it. The only hand-written numbers are the published rates and the cache multipliers.

**One incidental corroboration.** The live perceive and the frozen corpus produced the *identical*
projection (407 chars, 8 of 99 nodes, same eight lines). `corebank-web.observations.json` has not
drifted from the application it was captured from.

**So the gap is now two commands, and the second one does not exist yet.** Writing the runner is a
small job — the pieces are all built and tested — but it is a job, and it must be done by whoever
is also willing to watch the money. It needs the author to approve a specific run against the
Anthropic Messages API, and it needs something to run.

### 7.2 The discovery → replay seam — **CLOSED**

**A synthesized artifact now replays, through the real interpreter, against the real
`fixtures/corebank-web`, in a real browser.** The two halves of SPEC §1.1's cycle are connected by
code, and the connection is the one the design asks for: **a file**.

```
$ cd packages/runtime && npx vitest run test/synthesized-replay.test.ts
  ✓ the synthesized capability, read back as a document (4)
  ✓ replaying a SYNTHESIZED artifact against corebank-web
      ✓ verifies itself with the model out of the loop, and only then becomes a draft      2.0s
      ✓ executes every descriptor, checkpoint, budget and effect synthesis derived         2.0s
      ✓ is a capability, not a macro: approved, then invoked for a member the recording
        never saw                                                                          3.7s
      ✓ reports a member the core has no record of as a hard failure, because nobody
        declared an outcome                                                                1.2s
  Tests  8 passed (8)

$ cd packages/discovery && npx vitest run test/synthesis-corebank-web.test.ts
  Tests  25 passed (25)
```

**Re-verified in this pass, and here is exactly how far that verification goes.** Both files were
re-run as part of the full credential-unset suite and both are green at those counts (25 in
`@crr/discovery`, 8 in `@crr/runtime`, the four executing ones among them). What was **not**
re-done here is re-injecting the two synthesis defects below to watch their guards fail; those
remain on the previous unit's word, and the tests that would catch a regression are the ones that
just ran. A third, independent corroboration did arrive from an unexpected direction: `pnpm
preflight` (§7.1) perceives the entry screen **live** through `@crr/surface-browser`, and its
projection is byte-identical to the one derived from the committed corpus — 407 characters, 8 of 99
nodes, the same eight lines. `corebank-web.observations.json` has not drifted from the application
it was captured from, which is the assumption every stage downstream of `capture` rests on.

**Why a file and not a dependency.** RUNTIME-STATUS §10 item 1 proposed adding `@crr/discovery` to
`@crr/conformance`. That needs a `pnpm install`, and it is also the weaker fix: BRIEF §3.9 says the
artifact is **data, not code**, and a document that needs a function call to cross a package
boundary is not a document. So `@crr/discovery` emits its synthesized contract + artifact + report
to `packages/discovery/test/fixtures/corebank-web.capability.json`, and
`packages/runtime/test/synthesized-replay.test.ts` reads it off disk through `parseContract` /
`parseArtifact` — no import of `@crr/discovery`, no shared type, nothing but a schema both ends
validate against. That is also what makes the test worth having: a shared type would make structural
incompatibility impossible while leaving **semantic** incompatibility untouched, and semantic
incompatibility is what this was always about.

**The pipeline, and where a browser is needed.**

| Stage | Artefact | Command | Needs |
|---|---|---|---|
| capture | `corebank-web.observations.json` — four frozen `Observation`s (99 / 100 / 130 / 159 nodes) taken from the real fixture through `@crr/surface-browser` over CDP `Accessibility.getFullAXTree`, plus that driver's real `SurfaceCapabilities` | `pnpm -F @crr/discovery fixtures:capture` | Chromium |
| emit | `corebank-web.capability.json` — the contract, artifact and synthesis report | `pnpm -F @crr/discovery fixtures:synthesized` | nothing |
| execute | — | `pnpm -F @crr/runtime test` | Chromium |

The capture runs the **real discovery loop** against the live application with a hand-authored
scripted model, so the frozen screens are what the app served in response to the actions the program
performs, not three URLs somebody navigated to. Everything downstream is hermetic.

**What the runtime test walks, which is the whole ladder rather than the bottom rung.**

1. **Read it as data** — parses, digest intact, `implements` the contract by digest, and the linker
   **refuses it in `replay` mode** (check 27, `artifact-not-approved`) because it is `proposed`.
2. **Verify it** — `verifyAndDraft`, BRIEF §3.4, against the live application: mode `replay-dry`
   (chosen from the effect summary, not from the document's own plan), grade `full`, covered through
   the last step, arm `ok` with typed outputs. `proposed → draft`.
3. **Approve it** — a real ed25519 signature over the real digest. `draft → approved`.
4. **Invoke it in production** — for **member 10045, which the recording never saw**, and get that
   member's name, balance and status back. This is what separates a capability from a macro.

**What §7.2 said was unproved, now asserted against a live run** (the second test above, all against
the journal of a run rather than against the document that describes one):

- **descriptors** — 3 targets, 3 `resolved` events, every one `agreed: true` with
  `distinctSources ≥ 2`, no `disagreed` verdict, and `drift.divergence === 0`, i.e. nothing
  abstained. The unnamed search field resolves by a label anchor and an ordinal, because `role-name`
  is not derivable on a product with no accessible names on its inputs.
- **checkpoints** — one per step, four of four, all `passed`, every one derived by evaluating
  candidates against the recorded observation and every one holding against a screen rendered
  seconds earlier.
- **budgets** — `stableSamples: 3` on every step (the value the conformance sweep derived) spent by
  the real settle loop; `remediations {used: 0, limit: 0}` matching `flow.ambient: []`, asserted as
  a **pairing** because a non-zero rule count with a zero cycle budget is the inert-recovery hazard
  §7.7 still has no linker check for.
- **effect summary** — 3 dispatches, 3 policy decisions, all allowed, no approval token required
  because no step is irreversible; and the taint model end to end on a document nobody hand-wrote:
  the one action carrying the caller's value journaled a `taint:` handle, and the member number
  appears nowhere in the journal or the result.

**Two real defects in synthesis were found by executing what it emits, and both are fixed.** Neither
was reachable by any test that only linked the document:

1. **`deriveOutputs` folded a cell's accessible name into the query it derived** — and on a legacy
   grid a cell's accessible name **is the value being read**. The emitted artifact carried
   `"ALVAREZ, DANA (SYNTHETIC)"` and `"1,204.55"` in `flow.vocabulary` — recorded member data in the
   one document that is committed, diffed and **signed**, which is precisely what BRIEF §3.6 forbids
   — and the capability worked for exactly one member. Parameterization could not catch it: the
   member's name was never in the goal, so it was never bound to anything. Fixed at
   `packages/discovery/src/synthesis/outputs.ts`: when row-and-column addressing is available it is
   used **alone**. Guarded by a test that greps the sealed documents for all three values.
2. **Every delivered string output was case-folded.** `readingOf` returned `normalize: "std.text@1"`,
   which lowercases — right for matching a label against a screen, wrong for a value handed to a
   caller, who would have been read their own name back as `alvarez, dana (synthetic)`. The
   hand-authored artifact had already made the opposite choice one field along, in a comment. Fixed:
   `std.identity@1` is the default on the delivery path and a normalizer is chosen only where it
   earns its place (`std.money@1`, so `moneyUSD@1` sees a bare amount).

**What was still open here has since been closed; see LIVE-RUN-READINESS §5.5 for the fix and its
commands.** The parameter synthesis derived was named **`value1`, not `memberId`**: `inferParameters`
named a parameter after the accessible name of the field it was typed into, and on this product that
name is the empty string, so the `value${n}` fallback fired and the emitted contract offered a
calling agent an argument called `value1` described as "The value to use for `value1`". The artifact
was perfectly executable — the whole ladder above ran on it — but a badly named parameter is a
routing hazard.

`packages/discovery/src/synthesis/parameters.ts` now walks a documented chain — accessible name,
then the markup label, then the adjacent label anchor `deriveDescriptors` computes for the same node
(rungs 2 and 3 call `labelAnchorsOf`, the very function the descriptor builder calls), then a
host-supplied taint handle, then a positional placeholder. On riverbend the third rung answers with
"Member ID" and the contract now offers `memberId`. Reaching the last rung is no longer silent: it
emits a `parameter-name-underived` note at `review` severity and stamps `NEEDS A NAME:` into the
parameter's own description, because `value1` on a field with no name anywhere is the correct answer
and shipping it quietly was the actual defect. Fifteen tests, and the committed fixture was
regenerated.

**Drift is a red test, not a surprise on a live run.** `synthesis-corebank-web.test.ts` rebuilds
`corebank-web.capability.json` in process, from the same function the emit script calls, and
compares the **bytes** — so any change under `src/synthesis/` fails the build naming the command
that fixes it. Regenerate, and the runtime test then executes whatever the new synthesis emitted.
The hand-authored node references are `n<k>` indices with no names attached, so `checkRefs` asserts
the role *and* the accessible name of every referenced node before any run starts, in both the
capture script and the test, with a discrimination case proving that guard can fail. There is no
path from "synthesis emits something the interpreter cannot run" to a green board.

**The one honest caveat.** The four executing tests are among the 42 that skip silently without a
Chromium build (§1). Without one, the synthesized artifact is still parsed, digest-checked and
linked — the other four assertions in that file, plus all 25 in `@crr/discovery` — but it is not
executed, and the file prints a stderr line saying exactly that.

### 7.3 The confirmation dialog — **CLOSED**

**A real sub-account is now opened, through the real interpreter, against the real
`fixtures/corebank-web`, in a real browser — and the modal confirmation is what authorizes it.**

```
$ cd packages/runtime && npx vitest run test/browser-write.test.ts
  ✓ the documents this flow ships (2)          ← hermetic; the only part that runs with no Chromium
  ✓ opening a sub-account against corebank-web
      ✓ raises the confirmation, accepts it as the postcondition, and commits exactly once  1771ms
      ✓ dry-runs to the irreversible boundary and does not perform it                       1380ms
      ✓ verifies, drafts, and then invokes - and opens exactly ONE account across both      2957ms
      ✓ still refuses an UNDECLARED dialog on the same widget, and posts nothing            1377ms
  Tests  6 passed (6)

$ cd packages/core && npx vitest run test/expected-dialog.test.ts
  Tests  19 passed (19)
```

**Re-verified in this pass, with the same caveat §7.2 carries.** All three files are green at those
counts inside the full credential-unset suite — 6 in `browser-write.test.ts`, 19 in
`expected-dialog.test.ts`, and the 19 in `runtime/test/cycle.test.ts` that include both halves of
settle rule 3. The four-way injection matrix at the end of this section was **not** re-run here; it
stands on the previous unit's word, and the assertions it describes are the ones that just passed.

**Still true, and still deliberate: the write flow is not in `pnpm demo`.** The demo bundle was
re-run this pass (7/7 exhibits, 48 files, redaction canary CLEAN on both passes, exit 0) and the
sub-account flow is absent from it for the reason given at the end of this section — an irreversible
capability's arguments include an amount the application prints back on its own confirmation screen,
and the canary greps every byte of the bundle for parameter values. That remains a decision for
whoever writes `/README.md` and `/REPORT.md`, not a wiring task.

#### The decision, and the argument for it

The two candidates this document named were an `expectDialog` clause on `Checkpoint` and a
`resume: "continue"` recovery mode. **`expectDialog` won**, and the argument is not only that it is
smaller.

*The band order proved one thing too many.* SPEC §4.4 puts B2 (interception) before B3 (declared
outcomes) to defend one true sentence: **what is visible behind a modal is stale by construction, so
reading a business outcome off it is reading history.** That sentence is right and it survives. What
the code enforced alongside it was a second sentence — *every* dialog is an interruption — and that
one is false. A confirmation dialog is the **postcondition of the click that raised it**. An
interruption is, by definition, something nobody declared. So the fix is to make the distinction the
band order was missing: a step declares the dialog it transacts with, and B2 stands down **to the
checkpoint** for that dialog and for nothing else.

*Why not `resume: "continue"`.* It is the larger change and the wrong shape:

- **Larger.** `expectDialog` is one optional field, one stand-down in B2, one clause in B5 and one
  linker clause — no interpreter control flow moves. `resume: "continue"` adds a control-flow edge
  to the interpreter, a case to the restart gate (§3.6), a meaning to the remediation ledger, and a
  second reading of `afterRemedy: "reverify"`.
- **Wrong shape.** It would put the irreversible commit inside a *remedy*, and SPEC §3.5 forbids
  exactly that: a remedy may clear an obstacle and hand control back; it may not bind a value,
  classify, or recurse. It is also a lie in the journal — the most consequential act in the flow
  would be recorded as "a recoverable condition was remedied".
- **It does not close §7.4 either.** §7.4 is a genuinely different problem: an *unmodelled*
  interstitial arriving after a step has acted, which must be cleared and re-verified. Giving one
  mechanism both jobs makes it right for neither. §7.4 stays open and conformance scenario 25 still
  pins the wrong behaviour.

#### What shipped

`Checkpoint.dialog?: ExpectedDialog` — `{ where: NodeQuery; present: boolean }`, `packages/core/src/artifact.ts`.

- **Optional, not `| null`.** The artifact is content-addressed and an approval signs the address; a
  required `dialog: null` would move the digest of every artifact ever recorded to say what their
  absence already says. Every existing document is unchanged byte for byte.
- **`present` carries both halves.** `true` = this step RAISES the dialog (it is the postcondition);
  `false` = this step ANSWERS it (its absence is). The licence (B2 stands down) and the obligation
  (B5 asserts) are one field on purpose, so a step cannot claim the first without paying the second.
- **The dialog outlives the step boundary** — one step's postcondition is the next step's starting
  screen — which is why both steps declare it. A clause covering only the raising step would have
  moved the refusal one step to the right and changed nothing.

The stand-down (`declaredInterception`, `packages/core/src/classify.ts`) is four refusals, not a
permission, and each closes a way the clause could have become a hole:

| # | Refusal | The test that would fail without it |
|---|---|---|
| 1 | the step declared nothing → no stand-down | `changes nothing for a step that declares no dialog` |
| 2 | `Observation.nativeDialog !== null` vetoes it outright | `refuses a NATIVE dialog even when the step declares one` |
| 3 | no VISIBLE dialog node explains the interception | `refuses an interception that no visible dialog node explains` |
| 4 | **every** open dialog must be the declared one, not one of them | `refuses TWO dialogs when only one of them was declared` |

Refusal 2 is the load-bearing one and it is a property of the channel rather than a cut corner: **a
native dialog blocks the renderer, so there is no post-act `Observation` to check a postcondition
against, and a postcondition that cannot be checked is not a postcondition.** Measured, not assumed
— `packages/surface-browser/test/browser-act.test.ts` drives the fixture's `?dialog=native` mode and
records `perceive` returning `perceive-timeout` while a `window.confirm` is open. A `window.confirm`
therefore stays exactly what it is today: an interception.

**Band B3 does not run when the stand-down fires**, either way `present` points, because the screen
*behind* the panel is still stale. That is the true half of "B2 before B3" and it is preserved
structurally, in the classifier, for a document that was never linked.

**The linker check that keeps it honest** is folded into check 25 (`checkCheckpoints`), so
`LINK_CHECK_COUNT` stays 28 and SPEC §10's numbering is untouched. Three obligations, one per way the
licence could be turned back into a hole:

- `expect.dialog.where` must constrain `role: "dialog"` — B2 stands down only for open dialog NODES
  the query selects, so a query that cannot select one leaves a step declared on paper and
  undeclared in fact (`checkpoint-dialog-not-a-dialog`).
- a step whose postcondition is an OPEN dialog declares **no `outcomes` and no `extract`** —
  everything behind a modal is the state before it was raised (`checkpoint-dialog-shadows-declarations`).
- **no program's last step ends with a dialog open** — the final postcondition is the state the
  automation hands back, and a blocked screen is not one (`checkpoint-dialog-left-open`).

#### A second torn read, and this one is on a browser

Closing this uncovered a real defect that nothing else could have found, because it needs a dialog
to be a *postcondition* before it does any harm. `settle()` used to return on the first poll that
saw **any** interception. That was safe while every interception was a hard failure — a torn read
and a settled one produce the same verdict when the verdict is always "stop". It stopped being safe
the moment a checkpoint had to adjudicate the screen.

**Measured, against the real fixture:** 18 ms after the click that raises the confirmation panel, one
`perceive` returned the accessibility tree of the NEW document (137 nodes, the panel among them)
stitched to the frame tree of the OLD one — the driver reads `Page.getFrameTree` before
`Accessibility.getFullAXTree` and the navigation committed in between — so `route` said
`/subaccount/new` on the `/subaccount/confirm` screen and the checkpoint failed a step that had in
fact succeeded. That is the browser's instance of the torn repaint the terminal spike measured on a
character grid.

The fix is the one the design already argues for (SPEC §3.3): `settle()` short-circuits for a
**native** dialog only — that channel blocks the renderer and the classifier needs the message in
hand — and an in-page modal goes through the ordinary quiescence loop like every other screen, where
`stableSamples` catches the tear. `packages/runtime/src/settle.ts`, rule 3. It is guarded
hermetically as well as against the browser: `test/cycle.test.ts` now has both halves of rule 3 —
`stops on the first poll when a NATIVE dialog is open` and `does NOT stop on the first poll for an
in-page modal, which blocks nothing` — so the defect is caught on a machine with no Chromium.

#### What the browser test walks, and what it refuses

The artifact is `packages/runtime/test/fixtures/corebank-write.ts`:
`corebank.member.open_sub_account@1.0.0`, five steps, `WRITE_IRREVERSIBLE`, `requiresApproval: true`,
`idempotent: false`. Three effect classes in one program — `READ` on the form steps,
`WRITE_REVERSIBLE` on the POST that raises the panel, `WRITE_IRREVERSIBLE` on the one that commits —
and the allowlist gives each route a different ceiling, so the policy chokepoint authorizes the two
writes against two different rules.

1. **It commits, once.** Not "a confirmation screen said so": the assertion reads the fixture's own
   `/__fixture/state` endpoint before and after and requires the core to be holding exactly one more
   sub-account. A double-post would show a green confirmation both times and this would still catch
   it. `undeclared-dialog` appears nowhere in the journal, and the raising step's post-act verdict is
   `advance` **with the modal on screen** — which is the whole amendment in one journal line.
2. **The dry run stops at the boundary and the core is unchanged.** `verifyArtifact` chooses
   `replay-dry` from the effect summary, grades `partial-up-to-irreversible`, covers through
   `submit-subaccount-form`, stops before `commit-subaccount`, and the boundary step's journal has
   `resolved` and **no `acted`**. This mode could not reach the boundary at all before the amendment:
   the panel is on screen when the boundary step begins, and B2 refused it there. The commit is
   refused twice over during verification — once by the dry boundary, once by
   `allowlist.discoveryMaxEffect: "WRITE_REVERSIBLE"`, because a verification replay runs in
   `discovery` mode (SPEC §6.6).
3. **Verify, draft, invoke — one account across both.** And in between, a refusal worth having: the
   dry run parks the session on the confirmation panel (the interpreter does not clean up after
   itself, for the same reason the driver's `close()` will not answer a pending dialog), and a
   production invocation run against *that* screen fails `undeclared-dialog` at step 1 with
   `sideEffects: "none-guaranteed"`. A freshly brokered session (SPEC §7.6) never sees it; the test
   stands in for the broker by hand and then the run is green.
4. **An undeclared dialog on the SAME widget is still a hard failure.** The fixture renders its
   maintenance interstitial with the same modal machinery as the confirmation — one widget, two
   identities, deliberately, so that an engine cannot classify a modal by "a modal is showing".
   Armed on the confirmation screen, both panels are up, refusal 4 fires, and the run fails with
   nothing posted.

Verified by injection, all four reverted:

```
# `declaredInterception` short-circuited to false (the B2 stand-down removed):
  core      ×  4 of 19 in test/expected-dialog.test.ts
  runtime   ×  3 of 4  browser tests   (the write flow is unreachable again)
# the B5 obligation and the B3 guard removed:
  core      ×  3 of 19
# settle rule 3 restored to short-circuiting on ANY interception:
  runtime   ×  3 of 4  browser tests   (the torn read comes back)
  runtime   ×  1 of 19 in test/cycle.test.ts       (hermetic: it needs no Chromium)
# the check-25 dialog clauses removed:
  core      ×  4 of 19
```

#### The one thing this capability does not do, and why

**It returns no outputs.** The core's confirmation screen prints the new account number and the
posting reference as unlabelled `<font>` runs inside a LAYOUT table: measured through
`@crr/surface-browser`, every one of those nodes comes back `ariaRole: null` with no
`tablePosition`, so no `NodeQuery` can name them — `role` cannot select a structural node and `cell`
addressing needs a real table with headers. Returning nothing is the honest answer; inventing an
ordinal into a layout table would be a locator, which is the one thing this design refuses.

**It is the same driver gap §7.6 records on the green screen**, where the member's name is an
unlabelled prose run and `detect()` emits no node for it. Two surfaces, one fix: an unlabelled run of
body text should become a `text` node. Doing it changes node counts that `browser-overlay.test.ts`
asserts (the cross-tenant divergence report), so it is a decision with a blast radius rather than a
one-liner, and it is named here rather than made.

**The nine-step READ flow stays.** `corebank.member.read_share_position` still ends on a prepared
open-sub-account form, and that is now a product decision rather than a limitation: reading a
member's position and posting to their account are different capabilities with different effect
classes, different approval requirements and different `whenNotToUse` prose, and the read one should
not be able to write. The two documents say so to each other — the read contract's third
`whenNotToUse` line names the write capability by role.

**The write flow is NOT in `pnpm demo`, and that is a deliberate omission rather than an oversight.**
The demo bundle is the evidence directory and the redaction canary gates its exit code by grepping
every byte of it for the parameter values a run was given. An irreversible capability's arguments
include an amount that the application prints back on its own confirmation screen, so adding this
flow to the bundle is a decision about what evidence may contain, not a wiring change. It belongs
with whoever writes `/README.md` and `/REPORT.md` (§10). Until then the six tests above are the
evidence, and they run under `pnpm test`.

### 7.4 `resume: "continue"` — a known gap, pinned by a scenario that says so

There is no recovery mode that re-verifies without re-dispatching. Measured consequence: **an
interstitial that appears AFTER a step has acted cannot be recovered.** `retry-step` re-resolves a
target the action already navigated away from, and the engine reports `target-not-found` for a run
that in fact recovered. **Conformance scenario 25 deliberately pins the wrong behaviour**, and its
title says so, so that the day the mode exists a test fails and somebody comes back to it.

**§7.3 did not close this, deliberately.** `Checkpoint.dialog` is about a dialog a step DECLARED as
its own postcondition; §7.4 is about one nobody declared, arriving after the act, which has to be
cleared and re-verified. They look alike and they are opposite: one is a thing the program expected,
the other is an interruption. A single mechanism serving both would have to decide at runtime which
it was looking at, and the whole point of the taxonomy is that a declaration decides that.

### 7.5 The `JournalEvent` type does not discriminate

`packages/core/src/journal.ts:65`:

```ts
const event = <T extends z.core.$ZodShape>(type: string, shape: T) =>
  z.strictObject({ ...envelope, type: z.literal(type), ...shape });
```

`type` is typed `string`, so `z.literal(type)` infers `ZodLiteral<string>` and every union member's
discriminant widens. **The wire format is fine** — it really is a `z.discriminatedUnion` and every
event is parsed before it is written — but `event.type === "resolved"` narrows nothing.
Knock-on: `@crr/runtime`'s `JournalEventInput` is a mapped type keyed on `E["type"]` and collapses to
a string index signature. `@crr/conformance` works around it in one commented place
(`src/journal-view.ts`) with `test/journal-view.test.ts` driving a real run so the workaround cannot
go stale silently. The fix is to make the helper generic over the literal
(`<const N extends string>`), and it will surface real errors across `@crr/runtime`.

### 7.6 One artifact, two tenants — proved. One contract, two surfaces — **not** proved

The multi-tenant claim is measured and green:

```
$ cd packages/runtime && npx vitest run test/browser-overlay.test.ts
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
```

One artifact replays green on both tenants through a 12-token vocabulary overlay (of 21 declared),
4 `routeBasePath` entries, 2 `stripTokens`, 2 `settle` overrides — and **no step override, no
detector, no instruction, no outcome**. Without the overlay's vocabulary the run fails with
`target-underdetermined` and the drift signal names the exact descriptor that abstained. The
divergence metric is the **Jaccard** distance (1 − shared/union), not the terminal spike's
1 − shared/|left|, because the spike's version reports 0% when one tenant is a strict superset of
the other; the departure is pinned by a test that computes the spike's worked example both ways.

**The cross-surface claim is weaker than "one contract, two programs".** The browser corpus's
contract declares a required `memberName` output. The green screen prints the member's name as an
unlabelled plain run (`Member:  12345   AVERY SYNTHETIC`), and `detect()` emits nodes for headings,
labelled fields, legend controls, status bands and tables — **not for prose**. There is nothing for
an `ExtractSpec` to name. Rather than publish a contract the terminal program cannot satisfy, the
terminal declares its own (`corebank.member.account_list@1.0.0`), and
`packages/conformance/test/heterogeneity.test.ts` compares the two `activate` steps field by field
instead. They are identical: both `{kind:"activate"}`, both a `role: "button"` + `role-name`
descriptor on a vocabulary token. **The fix belongs in `detect()`** — unlabelled prose lines in a
screen's body should become `text` nodes. The same gap forced both ambient detectors to read a
screen-id band and a banner heading rather than the sentences `SESSION HAS ENDED` and `*** ABEND
0C7`, and a taxonomy that cannot see the sentence explaining the failure is weaker than one that can.

**The browser has the same gap, and §7.3 found it.** The sub-account capability returns NO outputs,
because the core's confirmation screen prints the new account number and the posting reference as
unlabelled `<font>` runs inside a layout table and every one of those nodes comes back
`ariaRole: null` with no `tablePosition`. Two surfaces, one fix, and it is the same sentence: an
unlabelled run of body text should become a `text` node. On the browser side that changes the node
counts the cross-tenant divergence report above asserts, so it is a decision with a blast radius
rather than a one-liner — which is why it is written down twice and made nowhere.

What *is* proved, and it is the port-falsification result the terminal surface exists for:

```
$ cd packages/conformance && pnpm exec vitest run test/heterogeneity.test.ts
one artifact, one `activate` step, two tenants; bytes the driver wrote to the transport:
  riverbend  "12345\r\x1bOR"     (F3)
  summit     "12345\r\x1b[24~"   (F12)
both runs return status "ok" with typed outputs
```

The artifact contains no F-key and no escape byte; the summit overlay's vocabulary is three tokens
and none of them is a key. Verified by injection three ways (driver hardcodes F3 → 2 tests fail;
harness passes `originAlias: null` → the policy chokepoint denies every action on a routeless
surface, 2 tests fail; linker check 21 short-circuited → the `GATE TWO` test fails).

### 7.7 Limits inside the engine, each named at its site

- ~~**Synthesis cannot name a parameter after a field that has no accessible name.**~~ **CLOSED.**
  `inferParameters` used to fall back to `value${n}`, so the capability synthesized against
  `corebank-web` - whose search inputs have no accessible name at all - offered a calling agent an
  argument called `value1`. `synthesis/parameters.ts` now walks a documented chain ending at the
  label anchor `deriveDescriptors` computes for the same node, which yields `memberId` here, and
  flags the case where every rung comes up empty instead of shipping `value1` in silence. See
  LIVE-RUN-READINESS §5.5.
- **Table cells are not coerced to their declared per-column `ValueType`.** `readTable` rows come
  back as `Record<string, string>`, so `accounts[].balance` is the string the grid printed
  (`"1,204.55"`). The terminal flow works around it by reading the share balance a second time as a
  scalar `table-cell` extract, which *is* typed (`{amount: "1204.55", currency: "USD"}`).
- **Classifier rows 8, 13 and 16 infer a failure class from the remedy** (`reauthenticate` →
  `session-expired-unrecoverable`, `escalate` → `entitlement-denied`, else `app-error`) because
  `RecoveryRuleSchema` has no field naming one. Works, tested, but an inference where the spec
  implies a declaration. One optional `classifyAs` field fixes it; `src/classify.ts` names the site.
- **`maxRemediationCycles: 0` makes ambient recoveries inert**, and four of the five fixture steps
  declare exactly that. The linker check unit 4 asked for ("an artifact declaring ambient recoveries
  has at least one step that can spend one") **was never added** — the list is still 28. Synthesis
  works around it from the recorder side by deriving non-zero step budgets when it lifts a dialog
  into an ambient rule, so the hazard is **half-mitigated and still unchecked**.
- **A `fill` bound to a sensitive parameter has no read-back postcondition.** The driver blanks
  `value` for a masked field, so the truncation defence SPEC §3 asks for does not exist for
  sensitive fills. Resolved in favour of the taint model: the check passes and emits a warning — and
  because `RunWarningSchema`'s enum is closed, that warning rides on the `checkpoint` journal event's
  trace rather than on `RunEnvelope.warnings`, **where a caller would actually see it**. The fix is
  one field on the port: a driver reporting the masked field's *length*.
- **`slow-repaint` outside the budget classifies as `no-observable-effect`, not `did-not-settle`.**
  The terminal surface genuinely does settle — it is perfectly quiet — it just settles on the screen
  that was already there. `did-not-settle` is reachable on a browser, whose driver knows a request is
  outstanding.
- **`@crr/runtime` lists `@crr/surface-browser` in `dependencies` and `src/` never imports it.** The
  *code* is clean (the contract test enforces it); the *manifest* contradicts the design claim
  `cli.ts` makes in its own header. It belongs in `devDependencies` — a one-line change plus a
  `pnpm install`, which this pass was not permitted to run.

---

## 8. What is stubbed, and why

Every one is stubbed at a clean seam and says so at the seam.

| Stub | Where | Why, and what it costs |
|---|---|---|
| **`agent-sdk` adapter** | named in `DISCOVERY_ADAPTERS`, no implementation | Dev-only by design (BRIEF §10) and must never produce evidence. It runs Claude Code's loop, not ours, so it validates none of our prompt shape, tool schemas, observation serialization or stopping conditions. |
| **No outcome detectors are synthesized** | `synthesis/emit.ts` | SPEC §0.2 forbids inferring one. `contract.outcomes` comes out `[]` and the model's `finish` candidates ride in `SynthesisReport` with an `outcome-candidate-needs-detector` note. A generated `detect` predicate for a screen the run never observed is exactly how a false `MEMBER_NOT_FOUND` gets emitted. |
| **`whenToUse` / `whenNotToUse` are not generated** | `synthesis/emit.ts` | Filled with `"NEEDS AN AUTHOR"` plus a `prose-needs-author` note. Models mis-route far more often than they mis-fill arguments, so a generated line there is a generated routing decision. |
| **`effect-in-doubt` escalates and journals but is not parked** | `interpreter.ts` | It does not appear in the operator console queue; the arm stays `failed`, which is correct (the caller must not retry). Wiring it needs a second kind of parked entry — a live session a human may look at and may never hand back. Seam named in a comment at the site. |
| **Approval key custody does not exist** | `runtime/approval.ts` | OPEN-QUESTIONS-RESOLVED Q5, deliberately out of scope. `ApprovalSigner` is a port so a KMS or HSM substitutes cleanly; `ed25519Signer` holds a private key in process memory with **no approver identity, no expiry and no revocation**. Signature *verification* is real (`ed25519Trust`), and the linker does compare `approval.over` to the artifact's digest and refuse an unverifiable approval (checks 26/27) — so CORE-STATUS §7 items 3 and 4 are now closed. |
| **`examples/` does not exist** | `pnpm-workspace.yaml` lists it | Creating a workspace member needs a `pnpm install`. The demo lives in `packages/runtime/demo/` instead, covered by `test/demo-contract.test.ts` (which asserts it imports no driver and reads no credential). The only `--surface <module>` factory in the repo is a test fixture. |
| **Desktop (AX/UIA) surface** | not built | A documented seam, per BRIEF §3.1. The `Surface` port is two operations and the terminal driver is the proof they are not browser-shaped. |
| **`openai` model id has no default** | `adapters/openai.ts` | Deliberate. BRIEF §9 forbids writing a model id from memory and there is no OpenAI counterpart to the `claude-api` skill, so `createOpenAIModel` throws unless `modelId` or `CRR_OPENAI_MODEL` is supplied, with an error that says why. |

---

## 9. Repository hygiene — five files that must be deleted, and could not be

`rm` and `mv` are denied to every agent that has worked in this tree, and the deletion attempt in
this pass was blocked as well. **Re-confirmed in the verification pass: `rm -f /.exports.mjs` was
denied by the permission system, and all five entries below are still present.** None of these
affects any test, the build, `pnpm typecheck` or `pnpm lint`. Three of them **are not gitignored and
would be committed**:

```
rm  /.exports.mjs                          # 0 bytes, a throwaway export scanner. NOT gitignored.
rm  /packages/conformance/probe.ts         # `export {}` + a "DELETE THIS FILE" header. NOT gitignored.
rm  /packages/conformance/src/__probe.ts   # `export {}` + a "DELETE THIS FILE" header. NOT gitignored.
rm -rf /packages/core/.scratch/            # probe.ts (1,326 B) + probe2.ts (798 B). Gitignored, but
                                           # probe.ts is Playwright/CDP spike code sitting inside the
                                           # package whose entire claim is that it is pure.
rm -rf /.scratch/  /packages/conformance/.scratch/   # this pass's working files and backups.
```

`packages/conformance/src/__probe.ts` is on the new barrel test's `NOT_ON_THE_BARREL` ledger as a
**defect, not a decision**, and boxed in by two assertions (zero exports, under 800 bytes) so it
cannot quietly grow back into a module while it waits. When it is deleted, the ledger entry should
go with it; the test tolerates its absence by design.

`/.scratch/` now holds **60 files**, including the seam pass's four probes (`probe-capture.ts`,
`probe-proj.ts`, `probe-synth.ts`, `probe-obs.json`) and a run of `*.bak` and `*.log` working files.
It is gitignored and read by no test, lint or contract scan. **The verification pass added nothing
to it** — its temporary files went to a session scratchpad outside the repository, and the only
files it wrote inside the tree are the four it means to ship:
`packages/discovery/tools/preflight.ts`, plus one line each in `packages/discovery/package.json`,
`packages/discovery/tsconfig.json` and the root `package.json`.

---

## 10. Deliverables still missing

BRIEF §7 names three paths. Two do not exist.

- **`/README.md` — MISSING.** Required to cover setup, config/keys, how to run without live
  services, and a demo path. The text it needs from this pass:
  `pnpm install` → `pnpm exec playwright install chromium` (**once, and not optional — see §1: 46
  tests silently skip without it**) → `pnpm demo`, which produces the whole of `/evidence/` with no
  live service and exits non-zero if any scenario misses its declared arm or the redaction canary
  finds a parameter value. Also needs the `agent-sdk`-is-dev-only warning BRIEF §10 requires, and
  now `pnpm preflight` — the one command a reader should be told to run before any command that
  costs money (§7.1). (The "38" in earlier revisions of this line was stale: the number moved to 42
  when §7.2 closed and to 46 when §7.3 did, and only §1 was updated. Re-measured this pass:
  `runtime 16 + surface-browser 29 + conformance 1 = 46`.)
- **`/REPORT.md` — MISSING.** 1–3 pages under exactly seven headings: Architecture · Artifact schema
  · Determinism & error handling · Heterogeneity & multi-tenant · Escalation & handoff · Safety ·
  Cuts.
- **`/evidence/` — PRESENT**, 48 files, minus the live discovery run (§7.1).
- **The live-run runner — MISSING, and newly identified as its own deliverable.** Not a BRIEF §7
  path, but §7.1's evidence cannot exist without it and nothing in the repo provides it. `pnpm
  preflight` exists and reports its absence as a blocker; what it is waiting for is a script that
  composes `createAnthropicModel` → `createRecordingModel` → `runDiscoveryLoop` → `synthesizeCapability`
  → `verifyAndDraft` → the six files `evidence/discovery-live/PENDING.md` names.

---

## 11. Corrections to the unit reports

Where a unit's claim could not be reproduced in this working tree, this is what was found instead.

1. **`SETTLE_POLICY_DEFAULTS.stableSamples = 3` was claimed and was NOT in the tree.** It had been
   reverted to `2` by a concurrent edit. Re-applied, and guarded — §3.4.
2. **The false-success split on the browser corpus is 13 / 4, not 12 / 5.** Unit 17 reported "12
   false successes and 5 misclassifications" out of 17 kills. Re-running `buildKillMatrix` over
   `ALL_SCENARIOS` today gives 17 kills of which **13** are false successes. The total is unchanged;
   the split is not. Command in §5.1.
3. **`packages/core/test/no-locator-vocabulary.test.ts` is green.** Unit 19 reported it failing
   because `packages/conformance/` existed and was not on `ABOVE_THE_DRIVERS`; it has since been
   added, and this pass verified by injection that the scan really reads conformance's `src/`.
4. **`@crr/conformance`'s `playwright` and `@crr/surface-browser` devDependencies are not unused.**
   Unit 17 asked for both to be dropped. `test/heterogeneity.test.ts` (added later) imports
   `attachBrowserSurface` and `chromium`, and the new barrel test imports `CaptureSink` from both
   drivers as types. Both should stay.
5. **The lockfile is consistent with every manifest.** Unit 20 flagged its hand-written `link:`
   entries as possibly leaving pnpm's bookkeeping stale. A full comparison of all nine importers
   against all nine `package.json` files reports **0 problems**, and `node_modules/.modules.yaml`
   has `pendingBuilds: []`. A `pnpm install` is still worth running once, but nothing is broken.
6. **`pnpm lint` exits 0 over 301 files.** Units 19 and 24 reported 15–24 diagnostics; those were
   sibling agents' in-progress files and are gone. Three formatting diagnostics introduced by this
   pass's renames were fixed with `biome check --write` on the three affected files.
7. **`@crr/conformance` typechecks.** Unit 24 reported
   `src/scenarios/terminal.ts(168,72): Property 'settled' does not exist on type 'JournalEvent'`.
   That module was moved to `test/terminal/scenarios.ts` and the narrowing now goes through
   `src/journal-view.ts`. The underlying core defect is real and still open — §7.5.
8. **`packages/conformance/src` imports no driver.** Unit 24 reported `src/corpus/terminal-harness.ts`
   importing `@crr/surface-terminal`. The driver wiring now lives in `test/terminal/harness.ts`; the
   documents stayed in `src/`. Verified by injection.

**Added by the verification pass that built `pnpm preflight`. These are corrections to THIS
document, not to a unit report.**

9. **§7.1's "one command away from closing" was false, and it was this document's own claim.**
   There is no command. `createAnthropicModel` has no caller outside its unit tests, so the live
   discovery run cannot be performed even with the author's approval and a funded key. Rewritten in
   §7.1 with the grep that shows it, and the missing runner is now its own entry in §10.
   `RUNTIME-STATUS.md:572` had recorded the same fact and it was never carried across.
10. **§10's "38 tests silently skip without Chromium" was stale.** The number moved to 42 when §7.2
    closed and to 46 when §7.3 did; §1 was updated both times and §10 was not. Re-measured this
    pass with `PLAYWRIGHT_BROWSERS_PATH` pointed at an empty directory: `runtime 295 passed | 16
    skipped`, `surface-browser 78 | 29`, `conformance 101 | 1` — **46**, and 1,739 green without a
    browser. §1's figure was correct; §10's was not, and is now.
11. **Everything else in §§1–8 that this pass re-ran, reproduced.** 1,785 tests across 101 files in
    8 members, all green with the four credential variables unset; `pnpm build` 8/8; `pnpm
    typecheck` 14/14; `pnpm lint` clean (310 files now, +1 for the preflight); `pnpm demo` 7/7 with
    both canary passes CLEAN. The per-package counts in §2's table match test for test. What this
    pass did **not** re-verify is every injection experiment §§3–7 describe; those still stand on
    the units that ran them, and where a section leans on one it now says so.

---

## 12. What a reviewer should take from this

**Proved, by a command in this document:** the classifier's three-way split; descriptor agreement as
a detected condition rather than a fallback chain; the single policy chokepoint, covering the
interpreter, the model's own action during discovery and a human's action through the operator
console alike; the typed four-arm result contract; the escalation path; **a conformance suite with
nine weakened engines, zero survivors over the combined corpus, zero false successes for the
reference engine, and a meta-test verified to fail when the suite stops discriminating**; one
artifact replaying green on two tenants of one vendor product through a non-semantic overlay; and
one `activate` step lowering to a click on a browser and to `F3`/`F12` on two tenants of a green
screen.

**And the cycle itself, which was the headline gap until this pass — a SYNTHESIZED artifact
replays.** `@crr/discovery` emits its contract and artifact to a committed JSON file; `@crr/runtime` reads that
file as data and executes it against the real hostile fixture in a real browser, verifies it,
approves it with an ed25519 signature over its digest, and then invokes it for a member the
recording never saw. Executing it found two real defects in synthesis - a member's name and balance
in a signed document, and every delivered string case-folded - both fixed and both guarded (§7.2).

**And the irreversible write, which was the other headline gap — a real sub-account is opened
against the real fixture in a real browser, the modal confirmation is what authorizes it, and the
core is asked afterwards how many accounts it holds.** A dry-run verification stops at the boundary
and the count does not move; a verification followed by an approved invocation opens exactly one;
the fixture's maintenance interstitial, which is the SAME modal widget with a different accessible
name, is still `undeclared-dialog` and posts nothing. Closing it found a second real defect — a torn
read on a browser, the accessibility tree of one document stitched to the frame tree of the previous
one — which was invisible while every dialog was a hard failure and is fixed and guarded (§7.3).

**Not proved:** that a model has ever driven this system end to end (§7.1). It remains the only
headline gap, and this pass corrected what that gap actually is. It is **not** "one approved API
call away" — earlier revisions of this document said so and they were wrong. The shipping Anthropic
adapter has no caller outside its own unit tests, so there is no command for the author to approve.
Closing it takes two things in order: **write the runner**, then **approve the run**.

**What this pass shipped toward it:** `pnpm preflight`, a readiness check that makes no model call
and never uses the key, and that puts the whole decision on one screen — the exact request body, a
locally estimated ~2,135-token turn 1 and ~124-token first observation, a cost table at both
published rates ($0.31 for a realistic 8-turn run on `claude-opus-5`, $31.90 for the absolute
worst case the budgets permit), the full policy allowlist with the real `check()` run against an
off-allowlist route in front of you, and the destination the transcript would land in. It exits
non-zero today, and the blocker it names is the missing runner.

**Do not read the green board as completeness.** 46 of 1,785 tests are browser-conditional and skip
silently; the flake rate is measured over a fixture we control, not a vendor app; four of nine
mutants survive the green-screen corpus for reasons that are properties of the surface and are
written down rather than papered over; and `pnpm preflight` itself has no automated test — it is
verified by running it, which this pass did in three configurations (§7.1).
