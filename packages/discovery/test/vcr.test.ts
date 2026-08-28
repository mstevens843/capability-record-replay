// THE ACCEPTANCE TEST SPEC section 11 unit 13 names: the loop completes the fixture goal from a VCR
// fixture with NO API KEY.
//
// It is the load-bearing test of this package and of BRIEF section 11's no-spend rule. The model
// object it runs against is `createReplayModel`, which holds a parsed JSON file and nothing else -
// no client, no key, no socket - so this suite cannot reach a provider even if somebody wires it
// wrong. The first test asserts that explicitly by deleting every credential from the environment
// for the duration of the run.
//
// The rest of the file is the VCR's own contract: a transcript that no longer matches the prompt
// the loop builds is a FATAL mismatch, not a shrug, because that is the only form in which "the VCR
// catches prompt and tool-schema regressions" is true.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MockSurface } from "@crr/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  DISCOVERY_TOOLS,
  type Transcript,
  TranscriptMismatchError,
  assertRealRecording,
  createReplayModel,
  parseTranscript,
  runDiscoveryLoop,
  toolNamesIn,
} from "../src/index.js";
import { FIXTURE_FILE, buildSyntheticTranscript } from "./fixtures/build-transcript.js";
import {
  ALLOWLIST,
  CONTROL,
  FROZEN_NOW,
  GOAL,
  frozenClockMs,
  screens,
  transitions,
} from "./fixtures/corebank.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_PATH = join(HERE, "fixtures", FIXTURE_FILE);
const RAW = readFileSync(FIXTURE_PATH, "utf8");

const committed = (): Transcript => parseTranscript(JSON.parse(RAW));

const TARGET = {
  tenantId: "riverbend",
  originAlias: "corebank",
  entryRoute: "/members/search",
} as const;

async function replayTheFixture(transcript: Transcript) {
  const surface = new MockSurface({ screens, start: "searchForm", transitions });
  const run = await runDiscoveryLoop({
    goal: GOAL,
    target: TARGET,
    model: createReplayModel(transcript),
    surface,
    allowlist: ALLOWLIST,
    control: CONTROL,
    now: () => FROZEN_NOW,
    nowMs: frozenClockMs(),
  });
  return { run, surface };
}

// Every credential BRIEF section 11 names as a way an agent could spend the author's money.
// `CLAUDE_CODE_OAUTH_TOKEN` is on the list because the `agent-sdk` adapter draws on a Claude Code
// subscription rather than on an API key, so a suite that only unset the two API keys would still
// have a live path to a provider if that adapter were ever wired into a test.
const CREDENTIAL_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;
const saved = new Map<string, string | undefined>();

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

// ---------------------------------------------------------------------------------------------
// The acceptance
// ---------------------------------------------------------------------------------------------

