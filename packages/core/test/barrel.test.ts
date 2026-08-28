// The barrel is the package.
//
// Seven units were built in parallel by agents that could not see each other's work, and
// `src/index.ts` is where that either becomes one coherent package or stays seven. `export *` is
// unusually good at hiding the two failures that produces:
//
//   · A module nobody re-exported. It compiles, its tests pass, and it is invisible to every
//     consumer - the unit shipped and nothing can call it.
//   · Two modules exporting the same name. Under the ES module semantics `export *` follows, an
//     ambiguous star export is not an error; the binding is simply ABSENT from the barrel. So the
//     symptom is a missing export at the far end of the monorepo, reported nowhere near its cause.
//
// Both are checked here against the files on disk rather than against a hand-maintained list,
// because a hand-maintained list is the thing that goes stale.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as barrel from "../src/index.js";

const SRC = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "src");

interface Module {
  /** Path relative to `src`, POSIX-separated: `hash/sha256.ts`. */
  readonly file: string;
  /** The specifier `index.ts` would use to re-export it: `./hash/sha256.js`. */
  readonly specifier: string;
  readonly names: readonly string[];
  /** The subset of `names` that exists at runtime - functions, constants, schemas. */
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

/**
 * The names a module exports, read from the syntax.
 *
 * The TypeScript AST rather than a regex, because `export type { X }`, `export { x as y }` and a
 * multi-declarator `export const a = 1, b = 2` are all things this package does, and each is a way
 * a regex would be quietly wrong about the very list the test is checking.
 */
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
  .filter((path) => relative(SRC, path) !== "index.ts")
  .map((path) => {
    const file = relative(SRC, path).replaceAll("\\", "/");
    const { names, values } = exportsOf(path);
    return { file, specifier: `./${file.replace(/\.ts$/, ".js")}`, names, values };
  });

const INDEX = readFileSync(join(SRC, "index.ts"), "utf8");

// ---------------------------------------------------------------------------------------------

describe("the public surface", () => {
  it("was actually read", () => {
    expect(MODULES.length).toBeGreaterThan(25);
    expect(MODULES.map((m) => m.file)).toContain("hash/sha256.ts");
  });

  it("re-exports every module in src, so no unit can ship invisibly", () => {
    const missing = MODULES.filter((m) => !INDEX.includes(`"${m.specifier}"`)).map((m) => m.file);
    expect(missing).toEqual([]);
  });

  it("re-exports nothing that is not there", () => {
    // The other direction: a module renamed or removed leaves a specifier behind that would fail
    // the build, but a specifier for a file that never existed fails it in a way nobody can read.
    const declared = [...INDEX.matchAll(/export \* from "([^"]+)"/g)].map((m) => m[1] as string);
    const known = new Set(MODULES.map((m) => m.specifier));
    expect(declared.filter((s) => !known.has(s))).toEqual([]);
    expect(declared.length).toBe(MODULES.length);
  });

  it("has no name exported by two modules", () => {
    // The silent one. Two parallel agents naming the same thing does not fail the build - the
    // ambiguous binding is dropped from the barrel and the error surfaces at the consumer.
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
    // Reading the syntax proves what `index.ts` SAYS. This proves what the module system did with
    // it - the check that would catch an ambiguous star export even if the collision test above
    // were fooled by a name spelled two ways.
    const live = new Set(Object.keys(barrel));
    const absent = MODULES.flatMap((m) =>
      m.values.filter((name) => !live.has(name)).map((name) => `${m.file}: ${name}`),
    );
    expect(absent).toEqual([]);
  });
});
