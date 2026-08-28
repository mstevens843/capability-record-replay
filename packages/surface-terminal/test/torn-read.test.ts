// The acceptance case for the whole unit: QUIESCENCE PROPOSES, THE CHECKPOINT DISPOSES.
//
// A character surface has no load event. The only readiness signal a transport offers is silence,
// and silence is not evidence - an application that stalls halfway through a repaint is silent in
// exactly the way an application that has finished one is silent. The spike measured this rather
// than asserting it might happen: 55% of a frame delivered, then a pause longer than the quiet
// window, and the observation that came back had `screenId: null` and three nodes instead of eight.
//
// This file reproduces that on demand through the fixture's `torn-repaint` fault and then makes the
// point that matters: the torn observation IS reported settled, and it FAILS the step's checkpoint.
// The tear is therefore a detected condition rather than a silent misread, and the design
// conclusion is the same one the browser driver reaches by a different road - readiness is the
// checkpoint, never the settle loop.
//
// Note what is NOT the fix. Raising the quiet window does not make this sound; no window does,
// because the application can always pause for longer than whatever number is chosen. That is why
// `requiresSettled: true` is a precondition for a negative business outcome and never a substitute
// for verifying what is on the screen.

import { type Predicate, PredicateSchema, evaluatePredicate } from "@crr/core";
import { describe, expect, it } from "vitest";
import { detect } from "../src/detect.js";
import { observationOf } from "../src/observe.js";
import { grid, screen } from "./support/corpus.js";
import { contextFor } from "./support/eval.js";
import { openTeller } from "./support/teller.js";

/**
 * The checkpoint a `navigate to member inquiry` step would declare: the screen is settled, we are
 * on the screen we meant to be on, and the control we are about to use is there.
 *
 * Parsed through the real schema rather than written as a bare object, so this is provably a
 * predicate an artifact could carry and not a shape only this test can express.
 */
const CHECKPOINT: Predicate = PredicateSchema.parse({
  all: [
    { kind: "settled" },
    {
      kind: "node-exists",
      where: {
        scope: {
          path: [
            {
              kind: "screen",
              id: { mode: "exact", value: "MEMBER INQUIRY 01", normalize: "std.text@1" },
            },
          ],
        },
        role: "textbox",
        name: { mode: "exact", value: "Account Number", normalize: "std.label@1" },
      },
    },
    {
      kind: "count",
      where: { role: "button" },
      op: "gte",
      n: 3,
    },
  ],
} satisfies Predicate);

const stableStability = { settled: true, generation: 1, pendingReason: null } as const;

const observe = (name: string) =>
  observationOf(detect(grid(name)), {
    seq: 0,
    driver: "surface-terminal@test",
    surfaceKind: "terminal",
    stability: stableStability,
  }).observation;

describe("a torn repaint, taken from the committed corpus", () => {
  it("yields a DIFFERENT observation from the whole frame", () => {
    const torn = screen("torn");
    const whole = screen("tornWhole");
    expect(torn.screenId).toBeNull();
    expect(whole.screenId).toBe("MEMBER INQUIRY 01");
    expect(torn.nodes).toHaveLength(3);
    expect(whole.nodes).toHaveLength(8);
  });

  it("loses the screen-id band, so the container path is empty and every scope stops matching", () => {
    const torn = observe("torn");
    expect(torn.nodes.every((node) => node.containerPath.length === 0)).toBe(true);
    const whole = observe("tornWhole");
    expect(whole.nodes.every((node) => node.containerPath.length === 1)).toBe(true);
  });

  it("FAILS the checkpoint, while the whole frame passes it", () => {
    // The acceptance assertion. Both observations claim `settled: true`; only one of them is the
    // screen the step was waiting for.
    expect(evaluatePredicate(CHECKPOINT, contextFor(observe("torn")))).toBe(false);
    expect(evaluatePredicate(CHECKPOINT, contextFor(observe("tornWhole")))).toBe(true);
  });
});

describe("the same tear, live, through the driver", () => {
  it("reports SETTLED on a half-painted screen - which is why the checkpoint is the gate", async () => {
    const harness = await openTeller({ fault: "torn-repaint", delayMs: 500, quietMs: 20 });
    try {
      // The fixture has delivered 55% of its first frame and gone quiet. The surface's own
      // readiness signal is exhausted: nothing else it can measure will tell it the truth.
      const torn = await harness.observe();
      expect(torn.stability.settled).toBe(true);
      expect(torn.stability.pendingReason).toBeNull();

      // And it is wrong. This is the false success the checkpoint exists to refuse.
      expect(evaluatePredicate(CHECKPOINT, contextFor(torn))).toBe(false);

      await harness.quiet(700);
      const whole = await harness.observe();
      expect(whole.stability.settled).toBe(true);
      expect(evaluatePredicate(CHECKPOINT, contextFor(whole))).toBe(true);

      // The skeleton digest moved, which is what a settle loop compares generations of. Note the
      // ordering that makes the tear dangerous: the digest was ALREADY STABLE for the whole quiet
      // window before the rest of the frame arrived.
      expect(whole.skeletonDigest).not.toBe(torn.skeletonDigest);
    } finally {
      await harness.close();
    }
  });
});
