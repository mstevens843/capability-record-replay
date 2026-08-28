// One failing fixture per numbered check in SPEC section 10.
//
// The list lives in `test/fixtures/` rather than inside a test file because unit 7 needs it: the
// linker's acceptance criterion is "28 tests, one per check, each with a fixture that must fail it
// and one that must pass", and the passing fixture is `member-lookup.ts` while these are the
// failing ones. Writing them twice would guarantee they drift.
//
// Each case records WHO refuses it, and that is the interesting column:
//
//   · `schema`  - the document is refused at parse time. The mistake is unrepresentable, or close
//                 enough that a validator catches it with no other document in hand.
//   · `digest`  - the document parses and its content address no longer matches, which is the
//                 mechanism an approval signature rests on.
//   · `linker`  - the document is VALID on its own and only wrong in company: against the contract
//                 it claims to implement, against the surface it will run on, or against the
//                 arguments it was called with. These cases assert that the document still parses,
//                 which is the honest statement that a validator cannot close them.
//
// Forty percent of section 10 turning out to be schema-owned is the point of the exercise. A rule
// enforced by a type is a rule nobody has to remember at 2am.

import {
  artifactDigestIsIntact,
  safeParseArtifact,
  safeParseContract,
  safeParseOverlay,
} from "../../src/index.js";
import { memberLookupArtifact, memberLookupContract, summitOverlay } from "./member-lookup.js";

/** A loose view of a document, for a mutation that is deliberately wrong. */
export type JsonRecord = { [key: string]: unknown };

export type RefusedBy = "schema" | "digest" | "linker";
export type DocumentKind = "artifact" | "contract" | "overlay";

export interface RejectionCase {
  /** The numbered check in SPEC section 10. */
  readonly check: number;
  readonly what: string;
  readonly refusedBy: RefusedBy;
  readonly document: DocumentKind;
  /** The reason this one is not a validator's job, present only on linker cases. */
  readonly needs?: string;
  readonly mutate: (doc: JsonRecord) => void;
}

const artifact = () => structuredClone(memberLookupArtifact) as unknown as JsonRecord;
const contract = () => structuredClone(memberLookupContract) as unknown as JsonRecord;
const overlay = () => structuredClone(summitOverlay) as unknown as JsonRecord;

/** The document each case mutates, already mutated. */
export function buildRejection(c: RejectionCase): JsonRecord {
  const doc =
    c.document === "artifact" ? artifact() : c.document === "contract" ? contract() : overlay();
  c.mutate(doc);
  return doc;
}

export function documentIsRefused(c: RejectionCase, doc: JsonRecord): boolean {
  if (c.refusedBy === "digest") {
    return !artifactDigestIsIntact(doc);
  }
  const parsed =
    c.document === "artifact"
      ? safeParseArtifact(doc)
      : c.document === "contract"
        ? safeParseContract(doc)
        : safeParseOverlay(doc);
  return !parsed.success;
}

// Small typed accessors, so a mutation reads as the edit a careless author would actually make.
const steps = (doc: JsonRecord) => (doc.flow as JsonRecord).steps as JsonRecord[];
const step = (doc: JsonRecord, id: string) => steps(doc).find((s) => s.id === id) as JsonRecord;

