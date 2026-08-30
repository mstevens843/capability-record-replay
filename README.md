# capability-record-replay

**An LLM works out how to do a job in a legacy back-office application once. That run is recorded as
a typed, versioned, parameterized capability. From then on the capability replays with no model in
the decision path, and an AI agent invokes it by name with typed arguments.**

The target environment is the long tail of core-banking screens, servicing tools and admin consoles
at US banks and credit unions that expose no API at all — server-rendered framesets, nested layout
tables, generated element ids, no test ids, and a green-screen teller app behind some of them. The
UI is stable; the *runtime* is not. A capability that only works on the happy path is useless there,
so the load-bearing part of this system is not the step list — it is the declared mapping from what
the screen shows to what the caller is told: `MEMBER_NOT_FOUND` is a **typed answer**, a maintenance
interstitial is a **bounded remedy**, and an application error page is a **stop** that names the
step, the expectation and the observation. The design write-up is [REPORT.md](./REPORT.md); this
file is how to run it.

---

> [!WARNING]
> **What is not proven, first.**
>
> - **Every robustness number in this repository was measured against a fixture I wrote myself.**
>   `fixtures/corebank-web` and `fixtures/corebank-tui` are deliberately hostile, but they are mine,
>   and a fixture you control cannot surprise you the way a real vendor app does. Zero flake over
>   20 runs bounds hidden state in the engine; it is not a reliability claim about production.
> - **One live discovery run, one goal, one application, one model.** Nine turns and $0.14. It is
>   real and its full recording is committed — it is not a sample size.
> - **Four of the nine mutant replay engines survive the green-screen corpus**, each for a reason
>   that is a property of that surface and is written down in the test. The 25-scenario browser
>   corpus kills all nine on its own; the 14-scenario green-screen corpus kills five.
> - **The green board is not the same as done.** [REPORT.md §7](./REPORT.md) is the cut list and
>   `docs/design/FINAL-STATUS.md` is the long-form internal version, including limits named at their
>   own call sites.

---

## Verdict table

Every row carries the command that produced it. Nothing here is asserted from memory. **No command
in this table contacts a model**; the `pnpm test`, `pnpm demo`, `stability` and `pnpm discover
--dry-run` rows were run with `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY -u
CLAUDE_CODE_OAUTH_TOKEN` prefixed, to prove it structurally rather than by inspection.

| Claim | Verdict | Command / receipt |
| --- | --- | --- |
| **A model really drove a real UI to a goal.** `claude-opus-5`, adapter `anthropic`, 9 turns, `reached-goal`, **42,368 billed tokens**, **$0.140904** | **measured, once** | `cat evidence/discovery-live/provenance.json` · full transcript in `evidence/discovery-live/transcript.json` |
| **The 55.4% cache hit rate on that run is a warm-start figure, not a cold-start one.** All nine turns report `cacheCreationInputTokens: 0` and read a 2,512-token prefix, so the prefix was already warm from the attempt before it. A first run would show a lower rate and a cache-write charge | **measured, and flattered — read it as an upper bound** | `python3 -c "import json;[print(t['response']['usage']) for t in json.load(open('evidence/discovery-live/transcript.json'))['turns']]"` |
| **The artifact synthesized from that run replayed with the model out of the decision loop**, graded `full`, and only then became a `draft` | **measured** | `cat evidence/discovery-live/verification.json` → `"modelInTheLoop": false`, `"status": "verified"`, `"grade": "full"` |
| **Replay separates `ok` / business outcome / recoverable / hard failure with zero false successes**, and **9 of 9 deliberately weakened engines are killed** — 17 kills, **13 of them false successes** | **measured** | `pnpm -F @crr/conformance stability` → `25 scenarios: 25 passed, 0 failed, 0 FALSE SUCCESSES`, `every mutant was killed by at least one scenario`, exit 0 |
| **The fallback-chain mutant (`nearestMatch`) is killed by 6 scenarios and every one is a false success** — the mutant told a caller a business outcome for a broken run | **measured** | same command, kill-matrix row `nearestMatch  04,06,08,09,15,21` |
| **Replay is deterministic over the corpus**: 25 scenarios × 20 runs, flake rate 0.0%, 0 result documents that were not byte-identical | **measured, on a fixture I wrote** | same command |
| **4 of 9 mutants survive the terminal corpus** (`noAssert`, `noSettleGate`, `noContinuity`, `noProvenance`), each with a written reason asserted by the test | **limitation, reported not hidden** | `pnpm -F @crr/conformance exec vitest run test/terminal-conformance.test.ts` → 10 passed |
| **The whole repository builds and tests with zero credentials.** 2,027 tests, 8 workspace members | **measured** | `env -u … pnpm test` → `Tasks: 14 successful, 14 total`, exit 0 |
| **`pnpm demo` produces the entire evidence bundle with no live service**, all three arms of the taxonomy exhibited, redaction canary clean on both passes | **measured** | `env -u … pnpm demo` → seven `PASS` lines, `whole-bundle canary pass: CLEAN - 144 files, 0 hits`, `DEMO OK`, exit 0 |
| **The bundle `pnpm demo` produces is the same bundle every time**: three consecutive runs, 144 files each, the same paths once content-address digests are normalized. The count is no longer narrated — the run compares it against an independent walk of the finished directory, and fails on any blob no run in the bundle claims | **measured, verified by injection** | `env -u … pnpm demo` ×3 → `144 files`, `7 blob directories checked, every file accounted for`, `DEMO OK`, exit 0; planting one stray blob gives `BUNDLE INTEGRITY FAILED - 2 stray blob(s)`, `DEMO FAILED`, exit 1 |
| **The engine cannot read a clock, do I/O, or import a driver, and no package above the drivers contains CSS vocabulary** — read off disk, not asserted | **measured, verified by injection** | `pnpm -F @crr/core exec vitest run test/purity.test.ts test/no-locator-vocabulary.test.ts test/policy-chokepoint.test.ts` → 44 passed |
| **The spend cap stops a run before it starts. It has never bound *mid-run*.** The between-turns guard fires on the projection, demonstrated free at the turn-0 boundary; it has no unit test and no run has ever crossed it at turn *n* | **partially proven** | `pnpm discover --dry-run --force --max-usd 0.02` → `status budget-exhausted`, `$0.0000 has been billed and turn 1 projects to at most $0.06 … which would cross the $0.02 ceiling`, exit 1 |
| **Every file in the live bundle is covered by a gating canary pass, and the files that describe the run rather than record it are grepped for member data.** A fifth gating pass (`5 metadata`) takes its scope as the complement of the other four, so `provenance.json`, `spend.json` and the bundle README are covered and a file added later is covered by default | **measured, verified by injection** | `pnpm -F @crr/discovery exec vitest run test/canary-scopes.test.ts` → 56 passed; injecting the pre-fix `finish.summary` into a copy of `provenance.json` fails the pass naming the file and both needles, and restoring the bytes passes it |
| **`contract.outcomes` on the live artifact is `[]`.** Synthesis will not invent a detector for a screen the run never observed, so the model's proposed outcome rides in the report as a review item instead | **deliberate, and a real gap in the shipped capability** | `python3 -c "import json;print(json.load(open('evidence/discovery-live/synthesized/contract.json'))['outcomes'])"` |

