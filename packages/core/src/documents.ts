// The three documents, as a front door: parse, digest, and seal.
//
// This module exists so that nothing outside `@crr/core` has to know that a document's digest is
// computed over its own body with the self-referential fields removed. That rule is exactly the
// kind of thing two call sites implement slightly differently, and the consequence would be an
// approval signature that verifies in the recorder and not in the linker.

import type { z } from "zod";
import { type CapabilityArtifact, CapabilityArtifactSchema } from "./artifact.js";
import { type CapabilityContract, CapabilityContractSchema } from "./contract.js";
import { combineDigests, digestOf, documentDigest } from "./digest.js";
import { type JournalEvent, JournalEventSchema } from "./journal.js";
import { type Observation, ObservationSchema } from "./observation.js";
import { type CapabilityOverlay, CapabilityOverlaySchema } from "./overlay.js";
import type { Digest } from "./primitives.js";
import { type ReplayResultDocument, ReplayResultSchema } from "./result.js";

/**
 * A document as it is being written: a plain JSON object, with no digest yet.
 *
 * Deliberately not `Omit<CapabilityArtifact, "digest">`. The branded ids in these types are what a
 * PARSED document has; a draft has plain strings, and forcing an author to cast forty of them just
 * to reach the validator would make the cast the habit and the validation the afterthought. So the
 * seal functions take JSON and hand back a parsed document - the digest and the validation happen
 * together, and there is no way to obtain one of these types except by passing the schema.
 */
export type Draft = Readonly<Record<string, unknown>>;

// ---------------------------------------------------------------------------------------------
// Parsing
//
// `parse` throws and `safeParse` does not, matching zod's own convention rather than inventing a
// third. The throwing form is for a recorder writing a document it just built - where a failure is
// a bug in the recorder - and the safe form is for anything reading a file off disk, where a
// failure is data and belongs in a link report.
// ---------------------------------------------------------------------------------------------

export const parseContract = (value: unknown): CapabilityContract =>
  CapabilityContractSchema.parse(value) as CapabilityContract;
export const safeParseContract = (value: unknown): z.ZodSafeParseResult<CapabilityContract> =>
  CapabilityContractSchema.safeParse(value) as z.ZodSafeParseResult<CapabilityContract>;

export const parseArtifact = (value: unknown): CapabilityArtifact =>
  CapabilityArtifactSchema.parse(value) as CapabilityArtifact;
export const safeParseArtifact = (value: unknown): z.ZodSafeParseResult<CapabilityArtifact> =>
  CapabilityArtifactSchema.safeParse(value) as z.ZodSafeParseResult<CapabilityArtifact>;

export const parseOverlay = (value: unknown): CapabilityOverlay =>
  CapabilityOverlaySchema.parse(value) as CapabilityOverlay;
export const safeParseOverlay = (value: unknown): z.ZodSafeParseResult<CapabilityOverlay> =>
  CapabilityOverlaySchema.safeParse(value) as z.ZodSafeParseResult<CapabilityOverlay>;

export const parseObservation = (value: unknown): Observation =>
  ObservationSchema.parse(value) as Observation;
export const safeParseObservation = (value: unknown): z.ZodSafeParseResult<Observation> =>
  ObservationSchema.safeParse(value) as z.ZodSafeParseResult<Observation>;

export const parseJournalEvent = (value: unknown): JournalEvent =>
  JournalEventSchema.parse(value) as JournalEvent;
export const safeParseJournalEvent = (value: unknown): z.ZodSafeParseResult<JournalEvent> =>
  JournalEventSchema.safeParse(value) as z.ZodSafeParseResult<JournalEvent>;

export const parseReplayResult = (value: unknown): ReplayResultDocument =>
  ReplayResultSchema.parse(value) as ReplayResultDocument;
export const safeParseReplayResult = (value: unknown): z.ZodSafeParseResult<ReplayResultDocument> =>
  ReplayResultSchema.safeParse(value) as z.ZodSafeParseResult<ReplayResultDocument>;

// ---------------------------------------------------------------------------------------------
// Explaining a refusal
// ---------------------------------------------------------------------------------------------

export interface ValidationProblem {
  /** A dotted path into the document: `flow.steps.2.outcomes.0.detect.text`. */
  readonly path: string;
  readonly message: string;
}

interface UnionIssue {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly errors?: readonly (readonly UnionIssue[])[];
}

/**
 * Flatten a validation failure into the messages a person can act on.
 *
 * This exists because of one construct: `Predicate`. Three of its arms are keyed by the presence of
 * a field (`all`, `any`, `not`) rather than by a discriminant, so it has to be a plain union - and a
 * plain union reports "Invalid input" at the whole predicate and buries the real message, which in
 * this schema is frequently the one that says a detector was written with a member number in it.
 * That message is the entire point of the check; losing it to a union wrapper would make the most
 * reviewed construct in the artifact the one with the worst error.
 *
 * The heuristic is "the branch that got furthest": among a union's candidate parses, the one that
 * produced the fewest complaints, breaking ties by the deepest path. On a tagged shape that is
 * always the arm the author meant, because every other arm fails immediately on its own shape.
 */
