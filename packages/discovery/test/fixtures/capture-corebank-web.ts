// Capture the frozen `Observation` corpus, by running the discovery loop against the REAL browser.
//
//   pnpm -F @crr/discovery fixtures:capture
//
// This is the ONE step in the whole seam that needs a Chromium build, and it is the reason the rest
// of it does not. It boots `fixtures/corebank-web` on an ephemeral loopback port, drives it through
// `@crr/surface-browser`'s CDP accessibility-tree driver, and writes down the three screens the
// application actually produced in response to the three actions `SCRIPT` performs. Everything
// downstream - the recorded run, synthesis, the emitted documents, and the drift test that pins
// them - then runs from that file with no browser at all.
//
// WHY THE LOOP AND NOT THREE `perceive()` CALLS. A corpus assembled by navigating to three URLs
// would be three screens that happen to exist; this is the screen the app served in response to the
// click the program will make, which is the only thing that makes the recording a recording. It
// also means the hand-authored node references in `REFS` are validated against the live
// application at capture time, not just against the file they came from.
//
// NO MODEL AND NO CREDENTIAL. The model is `createScriptedModel` over hand-authored turns, and the
// only socket opened is to 127.0.0.1. BRIEF section 11.
//
// TWO IMPORTS BY PATH, AND THEY ARE DELIBERATE. `@crr/discovery` does not declare `playwright`,
// `@crr/surface-browser` or `@crr/fixture-corebank-web`, and it must not: the package that owns the
// model loop has no business depending on a driver, `packages/core/test/no-locator-vocabulary.test.ts`
// reads `packages/discovery/src` off disk to say so, and adding a dependency means an install this
// pass was not permitted to run. A capture script in `test/fixtures/` resolving them by path is the
// precedent `packages/runtime/test/support/corebank.ts` already sets, with the same reasoning.

import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  LeaseToken,
  Observation,
  PerceiveResult,
  RouteId,
  RoutePattern,
  Surface,
  SurfaceCapabilities,
} from "@crr/core";
import { createScriptedModel } from "../../src/index.js";
import {
  CONTROL,
  type CorebankWebCorpus,
  OBSERVATIONS_FILE,
  RECORDED_MEMBER_ID,
  SCRIPT,
  checkRefs,
  runOver,
} from "./corebank-web.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PACKAGES = resolve(HERE, "..", "..", "..");
const SURFACE_BROWSER = resolve(PACKAGES, "surface-browser");
const FIXTURE_SERVER = resolve(PACKAGES, "..", "fixtures", "corebank-web", "src", "server.js");

// The three routes this capability touches. They are the driver's canonicalization table, which is
// why `/member/:memberId` is a PATTERN here: an `Observation` gets written to disk, and a member
// number in a path is persisted member data (SPEC section 3.6). The corpus below is safe to commit
// because of this line.
const ROUTES: readonly RoutePattern[] = [
  { id: "search" as RouteId, originAlias: "corebank", path: "/search", frame: "content" },
  {
    id: "search-results" as RouteId,
    originAlias: "corebank",
    path: "/search/results",
    frame: "content",
  },
  {
    id: "member-by-memberid" as RouteId,
    originAlias: "corebank",
    path: "/member/:memberId",
    frame: "content",
  },
];

interface PlaywrightPage {
  goto(url: string, options?: { waitUntil?: string }): Promise<unknown>;
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

const { chromium } = createRequire(`${SURFACE_BROWSER}/package.json`)(
  "playwright",
) as PlaywrightModule;

const { attachBrowserSurface } = (await import(
  pathToFileURL(resolve(SURFACE_BROWSER, "src", "index.ts")).href
)) as {
  attachBrowserSurface(options: {
    page: unknown;
    origins: Readonly<Record<string, string>>;
    routes: readonly RoutePattern[];
    primaryFrame: string;
    geometry: string;
    lease: LeaseToken;
  }): Promise<Surface>;
};

const { startFixtureServer } = (await import(pathToFileURL(FIXTURE_SERVER).href)) as {
  startFixtureServer(opts: {
    port?: number;
  }): Promise<{ origin: string; close(): Promise<unknown> }>;
};

const fixture = await startFixtureServer({ port: 0 });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  // The frameset first: `banner`, `nav` and `content` only exist once the top document has loaded,
  // and every route this program names lands in `content`. The content frame's own default src is
  // `/search`, which is why the emitted flow has no opening `navigate` step - a brokered session
  // already lands where the program starts.
  await page.goto(`${fixture.origin}/`, { waitUntil: "load" });

  const surface = await attachBrowserSurface({
    page,
    origins: { corebank: fixture.origin },
    routes: ROUTES,
    primaryFrame: "content",
    geometry: "actionable",
    // The lease the loop holds. `Surface.act` refuses an action from a non-holder as a matter of
    // enforcement rather than convention (BRIEF section 3.5), so a capture script that forgot this
    // gets `lease-not-held` on every dispatch - which is the port working.
    lease: CONTROL.token,
  });

