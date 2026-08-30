# replay-01-green

**the nine-step share-position flow, no fault armed**

| | |
|---|---|
| arm | `ok` (expected `ok`) |
| taxonomy | green |
| fault injected | none |
| session broker | can-reauthenticate |
| produced by | `@crr/runtime` `replay()` over `@crr/surface-browser`, no model |

A deterministic replay with no model anywhere in the decision path returns four typed outputs from a frameset-era application with no test ids.

## Files

- `result.json` - the result document the calling agent receives.
- `journal.jsonl` - the structured journal, one event per line, written as the run happened.
- `run.log` - this scenario's section of the demo console output.
- `observations/` - content-addressed frozen `Observation`s. Each one turns this run into a
  `classify()` unit test with no reproduction step, and each has been through
  `redactObservation` before a byte was written.
