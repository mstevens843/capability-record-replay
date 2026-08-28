// Screenshot masking, verified by decoding the PNG rather than by eyeballing it.
//
// The whole taint story runs end to end here and it is worth naming the links, because each one is
// owned by a different unit and the point is that they meet:
//
//   the artifact says a step's value is sensitive  ->  `Action.type.sensitive` is true
//     ->  the DRIVER records the node and blanks its value in every later observation (`masked`)
//     ->  `@crr/core`'s `deriveMaskRegions` turns the masked node's geometry into rectangles
//     ->  `safeCaptureRequest` REFUSES the capture outright if any of them has no geometry
//     ->  this driver blanks those pixels before the bytes leave `capture()`
//     ->  the ref and the digest are over the MASKED bytes, so nothing unmasked is addressable.

import {
  type LeaseToken,
  type Observation,
  type UINode,
  deriveMaskRegions,
  safeCaptureRequest,
  sha256Bytes,
} from "@crr/core";
import { describe, expect, it } from "vitest";
import { MemoryCaptureSink } from "../src/capture-sink.js";
import { BrowserSurfaceError } from "../src/errors.js";
import { MASK_COLOUR } from "../src/png.js";
import { type BrowserSurface, attachBrowserSurface } from "../src/surface.js";
import { chromiumAvailable, gotoContent, openCorebank } from "./support/corebank.js";
import { refDecode, refPixel } from "./support/png-ref.js";

const LEASE = "lease-automation-1" as LeaseToken;

const observe = async (surface: BrowserSurface): Promise<Observation> => {
  const result = await surface.perceive({ deadlineMs: 10_000 });
  if (!result.ok) throw new Error(`perceive failed: ${JSON.stringify(result.fault)}`);
  return result.observation;
};

describe.skipIf(!chromiumAvailable())("masked capture", () => {
  it("blanks the sensitive field's pixels, and only those", async () => {
    const env = await openCorebank();
    const sink = new MemoryCaptureSink();
    try {
      await env.page.goto(`${env.fixture.origin}/`, { waitUntil: "load" });
      const surface = await attachBrowserSurface({
        page: env.page,
        origins: { corebank: env.fixture.origin },
        primaryFrame: "content",
        lease: LEASE,
        captureSink: sink,
      });
      await gotoContent(env.page, `${env.fixture.origin}/member/10041/subaccount/new`);
      const before = await observe(surface);
      const deposit = before.nodes.filter((node) => node.ariaRole === "textbox")[0] as UINode;

      await surface.act(
        { kind: "type", target: deposit.id, text: "25.00", mode: "replace", sensitive: true },
        LEASE,
      );
      const after = await observe(surface);
      const masked = after.nodes.filter((node) => node.masked);
      expect(masked).toHaveLength(1);
      expect(masked[0]?.value).toBeNull();
      const bounds = masked[0]?.bounds;
      if (bounds == null) throw new Error("the masked node has no geometry");

      // The region list is computed by `@crr/core` from the observation, not by the driver: what
      // crosses the port is rectangles, because the character-grid driver has no locators at all.
      const request = safeCaptureRequest(
        deriveMaskRegions(after.nodes, [], { unit: "px" }),
        "image",
      );
      expect(request.ok).toBe(true);
      if (!request.ok) throw new Error("unreachable");
      expect(request.request.maskRegions.length).toBeGreaterThan(0);

      const unmasked = await surface.capture({ maskRegions: [], format: "image" });
      const capture = await surface.capture(request.request);
      expect(capture.maskedRegions).toBe(request.request.maskRegions.length);

      const bytes = sink.get(capture.ref);
      if (bytes === undefined) throw new Error("the capture was not stored");
      // Decoded by an INDEPENDENTLY written codec, so an encoder bug and a decoder bug cannot
      // cancel each other out into a green test over leaked bytes.
      const image = refDecode(bytes);
      expect(image.width).toBe(1280);
      expect(image.height).toBe(720);

      const centre = {
        x: bounds.x + Math.floor(bounds.w / 2),
        y: bounds.y + Math.floor(bounds.h / 2),
      };
      expect(refPixel(image, centre.x, centre.y)).toEqual([...MASK_COLOUR]);
      expect(refPixel(image, bounds.x + 1, bounds.y + 1)).toEqual([...MASK_COLOUR]);

      // The pixel just outside the rectangle is untouched, and the banner - three hundred pixels
      // away and in another document - still has the tenant's colour. That second assertion is what
      // proves the scanline filters were undone correctly rather than merely consistently.
      expect(refPixel(image, bounds.x + bounds.w + 6, centre.y)).not.toEqual([...MASK_COLOUR]);
      expect(refPixel(image, 640, 10)).toEqual([0x1f, 0x3d, 0x66]);

      const plain = sink.get(unmasked.ref);
      if (plain === undefined) throw new Error("the unmasked capture was not stored");
      // And the mask actually did something: the same pixel was NOT magenta before it was applied.
      expect(refPixel(refDecode(plain), centre.x, centre.y)).not.toEqual([...MASK_COLOUR]);
      await surface.close();
    } finally {
      await env.close();
    }
  });

  it("addresses the masked bytes and nothing else", async () => {
    const env = await openCorebank();
    const sink = new MemoryCaptureSink();
    try {
      await env.page.goto(`${env.fixture.origin}/`, { waitUntil: "load" });
      const surface = await attachBrowserSurface({
        page: env.page,
        origins: { corebank: env.fixture.origin },
        primaryFrame: "content",
        lease: LEASE,
        captureSink: sink,
      });
      await observe(surface);
      const plain = await surface.capture({ maskRegions: [], format: "image" });
      const masked = await surface.capture({
        maskRegions: [{ x: 100, y: 100, w: 200, h: 40 }],
        format: "image",
      });
      // The digest is over the bytes that were stored, and a different mask is a different capture.
      expect(masked.digest).not.toBe(plain.digest);
      expect(masked.digest).toBe(`sha256:${sha256Bytes(sink.get(masked.ref) as Uint8Array)}`);
      expect(masked.ref).toContain(sha256Bytes(sink.get(masked.ref) as Uint8Array));
      expect(masked.maskedRegions).toBe(1);
      await surface.close();
    } finally {
      await env.close();
    }
  });

  it("refuses a format it does not advertise, and a screenshot that would hang", async () => {
    const env = await openCorebank();
    try {
      await env.page.goto(`${env.fixture.origin}/?dialog=native`, { waitUntil: "load" });
      const surface = await attachBrowserSurface({
        page: env.page,
        origins: { corebank: env.fixture.origin },
        primaryFrame: "content",
        lease: LEASE,
      });
      await expect(surface.capture({ maskRegions: [], format: "text-grid" })).rejects.toThrow(
        BrowserSurfaceError,
      );

      await gotoContent(env.page, `${env.fixture.origin}/member/10041/subaccount/new`);
      const submit = (await observe(surface)).nodes.find(
        (node) => node.ariaRole === "button",
      ) as UINode;
      await surface.act({ kind: "click", target: submit.id }, LEASE);
      expect(surface.pendingNativeDialog).not.toBeNull();
      // A blocked renderer cannot paint. Saying so beats a fifteen-second timeout that ends in a
      // screenshot of nothing.
      await expect(surface.capture({ maskRegions: [], format: "image" })).rejects.toThrow(
        /renderer is blocked/,
      );
      await surface.act({ kind: "dismissDialog" }, LEASE);
      await surface.close();
    } finally {
      await env.close();
    }
  });
});
