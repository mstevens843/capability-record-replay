import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Allowlist,
  type CapabilityArtifact,
  type CapabilityContract,
  type Digest,
  type EffectClass,
  MOCK_LEASE_TOKEN,
  MockSurface,
  type MockTransition,
  type Observation,
  approvalArgsHash,
  digestOf,
} from "@crr/core";
import {
  type ApprovalSigner,
  type InvocationApprovalGrant,
  type TrustedKey,
  ed25519Trust,
  ed25519TrustStore,
  generateApprovalKeyPair,
  invocationApprovalGrant,
  localApprovalKeySigner,
  signApprovalDocument,
} from "../src/approval.js";
import { manualClock } from "../src/clock.js";
import { MemoryEvidenceSink } from "../src/evidence.js";
import { sequentialIds } from "../src/ids.js";
import { MemoryIdempotencyStore, type InvokeHost, invokeDetailed } from "../src/invoke.js";
import { MemoryJournal } from "../src/journal.js";
import { approve } from "../src/lifecycle.js";
import { replay } from "../src/replay.js";
import { StaticSessionBroker } from "../src/session.js";
import { verifyAndDraft } from "../src/verify.js";
import {
  WRITE_IDS,
  WRITE_MEMBER_ID,
  proposedWriteArtifact,
  writeAllowlist,
  writeContract,
  writeScreens,
  writeTransitions,
} from "../test/fixtures/write-flow.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const OUT = join(REPO, "evidence/write-boundary");
const TENANT = { tenantId: "riverbend", appInstanceId: "riverbend-mock" };
const ARGS = { memberId: WRITE_MEMBER_ID } as const;
const APPROVER_AUTHORITY = "open-subaccount-approver";

let artifactSigner: ApprovalSigner;
let artifactTrustedKey: TrustedKey;
let approvedArtifact: CapabilityArtifact;

interface ScenarioSummary {
  readonly id: string;
  readonly status: string;
  readonly failureClass?: string;
  readonly stepsExecuted: number;
  readonly finalDispatches: number;
  readonly dryBoundary?: unknown;
  readonly approvalAccepted: number;
  readonly approvalRefused: readonly string[];
  readonly deduplicated?: boolean;
  readonly note: string;
}

