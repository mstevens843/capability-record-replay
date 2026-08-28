// The browser factory `crr replay --surface` loads.
//
// THIS FILE IS THE PROOF OF A DESIGN CLAIM, not a convenience. `@crr/runtime` contains no import of
// Playwright, of `@crr/surface-browser`, or of anything that knows what a pixel is - a contract test
// in `@crr/core` reads the two engine packages off disk and fails if one ever appears. The driver
// reaches the interpreter through a module path on the command line, and this is that module. A
// green-screen factory over `@crr/surface-terminal` is the same twenty lines and needs no change
// anywhere above it.
//
// It is plain JavaScript because `--surface` is imported by URL at run time and is therefore not
// compiled by anything.
//
// It starts `fixtures/corebank-web` on an ephemeral loopback port. Nothing here reaches the public
// internet, reads a credential, or contacts a model.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { startFixtureServer } from "@crr/fixture-corebank-web";
import { attachBrowserSurface } from "@crr/surface-browser";
import { chromium } from "playwright";

/**
 * The route patterns the driver canonicalizes observed urls against.
 *
 * Read from the artifact rather than hard-coded, because a route table that has drifted from the
 * artifact silently turns every route predicate into "no route observed", and a checkpoint that
 * fails for the wrong reason is worse than one that fails. `CRR_DEMO_ARTIFACT` overrides the path,
 * which is resolved against the current directory.
 */
function routesFromArtifact() {
  const path = resolve(process.env.CRR_DEMO_ARTIFACT ?? "evidence/artifact/artifact.json");
  return JSON.parse(readFileSync(path, "utf8")).flow.routes;
}

export default async function openSurface() {
  const fixture = await startFixtureServer({ port: 0 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  // The frameset first: `banner`, `nav` and `content` only exist once the top document has loaded,
  // and every route this program names lands in `content`.
  await page.goto(`${fixture.origin}/`, { waitUntil: "load" });

  const surface = await attachBrowserSurface({
    page,
    origins: { corebank: fixture.origin },
    routes: routesFromArtifact(),
    primaryFrame: "content",
    geometry: "actionable",
  });

  return {
    surface,
    close: async () => {
      await browser.close();
      await fixture.close();
    },
  };
}
