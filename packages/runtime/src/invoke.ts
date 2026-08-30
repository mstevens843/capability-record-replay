// `invoke` - the host an AI agent actually calls, and the three guarantees it makes.
//
// 1. IT NEVER REJECTS. Not on a business outcome, not on a hard failure, not on a validation error,
//    not on a bug in this file. A rejected promise from `invoke` is a bug in the host, and the
//    reason is not stylistic: the caller is frequently an LLM harness, and a thrown exception at a
//    tool boundary is a crash the model cannot see, cannot reason about, and cannot report honestly
//    to a member. Everything unexpected becomes `failed / internal-invariant` - "a system that
//    cannot say 'I am broken' says 'you are' instead".
//
// 2. IT PINS THE CONTRACT DIGEST. `Invocation.capability.contractDigest` is what the caller's
//    GENERATED types were built from. The host compares it against the contract it loaded, and a
//    mismatch is `failed / contract-stale` before a session is brokered. This closes the one silent
//    hole in the typed-outcome mechanism: if a generated declaration is stale, or `C["outcomes"]`
//    widened to `readonly OutcomeDecl[]` instead of a literal tuple, the caller's exhaustive
//    `switch` decays into a string comparison and the runtime can hand it an outcome its types have
//    never heard of. The pin turns that into a LOUD failure at exactly the moment the type-level
//    mechanism would otherwise fail without a sound. The comparison itself is linker check 4; this
//    module's job is to make sure the pin is always supplied.
//
// 3. IT DE-DUPLICATES. `idempotencyKey` returns the PRIOR RESULT rather than re-driving the UI,
//    and a concurrent repeat awaits the first run rather than racing it. Retries at the agent layer
//    are inevitable, and a retried WRITE against a legacy screen is how a member gets two
//    sub-accounts.
//
// WHERE THE TYPE COMES FROM. `replay` returns a validated `ReplayResultDocument` - the erased,
// schema-checked shape. `invoke` returns `ReplayResult<C>`, which is a COMPILE-TIME REFINEMENT of
// exactly that runtime shape: same fields, literal types on the discriminants. The cast at the
// boundary is sound precisely because of guarantee 2 - the digest pin is what makes "the contract
// the caller's types were generated from is the contract that ran" a checked fact rather than an
// assumption. Remove the pin and the cast becomes a lie; that is the trade SPEC section 12.1
// decision 4 records.

import {
  type Allowlist,
  type ApprovalTrust,
  type CapabilityArtifact,
  type CapabilityContract,
  type CapabilityOverlay,
  type ReplayResult,
  type ReplayResultDocument,
  ReplayResultSchema,
  type WithApproval,
  digestOf,
} from "@crr/core";
import { type ApprovalGrant, approvalGrant, type InvocationApprovalGrant } from "./approval.js";
import { type Clock, systemClock } from "./clock.js";
import { type EvidenceSink, MemoryEvidenceSink } from "./evidence.js";
import { type IdSource, evidenceRefOf, randomIds } from "./ids.js";
import { type Journal, MemoryJournal } from "./journal.js";
import { ENGINE_VERSION, type ReplayOptions, replay } from "./replay.js";
import type { SessionBroker } from "./session.js";

/** What the host needs in order to run one capability that is not on the invocation itself. */
export interface InvokeHost {
  /** The program that implements this contract for this tenant. A host with several may choose by
   *  tenant; the signature takes the whole invocation so it can. */
  readonly artifact: CapabilityArtifact;
  /** Per-tenant overrides, or `null`. The base artifact is runnable on its own. */
  readonly overlay?: CapabilityOverlay | null;
  readonly broker: SessionBroker;
  readonly allowlist: Allowlist;
  readonly trust: ApprovalTrust;
  /** Required by the TYPE when the capability is irreversible - see `WithApproval` - and this is
   *  where the token the caller supplied is turned into a grant over the artifact's digest. */
  readonly approval?: ApprovalGrant | null;
  readonly invocationApproval?: InvocationApprovalGrant | null;
  readonly approvalPolicyVersion?: string;
  readonly clock?: Clock;
  readonly ids?: IdSource;
  readonly journal?: ReplayOptions["journal"];
  readonly evidence?: EvidenceSink;
  readonly mode?: "replay" | "verification";
  readonly actorId?: string;
  readonly perceiveDeadlineMs?: number;
  /** Where a repeat `idempotencyKey` is looked up. Absent means no de-duplication at all, which is
   *  the honest default for a host that has not been given somewhere to remember. */
  readonly idempotency?: IdempotencyStore | null;
}

