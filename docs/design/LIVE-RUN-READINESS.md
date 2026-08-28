# LIVE-RUN-READINESS — what `pnpm discover --yes` will do, and what it will cost

**Written for the person whose card is on the account.** Every command below was run in this working
tree on 2026-08-27 except the one this document exists to authorise, which was not run and must not
be run by any agent (`.private/BRIEF.md` §11). Where a number is measured, the command that produced
it is printed next to it. Where a number is an estimate, it says so and names the assumption.

Read §5 (what can still go wrong) before §1 (the command). §5.1, §5.2 and §5.5 were the things this
document said to fix before spending anything; all three are now fixed, tested and re-measured, and
each section says what was done and what command proves it. §5.5 in particular is fixed **before**
the run rather than after, because it changes the synthesized contract's bytes and doing it
afterwards would change the live artifact's digest.

---

## 0. Status in one line

```
$ pnpm preflight                                       →  READY. 15 checks passed.   exit 0
$ pnpm discover --dry-run --force                      →  the whole runner, end to end  exit 0
$ pnpm discover                        (no --yes)      →  NOT PROCEEDING               exit 2
$ env -u ANTHROPIC_API_KEY … TURBO_FORCE=1 pnpm test   →  1,820 passed, 14/14 tasks    exit 0
$ env -u ANTHROPIC_API_KEY … pnpm demo                 →  7/7, 48 files, canary CLEAN  exit 0
```

(1,785 → 1,805: twenty tests added closing §5.1 and §5.2. 1,805 → 1,820: fifteen more closing §5.5.
None removed, none weakened; three existing assertions were updated because they had the old
parameter name or the old report shape written into them. The `pnpm demo` row was re-run after §5.5
and is current.)

The runner exists, it has been rehearsed end to end against the VCR adapter, both spend guards have
been observed to fire, and the `--yes` gate has been observed to refuse a run **with a real funded
credential already loaded into the process**. The only thing in this document that was not executed
is the model call itself — and §5.4, which is read off the source rather than rehearsed, for the
reason it gives.

---

## 1. The command

```bash
pnpm preflight        # first. Makes no model call. Should print READY and exit 0.
pnpm discover --yes   # this one spends money.
```

`pnpm preflight` reads `ANTHROPIC_API_KEY` **from your shell only** and checks its shape; it never
prints it and never uses it. `pnpm discover` additionally reads `<repo>/.env` for you and announces
which variable *names* it set — never a value, never a prefix, never a length. An already-set shell
variable always beats the file. So if your key lives in `.env`, preflight will say

```
  [BLOCK ] ANTHROPIC_API_KEY is not set in this shell.
  VERDICT  NOT READY - 1 blocker(s).                                        exit 1
```

and `pnpm discover` will still find it. To make preflight agree: `set -a; . ./.env; set +a`.

**Flags worth knowing before you type the command:**

| flag | default | when you would change it |
|---|---|---|
| `--model <id>` | `claude-opus-5` (or `CRR_MODEL`) | `claude-sonnet-5` costs ~40% of opus on this loop. An id outside `MODEL_RATES` is **refused**, not run unpriced. |
| `--max-usd <n>` | `2.00` | The whole-run ceiling. See §3. |
| `--max-turns <n>` | `24` | The hand-authored script reaches this goal in 8. |
| `--max-output-tokens <n>` | `2000` | Raise if turns come back truncated; the runner warns when any do. |
| `--out <dir>` | `evidence/discovery-live` | Send a first attempt somewhere else if you want to look before committing. |
| `--force` | off | Required to overwrite an existing `transcript.json`. |

---

## 2. What it will do, stage by stage

All five stages ran in the rehearsal. The output quoted is the rehearsal's, from
`.scratch/discovery-dry-run/discovery.log`; the live run differs only in who answers the turns.

**0 — the confirmation screen.** Prints mode, adapter, model, rates, the goal verbatim, the member,
the tenant, the loopback origin, the full policy allowlist, every budget, and the destination. Then,
without `--yes`, it stops.

**1 — discovery.** Boots `fixtures/corebank-web` on an ephemeral loopback port, opens Chromium,
perceives through `@crr/surface-browser` (CDP accessibility tree), and runs the observe → decide →
act loop. Every tool call passes `PolicyEngine.check` and is journaled. Per-turn usage and running
spend are printed as they arrive:

```
      turn  1  in       0  cache w/r 0/0  out      0  tool_use   turn $0.0000   RUN $0.0000 / $2.00
      …
      status          reached-goal
      turns           8
      steps recorded  3
      outputs noted   memberName, shareBalance, accountStatus
```

