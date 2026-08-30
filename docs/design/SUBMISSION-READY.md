# SUBMISSION-READY — the last board before pressing send

**Read this first, then `git status`, then send.**

Every command in this document was run in this working tree on **2026-08-28**, in the order printed,
on `node v22.22.1` / `pnpm 10.33.0` / macOS 24.6.0. Where a number appears, the command that produced
it is next to it. Where something was **not** run, it says so and says why. **No live model API call
was made by this pass, to any provider** — `.private/BRIEF.md` §11.

Turbo caches aggressively, and a cached task replays an old log. Every board figure below was taken
from a run forced with `TURBO_FORCE=1` (or `--force`), so `Cached: 0` is part of the receipt.

> **RE-TAKEN IN PART ON 2026-08-29, AFTER THE OUTCOME-PROMOTION PASS.** That pass added linker check
> 29 (`outcome-unproven`), `packages/core/src/promotion.ts`, `packages/runtime/src/promote.ts` and
> their two test files, so the test board below moved. **Only the test board was re-run**, with
> `npx turbo run test --force` and every credential variable unset: **a now-superseded 107-file
> board, 14/14 tasks, `Cached: 0/14`, exit 0.** The figures that carry that date are marked `re-taken
> 2026-08-29`; every other figure in this document — `pnpm lint` 317 files, the no-Chromium board,
> `pnpm preflight`, the conformance stability line — is still the 2026-08-28
> measurement and was **not** re-run, so read it as dated rather than as current. Nothing was
> weakened, skipped or deleted to move the number; the three members that grew are named below.

> **ANNOTATED ON 2026-08-30, AFTER THE SEMANTIC-DENIAL / WRITE-BOUNDARY EVIDENCE PASS.** A forced
> credentials-unset run
> (`env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN
> TURBO_FORCE=1 pnpm test`) exited 0 with **2,032 tests / 109 files / 14 of 14 tasks**, `Cached:
> 0/14`. The forced-run ledger below remains the 2026-08-29 measurement and is preserved as history
> rather than silently rewritten. The supplemental-inclusive `pnpm demo` was also run three times
> with credentials unset; each run exited 0 with **241 files** and a clean whole-bundle canary.

---

## 1. The board

```
$ TURBO_FORCE=1 pnpm build                → Tasks: 8 successful, 8 total     Cached 0/8    exit 0
$ TURBO_FORCE=1 pnpm typecheck            → Tasks: 14 successful, 14 total   Cached 0/14   exit 0
$ pnpm lint                               → Checked 317 files in 104ms. No fixes applied.  exit 0

$ env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY \
      -u CLAUDE_CODE_OAUTH_TOKEN TURBO_FORCE=1 pnpm test
                                          → 2,032 passed, 109 files, 14/14 tasks, Cached 0/14
                                            1m32.414s  (re-taken 2026-08-30)               exit 0

$ pnpm demo   (three credential-unset runs)
                                          → 241 files, DEMO OK, whole-bundle canary CLEAN
                                            every time   (re-taken 2026-08-30)             exit 0

$ pnpm preflight        (no key in shell) → NOT READY, 1 blocker, 1 warning, 13 passed      exit 1
$ ANTHROPIC_API_KEY=<shape-valid> pnpm preflight
                                          → 14 check(s) passed, 1 warning
                                            "NO MODEL CALL WAS MADE BY THIS SCRIPT"         exit 0

$ pnpm -F @crr/conformance stability      → 25/25, 0 FALSE SUCCESSES, 9/9 mutants killed,
                                            flake rate 0.0% over 20 runs                    exit 0
```

**Nothing regressed. No test was weakened, skipped or deleted.**

### Per member — the numbers that add up to 2,032

`env -u … TURBO_FORCE=1 pnpm test`, per-member `Tests N passed (N)`. Test-file counts below are
the `*.test.*` files present in each package on 2026-08-30 and add up to the 109 files printed by
the full forced run. The dated notes after the table preserve the earlier moves rather than
rewriting history.

