# replay-02-outcome-member-not-found

**the core holds no such member**

| | |
|---|---|
| arm | `outcome` (expected `outcome`) |
| taxonomy | expected business outcome |
| fault injected | `not-found` at `results`, sticky |
| session broker | can-reauthenticate |
| produced by | `@crr/runtime` `replay()` over `@crr/surface-browser`, no model |

MEMBER_NOT_FOUND arrives on the `outcome` arm with the caller guidance copied verbatim from the reviewed contract. It is an answer, not an exception, and the run stops at the step that detected it.

## Files

- `result.json` — the result document the calling agent receives.
- `journal.jsonl` — the structured journal, one event per line, written as the run happened.
- `run.log` — this scenario's section of the demo console output.
- `observations/` — content-addressed frozen `Observation`s. Each one turns this run into a
  `classify()` unit test with no reproduction step, and each has been through
  `redactObservation` before a byte was written.
