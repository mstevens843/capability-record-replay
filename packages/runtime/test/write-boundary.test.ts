import {
  type Allowlist,
  type CapabilityArtifact,
  type CapabilityContract,
  type EffectClass,
  MOCK_LEASE_TOKEN,
  MockSurface,
  type MockTransition,
  type Observation,
  digestOf,
} from "@crr/core";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ApprovalSigner,
  type InvocationApprovalGrant,
  type TrustedKey,
  ed25519Trust,
  generateApprovalKeyPair,
} from "../src/approval.js";
import { Catalog } from "../src/catalog.js";
import { manualClock } from "../src/clock.js";
import { MemoryEvidenceSink } from "../src/evidence.js";
import { sequentialIds } from "../src/ids.js";
import { MemoryIdempotencyStore, type InvokeHost, invokeDetailed } from "../src/invoke.js";
import { MemoryJournal } from "../src/journal.js";
import { approve } from "../src/lifecycle.js";
import { type ReplayOptions, replay } from "../src/replay.js";
import { StaticSessionBroker } from "../src/session.js";
import { toolNameOf } from "../src/tools.js";
import { verifyAndDraft } from "../src/verify.js";
import { IDS } from "./fixtures/mock-flow.js";
import {
  WRITE_IDS,
  WRITE_MEMBER_ID,
  proposedWriteArtifact,
  writeAllowlist,
  writeContract,
  writeScreens,
  writeTransitions,
} from "./fixtures/write-flow.js";
import {
  type InvocationApprovalOptions,
  invocationApprovalFixture,
} from "./support/invocation-approval.js";
import { eventsOf, journalText } from "./support/journal.js";

const TENANT = { tenantId: "riverbend", appInstanceId: "riverbend-mock" };
const ARGS = { memberId: WRITE_MEMBER_ID } as const;
const ARTIFACT_KEY_ID = "artifact-write-approval-key";

let artifactSigner: ApprovalSigner;
let artifactTrustedKey: TrustedKey;
let approvedArtifact: CapabilityArtifact;

beforeAll(async () => {
  const pair = generateApprovalKeyPair(ARTIFACT_KEY_ID);
  artifactSigner = pair.signer;
  artifactTrustedKey = pair.trustedKey;
  approvedArtifact = await approvedWriteArtifact(proposedWriteArtifact());
});

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
    ids: sequentialIds("write-draft"),
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

type ApprovalOverrides = Omit<InvocationApprovalOptions, "artifact" | "contract" | "args"> & {
  readonly artifact?: CapabilityArtifact;
  readonly contract?: CapabilityContract;
  readonly args?: Readonly<Record<string, unknown>>;
};

function invocationApproval(overrides: ApprovalOverrides = {}): InvocationApprovalGrant {
  const args = overrides.args ?? ARGS;
  return invocationApprovalFixture({
    artifact: overrides.artifact ?? approvedArtifact,
    contract: overrides.contract ?? writeContract,
    args,
    tenant: TENANT,
    ...overrides,
  }).grant;
}

interface RunWriteOptions {
  readonly artifact?: CapabilityArtifact;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly transitions?: readonly MockTransition[];
  readonly allowlist?: Allowlist;
  readonly invocationApproval?: InvocationApprovalGrant | null;
  readonly idempotencyKey?: string | null;
  readonly dryRun?: ReplayOptions["dryRun"];
}

async function runWrite(options: RunWriteOptions = {}) {
  const surface = writeSurface(options.transitions ?? writeTransitionsForMock());
  const clock = manualClock();
  const evidence = new MemoryEvidenceSink();
  const out = await replay({
    contract: writeContract,
    artifact: options.artifact ?? approvedArtifact,
    args: options.args ?? ARGS,
    tenant: TENANT,
    allowlist: options.allowlist ?? writeAllowlist("WRITE_IRREVERSIBLE"),
    broker: new StaticSessionBroker(surface),
    trust: ed25519Trust([artifactTrustedKey]),
    clock,
    ids: sequentialIds("write-boundary"),
    evidence,
    journal: (runId) => new MemoryJournal({ runId, clock }),
    onIntervention: "fail",
    ...(options.invocationApproval === undefined
      ? {}
      : { invocationApproval: options.invocationApproval }),
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
  });
  return { ...out, surface, clock, evidence };
}

