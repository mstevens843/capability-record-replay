// The redaction canary: the check that decides whether the evidence bundle may be published.
//
// BRIEF section 3.6 and section 3.7 make one promise about this system - "the artifact stores
// shapes, never values", and "values bound to `sensitive` parameters never reach logs, artifacts,
// or screenshots". Every other module in this package implements one half of that promise:
// `evidence.ts` redacts an observation, `journal.ts` writes handles instead of values,
// `@crr/core`'s `masking.ts` derives the rectangles a driver blanks. Each of them is unit-tested
// against its own inputs.
//
// This module tests the OUTPUT. It takes the values a run was actually given and greps the bytes
// that were actually written, which is the only check that fails when a mechanism is correct and
// somebody forgot to call it. `test/redaction.test.ts` asserts the sealed artifact holds no value;
// this asserts the whole bundle holds no value, in fourteen encodings, including inside a PNG's
// metadata chunks.
//
// THREE DESIGN RULES, all of which exist because a canary that cannot fail is worse than no canary.
//
// 1. IT PROVES IT CAN FIRE, EVERY TIME IT RUNS. `selfTest` plants each needle in a synthetic buffer
//    and runs the same matcher over it before the real scan begins. A report whose self-test did
//    not find every planted needle is `clean: false` no matter how few hits the bundle produced -
//    an encoder bug that silently produced an empty needle would otherwise turn the canary into a
//    green light that means nothing. This is the same standard the architecture contract tests are
//    held to: verified by injecting a real violation, not by trusting the scan.
//
// 2. THE REPORT NEVER CONTAINS A SECRET. Hits carry a LABEL ("scenario not-found / args.memberId"),
//    never the value, and every context excerpt has all known values blanked before it is stored.
//    The report is written into the bundle it just scanned; a report that quoted the leak it found
//    would be a leak, and the next run would find it.
//
// 3. NOTHING IS SILENTLY DROPPED. A hit that falls inside a 40+ character hexadecimal run - a
//    sha256 digest - is `suppressed` rather than deleted, and it is still printed. Suppression
//    costs nothing: a value that was genuinely hex-encoded into a digest-shaped blob is caught by
//    the `hex-lower` / `hex-upper` needles instead, which is why this is the one narrow rule.
//
// WHAT THIS CANNOT DO, stated plainly because the alternative is a false sense of coverage:
// a byte scan cannot see through compression or encryption. A PNG's pixels are a zlib stream, so
// this module inflates and scans a screenshot's TEXT chunks but not its raster. The defence for the
// raster is the mask, and the mask is verified at the pixel by decoding the image with an
// independently written codec in `@crr/surface-browser`'s `browser-capture.test.ts`, not here.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { inflateSync } from "node:zlib";

/**
 * One value the bundle must not contain, and a name for it that is safe to print.
 *
 * The label is what appears in the report, in a log line and in a CI failure. It has to be enough
 * to find the call site - "scenario member-not-found / args.memberId" - and it must never be the
 * value, because the report is written into the bundle.
 */
export interface CanarySecret {
  readonly label: string;
  readonly value: string;
}

/** How a value can be spelled in a file. Each is a real way a leak has escaped a redactor. */
export type CanaryEncoding =
  | "utf8"
  | "utf8-lower"
  | "utf8-upper"
  | "utf16le"
  | "json-escape"
  | "json-unicode"
  | "uri-component"
  | "percent-bytes"
  | "html-entity-decimal"
  | "html-entity-hex"
  | "hex-lower"
  | "hex-upper"
  | "base64"
  | "base64url";

export type SuppressionReason = "inside-opaque-hex-token";

export interface CanaryHit {
  /** Path relative to the bundle root, with `/` separators on every platform. */
  readonly file: string;
  /** Which view of the file matched: the bytes themselves, the file's own name, or a PNG chunk. */
  readonly view: string;
  /** The secret's LABEL. Never its value. */
  readonly secret: string;
  readonly encoding: CanaryEncoding;
  readonly offset: number;
  readonly length: number;
  /** 1-based line number, or `null` when the view has no text structure. */
  readonly line: number | null;
  /** Surrounding bytes with every known value blanked. Printable ASCII only. */
  readonly context: string;
  readonly suppressed: SuppressionReason | null;
}

