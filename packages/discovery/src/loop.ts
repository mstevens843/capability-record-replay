// SPEC section 1.1 and 6.1 - the observe/decide/act loop.
//
// This is our own manual tool-use loop, not the SDK's `toolRunner`, for the three reasons BRIEF
// section 9 gives and one more that only shows up here: the runner owns the dispatch, and the
// dispatch is where the policy chokepoint has to be. A loop that hands tool execution to a library
// cannot put `PolicyEngine.check` in front of every `Surface.act`, and the repo-wide contract test
// that reads this file off disk would have nothing to find.
//
// THE INVARIANTS THIS FILE IS RESPONSIBLE FOR
//
//   1. EVERY dispatch passes `check` first, and the decision is read. `dispatch()` below is the
//      only function in the package that calls `Surface.act`, and `test/policy-chokepoint.test.ts`
//      in `@crr/core` scans this source to prove it.
//   2. ONE ACTION PER TURN. `disable_parallel_tool_use` is set on the request (see the anthropic
//      adapter), and this loop additionally refuses a second acting tool call in the same assistant
//      message. Two enforcements, because the recorded step order is only meaningful if the model
//      saw the consequence of each action before choosing the next.
//   3. A NODE REF IS VALID FOR ONE TURN. The map from `n<k>` to `NodeId` is rebuilt on every
//      observation and a ref from an earlier one is REFUSED, not resolved. Resolving a stale ref is
//      how a model that is one screen behind clicks the right-looking thing on the wrong screen.
//   4. THE MODEL NEVER SEES A BOUND VALUE. A secret is referenced by placeholder; the loop
//      substitutes it into the `Action` and nowhere else, and everything that leaves this file -
//      journal, transcript, recorded step - carries the taint handle instead.
//   5. NO EXIT DESTROYS WHAT THE RUN PAID FOR. Reaching the goal, giving up, running out of turns,
//      running out of budget and being cut off mid-turn by a rate limit are five different endings
//      and one shape: a `DiscoveryRun` carrying every recorded step, every journal event, the
//      measured usage and a status saying which ending it was. See `onUnexpectedError`.

import type Anthropic from "@anthropic-ai/sdk";
import {
  type ActFaultKind,
  type Action,
  type Allowlist,
  type ApprovalToken,
  type EffectClass,
  type Key,
  type LeaseSnapshot,
  type LeaseToken,
  type NodeId,
  type Observation,
  type PolicyContext,
  type PolicyDecision,
  type PolicyMoment,
  type RouteLocation,
  type Surface,
  type TaintHandle,
  type TaintedValue,
  type Timestamp,
  check,
  revealTainted,
  taintHandlesOf,
} from "@crr/core";
import {
  type DiscoveryEvent,
  type DiscoveryJournalSink,
  InMemoryDiscoveryJournal,
  redactToolInput,
} from "./journal.js";
import {
  type AssistantBlock,
  type DiscoveryAdapterName,
  type DiscoveryModel,
  DiscoveryModelError,
  type ModelTurnRequest,
  type ModelUsage,
  ZERO_USAGE,
  addUsage,
  cacheHitRate,
  toParamBlocks,
} from "./model-port.js";
import { type Projection, type ProjectionOptions, projectObservation } from "./projection.js";
import { DISCOVERY_SYSTEM_PROMPT, renderTaskMessage } from "./prompt.js";
import {
  type ActInput,
  ActInputSchema,
  DISCOVERY_TOOLS,
  FinishInputSchema,
  GoInputSchema,
  NoteOutputInputSchema,
  ObserveInputSchema,
  type OutcomeCandidate,
  TOOL_NAMES,
  type ToolName,
  toolsWithCacheBreakpoint,
} from "./tools.js";
import type { RecordingModel } from "./transcript.js";

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

export interface DiscoveryTarget {
  readonly tenantId: string;
  readonly originAlias: string;
  /** Absolute path the run starts on. Also the first thing shown to the model. */
  readonly entryRoute: string;
}

/**
 * The control lease, as the loop needs it.
 *
 * `epoch` is the lease AUTHORITY's current epoch, which is not the same thing as the epoch on the
 * snapshot the run is holding - comparing the two is what catches an automation still acting on a
 * session a human took (SPEC section 2.9). During discovery they are normally equal, and the field
 * exists so that a discovery run in the operator console cannot quietly be exempt from the rule.
 */
export interface DiscoveryControl {
  readonly token: LeaseToken;
  readonly snapshot: LeaseSnapshot;
  readonly epoch?: number;
}

export interface DiscoveryLimits {
  /** Model turns. A turn is one request/response pair, tool calls included. */
  readonly maxTurns: number;
  /** Dispatched actions, `go` included. The budget that bounds what a discovery run can DO. */
  readonly maxActions: number;
  /** Passed straight to `Surface.perceive`. An unbounded perceive is a hang, not an error. */
  readonly perceiveDeadlineMs: number;
  /** Consecutive refusals of any kind before the loop gives up on the model. */
  readonly maxConsecutiveRefusals: number;
}

export const DEFAULT_LIMITS: DiscoveryLimits = {
  maxTurns: 24,
  maxActions: 40,
  perceiveDeadlineMs: 5000,
  maxConsecutiveRefusals: 4,
};

