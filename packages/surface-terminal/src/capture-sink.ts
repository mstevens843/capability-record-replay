// Where a capture's bytes go, as a port.
//
// Deliberately a second, tiny copy of the same idea `@crr/surface-browser` has rather than a shared
// one. A driver must not import another driver - that is the architecture rule the contract test
// enforces - and promoting thirty lines into a shared package so two drivers can agree on
// `put(bytes)` would be exactly the kind of package that exists to look like architecture.
//
// The ref is content-addressed, so two captures of the same masked screen collapse to one blob and
// a ref in a journal is checkable against the file it names without trusting the journal. The
// extension differs from the browser's on purpose: a reader who sees `grid-<hex>.txt` in an
// evidence directory knows immediately which surface produced it.

import { type EvidenceRef, sha256Bytes } from "@crr/core";

export interface CaptureSink {
  put(bytes: Uint8Array, contentType: string): Promise<EvidenceRef>;
}

export const gridRefOf = (bytes: Uint8Array): EvidenceRef =>
  `grid-${sha256Bytes(bytes)}.txt` as EvidenceRef;

/** Keeps the bytes in this process, bounded - an unbounded map on a per-step capture is a memory
 *  leak with a conformance run attached. Oldest first out; an evicted ref reads back `undefined`,
 *  which is the honest answer. */
export class MemoryGridSink implements CaptureSink {
  readonly #blobs = new Map<EvidenceRef, Uint8Array>();
  readonly #limit: number;

  constructor(limit = 64) {
    this.#limit = Math.max(1, limit);
  }

  async put(bytes: Uint8Array, _contentType: string): Promise<EvidenceRef> {
    const ref = gridRefOf(bytes);
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
