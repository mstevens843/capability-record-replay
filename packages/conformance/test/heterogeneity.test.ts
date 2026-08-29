// THE ACCEPTANCE TEST FOR SPEC SECTION 11 UNIT 21.
//
//     "The same `activate` step lowers to `pressKey(F5)` on the grid and to a click on the browser;
//      both replay green."
//
// F5 is the spec's illustration; the measured pair in this repository is F3 and F12, because
// `fixtures/corebank-tui`'s two tenants of one vendor product bind Exit/Back to different function
// keys - which is the whole reason SPEC section 12.1 item 5 put F-keys at the PORT and kept them out
// of the artifact. The claim is stronger this way round: one artifact, no key anywhere in it, two
// different bytes on the wire, both runs green.
//
// The lowering happens in two places and this file separates them, because conflating them is how a
// heterogeneity claim ends up being a claim about one function:
//
//   ARTIFACT -> PORT   `{ kind: "activate" }` becomes the `click` action. Surface-independent, done
//                      by `@crr/core`'s linker and the interpreter, identical for both programs.
//   PORT -> SURFACE    `click` becomes bytes. On the grid, the key this tenant's legend printed. In
//                      the browser, a DOM click. This is the driver's half and the only half that
//                      differs.
//
// Both halves are exercised against real things: a live 80x24 fixture behind `@xterm/headless`, and
// a real Chromium against the real `fixtures/corebank-web` server. No credential, no network beyond
// 127.0.0.1, no model.

import { existsSync } from "node:fs";
import type { CapabilityArtifact, LeaseToken, NodeId, RoutePattern } from "@crr/core";
import { artifactDigestOf, link, sealArtifact } from "@crr/core";
import { startFixtureServer } from "@crr/fixture-corebank-web";
import { attachBrowserSurface } from "@crr/surface-browser";
import {
  TERMINAL_SUPPORTED_ROLES,
  TerminalSurface,
  createMemoryTransport,
} from "@crr/surface-terminal";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { artifact as browserArtifact, contract as browserContract } from "../src/corpus/flow.js";
import { runFlow } from "../src/corpus/harness.js";
import {
  TERMINAL_ORIGIN,
  summitOverlay,
  terminalAllowlist,
  terminalArtifact,
  terminalContract,
  terminalTrust,
} from "../src/corpus/terminal.js";
import { REFERENCE_ENGINE } from "../src/engines/mutants.js";
import { runTerminalFlow } from "./terminal/harness.js";
import { F3_BYTES, F12_BYTES } from "./terminal/scenarios.js";

// ---------------------------------------------------------------------------------------------
// Reading the two documents
// ---------------------------------------------------------------------------------------------

type Step = {
  readonly id: string;
  readonly instruction: Record<string, unknown>;
  readonly target: unknown;
};

const stepsOf = (a: CapabilityArtifact): readonly Step[] =>
  (a as unknown as { flow: { steps: readonly Step[] } }).flow.steps;

const stepNamed = (a: CapabilityArtifact, id: string): Step => {
  const found = stepsOf(a).find((s) => s.id === id);
  if (found === undefined) throw new Error(`no step named ${id}`);
  return found;
};

/** The role and the vocabulary token a target's `role-name` descriptor rests on. */
const roleNameOf = (target: unknown): { role: string; token: string } => {
  const descriptors = (target as { descriptors: readonly Record<string, unknown>[] }).descriptors;
  const byName = descriptors.find((d) => d.kind === "role-name");
  if (byName === undefined) throw new Error("this target has no role-name descriptor");
  return {
    role: String(byName.role),
    token: String((byName.name as { token: string }).token),
  };
};

const TERMINAL = terminalArtifact();
const BROWSER = browserArtifact();

// ---------------------------------------------------------------------------------------------
// 1. The step is the same step
// ---------------------------------------------------------------------------------------------