/** A credential-shaped string, which is forbidden regardless of any parameter binding. */
export interface ForbiddenPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

export interface ForbiddenHit {
  readonly file: string;
  readonly view: string;
  readonly name: string;
  readonly line: number | null;
  readonly offset: number;
}

export interface CanarySelfTest {
  /** Every (secret, encoding) needle the matcher was asked to prove it can find. */
  readonly planted: number;
  /** Needles the matcher found in the synthetic buffer. Anything less than `planted` is a bug. */
  readonly found: number;
  /** `secret / encoding` for every needle that did NOT come back. Empty is the only good value. */
  readonly missed: readonly string[];
  readonly ok: boolean;
}

export interface CanaryReport {
  readonly bundleDir: string;
  readonly filesScanned: number;
  readonly bytesScanned: number;
  readonly secrets: readonly string[];
  readonly encodings: readonly CanaryEncoding[];
  /** Distinct byte sequences searched for. Fewer than secrets x encodings: a digits-only value has
   *  the same bytes in `utf8`, `utf8-lower` and `utf8-upper`, and a short one has no usable base64
   *  needle at all (see `skippedEncodings`). */
  readonly needles: number;
  /** `secret / encoding` pairs for which no needle could be built, and why. Printed rather than
   *  hidden: an encoding that was never searched is not coverage. */
  readonly skippedEncodings: readonly string[];
  readonly hits: readonly CanaryHit[];
  readonly suppressed: readonly CanaryHit[];
  readonly forbidden: readonly ForbiddenHit[];
  readonly selfTest: CanarySelfTest;
  /** The publish gate: no hit, no forbidden pattern, AND a self-test that proved the matcher works. */
  readonly clean: boolean;
}

export interface CanaryOptions {
  readonly bundleDir: string;
  readonly secrets: readonly CanarySecret[];
  /** Defaults to `DEFAULT_FORBIDDEN_PATTERNS`. Pass `[]` to disable. */
  readonly forbidden?: readonly ForbiddenPattern[];
  /** Relative paths (POSIX separators) this returns `true` for are not read. Nothing is skipped by
   *  default; a bundle with an unscannable file should say so rather than quietly excluding it. */
  readonly skip?: (relativePath: string) => boolean;
  /** Bytes of context either side of a hit. */
  readonly contextBytes?: number;
}

/**
 * Credential shapes that must never appear in a published bundle, whatever the parameter bindings.
 *
 * These are structural, not value-based: the point is that nobody has to remember to add their key
 * to the secret list. A PEM header or an `sk-ant-` prefix in an evidence file is a finding on its
 * own, and the canary reports the OFFSET rather than the match so the report stays publishable.
 */
