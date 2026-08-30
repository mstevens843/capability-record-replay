import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CorpusEntry,
  type EvidenceRef,
  type Observation,
  type Predicate,
  type StepId,
  type TenantId,
  proveDiscrimination,
} from "@crr/core";
import { ed25519Trust } from "../../src/approval.js";
import { MemoryEvidenceSink } from "../../src/evidence.js";
import { sequentialIds } from "../../src/ids.js";
import { MemoryJournal } from "../../src/journal.js";
import { replay, type ReplayOutput } from "../../src/replay.js";
import {
  WRITE_APPROVER_KEY_ID,
  WRITE_DEPOSIT,
  WRITE_MEMBER_ID,
  openSubAccountAllowlist,
  openSubAccountArtifact,
  openSubAccountContract,
  writeApproverPublicKey,
} from "../fixtures/corebank-write.js";
import {
  type CorebankSession,
  chromiumAvailable,
  openCorebankSession,
} from "../support/corebank.js";
import { invocationApprovalFixture } from "../support/invocation-approval.js";
import { eventsOf } from "../support/journal.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const OUT = join(REPO, "evidence/semantic-denials");
const TENANT = { tenantId: "riverbend", appInstanceId: "riverbend-corebank-fixture" };
const ARGS = { memberId: WRITE_MEMBER_ID, openingDeposit: WRITE_DEPOSIT } as const;
const COMMIT = "commit-subaccount" as StepId;
const CONTENT_FRAME = {
  kind: "frame",
  name: { mode: "exact", value: "content", normalize: "std.text@1" },
} as const;

type DenialFault = "permission-denied-record" | "permission-denied-role";

interface ScenarioRun {
  readonly id: string;
  readonly before: number;
  readonly after: number;
  readonly output: ReplayOutput;
}

interface ScenarioSummary {
  readonly id: string;
  readonly status: string;
  readonly outcome?: string;
  readonly failureClass?: string;
  readonly failureAtStep?: string;
  readonly beforeSubAccounts: number;
  readonly afterSubAccounts: number;
  readonly commitStepActed: number;
  readonly approvalAccepted: number;
  readonly approvalRefused: readonly string[];
  readonly commitClassifierVerdict: unknown;
  readonly note: string;
}

