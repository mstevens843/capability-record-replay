// `crr promote`: the edge from a `review`-severity note to a business outcome a caller can act on.
//
// WHAT THIS FILE IS FOR. `packages/discovery/src/synthesis/emit.ts` emits `contract.outcomes: []`
// and refuses to invent a detector, correctly. `NoteSeverity` promises that a `review` note means
// "the artifact cannot be approved until a person has read the note". Until this existed, a person
// who read it had nowhere to go. This is the somewhere.
//
// IT IS A REVISION, NEVER AN EDIT. `artifact@v1 (draft)` plus a review document produce
// `contract@v2` and `artifact@v2 (proposed)`; v1 is left exactly where it is, still a valid,
// verified, approvable draft that answers `ok | failed` and never MEMBER_NOT_FOUND - which is a TRUE
// description of a program with no detector, and better for a deployment that has not finished its
// review than a half-promoted v2. `recordVerification` already refuses to re-verify an APPROVED
// artifact because that would change the digest its approval signs; the same argument applies one
// step earlier, because a draft's digest is the address a reviewer has been reading.
//
// THE CONTRACT BUMPS MAJOR. Adding an outcome code is a breaking change from the CALLER's side: an
// exhaustive `switch (r.outcome)` that compiled yesterday does not compile tomorrow. A MINOR bump
// would leave a caller pinned through `ContractPin` (linker check 4) silently entitled to receive an
// arm its generated types have never heard of, which is the exact failure the pin exists to prevent.
//
// NOTHING HERE REACHES A MODEL, and neither does `crr probe`. The whole promotion path runs with
// zero credentials, which is the property the rest of the replay path already has.
//
// WHAT IT DOES NOT DO: it does not verify. `promote` writes a `proposed` artifact and stops, because
// the second gate is a LIVE REPLAY of the happy path (`crr verify`), and that gate is not a
// formality. `classify.ts` evaluates band B3 (declared outcomes) BEFORE band B5 (the checkpoint) and
// B3 is terminal, so adding a detector to a step changes the meaning of every successful run through
// it. A hijacking detector makes `replay()` return the `outcome` arm, `gradeVerification` fails
// closed on that with a reason it already carries, and v2 stays `proposed` for ever. The two gates
// are not redundant: the pure proof sees only screens somebody froze, and the replay sees only the
// one path it walks.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type CapabilityArtifact,
  type CapabilityContract,
  type CapabilityOverlay,
  type CorpusEntry,
  type Digest,
  type Observation,
  PROVER_VERSION,
  type PromotionReview,
  type ProofResult,
  type TenantId,
  corpusDigestOf,
  digestOf,
  link,
  parsePromotionReview,
  promotionReviewDigestOf,
  proveDiscrimination,
  safeParseJournalEvent,
  safeParseObservation,
  sealArtifact,
  sealContract,
} from "@crr/core";
import { MOCK_SURFACE_CAPABILITIES } from "@crr/core";

// ---------------------------------------------------------------------------------------------
// The corpus, assembled off disk
// ---------------------------------------------------------------------------------------------

/**
 * One evidence bundle: a run journal beside a directory of frozen observations.
 *
 * `evidence/replay-02-outcome-member-not-found/` is exactly this shape and so is anything
 * `--evidence` and `--journal` wrote together, which is why the promotion tool takes a DIRECTORY
 * rather than a list of files. The journal is not optional and that is the point: it is where the
 * step, the phase and the tenant of every capture come from, and none of those are the reviewer's
 * to assert.
 */
export interface CorpusBundle {
  readonly dir: string;
  readonly entries: readonly CorpusEntry[];
  /** Every observation the bundle holds, by content address, so a positive named by digest can be
   *  found without trusting the filename. */
  readonly byDigest: ReadonlyMap<string, CorpusEntry>;
  readonly problems: readonly string[];
}

interface CaptureLine {
  readonly ref: string;
  readonly stepId: string;
  readonly phase: "pre" | "post";
  readonly kind: string;
}

/**
 * Read one bundle: the journal first, then the observations it names.
 *
 * THE JOURNAL IS READ FIRST AND IT IS THE AUTHORITY. An observation file on its own is a screen
 * with no provenance - nothing in the bytes says which step produced it, in which phase, at which
 * tenant, or how the run ended. Those four facts decide whether a screen is the mandatory
 * happy-path negative, an abnormal sibling, or the positive itself, and a reviewer who could supply
 * them could aim a proof at whatever answer they wanted. So a blob the journal does not name is
 * REPORTED AND DROPPED rather than admitted with assumed metadata.
 */
