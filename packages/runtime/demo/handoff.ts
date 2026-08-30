import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Action,
  type Allowlist,
  MOCK_LEASE_TOKEN,
  MockSurface,
  type MockTransition,
  type NodeId,
  type Observation,
  type PolicyContext,
  type PolicyDecision,
  check,
} from "@crr/core";
import { renderCanaryReport, runRedactionCanary } from "../src/canary.js";
import { manualClock } from "../src/clock.js";
import { MemoryEvidenceSink } from "../src/evidence.js";
import { sequentialIds } from "../src/ids.js";
import { ControlPlane, type LiveView } from "../src/intervention.js";
import { MemoryJournal } from "../src/journal.js";
import { replay, type ReplayOutput } from "../src/replay.js";
import { StaticSessionBroker } from "../src/session.js";
import {
  EIDS,
  MEMBER_ID,
  escalationArtifact,
  escalationContract,
  escalationScreens,
} from "../test/fixtures/escalation-flow.js";
import { mockAllowlist, mockTrust } from "../test/fixtures/mock-flow.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const OUT = join(REPO, "evidence/handoff");
const TENANT = { tenantId: "riverbend", appInstanceId: "riverbend-mock" };
const OPERATOR = "operator:pat";

const TRANSITIONS: readonly MockTransition[] = [
  { from: "blank", on: { kind: "navigate", path: "/search" }, to: "search" },
  { from: "search", on: { kind: "type", target: EIDS.memberIdField }, to: "search-hold" },
  { from: "search-hold", on: { kind: "click", target: EIDS.authorizeButton }, to: "search-typed" },
  { from: "search-hold", on: { kind: "click", target: EIDS.menuLink }, to: "menu" },
  { from: "search-typed", on: { kind: "click", target: EIDS.searchButton }, to: "results" },
];

interface StuckRun {
  readonly control: ControlPlane;
  readonly journal: MemoryJournal;
  readonly evidence: MemoryEvidenceSink;
  readonly output: ReplayOutput;
  readonly interventionId: string;
}

interface ScenarioSummary {
  readonly id: string;
  readonly initialController: string | null;
  readonly offeredState: string;
  readonly offeredLeaseHolder: string;
  readonly claimedController: string;
  readonly leaseEpochs: readonly unknown[];
  readonly staleAutomationRefusedBeforeDispatch: boolean;
  readonly staleAutomationRefusalReason: string | null;
  readonly humanActionPolicyChecked: boolean;
  readonly humanActionPolicyReason: string | null;
  readonly handback: string;
  readonly finalStatus: string;
  readonly finalFailureClass?: string;
  readonly finalOutcome?: string;
  readonly finalOutputs?: unknown;
  readonly resumeChecks: readonly unknown[];
  readonly note: string;
}

