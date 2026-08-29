// Booting the hostile surface for a real replay, and the guard that decides whether it can run.
//
// TWO THINGS TO KNOW BEFORE EDITING THIS FILE, both temporary and both about the lockfile rather
// than about the design.
//
// 1. `playwright` is resolved through `@crr/surface-browser`'s own `node_modules` rather than
//    imported by name. `@crr/runtime` does not declare it - the interpreter is written against the
//    `Surface` port and must not - and adding a devDependency means touching a lockfile several
//    agents are working against concurrently. When `"playwright"` is added to this package's
//    devDependencies this becomes a plain named import and `resolvePlaywright` goes away. The
//    NEEDED DEPENDENCY IS REPORTED rather than added.
// 2. `fixtures/corebank-web` is imported by path for the same reason, which is the precedent
//    `@crr/surface-browser`'s own test support already sets.
//
// Nothing here reaches the public internet and nothing here needs a credential. The fixture is a
// zero-dependency `node:http` server on an EPHEMERAL port, and every fault it can inject is armed
// over its own control endpoint.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LeaseToken, RoutePattern, Surface, SurfaceCapabilities } from "@crr/core";
import { attachBrowserSurface } from "@crr/surface-browser";
import type { BrokeredSession, SessionBroker } from "../../src/session.js";

const here = dirname(fileURLToPath(import.meta.url));
const SURFACE_BROWSER = resolve(here, "../../../surface-browser");
const SERVER_PATH = resolve(here, "../../../../fixtures/corebank-web/src/server.js");

export interface FixtureServer {
  readonly port: number;
  readonly origin: string;
  close(): Promise<void>;
}

/**
 * The two members of Playwright's surface these tests use.
 *
 * Written out rather than imported because the module is resolved by path (note 1 above) and its
 * own types are therefore not in scope. `Browser` and `Page` are structurally opaque here on
 * purpose: this file passes them straight to `attachBrowserSurface`, which is where they are typed
 * properly, and re-declaring their shapes would be a second copy of a third-party API.
 */
interface PlaywrightFrame {
  name(): string;
  goto(url: string, options?: { waitUntil?: string }): Promise<unknown>;
}
interface PlaywrightPage {
  goto(url: string, options?: { waitUntil?: string }): Promise<unknown>;
  frames(): readonly PlaywrightFrame[];
  request: { get(url: string): Promise<{ json(): Promise<unknown> }> };
}
interface PlaywrightBrowser {
  newPage(options?: unknown): Promise<PlaywrightPage>;
  close(): Promise<void>;
}
interface PlaywrightModule {
  chromium: {
    launch(options?: unknown): Promise<PlaywrightBrowser>;
    executablePath(): string;
  };
}

function resolvePlaywright(): PlaywrightModule {
  const require = createRequire(`${SURFACE_BROWSER}/package.json`);
  return require("playwright") as PlaywrightModule;
}

/**
 * Is a Chromium build actually on this machine?
 *
 * A browser test that cannot find a browser should say so LOUDLY and skip, not fail forty times
 * with a download error - and the loudness matters more than it looks. A suite that quietly skips
 * its browser half reports "all green" while proving nothing about the thing the package is for,
 * which is the same class of false success this whole project exists to refuse.
 */
let warned = false;
export function chromiumAvailable(): boolean {
  let present = false;
  try {
    present = existsSync(resolvePlaywright().chromium.executablePath());
  } catch {
    present = false;
  }
  if (!present && !warned) {
    warned = true;
    process.stderr.write(
      "[@crr/runtime] SKIPPING every browser replay test: no Chromium build was found. " +
        "Run `pnpm -F @crr/surface-browser exec playwright install chromium`. The hermetic tests still ran.\n",
    );
  }
  return present;
}

export async function startCorebank(): Promise<FixtureServer> {
  const module = (await import(pathToFileURL(SERVER_PATH).href)) as {
    startFixtureServer(opts: { port?: number }): Promise<FixtureServer>;
  };
  return module.startFixtureServer({ port: 0 });
}