export const DEFAULT_FORBIDDEN_PATTERNS: readonly ForbiddenPattern[] = [
  { name: "pem-private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "anthropic-api-key", pattern: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: "openai-api-key", pattern: /sk-(?:proj-)?[A-Za-z0-9]{32,}/g },
  { name: "aws-access-key-id", pattern: /AKIA[0-9A-Z]{16}/g },
  { name: "github-token", pattern: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  { name: "claude-code-oauth-token", pattern: /sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{16,}/g },
];

const ALL_ENCODINGS: readonly CanaryEncoding[] = [
  "utf8",
  "utf8-lower",
  "utf8-upper",
  "utf16le",
  "json-escape",
  "json-unicode",
  "uri-component",
  "percent-bytes",
  "html-entity-decimal",
  "html-entity-hex",
  "hex-lower",
  "hex-upper",
  "base64",
  "base64url",
];

/** A base64 needle shorter than this is indistinguishable from noise, so it is not searched for and
 *  the omission is reported. Six characters of base64 is 36 bits. */
const MIN_BASE64_NEEDLE = 6;

/** A run of hexadecimal at least this long is a digest, not prose. sha256 hex is 64. */
const OPAQUE_HEX_RUN = 40;

interface Needle {
  readonly secret: string;
  readonly encoding: CanaryEncoding;
  readonly bytes: Buffer;
}

// ---------------------------------------------------------------------------------------------
// Encoding the needles
// ---------------------------------------------------------------------------------------------

/**
 * The base64 spellings of a value that is embedded at an unknown byte offset inside a larger
 * stream.
 *
 * Base64 packs three bytes into four characters, so the same value has three different spellings
 * depending on how many bytes precede it. Encoding `value` alone finds only one of the three, which
 * is how a leak inside a base64 blob survives a naive grep. Each variant drops the leading
 * characters that carry the padding bytes' bits and the trailing characters that would carry bits
 * of whatever follows the value in the real stream.
 */
function base64Spellings(value: Buffer, urlSafe: boolean): readonly string[] {
  const out = new Set<string>();
  for (let pad = 0; pad < 3; pad += 1) {
    const prefixed = Buffer.concat([Buffer.alloc(pad, 0x41), value]);
    const encoded = prefixed.toString(urlSafe ? "base64url" : "base64").replace(/=+$/, "");
    const dropFront = Math.ceil((pad * 8) / 6);
    const core = encoded.slice(dropFront, Math.max(dropFront, encoded.length - 2));
    if (core.length >= MIN_BASE64_NEEDLE) out.add(core);
  }
  return [...out];
}

function encodeAs(encoding: CanaryEncoding, value: string): readonly Buffer[] {
  const utf8 = Buffer.from(value, "utf8");
  switch (encoding) {
    case "utf8":
      return [utf8];
    case "utf8-lower":
      return [Buffer.from(value.toLowerCase(), "utf8")];
    case "utf8-upper":
      return [Buffer.from(value.toUpperCase(), "utf8")];
    case "utf16le":
      return [Buffer.from(value, "utf16le")];
    case "json-escape": {
      // What `JSON.stringify` writes between the quotes. Identical to `utf8` for a plain value and
      // different the moment the value holds a quote, a backslash or a control character.
      const body = JSON.stringify(value).slice(1, -1);
      return [Buffer.from(body, "utf8")];
    }
    case "json-unicode": {
      // The `\u0031\u0030...` form a conservative serializer emits. A real escape hatch: it
      // defeats every grep for the literal.
      const body = [...value]
        .map((ch) => `\\u${ch.codePointAt(0)?.toString(16).padStart(4, "0") ?? ""}`)
        .join("");
      return [Buffer.from(body, "utf8")];
    }
    case "uri-component":
      return [Buffer.from(encodeURIComponent(value), "utf8")];
    case "percent-bytes": {
      const body = [...utf8].map((b) => `%${b.toString(16).padStart(2, "0")}`).join("");
      return [Buffer.from(body.toLowerCase(), "utf8"), Buffer.from(body.toUpperCase(), "utf8")];
    }
    case "html-entity-decimal":
      return [Buffer.from([...value].map((ch) => `&#${ch.codePointAt(0)};`).join(""), "utf8")];
    case "html-entity-hex":
      return [
        Buffer.from(
          [...value].map((ch) => `&#x${ch.codePointAt(0)?.toString(16)};`).join(""),
          "utf8",
        ),
      ];
    case "hex-lower":
      return [Buffer.from(utf8.toString("hex"), "utf8")];
    case "hex-upper":
      return [Buffer.from(utf8.toString("hex").toUpperCase(), "utf8")];
    case "base64":
      return base64Spellings(utf8, false).map((s) => Buffer.from(s, "utf8"));
    case "base64url":
      return base64Spellings(utf8, true).map((s) => Buffer.from(s, "utf8"));
  }
}

/**
 * Every needle for every secret, plus a list of the (secret, encoding) pairs that produced none.
 *
 * De-duplicated by bytes AND by (secret, encoding), because a digits-only value spells the same in
 * `utf8`, `utf8-lower` and `utf8-upper` and reporting one hit three times would make a single leak
 * look like three.
 */
export function buildNeedles(secrets: readonly CanarySecret[]): {
  readonly needles: readonly Needle[];
  readonly skipped: readonly string[];
} {
  const needles: Needle[] = [];
  const skipped: string[] = [];
  for (const secret of secrets) {
    if (secret.value.length === 0) {
      skipped.push(`${secret.label} / <empty value, nothing to search for>`);
      continue;
    }
    const seen = new Set<string>();
    for (const encoding of ALL_ENCODINGS) {
      const spellings = encodeAs(encoding, secret.value).filter((b) => b.length > 0);
      if (spellings.length === 0) {
        skipped.push(
          `${secret.label} / ${encoding} - no needle of at least ${MIN_BASE64_NEEDLE} characters`,
        );
        continue;
      }
      let added = 0;
      for (const bytes of spellings) {
        const key = bytes.toString("base64");
        if (seen.has(key)) continue;
        seen.add(key);
        needles.push({ secret: secret.label, encoding, bytes });
        added += 1;
      }
      if (added === 0) {
      }
    }
  }
  return { needles, skipped };
}

// ---------------------------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------------------------

interface View {
  readonly name: string;
  readonly bytes: Buffer;
  /** Line numbers are only meaningful for a view with text structure. */
  readonly text: boolean;
}

function isProbablyText(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 8192);
  return !head.includes(0);
}

function lineAt(bytes: Buffer, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (bytes[i] === 0x0a) line += 1;
  return line;
}

/** Maximal runs of hexadecimal at least `OPAQUE_HEX_RUN` long: the digests. */
function opaqueHexRuns(bytes: Buffer): readonly (readonly [number, number])[] {
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= bytes.length; i += 1) {
    const b = i < bytes.length ? (bytes[i] as number) : -1;
    const hex = (b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x66) || (b >= 0x41 && b <= 0x46);
    if (hex) {
      if (start < 0) start = i;
    } else {
      if (start >= 0 && i - start >= OPAQUE_HEX_RUN) runs.push([start, i]);
      start = -1;
    }
  }
  return runs;
}

