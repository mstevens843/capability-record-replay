#!/usr/bin/env node
// `crr` - the command line the reviewer runs.
//
// Seven verbs, and the split between them is the architecture rather than convenience:
//
//   crr show    <artifact>                  reads a document. No surface, no session, no I/O but a
//                                           file read.
//   crr link    <contract> <artifact>       runs all 29 checks and performs ZERO ACTIONS. That is
//                                           the whole value: an artifact can be rejected, with a
//                                           numbered reason, before anything is launched.
//   crr verify  <contract> <artifact>       replays a PROPOSED artifact with the model out of the
//                                           loop and, only if that succeeds, writes the `draft`.
//   crr approve <artifact>                  signs the digest of a verified draft. The approver has
//                                           to tick the grade and the effect classes by hand.
//   crr replay  <contract> <artifact>       links, brokers a session, runs the program, prints one
//                                           of four arms.
//   crr probe   <contract> <artifact>       `replay` with `--capture-every`: freezes an observation
//                                           at EVERY step whatever the steps declare, and prints a
//                                           step-to-digest table. Changes no decision and spends no
//                                           budget - it exists because a green run normally freezes
//                                           nothing, so the one screen an outcome promotion cannot
//                                           do without is the one nobody has.
//   crr promote <contract> <artifact>       runs the discrimination proof over a frozen corpus and,
//                                           only if it returns `discriminates` at every named
//                                           tenant, emits contract@vN+1 and artifact@vN+1
//                                           (proposed). `--dry-run` prints and writes nothing.
//
// `probe` and `promote` are two commands rather than one for the same reason `verify` and `approve`
// are: the first spends a session and establishes facts, the second is a document operation that
// reads them. And `promote` deliberately stops at `proposed`: the second gate is the live
// verification replay, because `classify.ts` evaluates declared outcomes BEFORE the checkpoint, so
// adding a detector changes the meaning of every SUCCESSFUL run through that step.
//
// `verify` and `approve` are two commands rather than one on purpose: the first is a machine
// establishing a fact and the second is a PERSON accepting a risk, and a single `--yes` flag that
// did both would be the exact collapse SPEC section 12.3's twelfth accepted limit warns about.
//
// THE DRIVER IS A PARAMETER, NOT A DEPENDENCY. `--surface <module>` names a module that default-
// exports a factory returning a `Surface`. `@crr/runtime` therefore does not depend on Playwright,
// on a pty, or on anything that knows what a pixel is - which is the same claim the package makes
// about itself everywhere else, made checkable by the fact that this file compiles without them.
// `examples/` ships the browser factory; a green-screen one drops in beside it unchanged.
//
// NOTHING HERE REACHES A MODEL. `crr` has no discovery verb: recording is `@crr/discovery`'s and
// requires a provider key. Replay is the path a reviewer can run with no credentials at all, which
// is the point of the whole design.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  type Allowlist,
  type CapabilityArtifact,
  type CapabilityContract,
  type CapabilityOverlay,
  type JournalEvent,
  LINK_CHECK_COUNT,
  MOCK_SURFACE_CAPABILITIES,
  type Surface,
  link,
  parseArtifact,
  parseContract,
  parseOverlay,
  renderTarget,
} from "@crr/core";
import { ed25519Signer, ed25519Trust, unverifiedTrust } from "./approval.js";
import { FileEvidenceSink } from "./evidence.js";
import { FileJournal } from "./journal.js";
import { LifecycleError, approve, unprovenOutcomesOf } from "./lifecycle.js";
import { type PromotionEvent, type PromotionReport, confirmProbe, promote } from "./promote.js";
import { replay } from "./replay.js";
import { StaticSessionBroker } from "./session.js";
import { type VerificationMode, type VerificationReport, verifyAndDraft } from "./verify.js";

