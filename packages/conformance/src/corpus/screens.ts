// The frozen corpus: one screen family per fault `fixtures/corebank-web` can inject.
//
// The fixture's registry (`fixtures/corebank-web/src/faults.js`) declares ten faults and states, per
// fault, which row of SPEC section 4.2 it is built to produce. Every one of them has a screen here
// and a scenario in `../scenarios/index.ts`, plus the four wrong-target sub-cases of SPEC section
// 4.5 that no HTTP fault can express because they are properties of a locator rather than of a
// response.
//
// Two screens in here are the ones a browser cannot be asked for on demand, and they are the reason
// this corpus is hand-built rather than captured:
//
//   · `results-loading` claims "0 records found" while it is still painting. That is not a
//     contrivance - it is what a server-rendered grid with a flushed header does, and it is exactly
//     why band B0 runs before band B3. An engine without a quiescence gate reads it and tells a
//     member their account does not exist.
//   · `detail` shows a share balance of `0.00` before the tab it belongs to has loaded. An engine
//     without the effect-delta assertion clicks a dead control, reads that, and returns a WRONG
//     BALANCE on the `ok` arm.

import { type NodeId, type Observation, tearObservation } from "@crr/core";
import { type NodeSpec, node, screen } from "./build.js";

// ---------------------------------------------------------------------------------------------
// Node ids. Generated-looking on purpose: the fixture serves `ctl00_ctl32_g_9a1` and nothing above
// the driver is allowed to care.
// ---------------------------------------------------------------------------------------------

export const IDS = {
  memberIdLabel: "text:ctl00_lbl_g_a1" as NodeId,
  memberIdField: "textbox:ctl00_txt_g_a2" as NodeId,
  branchLabel: "text:ctl00_lbl_g_a3" as NodeId,
  branchField: "textbox:ctl00_txt_g_a4" as NodeId,
  searchButton: "button:ctl00_btn_g_a5" as NodeId,
  quickField: "textbox:ctl00_txt_g_q1" as NodeId,
  quickButton: "button:ctl00_btn_g_q2" as NodeId,
  resultsBanner: "status:ctl00_lbl_g_b0" as NodeId,
  openLink: "link:ctl00_lnk_g_c9" as NodeId,
  otherLink: "link:ctl00_lnk_g_c8" as NodeId,
  detailHeading: "heading:ctl00_hdg_g_d1" as NodeId,
  detailName: "text:ctl00_txt_g_d2" as NodeId,
  sharesTab: "tab:ctl00_tab_g_d3" as NodeId,
  sharesStatus: "status:ctl00_lbl_g_d4" as NodeId,
  noticeAck: "button:ctl00_btn_g_m1" as NodeId,
  noticeContinue: "button:ctl00_btn_g_m2" as NodeId,
} as const;

export const MEMBER_ID = "50001";
const OTHER_MEMBER = "50002";

// ---------------------------------------------------------------------------------------------
// The search form
// ---------------------------------------------------------------------------------------------

const searchNodes = (opts: {
  readonly member?: string | null;
  readonly branch?: string | null;
  readonly memberInvalid?: boolean;
  readonly branchInvalid?: boolean;
  readonly banner?: string;
}) => {
  const nodes = [
    node({
      id: IDS.memberIdLabel,
      role: "text",
      where: "search",
      name: "Member ID",
      text: "Member ID",
    }),
    node({
      id: IDS.memberIdField,
      role: "textbox",
      where: "search",
      name: "Member ID",
      value: opts.member ?? null,
      capacity: 5,
      labelledBy: [IDS.memberIdLabel],
      ...(opts.memberInvalid === true ? { invalid: true } : {}),
    }),
    node({
      id: IDS.branchLabel,
      role: "text",
      where: "search",
      name: "Branch Code",
      text: "Branch Code",
    }),
    node({
      id: IDS.branchField,
      role: "textbox",
      where: "search",
      name: "Branch Code",
      value: opts.branch ?? null,
      labelledBy: [IDS.branchLabel],
      ...(opts.branchInvalid === true ? { invalid: true } : {}),
    }),
    node({ id: IDS.searchButton, role: "button", where: "search", name: "Search", text: "Search" }),
  ];
  if (opts.banner !== undefined) {
    nodes.push(
      node({ id: "alert:ctl00_alert_g_a9", role: "alert", where: "search", text: opts.banner }),
    );
  }
  return nodes;
};

