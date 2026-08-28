// `ExtractSpec` evaluation, against frozen screens and nothing else running.
//
// Extraction is a pure read from the SAME observation the checkpoint verified, which is why there
// is no `read` action on the `Surface` port and why every case below is a JSON file and a function
// call. The bias under test is refusal: each case here is a value that could have been guessed,
// rounded, blended or silently shortened by an implementation trying to be helpful, and the
// assertion is that it was not.
//
// The one to read twice is truncation. Reading nine of a member's ten shares and reporting them as
// ten is a wrong answer that looks like a right one, and it is the only failure in this file that
// a caller could not detect for themselves.

import { describe, expect, it } from "vitest";
import {
  type ContainerMatcher,
  type EvalContext,
  type ExtractOutcome,
  type ExtractSpec,
  type Observation,
  type ProgramFacts,
  type UINode,
  classify,
  readExtractSpec,
} from "../src/index.js";
import {
  RESULTS_TABLE_MATCHER,
  SHARES_TABLE_MATCHER,
  bindings,
  inputFor,
  program,
  readSharesStep,
  resolvedStep,
} from "./fixtures/classifier-screens.js";
import { detail, detailOpenShares, results, searchForm } from "./fixtures/corebank-observations.js";

// ---------------------------------------------------------------------------------------------
// Scaffolding — the real steps out of the real artifact, never a spec written to pass
// ---------------------------------------------------------------------------------------------

const ctxFor = (observation: Observation, facts: ProgramFacts = program): EvalContext => ({
  observation,
  program: facts,
  bindings,
});

const readStep = resolvedStep("read-savings-balance");

function specFor(output: string): ExtractSpec {
  const spec = readStep.extract.find((e) => e.output === output);
  if (spec === undefined) throw new Error(`the read step declares no output named ${output}`);
  return spec;
}

const sharesSpec = (rows: { minRows: number; maxRows: number }): ExtractSpec =>
  ({
    output: "shares",
    from: "cell@1",
    where: { scope: SHARES_TABLE_MATCHER, role: "cell" },
    parse: "string@1",
    normalize: "std.text@1",
    onMissing: "fail",
    rows: { ...rows, onTruncate: "fail" },
  }) as unknown as ExtractSpec;

/** A screen with one cell edited. Every screen in this file is the shared corpus or a named,
 *  minimal edit of it: a screen invented to make a test pass proves nothing about a screen. */
const withCell = (obs: Observation, id: string, patch: Partial<UINode>): Observation =>
  ({
    ...obs,
    nodes: obs.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
  }) as Observation;

/** Rename what the grid prints above a column, on the header row and on every cell that claims it,
 *  which is what a second tenant of the same vendor product looks like. */
const withHeader = (obs: Observation, from: string, to: string): Observation =>
  ({
    ...obs,
    nodes: obs.nodes.map((n) => {
      if (n.tablePosition === null || n.tablePosition.colHeader !== from) return n;
      const renamedCell = n.name === from ? { name: to, text: to } : {};
      return { ...n, ...renamedCell, tablePosition: { ...n.tablePosition, colHeader: to } };
    }),
  }) as Observation;

/**
 * The same rename, carried into the CONTAINER PATH as well.
 *
 * A driver reading summit's grid reports summit's header everywhere it reports one, container path
 * included, so this is the faithful shape. `withHeader` above stops short of the container path and
 * the tests that use it are about the header row alone; a rename that reaches the path also moves
 * the SCOPE, which is a different thing to be testing and is what the `columnHeaders` cases below
 * need.
 */
const withGridHeader = (obs: Observation, from: string, to: string): Observation =>
  ({
    ...withHeader(obs, from, to),
    nodes: withHeader(obs, from, to).nodes.map((n) => ({
      ...n,
      containerPath: n.containerPath.map((segment) =>
        segment.kind === "table"
          ? { ...segment, headers: segment.headers.map((h) => (h === from ? to : h)) }
          : segment,
      ),
    })),
  }) as Observation;

/**
 * The shares grid, scoped by the two columns this tenant did NOT rename.
 *
 * Derived from the shared matcher rather than written out, so it cannot drift from it. It exists
 * because the shipped matcher names all three of the grid's columns including the balance one, and
 * a case about "the balance header was renamed" cannot also depend on that header to find the grid
 * - the read would refuse with `scope-absent` before it ever reached the column lookup, and would
 * be testing the container matcher rather than the table read.
 */