| Member | Tests | Test files | was, 2026-08-29 |
|---|---:|---:|---:|
| `packages/core` | 840 | 38 | 819 / 37 |
| `packages/runtime` | 394 | 24 | 367 / 23 |
| `packages/discovery` | 362 | 16 | 361 / 16 |
| `packages/surface-browser` | 107 | 12 | unchanged |
| `packages/surface-terminal` | 125 | 9 | unchanged |
| `packages/conformance` | 102 | 8 | unchanged |
| `fixtures/corebank-web` | 66 | 1 | unchanged |
| `fixtures/corebank-tui` | 36 | 1 | unchanged |
| **Total** | **2,032** | **109** | superseded / 107 |

The submission brief that opened this pass said "1,843 must still pass." **1,843 is the count from an
earlier revision and it was already stale before this pass began.** Two test files landed since:
`packages/runtime/test/demo-integrity.test.ts` (19 tests) and
`packages/discovery/test/canary-scopes.test.ts` (56 tests), plus 3 source scans added to
`packages/runtime/test/demo-contract.test.ts` (9 → 12). 1,843 + 19 + 56 + 3 = 1,921. Nothing was
removed to get there; every number above is a fresh forced run.

**The same discipline for the 2026-08-29 move from the 1,921-test board.** Sixty-three tests were
added and none removed. Fifty-six of them are the two new files the outcome-promotion pass owes:
`packages/core/test/promotion.test.ts` (**28 passed**, `pnpm -F @crr/core exec vitest run
test/promotion.test.ts`) and `packages/runtime/test/promote.test.ts` (**28 passed**, `pnpm -F
@crr/runtime exec vitest run test/promote.test.ts`) — which is also why the file count moves 105 →
107 and only by two. The remaining seven are spread over existing files in `@crr/core` (+3 beyond
`promotion.test.ts`), `@crr/runtime` (+3 beyond `promote.test.ts`) and `@crr/discovery` (+1); those
seven were **not** attributed to individual files by this pass, so 63 = 56 + 7 is a measured total
with an unattributed remainder rather than a full accounting.

### The board a reviewer with no Chromium gets

```
$ env -u … PLAYWRIGHT_BROWSERS_PATH=<empty dir> TURBO_FORCE=1 pnpm test
    @crr/surface-browser   Tests   78 passed |  29 skipped (107)
    @crr/runtime           Tests  320 passed |  16 skipped (336)
    @crr/conformance       Tests  101 passed |   1 skipped (102)
    (the other five members unchanged)             Tasks: 14 successful, 14 total    exit 0
```

**1,875 passing, 46 skipped, green.** *(2026-08-28 figures, and the pass totals are stale — the
members grew on 2026-08-29, so `336` should read `367`. What the 2026-08-29 re-run does establish is
that **the skips did not move**: `@crr/surface-browser` `78 passed | 29 skipped (107)`,
`@crr/runtime` `16 skipped (367)`, `@crr/conformance` `101 passed | 1 skipped (102)` — still 46, all
still the Chromium guard. It is **not** re-certified green: that run exited 1 on a stray scratch
module left in `packages/runtime/src/` by the pass itself, which failed three
`packages/runtime/test/barrel.test.ts` assertions — that test doing its job, not a regression. This
block is recorded as unsettled rather than repaired on paper; re-run it once the tree is clean.)*
All 46 are the Chromium guard
(`const describeBrowser = CHROMIUM ? describe : describe.skip`, `describe.skipIf(!chromiumAvailable())`).
`grep -rn 'it\.skip\|test\.skip\|describe\.skip\|\.todo(' packages/*/test fixtures/*/test` returns
**14** lines and every one is that guard. There is no unconditional skip and no `.todo`.

**A green board without a browser is the trap in this repository**, and it is why the README's setup
section says `pnpm -F @crr/surface-browser exec playwright install chromium` is not optional.

---

## 2. `pnpm demo` — three runs, one file count

```
run 1: exit=0  files=241  whole-bundle canary CLEAN   DEMO OK
run 2: exit=0  files=241  whole-bundle canary CLEAN   DEMO OK
run 3: exit=0  files=241  whole-bundle canary CLEAN   DEMO OK
```