describe("the discovery loop completes the fixture goal from a VCR fixture", () => {
  it("reaches the goal with every credential removed from the environment", async () => {
    for (const key of CREDENTIAL_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    for (const key of CREDENTIAL_KEYS) expect(process.env[key]).toBeUndefined();

    const { run } = await replayTheFixture(committed());

    expect(run.status).toBe("reached-goal");
    expect(run.adapter).toBe("replay");
    expect(run.summary).toContain("share balance");
  });

  it("records the three actions that make up the flow, in order", async () => {
    const { run } = await replayTheFixture(committed());
    expect(run.steps.map((step) => step.action.kind)).toEqual(["type", "click", "click"]);
    expect(run.steps.map((step) => step.nodeId)).toEqual([
      "textbox:member-id",
      "button:search",
      "link:select-row1",
    ]);
    expect(run.steps.every((step) => step.dispatched)).toBe(true);
  });

  it("keeps the model's reasoning as prose the engine never reads", async () => {
    const { run } = await replayTheFixture(committed());
    for (const step of run.steps) expect(step.intent.length).toBeGreaterThan(10);
    expect(run.steps[0]?.intent).toContain("Member ID");
  });

  it("hands synthesis the full observation each node id indexes into", async () => {
    // Unit 14's `deriveDescriptors` needs the TREE, not the projection. If this stops being true,
    // descriptor derivation has nothing to derive from.
    const { run } = await replayTheFixture(committed());
    for (const step of run.steps) {
      expect(step.observation.nodes.length).toBeGreaterThan(0);
      if (step.nodeId !== null) {
        expect(step.observation.nodes.some((node) => node.id === step.nodeId)).toBe(true);
      }
      expect(step.after).not.toBeNull();
    }
  });

  it("notes the output the caller asked for, bound to a node and an observation", async () => {
    const { run } = await replayTheFixture(committed());
    expect(run.outputs).toHaveLength(1);
    const output = run.outputs[0];
    expect(output?.outputName).toBe("shareBalance");
    expect(output?.nodeId).toBe("textbox:detail-share-balance");
    expect(output?.observation.route?.path).toBe("/members/:memberId");
  });

  it("drove the real surface, not a stub of one", async () => {
    const { surface } = await replayTheFixture(committed());
    expect(surface.screen).toBe("detail");
    expect(surface.dispatched.map((d) => d.action.kind)).toEqual(["type", "click", "click"]);
    // Every perceive was bounded. An unbounded perceive is a hang, and a hang has no failure class.
    expect(surface.deadlines.every((deadline) => deadline > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The fixture says what it is
// ---------------------------------------------------------------------------------------------

describe("the committed fixture is honest about its provenance", () => {
  it("is marked synthetic and refuses to be used as evidence", () => {
    const transcript = committed();
    expect(transcript.synthetic).toBe(true);
    expect(transcript.provenance.adapter).toBe("scripted");
    expect(transcript.provenance.note).toContain("SYNTHETIC");
    expect(transcript.provenance.note).toContain("NOT evidence");
    expect(() => assertRealRecording(transcript)).toThrow(/synthetic/);
  });

  it("reports zero tokens, because a scripted run consumed none", () => {
    // The alternative - inventing plausible token counts - is how a fabricated number ends up
    // quoted in a README. A synthetic fixture's cache hit rate is 0 and cannot be mistaken for a
    // measurement.
    const transcript = committed();
    expect(transcript.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    expect(transcript.cacheHitRate).toBe(0);
  });

  it("names itself synthetic in its own filename", () => {
    expect(FIXTURE_FILE).toContain("synthetic");
  });

  it("exercised four of the five tools", () => {
    expect(toolNamesIn(committed())).toEqual(["act", "finish", "note_output", "observe"]);
  });
});

// ---------------------------------------------------------------------------------------------
// The regression detector
// ---------------------------------------------------------------------------------------------

describe("the VCR is a prompt and tool-schema regression detector", () => {
  it("rebuilds byte-identically from the script", async () => {
    // This is the test that fails when the system prompt, a tool description, the projection or the
    // loop's message shape changes. The fix is to re-record, not to loosen the check:
    //   pnpm -F @crr/discovery fixtures:synthetic
    const { transcript } = await buildSyntheticTranscript();
    expect(`${JSON.stringify(transcript, null, 2)}\n`).toBe(RAW);
  });

  it("refuses to serve a turn when the cacheable prefix has changed", async () => {
    const transcript = committed();
    const tampered: Transcript = {
      ...transcript,
      prefix: { ...transcript.prefix, digest: "sha256:".padEnd(71, "0") as never },
    };
    const surface = new MockSurface({ screens, start: "searchForm", transitions });
    await expect(
      runDiscoveryLoop({
        goal: GOAL,
        target: TARGET,
        model: createReplayModel(tampered),
        surface,
        allowlist: ALLOWLIST,
        control: CONTROL,
        now: () => FROZEN_NOW,
        nowMs: frozenClockMs(),
      }),
    ).rejects.toThrow(TranscriptMismatchError);
  });

  it("refuses to serve a turn when the conversation has changed", async () => {
    const transcript = committed();
    const surface = new MockSurface({ screens, start: "searchForm", transitions });
    await expect(
      runDiscoveryLoop({
        // A different goal means a different first user message, so the recorded turn was answered
        // to a question that was never asked. Serving it anyway would certify a conversation nobody
        // ever had.
        goal: "Close member 50001's savings account.",
        target: TARGET,
        model: createReplayModel(transcript),
        surface,
        allowlist: ALLOWLIST,
        control: CONTROL,
        now: () => FROZEN_NOW,
        nowMs: frozenClockMs(),
      }),
    ).rejects.toThrow(/different conversation/);
  });

  it("can be told to ignore the mismatch, and that is a visible call-site decision", async () => {
    const transcript = committed();
    const surface = new MockSurface({ screens, start: "searchForm", transitions });
    const run = await runDiscoveryLoop({
      goal: "Close member 50001's savings account.",
      target: TARGET,
      model: createReplayModel(transcript, { strict: false }),
      surface,
      allowlist: ALLOWLIST,
      control: CONTROL,
      now: () => FROZEN_NOW,
      nowMs: frozenClockMs(),
    });
    expect(run.status).toBe("reached-goal");
  });

  it("refuses when the loop asks for more turns than were recorded", async () => {
    const transcript = committed();
    const short: Transcript = { ...transcript, turns: transcript.turns.slice(0, 2) };
    const surface = new MockSurface({ screens, start: "searchForm", transitions });
    await expect(
      runDiscoveryLoop({
        goal: GOAL,
        target: TARGET,
        model: createReplayModel(short),
        surface,
        allowlist: ALLOWLIST,
        control: CONTROL,
        now: () => FROZEN_NOW,
        nowMs: frozenClockMs(),
      }),
    ).rejects.toThrow(/got further this time/);
  });

  it("refuses a file whose stated cache hit rate disagrees with its own token counts", () => {
    const transcript = committed();
    const lying = { ...transcript, cacheHitRate: 0.9 };
    expect(() => parseTranscript(lying)).toThrow(TranscriptMismatchError);
  });

  it("records the prompt the LOOP built, not the one the scripted model looked at", () => {
    // The scripted model ignores the request entirely. The recorder does not, which is why a
    // synthetic fixture still pins the real system prompt and the real tool definitions.
    const transcript = committed();
    expect(transcript.prefix.tools).toHaveLength(DISCOVERY_TOOLS.length);
    expect(transcript.prefix.system[0]?.cache_control).toEqual({ type: "ephemeral" });
  });
});
