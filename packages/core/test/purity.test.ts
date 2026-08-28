// CONTRACT TEST 1 of 2 (SPEC section 1.3): `@crr/core` is pure.
//
// This is the architectural claim of the project, and it is the reason the package boundary is
// drawn on purity rather than on subject matter (SPEC section 1.2). Everything else in the design
// leans on it:
//
//   · the classifier is a total function from a frozen `Observation` to a `Verdict`, so the whole
//     error taxonomy is unit-testable with no browser, no fixture and no session (SPEC section 0.1);
//   · the linker's 28 checks depend on three documents and nothing else, so two hosts linking the
//     same artifact cannot reach different conclusions;
//   · `@crr/conformance` can grade a replay engine by feeding it recorded screens, because there is
//     nothing else for the engine to read.
//
// "Pure" here is not a comment in a header. It is: no clock, no randomness, no socket, no timer,
// no file, no process environment, and no import of a driver. Time and randomness are passed IN -
// `PolicyMoment.now`, `Timestamp`, `RunId` - which is what makes a run reproducible from its
// journal.
//
// The test has three parts, and the middle one is the one that matters:
//   1. the scan, with a floor on how much it read;
//   2. a discrimination suite - the scanner run against sources that DO break the rule, one per
//      forbidden token, asserting it catches each. A test that cannot fail is not evidence;
//   3. the exemption ledger, asserted empty.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ARCHITECTURE_EXEMPTIONS,
  type ArchitectureViolation,
  IMPURE_TOKENS,
  type SourceFile,
  isDriverSpecifier,
  moduleSpecifiers,
  packageSources,
  scanForForeignImports,
  scanForImpurity,
} from "./architecture-scan.js";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

/** Everything `@crr/core` ships. `tsup src/index.ts` reaches exactly this set. */
const CORE: readonly SourceFile[] = packageSources(ROOT, ["core"]);

/**
 * The complete dependency allowance for the pure package.
 *
 * One entry. `zod` is here because SPEC section 2 makes the schema the single source of truth and
 * `z.infer`s the types from it; it validates in memory and touches nothing. Anything else added to
 * this line is a design conversation, which is the point of the line.
 */
const ALLOWED_DEPENDENCIES: readonly string[] = ["zod"];

const format = (v: ArchitectureViolation): string =>
  `${v.path}:${v.line}  ${v.token}  -  ${v.why}\n    ${v.excerpt}`;

// ---------------------------------------------------------------------------------------------
// 1. The package
// ---------------------------------------------------------------------------------------------

