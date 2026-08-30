// The approval model: what "approved" means, and the two different questions it answers.
//
// docs/design/APPROVAL-MODEL.md is the write-up. This is the enforcement.
//
// THE CENTRAL DISTINCTION, because everything below is derived from it:
//
//   · ARTIFACT APPROVAL  - "this procedure is reviewed and allowed to exist."  A statement about a
//     program. It is made once, by a reviewer who read the step list, and it is what the artifact's
//     own `lifecycle.approval` has always meant.
//   · INVOCATION APPROVAL - "this specific irreversible execution is authorised now."  A statement
//     about a REQUEST: these arguments, this tenant, this app instance, inside this window. It is
//     made per execution and it is the only one that can gate a write.
//
// Conflating them is the failure this module exists to make impossible. A signed artifact says a
// human read the program; it says nothing whatever about whether the member whose account is about
// to be opened agreed to it, whether the operator presenting it is entitled today, or whether this
// is the second copy of a request that already ran. THE SCHEMA REFUSES THE CONFLATION RATHER THAN
// DOCUMENTING IT: `ceiling: "WRITE_IRREVERSIBLE"` is the only arm of the union whose `subject` is
// `z.literal("invocation")` and whose `request` binding is required, so an artifact approval that
// authorises an irreversible write is not a thing that can be written down.
//
// WHY IT LIVES IN THE PURE PACKAGE. Verification has to happen where it can be enforced - at the
// chokepoint, at the moment of the write - and the chokepoint is reached from a package that
// cannot import a clock or a socket. So everything here is a pure total function over data the
// caller supplies: the moment (`now`), the trust store (a roster and a revocation list, as VALUES),
// and one injected `verifySignature`, which is the same seam `ApprovalTrust` has always been. A
// deployment that signs with a KMS supplies a different `verifySignature` and changes nothing else.
//
// WHAT IS SIGNED is the approval's own content digest - the canonical JSON of every field except
// `signature` - and `verifyApproval` RECOMPUTES it rather than reading the stored `over`. That is
// one notch stricter than the artifact path, where `over` is compared against a digest the document
// carries; here there is nothing to compare against but the bytes themselves.

import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { digestOf } from "./digest.js";
import { effectExceeds } from "./policy-engine.js";
import {
  AppInstanceIdSchema,
  CapabilityNameSchema,
  ContractVersionSchema,
  type DeepReadonly,
  type Digest,
  DigestSchema,
  type EffectClass,
  TenantIdSchema,
  type Timestamp,
  TimestampSchema,
} from "./primitives.js";
import type { SchemaIdentity } from "./schema-identity.js";

export const SCHEMA_VERSION_APPROVAL = "capability.approval/v1";

/**
 * The version of the rules an approval was issued under.
 *
 * On the document AND on the demand, compared for equality rather than ordered. An approval issued
 * under one set of allowlists, effect derivations and refusal reasons is not evidence about a
 * deployment running a different set, and a `>=` comparison would quietly say it was. Bumping this
 * invalidates every approval in flight, which is the intended cost of changing what approval means.
 */
export const APPROVAL_POLICY_VERSION = "crr-approval-policy/1";

// ---------------------------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------------------------

export const ApprovalSubjectSchema = z.enum(["artifact", "invocation"]);
export type ApprovalSubject = z.infer<typeof ApprovalSubjectSchema>;

/**
 * Who signed, as the document CLAIMS it.
 *
 * The trust store is authoritative for all three of these and the claim is checked against it
 * (`signer-identity-mismatch`). The claim is carried anyway, for one reason: a postmortem reading
 * an approval out of an evidence bundle years later has no roster, and an approval that only says
 * `keyId: "hsm-3"` is an approval nobody can attribute to a person.
 *
 * `authority` is the ROLE the signer was acting under - `credit-union-operations-approver`,
 * `break-glass` - not a permission list. A demand names the authority it requires; the roster
 * decides whether this signer holds it. That is the field that separates "somebody with a key" from
 * "somebody entitled to authorise this class of write", and it is the reason the trust store holds
 * more than a set of public keys.
 */
export const ApprovalSignerRefSchema = z.strictObject({
  signerId: z.string().min(1).max(128),
  authority: z.array(z.string().min(1).max(64)).min(1).max(16).readonly(),
  keyId: z.string().min(1).max(128),
  alg: z.string().min(1).max(32),
});
export type ApprovalSignerRef = DeepReadonly<z.infer<typeof ApprovalSignerRefSchema>>;

