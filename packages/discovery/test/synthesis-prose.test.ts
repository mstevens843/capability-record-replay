// The half of BRIEF section 3.6 that parameterization cannot reach, and the run that proved it.
//
// `synthesis-parameterization.test.ts` is the acceptance test for the CALLER'S ARGUMENT: the member
// number came from the goal, it was bound to a typed parameter, and `parameterizeText` replaces
// every occurrence of it. That mechanism is exact and it is complete for what it covers.
//
// It covers nothing the model read off the screen. The member's NAME was never in the goal, so it
// was never bound, so there is nothing for a substitution to substitute - and the first live
// discovery run put it in a committed file exactly that way:
//
//     "title": "Member 10043 found and active"
//     "why":   "The search results row showed 10043 / <the member's name> / <their balance> / ACTIVE"
//
// `artifact.json` and `contract.json` were clean. `report.json` was not, because it carried the
// model's `finish` prose verbatim. Four canary hits, three of them values no parameter had ever
// been bound to.
//
// So this file is the acceptance test for the OTHER class, and it is deliberately built the same
// way: poison every piece of free model prose in a real recording with values that recording
// declared as outputs, run the shipping synthesis over it, and assert over the SERIALIZED bytes
// that none of them survived. Two independent scanners, for the same reason as next door - a
// structural walk that reports a path, and a blind `indexOf` that cannot be fooled by a bug in the
// walker. And a discrimination suite, because a scanner that has never been shown to fail proves
// nothing.
//
// The fixture is `corebank-web`: observations captured from the real application through the real
// browser driver, a hand-authored script, no provider, no clock, no credential. Its three outputs
// are the same three the live run noted, and the values are the same shapes.

import { describe, expect, it } from "vitest";
import {
  type DiscoveryRun,
  MIN_OBSERVED_NEEDLE_LENGTH,
  PROSE_WITHHELD_MARKER,
  type SynthesisResult,
  type ValueBinding,
  findBoundValues,
  observedValuesOf,
  scrubProse,
  synthesizeCapability,
  unsearchableDetail,
  withholdingMarker,
} from "../src/index.js";
import {
  RECORDED_MEMBER_ID,
  REFS,
  loadCorpus,
  recordedRun,
  synthesisInput,
} from "./fixtures/corebank-web.js";

const corpus = loadCorpus();

/**
 * What the recorded run declared as outputs, spelled out here so the assertions are readable.
 *
 * These are the accessible names of the three result-row cells `REFS` pins, and `checkRefs` fails
 * the fixture if the captured corpus ever stops agreeing - so they cannot drift into being three
 * strings that happen to be absent from every document for the wrong reason.
 */
const OBSERVED = {
  memberName: REFS.nameCell.name,
  shareBalance: REFS.balanceCell.name,
  accountStatus: REFS.statusCell.name,
} as const;

/** The three observed values as bindings, purely so `findBoundValues` can be pointed at them. They
 *  were never parameters - that is the entire point of this file. */
const asNeedles: readonly ValueBinding[] = Object.entries(OBSERVED).map(([param, value]) => ({
  param,
  value,
  placeholder: `{${param}}`,
  sensitivity: "sensitive" as const,
}));

/**
 * The same recording, with every free-prose field carrying a value the run recorded as an output.
 *
 * Three fields, and each one is a real persistence path rather than a hypothetical: `intent` lands
 * in the artifact an approval SIGNS, `meaning` lands in the contract as `OutputSpec.description`,
 * and the outcome candidate's two sentences land in the report. The casings differ on purpose: a
 * legacy screen echoes wording in whatever case it likes, and a scan that missed the echo would
 * pass a document that still carries the value.
 */
function poisoned(run: DiscoveryRun, code: string): DiscoveryRun {
  return {
    ...run,
    outcomeCandidates: [
      {
        code,
        title: `Member ${RECORDED_MEMBER_ID} found: ${OBSERVED.memberName}`,
        why:
          `The search results row showed ${RECORDED_MEMBER_ID} / ${OBSERVED.memberName} / ` +
          `${OBSERVED.shareBalance} / ${OBSERVED.accountStatus}, and the record opened.`,
      },
    ],
    steps: run.steps.map((step) => ({
      ...step,
      intent: `${step.intent} The row I clicked reads ${OBSERVED.memberName.toLowerCase()}.`,
    })),
    outputs: run.outputs.map((output) => ({
      ...output,
      meaning: `${output.meaning} On this run it read ${OBSERVED.shareBalance}.`,
    })),
  };
}

