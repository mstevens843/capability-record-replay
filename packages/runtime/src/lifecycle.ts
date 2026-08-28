// The artifact lifecycle: `proposed -> verified(draft) -> approved`.
//
// BRIEF section 3.4 in one sentence: RECORDING IS NOT A CLAIM UNTIL IT REPLAYS. A discovery run
// ends with a document that describes what the model did; whether that description is FAITHFUL is a
// separate question, and the only honest way to answer it is to run the description with the model
// out of the loop and see whether the surface agrees. So an artifact leaves synthesis as `proposed`
// and can only become `draft` by carrying a `Verification` record that a real replay produced
// (`verify.ts`), and can only become `approved` by carrying a signature over its own digest.
//
// Three properties are worth naming because they are what the states buy:
//
//   · A FAILED VERIFICATION PRODUCES NOTHING. There is no path here from a replay that did not
//     succeed to a `draft` document. The artifact simply stays `proposed`, which is a state the
//     policy chokepoint refuses to run (rule 7) and the linker refuses to link for replay
//     (check 27). Nothing has to remember to delete it.
//   · THE APPROVER SIGNS THE VERIFICATION, not just the program. `verification` is inside the
//     digest (only `digest`, `signatures` and `lifecycle` are excluded), so the signature covers
//     "this program, verified in this mode, to this grade". An approver cannot be shown a `full`
//     grade and have a `partial-up-to-irreversible` one substituted afterwards.
//   · AN EDITED APPROVED ARTIFACT CANNOT BE RUN. Editing any field of the program changes the
//     digest, and there are exactly three ways that can go, all of which stop: leave `digest`
//     alone and linker check 2 refuses the document; recompute `digest` and the schema refuses it
//     because `lifecycle.approval.over` no longer matches; recompute both and the signature no
//     longer verifies over the new digest (check 27). `checkArtifactIntegrity` below reports all
//     three in one pass for a reader who has just picked a file up off disk.
//
// What this file does NOT do is key custody, and that is deliberate rather than unfinished. See
// `ApprovalSigner` in `approval.ts`, OPEN-QUESTIONS-RESOLVED Q5, and REPORT section 6.

import {
  type ApprovalTrust,
  type CapabilityArtifact,
  type EffectClass,
  type Timestamp,
  type Verification,
  artifactDigestIsIntact,
  artifactDigestOf,
  approveArtifact as attachApproval,
  safeParseArtifact,
  sealArtifact,
} from "@crr/core";
import type { ApprovalSigner } from "./approval.js";

/**
 * A refused lifecycle transition.
 *
 * A class rather than a result union because every one of these is a programming or process error -
 * approving an unverified artifact, signing a document whose bytes do not match its digest - and
 * none of them is a condition a caller should be handling in a `switch`. `reasons` is a list
 * because an approval can be wrong in several ways at once and telling the approver one of them at
 * a time is how a review becomes four round trips.
 */
export class LifecycleError extends Error {
  readonly reasons: readonly string[];

  constructor(what: string, reasons: readonly string[]) {
    super(`${what}: ${reasons.join("; ")}`);
    this.name = "LifecycleError";
    this.reasons = reasons;
  }
}

// ---------------------------------------------------------------------------------------------
// proposed -> verified(draft)
// ---------------------------------------------------------------------------------------------

/**
 * Stamp a verification onto a proposed artifact and promote it to `draft`.
 *
 * The digest changes here, and that is the point rather than an inconvenience: the verification
 * record is part of the program's identity, so `mock-member-find@1` before verification and
 * `mock-member-find@1` after it are two different content addresses and an approval over one is not
 * an approval over the other.
 *
 * `verification.status` must be `verified`. There is deliberately no "record that it failed" path -
 * a failed verification leaves the proposed document exactly where it was, and `VerificationReport`
 * carries the reason for a human to read.
 */
export function recordVerification(
  artifact: CapabilityArtifact,
  verification: Verification,
): CapabilityArtifact {
  const reasons: string[] = [];
  if (artifact.lifecycle.status === "approved") {
    reasons.push(
      "re-verifying an approved artifact would change the digest its approval signs, which is the same thing as revoking the approval; verify the next version instead",
    );
  } else if (artifact.lifecycle.status !== "proposed" && artifact.lifecycle.status !== "draft") {
    reasons.push(
      `only a proposed or draft artifact can take a verification, and this one is ${artifact.lifecycle.status}`,
    );
  }
  if (verification.status !== "verified") {
    reasons.push(
      "a replay that did not succeed does not produce a draft; the artifact stays proposed",
    );
  }
  if (artifact.signatures.length > 0) {
    reasons.push(
      "this artifact carries attestations over its current digest, and stamping a verification changes that digest; re-sign after verifying",
    );
  }
  if (reasons.length > 0) throw new LifecycleError("this artifact cannot be verified", reasons);

  return sealArtifact({
    ...artifact,
    lifecycle: { status: "draft", supersedes: artifact.lifecycle.supersedes, approval: null },
    verification,
  });
}

// ---------------------------------------------------------------------------------------------
// draft -> approved
// ---------------------------------------------------------------------------------------------

export interface ApproveOptions {
  readonly signer: ApprovalSigner;
  /** An identity handle, not a mailbox. "Who approved this" is an audit answer the identity system
   *  resolves; a personal address in a signed, widely-copied document is data it does not need. */
  readonly approvedBy: string;
  readonly approvedAt: Timestamp;
  /**
   * The grade the approver READ AND TICKED (SPEC section 6.6).
   *
   * Passed in rather than copied from the artifact on purpose. If this function read the grade off
   * the document, the tick would be a formality and `partial-up-to-irreversible` would be flattened
   * back into a boolean `verified` - which is precisely the risk SPEC section 12.3's twelfth
   * accepted limit is about. A mismatch is refused, so the approver has to have looked.
   */
  readonly acknowledgedGrade: Verification["grade"];
  /** Same argument, for the blast radius: the approver ticks the effect classes they are agreeing
   *  to, and the artifact's own maximum has to be among them. */
  readonly acknowledgedEffects: readonly EffectClass[];
}