/**
 * Where the approval is valid. NO WILDCARDS, and the omission is the control.
 *
 * A `"*"` tenant is how one break-glass approval issued against a fixture ends up authorising a
 * write at three hundred credit unions. Both lists are `min(1)`, so the narrowest possible approval
 * names one tenant and one app instance, and the broadest one a person can write is still a list
 * somebody typed out.
 *
 * `appInstances` is separate from `tenants` because a tenant runs ~20 apps and an approval to open
 * a sub-account in the core is not an approval to touch the card platform - which is exactly the
 * heterogeneity BRIEF section 4 describes.
 */
export const ApprovalScopeSchema = z.strictObject({
  tenants: z.array(TenantIdSchema).min(1).max(64).readonly(),
  appInstances: z.array(AppInstanceIdSchema).min(1).max(64).readonly(),
});
export type ApprovalScope = DeepReadonly<z.infer<typeof ApprovalScopeSchema>>;

/**
 * What binds an approval to ONE request.
 *
 * `argsHash` is `approvalArgsHash` below - salted with the approval id, and the module comment
 * there says exactly what the salt buys and what it does not. `idempotencyKey` is the caller's own
 * de-duplication key, and binding it is what stops an approval for one write authorising a second
 * one: `appendSubAccount` in the fixture is deliberately NOT idempotent, so a replayed approval
 * with a fresh key is the exact mechanism by which a member gets two sub-accounts.
 *
 * `idempotencyKey` is nullable because a caller may legitimately have none - and an approval that
 * does not bind one says so in the document rather than being silently unbound. `verifyApproval`
 * treats `null` as "this approval does not constrain the key", and refuses a MISMATCH rather than
 * an absence.
 */
export const ApprovalRequestBindingSchema = z.strictObject({
  argsHash: DigestSchema,
  idempotencyKey: z.string().min(1).max(200).nullable(),
});
export type ApprovalRequestBinding = DeepReadonly<z.infer<typeof ApprovalRequestBindingSchema>>;

/** Every arm carries these. Split out so the three arms differ only where the design says they do. */
const approvalCommon = {
  schemaVersion: z.literal(SCHEMA_VERSION_APPROVAL),
  /** Stable, unique, and the handle a revocation names. Not a digest: an approval must be
   *  revocable by identity without anybody having to hold its bytes. */
  approvalId: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, {
      error: "an approval id is an opaque handle: letters, digits, dot, colon, dash, underscore",
    }),
  capability: z.strictObject({
    name: CapabilityNameSchema,
    version: ContractVersionSchema,
  }),
  /** BOTH digests, and both are checked. The artifact digest says which program; the contract
   *  digest says which set of outcome arms the caller was promised. An approval that pinned only
   *  the artifact would survive a contract bump that added a business outcome the approver never
   *  saw - which is precisely what `docs/design/OUTCOME-PROMOTION.md` makes a MAJOR version. */
  approves: z.strictObject({
    artifactDigest: DigestSchema,
    contractDigest: DigestSchema,
  }),
  scope: ApprovalScopeSchema,
  policyVersion: z.string().min(1).max(64),
  signer: ApprovalSignerRefSchema,
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  /** Over `approvalDigestOf(...)` - this document with `signature` removed. Detached, base64url or
   *  whatever the signing adapter emits; core never parses it and only hands it to the injected
   *  verifier. */
  signature: z.string().min(1).max(1024),
} as const;

/**
 * THE UNION, discriminated on `ceiling`, and the discriminant is doing the security work.
 *
 * "An approval for READ or WRITE_REVERSIBLE must not authorise WRITE_IRREVERSIBLE" is not enforced
 * here by comparing two strings at runtime. It is enforced by the shape:
 *
 *   · the `WRITE_IRREVERSIBLE` arm is the ONLY one whose `subject` is `z.literal("invocation")`, so
 *     an artifact approval - the "this procedure may exist" statement - cannot carry that ceiling
 *     at all;
 *   · the `WRITE_IRREVERSIBLE` arm is the ONLY one whose `request` is required, so a grant that
 *     does not name the exact arguments and de-duplication key it authorises does not parse;
 *   · consequently `IrreversibleApproval` is a TypeScript type that a READ approval cannot inhabit -
 *     `request: null` is not assignable to `ApprovalRequestBinding` - and the irreversible gate's
 *     parameter is that type. A caller who tries to hand a read approval to the write gate gets a
 *     compile error, not a refusal at 3am.
 *
 * There is exactly one place where a `ceiling` is narrowed at runtime, `irreversibleApprovalOf`
 * below, because a document arrives as JSON and something has to be the boundary. That function is
 * named, tested, and produces `effect-class-escalation` - never a boolean.
 */
