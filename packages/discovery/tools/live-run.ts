// The configuration of THE live discovery run, in one place, imported by both the thing that
// prices it (`preflight.ts`) and the thing that performs it (`discover.ts`).
//
// WHY THIS FILE EXISTS AT ALL. `pnpm preflight` tells the author what a run would cost before they
// authorise it. That report is worth exactly as much as the guarantee that the run it priced is the
// run that happens. Two files each holding "the goal", "the allowlist" and "the model id" is that
// guarantee held by a convention, and a convention is what fails on the afternoon somebody edits
// one of them. So both scripts import this module, and the preflight's numbers are numbers about
// the runner by construction.
//
// WHAT IS HERE AND WHAT IS NOT. Everything about the run that is a DECISION - the goal, the member
// number, the prose a person owns, the published prices, the arithmetic that turns tokens into
// dollars. Nothing about the MECHANISM: the loop, the adapters, the recorder and synthesis are all
// in `src/`, tested, and this module only arranges them.
//
// IT IMPORTS FROM `test/fixtures/`, AND THAT IS THE PRECEDENT RATHER THAN A SHORTCUT. The corpus
// module already owns the allowlist, the control lease, the entry route, the node references and
// the hand-authored script that the committed capability was synthesized from. A live run that
// invented a second allowlist would be a live run whose evidence could not be compared with the
// committed documents - which is most of what makes the live run worth the money. `preflight.ts`
// imports the same module for the same reason, and says so at its own import site.
//
// NOTHING IN THIS FILE OPENS A SOCKET, READS A CREDENTIAL OR CALLS A MODEL.

import type { ScriptedTurn } from "../src/scripted-model.js";
import {
  ALLOWLIST,
  CONTROL,
  ENTRY_ROUTE,
  RECORDED_MEMBER_ID,
  REFS,
  SCRIPT,
} from "../test/fixtures/corebank-web.js";

export { ALLOWLIST, CONTROL, ENTRY_ROUTE, RECORDED_MEMBER_ID };

// ---------------------------------------------------------------------------------------------
// The member the live run is performed on
// ---------------------------------------------------------------------------------------------

/**
 * A DIFFERENT member from the one every other exhibit in `evidence/` uses, and the reason is the
 * reason `pnpm demo` picks `1337.42` for its masked-capture deposit rather than a round number.
 *
 * The demo's redaction canary greps the WHOLE of `evidence/` for the values its own runs were
 * given - `10041` and `99999`. A live discovery recording necessarily contains the member number it
 * was asked about: it is in the goal, the model types it, and the application prints it back in the
 * results grid and in its own query string. Recording the live run on 10041 would therefore mean
 * one of two bad things - `pnpm demo` failing over a value that is not a leak, or somebody
 * loosening the demo's canary to stop it noticing. Recording it on a different member means a
 * canary hit anywhere in `evidence/` is unambiguous about which run produced it, which is exactly
 * what the demo says about its own deposit amount.
 *
 * 10043 also earns its place on the merits: `CHEN, MIN (SYNTHETIC)` is `ACTIVE`, holds TWO
 * sub-accounts where 10041 holds one, and appears in no frozen corpus - so the live artifact is a
 * genuinely new derivation rather than a re-derivation of the committed one, and its member data
 * (`CHEN, MIN (SYNTHETIC)`, `15,900.00`) makes a distinctive canary needle.
 */
export const LIVE_MEMBER_ID = "10043";

