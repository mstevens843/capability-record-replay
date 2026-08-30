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

/**
 * Arm one of the fixture's faults for THIS browser session, if `CRR_DEMO_FAULT` asks for one.
 *
 * WHY IT IS HERE AND NOT IN THE ENGINE. Arming a fault is a property of the deployment the driver
 * opened, not of the program being replayed, so it belongs beside the factory that started the
 * server - the same place `demo/surface.ts` puts it for the demo's own scenarios. Nothing above
 * this file learns that a fault exists.
 *
 * WHY IT EXISTS AT ALL. `crr promote` proves a detector by showing it fires on one frozen screen
 * and is silent on every other one the corpus holds, and the negatives that make that claim worth
 * anything are the OTHER abnormal screens at the same step - the app-error page, the sign-in
 * screen - which a fixture only produces on cue. Without this hook the only corpus `crr probe`
 * could build is "the happy path and the outcome", and a detector proven against that has been
 * shown to tell an answer from a success and from nothing else.
 *
 * The value is the query string of the fixture's own control endpoint, e.g.
 * `set=app-error&at=results&mode=sticky`. Unset - which is every `pnpm demo` run - arms nothing and
 * this function does not touch the network at all.
 */
async function armFaultIfAsked(page, origin) {
  const spec = process.env.CRR_DEMO_FAULT;
  if (spec === undefined || spec.length === 0) return;
  // Through the PAGE's request context, so the fixture's session cookie goes with it and the fault
  // is armed for the session the browser is actually driving.
  const response = await page.request.get(`${origin}/__fixture/fault?${spec}`);
  process.stderr.write(`fixture fault armed  ${JSON.stringify(await response.json())}\n`);
}

export default async function openSurface() {
  const fixture = await startFixtureServer({ port: 0 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  // The frameset first: `banner`, `nav` and `content` only exist once the top document has loaded,
  // and every route this program names lands in `content`.
  await page.goto(`${fixture.origin}/`, { waitUntil: "load" });
  await armFaultIfAsked(page, fixture.origin);

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