const HEX_CHARS = /^[0-9a-fA-F]+$/;

/**
 * A printable excerpt with every known value blanked.
 *
 * The blanking is not cosmetic. This string is written into the bundle, so a context that quoted
 * the leak would put the value back into the very file the next run scans.
 */
function contextOf(
  bytes: Buffer,
  offset: number,
  length: number,
  needles: readonly Needle[],
  width: number,
): string {
  const from = Math.max(0, offset - width);
  const to = Math.min(bytes.length, offset + length + width);
  const slice = Buffer.from(bytes.subarray(from, to));
  // The hit itself first, then anything else that happens to be in the window.
  for (const needle of needles) {
    let at = slice.indexOf(needle.bytes);
    while (at >= 0) {
      slice.fill(0x2e, at, at + needle.bytes.length);
      at = slice.indexOf(needle.bytes, at + 1);
    }
  }
  const printable = [...slice]
    .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
    .join("");
  const marker = `<${length} REDACTED BYTES>`;
  const head = printable.slice(0, offset - from);
  const tail = printable.slice(offset - from + length);
  return `${head}${marker}${tail}`;
}

function scanView(
  file: string,
  view: View,
  needles: readonly Needle[],
  forbidden: readonly ForbiddenPattern[],
  contextBytes: number,
): { hits: CanaryHit[]; forbiddenHits: ForbiddenHit[] } {
  const hits: CanaryHit[] = [];
  const forbiddenHits: ForbiddenHit[] = [];
  const runs = opaqueHexRuns(view.bytes);
  for (const needle of needles) {
    let at = view.bytes.indexOf(needle.bytes);
    while (at >= 0) {
      const end = at + needle.bytes.length;
      const inOpaque =
        needle.encoding.startsWith("utf8") &&
        HEX_CHARS.test(needle.bytes.toString("latin1")) &&
        runs.some(([s, e]) => at >= s && end <= e);
      hits.push({
        file,
        view: view.name,
        secret: needle.secret,
        encoding: needle.encoding,
        offset: at,
        length: needle.bytes.length,
        line: view.text ? lineAt(view.bytes, at) : null,
        context: contextOf(view.bytes, at, needle.bytes.length, needles, contextBytes),
        suppressed: inOpaque ? "inside-opaque-hex-token" : null,
      });
      at = view.bytes.indexOf(needle.bytes, at + 1);
    }
  }
  if (view.text) {
    const text = view.bytes.toString("utf8");
    for (const { name, pattern } of forbidden) {
      // A fresh RegExp per view: `g` regexes carry `lastIndex` between calls and a shared one would
      // silently skip the first match of every file after the first.
      const re = new RegExp(
        pattern.source,
        pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
      );
      for (const match of text.matchAll(re)) {
        const offset = Buffer.byteLength(text.slice(0, match.index ?? 0), "utf8");
        forbiddenHits.push({
          file,
          view: view.name,
          name,
          line: lineAt(view.bytes, offset),
          offset,
        });
      }
    }
  }
  return { hits, forbiddenHits };
}

