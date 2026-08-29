# `@crr/runtime`, `@crr/discovery`, `@crr/surface-browser` — status after integration

> **SUPERSEDED IN PART BY `docs/design/FINAL-STATUS.md`.** This file is the record of the pass that
> integrated SPEC §11 units 10–16 and is kept as written. Units 17–24 have landed since, so some
> statements here are no longer true — most visibly §7.5's "`@crr/surface-terminal` and
> `@crr/conformance` do not exist" (both exist and ship tests), §7.6's `stableSamples` placeholder
> (measured and applied; FINAL-STATUS §3.4), §7.7's unconnected adapter vocabularies (now pinned by
> tests; FINAL-STATUS §3.1), and §8 items 2–3 (the manifests were fixed). **Where the two disagree,
> FINAL-STATUS is the one whose commands were re-run.** §7.1 (the discovery→replay seam) and §7.2
> (the confirmation-dialog encoding) are both still open, unchanged.

**Scope of this file.** SPEC §11 build units **10–16** were built in parallel by seven agents that
could not see each other's work, and then integrated. This is the companion to
`docs/design/CORE-STATUS.md` and follows the same rule: every number below came from a command that
was actually run, the command is printed next to the number, and what is *not* proved is stated as
plainly as what is.

Last integrated: the units 10–16 integration pass (barrels, cross-package conflict resolution, the
architecture contract tests extended above the drivers, a barrel test per package).

---

## 1. Commands, and their real output

Turbo caches every one of these, and a cache hit is not evidence. The numbers below come from runs
with the cache bypassed (`TURBO_FORCE=1`), which executes exactly the same scripts.

```
$ TURBO_FORCE=1 pnpm build
  @crr/core:build:            ESM dist/index.js 310.02 KB   DTS dist/index.d.ts 14.42 MB   # SUPERSEDED, see 10.5
  @crr/surface-browser:build: ESM dist/index.js  55.39 KB   DTS dist/index.d.ts 24.08 KB
  @crr/discovery:build:       ESM dist/index.js 123.37 KB   DTS dist/index.d.ts 69.35 KB
  @crr/runtime:build:         ESM dist/index.js  71.73 KB   DTS dist/index.d.ts 86.83 KB
                              ESM dist/cli.js    12.62 KB   ESM dist/codegen-cli.js 3.06 KB
   Tasks:    5 successful, 5 total
  Cached:    0 cached, 5 total
    Time:    18.765s                                                          (exit 0)

$ TURBO_FORCE=1 pnpm typecheck                 # tsc --noEmit in all five workspace members
   Tasks:    7 successful, 7 total
  Cached:    0 cached, 7 total
    Time:    13.992s                           (no diagnostics printed;       exit 0)

$ env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY \
      -u CLAUDE_CODE_OAUTH_TOKEN TURBO_FORCE=1 pnpm test
  @crr/core:test:                  Test Files  33 passed (33)   Tests  744 passed (744)
  @crr/runtime:test:               Test Files  15 passed (15)   Tests  239 passed (239)
  @crr/discovery:test:             Test Files  11 passed (11)   Tests  196 passed (196)
  @crr/surface-browser:test:       Test Files  12 passed (12)   Tests  107 passed (107)
  @crr/fixture-corebank-web:test:  Test Files   1 passed  (1)   Tests   66 passed  (66)
   Tasks:    7 successful, 7 total
  Cached:    0 cached, 7 total
    Time:    19.713s                                                          (exit 0)

$ pnpm lint                                    # biome check . at the repo root
  Checked 215 files in 66ms. No fixes applied.                                (exit 0)
```

**Totals: 72 test files, 1352 tests, all passing.** Plain `pnpm build` / `pnpm typecheck` /
`pnpm test` at the root also exit 0; they report `FULL TURBO` because the forced runs above
populated the cache.

`pnpm lint` was reported as failing on `packages/runtime/package.json format` by unit 10. It does
not fail now: 215 files, zero findings, exit 0. The only formatting fixes this pass applied were to
files it had just written (`npx biome check --fix` on those files by name).

---

## 2. What exists, and where the tests are

| Package | Units | `src/` modules | Test files | Tests | Browser-driving |
|---|---|---|---|---|---|
| `@crr/surface-browser` | 10 | 11 | 12 | **107** | 4 files, 29 tests |
| `@crr/runtime` | 11, 12, 15, 16 | 28 | 15 | **239** | 1 file, 4 tests |
| `@crr/discovery` | 13, 14 | 18 | 11 | **196** | none |
| `@crr/core` | 1–9 | 37 | 33 | **744** | none |
| `fixtures/corebank-web` | 9 | 6 | 1 | **66** | (it *is* the app) |

**1319 of the 1352 tests are hermetic** — no browser, no socket, no clock, no credential. The other
33 launch Chromium against the local `corebank-web` fixture server, never the public internet, and
they live in files named `browser-*.test.ts` so the split is visible from a directory listing.

