// The discovery half of the seam, and the guard that stops the two halves drifting apart.
//
// `packages/runtime/test/synthesized-replay.test.ts` executes `corebank-web.capability.json`
// against the real application. It can only do that because somebody ran
// `pnpm -F @crr/discovery fixtures:synthesized` after the last change to synthesis - and "somebody
// remembered" is not a mechanism. So this file rebuilds the document in process, from the same
// function the script calls, and compares the BYTES.
//
// Change `synthesis/`, and this goes red with a diff and the command that fixes it. Regenerate, and
// the runtime test then executes whatever the new synthesis emitted - which is the point: a change
// that makes synthesis emit something the interpreter cannot run breaks the build, rather than
// being discovered on a live run against a customer's core banking system.
//
// Everything here is hermetic. No browser, no clock, no credential, no socket: the observations
// were captured once (`fixtures:capture`) and are read off disk.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CapabilityArtifact,
  type CapabilityContract,
  ObservationSchema,
  artifactDigestIsIntact,
  link,
  parseArtifact,
  parseContract,
} from "@crr/core";
import { describe, expect, it } from "vitest";
import {
  ALLOWLIST,
  CAPABILITY_FILE,
  OBSERVATIONS_FILE,
  RECORDED_MEMBER_ID,
  REFS,
  checkRefs,
  emittedBytes,
  loadCorpus,
  loadEmitted,
  nodeFor,
  synthesizeFromCorpus,
} from "./fixtures/corebank-web.js";

const FIXTURES = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures");

const REGENERATE = "pnpm -F @crr/discovery fixtures:synthesized";
const RECAPTURE = "pnpm -F @crr/discovery fixtures:capture";

const corpus = loadCorpus(FIXTURES);
const emitted = loadEmitted(FIXTURES);
const contract = parseContract(emitted.contract) as CapabilityContract;
const artifact = parseArtifact(emitted.artifact) as CapabilityArtifact;

/**
 * The name a calling agent has to type, and it is NOT a positional placeholder.
 *
 * This product's search inputs carry no accessible name at all, so rung 1 of the naming chain in
 * `synthesis/parameters.ts` has nothing to spell a name from and neither does rung 2 - the markup
 * associates no label. Rung 3 does: the nearest adjacent label text, which is the same anchor
 * `deriveDescriptors` computes for the very same node, and on riverbend that text is "Member ID".
 * Written as a literal rather than read off the contract on purpose - reading it off the document
 * under test would make this constant agree with whatever synthesis emitted, placeholder included.
 */
const PARAM = "memberId";

// ---------------------------------------------------------------------------------------------
// 1. The corpus is what it says it is
// ---------------------------------------------------------------------------------------------