/**
 * The task, verbatim, as the first user message will carry it.
 *
 * THE MEMBER NUMBER IS A LITERAL IN THE GOAL, AND THAT IS A DELIBERATE CHOICE OVER THE ALTERNATIVE.
 *
 * The obvious-looking alternative is to bind it as a SENSITIVE parameter - hand the loop a
 * `TaintedValue`, show the model `{{memberNumber}}`, and let the taint model keep the value out of
 * everything written down. It was built that way first, and running it produced two measured
 * results that say it is the wrong choice for this flow:
 *
 *   1. IT MAKES THE ARTIFACT WORSE, WHICH IS THE DELIVERABLE. `inferParameters` records a sensitive
 *      binding with no value (there is nothing it is allowed to hold), so the substitution table
 *      has no text for it - and `table-cell` addressing, which finds the results row whose Member ID
 *      cell holds the BOUND VALUE, becomes underivable. The synthesis report said so in as many
 *      words: `descriptor-rejected  table-cell: the node is not in a table row addressable by a
 *      bound value`, on all three cells and on the row's Open link, where the literal run rejects it
 *      on none of them. The descriptors that remain then fold the cell's own accessible name into
 *      what they record, and `flow.vocabulary` came out holding `ALVAREZ, DANA (SYNTHETIC)` and
 *      `1,204.55` - recorded member data in the one document that is committed, diffed and SIGNED,
 *      which is precisely what BRIEF section 3.6 forbids and what FINAL-STATUS section 7.2 records
 *      as a defect somebody already had to fix once.
 *   2. IT DOES NOT EVEN KEEP THE VALUE OUT OF THE RECORDING. The application PRINTS the member
 *      number: in the results grid's Member ID cell, in the row's accessible name, and in its own
 *      `?...txtMemberId=10041` query string. All three reach the projection the model is shown and
 *      therefore the transcript. A second measured finding fell out of the same run and is worth
 *      recording on its own: the loop masks a bound value in the field it was TYPED into, by node
 *      id - and a server-rendered round trip re-renders that field on a NEW screen with NEW node
 *      ids, where the mask no longer applies. On a legacy surface, masking by node identity does
 *      not survive a form post.
 *
 * The literal binding, by contrast, is the mechanism SPEC section 6.3 was designed around and it
 * does the job: the value is matched against the goal text, becomes a typed parameter, and
 * `parameterizeText` then substitutes it out of the model's own `why` prose as well - which is why
 * the committed capability contains the string `10041` exactly zero times.
 *
 * WHAT THAT COSTS, STATED PLAINLY. The value is in clear in `transcript.json`, `discovery.log` and
 * `journal.jsonl`, because the model was told it, typed it and was shown it. The runner's canary
 * reports every one of those occurrences with its line number rather than pretending they are not
 * there, and gates on the places the value genuinely must not be: the synthesized documents, and
 * everything the verification replay wrote - where the same number IS a bound value and the taint
 * model does hold.
 */
export const LIVE_GOAL = [
  `Look up member ${LIVE_MEMBER_ID} in the riverbend core banking back office,`,
  "report their name, share balance and membership status, and open their member record.",
].join(" ");

/** The tenant this run is recorded against. */
export const LIVE_TENANT = {
  tenantId: "riverbend",
  appInstanceId: "riverbend-corebank-live",
} as const;

// ---------------------------------------------------------------------------------------------
// The prose a person owns
// ---------------------------------------------------------------------------------------------

/**
 * SPEC section 2.3: synthesis derives the program and refuses to write the routing prose, because a
 * generated `whenToUse` is a generated routing decision. These lines are the same ones the committed
 * capability carries, for the same reason the goal is: so the two documents are comparable.
 */
export const LIVE_CAPABILITY = {
  name: "corebank.member.read_share_position",
  title: "Read a member's share position",
  summary:
    "Looks a member up by member number and reports their name, share balance and membership " +
    "status, leaving the servicing session on that member's record.",
  whenToUse: [
    "The member is asking what their share or savings balance is.",
    "A teller needs the member's current position before servicing the account.",
  ],
  whenNotToUse: [
    "You do not have a member number. Identify the member first; this capability will not search by name.",
    "The member is asking about a loan, certificate or card balance - this reads share accounts only.",
  ],
} as const;

export const LIVE_VENDOR = {
  product: "CoreBank Servicing",
  productVersionRange: ">=8.0 <9.0",
  sessionProfile: "corebank-teller",
} as const;

// ---------------------------------------------------------------------------------------------
// The rehearsal script
// ---------------------------------------------------------------------------------------------

/**
 * `SCRIPT`, retargeted from the corpus member to the live one.
 *
 * Both the `fill` value and the `why` prose are rewritten, because both mention the number and a
 * rehearsal that typed one member's id while explaining another would be a rehearsal of a
 * conversation nobody could have. Derived from `SCRIPT` rather than copied so that a change to the
 * corpus script cannot leave the rehearsal describing a different run - the corpus script is the
 * one that is validated against the live application by `fixtures:capture`.
 *
 * The node indices are NOT rewritten and do not need to be: a search by member number returns
 * exactly one row on this fixture, so the results screen has the same shape whichever member it is
 * about. That assumption is checked the only way it can be - by running it, which is what
 * `--dry-run` is.
 */
export function rehearsalScript(): readonly ScriptedTurn[] {
  const retarget = (text: string): string => text.split(RECORDED_MEMBER_ID).join(LIVE_MEMBER_ID);
  const fillRef = `n${REFS.memberIdField.index}`;
  return SCRIPT.map((turn) => ({
    ...turn,
    toolUses: (turn.toolUses ?? []).map((use) => {
      const input = use.input as {
        readonly nodeRef?: string;
        readonly value?: string | null;
        readonly why?: string;
      };
      const why = input.why === undefined ? {} : { why: retarget(input.why) };
      const value =
        use.name === "act" && input.nodeRef === fillRef && input.value === RECORDED_MEMBER_ID
          ? { value: LIVE_MEMBER_ID }
          : {};
      return { ...use, input: { ...input, ...why, ...value } };
    }),
  }));
}

// ---------------------------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------------------------