async function synthesizePoisoned(code: string): Promise<SynthesisResult> {
  const run = await recordedRun(corpus);
  return synthesizeCapability(synthesisInput(poisoned(run, code), corpus));
}

// ---------------------------------------------------------------------------------------------
// The acceptance
// ---------------------------------------------------------------------------------------------

describe("a recorded member value never survives model prose into an emitted document", () => {
  // A code with no collision, so this suite is about PROSE. The code is a separate question and
  // gets its own suite below; mixing them would let a failure in one hide behind the other.
  const CODE = "MEMBER_RECORD_OPENED";

  it("is absent from every string, number and key of the report", async () => {
    const { report } = await synthesizePoisoned(CODE);
    expect(findBoundValues(report, asNeedles)).toEqual([]);
  });

  it("is absent from the report's raw serialization, checked without walking anything", async () => {
    const { report } = await synthesizePoisoned(CODE);
    const raw = JSON.stringify(report);
    const folded = raw.toLowerCase();
    for (const [output, value] of Object.entries(OBSERVED)) {
      expect(raw.includes(value), `${output} must not appear in the report`).toBe(false);
      expect(folded.includes(value.toLowerCase()), `${output}, case-folded`).toBe(false);
    }
  });

  it("is absent from the artifact and the contract, which are the documents that get signed", async () => {
    const { artifact, contract } = await synthesizePoisoned(CODE);
    expect(findBoundValues(artifact, asNeedles)).toEqual([]);
    expect(findBoundValues(contract, asNeedles)).toEqual([]);
    const raw = JSON.stringify({ artifact, contract }).toLowerCase();
    for (const value of Object.values(OBSERVED)) {
      expect(raw.includes(value.toLowerCase())).toBe(false);
    }
  });

  it("takes the caller's argument out with it, by the mechanism that already existed", async () => {
    // Layering, not replacement: the title carried BOTH the bound member number and an observed
    // name. Parameterization runs first and is exact; withholding is what happens to whatever it
    // could not reach.
    const { report, artifact, contract } = await synthesizePoisoned(CODE);
    expect(JSON.stringify({ report, artifact, contract })).not.toContain(RECORDED_MEMBER_ID);
  });

  it("survives the same check on the RUN it was synthesized from, which does carry the values", async () => {
    // The control. If the poisoned run were also clean, every assertion above would pass for the
    // wrong reason.
    const run = poisoned(await recordedRun(corpus), CODE);
    const raw = JSON.stringify({
      outcomeCandidates: run.outcomeCandidates,
      intents: run.steps.map((step) => step.intent),
      meanings: run.outputs.map((output) => output.meaning),
    }).toLowerCase();
    for (const value of Object.values(OBSERVED)) {
      expect(raw.includes(value.toLowerCase())).toBe(true);
    }
    expect(findBoundValues(run.outcomeCandidates, asNeedles).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Withheld, not dropped
// ---------------------------------------------------------------------------------------------

describe("what a reviewer sees where the sentence was", () => {
  const CODE = "MEMBER_RECORD_OPENED";

  it("replaces the wording with a marker that names the output class it carried", async () => {
    const { report } = await synthesizePoisoned(CODE);
    const candidate = report.outcomeCandidates[0];
    expect(candidate?.title).toContain(PROSE_WITHHELD_MARKER);
    expect(candidate?.title).toContain('"memberName"');
    expect(candidate?.why).toContain(PROSE_WITHHELD_MARKER);
  });

  it("keeps the symbolic code, which is the machine-readable half of the candidate", async () => {
    const { report } = await synthesizePoisoned(CODE);
    expect(report.outcomeCandidates[0]?.code).toBe(CODE);
  });

  it("records WHICH field was withheld and for which output, structurally", async () => {
    // Structured as well as prose, so a reviewer's tooling can gate on it without parsing English.
    const { report } = await synthesizePoisoned(CODE);
    const withheld = report.outcomeCandidates[0]?.withheld ?? [];
    expect(withheld.map((one) => one.field)).toEqual(["title", "why"]);
    expect(withheld[0]?.outputs).toEqual(["memberName"]);
    expect(withheld[1]?.outputs).toEqual(["memberName", "shareBalance", "accountStatus"]);
  });

  it("raises a note at the severity that blocks approval, and names no value in it", async () => {
    const { report } = await synthesizePoisoned(CODE);
    const flags = report.notes.filter((note) => note.code === "prose-withheld");
    expect(flags.length).toBeGreaterThan(0);
    for (const flag of flags) expect(flag.severity).toBe("review");
    // Notes reach logs and consoles. A note about a leak that quotes the value is the leak it is
    // reporting, one level up.
    expect(findBoundValues(report.notes, asNeedles)).toEqual([]);
  });

  it("withholds the step intent in the SIGNED artifact too, not only in the report", async () => {
    const { artifact, report } = await synthesizePoisoned(CODE);
    const intents = artifact.flow.steps.map((step) => step.intent);
    expect(intents.some((intent) => intent.includes(PROSE_WITHHELD_MARKER))).toBe(true);
    expect(
      report.notes.some((note) => note.code === "prose-withheld" && note.stepId !== undefined),
    ).toBe(true);
  });

  it("withholds the output description in the CONTRACT, which an agent routes on", async () => {
    const { contract } = await synthesizePoisoned(CODE);
    const balance = contract.outputs.find((output) => output.name === "shareBalance");
    expect(balance?.description).toContain(PROSE_WITHHELD_MARKER);
    expect(balance?.description).toContain('"shareBalance"');
  });

  it("leaves clean prose alone, so the control is not just 'withhold everything'", async () => {
    // The unpoisoned run through the same code path. Nothing is withheld, no note fires, and the
    // model's own sentences are still readable - which is the whole reason for preferring
    // withholding over dropping the field.
    const run = await recordedRun(corpus);
    const { report, artifact, contract } = synthesizeCapability(synthesisInput(run, corpus));
    expect(report.notes.some((note) => note.code === "prose-withheld")).toBe(false);
    const bytes = JSON.stringify({ report, artifact, contract });
    expect(bytes).not.toContain(PROSE_WITHHELD_MARKER);
    expect(artifact.flow.steps[0]?.intent.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// The outcome code
// ---------------------------------------------------------------------------------------------

describe("a proposed outcome code is kept, and what is wrong with it is said out loud", () => {
  it("flags a code that spells an observed value rather than withholding it", async () => {
    // `MEMBER_FOUND_ACTIVE` is what the live run actually proposed, and `ACTIVE` is what the status
    // column actually said. The code is symbolic and is the half of the candidate a reviewer needs
    // in order to go and write a detector, so it is kept - and the note is how they learn it may be
    // this member's data rather than the application's vocabulary.
    const { report } = await synthesizePoisoned("MEMBER_FOUND_ACTIVE");
    expect(report.outcomeCandidates[0]?.code).toBe("MEMBER_FOUND_ACTIVE");
    const flag = report.notes.find((note) => note.code === "outcome-code-carries-recorded-value");
    expect(flag?.severity).toBe("review");
    expect(flag?.detail).toContain('"accountStatus"');
  });

  it("parameterizes a code that spells the CALLER'S argument, because that one is substitutable", async () => {
    // The exact shape the redaction canary caught in the first live run, moved one field along. A
    // bound value is exactly replaceable, so it is replaced rather than withheld, and the report
    // still says a person has to rename it: an outcome code that names one member is not an outcome.
    const { report } = await synthesizePoisoned(`MEMBER_${RECORDED_MEMBER_ID}_FOUND`);
    expect(report.outcomeCandidates[0]?.code).toBe("MEMBER_{memberId}_FOUND");
    expect(JSON.stringify(report)).not.toContain(RECORDED_MEMBER_ID);
    expect(
      report.notes.some(
        (note) =>
          note.code === "outcome-code-carries-recorded-value" && note.detail.includes("memberId"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The unit underneath, and its discrimination suite
// ---------------------------------------------------------------------------------------------

describe("the observed-value table", () => {
  it("reads the value off the node the run noted, for every output", async () => {
    const run = await recordedRun(corpus);
    const observed = observedValuesOf(run.outputs);
    expect(observed.values.map((one) => one.output).sort()).toEqual([
      "accountStatus",
      "memberName",
      "shareBalance",
    ]);
    expect(observed.values.find((one) => one.output === "memberName")?.value).toBe(
      OBSERVED.memberName,
    );
  });

  it("says out loud which outputs it will NOT search prose for", () => {
    const short = observedValuesOf([
      {
        outputName: "flag",
        meaning: "a two-letter code",
        nodeId: "n1" as never,
        observation: {
          nodes: [{ id: "n1", name: "Flag", value: "OK", text: null }],
        } as never,
      },
    ]);
    expect(short.values).toEqual([]);
    expect(short.unsearchable).toEqual([{ output: "flag", length: 2 }]);
    expect("OK".length).toBeLessThan(MIN_OBSERVED_NEEDLE_LENGTH);

    // The sentence a reviewer actually reads. It names the output and the LENGTH of its value,
    // which is the whole of what is safe to say about a value too short to say anything about.
    const detail = unsearchableDetail(short.unsearchable);
    expect(detail).toContain('"flag" (2 characters)');
    expect(detail).toContain(`under ${MIN_OBSERVED_NEEDLE_LENGTH}`);
    expect(detail).not.toContain("OK");
  });

  it("reaches the report as an info note when a run has such an output", async () => {
    // Not a hypothetical: `accountStatus` reads "ACTIVE" on this fixture, which is six characters
    // and IS searched. Shorten it and the note is how the gap becomes visible rather than assumed.
    const run = await recordedRun(corpus);
    const trimmed: DiscoveryRun = {
      ...run,
      outputs: run.outputs.map((output) => ({
        ...output,
        observation: {
          ...output.observation,
          nodes: output.observation.nodes.map((node) =>
            node.id === output.nodeId ? { ...node, name: "NEW", value: null, text: null } : node,
          ),
        },
      })),
    };
    const { report } = synthesizeCapability(synthesisInput(trimmed, corpus));
    const note = report.notes.find((one) => one.code === "prose-unchecked");
    expect(note?.severity).toBe("info");
    expect(note?.detail).toContain("(3 characters)");
  });
});

describe("the scrub can fail", () => {
  const observed = [{ output: "memberName", value: OBSERVED.memberName }];

  it("withholds prose that quotes an observed value", () => {
    const scrubbed = scrubProse(`The row read ${OBSERVED.memberName}.`, [], observed);
    expect(scrubbed.withheldFor).toEqual(["memberName"]);
    expect(scrubbed.text).not.toContain(OBSERVED.memberName);
  });

  it("withholds it across case, because a screen echoes wording however it likes", () => {
    const scrubbed = scrubProse(`the row read ${OBSERVED.memberName.toLowerCase()}.`, [], observed);
    expect(scrubbed.withheldFor).toEqual(["memberName"]);
  });

  it("keeps prose that quotes nothing", () => {
    const scrubbed = scrubProse("Opened the member's record from the results grid.", [], observed);
    expect(scrubbed.withheldFor).toEqual([]);
    expect(scrubbed.text).toBe("Opened the member's record from the results grid.");
  });

  it("parameterizes before it withholds, so a bound value alone does not cost the sentence", () => {
    const bindings: readonly ValueBinding[] = [
      {
        param: "memberId",
        value: RECORDED_MEMBER_ID,
        placeholder: "{memberId}",
        sensitivity: "sensitive",
      },
    ];
    const scrubbed = scrubProse(`Searched for member ${RECORDED_MEMBER_ID}.`, bindings, observed);
    expect(scrubbed.withheldFor).toEqual([]);
    expect(scrubbed.text).toBe("Searched for member {memberId}.");
  });

  it("falls back to a marker that names nothing when even the OUTPUT NAME would repeat a value", () => {
    // The self-check inside `withholdingMarker`. An output name is model-authored text, so a marker
    // assembled out of one could carry the thing it is reporting. Contrived on purpose: the only
    // way to show the branch works is to construct the condition that reaches it.
    const collides = [{ output: "memberName", value: "which is member data" }];
    const marker = withholdingMarker(["memberName"], [], collides);
    expect(marker).toContain(PROSE_WITHHELD_MARKER);
    expect(marker).not.toContain('"memberName"');
    expect(marker.toLowerCase()).not.toContain("which is member data");
  });

  it("never puts the value it is refusing into the marker", () => {
    const scrubbed = scrubProse(`The row read ${OBSERVED.memberName}.`, [], observed);
    expect(findBoundValues({ marker: scrubbed.text }, asNeedles)).toEqual([]);
    expect(scrubbed.text).toContain(PROSE_WITHHELD_MARKER);
  });
});
