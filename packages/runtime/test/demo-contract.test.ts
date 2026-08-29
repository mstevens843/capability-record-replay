// The demo's own contract tests: it cannot spend money, and the driver is still a parameter.
//
// `pnpm demo` is the command a reviewer runs and the command that produces `/evidence/`. Two
// properties of it are load-bearing and neither is visible from reading its output:
//
//   1. IT CANNOT REACH A MODEL. `.private/BRIEF.md` §11 makes "no agent may spend the author's
//      money" a hard rule, and the submission requires the replay path to run with no live LLM. A
//      script that *could* call a provider is a script that eventually does - one convenience import
//      while debugging and the guarantee is gone with no test failing. So the guarantee is a
//      property of the import graph, checked here off disk.
//   2. ONLY THE FACTORY KNOWS WHAT A BROWSER IS. `@crr/runtime/src` contains no driver import and
//      `@crr/core`'s architecture scan enforces that. The demo lives outside `src/`, so that scan
//      does not cover it - and a demo whose orchestrator imported Playwright directly would quietly
//      contradict the claim `--surface <module>` exists to make.
//
// Read off disk, like every other architecture test in this repository, and each one is paired with
// a discrimination test proving the scanner can actually fail.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO = join(HERE, "../demo");
const REPO = join(HERE, "../../..");

/**
 * Provider clients, by package name. Matched against IMPORT SPECIFIERS rather than against raw
 * text: `openai` as a substring appears in ordinary prose, and a scanner with false positives is a
 * scanner somebody eventually deletes.
 */
const FORBIDDEN_IMPORTS: readonly { readonly module: string; readonly why: string }[] = [
  { module: "@anthropic-ai/sdk", why: "the Anthropic SDK is a live provider client" },
  { module: "@anthropic-ai/claude-agent-sdk", why: "the agent SDK draws on a Claude subscription" },
  { module: "openai", why: "the OpenAI SDK is a live provider client" },
  {
    module: "@crr/discovery",
    why: "the discovery package is the only one that may import a model SDK, and importing it puts one in this graph",
  },
];

/** Text that means a credential is being read or a request is being made, wherever it appears. */
const FORBIDDEN_TEXT: readonly { readonly needle: string; readonly why: string }[] = [
  { needle: "ANTHROPIC_API_KEY", why: "the demo reads no credential of any kind" },
  { needle: "OPENAI_API_KEY", why: "the demo reads no credential of any kind" },
  { needle: "CLAUDE_CODE_OAUTH_TOKEN", why: "the demo reads no credential of any kind" },
  { needle: "https://", why: "the demo contacts loopback and nothing else" },
  { needle: "fetch(", why: "the demo makes no outbound request of its own" },
];

/** What a driver is, by any spelling. */
const DRIVER_MODULES: readonly string[] = [
  "playwright",
  "playwright-core",
  "@playwright/test",
  "@crr/surface-browser",
  "@crr/surface-terminal",
  "@xterm/headless",
  "puppeteer",
];

/** Source with its comments blanked, so prose naming a module is not mistaken for using one - this
 *  file's own header names several of the needles it looks for, and so do the demo's headers. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
}

/** Every module specifier the file imports, statically or dynamically. */
function importsOf(path: string): readonly string[] {
  const source = code(path);
  const out: string[] = [];
  for (const match of source.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)) {
    out.push(match[1] as string);
  }
  return out;
}

function demoFiles(): readonly string[] {
  return readdirSync(DEMO)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".mjs"))
    .sort()
    .map((name) => join(DEMO, name));
}

/**
 * Is every `discoverySlot()` call reached only when there is NO live discovery run?
 *
 * Returns one sentence per violation, so a failure names the way the rule was broken rather than
 * printing `false`. Text-level rather than AST-level on purpose: this file already reads the demo
 * off disk with its comments blanked, and the property is a two-line one.
 */