export function readCorpusBundle(dir: string): CorpusBundle {
  const problems: string[] = [];
  const captures = new Map<string, CaptureLine>();
  let tenantId: string | null = null;
  let runStatus: CorpusEntry["runStatus"] | null = null;

  let journalLines: readonly string[];
  try {
    journalLines = readFileSync(join(dir, "journal.jsonl"), "utf8").split("\n");
  } catch {
    return {
      dir,
      entries: [],
      byDigest: new Map(),
      problems: [
        `${dir} holds no journal.jsonl, so nothing there can be dated, stepped or attributed; a screen with no provenance is not corpus`,
      ],
    };
  }

  for (const line of journalLines) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      problems.push(`${dir}: a journal line is not JSON and was skipped`);
      continue;
    }
    const event = safeParseJournalEvent(parsed);
    if (!event.success) continue;
    // Narrowed by hand rather than by the discriminant. `JournalEvent` is `DeepReadonly`'d, which
    // widens every `z.literal` type back to `string` and so takes the union's discrimination with
    // it; a cast here is honest about that, and every field it names has already been through the
    // schema on the line above.
    const value = event.data as unknown as {
      readonly type: string;
      readonly tenantId?: string;
      readonly status?: CorpusEntry["runStatus"];
      readonly ref?: string;
      readonly kind?: string;
      readonly stepId?: string;
      readonly phase?: "pre" | "post";
    };
    if (value.type === "run.started" && value.tenantId !== undefined) tenantId = value.tenantId;
    if (value.type === "run.finished" && value.status !== undefined) runStatus = value.status;
    if (
      value.type === "evidence.captured" &&
      value.kind === "observation" &&
      value.ref !== undefined &&
      value.stepId !== undefined &&
      value.phase !== undefined
    ) {
      captures.set(value.ref, {
        ref: value.ref,
        stepId: value.stepId,
        phase: value.phase,
        kind: value.kind,
      });
    }
  }

  if (tenantId === null)
    problems.push(`${dir}: the journal never says which tenant this run was at`);
  if (runStatus === null) problems.push(`${dir}: the journal never says how this run ended`);

  const entries: CorpusEntry[] = [];
  const byDigest = new Map<string, CorpusEntry>();
  const observationsDir = join(dir, "observations");
  let files: readonly string[];
  try {
    files = readdirSync(observationsDir);
  } catch {
    files = [];
  }
  for (const file of files) {
    if (!file.startsWith("obs-") || !file.endsWith(".json")) continue;
    const ref = `obs:${basename(file, ".json").slice("obs-".length)}`;
    const capture = captures.get(ref);
    if (capture === undefined) {
      problems.push(
        `${dir}: ${file} is on disk and the journal never recorded capturing it; a screen with no journal line has no step, no phase and no run, so it is not admitted`,
      );
      continue;
    }
    const parsed = safeParseObservation(
      JSON.parse(readFileSync(join(observationsDir, file), "utf8")),
    );
    if (!parsed.success) {
      problems.push(`${dir}: ${file} does not parse as an Observation`);
      continue;
    }
    const observation = parsed.data as Observation;
    // RE-DERIVED, NEVER BELIEVED. The filename claims a content address; this is the address the
    // bytes actually have. They disagree exactly when somebody edited a frozen screen, which is the
    // one edit the whole corpus rests on nobody having made.
    const digest = digestOf(observation);
    if (`obs:${digest.slice("sha256:".length)}` !== ref) {
      problems.push(
        `${dir}: ${file} hashes to ${digest} and is filed under ${ref}; a frozen observation that does not hash to its own name has been edited`,
      );
      continue;
    }
    const entry: CorpusEntry = {
      observation,
      atStep: capture.stepId as CorpusEntry["atStep"],
      phase: capture.phase,
      runStatus: runStatus ?? "failed",
      tenantId: (tenantId ?? "unknown") as TenantId,
    };
    entries.push(entry);
    byDigest.set(digest, entry);
  }

  return { dir, entries, byDigest, problems };
}

/** Several bundles as one corpus. Deduplicated by content address, because two runs that hit the
 *  same screen wrote one file twice and counting it twice would inflate a number an approver reads. */
