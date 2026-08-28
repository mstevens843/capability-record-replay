// The PER-INSTRUCTION postconditions of SPEC section 3's table.
//
// The admission criterion for the instruction set was that each opcode has "a distinct postcondition
// the interpreter can verify" - that is the stated reason `fill`, `select` and `setToggle` are three
// opcodes and not one `setValue`. So the interpreter has to actually verify them, and this is where
// that happens. Without it the argument for the instruction set is a claim about a table in a
// document rather than a property of the engine.
//
// They are NOT the checkpoint. `expect` is what the ARTIFACT declares about the screen; this is what
// the ENGINE knows about the opcode it just executed, and it is the same for every artifact. The two
// are checked in that order - the classifier first, so an outcome, an environment condition or a
// declared recovery still wins - and only a verdict that was otherwise going to `advance` is
// re-examined here. Fail-closed: a postcondition that cannot be evaluated is a failure, not a pass.
//
// THE VALUE READ-BACK IS THE ONE THAT EARNS ITS KEEP. A legacy input with a `maxlength` or an input
// mask silently truncates or reformats what you typed and then produces "no member found" for a
// member who exists. That is a wrong answer with no error message anywhere, and comparing the
// field's value against what was written is the only thing that catches it.
//
// Re-resolution rather than a saved node id: `NodeId` is valid within ONE observation by contract
// (SPEC section 2.2), so carrying one across the act boundary would be reading an identity the port
// does not promise. Re-resolving through the same descriptors against the post-act observation is
// both correct and, usefully, a second independent check that the control we typed into is still
// the control the descriptors name.

import {
  type EvalContext,
  type ResolvedBindings,
  type ResolvedStep,
  type SurfaceCapabilities,
  type TargetRef,
  type UINode,
  bindingFor,
  matchText,
  normalize,
  resolveTarget,
  routeMatches,
} from "@crr/core";

export type PostconditionResult =
  | { readonly ok: true; readonly warning?: string }
  | { readonly ok: false; readonly note: string };

const OK: PostconditionResult = { ok: true };

/**
 * THE ONE PLACE THE TAINT MODEL AND SPEC SECTION 3 GENUINELY CONFLICT, resolved in favour of the
 * taint model and reported rather than hidden.
 *
 * SPEC section 3 gives `fill` the postcondition "the target's `value` equals the written value after
 * `normalize`", and argues for it with the case it catches: a legacy input with a `maxlength`
 * silently truncates a member number and the flow then reports MEMBER_NOT_FOUND for a member who
 * exists. But when the value is bound to a SENSITIVE parameter, the driver blanks that field's
 * `value` and `text` before the observation crosses the port (`masked: true`) - by design, because
 * there is no masked spelling of a member number that is safe to write to an evidence directory.
 *
 * So on a sensitive fill the read-back is not evaluable, and there are three ways to be wrong about
 * it: fail the step (every sensitive fill fails), pass silently (the truncation defence quietly does
 * not exist), or unmask for the comparison (the regulated value crosses the port for the benefit of
 * an assertion). This takes the fourth: PASS, and attach a warning that says the check could not be
 * performed, which lands on `RunEnvelope.warnings` on every arm including `ok`.
 *
 * The real fix is one field on the port. `UINode.capacity` already exists for a character grid's
 * field width; a driver that reported the masked field's LENGTH would restore the truncation check
 * without ever carrying the value. That is a `@crr/surface-browser` change and it is reported, not
 * made here.
 */
const MASKED_NOTE =
  "the field is masked because its value is bound to a sensitive parameter, so the written value could not be read back; a truncating maxlength or input mask on this field would not be detected";
const no = (note: string): PostconditionResult => ({ ok: false, note });

export interface PostconditionInput {
  readonly step: ResolvedStep;
  readonly ctx: EvalContext;
  readonly bindings: ResolvedBindings;
  readonly capabilities: SurfaceCapabilities;
  readonly disabledDescriptors: readonly string[];
  /**
   * The engine's target resolver (`DecisionFunctions.resolveTarget`), defaulting to `@crr/core`'s.
   *
   * Threaded through rather than imported directly so that a weakened engine is weakened HERE too.
   * The re-resolution below is a second, independent application of the same decision, and an
   * injection seam that covered `classify` and the pre-act resolve but not this one would leave a
   * mutant partially defended by a code path nobody meant to exempt - which makes the conformance
   * verdict a statement about coverage of the seam rather than about the engine.
   */
  readonly resolve?: typeof resolveTarget;
}

export function verifyInstructionPostcondition(input: PostconditionInput): PostconditionResult {
  const { step, ctx } = input;
  const instruction = step.instruction;

  switch (instruction.kind) {
    case "navigate":
      return routeMatches(instruction.route, ctx)
        ? OK
        : no(`the surface is not on route ${instruction.route} after navigating to it`);

    case "fill": {
      const node = reresolve(input);
      if (node === null) return no("the field that was filled no longer resolves under quorum");
      if (node.masked) return { ok: true, warning: MASKED_NOTE };
      const binding = bindingFor(instruction.value, input.bindings);
      if (binding === null) return no("the filled value is unbound");
      // Normalized on both sides, because a legacy field reformats as often as it truncates: a
      // date box that turns `2026-02-11` into `02/11/2026` has not lost anything, and an equality
      // check on the raw strings would call that a failure.
      const wrote = normalize("std.text@1", binding.value, {
        brandingTokens: ctx.program.brandingTokens,
      });
      const holds = normalize("std.text@1", node.value ?? "", {
        brandingTokens: ctx.program.brandingTokens,
      });
      if (holds === wrote) return OK;
      // The note names LENGTHS, never the values. This string is journaled and read in an
      // intervention brief, and the whole point of the check is that the field holds member data.
      return no(
        `the field holds ${holds.length} characters and ${wrote.length} were written; a maxlength or an input mask changed what was typed`,
      );
    }

    case "select": {
      const node = reresolve(input);
      if (node === null) return no("the control that was set no longer resolves under quorum");
      return matchText(instruction.option, node.value ?? "", "identity", ctx)
        ? OK
        : no("the control's selected option is not the one this step chose");
    }

    case "setToggle": {
      const node = reresolve(input);
      if (node === null) return no("the toggle that was set no longer resolves under quorum");
      // `setToggle` SETS a state; it does not toggle. A read-back is what makes that checkable,
      // and it is why the opcode is idempotent by construction.
      return node.state.checked === instruction.checked
        ? OK
        : no(
            `the toggle reads ${String(node.state.checked)} and ${String(instruction.checked)} was set`,
          );
    }

    case "dialog":
      return ctx.observation.nativeDialog === null
        ? OK
        : no("the dialog this step answered is still open");

    // `activate` and `pressKey` have no opcode-level postcondition beyond `expect` and `delta`,
    // which the classifier already checked - the artifact is the only thing that knows what a
    // click was supposed to achieve. `read`, `readTable` and `assert` dispatch nothing and their
    // postcondition IS the extraction the classifier performed.
    default:
      return OK;
  }
}

/** The step's own target, resolved again against the POST-act observation. `null` when it no longer
 *  resolves under quorum - which is itself a postcondition failure and not a reason to skip one. */
function reresolve(input: PostconditionInput): UINode | null {
  if (input.step.target === null) return null;
  const resolution = (input.resolve ?? resolveTarget)({
    target: input.step.target as TargetRef,
    ctx: input.ctx,
    capabilities: input.capabilities,
    disabledDescriptors: input.disabledDescriptors,
  });
  return resolution.status === "resolved" ? (resolution.resolvedNode as UINode) : null;
}
