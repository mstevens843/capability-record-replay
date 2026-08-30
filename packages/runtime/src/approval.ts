// ed25519 approval verification - `@crr/core`'s open seam, closed.
//
// `ApprovalTrust.verifySignature` is INJECTED by the linker rather than implemented there, because
// signature arithmetic is a dependency and `@crr/core`'s whole claim is that it has none beyond
// zod. What core owns is the DOCUMENT half of the question: which digest was signed, and whether
// the key that signed it is one this deployment trusts (linker check 27). What is here is the
// arithmetic, and it is here because this is the package that is already allowed to import
// `node:crypto`.
//
// The limit as it stood before the approval model landed, kept here because half of it is still
// true: **there is still no key custody.** Public keys are handed to `ed25519Trust` by whoever
// constructs a catalog, from a file or an environment variable, and nothing here mints, distributes
// or destroys one. What HAS changed is everything downstream of custody - a key now has an owner, a
// set of roles, a validity window and a revocation state (`SignerRecord`), an approval can be
// withdrawn by id (`ApprovalRevocation`), and signing is a PORT whose local ed25519 implementation
// is one adapter among several (`ApprovalKeySigner`, `externalApprovalSigner`). NO EXTERNAL KMS OR
// HSM WAS INTEGRATED. `externalApprovalSigner` is the seam an integrator fills in; it has been
// exercised against an in-process fake and against nothing else, and docs/design/APPROVAL-MODEL.md
// says so in its "what this does not do" section.

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signBytes,
  verify as verifySignatureBytes,
} from "node:crypto";
import {
  type Approval,
  type ApprovalToken,
  type ApprovalTrust,
  type ApprovalTrustStore,
  approvalDigestOf,
  parseApproval,
} from "@crr/core";
import type { Digest } from "@crr/core";
import { approvalTokenOf } from "./ids.js";

export interface TrustedKey {
  readonly keyId: string;
  /** SPKI DER or a PEM block. An ed25519 raw 32-byte public key is accepted too and wrapped. */
  readonly publicKey: string | Uint8Array;
}

/** The 12-byte SPKI prefix an ed25519 public key carries. Prepended when a caller hands over the
 *  bare 32 bytes, which is what most key-generation tooling prints. */
const ED25519_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

function publicKeyOf(key: TrustedKey["publicKey"]): ReturnType<typeof createPublicKey> {
  if (typeof key === "string") return createPublicKey(key);
  if (key.length === 32) {
    const spki = new Uint8Array(ED25519_SPKI_PREFIX.length + 32);
    spki.set(ED25519_SPKI_PREFIX, 0);
    spki.set(key, ED25519_SPKI_PREFIX.length);
    return createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" });
  }
  return createPublicKey({ key: Buffer.from(key), format: "der", type: "spki" });
}

/**
 * A trust store the linker can use.
 *
 * The message signed is the DIGEST STRING itself (`sha256:…`), not the document bytes. That is
 * SPEC section 2.4's design and it is the reason an approved artifact cannot be silently edited: the
 * digest is over the JCS form of the document with `lifecycle` excluded, so editing any other field
 * changes the digest and the signature stops verifying against it.
 *
 * Fail-closed everywhere: an unparseable key, an unknown algorithm and a malformed signature all
 * return `false` rather than throwing, because linker check 27 reads a boolean and an exception
 * escaping a pure function it injected would take the whole link down with a stack trace instead of
 * a numbered refusal.
 */
export function ed25519Trust(keys: readonly TrustedKey[]): ApprovalTrust {
  const byId = new Map(keys.map((k) => [k.keyId, k]));
  return {
    trustedKeyIds: keys.map((k) => k.keyId),
    verifySignature: ({ over, keyId, alg, signature }) => {
      if (alg !== "ed25519") return false;
      const key = byId.get(keyId);
      if (key === undefined) return false;
      try {
        return verifySignatureBytes(
          null,
          Buffer.from(over, "utf8"),
          publicKeyOf(key.publicKey),
          Buffer.from(signature.replace(/^ed25519:/, ""), "base64url"),
        );
      } catch {
        return false;
      }
    },
  };
}

