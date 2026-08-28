// Booting the hostile surface for the demo, with a real browser and no network beyond loopback.
//
// This file is the reason `@crr/runtime/src` can claim "the driver is a parameter". It is the only
// place in the demo that names Playwright or `@crr/surface-browser`, it lives OUTSIDE `src/`, and
// `test/demo-contract.test.ts` fails if any driver name appears in the other three files. A
// green-screen version of this module drops in beside it and every scenario runs unchanged.
//
// WHAT IT CONTACTS: a `node:http` server this process starts on an ephemeral loopback port, and a
// Chromium build already on the machine. Nothing else. No credential is read and no model API
// exists in this import graph.

import type { LeaseToken, RoutePattern, Surface } from "@crr/core";
// The fixture is a workspace package and is imported by name. It ships plain JavaScript with
// generated `.d.ts`, which is why there is no build step between editing it and running this.
import { startFixtureServer } from "@crr/fixture-corebank-web";
import { MemoryCaptureSink, attachBrowserSurface } from "@crr/surface-browser";
import type { BrowserSurface } from "@crr/surface-browser";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import type { SessionBroker } from "../src/session.js";

export interface DemoSurface {
  readonly origin: string;
  readonly surface: Surface;
  readonly broker: SessionBroker;
  readonly page: Page;
  /**
   * The bytes of a capture, by the ref `Surface.capture` returned.
   *
   * Off the port on purpose. `capture()` returns a content-addressed REF and a digest, never bytes,
   * because a run's decision path must never be able to look at a screenshot. Fetching the bytes to
   * write them to disk is a driver-level concern, so it is exposed here - beside the driver - and
   * not through the port the demo otherwise talks to.
   */
  captured(ref: string): Uint8Array | undefined;
  /** Arm one of the fixture's eight faults for THIS browser session, over its control endpoint. */
  arm(
    fault: string,
    options?: { readonly at?: string; readonly mode?: string; readonly delayMs?: number },
  ): Promise<unknown>;
  /** Point the content frame at a path. The frameset's own url never moves, so this is how a screen
   *  is reached without going through the program - used only by the masked-capture exhibit. */
  gotoContent(path: string): Promise<void>;
  close(): Promise<void>;
}

export function chromiumPath(): string | null {
  try {
    return chromium.executablePath();
  } catch {
    return null;
  }
}

export interface OpenOptions {
  readonly routes: readonly RoutePattern[];
  readonly lease?: LeaseToken | null;
  /**
   * What this deployment's session broker answers when a recovery asks it to re-establish the
   * session. It is a property of the DEPLOYMENT, not of the fixture: a credit union with a working
   * SSO integration answers `refreshed`, one without any way to sign in headlessly answers
   * `failed`, and the two produce genuinely different failure classes from the same screen. The
   * demo's scenarios each declare which deployment they are about, because a single hard-coded
   * answer would make one of the two unreachable and quietly narrow the taxonomy.
   */
  readonly refresh?: "refreshed" | "reopened" | "failed";
}

/** One fixture server, one browser, one page, one `Surface`, wrapped in a session broker. */
export async function openDemoSurface(options: OpenOptions): Promise<DemoSurface> {
  const fixture = await startFixtureServer({ port: 0 });
  let browser: Browser;
  try {
    browser = await chromium.launch();
  } catch (error) {
    await fixture.close();
    throw error;
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${fixture.origin}/`, { waitUntil: "load" });

  const captures = new MemoryCaptureSink();
  const browserSurface = await attachBrowserSurface({
    captureSink: captures,
    page,
    origins: { corebank: fixture.origin },
    routes: options.routes,
    primaryFrame: "content",
    geometry: "actionable",
    ...(options.lease === undefined ? {} : { lease: options.lease }),
  });

  const broker: SessionBroker = {
    open: async () => ({ sessionId: "corebank-demo", surface: browserSurface }),
    refresh: async () => options.refresh ?? "refreshed",
    close: async () => undefined,
  };

  return {
    origin: fixture.origin,
    surface: browserSurface,
    broker,
    page,
    captured: (ref) => captures.get(ref as never),
    arm: async (fault, opts = {}) => {
      const url = new URL(`${fixture.origin}/__fixture/fault`);
      url.searchParams.set("set", fault);
      if (opts.at !== undefined) url.searchParams.set("at", opts.at);
      if (opts.mode !== undefined) url.searchParams.set("mode", opts.mode);
      if (opts.delayMs !== undefined) url.searchParams.set("delayMs", String(opts.delayMs));
      // Through the PAGE's request context so the fixture's session cookie goes with it and the
      // fault is armed for the session the browser is actually driving.
      const response = await page.request.get(url.toString());
      return response.json();
    },
    gotoContent: async (path) => {
      const content = page.frames().find((frame) => frame.name() === "content");
      if (content === undefined) throw new Error("the content frame is not on this page");
      await content.goto(`${fixture.origin}${path}`, { waitUntil: "load" });
    },
    close: async () => {
      await browser.close();
      await fixture.close();
    },
  };
}