function pendingSlotIsGuarded(source: string): readonly string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/discoverySlot\(\);/g)) {
    const before = source.slice(0, match.index);
    const guard = before.lastIndexOf("liveRunPresent()");
    if (guard === -1) {
      out.push("discoverySlot() is called with no liveRunPresent() guard before it");
      continue;
    }
    const between = before.slice(guard);
    if (between.includes("function ")) {
      out.push("discoverySlot() is called outside the block the nearest liveRunPresent() guards");
      continue;
    }
    // The guard must send the call down the NEGATIVE branch: `if (!liveRunPresent())`, or the
    // `else` of `if (liveRunPresent())`. Writing the slot when a run IS present is the defect.
    if (!between.includes("else") && !before.slice(guard - 4, guard).includes("!")) {
      out.push("discoverySlot() runs WHEN a live run is present, which is exactly backwards");
    }
  }
  return out;
}

/**
 * Every string literal that names a path inside the bundle by the repo-relative name `evidence/…`.
 *
 * The bundle directory is a parameter (`CRR_DEMO_EVIDENCE_DIR`), so a hard-coded `evidence/…` is a
 * writer that ignores it - which is how a run pointed at a scratch directory came to write into the
 * committed bundle. Bundle-RELATIVE literals (`artifact/`, `replay-01-green/`) are correct wherever
 * the bundle lives and are not matched.
 */
