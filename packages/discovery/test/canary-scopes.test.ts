// Which file each redaction pass covers, asserted rather than argued.
//
// FINAL-STATUS section 7.2 is the reason this file exists, and the shape of the gap is the reason
// it is shaped like this. `provenance.json` was in the credential pass and in no other, so it was
// checked for `sk-ant-` and never for a member's name - and the writer had every opportunity to put
// one there, because `run.summary` is the model's free prose about what it saw. Nothing was leaking.
// What was missing was a check that would have said so.
//
// The gap survived review because the four scopes were four `skip` closures in the middle of a
// script with top-level `await` in it. Nothing could import them, so answering "which gating pass
// covers this file?" meant reading four closures with the bundle's file list held in your head.
// `tools/canaries.ts` makes a pass DATA - a scope predicate, a needle class, and whether it gates -
// and this file is what that buys: the question asked mechanically, of every path in the bundle
// that actually shipped.
//
// FOUR THINGS ARE ASSERTED, and they are different claims.
//
//   1. COVERAGE, over the REAL evidence bundle read off disk. Every path in
//      `evidence/discovery-live/` is covered by a gating pass, and the files that describe the run
//      rather than record it are covered by a gating pass that searches for RECORDED MEMBER DATA.
//      The exemptions are enumerated here, so widening one means editing this file.
//
//   2. THE NEEDLES, derived by the shipping function from a real recording. Two searchable values
//      and one below the floor, reported rather than dropped - the same three the live run had.
//
//   3. DISCRIMINATION. A member's name planted in `provenance.json` FAILS pass 5, naming the file
//      and the needle; removed, the same bytes pass. And the two places that datum legitimately
//      lives - the recording and the replay result - do not fail anything, because a gate that
//      fires on those is a gate somebody deletes.
//
//   4. THE RUNNER STILL WIRES IT. `discover.ts` is read off disk, because it cannot be imported.
//
// WHAT THE SCANNER HERE IS, AND IS NOT. `@crr/discovery` declares no dependency on `@crr/runtime`
// and must not - the package that owns the model loop has no business depending on an interpreter,
// and `packages/core/test/no-locator-vocabulary.test.ts` reads `packages/discovery/src` off disk to
// say so. The runner resolves the real `runRedactionCanary` by path at startup and hands it in;
// that seam is exactly why `CanaryScan` is a parameter. So this file injects a stand-in that does a
// plain byte search in two casings, and it PROVES THE STAND-IN CAN FAIL before trusting it, which
// is the standard the real canary holds itself to. What that combination establishes is ROUTING:
// that the right needles reach the right files. That the scanner itself finds a value in fourteen
// encodings, inside a PNG chunk and in a file NAME, is `@crr/runtime`'s `redaction.test.ts` and the
// real canary's own per-run self-test. Neither claim covers the other and neither is asserted here
// as though it did.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { DiscoveryRun } from "../src/index.js";
import { type SpendSnapshot, writeCoreBundle, writeJson, writeText } from "../tools/bundle.js";
import {
  CANARY_SCOPES,
  type CanaryHitView,
  type CanaryScan,
  type CanarySecretView,
  KNOWN_UNSCANNED,
  MIN_NEEDLE_LENGTH,
  RECORDING_FILES,
  canaryNeedlesOf,
  gatingMemberDataScopesFor,
  runCanaryPasses,
} from "../tools/canaries.js";
import { LIVE_MEMBER_ID, type ModelRate, rateFor } from "../tools/live-run.js";
import { FROZEN_NOW, loadCorpus, recordedRun } from "./fixtures/corebank-web.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const LIVE_BUNDLE = join(REPO, "evidence", "discovery-live");

const corpus = loadCorpus();

/** Every path in the committed live bundle, walked once. */
const LIVE_PATHS = walk(LIVE_BUNDLE);

// ---------------------------------------------------------------------------------------------
// A scanner that is proved able to fail before it is believed
// ---------------------------------------------------------------------------------------------

