// Acceptance tests for the green-screen fixture.
//
// Three properties, and they are the three the fixture exists to provide:
//
//   1. EVERY fault in the registry is reachable and produces the behaviour its taxonomy row needs.
//      The scenario table is driven off the exported `FAULTS` registry rather than a hand-written
//      list, so adding a fault without an assertion FAILS this file instead of silently shipping an
//      untested fault.
//   2. The three conditions that are NOT faults - not found, permission denied, validation error -
//      are reachable from the account number alone, because they are facts about the request.
//   3. The two tenants serve materially different screens for the same capability.
//
// Plus the invariants that make the fixture worth driving at all: it paints with absolute cursor
// addressing only, it enforces its own field widths, it tokenizes escape sequences split across
// chunk boundaries, and `app.js` never touches `process`.
//
// Everything runs in this process against a manual scheduler, so the timing faults are exact rather
// than flaky. No child process, no socket, no clock.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createTellerApp, tokenizeKeys } from "../src/app.js";
import { MEMBERS, STATUS } from "../src/data.js";
import { FAULTS, armFault, canonicalFaultId } from "../src/faults.js";
import { TENANTS, TENANT_IDS } from "../src/tenants.js";

/**
 * An app with time under the test's control: nothing fires until `flush()` is called, so a delayed
 * or torn repaint is a deterministic sequence of chunks rather than a race with a timer.
 * @param {import("../src/app.js").TellerAppOptions} [options]
 */
function open(options = {}) {
  /** @type {{ fn: () => void }[]} */
  const timers = [];
  /** @type {string[]} */
  const chunks = [];
  const app = createTellerApp({
    ...options,
    schedule: (fn) => {
      const handle = { fn };
      timers.push(handle);
      return handle;
    },
    cancel: (handle) => {
      const i = timers.indexOf(/** @type {{ fn: () => void }} */ (handle));
      if (i >= 0) timers.splice(i, 1);
    },
  });
  app.onOutput((chunk) => chunks.push(chunk));
  app.start();
  return {
    app,
    chunks,
    /** Everything the app has emitted so far, concatenated. */
    painted: () => chunks.join(""),
    /** Run every pending timer. */
    flush: () => {
      for (const timer of timers.splice(0)) timer.fn();
    },
    pending: () => timers.length,
    /** @param {string} keys */
    send: (keys) => app.write(keys),
  };
}

const frameOf = (options = {}) => {
  const t = open(options);
  t.flush();
  const out = t.painted();
  t.app.close();
  return out;
};

describe("the flow: two screens, reached by keystrokes", () => {
  it("starts on the member inquiry screen", () => {
    const t = open();
    expect(t.app.screen).toBe("inquiry");
    expect(t.app.screenId).toBe("MEMBER INQUIRY 01");
    t.app.close();
  });

  it("reaches the account list for a member on file", () => {
    const t = open();
    t.send("12345\r");
    expect(t.app.screen).toBe("detail");
    expect(t.app.screenId).toBe("ACCOUNT LIST 02");
    t.app.close();
  });

  it("goes back to the inquiry screen on the tenant's exit key", () => {
    const t = open();
    t.send("12345\r");
    t.send("\x1bOR"); // F3
    expect(t.app.screen).toBe("inquiry");
    t.app.close();
  });

  it("uses F12 at the tenant that binds Exit to F12, and ignores F3 there", () => {
    const t = open({ tenant: "summit" });
    t.send("12345\r");
    t.send("\x1bOR"); // F3 - not this tenant's key
    expect(t.app.screen).toBe("detail");
    t.send("\x1b[24~"); // F12
    expect(t.app.screen).toBe("inquiry");
    t.app.close();
  });

  it("moves the list selection with the arrow keys and opens the selected suffix", () => {
    const t = open();
    t.send("12345\r");
    t.send("\x1b[B\x1b[B\r");
    expect(t.app.statusText).toBe(STATUS.opened("D0001"));
    t.app.close();
  });
});

