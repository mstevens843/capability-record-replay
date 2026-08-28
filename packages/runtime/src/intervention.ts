// The control plane: SPEC section 7.1's state machine, and the parked runs it holds.
//
// A session has EXACTLY ONE controller. That sentence is cheap to write and it is only worth
// something if something refuses. Three things refuse here, and they refuse different callers:
//
//   1. THE DESK. Every transition is guarded by the state machine below, so an operator who has not
//      claimed cannot inject an action, and one who has cannot inject one after the intervention
//      expired. `HUMAN_OFFERED` is a real state and not a formality: between the run releasing the
//      lease and a person picking it up, NOBODY may act.
//   2. THE POLICY CHOKEPOINT. A human action goes through the same `check` as an automation action,
//      with `mode: "operator"` - which flips the expected lease holder from `automation` to `human`.
//      That is what makes "the executor rejects actions from a non-holder" symmetric: the automation
//      is refused while a human holds it, by exactly the same three lines of the same function.
//   3. THE PORT. `Surface.act(action, token)` refuses a token the driver was not granted, and every
//      transition mints a new token at a new epoch. An automation that still believes it holds a
//      session a human took forty seconds ago learns otherwise at the driver, which is the one place
//      a gate upstairs cannot see.
//
// WHAT IS DELIBERATELY THIN, and why (BRIEF section 8 forbids a React admin app, and the assignment
// puts a full co-browsing console out of scope):
//
//   · THE LIVE VIEW IS POLLED, NOT STREAMED. `Surface.capture()` returns a content-addressed REF and
//     a digest, never bytes - by design, because a capture is evidence and no decision path may read
//     pixels. So the console shows the capture's address, its mask count, and the filtered node list,
//     and re-renders on demand. Production streams frames over CDP screencast or WebRTC; that is a
//     documented seam and this is the thin-but-real version of it.
//   · THERE IS NO OPERATOR AUTHENTICATION. The desk trusts the `operatorId` the console hands it. A
//     deployment puts SSO in front of the console; building a second identity system here would be
//     the "auth service" the anti-goals name.
//   · PARKED RUNS LIVE IN MEMORY. A suspension holds a live browser or pty, so a process restart
//     loses the session anyway (SPEC section 7.5, and section 12 records it). Persisting the desk
//     without persisting the session would buy an index of dead handles.

import {
  type ActionKind,
  type Allowlist,
  type Capture,
  type ControlTransfer,
  type Controller,
  type EffectClass,
  type FailureClass,
  type Intervention,
  type InterventionId,
  InterventionSchema,
  type LeaseToken,
  type LinkedProgram,
  type NodeId,
  type Observation,
  type ObservedSummary,
  type PolicyContext,
  type PolicyDecision,
  type ReplayResultDocument,
  type ResolvedBindings,
  type ResolvedStep,
  type RunId,
  type Surface,
  type SurfaceKind,
  type SuspensionReason,
  type Timestamp,
  type UINode,
  type Verdict,
  check,
  deriveMaskRegions,
  higherEffect,
  observedSummaryOf,
  redactTaint,
  safeCaptureRequest,
} from "@crr/core";
import type { Action } from "@crr/core";
import type { ApprovalGrant } from "./approval.js";
import { type RunLedger, StepLedger } from "./budgets.js";
import type { Clock } from "./clock.js";
import type { EvidenceSink } from "./evidence.js";
import type { Journal } from "./journal.js";
import type { LeaseAuthority } from "./lease.js";
import { type ResumeCheck, resumePrecheck } from "./resume.js";

// ---------------------------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------------------------

/**
 * SPEC section 7.1's states.
 *
 * `AUTOMATION_HELD` and `RELEASING` are not reachable from the desk - by the time a run is parked
 * the interpreter has already released the lease - but they are named here because it is one
 * machine, and a state chart with two of its states living in another file is a state chart nobody
 * can check.
 */
export type ControlState =
  | "AUTOMATION_HELD"
  | "RELEASING"
  | "HUMAN_OFFERED"
  | "HUMAN_HELD"
  | "ORPHANED"
  | "TERMINATED";

/** Which controller may act in each state. `null` is a real answer and it is why `HUMAN_OFFERED`
 *  exists: between the release and the claim, nobody may touch the session. */
export const MAY_ACT: Readonly<Record<ControlState, Controller | null>> = {
  AUTOMATION_HELD: "automation",
  RELEASING: null,
  HUMAN_OFFERED: null,
  HUMAN_HELD: "human",
  ORPHANED: null,
  TERMINATED: null,
};

// ---------------------------------------------------------------------------------------------
// What a parked run is
// ---------------------------------------------------------------------------------------------

