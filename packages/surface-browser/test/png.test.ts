import { describe, expect, it } from "vitest";
import { BrowserSurfaceError } from "../src/errors.js";
import { MASK_COLOUR, blankRegions, decodePng, encodePng, pixelAt } from "../src/png.js";
import { type RefImage, refDecode, refEncode, refPixel } from "./support/png-ref.js";

/** A deterministic gradient, so a filter that is applied and un-applied wrongly shows up as a
 *  visible arithmetic error rather than as a field of identical bytes that hides one. */
function gradient(width: number, height: number, channels: 3 | 4): RefImage {
  const data = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * channels;
      data[index] = (x * 7 + y * 13) & 0xff;
      data[index + 1] = (x * 31 + 5) & 0xff;
      data[index + 2] = (y * 91 + 17) & 0xff;
      if (channels === 4) data[index + 3] = 0xff;
    }
  }
  return { width, height, channels, data };
}

describe("decodePng", () => {
  it("un-applies all five scanline filters, which is what a real screenshot uses", () => {
    // Chromium picks a filter per row. A decoder that only handles `None` produces a picture that
    // is recognisable and wrong, which is the worst possible outcome for a test that reads pixels.
    const source = gradient(11, 9, 3);
    const decoded = decodePng(refEncode(source, [0, 1, 2, 3, 4]));
    expect(decoded.width).toBe(11);
    expect(decoded.height).toBe(9);
    expect([...decoded.data]).toEqual([...source.data]);
  });

  it("handles the RGBA form as well as the RGB one Chromium emits", () => {
    const source = gradient(6, 4, 4);
    const decoded = decodePng(refEncode(source, [4, 3, 2, 1]));
    expect(decoded.channels).toBe(4);
    expect([...decoded.data]).toEqual([...source.data]);
  });

  it("refuses a form it cannot read instead of mis-decoding it", () => {
    const bytes = Buffer.from(refEncode(gradient(4, 4, 3)));
    bytes[8 + 8 + 8] = 16; // IHDR bit depth
    expect(() => decodePng(bytes)).toThrow(BrowserSurfaceError);
    expect(() => decodePng(Buffer.from("not a png at all"))).toThrow(/bad signature/);
  });
});

describe("encodePng", () => {
  it("round trips through an independently written decoder", () => {
    const source = gradient(9, 7, 3);
    const decoded = refDecode(encodePng({ ...source }));
    expect(decoded.width).toBe(9);
    expect([...decoded.data]).toEqual([...source.data]);
  });

  it("preserves the channel count rather than silently converting the image", () => {
    expect(refDecode(encodePng(gradient(4, 4, 4))).channels).toBe(4);
    expect(refDecode(encodePng(gradient(4, 4, 3))).channels).toBe(3);
  });

  it("is byte-for-byte reproducible, which is what a content-addressed blob wants", () => {
    const source = gradient(8, 8, 3);
    expect([...encodePng(source)]).toEqual([...encodePng(source)]);
  });
});

describe("blankRegions", () => {
  it("fills the rectangle and leaves everything else alone", () => {
    const image = { ...gradient(20, 20, 3) };
    const before = refPixel(image, 15, 15);
    expect(blankRegions(image, [{ x: 4, y: 4, w: 6, h: 6 }])).toBe(1);
    const decoded = refDecode(encodePng(image));
    expect(refPixel(decoded, 6, 6)).toEqual([...MASK_COLOUR]);
    expect(refPixel(decoded, 4, 4)).toEqual([...MASK_COLOUR]);
    expect(refPixel(decoded, 3, 4)).not.toEqual([...MASK_COLOUR]);
    expect(refPixel(decoded, 10, 4)).not.toEqual([...MASK_COLOUR]);
    expect(refPixel(decoded, 15, 15)).toEqual([...before]);
  });

  it("clips a region that hangs off the edge instead of running past the buffer", () => {
    const image = { ...gradient(10, 10, 3) };
    expect(blankRegions(image, [{ x: 8, y: 8, w: 100, h: 100 }])).toBe(1);
    expect(refPixel(refDecode(encodePng(image)), 9, 9)).toEqual([...MASK_COLOUR]);
  });

  it("counts a region that covered nothing as nothing", () => {
    // `Capture.maskedRegions` is read as "how much was redacted". A rectangle entirely off the image
    // masked no pixels, and reporting it as a mask would make a leak look like a redaction.
    const image = { ...gradient(10, 10, 3) };
    expect(blankRegions(image, [{ x: 40, y: 40, w: 5, h: 5 }])).toBe(0);
    expect(blankRegions(image, [{ x: 1, y: 1, w: 0, h: 5 }])).toBe(0);
  });

  it("writes an opaque alpha, so a mask cannot be see-through on an RGBA capture", () => {
    const image = { ...gradient(6, 6, 4) };
    image.data[(2 * 6 + 2) * 4 + 3] = 0;
    blankRegions(image, [{ x: 2, y: 2, w: 2, h: 2 }]);
    expect(pixelAt(image, 2, 2)).toEqual([...MASK_COLOUR, 255]);
  });
});

describe("pixelAt", () => {
  it("refuses a point outside the image", () => {
    expect(() => pixelAt(gradient(4, 4, 3), 4, 0)).toThrow(BrowserSurfaceError);
  });
});
