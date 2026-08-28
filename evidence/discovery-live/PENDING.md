# discovery-live — EMPTY, ON PURPOSE

**This directory holds nothing. That is the honest state of this deliverable today.**

The assignment asks for logs from a discovery run. A discovery run puts a model in the loop:
it calls the Anthropic Messages API, it costs the author money, and under `.private/BRIEF.md`
§11 no agent working on this repository may make a live model call — live runs are initiated
by the author, for a specific approved run, and nothing else.

So the mechanism is built and the slot is empty, rather than the slot being filled with
something that looks like a discovery run and is not.

## What will land here

| File | What it is |
|---|---|
| `transcript.json` | The full VCR recording of the run: requests, responses, tool calls, timings, token usage, and `usage.cache_read_input_tokens` per turn. Redacted by the same taint model as everything else — a recorded transcript is a persisted artifact. |
| `discovery.log` | The observe → decide → act loop's console output: the filtered `Observation` the model was shown each turn, the node id it picked, the policy decision on each tool call. |
| `journal.jsonl` | The discovery journal. Every tool call passes `PolicyEngine.check` and is journaled, exactly as a replay action is. |
| `synthesized/` | `contract.json` + `artifact.json` as **synthesis** emitted them, plus the `SynthesisReport`. |
| `verification.json` | The immediate self-replay with the model out of the loop. The artifact is only saved as `draft` if this passes. |
| `provenance.json` | Adapter (`anthropic`), model id, prompt version, measured cache hit rate. |

## What is NOT allowed to land here

- A transcript replayed from a VCR fixture. Those exist (`packages/discovery/test/`) and they
  are how the loop is tested with no credential — but a replayed fixture is not a live run and
  presenting one as evidence would be the exact dishonesty this file exists to avoid.
- A run driven by a human or by a coding agent through a manual driver. That is a debugging
  aid, not a discovery run.
- A run through the `agent-sdk` adapter. It draws on a Claude Code subscription and it runs
  Claude Code's loop rather than ours, so it validates neither our prompt shape nor our tool
  schemas.

## What the rest of the bundle does and does not establish without it

Every other directory here is a **replay**, which is the half of the system that runs in
production with no model in the decision path. They establish that the interpreter, the
classifier, the descriptor agreement check, the policy chokepoint, the taint model and the
typed result contract work against a real hostile surface.

They do **not** establish that a model can discover this flow unaided. Nothing in this bundle
does, and until `transcript.json` exists that claim is not made.
