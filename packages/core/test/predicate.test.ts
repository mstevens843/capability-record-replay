// The predicate language.
//
// The first test here is the one that earns its keep. `Predicate`'s TypeScript type is hand-written
// - zod cannot infer a recursive union without an annotation - so the type and the schema are two
// definitions of one thing, which is exactly the arrangement this project argues against everywhere
// else. The compiler catches an arm whose SHAPE drifts; it cannot catch an arm that was added to the
// type and forgotten in the schema. This does.

import { describe, expect, it } from "vitest";
import {
  BoundedPredicateSchema,
  MAX_PREDICATE_DEPTH,
  NodeQuerySchema,
  type Predicate,
  PredicateSchema,
  predicateDepth,
  predicateLeaves,
} from "../src/index.js";

const anyRow = { role: "row" } as const;

/** One example of every arm the type declares. */
const ARMS: Readonly<Record<string, Predicate>> = {
  all: { all: [{ kind: "settled" }] },
  any: { any: [{ kind: "settled" }] },
  not: { not: { kind: "settled" } },
  "node-exists": { kind: "node-exists", where: anyRow },
  "node-absent": { kind: "node-absent", where: anyRow },
  "text-present": {
    kind: "text-present",
    text: { mode: "contains", value: "No member found", normalize: "std.text@1" },
  },
  "node-state": { kind: "node-state", where: anyRow, state: "disabled", equals: false },
  "value-matches": {
    kind: "value-matches",
    where: anyRow,
    matcher: { mode: "exact", value: "OPEN", normalize: "std.text@1" },
  },
  count: { kind: "count", where: anyRow, op: "gte", n: 1 },
  "route-matches": { kind: "route-matches", route: "member-detail" as never },
  settled: { kind: "settled" },
  "native-dialog": { kind: "native-dialog", dialogType: "confirm" },
  continuity: { kind: "continuity", ref: "subjectMember" },
};

describe("the predicate language", () => {
  it("has a schema arm for every arm of the type", () => {
    for (const [name, predicate] of Object.entries(ARMS)) {
      const parsed = PredicateSchema.safeParse(predicate);
      expect(parsed.success, `the ${name} arm must parse`).toBe(true);
    }
  });

  it("refuses a construct the language deliberately does not have", () => {
    // No arithmetic beyond a count comparison, no regex, no expression language, no user-defined
    // function. Each of these is something a model will try once.
    for (const invented of [
      { kind: "matches-regex", where: anyRow, pattern: "^No member" },
      { kind: "eval", expression: "nodes.length > 0" },
      { kind: "text-present", text: { mode: "regex", value: ".*", normalize: "std.text@1" } },
      { all: [] },
      { all: [{ kind: "settled" }], any: [{ kind: "settled" }] },
    ]) {
      expect(PredicateSchema.safeParse(invented).success, JSON.stringify(invented)).toBe(false);
    }
  });

  it("bounds its own depth", () => {
    const nest = (depth: number): Predicate =>
      depth <= 1 ? { kind: "settled" } : { all: [nest(depth - 1)] };
    expect(predicateDepth(nest(MAX_PREDICATE_DEPTH))).toBe(MAX_PREDICATE_DEPTH);
    expect(BoundedPredicateSchema.safeParse(nest(MAX_PREDICATE_DEPTH)).success).toBe(true);
    expect(BoundedPredicateSchema.safeParse(nest(MAX_PREDICATE_DEPTH + 1)).success).toBe(false);
  });

  it("flattens to its leaves, which is how the artifact checks what it references", () => {
    const composite: Predicate = {
      all: [{ kind: "settled" }, { not: { kind: "continuity", ref: "subjectMember" } }],
    };
    expect(predicateLeaves(composite).map((l) => l.kind)).toEqual(["settled", "continuity"]);
  });
});

describe("NodeQuery", () => {
  it("refuses a query that constrains nothing about the node", () => {
    // A detector that matches every node in a container is a machine for emitting a business
    // outcome nobody observed - and MEMBER_NOT_FOUND is the worst thing this system can invent.
    const scopeOnly = {
      scope: {
        path: [
          { kind: "frame", name: { mode: "exact", value: "content", normalize: "std.text@1" } },
        ],
      },
    };
    expect(NodeQuerySchema.safeParse(scopeOnly).success).toBe(false);
    expect(NodeQuerySchema.safeParse({ ...scopeOnly, role: "row" }).success).toBe(true);
  });

  it("addresses a cell by value, never by index", () => {
    const byValue = {
      cell: {
        table: {
          path: [
            {
              kind: "table",
              headers: [{ mode: "token", token: "member-column", normalize: "std.label@1" }],
            },
          ],
        },
        rowKey: {
          columnHeader: { mode: "token", token: "member-column", normalize: "std.label@1" },
          value: { from: "param", param: "memberId" },
        },
        columnHeader: { mode: "token", token: "balance-column", normalize: "std.label@1" },
      },
    };
    expect(NodeQuerySchema.safeParse(byValue).success).toBe(true);

    const byIndex = { cell: { table: byValue.cell.table, rowIndex: 3, colIndex: 2 } };
    expect(NodeQuerySchema.safeParse(byIndex).success).toBe(false);
  });
});
