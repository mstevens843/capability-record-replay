// Acting on the real surface: the lease, actionability, interception, and the native dialog channel.

import type { Action, LeaseToken, NodeId, Observation, RoutePattern, UINode } from "@crr/core";
import { describe, expect, it } from "vitest";
import { type BrowserSurface, attachBrowserSurface } from "../src/surface.js";
import {
  type BrowserFixture,
  chromiumAvailable,
  gotoContent,
  openCorebank,
} from "./support/corebank.js";

const LEASE = "lease-automation-1" as LeaseToken;

const ROUTES = [
  { id: "search", originAlias: "corebank", path: "/search", frame: "content" },
  { id: "results", originAlias: "corebank", path: "/search/results", frame: "content" },
  { id: "detail", originAlias: "corebank", path: "/member/:memberId", frame: "content" },
] as unknown as readonly RoutePattern[];

async function open(env: BrowserFixture, entry = "/"): Promise<BrowserSurface> {
  await env.page.goto(`${env.fixture.origin}${entry}`, { waitUntil: "load" });
  return attachBrowserSurface({
    page: env.page,
    origins: { corebank: env.fixture.origin },
    routes: ROUTES,
    primaryFrame: "content",
    lease: LEASE,
    actTimeoutMs: 8000,
  });
}

const observe = async (surface: BrowserSurface): Promise<Observation> => {
  const result = await surface.perceive({ deadlineMs: 10_000 });
  if (!result.ok) throw new Error(`perceive failed: ${JSON.stringify(result.fault)}`);
  return result.observation;
};

const one = (observation: Observation, predicate: (node: UINode) => boolean): UINode => {
  const hits = observation.nodes.filter(predicate);
  if (hits.length !== 1) throw new Error(`expected exactly one node, found ${hits.length}`);
  return hits[0] as UINode;
};

describe.skipIf(!chromiumAvailable())("the control lease, enforced at the port", () => {
  it("refuses an action from a holder that is not the current one", async () => {
    const env = await openCorebank();
    try {
      const surface = await open(env);
      const observation = await observe(surface);
      const button = one(observation, (node) => node.ariaRole === "button");
      expect(
        await surface.act({ kind: "click", target: button.id }, "stale" as LeaseToken),
      ).toEqual({ ok: false, fault: { kind: "lease-not-held" } });
      // Checked BEFORE the target is even looked at: a driver that validates the node first has
      // already told a controller it does not recognise whether that node exists.
      const ghost = "button:f9-999" as NodeId;
      expect(await surface.act({ kind: "click", target: ghost }, "stale" as LeaseToken)).toEqual({
        ok: false,
        fault: { kind: "lease-not-held" },
      });
      surface.revokeLease();
      expect(await surface.act({ kind: "click", target: button.id }, LEASE)).toEqual({
        ok: false,
        fault: { kind: "lease-not-held" },
      });
      await surface.close();
    } finally {
      await env.close();
    }
  });
});