/**
 * The second form the vendor's 8.3 release added.
 *
 * It has no Member ID field, so `role-name` still resolves the member field uniquely - but
 * `ordinal-in-container` now names a textbox in each of two forms and abstains, which strips that
 * one target down to two CORRELATED descriptors and nothing else. Its submit control is a LINK
 * rather than a button, deliberately: the point of the scenario is that a target fails on the
 * INDEPENDENCE of its evidence and not on the count of it, and a second button would make the
 * search button fail on the count instead - which would hide the case the scenario is about.
 */
const quickNodes: readonly ReturnType<typeof node>[] = [
  node({ id: IDS.quickField, role: "textbox", where: "quick", name: "Account Number" }),
  node({ id: IDS.quickButton, role: "link", where: "quick", name: "Go", text: "Go" }),
];

// ---------------------------------------------------------------------------------------------
// The results grid
// ---------------------------------------------------------------------------------------------

interface RowSpec {
  readonly rowIndex: number;
  readonly memberId: string;
  readonly name: string;
  readonly balance: string;
  /** The accessible name of the action link, or `null` for a row whose action column is empty. */
  readonly action: string | null;
  readonly linkId: NodeId;
}

const COLUMNS = ["Member ID", "Name", "Share Balance", "Status", "Action"] as const;

const rowNodes = (row: RowSpec): readonly ReturnType<typeof node>[] => {
  const cell = (colIndex: number, id: string, text: string, extra: Partial<NodeSpec> = {}) =>
    node({
      id,
      role: "cell",
      where: "results-row",
      text,
      table: { rowIndex: row.rowIndex, colIndex, colHeader: COLUMNS[colIndex] as string },
      ...extra,
    });
  const prefix = `ctl00_grd_r${row.rowIndex}`;
  const nodes = [
    cell(0, `cell:${prefix}_c0`, row.memberId),
    cell(1, `cell:${prefix}_c1`, row.name),
    cell(2, `cell:${prefix}_c2`, row.balance),
    cell(3, `cell:${prefix}_c3`, "Active"),
    cell(4, `cell:${prefix}_c4`, "", row.action === null ? {} : { children: [row.linkId] }),
  ];
  if (row.action !== null) {
    nodes.push(
      node({
        id: row.linkId,
        role: "link",
        where: "results-row",
        name: row.action,
        text: row.action,
        parent: `cell:${prefix}_c4`,
      }),
    );
  }
  return nodes;
};

const banner = (text: string) =>
  node({ id: IDS.resultsBanner, role: "status", where: "results", text });

const ROW_50001: RowSpec = {
  rowIndex: 0,
  memberId: MEMBER_ID,
  name: "Dale Rivera",
  balance: "1,204.55",
  action: "Open",
  linkId: IDS.openLink,
};

// ---------------------------------------------------------------------------------------------
// The member detail screen
// ---------------------------------------------------------------------------------------------

const detailNodes = (opts: {
  readonly memberId: string;
  readonly name: string;
  readonly balance: string;
  readonly alert?: string;
  /** The tab's own state, and the ONLY structural difference the share-position click makes.
   *  `skeletonDigestOf` hashes roles, names and state and deliberately not text, so a panel whose
   *  numbers changed and whose structure did not is - correctly - not a delta. */
  readonly sharesLoaded?: boolean;
}) => {
  const nodes = [
    node({
      id: IDS.detailHeading,
      role: "heading",
      where: "detail",
      name: `Member ${opts.memberId}`,
      text: `Member ${opts.memberId}`,
    }),
    node({ id: IDS.detailName, role: "text", where: "detail", text: opts.name }),
    node({
      id: IDS.sharesTab,
      role: "tab",
      where: "detail",
      name: "Share Position",
      text: "Share Position",
      selected: opts.sharesLoaded ?? false,
    }),
    node({ id: IDS.sharesStatus, role: "status", where: "detail", text: opts.balance }),
  ];
  if (opts.alert !== undefined) {
    nodes.push(
      node({ id: "alert:ctl00_alert_g_d9", role: "alert", where: "detail", text: opts.alert }),
    );
  }
  return nodes;
};

const notice = (label: string, id: NodeId) => [
  node({
    id: "heading:ctl00_hdg_g_m0",
    role: "heading",
    where: "dialog",
    name: "System Notice",
    text: "System Notice",
  }),
  node({ id, role: "button", where: "dialog", name: label, text: label }),
];

// ---------------------------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------------------------

