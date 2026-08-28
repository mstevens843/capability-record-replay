// The registry itself: what is registered, and the mechanism that freezes it.
//
// The problem this file solves is stated in SPEC section 2.1: engine code must not be able to
// silently change what an approved artifact *means* while the artifact's digest keeps matching.
// An artifact says `normalize: "std.label@1"`. If someone improves `stdLabel` next quarter, the
// artifact's bytes are unchanged, its digest is unchanged, the approval signature still verifies -
// and it now matches different text than the person who approved it read.
//
// The mechanism is a behaviour digest. Each registered function is applied to a fixed corpus of
// probe inputs, and the digest is taken over the (probe, result) pairs. Change the function's
// behaviour on any probe and the digest moves; `test/registry-stability.test.ts` holds the frozen
// values and fails. The way past that test is to register the new behaviour under a new major and
// leave the old one in place, which is exactly the conversation that should happen.
//
// The corpus lives here rather than in the test because the digest is a property of the registry -
// a runtime can journal it alongside a run, and anyone can recompute it - not a property of our
// test suite.

import { digestOf } from "./digest.js";
import { type ExtractorSource, extract } from "./extractors.js";
import { normalize } from "./normalizers.js";
import { parse } from "./parsers.js";
import {
  type Digest,
  type ExtractorId,
  type NormalizerId,
  type ParserId,
  type RegistryId,
  registryMajor,
} from "./primitives.js";

export type RegistryKind = "normalizer" | "extractor" | "parser";

export interface RegistryEntry {
  readonly id: RegistryId;
  readonly kind: RegistryKind;
  /** Declared, not derived, so that a mismatch with the id's own suffix is a test failure rather
   *  than an assumption. */
  readonly major: number;
  /** One line, aimed at the person approving an artifact that names this id. The prose renderers
   *  in SPEC section 4.7 read from here, so it is written to be dropped into a sentence. */
  readonly summary: string;
}

export const REGISTRY: readonly RegistryEntry[] = [
  {
    id: "std.text@1",
    kind: "normalizer",
    major: 1,
    summary: "ignoring case, surrounding space, repeated spaces and invisible characters",
  },
  {
    id: "std.label@1",
    kind: "normalizer",
    major: 1,
    summary: "ignoring case, spacing, a trailing colon or period, and this tenant's branding words",
  },
  {
    id: "std.money@1",
    kind: "normalizer",
    major: 1,
    summary: "ignoring the dollar sign, thousands separators and how the negative is written",
  },
  {
    id: "std.identity@1",
    kind: "normalizer",
    major: 1,
    summary: "exactly, character for character",
  },
  { id: "text@1", kind: "extractor", major: 1, summary: "the text shown by the element" },
  { id: "value@1", kind: "extractor", major: 1, summary: "the value held by the field" },
  { id: "name@1", kind: "extractor", major: 1, summary: "the label of the element" },
  { id: "cell@1", kind: "extractor", major: 1, summary: "the contents of the table cell" },
  { id: "string@1", kind: "parser", major: 1, summary: "as text" },
  { id: "integer@1", kind: "parser", major: 1, summary: "as a whole number" },
  { id: "moneyUSD@1", kind: "parser", major: 1, summary: "as a US dollar amount" },
  { id: "dateUS@1", kind: "parser", major: 1, summary: "as a month/day/year date" },
  { id: "dateISO@1", kind: "parser", major: 1, summary: "as a year-month-day date" },
  { id: "enum@1", kind: "parser", major: 1, summary: "as one of the declared values" },
];

const BY_ID: ReadonlyMap<string, RegistryEntry> = new Map(REGISTRY.map((e) => [e.id, e]));

export function lookupRegistryEntry(id: string): RegistryEntry | undefined {
  return BY_ID.get(id);
}

/**
 * Linker check 18's predicate: does this id exist, at this major?
 *
 * An unknown id is a link error and not a runtime surprise. The alternative - discovering at
 * replay that `std.label@2` was never implemented - would surface as a normalizer that silently
 * did nothing, which is the quiet wrongness this whole design is arranged against.
 */
export function isRegisteredId(id: string): id is RegistryId {
  return BY_ID.has(id);
}

export function registryEntriesOfKind(kind: RegistryKind): readonly RegistryEntry[] {
  return REGISTRY.filter((e) => e.kind === kind);
}

// ---------------------------------------------------------------------------------------------
// The probe corpus
//
// Chosen to be *discriminating*, not exhaustive: every probe is here because some plausible edit
// to a registered function would change its result. The awkward ones - the non-breaking space, the
// decomposed umlaut, the trailing minus, the accounting parentheses - are the cases that came out
// of the two surface spikes, where a legacy server-rendered page and a character grid describe the
// same screen differently.
// ---------------------------------------------------------------------------------------------

export interface NormalizerProbe {
  readonly input: string;
  readonly brandingTokens?: readonly string[];
}

