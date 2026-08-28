// Where a capture's bytes go, as a port.
//
// `Capture` crosses the surface boundary carrying a REF and a DIGEST, never an image, because
// nothing above the port may read pixels - SPEC section 2.2 is explicit that no detector, no
// descriptor and no checkpoint may consume them, and handing back a buffer would make that a
// convention rather than a shape. So the driver needs somewhere to put the bytes, and that
// somewhere is file-backed in `@crr/runtime` and in memory here.
//
// The ref is CONTENT-ADDRESSED - it is the digest of the bytes - which means two captures of the
// same masked screen collapse to one blob, and a ref in a journal is checkable against the file it
// names without trusting the journal.

import { type EvidenceRef, sha256Bytes } from "@crr/core";

export interface CaptureSink {
  /** Store the bytes and return the key they can be fetched back by. */
  put(bytes: Uint8Array, contentType: string): Promise<EvidenceRef>;
}

/** `sha256:<hex>` is a digest; a ref is a key, so it is spelled differently on purpose - a reader
 *  who sees `capture-<hex>.png` in a journal knows what kind of thing it names. */
export const captureRefOf = (bytes: Uint8Array): EvidenceRef =>
  `capture-${sha256Bytes(bytes)}.png` as EvidenceRef;

/**
 * The default sink: keeps the bytes in this process, bounded.
 *
 * Bounded because a long conformance run captures on every step and an unbounded map is a memory
 * leak with a test suite attached. Oldest-first eviction, and `get` returning `undefined` for an
 * evicted ref is the honest answer - a driver that pretended to still have it would be worse.
 */
export class MemoryCaptureSink implements CaptureSink {
  readonly #blobs = new Map<EvidenceRef, Uint8Array>();
  readonly #limit: number;

  constructor(limit = 64) {
    this.#limit = Math.max(1, limit);
  }

  async put(bytes: Uint8Array, _contentType: string): Promise<EvidenceRef> {
    const ref = captureRefOf(bytes);
    this.#blobs.delete(ref);
    this.#blobs.set(ref, bytes);
    while (this.#blobs.size > this.#limit) {
      const oldest = this.#blobs.keys().next();
      if (oldest.done === true) break;
      this.#blobs.delete(oldest.value);
    }
    return ref;
  }

  get(ref: EvidenceRef): Uint8Array | undefined {
    return this.#blobs.get(ref);
  }

  get size(): number {
    return this.#blobs.size;
  }
}
