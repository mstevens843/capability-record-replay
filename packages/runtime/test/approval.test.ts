// Approval: signing over the digest, and the four ways an edited approved artifact gives itself up.
//
// SPEC section 11's second acceptance sentence for build unit 15 is "an edited approved artifact
// fails the digest check", and the interesting thing about that sentence is that there is more than
// one way to try it. An attacker - or, far more likely, a well-meaning engineer with a text editor
// at 2am - can edit the program and leave the digest alone, or edit it and recompute the digest, or
// edit it and recompute the digest and rewrite the approval's `over` field to match. All three are
// exercised below, and all three stop, at three different controls:
//
//   1. leave `digest` alone         -> linker check 2: the document does not hash to its digest
//   2. recompute `digest`           -> the SCHEMA refuses it: `lifecycle.approval.over` no longer
//                                      names this document, so it does not even parse
//   3. recompute both               -> linker check 27: the signature does not verify over the new
//                                      digest, because the approver signed the old one
//
// That layering is why the digest excludes `lifecycle` and why the signature is over the digest
// STRING rather than the file bytes. It is also why `checkArtifactIntegrity` reports all of them in
// one pass: a human holding a file needs one answer, not three checks they have to remember to run.
//
// `mock-flow.ts` says the crypto is put under test here rather than there. This is that file.

import {
  type Allowlist,
  type CapabilityArtifact,
  type CapabilityContract,
  MOCK_LEASE_TOKEN,
  MOCK_SURFACE_CAPABILITIES,
  MockSurface,
  type MockTransition,
  type Observation,
  artifactDigestOf,
  link,
  safeParseArtifact,
  sealArtifact,
} from "@crr/core";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ApprovalSigner,
  type TrustedKey,
  ed25519Trust,
  generateApprovalKeyPair,
  unverifiedTrust,
} from "../src/approval.js";
import { manualClock } from "../src/clock.js";
import { MemoryEvidenceSink } from "../src/evidence.js";
import { sequentialIds } from "../src/ids.js";
import { MemoryJournal } from "../src/journal.js";
import {
  LifecycleError,
  approve,
  checkArtifactIntegrity,
  recordVerification,
} from "../src/lifecycle.js";
import { StaticSessionBroker } from "../src/session.js";
import { verifyAndDraft } from "../src/verify.js";
import {
  IDS,
  MOCK_MEMBER_ID,
  mockAllowlist,
  mockArtifact,
  mockContract,
  screens,
} from "./fixtures/mock-flow.js";
import {
  proposedWriteArtifact,
  writeAllowlist,
  writeContract,
  writeScreens,
  writeTransitions,
} from "./fixtures/write-flow.js";

const KEY_ID = "ops-approval-key-1";
const APPROVED_AT = "2026-02-11T15:20:04.000Z";
const TENANT = { tenantId: "riverbend", appInstanceId: "riverbend-mock" };

let signer: ApprovalSigner;
let trustedKey: TrustedKey;
/** A read capability, verified `full`, sitting in `draft` and waiting for a human. */
let readDraft: CapabilityArtifact;
/** A write capability, verified `partial-up-to-irreversible`. */
let writeDraft: CapabilityArtifact;

beforeAll(async () => {
  const pair = generateApprovalKeyPair(KEY_ID);
  signer = pair.signer;
  trustedKey = pair.trustedKey;

  readDraft = await draftOf({
    artifact: proposedFrom(mockArtifact()),
    contract: mockContract,
    allowlist: mockAllowlist,
    screens,
    transitions: [
      { from: "blank", on: { kind: "navigate", path: "/search" }, to: "search" },
      { from: "search", on: { kind: "type", target: IDS.memberIdField }, to: "search-typed" },
      { from: "search-typed", on: { kind: "click", target: IDS.searchButton }, to: "results" },
    ],
    args: { memberId: MOCK_MEMBER_ID },
  });

  writeDraft = await draftOf({
    artifact: proposedWriteArtifact(),
    contract: writeContract,
    allowlist: writeAllowlist(),
    screens: writeScreens,
    transitions: writeTransitions as unknown as readonly MockTransition[],
    args: { memberId: MOCK_MEMBER_ID },
  });
});