---

## Quickstart

Node 22 (`engines: >=20 <25`), pnpm 10. Verified on `node v22.22.1` / `pnpm 10.33.0`.

```bash
pnpm install
pnpm -F @crr/surface-browser exec playwright install chromium   # once — see the note below
pnpm demo
```

On a cold clone `pnpm install` prints four `WARN Failed to create bin … ENOENT …
packages/runtime/dist/cli.js` lines. They are expected and harmless: `@crr/runtime` declares two
bins (`crr`, `crr-codegen`) that point at build output which does not exist until `pnpm build` runs,
and `pnpm demo` builds it. Nothing in this README invokes them by name.

**`pnpm demo` needs no API key, no `.env`, and no network beyond loopback.** It builds
`@crr/runtime`, starts `fixtures/corebank-web` on an ephemeral loopback port, drives it with a local
Chromium, and rewrites the whole of [`evidence/`](./evidence) (except the live discovery run, which
it never touches). It exits non-zero if any scenario misses its declared arm, if the redaction canary
finds a parameter value anywhere in the bundle, or if the finished bundle holds a content-addressed
blob that no run in it claims to have written. About ten seconds after the build.

**Run it once at a time.** Two concurrent runs used to interleave and leave both runs' blobs behind,
in a bundle that then described neither; the second one now refuses to start and says which pid holds
the lock.

```text
   PASS  replay-01-green                    ok        green
   PASS  replay-02-outcome-member-not-found outcome   expected business outcome
   PASS  replay-03-recovered-interstitial   ok        recoverable condition
   PASS  replay-04-failed-app-error         failed    hard failure
   PASS  replay-05-failed-session-expired   failed    hard failure
   PASS  masked-capture                     3 region(s) blanked
   PASS  cli-replay                         exit 0

REDACTION CANARY  CLEAN
  hits          0
  suppressed    0 (inside a digest-shaped hex run)
  credentials   0

   144 files in the bundle, produced in 10s
   discovery-live/  a LIVE model run is present - see its own README.md and provenance.json
   whole-bundle canary pass: CLEAN - 144 files, 0 hits
DEMO OK
```

(The canary block's `scanned` / `searched for` / `self-test` / `not searched` lines are elided, as
are two lines about where the second canary pass runs; every line above is verbatim except the
wall-clock duration, which varies.)

### About Chromium

`playwright` is a dependency of the packages that need it, not of the workspace root, so the install
command is scoped:

```bash
pnpm -F @crr/surface-browser exec playwright install chromium
```

From the repo root, `pnpm exec playwright …` fails with `Command "playwright" not found` and
`npx playwright …` fails with `sh: playwright: command not found`. Use the scoped form above.

**Without a Chromium build the test suite is still green, and that is a trap worth naming.** In the
2026-08-29 measurement, 46 of the then-1,984 tests skipped — including every test that had ever
touched a real browser — and each guard printed a warning to stderr, but the board read green:

