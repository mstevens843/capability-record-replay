// The port's `Key` vocabulary, lowered onto the bytes a VT terminal actually sends.
//
// Boring and fiddly, which is exactly why it belongs in one table rather than scattered through the
// driver. Two conventions are worth knowing before editing it:
//
//   F1-F4 are SS3 sequences (`ESC O P` .. `ESC O S`), not CSI ones. Every other function key is
//   `ESC [ n ~`, and the numbering has holes - 16, 22 and anything past 24 are not assigned - which
//   is why this is a table and not arithmetic.
//
//   Backspace is DEL (0x7f), not BS (0x08). That has been the terminal convention since DEC, and an
//   application that reads 0x08 as "move the cursor left" instead of "delete the character behind
//   it" will silently eat a keystroke. The fixture accepts both; a real Episys would not.
//
// `Key` is a CLOSED set at the port, so this table is total by construction: adding a key to the
// port without adding it here is a compile error, which is the point.

import type { Key } from "@crr/core";

const ESC = "\x1b";

export const KEY_BYTES: Readonly<Record<Key, string>> = Object.freeze({
  Enter: "\r",
  Tab: "\t",
  Escape: ESC,
  Backspace: "\x7f",
  Delete: `${ESC}[3~`,
  ArrowUp: `${ESC}[A`,
  ArrowDown: `${ESC}[B`,
  ArrowRight: `${ESC}[C`,
  ArrowLeft: `${ESC}[D`,
  Home: `${ESC}[1~`,
  End: `${ESC}[4~`,
  PageUp: `${ESC}[5~`,
  PageDown: `${ESC}[6~`,
  F1: `${ESC}OP`,
  F2: `${ESC}OQ`,
  F3: `${ESC}OR`,
  F4: `${ESC}OS`,
  F5: `${ESC}[15~`,
  F6: `${ESC}[17~`,
  F7: `${ESC}[18~`,
  F8: `${ESC}[19~`,
  F9: `${ESC}[20~`,
  F10: `${ESC}[21~`,
  F11: `${ESC}[23~`,
  F12: `${ESC}[24~`,
});

/** Every key this driver can send. Advertised in `SurfaceCapabilities.supportedKeys`, computed from
 *  the table so the advertisement cannot drift away from what the driver can do. */
export const TERMINAL_SUPPORTED_KEYS: readonly Key[] = Object.freeze(
  Object.keys(KEY_BYTES) as Key[],
);

export const bytesForKey = (key: Key): string => KEY_BYTES[key];

/**
 * Printable text, as an operator would type it.
 *
 * Control characters are stripped rather than escaped. A green screen has no way to receive a
 * literal newline into a field - the byte would submit the screen - so silently passing one through
 * would turn "type this member's name" into "type part of it and press Enter", which is a wrong
 * action that reports success.
 */
export const typableText = (text: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control bytes is the point.
  text.replace(/[\x00-\x1f\x7f]/g, "");