/**
 * What the run has spent, offered to `stopBeforeTurn` between turns.
 *
 * `usage` is the sum of the `usage` field on every response the provider has actually returned. It
 * is a MEASUREMENT, not a projection, and that is the whole reason this hook exists at this point
 * in the loop rather than as a wrapper around the model: a decorator can refuse the next call, but
 * only the loop can refuse it and still end the run cleanly - with `finish` unreached, the recorded
 * steps intact, `loop.finished` journaled, and a `DiscoveryRun` handed back for whatever the caller
 * wants to write down. A budget guard that throws away the transcript it was protecting has spent
 * the money and kept nothing.
 *
 * `DiscoveryLimits` deliberately does not grow a `maxUsd` field. Money is not a property of this
 * loop: the token PRICE of a model is provider and plan dependent, it changes without the code
 * changing, and a constant in `DEFAULT_LIMITS` would be a number this package could not check. The
 * loop reports what it has spent in tokens; the runner that is watching the invoice owns the
 * arithmetic that turns that into dollars, and owns being wrong about it.
 */
export interface TurnBudgetProbe {
  /** 1-based index of the turn that is about to be requested. */
  readonly nextTurn: number;
  /** Turns already completed. */
  readonly turnsTaken: number;
  /** Cumulative, measured, provider-reported token usage across every turn so far. */
  readonly usage: ModelUsage;
  /** Actions dispatched so far, `go` included. */
  readonly actions: number;
}

export interface DiscoveryLoopOptions {
  readonly goal: string;
  readonly target: DiscoveryTarget;
  readonly model: DiscoveryModel;
  readonly surface: Surface;
  readonly allowlist: Allowlist;
  readonly control: DiscoveryControl;
  /** Required before any `WRITE_IRREVERSIBLE` action, in discovery exactly as in replay. SPEC
   *  section 8.1 is deliberate that there is no "approve everything for this run" mode. */
  readonly approval?: ApprovalToken | null;
  /**
   * Values the model may USE but must never SEE, by placeholder.
   *
   * The placeholder is what the model types; the loop substitutes the bound value into the
   * `Action` and marks it `sensitive`, which is what makes the driver mask the field's region
   * before any bytes exist. Everything else in this package - journal, transcript, recorded step -
   * sees only the handle.
   */
  readonly secrets?: ReadonlyMap<string, TaintedValue>;
  readonly journal?: DiscoveryJournalSink;
  /** Injected. This package is allowed a clock; the loop still takes one as an argument so a test
   *  can drive an entire run from a frozen sequence and get byte-identical output. */
  readonly now?: () => Timestamp;
  readonly nowMs?: () => number;
  readonly limits?: Partial<DiscoveryLimits>;
  /**
   * Asked, between every pair of turns, whether the next one may be taken.
   *
   * Return `null` to continue, or a SENTENCE saying why not - which becomes `DiscoveryRun.summary`
   * under status `budget-exhausted`, so the reason a run stopped is carried by the run rather than
   * printed somewhere and lost. Absent, nothing but `limits.maxTurns` bounds the run.
   */
  readonly stopBeforeTurn?: (probe: TurnBudgetProbe) => string | null;
  /**
   * What happens when something inside the loop THROWS - a rate limit, a 400, a dropped
   * connection, a journal sink that could not write, a bug in this file.
   *
   * `"throw"` (the default) propagates it, which is the right contract for every caller whose run
   * cost nothing: the VCR's strict digest check exists to be LOUD when a fixture no longer matches
   * the prompt, and a regression detector that downgraded a mismatch to a returned status is a
   * regression detector that stops failing CI.
   *
   * `"keep-the-run"` catches it, ends the run with status `failed` and a `DiscoveryFailure`, and
   * returns everything the run accumulated: every recorded step, every journal event, the measured
   * usage, and - because the recorder wraps the model rather than living in here - a transcript
   * the caller can still ask for. It is the same principle `TurnBudgetProbe` states for the budget
   * path, applied to the path that actually loses money: a guard that throws away the transcript it
   * was protecting has spent the money and kept nothing. `tools/discover.ts` passes it for exactly
   * that reason, and `test/loop-failure.test.ts` is the proof.
   *
   * It is opt-in rather than the default because the two callers want opposite things and both are
   * right. Only the caller that PAID for the turns can say that keeping them is worth more than
   * failing loudly, so that caller says it, at the call site, where a reader can see it.
   */
  readonly onUnexpectedError?: "throw" | "keep-the-run";
  readonly projection?: ProjectionOptions;
  /** Declares the effect class of an action the loop is about to dispatch. See `defaultEffectOf`. */
  readonly effectOf?: (action: Action, observation: Observation | null) => EffectClass;
}

// ---------------------------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------------------------

export type DiscoveryStatus =
  | "reached-goal"
  | "stuck"
  | "budget-exhausted"
  | "model-stopped"
  | "failed";

/**
 * Why a run ended in an exception rather than in a decision.
 *
 * Present only on status `failed`, and it is deliberately four flat fields rather than the error
 * itself: a `DiscoveryRun` is what an evidence bundle serializes, and an `Error` serializes to
 * `{}`. The one thing the caller most needs after a mid-run rate limit - WHICH provider error, at
 * WHICH turn - would have been the thing JSON dropped.
 *
 * `message` is provider prose, not ours, and it is capped rather than trusted. `stack` carries
 * absolute paths from the machine the run happened on, so it is offered for the console and is NOT
 * a field a bundle writer should copy into a committed file.
 */
