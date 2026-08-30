// The promotion operation, end to end, with nothing hand-written that a run could have produced.
//
// The two probes below are REAL RUNS of a REAL artifact through the real interpreter, the real
// policy chokepoint and the real redaction path, against a `MockSurface`. Their journals and their
// frozen observations are what the proof draws on - which is the whole point, because the one thing
// a reviewer must not be able to do is decide what a screen said or which step it came from.
//
// The starting pair is deliberately `v1`: a verified draft with NO business outcome, exactly the
// document synthesis emits and exactly the document `evidence/discovery-live/synthesized/` ships.
// A member the core does not hold makes it return `failed`, because nobody has declared what that
// screen means yet. Closing that gap is what a promotion is for, and the run that returned `failed`
// is where the positive comes from - the design's intended steady state rather than a special case.

import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CapabilityArtifact,
  type CapabilityContract,
  MOCK_LEASE_TOKEN,
  MOCK_SURFACE_CAPABILITIES,
  MockSurface,
  type MockTransition,
  type Predicate,
  digestOf,
  link,
  sealArtifact,
  sealContract,
} from "@crr/core";
import { describe, expect, it } from "vitest";
import { generateApprovalKeyPair } from "../src/approval.js";
import { manualClock } from "../src/clock.js";
import { FileEvidenceSink } from "../src/evidence.js";
import { sequentialIds } from "../src/ids.js";
import { FileJournal } from "../src/journal.js";
import { LifecycleError, approve } from "../src/lifecycle.js";
import { confirmProbe, promote, readCorpus } from "../src/promote.js";
import { replay } from "../src/replay.js";
import { StaticSessionBroker } from "../src/session.js";
import { verifyAndDraft } from "../src/verify.js";
import {
  IDS,
  MOCK_MEMBER_ID,
  mockAllowlist,
  mockArtifact,
  mockContract,
  mockTrust,
  screens,
  token,
} from "./fixtures/mock-flow.js";

// ---------------------------------------------------------------------------------------------
// v1: the pair as synthesis leaves it - a verified draft with `outcomes: []`
// ---------------------------------------------------------------------------------------------

const contractV1: CapabilityContract = sealContract({
  ...mockContract,
  digest: undefined,
  outcomes: [],
});

const artifactV1: CapabilityArtifact = (() => {
  const approved = mockArtifact();
  return sealArtifact({
    ...approved,
    digest: undefined,
    signatures: [],
    implements: { ...approved.implements, contractDigest: contractV1.digest },
    // A DRAFT, not an approval. `promote` refuses anything else: a program that has never replayed
    // itself with the model out of the loop has nothing for a detector to be added to.
    lifecycle: { status: "draft", supersedes: null, approval: null },
    flow: {
      ...approved.flow,
      steps: approved.flow.steps.map((step) => ({ ...step, outcomes: [] })),
    },
  });
})();

const HAPPY: readonly MockTransition[] = [
  { from: "blank", on: { kind: "navigate", path: "/search" }, to: "search" },
  { from: "search", on: { kind: "type", target: IDS.memberIdField }, to: "search-typed" },
  { from: "search-typed", on: { kind: "click", target: IDS.searchButton }, to: "results" },
];

/** The same flow against a member the core does not hold. v1 has no detector, so it fails. */
const NOT_FOUND: readonly MockTransition[] = [
  { from: "blank", on: { kind: "navigate", path: "/search" }, to: "search" },
  { from: "search", on: { kind: "type", target: IDS.memberIdField }, to: "search-typed" },
  { from: "search-typed", on: { kind: "click", target: IDS.searchButton }, to: "results-empty" },
];

/**
 * One probe: `replay` with `captureEvery`, into a real evidence directory beside a real journal.
 *
 * `captureEvery` is what `crr probe --capture-every` sets, and it is a RUNTIME option: every step of
 * `mockArtifact` declares `captureOn: ["failure"]`, so without it the green run below writes NOTHING
 * and the one observation the proof cannot do without does not exist. The artifact is byte-identical
 * either way, which is the property that keeps the probe from moving a content address an approval
 * signs.
 */
