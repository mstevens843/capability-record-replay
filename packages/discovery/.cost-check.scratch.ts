// SCRATCH - delete me. Written by the rehearsal pass to exercise the shipped costOf()/billedTokens()
// at non-zero provider numbers, which `pnpm discover --dry-run` cannot reach because
// createScriptedModel reports ZERO_USAGE. Opens no socket. `rm packages/discovery/.cost-check.scratch.ts`
import { billedTokens, costOf, rateFor } from "./tools/live-run.js";

const opus = rateFor("claude-opus-5");
if (opus === null) throw new Error("no rate for claude-opus-5");

const cached = {
  inputTokens: 225,
  outputTokens: 800,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 2034,
};
const cachedByHand = ((225 + 0 * 1.25 + 2034 * 0.1) * 5) / 1e6 + (800 * 25) / 1e6;
const first = {
  inputTokens: 101,
  outputTokens: 800,
  cacheCreationInputTokens: 2034,
  cacheReadInputTokens: 0,
};
const firstByHand = ((101 + 2034 * 1.25) * 5) / 1e6 + (800 * 25) / 1e6;
const agg = {
  inputTokens: 264669,
  outputTokens: 24 * 800,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

console.log(
  `cached turn      costOf=${costOf(cached, opus).toFixed(8)}  byHand=${cachedByHand.toFixed(8)}  ${costOf(cached, opus) === cachedByHand ? "AGREE" : "DISAGREE"}`,
);
console.log(`                 billedTokens=${billedTokens(cached)}  expected 3059`);
console.log(
  `first turn       costOf=${costOf(first, opus).toFixed(8)}  byHand=${firstByHand.toFixed(8)}  ${costOf(first, opus) === firstByHand ? "AGREE" : "DISAGREE"}`,
);
console.log(
  `24-turn typical  costOf=$${costOf(agg, opus).toFixed(2)}  preflight prints $1.80  billed=${billedTokens(agg)}`,
);