export const SPEC_10_REJECTIONS: readonly RejectionCase[] = [
  {
    check: 1,
    what: "an unknown schema version is refused rather than ignored",
    refusedBy: "schema",
    document: "artifact",
    mutate: (d) => {
      d.schemaVersion = "capability.artifact/v2";
    },
  },
  {
    check: 2,
    what: "an edited approved artifact no longer matches its digest",
    refusedBy: "digest",
    document: "artifact",
    mutate: (d) => {
      (step(d, "submit-search").settle as JsonRecord).maxWaitMs = 30_000;
    },
  },
  {
    check: 3,
    what: "the contract digest the artifact claims to implement is not the contract that loaded",
    refusedBy: "linker",
    document: "artifact",
    needs: "the contract, to recompute its digest",
    mutate: (d) => {
      (d.implements as JsonRecord).contractDigest =
        "sha256:1111111111111111111111111111111111111111111111111111111111111111";
    },
  },
  {
    check: 4,
    what: "the caller's pinned contract digest is stale",
    refusedBy: "linker",
    document: "contract",
    needs: "the invocation, which is not a document",
    mutate: (d) => {
      d.version = "1.1.0";
    },
  },
  {
    check: 5,
    what: "a value is read from a step that does not run earlier",
    refusedBy: "schema",
    document: "artifact",
    mutate: (d) => {
      const fill = step(d, "enter-member-id").instruction as JsonRecord;
      fill.value = { from: "output", step: "read-savings-balance", output: "memberName" };
    },
  },
  {
    check: 6,
    what: "one output is written by two different steps",
    refusedBy: "schema",
    document: "artifact",
    mutate: (d) => {
      const read = step(d, "read-savings-balance").extract as JsonRecord[];
      (step(d, "submit-search").extract as JsonRecord[]).push(
        structuredClone(read[1] as JsonRecord),
      );
    },
  },
  {
    check: 7,
    what: "a declared contract output has no producing extraction",
    refusedBy: "linker",
    document: "artifact",
    needs: "the contract, to know which outputs were promised",
    mutate: (d) => {
      const extract = step(d, "read-savings-balance").extract as JsonRecord[];
      extract.splice(0, 1);
    },
  },
  {
    check: 8,
    what: "a detector names an outcome the contract never declared",
    refusedBy: "linker",
    document: "artifact",
    needs: "the contract, to know which outcome codes exist",
    mutate: (d) => {
      (step(d, "submit-search").outcomes as JsonRecord[])[0]!.code = "MEMBER_ASLEEP";
    },
  },
  {
    check: 9,
    what: "two rules in one step share a priority, which would be a runtime coin-flip",
    refusedBy: "schema",
    document: "artifact",
    mutate: (d) => {
      const outcomes = step(d, "submit-search").outcomes as JsonRecord[];
      outcomes.push({ ...structuredClone(outcomes[0] as JsonRecord), code: "MEMBER_RESTRICTED" });
    },
  },
  {
    check: 10,
    what: "a matcher carries a stylesheet selector instead of a name a person would read",
    refusedBy: "schema",
    document: "artifact",
    mutate: (d) => {
      const target = step(d, "submit-search").target as JsonRecord;
      (target.descriptors as JsonRecord[])[0]!.name = {
        mode: "exact",
        value: "#ctl00_g_9a1 > td:nth-child(3) a",
        normalize: "std.text@1",
      };
    },
  },
  {
    check: 11,
    what: "a target is left with one descriptor, so nothing can disagree with it",
    refusedBy: "schema",
    document: "artifact",
    mutate: (d) => {
      const target = step(d, "submit-search").target as JsonRecord;
      (target.descriptors as JsonRecord[]).splice(1, 1);
    },
  },
  {
    check: 12,
    what: "a geometric descriptor is anchored to another geometric descriptor",
    refusedBy: "schema",
    document: "artifact",
    mutate: (d) => {
      const target = step(d, "submit-search").target as JsonRecord;
      const geometric = (target.descriptors as JsonRecord[])[1] as JsonRecord;
      geometric.anchor = structuredClone(geometric);
    },
  },
  {
    check: 13,
    what: "the recorded effect summary does not match what the steps actually do",
    refusedBy: "schema",
    document: "artifact",
    mutate: (d) => {
      (d.effects as JsonRecord).maxEffect = "WRITE_REVERSIBLE";
    },
  },
  {
    check: 14,
    what: "a detector was written with the member number in it instead of a template hole",
    refusedBy: "schema",
    document: "artifact",
    mutate: (d) => {
      (step(d, "submit-search").outcomes as JsonRecord[])[0]!.detect = {
        kind: "text-present",
        text: { mode: "contains", value: "No member found for 400123456", normalize: "std.text@1" },
      };
    },
  },
  {
    check: 15,
    what: "the action budget cannot cover the program's own declared recoveries",
    refusedBy: "schema",
    document: "artifact",
    mutate: (d) => {
      (d.budgets as JsonRecord).maxActions = 2;
    },
  },
  {
    check: 16,
    what: "a remedy is given more than four instructions",
    refusedBy: "schema",
    document: "artifact",
    mutate: (d) => {
      const ambient = (d.flow as JsonRecord).ambient as JsonRecord[];
      const remedy = ambient[1]!.remedy as JsonRecord;
      const one = (remedy.instructions as JsonRecord[])[0] as JsonRecord;
      remedy.instructions = [one, one, one, one, one];
    },
  },
  {
    check: 17,
    what: "the program needs a descriptor kind this surface cannot resolve",
    refusedBy: "linker",
    document: "artifact",
    needs: "the driver's advertised capabilities",
    mutate: (d) => {
      (d.target as JsonRecord).requires = ["accessibility-tree", "character-grid"];
    },
  },
  {
    check: 18,
    what: "a predicate nests deeper than the language allows",
    refusedBy: "schema",
    document: "artifact",
    mutate: (d) => {
      const expect = step(d, "open-search").expect as JsonRecord;
      expect.predicate = {
        all: [{ any: [{ not: { all: [{ any: [{ kind: "settled" }] }] } }] }],
      };
    },
  },
  {
    check: 19,
    what: "a recovery restarts from a step that is not a declared resume point",
    refusedBy: "schema",
    document: "artifact",
    mutate: (d) => {
      const recovery = (step(d, "submit-search").recoveries as JsonRecord[])[0] as JsonRecord;
      recovery.resume = "restart-from-checkpoint";
      recovery.resumeAt = "enter-member-id";
    },
  },
  {
    check: 20,
    what: "an overlay tries to change what the capability means",
    refusedBy: "schema",
    document: "overlay",
    mutate: (d) => {
      (d.steps as JsonRecord)["submit-search"] = { effect: "WRITE_IRREVERSIBLE" };
    },
  },
  {
    check: 21,
    what: "a program hardcodes a function key the driver is supposed to choose",
    refusedBy: "schema",
    document: "artifact",
    mutate: (d) => {
      step(d, "submit-search").instruction = { kind: "pressKey", key: "F5" };
    },
  },
  {
    check: 22,
    what: "an outcome detector is allowed to fire before the step that would produce it",
    refusedBy: "schema",
    document: "artifact",
    mutate: (d) => {
      (step(d, "submit-search").outcomes as JsonRecord[])[0]!.phase = "pre";
    },
  },
  {
    check: 23,
    what: "a non-environment recovery claims the right to fire against an unsettled screen",
    refusedBy: "schema",
    document: "artifact",
    mutate: (d) => {
      (step(d, "submit-search").recoveries as JsonRecord[])[0]!.allowUnsettled = true;
    },
  },
  {
    check: 24,
    what: "a table read declares no row bounds, so truncation would be silent",
    refusedBy: "schema",
    document: "artifact",
    mutate: (d) => {
      step(d, "read-savings-balance").instruction = { kind: "readTable" };
    },
  },
  {
    check: 25,
    what: "a step is written with no postcondition",
    refusedBy: "schema",
    document: "artifact",
    mutate: (d) => {
      const s = step(d, "submit-search");
      s.expect = undefined;
    },
  },
  {
    check: 26,
    what: "a route uses an origin alias the policy does not permit",
    refusedBy: "schema",
    document: "artifact",
    mutate: (d) => {
      const routes = (d.flow as JsonRecord).routes as JsonRecord[];
      routes[1]!.originAlias = "elsewhere";
    },
  },
  {
    check: 27,
    what: "replay is asked to run an artifact that was never approved",
    refusedBy: "linker",
    document: "artifact",
    needs: "the run mode and a trust store of approver keys",
    mutate: (d) => {
      (d.lifecycle as JsonRecord).status = "draft";
      (d.lifecycle as JsonRecord).approval = null;
    },
  },
  {
    check: 28,
    what: "a supplied argument does not satisfy the parameter's declared constraints",
    refusedBy: "linker",
    document: "contract",
    needs: "the caller's arguments, which are not a document",
    mutate: (d) => {
      const inputs = d.inputs as JsonRecord[];
      (inputs[0]!.constraints as JsonRecord).charset = "alnum";
    },
  },
];