export interface CorebankSession {
  readonly fixture: FixtureServer;
  readonly surface: Surface;
  readonly broker: SessionBroker;
  /** Arm one of the fixture's eight faults for THIS browser session, over its control endpoint.
   *  Scoped by the `CBSESSIONID` cookie, so concurrent tests on one server do not interfere. */
  arm(
    fault: string,
    options?: { readonly at?: string; readonly mode?: string; readonly delayMs?: number },
  ): Promise<unknown>;
  /**
   * The fixture's own account of what it holds for THIS session - the system of record, read
   * outside the interpreter.
   *
   * The only honest way to assert "the write happened exactly once". A confirmation screen saying
   * an account was opened is the application's claim about itself; the count of sub-accounts the
   * core is holding afterwards is the fact. A replay engine that double-posted would show a green
   * confirmation both times.
   */
  state(): Promise<{
    readonly session: string;
    readonly dialogMode: string;
    readonly members: readonly { readonly memberId: string; readonly subAccounts: number }[];
  }>;
  /**
   * Point the `content` frame at a path under this session's tenant and wait for it to load.
   *
   * The frameset's own url never changes in a frameset-era application, so this is how a screen is
   * reached without going through the program. Build unit 19 uses it to perceive the SAME four
   * screens at two tenants for the cross-tenant divergence report: the report is a measurement of
   * the surfaces, taken outside the interpreter on purpose, so that it cannot be confused with
   * evidence about the run.
   */
  gotoContent(path: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * One fixture server, one browser, one page, one `Surface`, wrapped in a session broker.
 *
 * The broker's `refresh` reports `refreshed` and does nothing, and that is honest for this fixture
 * rather than a shortcut: the "session" here is a browser page that never expires, so there is
 * nothing to re-establish. A broker in front of a real core banking system re-runs an SSO flow, and
 * the one place that difference shows up is that `session-expired-unrecoverable` is unreachable
 * against this fixture. Said out loud because a test that silently made a failure class unreachable
 * would be proving less than it looks.
 */
export async function openCorebankSession(
  routes: readonly RoutePattern[],
  options: {
    readonly viewport?: { width: number; height: number };
    /**
     * The tenant's mount point, e.g. `/cb` for summit. Empty for riverbend.
     *
     * It is the frameset entry that moves, NOT the origin: both tenants of this fixture are served
     * by one process on one port, which is what makes the two runs comparable - the only thing that
     * differs between them is the application, not the network. A real deployment would give each
     * tenant its own host and the overlay would bind a different `originAliases` entry; the base
     * path is the harder case of the two and is the one the overlay's `routeBasePath` exists for.
     */
    readonly basePath?: string;
  } = {},
): Promise<CorebankSession> {
  const { chromium } = resolvePlaywright();
  const fixture = await startCorebank();
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: options.viewport ?? { width: 1280, height: 900 },
  });
  // The frameset first: `banner`, `nav` and `content` only exist once the top document has loaded,
  // and every route this program names lands in `content`.
  const basePath = options.basePath ?? "";
  await page.goto(`${fixture.origin}${basePath}/`, { waitUntil: "load" });

  const surface = await attachBrowserSurface({
    // `attachBrowserSurface` is the one place these are typed properly; this file only carries them
    // from `newPage` to the driver.
    page: page as never,
    origins: { corebank: fixture.origin },
    routes,
    primaryFrame: "content",
    geometry: "actionable",
  });

  const broker: SessionBroker = {
    open: async (): Promise<BrokeredSession> => ({ sessionId: "corebank-fixture", surface }),
    refresh: async () => "refreshed",
    close: async () => undefined,
  };

  return {
    fixture,
    surface,
    broker,
    arm: async (fault, opts = {}) => {
      const url = new URL(`${fixture.origin}/__fixture/fault`);
      url.searchParams.set("set", fault);
      if (opts.at !== undefined) url.searchParams.set("at", opts.at);
      if (opts.mode !== undefined) url.searchParams.set("mode", opts.mode);
      if (opts.delayMs !== undefined) url.searchParams.set("delayMs", String(opts.delayMs));
      // Through the PAGE's request context, so the fixture's session cookie goes with it and the
      // fault is armed for the session the browser is actually driving.
      const response = await page.request.get(url.toString());
      return response.json();
    },
    state: async () => {
      const response = await page.request.get(`${fixture.origin}/__fixture/state`);
      return (await response.json()) as Awaited<ReturnType<CorebankSession["state"]>>;
    },
    gotoContent: async (path) => {
      const content = page.frames().find((frame) => frame.name() === "content");
      if (content === undefined) throw new Error("the content frame is not on this page");
      await content.goto(`${fixture.origin}${basePath}${path}`, { waitUntil: "load" });
    },
    close: async () => {
      await browser.close();
      await fixture.close();
    },
  };
}

export type { LeaseToken, SurfaceCapabilities };
