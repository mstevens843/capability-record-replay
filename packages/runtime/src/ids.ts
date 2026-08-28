// Identifier minting - the second thing `@crr/core` is not allowed to do.
//
// A run id, a lease token and an intervention id are all unguessable handles, and unguessability is
// randomness, which the purity contract test forbids in core. So they are minted here behind a port
// for the same reason the clock is: a journal whose run ids are stable across two runs of a test is
// a journal a test can compare byte for byte.
//
// The lease token is the one that has a security property rather than a tidiness property. It is
// what `Surface.act` checks, so a token a second process could guess is a control model that only
// works when nobody is attacking it: 128 bits from `crypto.getRandomValues`, never a counter.

import { randomBytes, randomUUID } from "node:crypto";
import {
  type ApprovalToken,
  ApprovalTokenSchema,
  type EvidenceRef,
  EvidenceRefSchema,
  type InterventionId,
  InterventionIdSchema,
  type LeaseToken,
  LeaseTokenSchema,
  type RunId,
  RunIdSchema,
} from "@crr/core";

export interface IdSource {
  runId(): RunId;
  leaseToken(): LeaseToken;
  interventionId(): InterventionId;
}

export function randomIds(): IdSource {
  return {
    runId: () => RunIdSchema.parse(`run-${randomUUID()}`),
    // 128 bits. A lease token is checked at the port on every action, so it is a capability and is
    // sized like one.
    leaseToken: () => LeaseTokenSchema.parse(`lease-${randomBytes(16).toString("base64url")}`),
    interventionId: () => InterventionIdSchema.parse(`itv-${randomUUID()}`),
  };
}

/**
 * Deterministic ids for a test.
 *
 * NOT for production and the name says so. A predictable lease token would let anything holding the
 * source code take a session away from the automation mid-run.
 */
export function sequentialIds(prefix = "test"): IdSource {
  const counts = { run: 0, lease: 0, intervention: 0 };
  const next = (of: keyof typeof counts): number => {
    counts[of] += 1;
    return counts[of];
  };
  return {
    runId: () => RunIdSchema.parse(`run-${prefix}-${next("run")}`),
    leaseToken: () => LeaseTokenSchema.parse(`lease-${prefix}-${next("lease")}`),
    interventionId: () => InterventionIdSchema.parse(`itv-${prefix}-${next("intervention")}`),
  };
}

/** An approval token as the policy engine takes it: opaque, whitespace-free, minted outside core. */
export function approvalTokenOf(value: string): ApprovalToken {
  return ApprovalTokenSchema.parse(value);
}

/** A content-addressed evidence key. `sha256:<hex>` prefixed by what kind of blob it is, so a
 *  journal line naming one says what it is without a lookup. */
export function evidenceRefOf(kind: string, digest: string): EvidenceRef {
  return EvidenceRefSchema.parse(`${kind}:${digest.replace(/^sha256:/, "")}`);
}