/** The read fixture rewound to the state synthesis emits, so the lifecycle starts at its start. */
function proposedFrom(approved: CapabilityArtifact): CapabilityArtifact {
  return sealArtifact({
    ...approved,
    lifecycle: { status: "proposed", supersedes: null, approval: null },
    verification: { ...approved.verification, status: "unverified" },
  });
}

async function draftOf(args: {
  readonly artifact: CapabilityArtifact;
  readonly contract: CapabilityContract;
  readonly allowlist: Allowlist;
  readonly screens: Readonly<Record<string, Observation>>;
  readonly transitions: readonly MockTransition[];
  readonly args: Readonly<Record<string, unknown>>;
}): Promise<CapabilityArtifact> {
  const clock = manualClock();
  const surface = new MockSurface({
    screens: args.screens,
    start: "blank",
    transitions: args.transitions,
    lease: MOCK_LEASE_TOKEN,
  });
  const { report, artifact } = await verifyAndDraft({
    contract: args.contract,
    artifact: args.artifact,
    args: args.args,
    tenant: TENANT,
    allowlist: args.allowlist,
    broker: new StaticSessionBroker(surface),
    clock,
    ids: sequentialIds("approve"),
    evidence: new MemoryEvidenceSink(),
    journal: (runId) => new MemoryJournal({ runId, clock }),
  });
  if (artifact === null) throw new Error(`the fixture must verify: ${report.reason}`);
  return artifact;
}

const linkAsReplay = (artifact: CapabilityArtifact, keys: readonly TrustedKey[]) =>
  link({
    contract: mockContract,
    artifact,
    overlay: null,
    capabilities: MOCK_SURFACE_CAPABILITIES,
    args: { memberId: MOCK_MEMBER_ID },
    mode: "replay",
    allowlist: mockAllowlist,
    trust: ed25519Trust(keys),
  });

// ---------------------------------------------------------------------------------------------

describe("signing the digest", () => {
  it("turns a verified draft into an artifact replay will run", () => {
    const approved = approve(readDraft, {
      signer,
      approvedBy: "ops-approver-4",
      approvedAt: APPROVED_AT,
      acknowledgedGrade: "full",
      acknowledgedEffects: ["READ"],
    });

    expect(approved.lifecycle.status).toBe("approved");
    expect(approved.lifecycle.approval?.over).toBe(approved.digest);
    expect(approved.lifecycle.approval?.keyId).toBe(KEY_ID);
    // The digest is unchanged by the approval, because `lifecycle` is excluded from it - which is
    // the only reason a signature over the digest can live inside the document it signs.
    expect(approved.digest).toBe(readDraft.digest);

    const linked = linkAsReplay(approved, [trustedKey]);
    expect(linked.ok ? [] : linked.errors.map((e) => `${e.check} ${e.code}`)).toEqual([]);
  });

  it("refuses the signature when the deployment does not trust the key", () => {
    const approved = approve(readDraft, {
      signer,
      approvedBy: "ops-approver-4",
      approvedAt: APPROVED_AT,
      acknowledgedGrade: "full",
      acknowledgedEffects: ["READ"],
    });
    const stranger = generateApprovalKeyPair("some-other-key").trustedKey;

    const linked = linkAsReplay(approved, [stranger]);
    expect(linked.ok).toBe(false);
    if (linked.ok) throw new Error("unreachable");
    expect(linked.errors.map((e) => e.code)).toContain("signing-key-untrusted");
  });

  it("refuses a signature made by a different key over the same digest", () => {
    const impostor = generateApprovalKeyPair(KEY_ID);
    const approved = approve(readDraft, {
      signer: impostor.signer,
      approvedBy: "ops-approver-4",
      approvedAt: APPROVED_AT,
      acknowledgedGrade: "full",
      acknowledgedEffects: ["READ"],
    });

    // The key ID collides deliberately: the deployment trusts THE KEY, not the label on it.
    const linked = linkAsReplay(approved, [trustedKey]);
    expect(linked.ok).toBe(false);
    if (linked.ok) throw new Error("unreachable");
    expect(linked.errors.map((e) => e.code)).toContain("signature-invalid");
  });

  it("fails closed on a malformed signature and an unknown algorithm rather than throwing", () => {
    const trust = ed25519Trust([trustedKey]);
    expect(
      trust.verifySignature({
        over: readDraft.digest,
        keyId: KEY_ID,
        alg: "rsa-pss",
        signature: signer.sign(readDraft.digest),
      }),
    ).toBe(false);
    expect(
      trust.verifySignature({
        over: readDraft.digest,
        keyId: KEY_ID,
        alg: "ed25519",
        signature: "not base64url at all !!!",
      }),
    ).toBe(false);
  });

  it("says in its own name that the unverified trust store verifies nothing", () => {
    const trust = unverifiedTrust([KEY_ID]);
    expect(
      trust.verifySignature({
        over: "sha256:0000",
        keyId: KEY_ID,
        alg: "ed25519",
        signature: "nonsense",
      }),
    ).toBe(true);
  });
});

