import { describe, expect, it } from "vitest";
import {
  APPROVAL_POLICY_VERSION,
  SCHEMA_VERSION_APPROVAL,
  type Approval,
  type ApprovalDemand,
  type ApprovalRefusalReason,
  type ApprovalTrustStore,
  type EffectClass,
  type Timestamp,
  approvalArgsHash,
  authorizeIrreversibleWrite,
  digestOf,
  irreversibleApprovalOf,
  parseApproval,
  verifyApproval,
} from "../src/index.js";

const ARTIFACT_DIGEST = digestOf("artifact");
const CONTRACT_DIGEST = digestOf("contract");
const ARGS = { memberId: "50001", product: "share", openingDeposit: "25.00" };
const APPROVAL_ID = "approval-core-valid-1";
const AUTHORITY = "open-subaccount-approver";
const NOW = "2026-02-11T14:00:00.000Z" as Timestamp;

function approval(overrides: Record<string, unknown> = {}): Approval {
  return parseApproval({
    schemaVersion: SCHEMA_VERSION_APPROVAL,
    approvalId: APPROVAL_ID,
    subject: "invocation",
    capability: { name: "corebank.member.open_sub_account", version: "1.0.0" },
    approves: { artifactDigest: ARTIFACT_DIGEST, contractDigest: CONTRACT_DIGEST },
    scope: { tenants: ["riverbend"], appInstances: ["riverbend-corebank"] },
    policyVersion: APPROVAL_POLICY_VERSION,
    ceiling: "WRITE_IRREVERSIBLE",
    issuedAt: "2026-02-11T13:55:00.000Z",
    expiresAt: "2026-02-11T15:00:00.000Z",
    request: {
      argsHash: approvalArgsHash(APPROVAL_ID, ARGS),
      idempotencyKey: "open-subaccount-req-1",
    },
    signer: {
      signerId: "ops-approver-4",
      authority: [AUTHORITY],
      keyId: "key-1",
      alg: "fixture",
    },
    signature: "sig",
    ...overrides,
  });
}

function demand(overrides: Partial<ApprovalDemand> = {}): ApprovalDemand {
  return {
    subject: "invocation",
    capability: { name: "corebank.member.open_sub_account", version: "1.0.0" },
    artifactDigest: ARTIFACT_DIGEST,
    contractDigest: CONTRACT_DIGEST,
    effect: "WRITE_IRREVERSIBLE",
    artifactMaxEffect: "WRITE_IRREVERSIBLE",
    tenantId: "riverbend",
    appInstanceId: "riverbend-corebank",
    policyVersion: APPROVAL_POLICY_VERSION,
    requiredAuthority: [AUTHORITY],
    argsHash: approvalArgsHash(APPROVAL_ID, ARGS),
    idempotencyKey: "open-subaccount-req-1",
    ...overrides,
  };
}

function trust(overrides: Partial<ApprovalTrustStore> = {}): ApprovalTrustStore {
  return {
    trustedKeyIds: ["key-1"],
    verifySignature: ({ signature }) => signature === "sig",
    signers: [
      {
        keyId: "key-1",
        signerId: "ops-approver-4",
        authority: [AUTHORITY],
        alg: "fixture",
        notBefore: "2026-02-11T13:00:00.000Z" as Timestamp,
        notAfter: "2026-02-12T14:00:00.000Z" as Timestamp,
        status: "active",
        revokedReason: null,
        supersedes: null,
      },
    ],
    revocations: [],
    ...overrides,
  };
}

function reasonOf(
  subject: Approval,
  gateDemand: ApprovalDemand = demand(),
  gateTrust: ApprovalTrustStore = trust(),
): ApprovalRefusalReason | "accepted" {
  const verdict = verifyApproval({
    approval: subject,
    demand: gateDemand,
    trust: gateTrust,
    now: NOW,
  });
  return verdict.ok ? "accepted" : verdict.reason;
}

describe("approval document shape", () => {
  it("does not allow an artifact approval to carry an irreversible ceiling", () => {
    expect(() => approval({ subject: "artifact" })).toThrow();
  });

  it("does not allow an irreversible approval without request binding", () => {
    expect(() => approval({ request: null })).toThrow();
  });

  it("does not allow an artifact approval to bind one request", () => {
    expect(() =>
      approval({
        ceiling: "READ",
        subject: "artifact",
        request: { argsHash: digestOf("args"), idempotencyKey: "x" },
      }),
    ).toThrow(/expected null/);
  });
});

