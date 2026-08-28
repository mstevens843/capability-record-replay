// What the caller is told, and how the interpreter reads it off the screen.
//
// A `note_output` tool call is the model saying "this node holds a value the caller should receive".
// It supplied a node reference, a name and a sentence of meaning; it did not supply a query, a
// parser, a type or a sensitivity, and it is not asked to. Those are derived here from the frozen
// observation, for the same reason locators are: a model-authored extraction spec is a model-authored
// claim about what a number means, and this system's whole argument is that the model discovers once
// and deterministic code decides forever.
//
// TWO DERIVATIONS ARE WORTH READING THE ARGUMENT FOR.
//
// A DIGIT STRING IS NEVER PARSED AS AN INTEGER. `integer@1` returns a JavaScript number, and a
// number has no leading zero. Every account, routing and member identifier in a core banking system
// does. The failure is silent and permanent - `0012345` becomes `12345`, which is a different
// member - so a run of digits becomes a `string` with `charset: "digits"`, and the artifact says so
// where a reviewer can see it. A caller who genuinely wants arithmetic asks for it explicitly.
//
// THE QUERY IS VERIFIED, NOT ASSUMED. `readExtractSpec` refuses when a query matches more than one
// node, and a spec that matches two nodes at record time will match two at replay time. So the
// derived `NodeQuery` is run through `@crr/core`'s own `queryNodes` against the observation it came
// from, and a spec that does not select exactly the noted node is a blocking problem rather than a
// document that fails on its first real call.

import {
  type ExtractSpec,
  type ExtractorId,
  type NodeQuery,
  type NormalizerId,
  type OutputSpec,
  type ParserId,
  type RowKey,
  type Sensitivity,
  type UINode,
  type ValueType,
  piiShapeOf,
  queryNodes,
} from "@crr/core";
import type { RecordedOutput } from "../loop.js";
import { type Vocabulary, containerMatcherOf, rowKeyFor } from "./descriptors.js";
import { type ObservedValue, observedValuesOf, scrubProse, withholdingDetail } from "./prose.js";
import type { SynthesisNote } from "./report.js";
import type { ValueBinding } from "./values.js";

export interface DerivedOutput {
  readonly spec: OutputSpec;
  readonly extract: ExtractSpec;
  /** The observation the value was read from, so the emitter can place the read step on the screen
   *  the model was actually looking at rather than at the end of the flow. */
  readonly observationSeq: number;
}

export interface DeriveOutputsInput {
  readonly outputs: readonly RecordedOutput[];
  readonly bindings: readonly ValueBinding[];
  readonly vocabulary: Vocabulary;
  /** Every value the run declared as an output, so `meaning` can be tested against it. Defaults to
   *  the values of `outputs`; the emitter passes its own copy so the whole pipeline measures model
   *  prose against one list and reports the too-short ones exactly once. */
  readonly observed?: readonly ObservedValue[];
}

export interface DerivedOutputs {
  readonly outputs: readonly DerivedOutput[];
  readonly notes: readonly SynthesisNote[];
}