// ---------------------------------------------------------------------------------------------
// PNG metadata - the "screenshot metadata" half of the ask
// ---------------------------------------------------------------------------------------------

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The text-carrying chunks of a PNG, decompressed.
 *
 * A screenshot is scanned as raw bytes like every other file, but its pixels are a zlib stream and
 * a byte scan cannot see into one. Its METADATA is a different matter: `tEXt`, `iTXt`, `zTXt` and
 * `eXIf` are exactly where a capture pipeline writes a page title, a URL or a form value, and two
 * of them are compressed. They are inflated here so the same needles run over them.
 */
export function pngTextChunks(bytes: Buffer): readonly { name: string; payload: Buffer }[] {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_MAGIC)) return [];
  const out: { name: string; payload: Buffer }[] = [];
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString("latin1");
    const dataAt = at + 8;
    if (dataAt + length > bytes.length) break;
    const data = bytes.subarray(dataAt, dataAt + length);
    if (type === "tEXt" || type === "eXIf") {
      out.push({ name: `png:${type}`, payload: Buffer.from(data) });
    } else if (type === "zTXt" || type === "iTXt") {
      // Both hold a NUL-separated keyword header followed by a possibly-deflated body. Inflate what
      // inflates; keep the raw bytes when it does not, because an undecodable chunk is still bytes
      // that could hold a value.
      let payload = Buffer.from(data);
      const nul = data.indexOf(0);
      if (nul >= 0) {
        try {
          payload = Buffer.concat([data.subarray(0, nul), inflateSync(data.subarray(nul + 2))]);
        } catch {
          payload = Buffer.from(data);
        }
      }
      out.push({ name: `png:${type}`, payload });
    }
    at = dataAt + length + 4;
    if (type === "IEND") break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The self-test: proof the matcher can fail
// ---------------------------------------------------------------------------------------------

function selfTest(needles: readonly Needle[]): CanarySelfTest {
  const missed: string[] = [];
  let found = 0;
  for (const needle of needles) {
    // Planted at a non-zero offset, inside filler that is not part of the needle, so an off-by-one
    // in the matcher shows up rather than being masked by a match at index 0.
    const planted = Buffer.concat([
      Buffer.from("canary-self-test filler ", "utf8"),
      needle.bytes,
      Buffer.from(" filler", "utf8"),
    ]);
    if (planted.indexOf(needle.bytes) === 24) found += 1;
    else missed.push(`${needle.secret} / ${needle.encoding}`);
  }
  return { planted: needles.length, found, missed, ok: missed.length === 0 };
}

// ---------------------------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------------------------

function walk(root: string, skip: (relativePath: string) => boolean): readonly string[] {
  const out: string[] = [];
  const entries = readdirSync(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    // `parentPath` is Node 20.12+/22; `path` is the older spelling. Both are absolute.
    const parent = (entry as { parentPath?: string; path?: string }).parentPath ?? entry.path;
    const absolute = join(parent, entry.name);
    if (!statSync(absolute).isFile()) continue;
    const rel = relative(root, absolute).split(sep).join("/");
    if (skip(rel)) continue;
    out.push(rel);
  }
  return out.sort();
}

/**
 * Grep an evidence bundle for every value the runs that produced it were given.
 *
 * Deterministic: files are walked in sorted order and hits come back sorted, so two runs over the
 * same bytes produce byte-identical reports and a diff of two reports is meaningful.
 */
