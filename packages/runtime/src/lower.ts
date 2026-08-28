// LOWER - step 6 of the SPEC section 3.1 cycle: one `Instruction` plus the node resolution chose,
// as one dispatchable `Action`.
//
// This is the seam the whole cross-surface claim rests on, and it is worth being explicit about
// what happens here rather than burying it in the interpreter. The ARTIFACT says what the operator
// meant (`activate`); the SURFACE says how that is done here. On a browser `activate` lowers to a
// click. On a character grid the synthesized button node carries the key from the F-key legend
// line, so the same instruction lowers to `pressKey(F5)` - measured in the terminal spike - and the
// artifact does not change. That one rename is why F-keys live at the PORT and not in the program:
// the Exit control is F3 at one tenant and F12 at the next while the node is identical, so a
// program that hardcoded F3 would be correct at one credit union and wrong at the one next door.
//
// Lowering can REFUSE, and a refusal is a value rather than an exception. Every reason here is a
// program-or-surface mismatch the linker is supposed to have caught at load time (checks 15, 21,
// 22), so reaching one of them at run time means an invariant broke - which is exactly what
// `internal-invariant` is for, and it should say so rather than throw.

import {
  type Action,
  type ActionKind,
  type EvalContext,
  type Key,
  KeySchema,
  type NodeId,
  type ResolvedBindings,
  type ResolvedStep,
  type RouteLocation,
  type SurfaceCapabilities,
  type UINode,
  bindingFor,
  matchText,
} from "@crr/core";

export type LoweringResult =
  | { readonly ok: true; readonly action: Action }
  | { readonly ok: false; readonly reason: string };

export interface LoweringInput {
  readonly step: ResolvedStep;
  /** The node target resolution selected, or `null` for the instructions that act on no node. */
  readonly node: UINode | null;
  readonly bindings: ResolvedBindings;
  readonly capabilities: SurfaceCapabilities;
  /** The observation the resolution ran against - the SAME one, because a `select` has to name an
   *  option that exists on the screen we are about to act on and not on the one before it. */
  readonly ctx: EvalContext;
  /** For `navigate` only: the concrete location, with every `:param` bound. */
  readonly location: RouteLocation | null;
}

const refuse = (reason: string): LoweringResult => ({ ok: false, reason });

function supports(capabilities: SurfaceCapabilities, kind: ActionKind): boolean {
  return capabilities.supportedActions.includes(kind);
}

