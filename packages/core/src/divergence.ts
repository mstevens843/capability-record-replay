// Cross-tenant surface divergence - the reporting half of SPEC section 9.4.
//
// There are TWO drift questions in this system and they are deliberately separate documents:
//
//   1. "Did THIS RUN see the surface the artifact was recorded against?" - `DriftSignal`, computed
//      per run in `@crr/runtime` over descriptor VERDICTS. It rides on every result arm including
//      `ok`. It answers a question about one run.
//   2. "How different are these two tenants of the same vendor product?" - this file. It is
//      computed over two OBSERVATIONS of the same screen and answers a question about a deployment:
//      does this tenant need its own artifact, or does a vocabulary overlay cover it?
//
// Question 2 is the one OPEN-QUESTIONS-RESOLVED Q4 defers, and this module is the measurement it
// defers TO. **IT SHIPS NO THRESHOLD.** `needsSpecialization` is `null` here - not `false`, which
// would be a verdict nobody earned - and the report carries the entries that changed so that the
// human deciding has the evidence and not just the fraction. Inventing a cutoff and defending it in
// a write-up is exactly the unearned precision this project does not do.
//
// THE ARITHMETIC, AND WHERE IT DEPARTS FROM THE TERMINAL SPIKE'S. The spike
// (docs/design/spike-terminal-surface.md section 3.4) reported its two tenants as
// `shared 3/8 -> divergence 63%` over all nodes and `shared 3/5 -> 40%` over interactive nodes:
// one minus the shared count over ONE SIDE's node count. This ships the JACCARD distance instead -
// one minus the shared count over the size of the UNION - and the difference is not cosmetic, so
// it is written down rather than quietly absorbed:
//
//   · `1 - shared/|left|` reports ZERO when the right side is a strict superset of the left. A
//     tenant that added five controls to a nav bar scores 0% divergence under it, and five added
//     controls is precisely the drift that breaks an ordinal descriptor next quarter.
//   · Jaccard is symmetric, so it does not depend on which tenant you happened to call `left`, and
//     `crossTenantDivergence(a, b)` and `(b, a)` cannot disagree.
//
// The conversion, for anyone comparing against the spike's numbers: the spike's eight-node screens
// share three keys, so they are 3/8 = 63% its way and 3/13 = 77% this way. Both denominators are
// printed on every row of `renderDivergence` for exactly this reason - a percentage with no
// denominator beside it is a number nobody can check.
//
// The two BANDS are reported side by side because the gap between them is the finding: it is what
// says whether the difference between two tenants is branding or structure - and the direction of
// that gap turns out to depend on the surface, which is measured rather than assumed. See
// `packages/runtime/test/browser-overlay.test.ts` for the web fixture's numbers and why they invert
// the spike's relationship.
//
// WHAT IS DELIBERATELY NOT IN THE KEY:
//   - `containerPath`, because one tenant wrapping its content in an extra layout table would make
//     every node on the screen read as changed, and "they nested one more table" is not the same
//     news as "they renamed every field". A structural comparison is a different report; this one
//     is about vocabulary, which is what the overlay mechanism actually addresses.
//   - geometry, `value`, `text` and `live` nodes. Geometry moves with a font; a value moves with
//     the member; a live node moves on its own. None of the three is a per-tenant fact.
//   - node ids. They are per-observation handles and comparing them would report on the driver.

import { normalize } from "./normalizers.js";
import type { Observation, UINode } from "./observation.js";
import type { Role } from "./primitives.js";

/**
 * The roles a person can act on.
 *
 * `text`, `heading`, `image`, `region`, `table`, `row`, `cell` and the other structural roles are
 * absent on purpose: they are exactly the band a rebrand moves, and a signal that screams at every
 * rebrand is a signal people learn to ignore. `alert` and `status` are absent for a different
 * reason - they carry a transient message, so including them would make two observations of the
 * same unchanged screen compare as different.
 *
 * Exported and shared rather than redefined per caller. `@crr/discovery`'s surface fingerprint uses
 * the same set, and two definitions of "what counts as interactive" that have to agree is precisely
 * the class of bug this repository has already been bitten by once.
 */
export const INTERACTIVE_ROLES: ReadonlySet<Role> = new Set<Role>([
  "button",
  "link",
  "textbox",
  "combobox",
  "listbox",
  "option",
  "checkbox",
  "radio",
  "tab",
]);