function literalBundlePaths(source: string): readonly string[] {
  return [...source.matchAll(/["'`](evidence\/[^"'`]*)["'`]/g)].map((match) => match[1] as string);
}

describe("the demo", () => {
  it("has files to scan, and they really do import things", () => {
    // A scan that reads nothing passes as loudly as one that reads everything.
    const names = demoFiles().map((path) => path.slice(DEMO.length + 1));
    expect(names).toEqual([
      "integrity.ts",
      "main.ts",
      "scenarios.ts",
      "surface-entry.mjs",
      "surface.ts",
    ]);
    for (const path of demoFiles()) {
      expect(importsOf(path).length, path).toBeGreaterThan(0);
    }
  });

  it("CANNOT REACH A MODEL - no provider SDK, no credential, no outbound request", () => {
    const found: string[] = [];
    for (const path of demoFiles()) {
      const name = path.slice(REPO.length + 1);
      for (const specifier of importsOf(path)) {
        const forbidden = FORBIDDEN_IMPORTS.find((f) => f.module === specifier);
        if (forbidden !== undefined)
          found.push(`${name}  imports ${specifier}  - ${forbidden.why}`);
      }
      const source = code(path);
      for (const { needle, why } of FORBIDDEN_TEXT) {
        if (source.includes(needle)) found.push(`${name}  ${needle}  - ${why}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("keeps the driver in the factory, which is the whole point of `--surface <module>`", () => {
    const offenders: string[] = [];
    for (const path of demoFiles()) {
      const name = path.slice(DEMO.length + 1);
      // These two ARE the factory. Everything else drives the surface through the port, including
      // the masked-capture exhibit - which is why `capture()` is on the port and returns a ref.
      if (name === "surface.ts" || name === "surface-entry.mjs") continue;
      for (const specifier of importsOf(path)) {
        if (DRIVER_MODULES.includes(specifier)) offenders.push(`${name}  ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("and the factory really does import one, so the previous test is not vacuous", () => {
    const factory = importsOf(join(DEMO, "surface.ts"));
    expect([...new Set(factory.filter((m) => DRIVER_MODULES.includes(m)))].sort()).toEqual([
      "@crr/surface-browser",
      "playwright",
    ]);
  });

  it("the scanner can fail: a module named only in a comment is not an import", () => {
    // The header of `surface-entry.mjs` names `@crr/surface-browser` in prose AND imports it. The
    // comment stripper must remove the first occurrence and leave the second.
    expect(importsOf(join(DEMO, "surface-entry.mjs"))).toContain("@crr/surface-browser");
    const source = readFileSync(join(DEMO, "surface-entry.mjs"), "utf8");
    expect(source.slice(0, source.indexOf("import {"))).toContain("@crr/surface-browser");
  });

  it("is wired to `pnpm demo`, because a deliverable nobody can run is not a deliverable", () => {
    const root = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(root.scripts.demo).toBeDefined();
    expect(root.scripts.demo).toContain("packages/runtime/demo/main.ts");
  });

  it("never writes PENDING.md on top of a live discovery run", () => {
    // LIVE-RUN-READINESS section 5.1, as a regression test. `discoverySlot()` writes
    // `evidence/discovery-live/PENDING.md`, which says in bold that the directory holds nothing.
    // `pnpm discover --yes` DELETES that file on success, and its closing line tells the author to
    // run `pnpm demo` next - which used to put the note straight back, beside the transcript it
    // contradicts. The fix is one guard, and this is what stops it being removed by accident.
    expect(pendingSlotIsGuarded(code(join(DEMO, "main.ts")))).toEqual([]);
  });

  it("that scanner can fail, on each way of breaking the guard", () => {
    // The discrimination half, because a scanner that cannot fail is not evidence. Three sources
    // that DO break the rule, one per way of breaking it.
    expect(pendingSlotIsGuarded("  const cli = cliReplay();\n  discoverySlot();\n")).toEqual([
      "discoverySlot() is called with no liveRunPresent() guard before it",
    ]);
    expect(
      pendingSlotIsGuarded("  if (liveRunPresent()) { }\n  function x() { }\n  discoverySlot();\n"),
    ).toEqual(["discoverySlot() is called outside the block the nearest liveRunPresent() guards"]);
    expect(pendingSlotIsGuarded("  if (liveRunPresent()) discoverySlot();\n")).toEqual([
      "discoverySlot() runs WHEN a live run is present, which is exactly backwards",
    ]);
    // And the shape the demo actually uses passes, so the scanner is not simply always angry.
    expect(
      pendingSlotIsGuarded(
        "  if (liveRunPresent()) {\n    log();\n  } else {\n    discoverySlot();\n  }\n",
      ),
    ).toEqual([]);
  });

  it("takes the bundle lock BEFORE it deletes anything", () => {
    // Order is the whole property. `clearOwned()` is the destructive step, so a lock taken after
    // it has already let a second process delete the first one's bundle. Two concurrent runs were
    // measured leaving 2 journal blobs in all five scenario directories, both printing `DEMO OK`.
    const source = code(join(DEMO, "main.ts"));
    const lock = source.indexOf("acquireBundleLock(");
    const clear = source.indexOf("clearOwned(suite");
    expect(lock, "main.ts no longer takes a bundle lock").toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(clear);
    // And it is released, or the next run refuses to start.
    expect(source).toContain("releaseBundleLock(");
  });

  it("writes every path through the bundle directory, so a run pointed elsewhere writes nowhere here", () => {
    // THE DEFECT: `cliReplay()` passed the subprocess repo-relative `evidence/...` paths while
    // every other writer honoured `CRR_DEMO_EVIDENCE_DIR`, so a demo run against a scratch bundle
    // dropped its journal blob into the COMMITTED one. Measured: two scratch runs took
    // `evidence/cli-replay/observations/` to three journal blobs and the tracked bundle to 67
    // files. A string literal caused it, so a string literal is what this looks for.
    expect(literalBundlePaths(code(join(DEMO, "main.ts")))).toEqual([]);
  });

  it("that scanner can fail, on the exact shape that shipped", () => {
    expect(
      literalBundlePaths('const argv = ["replay", "evidence/artifact/contract.json"];'),
    ).toEqual(["evidence/artifact/contract.json"]);
    expect(literalBundlePaths('"--evidence", "evidence/cli-replay/observations",')).toEqual([
      "evidence/cli-replay/observations",
    ]);
    // A bundle-relative path in generated prose is not the defect: the bundle's own README links
    // `artifact/` and `replay-01-green/`, and those are correct wherever the bundle lives.
    expect(literalBundlePaths('"[`artifact/`](artifact/) holds the documents"')).toEqual([]);
  });

  it("keeps the evidence bundle's run logs out of `.gitignore`'s `*.log`", () => {
    // `*.log` is in `.gitignore` for build noise. The bundle's logs ARE the deliverable, and a
    // committed bundle missing every `run.log` is a silent hole a reviewer discovers, not us.
    const ignore = readFileSync(join(REPO, ".gitignore"), "utf8");
    expect(ignore).toContain("!/evidence/**/*.log");
  });
});