  // A SETTLING `perceive`, and the reason is the one thing this capture cannot get wrong.
  //
  // `Surface.act` dispatches and returns; it does not wait for a navigation, because waiting is a
  // POLICY and the port is a mechanism (`@crr/runtime`'s `settle()` owns it at replay time, with a
  // budget and a ledger). The discovery loop has no settle loop of its own by design - SPEC section
  // 6.1 leaves readiness to the model's next `observe` - so a click on Search, perceived
  // immediately, returns the search screen the browser has not navigated away from yet. Measured:
  // without this, the corpus's `results` screen came back as the pre-click search form and every
  // later node reference in the script was refused as stale.
  //
  // So the capture surface polls until two consecutive snapshots agree, which is the same law the
  // settle loop applies (`stableSamples`), and freezes THAT. A corpus of half-loaded screens would
  // be a corpus of checkpoints that can never hold.
  const settlingPerceive = async (opts: {
    readonly deadlineMs: number;
  }): Promise<PerceiveResult> => {
    const deadline = Date.now() + 8000;
    let previous: string | null = null;
    let last = await surface.perceive(opts);
    while (Date.now() < deadline) {
      const key = last.ok
        ? `${last.observation.route?.path ?? "-"}|${last.observation.skeletonDigest}|${last.observation.stability.settled}`
        : `fault:${last.fault.kind}`;
      if (key === previous && last.ok && last.observation.stability.settled) return last;
      previous = key;
      await new Promise((resolve) => setTimeout(resolve, 80));
      last = await surface.perceive(opts);
    }
    return last;
  };

  const capturing: Surface = {
    perceive: settlingPerceive,
    act: surface.act.bind(surface),
    capture: surface.capture.bind(surface),
    capabilities: surface.capabilities.bind(surface),
  };

  const run = await runOver({
    surface: capturing,
    model: createScriptedModel(SCRIPT, { modelId: "synthetic-script" }),
  });

  if (run.status !== "reached-goal") {
    throw new Error(
      [
        `the capture run ended "${run.status}" (${run.summary}); the corpus was NOT written.`,
        "Either the fixture's markup moved under the node references in REFS, or the script no",
        "longer describes a run this application permits.",
      ].join(" "),
    );
  }
  if (run.steps.length !== 3) {
    throw new Error(
      [
        "expected 3 dispatched steps (fill, activate Search, activate Open) and the run recorded",
        `${run.steps.length}; the corpus was NOT written.`,
      ].join(" "),
    );
  }

  // The four screens, taken off the RUN rather than off a second set of navigations.
  //
  //   search       - what the model was shown before it typed anything, so the committed corpus
  //                  carries no member number in the field it was about to be typed into;
  //   searchFilled - the same screen after the fill. Kept because it is NOT the same tree: Chromium
  //                  materialises a StaticText node for the value, which shifts every later index
  //                  by one (see REFS.searchButton);
  //   results      - the screen the search click produced, which the model read three cells off;
  //   detail       - the screen the row link produced, which is where the flow ends.
  const [fill, submit, open] = run.steps;
  const after = open?.after;
  if (
    fill === undefined ||
    submit === undefined ||
    open === undefined ||
    after === null ||
    after === undefined
  ) {
    throw new Error("the run did not record the four observations the corpus needs");
  }
  const screens: Readonly<Record<string, Observation>> = {
    search: fill.observation,
    searchFilled: submit.observation,
    results: open.observation,
    detail: after,
  };

  const corpus: CorebankWebCorpus = {
    _readme:
      "A frozen Observation corpus captured from fixtures/corebank-web through @crr/surface-browser " +
      "(CDP Accessibility.getFullAXTree). The SCREENS ARE REAL - these are the accessible names, " +
      "container paths, table positions and geometry that application actually produces, which is " +
      "why an artifact synthesized from them can be executed against it. The MODEL WAS NOT: the run " +
      "that produced this was driven by a hand-authored script, no provider was called, and this " +
      "file is NOT evidence of a discovery run. All member data is synthetic (see " +
      "fixtures/corebank-web/src/data.js). Regenerate with: pnpm -F @crr/discovery fixtures:capture",
    capture: {
      driver: surface.capabilities().driver,
      fixture: "fixtures/corebank-web",
      tenantId: "riverbend",
      capturedAt: new Date().toISOString(),
      command: "pnpm -F @crr/discovery fixtures:capture",
    },
    capabilities: surface.capabilities() as SurfaceCapabilities,
    screens: screens as CorebankWebCorpus["screens"],
  };

  // A last look before it is written: the node references this fixture's script is built out of
  // must still name the controls they were chosen for.
  checkRefs(corpus);

  // Compact, one line. Nobody reads a 130-node accessibility tree in a diff, and a pretty-printed
  // copy is twice the bytes for a file whose only reader is a parser.
  writeFileSync(join(HERE, OBSERVATIONS_FILE), `${JSON.stringify(corpus)}\n`, "utf8");
  const counts = Object.entries(screens)
    .map(([name, observation]) => `${name} ${observation.nodes.length}`)
    .join(", ")
    .concat(" nodes");
  process.stdout.write(
    `wrote ${OBSERVATIONS_FILE}: ${counts}, member ${RECORDED_MEMBER_ID}, driver ${corpus.capture.driver}\n`,
  );
} finally {
  await browser.close();
  await fixture.close();
}

// The emitted documents are derived from what was just written, in the same command, so the two
// committed files can never be one recapture out of step with each other.
await import("./emit-corebank-web.js");
