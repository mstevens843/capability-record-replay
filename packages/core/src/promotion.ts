// Outcome promotion: how a HUMAN gets a business outcome into a document that refuses to let a
// model write one (docs/design/OUTCOME-PROMOTION.md).
//
// THE GAP THIS CLOSES. Synthesis emits `contract.outcomes: []` and says why at the site it happens:
// a detector for a screen the run never observed would be inferred rather than declared, and that
// is exactly how a false MEMBER_NOT_FOUND ships. The run carries the refusal forward as a
// `review`-severity note, and `NoteSeverity` already promises that `review` means "the artifact
// cannot be approved until a person has read the note". Until this module existed there was nothing
// a person reading it could DO. The note was a dead end.
//
// THE RULE IT IS DERIVED FROM is BRIEF section 3.4 - recording is not a claim until it replays -
// applied to the reviewer rather than to the model. A detector is a claim about what a screen
// means. A human typing it is exactly as unverified as a model emitting it, and more dangerous,
// because the model's output is routed through a refusal while the human's arrives with the
// authority of having been reviewed. So the reviewer's detector faces the same gate the model's
// flow did, and the gate is STRICTER, because a detector is provable in a way a step list is not.
//
// WHAT IS PROVABLE, precisely: that this predicate FIRES on a captured observation of the outcome
// screen and is SILENT on every other observation the system holds. That is the mutant meta-test's
// logic (`packages/conformance`) turned on detectors - a suite that cannot tell a good engine from
// a subtly wrong one has proved nothing, and a detector that cannot tell the outcome screen from
// every other screen has detected nothing.
//
// WHY IT IS IN `@crr/core`. No clock, no I/O, no randomness, no driver import. A proof that needed a
// browser could not be re-run by a reviewer, by CI, or by the postmortem six months later - and the
// evaluation below is `evaluatePredicate`, THE SAME FUNCTION THE CLASSIFIER'S BAND B3 CALLS, not a
// re-implementation of it. A proof that could disagree with the runtime about what a predicate
// means would be worthless, and the only way to guarantee they cannot is to make it the same call.

import { z } from "zod";
import { OutcomeRuleSchema } from "./artifact.js";
import { OutcomeDeclSchema } from "./contract.js";
import { combineDigests, digestOf } from "./digest.js";
import {
  type EvalContext,
  type ProgramFacts,
  type ResolvedBindings,
  evaluatePredicate,
} from "./evaluate.js";
import type { Predicate } from "./matchers.js";
import type { Observation } from "./observation.js";
import {
  AppInstanceIdSchema,
  CapabilityNameSchema,
  ContractVersionSchema,
  type DeepReadonly,
  type Digest,
  DigestSchema,
  LabelTokenSchema,
  RunIdSchema,
  type StepId,
  StepIdSchema,
  type TenantId,
  TenantIdSchema,
  TimestampSchema,
} from "./primitives.js";
import type { SchemaIdentity } from "./schema-identity.js";

export const SCHEMA_VERSION_PROMOTION = "capability.promotion/v1";

/** Goes on every receipt. Bumping it is a deliberate act: it changes what every future receipt
 *  claims was run, and an old receipt keeps naming the prover that actually produced it. */
export const PROVER_VERSION = "crr-prover/1";

// ---------------------------------------------------------------------------------------------
// The review document - an INPUT, not a fourth document type
// ---------------------------------------------------------------------------------------------
//
// SPEC section 0.4 is "three documents, three readers", and a fourth document would have no fourth
// reader: at runtime the linker, the interpreter and the classifier read the detector off
// `artifact.flow.steps[].outcomes[]` and would never open a promotion document at all. Keeping one
// live would store two copies of one detector and force the linker to decide which wins, which is
// precisely the version skew SPEC section 1.2 refuses `@crr/schema` in order to avoid.
//
// So this is consumed ONCE, at promotion time, and leaves behind a `promotions[]` receipt on the
// artifact plus its own archived bytes. The binding runs one way - from `reviewDigest` to
// `evidence/promotions/` - and that is the cost, stated plainly: lose those bytes and the receipt
// names a document nobody can read.

