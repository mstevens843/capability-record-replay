// SPEC section 8.1-8.2 - the chokepoint.
//
// Every action, in discovery, in replay and in the operator console, passes through `check` and
// nothing else. The property that matters is not that this code is good; it is that it is the ONLY
// code. A package boundary would not have bought that - `@crr/policy` would be a directory anyone
// can decline to import - so the property is held up by a contract test instead
// (`test/policy-chokepoint.test.ts`), which reads the repo off disk and fails if any `Surface.act`
// call site is not immediately preceded by a `check` on the same action whose decision is then
// consulted. The journal schema requires a `policy.decided` before every `acted` at the same step,
// which is the same claim proved a second way from the audit trail.
//
// It is a pure total function. No clock, no I/O, no exceptions on the decision path: a refusal is a
// value with a reason and a rule id, because a thrown refusal is a refusal somebody can catch and
// continue past.
//
// TIME AND THE SESSION EPOCH ARE ARGUMENTS. SPEC section 2.8 writes the signature as
// `check(action, ctx)`, but `@crr/core` has no clock and no session, and a lease that cannot be
// checked for expiry is not a lease. So the reading of "now" and the lease authority's current
// epoch arrive as a third argument, `PolicyMoment`, supplied by the caller that does have both.
// That is the same move the whole package makes everywhere else, and it is what keeps the engine
// unit-testable against a frozen moment.

import type { InstructionKind } from "./artifact.js";
import type { Action } from "./observation.js";
import type { Allowlist, PolicyContext, PolicyDecision, PolicyDenialReason } from "./policy.js";
import type { EffectClass, Timestamp } from "./primitives.js";
import { taintParamOf } from "./taint.js";

// ---------------------------------------------------------------------------------------------
// Risk classes
// ---------------------------------------------------------------------------------------------

/** Ordered, not just enumerated: every effect question in the system is a comparison. */
export const EFFECT_RANK: Readonly<Record<EffectClass, number>> = {
  READ: 0,
  WRITE_REVERSIBLE: 1,
  WRITE_IRREVERSIBLE: 2,
};

export function higherEffect(a: EffectClass, b: EffectClass): EffectClass {
  return EFFECT_RANK[a] >= EFFECT_RANK[b] ? a : b;
}

/** True when `effect` is above `cap`. Spelled as its own function because `>` on two strings is
 *  the bug this replaces. */
export function effectExceeds(effect: EffectClass, cap: EffectClass): boolean {
  return EFFECT_RANK[effect] > EFFECT_RANK[cap];
}

/**
 * What the INSTRUCTION alone proves about a step's effect, or `null` when it proves nothing.
 *
 * SPEC section 8.2 says the linker re-derives the class from the instruction kind and the route,
 * and that where declaration and derivation disagree the higher wins. This is the honest half of
 * that derivation: an instruction that dispatches nothing at the surface cannot write, so `read`,
 * `readTable` and `assert` derive `READ` and a step declaring otherwise is wrong. Every other
 * instruction could be either - `activate` on a "Search" button is a read and `activate` on
 * "Close Account" is not, and no pure function over the artifact can tell them apart.
 *
 * That gap is SPEC section 8.2's accepted limit, stated here rather than hidden: **effect is
 * declared, not proven.** The mitigations are elsewhere (the browser driver's non-GET heuristic,
 * `EffectSummary` in the approval UI, `acknowledgedEffects` in the audit trail).
 */
export function derivedEffectClass(instructionKind: InstructionKind): EffectClass | null {
  return instructionKind === "read" ||
    instructionKind === "readTable" ||
    instructionKind === "assert"
    ? "READ"
    : null;
}

/** "The higher wins, and the linker reports it", as a value the linker can report. */
export function reconcileEffectClass(
  declared: EffectClass,
  derived: EffectClass | null,
): { readonly effect: EffectClass; readonly agreed: boolean } {
  if (derived === null) return { effect: declared, agreed: true };
  return { effect: higherEffect(declared, derived), agreed: declared === derived };
}

// ---------------------------------------------------------------------------------------------
// The moment a decision is made in
// ---------------------------------------------------------------------------------------------

/**
 * The two facts about "now" that a pure predicate cannot go and get for itself.
 *
 * `epoch` is the lease authority's CURRENT epoch, not the run's belief about it. Comparing it
 * against `ctx.lease.epoch` is what catches the failure SPEC section 2.9 names as the interesting
 * one: not a human and an automation racing for a click, but an automation that still believes it
 * holds a session a human took forty seconds ago.
 */
export interface PolicyMoment {
  readonly now: Timestamp;
  readonly epoch: number;
}

// ---------------------------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------------------------

const MAX_RULE_ID = 128;
const MAX_DETAIL = 1000;

