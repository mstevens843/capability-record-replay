// Fill the reviewer's template with the two facts the reviewer is not allowed to assert.
//
// `promotion.template.json` is hand-authored: the outcome code, the caller-facing prose, the
// `stableUnderRetryBecause` judgement, the detector predicate, the vocabulary and the step. This
// script substitutes only `__STEP__`, `__OBSERVATION__`, `__RUN__` and `__CORPUS__`, and it reads
// the first three OUT OF THE RUN JOURNAL rather than taking them from a person - which is the same
// rule `crr promote` enforces on the other side, where the journal's `evidence.captured.stepId` is
// checked against whatever the review claims.
//
// Deterministic, no network, no model. Run as:
//   node evidence/outcome-promotion/review/build-review.mjs <journal.jsonl> <stepId> <out.json> <corpusDir>...

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const [journalPath, stepId, outPath, ...corpus] = process.argv.slice(2);
if (journalPath === undefined || stepId === undefined || outPath === undefined) {
  throw new Error("usage: build-review.mjs <journal.jsonl> <stepId> <out.json> <corpusDir>...");
}

let runId = null;
let observation = null;
for (const line of readFileSync(journalPath, "utf8").split("\n")) {
  if (line.trim().length === 0) continue;
  const event = JSON.parse(line);
  if (event.type === "run.started") runId = event.runId;
  if (
    event.type === "evidence.captured" &&
    event.kind === "observation" &&
    event.stepId === stepId &&
    event.phase === "post"
  ) {
    observation = `sha256:${String(event.ref).slice("obs:".length)}`;
  }
}
if (runId === null) throw new Error(`${journalPath} names no run`);
if (observation === null) throw new Error(`${journalPath} froze no post-phase screen at ${stepId}`);

const template = readFileSync(join(HERE, "promotion.template.json"), "utf8");
const filled = template
  .split("__STEP__")
  .join(stepId)
  .split("__OBSERVATION__")
  .join(observation)
  .split("__RUN__")
  .join(runId);
const review = JSON.parse(filled);
review.evidence.corpusRefs = corpus;
writeFileSync(outPath, `${JSON.stringify(review, null, 2)}\n`);
process.stdout.write(`review written  ${outPath}\n  step ${stepId}\n  positive ${observation}\n  from run ${runId}\n`);