describe("the three conditions that are NOT faults - they are facts about the request", () => {
  it("reports a member that is not on file", () => {
    const t = open();
    t.send("77777\r");
    expect(t.app.screen).toBe("inquiry");
    expect(t.app.statusText).toBe(STATUS.notOnFile("77777"));
    t.app.close();
  });

  it("reports a record this teller may not see", () => {
    const t = open();
    t.send("99999\r");
    expect(t.app.statusText).toBe(STATUS.restricted);
    t.app.close();
  });

  it("reports a non-numeric account number as a validation error", () => {
    const t = open();
    t.send("ABC\r");
    expect(t.app.statusText).toBe(STATUS.nonNumeric);
    t.app.close();
  });

  it("reports an empty query", () => {
    const t = open();
    t.send("\r");
    expect(t.app.statusText).toBe(STATUS.emptyQuery);
    t.app.close();
  });

  it("prints all three on the status band, where a driver reports them without interpreting", () => {
    for (const [keys, text] of [
      ["77777\r", STATUS.notOnFile("77777")],
      ["99999\r", STATUS.restricted],
      ["ABC\r", STATUS.nonNumeric],
    ]) {
      const t = open();
      t.send(keys);
      // Row 23 (1-based), the status band, and the app tags an error with `***`.
      expect(t.painted()).toContain(`\x1b[23;1H *** ${text}`);
      t.app.close();
    }
  });
});

describe("every fault in the registry is armable and does what its taxonomy row needs", () => {
  it("declares a family, a screen, a mode and a taxonomy row for each", () => {
    for (const [id, spec] of Object.entries(FAULTS)) {
      expect(spec.id, id).toBe(id);
      expect(["delivery", "transition"], id).toContain(spec.family);
      expect(["once", "sticky"], id).toContain(spec.mode);
      expect(spec.taxonomy.length, id).toBeGreaterThan(10);
      expect(canonicalFaultId(id), id).toBe(id);
    }
  });

  it("has an assertion below for every fault, so a new one cannot ship untested", () => {
    expect(Object.keys(FAULTS).sort()).toEqual(COVERED.sort());
  });

  it("torn-repaint: delivers a partial frame, goes quiet, then delivers the rest", () => {
    const whole = frameOf();
    const t = open({ fault: "torn-repaint" });
    expect(t.chunks).toHaveLength(1);
    expect(t.painted().length).toBeLessThan(whole.length);
    // The tell: the screen-id band is painted near the end of the frame, so a torn read has none.
    expect(t.painted()).not.toContain("MEMBER INQUIRY 01");
    expect(t.pending()).toBe(1);
    t.flush();
    expect(t.painted()).toBe(whole);
    expect(t.painted()).toContain("MEMBER INQUIRY 01");
    t.app.close();
  });

  it("slow-repaint: holds an entire frame back and then delivers it intact", () => {
    const whole = frameOf();
    const t = open({ fault: "slow-repaint", faultAt: "inquiry" });
    expect(t.chunks).toHaveLength(0);
    expect(t.pending()).toBe(1);
    t.flush();
    expect(t.painted()).toBe(whole);
    t.app.close();
  });

  it("session-timeout: lands on the sign-on screen instead, and is cleared by signing on", () => {
    const t = open({ fault: "session-timeout" });
    t.flush();
    t.send("12345\r");
    expect(t.app.screen).toBe("signon");
    expect(t.app.screenId).toBe("SIGN ON 00");
    // Sticky: it is the REMEDY that clears it, not the passage of time.
    t.send("TLR01\r");
    expect(t.app.screen).toBe("inquiry");
    expect(t.app.statusText).toBe(STATUS.signedOn);
    t.send("12345\r");
    expect(t.app.screen).toBe("detail");
    t.app.close();
  });

  it("session-timeout: refuses an empty operator id, so the remedy can fail too", () => {
    const t = open({ fault: "session-timeout" });
    t.send("12345\r");
    t.send("\r");
    expect(t.app.screen).toBe("signon");
    t.app.close();
  });

  it("app-error: paints an abend screen once, and the retry succeeds", () => {
    const t = open({ fault: "app-error" });
    t.send("12345\r");
    expect(t.app.screen).toBe("error");
    expect(t.app.screenId).toBe("SYSTEM ERROR 99");
    expect(t.painted()).toContain("ABEND 0C7");
    // `once`: spent when it fired, so the same flow works on the next attempt.
    t.send("\x1bOR");
    t.send("12345\r");
    expect(t.app.screen).toBe("detail");
    t.app.close();
  });
});

