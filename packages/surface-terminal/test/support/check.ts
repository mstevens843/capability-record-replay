// Dev tool: dump every frozen grid's detection, and probe one target resolution.
//
//   pnpm -F @crr/surface-terminal exec tsx test/support/check.ts
//
// Not a test - it asserts nothing. It exists because the fastest way to understand why a detector
// heuristic did something on an 80x24 grid is to look at every node it emitted next to the grid it
// emitted them from, and reading that out of a failing assertion's diff is much slower.

import { readFileSync } from "node:fs";
import { detect } from "../../src/detect.js";
import { type GridCorpus, decodeCorpus } from "../../src/grid-codec.js";

const corpus = decodeCorpus(
  JSON.parse(
    readFileSync(new URL("../fixtures/grids.json", import.meta.url), "utf8"),
  ) as GridCorpus,
);

for (const [name, grid] of Object.entries(corpus)) {
  const screen = detect(grid);
  process.stdout.write(`\n=== ${name}  screenId=${JSON.stringify(screen.screenId)}\n`);
  for (const node of screen.nodes) {
    process.stdout.write(
      `   ${node.id.padEnd(34)} role=${node.role.padEnd(8)} name=${JSON.stringify(node.name)}` +
        ` value=${JSON.stringify(node.value)} key=${node.key} cap=${node.capacity}` +
        ` focus=${node.state.focused} conf=${node.confidence} cols=${JSON.stringify(node.columns)}` +
        ` anchor=${JSON.stringify(node.anchor)} bounds=${JSON.stringify(node.bounds)}\n`,
    );
    for (const row of node.children ?? []) {
      process.stdout.write(
        `        row${row.index} sel=${row.state.selected} cells=${JSON.stringify(row.cells)}\n`,
      );
    }
  }
}
