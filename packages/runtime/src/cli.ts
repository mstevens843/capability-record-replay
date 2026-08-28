#!/usr/bin/env node
// `crr` - the command line the reviewer runs.
//
// Five verbs, and the split between them is the architecture rather than convenience:
//
//   crr show    <artifact>                  reads a document. No surface, no session, no I/O but a
//                                           file read.
//   crr link    <contract> <artifact>       runs all 28 checks and performs ZERO ACTIONS. That is
//                                           the whole value: an artifact can be rejected, with a
//                                           numbered reason, before anything is launched.
//   crr verify  <contract> <artifact>       replays a PROPOSED artifact with the model out of the
//                                           loop and, only if that succeeds, writes the `draft`.
//   crr approve <artifact>                  signs the digest of a verified draft. The approver has
//                                           to tick the grade and the effect classes by hand.
//   crr replay  <contract> <artifact>       links, brokers a session, runs the program, prints one
//                                           of four arms.
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

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  type Allowlist,
  type CapabilityArtifact,
  type CapabilityContract,
  type CapabilityOverlay,
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
import { LifecycleError, approve } from "./lifecycle.js";
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
    },
  });

  // The verb is validated BEFORE any document is read. A `crr nonsense` that reports "a contract
  // path is required" has told the user about the wrong mistake.
  if (
    verb !== "show" &&
    verb !== "link" &&
    verb !== "replay" &&
    verb !== "verify" &&
    verb !== "approve"
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
      });
      const out = values.out ?? resolve(positionals[0] as string);
      writeFileSync(out, `${JSON.stringify(approved, null, 2)}\n`);
      process.stdout.write(
        `APPROVED  ${approved.artifactId}@${approved.version}\n` +
          `  digest    ${approved.digest}\n` +
          `  signed by ${approved.lifecycle.approval?.approvedBy ?? "?"}\n` +
          `  grade     ${approved.verification.grade} (${approved.verification.mode}, covered through ${approved.verification.coveredThroughStep})\n` +
          `  written   ${out}\n`,
      );
      return 0;
    } catch (error) {
      if (!(error instanceof LifecycleError)) throw error;
      process.stdout.write("APPROVAL REFUSED\n");
      for (const reason of error.reasons) process.stdout.write(`  ${reason}\n`);
      return 1;
    }
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
      allowlist,
      trust,
    });
    if (result.ok) {
      process.stdout.write(
        `link ok - ${result.program.steps.length} steps, effective digest ${result.program.effectiveDigest}\n`,
      );
      return 0;
    }
    process.stdout.write(`link REFUSED (${result.failure})\n`);
    for (const error of result.errors) {
      process.stdout.write(`  check ${error.check} ${error.code}: ${error.message}\n`);
    }
    return 1;
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

    const { result } = await replay({
      contract,
      artifact,
      overlay,
      args,
      tenant,
      allowlist,
      broker: new StaticSessionBroker(opened.surface, { onRefresh: async () => "refreshed" }),
      trust,
      ...(values.evidence === undefined ? {} : { evidence: new FileEvidenceSink(values.evidence) }),
      ...(values.journal === undefined
        ? {}
        : {
            journal: (runId, clock) =>
              new FileJournal({ runId, clock, path: values.journal as string }),
          }),
    });

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
  return `${lines.join("\n")}\n`;
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