describe.skipIf(!chromiumAvailable())("dispatching", () => {
  it("types real key events into a field that has no accessible name, and submits", async () => {
    const env = await openCorebank();
    try {
      const surface = await open(env);
      let observation = await observe(surface);
      const field = observation.nodes.filter((node) => node.ariaRole === "textbox")[0] as UINode;
      expect(
        await surface.act(
          { kind: "type", target: field.id, text: "10041", mode: "replace", sensitive: false },
          LEASE,
        ),
      ).toEqual({ ok: true, dispatched: true });

      observation = await observe(surface);
      expect(observation.nodes.find((node) => node.id === field.id)?.value).toBe("10041");

      const search = one(observation, (node) => node.ariaRole === "button");
      expect(await surface.act({ kind: "click", target: search.id }, LEASE)).toEqual({
        ok: true,
        dispatched: true,
      });
      await env.page.waitForTimeout(200);
      observation = await observe(surface);
      expect(observation.route?.path).toBe("/search/results");
      expect(
        observation.nodes.filter((node) => node.ariaRole === "cell" && node.name === "10041"),
      ).toHaveLength(1);
      await surface.close();
    } finally {
      await env.close();
    }
  });

  it("replaces the whole field rather than appending to it", async () => {
    const env = await openCorebank();
    try {
      const surface = await open(env);
      const field = (await observe(surface)).nodes.filter(
        (node) => node.ariaRole === "textbox",
      )[0] as UINode;
      const fill = (text: string): Action => ({
        kind: "type",
        target: field.id,
        text,
        mode: "replace",
        sensitive: false,
      });
      await surface.act(fill("99999"), LEASE);
      await surface.act(fill("10041"), LEASE);
      expect((await observe(surface)).nodes.find((n) => n.id === field.id)?.value).toBe("10041");
      await surface.act(fill(""), LEASE);
      expect((await observe(surface)).nodes.find((n) => n.id === field.id)?.value ?? "").toBe("");
      await surface.close();
    } finally {
      await env.close();
    }
  });

  it("selects an option by its label and fires exactly one change", async () => {
    const env = await openCorebank();
    try {
      const surface = await open(env);
      await gotoContent(env.page, `${env.fixture.origin}/member/10041/subaccount/new`);
      const observation = await observe(surface);
      const combo = one(observation, (node) => node.ariaRole === "combobox");
      expect(
        await surface.act(
          { kind: "select", target: combo.id, option: "Share Account - Regular" },
          LEASE,
        ),
      ).toEqual({ ok: true, dispatched: true });
      expect((await observe(surface)).nodes.find((n) => n.id === combo.id)?.value).toBe(
        "Share Account - Regular",
      );
      await surface.close();
    } finally {
      await env.close();
    }
  });

  it("reports a select option the page does not offer instead of picking a neighbour", async () => {
    const env = await openCorebank();
    try {
      const surface = await open(env);
      await gotoContent(env.page, `${env.fixture.origin}/member/10041/subaccount/new`);
      const combo = one(await observe(surface), (node) => node.ariaRole === "combobox");
      const result = await surface.act(
        { kind: "select", target: combo.id, option: "Christmas Club" },
        LEASE,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.fault.kind).toBe("surface-error");
      await surface.close();
    } finally {
      await env.close();
    }
  });

  it("makes `setChecked` idempotent, because a checkbox is a toggle", async () => {
    const env = await openCorebank();
    try {
      // Summit's results grid carries a leading radio column; riverbend's does not.
      await env.page.goto(`${env.fixture.origin}/cb/`, { waitUntil: "load" });
      const surface = await attachBrowserSurface({
        page: env.page,
        origins: { corebank: `${env.fixture.origin}/cb` },
        primaryFrame: "content",
        lease: LEASE,
      });
      await gotoContent(env.page, `${env.fixture.origin}/cb/search/results?lastName=PARKER`);
      let observation = await observe(surface);
      const radio = observation.nodes.filter((node) => node.ariaRole === "radio")[0] as UINode;
      expect(radio.state.checked).toBe(false);
      expect(
        await surface.act({ kind: "setChecked", target: radio.id, checked: true }, LEASE),
      ).toEqual({ ok: true, dispatched: true });
      observation = await observe(surface);
      expect(observation.nodes.find((n) => n.id === radio.id)?.state.checked).toBe(true);

      const before = observation.stability.generation;
      expect(
        await surface.act({ kind: "setChecked", target: radio.id, checked: true }, LEASE),
      ).toEqual({ ok: true, dispatched: true });
      const after = await observe(surface);
      // Nothing was dispatched, so nothing moved: the second call did not toggle it back off.
      expect(after.stability.generation).toBe(before);
      expect(after.nodes.find((n) => n.id === radio.id)?.state.checked).toBe(true);
      await surface.close();
    } finally {
      await env.close();
    }
  });

  it("presses a key at the focused node", async () => {
    const env = await openCorebank();
    try {
      const surface = await open(env);
      const field = (await observe(surface)).nodes.filter(
        (node) => node.ariaRole === "textbox",
      )[0] as UINode;
      await surface.act(
        { kind: "type", target: field.id, text: "10041", mode: "replace", sensitive: false },
        LEASE,
      );
      expect(
        await surface.act({ kind: "pressKey", target: field.id, key: "Enter" }, LEASE),
      ).toEqual({ ok: true, dispatched: true });
      await env.page.waitForTimeout(250);
      expect((await observe(surface)).route?.path).toBe("/search/results");
      await surface.close();
    } finally {
      await env.close();
    }
  });

  it("focuses a node without clicking it", async () => {
    const env = await openCorebank();
    try {
      const surface = await open(env);
      const field = (await observe(surface)).nodes.filter(
        (node) => node.ariaRole === "textbox",
      )[1] as UINode;
      expect(await surface.act({ kind: "focus", target: field.id }, LEASE)).toEqual({
        ok: true,
        dispatched: true,
      });
      expect((await observe(surface)).nodes.find((n) => n.id === field.id)?.state.focused).toBe(
        true,
      );
      await surface.close();
    } finally {
      await env.close();
    }
  });

  it("navigates a named frame, and refuses a route it cannot resolve", async () => {
    const env = await openCorebank();
    try {
      const surface = await open(env);
      expect(
        await surface.act(
          {
            kind: "navigate",
            route: { originAlias: "corebank", path: "/member/10041", query: {}, frame: "content" },
          },
          LEASE,
        ),
      ).toEqual({ ok: true, dispatched: true });
      expect((await observe(surface)).route?.path).toBe("/member/:memberId");

      const unknown = await surface.act(
        { kind: "navigate", route: { originAlias: "elsewhere", path: "/x", query: {} } },
        LEASE,
      );
      expect(unknown).toEqual({
        ok: false,
        fault: {
          kind: "navigation-blocked",
          route: "elsewhere (origin alias is not configured for this tenant)",
        },
      });

      const unsubstituted = await surface.act(
        {
          kind: "navigate",
          route: { originAlias: "corebank", path: "/member/:memberId", query: {} },
        },
        LEASE,
      );
      expect(unsubstituted.ok).toBe(false);
      if (unsubstituted.ok) throw new Error("unreachable");
      expect(unsubstituted.fault).toEqual({
        kind: "navigation-blocked",
        route: "/member/:memberId (still a pattern; its arguments were never substituted)",
      });
      // A fault is journalled and a journal is evidence: the concrete path never appears in one.
      expect(JSON.stringify(unknown)).not.toContain("10041");
      await surface.close();
    } finally {
      await env.close();
    }
  });
});