/** Everything one invocation produced, for an evidence bundle or a conformance harness. */
export interface InvokeOutput<C extends CapabilityContract> {
  readonly result: ReplayResult<C>;
  /** The same result as the validated, generic-erased document. What gets written to disk. */
  readonly document: ReplayResultDocument;
  readonly journal: Journal;
  readonly evidence: EvidenceSink;
  /** True when this result came back from the idempotency store and no UI was driven. */
  readonly deduplicated: boolean;
}

// ---------------------------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------------------------

/**
 * Where a repeat key finds its prior result.
 *
 * It stores a PROMISE rather than a value, and that is the whole design. Storing the finished
 * result de-duplicates a retry that arrives after the first run ended, which is the easy half; two
 * calls with the same key arriving a millisecond apart both miss a value cache and both drive the
 * UI, which is the half that opens the second sub-account. Awaiting the in-flight promise costs one
 * map entry and closes it.
 */
export interface IdempotencyStore {
  get(key: string): Promise<InvokeOutput<CapabilityContract>> | undefined;
  set(key: string, run: Promise<InvokeOutput<CapabilityContract>>): void;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly #entries = new Map<string, Promise<InvokeOutput<CapabilityContract>>>();

  get(key: string): Promise<InvokeOutput<CapabilityContract>> | undefined {
    return this.#entries.get(key);
  }

  set(key: string, run: Promise<InvokeOutput<CapabilityContract>>): void {
    this.#entries.set(key, run);
  }

  get size(): number {
    return this.#entries.size;
  }
}

/**
 * The key. Scoped by capability NAME AND VERSION, never by the key alone.
 *
 * Two capabilities sharing an agent's request id is not a hypothetical - an agent that keys on its
 * own turn id does exactly that when one turn calls two tools - and returning capability A's result
 * for a call to capability B is a wrong answer with a plausible shape, which is the worst kind this
 * system can emit.
 */
export function idempotencyKeyOf(capability: { name: string; version: string }, key: string) {
  return `${capability.name}@${capability.version}#${key}`;
}

// ---------------------------------------------------------------------------------------------
// invoke
// ---------------------------------------------------------------------------------------------

/**
 * Run one capability, typed by its contract, and return one of four arms.
 *
 * The signature is SPEC section 2.6's, plus the host. `WithApproval<C>` is what makes the approval
 * token required by the TYPE when the capability is irreversible and forbidden when it is not: you
 * cannot forget it, and you cannot smuggle one onto a read to look important.
 */
export async function invoke<C extends CapabilityContract>(
  contract: C,
  inv: WithApproval<C>,
  host: InvokeHost,
): Promise<ReplayResult<C>> {
  return (await invokeDetailed(contract, inv, host)).result;
}

export async function invokeDetailed<C extends CapabilityContract>(
  contract: C,
  inv: WithApproval<C>,
  host: InvokeHost,
): Promise<InvokeOutput<C>> {
  const store = host.idempotency ?? null;
  const key =
    inv.idempotencyKey === undefined || store === null
      ? null
      : idempotencyKeyOf(inv.capability, inv.idempotencyKey);

  if (key !== null && store !== null) {
    const prior = store.get(key);
    if (prior !== undefined) {
      const settled = await prior;
      return { ...settled, deduplicated: true } as InvokeOutput<C>;
    }
    const running = runOnce(contract, inv, host) as Promise<InvokeOutput<CapabilityContract>>;
    store.set(key, running);
    return (await running) as InvokeOutput<C>;
  }

  return runOnce(contract, inv, host);
}

