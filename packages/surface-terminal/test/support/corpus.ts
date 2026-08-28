// The committed grid corpus, decoded once.
//
// Every grid in `test/fixtures/grids.json` was painted by the real fixture app and parsed by the
// real emulator; see `capture-grids.ts` for how to regenerate it and why it is committed rather
// than produced at test time.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type DetectedNode, type DetectedScreen, detect } from "../../src/detect.js";
import { type GridCorpus, decodeCorpus } from "../../src/grid-codec.js";
import type { Grid } from "../../src/grid.js";

const here = dirname(fileURLToPath(import.meta.url));
export const CORPUS_PATH = resolve(here, "../fixtures/grids.json");

export const RAW_CORPUS = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as GridCorpus;

/** Named grids: `initial`, `typed`, `tabbed`, `detail`, `arrowed`, `opened`, `notfound`, `denied`,
 *  `invalid`, `torn`, `tornWhole`, `signon`, `abend`, `summitInitial`, `summitDetail`. */
export const GRIDS: Readonly<Record<string, Grid>> = decodeCorpus(RAW_CORPUS);

export const grid = (name: string): Grid => {
  const found = GRIDS[name];
  if (found === undefined) throw new Error(`no frozen grid named "${name}"`);
  return found;
};

export const screen = (name: string): DetectedScreen => detect(grid(name));

export const nodeById = (s: DetectedScreen, id: string): DetectedNode | undefined =>
  s.nodes.find((n) => n.id === id);

export const nodesByRole = (s: DetectedScreen, role: DetectedNode["role"]): DetectedNode[] =>
  s.nodes.filter((n) => n.role === role);