function walk(root: string): readonly string[] {
  // A clear sentence rather than an ENOENT stack out of test collection. `evidence/discovery-live`
  // is a committed deliverable; a suite that cannot find it has a wrong path, not a missing run.
  if (!existsSync(root)) throw new Error(`canary-scopes: expected an evidence bundle at ${root}`);
  const out: string[] = [];
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const parent = (entry as { parentPath?: string; path?: string }).parentPath ?? entry.path;
    const absolute = join(parent, entry.name);
    if (!statSync(absolute).isFile()) continue;
    out.push(relative(root, absolute).split(sep).join("/"));
  }
  return out.sort();
}

/**
 * A plain substring search, in the file's bytes and in its name, folded and unfolded.
 *
 * Deliberately much weaker than the shipping scanner. It is here to route needles at scopes, not to
 * stand in for fourteen encodings, and the header says so. `selfTest` is not decoration: if it ever
 * reports `ok: false` the report is `clean: false` whatever the hit count, which is the one rule
 * that stops a scanner passing by scanning nothing.
 */
const standIn: CanaryScan = (options) => {
  const skip = options.skip ?? (() => false);
  const files = walk(options.bundleDir).filter((path) => !skip(path));
  const hits: CanaryHitView[] = [];
  let bytesScanned = 0;

  for (const file of files) {
    const bytes = readFileSync(join(options.bundleDir, file));
    bytesScanned += bytes.length;
    for (const view of [
      { name: "bytes", text: bytes.toString("utf8") },
      { name: "path", text: file },
    ]) {
      for (const secret of options.secrets) {
        if (secret.value.length === 0) continue;
        const at = view.text.toLowerCase().indexOf(secret.value.toLowerCase());
        if (at < 0) continue;
        hits.push({
          file,
          view: view.name,
          secret: secret.label,
          encoding: "utf8",
          line: view.text.slice(0, at).split("\n").length,
        });
      }
    }
  }

  const missed = options.secrets
    .filter((secret) => `filler ${secret.value} filler`.indexOf(secret.value) !== 7)
    .map((secret) => secret.label);
  const selfTest = {
    ok: missed.length === 0,
    planted: options.secrets.length,
    found: options.secrets.length - missed.length,
  };

  return {
    clean: hits.length === 0 && selfTest.ok,
    filesScanned: files.length,
    bytesScanned,
    needles: options.secrets.length,
    skippedEncodings: [],
    hits,
    suppressed: [],
    forbidden: [],
    selfTest,
  };
};

// ---------------------------------------------------------------------------------------------
// A bundle written by the shipping writer, into a directory that is not `evidence/`
// ---------------------------------------------------------------------------------------------

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const EMPTY_LEDGER: SpendSnapshot = { spentUsd: 0, billed: 0, turns: [] };

/** The published rate table entry the runner uses. Non-null by construction; `rateFor` is
 *  nullable because an unknown model id is a refusal rather than a guess. */
const RATE: ModelRate = (() => {
  const rate = rateFor("claude-opus-5");
  if (rate === null) throw new Error("claude-opus-5 is missing from MODEL_RATES");
  return rate;
})();

/**
 * `provenance.json`, `spend.json` and `README.md` from the real `writeCoreBundle`, plus a stand-in
 * for each of the other three scopes.
 *
 * The metadata files are the real writer's output on purpose: pass 5's whole subject is what that
 * function puts in them, and a hand-written `provenance.json` would test a fixture rather than the
 * thing that shipped. The other three are one file each, because what is being asserted about them
 * is which pass reads them, not what is in them.
 */