describe("one instruction, two programs", () => {
  it("the browser program and the green-screen program carry the IDENTICAL activate instruction", () => {
    // Byte-for-byte. `activate` has no arguments at all - the target is a separate field, and the
    // key is not expressible - so there is nothing in the instruction for a surface to leak into.
    // That is the design, and this is the assertion that it held once two surfaces existed.
    const terminal = stepNamed(TERMINAL, "run-inquiry").instruction;
    const browser = stepNamed(BROWSER, "submit-search").instruction;
    expect(terminal).toEqual({ kind: "activate" });
    expect(browser).toEqual({ kind: "activate" });
    expect(terminal).toEqual(browser);
  });

  it("both describe their control the same way: a role and a name, no coordinates and no key", () => {
    const terminal = roleNameOf(stepNamed(TERMINAL, "run-inquiry").target);
    const browser = roleNameOf(stepNamed(BROWSER, "submit-search").target);
    expect(terminal.role).toBe("button");
    expect(browser.role).toBe("button");
    // The tokens differ because the two documents have their own vocabularies; what matters is that
    // both are TOKENS resolved through `flow.vocabulary`, so an overlay reaches either one.
    expect(terminal.token).toBe("search-control");
    expect(browser.token).toBe("search-button");
  });

  it("the two artifacts declare DIFFERENT surfaces and different required features", () => {
    const target = (a: CapabilityArtifact) =>
      (a as unknown as { target: { surfaceKind: string; requires: readonly string[] } }).target;
    expect(target(TERMINAL).surfaceKind).toBe("terminal");
    expect(target(BROWSER).surfaceKind).toBe("web-legacy");
    expect(target(TERMINAL).requires).toContain("character-grid");
    expect(target(BROWSER).requires).toContain("accessibility-tree");
    // The one the green screen cannot offer, and the reason linker check 17 refuses at LOAD time
    // rather than at step six.
    expect(target(BROWSER).requires).toContain("route");
    expect(target(TERMINAL).requires).not.toContain("route");
  });
});

// ---------------------------------------------------------------------------------------------
// 2. THE PAYOFF: the same step, two surfaces, two lowerings, both green
// ---------------------------------------------------------------------------------------------

