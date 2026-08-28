// The barrel is the package - and `export *` hides exactly two failures.
//
//   · A module nobody re-exported. It compiles, its tests pass, and no consumer can see it.
//   · Two modules exporting the same name. Under the ES module semantics `export *` follows, an
//     ambiguous star export is NOT an error: the binding is silently ABSENT from the barrel, and the
//     symptom surfaces at the far end of the monorepo with nothing pointing back at the cause.
//
// The second one is not hypothetical here. Unit 12 introduced `export type { Digest }` in
// `invoke.ts` beside the identical line in `replay.ts`, which quietly removed `Digest` from
// `@crr/runtime`'s public surface; nothing failed. This file is the check that would have caught it,
// modelled on `@crr/core`'s own `test/barrel.test.ts` and reading the files on disk rather than a
// hand-maintained list.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ActionKind as CoreActionKind,
  Digest as CoreDigest,
  PolicyDecision as CorePolicyDecision,
} from "@crr/core";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { ActionKind, Digest, PolicyDecision } from "../src/index.js";
import * as barrel from "../src/index.js";

const SRC = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "src");

/**
 * The modules that are ENTRY POINTS rather than library surface.
 *
 * Both are `main()` behind an `import.meta.url` guard and are built as their own bundles
 * (`package.json` `bin`). Re-exporting a command from the library barrel would put `parseArgs` and
 * `process.stdout` in the import graph of every consumer that only wanted to call `invoke`.
 */
const ENTRY_POINTS = new Set(["cli.ts", "codegen-cli.ts"]);

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

/** The names a module exports, read from the AST - `export type { X }` and `export { x as y }` are
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

const MODULES: readonly Module[] = sourceFiles(SRC)
  .filter((path) => {
    const file = relative(SRC, path).replaceAll("\\", "/");
    return file !== "index.ts" && !ENTRY_POINTS.has(file);
  })
  .map((path) => {
    const file = relative(SRC, path).replaceAll("\\", "/");
    const { names, values } = exportsOf(path);
    return { file, specifier: `./${file.replace(/\.ts$/, ".js")}`, names, values };
  });

const INDEX = readFileSync(join(SRC, "index.ts"), "utf8");

describe("the public surface of @crr/runtime", () => {
  it("was actually read", () => {
    expect(MODULES.length).toBeGreaterThan(10);
    expect(MODULES.map((m) => m.file)).toContain("invoke.ts");
    expect(MODULES.map((m) => m.file)).toContain("catalog.ts");
  });

  it("re-exports every library module, so no unit can ship invisibly", () => {
    const missing = MODULES.filter((m) => !INDEX.includes(`"${m.specifier}"`)).map((m) => m.file);
    expect(missing).toEqual([]);
  });

  it("re-exports nothing that is not there", () => {
    const declared = [...INDEX.matchAll(/export \* from "([^"]+)"/g)].map((m) => m[1] as string);
    const known = new Set(MODULES.map((m) => m.specifier));
    expect(declared.filter((s) => !known.has(s))).toEqual([]);
    expect(declared.length).toBe(MODULES.length);
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

  it("actually exposes every value at runtime, not merely in the types", () => {
    const live = new Set(Object.keys(barrel));
    const absent = MODULES.flatMap((m) =>
      m.values.filter((name) => !live.has(name)).map((name) => `${m.file}: ${name}`),
    );
    expect(absent).toEqual([]);
  });

  it("keeps the two commands out of the library graph", () => {
    for (const entry of ENTRY_POINTS) {
      expect(INDEX).not.toContain(`./${entry.replace(/\.ts$/, ".js")}`);
    }
    expect(barrel).not.toHaveProperty("main");
  });
});

// ---------------------------------------------------------------------------------------------
// The workspace, not just this package
// ---------------------------------------------------------------------------------------------
//
// The check above is about ONE barrel. This one is about the three barrels a consumer imports
// together, and it exists because the integration pass that wrote it found a real collision:
// `@crr/runtime` exported a `ReplayOptions` (the argument to `replay()`, the artifact interpreter)
// and `@crr/discovery` exported a different `ReplayOptions` (the argument to `createReplayModel`,
// the VCR transcript adapter). Both were correct in their own file. Neither package's tests could
// see the other. The first person to import both would have had to alias one of them, and the
// second would have got it wrong. `@crr/discovery`'s is now `TranscriptReplayOptions`.
//
// It reads the sibling packages off DISK rather than importing them, so this test adds no
// dependency edge - `@crr/runtime` does not and should not depend on `@crr/discovery`. When
// `@crr/conformance` arrives it will depend on both and is the better home; until then this is the
// only place in the workspace where the two names are visible at once.

const PACKAGES = resolve(SRC, "..", "..");

/** The library modules of one package, by the same rule each package's own barrel test uses. */
function libraryNames(pkg: string, entryPoints: ReadonlySet<string>): ReadonlyMap<string, string> {
  const src = join(PACKAGES, pkg, "src");
  const out = new Map<string, string>();
  for (const path of sourceFiles(src)) {
    const file = relative(src, path).replaceAll("\\", "/");
    if (file === "index.ts" || entryPoints.has(file)) continue;
    for (const name of exportsOf(path).names) out.set(name, `${pkg}/${file}`);
  }
  return out;
}

