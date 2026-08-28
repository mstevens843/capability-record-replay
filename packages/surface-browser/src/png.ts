// A minimal PNG codec, so a masked screenshot is a fact rather than a claim.
//
// WHY THIS FILE EXISTS AT ALL, stated plainly because it is a deviation worth arguing with.
//
// SPEC section 8.4 says mask regions are blanked "BEFORE the bytes exist", and `@crr/core`'s
// `masking.ts` names the intended mechanism: Playwright's `page.screenshot({ mask })`, bridged from
// a node to a `Locator`. Two measured facts stand in the way. `mask` takes `Locator[]` and there is
// no coordinate form of it - but what crosses this port is `CaptureRequest.maskRegions`, which is a
// list of RECTANGLES, because the terminal driver blanks a cell range and has no locators at all.
// And the only bridge from a perceived node to a `Locator` is `aria-ref`, which is an undocumented
// selector engine absent from `types.d.ts` (browser spike section 7.2) and would additionally
// require aligning two different node sets on every capture (section 6.2).
//
// So this driver blanks the raster in process: screenshot -> decode -> fill -> re-encode, and the
// unmasked buffer is a local that is never returned, never digested, never written and never
// logged. The invariant the rule is FOR - nothing unmasked reaches a ref, a digest, a log or a disk
// - holds and is asserted by a test. The literal words "before the bytes exist" do not. That is the
// trade, it is recorded here rather than in a commit message, and the alternative is an undocumented
// selector engine in the path that decides whether a member's data reaches an evidence directory.
//
// Scope: 8-bit RGB and RGBA, non-interlaced, which is what Chromium's screenshot encoder produces
// (measured: `IHDR w=1280 h=720 bitDepth=8 colorType=2 interlace=0`). Anything else is refused
// loudly rather than mis-decoded into a picture that looks masked and is not.

import { deflateSync, inflateSync } from "node:zlib";
import { BrowserSurfaceError } from "./errors.js";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** Playwright's own mask colour, reused so a capture masked by this driver looks like every other
 *  masked screenshot a reviewer has seen. Opaque magenta occurs in no real bank screen. */
export const MASK_COLOUR: readonly [number, number, number] = [0xff, 0x00, 0xff];

export interface Raster {
  readonly width: number;
  readonly height: number;
  /** 3 for RGB, 4 for RGBA. Preserved through a re-encode so the output is the same kind of image
   *  as the input rather than a silently converted one. */
  readonly channels: 3 | 4;
  /** Row-major, `width * channels` bytes per row, with no per-row filter byte. */
  readonly data: Uint8Array;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

// ---------------------------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------------------------

export function decodePng(bytes: Uint8Array): Raster {
  for (const [index, expected] of SIGNATURE.entries()) {
    if (bytes[index] !== expected) throw new BrowserSurfaceError("not a PNG: bad signature");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels: 3 | 4 = 3;
  const idat: Uint8Array[] = [];

  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4] as number,
      bytes[offset + 5] as number,
      bytes[offset + 6] as number,
      bytes[offset + 7] as number,
    );
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const bitDepth = bytes[offset + 16] as number;
      const colourType = bytes[offset + 17] as number;
      const interlace = bytes[offset + 20] as number;
      if (bitDepth !== 8 || interlace !== 0 || (colourType !== 2 && colourType !== 6)) {
        throw new BrowserSurfaceError(
          [
            `unsupported PNG: bitDepth=${bitDepth} colourType=${colourType} interlace=${interlace};`,
            "this codec handles the 8-bit non-interlaced RGB and RGBA forms a browser screenshot uses",
          ].join(" "),
        );
      }
      channels = colourType === 2 ? 3 : 4;
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (width === 0 || height === 0 || idat.length === 0) {
    throw new BrowserSurfaceError("unsupported PNG: no image data");
  }
  const raw = inflateSync(Buffer.concat(idat));
  return { width, height, channels, data: unfilter(raw, width, height, channels) };
}