describe("the approver has to have read the grade", () => {
  it("refuses an approval that ticks a grade the artifact was not verified to", () => {
    expect(() =>
      approve(writeDraft, {
        signer,
        approvedBy: "ops-approver-4",
        approvedAt: APPROVED_AT,
        // The write flow was verified `partial-up-to-irreversible`. Ticking `full` is the exact
        // mistake SPEC section 12.3's twelfth accepted limit is about, and it is refused rather
        // than logged.
        acknowledgedGrade: "full",
        acknowledgedEffects: ["WRITE_IRREVERSIBLE"],
      }),
    ).toThrow(/ticked grade "full" and this artifact was verified to "partial-up-to-irreversible"/);
  });

  it("accepts the approval that ticks the grade the run actually established", () => {
    const approved = approve(writeDraft, {
      signer,
      approvedBy: "ops-approver-4",
      approvedAt: APPROVED_AT,
      acknowledgedGrade: "partial-up-to-irreversible",
      acknowledgedEffects: ["READ", "WRITE_IRREVERSIBLE"],
    });
    expect(approved.lifecycle.status).toBe("approved");
    expect(approved.lifecycle.approval?.acknowledgedGrade).toBe("partial-up-to-irreversible");
  });

  it("refuses an approval that does not tick the artifact's own maximum effect", () => {
    expect(() =>
      approve(writeDraft, {
        signer,
        approvedBy: "ops-approver-4",
        approvedAt: APPROVED_AT,
        acknowledgedGrade: "partial-up-to-irreversible",
        acknowledgedEffects: ["READ"],
      }),
    ).toThrow(/did not tick this artifact's maximum effect \(WRITE_IRREVERSIBLE\)/);
  });

  it("refuses to approve something that has never replayed itself", () => {
    const proposed = proposedWriteArtifact();
    let thrown: unknown;
    try {
      approve(proposed, {
        signer,
        approvedBy: "ops-approver-4",
        approvedAt: APPROVED_AT,
        acknowledgedGrade: "partial-up-to-irreversible",
        acknowledgedEffects: ["WRITE_IRREVERSIBLE"],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LifecycleError);
    expect((thrown as LifecycleError).reasons.join(" ")).toMatch(
      /never replayed itself with the model out of the loop/,
    );
  });
});

describe("an edited approved artifact", () => {
  const approvedRead = (): CapabilityArtifact =>
    approve(readDraft, {
      signer,
      approvedBy: "ops-approver-4",
      approvedAt: APPROVED_AT,
      acknowledgedGrade: "full",
      acknowledgedEffects: ["READ"],
    });

  /**
   * One edit, applied three ways.
   *
   * Deliberately BENIGN as far as the schema is concerned - a step title, which every other
   * validator in the system is happy about - so that what catches it is the integrity machinery and
   * not a lucky consistency check somewhere else. A tamper that also broke the effect summary would
   * make this suite pass for the wrong reason.
   */
  function tampered(): Record<string, unknown> {
    const doc = structuredClone(approvedRead()) as unknown as Record<string, unknown>;
    const steps = (doc.flow as { steps: { title: string }[] }).steps;
    (steps[0] as { title: string }).title = "Open the search screen (edited after approval)";
    return doc;
  }

  it("is caught by the digest when the digest is left alone", () => {
    const doc = tampered();

    // It is still a valid document. Nothing about its SHAPE is wrong, which is exactly why the
    // content address rather than the schema has to be the thing that notices.
    const parsed = safeParseArtifact(doc);
    expect(parsed.success ? null : JSON.stringify(parsed.error.issues)).toBeNull();
    if (!parsed.success) throw new Error("unreachable");

    const linked = linkAsReplay(parsed.data, [trustedKey]);
    expect(linked.ok).toBe(false);
    if (linked.ok) throw new Error("unreachable");
    expect(linked.errors.map((e) => `${e.check} ${e.code}`)).toContain("2 digest-mismatch");

    const report = checkArtifactIntegrity(doc, ed25519Trust([trustedKey]));
    expect(report.ok).toBe(false);
    expect(report.claimedDigest).not.toBe(report.computedDigest);
    expect(report.problems.join(" ")).toMatch(/edited since it was sealed/);
  });

  it("is caught by the schema when the digest is recomputed to match", () => {
    const doc = tampered();
    const resealed = { ...doc, digest: artifactDigestOf(doc) };

    const parsed = safeParseArtifact(resealed);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.success ? [] : parsed.error.issues)).toContain(
      "the approval signs a digest other than this document's own",
    );

    const report = checkArtifactIntegrity(resealed, ed25519Trust([trustedKey]));
    expect(report.ok).toBe(false);
  });

  it("is caught by the signature when the digest AND the approval are both rewritten", () => {
    const doc = tampered();
    const digest = artifactDigestOf(doc);
    const lifecycle = doc.lifecycle as { approval: Record<string, unknown> };
    const forged = {
      ...doc,
      digest,
      lifecycle: { ...lifecycle, approval: { ...lifecycle.approval, over: digest } },
    };

    // Now it parses, and its digest is intact. Only the signature knows, because the approver
    // signed the digest of the document they were shown and this is a different document.
    const parsed = safeParseArtifact(forged);
    expect(parsed.success ? null : JSON.stringify(parsed.error.issues)).toBeNull();
    if (!parsed.success) throw new Error("unreachable");
    expect(artifactDigestOf(parsed.data)).toBe(parsed.data.digest);

    const linked = linkAsReplay(parsed.data, [trustedKey]);
    expect(linked.ok).toBe(false);
    if (linked.ok) throw new Error("unreachable");
    expect(linked.errors.map((e) => `${e.check} ${e.code}`)).toContain("27 signature-invalid");

    const report = checkArtifactIntegrity(forged, ed25519Trust([trustedKey]));
    expect(report.ok).toBe(false);
    expect(report.problems).toContain(
      "the approval signature does not verify over this artifact's digest",
    );
  });

  it("passes every one of those checks when it has not been edited", () => {
    const approved = approvedRead();
    const report = checkArtifactIntegrity(approved, ed25519Trust([trustedKey]));
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.claimedDigest).toBe(report.computedDigest);
  });

  it("reports an unverifiable approval as unverified rather than assuming it is good", () => {
    const report = checkArtifactIntegrity(approvedRead(), null);
    expect(report.ok).toBe(false);
    expect(report.problems.join(" ")).toMatch(/could not be verified/);
  });
});

