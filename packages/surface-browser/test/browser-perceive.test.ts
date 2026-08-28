// Perception against the real hostile surface.
//
// These boot `fixtures/corebank-web` on an EPHEMERAL PORT and drive a locally launched Chromium.
// Nothing here reaches the public internet and nothing here needs a credential. The hermetic half of
// this suite (`normalize`, `geometry`, `routes`, `png`, `roles`) covers the logic; what is proved
// here is that the logic is pointed at the right facts.

import {
  type EvalContext,
  type NodeId,
  type RoutePattern,
  SurfaceCapabilitiesSchema,
  type UINode,
  parseObservation,
  resolveCell,
  surfaceFeaturesOf,
} from "@crr/core";
import { describe, expect, it } from "vitest";
import { type BrowserSurface, attachBrowserSurface } from "../src/surface.js";
import {
  type BrowserFixture,
  chromiumAvailable,
  gotoContent,
  openCorebank,
} from "./support/corebank.js";
import { evalContextFor } from "./support/engine.js";

const ROUTES = [
  { id: "search", originAlias: "corebank", path: "/search", frame: "content" },
  { id: "results", originAlias: "corebank", path: "/search/results", frame: "content" },
  { id: "detail", originAlias: "corebank", path: "/member/:memberId", frame: "content" },
] as unknown as readonly RoutePattern[];

async function open(env: BrowserFixture, basePath = ""): Promise<BrowserSurface> {
  await env.page.goto(`${env.fixture.origin}${basePath}/`, { waitUntil: "load" });
  return attachBrowserSurface({
    page: env.page,
    origins: { corebank: `${env.fixture.origin}${basePath}` },
    routes: ROUTES,
    primaryFrame: "content",
  });
}

const observe = async (surface: BrowserSurface) => {
  const result = await surface.perceive({ deadlineMs: 10_000 });
  if (!result.ok) throw new Error(`perceive failed: ${JSON.stringify(result.fault)}`);
  return result.observation;
};

const roleHistogram = (nodes: readonly UINode[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const node of nodes) {
    if (node.ariaRole === null) continue;
    out[node.ariaRole] = (out[node.ariaRole] ?? 0) + 1;
  }
  return out;
};