function bundle(run: DiscoveryRun): string {
  const dir = mkdtempSync(join(tmpdir(), "crr-canary-scopes-"));
  temps.push(dir);

  writeCoreBundle({
    outDir: dir,
    flags: { dryRun: false, effort: "high", maxUsd: 2, maxOutputTokens: 2000, maxTotalTokens: 1 },
    run,
    transcript: null,
    transcriptProblem: "this bundle is written by a test; there is no recording",
    recordedAt: FROZEN_NOW,
    adapter: "scripted",
    modelId: "synthetic-script",
    tenantId: "riverbend",
    entryRoute: "/search",
    driver: "mock",
    rate: RATE,
    spend: EMPTY_LEDGER,
    verification: null,
    lifecycle: null,
  });

  writeText(join(dir, "discovery.log"), "the runner's output\n");
  writeJson(join(dir, "transcript.json"), { turns: [] });
  writeText(join(dir, "journal.jsonl"), "{}\n");
  writeJson(join(dir, "verification.json"), { status: "verified" });
  mkdirSync(join(dir, "synthesized"), { recursive: true });
  writeJson(join(dir, "synthesized", "report.json"), { notes: [] });
  return dir;
}

/** Append a line to a file already in the bundle, and hand back a function that restores it. */
function plant(dir: string, file: string, line: string): () => void {
  const path = join(dir, file);
  const before = readFileSync(path);
  writeText(path, `${before.toString("utf8")}${line}\n`);
  return () => {
    writeText(path, before.toString("utf8"));
    expect(readFileSync(path).equals(before), `${file} was not restored byte-identically`).toBe(
      true,
    );
  };
}

function passesOver(dir: string, run: DiscoveryRun) {
  return runCanaryPasses({
    scan: standIn,
    bundleDir: dir,
    needles: canaryNeedlesOf({ run, memberId: LIVE_MEMBER_ID }),
  });
}

function passNamed(outcome: ReturnType<typeof passesOver>, id: string) {
  const pass = outcome.passes.find((candidate) => candidate.id === id);
  if (pass === undefined) throw new Error(`no canary pass ${id}`);
  return pass;
}

// ---------------------------------------------------------------------------------------------
// 1. Coverage, over the bundle that actually shipped
// ---------------------------------------------------------------------------------------------

/**
 * The paths in `evidence/discovery-live/` a gating member-data pass is NOT expected to cover, and
 * the argument for each. Any other path failing that check is the section 7.2 gap coming back.
 */
const MEMBER_DATA_LIVES_HERE_LEGITIMATELY: readonly { prefix: string; why: string }[] = [
  {
    prefix: "transcript.json",
    why: "the recording: the model was shown the results row, and a recording without it is a recording of a different conversation",
  },
  {
    prefix: "discovery.log",
    why: "the recording, as the runner printed it while the model was driving the application",
  },
  {
    prefix: "journal.jsonl",
    why: "the recording, as the discovery journal wrote it one policy-checked action at a time",
  },
  {
    prefix: "verification",
    why: "the replay RESULT is the outputs the caller asked the capability for; a gate here would forbid the capability from working",
  },
  ...KNOWN_UNSCANNED.map((entry) => ({ prefix: entry.prefix, why: entry.why })),
];

