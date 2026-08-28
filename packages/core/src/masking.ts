// SPEC section 8.4 - screenshot region masking.
//
// Masking happens BEFORE the bytes exist. A capture that was ever unmasked in memory is a capture
// that can leak, so the region list is computed from the observation the executor already has and
// handed to the driver as part of the request - the driver never produces an unmasked image and
// then paints over it.
//
// Two things this module refuses to do quietly, both of which are the interesting half:
//
//   · A sensitive node with NO GEOMETRY cannot be masked. The tempting behaviour is to skip it and
//     take the screenshot anyway; that is precisely how a member number ends up in evidence. It is
//     reported as `unmaskable`, and `safeCaptureRequest` refuses the capture. Losing a screenshot
//     is a debugging cost. Leaking one is a regulatory event.
//   · Bounds carry a UNIT (`px` on a browser, `cell` on a character grid). A pixel rectangle
//     applied to a grid dump masks the wrong cells - and masks nothing where it matters. Mixed
//     units are treated as unmaskable rather than averaged into a plausible-looking rectangle.
//
// [spike, browser section 4.4] Playwright's `mask` takes `Locator[]`, not rectangles, so the
// browser driver keeps a `UINode -> Locator` bridge used purely for redaction. That is a driver
// concern; what crosses the port is still `CaptureRequest.maskRegions`, because the terminal driver
// blanks a cell range and has no locators at all.

import type { Bounds, CaptureRequest, UINode } from "./observation.js";
import type { NodeId } from "./primitives.js";

export type MaskRegion = CaptureRequest["maskRegions"][number];
export type MaskUnit = Bounds["unit"];

export interface MaskDerivationOptions {
  /** Which unit the capture is measured in. Defaults to the unit of the first sensitive node that
   *  has bounds, because a driver reports one unit and one only. */
  readonly unit?: MaskUnit;
  /** Grown by this much on every side. `0` masks exactly what the driver reported, which is what
   *  the browser spike verified at the pixel; a driver whose geometry is known to be tight by a
   *  hair can ask for one. */
  readonly padding?: number;
  /** Also mask every node the driver already blanked (`UINode.masked`). On by default: the driver
   *  blanked the value because it is bound to a sensitive parameter, and the pixels are still
   *  there. */
  readonly includeDriverMasked?: boolean;
}

export interface MaskDerivation {
  /** Deterministically ordered (top-to-bottom, then left-to-right) and de-duplicated, so the same
   *  screen produces the same request - and therefore the same capture digest - every time. */
  readonly regions: readonly MaskRegion[];
  /** Sensitive nodes present in the observation that could not be turned into a rectangle: no
   *  bounds, or bounds in a unit this capture is not measured in. A capture taken now WOULD leak
   *  them. */
  readonly unmaskable: readonly NodeId[];
  /** Sensitive nodes that are not in this observation at all, or occupy no area. Nothing of them
   *  is on screen, so there is nothing to mask - reported rather than silently dropped, because
   *  "the field we meant to mask was not there" is worth seeing in a journal. */
  readonly absent: readonly NodeId[];
}

/**
 * The regions to blank for a set of nodes bound to sensitive parameters.
 *
 * Each named node contributes the union of its own rectangle and those of its descendants. That
 * matters on a legacy surface far more than it looks: the accessible node carrying the name is
 * routinely a container, and the text a human reads is in a child. Masking the union costs a few
 * extra pixels and removes an entire class of "we masked the label, not the value".
 */