export function readCorpus(dirs: readonly string[]): CorpusBundle {
  const entries: CorpusEntry[] = [];
  const byDigest = new Map<string, CorpusEntry>();
  const problems: string[] = [];
  for (const dir of dirs) {
    const bundle = readCorpusBundle(dir);
    problems.push(...bundle.problems);
    for (const [digest, entry] of bundle.byDigest) {
      if (byDigest.has(digest)) continue;
      byDigest.set(digest, entry);
      entries.push(entry);
    }
  }
  return { dir: dirs.join(", "), entries, byDigest, problems };
}

// ---------------------------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------------------------

export interface PromoteOptions {
  readonly contract: CapabilityContract;
  readonly artifact: CapabilityArtifact;
  /** The review document, as read off disk. Parsed here so a malformed one is a report and not a
   *  stack trace. */
  readonly review: unknown;
  /** Directories written by `crr probe --capture-every`, or any `--evidence`/`--journal` pair. */
  readonly corpusDirs: readonly string[];
  /**
   * The tenants this promotion is being made for, each with the overlay that tenant runs.
   *
   * A PROMOTION IS TENANT-SCOPED and the proof runs once per pair. A detector uses a `token`
   * matcher, a token resolves through `flow.vocabulary`, and an overlay overrides that per tenant -
   * so `not-found-banner` is different text at Riverbend and Summit, and a proof at one says
   * nothing about the other. The operational cost is real and named: onboarding a new tenant to a
   * capability with a promoted outcome now needs a probe and a re-proof there, rather than being a
   * pure overlay change.
   */
  readonly tenants: readonly {
    readonly tenantId: string;
    readonly overlay?: CapabilityOverlay | null;
  }[];
  /** The arguments the probe ran with, so a `template` matcher resolves its holes the way it will
   *  at runtime. Absent means no bindings, under which an unresolved hole makes the detector FALSE -
   *  fail-closed, and visible as `does-not-fire` rather than as a silent pass. */
  readonly args?: Readonly<Record<string, unknown>>;
  /** Where the review document is archived, keyed by its own digest. Omitted by `--dry-run`. */
  readonly archiveDir?: string | null;
}

export interface TenantProof {
  readonly tenantId: string;
  readonly proof: ProofResult;
}

/**
 * What a promotion attempt produced. `documents` is non-null on EXACTLY the runs that passed every
 * gate, so there is no state in which a caller holds a half-promoted pair.
 */
export interface PromotionReport {
  readonly ok: boolean;
  readonly code: string;
  readonly atStep: string;
  readonly reviewDigest: Digest | null;
  readonly proofs: readonly TenantProof[];
  readonly corpus: { readonly dirs: readonly string[]; readonly observations: number };
  readonly problems: readonly string[];
  readonly documents: {
    readonly contract: CapabilityContract;
    readonly artifact: CapabilityArtifact;
    readonly archivedAt: string | null;
  } | null;
}

/** Every step of a promotion, in the order it happened, for a journal or a console. */
export type PromotionEvent =
  | {
      readonly step: "review-read";
      readonly reviewDigest: Digest;
      readonly reviewedBy: string;
      readonly code: string;
      readonly atStep: string;
    }
  | {
      readonly step: "corpus-read";
      readonly dirs: readonly string[];
      readonly observations: number;
      readonly problems: number;
    }
  | {
      readonly step: "positive-bound";
      readonly observation: Digest;
      readonly atStep: string;
      readonly journalStep: string;
    }
  | {
      readonly step: "proved";
      readonly tenantId: string;
      readonly verdict: ProofResult["verdict"];
      readonly reason: string;
    }
  | { readonly step: "refused"; readonly why: string }
  | {
      readonly step: "emitted";
      readonly contractVersion: string;
      readonly artifactVersion: number;
      readonly artifactDigest: Digest;
    }
  | { readonly step: "archived"; readonly path: string };

export interface PromoteHooks {
  readonly onEvent?: (event: PromotionEvent) => void;
}

/**
 * Run the proof and, only if it returns `discriminates` at every named tenant, emit the revision.
 *
 * A refusal WRITES NOTHING. That is the same shape `verifyAndDraft` has, and for the same reason:
 * the failure case leaves the previous documents exactly where they were, and the report carries the
 * reason for a human to read. `--dry-run` is not a different code path, it is this function with no
 * `archiveDir` and the caller declining to write what it returned - which is why iterating on a
 * detector costs no session and no document.
 */
