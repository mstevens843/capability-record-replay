// The scanner behind the two contract tests SPEC section 1.3 names.
//
// Both tests make a claim about ABSENCE - that `@crr/core` contains no clock, no randomness, no
// I/O and no driver import, and that nothing above the drivers speaks CSS. An absence cannot be
// demonstrated by exercising the code; it is a property of the text, so the text is what gets read.
//
// Two decisions are worth stating up front, because both are places a scan like this normally goes
// quietly wrong:
//
//   1. COMMENTS ARE BLANKED, STRING BODIES ARE NOT. A comment cannot read a clock, and this repo's
//      sources explain at length WHY they do not call `crypto.subtle.digest` or `Date.now()` - a
//      scan that failed on those sentences would be a scan somebody deletes a paragraph to satisfy,
//      which is the opposite of what a contract test is for. A string body is different: it can be
//      a module specifier (`await import("node:fs")`), and it is exactly where a stored CSS
//      selector would live. So strings stay in.
//   2. THE SCANNER IS PROVED TO FAIL. Each test file carries a discrimination suite that runs this
//      scanner over sources that DO break the rule, one per token. A test asserting that a list is
//      empty passes just as green when its matcher has stopped matching.
//
// It lives in `test/` rather than `src/` for a reason that is itself the architecture: it reads
// files off disk, and `@crr/core` may not.

import { type SourceFile, blankCommentsAndStrings, repoSources } from "./chokepoint-scan.js";

export type ArchitectureRule =
  /** A clock, a random source, a socket, a timer or the process environment. */
  | "impurity"
  /** An import of a module this package is not allowed to depend on. */
  | "foreign-import"
  /** Locator vocabulary: the surface's private language, leaking above the driver. */
  | "locator-vocabulary";

export interface ArchitectureViolation {
  readonly path: string;
  readonly line: number;
  readonly rule: ArchitectureRule;
  /** The forbidden thing, spelled the way SPEC section 1.3 spells it. */
  readonly token: string;
  /** Why this token is forbidden here - carried on the finding so a failure message can say it. */
  readonly why: string;
  /** The offending line, trimmed. A finding a reader cannot locate is a finding they ignore. */
  readonly excerpt: string;
}

export interface ForbiddenToken {
  readonly token: string;
  readonly pattern: RegExp;
  readonly why: string;
}

// ---------------------------------------------------------------------------------------------
// What may not appear in a pure module
// ---------------------------------------------------------------------------------------------

/**
 * SPEC section 1.3's list, verbatim, minus the `surface-*` import which is a property of a module
 * specifier rather than of the text and is checked by `scanForForeignImports`.
 *
 * The `why` on each entry is not decoration. Every one of these has an obvious local convenience
 * and a non-obvious cost, and the cost is the reason the rule exists: the classifier's whole claim
 * is that a frozen `Observation` on disk plus a step index is a COMPLETE test case. One `Date.now()`
 * inside a settle decision and the same observation classifies two ways depending on the hour.
 */
