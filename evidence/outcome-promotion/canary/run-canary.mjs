// The redaction canary over `evidence/outcome-promotion/`, in two scopes.
//
// It is the SAME function `pnpm demo` runs over the whole bundle - `runRedactionCanary` from
// `@crr/runtime`, imported here from the built `dist/` by relative path so this file needs no
// package resolution of its own. Nothing here reaches a model, a credential or the network.
//
// WHY TWO SCOPES, and this is the argument rather than the code. Two classes of occurrence are
// different in kind, and one gate over both would either be unpassable or worthless:
//
//   1. THE DOCUMENTS AND THE RECORDS - every observation, journal, result, contract, artifact,
//      review and console this exercise wrote. A caller's argument has no business being in any of
//      them: `memberId` is declared `sensitive` on the contract, so the taint model substitutes a
//      handle before a byte is written. This pass GATES. It found a real leak the first time it
//      ran (`observedSummaryOf` passed the observed route's query straight through, so the member
//      number reached the journal's `classified` line and the result document's failure trace);
//      the fix is in `packages/core/src/evaluate.ts` and the regression test is
//      `packages/core/test/render.test.ts`.
//   2. THE REPRODUCTION - `README.md` and `reproduce.sh`, where the argument appears because the
//      COMMAND is the deliverable. BRIEF section 0 requires the command to be printed next to the
//      claim, and a command with its argument removed is not a command. This pass REPORTS every
//      occurrence with its line number and gates on nothing, which is exactly what the live
//      discovery bundle's fourth pass does for the same reason.
//
// The two scopes are complements, so a file added later is covered by one of them by default.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderCanaryReport, runRedactionCanary } from "../../../packages/runtime/dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, "..");

/** The values these runs were GIVEN. Every one is an obviously synthetic fixture member number. */
const SECRETS = [
  { label: "green probe + re-verification + green invocation / args.memberId", value: "10043" },
  { label: "absent-member probe + before/after invocation / args.memberId", value: "10099" },
  { label: "malformed-number probe / args.memberId", value: "7777" },
];

/** The reproduction files: the two places a command line is quoted. */
const REPRODUCTION = new Set(["README.md", "reproduce.sh"]);

function pass(id, gating, skip) {
  const report = runRedactionCanary({ bundleDir: BUNDLE, secrets: SECRETS, skip });
  writeFileSync(join(HERE, `${id}.json`), `${JSON.stringify(report, null, 2)}\n`);
  return { id, gating, report };
}

const passes = [
  pass("documents", true, (path) => REPRODUCTION.has(path) || path.startsWith("canary/")),
  pass("reproduction", false, (path) => !REPRODUCTION.has(path)),
];

const lines = [
  "redaction canary - evidence/outcome-promotion/",
  "",
  `run by  node evidence/outcome-promotion/canary/run-canary.mjs`,
  "",
];
for (const { id, gating, report } of passes) {
  lines.push(
    `pass ${id}  ${gating ? "GATING" : "reporting only"}`,
    `  files      ${report.filesScanned}`,
    `  bytes      ${report.bytesScanned}`,
    `  needles    ${report.needles} over ${report.secrets.length} value(s) x ${report.encodings.length} encoding(s)`,
    `  self-test  ${report.selfTest.ok ? "PASSED" : `FAILED - missed ${report.selfTest.missed.join(", ")}`} (${report.selfTest.found}/${report.selfTest.planted} planted needles found)`,
    `  hits       ${report.hits.length}`,
    `  suppressed ${report.suppressed.length} (inside an opaque 40+ character hex run)`,
    `  forbidden  ${report.forbidden.length}`,
    `  verdict    ${report.clean ? "CLEAN" : "NOT CLEAN"}`,
  );
  for (const hit of report.hits) {
    lines.push(`    ${hit.file}:${hit.line ?? "?"}  ${hit.secret}  [${hit.encoding}]`);
  }
  for (const hit of report.forbidden) {
    lines.push(`    FORBIDDEN ${hit.name} in ${hit.file}:${hit.line ?? "?"}`);
  }
  lines.push("");
}

const gate = passes.find((p) => p.gating);
lines.push(
  gate.report.clean
    ? "GATE: the documents and records this exercise wrote hold no caller argument, in any of the encodings above."
    : "GATE FAILED: see the hits above.",
  "",
);
writeFileSync(join(HERE, "report.txt"), `${lines.join("\n")}\n`);
process.stdout.write(`${lines.join("\n")}\n`);
process.stdout.write(renderCanaryReport(gate.report));
process.exitCode = gate.report.clean ? 0 : 1;