export interface DiscoveryFailure {
  /** The error's own `name`: `DiscoveryModelError`, `TranscriptMismatchError`, `TypeError`, ... */
  readonly name: string;
  /** Capped at 1,000 characters, the same cap the journal puts on a refusal detail. */
  readonly message: string;
  /** The adapter that raised it, when the thrower named one. `null` for anything else. */
  readonly adapter: DiscoveryAdapterName | null;
  /** 1-based turn that was in flight. `0` when nothing had been requested yet. */
  readonly turn: number;
  /** For the console and for stderr. See the note above about what it contains. */
  readonly stack: string | null;
}

/** What the model typed, for unit 14's parameterization pass. A literal is kept because SPEC
 *  section 6.3 matches it against the goal text; a bound value is kept only as a handle. */
export type RecordedValue =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "sensitive"; readonly handle: TaintHandle; readonly placeholder: string };

/**
 * One dispatched action, with everything synthesis needs and nothing it does not.
 *
 * `observation` is the FULL observation the node id indexes into, because `deriveDescriptors`
 * (unit 14) needs the tree, not the projection - the projection is what the model saw and it is
 * deliberately lossy. `intent` is the model's `why` and becomes `Step.intent`, which SPEC section
 * 6.4 requires no executable path to read.
 */
export interface RecordedStep {
  readonly index: number;
  readonly tool: "act" | "go";
  readonly intent: string;
  readonly nodeId: NodeId | null;
  /**
   * The action AS RECORDED, which is not always the action as dispatched: a `type` carrying a value
   * bound to a sensitive parameter records the taint HANDLE in `text`, never the value.
   *
   * That is the same move the artifact makes one unit later - `Instruction.fill` stores
   * `{ from: "param" }` and never a literal (SPEC section 3.6) - and doing it here rather than
   * there is what keeps the in-memory `DiscoveryRun` greppable-clean, which matters because that
   * object is what an evidence dump serializes. A NON-sensitive literal is kept deliberately:
   * SPEC section 6.3 parameterizes by matching what the model typed against the goal text, and a
   * blanket redaction here would destroy the input to the mechanism that keeps values out of
   * artifacts in the first place.
   */
  readonly action: Action;
  readonly effect: EffectClass;
  readonly policyRuleId: string;
  readonly value: RecordedValue | null;
  readonly route: RouteLocation | null;
  readonly observation: Observation;
  readonly after: Observation | null;
  readonly dispatched: boolean;
  readonly faultKind: ActFaultKind | null;
}

export interface RecordedOutput {
  readonly outputName: string;
  readonly meaning: string;
  readonly nodeId: NodeId;
  readonly observation: Observation;
}

export interface DiscoveryRun {
  readonly status: DiscoveryStatus;
  readonly summary: string;
  readonly goal: string;
  readonly adapter: string;
  readonly modelId: string;
  readonly steps: readonly RecordedStep[];
  readonly outputs: readonly RecordedOutput[];
  readonly outcomeCandidates: readonly OutcomeCandidate[];
  readonly observations: readonly Observation[];
  readonly turns: number;
  readonly usage: ModelUsage;
  /** Surfaced so BRIEF section 9's "report the measured cache hit rate" is a field, not a chore. */
  readonly cacheHitRate: number;
  readonly events: readonly DiscoveryEvent[];
  /** Set exactly when `status` is `failed`. `null` on every other status. */
  readonly failure: DiscoveryFailure | null;
}

// ---------------------------------------------------------------------------------------------
// Effect classification
// ---------------------------------------------------------------------------------------------

/**
 * What effect class to declare for an action during free discovery.
 *
 * SPEC section 8.2 states the limit this implements rather than hides: effect is DECLARED, not
 * proven. No pure function over an action can tell `activate` on "Search" from `activate` on
 * "Close Account", so this table is conservative in the only direction that is safe:
 *
 *   · READ for the things that demonstrably dispatch nothing to a server - focusing a control,
 *     dismissing a dialog, and following a route (a `navigate` on these surfaces is a GET; a
 *     driver that knows better says so through `effectOf`);
 *   · WRITE_REVERSIBLE for everything else, INCLUDING a plain search-button click, because it
 *     might be a submit and this function cannot tell.
 *
 * `WRITE_IRREVERSIBLE` is never derived. It has to be declared by the caller through `effectOf`,
 * which then forces an approval token through policy rule 8 - and that is the point: the strongest
 * control in the system must not be reachable by a heuristic.
 */
export function defaultEffectOf(action: Action): EffectClass {
  switch (action.kind) {
    case "focus":
    case "navigate":
    case "dismissDialog":
      return "READ";
    default:
      return "WRITE_REVERSIBLE";
  }
}

// ---------------------------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------------------------

type RefusalReason =
  | "unknown-tool"
  | "invalid-input"
  | "stale-node-ref"
  | "policy-denied"
  | "budget";

interface ToolOutcome {
  readonly text: string;
  readonly isError: boolean;
  readonly detail: string;
  /** `null` when the call succeeded. Carried as a value rather than re-derived from the message,
   *  because a journal reason recovered by string-matching our own prose is a journal reason that
   *  silently changes the day somebody rewords an error. */
  readonly refusal: RefusalReason | null;
}

