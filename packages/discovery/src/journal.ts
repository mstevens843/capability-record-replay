// The discovery journal.
//
// SPEC section 1.1 requires that during discovery "every tool call passes PolicyEngine.check and is
// journaled". `@crr/core`'s `JournalEvent` is the REPLAY journal: `run.started` needs an artifact
// digest and `step.entered` needs a `StepId`, and during discovery neither exists yet - the whole
// point of the run is to produce the artifact those fields name. Bending the replay journal to fit
// would mean inventing a digest for a document that does not exist, which is exactly the kind of
// plausible-looking fiction this repo is not allowed to put in an audit trail.
//
// So discovery has its own event stream, deliberately overlapping the replay one where the events
// really are the same event: `policy.decided`, `acted` and `observed` carry the same fields, with
// the same redaction rules, so a reader of one journal can read the other and the conformance
// suite can eventually diff them. The discovery-only events are the ones about the MODEL, which
// replay does not have because replay has no model.
//
// REDACTION. Two rules, both enforced here rather than asked for in prose:
//   · `acted` carries a taint handle and a length, never text - copied from `@crr/core`'s journal
//     for exactly that reason;
//   · `tool.called` carries the input with every `TaintedValue` replaced by its handle, via
//     `redactDeep`. A tool input is the single most likely place for a bound value to escape,
//     because it is the one structure in this loop that is both model-shaped and logged.

import { redactDeep } from "@crr/core";
import { ActFaultKindSchema, ActionKindSchema, EffectClassSchema } from "@crr/core";
import { PolicyDecisionSchema, TaintHandleSchema, TimestampSchema } from "@crr/core";
import type { DeepReadonly } from "@crr/core";
import { z } from "zod";
import { TOOL_NAMES } from "./tools.js";

const envelope = {
  seq: z.int().nonnegative(),
  /** Injected by the caller. This package has a clock available; the loop does not read one
   *  directly, so a test can drive the whole thing from a frozen sequence. */
  at: TimestampSchema,
} as const;

/**
 * `N extends string` rather than a plain `string` parameter, and that is not a style choice.
 *
 * With `type: string` the inferred discriminant is `string`, the union stops being a discriminated
 * one, and `event.type === "acted"` narrows nothing - so every consumer ends up casting, which is
 * exactly the thing a discriminated union exists to prevent. Capturing the literal keeps narrowing
 * working all the way out to the test that reads the journal.
 */
const event = <N extends string, T extends z.core.$ZodShape>(type: N, shape: T) =>
  z.strictObject({ ...envelope, type: z.literal(type), ...shape });

export const ModelUsageSchema = z.strictObject({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cacheCreationInputTokens: z.int().nonnegative(),
  cacheReadInputTokens: z.int().nonnegative(),
});

