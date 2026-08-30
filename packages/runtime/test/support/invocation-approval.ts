import {
  APPROVAL_POLICY_VERSION,
  SCHEMA_VERSION_APPROVAL,
  type Approval,
  type ApprovalTrustStore,
  type CapabilityArtifact,
  type CapabilityContract,
  type Digest,
  type EffectClass,
  type Timestamp,
  approvalArgsHash,
} from "@crr/core";
import {
  ed25519TrustStore,
  generateApprovalKeyPair,
  invocationApprovalGrant,
  localApprovalKeySigner,
  signApprovalDocument,
  type InvocationApprovalGrant,
  type TrustedSigner,
  type UnsignedApproval,
} from "../../src/approval.js";

export const INVOCATION_APPROVAL_AUTHORITY = "open-subaccount-approver";
export const INVOCATION_APPROVAL_SIGNER = "ops-approver-4";
export const INVOCATION_APPROVAL_KEY = "ops-invocation-key-1";
export const APPROVAL_NOW = "2026-02-11T14:00:00.000Z" as Timestamp;

export interface InvocationApprovalFixture {
  readonly grant: InvocationApprovalGrant;
  readonly approval: Approval;
  readonly trust: ApprovalTrustStore;
}

export interface InvocationApprovalOptions {
  readonly approvalId?: string;
  readonly artifact: CapabilityArtifact;
  readonly contract: CapabilityContract;
  readonly args: Readonly<Record<string, unknown>>;
  readonly tenant?: { readonly tenantId: string; readonly appInstanceId: string };
  readonly artifactDigest?: Digest;
  readonly contractDigest?: Digest;
  readonly ceiling?: EffectClass;
  readonly subject?: "artifact" | "invocation";
  readonly policyVersion?: string;
  readonly issuedAt?: Timestamp;
  readonly expiresAt?: Timestamp;
  readonly argsHash?: Digest;
  readonly idempotencyKey?: string | null;
  readonly signerId?: string;
  readonly keyId?: string;
  readonly authority?: readonly [string, ...string[]];
  readonly requiredAuthority?: readonly [string, ...string[]];
  readonly trustSignerId?: string;
  readonly trustAuthority?: readonly string[];
  readonly trustStatus?: "active" | "revoked";
  readonly revokedReason?: string | null;
  readonly trustNotBefore?: Timestamp;
  readonly trustNotAfter?: Timestamp;
  readonly trustRevocations?: ApprovalTrustStore["revocations"];
  readonly untrustedSigner?: boolean;
}

export function invocationApprovalFixture(
  options: InvocationApprovalOptions,
): InvocationApprovalFixture {
  const tenant = options.tenant ?? { tenantId: "riverbend", appInstanceId: "riverbend-mock" };
  const approvalId = options.approvalId ?? "approval-runtime-valid-1";
  const keyId = options.keyId ?? INVOCATION_APPROVAL_KEY;
  const signerId = options.signerId ?? INVOCATION_APPROVAL_SIGNER;
  const authority = options.authority ?? [INVOCATION_APPROVAL_AUTHORITY];
  const requiredAuthority = options.requiredAuthority ?? [INVOCATION_APPROVAL_AUTHORITY];
  const pair = generateApprovalKeyPair(keyId);
  const signer = localApprovalKeySigner({ signer: pair.signer, signerId, authority });
  const trustedSigners: readonly TrustedSigner[] =
    options.untrustedSigner === true
      ? []
      : [
          {
            ...pair.trustedKey,
            signerId: options.trustSignerId ?? signerId,
            authority: options.trustAuthority ?? authority,
            notBefore: options.trustNotBefore ?? "2026-02-11T13:00:00.000Z",
            notAfter: options.trustNotAfter ?? "2026-02-12T14:00:00.000Z",
            status: options.trustStatus ?? "active",
            revokedReason: options.revokedReason ?? null,
            supersedes: null,
          },
        ];
  const trust = ed25519TrustStore(trustedSigners, options.trustRevocations ?? []);
  const ceiling = options.ceiling ?? "WRITE_IRREVERSIBLE";
  const request =
    ceiling === "WRITE_IRREVERSIBLE"
      ? {
          argsHash: options.argsHash ?? approvalArgsHash(approvalId, options.args),
          idempotencyKey: options.idempotencyKey ?? null,
        }
      : null;

  const unsigned = {
    schemaVersion: SCHEMA_VERSION_APPROVAL,
    approvalId,
    subject: options.subject ?? "invocation",
    capability: {
      name: options.contract.name,
      version: options.contract.version,
    },
    approves: {
      artifactDigest: options.artifactDigest ?? options.artifact.digest,
      contractDigest: options.contractDigest ?? options.contract.digest,
    },
    scope: {
      tenants: [tenant.tenantId],
      appInstances: [tenant.appInstanceId],
    },
    policyVersion: options.policyVersion ?? APPROVAL_POLICY_VERSION,
    ceiling,
    issuedAt: options.issuedAt ?? "2026-02-11T13:55:00.000Z",
    expiresAt: options.expiresAt ?? "2026-02-11T15:00:00.000Z",
    request,
    signer: {
      signerId,
      authority,
      keyId,
      alg: "ed25519",
    },
  } as unknown as UnsignedApproval;
  const approval = signApprovalDocument(unsigned, signer);
  const grant = invocationApprovalGrant({
    approval,
    trust,
    requiredAuthority,
  });
  return { grant, approval, trust };
}
