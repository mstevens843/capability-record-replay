// The catalog: saved artifacts, exposed as callable capabilities an AI agent discovers by name.
//
// This is the production door. Everything upstream of it - the discovery loop, synthesis, the
// verification replay, approval - exists to put a document in here; everything downstream of it is
// an agent calling `read_share_position` with a member number and receiving one of four arms. There
// is NO MODEL ANYWHERE IN THIS FILE and none in anything it calls, which is the claim the whole
// project is built to make.
//
// THREE THINGS THE CATALOG OWNS, and the reason each is here rather than in `invoke.ts`:
//
//   1. IDENTITY. The contract that LINKS is the one the catalog loaded, never the one the caller
//      handed in. That is what makes the digest pin mean anything: a host that links the caller's
//      own copy of the contract is comparing a document to itself and will report `contract-stale`
//      exactly never. `invoke`'s `contract` argument is there to carry the caller's TYPES, and the
//      catalog says so out loud rather than leaving it to be discovered.
//   2. RESOLUTION. Contract name -> artifact -> per-tenant overlay. SPEC section 9's base-plus-
//      overlay is a lookup, and this is where the lookup happens; the linker re-checks the merge it
//      produces, so a wrong overlay is a refusal rather than a silently different program.
//   3. THE TWO DOORS. `invoke` returns a typed union to a PROGRAM. `callTool` takes the raw JSON of
//      a `tool_use.input`, runs the same path, and returns the deliberately poorer `AgentToolResult`
//      a MODEL sees. Two audiences, one result (SPEC section 2.7) - and the fact that the model's
//      door is a thin wrapper over the program's is the reason the two cannot drift.

import {
  type AgentToolResult,
  type Allowlist,
  type ApprovalTrust,
  type CapabilityArtifact,
  type CapabilityContract,
  type CapabilityOverlay,
  type Digest,
  type ReplayResult,
  type ReplayResultDocument,
  ReplayResultSchema,
  type WithApproval,
  digestOf,
  sealContract,
} from "@crr/core";
import { renderForAgent } from "./agent-view.js";
import type { ApprovalGrant, InvocationApprovalGrant } from "./approval.js";
import { type Clock, systemClock } from "./clock.js";
import { type EvidenceSink, MemoryEvidenceSink } from "./evidence.js";
import { type IdSource, evidenceRefOf } from "./ids.js";
import {
  type IdempotencyStore,
  type InvokeHost,
  type InvokeOutput,
  invokeDetailed,
} from "./invoke.js";
import { type Journal, MemoryJournal } from "./journal.js";
import { ENGINE_VERSION, type ReplayOptions } from "./replay.js";
import type { SessionBroker } from "./session.js";
import type { FileDocumentStore } from "./store.js";
import {
  type CatalogEntry,
  type ToolDefinition,
  catalogEntryOf,
  toolDefinitionOf,
} from "./tools.js";

/** One capability, registered. The overlay map is keyed by tenant id; a tenant with no entry runs
 *  the base artifact, which is what "the overlay is additive and optional" means operationally. */
export interface CapabilityRegistration {
  readonly contract: CapabilityContract;
  readonly artifact: CapabilityArtifact;
  readonly overlays?: Readonly<Record<string, CapabilityOverlay>>;
  /** Per-capability, because a read capability and an irreversible one should not share one. */
  readonly allowlist: Allowlist;
  readonly broker: SessionBroker;
}

export interface CatalogOptions {
  readonly trust: ApprovalTrust;
  readonly clock?: Clock;
  readonly ids?: IdSource;
  readonly journal?: ReplayOptions["journal"];
  readonly evidence?: EvidenceSink;
  readonly mode?: "replay" | "verification";
  readonly actorId?: string;
  readonly perceiveDeadlineMs?: number;
  readonly invocationApproval?: InvocationApprovalGrant | null;
  readonly approvalPolicyVersion?: string;
  /** Shared across every capability, because an agent's dedupe key is scoped to its own turn and
   *  not to one tool. `idempotencyKeyOf` re-scopes it by capability so two tools in one turn cannot
   *  read each other's result. */
  readonly idempotency?: IdempotencyStore | null;
}

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