export const DiscoveryEventSchema = z.discriminatedUnion("type", [
  event("loop.started", {
    adapter: z.string().min(1).max(64),
    modelId: z.string().min(1).max(128),
    /** The goal SHAPE, not the goal. A goal is free text a person typed and it is where a member
     *  number arrives; the journal records its length and digest so two runs can be told apart
     *  without the audit trail carrying the number. */
    goalLength: z.int().nonnegative(),
    tenantId: z.string().min(1).max(64),
  }),
  event("turn.requested", {
    turn: z.int().positive(),
    messages: z.int().nonnegative(),
    tools: z.int().nonnegative(),
  }),
  event("turn.responded", {
    turn: z.int().positive(),
    stopReason: z.string().max(64).nullable(),
    toolCalls: z.int().nonnegative(),
    usage: ModelUsageSchema,
    latencyMs: z.int().nonnegative(),
  }),
  event("tool.called", {
    turn: z.int().positive(),
    toolUseId: z.string().min(1).max(128),
    name: z.enum(TOOL_NAMES),
    /** Redacted with `redactDeep` before it gets here. */
    input: z.unknown(),
  }),
  event("tool.refused", {
    turn: z.int().positive(),
    toolUseId: z.string().min(1).max(128),
    name: z.string().max(64),
    reason: z.enum(["unknown-tool", "invalid-input", "stale-node-ref", "policy-denied", "budget"]),
    detail: z.string().max(1000),
  }),
  event("observed", {
    obsSeq: z.int().nonnegative(),
    skeletonDigest: z.string().min(1).max(128),
    settled: z.boolean(),
    nodeCount: z.int().nonnegative(),
    /** How much of the observation the model was actually shown. The gap between this and
     *  `nodeCount` is the filter doing its job, and it is the number the cost story is told with. */
    projectedNodes: z.int().nonnegative(),
  }),
  event("policy.decided", {
    decision: PolicyDecisionSchema,
    actionKind: ActionKindSchema,
    effect: EffectClassSchema,
  }),
  event("acted", {
    actionKind: ActionKindSchema,
    targetTitle: z.string().max(200),
    valueRef: TaintHandleSchema.nullable(),
    valueLength: z.int().nonnegative().nullable(),
    result: z.union([z.literal("dispatched"), ActFaultKindSchema]),
  }),
  event("output.noted", {
    outputName: z.string().min(1).max(64),
    targetTitle: z.string().max(200),
  }),
  /**
   * The loop caught a throwable and kept the run. Emitted immediately before `loop.finished`.
   *
   * It is a separate event rather than three more optional fields on `loop.finished` because the
   * journal is what survives when nothing else does, and `grep loop.failed journal.jsonl` should
   * be the whole question. `message` is provider prose and is capped on the way in; the STACK is
   * deliberately absent - it carries absolute paths from the machine the run happened on, and an
   * audit trail is forever.
   */
  event("loop.failed", {
    /** 1-based turn that was in flight, or 0 if nothing had been requested yet. */
    turn: z.int().nonnegative(),
    errorName: z.string().min(1).max(128),
    adapter: z.string().max(64).nullable(),
    message: z.string().max(1000),
  }),
  event("loop.finished", {
    status: z.enum(["reached-goal", "stuck", "budget-exhausted", "model-stopped", "failed"]),
    turns: z.int().nonnegative(),
    actions: z.int().nonnegative(),
    usage: ModelUsageSchema,
    cacheHitRate: z.number().min(0).max(1),
  }),
]);
export type DiscoveryEvent = DeepReadonly<z.infer<typeof DiscoveryEventSchema>>;

/** Where events go. Synchronous and total: a journal that can fail is a journal that stops the run,
 *  and the audit trail must never be the thing that breaks the thing it is auditing. */
export type DiscoveryJournalSink = (event: DiscoveryEvent) => void;

/**
 * A sink that keeps everything in memory, validating on the way in.
 *
 * Validation is not paranoia about our own code. The journal is the input to the evidence bundle
 * (unit 18) and to the redaction canary, and an event that does not parse is an event that will be
 * silently dropped by whoever reads it back off disk - at which point the audit trail has a hole
 * exactly where the interesting thing happened.
 */
export class InMemoryDiscoveryJournal {
  readonly #events: DiscoveryEvent[] = [];
  #seq = 0;

  /** Next sequence number. Exposed so the loop can stamp an event it builds itself. */
  next(): number {
    return this.#seq++;
  }

  readonly write: DiscoveryJournalSink = (event) => {
    this.#events.push(DiscoveryEventSchema.parse(event) as DiscoveryEvent);
  };

  get events(): readonly DiscoveryEvent[] {
    return this.#events;
  }
}

/** Replace every `TaintedValue` in a tool input with its opaque handle before it is journaled or
 *  recorded. Re-exported through this module so that `grep -n redactToolInput` finds every place a
 *  model-authored structure crosses into a persisted one. */
export function redactToolInput(input: unknown): unknown {
  return redactDeep(input);
}