Per-unit test counts as each unit delivered them (cumulative within a package, because later units
in the same package inherited and extended the suite):

| Unit | Subject | Package | Tests at delivery |
|---|---|---|---|
| 10 | CDP AX stitch, frames, geometry, dialogs, masked capture, driver rules D1–D7 | `surface-browser` | 101 |
| 11 | the §3.1 interpreter cycle, settle, budgets, lease, journal, evidence, store, `crr replay` | `runtime` | 81 |
| 12 | result contract, catalog, `renderForAgent`, the digest pin, codegen | `runtime` | 162 |
| 13 | discovery loop, five tools, projection, VCR record/replay, Anthropic adapter | `discovery` | 113 |
| 14 | synthesis: descriptors, parameterization, routes, outputs, fingerprint, emit | `discovery` | 190 |
| 15 | verification replay (`full`/`dry`/`reset`), grade, ed25519 signing, `approve` | `runtime` | 204 |
| 16 | escalation, intervention desk, the seven-step resume re-check, operator console | `runtime` | 235 |
| — | **this integration pass** | all four | **+18** |

The 18 added here are 6 + 6 barrel tests (`discovery`, `surface-browser`), 4 cross-package tests in
`runtime`'s existing barrel test, and 2 contract tests in `core`. **`@crr/core`'s 742 all still
pass**; the file it grew to 744 is `test/no-locator-vocabulary.test.ts`, and §4 says what the two
new ones are for.

### Every SPEC §11 acceptance test for units 10–16 exists and passes

Checked one by one against the table in SPEC §11, because a unit report saying "passing" and the
spec's stated acceptance criterion are two different claims:

- **10** — `browser-perceive.test.ts` (frameset node counts, roles, advertised capabilities),
  `browser-act.test.ts` ("holds the dialog open, times perception out, and answers it on request"),
  `browser-capture.test.ts` ("blanks the sensitive field's pixels, and only those").
- **11** — `browser-replay.test.ts`: the nine-step flow returns `ok` with typed outputs, plus three
  fault scenarios (`MEMBER_NOT_FOUND` outcome, declared interstitial recovered, app-error page as a
  hard failure once the restart budget is spent). **Against the real fixture, in a browser.**
- **12** — `typed-outcomes.test.ts` compiles the generated call site and then *refuses to compile*
  it once a third `OutcomeDecl` is declared; `invoke.test.ts` covers the stale-digest pin;
  `agent-view.test.ts` covers `renderForAgent`.
- **13** — `vcr.test.ts` "reaches the goal with every credential removed from the environment";
  `tool-schema.test.ts` is the schema regression suite.
- **14** — `synthesis-descriptors.test.ts` (frozen-observation derivation),
  `synthesis-parameterization.test.ts` (the recorded value appears nowhere in the emitted artifact),
  `synthesis-emit.test.ts` (byte-equal across two independent runs; the documents *link*).
- **15** — `verify.test.ts` "DOES NOT PERFORM THE WRITE TWICE: one run wrote, the verification that
  follows does not"; `approval.test.ts` for the edited-artifact digest check.
- **16** — `escalation.test.ts` "REFUSES when the human navigated away — the acceptance case", and
  "drives suspend -> claim -> act -> hand-back -> resume over its six routes".

---

## 3. The three barrels, and the one real conflict

All three `src/index.ts` files already existed and were already complete. Verified rather than
assumed: **every module in every package is re-exported, and no name is exported by two modules in
the same package** — see §5.

### 3.1 `ReplayOptions` was declared twice, in two packages, meaning two different things

`@crr/runtime`'s `ReplayOptions` is the argument to `replay()` — the artifact interpreter, the
centre of the whole system, twenty-odd fields. `@crr/discovery`'s `ReplayOptions` was the argument
to `createReplayModel()` — the VCR transcript adapter, one optional `strict` boolean.

Each read correctly in its own file. Neither package's tests could see the other, because
**neither package imports the other and nothing in the workspace imports both.** The first consumer
of both (`@crr/conformance`, `examples`) would have had to alias one of them, and the second would
have got it wrong.

**Resolved:** `@crr/discovery`'s is now `TranscriptReplayOptions`. The narrower concept takes the
longer name, and the rename is documented at the declaration. Two call sites in
`packages/discovery/src/transcript.ts`; nothing else in the workspace referenced it.

### 3.2 Three names are shared between `@crr/core` and `@crr/runtime` on purpose

`ActionKind`, `Digest` and `PolicyDecision` are exported by both. They are **not** second
definitions: `packages/runtime/src/interpreter.ts:1563` and `replay.ts:912` re-export core's types
because they appear in the signature of something `@crr/runtime` exports. They are now on an
explicit ledger (`INTENTIONAL_OVERLAPS` in `packages/runtime/test/barrel.test.ts`) with the argument
for each, and **compile-time seams assert the two spellings are the same type** in both directions:

