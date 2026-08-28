// The driver itself, against the live fixture, entirely in this process.
//
// Everything here goes through the four port methods and nothing else, which is the point: if a
// test needed a terminal-shaped escape hatch to do its job, the port would not fit this surface.
// None of them does.

import type { LeaseToken, NodeId } from "@crr/core";
import { describe, expect, it } from "vitest";
import { MemoryGridSink } from "../src/capture-sink.js";
import { detect } from "../src/detect.js";
import { TERMINAL_DRIVER, TerminalSurface, blankGridRegions } from "../src/surface.js";
import { createMemoryTransport } from "../src/transport.js";
import { TEST_LEASE, openTeller } from "./support/teller.js";

const id = (raw: string) => raw as NodeId;
const WRONG_LEASE = "lease-someone-else" as LeaseToken;

describe("capabilities are advertised before anything is spawned", () => {
  it("names the driver, the surface kind and the unit its geometry is in", () => {
    const surface = new TerminalSurface({ transport: createMemoryTransport() });
    const caps = surface.capabilities();
    expect(caps.kind).toBe("terminal");
    expect(caps.driver).toBe(TERMINAL_DRIVER);
    expect(caps.boundsUnit).toBe("cell");
    expect(caps.canCapture).toEqual(["text-grid"]);
  });

  it("advertises exactly the four actions it can perform", () => {
    const surface = new TerminalSurface({ transport: createMemoryTransport() });
    expect([...surface.capabilities().supportedActions].sort()).toEqual([
      "click",
      "focus",
      "pressKey",
      "type",
    ]);
  });

  it("advertises every function key, because on a green screen they are the submit mechanism", () => {
    const keys = new Set(
      new TerminalSurface({ transport: createMemoryTransport() }).capabilities().supportedKeys,
    );
    for (let n = 1; n <= 12; n++) expect(keys).toContain(`F${n}`);
  });
});