```text
$ env -u … PLAYWRIGHT_BROWSERS_PATH=<an empty dir> pnpm test
    @crr/surface-browser   Tests   78 passed |  29 skipped (107)
    @crr/runtime           Tests  320 passed |  16 skipped (336)
    @crr/conformance       Tests  101 passed |   1 skipped (102)
    Tasks: 14 successful, 14 total                                exit 0
```

1,875 passing, green, and the browser replays never ran. Install Chromium. This no-Chromium board
was not re-run in the 2026-08-30 write-boundary pass.

---

## The demo path

### 1. Replay a capability — no model, no key, no credentials

This is the production path. `pnpm demo` leaves a signed, approved capability in
[`evidence/artifact/`](./evidence/artifact); replay it yourself with the shipped CLI:

```bash
node packages/runtime/dist/cli.js replay \
  evidence/artifact/contract.json evidence/artifact/artifact.json \
  --surface packages/runtime/demo/surface-entry.mjs \
  --args '{"memberId":"10041"}' \
  --allowlist evidence/artifact/allowlist.json \
  --trusted-key ops-approval-key-1:evidence/artifact/approver.spki.pem \
  --tenant riverbend --app riverbend-corebank-fixture
```

```text
OK  run run-65efdee2-…  9/9 steps  1776ms
{
  "memberName": "ALVAREZ, DANA (SYNTHETIC)",
  "shareBalance": { "amount": "1204.55", "currency": "USD" },
  "accountStatus": "ACTIVE",
  "shareAccounts": [ { "Acct": "0001", "Share Account": "Share Account - Regular", … } ]
}
exit 0
```

Now run the **same command** with one argument changed to a member the core does not hold —
`--args '{"memberId":"19999"}'` — and nothing else touched:

```text
OUTCOME  run run-f4763909-…  2/9 steps  513ms
  outcome  MEMBER_NOT_FOUND
  guidance Tell the member that number is not on file and ask them to read it again from their
           card or statement. Do not guess a different number on their behalf.
exit 2
```

**Exit `2` is the point of the whole system.** That is not an error. It is a typed business outcome
the calling agent is expected to act on, and it is reported as one — the run stopped at step 2 of 9,
nothing else was attempted, and the caller got prose it can say out loud. `0` is `ok`, `2` is a
declared business outcome, `1` is anything else; a shell script has to be able to tell those apart.

`10041` through `10046` all return `ok` with that member's own outputs. **`10047` does not, and it
is worth thirty seconds.** It is the CLOSED account the fixture holds so the classifier has a
closed-account screen to look at, and the shipped `contract.json` declares exactly one outcome,
`MEMBER_NOT_FOUND`. There is no declared detector for "closed", so replay refuses to invent one and
stops:

```text
FAILED  run run-fd5f7989-…  6/9 steps  1254ms
  failure      output-extraction-failed at read-share-accounts
  side effects possible
  expected     every declared output can be read and typed from the screen the checkpoint verified (shareAccounts: missing-column - Share Account in row 1)
  do this      A required output could not be read or parsed; there is no partial success.
exit 1
```

That is fail-closed working, not a bug: a capability that guessed `MEMBER_NOT_FOUND` from a screen it
had never been taught would be the single worst failure mode in this system (REPORT §3). `10046` is
RESTRICTED and still returns `ok`, because the record-scoped denial the fixture can produce is
likewise not in this artifact's declared outcome set. Both are the same rule as the verdict-table row
about the live artifact's empty `contract.outcomes`: an outcome exists only where a person declared a
detector for it, and the shipped hand-authored contract declares exactly one. `side effects possible`
on a READ capability is the `effect`-is-declared-never-proven limit in REPORT §6, surfacing exactly
where it should.

All fixture data is synthetic and marked `(SYNTHETIC)` on the screens themselves.

`--surface` takes a **module path**, not a fixed set of values: `@crr/runtime` imports no driver
anywhere in `src/`, and a contract test in `@crr/core` fails if it ever does, so a green-screen
factory drops into that flag unchanged.

### 2. Run the agent on a goal — free, with the model's turns served from a VCR recording

```bash
pnpm discover --dry-run
```

This is the entire runner: the observe → decide → act loop, the policy chokepoint on every tool
call, deterministic synthesis, the verification replay with the model out of the loop, and all five
redaction canary passes (the committed live run predates the fifth — see the verdict table). The only substitution is the provider — turns come from a recorded
transcript instead of the Messages API. **`createAnthropicModel` is never constructed on this path,
so no key is used and `$0.0000` is spent.** (`pnpm discover` loads `.env` in either mode and prints
the variable *names* it set; in `--dry-run` nothing consumes them.) Output lands in
`.scratch/discovery-dry-run/`, never in `evidence/` — `assertRealRecording` refuses to write a
synthetic transcript there even if you point `--out` at it.

```text
── VERDICT ──
      discovery reached the goal    yes
      it replayed without a model   yes
      the artifact is a draft       yes
      the bundle is clean           yes
      measured spend                $0.0000
      THIS WAS A REHEARSAL. No provider was called…
exit 0
```

A re-run needs `--force`: the runner refuses to overwrite an existing transcript, because a live
transcript is the one file in this repository that cannot be regenerated for free.

### 3. The parts `pnpm demo` does not exhibit