export const IMPURE_TOKENS: readonly ForbiddenToken[] = [
  {
    token: "Date",
    pattern: /\bDate\b/g,
    why: "the current time is an argument (`PolicyMoment.now`, `Timestamp`), never a reading",
  },
  {
    token: "Math.random",
    pattern: /\bMath\s*\.\s*random\b/g,
    why: "a run that cannot be replayed from its journal is not a deterministic replay",
  },
  {
    token: "fetch(",
    pattern: /\bfetch\s*\(/g,
    why: "core decides; `@crr/runtime` and the drivers are what touch a socket",
  },
  {
    token: "node:",
    pattern: /node:/g,
    why: "a module that reads a file cannot be exercised from a frozen snapshot alone",
  },
  {
    token: "process.env",
    pattern: /\bprocess\s*\.\s*env\b/g,
    why: "linking must depend on the three documents and nothing else, or two hosts link differently",
  },
  {
    token: "setTimeout",
    pattern: /\bsetTimeout\b/g,
    why: "waiting is the interpreter's job; the settle POLICY is data the classifier reads",
  },
  {
    token: "setInterval",
    pattern: /\bsetInterval\b/g,
    why: "same: quiescence polling lives in `@crr/runtime`, where a clock is allowed",
  },
];

/**
 * SPEC section 1.3's second list.
 *
 * Matched case-insensitively, because `CSS`, `XPath` and `cssText` are the spellings a leak would
 * actually arrive in. The point is not that these strings are dangerous in themselves - it is that
 * the moment one appears above the driver, the artifact has started to describe a DOM, and the
 * green-screen surface (which has no elements, no attributes and no stylesheet) stops being
 * implementable behind the same port. BRIEF section 3.1 calls that the thing `surface-terminal`
 * exists to falsify.
 */
export const LOCATOR_TOKENS: readonly ForbiddenToken[] = [
  {
    token: "querySelector",
    pattern: /querySelector/gi,
    why: "a descriptor names a role and an accessible name; a query names a document",
  },
  {
    token: "css",
    pattern: /css/gi,
    why: "a character grid has no stylesheet, so a CSS-shaped locator cannot be resolved on one",
  },
  {
    token: "xpath",
    pattern: /xpath/gi,
    why: "an XPath is a path through a markup tree - the exact structure this design refuses to store",
  },
  {
    token: "getElementById",
    pattern: /getElementById/gi,
    why: "the fixture's ids are generated (`ctl00_ctl32_g_9a1`); an id is not an identity",
  },
  {
    token: "innerHTML",
    pattern: /innerHTML/gi,
    why: "markup is the driver's private input, not evidence any layer above it may read",
  },
  {
    token: "[data-",
    pattern: /\[data-/gi,
    why: "the target applications have no test ids, which is the premise of the whole assignment",
  },
];

// ---------------------------------------------------------------------------------------------
// Exemptions
// ---------------------------------------------------------------------------------------------

export interface Exemption {
  /** Path relative to the repository root, exactly as `repoSources` reports it. */
  readonly path: string;
  /** The token from `IMPURE_TOKENS` or `LOCATOR_TOKENS` this file is permitted to contain. */
  readonly token: string;
  /** The argument for it. A reviewer reads this, not the diff that introduced it. */
  readonly why: string;
}

/**
 * The exemption ledger, empty on purpose.
 *
 * It is data rather than a set of scattered `// eslint-disable`-shaped escape hatches so that
 * granting one is a single reviewable line with an argument attached to it, and so that the tests
 * can assert two things about the list: that it is empty today, and that no entry on it is DEAD -
 * an exemption whose file no longer contains the token is a permission nobody is using and nobody
 * remembers granting.
 *
 * If a unit genuinely needs one, add it here with the argument, and expect the test that asserts
 * emptiness to fail until somebody agrees with you in review.
 */
export const ARCHITECTURE_EXEMPTIONS: readonly Exemption[] = [];

function isExempt(
  exemptions: readonly Exemption[],
  file: SourceFile,
  token: ForbiddenToken,
): boolean {
  return exemptions.some((e) => e.path === file.path && e.token === token.token);
}

// ---------------------------------------------------------------------------------------------
// The scans
// ---------------------------------------------------------------------------------------------

function scanTokens(
  files: Iterable<SourceFile>,
  tokens: readonly ForbiddenToken[],
  rule: ArchitectureRule,
  exemptions: readonly Exemption[],
): readonly ArchitectureViolation[] {
  const out: ArchitectureViolation[] = [];
  for (const file of files) {
    // Comment bodies out, string bodies in. See the header for why the asymmetry.
    const code = blankCommentsAndStrings(file.text, { blankStrings: false });
    const lines = code.split("\n");
    const original = file.text.split("\n");
    for (const token of tokens) {
      if (isExempt(exemptions, file, token)) continue;
      // The `g` flag is dropped deliberately: a global regex carries `lastIndex` from one `test`
      // to the next, so a shared one would report every second hit and no more. That is the
      // classic way a scan like this silently stops scanning while still passing.
      const matcher = new RegExp(token.pattern.source, token.pattern.flags.replace("g", ""));
      for (const [index, line] of lines.entries()) {
        if (!matcher.test(line)) continue;
        out.push({
          path: file.path,
          line: index + 1,
          rule,
          token: token.token,
          why: token.why,
          excerpt: (original[index] ?? line).trim().slice(0, 120),
        });
      }
    }
  }
  return out;
}

/** SPEC section 1.3 test 1, the token half. */
export function scanForImpurity(
  files: Iterable<SourceFile>,
  exemptions: readonly Exemption[] = ARCHITECTURE_EXEMPTIONS,
): readonly ArchitectureViolation[] {
  return scanTokens(files, IMPURE_TOKENS, "impurity", exemptions);
}

/** SPEC section 1.3 test 2. */
export function scanForLocatorVocabulary(
  files: Iterable<SourceFile>,
  exemptions: readonly Exemption[] = ARCHITECTURE_EXEMPTIONS,
): readonly ArchitectureViolation[] {
  return scanTokens(files, LOCATOR_TOKENS, "locator-vocabulary", exemptions);
}

// Every way a module specifier can be written, including the two that a `from "..."` scan misses:
// a side-effect import and a dynamic one. `require` is here because a `.cts` file could still use
// it and the scan should not have a hole shaped like a file extension.
//
// Two tightenings, both of which this package's own sources demanded. The lookbehind stops the
// keyword being matched INSIDE a string - `z.discriminatedUnion("from", [...])` and
// `MockTransition["from"]` are both real lines here, and both read as `from "..."` to a scanner
// that does not care what precedes the word. And a specifier may not contain whitespace, which is
// what stops such a match from running away across three lines to find its closing quote.
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /(?<![\w$."'`])from\s*(["'])([^"'\s]+)\1/g,
  /(?<![\w$."'`])import\s*(["'])([^"'\s]+)\1/g,
  /(?<![\w$."'`])import\s*\(\s*(["'])([^"'\s]+)\1/g,
  /(?<![\w$."'`])require\s*\(\s*(["'])([^"'\s]+)\1/g,
];

export interface ModuleSpecifier {
  readonly spec: string;
  readonly line: number;
}

/** Every module specifier in a source, with the line each sits on. */
export function moduleSpecifiers(file: SourceFile): readonly ModuleSpecifier[] {
  const code = blankCommentsAndStrings(file.text, { blankStrings: false });
  const out: ModuleSpecifier[] = [];
  const seen = new Set<string>();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of code.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const spec = match[2] as string;
      // The patterns overlap on purpose - `import("x")` matches two of them - so the same
      // specifier at the same offset is reported once.
      const line = code.slice(0, match.index).split("\n").length;
      const key = `${line}:${spec}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ spec, line });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/** A specifier that names a driver package: `@crr/surface-browser`, `../surface-terminal/x.js`. */
export function isDriverSpecifier(spec: string): boolean {
  return spec.split("/").some((segment) => segment.startsWith("surface-"));
}

/**
 * The libraries a driver is MADE OF.
 *
 * `isDriverSpecifier` catches the package; this catches the shortcut around it. A module in
 * `@crr/runtime` that reached for `playwright` directly rather than importing
 * `@crr/surface-browser` would pass the first check and commit the identical sin: the engine would
 * know what a `Page` is, and `@crr/surface-terminal` - a character grid with no elements and no
 * pixels - would stop being implementable behind the same port while every test stayed green.
 *
 * It is a small list on purpose. It names the two surfaces this repo actually builds and the pty
 * library the terminal one needs; it is not an attempt to enumerate every automation library in
 * existence, and the allowlist form (`scanForForeignImports`) is the stronger rule where a package
 * can afford it. `@crr/core` can and does. `@crr/runtime` cannot: it is the package that owns disk,
 * sockets and clocks, so its legitimate import set is open-ended and a blocklist of the specific
 * thing it must not reach for is the honest control.
 */
export const DRIVER_LIBRARIES: readonly string[] = [
  "playwright",
  "playwright-core",
  "@playwright/test",
  "@xterm/headless",
  "xterm-headless",
  "node-pty",
  "puppeteer",
  "puppeteer-core",
  "selenium-webdriver",
];

/**
 * BRIEF section 3.1's other half: "the engine packages must contain no CSS-selector vocabulary AND
 * NO IMPORT OF ANY DRIVER."
 *
 * `@crr/core` gets the stronger allowlist form of this rule from `scanForForeignImports`. The two
 * packages above the drivers that are ALLOWED to do I/O do not, so this is their version of it, and
 * the failure it is here to catch is specific and cheap to make: `crr`'s whole claim is that the
 * driver is a PARAMETER (`--surface <module>`), and one convenience import in `cli.ts` would end
 * that claim without breaking a single test.
 */
export function scanForDriverImports(
  files: Iterable<SourceFile>,
  exemptions: readonly Exemption[] = ARCHITECTURE_EXEMPTIONS,
): readonly ArchitectureViolation[] {
  const out: ArchitectureViolation[] = [];
  for (const file of files) {
    const original = file.text.split("\n");
    for (const { spec, line } of moduleSpecifiers(file)) {
      const root = spec.startsWith("@")
        ? spec.split("/").slice(0, 2).join("/")
        : spec.split("/")[0];
      const driver = isDriverSpecifier(spec);
      const library = DRIVER_LIBRARIES.includes(root as string);
      if (!driver && !library) continue;
      if (exemptions.some((e) => e.path === file.path && e.token === spec)) continue;
      out.push({
        path: file.path,
        line,
        rule: "foreign-import",
        token: spec,
        why: driver
          ? "the driver is a parameter (`--surface <module>`), not a dependency of the engine"
          : "importing what a driver is made of is importing a driver by another name",
        excerpt: (original[line - 1] ?? spec).trim().slice(0, 120),
      });
    }
  }
  return out;
}

/**
 * SPEC section 1.3 test 1, the import half - and then some.
 *
 * The spec names `surface-*` and `node:`. This checks the stronger property those two are examples
 * of: a module in this package may import a RELATIVE path or one of `allowed`, and nothing else.
 * Stronger is worth it because the two the spec names are the imports we thought of. `playwright`,
 * `fs` written without its `node:` prefix, and `@crr/runtime` are the ones we did not, and each of
 * them would end the purity claim just as completely.
 */
export function scanForForeignImports(
  files: Iterable<SourceFile>,
  allowed: readonly string[],
): readonly ArchitectureViolation[] {
  const out: ArchitectureViolation[] = [];
  const permitted = new Set(allowed);
  for (const file of files) {
    const original = file.text.split("\n");
    for (const { spec, line } of moduleSpecifiers(file)) {
      if (spec.startsWith("./") || spec.startsWith("../")) continue;
      // The package root and a subpath export of it are the same dependency.
      const root = spec.startsWith("@")
        ? spec.split("/").slice(0, 2).join("/")
        : spec.split("/")[0];
      if (permitted.has(root as string)) continue;
      out.push({
        path: file.path,
        line,
        rule: "foreign-import",
        token: isDriverSpecifier(spec) ? "surface-* import" : spec,
        why: isDriverSpecifier(spec)
          ? "core decides what to do; a driver knows what a frame or a pixel is, and core may not"
          : `only ${allowed.join(", ")} and relative paths are permitted here`,
        excerpt: (original[line - 1] ?? spec).trim().slice(0, 120),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Choosing what to read
// ---------------------------------------------------------------------------------------------

/**
 * The shipped sources of the named packages.
 *
 * `src/` and not the whole package directory, and that boundary is the honest part: `test/` reads
 * the repository off disk with `node:fs` - this file does - and a purity rule that forbade that
 * would forbid the test that enforces purity. What ships is `tsup src/index.ts`, so `src/` is
 * exactly the set of modules the claim is about.
 */
export function packageSources(root: string, packages: readonly string[]): readonly SourceFile[] {
  const prefixes = packages.map((p) => `packages/${p}/src/`);
  return repoSources(root).filter((f) =>
    prefixes.some((prefix) => f.path.replaceAll("\\", "/").startsWith(prefix)),
  );
}

export type { SourceFile };