/**
 * A trust store that accepts any well-formed approval.
 *
 * For a fixture, a demo and a conformance scenario whose subject is the interpreter rather than the
 * crypto - and it says so in its name, so nobody reaches for it by accident. `link` still checks
 * that the approval signs THIS document's digest and that the key id is one the deployment listed;
 * what this skips is only the arithmetic.
 */
export function unverifiedTrust(trustedKeyIds: readonly string[]): ApprovalTrust {
  return { trustedKeyIds: [...trustedKeyIds], verifySignature: () => true };
}

export interface TrustedSigner extends TrustedKey {
  readonly signerId: string;
  readonly authority: readonly string[];
  readonly notBefore: string;
  readonly notAfter: string;
  readonly status?: "active" | "revoked";
  readonly revokedReason?: string | null;
  readonly supersedes?: string | null;
}

export function ed25519TrustStore(
  signers: readonly TrustedSigner[],
  revocations: ApprovalTrustStore["revocations"] = [],
): ApprovalTrustStore {
  const trust = ed25519Trust(signers);
  return {
    ...trust,
    signers: signers.map((signer) => ({
      keyId: signer.keyId,
      signerId: signer.signerId,
      authority: [...signer.authority],
      alg: "ed25519",
      notBefore: signer.notBefore as ApprovalTrustStore["signers"][number]["notBefore"],
      notAfter: signer.notAfter as ApprovalTrustStore["signers"][number]["notAfter"],
      status: signer.status ?? "active",
      revokedReason: signer.revokedReason ?? null,
      supersedes: signer.supersedes ?? null,
    })),
    revocations: [...revocations],
  };
}

// ---------------------------------------------------------------------------------------------
// The other half: producing the signature the trust store verifies
// ---------------------------------------------------------------------------------------------

/**
 * Whatever can sign an artifact's digest on an approver's behalf.
 *
 * It is a PORT, and that is the only part of key custody this project actually gets right. The
 * implementation below holds a private key in this process's memory, which is fine for a fixture
 * and for `pnpm demo` and is not a custody story: a production deployment implements this interface
 * against a KMS or an HSM, where `sign` is a network call and the private key never exists in the
 * application at all. Everything above this line - the digest, the lifecycle gate, the linker's
 * check 27 - is unchanged by that substitution, which is the whole reason it is an interface.
 *
 * See `approve()` in `lifecycle.ts` for what is signed and why it is the digest rather than the
 * bytes.
 */
export interface ApprovalSigner {
  /** Names the public half in the deployment's trust store. Recorded in `lifecycle.approval`. */
  readonly keyId: string;
  readonly alg: "ed25519";
  /** The detached signature over the digest STRING, base64url, no prefix. */
  sign(over: Digest): string;
}

export interface ApprovalKeySigner {
  readonly keyId: string;
  readonly alg: string;
  readonly signerId: string;
  readonly authority: readonly [string, ...string[]];
  sign(over: Digest): string;
}

export function localApprovalKeySigner(args: {
  readonly signer: ApprovalSigner;
  readonly signerId: string;
  readonly authority: readonly [string, ...string[]];
}): ApprovalKeySigner {
  return {
    keyId: args.signer.keyId,
    alg: args.signer.alg,
    signerId: args.signerId,
    authority: [...args.authority],
    sign: (over) => args.signer.sign(over),
  };
}

export function externalApprovalSigner(args: {
  readonly keyId: string;
  readonly alg: string;
  readonly signerId: string;
  readonly authority: readonly [string, ...string[]];
  readonly sign: (over: Digest) => string;
}): ApprovalKeySigner {
  return {
    keyId: args.keyId,
    alg: args.alg,
    signerId: args.signerId,
    authority: [...args.authority],
    sign: args.sign,
  };
}

