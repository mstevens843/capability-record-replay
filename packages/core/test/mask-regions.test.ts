// Mask-region derivation, against the frozen corebank screens.
//
// The screens are the hostile ones on purpose. The member name is displayed in a readonly textbox
// inside a landmark that has no geometry of its own, which is exactly the shape that makes a naive
// implementation mask the label and miss the value - and exactly the shape a legacy back office
// produces.
//
// The test that matters most here is the refusal one: a sensitive node with no geometry anywhere in
// its subtree must make the capture refuse, not proceed. Losing a screenshot costs a debugging
// session. Taking an unmasked one costs a regulatory event.

import { describe, expect, it } from "vitest";
import {
  MockSurface,
  type NodeId,
  type UINode,
  deriveMaskRegions,
  safeCaptureRequest,
} from "../src/index.js";
import { IDS, corebankScreens, detail, searchForm } from "./fixtures/corebank-observations.js";

const nodes = detail.nodes;

describe("deriveMaskRegions", () => {
  it("masks the rectangle a driver reported for a sensitive field", () => {
    const derived = deriveMaskRegions(searchForm.nodes, [IDS.memberIdField]);
    expect(derived).toEqual({
      regions: [{ x: 112, y: 92, w: 160, h: 24 }],
      unmaskable: [],
      absent: [],
    });
  });

  it("covers the whole subtree, because the value is routinely in a child of the named node", () => {
    // `region:member-detail` has no geometry of its own; the heading and both readonly textboxes
    // inside it do. Masking only what the named node reports would blank nothing at all.
    const derived = deriveMaskRegions(nodes, [IDS.detailRegion]);
    expect(derived.unmaskable).toEqual([]);
    expect(derived.regions).toEqual([{ x: 24, y: 56, w: 376, h: 96 }]);
  });

  it("also masks whatever the driver already blanked", () => {
    // `UINode.masked` means the driver blanked the VALUE in the observation because it is bound to
    // a sensitive parameter. The pixels are still on the screen.
    const withDriverMask = nodes.map(
      (n): UINode => (n.id === IDS.memberNameField ? { ...n, masked: true } : n),
    );
    const derived = deriveMaskRegions(withDriverMask, []);
    expect(derived.regions).toEqual([{ x: 160, y: 96, w: 240, h: 24 }]);

    const optedOut = deriveMaskRegions(withDriverMask, [], { includeDriverMasked: false });
    expect(optedOut.regions).toEqual([]);
  });

  it("reports a sensitive node with no geometry as unmaskable rather than skipping it", () => {
    const blind = nodes.map(
      (n): UINode => (n.id === IDS.memberNameField ? { ...n, bounds: null } : n),
    );
    const derived = deriveMaskRegions(blind, [IDS.memberNameField]);
    expect(derived.unmaskable).toEqual([IDS.memberNameField]);
    expect(derived.regions).toEqual([]);
  });

  it("reports a node that is not on this screen as absent, not as a failure", () => {
    const derived = deriveMaskRegions(searchForm.nodes, [IDS.memberNameField]);
    expect(derived.absent).toEqual([IDS.memberNameField]);
    expect(derived.unmaskable).toEqual([]);
  });

  it("treats geometry in the wrong unit as unmaskable, never as a plausible rectangle", () => {
    // A pixel rectangle applied to a character grid masks the wrong cells and blanks nothing where
    // it matters. There is no useful conversion, so there is no conversion.
    const grid = nodes.map(
      (n): UINode =>
        n.id === IDS.memberNameField
          ? { ...n, children: [], bounds: { x: 20, y: 4, w: 30, h: 1, unit: "cell" } }
          : n,
    );
    const derived = deriveMaskRegions(grid, [IDS.memberNameField], { unit: "px" });
    expect(derived.unmaskable).toEqual([IDS.memberNameField]);
  });

  it("is deterministic: same screen, same request, byte for byte", () => {
    const ids: readonly NodeId[] = [IDS.memberNameField, IDS.accountStatusField, IDS.detailHeading];
    const a = deriveMaskRegions(nodes, ids);
    const b = deriveMaskRegions(nodes, [...ids].reverse());
    expect(a.regions).toEqual(b.regions);
    // Top-to-bottom, then left-to-right, and de-duplicated - so a capture digest over the request
    // is stable and a repeated node cannot inflate `maskedRegions`.
    expect(a.regions).toEqual([
      { x: 24, y: 56, w: 320, h: 24 },
      { x: 160, y: 96, w: 240, h: 24 },
      { x: 160, y: 128, w: 120, h: 24 },
    ]);
    expect(
      deriveMaskRegions(nodes, [IDS.memberNameField, IDS.memberNameField]).regions,
    ).toHaveLength(1);
  });

  it("grows a region when a driver asks for padding", () => {
    const derived = deriveMaskRegions(searchForm.nodes, [IDS.memberIdField], { padding: 2 });
    expect(derived.regions).toEqual([{ x: 110, y: 90, w: 164, h: 28 }]);
  });
});

describe("safeCaptureRequest", () => {
  it("builds the request when everything sensitive can be covered", () => {
    const derived = deriveMaskRegions(nodes, [IDS.memberNameField]);
    const request = safeCaptureRequest(derived, "image");
    expect(request).toEqual({
      ok: true,
      request: { maskRegions: [{ x: 160, y: 96, w: 240, h: 24 }], format: "image" },
    });
  });

  it("refuses the capture when something sensitive cannot be covered", () => {
    // A value the executor has to handle, not an exception it can forget to catch: the journal
    // records `capture-refused` with the node that caused it, which is a better bug report than a
    // missing file.
    const blind = nodes.map(
      (n): UINode => (n.id === IDS.memberNameField ? { ...n, bounds: null } : n),
    );
    const derived = deriveMaskRegions(blind, [IDS.memberNameField]);
    expect(safeCaptureRequest(derived, "image")).toEqual({
      ok: false,
      unmaskable: [IDS.memberNameField],
    });
  });

  it("produces a request whose mask reaches the bytes", async () => {
    // The mock's capture digest is taken over the screen AND the mask, so this asserts the derived
    // regions actually change the artifact rather than only its metadata - the same property the
    // browser driver's PNG-decode test asserts at the pixel.
    const surface = new MockSurface({ screens: corebankScreens, start: "detail" });
    const derived = deriveMaskRegions(nodes, [IDS.memberNameField]);
    const request = safeCaptureRequest(derived, "image");
    if (!request.ok) throw new Error("the fixture screen is maskable");

    const masked = await surface.capture(request.request);
    const unmasked = await surface.capture({ maskRegions: [], format: "image" });
    expect(masked.maskedRegions).toBe(1);
    expect(masked.digest).not.toBe(unmasked.digest);
  });
});
