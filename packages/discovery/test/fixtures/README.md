# `@crr/discovery` test fixtures

## `corebank-member-lookup.synthetic.transcript.json` — NOT EVIDENCE

**The model's side of this transcript was written by hand.** No model produced it, no provider was
called, and no tokens were spent. It exists so that the discovery loop, the tool schemas and the VCR
mechanism can be exercised in CI with **no credentials present**, which is a hard requirement of the
submission (BRIEF §10, §11).

It is marked `"synthetic": true` in the file itself, its `provenance.adapter` is `scripted`, and
`assertRealRecording()` throws on it. Every token count in it is **zero**, and therefore so is its
cache hit rate — inventing plausible-looking token counts is how a fabricated number ends up quoted
in a README as if somebody had measured it.

**It must never be presented as evidence of a discovery run.** Real transcripts come from the
`anthropic` adapter against the live API, in a run the author has explicitly approved, and they will
carry `"synthetic": false` with a real `recordedAt`.

What *is* real about it: the system prompt, the tool definitions, the message history, the
projection the model was shown, the policy decisions and the recorded steps. All of those were
produced by the shipping code paths, which is what makes a prompt or tool-schema change show up here
as a red test instead of as a surprise on a live run.

### Regenerating

```
pnpm -F @crr/discovery fixtures:synthetic    # rewrite the transcript AND the openai cassette
pnpm -F @crr/discovery fixtures:digests      # print the golden digests test/tool-schema.test.ts pins
```

Neither command makes a network call or needs a key.

## `corebank-member-lookup.synthetic.openai.cassette.json` — ALSO NOT EVIDENCE

The **HTTP-level** cassette for the `openai` adapter (SPEC §11 unit 23). Same rules as above and for
the same reasons: the model turns are the hand-authored `SCRIPT` from `build-transcript.ts`,
mechanically translated into the Chat Completions response shape. No provider was called, every
token count is zero, and it is marked `"synthetic": true` in the file.

**Why a second cassette when the VCR already exists.** `Transcript` records the *port* —
`ModelTurnRequest` in, `ModelTurnResponse` out — which is the right level for replaying a
conversation and the wrong level for testing an adapter, because an adapter's entire job is the
translation on either side of that port. A port-level fixture replays straight past every line of
`src/adapters/openai.ts`. This cassette sits one layer lower, at the HTTP boundary, and the player
also **records the request bodies the adapter built** so a test can assert on the bytes we would
have sent.

It is generated from the same script as the Anthropic-side fixture on purpose. A cassette written
independently could drift into testing a different conversation, and then "the same loop completes
against a second provider" would be true of two different loops.

## The other files

- `corebank.ts` — a frozen `Observation` corpus and a `MockSurface` script for the riverbend
  member-lookup flow. **All data is obviously synthetic**: member 50001, "AVERY SYNTHETIC".
- `build-transcript.ts` — the hand-authored model turns, and the function that runs the real loop
  over them.
- `build-openai-cassette.ts` — the same turns translated to the Chat Completions response shape,
  plus `playCassette()`, which returns the injectable `fetch` the adapter tests use. It has no
  socket and cannot acquire one.
- `regenerate.ts`, `print-digests.ts` — the two entrypoints above.

## Why `**/*.transcript.json` is in biome's ignore list

A recorded transcript is a **record of a run**, and the byte-comparison in `test/vcr.test.ts` is the
prompt/tool-schema regression detector. A formatter rewriting the file would edit the record and
break the detector, and the two would then fight: `pnpm lint --fix` reformats it, then
`fixtures:synthetic` rewrites it, forever. Same precedent, and the same argument, as `evidence/` and
the two spike directories already in that list.

---

## `corebank-web.observations.json` and `corebank-web.capability.json` — the discovery → replay seam

These two files exist to close FINAL-STATUS §7.2: **no test had ever replayed a synthesized
artifact**, so the cycle the whole submission is about — the model discovers, the artifact becomes a
reusable capability, deterministic replay invokes it — had never been run end to end.

`packages/runtime/test/synthesized-replay.test.ts` reads `corebank-web.capability.json` off disk and
executes it through the real interpreter against the real `fixtures/corebank-web` in a real browser.
It does **not** import `@crr/discovery`, and it must not: no package in this workspace holds both
halves, and BRIEF §3.9 says why that is right rather than a limitation — **the artifact is data, not
code**. The seam between the half that writes the program and the half that executes it is a file
with a content address that either parses or does not.

### The two files

| File | Contains | Regenerated by | Needs |
|---|---|---|---|
| `corebank-web.observations.json` | Four frozen `Observation`s (99 / 100 / 130 / 159 nodes) captured from `fixtures/corebank-web` through `@crr/surface-browser` over CDP `Accessibility.getFullAXTree`, plus that driver's `SurfaceCapabilities` | `pnpm -F @crr/discovery fixtures:capture` | a Chromium build |
| `corebank-web.capability.json` | The `contract`, `artifact` and synthesis `report` emitted from a discovery run over that corpus | `pnpm -F @crr/discovery fixtures:synthesized` (also run by `fixtures:capture`) | nothing |

**The screens are real. The model is not.** These are the accessible names this product actually
computes — the search fields have none — the container paths its frameset actually produces, and the
table positions its header-less grid actually yields. That is the whole reason the emitted artifact
can be executed against the live application rather than only against a mock. The model's turns are
the hand-authored `SCRIPT` in `corebank-web.ts`: no provider was called, no token was spent, the
run's provenance records `adapter: "replay"` / `modelId: "synthetic-script"`, and **neither file is
evidence of a discovery run**. See `evidence/discovery-live/PENDING.md` for what would be.

### Why the corpus is safe to commit

The driver canonicalized `/member/10041` to `/member/:memberId` before the file existed (SPEC §3.6),
so no route in it carries a member number. The member data that *is* in it — 10041, "ALVAREZ, DANA
(SYNTHETIC)" — is fixture data from `fixtures/corebank-web/src/data.js` and exists nowhere else.
None of it survives into the emitted documents: `test/synthesis-corebank-web.test.ts` greps the
sealed contract and artifact for the member number, the member's name and the balance, and finds
none of them.

### Drift

`test/synthesis-corebank-web.test.ts` rebuilds `corebank-web.capability.json` in process, from the
same function the emit script calls, and compares the **bytes**. Change anything under
`src/synthesis/` and it goes red naming the command that fixes it. Regenerate, and the runtime test
then executes whatever the new synthesis emitted. There is no path from "synthesis emits something
the interpreter cannot run" to a green board.

The hand-authored node references (`REFS`) are `n<k>` indices into an observation's node list, which
is the contract SPEC §6.2 gives the model. An integer that has quietly come to mean a different
control is the worst way this fixture could fail, so `checkRefs` asserts the role *and* the
accessible name of every referenced node before any run starts, and the capture script refuses to
write a corpus that fails it.

### Why `**/*.observations.json` and `**/*.capability.json` are in biome's ignore list

Same reason as `**/*.transcript.json`: both are records that a test compares byte for byte, and a
formatter rewriting one would edit the record and break the comparison.
