// An independent PNG codec, written for the tests only.
//
// It exists so the masking assertions are not self-confirming. If `src/png.ts` encoded and decoded
// with the same misunderstanding, a round-trip test would pass green while the bytes on disk were
// wrong - and the whole point of the mask test is that the BYTES are right. So the test decodes with
// this and encodes with this, and `src/png.ts` is checked against it in both directions.
//
// It also lets a test hand-build a PNG that uses all five scanline filters, which is what a real
// browser screenshot does and what `src/png.ts`'s `unfilter` has to get right.

import { deflateSync, inflateSync } from "node:zlib";

export interface RefImage {
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
  readonly data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function refDecode(bytes: Uint8Array): RefImage {
  const buffer = Buffer.from(bytes);
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("ref: not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels: 3 | 4 = 3;
  const idat: Buffer[] = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8) throw new Error(`ref: bit depth ${String(body[8])}`);
      if (body[9] !== 2 && body[9] !== 6) throw new Error(`ref: colour type ${String(body[9])}`);
      channels = body[9] === 2 ? 3 : 4;
    } else if (type === "IDAT") {
      idat.push(Buffer.from(body));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  let source = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source++] as number;
    for (let i = 0; i < stride; i += 1) {
      const value = raw[source + i] as number;
      const a = i >= channels ? (out[y * stride + i - channels] as number) : 0;
      const b = y > 0 ? (out[(y - 1) * stride + i] as number) : 0;
      const c = y > 0 && i >= channels ? (out[(y - 1) * stride + i - channels] as number) : 0;
      const restored =
        filter === 0
          ? value
          : filter === 1
            ? value + a
            : filter === 2
              ? value + b
              : filter === 3
                ? value + ((a + b) >> 1)
                : value + paeth(a, b, c);
      out[y * stride + i] = restored & 0xff;
    }
    source += stride;
  }
  return { width, height, channels, data: new Uint8Array(out) };
}

/** Encode with a caller-chosen filter per row, so a test can exercise all five branches. */
export function refEncode(image: RefImage, filters: readonly number[] = [0]): Uint8Array {
  const stride = image.width * image.channels;
  const rows = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const filter = filters[y % filters.length] as number;
    rows[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i += 1) {
      const raw = image.data[y * stride + i] as number;
      const a = i >= image.channels ? (image.data[y * stride + i - image.channels] as number) : 0;
      const b = y > 0 ? (image.data[(y - 1) * stride + i] as number) : 0;
      const c =
        y > 0 && i >= image.channels
          ? (image.data[(y - 1) * stride + i - image.channels] as number)
          : 0;
      const encoded =
        filter === 0
          ? raw
          : filter === 1
            ? raw - a
            : filter === 2
              ? raw - b
              : filter === 3
                ? raw - ((a + b) >> 1)
                : raw - paeth(a, b, c);
      rows[y * (stride + 1) + 1 + i] = encoded & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8;
  ihdr[9] = image.channels === 3 ? 2 : 6;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function refPixel(image: RefImage, x: number, y: number): readonly [number, number, number] {
  const index = (y * image.width + x) * image.channels;
  return [
    image.data[index] as number,
    image.data[index + 1] as number,
    image.data[index + 2] as number,
  ];
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function chunk(type: string, body: Buffer): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "ascii");
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

const TABLE = (() => {
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
  for (const byte of bytes) crc = (TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
