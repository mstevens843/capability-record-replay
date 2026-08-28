// The prose renderers, and the canary that guards them.
//
// Two things are under test and only one of them is prose quality.
//
// The first is that the sentences are USEFUL: a failure report has to say what step, what was
// expected and what was observed, at a level of detail somebody can act on at 2am without opening
// the artifact. The assertions below are written as whole expected strings rather than
// `toContain`, because a renderer that silently drops a clause still contains everything it used
// to and a reviewer reading a diff of these strings sees exactly what a reader would see.
//
// The second is the REDACTION CANARY, and it is the reason this file is long. SPEC section 4.7
// makes two rules - a `ValueRef` renders by name, a template hole renders unresolved - and the
// whole point of them is that a hard failure can be journaled, shipped to an operator console and
// pasted into a ticket without a member's account number travelling with it. The canary sweeps
// every renderer over every step of the real artifact crossed with every screen in the corpus and
// asserts that no parameter value appears in any string that comes out. It runs twice: once with
// the parameter tainted, and once with the same parameter NOT tainted, because the rule is about
// where the value came from and not about how it was labelled.

import { describe, expect, it } from "vitest";
import {
  type EvalContext,
  type ExpectationTrace,
  type FailureDetail,
  type Observation,
  type Predicate,
  type ResolvedBinding,
  type ResolvedStep,
  type StepId,
  type TargetRef,
  classify,
  observedSummaryOf,
  renderAssertion,
  renderExtract,
  renderFailure,
  renderObserved,
  renderPredicate,
  renderQuorum,
  renderTarget,
  renderVerdict,
} from "../src/index.js";
import {
  CALLER_MEMBER_ID,
  appErrorPage,
  bindings,
  detailUnreadableBalance,
  entitlementDenied,
  inputFor,
  notFoundBanner,
  program,
  resolvedStep,
  restrictedDetail,
  sessionExpired,
  validationError,
  wrongMemberDetail,
} from "./fixtures/classifier-screens.js";
import {
  detail,
  results,
  resultsTorn,
  searchForm,
  searching,
} from "./fixtures/corebank-observations.js";
import { memberLookupArtifact } from "./fixtures/member-lookup.js";

const STEPS = memberLookupArtifact.flow.steps;

const stepIds = STEPS.map((s) => s.id as string);

const SCREENS: Readonly<Record<string, Observation>> = {
  searchForm,
  searching,
  results,
  resultsTorn,
  detail,
  notFoundBanner,
  validationError,
  restrictedDetail,
  entitlementDenied,
  sessionExpired,
  appErrorPage,
  wrongMemberDetail,
  detailUnreadableBalance,
};

const ctxFor = (
  observation: Observation,
  who: readonly ResolvedBinding[] = bindings,
): EvalContext => ({ observation, program, bindings: who });

const targetOf = (stepId: string): TargetRef => {
  const target = STEPS.find((s) => s.id === stepId)?.target;
  if (target === null || target === undefined) throw new Error(`${stepId} has no target`);
  return target;
};

// ---------------------------------------------------------------------------------------------
// The target, as a sentence
// ---------------------------------------------------------------------------------------------

