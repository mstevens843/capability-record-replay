# replay-05-failed-session-expired

**the session expires mid-flow and cannot be re-established**

| | |
|---|---|
| arm | `failed` (expected `failed`) |
| taxonomy | hard failure |
| fault injected | `session-timeout` at `detail`, sticky |
| session broker | cannot-reauthenticate |
| produced by | `@crr/runtime` `replay()` over `@crr/surface-browser`, no model |

The declared `SESSION_EXPIRED` rule delegates to the session broker rather than logging in - there is nowhere in the artifact a credential could be written down. THIS DEPLOYMENT'S BROKER CANNOT RE-AUTHENTICATE, which is the only configuration in which `session-expired-unrecoverable` is reachable at all, so the condition is reported as a hard failure instead of being retried forever.

## Files

- `result.json` - the result document the calling agent receives.
- `journal.jsonl` - the structured journal, one event per line, written as the run happened.
- `run.log` - this scenario's section of the demo console output.
- `observations/` - content-addressed frozen `Observation`s. Each one turns this run into a
  `classify()` unit test with no reproduction step, and each has been through
  `redactObservation` before a byte was written.
