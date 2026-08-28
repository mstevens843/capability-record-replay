// The journal readers, checked against a REAL run rather than a hand-built object.
//
// `src/journal-view.ts` asserts shapes that `@crr/core`'s journal schema has already validated at
// write time, because that schema's inferred TYPE does not discriminate (its `event()` helper takes
// `type: string`, so every member's tag widens to `string`). An assertion is only as good as the
// thing that would notice it going stale - so these tests drive the real interpreter, take the real
// journal it wrote, and check that every field the readers claim is actually there and typed.
//
// If someone renames `descriptors[].evidenceSource` in core, this file goes red. That is the whole
// contract: the cast in `journal-view.ts` is allowed to exist because this file is watching it.

import { describe, expect, it } from "vitest";
import { runFlow } from "../src/corpus/harness.js";
import { IDS } from "../src/corpus/screens.js";
import { REFERENCE_ENGINE } from "../src/engines/mutants.js";
import { checkpointEvents, resolvedEvents, settledEvents } from "../src/journal-view.js";

const happy = await runFlow(REFERENCE_ENGINE, {});
const events = happy.out.journal.events;

describe("resolvedEvents", () => {
  it("returns one entry per target resolution, and nothing else", () => {
    const resolved = resolvedEvents(events);
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved.length).toBe(events.filter((e) => e.type === "resolved").length);
  });

  it("carries every field the degradation report reads, with the right types", () => {
    for (const event of resolvedEvents(events)) {
      expect(typeof event.stepId).toBe("string");
      expect(typeof event.agreed).toBe("boolean");
      expect(Number.isInteger(event.distinctSources)).toBe(true);
      expect(event.descriptors.length).toBeGreaterThan(0);
      for (const d of event.descriptors) {
        expect(typeof d.id).toBe("string");
        expect(typeof d.kind).toBe("string");
        expect(typeof d.evidenceSource).toBe("string");
        expect(["resolved", "abstained", "non-unique", "disabled", "disagreed"]).toContain(
          d.verdict,
        );
        expect(d.nodeId === null || typeof d.nodeId === "string").toBe(true);
      }
    }
  });

  it("names the descriptors the corpus artifact declares, so the ids are real", () => {
    const ids = new Set(resolvedEvents(events).flatMap((e) => e.descriptors.map((d) => d.id)));
    expect(ids.has("member-id-field-by-name")).toBe(true);
    expect(ids.has("open-link-by-row")).toBe(true);
  });
});

describe("settledEvents", () => {
  it("returns one entry per settle loop with a poll count and a settled flag", () => {
    const settles = settledEvents(events);
    expect(settles.length).toBeGreaterThan(0);
    for (const s of settles) {
      expect(typeof s.stepId).toBe("string");
      expect(Number.isInteger(s.polls)).toBe(true);
      expect(s.polls).toBeGreaterThan(0);
      expect(Number.isInteger(s.elapsedMs)).toBe(true);
      expect(typeof s.settled).toBe("boolean");
    }
  });

  it("reports every step of the happy path as settled", () => {
    expect(settledEvents(events).every((s) => s.settled)).toBe(true);
  });

  it("reports NOT settled when the screen never arrives, which is what the sweep reads", async () => {
    // The negative control for the reader itself: a field that is `true` in every run this file can
    // reach is a field that could be hard-coded and nobody would know.
    const stalled = await runFlow(REFERENCE_ENGINE, {
      transitions: [
        {
          from: "search-ready",
          on: { kind: "click", target: IDS.searchButton },
          to: "results",
          via: [{ kind: "stall", screen: "results-loading" }],
        },
        { from: "blank", on: { kind: "navigate", path: "/teller/search" }, to: "search" },
        { from: "search", on: { kind: "type", target: IDS.memberIdField }, to: "search-member" },
        {
          from: "search-member",
          on: { kind: "type", target: IDS.branchField },
          to: "search-ready",
        },
        { on: { kind: "navigate", path: "/teller/search" }, to: "search" },
      ],
    });
    const settles = settledEvents(stalled.out.journal.events);
    expect(settles.some((s) => !s.settled)).toBe(true);
    // And the stall really is expensive in polls, which is the cost unit the sweep reports in.
    expect(Math.max(...settles.map((s) => s.polls))).toBeGreaterThan(10);
  });
});

describe("checkpointEvents", () => {
  it("returns a pass flag per checkpoint, all passing on the happy path", () => {
    const checkpoints = checkpointEvents(events);
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(checkpoints.every((c) => c.passed)).toBe(true);
  });

  it("emits NO checkpoint for a step the post-classification already failed", async () => {
    // Worth pinning, because it is counter-intuitive and it is what a postmortem reader needs to
    // know. On the torn read the run comes back `failed:checkpoint-failed` - but that verdict is
    // reached by the CLASSIFIER in its post phase, which ends the step before the checkpoint stage
    // records anything. So the failing step contributes a `classified` event and no `checkpoint`
    // event, and a reader counting checkpoints would otherwise conclude the step was never reached.
    const torn = await runFlow(REFERENCE_ENGINE, {
      transitions: [
        {
          from: "search-ready",
          on: { kind: "click", target: IDS.searchButton },
          to: "results-torn",
        },
        { from: "blank", on: { kind: "navigate", path: "/teller/search" }, to: "search" },
        { from: "search", on: { kind: "type", target: IDS.memberIdField }, to: "search-member" },
        {
          from: "search-member",
          on: { kind: "type", target: IDS.branchField },
          to: "search-ready",
        },
        { on: { kind: "navigate", path: "/teller/search" }, to: "search" },
      ],
    });
    expect(torn.out.result.status).toBe("failed");
    const checkpoints = checkpointEvents(torn.out.journal.events);
    const settles = settledEvents(torn.out.journal.events);
    expect(checkpoints.every((c) => c.passed)).toBe(true);
    // One settle without a checkpoint behind it: the step that was torn.
    expect(settles).toHaveLength(checkpoints.length + 1);
  });
});