function writeText(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeSurface(transitions: readonly MockTransition[] = writeTransitionsForMock()) {
  return new MockSurface({
    screens: writeScreens as Readonly<Record<string, Observation>>,
    start: "blank",
    transitions,
    lease: MOCK_LEASE_TOKEN,
  });
}

function writeTransitionsForMock(): readonly MockTransition[] {
  return writeTransitions as unknown as readonly MockTransition[];
}

async function approvedWriteArtifact(artifact: CapabilityArtifact): Promise<CapabilityArtifact> {
  const clock = manualClock();
  const { report, artifact: draft } = await verifyAndDraft({
    contract: writeContract,
    artifact,
    args: ARGS,
    tenant: TENANT,
    allowlist: writeAllowlist(),
    broker: new StaticSessionBroker(writeSurface()),
    clock,
    ids: sequentialIds("evidence-draft"),
    evidence: new MemoryEvidenceSink(),
    journal: (runId) => new MemoryJournal({ runId, clock }),
  });
  if (draft === null) throw new Error(`write fixture did not verify: ${report.reason}`);
  return approve(draft, {
    signer: artifactSigner,
    approvedBy: "ops-approver-4",
    approvedAt: "2026-02-11T14:10:00.000Z",
    acknowledgedGrade: "partial-up-to-irreversible",
    acknowledgedEffects: ["READ", "WRITE_IRREVERSIBLE"],
  });
}

function invocationApproval(args: {
  readonly approvalId: string;
  readonly artifact?: CapabilityArtifact;
  readonly artifactDigest?: Digest;
  readonly contractDigest?: Digest;
  readonly idempotencyKey?: string | null;
  readonly expiresAt?: string;
}): InvocationApprovalGrant {
  const artifact = args.artifact ?? approvedArtifact;
  const pair = generateApprovalKeyPair(`invocation-${args.approvalId}`);
  const signer = localApprovalKeySigner({
    signer: pair.signer,
    signerId: "ops-approver-4",
    authority: [APPROVER_AUTHORITY],
  });
  const trust = ed25519TrustStore([
    {
      ...pair.trustedKey,
      signerId: "ops-approver-4",
      authority: [APPROVER_AUTHORITY],
      notBefore: "2026-02-11T13:00:00.000Z",
      notAfter: "2026-02-12T14:00:00.000Z",
      status: "active",
      revokedReason: null,
      supersedes: null,
    },
  ]);
  const approval = signApprovalDocument(
    {
      schemaVersion: "capability.approval/v1",
      approvalId: args.approvalId,
      subject: "invocation",
      capability: {
        name: writeContract.name,
        version: writeContract.version,
      },
      approves: {
        artifactDigest: args.artifactDigest ?? artifact.digest,
        contractDigest: args.contractDigest ?? writeContract.digest,
      },
      scope: {
        tenants: [TENANT.tenantId],
        appInstances: [TENANT.appInstanceId],
      },
      policyVersion: "crr-approval-policy/1",
      ceiling: "WRITE_IRREVERSIBLE",
      issuedAt: "2026-02-11T13:55:00.000Z",
      expiresAt: args.expiresAt ?? "2026-02-11T15:00:00.000Z",
      request: {
        argsHash: approvalArgsHash(args.approvalId, ARGS),
        idempotencyKey: args.idempotencyKey ?? null,
      },
      signer: {
        signerId: "ops-approver-4",
        authority: [APPROVER_AUTHORITY],
        keyId: pair.signer.keyId,
        alg: "ed25519",
      },
    } as never,
    signer,
  );
  return invocationApprovalGrant({
    approval,
    trust,
    requiredAuthority: [APPROVER_AUTHORITY],
  });
}

function confirmClicks(surface: MockSurface): number {
  return surface.dispatched.filter(
    (d) => d.action.kind === "click" && d.action.target === WRITE_IDS.confirmButton,
  ).length;
}

function approvalEvents(journal: MemoryJournal): {
  readonly accepted: number;
  readonly refused: readonly string[];
} {
  const events = journal.events as unknown as readonly {
    readonly type: string;
    readonly reason?: string;
  }[];
  return {
    accepted: events.filter((event) => event.type === "approval.accepted").length,
    refused: events
      .filter((event) => event.type === "approval.refused")
      .map((event) => event.reason ?? "unknown"),
  };
}

function writeEvidence(dir: string, evidence: MemoryEvidenceSink): void {
  for (const ref of evidence.refs()) {
    writeJson(join(dir, "evidence", `${ref.replaceAll(":", "-")}.json`), evidence.get(ref));
  }
}

async function replayScenario(args: {
  readonly id: string;
  readonly note: string;
  readonly artifact?: CapabilityArtifact;
  readonly allowlist?: Allowlist;
  readonly approval?: InvocationApprovalGrant | null;
  readonly idempotencyKey?: string | null;
  readonly dryRun?: { readonly stopBeforeEffect: EffectClass };
  readonly transitions?: readonly MockTransition[];
}): Promise<ScenarioSummary> {
  const dir = join(OUT, args.id);
  const surface = writeSurface(args.transitions ?? writeTransitionsForMock());
  const clock = manualClock();
  const evidence = new MemoryEvidenceSink();
  const journals: MemoryJournal[] = [];
  const out = await replay({
    contract: writeContract,
    artifact: args.artifact ?? approvedArtifact,
    args: ARGS,
    tenant: TENANT,
    allowlist: args.allowlist ?? writeAllowlist("WRITE_IRREVERSIBLE"),
    broker: new StaticSessionBroker(surface),
    trust: ed25519Trust([artifactTrustedKey]),
    clock,
    ids: sequentialIds(args.id),
    evidence,
    journal: (runId) => {
      const book = new MemoryJournal({ runId, clock });
      journals.push(book);
      return book;
    },
    onIntervention: "fail",
    ...(args.approval === undefined ? {} : { invocationApproval: args.approval }),
    ...(args.idempotencyKey === undefined ? {} : { idempotencyKey: args.idempotencyKey }),
    ...(args.dryRun === undefined ? {} : { dryRun: args.dryRun }),
  });
  const journal = journals[0];
  if (journal === undefined) throw new Error(`scenario ${args.id} did not create a journal`);
  const approvals = approvalEvents(journal);
  const summary: ScenarioSummary = {
    id: args.id,
    status: out.result.status,
    ...(out.result.status === "failed" ? { failureClass: out.result.failure.class } : {}),
    stepsExecuted: out.result.run.stepsExecuted,
    finalDispatches: confirmClicks(surface),
    ...(out.dryBoundary === null ? {} : { dryBoundary: out.dryBoundary }),
    approvalAccepted: approvals.accepted,
    approvalRefused: approvals.refused,
    note: args.note,
  };
  writeJson(join(dir, "result-summary.json"), summary);
  writeJson(join(dir, "journal.json"), journal.events);
  writeEvidence(dir, evidence);
  return summary;
}

async function idempotencyScenario(): Promise<ScenarioSummary> {
  const id = "idempotency-repeat";
  const dir = join(OUT, id);
  const surface = writeSurface();
  const clock = manualClock();
  const evidence = new MemoryEvidenceSink();
  const idempotency = new MemoryIdempotencyStore();
  const key = "write-evidence-idempotency";
  const journals: MemoryJournal[] = [];
  const host: InvokeHost = {
    artifact: approvedArtifact,
    broker: new StaticSessionBroker(surface),
    allowlist: writeAllowlist("WRITE_IRREVERSIBLE"),
    trust: ed25519Trust([artifactTrustedKey]),
    invocationApproval: invocationApproval({
      approvalId: "approval-evidence-idempotency",
      idempotencyKey: key,
    }),
    clock,
    ids: sequentialIds(id),
    evidence,
    journal: (runId) => {
      const book = new MemoryJournal({ runId, clock });
      journals.push(book);
      return book;
    },
    idempotency,
  };
  const invocation = {
    capability: {
      name: writeContract.name,
      version: writeContract.version,
      contractDigest: writeContract.digest,
    },
    tenant: TENANT,
    args: ARGS,
    approval: "legacy-type-token",
    idempotencyKey: key,
    onIntervention: "fail",
    correlation: { agentSessionId: "agent-turn-write-boundary", requestedBy: "agent" },
  } as never;
  const first = await invokeDetailed(writeContract, invocation, host);
  const second = await invokeDetailed(writeContract, invocation, host);
  const journal = journals[0];
  if (journal === undefined) throw new Error("idempotency scenario did not create a journal");
  const approvals = approvalEvents(journal);
  const summary: ScenarioSummary = {
    id,
    status: first.document.status,
    stepsExecuted: first.document.run.stepsExecuted,
    finalDispatches: confirmClicks(surface),
    approvalAccepted: approvals.accepted,
    approvalRefused: approvals.refused,
    deduplicated: second.deduplicated,
    note: "The first invocation commits once. The second invocation has the same idempotency key and returns the stored result without driving the surface again.",
  };
  writeJson(join(dir, "result-summary.json"), summary);
  writeJson(join(dir, "journal.json"), journal.events);
  writeJson(join(dir, "second-result-summary.json"), {
    status: second.document.status,
    deduplicated: second.deduplicated,
    sameDocument: JSON.stringify(first.document) === JSON.stringify(second.document),
  });
  writeEvidence(dir, evidence);
  return summary;
}

function ceilingAllowlist(maxEffect: EffectClass): Allowlist {
  const base = writeAllowlist("WRITE_IRREVERSIBLE");
  return {
    ...base,
    maxEffect,
    routes: base.routes.map((route) =>
      route.pathPattern === "/subaccount/new" ? { ...route, maxEffect } : route,
    ),
  };
}

function timeoutAfterCommit(transition: MockTransition): MockTransition {
  return {
    ...transition,
    via: [{ kind: "fault", fault: { kind: "perceive-timeout", elapsedMs: 0 } }],
  };
}

function assertCleanCanary(): readonly string[] {
  const hits: string[] = [];
  const scan = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) scan(full);
      else if (readFileSync(full, "utf8").includes(WRITE_MEMBER_ID)) hits.push(full);
    }
  };
  scan(OUT);
  return hits;
}