const approvalSchemaImpl = z
  .discriminatedUnion("ceiling", [
    z.strictObject({
      ...approvalCommon,
      ceiling: z.literal("READ"),
      subject: ApprovalSubjectSchema,
      /** A read approval binds no request. There is nothing about a read that a per-request binding
       *  would protect, and a nullable field that is always null on this arm is a field somebody
       *  eventually populates. */
      request: z.null(),
    }),
    z.strictObject({
      ...approvalCommon,
      ceiling: z.literal("WRITE_REVERSIBLE"),
      subject: ApprovalSubjectSchema,
      /** Optional here: a reversible write CAN be bound to one request and often should be, but a
       *  standing approval for a reversible capability is a legitimate operational posture. */
      request: ApprovalRequestBindingSchema.nullable(),
    }),
    z.strictObject({
      ...approvalCommon,
      ceiling: z.literal("WRITE_IRREVERSIBLE"),
      /** THE LITERAL. An irreversible ceiling is an invocation statement or it is nothing. */
      subject: z.literal("invocation"),
      /** REQUIRED. See the union's header. */
      request: ApprovalRequestBindingSchema,
    }),
  ])
  .superRefine((a, ctx) => {
    // On the union rather than on each arm: the window rule is the same for all three, and three
    // copies of it is three places for one of them to be edited.
    if (!strictlyBefore(a.issuedAt, a.expiresAt)) {
      ctx.addIssue(
        `an approval expires after it is issued; this one is issued ${a.issuedAt} and expires ${a.expiresAt}`,
      );
    }
    // An ARTIFACT approval is a statement about a program and binds no request. The irreversible
    // arm cannot reach here (its `subject` is a literal), so this closes the only remaining way to
    // write "this procedure may exist, for these exact arguments" - which is two statements wearing
    // one signature.
    if (a.subject === "artifact" && a.request !== null) {
      ctx.addIssue(
        "an artifact approval says a procedure may exist; it binds no request, because binding one would make it an invocation approval with the wrong name on it",
      );
    }
  });
export interface ApprovalSchemaType extends SchemaIdentity<typeof approvalSchemaImpl> {}
export const ApprovalSchema: ApprovalSchemaType = approvalSchemaImpl;

export type Approval = DeepReadonly<z.infer<typeof ApprovalSchema>>;

/** The arm that can authorise a write nobody can take back. Uninhabitable by a read approval. */
export type IrreversibleApproval = Extract<Approval, { readonly ceiling: "WRITE_IRREVERSIBLE" }>;

/** An approval about a PROGRAM. Never irreversible, by construction. */
export type ArtifactApproval = Extract<Approval, { readonly subject: "artifact" }>;

export const parseApproval = (value: unknown): Approval => ApprovalSchema.parse(value) as Approval;
export const safeParseApproval = (value: unknown) => ApprovalSchema.safeParse(value);

// ---------------------------------------------------------------------------------------------
// What is signed
// ---------------------------------------------------------------------------------------------

/**
 * The digest an approval's signature is taken over: every field except `signature` itself.
 *
 * Deliberately NOT stored on the document. The artifact carries its own `digest` because a linker
 * check, an overlay merge and a promotion receipt all need to name it without holding the bytes; an
 * approval is presented whole or not at all, so a stored self-digest would only be a second place
 * for the truth to live and a first place for a forgery to start.
 */
export function approvalDigestOf(approval: Readonly<Record<string, unknown>>): Digest {
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(approval)) {
    if (key === "signature") continue;
    stripped[key] = value;
  }
  return digestOf(stripped);
}

/**
 * The request binding's argument hash, SALTED WITH THE APPROVAL ID.
 *
 * Say plainly what the salt buys, because it is easy to overclaim. A member number is five digits.
 * An unsalted hash of `{"memberId":"10041"}` is a hundred thousand-entry rainbow table, so a bare
 * digest of caller arguments IS the argument for anyone who sees it - and this value is written to
 * an approval document and compared inside a runtime that journals refusals.
 *
 * Salting with the approval id means the digest alone, leaked into a log line or a refusal message,
 * is not a lookup. It buys NOTHING against somebody holding the approval document itself, because
 * the id is right there next to the hash. That is the honest boundary: the salt protects the hash in
 * transit through the audit trail, not the document at rest, and the document at rest is protected
 * by not writing member data into one in the first place - `argsHash` is the only place a bound
 * value contributes to an approval at all, and it contributes as a digest.
 */
