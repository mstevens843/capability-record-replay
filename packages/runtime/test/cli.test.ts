// `crr`, driven in-process.
//
// The verbs are tested the way a reviewer uses them, against the REAL corebank documents written to
// a temporary store - so a change that breaks the CLI's document handling breaks here rather than in
// the demo. `replay` is driven with `--surface` pointing at a module that hands back a scripted
// surface, which is the same seam the browser factory plugs into and the reason `@crr/runtime` does
// not depend on Playwright.

import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArtifact, sealArtifact } from "@crr/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { sharePositionArtifact, sharePositionContract } from "./fixtures/corebank.js";
import { mockAllowlist, mockArtifact, mockContract } from "./fixtures/mock-flow.js";

const dir = mkdtempSync(join(tmpdir(), "crr-cli-"));
const write = (name: string, value: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
};

const readJsonAt = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

const CONTRACT = write("contract.json", mockContract);
const ARTIFACT = write("artifact.json", mockArtifact());
const ALLOWLIST = write("allowlist.json", mockAllowlist);
const COREBANK_CONTRACT = write("corebank-contract.json", sharePositionContract);
const COREBANK_ARTIFACT = write("corebank-artifact.json", sharePositionArtifact);

// The same read fixture rewound to the state synthesis emits it in: `proposed`, carrying a plan
// rather than a result. `crr verify` is the only thing that can move it forward.
const approvedMock = mockArtifact();
const PROPOSED = write(
  "proposed.json",
  sealArtifact({
    ...approvedMock,
    lifecycle: { status: "proposed", supersedes: null, approval: null },
    verification: { ...approvedMock.verification, status: "unverified" },
  }),
);

const APPROVER = generateKeyPairSync("ed25519");
const KEY_FILE = join(dir, "approver.pem");
writeFileSync(KEY_FILE, APPROVER.privateKey.export({ format: "pem", type: "pkcs8" }) as string);
const PUB_FILE = join(dir, "approver.pub.pem");
writeFileSync(PUB_FILE, APPROVER.publicKey.export({ format: "pem", type: "spki" }) as string);
const SURFACE = join(dir, "surface.mjs");
writeFileSync(
  SURFACE,
  `import { MockSurface, MOCK_LEASE_TOKEN } from "@crr/core";
import { screens, IDS } from ${JSON.stringify(new URL("./fixtures/mock-surface-entry.mjs", import.meta.url).href)};
export default async () => ({
  surface: new MockSurface({
    screens,
    start: "blank",
    lease: MOCK_LEASE_TOKEN,
    transitions: [
      { from: "blank", on: { kind: "navigate", path: "/search" }, to: "search" },
      { from: "search", on: { kind: "type", target: IDS.memberIdField }, to: "search-typed" },
      { from: "search-typed", on: { kind: "click", target: IDS.searchButton }, to: "results" },
    ],
  }),
});
`,
);

let out = "";
let err = "";
const capture = () => {
  out = "";
  err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err += String(chunk);
    return true;
  });
};
afterEach(() => {
  vi.restoreAllMocks();
});

describe("crr show", () => {
  it("describes an artifact without touching a surface", async () => {
    capture();
    expect(await main(["show", COREBANK_ARTIFACT])).toBe(0);
    expect(out).toContain("corebank-member-share-position-web@1  approved");
    expect(out).toContain("max effect   READ");
    // The step list a reviewer reads before approving, with the effect class on every line.
    expect(out).toContain("0. [READ] navigate Open the member search screen");
    expect(out).toContain("8. [READ] assert Confirm the sub-account form is ready");
  });
});

describe("crr link", () => {
  it("runs the checks and performs zero actions", async () => {
    capture();
    expect(
      await main([
        "link",
        COREBANK_CONTRACT,
        COREBANK_ARTIFACT,
        "--args",
        '{"memberId":"10041"}',
        "--insecure-trust",
      ]),
    ).toBe(0);
    expect(out).toContain("link ok - 9 steps");
    expect(out).toContain("effective digest sha256:");
  });

  it("refuses an argument the contract's own constraints reject, with a numbered check", async () => {
    capture();
    expect(
      await main([
        "link",
        COREBANK_CONTRACT,
        COREBANK_ARTIFACT,
        "--args",
        '{"memberId":"abc"}',
        "--insecure-trust",
      ]),
    ).toBe(1);
    expect(out).toContain("link REFUSED (argument-invalid)");
    expect(out).toMatch(/check \d+/);
  });

  it("refuses a contract and an artifact that do not belong together", async () => {
    capture();
    expect(await main(["link", COREBANK_CONTRACT, ARTIFACT, "--insecure-trust"])).toBe(1);
    expect(out).toContain("link REFUSED");
  });
});