async function probe(options: {
  readonly dir: string;
  readonly transitions: readonly MockTransition[];
  readonly args: Readonly<Record<string, unknown>>;
  readonly artifact?: CapabilityArtifact;
  readonly contract?: CapabilityContract;
  readonly captureEvery?: boolean;
}) {
  const clock = manualClock();
  const out = await replay({
    contract: options.contract ?? contractV1,
    artifact: options.artifact ?? artifactV1,
    args: options.args,
    tenant: { tenantId: "riverbend", appInstanceId: "riverbend-mock" },
    allowlist: mockAllowlist,
    broker: new StaticSessionBroker(
      new MockSurface({
        screens,
        start: "blank",
        transitions: options.transitions,
        lease: MOCK_LEASE_TOKEN,
      }),
    ),
    trust: mockTrust,
    clock,
    ids: sequentialIds("probe"),
    // `mode: "verification"` because v1 is a DRAFT and the policy chokepoint refuses to let an
    // unapproved artifact drive a surface in `replay`. A probe is not a production invocation.
    mode: "verification",
    ...(options.captureEvery === false ? {} : { captureEvery: true }),
    evidence: new FileEvidenceSink(join(options.dir, "observations")),
    journal: (runId) => new FileJournal({ runId, clock, path: join(options.dir, "journal.jsonl") }),
    onIntervention: "fail",
  });
  return out;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "crr-promote-"));
}

// ---------------------------------------------------------------------------------------------
// The corpus the two probes produce
// ---------------------------------------------------------------------------------------------

const bundles = await (async () => {
  const green = tempDir();
  const condition = tempDir();
  const greenRun = await probe({
    dir: green,
    transitions: HAPPY,
    args: { memberId: MOCK_MEMBER_ID },
  });
  const conditionRun = await probe({
    dir: condition,
    transitions: NOT_FOUND,
    args: { memberId: "00000" },
  });
  return { green, condition, greenRun, conditionRun };
})();

/** The screen the condition probe froze at `submit-search`, found the way `crr probe`'s table shows
 *  it: by reading the journal, not by guessing which file is which. */
const POSITIVE_DIGEST = (() => {
  const corpus = readCorpus([bundles.condition]);
  const entry = corpus.entries.find(
    (e) =>
      e.atStep === "submit-search" &&
      e.phase === "post" &&
      e.observation.route?.path === "/results",
  );
  if (entry === undefined) throw new Error("the condition probe froze no /results screen");
  return digestOf(entry.observation);
})();

const DETECTOR: Predicate = {
  kind: "text-present",
  scope: {
    path: [{ kind: "frame", name: { mode: "exact", value: "content", normalize: "std.text@1" } }],
  },
  text: token("not-found-banner"),
} as unknown as Predicate;

const review = (over: Record<string, unknown> = {}) => ({
  schemaVersion: "capability.promotion/v1",
  promotes: {
    capability: contractV1.name,
    contractVersion: contractV1.version,
    artifactDigest: artifactV1.digest,
  },
  reviewedBy: "ops-approver-4",
  reviewedAt: "2026-08-29T12:00:00.000Z",
  outcome: {
    code: "MEMBER_NOT_FOUND",
    kind: "business_outcome",
    title: "No member with that number",
    summary: "The core system holds no member with the number supplied.",
    terminal: true,
    payload: [],
    stableUnderRetry: true,
    stableUnderRetryBecause:
      "the core holding no such member is a fact about the record; the next attempt with the same number returns the same answer",
    callerAction: "retry-different-input",
    retryable: "with_different_inputs",
    agentGuidance: "Tell the member that number is not on file and ask them to read it again.",
  },
  detector: {
    atStep: "submit-search",
    priority: 10,
    phase: "post",
    requiresSettled: true,
    capture: [],
    detect: DETECTOR,
  },
  vocabulary: { "not-found-banner": ["No member found"] },
  evidence: {
    positives: [
      {
        observation: POSITIVE_DIGEST,
        fromRun: "run-probe-mock-1",
        atStep: "submit-search",
        tenantId: "riverbend",
        appInstanceId: "riverbend-mock",
      },
    ],
    corpusRefs: ["the condition probe", "the green probe"],
  },
  ...over,
});

const run = (over: Record<string, unknown> = {}, corpusDirs?: readonly string[]) =>
  promote({
    contract: contractV1,
    artifact: artifactV1,
    review: review(over),
    corpusDirs: corpusDirs ?? [bundles.condition, bundles.green],
    tenants: [{ tenantId: "riverbend" }],
    args: { memberId: "00000" },
    archiveDir: null,
  });