Commands: `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY -u
CLAUDE_CODE_OAUTH_TOKEN pnpm demo`. Byte totals were not re-quoted on 2026-08-30; the file count
and canary verdict are the measured submission signals.

**The file count is exact; the byte total is not, and the difference is the honest part.** Normalising
the digest in every content-addressed blob name, the three runs produce a **byte-identical file
list**. The digests themselves move every run by construction — a journal blob is named by the digest
of a journal carrying that run's own timestamps — and `demo.log` is inside the bundle and prints its
own wall-clock duration. So: **quote the count, re-measure the bytes.** The count is not narrated any
more; the run compares its printed count against an independent walk of the finished directory and
against the whole-bundle canary's own count, and a disagreement fails the run.

Each run also prints, and gates on:

```
── integrity ─ every content-addressed blob directory against the run that owns it
   7 blob directories checked, every file accounted for
── discovery-live ─ a live run is present; PENDING.md not written
REDACTION CANARY  CLEAN   3 value(s) x 14 encodings = 26 needles, self-test 26/26, 0 hits, 0 credentials
   whole-bundle canary pass: CLEAN - 241 files, 0 hits
DEMO OK
```

`git status` after a demo shows six or seven deleted and the same number of added blob paths under
`<scenario>/observations/`. **That is the expected churn, not a defect** — see FINAL-STATUS §9, which reproduces both of the
defects that used to make the *count* move and shows the lock and the audit that fixed them.

---

## 3. The README's demo path, run from this tree

Every command in README "The demo path" §1 was executed against the freshly generated bundle. The
outputs reproduce, including the exit codes, which are the point:

| Command | Observed | Exit |
|---|---|---:|
| `crr replay … --args '{"memberId":"10041"}'` | `OK … 9/9 steps`, `ALVAREZ, DANA (SYNTHETIC)`, `1204.55`, `ACTIVE` | **0** |
| same, `"memberId":"19999"` | `OUTCOME … 2/9 steps`, `outcome MEMBER_NOT_FOUND` + caller guidance | **2** |
| same, `"memberId":"10047"` (closed account) | `FAILED … 6/9 steps`, `output-extraction-failed at read-share-accounts` | **1** |
| same, `"memberId":"10046"` (restricted) | `OK … 9/9 steps`, `accountStatus: "RESTRICTED"` | **0** |

Exit `0` / `2` / `1` are `ok` / declared business outcome / everything else, so a shell script can
tell them apart. None of these four runs wrote anything into `evidence/` — the CLI writes a journal
only when given `--journal`, and the bundle count stayed unchanged across all four.

The four "requirements `pnpm demo` does not exhibit" commands in README §3 all reproduce their
counts, read off the forced test run: `escalation.test.ts` **31**, `browser-overlay.test.ts` **4**,
`heterogeneity.test.ts` **14**, `browser-write.test.ts` **10**. So do the others the README quotes:
`terminal-conformance.test.ts` **10**, `loop-failure.test.ts` **18**, `canary-scopes.test.ts` **56**,
and the three core contract tests **15 + 14 + 15 = 44**.

### The kill matrix, verbatim

```
$ pnpm -F @crr/conformance stability
25 scenarios: 25 passed, 0 failed, 0 FALSE SUCCESSES
kill matrix: 9 mutants x 25 scenarios
mutant            killed by                          of which false successes
firstMatch        16,17                              17
countQuorum       17                                 17
noAssert          18                                 -
noSettleGate      13                                 13
checkpointFirst   02,03,05                           05
noContinuity      21                                 21
noDelta           20                                 20
nearestMatch      04,06,08,09,15,21                  04,06,08,09,15,21
noProvenance      04                                 04
every mutant was killed by at least one scenario
25 scenarios x 20 runs: flake rate 0.0%, 0 with a result document that was not byte-identical
```

**17 kills, 13 of them false successes**, counted off that table by hand — which is the split
`/REPORT.md` and `/README.md` both quote. Eight of the nine mutants are caught by at least one false
success; only `noAssert` is caught purely by a misclassification.

