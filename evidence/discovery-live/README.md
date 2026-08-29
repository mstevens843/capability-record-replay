# discovery-live

**A real discovery run.** A model was in the loop, it was called over the network, and the run was billed to the author's Anthropic project.

| | |
|---|---|
| adapter | `anthropic` |
| model id | `claude-opus-5` |
| effort | `high` |
| max_tokens per turn | 2000 |
| recorded at | 2026-08-28T02:24:10.144Z |
| command | `pnpm discover --yes` |
| status | `reached-goal` |
| turns | 9 |
| verification | verified / full |
| artifact lifecycle | `draft` |

## Files

| file | what it is |
|---|---|
| `transcript.json` | the full VCR recording: every request's message digest, every response, every tool call, per-turn token usage and `cache_read_input_tokens`. |
| `discovery.log` | what the runner printed, including the live spend after every turn. |
| `journal.jsonl` | the discovery journal. Every tool call passed `PolicyEngine.check` and is journaled, exactly as a replay action is. |
| `synthesized/` | the contract, the artifact and the synthesis report. See its own README. |
| `verification.json` | the self-replay with the model out of the loop, and the result document it produced. |
| `verification-journal.jsonl` | that replay's journal. |
| `verification-evidence/` | the observations that replay froze, with every bound value redacted. |
| `provenance.json` | adapter, model id, prompt version, measured usage, measured cache hit rate, measured spend. |
| `spend.json` | the per-turn cost ledger the budget guard decided on. |
| `canary/` | the four redaction passes this run performed, and what each searched for. A fifth was added afterwards — see below. |

## Where the member number is, and where it is not

Every value here is synthetic — see `fixtures/corebank-web/src/data.js`. Member 10043
is deliberately **not** the member `pnpm demo` uses, so a canary hit anywhere under
`evidence/` names the run that produced it without ambiguity.

The number **is** in `transcript.json`, `discovery.log` and `journal.jsonl`, and that is not a
leak: the model had to be told which member to look up, it typed the number, and the
application printed it back in the results grid and in its own query string. A discovery
recording that did not contain it would be a recording of a different conversation. The
canary's fourth pass lists every one of those occurrences with its line number, so the claim
is checkable rather than asserted.

The number is **not** in `synthesized/`, because parameterization replaced it — including in
the model's own `why` prose, which becomes `Step.intent`. It is **not** in anything the
verification replay wrote, because at replay time it is an argument the interpreter binds as a
`TaintedValue` and SPEC §8.3's sink table applies in full. Those two are the canary's first and
second passes, and both gate the exit code.

Member names and balances appear in the transcript (the model was shown the screen) and in the
replay result (the caller asked for them). What they must never do is appear in `synthesized/`,
and the first pass searches for them there too.

## A fifth canary pass, added after this run

> Added by hand after the run, by the same convention as the section below it: the run cannot
> describe a pass that did not exist when it executed, and a reviewer reading `canary/` should not
> have to conclude from four reports that this directory's own metadata is ungated.

`canary/` holds four reports because this run was made with the four-pass runner. A **fifth gating
pass** was added afterwards, in `packages/discovery/tools/canaries.ts`, and re-run over this bundle:
**CLEAN**, 3 files, 27 needles, 0 hits, self-test 27/27.

It covers `provenance.json`, `spend.json` and this `README.md` — everything the run writes *about*
itself rather than as a record of it — and it searches for **recorded member data**: the values the
run read off the screen. Those are legitimate in the recording (the model was shown the screen) and
in the replay result (they are the outputs the caller asked for), and in nothing else. It does
**not** search for the member number, which the three files above state on purpose; gating on that
would make the pass unpassable for the same reason the fourth pass is not gated.

Its scope is the **complement** of the other four, so a file added here later is scanned by default.
`packages/discovery/test/canary-scopes.test.ts` (56 tests) reads this directory off disk and asserts
that every path in it is covered, and that planting a member's name in `provenance.json` fails the
pass by file and by needle. The four reports in `canary/` were not re-emitted, because re-emitting
them means another live run.

## Two digests for one artifact — read this before you diff them

> Added by hand after the run, because the run itself does not explain it and a reviewer who checks
> the content addressing deserves the answer rather than a puzzle.

```
discovery.log:71                    artifact digest sha256:923ab02f…   (as synthesized, `proposed`)
verification.json:42  result.run.artifact.digest sha256:923ab02f…
synthesized/artifact.json:10                     sha256:32e56a6f…      (as written, `draft`)
```

`ARTIFACT_DIGEST_EXCLUDED_FIELDS` (`packages/core/src/documents.ts`) is
`["digest", "signatures", "lifecycle"]`. **`verification` is not on it**, and `verifyAndDraft` writes
`{ mode, status, coveredThroughStep, grade, runId, at }` into the artifact after the replay that
promoted it. So the digest recorded *during* the run is the digest of the document *before* that
stamp, and the file on disk is the document *after* it.

Nothing is broken: `artifact.json` re-digests to `32e56a6f…`, so it is self-consistent, and an
approval would sign that value, which is stable from then on. But `verification.runId` and
`verification.at` are non-deterministic, which means **the shipped artifact's content address is not
reproducible from the recording** even though synthesis itself is. By the same argument that excludes
`lifecycle`, `verification` is mutable state *about* the program rather than the program, and belongs
on the excluded list. That is a one-line change plus a re-emit; it moves every committed artifact's
digest, so it was not made for this submission. It is named in `REPORT.md` §7 and in the README's
limitations list.

## One file in `verification-evidence/`

`verification.json` references exactly one frozen observation,
`journal-e95e0286….json`. Two others from earlier attempts of the run were sitting in this directory
and have been removed; they were canary-clean and referenced by nothing.