describe("approval verification", () => {
  it("accepts a signed invocation approval bound to this request", () => {
    const narrowed = irreversibleApprovalOf(approval());
    expect(narrowed.ok).toBe(true);
    if (!narrowed.ok) throw new Error("unreachable");

    const verdict = authorizeIrreversibleWrite({
      approval: narrowed.approval,
      demand: demand() as ApprovalDemand & {
        readonly requiredAuthority: readonly [string, ...string[]];
      },
      trust: trust(),
      now: NOW,
    });
    expect(verdict).toMatchObject({
      ok: true,
      approvalId: APPROVAL_ID,
      subject: "invocation",
      ceiling: "WRITE_IRREVERSIBLE",
      signerId: "ops-approver-4",
      keyId: "key-1",
    });
  });

  it("refuses READ and WRITE_REVERSIBLE approvals before the irreversible write gate", () => {
    for (const ceiling of ["READ", "WRITE_REVERSIBLE"] as const) {
      const narrowed = irreversibleApprovalOf(
        approval({ ceiling, request: null, subject: "invocation" }),
      );
      expect(narrowed.ok).toBe(false);
      if (!narrowed.ok) expect(narrowed.verdict.reason).toBe("effect-class-escalation");
    }
  });

  it.each([
    [
      "signer-unknown",
      approval(),
      demand(),
      trust({ signers: [], trustedKeyIds: [] }),
    ],
    [
      "signer-key-revoked",
      approval(),
      demand(),
      trust({
        signers: [
          {
            ...trust().signers[0]!,
            status: "revoked",
            revokedReason: "lost custody",
          },
        ],
      }),
    ],
    [
      "approval-revoked",
      approval(),
      demand(),
      trust({
        revocations: [
          {
            approvalId: APPROVAL_ID,
            reason: "duplicate request",
            revokedAt: "2026-02-11T14:05:00.000Z" as Timestamp,
            revokedBy: "ops-risk",
          },
        ],
      }),
    ],
    [
      "signer-authority-insufficient",
      approval(),
      demand({ requiredAuthority: ["second-approver"] }),
      trust(),
    ],
    [
      "subject-mismatch",
      approval({ ceiling: "READ", subject: "artifact", request: null }),
      demand({
        effect: "READ",
        artifactMaxEffect: "READ",
        argsHash: null,
        idempotencyKey: null,
      }),
      trust(),
    ],
    [
      "artifact-digest-mismatch",
      approval({ approves: { artifactDigest: digestOf("other-artifact"), contractDigest: CONTRACT_DIGEST } }),
      demand(),
      trust(),
    ],
    [
      "contract-digest-mismatch",
      approval({ approves: { artifactDigest: ARTIFACT_DIGEST, contractDigest: digestOf("other-contract") } }),
      demand(),
      trust(),
    ],
    [
      "policy-version-mismatch",
      approval({ policyVersion: "crr-approval-policy/old" }),
      demand(),
      trust(),
    ],
    ["tenant-not-in-scope", approval({ scope: { tenants: ["summit"], appInstances: ["riverbend-corebank"] } }), demand(), trust()],
    [
      "app-instance-not-in-scope",
      approval({ scope: { tenants: ["riverbend"], appInstances: ["riverbend-cards"] } }),
      demand(),
      trust(),
    ],
    [
      "approval-expired",
      approval({ expiresAt: "2026-02-11T13:59:59.000Z" }),
      demand(),
      trust(),
    ],
    [
      "effect-ceiling-exceeded",
      approval({ ceiling: "WRITE_REVERSIBLE", request: null }),
      demand({
        effect: "READ",
        artifactMaxEffect: "WRITE_IRREVERSIBLE",
        argsHash: null,
        idempotencyKey: null,
      }),
      trust(),
    ],
    [
      "args-hash-mismatch",
      approval({
        request: { argsHash: digestOf("different-args"), idempotencyKey: "open-subaccount-req-1" },
      }),
      demand(),
      trust(),
    ],
    [
      "idempotency-key-mismatch",
      approval({
        request: { argsHash: approvalArgsHash(APPROVAL_ID, ARGS), idempotencyKey: null },
      }),
      demand(),
      trust(),
    ],
    [
      "idempotency-key-mismatch",
      approval({
        request: { argsHash: approvalArgsHash(APPROVAL_ID, ARGS), idempotencyKey: "other-key" },
      }),
      demand(),
      trust(),
    ],
  ] as const)("returns %s for the first failing approval condition", (expected, doc, ask, store) => {
    expect(reasonOf(doc, ask, store)).toBe(expected);
  });
});
