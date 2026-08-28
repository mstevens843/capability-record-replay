// Emit the capability documents the runtime replays.
//
//   pnpm -F @crr/discovery fixtures:synthesized
//
// Hermetic: no browser, no clock, no credential, no network. It reads the committed observation
// corpus, runs the real discovery loop over a `MockSurface` built from it, runs the real synthesis,
// and writes the contract, the artifact and the synthesis report to one JSON file.
//
// THAT FILE IS THE SEAM. `packages/runtime/test/synthesized-replay.test.ts` reads it back with
// `parseContract`/`parseArtifact` - no import of this package, no shared type, nothing but a
// document with a digest - and executes it against the live fixture through the real interpreter.
// Run this, and the artifact the runtime executes changes; that is exactly the coupling FINAL-STATUS
// section 7.2 says had never been established.
//
// `test/synthesis-corebank-web.test.ts` re-runs `emittedBytes()` in process and compares the bytes,
// so an edit to synthesis that nobody re-emitted is a RED TEST rather than a surprise on a live run.
//
// This module is an ENTRY POINT: importing it writes the file. Everything reusable lives in
// `corebank-web.ts`, so a test can rebuild the document without touching the working tree.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITY_FILE, OBSERVATIONS_FILE, emittedBytes } from "./corebank-web.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const bytes = await emittedBytes(HERE);
writeFileSync(join(HERE, CAPABILITY_FILE), bytes, "utf8");
process.stdout.write(`wrote ${CAPABILITY_FILE}: ${bytes.length} bytes from ${OBSERVATIONS_FILE}\n`);
