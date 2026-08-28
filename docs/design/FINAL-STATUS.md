# FINAL-STATUS — the true state of `capability-record-replay`

**This document feeds `REPORT.md`. Nothing in it is a claim; every number is followed by the command
that produced it, and every command in it was run in this working tree on 2026-08-27.** Where an
earlier revision of this document asserted something this pass could not reproduce, the discrepancy
is stated rather than smoothed over — see §11. Twelve of the twenty corrections in §11 are
corrections to **this file**, and §11.12 is the largest of them.

Read §7 (what does not work) and §8 (what is stubbed) before §2 (the green board). The board is
green; §7 is why that is not the same as "done".

---

## 1. Headline

```
$ TURBO_FORCE=1 pnpm build          →  Tasks: 8 successful, 8 total     5.545s    exit 0
$ TURBO_FORCE=1 pnpm typecheck      →  Tasks: 14 successful, 14 total   5.66s     exit 0
$ pnpm lint                         →  Checked 314 files in 92ms. No fixes applied.  exit 0

$ env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY \
      -u CLAUDE_CODE_OAUTH_TOKEN TURBO_FORCE=1 pnpm test
                                    →  Tasks: 14 successful, 14 total   1m29.506s exit 0

$ env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY \
      -u CLAUDE_CODE_OAUTH_TOKEN pnpm demo
                                    →  7/7 exhibits PASS, 48 files, 9.9s, canary CLEAN, exit 0

$ pnpm preflight                    →  NOT READY - 1 blocker(s).  14 check(s) passed.   exit 1
$ ANTHROPIC_API_KEY=<well-formed> pnpm preflight
                                    →  READY. Every check passed.  15 check(s) passed.  exit 0

$ pnpm discover --dry-run --force   →  the whole runner, end to end                     exit 0
$ pnpm discover                     →  (not run here: it is the author's to authorise)
```

**`pnpm preflight`'s only blocker on this machine is the shell, not the repository.** It reads
`ANTHROPIC_API_KEY` from the shell to check its *shape*, and this shell has none. Everything it
checks about the repository passes, including the check that used to fail — `[recorder] BLOCK  no
runner exists` — because **the runner now exists** (§3.5, §7.1). The READY line above was produced
with a syntactically valid **fake** key exported, which exercises the shape branch and nothing else;
it proves the other fourteen checks pass, not that the author's real key is well-formed.

**1,820 tests across 102 files in 8 workspace members. All pass. No live model API call was made at
any point in this pass, to any provider.**

The count moved 1,726 → 1,759 when §7.2 was closed (25 tests in
`packages/discovery/test/synthesis-corebank-web.test.ts`, 8 in
`packages/runtime/test/synthesized-replay.test.ts`), 1,759 → 1,785 when §7.3 was closed (19 in
`packages/core/test/expected-dialog.test.ts`, 6 in `packages/runtime/test/browser-write.test.ts`,
one in `runtime/test/cycle.test.ts` for the settle-loop defect that closing it uncovered),
1,785 → 1,805 when §3.5 was closed (18 in the new `packages/discovery/test/loop-failure.test.ts`,
2 in `packages/runtime/test/demo-contract.test.ts`), and 1,805 → 1,820 when §3.6 was closed
(15 across `synthesis-parameterization.test.ts`, `synthesis-corebank-web.test.ts` and
`synthesized-replay.test.ts`). **Nothing was weakened, skipped or deleted to make room for any of
them**, and that is mechanical rather than promised:

```
$ grep -rn 'it\.skip\|test\.skip\|describe\.skip\|\.todo(' packages/*/test fixtures/*/test \
      --include='*.ts' | wc -l
  14
```

All fourteen are the Chromium guard — `const describeBrowser = CHROMIUM ? describe : describe.skip`
and `describe.skipIf(!chromiumAvailable())`. There is no unconditional skip and no `.todo` anywhere
in the suite.

**One honesty caveat on the credential-unset run.** This machine had **no credentials in the shell**
—

```
$ echo "${ANTHROPIC_API_KEY:+YES}${ANTHROPIC_API_KEY:-NO}"   →  NO   (same for the other three)
```

— so `env -u …` was a no-op relative to a plain run, and on its own it proves nothing a plain run
would not. (Re-confirmed from the other side this pass: `pnpm preflight`'s first check reads
`ANTHROPIC_API_KEY` and reported it unset, which is why its verdict carries a credential blocker.)
It is also **not** true that there is no funded credential anywhere near this tree: `<repo>/.env`
holds live, funded keys. What carries the claim is structural, and it is checkable:

- **Nothing in `packages/` or `fixtures/` loads `.env`, and exactly one file in the repository
  does.** `grep -rn dotenv` over both returns nothing. The single reader is `loadDotEnv` in
  `packages/discovery/tools/discover.ts` — not on any barrel, not imported by any library module,
  and it announces the variable *names* it set and never a value, a prefix or a length. An
  already-set shell variable always beats the file. **`tools/preflight.ts` does not read `.env` at
  all**; it names it only in the prose it prints, telling you that `pnpm discover` will find a key
  its own check just said was absent from your shell.