---

## 4. Submission hygiene

```
$ git check-ignore -q .env .private .private/ASSIGNMENT.txt .private/BRIEF.md .scratch
                                                                      → all IGNORED
$ git ls-files -z | xargs -0 grep -lE 'sk-ant-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}'
                                                                      → (no output)
$ git ls-files | grep -c DS_Store                                     → 0
$ git ls-files | grep '^\.env'                                        → .env.example  (only)
$ git ls-files | wc -l                                                → 448
$ git ls-files evidence | wc -l                                       → 65
$ git ls-files README.md REPORT.md | wc -l                            → 2
```

**No stray or temporary file would be committed.** The untracked list is eleven or twelve paths
depending on how many blob digests the last demo happened to move, and every one is intended:

- **Four new source files**, all of them the work this pass and the two before it did, all lint-clean
  and all covered by tests: `packages/discovery/tools/canaries.ts`,
  `packages/discovery/test/canary-scopes.test.ts`, `packages/runtime/demo/integrity.ts`,
  `packages/runtime/test/demo-integrity.test.ts`. **These must be `git add`ed** — without them the
  suite does not build the board above.
- **This document**, `docs/design/SUBMISSION-READY.md`.
- **Six or seven `evidence/**/observations/journal-*.json` / `obs-*.json` blobs**, matched one for
  one by deletions of the previous run's blobs. That is the demo churn described in §2; the number
  moves because an `obs-*` blob whose digest happens to match the committed one is not rewritten.

`.scratch/` (107 working files), `packages/core/.scratch/`, `.turbo/`, `dist/`, `node_modules/` and
five `.DS_Store` files are on disk and all gitignored — `git check-ignore` confirms each. Nothing under
them is read by a test, a lint or a contract scan. Removing them is cosmetic; leaving them cannot
affect what a reviewer clones.

**A reviewer clones and runs, with no credentials:** `pnpm install` →
`pnpm -F @crr/surface-browser exec playwright install chromium` → `pnpm demo`. That path was executed
in this tree, four times, and exits 0 every time. `pnpm test` with all four credential variables
unset exits 0 and no provider SDK is in the demo's import graph —
`packages/runtime/test/demo-contract.test.ts` fails if one ever is.

---

## 5. What changed in this pass, and why

**Two code fixes.** Both are behaviour-preserving and both were driven by something a reviewer would
hit.

1. **`packages/discovery/src/synthesis/prose.ts` held a literal NUL byte** at offset 7253, inside a
   template string used as a `Set` key separator (`` `${output.outputName}\0${text.toLowerCase()}` ``).
   The intent — an unambiguous separator — is fine; writing it as a raw byte rather than an escape is
   not. **It was the only file in the repository containing a NUL**, and the consequence is that
   `git diff` printed `Bin 12503 -> 12504 bytes` / *"Binary files differ"* for it, `git grep` and
   `grep -r` reported *"Binary file … matches"* and returned no lines, and the file rendered as binary
   on a host. Replaced with the `\u0000` escape: identical runtime string, and `git grep` now reads
   the file. Verified with a fresh full test run.
2. **`packages/runtime/demo/main.ts` generated three claims that stopped being true when the live run
   landed.** They are generated, so they had to be fixed at the generator and the bundle
   regenerated — which is why `evidence/README.md` and `evidence/artifact/README.md` are modified.
   - *"Every file in this directory was produced by `pnpm demo`"* — false; `discovery-live/` was not.
     Now a `liveRunPresent()` branch that names the exception.
   - *"When the live discovery run happens, the artifact that synthesis emits replaces it and this
     paragraph goes away."* The run happened and it did not replace it, deliberately: a synthesized
     artifact is the **output** of a run and moves whenever the run is repeated, and the suite that
     polices this bundle needs an input it can pin. The paragraph now says that, and points at the
     two synthesized artifacts that do exist — `discovery-live/synthesized/artifact.json`, replayed
     by the run itself at `verification.json`, and the frozen
     `packages/discovery/test/fixtures/corebank-web.capability.json`, which
     `packages/runtime/test/synthesized-replay.test.ts` reads off disk and replays on every
     `pnpm test`.
   - `evidence/artifact/README.md` linked `../discovery-live/PENDING.md`, which the live run deleted.
     Now branched. **Every relative link in every shipped markdown file was checked and resolves.**

