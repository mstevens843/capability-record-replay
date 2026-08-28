import type { Bounds } from "@crr/core";
import { describe, expect, it } from "vitest";
import { boundsFromBoxModel, centreOf, unclickableReason } from "../src/geometry.js";

/** A box model quad is four corners clockwise from the top left. */
const quad = (x: number, y: number, w: number, h: number): readonly number[] => [
  x,
  y,
  x + w,
  y,
  x + w,
  y + h,
  x,
  y + h,
];

const model = (x: number, y: number, w: number, h: number) => ({
  content: quad(x + 8, y + 3, w - 16, h - 6),
  padding: quad(x + 4, y + 1, w - 8, h - 2),
  border: quad(x, y, w, h),
  margin: quad(x - 2, y - 2, w + 4, h + 4),
  width: w,
  height: h,
});

describe("boundsFromBoxModel", () => {
  it("reads the border quad, which is what a bounding box means", () => {
    // Measured: for a `<button>` the content quad is x=193.1 w=112.6 and the border quad is
    // x=185.1 w=128.6, and the border quad is the one `locator.boundingBox()` agrees with. On a
    // legacy toolbar button that is mostly padding, that gap is the control versus its container.
    expect(boundsFromBoxModel(model(185.1, 62, 128.6, 21))).toEqual({
      x: 185,
      y: 62,
      w: 129,
      h: 21,
      unit: "px",
    });
  });

  it("keeps a negative origin, because a scrolled frame really does move boxes above the fold", () => {
    expect(boundsFromBoxModel(model(182, -103, 74.5, 23))?.y).toBe(-103);
  });

  it("refuses a malformed quad rather than inventing a rectangle", () => {
    expect(boundsFromBoxModel({ ...model(0, 0, 1, 1), border: [1, 2, 3] })).toBeNull();
    expect(
      boundsFromBoxModel({ ...model(0, 0, 1, 1), border: quad(Number.NaN, 0, 1, 1) }),
    ).toBeNull();
  });
});

describe("unclickableReason", () => {
  const viewport = { width: 1280, height: 720 };
  const px = (x: number, y: number, w: number, h: number): Bounds => ({ x, y, w, h, unit: "px" });

  it("allows a normal on-screen box", () => {
    expect(unclickableReason(px(10, 10, 100, 20), viewport)).toBeNull();
    expect(centreOf(px(10, 10, 100, 20))).toEqual({ x: 60, y: 20 });
  });

  it("refuses a zero-size node, which is PRESENT and not ignored in the accessibility tree", () => {
    expect(unclickableReason(px(181, 528, 0, 0), viewport)).toBe("zero-size");
    expect(unclickableReason(px(181, 528, 114, 0), viewport)).toBe("zero-size");
  });

  it("refuses a box still outside the viewport after the caller has scrolled and re-read it", () => {
    expect(unclickableReason(px(181, 4065, 114, 18), viewport)).toBe("off-screen-unscrollable");
    expect(unclickableReason(px(-400, 100, 100, 18), viewport)).toBe("off-screen-unscrollable");
  });

  it("checks zero-size FIRST, because a 0x0 box has a perfectly reasonable-looking centre", () => {
    expect(unclickableReason(px(4000, 4000, 0, 0), viewport)).toBe("zero-size");
  });
});