/**
 * Sign the digest, and nothing else.
 *
 * WHAT IS SIGNED IS THE DIGEST STRING, not the document bytes. Two consequences follow, and both
 * are the reason it is done this way. A signature over bytes would be invalidated by re-indenting
 * the file; a signature over the digest survives any reformatting and fails on any change to the
 * program, because the digest is over the JCS canonicalization. And the digest excludes
 * `lifecycle`, so attaching this approval does not change the value it signs - a signature over the
 * whole document would be chasing its own tail.
 *
 * The integrity of the digest is RE-DERIVED here before signing. Signing a `digest` field that
 * nobody recomputed is signing somebody else's claim about the document rather than the document.
 */
export function approve(artifact: CapabilityArtifact, options: ApproveOptions): CapabilityArtifact {
  const reasons: string[] = [];
  if (artifact.lifecycle.status !== "draft") {
    reasons.push(
      artifact.lifecycle.status === "proposed"
        ? "this artifact has never replayed itself with the model out of the loop, so there is nothing to approve yet"
        : `only a draft can be approved, and this one is ${artifact.lifecycle.status}`,
    );
  }
  if (artifact.verification.status !== "verified") {
    reasons.push("the artifact carries no successful verification replay");
  }
  if (!artifactDigestIsIntact(artifact)) {
    reasons.push(
      `the document does not hash to the digest it carries (${artifact.digest} vs ${artifactDigestOf(artifact)}); it has been edited since it was sealed`,
    );
  }
  if (options.acknowledgedGrade !== artifact.verification.grade) {
    reasons.push(
      `the approver ticked grade "${options.acknowledgedGrade}" and this artifact was verified to "${artifact.verification.grade}" by a ${artifact.verification.mode} covering through step ${artifact.verification.coveredThroughStep}`,
    );
  }
  if (!options.acknowledgedEffects.includes(artifact.effects.maxEffect)) {
    reasons.push(
      `the approver did not tick this artifact's maximum effect (${artifact.effects.maxEffect})`,
    );
  }
  if (options.signer.alg !== "ed25519") {
    reasons.push(`the approval algorithm is ed25519 and the signer offered ${options.signer.alg}`);
  }
  if (reasons.length > 0) throw new LifecycleError("this artifact cannot be approved", reasons);

  return attachApproval(artifact, {
    approvedBy: options.approvedBy,
    approvedAt: options.approvedAt,
    signature: options.signer.sign(artifact.digest),
    keyId: options.signer.keyId,
    alg: "ed25519",
    acknowledgedEffects: [...options.acknowledgedEffects],
    acknowledgedGrade: options.acknowledgedGrade,
  });
}

// ---------------------------------------------------------------------------------------------
// What a reader checks before trusting a file
// ---------------------------------------------------------------------------------------------

export interface IntegrityReport {
  readonly ok: boolean;
  /** What the document claims its address is, or `null` if it is not even shaped like an artifact. */
  readonly claimedDigest: string | null;
  /** What its bytes actually hash to. */
  readonly computedDigest: string | null;
  readonly problems: readonly string[];
}

/**
 * The three ways an edited approved artifact gives itself away, reported in one pass.
 *
 * Takes an `unknown` deliberately: integrity is what you check BEFORE you trust something you just
 * read off disk, and a signature `CapabilityArtifact -> boolean` would only ever run on documents
 * that had already been accepted. `link` performs the same checks in its own numbered vocabulary
 * (2 and 27) at the moment they matter; this exists so `crr show`, an evidence bundle and a human
 * at 2am can ask the question without linking a program against a surface.
 *
 * `trust` may be `null`, in which case the signature is REPORTED AS UNVERIFIABLE rather than
 * assumed good. An unverifiable approval is not an approval.
 */
export function checkArtifactIntegrity(
  document: unknown,
  trust: ApprovalTrust | null,
): IntegrityReport {
  const parsed = safeParseArtifact(document);
  if (!parsed.success) {
    const record = document as { readonly digest?: unknown };
    return {
      ok: false,
      claimedDigest: typeof record?.digest === "string" ? record.digest : null,
      computedDigest: null,
      problems: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }

  const artifact = parsed.data;
  const computed = artifactDigestOf(artifact);
  const problems: string[] = [];
  if (artifact.digest !== computed) {
    problems.push(
      `the document hashes to ${computed} and claims ${artifact.digest}; it has been edited since it was sealed`,
    );
  }

  const approval = artifact.lifecycle.approval;
  if (artifact.lifecycle.status === "approved" && approval !== null) {
    if (approval.over !== artifact.digest) {
      problems.push("the approval signs a digest other than this document's own");
    } else if (trust === null) {
      problems.push("no trust store was supplied, so the approval signature could not be verified");
    } else if (!trust.trustedKeyIds.includes(approval.keyId)) {
      problems.push(`the approval was signed by key ${approval.keyId}, which is not trusted here`);
    } else if (
      !trust.verifySignature({
        over: approval.over,
        keyId: approval.keyId,
        alg: approval.alg,
        signature: approval.signature,
      })
    ) {
      problems.push("the approval signature does not verify over this artifact's digest");
    }
  }

  return {
    ok: problems.length === 0,
    claimedDigest: artifact.digest,
    computedDigest: computed,
    problems,
  };
}
