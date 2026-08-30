// `pnpm demo` - the evidence bundle, produced from scratch, with no live service of any kind.
//
// WHAT THIS RUNS AGAINST. A `node:http` server this process starts on an ephemeral loopback port
// (`fixtures/corebank-web`, the frameset-era back office with eight injectable faults) and a
// Chromium build already on the machine. That is the entire dependency list. No credential is read,
// no provider SDK is in this import graph, and `test/demo-contract.test.ts` fails if one ever
// is - which matters because BRIEF section 11 makes "no agent may spend the author's money" a hard
// rule and a script that could reach a model is a script that eventually does.
//
// WHAT THIS SCRIPT DOES NOT PRODUCE. The live discovery run. A discovery run is a live model run
// by definition, it costs money, and it is the author's decision to make - so this script creates
// the slot, says what will land in it, and never fabricates a transcript. A VCR fixture replayed
// through the discovery loop is NOT a discovery run and is not presented as one anywhere in this
// bundle. The author has since performed one and `evidence/discovery-live/` holds it; every claim
// below that used to read "the slot is empty" is now a `liveRunPresent()` branch rather than a
// literal, for the reason that function's own comment gives.
//
// THE BUNDLE IS SELF-CHECKING, in two independent ways, and the script exits non-zero if either
// fails:
//   1. every scenario declares the arm and the fields it expects, and they are asserted after the
//      run - so a committed bundle is a bundle whose claims were checked rather than narrated;
//   2. the redaction canary greps every byte that was written for every parameter value that was
//      passed in, in fourteen encodings, including inside the screenshot's metadata chunks.

import { spawnSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Observation,
  type ReplayResultDocument,
  type UINode,
  deriveMaskRegions,
  safeCaptureRequest,
  sha256Bytes,
} from "@crr/core";
import { ed25519Trust } from "../src/approval.js";
import {
  type CanaryReport,
  type CanarySecret,
  renderCanaryReport,
  runRedactionCanary,
} from "../src/canary.js";
import { FileEvidenceSink } from "../src/evidence.js";
import { randomIds } from "../src/ids.js";
import { FileJournal } from "../src/journal.js";
import { replay } from "../src/replay.js";
// The three documents come from the module the interpreter's own acceptance test uses, so the
// artifact in the bundle is by construction the artifact that suite replays. Copying them into a
// second file would let the evidence drift away from the tests that police it.
import {
  ABSENT_MEMBER_ID,
  APPROVER_KEY_ID,
  FIXTURE_MEMBER_ID,
  approverPublicKey,
  corebankAllowlist,
  sharePositionArtifact,
  sharePositionContract,
} from "../test/fixtures/corebank.js";
import {
  type BlobDirClaim,
  acquireBundleLock,
  auditBundleBlobs,
  releaseBundleLock,
} from "./integrity.js";
import { type Scenario, scenarios } from "./scenarios.js";
import { chromiumPath, openDemoSurface } from "./surface.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
/**
 * Where the bundle goes. `<repo>/evidence` unless told otherwise, and the override exists for one
 * reason: `discoverySlot()` below must not run when a live discovery run is present, and the only
 * honest way to check that is to point this script at a directory that HAS one. Writing a fake
 * transcript into the real `evidence/discovery-live/` to test the guard is the one thing that
 * directory forbids - see its `PENDING.md` - so the guard is exercised against a `mkdtemp` instead.
 * `pnpm demo` with no environment set is unchanged in every respect.
 */
const EVIDENCE = process.env.CRR_DEMO_EVIDENCE_DIR ?? join(REPO, "evidence");
const ROUTES = sharePositionArtifact.flow.routes;
const LEASE = "lease-demo-capture" as never;

/** The sensitive value the masked-capture exhibit types into the deposit field. Distinctive on
 *  purpose: a canary hit on `25.00` would be ambiguous, and an ambiguous canary is a canary nobody
 *  believes. Obviously synthetic, like every other value in this repository. */
const CAPTURE_DEPOSIT = "1337.42";

// ---------------------------------------------------------------------------------------------
// A log that is both printed and kept, because the printed one is the deliverable
// ---------------------------------------------------------------------------------------------

/** The bundle lock this process holds, released once at the very end. Null until it is taken. */
let heldLock: string | null = null;

const lines: string[] = [];
const log = (line = ""): void => {
  lines.push(line);
  process.stdout.write(`${line}\n`);
};
const since = (mark: number): string => `${lines.slice(mark).join("\n")}\n`;

const writeText = (path: string, body: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
};
const writeJson = (path: string, value: unknown): void =>
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);

// ---------------------------------------------------------------------------------------------
// The bundle layout
// ---------------------------------------------------------------------------------------------

/**
 * Everything this script owns and therefore may delete.
 *
 * `discovery-live/` is NOT on the list and never will be. When the author performs the live
 * discovery run, its transcript lands there, and a demo that cleared the directory would delete the
 * one artifact in this bundle that cannot be regenerated for free.
 */
function clearOwned(scenarioIds: readonly string[]): void {
  const owned = [
    "artifact",
    "masked-capture",
    "cli-replay",
    "redaction-canary",
    "demo.log",
    "MANIFEST.json",
    "README.md",
    ...scenarioIds,
  ];
  mkdirSync(EVIDENCE, { recursive: true });
  for (const entry of owned) rmSync(join(EVIDENCE, entry), { recursive: true, force: true });
}

function writeArtifactExhibit(): readonly string[] {
  const dir = join(EVIDENCE, "artifact");
  writeJson(join(dir, "contract.json"), sharePositionContract);
  writeJson(join(dir, "artifact.json"), sharePositionArtifact);
  writeJson(join(dir, "allowlist.json"), corebankAllowlist);
  // The PUBLIC half only, in PEM, so `crr replay --trusted-key` can verify the approval signature
  // from the command line. The private half is generated per process and is never written down.
  const pem = createPublicKey({
    key: Buffer.from(approverPublicKey),
    format: "der",
    type: "spki",
  })
    .export({ format: "pem", type: "spki" })
    .toString();
  writeText(join(dir, "approver.spki.pem"), pem);
  writeText(
    join(dir, "README.md"),
    [
      "# artifact — the three documents a replay links",
      "",
      "**SPEC §0.4: three documents, three readers.** They are separate files here because they are",
      "separate files in the design, and the separation is what lets one contract be implemented by",
      "two programs — a browser one and a green-screen one.",
      "",
      "| File | Reader | What it may contain |",
      "|---|---|---|",
      "| `contract.json` | the calling agent and the product owner | typed inputs and outputs, outcome **names**, prose. **Zero surface detail and no detector.** |",
      "| `artifact.json` | the interpreter and the security reviewer | the program: steps, targets, detectors, budgets, effects, provenance, the lifecycle and the approval. |",
      "| `allowlist.json` | the deployment | the origins, route patterns, action kinds and effect ceiling this installation permits. A program that authorized itself would not be authorized. |",
      "| `approver.spki.pem` | anyone verifying | the **public** half of the ed25519 approval key. |",
      "",
      "## Not one descriptor here is a selector, and none could be",
      "",
      "This product has no test ids, no `data-*` attributes and no `<label for>`, and its generated",
      "element ids differ per tenant (`ctl00_ctl32_g_9a1_txtMemberId` at one, `ctl00_ctl41_g_c7e2_txtMbrNo`",
      "at the next). A target is a role plus an accessible name, a label anchor, a table cell relative to",
      "a column header, or an ordinal within a landmark — resolved independently at replay time and",
      "**compared**. Disagreement is a refusal, not a fallback chain.",
      "",
      "## No member number appears in either document",
      "",
      "`grep` it. The caller's argument is a typed parameter and the artifact stores its **shape**",
      "(`digits`, `minLength: 5`, `maxLength: 5`), the goal template says `{memberId}`, and the routes",
      "are patterns (`/member/:memberId`). One mechanism — parameterization — is simultaneously the",
      "reusability story, the PII control and the route-canonicalization story.",
      "",
      "## Provenance, said plainly",
      "",
      "**Hand-authored.** `provenance.model.adapter` reads `replay` and the model id is",
      '`none:hand-authored-for-unit-11`, because that enum has no value meaning "a person wrote this".',
      "Every matcher in it was derived from a real `perceive()` over the fixture through",
      liveRunPresent()
        ? "`@crr/surface-browser`, but no model produced it. For one a model DID produce, see `../discovery-live/`."
        : "`@crr/surface-browser`, but no model produced it. See `../discovery-live/PENDING.md`.",
      "",
      "## The approval",
      "",
      "The signature is over the **digest string**, and the digest is over the JCS canonical form of",
      "the document with `lifecycle` excluded — so editing any other field changes the digest and the",
      "signature stops verifying. `crr replay --trusted-key` checks it; `../cli-replay/console.txt` is",
      "that check passing. The key pair is generated per process and the private half is never written",
      "anywhere, so these two files differ on every demo run while the digest does not.",
      "",
    ].join("\n"),
  );
  return [
    `artifact  ${sharePositionArtifact.artifactId}@${sharePositionArtifact.version}  ${sharePositionArtifact.lifecycle.status}`,
    `digest    ${sharePositionArtifact.digest}`,
    `contract  ${sharePositionContract.name}@${sharePositionContract.version}`,
    `steps     ${sharePositionArtifact.flow.steps.length}, max effect ${sharePositionArtifact.effects.maxEffect}`,
    `approval  ${sharePositionArtifact.lifecycle.approval?.approvedBy ?? "none"} / ${APPROVER_KEY_ID} (ed25519 over the digest)`,
  ];
}