Four core requirements are real but not in the bundle. `pnpm demo` keeps to one surface, one tenant
and one READ capability on purpose — and the write flow specifically stays out because an
irreversible capability's arguments include an amount the application prints back on its own
confirmation screen, and the canary greps every byte of `evidence/` for parameter values. Loosening
the canary to publish a nicer exhibit is the wrong trade. They have commands instead, and all four
run green right now:

| Requirement | Command | Result |
| --- | --- | ---: |
| **Escalation & handoff** — detect stuck, raise an intervention with context, transfer the live session under a lease the executor enforces, re-verify on hand-back | `pnpm -F @crr/runtime exec vitest run test/escalation.test.ts` | 31 passed |
| **Multi-tenant reuse** — *one* artifact replayed green against two tenant variants of the same vendor product through a vocabulary overlay, with a cross-tenant divergence report | `pnpm -F @crr/runtime exec vitest run test/browser-overlay.test.ts` | 4 passed |
| **Heterogeneity** — the same `activate` step lowered to `F3` on one tenant's green screen and `F12` on the other's, from an artifact that contains no key and no escape byte | `pnpm -F @crr/conformance exec vitest run test/heterogeneity.test.ts` | 14 passed |
| **The irreversible boundary** — a real sub-account opened against the fixture in a real browser, the modal confirmation as the postcondition, committed exactly once; plus a dry run that stops at the boundary and does not perform it | `pnpm -F @crr/runtime exec vitest run test/browser-write.test.ts` | 6 passed |
| **Outcome promotion** — the path from a `needs-detector` review note to a business outcome a caller can act on: a human writes a detector, a pure proof over frozen screens refuses it unless it fires on the outcome screen and is silent on every other one, and the revision has to replay its happy path again | `pnpm -F @crr/core exec vitest run test/promotion.test.ts` · `pnpm -F @crr/runtime exec vitest run test/promote.test.ts` | 28 + 28 passed |

#### Promoting an outcome, in the order a person does it

Synthesis emits `contract.outcomes: []` and refuses to invent a detector — a detector for a screen
the run never observed is exactly how a false `MEMBER_NOT_FOUND` ships. `crr promote` is the other
half: the reviewer writes the detector, and the machine makes them prove it. **Nothing in this path
reaches a model**, and no step of it spends a credential.

```bash
# 1. Freeze the screens. A green run normally freezes NOTHING (`captureOn: ["failure"]`), so the one
#    observation the proof cannot do without is the one nobody has. --capture-every reverses that
#    for one run; it is a runtime option and does not move the artifact's content address.
crr probe contract.json artifact.json --surface ./surface.mjs \
    --args '{"memberId":"00000"}' --evidence evidence/probe-not-found --journal evidence/probe-not-found/journal.jsonl
crr probe contract.json artifact.json --surface ./surface.mjs \
    --args '{"memberId":"10041"}' --evidence evidence/probe-green    --journal evidence/probe-green/journal.jsonl
#    both print a step / phase / content-address table; the positive is one line of reading

# 2. Iterate against the proof, writing nothing. This is where a detector gets fixed, and it costs
#    no session and no document.
crr promote contract.json artifact.json --review promotion.json \
    --corpus evidence/probe-not-found --corpus evidence/probe-green --tenant riverbend --dry-run

# 3. Promote. Emits contract@2.0.0 (MAJOR: an added outcome breaks an exhaustive switch) and
#    artifact@v2 (proposed), and archives the review under its own digest. v1 is left untouched.
crr promote contract.json artifact.json --review promotion.json \
    --corpus evidence/probe-not-found --corpus evidence/probe-green --tenant riverbend --out-dir v2/

# 4. Verify. The SECOND gate, and not a formality: the classifier evaluates declared outcomes BEFORE
#    the checkpoint, so a detector that also matches the successful screen turns every green run into
#    a confident MEMBER_NOT_FOUND. If it hijacks the happy path this fails and v2 stays `proposed`.
crr verify v2/contract.json v2/artifact.json --surface ./surface.mjs --out v2/artifact.json

# 5. Approve. The approver ticks the promoted code by hand, and `approve()` refuses on mismatch in
#    both directions - exactly as it does for the grade and the effect classes.
crr approve v2/artifact.json --sign-key ops-key-1:approver.pem --approver ops-approver-4 \
    --ack-grade full --ack-effects READ --ack-promotions MEMBER_NOT_FOUND
```

**This has now been done for real, against the live run's own artifact**, and the whole walk is in
[`evidence/outcome-promotion/`](./evidence/outcome-promotion): six `crr probe --capture-every` runs
against the browser fixture, a detector a reviewer wrote, a proof that **refused the reviewer's first
attempt**, `contract@2.0.0` + `artifact@2`, the re-verification replay, and the invocation that comes
back `OUTCOME MEMBER_NOT_FOUND` (exit 2) where v1 came back `failed / checkpoint-failed`. Its
`README.md` names a producer for every file — model, reviewer, or deterministic code — and the four
defects the exercise found in this repository's own code. `evidence/artifact/` is untouched and its
outcome is still `origin: "hand-authored"`, which `crr show` and `crr link` print as `UNPROVEN`. See
`REPORT.md` §7 and `docs/design/OUTCOME-PROMOTION.md`.

### 4. Everything else