/** What a model's harness supplies alongside the tool arguments. It is not the model's to choose. */
export interface ToolCallContext {
  readonly tenant: { readonly tenantId: string; readonly appInstanceId: string };
  /** SPEC section 2.6: what THIS caller can tolerate when the run gets stuck. A batch job says
   *  "fail" and goes home; a live conversational turn says "suspend" and picks the run back up. */
  readonly onIntervention: "suspend" | "fail";
  readonly correlation: {
    readonly agentSessionId: string;
    readonly requestedBy: "agent" | "human" | "schedule";
  };
  readonly idempotencyKey?: string;
  readonly budget?: { readonly wallClockMs: number; readonly maxRemediations: number };
  readonly approval?: ApprovalGrant;
  readonly invocationApproval?: InvocationApprovalGrant | null;
  readonly approvalPolicyVersion?: string;
  /**
   * The digest the harness saw when it FETCHED these tool definitions.
   *
   * Optional, and the honest reason it exists: for a model-facing call the pin is otherwise vacuous,
   * because the tool definition and the contract come from the same object in the same process.
   * Staleness is real for a harness that cached its tool list at boot while the catalog reloaded -
   * and this is the field that turns that into `contract-stale` rather than an agent calling a tool
   * whose arguments have changed underneath it.
   */
  readonly pinnedContractDigest?: string;
}

export class Catalog {
  readonly #entries = new Map<string, CapabilityRegistration>();
  readonly #options: CatalogOptions;

  constructor(options: CatalogOptions) {
    this.#options = options;
  }

  // -- registration ----------------------------------------------------------------------------

  register(registration: CapabilityRegistration): this {
    const name = registration.contract.name;
    if (registration.artifact.implements.name !== name) {
      throw new CatalogError(
        `artifact ${registration.artifact.artifactId} implements ${registration.artifact.implements.name}, not ${name}`,
      );
    }
    this.#entries.set(name, registration);
    return this;
  }

  /**
   * Register from a file-backed store: the newest artifact implementing each named contract.
   *
   * "Newest" is `latestArtifactFor`'s definition - the highest version integer, never an mtime.
   * Overlays are read per tenant id and are simply absent where the tenant has none, which is the
   * whole point of an additive overlay: adding a tenant does not touch the base document.
   */
  registerFromStore(
    store: FileDocumentStore,
    spec: {
      readonly name: string;
      readonly version: string;
      readonly tenants?: readonly string[];
      readonly allowlist: Allowlist;
      readonly broker: SessionBroker;
    },
  ): this {
    const contract = store.getContract(spec.name, spec.version);
    const artifact = store.latestArtifactFor(spec.name);
    if (artifact === null) {
      throw new CatalogError(`no artifact in ${store.root} implements ${spec.name}`);
    }
    const overlays: Record<string, CapabilityOverlay> = {};
    for (const tenantId of spec.tenants ?? []) {
      const overlay = store.getOverlay(artifact.artifactId, tenantId);
      if (overlay !== null) overlays[tenantId] = overlay;
    }
    return this.register({
      contract,
      artifact,
      overlays,
      allowlist: spec.allowlist,
      broker: spec.broker,
    });
  }

  // -- discovery -------------------------------------------------------------------------------

  /** Every registered capability as a catalog row. Ordered by name so a listing is stable. */
  entries(): readonly CatalogEntry[] {
    return this.#sorted().map((r) => catalogEntryOf(r.contract));
  }

  /** Every registered capability as a callable tool definition. */
  tools(): readonly ToolDefinition[] {
    return this.#sorted().map((r) => toolDefinitionOf(r.contract));
  }

