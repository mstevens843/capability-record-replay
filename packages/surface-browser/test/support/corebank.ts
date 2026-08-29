// Booting the hostile surface, and the guard that decides whether a browser test can run at all.
//
// TWO THINGS TO KNOW BEFORE EDITING THIS FILE.
//
// 1. `fixtures/corebank-web` is imported by PATH rather than by package name. It is a workspace
//    member and `@crr/surface-browser` does not declare it as a dependency, so pnpm has not linked
//    the scope into this package's `node_modules` - and adding the dependency means touching the
//    lockfile, which several agents are working against concurrently. The dynamic `import()` below
//    is therefore deliberate and TEMPORARY: when `"@crr/fixture-corebank-web": "workspace:*"` is
//    added to this package's devDependencies, this becomes a plain named import and the local
//    interface goes away.
//
// 2. Nothing here reaches the public internet, and nothing here needs a credential. The fixture is
//    a zero-dependency `node:http` server on an EPHEMERAL port, so many of these can run at once,
//    and every fault it can inject is armed over its own control endpoint.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Browser, type Page, chromium } from "playwright";

/** The slice of the fixture's public API these tests use. Mirrors the JSDoc on
 *  `startFixtureServer`; see note 1 above for why it is written out here. */
export interface FixtureServer {
  readonly port: number;
  readonly origin: string;
  close(): Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(here, "../../../../fixtures/corebank-web/src/server.js");

export async function startCorebank(): Promise<FixtureServer> {
  const module = (await import(pathToFileURL(SERVER_PATH).href)) as {
    startFixtureServer(opts: { port?: number }): Promise<FixtureServer>;
  };
  return module.startFixtureServer({ port: 0 });
}

/**
 * Is a Chromium build actually on this machine?
 *
 * A browser test that cannot find a browser should say so and skip, not fail forty times with a
 * download error. The hermetic half of this suite - normalization, geometry, routes, the PNG codec -
 * covers the logic and runs everywhere; what skips here is the part that genuinely needs a renderer.
 *
 * It says so LOUDLY, once, and that matters more than it looks. A suite that quietly skips its
 * browser half reports "all green" while proving nothing about the thing the package is for -
 * which is the same class of false success this whole project exists to refuse. If you see the
 * warning below under `pnpm test` at the repo root, the usual cause is that
 * `PLAYWRIGHT_BROWSERS_PATH` is set in your shell and turbo did not pass it through; it is in
 * `turbo.json`'s `globalPassThroughEnv` for exactly that reason.
 */
let warned = false;
export function chromiumAvailable(): boolean {
  let present = false;
  try {
    present = existsSync(chromium.executablePath());
  } catch {
    present = false;
  }
  if (!present && !warned) {
    warned = true;
    const where = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "the Playwright default cache";
    process.stderr.write(
      [
        "[@crr/surface-browser] SKIPPING every browser test: no Chromium build was found",
        `(looked under ${where}).`,
        "Run `pnpm -F @crr/surface-browser exec playwright install chromium`. The hermetic tests still ran.\n",
      ].join(" "),
    );
  }
  return present;
}

export interface BrowserFixture {
  readonly fixture: FixtureServer;
  readonly browser: Browser;
  readonly page: Page;
  close(): Promise<void>;
}

/** One fixture server, one browser, one page. The viewport is pinned so geometry assertions mean
 *  the same thing on every machine. */
export async function openCorebank(): Promise<BrowserFixture> {
  const fixture = await startCorebank();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  return {
    fixture,
    browser,
    page,
    close: async () => {
      await browser.close();
      await fixture.close();
    },
  };
}

/** Point the `content` frame at a url and wait for it to settle. The frameset's own url never
 *  changes, so this is how the flow moves in a frameset-era application. */
export async function gotoContent(page: Page, url: string): Promise<void> {
  const content = page.frames().find((frame) => frame.name() === "content");
  if (content === undefined) throw new Error("the content frame is not on this page");
  await content.goto(url, { waitUntil: "load" });
}