/**
 * How the run ends, once the desk knows what happened.
 *
 * ONE continuation rather than three, because the three endings differ only in what they are told.
 * The host (`replay`) closes over everything needed to build a `ReplayResultDocument` - the
 * envelope, the ledgers, the traces from every attempt - and the desk should not learn any of it.
 */
export type ResumeDisposition =
  | {
      readonly kind: "resume";
      readonly actionsPerformed: ControlTransfer["actionsPerformed"];
      readonly checks: readonly ResumeCheck[];
    }
  | {
      readonly kind: "failed";
      readonly failure: FailureClass;
      readonly notes: readonly string[];
      readonly observation: Observation | null;
      readonly checks: readonly ResumeCheck[];
    }
  | {
      readonly kind: "outcome";
      readonly verdict: Extract<Verdict, { readonly kind: "outcome" }>;
      readonly observation: Observation;
      readonly checks: readonly ResumeCheck[];
    };

export type RunContinuation = (disposition: ResumeDisposition) => Promise<ReplayResultDocument>;

/** Everything the desk needs to hold a live run open across an agent turn. */
export interface ParkedRun {
  readonly runId: RunId;
  readonly sessionId: string;
  readonly tenantId: string;
  readonly program: LinkedProgram;
  /** The step the run suspended at. Resume re-runs THIS step, never the next one. */
  readonly step: ResolvedStep;
  readonly surface: Surface;
  readonly lease: LeaseAuthority;
  readonly journal: Journal;
  readonly evidence: EvidenceSink;
  readonly ledger: RunLedger;
  readonly clock: Clock;
  readonly allowlist: Allowlist;
  readonly approval: ApprovalGrant | null;
  readonly bindings: ResolvedBindings;
  readonly perceiveDeadlineMs: number;
  /**
   * The lease token and epoch the AUTOMATION held before it released.
   *
   * Step 1 of the re-check asks the authority about THESE rather than about the current grant,
   * because `handoff-resume` is only distinguishable from `lost` if the question names the old one -
   * and a run that cannot tell "I gave this up and got it back" from "somebody took this from me"
   * fails a run a human just finished helping.
   */
  readonly heldBefore: { readonly token: LeaseToken; readonly epoch: number };
}

export interface ParkRequest {
  readonly interventionId: InterventionId;
  readonly parked: ParkedRun;
  readonly reason: SuspensionReason;
  readonly brief: Intervention["brief"];
  readonly resumeToken: string;
  readonly continuation: RunContinuation;
}

// ---------------------------------------------------------------------------------------------
// What the desk answers with
// ---------------------------------------------------------------------------------------------

export type DeskRefusalCode =
  | "unknown-intervention"
  | "wrong-state"
  | "not-holder"
  | "lease-expired"
  | "policy-denied"
  | "surface-fault"
  | "not-settled";

/** A refusal is a VALUE, never a thrown error - the same rule the policy engine follows, for the
 *  same reason: a thrown refusal is a refusal somebody can catch and continue past. */
export interface DeskRefusal {
  readonly ok: false;
  readonly code: DeskRefusalCode;
  readonly detail: string;
  /** Present when the refusal came from the chokepoint, so the console can name the rule id. */
  readonly decision?: PolicyDecision;
  readonly checks?: readonly ResumeCheck[];
}

/** One row of the live view. A redacted NAME and never a value: the console is a screen a person
 *  reads in an open-plan office, and the value is the member's. */
export interface LiveNode {
  readonly id: NodeId;
  readonly role: string | null;
  readonly name: string;
  readonly disabled: boolean;
  readonly visible: boolean;
  /** True when the driver would accept an action against it, so the console can grey the rest. */
  readonly actionable: boolean;
  readonly masked: boolean;
}

/**
 * What the operator sees, in the vocabulary of the PORT and nothing else.
 *
 * There is not one browser word in this type. The browser driver fills `capture` with a masked
 * image's content address; the character-grid driver fills it with a masked text dump's; the
 * console renders the same fields either way and posts back the same typed `Action`s. That is the
 * strongest available evidence that the seam is real - this is the one place a UI would normally
 * reach for a screenshot API, and it reaches for `Surface.capture` instead.
 */
export interface LiveView {
  readonly interventionId: InterventionId;
  readonly state: ControlState;
  readonly holder: Controller;
  readonly actorId: string;
  readonly epoch: number;
  readonly surface: SurfaceKind;
  readonly capture: Capture | null;
  readonly captureFormat: "image" | "text-grid" | null;
  /** Node ids whose pixels could not be masked, in which case NO capture was taken. A refused
   *  capture is reported; a leaked one is not recoverable. */
  readonly captureRefused: readonly NodeId[];
  readonly observed: ObservedSummary;
  readonly nodes: readonly LiveNode[];
}