const base: Record<string, Observation> = {
  blank: screen(0, { path: "/blank", nodes: [] }),

  // -- search -------------------------------------------------------------------------------
  search: screen(1, { path: "/teller/search", nodes: searchNodes({}) }),
  "search-member": screen(2, { path: "/teller/search", nodes: searchNodes({ member: MEMBER_ID }) }),
  "search-ready": screen(3, {
    path: "/teller/search",
    nodes: searchNodes({ member: MEMBER_ID, branch: "0042" }),
  }),
  /** Row 4: the app rejected a value the CALLER supplied. A legitimate typed answer. */
  "search-member-rejected": screen(4, {
    path: "/teller/search",
    nodes: searchNodes({
      member: "123",
      memberInvalid: true,
      banner: "Member ID must be exactly 5 digits.",
    }),
  }),
  /** Row 5: the SAME red banner, over a value baked into the artifact. No caller can fix it. */
  "search-branch-rejected": screen(5, {
    path: "/teller/search",
    nodes: searchNodes({
      member: MEMBER_ID,
      branch: "0042",
      branchInvalid: true,
      banner: "Branch code is not enabled for this teller station.",
    }),
  }),
  /** The vendor's 8.3 form, with the second panel that costs the target its third descriptor. */
  "search-two-forms": screen(6, {
    path: "/teller/search",
    nodes: [...searchNodes({ member: MEMBER_ID }), ...quickNodes],
  }),
  "search-two-forms-ready": screen(7, {
    path: "/teller/search",
    nodes: [...searchNodes({ member: MEMBER_ID, branch: "0042" }), ...quickNodes],
  }),

  // -- results ------------------------------------------------------------------------------
  results: screen(10, {
    path: "/teller/results",
    nodes: [banner("1 record found"), ...rowNodes(ROW_50001)],
  }),
  /**
   * THE SLOW-LOAD SHELL, and the single most important screen in this corpus.
   *
   * The grid frame is flushed with its banner before the rows exist, so for one or more polls the
   * page says "0 records found" and means "not yet". `settled: false` is the driver's own opinion;
   * band B0 is what makes the engine believe it rather than the banner.
   */
  "results-loading": screen(11, {
    path: "/teller/results",
    settled: false,
    nodes: [banner("0 records found")],
  }),
  /** Row 9 where a step can actually recover from it: the notice covers the FORM, so dismissing it
   *  and retrying the step finds the field exactly where it was. */
  "search-notice": screen(17, {
    path: "/teller/search",
    intercepted: true,
    nodes: [
      ...searchNodes({ member: MEMBER_ID, branch: "0042" }),
      ...notice("Acknowledge", IDS.noticeAck),
    ],
  }),
  /** The same notice one action later - after the search has already navigated. See the KNOWN GAP
   *  scenario: there is no legal resumption for this today. */
  "results-notice": screen(16, {
    path: "/teller/results",
    intercepted: true,
    nodes: [
      banner("1 record found"),
      ...rowNodes(ROW_50001),
      ...notice("Acknowledge", IDS.noticeAck),
    ],
  }),
  "results-empty": screen(12, {
    path: "/teller/results",
    nodes: [banner("No members matched that number.")],
  }),
  /** Two rows, and three descriptors that do not agree about which one is ours. */
  "results-two-rows": screen(13, {
    path: "/teller/results",
    nodes: [
      banner("2 records found"),
      ...rowNodes({
        rowIndex: 0,
        memberId: OTHER_MEMBER,
        name: "Kim Alvarez",
        balance: "88.10",
        action: "Open",
        linkId: IDS.otherLink,
      }),
      ...rowNodes({ ...ROW_50001, rowIndex: 1, name: "Dale Alvarez", action: "Open Account" }),
    ],
  }),
  /** W1: the core silently widened the search and returned somebody else's row. */
  "results-wrong-row": screen(14, {
    path: "/teller/results",
    nodes: [
      banner("1 record found"),
      ...rowNodes({
        rowIndex: 0,
        memberId: OTHER_MEMBER,
        name: "Kim Alvarez",
        balance: "88.10",
        action: "Open",
        linkId: IDS.openLink,
      }),
    ],
  }),
  /** The row is ours and the action column never rendered its link. */
  "results-no-link": screen(15, {
    path: "/teller/results",
    nodes: [banner("1 record found"), ...rowNodes({ ...ROW_50001, action: null })],
  }),

  // -- member detail ------------------------------------------------------------------------
  detail: screen(20, {
    path: "/teller/detail",
    nodes: detailNodes({ memberId: MEMBER_ID, name: "Dale Rivera", balance: "0.00" }),
  }),
  "detail-shares": screen(21, {
    path: "/teller/detail",
    nodes: detailNodes({
      memberId: MEMBER_ID,
      name: "Dale Rivera",
      balance: "1,204.55",
      sharesLoaded: true,
    }),
  }),
  /** The record the app took us to instead. Every control asserted true; only continuity knows. */
  "detail-other": screen(22, {
    path: "/teller/detail",
    nodes: detailNodes({ memberId: OTHER_MEMBER, name: "Kim Alvarez", balance: "0.00" }),
  }),
  "detail-other-shares": screen(23, {
    path: "/teller/detail",
    nodes: detailNodes({
      memberId: OTHER_MEMBER,
      name: "Kim Alvarez",
      balance: "88.10",
      sharesLoaded: true,
    }),
  }),
  /** Row 7: the denial is a property of the RECORD. A typed answer the caller can act on. */
  "detail-restricted": screen(24, {
    path: "/teller/detail",
    nodes: detailNodes({
      memberId: MEMBER_ID,
      name: "Dale Rivera",
      balance: "0.00",
      alert: "This member record is restricted. Refer to a member services specialist.",
    }),
  }),
  /** The restricted record still RENDERS - the flag is a notice, not a wall. That is what makes an
   *  engine which checks its checkpoint before its outcomes dangerous rather than merely wrong: the
   *  checkpoint passes, the flow continues, and a restricted member's balance is read out loud. */
  "detail-restricted-shares": screen(29, {
    path: "/teller/detail",
    nodes: detailNodes({
      memberId: MEMBER_ID,
      name: "Dale Rivera",
      balance: "1,204.55",
      sharesLoaded: true,
      alert: "This member record is restricted. Refer to a member services specialist.",
    }),
  }),
  /** Row 8: the denial is a property of the SESSION ROLE. It will fail identically forever. */
  "detail-role-denied": screen(25, {
    path: "/teller/detail",
    nodes: detailNodes({
      memberId: MEMBER_ID,
      name: "Dale Rivera",
      balance: "0.00",
      alert: "Your role is not entitled to function VIEW_SHARE_POSITION.",
    }),
  }),
  /** Row 9: an interstitial the artifact DECLARED. Budgeted, remediable, not a failure. */
  "detail-notice": screen(26, {
    path: "/teller/detail",
    intercepted: true,
    nodes: [
      ...detailNodes({ memberId: MEMBER_ID, name: "Dale Rivera", balance: "0.00" }),
      ...notice("Acknowledge", IDS.noticeAck),
    ],
  }),
  /** Row 10: an interstitial nobody declared. Answering it on a guess is how an automation clicks
   *  "Yes, delete" on behalf of a member, so it is a hard failure. */
  "detail-undeclared-notice": screen(27, {
    path: "/teller/detail",
    intercepted: true,
    nodes: [
      ...detailNodes({ memberId: MEMBER_ID, name: "Dale Rivera", balance: "0.00" }),
      ...notice("Continue anyway", IDS.noticeContinue),
    ],
  }),
  /** Rows 10/21: a NATIVE dialog. A separate observation channel that also blocks the renderer. */
  "detail-native-dialog": screen(28, {
    path: "/teller/detail",
    dialog: { type: "confirm", message: "Discard the interrupted batch?", defaultValue: null },
    nodes: detailNodes({ memberId: MEMBER_ID, name: "Dale Rivera", balance: "0.00" }),
  }),

  // -- environment --------------------------------------------------------------------------
  /** Rows 11-13. Every content route serves this until the broker re-authenticates. */
  signin: screen(30, {
    path: "/teller/signin",
    nodes: [
      node({
        id: "heading:ctl00_hdg_g_s1",
        role: "heading",
        where: "detail",
        name: "Sign in",
        text: "Sign in",
      }),
      node({
        id: "alert:ctl00_lbl_g_s2",
        role: "alert",
        where: "detail",
        text: "Your session has expired. Please sign in again.",
      }),
    ],
  }),
  /**
   * Row 16, and the screen the nearest-string-match mutant dies on.
   *
   * The prose is the vendor's, not ours: an ASP.NET unhandled-exception page naming the service
   * that fell over. It shares two of the three words in `MEMBER_NOT_FOUND`, which is precisely why
   * promoting an unmatched screen to the nearest declared outcome is a machine for telling a member
   * their account does not exist because a downstream service is down.
   */
  "app-error": screen(31, {
    path: "/teller/detail",
    nodes: [
      node({
        id: "alert:ctl00_err_g_e1",
        role: "alert",
        where: "detail",
        text: "Server Error in '/teller' Application. Unhandled exception: the member record service is not available.",
      }),
    ],
  }),
};

/**
 * The torn read: the grid frame after the banner painted and before the rows did.
 *
 * `tearObservation` leaves `stability` exactly as it was, which is the whole point - the driver
 * says settled and is wrong. Quiescence proposed; only the checkpoint disposes.
 */
base["results-torn"] = tearObservation(base.results as Observation, {
  keep: [IDS.resultsBanner],
});

export const screens: Readonly<Record<string, Observation>> = Object.freeze(base);