The same stale prediction was in `packages/runtime/test/fixtures/corebank.ts`'s header comment
(*"when they land, the artifact they emit replaces this file"*) and is corrected there with the
reason it did not.

**Documents brought in line with the tree** (each of these was a sentence the code makes false):

| File | What was false | Now |
|---|---|---|
| `README.md` | `MIN_NEEDLE_LENGTH = 8` "in `tools/discover.ts`" | it lives in `tools/canaries.ts:191`; both floor paths are now fully qualified |
| `README.md` | the `pnpm discover --dry-run` blurb said "all **four** redaction canary passes" | five; the committed live bundle is the one that has four, and the row says so |
| `README.md` | both `pnpm preflight` transcripts omitted the warning the live run makes permanent | both re-run and re-transcribed, warning included |
| `README.md` | the `pnpm demo` sample block dropped the `discovery-live` line | restored; the elision note now covers what is actually elided |
| `REPORT.md` | 3,211 words after two prior passes added to §6 and §7 | trimmed to **2,938** (`wc -w`), **2,688** excluding the claims table and the one code block. Seven `##` headings, in order, verified |
| `FINAL-STATUS` §1 | the lint blockquote still said "318 → 313" beside a code block reading 317 | says 318 → 313 → **317**, and names the four files that came back |
| `FINAL-STATUS` §2 | `fixtures/corebank-web` "8 injectable faults" | **10**, read out of `FAULT_IDS` |
| `FINAL-STATUS` §6, §8 | `demo-contract.test.ts` "(9 tests)" | **12** |
| `FINAL-STATUS` §6, §10 | a fixed byte total for the bundle | re-measured, with the reason it is not a fixed number |
| `FINAL-STATUS` §7.3 | *"they should be the same number"* | superseded by measurement — see §6 below. Also the stale constant path |
| `FINAL-STATUS` §9 | a three-entry `git log` | both logs, then and now |
| `FINAL-STATUS` §10 | *"Only two of them are committed … `/README.md` — PRESENT, and UNTRACKED"* | contradicted its own §9. All three are committed, verified with `git ls-files` |
| `FINAL-STATUS` §11 | a pass-dated ledger read as the current board | banner: it is dated, and the three figures that moved are named with today's values |
| `COMMIT-PLAN.md` | *"Nothing here has been committed"* | **SUPERSEDED** banner naming the two commits that landed and the three stale numbers, without rewriting the draft commit messages, which are a record |
| `LIVE-RUN-READINESS.md` | future tense about a run that happened | banner: the run, its result, and the two board figures that moved |
| `evidence/discovery-live/README.md` | `canary/` described as "all four redaction passes" with no mention of the fifth | a hand-marked section on the fifth pass, by the same convention as the hand-added "Two digests" section already in that file. **No member datum was added**, checked by grep |

---

## 6. Limitations that are still true

Nothing below was closed by this pass. This list is the same as `/REPORT.md` §7 and `/README.md`
"Limitations"; it is repeated here so the author can read it once more before sending.

- **The target application is the author's own fixture.** The single largest threat to every
  robustness number in the repository, and no scenario count fixes it. A 0.0% flake rate over a
  corpus you wrote bounds hidden state in the engine, not flake in production.
- **One live discovery run.** Nine turns, one goal, one tenant, one model, one surface. No live model
  has ever been refused by the policy gate, got stuck, or raised an intervention — those paths have
  hermetic tests and the conformance corpus only.
- **No OpenAI run.** Provider independence is a claim about the port, tested at the port, not a
  measured second run. The adapter is real and has 26 tests; it is not reachable from the CLI.
- **The spend cap has never bound mid-run**, only at the turn-0 boundary. `stopBeforeTurn` has no
  unit test and is reachable only through `pnpm discover`.
