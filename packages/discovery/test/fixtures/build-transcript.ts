// Builds the SYNTHETIC VCR fixture.
//
// READ THIS BEFORE USING ANYTHING THIS FILE PRODUCES.
//
// The model's side of the resulting transcript was WRITTEN BY HAND, in `SCRIPT` below. No model
// produced it, no provider was called, and no tokens were spent - which is why every usage figure
// in the fixture is zero and its cache hit rate is 0. It exists to exercise the loop, the tool
// schemas and the VCR mechanism with no credentials present, and it is marked `synthetic: true` in
// the file itself so that `assertRealRecording` refuses it.
//
// IT IS NOT EVIDENCE OF A DISCOVERY RUN and must never be presented as one (BRIEF section 10).
// Real transcripts come from the `anthropic` adapter against the live API, in a run the author has
// explicitly approved.
//
// What IS real about it: the system prompt, the tool definitions, the message history, the
// projection the model was shown, the policy decisions and the recorded steps. Those were all
// produced by the shipping code paths, which is what makes a prompt or tool-schema change show up
// as a red test here rather than as a surprise on a live run.

import { MockSurface } from "@crr/core";
import {
  type DiscoveryRun,
  type Transcript,
  createRecordingModel,
  createScriptedModel,
  runDiscoveryLoop,
} from "../../src/index.js";
import type { ScriptedTurn } from "../../src/index.js";
import {
  ALLOWLIST,
  CONTROL,
  FROZEN_NOW,
  GOAL,
  frozenClockMs,
  screens,
  transitions,
} from "./corebank.js";

/**
 * The hand-authored model turns.
 *
 * The node references are indices into each screen's own node list, which is exactly the contract
 * SPEC section 6.2 gives the model - so a change to the projection's FILTER (not its wording) will
 * break this script, and that is the correct sensitivity for a fixture whose job is to pin the
 * model-facing surface.
 */
export const SCRIPT: readonly ScriptedTurn[] = [
  {
    text: "Let me look at the search screen first.",
    toolUses: [{ name: "observe", input: {} }],
  },
  {
    toolUses: [
      {
        name: "act",
        input: {
          nodeRef: "n1",
          action: "fill",
          value: "50001",
          key: null,
          why: "The task names member 50001 and this is the Member ID field on the search form.",
        },
      },
    ],
  },
  {
    toolUses: [
      {
        name: "act",
        input: {
          nodeRef: "n2",
          action: "activate",
          value: null,
          key: null,
          why: "Submit the search now that the member number is entered.",
        },
      },
    ],
  },
  {
    toolUses: [
      {
        name: "act",
        input: {
          nodeRef: "n7",
          action: "activate",
          value: null,
          key: null,
          why: "Open the member whose Member ID column reads 50001.",
        },
      },
    ],
  },
  {
    toolUses: [
      {
        name: "note_output",
        input: {
          nodeRef: "n2",
          outputName: "shareBalance",
          meaning: "The member's current share account balance, which is what the task asked for.",
        },
      },
    ],
  },
  {
    toolUses: [
      {
        name: "finish",
        input: {
          status: "reached-goal",
          summary:
            "Searched for member 50001, opened the matching row, and read the share balance from the member detail screen.",
          outcomeCandidates: null,
        },
      },
    ],
  },
];

export interface BuiltFixture {
  readonly transcript: Transcript;
  readonly run: DiscoveryRun;
  readonly surface: MockSurface;
}

/** Run the real loop against the mock surface with the scripted model, recording as it goes. */
export async function buildSyntheticTranscript(): Promise<BuiltFixture> {
  const surface = new MockSurface({ screens, start: "searchForm", transitions });
  const model = createRecordingModel(createScriptedModel(SCRIPT, { modelId: "synthetic-script" }), {
    nowMs: frozenClockMs(),
    recordedAt: null,
    synthetic: true,
    note:
      "SYNTHETIC. The assistant turns in this file were authored by hand in " +
      "packages/discovery/test/fixtures/build-transcript.ts; no model produced them and no provider " +
      "was called, which is why every token count is zero. It exists so the discovery loop can be " +
      "exercised with no credentials. It is NOT evidence of a discovery run.",
  });

  const run = await runDiscoveryLoop({
    goal: GOAL,
    target: { tenantId: "riverbend", originAlias: "corebank", entryRoute: "/members/search" },
    model,
    surface,
    allowlist: ALLOWLIST,
    control: CONTROL,
    now: () => FROZEN_NOW,
    nowMs: frozenClockMs(),
  });

  return { transcript: model.transcript(), run, surface };
}

/** The committed file's path, relative to this directory. Named so nobody can mistake it. */
export const FIXTURE_FILE = "corebank-member-lookup.synthetic.transcript.json";