export function promote(options: PromoteOptions, hooks: PromoteHooks = {}): PromotionReport {
  const emit = hooks.onEvent ?? (() => undefined);
  const problems: string[] = [];
  const refuse = (report: Omit<PromotionReport, "ok" | "documents">): PromotionReport => {
    for (const why of report.problems) emit({ step: "refused", why });
    return { ...report, ok: false, documents: null };
  };

  let review: PromotionReview;
  try {
    review = parsePromotionReview(options.review);
  } catch (error) {
    return refuse({
      code: "?",
      atStep: "?",
      reviewDigest: null,
      proofs: [],
      corpus: { dirs: options.corpusDirs, observations: 0 },
      problems: [`the review document does not parse: ${(error as Error).message}`],
    });
  }

  const reviewDigest = promotionReviewDigestOf(options.review);
  const code = review.outcome.code;
  const atStep = review.detector.atStep;
  emit({ step: "review-read", reviewDigest, reviewedBy: review.reviewedBy, code, atStep });

  const bail = (extra: readonly string[]): PromotionReport =>
    refuse({
      code,
      atStep,
      reviewDigest,
      proofs: [],
      corpus: { dirs: options.corpusDirs, observations: 0 },
      problems: [...problems, ...extra],
    });

  // ---- the review is against THIS artifact ---------------------------------------------------
  //
  // By content address, not by name. A review written against one program and applied to another is
  // the single most damaging clerical error available here: every string in it would still look
  // right, and the detector would be scoped to a step that means something else.
  if (review.promotes.artifactDigest !== options.artifact.digest) {
    problems.push(
      `the review promotes artifact ${review.promotes.artifactDigest} and this one is ${options.artifact.digest}`,
    );
  }
  if (review.promotes.capability !== options.contract.name) {
    problems.push(
      `the review promotes ${review.promotes.capability} and this contract is ${options.contract.name}`,
    );
  }
  if (review.promotes.contractVersion !== options.contract.version) {
    problems.push(
      `the review promotes contract ${review.promotes.contractVersion} and this one is ${options.contract.version}`,
    );
  }
  if (options.artifact.lifecycle.status !== "draft") {
    problems.push(
      `only a verified draft can be promoted, and this artifact is ${options.artifact.lifecycle.status}; a program that has never replayed itself has nothing for a detector to be added to`,
    );
  }
  if (options.contract.outcomes.some((o) => o.code === code)) {
    problems.push(`the contract already declares ${code}`);
  }
  const target = options.artifact.flow.steps.find((s) => s.id === atStep);
  if (target === undefined) {
    problems.push(`the detector is declared at step ${atStep}, which this flow does not contain`);
  } else if (target.outcomes.some((r) => r.code === code)) {
    problems.push(`step ${atStep} already detects ${code}`);
  }
  if (options.tenants.length === 0) {
    problems.push("a promotion is tenant-scoped and no tenant was named");
  }
  if (problems.length > 0) return bail([]);

  // ---- the corpus ----------------------------------------------------------------------------
  const corpus = readCorpus(options.corpusDirs);
  problems.push(...corpus.problems);
  emit({
    step: "corpus-read",
    dirs: options.corpusDirs,
    observations: corpus.entries.length,
    problems: corpus.problems.length,
  });

  // ---- the positives are BOUND TO A STEP BY THE JOURNAL, not by the review --------------------
  //
  // This is the control the design's section 6.3 attributes to the proof and the proof does not
  // actually provide. A mis-scoped detector whose positive is relabelled to follow it proves
  // perfectly well - measured, in `packages/core/test/promotion.test.ts` - because the predicate
  // really does fire on that screen and really is silent on the green one. What is wrong is the
  // LABEL, and the label is a fact the RUN recorded. So it is read from the journal here and the
  // review document's claim is checked against it, never trusted.
  const positives: CorpusEntry[] = [];
  for (const named of review.evidence.positives) {
    const entry = corpus.byDigest.get(named.observation);
    if (entry === undefined) {
      problems.push(
        `the review names positive ${named.observation} and no bundle in the corpus holds an observation with that content address; a positive that is not on disk cannot be re-derived, and a hand-written one is refused`,
      );
      continue;
    }
    if (entry.atStep !== atStep) {
      problems.push(
        `the review says positive ${named.observation} was captured at step ${named.atStep}, and the run journal says ${entry.atStep}; the step a screen was captured at is not the reviewer's to assert`,
      );
      continue;
    }
    if (entry.tenantId !== named.tenantId) {
      problems.push(
        `the review says positive ${named.observation} came from tenant ${named.tenantId} and the run journal says ${entry.tenantId}`,
      );
      continue;
    }
    emit({
      step: "positive-bound",
      observation: named.observation,
      atStep: named.atStep,
      journalStep: entry.atStep,
    });
    positives.push(entry);
  }
  if (problems.length > 0) {
    return refuse({
      code,
      atStep,
      reviewDigest,
      proofs: [],
      corpus: { dirs: options.corpusDirs, observations: corpus.entries.length },
      problems,
    });
  }

  const positiveDigests = new Set(positives.map((p) => digestOf(p.observation)));
  const negatives = corpus.entries.filter((e) => !positiveDigests.has(digestOf(e.observation)));

  // ---- the proof, once per (tenant, overlay) pair ---------------------------------------------
  const proofs: TenantProof[] = [];
  const provenAt: string[] = [];
  for (const tenant of options.tenants) {
    const linked = link({
      contract: options.contract,
      artifact: options.artifact,
      overlay: tenant.overlay ?? null,
      capabilities: MOCK_SURFACE_CAPABILITIES,
      args: options.args ?? {},
      // `discovery`, because v1 is a draft nobody has approved and the point of this link is to get
      // the MERGED vocabulary for this tenant rather than to authorize a run. No surface is touched.
      mode: "discovery",
      tenant: tenant.tenantId,
    });
    if (!linked.ok) {
      problems.push(
        `the program does not link at ${tenant.tenantId}, so there is no merged vocabulary to prove against: ${linked.errors.map((e) => `check ${e.check} ${e.code}`).join(", ")}`,
      );
      continue;
    }
    // The vocabulary the promotion ADDS has to be in the facts the proof runs against, or a token
    // the reviewer just declared would resolve to nothing and the detector would be false for a
    // reason that has nothing to do with the screen.
    const facts = {
      ...linked.program.facts,
      vocabulary: { ...linked.program.facts.vocabulary, ...review.vocabulary },
    };
    const proof = proveDiscrimination({
      detect: review.detector.detect,
      atStep,
      tenant: tenant.tenantId as TenantId,
      positives,
      negatives,
      facts,
      bindings: linked.program.bindings,
    });
    proofs.push({ tenantId: tenant.tenantId, proof });
    emit({
      step: "proved",
      tenantId: tenant.tenantId,
      verdict: proof.verdict,
      reason: proof.reason,
    });
    if (proof.verdict === "discriminates") provenAt.push(tenant.tenantId);
    else problems.push(`${tenant.tenantId}: ${proof.verdict} - ${proof.reason}`);
  }

  const report = {
    code,
    atStep,
    reviewDigest,
    proofs,
    corpus: { dirs: options.corpusDirs, observations: corpus.entries.length },
    problems,
  };
  if (problems.length > 0 || provenAt.length !== options.tenants.length) return refuse(report);

  // ---- emit ------------------------------------------------------------------------------------
  const first = proofs[0] as TenantProof;
  const nextContract = sealContract({
    ...options.contract,
    // MAJOR. An exhaustive switch that compiled yesterday does not compile tomorrow.
    version: bumpMajor(options.contract.version),
    outcomes: [
      ...options.contract.outcomes,
      { ...stripReviewOnly(review), origin: "reviewer-authored" },
    ],
  });

  const nextArtifact = sealArtifact({
    ...options.artifact,
    version: options.artifact.version + 1,
    implements: {
      ...options.artifact.implements,
      version: nextContract.version,
      contractDigest: nextContract.digest,
    },
    lifecycle: { status: "proposed", supersedes: options.artifact.version, approval: null },
    flow: {
      ...options.artifact.flow,
      vocabulary: { ...options.artifact.flow.vocabulary, ...review.vocabulary },
      steps: options.artifact.flow.steps.map((step) =>
        step.id !== atStep
          ? step
          : {
              ...step,
              outcomes: [
                ...step.outcomes,
                {
                  code,
                  detect: review.detector.detect,
                  priority: review.detector.priority,
                  phase: review.detector.phase,
                  requiresSettled: review.detector.requiresSettled,
                  capture: review.detector.capture,
                  origin: "reviewer-authored",
                },
              ],
            },
      ),
    },
    // `verification` is reset to the PLAN rather than carried over. v2 is a different program and
    // v1's verification was of v1; keeping the stamp would let a promoted artifact inherit a grade
    // no replay of it ever earned, which is the one thing this lifecycle exists to make impossible.
    verification: { ...options.artifact.verification, status: "unverified" },
    promotions: [
      ...options.artifact.promotions,
      {
        code,
        atStep,
        reviewDigest,
        reviewedBy: review.reviewedBy,
        supersedesArtifactVersion: options.artifact.version,
        proof: {
          verdict: "discriminates",
          proverVersion: PROVER_VERSION,
          positives: positives.map((p) => ({ observation: digestOf(p.observation), atStep })),
          negatives: {
            corpusDigest: corpusDigestOf(negatives),
            ...first.proof.negatives,
          },
          provenAt,
        },
        // V3 of the design's section 3.3 is EVIDENCE AND NEVER A GATE, so it starts false and is
        // stamped by `crr promote --confirm` after the condition has been re-run against v2. It
        // cannot be a gate because `gradeVerification` deliberately refuses to grade a run that
        // returned an outcome, and because our fixture can produce a condition on cue while a real
        // core banking system cannot.
        probeConfirmed: false,
      },
    ],
    signatures: [],
  });

  emit({
    step: "emitted",
    contractVersion: nextContract.version,
    artifactVersion: nextArtifact.version,
    artifactDigest: nextArtifact.digest,
  });

  let archivedAt: string | null = null;
  if (options.archiveDir != null) {
    mkdirSync(options.archiveDir, { recursive: true });
    archivedAt = join(options.archiveDir, `${reviewDigest.replace(":", "-")}.json`);
    writeFileSync(archivedAt, `${JSON.stringify(options.review, null, 2)}\n`);
    emit({ step: "archived", path: archivedAt });
  }

  return {
    ...report,
    ok: true,
    documents: { contract: nextContract, artifact: nextArtifact, archivedAt },
  };
}