- **`pnpm preflight` has no automated test.** It is exercised by hand; both transcripts in the README
  are hand runs, re-taken this pass.
- **The gating canary's needle floor is 8; synthesis's is 4.** A five-, six- or seven-character
  observed value in a document synthesis failed to scrub would ship CLEAN. **What changed is that the
  fix is now known not to be "one number."** Re-running the five passes over the live bundle at a
  floor of 4 fails the *gating* document pass with 4 hits, every one the string
  `MEMBER_FOUND_ACTIVE` — the symbolic outcome code the synthesis report deliberately keeps and flags
  at `review` severity, because an observed value cannot be substituted into a code and leave a legal
  code. Checkable by hand without re-running anything:
  `grep -c MEMBER_FOUND_ACTIVE evidence/discovery-live/synthesized/report.json` → **4**, and
  `grep -rno ACTIVE evidence/discovery-live/synthesized/ | wc -l` → **4**, so those four hits are the
  only occurrences of the value anywhere under `synthesized/`. Both were re-verified this pass. The
  real fix is exempting a `SCREAMING_SNAKE` token the report already flagged, then dropping the floor.
- **The canary's own report republishes what it quoted.** `evidence/discovery-live/canary/report.txt`
  prints the member's name and balance in five context excerpts, because the recording pass blanks
  only the values *it* searches for and it searches for the caller's argument alone. Verified this
  pass: `grep -c "CHEN" evidence/discovery-live/canary/report.txt` → **5**. Every byte is a quotation
  of `transcript.json`, where the row legitimately lives, so nothing new reaches the bundle and no
  control was bypassed — what is violated is the rule that file states about itself, in the one
  document a reviewer reads to decide whether to trust the other passes. The fix needs a blank-list
  separate from the needle-list, which means re-emitting the committed reports, which means another
  live run.
- **The live bundle names two content addresses for one artifact.** `verification` is not on
  `ARTIFACT_DIGEST_EXCLUDED_FIELDS`, so the shipped `synthesized/artifact.json` digests to
  `32e56a6f…` while the run log says `923ab02f…`. Self-consistent, and an approval signs the stable
  one, but the shipped address is not reproducible from the recording. The one-line fix moves every
  committed digest and was not made.
- **`contract.outcomes` on the live artifact is `[]`.** Synthesis will not invent a detector for a
  screen the run never observed. The shipped capability from that run is thinner than the committed
  hand-authored one, on purpose.
- **Four of nine mutants survive the green-screen corpus** (`noAssert`, `noSettleGate`,
  `noContinuity`, `noProvenance`), each with a written reason asserted in both directions by the
  test. That is a result about the surface, not a hole in the effort.
- **No branching in the artifact language**, and no `resume: "continue"`. Conformance scenario 25
  pins the wrong behaviour deliberately.
- **External approval custody is not implemented.** Artifact approval remains the lifecycle digest
  receipt; invocation approval is richer and runtime-enforced with expiry, signer authority, request
  binding and revocation checks. KMS/HSM custody and key administration remain deployment seams.
- **The operator console is bare and polls rather than streams.** The lease and both enforcement
  points are real.
- **Desktop (AX/UIA) is a documented seam, not code.**
- **"One artifact, two tenants" is proved; "one contract, two surfaces" is not.**
- **No concurrency story.**
- **The frozen-observation blobs do not deduplicate across browser sessions.** Five runs produced
  four digests for one app-error screen, differing only in a CDP AX node id. `evidence.ts`'s header
  claims the opposite benefit and now says so at the site. Within one session they do dedupe.

---

## 7. What this pass did **not** run, and why

**`pnpm discover` in any form — including `--dry-run`.** `.private/BRIEF.md` §11 and this pass's own
brief both forbid it flatly. Two consequences the author should know before sending:

- The `pnpm discover --dry-run` verdict block in `README.md` "The demo path" §2, and the
  `pnpm discover --dry-run --force --max-usd 0.02` → `budget-exhausted` transcript in the verdict
  table, **were not re-run by this pass.** They were recorded by an earlier pass and are unchanged.