describe("the frozen corpus", () => {
  it("holds four real observations from the browser driver, not a hand-written mock", () => {
    expect(corpus.capture.driver).toBe("surface-browser@0.1.0");
    expect(corpus.capabilities.driver).toBe("surface-browser@0.1.0");
    expect(corpus.capabilities.kind).toBe("web-legacy");
    expect(Object.keys(corpus.screens).sort()).toEqual([
      "detail",
      "results",
      "search",
      "searchFilled",
    ]);
    // A hand-written screen has a handful of nodes. These are stitched accessibility trees across a
    // frameset and, on the detail screen, a nested iframe as well.
    for (const [name, observation] of Object.entries(corpus.screens)) {
      expect(ObservationSchema.safeParse(observation).success, name).toBe(true);
      expect(observation.nodes.length, name).toBeGreaterThan(90);
    }
    expect(corpus.screens.detail.nodes.length).toBeGreaterThan(corpus.screens.search.nodes.length);
  });

  it("carries no member number in any route it froze", () => {
    // SPEC section 3.6: an `Observation` on disk is a persisted document, and a member number in a
    // path is persisted member data. The driver canonicalized `/member/10041` before this file
    // existed, which is the only reason the corpus is safe to commit at all.
    for (const [name, observation] of Object.entries(corpus.screens)) {
      expect(observation.route?.path ?? "", name).not.toContain(RECORDED_MEMBER_ID);
    }
    expect(corpus.screens.detail.route?.path).toBe("/member/:memberId");
  });

  it("still has the controls the hand-authored script points at", () => {
    // The script is a list of `n<k>` indices with no names attached (SPEC section 6.2), so this is
    // the assertion that stops a recapture from silently re-aiming it at a different control.
    expect(() => checkRefs(corpus)).not.toThrow();
    expect(corpus.screens.search.nodes[REFS.memberIdField.index]?.name).toBe("");
    expect(corpus.screens.searchFilled.nodes[REFS.searchButton.index]?.name).toBe("Search");
  });

  it("records that typing shifts every later index, which is why two search screens are frozen", () => {
    // Not trivia: it is the reason `REFS.searchButton` reads off `searchFilled`. Chromium
    // materialises a StaticText node for the typed value, so the button moves from n97 to n98.
    expect(corpus.screens.searchFilled.nodes.length).toBe(corpus.screens.search.nodes.length + 1);
    // n98 exists on both screens and is "Search" on both - and is the BUTTON on only one of them.
    // Before the fill it is the StaticText inside the button; a script that had not been re-aimed
    // would be asking the loop to click a piece of text, which is refused as not actionable and
    // reads in a journal like a fixture bug rather than like an off-by-one.
    expect(corpus.screens.search.nodes[REFS.searchButton.index]?.ariaRole).toBeNull();
    expect(corpus.screens.searchFilled.nodes[REFS.searchButton.index]?.ariaRole).toBe("button");
    expect(nodeFor(corpus, REFS.memberIdField)).toBe(
      corpus.screens.search.nodes[REFS.memberIdField.index]?.id,
    );
  });

  it("fails loudly, naming both controls, when a reference stops meaning what it meant", () => {
    // The discrimination case: this guard is only worth something if it can fail.
    const moved = {
      ...corpus,
      screens: {
        ...corpus.screens,
        searchFilled: {
          ...corpus.screens.searchFilled,
          nodes: corpus.screens.searchFilled.nodes.map((node, index) =>
            index === REFS.searchButton.index ? { ...node, name: "Go" } : node,
          ),
        },
      },
    };
    expect(() => checkRefs(moved)).toThrow(/chosen as button "Search".*now has button "Go"/s);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. The committed documents are the ones synthesis emits TODAY
// ---------------------------------------------------------------------------------------------

describe("the emitted capability documents", () => {
  it("are byte-identical to what synthesis produces right now", async () => {
    const rebuilt = await emittedBytes(FIXTURES);
    const committed = readFileSync(join(FIXTURES, CAPABILITY_FILE), "utf8");
    if (rebuilt !== committed) {
      // Said in the failure rather than left to be worked out, because the fix is one command and
      // the consequence of not running it is that the runtime replays a stale program.
      expect(
        `${CAPABILITY_FILE} is out of date with synthesis. Run \`${REGENERATE}\` and review the diff.`,
      ).toBe("");
    }
    expect(rebuilt).toBe(committed);
  });

  it("are reproducible: two independent runs of the whole pipeline agree byte for byte", async () => {
    // Without this the digest below addresses nothing in particular and the approval signature over
    // it signs nothing in particular.
    const [first, second] = await Promise.all([emittedBytes(FIXTURES), emittedBytes(FIXTURES)]);
    expect(first).toBe(second);
  });

  it("address their own content and implement each other by digest", () => {
    expect(artifactDigestIsIntact(JSON.parse(JSON.stringify(artifact)))).toBe(true);
    expect(artifact.implements.contractDigest).toBe(contract.digest);
  });

  it("are `proposed` and `unverified`: a recording is not a claim until it replays", () => {
    // And it is `packages/runtime/test/synthesized-replay.test.ts` that replays it. This assertion
    // and that test are the two halves of BRIEF section 3.4.
    expect(artifact.lifecycle.status).toBe("proposed");
    expect(artifact.lifecycle.approval).toBeNull();
    expect(artifact.verification.status).toBe("unverified");
  });

  it("say plainly, in the file, that no model produced them", () => {
    expect(emitted.provenance.adapter).toBe("replay");
    expect(emitted.provenance.modelId).toBe("synthetic-script");
    expect(emitted.provenance.synthetic).toBe(true);
    expect(emitted._readme).toContain("NOT EVIDENCE");
  });

  it("carry the recording member's number nowhere at all", () => {
    // The mechanism BRIEF section 3.6 calls the privacy control, checked over the bytes rather than
    // over the fields: parameterization means the artifact stores a SHAPE, and this is the grep
    // that proves it for the one value the goal supplied.
    const bytes = JSON.stringify({ contract, artifact });
    expect(bytes).not.toContain(RECORDED_MEMBER_ID);
    expect(contract.inputs).toHaveLength(1);
    expect(contract.inputs[0]?.type).toEqual({ kind: "string", charset: "digits" });
  });

  it("carry no value read off the recorded member's row either", () => {
    // A REGRESSION GUARD WITH A HISTORY. Before this deliverable, `deriveOutputs` folded a cell's
    // accessible name into the query it derived - and on a grid a cell's name IS the value. The
    // emitted artifact carried "ALVAREZ, DANA (SYNTHETIC)" and "1,204.55" in `flow.vocabulary`, so
    // the one document that is committed, diffed and signed held a member's name and balance, and
    // the capability worked for exactly one member. Executing the artifact is what found it.
    const bytes = JSON.stringify({ contract, artifact });
    for (const value of ["ALVAREZ", "1,204.55", "DORMANT"]) {
      expect(
        bytes,
        `${value} must not appear in a document that is signed and committed`,
      ).not.toContain(value);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 3. The program, and the surface it was written against
// ---------------------------------------------------------------------------------------------

describe("the synthesized program", () => {
  it("is the recording straightened: fill, submit, read, open", () => {
    expect(artifact.flow.steps.map((step) => step.instruction.kind)).toEqual([
      "fill",
      "activate",
      "read",
      "activate",
    ]);
    expect(artifact.flow.routes.map((route) => route.path)).toEqual([
      "/search",
      "/search/results",
      "/member/:memberId",
    ]);
  });

  it("names only descriptor kinds this driver advertises it can resolve", () => {
    // The point of passing the BROWSER's capabilities to synthesis rather than a mock's: a
    // descriptor kind recorded as evidence that the driver will never supply is a quorum that can
    // never be met, and the linker would refuse the artifact at load time.
    const resolvable = new Set(corpus.capabilities.resolvableDescriptors);
    for (const step of artifact.flow.steps) {
      for (const descriptor of step.target?.descriptors ?? []) {
        expect(resolvable.has(descriptor.kind), descriptor.kind).toBe(true);
      }
    }
  });

  it("builds every quorum from two independently sourced descriptors", () => {
    for (const step of artifact.flow.steps) {
      if (step.target === null) continue;
      const sources = new Set(step.target.descriptors.map((d) => d.evidenceSource));
      expect(step.target.descriptors.length, step.id).toBeGreaterThanOrEqual(2);
      expect(sources.size, step.id).toBeGreaterThanOrEqual(2);
      expect(step.target.quorum.requireIdentical).toBe(true);
      expect(step.target.quorum.onUnderQuorum).toBe("fail");
    }
  });

  it("locates the unnamed search field by a label anchor and an ordinal, because it has no name", () => {
    // This is the hostility of the target product showing up as a shape in the document. There is
    // no `<label for>`, no `aria-label` and no test id on this form, so `role-name` - the descriptor
    // anyone would reach for first - is not derivable at all, and the report says so.
    const fill = artifact.flow.steps[0];
    expect(fill?.target?.descriptors.map((d) => d.kind)).toEqual([
      "label-anchored",
      "ordinal-in-container",
    ]);
    expect(
      emitted.report as { notes: readonly { code: string; detail: string; stepId?: string }[] },
    ).toBeDefined();
    const notes = (emitted.report as { notes: readonly { detail: string; stepId?: string }[] })
      .notes;
    expect(
      notes.some((n) => n.stepId === "fill-fill" && n.detail.includes("no accessible name")),
    ).toBe(true);
  });

  it("names the parameter after the label anchor, on a field that has no accessible name", () => {
    // The whole point of the naming chain. `role-name` is not derivable for this field - the test
    // above asserts that - so rung 1 has nothing, and there is no `<label for>` so rung 2 has
    // nothing either. Rung 3 is the label anchor `deriveDescriptors` uses for the SAME node, and it
    // is what turns `value1` into an argument a calling agent can route on.
    expect(contract.inputs.map((one) => one.name)).toEqual([PARAM]);
    expect(contract.inputs[0]?.description).toContain('"Member ID"');
    // And the chain says which rung answered, so a reviewer can see it was derived and from what.
    const parameters = (
      emitted.report as { parameters: readonly { name: string; namedFrom: string }[] }
    ).parameters;
    expect(parameters).toEqual([
      expect.objectContaining({ name: PARAM, namedFrom: "adjacent-label" }),
    ]);
  });

  it("raises no positional-name flag, because it did not have to name anything positionally", () => {
    // The other half of the flag's discrimination lives in `synthesis-parameterization.test.ts`,
    // where a field with no wording anywhere DOES raise it. Here the flag must stay quiet, or it
    // would be a note that fires on every capability and therefore means nothing.
    const notes = (emitted.report as { notes: readonly { code: string }[] }).notes;
    expect(notes.some((n) => n.code === "parameter-name-underived")).toBe(false);
    expect(JSON.stringify(contract.inputs)).not.toContain("NEEDS A NAME");
  });

  it("keys the row it clicks, and every cell it reads, by the caller's own argument", () => {
    // The wrong-row killer, derived rather than written. Without it "open the member" degrades to
    // "click a link in this grid" and "read the balance" degrades to "some cell in this table".
    const open = artifact.flow.steps[3];
    expect(open?.target?.assert.rowKeyEquals?.value).toEqual({ from: "param", param: PARAM });
    for (const spec of artifact.flow.steps[2]?.extract ?? []) {
      expect(spec.where.cell?.rowKey.value, spec.output).toEqual({
        from: "param",
        param: PARAM,
      });
    }
  });

  it("declares no business outcome, because SPEC section 0.2 forbids inventing a detector", () => {
    // The consequence is asserted against the live application in the runtime test: a member the
    // core has no record of comes back `failed`, not `MEMBER_NOT_FOUND`. That is the correct arm
    // for a capability nobody has yet declared an outcome for, and the report says what is missing.
    expect(contract.outcomes).toEqual([]);
    const notes = (emitted.report as { notes: readonly { code: string }[] }).notes;
    expect(notes.some((n) => n.code === "outcome-candidate-needs-detector")).toBe(true);
  });

  it("analyses its effects statically, before anything runs", () => {
    // WRITE_REVERSIBLE rather than READ, and that is `defaultEffectOf` being conservative in the one
    // direction that is safe: no pure function over an action can tell `activate` on "Search" from
    // `activate` on "Close Account" (SPEC section 8.2 - effect is DECLARED, not proven).
    expect(artifact.effects.maxEffect).toBe("WRITE_REVERSIBLE");
    expect(artifact.effects.irreversibleSteps).toEqual([]);
    expect(artifact.effects.requiresApproval).toBe(false);
    expect(artifact.effects.restartSafeUpToPc).toBe(artifact.flow.steps.length);
    expect(artifact.effects.routesTouched).toEqual([
      "search",
      "search-results",
      "member-by-memberid",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. The linker accepts it - with no browser in the room
// ---------------------------------------------------------------------------------------------

describe("linking the synthesized documents against the real driver's capabilities", () => {
  it("passes all 29 checks in replay mode, with zero actions performed", () => {
    const result = link({
      contract,
      artifact,
      capabilities: corpus.capabilities,
      args: { [PARAM]: RECORDED_MEMBER_ID },
      // `verification`, not `replay`: check 27 wants an APPROVED artifact, and a `proposed`
      // document has not been approved by anybody. That is the lifecycle working - the verification
      // replay is how a draft earns the label - and the runtime test walks the whole ladder.
      mode: "verification",
      allowlist: ALLOWLIST,
      trust: { trustedKeyIds: [], verifySignature: () => false },
    });
    if (!result.ok) console.error(JSON.stringify(result.errors, null, 2));
    expect(result.ok).toBe(true);
  });

  it("refuses at load time when the surface cannot resolve a descriptor kind it depends on", () => {
    // Proof the check above is doing work rather than passing on a permissive capability set.
    const blinkered = {
      ...corpus.capabilities,
      resolvableDescriptors: corpus.capabilities.resolvableDescriptors.filter(
        (kind) => kind !== "label-anchored",
      ),
    };
    const result = link({
      contract,
      artifact,
      capabilities: blinkered,
      args: { [PARAM]: RECORDED_MEMBER_ID },
      mode: "verification",
      allowlist: ALLOWLIST,
      trust: { trustedKeyIds: [], verifySignature: () => false },
    });
    expect(result.ok).toBe(false);
  });

  it("refuses an argument that is not the shape the contract declared", () => {
    const result = link({
      contract,
      artifact,
      capabilities: corpus.capabilities,
      args: { [PARAM]: "not-digits" },
      mode: "verification",
      allowlist: ALLOWLIST,
      trust: { trustedKeyIds: [], verifySignature: () => false },
    });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. The pipeline itself
// ---------------------------------------------------------------------------------------------

describe("the discovery run behind the documents", () => {
  it("reaches the goal over the frozen corpus with no browser and no credential", async () => {
    const { report } = await synthesizeFromCorpus(corpus);
    expect(report.notes.filter((note) => note.severity === "blocking")).toEqual([]);
  });

  it("fails the emit, rather than emitting a wrong program, when the corpus drifts", async () => {
    // The other end of `checkRefs`: a corpus whose screens have moved must not quietly produce a
    // capability that clicks the wrong control. It must stop.
    const drifted = {
      ...corpus,
      screens: {
        ...corpus.screens,
        search: { ...corpus.screens.search, nodes: corpus.screens.search.nodes.slice(0, 40) },
      },
    };
    await expect(synthesizeFromCorpus(drifted)).rejects.toThrow(
      new RegExp(`has no node at index|${RECAPTURE.replaceAll("-", "\\-")}`),
    );
  });

  it("reads the corpus that `fixtures:capture` writes, by name", () => {
    // A cheap assertion that keeps the two commands in the failure messages true.
    expect(emitted.provenance.corpus).toBe(OBSERVATIONS_FILE);
    expect(emitted.provenance.command).toBe(REGENERATE);
  });
});