// ---------------------------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------------------------

interface ScenarioOutcome {
  readonly scenario: Scenario;
  readonly result: ReplayResultDocument | null;
  readonly complaints: readonly string[];
  readonly durationMs: number;
}

async function runScenario(scenario: Scenario): Promise<ScenarioOutcome> {
  const dir = join(EVIDENCE, scenario.id);
  mkdirSync(dir, { recursive: true });
  const mark = lines.length;
  const startedAt = Date.now();

  log(`── ${scenario.id} ─ ${scenario.title}`);
  log(`   taxonomy  ${scenario.taxonomy}`);
  log(
    `   fault     ${scenario.fault === null ? "none armed" : `${scenario.fault.id} at ${scenario.fault.at} (${scenario.fault.mode})`}`,
  );
  log(`   args      ${JSON.stringify(Object.keys(scenario.args))} (values withheld from this log)`);
  log(`   broker    ${scenario.broker}`);

  const session = await openDemoSurface({
    routes: ROUTES,
    refresh: scenario.broker === "can-reauthenticate" ? "refreshed" : "failed",
  });
  let result: ReplayResultDocument | null = null;
  let complaints: readonly string[] = [];
  try {
    if (scenario.fault !== null) {
      const armed = await session.arm(scenario.fault.id, {
        at: scenario.fault.at,
        mode: scenario.fault.mode,
      });
      log(`   armed     ${JSON.stringify(armed)}`);
    }
    const out = await replay({
      contract: sharePositionContract,
      artifact: sharePositionArtifact,
      args: scenario.args,
      tenant: { tenantId: "riverbend", appInstanceId: "riverbend-corebank-fixture" },
      allowlist: corebankAllowlist,
      broker: session.broker,
      trust: ed25519Trust([{ keyId: APPROVER_KEY_ID, publicKey: approverPublicKey }]),
      ids: randomIds(),
      evidence: new FileEvidenceSink(join(dir, "observations")),
      journal: (runId, clock) =>
        new FileJournal({ runId, clock, path: join(dir, "journal.jsonl") }),
      perceiveDeadlineMs: 15_000,
      onIntervention: "fail",
    });
    result = out.result;
    complaints = scenario.check(out.result);
    writeJson(join(dir, "result.json"), out.result);
    log(`   arm       ${out.result.status.toUpperCase()}   ${describe(out.result)}`);
    log(
      `   run       ${out.result.run.stepsExecuted}/${out.result.run.stepsTotal} steps, ${out.result.run.durationMs}ms, ${out.result.run.steps.length} step attempts`,
    );
    log(
      `   budgets   actions ${out.result.run.budgets.actions.used}, observations ${out.result.run.budgets.observations.used}, remediations ${out.result.run.budgets.remediations.used}, program attempts ${out.result.run.budgets.programAttempts.used}`,
    );
    for (const recovery of out.result.run.recoveriesApplied) {
      log(
        `   recovery  ${recovery.name} at ${recovery.stepId}: ${recovery.result} after ${recovery.attempts}`,
      );
    }
    log(
      `   evidence  ${out.result.run.evidence.length} frozen observation(s), journal ${out.result.run.journalRef}`,
    );
  } catch (error) {
    complaints = [`the run threw: ${error instanceof Error ? error.message : String(error)}`];
    log(`   THREW     ${complaints[0]}`);
  } finally {
    await session.close();
  }

  for (const complaint of complaints) log(`   MISMATCH  ${complaint}`);
  log(`   checked   ${complaints.length === 0 ? "every declared expectation held" : "FAILED"}`);
  log();

  writeText(join(dir, "run.log"), since(mark));
  writeText(
    join(dir, "README.md"),
    [
      `# ${scenario.id}`,
      "",
      `**${scenario.title}**`,
      "",
      "| | |",
      "|---|---|",
      `| arm | \`${result?.status ?? "threw"}\` (expected \`${scenario.arm}\`) |`,
      `| taxonomy | ${scenario.taxonomy} |`,
      `| fault injected | ${scenario.fault === null ? "none" : `\`${scenario.fault.id}\` at \`${scenario.fault.at}\`, ${scenario.fault.mode}`} |`,
      `| session broker | ${scenario.broker} |`,
      "| produced by | `@crr/runtime` `replay()` over `@crr/surface-browser`, no model |",
      "",
      scenario.proves,
      "",
      "## Files",
      "",
      "- `result.json` — the result document the calling agent receives.",
      "- `journal.jsonl` — the structured journal, one event per line, written as the run happened.",
      "- `run.log` — this scenario's section of the demo console output.",
      "- `observations/` — content-addressed frozen `Observation`s. Each one turns this run into a",
      "  `classify()` unit test with no reproduction step, and each has been through",
      "  `redactObservation` before a byte was written.",
      "",
    ].join("\n"),
  );

  return { scenario, result, complaints, durationMs: Date.now() - startedAt };
}

function describe(result: ReplayResultDocument): string {
  switch (result.status) {
    case "ok":
      return `outputs: ${Object.keys(result.outputs).join(", ")}`;
    case "outcome":
      return `${result.outcome} (terminal=${result.terminal}, callerAction=${result.callerAction})`;
    case "suspended":
      return `intervention ${result.intervention.reason}`;
    default:
      return `${result.failure.class} at ${result.failure.atStep ?? "pre-flight"}`;
  }
}

// ---------------------------------------------------------------------------------------------
// The masked capture - the one exhibit that is about pixels rather than about a run
// ---------------------------------------------------------------------------------------------

/**
 * The SMALLEST nodes whose visible text carries one of these values.
 *
 * Smallest, because `deriveMaskRegions` masks the union of a node's whole subtree: a legacy
 * application's accessible tree routinely has the document, the layout table and the row all
 * carrying the same aggregated text, and handing it the document would blank the screenshot. Keeping
 * only nodes with no matching descendant masks the cell and not the page.
 */
function tightestNodesCarrying(
  nodes: readonly UINode[],
  values: readonly string[],
): readonly UINode["id"][] {
  const carries = (node: UINode): boolean =>
    values.some((value) =>
      [node.name, node.value, node.text].some((field) => field?.includes(value) === true),
    );
  const matching = nodes.filter(carries);
  const matchingIds = new Set(matching.map((node) => node.id));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const hasMatchingDescendant = (node: UINode): boolean =>
    node.children.some((childId) => {
      const child = byId.get(childId);
      if (child === undefined) return false;
      return matchingIds.has(childId) || hasMatchingDescendant(child);
    });
  return matching.filter((node) => !hasMatchingDescendant(node)).map((node) => node.id);
}

async function maskedCapture(): Promise<{ readonly ok: boolean; readonly summary: string }> {
  const dir = join(EVIDENCE, "masked-capture");
  mkdirSync(dir, { recursive: true });
  const mark = lines.length;
  log("── masked-capture ─ region masking of a field bound to a sensitive parameter");

  const session = await openDemoSurface({ routes: ROUTES, lease: LEASE });
  try {
    await session.gotoContent(`/member/${FIXTURE_MEMBER_ID}/subaccount/new`);
    const observe = async (): Promise<Observation> => {
      const perceived = await session.surface.perceive({ deadlineMs: 15_000 });
      if (!perceived.ok) throw new Error(`perceive failed: ${JSON.stringify(perceived.fault)}`);
      return perceived.observation;
    };
    const before = await observe();
    const field = before.nodes.filter((node) => node.ariaRole === "textbox")[0] as UINode;
    log(
      `   typed into  role=${field.ariaRole} name=${JSON.stringify(field.name)} (sensitive: true)`,
    );
    await session.surface.act(
      { kind: "type", target: field.id, text: CAPTURE_DEPOSIT, mode: "replace", sensitive: true },
      LEASE,
    );
    const after = await observe();
    const masked = after.nodes.filter((node) => node.masked);
    log(`   driver      blanked ${masked.length} node value(s) in every later observation`);

    // THE HALF THE DRIVER CANNOT DO ON ITS OWN, and the reason `deriveMaskRegions` takes an explicit
    // node list at all. The driver blanks the field a sensitive value was TYPED into. It knows
    // nothing about the same value being PRINTED BACK somewhere else on the screen - and this
    // product prints the member number in the form header, three rows above the field. Masking only
    // what the driver blanked ships a screenshot with the value in its pixels, where a byte scan
    // cannot find it and a reviewer can read it at a glance. That is precisely the failure this
    // exhibit exists to rule out, and it was caught by looking at the image.
    //
    // Inside a run the executor gets these ids from the taint model - `ResolvedBindings` plus the
    // nodes each step resolved. This exhibit stands outside a run, so it finds them by the values it
    // just supplied. The mechanism being demonstrated downstream is identical.
    const echoed = tightestNodesCarrying(after.nodes, [FIXTURE_MEMBER_ID, CAPTURE_DEPOSIT]);
    log(`   echoed      ${echoed.length} node(s) print a supplied value back and are masked too`);

    // The rectangles are computed by `@crr/core` from the observation, never by the driver: what
    // crosses the port is geometry, because the character-grid driver has no locators at all.
    const derivation = deriveMaskRegions(after.nodes, echoed, { unit: "px" });
    const request = safeCaptureRequest(derivation, "image");
    if (!request.ok) {
      log(`   REFUSED     ${request.unmaskable.length} sensitive node(s) have no geometry`);
      writeText(join(dir, "capture.log"), since(mark));
      return { ok: false, summary: "the capture was refused: a sensitive node had no geometry" };
    }
    const unmasked = await session.surface.capture({ maskRegions: [], format: "image" });
    const capture = await session.surface.capture(request.request);
    const bytes = session.captured(capture.ref);
    if (bytes === undefined) throw new Error("the capture was not stored");

    // ONLY the masked bytes are written. The unmasked screenshot exists for exactly as long as it
    // takes to prove the mask changed something, and it never reaches the disk.
    const file = join(dir, capture.ref);
    writeText(file, "");
    writeFileSync(file, bytes);
    writeJson(join(dir, "capture.json"), {
      note: "The masked PNG is the only screenshot in this bundle. An unmasked one was taken in memory to prove the mask changed the bytes, and was never written.",
      ref: capture.ref,
      digest: capture.digest,
      maskedRegions: capture.maskedRegions,
      regions: request.request.maskRegions,
      unmaskableNodes: derivation.unmaskable.length,
      absentNodes: derivation.absent.length,
      differsFromUnmasked: capture.digest !== unmasked.digest,
      pixelLevelVerification:
        "packages/surface-browser/test/browser-capture.test.ts decodes the PNG with an independently written codec and asserts the masked pixels are the mask colour and the neighbouring pixels are not. A byte scan cannot check a raster, so that test - not the canary - is the evidence for the pixels.",
    });
    log(
      `   regions     ${capture.maskedRegions} blanked, ${bytes.length} bytes written as ${capture.ref}`,
    );
    log(
      `   digest      ${capture.digest} (differs from the unmasked capture: ${capture.digest !== unmasked.digest})`,
    );
    log();
    writeText(join(dir, "capture.log"), since(mark));
    writeText(
      join(dir, "README.md"),
      [
        "# masked-capture",
        "",
        "**Region masking of a screenshot area bound to a sensitive parameter** (BRIEF §3.7, SPEC §8.4).",
        "",
        "A value is typed into the deposit field with `sensitive: true`. From that moment the driver",
        "blanks that node's `value` in every observation it produces; `@crr/core`'s `deriveMaskRegions`",
        "turns the blanked node's geometry into rectangles, `safeCaptureRequest` **refuses the capture",
        "outright** if any sensitive node has no geometry to mask, and the driver blanks those pixels",
        "before the bytes leave `capture()`. The ref and the digest are over the masked bytes, so",
        "nothing unmasked is addressable.",
        "",
        "The unmasked screenshot was taken in memory only, to prove the mask changed the bytes, and",
        "was never written to disk. `capture.json` records the rectangles and both digests.",
        "",
        "The redaction canary scans this PNG's bytes and inflates its `tEXt`/`zTXt`/`iTXt` chunks. It",
        "**cannot** see into the pixel stream - that is what the pixel-level assertions in",
        "`packages/surface-browser/test/browser-capture.test.ts` are for, and saying so is the",
        "difference between a check and a claim.",
        "",
      ].join("\n"),
    );
    return {
      ok: capture.maskedRegions > 0 && capture.digest !== unmasked.digest,
      summary: `${capture.maskedRegions} region(s) blanked`,
    };
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------------------------
// The CLI transcript - the reviewer's own command, run for real
// ---------------------------------------------------------------------------------------------

function cliReplay(): { readonly ok: boolean; readonly summary: string } {
  const dir = join(EVIDENCE, "cli-replay");
  mkdirSync(dir, { recursive: true });
  const cli = join(REPO, "packages/runtime/dist/cli.js");
  if (!existsSync(cli)) {
    return { ok: false, summary: `${relative(REPO, cli)} is missing - run \`pnpm build\` first` };
  }
  // THE ARGUMENT VALUE IS NOT WRITTEN DOWN, and the reason is the point of the exercise. A member
  // number is a `sensitive` parameter, and the taint model says a value bound to one never reaches
  // a log or an artifact. A command line is a log. The first run of this demo published the real
  // command into three files and the redaction canary failed the build over it - so the transcript
  // carries the SHAPE and points at where a reviewer gets a value, exactly as the artifact does.
  const args = `{"memberId":"${FIXTURE_MEMBER_ID}"}`;
  const argsShape = '{"memberId":"<A FIVE-DIGIT MEMBER NUMBER>"}';
  // EVERY PATH HERE IS DERIVED FROM `EVIDENCE`, and that is a fix rather than a flourish. These
  // were seven repo-relative `evidence/...` literals, so this one writer ignored
  // `CRR_DEMO_EVIDENCE_DIR` while every other writer in this file honoured it: a demo run pointed
  // at a scratch directory - the documented way to exercise the `discovery-live` guard - dropped
  // its journal blob into the COMMITTED bundle and left it there. Measured: two such runs took
  // `evidence/cli-replay/observations/` to three journal blobs and the tracked bundle to 67 files.
  // `relative(REPO, …)` reproduces the old strings exactly when the bundle is `<repo>/evidence`, so
  // the command a reviewer copies out of the transcript is unchanged.
  const inBundle = (...parts: string[]): string =>
    relative(REPO, join(EVIDENCE, ...parts))
      .split(sep)
      .join("/");
  const argv = [
    "replay",
    inBundle("artifact", "contract.json"),
    inBundle("artifact", "artifact.json"),
    "--surface",
    "packages/runtime/demo/surface-entry.mjs",
    "--args",
    args,
    "--allowlist",
    inBundle("artifact", "allowlist.json"),
    "--trusted-key",
    `${APPROVER_KEY_ID}:${inBundle("artifact", "approver.spki.pem")}`,
    "--tenant",
    "riverbend",
    "--app",
    "riverbend-corebank-fixture",
    "--journal",
    inBundle("cli-replay", "journal.jsonl"),
    "--evidence",
    inBundle("cli-replay", "observations"),
  ];
  // `argv` in full, verb included: the printed command is one a reviewer copy-pastes, and a
  // transcript that drops `replay` prints something that exits non-zero. Only the argument VALUE is
  // substituted, for the reason given above.
  const shown = argv.map((arg) => (arg === args ? argsShape : arg));
  const command = `node packages/runtime/dist/cli.js ${shown.map(quote).join(" ")}`;
  log("── cli-replay ─ the same replay, through the shipped `crr` command");
  log(`   $ ${command}`);
  const proc = spawnSync(process.execPath, [cli, ...argv], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 180_000,
  });
  const transcript = [
    "# The member number this run was given is REDACTED from this transcript. It is a `sensitive`",
    "# parameter, and a command line is a log. Any member in fixtures/corebank-web/src/data.js works.",
    "",
    `$ ${command}`,
    "",
    `${proc.stdout ?? ""}${proc.stderr ?? ""}`,
    `exit ${proc.status}`,
    "",
  ].join("\n");
  writeText(join(dir, "console.txt"), transcript);
  for (const line of (proc.stdout ?? "").trimEnd().split("\n")) log(`   | ${line}`);
  log(`   exit      ${proc.status}`);
  log();
  writeText(
    join(dir, "README.md"),
    [
      "# cli-replay",
      "",
      "The same nine-step replay driven by the shipped `crr` binary rather than by the demo's own",
      "call into `replay()`, so the bundle contains one transcript a reviewer can reproduce verbatim:",
      "",
      "```",
      `$ ${command}`,
      "```",
      "",
      "`--surface` is a **module path**, not a flag with a fixed set of values. `@crr/runtime` does",
      "not import Playwright anywhere in `src/` - a contract test in `@crr/core` fails if it ever",
      "does - so the driver is genuinely a parameter and a green-screen factory drops in unchanged.",
      "",
      "`--trusted-key` verifies the ed25519 approval signature over the artifact's digest. The key",
      "pair is generated per process (a private key in a repository is a private key on the",
      "internet), so `approver.spki.pem` and the signature in `artifact.json` change on every demo",
      "run while the digest they cover does not.",
      "",
      "Exit code follows the arm: `0` ok, `2` a business outcome, `1` anything else. An outcome is",
      "not an error, and a shell script has to be able to tell those apart.",
      "",
    ].join("\n"),
  );
  return {
    ok: proc.status === 0,
    summary: proc.status === 0 ? "exit 0" : `exit ${proc.status}`,
  };
}

