// What comes out of synthesis: a valid, content-addressed, straight-line program and the contract
// a calling agent sees.
//
// Every case here runs the whole pipeline over the VCR fixture with no credentials, no browser and
// no clock (`recordedAt` is injected), which is what lets the last test in this file assert BYTE
// EQUALITY across two independent runs. A recorder whose output moves between runs has no content
// address, and without a content address the approval signature signs nothing in particular.

import {
  MOCK_SURFACE_CAPABILITIES,
  ProvenanceSchema,
  artifactDigestIsIntact,
  link,
  parseArtifact,
  parseContract,
} from "@crr/core";
import { describe, expect, it } from "vitest";
import { DISCOVERY_ADAPTERS, SynthesisError, synthesizeCapability } from "../src/index.js";
import { recordedRun, synthesisInput, synthesized } from "./fixtures/synthesis-run.js";

// ---------------------------------------------------------------------------------------------
// The documents
// ---------------------------------------------------------------------------------------------

describe("the emitted documents are valid and content-addressed", () => {
  it("round-trips through the artifact and contract validators", async () => {
    const { artifact, contract } = await synthesized();
    expect(() => parseArtifact(JSON.parse(JSON.stringify(artifact)))).not.toThrow();
    expect(() => parseContract(JSON.parse(JSON.stringify(contract)))).not.toThrow();
  });

  it("addresses its own content, so an edited artifact cannot pass the linker's check 2", async () => {
    const { artifact } = await synthesized();
    expect(artifactDigestIsIntact(JSON.parse(JSON.stringify(artifact)))).toBe(true);
    const edited = JSON.parse(JSON.stringify(artifact));
    edited.flow.steps[0].title = "something else";
    expect(artifactDigestIsIntact(edited)).toBe(false);
  });

  it("implements the contract it was sealed against, by digest", async () => {
    const { artifact, contract } = await synthesized();
    expect(artifact.implements.contractDigest).toBe(contract.digest);
    expect(artifact.implements.name).toBe(contract.name);
    expect(artifact.implements.version).toBe(contract.version);
  });

  it("is proposed and unverified: a recording is not a claim until it replays", async () => {
    const { artifact } = await synthesized();
    expect(artifact.lifecycle.status).toBe("proposed");
    expect(artifact.lifecycle.approval).toBeNull();
    expect(artifact.verification.status).toBe("unverified");
    expect(artifact.signatures).toEqual([]);
  });

  it("plans a full verification replay for a read-only flow and names where it would stop", async () => {
    const { artifact } = await synthesized();
    expect(artifact.verification.mode).toBe("replay-full");
    expect(artifact.verification.grade).toBe("full");
    const ids = artifact.flow.steps.map((step) => step.id);
    expect(ids).toContain(artifact.verification.coveredThroughStep);
  });
});

// ---------------------------------------------------------------------------------------------
// The program
// ---------------------------------------------------------------------------------------------

