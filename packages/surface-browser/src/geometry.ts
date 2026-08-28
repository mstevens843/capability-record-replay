// Driver rule D4, and the three traps that make it a rule instead of two lines of arithmetic.
//
//   · TWO COORDINATE SPACES. `ariaSnapshot({boxes:true})` and `getBoundingClientRect()` report boxes
//     that are FRAME-LOCAL; `DOM.getBoxModel` and `locator.boundingBox()` report MAIN-FRAME ones. On
//     a single-document page nobody notices. On a frameset they differ by the frame's offset, and a
//     click at the frame-local point lands somewhere else entirely - measured directly:
//     `click frame-LOCAL rect centre -> hit button = false`. `page.mouse` consumes main-frame
//     viewport CSS pixels, so `DOM.getBoxModel` is the only source used here.
//
//   · THE `border` QUAD, NEVER `content`. They coincide for an `<a>` and do not for a `<button>`:
//     content `x=193.1 w=112.6`, border `x=185.1 w=128.6`, and `border` is what
//     `locator.boundingBox()` returns. On a legacy toolbar button that is mostly padding, the
//     content centre is the difference between hitting the control and hitting its container.
//
//   · READ THE BOX AGAIN AFTER SCROLLING. Boxes move when a frame scrolls and they can go negative,
//     tracking exactly (`y=197` before a `scrollTo(0,300)`, `y=-103` after). So the sequence is
//     scroll -> RE-READ -> validate -> click, never read-once-and-click.
//
// A fourth trap is handled by the caller rather than here, and is worth naming next to these: a
// zero-size node is PRESENT AND NOT IGNORED in the accessibility tree with a `0x0` box, so "the node
// exists" is not evidence that a coordinate click is possible.

import type { Bounds } from "@crr/core";
import type { BoxModel } from "./cdp.js";

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * The border quad as an integer rectangle in main-frame CSS pixels.
 *
 * A quad is eight numbers: four corners, clockwise from the top left. Width therefore comes from
 * `[2] - [0]` (top-right minus top-left) and height from `[7] - [1]` (bottom-left minus top-left).
 * Rounding is to integers because the schema has no floating point anywhere at any depth - a digest
 * over an artifact must not depend on how a platform prints `88.10000000000001`.
 */
export function boundsFromBoxModel(model: BoxModel): Bounds | null {
  const quad = model.border;
  if (quad.length < 8) return null;
  const x0 = quad[0] as number;
  const y0 = quad[1] as number;
  const x1 = quad[2] as number;
  const y1 = quad[7] as number;
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
  return {
    x: Math.round(x0),
    y: Math.round(y0),
    w: Math.max(0, Math.round(x1 - x0)),
    h: Math.max(0, Math.round(y1 - y0)),
    unit: "px",
  };
}

/** The centre of a rectangle, rounded to a whole pixel. `page.mouse` takes main-frame viewport CSS
 *  pixels, which is the space `boundsFromBoxModel` already produced. */
export function centreOf(bounds: Bounds): Point {
  return { x: Math.round(bounds.x + bounds.w / 2), y: Math.round(bounds.y + bounds.h / 2) };
}

/** Why a node cannot be clicked where it is, or `null` when it can. The two arms map straight onto
 *  `ActFault`'s `not-actionable.why`, so the driver never has to invent a reason. */
export type UnclickableReason = "zero-size" | "off-screen-unscrollable";

/**
 * Can a real mouse reach the centre of this rectangle?
 *
 * Zero-size first, because a `0x0` box has a centre that looks perfectly reasonable and clicking it
 * hits whatever is underneath - which is the silent-wrong-target failure this whole design exists to
 * refuse. Then the viewport test, applied AFTER the caller has scrolled and re-read: a box still
 * outside the viewport at that point is one nothing can bring into view.
 */
export function unclickableReason(bounds: Bounds, viewport: Viewport): UnclickableReason | null {
  if (bounds.w === 0 || bounds.h === 0) return "zero-size";
  const centre = centreOf(bounds);
  const inside =
    centre.x >= 0 && centre.y >= 0 && centre.x < viewport.width && centre.y < viewport.height;
  return inside ? null : "off-screen-unscrollable";
}