/**
 * Undo the per-scanline filter. Five types, and all five appear in a real screenshot - Chromium's
 * encoder picks per row - so a decoder that only handles `None` produces a picture that is
 * recognisable and wrong, which is the worst outcome for a test that inspects pixels.
 */
function unfilter(raw: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  let source = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source] as number;
    source += 1;
    const rowStart = y * stride;
    const priorStart = rowStart - stride;
    for (let i = 0; i < stride; i += 1) {
      // Typed-array reads inside a bound loop never yield undefined; the casts are type-level only.
      const value = raw[source + i] as number;
      const left = i >= channels ? (out[rowStart + i - channels] as number) : 0;
      const up = y > 0 ? (out[priorStart + i] as number) : 0;
      const upLeft = y > 0 && i >= channels ? (out[priorStart + i - channels] as number) : 0;
      let restored: number;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + up;
          break;
        case 3:
          restored = value + ((left + up) >> 1);
          break;
        case 4:
          restored = value + paeth(left, up, upLeft);
          break;
        default:
          throw new BrowserSurfaceError(`unsupported PNG scanline filter ${filter}`);
      }
      out[rowStart + i] = restored & 0xff;
    }
    source += stride;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// ---------------------------------------------------------------------------------------------
// Blank
// ---------------------------------------------------------------------------------------------

/**
 * Fill each region with an opaque colour, in place, and report how many actually covered pixels.
 *
 * The count is returned rather than the region count because that is what `Capture.maskedRegions`
 * should mean: a rectangle that fell entirely outside the image masked nothing, and reporting it as
 * a mask would make a leak look like a redaction in the journal.
 */
export function blankRegions(
  raster: Raster,
  regions: readonly Rect[],
  colour: readonly [number, number, number] = MASK_COLOUR,
): number {
  const { width, height, channels, data } = raster;
  let applied = 0;
  for (const region of regions) {
    const x0 = Math.max(0, Math.min(width, Math.floor(region.x)));
    const y0 = Math.max(0, Math.min(height, Math.floor(region.y)));
    const x1 = Math.max(0, Math.min(width, Math.ceil(region.x + region.w)));
    const y1 = Math.max(0, Math.min(height, Math.ceil(region.y + region.h)));
    if (x1 <= x0 || y1 <= y0) continue;
    applied += 1;
    for (let y = y0; y < y1; y += 1) {
      let index = (y * width + x0) * channels;
      for (let x = x0; x < x1; x += 1) {
        data[index] = colour[0];
        data[index + 1] = colour[1];
        data[index + 2] = colour[2];
        if (channels === 4) data[index + 3] = 0xff;
        index += channels;
      }
    }
  }
  return applied;
}

/** The pixel at a point, as `[r, g, b, a]`. `a` is 255 on an RGB image, which is what it means. */
export function pixelAt(
  raster: Raster,
  x: number,
  y: number,
): readonly [number, number, number, number] {
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) {
    throw new BrowserSurfaceError(
      `pixel (${x}, ${y}) is outside a ${raster.width}x${raster.height} image`,
    );
  }
  const index = (y * raster.width + x) * raster.channels;
  return [
    raster.data[index] as number,
    raster.data[index + 1] as number,
    raster.data[index + 2] as number,
    raster.channels === 4 ? (raster.data[index + 3] as number) : 0xff,
  ];
}

// ---------------------------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------------------------

/** Re-encode with every scanline filtered `None`. Bigger than Chromium's output and byte-for-byte
 *  reproducible, which is what a content-addressed evidence blob wants. */
export function encodePng(raster: Raster): Uint8Array {
  const { width, height, channels, data } = raster;
  const stride = width * channels;
  const rows = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    rows[y * (stride + 1)] = 0;
    rows.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = channels === 3 ? 2 : 6;
  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

function chunk(type: string, body: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + body.byteLength);
  out.writeUInt32BE(body.byteLength, 0);
  out.write(type, 4, "ascii");
  Buffer.from(body).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.byteLength)), 8 + body.byteLength);
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
