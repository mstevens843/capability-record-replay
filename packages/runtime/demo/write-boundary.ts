import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Allowlist,
  type ApprovalTrustStore,
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
  readonly tenant?: typeof TENANT;
  readonly policyVersion?: string;
  readonly ceiling?: EffectClass;
  readonly expiresAt?: string;
  readonly argsHash?: Digest;
  readonly untrustedSigner?: boolean;
  readonly trustStatus?: "active" | "revoked";
  readonly revokedReason?: string | null;
  readonly trustRevocations?: ApprovalTrustStore["revocations"];
}): InvocationApprovalGrant {
  const artifact = args.artifact ?? approvedArtifact;
  const scope = args.tenant ?? TENANT;
  const pair = generateApprovalKeyPair(`invocation-${args.approvalId}`);
  const signer = localApprovalKeySigner({
    signer: pair.signer,
    signerId: "ops-approver-4",
    authority: [APPROVER_AUTHORITY],
  });
  const trust = ed25519TrustStore(
    args.untrustedSigner === true
      ? []
      : [
          {
            ...pair.trustedKey,
            signerId: "ops-approver-4",
            authority: [APPROVER_AUTHORITY],
            notBefore: "2026-02-11T13:00:00.000Z",
            notAfter: "2026-02-12T14:00:00.000Z",
            status: args.trustStatus ?? "active",
            revokedReason: args.revokedReason ?? null,
            supersedes: null,
          },
        ],
    args.trustRevocations ?? [],
  );
  const ceiling = args.ceiling ?? "WRITE_IRREVERSIBLE";
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
        tenants: [scope.tenantId],
        appInstances: [scope.appInstanceId],
      },
      policyVersion: args.policyVersion ?? "crr-approval-policy/1",
      ceiling,
      issuedAt: "2026-02-11T13:55:00.000Z",
      expiresAt: args.expiresAt ?? "2026-02-11T15:00:00.000Z",
      request:
        ceiling === "WRITE_IRREVERSIBLE"
          ? {
              argsHash: args.argsHash ?? approvalArgsHash(args.approvalId, ARGS),
              idempotencyKey: args.idempotencyKey ?? null,
            }
          : null,
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

function assertCleanCanary(): readonly { readonly label: string; readonly hits: readonly string[] }[] {
  const secrets = [{ label: "WRITE_MEMBER_ID", value: WRITE_MEMBER_ID }] as const;
  const hits = new Map<string, string[]>(secrets.map((secret) => [secret.label, []]));
  const scan = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) scan(full);
      else {
        const text = readFileSync(full, "utf8");
        for (const secret of secrets) {
          if (text.includes(secret.value)) hits.get(secret.label)?.push(full);
        }
      }
    }
  };
  scan(OUT);
  return [...hits].map(([label, found]) => ({ label, hits: found }));
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
      id: "wrong-contract-digest",
      note: "The approval is signed and otherwise valid, but covers a different contract digest. No irreversible dispatch occurs.",
      approval: invocationApproval({
        approvalId: "approval-evidence-wrong-contract",
        contractDigest: digestOf("wrong-contract"),
      }),
    }),
    await replayScenario({
      id: "expired-approval",
      note: "The approval expired before the invocation reached the irreversible gate. No irreversible dispatch occurs.",
      approval: invocationApproval({
        approvalId: "approval-evidence-expired",
        expiresAt: "2026-02-11T13:59:59.000Z",
      }),
    }),
    await replayScenario({
      id: "wrong-tenant-scope",
      note: "The approval is scoped to another tenant. No irreversible dispatch occurs.",
      approval: invocationApproval({
        approvalId: "approval-evidence-wrong-tenant",
        tenant: { tenantId: "summit", appInstanceId: TENANT.appInstanceId },
      }),
    }),
    await replayScenario({
      id: "wrong-app-scope",
      note: "The approval is scoped to another app instance. No irreversible dispatch occurs.",
      approval: invocationApproval({
        approvalId: "approval-evidence-wrong-app",
        tenant: { tenantId: TENANT.tenantId, appInstanceId: "riverbend-branch-mock" },
      }),
    }),
    await replayScenario({
      id: "old-approval-policy",
      note: "The approval was issued under a different approval-policy version. No irreversible dispatch occurs.",
      approval: invocationApproval({
        approvalId: "approval-evidence-old-policy",
        policyVersion: "crr-approval-policy/old",
      }),
    }),
    await replayScenario({
      id: "write-reversible-approval",
      note: "A WRITE_REVERSIBLE approval cannot authorize a WRITE_IRREVERSIBLE action. No irreversible dispatch occurs.",
      approval: invocationApproval({
        approvalId: "approval-evidence-reversible-ceiling",
        ceiling: "WRITE_REVERSIBLE",
      }),
    }),
    await replayScenario({
      id: "untrusted-signer",
      note: "The signature is well formed, but the signer key is absent from the trust store. No irreversible dispatch occurs.",
      approval: invocationApproval({
        approvalId: "approval-evidence-untrusted",
        untrustedSigner: true,
      }),
    }),
    await replayScenario({
      id: "revoked-signer-key",
      note: "The signer key is in the trust store but revoked. No irreversible dispatch occurs.",
      approval: invocationApproval({
        approvalId: "approval-evidence-revoked-key",
        trustStatus: "revoked",
        revokedReason: "operator left the credit union",
      }),
    }),
    await replayScenario({
      id: "revoked-approval-id",
      note: "The signer key is trusted, but this approval id has been revoked. No irreversible dispatch occurs.",
      approval: invocationApproval({
        approvalId: "approval-evidence-revoked-approval",
        trustRevocations: [
          {
            approvalId: "approval-evidence-revoked-approval",
            reason: "duplicate member request",
            revokedAt: "2026-02-11T14:02:00.000Z",
            revokedBy: "ops-risk",
          },
        ],
      }),
    }),
    await replayScenario({
      id: "args-hash-mismatch",
      note: "The approval is bound to a different argument hash. No irreversible dispatch occurs.",
      approval: invocationApproval({
        approvalId: "approval-evidence-wrong-args",
        argsHash: digestOf("other-args"),
      }),
    }),
    await replayScenario({
      id: "idempotency-mismatch",
      note: "The invocation presents one idempotency key, but the approval binds another. No irreversible dispatch occurs.",
      approval: invocationApproval({
        approvalId: "approval-evidence-wrong-idempotency",
        idempotencyKey: "write-evidence-approved-key",
      }),
      idempotencyKey: "write-evidence-presented-key",
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
      "dry-run boundary reporting, valid approval dispatching once, specific rejection reasons,",
      "policy as a separate gate, idempotency de-duplication and effect-in-doubt after a",
      "post-commit observation failure.",
      "",
      "The successful run has a typed confirmation output in memory. The output value is not written",
      "to this evidence directory because the fixture text includes the synthetic sensitive member",
      "number; the summary records the status and final dispatch count instead.",
      "",
      "The browser fixture state proof remains in `packages/runtime/test/browser-write.test.ts`.",
      "",
    ].join("\n"),
  );
  const canary = assertCleanCanary();
  writeJson(join(OUT, "MANIFEST.json"), {
    generatedBy: "packages/runtime/demo/write-boundary.ts",
    scenarios: summaries,
    canary,
  });
  const hitPaths = canary.flatMap((entry) => entry.hits);
  if (hitPaths.length > 0) {
    throw new Error(`write-boundary evidence leaked synthetic sensitive values: ${hitPaths.join(", ")}`);
  }
  process.stdout.write(`write-boundary evidence: ${summaries.length} scenarios, canary clean\n`);
}

await main();