describe.skipIf(!chromiumAvailable())("perceiving the frameset", () => {
  it("advertises capabilities the linker can check a program against", async () => {
    const env = await openCorebank();
    try {
      const surface = await open(env);
      const capabilities = surface.capabilities();
      expect(() => SurfaceCapabilitiesSchema.parse(capabilities)).not.toThrow();
      expect([...surfaceFeaturesOf(capabilities)].sort()).toEqual([
        "accessibility-tree",
        "containers",
        "geometry",
        "native-dialog-channel",
        "route",
        "table-position",
      ]);
      // A browser is not a character grid, and saying so is what makes a program recorded on the
      // green screen fail to LINK here rather than fail mysteriously at step six.
      expect(surfaceFeaturesOf(capabilities)).not.toContain("character-grid");
      expect(capabilities.containerKinds).not.toContain("heading-section");
      await surface.close();
    } finally {
      await env.close();
    }
  });

  it("returns one stitched screen with the node count and roles the fixture has", async () => {
    const env = await openCorebank();
    try {
      const surface = await open(env);
      const observation = await observe(surface);

      // The obligation every driver has: what it emits must validate. A driver whose observation
      // cannot be read back off disk breaks SPEC section 4.8's whole claim about frozen corpora.
      expect(() => parseObservation(observation)).not.toThrow();

      // Pinned deliberately against Chromium 151.0.7922.34. A single `getFullAXTree` call returns
      // SEVEN nodes on this page; the number below is what stitching four documents produces, minus
      // the `InlineTextBox` nodes that carry no backend id. If a browser upgrade moves it, that is
      // a signal worth reading, not a flake to loosen.
      expect(observation.nodes).toHaveLength(99);
      expect(roleHistogram(observation.nodes)).toEqual({
        link: 4,
        form: 1,
        textbox: 2,
        button: 1,
      });
      expect(observation.roots).toHaveLength(1);
      expect(observation.stability.settled).toBe(true);
      expect(observation.nativeDialog).toBeNull();
      expect(observation.inputIntercepted).toBe(false);
      expect(observation.skeletonDigest.length).toBeGreaterThan(0);
      await surface.close();
    } finally {
      await env.close();
    }
  });

  it("puts every document's nodes under its frame NAME, never an ordinal", async () => {
    const env = await openCorebank();
    try {
      const surface = await open(env);
      const observation = await observe(surface);
      const inFrame = (name: string): readonly UINode[] =>
        observation.nodes.filter((node) =>
          node.containerPath.some((segment) => segment.kind === "frame" && segment.name === name),
        );
      for (const frame of ["banner", "nav", "content"]) {
        expect(inFrame(frame).length).toBeGreaterThan(0);
      }
      // Every node sits under the top document; the child frame names are what distinguish them.
      expect(inFrame("top").length).toBe(observation.nodes.length - 1);
      expect(
        observation.nodes.find((node) => node.name === "Member Search")?.containerPath,
      ).toEqual([
        { kind: "frame", name: "top" },
        { kind: "frame", name: "nav" },
      ]);
      await surface.close();
    } finally {
      await env.close();
    }
  });

  it("stitches a frame nested inside a frame", async () => {
    const env = await openCorebank();
    try {
      const surface = await open(env);
      await gotoContent(env.page, `${env.fixture.origin}/member/10041`);
      const observation = await observe(surface);
      const nested = observation.nodes.filter((node) =>
        node.containerPath.some(
          (segment) => segment.kind === "frame" && segment.name === "subacct",
        ),
      );
      expect(nested.length).toBeGreaterThan(10);
      expect(nested[0]?.containerPath.slice(0, 3)).toEqual([
        { kind: "frame", name: "top" },
        { kind: "frame", name: "content" },
        { kind: "frame", name: "subacct" },
      ]);
      // One screen, one root: the whole thing only exists after the stitch.
      expect(observation.roots).toHaveLength(1);
      await surface.close();
    } finally {
      await env.close();
    }
  });

  it("canonicalizes the location of the frame the flow actually moves in", async () => {
    const env = await openCorebank();
    try {
      const surface = await open(env);
      expect((await observe(surface)).route).toEqual({
        originAlias: "corebank",
        path: "/search",
        query: {},
        frame: "content",
      });
      await gotoContent(env.page, `${env.fixture.origin}/member/10041`);
      const route = (await observe(surface)).route;
      // The member number is gone: an observation is a document that gets written to evidence.
      expect(route?.path).toBe("/member/:memberId");
      expect(JSON.stringify(route)).not.toContain("10041");
      await surface.close();
    } finally {
      await env.close();
    }
  });

  it("measures the label a legacy form has instead of a `for` attribute", async () => {
    const env = await openCorebank();
    try {
      const surface = await open(env);
      const observation = await observe(surface);
      const label = observation.nodes.find(
        (node) => node.rawRole === "StaticText" && node.name === "Member ID",
      );
      const field = observation.nodes.filter((node) => node.ariaRole === "textbox")[0];
      expect(label?.bounds).not.toBeNull();
      expect(field?.bounds).not.toBeNull();
      // Exactly what a `label-anchored` / `right-of` descriptor consumes: this form has no
      // `<label for>` anywhere, so proximity is the only association there is.
      const a = label?.bounds;
      const b = field?.bounds;
      if (a == null || b == null) throw new Error("no geometry");
      expect(b.x).toBeGreaterThan(a.x + a.w);
      expect(b.y).toBeLessThan(a.y + a.h);
      expect(a.y).toBeLessThan(b.y + b.h);
      // The field itself is nameless. Rank 1 cannot see it; rank 2 is why the flow works at all.
      expect(field?.name).toBe("");
      await surface.close();
    } finally {
      await env.close();
    }
  });
});