describe("crr replay", () => {
  it("returns 0 and prints the typed outputs on the ok arm", async () => {
    capture();
    const code = await main([
      "replay",
      CONTRACT,
      ARTIFACT,
      "--surface",
      SURFACE,
      "--args",
      '{"memberId":"50001"}',
      "--allowlist",
      ALLOWLIST,
      "--insecure-trust",
    ]);
    expect(code).toBe(0);
    expect(out).toContain("OK  run ");
    expect(out).toContain('"resultCount": "1 record"');
  });

  it("exits 2 for a business outcome, so a shell can tell an answer from a break", async () => {
    // The result contract's central distinction, carried all the way out to an exit code.
    const outcomeSurface = join(dir, "surface-outcome.mjs");
    writeFileSync(
      outcomeSurface,
      `import { MockSurface, MOCK_LEASE_TOKEN } from "@crr/core";
import { screens, IDS } from ${JSON.stringify(new URL("./fixtures/mock-surface-entry.mjs", import.meta.url).href)};
export default async () => ({
  surface: new MockSurface({
    screens,
    start: "blank",
    lease: MOCK_LEASE_TOKEN,
    transitions: [
      { from: "blank", on: { kind: "navigate", path: "/search" }, to: "search" },
      { from: "search", on: { kind: "type", target: IDS.memberIdField }, to: "search-typed" },
      { from: "search-typed", on: { kind: "click", target: IDS.searchButton }, to: "results-empty" },
    ],
  }),
});
`,
    );
    capture();
    const code = await main([
      "replay",
      CONTRACT,
      ARTIFACT,
      "--surface",
      outcomeSurface,
      "--args",
      '{"memberId":"50001"}',
      "--allowlist",
      ALLOWLIST,
      "--insecure-trust",
    ]);
    expect(code).toBe(2);
    expect(out).toContain("OUTCOME  run ");
    expect(out).toContain("MEMBER_NOT_FOUND");
    expect(out).toContain("not on file");
  });

  it("prints the machine-readable result document on request", async () => {
    capture();
    await main([
      "replay",
      CONTRACT,
      ARTIFACT,
      "--surface",
      SURFACE,
      "--args",
      '{"memberId":"50001"}',
      "--allowlist",
      ALLOWLIST,
      "--insecure-trust",
      "--json",
    ]);
    const document = JSON.parse(out) as { status: string; run: { journalRef: string } };
    expect(document.status).toBe("ok");
    expect(document.run.journalRef).toMatch(/^journal:/);
  });
});

describe("crr with no verb", () => {
  it("prints the usage and fails, rather than doing something", async () => {
    capture();
    expect(await main([])).toBe(1);
    expect(out).toContain("crr - deterministic replay");
    expect(await main(["nonsense"])).toBe(1);
    expect(err).toContain('unknown verb "nonsense"');
  });
});

describe("crr verify", () => {
  it("replays a proposed artifact with no model in the loop and writes the draft", async () => {
    capture();
    const draft = join(dir, "draft-verify.json");
    expect(
      await main([
        "verify",
        CONTRACT,
        PROPOSED,
        "--surface",
        SURFACE,
        "--args",
        '{"memberId":"50001"}',
        "--out",
        draft,
      ]),
    ).toBe(0);

    expect(out).toContain("VERIFIED  replay-full  grade full");
    expect(out).toContain("covered   submit-search");
    const written = parseArtifact(JSON.parse(readFileSync(draft, "utf8")));
    expect(written.lifecycle.status).toBe("draft");
    expect(written.verification.status).toBe("verified");
  });
});

describe("crr approve", () => {
  async function draftFile(name: string): Promise<string> {
    const path = join(dir, name);
    const code = await main([
      "verify",
      CONTRACT,
      PROPOSED,
      "--surface",
      SURFACE,
      "--args",
      '{"memberId":"50001"}',
      "--out",
      path,
    ]);
    if (code !== 0) throw new Error(`the fixture must verify, got exit ${code}: ${out}`);
    return path;
  }

  it("signs the digest, and the signed artifact then links for replay", async () => {
    capture();
    const draft = await draftFile("draft-approve.json");
    const approved = join(dir, "approved.json");

    expect(
      await main([
        "approve",
        draft,
        "--sign-key",
        `ops-key-1:${KEY_FILE}`,
        "--approver",
        "ops-approver-4",
        "--ack-grade",
        "full",
        "--ack-effects",
        "READ",
        "--out",
        approved,
      ]),
    ).toBe(0);
    expect(out).toContain("APPROVED");

    capture();
    expect(
      await main([
        "link",
        CONTRACT,
        approved,
        "--args",
        '{"memberId":"50001"}',
        "--trusted-key",
        `ops-key-1:${PUB_FILE}`,
      ]),
    ).toBe(0);
    expect(out).toContain("link ok - 3 steps");
  });

  it("refuses when the approver ticks a grade the run did not establish", async () => {
    capture();
    const draft = await draftFile("draft-badgrade.json");
    capture();

    expect(
      await main([
        "approve",
        draft,
        "--sign-key",
        `ops-key-1:${KEY_FILE}`,
        "--approver",
        "ops-approver-4",
        "--ack-grade",
        "partial-up-to-irreversible",
        "--ack-effects",
        "READ",
        "--out",
        join(dir, "never-written.json"),
      ]),
    ).toBe(1);
    expect(out).toContain("APPROVAL REFUSED");
    expect(out).toContain('verified to "full"');
  });

  it("refuses to approve an artifact that has never replayed itself", async () => {
    capture();
    expect(
      await main([
        "approve",
        PROPOSED,
        "--sign-key",
        `ops-key-1:${KEY_FILE}`,
        "--approver",
        "ops-approver-4",
        "--ack-grade",
        "full",
        "--ack-effects",
        "READ",
        "--out",
        join(dir, "never-written-2.json"),
      ]),
    ).toBe(1);
    expect(out).toContain("never replayed itself with the model out of the loop");
  });
});

