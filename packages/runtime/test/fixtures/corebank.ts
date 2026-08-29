// The three documents for the acceptance flow, written against the REAL `fixtures/corebank-web`.
//
// PROVENANCE, SAID FIRST BECAUSE IT MATTERS. **This artifact was hand-authored for build unit 11's
// acceptance test. No model produced it.** `provenance.model` therefore says `adapter: "replay"`
// with a `modelId` that names no model and `transcriptRef: null`, because the honest options in
// that enum are "a provider produced this" and this one did not. The evidence bundle must never
// present a run of this artifact as a discovery run.
//
// THIS COMMENT USED TO PREDICT ITS OWN DELETION - "when discovery and synthesis land, the artifact
// they emit replaces this file". They landed, and it did not, and the prediction was wrong for a
// reason worth writing down. A synthesized artifact is the OUTPUT of a run and changes whenever the
// run is repeated; the acceptance suite needs an input it can pin, and `evidence/artifact/` needs
// to be the document those tests actually replay so the bundle cannot drift away from them. The
// artifact synthesis emitted from the live run is committed at `evidence/discovery-live/
// synthesized/artifact.json` and is replayed by `test/synthesized-replay.test.ts`. Two artifacts,
// two jobs, and neither pretends to be the other.
//
// ALL DATA IS SYNTHETIC. Nothing here carries a member number: the caller's argument is a typed
// parameter and the artifact stores its SHAPE. That is not tidiness - `test/redaction.test.ts`
// greps the sealed document for the value the tests pass in, and this file is the thing being
// grepped.
//
// Every matcher below was derived from a real `perceive()` over the fixture through
// `@crr/surface-browser`, not from reading the fixture's HTML. Where a number appears - a pixel
// distance, an ordinal - it came off a measured observation and the measurement is in the comment.

import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import {
  type CapabilityArtifact,
  type CapabilityContract,
  type ContainerMatcher,
  type NormalizerId,
  type Predicate,
  type RouteId,
  type StepId,
  type TargetRef,
  type TextMatcher,
  approveArtifact,
  sealArtifact,
  sealContract,
} from "@crr/core";
import type { Allowlist } from "@crr/core";

// ---------------------------------------------------------------------------------------------
// Small constructors, so the documents read like documents and not like casts
// ---------------------------------------------------------------------------------------------

const token = (t: string, normalize: NormalizerId = "std.label@1"): TextMatcher =>
  ({ mode: "token", token: t, normalize }) as TextMatcher;
const exact = (value: string, normalize: NormalizerId = "std.text@1"): TextMatcher =>
  ({ mode: "exact", value, normalize }) as TextMatcher;

/** The frameset's content pane. Measured: every content node's container path is
 *  `[frame top, frame content, ...]`, and `containerMatches` is a SUBSEQUENCE match, so naming the
 *  content frame alone is enough and survives a tenant that wraps it in one more landmark. */
const CONTENT = { kind: "frame", name: exact("content") } as const;
const SUBACCT_FRAME = { kind: "frame", name: exact("subacct") } as const;

/** The search form. Its accessible name is EMPTY on this product - there is no `<legend>` and no
 *  `aria-label` - so the landmark matcher names the role and nothing else. A matcher that demanded
 *  a name here would never match, which is the sort of thing you only find by perceiving the real
 *  screen. */
const contentForm: ContainerMatcher = {
  path: [CONTENT, { kind: "landmark", role: "form" }],
};
const contentPane: ContainerMatcher = { path: [CONTENT] };

const resultsGrid: ContainerMatcher = {
  path: [
    CONTENT,
    {
      kind: "table",
      headers: [token("member-column"), token("name-column"), token("status-column")],
    },
  ],
};

/** The member's existing shares. A NESTED IFRAME inside the content frame, so this container only
 *  exists once the driver has stitched an accessibility tree across two levels of framing. */
const shareGrid: ContainerMatcher = {
  path: [
    SUBACCT_FRAME,
    {
      kind: "table",
      headers: [
        token("subaccount-number-column"),
        token("subaccount-product-column"),
        token("balance-column"),
      ],
    },
  ],
};

const noticeDialog: ContainerMatcher = {
  path: [CONTENT, { kind: "landmark", role: "dialog", name: token("notice-dialog") }],
};

const settled: Predicate = { kind: "settled" };

// ---------------------------------------------------------------------------------------------
// The contract - what the calling agent sees. No detector, no frame name, no descriptor.
// ---------------------------------------------------------------------------------------------

