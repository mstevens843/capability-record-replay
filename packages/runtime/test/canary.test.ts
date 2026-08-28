// The redaction canary, verified the only way a canary can be: by injecting real leaks.
//
// A grep that finds nothing passes exactly as loudly as a grep that cannot find anything, so every
// assertion below plants a value first and then asserts the scan reports it. The encoding table is
// the important half - `utf8` is the leak a careless `console.log` produces, and the other thirteen
// are the ones that survive a reviewer grepping for the literal.
//
// Hermetic: a temporary directory, no browser, no network, no credential.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CanaryEncoding,
  DEFAULT_FORBIDDEN_PATTERNS,
  buildNeedles,
  pngTextChunks,
  renderCanaryReport,
  runRedactionCanary,
} from "../src/canary.js";

const SECRET = "10041";
const LABEL = "scenario happy-path / args.memberId";
const SECRETS = [{ label: LABEL, value: SECRET }];

const dirs: string[] = [];
function bundle(files: Readonly<Record<string, string | Buffer>>): string {
  const dir = mkdtempSync(join(tmpdir(), "crr-canary-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  }
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const scan = (dir: string) => runRedactionCanary({ bundleDir: dir, secrets: SECRETS });

/** A PNG with whatever ancillary chunks the test wants. CRCs are not checked by the parser and are
 *  filled with zeroes, because what is under test is the chunk WALK, not a checksum. */
function png(chunks: readonly { type: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  for (const chunk of [...chunks, { type: "IEND", data: Buffer.alloc(0) }]) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(chunk.data.length);
    parts.push(length, Buffer.from(chunk.type, "latin1"), chunk.data, Buffer.alloc(4));
  }
  return Buffer.concat(parts);
}

describe("the redaction canary", () => {
  it("passes a bundle that holds no bound value", () => {
    const report = scan(
      bundle({
        "result.json": JSON.stringify({ status: "ok", memberName: "ALVAREZ, DANA (SYNTHETIC)" }),
        "journal.jsonl": '{"type":"acted","valueRef":"taint:p1"}\n',
      }),
    );
    expect(report.clean).toBe(true);
    expect(report.hits).toEqual([]);
    expect(report.filesScanned).toBe(2);
  });

  it("FAILS on the plain leak, and names the file, the line and the label", () => {
    const report = scan(
      bundle({
        "a.json": '{"ok":true}\n',
        "nested/journal.jsonl": `{"type":"observed"}\n{"type":"acted","text":"${SECRET}"}\n`,
      }),
    );
    expect(report.clean).toBe(false);
    expect(report.hits).toHaveLength(1);
    expect(report.hits[0]).toMatchObject({
      file: "nested/journal.jsonl",
      view: "bytes",
      secret: LABEL,
      encoding: "utf8",
      line: 2,
    });
  });

  // The encoding table, one planted leak each, with a value chosen so that the spelling under test
  // is DISTINCT from every other spelling of the same value. Needles are de-duplicated by bytes, so
  // asserting `hex-upper` against a digits-only value would only ever prove that `hex-lower` works.
  const cases: readonly { encoding: CanaryEncoding; value: string; body: string }[] = [
    { encoding: "utf8", value: "10041", body: "id=10041" },
    { encoding: "utf8-lower", value: "Dana", body: "member dana alvarez" },
    { encoding: "utf8-upper", value: "Dana", body: "MEMBER DANA ALVAREZ" },
    { encoding: "json-escape", value: 'a"b', body: JSON.stringify({ note: 'a"b' }) },
    { encoding: "json-unicode", value: "10041", body: '"\\u0031\\u0030\\u0030\\u0034\\u0031"' },
    { encoding: "uri-component", value: "Dana Smith", body: "?name=Dana%20Smith" },
    { encoding: "percent-bytes", value: "10041", body: "%31%30%30%34%31" },
    { encoding: "html-entity-decimal", value: "10041", body: "&#49;&#48;&#48;&#52;&#49;" },
    { encoding: "html-entity-hex", value: "10041", body: "&#x31;&#x30;&#x30;&#x34;&#x31;" },
    { encoding: "hex-lower", value: "10041", body: "3130303431" },
    { encoding: "hex-upper", value: "Dana", body: "44616E61" },
  ];
  for (const { encoding, value, body } of cases) {
    it(`catches the value spelled as ${encoding}`, () => {
      const report = runRedactionCanary({
        bundleDir: bundle({ "leak.txt": `${body}\n` }),
        secrets: [{ label: LABEL, value }],
      });
      expect(report.clean).toBe(false);
      expect(report.hits.map((h) => h.encoding)).toContain(encoding);
    });
  }

  it("catches a UTF-16LE spelling, which a plain grep never sees", () => {
    const report = scan(bundle({ "leak.bin": Buffer.from(`x${SECRET}x`, "utf16le") }));
    expect(report.clean).toBe(false);
    expect(report.hits.map((h) => h.encoding)).toContain("utf16le");
    // A binary view has no line structure and must not invent one.
    expect(report.hits[0]?.line).toBeNull();
  });

  it("catches a base64 spelling at every one of the three byte alignments", () => {
    const value = "MEMBER-10041-SYNTHETIC";
    const secrets = [{ label: "b64", value }];
    for (let pad = 0; pad < 3; pad += 1) {
      const stream = Buffer.concat([Buffer.alloc(pad, 0x5a), Buffer.from(value, "utf8")]);
      const dir = bundle({ "blob.txt": stream.toString("base64") });
      const report = runRedactionCanary({ bundleDir: dir, secrets });
      expect(
        report.hits.map((h) => h.encoding),
        `alignment ${pad}`,
      ).toContain("base64");
    }
  });

  it("catches a value that is only in a FILENAME", () => {
    const report = scan(bundle({ [`obs-${SECRET}.json`]: "{}\n" }));
    expect(report.clean).toBe(false);
    expect(report.hits[0]).toMatchObject({ view: "path", encoding: "utf8" });
  });

  it("catches a value in a screenshot's tEXt metadata", () => {
    const image = png([{ type: "tEXt", data: Buffer.from(`Title\0member ${SECRET}`, "latin1") }]);
    const report = scan(bundle({ "capture.png": image }));
    expect(report.clean).toBe(false);
    expect(report.hits.map((h) => h.view)).toContain("png:tEXt");
  });

  it("catches a value in a COMPRESSED zTXt chunk, which the raw byte scan cannot see", () => {
    const body = deflateSync(Buffer.from(`the member is ${SECRET}`, "utf8"));
    const image = png([
      { type: "zTXt", data: Buffer.concat([Buffer.from("Comment\0\0", "latin1"), body]) },
    ]);
    const dir = bundle({ "capture.png": image });
    // The proof that the inflate is doing the work: the value is NOT in the file's bytes.
    const report = runRedactionCanary({ bundleDir: dir, secrets: SECRETS });
    expect(report.hits.map((h) => h.view)).toEqual(["png:zTXt"]);
    expect(pngTextChunks(image).map((c) => c.name)).toEqual(["png:zTXt"]);
  });

  it("suppresses, but still reports, a coincidental match inside a digest", () => {
    const digest = `sha256:${"ab10041cd".padEnd(64, "e")}`;
    const report = scan(bundle({ "manifest.json": `{"digest":"${digest}"}\n` }));
    expect(report.hits).toEqual([]);
    expect(report.suppressed).toHaveLength(1);
    expect(report.suppressed[0]?.suppressed).toBe("inside-opaque-hex-token");
    // Suppression is not deletion: the hex spelling of the same value is still a hard failure.
    expect(report.clean).toBe(true);
    const rendered = renderCanaryReport(report);
    expect(rendered).toContain("suppressed    1");
  });

  it("still fails on a value that was hex-encoded into a digest-shaped blob", () => {
    const blob = `3130303431${"f".repeat(54)}`;
    const report = scan(bundle({ "blob.json": `{"x":"${blob}"}\n` }));
    expect(report.clean).toBe(false);
    expect(report.hits.map((h) => h.encoding)).toEqual(["hex-lower"]);
  });

  it("flags a credential SHAPE nobody put on the secret list", () => {
    const report = scan(
      bundle({ "oops.pem": "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA==\n" }),
    );
    expect(report.clean).toBe(false);
    expect(report.forbidden).toHaveLength(1);
    expect(report.forbidden[0]?.name).toBe("pem-private-key");
    expect(report.hits).toEqual([]);
  });

  it("finds every forbidden shape once per occurrence, across files", () => {
    const report = scan(
      bundle({
        "a.txt": "AKIAABCDEFGHIJKLMNOP and AKIAZZZZZZZZZZZZZZZZ\n",
        "b.txt": "AKIAQQQQQQQQQQQQQQQQ\n",
      }),
    );
    expect(report.forbidden.filter((f) => f.name === "aws-access-key-id")).toHaveLength(3);
  });

  it("NEVER writes the value into its own report", () => {
    const report = scan(
      bundle({ "leak.json": `{"memberId":"${SECRET}","note":"before ${SECRET} after"}\n` }),
    );
    expect(report.hits.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(report) + renderCanaryReport(report);
    // The report is written INTO the bundle it scanned. If it quoted the leak, the next run would
    // find the canary's own output and never go clean again.
    expect(serialized).not.toContain(SECRET);
    expect(report.hits[0]?.context).toContain("REDACTED BYTES");
  });

  it("proves the matcher works before it trusts a clean result", () => {
    const report = scan(bundle({ "empty.json": "{}\n" }));
    expect(report.selfTest.ok).toBe(true);
    expect(report.selfTest.planted).toBe(report.needles);
    expect(report.selfTest.found).toBe(report.needles);
    expect(report.selfTest.missed).toEqual([]);
    expect(renderCanaryReport(report)).toContain("self-test     PASSED");
  });

  it("reports the encodings it could NOT build a needle for, rather than omitting them", () => {
    const report = scan(bundle({ "empty.json": "{}\n" }));
    // Five digits is eight base64 characters, of which only three to five are independent of the
    // value's byte alignment - too few to tell from noise, so they are not searched for and the
    // omission is on the report.
    expect(report.skippedEncodings.join("\n")).toContain("base64");
    expect(renderCanaryReport(report)).toContain("not searched");
  });

  it("de-duplicates needles so one leak is reported once, not three times", () => {
    const { needles } = buildNeedles(SECRETS);
    const spellings = needles.filter((n) => n.encoding.startsWith("utf8"));
    // `utf8`, `utf8-lower` and `utf8-upper` are the same bytes for a digits-only value.
    expect(spellings).toHaveLength(1);
    const alpha = buildNeedles([{ label: "n", value: "Alvarez" }]).needles;
    expect(alpha.filter((n) => n.encoding.startsWith("utf8"))).toHaveLength(3);
  });

  it("is deterministic: the same bytes produce the same report", () => {
    const files = {
      "b.json": `{"x":"${SECRET}"}\n`,
      "a.json": `{"y":"${SECRET}"}\n`,
      "c/d.json": "{}\n",
    };
    const first = scan(bundle(files));
    const second = scan(bundle(files));
    expect(first.hits.map((h) => [h.file, h.offset])).toEqual(
      second.hits.map((h) => [h.file, h.offset]),
    );
    expect(first.hits.map((h) => h.file)).toEqual(["a.json", "b.json"]);
  });

  it("honours a skip predicate, and counts what it actually read", () => {
    const dir = bundle({ "keep.json": "{}\n", "drop/leak.json": `${SECRET}\n` });
    const report = runRedactionCanary({
      bundleDir: dir,
      secrets: SECRETS,
      skip: (rel) => rel.startsWith("drop/"),
    });
    expect(report.filesScanned).toBe(1);
    expect(report.clean).toBe(true);
  });

  it("ships a forbidden-pattern list that is not empty", () => {
    expect(DEFAULT_FORBIDDEN_PATTERNS.length).toBeGreaterThan(4);
  });
});