/**
 * Published rates, per million tokens, and the ONE copy of them in this repository.
 *
 * Verified against the `claude-api` skill rather than written from memory, which BRIEF section 9
 * requires of every API fact here. `cacheWrite` / `cacheRead` are MULTIPLIERS on the input rate: a
 * five-minute ephemeral breakpoint - which is what `tools.ts` sets - is billed at 1.25x to write
 * and 0.1x to read. `minCachePrefix` is the model-dependent floor below which a breakpoint SILENTLY
 * does nothing: no error, just `cache_creation_input_tokens: 0` for ever.
 */
export const MODEL_RATES = [
  { id: "claude-opus-5", input: 5, output: 25, minCachePrefix: 512 },
  { id: "claude-sonnet-5", input: 2, output: 10, minCachePrefix: 1024 },
] as const;

export type ModelRate = (typeof MODEL_RATES)[number];

export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

/** The project's spend cap, from BRIEF section 11. It is the author's own money. */
export const SPEND_CAP_USD = 10;

/** The rate row for a model id, or `null` for a model this table has never been told the price of.
 *  `null` is a first-class answer: a runner that guessed a price for an unknown model would be
 *  guessing with somebody else's money, and the caller refuses the run instead. */
export function rateFor(modelId: string): ModelRate | null {
  return MODEL_RATES.find((rate) => rate.id === modelId) ?? null;
}

export interface BilledUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
}

/**
 * What a measured `usage` cost, in dollars.
 *
 * Every term is a token count the PROVIDER returned, at the published rate for the model that
 * returned it. Nothing here is projected and nothing is assumed; the projection lives in the runner
 * and is clearly labelled there.
 */
export function costOf(usage: BilledUsage, rate: ModelRate): number {
  const input =
    usage.inputTokens +
    usage.cacheCreationInputTokens * CACHE_WRITE_MULTIPLIER +
    usage.cacheReadInputTokens * CACHE_READ_MULTIPLIER;
  return (input * rate.input + usage.outputTokens * rate.output) / 1_000_000;
}

/** Every token the provider billed for in any form. The denominator of the cache hit rate, and the
 *  quantity the run's absolute token ceiling is measured against. */
export function billedTokens(usage: BilledUsage): number {
  return (
    usage.inputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens +
    usage.outputTokens
  );
}

// ---------------------------------------------------------------------------------------------
// The ceilings the runner ships with, here so that the preflight prices the run that will happen
// ---------------------------------------------------------------------------------------------

/**
 * `max_tokens`, lowered from the adapter's own 16,000.
 *
 * THE ARITHMETIC, from the sizes `pnpm preflight` measures. Preflight's worst case is every turn
 * emitting `max_tokens`, and at 16,000 that is $31.90 on claude-opus-5 for a 24-turn run - against
 * a $10 project cap. The number is dominated by `max_tokens` twice over: once directly in the
 * output bill, and once again in the input bill, because every turn's output is re-sent as history
 * on every subsequent turn, which is why that column grows quadratically.
 *
 * What this loop's assistant turns actually contain is at most one `tool_use` block, and the
 * largest of the five tool schemas (`act`: nodeRef, action, value, key, why) is a few hundred
 * characters of input - preflight measures ALL FIVE TOOL DEFINITIONS at 4,447 characters, about
 * 1,348 tokens, so one CALL is a small fraction of that - plus adaptive thinking, which bills as
 * output and is the part that is genuinely unbounded. Preflight's assumed output per turn, the
 * only symbol in its model that is not measured, is 800 tokens including thinking.
 *
 * 2,000 is 2.5x that assumption: a normal turn is never truncated, a turn that thinks unusually
 * hard has room, and the absolute worst 24-turn run drops from $31.90 to $4.18 - under the project
 * cap before any other guard has fired. (That figure is `pnpm preflight`'s, computed by the same
 * arithmetic it prints, not one written here by hand.) It is a ceiling, not a target; the money guard is
 * what actually stops a run. `--max-output-tokens` raises it for anyone who disagrees.
 *
 * Truncation is not silent: the runner reads `stop_reason` off every recorded turn and reports any
 * turn that hit the ceiling, because a `tool_use` block cut off mid-JSON is refused by the loop's
 * input schema, which the model then reads as its own mistake rather than as a low ceiling.
 */
export const DISCOVER_MAX_OUTPUT_TOKENS = 2000;

/**
 * The money cap for ONE run, in dollars.
 *
 * Chosen against the same table: preflight's TYPICAL full-budget 24-turn run on claude-opus-5 is
 * $1.80, so $2.00 lets a run that genuinely needs every turn finish and stops one that has started
 * paying for its own confusion. Because the guard PROJECTS the next turn's worst case before taking
 * it, this is a ceiling rather than a target a run can overshoot: 20% of the $10 project cap, so
 * the author can afford to be wrong about it four times over.
 */
export const DISCOVER_MAX_USD = 2.0;