// ---------------------------------------------------------------------------------------------
// The promotion path, from the command line a reviewer actually types
// ---------------------------------------------------------------------------------------------

describe("crr probe", () => {
  it("freezes a screen at every step and prints the step-to-digest table", async () => {
    // The table is the whole ergonomic point: identifying the positive becomes one line of reading
    // rather than a hunt through a JSONL file for whichever `evidence.captured` came after
    // whichever `observed`.
    const evidence = join(dir, "probe-green");
    capture();
    const code = await main([
      "probe",
      CONTRACT,
      ARTIFACT,
      "--surface",
      SURFACE,
      "--args",
      '{"memberId":"50001"}',
      "--allowlist",
      ALLOWLIST,
      "--insecure-trust",
      "--evidence",
      evidence,
      "--journal",
      join(dir, "probe-green", "journal.jsonl"),
    ]);
    expect(code, out).toBe(0);
    expect(out).toContain("captured observations (step / phase / content address)");
    expect(out).toContain("submit-search");
    expect(out).toContain("obs:");
    // A green run declares `captureOn: ["failure"]` at every step, so without the flag this table
    // would be empty - which is exactly why the verb exists.
    expect(readdirSync(evidence).filter((f) => f.startsWith("obs-")).length).toBeGreaterThan(0);
  });
});

describe("crr promote", () => {
  const review = {
    schemaVersion: "capability.promotion/v1",
    promotes: {
      capability: mockContract.name,
      contractVersion: mockContract.version,
      artifactDigest: mockArtifact().digest,
    },
    reviewedBy: "ops-approver-4",
    reviewedAt: "2026-08-29T12:00:00.000Z",
    outcome: {
      code: "ACCOUNT_CLOSED",
      kind: "business_outcome",
      title: "The member's account is closed",
      summary: "The core reports the account as closed.",
      terminal: true,
      payload: [],
      stableUnderRetry: true,
      stableUnderRetryBecause:
        "a closed account is a fact about the record, not about this attempt",
      callerAction: "refer-to-specialist",
      retryable: "never",
      agentGuidance:
        "Tell the member the account is closed and hand off to a branch representative.",
    },
    detector: {
      atStep: "submit-search",
      priority: 20,
      phase: "post",
      requiresSettled: true,
      capture: [],
      detect: {
        kind: "text-present",
        scope: {
          path: [
            { kind: "frame", name: { mode: "exact", value: "content", normalize: "std.text@1" } },
          ],
        },
        text: { mode: "token", token: "closed-banner", normalize: "std.label@1" },
      },
    },
    vocabulary: { "closed-banner": ["This account is closed"] },
    evidence: {
      positives: [
        {
          observation: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          fromRun: "run-probe-1",
          atStep: "submit-search",
          tenantId: "riverbend",
          appInstanceId: "riverbend-mock",
        },
      ],
      corpusRefs: ["probe-green"],
    },
  };

  it("refuses, writes nothing, and names the observation nobody froze", async () => {
    // A dry run against a corpus that does not hold the positive. The refusal is the useful half:
    // this is where a detector gets fixed, and it costs no session and no document.
    //
    // The artifact is rewound to a DRAFT, because `promote` refuses anything else: an approved
    // artifact's digest is one an approver signed, and a proposed one has never replayed itself.
    const approved = mockArtifact();
    const DRAFT = write(
      "promote-draft.json",
      sealArtifact({
        ...approved,
        digest: undefined,
        signatures: [],
        lifecycle: { status: "draft", supersedes: null, approval: null },
      }),
    );
    const REVIEW = write("promotion.json", {
      ...review,
      promotes: { ...review.promotes, artifactDigest: parseArtifact(readJsonAt(DRAFT)).digest },
    });
    capture();
    const code = await main([
      "promote",
      CONTRACT,
      DRAFT,
      "--review",
      REVIEW,
      "--corpus",
      join(dir, "probe-green"),
      "--tenant",
      "riverbend",
      "--dry-run",
    ]);
    expect(code).toBe(1);
    expect(out).toContain("PROMOTION REFUSED  ACCOUNT_CLOSED at submit-search");
    expect(out).toContain("a hand-written one is refused");
  });

  it("refuses --confirm from a run that did not return the outcome", async () => {
    const RESULT = write("probe-result.json", { status: "ok" });
    capture();
    expect(
      await main([
        "promote",
        "--confirm",
        ARTIFACT,
        "--code",
        "ACCOUNT_CLOSED",
        "--result",
        RESULT,
      ]),
    ).toBe(1);
    expect(out).toContain("CONFIRMATION REFUSED");
  });
});