export function deriveOutputs(input: DeriveOutputsInput): DerivedOutputs {
  const notes: SynthesisNote[] = [];
  const derived: DerivedOutput[] = [];
  const seen = new Set<string>();
  const observed = input.observed ?? observedValuesOf(input.outputs).values;

  for (const output of input.outputs) {
    if (seen.has(output.outputName)) continue;
    const node = output.observation.nodes.find((one) => one.id === output.nodeId);
    if (node === undefined || node.ariaRole === null) {
      notes.push({
        code: "instruction-not-representable",
        severity: "blocking",
        detail: `the node noted as output "${output.outputName}" is not an addressable node in the observation it was noted on`,
      });
      continue;
    }
    const scope = containerMatcherOf(node.containerPath, input.vocabulary);
    if (scope === null) {
      notes.push({
        code: "instruction-not-representable",
        severity: "blocking",
        detail: `the node noted as output "${output.outputName}" sits in no container, so no scoped query can name it`,
      });
      continue;
    }

    // Row addressing for a READ, derived exactly as it is for a click. Reading a balance out of a
    // grid is as exposed to the wrong row as clicking one is, and the same key closes both.
    const rowKey = rowKeyFor(
      node,
      output.observation,
      input.bindings,
      input.vocabulary,
      new Map(output.observation.nodes.map((one) => [one.id as string, one])),
    );
    // A CELL IS ADDRESSED BY ITS ROW AND COLUMN, NEVER BY WHAT IT SAYS.
    //
    // Found by executing a synthesized artifact against the live fixture (see
    // `packages/runtime/test/synthesized-replay.test.ts`): on a legacy grid a cell's accessible
    // name IS the value being read, so folding it into the query pins the capability to the one
    // member it was recorded on. Two failures at once, and the first is the worse of the two:
    //
    //   · the artifact would carry "ALVAREZ, DANA (SYNTHETIC)" and "1,204.55" in `flow.vocabulary`
    //     - recorded member data in the one document that is committed, diffed and SIGNED, which is
    //     exactly what BRIEF section 3.6 says an artifact must never hold. Parameterization does
    //     not catch it, because the member's NAME was never mentioned in the goal and so was never
    //     bound to anything;
    //   · and the next caller, asking about a different member, gets `output-extraction-failed` for
    //     a screen that is showing them their answer.
    //
    // So when row-and-column addressing is available it is used ALONE. `extractorOf` already says
    // the same thing one field along about `cell@1` never reading the accessible name; this is that
    // rule applied to the query rather than to the reader.
    //
    // `Vocabulary.matcher` MINTS a token as a side effect, so the name is asked for only on the
    // branch that will use it. Asking for it unconditionally would put the member's name in
    // `flow.vocabulary` even on the runs where nothing went on to reference it.
    const bare: NodeQuery = { scope, role: node.ariaRole };
    const addressed: NodeQuery | null =
      rowKey === null || node.tablePosition === null || node.tablePosition.colHeader === null
        ? null
        : cellQuery(bare, node, rowKey, input.vocabulary);
    const named = (): NodeQuery => {
      const name = input.vocabulary.matcher(node.name);
      return name === null ? bare : { ...bare, name };
    };
    const where: NodeQuery = addressed ?? named();

    const matched = queryNodes(where, {
      observation: output.observation,
      program: {
        routes: [],
        vocabulary: input.vocabulary.record(),
        continuity: [],
        outputs: {},
        brandingTokens: [],
        maxEffect: "READ",
        restartSafeUpToPc: 0,
        resumePoints: [],
      },
      bindings: input.bindings.map((binding) => ({
        name: binding.param,
        origin: "param" as const,
        value: binding.value,
        sensitivity: binding.sensitivity,
        handle: null,
      })),
    });
    if (matched.length !== 1 || matched[0]?.id !== node.id) {
      notes.push({
        code: "instruction-not-representable",
        severity: "blocking",
        detail: `the query derived for output "${output.outputName}" selects ${matched.length} node(s) on the screen it was recorded from, and an extraction that is ambiguous at record time is ambiguous at replay time`,
      });
      continue;
    }

    const displayed = readableValueOf(node);
    const reading = readingOf(displayed);
    const sensitivity: Sensitivity = piiShapeOf(displayed) === null ? "internal" : "sensitive";
    const from = extractorOf(node, where);

    // `meaning` is a sentence the model wrote about a value it was looking at, and it lands in the
    // CONTRACT as `OutputSpec.description` - a committed, signed, model-facing document. Same
    // treatment as `Step.intent` and the outcome candidates: parameterize, then withhold if it
    // still carries a value the run declared as an output. A description reading "the balance,
    // 15,900.00" is the same defect as the report's, in the document that matters more.
    const meaning = scrubProse(output.meaning, input.bindings, observed);
    if (meaning.withheldFor.length > 0) {
      notes.push({
        code: "prose-withheld",
        severity: "review",
        detail: withholdingDetail(
          `stated meaning for the output "${output.outputName}"`,
          meaning.withheldFor,
        ),
      });
    }

    seen.add(output.outputName);
    derived.push({
      observationSeq: output.observation.seq,
      spec: {
        name: output.outputName,
        type: reading.type,
        required: true,
        description: meaning.text.slice(0, 1000),
        sensitivity,
        // `deliver` is the balance where reading the value is the point of the call; a value that
        // already looks like regulated data is masked from the MODEL even though the typed result
        // handed to the calling program still carries it (SPEC section 2.3).
        agentDisclosure: sensitivity === "sensitive" ? "mask" : "deliver",
      },
      extract: {
        output: output.outputName,
        from,
        where,
        parse: reading.parse,
        normalize: reading.normalize,
        // Returning `{ balance: null }` to an agent is how a member gets told their balance is
        // nothing. A missing required output is a failure, not a partial success.
        onMissing: "fail",
      },
    });

    if (sensitivity === "sensitive") {
      notes.push({
        code: "parameter-regulated-shape",
        severity: "review",
        detail: `output "${output.outputName}" reads a value with the shape of regulated data; it is declared sensitive and masked from the model, and a person should confirm that is the right disclosure`,
      });
    } else if (reading.type.kind === "string") {
      notes.push({
        code: "prose-needs-author",
        severity: "review",
        detail: `output "${output.outputName}" is free text, and no deterministic rule can tell a balance from a member's name; a person must confirm its sensitivity and agentDisclosure before this contract is published`,
      });
    }
  }

  return { outputs: derived, notes };
}