export function lowerInstruction(input: LoweringInput): LoweringResult {
  const { step, node, capabilities } = input;
  const instruction = step.instruction;

  switch (instruction.kind) {
    case "navigate": {
      if (input.location === null) {
        return refuse(`step ${step.id} navigates and no concrete location was resolved`);
      }
      if (!supports(capabilities, "navigate")) {
        return refuse("this surface cannot navigate to a route directly");
      }
      return { ok: true, action: { kind: "navigate", route: input.location } };
    }

    case "activate": {
      if (node === null) return refuse(`step ${step.id} activates a control and resolved none`);
      // The one place a surface gets to disagree with the program about mechanism. A driver that
      // cannot click - a character grid - advertises `pressKey` instead, and the node it
      // synthesized from the F-key legend carries the key in its `value`.
      if (supports(capabilities, "click")) {
        return { ok: true, action: { kind: "click", target: node.id as NodeId } };
      }
      const key = activationKeyOf(node);
      if (key !== null && supports(capabilities, "pressKey")) {
        return { ok: true, action: { kind: "pressKey", target: node.id as NodeId, key } };
      }
      return refuse(
        `this surface offers neither click nor a key on the control named "${node.name}"`,
      );
    }

    case "fill": {
      if (node === null) return refuse(`step ${step.id} fills a field and resolved none`);
      const binding = bindingFor(instruction.value, input.bindings);
      if (binding === null) {
        return refuse(`step ${step.id} fills from a value reference nothing bound`);
      }
      if (!supports(capabilities, "type")) return refuse("this surface cannot type");
      // `sensitive` is derived from the BINDING's taint handle and never from the step. The driver
      // reads it to blank the field's region before any screenshot bytes exist, and the policy
      // chokepoint refuses a tainted value dispatched through any other action kind.
      return {
        ok: true,
        action: {
          kind: "type",
          target: node.id as NodeId,
          text: binding.value,
          mode: "replace",
          sensitive: binding.handle !== null,
        },
      };
    }

    case "select": {
      if (node === null) return refuse(`step ${step.id} selects and resolved no control`);
      if (!supports(capabilities, "select")) return refuse("this surface cannot select an option");
      const option = optionNameOf(node, instruction.option, input.ctx);
      if (option === null) {
        // Not "pick the closest": an option that is not on the screen is a program that does not
        // fit this tenant's product catalogue, and guessing which of two similar names was meant
        // is how a member gets the wrong account type opened.
        return refuse(`no option on this control matches what step ${step.id} asked for`);
      }
      return { ok: true, action: { kind: "select", target: node.id as NodeId, option } };
    }

    case "setToggle": {
      if (node === null) return refuse(`step ${step.id} sets a toggle and resolved none`);
      if (!supports(capabilities, "setChecked")) return refuse("this surface cannot set a toggle");
      // Sets a STATE; it does not toggle. `toggle` is order-dependent and therefore not replayable:
      // replaying it against a screen that remembered the last operator's choice produces the
      // opposite result.
      return {
        ok: true,
        action: { kind: "setChecked", target: node.id as NodeId, checked: instruction.checked },
      };
    }

    case "pressKey": {
      const parsed = KeySchema.safeParse(instruction.key);
      if (!parsed.success) return refuse(`${instruction.key} is not a key this port carries`);
      const key = parsed.data;
      if (!capabilities.supportedKeys.includes(key)) {
        return refuse(`this surface does not carry the ${key} key`);
      }
      if (!supports(capabilities, "pressKey")) return refuse("this surface cannot press a key");
      // A null target means the focused control, which is the point of the instruction: on a
      // character grid the cursor IS the selection and naming a node would be a second answer.
      return { ok: true, action: { kind: "pressKey", target: node?.id ?? null, key } };
    }

    case "dialog": {
      const wanted: ActionKind = instruction.accept ? "acceptDialog" : "dismissDialog";
      if (!supports(capabilities, wanted)) return refuse(`this surface cannot ${wanted}`);
      return {
        ok: true,
        action: instruction.accept
          ? { kind: "acceptDialog", text: instruction.text }
          : { kind: "dismissDialog" },
      };
    }

    case "read":
    case "readTable":
    case "assert":
      // Steps 5-8 of the cycle are skipped for these; reaching the lowerer at all is a bug in the
      // interpreter rather than in the artifact, and saying so is more useful than a no-op action.
      return refuse(`a ${instruction.kind} instruction dispatches nothing and must not be lowered`);
  }
}

/**
 * The key a synthesized control carries, for a surface that cannot click.
 *
 * On a character grid the driver builds a `button` node out of the F-key legend line - "F5=Post" -
 * and puts the key in the node's `value`. Nothing above the port knows that; this function is the
 * one place that convention is read, and it lives here rather than in the artifact so that a
 * tenant whose Exit is F12 needs no overlay at all.
 */
function activationKeyOf(node: UINode): Key | null {
  const parsed = KeySchema.safeParse(node.value ?? "");
  return parsed.success ? parsed.data : null;
}

/**
 * Which option on this control the matcher names, by its own accessible name.
 *
 * Matched against the option NODES under the control rather than against a list the artifact
 * carries, because the product catalogue is the tenant's and a hardcoded option string is the same
 * mistake as a hardcoded label.
 */
function optionNameOf(
  control: UINode,
  matcher: Parameters<typeof matchText>[0],
  ctx: EvalContext,
): string | null {
  const byId = new Map(ctx.observation.nodes.map((n) => [n.id, n]));
  const options: UINode[] = [];
  const walk = (id: NodeId, depth: number): void => {
    if (depth > 8) return;
    const node = byId.get(id);
    if (node === undefined) return;
    if (node.ariaRole === "option") options.push(node);
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const child of control.children) walk(child, 0);

  const hits = options.filter((option) => matchText(matcher, option.name, "identity", ctx));
  // Two options reading the same is an ambiguity, not a preference - the same rule the target
  // resolver applies to nodes.
  return hits.length === 1 ? ((hits[0] as UINode).name ?? null) : null;
}