describe.skipIf(!chromiumAvailable())("what the machinery refuses", () => {
  it("reports a node that is not in the current observation as gone", async () => {
    const env = await openCorebank();
    try {
      const surface = await open(env);
      await observe(surface);
      const ghost = "button:f7-4242" as NodeId;
      expect(await surface.act({ kind: "click", target: ghost }, LEASE)).toEqual({
        ok: false,
        fault: { kind: "node-gone", nodeId: ghost },
      });
      await surface.close();
    } finally {
      await env.close();
    }
  });

  it("refuses a disabled control mechanically, whatever the program asked for", async () => {
    const env = await openCorebank();
    try {
      const surface = await open(env);
      const content = env.page.frames().find((frame) => frame.name() === "content");
      // Test setup, not driver behaviour: the fixture has no disabled control, and a driver that
      // never meets one has never been shown to refuse one.
      //
      // The body is a STRING rather than a closure because this package compiles with no DOM lib on
      // purpose - `src/` must not be able to reach a browser global by accident, and a test that
      // pulled the DOM types in to write one line would be exactly that loophole. Playwright
      // evaluates a string as an EXPRESSION and does not call it, so this is an IIFE - and it
      // returns the count so a silent no-op cannot masquerade as a passing assertion below.
      const disabled = await content?.evaluate(
        `(() => { let n = 0; for (const input of document.getElementsByTagName("input")) { if (input.type === "submit") { input.disabled = true; n++; } } return n; })()`,
      );
      expect(disabled).toBe(1);
      const button = one(await observe(surface), (node) => node.ariaRole === "button");
      expect(await surface.act({ kind: "click", target: button.id }, LEASE)).toEqual({
        ok: false,
        fault: { kind: "not-actionable", nodeId: button.id, why: "disabled" },
      });
      await surface.close();
    } finally {
      await env.close();
    }
  });

  it("refuses a click that a blocking overlay would have swallowed", async () => {
    const env = await openCorebank();
    try {
      const surface = await open(env);
      await gotoContent(env.page, `${env.fixture.origin}/member/10041/subaccount/new`);
      let observation = await observe(surface);
      const combo = one(observation, (node) => node.ariaRole === "combobox");
      await surface.act(
        { kind: "select", target: combo.id, option: "Share Account - Regular" },
        LEASE,
      );
      const deposit = one(observation, (node) => node.ariaRole === "textbox");
      await surface.act(
        { kind: "type", target: deposit.id, text: "25.00", mode: "replace", sensitive: false },
        LEASE,
      );
      await surface.act(
        { kind: "click", target: one(observation, (n) => n.ariaRole === "button").id },
        LEASE,
      );
      await env.page.waitForTimeout(400);

      observation = await observe(surface);
      // The in-page modal IS perceivable - unlike a native dialog - and it comes with a full-page
      // click interceptor over the form behind it.
      expect(observation.inputIntercepted).toBe(true);
      expect(
        observation.nodes.filter((node) => node.ariaRole === "dialog").map((node) => node.name),
      ).toEqual(["Confirm Sub-Account"]);

      const behind = one(observation, (node) => node.ariaRole === "combobox");
      // SPEC section 4.5's W5: without this the click "succeeds" against the dim layer and the
      // checkpoint fails somewhere else entirely, with the cause three steps upstream.
      expect(await surface.act({ kind: "click", target: behind.id }, LEASE)).toEqual({
        ok: false,
        fault: { kind: "intercepted", nodeId: behind.id },
      });

      // The control that IS on top is reachable.
      const confirm = one(
        observation,
        (node) => node.ariaRole === "button" && node.name === "Confirm",
      );
      expect(await surface.act({ kind: "click", target: confirm.id }, LEASE)).toEqual({
        ok: true,
        dispatched: true,
      });
      await surface.close();
    } finally {
      await env.close();
    }
  });
});

