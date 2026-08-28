// Content addressing: the property an approval signature depends on.
//
// The claim being tested is narrow and load-bearing: two parties who agree about a document agree
// about its digest, and any edit to a document changes it. Everything in SPEC section 3.9 - "an
// approved artifact cannot be silently edited" - is that claim plus a signature over the result.
//
// The fixed digests below were produced by an independent implementation over the exact canonical
// bytes, so this file pins the composition of the canonicalizer and the hash, not just the hash:
//   python3 -c 'open("d.bin","wb").write(b"{}")' && shasum -a 256 d.bin

import { describe, expect, it } from "vitest";
import {
  DIGEST_PREFIX,
  combineDigests,
  digestOf,
  documentDigest,
  documentDigestMatches,
  isDigest,
} from "../src/digest.js";

describe("digestOf", () => {
  it("matches digests computed by an independent implementation over the canonical bytes", () => {
    expect(digestOf({})).toBe(
      "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    );
    expect(digestOf([])).toBe(
      "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    );
    expect(digestOf({ a: 1 })).toBe(
      "sha256:015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
    );
    expect(digestOf(null)).toBe(
      "sha256:74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b",
    );
  });

  it("is insensitive to property order, which is the whole point", () => {
    // The same document written by two tools, or round-tripped through one, must sign the same.
    expect(digestOf({ amount: "1234.56", currency: "USD" })).toBe(
      digestOf({ currency: "USD", amount: "1234.56" }),
    );
    expect(digestOf({ currency: "USD", amount: "1234.56" })).toBe(
      "sha256:07227fae37188b1d3487cd760d5c0f08787037ee9bc5739e7b89578a15893c6c",
    );
  });

  it("is sensitive to every edit that changes meaning", () => {
    const base = { id: "search", waitMs: 15000, outcomes: ["MEMBER_NOT_FOUND"] };
    const variants = [
      { ...base, id: "search " },
      { ...base, waitMs: 15001 },
      { ...base, waitMs: "15000" },
      { ...base, outcomes: ["MEMBER_NOT_FOUND", "MEMBER_RESTRICTED"] },
      { ...base, outcomes: [] },
      { ...base, extra: null },
    ];
    for (const v of variants) expect(digestOf(v)).not.toBe(digestOf(base));
  });

  it("distinguishes values a looser encoding would merge", () => {
    // A string that looks like a number, an array vs an object with index keys, and a nested
    // structure vs its flattened spelling.
    expect(digestOf({ n: 1 })).not.toBe(digestOf({ n: "1" }));
    expect(digestOf([1, 2])).not.toBe(digestOf({ "0": 1, "1": 2 }));
    expect(digestOf({ a: { b: 1 } })).not.toBe(digestOf({ "a.b": 1 }));
  });

  it("always produces the sha256: prefix with 64 lowercase hex characters", () => {
    const d = digestOf({ any: "document" });
    expect(d.startsWith(DIGEST_PREFIX)).toBe(true);
    expect(isDigest(d)).toBe(true);
  });
});

describe("isDigest", () => {
  it("accepts only the exact form", () => {
    expect(isDigest(`sha256:${"a".repeat(64)}`)).toBe(true);
    expect(isDigest(`sha256:${"A".repeat(64)}`)).toBe(false);
    expect(isDigest(`sha256:${"a".repeat(63)}`)).toBe(false);
    expect(isDigest(`sha1:${"a".repeat(64)}`)).toBe(false);
    expect(isDigest("a".repeat(64))).toBe(false);
    // Synthetic digests appear all through the spec's examples; none of them may ever validate.
    expect(isDigest("sha256:<synthetic>")).toBe(false);
  });
});

describe("documentDigest", () => {
  const artifact = {
    artifactId: "corebank-member-balance",
    implements: { capability: "corebank.member.read_savings_balance", contractDigest: "sha256:aa" },
    steps: [{ id: "search" }],
  };

  it("ignores the document's own digest field, so a document can carry its own address", () => {
    const withDigest = { ...artifact, digest: "sha256:whatever" };
    expect(documentDigest(withDigest)).toBe(documentDigest(artifact));
  });

  it("ignores signatures, so a second approver does not invalidate the first", () => {
    const signedOnce = { ...artifact, signatures: [{ by: "approver-a" }] };
    const signedTwice = { ...artifact, signatures: [{ by: "approver-a" }, { by: "approver-b" }] };
    expect(documentDigest(signedOnce)).toBe(documentDigest(signedTwice));
  });

  it("does NOT ignore a nested digest, because that is a reference to another document", () => {
    const relinked = {
      ...artifact,
      implements: { ...artifact.implements, contractDigest: "sha256:bb" },
    };
    expect(documentDigest(relinked)).not.toBe(documentDigest(artifact));
  });

  it("detects an edit to an approved document", () => {
    const approved = { ...artifact, digest: documentDigest(artifact) };
    expect(documentDigestMatches(approved)).toBe(true);

    const tampered = { ...approved, steps: [{ id: "search" }, { id: "transfer-funds" }] };
    expect(documentDigestMatches(tampered)).toBe(false);
  });

  it("reports a mismatch when the digest field is absent or not a string", () => {
    expect(documentDigestMatches(artifact)).toBe(false);
    expect(documentDigestMatches({ ...artifact, digest: 7 })).toBe(false);
  });
});

describe("combineDigests", () => {
  const a = "sha256:aa";
  const b = "sha256:bb";

  it("is order-sensitive", () => {
    expect(combineDigests([a, b])).not.toBe(combineDigests([b, a]));
  });

  it("distinguishes an absent overlay from a two-part combination", () => {
    // effectiveDigest = f(artifactDigest, overlayDigest, linkerVersion), and a run with no overlay
    // must not be able to collide with a run that had one.
    expect(combineDigests([a, null, "linker@1"])).not.toBe(combineDigests([a, "linker@1"]));
  });

  it("cannot be confused by a different split of the same characters", () => {
    // The reason this hashes an array rather than a concatenation: "ab" + "c" and "a" + "bc" are
    // the same character sequence and different inputs.
    expect(combineDigests(["ab", "c"])).not.toBe(combineDigests(["a", "bc"]));
  });

  it("is stable for the same parts", () => {
    expect(combineDigests([a, b, "linker@1"])).toBe(combineDigests([a, b, "linker@1"]));
  });
});
