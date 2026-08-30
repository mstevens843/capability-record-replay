// The discrimination proof, which is the whole of what stands between a human's opinion about a
// screen and a caller being told MEMBER_NOT_FOUND about a member who exists.
//
// EVERY CASE HERE IS A REFUSAL EXCEPT ONE, and that ratio is the point. A gate is only worth having
// if you can show what it stops, so the four detectors below are the four mistakes a competent,
// well-intentioned reviewer actually makes - a matcher that is trivially true, a matcher keyed on
// the institution's chrome, a detector scoped to a step where the condition cannot happen, and a
// corpus too thin to tell any of them apart - and each is asserted by VERDICT AND BY THE
// OBSERVATION IT NAMES, because a refusal that cannot say which screen it choked on is a refusal
// nobody can act on.
//
// The corpus is the repository's own frozen screens: `classifier-screens.ts` and
// `corebank-observations.ts`, the same ones the classifier's own tests run against. That is
// deliberate. A proof evaluated through `evaluatePredicate` - the SAME function `bandB3` calls -
// against the SAME screens the classifier is tested on is a proof that cannot quietly disagree with
// the runtime about what a predicate means.

import { describe, expect, it } from "vitest";
import {
  BoundedPredicateSchema,
  type CorpusEntry,
  type LabelToken,
  MAX_PREDICATE_DEPTH,
  type Observation,
  PROVER_VERSION,
  type Predicate,
  PromotionReviewSchema,
  SafeTextMatcherSchema,
  type StepId,
  type TenantId,
  corpusDigestOf,
  digestOf,
  parsePromotionReview,
  promotionReviewDigestOf,
  proveDiscrimination,
} from "../src/index.js";
import {
  appErrorPage,
  bindings,
  entitlementDenied,
  notFoundBanner,
  program,
  sessionExpired,
  validationError,
} from "./fixtures/classifier-screens.js";
import { detail, results, searchForm } from "./fixtures/corebank-observations.js";

// ---------------------------------------------------------------------------------------------
// The corpus, assembled the way `crr promote` assembles it off disk
// ---------------------------------------------------------------------------------------------

const SUBMIT = "submit-search" as StepId;
const ENTER = "enter-member-id" as StepId;
const OPEN_ROW = "open-member-row" as StepId;
const RIVERBEND = "riverbend" as TenantId;
const SUMMIT = "summit" as TenantId;

const at = (
  observation: Observation,
  atStep: StepId,
  runStatus: CorpusEntry["runStatus"],
  tenantId: TenantId = RIVERBEND,
  phase: "pre" | "post" = "post",
): CorpusEntry => ({ observation, atStep, phase, runStatus, tenantId });

/** The one designated positive: the screen the condition probe froze at `submit-search`. */
const POSITIVE = at(notFoundBanner, SUBMIT, "outcome");

/**
 * The negatives, and the third group is the sharpest.
 *
 * `results` is THE MANDATORY ONE - the same step, phase `post`, on a run that reached `ok`. Note
 * what it costs to have: `evidence.captureOn` is `["failure"]` on every step of every shipped
 * artifact, so a green run freezes nothing and this screen is the one the repository never keeps.
 * It exists here only because a fixture corpus is not a production evidence bundle, which is
 * exactly why `crr probe --capture-every` had to be built.
 *
 * The abnormal-but-different screens at the same step (`appErrorPage`, `sessionExpired`,
 * `validationError`) are what decide whether a detector can tell "no member found" from "the server
 * threw" - the failure mode that worries me most, because it returns a STABLE answer about a
 * TRANSIENT system fact, which is Q1's rule inverted.
 */
const NEGATIVES: readonly CorpusEntry[] = [
  // The mandatory class: green, same step, phase post.
  at(results, SUBMIT, "ok"),
  at(results, SUBMIT, "ok"),
  // Abnormal, same step, different condition.
  at(appErrorPage, SUBMIT, "failed"),
  at(sessionExpired, SUBMIT, "failed"),
  at(validationError, SUBMIT, "outcome"),
  // Other steps on the same run.
  at(searchForm, ENTER, "ok"),
  at(detail, OPEN_ROW, "ok"),
  at(entitlementDenied, OPEN_ROW, "failed"),
  // Another tenant. Admitted as a negative - the detector must be silent at Summit too - but never
  // able to satisfy the minimum on its own.
  at(results, SUBMIT, "ok", SUMMIT),
];

const token = (t: string) =>
  ({ mode: "token", token: t as LabelToken, normalize: "std.label@1" }) as const;