/** Which nodes a comparison is taken over. */
export type DivergenceBand = "all" | "interactive";

/**
 * One node's identity for comparison purposes: its role and what it is called, folded.
 *
 * `std.text@1` and not `std.label@1`: the label normalizer strips branding runs, and the whole
 * point of the `all` band is to SHOW what branding costs. Folding it away inside the metric would
 * make the two bands report the same number and the finding would vanish.
 */
export function divergenceKeyOf(candidate: UINode): string {
  const role = candidate.ariaRole ?? candidate.rawRole;
  // A stringified PAIR rather than a joined string: `rawRole` is free text on some drivers, so any
  // separator that can occur inside a role is a separator that can make two different nodes produce
  // one key - and a collision understates divergence, which is the one direction a report like this
  // must never be wrong in.
  return JSON.stringify([role, normalize("std.text@1", candidate.name)]);
}

/**
 * The multiset of node keys on a screen, sorted.
 *
 * A multiset rather than a set: a grid with four "Open" links is a different screen from one with
 * two, and collapsing them would hide a tenant whose results page paginates differently. Sorted so
 * that two drivers walking a frameset in a different order describe the same screen.
 */
export function surfaceKeysOf(observation: Observation, band: DivergenceBand): readonly string[] {
  const keys: string[] = [];
  for (const candidate of observation.nodes) {
    if (candidate.live) continue;
    if (band === "interactive") {
      if (candidate.ariaRole === null || !INTERACTIVE_ROLES.has(candidate.ariaRole)) continue;
    }
    keys.push(divergenceKeyOf(candidate));
  }
  return keys.sort();
}

export interface DivergenceEntry {
  readonly key: string;
  /** How many the left side has, and how many the right side has. One of them is always zero for a
   *  key that appears in `onlyLeft` or `onlyRight`; both are non-zero for a count difference. */
  readonly left: number;
  readonly right: number;
}

export interface BandDivergence {
  readonly band: DivergenceBand;
  /** Multiset sizes, not distinct-key counts: `shared 3/8` in the spike's notation is
   *  `shared` over `union`. */
  readonly leftNodes: number;
  readonly rightNodes: number;
  readonly shared: number;
  readonly union: number;
  /** `1 - shared/union`, rounded to four places. `0` when both sides are empty, because two blank
   *  screens have not diverged - they have failed, and that is a different report. */
  readonly divergence: number;
  /** What actually differs, so the fraction is never the only thing on the page. Bounded, because a
   *  report is read by a person. */
  readonly changed: readonly DivergenceEntry[];
  /** True when `changed` was cut short by the bound above. */
  readonly changedTruncated: boolean;
}

const MAX_CHANGED = 64;

/**
 * Compare two screens.
 *
 * Total: no throw, no clock, no I/O. Two observations of screens that share nothing return
 * divergence 1 and the whole of both sides in `changed`, which is correct and is also what a
 * comparison of the WRONG two screens looks like - so the caller pairs them by screen id and the
 * report says which pairing it used.
 */
export function compareSurfaces(
  left: Observation,
  right: Observation,
  band: DivergenceBand,
): BandDivergence {
  const leftKeys = surfaceKeysOf(left, band);
  const rightKeys = surfaceKeysOf(right, band);
  return compareKeys(leftKeys, rightKeys, band);
}

/** The same comparison over already-extracted keys, so a caller that has them does not re-walk. */
export function compareKeys(
  leftKeys: readonly string[],
  rightKeys: readonly string[],
  band: DivergenceBand,
): BandDivergence {
  const leftCounts = countOf(leftKeys);
  const rightCounts = countOf(rightKeys);

  let shared = 0;
  let union = 0;
  const changed: DivergenceEntry[] = [];
  // Sorted so two runs of the same comparison produce byte-identical reports.
  for (const key of [...new Set([...leftCounts.keys(), ...rightCounts.keys()])].sort()) {
    const l = leftCounts.get(key) ?? 0;
    const r = rightCounts.get(key) ?? 0;
    shared += Math.min(l, r);
    union += Math.max(l, r);
    if (l !== r && changed.length < MAX_CHANGED) changed.push({ key, left: l, right: r });
  }

  return {
    band,
    leftNodes: leftKeys.length,
    rightNodes: rightKeys.length,
    shared,
    union,
    divergence: union === 0 ? 0 : round4(1 - shared / union),
    changed,
    changedTruncated: changed.length >= MAX_CHANGED,
  };
}

