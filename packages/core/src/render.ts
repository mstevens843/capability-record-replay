// Failure prose is generated, never authored (SPEC section 4.7).
//
// This is the module an on-call engineer reads at 2am and a reviewer reads before approving an
// artifact. Everything in it is a FOLD over the declared document - the predicate, the target, the
// extraction spec, the failure detail - because authored prose drifts from the predicate it claims
// to describe. It is written once and the predicate is edited twice; a fold cannot drift.
//
// Two rules govern every string produced here, and together they close a real privacy hole:
//
//   1. A `ValueRef` renders BY NAME (`param.memberId`) and a template hole renders UNRESOLVED
//      (`{memberId}`). The expectation half of a failure report therefore never carries a member
//      number, whatever the artifact says.
//   2. The observed half is scrubbed: every bound value that is not an artifact literal is
//      substituted out of the finished text. `renderFailure` applies that pass LAST, over the
//      assembled paragraph, so a leak introduced by any of its inputs is still caught on the way
//      out. `test/render.test.ts` is the canary that proves it over every screen in the corpus.
//
// Runs are correlated by `runId`, not by the value they were asked about. That is the whole trade
// and it is worth stating: the alternative - "expected is verbatim from an authored string" -
// either leaks the tainted value into every hard failure or produces a message too vague to tell
// one run from another.
//
// WHERE THE OTHER RENDERERS LIVE, and why they are not here. `renderPredicate`, `renderMatcher`
// and `renderValueRef` sit in `evaluate.ts` beside the evaluator, and `describeDescriptor` sits in
// `target-resolver.ts` beside the resolver, because each of those folds must enumerate exactly the
// same arms as the function next to it. Co-location is how a reviewer checks that, and how adding
// an arm to the language shows up as one diff instead of two. This module is where those folds are
// COMPOSED into the sentences a person actually reads.
//
// NOT the agent-facing renderer. `renderForAgent` (SPEC section 2.6, `@crr/runtime`) is a
// different projection for a different reader: it strips step ids, descriptors and withheld
// outputs, because a model does not need them and a tool result is itself a persisted artifact.
// This one deliberately includes them - the person reading it is trying to fix the run.

import type { ExtractSpec } from "./artifact.js";
import type { EvidenceSource } from "./descriptor-kinds.js";
import type { Quorum, TargetAssertion, TargetRef } from "./descriptors.js";
import type {
  ExpectationTrace,
  FailureClass,
  FailureDetail,
  ObservedSummary,
  Retriable,
  SideEffects,
  TargetCandidate,
} from "./diagnostics.js";
import {
  type EvalContext,
  type ResolvedBindings,
  evaluatePredicate,
  queryNodes,
  redactTaint,
  renderMatcher,
  renderPredicate,
  renderValueRef,
} from "./evaluate.js";
import type { NodeQuery, Predicate } from "./matchers.js";
import type { UINode } from "./observation.js";
import type { RunId, StepId } from "./primitives.js";
import { describeContainer, describeDescriptor } from "./target-resolver.js";

// ---------------------------------------------------------------------------------------------
// The target, as a sentence
// ---------------------------------------------------------------------------------------------

/**
 * What this step acts on, in the words a person would use.
 *
 * The lead is the highest-ranked descriptor, because rank is ordered by how a HUMAN identifies the
 * control: its accessible name first, its label second, its row and column third, its position
 * fourth. The others corroborate - they are reported by `renderQuorum` and by the candidate table,
 * not folded into the identity sentence, because a reader looking for "which control" does not
 * want four spellings of it.
 *
 * A generated id, a selector or a coordinate renders as nothing at all. This is the concrete payoff
 * of a language that refused all three: every construct it kept, it kept partly because the
 * interpreter can explain it at 2am.
 */
export function renderTarget(t: TargetRef): string {
  const lead = leadDescriptor(t);
  const identity = lead === null ? `the ${t.role}` : describeDescriptor(lead);
  const scope = describeContainer(t.scope);
  // A `table-cell` descriptor names its own table, and a target's scope is normally that same
  // table - so appending it unconditionally produces "inside the table [...], inside the table
  // [...]", which reads like two tables and sends the reader looking for the second one.
  return identity.includes(scope) ? identity : `${identity}, inside ${scope}`;
}

/** Descriptors are ranked by KIND, and the rank table is deliberately not a field an overlay could
 *  reorder - so this picks the same lead for every tenant. Ties keep declaration order. */
function leadDescriptor(t: TargetRef): TargetRef["descriptors"][number] | null {
  let best: TargetRef["descriptors"][number] | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const descriptor of t.descriptors) {
    const rank = RANK[descriptor.kind];
    if (rank < bestRank) {
      best = descriptor;
      bestRank = rank;
    }
  }
  return best;
}