export type UnsignedApproval = Omit<Approval, "signature">;

export function signApprovalDocument(
  unsigned: UnsignedApproval,
  signer: ApprovalKeySigner,
): Approval {
  const draft = {
    ...unsigned,
    signer: {
      signerId: signer.signerId,
      authority: signer.authority,
      keyId: signer.keyId,
      alg: signer.alg,
    },
  };
  return parseApproval({
    ...draft,
    signature: signer.sign(approvalDigestOf(draft as Readonly<Record<string, unknown>>)),
  });
}

/**
 * An in-process signer over an ed25519 private key.
 *
 * THE LIMITATION, STATED WHERE IT WILL BE READ: this implementation has no key custody. It takes a
 * private key as an argument, holds it in memory for as long as the process lives, and has no
 * notion of who the approver is beyond a `keyId` string, no expiry, no revocation path, and no
 * audit trail of its own use. That is a deliberate stopping point (OPEN-QUESTIONS-RESOLVED Q5), not
 * an oversight: an approval is only ever as strong as the custody of the signing key, and a
 * half-built key manager would make that weakness harder to see rather than easier. REPORT section
 * 6 says the same thing in the same words.
 */
export function ed25519Signer(
  keyId: string,
  privateKey: string | Uint8Array | ReturnType<typeof createPrivateKey>,
): ApprovalSigner {
  const key =
    typeof privateKey === "string"
      ? createPrivateKey(privateKey)
      : privateKey instanceof Uint8Array
        ? createPrivateKey({ key: Buffer.from(privateKey), format: "der", type: "pkcs8" })
        : privateKey;
  return {
    keyId,
    alg: "ed25519",
    // `null` is the digest algorithm: ed25519 signs the message directly, and passing a hash name
    // here is how an ed25519 signature ends up being taken over the wrong bytes.
    sign: (over) => signBytes(null, Buffer.from(over, "utf8"), key).toString("base64url"),
  };
}

/**
 * A fresh key pair, for a fixture, a test and `pnpm demo`.
 *
 * Generated per process and never written down, which is the correct treatment for a key with no
 * custody: a private key committed to a repository is a private key on the internet, and a stored
 * one would additionally teach the wrong lesson about what this function is for. The property
 * anything here proves - "the runtime verifies a signature over the digest" - is proved as well by
 * a key minted a millisecond ago as by one that has been sitting in a file.
 */
export function generateApprovalKeyPair(keyId: string): {
  readonly signer: ApprovalSigner;
  readonly trustedKey: TrustedKey;
} {
  const pair = generateKeyPairSync("ed25519");
  return {
    signer: ed25519Signer(keyId, pair.privateKey),
    trustedKey: {
      keyId,
      publicKey: new Uint8Array(pair.publicKey.export({ format: "der", type: "spki" })),
    },
  };
}

/**
 * The token a caller presents to authorize an irreversible step.
 *
 * The policy engine can only check that a token exists and that the run pinned a digest for it
 * (rule 8); binding the two is the runtime's job and it is one line: the token names the digest it
 * was minted against, and `replay` refuses when that digest is not the artifact's own.
 */
export interface ApprovalGrant {
  readonly token: ApprovalToken;
  readonly digest: Digest;
}

export function approvalGrant(digest: Digest, token: string): ApprovalGrant {
  return { token: approvalTokenOf(token), digest };
}

export interface InvocationApprovalGrant {
  readonly approval: Approval;
  readonly trust: ApprovalTrustStore;
  readonly requiredAuthority: readonly [string, ...string[]];
}

export function invocationApprovalGrant(args: {
  readonly approval: Approval;
  readonly trust: ApprovalTrustStore;
  readonly requiredAuthority: readonly [string, ...string[]];
}): InvocationApprovalGrant {
  return {
    approval: args.approval,
    trust: args.trust,
    requiredAuthority: [...args.requiredAuthority],
  };
}
