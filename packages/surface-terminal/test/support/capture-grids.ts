// Regenerate `test/fixtures/grids.json`.
//
//   pnpm -F @crr/surface-terminal exec tsx test/support/capture-grids.ts
//
// The corpus is COMMITTED, not generated at test time, and that is the whole point: the detector's
// assertions then run against bytes that were reviewed in a pull request rather than against
// whatever the fixture happens to paint today. If a change to the fixture changes what the driver
// sees, the diff of this file is where that becomes visible - which is exactly what you want, and
// exactly what a test that regenerated its own inputs would hide.
//
// Every grid below is a real capture: the fixture app painted it, `@xterm/headless` parsed it, and
// the encoder is asserted lossless in `test/grid-codec.test.ts`.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type EncodedGrid, encodeGrid } from "../../src/grid-codec.js";
import { openTeller } from "./teller.js";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../fixtures/grids.json");

async function main(): Promise<void> {
  const grids: Record<string, EncodedGrid> = {};

  // --- the riverbend happy path and its three status outcomes.
  const t = await openTeller({});
  grids.initial = encodeGrid(await t.grid());
  await t.send("12345");
  grids.typed = encodeGrid(await t.grid());
  await t.send("\t");
  grids.tabbed = encodeGrid(await t.grid());
  await t.send("\t\r");
  grids.detail = encodeGrid(await t.grid());
  await t.send("\x1b[B\x1b[B");
  grids.arrowed = encodeGrid(await t.grid());
  await t.send("\r");
  grids.opened = encodeGrid(await t.grid());
  await t.send("\x1bOR"); // F3 back to the inquiry screen
  await t.send("77777\r");
  grids.notfound = encodeGrid(await t.grid());
  await t.send("\x7f\x7f\x7f\x7f\x7f99999\r");
  grids.denied = encodeGrid(await t.grid());
  await t.send("\x7f\x7f\x7f\x7f\x7fABC\r");
  grids.invalid = encodeGrid(await t.grid());
  await t.close();

  // --- the torn read. Snapshot while the app is mid-repaint and silent, then again once the rest
  //     of the frame arrives. These two grids are the acceptance case for the whole unit.
  const torn = await openTeller({ fault: "torn-repaint", delayMs: 600, quietMs: 15 });
  grids.torn = encodeGrid(await torn.grid());
  await torn.quiet(800);
  grids.tornWhole = encodeGrid(await torn.grid());
  await torn.close();

  // --- the two transition faults.
  const timeout = await openTeller({ fault: "session-timeout" });
  await timeout.send("12345\r");
  grids.signon = encodeGrid(await timeout.grid());
  await timeout.close();

  const abend = await openTeller({ fault: "app-error" });
  await abend.send("12345\r");
  grids.abend = encodeGrid(await abend.grid());
  await abend.close();

  // --- the second tenant. Same vendor product, different branding, labels, geometry and exit key.
  const summit = await openTeller({ tenant: "summit" });
  grids.summitInitial = encodeGrid(await summit.grid());
  await summit.send("12345\r");
  grids.summitDetail = encodeGrid(await summit.grid());
  await summit.close();

  writeFileSync(OUT, `${JSON.stringify(grids, null, 1)}\n`, "utf8");
  process.stdout.write(`wrote ${Object.keys(grids).length} grids to ${OUT}\n`);
}

await main();
