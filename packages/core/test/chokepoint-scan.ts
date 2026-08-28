// The scanner behind the chokepoint contract test.
//
// SPEC section 1.2 explains why `@crr/policy` does not exist: a package boundary does not make a
// function the ONLY chokepoint, because nothing forces anyone to import it. SPEC section 8.1 names
// what does - "a contract test that reads the repo off disk and fails if any `Surface.act` call
// site is not immediately preceded by a `check` on the same action". This is that reader.
//
// It is a lexical scan, not a type-aware one, and that is a deliberate trade. A `ts-morph` pass
// would be more precise about which receiver is really a `Surface`; it would also be a dependency,
// a build step and a thing to keep working, in a repo whose whole argument is that the controls are
// cheap enough to actually keep. What a lexical scan gives up is precision on exotic shapes - so
// the exotic shapes are refused outright (`indirect-act`) rather than waved through, which is the
// direction a safety scan should be wrong in.
//
// It lives in `test/` rather than `src/` for a reason that is itself part of the architecture: it
// reads files off disk, and `@crr/core` may not.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

export type ChokepointViolationKind =
  /** An action was dispatched with no policy decision in front of it. */
  | "no-check"
  /** A decision was taken about a DIFFERENT action than the one dispatched. */
  | "wrong-action"
  /** A decision was taken and never read. A check whose answer is ignored is not a check. */
  | "decision-ignored"
  /** `act` was reached other than by a direct call, so no scan can prove what it was given. */
  | "indirect-act";

export interface ChokepointViolation {
  readonly path: string;
  readonly line: number;
  readonly kind: ChokepointViolationKind;
  readonly detail: string;
}

/** How many source lines may sit between the decision and the dispatch. Wide enough for a journal
 *  write and a settle call, narrow enough that the two stay readable as one unit. */
const WINDOW = 12;

/** An explicit, greppable opt-out. It exists so that a legitimate exception is a line in a diff
 *  somebody has to defend, rather than a scan everybody quietly stops trusting. The contract test
 *  asserts the list of exemptions is empty. */
export const CHOKEPOINT_EXEMPTION = "policy-chokepoint: exempt";