/**
 * The detector, written in THE LANGUAGE THE ARTIFACT ALREADY USES.
 *
 * There is no second predicate language here and there must never be one. The four criteria that
 * decided the first one's membership - diffable in a pull request, reviewable by someone who is not
 * an engineer, cost-bounded, renderable into prose - are MORE important for a human-authored
 * detector, not less, because this one is not backed by a recording. Reusing `OutcomeRuleSchema`
 * verbatim means the reviewer inherits every refusal for free: no regex, no stylesheet selector, no
 * path expression, no URL, no node id, no member number, no matcher that constrains only its scope,
 * no matcher that normalizes to the empty string, no `count >= 0`.
 *
 * `code` is omitted because it is on the outcome declaration below and one file must not be able to
 * disagree with itself. `origin` is omitted because the promotion stamps it: a review document that
 * could declare itself `synthesized` would be a review document that could launder its own
 * provenance.
 */
const promotionDetectorSchemaImpl = OutcomeRuleSchema.omit({ code: true, origin: true }).extend({
  /** WHICH STEP. OPEN-QUESTIONS Q2 chose per-step scoping to catch "MEMBER_NOT_FOUND was detected
   *  at a step where it is impossible"; this is the field that gets it wrong, and the proof is what
   *  catches it - a detector declared at the wrong step has no positive at that step and comes back
   *  `does-not-fire`. */
  atStep: StepIdSchema,
});
export interface PromotionDetectorSchemaType
  extends SchemaIdentity<typeof promotionDetectorSchemaImpl> {}
export const PromotionDetectorSchema: PromotionDetectorSchemaType = promotionDetectorSchemaImpl;

export type PromotionDetector = DeepReadonly<z.infer<typeof PromotionDetectorSchema>>;

/**
 * The outcome declaration, plus the one field that stays HERE and is never promoted.
 *
 * OPEN-QUESTIONS Q1's addendum asks for "a one-line `stableUnderRetry: true` assertion authored by
 * whoever declared it", and today that field is a bare `z.literal(true)` that costs nothing to
 * type. `stableUnderRetryBecause` is the justification, and it is deliberately NOT copied onto the
 * contract: the contract is what a calling agent reads, and a rationale for a taxonomy decision is
 * not routing information - `describeCapability` assembles "reviewed fields and NOTHING ELSE".
 * `crr approve` prints it, resolved through `reviewDigest`, so the approver reads the claim at the
 * moment they accept it.
 *
 * The trade-off is that the justification sits one dereference away from the document it justifies,
 * which is worth it because the alternative puts un-routing prose into the one document whose whole
 * discipline is that it contains only what a router needs.
 */
const promotionOutcomeSchemaImpl = OutcomeDeclSchema.omit({ origin: true }).extend({
  stableUnderRetryBecause: z.string().min(1).max(1000),
});
export interface PromotionOutcomeSchemaType
  extends SchemaIdentity<typeof promotionOutcomeSchemaImpl> {}
export const PromotionOutcomeSchema: PromotionOutcomeSchemaType = promotionOutcomeSchemaImpl;

export type PromotionOutcome = DeepReadonly<z.infer<typeof PromotionOutcomeSchema>>;