/**
 * The gate. First refusal wins, in SPEC section 8.1's order.
 *
 * Nothing in a denial `detail` is ever a bound value: details name parameters, routes, effect
 * classes and rule ids, all of which are schema vocabulary. A denial is journaled and read by a
 * human in an intervention brief, so a detail that quoted the text being typed would put a member
 * number in the audit trail at exactly the moment the system was trying to be careful.
 */
export function check(action: Action, ctx: PolicyContext, at: PolicyMoment): PolicyDecision {
  const allowlist = ctx.allowlist;

  // 1. The lease, at the current epoch. -------------------------------------------------------
  if (ctx.lease.epoch !== at.epoch) {
    return deny(
      "lease-not-held",
      "lease:epoch",
      `the caller holds lease epoch ${ctx.lease.epoch} and the session is at epoch ${at.epoch}; control was transferred`,
    );
  }
  const expectedHolder = ctx.mode === "operator" ? "human" : "automation";
  if (ctx.lease.holder !== expectedHolder) {
    return deny(
      "lease-not-held",
      "lease:holder",
      `${ctx.mode} acts as ${expectedHolder} and the lease is held by ${ctx.lease.holder} (${ctx.lease.actorId})`,
    );
  }
  if (!timestampIsBefore(at.now, ctx.lease.expiresAt)) {
    return deny(
      "lease-not-held",
      "lease:expired",
      `the lease expired at ${ctx.lease.expiresAt} and it is now ${at.now}`,
    );
  }

  // 2. The origin. ----------------------------------------------------------------------------
  //
  // A null route is refused before the origin is looked at, because there is no origin to look at:
  // "act somewhere I cannot name" has no safe reading. It is `route-not-allowed` rather than
  // `origin-not-allowed` because the missing fact is the location, not the host.
  if (ctx.route === null) {
    return deny(
      "route-not-allowed",
      "route:unknown",
      "the caller did not say where this action lands; policy cannot authorize an unlocated action",
    );
  }
  if (!allowlist.originAliases.includes(ctx.route.originAlias)) {
    return deny(
      "origin-not-allowed",
      "allowlist:origin",
      `origin alias "${ctx.route.originAlias}" is not in the allowlist [${allowlist.originAliases.join(", ")}]`,
    );
  }

  // 3. The route. -----------------------------------------------------------------------------
  //
  // A navigate action carries its own destination, so the two must agree. A check run against the
  // page you are on while the action goes somewhere else is a check of the wrong thing, and it is
  // the shape an open redirect takes on a surface with no address bar.
  if (action.kind === "navigate") {
    const target = action.route;
    if (target.originAlias !== ctx.route.originAlias || target.path !== ctx.route.path) {
      return deny(
        "route-not-allowed",
        "route:action-mismatch",
        `the action navigates to ${target.originAlias}${target.path} but the decision was requested for ${ctx.route.originAlias}${ctx.route.path}`,
      );
    }
  }
  if (!pathIsCanonicalShape(ctx.route.path)) {
    return deny(
      "route-not-allowed",
      "route:path-shape",
      `"${ctx.route.path}" is not a canonicalized path; a dot segment or an empty segment cannot be matched against an allowlist`,
    );
  }
  const matched = matchRoute(allowlist, ctx.route.originAlias, ctx.route.path);
  if (matched === null) {
    return deny(
      "route-not-allowed",
      "allowlist:route",
      `no allowlisted pattern for ${ctx.route.originAlias}${ctx.route.path}`,
    );
  }
  const routeRuleId = clamp(`route:${matched.originAlias}${matched.pathPattern}`, MAX_RULE_ID);

  // 4. The action kind. -----------------------------------------------------------------------
  if (!allowlist.actionKinds.includes(action.kind)) {
    return deny(
      "action-kind-not-allowed",
      "allowlist:actionKind",
      `action kind "${action.kind}" is not among [${allowlist.actionKinds.join(", ")}]`,
    );
  }

  // The effect this decision is about. The actuator says what it is doing; the artifact's step, if
  // there is one, says what the program declared. SPEC section 8.2: the higher wins.
  const requested = ctx.effect;
  const effective = ctx.step === null ? requested : higherEffect(requested, ctx.step.effect);

  // 5. The allowlist caps. --------------------------------------------------------------------
  if (effectExceeds(effective, allowlist.maxEffect)) {
    return deny(
      "effect-exceeds-allowlist",
      "allowlist:maxEffect",
      `this action is ${effective} and the allowlist permits at most ${allowlist.maxEffect}`,
    );
  }
  if (effectExceeds(effective, matched.maxEffect)) {
    return deny(
      "effect-exceeds-allowlist",
      "allowlist:route-maxEffect",
      `this action is ${effective} and ${matched.originAlias}${matched.pathPattern} permits at most ${matched.maxEffect}`,
    );
  }
  if (ctx.mode === "discovery" && effectExceeds(effective, allowlist.discoveryMaxEffect)) {
    return deny(
      "effect-exceeds-allowlist",
      "allowlist:discoveryMaxEffect",
      `discovery may not exceed ${allowlist.discoveryMaxEffect} and this action is ${effective}`,
    );
  }

  // 6. What the artifact declared for THIS step. -----------------------------------------------
  //
  // SPEC section 8.1 writes this as `effect <= artifact.policy.maxEffect`. The step's own declared
  // effect is the tighter form of the same check and is the one the context carries: the
  // artifact's `policy.maxEffect` is derived from the maximum over exactly these step effects
  // (`deriveEffectSummary`, and the schema refuses a document where the two disagree), so a step
  // that satisfies its own declaration satisfies the document's. The direction that matters is an
  // actuator about to do MORE than the program said it would.
  if (ctx.step !== null && effectExceeds(requested, ctx.step.effect)) {
    return deny(
      "effect-exceeds-artifact",
      "artifact:step-maxEffect",
      `step "${ctx.step.id}" is declared ${ctx.step.effect} and this action is ${requested}`,
    );
  }

  // 7. In replay: an approved artifact whose digest verifies. ----------------------------------
  if (ctx.mode === "replay") {
    if (ctx.artifact === null) {
      return deny(
        "artifact-not-approved",
        "artifact:lifecycle",
        "replay presented no artifact; an unapproved program may not drive a production surface",
      );
    }
    if (ctx.artifact.lifecycle !== "approved") {
      return deny(
        "artifact-not-approved",
        "artifact:lifecycle",
        `the artifact is ${ctx.artifact.lifecycle}; replay requires approved`,
      );
    }
    if (!ctx.artifact.digestVerified) {
      return deny(
        "artifact-digest-mismatch",
        "artifact:digest",
        "the artifact's content digest does not match the document; an approved artifact cannot be edited",
      );
    }
  }

  // 8. Irreversible needs an approval token. ---------------------------------------------------
  //
  // Uniform across modes on purpose. In replay the token is minted against an approved digest; in
  // discovery it stands for the explicit interactive human approval SPEC section 8.1 requires at
  // the moment the action is attempted - there is no "approve everything for this run" mode, and
  // the operator console is not an exemption from the strongest control in the system.
  if (effective === "WRITE_IRREVERSIBLE") {
    if (ctx.approval === null) {
      return deny(
        "irreversible-requires-approval",
        "approval:irreversible",
        `this action is WRITE_IRREVERSIBLE in ${ctx.mode} and no approval token was presented`,
      );
    }
    // What a pure predicate can check is that the token names an artifact at all. Whether the
    // signature verifies, and against which key, is the runtime's - it needs a key and a clock,
    // and neither belongs here. The linker pins the digest the token must name.
    if (ctx.mode === "replay" && ctx.approvedDigest === null) {
      return deny(
        "artifact-digest-mismatch",
        "approval:digest-binding",
        "the approval token names no artifact digest, so it cannot be shown to authorize this one",
      );
    }
  }

  // 9. No tainted value to a sink that cannot mask it. -----------------------------------------
  const taintDenial = checkTaint(action, ctx);
  if (taintDenial !== null) return taintDenial;

  return { allow: true, effect: effective, ruleId: routeRuleId };
}

