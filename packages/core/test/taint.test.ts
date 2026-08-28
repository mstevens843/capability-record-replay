// The taint model, tested the way it will actually be attacked: by accident.
//
// Nobody leaks a member number on purpose. They interpolate a variable into a log line, or spread
// an object into a journal event, or hand a value to `JSON.stringify` two layers above the place it
// was bound. So every test here is a mistake somebody will make, and the assertion is that the
// mistake produces a handle rather than a member number.
//
// The distinctive canary is the same shape as the redaction canary test in unit 18: one value, and
// a grep that must find nothing.

import { describe, expect, it } from "vitest";
import {
  TAINT_SINKS,
  type TaintSink,
  TaintViolationError,
  bindSensitive,
  describeTainted,
  isTainted,
  maskedLabel,
  mintTaintHandle,
  redactDeep,
  revealTainted,
  taintHandlesOf,
  taintParamOf,
} from "../src/index.js";

const CANARY = "50001-CANARY-DO-NOT-LOG";
const bind = () => bindSensitive("memberId", CANARY, 1);

describe("a taint handle", () => {
  it("names the binding and never the value", () => {
    const handle = mintTaintHandle("memberId", 1);
    expect(handle).toBe("taint:memberId-1");
    expect(taintParamOf(handle)).toBe("memberId");
  });

  it("distinguishes two bindings of the same parameter", () => {
    expect(mintTaintHandle("memberId", 1)).not.toBe(mintTaintHandle("memberId", 2));
    expect(taintParamOf(mintTaintHandle("memberId", 2))).toBe("memberId");
  });

  it("refuses to be minted from something that is not a parameter name", () => {
    // The failure this prevents: `mintTaintHandle(theValue, 1)`, which would put the value in the
    // one field designed to be safe to log.
    expect(() => mintTaintHandle(CANARY, 1)).toThrow(TaintViolationError);
    expect(() => mintTaintHandle("memberId", 0)).toThrow(TaintViolationError);
    expect(() => mintTaintHandle("memberId", 1.5)).toThrow(TaintViolationError);
  });
});

describe("a bound value", () => {
  it("survives none of the four ways a value normally escapes", () => {
    const v = bind();
    const escapes: Record<string, string> = {
      "String()": String(v),
      template: `${v}`,
      concatenation: `${v}`,
      "JSON.stringify": JSON.stringify(v),
      "JSON.stringify nested": JSON.stringify({ step: "enter-member-id", value: v }),
      spread: JSON.stringify({ ...v }),
      keys: Object.keys(v).join(","),
      "Number()": String(Number(v)),
      toStringTag: Object.prototype.toString.call(v),
    };
    for (const [how, text] of Object.entries(escapes)) {
      expect(text, how).not.toContain(CANARY);
    }
    expect(String(v)).toBe("taint:memberId-1");
    expect(JSON.parse(JSON.stringify({ value: v }))).toEqual({ value: "taint:memberId-1" });
    // `Number(handle)` is NaN rather than the member number: arithmetic on a tainted value fails
    // loudly instead of quietly unwrapping it.
    expect(Number.isNaN(Number(v))).toBe(true);
  });

  it("does not survive being copied out of its box", () => {
    const copy = structuredClone(bind()) as unknown as Record<string, unknown>;
    expect(isTainted(copy)).toBe(false);
    expect(JSON.stringify(copy)).not.toContain(CANARY);
  });

  it("renders as a length for the model-facing projection and nothing more", () => {
    const v = bind();
    expect(maskedLabel(v)).toBe(`<masked:${CANARY.length}>`);
    expect(describeTainted(v)).toEqual({
      handle: "taint:memberId-1",
      param: "memberId",
      present: true,
    });
  });

  it("is recognisable, and a plain string is not", () => {
    expect(isTainted(bind())).toBe(true);
    expect(isTainted(CANARY)).toBe(false);
    expect(isTainted({ handle: "taint:memberId-1" })).toBe(false);
  });

  it("yields the handles the policy context wants", () => {
    expect(taintHandlesOf([bind(), bindSensitive("pin", "0000", 1)])).toEqual([
      "taint:memberId-1",
      "taint:pin-1",
    ]);
  });
});

describe("the sinks", () => {
  it("hand the value to the two SPEC 8.3 permits", () => {
    expect(revealTainted(bind(), "surface-action")).toBe(CANARY);
    expect(revealTainted(bind(), "caller-output")).toBe(CANARY);
  });

  it("refuse every other one, loudly, with the reason attached", () => {
    // Enumerated from the table rather than listed here, so a sink added later cannot default to
    // allowed by being forgotten in this test.
    const disallowed = (Object.keys(TAINT_SINKS) as TaintSink[]).filter(
      (s) => !TAINT_SINKS[s].allowed,
    );
    expect(disallowed.length).toBeGreaterThan(5);
    for (const sink of disallowed) {
      expect(() => revealTainted(bind(), sink), sink).toThrow(TaintViolationError);
      try {
        revealTainted(bind(), sink);
      } catch (error) {
        // The refusal explains itself: a developer who hits this needs to know why the sink is
        // closed, not just that it is.
        expect((error as Error).message).toContain(TAINT_SINKS[sink].why);
        expect((error as Error).message).not.toContain(CANARY);
      }
    }
  });

  it("refuses rather than substituting a masked string", () => {
    // A substitution would mean the field gets filled with "<masked:23>" and the run fails a
    // hundred lines later with a validation error nobody can trace back to here.
    expect(() => revealTainted(bind(), "journal")).toThrow(/may not reach the "journal" sink/);
  });

  it("keeps the two allowed sinks to exactly the two SPEC 8.3 names", () => {
    const allowed = (Object.keys(TAINT_SINKS) as TaintSink[]).filter((s) => TAINT_SINKS[s].allowed);
    expect(allowed.sort()).toEqual(["caller-output", "surface-action"]);
  });
});

describe("redactDeep", () => {
  it("replaces bound values anywhere in a structure a logger might be handed", () => {
    const event = {
      type: "acted",
      step: "enter-member-id",
      args: { memberId: bind(), includeClosed: false },
      trail: [bind(), "public"],
    };
    const redacted = redactDeep(event);
    expect(JSON.stringify(redacted)).not.toContain(CANARY);
    expect(redacted).toEqual({
      type: "acted",
      step: "enter-member-id",
      args: { memberId: "taint:memberId-1", includeClosed: false },
      trail: ["taint:memberId-1", "public"],
    });
  });

  it("refuses a cyclic structure instead of returning a partial copy", () => {
    const cyclic: Record<string, unknown> = { value: bind() };
    cyclic.self = cyclic;
    expect(() => redactDeep(cyclic)).toThrow(TaintViolationError);
  });
});
