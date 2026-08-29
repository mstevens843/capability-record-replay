// The barrel is the package - and this package's barrel has a second job.
//
// PART ONE is the same four invariants the other five packages hold, because `export *` hides
// exactly two failures and the second one is the dangerous one:
//
//   · A module nobody re-exported. It compiles, its tests pass, and no consumer can see it.
//   · Two modules exporting the same name. Under the ES module semantics `export *` follows, an
//     ambiguous star export is NOT an error: the binding is silently ABSENT from the barrel, and
//     the symptom surfaces at the far end of the monorepo with nothing pointing back at the cause.
//
// `@crr/conformance`'s barrel is CURATED - a hand-written list of named re-exports rather than a
// wall of `export *` - so the second failure cannot happen here by construction, and the first one
// changes shape: a module may be deliberately internal. The invariant that survives is therefore
// "every module is either on the barrel or on a LEDGER with a reason", which is the check that
// actually catches a unit shipping invisibly.
//
// PART TWO is the workspace-wide name ledger, and it is here because this is the only package that
// can hold it. RUNTIME-STATUS section 3.1 records the collision that started it: `ReplayOptions`
// was declared in `@crr/runtime` (the argument to `replay()`, twenty-odd fields) and in
// `@crr/discovery` (the argument to `createReplayModel()`, one optional boolean). Each file read
// correctly on its own. No test could see it, because NOTHING IN THE WORKSPACE IMPORTED BOTH - and
// the first consumer that did would have had to alias one of the two, with no way to tell which.
//
// `@crr/runtime`'s own barrel test carries a three-package version of this check and says in its
// header that "`@crr/conformance` will depend on both and is the better home". It now exists, and
// this is that home: the ledger below reads all SIX packages off disk, so the two DRIVERS - which
// no engine package may import, and which therefore have the least chance of any test noticing a
// collision between them - are covered for the first time. It found two on the day it was written;
// both are recorded in `docs/design/FINAL-STATUS.md` and both were renamed rather than ledgered.
//
// DUPLICATION, DELIBERATE. Five packages now carry a near-identical copy of the AST reader below.
// The alternative is a shared dev package, which is a workspace member and therefore a lockfile
// change; and a test that reads its OWN package's `src/` off disk cannot lie about which package it
// is describing. CORE-STATUS section 7 item 7 records the same seam from the other end:
// `@crr/conformance` cannot import `packages/core/test/*` either, because those scanners do I/O and
// live in `test/` for exactly that reason.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// TYPE-ONLY, both of them. Importing the two drivers for their VALUES here would load Playwright and
// `@xterm/headless` into this suite; `import type` is erased entirely and the seam below is checked
// by `tsc --noEmit` over `test/**`, which is where a type identity claim belongs anyway.
import type { CaptureSink as BrowserCaptureSink } from "@crr/surface-browser";
import type { CaptureSink as TerminalCaptureSink } from "@crr/surface-terminal";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as barrel from "../src/index.js";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const SRC = resolve(HERE, "..", "src");
const PACKAGES = resolve(HERE, "..", "..");

interface Module {
  readonly file: string;
  readonly specifier: string;
  readonly names: readonly string[];
  readonly values: readonly string[];
}

function sourceFiles(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** The names a module exports, read from the AST. `export type { X }` and `export { x as y }` are
 *  both things this package does, and both are ways a regex would be quietly wrong. */
function exportsOf(path: string): { names: readonly string[]; values: readonly string[] } {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.ES2022,
    true,
  );
  const names: string[] = [];
  const values: string[] = [];
  const exported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.push(declaration.name.text);
          values.push(declaration.name.text);
        }
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      exported(statement) &&
      statement.name !== undefined
    ) {
      names.push(statement.name.text);
      values.push(statement.name.text);
    } else if (
      (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
      exported(statement)
    ) {
      names.push(statement.name.text);
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        names.push(element.name.text);
        if (!statement.isTypeOnly && !element.isTypeOnly) values.push(element.name.text);
      }
    }
  }
  return { names, values };
}

/**
 * Modules that are deliberately NOT on the barrel, each with the argument for it.
 *
 * The same shape `@crr/runtime`'s `ENTRY_POINTS` has, and for the same reason: an exclusion that
 * nobody has to defend is an exclusion nobody notices. Adding an entry is one reviewable line.
 */
