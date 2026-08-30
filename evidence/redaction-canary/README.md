# redaction-canary

`report.txt` and `report.json` are the output of `runRedactionCanary()` over this whole
directory tree, run at the end of `pnpm demo`. It greps every byte that was written for every
**parameter value** the runs were given, in fourteen encodings, and `pnpm demo` exits non-zero
if it finds one.

## Three properties that make it worth trusting

1. **It proves it can fire, on every run.** Before scanning, it plants each needle in a
   synthetic buffer and asserts the same matcher finds it. `self-test PASSED` in the report is
   that check; a report whose self-test failed is `clean: false` no matter how few hits it
   found. `packages/runtime/test/canary.test.ts` injects a real leak in each encoding.
2. **The report never contains a value.** Hits carry a label and a context excerpt with every
   known value blanked. This report is written into the bundle it just scanned - one that
   quoted its own finding would be the leak.
3. **Nothing is silently dropped.** A coincidental match inside a 40+ character hexadecimal run
   (a sha256 digest) is listed under `suppressed` rather than deleted. That costs nothing: a
   value genuinely hex-encoded into a blob is caught by the `hex-lower`/`hex-upper` needles.

## What it covers, and what it cannot

It scans **file contents, file names, and a PNG's inflated `tEXt`/`zTXt`/`iTXt` chunks**, and
the `not searched` lines name every (value, encoding) pair for which no usable needle could be
built, so the coverage claim is checkable rather than asserted. It
cannot see through compression or encryption, so a screenshot's pixel stream is out of reach;
the defence there is the mask, verified at the pixel in
`packages/surface-browser/test/browser-capture.test.ts`.

It searches for **parameter values** - the caller's inputs, which the taint model says must
never be persisted. It deliberately does **not** search for screen-read outputs such as the
member's name: the result contract exists to deliver those to the caller, and a check that
flagged them would be checking the wrong thing.