(The zeros are the rehearsal: `createScriptedModel` reports `ZERO_USAGE` by design. On a live run
these columns carry the provider's own numbers — see §6.)

**2 — synthesis.** The recording becomes a typed, parameterized, content-addressed contract +
artifact. Rehearsed output:

```
      capability      corebank.member.read_share_position@1.0.0
      contract digest sha256:8589fe3b113d04aae80b274116beea0786c76f11d60e3e8b16e9ad93407704f0
      steps           fill -> activate -> read -> activate
      parameters      value1:sensitive
      outputs         memberName, shareBalance, accountStatus
      outcomes        (none - synthesis will not invent a detector)
      lifecycle       proposed   verification unverified
      report notes    10
```

**Three lines of that block are stale, and deliberately not edited.** It is quoted rehearsal output
from a run that happened before §5.5, and rewriting recorded output to match today's code is the one
thing a rehearsal transcript may never do. Since §5.5 the `parameters` line carries the naming rung
and no longer says `value1`; the contract digest and the note count move with it. The rehearsal was
**not** re-run to refresh them, because `.private/BRIEF.md` §11 names `pnpm discover` as a command no
agent runs. What *was* re-derived, from the same synthesis over the same committed observation
corpus, is `packages/discovery/test/fixtures/corebank-web.capability.json` — see §5.5.

**3 — verification (BRIEF §3.4).** The same artifact is replayed against the same application in a
**fresh browser session** with the model out of the loop. Only if that passes is the document saved
as `draft`:

```
      mode            replay-dry
      status          verified
      grade           full
      covered through activate-open
      proposed -> draft   verification verified/full
```

**4 — the bundle.** 19 files, ~250 KB, into `evidence/discovery-live/`: `transcript.json`,
`discovery.log`, `journal.jsonl`, `provenance.json`, `spend.json`, `README.md`, `synthesized/`
(contract, artifact, report, README), `verification.json`, `verification-journal.jsonl`,
`verification-evidence/`, `canary/`.

**5 — the redaction canary.** Four scoped passes; three gate the exit code. Rehearsed:

```
      pass 1 documents    CLEAN    4 files,  68,854 bytes, 34 needles, 0 hits, 0 credential shapes
      pass 2 replay       CLEAN    4 files,  79,544 bytes,  7 needles, 0 hits, 0 credential shapes
      pass 3 credentials  CLEAN   19 files, 217,118 bytes,  0 needles, 0 hits, 0 credential shapes
      pass 4 recording    reported 3 files,  44,132 bytes,  7 needles, 19 hits, 0 credential shapes
```

Pass 4 is **reported, not gated, and that is the honest design**: the member number is a literal in
the goal, so the model is told it, types it, and is shown it in the application's own output. A
discovery recording that did not contain it would be a recording of a different conversation. Pass 4
lists all 19 occurrences with file and line so the claim is checkable rather than asserted; passes 1
and 2 gate on the two places the number genuinely must not be — the synthesized documents, and
everything the verification replay wrote.

**Then, on success only:** `evidence/discovery-live/PENDING.md` is deleted and the runner prints
`A REAL DISCOVERY RUN IS ON DISK.` Exit 0 requires all three of: reached the goal, verified without
a model, canary clean.

---

## 3. What it will cost

### The measured half

`pnpm preflight` builds the exact turn-1 request the runner sends — same system prompt, same five
tool definitions, same `max_tokens`, same effort — and sizes it. These are **local character-count
estimates**, not tokenizer output, because `messages.countTokens` is itself a billed round trip.
Treat each as ±20%.

```
  system prompt             2,265 chars  ~   687 tok
  tool definitions          4,447 chars  ~ 1,348 tok
  ─ cacheable prefix        6,712 chars  ~ 2,034 tok      (clears opus-5's 512-token cache floor)
  task message                331 chars  ~   101 tok
  ═ TURN 1 INPUT            7,043 chars  ~ 2,135 tok
  first observation           407 chars  ~   124 tok      perceived LIVE, just now, over CDP
```

### The estimated half

One symbol is **assumed**: `U`, output tokens per turn, taken as 800. There has never been a live run
in this repository to measure it from. Thinking is on by default on `claude-opus-5` at effort `high`
and thinking tokens bill as output, so **`U` is the figure most likely to be wrong and the one the
output bill is linear in.** Re-price it with `CRR_PREFLIGHT_OUTPUT_TOKENS=3000 pnpm preflight`.

The model of a run: turn 1 input = `P + T`; turn *t* input = `P + T + Σ(U + O)` over the *t−1* turns
before it; the history is re-sent every turn, which is why input grows quadratically in turn count.

**`claude-opus-5`, $5 / $25 per MTok:**

| turns | scenario | input tok | input $ | output $ | **total** | % of $10 cap |
|---:|---|---:|---:|---:|---:|---:|
| 8 | typical (U = 800) | 30,646 | $0.15 | $0.16 | **$0.31** | 3.1% |
| 8 | ceiling (U = 2,000) | 64,246 | $0.32 | $0.40 | **$0.72** | 7.2% |
| 16 | typical | 118,090 | $0.59 | $0.32 | **$0.91** | 9.1% |
| 16 | ceiling | 262,090 | $1.31 | $0.80 | **$2.11** | 21.1% |
| 24 | typical | 264,669 | $1.32 | $0.48 | **$1.80** | 18.0% |
| 24 | ceiling | 595,869 | $2.98 | $1.20 | **$4.18** | 41.8% |

`claude-sonnet-5` ($2 / $10) is the same table at roughly 40%: $0.13 / $0.72 / $1.67 in the same
three rows.

**The absolute worst one run of `pnpm discover --yes` can cost on `claude-opus-5` is $4.18** — every
one of 24 turns emitting the full 2,000-token ceiling — and `--max-usd 2.00` stops it well before
that. The adapter's own default `max_tokens` of 16,000 would have made that worst case **$31.90**,
three times the project cap; `DISCOVER_MAX_OUTPUT_TOKENS` lowers it to 2,000 for exactly that reason.

**Realistic expectation: $0.30 – $0.80.** The hand-authored script reaches this goal in 8 turns; a
real model has to explore, so budget for more than 8 and fewer than 24.

**One closeness worth knowing.** At the assumed `U = 800`, a full 24-turn run lands at $1.80 against
a $2.00 cap — a $0.20 margin. So on a typical run the *turn* budget ends it and the money cap never
fires; if `U` is even modestly higher than assumed, the *money* cap fires first, mid-run, somewhere
around turn 15–20. Both endings are clean (§4). Neither is a failure.

**Caching saves almost nothing here, and the report says so.** Only the system prompt and the tool
definitions carry a breakpoint; the message history does not. Measured from the same table: caching
saves **$0.21** on a full-budget 24-turn opus run. BRIEF §9 asks for the cache hit rate as reported
evidence — this is the number that will make it look small, and that is a real finding about the
shape of an agent loop rather than a defect.

**The arithmetic is this repository's, not an invoice.** `provenance.json` and `spend.json` say so in
their own text. The authority is the Anthropic console.

---

## 4. What the guards will do if it goes wrong

### The `--yes` gate — **observed**

```
$ pnpm discover                       # .env holding the real, funded key; no --yes
      credential      ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, OPENAI_API_KEY, CRR_MODEL loaded from .env
      NOT PROCEEDING. This run would spend the author's money and `--yes` was not given.
                                                                                        exit 2
```

`createAnthropicModel` is constructed inside the branch the gate guards, so the refusal happens
before a client object exists. There is no flag combination that reaches the provider by accident.

### The spend cap — **observed firing**

```
$ pnpm discover --dry-run --max-usd 0.05 --out .scratch/budget-usd
      status          budget-exhausted
      summary         the spend cap stopped this run: $0.0000 has been billed and turn 1 projects
                      to at most $0.06 (2,201 prompt tokens at $5/Mtok plus 2,000 output tokens at
                      $25/Mtok), which would cross the $0.05 ceiling. Raise it with --max-usd if
                      that is what you want to do.
      turns           0
                                                                                        exit 1
```

### The price-independent token backstop — **observed firing**

```
$ pnpm discover --dry-run --max-total-tokens 100 --out .scratch/budget-tokens
      status          budget-exhausted
      summary         the token backstop stopped this run: 0 tokens have been billed and turn 1
                      would take it to at most 4,201, past the 100 ceiling. This guard is
                      price-independent; if it fired before the spend cap did, MODEL_RATES is
                      probably wrong.
                                                                                        exit 1
```

Both guards live **inside** `runDiscoveryLoop` as `stopBeforeTurn`, not around the model, and that
placement is what makes them safe: the loop `break`s, `loop.finished` is journaled, the recorded
steps survive, and a `DiscoveryRun` is returned for the bundle writer. Verified in the journal of the
guarded rehearsal:

```
{"type":"loop.started",...}
{"type":"loop.finished","status":"budget-exhausted","turns":0,"actions":0,"usage":{...},"cacheHitRate":0}
```

The projection is pessimistic in three ways on purpose: the whole next prompt is charged at the full
input rate ignoring the cache discount that will actually apply; the next output is charged at
`max_tokens` rather than at what the model has been emitting; the next tool result is charged at the
largest growth measured so far. So `--max-usd` is a **ceiling a run cannot overshoot**, not a target.

### The safety gate while the model drives — **exercised by preflight, just now**

```
  on-allowlist   corebank/search           ALLOW  (rule route:corebank/search)
  off-allowlist  corebank/admin/settings   DENY   route-not-allowed
  foreign origin anthropic/v1/messages     DENY   origin-not-allowed
  no route at all                          DENY   route-not-allowed
```

One origin alias, bound to the loopback fixture. Three explicit routes, no wildcard.
`discoveryMaxEffect: WRITE_REVERSIBLE`, so no irreversible action can be dispatched at all, and the
loop is given `approval: null`. The model cannot reach anything but the local fixture.

### If the run does not reach the goal

Synthesis is skipped, the verification replay does not happen, the artifact stays `proposed`,
`PENDING.md` is **not** deleted, and the exit code is 1 — but the bundle is still written, because a
guard that destroys the evidence of firing is worse than no guard. Rehearsed: the budget-stopped runs
above still produced `provenance.json`, `spend.json`, `journal.jsonl`, `README.md`, `discovery.log`
and all four canary reports.

That now holds for **every** ending, `failed` included. `stuck`, `budget-exhausted`, `model-stopped`
and `failed` all write the same files through the same function; what differs between them is what
`provenance.json` says, which is a field rather than a branch. See §5.2.

---

## 5. What can still go wrong — read this before you spend

### 5.1 `pnpm demo` re-created `PENDING.md` on top of a live run — **fixed**

`packages/runtime/demo/main.ts` defines `discoverySlot()`, which writes
`evidence/discovery-live/PENDING.md` with the words *"This directory holds nothing. That is the
honest state of this deliverable today."* It was called unconditionally. The runner deletes
`PENDING.md` on success precisely to avoid *"a bundle that contains both a transcript and a note
saying there is no transcript"* — and the runner's own closing message tells you to run `pnpm demo`
next, so the note came straight back.

It is now behind the `liveRunPresent()` helper that already guarded the MANIFEST row and the
generated `evidence/README.md`:

```ts
  if (liveRunPresent()) {
    log("── discovery-live ─ a live run is present; PENDING.md not written");
    …
  } else {
    discoverySlot();
  }
```

**Verified by running the demo, not by reading it.** Writing a fake transcript into
`evidence/discovery-live/` is the one thing that directory forbids, so `main.ts` grew one seam —
`CRR_DEMO_EVIDENCE_DIR`, defaulting to `<repo>/evidence` — and the guard was exercised against a
`mkdtemp` directory holding an obviously fake `transcript.json`. Three runs, all exit 0:

```
$ CRR_DEMO_EVIDENCE_DIR=$T/evidence-empty pnpm exec tsx packages/runtime/demo/main.ts
      discovery-live/  EMPTY - a live model run, pending the author's approval
      $T/evidence-empty/discovery-live/  →  PENDING.md                          exit 0

$ CRR_DEMO_EVIDENCE_DIR=$T/evidence-live  pnpm exec tsx packages/runtime/demo/main.ts
   ── discovery-live ─ a live run is present; PENDING.md not written
      $T/evidence-live/discovery-live/   →  transcript.json  (and nothing else)  exit 0

$ (same, with PENDING.md put back by hand beside the transcript)
      WARNING: PENDING.md is still there beside a transcript. It says the slot is empty and
      the transcript says it is not. …                                          exit 0
```

The third run is the case this section originally warned about: on a *failed* live run
`transcript.json` exists so `liveRunPresent()` is true, while `PENDING.md` still sits beside it
saying the slot is empty. The demo no longer creates that contradiction and now **names it** when it
finds one, rather than silently tidying up a file the runner deliberately left in place.

`packages/runtime/test/demo-contract.test.ts` grew two tests: one that reads `demo/main.ts` off disk
and fails if the call is ever unguarded, and one that runs the same scanner against three sources
that *do* break the rule — no guard, a guard in another function, and a guard with the sense
inverted — so it is a scanner that can fail rather than one that passes because it looked at
nothing. **`evidence/` was not touched by any of this**; the real bundle is still the author's to
regenerate after the live run.

### 5.2 A mid-run API error lost the transcript you had already paid for — **fixed**

`runDiscoveryLoop` did not catch a `DiscoveryModelError`. A rate limit, a 400 or a dropped
connection propagated out of the loop to `discover.ts`'s outer `catch`, which printed `FAILED: …`
and exited 1 — at which point **`transcript.json`, `spend.json`, `provenance.json`, `README.md` and
`discovery.log` had not been written**, because every one of them is written after the loop returns.
The only durable record of a partly-paid run was `journal.jsonl`. The loop's own `TurnBudgetProbe`
comment already stated the principle — *"a budget guard that throws away the transcript it was
protecting has spent the money and kept nothing"* — and the budget path honoured it while the
exception path did not.

Three changes, in the three places the failure passed through:

1. **`packages/discovery/src/loop.ts`** — the turn cycle is wrapped, and a caught throwable ends the
   run with the new status **`failed`** and a `DiscoveryFailure { name, message, adapter, turn,
   stack }`. Every recorded step, every journal event and the measured usage come back on the
   `DiscoveryRun` exactly as they do when the budget guard stops the run. The catch is *not*
   narrowed to `DiscoveryModelError`: a dropped socket, a journal sink that could not write and a
   bug in the file are all "the run ended and here is what it had". A `loop.failed` event is
   journaled before `loop.finished`, and both terminal events are emitted through a sink wrapper
   that cannot itself lose the run.

   It is **opt-in** — `onUnexpectedError: "keep-the-run"` — and `pnpm discover` is the caller that
   opts in. The default is still to throw, because the VCR's strict digest check exists to be loud
   when a fixture stops matching the prompt, and three tests in `test/vcr.test.ts` assert that
   loudness. Only the caller that *paid* for the turns can say that keeping them beats failing
   loudly, so that caller says it, at the call site. A test reads `tools/discover.ts` off disk and
   fails if it ever stops saying it.

2. **`packages/discovery/tools/bundle.ts`** (new) — the four files a run must not lose are written
   by one named function, `writeCoreBundle()`, with no status check and no early return anywhere in
   it. They were forty lines of `writeJson` in the middle of the `try` a provider error jumped
   straight out of; a script with top-level `await` and `process.exit` in it cannot be imported, so
   nothing could assert that the bytes reached the disk. `discoveryExitCode()` moved there with
   them, so "only `reached-goal` is a success" is a function rather than three `&&`s.

3. **`packages/discovery/tools/discover.ts`** — passes the option, prints the failure and its turn,
   sends the stack to **stderr only** (`discovery.log` is committed and a stack carries absolute
   paths), and no longer lets `model.transcript()` throw on the recovery path: the recorder refuses
   to hand back an empty transcript and is right to, but that refusal happens *after* the loop
   returned, on the path whose whole job is to write down what the run had.

**The proof**, `packages/discovery/test/loop-failure.test.ts`, 18 tests. It injects a
`DiscoveryModelError` at turn 3 of a scripted run through the real recorder and the real loop, then
writes the bundle through the same function the runner calls, into a `mkdtemp` directory:

```
$ pnpm -F @crr/discovery exec vitest run test/loop-failure.test.ts
 ✓ test/loop-failure.test.ts (18 tests) 35ms
   Test Files  1 passed (1)        Tests  18 passed (18)                        exit 0
```

What it asserts, in the order the money leaves:

- the run comes back `failed`, naming `DiscoveryModelError`, adapter `anthropic`, turn 3;
- the step turn 2 recorded is still there — that is the thing the old path threw away;
- `transcript.json` is **on disk** holding turns **1 and 2**, with the provider's per-turn usage;
- `spend.json` is on disk, its `totalUsd` equal to `costOf()` over exactly those two turns;
- `provenance.json` says `"status": "failed"` with the error's name, message and turn, and carries
  **no stack**;
- `README.md` opens with *"This run ended on an error"* before it says anything else;
- `discoveryExitCode()` is **1** even with `verified: true` and a clean canary;
- and a value bound to a sensitive parameter appears in none of the four files, so the new failure
  fields are under the taint model like everything else.

**One accounting point worth being precise about, because the difference is visible in the files.**
The transcript holds the turns the provider *answered*. A request that raised returns no response
and no `usage`, so turn 3 is in `run.turns` and in `provenance.run.failure.turn` but not in
`transcript.turns` and not in the ledger — you were not billed for it. `provenance.json` carries both
numbers side by side (`run.turns: 3`, `transcript: { present: true, turns: 2 }`) so the gap is
something you can read rather than something you have to infer.

**What this does not change.** Synthesis is still skipped, the verification replay still does not
happen, `PENDING.md` is still **not** deleted, and the exit code is still 1. A run that stopped on an
error is not a discovery run. What is different is that you can now *see* what it did before it
stopped, and what it cost.

The Anthropic SDK still retries twice by default on 429/5xx before surfacing, so a transient limit
will usually not reach this path at all.

### 5.3 The spend guard has only been observed firing *before turn 1*

Under `--dry-run` the scripted model reports `ZERO_USAGE`, so the ledger's inputs never move:
`spent` stays $0 and `projectNext()` returns the same constant every turn. The guard can therefore
only be observed at the turn-0 → turn-1 boundary, which is where both rehearsals above caught it.
**The mid-run boundary — spend accumulating across turns and the cap binding at turn *n* — has never
executed.** So has the ledger's `record()` path over non-zero provider numbers, its measured
tool-result growth, and its cache accounting.

What *was* checked this pass is the arithmetic underneath it. The shipped `costOf()` and
`billedTokens()` from `tools/live-run.ts` were run at non-zero usage:

```
cached turn      costOf=0.02214200  byHand=0.02214200   (float association only, |Δ| = 3.5e-18)
                 billedTokens=3059  expected 3059
first turn       costOf=0.03321750  byHand=0.03321750   AGREE
24-turn typical  costOf=$1.80       preflight prints $1.80
```

That last row is the useful one: `costOf()` and preflight's own independent cost table agree to the
cent on the 24-turn figure. The pricing arithmetic is right; the *ledger that feeds it* is what has
not run against real numbers.

There is no unit test for `stopBeforeTurn` — `packages/discovery/test/loop.test.ts` covers
`maxTurns`, `maxActions` and `maxConsecutiveRefusals` exhaustion, not the hook. The hook is the one
addition to `packages/discovery/src/loop.ts` that the 250 discovery tests do not touch.

### 5.4 A dry run aimed at `evidence/` is refused, but not before it litters

`assertRealRecording` fires on the **destination**, so `--dry-run --out evidence/discovery-live` is
correctly refused. But `journal.jsonl` is created in the destination directory *before* the loop
runs, and the refusal happens *after* it returns — so a refused rehearsal still leaves a
`journal.jsonl` inside the protected directory. Don't aim a dry run at `evidence/`.

### 5.5 The contract offered a parameter called `value1` — **fixed**

`inferParameters` named a parameter after the accessible name of the field it was typed into. This
product's search inputs have **no accessible name at all** — which is the legacy-app reality the
whole project is about — so the fallback fired and the synthesized contract offered a calling agent
an argument called `value1`, described as *"The value to use for `value1`"*. The artifact was
perfectly executable; the *name* was the defect. The assignment's §3.2 asks for typed input
parameters and its first stretch goal is a catalog of capabilities *"an AI agent could discover and
invoke by name with typed args"* — `value1` fails that on sight, and this run was about to bake it
into the headline evidence artifact.

**Naming is now a deterministic chain over evidence the system already had.** No model is asked,
nothing is inferred from the shape of the value — a name derived from a value would put a member
number in the caller's public API — and nothing about this fixture is special-cased:

| rung | what it reads | where it comes from |
|---|---|---|
| 1 `accessible-name` | the control's own accessible name | the frozen observation |
| 2 `labelled-by` | the wording the **markup** associates with the control | `labelAnchorsOf` |
| 3 `adjacent-label` | the nearest adjacent label text, inside the same eight-control-height reach a `label-anchored` descriptor uses | `labelAnchorsOf` — same function, same node, same anchor |
| 4 `taint-handle` | for an operator-supplied secret, the parameter name the **host** chose | the taint handle, which names a binding and never a value |
| 5 `positional` | nothing. `value1` — **and a flag** | — |

Rungs 2 and 3 are literally the anchor the locator uses. `labelAnchoredOf` was refactored to walk
`labelAnchorsOf`, and the parameter namer calls that same function, so a parameter cannot be named
after a label the locator does not use — the failure mode a second, private "what is this field
called?" implementation would have shipped the first time the two disagreed. A rung is **skipped**,
not taken, when its wording carries a recorded value or a regulated shape (the same
`unsafeTextReason` guard `Vocabulary.matcher` applies to a label before it becomes a vocabulary
token), or when it does not spell a legal `FieldNameSchema` identifier. `uniqueName` keeps the
result distinct from every other parameter and from the holes route canonicalization goes on to mint.

**Rung 5 is no longer silent, and that was the real defect.** `value1` on a field with no name
anywhere is the *correct* answer; shipping it quietly is not. Reaching rung 5 now emits a
`parameter-name-underived` note at **`review`** severity — the severity that means "this artifact
cannot be approved until a person has read this" — and the contract's own parameter description
carries `NEEDS A NAME: …`, the convention `PROSE_PLACEHOLDER` already established. `pnpm discover`
prints every note, and its `parameters` line now names the rung each argument was named from:

```
      parameters      memberId:sensitive (named from adjacent-label)
```

**On this product it yields `memberId`.** riverbend's label is "Member ID"; summit's is "Member
Number", which spells `memberNumber`. Neither string appears anywhere in the engine.

**It changed the committed capability's bytes, exactly as this section warned.**
`pnpm -F @crr/discovery fixtures:synthesized` was re-run, so the seam test passes on the new bytes:
contract digest is now `sha256:77a9f415…`, artifact `sha256:e03beee2…`. **If you run the live
discovery run after this, its artifact carries the new naming; if you had already run it before,
re-synthesis would change its digest.** It is fixed *before* the spend, which is the order that
costs nothing.

Commands, all run in this working tree:

```
$ pnpm -F @crr/discovery fixtures:synthesized
  wrote corebank-web.capability.json: 74192 bytes from corebank-web.observations.json    exit 0

$ pnpm -F @crr/discovery exec vitest run test/synthesis-parameterization.test.ts \
                                         test/synthesis-corebank-web.test.ts
   ✓ test/synthesis-parameterization.test.ts (40 tests)  76ms
   ✓ test/synthesis-corebank-web.test.ts     (27 tests) 151ms
     Tests  67 passed (67)                                                              exit 0

$ pnpm -F @crr/runtime exec vitest run test/synthesized-replay.test.ts
     Tests  9 passed (9)   ← the artifact still executes, in a real browser              exit 0

$ env -u ANTHROPIC_API_KEY … TURBO_FORCE=1 pnpm test    1,820 passed, 14/14 tasks        exit 0
$ env -u ANTHROPIC_API_KEY … pnpm demo                  7/7, 48 files, canary CLEAN      exit 0
$ pnpm typecheck && pnpm lint                           315 files, no findings           exit 0
```

**Both halves are tested, and so is the stopping.** The labelled cases name the parameter and raise
no flag — one test per rung, plus a precedence test proving rung 1 beats rungs 2 and 3. The
genuinely-unlabelled case produces `value1` **and** the `review` note **and** the `NEEDS A NAME`
description. Three more assert what a derived name may never be: spelled from a recorded value (a
field labelled "Member 50001" falls through and flags rather than minting `member50001`), an illegal
identifier, or a collision. And there is a discrimination case whose *only* difference from the
passing rung-3 test is a surface that reports no `boundsUnit`: adjacency is a geometric claim, so the
chain stops one rung early rather than guessing a unit — the same condition under which
`labelAnchoredOf` declines to emit a spatial descriptor.

### 5.6 The transcript's own provenance note was wrong, and was corrected this pass

`discover.ts` was about to stamp every live transcript with *"The member number was bound as a
sensitive parameter and was never shown to the model."* That is residue from the sensitive-binding
design that `live-run.ts` records as built-then-rejected; the shipped runner passes no `secrets` map
to `runDiscoveryLoop` at all, and canary pass 4 lists 19 places the number appears. A false
provenance claim inside the one committed evidence file BRIEF §10 governs is a serious defect, so
the note (`discover.ts:1128`) and the stale file header (`:37`) were rewritten to describe what the
runner actually does. No logic changed; `pnpm typecheck` and `pnpm lint` are green.

### 5.7 `docs/design/FINAL-STATUS.md` §7.1 is now factually wrong

It still says *"THE COMMAND IS THE THING THAT IS MISSING"*, quotes a `grep` showing
`createAnthropicModel` has no caller, and reproduces a preflight verdict with a `[recorder] BLOCK`
line and two cost warnings. All four claims are false as of this pass. Regenerate it — that document
has an owner and a voice, and §7.1 cannot be rewritten in isolation without contradicting §1 and §6.

### 5.8 Leave-behinds from this rehearsal

- `.scratch/discovery-dry-run/` was overwritten with `--force`; `.scratch/budget-usd/` and
  `.scratch/budget-tokens/` are new. All gitignored. `verification-evidence/` in the dry-run bundle
  now holds **two** journals, because `--force` overwrites files but does not clean the directory.
- **`packages/discovery/.cost-check.scratch.ts` must be deleted:**
  `rm packages/discovery/.cost-check.scratch.ts`. It is the §5.3 arithmetic check; this session's
  sandbox denied every `rm` and `mv`, so it could not be removed here. It is lint-clean (biome now
  reads 313 files, not 312) and outside `tsconfig`'s `include`, so it breaks nothing — but it is not
  part of the deliverable.

---

## 6. What to check after the run

In order. Stop at the first one that fails.

1. **Exit code 0.** Anything else means one of *reached the goal / verified without a model / canary
   clean* did not hold, and the VERDICT block says which.

2. **The VERDICT block in `evidence/discovery-live/discovery.log`** — four `yes` and a dollar figure:

   ```
         discovery reached the goal    yes
         it replayed without a model   yes
         the artifact is a draft       yes
         the bundle is clean           yes
         measured spend                $0.xxxx
   ```

3. **The canary.** Passes 1, 2 and 3 `CLEAN`. Then actually read pass 4's hit list: every line should
   be `transcript.json`, `discovery.log` or `journal.jsonl`, and every needle should be the member
   number. A hit on any other file is a real leak that pass 4 does not gate on.

4. **`PENDING.md` is gone.** If it is still there, the run did not fully succeed — do not commit the
   bundle as evidence of a discovery run until you understand why.

5. **`provenance.json`** reads `"adapter": "anthropic"`, `"synthetic": false`,
   `"isEvidenceOfADiscoveryRun": true`, and a real `modelId` with no `(REHEARSAL, not called)` suffix.

6. **`spend.json` against the Anthropic console.** `totalUsd` is this repository's arithmetic over
   the token counts the provider returned. If the console disagrees materially, `MODEL_RATES` in
   `tools/live-run.ts` is stale and every cost claim in the repo needs re-deriving.

7. **The cache hit rate**, printed in the run summary and stored in `provenance.json`. This is the
   first time it has ever been measured. BRIEF §9 asks for it as evidence; §3 above predicts it will
   be unimpressive, and that prediction is itself the reportable result.

8. **Truncation.** If any turn hit `max_tokens` the runner prints a `WARNING: n turn(s) hit
   max_tokens` block naming the turns. A `tool_use` block cut off mid-JSON is refused by the loop's
   schema and the model reads that as its own mistake — re-run with `--max-output-tokens 4000`.

9. **Before `pnpm demo`:** §5.1 is fixed, so the demo will leave `PENDING.md` alone. Still run
   `grep -rn '10041\|99999\|1337\.42' evidence/discovery-live/`. It should return nothing — the live
   run is deliberately on member **10043** so that a canary hit anywhere under `evidence/` names the
   run that produced it. If the model happened to try `99999` while exploring, `pnpm demo`'s
   whole-bundle canary will fail on a value that is not a leak, and the right answer is to say so in
   the evidence rather than to loosen the canary.

10. **`pnpm demo`**, then `pnpm test`, then commit. The demo re-derives `evidence/MANIFEST`,
    `evidence/README.md` and the whole-bundle canary so the live bundle is covered by them too.

---

## 7. What this rehearsal proves, and what it does not

**Proves.** That the composition root runs: fixture boot, browser, driver, loop, policy chokepoint,
recorder, VCR round-trip under *strict* digest checking, synthesis, verification replay in a fresh
session, bundle writer, four canary passes, verdict, exit code. That both spend guards halt the loop
cleanly at the pre-turn-1 boundary and keep everything they have. That `--yes` refuses with a funded
credential in the process. That a `DiscoveryModelError` mid-run now does the same thing the budget
guard does — §5.2, and the eighteen tests behind it. That a synthesized capability offers a calling
agent an argument named after what the screen calls the field rather than `value1`, and says so out
loud when it cannot — §5.5, and the fifteen tests behind that. The suite stands at 1,820,
thirty-five of them added by §5.1, §5.2 and §5.5 and none of them removed or weakened; `pnpm demo`
was re-run after §5.5 at 7/7, 48 files, canary CLEAN.

It also proves one thing nobody set out to test. The rehearsal records a transcript against a live
browser and replays it through `createReplayModel` with **strict message-digest checking on**, in a
second browser session — and it passes. The projection the model is shown is byte-stable across two
independent browser sessions of the same application.

**Does not prove.** That a real model can do this task. That is the entire reason the live run is
worth paying for, and no amount of rehearsal substitutes for it. It also does not exercise the
Anthropic adapter's request body or its error mapping — those are hermetic unit tests in
`packages/discovery/test/anthropic-adapter.test.ts` — nor, per §5.3, the spend ledger against real
provider numbers.

**No live model API call was made at any point in producing this document, to any provider.** For the
rehearsal runs the three credential variables were shadowed with obviously-fake values so that a bug
could not have authenticated even in principle; only the `--yes` gate demonstration was run with the
real key loaded, and it stopped before a client was constructed.