/**
 * Stamp `probeConfirmed` on a receipt after the condition was re-run against this revision.
 *
 * EVIDENCE, NOT A GATE, and the asymmetry is the honest operational cost of the whole design rather
 * than a gap in it: our fixture can be made to produce `not-found` on cue and a real core banking
 * system cannot be made to produce every condition on demand. So a promotion can ship whose detector
 * has never fired in a live session, `probeConfirmed` stays `false`, and `crr approve` PRINTS that
 * rather than hiding it.
 */
export function confirmProbe(
  artifact: CapabilityArtifact,
  code: string,
  result: { readonly status: string; readonly outcome?: unknown; readonly run?: unknown },
): { readonly artifact: CapabilityArtifact | null; readonly reason: string } {
  const receipt = artifact.promotions.find((p) => p.code === code);
  if (receipt === undefined) {
    return { artifact: null, reason: `this artifact carries no promotion receipt for ${code}` };
  }
  if (result.status !== "outcome" || result.outcome !== code) {
    return {
      artifact: null,
      reason: `the probe returned ${result.status}${result.status === "outcome" ? ` (${String(result.outcome)})` : ""} and the receipt would be claiming it returned ${code}`,
    };
  }
  if (artifact.lifecycle.approval !== null) {
    return {
      artifact: null,
      reason:
        "stamping a receipt changes the digest this artifact's approval signs, which is the same thing as revoking the approval; confirm before approving",
    };
  }
  return {
    artifact: sealArtifact({
      ...artifact,
      promotions: artifact.promotions.map((p) =>
        p.code === code ? { ...p, probeConfirmed: true } : p,
      ),
    }),
    reason: `the probe returned ${code} at ${artifact.promotions.find((p) => p.code === code)?.atStep}`,
  };
}

// ---------------------------------------------------------------------------------------------

function bumpMajor(version: string): string {
  const major = Number.parseInt(version.split(".")[0] ?? "1", 10);
  return `${major + 1}.0.0`;
}

/** The review's outcome minus the field that stays on the review: `stableUnderRetryBecause` is a
 *  rationale for a taxonomy decision, and the contract is what a ROUTER reads. */
function stripReviewOnly(review: PromotionReview): Record<string, unknown> {
  const { stableUnderRetryBecause: _held, ...decl } = review.outcome;
  return decl as unknown as Record<string, unknown>;
}