- **Only two shipped modules read `process.env` for a credential**, and both do it inside a factory
  whose `env` is an injectable parameter — `packages/discovery/src/adapters/anthropic.ts:133` and
  `adapters/openai.ts:420`, both spelled `options.env ?? process.env`. (The three other
  `process.env` reads in shipped source are a fixture's `PORT`, a fixture's TTY setup and the
  terminal transport's child-process env. Re-grepped this pass: still exactly three.)
- **Every adapter construction in the test suite injects both.** Re-measured this pass, not carried
  forward:

  ```
  $ cd packages/discovery && python3 <scan of create{Anthropic,OpenAI}Model call sites under test/,
                                      skipping matches on comment lines>
    adapter factory call sites in tests: 27
    without BOTH an injected env and an injected transport: 3
      test/anthropic-adapter.test.ts:130  env=True transport=False   ← asserts the refusal
      test/anthropic-adapter.test.ts:131  env=True transport=False   ← asserts the refusal
      test/openai-adapter.test.ts:132     env=True transport=False   ← asserts the refusal
  ```

  All 27 pass an explicit `env`; the three without a transport are the tests that assert the factory
  *throws* when no key is present. A real key in the environment therefore cannot reach a client.
  (The scan must skip comment lines: `test/fixtures/build-openai-cassette.ts:122` says
  *"Hand this to `createOpenAIModel({ fetch })`"* in a doc comment, and a naive scan counts it as a
  28th site with no injected `env`.)

**A second caveat on the board, which matters more than it looks.** 46 of the 1,820 tests are
skipped when no Chromium build is installed, and **every suite still reports green**:

```
$ env -u ANTHROPIC_API_KEY … PLAYWRIGHT_BROWSERS_PATH=<empty dir> TURBO_FORCE=1 pnpm test
    @crr/surface-browser   Tests   78 passed |  29 skipped (107)
    @crr/runtime           Tests  298 passed |  16 skipped (314)
    @crr/conformance       Tests  101 passed |   1 skipped (102)
    (the other five members unchanged)      Tasks: 14 successful, 14 total     exit 0
```

A reviewer who runs `pnpm install && pnpm test` without `pnpm exec playwright install chromium` gets
**1,774 passing tests and a green board**, and **every test that has ever touched a real browser is
among the 46** — including the five that execute a synthesized artifact (§7.2) and the four that
open a real sub-account (§7.3). The guards print a warning to stderr (`[@crr/runtime] SKIPPING every
browser replay test: no Chromium build was found`), and the seam test prints a second, more specific
one naming itself and saying that the synthesized artifact was parsed and linked but never executed.
That is still the only signal. This must be in the README's setup section, not left to be
discovered.

---

## 2. Per package

| Package | Tests | Files | src | What it establishes |
|---|---:|---:|---|---|
| `@crr/core` | 788 | 36 | 39 files / 15,293 lines | Schema, canonical JSON + digest, the **28-check linker**, the classifier, the target resolver, the extractor, overlay merge, the policy chokepoint, the prose renderers. Pure — no clock, no I/O, no randomness, no driver import, enforced by a source-scanning contract test verified by injection. |
| `@crr/runtime` | 314 | 21 | 29 / 9,942 | Interpreter, settle loop, budget ledgers, control lease, journal writer, evidence sink, file store, catalog/`invoke`, ed25519 approval verification, operator console, the `crr` CLI, the redaction canary, `pnpm demo`. |
| `@crr/discovery` | 282 | 14 | 19 / 7,468 | Provider port, manual Anthropic loop, **OpenAI adapter** (HTTP shape over an injected `fetch`), VCR transcript record/replay, synthesis, parameter naming. The only package that may import a model SDK. |
| `@crr/surface-browser` | 107 | 12 | 11 / 2,501 | Per-frame CDP `Accessibility.getFullAXTree` stitch → `Observation`, dialog ownership, `perceive` deadline, PNG mask. |
| `@crr/surface-terminal` | 125 | 9 | 10 / 2,446 | `@xterm/headless` over a `TerminalTransport` port → `Observation` from an 80×24 character grid, `detect()`, `act()` with F-key lowering, screen-id → route canonicalization. |
| `@crr/conformance` | 102 | 8 | 16 / 5,039 | 25 browser scenarios + 14 terminal scenarios × 10 engines (1 reference, 9 mutants), the meta-test, multi-run stability, the `stableSamples` sweep, the cross-workspace name ledger. |
| `fixtures/corebank-web` | 66 | 1 | 1,971 lines | Frameset, nested layout tables, generated ids, `<font>`, no test ids, **two confirmation channels** (an in-page modal and a native `confirm()`), a real non-idempotent sub-account commit, 8 injectable faults, 2 tenant variants. |
| `fixtures/corebank-tui` | 36 | 1 | 970 lines | 80×24 green screen, 4 fault modes in 2 families, 2 tenant variants. |
| **Total** | **1,820** | **102** | | |

Command for every count in the table: `env -u … TURBO_FORCE=1 pnpm test` (per-package
`Tests N passed (N)` lines), and `find packages/<p>/src -name '*.ts' | wc -l` /
`cat $(…) | wc -l` for the sizes.

**Four files are in none of those `src` numbers, on purpose**, because they are entry points rather
than library modules — `packages/discovery/tools/`:

| File | Lines | What it is |
|---|---:|---|
| `discover.ts` | 1,630 | `pnpm discover` — the live-run runner (§3.5, §7.1). |
| `preflight.ts` | 1,121 | `pnpm preflight` — the readiness check that makes no model call (§7.1). |
| `bundle.ts` | 338 | The four files a run must not lose, written by one function with no status check (§3.5). |
| `live-run.ts` | 291 | The goal, tenant, allowlist, rates, budgets and hand-authored prose the other three read. |

They are outside `src/`, so they are not on the barrel, not in the built library, not read by the
barrel test's module-coverage invariant, and not counted in the `src` column; `tsconfig.json`
includes `tools/**/*.ts` so `pnpm typecheck` reads them, and `pnpm lint` covers them because biome
reads the whole tree. **Two of the four are directly under test** —
`packages/discovery/test/loop-failure.test.ts` imports `bundle.ts` and `live-run.ts` and reads
`discover.ts` off disk — and `preflight.ts` is not; see §7.1.

Build output, `TURBO_FORCE=1 pnpm build`:

```
core            ESM 325.39 KB   declarations 287,298 bytes across 39 files (tsc, per-file)
runtime         ESM  84.07 KB   (+ cli.js 12.62 KB)   DTS  96.02 KB
discovery       ESM 137.99 KB   DTS  85.70 KB
conformance     ESM 116.82 KB   DTS  54.56 KB
surface-browser ESM  55.39 KB   DTS  24.08 KB
surface-terminal ESM 50.74 KB   DTS  21.95 KB
```

(`discovery` grew from 132.20 KB / 77.33 KB when the parameter-naming chain and the loop's failure
path landed — §3.5, §3.6.)

---

## 3. What the recent passes changed

§3.1–§3.4 are the integration pass: cross-package conflicts, the architecture contract tests over
the new packages, a barrel test for `@crr/conformance`, and a measured constant that had been
silently lost. §3.5 and §3.6 are the two passes since, and they are what made §7.1 a different
sentence than it was.

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
has `pendingBuilds: []` and the tree resolves. **No pass since has run `pnpm add` or `pnpm install`**
— BRIEF §11 and the `@crr/core`-stays-pure rule both forbid it — so no manifest has moved.

### 3.2 The architecture contract tests, over the new packages

`ABOVE_THE_DRIVERS` in `packages/core/test/no-locator-vocabulary.test.ts` is
`["core", "runtime", "discovery", "conformance"]`. The task expected this to be failing; it had
already been fixed, and the integration pass verified it is **doing work** rather than merely
present:

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
side: the same selector appended to `packages/surface-terminal/src/grid.ts` leaves the suite green.
A driver is precisely the layer allowed to know what a stylesheet is.

The per-package floor assertion covers conformance (`counted.get("conformance") > 5`), so the scan
cannot silently stop reading it. `DRIVER_LIBRARIES` already includes `@xterm/headless`, so reaching
for the emulator directly is caught as well as importing the driver package.

**It does NOT read `packages/discovery/tools/`, and that is worth being exact about**, because the
runner is the one new file that drives a browser. `packageSources` filters `repoSources` to
`packages/<p>/src/` (`packages/core/test/architecture-scan.ts:399`), so `tools/discover.ts` is
outside this particular scan. Two things follow, one reassuring and one a limit:

- **The chokepoint test *does* cover it.** `policy-chokepoint.test.ts` uses `repoSources` directly,
  which walks every non-test `.ts` under `packages/`, `apps/`, `examples/` and `fixtures/`. The
  runner is inside that set.
- **The runner keeps the `src/` scan's claim true by depending on nothing.** `@crr/discovery`
  declares neither `playwright`, nor `@crr/surface-browser`, nor the fixture, nor `@crr/runtime` —
  the package that owns the model loop has no business depending on a driver or an interpreter, and
  the locator scan reads `packages/discovery/src` off disk to say so. `tools/discover.ts` therefore
  resolves all four **by path** at runtime (`createRequire` and dynamic `import`), with the reasoning
  written at the site (`discover.ts:48–56`). The cost is named there too: the `@crr/runtime` slice in
  that file is a hand-written structural type rather than the real one, **so that seam is checked by
  running it, which is what `--dry-run` is for** — not by `tsc`.

Grepped this pass, `packages/discovery/tools/*.ts` contains no `querySelector`, `getElementById`,
`innerHTML`, `[data-`, `xpath` or `css`. That is a grep in a document, not a standing test.

### 3.3 A barrel test for `@crr/conformance` (`packages/conformance/test/barrel.test.ts`)

`@crr/surface-terminal` already had one. `@crr/conformance` did not; it does now, 12 tests, and it
carries a second job.

Its barrel is **curated** (hand-written named re-exports, not `export *`), so the ambiguous-star
failure cannot occur by construction and the module-coverage invariant changes shape: every module
is either on the barrel or on a `NOT_ON_THE_BARREL` ledger with a reason. Two entries —
`stability-cli.ts` (an entry point, kept out of the library graph for the same reason
`@crr/runtime` keeps `cli.ts` out) and `__probe.ts` (a leftover scratch file; see §9).

**The second job is the workspace-wide name ledger.** `@crr/runtime`'s barrel test carries a
three-package version and says in its own header that "`@crr/conformance` will depend on both and is
the better home". The newer one reads **all six** packages off disk. That extension is not cosmetic
— it is the only thing in the repository that can see a collision between the two drivers, which are
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

It was re-applied, and **the guard that was missing was added**. `packages/core/src/artifact.ts:248`
reads `stableSamples: 3` in this working tree, checked just now. The sweep, **re-run this pass**:

```
$ env -u ANTHROPIC_API_KEY … pnpm -F @crr/conformance stability
  SettlePolicy.stableSamples sweep - engine: reference
  case               expected                        n=1        n=2        n=3        n=4
  happy              ok                            ok 7p     ok 14p     ok 21p     ok 28p
  slow-load          ok                            ok 9p     ok 16p     ok 23p     ok 30p
  never-settles      failed:did-not-settle        ok 44p     ok 47p     ok 50p     ok 53p
  tear-1             ok                         WRONG 4p     ok 15p     ok 22p     ok 29p
  tear-2             ok                         WRONG 4p   WRONG 8p     ok 23p     ok 30p
  tear-3             ok                         WRONG 4p   WRONG 8p  WRONG 12p     ok 31p
  tear-persistent    failed:checkpoint-failed      ok 4p      ok 8p     ok 12p     ok 16p

  LAW: stableSamples = n rejects a tear of up to n-1 consecutive polls, and no more.
       Every swept value obeyed it.
  measured tear width: 2 consecutive polls
  THE EVIDENCE SUPPORTS stableSamples = 3: the smallest value that is correct on every control
       case and rejects a tear as wide as the one that was actually measured.
  AND THE LIMIT: `tear-persistent` is caught at EVERY value, by the CHECKPOINT rather than by the
       settle loop. Raising stableSamples buys one more poll of tear rejected per extra poll per
       step; it does not turn quiescence into a readiness signal, and no value of it would.
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

### 3.5 The live-run path — the runner, and the two ways a paid run could have lost its transcript

This is the pass that changed §7.1 from *"there is no command"* to *"there is a command and it has
not been authorised"*. Four files, three of them new:

| File | What it does |
|---|---|
| `tools/live-run.ts` | The goal, the member, the tenant, the allowlist, `MODEL_RATES`, `DISCOVER_MAX_OUTPUT_TOKENS`, `costOf()`, `billedTokens()`, and the hand-authored capability prose. Everything the other three read, in one place, so the preflight and the runner cannot disagree about what a run is. |
| `tools/discover.ts` | `pnpm discover`. Boots the fixture on an ephemeral loopback port, launches Chromium, composes `createAnthropicModel` → `createRecordingModel` → `runDiscoveryLoop` → `synthesizeCapability` → `verifyAndDraft` → `runRedactionCanary`, and writes the bundle. |
| `tools/bundle.ts` | `writeCoreBundle()` and `discoveryExitCode()` — see below. |
| `tools/preflight.ts` | `pnpm preflight`, from the previous pass. §7.1. |

**The `--yes` gate.** `createAnthropicModel` is constructed **inside** the branch the gate guards
(`tools/discover.ts:1100–1105`), and the refusal (`:1078`) returns before it. Read off the source in
this working tree, in this order: dotenv load → confirmation screen → `if (!dryRun && !yes) exit 2`
→ fixture boot → `chromium.launch()` → model construction. **There is no flag combination that
reaches the provider by accident**, and no flag combination that constructs an Anthropic client
without `--yes`. The refusal was *observed* firing with the author's real funded credential loaded
into the process by the pass that built it; **this pass verified it structurally and did not run it**,
because a bare `pnpm discover` is not on this pass's task list and BRIEF §11 makes that the author's
command, not an agent's.

**Both spend guards, re-observed firing this pass.** They live **inside** `runDiscoveryLoop` as
`stopBeforeTurn`, not around the model, and that placement is what makes them safe: the loop
`break`s, `loop.finished` is journaled, the recorded steps survive, and a `DiscoveryRun` comes back
for the bundle writer.

```
$ pnpm discover --dry-run --force --max-usd 0.05 --out .scratch/budget-usd
      status          budget-exhausted
      summary         the spend cap stopped this run: $0.0000 has been billed and turn 1 projects
                      to at most $0.06 (2,201 prompt tokens at $5/Mtok plus 2,000 output tokens at
                      $25/Mtok), which would cross the $0.05 ceiling. …
      turns           0                                                              exit 1

$ pnpm discover --dry-run --force --max-total-tokens 100 --out .scratch/budget-tokens
      status          budget-exhausted
      summary         the token backstop stopped this run: 0 tokens have been billed and turn 1
                      would take it to at most 4,201, past the 100 ceiling. This guard is
                      price-independent; if it fired before the spend cap did, MODEL_RATES is
                      probably wrong.
      turns           0                                                              exit 1

$ python3 <read loop.* events out of both journals>
  .scratch/budget-usd/journal.jsonl
    {"type": "loop.started"}
    {"type": "loop.finished", "status": "budget-exhausted", "turns": 0, "actions": 0, …}
  .scratch/budget-tokens/journal.jsonl        (identical)
```

Both runs still wrote `provenance.json`, `spend.json`, `README.md` and all four canary reports. **A
guard that destroys the evidence of firing is worse than no guard**, and that is the principle the
rest of this section is about.

**Two ways a paid run could have lost the transcript it had already paid for, both fixed.**

1. **A mid-run API error threw the transcript away.** `runDiscoveryLoop` did not catch a
   `DiscoveryModelError`. A rate limit, a 400 or a dropped connection propagated out to
   `discover.ts`'s outer `catch`, which printed `FAILED: …` and exited 1 — at which point
   `transcript.json`, `spend.json`, `provenance.json`, `README.md` and `discovery.log` **had not been
   written**, because every one of them is written after the loop returns. The only durable record of
   a partly-paid run was `journal.jsonl`. The loop's own `TurnBudgetProbe` comment already stated the
   principle — *"a budget guard that throws away the transcript it was protecting has spent the money
   and kept nothing"* — and the budget path honoured it while the exception path did not.

   `src/loop.ts` now wraps the turn cycle and ends the run with status **`failed`** carrying a
   `DiscoveryFailure { name, message, adapter, turn, stack }`. The catch is deliberately **not**
   narrowed to `DiscoveryModelError`: a dropped socket, a journal sink that could not write and a bug
   in the file are all *"the run ended and here is what it had"*. It is **opt-in**
   (`onUnexpectedError: "keep-the-run"`) because the VCR's strict digest check exists to be loud when
   a fixture stops matching the prompt, and three tests in `test/vcr.test.ts` assert that loudness —
   so only the caller that *paid* for the turns may say that keeping them beats failing loudly, and
   that caller says it at the call site (`tools/discover.ts:1188`). A test reads `discover.ts` off
   disk and fails if it ever stops saying it.

   `tools/bundle.ts` is the other half: the four files a run must not lose are written by one named
   function with **no status check and no early return anywhere in it**. They used to be forty lines
   of `writeJson` in the middle of the `try` a provider error jumped straight out of, and a script
   with top-level `await` and `process.exit` in it cannot be imported, so nothing could assert that
   the bytes reached the disk.

   ```
   $ pnpm -F @crr/discovery exec vitest run test/loop-failure.test.ts
      ✓ test/loop-failure.test.ts (18 tests) 36ms
        Test Files  1 passed (1)        Tests  18 passed (18)                        exit 0
   ```

   It injects a `DiscoveryModelError` at turn 3 of a scripted run through the real recorder and the
   real loop, then writes the bundle through the same function the runner calls, into a `mkdtemp`
   directory, and asserts — in the order the money leaves — that the run comes back `failed` naming
   the adapter and the turn; that the step turn 2 recorded is still there; that `transcript.json` is
   **on disk** holding turns 1 and 2 with the provider's per-turn usage; that `spend.json`'s
   `totalUsd` equals `costOf()` over exactly those two turns; that `provenance.json` says
   `"status": "failed"` and carries **no stack** (a stack has absolute paths in it and
   `discovery.log` is committed); that `README.md` opens with *"This run ended on an error"*; that
   `discoveryExitCode()` is **1** even with `verified: true` and a clean canary; and that a value
   bound to a sensitive parameter appears in none of the four files.

   One accounting point the files make visible: the transcript holds the turns the provider
   *answered*. A request that raised returns no response and no `usage`, so turn 3 is in `run.turns`
   and in `provenance.run.failure.turn` but **not** in `transcript.turns` and not in the ledger — you
   were not billed for it. `provenance.json` carries both numbers side by side so the gap is
   something you can read rather than infer.

2. **`pnpm demo` re-created `PENDING.md` on top of a live run.**
   `packages/runtime/demo/main.ts`'s `discoverySlot()` writes `evidence/discovery-live/PENDING.md`
   with the words *"This directory holds nothing."* It was called unconditionally — and the runner
   deletes `PENDING.md` on success precisely to avoid *"a bundle that contains both a transcript and
   a note saying there is no transcript"*, while its own closing message tells you to run `pnpm demo`
   next. The note came straight back.

   It is now behind the `liveRunPresent()` helper that already guarded the MANIFEST row, and the
   demo **names** the contradiction when it finds one (a failed live run leaves both files in place
   deliberately) rather than silently tidying up a file the runner meant to leave. Verified by
   *running* the demo against a `mkdtemp` evidence directory holding an obviously fake
   `transcript.json`, through a new `CRR_DEMO_EVIDENCE_DIR` seam — **`evidence/` itself was not
   touched**, because writing a fake transcript into `evidence/discovery-live/` is the one thing that
   directory forbids. `packages/runtime/test/demo-contract.test.ts` grew two tests: one that reads
   `demo/main.ts` off disk and fails if the call is ever unguarded, and one that runs the same
   scanner against three sources that *do* break the rule — no guard, a guard in another function,
   and a guard with the sense inverted — so it is a scanner that can fail rather than one that
   passes because it looked at nothing.

### 3.6 Synthesis offered a parameter called `value1`, and now it does not

The capability synthesized against `fixtures/corebank-web` offered a calling agent an argument named
**`value1`**, described as *"The value to use for `value1`"*. `inferParameters` named a parameter
after the accessible name of the field it was typed into, and this product's search inputs have **no
accessible name at all** — which is the legacy-app reality the whole project is about — so the
`value${n}` fallback fired. The artifact was perfectly executable; the *name* was the defect. The
assignment's §3.2 asks for typed input parameters and its first stretch goal is a catalog of
capabilities *"an AI agent could discover and invoke by name with typed args"*. `value1` fails that
on sight, and it was about to be baked into the headline evidence artifact.

**Naming is now a deterministic chain over evidence the system already had.** No model is asked,
nothing is inferred from the *shape* of the value — a name derived from a value would put a member
number in the caller's public API — and nothing about this fixture is special-cased:

| rung | what it reads | where it comes from |
|---|---|---|
| 1 `accessible-name` | the control's own accessible name | the frozen observation |
| 2 `labelled-by` | the wording the **markup** associates with the control | `labelAnchorsOf` |
| 3 `adjacent-label` | the nearest adjacent label text, inside the same reach a `label-anchored` descriptor uses | `labelAnchorsOf` — same function, same node, same anchor |
| 4 `taint-handle` | for an operator-supplied secret, the parameter name the **host** chose | the taint handle, which names a binding and never a value |
| 5 `positional` | nothing. `value1` — **and a flag** | — |

Rungs 2 and 3 are literally the anchor the locator uses: `labelAnchoredOf` was refactored to walk
`labelAnchorsOf`, and the parameter namer calls that same function, so **a parameter cannot be named
after a label the locator does not use** — the failure mode a second, private "what is this field
called?" implementation would have shipped the first time the two disagreed. A rung is *skipped*,
not taken, when its wording carries a recorded value or a regulated shape (the same
`unsafeTextReason` guard `Vocabulary.matcher` applies before a label becomes a vocabulary token), or
when it does not spell a legal `FieldNameSchema` identifier. `uniqueName` keeps the result distinct
from every other parameter and from the holes route canonicalization goes on to mint.

**Rung 5 is no longer silent, and that was the real defect.** `value1` on a field with no name
anywhere is the *correct* answer; shipping it quietly is not. Reaching rung 5 emits a
`parameter-name-underived` note at **`review`** severity — the severity that means "this artifact
cannot be approved until a person has read this" — and stamps `NEEDS A NAME: …` into the parameter's
own description, following the convention `PROSE_PLACEHOLDER` already established.
`SynthesisReport.parameters[].namedFrom` records which rung each name came off, so the provenance of
a *good* name is visible too, not only the absence of one.

**On this product it yields `memberId`.** riverbend's label is "Member ID"; summit's is "Member
Number", which spells `memberNumber`. Neither string appears anywhere in the engine. Read out of the
committed capability in this working tree:

```
$ python3 <read contract.inputs[0] out of packages/discovery/test/fixtures/corebank-web.capability.json>
  { "name": "memberId",
    "type": { "kind": "string", "charset": "digits" },
    "required": true,
    "description": "The value to use for \"Member ID\". It was named in the goal the capability
                    was discovered from.",
    "sensitivity": "sensitive",
    "discoveredFrom": { "goalSpan": "Look up member {memberId} in the riverbend core banking b" } }
```

**It changed the committed capability's bytes**, as it had to: `pnpm -F @crr/discovery
fixtures:synthesized` was re-run, and the contract digest is now
`sha256:77a9f4150f94985aa1f7920ab22cc2734d4e6ec764f06e1740002299df0590a9`, the artifact
`sha256:e03beee25a9ba9f94e7dd83a83b78c5a73a5d22c7efbf623a93d1c4b197ebfc1`. It was fixed **before**
the live run rather than after, which is the order that costs nothing: doing it afterwards would have
moved the live artifact's digest and invalidated any approval signed over it.

```
$ pnpm -F @crr/discovery exec vitest run test/synthesis-parameterization.test.ts \
                                         test/synthesis-corebank-web.test.ts
   ✓ test/synthesis-parameterization.test.ts (40 tests)  75ms
   ✓ test/synthesis-corebank-web.test.ts     (27 tests) 148ms
     Tests  67 passed (67)                                                          exit 0
```

**Both halves are tested, and so is the stopping.** One test per rung, plus a precedence test proving
rung 1 beats rungs 2 and 3. The genuinely-unlabelled case produces `value1` **and** the `review` note
**and** the `NEEDS A NAME` description. Three more assert what a derived name may never be: spelled
from a recorded value (a field labelled "Member 50001" falls through and flags rather than minting
`member50001`), an illegal identifier, or a collision. And there is a discrimination case whose
*only* difference from the passing rung-3 test is a surface that reports no `boundsUnit`: adjacency
is a geometric claim, so the chain stops one rung early rather than guessing a unit — the same
condition under which `labelAnchoredOf` declines to emit a spatial descriptor.

The runner prints the rung it used, so a bad name is visible in the run rather than only in the
document. From the rehearsal, this pass:

```
      parameters      memberId:sensitive (named from adjacent-label)
```

---

## 4. The five contract tests that hold the architecture up

All five are scan → discrimination-suite → ledger-asserted-empty, all five read the repository off
disk, and all five have had their file selection verified by injecting a violation into a **real**
module rather than a synthetic string.

| Test | Scope | Enforces |
|---|---|---|
| `core/test/purity.test.ts` | `packages/core/src` | No `Date`, `Math.random`, `fetch(`, `node:`, `process.env`, `setTimeout`, `setInterval`; allowlisted imports only. |
| `core/test/no-locator-vocabulary.test.ts` | `core`, `runtime`, `discovery`, `conformance` | No `querySelector`, `css`, `xpath`, `getElementById`, `innerHTML`, `[data-`; **and** no import of any driver or driver library. Checks its own package list against the workspace, so a new package fails it until somebody decides. |
| `core/test/policy-chokepoint.test.ts` | the whole repository | Every `Surface.act` call site is immediately preceded by a `check` on the same action whose decision is read. **Four real dispatch sites, all guarded**, re-derived off disk this pass: `runtime/interpreter.ts:578`, `runtime/interpreter.ts:1090`, `runtime/intervention.ts:532` (the human's own action), `discovery/loop.ts:546` (the model's own action). **The model's action during discovery and a human's action through the operator console pass the same gate as the interpreter's.** `15 passed (15)`. |
| six `test/barrel.test.ts` files | one per package | Every module reachable; no name owned by two modules; every value live at runtime, not merely in the types. |
| `conformance/test/barrel.test.ts` | all six `packages/*` | No exported name owned by two packages except four ledgered ones, each with a written reason and — for `CaptureSink` — a compile-time identity seam. |
| `core/test/declaration-size.test.ts` | `packages/core/dist` | Per-file and total `.d.ts` budgets, so the 15 MB regression cannot come back. Measured this pass: **287,298 bytes across 39 files**. |

The three line numbers in row 3 **moved** since the previous revision of this document, which quoted
`interpreter.ts:543`, `:1054` and `loop.ts:432`. They are not the same file any more — the loop grew
its failure path (§3.5) and the interpreter its dialog stand-down (§7.3). The test does not care,
because it locates the dispatches by scanning; this document quoted them by hand, and that is why
they were stale. See §11.14.

---

## 5. The conformance result, in full

Everything in this section was re-run this pass with the shipped command, not copied forward.

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
17 kills in total, **13 of them false successes** (the mutant told a caller `ok`, or told it a
business outcome, for a run that was broken) and 4 misclassifications. Six of the nine mutants are
caught by at least one false success. `nearestMatch` — the "fallback chain" mutant, the one that
converts an ambiguity into a confident wrong click — is killed by six scenarios and **every one of
the six is a false success**, which is the single most load-bearing row in this table.

The CLI's exit code is gated on `report.passed && matrix.survivors.length === 0 && flakeRate === 0
&& nonDeterministic === [] && unstableDescriptors === []`, so `exit 0` above *is* the
zero-survivors assertion; the survivor list is not printed separately when it is empty.

The mutants are the **real** `replay()` — same linker, lease, budgets, journal, session broker —
with exactly one pure decision function replaced through an injection seam
(`DecisionFunctions` on `InterpreterOptions`/`ReplayOptions`). A meta-test enforces that by function
identity: each mutant must weaken exactly one of `classify` / `resolveTarget` and share `@crr/core`'s
own function object for the other. Without that seam the mutants would be stubs, and a suite that
can only tell a real engine from a stub proves nothing.

The meta-test was verified to fail against a real gap: deleting scenario 21 (the only scenario that
kills `noContinuity`) produced `SURVIVORS (a gap in the suite): noContinuity` and 4 failing tests.
**That injection was not re-run this pass** and stands on the unit that ran it; the four tests it
describes are among the 102 that passed above.

### 5.2 The terminal corpus — **four mutants survive, and that is reported, not hidden**

```
$ cd packages/conformance && pnpm exec tsx <runConformance + buildKillMatrix over TERMINAL_SCENARIOS>

14 scenarios: 14 passed, 0 failed, 0 FALSE SUCCESSES
TERMINAL CORPUS reference engine: total=14 passed=14 failed=0 falseSuccesses=0

kill matrix: 9 mutants x 14 scenarios
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
number *in both directions* with a written reason (>60 characters, asserted) for each of the four
survivors. Forcing all nine would have meant a fixture that lies. The reasons, from `OUT_OF_REACH`
in that file:

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

**The union of the two corpora kills all nine**, and this pass ran that union rather than asserting
it — the previous revision printed a `COMBINED SURVIVORS` line that no command produced:

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

That is the honest statement: *the suite* discriminates; *the green-screen corpus alone* does not,
for four reasons each of which is a property of the surface rather than a gap in the effort.

### 5.3 Stability

```
$ env -u ANTHROPIC_API_KEY … pnpm -F @crr/conformance stability
  25 scenarios x 20 runs: flake rate 0.0%, 0 with a result document that was not byte-identical
  no descriptor changed its verdict between runs of the same scenario
```

- **Flake rate 0.0%** — proportion of scenarios that were *inconsistent* across runs, not the
  proportion that failed.
- **Result determinism, stricter:** 0 of 25 scenarios produced a `ReplayResultDocument` that was not
  byte-identical across all 20 runs (digest of the whole document, not just the arm).
- **Descriptor instability: 0** descriptors changed verdict between runs of the same scenario, across
  15 descriptors and 5,300 consultations.
- Per-descriptor contribution rates (20 × 25), re-read off this pass's run: `open-link-by-row`
  340 consultations / 82.4% carried / silent in scenarios 16, 18, 19; `open-link-by-name` 340 /
  88.2% / 16, 19; `open-link-by-ordinal` 340 / 88.2% / 16, 19; `search-button-by-name` and
  `-by-ordinal` 440 / 95.5% / none; `member-id-field-by-ordinal` 500 / 96.0% / 17; the remaining
  nine at 100.0%, silent nowhere.

**What this number is not.** The report prints its own caveat and it is the right one: *this
measures the engine over a frozen corpus on a manual clock. A fixture you control cannot surprise
you the way a real vendor app does; it bounds hidden state in the engine, not flake in production.*
Zero over 20 runs is not a reliability claim.

---

## 6. The evidence bundle

`pnpm demo` — no live service, one local Chromium, one ephemeral loopback port, 9.9s, exit 0.

```
7/7 exhibits PASS
  replay-01-green                    ok        green
  replay-02-outcome-member-not-found outcome   expected business outcome
  replay-03-recovered-interstitial   ok        recoverable condition
  replay-04-failed-app-error         failed    hard failure
  replay-05-failed-session-expired   failed    hard failure
  masked-capture                     3 region(s) blanked
  cli-replay                         exit 0

REDACTION CANARY  CLEAN
  scanned       44 files, 920,593 bytes
  searched for  3 value(s) x 14 encodings = 26 distinct needles
  self-test     PASSED - 26/26 planted needles were found
  hits          0     suppressed  0     credentials  0

  48 files in the bundle, produced in 9.9s
  discovery-live/  EMPTY - a live model run, pending the author's approval
  whole-bundle canary pass: CLEAN - 48 files, 0 hits
```

48 files, 934,441 bytes (1,016 KB on disk). All three arms of the taxonomy are exhibited, which is
BRIEF §5's specific ask ("at least one replay that hits an exceptional state and shows how it was
classified") answered four times over.

The canary was verified against planted leaks: plain UTF-8 in a log, percent-encoded bytes in a
JSON result, UTF-16LE appended to a PNG, and a value in a **file name** — 4/4 caught, then reverted.
The self-test line above is the standing version of that check: it plants all 26 needles in a
scratch corpus on every run and fails if it cannot find them, so the scanner cannot pass by
scanning nothing.

**What the bundle does not contain, and why — see §7.1.** `evidence/discovery-live/` holds only
`PENDING.md`, confirmed on disk this pass. No transcript was fabricated and no VCR fixture is
presented as a live run. The rehearsal this pass ran wrote to `.scratch/discovery-dry-run/`, and
`assertRealRecording` would have refused it if it had been pointed at `evidence/`.

---

## 7. What does **not** work, is not proved, or is unresolved

Ordered by how much it costs the submission.

### 7.1 There is no live discovery run. There **is** now a command for one, and it is the author's to run

BRIEF §5 requires "logs from a real discovery run" in `evidence/`. **They are not there.** BRIEF §11
forbids every agent on this repo from making a live model API call, so this is a deliberate hole
with a documented shape, not an oversight:

- `evidence/discovery-live/PENDING.md` names every file that will land there and names what may
  **never** be put there in its place: a VCR-replayed transcript, a human- or coding-agent-driven
  run, an `agent-sdk` run.
- `pnpm demo` deliberately never deletes that directory, and since §3.5 it also never writes
  `PENDING.md` back on top of a real run.
- The "saved example artifact" in `evidence/artifact/` is the **hand-authored**
  `sharePositionArtifact` from `packages/runtime/test/fixtures/corebank.ts`. Both `evidence/README.md`
  and `evidence/artifact/README.md` say so plainly, and say that
  `provenance.model.adapter: "replay"` is the enum's least-dishonest value for "a person wrote this".

**WHAT CHANGED. An earlier revision of this section said "THE COMMAND IS THE THING THAT IS MISSING"
and quoted a grep showing `createAnthropicModel` had no caller. That was true when it was written
and it is false now.** The same grep, run in this working tree:

```
$ grep -rn createAnthropicModel packages/ --include='*.ts' \
      | grep -v '/test/' | grep -v '/dist/' | cut -d: -f1,2
packages/discovery/tools/preflight.ts:17
packages/discovery/tools/preflight.ts:185
packages/discovery/tools/preflight.ts:983
packages/discovery/tools/preflight.ts:991
packages/discovery/tools/discover.ts:8
packages/discovery/tools/discover.ts:81
packages/discovery/tools/discover.ts:1102
packages/discovery/src/adapters/anthropic.ts:132
```

Reading those eight, in the order that matters: `adapters/anthropic.ts:132` is the declaration;
`tools/discover.ts:81` is the import and `:1102` is **the call**, inside the branch `--yes` guards
(`:8` is the file header describing the composition). The four in `preflight.ts` are three prose
mentions and one data row (`{ call: "createAnthropicModel", why: "the live adapter" }`) — preflight
reports that the runner composes it and **never constructs it**; its only import from that module is
`buildRequestBody` and `DEFAULT_MAX_TOKENS`.

`pnpm discover` composes `createAnthropicModel` → `createRecordingModel` → `runDiscoveryLoop` →
`synthesizeCapability` → `verifyAndDraft` → `runRedactionCanary` → the bundle. **The whole thing has
been rehearsed end to end against the VCR replay adapter, this pass, and it passes:**

```
$ pnpm discover --dry-run --force
      status          reached-goal              8 turns, 3 steps recorded
      capability      corebank.member.read_share_position@1.0.0
      contract digest sha256:77a9f4150f94985aa1f7920ab22cc2734d4e6ec764f06e1740002299df0590a9
      parameters      memberId:sensitive (named from adjacent-label)
      verification    verified / full / covered through activate-open   proposed -> draft
      canary          pass 1 CLEAN, pass 2 CLEAN, pass 3 CLEAN, pass 4 reported (19 hits, all the
                      member number in the recording, listed by file and line)
      VERDICT         four yes and $0.0000                                       exit 0
```

The dry-run bundle's **artifact** digest is `sha256:f29a73b2…`, not the committed fixture's
`sha256:e03beee2…`, and that is correct rather than a drift: the rehearsal synthesizes from its own
live capture against a fixture on an ephemeral port, while the committed fixture is synthesized from
the frozen observation corpus. The **contract** digest is identical across both, because the contract
does not carry the origin. That the two agree on the contract and differ only where they must is a
better check than either one alone.

#### `pnpm preflight` — the readiness check

`packages/discovery/tools/preflight.ts`. A human runs it **before** authorising a paid call, and it
answers the question that decision actually needs answered: what would go out, how big is it, what
would it cost, what would the safety gate permit while it ran, and where would the recording land.

**It makes no model call, and that is a property rather than a promise.** It imports `buildRequestBody`
and `DEFAULT_MAX_TOKENS` from the adapter and **never `createAnthropicModel`**; it reads
`ANTHROPIC_API_KEY` only to check its *shape* and never prints, logs or transmits the value; and it
counts tokens **locally from character counts** because `messages.countTokens` is itself a billed
round trip. The only sockets it opens are to `127.0.0.1` — the fixture it boots and a local Chromium
driving it.

The verdict, verbatim, in this working tree with no credential in the shell:

```
── VERDICT ─────────────────────────────────────────────────────────────────────────────────────

      NOT READY - 1 blocker(s):

        BLOCK  [credential] ANTHROPIC_API_KEY is not set in this shell. `createAnthropicModel` throws without it.

      14 check(s) passed.

      NO MODEL CALL WAS MADE BY THIS SCRIPT. The only sockets it opened were to 127.0.0.1.
      Every token figure above is a LOCAL CHARACTER-COUNT ESTIMATE, not a tokenizer result
      and not `messages.countTokens`, which would itself be a request to the provider.
                                                                                        exit 1
```

and with a syntactically valid **fake** key exported, which exercises the shape branch and nothing
else:

```
      READY. Every check passed. Nothing here authorises the run - a person does.
      15 check(s) passed.                                                               exit 0
```

The check that used to read `[recorder] BLOCK  no runner exists` now reads:

```
  [  ok  ] `pnpm discover` exists and composes the adapter, the recorder, the loop, synthesis,
           the verification replay and the canary.
```

and the two cost warnings the earlier verdict carried are gone, because
`DISCOVER_MAX_OUTPUT_TOKENS` lowered `max_tokens` from the adapter's default 16,000 to 2,000. That
single change is what moved the worst case a run can cost from **$31.90** — three times the whole
project cap — to **$4.18**, and `--max-usd 2.00` stops it well before that.

**The cost table it prints, at the published rates** (verified against the `claude-api` skill, not
written from memory: opus-5 $5/$25 per Mtok, sonnet-5 $2/$10). `U` is output tokens per turn and is
the one symbol that is **assumed** rather than measured — there has never been a live run to measure
it from — so it is an input to the estimate, printed as such, and overridable with
`CRR_PREFLIGHT_OUTPUT_TOKENS`:

| turns | scenario | opus-5 | sonnet-5 |
|---:|---|---:|---:|
| 8 | typical (U = 800) | **$0.31** | $0.13 |
| 8 | ceiling (U = max_tokens = 2,000) | $0.72 | $0.29 |
| 24 | typical (U = 800) | $1.80 | $0.72 |
| 24 | ceiling (U = max_tokens = 2,000) | $4.18 | $1.67 |
| 24 | if `max_tokens` were the adapter's 16,000 | $31.90 | $12.76 |

8 turns is the length of the hand-authored `SCRIPT` that reaches this goal through this loop; 24 is
`DEFAULT_LIMITS.maxTurns`. **Realistic expectation: $0.30 – $0.80.** One closeness worth knowing:
at the assumed `U = 800` a full 24-turn run lands at $1.80 against a $2.00 cap, so on a typical run
the *turn* budget ends it and the money cap never fires; if `U` is even modestly higher, the *money*
cap fires first, mid-run, somewhere around turn 15–20. Both endings are clean.

Two results from building it that are worth more than the dollar amounts:

- **Prompt caching saves almost nothing on this loop, and the report says so.** Only the system
  prompt and the tool definitions carry a breakpoint; the message history does not, so every
  observation and every assistant turn is re-billed at full input price on every subsequent turn.
  Measured from the same table: caching saves **$0.21** on a full-budget 24-turn opus-5 run, while
  the growing history drives input from 30,646 tokens at 8 turns to 264,669 at 24. BRIEF §9 asks
  for the cache hit rate as reported evidence; this is the number that will make it look small, and
  that is a real finding about the shape of an agent loop rather than a defect.
- **The 2,034-token prefix clears both models' minimum cacheable prefix** (512 on opus-5, 1,024 on
  sonnet-5). Below the floor a breakpoint silently does nothing — no error, just
  `cache_creation_input_tokens: 0` forever — so this is checked rather than assumed.

**One incidental corroboration.** The live perceive and the frozen corpus produced the *identical*
projection (407 chars, 8 of 99 nodes, same eight lines), again this pass.
`corebank-web.observations.json` has not drifted from the application it was captured from.

#### What is still not proved, and what is still weak

- **No model has ever driven this system.** That is the entire reason the live run is worth paying
  for, and no amount of rehearsal substitutes for it. What the rehearsal proves is that the
  *composition root* runs; what it cannot prove is that a real model reaches this goal in 24 turns.
- **`pnpm preflight` has no automated test.** It is verified by running it, which this pass did in
  two configurations (no credential; a syntactically valid fake key) and an earlier pass did in a
  third (`PLAYWRIGHT_BROWSERS_PATH` at an empty directory, exercising the frozen-corpus fallback).
  What keeps it from drifting is not a test but its inputs: every budget, model id, prompt, tool
  schema, allowlist and route in the report is **read from the shipping source** —
  `DEFAULT_LIMITS`, `DEFAULT_MAX_TOKENS`, `DEFAULT_MODEL_ID`, `DISCOVERY_SYSTEM_PROMPT`,
  `DISCOVERY_TOOLS`, `ALLOWLIST`, `ENTRY_ROUTE`, `GOAL` — not copied into it. The only hand-written
  numbers are the published rates and the cache multipliers.
- **The spend guard has only ever been observed firing *before turn 1*.** Under `--dry-run` the
  scripted model reports `ZERO_USAGE`, so the ledger's inputs never move and `projectNext()` returns
  the same constant every turn. The mid-run boundary — spend accumulating across turns and the cap
  binding at turn *n* — **has never executed**, and neither has the ledger's `record()` path over
  non-zero provider numbers, its measured tool-result growth, or its cache accounting. The
  *arithmetic* underneath it was checked at non-zero usage and `costOf()` agrees with preflight's
  independent cost table to the cent on the 24-turn figure; the *ledger that feeds it* is what has
  not run against real numbers. There is also **no unit test for `stopBeforeTurn`** — re-grepped this
  pass, the only caller is `tools/discover.ts:1191` — so the hook is the one addition to
  `src/loop.ts` that the 282 discovery tests do not touch.
- **The runner's view of `@crr/runtime` is a hand-written structural type, not the real one.**
  `@crr/discovery` must not depend on an interpreter or a driver (§3.2), so `tools/discover.ts`
  resolves `playwright`, `@crr/surface-browser`, the fixture and `@crr/runtime` **by path** at
  runtime and hand-types the slice of `@crr/runtime` it uses. `tsc` therefore checks that slice
  against nothing. **The only thing that catches a drift between the slice and the real package is
  running the runner**, which is what `pnpm discover --dry-run` is for and why it is worth running
  before the paid one. The reasoning is written at the site (`discover.ts:48–56`); the exposure is
  real and is named here rather than buried in it.
- **A dry run aimed at `evidence/` is refused, but not before it litters.** `assertRealRecording`
  fires on the destination, so `--dry-run --out evidence/discovery-live` is correctly refused — but
  `journal.jsonl` is created in the destination *before* the loop runs and the refusal happens
  *after* it returns, so a refused rehearsal leaves a `journal.jsonl` inside the protected directory.
  Don't aim a dry run at `evidence/`.
- **The `--yes` gate was verified structurally this pass, not by running it.** It was observed
  refusing with the author's real funded credential in the process by the pass that built it. Here it
  was read off the source: the refusal returns at `discover.ts:1078`, the fixture boots at `:1092`
  and the client is constructed at `:1102`. Running a bare `pnpm discover` was not on this pass's
  task list, and BRIEF §11 makes it the author's command.

**So the gap is now one command, and it is the author's to type.** `pnpm preflight`, then
`pnpm discover --yes`. `docs/design/LIVE-RUN-READINESS.md` is the document written for the person
whose card is on the account; it is the one to read before authorising, not this one.

### 7.2 The discovery → replay seam — **CLOSED**

**A synthesized artifact replays, through the real interpreter, against the real
`fixtures/corebank-web`, in a real browser.** The two halves of SPEC §1.1's cycle are connected by
code, and the connection is the one the design asks for: **a file**.

```
$ cd packages/runtime && pnpm exec vitest run test/synthesized-replay.test.ts
  ✓ the synthesized capability, read back as a document
      ✓ parses as a contract and an artifact with no help from the package that wrote it
      ✓ offers a caller an argument named after the screen, not a positional placeholder
      ✓ arrives `proposed` and `unverified`, because a recording is not a claim
      ✓ declares a program of four steps over three routes of the fixture
      ✓ is refused by the linker in production mode until somebody has approved it
  ✓ replaying a SYNTHESIZED artifact against corebank-web
      ✓ verifies itself with the model out of the loop, and only then becomes a draft      2.3s
      ✓ executes every descriptor, checkpoint, budget and effect synthesis derived         1.8s
      ✓ is a capability, not a macro: approved, then invoked for a member the recording
        never saw                                                                          3.7s
      ✓ reports a member the core has no record of as a hard failure, because nobody
        declared an outcome                                                                1.2s
  Tests  9 passed (9)

$ cd packages/discovery && pnpm exec vitest run test/synthesis-corebank-web.test.ts
  Tests  27 passed (27)
```

(8 → 9 and 25 → 27 since the previous revision: the second test above is new, and it is the one that
would have caught `value1` — §3.6.)

**Re-verified in this pass, and here is exactly how far that verification goes.** Both files were
re-run as part of the full credential-unset suite and both are green at those counts. What was
**not** re-done here is re-injecting the two synthesis defects below to watch their guards fail;
those remain on the previous unit's word, and the tests that would catch a regression are the ones
that just ran.

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
performs, not three URLs somebody navigated to. Everything downstream is hermetic — re-measured this
pass: `@crr/discovery`'s 282 tests are **all** green with `PLAYWRIGHT_BROWSERS_PATH` pointed at an
empty directory.

**What the runtime test walks, which is the whole ladder rather than the bottom rung.**

1. **Read it as data** — parses, digest intact, `implements` the contract by digest, and the linker
   **refuses it in `replay` mode** (check 27, `artifact-not-approved`) because it is `proposed`.
2. **Verify it** — `verifyAndDraft`, BRIEF §3.4, against the live application: mode `replay-dry`
   (chosen from the effect summary, not from the document's own plan), grade `full`, covered through
   the last step, arm `ok` with typed outputs. `proposed → draft`.
3. **Approve it** — a real ed25519 signature over the real digest. `draft → approved`.
4. **Invoke it in production** — for **member 10045, which the recording never saw**, and get that
   member's name, balance and status back. This is what separates a capability from a macro.

**What §7.2 once said was unproved, now asserted against a live run** (all against the journal of a
run rather than against the document that describes one):

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

**Three real defects in synthesis were found by executing what it emits, and all three are fixed.**
None was reachable by any test that only linked the document:

1. **Recorded member data reached a signed document.** `deriveOutputs` folded a cell's accessible
   name into the query it derived — and on a legacy grid a cell's accessible name **is the value
   being read**. The emitted artifact carried `"ALVAREZ, DANA (SYNTHETIC)"` and `"1,204.55"` in
   `flow.vocabulary`: a member's name and a member's balance, in the one document that is committed,
   diffed and **signed**, which is precisely what BRIEF §3.6 forbids — and the capability worked for
   exactly one member. Parameterization could not catch it: the member's name was never in the goal,
   so it was never bound to anything. Fixed at `packages/discovery/src/synthesis/outputs.ts` — when
   row-and-column addressing is available it is used **alone**. Guarded by a test that greps the
   sealed documents for all three values, and re-checked here:
   `grep -c 'ALVAREZ\|1,204.55' packages/discovery/test/fixtures/corebank-web.capability.json` → `0`.
2. **Every delivered string output was case-folded.** `readingOf` returned `normalize: "std.text@1"`,
   which lowercases — right for matching a label against a screen, wrong for a value handed to a
   caller, who would have been read their own name back as `alvarez, dana (synthetic)`. Fixed:
   `std.identity@1` is the default on the delivery path and a normalizer is chosen only where it
   earns its place (`std.money@1`, so `moneyUSD@1` sees a bare amount).
3. **The parameter was called `value1`.** Fixed and described in full at §3.6; the contract now
   offers `memberId`, and the case where no rung answers is flagged at `review` severity instead of
   shipping in silence.

**Drift is a red test, not a surprise on a live run.** `synthesis-corebank-web.test.ts` rebuilds
`corebank-web.capability.json` in process, from the same function the emit script calls, and
compares the **bytes** — so any change under `src/synthesis/` fails the build naming the command
that fixes it. Regenerate, and the runtime test then executes whatever the new synthesis emitted.
The hand-authored node references are `n<k>` indices with no names attached, so `checkRefs` asserts
the role *and* the accessible name of every referenced node before any run starts, in both the
capture script and the test, with a discrimination case proving that guard can fail. There is no
path from "synthesis emits something the interpreter cannot run" to a green board.

**The one honest caveat.** The four executing tests are among the 46 that skip silently without a
Chromium build (§1). Without one, the synthesized artifact is still parsed, digest-checked and
linked — the other five assertions in that file, plus all 27 in `@crr/discovery` — but it is not
executed, and the file prints a stderr line saying exactly that.

### 7.3 The confirmation dialog — **CLOSED**

**A real sub-account is opened, through the real interpreter, against the real
`fixtures/corebank-web`, in a real browser — and the modal confirmation is what authorizes it.**

```
$ cd packages/runtime && pnpm exec vitest run test/browser-write.test.ts
  ✓ the documents this flow ships (2)          ← hermetic; the only part that runs with no Chromium
  ✓ opening a sub-account against corebank-web
      ✓ raises the confirmation, accepts it as the postcondition, and commits exactly once  2464ms
      ✓ dry-runs to the irreversible boundary and does not perform it                       1364ms
      ✓ verifies, drafts, and then invokes - and opens exactly ONE account across both      2970ms
      ✓ still refuses an UNDECLARED dialog on the same widget, and posts nothing            1383ms
  Tests  6 passed (6)

$ cd packages/core && pnpm exec vitest run test/expected-dialog.test.ts
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
  to the interpreter, a case to the restart gate, a meaning to the remediation ledger, and a
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
  screen — which is why both steps declare it.

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
records `perceive` returning `perceive-timeout` while a `window.confirm` is open.

**Band B3 does not run when the stand-down fires**, either way `present` points, because the screen
*behind* the panel is still stale. That is the true half of "B2 before B3" and it is preserved
structurally, in the classifier, for a document that was never linked.

**The linker check that keeps it honest** is folded into check 25 (`checkCheckpoints`), so
`LINK_CHECK_COUNT` stays **28** (`packages/core/src/linker.ts:86`, re-read this pass) and SPEC §10's
numbering is untouched. Three obligations, one per way the licence could be turned back into a hole:
`expect.dialog.where` must constrain `role: "dialog"`; a step whose postcondition is an OPEN dialog
declares **no `outcomes` and no `extract`**; and **no program's last step ends with a dialog open**.

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
**native** dialog only, and an in-page modal goes through the ordinary quiescence loop like every
other screen, where `stableSamples` catches the tear. `packages/runtime/src/settle.ts`, rule 3. It is
guarded hermetically as well as against the browser: `test/cycle.test.ts` has both halves of rule 3,
so the defect is caught on a machine with no Chromium.

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
   `replay-dry`, grades `partial-up-to-irreversible`, covers through `submit-subaccount-form`, stops
   before `commit-subaccount`, and the boundary step's journal has `resolved` and **no `acted`**. The
   commit is refused twice over during verification — once by the dry boundary, once by
   `allowlist.discoveryMaxEffect: "WRITE_REVERSIBLE"`, because a verification replay runs in
   `discovery` mode (SPEC §6.6).
3. **Verify, draft, invoke — one account across both.** And in between, a refusal worth having: the
   dry run parks the session on the confirmation panel, and a production invocation run against
   *that* screen fails `undeclared-dialog` at step 1 with `sideEffects: "none-guaranteed"`. A freshly
   brokered session (SPEC §7.6) never sees it; the test stands in for the broker by hand and then the
   run is green.
4. **An undeclared dialog on the SAME widget is still a hard failure.** The fixture renders its
   maintenance interstitial with the same modal machinery as the confirmation — one widget, two
   identities, deliberately, so that an engine cannot classify a modal by "a modal is showing".
   Armed on the confirmation screen, both panels are up, refusal 4 fires, and the run fails with
   nothing posted.

Verified by injection, all four reverted (previous pass's measurement, not re-run here):

```
# `declaredInterception` short-circuited to false (the B2 stand-down removed):
  core      ×  4 of 19 in test/expected-dialog.test.ts
  runtime   ×  3 of 4  browser tests   (the write flow is unreachable again)
# the B5 obligation and the B3 guard removed:            core  ×  3 of 19
# settle rule 3 restored to short-circuiting on ANY interception:
  runtime   ×  3 of 4  browser tests   (the torn read comes back)
  runtime   ×  1 of 19 in test/cycle.test.ts             (hermetic: it needs no Chromium)
# the check-25 dialog clauses removed:                   core  ×  4 of 19
```

#### The one thing this capability does not do, and why

**It returns no outputs.** The core's confirmation screen prints the new account number and the
posting reference as unlabelled `<font>` runs inside a LAYOUT table: measured through
`@crr/surface-browser`, every one of those nodes comes back `ariaRole: null` with no
`tablePosition`, so no `NodeQuery` can name them. Returning nothing is the honest answer; inventing
an ordinal into a layout table would be a locator, which is the one thing this design refuses.

**It is the same driver gap §7.6 records on the green screen.** Two surfaces, one fix: an unlabelled
run of body text should become a `text` node. Doing it changes node counts that
`browser-overlay.test.ts` asserts, so it is a decision with a blast radius rather than a one-liner,
and it is named here rather than made.

**The nine-step READ flow stays.** Reading a member's position and posting to their account are
different capabilities with different effect classes, different approval requirements and different
`whenNotToUse` prose, and the read one should not be able to write. The two documents say so to each
other — the read contract's third `whenNotToUse` line names the write capability by role.

### 7.4 `resume: "continue"` — a known gap, pinned by a scenario that says so

There is no recovery mode that re-verifies without re-dispatching. Measured consequence: **an
interstitial that appears AFTER a step has acted cannot be recovered.** `retry-step` re-resolves a
target the action already navigated away from, and the engine reports `target-not-found` for a run
that in fact recovered. **Conformance scenario 25 deliberately pins the wrong behaviour**, and its
title says so (`KNOWN GAP: an interstitial that appears AFTER the step acted cannot be resumed
today`, `PASS 4/4` in this pass's run), so that the day the mode exists a test fails and somebody
comes back to it.

**§7.3 did not close this, deliberately.** `Checkpoint.dialog` is about a dialog a step DECLARED as
its own postcondition; §7.4 is about one nobody declared, arriving after the act, which has to be
cleared and re-verified. They look alike and they are opposite: one is a thing the program expected,
the other is an interruption. A single mechanism serving both would have to decide at runtime which
it was looking at, and the whole point of the taxonomy is that a declaration decides that.

### 7.5 The `JournalEvent` type does not discriminate

`packages/core/src/journal.ts:65`, re-read this pass:

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

The multi-tenant claim is measured and green. Re-run this pass:

```
$ cd packages/runtime && pnpm exec vitest run test/browser-overlay.test.ts
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

**The browser has the same gap, and §7.3 found it.** Two surfaces, one fix, and it is the same
sentence: an unlabelled run of body text should become a `text` node. On the browser side that
changes the node counts the cross-tenant divergence report above asserts, so it is a decision with a
blast radius rather than a one-liner — which is why it is written down twice and made nowhere.

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

- ~~**Synthesis cannot name a parameter after a field that has no accessible name.**~~ **CLOSED —
  §3.6.** `synthesis/parameters.ts` walks a five-rung chain ending at the label anchor
  `deriveDescriptors` computes for the same node, which yields `memberId` here, and flags the case
  where every rung comes up empty at `review` severity instead of shipping `value1` in silence.
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
  has at least one step that can spend one") **was never added** — the list is still 28, re-read this
  pass. Synthesis works around it from the recorder side by deriving non-zero step budgets when it
  lifts a dialog into an ambient rule, so the hazard is **half-mitigated and still unchecked**.
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
- **`@crr/runtime` lists `@crr/surface-browser` in `dependencies` and `src/` never imports it.**
  Re-checked this pass: the manifest still carries it, and the only three matches for
  `@crr/surface-browser` under `packages/runtime/src/` are prose in comments. The *code* is clean
  (the contract test enforces it); the *manifest* contradicts the design claim `cli.ts` makes in its
  own header. It belongs in `devDependencies` — a one-line change plus a `pnpm install`, which no
  pass has been permitted to run.

---

## 8. What is stubbed, and why

Every one is stubbed at a clean seam and says so at the seam. Every row re-checked against the tree
this pass.

| Stub | Where | Why, and what it costs |
|---|---|---|
| **`agent-sdk` adapter** | named in `DISCOVERY_ADAPTERS` (`src/model-port.ts:36`), no implementation | Dev-only by design (BRIEF §10) and must never produce evidence. It runs Claude Code's loop, not ours, so it validates none of our prompt shape, tool schemas, observation serialization or stopping conditions. |
| **No outcome detectors are synthesized** | `synthesis/emit.ts` | SPEC §0.2 forbids inferring one. `contract.outcomes` comes out `[]` and the model's `finish` candidates ride in `SynthesisReport` with an `outcome-candidate-needs-detector` note — visible in this pass's rehearsal output. A generated `detect` predicate for a screen the run never observed is exactly how a false `MEMBER_NOT_FOUND` gets emitted. |
| **`whenToUse` / `whenNotToUse` / `title` / `summary` are not generated** | `synthesis/emit.ts:1112` | `input.capability.whenToUse ?? [PROSE_PLACEHOLDER]`. Synthesis never writes routing prose; it accepts prose a **person** wrote and otherwise stamps `"NEEDS AN AUTHOR: …"` plus a `prose-needs-author` note. **Be precise about what that means for the evidence:** the prose in the committed capability and in the live-run bundle is hand-authored, in `tools/live-run.ts`'s `LIVE_CAPABILITY` and in the fixture emit script, and is passed *into* synthesis. Models mis-route far more often than they mis-fill arguments, so a generated line there is a generated routing decision. |
| **`effect-in-doubt` escalates and journals but is not parked** | `interpreter.ts` | It does not appear in the operator console queue; the arm stays `failed`, which is correct (the caller must not retry). Wiring it needs a second kind of parked entry — a live session a human may look at and may never hand back. Seam named in a comment at the site. |
| **Approval key custody does not exist** | `runtime/approval.ts` | OPEN-QUESTIONS-RESOLVED Q5, deliberately out of scope. `ApprovalSigner` is a port so a KMS or HSM substitutes cleanly; `ed25519Signer` holds a private key in process memory with **no approver identity, no expiry and no revocation**. Signature *verification* is real (`ed25519Trust`), and the linker does compare `approval.over` to the artifact's digest and refuse an unverifiable approval (checks 26/27). |
| **`examples/` does not exist** | `pnpm-workspace.yaml:12` lists it | Creating a workspace member needs a `pnpm install`. The demo lives in `packages/runtime/demo/` instead, covered by `test/demo-contract.test.ts` (9 tests, which assert it imports no driver, reads no credential, and never writes `PENDING.md` over a live run). The only `--surface <module>` factory in the repo is a test fixture. |
| **Desktop (AX/UIA) surface** | not built | A documented seam, per BRIEF §3.1. The `Surface` port is two operations and the terminal driver is the proof they are not browser-shaped. |
| **`openai` model id has no default** | `adapters/openai.ts` | Deliberate. BRIEF §9 forbids writing a model id from memory and there is no OpenAI counterpart to the `claude-api` skill, so `createOpenAIModel` throws unless `modelId` or `CRR_OPENAI_MODEL` is supplied, with an error that says why. The adapter itself is real and has 26 tests. |

---

## 9. Repository hygiene — four files that must be deleted, and could not be

`rm` and `mv` are denied to every agent that has worked in this tree. **Re-confirmed this pass**, on
the three tracked files below:

```
$ rm -f packages/discovery/.cost-check.scratch.ts packages/conformance/probe.ts \
        packages/conformance/src/__probe.ts
  Permission to use Bash with command `rm -f …` has been denied.
```

None of these affects any test, the build, `pnpm typecheck` or `pnpm lint`. **Three of them are
tracked by git and would ship** (`git ls-files --error-unmatch` says so for each):

```
rm  /packages/conformance/probe.ts         # `export {}` + a "DELETE THIS FILE" header. TRACKED.
rm  /packages/conformance/src/__probe.ts   # `export {}` + a "DELETE THIS FILE" header. TRACKED.
rm  /packages/discovery/.cost-check.scratch.ts   # 1,565 B, the §7.1 spend arithmetic check. TRACKED.
                                           # Outside tsconfig's include; lint-clean; not part of
                                           # the deliverable. It is why biome reads 314 files.
rm -rf /packages/core/.scratch/            # probe.ts (1,326 B) + probe2.ts (798 B). Gitignored, but
                                           # probe.ts is Playwright/CDP spike code sitting inside the
                                           # package whose entire claim is that it is pure.
rm -rf /.scratch/  /packages/conformance/.scratch/   # 99 + 1 working files. Gitignored.
```

**One entry from the previous revision is gone and stays gone:** `/.exports.mjs`, a 0-byte throwaway
export scanner that was not gitignored, was removed by a commit (`7d8f052 delete stray file
export.mjs`) and is absent from the tree. The list is four entries now, not five.

`packages/conformance/src/__probe.ts` is on the conformance barrel test's `NOT_ON_THE_BARREL` ledger
as a **defect, not a decision**, and boxed in by two assertions (zero exports, under 800 bytes) so it
cannot quietly grow back into a module while it waits. When it is deleted, the ledger entry should go
with it; the test tolerates its absence by design.

`/.scratch/` now holds **99 files**, including this pass's three `pnpm discover --dry-run` bundles
(`discovery-dry-run/`, `budget-usd/`, `budget-tokens/`). It is gitignored and read by no test, lint
or contract scan. Every other temporary file this pass produced went to a session scratchpad outside
the repository.

**`evidence/` moved, and it is worth saying why rather than leaving it to a diff.** Running
`pnpm demo` — which §1 and §6 quote, and which is the command that *produces* `evidence/` — rewrote
the bundle. The count and the verdict are unchanged (48 files, 934,441 bytes, canary CLEAN on both
passes, exit 0); what moved is per-run content, and `git status` shows it as **8 deletions and 8
additions** because the content-addressed observation files under
`evidence/<scenario>/observations/` are named by the digest of a journal that carries this run's own
timestamps. `evidence/discovery-live/` was **not** touched: it still holds `PENDING.md` and nothing
else. The two design documents are the only other files this pass changed.

---

## 10. Deliverables still missing

BRIEF §7 names three paths. One is still absent, one is complete-but-for-§7.1, and one is present.

- **`/README.md` — MISSING.** Required to cover setup, config/keys, how to run without live
  services, and a demo path. The text it needs from this pass:
  `pnpm install` → `pnpm exec playwright install chromium` (**once, and not optional — see §1: 46
  tests silently skip without it**) → `pnpm demo`, which produces the whole of `/evidence/` with no
  live service and exits non-zero if any scenario misses its declared arm or the redaction canary
  finds a parameter value. Also needs the `agent-sdk`-is-dev-only warning BRIEF §10 requires, and
  the two commands that bracket the one that costs money: `pnpm preflight` first, then
  `pnpm discover --dry-run` to rehearse it free, and only then `pnpm discover --yes`.
- **`/REPORT.md` — MISSING.** 1–3 pages under exactly seven headings: Architecture · Artifact schema
  · Determinism & error handling · Heterogeneity & multi-tenant · Escalation & handoff · Safety ·
  Cuts.
- **`/evidence/` — PRESENT**, 48 files, 934,441 bytes, minus the live discovery run (§7.1).
- **~~The live-run runner — MISSING~~ — BUILT.** It was listed here as its own deliverable in the
  previous revision because §7.1's evidence could not exist without it. `packages/discovery/tools/`
  now holds `discover.ts`, `bundle.ts` and `live-run.ts` alongside `preflight.ts`; `pnpm preflight`
  reports it present; the whole thing rehearses end to end at exit 0. What remains is not a build
  task. It is the author deciding to spend ~$0.30–$0.80.

---

## 11. Corrections

Where a claim could not be reproduced in this working tree, this is what was found instead.
§§11.1–11.8 are corrections to the unit reports and stand as originally written; §§11.9–11.19 are
corrections to **this document**.

1. **`SETTLE_POLICY_DEFAULTS.stableSamples = 3` was claimed and was NOT in the tree.** It had been
   reverted to `2` by a concurrent edit. Re-applied, and guarded — §3.4. Still `3` this pass.
2. **The false-success split on the browser corpus is 13 / 4, not 12 / 5.** Unit 17 reported "12
   false successes and 5 misclassifications" out of 17 kills. Re-running the kill matrix today still
   gives 17 kills of which **13** are false successes. The total is unchanged; the split is not.
3. **`packages/core/test/no-locator-vocabulary.test.ts` is green.** Unit 19 reported it failing
   because `packages/conformance/` existed and was not on `ABOVE_THE_DRIVERS`; it has since been
   added, and the integration pass verified by injection that the scan really reads conformance's
   `src/`.
4. **`@crr/conformance`'s `playwright` and `@crr/surface-browser` devDependencies are not unused.**
   Unit 17 asked for both to be dropped. `test/heterogeneity.test.ts` imports `attachBrowserSurface`
   and `chromium`, and the conformance barrel test imports `CaptureSink` from both drivers as types.
   Both should stay.
5. **The lockfile is consistent with every manifest.** Unit 20 flagged its hand-written `link:`
   entries as possibly leaving pnpm's bookkeeping stale. A full comparison of all nine importers
   against all nine `package.json` files reports **0 problems**. A `pnpm install` is still worth
   running once, but nothing is broken, and no pass since has touched a manifest.
6. **`pnpm lint` exits 0.** Units 19 and 24 reported 15–24 diagnostics; those were sibling agents'
   in-progress files and are gone. It reads 314 files today.
7. **`@crr/conformance` typechecks.** Unit 24 reported
   `src/scenarios/terminal.ts(168,72): Property 'settled' does not exist on type 'JournalEvent'`.
   That module was moved to `test/terminal/scenarios.ts` and the narrowing now goes through
   `src/journal-view.ts`. The underlying core defect is real and still open — §7.5.
8. **`packages/conformance/src` imports no driver.** Unit 24 reported `src/corpus/terminal-harness.ts`
   importing `@crr/surface-terminal`. The driver wiring now lives in `test/terminal/harness.ts`; the
   documents stayed in `src/`. Verified by injection.
9. **§7.1's "one command away from closing" was false when it was written**, and that correction was
   itself correct: there was no runner, `createAnthropicModel` had no caller, and the author could
   not have spent the money even deliberately. **That correction is now closed by §3.5.**
10. **§10's "38 tests silently skip without Chromium" was stale.** It moved to 42, then 46. **46 is
    still the number**, re-measured this pass with `PLAYWRIGHT_BROWSERS_PATH` at an empty directory
    (`surface-browser 29 + runtime 16 + conformance 1`).
11. **§1's "1,739 green without a browser" is stale.** It is **1,774** now, of 1,820.
12. **THE LARGE ONE. §7.1 asserted four things that are all false as of this pass**, and it is the
    reason this document was regenerated rather than patched:
    - *"THE COMMAND IS THE THING THAT IS MISSING"* — there is a command, `pnpm discover`.
    - a grep showing `createAnthropicModel` with no caller outside its unit tests — it has one, at
      `tools/discover.ts:1102`, and the grep in §7.1 is the current one.
    - a preflight verdict containing `6. RECORDING  BLOCK  no runner exists` — that check now
      passes and enumerates the six pieces the runner composes.
    - a preflight verdict reading `NOT READY — 1 blocker, 2 warnings, 12 checks passed` — the two
      cost warnings are gone (`max_tokens` was lowered from 16,000 to 2,000, moving the worst case
      from $31.90 to $4.18) and the counts are now 14 passed / 15 with a key.
    Every limitation the old §7.1 recorded that is *still* true has been kept: no model has ever
    driven this system, preflight has no automated test, `U` is assumed rather than measured, and
    the cache saving is small.
13. **§5.2's `COMBINED SURVIVORS (browser + terminal): []` line was quoted but no command produced
    it.** `ALL_SCENARIOS` is the browser corpus alone, so the test at
    `terminal-conformance.test.ts:171` that the line appeared to come from is asserting something
    else (that generalising to a second corpus did not weaken the first). This pass **ran the union**
    — 9 mutants × 39 scenarios — and the line is now output rather than inference. The claim was
    true; its provenance was not.
14. **Three of the four chokepoint dispatch sites in §4 had stale line numbers.**
    `interpreter.ts:543` → `:578`, `interpreter.ts:1054` → `:1090`, `loop.ts:432` → `:546`;
    `intervention.ts:532` is unchanged. The test locates them by scanning and never noticed; this
    document quoted them by hand. Re-derived off disk this pass.
15. **§2's per-package counts, `src` sizes and build sizes all moved** and are re-measured:
    `@crr/discovery` 250 → 282 tests and 6,965 → 7,468 `src` lines; `@crr/runtime` 311 → 314;
    total 1,785 → 1,820 across 101 → 102 files; `discovery` ESM 132.20 → 137.99 KB and DTS
    77.33 → 85.70 KB.
16. **§6's canary line said "3 values × 14 encodings = 26 distinct needles, 0 hits" over a bundle
    it did not size.** Re-run: pass 1 scans 44 files / 920,593 bytes, the whole-bundle pass scans 48
    files, both CLEAN, and the bundle is 934,441 bytes.
17. **§9 listed five deletions; one of them is done.** `/.exports.mjs` was removed by a commit and
    is gone from the tree. Four remain, three of them tracked. `rm` is still denied.
18. **§8's `whenToUse` row was imprecise in a way that mattered.** It said the fields are "filled
    with `NEEDS AN AUTHOR`", which is only what happens when the caller supplies nothing. The
    committed capability and the live-run bundle both carry real prose, because
    `tools/live-run.ts`'s `LIVE_CAPABILITY` and the fixture emit script pass hand-written lines in.
    The row now says so, because "synthesis wrote this" and "a person wrote this and synthesis
    carried it" are different claims about the one document a reviewer will read most closely.
19. **§1's "Nothing loads `.env`" needed extending, not correcting.** The grep it rests on
    (`grep -rn dotenv` over `packages/` and `fixtures/`) still returns nothing, and no library
    module reads `.env`. But a file that does now exists: `loadDotEnv` in
    `packages/discovery/tools/discover.ts`, reading it with `readFileSync`. §1 names it, says what it
    prints (names, never values), and says that `tools/preflight.ts` — which talks about `.env` in
    its output — **does not read it**.
20. **Everything else in §§1–8 that this pass re-ran, reproduced.** 1,820 tests across 102 files in
    8 members, all green with the four credential variables unset; `pnpm build` 8/8; `pnpm
    typecheck` 14/14; `pnpm lint` clean; `pnpm demo` 7/7 with both canary passes CLEAN; the browser
    kill matrix, the terminal kill matrix, the flake rate, the per-descriptor table, the settle
    sweep and the cross-tenant divergence table all identical to the previous revision's, cell for
    cell. What this pass did **not** re-verify is every injection experiment §§3–7 describe; those
    still stand on the units that ran them, and where a section leans on one it now says so.

---

## 12. What a reviewer should take from this

**Proved, by a command in this document:** the classifier's three-way split; descriptor agreement as
a detected condition rather than a fallback chain; the single policy chokepoint, covering the
interpreter, the model's own action during discovery and a human's action through the operator
console alike; the typed four-arm result contract; the escalation path; **a conformance suite with
nine weakened engines, zero survivors over the combined 39-scenario corpus, zero false successes for
the reference engine, and a meta-test verified to fail when the suite stops discriminating** (the
survivor and false-success numbers were re-run this pass; the meta-test's own failure injection was
not, and §5.1 says so); one
artifact replaying green on two tenants of one vendor product through a non-semantic overlay; and
one `activate` step lowering to a click on a browser and to `F3`/`F12` on two tenants of a green
screen.

**And the cycle itself — a SYNTHESIZED artifact replays.** `@crr/discovery` emits its contract and
artifact to a committed JSON file; `@crr/runtime` reads that file as data and executes it against the
real hostile fixture in a real browser, verifies it, approves it with an ed25519 signature over its
digest, and then invokes it for a member the recording never saw. Executing it found three real
defects in synthesis — a member's name and balance in a signed document, every delivered string
case-folded, and a parameter offered to a calling agent as `value1` — all three fixed and all three
guarded (§7.2, §3.6).

**And the irreversible write — a real sub-account is opened against the real fixture in a real
browser, the modal confirmation is what authorizes it, and the core is asked afterwards how many
accounts it holds.** A dry-run verification stops at the boundary and the count does not move; a
verification followed by an approved invocation opens exactly one; the fixture's maintenance
interstitial, which is the SAME modal widget with a different accessible name, is still
`undeclared-dialog` and posts nothing. Closing it found a second real defect — a torn read on a
browser, the accessibility tree of one document stitched to the frame tree of the previous one —
which was invisible while every dialog was a hard failure and is fixed and guarded (§7.3).

**And the live-run path, which was the headline gap in the previous revision of this document.**
There is now a runner (`pnpm discover`), a readiness check that makes no model call
(`pnpm preflight`), a free end-to-end rehearsal (`pnpm discover --dry-run`), two spend guards that
have been *observed* halting the loop and keeping everything it had (re-observed this pass), a
`--yes` gate observed refusing with a funded credential in the process (by the pass that built it;
re-verified here off the source, §7.1), and a failure path that writes the transcript you already
paid for instead of throwing it away. The whole decision is on one screen
before a cent is spent.

**Not proved:** that a model has ever driven this system end to end (§7.1). It remains the only
headline gap, and it is no longer an engineering gap. The runner exists, it has been rehearsed, the
worst case is $4.18 with a $2.00 cap in front of it, and the realistic figure is $0.30–$0.80. What
it needs is the author's decision, and `docs/design/LIVE-RUN-READINESS.md` is the document written
for making it.

**Do not read the green board as completeness.** 46 of 1,820 tests are browser-conditional and skip
silently; the flake rate is measured over a fixture we control, not a vendor app; four of nine
mutants survive the green-screen corpus for reasons that are properties of the surface and are
written down rather than papered over; `pnpm preflight` has no automated test; the spend ledger has
never run against real provider numbers (§7.1); and `/README.md` and `/REPORT.md`, two of the three
paths BRIEF §7 names, do not exist (§10).