```bash
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN pnpm test
pnpm -F @crr/conformance stability      # 25 scenarios, the 9-mutant kill matrix, 20-run stability
pnpm typecheck                          # 14/14
pnpm lint                               # biome over the whole tree, no fixes applied
pnpm build                              # 8/8
```

```bash
# The stretch goal: typed caller bindings generated from an approved contract, touching no surface.
mkdir -p .scratch/store/contracts && cp evidence/artifact/contract.json .scratch/store/contracts/
pnpm codegen --store .scratch/store --out .scratch/generated
#   codegen: 2 written, 0 unchanged -> …/.scratch/generated
```

---

## The live discovery run

**It already happened, and the whole recording is committed.** You do not need to repeat it to grade
this submission — read [`evidence/discovery-live/`](./evidence/discovery-live). If you want to
repeat it, it costs about fifteen cents.

| | |
| --- | --- |
| adapter / model | `anthropic` · `claude-opus-5` · effort `high` · `max_tokens` 2000 per turn |
| goal | *"Look up member 10043 in the riverbend core banking back office, report their name, share balance and membership status, and open their member record."* |
| turns | 9, status `reached-goal` |
| usage | 18,220 input · 1,540 output · 22,608 cache-read · **0 cache-write** |
| spend | **$0.140904**, 42,368 billed tokens, against a `--max-usd` cap of $2.00 |
| cache | 55.4% hit rate — **warm-start.** Every turn reports `cacheCreationInputTokens: 0`, so the prefix was populated by the failed attempt before this one. A cold run pays the write and reads a lower rate. |
| outcome | synthesized artifact **replayed with the model out of the loop**, graded `full`, saved as `draft`; canary passes 1–3 clean, pass 4 reported and not gated. The run predates the fifth pass, which was added afterwards and re-run over this bundle: **CLEAN**, 3 files, 27 needles, 0 hits |

`measuredUsd` is this repository's arithmetic over the token counts the provider returned, at the
rates in `packages/discovery/tools/live-run.ts`. It is not an invoice; the provider's console is the
authority.

**It took three attempts, and only one of the two failures was free:**

1. **$0.00.** The provider rejected the tool schema under `strict: true` —
   `Enum value 'Enter' does not match declared type '["string","null"]'`. Valid JSON Schema; a union
   `type` array combined with an `enum` is refused. The request never reached the model. Fixed with
   `anyOf`.
2. **Billed, and this repository cannot say how much.** `ZodError: unrecognized_keys: ["caller"]` —
   we were strict-validating the provider's *response* schema, which we do not own, and a field had
   been added upstream. A parse error on a response means the response existed and was paid for, but
   the ledger only records turns it managed to parse, so **that run's `spend.json` says $0.00 while
   at least one turn had in fact been billed.** The provider's console is the authority on what was
   charged; this repository's arithmetic is not. (It also left the prompt cache warm, which is why
   the successful run's 55.4% hit rate is a warm-start figure.) Validate what you emit; parse what
   you receive.

Both attempts wrote their transcript and spend ledger and exited non-zero, because the durability
path was built before the run.

Neither failed attempt survives in `evidence/`: the successful run wrote over the same destination.
What survives is the property that made them cheap — a run that dies mid-flight still writes its
transcript, its spend ledger and its provenance, and still exits non-zero. That is pinned by
`pnpm -F @crr/discovery exec vitest run test/loop-failure.test.ts` → 18 passed, including *"writes a
transcript with no turns, but with the prompt, when turn 1 itself failed"*.

### To repeat it

```bash
pnpm preflight                # run this FIRST. It makes no model call.
pnpm discover --dry-run       # rehearse the whole runner, free
pnpm discover --yes           # the only command in this repository that spends money
```

**`pnpm preflight` is the thing to run first.** It boots the fixture, builds the exact turn-1
request the runner will send without sending it, prices it on two models, prints the entire policy
allowlist, exercises the chokepoint against an off-allowlist route, and says where the recording
would land. It never constructs `createAnthropicModel`, reads `ANTHROPIC_API_KEY` only to check its
*shape*, and counts tokens locally rather than calling `messages.countTokens`, which would itself be
a request to the provider. **It has no automated test** — it is exercised by hand, and the output
below is a transcript of that, not a fixture. Both halves were re-run after the live discovery run
landed, which is why both now carry the `transcript.json already exists` warning: the recorder will
not silently overwrite a committed run, and it says so before you spend anything.

```text
$ pnpm preflight                                  # with no key in the shell
      NOT READY - 1 blocker(s):
        BLOCK  [credential] ANTHROPIC_API_KEY is not set in this shell.
      1 warning(s) - readable, not fatal:
        warn   [recorder] evidence/discovery-live/transcript.json already exists
               - a run would overwrite it.
      13 check(s) passed.                                                   exit 1

$ ANTHROPIC_API_KEY=<well-formed> pnpm preflight
      1 warning(s) - readable, not fatal:
        warn   [recorder] evidence/discovery-live/transcript.json already exists
               - a run would overwrite it.
      14 check(s) passed.
      [ ok ] the worst a full-budget run on claude-opus-5 can cost is $4.18,
             and --max-usd caps it at $2.00.
      NO MODEL CALL WAS MADE BY THIS SCRIPT.                                exit 0
```