function writeText(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

const click = (target: NodeId): Action => ({ kind: "click", target }) as Action;

async function stuck(id: string, allowlist: Allowlist = mockAllowlist): Promise<StuckRun> {
  const surface = new MockSurface({
    screens: escalationScreens as Readonly<Record<string, Observation>>,
    start: "blank",
    transitions: TRANSITIONS,
    lease: MOCK_LEASE_TOKEN,
  });
  const clock = manualClock();
  const control = new ControlPlane({ clock, interventionTtlMs: 600_000 });
  const evidence = new MemoryEvidenceSink();
  let journal!: MemoryJournal;

  const output = await replay({
    contract: escalationContract,
    artifact: escalationArtifact(),
    args: { memberId: MEMBER_ID },
    tenant: TENANT,
    allowlist,
    broker: new StaticSessionBroker(surface),
    trust: mockTrust,
    clock,
    ids: sequentialIds(`handoff-${id}`),
    evidence,
    journal: (runId) => {
      journal = new MemoryJournal({ runId, clock });
      return journal;
    },
    onIntervention: "suspend",
    control,
  });

  if (output.result.status !== "suspended") {
    throw new Error(`${id}: expected suspended, got ${output.result.status}`);
  }
  return {
    control,
    journal,
    evidence,
    output,
    interventionId: output.result.intervention.id,
  };
}

function eventRows(journal: MemoryJournal, type: string): readonly Record<string, unknown>[] {
  return (journal.events as unknown as readonly Record<string, unknown>[]).filter(
    (event) => event.type === type,
  );
}

function leaseEpochs(journal: MemoryJournal): readonly unknown[] {
  return eventRows(journal, "lease.acquired").map((event) => ({
    holder: event.holder,
    actorId: event.actorId,
    epoch: event.epoch,
  }));
}

function initialController(journal: MemoryJournal): string | null {
  const first = eventRows(journal, "lease.acquired")[0];
  return typeof first?.holder === "string" ? first.holder : null;
}

function staleAutomationRefusal(
  run: StuckRun,
  view: LiveView,
  action: Action,
): { readonly refused: boolean; readonly decision: PolicyDecision } {
  const ctx: PolicyContext = {
    mode: "replay",
    allowlist: mockAllowlist,
    step: null,
    route: view.observed.route,
    effect: "READ",
    lease: {
      holder: view.holder,
      actorId: view.actorId,
      epoch: view.epoch,
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    approval: null,
    artifact: { lifecycle: "approved", digestVerified: true },
    taint: [],
    approvedDigest: null,
  };
  const decision = check(action, ctx, {
    now: "2026-02-11T14:00:00.000Z",
    epoch: view.epoch,
  });
  run.journal.append({ type: "policy.decided", decision, actionKind: action.kind, effect: "READ" });
  return {
    refused: !decision.allow && decision.reason === "lease-not-held",
    decision,
  };
}

function writeEvidence(dir: string, evidence: MemoryEvidenceSink): void {
  for (const ref of evidence.refs()) {
    writeJson(join(dir, "evidence", `${ref.replaceAll(":", "-")}.json`), evidence.get(ref));
  }
}

function summarizeResult(result: ReplayOutput["result"]): {
  readonly finalStatus: string;
  readonly finalFailureClass?: string;
  readonly finalOutcome?: string;
  readonly finalOutputs?: unknown;
} {
  if (result.status === "ok") {
    return { finalStatus: "ok", finalOutputs: result.outputs };
  }
  if (result.status === "outcome") {
    return { finalStatus: "outcome", finalOutcome: result.outcome };
  }
  if (result.status === "failed") {
    return { finalStatus: "failed", finalFailureClass: result.failure.class };
  }
  return { finalStatus: result.status };
}

async function successScenario(): Promise<ScenarioSummary> {
  const run = await stuck("success");
  const dir = join(OUT, "success");
  const offered = await run.control.view(run.interventionId);
  if (!offered.ok) throw new Error(`success: offered view refused: ${offered.detail}`);
  const intervention = run.control.get(run.interventionId);
  if (intervention === null) throw new Error("success: intervention was not parked");

  const claimed = await run.control.claim(run.interventionId, OPERATOR);
  if (!claimed.ok) throw new Error(`success: claim refused: ${claimed.detail}`);

  const stale = staleAutomationRefusal(run, claimed.view, click(EIDS.authorizeButton));
  if (!stale.refused) throw new Error("success: stale automation was not refused before dispatch");

  const acted = await run.control.inject(run.interventionId, OPERATOR, click(EIDS.authorizeButton));
  if (!acted.ok) throw new Error(`success: human action refused: ${acted.detail}`);
  if (!acted.decision.allow) throw new Error("success: human action did not pass policy");

  const handed = await run.control.handBack(run.interventionId, OPERATOR);
  if (!handed.ok) throw new Error(`success: handback refused: ${handed.detail}`);
  if (handed.result.status !== "ok") {
    throw new Error(`success: expected ok after handback, got ${handed.result.status}`);
  }
  if (handed.checks.length !== 7 || handed.checks.some((check) => !check.passed)) {
    throw new Error("success: resume did not pass all seven checks");
  }

  writeJson(join(dir, "intervention.json"), intervention);
  writeJson(join(dir, "offered-view.json"), offered.view);
  writeJson(join(dir, "claimed-view.json"), claimed.view);
  writeJson(join(dir, "result-summary.json"), {
    result: summarizeResult(handed.result),
    attribution: handed.result.run.attribution,
    resumeChecks: handed.checks,
  });
  writeJson(join(dir, "journal.json"), run.journal.events);
  writeEvidence(dir, run.evidence);

  return {
    id: "success",
    initialController: initialController(run.journal),
    offeredState: offered.view.state,
    offeredLeaseHolder: offered.view.holder,
    claimedController: claimed.view.holder,
    leaseEpochs: leaseEpochs(run.journal),
    staleAutomationRefusedBeforeDispatch: stale.refused,
    staleAutomationRefusalReason: stale.decision.allow ? null : stale.decision.reason,
    humanActionPolicyChecked: acted.decision.allow,
    humanActionPolicyReason: null,
    handback: "accepted",
    ...summarizeResult(handed.result),
    resumeChecks: handed.checks,
    note: "Automation suspended on a supervisor hold; the operator claimed the same session, cleared the hold through a policy-checked click, handed back, and replay resumed from the top of the suspended step.",
  };
}

async function refusedHandbackScenario(): Promise<ScenarioSummary> {
  const run = await stuck("refused");
  const dir = join(OUT, "refused-handback");
  const offered = await run.control.view(run.interventionId);
  if (!offered.ok) throw new Error(`refused: offered view refused: ${offered.detail}`);
  const intervention = run.control.get(run.interventionId);
  if (intervention === null) throw new Error("refused: intervention was not parked");

  const claimed = await run.control.claim(run.interventionId, OPERATOR);
  if (!claimed.ok) throw new Error(`refused: claim refused: ${claimed.detail}`);

  const stale = staleAutomationRefusal(run, claimed.view, click(EIDS.authorizeButton));
  if (!stale.refused) throw new Error("refused: stale automation was not refused before dispatch");

  const wandered = await run.control.inject(run.interventionId, OPERATOR, click(EIDS.menuLink));
  if (!wandered.ok) throw new Error(`refused: menu action refused: ${wandered.detail}`);
  if (!wandered.decision.allow) throw new Error("refused: human action did not pass policy");

  const handed = await run.control.handBack(run.interventionId, OPERATOR);
  if (!handed.ok) throw new Error(`refused: expected terminal failed result, got ${handed.detail}`);
  if (handed.result.status !== "failed" || handed.result.failure.class !== "precondition-not-met") {
    throw new Error(`refused: expected failed/precondition-not-met, got ${handed.result.status}`);
  }
  if (handed.checks.at(-1)?.step !== 4 || handed.checks.at(-1)?.passed !== false) {
    throw new Error("refused: handback did not stop at precondition recheck");
  }

  writeJson(join(dir, "intervention.json"), intervention);
  writeJson(join(dir, "offered-view.json"), offered.view);
  writeJson(join(dir, "claimed-view.json"), claimed.view);
  writeJson(join(dir, "result-summary.json"), {
    result: summarizeResult(handed.result),
    attribution: handed.result.run.attribution,
    resumeChecks: handed.checks,
  });
  writeJson(join(dir, "journal.json"), run.journal.events);
  writeEvidence(dir, run.evidence);

  return {
    id: "refused-handback",
    initialController: initialController(run.journal),
    offeredState: offered.view.state,
    offeredLeaseHolder: offered.view.holder,
    claimedController: claimed.view.holder,
    leaseEpochs: leaseEpochs(run.journal),
    staleAutomationRefusedBeforeDispatch: stale.refused,
    staleAutomationRefusalReason: stale.decision.allow ? null : stale.decision.reason,
    humanActionPolicyChecked: wandered.decision.allow,
    humanActionPolicyReason: null,
    handback: "refused-by-resume-precheck",
    ...summarizeResult(handed.result),
    resumeChecks: handed.checks,
    note: "The operator claimed the same session but navigated away before handback. Resume re-observed the current screen and refused at precondition re-verification instead of continuing on the wrong route.",
  };
}

function writeReadme(): void {
  writeText(
    join(OUT, "README.md"),
    [
      "# handoff evidence",
      "",
      "Generated by `pnpm -F @crr/runtime exec tsx demo/handoff.ts`.",
      "",
      "This exhibit is the assignment's human-in-the-loop handoff requirement as a deterministic",
      "run. It uses the mock escalation fixture from `packages/runtime/test/escalation.test.ts`: the",
      "automation reaches a supervisor-hold screen, raises an intervention, cedes the live session,",
      "and the operator claims it under a new lease epoch.",
      "",
      "The success case proves that stale automation is refused before dispatch, the operator",
      "action passes the same policy chokepoint as automation, the journal records the",
      "controller transition, and handback runs the seven resume checks before replay continues.",
      "",
      "The refused case proves the opposite half: if the operator leaves the session on the wrong",
      "screen, handback re-perceives and refuses with `precondition-not-met` instead of continuing.",
      "",
      "The pre-handoff automation token is intentionally not written into evidence. Direct",
      "driver-level lease refusal is covered in `packages/runtime/test/escalation.test.ts`; this",
      "bundle records the exposed stale-controller check and the handoff outcome.",
      "",
    ].join("\n"),
  );
}

function scan(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...scan(full));
    else out.push(full);
  }
  return out;
}