describe("renderTarget", () => {
  it("names the row by the VALUE that selects it, and the value by its parameter name", () => {
    // SPEC section 4.7's own example. A generated id renders as nothing at all, which is the
    // concrete payoff of a language that refused selectors: the interpreter can explain itself.
    expect(renderTarget(targetOf("open-member-row"))).toBe(
      'the link in column <actions-column> of the row whose <member-column> cell equals param.memberId, inside frame exactly "content", inside the table with columns [<member-column>, <name-column>, <status-column>]',
    );
  });

  it("leads with the identity a human would use, not with the positional fallback", () => {
    // Rank is a property of the KIND and is not a field an overlay can reorder, so every tenant
    // gets the same lead sentence for the same control.
    expect(renderTarget(targetOf("enter-member-id"))).toContain(
      "the textbox named <member-id-field>",
    );
  });

  it("says how much agreement the step demanded, which is what an underdetermined refusal is about", () => {
    expect(renderQuorum(targetOf("open-member-row").quorum)).toBe(
      "at least 2 descriptors agreeing on ONE node, from 2 distinct evidence sources",
    );
  });

  it("renders the pre-act assertion, including the row key that is the wrong-row killer", () => {
    expect(renderAssertion(targetOf("open-member-row").assert)).toBe(
      "is a link, and sits on the row whose <member-column> cell equals param.memberId",
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The read, as a sentence
// ---------------------------------------------------------------------------------------------

describe("renderExtract", () => {
  it("says which read, from where, and through which registered behaviour", () => {
    const spec = resolvedStep("read-savings-balance").extract.find(
      (e) => e.output === "savingsBalance",
    );
    expect(spec === undefined ? "" : renderExtract(spec)).toBe(
      'the required output `savingsBalance`, read from the cell in column <balance-column> of the row whose <share-type-column> cell equals "Savings", inside frame exactly "content", inside the table with columns [<share-type-column>, <balance-column>, <status-column>] with cell@1, normalized by std.money@1 and parsed by moneyUSD@1',
    );
  });

  it("says the bounds of a table read, and that truncation is a failure", () => {
    const spec = {
      output: "shares",
      from: "cell@1",
      where: { role: "cell" },
      parse: "string@1",
      normalize: "std.text@1",
      onMissing: "fail",
      rows: { minRows: 1, maxRows: 10, onTruncate: "fail" },
    } as Parameters<typeof renderExtract>[0];
    expect(renderExtract(spec)).toContain("as 1-10 rows (truncation is a failure)");
  });
});

// ---------------------------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------------------------

describe("renderVerdict", () => {
  it("evaluates every leaf, so a reader learns WHICH half of an expectation failed", () => {
    // "The checkpoint failed" tells a person nothing. A two-clause `all` that returns false has
    // told them nothing about which half, and the half is the whole message.
    const expectation = STEPS.find((s) => s.id === "open-member-row")?.expect
      .predicate as Predicate;
    const trace = renderVerdict(expectation, ctxFor(searchForm));
    expect(trace.clauses.map((c) => c.verdict)).toEqual([true, false, false]);
    expect(trace.clauses[1]?.rendered).toBe("the surface is on route member-detail");
  });

  it("attaches what the clause actually found, and where that evidence came from", () => {
    const query: Predicate = {
      kind: "node-exists",
      where: { role: "cell", name: { mode: "contains", value: "OPEN", normalize: "std.text@1" } },
    } as Predicate;
    const clause = renderVerdict(query, ctxFor(results)).clauses[0];
    expect(clause?.verdict).toBe(true);
    expect(clause?.nodeSummary).toBe('matched the cell named "OPEN"');
    expect(clause?.evidenceSource).toBe("accessibleName");
  });

  it("says nothing matched rather than leaving the reader to infer it", () => {
    const query: Predicate = {
      kind: "node-exists",
      where: {
        role: "cell",
        name: { mode: "exact", value: "nothing here", normalize: "std.text@1" },
      },
    } as Predicate;
    expect(renderVerdict(query, ctxFor(searchForm)).clauses[0]?.nodeSummary).toBe(
      "nothing in scope matched",
    );
  });

  it("claims an evidence source only where the clause really rests on one", () => {
    // A count rests on structure. Labelling it `accessibleName` would make the field useless in
    // the one report it exists for - the underdetermined one, where the question is always
    // "how many INDEPENDENT things agreed".
    const counted: Predicate = { kind: "count", where: { role: "row" }, op: "gte", n: 1 };
    expect(renderVerdict(counted, ctxFor(results)).clauses[0]?.evidenceSource).toBeUndefined();
    expect(
      renderVerdict({ kind: "settled" }, ctxFor(results)).clauses[0]?.nodeSummary,
    ).toBeUndefined();
  });

  it("renders a template hole UNRESOLVED, and the matcher still evaluates against the screen", () => {
    // The second of SPEC section 4.7's two rules. The predicate is TRUE - the heading really does
    // carry the member number - and the rendering of it still carries no member number.
    const templated: Predicate = {
      kind: "text-present",
      text: { mode: "template", value: "Member Detail #{memberId}", normalize: "std.text@1" },
    } as Predicate;
    const trace = renderVerdict(templated, ctxFor(detail));
    expect(trace.clauses[0]?.verdict).toBe(true);
    expect(trace.rendered).toBe('text matching "Member Detail #{memberId}" is present');
  });

  it("is empty, not absent, when a step declares no precondition", () => {
    expect(renderVerdict(null, ctxFor(detail))).toEqual({
      rendered: "(nothing was expected)",
      clauses: [],
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

function failureAt(stepId: string, screen: Observation): FailureDetail & { failure: string } {
  const verdict = classify(inputFor(resolvedStep(stepId), screen));
  if (verdict.kind !== "fail") throw new Error(`${stepId} on that screen was ${verdict.kind}`);
  return { ...verdict.detail, failure: verdict.failure };
}

describe("renderFailure", () => {
  it("says what step, what was expected, what was observed, and what to do", () => {
    const detailOf = failureAt("open-member-row", wrongMemberDetail);
    const text = renderFailure({
      failure: "continuity-broken",
      detail: detailOf,
      at: { stepId: "open-member-row" as StepId, stepIndex: 3, stepCount: 5, title: "Open it" },
      bindings,
    });
    expect(text.split("\n")[0]).toBe(
      "failed at step 4 of 5, `open-member-row` (Open it): continuity-broken",
    );
    expect(text).toContain("expected: ");
    expect(text).toContain("observed: ");
    expect(text).toContain("side effects: possible - the run stopped partway");
    expect(text).toContain("retriable: no - do not retry");
    expect(text).toContain("do this: ");
  });

  it("marks each clause with its own verdict, so the false one is findable by eye", () => {
    const text = renderFailure({
      failure: "checkpoint-failed",
      detail: failureAt("submit-search", resultsTorn),
      at: { stepId: "submit-search" as StepId, stepIndex: 2 },
      bindings,
    });
    expect(text).toContain("[ok  ]");
    expect(text).toContain("[FAIL]");
  });

  it("says plainly that nothing was touched, when that is a fact rather than a hope", () => {
    const text = renderFailure({
      failure: "link-error",
      detail: {
        sideEffects: "none-guaranteed",
        expected: { rendered: "the artifact links against this surface", clauses: [] },
        observed: observedSummaryOf(searchForm, bindings),
        attempts: [],
        retriable: "after-human-action",
        operatorAction: "Re-link the artifact.",
      },
      at: null,
    });
    expect(text.split("\n")[0]).toBe("failed before the surface was touched: link-error");
    expect(text).toContain("side effects: none-guaranteed - nothing was touched");
  });

  it("shouts about an effect in doubt, because that one must never be retried", () => {
    const text = renderFailure({
      failure: "effect-in-doubt",
      detail: {
        sideEffects: "in-doubt",
        expected: { rendered: "the result of an irreversible action is observed", clauses: [] },
        observed: observedSummaryOf(detail, bindings),
        attempts: [],
        retriable: "no",
        operatorAction: "Reconcile against the system of record.",
      },
      at: { stepId: "open-member-row" as StepId, stepIndex: 3 },
    });
    expect(text).toContain("IN DOUBT");
    expect(text).toContain("Do NOT retry");
  });

  it("shows what each descriptor picked, which is the whole content of an ambiguous refusal", () => {
    // Two descriptors that resolved to DIFFERENT nodes is the case this report exists for, and
    // "both resolved" says nothing. The identity each one landed on is the finding - and the name
    // it landed on is scrubbed like everything else on the observed side.
    const text = renderFailure({
      failure: "target-ambiguous",
      detail: {
        sideEffects: "none-guaranteed",
        expected: { rendered: "every descriptor resolves to the SAME node", clauses: [] },
        observed: observedSummaryOf(results, bindings),
        candidates: [
          {
            descriptorId: "select-by-row-key",
            kind: "table-cell",
            evidenceSource: "columnHeader",
            verdict: "disagreed",
            nodeId: "link:results-select" as never,
            fingerprint: {
              ariaRole: "link",
              name: "Select 50001",
              containerPath: [],
              tablePosition: null,
              boundsBucket: null,
            },
            rendered: "the link in column <actions-column>",
          },
          {
            descriptorId: "select-right-of-member-cell",
            kind: "geometric",
            evidenceSource: "geometry",
            verdict: "disagreed",
            nodeId: null,
            fingerprint: null,
            rendered: "the link right of the member cell",
          },
        ],
        attempts: [],
        retriable: "after-human-action",
        operatorAction: "Two descriptors disagreed; look at both.",
      },
      at: { stepId: "open-member-row" as StepId, stepIndex: 3 },
      bindings,
    });
    expect(text).toContain(
      'table-cell/columnHeader: disagreed, picked link "Select <taint:memberId>"',
    );
    expect(text).toContain("geometric/geometry: disagreed, picked nothing");
    expect(text).not.toContain(CALLER_MEMBER_ID.value);
  });

  it("renders the observed side as a summary, with the redaction count shown rather than hidden", () => {
    // Zero redactions on a member screen is worth noticing, which is only possible if the count is
    // in front of the person reading.
    const summary = renderObserved(observedSummaryOf(detail, bindings));
    expect(summary).toContain("corebank/members/:memberId");
    expect(summary).toContain("settled");
    expect(summary).toContain("field(s) redacted");
    expect(summary).toContain('heading "Member Detail #<taint:memberId>"');
  });
});

// ---------------------------------------------------------------------------------------------
// The redaction canary
// ---------------------------------------------------------------------------------------------

/**
 * Every string every renderer in this package can produce, over the whole corpus.
 *
 * Deliberately exhaustive rather than sampled: the failure mode this guards against is a renderer
 * added later that reaches for a node's `name` or a matcher's `value` without thinking about where
 * that string came from, and a sampled sweep would miss it on the one screen that matters.
 */
function everythingRendered(who: readonly ResolvedBinding[]): readonly string[] {
  const out: string[] = [];
  const push = (s: string | undefined): void => {
    if (s !== undefined) out.push(s);
  };
  const pushTrace = (trace: ExpectationTrace): void => {
    push(trace.rendered);
    for (const clause of trace.clauses) {
      push(clause.rendered);
      push(clause.nodeSummary);
    }
  };

  for (const step of STEPS) {
    if (step.target !== null) {
      push(renderTarget(step.target));
      push(renderQuorum(step.target.quorum));
      push(renderAssertion(step.target.assert));
    }
    push(renderPredicate(step.expect.predicate));
    if (step.precondition !== null) push(renderPredicate(step.precondition));
    for (const spec of step.extract) push(renderExtract(spec));
    for (const rule of step.outcomes) {
      push(renderPredicate(rule.detect));
      for (const spec of rule.capture) push(renderExtract(spec));
    }
    for (const rule of step.recoveries) push(renderPredicate(rule.detect));
  }
  for (const rule of memberLookupArtifact.flow.ambient) push(renderPredicate(rule.detect));

  for (const screen of Object.values(SCREENS)) {
    push(renderObserved(observedSummaryOf(screen, who)));
    for (const id of stepIds) {
      const step = resolvedStep(id);
      const ctx = ctxFor(screen, who);
      pushTrace(renderVerdict(step.expect.predicate, ctx));
      pushTrace(renderVerdict(step.precondition, ctx));
      for (const rule of step.outcomes) pushTrace(renderVerdict(rule.detect, ctx));

      const verdict = classify(inputFor(step as ResolvedStep, screen, { bindings: who }));
      if (verdict.kind !== "fail") continue;
      push(
        renderFailure({
          failure: verdict.failure,
          detail: verdict.detail,
          at: {
            stepId: step.id,
            stepIndex: step.index,
            stepCount: STEPS.length,
            title: step.title,
          },
          runId: "run-canary" as Parameters<typeof renderFailure>[0]["runId"],
          bindings: who,
        }),
      );
    }
  }
  return out;
}

describe("the redaction canary - no parameter value reaches any rendered string", () => {
  const TAINTED = CALLER_MEMBER_ID.value;

  it("renders every step, every screen and every failure without the member number", () => {
    const rendered = everythingRendered(bindings);
    // A canary that swept nothing would pass silently, which is the one way this test could lie.
    expect(rendered.length).toBeGreaterThan(200);
    for (const text of rendered) {
      expect(text.includes(TAINTED), `leaked ${TAINTED}: ${text}`).toBe(false);
    }
  });

  it("holds when the same parameter is NOT tainted, because the rule is about provenance", () => {
    // `sensitivity` governs persistence; this rule governs whether a run can be identified by the
    // value it was asked about. A parameter that is merely `internal` is still the caller's.
    const untainted: readonly ResolvedBinding[] = [
      { ...CALLER_MEMBER_ID, sensitivity: "internal", handle: null },
    ];
    const rendered = everythingRendered(untainted);
    for (const text of rendered) {
      expect(text.includes(TAINTED), `leaked ${TAINTED}: ${text}`).toBe(false);
    }
    expect(rendered.some((t) => t.includes("<memberId>"))).toBe(true);
  });

  it("scrubs a value that reached a node NAME, which is where a legacy app puts it", () => {
    // The driver blanks the field the value was typed into. It does not associate the page heading
    // that prints the number back at you with that field, and `heading` is exactly the role a
    // failure summary quotes first. So the substitution happens once more on the way out.
    const heading: Predicate = {
      kind: "node-exists",
      where: {
        role: "heading",
        name: { mode: "contains", value: "Member Detail", normalize: "std.text@1" },
      },
    } as Predicate;
    expect(renderVerdict(heading, ctxFor(detail)).clauses[0]?.nodeSummary).toBe(
      'matched the heading named "Member Detail #<taint:memberId>"',
    );
  });

  it("scrubs a value that IS the whole cell, on the grid the caller was searched for in", () => {
    const cell: Predicate = {
      kind: "node-exists",
      where: { role: "cell", name: { mode: "contains", value: "5000", normalize: "std.text@1" } },
    } as Predicate;
    expect(renderVerdict(cell, ctxFor(results)).clauses[0]?.nodeSummary).toBe(
      'matched the cell named "<taint:memberId>"',
    );
  });

  it("catches a leak introduced downstream, because the scrub is the LAST thing that happens", () => {
    // Belt and braces on purpose. Every input to this function is redacted already; this asserts
    // that a future summary builder which forgets cannot turn a failure report into a disclosure.
    const leaky = observedSummaryOf(detail, []);
    expect(JSON.stringify(leaky)).toContain(TAINTED);
    const text = renderFailure({
      failure: "checkpoint-failed",
      detail: {
        sideEffects: "possible",
        expected: { rendered: `the record ${TAINTED} is on screen`, clauses: [] },
        observed: leaky,
        attempts: [],
        retriable: "after-human-action",
        operatorAction: "Look at the screen.",
      },
      at: { stepId: "open-member-row" as StepId, stepIndex: 3 },
      bindings,
    });
    expect(text).not.toContain(TAINTED);
    expect(text).toContain("<taint:memberId>");
  });

  it("keeps an artifact LITERAL, because that one is the artifact's own text and the bug's name", () => {
    // The asymmetry is the point of SPEC section 4.2 rows 4-vs-5: when the rejected value came
    // from the artifact rather than the caller, the value IS the finding, and blanking it would
    // remove the only thing that makes the report actionable.
    const literalStep = resolvedStep("read-savings-balance");
    const spec = literalStep.extract.find((e) => e.output === "savingsBalance");
    expect(spec === undefined ? "" : renderExtract(spec)).toContain('"Savings"');
  });
});