describe.skipIf(!chromiumAvailable())("the layout-table case", () => {
  it("resolves the member's row to EXACTLY ONE row", async () => {
    const env = await openCorebank();
    try {
      const surface = await open(env);
      // Two rows carrying the same displayed NAME. "The Parker row" is ambiguous; "the row whose
      // Member ID cell is 10045" is not - and on a page of nested layout tables the naive form of
      // that query matched the data row AND the layout row wrapping the whole page.
      await gotoContent(env.page, `${env.fixture.origin}/search/results?lastName=PARKER`);
      const observation = await observe(surface);
      const byId = new Map(observation.nodes.map((node) => [node.id, node]));

      const keyCells = observation.nodes.filter(
        (node) => node.ariaRole === "cell" && node.name === "10045",
      );
      expect(keyCells).toHaveLength(1);

      const ancestorRows: NodeId[] = [];
      let cursor = keyCells[0]?.parent ?? null;
      while (cursor !== null) {
        const node = byId.get(cursor);
        if (node === undefined) break;
        if (node.ariaRole === "row") ancestorRows.push(node.id);
        cursor = node.parent;
      }
      expect(ancestorRows).toHaveLength(1);

      // Three rows on the page: the header row and two members. Every other "row" on this document
      // is a LayoutTableRow and is therefore structure.
      expect(observation.nodes.filter((node) => node.ariaRole === "row")).toHaveLength(3);
      expect(
        observation.nodes.filter((node) => node.rawRole === "LayoutTableRow").length,
      ).toBeGreaterThan(0);
      await surface.close();
    } finally {
      await env.close();
    }
  });

  it("hands `@crr/core`'s own cell resolver enough to read the right cell", async () => {
    const env = await openCorebank();
    try {
      const surface = await open(env);
      await gotoContent(env.page, `${env.fixture.origin}/search/results?lastName=PARKER`);
      const ctx: EvalContext = evalContextFor(await observe(surface), { memberId: "10045" });
      const cell = resolveCell(
        {
          table: {
            path: [
              { kind: "frame", name: { mode: "exact", value: "content", normalize: "std.text@1" } },
              {
                kind: "table",
                headers: [{ mode: "exact", value: "Member ID", normalize: "std.label@1" }],
              },
            ],
          },
          rowKey: {
            columnHeader: { mode: "exact", value: "Member ID", normalize: "std.label@1" },
            value: { from: "param", param: "memberId" },
          },
          columnHeader: { mode: "exact", value: "Share Balance", normalize: "std.label@1" },
        },
        ctx,
      );
      // 10044 and 10045 display the same name and different balances. Reading by row INDEX would
      // have got this right by luck; reading by row KEY gets it right on purpose.
      expect(cell?.text).toBe("7,415.28");
      await surface.close();
    } finally {
      await env.close();
    }
  });

  it("reads the same column at the tenant whose grid has an extra leading column", async () => {
    const env = await openCorebank();
    try {
      // Summit prepends a `Sel` radio column, so every column INDEX shifts by one and the balance
      // column is called something else. One unchanged query, two tenants: this is the whole
      // multi-tenant claim, tested at the surface rather than asserted in a document.
      const surface = await open(env, "/cb");
      await gotoContent(env.page, `${env.fixture.origin}/cb/search/results?lastName=PARKER`);
      const observation = await observe(surface);
      const ctx = evalContextFor(observation, { memberId: "10045" });
      const cell = resolveCell(
        {
          table: {
            path: [
              { kind: "frame", name: { mode: "exact", value: "content", normalize: "std.text@1" } },
              {
                kind: "table",
                headers: [{ mode: "exact", value: "Member Number", normalize: "std.label@1" }],
              },
            ],
          },
          rowKey: {
            columnHeader: { mode: "exact", value: "Member Number", normalize: "std.label@1" },
            value: { from: "param", param: "memberId" },
          },
          columnHeader: { mode: "exact", value: "Savings Balance", normalize: "std.label@1" },
        },
        ctx,
      );
      expect(cell?.text).toBe("7,415.28");
      expect(cell?.tablePosition?.colIndex).toBe(3);
      expect(cell?.tablePosition?.headerProvenance).toBe("first-row-heuristic");
      await surface.close();
    } finally {
      await env.close();
    }
  });
});