const COVERED = ["torn-repaint", "slow-repaint", "session-timeout", "app-error"];

describe("arming a fault", () => {
  it("treats an unknown name as no fault rather than as an error", () => {
    expect(armFault("nonesuch")).toBeNull();
    expect(armFault("")).toBeNull();
    expect(armFault("none")).toBeNull();
    expect(armFault(null)).toBeNull();
  });

  it("accepts the shorthands the prose uses", () => {
    expect(canonicalFaultId("tear")).toBe("torn-repaint");
    expect(canonicalFaultId("slow-load")).toBe("slow-repaint");
    expect(canonicalFaultId("abend")).toBe("app-error");
    expect(canonicalFaultId("TIMEOUT")).toBe("session-timeout");
  });

  it("fills defaults from the registry and honours overrides", () => {
    const armed = armFault("torn-repaint", {
      at: "detail",
      mode: "sticky",
      delayMs: 50,
      tearAt: 0.2,
    });
    expect(armed).toEqual({
      id: "torn-repaint",
      family: "delivery",
      screen: "detail",
      mode: "sticky",
      delayMs: 50,
      tearAt: 0.2,
    });
  });

  it("ignores an out-of-range tear point rather than emitting an empty frame", () => {
    expect(armFault("torn-repaint", { tearAt: 0 })?.tearAt).toBe(0.55);
    expect(armFault("torn-repaint", { tearAt: 1 })?.tearAt).toBe(0.55);
    expect(armFault("torn-repaint", { tearAt: "nonsense" })?.tearAt).toBe(0.55);
  });
});

describe("two tenants of one vendor product", () => {
  it("has exactly the two the multi-tenant story needs", () => {
    expect(TENANT_IDS).toEqual(["riverbend", "summit"]);
  });

  it("differs in branding, labels, geometry, widths, screen names and the exit key", () => {
    const rb = TENANTS.riverbend;
    const sm = TENANTS.summit;
    expect(rb.bank).not.toBe(sm.bank);
    expect(rb.labels).not.toEqual(sm.labels);
    expect(rb.fieldCol).not.toBe(sm.fieldCol);
    expect(rb.fieldRows).not.toEqual(sm.fieldRows);
    expect(rb.widths).not.toEqual(sm.widths);
    expect(rb.inquiryScreen).not.toBe(sm.inquiryScreen);
    expect(rb.exitKey).toBe("F3");
    expect(sm.exitKey).toBe("F12");
  });

  it("serves the SAME account data on both, so one read step covers them", () => {
    for (const tenant of TENANT_IDS) {
      const t = open({ tenant });
      t.send("12345\r");
      expect(t.painted()).toContain("REGULAR SAVINGS");
      expect(t.painted()).toContain("1,204.55");
      t.app.close();
    }
  });

  it("falls back to the default tenant for an unknown name", () => {
    const t = open({ tenant: "nonesuch" });
    expect(t.app.tenant.id).toBe("riverbend");
    t.app.close();
  });
});