/** `Omit` collapses a discriminated union to its shared keys, which would erase every event's own
 *  fields. Distributing it over the members is what keeps `emit` typed per event. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type DiscoveryEventBody = DistributiveOmit<DiscoveryEvent, "seq" | "at">;

// ---------------------------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------------------------

export async function runDiscoveryLoop(options: DiscoveryLoopOptions): Promise<DiscoveryRun> {
  const limits: DiscoveryLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const now = options.now ?? (() => new Date().toISOString());
  const nowMs = options.nowMs ?? (() => Date.now());
  const effectOf = options.effectOf ?? defaultEffectOf;
  const secrets = options.secrets ?? new Map<string, TaintedValue>();
  const taint = taintHandlesOf([...secrets.values()]);
  const recorder = asRecorder(options.model);

  const memory = new InMemoryDiscoveryJournal();
  const sink: DiscoveryJournalSink = (event) => {
    memory.write(event);
    options.journal?.(event);
  };
  // The envelope is stamped here and the event is validated on the way into the journal, so the
  // cast is checked at runtime a line later rather than trusted.
  const emit = (body: DiscoveryEventBody): void => {
    sink({ ...body, seq: memory.next(), at: now() } as DiscoveryEvent);
  };
  /**
   * `emit` for the two TERMINAL events, and only for those.
   *
   * A journal sink is documented as total, and the in-memory one validates on the way in - but the
   * runner's sink is a `writeFileSync`, and a disk that filled up between turn 8 and turn 9 must
   * not be the reason a paid transcript is lost as well. Everything before this point still emits
   * loudly, because an event dropped in the MIDDLE of a run is a hole in the audit trail exactly
   * where the interesting thing happened; a closing event that could not be written costs a line
   * the returned `DiscoveryRun` already carries in a field.
   */
  const emitFinal = (body: DiscoveryEventBody): void => {
    try {
      emit(body);
    } catch {
      // Deliberately swallowed. See above.
    }
  };

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: renderTaskMessage({
        goal: options.goal,
        tenantId: options.target.tenantId,
        originAlias: options.target.originAlias,
        entryRoute: options.target.entryRoute,
        allowedRoutes: options.allowlist.routes
          .filter((route) => route.originAlias === options.target.originAlias)
          .map((route) => route.pathPattern),
        secretPlaceholders: [...secrets.keys()],
      }),
    },
  ];

  const steps: RecordedStep[] = [];
  const outputs: RecordedOutput[] = [];
  const observations: Observation[] = [];
  let outcomeCandidates: readonly OutcomeCandidate[] = [];
  let projection: Projection | null = null;
  let screen: Observation | null = null;
  let usage: ModelUsage = ZERO_USAGE;
  let actions = 0;
  let turn = 0;
  let refusalStreak = 0;
  let status: DiscoveryStatus | null = null;
  let summary = "";
  let failure: DiscoveryFailure | null = null;

  emit({
    type: "loop.started",
    adapter: options.model.adapter,
    modelId: options.model.modelId,
    goalLength: options.goal.length,
    tenantId: options.target.tenantId,
  });

  const refuse = (refusal: RefusalReason, detail: string): ToolOutcome => ({
    text: `Refused: ${detail}`,
    isError: true,
    detail,
    refusal,
  });
  const ok = (text: string, detail: string): ToolOutcome => ({
    text,
    isError: false,
    detail,
    refusal: null,
  });

  // ------------------------------------------------------------------------------------------
  // Perception
  // ------------------------------------------------------------------------------------------

  const perceive = async (): Promise<ToolOutcome> => {
    const result = await options.surface.perceive({ deadlineMs: limits.perceiveDeadlineMs });
    if (!result.ok) {
      // A perceive fault is mechanical and the model is told so plainly. It is NOT classified here:
      // turning "the screen would not tell me what it looks like" into a business answer is exactly
      // the fail-open SPEC section 0.2 forbids, and the classifier that may do it lives in replay.
      return {
        text: `The screen could not be read: ${result.fault.kind}. Try observe again.`,
        isError: true,
        detail: result.fault.kind,
        refusal: null,
      };
    }
    const masked = maskedNodes(result.observation, steps, secrets);
    // DEFENCE IN DEPTH. Masking a field is the DRIVER's obligation (`UINode.masked`), and a real
    // driver does it before the bytes exist. But `RecordedStep.observation` is what synthesis reads
    // and therefore what an artifact is derived from, so the one thing this loop will not do is
    // hand the next unit a tree with a bound value still in it because a driver forgot. Scrubbing
    // here is cheap, it is visible, and it makes the redaction canary a property of this package
    // rather than a property of whichever driver happens to be plugged in.
    const observation = scrubTaintedValues(result.observation, masked);
    screen = observation;
    observations.push(observation);
    projection = projectObservation(observation, { ...options.projection, masked });
    emit({
      type: "observed",
      obsSeq: observation.seq,
      skeletonDigest: observation.skeletonDigest,
      settled: observation.stability.settled,
      nodeCount: observation.nodes.length,
      projectedNodes: projection.shown,
    });
    return ok(projection.text, "observed");
  };

  // ------------------------------------------------------------------------------------------
  // Dispatch - THE ONLY `Surface.act` CALL SITE IN THIS PACKAGE
  // ------------------------------------------------------------------------------------------

  type Dispatched =
    | { readonly ok: true; readonly ruleId: string; readonly faultKind: ActFaultKind | null }
    | { readonly ok: false; readonly decision: Extract<PolicyDecision, { allow: false }> };

  const dispatch = async (
    action: Action,
    route: RouteLocation | null,
    effect: EffectClass,
    valueRef: TaintHandle | null,
    title: string,
  ): Promise<Dispatched> => {
    const context: PolicyContext = {
      mode: "discovery",
      allowlist: options.allowlist,
      step: null,
      route: route === null ? null : { originAlias: route.originAlias, path: route.path },
      effect,
      lease: options.control.snapshot,
      approval: options.approval ?? null,
      artifact: null,
      taint,
      approvedDigest: null,
    };
    const moment: PolicyMoment = {
      now: now(),
      epoch: options.control.epoch ?? options.control.snapshot.epoch,
    };
    const decision = check(action, context, moment);
    emit({ type: "policy.decided", decision, actionKind: action.kind, effect });
    if (!decision.allow) return { ok: false, decision };
    const result = await options.surface.act(action, options.control.token);
    emit({
      type: "acted",
      actionKind: action.kind,
      targetTitle: title,
      valueRef,
      valueLength: action.kind === "type" ? action.text.length : null,
      result: result.ok ? "dispatched" : result.fault.kind,
    });
    return { ok: true, ruleId: decision.ruleId, faultKind: result.ok ? null : result.fault.kind };
  };

  // ------------------------------------------------------------------------------------------
  // Tools
  // ------------------------------------------------------------------------------------------

  const runAct = async (raw: unknown): Promise<ToolOutcome> => {
    const parsed = ActInputSchema.safeParse(raw);
    if (!parsed.success)
      return refuse("invalid-input", `act input is not valid: ${parsed.error.message}`);
    const input = parsed.data;

    const before = screen;
    const shown = projection;
    if (before === null || shown === null) {
      return refuse(
        "stale-node-ref",
        "call observe before acting: there is no screen listing to take a nodeRef from",
      );
    }
    if (actions >= limits.maxActions) {
      return refuse("budget", `the action budget for this run (${limits.maxActions}) is spent`);
    }
    const nodeId = shown.refs.get(input.nodeRef) ?? null;
    if (nodeId === null) {
      // A stale or invented ref. Refused rather than resolved: the screen has moved and guessing
      // what the model meant is precisely how a confident wrong click happens.
      return refuse(
        "stale-node-ref",
        `${input.nodeRef} is not on the screen you were last shown; call observe and use a reference from the new listing`,
      );
    }

    const lowered = lowerAction(input, nodeId, secrets);
    if (!lowered.ok) return refuse("invalid-input", lowered.error);

    const action = lowered.action;
    const route = before.route;
    const effect = effectOf(action, before);
    actions += 1;
    const outcome = await dispatch(
      action,
      route,
      effect,
      lowered.value?.kind === "sensitive" ? lowered.value.handle : null,
      nodeTitle(before, nodeId),
    );
    if (!outcome.ok) {
      return refuse(
        "policy-denied",
        `${outcome.decision.reason} (${outcome.decision.ruleId}) - ${outcome.decision.detail}`,
      );
    }

    steps.push({
      index: steps.length + 1,
      tool: "act",
      intent: input.why,
      nodeId,
      action: recordable(action, lowered.value),
      effect,
      policyRuleId: outcome.ruleId,
      value: lowered.value,
      route,
      observation: before,
      after: null,
      dispatched: outcome.faultKind === null,
      faultKind: outcome.faultKind,
    });

    const seen = await perceive();
    patchAfter(steps, screen);
    const head =
      outcome.faultKind === null
        ? "Done."
        : `The action did not go through (${outcome.faultKind}).`;
    return ok(`${head}\n${seen.text}`, head);
  };

  const runGo = async (raw: unknown): Promise<ToolOutcome> => {
    const parsed = GoInputSchema.safeParse(raw);
    if (!parsed.success)
      return refuse("invalid-input", `go input is not valid: ${parsed.error.message}`);
    const input = parsed.data;
    if (actions >= limits.maxActions) {
      return refuse("budget", `the action budget for this run (${limits.maxActions}) is spent`);
    }
    if (!input.routeHint.startsWith("/")) {
      return refuse(
        "invalid-input",
        "routeHint is an absolute path on the application you were given, e.g. /members/search",
      );
    }

    // The ORIGIN comes from the target, never from the model. That is what makes "navigate off the
    // allowlist" unrepresentable rather than merely denied.
    const route: RouteLocation = {
      originAlias: options.target.originAlias,
      path: input.routeHint,
      query: {},
    };
    const action: Action = { kind: "navigate", route };
    const before = screen;
    const effect = effectOf(action, before);
    actions += 1;
    const outcome = await dispatch(
      action,
      route,
      effect,
      null,
      `${route.originAlias}${route.path}`,
    );
    if (!outcome.ok) {
      return refuse(
        "policy-denied",
        `${outcome.decision.reason} (${outcome.decision.ruleId}) - ${outcome.decision.detail}`,
      );
    }
    if (before !== null) {
      steps.push({
        index: steps.length + 1,
        tool: "go",
        intent: input.why,
        nodeId: null,
        action,
        effect,
        policyRuleId: outcome.ruleId,
        value: null,
        route,
        observation: before,
        after: null,
        dispatched: outcome.faultKind === null,
        faultKind: outcome.faultKind,
      });
    }
    const seen = await perceive();
    patchAfter(steps, screen);
    return seen;
  };

  const runNoteOutput = (raw: unknown): ToolOutcome => {
    const parsed = NoteOutputInputSchema.safeParse(raw);
    if (!parsed.success) {
      return refuse("invalid-input", `note_output input is not valid: ${parsed.error.message}`);
    }
    const input = parsed.data;
    const current = screen;
    const shown = projection;
    if (current === null || shown === null) return refuse("stale-node-ref", "call observe first");
    const nodeId = shown.refs.get(input.nodeRef) ?? null;
    if (nodeId === null) {
      return refuse("stale-node-ref", `${input.nodeRef} is not on the screen you were last shown`);
    }
    if (outputs.some((output) => output.outputName === input.outputName)) {
      return refuse("invalid-input", `the output "${input.outputName}" has already been noted`);
    }
    outputs.push({
      outputName: input.outputName,
      meaning: input.meaning,
      nodeId,
      observation: current,
    });
    emit({
      type: "output.noted",
      outputName: input.outputName,
      targetTitle: nodeTitle(current, nodeId),
    });
    return ok(`Noted ${input.outputName}.`, "noted");
  };

  const runFinish = (raw: unknown): ToolOutcome => {
    const parsed = FinishInputSchema.safeParse(raw);
    if (!parsed.success) {
      return refuse("invalid-input", `finish input is not valid: ${parsed.error.message}`);
    }
    status = parsed.data.status;
    summary = parsed.data.summary;
    outcomeCandidates = parsed.data.outcomeCandidates ?? [];
    return ok("Recorded.", parsed.data.status);
  };

  const runTool = async (name: ToolName, input: unknown): Promise<ToolOutcome> => {
    switch (name) {
      case "observe": {
        const parsed = ObserveInputSchema.safeParse(input ?? {});
        if (!parsed.success) return refuse("invalid-input", "observe takes no arguments");
        return perceive();
      }
      case "act":
        return runAct(input);
      case "go":
        return runGo(input);
      case "note_output":
        return runNoteOutput(input);
      case "finish":
        return runFinish(input);
      default: {
        const unreachable: never = name;
        return refuse("unknown-tool", `there is no tool called "${String(unreachable)}"`);
      }
    }
  };

  // ------------------------------------------------------------------------------------------
  // The turn cycle
  // ------------------------------------------------------------------------------------------

  const system = [
    {
      type: "text" as const,
      text: DISCOVERY_SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" as const },
    },
  ];
  const tools = toolsWithCacheBreakpoint(DISCOVERY_TOOLS);

  // THE EXCEPTION PATH, and it is the same principle as the budget path one screen down.
  //
  // Before this existed, a rate limit on turn 9 of a paid run propagated out of here to the
  // runner's outer catch, which printed FAILED and exited - at which point `transcript.json`,
  // `spend.json`, `provenance.json`, `README.md` and the log had not been written, because every
  // one of them is written AFTER the loop returns. Eight paid turns were gone and only
  // `journal.jsonl` survived. The loop is the only place that can fix that, because it is the
  // only place holding the accumulated steps, and it fixes it the way the budget guard already
  // does: stop, say why, keep everything.
  //
  // The catch is deliberately NOT narrowed to `DiscoveryModelError`. A dropped socket, a journal
  // sink that could not write, a bug in this file - from the caller's side those are all "the run
  // ended and here is what it had", and a taxonomy of throwables written here would be a list
  // that is wrong the first time something new is thrown. What the caller gets instead is the
  // error's own name and message on `DiscoveryRun.failure`, so it can tell them apart itself.
  try {
    while (status === null) {
      if (turn >= limits.maxTurns) {
        status = "budget-exhausted";
        summary = `the run reached its turn budget (${limits.maxTurns}) without calling finish`;
        break;
      }

      // THE SPEND GATE, and it is here rather than around `options.model` on purpose - see
      // `TurnBudgetProbe`. Stopping here leaves the run in exactly the state a stop between turns
      // should leave it in: every step recorded, every event journaled, and a status that says the
      // budget ended it rather than the model.
      const halt = options.stopBeforeTurn?.({
        nextTurn: turn + 1,
        turnsTaken: turn,
        usage,
        actions,
      });
      if (halt !== undefined && halt !== null) {
        status = "budget-exhausted";
        summary = halt;
        break;
      }

      turn += 1;

      const request: ModelTurnRequest = { system, tools, messages: [...messages] };
      emit({ type: "turn.requested", turn, messages: messages.length, tools: tools.length });

      const started = nowMs();
      const response = await options.model.turn(request);
      const latencyMs = Math.max(0, Math.round(nowMs() - started));
      usage = addUsage(usage, response.usage);

      const toolUses = response.content.filter(
        (block): block is Extract<AssistantBlock, { type: "tool_use" }> =>
          block.type === "tool_use",
      );
      emit({
        type: "turn.responded",
        turn,
        stopReason: response.stopReason,
        toolCalls: toolUses.length,
        usage: response.usage,
        latencyMs,
      });

      messages.push({
        role: "assistant",
        content: toParamBlocks(response.content, options.model.adapter),
      });

      if (toolUses.length === 0) {
        // No tool call and no `finish`: the model has stopped talking to the machinery. That is a
        // stopping condition of its own and it is NOT `stuck` - `stuck` is a claim the model makes
        // deliberately, and attributing it here would put words in its mouth in the evidence.
        status = "model-stopped";
        summary = textOf(response.content) || "the model ended its turn without calling a tool";
        break;
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      let actedThisTurn = false;

      for (const use of toolUses) {
        const callStarted = nowMs();
        const known = (TOOL_NAMES as readonly string[]).includes(use.name);
        let outcome: ToolOutcome;

        if (!known) {
          outcome = refuse("unknown-tool", `there is no tool called "${use.name}"`);
        } else {
          const name = use.name as ToolName;
          emit({
            type: "tool.called",
            turn,
            toolUseId: use.id,
            name,
            input: redactToolInput(use.input),
          });
          if ((name === "act" || name === "go") && actedThisTurn) {
            // Enforcement 2 of 2 for "one action per turn". `disable_parallel_tool_use` is the
            // provider-side half; this is the half that still holds if a provider ignores it.
            outcome = refuse(
              "invalid-input",
              "one action at a time: you must see the result of the previous action before choosing the next",
            );
          } else {
            outcome = await runTool(name, use.input);
            if (name === "act" || name === "go") actedThisTurn = true;
          }
        }

        if (outcome.refusal !== null) {
          emit({
            type: "tool.refused",
            turn,
            toolUseId: use.id,
            name: use.name,
            reason: outcome.refusal,
            detail: outcome.detail.slice(0, 1000),
          });
        }

        refusalStreak = outcome.refusal === null ? 0 : refusalStreak + 1;
        recorder?.recordToolCall({
          turn,
          toolUseId: use.id,
          name: use.name,
          input: redactToolInput(use.input),
          outcome: outcome.refusal === null ? "ok" : "refused",
          detail: outcome.detail.slice(0, 1000),
          latencyMs: Math.max(0, Math.round(nowMs() - callStarted)),
        });
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: outcome.text,
          ...(outcome.isError ? { is_error: true } : {}),
        });
      }

      // BRIEF section 9: all `tool_result` blocks go back in a SINGLE user message.
      messages.push({ role: "user", content: results });

      if (status === null && refusalStreak >= limits.maxConsecutiveRefusals) {
        status = "budget-exhausted";
        summary = `${refusalStreak} tool calls in a row were refused; the loop stopped rather than letting the model keep paying for the same mistake`;
      }
    }
  } catch (cause) {
    // The default is still to propagate. See `onUnexpectedError`: the caller that paid for the
    // turns is the only one that can say keeping them beats failing loudly.
    if (options.onUnexpectedError !== "keep-the-run") throw cause;
    failure = describeFailure(cause, turn);
    status = "failed";
    const during = turn === 0 ? "before any turn was requested" : `during turn ${turn}`;
    summary = `the run stopped on an error ${during}: ${failure.name}: ${failure.message}`;
    emitFinal({
      type: "loop.failed",
      turn,
      errorName: failure.name,
      adapter: failure.adapter,
      message: failure.message,
    });
  }

  const rate = cacheHitRate(usage);
  const finalStatus = status ?? "budget-exhausted";
  emitFinal({
    type: "loop.finished",
    status: finalStatus,
    turns: turn,
    actions,
    usage,
    cacheHitRate: rate,
  });

  return {
    status: finalStatus,
    summary,
    goal: options.goal,
    adapter: options.model.adapter,
    modelId: options.model.modelId,
    steps,
    outputs,
    outcomeCandidates,
    observations,
    turns: turn,
    usage,
    cacheHitRate: rate,
    events: memory.events,
    failure,
  };
}