function writeText(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function accountsHeld(session: CorebankSession): Promise<number> {
  const state = await session.state();
  return state.members.find((m) => m.memberId === WRITE_MEMBER_ID)?.subAccounts ?? -1;
}

function runOptions(session: CorebankSession, id: string): Parameters<typeof replay>[0] {
  return {
    contract: openSubAccountContract,
    artifact: openSubAccountArtifact,
    args: ARGS,
    tenant: TENANT,
    allowlist: openSubAccountAllowlist,
    broker: session.broker,
    trust: ed25519Trust([{ keyId: WRITE_APPROVER_KEY_ID, publicKey: writeApproverPublicKey }]),
    ids: sequentialIds(`semantic-${id}`),
    evidence: new MemoryEvidenceSink(),
    journal: (runId, clock) => new MemoryJournal({ runId, clock }),
    perceiveDeadlineMs: 15_000,
    onIntervention: "fail",
    invocationApproval: invocationApprovalFixture({
      approvalId: `approval-semantic-${id}`,
      artifact: openSubAccountArtifact,
      contract: openSubAccountContract,
      args: ARGS,
      tenant: TENANT,
      idempotencyKey: `semantic-${id}`,
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      trustNotBefore: "2026-01-01T00:00:00.000Z",
      trustNotAfter: "2099-01-01T00:00:00.000Z",
    }).grant,
    idempotencyKey: `semantic-${id}`,
  };
}

async function runScenario(id: string, fault?: DenialFault): Promise<ScenarioRun> {
  const session = await openCorebankSession(openSubAccountArtifact.flow.routes);
  try {
    const before = await accountsHeld(session);
    if (fault !== undefined) await session.arm(fault);
    const output = await replay(runOptions(session, id));
    const after = await accountsHeld(session);
    return { id, before, after, output };
  } finally {
    await session.close();
  }
}

function approvalRefusals(output: ReplayOutput): readonly string[] {
  return eventsOf(output.journal, "approval.refused").map((event) =>
    typeof event.reason === "string" ? event.reason : "unknown",
  );
}

function classifiedAtCommit(output: ReplayOutput): unknown {
  return (
    eventsOf(output.journal, "classified").find(
      (event) => event.stepId === COMMIT && event.phase === "post",
    )?.verdict ?? null
  );
}

function summary(run: ScenarioRun, note: string): ScenarioSummary {
  const result = run.output.result;
  const failureAtStep =
    result.status === "failed" && result.failure.atStep !== null
      ? { failureAtStep: result.failure.atStep }
      : {};
  return {
    id: run.id,
    status: result.status,
    ...(result.status === "outcome" ? { outcome: result.outcome } : {}),
    ...(result.status === "failed" ? { failureClass: result.failure.class, ...failureAtStep } : {}),
    beforeSubAccounts: run.before,
    afterSubAccounts: run.after,
    commitStepActed: eventsOf(run.output.journal, "acted").filter(
      (event) => event.stepId === COMMIT,
    ).length,
    approvalAccepted: eventsOf(run.output.journal, "approval.accepted").length,
    approvalRefused: approvalRefusals(run.output),
    commitClassifierVerdict: classifiedAtCommit(run.output),
    note,
  };
}

function writeRunEvidence(run: ScenarioRun, note: string): ScenarioSummary {
  const dir = join(OUT, run.id);
  const runSummary = summary(run, note);
  writeJson(join(dir, "result-summary.json"), runSummary);
  writeJson(join(dir, "journal.json"), run.output.journal.events);
  const evidence = run.output.evidence as MemoryEvidenceSink;
  for (const ref of evidence.refs()) {
    writeJson(join(dir, "evidence", `${ref.replaceAll(":", "-")}.json`), evidence.get(ref));
  }
  return runSummary;
}

function capturedObservation(run: ScenarioRun): Observation {
  const captured = eventsOf(run.output.journal, "evidence.captured").find(
    (event) => event.stepId === COMMIT && event.phase === "post",
  );
  if (captured === undefined || typeof captured.ref !== "string") {
    throw new Error(`${run.id} did not capture a post-commit observation`);
  }
  return (run.output.evidence as MemoryEvidenceSink).get(captured.ref as EvidenceRef) as Observation;
}

function corpusEntry(run: ScenarioRun, runStatus: CorpusEntry["runStatus"]): CorpusEntry {
  return {
    observation: capturedObservation(run),
    atStep: COMMIT,
    phase: "post",
    runStatus,
    tenantId: TENANT.tenantId as TenantId,
  };
}

function memberRestrictedDetector(): Predicate {
  const rule = openSubAccountArtifact.flow.steps
    .find((step) => step.id === COMMIT)
    ?.outcomes.find((outcome) => outcome.code === "MEMBER_RESTRICTED");
  if (rule === undefined) throw new Error("MEMBER_RESTRICTED is not declared at commit");
  return rule.detect as Predicate;
}

function proveDenialSplit(green: ScenarioRun, record: ScenarioRun, role: ScenarioRun): unknown {
  const program = record.output.program;
  if (program === null) throw new Error("record-denial replay did not link");
  const positive = corpusEntry(record, "outcome");
  const negatives = [corpusEntry(green, "ok"), corpusEntry(role, "failed")];
  const detector = proveDiscrimination({
    detect: memberRestrictedDetector(),
    atStep: COMMIT,
    tenant: TENANT.tenantId as TenantId,
    positives: [positive],
    negatives,
    facts: program.facts,
    bindings: program.bindings,
  });
  const broadRequestRefused: Predicate = {
    kind: "text-present",
    scope: { path: [CONTENT_FRAME] },
    text: { mode: "contains", value: "Request Refused", normalize: "std.text@1" },
  } as Predicate;
  const broad = proveDiscrimination({
    detect: broadRequestRefused,
    atStep: COMMIT,
    tenant: TENANT.tenantId as TenantId,
    positives: [positive],
    negatives,
    facts: program.facts,
    bindings: program.bindings,
  });
  return {
    declaredDetector: detector,
    overBroadDetector: broad,
    conclusion:
      detector.verdict === "discriminates" && broad.verdict === "over-fires"
        ? "record denial is a declared business outcome; role denial is a separate entitlement failure"
        : "semantic denial proof failed",
  };
}

function assertRunOutcomes(green: ScenarioRun, record: ScenarioRun, role: ScenarioRun): void {
  if (green.output.result.status !== "ok") {
    throw new Error(`green control was not ok: ${JSON.stringify(green.output.result)}`);
  }
  if (green.after !== green.before + 1) {
    throw new Error(`green control did not commit exactly once: ${green.before} -> ${green.after}`);
  }
  if (record.output.result.status !== "outcome" || record.output.result.outcome !== "MEMBER_RESTRICTED") {
    throw new Error(`record denial was not MEMBER_RESTRICTED: ${JSON.stringify(record.output.result)}`);
  }
  if (record.after !== record.before) {
    throw new Error(`record denial changed fixture state: ${record.before} -> ${record.after}`);
  }
  if (role.output.result.status !== "failed" || role.output.result.failure.class !== "entitlement-denied") {
    throw new Error(`role denial was not entitlement-denied: ${JSON.stringify(role.output.result)}`);
  }
  if (role.after !== role.before) {
    throw new Error(`role denial changed fixture state: ${role.before} -> ${role.after}`);
  }
}

function assertCleanCanary(): readonly { readonly label: string; readonly hits: readonly string[] }[] {
  const secrets = [
    { label: "WRITE_MEMBER_ID", value: WRITE_MEMBER_ID },
    { label: "WRITE_DEPOSIT", value: WRITE_DEPOSIT },
  ] as const;
  const hits = new Map<string, string[]>(secrets.map((secret) => [secret.label, []]));
  const scan = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        scan(full);
        continue;
      }
      const text = readFileSync(full, "utf8");
      for (const secret of secrets) {
        if (text.includes(secret.value)) hits.get(secret.label)?.push(full);
      }
    }
  };
  scan(OUT);
  return [...hits].map(([label, found]) => ({ label, hits: found }));
}