describe("the lifecycle refuses the transitions that would launder a claim", () => {
  it("will not re-verify an approved artifact, because that would revoke the approval", () => {
    const approved = approve(readDraft, {
      signer,
      approvedBy: "ops-approver-4",
      approvedAt: APPROVED_AT,
      acknowledgedGrade: "full",
      acknowledgedEffects: ["READ"],
    });
    expect(() => recordVerification(approved, approved.verification)).toThrow(
      /same thing as revoking the approval/,
    );
  });

  it("will not stamp a verification that did not succeed", () => {
    expect(() =>
      recordVerification(proposedWriteArtifact(), {
        ...writeDraft.verification,
        status: "unverified",
      }),
    ).toThrow(/does not produce a draft/);
  });

  it("will not approve a document whose bytes no longer hash to its digest", () => {
    const doc = structuredClone(readDraft) as unknown as Record<string, unknown>;
    (doc.flow as { steps: { title: string }[] }).steps[0]!.title = "Open the search screen ";
    const stale = doc as unknown as CapabilityArtifact;
    expect(() =>
      approve(stale, {
        signer,
        approvedBy: "ops-approver-4",
        approvedAt: APPROVED_AT,
        acknowledgedGrade: "full",
        acknowledgedEffects: ["READ"],
      }),
    ).toThrow(/does not hash to the digest it carries/);
  });
});