describe("the same activate step, lowered twice", () => {
  it("lowers to pressKey(F3) on the grid at riverbend, and the run is green", async () => {
    const run = await runTerminalFlow(REFERENCE_ENGINE, { tenant: "riverbend" });
    try {
      expect(run.out.result.status).toBe("ok");
      // F3 is `ESC O P`-family: an SS3 sequence. The artifact contains no `F3` and no escape byte.
      expect(run.keystrokes).toContain(F3_BYTES);
      expect(run.keystrokes).not.toContain(F12_BYTES);
    } finally {
      await run.close();
    }
  }, 30_000);

  it("lowers to pressKey(F12) at summit, from the SAME artifact and an overlay that says nothing about keys", async () => {
    const run = await runTerminalFlow(REFERENCE_ENGINE, { tenant: "summit" });
    try {
      expect(run.out.result.status).toBe("ok");
      expect(run.keystrokes).toContain(F12_BYTES);
      expect(run.keystrokes).not.toContain(F3_BYTES);
    } finally {
      await run.close();
    }
  }, 30_000);

  it("and the overlay that makes summit work mentions labels and screens, never a key", () => {
    const vocabulary = (summitOverlay as unknown as { vocabulary: Record<string, string[]> })
      .vocabulary;
    expect(Object.keys(vocabulary).sort()).toEqual([
      "account-field",
      "accounts-screen",
      "inquiry-screen",
    ]);
    // The measurement, stated as an assertion: the largest behavioural difference between these two
    // credit unions - which physical key submits a screen - costs nothing in the per-tenant file.
    const serialized = JSON.stringify(summitOverlay);
    for (let n = 1; n <= 12; n++) expect(serialized).not.toContain(`"F${n}"`);
  });

  it("the browser program's SAME activate step dispatches a click, and its run is green", async () => {
    const { out } = await runFlow(REFERENCE_ENGINE, {});
    expect(out.result.status).toBe("ok");
    // Cast rather than narrowed: `JournalEvent`'s discriminant widens to `string`
    // (docs/design/RUNTIME-STATUS.md section 7.3), so reading a field off an event needs one here.
    const acted = (out.journal.events as unknown as readonly Record<string, unknown>[]).filter(
      (e) => e.type === "acted" && e.stepId === "submit-search",
    );
    expect(acted).toHaveLength(1);
    expect(acted[0]?.actionKind).toBe("click");
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
// 3. ...and `click` really is a DOM click, against a real browser
// ---------------------------------------------------------------------------------------------

/**
 * Is a Chromium build actually on this machine?
 *
 * A browser test that cannot find a browser must say so LOUDLY and skip. A suite that quietly
 * skipped its browser half would report "all green" while proving nothing about the half of the
 * heterogeneity claim that involves a browser - which is the same class of false success this whole
 * package exists to refuse.
 */
const chromiumAvailable = (): boolean => {
  try {
    if (existsSync(chromium.executablePath())) return true;
  } catch {
    /* fall through to the warning */
  }
  process.stderr.write(
    "[@crr/conformance] SKIPPING the browser half of the heterogeneity test: no Chromium build " +
      "was found. Run `pnpm -F @crr/surface-browser exec playwright install chromium`. The green-screen half still ran.\n",
  );
  return false;
};

const BROWSER_ROUTES: readonly RoutePattern[] = [
  { id: "search", originAlias: "corebank", path: "/search", frame: "content" },
  { id: "results", originAlias: "corebank", path: "/search/results", frame: "content" },
] as unknown as readonly RoutePattern[];

describe.runIf(chromiumAvailable())("the other half of the lowering, in a real browser", () => {
  it("turns the port's click into a DOM submit that moves the content frame", async () => {
    const lease = "lease-heterogeneity" as LeaseToken;
    const fixture = await startFixtureServer({ port: 0 });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      // The frameset first: `content` does not exist until the top document has loaded.
      await page.goto(`${fixture.origin}/`, { waitUntil: "load" });
      const content = page.frames().find((f) => f.name() === "content");
      expect(content, "the fixture's content frame").toBeDefined();
      await content?.goto(`${fixture.origin}/search`, { waitUntil: "load" });

      const surface = await attachBrowserSurface({
        page: page as never,
        origins: { corebank: fixture.origin },
        routes: BROWSER_ROUTES,
        primaryFrame: "content",
        geometry: "actionable",
        lease,
      });

      const before = await surface.perceive({ deadlineMs: 10_000 });
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      expect(before.observation.route?.path).toBe("/search");

      // THE FIRST TEXTBOX, by ordinal, because this fixture is hostile on purpose: its inputs carry
      // no `for`/`id` pairing and no `aria-label`, so CDP computes an EMPTY accessible name for both
      // of them. That is the condition `ordinal-in-container` exists for, and it is why the browser
      // corpus's field target needs three descriptors to reach a quorum of two.
      const field = before.observation.nodes.find((n) => n.ariaRole === "textbox");
      const button = before.observation.nodes.find(
        (n) => n.ariaRole === "button" && n.name.includes("Search"),
      );
      expect(field, "the first textbox on the search form").toBeDefined();
      expect(button, "the Search button").toBeDefined();

      // The two port actions the two instructions lower to, dispatched by hand so that what is
      // under test is the DRIVER's half and nothing above it.
      const typed = await surface.act(
        {
          kind: "type",
          target: field?.id as NodeId,
          text: "50001",
          mode: "replace",
          sensitive: false,
        },
        lease,
      );
      expect(typed.ok).toBe(true);

      const clicked = await surface.act({ kind: "click", target: button?.id as NodeId }, lease);
      expect(clicked.ok).toBe(true);

      // The DOM click submitted the form and the content frame moved. On the grid, the same port
      // action wrote `\x1bOR` and the screen-id band moved from 01 to 02. Same instruction, same
      // port action, two entirely different mechanisms underneath, and nothing above the port knows.
      await content?.waitForURL(/\/search\/results/, { timeout: 10_000 });
      const after = await surface.perceive({ deadlineMs: 10_000 });
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.observation.route?.path).toBe("/search/results");
    } finally {
      await browser.close();
      await fixture.close();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// 4. Linker check 21: an F-key in an artifact is refused
// ---------------------------------------------------------------------------------------------

describe("no artifact may name a function key", () => {
  const terminalCapabilities = () =>
    new TerminalSurface({ transport: createMemoryTransport() }).capabilities();

  it("the shipped green-screen artifact contains no function key anywhere in its bytes", () => {
    const serialized = JSON.stringify(TERMINAL);
    for (let n = 1; n <= 12; n++) {
      expect(serialized, `F${n} appears in the artifact`).not.toContain(`"F${n}"`);
    }
    // And no escape byte either: the artifact is a document, not a keyboard. `JSON.stringify`
    // renders one as a \\u001b escape, which is what a hand-written VT sequence looks like on disk.
    expect(serialized).not.toContain("\\u001b");
  });

  it("GATE ONE - the schema has no member for a function key, so a sealed artifact cannot hold one", () => {
    // `ArtifactKeySchema` is a closed enum of thirteen editing/navigation keys. The port's `Key` has
    // F1-F12 because the terminal driver emits them; the program's vocabulary does not.
    const draft = withFKeyStep();
    // Through the same front door a recorder uses, so the refusal comes from the schema
    // rather than from a digest this test computed by hand.
    expect(() => sealArtifact(draft)).toThrow();
  });

  it("GATE TWO - and the linker refuses one anyway, for a document that never met the schema", () => {
    // A hand-edited JSON file on disk, or a document produced by a recorder built against an older
    // schema, reaches `link` without ever passing zod - `link` walks raw JSON on purpose, so that it
    // is the same function whether the artifact came from `sealArtifact` or from a text editor.
    const draft = withFKeyStep();
    const document = { ...draft, digest: artifactDigestOf(draft) };
    const result = link({
      contract: terminalContract,
      artifact: document,
      capabilities: terminalCapabilities(),
      args: { memberNumber: "12345" },
      allowlist: terminalAllowlist,
      trust: terminalTrust,
      mode: "replay",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const check21 = result.errors.filter((e) => e.check === 21);
    expect(check21.length, JSON.stringify(result.errors.slice(0, 4))).toBeGreaterThan(0);
    expect(check21[0]?.code).toBe("function-key-in-artifact");
    // The refusal explains itself with the measurement rather than with a rule number.
    expect(check21[0]?.message).toContain("F3");
    expect(check21[0]?.message).toContain("F12");
  });

  it("but the PORT advertises every function key, because that is where they belong", () => {
    const keys = new Set(terminalCapabilities().supportedKeys);
    for (let n = 1; n <= 12; n++) expect(keys).toContain(`F${n}`);
    // And the roles the driver can report, so the two halves of the port are visibly one object.
    expect(terminalCapabilities().supportedRoles).toEqual(TERMINAL_SUPPORTED_ROLES);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Both programs link, on their own surface and not on the other one
// ---------------------------------------------------------------------------------------------

describe("check 17 keeps each program on the surface it was recorded against", () => {
  it("the green-screen program links against the terminal driver", () => {
    const result = link({
      contract: terminalContract,
      artifact: TERMINAL,
      capabilities: new TerminalSurface({ transport: createMemoryTransport() }).capabilities(),
      args: { memberNumber: "12345" },
      allowlist: terminalAllowlist,
      trust: terminalTrust,
      mode: "replay",
    });
    expect(result.ok, JSON.stringify(result.ok ? [] : result.errors.slice(0, 3))).toBe(true);
  });

  it("and the BROWSER program is refused by it at load time, naming the missing feature", () => {
    // Not a runtime surprise six steps in: the browser program navigates, and a green screen has
    // nowhere to navigate to. The refusal happens before a transport is opened.
    const result = link({
      contract: browserContract,
      artifact: BROWSER,
      capabilities: new TerminalSurface({ transport: createMemoryTransport() }).capabilities(),
      args: { memberId: "50001" },
      allowlist: terminalAllowlist,
      trust: terminalTrust,
      mode: "replay",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain("surface-missing-feature");
    expect(codes).toContain("surface-missing-action");
  });
});

// ---------------------------------------------------------------------------------------------

/** The green-screen artifact with `run-inquiry` rewritten to press F3 directly - the shortcut the
 *  spec forbids, built here so the refusal can be observed rather than asserted. */
function withFKeyStep(): Record<string, unknown> {
  const base = JSON.parse(JSON.stringify(TERMINAL)) as Record<string, unknown>;
  const flow = base.flow as { steps: Record<string, unknown>[] };
  const step = flow.steps.find((s) => s.id === "run-inquiry");
  if (step === undefined) throw new Error("run-inquiry vanished");
  step.instruction = { kind: "pressKey", key: "F3" };
  step.target = null;
  for (const field of ["digest", "signatures", "lifecycle"]) delete base[field];
  base.signatures = [];
  base.lifecycle = { status: "draft", supersedes: null, approval: null };
  return base;
}
