import { sha256Bytes } from "@crr/core";
import { describe, expect, it } from "vitest";
import { MemoryCaptureSink, captureRefOf } from "../src/capture-sink.js";

describe("captureRefOf", () => {
  it("is content addressed, so a ref in a journal is checkable against the blob it names", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(captureRefOf(bytes)).toBe(`capture-${sha256Bytes(bytes)}.png`);
  });

  it("collapses two captures of identical bytes onto one blob", async () => {
    const sink = new MemoryCaptureSink();
    const a = await sink.put(new Uint8Array([9, 9]), "image/png");
    const b = await sink.put(new Uint8Array([9, 9]), "image/png");
    expect(a).toBe(b);
    expect(sink.size).toBe(1);
  });
});

describe("MemoryCaptureSink", () => {
  it("hands the bytes back by ref", async () => {
    const sink = new MemoryCaptureSink();
    const ref = await sink.put(new Uint8Array([7]), "image/png");
    expect([...(sink.get(ref) ?? [])]).toEqual([7]);
  });

  it("is bounded, and says nothing rather than lying about an evicted blob", async () => {
    const sink = new MemoryCaptureSink(2);
    const first = await sink.put(new Uint8Array([1]), "image/png");
    await sink.put(new Uint8Array([2]), "image/png");
    await sink.put(new Uint8Array([3]), "image/png");
    expect(sink.size).toBe(2);
    expect(sink.get(first)).toBeUndefined();
  });
});
