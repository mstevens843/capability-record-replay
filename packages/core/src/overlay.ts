// SPEC section 2.5 - the overlay document: per-tenant, additive, non-semantic.
//
// The rule that makes multi-tenancy safe is one sentence:
//
//     AN OVERLAY MAY NOT CHANGE WHAT A CAPABILITY MEANS.
//
// Not the contract, not an outcome code, not an effect class, not a step's instruction, not the
// step order, not a checkpoint predicate. An overlay may change how a control is FOUND, what a
// label is called locally, how long to wait, and where the app is mounted, and it may ADD
// recoveries. A per-tenant file that could change what a capability DOES would be a supply-chain
// hole reviewed to a config file's standard - which is the standard these files actually get.
//
// The enforcement is that the type has no slot for any of it. There is no `outcomes` field, no
// `instruction` field, no `expect` field, and `strictObject` means inventing one is a parse error.
// The linker re-checks the same ground (check 20) against the base artifact, because "the ids you
// patched exist" needs both documents in hand.

import { z } from "zod";
import { RecoveryRuleSchema, SettlePolicyBaseSchema, StepBudgetsSchema } from "./artifact.js";
import { DescriptorIdSchema, DescriptorSchema } from "./descriptors.js";
import {
  AppInstanceIdSchema,
  ArtifactIdSchema,
  type DeepReadonly,
  DigestSchema,
  LabelTokenSchema,
  RouteIdSchema,
  StepIdSchema,
  TenantIdSchema,
} from "./primitives.js";
import type { SchemaIdentity } from "./schema-identity.js";

export const SCHEMA_VERSION_OVERLAY = "capability.overlay/v1";

/**
 * A real origin, and the ONE place in the whole schema where a host is legitimate.
 *
 * Everywhere else an origin is a symbolic alias, precisely so that an artifact cannot become
 * accidentally single-tenant. This is where the alias is finally bound, in the per-tenant file, and
 * it is a scheme and an authority with no path: a path here would let an overlay silently retarget
 * where every route in the program lands.
 *
 * FOUR SCHEMES, not one. `http`/`https` was the whole list until build unit 21 bound an alias for a
 * green screen and had to choose between writing a fictional `https://` host into a document that
 * would never make an HTTP request, or admitting the field was browser-shaped. A Symitar Episys or
 * an AS/400 is reached over telnet or TN3270, and that IS the origin in exactly the sense this field
 * means it: the authority a tenant's session is opened against. Nothing in the engine parses this
 * string - `resolveOverlay` carries it through and hands it to whatever opens the session - so the
 * widening costs no behaviour and buys a per-tenant file that is true.
 */