export const sharePositionContract: CapabilityContract = sealContract({
  schemaVersion: "capability.contract/v1",
  name: "corebank.member.read_share_position",
  version: "1.0.0",
  title: "Read a member's share position",
  summary:
    "Looks a member up by member number, reports their name, total share balance and account status, lists their existing share accounts, and leaves the servicing session on the open-sub-account form for that member.",
  whenToUse: [
    "The member is asking what their share or savings balance is, or which share accounts they hold.",
    "A teller is about to open a sub-account and needs the member's current position first.",
  ],
  whenNotToUse: [
    "You do not have a member number. Identify the member first; this capability will not search by name.",
    "The member is asking about a loan, certificate or card balance - this reads share accounts only.",
    "You want to OPEN a sub-account. This capability stops at the form; opening one is a separate, approved, irreversible capability.",
  ],

  inputs: [
    {
      name: "memberId",
      type: { kind: "string", charset: "digits", minLength: 5, maxLength: 5 },
      required: true,
      description:
        "The member's member number, five digits, as printed on their card or statement.",
      sensitivity: "sensitive",
      constraints: { charset: "digits", minLength: 5, maxLength: 5 },
      discoveredFrom: { goalSpan: "member {memberId}" },
    },
  ],
  outputs: [
    {
      name: "memberName",
      type: { kind: "string" },
      required: true,
      description: "The member's name as the core system holds it.",
      sensitivity: "sensitive",
      agentDisclosure: "mask",
    },
    {
      name: "shareBalance",
      type: { kind: "money", currency: "USD" },
      required: true,
      description: "The member's total share balance.",
      sensitivity: "internal",
      agentDisclosure: "deliver",
    },
    {
      name: "accountStatus",
      type: { kind: "enum", values: ["ACTIVE", "DORMANT", "FROZEN", "RESTRICTED", "CLOSED"] },
      required: true,
      description: "The membership's status on the core system.",
      sensitivity: "internal",
      agentDisclosure: "deliver",
      example: "ACTIVE",
    },
    {
      name: "shareAccounts",
      // The column NAMES are matched against the grid's own headers after `std.text@1`, with no
      // vocabulary indirection - see the note in the artifact below. That is a real limitation and
      // it is recorded rather than worked around.
      type: {
        kind: "table",
        columns: [
          { name: "Acct", type: { kind: "string" } },
          { name: "Share Account", type: { kind: "string" } },
          { name: "Share Balance", type: { kind: "string" } },
          { name: "Opened", type: { kind: "string" } },
        ],
      },
      required: true,
      description: "The member's existing share accounts, one row each.",
      sensitivity: "internal",
      agentDisclosure: "deliver",
    },
  ],
  outcomes: [
    {
      code: "MEMBER_NOT_FOUND",
      kind: "business_outcome",
      title: "No member with that number",
      summary: "The core system holds no member with the number supplied.",
      terminal: true,
      payload: [],
      // The rule from OPEN-QUESTIONS-RESOLVED Q1: an outcome is a fact about the request or the
      // record that will still be true on the next attempt. This one is. A session timeout is not,
      // which is why that is a failure and this is an answer.
      stableUnderRetry: true,
      callerAction: "retry-different-input",
      retryable: "with_different_inputs",
      agentGuidance:
        "Tell the member that number is not on file and ask them to read it again from their card or statement. Do not guess a different number on their behalf.",
    },
  ],

  effect: "READ",
  requiresApproval: false,
  idempotent: true,
});

// ---------------------------------------------------------------------------------------------
// Targets
//
// Not one of these is a selector, and not one of them could be. This product has NO test ids, NO
// `data-*` attributes and NO `<label for>`, and its generated element ids differ per tenant
// (`ctl00_ctl32_g_9a1_txtMemberId` at one, `ctl00_ctl41_g_c7e2_txtMbrNo` at the next). Measured
// consequence: the search fields have NO accessible name at all, so `role-name` - rank 1, the
// descriptor you would reach for first - is unusable on them and the quorum is built from a label
// anchor and an ordinal instead.
// ---------------------------------------------------------------------------------------------

const QUORUM = {
  min: 2,
  distinctEvidenceSources: 2,
  requireIdentical: true,
  onUnderQuorum: "fail",
  expectUnique: true,
} as const;

const memberIdField: TargetRef = {
  scope: contentForm,
  role: "textbox",
  descriptors: [
    {
      // "the box next to Member ID". Measured on the real screen: the label's right edge is at
      // x=255 and this field starts at x=263, a gap of 8px; the NEXT field along (Last Name) starts
      // at x=447, a gap of 192px. 60px separates them with room for a font difference and no room
      // for the wrong field.
      id: "member-id-right-of-label",
      kind: "label-anchored",
      evidenceSource: "labelText",
      label: token("member-id-label"),
      role: "textbox",
      relation: "right-of",
      maxDistance: { unit: "px", value: 60 },
    },
    {
      id: "member-id-first-in-form",
      kind: "ordinal-in-container",
      evidenceSource: "ordinal",
      container: contentForm,
      role: "textbox",
      index: 0,
    },
  ],
  quorum: QUORUM,
  assert: { role: "textbox", enabled: true, visible: true },
  recordedNode: {
    ariaRole: "textbox",
    name: "",
    containerPath: [
      { kind: "frame", name: "top" },
      { kind: "frame", name: "content" },
      { kind: "landmark", role: "form", name: null },
    ],
    tablePosition: null,
    boundsBucket: "px:12x2",
  },
};

const searchButton: TargetRef = {
  scope: contentForm,
  role: "button",
  descriptors: [
    {
      id: "search-by-name",
      kind: "role-name",
      evidenceSource: "accessibleName",
      role: "button",
      name: token("search-button"),
    },
    {
      // A second, INDEPENDENTLY SOURCED opinion. If the vendor renames the button this one still
      // resolves and the disagreement is loud, which is the whole point of a quorum over a fallback
      // chain. Measured: the member-id field's right edge is x=360 and the button starts at x=602.
      id: "search-right-of-member-id",
      kind: "geometric",
      evidenceSource: "geometry",
      anchor: {
        id: "search-anchor-member-id",
        kind: "label-anchored",
        evidenceSource: "labelText",
        label: token("member-id-label"),
        role: "textbox",
        relation: "right-of",
        maxDistance: { unit: "px", value: 60 },
      },
      role: "button",
      direction: "right-of",
      maxDistance: { unit: "px", value: 300 },
    },
  ],
  quorum: QUORUM,
  assert: { role: "button", enabled: true, visible: true },
  recordedNode: {
    ariaRole: "button",
    name: "Search",
    containerPath: [
      { kind: "frame", name: "top" },
      { kind: "frame", name: "content" },
      { kind: "landmark", role: "form", name: null },
    ],
    tablePosition: null,
    boundsBucket: "px:7x2",
  },
};