const confirmClicks = (surface: MockSurface): number =>
  surface.dispatched.filter(
    (d) => d.action.kind === "click" && d.action.target === WRITE_IDS.confirmButton,
  ).length;

const openClicks = (surface: MockSurface): number =>
  surface.dispatched.filter((d) => d.action.kind === "click" && d.action.target === IDS.openLink)
    .length;

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

describe("runtime invocation approval at the write boundary", () => {
  it("refuses before the irreversible action when no invocation approval is present", async () => {
    const { result, journal, surface, evidence } = await runWrite();

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.class).toBe("approval-required");
    expect(result.failure.sideEffects).toBe("possible");
    expect(confirmClicks(surface)).toBe(0);
    expect(eventsOf(journal, "acted").map((e) => e.stepId)).not.toContain("confirm-open");
    expect(eventsOf(journal, "approval.refused")[0]).toMatchObject({
      reason: "request-binding-missing",
      stepId: "confirm-open",
      effect: "WRITE_IRREVERSIBLE",
    });
    expect(journalText(journal)).not.toContain(WRITE_MEMBER_ID);
    const evidenceText = evidence.refs().map((ref) => JSON.stringify(evidence.get(ref))).join("\n");
    expect(evidenceText).not.toContain(WRITE_MEMBER_ID);
  });

  it("dry-runs through reversible work and reports the irreversible boundary", async () => {
    const { result, dryBoundary, surface, journal } = await runWrite({
      dryRun: { stopBeforeEffect: "WRITE_IRREVERSIBLE" },
    });

    expect(result.status).toBe("ok");
    expect(dryBoundary).toEqual({
      stepId: "confirm-open",
      stepIndex: 4,
      effect: "WRITE_IRREVERSIBLE",
      expectedAction: "click",
      requiresApproval: true,
    });
    expect(confirmClicks(surface)).toBe(0);
    expect(surface.screen).toBe("new-subaccount");
    expect(eventsOf(journal, "approval.accepted")).toHaveLength(0);
    expect(eventsOf(journal, "approval.refused")).toHaveLength(0);
  });

  it("accepts a scoped invocation approval and commits exactly once", async () => {
    const idempotencyKey = "write-valid-1";
    const { result, journal, surface, evidence } = await runWrite({
      invocationApproval: invocationApproval({
        approvalId: "approval-runtime-valid-1",
        idempotencyKey,
      }),
      idempotencyKey,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.outputs.confirmation).toBe("sub-account sa-77120 opened for member 50001");
    expect(confirmClicks(surface)).toBe(1);
    expect(eventsOf(journal, "approval.accepted")).toHaveLength(1);
    expect(eventsOf(journal, "approval.refused")).toHaveLength(0);
    expect(journalText(journal)).not.toContain(WRITE_MEMBER_ID);
    const evidenceText = evidence.refs().map((ref) => JSON.stringify(evidence.get(ref))).join("\n");
    expect(evidenceText).not.toContain(WRITE_MEMBER_ID);
  });

  const rejectionCases: readonly {
    readonly name: string;
    readonly expected: string;
    readonly grant: () => InvocationApprovalGrant;
    readonly idempotencyKey?: string;
  }[] = [
    {
      name: "wrong artifact digest",
      expected: "artifact-digest-mismatch",
      grant: () =>
        invocationApproval({
          approvalId: "approval-runtime-wrong-artifact",
          artifactDigest: digestOf("wrong-artifact"),
        }),
    },
    {
      name: "wrong contract digest",
      expected: "contract-digest-mismatch",
      grant: () =>
        invocationApproval({
          approvalId: "approval-runtime-wrong-contract",
          contractDigest: digestOf("wrong-contract"),
        }),
    },
    {
      name: "expired approval",
      expected: "approval-expired",
      grant: () =>
        invocationApproval({
          approvalId: "approval-runtime-expired",
          expiresAt: "2026-02-11T13:59:59.000Z",
        }),
    },
    {
      name: "wrong tenant",
      expected: "tenant-not-in-scope",
      grant: () =>
        invocationApproval({
          approvalId: "approval-runtime-wrong-tenant",
          tenant: { tenantId: "summit", appInstanceId: "riverbend-mock" },
        }),
    },
    {
      name: "wrong app instance",
      expected: "app-instance-not-in-scope",
      grant: () =>
        invocationApproval({
          approvalId: "approval-runtime-wrong-app",
          tenant: { tenantId: "riverbend", appInstanceId: "riverbend-branch-mock" },
        }),
    },
    {
      name: "old approval policy",
      expected: "policy-version-mismatch",
      grant: () =>
        invocationApproval({
          approvalId: "approval-runtime-old-policy",
          policyVersion: "crr-approval-policy/old",
        }),
    },
    {
      name: "READ ceiling",
      expected: "effect-class-escalation",
      grant: () =>
        invocationApproval({
          approvalId: "approval-runtime-read-ceiling",
          ceiling: "READ",
        }),
    },
    {
      name: "WRITE_REVERSIBLE ceiling",
      expected: "effect-class-escalation",
      grant: () =>
        invocationApproval({
          approvalId: "approval-runtime-reversible-ceiling",
          ceiling: "WRITE_REVERSIBLE",
        }),
    },
    {
      name: "untrusted signer",
      expected: "signer-unknown",
      grant: () =>
        invocationApproval({
          approvalId: "approval-runtime-untrusted",
          untrustedSigner: true,
        }),
    },
    {
      name: "revoked signer key",
      expected: "signer-key-revoked",
      grant: () =>
        invocationApproval({
          approvalId: "approval-runtime-revoked-key",
          trustStatus: "revoked",
          revokedReason: "operator left the credit union",
        }),
    },
    {
      name: "revoked approval id",
      expected: "approval-revoked",
      grant: () =>
        invocationApproval({
          approvalId: "approval-runtime-revoked-approval",
          trustRevocations: [
            {
              approvalId: "approval-runtime-revoked-approval",
              reason: "duplicate member request",
              revokedAt: "2026-02-11T14:02:00.000Z",
              revokedBy: "ops-risk",
            },
          ],
        }),
    },
    {
      name: "args hash mismatch",
      expected: "args-hash-mismatch",
      grant: () =>
        invocationApproval({
          approvalId: "approval-runtime-wrong-args",
          argsHash: digestOf("other-args"),
        }),
    },
    {
      name: "missing idempotency binding",
      expected: "idempotency-key-mismatch",
      idempotencyKey: "write-key-missing-binding",
      grant: () =>
        invocationApproval({
          approvalId: "approval-runtime-missing-idempotency",
          idempotencyKey: null,
        }),
    },
    {
      name: "idempotency key mismatch",
      expected: "idempotency-key-mismatch",
      idempotencyKey: "write-key-presented",
      grant: () =>
        invocationApproval({
          approvalId: "approval-runtime-wrong-idempotency",
          idempotencyKey: "write-key-approved",
        }),
    },
  ];

  for (const scenario of rejectionCases) {
    it(`rejects ${scenario.name} without dispatching the irreversible action`, async () => {
      const { result, journal, surface } = await runWrite({
        invocationApproval: scenario.grant(),
        ...(scenario.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: scenario.idempotencyKey }),
      });

      expect(result.status).toBe("failed");
      if (result.status !== "failed") return;
      expect(result.failure.class).toBe("approval-required");
      expect(confirmClicks(surface)).toBe(0);
      expect(eventsOf(journal, "acted").map((e) => e.stepId)).not.toContain("confirm-open");
      expect(eventsOf(journal, "approval.refused")[0]).toMatchObject({
        reason: scenario.expected,
        stepId: "confirm-open",
      });
    });
  }
});

