// CONTRACT TEST 2 of 2 (SPEC section 1.3): no CSS vocabulary above the drivers.
//
// BRIEF section 2 puts it as sharply as it can be put: "any artifact that stores a CSS selector has
// already failed". The reason is not taste. The assignment's surfaces include a green-screen teller
// application - a character grid with no elements, no attributes, no ids and no stylesheet - and
// SPEC section 1.2 says `@crr/surface-terminal` exists "to falsify the port". A selector reaching
// even one layer above the driver quietly makes the port browser-shaped, and the falsification stops
// being possible while every test still passes.
//
// So the rule is enforced on the text, in the packages that sit above the drivers: `@crr/core`,
// `@crr/runtime` and `@crr/discovery`. The latter two were named here before they existed, so that
// they would be covered on the day they arrived rather than on the day somebody remembered to add
// them. They have now arrived - 46 modules between them, including a driver-facing interpreter and
// a model loop - and the tests below assert that their sources are really being READ, because a
// package list is only worth what the file selection behind it is worth.
//
// WHAT THIS TEST IS NOT. It is not the artifact validator. A document arriving from disk can carry
// a selector in a descriptor position no matter how clean this source tree is, and refusing that is
// `text-safety.ts`'s job (SPEC section 10 check 10, `locatorShapeOf`) - asserted at the bottom of
// this file, because the two halves are only convincing together: this one covers the code, that
// one covers the data.
//
// Structure matches the purity test: scan, discrimination suite, ledger.

import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { locatorShapeOf, unsafeTextReason } from "../src/index.js";
import {
  ARCHITECTURE_EXEMPTIONS,
  type ArchitectureViolation,
  DRIVER_LIBRARIES,
  LOCATOR_TOKENS,
  type SourceFile,
  packageSources,
  scanForDriverImports,
  scanForLocatorVocabulary,
} from "./architecture-scan.js";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

/**
 * Everything above the drivers.
 *
 * `surface-browser` and `surface-terminal` are absent on purpose - a driver is precisely the layer
 * that is allowed to know what a stylesheet is. The fixtures are absent for the same reason from
 * the other end: `fixtures/corebank-web` is a hostile server-rendered application whose whole job
 * is to have generated ids and `<font>` tags in it.
 */
const ABOVE_THE_DRIVERS: readonly string[] = ["core", "runtime", "discovery", "conformance"];

const SOURCES: readonly SourceFile[] = packageSources(ROOT, ABOVE_THE_DRIVERS);

const format = (v: ArchitectureViolation): string =>
  `${v.path}:${v.line}  ${v.token}  -  ${v.why}\n    ${v.excerpt}`;

// ---------------------------------------------------------------------------------------------
// 1. The packages
// ---------------------------------------------------------------------------------------------

