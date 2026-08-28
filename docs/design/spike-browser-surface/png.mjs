import zlib from 'node:zlib';
/** Minimal non-interlaced PNG decoder -> { w, h, px(x,y) => [r,g,b,a] }. Enough to verify pixels. */
export function decodePng(buf) {
  let o = 8, w = 0, h = 0, bitDepth = 0, colorType = 0; const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o); const type = buf.toString('ascii', o + 4, o + 8); const data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; if (data[12] !== 0) throw new Error('interlaced'); }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('bitDepth ' + bitDepth);
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]; if (!ch) throw new Error('colorType ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch; const out = Buffer.alloc(h * stride);
  const pa = (i, r) => (i >= ch ? out[r * stride + i - ch] : 0);
  const pb = (i, r) => (r > 0 ? out[(r - 1) * stride + i] : 0);
  const pc = (i, r) => (i >= ch && r > 0 ? out[(r - 1) * stride + i - ch] : 0);
  for (let r = 0; r < h; r++) {
    const ft = raw[r * (stride + 1)]; const line = raw.subarray(r * (stride + 1) + 1, (r + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const x = line[i]; let v;
      if (ft === 0) v = x; else if (ft === 1) v = x + pa(i, r); else if (ft === 2) v = x + pb(i, r);
      else if (ft === 3) v = x + ((pa(i, r) + pb(i, r)) >> 1);
      else { const a = pa(i, r), b = pb(i, r), c = pc(i, r), p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
             v = x + (da <= db && da <= dc ? a : db <= dc ? b : c); }
      out[r * stride + i] = v & 0xff;
    }
  }
  return { w, h, px(x, y) { const i = y * stride + x * ch; return ch >= 3 ? [out[i], out[i+1], out[i+2], ch === 4 ? out[i+3] : 255] : [out[i], out[i], out[i], 255]; } };
}
