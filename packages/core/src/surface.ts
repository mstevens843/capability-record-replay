// SPEC section 2.2 - the seam itself.
//
// `observation.ts` owns every VALUE that crosses this boundary; this file owns the boundary. Four
// methods, and nothing above them has ever heard of a browser.
//
// Two of the four signatures are shaped by a measured fact rather than by taste, and both are worth
// stating here because a driver author will otherwise "simplify" them back:
//
//   · `perceive` takes a DEADLINE and nothing else. Not a selector, not a hint - perception is not
//     parameterized by what you hope to find. The deadline is non-negotiable because an open native
//     dialog blocks the renderer and `Accessibility.getFullAXTree` then never returns at all: no CDP
//     error, no timeout of its own. The browser spike deadlocked and was killed at two minutes. A
//     call with no timeout is a hang, not an error, and a hang has no failure class.
//   · `act` takes the LEASE TOKEN. The control model is therefore enforced twice - once by the
//     executor and once at the port - because the interesting failure is not a human and an
//     automation racing for a click. It is an automation that still believes it holds a session a
//     human took forty seconds ago, and a gate upstairs cannot see that at all.

import { digestOf } from "./digest.js";
import type {
  ActResult,
  Action,
  Capture,
  CaptureRequest,
  PerceiveResult,
  SurfaceCapabilities,
  UINode,
} from "./observation.js";
import type { LeaseToken } from "./primitives.js";

/**
 * The whole surface abstraction. A browser driver, a pty driver and an in-memory mock implement
 * this and nothing else; everything above is written against these four methods.
 */
export interface Surface {
  /**
   * Normalized snapshot, bounded by a deadline the driver honours with its OWN timer rather than
   * trusting the transport's. On expiry the driver reports `perceive-timeout` - a fault, never an
   * exception, because "the screen would not tell me what it looks like" is a condition the
   * classifier has a row for.
   */
  perceive(opts: { readonly deadlineMs: number }): Promise<PerceiveResult>;

  /**
   * Perform exactly one action. A driver reports what the machinery did and never what it meant:
   * every arm of `ActFault` is mechanical, and turning one into a failure class needs the
   * artifact's context, which lives on the other side of this port.
   */
  act(action: Action, lease: LeaseToken): Promise<ActResult>;

  /**
   * Evidence only. A capture is NEVER read by the decision path - no detector, no descriptor and no
   * checkpoint may consume pixels. Keeping it off `perceive` is what makes that enforceable rather
   * than aspirational, and it is what lets a character grid be a real driver: its "screenshot" is a
   * text dump and nothing upstream notices.
   */
  capture(req: CaptureRequest): Promise<Capture>;

  /** Advertised at LOAD time, so the linker can refuse a program this surface cannot run before a
   *  browser is launched or a pty is spawned. Synchronous: it is a description, not a probe. */
  capabilities(): SurfaceCapabilities;
}

// ---------------------------------------------------------------------------------------------
// A driver obligation that is shared code rather than shared prose
// ---------------------------------------------------------------------------------------------

/**
 * The structural skeleton of one node - what `Observation.skeletonDigest` is taken over.
 *
 * Geometry is absent by construction: a reflow of two pixels is not a change of state, and a
 * settle loop keyed on pixels never settles on a page with a fluid layout.
 */
interface NodeSkeleton {
  readonly rawRole: string;
  readonly ariaRole: string | null;
  readonly name: string;
  readonly containerPath: unknown;
  readonly state: unknown;
}

/**
 * `Observation.skeletonDigest`, computed the same way by every driver.
 *
 * SPEC section 2.2 says the DRIVER computes this so that the classifier never hashes anything, and
 * that stays true: this function is called from inside a driver. What it buys by living here is
 * that the browser driver, the terminal driver and the mock cannot drift into three different
 * definitions of "the screen changed" - which would make the settle loop mean something different
 * on each surface while looking identical in the artifact.
 *
 * Two exclusions, both load-bearing:
 *   · geometry, so a reflow is not a change;
 *   · nodes marked `live`, so a clock in a page header cannot make a surface permanently unsettled.
 *
 * Note the scope: this is a digest over NODES. A native dialog is a separate channel and does not
 * appear in the tree at all, so its arrival does not disturb the skeleton - the classifier reads
 * `nativeDialog` directly (band B2) rather than inferring it from a digest that cannot see it.
 *
 * Both role fields are included. `rawRole` is where a structural change surfaces first - a data
 * grid that degrades into a layout table keeps every accessible name it had - and noticing
 * structural change is the entire job of this value.
 */
export function skeletonDigestOf(nodes: readonly UINode[]): string {
  const skeleton: NodeSkeleton[] = [];
  for (const node of nodes) {
    if (node.live) continue;
    skeleton.push({
      rawRole: node.rawRole,
      ariaRole: node.ariaRole,
      name: node.name,
      containerPath: node.containerPath,
      state: node.state,
    });
  }
  return digestOf(skeleton);
}