export function approvalArgsHash(approvalId: string, args: unknown): Digest {
  return digestOf([approvalId, canonicalJson(args)]);
}

// ---------------------------------------------------------------------------------------------
// The trust store: keys, roles, rotation, revocation
// ---------------------------------------------------------------------------------------------

/**
 * One signer, as the DEPLOYMENT knows them. Authoritative over anything the document claims.
 *
 * ROTATION lives in `notBefore` / `notAfter` / `supersedes`, and it is a story rather than a
 * mechanism because nothing here mints or distributes a key. What the seam gives you: two records
 * for one person, overlapping windows, the newer one naming the older in `supersedes`. During the
 * overlap both verify, so approvals signed before the cutover keep working while new ones are taken
 * under the new key; after it, the old record's `notAfter` has passed and its approvals refuse with
 * `signer-key-not-in-validity-window` rather than `signature-invalid` - which is the difference
 * between "your key was rotated" and "somebody forged this".
 *
 * REVOCATION is `status`, and it is separate from the window on purpose: an expired key is a
 * schedule, a revoked key is an incident, and an operator reading `signer-key-revoked` next to
 * `revokedReason` needs to know which one happened.
 */
export interface SignerRecord {
  readonly keyId: string;
  readonly signerId: string;
  /** The roles this signer holds. A demand names what it requires; this decides. */
  readonly authority: readonly string[];
  readonly alg: string;
  readonly notBefore: Timestamp;
  readonly notAfter: Timestamp;
  readonly status: "active" | "revoked";
  /** Read out loud in the refusal and in the journal. A revocation with no reason is an outage
   *  nobody can explain. */
  readonly revokedReason: string | null;
  /** The key id this one replaces, for a rotation an auditor can follow. `null` for a first key. */
  readonly supersedes: string | null;
}

/** One approval, refused by identity. The reason is mandatory for the same argument as above. */
export interface ApprovalRevocation {
  readonly approvalId: string;
  readonly reason: string;
  readonly revokedAt: Timestamp;
  readonly revokedBy: string;
}

/**
 * The approver trust store, in the two members linker check 27 needs and nothing more.
 *
 * `verifySignature` is INJECTED rather than implemented, and that is the honest seam this package
 * has always had: ed25519 verification is arithmetic `@crr/core` does not own, and importing a
 * crypto library into the package whose entire claim is that it has no ambient dependencies would
 * trade the architecture for one function. What core owns is the part that is a document question -
 * which digest was signed, and whether the key that signed it is one this deployment listed.
 *
 * It lives here rather than in `linker.ts` because the trust store is the approval model's, and the
 * linker is one of its two readers. THE SEAM IS THE KMS SEAM: a deployment whose keys live in an
 * HSM supplies a `verifySignature` that calls it, and nothing above this line changes.
 */
export interface ApprovalTrust {
  readonly trustedKeyIds: readonly string[];
  readonly verifySignature: (signed: {
    readonly over: string;
    readonly keyId: string;
    readonly alg: string;
    readonly signature: string;
  }) => boolean;
}

/**
 * The trust store the approval gate reads. A superset of `ApprovalTrust`, not a replacement.
 *
 * `ApprovalTrust` answers "is this key one we listed, and does this signature verify" and is what
 * linker check 27 needs. This adds the two things a linker cannot use and a runtime gate cannot do
 * without: WHO a key belongs to and what they are entitled to authorise, and WHAT has been withdrawn
 * since it was issued. Both are values, so the whole gate stays pure and a reviewer can re-run any
 * refusal from the store plus the document.
 */
export interface ApprovalTrustStore extends ApprovalTrust {
  readonly signers: readonly SignerRecord[];
  readonly revocations: readonly ApprovalRevocation[];
}

// ---------------------------------------------------------------------------------------------
// The refusal vocabulary
// ---------------------------------------------------------------------------------------------

/**
 * Every way an approval can be refused, each with its own name.
 *
 * A generic `approval-invalid` is worth nothing to the person on the other end of it: "expired" is
 * a five-second fix, "revoked signer" is an incident, "wrong tenant" is a mis-routed request, and
 * "effect-class escalation" is somebody trying to spend a read approval on a write. One test per
 * member, and `APPROVAL_REFUSAL_REASONS` is what that test iterates.
 */
