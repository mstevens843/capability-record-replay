// SPEC section 2.8 - the types of the single chokepoint.
//
// Every action, in BOTH discovery and replay, passes through one `check(action, ctx)` and nothing
// else. That is enforced by a contract test that fails if any `Surface.act` call site in the repo is
// not immediately preceded by a check on the same action - a package boundary would not have bought
// that property, which is why there is no `@crr/policy`.
//
// The predicate itself is the policy unit's; what is here is its vocabulary. It is pure: no I/O, no
// clock. Time enters as `expiresAt` on a lease snapshot and is compared against a timestamp the
// caller supplies, and secrets never enter at all - a tainted value reaches this module as an
// opaque handle, so the engine can tell that an action carries regulated text without ever holding
// the text.

import { z } from "zod";
import { ResolvedStepSchema } from "./artifact.js";
import { ActionKindSchema, OriginAliasSchema } from "./observation.js";
import {
  ApprovalTokenSchema,
  type DeepReadonly,
  DigestSchema,
  EffectClassSchema,
} from "./primitives.js";
import type { SchemaIdentity } from "./schema-identity.js";
import { LeaseSnapshotSchema } from "./session.js";

/** An opaque stand-in for a value bound to a sensitive parameter. Branded so that a raw string can
 *  never be passed where one of these is expected - the compiler is the first line of the taint
 *  model, and the redaction canary test is the second. */
export const TaintHandleSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^taint:[A-Za-z0-9_-]+$/, { error: "a taint handle is opaque and carries no value" })
  .brand<"TaintHandle">();
export type TaintHandle = z.infer<typeof TaintHandleSchema>;

export const AllowlistSchema = z.strictObject({
  originAliases: z.array(OriginAliasSchema).min(1).max(32).readonly(),
  /**
   * Route PATTERNS, never hosts-as-strings.
   *
   * Two consequences, and the second is the one that matters: the allowlist survives a tenant on a
   * different host, and it cannot be satisfied by a lookalike domain, because the alias is resolved
   * from the tenant's own overlay rather than parsed out of whatever the page navigated to.
   */
  routes: z
    .array(
      z.strictObject({
        originAlias: OriginAliasSchema,
        pathPattern: z.string().startsWith("/").max(512),
        maxEffect: EffectClassSchema,
      }),
    )
    .min(1)
    .max(256)
    .readonly(),
  actionKinds: z.array(ActionKindSchema).min(1).readonly(),
  maxEffect: EffectClassSchema,
  /** Discovery only: the model may not act outside this even before an artifact exists. This is
   *  the gate that stops a discovery run being a licence to drive anything. */
  discoveryMaxEffect: EffectClassSchema,
});
export type Allowlist = DeepReadonly<z.infer<typeof AllowlistSchema>>;

const policyContextSchemaImpl = z.strictObject({
  mode: z.enum(["discovery", "replay", "operator"]),
  allowlist: AllowlistSchema,
  /** The RESOLVED step, or null during free discovery. */
  step: ResolvedStepSchema.nullable(),
  /** Where the action would land, canonicalized by the driver BEFORE the check - so the policy
   *  engine never parses a URL and never has to decide what two spellings of one host mean. */
  route: z
    .strictObject({ originAlias: OriginAliasSchema, path: z.string().startsWith("/").max(512) })
    .nullable(),
  effect: EffectClassSchema,
  lease: LeaseSnapshotSchema,
  approval: ApprovalTokenSchema.nullable(),
  artifact: z
    .strictObject({
      lifecycle: z.enum(["proposed", "draft", "approved", "deprecated"]),
      digestVerified: z.boolean(),
    })
    .nullable(),
  /** Values bound to sensitive parameters, as OPAQUE HANDLES. */
  taint: z.array(TaintHandleSchema).max(32).readonly(),
  /** The digest the caller's approval token was minted against, when there is one. Carried so a
   *  token issued for one artifact cannot authorize a different one. */
  approvedDigest: DigestSchema.nullable(),
});
export interface PolicyContextSchemaType extends SchemaIdentity<typeof policyContextSchemaImpl> {}
export const PolicyContextSchema: PolicyContextSchemaType = policyContextSchemaImpl;

export type PolicyContext = DeepReadonly<z.infer<typeof PolicyContextSchema>>;

export const PolicyDenialReasonSchema = z.enum([
  "origin-not-allowed",
  "route-not-allowed",
  "action-kind-not-allowed",
  "effect-exceeds-allowlist",
  "effect-exceeds-artifact",
  "irreversible-requires-approval",
  "artifact-not-approved",
  "artifact-digest-mismatch",
  "lease-not-held",
  "tainted-value-to-disallowed-sink",
]);
export type PolicyDenialReason = z.infer<typeof PolicyDenialReasonSchema>;

/**
 * A decision always names the rule that produced it.
 *
 * An allow with no `ruleId` is indistinguishable from a missing check, and the journal has to be
 * able to prove that every dispatched action was preceded by a decision that named a rule - which
 * is how "one chokepoint" becomes a demonstrated property rather than an architectural claim.
 */
export const PolicyDecisionSchema = z.union([
  z.strictObject({
    allow: z.literal(true),
    effect: EffectClassSchema,
    ruleId: z.string().min(1).max(128),
  }),
  z.strictObject({
    allow: z.literal(false),
    reason: PolicyDenialReasonSchema,
    ruleId: z.string().min(1).max(128),
    detail: z.string().max(1000),
  }),
]);
export type PolicyDecision = DeepReadonly<z.infer<typeof PolicyDecisionSchema>>;
