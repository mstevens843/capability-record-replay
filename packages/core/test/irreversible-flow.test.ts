// The write path, which the schema treats differently in four places.
//
// Save-time invariant 11 is the one worth reading twice. An action that touched the wrong record and
// left no evidence on screen is undetectable by any pure function over that screen - that is the
// honest limit of this whole approach. The mitigation is that a confirmation screen usually PRINTS
// the identity of what it did, so if the checkpoint asserts continuity there, the undetectable case
// collapses into a detectable one. Which is exactly why the strongest control in the document is not
// allowed to be optional on the flows it exists to protect: if a vendor's confirmation genuinely
// does not name the record, the artifact cannot reach draft and a human has to decide - and that is
// the correct place for that decision, not a silent gap.

import { describe, expect, it } from "vitest";
import { artifactDigestOf, safeParseArtifact } from "../src/index.js";
import { memberLookupArtifact } from "./fixtures/member-lookup.js";

type JsonRecord = { [key: string]: unknown };

/** The read fixture, rewritten so that opening the member record is an irreversible write. */
function irreversibleVariant(edit: (doc: JsonRecord) => void = () => {}): JsonRecord {
  const doc = structuredClone(memberLookupArtifact) as unknown as JsonRecord;
  const steps = (doc.flow as JsonRecord).steps as JsonRecord[];
  const target = steps.find((s) => s.id === "open-member-row") as JsonRecord;
  target.effect = "WRITE_IRREVERSIBLE";

  doc.effects = {
    ...(doc.effects as JsonRecord),
    maxEffect: "WRITE_IRREVERSIBLE",
    irreversibleSteps: ["open-member-row"],
    requiresApproval: true,
    restartSafeUpToPc: 3,
  };
  doc.policy = {
    ...(doc.policy as JsonRecord),
    maxEffect: "WRITE_IRREVERSIBLE",
    requiresApprovalToken: true,
  };
  // The approver has to have ticked the effect they were approving.
  doc.lifecycle = {
    status: "draft",
    supersedes: null,
    approval: null,
  };

  edit(doc);
  const { digest: _stale, ...rest } = doc;
  void _stale;
  return { ...rest, digest: artifactDigestOf(rest) };
}

const step = (doc: JsonRecord, id: string): JsonRecord =>
  ((doc.flow as JsonRecord).steps as JsonRecord[]).find((s) => s.id === id) as JsonRecord;

describe("a flow with an irreversible step", () => {
  it("is accepted when its checkpoint proves which record it acted on", () => {
    const parsed = safeParseArtifact(irreversibleVariant());
    expect(parsed.success ? null : JSON.stringify(parsed.error.issues, null, 2)).toBeNull();
  });

  it("derives requiresApproval from the steps, not from a boolean somebody set", () => {
    const parsed = safeParseArtifact(irreversibleVariant());
    if (!parsed.success) throw new Error("expected the variant to parse");
    expect(parsed.data.effects.requiresApproval).toBe(true);
    expect(parsed.data.policy.requiresApprovalToken).toBe(true);
    // Everything up to the write is restartable; the write itself is not.
    expect(parsed.data.effects.restartSafeUpToPc).toBe(3);
  });

  it("refuses a write flow that declares no continuity value at all", () => {
    const noContinuity = irreversibleVariant((d) => {
      d.continuity = [];
      for (const s of (d.flow as JsonRecord).steps as JsonRecord[]) {
        (s.expect as JsonRecord).continuity = [];
      }
    });
    expect(safeParseArtifact(noContinuity).success).toBe(false);
  });

  it("refuses a write whose own checkpoint does not assert the subject", () => {
    const unasserted = irreversibleVariant((d) => {
      (step(d, "open-member-row").expect as JsonRecord).continuity = [];
    });
    const parsed = safeParseArtifact(unasserted);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(JSON.stringify(parsed.error.issues)).toContain("must assert a continuity value");
  });

  it("refuses a remedy that presses more buttons after an irreversible dispatch", () => {
    // Once the write is in flight, a remedy that acts again is how a member gets two sub-accounts.
    // The only safe move is to stop and ask a person.
    const withActionRemedy = irreversibleVariant((d) => {
      const s = step(d, "open-member-row");
      s.recoveries = [
        {
          name: "RETRY_SUBMIT",
          band: "recoverable",
          detect: { kind: "settled" },
          priority: 10,
          phase: "post",
          remedy: {
            kind: "actions",
            instructions: [{ kind: "navigate", route: "member-search" }],
          },
          maxAttempts: 1,
          allowUnsettled: false,
          afterRemedy: "reverify",
          resume: "retry-step",
        },
      ];
      (s.budgets as JsonRecord).perRecoveryMaxAttempts = { RETRY_SUBMIT: 1 };
    });
    const parsed = safeParseArtifact(withActionRemedy);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const issues = JSON.stringify(parsed.error.issues);
    expect(issues).toContain("may not remedy by performing actions");
    expect(issues).toContain("must resume by escalating");
  });

  it("refuses a restart that would cross the irreversible step", () => {
    const crossing = irreversibleVariant((d) => {
      const s = step(d, "read-savings-balance");
      s.recoveries = [
        {
          name: "START_OVER",
          band: "recoverable",
          detect: { kind: "settled" },
          priority: 10,
          phase: "post",
          remedy: { kind: "escalate", reason: "lost the record", brief: "start again by hand" },
          maxAttempts: 1,
          allowUnsettled: false,
          afterRemedy: "reverify",
          resume: "restart-from-checkpoint",
          resumeAt: "open-search",
        },
      ];
      (s.budgets as JsonRecord).perRecoveryMaxAttempts = { START_OVER: 1 };
    });
    const parsed = safeParseArtifact(crossing);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(JSON.stringify(parsed.error.issues)).toContain("restart across irreversible step");
  });
});