async function main(): Promise<void> {
  if (!chromiumAvailable()) {
    throw new Error(
      "semantic denial evidence requires Chromium; run `pnpm -F @crr/surface-browser exec playwright install chromium`",
    );
  }

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const green = await runScenario("green-control");
  const record = await runScenario("record-denial-business-outcome", "permission-denied-record");
  const role = await runScenario("role-denial-entitlement-failure", "permission-denied-role");
  assertRunOutcomes(green, record, role);

  const summaries = [
    writeRunEvidence(
      green,
      "Control run used as a negative proof sample. It commits once in its isolated browser fixture session.",
    ),
    writeRunEvidence(
      record,
      "The fixture refused the commit because the member record is restricted. The artifact's reviewer-authored detector returns MEMBER_RESTRICTED and the fixture state does not change.",
    ),
    writeRunEvidence(
      role,
      "The fixture refused the same final screen because the teller role lacks OPEN_SUBACCOUNT authority. The runtime reports entitlement-denied, not a member business outcome, and the fixture state does not change.",
    ),
  ];
  const proof = proveDenialSplit(green, record, role);
  writeJson(join(OUT, "proof.json"), proof);
  writeJson(join(OUT, "promotion-receipt.json"), {
    promotion: openSubAccountArtifact.promotions.find(
      (promotion) => promotion.code === "MEMBER_RESTRICTED" && promotion.atStep === COMMIT,
    ),
  });
  writeText(
    join(OUT, "README.md"),
    [
      "# semantic denial evidence",
      "",
      "Generated by `pnpm -F @crr/runtime exec tsx test/evidence/semantic-denials.ts`.",
      "",
      "This exhibit drives the real `fixtures/corebank-web` browser surface. It proves that two",
      "nearly identical `Request Refused` screens are not guessed from prose: record denial is a",
      "reviewer-authored `MEMBER_RESTRICTED` business outcome, while role denial is an",
      "`entitlement-denied` operator/session failure.",
      "",
      "`proof.json` contains the discrimination result for the declared detector and the negative",
      "control showing an over-broad `Request Refused` detector over-fires on the role-denial screen.",
      "Each scenario directory contains the replay journal and redacted captured observations.",
      "",
    ].join("\n"),
  );
  const canary = assertCleanCanary();
  writeJson(join(OUT, "MANIFEST.json"), {
    generatedBy: "packages/runtime/test/evidence/semantic-denials.ts",
    scenarios: summaries,
    canary,
  });
  const leaks = canary.flatMap((entry) => entry.hits);
  if (leaks.length > 0) {
    throw new Error(`semantic denial evidence leaked synthetic sensitive values: ${leaks.join(", ")}`);
  }
  process.stdout.write(`semantic denial evidence: ${summaries.length} scenarios, canary clean\n`);
}

await main();