/** Control C1 in one object: the row is selected BY the member number the caller asked about, so
 *  there is no arrangement of the results grid that lets this open the wrong member's record. The
 *  fixture's other tenant prepends a radio column and shifts every column INDEX by one; addressing
 *  the row by its Member ID cell is what makes that difference cost nothing. */
const openRowLink: TargetRef = {
  scope: resultsGrid,
  role: "link",
  descriptors: [
    {
      id: "open-by-row-key",
      kind: "table-cell",
      evidenceSource: "columnHeader",
      table: resultsGrid,
      rowKey: { columnHeader: token("member-column"), value: { from: "param", param: "memberId" } },
      columnHeader: token("action-column"),
      childRole: "link",
      // This grid has no `<th>`, no `scope=` and no `<caption>`: the driver read the headers off
      // row zero and SAYS SO. A guess that was never labelled as one cannot be corrected by an
      // overlay, and a guess that changed is worth a person's attention.
      headerProvenance: "first-row-heuristic",
    },
    {
      id: "open-by-link-text",
      kind: "role-name",
      evidenceSource: "accessibleName",
      role: "link",
      name: token("open-row-link"),
    },
  ],
  quorum: QUORUM,
  assert: {
    role: "link",
    rowKeyEquals: {
      columnHeader: token("member-column"),
      value: { from: "param", param: "memberId" },
    },
  },
  recordedNode: {
    ariaRole: "link",
    name: "Open",
    containerPath: [
      { kind: "frame", name: "top" },
      { kind: "frame", name: "content" },
      { kind: "landmark", role: "form", name: null },
      { kind: "table", headers: ["Member ID", "Name", "Share Balance", "Status", "Action"] },
    ],
    tablePosition: { rowHeader: null, colHeader: "Action" },
    boundsBucket: "px:5x2",
  },
};

const openSubAccountButton: TargetRef = {
  scope: contentForm,
  role: "button",
  descriptors: [
    {
      id: "open-subaccount-by-name",
      kind: "role-name",
      evidenceSource: "accessibleName",
      role: "button",
      name: token("open-subaccount-button"),
    },
    {
      id: "open-subaccount-only-control",
      kind: "ordinal-in-container",
      evidenceSource: "ordinal",
      container: contentForm,
      role: "button",
      index: 0,
    },
  ],
  quorum: QUORUM,
  assert: { role: "button", enabled: true, visible: true },
  recordedNode: {
    ariaRole: "button",
    name: "Open Sub-Account",
    containerPath: [
      { kind: "frame", name: "top" },
      { kind: "frame", name: "content" },
      { kind: "landmark", role: "form", name: null },
    ],
    tablePosition: null,
    boundsBucket: "px:16x2",
  },
};

const noticeAcknowledgeButton: TargetRef = {
  scope: noticeDialog,
  role: "button",
  descriptors: [
    {
      id: "notice-ack-by-name",
      kind: "role-name",
      evidenceSource: "accessibleName",
      role: "button",
      name: token("notice-dismiss-button"),
    },
    {
      id: "notice-ack-only-control",
      kind: "ordinal-in-container",
      evidenceSource: "ordinal",
      container: noticeDialog,
      role: "button",
      index: 0,
    },
  ],
  quorum: QUORUM,
  assert: { role: "button", enabled: true, visible: true },
  recordedNode: {
    ariaRole: "button",
    name: "Acknowledge",
    containerPath: [
      { kind: "frame", name: "top" },
      { kind: "frame", name: "content" },
      { kind: "landmark", role: "dialog", name: "System Notice" },
    ],
    tablePosition: null,
    boundsBucket: "px:11x2",
  },
};

// ---------------------------------------------------------------------------------------------
// The program
// ---------------------------------------------------------------------------------------------

const SETTLE = { stableSamples: 2, pollIntervalMs: 120, maxWaitMs: 8_000 } as const;
/** Every step can spend a remediation. A step with `maxRemediationCycles: 0` can never recover, so
 *  an ambient rule that fires there returns `recovery-exhausted` immediately - which makes the
 *  flow's ambient rules inert on exactly the steps you wanted them for. */
const BUDGETS = { perRecoveryMaxAttempts: {}, maxRemediationCycles: 2 } as const;

const ROUTES = {
  search: "member-search" as RouteId,
  results: "member-results" as RouteId,
  detail: "member-detail" as RouteId,
  newSub: "subaccount-new" as RouteId,
};