describe("the painter behaves like a green screen", () => {
  it("erases and then addresses the cursor absolutely, never relatively", () => {
    const frame = frameOf();
    expect(frame.startsWith("\x1b[2J\x1b[H")).toBe(true);
    // No relative cursor motion, no scroll region, no line-wrap reliance. Every write is
    // `CSI row;col H` followed by text, which is what makes the emulator's grid deterministic.
    // Composed from ESC rather than written with a literal, for the reason `app.js` gives: the
    // control character is the subject here, and building the pattern says so.
    const ESC = "\u001b";
    const sequences = frame.match(new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g")) ?? [];
    const allowed = new RegExp(`^${ESC}\\[(2J|H|[0-9]+;[0-9]+H|0m|1m|7m)$`);
    expect(sequences.filter((s) => !allowed.test(s))).toEqual([]);
  });

  it("marks operator-writable fields with reverse video and emphasis with bold", () => {
    const frame = frameOf();
    expect(frame).toContain("\x1b[7m");
    expect(frame).toContain("\x1b[1m");
  });

  it("paints the status band on row 23 and the screen-id band on row 24", () => {
    const frame = frameOf();
    expect(frame).toContain("\x1b[24;1H MEMBER INQUIRY 01");
  });

  it("separates legend entries with more than one space, so a key cannot swallow the next name", () => {
    expect(frameOf()).toContain("F3=Exit   TAB=Next Field   ENTER=Search");
  });
});

describe("input handling", () => {
  it("enforces the field's declared width, which is the same number the driver reads off the grid", () => {
    const t = open();
    t.send("1234567890123456");
    expect(t.painted()).toContain("123456789012");
    expect(t.painted()).not.toContain("1234567890123");
    t.app.close();
  });

  it("uppercases input, the way a teller terminal does", () => {
    const t = open();
    t.send("abc\r");
    expect(t.app.statusText).toBe(STATUS.nonNumeric);
    t.app.close();
  });

  it("tokenizes an escape sequence glued to ordinary characters", () => {
    expect(tokenizeKeys("12\x1b[B34").tokens).toEqual(["1", "2", "\x1b[B", "3", "4"]);
  });

  it("carries a sequence SPLIT ACROSS CHUNKS rather than printing its bytes", () => {
    // A byte-oriented transport splits wherever it likes. Without the carry, `ESC` and `[` would be
    // typed into the field as literal characters and the arrow key would be lost.
    const first = tokenizeKeys("12\x1b[");
    expect(first.tokens).toEqual(["1", "2"]);
    expect(first.carry).toBe("\x1b[");
    expect(tokenizeKeys(`${first.carry}B`).tokens).toEqual(["\x1b[B"]);
  });

  it("moves focus between the two fields on TAB", () => {
    const t = open();
    t.send("12345");
    t.send("\t");
    t.send("AVERY");
    // The account number kept its value and the name field took the new text.
    expect(t.painted()).toContain("12345");
    expect(t.painted()).toContain("AVERY");
    t.app.close();
  });
});

describe("the fixture's data is obviously synthetic and its app never touches the process", () => {
  it("names nobody real and holds no credential", () => {
    expect(MEMBERS["12345"]?.name).toBe("AVERY SYNTHETIC");
    expect(MEMBERS["54321"]?.name).toBe("BRETT PLACEHOLDER");
    expect(MEMBERS["99999"]?.name).toBe("FROZEN TEST ACCT");
    const source = readFileSync(fileURLToPath(new URL("../src/data.js", import.meta.url)), "utf8");
    expect(source).not.toMatch(/password|secret|api[_-]?key/i);
  });

  it("keeps `process` out of everything but the process wrapper", () => {
    // `app.js` takes bytes and emits frames and knows nothing else. That is what lets the same
    // object be spawned as a child, driven in memory by a unit test, and used to capture the frozen
    // grids the driver's detector asserts against - with all three producing the same bytes.
    for (const file of ["app.js", "render.js", "faults.js", "tenants.js", "data.js"]) {
      const source = readFileSync(
        fileURLToPath(new URL(`../src/${file}`, import.meta.url)),
        "utf8",
      );
      expect(source.includes("process."), file).toBe(false);
    }
    const main = readFileSync(fileURLToPath(new URL("../src/main.js", import.meta.url)), "utf8");
    expect(main).toContain("process.stdin");
  });
});