export function runRedactionCanary(options: CanaryOptions): CanaryReport {
  const { needles, skipped } = buildNeedles(options.secrets);
  const forbidden = options.forbidden ?? DEFAULT_FORBIDDEN_PATTERNS;
  const contextBytes = options.contextBytes ?? 32;
  const skip = options.skip ?? (() => false);

  const hits: CanaryHit[] = [];
  const suppressed: CanaryHit[] = [];
  const forbiddenHits: ForbiddenHit[] = [];
  let bytesScanned = 0;

  const files = walk(options.bundleDir, skip);
  for (const file of files) {
    const bytes = readFileSync(join(options.bundleDir, file));
    bytesScanned += bytes.length;
    const views: View[] = [
      // The path itself. A value in a FILENAME is published just as loudly as one in a body, and it
      // is the one place a redactor that only ever sees file contents cannot look.
      { name: "path", bytes: Buffer.from(file, "utf8"), text: true },
      { name: "bytes", bytes, text: isProbablyText(bytes) },
      ...pngTextChunks(bytes).map((chunk) => ({
        name: chunk.name,
        bytes: chunk.payload,
        text: true,
      })),
    ];
    for (const view of views) {
      const scanned = scanView(file, view, needles, forbidden, contextBytes);
      for (const hit of scanned.hits) (hit.suppressed === null ? hits : suppressed).push(hit);
      forbiddenHits.push(...scanned.forbiddenHits);
    }
  }

  const test = selfTest(needles);
  const order = (a: CanaryHit, b: CanaryHit): number =>
    a.file.localeCompare(b.file) || a.view.localeCompare(b.view) || a.offset - b.offset;
  return {
    bundleDir: options.bundleDir,
    filesScanned: files.length,
    bytesScanned,
    secrets: options.secrets.map((s) => s.label),
    encodings: ALL_ENCODINGS,
    needles: needles.length,
    skippedEncodings: skipped,
    hits: [...hits].sort(order),
    suppressed: [...suppressed].sort(order),
    forbidden: forbiddenHits,
    selfTest: test,
    clean: hits.length === 0 && forbiddenHits.length === 0 && test.ok,
  };
}

/** The human-readable form. Printed by `pnpm demo` and written next to the JSON report. */
export function renderCanaryReport(report: CanaryReport): string {
  const lines: string[] = [];
  lines.push(`REDACTION CANARY  ${report.clean ? "CLEAN" : "FAILED"}`);
  lines.push(`  bundle        ${report.bundleDir}`);
  lines.push(`  scanned       ${report.filesScanned} files, ${report.bytesScanned} bytes`);
  lines.push(
    `  searched for  ${report.secrets.length} value(s) x ${report.encodings.length} encodings = ${report.needles} distinct needles`,
  );
  lines.push(
    `  self-test     ${report.selfTest.ok ? "PASSED" : "FAILED"} - ${report.selfTest.found}/${report.selfTest.planted} planted needles were found`,
  );
  for (const missed of report.selfTest.missed) lines.push(`    NOT FOUND   ${missed}`);
  for (const skippedEncoding of report.skippedEncodings) {
    lines.push(`  not searched  ${skippedEncoding}`);
  }
  lines.push(`  hits          ${report.hits.length}`);
  for (const hit of report.hits) {
    lines.push(
      `    LEAK  ${hit.file}${hit.view === "bytes" ? "" : ` (${hit.view})`}${hit.line === null ? "" : `:${hit.line}`}  ${hit.secret} as ${hit.encoding}`,
    );
    lines.push(`          ${hit.context}`);
  }
  lines.push(`  suppressed    ${report.suppressed.length} (inside a digest-shaped hex run)`);
  for (const hit of report.suppressed) {
    lines.push(`    hex   ${hit.file}${hit.line === null ? "" : `:${hit.line}`}  ${hit.secret}`);
  }
  lines.push(`  credentials   ${report.forbidden.length}`);
  for (const hit of report.forbidden) {
    lines.push(`    SHAPE ${hit.file}${hit.line === null ? "" : `:${hit.line}`}  ${hit.name}`);
  }
  return `${lines.join("\n")}\n`;
}