// Local, and not imported from `descriptor-kinds.ts`, for one reason: this is a RENDERING order,
// and if it ever needs to differ from the resolver's ranking it must be able to without changing
// what the resolver does. Today they agree.
const RANK: Readonly<Record<TargetRef["descriptors"][number]["kind"], number>> = {
  "role-name": 1,
  "label-anchored": 2,
  "table-cell": 3,
  "ordinal-in-container": 4,
  geometric: 5,
};

/**
 * How much agreement this step demanded. Read after a `target-underdetermined` refusal, where the
 * question is always "why was that not enough evidence?" - and the answer is nearly always the
 * distinct-source count rather than the descriptor count.
 */
export function renderQuorum(q: Quorum): string {
  return `at least ${q.min} descriptors agreeing on ONE node, from ${q.distinctEvidenceSources} distinct evidence sources`;
}

/**
 * The pre-act assertion, in words. Read after `target-assert-failed`, which is most often the
 * wrong row - and `rowKeyEquals` is the clause that says so.
 */
export function renderAssertion(a: TargetAssertion): string {
  const clauses = [`is a ${a.role}`];
  if (a.name !== undefined) clauses.push(`is named ${renderMatcher(a.name)}`);
  if (a.enabled !== undefined) clauses.push(a.enabled ? "is enabled" : "is disabled");
  if (a.visible !== undefined) clauses.push(a.visible ? "is visible" : "is not visible");
  if (a.rowKeyEquals !== undefined) {
    clauses.push(
      `sits on the row whose ${renderMatcher(a.rowKeyEquals.columnHeader)} cell equals ${renderValueRef(a.rowKeyEquals.value)}`,
    );
  }
  return clauses.join(", and ");
}

// ---------------------------------------------------------------------------------------------
// The extraction spec, as a sentence
// ---------------------------------------------------------------------------------------------

/**
 * Which read failed. `output-extraction-failed` names the class and the reason names the fix, but
 * neither says WHAT the engine was trying to read, and that is the first thing anyone asks.
 *
 * The registry ids are printed verbatim. They are versioned behaviour, they are what a reviewer
 * greps for, and `moneyUSD@1` is more useful to the person holding the pager than any English
 * paraphrase of it would be.
 */
export function renderExtract(spec: ExtractSpec): string {
  const bounds =
    spec.rows === undefined
      ? ""
      : ` as ${spec.rows.minRows}-${spec.rows.maxRows} rows (truncation is a failure)`;
  const missing = spec.onMissing === "fail" ? "required" : "optional";
  return `the ${missing} output \`${spec.output}\`, read from ${renderQuery(spec.where)} with ${spec.from}, normalized by ${spec.normalize} and parsed by ${spec.parse}${bounds}`;
}

/** A query as a noun phrase. `renderPredicate` builds its own; this one is for the positions where
 *  a query appears outside a predicate, so the two never diverge in the middle of one report. */
function renderQuery(query: NodeQuery): string {
  if (query.cell !== undefined) {
    return `the cell in column ${renderMatcher(query.cell.columnHeader)} of the row whose ${renderMatcher(query.cell.rowKey.columnHeader)} cell equals ${renderValueRef(query.cell.rowKey.value)}, inside ${describeContainer(query.cell.table)}`;
  }
  const head = query.role === undefined ? "a node" : `a ${query.role}`;
  const named = query.name === undefined ? "" : ` named ${renderMatcher(query.name)}`;
  const scoped = query.scope === undefined ? "" : ` inside ${describeContainer(query.scope)}`;
  return `${head}${named}${scoped}`;
}

// ---------------------------------------------------------------------------------------------
// The verdict — SPEC section 4.7's `renderVerdict`
// ---------------------------------------------------------------------------------------------

/**
 * The expectation, rendered, with every leaf evaluated and its evidence attached.
 *
 * The clause list is the point. "The checkpoint failed" tells a person nothing; "the detail heading
 * is present [true], and the balance cell is present [FALSE - nothing in scope matched]" tells them
 * where to look. Leaf-level rather than whole-predicate, because a two-clause `all` that returns
 * false has told you nothing about which half.
 *
 * SPEC section 4.7 writes the signature as `renderVerdict(p, o)`, over an `Observation`. It takes
 * an `EvalContext` instead, and that is a correction rather than an extension: a predicate cannot
 * be evaluated against an observation alone - `continuity`, `route-matches` and every template hole
 * need the bindings and the linked program facts. The context carries the observation, so nothing
 * is lost and the type stops promising something the language cannot do.
 */
