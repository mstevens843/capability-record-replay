// Driver rule D2, as a table.
//
// `ariaRole` is `null` unless Chromium reported `role.type === "role"` AND that role has a member in
// `@crr/core`'s closed `Role` vocabulary. Only non-null nodes are candidate targets, and that single
// field is the whole difference between "resolved to 3 elements" and `OK` on a page built out of
// nested layout tables:
//
//   role=LayoutTable     type=internalRole   <- structure. ariaRole: null. never a target.
//   role=table           type=role           <- the real data grid.
//   role=LayoutTableRow  type=internalRole   <- structure.
//   role=row             type=role           <- a row "the row whose Member ID is X" can mean.
//
// (browser spike sections 1.4 and 9. `filter({has})` over folded roles matched two ancestor rows for
// every member id and Playwright strict mode refused with "resolved to 3 elements".)
//
// The second half of the rule is the closed vocabulary. `generic` and `none` arrive as
// `type === "role"` and are still structure, so passing D2 is necessary and not sufficient: a role
// becomes an `ariaRole` only by appearing in the table below. That is also what makes
// `SurfaceCapabilities.supportedRoles` honest - it is COMPUTED from this table, so the linker's
// load-time refusal (SPEC section 10 check 17) is checked against what the driver can really emit
// rather than against a list somebody maintained by hand.

import type { Role } from "@crr/core";

/**
 * Chromium's ARIA role name -> the normalized cross-surface role.
 *
 * Most rows are the identity. The ones that are not each fold a role that means the same thing to
 * an operator into the vocabulary a program is written in, which is the entire job of a normalized
 * role: an artifact says `button` and does not care that this tenant's markup used a `<input
 * type=submit>` and the next one used a `<a role=button>`.
 */
export const ARIA_ROLE_MAP: Readonly<Record<string, Role>> = {
  // -- identity
  button: "button",
  link: "link",
  textbox: "textbox",
  combobox: "combobox",
  listbox: "listbox",
  option: "option",
  checkbox: "checkbox",
  radio: "radio",
  table: "table",
  row: "row",
  cell: "cell",
  columnheader: "columnheader",
  rowheader: "rowheader",
  heading: "heading",
  dialog: "dialog",
  alert: "alert",
  status: "status",
  form: "form",
  region: "region",
  navigation: "navigation",
  main: "main",
  group: "group",
  list: "list",
  listitem: "listitem",
  tab: "tab",
  image: "image",

  // -- folded, each for a stated reason
  /** `<img>` reports `image` on some builds and `img` on others; they are one thing to a program. */
  img: "image",
  /** A search box is a textbox that the author labelled. Nothing a step does to one differs. */
  searchbox: "textbox",
  /** An alert dialog is a dialog that also shouts. Band B2 cares that input is intercepted. */
  alertdialog: "dialog",
  /** A grid is a table with keyboard semantics; a gridcell is a cell. The row/column addressing a
   *  `table-cell` descriptor performs is identical, and refusing to map them would make an
   *  artifact recorded against a `<table>` fail on a tenant whose vendor upgraded to `role=grid`. */
  grid: "table",
  treegrid: "table",
  gridcell: "cell",
  /** A switch is a checkbox with different paint. `setToggle` means the same thing to both. */
  switch: "checkbox",
  /** The four landmark roles with no member of their own. They are regions, they can appear in a
   *  `containerPath`, and scoping a detector to one is worth more than the lost distinction. */
  banner: "region",
  contentinfo: "region",
  complementary: "region",
  search: "region",
};

/**
 * The normalized role for one Chromium AX role, or `null` for structure.
 *
 * `type` is checked before the table, so a Chromium-internal role can never reach it - not even one
 * that happens to share a spelling with an ARIA role.
 */
export function normalizeRole(roleType: string | undefined, roleValue: string): Role | null {
  if (roleType !== "role") return null;
  return ARIA_ROLE_MAP[roleValue] ?? null;
}

/**
 * Every role this driver can emit, sorted, with no duplicates.
 *
 * Derived rather than declared: a role added to the table above appears here automatically, and a
 * role that is NOT in the table is refused by the linker at load time instead of failing as a
 * mysterious `target-not-found` six steps into a run.
 *
 * Note what is absent: `text`. No Chromium ARIA role maps to it - a run of page text arrives as the
 * internal role `StaticText` and is therefore structure - so this driver never emits it. That is
 * not a gap in perception: a `StaticText` node keeps its `name` and its `text`, and the
 * `text-present` predicate scans both fields on EVERY node, structural ones included. What it costs
 * is the ability to make a text run an action target, which is the correct thing to lose.
 */
export const BROWSER_SUPPORTED_ROLES: readonly Role[] = [
  ...new Set(Object.values(ARIA_ROLE_MAP)),
].sort() as readonly Role[];

/**
 * The roles a `containerPath` landmark segment may carry, matched against `@crr/core`'s
 * `LandmarkRole`. A node with one of these roles becomes a breadcrumb segment for everything
 * beneath it.
 */
export const LANDMARK_ROLES: ReadonlySet<Role> = new Set<Role>([
  "main",
  "navigation",
  "form",
  "region",
  "dialog",
]);

/** Chromium's own name for a run of rendered text. Its `name` IS the text, and it is the node a
 *  `label-anchored` descriptor anchors on when a legacy form has no `<label for>` at all - which is
 *  every form in the target applications. */
export const STATIC_TEXT_ROLE = "StaticText";

/** The AX role of the element that embeds another document. The stitch edge: `DOM.describeNode` on
 *  its backend id yields the child document's frame id. */
export const IFRAME_ROLE = "Iframe";
