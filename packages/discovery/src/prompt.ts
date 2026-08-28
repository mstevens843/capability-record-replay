// The stable prefix, and the one thing that is not stable.
//
// BRIEF section 9: the cacheable prefix must come FIRST and must not change between turns, because
// the observation payload changes every turn and a prefix that moves is a prefix that never hits.
// So the split here is strict and it is the whole reason this file exists as its own module:
//
//   · `DISCOVERY_SYSTEM_PROMPT` contains no goal, no tenant, no route and no observation. It is
//     byte-identical across every turn of every run of every tenant, which means the cache prefix
//     is shared across RUNS and not merely across turns - the difference between a hit rate that
//     is interesting and one that is a rounding error on a system driving thousands of app
//     instances.
//   · the goal, the tenant and the entry route go in the first USER message, after the breakpoint.
//
// The prompt is also where the loop's contract with the model is stated in words, and every clause
// in it is load-bearing somewhere else in this repo:
//   · "one action per call" is `disable_parallel_tool_use` said twice, because a model that batches
//     actions produces a step order the recording cannot honour (SPEC section 6.1);
//   · "being stuck is a good answer" is SPEC section 0.2's fail-closed rule pointed at the model:
//     a confident wrong finish is far more expensive than an honest `stuck`;
//   · "an outcome is a fact about the record" is OPEN-QUESTIONS-RESOLVED Q1's rule, given to the
//     model in the same words the contract author will read it in.

/**
 * The system prompt. Stable, cacheable, and pinned by a digest test.
 *
 * Deliberately short. Every token here is paid on the first turn of every run and then read from
 * the cache; the reason to keep it tight is not that cost, it is that a long prompt is a prompt
 * nobody re-reads when the behaviour changes.
 */
export const DISCOVERY_SYSTEM_PROMPT = [
  "You are discovering how to accomplish one task in a back-office banking application, so that",
  "the steps can be recorded and replayed later with no model involved. A person will review the",
  "recording. Work the way a careful operator would: look, act once, look again.",
  "",
  "HOW YOU SEE THE SCREEN",
  "You are shown a filtered list of the controls and readable values that are visible right now.",
  "Each line starts with a reference like [n7]. Those references are valid only for the screen you",
  "were just shown; after any action the screen is re-read and the references are renumbered.",
  "Always act on a reference from the most recent listing.",
  "",
  "You cannot see the page source, and you never write a selector of any kind. You choose a node",
  "reference from what you were shown; the recording system derives the durable way to find that",
  "control afterwards. This is deliberate - do not ask for markup, ids or attributes.",
  "",
  "HOW YOU ACT",
  "One action per call, then look at the result before choosing the next. If a tool result says",
  "the screen has not settled, call observe again rather than acting into a moving screen.",
  "Actions are checked against a safety allowlist before they happen; a refusal tells you the",
  "reason and is not something to work around. If you are refused twice for the same reason, stop",
  "and finish with status stuck.",
  "",
  "WHAT TO RECORD",
  "When the screen shows a value the caller of this capability would need back, call note_output on",
  "it. Prefer the specific node holding the value over a heading near it.",
  "",
  "HOW TO FINISH",
  "Call finish exactly once, at the end.",
  "Use status reached-goal only if the screen in front of you demonstrates the task is done.",
  "Use status stuck if it cannot be done from here. Being stuck is a good answer and an honest one;",
  "a wrong reached-goal is the most expensive thing you can produce, because it is recorded and",
  "then replayed unattended.",
  "",
  "If the application gave a definite business answer - no such member, account restricted, request",
  "not permitted for this record - list it in outcomeCandidates. An outcome is a fact about the",
  "request or the record that would still be true on a second attempt. A timeout, a slow page, an",
  "expired session or an application error is NOT an outcome; it is a fact about this attempt, and",
  "it does not belong in that list.",
].join("\n");

/**
 * The first user message: everything that is NOT stable, in one block after the cache breakpoint.
 *
 * The goal text is passed through verbatim. That matters for a reason that only shows up two units
 * later: SPEC section 6.3 parameterizes by matching the literals the model typed against the GOAL
 * TEXT, so a goal that was paraphrased here would break the binding that turns a recorded value
 * into a typed parameter - which is the same mechanism that keeps the value out of the artifact.
 */
export function renderTaskMessage(task: {
  readonly goal: string;
  readonly tenantId: string;
  readonly originAlias: string;
  readonly entryRoute: string;
  readonly allowedRoutes: readonly string[];
  /**
   * Placeholders for values the model may USE but must never SEE.
   *
   * This is the whole of the model's knowledge about a credential: a name it can type into `fill`.
   * The loop substitutes the bound value into the action and nowhere else, so the transcript, the
   * journal and the recorded step carry a taint handle - which is what makes SPEC section 6.4's
   * "redaction applies to transcripts too" a mechanism rather than a promise.
   */
  readonly secretPlaceholders?: readonly string[];
}): string {
  const lines = [
    `TASK: ${task.goal}`,
    "",
    `Application: ${task.originAlias} (tenant ${task.tenantId})`,
    `You start at: ${task.entryRoute}`,
    "Routes you are permitted to visit with go:",
    ...task.allowedRoutes.map((route) => `  ${route}`),
  ];

  const secrets = task.secretPlaceholders ?? [];
  if (secrets.length > 0) {
    lines.push(
      "",
      "Some values are withheld from you. To enter one, pass its placeholder as the value of fill",
      "exactly as written; the real value is substituted where you cannot see it, and the field is",
      "masked in everything you are shown afterwards. Available placeholders:",
      ...secrets.map((placeholder) => `  ${placeholder}`),
    );
  }

  lines.push("", "Call observe first.");
  return lines.join("\n");
}