export function renderVerdict(p: Predicate | null, ctx: EvalContext): ExpectationTrace {
  if (p === null) return { rendered: "(nothing was expected)", clauses: [] };
  return {
    rendered: renderPredicate(p),
    // 64 is `ExpectationTraceSchema`'s own bound. A predicate is depth-bounded at 4 and checked at
    // save time, so reaching it means a hand-assembled step rather than a validated artifact.
    clauses: flatten(p)
      .slice(0, 64)
      .map((leaf) => ({
        rendered: renderPredicate(leaf),
        verdict: evaluatePredicate(leaf, ctx),
        ...evidenceFor(leaf, ctx),
      })),
  };
}

function flatten(p: Predicate): readonly Predicate[] {
  if ("all" in p) return p.all.flatMap(flatten);
  if ("any" in p) return p.any.flatMap(flatten);
  if ("not" in p) return [p];
  return [p];
}

interface ClauseEvidence {
  readonly nodeSummary?: string;
  readonly evidenceSource?: EvidenceSource;
}

/**
 * What the clause actually found, for the clauses that look at nodes at all.
 *
 * `evidenceSource` is filled only where it is HONEST: a cell-addressed query concluded from a
 * column header, a name-matched query concluded from an accessible name. A clause with no source
 * is one that rests on structure - a count, a route, the settle flag - and inventing a source for
 * it would make the field useless exactly where it matters, in the underdetermined report.
 */
function evidenceFor(leaf: Predicate, ctx: EvalContext): ClauseEvidence {
  if ("all" in leaf || "any" in leaf) return {};
  if ("not" in leaf) return evidenceFor(leaf.not, ctx);
  switch (leaf.kind) {
    case "node-exists":
    case "node-absent":
    case "node-state":
    case "value-matches":
    case "count":
      return {
        nodeSummary: summarizeMatches(queryNodes(leaf.where, ctx), ctx.bindings),
        ...sourceOf(leaf.where),
      };
    default:
      // `text-present`, `route-matches`, `settled`, `native-dialog` and `continuity` do not select
      // a node, and a summary of "what matched" would be a fabrication.
      return {};
  }
}

function sourceOf(query: NodeQuery): { readonly evidenceSource?: EvidenceSource } {
  if (query.cell !== undefined) return { evidenceSource: "columnHeader" };
  if (query.name !== undefined) return { evidenceSource: "accessibleName" };
  return {};
}

/** Never a node id and never a value: SPEC section 2.6 says so of this field, and a legacy app's
 *  synthesized ids frequently carry the label - which on a member screen carries the member. */
function summarizeMatches(matches: readonly UINode[], bindings: ResolvedBindings): string {
  if (matches.length === 0) return "nothing in scope matched";
  if (matches.length > 1) return `${matches.length} nodes matched`;
  const node = matches[0] as UINode;
  const role = node.ariaRole ?? node.rawRole;
  const name = redactTaint(node.name, bindings).text;
  const state = node.state.disabled ? ", disabled" : "";
  return name.length === 0
    ? `matched one unnamed ${role}${state}`
    : `matched the ${role} named "${truncate(name, 200)}"${state}`;
}

// ---------------------------------------------------------------------------------------------
// The observed half
// ---------------------------------------------------------------------------------------------

/**
 * What was actually there, on one line.
 *
 * A summary and not an observation: the observation itself is captured by reference and is what a
 * `classify()` unit test is written from. This is the part that goes in front of a person, and the
 * redaction count is printed rather than hidden - zero on a member screen is worth noticing.
 */
export function renderObserved(o: ObservedSummary): string {
  const route = o.route === null ? "no route" : `${o.route.originAlias}${o.route.path}`;
  const settled = o.settled
    ? "settled"
    : `NOT settled${o.pendingReason === null ? "" : ` (${o.pendingReason})`}`;
  const dialog =
    o.nativeDialog === null
      ? "no native dialog"
      : `native ${o.nativeDialog.type} dialog: "${truncate(o.nativeDialog.message, 200)}"`;
  const intercepted = o.inputIntercepted ? ", input intercepted" : "";
  const salient = o.salient
    .slice(0, 8)
    .map((n) => `${n.role ?? "node"} "${truncate(n.name, 80)}"${n.disabled ? " (disabled)" : ""}`)
    .join("; ");
  const redactions = `${o.redactionsApplied} field(s) redacted`;
  return `${route} - ${settled}, ${o.nodeCount} nodes, ${dialog}${intercepted}, ${redactions}${salient.length === 0 ? "" : `\n  on screen: ${salient}`}`;
}

// ---------------------------------------------------------------------------------------------
// The whole report
// ---------------------------------------------------------------------------------------------

/** Where the run was when it stopped. `null` for a pre-flight failure, which happened before there
 *  was a step to be at. */
