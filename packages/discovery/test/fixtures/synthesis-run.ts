// One `DiscoveryRun`, produced with no credentials and no browser, for the synthesis tests.
//
// The run is driven by the VCR `replay` adapter over the committed synthetic transcript. That
// matters for two separate reasons and it is worth being precise about both.
//
// COST AND HERMETICITY. `createReplayModel` holds a parsed JSON file: no client, no key, no socket.
// The whole discovery loop runs, the whole synthesis runs, and nothing can reach a provider even if
// somebody wires it wrong. BRIEF section 11's no-spend rule is satisfied by construction rather
// than by discipline.
//
// PROVENANCE HONESTY. The transcript's own assistant turns were hand-authored (see
// `build-transcript.ts`) and the file says `synthetic: true`, which is why `assertRealRecording`
// refuses it. The artifact synthesized here therefore records `adapter: "replay"` and
// `modelId: "synthetic-script"` in its provenance, which is exactly what happened and exactly what
// BRIEF section 10 requires. It is NOT evidence of a discovery run, and nothing in these tests
// presents it as one.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MOCK_SURFACE_CAPABILITIES, MockSurface, type SurfaceCapabilities } from "@crr/core";
import {
  type DiscoveryRun,
  type SynthesisResult,
  type SynthesizeInput,
  createReplayModel,
  parseTranscript,
  runDiscoveryLoop,
  synthesizeCapability,
} from "../../src/index.js";
import { FIXTURE_FILE } from "./build-transcript.js";
import {
  ALLOWLIST,
  CONTROL,
  FROZEN_NOW,
  GOAL,
  frozenClockMs,
  screens,
  transitions,
} from "./corebank.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const RAW = readFileSync(join(HERE, FIXTURE_FILE), "utf8");

/** The concrete member number the recording used. Every test that asserts it appears NOWHERE
 *  imports it from here, so there is exactly one place the value is written down. */
export const RECORDED_MEMBER_ID = "50001";

export const CAPABILITIES: SurfaceCapabilities = MOCK_SURFACE_CAPABILITIES;

export async function recordedRun(): Promise<DiscoveryRun> {
  const surface = new MockSurface({ screens, start: "searchForm", transitions });
  return runDiscoveryLoop({
    goal: GOAL,
    target: { tenantId: "riverbend", originAlias: "corebank", entryRoute: "/members/search" },
    model: createReplayModel(parseTranscript(JSON.parse(RAW))),
    surface,
    allowlist: ALLOWLIST,
    control: CONTROL,
    now: () => FROZEN_NOW,
    nowMs: frozenClockMs(),
  });
}

/** Everything a person owns rather than derives: the capability's name, its prose, and which vendor
 *  product this program is written against. */
export function synthesisInput(run: DiscoveryRun): SynthesizeInput {
  return {
    run,
    capability: {
      name: "corebank.member.read_share_balance",
      title: "Read a member's share balance",
      summary: "Look up a member by id and report the current balance of their share account.",
      whenToUse: ["The caller has a member id and needs that member's current share balance."],
      whenNotToUse: [
        "The caller has a name rather than a member id; this capability does not search by name.",
      ],
    },
    vendor: {
      product: "corebank-web",
      productVersionRange: ">=1.0.0 <2.0.0",
      sessionProfile: "corebank-teller",
    },
    capabilities: CAPABILITIES,
    tenantId: "riverbend",
    appInstanceId: "riverbend-corebank-01",
    runId: "run:synthesis-fixture",
    recordedAt: FROZEN_NOW,
    promptVersion: "discovery/1",
    transcriptRef: null,
  };
}

export async function synthesized(): Promise<SynthesisResult> {
  return synthesizeCapability(synthesisInput(await recordedRun()));
}