export const NORMALIZER_PROBES: readonly NormalizerProbe[] = [
  { input: "" },
  { input: "   " },
  { input: "Member ID:" },
  { input: "  Member   ID  " },
  { input: "Member\u00A0ID" },
  { input: "Account\u200BNumber_" },
  { input: "\uFEFFSearch" },
  { input: "SEARCH" },
  { input: "Ma\u0308nner" },
  { input: "M\u00E4nner" },
  { input: "Balance ._:" },
  { input: "Riverbend Search", brandingTokens: ["Riverbend"] },
  { input: "Search Riverbend Member", brandingTokens: ["riverbend"] },
  { input: "River Bend Bank Balance", brandingTokens: ["River Bend Bank"] },
  { input: "Summit Summary", brandingTokens: ["Summit"] },
  { input: "Riverbend Riverbend Search", brandingTokens: ["Riverbend"] },
  { input: "Balance - Riverbend", brandingTokens: ["Riverbend"] },
  { input: "$1,234.56" },
  { input: "( 1,234.56 )" },
  { input: "1234.56-" },
  { input: "USD 10.00" },
  { input: "10.00 usd" },
  { input: "EUR 10,00" },
  { input: "+0.5" },
  { input: "-$0.00" },
  { input: "n/a" },
];

export const EXTRACTOR_PROBES: readonly ExtractorSource[] = [
  { name: "Share Balance", value: null, text: null },
  { name: "Share Balance", value: null, text: "$1,234.56" },
  { name: "Share Balance", value: "1234.56", text: "$1,234.56" },
  { name: "Member ID", value: "", text: "  " },
  { name: "Member ID", value: " ", text: "12345" },
  { name: "", value: null, text: "\u200B" },
  { name: "Status", value: null, text: " Active " },
];

export interface ParserProbe {
  readonly input: string;
  readonly enumValues?: readonly string[];
}

export const PARSER_PROBES: readonly ParserProbe[] = [
  { input: "" },
  { input: "   " },
  { input: "0" },
  { input: "-0" },
  { input: "007" },
  { input: "1234" },
  { input: "-1234" },
  { input: "1,234" },
  { input: "1e3" },
  { input: "9007199254740993" },
  { input: "12.50" },
  { input: "$1,234.56" },
  { input: "(1,234.56)" },
  { input: "1234.56-" },
  { input: "EUR 10,00" },
  { input: ".5" },
  { input: "01/31/2026" },
  { input: "1/3/2026" },
  { input: "02/30/2024" },
  { input: "02/29/2024" },
  { input: "02/29/2023" },
  { input: "01/31/26" },
  { input: "2026-01-31" },
  { input: "2026-1-31" },
  { input: "1900-02-29" },
  { input: "2000-02-29" },
  { input: "Active", enumValues: ["Active", "Closed"] },
  { input: "active", enumValues: ["Active", "Closed"] },
  { input: "ACTIVE", enumValues: ["Active", "ACTIVE"] },
  { input: "active", enumValues: ["Active", "ACTIVE"] },
  { input: "Frozen", enumValues: ["Active", "Closed"] },
  { input: "Active" },
];

// ---------------------------------------------------------------------------------------------
// Behaviour digests
// ---------------------------------------------------------------------------------------------

function observationsFor(entry: RegistryEntry): unknown {
  switch (entry.kind) {
    case "normalizer":
      return NORMALIZER_PROBES.map((probe) => [
        probe,
        normalize(entry.id as NormalizerId, probe.input, { brandingTokens: probe.brandingTokens }),
      ]);
    case "extractor":
      return EXTRACTOR_PROBES.map((probe) => [probe, extract(entry.id as ExtractorId, probe)]);
    case "parser":
      return PARSER_PROBES.map((probe) => [
        probe,
        parse(entry.id as ParserId, probe.input, { enumValues: probe.enumValues }),
      ]);
  }
}

/**
 * The digest of one registered function's behaviour over the probe corpus.
 *
 * The id and the corpus are inside the hashed value, so adding a probe moves every digest of that
 * kind. That is intended: a new probe is a new claim about what the function does, and it should
 * be reviewed with the same weight as a change to the function.
 */
export function behaviourDigest(id: RegistryId): Digest {
  const entry = BY_ID.get(id);
  if (entry === undefined) {
    // Unreachable through the type, but this function is also called with values that crossed a
    // parse boundary, and returning a digest for an unregistered id would be worse than throwing.
    throw new Error(`no registered function with id ${id}`);
  }
  return digestOf({
    id: entry.id,
    kind: entry.kind,
    major: entry.major,
    observations: observationsFor(entry),
  });
}

/** One digest over the whole registry: what an artifact was approved against, in one value. */
export function registryBehaviourDigest(): Digest {
  return digestOf(REGISTRY.map((e) => [e.id, behaviourDigest(e.id)]));
}

/** True when an entry's declared major agrees with the suffix of its own id. */
export function entryMajorIsConsistent(entry: RegistryEntry): boolean {
  return registryMajor(entry.id) === entry.major;
}