const USAGE = `crr - deterministic replay of a recorded capability

  crr show    <artifact.json>
  crr link    <contract.json> <artifact.json> [options]
  crr verify  <contract.json> <artifact.json> --surface <module> [options]
  crr approve <artifact.json> --sign-key <keyId>:<privateKey.pem> --approver <id>
                            --ack-grade <grade> --ack-effects <a,b> [--out <file>]
  crr replay  <contract.json> <artifact.json> --surface <module> [options]
  crr probe   <contract.json> <artifact.json> --surface <module> --evidence <dir> [options]
  crr promote <contract.json> <artifact.json> --review <promotion.json> --corpus <dir>
                            [--corpus <dir>...] [--tenant <id>...] [--dry-run] [--out-dir <dir>]
  crr promote --confirm <artifact.json> --code <OUTCOME> --result <result.json> [--out <file>]

Options
  --overlay <file>        per-tenant overlay document
  --args <json>           the caller's arguments, e.g. '{"memberId":"10041"}'
  --tenant <id>           tenant id                       (default: riverbend)
  --app <id>              app instance id                 (default: <tenant>-fixture)
  --allowlist <file>      policy allowlist json           (default: derived from the artifact)
  --trusted-key <id:file> an approver key id and its public key file (repeatable)
  --insecure-trust        accept any well-formed approval WITHOUT verifying the signature
  --journal <file>        write the journal as JSONL
  --evidence <dir>        write frozen observations here
  --surface <module>      a module default-exporting () => Promise<{ surface, close? }>
  --json                  print the result document and nothing else
  --mode <m>              verify only: replay-full | replay-dry | replay-reset
  --out <file>            verify/approve: where to write the resulting document
  --sign-key <id:file>    approve only: the approver's key id and its PKCS8 private key file
  --approver <id>         approve only: the approver's identity handle
  --ack-grade <grade>     approve only: full | partial-up-to-irreversible - TICKED BY A HUMAN
  --ack-effects <list>    approve only: comma-separated effect classes the approver accepts
  --ack-promotions <list> approve only: comma-separated reviewer-authored outcome codes - TICKED
                          BY A HUMAN, refused on mismatch in both directions
  --review <file>         promote only: the reviewer's promotion.json
  --corpus <dir>          promote only: an evidence bundle (journal.jsonl + observations/), repeatable
  --dry-run               promote only: run the proof, print the table, write nothing
  --out-dir <dir>         promote only: where contract/artifact/the archived review are written
  --confirm               promote only: stamp probeConfirmed from a probe result
  --code <OUTCOME>        promote --confirm: which promoted outcome the result confirms
  --result <file>         promote --confirm: the replay result document the probe produced

Every path is resolved against the current directory. No verb here contacts a model.
`;

type Json = Record<string, unknown>;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

/**
 * A last-resort allowlist derived from the artifact's own declarations.
 *
 * Deliberately NOT the same thing as a deployment's allowlist, and the difference matters: a
 * program that authorizes itself is not authorized. This exists so `crr replay` is runnable against
 * a fixture with one flag, and it says so on the way past; a real deployment passes `--allowlist`
 * and the two are compared by check 26.
 */
function allowlistFromArtifact(artifact: CapabilityArtifact): Allowlist {
  return {
    originAliases: [...artifact.policy.originAliases],
    routes: artifact.flow.routes.map((route) => ({
      originAlias: route.originAlias,
      pathPattern: route.path,
      maxEffect: artifact.policy.maxEffect,
    })),
    actionKinds: [
      "click",
      "type",
      "select",
      "setChecked",
      "pressKey",
      "focus",
      "navigate",
      "acceptDialog",
      "dismissDialog",
    ],
    maxEffect: artifact.policy.maxEffect,
    discoveryMaxEffect: "READ",
  };
}

interface SurfaceFactoryResult {
  readonly surface: Surface;
  close?(): Promise<void>;
}

async function loadSurface(spec: string): Promise<SurfaceFactoryResult> {
  const module = (await import(pathToFileURL(resolve(spec)).href)) as {
    default?: () => Promise<SurfaceFactoryResult>;
    openSurface?: () => Promise<SurfaceFactoryResult>;
  };
  const factory = module.default ?? module.openSurface;
  if (typeof factory !== "function") {
    throw new Error(`${spec} exports neither a default function nor \`openSurface\``);
  }
  return factory();
}