const promotionReviewSchemaImpl = z
  .strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION_PROMOTION),
    /** Which artifact this review is against, by content address. A review written against one
     *  program and applied to another is the one mistake this field exists to make impossible. */
    promotes: z.strictObject({
      capability: CapabilityNameSchema,
      contractVersion: ContractVersionSchema,
      artifactDigest: DigestSchema,
    }),
    /** An identity handle, not a mailbox - matching `ApproveOptions.approvedBy`. */
    reviewedBy: z.string().min(1).max(128),
    /** Inside `reviewDigest` and therefore inside artifact@v2's digest, which is fine and is the
     *  distinction section 3.4 draws: the RECEIPT carries no clock, and the archived document may,
     *  because artifact@v2's address stays reproducible from these bytes plus the corpus. */
    reviewedAt: TimestampSchema,

    outcome: PromotionOutcomeSchema,
    detector: PromotionDetectorSchema,

    /** Additive only, merged into `artifact@v2.flow.vocabulary`. A `token` matcher is the form the
     *  multi-tenant design wants an author to reach for, and it is useless without its words. */
    vocabulary: z.record(LabelTokenSchema, z.array(z.string().min(1).max(300)).min(1).max(16)),

    evidence: z.strictObject({
      /**
       * THE POSITIVES, NAMED BY CONTENT ADDRESS AND BY THE RUN THAT PRODUCED THEM.
       *
       * A hand-written observation is refused: the promotion tool re-derives the digest from bytes
       * on disk and cross-checks the run's journal that this digest was captured AT THE DECLARED
       * STEP. Nobody authored these screens - they came out of `Surface.perceive()`, through the
       * driver's own normalization, with the driver's own skeleton digest and stability on them.
       * The reviewer chooses WHICH CAPTURE IS THE OUTCOME; they do not get to say what the screen
       * said.
       *
       * Be honest about what that stops. A reviewer with commit access can fabricate a consistent
       * observation AND a consistent journal. The digest check raises forgery from "edit one line"
       * to "fabricate an internally consistent run", and the control actually standing behind it is
       * that the receipt is inside a digest an identified approver signs. Nothing here defends
       * against the approver.
       */
      positives: z
        .array(
          z.strictObject({
            observation: DigestSchema,
            fromRun: RunIdSchema,
            atStep: StepIdSchema,
            tenantId: TenantIdSchema,
            appInstanceId: AppInstanceIdSchema,
          }),
        )
        .min(1)
        .max(64)
        .readonly(),
      /** Directories of frozen observations the proof draws its negatives from. Paths, because the
       *  reviewer is pointing at bundles on their own disk and core never dereferences one. */
      corpusRefs: z.array(z.string().min(1).max(1024)).min(1).max(64).readonly(),
    }),
  })
  .superRefine((review, ctx) => {
    for (const positive of review.evidence.positives) {
      if (positive.atStep !== review.detector.atStep) {
        ctx.addIssue(
          `the detector is declared at step ${review.detector.atStep} and a positive is named at ${positive.atStep}; a detector is only ever evaluated at its own step, so that screen is not evidence for it`,
        );
      }
    }
  });
export interface PromotionReviewSchemaType
  extends SchemaIdentity<typeof promotionReviewSchemaImpl> {}
export const PromotionReviewSchema: PromotionReviewSchemaType = promotionReviewSchemaImpl;

export type PromotionReview = DeepReadonly<z.infer<typeof PromotionReviewSchema>>;

export const parsePromotionReview = (value: unknown): PromotionReview =>
  PromotionReviewSchema.parse(value) as PromotionReview;
export const safeParsePromotionReview = (value: unknown): z.ZodSafeParseResult<PromotionReview> =>
  PromotionReviewSchema.safeParse(value) as z.ZodSafeParseResult<PromotionReview>;

/** The address a receipt's `reviewDigest` names: over the canonical JSON of the whole review
 *  document. It carries no `digest` field of its own, so nothing is excluded. */
export const promotionReviewDigestOf = (review: unknown): Digest => digestOf(review);

// ---------------------------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------------------------

/** How a run ended. The one distinction the proof cares about is `ok` versus everything else. */
export type CorpusRunStatus = "ok" | "outcome" | "suspended" | "failed";

/**
 * One frozen observation, with the four facts about its capture that the proof needs and that the
 * reviewer does not get to assert: which step, which phase, how the run ended, and which tenant.
 *
 * NOTE WHAT IS ABSENT: a digest field. The prover computes each entry's content address itself with
 * `digestOf(observation)` rather than believing one it was handed, which deletes an entire class of
 * mislabelling - "here is the address of the not-found screen" attached to some other screen. The
 * value it computes is the same one the evidence sink minted, because the sink content-addresses
 * the REDACTED observation and this is the redacted observation read back off disk.
 *
 * `atStep` and `phase` are read off the run journal's `evidence.captured` line, which is why that
 * event now carries both. A security-relevant binding inferred from line ordering is exactly the
 * quiet wrongness this repository refuses everywhere else.
 */