const SHARES_SCOPE_INVARIANT: ContainerMatcher = (() => {
  const [frame, table] = SHARES_TABLE_MATCHER.path as readonly [
    ContainerMatcher["path"][number],
    { readonly kind: "table"; readonly headers: readonly unknown[] },
  ];
  return {
    path: [frame, { ...table, headers: [table.headers[0], table.headers[2]] }],
  } as unknown as ContainerMatcher;
})();

const withTableColumns = (columns: readonly { name: string }[]): ProgramFacts =>
  ({
    ...program,
    outputs: {
      ...program.outputs,
      shares: {
        type: { kind: "table", columns: columns.map((c) => ({ ...c, type: { kind: "string" } })) },
        sensitivity: "internal",
      },
    },
  }) as unknown as ProgramFacts;

function refusal(outcome: ExtractOutcome): Extract<ExtractOutcome, { ok: false }> {
  if (outcome.ok) throw new Error(`expected a refusal, got ${JSON.stringify(outcome.output)}`);
  return outcome;
}

// ---------------------------------------------------------------------------------------------
// Scalar reads
// ---------------------------------------------------------------------------------------------

describe("reading one declared value", () => {
  it("reads a cell addressed by row VALUE and column header, and types it", () => {
    // Row-and-column addressing keyed by values, never indices. Without it this degrades to "some
    // cell in this grid", which is how a checking balance gets read out as a savings balance.
    const outcome = readExtractSpec(specFor("savingsBalance"), "read", ctxFor(detail));
    expect(outcome.ok && outcome.output.value).toEqual({ currency: "USD", amount: "1284.55" });
  });

  it("carries the declared sensitivity with the value, so the sink does not have to guess", () => {
    const outcome = readExtractSpec(specFor("memberName"), "read", ctxFor(detail));
    expect(outcome.ok && outcome.output.sensitivity).toBe("sensitive");
  });

  it("refuses a value it cannot type rather than returning the text it found", () => {
    // "n/a" in a balance column is not a balance. A parser that shrugged and returned the string
    // would hand a caller a typed hole its generated types say cannot exist.
    const screen = withCell(detail, "cell:shares-1-1", { name: "n/a", text: "n/a" });
    const outcome = refusal(readExtractSpec(specFor("savingsBalance"), "read", ctxFor(screen)));
    expect(outcome.reason).toBe("unparseable");
    expect(outcome.detail).toContain("moneyUSD@1");
  });

  it("treats a blank cell as missing, and `onMissing: fail` as meaning it", () => {
    // Returning `{ savingsBalance: null }` to an agent is how a member is told their balance is
    // nothing. A whitespace-only cell is not a value.
    const screen = withCell(detail, "cell:shares-1-1", { name: "   ", text: "   " });
    expect(refusal(readExtractSpec(specFor("savingsBalance"), "read", ctxFor(screen))).reason).toBe(
      "missing",
    );
  });

  it("returns null for a missing value only when the artifact asked for that", () => {
    const optional = { ...specFor("savingsBalance"), onMissing: "null" } as ExtractSpec;
    const screen = withCell(detail, "cell:shares-1-1", { name: "", text: "" });
    const outcome = readExtractSpec(optional, "read", ctxFor(screen));
    expect(outcome.ok && outcome.output.value).toBeNull();
  });

  it("refuses when the query selects more than one node", () => {
    // Two candidates is an ambiguity, not a preference. Picking the first one is how a design
    // converts an ambiguity into a confident wrong answer.
    const duplicated = {
      ...detail,
      nodes: [
        ...detail.nodes,
        { ...(detail.nodes.find((n) => n.id === "textbox:member-name") as UINode), id: "clone:1" },
      ],
    } as Observation;
    const outcome = refusal(readExtractSpec(specFor("memberName"), "read", ctxFor(duplicated)));
    expect(outcome.reason).toBe("ambiguous");
    expect(outcome.detail).toBe("2 nodes matched");
  });

  it("refuses an output the contract does not declare, instead of inventing a type for it", () => {
    const undeclared = { ...specFor("memberName"), output: "notAnOutput" } as ExtractSpec;
    expect(refusal(readExtractSpec(undeclared, "read", ctxFor(detail))).reason).toBe(
      "type-not-declared",
    );
  });

  it("refuses row bounds on a scalar output, and a table output on a step that is not readTable", () => {
    const bounded = { ...specFor("memberName"), rows: { minRows: 1, maxRows: 2 } } as ExtractSpec;
    expect(refusal(readExtractSpec(bounded, "read", ctxFor(detail))).reason).toBe("type-mismatch");
    expect(
      refusal(readExtractSpec(sharesSpec({ minRows: 1, maxRows: 9 }), "read", ctxFor(detail)))
        .reason,
    ).toBe("type-mismatch");
  });
});