const CONTENT_FRAME = {
  kind: "frame",
  name: { mode: "exact", value: "content", normalize: "std.text@1" },
} as const;

/** The detector a reviewer would actually write, in the artifact's own predicate language. */
const GOOD: Predicate = {
  kind: "text-present",
  scope: { path: [CONTENT_FRAME] },
  text: token("not-found-banner"),
} as unknown as Predicate;

const prove = (over: Partial<Parameters<typeof proveDiscrimination>[0]> = {}) =>
  proveDiscrimination({
    detect: GOOD,
    atStep: SUBMIT,
    tenant: RIVERBEND,
    positives: [POSITIVE],
    negatives: NEGATIVES,
    facts: program,
    bindings,
    ...over,
  });

// ---------------------------------------------------------------------------------------------
// The one that passes
// ---------------------------------------------------------------------------------------------

describe("a detector that discriminates", () => {
  it("fires on the outcome screen and is silent on every other observation the system holds", () => {
    const result = prove();
    expect(result.verdict, result.reason).toBe("discriminates");
    expect(result.positives).toEqual([
      { observation: digestOf(notFoundBanner), atStep: SUBMIT, outcome: "fires" },
    ]);
  });

  it("reports the corpus by class and ships no threshold for any of it", () => {
    const result = prove();
    // Exactly one minimum is enforced - a happy-path negative at the step. Everything else is
    // REPORTED, per OPEN-QUESTIONS Q4's precedent, so an approver reads what the corpus held rather
    // than an invented number's opinion of it.
    expect(result.negatives).toEqual({
      total: 9,
      happyPathAtStep: 2,
      otherAbnormalAtStep: 3,
      otherSteps: 3,
      otherTenants: 1,
    });
    expect(result.negatives.total).toBe(
      result.negatives.happyPathAtStep +
        result.negatives.otherAbnormalAtStep +
        result.negatives.otherSteps +
        result.negatives.otherTenants,
    );
  });

  it("addresses its corpus, so a corpus that grew afterwards is visibly a different corpus", () => {
    const before = prove();
    const after = prove({ negatives: [...NEGATIVES, at(notFoundBanner, OPEN_ROW, "failed")] });
    expect(after.corpusDigest).not.toBe(before.corpusDigest);
    // Sorted on the way in, so the answer does not depend on the order a directory listing came
    // back in. Two orderings of the same screens are the same corpus.
    expect(corpusDigestOf([...NEGATIVES].reverse())).toBe(before.corpusDigest);
  });

  it("names the prover that ran, so an old receipt keeps naming the prover that produced it", () => {
    expect(prove().proverVersion).toBe(PROVER_VERSION);
  });
});

// ---------------------------------------------------------------------------------------------
// 6.1 - a detector that matches the empty string
// ---------------------------------------------------------------------------------------------

