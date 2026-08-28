// The registry freeze: this test fails if any registered function's behaviour changes at the same
// major version.
//
// THE PROBLEM. An artifact says `normalize: "std.label@1"`. It has been reviewed by an operations
// person, digested, signed, and approved. Six months later someone improves `stdLabel` - strips one
// more character, folds one more space. The artifact's bytes are unchanged. Its digest is
// unchanged. The signature still verifies. And it now matches different text than the person who
// approved it read. Nothing in the system notices, and the first symptom is a detector that fires
// at one tenant and not another.
//
// THE MECHANISM. Every registered function is applied to a fixed probe corpus (in `src/registry.ts`,
// so it is part of the artifact of the registry rather than of this test), and the digest is taken
// over the (probe, result) pairs. The expected digests below are frozen. Change what any function
// does on any probe - or change the corpus - and the digest moves and this test fails.
//
// WHAT TO DO WHEN IT FAILS. Not update the constant. The two legitimate responses are:
//
//   1. The change was accidental. Revert it.
//   2. The change is wanted. Register the new behaviour as a NEW MAJOR - `std.label@2` alongside
//      `std.label@1` - so existing approved artifacts keep the semantics they were approved with,
//      and moving to the new behaviour is an edit to an artifact that goes back through review.
//
// Updating the frozen digest in place is the third option, and it is the one this test exists to
// make someone argue for out loud.

import { describe, expect, it } from "vitest";
import { digestOf } from "../src/digest.js";
import { normalize } from "../src/normalizers.js";
import type { Digest, RegistryId } from "../src/primitives.js";
import {
  NORMALIZER_PROBES,
  REGISTRY,
  behaviourDigest,
  registryBehaviourDigest,
} from "../src/registry.js";

/**
 * Frozen behaviour of every registered function, at the major encoded in its id.
 *
 * Produced by `behaviourDigest(id)` over the probe corpus in `src/registry.ts`, and reproducible
 * from the source alone - the canonicalization is RFC 8785 and the hash is the vendored SHA-256
 * pinned in `sha256.test.ts`, so nothing here depends on a tool this repository ships.
 */
const FROZEN: Readonly<Record<RegistryId, string>> = {
  "std.text@1": "sha256:02dc7f5b2c3c26ca6a32ce9e463ebf09de7dca0a028a06f8405148eea8381a71",
  "std.label@1": "sha256:bf6c34e27167da68487c93624717f2477c04d69f8c84f6bff940350515b4eae3",
  "std.money@1": "sha256:e483e45cce89691dc12fe587bec210cdb1b513f58c95157a7c032e4bae18c6fe",
  "std.identity@1": "sha256:f471ee09f7cc905d6feb43816341413c8caa2b626fdce4596682d8d50e61264b",
  "text@1": "sha256:a55e872798e292df2978bf287339535a2d834c84b04cf21458bc4cc9971ac8a3",
  "value@1": "sha256:98de45cedcfe46fb1f80fc4388130b18218b61927821b543ea5c83d780353b61",
  "name@1": "sha256:702cbdbbc9337612cceb75d469a284efdb7fb8c8151c8470574346e80fee2819",
  "cell@1": "sha256:81498e44a08a98abfbd96db5204b529d2dbb2cbec9569b1cea2de82c050c74a3",
  "string@1": "sha256:12799fccd3997c2f96f7a9dc7c7fef587e5c82d04a5fdb56140cd71bea16314e",
  "integer@1": "sha256:431ace9a70026110f82d58e8aae02ef8df5ffa72d6532ffb9e71048c4e608bc1",
  "moneyUSD@1": "sha256:d252b6cfbcc6bdca4d1b968bd427c5c76438fe3ad37c2d183c30cada4a880028",
  "dateUS@1": "sha256:5f775a5dcd884678964fc8e5ba3d3f18215e13c5251e299ffaf81e67c513276a",
  "dateISO@1": "sha256:987aec414e3b8b6743df36066fd40ba3e570619007859938eb113008626dbed6",
  "enum@1": "sha256:8e7385fa9bafbd51982222424013b6bc2cb10532ad07d2c0a95cb4c19b902060",
};

/** One value that answers "which registry semantics did this run use", for the journal. */
const FROZEN_AGGREGATE = "sha256:bde58fcab26b0e8a21fa7574093fd64639dc15fe14fb400aa7e3ab9a3e6aa5f5";

describe("registry behaviour is frozen at its declared major", () => {
  for (const entry of REGISTRY) {
    it(`${entry.id} behaves exactly as it did when it was frozen`, () => {
      expect(behaviourDigest(entry.id)).toBe(FROZEN[entry.id]);
    });
  }

  it("has a frozen digest for every registered id, and no orphans", () => {
    // A new function added without a frozen digest would otherwise be silently unfrozen, and a
    // removed one would leave a constant that proves nothing.
    expect(Object.keys(FROZEN).sort()).toEqual(REGISTRY.map((e) => e.id).sort());
  });

  it("has a stable aggregate digest for the registry as a whole", () => {
    expect(registryBehaviourDigest()).toBe(FROZEN_AGGREGATE);
  });
});

describe("the freeze actually detects a behaviour change", () => {
  // A freeze test that cannot fail is decoration. These assertions prove the mechanism has teeth
  // by digesting deliberately altered behaviour and showing it does not match the frozen value.
  //
  // They stand in for the mutants in `@crr/conformance`: same idea, one layer down.

  const digestOfAltered = (fn: (input: string) => string): Digest =>
    // Recomputed exactly the way `behaviourDigest` does, over the same corpus, so the only
    // difference between this value and the real one is the function's behaviour.
    digestOf({
      id: "std.text@1",
      kind: "normalizer",
      major: 1,
      observations: NORMALIZER_PROBES.map((probe) => [probe, fn(probe.input)]),
    });

  it("notices a normalizer that stops folding case", () => {
    const withoutCaseFolding = (input: string): string =>
      input.normalize("NFC").replace(/\s+/g, " ").trim();
    expect(digestOfAltered(withoutCaseFolding)).not.toBe(FROZEN["std.text@1"]);
  });

  it("notices a normalizer that stops collapsing whitespace", () => {
    const withoutCollapse = (input: string): string => input.normalize("NFC").trim().toLowerCase();
    expect(digestOfAltered(withoutCollapse)).not.toBe(FROZEN["std.text@1"]);
  });

  it("notices a normalizer that adds one extra stripped character", () => {
    // The smallest plausible "improvement": also strip a trailing hyphen. It changes nothing a
    // casual reader would notice, and it changes what an approved artifact matches.
    const withHyphenStripped = (input: string): string =>
      normalize("std.text@1", input).replace(/-+$/, "");
    expect(digestOfAltered(withHyphenStripped)).not.toBe(FROZEN["std.text@1"]);
  });
});