export interface FailureSite {
  readonly stepId: StepId;
  /** Zero-based, as the interpreter counts. Rendered one-based, as a person counts. */
  readonly stepIndex: number;
  readonly stepCount?: number;
  /** The step's authored title. The engine may not READ prose (a contract test asserts it), but
   *  rendering it is exactly what it is for: "Open the member's detail row" is what tells a
   *  reviewer which step 4 is. */
  readonly title?: string;
}

export interface FailureReport {
  readonly failure: FailureClass;
  readonly detail: FailureDetail;
  readonly at: FailureSite | null;
  readonly runId?: RunId;
  /** Applied as a final scrub over the assembled text. Belt AND braces, deliberately: the inputs
   *  are redacted already, and this is the last place prose leaves the package. */
  readonly bindings?: ResolvedBindings;
}

/**
 * What step, what was expected, what was observed - the three things the brief asks a hard failure
 * to surface, in the order a person needs them.
 *
 * The last four lines are the ones that get acted on: side effects say whether anything was
 * touched, retriable says whether trying again is even a coherent idea, and `operatorAction` is
 * copied from the per-class table rather than generated here, so two runs of the same failure never
 * explain themselves differently.
 */
export function renderFailure(report: FailureReport): string {
  const lines: string[] = [];
  const run = report.runId === undefined ? "" : `run ${report.runId}: `;
  lines.push(`${run}${renderSite(report.at)}: ${report.failure}`);
  lines.push(`expected: ${report.detail.expected.rendered}`);
  for (const clause of report.detail.expected.clauses) {
    const mark = clause.verdict ? "ok  " : "FAIL";
    const evidence = clause.nodeSummary === undefined ? "" : ` - ${clause.nodeSummary}`;
    const source = clause.evidenceSource === undefined ? "" : ` [${clause.evidenceSource}]`;
    lines.push(`  [${mark}] ${clause.rendered}${evidence}${source}`);
  }
  lines.push(`observed: ${renderObserved(report.detail.observed)}`);
  if (report.detail.candidates !== undefined && report.detail.candidates.length > 0) {
    lines.push("candidates:");
    for (const candidate of report.detail.candidates) lines.push(`  ${renderCandidate(candidate)}`);
  }
  for (const attempt of report.detail.attempts) {
    lines.push(`recovery ${attempt.recoveryId}: ${attempt.attempts} attempt(s)`);
  }
  lines.push(`side effects: ${SIDE_EFFECT_PROSE[report.detail.sideEffects]}`);
  lines.push(`retriable: ${RETRIABLE_PROSE[report.detail.retriable]}`);
  lines.push(`do this: ${report.detail.operatorAction}`);

  const text = lines.join("\n");
  return report.bindings === undefined ? text : redactTaint(text, report.bindings).text;
}

function renderSite(at: FailureSite | null): string {
  if (at === null) return "failed before the surface was touched";
  const position =
    at.stepCount === undefined
      ? `step ${at.stepIndex + 1}`
      : `step ${at.stepIndex + 1} of ${at.stepCount}`;
  const title = at.title === undefined ? "" : ` (${at.title})`;
  return `failed at ${position}, \`${at.stepId}\`${title}`;
}

/** One descriptor's account of itself. The evidence source is on every row for the reason section
 *  5.1 gives: three candidates that agree are not three pieces of evidence if they read one label,
 *  and a report that omitted the source would make a refusal look inexplicable. */
function renderCandidate(c: TargetCandidate): string {
  // What it picked, by IDENTITY rather than by id. On a `target-ambiguous` refusal the question is
  // "what did the two of them each land on", and two synthesized ids answer that far worse than
  // two role-and-name pairs do. The final scrub in `renderFailure` covers the name.
  const hit =
    c.fingerprint === null
      ? "nothing"
      : `${c.fingerprint.ariaRole} "${truncate(c.fingerprint.name ?? "", 120)}"`;
  return `${c.kind}/${c.evidenceSource}: ${c.verdict}, picked ${hit} - ${c.rendered}`;
}

const SIDE_EFFECT_PROSE: Readonly<Record<SideEffects, string>> = {
  "none-guaranteed": "none-guaranteed - nothing was touched",
  possible: "possible - the run stopped partway; reversible or read work may have happened",
  "in-doubt":
    "IN DOUBT - an irreversible action was dispatched and its result was never observed. Reconcile against the system of record. Do NOT retry",
};

const RETRIABLE_PROSE: Readonly<Record<Retriable, string>> = {
  "same-inputs": "same-inputs - transient; the caller may retry now",
  "after-human-action": "after-human-action - a person must change the environment first",
  no: "no - do not retry",
};

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}