export interface InterventionSummary {
  readonly id: InterventionId;
  readonly capabilityTitle: string;
  readonly tenantId: string;
  readonly reason: SuspensionReason;
  readonly stepIndex: number;
  readonly stepTitle: string;
  readonly state: ControlState;
  readonly raisedAt: Timestamp;
  readonly expiresAt: Timestamp;
  readonly ageMs: number;
  readonly expiresInMs: number;
  readonly claimedBy: string | null;
}

export interface ClaimOk {
  readonly ok: true;
  readonly intervention: Intervention;
  readonly view: LiveView;
}

export interface InjectOk {
  readonly ok: true;
  readonly decision: PolicyDecision;
  readonly view: LiveView;
}

export interface HandbackOk {
  readonly ok: true;
  readonly result: ReplayResultDocument;
  readonly checks: readonly ResumeCheck[];
}

// ---------------------------------------------------------------------------------------------
// Effect, for an action a human injected
// ---------------------------------------------------------------------------------------------

/**
 * The effect class the console attributes to an injected action.
 *
 * SPEC section 8.2's accepted limit applies here in full, and it is worth stating rather than
 * hiding: EFFECT IS DECLARED, NOT PROVEN. Nothing can tell a click on "Search" from a click on
 * "Close Account", which is exactly why the artifact declares it per step - and why this table is a
 * floor an operator may RAISE and never lower.
 *
 * What actually contains a human at this console is therefore not this table. It is the allowlist
 * (origin, route pattern, action kind, per-route effect ceiling), the lease, and the fact that the
 * desk presents NO APPROVAL TOKEN - so anything resolving to `WRITE_IRREVERSIBLE` is refused by
 * policy rule 8 outright. The console does not try to be a stronger control over a person than the
 * application's own authorization already is. It tries to be the SAME control the automation gets,
 * applied to the same session, so that a human's clicks are as auditable as a program's.
 */
export const OPERATOR_ACTION_EFFECT: Readonly<Record<ActionKind, EffectClass>> = {
  click: "READ",
  focus: "READ",
  pressKey: "READ",
  navigate: "READ",
  dismissDialog: "READ",
  type: "WRITE_REVERSIBLE",
  select: "WRITE_REVERSIBLE",
  setChecked: "WRITE_REVERSIBLE",
  // Accepting a prompt is answering "yes" to a question nobody in this process read. In a legacy
  // core, the confirm dialog is exactly where the irreversible thing happens.
  acceptDialog: "WRITE_IRREVERSIBLE",
};

// ---------------------------------------------------------------------------------------------
// The desk
// ---------------------------------------------------------------------------------------------

export interface ControlPlaneOptions {
  readonly clock: Clock;
  /**
   * How long an operator has before the suspended run converts to `failed / recovery-exhausted`
   * (SPEC section 7.1's last two rows). A suspension holds a live browser or pty; an unbounded one
   * holds it forever, and SPEC section 7.5 is explicit that a long human response time is a way for
   * a suspension to become a failure.
   */
  readonly interventionTtlMs?: number;
  /** Prefix for `Intervention.consoleUrl`. The console sets this when it learns its own port. */
  readonly consoleBaseUrl?: string;
}

const DEFAULT_TTL_MS = 900_000;

interface Entry {
  intervention: Intervention;
  readonly parked: ParkedRun;
  readonly continuation: RunContinuation;
  state: ControlState;
  operatorId: string | null;
  readonly actions: { kind: ActionKind; targetTitle: string }[];
  settled: ReplayResultDocument | null;
}

export class ControlPlane {
  readonly #clock: Clock;
  readonly #ttlMs: number;
  #baseUrl: string;
  readonly #entries = new Map<string, Entry>();

  constructor(options: ControlPlaneOptions) {
    this.#clock = options.clock;
    this.#ttlMs = options.interventionTtlMs ?? DEFAULT_TTL_MS;
    this.#baseUrl = (options.consoleBaseUrl ?? "crr://intervention").replace(/\/+$/, "");
  }

  /** Set by `startOperatorConsole`, which is the only thing that knows the real port. */
  set consoleBaseUrl(url: string) {
    this.#baseUrl = url.replace(/\/+$/, "");
    for (const entry of this.#entries.values()) {
      entry.intervention = {
        ...entry.intervention,
        consoleUrl: `${this.#baseUrl}/interventions/${entry.intervention.id}`,
      } as Intervention;
    }
  }