const unsealed = {
  schemaVersion: "capability.artifact/v1",
  artifactId: "corebank-member-share-position-web",
  implements: {
    name: sharePositionContract.name,
    version: sharePositionContract.version,
    contractDigest: sharePositionContract.digest,
  },
  version: 1,

  target: {
    product: "CoreBank Servicing",
    productVersionRange: ">=8.0 <9.0",
    surfaceKind: "web-legacy",
    requires: ["accessibility-tree", "table-position", "containers", "geometry", "route"],
    sessionProfile: "corebank-teller",
  },

  lifecycle: { status: "draft", supersedes: null, approval: null },

  flow: {
    entry: {
      route: ROUTES.search,
      precondition: { kind: "route-matches", route: ROUTES.search } as Predicate,
    },
    routes: [
      { id: ROUTES.search, originAlias: "corebank", path: "/search", frame: "content" },
      {
        id: ROUTES.results,
        originAlias: "corebank",
        path: "/search/results",
        // NO query constraint, and the reason is the fixture being honest about what a WebForms
        // postback looks like: the search form submits `ctl00$ctl32$g$9a1$txtMemberId=10041`, and
        // the generated control name differs at the other tenant. Pinning the query would be
        // storing a tenant's markup detail in the base artifact - exactly the mistake this design
        // refuses - so "we are on THE results page for the member we were asked about" is carried
        // by the `subjectMember` continuity check inside the grid instead, which reads the screen
        // rather than the URL and works at both tenants.
        frame: "content",
      },
      { id: ROUTES.detail, originAlias: "corebank", path: "/member/:memberId", frame: "content" },
      {
        id: ROUTES.newSub,
        originAlias: "corebank",
        path: "/member/:memberId/subaccount/new",
        frame: "content",
      },
    ],

    // THE MULTI-TENANT HINGE. Declared once, referenced by token from every descriptor, detector,
    // row key, checkpoint and table read below.
    //
    // EVERY SYNONYM HERE IS A WORD THAT WAS ON RIVERBEND'S SCREEN, and that is the whole design.
    // The obvious alternative - listing the other tenant's wording here too, so the base matches
    // both - is `oneOf` widening, and SPEC section 9.3 rejects it for a reason that only shows up
    // at the tenth tenant rather than the second: discrimination degrades MONOTONICALLY as tenants
    // are added. A base that has learned to accept "Member ID", "Member Number", "Member #" and
    // "Mbr No" will happily match a field labelled "Member Number" on a screen where the field this
    // step wanted was labelled "Member ID", and it will do so silently. The overlay replaces a
    // token's list WHOLESALE precisely so that each tenant's matcher stays exactly as narrow as the
    // screen it runs against.
    //
    // Summit's dialect therefore lives in `corebank-summit.ts`, not here. Twelve of these twenty-one
    // tokens are replaced there; the other nine are identical across both tenants and are the
    // evidence for SPEC section 9.4's point that not every per-tenant difference needs an overlay.
    vocabulary: {
      "member-id-label": ["Member ID"],
      "search-button": ["Search"],
      "member-column": ["Member ID"],
      "name-column": ["Name"],
      "balance-column": ["Share Balance"],
      "status-column": ["Status"],
      "action-column": ["Action"],
      // Identical at both tenants. An artifact step that says `activate the link named Open` needs
      // no overlay at all, which is the cheapest per-tenant difference there is: none.
      "open-row-link": ["Open"],
      "member-detail-heading": ["Member Detail"],
      "subaccount-list-heading": ["Share Accounts"],
      "subaccount-number-column": ["Acct"],
      "subaccount-product-column": ["Share Account"],
      "subaccount-opened-column": ["Opened"],
      "open-subaccount-button": ["Open Sub-Account"],
      "subaccount-type-label": ["Sub-Account Type"],
      "initial-deposit-label": ["Initial Deposit"],
      // The four below are printed by the vendor's own framework rather than by the tenant's
      // configuration, so they are the same string at every deployment of this product. They are
      // still tokens, because "it is the same today" is not a reason to make it un-retargetable.
      "not-found-banner": ["No members matched the search criteria"],
      "session-expired-banner": ["Your session has ended due to inactivity"],
      "app-error-banner": ["Server Error in", "unhandled exception occurred"],
      "notice-dialog": ["System Notice"],
      "notice-dismiss-button": ["Acknowledge", "OK"],
    },

    resumePoints: ["open-search" as StepId],

    steps: [
      // ---- 1 -----------------------------------------------------------------------------------
      {
        id: "open-search" as StepId,
        title: "Open the member search screen",
        intent: "Get to the search form so a member number can be entered.",
        effect: "READ",
        instruction: { kind: "navigate", route: ROUTES.search },
        target: null,
        precondition: null,
        settle: SETTLE,
        expect: {
          predicate: {
            all: [
              settled,
              { kind: "route-matches", route: ROUTES.search },
              { kind: "count", where: { scope: contentForm, role: "textbox" }, op: "gte", n: 2 },
            ],
          } as Predicate,
          // SPEC section 3's instruction table gives `navigate` the postcondition "location matches
          // the declared route AND expect" - and pointedly NOT `delta`, which it requires only of
          // `activate` and `pressKey`. That is not an oversight: this flow's entry route is where a
          // brokered session already lands, so a navigate to it legitimately changes nothing, and
          // `mustChange: true` here fails a step that did exactly what it was asked to do.
          // `navigatedTo` is the real postcondition and it is asserted.
          delta: { mustChange: false, navigatedTo: ROUTES.search },
          continuity: [],
        },
        outcomes: [],
        recoveries: [],
        extract: [],
        budgets: BUDGETS,
        evidence: { captureOn: ["failure"] },
      },
      // ---- 2 -----------------------------------------------------------------------------------
      {
        id: "enter-member-id" as StepId,
        title: "Type the member number into the search box",
        intent: "Put the caller's member number in the field the search reads from.",
        effect: "READ",
        instruction: { kind: "fill", value: { from: "param", param: "memberId" }, mode: "replace" },
        target: memberIdField,
        precondition: {
          kind: "node-state",
          where: { scope: contentForm, role: "textbox", state: { readonly: false } },
          state: "readonly",
          equals: false,
        } as Predicate,
        settle: SETTLE,
        // The field carries `maxlength="5"`. A legacy input with a length limit silently truncates
        // what you typed and then produces "no member found" for a member who exists, so the value
        // is read back and compared - which is what makes this instruction worth its own step.
        // The read-back that catches a `maxlength` truncation is NOT written here, and that is
        // deliberate. Both search fields are unnamed textboxes on this product, so no `NodeQuery`
        // can name the one this step filled - a `value-matches` scoped to the form asserts about
        // BOTH of them and fails on the empty one. The value the field ends up holding is the
        // OPCODE's postcondition (SPEC section 3's table), the interpreter re-resolves this step's
        // own target to check it, and `src/postcondition.ts` is where it lives.
        expect: {
          predicate: {
            all: [
              settled,
              { kind: "count", where: { scope: contentForm, role: "textbox" }, op: "gte", n: 2 },
            ],
          } as Predicate,
          // Also no delta, and for a sharper reason than the navigate above: `skeletonDigest` is
          // taken over role, name, container path and STATE, deliberately excluding `value` - so a
          // field's contents changing is invisible to it by design. `fill`'s real postcondition is
          // the read-back above, which is exactly what catches the `maxlength="5"` truncation this
          // step exists to catch.
          delta: { mustChange: false },
          continuity: [],
        },
        outcomes: [],
        recoveries: [],
        extract: [],
        budgets: BUDGETS,
        evidence: { captureOn: ["failure"] },
      },
      // ---- 3 -----------------------------------------------------------------------------------
      {
        id: "submit-search" as StepId,
        title: "Run the search",
        intent: "Submit the search form and wait for the results grid.",
        effect: "READ",
        instruction: { kind: "activate" },
        target: searchButton,
        precondition: {
          kind: "node-state",
          where: { scope: contentForm, role: "button", name: token("search-button") },
          state: "disabled",
          equals: false,
        } as Predicate,
        settle: { ...SETTLE, maxWaitMs: 12_000 },
        expect: {
          predicate: {
            all: [
              settled,
              { kind: "route-matches", route: ROUTES.results },
              { kind: "count", where: { scope: resultsGrid, role: "row" }, op: "gte", n: 2 },
              { kind: "continuity", ref: "subjectMember", scope: resultsGrid },
            ],
          } as Predicate,
          delta: { mustChange: true, navigatedTo: ROUTES.results },
          continuity: ["subjectMember"],
        },
        outcomes: [
          {
            code: "MEMBER_NOT_FOUND",
            // Declared, never inferred. "The grid looks empty" is not a detector: an expired-session
            // screen has an empty results-shaped table on it too, which is exactly the trap the
            // fixture sets on purpose and exactly why band B1 runs before this one.
            detect: {
              kind: "text-present",
              scope: contentPane,
              text: token("not-found-banner"),
            } as Predicate,
            priority: 10,
            phase: "post",
            requiresSettled: true,
            capture: [],
          },
        ],
        recoveries: [],
        extract: [],
        budgets: BUDGETS,
        evidence: { captureOn: ["failure", "outcome"] },
      },
      // ---- 4 -----------------------------------------------------------------------------------
      {
        id: "read-member-summary" as StepId,
        title: "Read the member's summary from the results grid",
        intent:
          "Read the member's name, total share balance and status off the row we searched for.",
        effect: "READ",
        instruction: { kind: "read" },
        target: null,
        precondition: { kind: "route-matches", route: ROUTES.results } as Predicate,
        settle: SETTLE,
        expect: {
          predicate: {
            all: [settled, { kind: "continuity", ref: "subjectMember", scope: resultsGrid }],
          } as Predicate,
          // A read dispatches nothing, so nothing is expected to change. This is the one place
          // `mustChange: false` is correct, and it is why the field is a boolean rather than an
          // engine constant.
          delta: { mustChange: false },
          continuity: ["subjectMember"],
        },
        outcomes: [],
        recoveries: [],
        extract: [
          // Row-and-column addressing keyed by the caller's OWN value. Without it this degrades to
          // "some cell in this grid", which is how one member's balance gets read out to another.
          {
            output: "memberName",
            from: "cell@1",
            where: {
              cell: {
                table: resultsGrid,
                rowKey: {
                  columnHeader: token("member-column"),
                  value: { from: "param", param: "memberId" },
                },
                columnHeader: token("name-column"),
              },
            },
            parse: "string@1",
            // `std.identity@1` and not `std.text@1`, because this value is DELIVERED rather than
            // COMPARED. `std.text@1` case-folds - which is exactly right for matching a label
            // against a screen and exactly wrong for a member's name, which a caller is going to
            // read back to them.
            normalize: "std.identity@1",
            onMissing: "fail",
          },
          {
            output: "shareBalance",
            from: "cell@1",
            where: {
              cell: {
                table: resultsGrid,
                rowKey: {
                  columnHeader: token("member-column"),
                  value: { from: "param", param: "memberId" },
                },
                columnHeader: token("balance-column"),
              },
            },
            parse: "moneyUSD@1",
            normalize: "std.money@1",
            onMissing: "fail",
          },
          {
            output: "accountStatus",
            from: "cell@1",
            where: {
              cell: {
                table: resultsGrid,
                rowKey: {
                  columnHeader: token("member-column"),
                  value: { from: "param", param: "memberId" },
                },
                columnHeader: token("status-column"),
              },
            },
            parse: "enum@1",
            normalize: "std.text@1",
            onMissing: "fail",
          },
        ],
        budgets: BUDGETS,
        evidence: { captureOn: ["failure"] },
      },
      // ---- 5 -----------------------------------------------------------------------------------
      {
        id: "open-member-record" as StepId,
        title: "Open the matching member's record",
        intent: "Follow the row whose member number is the one we were asked about.",
        effect: "READ",
        instruction: { kind: "activate" },
        target: openRowLink,
        precondition: {
          kind: "count",
          where: { scope: resultsGrid, role: "row" },
          op: "gte",
          n: 2,
        } as Predicate,
        settle: { ...SETTLE, maxWaitMs: 12_000 },
        // Not "a member detail page loaded" but "THE member detail page for the member we were
        // asked about". This is what catches the app's own search silently correcting the id.
        expect: {
          predicate: {
            all: [
              settled,
              { kind: "route-matches", route: ROUTES.detail },
              { kind: "text-present", scope: contentPane, text: token("member-detail-heading") },
              { kind: "continuity", ref: "subjectMember", scope: contentPane },
            ],
          } as Predicate,
          delta: { mustChange: true, navigatedTo: ROUTES.detail },
          continuity: ["subjectMember"],
        },
        outcomes: [],
        recoveries: [],
        extract: [],
        budgets: BUDGETS,
        evidence: { captureOn: ["failure"] },
      },
      // ---- 6 -----------------------------------------------------------------------------------
      {
        id: "verify-member-record" as StepId,
        title: "Confirm we are on the right member's record",
        intent:
          "Re-observe the detail screen and check the subject is still the member we were asked about before anything is read from it.",
        effect: "READ",
        instruction: { kind: "assert" },
        target: null,
        precondition: { kind: "route-matches", route: ROUTES.detail } as Predicate,
        settle: SETTLE,
        expect: {
          predicate: {
            all: [
              settled,
              { kind: "continuity", ref: "subjectMember", scope: contentPane },
              { kind: "count", where: { scope: shareGrid, role: "row" }, op: "gte", n: 1 },
            ],
          } as Predicate,
          delta: { mustChange: false },
          continuity: ["subjectMember"],
        },
        outcomes: [],
        recoveries: [],
        extract: [],
        budgets: BUDGETS,
        evidence: { captureOn: ["failure"] },
      },
      // ---- 7 -----------------------------------------------------------------------------------
      {
        id: "read-share-accounts" as StepId,
        title: "List the member's existing share accounts",
        intent: "Read the share-account grid in the nested frame, bounded.",
        effect: "READ",
        instruction: { kind: "readTable" },
        target: null,
        precondition: { kind: "route-matches", route: ROUTES.detail } as Predicate,
        settle: SETTLE,
        expect: {
          predicate: {
            all: [
              settled,
              { kind: "count", where: { scope: shareGrid, role: "row" }, op: "gte", n: 1 },
            ],
          } as Predicate,
          delta: { mustChange: false },
          continuity: [],
        },
        outcomes: [],
        recoveries: [],
        extract: [
          {
            output: "shareAccounts",
            from: "cell@1",
            where: { scope: shareGrid, role: "cell" },
            parse: "string@1",
            // Delivered, not compared - see `memberName` above.
            normalize: "std.identity@1",
            onMissing: "fail",
            // THE CONTRACT'S COLUMN NAMES ARE THE CALLER'S FIELD NAMES, NOT THE SCREEN'S HEADERS.
            //
            // `shareAccounts` is declared as a table of `Acct | Share Account | Share Balance |
            // Opened`, and those four strings are what a generated TypeScript row type is keyed by
            // at every tenant. Without this map they would ALSO be matched directly against the
            // strings this grid prints, which quietly puts surface vocabulary on the contract and
            // makes the read tenant-specific: summit's grid is headed `Savings Account` and
            // `Savings Balance`, so the read fails there with `missing-column` and no overlay can
            // reach it, because an overlay may not touch a contract. Build unit 19 found exactly
            // that, against the real fixture, with every other step already replaying green.
            //
            // With the map, the surface half is a `TextMatcher` like everything else in this
            // document, the token resolves through `flow.vocabulary`, and summit's overlay fixes it
            // in the same two lines that fix the results grid. `Acct` and `Opened` are tokens too
            // even though both tenants print them identically - see the note on the invariant
            // banners above.
            columnHeaders: {
              Acct: token("subaccount-number-column"),
              "Share Account": token("subaccount-product-column"),
              "Share Balance": token("balance-column"),
              Opened: token("subaccount-opened-column"),
            },
            // Bounded iteration, and the reason `readTable` is allowed at all: an Observation holds
            // finitely many nodes, this walks that finite set once, and `onTruncate` has exactly one
            // legal value - reading nine of a member's ten shares and reporting them as ten is a
            // wrong answer that looks like a right one.
            rows: { minRows: 1, maxRows: 25, onTruncate: "fail" },
          },
        ],
        budgets: BUDGETS,
        evidence: { captureOn: ["failure"] },
      },
      // ---- 8 -----------------------------------------------------------------------------------
      {
        id: "open-subaccount-form" as StepId,
        title: "Open the sub-account form for this member",
        intent:
          "Leave the servicing session on the open-sub-account form for this member, so a teller can complete the write.",
        // A GET that renders a form and writes nothing. Declared READ, and the linker re-derives it:
        // an `activate` proves nothing about effect on its own, which is SPEC 8.2's accepted limit
        // and the reason `effect` is declared rather than inferred.
        effect: "READ",
        instruction: { kind: "activate" },
        target: openSubAccountButton,
        precondition: { kind: "route-matches", route: ROUTES.detail } as Predicate,
        settle: { ...SETTLE, maxWaitMs: 12_000 },
        expect: {
          predicate: {
            all: [
              settled,
              { kind: "route-matches", route: ROUTES.newSub },
              { kind: "continuity", ref: "subjectMember", scope: contentPane },
            ],
          } as Predicate,
          delta: { mustChange: true, navigatedTo: ROUTES.newSub },
          continuity: ["subjectMember"],
        },
        outcomes: [],
        recoveries: [],
        extract: [],
        budgets: BUDGETS,
        evidence: { captureOn: ["failure"] },
      },
      // ---- 9 -----------------------------------------------------------------------------------
      {
        id: "confirm-form-ready" as StepId,
        title: "Confirm the sub-account form is ready for the teller",
        intent:
          "Check the product list and the deposit field are present and usable before handing the session over.",
        effect: "READ",
        instruction: { kind: "assert" },
        target: null,
        precondition: { kind: "route-matches", route: ROUTES.newSub } as Predicate,
        settle: SETTLE,
        expect: {
          predicate: {
            all: [
              settled,
              { kind: "text-present", scope: contentPane, text: token("subaccount-type-label") },
              { kind: "text-present", scope: contentPane, text: token("initial-deposit-label") },
              {
                kind: "node-state",
                where: { scope: contentForm, role: "combobox" },
                state: "disabled",
                equals: false,
              },
              { kind: "continuity", ref: "subjectMember", scope: contentPane },
            ],
          } as Predicate,
          delta: { mustChange: false },
          continuity: ["subjectMember"],
        },
        outcomes: [],
        recoveries: [],
        extract: [],
        budgets: BUDGETS,
        evidence: { captureOn: ["failure"] },
      },
    ],

    ambient: [
      {
        // SPEC 4.2 row 16. An application error page is an ENVIRONMENT fact, so it is classified
        // before any declared business outcome - a 500 whose content region happens to be empty
        // must never be read as "no member found".
        name: "APP_ERROR_PAGE",
        band: "environment",
        detect: {
          kind: "text-present",
          scope: contentPane,
          text: token("app-error-banner"),
        } as Predicate,
        priority: 10,
        phase: "both",
        // Anything that is not `reauthenticate` and not `escalate` classifies as `app-error` when
        // it becomes terminal. The remedy is the only honest one available to a program that may not
        // log in and may not click on a stack trace: go back to the entry route and start over.
        remedy: { kind: "actions", instructions: [{ kind: "navigate", route: ROUTES.search }] },
        maxAttempts: 1,
        // An error page is WHY the surface will never settle, so this detector has to be allowed to
        // fire against an unsettled screen. Only an environment band may say so.
        allowUnsettled: true,
        afterRemedy: "reverify",
        // Row 16's one concession: a restart is permitted because this run's maxEffect is READ.
        // `restartSafeUpToPc` and the program-attempt ledger bound it; when either refuses, the
        // verdict is the hard failure `app-error` rather than another attempt.
        resume: "restart-program",
      },
      {
        name: "SESSION_EXPIRED",
        band: "environment",
        detect: {
          kind: "text-present",
          scope: contentPane,
          text: token("session-expired-banner"),
        } as Predicate,
        priority: 20,
        phase: "both",
        // Delegated to the session broker: the program never logs in, so there is no place in this
        // document where a credential could be written down even by accident.
        remedy: { kind: "reauthenticate" },
        maxAttempts: 1,
        allowUnsettled: true,
        afterRemedy: "reverify",
        resume: "restart-program",
      },
      {
        // The fixture raises this with the SAME widget it uses for the confirmation step, on
        // purpose: a replay engine may not classify a modal by "a modal is showing", it has to match
        // a DECLARED identity and treat anything else as `undeclared-dialog`.
        name: "DISMISS_SYSTEM_NOTICE",
        band: "interception",
        detect: {
          kind: "node-exists",
          where: { scope: noticeDialog, role: "button", name: token("notice-dismiss-button") },
        } as Predicate,
        priority: 30,
        phase: "both",
        remedy: {
          kind: "actions",
          instructions: [{ kind: "activate", target: noticeAcknowledgeButton }],
        },
        maxAttempts: 2,
        allowUnsettled: false,
        afterRemedy: "reverify",
        // NOT `retry-step`. The notice is dismissed in place, so re-running the step that raised it
        // would re-dispatch an action whose effect is already on screen - and for an idempotent
        // search that produces an identical skeleton digest, which the delta assertion correctly
        // reports as `no-observable-effect`. Resuming from the declared entry point re-walks the
        // flow from a state the checkpoints can all be met from.
        resume: "restart-from-checkpoint",
        resumeAt: "open-search" as StepId,
      },
    ],
  },

  continuity: [
    {
      id: "subjectMember",
      source: { from: "param", param: "memberId" },
      // Normalized rather than identity: "10041" in the search box and "Member ID 10041" in the
      // detail table are the same subject, and an equality check would say otherwise.
      compare: { via: "std.text@1", type: { kind: "string", charset: "digits" } },
    },
  ],

  provenance: {
    discoveryRunId: "run-unit11-hand-authored",
    goalTemplate:
      "look up member {memberId} in the back office, read their share position, and open the sub-account form for them",
    model: {
      // NOT a discovery run. See the header of this file: this artifact was hand-authored for the
      // interpreter's acceptance test and `replay` is the only value in this enum that does not
      // claim a live provider produced it.
      adapter: "replay",
      modelId: "none:hand-authored-for-unit-11",
      promptVersion: "n/a",
    },
    transcriptRef: null,
    recordedAt: "2026-02-11T14:03:22.000Z",
    recordedAgainst: {
      tenantId: "riverbend",
      appInstanceId: "riverbend-corebank-fixture",
      fingerprint: {
        perStep: {
          "open-search": "fp:search",
          "enter-member-id": "fp:search",
          "submit-search": "fp:results",
          "read-member-summary": "fp:results",
          "open-member-record": "fp:results",
          "verify-member-record": "fp:detail",
          "read-share-accounts": "fp:detail",
          "open-subaccount-form": "fp:detail",
          "confirm-form-ready": "fp:newsub",
        },
      },
    },
  },

  verification: {
    mode: "replay-full",
    status: "verified",
    coveredThroughStep: "confirm-form-ready" as StepId,
    grade: "full",
    runId: "run-unit11-verify",
    at: "2026-02-11T14:05:41.000Z",
  },

  policy: {
    originAliases: ["corebank"],
    maxEffect: "READ",
    requiresApprovalToken: false,
    redaction: { taintedParams: ["memberId"], maskScreenshotRegions: true },
  },

  effects: {
    maxEffect: "READ",
    irreversibleSteps: [],
    routesTouched: [ROUTES.search, ROUTES.results, ROUTES.detail, ROUTES.newSub],
    reads: [
      { field: "memberName", sensitivity: "sensitive" },
      { field: "shareBalance", sensitivity: "internal" },
      { field: "accountStatus", sensitivity: "internal" },
      { field: "shareAccounts", sensitivity: "internal" },
    ],
    requiresApproval: false,
    restartSafeUpToPc: 9,
  },

  budgets: {
    maxActions: 40,
    maxObservations: 400,
    maxTotalRemediations: 6,
    // One restart. The app-error scenario spends it and the SECOND occurrence is the hard failure,
    // which is the whole point: a bounded recovery that stops being a recovery.
    maxProgramAttempts: 1,
    deadlineMs: 180_000,
  },

  signatures: [],
};

