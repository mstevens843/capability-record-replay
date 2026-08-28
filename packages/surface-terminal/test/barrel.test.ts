// The barrel is the package - and `export *` hides exactly two failures.
//
//   · A module nobody re-exported. It compiles, its tests pass, and no consumer can see it.
//   · Two modules exporting the same name. Under the ES module semantics `export *` follows, an
//     ambiguous star export is NOT an error: the binding is silently ABSENT from the barrel, and
//     the symptom surfaces at the far end of the monorepo with nothing pointing back at the cause.
//
// Two more checks here are specific to THIS driver, and both encode a decision this package would
// otherwise only have in prose:
//
//   · `node-pty` is not imported, anywhere, at any version. The spike's finding (section 1.3) is
//     that a fresh install of `node-pty@1.1.0` is broken out of the box on darwin-arm64 and that
//     neither `pnpm approve-builds` nor a manual `chmod +x` durably fixes it. A dependency added
//     "just for the pty transport" would be a reviewer's `pnpm install` failing, and the argument
//     for the transport port would quietly become an argument for a native module.
//   · No driver imports another driver. `@crr/surface-browser` and this package have parallel
//     `CaptureSink` types on purpose; a shared one would be a package boundary that exists to look
//     like architecture, and an import between two drivers is the thing the architecture forbids.
//
// DUPLICATION, DELIBERATE. Four packages carry a near-identical copy of the reader below. The
// alternative is a shared dev package, and a test that reads its OWN package's `src/` off disk
// cannot lie about which package it is describing.

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

const SOURCES = sourceFiles(SRC).map((path) => ({
  file: relative(SRC, path).replaceAll("\\", "/"),
  text: readFileSync(path, "utf8"),
}));

describe("the public surface of @crr/surface-terminal", () => {
  it("was actually read", () => {
    // The floor is the failure this catches: a moved directory or a walk that silently returned
    // nothing. Without it, deleting `src/` would make every assertion below pass.
    expect(MODULES.length).toBeGreaterThan(5);
    expect(MODULES.map((m) => m.file)).toContain("surface.ts");
    expect(MODULES.map((m) => m.file)).toContain("detect.ts");
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
    expect(typeof barrel.TerminalSurface).toBe("function");
    expect(typeof barrel.detect).toBe("function");
  });
});

describe("the two dependency decisions this package is built on", () => {
  it("does not reference node-pty anywhere in src/", () => {
    const offenders = SOURCES.filter(({ text }) => /["']node-pty["']/.test(text)).map(
      (s) => s.file,
    );
    expect(offenders).toEqual([]);
    const manifest = JSON.parse(readFileSync(resolve(SRC, "..", "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      expect(Object.keys(manifest[field] ?? {})).not.toContain("node-pty");
    }
  });

  it("imports no other driver", () => {
    const offenders = SOURCES.flatMap(({ file, text }) =>
      [...text.matchAll(/from\s+["'](@crr\/surface-(?!terminal)[^"']*)["']/g)].map(
        (m) => `${file}: ${m[1]}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("declares exactly the two runtime dependencies it needs", () => {
    const manifest = JSON.parse(readFileSync(resolve(SRC, "..", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@crr/core", "@xterm/headless"]);
  });

  it("imports @xterm/headless as a DEFAULT import, because v6 ships no exports map", () => {
    // `import { Terminal } from "@xterm/headless"` throws at load:
    //   SyntaxError: Named export 'Terminal' not found.
    // Asserted rather than commented, because the fix looks like a mistake and gets "corrected".
    const emulator = SOURCES.find((s) => s.file === "emulator.ts");
    expect(emulator?.text).toMatch(/^import\s+xtermPkg\s+from\s+"@xterm\/headless";$/m);
    // Anchored to the start of a line so the SyntaxError quoted in this file's own header comment
    // does not count as a violation of the rule it is documenting.
    expect(emulator?.text).not.toMatch(/^import\s*\{[^}]*\}\s*from\s*"@xterm\/headless"/m);
  });
});