  // -- RELEASING -> HUMAN_OFFERED ---------------------------------------------------------------

  /**
   * Take custody of a suspended run.
   *
   * The lease has ALREADY been released by the interpreter, which is the correct order: releasing it
   * is what makes the automation's token stop validating at the port, and an operator clicking on a
   * session the automation still holds is the race this control exists to prevent. So the state
   * recorded here is `HUMAN_OFFERED` - offered to a person who has not yet picked it up, and during
   * which nobody at all may act.
   */
  park(request: ParkRequest): Intervention {
    const raisedAt = this.#clock.now();
    const intervention = InterventionSchema.parse({
      id: request.interventionId,
      runId: request.parked.runId,
      sessionId: request.parked.sessionId,
      reason: request.reason,
      raisedAt,
      expiresAt: stamp(raisedAt, this.#ttlMs),
      state: "open",
      brief: request.brief,
      resumeToken: request.resumeToken,
      consoleUrl: `${this.#baseUrl}/interventions/${request.interventionId}`,
      resolution: null,
    }) as Intervention;

    this.#entries.set(intervention.id, {
      intervention,
      parked: request.parked,
      continuation: request.continuation,
      state: "HUMAN_OFFERED",
      operatorId: null,
      actions: [],
      settled: null,
    });
    return intervention;
  }

  // -- reading ---------------------------------------------------------------------------------

  /** Open interventions, newest first. SPEC section 7.3's `GET /interventions`. */
  async list(): Promise<readonly InterventionSummary[]> {
    await this.sweep();
    const now = Date.parse(this.#clock.now());
    return [...this.#entries.values()]
      .map((entry) => ({
        id: entry.intervention.id,
        capabilityTitle: entry.intervention.brief.capabilityTitle,
        tenantId: entry.parked.tenantId,
        reason: entry.intervention.reason,
        stepIndex: entry.intervention.brief.stepIndex,
        stepTitle: entry.intervention.brief.stepTitle,
        state: entry.state,
        raisedAt: entry.intervention.raisedAt,
        expiresAt: entry.intervention.expiresAt,
        ageMs: Math.max(0, now - Date.parse(entry.intervention.raisedAt)),
        expiresInMs: Date.parse(entry.intervention.expiresAt) - now,
        claimedBy: entry.operatorId,
      }))
      .sort((a, b) => Date.parse(b.raisedAt) - Date.parse(a.raisedAt));
  }

  get(id: string): Intervention | null {
    return this.#entries.get(id)?.intervention ?? null;
  }

  stateOf(id: string): ControlState | null {
    return this.#entries.get(id)?.state ?? null;
  }

  /** The result document a settled run produced, for a caller polling `resume.pollAfterMs`. */
  resultOf(id: string): ReplayResultDocument | null {
    return this.#entries.get(id)?.settled ?? null;
  }

  get size(): number {
    return this.#entries.size;
  }

  // -- HUMAN_OFFERED -> HUMAN_HELD --------------------------------------------------------------

  /**
   * An operator takes the session, at epoch+1.
   *
   * The epoch bump is not bookkeeping. The placeholder grant the interpreter minted on its way out
   * dies here, and so does the `resumeToken` the CALLER was handed on the suspended arm - which is
   * deliberate: that token is a handle for asking about the run, never a licence to drive it.
   */
  async claim(id: string, operatorId: string): Promise<ClaimOk | DeskRefusal> {
    const entry = await this.#live(id);
    if ("ok" in entry) return entry;
    if (entry.state !== "HUMAN_OFFERED") {
      return refuse(
        "wrong-state",
        `intervention ${id} is ${entry.state}; only an offered intervention can be claimed`,
      );
    }

    entry.parked.lease.handToHuman(operatorId, entry.intervention.id);
    entry.state = "HUMAN_HELD";
    entry.operatorId = operatorId;
    entry.intervention = { ...entry.intervention, state: "claimed" } as Intervention;
    entry.parked.journal.append({
      type: "lease.acquired",
      holder: "human",
      actorId: operatorId,
      epoch: entry.parked.lease.epoch,
    });

    const view = await this.#view(entry);
    return { ok: true, intervention: entry.intervention, view };
  }

  /** The live view, re-polled. Safe in any state - looking is not acting. */
  async view(id: string): Promise<{ readonly ok: true; readonly view: LiveView } | DeskRefusal> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return refuse("unknown-intervention", `no intervention ${id}`);
    return { ok: true, view: await this.#view(entry) };
  }

  // -- acting, in the same live session ---------------------------------------------------------

  /**
   * Inject one action into the SAME live session, policy-checked exactly like an automation action.
   *
   * NOT called `act`, and the reason is architectural rather than stylistic: the chokepoint contract
   * test reads the repo off disk and refuses any `<receiver>.act(` that is not immediately preceded
   * by a `check` on the same value. A second method spelled `.act(` on a different receiver is
   * exactly the ambiguity that scan exists to be suspicious of, and buying an exemption to keep a
   * shorter name would be trading a working control for a nicer word. `Surface.act` is the only
   * `.act` in this repository.
   *
   * `declaredEffect` may only raise the table's floor. An operator who knows the button they are
   * about to press closes an account can say so, and will then be refused for want of an approval
   * token - which is the right answer, and the reason the field exists.
   */
  async inject(
    id: string,
    operatorId: string,
    action: Action,
    declaredEffect?: EffectClass,
  ): Promise<InjectOk | DeskRefusal> {
    const entry = await this.#live(id);
    if ("ok" in entry) return entry;
    const held = this.#holds(entry, operatorId);
    if (held !== null) return held;

    const perceived = await entry.parked.surface.perceive({
      deadlineMs: entry.parked.perceiveDeadlineMs,
    });
    if (!perceived.ok) {
      return refuse(
        "surface-fault",
        `the surface could not be observed before acting (${perceived.fault.kind})`,
      );
    }
    const observation = perceived.observation;
    const effect = higherEffect(OPERATOR_ACTION_EFFECT[action.kind], declaredEffect ?? "READ");
    const ctx = policyContextFor(entry.parked, observation, effect);

    // THE CHOKEPOINT. Same function, same order of rules, same journal line as an automation
    // action - and `mode: "operator"` is what makes rule 1 demand a HUMAN lease holder here and an
    // automation one everywhere else. The dispatch is kept within a few lines of the decision on
    // purpose: `test/policy-chokepoint.test.ts` reads this file off disk and refuses a wider gap.
    const parked = entry.parked;
    const moment = { now: parked.clock.now(), epoch: parked.lease.epoch };
    const decision = check(action, ctx, moment);
    parked.journal.append({ type: "policy.decided", decision, actionKind: action.kind, effect });
    if (!decision.allow) {
      return { ok: false, code: "policy-denied", detail: decision.detail, decision };
    }
    const result = await parked.surface.act(action, parked.lease.token);

    if (!result.ok) {
      return refuse("surface-fault", `the driver refused the action (${result.fault.kind})`);
    }

    // Attribution, and TITLES ONLY. An operator console that recorded what was typed would be a
    // second copy of every member number a human ever keyed, in the audit trail, forever.
    const targetTitle = titleOf(action, observation, parked.bindings);
    parked.journal.append({
      type: "human.acted",
      actorId: operatorId,
      actionKind: action.kind,
      targetTitle,
    });
    entry.actions.push({ kind: action.kind, targetTitle });

    return { ok: true, decision, view: await this.#view(entry) };
  }

  // -- HUMAN_HELD -> AUTOMATION_HELD ------------------------------------------------------------

  /**
   * Hand back, run SPEC section 7.4's seven-step re-check, and let the run continue - or not.
   *
   * The run does not blindly continue. Every arm below is a real ending, and the interesting one is
   * `refuse`: a human who wandered off to another member's record hands back into
   * `precondition-not-met` or `continuity-broken`, and the run stops rather than reading a balance
   * off the wrong account.
   */
  async handBack(id: string, operatorId: string): Promise<HandbackOk | DeskRefusal> {
    const entry = await this.#live(id);
    if ("ok" in entry) return entry;
    const held = this.#holds(entry, operatorId);
    if (held !== null) return held;

    const parked = entry.parked;

    // ---- 1  LEASE: the automation re-acquires at epoch+1 ---------------------------------------
    parked.lease.resumeAutomation(`run:${parked.runId}`, entry.actions);
    parked.journal.append({
      type: "lease.acquired",
      holder: "automation",
      actorId: `run:${parked.runId}`,
      epoch: parked.lease.epoch,
    });
    const leaseState = parked.lease.state({
      token: parked.heldBefore.token,
      epoch: parked.heldBefore.epoch,
    });

    // ---- 2  RE-OBSERVE: the screen the human left, not the one they were given ------------------
    const perceived = await parked.surface.perceive({ deadlineMs: parked.perceiveDeadlineMs });
    const observation = perceived.ok ? perceived.observation : null;
    if (observation !== null) {
      parked.journal.append({
        type: "observed",
        stepId: parked.step.id,
        obsSeq: observation.seq,
        skeletonDigest: observation.skeletonDigest,
        settled: observation.stability.settled,
        nodeCount: observation.nodes.length,
        observationRef: null,
      });
    }

    // ---- 3 to 6 --------------------------------------------------------------------------------
    const precheck = resumePrecheck({
      program: parked.program,
      step: parked.step,
      observation,
      perceiveFault: perceived.ok ? null : perceived.fault,
      bindings: parked.bindings,
      // A resume re-check is not a step attempt and spends no recovery budget, so it is
      // counted against a FRESH per-step ledger. Reusing the suspended attempt's would let
      // the re-check see attempts it did not make, and the classifier reads exactly that
      // field to decide whether a recovery is still affordable.
      counters: parked.ledger.counters(new StepLedger()),
      elapsedMs: parked.ledger.elapsedMs,
      leaseState,
      approval: parked.approval,
      approvalAlreadySpent: irreversibleAlreadyAuthorized(parked.journal),
    });

    if (precheck.kind === "not-yet") {
      // NOT a resume and NOT a failure. The operator is standing at the console and can press the
      // button again; converting a half-painted page into a terminal failure would be exactly the
      // "not yet is not not so" mistake, one level up. The lease is handed straight back so the
      // human keeps control while they wait.
      parked.lease.handToHuman(operatorId, entry.intervention.id);
      return { ok: false, code: "not-settled", detail: precheck.note, checks: precheck.checks };
    }

    entry.state = "TERMINATED";
    entry.intervention = {
      ...entry.intervention,
      state: "resolved",
      resolution: { by: operatorId, at: this.#clock.now(), disposition: "resume" },
    } as Intervention;
    parked.journal.append({
      type: "intervention.resolved",
      interventionId: entry.intervention.id,
      disposition: "resume",
      by: operatorId,
    });

    const disposition: ResumeDisposition =
      precheck.kind === "proceed"
        ? { kind: "resume", actionsPerformed: entry.actions, checks: precheck.checks }
        : precheck.kind === "outcome"
          ? {
              kind: "outcome",
              verdict: precheck.verdict,
              observation: observation as Observation,
              checks: precheck.checks,
            }
          : {
              kind: "failed",
              failure: precheck.failure,
              notes: precheck.notes,
              observation,
              checks: precheck.checks,
            };

    const result = await entry.continuation(disposition);
    entry.settled = result;
    return { ok: true, result, checks: precheck.checks };
  }

  /** The operator gives up. `failed`, never a silent close - a run nobody finished is a run whose
   *  caller is still waiting. */
  async abort(
    id: string,
    operatorId: string,
    reason = "the operator aborted the intervention",
  ): Promise<HandbackOk | DeskRefusal> {
    const entry = await this.#live(id);
    if ("ok" in entry) return entry;
    const held = this.#holds(entry, operatorId);
    if (held !== null) return held;
    return {
      ok: true,
      checks: [],
      result: await this.#terminate(entry, operatorId, "recovery-exhausted", [reason]),
    };
  }

  /**
   * Expire what has run out of time.
   *
   * Two clocks, and they mean different things. `intervention.expiresAt` is the operator's SLA and
   * SPEC section 7.1 says a suspended run that outlives it converts to `failed / recovery-exhausted`.
   * The LEASE's own TTL is the orphan detector: a console that crashed with the lease in its hand
   * leaves a session nobody can take back, and `ORPHANED -> TERMINATED` is the transition that says
   * so rather than leaving a browser open until the process dies.
   */
  async sweep(): Promise<void> {
    const now = Date.parse(this.#clock.now());
    for (const entry of this.#entries.values()) {
      if (entry.state === "TERMINATED") continue;
      if (now >= Date.parse(entry.intervention.expiresAt)) {
        await this.#terminate(entry, "system:expiry", "recovery-exhausted", [
          `the intervention expired at ${entry.intervention.expiresAt} with no hand-back`,
        ]);
        continue;
      }
      if (now >= Date.parse(entry.parked.lease.lease.expiresAt)) {
        entry.state = "ORPHANED";
        await this.#terminate(entry, "system:orphan", "lease-lost", [
          `the lease expired at ${entry.parked.lease.lease.expiresAt} with no heartbeat`,
        ]);
      }
    }
  }

  // -- internals -------------------------------------------------------------------------------

  async #terminate(
    entry: Entry,
    by: string,
    failure: FailureClass,
    notes: readonly string[],
  ): Promise<ReplayResultDocument> {
    entry.state = "TERMINATED";
    entry.intervention = {
      ...entry.intervention,
      state: by.startsWith("system:") ? "expired" : "abandoned",
      resolution: { by, at: this.#clock.now(), disposition: "abort" },
    } as Intervention;
    entry.parked.journal.append({
      type: "intervention.resolved",
      interventionId: entry.intervention.id,
      disposition: "abort",
      by,
    });
    entry.parked.lease.revoke();
    const result = await entry.continuation({
      kind: "failed",
      failure,
      notes,
      observation: null,
      checks: [],
    });
    entry.settled = result;
    return result;
  }

  /** The entry, if it is still one a caller may operate on. */
  async #live(id: string): Promise<Entry | DeskRefusal> {
    await this.sweep();
    const entry = this.#entries.get(id);
    if (entry === undefined) return refuse("unknown-intervention", `no intervention ${id}`);
    if (entry.state === "TERMINATED" || entry.state === "ORPHANED") {
      return refuse("wrong-state", `intervention ${id} is ${entry.state} and holds no session`);
    }
    return entry;
  }

  /** The desk's own half of "exactly one controller". The policy engine checks the same thing from
   *  the lease; this checks it from the DESK's record of who claimed, so an operator who never
   *  claimed is refused before a surface is even observed. */
  #holds(entry: Entry, operatorId: string): DeskRefusal | null {
    if (entry.state !== "HUMAN_HELD" || MAY_ACT[entry.state] !== "human") {
      return refuse(
        "wrong-state",
        `intervention ${entry.intervention.id} is ${entry.state}; claim it before acting`,
      );
    }
    if (entry.operatorId !== operatorId) {
      return refuse(
        "not-holder",
        `${operatorId} does not hold this session; ${entry.operatorId ?? "nobody"} claimed it`,
      );
    }
    if (Date.parse(entry.parked.clock.now()) >= Date.parse(entry.parked.lease.lease.expiresAt)) {
      return refuse("lease-expired", "the lease expired; the session is orphaned");
    }
    return null;
  }

  async #view(entry: Entry): Promise<LiveView> {
    const parked = entry.parked;
    const lease = parked.lease.lease;
    const perceived = await parked.surface.perceive({ deadlineMs: parked.perceiveDeadlineMs });
    const capabilities = parked.surface.capabilities();
    // The surface's OWN preferred capture format, first in its advertised list. A browser leads with
    // `image` and a character grid with `text-grid`, and the console never learns which it got.
    const format = capabilities.canCapture[0] ?? null;

    if (!perceived.ok) {
      return {
        interventionId: entry.intervention.id,
        state: entry.state,
        holder: lease.holder,
        actorId: lease.actorId,
        epoch: lease.epoch,
        surface: capabilities.kind,
        capture: null,
        captureFormat: format,
        captureRefused: [],
        observed: emptyObserved(perceived.fault.kind),
        nodes: [],
      };
    }

    const observation = perceived.observation;
    let capture: Capture | null = null;
    let refused: readonly NodeId[] = [];
    if (format !== null) {
      // Masked BEFORE the bytes exist. A screenshot that was ever unmasked in memory is a screenshot
      // that can leak, and this is the first consumer of `Surface.capture` in the system - so the
      // masking path is not theoretical.
      const derivation = deriveMaskRegions(observation.nodes, sensitiveNodes(observation, parked));
      const request = safeCaptureRequest(derivation, format);
      if (request.ok) capture = await parked.surface.capture(request.request);
      else refused = request.unmaskable;
      if (capture !== null) {
        parked.journal.append({
          type: "evidence.captured",
          ref: capture.ref,
          kind: format === "image" ? "image" : "text-grid",
          maskedRegions: capture.maskedRegions,
        });
      }
    }

    return {
      interventionId: entry.intervention.id,
      state: entry.state,
      holder: lease.holder,
      actorId: lease.actorId,
      epoch: lease.epoch,
      surface: capabilities.kind,
      capture,
      captureFormat: format,
      captureRefused: refused,
      observed: observedSummaryOf(observation, parked.bindings),
      nodes: liveNodes(observation, parked.bindings),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function refuse(code: DeskRefusalCode, detail: string): DeskRefusal {
  return { ok: false, code, detail };
}

function stamp(from: Timestamp, deltaMs: number): Timestamp {
  return new Date(Date.parse(from) + deltaMs).toISOString() as Timestamp;
}

/**
 * Has this run already authorized an irreversible action?
 *
 * Read off the journal's own `policy.decided` events rather than tracked in a field, because the
 * journal is the record a postmortem reads and a second copy of the same fact is a second thing to
 * get wrong. SPEC section 7.4 step 6: a token consumed before the handoff does not survive it.
 */
export function irreversibleAlreadyAuthorized(journal: Journal): boolean {
  // The cast is not laziness. `JournalEventSchema` builds each member's `type` through a generic
  // helper, so the inferred union carries `type: string` rather than a literal and TypeScript cannot
  // narrow it - which is a fact about that schema's construction, not about this predicate. Reading
  // the three fields structurally is the honest version; inventing a parallel discriminated union
  // here would be a second definition of the journal.
  type Decided = {
    readonly type: string;
    readonly effect: EffectClass;
    readonly decision: PolicyDecision;
  };
  return journal.events.some((event) => {
    const decided = event as Partial<Decided>;
    return (
      decided.type === "policy.decided" &&
      decided.effect === "WRITE_IRREVERSIBLE" &&
      decided.decision?.allow === true
    );
  });
}

function policyContextFor(
  parked: ParkedRun,
  observation: Observation,
  effect: EffectClass,
): PolicyContext {
  return {
    mode: "operator",
    allowlist: parked.allowlist,
    // A human acting is not executing a program step. Pinning the suspended step here would impose
    // its declared effect as a floor on every click, which on an irreversible step would deny the
    // operator the very session they were called in to unstick.
    step: null,
    route:
      observation.route === null
        ? null
        : { originAlias: observation.route.originAlias, path: observation.route.path },
    effect,
    lease: parked.lease.snapshot(),
    // NEVER an approval token. Anything the effect table calls irreversible is refused here, and
    // that is the point: a console is not a place to authorize an irreversible write.
    approval: null,
    artifact: {
      lifecycle: parked.program.artifact.lifecycle.status,
      digestVerified: true,
    },
    taint: parked.bindings.flatMap((b) => (b.handle === null ? [] : [b.handle])),
    approvedDigest: null,
  } as PolicyContext;
}

/** Nodes whose pixels must be blanked: the ones the driver already blanked, and the ones whose text
 *  still contains a caller-supplied value because a legacy app prints back what you typed. */
function sensitiveNodes(observation: Observation, parked: ParkedRun): readonly NodeId[] {
  const ids: NodeId[] = [];
  for (const node of observation.nodes) {
    if (node.masked) {
      ids.push(node.id);
      continue;
    }
    const leaked = [node.name, node.value, node.text].some(
      (text) => text !== null && redactTaint(text, parked.bindings).redactions > 0,
    );
    if (leaked) ids.push(node.id);
  }
  return ids;
}

const ACTIONABLE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "combobox",
  "checkbox",
  "radio",
  "menuitem",
  "tab",
  "option",
]);