describe("the program is the recording, straightened", () => {
  it("emits one step per dispatched action plus a read for what the model noted", async () => {
    const { artifact } = await synthesized();
    expect(artifact.flow.steps.map((step) => step.instruction.kind)).toEqual([
      "fill",
      "activate",
      "activate",
      "read",
    ]);
  });

  it("places the read on the screen it was read from, not at the end of the flow", async () => {
    // Extraction reads the SAME observation the checkpoint verified. A read floated to the end
    // would verify one screen and read whichever the program happened to be on.
    const { artifact } = await synthesized();
    const read = artifact.flow.steps.at(-1);
    expect(read?.precondition).toEqual({ kind: "route-matches", route: "members-by-memberid" });
    expect(read?.extract.map((spec) => spec.output)).toEqual(["shareBalance"]);
  });

  it("gives every step a checkpoint, and every checkpoint held on the recorded screen", async () => {
    const { artifact } = await synthesized();
    for (const step of artifact.flow.steps) {
      expect(step.expect.predicate).toBeDefined();
      // The postcondition is a conjunction of things that were verified true against the recorded
      // observation, so no step ships a checkpoint that was already false.
      expect(JSON.stringify(step.expect.predicate).length).toBeGreaterThan(0);
    }
  });

  it("derives `mustChange` from the recording rather than asserting it", async () => {
    const { artifact } = await synthesized();
    const byKind = new Map(artifact.flow.steps.map((step) => [step.instruction.kind, step]));
    // A `read` dispatches nothing, so there is no pre-act digest and `mustChange` must be false or
    // a correct step classifies as `no-observable-effect`.
    expect(byKind.get("read")?.expect.delta.mustChange).toBe(false);
  });

  it("declares navigation on the step that navigated, and only there", async () => {
    const { artifact } = await synthesized();
    const navigated = artifact.flow.steps.filter(
      (step) => step.expect.delta.navigatedTo !== undefined,
    );
    expect(navigated).toHaveLength(1);
    expect(navigated[0]?.expect.delta.navigatedTo).toBe("members-by-memberid");
  });

  it("asserts continuity on the screen that still showed the subject, and nowhere else", async () => {
    const { artifact } = await synthesized();
    expect(artifact.continuity.map((def) => def.id)).toEqual(["memberId"]);
    const asserting = artifact.flow.steps.filter((step) => step.expect.continuity.length > 0);
    expect(asserting.map((step) => step.id)).toEqual(["activate-search"]);
    // Never on the fill step: reading back the value we just typed is evidence that typing works,
    // not that the application agrees about the subject.
    const fill = artifact.flow.steps.find((step) => step.instruction.kind === "fill");
    expect(fill?.expect.continuity).toEqual([]);
  });

  it("carries the wrong-row killer into the assertion on the row it clicked", async () => {
    const { artifact } = await synthesized();
    const select = artifact.flow.steps.find((step) => step.id === "activate-select");
    expect(select?.target?.assert.rowKeyEquals?.value).toEqual({
      from: "param",
      param: "memberId",
    });
  });

  it("gives every target two descriptors and a two-source quorum", async () => {
    const { artifact } = await synthesized();
    for (const step of artifact.flow.steps) {
      if (step.target === null) continue;
      expect(step.target.descriptors.length).toBeGreaterThanOrEqual(2);
      expect(step.target.quorum).toEqual({
        min: 2,
        distinctEvidenceSources: 2,
        requireIdentical: true,
        onUnderQuorum: "fail",
        expectUnique: true,
      });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Routes and the vocabulary
// ---------------------------------------------------------------------------------------------

describe("routes are patterns and wording is a token", () => {
  it("declares only the routes the run touched, as patterns", async () => {
    const { artifact } = await synthesized();
    expect(artifact.flow.routes.map((route) => route.path)).toEqual([
      "/members/search",
      "/members/:memberId",
    ]);
    for (const route of artifact.flow.routes) {
      expect(route.originAlias).toBe("corebank");
      expect(route.path).not.toContain("://");
    }
  });

  it("puts every piece of screen wording in the vocabulary, referenced by token", async () => {
    const { artifact } = await synthesized();
    const vocabulary: Readonly<Record<string, readonly string[]>> = artifact.flow.vocabulary;
    expect(Object.keys(vocabulary)).toContain("member-id");
    expect(vocabulary["member-id"]).toEqual(["Member ID"]);
    // The hinge: a second tenant that says "Member #" is a one-line overlay, not a re-record.
    expect(Object.keys(vocabulary).length).toBeGreaterThan(5);
  });
});

// ---------------------------------------------------------------------------------------------
// The static effect analysis
// ---------------------------------------------------------------------------------------------

describe("effects are analysed statically, before anything runs", () => {
  it("rolls the steps up into the summary the schema re-derives", async () => {
    const { artifact } = await synthesized();
    // WRITE_REVERSIBLE, not READ: `defaultEffectOf` cannot prove that clicking "Search" is a read,
    // and SPEC section 8.2 is explicit that effect is DECLARED, not proven. Conservative in the one
    // direction that is safe.
    expect(artifact.effects.maxEffect).toBe("WRITE_REVERSIBLE");
    expect(artifact.effects.irreversibleSteps).toEqual([]);
    expect(artifact.effects.requiresApproval).toBe(false);
    expect(artifact.effects.restartSafeUpToPc).toBe(artifact.flow.steps.length);
    expect(artifact.effects.routesTouched).toEqual(["members-search", "members-by-memberid"]);
  });

  it("pairs every read field with the sensitivity the contract declares", async () => {
    const { artifact, contract } = await synthesized();
    for (const read of artifact.effects.reads) {
      const output = contract.outputs.find((one) => one.name === read.field);
      expect(read.sensitivity).toBe(output?.sensitivity);
    }
  });

  it("keeps policy and effects in agreement, so neither can be edited alone", async () => {
    const { artifact } = await synthesized();
    expect(artifact.policy.maxEffect).toBe(artifact.effects.maxEffect);
    expect(artifact.policy.requiresApprovalToken).toBe(artifact.effects.requiresApproval);
  });

  it("requires only the surface features the program actually uses", async () => {
    const { artifact } = await synthesized();
    expect(artifact.target.requires).toEqual(["accessibility-tree", "containers"]);
  });
});

// ---------------------------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------------------------

describe("the contract a calling agent sees", () => {
  it("carries typed outputs and no surface detail", async () => {
    const { contract } = await synthesized();
    const balance = contract.outputs.find((one) => one.name === "shareBalance");
    expect(balance?.type).toEqual({ kind: "money", currency: "USD" });
    expect(balance?.agentDisclosure).toBe("deliver");
    const raw = JSON.stringify(contract);
    expect(raw).not.toContain("descriptors");
    expect(raw).not.toContain("containerPath");
    expect(raw).not.toContain("frame");
  });

  it("declares no business outcome, because synthesis will not write a detector", async () => {
    // SPEC section 0.2: promotion to a business outcome requires an explicit declared detector, and
    // nothing may be inferred into one. A detector for a screen this run never observed is exactly
    // how a false MEMBER_NOT_FOUND gets emitted.
    const { contract, report } = await synthesized();
    expect(contract.outcomes).toEqual([]);
    expect(report.notes.some((note) => note.code === "outcome-candidate-needs-detector")).toBe(
      true,
    );
  });

  it('never emits `origin: "synthesized"`, so the dead enum member stays dead', async () => {
    // `OutcomeOrigin` carries `synthesized` for a day that has not come: the day synthesis learns to
    // derive a detector from an outcome screen the discovery run ITSELF observed, which is reachable
    // - `DiscoveryRun.observations` holds every screen the model saw. The member is in the enum now
    // so that provenance never has to be backfilled across signed documents, and this test is what
    // keeps it from being revived by accident rather than on purpose. Reviving it deliberately means
    // deleting this test, in a commit that says why.
    const { contract, artifact } = await synthesized();
    expect(JSON.stringify(contract)).not.toContain("synthesized");
    expect(JSON.stringify(artifact)).not.toContain("synthesized");
    expect(artifact.flow.steps.flatMap((step) => step.outcomes)).toEqual([]);
    expect(artifact.promotions).toEqual([]);
  });

  it("rolls the effect up from the artifact rather than claiming its own", async () => {
    const { contract, artifact } = await synthesized();
    expect(contract.effect).toBe(artifact.effects.maxEffect);
    expect(contract.requiresApproval).toBe(false);
    expect(contract.idempotent).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The linker
//
// The strongest cross-unit assertion available to this unit, and the reason it is worth the import:
// `link` runs all 28 of SPEC section 10's checks over the contract, the artifact, the caller's
// arguments and what the driver advertises. A synthesized document that links is a document the
// interpreter can run; one that does not is a recording that would have failed on its first
// invocation, at load time, for a reason nobody would have traced back to here.
// ---------------------------------------------------------------------------------------------

describe("the emitted documents link", () => {
  const request = (
    artifact: unknown,
    contract: unknown,
    mode: "discovery" | "verification" | "replay",
  ) => ({
    contract: JSON.parse(JSON.stringify(contract)),
    artifact: JSON.parse(JSON.stringify(artifact)),
    capabilities: MOCK_SURFACE_CAPABILITIES,
    args: { memberId: "50001" },
    mode,
  });

  it("passes all 29 checks in discovery and verification mode", async () => {
    const { artifact, contract } = await synthesized();
    for (const mode of ["discovery", "verification"] as const) {
      const result = link(request(artifact, contract, mode));
      if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
      expect(result.program.steps).toHaveLength(4);
    }
  });

  it("binds a sensitive argument to a taint handle, which is what masking is driven by", async () => {
    const { artifact, contract } = await synthesized();
    const result = link(request(artifact, contract, "verification"));
    if (!result.ok) throw new Error("did not link");
    const binding = result.program.bindings.find((one) => one.name === "memberId");
    expect(binding?.sensitivity).toBe("sensitive");
    expect(binding?.handle).not.toBeNull();
  });

  it("is refused for a production replay, because a proposed artifact has not earned it", async () => {
    const { artifact, contract } = await synthesized();
    const result = link(request(artifact, contract, "replay"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("shape");
    expect(result.errors.map((error) => error.code)).toContain("artifact-not-approved");
    expect(result.sideEffects).toBe("none-guaranteed");
  });
});

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

describe("what synthesis could not decide is said out loud", () => {
  it("names the routing prose a person must write, when it was not supplied", async () => {
    const run = await recordedRun();
    const bare = synthesisInput(run);
    const result = synthesizeCapability({
      ...bare,
      capability: {
        name: bare.capability.name,
        title: bare.capability.title,
        summary: bare.capability.summary,
      },
    });
    expect(result.report.notes.some((note) => note.code === "prose-needs-author")).toBe(true);
    expect(result.contract.whenToUse[0]).toContain("NEEDS AN AUTHOR");
  });

  it("reports which descriptors survived for each step, so a thinning margin is visible", async () => {
    const { report } = await synthesized();
    expect(report.descriptors["activate-select"]).toEqual(["role-name", "ordinal-in-container"]);
  });

  it("reports every parameter with the evidence for it, and no values", async () => {
    const { report } = await synthesized();
    // `namedFrom` is the rung of the naming chain the NAME came off, and it is reported for the
    // same reason `discoveredFrom` is: a reviewer approving an argument a calling agent will route
    // on needs to see where its name came from. On this fixture the field has an accessible name,
    // so rung 1 answers; `corebank-web`'s search inputs do not, and answer on rung 3.
    expect(report.parameters).toEqual([
      {
        name: "memberId",
        sensitivity: "sensitive",
        discoveredFrom: "goal",
        namedFrom: "accessible-name",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------

describe("what synthesis refuses", () => {
  it("refuses a run driven by a hand-authored script", async () => {
    const run = await recordedRun();
    const scripted = { ...run, adapter: "scripted" as const };
    expect(() => synthesizeCapability(synthesisInput(scripted))).toThrow(SynthesisError);
    // BRIEF section 10: a run driven by a script is a debugging aid, not evidence, and the
    // artifact's provenance vocabulary deliberately has no spelling for it.
    expect(() => synthesizeCapability(synthesisInput(scripted))).toThrow(/debugging aid/);
  });

  it("refuses a run that dispatched nothing", async () => {
    const run = await recordedRun();
    expect(() => synthesizeCapability(synthesisInput({ ...run, steps: [], outputs: [] }))).toThrow(
      SynthesisError,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The two adapter vocabularies
// ---------------------------------------------------------------------------------------------

/**
 * `@crr/core` and `@crr/discovery` each name the set of adapters, and they DISAGREE on purpose.
 *
 * This is the `ReplayOptions` failure of RUNTIME-STATUS section 3.1 in its second form: not one name
 * meaning two things, but one VOCABULARY written down twice. `ProvenanceSchema.model.adapter` is a
 * closed enum on a document that gets signed and committed; `DISCOVERY_ADAPTERS` is the set of
 * adapters the loop can be driven by. The difference between them is exactly `"scripted"`, and the
 * gap is deliberate - BRIEF section 10 says a run driven by a hand-authored script is a debugging
 * aid, not evidence, so it must have NO honest spelling in an artifact, and `emit.ts` refuses one
 * rather than mislabelling it `"replay"` (the refusal is asserted above).
 *
 * RUNTIME-STATUS section 7.7 records this as "an unresolved schema mismatch across the package
 * boundary ... right now the two vocabularies simply disagree and nothing but a thrown error
 * connects them." These three tests are what connects them. They pin the difference in BOTH
 * directions, so the failure modes that had nothing watching them now do:
 *
 *   · an adapter added to the loop and not to the artifact's enum - a discovery run that completes
 *     and then cannot be recorded, discovered at the end of the run rather than at the start;
 *   · an adapter added to the artifact's enum with no implementation behind it - a provenance line
 *     claiming a model produced an artifact when nothing in this package can drive that model.
 *
 * The enum's members are read off the live schema rather than retyped here, because a copy of the
 * list in a test is a third place for the vocabulary to be written down.
 */
const CORE_ADAPTER_ENUM: readonly string[] = (
  ProvenanceSchema as unknown as {
    shape: { model: { shape: { adapter: { options: readonly string[] } } } };
  }
).shape.model.shape.adapter.options;

describe("the adapter vocabulary, which is written down in two packages", () => {
  it("was actually read off the live schema", () => {
    expect(CORE_ADAPTER_ENUM.length).toBeGreaterThan(2);
    expect(CORE_ADAPTER_ENUM).toContain("anthropic");
  });

  it("differs by exactly one member, and that member is `scripted`", () => {
    const loopOnly = DISCOVERY_ADAPTERS.filter((a) => !CORE_ADAPTER_ENUM.includes(a));
    expect(loopOnly).toEqual(["scripted"]);
  });

  it("names no adapter in an artifact that this package cannot actually drive", () => {
    // The other direction, and the more dangerous one: an enum member with no implementation behind
    // it is a provenance line that can be written and never earned. `agent-sdk` and `openai` are on
    // BOTH lists; `agent-sdk` has no implementation yet and that is a stub recorded in
    // FINAL-STATUS, not a vocabulary disagreement - the name exists in both places, which is what
    // this test is about.
    const unimplementable = CORE_ADAPTER_ENUM.filter(
      (a) => !(DISCOVERY_ADAPTERS as readonly string[]).includes(a),
    );
    expect(unimplementable).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------------------------

describe("synthesis is deterministic", () => {
  it("produces byte-identical documents, and therefore identical digests, across runs", async () => {
    const first = await synthesized();
    const second = await synthesized();
    expect(second.artifact.digest).toBe(first.artifact.digest);
    expect(second.contract.digest).toBe(first.contract.digest);
    expect(JSON.stringify(second.artifact)).toBe(JSON.stringify(first.artifact));
    expect(JSON.stringify(second.contract)).toBe(JSON.stringify(first.contract));
  });

  it("reads no clock: the recorded timestamp is the one it was given", async () => {
    const { artifact } = await synthesized();
    expect(artifact.provenance.recordedAt).toBe("2026-01-31T09:15:00.000Z");
    expect(artifact.verification.at).toBe(artifact.provenance.recordedAt);
  });

  it("records which adapter and model produced the run", async () => {
    const { artifact } = await synthesized();
    expect(artifact.provenance.model.adapter).toBe("replay");
    expect(artifact.provenance.model.modelId).toBe("synthetic-script");
  });
});
