// Reading a run's journal back, for the measurements that need more than the arm.
//
// WHY THIS FILE EXISTS RATHER THAN A `switch` ON `event.type`.
//
// `@crr/core` builds its journal union with a helper whose signature is `event(type: string, ...)`,
// so every member's `type` infers as `string` rather than as its own literal. The union is a real
// discriminated union ON THE WIRE - `JournalEventSchema` is a `z.discriminatedUnion` and every
// event is parsed against it before it is written - but the TYPE that comes out the other side does
// not discriminate, so `event.type === "resolved"` narrows nothing and `event.descriptors` does not
// typecheck.
//
// That is a defect in core's type, not in the data, and widening it there is a change with a blast
// radius across five packages (`JournalEventInput` in `@crr/runtime` is a mapped type keyed on
// `E["type"]`, and it collapses today for the same reason). It is reported rather than fixed under
// a stability unit.
//
// So the narrowing happens HERE, once, in a file that says what it is doing and why. Each reader
// checks the tag and then asserts the shape the schema in `@crr/core` has already enforced at write
// time - the assertion is over a value that a `strictObject` parse has passed, not over a hopeful
// guess about a JSON blob. If core's schema changes, `test/journal-view.test.ts` fails, because it
// asserts these readers against a real run rather than against a hand-built object.

import type { DescriptorVerdict, JournalEvent } from "@crr/core";

/** One descriptor's outcome inside a `resolved` event. Mirrors `@crr/core`'s journal schema. */
export interface DescriptorOutcome {
  readonly id: string;
  readonly kind: string;
  readonly evidenceSource: string;
  readonly verdict: DescriptorVerdict;
  readonly nodeId: string | null;
}

export interface ResolvedEvent {
  readonly stepId: string;
  readonly descriptors: readonly DescriptorOutcome[];
  readonly agreed: boolean;
  readonly distinctSources: number;
}

export interface SettledEvent {
  readonly stepId: string;
  readonly polls: number;
  readonly elapsedMs: number;
  readonly settled: boolean;
}

export interface CheckpointEvent {
  readonly stepId: string;
  readonly passed: boolean;
}

const tagged = <T>(events: readonly JournalEvent[], type: string): readonly T[] =>
  events.filter((e) => e.type === type) as readonly unknown[] as readonly T[];

/** Every target resolution in the run, in order. */
export const resolvedEvents = (events: readonly JournalEvent[]): readonly ResolvedEvent[] =>
  tagged<ResolvedEvent>(events, "resolved");

/** Every settle loop in the run, in order. `polls` is what the settle sweep measures cost in:
 *  a poll is a real `perceive()` and a real charge against the observation ledger, whereas the
 *  elapsed milliseconds on a manual clock are an arithmetic restatement of the poll count. */
export const settledEvents = (events: readonly JournalEvent[]): readonly SettledEvent[] =>
  tagged<SettledEvent>(events, "settled");

export const checkpointEvents = (events: readonly JournalEvent[]): readonly CheckpointEvent[] =>
  tagged<CheckpointEvent>(events, "checkpoint");