describe.skipIf(!chromiumAvailable())("the native dialog channel", () => {
  it("holds the dialog open, times perception out, and answers it on request", async () => {
    const env = await openCorebank();
    try {
      const surface = await open(env, "/?dialog=native");
      await gotoContent(env.page, `${env.fixture.origin}/member/10041/subaccount/new`);
      const submit = one(await observe(surface), (node) => node.ariaRole === "button");

      // The click does not resolve while a confirm is open - the renderer is blocked inside the
      // handler - but the click HAS happened and the dialog is its consequence, so the driver
      // reports a dispatch immediately rather than hanging or claiming the click never landed.
      const started = Date.now();
      expect(await surface.act({ kind: "click", target: submit.id }, LEASE)).toEqual({
        ok: true,
        dispatched: true,
      });
      expect(Date.now() - started).toBeLessThan(4000);

      // Never auto-accepted and never auto-dismissed: with NO handler registered Playwright
      // dismisses it for you, the click succeeds, and the confirmation the flow depended on never
      // happens.
      expect(surface.pendingNativeDialog).toEqual({
        type: "confirm",
        message: "Open a Share Account for member 10041?",
        defaultValue: null,
      });

      // Driver rule D6. `getFullAXTree` never returns while the renderer is blocked: no CDP error,
      // no timeout of its own. A call with no deadline is a hang, and a hang has no failure class.
      const before = Date.now();
      const blocked = await surface.perceive({ deadlineMs: 900 });
      expect(blocked.ok).toBe(false);
      if (blocked.ok) throw new Error("unreachable");
      expect(blocked.fault.kind).toBe("perceive-timeout");
      expect(Date.now() - before).toBeGreaterThanOrEqual(880);
      expect(Date.now() - before).toBeLessThan(3000);

      // Nothing else can act through a blocked renderer either.
      expect(await surface.act({ kind: "click", target: submit.id }, LEASE)).toEqual({
        ok: false,
        fault: { kind: "intercepted", nodeId: submit.id },
      });

      expect(await surface.act({ kind: "acceptDialog", text: null }, LEASE)).toEqual({
        ok: true,
        dispatched: true,
      });
      expect(surface.pendingNativeDialog).toBeNull();
      await env.page.waitForTimeout(400);
      const after = await observe(surface);
      expect(after.nativeDialog).toBeNull();
      expect(after.nodes.length).toBeGreaterThan(50);
      await surface.close();
    } finally {
      await env.close();
    }
  });

  it("dismisses on request, and refuses a dialog action when none is open", async () => {
    const env = await openCorebank();
    try {
      const surface = await open(env, "/?dialog=native");
      await gotoContent(env.page, `${env.fixture.origin}/member/10041/subaccount/new`);
      const nothingOpen = await surface.act({ kind: "dismissDialog" }, LEASE);
      expect(nothingOpen).toEqual({
        ok: false,
        fault: { kind: "surface-error", message: "no native dialog is open" },
      });

      const submit = one(await observe(surface), (node) => node.ariaRole === "button");
      await surface.act({ kind: "click", target: submit.id }, LEASE);
      expect(surface.pendingNativeDialog?.type).toBe("confirm");
      expect(await surface.act({ kind: "dismissDialog" }, LEASE)).toEqual({
        ok: true,
        dispatched: true,
      });
      await env.page.waitForTimeout(300);
      // Dismissing the confirm cancels the write: the form is still on screen and nothing posted.
      // (The open-sub-account form is deliberately NOT among the declared routes here, so
      // `route` is `null` - canonicalization fails closed rather than leaking an undeclared path.)
      const after = await observe(surface);
      expect(after.route).toBeNull();
      expect(after.nodes.some((node) => node.ariaRole === "combobox")).toBe(true);
      expect(after.nodes.some((node) => node.name === "Posting Reference")).toBe(false);
      expect(after.nativeDialog).toBeNull();
      await surface.close();
    } finally {
      await env.close();
    }
  });
});
