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
>   that is a property of that surface and is written down in the test. The two corpora together
>   kill all nine; neither does alone.
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
| **A model really drove a real UI to a goal.** `claude-opus-5`, adapter `anthropic`, 9 turns, `reached-goal`, **55.4% cache hit rate**, **42,368 billed tokens**, **$0.140904** | **measured, once** | `cat evidence/discovery-live/provenance.json` · full transcript in `evidence/discovery-live/transcript.json` |
| **The artifact synthesized from that run replayed with the model out of the decision loop**, graded `full`, and only then became a `draft` | **measured** | `cat evidence/discovery-live/verification.json` → `"modelInTheLoop": false`, `"status": "verified"`, `"grade": "full"` |
| **Replay separates `ok` / business outcome / recoverable / hard failure with zero false successes**, and **9 of 9 deliberately weakened engines are killed** — 17 kills, **13 of them false successes** | **measured** | `pnpm -F @crr/conformance stability` → `25 scenarios: 25 passed, 0 failed, 0 FALSE SUCCESSES`, `every mutant was killed by at least one scenario`, exit 0 |
| **The fallback-chain mutant (`nearestMatch`) is killed by 6 scenarios and every one is a false success** — the mutant told a caller a business outcome for a broken run | **measured** | same command, kill-matrix row `nearestMatch  04,06,08,09,15,21` |
| **Replay is deterministic over the corpus**: 25 scenarios × 20 runs, flake rate 0.0%, 0 result documents that were not byte-identical | **measured, on a fixture I wrote** | same command |
| **4 of 9 mutants survive the terminal corpus** (`noAssert`, `noSettleGate`, `noContinuity`, `noProvenance`), each with a written reason asserted by the test | **limitation, reported not hidden** | `pnpm -F @crr/conformance exec vitest run test/terminal-conformance.test.ts` → 10 passed |
| **The whole repository builds and tests with zero credentials.** 1,843 tests, 8 workspace members | **measured** | `env -u … pnpm test` → `Tasks: 14 successful, 14 total`, exit 0 |
| **`pnpm demo` produces the entire evidence bundle with no live service**, all three arms of the taxonomy exhibited, redaction canary clean on both passes | **measured** | `env -u … pnpm demo` → `7/7 exhibits PASS`, `whole-bundle canary pass: CLEAN`, exit 0 |
| **The engine cannot read a clock, do I/O, or import a driver, and no package above the drivers contains CSS vocabulary** — read off disk, not asserted | **measured, verified by injection** | `pnpm -F @crr/core exec vitest run test/purity.test.ts test/no-locator-vocabulary.test.ts test/policy-chokepoint.test.ts` → 44 passed |
| **The spend cap stops a run before it starts. It has never bound *mid-run*.** The between-turns guard fires on the projection, demonstrated free at the turn-0 boundary; it has no unit test and no run has ever crossed it at turn *n* | **partially proven** | `pnpm discover --dry-run --force --max-usd 0.02` → `status budget-exhausted`, `$0.0000 has been billed and turn 1 projects to at most $0.06 … which would cross the $0.02 ceiling`, exit 1 |
| **`evidence/discovery-live/provenance.json` is covered by no gating *value* canary pass.** Passes 1 and 2 scope to the synthesized documents and to what the verification replay wrote; pass 3 covers the whole bundle for credential shapes only | **known gap** | `evidence/discovery-live/canary/report.txt`, pass headers |
| **`contract.outcomes` on the live artifact is `[]`.** Synthesis will not invent a detector for a screen the run never observed, so the model's proposed outcome rides in the report as a review item instead | **deliberate, and a real gap in the shipped capability** | `python3 -c "import json;print(json.load(open('evidence/discovery-live/synthesized/contract.json'))['outcomes'])"` |

---

## Quickstart

Node 22 (`engines: >=20 <25`), pnpm 10. Verified on `node v22.22.1` / `pnpm 10.33.0`.

```bash
pnpm install
pnpm -F @crr/surface-browser exec playwright install chromium   # once — see the note below
pnpm demo
```

**`pnpm demo` needs no API key, no `.env`, and no network beyond loopback.** It builds
`@crr/runtime`, starts `fixtures/corebank-web` on an ephemeral loopback port, drives it with a local
Chromium, and rewrites the whole of [`evidence/`](./evidence) (except the live discovery run, which
it never touches). It exits non-zero if any scenario misses its declared arm or if the redaction
canary finds a parameter value anywhere in the bundle. About ten seconds after the build.