/**
 * Row-and-column addressing for a value read out of a grid.
 *
 * Without it, extraction on a legacy accounts grid degrades to "some cell in this table", which is
 * how a checking balance gets reported as a savings balance to a member on the phone. With it, the
 * cell is addressed by the member the caller asked about and the column the app itself labelled.
 */
function cellQuery(
  base: NodeQuery,
  node: UINode,
  rowKey: RowKey,
  vocabulary: Vocabulary,
): NodeQuery | null {
  const table = containerMatcherOf(node.containerPath, vocabulary);
  const columnHeader = vocabulary.matcher(node.tablePosition?.colHeader ?? "");
  if (table === null || columnHeader === null) return null;
  return { ...base, cell: { table, rowKey, columnHeader } };
}

/** What the node displays, for typing purposes only. Never stored. */
function readableValueOf(node: UINode): string {
  if (node.value !== null && node.value.trim().length > 0) return node.value;
  if (node.text !== null && node.text.trim().length > 0) return node.text;
  return node.name;
}

/** Which field of the node carries the value. `cell@1` deliberately never falls back to the
 *  accessible name: on a table-based layout a cell's computed name is often its column header. */
function extractorOf(node: UINode, where: NodeQuery): ExtractorId {
  if (where.cell !== undefined) return "cell@1";
  if (node.value !== null && node.value.trim().length > 0) return "value@1";
  if (node.text !== null && node.text.trim().length > 0) return "text@1";
  return "name@1";
}

interface Reading {
  readonly type: ValueType;
  readonly parse: ParserId;
  readonly normalize: NormalizerId;
}

/**
 * A DELIVERED VALUE IS NEVER CASE-FOLDED.
 *
 * `std.text@1` lowercases, which is exactly right for matching a label against a screen and exactly
 * wrong for a value the caller receives: a member whose name comes back as "alvarez, dana" is being
 * read their own record back in the wrong case by an agent that is supposed to be quoting the core
 * system. `ExtractSpec.normalize` sits on the DELIVERY path, not the matching path, so the default
 * here is identity and a normalizer is chosen only where it earns its place - `std.money@1` strips
 * the currency decoration `moneyUSD@1` would otherwise refuse.
 *
 * Found by executing a synthesized artifact against the live fixture
 * (`packages/runtime/test/synthesized-replay.test.ts`); the hand-authored artifact had made the same
 * choice, in a comment, one field along.
 */
const DELIVERED: NormalizerId = "std.identity@1";

/** `$1,234.56`, `(1,234.56)`, `1234.56-` - what a banking screen prints for money, and nothing
 *  looser. Two decimal places are required: a bare `1.5` is a rate or a version, not a balance. */
const MONEY = /^[$(]?\s*-?[0-9][0-9,]*\.[0-9]{2}\s*\)?-?$/;
const DATE_US = /^[0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4}$/;
const DATE_ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const DIGITS = /^[0-9]+$/;

function readingOf(observed: string): Reading {
  const value = observed.trim();
  if (MONEY.test(value)) {
    return {
      type: { kind: "money", currency: "USD" },
      parse: "moneyUSD@1",
      normalize: "std.money@1",
    };
  }
  if (DATE_US.test(value)) {
    return {
      type: { kind: "date", format: "YYYY-MM-DD" },
      parse: "dateUS@1",
      normalize: DELIVERED,
    };
  }
  if (DATE_ISO.test(value)) {
    return {
      type: { kind: "date", format: "YYYY-MM-DD" },
      parse: "dateISO@1",
      normalize: DELIVERED,
    };
  }
  if (DIGITS.test(value)) {
    // A run of digits, kept as a string. See the header: an integer loses the leading zero, and the
    // leading zero is the difference between two members.
    return {
      type: { kind: "string", charset: "digits" },
      parse: "string@1",
      normalize: DELIVERED,
    };
  }
  return { type: { kind: "string" }, parse: "string@1", normalize: DELIVERED };
}