async function main(): Promise<void> {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const artifactKey = generateApprovalKeyPair("write-boundary-artifact-key");
  artifactSigner = artifactKey.signer;
  artifactTrustedKey = artifactKey.trustedKey;
  approvedArtifact = await approvedWriteArtifact(proposedWriteArtifact());

  const policyArtifact = await approvedWriteArtifact(proposedWriteArtifact({ irreversibleAt: "open" }));
  const summaries = [
    await replayScenario({
      id: "no-approval",
      note: "The runtime reaches the final boundary and refuses before the irreversible dispatch. Reversible setup happened, so sideEffects is conservative, but finalDispatches is zero.",
    }),
    await replayScenario({
      id: "dry-run",
      note: "Dry run resolves and lowers the irreversible step, then stops before dispatch.",
      dryRun: { stopBeforeEffect: "WRITE_IRREVERSIBLE" },
    }),
    await replayScenario({
      id: "valid-approval",
      note: "A scoped invocation approval is accepted and the final irreversible action dispatches exactly once. The typed output value is withheld from this evidence summary because it contains the synthetic sensitive member id.",
      approval: invocationApproval({
        approvalId: "approval-evidence-valid",
        idempotencyKey: "write-evidence-valid",
      }),
      idempotencyKey: "write-evidence-valid",
    }),
    await replayScenario({
      id: "wrong-artifact-digest",
      note: "The approval is signed and otherwise valid, but covers a different artifact digest. No irreversible dispatch occurs.",
      approval: invocationApproval({
        approvalId: "approval-evidence-wrong-artifact",
        artifactDigest: digestOf("wrong-artifact"),
      }),
    }),
    await replayScenario({
      id: "policy-read-ceiling",
      note: "A valid approval is present, but policy maxEffect READ is a separate gate and refuses before the first write step dispatches.",
      artifact: policyArtifact,
      allowlist: { ...writeAllowlist("WRITE_IRREVERSIBLE"), maxEffect: "READ" },
      approval: invocationApproval({
        approvalId: "approval-evidence-policy-read",
        artifact: policyArtifact,
      }),
    }),
    await idempotencyScenario(),
    await replayScenario({
      id: "effect-in-doubt",
      note: "The irreversible action dispatches once, then perception times out. The result is effect-in-doubt and is not retryable.",
      approval: invocationApproval({
        approvalId: "approval-evidence-effect-in-doubt",
      }),
      transitions: writeTransitionsForMock().map((transition) =>
        transition.from === "new-subaccount" ? timeoutAfterCommit(transition) : transition,
      ),
    }),
  ];

  writeText(
    join(OUT, "README.md"),
    [
      "# write-boundary evidence",
      "",
      "Generated by `pnpm -F @crr/runtime exec tsx demo/write-boundary.ts`.",
      "",
      "This exhibit uses the deterministic mock write fixture rather than the browser fixture. It",
      "proves runtime behavior at the irreversible boundary: approval refusal before dispatch,",
      "dry-run boundary reporting, valid approval dispatching once, policy as a separate gate,",
      "idempotency de-duplication and effect-in-doubt after a post-commit observation failure.",
      "",
      "The successful run has a typed confirmation output in memory. The output value is not written",
      "to this evidence directory because the fixture text includes the synthetic sensitive member",
      "number; the summary records the status and final dispatch count instead.",
      "",
      "The browser fixture state proof remains in `packages/runtime/test/browser-write.test.ts`.",
      "",
    ].join("\n"),
  );
  const hits = assertCleanCanary();
  writeJson(join(OUT, "MANIFEST.json"), {
    generatedBy: "packages/runtime/demo/write-boundary.ts",
    scenarios: summaries,
    canary: { forbiddenValue: "WRITE_MEMBER_ID", hits },
  });
  if (hits.length > 0) {
    throw new Error(`write-boundary evidence leaked the synthetic member id: ${hits.join(", ")}`);
  }
  process.stdout.write(`write-boundary evidence: ${summaries.length} scenarios, canary clean\n`);
}

await main();
