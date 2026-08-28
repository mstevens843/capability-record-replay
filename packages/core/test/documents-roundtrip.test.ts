// The acceptance test SPEC section 11 asks unit 2 for: a hand-written example of each document,
// parsed back.
//
// "Round-trip" is asserted against the CANONICAL FORM rather than by deep equality, and the
// difference matters. A validator that quietly filled in a default, coerced a number, or dropped an
// unknown key would still pass a shape check while producing a document whose digest is not the
// digest of the file on disk - and an approval signature is taken over that digest. So the property
// being tested is: parsing is the identity on a valid document.

import { describe, expect, it } from "vitest";
import {
  DIGEST_PATTERN,
  artifactDigestIsIntact,
  canonicalJson,
  contractDigestIsIntact,
  overlayDigestIsIntact,
  parseArtifact,
  parseContract,
  parseOverlay,
  piiShapeOf,
  safeParseArtifact,
  safeParseContract,
  safeParseOverlay,
} from "../src/index.js";
import {
  memberLookupArtifact,
  memberLookupContract,
  summitOverlay,
} from "./fixtures/member-lookup.js";

/** Every string in a document, so a canary test can look at what an author actually wrote. */
const authoredStrings = (value: unknown): readonly string[] => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(authoredStrings);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, v]) => [key, ...authoredStrings(v)]);
  }
  return [];
};

const roundTrips = (parse: (v: unknown) => unknown, document: unknown, label: string) => {
  const parsed = parse(structuredClone(document));
  expect(canonicalJson(parsed as never), `${label} must survive parsing unchanged`).toBe(
    canonicalJson(document as never),
  );
};

describe("the contract document", () => {
  it("parses", () => {
    const result = safeParseContract(memberLookupContract);
    expect(result.success ? null : JSON.stringify(result.error.issues, null, 2)).toBeNull();
  });

  it("round-trips through the validator without being altered", () => {
    roundTrips(parseContract, memberLookupContract, "the contract");
  });

  it("carries a digest over its own content", () => {
    expect(contractDigestIsIntact(memberLookupContract)).toBe(true);
  });

  it("cannot be given a detector", () => {
    // The single most important structural claim in section 0.4: detectors live on the artifact's
    // steps so that one contract can be implemented by a browser program and a green-screen
    // program. If an outcome declaration could carry a predicate, that would be a convention.
    const withDetector = structuredClone(memberLookupContract) as unknown as {
      outcomes: { detect?: unknown }[];
    };
    withDetector.outcomes[0]!.detect = { kind: "settled" };
    expect(safeParseContract(withDetector).success).toBe(false);
  });

  it("cannot be given a step id, a frame or a container path", () => {
    for (const surfaceLeak of [
      { atStep: "submit-search" },
      { frame: "content" },
      { scope: { path: [{ kind: "frame", name: "content" }] } },
    ]) {
      expect(safeParseContract({ ...memberLookupContract, ...surfaceLeak }).success).toBe(false);
    }
  });
});

describe("the artifact document", () => {
  it("parses", () => {
    const result = safeParseArtifact(memberLookupArtifact);
    expect(result.success ? null : JSON.stringify(result.error.issues, null, 2)).toBeNull();
  });

  it("round-trips through the validator without being altered", () => {
    roundTrips(parseArtifact, memberLookupArtifact, "the artifact");
  });

  it("carries a digest over the program, which the approval signs", () => {
    expect(artifactDigestIsIntact(memberLookupArtifact)).toBe(true);
    expect(memberLookupArtifact.lifecycle.approval?.over).toBe(memberLookupArtifact.digest);
  });

  it("refuses a silently edited approved artifact", () => {
    // The whole argument for content addressing: change one wait budget in an approved artifact and
    // the digest no longer matches the signature.
    const edited = structuredClone(memberLookupArtifact) as unknown as {
      flow: { steps: { settle: { maxWaitMs: number } }[] };
    };
    edited.flow.steps[0]!.settle.maxWaitMs = 9_000;
    expect(artifactDigestIsIntact(edited)).toBe(false);
  });

  it("holds no regulated data in any of its strings", () => {
    // The parameterization claim, tested rather than asserted, and tested with the same predicate
    // the validator uses. The discovery run drove this flow with a real member number; the goal
    // template, the detectors and the descriptors all came back holding a shape instead.
    //
    // Digests are exempt and only digests: 64 hex characters contain long digit runs by
    // construction, and a digest is computed, never authored.
    const offenders = authoredStrings(memberLookupArtifact)
      .filter((s) => !DIGEST_PATTERN.test(s))
      .map((s) => [s, piiShapeOf(s)] as const)
      .filter(([, shape]) => shape !== null);
    expect(offenders).toEqual([]);
    expect(canonicalJson(memberLookupArtifact as never)).toContain("{memberId}");
  });
});

describe("the overlay document", () => {
  it("parses", () => {
    const result = safeParseOverlay(summitOverlay);
    expect(result.success ? null : JSON.stringify(result.error.issues, null, 2)).toBeNull();
  });

  it("round-trips through the validator without being altered", () => {
    roundTrips(parseOverlay, summitOverlay, "the overlay");
  });

  it("carries a digest over its own content", () => {
    expect(overlayDigestIsIntact(summitOverlay)).toBe(true);
  });

  it("has nowhere to put an outcome, an instruction, a checkpoint or an effect class", () => {
    // Section 2.5's one sentence, enforced by the absence of a field rather than by a reviewer
    // noticing. A per-tenant file that can change what a capability MEANS is a supply-chain hole.
    for (const semanticChange of [
      { outcomes: [] },
      { addOutcomes: {} },
      { steps: { "submit-search": { instruction: { kind: "activate" } } } },
      { steps: { "submit-search": { expect: { predicate: { kind: "settled" } } } } },
      { steps: { "submit-search": { effect: "WRITE_IRREVERSIBLE" } } },
    ]) {
      expect(safeParseOverlay({ ...summitOverlay, ...semanticChange }).success).toBe(false);
    }
  });
});