export async function main(argv: readonly string[]): Promise<number> {
  const [verb, ...rest] = argv;
  if (verb === undefined || verb === "--help" || verb === "-h" || verb === "help") {
    process.stdout.write(USAGE);
    return verb === undefined ? 1 : 0;
  }

  const { values, positionals } = parseArgs({
    args: [...rest],
    allowPositionals: true,
    options: {
      overlay: { type: "string" },
      args: { type: "string" },
      tenant: { type: "string" },
      app: { type: "string" },
      allowlist: { type: "string" },
      "trusted-key": { type: "string", multiple: true },
      "insecure-trust": { type: "boolean" },
      journal: { type: "string" },
      evidence: { type: "string" },
      surface: { type: "string" },
      json: { type: "boolean" },
      mode: { type: "string" },
      out: { type: "string" },
      "sign-key": { type: "string" },
      approver: { type: "string" },
      "ack-grade": { type: "string" },
      "ack-effects": { type: "string" },
      "ack-promotions": { type: "string" },
      review: { type: "string" },
      corpus: { type: "string", multiple: true },
      "dry-run": { type: "boolean" },
      "out-dir": { type: "string" },
      confirm: { type: "boolean" },
      code: { type: "string" },
      result: { type: "string" },
      "capture-every": { type: "boolean" },
    },
  });

  // The verb is validated BEFORE any document is read. A `crr nonsense` that reports "a contract
  // path is required" has told the user about the wrong mistake.
  if (
    verb !== "show" &&
    verb !== "link" &&
    verb !== "replay" &&
    verb !== "verify" &&
    verb !== "approve" &&
    verb !== "probe" &&
    verb !== "promote"
  ) {
    process.stderr.write(`unknown verb "${verb}"\n\n${USAGE}`);
    return 1;
  }

  if (verb === "show") {
    const artifact = parseArtifact(readJson(expect(positionals[0], "an artifact path")));
    process.stdout.write(describeArtifact(artifact));
    return 0;
  }

  // `approve` takes no contract and touches no surface: it is a document operation and a human
  // decision, and giving it the same argument shape as `replay` would suggest otherwise.
  if (verb === "approve") {
    const draft = parseArtifact(readJson(expect(positionals[0], "an artifact path")));
    const keySpec = expect(values["sign-key"], "--sign-key <keyId>:<privateKey.pem>");
    const at = keySpec.indexOf(":");
    if (at < 1) throw new Error(`--sign-key takes <keyId>:<privateKeyFile>, got "${keySpec}"`);
    try {
      const approved = approve(draft, {
        signer: ed25519Signer(
          keySpec.slice(0, at),
          readFileSync(resolve(keySpec.slice(at + 1)), "utf8"),
        ),
        approvedBy: expect(values.approver, "--approver <id>"),
        approvedAt: new Date().toISOString() as never,
        acknowledgedGrade: expect(values["ack-grade"], "--ack-grade <grade>") as never,
        acknowledgedEffects: expect(values["ack-effects"], "--ack-effects <list>")
          .split(",")
          .map((e) => e.trim()) as never,
        acknowledgedPromotions: (values["ack-promotions"] ?? "")
          .split(",")
          .map((c) => c.trim())
          .filter((c) => c.length > 0),
      });
      const out = values.out ?? resolve(positionals[0] as string);
      writeFileSync(out, `${JSON.stringify(approved, null, 2)}\n`);
      process.stdout.write(
        [
          `APPROVED  ${approved.artifactId}@${approved.version}`,
          `  digest    ${approved.digest}`,
          `  signed by ${approved.lifecycle.approval?.approvedBy ?? "?"}`,
          `  grade     ${approved.verification.grade} (${approved.verification.mode}, covered through ${approved.verification.coveredThroughStep})`,
          `${describePromotions(approved)}  written   ${out}\n`,
        ].join("\n"),
      );
      return 0;
    } catch (error) {
      if (!(error instanceof LifecycleError)) throw error;
      process.stdout.write("APPROVAL REFUSED\n");
      for (const reason of error.reasons) process.stdout.write(`  ${reason}\n`);
      return 1;
    }
  }

  // `promote --confirm` stamps a receipt from a probe result. A document operation like `approve`,
  // so it takes an artifact and no contract - and it is EVIDENCE rather than a gate, which is why it
  // is a separate invocation a person may simply never make.
  if (verb === "promote" && values.confirm === true) {
    const artifact = parseArtifact(readJson(expect(positionals[0], "an artifact path")));
    const code = expect(values.code, "--code <OUTCOME>");
    const result = readJson(expect(values.result, "--result <file>")) as {
      status: string;
      outcome?: unknown;
    };
    const confirmed = confirmProbe(artifact, code, result);
    if (confirmed.artifact === null) {
      process.stdout.write(`CONFIRMATION REFUSED\n  ${confirmed.reason}\n`);
      return 1;
    }
    const out = values.out ?? resolve(positionals[0] as string);
    writeFileSync(out, `${JSON.stringify(confirmed.artifact, null, 2)}\n`);
    process.stdout.write(
      `CONFIRMED  ${code}\n  why      ${confirmed.reason}\n  digest   ${confirmed.artifact.digest}\n  written  ${out}\n`,
    );
    return 0;
  }

  const contract: CapabilityContract = parseContract(
    readJson(expect(positionals[0], "a contract path")),
  );
  const artifact: CapabilityArtifact = parseArtifact(
    readJson(expect(positionals[1], "an artifact path")),
  );
  const overlay: CapabilityOverlay | null =
    values.overlay === undefined ? null : parseOverlay(readJson(values.overlay));
  const args = values.args === undefined ? {} : (JSON.parse(values.args) as Json);
  const allowlist =
    values.allowlist === undefined
      ? allowlistFromArtifact(artifact)
      : (readJson(values.allowlist) as Allowlist);
  const trust = values["insecure-trust"]
    ? unverifiedTrust(trustedKeyIds(values["trusted-key"] ?? [], artifact))
    : ed25519Trust(
        (values["trusted-key"] ?? []).map((entry) => {
          const at = entry.indexOf(":");
          if (at < 1)
            throw new Error(`--trusted-key takes <keyId>:<publicKeyFile>, got "${entry}"`);
          return {
            keyId: entry.slice(0, at),
            publicKey: readFileSync(resolve(entry.slice(at + 1)), "utf8"),
          };
        }),
      );

  if (verb === "link") {
    const result = link({
      contract,
      artifact,
      overlay,
      capabilities: MOCK_SURFACE_CAPABILITIES,
      args,
      mode: "replay",
      // `--tenant`, with the same default every other verb uses. It was omitted here until a
      // promoted artifact was linked for the first time, and the omission was not cosmetic: check
      // 29's tenant clause refuses a reviewer-authored outcome whose proof does not name THIS
      // tenant, and a link that names no tenant can never satisfy it. `crr link` therefore refused
      // every artifact carrying a promotion, at every tenant, including the one it was proven at.
      tenant: values.tenant ?? "riverbend",
      allowlist,
      trust,
    });
    if (result.ok) {
      process.stdout.write(
        `link ok - ${result.program.steps.length} steps, ${LINK_CHECK_COUNT} checks, effective digest ${result.program.effectiveDigest}\n${describeOrigins(artifact)}`,
      );
      return 0;
    }
    process.stdout.write(`link REFUSED (${result.failure})\n`);
    for (const error of result.errors) {
      process.stdout.write(`  check ${error.check} ${error.code}: ${error.message}\n`);
    }
    return 1;
  }

  // `promote` reaches no model and touches no surface. The whole promotion path runs with zero
  // credentials, which is the same property the rest of the replay path already has - so it sits
  // above the point where a driver is loaded.
  if (verb === "promote") {
    const tenants = (values.tenant ?? "riverbend")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .map((tenantId) => ({ tenantId, overlay }));
    const dryRun = values["dry-run"] === true;
    const outDir = values["out-dir"] ?? ".";
    const report = promote(
      {
        contract,
        artifact,
        review: readJson(expect(values.review, "--review <promotion.json>")),
        corpusDirs: (values.corpus ?? []).map((dir) => resolve(dir)),
        tenants,
        args,
        // A dry run archives nothing, because archiving a review whose proof was never accepted
        // would leave a document in `evidence/promotions/` that no receipt points at.
        archiveDir: dryRun ? null : join(resolve(outDir), "promotions"),
      },
      { onEvent: (event) => process.stdout.write(`  ${describePromotionEvent(event)}\n`) },
    );
    process.stdout.write(describePromotion(report));
    if (!report.ok || report.documents === null) return 1;
    if (dryRun) {
      process.stdout.write("  DRY RUN - nothing was written\n");
      return 0;
    }
    const contractOut = join(resolve(outDir), "contract.json");
    const artifactOut = join(resolve(outDir), "artifact.json");
    mkdirSync(resolve(outDir), { recursive: true });
    writeFileSync(contractOut, `${JSON.stringify(report.documents.contract, null, 2)}\n`);
    writeFileSync(artifactOut, `${JSON.stringify(report.documents.artifact, null, 2)}\n`);
    process.stdout.write(
      [
        `  written   ${contractOut}`,
        `  written   ${artifactOut}`,
        `  NEXT      crr verify ${contractOut} ${artifactOut} --surface <module>`,
        "            v2 is PROPOSED. The happy path has not been replayed against the new detector,",
        "            and a detector that hijacks it fails that replay closed.\n",
      ].join("\n"),
    );
    return 0;
  }

  const opened = await loadSurface(expect(values.surface, "--surface <module>"));
  const tenantId = values.tenant ?? "riverbend";
  const tenant = { tenantId, appInstanceId: values.app ?? `${tenantId}-fixture` };
  try {
    // `verify` is the gate the whole lifecycle hangs off: it replays the PROPOSED artifact with no
    // model anywhere and writes a `draft` only if that run succeeded. A refusal writes nothing,
    // which is the entire content of "recording is not a claim until it replays".
    if (verb === "verify") {
      const { report, artifact: draft } = await verifyAndDraft({
        contract,
        artifact,
        overlay,
        args,
        tenant,
        allowlist,
        broker: new StaticSessionBroker(opened.surface, { onRefresh: async () => "refreshed" }),
        ...(values.mode === undefined ? {} : { mode: values.mode as VerificationMode }),
        ...(values.evidence === undefined
          ? {}
          : { evidence: new FileEvidenceSink(values.evidence) }),
        ...(values.journal === undefined
          ? {}
          : {
              journal: (runId, clock) =>
                new FileJournal({ runId, clock, path: values.journal as string }),
            }),
      });
      if (draft !== null) {
        const out = values.out ?? resolve(positionals[1] as string);
        writeFileSync(out, `${JSON.stringify(draft, null, 2)}\n`);
        process.stdout.write(`${describeVerification(report)}  written   ${out}\n`);
        return 0;
      }
      process.stdout.write(describeVerification(report));
      return 1;
    }

    const { result, journal } = await replay({
      contract,
      artifact,
      overlay,
      args,
      tenant,
      allowlist,
      broker: new StaticSessionBroker(opened.surface, { onRefresh: async () => "refreshed" }),
      trust,
      // THE ONLY DIFFERENCE BETWEEN `probe` AND `replay`. It is a runtime option, not an artifact
      // edit: `evidence.captureOn` lives inside the digest an approval signs, and overriding it from
      // a command line must not move the program's content address. It does not, because nothing
      // here touches the document - the probe's `effectiveDigest` is the one an ordinary replay
      // would produce, and only the number of files on disk differs.
      ...(verb === "probe" ? { captureEvery: true } : {}),
      ...(values.evidence === undefined ? {} : { evidence: new FileEvidenceSink(values.evidence) }),
      ...(values.journal === undefined
        ? {}
        : {
            journal: (runId, clock) =>
              new FileJournal({ runId, clock, path: values.journal as string }),
          }),
    });

    if (verb === "probe") {
      process.stdout.write(describeResult(result));
      process.stdout.write(describeCaptures(journal.events));
      return result.status === "ok" ? 0 : result.status === "outcome" ? 2 : 1;
    }

    if (values.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(describeResult(result));
    }
    // The exit code follows the ARM, and an outcome is not an error. `2` for a business outcome so
    // a shell script can tell "the member is not on file" from "the run broke", which is the same
    // distinction the result type makes for a calling agent.
    return result.status === "ok" ? 0 : result.status === "outcome" ? 2 : 1;
  } finally {
    await opened.close?.();
  }
}