describe("perceive", () => {
  it("returns the inquiry screen with the nodes the detector found", async () => {
    const t = await openTeller({});
    try {
      const result = await t.surface.perceive({ deadlineMs: 1_000 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const roles = result.observation.nodes.map((n) => n.ariaRole);
      expect(roles.filter((r) => r === "textbox")).toHaveLength(2);
      expect(roles.filter((r) => r === "button")).toHaveLength(3);
      expect(result.observation.surface.driver).toBe(TERMINAL_DRIVER);
      expect(result.observation.seq).toBe(0);
    } finally {
      await t.close();
    }
  });

  it("advances seq on every observation, and it is not a timestamp", async () => {
    const t = await openTeller({});
    try {
      const first = await t.observe();
      const second = await t.observe();
      expect(second.seq).toBe(first.seq + 1);
    } finally {
      await t.close();
    }
  });

  it("refuses a deadline that is not a positive integer", async () => {
    const t = await openTeller({});
    try {
      await expect(t.surface.perceive({ deadlineMs: 0 })).rejects.toThrow(/positive integer/);
    } finally {
      await t.close();
    }
  });

  it("reports pty-active while bytes are still arriving", async () => {
    // A quiet window far longer than the harness waits, so the driver has not yet decided the
    // screen has stopped moving. That is what an executor's settle loop sees on its first turn.
    const t = await openTeller({ quietMs: 5_000, settleWaitMs: 10 });
    try {
      const result = await t.surface.perceive({ deadlineMs: 1_000 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.observation.stability.settled).toBe(false);
      expect(result.observation.stability.pendingReason).toBe("pty-active");
    } finally {
      await t.close();
    }
  });
});

describe("act enforces the control lease AT THE PORT", () => {
  it("refuses an action from a holder of a different lease", async () => {
    const t = await openTeller({});
    try {
      const result = await t.surface.act(
        { kind: "focus", target: id("textbox:account-number") },
        WRONG_LEASE,
      );
      expect(result).toEqual({ ok: false, fault: { kind: "lease-not-held" } });
    } finally {
      await t.close();
    }
  });

  it("refuses everything once the lease is revoked", async () => {
    const t = await openTeller({});
    try {
      await t.observe();
      t.surface.revokeLease();
      const result = await t.surface.act(
        { kind: "pressKey", target: null, key: "Enter" },
        TEST_LEASE,
      );
      expect(result.ok).toBe(false);
    } finally {
      await t.close();
    }
  });
});

describe("act: typing", () => {
  it("types into the focused field and reads the value back", async () => {
    const t = await openTeller({});
    try {
      await t.observe();
      const result = await t.surface.act(
        {
          kind: "type",
          target: id("textbox:account-number"),
          text: "12345",
          mode: "replace",
          sensitive: false,
        },
        TEST_LEASE,
      );
      expect(result).toEqual({ ok: true, dispatched: true });
      await t.quiet();
      const after = await t.observe();
      expect(after.nodes.find((n) => n.id === "textbox:account-number")?.value).toBe("12345");
    } finally {
      await t.close();
    }
  });

  it("walks the cursor to an UNFOCUSED field with Tab before typing into it", async () => {
    // Limitation (a): there is no addressable focus on a character surface. Making the node
    // actionable is the driver's obligation, and this is what that costs.
    const t = await openTeller({});
    try {
      await t.observe();
      await t.surface.act(
        {
          kind: "type",
          target: id("textbox:name-search"),
          text: "SYNTHETIC",
          mode: "replace",
          sensitive: false,
        },
        TEST_LEASE,
      );
      await t.quiet();
      const after = await t.observe();
      expect(after.nodes.find((n) => n.id === "textbox:name-search")?.value).toBe("SYNTHETIC");
      // And nothing landed in the other field, which is the failure this walk exists to avoid.
      expect(after.nodes.find((n) => n.id === "textbox:account-number")?.value).toBe("");
    } finally {
      await t.close();
    }
  });

  it("replaces rather than appends", async () => {
    const t = await openTeller({});
    try {
      await t.observe();
      const type = (text: string) =>
        t.surface.act(
          {
            kind: "type",
            target: id("textbox:account-number"),
            text,
            mode: "replace",
            sensitive: false,
          },
          TEST_LEASE,
        );
      await type("99999");
      await t.quiet();
      await t.observe();
      await type("12345");
      await t.quiet();
      const after = await t.observe();
      expect(after.nodes.find((n) => n.id === "textbox:account-number")?.value).toBe("12345");
    } finally {
      await t.close();
    }
  });

  it("refuses text longer than the capacity the GRID declared", async () => {
    const t = await openTeller({});
    try {
      await t.observe();
      const result = await t.surface.act(
        {
          kind: "type",
          target: id("textbox:account-number"),
          text: "1234567890123",
          mode: "replace",
          sensitive: false,
        },
        TEST_LEASE,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.fault.kind).toBe("surface-error");
    } finally {
      await t.close();
    }
  });

  it("blanks a sensitive value in every later observation", async () => {
    const t = await openTeller({});
    try {
      await t.observe();
      await t.surface.act(
        {
          kind: "type",
          target: id("textbox:account-number"),
          text: "12345",
          mode: "replace",
          sensitive: true,
        },
        TEST_LEASE,
      );
      await t.quiet();
      const after = await t.observe();
      const field = after.nodes.find((n) => n.id === "textbox:account-number");
      expect(field?.masked).toBe(true);
      expect(field?.value).toBe("");
      // The GRID still shows it - the driver reports what it did, it does not rewrite the screen.
      const raw = await t.grid();
      expect(detect(raw).nodes.find((n) => n.id === "textbox:account-number")?.value).toBe("12345");
    } finally {
      await t.close();
    }
  });
});

describe("act: activating a control lowers to this tenant's key", () => {
  it("submits the inquiry by activating the control named Search", async () => {
    const t = await openTeller({});
    try {
      await t.observe();
      await t.surface.act(
        {
          kind: "type",
          target: id("textbox:account-number"),
          text: "12345",
          mode: "replace",
          sensitive: false,
        },
        TEST_LEASE,
      );
      await t.quiet();
      await t.observe();
      const result = await t.surface.act(
        { kind: "click", target: id("button:search") },
        TEST_LEASE,
      );
      expect(result).toEqual({ ok: true, dispatched: true });
      await t.quiet();
      const detail = await t.observe();
      expect(detail.nodes[0]?.containerPath[0]).toEqual({ kind: "screen", id: "ACCOUNT LIST 02" });
    } finally {
      await t.close();
    }
  });

  it("sends F3 at riverbend and F12 at summit for the SAME node id and the SAME action", async () => {
    // The multi-tenant claim, demonstrated rather than asserted. `button:exit` is the same node at
    // both credit unions; the key behind it is read off the legend at replay time. An artifact that
    // said `pressKey(F3)` would be right at one and wrong at the other.
    for (const [tenant, bytes] of [
      ["riverbend", "\x1bOR"],
      ["summit", "\x1b[24~"],
    ] as const) {
      const t = await openTeller({ tenant });
      try {
        await t.observe();
        const before = t.transport.written.length;
        const result = await t.surface.act(
          { kind: "click", target: id("button:exit") },
          TEST_LEASE,
        );
        expect(result).toEqual({ ok: true, dispatched: true });
        expect(t.transport.written.slice(before).join("")).toBe(bytes);
      } finally {
        await t.close();
      }
    }
  });

  it("walks the list selection onto a row that was not selected", async () => {
    const t = await openTeller({});
    try {
      await t.send("12345\r");
      const detail = await t.observe();
      const target = detail.nodes.find((n) => n.ariaRole === "row" && n.id === "row:d0001");
      expect(target).toBeDefined();
      const result = await t.surface.act({ kind: "click", target: id("row:d0001") }, TEST_LEASE);
      expect(result).toEqual({ ok: true, dispatched: true });
      await t.quiet();
      const after = await t.observe();
      expect(after.nodes.find((n) => n.id === "row:d0001")?.state.selected).toBe(true);
    } finally {
      await t.close();
    }
  });
});

describe("act: the mechanical refusals", () => {
  it("reports node-gone for an id that was not in the last observation", async () => {
    const t = await openTeller({});
    try {
      await t.observe();
      const result = await t.surface.act(
        { kind: "focus", target: id("textbox:nonesuch") },
        TEST_LEASE,
      );
      expect(result).toEqual({
        ok: false,
        fault: { kind: "node-gone", nodeId: "textbox:nonesuch" },
      });
    } finally {
      await t.close();
    }
  });

  it("refuses to focus something that cannot hold a cursor", async () => {
    const t = await openTeller({});
    try {
      await t.observe();
      const result = await t.surface.act(
        { kind: "focus", target: id("heading:teller-04") },
        TEST_LEASE,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.fault.kind).toBe("not-actionable");
    } finally {
      await t.close();
    }
  });

  it("refuses an action it never advertised, rather than approximating one", async () => {
    const t = await openTeller({});
    try {
      await t.observe();
      const result = await t.surface.act(
        { kind: "select", target: id("textbox:account-number"), option: "anything" },
        TEST_LEASE,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.fault.kind).toBe("surface-error");
        if (result.fault.kind === "surface-error") {
          expect(result.fault.message).toContain("supportedActions");
        }
      }
    } finally {
      await t.close();
    }
  });
});

describe("capture is evidence only, and masking happens before the bytes exist", () => {
  it("dumps the grid as text and content-addresses it", async () => {
    const sink = new MemoryGridSink();
    const t = await openTeller({});
    try {
      // Rebuild the surface on the same transport so the capture lands in a sink we can read.
      const surface = new TerminalSurface({
        transport: t.transport,
        captureSink: sink,
        lease: TEST_LEASE,
      });
      t.transport.emit("");
      await t.quiet();
      const capture = await surface.capture({ maskRegions: [], format: "text-grid" });
      expect(capture.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(capture.maskedRegions).toBe(0);
      expect(sink.get(capture.ref)).toBeDefined();
      await surface.close();
    } finally {
      await t.close();
    }
  });

  it("blanks the cells a mask region covers, and only those", () => {
    const t = {
      cols: 4,
      rows: 2,
      cursor: { x: 0, y: 0 },
      cells: [
        [cell("A"), cell("B"), cell("C"), cell("D")],
        [cell("E"), cell("F"), cell("G"), cell("H")],
      ],
    };
    const { masked, count } = blankGridRegions(t, [{ x: 1, y: 0, w: 2, h: 1 }]);
    expect(count).toBe(1);
    expect(masked.cells[0]?.map((c) => c.ch).join("")).toBe("A  D");
    expect(masked.cells[1]?.map((c) => c.ch).join("")).toBe("EFGH");
  });

  it("refuses a format it does not advertise", async () => {
    const t = await openTeller({});
    try {
      await expect(t.surface.capture({ maskRegions: [], format: "image" })).rejects.toThrow(
        /cannot capture/,
      );
    } finally {
      await t.close();
    }
  });
});

const cell = (ch: string) => ({
  ch,
  inverse: false,
  bold: false,
  underline: false,
  fg: -1,
  bg: -1,
});