export function deriveMaskRegions(
  nodes: readonly UINode[],
  sensitiveNodeIds: readonly NodeId[],
  options: MaskDerivationOptions = {},
): MaskDerivation {
  const byId = new Map<NodeId, UINode>();
  for (const node of nodes) byId.set(node.id, node);

  const wanted = new Set<NodeId>(sensitiveNodeIds);
  if (options.includeDriverMasked !== false) {
    for (const node of nodes) if (node.masked) wanted.add(node.id);
  }

  const unit = options.unit ?? inferUnit(wanted, byId);
  const padding = options.padding ?? 0;

  const regions: MaskRegion[] = [];
  const unmaskable: NodeId[] = [];
  const absent: NodeId[] = [];

  for (const id of [...wanted].sort()) {
    const root = byId.get(id);
    if (root === undefined) {
      absent.push(id);
      continue;
    }
    const box = unionOfSubtree(root, byId, unit);
    if (box === "wrong-unit") {
      unmaskable.push(id);
      continue;
    }
    if (box === null) {
      // No geometry anywhere in the subtree. If the surface reports no geometry at all this is a
      // capability question, not a leak - but we cannot tell those apart from here, so the
      // conservative reading wins and the caller decides with `safeCaptureRequest`.
      unmaskable.push(id);
      continue;
    }
    if (box.w === 0 || box.h === 0) {
      absent.push(id);
      continue;
    }
    regions.push(pad(box, padding));
  }

  return { regions: dedupe(regions), unmaskable, absent };
}

/**
 * The capture request, or a refusal.
 *
 * Separated from the derivation so that the refusal is a value the executor has to handle rather
 * than an exception it can forget to catch - and so the journal can record `capture-refused` with
 * the node ids that caused it, which is a far better bug report than a missing file.
 */
export type SafeCaptureRequest =
  | { readonly ok: true; readonly request: CaptureRequest }
  | { readonly ok: false; readonly unmaskable: readonly NodeId[] };

export function safeCaptureRequest(
  derivation: MaskDerivation,
  format: CaptureRequest["format"],
): SafeCaptureRequest {
  if (derivation.unmaskable.length > 0) {
    return { ok: false, unmaskable: derivation.unmaskable };
  }
  return { ok: true, request: { maskRegions: derivation.regions, format } };
}

// ---------------------------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------------------------

function inferUnit(wanted: ReadonlySet<NodeId>, byId: ReadonlyMap<NodeId, UINode>): MaskUnit {
  for (const id of [...wanted].sort()) {
    const bounds = byId.get(id)?.bounds;
    if (bounds) return bounds.unit;
  }
  return "px";
}

function unionOfSubtree(
  root: UINode,
  byId: ReadonlyMap<NodeId, UINode>,
  unit: MaskUnit,
): MaskRegion | null | "wrong-unit" {
  let box: MaskRegion | null = null;
  let sawWrongUnit = false;
  // Iterative and visited-guarded: `children` is driver-reported, and a cycle in it must not hang
  // the executor at the exact moment it is trying to redact something.
  const seen = new Set<NodeId>([root.id]);
  const queue: UINode[] = [root];
  while (queue.length > 0) {
    const node = queue.pop() as UINode;
    const bounds = node.bounds;
    if (bounds !== null) {
      if (bounds.unit !== unit) sawWrongUnit = true;
      else box = box === null ? rect(bounds) : union(box, rect(bounds));
    }
    for (const childId of node.children) {
      if (seen.has(childId)) continue;
      seen.add(childId);
      const child = byId.get(childId);
      if (child !== undefined) queue.push(child);
    }
  }
  // Fail closed on ANY wrong-unit geometry in the subtree, even when some of it was usable: a
  // partial mask is an unmasked value with a rectangle next to it.
  if (sawWrongUnit) return "wrong-unit";
  return box;
}

function rect(b: Bounds): MaskRegion {
  return { x: b.x, y: b.y, w: b.w, h: b.h };
}

function union(a: MaskRegion, b: MaskRegion): MaskRegion {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.w, b.x + b.w);
  const bottom = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: right - x, h: bottom - y };
}

function pad(box: MaskRegion, padding: number): MaskRegion {
  if (padding === 0) return box;
  return {
    x: box.x - padding,
    y: box.y - padding,
    w: box.w + padding * 2,
    h: box.h + padding * 2,
  };
}

function dedupe(regions: readonly MaskRegion[]): readonly MaskRegion[] {
  const seen = new Set<string>();
  const out: MaskRegion[] = [];
  for (const r of [...regions].sort((a, b) => a.y - b.y || a.x - b.x || a.w - b.w || a.h - b.h)) {
    const key = `${r.x},${r.y},${r.w},${r.h}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