function describeVerification(report: VerificationReport): string {
  const lines = [
    `${report.status.toUpperCase()}  ${report.mode}  grade ${report.grade ?? "none"}`,
    `  covered   ${report.coveredThroughStep ?? "nothing"}`,
  ];
  if (report.stoppedBeforeStep !== null) {
    lines.push(
      `  stopped   before ${report.stoppedBeforeStep} - the irreversible action was NOT dispatched`,
    );
  }
  if (report.reset !== null) {
    lines.push(`  reset     ${report.reset.id}: ${report.reset.before} / ${report.reset.after}`);
  }
  lines.push(`  why       ${report.reason}`);
  return `${lines.join("\n")}\n`;
}

function trustedKeyIds(
  entries: readonly string[],
  artifact: CapabilityArtifact,
): readonly string[] {
  if (entries.length > 0) return entries.map((e) => e.split(":")[0] as string);
  const keyId = artifact.lifecycle.approval?.keyId;
  return keyId === undefined ? [] : [keyId];
}

function expect(value: string | undefined, what: string): string {
  if (value === undefined) throw new Error(`${what} is required`);
  return value;
}

/**
 * Where `origin` is shown, and it is deliberately NOT shown to a calling agent.
 *
 * `describeCapability`, `catalogEntryOf` and `renderForAgent` are unchanged and must stay that way:
 * a model handed a pedigree starts weighing outcomes by it - treating a human-authored
 * MEMBER_NOT_FOUND as softer than a derived one, or the reverse - and that is a routing decision
 * nobody reviewed, made by the component with the least context. An outcome is either in the
 * contract or it is not; "in the contract, but by a human" is not a third state a caller is entitled
 * to act on, because the whole point of the approval gate is that the distinction is already
 * resolved by the time a caller sees the code.
 *
 * Here, on the other hand, the reader IS the reviewer, and the distinction is the thing they came
 * for.
 */
