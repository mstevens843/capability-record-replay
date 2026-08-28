// The barrel is the package - and `export *` hides exactly two failures.
//
//   · A module nobody re-exported. It compiles, its tests pass, and no consumer can see it.
//   · Two modules exporting the same name. Under the ES module semantics `export *` follows, an
//     ambiguous star export is NOT an error: the binding is silently ABSENT from the barrel, and
//     the symptom surfaces at the far end of the monorepo with nothing pointing back at the cause.
//
// This package is where that second failure is most likely, because it is the one with
// subdirectories: `synthesis/` holds eight modules that all speak about parameters, routes and
// values, and two of them naming the same helper is a one-line accident.
//
// DUPLICATION, DELIBERATE. `@crr/core`, `@crr/runtime` and `@crr/surface-browser` each carry a
// near-identical copy of the reader below. The alternative is a shared dev package, and adding a
// workspace member is a lockfile change; a test that reads its OWN package's `src/` off disk also
// cannot lie about which package it is describing. `docs/design/CORE-STATUS.md` section 7 item 7
// already records this as the seam `@crr/conformance` will have to resolve.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as barrel from "../src/index.js";

const SRC = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "src");

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

const MODULES: readonly Module[] = sourceFiles(SRC)
  .map((path) => relative(SRC, path).replaceAll("\\", "/"))
  .filter((file) => file !== "index.ts")
  .map((file) => {
    const { names, values } = exportsOf(join(SRC, file));
    return { file, specifier: `./${file.replace(/\.ts$/, ".js")}`, names, values };
  });

const INDEX = readFileSync(join(SRC, "index.ts"), "utf8");

describe("the public surface of @crr/discovery", () => {
  it("was actually read", () => {
    // The floor is the failure this catches: a moved directory or a walk that silently returned
    // nothing. Without it, deleting `src/` would make every assertion below pass.
    expect(MODULES.length).toBeGreaterThan(10);
    expect(MODULES.map((m) => m.file)).toContain("loop.ts");
    // The subdirectories are the reason this test exists at all, so their presence is asserted
    // rather than assumed.
    expect(MODULES.map((m) => m.file)).toContain("adapters/anthropic.ts");
    expect(MODULES.map((m) => m.file)).toContain("synthesis/emit.ts");
  });

  it("re-exports every module, so no unit can ship invisibly", () => {
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
    // The types can be right while the binding is gone: that is exactly what an ambiguous star
    // export looks like from the outside.
    const live = new Set(Object.keys(barrel));
    const absent = MODULES.flatMap((m) =>
      m.values.filter((name) => !live.has(name)).map((name) => `${m.file}: ${name}`),
    );
    expect(absent).toEqual([]);
  });

  it("can be imported with no credential in the environment", () => {
    // BRIEF section 11: the whole suite must run with no key present. The Anthropic adapter is on
    // the barrel, so importing `@crr/discovery` loads the SDK - and it must not construct a client
    // or read a key at module scope. This test has already proved it by the time it runs: the
    // import at the top of this file succeeded.
    expect(typeof barrel.createAnthropicModel).toBe("function");
    expect(typeof barrel.createReplayModel).toBe("function");
  });
});
