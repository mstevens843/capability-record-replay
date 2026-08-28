// Pins the vendored SHA-256 to vectors this repository did not produce.
//
// A hand-rolled hash is only trustworthy against numbers computed by something else. Two
// independent sources are used, and each is named next to the vectors it produced:
//
//   1. The published FIPS 180-4 / NIST CAVP byte-oriented vectors.
//   2. `shasum -a 256`, run locally over bytes written by a short script, for the block-boundary
//      and multi-byte-UTF-8 cases the published set does not cover. The command is recorded above
//      the table so anyone can regenerate them.
//
// The UTF-8 cases matter as much as the hash cases: the encoder is hand-rolled too, and an encoder
// disagreement would split the digest of the same artifact across two runtimes - which is the one
// thing content addressing exists to prevent.

import { describe, expect, it } from "vitest";
import { sha256, sha256Bytes, utf8 } from "../src/hash/sha256.js";

interface Vector {
  readonly name: string;
  readonly input: string;
  readonly expected: string;
}

/** FIPS 180-4 Appendix B / NIST CAVP. */
const PUBLISHED: readonly Vector[] = [
  {
    name: "the empty string",
    input: "",
    expected: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  },
  {
    name: 'the one-block message "abc"',
    input: "abc",
    expected: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  },
  {
    name: "the 448-bit two-block message",
    input: "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    expected: "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  },
  {
    name: "the 896-bit multi-block message",
    input:
      "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmno" +
      "ijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
    expected: "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
  },
  {
    name: "one million repetitions of 'a'",
    input: "a".repeat(1_000_000),
    expected: "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
  },
];

/**
 * Lengths either side of every interesting point in the padding rule: the 55/56 cliff where the
 * 64-bit length field no longer fits alongside the padding and a whole extra block is emitted, the
 * 64-byte block edge, and the same two again one block later.
 *
 * Produced with, and reproducible by:
 *   python3 -c 'open("v.bin","wb").write(b"a"*55)' && shasum -a 256 v.bin
 */
const BOUNDARIES: readonly Vector[] = [
  {
    name: "55 bytes, the last length that fits beside its own padding",
    input: "a".repeat(55),
    expected: "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318",
  },
  {
    name: "56 bytes, the first length that forces another block",
    input: "a".repeat(56),
    expected: "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a",
  },
  {
    name: "63 bytes",
    input: "a".repeat(63),
    expected: "7d3e74a05d7db15bce4ad9ec0658ea98e3f06eeecf16b4c6fff2da457ddc2f34",
  },
  {
    name: "64 bytes, exactly one block",
    input: "a".repeat(64),
    expected: "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb",
  },
  {
    name: "65 bytes",
    input: "a".repeat(65),
    expected: "635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0",
  },
  {
    name: "119 bytes",
    input: "a".repeat(119),
    expected: "31eba51c313a5c08226adf18d4a359cfdfd8d2e816b13f4af952f7ea6584dcfb",
  },
  {
    name: "120 bytes",
    input: "a".repeat(120),
    expected: "2f3d335432c70b580af0e8e1b3674a7c020d683aa5f73aaaedfdc55af904c21c",
  },
  {
    name: "127 bytes",
    input: "a".repeat(127),
    expected: "c57e9278af78fa3cab38667bef4ce29d783787a2f731d4e12200270f0c32320a",
  },
  {
    name: "128 bytes, exactly two blocks",
    input: "a".repeat(128),
    expected: "6836cf13bac400e9105071cd6af47084dfacad4e5e302c94bfed24e013afb73e",
  },
];

/**
 * Multi-byte UTF-8, which exercises the hand-rolled encoder and the hash together. Same command as
 * above, with the bytes written from a Python literal.
 */
const UTF8_VECTORS: readonly Vector[] = [
  {
    name: "a two-byte character (U+00E4)",
    input: "ä",
    expected: "33e6d73fee82904c8d7afb78de1154d1e8dc2a0edb08120e63df5b9385c2d9cc",
  },
  {
    name: "a three-byte character (U+20AC)",
    input: "€",
    expected: "c4cc90ed3d26f12d4b08a75140970a7904035c31cbb4515a83f19b9003c00d1d",
  },
  {
    name: "a surrogate pair (U+1F602)",
    input: "\u{1F602}",
    expected: "d8c7b3398b054be5f0e2b42502fb5e83a065956fba00bc15a2fb5e3e962194b4",
  },
  {
    name: "one of each width in one string",
    input: "aä€\u{1F602}",
    expected: "e0dfbd31a90fa205d30a8fbc6ea3bcd13b154115ece11a873797d28956b2f7f5",
  },
  {
    name: "an embedded NUL",
    input: "a\u0000b",
    expected: "59b271ae1bbcb1d31d41929817f4b16fb439eb4f31520b5ad1d5ce98920a7138",
  },
];

describe("sha256", () => {
  for (const group of [
    { label: "published FIPS 180-4 vectors", vectors: PUBLISHED },
    { label: "block-boundary vectors from an independent implementation", vectors: BOUNDARIES },
    { label: "multi-byte UTF-8 vectors from an independent implementation", vectors: UTF8_VECTORS },
  ]) {
    describe(group.label, () => {
      for (const v of group.vectors) {
        it(`hashes ${v.name}`, () => {
          expect(sha256(v.input)).toBe(v.expected);
        });
      }
    });
  }

  it("always returns 64 lowercase hex characters", () => {
    for (let n = 0; n < 200; n++) {
      expect(sha256("x".repeat(n))).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("hashes bytes and the string that encodes to them identically", () => {
    const s = "member 12345 ä\u{1F602}";
    expect(sha256Bytes(utf8(s))).toBe(sha256(s));
  });
});

describe("utf8", () => {
  it("encodes each code point width to the expected byte count", () => {
    expect([...utf8("a")]).toEqual([0x61]);
    expect([...utf8("ä")]).toEqual([0xc3, 0xa4]);
    expect([...utf8("€")]).toEqual([0xe2, 0x82, 0xac]);
    expect([...utf8("\u{1F602}")]).toEqual([0xf0, 0x9f, 0x98, 0x82]);
  });

  it("replaces a lone surrogate with U+FFFD, the way TextEncoder does", () => {
    // Lossy on purpose, and the reason `canonicalJson` refuses lone surrogates before they reach
    // here: two distinct ill-formed strings must not collapse into one digest.
    expect([...utf8("\uD83D")]).toEqual([0xef, 0xbf, 0xbd]);
    expect([...utf8("\uDE02")]).toEqual([0xef, 0xbf, 0xbd]);
    expect(utf8("\uD83D")).toEqual(utf8("\uDE02"));
  });
});