export const sharePositionDraft: CapabilityArtifact = sealArtifact(unsealed);

// ---------------------------------------------------------------------------------------------
// A real ed25519 approval, over the real digest
// ---------------------------------------------------------------------------------------------
//
// Generated per process rather than committed. A private key in a repository is a private key on
// the internet, and the property under test is "the runtime verifies a signature over the digest",
// which a fresh key proves as well as a stored one and a stored one would additionally teach the
// wrong lesson.

const APPROVER = generateKeyPairSync("ed25519");

export const APPROVER_KEY_ID = "ops-approval-key-1";

/** The public half, SPKI DER, as `ed25519Trust` takes it. */
export const approverPublicKey: Uint8Array = new Uint8Array(
  APPROVER.publicKey.export({ format: "der", type: "spki" }),
);

export const sharePositionArtifact: CapabilityArtifact = approveArtifact(sharePositionDraft, {
  // An identity handle, not a person's mailbox. "Who approved this" is an audit answer the identity
  // system resolves; a mailbox in a signed, widely-copied document is personal data it does not need.
  approvedBy: "ops-approver-4",
  approvedAt: "2026-02-11T15:20:04.000Z",
  // The signature is over the DIGEST STRING, which is what makes an approved artifact
  // uneditable: the digest excludes `lifecycle`, so changing any other field changes the digest and
  // this signature stops verifying against it.
  signature: signBytes(
    null,
    Buffer.from(sharePositionDraft.digest, "utf8"),
    APPROVER.privateKey,
  ).toString("base64url"),
  keyId: APPROVER_KEY_ID,
  alg: "ed25519",
  acknowledgedEffects: ["READ"],
  acknowledgedGrade: "full",
});