export interface ScreenDivergence {
  /** How the caller named this pair of screens. Free text, because the two sides may not agree on a
   *  route: that is one of the things being measured. */
  readonly screen: string;
  readonly all: BandDivergence;
  readonly interactive: BandDivergence;
}

export interface CrossTenantDivergenceReport {
  readonly leftTenantId: string;
  readonly rightTenantId: string;
  readonly screens: readonly ScreenDivergence[];
  /** Every screen's nodes pooled, so one number can be quoted for the deployment. Pooled rather
   *  than averaged: an average over screens weights a two-control dialog the same as a grid. */
  readonly overall: { readonly all: BandDivergence; readonly interactive: BandDivergence };
  /**
   * ALWAYS `null`, and the type says so.
   *
   * OPEN-QUESTIONS-RESOLVED Q4: the threshold is measured against a corpus, not invented, and until
   * it has been the honest value is "this report does not decide". `false` would be a decision;
   * `null` is the absence of one, and a caller that wants to act on divergence has to write the
   * comparison itself, in the open, where a reviewer can see the number it chose.
   */
  readonly needsSpecialization: null;
}

export interface ScreenPair {
  readonly screen: string;
  readonly left: Observation;
  readonly right: Observation;
}

/** The whole report, over as many screen pairs as the caller has. */
export function crossTenantDivergence(args: {
  readonly leftTenantId: string;
  readonly rightTenantId: string;
  readonly screens: readonly ScreenPair[];
}): CrossTenantDivergenceReport {
  const screens = args.screens.map((pair) => ({
    screen: pair.screen,
    all: compareSurfaces(pair.left, pair.right, "all"),
    interactive: compareSurfaces(pair.left, pair.right, "interactive"),
  }));

  const pool = (band: DivergenceBand): BandDivergence => {
    const left: string[] = [];
    const right: string[] = [];
    for (const pair of args.screens) {
      // Prefixed by screen, so the same label on two different screens is two different facts. A
      // pooled comparison that let "Search" on the results page cancel "Search" on the search page
      // would understate divergence by exactly the amount a rebrand costs.
      for (const key of surfaceKeysOf(pair.left, band))
        left.push(JSON.stringify([pair.screen, key]));
      for (const key of surfaceKeysOf(pair.right, band))
        right.push(JSON.stringify([pair.screen, key]));
    }
    return compareKeys(left, right, band);
  };

  return {
    leftTenantId: args.leftTenantId,
    rightTenantId: args.rightTenantId,
    screens,
    overall: { all: pool("all"), interactive: pool("interactive") },
    needsSpecialization: null,
  };
}

/**
 * The report as the fixed-width block a human reads in a terminal or pastes into evidence.
 *
 * Rendered here rather than by the caller for the same reason `renderVerdict` lives in this package:
 * two runs of the same report must explain themselves identically, and a format assembled at each
 * call site does not.
 */
export function renderDivergence(report: CrossTenantDivergenceReport): string {
  const lines: string[] = [];
  lines.push(`cross-tenant divergence  ${report.leftTenantId} -> ${report.rightTenantId}`);
  lines.push("screen                    band          left  right  shared  union  divergence");
  const row = (screen: string, d: BandDivergence): string =>
    [
      screen.padEnd(24),
      d.band.padEnd(12),
      String(d.leftNodes).padStart(5),
      String(d.rightNodes).padStart(6),
      String(d.shared).padStart(7),
      String(d.union).padStart(6),
      `${(d.divergence * 100).toFixed(1)}%`.padStart(11),
    ].join("  ");
  for (const screen of report.screens) {
    lines.push(row(screen.screen, screen.all));
    lines.push(row("", screen.interactive));
  }
  lines.push(row("OVERALL", report.overall.all));
  lines.push(row("", report.overall.interactive));
  lines.push("needsSpecialization: null (no threshold ships; see OPEN-QUESTIONS-RESOLVED Q4)");
  return lines.join("\n");
}

function countOf(keys: readonly string[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}