async function main(): Promise<void> {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const scenarios = [await successScenario(), await refusedHandbackScenario()];
  writeReadme();
  const report = runRedactionCanary({
    bundleDir: OUT,
    secrets: [{ label: "HANDOFF_MEMBER_ID", value: MEMBER_ID }],
  });
  writeJson(join(OUT, "redaction-canary.json"), report);
  writeText(join(OUT, "redaction-canary.txt"), renderCanaryReport(report));
  writeJson(join(OUT, "MANIFEST.json"), {
    generatedBy: "packages/runtime/demo/handoff.ts",
    scenarioCount: scenarios.length,
    scenarios,
    redaction: {
      clean: report.clean,
      filesScanned: report.filesScanned,
      hits: report.hits.length,
      forbidden: report.forbidden.length,
    },
    files: scan(OUT).map((path) => path.slice(OUT.length + 1).replaceAll("\\", "/")).sort(),
  });

  const finalReport = runRedactionCanary({
    bundleDir: OUT,
    secrets: [{ label: "HANDOFF_MEMBER_ID", value: MEMBER_ID }],
  });
  if (!finalReport.clean) {
    throw new Error(`handoff evidence redaction failed: ${finalReport.hits.length} hits`);
  }
  process.stdout.write(`handoff evidence: ${scenarios.length} scenarios, canary clean\n`);
}

await main();