export const OriginSchema = z
  .string()
  .regex(/^(https?|telnet|tn3270):\/\/[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?$/, {
    error:
      "an origin is a scheme and a host with no path, e.g. https://riverbend-cb.example.invalid or telnet://green.riverbend.example.invalid:23",
  })
  .max(256);

const stepOverrideSchemaImpl = z
  .strictObject({
    /**
     * ADD a descriptor rather than editing the base one.
     *
     * A base descriptor that no longer resolves simply ABSTAINS, and that abstention is recorded
     * permanently in the fingerprint - which is a visible record of divergence. An overlay that
     * EDITED the base would erase the very signal the fingerprint exists to produce, and it would
     * make the approval signature over the base digest a signature over something this tenant never
     * runs.
     */
    addDescriptors: z.array(DescriptorSchema).min(1).max(4).readonly().optional(),
    /**
     * Mark a base descriptor as abstaining here. This is the one repair an add-only overlay cannot
     * otherwise make: an ordinal on a nav bar that gained a tab is permanently ambiguous, and no
     * amount of adding fixes it. Disabling is recorded in the fingerprint exactly like an
     * abstention, and the quorum check still has to pass over what survives.
     */
    disableDescriptors: z.array(DescriptorIdSchema).min(1).max(4).readonly().optional(),
    settle: SettlePolicyBaseSchema.partial().optional(),
    budgets: StepBudgetsSchema.partial().optional(),
    /** Only the header-provenance correction: a tenant whose grid DOES emit header roles, or one
     *  where row zero is a filter bar and the heuristic guessed wrong. */
    tableHeaders: z
      .record(
        z.string().min(1).max(128),
        z.array(z.string().min(1).max(128)).min(1).max(64).readonly(),
      )
      .optional(),
  })
  .superRefine((o, ctx) => {
    if (
      o.addDescriptors === undefined &&
      o.disableDescriptors === undefined &&
      o.settle === undefined &&
      o.budgets === undefined &&
      o.tableHeaders === undefined
    ) {
      ctx.addIssue("a step override that overrides nothing is a typo, not a policy");
    }
    if (o.settle !== undefined && Object.keys(o.settle).length === 0) {
      ctx.addIssue("an empty settle override changes nothing");
    }
    if (o.budgets !== undefined && Object.keys(o.budgets).length === 0) {
      ctx.addIssue("an empty budget override changes nothing");
    }
    const added = new Set((o.addDescriptors ?? []).map((d) => d.id));
    for (const id of o.disableDescriptors ?? []) {
      if (added.has(id)) {
        ctx.addIssue(`descriptor ${id} is both added and disabled by this override`);
      }
    }
  });
export interface StepOverrideSchemaType extends SchemaIdentity<typeof stepOverrideSchemaImpl> {}
export const StepOverrideSchema: StepOverrideSchemaType = stepOverrideSchemaImpl;

export type StepOverride = DeepReadonly<z.infer<typeof StepOverrideSchema>>;

const capabilityOverlaySchemaImpl = z
  .strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION_OVERLAY),
    appliesTo: z.strictObject({
      artifactId: ArtifactIdSchema,
      version: z.strictObject({
        min: z.int().positive(),
        max: z.int().positive().optional(),
      }),
    }),
    tenantId: TenantIdSchema,
    appInstanceId: AppInstanceIdSchema,

    originAliases: z.record(
      z
        .string()
        .regex(/^[a-z][a-z0-9-]*$/, { error: "an origin alias is a symbolic name" })
        .max(64),
      OriginSchema,
    ),

    /**
     * Route BASE PATH only - a prefix, never the path template.
     *
     * This covers the real case (the same vendor product mounted at /cb here and /corebank there)
     * without letting an overlay retarget where a `navigate` goes, which would be a semantic change
     * in the one document reviewed to a config file's standard.
     */
    routeBasePath: z
      .record(
        RouteIdSchema,
        z
          .string()
          .startsWith("/", { error: "a base path is absolute" })
          .max(128)
          .refine((p) => !p.includes("://") && !p.includes(":"), {
            error: "a base path is a fixed prefix: no origin, and no parameter placeholders",
          }),
      )
      .optional(),

    /** THE HINGE. Replaces a token's synonym list wholesale. One entry usually fixes a whole
     *  tenant, and because descriptors, detectors, row keys and checkpoints all reference the same
     *  token, one edit reaches all of them. */
    vocabulary: z
      .record(LabelTokenSchema, z.array(z.string().min(1).max(128)).min(1).max(16).readonly())
      .optional(),

    /** Branding words removed by the label normalizer before comparison, per tenant. This is why a
     *  tenant's branding never has to be baked into the shared registry. */
    stripTokens: z.array(z.string().min(1).max(64)).min(1).max(32).readonly().optional(),

    steps: z.record(StepIdSchema, StepOverrideSchema).optional(),

    /**
     * ADD-only, and RECOVERIES only.
     *
     * The type has no slot for an outcome, and that is the important part. Adding an outcome would
     * widen the union every caller switches on, and a caller compiled against
     * MEMBER_NOT_FOUND | MEMBER_RESTRICTED must not silently receive a third value at one tenant
     * and not at another. A genuinely unique tenant answer is a contract bump for everyone -
     * visible, reviewed, and correct.
     */
    addRecoveries: z
      .record(StepIdSchema, z.array(RecoveryRuleSchema).min(1).max(8).readonly())
      .optional(),

    digest: DigestSchema,
  })
  .superRefine((o, ctx) => {
    const { min, max } = o.appliesTo.version;
    if (max !== undefined && max < min) {
      ctx.addIssue(
        `appliesTo.version.max (${max}) is below min (${min}), so it applies to nothing`,
      );
    }
    if (Object.keys(o.originAliases).length === 0) {
      ctx.addIssue(
        "an overlay must bind at least one origin alias, or the program has nowhere to run",
      );
    }
    for (const [stepId, recoveries] of Object.entries(o.addRecoveries ?? {})) {
      const names = recoveries.map((r) => r.name);
      if (new Set(names).size !== names.length) {
        ctx.addIssue(`overlay adds recoveries with duplicate names at step ${stepId}`);
      }
    }
  });
export interface CapabilityOverlaySchemaType
  extends SchemaIdentity<typeof capabilityOverlaySchemaImpl> {}
export const CapabilityOverlaySchema: CapabilityOverlaySchemaType = capabilityOverlaySchemaImpl;

export type CapabilityOverlay = DeepReadonly<z.infer<typeof CapabilityOverlaySchema>>;
