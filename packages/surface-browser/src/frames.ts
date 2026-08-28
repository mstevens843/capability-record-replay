// Driver rule D3: `containerPath` is the frame NAME chain, never an ordinal - and driver rule D7:
// when `Page.getFrameTree` and `page.frames()` disagree, say so instead of silently perceiving less
// than the whole screen.
//
// The ordinal ban is measured, not stylistic. Navigating the `content` frame away removed a nested
// iframe and shifted every subsequent ordinal in the same session (browser spike section 2.3):
//
//   before: f0=#0 f1=#0/banner f2=#0/nav f3=#0/content f4=#0/content/detail
//   after : f0=#0 f1=#0/banner f2=#0/nav f3=#0/content
//
// A descriptor scoped to "frame 3" therefore means two different documents ten seconds apart. Names
// in a frameset are author-assigned, are what the application's own `target=` attributes use, and
// are what a human calls the frame - so they are what a breadcrumb stores.

import type { AxNode } from "./cdp.js";

/** The name given to the top document's own segment. A real word rather than an ordinal or a `#`
 *  sigil: it has to survive `@crr/core`'s text-safety refusal, which rejects a leading `#name` as a
 *  stylesheet selector, and it has to read as something a person would write in a matcher. */
export const TOP_FRAME_SEGMENT = "top";

/** What an unnamed non-root frame is called. THE ONE ORDINAL IN THE DESIGN, and it exists only
 *  because there is nothing else: an unnamed frame has no author-assigned identity at all. It is
 *  spelled so a reader can see what it is, and driver rule D3 still holds for every named frame -
 *  which, in a frameset-era application, is all of them. */
export const unnamedFrameSegment = (indexInParent: number): string => `frame-${indexInParent}`;

/** One frame, flattened out of the tree, in document order. */
export interface FrameInfo {
  readonly id: string;
  /** The author-assigned name, or `""`. Kept raw so `Observation.route.frame` reports what the
   *  application calls the frame rather than our fallback. */
  readonly name: string;
  readonly url: string;
  /** The name chain from the top document down to and including this frame. */
  readonly path: readonly string[];
  /** Index into the flattened list of the frame that embeds this one, or `null` for the top. */
  readonly parent: number | null;
}

/** The shape of `Page.getFrameTree`'s reply that this module reads. */
export interface FrameTreeNode {
  readonly frame: { readonly id: string; readonly name?: string; readonly url: string };
  readonly childFrames?: readonly FrameTreeNode[];
}

/**
 * Depth-first flattening of the frame tree, with each frame's name path computed on the way down.
 *
 * Depth-first and not breadth-first because the resulting order is the order the documents appear
 * on screen, which is the order a person reads them in and therefore the order an `Observation`'s
 * nodes should arrive in.
 */
export function flattenFrameTree(root: FrameTreeNode): readonly FrameInfo[] {
  const out: FrameInfo[] = [];
  const walk = (node: FrameTreeNode, path: readonly string[], parent: number | null): void => {
    const name = node.frame.name ?? "";
    const segment =
      parent === null ? TOP_FRAME_SEGMENT : name === "" ? unnamedFrameSegment(out.length) : name;
    const here = [...path, segment];
    const index = out.length;
    out.push({ id: node.frame.id, name, url: node.frame.url, path: here, parent });
    for (const child of node.childFrames ?? []) walk(child, here, index);
  };
  walk(root, [], null);
  return out;
}

/**
 * Driver rule D7, stated as a comparison rather than as a `catch {}`.
 *
 * A true out-of-process iframe is invisible to `Page.getFrameTree` on the page's own CDP session and
 * needs a session of its own; its `DOM.getBoxModel` then returns FRAME-LOCAL coordinates, so a
 * coordinate click computed from them misses the element entirely - measured, not inferred (browser
 * spike section 2.4: `click frame-LOCAL rect centre -> hit button = false`).
 *
 * Composing those offsets is perfectly doable. It is also untested code in the path that decides
 * where a click lands inside a banking application, and a loud limitation beats a quiet
 * approximation - so the driver DETECTS the case and refuses to perceive, rather than skipping the
 * frame and returning a screen that is missing a third of itself with no indication that it is.
 *
 * Returns a human-readable detail string when the two views disagree, or `null` when they agree.
 * Deliberately reports NAMES and counts and never URLs: a frame url is `/member/10041`, and an
 * `Observation` - fault included - is a document that gets written to an evidence directory.
 */
export function unperceivableFrameDetail(
  fromCdp: readonly FrameInfo[],
  livePageFrameNames: readonly string[],
): string | null {
  if (livePageFrameNames.length <= fromCdp.length) return null;
  const seen = new Set(fromCdp.map((frame) => frame.name));
  const missing: string[] = [];
  for (const name of livePageFrameNames) {
    if (seen.has(name)) {
      seen.delete(name);
      continue;
    }
    missing.push(name === "" ? "<unnamed>" : name);
  }
  // Assembled from parts rather than concatenated with `+`, which keeps the sentence readable at
  // this file's line width without tripping the formatter's preference for a single literal.
  return [
    `the browser reports ${livePageFrameNames.length} frames and this page's CDP session can see`,
    `${fromCdp.length}; unreachable: ${missing.join(", ")}.`,
    "A frame in its own process needs its own session and reports frame-local geometry, so",
    "composing it into this observation would produce coordinates that miss.",
  ].join(" ");
}

/**
 * The stitch edge, expressed as a lookup rather than as a walk.
 *
 * `Accessibility.getFullAXTree` fetches "the entire accessibility tree for the root Document" -
 * ROOT DOCUMENT, singular. On a frameset it returns seven nodes and every `Iframe` node has
 * `childIds: []`; nothing from any child document is present, same-origin or not (browser spike
 * section 2.1). The edge that joins them is `DOM.describeNode({backendNodeId}).node.frameId`, which
 * turns an `Iframe` AX leaf into the id of the document it embeds.
 */
export interface StitchEdge {
  /** The `Iframe` AX node, already namespaced to a global `NodeId`. */
  readonly iframeNodeId: string;
  /** The frame it embeds, as an index into the flattened frame list. */
  readonly childFrameIndex: number;
}

/** Every AX node that embeds another document, with the backend id the stitch is resolved through. */
export function iframeNodesOf(nodes: readonly AxNode[], role: string): readonly AxNode[] {
  return nodes.filter((node) => node.role?.value === role && node.backendDOMNodeId !== undefined);
}