  toolFor(capabilityName: string): ToolDefinition {
    return toolDefinitionOf(this.#require(capabilityName).contract);
  }

  contractFor(capabilityName: string): CapabilityContract {
    return this.#require(capabilityName).contract;
  }

  /** Reverse of `toolNameOf`, by lookup rather than by string surgery - the mapping is total but
   *  not obviously invertible by eye, and a catalog is the only thing that knows both spellings. */
  capabilityNameForTool(toolName: string): string | null {
    for (const entry of this.entries()) if (entry.toolName === toolName) return entry.name;
    return null;
  }

  has(capabilityName: string): boolean {
    return this.#entries.has(capabilityName);
  }

  // -- the program's door ----------------------------------------------------------------------

  /**
   * Run a capability and return one of four arms, typed by the caller's contract.
   *
   * `contract` carries the caller's TYPES. It is deliberately NOT the document that links: see the
   * module header. If the two disagree the run comes back `failed / contract-stale`, which is the
   * entire mechanism, and it only works because this method ignores the argument for that purpose.
   */
  async invoke<C extends CapabilityContract>(
    contract: C,
    inv: WithApproval<C>,
  ): Promise<ReplayResult<C>> {
    return (await this.invokeDetailed(contract, inv)).result;
  }

  async invokeDetailed<C extends CapabilityContract>(
    _contract: C,
    inv: WithApproval<C>,
  ): Promise<InvokeOutput<C>> {
    const registration = this.#entries.get(inv.capability.name);
    if (registration === undefined) return this.#unknown<C>(inv.capability.name, inv.tenant);
    return invokeDetailed(registration.contract as C, inv, this.#hostFor(registration, inv.tenant));
  }

  // -- the model's door ------------------------------------------------------------------------

  /**
   * One `tool_use` block, executed.
   *
   * `args` is whatever the model produced - `JSON.parse`d, never string-matched (BRIEF section 9) -
   * and it is passed through UNVALIDATED on purpose. Linker check 28 is the validator, it runs
   * before a session is brokered, and it returns `argument-invalid` with
   * `sideEffects: "none-guaranteed"`. Pre-validating here would produce a second, worse error
   * message for the same condition and a second place for the two to disagree.
   */
  async callTool(
    toolName: string,
    args: unknown,
    context: ToolCallContext,
  ): Promise<AgentToolResult> {
    const capabilityName = this.capabilityNameForTool(toolName) ?? toolName;
    const registration = this.#entries.get(capabilityName);
    if (registration === undefined) {
      // Not an exception. A model that called a tool that does not exist needs to be TOLD that, in
      // the same shape as every other answer, or the harness has to grow a second error path the
      // model has never seen an example of.
      return renderForAgent(
        unknownCapabilityResult(capabilityName, context.tenant, this.#options.clock),
        UNKNOWN_CAPABILITY_CONTRACT,
      );
    }
    const contract = registration.contract;
    const inv = {
      capability: {
        name: contract.name,
        version: contract.version,
        // The harness's pin is a plain string off the wire; branding is checked at the document
        // boundary and re-checked by linker check 4, which is the comparison that matters.
        contractDigest: (context.pinnedContractDigest ?? contract.digest) as Digest,
      },
      tenant: context.tenant,
      args: args as never,
      onIntervention: context.onIntervention,
      correlation: context.correlation,
      ...(context.idempotencyKey === undefined ? {} : { idempotencyKey: context.idempotencyKey }),
      ...(context.budget === undefined ? {} : { budget: context.budget }),
      ...(context.approval === undefined ? {} : { approval: context.approval.token }),
      // Through `unknown` deliberately. Every branded field on an `Invocation` - the capability
      // name, the version, the digest, the tenant - arrives here as a plain string off a transport
      // an agent harness owns, and branding is a claim about validation that this boundary has not
      // performed. The linker performs it: checks 1, 2, 4 and 28 run before a session is brokered,
      // and a tenant id or a digest that is not what it says it is comes back as a pre-flight
      // failure with zero actions taken. Asserting the brands here would move that check nowhere
      // and hide it.
    } as unknown as WithApproval<CapabilityContract>;

    const host = this.#hostFor(registration, context.tenant);
    const out = await invokeDetailed(contract, inv, {
      ...host,
      ...(context.approval === undefined ? {} : { approval: context.approval }),
      ...(context.invocationApproval === undefined
        ? {}
        : { invocationApproval: context.invocationApproval }),
      ...(context.approvalPolicyVersion === undefined
        ? {}
        : { approvalPolicyVersion: context.approvalPolicyVersion }),
    });
    return renderForAgent(out.document, contract);
  }

  // -- internals -------------------------------------------------------------------------------

  #sorted(): readonly CapabilityRegistration[] {
    return [...this.#entries.values()].sort((a, b) =>
      a.contract.name.localeCompare(b.contract.name),
    );
  }

  #require(capabilityName: string): CapabilityRegistration {
    const registration = this.#entries.get(capabilityName);
    if (registration === undefined) {
      throw new CatalogError(`no capability named ${capabilityName} is registered`);
    }
    return registration;
  }

  #hostFor(
    registration: CapabilityRegistration,
    tenant: { readonly tenantId: string },
  ): InvokeHost {
    const options = this.#options;
    return {
      artifact: registration.artifact,
      overlay: registration.overlays?.[tenant.tenantId] ?? null,
      broker: registration.broker,
      allowlist: registration.allowlist,
      trust: options.trust,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.ids === undefined ? {} : { ids: options.ids }),
      ...(options.journal === undefined ? {} : { journal: options.journal }),
      ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      ...(options.actorId === undefined ? {} : { actorId: options.actorId }),
      ...(options.perceiveDeadlineMs === undefined
        ? {}
        : { perceiveDeadlineMs: options.perceiveDeadlineMs }),
      ...(options.invocationApproval === undefined
        ? {}
        : { invocationApproval: options.invocationApproval }),
      ...(options.approvalPolicyVersion === undefined
        ? {}
        : { approvalPolicyVersion: options.approvalPolicyVersion }),
      idempotency: options.idempotency ?? null,
    };
  }

  /**
   * A capability nobody registered, as a result rather than a throw.
   *
   * `link-error` and not `contract-stale`: the caller's generated types are not the problem, the
   * deployment is. Telling an agent to regenerate its types when the host is missing an artifact
   * sends a human down the wrong path, which is the exact reason `failureClassOf` orders the
   * pre-flight classes the way it does.
   */
  #unknown<C extends CapabilityContract>(
    capabilityName: string,
    tenant: { readonly tenantId: string; readonly appInstanceId: string },
  ): InvokeOutput<C> {
    const clock = this.#options.clock ?? systemClock();
    const document = unknownCapabilityResult(capabilityName, tenant, clock);
    const journal: Journal = new MemoryJournal({ runId: document.run.runId, clock });
    return {
      result: document as unknown as ReplayResult<C>,
      document,
      journal,
      evidence: new MemoryEvidenceSink(),
      deduplicated: false,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// The unknown-capability document
// ---------------------------------------------------------------------------------------------

/**
 * A minimal, valid contract for the one case where a result must be rendered and no contract
 * exists: a model called a tool nobody registered.
 *
 * A real sealed document rather than a cast, because `renderForAgent` reads `outputs` and
 * `outcomes` off it and a cast is a lie that works right up until somebody adds a field.
 */
const UNKNOWN_CAPABILITY_CONTRACT: CapabilityContract = sealContract({
  schemaVersion: "capability.contract/v1",
  name: "catalog.unknown",
  version: "1.0.0",
  title: "Unknown capability",
  summary: "A placeholder used only to render a refusal for a capability nobody registered.",
  whenToUse: ["Never; this is not a capability."],
  whenNotToUse: ["Always."],
  inputs: [],
  outputs: [],
  outcomes: [],
  effect: "READ",
  requiresApproval: false,
  idempotent: true,
});

function unknownCapabilityResult(
  capabilityName: string,
  tenant: { readonly tenantId: string; readonly appInstanceId: string },
  clock: Clock | undefined,
): ReplayResultDocument {
  const at = (clock ?? systemClock()).now();
  const nothing = digestOf(null);
  return ReplayResultSchema.parse({
    status: "failed",
    failure: {
      class: "link-error",
      atStep: null,
      stepIndex: null,
      sideEffects: "none-guaranteed",
      expected: {
        rendered: `a capability named ${capabilityName} is registered in this catalog`,
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
      operatorAction: `No capability named ${capabilityName} is registered; deploy its contract and artifact, or correct the caller's tool name.`,
      observationRef: evidenceRefOf("obs", nothing),
    },
    run: {
      runId: "run-unregistered",
      capability: { name: "catalog.unknown", version: "1.0.0" },
      artifact: {
        artifactId: "unregistered",
        version: 1,
        digest: nothing as Digest,
        overlayDigest: null,
        effectiveDigest: nothing as Digest,
      },
      tenant,
      surface: "web-legacy",
      engineVersion: ENGINE_VERSION,
      startedAt: at,
      endedAt: at,
      durationMs: 0,
      stepsExecuted: 0,
      stepsTotal: 0,
      budgets: {
        actions: { used: 0, limit: 0 },
        observations: { used: 0, limit: 0 },
        remediations: { used: 0, limit: 0 },
        programAttempts: { used: 0, limit: 0 },
        wallClockMs: { used: 0, limit: 0 },
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
      evidence: [],
      journalRef: evidenceRefOf("json", nothing),
      warnings: [],
    },
  }) as ReplayResultDocument;
}

/** Exported for the tests that assert an unregistered tool is answered rather than thrown. */
export { unknownCapabilityResult, UNKNOWN_CAPABILITY_CONTRACT };