// ---------------------------------------------------------------------------------------------
// Rule 9, spelled out
// ---------------------------------------------------------------------------------------------

/**
 * The taint rule the chokepoint can actually enforce.
 *
 * The engine never sees a value - `ctx.taint` is a list of opaque handles - so the question it can
 * answer is a structural one: is this step about to put a tainted value on the wire through a
 * channel that cannot mask it? A `type` action carries `sensitive`, which is how the driver knows
 * to blank the field's region before any bytes exist. Nothing else does: an `acceptDialog` text, a
 * `select` option and a navigation path are all unmaskable, so a tainted value lowered into one of
 * them is refused rather than dispatched.
 *
 * The other direction is checked too, and it is the one that catches a wiring mistake rather than
 * a design mistake: an action that declares `sensitive: true` while no tainted binding is in scope
 * means a raw value reached the actuator without ever passing through `bindSensitive`. The taint
 * model was not engaged, so nothing downstream will redact it.
 */
function checkTaint(action: Action, ctx: PolicyContext): PolicyDecision | null {
  const tainted = new Set(ctx.taint.map(taintParamOf));
  const instruction = ctx.step?.instruction ?? null;

  let sensitiveParam: string | null = null;
  if (instruction !== null && instruction.kind === "fill") {
    const value = instruction.value;
    if (value.from === "credential") sensitiveParam = `credential:${value.key}`;
    else if (value.from === "param" && tainted.has(value.param)) sensitiveParam = value.param;
  }

  if (sensitiveParam !== null && !(action.kind === "type" && action.sensitive)) {
    return deny(
      "tainted-value-to-disallowed-sink",
      "taint:unmasked-dispatch",
      `step "${ctx.step?.id}" fills from the sensitive binding "${sensitiveParam}", which may only be dispatched as a type action marked sensitive; this action is ${action.kind}${action.kind === "type" ? " with sensitive=false" : ""}`,
    );
  }

  if (action.kind === "type" && action.sensitive && ctx.taint.length === 0) {
    return deny(
      "tainted-value-to-disallowed-sink",
      "taint:untracked-sensitive",
      "the action declares sensitive text but no tainted binding is in scope; the value did not come through bindSensitive and nothing downstream will redact it",
    );
  }

  return null;
}