```text
   PASS  replay-01-green                    ok        green
   PASS  replay-02-outcome-member-not-found outcome   expected business outcome
   PASS  replay-03-recovered-interstitial   ok        recoverable condition
   PASS  replay-04-failed-app-error         failed    hard failure
   PASS  replay-05-failed-session-expired   failed    hard failure
   PASS  masked-capture                     3 region(s) blanked
   PASS  cli-replay                         exit 0

REDACTION CANARY  CLEAN   …  hits 0   suppressed 0   credentials 0
   whole-bundle canary pass: CLEAN
DEMO OK
```

### About Chromium

`playwright` is a dependency of the packages that need it, not of the workspace root, so the install
command is scoped:

```bash
pnpm -F @crr/surface-browser exec playwright install chromium
```

From the repo root, `pnpm exec playwright …` fails with `Command "playwright" not found` and
`npx playwright …` fails with `sh: playwright: command not found`. Use the scoped form above.

**Without a Chromium build the test suite is still green, and that is a trap worth naming.** 46 of
the 1,843 tests skip — including every test that has ever touched a real browser — and each guard
prints a warning to stderr, but the board reads green:

```text
$ env -u … PLAYWRIGHT_BROWSERS_PATH=<an empty dir> pnpm test
    @crr/surface-browser   Tests   78 passed |  29 skipped (107)
    @crr/runtime           Tests  298 passed |  16 skipped (314)
    @crr/conformance       Tests  101 passed |   1 skipped (102)
    Tasks: 14 successful, 14 total                                exit 0
```

1,797 passing, green, and the browser replays never ran. Install Chromium.

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

Every member in `fixtures/corebank-web/src/data.js` works (`10041`–`10047`). All of it is
synthetic and marked `(SYNTHETIC)` on the screens themselves.

`--surface` takes a **module path**, not a fixed set of values: `@crr/runtime` imports no driver
anywhere in `src/`, and a contract test in `@crr/core` fails if it ever does, so a green-screen
factory drops into that flag unchanged.

### 2. Run the agent on a goal — free, with the model's turns served from a VCR recording

```bash
pnpm discover --dry-run
```

This is the entire runner: the observe → decide → act loop, the policy chokepoint on every tool
call, deterministic synthesis, the verification replay with the model out of the loop, and all four
redaction canary passes. The only substitution is the provider — turns come from a recorded
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
| usage | 18,220 input · 1,540 output · 22,608 cache-read · **55.4% cache hit rate** |
| spend | **$0.140904**, 42,368 billed tokens, against a `--max-usd` cap of $2.00 |
| outcome | synthesized artifact **replayed with the model out of the loop**, graded `full`, saved as `draft`; canary passes 1–3 clean |

`measuredUsd` is this repository's arithmetic over the token counts the provider returned, at the
rates in `packages/discovery/tools/live-run.ts`. It is not an invoice; the provider's console is the
authority.

**It took three attempts, and the first two cost $0.00** — both failed on the request before the
model ever answered, and both wrote their transcript and spend ledger and exited non-zero, because
the durability path was built before the run:

1. The provider rejected the tool schema under `strict: true` —
   `Enum value 'Enter' does not match declared type '["string","null"]'`. Valid JSON Schema; a union
   `type` array combined with an `enum` is refused. Fixed with `anyOf`.
2. `ZodError: unrecognized_keys: ["caller"]` — we were strict-validating the provider's *response*
   schema, which we do not own, and a field had been added upstream. Validate what you emit; parse
   what you receive.

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
a request to the provider.