/**
 * Names that appear in two packages ON PURPOSE, each with the argument for it.
 *
 * All three are `@crr/core` types that `@crr/runtime` re-exports because they appear in the
 * signature of something it exports - a consumer reading a `ReplayOutput` needs `Digest`, and one
 * writing a journal reader needs `PolicyDecision`. They are the SAME type, not a second definition
 * of it, and the compile-time seams in the test below are what keep that true: two types that both
 * spell themselves `Digest` and disagree about their brand would stop being mutually assignable and
 * `tsc --noEmit` would say so.
 *
 * Anything not on this list is a collision. Adding an entry is one reviewable line with a reason
 * attached, which is the point.
 */
const INTENTIONAL_OVERLAPS: readonly { readonly name: string; readonly why: string }[] = [
  {
    name: "ActionKind",
    why: "core's action taxonomy, re-exported beside the journal events that carry it",
  },
  {
    name: "Digest",
    why: "core's branded digest, re-exported beside `ReplayOutput.artifactDigest`",
  },
  {
    name: "PolicyDecision",
    why: "core's policy verdict, re-exported beside the `policy.decided` event",
  },
];

describe("the packages a consumer imports together", () => {
  const core = libraryNames("core", new Set());
  const runtime = libraryNames("runtime", ENTRY_POINTS);
  const discovery = libraryNames("discovery", new Set());

  it("were actually read", () => {
    // A scan of nothing is not a green test: if the sibling directory moves, this must fail rather
    // than report no collisions.
    expect(core.size).toBeGreaterThan(200);
    expect(runtime.size).toBeGreaterThan(50);
    expect(discovery.size).toBeGreaterThan(50);
  });

  it("export no name twice, except the ones on the ledger", () => {
    const permitted = new Set(INTENTIONAL_OVERLAPS.map((o) => o.name));
    const pairs: readonly (readonly [
      string,
      ReadonlyMap<string, string>,
      ReadonlyMap<string, string>,
    ])[] = [
      ["core / runtime", core, runtime],
      ["core / discovery", core, discovery],
      ["runtime / discovery", runtime, discovery],
    ];
    const collisions: string[] = [];
    for (const [label, a, b] of pairs) {
      for (const [name, whereA] of a) {
        const whereB = b.get(name);
        if (whereB === undefined || permitted.has(name)) continue;
        collisions.push(`${label}  ${name}: ${whereA} and ${whereB}`);
      }
    }
    expect(collisions).toEqual([]);
  });

  it("carries no ledger entry that is not a real overlap", () => {
    // A dead exemption is a permission nobody is using and nobody remembers granting. The same
    // rule `@crr/core`'s `ARCHITECTURE_EXEMPTIONS` is held to.
    const dead = INTENTIONAL_OVERLAPS.filter((o) => !(core.has(o.name) && runtime.has(o.name)));
    expect(dead.map((o) => o.name)).toEqual([]);
    for (const overlap of INTENTIONAL_OVERLAPS) expect(overlap.why.length).toBeGreaterThan(20);
  });

  it("means the same type by the three names it spells twice", () => {
    // Bidirectional assignability IS type identity, and `tsc --noEmit` over `test/**` is what
    // checks these lines - vitest does not typecheck, so the assertions below only keep the
    // bindings alive. The failure this catches is the one unit 9 hit for real between the
    // classifier and the resolver: two units agreeing on a NAME and disagreeing on the type.
    const digestOut: (d: CoreDigest) => Digest = (d) => d;
    const digestBack: (d: Digest) => CoreDigest = (d) => d;
    const kindOut: (a: CoreActionKind) => ActionKind = (a) => a;
    const kindBack: (a: ActionKind) => CoreActionKind = (a) => a;
    const decisionOut: (p: CorePolicyDecision) => PolicyDecision = (p) => p;
    const decisionBack: (p: PolicyDecision) => CorePolicyDecision = (p) => p;
    for (const seam of [digestOut, digestBack, kindOut, kindBack, decisionOut, decisionBack]) {
      expect(typeof seam).toBe("function");
    }
  });
});