export const ApprovalRefusalReasonSchema = z.enum([
  // -- is this an approval from somebody we trust? ---------------------------------------------
  "signer-unknown",
  "signer-key-revoked",
  "signer-key-not-in-validity-window",
  "signer-identity-mismatch",
  "signature-invalid",
  "approval-revoked",
  "signer-authority-insufficient",
  // -- does it authorise THIS? ------------------------------------------------------------------
  "subject-mismatch",
  "capability-mismatch",
  "artifact-digest-mismatch",
  "contract-digest-mismatch",
  "policy-version-mismatch",
  "tenant-not-in-scope",
  "app-instance-not-in-scope",
  "approval-not-yet-valid",
  "approval-expired",
  "effect-ceiling-exceeded",
  "effect-class-escalation",
  // -- and is it THIS request? ------------------------------------------------------------------
  "request-binding-missing",
  "args-hash-mismatch",
  "idempotency-key-mismatch",
]);
export type ApprovalRefusalReason = z.infer<typeof ApprovalRefusalReasonSchema>;

export const APPROVAL_REFUSAL_REASONS: readonly ApprovalRefusalReason[] =
  ApprovalRefusalReasonSchema.options;

// ---------------------------------------------------------------------------------------------
// The demand
// ---------------------------------------------------------------------------------------------

/**
 * What the runtime is asking the approval to authorise, assembled from the linked program and the
 * invocation - never from the approval itself.
 *
 * Every field here is something the gate KNOWS independently. That is the whole reason the demand
 * is a separate structure rather than a set of optional overrides: a check that reads its expected
 * value out of the document it is checking is not a check.
 */
export interface ApprovalDemand {
  readonly subject: ApprovalSubject;
  readonly capability: { readonly name: string; readonly version: string };
  readonly artifactDigest: Digest;
  readonly contractDigest: Digest;
  /** The effect of the action about to be dispatched. */
  readonly effect: EffectClass;
  /** The whole program's blast radius (`artifact.effects.maxEffect`). Checked separately from
   *  `effect`, because "this approval was issued for a procedure that cannot do that" and "this
   *  approval cannot authorise the step in front of me" are different mistakes. */
  readonly artifactMaxEffect: EffectClass;
  readonly tenantId: string;
  readonly appInstanceId: string;
  readonly policyVersion: string;
  /** ANY-of. An empty list means the demand does not constrain the role, which is legitimate for a
   *  read and is exactly what a write gate must not pass. */
  readonly requiredAuthority: readonly string[];
  /** `approvalArgsHash(approval.approvalId, args)`, computed by the caller because only the caller
   *  holds the bound arguments. `null` when the demand carries no request identity at all. */
  readonly argsHash: Digest | null;
  readonly idempotencyKey: string | null;
}

// ---------------------------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------------------------

/**
 * Accepted or refused, and a refusal always names one reason.
 *
 * `detail` is journaled, so it is written under the same rule as every other journalled string:
 * ids, digests, timestamps, tenant names and role names only. No argument value ever appears in one,
 * which is why `args-hash-mismatch` reports two digests and never what differed.
 */
export type ApprovalVerdict =
  | {
      readonly ok: true;
      readonly approvalId: string;
      readonly subject: ApprovalSubject;
      readonly ceiling: EffectClass;
      readonly signerId: string;
      readonly keyId: string;
      /** The recomputed content digest the signature was verified over. Journaled, so "which
       *  approval authorised this write" is answerable from the audit trail alone. */
      readonly over: Digest;
      readonly expiresAt: Timestamp;
    }
  | {
      readonly ok: false;
      readonly reason: ApprovalRefusalReason;
      readonly detail: string;
      readonly approvalId: string;
      readonly keyId: string | null;
    };

// ---------------------------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------------------------

/**
 * THE NARROWING BOUNDARY, and the only one.
 *
 * A document arrives as JSON, so somewhere a `ceiling` has to be looked at. This is that place, it
 * is one function, and its refusal has a name of its own - `effect-class-escalation` - rather than
 * being folded into whatever the caller was going to say next. Everything downstream takes
 * `IrreversibleApproval`, which a read approval cannot be assigned to.
 *
 * Note what it does NOT do: it does not verify anything. Narrowing is a type question and
 * verification is a trust question, and a function that did both would let a caller believe a
 * narrowed value was a checked one.
 */