const NOT_ON_THE_BARREL: readonly { readonly file: string; readonly why: string }[] = [
  {
    file: "stability-cli.ts",
    why: "an entry point - `main()` behind an `import.meta.url` guard, run by `pnpm -F @crr/conformance stability`. Re-exporting it would put `process.argv` and `process.stdout` in the import graph of every consumer that only wanted `runConformance`, which is the reason `@crr/runtime` keeps `cli.ts` and `codegen-cli.ts` off its barrel too",
  },
];

const MODULES: readonly Module[] = sourceFiles(SRC)
  .map((path) => relative(SRC, path).replaceAll("\\", "/"))
  .filter((file) => file !== "index.ts")
  .map((file) => {
    const { names, values } = exportsOf(join(SRC, file));
    return { file, specifier: `./${file.replace(/\.ts$/, ".js")}`, names, values };
  });

const INDEX = readFileSync(join(SRC, "index.ts"), "utf8");
const BARREL_NAMES = new Set(exportsOf(join(SRC, "index.ts")).names);

// ---------------------------------------------------------------------------------------------
// 1. The package's own barrel
// ---------------------------------------------------------------------------------------------

describe("the public surface of @crr/conformance", () => {
  it("was actually read", () => {
    // The floor is the failure this catches: a moved directory or a walk that silently returned
    // nothing. Without it, deleting `src/` would make every assertion below pass.
    expect(MODULES.length).toBeGreaterThan(10);
    expect(MODULES.map((m) => m.file)).toContain("engines/mutants.ts");
    expect(MODULES.map((m) => m.file)).toContain("scenarios/index.ts");
    // The two subdirectories are walked. `corpus/` and `engines/` are where a collision is most
    // likely - five corpus modules all speaking about screens, flows and scopes.
    expect(MODULES.filter((m) => m.file.startsWith("corpus/")).length).toBeGreaterThan(3);
    expect(BARREL_NAMES.size).toBeGreaterThan(60);
  });

  it("re-exports every module, or says why not", () => {
    const excused = new Set(NOT_ON_THE_BARREL.map((e) => e.file));
    const missing = MODULES.filter(
      (m) => !excused.has(m.file) && !INDEX.includes(`"${m.specifier}"`),
    ).map((m) => m.file);
    expect(missing).toEqual([]);
  });

  it("carries no exclusion that is not a real module, and none without a reason", () => {
    // A dead exemption is a permission nobody is using and nobody remembers granting - the rule
    // `@crr/core`'s `ARCHITECTURE_EXEMPTIONS` is held to.
    const known = new Set(MODULES.map((m) => m.file));
    expect(NOT_ON_THE_BARREL.filter((e) => !known.has(e.file)).map((e) => e.file)).toEqual([]);
    for (const entry of NOT_ON_THE_BARREL) expect(entry.why.length).toBeGreaterThan(40);
  });

  it("re-exports nothing that is not there", () => {
    const declared = [...INDEX.matchAll(/from "([^"]+)"/g)].map((m) => m[1] as string);
    const known = new Set(MODULES.map((m) => m.specifier));
    expect(declared.filter((s) => !known.has(s))).toEqual([]);
    expect(declared.length).toBeGreaterThan(10);
  });

  it("has no name exported by two modules", () => {
    const owners = new Map<string, string[]>();
    for (const module of MODULES) {
      for (const name of module.names) {
        const list = owners.get(name) ?? [];
        list.push(module.file);
        owners.set(name, list);
      }
    }
    const collisions = [...owners.entries()]
      .filter(([, files]) => new Set(files).size > 1)
      .map(([name, files]) => `${name}: ${[...new Set(files)].sort().join(" and ")}`);
    expect(collisions).toEqual([]);
  });

  it("actually exposes every name it claims, at runtime and not merely in the types", () => {
    // The types can be right while the binding is gone. On a curated barrel the way that happens is
    // a re-export whose module stopped exporting the name; either way the symptom is the same and
    // the far end of the monorepo is where it shows up.
    const live = new Set(Object.keys(barrel));
    const declaredValues = new Set<string>();
    for (const module of MODULES) {
      if (!INDEX.includes(`"${module.specifier}"`)) continue;
      for (const value of module.values) if (BARREL_NAMES.has(value)) declaredValues.add(value);
    }
    expect([...declaredValues].filter((name) => !live.has(name))).toEqual([]);
    expect(declaredValues.size).toBeGreaterThan(40);
    // The four the whole package is for. `ALL_MUTANTS` and `REFERENCE_ENGINE` are the negative
    // controls: the claim "this suite discriminates" is only checkable if the things it
    // discriminates against ship with it.
    expect(typeof barrel.runConformance).toBe("function");
    expect(typeof barrel.buildKillMatrix).toBe("function");
    expect(Array.isArray(barrel.ALL_MUTANTS)).toBe(true);
    expect(typeof barrel.REFERENCE_ENGINE).toBe("object");
  });

  it("keeps the scratch file boxed in until somebody deletes it", () => {
    // `__probe.ts` was a scratch file left behind by the unit that built the stability report. It is
    // deleted, so this now passes vacuously - and stays here as the guard that catches it coming
    // back: zero exports, and small enough that no unit could be hiding in it.
    const probe = MODULES.find((m) => m.file === "__probe.ts");
    if (probe === undefined) return; // deleted - which is the outcome this test wants
    expect(probe.names).toEqual([]);
    expect(readFileSync(join(SRC, "__probe.ts"), "utf8").length).toBeLessThan(800);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. The workspace: one name, two packages, nothing that imports both
// ---------------------------------------------------------------------------------------------

/** Entry points, per package: `main()` behind a guard, built as their own bundles, and deliberately
 *  off every barrel. They are excluded from the ledger for the same reason they are excluded from
 *  the barrels - `cli.ts` and `codegen-cli.ts` both declare `main`, and that is not a collision
 *  between packages, it is two commands. */
const ENTRY_POINTS: ReadonlySet<string> = new Set(["cli.ts", "codegen-cli.ts", "stability-cli.ts"]);

/** The library modules of one package, by the same rule each package's own barrel test uses. */
function libraryNames(pkg: string): ReadonlyMap<string, string> {
  const src = join(PACKAGES, pkg, "src");
  const out = new Map<string, string>();
  for (const path of sourceFiles(src)) {
    const file = relative(src, path).replaceAll("\\", "/");
    if (file === "index.ts" || ENTRY_POINTS.has(file)) continue;
    for (const name of exportsOf(path).names) out.set(name, `${pkg}/${file}`);
  }
  return out;
}

/**
 * Names that appear in two packages ON PURPOSE, each with the argument for it.
 *
 * The first three are `@crr/core` types that `@crr/runtime` re-exports because they appear in the
 * signature of something it exports - a consumer reading a `ReplayOutput` needs `Digest`, one
 * writing a journal reader needs `PolicyDecision`. They are the SAME type, not a second definition,
 * and the compile-time seams below are what keep that true.
 *
 * The fourth is different in kind and is the reason this ledger had to grow past `@crr/runtime`'s
 * three: `CaptureSink` is declared independently in BOTH DRIVERS. Neither may import the other -
 * an import between two drivers is the thing the architecture forbids, and the shared home would
 * have to be `@crr/core`, which would put a `Promise`-returning port in the package whose entire
 * claim is that it does no I/O. So the two declarations stay, and the seam below is what stops them
 * drifting: they are asserted MUTUALLY ASSIGNABLE, so the day one of them gains a field the build
 * breaks rather than a consumer.
 */
const INTENTIONAL_OVERLAPS: readonly { readonly name: string; readonly why: string }[] = [
  {
    name: "ActionKind",
    why: "core's action taxonomy, re-exported by runtime beside the journal events that carry it",
  },
  {
    name: "Digest",
    why: "core's branded digest, re-exported by runtime beside `ReplayOutput.artifactDigest`",
  },
  {
    name: "PolicyDecision",
    why: "core's policy verdict, re-exported by runtime beside the `policy.decided` event",
  },
  {
    name: "CaptureSink",
    why: "the same one-method port declared independently in both drivers, because no driver may import another and core may not hold a Promise-returning port; kept honest by the mutual-assignability seam below rather than by a comment",
  },
];

describe("the packages a consumer imports together", () => {
  const packages = readdirSync(PACKAGES).filter((entry) =>
    statSync(join(PACKAGES, entry)).isDirectory(),
  );
  const scanned = new Map(packages.map((pkg) => [pkg, libraryNames(pkg)] as const));

  it("were actually read - all of them, including the two drivers", () => {
    // A scan of nothing is not a green test. The failure this catches is a package added to the
    // workspace and never scanned here: the check stays green because it is not looking, which is
    // precisely the state `ReplayOptions` survived in.
    expect([...scanned.keys()].sort()).toEqual([
      "conformance",
      "core",
      "discovery",
      "runtime",
      "surface-browser",
      "surface-terminal",
    ]);
    expect(scanned.get("core")?.size ?? 0).toBeGreaterThan(200);
    expect(scanned.get("runtime")?.size ?? 0).toBeGreaterThan(50);
    expect(scanned.get("discovery")?.size ?? 0).toBeGreaterThan(50);
    expect(scanned.get("surface-browser")?.size ?? 0).toBeGreaterThan(20);
    expect(scanned.get("surface-terminal")?.size ?? 0).toBeGreaterThan(20);
    expect(scanned.get("conformance")?.size ?? 0).toBeGreaterThan(40);
  });

  it("export no name twice across the whole workspace, except the ones on the ledger", () => {
    const permitted = new Set(INTENTIONAL_OVERLAPS.map((o) => o.name));
    const collisions: string[] = [];
    const names = [...scanned.keys()].sort();
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const [a, b] = [names[i] as string, names[j] as string];
        for (const [name, whereA] of scanned.get(a) as ReadonlyMap<string, string>) {
          const whereB = (scanned.get(b) as ReadonlyMap<string, string>).get(name);
          if (whereB === undefined || permitted.has(name)) continue;
          collisions.push(`${a} / ${b}  ${name}: ${whereA} and ${whereB}`);
        }
      }
    }
    expect(collisions.sort()).toEqual([]);
  });

  it("carries no ledger entry that is not a real overlap", () => {
    const owners = (name: string): readonly string[] =>
      [...scanned.entries()].filter(([, m]) => m.has(name)).map(([pkg]) => pkg);
    const dead = INTENTIONAL_OVERLAPS.filter((o) => owners(o.name).length < 2);
    expect(dead.map((o) => o.name)).toEqual([]);
    for (const overlap of INTENTIONAL_OVERLAPS) expect(overlap.why.length).toBeGreaterThan(20);
  });

  it("means the same type by CaptureSink in both drivers", () => {
    // Bidirectional assignability IS type identity, and `tsc --noEmit` over `test/**` is what
    // checks these two lines - vitest does not typecheck, so the assertions below only keep the
    // bindings alive. The failure this catches: one driver gains `put(bytes, contentType, meta)`
    // and the other does not, and the first consumer to hold both discovers it at the far end.
    const browserToTerminal: (s: BrowserCaptureSink) => TerminalCaptureSink = (s) => s;
    const terminalToBrowser: (s: TerminalCaptureSink) => BrowserCaptureSink = (s) => s;
    for (const seam of [browserToTerminal, terminalToBrowser]) expect(typeof seam).toBe("function");
  });

  it("can fail - the ledger is not the only thing holding this up", () => {
    // A collision detector that has never been shown a collision is a scan of nothing wearing a
    // different hat. Two synthetic maps, one shared name, one permitted name.
    const left = new Map([
      ["ReplayOptions", "runtime/replay.ts"],
      ["Digest", "core/primitives.ts"],
    ]);
    const right = new Map([
      ["ReplayOptions", "discovery/transcript.ts"],
      ["Digest", "runtime/replay.ts"],
    ]);
    const permitted = new Set(INTENTIONAL_OVERLAPS.map((o) => o.name));
    const found = [...left]
      .filter(([name]) => right.has(name) && !permitted.has(name))
      .map(([name, where]) => `${name}: ${where} and ${right.get(name) as string}`);
    expect(found).toEqual(["ReplayOptions: runtime/replay.ts and discovery/transcript.ts"]);
  });
});
