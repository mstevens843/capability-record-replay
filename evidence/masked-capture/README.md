# masked-capture

**Region masking of a screenshot area bound to a sensitive parameter** (BRIEF §3.7, SPEC §8.4).

A value is typed into the deposit field with `sensitive: true`. From that moment the driver
blanks that node's `value` in every observation it produces; `@crr/core`'s `deriveMaskRegions`
turns the blanked node's geometry into rectangles, `safeCaptureRequest` **refuses the capture
outright** if any sensitive node has no geometry to mask, and the driver blanks those pixels
before the bytes leave `capture()`. The ref and the digest are over the masked bytes, so
nothing unmasked is addressable.

The unmasked screenshot was taken in memory only, to prove the mask changed the bytes, and
was never written to disk. `capture.json` records the rectangles and both digests.

The redaction canary scans this PNG's bytes and inflates its `tEXt`/`zTXt`/`iTXt` chunks. It
**cannot** see into the pixel stream - that is what the pixel-level assertions in
`packages/surface-browser/test/browser-capture.test.ts` are for, and saying so is the
difference between a check and a claim.