/**
 * The body, wrapped so that nothing escapes as a rejection.
 *
 * The `catch` is not defensive decoration. `replay` returns its own failures as values, so reaching
 * here means something threw that was not supposed to: a broker that could not reach the app, a
 * driver that raised on `capabilities()`, a bug in this package. All three are `internal-invariant`
 * - the class that exists so the engine can say "I am broken" instead of blaming the caller - and
 * all three carry `sideEffects: "possible"`, because a throw from inside a run cannot prove nothing
 * was dispatched.
 */
async function runOnce<C extends CapabilityContract>(
  contract: C,
  inv: WithApproval<C>,
  host: InvokeHost,
): Promise<InvokeOutput<C>> {
  const clock = host.clock ?? systemClock();
  const ids = host.ids ?? randomIds();
  const evidence = host.evidence ?? new MemoryEvidenceSink();
  let journal: Journal | null = null;

  try {
    const out = await replay({
      contract,
      artifact: host.artifact,
      overlay: host.overlay ?? null,
      args: inv.args as Readonly<Record<string, unknown>>,
      tenant: { tenantId: inv.tenant.tenantId, appInstanceId: inv.tenant.appInstanceId },
      allowlist: host.allowlist,
      broker: host.broker,
      trust: host.trust,
      approval:
        "approval" in inv && inv.approval !== undefined
          ? approvalGrant(host.artifact.digest, inv.approval)
          : (host.approval ?? null),
      invocationApproval: host.invocationApproval ?? null,
      ...(host.approvalPolicyVersion === undefined
        ? {}
        : { approvalPolicyVersion: host.approvalPolicyVersion }),
      ...(inv.idempotencyKey === undefined ? {} : { idempotencyKey: inv.idempotencyKey }),
      clock,
      ids,
      evidence,
      ...(host.journal === undefined ? {} : { journal: host.journal }),
      ...(host.mode === undefined ? {} : { mode: host.mode }),
      ...(host.actorId === undefined ? {} : { actorId: host.actorId }),
      ...(host.perceiveDeadlineMs === undefined
        ? {}
        : { perceiveDeadlineMs: host.perceiveDeadlineMs }),
      onIntervention: inv.onIntervention,
      ...(inv.budget === undefined ? {} : { budgetCeiling: inv.budget }),
      // GUARANTEE 2. Always supplied, never conditional: an invocation with no pin makes linker
      // check 4 vacuous, and a check that a caller can switch off by omitting a field is not a
      // check. The invocation type requires it, so there is nothing to fall back to.
      invocation: {
        name: inv.capability.name,
        version: inv.capability.version,
        contractDigest: inv.capability.contractDigest,
      },
    });
    journal = out.journal;
    return {
      // Sound because of the digest pin - see the module header.
      result: out.result as unknown as ReplayResult<C>,
      document: out.result,
      journal: out.journal,
      evidence: out.evidence,
      deduplicated: false,
    };
  } catch (error) {
    const runId = ids.runId();
    const at = clock.now();
    const sink = evidence;
    const book = journal ?? new MemoryJournal({ runId, clock });
    const document = internalInvariant({
      error,
      runId,
      at,
      contract,
      artifact: host.artifact,
      overlay: host.overlay ?? null,
      tenant: inv.tenant,
      evidence: sink,
      journal: book,
    });
    return {
      result: document as unknown as ReplayResult<C>,
      document,
      journal: book,
      evidence: sink,
      deduplicated: false,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// The arm of last resort
// ---------------------------------------------------------------------------------------------

/**
 * A thrown error, as a result document.
 *
 * The message is included because an operator needs it and it did not come from the surface - it
 * came from this process. It is clipped, and it is the only place in the failed arm where text this
 * package did not author appears; the `expected`/`observed` halves stay generated, so the taint
 * guarantees on those are untouched.
 */
function internalInvariant(args: {
  readonly error: unknown;
  readonly runId: string;
  readonly at: string;
  readonly contract: CapabilityContract;
  readonly artifact: CapabilityArtifact;
  readonly overlay: CapabilityOverlay | null;
  readonly tenant: { readonly tenantId: string; readonly appInstanceId: string };
  readonly evidence: EvidenceSink;
  readonly journal: Journal;
}): ReplayResultDocument {
  const message = args.error instanceof Error ? args.error.message : String(args.error);
  const journalRef = args.evidence.putJson("journal", args.journal.events);

  return ReplayResultSchema.parse({
    status: "failed",
    failure: {
      class: "internal-invariant",
      // Not `null`. A null step means a pre-flight failure, which the schema reads as
      // `sideEffects: "none-guaranteed"` - and a throw from inside a run has proved no such thing.
      // The artifact's first step is where the run was at the earliest; naming it is honest about
      // the fact that we do not know how far it got.
      atStep: args.artifact.flow.steps[0]?.id ?? null,
      stepIndex: args.artifact.flow.steps.length === 0 ? null : 0,
      sideEffects: args.artifact.flow.steps.length === 0 ? "none-guaranteed" : "possible",
      expected: {
        rendered: "the replay host completed a run and returned one of four arms",
        clauses: [],
      },
      observed: {
        route: null,
        settled: false,
        pendingReason: null,
        skeletonDigest: "no-observation",
        nodeCount: 0,
        nativeDialog: null,
        inputIntercepted: false,
        salient: [],
        redactionsApplied: 0,
      },
      attempts: [],
      retriable: "after-human-action",
      operatorAction: `The replay host threw instead of returning a result: ${clip(message)}. This is an engine bug; capture the journal and the run id.`,
      observationRef: evidenceRefOf("obs", digestOf(null)),
    },
    run: emptyEnvelope({ ...args, journalRef }),
  }) as ReplayResultDocument;
}

function emptyEnvelope(args: {
  readonly runId: string;
  readonly at: string;
  readonly contract: CapabilityContract;
  readonly artifact: CapabilityArtifact;
  readonly overlay: CapabilityOverlay | null;
  readonly tenant: { readonly tenantId: string; readonly appInstanceId: string };
  readonly evidence: EvidenceSink;
  readonly journalRef: string;
}): Record<string, unknown> {
  const budgets = args.artifact.budgets;
  return {
    runId: args.runId,
    capability: { name: args.contract.name, version: args.contract.version },
    artifact: {
      artifactId: args.artifact.artifactId,
      version: args.artifact.version,
      digest: args.artifact.digest,
      overlayDigest: args.overlay?.digest ?? null,
      effectiveDigest: args.artifact.digest,
    },
    tenant: args.tenant,
    surface: args.artifact.target.surfaceKind,
    engineVersion: ENGINE_VERSION,
    startedAt: args.at,
    endedAt: args.at,
    durationMs: 0,
    stepsExecuted: 0,
    stepsTotal: args.artifact.flow.steps.length,
    budgets: {
      actions: { used: 0, limit: budgets.maxActions },
      observations: { used: 0, limit: budgets.maxObservations },
      remediations: { used: 0, limit: budgets.maxTotalRemediations },
      programAttempts: { used: 0, limit: budgets.maxProgramAttempts },
      wallClockMs: { used: 0, limit: budgets.deadlineMs },
    },
    recoveriesApplied: [],
    attribution: { by: "automation", transfers: [] },
    steps: [],
    drift: {
      fingerprint: "fp:not-run",
      expected: "fp:not-run",
      divergence: 0,
      changed: [],
      needsSpecialization: false,
    },
    evidence: args.evidence.refs(),
    journalRef: args.journalRef,
    warnings: [],
  };
}

function clip(text: string): string {
  return text.length <= 300 ? text : `${text.slice(0, 300)}...`;
}
