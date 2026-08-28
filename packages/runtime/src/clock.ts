// The clock, as a port.
//
// `@crr/core` has no clock and two contract tests keep it that way, so every "now" the replay
// engine needs is minted HERE and passed down as a value: `PolicyMoment.now`, `Timestamp` on a
// journal event, `elapsedMs` on a `ClassifierInput`. That is not ceremony. A settle loop, a lease
// expiry and a run deadline are the three things in this system that are hardest to test and
// easiest to get wrong, and all three become ordinary unit tests the moment time is an argument.
//
// Two separate readings, deliberately:
//
//   · `now()` is a WALL-CLOCK timestamp. It goes in the journal and in a lease expiry, and it is
//     the one a human reads. It can jump backwards when a machine syncs its clock.
//   · `elapsedMs()` is MONOTONIC. Every budget in SPEC section 3.4 is compared against it, because
//     a run deadline that a clock adjustment can extend is not a deadline. `performance.now()`
//     rather than `Date.now()` for exactly that reason.
//
// `sleep` is on the port too, so the settle loop's poll interval is a fake in a unit test rather
// than a real 150 ms multiplied by every scenario in the conformance corpus.

import { type Timestamp, TimestampSchema } from "@crr/core";

export interface Clock {
  /** ISO-8601 UTC with a trailing `Z`, millisecond precision - the shape `TimestampSchema` takes. */
  now(): Timestamp;
  /** Milliseconds since this clock was created. Monotonic; never derived from the wall clock. */
  elapsedMs(): number;
  sleep(ms: number): Promise<void>;
}

/** Milliseconds since the epoch, as an ISO timestamp the schema accepts. */
export function timestampOf(epochMs: number): Timestamp {
  return TimestampSchema.parse(new Date(epochMs).toISOString());
}

/**
 * The real one. `performance.now()` for elapsed time, `Date.now()` for the wall clock, and the two
 * are never mixed.
 */
export function systemClock(): Clock {
  const startedAt = performance.now();
  return {
    now: () => timestampOf(Date.now()),
    elapsedMs: () => Math.max(0, Math.round(performance.now() - startedAt)),
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, Math.max(0, ms));
      }),
  };
}

export interface ManualClock extends Clock {
  /** Advance both readings by `ms`. Any `sleep` waiting for that point resolves. */
  advance(ms: number): void;
}

/**
 * A clock a test drives.
 *
 * `sleep` here does NOT wait: it advances the clock by the requested amount and resolves on the
 * microtask queue. That makes a settle loop with a 150 ms poll interval and an 8 s budget run in
 * microseconds while still spending exactly the budget it would have spent in real time - so the
 * ASSERTION a test makes about polls and elapsed milliseconds is the same one that would hold
 * against a wall clock, which a `setTimeout(0)` stub would not give.
 */
export function manualClock(startEpochMs = Date.parse("2026-02-11T14:00:00.000Z")): ManualClock {
  let elapsed = 0;
  return {
    now: () => timestampOf(startEpochMs + elapsed),
    elapsedMs: () => elapsed,
    sleep: async (ms) => {
      elapsed += Math.max(0, ms);
    },
    advance: (ms) => {
      elapsed += Math.max(0, ms);
    },
  };
}