### Keys and configuration

Copy [`.env.example`](./.env.example) to `.env` (gitignored) and set one variable:

```
ANTHROPIC_API_KEY=sk-ant-...
CRR_MODEL=claude-opus-5        # optional; this is the default
```

**`.env` is read by exactly one file in the repository** — `loadDotEnv` in
`packages/discovery/tools/discover.ts`. It is on no barrel, imported by no library module, and it
announces the variable *names* it set and never a value. An already-set shell variable always wins.
Nothing under `packages/` or `fixtures/` loads it. `pnpm preflight` does not read it at all.

`pnpm discover` refuses to run without `--yes`, refuses a `--model` whose price it does not know
rather than running un-budgeted, enforces a cumulative USD cap *between* turns from the usage the
provider returned (projecting the next turn before taking it), and writes the transcript, journal
and spend ledger on every exit path including the failing ones.

### Providers

- **`anthropic` — ships.** A hand-written tool-use loop against the Messages API, not the SDK's
  `toolRunner`: every tool call has to pass the policy chokepoint and be journaled, and
  `disable_parallel_tool_use` is set because a computer-use loop must observe the consequence of one
  action before choosing the next.
- **`openai` — real adapter, 26 tests, not wired to the CLI.** `pnpm discover` is Anthropic-only.
  `createOpenAIModel` throws unless a model id is supplied, on purpose. So "the loop is not
  provider-coupled" is a claim about the port, tested at the port — **not a measured second live run.**
- **`agent-sdk` — a name in the adapter enum with no implementation.** It was considered as a
  zero-marginal-cost development path and dropped: it would run Claude Code's loop rather than ours,
  so it validates none of our prompt shape, tool schemas, observation serialization or stopping
  conditions. Nothing in `evidence/` could have come from it.
- **`replay` (VCR) — how the loop is tested with no key at all.** Every discovery run through any
  adapter records its full transcript; the replay adapter serves it back deterministically. That is
  why `pnpm test` passes with zero credentials and why `pnpm discover --dry-run` exists.

---

## What is in `evidence/`

Start with [`evidence/README.md`](./evidence/README.md) — it is generated by the run that produces
the bundle, and it names which adapter produced every directory.

| Directory | What it is | Model in the loop? |
| --- | --- | --- |
| [`discovery-live/`](./evidence/discovery-live) | The real discovery run: transcript, journal, spend ledger, provenance, the synthesized documents, the self-verification replay, and the four canary passes the run itself performed | **yes** — the only thing in the bundle a model produced |
| [`artifact/`](./evidence/artifact) | The capability under replay: `contract.json`, `artifact.json`, the allowlist, the approver's public key | no — hand-authored, and it says so |
| `replay-01-green/` | The nine-step flow, no fault armed → `ok` with typed outputs | no |
| `replay-02-outcome-member-not-found/` | The core holds no such member → `outcome MEMBER_NOT_FOUND` | no |
| `replay-03-recovered-interstitial/` | A declared maintenance modal, dismissed inside its budget → `ok` | no |
| `replay-04-failed-app-error/` | An application error page that will not clear → `failed` | no |
| `replay-05-failed-session-expired/` | The session expires mid-flow and cannot be re-established → `failed` | no |
| [`masked-capture/`](./evidence/masked-capture) | A screenshot with three regions bound to sensitive fields blanked *before the bytes left the driver* | no |
| [`cli-replay/`](./evidence/cli-replay) | The same replay through the shipped CLI, so one transcript is reproducible verbatim | no |
| [`redaction-canary/`](./evidence/redaction-canary) | What the canary searched for, in what encodings, and what it could not search for | no |
| [`outcome-promotion/`](./evidence/outcome-promotion) | A reviewer walking the live run's artifact from `outcomes: []` to a proven `MEMBER_NOT_FOUND`: the probes, the refused first attempt, the proof, `contract@2.0.0`, the re-verification, and the invocation that returns the typed arm | no — it starts from two documents the live run produced and nothing else in it came from a model |

**How to read one run.** `result.json` is what the calling agent receives. `journal.jsonl` is the
structured journal written as the run happened. `run.log` is that scenario's console output.
`observations/` is the evidence sink: content-addressed frozen `Observation`s, each already through
`redactObservation`. A green run freezes nothing (its steps declare `captureOn: ["failure"]`); the
two hard failures each freeze the screen that failed, and that file is a `classify()` unit test with
no reproduction step attached to it.

**Reading the live run.** `provenance.json` for the adapter, model id and measured spend;
`verification.json` for the replay that promoted the artifact to `draft` with `modelInTheLoop:
false`; `synthesized/` for the three documents synthesis emitted, and `synthesized/report.json` for
everything synthesis refused to decide without a person. `canary/report.txt` is worth two minutes on
its own: passes 1–3 gate the exit code, pass 4 is **reported and not gated** and lists, with line
numbers, every place the member number legitimately appears in the recording — the model was told
the number, typed it, and was shown it echoed back. A recording that did not contain it would be a
recording of a different conversation.