export interface CorpusEntry {
  readonly observation: Observation;
  readonly atStep: StepId;
  readonly phase: "pre" | "post";
  readonly runStatus: CorpusRunStatus;
  readonly tenantId: TenantId;
}

/**
 * What the corpus held, by class, with NO THRESHOLD ATTACHED TO ANY OF IT.
 *
 * OPEN-QUESTIONS Q4 settles this precedent for `needsSpecialization` - "Measure it; ship no number.
 * Inventing a number and defending it in the write-up would be exactly the kind of unearned
 * precision this repo does not do" - and the same rule governs here. Exactly one minimum is
 * enforced (section 5.5); every other dimension is REPORTED, so an approver reads that a detector
 * was never shown a competing abnormal screen at its own step rather than being handed an invented
 * number's opinion of that fact.
 *
 * The four buckets partition the negatives exactly, so they sum to `total`. `otherAbnormalAtStep`
 * is "every other observation at this step and tenant" - an abnormal screen, and also the rare
 * `pre`-phase capture on a green run.
 */
export interface NegativeCensus {
  readonly total: number;
  /** Same tenant, same step, phase `post`, on a run that reached `ok`. THE ONE THAT IS MANDATORY. */
  readonly happyPathAtStep: number;
  /** Same tenant, same step, any other run. The session-expired banner, the app-error banner - the
   *  screens that decide whether this detector can tell "no member found" from "the server threw". */
  readonly otherAbnormalAtStep: number;
  readonly otherSteps: number;
  readonly otherTenants: number;
}

/**
 * Corpus identity: a digest over the SORTED member observation digests.
 *
 * Sorted, so the answer does not depend on the order a directory listing came back in; a digest, so
 * "proven against which corpus" is answerable years later and a corpus that grew after the proof is
 * visibly a different corpus.
 *
 * One measured caveat, taken from `evidence.ts`'s own header rather than assumed: content
 * addressing deduplicates WITHIN a browser session and not ACROSS sessions, because a `UINode` id
 * embeds a CDP per-document counter - the same application-error screen produced four different
 * digests across five `pnpm demo` runs. So a count of corpus members overcounts near-duplicates and
 * must be read as "how many observations", never as "how many distinct screens".
 */
export function corpusDigestOf(entries: readonly CorpusEntry[]): Digest {
  return combineDigests([...entries.map((e) => digestOf(e.observation))].sort());
}

// ---------------------------------------------------------------------------------------------
// The proof
// ---------------------------------------------------------------------------------------------

export interface ProofInput {
  /** The candidate detector, in the artifact's own predicate language. */
  readonly detect: Predicate;
  readonly atStep: StepId;
  /** The tenant being proven. A `token` matcher resolves through `flow.vocabulary`, which an
   *  overlay overrides per tenant, so `not-found-banner` is DIFFERENT TEXT at Riverbend and Summit
   *  and a proof at one says nothing about the other. Run this once per (tenant, overlay) pair
   *  against the MERGED program; `provenAt` is the list of tenants that passed. */
  readonly tenant: TenantId;
  readonly positives: readonly CorpusEntry[];
  readonly negatives: readonly CorpusEntry[];
  /** From the linked program: post-overlay vocabulary, routes, branding tokens. */
  readonly facts: ProgramFacts;
  /** The same bindings the linker produced. A detector may compare against a bound value; it may
   *  never copy one, which is `evaluate.ts`'s rule and holds here unchanged. */
  readonly bindings: ResolvedBindings;
}

/** How one designated positive behaved. `wrong-step` is not a third kind of failure - it is the
 *  mis-scoping case, reported as its own row so the reviewer reads the actual mistake. */
export interface PositiveResult {
  readonly observation: Digest;
  readonly atStep: StepId;
  readonly outcome: "fires" | "silent" | "wrong-step";
}

interface ProofCommon {
  readonly atStep: StepId;
  readonly tenant: TenantId;
  readonly proverVersion: string;
  readonly positives: readonly PositiveResult[];
  readonly negatives: NegativeCensus;
  readonly corpusDigest: Digest;
  /** One sentence a person can act on. Present on every arm, including the passing one. */
  readonly reason: string;
}