```text
$ pnpm preflight                                  # with no key in the shell
      NOT READY - 1 blocker(s):
        BLOCK  [credential] ANTHROPIC_API_KEY is not set in this shell.
      13 check(s) passed.                                                   exit 1

$ ANTHROPIC_API_KEY=<well-formed> pnpm preflight
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
| [`discovery-live/`](./evidence/discovery-live) | The real discovery run: transcript, journal, spend ledger, provenance, the synthesized documents, the self-verification replay, and all four canary passes | **yes** — the only thing in the bundle a model produced |
| [`artifact/`](./evidence/artifact) | The capability under replay: `contract.json`, `artifact.json`, the allowlist, the approver's public key | no — hand-authored, and it says so |
| `replay-01-green/` | The nine-step flow, no fault armed → `ok` with typed outputs | no |
| `replay-02-outcome-member-not-found/` | The core holds no such member → `outcome MEMBER_NOT_FOUND` | no |
| `replay-03-recovered-interstitial/` | A declared maintenance modal, dismissed inside its budget → `ok` | no |
| `replay-04-failed-app-error/` | An application error page that will not clear → `failed` | no |
| `replay-05-failed-session-expired/` | The session expires mid-flow and cannot be re-established → `failed` | no |
| [`masked-capture/`](./evidence/masked-capture) | A screenshot with three regions bound to sensitive fields blanked *before the bytes left the driver* | no |
| [`cli-replay/`](./evidence/cli-replay) | The same replay through the shipped CLI, so one transcript is reproducible verbatim | no |
| [`redaction-canary/`](./evidence/redaction-canary) | What the canary searched for, in what encodings, and what it could not search for | no |

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
| `packages/core` | The schema and validators, canonical JSON + SHA-256 digest, the 28-check linker, the classifier, the target resolver, the extractor, the overlay merge, the policy predicate and the prose renderers. **Zero I/O, zero clock, zero randomness, zero driver imports — checked by a source-scanning test, verified by injecting a real violation.** | 788 |
| `packages/runtime` | The impure half, all in one place: interpreter, settle loop, budget ledgers, control lease, journal writer, evidence sink, file-backed store, the catalog and `invoke` host, ed25519 approval verification, the operator console, the redaction canary, the `crr` CLI and `pnpm demo`. | 314 |
| `packages/discovery` | The model provider port, the hand-written Anthropic tool-use loop, the OpenAI adapter, the VCR transcript recorder/replayer, deterministic synthesis, and the `preflight` / `discover` entry points. The only package that may import a model SDK. | 305 |
| `packages/surface-browser` | Playwright + per-frame CDP `Accessibility.getFullAXTree` stitched into an `Observation`. Not `querySelector`. Owns dialogs, the `perceive` deadline and PNG region masking. | 107 |
| `packages/surface-terminal` | `@xterm/headless` over a `TerminalTransport` port → an `Observation` built from an 80×24 character grid. **Exists to falsify the port**: if the abstraction only fits a browser, this is where that stops being aspirational. | 125 |
| `packages/conformance` | 25 browser + 14 terminal fault scenarios × 10 engines (1 reference, 9 mutants), the meta-test that fails when the suite stops discriminating, and multi-run stability. Separate so the broken engines can never ship inside `@crr/core`. | 102 |
| `fixtures/corebank-web` | The hostile proxy surface: frameset, nested layout tables, generated ids, `<font>` tags, no test ids, two confirmation channels (an in-page modal and a native `confirm()`), a real non-idempotent commit, **10 injectable faults**, 2 tenant variants of one vendor product. | 66 |
| `fixtures/corebank-tui` | The 80×24 green screen: 4 fault modes in 2 families, 2 tenant variants, so `surface-terminal` has something hostile to drive. | 36 |
| | **Total, all credentials unset** | **1,843** |

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
- **One live run.** Nine turns, one goal, one tenant, one model.
- **The spend cap has never bound mid-run.** `stopBeforeTurn` is called between every pair of turns
  and refuses on the *projection*, which is demonstrable for free at the turn-0 boundary
  (`pnpm discover --dry-run --force --max-usd 0.02` → `budget-exhausted`, exit 1). It cannot be
  demonstrated at turn *n* by a rehearsal, because a VCR transcript reports zero usage so the
  accumulated total never grows — and the live run finished at $0.14 under a $2.00 cap. The hook
  also has no unit test of its own; it is only reachable through `pnpm discover`.
- **`provenance.json` is covered by no gating *value* canary pass.** The writer was fixed to scrub
  observed outputs; a fifth scoped pass was deliberately not added, because it could not be tested
  without spending another live run to produce input for it.
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
- **The OpenAI adapter is not reachable from the CLI.** Provider-independence is tested at the port,
  not demonstrated by a second live run.

---

## License

MIT.