const ACT_CALL = /(?<![\w$?.])((?:[\w$]+\.)*[\w$]+)\.act\s*\(/g;
const CHECK_CALL = /(?<![\w$?.])check\s*\(/g;
const BRACKET_ACT = /\[\s*["'`]act["'`]\s*\]/g;
const DESTRUCTURED_ACT = /(?:const|let|var)\s*\{[^}]*\bact\b[^}]*\}\s*=/g;

export function scanForChokepointViolations(
  files: Iterable<SourceFile>,
): readonly ChokepointViolation[] {
  const violations: ChokepointViolation[] = [];
  for (const file of files) violations.push(...scanFile(file));
  return violations;
}

interface CallSite {
  readonly offset: number;
  readonly receiver: string;
  readonly argument: string;
}

function scanFile(file: SourceFile): readonly ChokepointViolation[] {
  // Comments and string bodies are blanked before anything is matched, so a `.act(` in a doc
  // comment is not a finding and a `check(` in one is not an alibi. Offsets and newlines survive.
  const code = blankCommentsAndStrings(file.text);
  // The indirect-access patterns are matched with the STRING BODIES INTACT: `surface["act"]` is a
  // string, and blanking it would blank the very thing being looked for.
  const withStrings = blankCommentsAndStrings(file.text, { blankStrings: false });
  const lineOf = lineIndexer(code);
  const out: ChokepointViolation[] = [];

  for (const pattern of [BRACKET_ACT, DESTRUCTURED_ACT]) {
    for (const match of withStrings.matchAll(pattern)) {
      out.push({
        path: file.path,
        line: lineOf(match.index),
        kind: "indirect-act",
        detail:
          "act is reached other than by a direct call, so no scan can prove a decision preceded it",
      });
    }
  }

  const acts: CallSite[] = [...code.matchAll(ACT_CALL)].map((m) => ({
    offset: m.index,
    receiver: m[1] as string,
    argument: firstArgument(code, m.index + m[0].length),
  }));
  const checks: CallSite[] = [...code.matchAll(CHECK_CALL)].map((m) => ({
    offset: m.index,
    receiver: "check",
    argument: firstArgument(code, m.index + m[0].length),
  }));

  for (const [nth, act] of acts.entries()) {
    const line = lineOf(act.offset);
    if (isExempt(file.text, line)) continue;
    const at = (kind: ChokepointViolationKind, detail: string): void => {
      out.push({ path: file.path, line, kind, detail });
    };

    const previousAct = acts[nth - 1]?.offset ?? -1;
    const guard = checks
      .filter((c) => c.offset < act.offset && c.offset > previousAct)
      .filter((c) => line - lineOf(c.offset) <= WINDOW)
      .at(-1);

    if (guard === undefined) {
      at("no-check", `${act.receiver}.act(${act.argument}) has no policy decision before it`);
      continue;
    }
    if (guard.argument !== act.argument) {
      at(
        "wrong-action",
        `the decision was taken about "${guard.argument}" and the action dispatched is "${act.argument}"`,
      );
      continue;
    }
    // The decision has to be READ. `check(a, ctx, at); await s.act(a, lease)` type-checks, passes a
    // naive scan, and enforces nothing at all.
    if (!/\ballow\b/.test(code.slice(guard.offset, act.offset))) {
      at("decision-ignored", `the decision about "${act.argument}" is taken and never consulted`);
    }
  }

  return out;
}

function isExempt(text: string, line: number): boolean {
  const lines = text.split("\n");
  for (let j = line - 1; j >= Math.max(0, line - 3); j--) {
    if ((lines[j] ?? "").includes(CHOKEPOINT_EXEMPTION)) return true;
  }
  return false;
}

/**
 * The first argument of a call that opens at `from`, as written.
 *
 * Compared as TEXT, and spanning line breaks so that a call the formatter wrapped reads the same as
 * one it did not. Two spellings of the same variable are a finding: a reader cannot tell them apart
 * either, and "the checked action and the dispatched action are obviously the same expression" is
 * the property this test exists to keep true.
 */
function firstArgument(code: string, from: number): string {
  let depth = 0;
  for (let i = from; i < code.length && i < from + 500; i++) {
    const c = code[i] as string;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return normalize(code.slice(from, i));
      depth--;
    } else if (c === "," && depth === 0) return normalize(code.slice(from, i));
  }
  return normalize(code.slice(from, from + 500));
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function lineIndexer(code: string): (offset: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === "\n") starts.push(i + 1);
  return (offset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * Replace comment bodies and string contents with spaces, preserving every newline and offset.
 *
 * Crude on purpose: it needs to be right about the four things that could otherwise fake a finding
 * or fake an alibi - line comments, block comments, quoted strings and template literals - and it
 * needs no opinion about anything else.
 */
export function blankCommentsAndStrings(
  text: string,
  options: { readonly blankStrings?: boolean } = {},
): string {
  const blankStrings = options.blankStrings ?? true;
  const out: string[] = [];
  let state: "code" | "line" | "block" | "'" | '"' | "`" = "code";
  const push = (ch: string, blank: boolean): void => {
    out.push(ch === "\n" ? "\n" : blank ? " " : ch);
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    const next = text[i + 1] ?? "";

    if (state === "code") {
      if (c === "/" && next === "/") state = "line";
      else if (c === "/" && next === "*") state = "block";
      else if (c === "'" || c === '"' || c === "`") {
        state = c;
        push(c, false);
        continue;
      }
      push(c, state !== "code");
      continue;
    }
    if (state === "line") {
      if (c === "\n") state = "code";
      push(c, true);
      continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") {
        push(c, true);
        out.push(" ");
        i++;
        state = "code";
        continue;
      }
      push(c, true);
      continue;
    }
    // Inside a string literal.
    if (c === "\\") {
      push(c, blankStrings);
      if (i + 1 < text.length) {
        push(text[i + 1] as string, blankStrings);
        i++;
      }
      continue;
    }
    if (c === state) {
      state = "code";
      push(c, false);
      continue;
    }
    push(c, blankStrings);
  }
  return out.join("");
}

// ---------------------------------------------------------------------------------------------
// Reading the repo
// ---------------------------------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", ".git", "test", "tests", "evidence"]);

/** Every shipped TypeScript source in the repo. Tests are excluded deliberately, and the exclusion
 *  is the honest part: a test that drives a `MockSurface` directly is exercising the DRIVER, not
 *  running a capability, and forcing a policy decision into it would make the contract test measure
 *  ceremony instead of shipped call sites. */
export function repoSources(root: string): readonly SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|mts|cts)$/.test(entry)) continue;
      if (/\.(test|spec)\.[cm]?tsx?$/.test(entry)) continue;
      if (/\.d\.ts$/.test(entry)) continue;
      files.push({ path: full.slice(root.length + 1), text: readFileSync(full, "utf8") });
    }
  };
  for (const top of ["packages", "apps", "examples", "fixtures"]) {
    try {
      if (statSync(join(root, top)).isDirectory()) walk(join(root, top));
    } catch {
      // A workspace directory that does not exist yet is not a violation.
    }
  }
  return files;
}