// ---------------------------------------------------------------------------------------------
// Bounded table reads
// ---------------------------------------------------------------------------------------------

describe("reading a bounded table", () => {
  it("returns the data rows, keyed by the CONTRACT's column names, header row excluded", () => {
    const outcome = readExtractSpec(
      sharesSpec({ minRows: 1, maxRows: 10 }),
      "readTable",
      ctxFor(detail),
    );
    expect(outcome.ok && outcome.output.value).toEqual([
      { "Share Type": "savings", "Current Balance": "1,284.55", Status: "open" },
      { "Share Type": "checking", "Current Balance": "210.00", Status: "open" },
      { "Share Type": "holiday club", "Current Balance": "0.00", Status: "closed" },
    ]);
  });

  it("keys the rows the same way when the tenant spells its headers differently", () => {
    // Two tenants of one vendor product. The spelling difference belongs in the one place a
    // per-tenant difference belongs, and the caller's typed rows must not know about it.
    const summit = withHeader(
      withHeader(detail, "Current Balance", "CURRENT BALANCE "),
      "Share Type",
      "Share  type",
    );
    const outcome = readExtractSpec(
      sharesSpec({ minRows: 1, maxRows: 10 }),
      "readTable",
      ctxFor(summit),
    );
    const rows = outcome.ok && Array.isArray(outcome.output.value) ? outcome.output.value : [];
    expect(Object.keys(rows[0] ?? {})).toEqual(["Share Type", "Current Balance", "Status"]);
  });

  it("refuses a read whose rows exceed the declared maximum - the truncation case", () => {
    // The whole reason `onTruncate` has exactly one legal value. Returning the first two of three
    // shares is a wrong answer that looks like a right one, and the caller cannot tell.
    const outcome = refusal(
      readExtractSpec(sharesSpec({ minRows: 1, maxRows: 2 }), "readTable", ctxFor(detail)),
    );
    expect(outcome.reason).toBe("truncated");
    expect(outcome.detail).toBe("3 rows, declared maximum 2");
  });

  it("refuses a read whose rows fall short of the declared minimum", () => {
    const outcome = refusal(
      readExtractSpec(sharesSpec({ minRows: 4, maxRows: 10 }), "readTable", ctxFor(detail)),
    );
    expect(outcome.reason).toBe("too-few-rows");
    expect(outcome.detail).toBe("3 rows, declared minimum 4");
  });

  it("reads the same table at a different length without the bounds moving", () => {
    // The filtered view of the same record. The bound is a property of the contract, not of the
    // screen, so a shorter grid is a legitimate answer and a longer one is not.
    const outcome = readExtractSpec(
      sharesSpec({ minRows: 1, maxRows: 3 }),
      "readTable",
      ctxFor(detailOpenShares),
    );
    expect(outcome.ok && outcome.output.value).toHaveLength(2);
  });

  it("refuses a column the contract declares and the grid does not have", () => {
    // A share row with no balance in it is a typed hole the caller was promised would not exist.
    // A row with a hole is worse than no rows, because it looks like an answer.
    const facts = withTableColumns([{ name: "Share Type" }, { name: "Available Balance" }]);
    const outcome = refusal(
      readExtractSpec(sharesSpec({ minRows: 1, maxRows: 10 }), "readTable", ctxFor(detail, facts)),
    );
    expect(outcome.reason).toBe("missing-column");
    expect(outcome.detail).toBe("Available Balance");
  });

  it("refuses two screen columns that read as the same declared column", () => {
    const twoStatusColumns = withHeader(detail, "Share Type", "Status");
    const facts = withTableColumns([{ name: "Status" }]);
    const outcome = refusal(
      readExtractSpec(
        sharesSpec({ minRows: 1, maxRows: 10 }),
        "readTable",
        ctxFor(twoStatusColumns, facts),
      ),
    );
    expect(outcome.reason).toBe("ambiguous");
    expect(outcome.detail).toBe("two columns read as Status");
  });

  it("refuses a row that is missing one of the declared columns", () => {
    const ragged = {
      ...detail,
      nodes: detail.nodes.filter((n) => n.id !== "cell:shares-2-1"),
    } as Observation;
    const outcome = refusal(
      readExtractSpec(sharesSpec({ minRows: 1, maxRows: 10 }), "readTable", ctxFor(ragged)),
    );
    expect(outcome.reason).toBe("missing-column");
    expect(outcome.detail).toBe("Current Balance in row 2");
  });

  it("refuses a blank cell in a declared column rather than reporting an empty balance", () => {
    const blank = withCell(detail, "cell:shares-1-1", { name: "", text: "" });
    const outcome = refusal(
      readExtractSpec(sharesSpec({ minRows: 1, maxRows: 10 }), "readTable", ctxFor(blank)),
    );
    expect(outcome.reason).toBe("missing");
    expect(outcome.detail).toBe("Current Balance in row 1");
  });

  it("refuses a table read that names no container, instead of blending every grid on the screen", () => {
    const unscoped = {
      ...sharesSpec({ minRows: 1, maxRows: 10 }),
      where: { role: "cell" },
    } as ExtractSpec;
    expect(refusal(readExtractSpec(unscoped, "readTable", ctxFor(detail))).reason).toBe(
      "scope-not-declared",
    );
  });

  it("refuses a table read whose container is not on this screen, and says which of the two it was", () => {
    // "The shares table is not here" and "the shares table is empty" are different bugs with
    // different fixes, and a single `too-few-rows` for both would send the reader to the wrong one.
    expect(
      refusal(
        readExtractSpec(sharesSpec({ minRows: 1, maxRows: 10 }), "readTable", ctxFor(searchForm)),
      ).reason,
    ).toBe("scope-absent");
    const headerOnly = {
      ...detail,
      nodes: detail.nodes.filter(
        (n) =>
          n.tablePosition === null ||
          n.tablePosition.rowIndex === 0 ||
          !n.id.startsWith("cell:shares"),
      ),
    } as Observation;
    expect(
      refusal(
        readExtractSpec(sharesSpec({ minRows: 1, maxRows: 10 }), "readTable", ctxFor(headerOnly)),
      ).reason,
    ).toBe("too-few-rows");
  });

  it("refuses a table read with no declared bounds - there is no unbounded iteration here", () => {
    const unbounded = {
      ...sharesSpec({ minRows: 1, maxRows: 10 }),
      rows: undefined,
    } as ExtractSpec;
    expect(refusal(readExtractSpec(unbounded, "readTable", ctxFor(detail))).reason).toBe(
      "bounds-not-declared",
    );
  });

  // -------------------------------------------------------------------------------------------
  // `columnHeaders`: the SURFACE half of a table read, on the artifact where it belongs
  // -------------------------------------------------------------------------------------------
  //
  // Without this field a table read matches the CONTRACT's column names straight against the
  // strings the grid prints, which quietly puts surface vocabulary on a document SPEC section 0
  // decision 4 says carries none - and makes the read fail at the first tenant that renames a
  // header. Build unit 19 hit exactly that against the real fixture: summit prints "Savings
  // Balance" where riverbend prints "Share Balance", and no overlay could reach it, because an
  // overlay may not touch a contract.

  it("matches a renamed screen header through a vocabulary token, and still keys the rows by the CONTRACT's names", () => {
    const summit = withGridHeader(detail, "Current Balance", "Savings Balance");
    // What the tenant's overlay would have replaced. The base flow declares
    // `balance-column: ["Current Balance", "Balance"]`; this is that token, replaced wholesale.
    const facts = {
      ...program,
      vocabulary: { ...program.vocabulary, "balance-column": ["Savings Balance"] },
    } as ProgramFacts;
    const spec = {
      ...sharesSpec({ minRows: 1, maxRows: 10 }),
      where: { scope: SHARES_SCOPE_INVARIANT, role: "cell" },
      columnHeaders: {
        "Current Balance": { mode: "token", token: "balance-column", normalize: "std.label@1" },
      },
    } as unknown as ExtractSpec;

    const outcome = readExtractSpec(spec, "readTable", ctxFor(summit, facts));
    expect(outcome.ok).toBe(true);
    const rows = outcome.ok && Array.isArray(outcome.output.value) ? outcome.output.value : [];
    // The caller's key is the contract's, at both tenants. That is the whole point of putting the
    // screen's word on the artifact instead.
    expect(Object.keys(rows[0] ?? {})).toEqual(["Share Type", "Current Balance", "Status"]);
    expect(rows[0]).toMatchObject({ "Current Balance": "1,284.55" });
  });

  it("is what makes that work: the same read without the map refuses at the renamed header", () => {
    // The negative control for the test above. A feature whose absence changes nothing is a
    // feature nobody needed, and this is the assertion that says the map is load-bearing.
    const summit = withGridHeader(detail, "Current Balance", "Savings Balance");
    const unmapped = {
      ...sharesSpec({ minRows: 1, maxRows: 10 }),
      where: { scope: SHARES_SCOPE_INVARIANT, role: "cell" },
    } as unknown as ExtractSpec;
    const outcome = refusal(readExtractSpec(unmapped, "readTable", ctxFor(summit)));
    expect(outcome.reason).toBe("missing-column");
    expect(outcome.detail).toBe("Current Balance");
  });

  it("refuses when the mapped token matches nothing on the screen - it does not fall back", () => {
    // A token that no longer resolves must REFUSE, not quietly revert to matching the contract's
    // own name. A fallback here would mean a tenant whose overlay had gone stale silently read a
    // column the artifact never meant, which is the fallback-chain failure this design refuses
    // everywhere else.
    const facts = {
      ...program,
      vocabulary: { ...program.vocabulary, "balance-column": ["Ledger Balance"] },
    } as ProgramFacts;
    const spec = {
      ...sharesSpec({ minRows: 1, maxRows: 10 }),
      where: { scope: SHARES_SCOPE_INVARIANT, role: "cell" },
      columnHeaders: {
        "Current Balance": { mode: "token", token: "balance-column", normalize: "std.label@1" },
      },
    } as unknown as ExtractSpec;
    const outcome = refusal(readExtractSpec(spec, "readTable", ctxFor(detail, facts)));
    expect(outcome.reason).toBe("missing-column");
    expect(outcome.detail).toBe("Current Balance");
  });

  it("leaves the columns it does not name matching by their declared name", () => {
    // Additive: a map that covers one column of three does not disturb the other two, which is why
    // every artifact written before this field existed still reads exactly as it did.
    const spec = {
      ...sharesSpec({ minRows: 1, maxRows: 10 }),
      columnHeaders: {
        "Current Balance": { mode: "token", token: "balance-column", normalize: "std.label@1" },
      },
    } as unknown as ExtractSpec;
    const outcome = readExtractSpec(spec, "readTable", ctxFor(detail));
    expect(outcome.ok && outcome.output.value).toEqual([
      { "Share Type": "savings", "Current Balance": "1,284.55", Status: "open" },
      { "Share Type": "checking", "Current Balance": "210.00", Status: "open" },
      { "Share Type": "holiday club", "Current Balance": "0.00", Status: "closed" },
    ]);
  });

  it("reads a different grid with the same function, and returns only the declared shape", () => {
    // Nothing about the shares table is special-cased: a different grid, a different set of
    // columns, the same spec. The results grid also carries an "Actions" column the contract does
    // not declare, and the caller gets the shape it generated types from rather than the screen's.
    const facts = withTableColumns([
      { name: "Member ID" },
      { name: "Member Name" },
      { name: "Status" },
    ]);
    const spec = {
      ...sharesSpec({ minRows: 1, maxRows: 10 }),
      where: { scope: RESULTS_TABLE_MATCHER, role: "cell" },
    } as ExtractSpec;
    const outcome = readExtractSpec(spec, "readTable", ctxFor(results, facts));
    expect(outcome.ok && outcome.output.value).toEqual([
      { "Member ID": "50001", "Member Name": "avery synthetic", Status: "open" },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// What the classifier does with a refusal
// ---------------------------------------------------------------------------------------------

describe("a refused read is a hard failure, never a partial success", () => {
  it("reports truncation as output-extraction-failed, with the bound it broke", () => {
    const verdict = classify(inputFor(readSharesStep(2), detail));
    expect(verdict.kind).toBe("fail");
    if (verdict.kind !== "fail") return;
    expect(verdict.failure).toBe("output-extraction-failed");
    expect(verdict.detail.expected.rendered).toContain("shares: truncated");
    expect(verdict.detail.expected.rendered).toContain("declared maximum 2");
  });

  it("does not describe an extraction failure as a failed checkpoint", () => {
    // The checkpoint PASSED. Rendering its clauses here would print a list of true statements under
    // the word "expected", which is the most misleading thing that field could say at 2am.
    const verdict = classify(inputFor(readSharesStep(2), detail));
    if (verdict.kind !== "fail") throw new Error("expected a failure");
    expect(verdict.detail.expected.rendered).toContain("every declared output can be read");
    expect(verdict.detail.expected.clauses).toEqual([]);
  });

  it("says nothing was returned, rather than returning what it managed to read", () => {
    const verdict = classify(inputFor(readSharesStep(2), detail));
    expect(JSON.stringify(verdict)).not.toContain("holiday club");
  });
});