That report has **four** passes because the run that wrote it predates the fifth. `5 metadata` —
`provenance.json`, `spend.json` and the bundle README grepped for member data, gated, with its scope
taken as the complement of the other four — was added afterwards and re-run over this bundle:
**CLEAN**, 3 files, 10,131 bytes, 27 needles, 0 hits, self-test 27/27. The scopes live in
`packages/discovery/tools/canaries.ts` as data rather than as closures inside the runner, which is
what lets `packages/discovery/test/canary-scopes.test.ts` ask, of every path in this bundle, which
gating pass reads it.

**Three real leaks were caught by tooling rather than by review**, and they are the reason the canary
gates the build: two in synthesis (a table cell's accessible name folded into `flow.vocabulary` — on
a legacy grid the cell's name *is* the value — and `std.text@1` lowercasing delivered values), and
one in the synthesis *report*, where the model's own prose about what it saw carried member data.
`artifact.json` and `contract.json` were clean throughout: parameterization held on the documents
that get committed, diffed and signed. The canary also produced one instructive false positive that
turned out to be a real bug — 14 reported "leaks" in `spend.json` were IEEE-754 noise
(`"turnUsd": 0.014200999999999998`). Money was being serialized as a float artifact; it is rounded
to the microdollar at record time now.

---

## Repository map

Nine workspace projects: eight members plus the root. The line between `core` and everything else is
drawn on **purity**, not subject matter, because that is the boundary a contract test can enforce.

| Member | One line | Tests |
| --- | --- | ---: |
| `packages/core` | The schema and validators, canonical JSON + SHA-256 digest, the 29-check linker, the classifier, the target resolver, the extractor, the overlay merge, the policy predicate, the **detector discrimination proof**, and the prose renderers. **Zero I/O, zero clock, zero randomness, zero driver imports — checked by a source-scanning test, verified by injecting a real violation.** | 839 |
| `packages/runtime` | The impure half, all in one place: interpreter, settle loop, budget ledgers, control lease, journal writer, evidence sink, file-backed store, the catalog and `invoke` host, ed25519 approval verification, outcome promotion, the operator console, the redaction canary, the `crr` CLI and `pnpm demo`. | 390 |
| `packages/discovery` | The model provider port, the hand-written Anthropic tool-use loop, the OpenAI adapter, the VCR transcript recorder/replayer, deterministic synthesis, and the `preflight` / `discover` entry points. The only package that may import a model SDK. | 362 |
| `packages/surface-browser` | Playwright + per-frame CDP `Accessibility.getFullAXTree` stitched into an `Observation`. Not `querySelector`. Owns dialogs, the `perceive` deadline and PNG region masking. | 107 |
| `packages/surface-terminal` | `@xterm/headless` over a `TerminalTransport` port → an `Observation` built from an 80×24 character grid. **Exists to falsify the port**: if the abstraction only fits a browser, this is where that stops being aspirational. | 125 |
| `packages/conformance` | 25 browser + 14 terminal fault scenarios × 10 engines (1 reference, 9 mutants), the meta-test that fails when the suite stops discriminating, and multi-run stability. Separate so the broken engines can never ship inside `@crr/core`. | 102 |
| `fixtures/corebank-web` | The hostile proxy surface: frameset, nested layout tables, generated ids, `<font>` tags, no test ids, two confirmation channels (an in-page modal and a native `confirm()`), a real non-idempotent commit, **10 injectable faults**, 2 tenant variants of one vendor product. | 66 |
| `fixtures/corebank-tui` | The 80×24 green screen: 4 fault modes in 2 families, 2 tenant variants, so `surface-terminal` has something hostile to drive. | 36 |
| | **Total, all credentials unset** | **2,027** |

All fixture data is obviously synthetic and marked so on the screens. No real PII and no real
credential appears anywhere in this repository.

The mutants in `packages/conformance` are the **real** `replay()` — same linker, lease, budgets,
journal, session broker — with exactly one pure decision function swapped through an injection seam.
A meta-test enforces that by function identity. Without it they would be stubs, and a suite that can
only tell a real engine from a stub proves nothing.

---

## Limitations

The honest list, short version. [REPORT.md §7](./REPORT.md) is the full cut list with reasoning;
`docs/design/FINAL-STATUS.md` §7 and §8 carry the long form, including limits named at their own call
sites.

- **The fixture is my own construction.** This is the single biggest threat to the validity of every
  robustness number here, and no amount of scenario count fixes it. A real vendor app fails in ways
  I did not think to script.
- **One live run.** Nine turns, one goal, one tenant, one model. **No live model has ever been
  refused by the policy gate, got stuck, or raised an intervention** — the escalation path, the
  refusal path and the `stuck` path are covered by hermetic tests and the conformance corpus, and by
  nothing a model has actually done.
- **The spend cap has never bound mid-run.** `stopBeforeTurn` is called between every pair of turns
  and refuses on the *projection*, which is demonstrable for free at the turn-0 boundary
  (`pnpm discover --dry-run --force --max-usd 0.02` → `budget-exhausted`, exit 1). It cannot be
  demonstrated at turn *n* by a rehearsal, because a VCR transcript reports zero usage so the
  accumulated total never grows — and the live run finished at $0.14 under a $2.00 cap. The hook
  also has no unit test of its own; it is only reachable through `pnpm discover`.
- **The canary's own published report republishes what it quoted.** `canary.ts`'s second design
  rule is that every context excerpt has all *known* values blanked before it is stored — and "known"
  means known to that pass. The recording pass searches for the caller's argument alone, so a hit
  whose excerpt straddles the results row prints the member's name and balance into
  `evidence/discovery-live/canary/report.txt` and `canary/recording.json`. Every byte is a quotation
  of `transcript.json:417`, where the row legitimately lives, so nothing new reaches the bundle and
  no control was bypassed; what is violated is the rule that file states about itself. It is why
  `canary/` is the one ledgered exclusion from the fifth pass's otherwise-total scope. The fix is a
  blank-list separate from the needle-list, which means re-emitting the committed reports, which
  means another live run.
- **The canary that gates the build has a longer needle floor than the synthesis it is checking.**
  `MIN_NEEDLE_LENGTH = 8` in `packages/discovery/tools/canaries.ts`;
  `MIN_OBSERVED_NEEDLE_LENGTH = 4` in `packages/discovery/src/synthesis/prose.ts`. On the live run this was live: `membershipStatus` was `ACTIVE`, six
  characters, and `evidence/discovery-live/canary/report.txt` says so under `NOT SEARCHED, and why`.
  Nothing leaked, because synthesis's own 4-character rule withheld the prose that carried it — but
  the belt is 4 and the braces are 8, so a short observed value in a document synthesis failed to
  scrub would ship CLEAN. **Making them one number is not the fix, and that is now measured:**
  re-running the passes over the live bundle at a floor of 4 fails the gating document pass with 4
  hits, every one of them the string `MEMBER_FOUND_ACTIVE` — the symbolic outcome code the report
  deliberately keeps and flags at `review` severity, because an observed value cannot be substituted
  into a code and leave a legal code. The real fix is teaching that pass to exempt a
  `SCREAMING_SNAKE` token the report already flagged.
- **The live bundle names two content addresses for one artifact, and nothing in the bundle used to
  explain it.** `verification` is not on `ARTIFACT_DIGEST_EXCLUDED_FIELDS`, so writing the
  verification stamp moves the digest: `discovery.log` and `verification.json` say
  `sha256:923ab02f…`, while the shipped `synthesized/artifact.json` says `sha256:32e56a6f…`. The file
  on disk is self-consistent — it re-digests to `32e56a6f…` and an approval would sign that — but
  `verification.runId` and `verification.at` are non-deterministic, so the shipped artifact's content
  address is **not reproducible from the recording**. `verification` belongs on the excluded list
  beside `lifecycle`; that one-line change moves every committed artifact's digest and was not made.
- **`contract.outcomes` on the live artifact is `[]`.** Synthesis will not write a detector for a
  screen the run never observed — that is exactly how a false `MEMBER_NOT_FOUND` gets emitted — so
  the model's proposed outcome is carried in `synthesized/report.json` as a review item for a person.
  It means the shipped capability from that run is thinner than the committed hand-authored one.
- **Four of nine mutants survive the green-screen corpus.** The interesting one is `noSettleGate`: a
  green screen's readiness signal is *silence*, and a torn repaint is silent, so the driver reports
  `settled: true` on a half-painted frame. **On that surface quiescence cannot be the gate, which is
  why the checkpoint has to be.** That is a result about the design, not a hole in the effort — and
  it is asserted in both directions by the test, with a written reason per survivor.
- **No branching in the artifact language.** The flow is straight-line; an optional interstitial is
  modelled as a declared recovery, not as a branch. There is also no recovery mode that re-verifies
  without re-dispatching, so an interstitial arriving *after* a step has acted cannot be recovered —
  conformance scenario 25 deliberately pins the wrong behaviour so the day the mode exists a test
  fails and somebody comes back to it.
- **Approval signs a digest with ed25519 and stops.** There is no key custody, no approver identity
  beyond a handle, no expiry and no rotation. Signature *verification* is real and the linker refuses
  an approval that does not cover the artifact's digest; the signer is a port so a KMS substitutes
  cleanly. That is a seam, not a solution.
- **The operator console is deliberately bare** and its live view is a poll, not a stream. What is
  real is the control model underneath it: one controller per session under a lease token, enforced
  at the port rather than by convention, with hand-back re-verifying the precondition. Production
  streams frames over CDP screencast; that is a documented seam.
- **Desktop (AX/UIA) is designed, not built.** The `Surface` port is two operations, and the terminal
  driver is the evidence that they are not browser-shaped.
- **"One artifact, two tenants" is proved; "one contract, two surfaces" is not.** The green screen
  prints a member's name as unlabelled prose, and `detect()` emits nodes for headings, labelled
  fields, legend controls, status bands and tables — not for prose — so there is nothing for the
  browser contract's required `memberName` output to name. Rather than publish a contract the
  terminal program cannot satisfy, the terminal declares its own, and `heterogeneity.test.ts`
  compares the two `activate` steps field by field instead. That is a real weakening of the
  cross-surface claim and it is the second item on the "next" list in REPORT §7.
- **The OpenAI adapter is not reachable from the CLI.** Provider-independence is tested at the port,
  not demonstrated by a second live run.

---

## License

MIT.