// ---------------------------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------------------------

type AllowlistRoute = Allowlist["routes"][number];

/**
 * The allowlist entry that governs `path`, or `null`.
 *
 * When several patterns match, the STRICTEST cap wins rather than the first one written. An
 * allowlist is read by a human as a set of statements, not as an ordered program, and "the entry I
 * added last silently widened the one above it" is not a property anyone wants in the file that
 * decides what the automation may do.
 */
export function matchRoute(
  allowlist: Allowlist,
  originAlias: string,
  path: string,
): AllowlistRoute | null {
  let best: AllowlistRoute | null = null;
  for (const route of allowlist.routes) {
    if (route.originAlias !== originAlias) continue;
    if (!routePatternMatches(route.pathPattern, path)) continue;
    if (best === null || EFFECT_RANK[route.maxEffect] < EFFECT_RANK[best.maxEffect]) best = route;
  }
  return best;
}

/**
 * Segment-wise match. A `:name` or `*` pattern segment matches exactly one path segment.
 *
 * There is deliberately NO trailing wildcard. `/admin/**` is an allowlist entry that says nothing,
 * and the point of the document is to be readable as a bounded list of the places this capability
 * is permitted to touch. Adding one is a schema change and a conversation, which is the correct
 * price.
 *
 * A concrete segment matching a `:name` placeholder is intentional: paths are canonicalized before
 * they get here, and if a driver ever fails to canonicalize one, refusing to recognise the route
 * would fail the run for a reason that has nothing to do with the leak it is worried about. The
 * value never reaches this function's output either way.
 */
export function routePatternMatches(pattern: string, path: string): boolean {
  const p = segments(pattern);
  const q = segments(path);
  if (p.length !== q.length) return false;
  for (let i = 0; i < p.length; i++) {
    const want = p[i] as string;
    const got = q[i] as string;
    if (want.startsWith(":") || want === "*") {
      if (got.length === 0) return false;
      continue;
    }
    if (want !== got) return false;
  }
  return true;
}

/** A canonicalized path has no empty, `.` or `..` segments. `/members/../admin` is not a member
 *  route however it is spelled, and normalizing it here would be this module deciding what a URL
 *  means - which is the job it does not have. */
export function pathIsCanonicalShape(path: string): boolean {
  if (!path.startsWith("/")) return false;
  for (const segment of segments(path)) {
    if (segment.length === 0 || segment === "." || segment === "..") return false;
  }
  return true;
}

function segments(path: string): readonly string[] {
  const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed.split("/").slice(1);
}

// ---------------------------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------------------------

/**
 * `a < b` for two ISO-8601 UTC timestamps, computed as text.
 *
 * There is no date object anywhere in this package, and the token that would name one is kept out
 * of the source entirely so that the purity scan can stay as blunt as a grep.
 *
 * The fields are fixed-width and the trailing `Z` is required, so the only thing standing between
 * these and a lexicographic comparison is the optional milliseconds: `...:00Z` sorts AFTER
 * `...:00.000Z` because `Z` is above `.`. Normalizing that one field is cheaper than importing a
 * clock into a package whose whole claim is that it does not have one.
 */
export function timestampIsBefore(a: Timestamp, b: Timestamp): boolean {
  return withMillis(a) < withMillis(b);
}

function withMillis(t: Timestamp): string {
  return t.length === 20 ? `${t.slice(0, 19)}.000Z` : t;
}

function clamp(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function deny(reason: PolicyDenialReason, ruleId: string, detail: string): PolicyDecision {
  return {
    allow: false,
    reason,
    ruleId: clamp(ruleId, MAX_RULE_ID),
    detail: clamp(detail, MAX_DETAIL),
  };
}
