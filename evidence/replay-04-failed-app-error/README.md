# replay-04-failed-app-error

**an application error page that will not clear**

| | |
|---|---|
| arm | `failed` (expected `failed`) |
| taxonomy | hard failure |
| fault injected | `app-error` at `detail`, sticky |
| session broker | can-reauthenticate |
| produced by | `@crr/runtime` `replay()` over `@crr/surface-browser`, no model |

The one restart the taxonomy allows a READ run is spent against a broker that CAN re-establish the session, and then the run STOPS. The failure names the step, what was expected, what was observed and what an operator should do - and it is never promoted into a business outcome just because the content region is empty.

## Files

- `result.json` - the result document the calling agent receives.
- `journal.jsonl` - the structured journal, one event per line, written as the run happened.
- `run.log` - this scenario's section of the demo console output.
- `observations/` - content-addressed frozen `Observation`s. Each one turns this run into a
  `classify()` unit test with no reproduction step, and each has been through
  `redactObservation` before a byte was written.