/** Which member of the enforced minimum was missing. */
export type ThinCorpusReason = "no-positive" | "no-happy-path-negative-at-step";

/**
 * Four verdicts, and NO `warn` ARM AND NO OVERRIDE FLAG. A gate with a bypass is not a gate.
 *
 * Only `discriminates` permits a receipt to be written, which is why `PromotionReceipt.verdict` is
 * a `z.literal` - a receipt for a failed proof is unrepresentable, the same move `Verification`
 * makes by having no "record that it failed" path.
 */
export type ProofResult =
  | (ProofCommon & { readonly verdict: "discriminates" })
  | (ProofCommon & {
      readonly verdict: "does-not-fire";
      /** The positive it was silent on, or that was captured at another step. */
      readonly observation: Digest;
      readonly capturedAt: StepId;
    })
  | (ProofCommon & {
      readonly verdict: "over-fires";
      /**
       * ONE NEGATIVE MATTERS MORE THAN ALL THE OTHERS. `fires-on-happy-path` is not a stronger
       * warning than `fires-on-other-screen`, it is a DIFFERENT BUG: shipping this detector
       * converts every successful run through that step into a false MEMBER_NOT_FOUND. The report
       * says that in words rather than printing a digest, and the arm is separate so a caller
       * cannot accidentally treat the two the same.
       */
      readonly subclass: "fires-on-happy-path" | "fires-on-other-screen";
      readonly observation: Digest;
      readonly capturedAt: StepId;
      readonly capturedOn: CorpusRunStatus;
    })
  | (ProofCommon & { readonly verdict: "corpus-too-thin"; readonly missing: ThinCorpusReason });

/**
 * PROVE THAT THIS DETECTOR DISCRIMINATES. Pure, total, and over frozen observations only.
 *
 * THE ORDER OF THE CHECKS IS PART OF THE DESIGN, because each one makes the next one's message
 * worth reading:
 *
 *   1. No designated positive at all - there is nothing to prove. (`corpus-too-thin`)
 *   2. A positive the detector is silent on, or one captured at another step. (`does-not-fire`)
 *      BEFORE the corpus minimum, deliberately: a detector that does not fire on the one screen the
 *      reviewer does have is broken regardless of what else the corpus holds, and answering "go
 *      capture more screens" there is bad advice.
 *   3. No happy-path negative at this step and tenant. (`corpus-too-thin`) Without one, "fires on
 *      the outcome screen" is unfalsifiable at the only place it matters, and `fires-on-happy-path`
 *      - the verdict that catches the worst bug in this whole design - cannot be reached at all.
 *      It is always OBTAINABLE (artifact@v1 could not have become a draft without a verification
 *      replay that passed through this step) and never already STORED, because `captureOn` is
 *      `["failure"]` in production and a green run therefore freezes nothing. That asymmetry is why
 *      `crr probe --capture-every` exists.
 *   4. A negative it fires on, happy-path ones named first. (`over-fires`)
 *   5. Otherwise it discriminates.
 *
 * WHAT THIS DOES NOT ESTABLISH, said here because the verdict name is confident and the claim is
 * not: the proof's claim is exactly "fires on these captures, silent on those" and nothing larger.
 * A screen nobody froze is a screen the proof did not consider, and the most likely such screen is
 * the one that arrives after the next vendor upgrade. It also cannot tell you that the screen MEANS
 * "no such member" rather than "your search timed out and we rendered an empty grid" - that is the
 * reviewer's judgement, recorded in `stableUnderRetryBecause` and signed for.
 */