function describeOrigins(artifact: CapabilityArtifact): string {
  const lines: string[] = [];
  for (const step of artifact.flow.steps) {
    for (const rule of step.outcomes) {
      const receipt = artifact.promotions.find((p) => p.code === rule.code && p.atStep === step.id);
      const badge =
        rule.origin === "reviewer-authored"
          ? receipt === undefined
            ? "PROVEN? no receipt"
            : `proven at ${receipt.proof.provenAt.join(", ")}, probe ${receipt.probeConfirmed ? "confirmed" : "NOT confirmed"}`
          : rule.origin === "hand-authored"
            ? "UNPROVEN - typed in by hand, outside the promotion path"
            : "synthesized";
      lines.push(`  outcome   ${rule.code} at ${step.id} [${rule.origin}] ${badge}`);
    }
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** What `crr approve` prints above the signature: the promoted codes and the unproven ones. */
function describePromotions(artifact: CapabilityArtifact): string {
  const lines: string[] = [];
  for (const receipt of artifact.promotions) {
    lines.push(
      `  promoted  ${receipt.code} at ${receipt.atStep} by ${receipt.reviewedBy}, review ${receipt.reviewDigest}`,
      `            proven at ${receipt.proof.provenAt.join(", ")} against ${receipt.proof.negatives.total} negatives (${receipt.proof.negatives.happyPathAtStep} green at the step, ${receipt.proof.negatives.otherAbnormalAtStep} other abnormal at the step)`,
      // Printed, never hidden. A promotion whose detector has never fired in a live session is
      // exactly the thing the person signing should be told about.
      `            probe ${receipt.probeConfirmed ? "CONFIRMED against this revision" : "NOT confirmed - this detector has never fired in a live session"}`,
    );
  }
  const unproven = unprovenOutcomesOf(artifact);
  if (unproven.length > 0) {
    lines.push(
      `  UNPROVEN  ${unproven.join(", ")} - hand-authored, outside the promotion path; nothing has`,
      "            shown these fire on the outcome screen or are silent on the successful one",
    );
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function describePromotionEvent(event: PromotionEvent): string {
  switch (event.step) {
    case "review-read":
      return `review    ${event.code} at ${event.atStep}, by ${event.reviewedBy}, ${event.reviewDigest}`;
    case "corpus-read":
      return `corpus    ${event.observations} observations from ${event.dirs.length} bundle(s), ${event.problems} problem(s)`;
    case "positive-bound":
      return `positive  ${event.observation} - the journal says step ${event.journalStep}`;
    case "proved":
      return `proof     ${event.tenantId}: ${event.verdict.toUpperCase()} - ${event.reason}`;
    case "refused":
      return `REFUSED   ${event.why}`;
    case "emitted":
      return `emitted   contract@${event.contractVersion}, artifact@${event.artifactVersion} ${event.artifactDigest}`;
    case "archived":
      return `archived  ${event.path}`;
  }
}

function describePromotion(report: PromotionReport): string {
  const head = report.ok
    ? `PROMOTED  ${report.code} at ${report.atStep}`
    : `PROMOTION REFUSED  ${report.code} at ${report.atStep}`;
  const rows = report.proofs.map((p) => {
    const n = p.proof.negatives;
    return `  ${p.tenantId.padEnd(12)} ${p.proof.verdict.padEnd(16)} green@step ${n.happyPathAtStep}, other-abnormal@step ${n.otherAbnormalAtStep}, other steps ${n.otherSteps}, other tenants ${n.otherTenants}`;
  });
  // Every threshold this design ships is on that line and there is exactly one of them: at least
  // one positive, and at least one green capture at the step. The rest is reported so an approver
  // can see, for instance, that a detector was never shown a competing abnormal screen.
  const problems = report.problems.map((why) => `  ! ${why}`);
  return `${[head, ...rows, ...problems].join("\n")}\n`;
}

/** The step-to-digest table `crr probe` prints, so identifying the positive is one line of reading
 *  rather than a hunt through a JSONL file. */
function describeCaptures(events: readonly JournalEvent[]): string {
  const rows: string[] = ["  captured observations (step / phase / content address)"];
  for (const event of events) {
    const value = event as unknown as {
      type: string;
      kind?: string;
      ref?: string;
      stepId?: string;
      phase?: string;
    };
    if (value.type !== "evidence.captured" || value.kind !== "observation") continue;
    rows.push(
      `    ${(value.stepId ?? "?").padEnd(20)} ${(value.phase ?? "?").padEnd(5)} ${value.ref ?? "?"}`,
    );
  }
  if (rows.length === 1) {
    return "  no observation was frozen. --capture-every was set, so either the run stopped before its first step or no step was reached.\n";
  }
  return `${rows.join("\n")}\n`;
}

function describeArtifact(artifact: CapabilityArtifact): string {
  const lines = [
    `${artifact.artifactId}@${artifact.version}  ${artifact.lifecycle.status}`,
    `  implements   ${artifact.implements.name}@${artifact.implements.version}`,
    `  digest       ${artifact.digest}`,
    `  surface      ${artifact.target.surfaceKind} (${artifact.target.product} ${artifact.target.productVersionRange})`,
    `  max effect   ${artifact.effects.maxEffect}${artifact.effects.requiresApproval ? " - REQUIRES APPROVAL" : ""}`,
    `  restart safe up to pc ${artifact.effects.restartSafeUpToPc} of ${artifact.flow.steps.length}`,
    "  steps",
  ];
  for (const [index, step] of artifact.flow.steps.entries()) {
    const target = step.target === null ? "" : ` -> ${renderTarget(step.target)}`;
    lines.push(`    ${index}. [${step.effect}] ${step.instruction.kind} ${step.title}${target}`);
  }
  return `${lines.join("\n")}\n${describeOrigins(artifact)}${describePromotions(artifact)}`;
}

function describeResult(result: { readonly status: string } & Record<string, unknown>): string {
  const run = result.run as {
    runId: string;
    durationMs: number;
    stepsExecuted: number;
    stepsTotal: number;
  };
  const head = `${result.status.toUpperCase()}  run ${run.runId}  ${run.stepsExecuted}/${run.stepsTotal} steps  ${run.durationMs}ms`;
  switch (result.status) {
    case "ok":
      return `${head}\n${JSON.stringify(result.outputs, null, 2)}\n`;
    case "outcome":
      return `${head}\n  outcome  ${String(result.outcome)}\n  guidance ${String(result.guidance)}\n`;
    case "suspended": {
      const intervention = result.intervention as { id: string; reason: string; summary: string };
      return `${head}\n  intervention ${intervention.id} (${intervention.reason})\n  ${intervention.summary}\n`;
    }
    default: {
      const failure = result.failure as {
        class: string;
        atStep: string | null;
        expected: { rendered: string };
        operatorAction: string;
        sideEffects: string;
      };
      return [
        head,
        `  failure      ${failure.class} at ${failure.atStep ?? "pre-flight"}`,
        `  side effects ${failure.sideEffects}`,
        `  expected     ${failure.expected.rendered}`,
        `  do this      ${failure.operatorAction}`,
        "",
      ].join("\n");
    }
  }
}

// `import.meta.url` guard so the module can be imported by a test without running the CLI.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`crr: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
