// Prints the digests `test/tool-schema.test.ts` pins. Run it when a deliberate change to the model
// facing surface needs a new golden value:
//
//   pnpm -F @crr/discovery fixtures:digests

import { digestOf } from "@crr/core";
import { DISCOVERY_SYSTEM_PROMPT, DISCOVERY_TOOLS } from "../../src/index.js";

process.stdout.write(`tools  ${digestOf(DISCOVERY_TOOLS)}\n`);
process.stdout.write(`prompt ${digestOf(DISCOVERY_SYSTEM_PROMPT)}\n`);
