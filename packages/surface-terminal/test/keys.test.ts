// The key table, and the two conventions in it that are easy to get wrong.

import { KeySchema } from "@crr/core";
import { describe, expect, it } from "vitest";
import { portKeyOf } from "../src/detect.js";
import { KEY_BYTES, TERMINAL_SUPPORTED_KEYS, bytesForKey, typableText } from "../src/keys.js";

describe("every key the port has, this driver can send", () => {
  it("covers the port's whole vocabulary with no holes", () => {
    // `Key` is a closed set, so this is total by construction - but the assertion is what makes
    // adding a key to the port without adding it here a test failure rather than an `undefined`
    // written to a socket.
    expect([...TERMINAL_SUPPORTED_KEYS].sort()).toEqual([...KeySchema.options].sort());
    for (const key of KeySchema.options) expect(bytesForKey(key)).toBeTruthy();
  });

  it("sends F1-F4 as SS3 and the rest as CSI, because the numbering has holes", () => {
    expect(KEY_BYTES.F1).toBe("\x1bOP");
    expect(KEY_BYTES.F4).toBe("\x1bOS");
    expect(KEY_BYTES.F5).toBe("\x1b[15~");
    // 16 and 22 are unassigned: F6 is 17 and F11 is 23. Arithmetic would get both wrong.
    expect(KEY_BYTES.F6).toBe("\x1b[17~");
    expect(KEY_BYTES.F11).toBe("\x1b[23~");
    expect(KEY_BYTES.F12).toBe("\x1b[24~");
  });

  it("sends Backspace as DEL, not BS", () => {
    // DEC convention, and it has been that way for forty years. An application reading 0x08 as
    // "move the cursor left" instead of "delete behind it" silently eats a keystroke.
    expect(KEY_BYTES.Backspace).toBe("\x7f");
  });

  it("emits no two keys with the same byte sequence", () => {
    const bytes = Object.values(KEY_BYTES);
    expect(new Set(bytes).size).toBe(bytes.length);
  });
});

describe("legend tokens lower onto the port's key vocabulary", () => {
  it("maps F-keys and PF-keys alike", () => {
    expect(portKeyOf("F3")).toBe("F3");
    expect(portKeyOf("PF12")).toBe("F12");
    expect(portKeyOf("f7")).toBe("F7");
  });

  it("maps the named keys a green screen legend prints", () => {
    expect(portKeyOf("ENTER")).toBe("Enter");
    expect(portKeyOf("TAB")).toBe("Tab");
    expect(portKeyOf("ESC")).toBe("Escape");
  });

  it("answers null for a key the port has no name for, rather than picking a near one", () => {
    // CLEAR is a real 3270 key and is not in the port's set. Mapping it to Escape would press the
    // wrong thing on a screen where those do different things; the linker refuses the program.
    expect(portKeyOf("CLEAR")).toBeNull();
    expect(portKeyOf("F13")).toBeNull();
    expect(portKeyOf("PA2")).toBeNull();
  });
});

describe("typed text", () => {
  it("passes printable text through unchanged", () => {
    expect(typableText("AVERY SYNTHETIC")).toBe("AVERY SYNTHETIC");
  });

  it("strips control bytes rather than sending them into a field", () => {
    // A newline in a field's value would SUBMIT the screen. Passing it through would turn "type
    // this member's name" into "type part of it and press Enter", which is a wrong action that
    // reports success.
    expect(typableText("AVERY\r\nSYNTHETIC")).toBe("AVERYSYNTHETIC");
    expect(typableText("A\x1b[BB")).toBe("A[BB");
  });
});