export function irreversibleApprovalOf(
  approval: Approval,
):
  | { readonly ok: true; readonly approval: IrreversibleApproval }
  | { readonly ok: false; readonly verdict: Extract<ApprovalVerdict, { ok: false }> } {
  if (approval.ceiling === "WRITE_IRREVERSIBLE") return { ok: true, approval };
  return {
    ok: false,
    verdict: {
      ok: false,
      reason: "effect-class-escalation",
      detail: `approval ${approval.approvalId} was issued with a ${approval.ceiling} ceiling for subject ${approval.subject}; authorising a WRITE_IRREVERSIBLE action needs an approval issued for that class, and one cannot be produced by re-reading this one`,
      approvalId: approval.approvalId,
      keyId: approval.signer.keyId,
    },
  };
}

/**
 * Verify an approval against a demand, a trust store and a moment.
 *
 * PURE AND TOTAL. `now` is an argument; the trust store is data; the one thing that is not data is
 * `verifySignature`, injected exactly as `ApprovalTrust` has always injected it, because signature
 * arithmetic is a dependency this package does not have.
 *
 * THE ORDER IS PART OF THE DESIGN, and it is authenticate-then-authorise:
 *
 *   1..6  Is this an approval from somebody this deployment trusts, still, today?  Nothing in an
 *         unauthenticated blob is worth comparing against anything, so the roster, the key's state
 *         and the signature come first. The cost is that a forged document is refused on its
 *         signature rather than on the field its author got wrong, which is the correct trade: the
 *         alternative tells an attacker which of their guesses was closest.
 *   7..17 Does it authorise THIS - this program, this contract, this tenant, this instance, this
 *         window, this effect class, this request?
 *
 * First refusal wins, and every one of them is named.
 */