export function explainIssues(issues: readonly UnionIssue[]): readonly ValidationProblem[] {
  const out: ValidationProblem[] = [];
  for (const issue of issues) {
    const branches = issue.code === "invalid_union" ? issue.errors : undefined;
    if (branches === undefined || branches.length === 0) {
      out.push({ path: issue.path.map(String).join("."), message: issue.message });
      continue;
    }
    let best = branches[0] as readonly UnionIssue[];
    for (const branch of branches) if (scoreBranch(branch) < scoreBranch(best)) best = branch;
    const prefix = issue.path.map(String).join(".");
    for (const problem of explainIssues(best)) {
      out.push({
        path: [prefix, problem.path].filter((p) => p.length > 0).join("."),
        message: problem.message,
      });
    }
  }
  return out;
}

function scoreBranch(branch: readonly UnionIssue[]): number {
  let deepest = 0;
  for (const issue of branch) if (issue.path.length > deepest) deepest = issue.path.length;
  // Fewer complaints first, then whichever got deeper into the shape.
  return branch.length * 100 - deepest;
}

/** `explainIssues` over a zod failure, as one string per problem. */
export const explainValidationError = (error: {
  readonly issues: readonly UnionIssue[];
}): readonly string[] =>
  explainIssues(error.issues).map((p) =>
    p.path.length > 0 ? `${p.path}: ${p.message}` : p.message,
  );

// ---------------------------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------------------------

export const contractDigestOf = (c: Draft): Digest => documentDigest(c);
export const overlayDigestOf = (o: Draft): Digest => documentDigest(o);

/**
 * An artifact's digest excludes `lifecycle` as well as `digest` and `signatures`, and that is a
 * deliberate tightening of the one-line rule in SPEC section 2.4.
 *
 * Two things force it, and both are the kind of problem that only appears when you try to write the
 * document down. An approval SIGNS the digest and then lives inside `lifecycle.approval`, so if
 * `lifecycle` contributed, attaching the approval would change the very value it signs. And
 * deprecating an artifact months later flips `lifecycle.status`, which would invalidate an approval
 * that is still perfectly valid - the program did not change.
 *
 * So the digest addresses THE PROGRAM: the target, the flow, the continuity values, the policy
 * requirements, the effect summary, the budgets and the provenance. `lifecycle` is mutable state
 * ABOUT that program. The schema then enforces `lifecycle.approval.over === digest`, which means
 * anyone who computes the digest a different way fails to parse rather than failing to verify a
 * signature six months later.
 */
export const ARTIFACT_DIGEST_EXCLUDED_FIELDS: readonly string[] = [
  "digest",
  "signatures",
  "lifecycle",
];

export function artifactDigestOf(a: Draft): Digest {
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(a)) {
    if (ARTIFACT_DIGEST_EXCLUDED_FIELDS.includes(key)) continue;
    stripped[key] = value;
  }
  return digestOf(stripped);
}

/**
 * Compute a draft's content address and validate it in one step.
 *
 * The two are not separable on purpose. A digest over a document nobody validated is a precise
 * address for something that may not be a capability at all, and it is exactly the kind of value
 * that then gets signed.
 */
export const sealContract = (c: Draft): CapabilityContract =>
  parseContract({ ...c, digest: contractDigestOf(c) });
export const sealOverlay = (o: Draft): CapabilityOverlay =>
  parseOverlay({ ...o, digest: overlayDigestOf(o) });
export const sealArtifact = (a: Draft): CapabilityArtifact =>
  parseArtifact({ ...a, digest: artifactDigestOf(a) });

/**
 * Attach an approval to a sealed artifact.
 *
 * This is a separate operation rather than a field an author fills in, because the ordering is the
 * whole mechanism: the approver signs a digest, so the digest has to exist first, and `over` is set
 * from the artifact rather than accepted from the caller. An approval that named a different digest
 * would be an approval of some other document, and the schema refuses it - but the API should not
 * make it easy to write in the first place.
 */
export function approveArtifact(
  artifact: CapabilityArtifact,
  approval: Omit<NonNullable<CapabilityArtifact["lifecycle"]["approval"]>, "over">,
): CapabilityArtifact {
  return parseArtifact({
    ...artifact,
    lifecycle: {
      ...artifact.lifecycle,
      status: "approved",
      approval: { ...approval, over: artifact.digest },
    },
  });
}

/**
 * SPEC section 10 check 2, per document kind, so no caller has to remember which fields are
 * excluded from which digest.
 *
 * These take a plain document rather than a parsed one deliberately: integrity is what you check
 * BEFORE you trust something you just read off disk, and requiring a parsed value first would have
 * the check run only on documents that had already been accepted.
 */
export const contractDigestIsIntact = (c: Draft): boolean => c.digest === contractDigestOf(c);
export const artifactDigestIsIntact = (a: Draft): boolean => a.digest === artifactDigestOf(a);
export const overlayDigestIsIntact = (o: Draft): boolean => o.digest === overlayDigestOf(o);

/**
 * `effectiveDigest = f(artifactDigest, overlayDigest, linkerVersion)`.
 *
 * The linker version is in there because base-plus-overlay is only half the answer to "which bytes
 * actually ran": the merge is deterministic, but it is deterministic *for a given merger*, and in a
 * regulated environment the postmortem question is about the whole of it.
 */
export const effectiveDigestOf = (
  artifactDigest: Digest,
  overlayDigest: Digest | null,
  linkerVersion: string,
): Digest => combineDigests([artifactDigest, overlayDigest, linkerVersion]);
