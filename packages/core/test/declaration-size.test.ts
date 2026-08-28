// The declaration output is a build artifact with a budget, and this is the budget.
//
// WHY A TEST AND NOT A NOTE. `dist/index.d.ts` was 15,146,902 bytes before `src/schema-identity.ts`
// existed, because an exported `const XSchema = z.strictObject({...})` with no type annotation makes
// TypeScript print the whole inferred `z.ZodObject<{...}>` tree, and every parent schema re-prints
// its children's trees inside its own. That is invisible in review: the diff that reintroduces it is
// one `export const` that forgot its interface, and the symptom is a slow `tsc` three packages away.
// A number here is the only thing that notices.
//
// WHAT THE BUDGETS ARE CALIBRATED TO CATCH, verified by injecting the regression rather than
// asserted. Reverting ONE module (`result.ts`, seven schemas) to the unannotated form took
// `result.d.ts` from 22,522 to 64,521 bytes - the per-file cap catches that. Reverting three
// (`result`, `artifact`, `diagnostics`) took the total from 283,141 to 566,417 - the total cap
// catches that. Reverting all twelve is how the 15,146,902-byte file comes back, because the cost
// is multiplicative in the nesting rather than additive per schema. Neither budget will notice a
// few hundred bytes of honest growth, and neither is meant to.
//
// The emit runs in memory through the TypeScript API rather than reading `dist/`, so the test does
// not depend on a build having been run and cannot pass by measuring a stale file.

import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const PACKAGE = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Measured 283,141 bytes across 39 files. A three-module regression measured 566,417. */
const TOTAL_BUDGET_BYTES = 450_000;
/** Measured maximum was `artifact.d.ts` at 29,417 bytes. A one-module regression measured 64,521. */
const PER_FILE_BUDGET_BYTES = 60_000;

/** Runs `tsc --emitDeclarationOnly` for a parsed config and returns the bytes it WOULD have written. */
function emittedDeclarationBytes(
  options: ts.CompilerOptions,
  roots: readonly string[],
): {
  readonly total: number;
  readonly perFile: ReadonlyMap<string, number>;
  readonly diagnostics: readonly ts.Diagnostic[];
} {
  const program = ts.createProgram([...roots], {
    ...options,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    declarationMap: false,
    sourceMap: false,
  });
  const perFile = new Map<string, number>();
  const result = program.emit(undefined, (fileName, text) => {
    perFile.set(fileName, Buffer.byteLength(text, "utf8"));
  });
  let total = 0;
  for (const size of perFile.values()) total += size;
  return { total, perFile, diagnostics: result.diagnostics };
}

function parsedBuildConfig(): ts.ParsedCommandLine {
  const path = resolve(PACKAGE, "tsconfig.build.json");
  const read = ts.readConfigFile(path, (file) => readFileSync(file, "utf8"));
  expect(read.error).toBeUndefined();
  return ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(path));
}

const MEASURED = (() => {
  const config = parsedBuildConfig();
  return emittedDeclarationBytes(config.options, config.fileNames);
})();

describe("the declaration output stays small enough to be free", () => {
  it("was actually measured, so a zero below would be a broken measurement rather than a win", () => {
    expect(MEASURED.diagnostics).toEqual([]);
    expect(MEASURED.perFile.size).toBeGreaterThan(30);
    expect(MEASURED.total).toBeGreaterThan(50_000);
  });

  it("emits under the total budget", () => {
    expect(MEASURED.total).toBeLessThan(TOTAL_BUDGET_BYTES);
  });

  it("emits no single declaration file over the per-file budget", () => {
    const over = [...MEASURED.perFile.entries()]
      .filter(([, size]) => size > PER_FILE_BUDGET_BYTES)
      .map(([file, size]) => `${relative(PACKAGE, file)}: ${size} bytes`);
    expect(over).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The discrimination half: a budget test passes just as green when the thing it measures has
// stopped being measurable. These two compile the SAME schema shape with and without the
// `schema-identity` pattern and assert the difference is still enormous - so a TypeScript upgrade
// that changed how declarations are printed shows up here, with an explanation, rather than as an
// unexplained size regression in the tests above.
// ---------------------------------------------------------------------------------------------

const LEAF = `z.strictObject({
  one: z.string(), two: z.number(), three: z.boolean(), four: z.string().optional(),
  five: z.array(z.string()), six: z.enum(["a", "b", "c"]), seven: z.string().nullable(),
})`;
const COMPOSE = "z.strictObject({ leaf: Leaf, leaves: z.array(Leaf), maybe: Leaf.optional() })";

const WITHOUT_PATTERN = `import { z } from "zod";
export const Leaf = ${LEAF};
export const Mid = ${COMPOSE};
export const Top = z.strictObject({ mid: Mid, mids: z.array(Mid) });
export const Root = z.strictObject({ top: Top, tops: z.array(Top) });
`;

const WITH_PATTERN = `import { z } from "zod";
type Identity<S> = S;
const leafImpl = ${LEAF};
export interface LeafType extends Identity<typeof leafImpl> {}
export const Leaf: LeafType = leafImpl;
const midImpl = ${COMPOSE};
export interface MidType extends Identity<typeof midImpl> {}
export const Mid: MidType = midImpl;
const topImpl = z.strictObject({ mid: Mid, mids: z.array(Mid) });
export interface TopType extends Identity<typeof topImpl> {}
export const Top: TopType = topImpl;
export const Root = z.strictObject({ top: Top, tops: z.array(Top) });
`;

/** Compiles one synthetic module against the real `zod`, and returns its declaration bytes. */
function syntheticDeclarationBytes(source: string): number {
  const options = parsedBuildConfig().options;
  const file = resolve(PACKAGE, "src", "__declaration_size_probe__.ts");
  const host = ts.createCompilerHost(options, true);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = (name) => (name === file ? source : readFile(name));
  host.fileExists = (name) => name === file || fileExists(name);
  host.getSourceFile = (name, languageVersion) => {
    const text = host.readFile(name);
    return text === undefined ? undefined : ts.createSourceFile(name, text, languageVersion, true);
  };

  const program = ts.createProgram(
    [file],
    {
      ...options,
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      declarationMap: false,
    },
    host,
  );
  let bytes = 0;
  program.emit(undefined, (_name, text) => {
    bytes += Buffer.byteLength(text, "utf8");
  });
  expect(bytes).toBeGreaterThan(0);
  return bytes;
}

describe("the mechanism the budget depends on", () => {
  it("STILL EXPANDS a composed schema that does not use the pattern", () => {
    // If this ever stops being large, the budget above has become free to pass and means nothing.
    expect(syntheticDeclarationBytes(WITHOUT_PATTERN)).toBeGreaterThan(4_000);
  });

  it("prints a named interface by name, which is the whole saving", () => {
    const without = syntheticDeclarationBytes(WITHOUT_PATTERN);
    const withIt = syntheticDeclarationBytes(WITH_PATTERN);
    expect(withIt).toBeLessThan(without / 3);
  });
});