export function verifyApproval(input: {
  readonly approval: Approval;
  readonly demand: ApprovalDemand;
  readonly trust: ApprovalTrustStore;
  readonly now: Timestamp;
}): ApprovalVerdict {
  const { approval, demand, trust, now } = input;
  const id = approval.approvalId;
  const claimed = approval.signer;
  const refuse = (reason: ApprovalRefusalReason, detail: string): ApprovalVerdict => ({
    ok: false,
    reason,
    detail,
    approvalId: id,
    keyId: claimed.keyId,
  });

  // -- 1. the roster ---------------------------------------------------------------------------
  const record = trust.signers.find((s) => s.keyId === claimed.keyId);
  if (record === undefined) {
    return refuse(
      "signer-unknown",
      `approval ${id} names key ${claimed.keyId}, which is not in this deployment's signer roster`,
    );
  }

  // -- 2. revoked key --------------------------------------------------------------------------
  if (record.status === "revoked") {
    return refuse(
      "signer-key-revoked",
      `key ${record.keyId} (${record.signerId}) is revoked: ${record.revokedReason ?? "no reason recorded"}`,
    );
  }

  // -- 3. rotation window ----------------------------------------------------------------------
  //
  // Against `now`, not against `issuedAt`. An approval signed while the key was live but presented
  // after the key was retired is refused, and that is deliberate: retiring a key has to actually
  // stop things, or a rotation is a rename.
  if (!withinWindow(now, record.notBefore, record.notAfter)) {
    return refuse(
      "signer-key-not-in-validity-window",
      `key ${record.keyId} is valid from ${record.notBefore} to ${record.notAfter} and it is now ${now}${record.supersedes === null ? "" : ` (it supersedes ${record.supersedes})`}`,
    );
  }

  // -- 4. the identity the document claims -----------------------------------------------------
  if (record.signerId !== claimed.signerId) {
    return refuse(
      "signer-identity-mismatch",
      `key ${record.keyId} belongs to ${record.signerId} and approval ${id} claims it was signed by ${claimed.signerId}`,
    );
  }

  // -- 5. the signature, over a digest we recompute --------------------------------------------
  const over = approvalDigestOf(approval as unknown as Readonly<Record<string, unknown>>);
  const verified = trust.verifySignature({
    over,
    keyId: claimed.keyId,
    alg: claimed.alg,
    signature: approval.signature,
  });
  if (!verified) {
    return refuse(
      "signature-invalid",
      `the signature on approval ${id} does not verify over its own content digest ${over}`,
    );
  }

  // -- 6. the approval itself, withdrawn -------------------------------------------------------
  //
  // AFTER the signature, so a forged id cannot be used to fish the revocation list, and BEFORE
  // every scope check, because a withdrawn approval's contents stopped mattering the moment it was
  // withdrawn.
  const revocation = trust.revocations.find((r) => r.approvalId === id);
  if (revocation !== undefined) {
    return refuse(
      "approval-revoked",
      `approval ${id} was revoked at ${revocation.revokedAt} by ${revocation.revokedBy}: ${revocation.reason}`,
    );
  }

  // -- 7. the role -----------------------------------------------------------------------------
  //
  // Against the ROSTER's authority, never the document's. A signer who writes
  // `authority: ["break-glass"]` into their own approval has claimed a role, not been granted one.
  if (
    demand.requiredAuthority.length > 0 &&
    !demand.requiredAuthority.some((needed) => record.authority.includes(needed))
  ) {
    return refuse(
      "signer-authority-insufficient",
      `${record.signerId} holds [${record.authority.join(", ")}] and this action requires one of [${demand.requiredAuthority.join(", ")}]`,
    );
  }

  // -- 8. the subject --------------------------------------------------------------------------
  if (approval.subject !== demand.subject) {
    return refuse(
      "subject-mismatch",
      `approval ${id} approves the ${approval.subject}, and what is being authorised is the ${demand.subject}; "this procedure may exist" and "this execution may happen now" are different statements`,
    );
  }

  // -- 9. the capability -----------------------------------------------------------------------
  if (
    approval.capability.name !== demand.capability.name ||
    approval.capability.version !== demand.capability.version
  ) {
    return refuse(
      "capability-mismatch",
      `approval ${id} is for ${approval.capability.name}@${approval.capability.version} and this run is ${demand.capability.name}@${demand.capability.version}`,
    );
  }

  // -- 10/11. the two digests ------------------------------------------------------------------
  if (approval.approves.artifactDigest !== demand.artifactDigest) {
    return refuse(
      "artifact-digest-mismatch",
      `approval ${id} approves artifact ${approval.approves.artifactDigest} and this run links ${demand.artifactDigest}`,
    );
  }
  if (approval.approves.contractDigest !== demand.contractDigest) {
    return refuse(
      "contract-digest-mismatch",
      `approval ${id} approves contract ${approval.approves.contractDigest} and this run links ${demand.contractDigest}; the program is the one that was approved but the outcome arms a caller was promised are not`,
    );
  }

  // -- 12. the rules it was issued under -------------------------------------------------------
  if (approval.policyVersion !== demand.policyVersion) {
    return refuse(
      "policy-version-mismatch",
      `approval ${id} was issued under policy ${approval.policyVersion} and this deployment enforces ${demand.policyVersion}`,
    );
  }

  // -- 13/14. where ----------------------------------------------------------------------------
  if (!approval.scope.tenants.some((t) => t === demand.tenantId)) {
    return refuse(
      "tenant-not-in-scope",
      `approval ${id} is scoped to [${approval.scope.tenants.join(", ")}] and this run is at ${demand.tenantId}`,
    );
  }
  if (!approval.scope.appInstances.some((a) => a === demand.appInstanceId)) {
    return refuse(
      "app-instance-not-in-scope",
      `approval ${id} is scoped to app instances [${approval.scope.appInstances.join(", ")}] and this run is against ${demand.appInstanceId}`,
    );
  }

  // -- 15. when --------------------------------------------------------------------------------
  if (strictlyBefore(now, approval.issuedAt)) {
    return refuse(
      "approval-not-yet-valid",
      `approval ${id} is issued at ${approval.issuedAt} and it is now ${now}`,
    );
  }
  if (!strictlyBefore(now, approval.expiresAt)) {
    return refuse(
      "approval-expired",
      `approval ${id} expired at ${approval.expiresAt} and it is now ${now}`,
    );
  }

  // -- 16. how much ----------------------------------------------------------------------------
  //
  // Two comparisons, two names. The first is about the PROGRAM: an approval issued for a read
  // capability cannot be spent on a document that writes, even at a step that happens to be a read.
  // The second is about the MOMENT: this action, right now, against the ceiling this approval was
  // issued under. Collapsing them would report "insufficient ceiling" for an escalation attempt and
  // hide which of the two mistakes was made.
  if (effectExceeds(demand.artifactMaxEffect, approval.ceiling)) {
    return refuse(
      "effect-ceiling-exceeded",
      `approval ${id} has a ${approval.ceiling} ceiling and this program's blast radius is ${demand.artifactMaxEffect}`,
    );
  }
  if (effectExceeds(demand.effect, approval.ceiling)) {
    return refuse(
      "effect-class-escalation",
      `approval ${id} has a ${approval.ceiling} ceiling and the action being authorised is ${demand.effect}`,
    );
  }

  // -- 17. which request -----------------------------------------------------------------------
  const binding = approval.request;
  if (binding === null) {
    // Reachable only on the READ and WRITE_REVERSIBLE arms - the irreversible arm's `request` is
    // required by the schema - and only when the caller demanded a request identity anyway.
    if (demand.argsHash !== null || demand.idempotencyKey !== null) {
      return refuse(
        "request-binding-missing",
        `approval ${id} binds no request and this invocation was presented with one; an approval that does not name the arguments it authorises authorises all of them`,
      );
    }
  } else {
    if (demand.argsHash === null || binding.argsHash !== demand.argsHash) {
      return refuse(
        "args-hash-mismatch",
        `approval ${id} binds argument hash ${binding.argsHash} and this invocation hashes to ${demand.argsHash ?? "nothing - no arguments were bound"}`,
      );
    }
    if (binding.idempotencyKey !== null && binding.idempotencyKey !== demand.idempotencyKey) {
      return refuse(
        "idempotency-key-mismatch",
        `approval ${id} binds idempotency key ${binding.idempotencyKey} and this invocation presented ${demand.idempotencyKey ?? "none"}; a write this system cannot take back is authorised once, for one key`,
      );
    }
  }

  return {
    ok: true,
    approvalId: id,
    subject: approval.subject,
    ceiling: approval.ceiling,
    signerId: record.signerId,
    keyId: record.keyId,
    over,
    expiresAt: approval.expiresAt,
  };
}