- The fifth canary pass runs on the dry-run path too. Its scopes are asserted by
  `packages/discovery/test/canary-scopes.test.ts` (56 tests, green), which reads
  `evidence/discovery-live` off disk and plants a needle to prove the pass can fail — but **no
  end-to-end dry run has been executed since that pass was added.** If the author wants that
  confirmed before sending, `pnpm discover --dry-run --force` is the free command that does it, and
  it is the author's to run.

**The injection experiments described in FINAL-STATUS §§4–7** — the mutant-deletion meta-test, the
four-way dialog matrix, the three heterogeneity injections, the `stableSamples` revert, and the
two-concurrent-demo reproduction — were not re-performed. Each is recorded at its own site with the
pass that ran it. The *tests* that police them all ran green in the board above.

**The four committed reports in `evidence/discovery-live/canary/` were not re-emitted.** Re-emitting
them requires another live run. They correctly describe the four-pass run that produced them, and
that directory's `README.md` now says so and points at the fifth pass.

**`tools/bundle.ts`'s README generator now emits five-pass text.** A future live run's bundle README
will therefore differ from the committed one. That is the honest state; regenerating it would require
a live run.

---

## 8. What this project does and does not demonstrate

**It demonstrates the whole cycle, once, end to end, with a real model at the start of it.** A model
was called over the Anthropic Messages API, drove a hostile legacy fixture through the accessibility
tree for nine turns, and reached the goal for **$0.140904**. Deterministic synthesis turned that
recording into a typed, parameterized, content-addressed capability offering a calling agent an
argument named `memberId`. That artifact **replayed itself with no model in the decision path** —
three descriptor sets agreeing on every target, four checkpoints holding, three policy decisions
granted, the caller's argument reaching the surface as `taint:memberId-1` with a length and no
value — and only then became a `draft`. **The promotion is the result of a replay, not a field
somebody set.**

**It demonstrates that the replay engine can be told apart from a broken one.** Nine deliberately
weakened engines — the real `replay()` with exactly one pure decision function swapped, enforced by
function identity — are all killed by the combined corpus, with zero false successes for the
reference engine and a meta-test that fails when the suite stops discriminating.

**It demonstrates that the `Surface` port is not browser-shaped**, because a second driver over an
80×24 character grid was built and one artifact drives both tenants of it.

**It does not demonstrate any of this on an application the author did not write.** The fixture is
ours, the faults are the ones we thought to inject, and the flake rate is measured against a clock we
control. The provider is the one component in the loop that was not ours, and it broke the run twice
before it worked — which is the best available evidence for how much a real surface would find.

**It does not demonstrate that a model can discover this flow reliably.** One run is not a sample.

**It does not demonstrate production operations.** No concurrency story, no key custody, no desktop
driver, no second provider run.

---

## 9. Before you press send

```bash
git add packages/discovery/tools/canaries.ts \
        packages/discovery/test/canary-scopes.test.ts \
        packages/runtime/demo/integrity.ts \
        packages/runtime/test/demo-integrity.test.ts \
        docs/design/SUBMISSION-READY.md
git add -A evidence
git status --short          # nothing left but what you meant to commit

env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY \
    -u CLAUDE_CODE_OAUTH_TOKEN TURBO_FORCE=1 pnpm test   # 2,032, exit 0
pnpm demo                                                # 241 files, DEMO OK, exit 0
```

Run `pnpm demo` **once, alone**, immediately before committing — a second concurrent run now refuses
to start rather than corrupting the bundle, but the blob digests still move, so the last run before
the commit should be the one whose blobs are in it.

**Do not run `pnpm discover` in any form while preparing the push.** The live run is done and
committed, `.env` in this tree holds live funded credentials, and `loadDotEnv` restores them over an
`env -u` prefix.

Optional, and the author's call: `docs/design/COMMIT-PLAN.md` is a superseded planning document whose
own §6 says *"nothing references it"* and offers `rm`. It now carries a banner naming what is stale in
it. Delete it or ship it, but do not ship it unbannered.