/**
 * An unknown throwable, flattened into four fields a JSON file can hold.
 *
 * `instanceof` rather than a message match, in the order the taxonomy is written: BRIEF section 9
 * is explicit that provider errors are told apart by TYPE and never by string-matching a message,
 * and the same rule applies to our own. `name` is read off the error rather than derived, so a
 * `RateLimitError` the SDK adds tomorrow arrives here correctly labelled with no change to this
 * function.
 */
function describeFailure(cause: unknown, turn: number): DiscoveryFailure {
  const cap = (text: string): string => text.slice(0, 1000);
  if (cause instanceof DiscoveryModelError) {
    return {
      name: cause.name,
      message: cap(cause.message),
      adapter: cause.adapter,
      turn,
      stack: cause.stack ?? null,
    };
  }
  if (cause instanceof Error) {
    return {
      // A subclass that forgot to set `name` still reports something rather than an empty string.
      name: cause.name === "" ? "Error" : cause.name,
      message: cap(cause.message),
      adapter: null,
      turn,
      stack: cause.stack ?? null,
    };
  }
  // `throw "boom"` is legal JavaScript and a bundle that lost a run to one would be no better off
  // for the fact that it was not an `Error`.
  return { name: "UnknownThrow", message: cap(String(cause)), adapter: null, turn, stack: null };
}

