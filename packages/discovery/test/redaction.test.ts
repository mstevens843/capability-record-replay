// The redaction canary for this package.
//
// SPEC section 6.4 is explicit: "Redaction applies to transcripts too. A recorded VCR transcript is
// a persisted artifact under the same taint model as everything else." This is the empirical half
// of that claim - bind a distinctive value, run the whole loop, then grep EVERYTHING the package
// emits for it. The unit-18 canary does the same over the evidence tree; this one does it at the
// boundary where a model-authored structure first crosses into a persisted one.
//
// The canary is deliberately not a plausible member number. A grep that finds "50001" in a
// transcript tells you nothing, because the goal legitimately contains it; a grep that finds
// "CANARY-91375" tells you a control failed.

import { MockSurface, bindSensitive, isTainted, revealTainted } from "@crr/core";
import type { TaintedValue } from "@crr/core";
import { describe, expect, it } from "vitest";
import {
  type ScriptedTurn,
  createRecordingModel,
  createScriptedModel,
  runDiscoveryLoop,
} from "../src/index.js";
import {
  ALLOWLIST,
  CONTROL,
  FROZEN_NOW,
  frozenClockMs,
  screens,
  transitions,
} from "./fixtures/corebank.js";

/** Twelve characters, matching the Member ID field's capacity, so nothing truncates and the test is
 *  about redaction rather than about a legacy input's length limit. */
const CANARY = "CANARY-91375";
const PLACEHOLDER = "{{secret:memberId}}";

const SCRIPT: readonly ScriptedTurn[] = [
  { toolUses: [{ name: "observe", input: {} }] },
  {
    toolUses: [
      {
        name: "act",
        input: {
          nodeRef: "n1",
          action: "fill",
          value: PLACEHOLDER,
          key: null,
          why: "The member number was withheld from me, so I pass the placeholder.",
        },
      },
    ],
  },
  { toolUses: [{ name: "observe", input: {} }] },
  {
    toolUses: [
      {
        name: "finish",
        input: {
          status: "reached-goal",
          summary: "Entered the withheld member number into the search form.",
          outcomeCandidates: null,
        },
      },
    ],
  },
];

async function runWithSecret() {
  const secret: TaintedValue = bindSensitive("memberId", CANARY, 1);
  const surface = new MockSurface({ screens, start: "searchForm", transitions });
  const model = createRecordingModel(createScriptedModel(SCRIPT), {
    nowMs: frozenClockMs(),
    recordedAt: null,
    synthetic: true,
    note: "SYNTHETIC. Built inside test/redaction.test.ts to prove a bound value reaches no sink.",
  });
  const run = await runDiscoveryLoop({
    goal: "Look up the member whose number was withheld and report their share balance.",
    target: { tenantId: "riverbend", originAlias: "corebank", entryRoute: "/members/search" },
    model,
    surface,
    allowlist: ALLOWLIST,
    control: CONTROL,
    secrets: new Map([[PLACEHOLDER, secret]]),
    now: () => FROZEN_NOW,
    nowMs: frozenClockMs(),
  });
  return { run, surface, transcript: model.transcript(), secret };
}

describe("a value bound to a sensitive parameter reaches the surface and nothing else", () => {
  it("is typed into the field, marked sensitive so the driver masks its region", async () => {
    const { surface } = await runWithSecret();
    const typed = surface.dispatched.find((entry) => entry.action.kind === "type");
    if (typed?.action.kind !== "type") throw new Error("nothing was typed");
    expect(typed.action.text).toBe(CANARY);
    expect(typed.action.sensitive).toBe(true);
  });

  it("appears nowhere in the recorded transcript", async () => {
    const { transcript } = await runWithSecret();
    expect(JSON.stringify(transcript)).not.toContain(CANARY);
  });

  it("appears nowhere in the journal", async () => {
    const { run } = await runWithSecret();
    expect(JSON.stringify(run.events)).not.toContain(CANARY);
  });

  it("appears nowhere in the recorded steps or observations handed to synthesis", async () => {
    const { run } = await runWithSecret();
    expect(JSON.stringify(run.steps)).not.toContain(CANARY);
    expect(JSON.stringify(run.observations)).not.toContain(CANARY);
    expect(JSON.stringify(run)).not.toContain(CANARY);
  });

  it("appears nowhere in what the model was shown", async () => {
    const { transcript } = await runWithSecret();
    const toolResults = transcript.turns
      .flatMap((turn) => turn.appended)
      .flatMap((message) => (typeof message.content === "string" ? [] : message.content))
      .filter((block) => block.type === "tool_result");
    const text = JSON.stringify(toolResults);
    expect(text).not.toContain(CANARY);
    // What the model DOES see is the length, which SPEC 8.3 keeps on the box because "the field
    // truncated what we typed" is a real failure that is invisible without it.
    expect(text).toContain("&lt;masked:12&gt;".replaceAll("&lt;", "<").replaceAll("&gt;", ">"));
  });

  it("is carried through the run as an opaque handle instead", async () => {
    const { run } = await runWithSecret();
    const step = run.steps[0];
    expect(step?.value).toEqual({
      kind: "sensitive",
      handle: "taint:memberId-1",
      placeholder: PLACEHOLDER,
    });
    const acted = run.events.find((event) => event.type === "acted");
    expect(acted?.type === "acted" && acted.valueRef).toBe("taint:memberId-1");
    expect(acted?.type === "acted" && acted.valueLength).toBe(12);
  });

  it("keeps the placeholder out of the field: the model typed a name, the surface got a value", async () => {
    const { surface, transcript } = await runWithSecret();
    const typed = surface.dispatched.find((entry) => entry.action.kind === "type");
    if (typed?.action.kind !== "type") throw new Error("nothing was typed");
    expect(typed.action.text).not.toBe(PLACEHOLDER);
    // The placeholder itself is not secret - it is a name the prompt gave the model - so it is
    // expected to appear in the transcript, and that is what makes the file readable.
    expect(JSON.stringify(transcript)).toContain(PLACEHOLDER);
  });
});

describe("the taint box itself", () => {
  it("refuses the transcript sink by name", () => {
    const secret = bindSensitive("memberId", CANARY, 1);
    expect(isTainted(secret)).toBe(true);
    expect(() => revealTainted(secret, "vcr-transcript")).toThrow(/committed fixture/);
    expect(revealTainted(secret, "surface-action")).toBe(CANARY);
  });

  it("stringifies to its handle, so an accidental interpolation leaks nothing", () => {
    const secret = bindSensitive("memberId", CANARY, 1);
    expect(`${secret}`).toBe("taint:memberId-1");
    expect(JSON.stringify({ value: secret })).toBe('{"value":"taint:memberId-1"}');
  });
});