/** The filtered node list. Interactive controls first, then whatever names the screen, and never
 *  more than fits on one page - an operator scrolling a thousand rows is reading a DOM dump. */
function liveNodes(observation: Observation, bindings: ResolvedBindings): readonly LiveNode[] {
  const rows: LiveNode[] = [];
  for (const node of observation.nodes) {
    const role = node.ariaRole;
    const actionable =
      role !== null && ACTIONABLE_ROLES.has(role) && !node.state.disabled && node.state.visible;
    const named = node.name.length > 0 || (node.text ?? "").length > 0;
    if (!actionable && !named) continue;
    rows.push({
      id: node.id,
      role,
      name: redactTaint(node.name.length > 0 ? node.name : (node.text ?? ""), bindings).text.slice(
        0,
        200,
      ),
      disabled: node.state.disabled,
      visible: node.state.visible,
      actionable,
      masked: node.masked,
    });
  }
  rows.sort((a, b) => Number(b.actionable) - Number(a.actionable));
  return rows.slice(0, 200);
}

/** What a human did, as a TITLE. Never the text they typed, never a coordinate. */
function titleOf(action: Action, observation: Observation, bindings: ResolvedBindings): string {
  if (action.kind === "navigate") {
    return `${action.route.originAlias}${action.route.path}`;
  }
  if (action.kind === "acceptDialog" || action.kind === "dismissDialog") {
    return observation.nativeDialog === null
      ? "a dialog"
      : `${observation.nativeDialog.type} dialog`;
  }
  if (action.target === null) return "the focused control";
  const node: UINode | undefined = observation.nodes.find((n) => n.id === action.target);
  if (node === undefined) return "an unnamed control";
  const label = node.name.length > 0 ? node.name : (node.text ?? "");
  return redactTaint(label, bindings).text.slice(0, 200);
}

function emptyObserved(faultKind: string): ObservedSummary {
  return {
    route: null,
    settled: false,
    pendingReason: null,
    skeletonDigest: `perceive-fault:${faultKind}`,
    nodeCount: 0,
    nativeDialog: null,
    inputIntercepted: false,
    salient: [],
    redactionsApplied: 0,
  } as ObservedSummary;
}