describe("a detector that matches the empty string", () => {
  it("is refused at PARSE when its value normalizes to nothing", () => {
    // `min(1)` already refuses `""`. What survives it is a matcher one character long whose
    // NORMALIZED value is empty - `std.text@1` folds whitespace - and the empty string is contained
    // in every string on every screen, including a blank one.
    const parsed = SafeTextMatcherSchema.safeParse({
      mode: "contains",
      value: "  ",
      normalize: "std.text@1",
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("normalizes to the empty string");
  });

  it("is refused at PARSE for a zero-width character, which no diff shows", () => {
    const parsed = SafeTextMatcherSchema.safeParse({
      mode: "exact",
      value: "​",
      normalize: "std.label@1",
    });
    expect(parsed.success).toBe(false);
  });

  it("keeps a matcher that only LOOKS empty, because std.identity@1 normalizes nothing", () => {
    // Under `std.identity@1` two spaces really do only match two spaces, so refusing this one would
    // be the lint overreaching into a legitimate comparison on a character grid.
    expect(
      SafeTextMatcherSchema.safeParse({ mode: "exact", value: "  ", normalize: "std.identity@1" })
        .success,
    ).toBe(true);
  });

  it("is refused at PARSE as `count >= 0`, which is true of every screen including an empty one", () => {
    const parsed = BoundedPredicateSchema.safeParse({
      kind: "count",
      where: { role: "status" },
      op: "gte",
      n: 0,
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("a count of at least zero");
    // The same query with a real bound is exactly what a detector should say.
    expect(
      BoundedPredicateSchema.safeParse({
        kind: "count",
        where: { role: "status" },
        op: "gte",
        n: 1,
      }).success,
    ).toBe(true);
  });

  it("is refused BY THE PROOF as well, which is the general answer rather than a list of shapes", () => {
    // Handed straight to the prover as a value, past the schema that would have refused it. This is
    // the case for having a proof at all: the lint enumerates the trivially-true shapes somebody
    // thought of, and the proof catches the ones nobody did.
    const trivial = {
      kind: "count",
      where: { role: "status" },
      op: "gte",
      n: 0,
    } as unknown as Predicate;
    const result = prove({ detect: trivial });
    expect(result.verdict).toBe("over-fires");
    if (result.verdict !== "over-fires") return;
    expect(result.subclass).toBe("fires-on-happy-path");
    expect(result.observation).toBe(digestOf(results));
    expect(result.capturedOn).toBe("ok");
    expect(result.reason).toContain("a run that SUCCEEDED");
  });
});

// ---------------------------------------------------------------------------------------------
// 6.2 - a detector keyed on something present on every screen
// ---------------------------------------------------------------------------------------------

describe("a detector keyed on the institution's own chrome", () => {
  // This is the one the schema CANNOT catch, because "CoreBank" is a perfectly legitimate piece of
  // surface vocabulary. It is WHERE it appears that is wrong, and only a corpus can say that.
  const branding: Predicate = {
    kind: "text-present",
    scope: { path: [CONTENT_FRAME] },
    text: { mode: "contains", value: "CoreBank", normalize: "std.text@1" },
  } as unknown as Predicate;

  it("parses, because the string is real surface vocabulary", () => {
    expect(BoundedPredicateSchema.safeParse(branding).success).toBe(true);
  });

  it("is refused by the proof, and the subclass says which bug it is", () => {
    const result = prove({ detect: branding });
    expect(result.verdict).toBe("over-fires");
    if (result.verdict !== "over-fires") return;
    // Not a stronger warning than `fires-on-other-screen` - a DIFFERENT bug. Shipping this converts
    // every successful run through the step into a confident business outcome about a member who is
    // in fact on file, which is the worst thing this system can emit.
    expect(result.subclass).toBe("fires-on-happy-path");
    expect(result.capturedAt).toBe(SUBMIT);
    expect(result.observation).toBe(digestOf(results));
  });

  it("names a happy-path negative even when an abnormal one would also have matched", () => {
    // The offender is chosen happy-path-first on purpose: a report that named some incidental
    // screen while a green run also matched would bury the finding that actually matters.
    const result = prove({
      detect: branding,
      negatives: [at(appErrorPage, SUBMIT, "failed"), at(results, SUBMIT, "ok")],
    });
    expect(result.verdict).toBe("over-fires");
    if (result.verdict !== "over-fires") return;
    expect(result.observation).toBe(digestOf(results));
  });

  it("is refused as `fires-on-other-screen` when the only screen it also matches is abnormal", () => {
    // A detector that cannot tell the not-found banner from the app-error banner returns a STABLE
    // answer about a TRANSIENT system fact, which is Q1's rule inverted and worse than either arm.
    const bothBanners: Predicate = {
      any: [
        GOOD,
        {
          kind: "text-present",
          scope: { path: [CONTENT_FRAME] },
          text: token("app-error-banner"),
        },
      ],
    } as unknown as Predicate;
    const result = prove({ detect: bothBanners });
    expect(result.verdict).toBe("over-fires");
    if (result.verdict !== "over-fires") return;
    expect(result.subclass).toBe("fires-on-other-screen");
    expect(result.observation).toBe(digestOf(appErrorPage));
    expect(result.capturedOn).toBe("failed");
  });
});

// ---------------------------------------------------------------------------------------------
// 6.3 - a detector scoped to a step where the condition is impossible
// ---------------------------------------------------------------------------------------------

describe("a detector scoped to a step where the condition cannot happen", () => {
  // MEMBER_NOT_FOUND declared on `enter-member-id`, before the search has been dispatched. Linker
  // check 8 does NOT catch this: it proves the code is reachable from SOME step, not that the step
  // is plausible.
  it("is refused, because its positive was captured somewhere else", () => {
    const result = prove({ atStep: ENTER });
    expect(result.verdict).toBe("does-not-fire");
    if (result.verdict !== "does-not-fire") return;
    expect(result.observation).toBe(digestOf(notFoundBanner));
    expect(result.capturedAt).toBe(SUBMIT);
    expect(result.reason).toContain("only ever evaluated at its own step");
    expect(result.positives[0]?.outcome).toBe("wrong-step");
  });

  it("IS rescued by relabelling the positive - which is why the pure proof is not the only control", () => {
    // MEASURED, AND IT IS A LIMIT OF THE PROOF RATHER THAN A BUG IN IT. Move the positive's
    // `atStep` to follow the mis-scoped detector and the proof passes: the predicate is written in
    // terms of a SCREEN, so it really does fire on that screen and really is silent on the green
    // one at `enter-member-id`. Nothing a pure function of frozen observations can see is wrong
    // here.
    //
    // What is wrong is the LABEL, and the label is not the reviewer's to write. `evidence.captured`
    // carries `stepId` for exactly this reason, and `promote.ts` re-derives every positive's step
    // from the run journal rather than believing the review document -
    // `packages/runtime/test/promote.test.ts` asserts the refusal. The design's section 6.3 claims
    // the proof catches this on its own; it does not, and the journal cross-check is the control
    // that actually does.
    const result = prove({ atStep: ENTER, positives: [at(notFoundBanner, ENTER, "outcome")] });
    expect(result.verdict).toBe("discriminates");
  });

  it("refuses the review document outright when it names a positive at another step", () => {
    // Cheaper still: the same mistake is a parse error on the review document, so it never reaches
    // the proof at all.
    const parsed = PromotionReviewSchema.safeParse({
      ...VALID_REVIEW,
      evidence: {
        ...VALID_REVIEW.evidence,
        positives: [{ ...VALID_REVIEW.evidence.positives[0], atStep: "enter-member-id" }],
      },
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("only ever evaluated at its own step");
  });
});

// ---------------------------------------------------------------------------------------------
// 5.5 - a corpus too thin to decide
// ---------------------------------------------------------------------------------------------

describe("a corpus too thin to decide", () => {
  it("refuses when nothing was designated as the outcome screen", () => {
    const result = prove({ positives: [] });
    expect(result.verdict).toBe("corpus-too-thin");
    if (result.verdict !== "corpus-too-thin") return;
    expect(result.missing).toBe("no-positive");
  });

  it("refuses when no happy-path negative was captured at the step, and says how to get one", () => {
    // The clause that is not negotiable. Without a green capture at the declared step, "fires on
    // the outcome screen" is unfalsifiable at the only place it matters - and `fires-on-happy-path`,
    // the verdict that catches the worst bug in this design, cannot be reached at all.
    const result = prove({ negatives: NEGATIVES.filter((n) => n.runStatus !== "ok") });
    expect(result.verdict).toBe("corpus-too-thin");
    if (result.verdict !== "corpus-too-thin") return;
    expect(result.missing).toBe("no-happy-path-negative-at-step");
    expect(result.reason).toContain("--capture-every");
  });

  it("does not accept a green capture from ANOTHER TENANT as the happy-path negative", () => {
    // A `token` matcher resolves through the flow's vocabulary and an overlay overrides that per
    // tenant, so `not-found-banner` is different text at Summit. A proof at one tenant says nothing
    // whatever about the other, and a cross-tenant negative must not be able to satisfy the
    // minimum on its own.
    const result = prove({ negatives: [at(results, SUBMIT, "ok", SUMMIT)] });
    expect(result.verdict).toBe("corpus-too-thin");
    if (result.verdict !== "corpus-too-thin") return;
    expect(result.negatives.otherTenants).toBe(1);
    expect(result.negatives.happyPathAtStep).toBe(0);
  });

  it("does not accept a PRE-phase capture as the happy-path negative", () => {
    // "Not yet" is not "not so" one level up: the screen a step is judged on is the one after it
    // acted, and a pre-phase capture at the same step is a different screen with the same label.
    const result = prove({ negatives: [at(results, SUBMIT, "ok", RIVERBEND, "pre")] });
    expect(result.verdict).toBe("corpus-too-thin");
    if (result.verdict !== "corpus-too-thin") return;
    expect(result.negatives.happyPathAtStep).toBe(0);
    expect(result.negatives.otherAbnormalAtStep).toBe(1);
  });

  it("checks the positive BEFORE the corpus, because bad advice is worse than none", () => {
    // A detector that is silent on the one screen the reviewer does have is broken whatever else
    // the corpus holds, and answering "go capture more screens" there sends them off to do work
    // that will not help.
    const silent: Predicate = {
      kind: "text-present",
      scope: { path: [CONTENT_FRAME] },
      text: token("app-error-banner"),
    } as unknown as Predicate;
    const result = prove({ detect: silent, negatives: [] });
    expect(result.verdict).toBe("does-not-fire");
  });
});

// ---------------------------------------------------------------------------------------------
// The proof is the classifier's own evaluation, not a second opinion about it
// ---------------------------------------------------------------------------------------------

describe("the proof and the runtime cannot disagree", () => {
  it("resolves a token through the SAME vocabulary the classifier was handed", () => {
    // Drop the token from the program facts and the detector evaluates to FALSE rather than
    // throwing - `evaluate.ts`'s totality rule, which fails closed away from a business outcome.
    // A proof that quietly succeeded on an unresolvable token would be certifying a detector that
    // can never fire at runtime.
    const { "not-found-banner": _dropped, ...rest } = program.vocabulary;
    const result = prove({ facts: { ...program, vocabulary: rest } });
    expect(result.verdict).toBe("does-not-fire");
  });

  it("honours the tenant's own words, so the same detector proves differently per tenant", () => {
    // Summit's overlay says the banner reads something else. The identical predicate is silent on
    // the identical screen, which is exactly why `provenAt` is a list and linker check 29 refuses
    // to link at a tenant the list does not name.
    const summitVocabulary = {
      ...program.vocabulary,
      "not-found-banner": ["Nessun risultato"],
    };
    const result = prove({ facts: { ...program, vocabulary: summitVocabulary } });
    expect(result.verdict).toBe("does-not-fire");
  });
});

// ---------------------------------------------------------------------------------------------
// The review document
// ---------------------------------------------------------------------------------------------

const VALID_REVIEW = {
  schemaVersion: "capability.promotion/v1",
  promotes: {
    capability: "corebank.member.find",
    contractVersion: "1.0.0",
    artifactDigest: digestOf("some artifact"),
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
    detect: GOOD,
  },
  vocabulary: { "not-found-banner": ["No member found"] },
  evidence: {
    positives: [
      {
        observation: digestOf(notFoundBanner),
        fromRun: "run-probe-1",
        atStep: "submit-search",
        tenantId: "riverbend",
        appInstanceId: "riverbend-fixture",
      },
    ],
    corpusRefs: ["evidence/probe-not-found/observations"],
  },
} as const;

describe("the review document", () => {
  it("parses, and carries no `origin` for the reviewer to launder", () => {
    const review = parsePromotionReview(VALID_REVIEW);
    expect(review.detector.atStep).toBe("submit-search");
    expect("origin" in review.detector).toBe(false);
    expect("origin" in review.outcome).toBe(false);
  });

  it("inherits every refusal the artifact's own predicate language makes", () => {
    // The reviewer writes in the SAME language, so there is no second grammar to keep in step and
    // no second set of refusals to remember. A detector naming a member number is a parse error on
    // the review document for exactly the reason it is one on the artifact.
    const withPii = {
      ...VALID_REVIEW,
      detector: {
        ...VALID_REVIEW.detector,
        detect: {
          kind: "text-present",
          scope: { path: [CONTENT_FRAME] },
          text: {
            mode: "contains",
            value: "No member found for 500012345",
            normalize: "std.text@1",
          },
        },
      },
    };
    const parsed = PromotionReviewSchema.safeParse(withPii);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("template hole");
  });

  it("refuses a predicate nested past the artifact's own ceiling", () => {
    let nested: unknown = GOOD;
    for (let i = 0; i < MAX_PREDICATE_DEPTH + 1; i += 1) nested = { not: nested };
    const parsed = PromotionReviewSchema.safeParse({
      ...VALID_REVIEW,
      detector: { ...VALID_REVIEW.detector, detect: nested },
    });
    expect(parsed.success).toBe(false);
  });

  it("keeps `stableUnderRetryBecause` on the review and out of the contract", () => {
    // The contract is what a calling agent reads, and a rationale for a taxonomy decision is not
    // routing information. The approver reads it, resolved through `reviewDigest`, at the moment
    // they accept it.
    const review = parsePromotionReview(VALID_REVIEW);
    expect(review.outcome.stableUnderRetryBecause).toContain("fact about the record");
  });

  it("is addressed by its whole bytes, so the receipt names a document nobody can edit quietly", () => {
    const a = promotionReviewDigestOf(VALID_REVIEW);
    const b = promotionReviewDigestOf({ ...VALID_REVIEW, reviewedBy: "someone-else" });
    expect(a).not.toBe(b);
  });
});