describe("policy and idempotency stay independent of approval", () => {
  it("refuses at policy maxEffect READ before dispatching the first write step", async () => {
    const artifact = await approvedWriteArtifact(proposedWriteArtifact({ irreversibleAt: "open" }));
    const { result, surface } = await runWrite({
      artifact,
      allowlist: { ...writeAllowlist("WRITE_IRREVERSIBLE"), maxEffect: "READ" },
      invocationApproval: invocationApproval({
        approvalId: "approval-runtime-policy-read",
        artifact,
      }),
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.class).toBe("policy-denied");
    expect(openClicks(surface)).toBe(0);
    expect(confirmClicks(surface)).toBe(0);
    expect(surface.screen).toBe("results");
  });

  it("refuses WRITE_IRREVERSIBLE when policy only allows WRITE_REVERSIBLE", async () => {
    const { result, journal, surface } = await runWrite({
      allowlist: ceilingAllowlist("WRITE_REVERSIBLE"),
      invocationApproval: invocationApproval({
        approvalId: "approval-runtime-policy-reversible",
      }),
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.class).toBe("policy-denied");
    expect(confirmClicks(surface)).toBe(0);
    expect(eventsOf(journal, "approval.accepted")).toHaveLength(1);
  });

  it("still applies the action allowlist when approval is valid", async () => {
    const base = writeAllowlist("WRITE_IRREVERSIBLE");
    const { result, surface } = await runWrite({
      allowlist: {
        ...base,
        actionKinds: base.actionKinds.filter((kind) => kind !== "click"),
      },
      invocationApproval: invocationApproval({
        approvalId: "approval-runtime-action-allowlist",
      }),
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.class).toBe("policy-denied");
    expect(confirmClicks(surface)).toBe(0);
  });

  it("passes invocation approval through the model-facing tool boundary", async () => {
    const surface = writeSurface();
    const clock = manualClock();
    const evidence = new MemoryEvidenceSink();
    const idempotencyKey = "write-tool-boundary-1";
    const catalog = new Catalog({
      trust: ed25519Trust([artifactTrustedKey]),
      clock,
      ids: sequentialIds("write-tool"),
      evidence,
      journal: (runId) => new MemoryJournal({ runId, clock }),
    }).register({
      contract: writeContract,
      artifact: approvedArtifact,
      allowlist: writeAllowlist("WRITE_IRREVERSIBLE"),
      broker: new StaticSessionBroker(surface),
    });

    const view = await catalog.callTool(toolNameOf(writeContract.name), ARGS, {
      tenant: TENANT,
      onIntervention: "fail",
      correlation: { agentSessionId: "agent-turn-1", requestedBy: "agent" },
      idempotencyKey,
      invocationApproval: invocationApproval({
        approvalId: "approval-runtime-tool-boundary",
        idempotencyKey,
      }),
    });

    expect(view.status).toBe("ok");
    expect(confirmClicks(surface)).toBe(1);
  });

  it("deduplicates a repeated idempotency key instead of opening twice", async () => {
    const surface = writeSurface();
    const clock = manualClock();
    const evidence = new MemoryEvidenceSink();
    const idempotency = new MemoryIdempotencyStore();
    const idempotencyKey = "write-idempotency-1";
    const invocationApprovalGrant = invocationApproval({
      approvalId: "approval-runtime-idempotency",
      idempotencyKey,
    });
    const invocation = {
      capability: {
        name: writeContract.name,
        version: writeContract.version,
        contractDigest: writeContract.digest,
      },
      tenant: TENANT,
      args: ARGS,
      approval: "legacy-type-token",
      idempotencyKey,
      onIntervention: "fail",
      correlation: { agentSessionId: "agent-turn-1", requestedBy: "agent" },
    } as never;
    const host: InvokeHost = {
      artifact: approvedArtifact,
      broker: new StaticSessionBroker(surface),
      allowlist: writeAllowlist("WRITE_IRREVERSIBLE"),
      trust: ed25519Trust([artifactTrustedKey]),
      invocationApproval: invocationApprovalGrant,
      clock,
      ids: sequentialIds("write-idem"),
      evidence,
      journal: (runId) => new MemoryJournal({ runId, clock }),
      idempotency,
    };

    const first = await invokeDetailed(writeContract, invocation, host);
    const second = await invokeDetailed(writeContract, invocation, host);

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(first.result.status).toBe("ok");
    expect(second.result.status).toBe("ok");
    expect(confirmClicks(surface)).toBe(1);
    expect(idempotency.size).toBe(1);
  });

  it("reports effect-in-doubt after a dispatched irreversible action is no longer observable", async () => {
    const transitions = writeTransitionsForMock().map((transition) =>
      transition.from === "new-subaccount" ? timeoutAfterCommit(transition) : transition,
    );
    const { result, surface } = await runWrite({
      transitions,
      invocationApproval: invocationApproval({
        approvalId: "approval-runtime-effect-in-doubt",
      }),
    });

    expect(confirmClicks(surface)).toBe(1);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.class).toBe("effect-in-doubt");
    expect(result.failure.sideEffects).toBe("in-doubt");
    expect(result.failure.retriable).toBe("no");
  });
});

function timeoutAfterCommit(transition: MockTransition): MockTransition {
  return {
    ...transition,
    via: [{ kind: "fault", fault: { kind: "perceive-timeout", elapsedMs: 0 } }],
  };
}