describe("@crr/core", () => {
  it("was actually read - a scan of nothing is not a green test", () => {
    // Without a floor, moving `src/`, renaming the package or a walk that quietly returned an
    // empty list all turn this suite green. The named files are the ones whose absence would mean
    // the scan is looking at the wrong directory.
    expect(CORE.length).toBeGreaterThan(25);
    const paths = CORE.map((f) => f.path);
    expect(paths).toContain("packages/core/src/classify.ts");
    expect(paths).toContain("packages/core/src/linker.ts");
    expect(paths).toContain("packages/core/src/mock-surface.ts");
    expect(paths).toContain("packages/core/src/hash/sha256.ts");
  });

  it("reads no clock, no random source, no socket, no timer and no environment", () => {
    const violations = scanForImpurity(CORE);
    expect(violations.map(format)).toEqual([]);
  });

  it("imports nothing but zod and its own relative modules", () => {
    // The stronger form of "no `surface-*` import" and "no `node:`". Those two are the imports we
    // thought of; `playwright`, a bare `fs`, and `@crr/runtime` are the ones we did not, and each
    // ends the purity claim just as completely.
    const violations = scanForForeignImports(CORE, ALLOWED_DEPENDENCIES);
    expect(violations.map(format)).toEqual([]);
  });

  it("imports no driver, by any spelling of the specifier", () => {
    // Stated separately from the allowlist because it is the one SPEC section 1.3 names, and
    // because a relative path into a sibling package would slip past an allowlist that only looks
    // at bare specifiers.
    const drivers = CORE.flatMap((file) =>
      moduleSpecifiers(file)
        .filter((s) => isDriverSpecifier(s.spec))
        .map((s) => `${file.path}:${s.line} ${s.spec}`),
    );
    expect(drivers).toEqual([]);
  });

  it("declares no runtime dependency it is not allowed to import", () => {
    // The scan proves nothing IMPORTS a forbidden package. This proves none has been INSTALLED in
    // anticipation of doing so - the state that turns a purity breach into a one-line diff with no
    // manifest change next to it for a reviewer to notice.
    const manifest = JSON.parse(
      readFileSync(resolve(ROOT, "packages", "core", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(
      [...ALLOWED_DEPENDENCIES].sort(),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Can this test fail?
// ---------------------------------------------------------------------------------------------

describe("the scanner catches", () => {
  const scan = (text: string): readonly string[] =>
    scanForImpurity([{ path: "synthetic.ts", text }]).map((v) => v.token);

  it("every token SPEC section 1.3 names", () => {
    // One synthetic source per token, so a regex that has stopped matching shows up as a named
    // failure rather than as a suite that is still green over a smaller alphabet.
    const cases: readonly (readonly [string, string])[] = [
      ["Date", "const at = Date.now();"],
      ["Math.random", "const jitter = Math.random() * 100;"],
      ["fetch(", "const res = await fetch(url);"],
      ["node:", 'import { readFileSync } from "node:fs";'],
      ["process.env", "const key = process.env.ANTHROPIC_API_KEY;"],
      ["setTimeout", "setTimeout(() => resolve(null), 250);"],
      ["setInterval", "const handle = setInterval(poll, 50);"],
    ];
    expect(cases.map(([token]) => token).sort()).toEqual(
      [...IMPURE_TOKENS].map((t) => t.token).sort(),
    );
    for (const [token, source] of cases) expect(scan(source)).toContain(token);
  });

  it("a violation hidden behind a trailing comment on the same line", () => {
    expect(scan("const at = Date.now(); // the clock, right here")).toEqual(["Date"]);
  });

  it("a violation inside a template literal, where a naive string blank would lose it", () => {
    expect(scan("const s = `${Date.now()}`;")).toEqual(["Date"]);
  });

  it("more than one violation in one file, and reports the line of each", () => {
    const found = scanForImpurity([
      { path: "synthetic.ts", text: "const a = 1;\nconst b = Date.now();\nsetTimeout(f, 1);\n" },
    ]);
    expect(found.map((v) => [v.token, v.line])).toEqual([
      ["Date", 2],
      ["setTimeout", 3],
    ]);
  });

  it("but does not fire on prose that only DISCUSSES the forbidden call", () => {
    // The deliberate asymmetry, asserted rather than assumed. These sources explain at length why
    // they do not call `Date.now()` or `crypto.subtle.digest`; a scan that failed on those
    // sentences is a scan somebody deletes a paragraph to satisfy.
    expect(scan("// the caller passes Date.now() in; we never read it here\nconst x = 1;")).toEqual(
      [],
    );
    expect(scan("/* setInterval belongs in @crr/runtime */\nconst x = 1;")).toEqual([]);
  });

  it("and does not fire on an identifier that merely contains a token", () => {
    // `updated`, `candidate`, `validateAll` - the words this vocabulary would otherwise swallow.
    expect(scan("const updated = candidate; const d = validateAll(x);")).toEqual([]);
  });

  it("a foreign import, however it is spelled", () => {
    const foreign = (text: string): readonly string[] =>
      scanForForeignImports([{ path: "synthetic.ts", text }], ALLOWED_DEPENDENCIES).map(
        (v) => v.token,
      );
    expect(foreign('import { chromium } from "playwright";')).toEqual(["playwright"]);
    expect(foreign('import "reflect-metadata";')).toEqual(["reflect-metadata"]);
    expect(foreign('const fs = await import("node:fs");')).toEqual(["node:fs"]);
    expect(foreign('import { Surface } from "@crr/surface-browser";')).toEqual([
      "surface-* import",
    ]);
    expect(foreign('export { x } from "../../surface-terminal/src/grid.js";')).toEqual([]);
    // ...and the relative path into a driver is caught by the driver check instead, which is why
    // that check exists separately from the allowlist.
    expect(isDriverSpecifier("../../surface-terminal/src/grid.js")).toBe(true);
    expect(foreign('import { z } from "zod";')).toEqual([]);
    expect(foreign('import { canonicalJson } from "./canonical-json.js";')).toEqual([]);
  });

  it("and does not mistake the WORD `from` inside a string for an import", () => {
    // Not hypothetical. `ValueRefSchema` is a discriminated union on a field called `from`, and
    // `MockTransition["from"]` is a real type position, so both of these lines exist in this
    // package. A scanner that read them as imports would report four violations that are not
    // there - and a scan whose findings are noise is a scan that gets switched off.
    const foreign = (text: string): readonly string[] =>
      scanForForeignImports([{ path: "synthetic.ts", text }], ALLOWED_DEPENDENCIES).map(
        (v) => v.token,
      );
    expect(
      foreign('z.discriminatedUnion("from", [z.object({ from: z.literal("arg") })]);'),
    ).toEqual([]);
    expect(
      foreign('function scope(from: MockTransition["from"], screen: string) { return from; }'),
    ).toEqual([]);
    expect(foreign('registryField(record, "from", "extractor", at, add);')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. The ledger
// ---------------------------------------------------------------------------------------------

describe("the exemption ledger", () => {
  it("is empty", () => {
    // Not a hope: an assertion. Granting an exemption is one line with an argument attached, and
    // this test failing is what forces somebody to agree with the argument in review.
    expect(ARCHITECTURE_EXEMPTIONS).toEqual([]);
  });

  it("carries no dead entry - an exemption whose file no longer needs it", () => {
    // Vacuous while the ledger is empty, and deliberately written anyway: the moment an exemption
    // is granted, this is what stops it outliving the reason for it.
    const stale = ARCHITECTURE_EXEMPTIONS.filter((e) => {
      const file = CORE.find((f) => f.path === e.path);
      if (file === undefined) return true;
      const token = IMPURE_TOKENS.find((t) => t.token === e.token);
      if (token === undefined) return true;
      return scanForImpurity([file], []).every((v) => v.token !== e.token);
    });
    expect(stale).toEqual([]);
  });
});