// ---------------------------------------------------------------------------------------------
// Lowering a tool call onto the port's action vocabulary
// ---------------------------------------------------------------------------------------------

type Lowered =
  | { readonly ok: true; readonly action: Action; readonly value: RecordedValue | null }
  | { readonly ok: false; readonly error: string };

/**
 * `act`'s five verbs become the port's actions.
 *
 * The verbs and the actions are deliberately not the same list. `activate` is what a person does to
 * a button; `click` is what a browser does about it, and on a character grid it is an F-key. Making
 * the model speak the intent and the driver own the mechanism is the same separation the surface
 * port exists for, and it is why a recording made on one surface is at least expressible against
 * another.
 */
export function lowerAction(
  input: ActInput,
  target: NodeId,
  secrets: ReadonlyMap<string, TaintedValue>,
): Lowered {
  const fail = (error: string): Lowered => ({ ok: false, error });

  switch (input.action) {
    case "activate":
      return { ok: true, action: { kind: "click", target }, value: null };

    case "fill": {
      if (input.value === null) return fail("fill needs a value");
      const secret = secrets.get(input.value);
      if (secret !== undefined) {
        // The ONLY place a bound value is unboxed in this package, and it names its sink.
        // Everything downstream - journal, transcript, recorded step - carries the handle instead.
        return {
          ok: true,
          action: {
            kind: "type",
            target,
            text: revealTainted(secret, "surface-action"),
            mode: "replace",
            sensitive: true,
          },
          value: { kind: "sensitive", handle: secret.handle, placeholder: input.value },
        };
      }
      return {
        ok: true,
        action: { kind: "type", target, text: input.value, mode: "replace", sensitive: false },
        value: { kind: "literal", value: input.value },
      };
    }

    case "select": {
      if (input.value === null) return fail("select needs a value naming the option");
      return {
        ok: true,
        action: { kind: "select", target, option: input.value },
        value: { kind: "literal", value: input.value },
      };
    }

    case "setToggle": {
      if (input.value !== "true" && input.value !== "false") {
        return fail('setToggle needs value "true" or "false"');
      }
      return {
        ok: true,
        action: { kind: "setChecked", target, checked: input.value === "true" },
        value: { kind: "literal", value: input.value },
      };
    }

    case "pressKey": {
      if (input.key === null) return fail("pressKey needs a key");
      // `ArtifactKey` is a strict subset of the port's `Key`: the artifact vocabulary excludes the
      // function keys on purpose (SPEC section 2.2), so widening here is safe in this direction and
      // would not be in the other.
      const key: Key = input.key;
      return { ok: true, action: { kind: "pressKey", target, key }, value: null };
    }

    default: {
      const unreachable: never = input.action;
      return fail(`"${String(unreachable)}" is not one of the actions this tool accepts`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

function asRecorder(model: DiscoveryModel): RecordingModel | null {
  return "recordToolCall" in model ? (model as RecordingModel) : null;
}

function textOf(blocks: readonly AssistantBlock[]): string {
  return blocks
    .filter((block): block is Extract<AssistantBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function nodeTitle(observation: Observation, nodeId: NodeId): string {
  const node = observation.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) return "";
  return (node.name !== "" ? node.name : (node.text ?? "")).slice(0, 200);
}

/** The nodes whose displayed value must be replaced by `<masked:N>` in the projection: every field
 *  this run has typed a bound value into. */
function maskedNodes(
  observation: Observation,
  steps: readonly RecordedStep[],
  secrets: ReadonlyMap<string, TaintedValue>,
): ReadonlyMap<NodeId, TaintedValue> {
  const map = new Map<NodeId, TaintedValue>();
  for (const step of steps) {
    if (step.value?.kind !== "sensitive" || step.nodeId === null) continue;
    const bound = secrets.get(step.value.placeholder);
    if (bound === undefined) continue;
    const nodeId = step.nodeId;
    if (observation.nodes.some((node) => node.id === nodeId)) map.set(nodeId, bound);
  }
  return map;
}

/**
 * The action as it may be kept, which is the action as dispatched unless it carried a bound value.
 *
 * One function, one line, one name, so that `grep -n recordable` is the complete list of places
 * where a dispatched action becomes a recorded one.
 */
function recordable(action: Action, value: RecordedValue | null): Action {
  if (action.kind !== "type" || value?.kind !== "sensitive") return action;
  return { ...action, text: value.handle };
}

/**
 * Blank the value of every node this run typed a bound value into.
 *
 * `value: null` rather than a placeholder string, and `masked: true` so the fact is recorded rather
 * than merely the absence: a downstream reader has to be able to tell "this field was empty" from
 * "this field held something you may not see". Nothing else about the node changes, and the
 * skeleton digest is untouched because it never covered `value` in the first place - so a settle
 * comparison means the same thing before and after.
 */
function scrubTaintedValues(
  observation: Observation,
  masked: ReadonlyMap<NodeId, TaintedValue>,
): Observation {
  if (masked.size === 0) return observation;
  return {
    ...observation,
    nodes: observation.nodes.map((node) =>
      masked.has(node.id) ? { ...node, value: null, masked: true } : node,
    ),
  };
}

/** Attach the post-action observation to the step that was just pushed. Written as a replacement of
 *  the array's last entry because `RecordedStep` is immutable to everyone outside this file, and
 *  the alternative - building the step after the perceive - would lose it entirely if the perceive
 *  threw. */
function patchAfter(steps: RecordedStep[], observation: Observation | null): void {
  const last = steps.at(-1);
  if (last === undefined || observation === null) return;
  steps[steps.length - 1] = { ...last, after: observation };
}