const quote = (arg: string): string => (/[^\w./:@=-]/.test(arg) ? `'${arg}'` : arg);

// ---------------------------------------------------------------------------------------------
// The empty slot
// ---------------------------------------------------------------------------------------------

function discoverySlot(): void {
  const dir = join(EVIDENCE, "discovery-live");
  mkdirSync(dir, { recursive: true });
  writeText(
    join(dir, "PENDING.md"),
    [
      "# discovery-live — EMPTY, ON PURPOSE",
      "",
      "**This directory holds nothing. That is the honest state of this deliverable today.**",
      "",
      "The assignment asks for logs from a discovery run. A discovery run puts a model in the loop:",
      "it calls the Anthropic Messages API, it costs the author money, and under `.private/BRIEF.md`",
      "§11 no agent working on this repository may make a live model call — live runs are initiated",
      "by the author, for a specific approved run, and nothing else.",
      "",
      "So the mechanism is built and the slot is empty, rather than the slot being filled with",
      "something that looks like a discovery run and is not.",
      "",
      "## What will land here",
      "",
      "| File | What it is |",
      "|---|---|",
      "| `transcript.json` | The full VCR recording of the run: requests, responses, tool calls, timings, token usage, and `usage.cache_read_input_tokens` per turn. Redacted by the same taint model as everything else — a recorded transcript is a persisted artifact. |",
      "| `discovery.log` | The observe → decide → act loop's console output: the filtered `Observation` the model was shown each turn, the node id it picked, the policy decision on each tool call. |",
      "| `journal.jsonl` | The discovery journal. Every tool call passes `PolicyEngine.check` and is journaled, exactly as a replay action is. |",
      "| `synthesized/` | `contract.json` + `artifact.json` as **synthesis** emitted them, plus the `SynthesisReport`. |",
      "| `verification.json` | The immediate self-replay with the model out of the loop. The artifact is only saved as `draft` if this passes. |",
      "| `provenance.json` | Adapter (`anthropic`), model id, prompt version, measured cache hit rate. |",
      "",
      "## What is NOT allowed to land here",
      "",
      "- A transcript replayed from a VCR fixture. Those exist (`packages/discovery/test/`) and they",
      "  are how the loop is tested with no credential — but a replayed fixture is not a live run and",
      "  presenting one as evidence would be the exact dishonesty this file exists to avoid.",
      "- A run driven by a human or by a coding agent through a manual driver. That is a debugging",
      "  aid, not a discovery run.",
      "- A run through the `agent-sdk` adapter. It draws on a Claude Code subscription and it runs",
      "  Claude Code's loop rather than ours, so it validates neither our prompt shape nor our tool",
      "  schemas.",
      "",
      "## What the rest of the bundle does and does not establish without it",
      "",
      "Every other directory here is a **replay**, which is the half of the system that runs in",
      "production with no model in the decision path. They establish that the interpreter, the",
      "classifier, the descriptor agreement check, the policy chokepoint, the taint model and the",
      "typed result contract work against a real hostile surface.",
      "",
      "They do **not** establish that a model can discover this flow unaided. Nothing in this bundle",
      "does, and until `transcript.json` exists that claim is not made.",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------------------------
// Manifest, README, canary
// ---------------------------------------------------------------------------------------------

/**
 * Has the live discovery run happened yet?
 *
 * READ OFF DISK rather than hard-coded, because this bundle's own README used to say
 * "discovery-live/ is empty" as a literal - which was true for as long as it was true and would
 * have become a stale claim the moment `pnpm discover --yes` filled the slot. A generated document
 * asserting something it can check is the same defect as a comment asserting something the code
 * can check.
 */
function liveRunPresent(): boolean {
  return existsSync(join(EVIDENCE, "discovery-live", "transcript.json"));
}

/**
 * What every blob directory in this bundle is supposed to hold, and who says so.
 *
 * A scenario's authority is its own `result.json`: `run.evidence` lists every ref the run's
 * evidence sink minted, journal included, so the audit compares the directory against the document
 * a reviewer reads rather than against a number in this file. Two directories have no such
 * document in the bundle and get the weaker journal-count rule instead - `cli-replay/`, whose run
 * is a subprocess this script deliberately treats as a black box, and the live discovery run's
 * `verification-evidence/`, which the demo does not own and must never delete.
 *
 * `verification-evidence/` is audited anyway, and not for symmetry: two stale journal blobs were
 * found in it by hand and removed, from the directory a reviewer reads most carefully. Its
 * `verification.json` names exactly the refs its replay wrote, so from now on that is checked.
 */
function blobClaims(outcomes: readonly ScenarioOutcome[]): readonly BlobDirClaim[] {
  const claims: BlobDirClaim[] = outcomes.map((outcome) => ({
    label: `${outcome.scenario.id}/observations`,
    dir: join(EVIDENCE, outcome.scenario.id, "observations"),
    // A run that threw wrote no result document, so there is nothing to compare against and the
    // journal rule stands alone. It still catches the case this audit exists for.
    declared: outcome.result === null ? null : outcome.result.run.evidence,
  }));
  claims.push({
    label: "cli-replay/observations",
    dir: join(EVIDENCE, "cli-replay", "observations"),
    declared: null,
  });
  const verificationDir = join(EVIDENCE, "discovery-live", "verification-evidence");
  const verification = join(EVIDENCE, "discovery-live", "verification.json");
  if (existsSync(verificationDir) && existsSync(verification)) {
    const parsed = JSON.parse(readFileSync(verification, "utf8")) as {
      result?: { run?: { evidence?: readonly string[] } };
    };
    claims.push({
      label: "discovery-live/verification-evidence",
      dir: verificationDir,
      declared: parsed.result?.run?.evidence ?? null,
    });
  }
  return claims;
}

function walkEvidence(): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(EVIDENCE, { recursive: true, withFileTypes: true })) {
    const parent = (entry as { parentPath?: string; path?: string }).parentPath ?? entry.path;
    const absolute = join(parent, entry.name);
    if (!statSync(absolute).isFile()) continue;
    out.push(relative(EVIDENCE, absolute).split(sep).join("/"));
  }
  return out.sort();
}

const PRODUCERS: readonly { readonly prefix: string; readonly producer: string }[] = [
  { prefix: "artifact/", producer: "hand-authored (no model) — see README §Provenance" },
  { prefix: "cli-replay/", producer: "`crr replay` (shipped CLI), no model" },
  { prefix: "masked-capture/", producer: "`@crr/surface-browser` `capture()`, no model" },
  {
    prefix: "discovery-live/",
    producer: "`pnpm discover` — a LIVE model run, or PENDING.md if none has happened",
  },
  { prefix: "redaction-canary/", producer: "`@crr/runtime` `runRedactionCanary()`" },
  {
    // NOT produced by `pnpm demo`, and `clearOwned()` therefore does not list it either. A human
    // reviewer walked the live artifact through `crr probe` / `crr promote` / `crr verify`; the
    // directory's own README names a producer for every file it holds.
    prefix: "outcome-promotion/",
    producer:
      "a reviewer plus `crr` verbs, no model — that directory's README names a producer per file",
  },
  {
    prefix: "write-boundary/",
    producer:
      "`pnpm -F @crr/runtime exec tsx demo/write-boundary.ts`, no model — that directory's README names the scenarios",
  },
  {
    prefix: "semantic-denials/",
    producer:
      "`pnpm -F @crr/runtime exec tsx test/evidence/semantic-denials.ts`, no model",
  },
  {
    prefix: "handoff/",
    producer: "`pnpm -F @crr/runtime exec tsx demo/handoff.ts`, no model",
  },
  {
    prefix: "multi-tenant-overlay/",
    producer: "`pnpm -F @crr/runtime exec tsx demo/multi-tenant-overlay.ts`, no model",
  },
  {
    prefix: "terminal-survivors/",
    producer:
      "`pnpm -F @crr/conformance exec tsx test/evidence/terminal-survivors.ts`, no model",
  },
  {
    prefix: "replay-",
    producer: "`@crr/runtime` `replay()` over `@crr/surface-browser`, no model",
  },
];

function producerOf(file: string): string {
  return PRODUCERS.find((p) => file.startsWith(p.prefix))?.producer ?? "`pnpm demo`";
}

function writeManifest(): number {
  const files = walkEvidence().filter(
    (file) => file !== "MANIFEST.json" && !file.startsWith("redaction-canary/"),
  );
  writeJson(join(EVIDENCE, "MANIFEST.json"), {
    note: "Generated by `pnpm demo` for the current evidence tree. Excludes itself and `redaction-canary/`, which are written after it. Every entry names what produced it; only `discovery-live/` came from a live model run.",
    generatedAt: new Date().toISOString(),
    files: files.map((file) => {
      const bytes = readFileSync(join(EVIDENCE, file));
      return {
        path: file,
        bytes: bytes.length,
        sha256: sha256Bytes(bytes),
        producer: producerOf(file),
      };
    }),
  });
  return files.length;
}

function canarySecrets(): readonly CanarySecret[] {
  return [
    { label: "scenarios 01/03/04/05 + cli-replay / args.memberId", value: FIXTURE_MEMBER_ID },
    { label: "scenario 02 / args.memberId (absent member)", value: ABSENT_MEMBER_ID },
    { label: "masked-capture / initial deposit (sensitive fill)", value: CAPTURE_DEPOSIT },
  ];
}

function runCanary(): CanaryReport {
  const secrets = canarySecrets();
  const report = runRedactionCanary({ bundleDir: EVIDENCE, secrets });
  const dir = join(EVIDENCE, "redaction-canary");
  writeJson(join(dir, "report.json"), report);
  writeText(join(dir, "report.txt"), renderCanaryReport(report));
  writeText(
    join(dir, "README.md"),
    [
      "# redaction-canary",
      "",
      "`report.txt` and `report.json` are the output of `runRedactionCanary()` over this whole",
      "directory tree, run at the end of `pnpm demo`. It greps every byte that was written for every",
      "**parameter value** the runs were given, in fourteen encodings, and `pnpm demo` exits non-zero",
      "if it finds one.",
      "",
      "## Three properties that make it worth trusting",
      "",
      "1. **It proves it can fire, on every run.** Before scanning, it plants each needle in a",
      "   synthetic buffer and asserts the same matcher finds it. `self-test PASSED` in the report is",
      "   that check; a report whose self-test failed is `clean: false` no matter how few hits it",
      "   found. `packages/runtime/test/canary.test.ts` injects a real leak in each encoding.",
      "2. **The report never contains a value.** Hits carry a label and a context excerpt with every",
      "   known value blanked. This report is written into the bundle it just scanned — one that",
      "   quoted its own finding would be the leak.",
      "3. **Nothing is silently dropped.** A coincidental match inside a 40+ character hexadecimal run",
      "   (a sha256 digest) is listed under `suppressed` rather than deleted. That costs nothing: a",
      "   value genuinely hex-encoded into a blob is caught by the `hex-lower`/`hex-upper` needles.",
      "",
      "## What it covers, and what it cannot",
      "",
      "It scans **file contents, file names, and a PNG's inflated `tEXt`/`zTXt`/`iTXt` chunks**, and",
      "the `not searched` lines name every (value, encoding) pair for which no usable needle could be",
      "built, so the coverage claim is checkable rather than asserted. It",
      "cannot see through compression or encryption, so a screenshot's pixel stream is out of reach;",
      "the defence there is the mask, verified at the pixel in",
      "`packages/surface-browser/test/browser-capture.test.ts`.",
      "",
      "It searches for **parameter values** — the caller's inputs, which the taint model says must",
      "never be persisted. It deliberately does **not** search for screen-read outputs such as the",
      "member's name: the result contract exists to deliver those to the caller, and a check that",
      "flagged them would be checking the wrong thing.",
      "",
    ].join("\n"),
  );
  return report;
}

/**
 * The pass whose verdict is the exit code.
 *
 * Run after EVERY file is on disk, including the canary's own report, this bundle's `README.md` and
 * the finished `demo.log` - all three of which are written after the first pass and would otherwise
 * be the only files in the bundle nobody had scanned. Its output goes to the console and is
 * deliberately not written anywhere: a report of a scan that included the report is a file the scan
 * did not include, and that recursion has to stop somewhere. It stops here, with the whole bundle
 * covered and the exit code carrying the answer.
 */
function finalCanaryPass(): CanaryReport {
  return runRedactionCanary({ bundleDir: EVIDENCE, secrets: canarySecrets() });
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------

async function main(): Promise<number> {
  const startedAt = Date.now();
  log("capability-record-replay — evidence bundle");
  log("=========================================");
  log();
  log("No model API is contacted by this script and no credential is read. It starts");
  log("`fixtures/corebank-web` on an ephemeral loopback port and drives it with a local Chromium.");
  log();

  const chromium = chromiumPath();
  if (chromium === null || !existsSync(chromium)) {
    log("REFUSING TO PRODUCE A BUNDLE: no Chromium build was found.");
    log("  Run `pnpm -F @crr/surface-browser exec playwright install chromium` and try again.");
    log();
    log("This is deliberately fatal rather than a skip. A demo that quietly produced a smaller");
    log("bundle would be a demo whose output nobody could interpret.");
    return 1;
  }
  log(`chromium   ${chromium}`);
  log(`bundle     ${EVIDENCE}`);
  log();

  // ONE WRITER AT A TIME, and the reason is measured rather than theoretical. `clearOwned()` runs
  // once, at the start, and every blob is named by the digest of its own contents - so a second
  // demo starting while this one runs deletes nothing of ours and adds a second journal blob to
  // every scenario directory. Two concurrent runs against one bundle were made to do exactly that
  // in this tree: 8 stray files, both processes printing an inflated count and `DEMO OK`, both
  // exiting 0. The mitigation until now was a sentence in a design document asking the author to
  // run the demo alone; this is the same argument the control lease makes about human handoff,
  // applied to the script that produces the deliverable.
  const lock = acquireBundleLock(EVIDENCE);
  if (lock.ok) heldLock = lock.path;
  if (!lock.ok) {
    log("REFUSING TO PRODUCE A BUNDLE: another `pnpm demo` is writing this one.");
    log(`  bundle    ${EVIDENCE}`);
    log(`  held by   pid ${lock.holder.pid}, since ${lock.holder.at}`);
    log(`  lock      ${lock.path}`);
    log();
    log("Two demos writing one bundle interleave: each clears the directory at the start and then");
    log("adds its own content-addressed blobs, so the bundle ends up describing neither run. Wait");
    log("for the other one, or delete the lock file above if you are certain nothing is running.");
    return 1;
  }
  if (lock.tookOver !== null) {
    log(`lock       took over a stale lock from pid ${lock.tookOver.pid} (${lock.tookOver.at})`);
  }

  const suite = scenarios(FIXTURE_MEMBER_ID, ABSENT_MEMBER_ID);
  clearOwned(suite.map((s) => s.id));

  log("── artifact ─ the capability documents under replay");
  for (const line of writeArtifactExhibit()) log(`   ${line}`);
  log();

  const outcomes: ScenarioOutcome[] = [];
  for (const scenario of suite) outcomes.push(await runScenario(scenario));

  const capture = await maskedCapture();
  const cli = cliReplay();

  // LIVE-RUN-READINESS section 5.1. `PENDING.md` documents an EMPTY slot, and `pnpm discover --yes`
  // deletes it on success precisely so that a bundle never contains both a transcript and a note
  // saying there is no transcript. This script used to write it back unconditionally - and the
  // runner's own closing line tells you to run `pnpm demo` next, so the note came back every time.
  // The guard is the same one the MANIFEST row and the generated `evidence/README.md` already use.
  if (liveRunPresent()) {
    log("── discovery-live ─ a live run is present; PENDING.md not written");
    if (existsSync(join(EVIDENCE, "discovery-live", "PENDING.md"))) {
      log(
        "   WARNING: PENDING.md is still there beside a transcript. It says the slot is empty and",
      );
      log("   the transcript says it is not. `pnpm discover` removes it only on a run that fully");
      log(
        "   succeeded, so read that run's VERDICT block before treating this bundle as evidence.",
      );
    }
    log();
  } else {
    discoverySlot();
  }

  const claims = blobClaims(outcomes);
  const strays = auditBundleBlobs(claims);
  log("── integrity ─ every content-addressed blob directory against the run that owns it");
  if (strays.length === 0) {
    log(`   ${claims.length} blob directories checked, every file accounted for`);
  } else {
    for (const stray of strays) log(`   STRAY     ${stray}`);
    log("   A blob this run did not write is a blob from another run. Delete the bundle and run");
    log("   `pnpm demo` once, alone.");
  }
  log();

  // The log has to be on disk BEFORE the canary runs, or the one file most likely to hold a stray
  // value is the one file that is never scanned.
  writeText(join(EVIDENCE, "demo.log"), `${lines.join("\n")}\n`);
  const fileCount = writeManifest();
  const report = runCanary();

  const failures = outcomes.filter((o) => o.complaints.length > 0);

  const summary: string[] = [];
  summary.push("── summary");
  for (const outcome of outcomes) {
    summary.push(
      `   ${outcome.complaints.length === 0 ? "PASS" : "FAIL"}  ${outcome.scenario.id.padEnd(34)} ${(outcome.result?.status ?? "threw").padEnd(9)} ${outcome.scenario.taxonomy}`,
    );
  }
  summary.push(
    `   ${capture.ok ? "PASS" : "FAIL"}  masked-capture${" ".repeat(21)}${capture.summary}`,
  );
  summary.push(`   ${cli.ok ? "PASS" : "FAIL"}  cli-replay${" ".repeat(25)}${cli.summary}`);
  summary.push("");
  summary.push(renderCanaryReport(report).trimEnd());
  summary.push("");
  // THE PRINTED COUNT IS THE ONE A REVIEWER CHECKS, so it is derived twice and the two are
  // compared. `writeManifest()` counts the files it listed; the five it excludes are itself,
  // `README.md` and the three under `redaction-canary/`, all written after it. The whole-bundle
  // canary pass below walks the finished directory independently, and `countMismatch` is non-empty
  // if those two ever disagree - which is how an off-by-five in this line would announce itself
  // instead of being quoted into three documents.
  const claimedFiles = fileCount + 5;
  summary.push(
    `   ${claimedFiles} files in the bundle, produced in ${Math.round((Date.now() - startedAt) / 100) / 10}s`,
  );
  summary.push(
    liveRunPresent()
      ? "   discovery-live/  a LIVE model run is present - see its own README.md and provenance.json"
      : "   discovery-live/  EMPTY - a live model run, pending the author's approval",
  );
  summary.push(
    "   A SECOND, WHOLE-BUNDLE canary pass runs after this file is written - covering this log,",
  );
  summary.push(
    "   evidence/README.md and the canary's own report - and ITS verdict is the exit code.",
  );
  for (const line of summary) log(line);

  // Every file on disk, in this order, so the final pass has every byte in the bundle to look at.
  writeText(join(EVIDENCE, "demo.log"), `${lines.join("\n")}\n`);
  writeText(join(EVIDENCE, "README.md"), bundleReadme(outcomes, report, capture.ok, cli.ok));
  const final = finalCanaryPass();
  const onDisk = walkEvidence().length;
  const countAgrees = claimedFiles === onDisk && onDisk === final.filesScanned;
  const ok =
    failures.length === 0 &&
    report.clean &&
    final.clean &&
    capture.ok &&
    cli.ok &&
    strays.length === 0 &&
    countAgrees;
  process.stdout.write(
    `\n   whole-bundle canary pass: ${final.clean ? "CLEAN" : "FAILED"} - ${final.filesScanned} files, ${final.hits.length} hits\n`,
  );
  if (strays.length > 0) {
    process.stdout.write(`   BUNDLE INTEGRITY FAILED - ${strays.length} stray blob(s)\n`);
    for (const stray of strays) process.stdout.write(`     STRAY ${stray}\n`);
  }
  if (!countAgrees) {
    process.stdout.write(
      `   FILE COUNT DISAGREES - printed ${claimedFiles}, on disk ${onDisk}, scanned ${final.filesScanned}\n`,
    );
  }
  for (const hit of final.hits) {
    process.stdout.write(
      `     LEAK ${hit.file}${hit.line === null ? "" : `:${hit.line}`}  ${hit.secret} as ${hit.encoding}\n`,
    );
  }
  process.stdout.write(`${ok ? "DEMO OK" : "DEMO FAILED"}\n`);
  return ok ? 0 : 1;
}

function bundleReadme(
  outcomes: readonly ScenarioOutcome[],
  report: CanaryReport,
  captureOk: boolean,
  cliOk: boolean,
): string {
  const rows = outcomes.map(
    (o) =>
      `| [\`${o.scenario.id}/\`](${o.scenario.id}/) | ${o.scenario.taxonomy} | \`${o.result?.status ?? "threw"}\` | ${o.scenario.title} |`,
  );
  return [
    "# `/evidence` — what was actually run, and what was not",
    "",
    "This directory now has two kinds of evidence. The main replay bundle is produced by `pnpm demo`,",
    "on a laptop, with no live service of any kind. Supplemental exhibits are produced by their own",
    "commands and describe themselves in their own `README.md` files. `discovery-live/` is the one",
    "model-produced directory when present;",
    "everything else is deterministic replay, verification, conformance, or promotion work.",
    "",
    "**All data is synthetic.** `fixtures/corebank-web` is a purpose-built hostile back office; the",
    "members, balances and account numbers in it exist nowhere else and are marked `(SYNTHETIC)` on",
    "the screens themselves. No real PII and no real credential appears in this repository.",
    "",
    ...(liveRunPresent()
      ? [
          "## The live discovery run",
          "",
          "[`discovery-live/`](discovery-live/) holds a real one, produced by `pnpm discover --yes`.",
          "It is the only thing in this bundle a model produced; read its own `README.md` and",
          "`provenance.json` for the adapter, the model id, the measured token usage and the measured",
          "spend. Everything else below is a **replay**, which is the half that runs in production",
          "with no model in the decision path.",
          "",
        ]
      : [
          "## The one thing that is missing, said first",
          "",
          "[`discovery-live/`](discovery-live/) **is empty.** It is the slot for the live discovery run —",
          "the model-in-the-loop half of the system — and it is empty because a discovery run costs the",
          "author money and no agent working on this repository is permitted to spend it. The mechanism",
          "is built and tested and `pnpm discover --dry-run` rehearses all of it for free; the run",
          "itself is the author's to initiate. See",
          "[`discovery-live/PENDING.md`](discovery-live/PENDING.md) for exactly what will land there and",
          "what may never be put there in its place.",
          "",
          "Nothing in this bundle claims a model discovered anything. Every run below is a **replay**,",
          "which is the half that runs in production with no model in the decision path.",
          "",
        ]),
    "## Provenance — which adapter produced what",
    "",
    "| Directory | Produced by | Model |",
    "|---|---|---|",
    "| [`artifact/`](artifact/) | hand-authored for build unit 11's acceptance test | **none** |",
    "| `replay-0*/` | `@crr/runtime` `replay()` over `@crr/surface-browser` | **none — no model is in the decision path of a replay, by design** |",
    "| [`cli-replay/`](cli-replay/) | the shipped `crr` binary | **none** |",
    "| [`masked-capture/`](masked-capture/) | `@crr/surface-browser` `capture()` | **none** |",
    "| [`redaction-canary/`](redaction-canary/) | `@crr/runtime` `runRedactionCanary()` | **none** |",
    ...(existsSync(join(EVIDENCE, "outcome-promotion"))
      ? [
          "| [`outcome-promotion/`](outcome-promotion/) | a reviewer walking the live artifact through `crr probe` / `crr promote` / `crr verify` | **none — the two documents it starts from came from the live run; nothing else here did** |",
        ]
      : []),
    ...(existsSync(join(EVIDENCE, "write-boundary"))
      ? [
          "| [`write-boundary/`](write-boundary/) | `pnpm -F @crr/runtime exec tsx demo/write-boundary.ts` | **none** |",
        ]
      : []),
    ...(existsSync(join(EVIDENCE, "semantic-denials"))
      ? [
          "| [`semantic-denials/`](semantic-denials/) | `pnpm -F @crr/runtime exec tsx test/evidence/semantic-denials.ts` | **none** |",
        ]
      : []),
    ...(existsSync(join(EVIDENCE, "handoff"))
      ? [
          "| [`handoff/`](handoff/) | `pnpm -F @crr/runtime exec tsx demo/handoff.ts` | **none** |",
        ]
      : []),
    ...(existsSync(join(EVIDENCE, "multi-tenant-overlay"))
      ? [
          "| [`multi-tenant-overlay/`](multi-tenant-overlay/) | `pnpm -F @crr/runtime exec tsx demo/multi-tenant-overlay.ts` | **none** |",
        ]
      : []),
    ...(existsSync(join(EVIDENCE, "terminal-survivors"))
      ? [
          "| [`terminal-survivors/`](terminal-survivors/) | `pnpm -F @crr/conformance exec tsx test/evidence/terminal-survivors.ts` | **none** |",
        ]
      : []),
    liveRunPresent()
      ? "| [`discovery-live/`](discovery-live/) | `pnpm discover` — the `anthropic` adapter against the Messages API | see `discovery-live/provenance.json` |"
      : "| [`discovery-live/`](discovery-live/) | *pending* — will be `pnpm discover` over the `anthropic` adapter | *pending* |",
    "",
    "### About `artifact/`",
    "",
    "`artifact/artifact.json` was **hand-authored**, not synthesized from a discovery run, and its",
    "`provenance.model.adapter` says `replay` with a model id of `none:hand-authored-for-unit-11`",
    'because that enum has no honest value for "a person wrote this". Every matcher in it was derived',
    "from a real `perceive()` over the fixture through `@crr/surface-browser` — none of it was written",
    "by reading the fixture's HTML — but a model did not produce it and this bundle does not pretend",
    "one did.",
    "",
    ...(liveRunPresent()
      ? [
          "This paragraph used to end by predicting its own deletion — *when the live discovery run",
          "happens, the artifact synthesis emits replaces this one*. The run has happened and it did",
          "not replace it, on purpose. A synthesized artifact is the **output** of a run and moves",
          "whenever the run is repeated; the suite that polices this bundle needs an input it can pin.",
          "So there are two synthesized artifacts and neither is presented as this one. The live run's",
          "is committed beside its recording at",
          "[`discovery-live/synthesized/artifact.json`](discovery-live/synthesized/artifact.json) and",
          "was replayed by that run itself, with the model out of the loop, at",
          "[`discovery-live/verification.json`](discovery-live/verification.json). A second, frozen one",
          "lives at `packages/discovery/test/fixtures/corebank-web.capability.json`, and",
          "`packages/runtime/test/synthesized-replay.test.ts` reads it off disk as data and replays it",
          "against this same fixture on every `pnpm test` — which is the claim a reviewer can rerun.",
        ]
      : [
          "When the live discovery run happens, the artifact that synthesis emits will be committed",
          "beside its recording under `discovery-live/synthesized/`; this hand-authored one stays,",
          "because the acceptance suite needs an input it can pin.",
        ]),
    "",
    "The ed25519 approval key pair is generated per process, so `approver.spki.pem` and the signature",
    "inside `artifact.json` differ on every demo run. The **digest** they sign does not: it is over",
    "the JCS form of the document with `lifecycle` excluded, which is what makes an approved artifact",
    "uneditable.",
    "",
    "## The runs",
    "",
    "| Directory | Taxonomy | Arm | What happened |",
    "|---|---|---|---|",
    ...rows,
    `| [\`masked-capture/\`](masked-capture/) | safety | ${captureOk ? "masked" : "FAILED"} | a screenshot region bound to a sensitive parameter, blanked before the bytes left the driver |`,
    `| [\`cli-replay/\`](cli-replay/) | reproducibility | ${cliOk ? "exit 0" : "FAILED"} | the same replay through the shipped \`crr\` command, so a reviewer can run it verbatim |`,
    "",
    "Four of the five replays hit an exceptional state, and they are exceptional in three different",
    "ways — an expected business outcome, a recoverable condition, and two hard failures. That split",
    "is the product: `MEMBER_NOT_FOUND` is a typed **answer** the caller acts on, an interstitial is a",
    "**bounded, budgeted, reported** remedy, and an application error page is a **stop** that names the",
    "step, the expectation and the observation.",
    "",
    "Each scenario directory holds `result.json` (what the calling agent receives), `journal.jsonl`",
    "(the structured journal, written as the run happened), `run.log` (that scenario's console",
    "output) and `observations/` — the run's evidence sink, holding content-addressed frozen",
    "`Observation`s (each already through `redactObservation`) plus the journal blob the run's",
    "`journalRef` points at. A green run freezes no observation, because these steps declare",
    '`captureOn: ["failure"]`; the two hard failures each freeze the screen that failed, and that',
    "file is a `classify()` unit test with no reproduction step attached to it.",
    "",
    "## What the main `pnpm demo` bundle does not contain",
    "",
    "`pnpm demo` is still the read/replay bundle. It does not post a sub-account, and it does not arm",
    "commit-route permission faults. Those are covered by supplemental exhibits instead:",
    "",
    "- `write-boundary/` covers approval refusal, dry-run boundary reporting, valid approval,",
    "  rejected approvals, policy refusal, idempotency repeat, and effect-in-doubt.",
    "- `semantic-denials/` covers record-denial business outcome vs role-denial entitlement failure",
    "  against the browser write fixture.",
    "- `handoff/` covers suspend, intervention context, same-session lease claim, policy-checked",
    "  human action, safe handback and refused handback.",
    "- `multi-tenant-overlay/` covers one base browser artifact running at a second tenant through",
    "  overlay-only vocabulary, route and wait-budget changes, plus a no-overlay negative control.",
    "- `terminal-survivors/` covers the green-screen mutant survivor ledger.",
    "",
    "`pnpm demo` includes these supplemental directories when they already exist; the commands",
    "above regenerate them explicitly.",
    "",
    "## The redaction canary",
    "",
    "`pnpm demo` finishes by grepping this entire directory for **every parameter value the runs",
    "were given**, in fourteen encodings — the literal, UTF-16LE, JSON `\\uXXXX`, percent-encoded,",
    "HTML entities, hex, and base64 at all three byte alignments — plus the inflated text chunks of",
    "any PNG, and every file NAME.",
    "",
    "Where a needle could not be built it says so rather than omitting it: a five-digit member number",
    "is eight base64 characters, of which only three to five are independent of the value's byte",
    "alignment, which is too few to tell from noise. Those pairs are listed under `not searched` in",
    "[`redaction-canary/report.txt`](redaction-canary/report.txt). An encoding that was never searched",
    "for is not coverage, and a report that quietly dropped it would be claiming more than it checked.",
    "",
    `Result of the run that produced the main demo bundle: **${report.clean ? "CLEAN" : "FAILED"}** — ${report.filesScanned} files, ${report.bytesScanned} bytes, ${report.needles} distinct needles, ${report.hits.length} hits, ${report.forbidden.length} credential-shaped strings, self-test ${report.selfTest.ok ? "passed" : "FAILED"} (${report.selfTest.found}/${report.selfTest.planted}).`,
    "",
    "The supplemental write, semantic-denial, handoff and multi-tenant overlay exhibits also write",
    "canary summaries for the sensitive values they use. `terminal-survivors/` contains only",
    "scenario and mutant names, not caller inputs.",
    "",
    "That report covers every file that existed when it ran. This `README.md`, the report itself and",
    "the finished `demo.log` are written afterwards, so a **second whole-bundle pass** runs once every",
    "byte is on disk and **its** verdict is `pnpm demo`'s exit code. Its output is on the console and",
    "in no file, because a report of a scan that included the report is a file the scan did not",
    "include — the recursion has to stop somewhere, and it stops with the whole bundle covered.",
    "",
    "A committed bundle is therefore one where both passes were clean. See",
    "[`redaction-canary/`](redaction-canary/) for how the canary proves it can fail, and for the two",
    "things it cannot check.",
    "",
    "## Reproducing this",
    "",
    "```",
    "pnpm install",
    "pnpm -F @crr/surface-browser exec playwright install chromium   # once",
    "pnpm demo",
    "pnpm -F @crr/runtime exec tsx demo/write-boundary.ts",
    "pnpm -F @crr/runtime exec tsx test/evidence/semantic-denials.ts",
    "pnpm -F @crr/runtime exec tsx demo/handoff.ts",
    "pnpm -F @crr/runtime exec tsx demo/multi-tenant-overlay.ts",
    "pnpm -F @crr/conformance exec tsx test/evidence/terminal-survivors.ts",
    "```",
    "",
    "`pnpm demo` deletes and rewrites only the directories it owns; the supplemental evidence",
    "commands rewrite their own directories.",
    "",
  ].join("\n");
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `demo: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  // Released here rather than in a `finally` inside `main()` so that it covers the throw as well as
  // every return, including the early one that never took it - `releaseBundleLock` reads the file
  // first and refuses to remove a lock this process does not hold. A run killed outright leaves the
  // file behind on purpose: the next run finds the pid gone and takes it over.
  .finally(() => {
    if (heldLock !== null) releaseBundleLock(heldLock);
  });