// ---------------------------------------------------------------------------------------------
// The deployment's allowlist
// ---------------------------------------------------------------------------------------------
//
// Route PATTERNS, never hosts. The alias resolves per tenant, so this survives a credit union on a
// different host and cannot be satisfied by a lookalike domain.

export const corebankAllowlist: Allowlist = {
  originAliases: ["corebank"],
  routes: [
    { originAlias: "corebank", pathPattern: "/search", maxEffect: "READ" },
    { originAlias: "corebank", pathPattern: "/search/results", maxEffect: "READ" },
    { originAlias: "corebank", pathPattern: "/member/:memberId", maxEffect: "READ" },
    {
      originAlias: "corebank",
      pathPattern: "/member/:memberId/subaccount/new",
      maxEffect: "READ",
    },
  ],
  actionKinds: ["click", "type", "navigate", "pressKey", "acceptDialog", "dismissDialog"],
  maxEffect: "READ",
  discoveryMaxEffect: "READ",
};

/** The member this flow is exercised against. A FIXTURE member: five obviously synthetic digits
 *  that exist only in `fixtures/corebank-web/src/data.js`. */
export const FIXTURE_MEMBER_ID = "10041";
/** A member number the fixture holds no record for. */
export const ABSENT_MEMBER_ID = "99999";