export function proveDiscrimination(input: ProofInput): ProofResult {
  const census = censusOf(input);
  const corpusDigest = corpusDigestOf(input.negatives);

  const positives: PositiveResult[] = input.positives.map((entry) => ({
    observation: digestOf(entry.observation),
    atStep: entry.atStep,
    outcome:
      entry.atStep !== input.atStep ? "wrong-step" : fires(input, entry) ? "fires" : "silent",
  }));

  const common: ProofCommon = {
    atStep: input.atStep,
    tenant: input.tenant,
    proverVersion: PROVER_VERSION,
    positives,
    negatives: census,
    corpusDigest,
    reason: "",
  };

  // 1.
  if (positives.length === 0) {
    return {
      ...common,
      verdict: "corpus-too-thin",
      missing: "no-positive",
      reason: `no observation was designated as the ${input.atStep} outcome screen, so there is nothing for the detector to be proven against`,
    };
  }

  // 2.
  const unproven = positives.find((p) => p.outcome !== "fires");
  if (unproven !== undefined) {
    return {
      ...common,
      verdict: "does-not-fire",
      observation: unproven.observation,
      capturedAt: unproven.atStep,
      reason:
        unproven.outcome === "wrong-step"
          ? `the detector is declared at step ${input.atStep} and its positive ${unproven.observation} was captured at ${unproven.atStep}; a detector is only ever evaluated at its own step, so this screen is not evidence for it and the declared step is where the condition cannot happen`
          : `the detector is silent on ${unproven.observation}, the observation designated as the outcome screen at ${input.atStep} for tenant ${input.tenant}`,
    };
  }

  // 3.
  if (census.happyPathAtStep === 0) {
    return {
      ...common,
      verdict: "corpus-too-thin",
      missing: "no-happy-path-negative-at-step",
      reason: `the corpus holds no observation captured at step ${input.atStep}, phase post, on a run that reached ok at tenant ${input.tenant}; without one, "fires on the outcome screen" is unfalsifiable at the only place it matters - run a green probe with --capture-every, because a successful run freezes nothing on its own`,
    };
  }

  // 4. Happy-path negatives first: the subclass is a different bug, not a louder one, and a report
  //    that named some incidental screen while a green run also matched would bury the real finding.
  const offender =
    input.negatives.find((e) => isHappyPathAtStep(input, e) && fires(input, e)) ??
    input.negatives.find((e) => fires(input, e));
  if (offender !== undefined) {
    const happyPath = isHappyPathAtStep(input, offender);
    const digest = digestOf(offender.observation);
    return {
      ...common,
      verdict: "over-fires",
      subclass: happyPath ? "fires-on-happy-path" : "fires-on-other-screen",
      observation: digest,
      capturedAt: offender.atStep,
      capturedOn: offender.runStatus,
      reason: happyPath
        ? `the detector fires on ${digest}, a screen captured at step ${input.atStep} on a run that SUCCEEDED; shipping it would turn every successful run through that step into a confident business outcome about a record that is in fact there`
        : `the detector fires on ${digest}, captured at step ${offender.atStep} on a run that ended ${offender.runStatus} at tenant ${offender.tenantId}; it does not tell the outcome screen apart from that one`,
    };
  }

  // 5.
  return {
    ...common,
    verdict: "discriminates",
    reason: `fires on ${positives.length} designated positive(s) at step ${input.atStep} and is silent on all ${census.total} negative(s), of which ${census.happyPathAtStep} were captured at that step on a successful run and ${census.otherAbnormalAtStep} were other screens at that step`,
  };
}

/** The classifier's own call, with the classifier's own context. Not a re-implementation. */
function fires(input: ProofInput, entry: CorpusEntry): boolean {
  const ctx: EvalContext = {
    observation: entry.observation,
    program: input.facts,
    bindings: input.bindings,
  };
  return evaluatePredicate(input.detect, ctx);
}

function isHappyPathAtStep(input: ProofInput, entry: CorpusEntry): boolean {
  return (
    entry.tenantId === input.tenant &&
    entry.atStep === input.atStep &&
    entry.phase === "post" &&
    entry.runStatus === "ok"
  );
}

function censusOf(input: ProofInput): NegativeCensus {
  let happyPathAtStep = 0;
  let otherAbnormalAtStep = 0;
  let otherSteps = 0;
  let otherTenants = 0;
  for (const entry of input.negatives) {
    if (entry.tenantId !== input.tenant) otherTenants += 1;
    else if (entry.atStep !== input.atStep) otherSteps += 1;
    else if (isHappyPathAtStep(input, entry)) happyPathAtStep += 1;
    else otherAbnormalAtStep += 1;
  }
  return {
    total: input.negatives.length,
    happyPathAtStep,
    otherAbnormalAtStep,
    otherSteps,
    otherTenants,
  };
}