// ---------------------------------------------------------------------------------------------
// What the probes established, before anything is promoted
// ---------------------------------------------------------------------------------------------

describe("the probes", () => {
  it("a green run freezes NOTHING without --capture-every, which is why the flag exists", async () => {
    // The whole reason `crr probe` is a verb. Every step declares `captureOn: ["failure"]` - the
    // right default in production, because freezing every screen writes regulated data to disk at a
    // rate nobody wants - so the one observation an outcome promotion cannot do without is the one
    // observation the system never keeps.
    const dir = tempDir();
    await probe({
      dir,
      transitions: HAPPY,
      args: { memberId: MOCK_MEMBER_ID },
      captureEvery: false,
    });
    expect(readdirSync(join(dir, "observations")).filter((f) => f.startsWith("obs-"))).toEqual([]);
    expect(readCorpus([dir]).entries).toEqual([]);
  });

  it("freezes a screen at every step WITH it, and the journal says which step and phase", () => {
    const corpus = readCorpus([bundles.green]);
    expect(corpus.problems).toEqual([]);
    expect(corpus.entries.length).toBeGreaterThan(0);
    expect(corpus.entries.every((e) => e.runStatus === "ok")).toBe(true);
    expect(corpus.entries.map((e) => e.atStep)).toContain("submit-search");
    // Read off `evidence.captured`, which now carries `stepId` and `phase`. It used to be
    // positional, and a security-relevant binding inferred from line ordering is what this whole
    // path refuses to rest on.
    expect(
      corpus.entries.filter((e) => e.atStep === "submit-search" && e.phase === "post").length,
    ).toBeGreaterThan(0);
  });

  it("does not move the program's content address, because it never touches the document", () => {
    expect(bundles.greenRun.result.run.artifact.digest).toBe(artifactV1.digest);
  });

  it("returns `failed` for a member the core does not hold, because nobody declared the outcome yet", () => {
    // This is the gap. `contract.outcomes` is `[]`, so the honest answer to an empty results grid is
    // a hard failure - the run reached a screen the program has no vocabulary for. A caller is told
    // the truth and told nothing useful, which is what a promotion is for.
    expect(bundles.conditionRun.result.status).toBe("failed");
  });

  it("refuses an observation on disk that the journal never recorded capturing", () => {
    // A screen with no journal line has no step, no phase and no run behind it. Admitting one with
    // assumed metadata is how a reviewer aims a proof at the answer they want.
    const dir = tempDir();
    writeFileSync(join(dir, "journal.jsonl"), readFileSync(join(bundles.green, "journal.jsonl")));
    const observations = join(dir, "observations");
    new FileEvidenceSink(observations);
    writeFileSync(
      join(
        observations,
        "obs-0000000000000000000000000000000000000000000000000000000000000000.json",
      ),
      "{}\n",
    );
    const corpus = readCorpus([dir]);
    expect(corpus.problems.join(" ")).toContain("the journal never recorded capturing it");
    expect(corpus.entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The promotion
// ---------------------------------------------------------------------------------------------

describe("a promotion that proves out", () => {
  const report = run();

  it("proves the detector discriminates against the frozen corpus", () => {
    expect(report.ok, report.problems.join("; ")).toBe(true);
    expect(report.proofs.map((p) => p.proof.verdict)).toEqual(["discriminates"]);
    expect(report.proofs[0]?.proof.negatives.happyPathAtStep).toBeGreaterThan(0);
  });

  it("bumps the contract MAJOR, because an added outcome breaks an exhaustive switch", () => {
    // A MINOR bump would leave a caller pinned through `ContractPin` (linker check 4) silently
    // entitled to receive an arm its generated types have never heard of.
    expect(report.documents?.contract.version).toBe("2.0.0");
    expect(report.documents?.contract.outcomes.map((o) => o.code)).toEqual(["MEMBER_NOT_FOUND"]);
    expect(report.documents?.contract.outcomes[0]?.origin).toBe("reviewer-authored");
  });

  it("keeps the rationale off the contract, which is what a ROUTER reads", () => {
    expect(JSON.stringify(report.documents?.contract).includes("fact about the record")).toBe(
      false,
    );
  });

  it("emits artifact@v2 as PROPOSED, superseding v1, and leaves v1 exactly where it was", () => {
    const v2 = report.documents?.artifact;
    expect(v2?.version).toBe(2);
    expect(v2?.lifecycle).toEqual({ status: "proposed", supersedes: 1, approval: null });
    expect(v2?.verification.status).toBe("unverified");
    expect(v2?.implements.contractDigest).toBe(report.documents?.contract.digest);
    // v1 is still a valid, verified, approvable draft that answers `ok | failed` and never
    // MEMBER_NOT_FOUND - a TRUE description of a program with no detector.
    expect(artifactV1.lifecycle.status).toBe("draft");
    expect(artifactV1.flow.steps.flatMap((s) => s.outcomes)).toEqual([]);
  });

  it("writes the receipt with no clock and no run id, so v2's digest is reproducible", () => {
    const receipt = report.documents?.artifact.promotions[0];
    expect(receipt?.code).toBe("MEMBER_NOT_FOUND");
    expect(receipt?.atStep).toBe("submit-search");
    expect(receipt?.proof.verdict).toBe("discriminates");
    expect(receipt?.proof.provenAt).toEqual(["riverbend"]);
    expect(receipt?.probeConfirmed).toBe(false);
    // The gap REPORT section 7 names for `verification.runId`/`at` is not repeated here: every field
    // is a content address, an identity or a count, so re-running the same promotion over the same
    // review and the same corpus produces the same address.
    const again = run();
    expect(again.documents?.artifact.digest).toBe(report.documents?.artifact.digest);
    expect(JSON.stringify(receipt)).not.toContain("run-");
  });

  it("merges the reviewer's vocabulary additively", () => {
    const vocabulary = report.documents?.artifact.flow.vocabulary as Readonly<
      Record<string, readonly string[]>
    >;
    expect(vocabulary["not-found-banner"]).toEqual(["No member found"]);
  });

  it("links at the tenant it was proven at, and REFUSES at one it was not", () => {
    const v2 = report.documents?.artifact as CapabilityArtifact;
    const linkAt = (tenant: string) =>
      link({
        contract: report.documents?.contract,
        artifact: v2,
        capabilities: MOCK_SURFACE_CAPABILITIES,
        args: { memberId: MOCK_MEMBER_ID },
        mode: "replay",
        tenant,
        allowlist: mockAllowlist,
        trust: mockTrust,
      });
    // Not approved yet, so both refuse on check 27 - what is being asserted is check 29's presence
    // at the tenant nobody proved and its ABSENCE at the one somebody did.
    const here = linkAt("riverbend");
    const elsewhere = linkAt("summit");
    expect(here.ok === false && here.errors.some((e) => e.check === 29)).toBe(false);
    expect(elsewhere.ok === false && elsewhere.errors.some((e) => e.check === 29)).toBe(true);
    if (elsewhere.ok) return;
    expect(elsewhere.errors.find((e) => e.check === 29)?.message).toContain("proven at riverbend");
  });

  it("archives the review under its own digest when it is not a dry run", () => {
    const dir = tempDir();
    const written = promote({
      contract: contractV1,
      artifact: artifactV1,
      review: review(),
      corpusDirs: [bundles.condition, bundles.green],
      tenants: [{ tenantId: "riverbend" }],
      args: { memberId: "00000" },
      archiveDir: dir,
    });
    expect(written.ok).toBe(true);
    expect(written.documents?.archivedAt).toContain(
      (written.reviewDigest as string).replace(":", "-"),
    );
    // The binding runs ONE WAY, from the receipt to these bytes. Lose them and the receipt names a
    // document nobody can read - the stated cost of not making the review a fourth document.
    const archived = JSON.parse(readFileSync(written.documents?.archivedAt as string, "utf8"));
    expect(archived.outcome.stableUnderRetryBecause).toContain("fact about the record");
  });

  it("journals every step of itself: who promoted what, from which evidence, and what came back", () => {
    const steps: string[] = [];
    promote(
      {
        contract: contractV1,
        artifact: artifactV1,
        review: review(),
        corpusDirs: [bundles.condition, bundles.green],
        tenants: [{ tenantId: "riverbend" }],
        args: { memberId: "00000" },
        archiveDir: null,
      },
      { onEvent: (event) => steps.push(event.step) },
    );
    expect(steps).toEqual(["review-read", "corpus-read", "positive-bound", "proved", "emitted"]);
  });
});

// ---------------------------------------------------------------------------------------------
// What it refuses, and a refusal writes nothing
// ---------------------------------------------------------------------------------------------

describe("what a promotion refuses", () => {
  const refused = (report: ReturnType<typeof run>, needle: string) => {
    expect(report.ok).toBe(false);
    expect(report.documents).toBeNull();
    expect(report.problems.join(" | ")).toContain(needle);
  };

  it("a review written against a different program, by content address", () => {
    refused(
      run({
        promotes: {
          capability: contractV1.name,
          contractVersion: "1.0.0",
          artifactDigest: digestOf("somewhere else"),
        },
      }),
      "the review promotes artifact",
    );
  });

  it("a positive that is not on disk anywhere in the corpus", () => {
    refused(
      run({
        evidence: {
          positives: [
            {
              observation: digestOf("a screen nobody perceived"),
              fromRun: "run-probe-mock-1",
              atStep: "submit-search",
              tenantId: "riverbend",
              appInstanceId: "riverbend-mock",
            },
          ],
          corpusRefs: ["nowhere"],
        },
      }),
      "a hand-written one is refused",
    );
  });

  it("a positive the RUN JOURNAL says was captured at another step", () => {
    // THE CONTROL THE PURE PROOF DOES NOT PROVIDE. `packages/core/test/promotion.test.ts` measures
    // that a mis-scoped detector proves perfectly well once its positive is relabelled to follow it:
    // the predicate really does fire on that screen. What is wrong is the LABEL, and the label is
    // not the reviewer's to write - `evidence.captured` carries `stepId` for exactly this, and it is
    // read here rather than believed.
    const corpus = readCorpus([bundles.condition]);
    const elsewhere = corpus.entries.find((e) => e.atStep !== "submit-search");
    expect(elsewhere).toBeDefined();
    refused(
      run({
        detector: { ...review().detector, atStep: elsewhere?.atStep },
        evidence: {
          positives: [
            {
              observation: POSITIVE_DIGEST,
              fromRun: "run-probe-mock-1",
              atStep: elsewhere?.atStep,
              tenantId: "riverbend",
              appInstanceId: "riverbend-mock",
            },
          ],
          corpusRefs: ["the condition probe"],
        },
      }),
      "is not the reviewer's to assert",
    );
  });

  it("a detector that fires on the happy path, naming the screen and calling it what it is", () => {
    const report = run({
      detector: {
        ...review().detector,
        // "The search landed on the results route" is a perfectly true statement about the
        // not-found screen, and a perfectly true statement about the SUCCESSFUL one. It is the
        // shape of mistake the schema cannot catch, because nothing about the predicate is
        // malformed - it is simply not specific to the condition.
        detect: { kind: "route-matches", route: "results" },
      },
    });
    expect(report.ok).toBe(false);
    expect(report.documents).toBeNull();
    const proof = report.proofs[0]?.proof;
    expect(proof?.verdict).toBe("over-fires");
    if (proof?.verdict !== "over-fires") return;
    expect(proof.subclass).toBe("fires-on-happy-path");
    expect(proof.reason).toContain("a run that SUCCEEDED");
  });

  it("a corpus with no green capture at the step, and says how to get one", () => {
    const report = run({}, [bundles.condition]);
    expect(report.ok).toBe(false);
    const proof = report.proofs[0]?.proof;
    expect(proof?.verdict).toBe("corpus-too-thin");
    expect(proof?.reason).toContain("--capture-every");
  });

  it("an artifact that is not a verified draft", () => {
    const report = promote({
      contract: mockContract,
      artifact: mockArtifact(),
      review: review(),
      corpusDirs: [bundles.condition, bundles.green],
      tenants: [{ tenantId: "riverbend" }],
      archiveDir: null,
    });
    expect(report.ok).toBe(false);
    expect(report.problems.join(" ")).toContain("only a verified draft can be promoted");
  });

  it("a promotion with no tenant named, because a promotion is tenant-scoped", () => {
    const report = promote({
      contract: contractV1,
      artifact: artifactV1,
      review: review(),
      corpusDirs: [bundles.condition, bundles.green],
      tenants: [],
      archiveDir: null,
    });
    expect(report.ok).toBe(false);
    expect(report.problems.join(" ")).toContain("tenant-scoped");
  });
});

// ---------------------------------------------------------------------------------------------
// probeConfirmed - evidence, never a gate
// ---------------------------------------------------------------------------------------------

describe("confirming the probe against the promoted revision", () => {
  const v2 = run().documents?.artifact as CapabilityArtifact;

  it("stamps the receipt when the run really returned the outcome", () => {
    const stamped = confirmProbe(v2, "MEMBER_NOT_FOUND", {
      status: "outcome",
      outcome: "MEMBER_NOT_FOUND",
    });
    expect(stamped.artifact?.promotions[0]?.probeConfirmed).toBe(true);
  });

  it("refuses to stamp from a run that did not return it", () => {
    const stamped = confirmProbe(v2, "MEMBER_NOT_FOUND", { status: "ok" });
    expect(stamped.artifact).toBeNull();
    expect(stamped.reason).toContain("would be claiming");
  });

  it("is not a gate: the unconfirmed artifact is still a legal, approvable revision", () => {
    // Deliberate. `gradeVerification` refuses to grade a run that returned an outcome, and our
    // fixture can produce a condition on cue while a real core banking system cannot. So the gap is
    // PRINTED at approval time rather than closed by pretending every institution can arm one.
    expect(v2.promotions[0]?.probeConfirmed).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The SECOND gate: the live verification replay of the happy path
// ---------------------------------------------------------------------------------------------
//
// The naive objection to re-verifying is that promotion touches no step, no target and no
// instruction, so the happy path cannot have changed and re-running it is theatre. It is not, and
// this is the most important thing in the whole design: `classify.ts` evaluates band B3 (declared
// business outcomes) BEFORE band B5 (the checkpoint), and B3 is TERMINAL. A detector that matches
// something present on the SUCCESSFUL screen therefore does not produce a wrong-looking run - it
// produces a confident, green-looking `outcome` arm on a run that in fact succeeded, and the caller
// is told MEMBER_NOT_FOUND about a member who exists.
//
// The two gates are not redundant, and they fail differently. A detector keyed on a value that is
// stable in the frozen corpus and varies at runtime is caught by the replay and not by the proof; a
// detector keyed on a screen the happy path never reaches is caught by the proof and not by the
// replay.

describe("a hijacking detector, past the proof, at the verification replay", () => {
  it("turns a SUCCESSFUL run into a business outcome, and the existing gate fails closed on it", async () => {
    // Injected onto the happy path's own step, exactly as a promotion would place it - and the
    // proof would have refused this one, which is why it has to be built by hand to reach here.
    const v2 = sealArtifact({
      ...artifactV1,
      digest: undefined,
      version: 2,
      lifecycle: { status: "proposed", supersedes: 1, approval: null },
      verification: { ...artifactV1.verification, status: "unverified" },
      flow: {
        ...artifactV1.flow,
        steps: artifactV1.flow.steps.map((step) =>
          step.id !== "submit-search"
            ? step
            : {
                ...step,
                outcomes: [
                  {
                    code: "MEMBER_NOT_FOUND",
                    detect: { kind: "route-matches", route: "results" },
                    priority: 10,
                    phase: "post",
                    requiresSettled: true,
                    capture: [],
                    origin: "reviewer-authored",
                  },
                ],
              },
        ),
      },
      promotions: [
        {
          code: "MEMBER_NOT_FOUND",
          atStep: "submit-search",
          reviewDigest: digestOf("a review that should never have been accepted"),
          reviewedBy: "ops-approver-4",
          supersedesArtifactVersion: 1,
          proof: {
            verdict: "discriminates",
            proverVersion: "crr-prover/1",
            positives: [{ observation: POSITIVE_DIGEST, atStep: "submit-search" }],
            negatives: {
              corpusDigest: digestOf("a corpus that never contained a green screen"),
              total: 1,
              happyPathAtStep: 1,
              otherAbnormalAtStep: 0,
              otherSteps: 0,
              otherTenants: 0,
            },
            provenAt: ["riverbend"],
          },
          probeConfirmed: false,
        },
      ],
    });
    const contractV2 = sealContract({
      ...contractV1,
      digest: undefined,
      version: "2.0.0",
      outcomes: [{ ...mockContract.outcomes[0], origin: "reviewer-authored" }],
    });
    const v2Linked = sealArtifact({
      ...v2,
      digest: undefined,
      implements: { ...v2.implements, version: "2.0.0", contractDigest: contractV2.digest },
    });

    const clock = manualClock();
    const { report, artifact: drafted } = await verifyAndDraft({
      contract: contractV2,
      artifact: v2Linked,
      args: { memberId: MOCK_MEMBER_ID },
      tenant: { tenantId: "riverbend", appInstanceId: "riverbend-mock" },
      allowlist: mockAllowlist,
      broker: new StaticSessionBroker(
        new MockSurface({ screens, start: "blank", transitions: HAPPY, lease: MOCK_LEASE_TOKEN }),
      ),
      clock,
      ids: sequentialIds("verify"),
    });

    // The run SUCCEEDED at the surface. What came back is the outcome arm, which is precisely the
    // damage: without this gate, a green replay would have drafted a program that answers
    // MEMBER_NOT_FOUND for every member who is on file.
    expect(report.status).toBe("unverified");
    expect(report.result?.status).toBe("outcome");
    expect(report.grade).toBeNull();
    expect(report.verification).toBeNull();
    expect(report.reason).toContain("MEMBER_NOT_FOUND");
    // No new code. The engine already refused this, with the reason it already carries, in a live
    // session against a real driver with real settle timing - which the pure proof cannot do.
    expect(drafted).toBeNull();
    expect(v2Linked.lifecycle.status).toBe("proposed");
  });
});

// ---------------------------------------------------------------------------------------------
// Approval: the approver ticks the promoted code by hand
// ---------------------------------------------------------------------------------------------

describe("approving an artifact that carries a promotion", () => {
  const keys = generateApprovalKeyPair("promo-key-1");
  const draft = (() => {
    const v2 = run().documents?.artifact as CapabilityArtifact;
    // v2 is `proposed`; the real path to `draft` is a verification replay, and the point being
    // asserted here is the approval tick rather than the lifecycle, so the stamp is applied
    // directly.
    return sealArtifact({
      ...v2,
      digest: undefined,
      lifecycle: { status: "draft", supersedes: 1, approval: null },
      verification: { ...v2.verification, status: "verified" },
    });
  })();

  const options = {
    signer: keys.signer,
    approvedBy: "ops-approver-4",
    approvedAt: "2026-08-29T12:30:00.000Z" as never,
    acknowledgedGrade: "full" as const,
    acknowledgedEffects: ["READ" as const],
  };

  it("refuses when the approver did not tick the reviewer-authored code", () => {
    expect(() => approve(draft, options)).toThrow(LifecycleError);
    try {
      approve(draft, options);
    } catch (error) {
      expect((error as LifecycleError).reasons.join(" ")).toContain(
        "did not tick the reviewer-authored outcome MEMBER_NOT_FOUND",
      );
    }
  });

  it("refuses a tick for a code this artifact carries no receipt for", () => {
    // Both directions, exactly as the grade and the effects are refused: a missing code means a
    // human-authored outcome shipped unread, an extra one means the approver believes they accepted
    // something this document does not contain.
    try {
      approve(draft, {
        ...options,
        acknowledgedPromotions: ["MEMBER_NOT_FOUND", "ACCOUNT_CLOSED"],
      });
      expect.unreachable();
    } catch (error) {
      expect((error as LifecycleError).reasons.join(" ")).toContain("carries no receipt for it");
    }
  });

  it("signs when the tick matches, and the receipt is inside the digest that was signed", () => {
    const approved = approve(draft, { ...options, acknowledgedPromotions: ["MEMBER_NOT_FOUND"] });
    expect(approved.lifecycle.approval?.acknowledgedPromotions).toEqual(["MEMBER_NOT_FOUND"]);
    expect(approved.lifecycle.approval?.over).toBe(approved.digest);
    // Inside the digest, so an approver signs THIS PROGRAM WITH THIS PROOF. Editing the receipt
    // afterwards breaks the signature; `lifecycle` is the only mutable-state field the digest omits.
    const edited = {
      ...approved,
      promotions: [{ ...approved.promotions[0], probeConfirmed: true }],
    };
    expect(digestOf(edited)).not.toBe(digestOf(approved));
  });
});