describe("every file in the evidence bundle is covered, and the exemptions are written down", () => {
  const paths = LIVE_PATHS;

  it("finds the committed live run, so this suite is scanning something", () => {
    // Not a formality. A path typo turns every assertion below into a vacuous truth over an empty
    // list, which is exactly the failure mode the whole file exists to prevent one level up.
    expect(paths.length).toBeGreaterThan(10);
    expect(paths).toContain("provenance.json");
    expect(paths).toContain("synthesized/artifact.json");
  });

  it.each(LIVE_PATHS)("%s is read by at least one gating pass", (path) => {
    const gating = CANARY_SCOPES.filter((scope) => scope.gates && scope.covers(path));
    expect(gating.map((scope) => scope.id).length).toBeGreaterThan(0);
  });

  it.each(LIVE_PATHS)("%s is gated for recorded member data, or exempt on the record", (path) => {
    const gating = gatingMemberDataScopesFor(path);
    const exemption = MEMBER_DATA_LIVES_HERE_LEGITIMATELY.find((entry) =>
      path.startsWith(entry.prefix),
    );
    if (gating.length > 0) {
      expect(exemption, `${path} is both gated and exempt - decide which`).toBeUndefined();
      return;
    }
    expect(
      exemption,
      `${path} is covered by no gating member-data pass and no exemption`,
    ).toBeDefined();
    expect(exemption?.why.length ?? 0).toBeGreaterThan(40);
  });

  it("puts the three files that describe the run into pass 5, and only pass 5", () => {
    for (const file of ["provenance.json", "spend.json", "README.md"]) {
      expect(
        gatingMemberDataScopesFor(file).map((scope) => scope.id),
        file,
      ).toEqual(["5 metadata"]);
    }
  });

  it("takes pass 5's scope as a complement, so a file added later is covered by default", () => {
    // The failure mode section 7.2 describes is a file nobody remembered to add to a list. With a
    // complement there is no list to forget: a name this repository has never written still lands
    // in pass 5, and exempting it means writing a reason into `KNOWN_UNSCANNED`.
    for (const invented of ["notes.json", "run-metadata/summary.json", "cost-breakdown.csv"]) {
      expect(
        gatingMemberDataScopesFor(invented).map((scope) => scope.id),
        invented,
      ).toEqual(["5 metadata"]);
    }
  });

  it("keeps `canary/` as the only hole, and says why in more than a word", () => {
    expect(KNOWN_UNSCANNED.map((entry) => entry.prefix)).toEqual(["canary/"]);
    for (const entry of KNOWN_UNSCANNED) expect(entry.why.length).toBeGreaterThan(60);
    expect(gatingMemberDataScopesFor("canary/report.txt")).toEqual([]);
  });

  it("gates four of the five passes, and not the recording", () => {
    expect(
      CANARY_SCOPES.map((scope) => `${scope.id}:${scope.gates ? "gates" : "reports"}`),
    ).toEqual([
      "1 documents:gates",
      "2 replay:gates",
      "3 credentials:gates",
      "4 recording:reports",
      "5 metadata:gates",
    ]);
  });

  it("gives every pass an id whose slug can name a file", () => {
    // The runner writes `canary/<slug>.json` from `id.split(" ")[1]`. Two passes sharing a slug
    // would silently overwrite one report with another.
    const slugs = CANARY_SCOPES.map((scope) => scope.id.split(" ")[1]);
    expect(new Set(slugs).size).toBe(CANARY_SCOPES.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z]+$/);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. The needles, derived from a real recording
// ---------------------------------------------------------------------------------------------

describe("the needles a run yields", () => {
  it("takes the two values that are long enough and reports the one that is not", async () => {
    const needles = canaryNeedlesOf({
      run: await recordedRun(corpus),
      memberId: LIVE_MEMBER_ID,
    });
    expect(needles.recordedMemberData.map((secret) => secret.value)).toEqual([
      "ALVAREZ, DANA (SYNTHETIC)",
      "1,204.55",
    ]);
    expect(needles.notSearched.map((entry) => entry.output)).toEqual(["accountStatus"]);
    expect(needles.notSearched[0]?.length).toBeLessThan(MIN_NEEDLE_LENGTH);
    expect(needles.notSearched[0]?.why).toContain("under the 8-character floor");
  });

  it("labels every needle without putting the value in the label", () => {
    // The reports are written INTO the bundle they scanned. A label carrying the value would be a
    // leak the next run finds, which is `@crr/runtime`'s canary design rule 2 restated here at the
    // one site that authors labels.
    const needles = canaryNeedlesOf({ run: fakeRun(["MEMBERNAME"]), memberId: LIVE_MEMBER_ID });
    for (const secret of [...needles.callerArgument, ...needles.recordedMemberData]) {
      expect(secret.label).not.toContain(secret.value);
    }
  });

  it("classifies the caller's argument apart from what was read off the screen", async () => {
    const needles = canaryNeedlesOf({
      run: await recordedRun(corpus),
      memberId: LIVE_MEMBER_ID,
    });
    expect(needles.callerArgument.map((secret) => secret.needleClass)).toEqual(["caller-argument"]);
    expect(new Set(needles.recordedMemberData.map((secret) => secret.needleClass))).toEqual(
      new Set(["recorded-member-data"]),
    );
  });
});

/** A run with nothing in it but the outputs a test wants needles for. */
function fakeRun(values: readonly string[]): DiscoveryRun {
  return {
    outputs: values.map((value, index) => ({
      outputName: `output${index}`,
      nodeId: "n1",
      observation: { nodes: [{ id: "n1", value, name: null, text: null }] },
    })),
  } as unknown as DiscoveryRun;
}

// ---------------------------------------------------------------------------------------------
// 3. Discrimination: the gate fires, on the right file, for the right value
// ---------------------------------------------------------------------------------------------

describe("pass 5 over the run's own account of itself", () => {
  it("passes the bundle the shipping writer produces", async () => {
    const run = await recordedRun(corpus);
    const outcome = passesOver(bundle(run), run);
    expect(passNamed(outcome, "5 metadata").report.hits).toEqual([]);
    expect(outcome.clean).toBe(true);
  });

  it("reads exactly the three files that describe the run", async () => {
    const run = await recordedRun(corpus);
    const dir = bundle(run);
    const scanned: string[] = [];
    runCanaryPasses({
      scan: (options) => {
        const report = standIn(options);
        const skip = options.skip ?? (() => false);
        if (options.secrets.some((secret) => secret.label.startsWith("recorded member datum"))) {
          scanned.push(...walk(dir).filter((path) => !skip(path)));
        }
        return report;
      },
      bundleDir: dir,
      needles: canaryNeedlesOf({ run, memberId: LIVE_MEMBER_ID }),
    });
    // Pass 1 also carries member-data needles, over `synthesized/`. Everything else in this list
    // is pass 5, and the three metadata files are what it is for.
    expect([...new Set(scanned)].sort()).toEqual([
      "README.md",
      "provenance.json",
      "spend.json",
      "synthesized/report.json",
    ]);
  });

  it("FAILS when a member's name is planted in provenance.json, and names the file and the needle", async () => {
    const run = await recordedRun(corpus);
    const dir = bundle(run);
    const restore = plant(dir, "provenance.json", `{"leaked":"ALVAREZ, DANA (SYNTHETIC)"}`);

    const failed = passesOver(dir, run);
    const pass5 = passNamed(failed, "5 metadata");
    expect(pass5.report.clean).toBe(false);
    expect(pass5.report.hits.map((hit) => hit.file)).toEqual(["provenance.json"]);
    expect(pass5.report.hits[0]?.secret).toBe(
      "recorded member datum / memberName (read off the screen)",
    );
    expect(failed.clean).toBe(false);

    restore();
    expect(passNamed(passesOver(dir, run), "5 metadata").report.clean).toBe(true);
    expect(passesOver(dir, run).clean).toBe(true);
  });

  it("fires on the ledger and on the bundle README too, not only on provenance", async () => {
    const run = await recordedRun(corpus);
    for (const file of ["spend.json", "README.md"]) {
      const dir = bundle(run);
      const restore = plant(dir, file, "share balance 1,204.55 as of today");
      const pass5 = passNamed(passesOver(dir, run), "5 metadata");
      expect(
        pass5.report.hits.map((hit) => hit.file),
        file,
      ).toEqual([file]);
      restore();
      expect(passNamed(passesOver(dir, run), "5 metadata").report.clean, file).toBe(true);
    }
  });

  it("does NOT fire on the caller's argument, which those files state on purpose", async () => {
    // `provenance.json` prints the member number as `memberId` and inside `goal`, and the README
    // has a section about where it is and is not. A pass that failed on those is a pass somebody
    // switches off, which is the same argument that keeps pass 4 ungated.
    const run = await recordedRun(corpus);
    const dir = bundle(run);
    expect(readFileSync(join(dir, "provenance.json"), "utf8")).toContain(LIVE_MEMBER_ID);
    expect(readFileSync(join(dir, "README.md"), "utf8")).toContain(LIVE_MEMBER_ID);
    expect(passNamed(passesOver(dir, run), "5 metadata").report.clean).toBe(true);
  });

  it("does NOT fire on the recording or on the replay result, where that datum belongs", async () => {
    const run = await recordedRun(corpus);
    const dir = bundle(run);
    const restores = [
      plant(dir, "transcript.json", "row: 10043 / ALVAREZ, DANA (SYNTHETIC) / 1,204.55 / ACTIVE"),
      plant(dir, "journal.jsonl", `{"output.noted":"ALVAREZ, DANA (SYNTHETIC)"}`),
      plant(dir, "verification.json", `{"memberName":"ALVAREZ, DANA (SYNTHETIC)"}`),
    ];
    const outcome = passesOver(dir, run);
    expect(passNamed(outcome, "5 metadata").report.hits).toEqual([]);
    expect(outcome.clean).toBe(true);
    for (const restore of restores) restore();
  });

  it("still fails pass 1 for the same datum in a synthesized document", async () => {
    // The two member-data passes are not redundant: this is the one section 7.2 already had, and
    // it has to keep working after the fifth was added beside it.
    const run = await recordedRun(corpus);
    const dir = bundle(run);
    const restore = plant(dir, "synthesized/report.json", `{"why":"ALVAREZ, DANA (SYNTHETIC)"}`);
    const outcome = passesOver(dir, run);
    expect(passNamed(outcome, "1 documents").report.hits.map((hit) => hit.file)).toEqual([
      "synthesized/report.json",
    ]);
    expect(passNamed(outcome, "5 metadata").report.hits).toEqual([]);
    restore();
  });

  it("keeps pass 4 reported rather than gating, with the recording's hits still listed", async () => {
    const run = await recordedRun(corpus);
    const dir = bundle(run);
    const restore = plant(dir, "journal.jsonl", `typed ${LIVE_MEMBER_ID} into the form`);
    const outcome = passesOver(dir, run);
    const pass4 = passNamed(outcome, "4 recording");
    expect(pass4.gates).toBe(false);
    expect(pass4.report.hits.length).toBeGreaterThan(0);
    expect(outcome.clean).toBe(true);
    restore();
  });

  it("proves the scanner it trusts can fail", () => {
    // A suite whose scanner has never been shown to fire proves nothing about the scopes it points
    // that scanner at. The needle is planted in a file this test writes and nowhere else.
    const dir = mkdtempSync(join(tmpdir(), "crr-canary-selftest-"));
    temps.push(dir);
    writeText(join(dir, "a.txt"), "nothing here\n");
    const secrets: readonly CanarySecretView[] = [{ label: "planted", value: "SENTINEL-VALUE" }];
    expect(standIn({ bundleDir: dir, secrets }).clean).toBe(true);
    writeText(join(dir, "b.txt"), "carries SENTINEL-VALUE in the middle\n");
    const report = standIn({ bundleDir: dir, secrets });
    expect(report.clean).toBe(false);
    expect(report.hits.map((hit) => hit.file)).toEqual(["b.txt"]);
    expect(report.selfTest.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. The runner still points the real scanner at these scopes
// ---------------------------------------------------------------------------------------------

describe("`pnpm discover` wires the scopes to the real canary", () => {
  it("delegates to runCanaryPasses with @crr/runtime's scanner", () => {
    // Read off disk because `tools/discover.ts` is a script with top-level `await` and
    // `process.exit` in it: importing it would run it, and running it would call a provider. The
    // three checks are what stop this passing because it read the wrong file or nothing.
    const source = readFileSync(join(HERE, "..", "tools", "discover.ts"), "utf8");
    expect(source.length).toBeGreaterThan(10_000);
    expect(source).toContain("runCanaryPasses({");
    expect(source).toContain("scan: runtime.runRedactionCanary");
    expect(source).toContain("canaryNeedlesOf({ run, memberId: LIVE_MEMBER_ID })");
  });

  it("keeps the scopes and the needle floor in one place rather than two", () => {
    // They were both `const`s in the runner. A copy left behind there is how a scope silently
    // stops agreeing with the one this suite asserts over.
    const source = readFileSync(join(HERE, "..", "tools", "discover.ts"), "utf8");
    expect(source).not.toContain("const RECORDING_FILES");
    expect(source).not.toContain("const MIN_NEEDLE_LENGTH");
    expect(RECORDING_FILES.size).toBe(3);
  });
});