```ts
const digestOut: (d: CoreDigest) => Digest = (d) => d;
const digestBack: (d: Digest) => CoreDigest = (d) => d;
```

That seam was verified to be live, not decorative: adding `const bad: (d: string) => Digest = (d) => d;`
produces `test/barrel.test.ts(277,52): error TS2322: Type 'string' is not assignable to type
'string & $brand<"Digest">'`. This is the exact failure unit 9 hit for real between the classifier
and the resolver (`TargetOutcome.kind` vs `.status`), one package boundary further out.

### 3.3 What was *not* changed

`cli.ts` and `codegen-cli.ts` stay out of `@crr/runtime`'s barrel. They are `main()` behind an
`import.meta.url` guard and are built as their own bundles; re-exporting them would put `parseArgs`
and `process.stdout` in the import graph of every consumer that only wanted `invoke`. The barrel
test asserts both the exclusion and the reason (`ENTRY_POINTS`, "keeps the two commands out of the
library graph"). They are also the only two modules in the workspace that collide on a name — both
declare `main` — which is precisely why they must not both be starred into one namespace.

---

## 4. The architecture contract tests, extended above the drivers

SPEC §1.3 names two contract tests. Both live in `@crr/core/test` and both read the repo off disk.

### 4.1 CSS vocabulary — the package list was already right; the *coverage* was unproved

`test/no-locator-vocabulary.test.ts` already listed `["core", "runtime", "discovery"]`, written
before the latter two existed. They exist now, and the scan passes over all 46 of their `src/`
modules (28 + 18) — but the suite would have passed identically if `packageSources` had silently returned
nothing for them, which is exactly the state it had been in for the whole build.

Two strengthenings, both inside the existing tests (so `@crr/core`'s count did not move for these):

1. **"were actually read" now counts per package**, not in aggregate, with a floor for each. A total
   of sixty files proves nothing about `@crr/discovery` if all sixty came from `@crr/core`.
2. **The package list is now checked against the workspace**, not against itself: every directory
   under `packages/` is either a `surface-*` driver (exempt — a driver is precisely the layer
   allowed to know what a stylesheet is) or it must be on the list. `@crr/conformance` will fail
   this test on the day it is created, which is the day the decision should be made.

**Verified against the real packages, not only against synthetic sources.** Violations were injected
into two real modules and the suite was run:

```
# appended to packages/runtime/src/settle.ts and packages/discovery/src/prompt.ts, then reverted:
× the packages above the drivers > speak no locator vocabulary
  packages/discovery/src/prompt.ts:118  xpath  - an XPath is a path through a markup tree …
  packages/runtime/src/settle.ts:205  querySelector  - a descriptor names a role and an accessible name …
  packages/runtime/src/settle.ts:204  [data-  - the target applications have no test ids …
```

Both files were restored and the suite is green again.

### 4.2 New: the other half of BRIEF §3.1 — **no import of any driver**

BRIEF §3.1 reads: *"the engine packages must contain no CSS-selector vocabulary **and no import of
any driver**."* Only the first half was enforced above `@crr/core`. `@crr/core` gets the stronger
allowlist form of the second half from `purity.test.ts` (`scanForForeignImports`), but the two
packages above the drivers that legitimately own disk, sockets, clocks and a model SDK cannot be
held to an allowlist, so they had no version of it at all.

`scanForDriverImports` (new, in `test/architecture-scan.ts`) catches two shapes:

- **the driver package**, by any spelling — `@crr/surface-browser`, or a relative path into
  `../surface-terminal/`;
- **the libraries a driver is made of** (`DRIVER_LIBRARIES`: playwright, playwright-core,
  @playwright/test, @xterm/headless, xterm-headless, node-pty, puppeteer, puppeteer-core,
  selenium-webdriver). Reaching for `playwright` directly rather than importing
  `@crr/surface-browser` passes the first check and commits the identical sin.

The concrete failure it exists to catch: **`crr`'s central claim is that the driver is a parameter**
(`--surface <module>`), and `@crr/runtime` compiling without Playwright is the proof. One
convenience import in `cli.ts` would end that claim and break no test at all.

Two tests, `+2` on `@crr/core`'s count (742 → 744): the enforcement, and a discrimination suite that
proves the scanner can fail — including the near misses that would make it unusable (`@crr/core`,
`node:fs`, `@anthropic-ai/sdk`, and a comment mentioning the driver by name).

Verified the same way, against real modules:

```
# appended to packages/runtime/src/store.ts and packages/discovery/src/prompt.ts, then reverted:
× the packages above the drivers > import no driver …
  packages/discovery/src/prompt.ts:118  @crr/surface-browser  - the driver is a parameter
      (`--surface <module>`), not a dependency of the engine
  packages/runtime/src/store.ts:130     playwright            - importing what a driver is made of
      is importing a driver by another name
```

**Today the rule holds: `@crr/runtime/src` and `@crr/discovery/src` contain zero driver imports.**
Every mention of `@crr/surface-browser` in either `src/` tree is inside a comment. The manifest is a
separate question and is *not* clean — see §8.1.

### 4.3 The policy chokepoint already covered both packages, and it is doing real work

`test/policy-chokepoint.test.ts` scans the whole repository (97 shipped sources), not just
`@crr/core`, and it was green throughout. That was worth confirming rather than assuming, because a
scan that finds nothing passes as loudly as one that finds everything. There are **four real
`Surface.act` dispatch sites in the workspace**, all above `@crr/core`:

```
packages/runtime/src/interpreter.ts:543     guarded by check() at :535
packages/runtime/src/interpreter.ts:1054    guarded by check() at :1048
packages/runtime/src/intervention.ts:532    guarded by check() at :527   (the human's own action)
packages/discovery/src/loop.ts:432          guarded by check() at :429   (the model's own action)
```

Every one is immediately preceded by a `check` on the same expression whose decision is consulted.
The other `.act(` occurrences the scanner sees are in comments and are blanked before matching. This
is the single strongest structural result of the integration: **the model's action during discovery
and a human's action through the operator console pass the same gate as the interpreter's.**

---

## 5. A barrel test per package

`export *` hides exactly two failures, and the second one is the dangerous one: under the ES module
semantics `export *` follows, **an ambiguous star export is not an error — the binding is silently
absent from the barrel**, and the symptom surfaces at the far end of the monorepo with nothing
pointing back at the cause. Unit 12 hit it for real: `export type { Digest }` in `invoke.ts` beside
the identical line in `replay.ts` quietly removed `Digest` from `@crr/runtime`'s public surface and
nothing failed.

`@crr/core` and `@crr/runtime` already had one. `@crr/discovery` and `@crr/surface-browser` now do
too. Each reads its own `src/` off disk, extracts export names **from the TypeScript AST** (a regex
is quietly wrong about `export type { X }` and `export { x as y }`, and both appear here), and holds
the same four invariants:

1. every module in `src/` is re-exported — a unit cannot ship invisibly;
2. every specifier in `index.ts` names a module that exists, and the counts match;
3. no name is exported by two modules;
4. every *value* is really reachable through the barrel at runtime, not merely in the types — which
   is exactly what an ambiguous star export looks like from the outside.

Package-specific additions:

- **`@crr/discovery`** asserts the two subdirectories (`adapters/`, `synthesis/`) are actually being
  walked, because they are where a name collision is most likely — eight `synthesis/` modules all
  speaking about parameters, routes and values. It also asserts the barrel imports cleanly **with no
  credential in the environment**: the Anthropic adapter is on the barrel, so importing
  `@crr/discovery` loads the SDK, and it must not construct a client or read a key at module scope.
- **`@crr/surface-browser`** asserts that **Playwright's runtime is never loaded**. Ten of its eleven
  modules are pure functions over CDP payloads; only `surface.ts` touches a `Page`, and it touches
  one it is *handed* (`attachBrowserSurface`). The single reference to the module in `src/` is an
  `import type`, and the test fails on any value import. Without it, the day a consumer with no
  browsers installed imported `@crr/runtime` they would get an error from a transitive dependency
  they never named.
- **`@crr/runtime`** gained the cross-package ledger described in §3.1–3.2: it reads `core`,
  `runtime` and `discovery` off disk (no import, so no dependency edge is created) and fails on any
  name exported by two of them that is not on `INTENTIONAL_OVERLAPS`.

The cross-package check was verified to fail: adding `export interface EvidenceSink` to
`packages/discovery/src/prompt.ts` produced
`"runtime / discovery  EvidenceSink: runtime/evidence.ts and discovery/prompt.ts"`. Reverted.

**Known duplication.** Four near-identical copies of the AST reader now exist, one per package. The
alternative is a shared dev package, and adding a workspace member is a lockfile change this pass was
not permitted to make; a test that reads its *own* package's `src/` also cannot lie about which
package it is describing. `CORE-STATUS.md` §7 item 7 already records this as the seam
`@crr/conformance` will have to resolve, and it now has four callers instead of two.

---

## 6. The no-credentials requirement — verified, and how

BRIEF §11 is a hard rule and a submission requirement, not a nicety. **No live model API call was
made at any point in this pass.**

The exact command:

```
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY \
    -u CLAUDE_CODE_OAUTH_TOKEN TURBO_FORCE=1 pnpm test
```

Result: `Tasks: 7 successful, 7 total` / `Cached: 0 cached, 7 total`, all 1352 tests passing,
exit 0.

Four independent reasons this holds, rather than one:

1. **Nothing loads a `.env` file.** `grep -rn "dotenv"` over every package returns nothing; the only
   `process.env` read in shipped source is `packages/discovery/src/adapters/anthropic.ts:133`, and
   it takes `options.env` first.
2. **The only adapter that can call a provider takes an injectable client.** Every test in
   `@crr/discovery` constructs it as `createAnthropicModel({ env: {}, client: fakeClient(...) })`.
   With no key and no injected client, construction *throws* a `DiscoveryModelError` naming
   `createReplayModel()` as the alternative — the failure a reviewer will actually hit is answered
   with instructions rather than a 401.
3. **The loop's own acceptance test unsets the credentials itself** and asserts they are gone before
   running (`vcr.test.ts`, "reaches the goal with every credential removed from the environment").
   This pass added `CLAUDE_CODE_OAUTH_TOKEN` to that list — the `agent-sdk` adapter draws on a Claude
   Code subscription rather than an API key, so a suite that only unset the two API keys would still
   have a live path to a provider if that adapter were ever wired in.
4. **`crr` has no discovery verb.** Its five verbs are `show`, `link`, `verify`, `approve`, `replay`.
   Recording is `@crr/discovery`'s and has no CLI at all yet (§7.1).

---

## 7. What does **not** work, is not proved, or is stubbed

Ordered by how much it matters to the next phase.

### 7.1 The discovery→replay seam is untested, because nothing in the workspace imports both

This is the largest gap and it is structural, not a bug. `@crr/discovery` does not depend on
`@crr/runtime` and `@crr/runtime` does not depend on `@crr/discovery`. Verified: there is no import
edge in either direction, and the only place either package names the other outside a comment is the
disk-scanning ledger in `@crr/runtime`'s barrel test, which reads files and imports nothing.
Consequently:

- ✅ **A synthesized artifact links.** `synthesis-emit.test.ts` runs `@crr/core`'s `link` — all 28
  checks — over the emitted contract + artifact against `MOCK_SURFACE_CAPABILITIES`, in both
  `verification` and `replay` modes.
- ✅ **A hand-authored artifact replays,** through the real interpreter, the real browser driver and
  the real hostile fixture (`browser-replay.test.ts`, 4 tests).
- ❌ **No test ever replays a *synthesized* artifact.** The two halves of SPEC §1.1's cycle have
  never been connected by code.

**Why the risk is bounded, and where it is not.** It is not a *type* risk: `synthesizeCapability`
returns `@crr/core`'s `CapabilityContract` and `CapabilityArtifact`, and `replay()` consumes the same
two types, so the structural-incompatibility failure mode that bit units 4/5 cannot occur here — both
halves speak core's schema by construction. The risk is **semantic**: nothing has demonstrated that
the descriptors, checkpoints, budgets and effect summary synthesis emits are ones the interpreter can
actually execute. SPEC §11 puts unit 15's verification replay exactly here for exactly this reason,
and `verifyAndDraft` is implemented and tested — but tested against hand-written flows, never against
synthesis output.

**What closing it needs.** `@crr/conformance` (unit 17) depends on both by design and is the right
home. Failing that, `@crr/discovery` as a devDependency of `@crr/runtime` — a lockfile change (§8).
A third option needs no dependency at all and may be the fastest: have `@crr/discovery` emit its
synthesized contract + artifact to a committed JSON fixture, and have a `@crr/runtime` test *read*
that JSON and replay it. The artifact is data, not code; reading it as data is the whole design.
Note the synthesis fixture's recorded run is over `MockSurface`, so such a test replays over
`MockSurface` too — it would prove the interpreter can execute what synthesis emits, not that the
browser driver can.

### 7.2 The write path — the irreversible boundary — is proved against `MockSurface`, never a browser

`verify.test.ts` (21 tests) and `escalation.test.ts` (31 tests) drive `test/fixtures/write-flow.ts`
and `escalation-flow.ts` over `@crr/core`'s `MockSurface` — a frozen corpus of `Observation`s, no
browser, no network, no credential; `verify.test.ts`'s own header says so in its first line. They are strong tests and they cover the claims SPEC §11
asks for, including "DOES NOT PERFORM THE WRITE TWICE" and "REFUSES when the human navigated away".

But `fixtures/corebank-web` has a modal confirm and a real sub-account commit, and **the browser
suite never touches it.** Unit 11 explains why and the reason is legitimate rather than an oversight:
SPEC §4.4 runs band B2 (interception) before B5 (checkpoint), so a confirmation dialog cannot be a
step's expected postcondition, and the only expressible shape — an interception recovery whose remedy
performs the irreversible commit — is forbidden by SPEC §3.5. Unit 11 could not find a legal
encoding and says so, recommending either an `expectDialog` clause on `Checkpoint` or a
`resume: "continue"` recovery mode that re-verifies without re-dispatching. **That is a spec decision
the next phase has to make**, and until it is made the fixture's headline write flow is not
replayable at all.

The corebank acceptance flow is therefore nine READ steps ending on a *prepared* open-sub-account
form — an honest automation-prepares / human-completes hand-off, and it does exercise approval and
ed25519 — but a purely read-only capability would naturally be seven steps, and unit 11 says steps
8–9 exist partly to reach nine.

### 7.3 Two one-line changes `@crr/core` needs, deliberately not made

Both were reported by unit 11 and both are still outstanding. `@crr/core` is complete and verified
and an integration pass should not edit it silently.

1. **`JournalEvent` is not narrowable by `type`.** `packages/core/src/journal.ts`'s `event()` helper
   takes `type: string` rather than a generic literal, so `z.literal(type)` infers
   `ZodLiteral<string>` and every union member's discriminant widens to `string`. *Runtime validation
   is unaffected* — the schema holds the real literal and `parse` still refuses a wrong `type` — but
   `event.type === "acted"` narrows nothing. Fix:
   `const event = <K extends string, T extends z.core.$ZodShape>(type: K, shape: T) => …`. Until
   then the one unavoidable cast lives once, named, in
   `packages/runtime/test/support/journal.ts`.
2. **`RunWarningSchema`'s code enum has no member for "a declared check could not be evaluated"**
   (`postcondition-unverifiable`). See §7.4.

### 7.4 A `fill` bound to a sensitive parameter has no read-back postcondition

SPEC §3 requires `fill`'s postcondition to be "the target's value equals the written value after
normalize", justified by the `maxlength`-truncation case. The browser driver blanks `value` and
`text` for a field a sensitive value was typed into (`masked: true`), so the assertion would compare
the caller's argument against a deliberately empty string.

Resolved in favour of the taint model: `verifyInstructionPostcondition` **passes** on a masked node
and returns a warning. **The truncation defence does not exist for sensitive fills.** Because
`RunWarningSchema`'s enum is closed, the warning rides on the `checkpoint` journal event's trace
rather than on `RunEnvelope.warnings`, where a caller would see it.

The real fix is one field on the port: a driver reporting the masked field's **length**
(`UINode.capacity` already exists for grids) restores the check without carrying the value. That is a
`@crr/surface-browser` change; it is reported here and not made.

### 7.5 Stubs, named as stubs

- **`agent-sdk` and `openai` adapters: not implemented.** Both names are in `DISCOVERY_ADAPTERS`
  because BRIEF §10 requires every evidence file to say which adapter produced it. There is no
  implementation behind either. `openai` is SPEC §11 unit 23 (CUT-1); `agent-sdk` is dev-only by
  design and must never produce evidence.
- **No outcome detectors are synthesized.** SPEC §0.2 forbids inferring one, so `contract.outcomes`
  comes out `[]` and the model's `finish` candidates are carried into `SynthesisReport` with an
  `outcome-candidate-needs-detector` note. A generated `detect` predicate for a screen the run never
  observed is how a false `MEMBER_NOT_FOUND` gets emitted, which SPEC §0.2 calls the worst thing this
  system can do.
- **`whenToUse` / `whenNotToUse` are not generated.** They are filled with an explicit
  `"NEEDS AN AUTHOR"` placeholder plus a `prose-needs-author` note. SPEC §2.3: models mis-route far
  more often than they mis-fill arguments, so a generated line there is a generated routing decision.
- **`effect-in-doubt` escalates and journals, but is not parked on the control plane.** It does not
  appear in the operator console queue and the arm stays `failed` (correct: the caller must not
  retry). Wiring it needs a second kind of parked entry — a live session a human may look at and may
  never hand back, because there is nothing to resume into. The seam is named in a comment at the
  site in `interpreter.ts`.
- **Approval key custody does not exist** (OPEN-QUESTIONS-RESOLVED Q5, deliberately out of scope).
  `ApprovalSigner` is a port so a KMS or HSM substitutes cleanly; `ed25519Signer` holds a private key
  in process memory and has **no approver identity, no expiry and no revocation**. The limit is
  stated in the doc comments REPORT §6 can quote verbatim.
- **No `examples/` directory, no `pnpm demo`, and `evidence/` is empty.** `pnpm-workspace.yaml` lists
  `examples` and `cli.ts`'s header says "`examples/` ships the browser factory"; neither exists yet.
  BRIEF §0 requires `pnpm install && pnpm demo` to work with no live LLM. That is SPEC §11 unit 18
  and it is **not started**. `packages/runtime/test/fixtures/mock-surface-entry.mjs` is the only
  `--surface <module>` factory in the repo today, and it is a test fixture.
- **`@crr/surface-terminal` and `@crr/conformance` do not exist.** Units 17, 20, 21, 22.

### 7.6 Numbers that are placeholders, and inferences that look like declarations

Carried forward from `CORE-STATUS.md` §7 and still true:

- `SettlePolicy.stableSamples = 2` and the `needsSpecialization` divergence threshold are
  **placeholders pending measurement** (OPEN-QUESTIONS-RESOLVED Q4/Q6). Unit 17's corpus decides
  both. Do not invent a number.
- Classifier rows 8, 13 and 16 infer a failure class **from the remedy** because `RecoveryRuleSchema`
  has no field naming one. One optional `classifyAs` field fixes it.
- **The linker still has 28 checks.** The check unit 4 asked for — "an artifact declaring ambient
  recoveries has at least one step that can spend one" — was not added, and
  `maxRemediationCycles: 0` still makes ambient rules inert. Unit 14 works around this from the
  recorder side by deriving non-zero step budgets when it lifts a dialog into an ambient rule, which
  means **the hazard is now half-mitigated and still not checked.**
- Table cells are not coerced to their declared per-column `ValueType`; `ExtractedValue` rows are
  `Record<string, string>` by construction.

### 7.7 An unresolved schema mismatch across the package boundary

`@crr/core`'s `ProvenanceSchema.model.adapter` is `z.enum(["anthropic","openai","agent-sdk","replay"])`.
`@crr/discovery`'s `DISCOVERY_ADAPTERS` has a fifth member, `"scripted"`, for the hand-authored model
used to build VCR fixtures. **A scripted run therefore has no honest spelling in an artifact.**

`synthesizeCapability` currently *refuses* a scripted run (`SynthesisError`, "debugging aid, not a
discovery run") rather than mislabelling it `"replay"`, which is the right failure direction. But the
mismatch should be resolved deliberately — add `"scripted"` to core's enum, or keep the refusal and
say so in the schema's doc comment. Right now the two vocabularies simply disagree and nothing but a
thrown error connects them.

---

## 8. Manifest changes the next phase needs (all blocked on the lockfile)

This pass was instructed not to run `pnpm add` or `pnpm install`, because concurrent agents corrupt
the lockfile. None of the following was made. All four are one line each plus one `pnpm install`.

1. **`@crr/runtime` lists `@crr/surface-browser` in `dependencies`, and `src/` never imports it.**
   Only `test/support/corebank.ts` does. It belongs in `devDependencies`. As it stands the manifest
   contradicts the design claim that `cli.ts` makes in its own header — the *code* is clean (§4.2
   now enforces that) and the *package* is not.
2. **`@crr/runtime` needs `playwright` as a devDependency.** `test/support/corebank.ts` currently
   resolves it with `createRequire` from `packages/surface-browser/package.json` and declares two
   minimal local `Page` / `Browser` interfaces. Test-only; `src/` depends on neither, which is the
   point.
3. **`@crr/surface-browser` and `@crr/runtime` both need `"@crr/fixture-corebank-web": "workspace:*"`
   as a devDependency.** Both test-support files currently reach the fixture server by relative path
   (`../../../../fixtures/corebank-web/src/server.js`) and say so in a header comment naming what to
   delete once the dependency exists.
4. **Something must depend on both `@crr/discovery` and `@crr/runtime`** to close §7.1.
   `@crr/conformance` is the designed answer.

---

## 9. Repository hygiene: files that could not be deleted

`rm` is denied to the integration agent, the same as it was to the unit-9 and unit-10 agents. None of
these affects any test, the build, `pnpm typecheck` or `pnpm lint`. Checked by name at the end of
this pass:

- **`/.exports.mjs`** — PRESENT, 0 bytes. Unit 9's throwaway export scanner. **Not gitignored: it
  would be committed. Delete it.** Its useful half is now four barrel tests.
- **`/packages/core/.scratch/probe.ts` (1326 bytes) and `probe2.ts` (798 bytes)** — PRESENT.
  Gitignored and biome-ignored, so they cannot be committed or linted, but `probe.ts` contains
  Playwright/CDP spike code sitting inside the package whose entire claim is that it is pure. The
  architecture tests scan `packages/*/src` and correctly do not see it; a reviewer opening the
  directory will. **Delete the directory.**
- **`/packages/surface-browser/pw-smoke.mjs` and `probe-eval.tmp.mjs`** — **ABSENT.** Unit 10 flagged
  both as needing deletion; they are gone, and so is `packages/surface-browser/.scratch/`. Nothing in
  this pass removed them (`rm` was denied here too), so they were cleared by someone else between
  unit 10 and now. Recorded rather than explained.
- **`/.scratch/` (root) and `/packages/runtime/.scratch/` (empty)** — gitignored and biome-ignored.
  `/.scratch/` holds this pass's working files: three probe scripts (`probe-exports.mts`,
  `probe-cross.mts`, `probe-act.mts`), five `.bak` files used to restore the modules that the
  injected-violation probes in §4 temporarily broke, and five run logs. All disposable.

No configuration was changed in this pass. `biome.json`, `turbo.json`, `pnpm-workspace.yaml`, every
`tsconfig.json` and every `package.json` are untouched.

---

## 10. What the next phase needs to know

1. **Unit 17 (`@crr/conformance`) is the keystone, and it now has three jobs, not one.** Besides the
   mutants and the meta-test, it is the only package that will depend on both `@crr/discovery` and
   `@crr/runtime`, so it is where §7.1's synthesis→replay seam gets closed, and it is where the four
   duplicated barrel scanners and the two duplicated architecture scanners
   (`chokepoint-scan.ts`, `architecture-scan.ts`, both test-only because they do I/O) finally have to
   be promoted or copied a fifth time.
2. **The confirmation-dialog encoding is a spec decision that blocks the fixture's write flow**
   (§7.2). Nothing further can be demonstrated against corebank's modal confirm until SPEC §3.5/§4.4
   gains either an `expectDialog` clause on `Checkpoint` or a `resume: "continue"` recovery mode.
   This is the single highest-value open design question in the repo.
3. **Unit 18 (evidence) has not started and `pnpm demo` does not exist.** BRIEF §0 makes it a
   reviewer-facing requirement, `evidence/` is empty, and the only live-model path in the repo
   (`createAnthropicModel`) has no CLI in front of it. Whoever builds it must also build the
   `--surface` factory that `examples/` is supposed to ship.
4. **Four contract tests now hold this architecture up, not two.** Purity (core only), CSS vocabulary
   (core + runtime + discovery), **driver imports (core + runtime + discovery, new)**, and the policy
   chokepoint (the whole repo). All four are scan-then-discrimination-then-ledger, all four have had
   their file selection verified by injecting a violation into a real module, and all four have an
   exemption ledger asserted empty. Adding a package above the drivers now *fails* the CSS test until
   somebody adds it to the list — that is deliberate.
5. **FIXED, and unit 11's missing-`index.d.ts` report is now diagnosed rather than folklore.** Two
   independent defects, both reproduced deterministically before being fixed.

   *The cancellation.* `turbo run test` defaults to `--continue=never`, so the first failing task
   cancels every sibling. `@crr/core:test` and `@crr/core:build` run concurrently (`test` depends on
   `^build`, its DEPENDENCIES' build, and core has none), and `tsup --clean` deletes `dist/` up
   front, writes `index.js` in ~25ms, then spends the next nine seconds inside rollup-dts. A cancel
   landing in that window leaves `dist/index.d.ts` absent — which is exactly what unit 11 saw.
   Reproduced by adding one failing test to `packages/core/test/`:

   ```
   $ turbo run test --force                      # the old root script
     @crr/core:build:  ELIFECYCLE  Command failed.        <- killed mid-DTS
      Tasks:    4 successful, 6 total
   $ ls packages/core/dist                       # index.d.ts MISSING; index.js present
   ```

   Fixed with `--continue=dependencies-successful` in the root `build`/`test`/`typecheck` scripts —
   a failing task no longer cancels a sibling whose own dependencies succeeded, and a package whose
   dependency genuinely failed is still skipped rather than run against a broken build. Same probe,
   after:

   ```
   $ pnpm test                                   # the new root script, core:test still failing
     @crr/discovery 196   @crr/surface-terminal 125   @crr/surface-browser 107
     @crr/runtime   257   @crr/conformance 63   fixtures 66 + 36        <- all report REAL results
      Tasks:    13 successful, 14 total          Failed: @crr/core#test  (exit 1)
   $ ls -la packages/core/dist/index.d.ts        # intact
   ```

   *The 14.42 MB.* Not caused by rollup-dts: emitting the same declarations per-file with `tsc`
   measured 15,146,902 bytes against the rollup's 15,144,529 — within 0.02%. The cause is that an
   exported `const XSchema = z.strictObject({...})` carries no type annotation, so TypeScript prints
   the whole inferred `z.ZodObject<{...}>` tree, and every parent schema re-prints its children's
   trees inside its own. `ReplayResultSchema` alone was 2,239,487 bytes. Fixed by giving the composed
   schema constants a NAMED interface type (`packages/core/src/schema-identity.ts`), which the
   declaration printer emits by name instead of expanding, plus moving declaration emit to
   `tsc -p tsconfig.build.json`:

   ```
   $ find packages/core/dist -name '*.d.ts' -exec stat -f "%z" {} \; | awk '{s+=$1} END {print s, NR}'
     283141 39                                   # was 15,144,529 in one file  -> 53x smaller
   $ turbo run build --force                     # whole monorepo
     before: Time 24.244s   (core DTS 9384ms, runtime DTS 9883ms)
     after:  Time  5.688s   (core build 1.5s total, runtime DTS 1285ms)
   ```

   **Fidelity was measured, not asserted.** The rolled-up `dist/index.d.ts` of `@crr/runtime`,
   `@crr/discovery`, `@crr/surface-browser` and `@crr/surface-terminal` are byte-identical before and
   after the rewrite (same MD5s, 91,975 / 71,015 / 24,665 / 21,633 bytes), so nothing any dependent
   exposes changed shape. `packages/core/test/declaration-size.test.ts` is the regression guard, and
   it was verified by injection in both directions: reverting one module trips the per-file budget
   (64,521 bytes), reverting three trips the total budget (566,417 bytes).
6. **Nothing above the drivers reads a clock, a socket or a selector, and nothing dispatches an
   action without a policy decision — and all four of those are now facts a test will lose sleep
   over rather than sentences in a README.**