describe("the packages above the drivers", () => {
  it("were actually read - a scan of nothing is not a green test", () => {
    expect(SOURCES.length).toBeGreaterThan(25);
    // PER PACKAGE, not in aggregate. A total of 60 files proves nothing about `@crr/discovery` if
    // all 60 came from `@crr/core`, and that is exactly the state this suite was in while the other
    // two packages were still empty directories: green, and looking at one package.
    const counted = new Map(
      ABOVE_THE_DRIVERS.map((pkg) => [
        pkg,
        SOURCES.filter((f) => f.path.startsWith(`packages/${pkg}/src/`)).length,
      ]),
    );
    expect([...counted].filter(([, n]) => n === 0).map(([pkg]) => pkg)).toEqual([]);
    // Floors, not exact counts: a floor fails when a directory stops being read and does not fail
    // when somebody legitimately adds a module.
    expect(counted.get("core") ?? 0).toBeGreaterThan(25);
    expect(counted.get("runtime") ?? 0).toBeGreaterThan(15);
    expect(counted.get("discovery") ?? 0).toBeGreaterThan(10);
    expect(counted.get("conformance") ?? 0).toBeGreaterThan(5);
  });

  it("speak no locator vocabulary", () => {
    expect(scanForLocatorVocabulary(SOURCES).map(format)).toEqual([]);
  });

  it("import no driver, which is BRIEF section 3.1's other half of the same sentence", () => {
    // "the engine packages must contain no CSS-selector vocabulary and no import of any driver."
    // `@crr/core` gets the stronger allowlist form of this from `purity.test.ts`; these two cannot,
    // because they are the packages that legitimately own disk, sockets, clocks and a model SDK.
    //
    // The concrete failure: `crr`'s claim is that the driver is a PARAMETER (`--surface <module>`),
    // and `@crr/runtime` compiling without Playwright is the proof. One convenience import in
    // `cli.ts` would end that claim and break no test at all. Note the manifest is a SEPARATE
    // question this does not answer - `@crr/runtime` still lists `@crr/surface-browser` in
    // `dependencies` for its own browser-driving tests, and `docs/design/RUNTIME-STATUS.md` says so.
    expect(scanForDriverImports(SOURCES).map(format)).toEqual([]);
  });

  it("cover every package that is above a driver, including ones not written yet", () => {
    // The failure this catches is a package added later and never added here - the scan stays
    // green because it is not looking. So the list is checked against the WORKSPACE rather than
    // against itself: every directory under `packages/` is either a driver, and exempt because a
    // driver is precisely the layer allowed to know what a stylesheet is, or it is above the
    // drivers and must be on this list. `@crr/conformance` arrived and failed this test on the day
    // it did, which is exactly what it is for; the decision it forced was that a conformance suite
    // sits ABOVE the drivers even though it grades a replay engine. It runs entirely over
    // `MockSurface`, it names nodes by role and accessible name like everything else here, and its
    // deliberately weakened engines weaken a DECISION - never the perception the decision rests on.
    // A mutant that reached for a CSS selector would be modelling a different system.
    const inWorkspace = readdirSync(join(ROOT, "packages")).filter((entry) =>
      statSync(join(ROOT, "packages", entry)).isDirectory(),
    );
    const drivers = inWorkspace.filter((p) => p.startsWith("surface-"));
    const above = inWorkspace.filter((p) => !p.startsWith("surface-"));
    expect(above.length).toBeGreaterThan(0);
    expect([...above].sort()).toEqual([...ABOVE_THE_DRIVERS].sort());
    for (const driver of drivers) expect(ABOVE_THE_DRIVERS).not.toContain(driver);
    // Named explicitly as well, so that a workspace which somehow contained none of them could not
    // satisfy the set comparison above by being empty on both sides.
    expect(ABOVE_THE_DRIVERS).toContain("core");
    expect(ABOVE_THE_DRIVERS).toContain("runtime");
    expect(ABOVE_THE_DRIVERS).toContain("discovery");
    expect(ABOVE_THE_DRIVERS).toContain("conformance");
    expect(ABOVE_THE_DRIVERS).not.toContain("surface-browser");
    expect(ABOVE_THE_DRIVERS).not.toContain("surface-terminal");
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Can this test fail?
// ---------------------------------------------------------------------------------------------

describe("the scanner catches", () => {
  const scan = (text: string): readonly string[] =>
    scanForLocatorVocabulary([{ path: "synthetic.ts", text }]).map((v) => v.token);

  it("every token SPEC section 1.3 names", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["querySelector", "const el = root.querySelector(target.hint);"],
      ["css", "const locator = { css: target.hint };"],
      ["xpath", "await page.locator(`xpath=${hint}`).click();"],
      ["getElementById", "const el = document.getElementById(node.id);"],
      ["innerHTML", "const text = container.innerHTML;"],
      ["[data-", 'const sel = "[data-testid=submit]";'],
    ];
    expect(cases.map(([token]) => token).sort()).toEqual(
      [...LOCATOR_TOKENS].map((t) => t.token).sort(),
    );
    for (const [token, source] of cases) expect(scan(source)).toContain(token);
  });

  it("a selector hiding in a string, which is where one would actually be stored", () => {
    // The realistic leak is not a call. It is a field on a document: an overlay's "locator hint"
    // that somebody let through as free text because it was easier than deriving a descriptor.
    expect(
      scan('const hint = { kind: "css", value: "#ctl00_g_9a1 > td:nth-child(2)" };'),
    ).toContain("css");
  });

  it("the spellings a leak would really arrive in", () => {
    // `CSS`, `XPath`, `cssText`: matched case-insensitively, because a rule that only catches one
    // capitalisation is a rule with a workaround.
    expect(scan("const s = el.style.cssText;")).toContain("css");
    expect(scan("const p = buildXPath(node);")).toContain("xpath");
    expect(scan("const q = CSS.escape(name);")).toContain("css");
  });

  it("but does not fire on the words this domain legitimately uses", () => {
    // The near misses that would make the rule unusable if it were written as a substring search
    // over anything looser: a resolution that SUCCEEDS, an ACCESSIBLE name, a node ID.
    expect(scan("if (result.success) return accessibleNameOf(node);")).toEqual([]);
    expect(scan("const id = nodeIdOf(node); const path = containerPath;")).toEqual([]);
  });

  it("a driver reached for directly, and a driver reached for by the library it is made of", () => {
    // The discrimination half for `scanForDriverImports`. Three shapes, because a leak would
    // arrive as whichever one was most convenient at the time: the package by name, a relative
    // path into it from a sibling, and the automation library underneath it.
    const driverScan = (text: string): readonly string[] =>
      scanForDriverImports([{ path: "packages/runtime/src/synthetic.ts", text }]).map(
        (v) => v.token,
      );
    expect(driverScan('import { attach } from "@crr/surface-browser";')).toContain(
      "@crr/surface-browser",
    );
    expect(driverScan('import { grid } from "../../surface-terminal/src/grid.js";')).toContain(
      "../../surface-terminal/src/grid.js",
    );
    expect(driverScan('import { chromium } from "playwright";')).toContain("playwright");
    expect(driverScan('const p = await import("node-pty");')).toContain("node-pty");
    // And the near misses that would make it unusable: core, zod, the SDK, a node builtin, and a
    // sentence about the driver in a comment.
    expect(driverScan('import { link } from "@crr/core";')).toEqual([]);
    expect(driverScan('import { readFileSync } from "node:fs";')).toEqual([]);
    expect(driverScan('import Anthropic from "@anthropic-ai/sdk";')).toEqual([]);
    expect(
      driverScan("// the driver is a parameter; see @crr/surface-browser\nconst x = 1;"),
    ).toEqual([]);
    // The list is data, so a reader can see what it covers without reading the scanner.
    expect(DRIVER_LIBRARIES).toContain("playwright");
    expect(DRIVER_LIBRARIES).toContain("@xterm/headless");
  });

  it("but does not fire on prose explaining why the vocabulary is banned", () => {
    expect(
      scan("// not a querySelector: the descriptor names a role and a name\nconst x = 1;"),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. The other half: the data, not the code
// ---------------------------------------------------------------------------------------------

describe("the artifact validator refuses the same vocabulary in a document", () => {
  // A clean source tree does not make a clean artifact. SPEC section 1.3's closing sentence and
  // section 10 check 10 put the second half of this rule on the validator, and the pairing is what
  // makes either half worth anything - so the seam is asserted here rather than left implied.
  it("refuses a stylesheet selector in a descriptor position", () => {
    expect(locatorShapeOf("#ctl00_ctl32_g_9a1 > td:nth-child(2)")).not.toBeNull();
    expect(unsafeTextReason("#ctl00_ctl32_g_9a1 > td:nth-child(2)")).not.toBeNull();
  });

  it("refuses an XPath", () => {
    expect(locatorShapeOf("//table[2]/tr[3]/td[1]/a")).not.toBeNull();
  });

  it("accepts the accessible name a descriptor is actually made of", () => {
    expect(locatorShapeOf("Member Number")).toBeNull();
    expect(unsafeTextReason("Member Number")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// 4. The ledger
// ---------------------------------------------------------------------------------------------

describe("the exemption ledger", () => {
  it("is empty", () => {
    expect(ARCHITECTURE_EXEMPTIONS).toEqual([]);
  });
});
