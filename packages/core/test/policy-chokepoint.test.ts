// The contract test that holds up the "one chokepoint" claim.
//
// SPEC section 1.2 declines to create `@crr/policy`, and section 8.1 says why that is safe: a
// package boundary does not make `check` the only gate, because nothing forces anyone to import it.
// This test is what does. It reads every shipped source in the repo off disk and fails if any
// `Surface.act` call site is not immediately preceded by a `check` on the same action whose
// decision is then consulted.
//
// A contract test that scans for something absent has a specific way of going wrong: it passes
// because it looked at nothing, or because its matcher stopped matching. Both are silent. So this
// file has three parts, and the middle one is the important one:
//
//   1. the repo scan, with a floor on how many files it must have read;
//   2. a discrimination suite - the scanner run against sources that DO break the rule, one per
//      way of breaking it, asserting it catches each. This is the same move as the conformance
//      suite's mutants: a test that cannot fail is not evidence.
//   3. the exemption ledger, asserted empty.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CHOKEPOINT_EXEMPTION,
  type ChokepointViolationKind,
  type SourceFile,
  repoSources,
  scanForChokepointViolations,
} from "./chokepoint-scan.js";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

function scan(text: string): readonly ChokepointViolationKind[] {
  return scanForChokepointViolations([{ path: "synthetic.ts", text }]).map((v) => v.kind);
}

// ---------------------------------------------------------------------------------------------
// 1. The repo
// ---------------------------------------------------------------------------------------------

describe("the repository", () => {
  const files: readonly SourceFile[] = repoSources(ROOT);

  it("was actually read - a scan of nothing is not a green test", () => {
    // The floor is the failure this catches: a moved directory, a renamed workspace, a walk that
    // silently returned an empty list. Without it, deleting the repo would make this suite pass.
    expect(files.length).toBeGreaterThan(15);
    expect(files.some((f) => f.path.includes("surface"))).toBe(true);
  });

  it("dispatches no action that a policy decision did not authorize", () => {
    expect(scanForChokepointViolations(files)).toEqual([]);
  });

  it("carries no chokepoint exemptions", () => {
    // The opt-out exists so that a real exception has to be written down and defended in review.
    // Today there are none, and that is an assertion rather than a hope.
    const exempted = files.filter((f) => f.text.includes(CHOKEPOINT_EXEMPTION));
    expect(exempted.map((f) => f.path)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Can this test fail?
// ---------------------------------------------------------------------------------------------

describe("the scanner catches", () => {
  it("an action dispatched with no decision at all", () => {
    expect(
      scan(`
        async function run(surface: Surface, action: Action, lease: LeaseToken) {
          const result = await surface.act(action, lease);
          return result;
        }
      `),
    ).toEqual(["no-check"]);
  });

  it("a decision taken about a different action than the one dispatched", () => {
    // The subtlest of the four and the one a reviewer is least likely to see: the gate ran, the
    // journal has a `policy.decided` event, and the action that went to the driver is another one.
    expect(
      scan(`
        const decision = check(remedyAction, ctx, at);
        if (!decision.allow) return refuse(decision);
        await surface.act(stepAction, lease);
      `),
    ).toEqual(["wrong-action"]);
  });

  it("a decision that is taken and never read", () => {
    expect(
      scan(`
        check(action, ctx, at);
        await surface.act(action, lease);
      `),
    ).toEqual(["decision-ignored"]);
  });

  it("a decision that has drifted too far from the dispatch to be one unit", () => {
    const filler = Array.from({ length: 14 }, (_, i) => `          const x${i} = ${i};`).join("\n");
    expect(
      scan(`
        async function run() {
          const decision = check(action, ctx, at);
          if (!decision.allow) return refuse(decision);
${filler}
          await surface.act(action, lease);
        }
      `),
    ).toEqual(["no-check"]);
  });

  it("act reached by a bracket or a destructure, where no scan can follow it", () => {
    expect(scan(`const dispatch = surface["act"];`)).toEqual(["indirect-act"]);
    expect(scan("const { act } = surface;")).toEqual(["indirect-act"]);
  });

  it("a second dispatch that reuses the first one's decision", () => {
    // Two actions, one gate. The second `act` is not covered by the first decision - it is a
    // different action, and on a write flow it is the one that posts twice.
    expect(
      scan(`
        const decision = check(first, ctx, at);
        if (!decision.allow) return refuse(decision);
        await surface.act(first, lease);
        await surface.act(second, lease);
      `),
    ).toEqual(["no-check"]);
  });
});

describe("the scanner accepts", () => {
  it("the shape the interpreter is required to use", () => {
    expect(
      scan(`
        const decision = check(action, ctx, moment);
        journal.policyDecided(step.id, decision);
        if (!decision.allow) {
          return refused(step, decision);
        }
        const result = await surface.act(action, lease);
      `),
    ).toEqual([]);
  });

  it("a call the formatter wrapped across lines", () => {
    expect(
      scan(`
        const decision = check(
          action,
          ctx,
          moment,
        );
        if (!decision.allow) return refused(decision);
        const result = await surface.act(
          action,
          lease,
        );
      `),
    ).toEqual([]);
  });

  it("a destructured decision, which reads the answer just as well", () => {
    expect(
      scan(`
        const { allow, reason } = check(action, ctx, moment);
        if (!allow) return refused(reason);
        await surface.act(action, lease);
      `),
    ).toEqual([]);
  });

  it("two dispatches that each carry their own decision", () => {
    expect(
      scan(`
        const first = check(open, ctx, moment);
        if (!first.allow) return refused(first);
        await surface.act(open, lease);

        const second = check(confirm, ctx, moment);
        if (!second.allow) return refused(second);
        await surface.act(confirm, lease);
      `),
    ).toEqual([]);
  });

  it("prose and strings that merely mention acting", () => {
    // The scan blanks comments and string bodies first. Otherwise the file that DOCUMENTS the rule
    // would be the file that violates it, and the usual fix for that is to stop writing the
    // documentation.
    expect(
      scan(`
        // This used to be: await surface.act(action, lease) with no gate in front of it.
        /** @see surface.act(action, lease) */
        const help = "call surface.act(action, lease) only after check(action, ctx, at)";
        export const HINT = help;
      `),
    ).toEqual([]);
  });

  it("a driver DEFINING act, which is the port and not a call site", () => {
    expect(
      scan(`
        export class MockSurface implements Surface {
          async act(action: Action, lease: LeaseToken): Promise<ActResult> {
            return this.dispatch(action, lease);
          }
        }
      `),
    ).toEqual([]);
  });
});