/**
 * The write gate. Takes an `IrreversibleApproval`, which a read approval cannot be.
 *
 * This is the function P2's write gate calls, and the signature is the point of it: there is no
 * argument you can pass that gets an irreversible action authorised by a read approval, because the
 * only way to obtain the parameter type is `irreversibleApprovalOf`, which refuses with
 * `effect-class-escalation`.
 *
 * `requiredAuthority` is forced non-empty here rather than left to the caller. An irreversible write
 * authorised by "somebody holding a trusted key" is the control this whole module exists to
 * replace, and a demand that forgot to name a role would silently be that.
 */
export function authorizeIrreversibleWrite(input: {
  readonly approval: IrreversibleApproval;
  readonly demand: ApprovalDemand & { readonly requiredAuthority: readonly [string, ...string[]] };
  readonly trust: ApprovalTrustStore;
  readonly now: Timestamp;
}): ApprovalVerdict {
  if (input.demand.effect !== "WRITE_IRREVERSIBLE") {
    return {
      ok: false,
      reason: "effect-class-escalation",
      detail: `the irreversible write gate was asked to authorise a ${input.demand.effect} action; a gate that also passes reads is a gate nobody notices is open`,
      approvalId: input.approval.approvalId,
      keyId: input.approval.signer.keyId,
    };
  }
  return verifyApproval(input);
}

// ---------------------------------------------------------------------------------------------
// Time, compared without a clock
// ---------------------------------------------------------------------------------------------

/**
 * Lexicographic, because `TIMESTAMP_PATTERN` is ISO-8601 UTC with a mandatory trailing `Z` and
 * `primitives.ts` says in so many words that this makes timestamps "mergeable into one timeline by
 * string comparison".
 *
 * The one wrinkle the pattern allows is optional milliseconds, and `Z` sorts above `.`, so
 * `...:00Z` would compare ABOVE `...:00.500Z` on a naive comparison. Both sides are padded to the
 * millisecond form first. This is the whole reason there is a helper rather than a `<` at each of
 * the four call sites: one of the four would eventually have been written without the padding, and
 * it would have been the expiry one.
 */
function toMillis(t: Timestamp): string {
  return t.length === 20 ? `${t.slice(0, 19)}.000Z` : t;
}

function strictlyBefore(a: Timestamp, b: Timestamp): boolean {
  return toMillis(a) < toMillis(b);
}

function withinWindow(now: Timestamp, notBefore: Timestamp, notAfter: Timestamp): boolean {
  const n = toMillis(now);
  return n >= toMillis(notBefore) && n < toMillis(notAfter);
}
