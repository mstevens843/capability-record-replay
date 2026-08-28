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
| `canary/` | all four redaction passes, and what each searched for. |

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
