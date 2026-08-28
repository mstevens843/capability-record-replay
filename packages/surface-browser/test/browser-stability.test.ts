// Two driver obligations that only exist against a real renderer: what "settled" means on a page,
// and what happens when a frame is in a process this CDP session cannot reach.

import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { BrowserSurfaceError } from "../src/errors.js";
import { attachBrowserSurface } from "../src/surface.js";
import { chromiumAvailable, openCorebank, startCorebank } from "./support/corebank.js";

describe.skipIf(!chromiumAvailable())(
  "quiescence is the surface's answer, not the program's",
  () => {
    it("is not settled while the response body is still arriving", async () => {
      const env = await openCorebank();
      try {
        await env.page.goto(`${env.fixture.origin}/`, { waitUntil: "load" });
        const surface = await attachBrowserSurface({
          page: env.page,
          origins: { corebank: env.fixture.origin },
          primaryFrame: "content",
        });
        const settledFirst = await surface.perceive({ deadlineMs: 10_000 });
        expect(settledFirst.ok && settledFirst.observation.stability.settled).toBe(true);

        // The fixture flushes the page chrome immediately and the data 1500ms later. The request is
        // therefore in flight the whole time - which is exactly the condition a torn read is taken
        // during, and the reason `settled` is computed from the wire and not from a DOM heuristic.
        const content = env.page.frames().find((frame) => frame.name() === "content");
        const navigation = content?.goto(
          `${env.fixture.origin}/search/results?lastName=PARKER&_fault=slow-load&_faultDelayMs=1500`,
          { waitUntil: "load" },
        );
        await new Promise((resolve) => setTimeout(resolve, 400));

        const midFlight = await surface.perceive({ deadlineMs: 10_000 });
        if (!midFlight.ok) throw new Error(JSON.stringify(midFlight.fault));
        expect(midFlight.observation.stability.settled).toBe(false);
        expect(midFlight.observation.stability.pendingReason).toBe("navigating");

        await navigation;
        const done = await surface.perceive({ deadlineMs: 10_000 });
        if (!done.ok) throw new Error(JSON.stringify(done.fault));
        expect(done.observation.stability.settled).toBe(true);
        expect(done.observation.stability.pendingReason).toBeNull();
        // `generation` is monotonic and moved, which is what a settle loop watches.
        expect(done.observation.stability.generation).toBeGreaterThan(
          settledFirst.ok ? settledFirst.observation.stability.generation : 0,
        );
        await surface.close();
      } finally {
        await env.close();
      }
    }, 30_000);
  },
);

describe.skipIf(!chromiumAvailable())("driver rule D7 - an out-of-process frame", () => {
  it("refuses to perceive rather than reporting a screen that is missing a document", async () => {
    // Forced with `--site-per-process`, because Playwright launches Chromium with no site-isolation
    // flags and a cross-origin iframe normally stays in the same process. When it does NOT:
    // `Page.getFrameTree` on the page session cannot see the child, its `DOM.getBoxModel` returns
    // FRAME-LOCAL coordinates, and a coordinate click computed from them misses the element.
    // Composing those offsets is doable; untested code in the path that decides where a click lands
    // inside a banking application is not the trade to make.
    const fixture = await startCorebank();
    const browser = await chromium.launch({ args: ["--site-per-process"] });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await page.goto(`http://127.0.0.1:${fixture.port}/search`, { waitUntil: "load" });
      // `localhost` and `127.0.0.1` are different origins to Chromium even on the same port. The
      // body is a string because this package compiles with no DOM lib on purpose - see the note in
      // `browser-act.test.ts`.
      const attached = await page.evaluate(`(() => {
        const f = document.createElement("iframe");
        f.name = "elsewhere";
        f.src = "http://localhost:${fixture.port}/search";
        document.body.appendChild(f);
        return document.getElementsByTagName("iframe").length;
      })()`);
      expect(attached).toBe(1);
      await page.waitForTimeout(600);

      const surface = await attachBrowserSurface({
        page,
        origins: { corebank: `http://127.0.0.1:${fixture.port}` },
      });
      const result = await surface.perceive({ deadlineMs: 10_000 });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.fault.kind).toBe("unperceivable-container");
      if (result.fault.kind !== "unperceivable-container") throw new Error("unreachable");
      expect(result.fault.detail).toContain("elsewhere");
      // A fault is journalled and a journal is evidence: no url reaches one.
      expect(result.fault.detail).not.toContain("http");
      await surface.close();
    } finally {
      await browser.close();
      await fixture.close();
    }
  }, 30_000);
});

describe.skipIf(!chromiumAvailable())("misuse is an exception, never a surface condition", () => {
  it("refuses a deadline that is not a positive integer", async () => {
    const env = await openCorebank();
    try {
      await env.page.goto(`${env.fixture.origin}/`, { waitUntil: "load" });
      const surface = await attachBrowserSurface({
        page: env.page,
        origins: { corebank: env.fixture.origin },
      });
      // The whole reason the deadline is in the signature is that an unbounded perceive hangs, so a
      // nonsensical one is the caller's bug and must not be laundered into a `perceive-timeout` a
      // conformance suite would then grade.
      await expect(surface.perceive({ deadlineMs: 0 })).rejects.toThrow(BrowserSurfaceError);
      await expect(surface.perceive({ deadlineMs: -1 })).rejects.toThrow(/positive integer/);
      await expect(surface.perceive({ deadlineMs: 1.5 })).rejects.toThrow(BrowserSurfaceError);
      await surface.close();
      await expect(surface.perceive({ deadlineMs: 100 })).rejects.toThrow(/closed surface/);
      await surface.close();
    } finally {
      await env.close();
    }
  }, 30_000);
});
