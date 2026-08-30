// A filled-in, realistic example of all three documents: the credit-union member-lookup flow.
//
// This is the corpus the schema tests round-trip, and it is written the way a recorder would emit
// it rather than the way a test wants it - every field present, every token declared, every
// descriptor derived from a different piece of evidence. If it stops being realistic it stops being
// useful, because the thing it is actually testing is whether the schema can express a real flow at
// all.
//
// ALL DATA IS OBVIOUSLY SYNTHETIC. There is no member number anywhere in this file, and that is not
// tidiness: the artifact stores SHAPES, and a fixture that carried a value would prove the opposite
// of what it exists to prove. Digests are computed, not pasted, so they are always correct and
// nobody has to hand-edit one.

import {
  type CapabilityArtifact,
  type CapabilityContract,
  type CapabilityOverlay,
  type ContainerMatcher,
  type Descriptor,
  type LabelToken,
  type NormalizerId,
  PROVER_VERSION,
  type Predicate,
  type RouteId,
  type StepId,
  type TargetRef,
  type TextMatcher,
  approveArtifact,
  digestOf,
  sealArtifact,
  sealContract,
  sealOverlay,
} from "../../src/index.js";

// ---------------------------------------------------------------------------------------------
// Small constructors, so the documents below read like documents and not like casts
// ---------------------------------------------------------------------------------------------

const token = (t: string, normalize: NormalizerId = "std.label@1"): TextMatcher => ({
  mode: "token",
  token: t as LabelToken,
  normalize,
});
const exact = (value: string, normalize: NormalizerId = "std.label@1"): TextMatcher => ({
  mode: "exact",
  value,
  normalize,
});

const CONTENT_FRAME = { kind: "frame", name: exact("content", "std.text@1") } as const;

const searchForm: ContainerMatcher = {
  path: [CONTENT_FRAME, { kind: "landmark", role: "form", name: token("search-form") }],
};
const resultsTable: ContainerMatcher = {
  path: [
    CONTENT_FRAME,
    {
      kind: "table",
      headers: [token("member-column"), token("name-column"), token("status-column")],
    },
  ],
};
const detailRegion: ContainerMatcher = {
  path: [CONTENT_FRAME, { kind: "landmark", role: "region", name: token("member-detail-heading") }],
};
const sharesTable: ContainerMatcher = {
  path: [
    CONTENT_FRAME,
    {
      kind: "table",
      headers: [token("share-type-column"), token("balance-column"), token("status-column")],
    },
  ],
};
const noticeDialog: ContainerMatcher = {
  path: [CONTENT_FRAME, { kind: "landmark", role: "dialog", name: token("notice-dialog") }],
};

const settled: Predicate = { kind: "settled" };

// ---------------------------------------------------------------------------------------------
// The contract - what the calling agent sees. Notice what is absent: no detector, no frame name,
// no step id, no descriptor. A green-screen artifact could implement this one unchanged.
// ---------------------------------------------------------------------------------------------

export const memberLookupContract: CapabilityContract = sealContract({
  schemaVersion: "capability.contract/v1",
  name: "corebank.member.read_savings_balance",
  version: "1.0.0",
  title: "Read a member's savings balance",
  summary: "Looks up a member by member number and reports the balance of their savings share.",
  whenToUse: [
    "The member is asking what the balance of their savings or share account is.",
    "You already have the member's member number, or the member has just given it to you.",
  ],
  whenNotToUse: [
    "The member is asking about a checking, loan or certificate balance - this reads the savings share only.",
    "You do not have a member number. Identify the member first; this capability will not search by name.",
  ],

  inputs: [
    {
      name: "memberId",
      type: { kind: "string", charset: "digits", minLength: 5, maxLength: 10 },
      required: true,
      description:
        "The member's member number, digits only, as printed on their card or statement.",
      sensitivity: "sensitive",
      constraints: { charset: "digits", minLength: 5, maxLength: 10 },
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
      name: "savingsBalance",
      type: { kind: "money", currency: "USD" },
      required: true,
      description: "The current balance of the member's savings share.",
      sensitivity: "internal",
      agentDisclosure: "deliver",
    },
    {
      name: "accountStatus",
      type: { kind: "enum", values: ["OPEN", "DORMANT", "FROZEN"] },
      required: true,
      description: "Whether the savings share is open, dormant, or frozen.",
      sensitivity: "internal",
      agentDisclosure: "deliver",
      example: "OPEN",
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
      // Stable under retry: the same number will produce the same answer tomorrow. It is an
      // answer, not the absence of one.
      stableUnderRetry: true,
      origin: "hand-authored",
      callerAction: "retry-different-input",
      retryable: "with_different_inputs",
      agentGuidance:
        "Tell the member that number is not on file, and ask them to read it again from their card or statement. Do not guess a different number on their behalf.",
    },
    {
      code: "MEMBER_RESTRICTED",
      kind: "business_outcome",
      title: "The member's record is restricted",
      summary: "The member exists but their record carries a restriction that hides balances.",
      terminal: true,
      payload: [
        {
          name: "restrictionCode",
          type: { kind: "enum", values: ["DECEASED", "LEGAL_HOLD", "FRAUD_REVIEW"] },
          required: true,
          description: "Which restriction the core system reports on this member's record.",
          sensitivity: "internal",
        },
      ],
      // Stable under retry: a restriction is a fact about the RECORD. Contrast a session timeout,
      // which is a fact about this attempt and is therefore a failure, not an outcome.
      stableUnderRetry: true,
      // Both halves of an outcome carry the origin and linker check 8 requires them to be equal.
      // A contract that claimed synthesis derived this while the artifact said a human wrote it
      // would be a lie about provenance in the one place a reviewer would go looking for it.
      origin: "reviewer-authored",
      callerAction: "refer-to-specialist",
      retryable: "never",
      agentGuidance:
        "Tell the member that their record needs to be handled by a member-services representative, and offer to transfer them. Do not describe the restriction or read out the restriction code.",
    },
  ],

  effect: "READ",
  requiresApproval: false,
  idempotent: true,
});

export const memberLookupContractDigest = memberLookupContract.digest;

// ---------------------------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------------------------

const memberIdField: TargetRef = {
  scope: searchForm,
  role: "textbox",
  descriptors: [
    {
      id: "member-id-by-name",
      kind: "role-name",
      evidenceSource: "accessibleName",
      role: "textbox",
      name: token("member-id-field"),
    },
    {
      id: "member-id-by-label",
      kind: "label-anchored",
      evidenceSource: "labelText",
      label: token("member-id-field"),
      role: "textbox",
      relation: "right-of",
      maxDistance: { unit: "px", value: 320 },
    },
    {
      id: "member-id-by-position",
      kind: "ordinal-in-container",
      evidenceSource: "ordinal",
      container: searchForm,
      role: "textbox",
      index: 0,
    },
  ],
  quorum: {
    min: 2,
    distinctEvidenceSources: 2,
    requireIdentical: true,
    onUnderQuorum: "fail",
    expectUnique: true,
  },
  assert: { role: "textbox", enabled: true, visible: true },
  recordedNode: {
    ariaRole: "textbox",
    name: "Member ID",
    containerPath: [
      { kind: "frame", name: "content" },
      { kind: "landmark", role: "form", name: "Member Search" },
    ],
    tablePosition: null,
    boundsBucket: "px:16x4",
  },
};

const searchButton: TargetRef = {
  scope: searchForm,
  role: "button",
  descriptors: [
    {
      id: "search-by-name",
      kind: "role-name",
      evidenceSource: "accessibleName",
      role: "button",
      name: token("search-button"),
    },
    // Anchored to the field it sits beside. A geometric descriptor is rank 5 and never stands
    // alone, but as a SECOND, independently-sourced opinion it is exactly what the quorum wants:
    // if the vendor renames the button, this one still resolves and the disagreement is loud.
    {
      id: "search-right-of-member-id",
      kind: "geometric",
      evidenceSource: "geometry",
      anchor: {
        id: "search-anchor-member-id",
        kind: "label-anchored",
        evidenceSource: "labelText",
        label: token("member-id-field"),
        role: "textbox",
        relation: "right-of",
        maxDistance: { unit: "px", value: 320 },
      },
      role: "button",
      direction: "right-of",
      maxDistance: { unit: "px", value: 240 },
    },
  ],
  quorum: {
    min: 2,
    distinctEvidenceSources: 2,
    requireIdentical: true,
    onUnderQuorum: "fail",
    expectUnique: true,
  },
  assert: { role: "button", enabled: true, visible: true },
  recordedNode: {
    ariaRole: "button",
    name: "Search",
    containerPath: [
      { kind: "frame", name: "content" },
      { kind: "landmark", role: "form", name: "Member Search" },
    ],
    tablePosition: null,
    boundsBucket: "px:6x2",
  },
};

/** Control C1 in one object: the row is selected BY the member number the caller asked about, so
 *  there is no arrangement of the results grid that lets this click the wrong member. */
const selectRowLink: TargetRef = {
  scope: resultsTable,
  role: "link",
  descriptors: [
    {
      id: "select-by-row-key",
      kind: "table-cell",
      evidenceSource: "columnHeader",
      table: resultsTable,
      rowKey: { columnHeader: token("member-column"), value: { from: "param", param: "memberId" } },
      columnHeader: token("actions-column"),
      childRole: "link",
      // The legacy grid has no header row of its own, so the headers were read off row zero. That
      // is recorded as a guess, compared at replay, and correctable by a tenant overlay.
      headerProvenance: "first-row-heuristic",
    },
    {
      id: "select-right-of-member-cell",
      kind: "geometric",
      evidenceSource: "geometry",
      anchor: {
        id: "select-anchor-member-cell",
        kind: "table-cell",
        evidenceSource: "columnHeader",
        table: resultsTable,
        rowKey: {
          columnHeader: token("member-column"),
          value: { from: "param", param: "memberId" },
        },
        columnHeader: token("member-column"),
        headerProvenance: "first-row-heuristic",
      },
      role: "link",
      direction: "right-of",
      maxDistance: { unit: "px", value: 480 },
    },
  ],
  quorum: {
    min: 2,
    distinctEvidenceSources: 2,
    requireIdentical: true,
    onUnderQuorum: "fail",
    expectUnique: true,
  },
  assert: {
    role: "link",
    rowKeyEquals: {
      columnHeader: token("member-column"),
      value: { from: "param", param: "memberId" },
    },
  },
  recordedNode: {
    ariaRole: "link",
    name: "Select",
    containerPath: [
      { kind: "frame", name: "content" },
      { kind: "table", headers: ["Member ID", "Member Name", "Status", "Actions"] },
    ],
    tablePosition: { rowHeader: null, colHeader: "Actions" },
    boundsBucket: "px:4x1",
  },
};

const noticeDismissButton: TargetRef = {
  scope: noticeDialog,
  role: "button",
  descriptors: [
    {
      id: "notice-dismiss-by-name",
      kind: "role-name",
      evidenceSource: "accessibleName",
      role: "button",
      name: token("notice-dismiss-button"),
    },
    {
      id: "notice-dismiss-by-position",
      kind: "ordinal-in-container",
      evidenceSource: "ordinal",
      container: noticeDialog,
      role: "button",
      index: 0,
    },
  ],
  quorum: {
    min: 2,
    distinctEvidenceSources: 2,
    requireIdentical: true,
    onUnderQuorum: "fail",
    expectUnique: true,
  },
  assert: { role: "button", enabled: true, visible: true },
  recordedNode: {
    ariaRole: "button",
    name: "OK",
    containerPath: [
      { kind: "frame", name: "content" },
      { kind: "landmark", role: "dialog", name: "System Notice" },
    ],
    tablePosition: null,
    boundsBucket: "px:3x2",
  },
};

const DEFAULT_SETTLE = { stableSamples: 2, pollIntervalMs: 150, maxWaitMs: 8_000 } as const;
const NO_BUDGETS = { perRecoveryMaxAttempts: {}, maxRemediationCycles: 0 } as const;

// ---------------------------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------------------------

const unsealedArtifact = {
  schemaVersion: "capability.artifact/v1",
  artifactId: "corebank-member-savings-balance-web",
  implements: {
    name: memberLookupContract.name,
    version: memberLookupContract.version,
    contractDigest: memberLookupContractDigest,
  },
  version: 1,

  target: {
    product: "CoreBank Back Office",
    productVersionRange: ">=7.2 <8.0",
    surfaceKind: "web-legacy",
    requires: ["accessibility-tree", "table-position", "containers", "geometry", "route"],
    sessionProfile: "corebank-teller",
  },

  // Written as a verified draft. The approval is attached afterwards, because the approver signs
  // the digest and the digest does not exist until the document has been sealed.
  lifecycle: {
    status: "draft",
    supersedes: null,
    approval: null,
  },

  flow: {
    entry: {
      route: "member-search" as RouteId,
      precondition: { kind: "route-matches", route: "member-search" as RouteId } as Predicate,
    },
    routes: [
      {
        id: "member-search" as RouteId,
        originAlias: "corebank",
        path: "/members/search",
        frame: "content",
      },
      {
        id: "member-detail" as RouteId,
        originAlias: "corebank",
        path: "/members/:memberId",
        query: { tab: ":any" as const },
        frame: "content",
      },
    ],

    // The multi-tenant hinge. Every matcher above references one of these names; a tenant that
    // says "Member #" and "Find" needs a nine-line overlay rather than an edit at forty sites.
    vocabulary: {
      "member-id-field": ["Member ID", "Member Number"],
      "search-button": ["Search", "Find Member"],
      "search-form": ["Member Search"],
      "member-column": ["Member ID"],
      "name-column": ["Member Name"],
      "status-column": ["Status"],
      "actions-column": ["Actions"],
      "select-link": ["Select", "View"],
      "member-detail-heading": ["Member Detail"],
      "member-name-label": ["Member Name", "Name"],
      "status-label": ["Account Status", "Status"],
      "share-type-column": ["Share Type"],
      "balance-column": ["Current Balance", "Balance"],
      "not-found-banner": ["No member found", "Member not on file"],
      "restricted-banner": ["Account restricted", "Restricted - contact branch"],
      "session-expired-banner": ["Your session has expired", "Session timed out"],
      "notice-dialog": ["System Notice"],
      "notice-dismiss-button": ["OK", "Continue"],
    },

    resumePoints: ["open-search" as StepId],

    steps: [
      {
        id: "open-search" as StepId,
        title: "Open the member search screen",
        intent: "Get to the search form so a member number can be entered.",
        effect: "READ",
        instruction: { kind: "navigate", route: "member-search" as RouteId },
        target: null,
        precondition: null,
        settle: DEFAULT_SETTLE,
        expect: {
          predicate: {
            all: [
              settled,
              { kind: "route-matches", route: "member-search" as RouteId },
              {
                kind: "node-exists",
                where: { scope: searchForm, role: "textbox", name: token("member-id-field") },
              },
            ],
          } as Predicate,
          delta: { mustChange: true, navigatedTo: "member-search" as RouteId },
          continuity: [],
        },
        outcomes: [],
        recoveries: [],
        extract: [],
        budgets: NO_BUDGETS,
        evidence: { captureOn: ["failure"] },
      },
      {
        id: "enter-member-id" as StepId,
        title: "Type the member number into the search box",
        intent: "Put the caller's member number in the field the search reads from.",
        effect: "READ",
        instruction: {
          kind: "fill",
          value: { from: "param", param: "memberId" },
          mode: "replace",
        },
        target: memberIdField,
        precondition: {
          kind: "node-state",
          where: { scope: searchForm, role: "textbox", name: token("member-id-field") },
          state: "readonly",
          equals: false,
        } as Predicate,
        settle: DEFAULT_SETTLE,
        // A legacy input with a length limit or an input mask silently truncates or reformats what
        // was typed, and then produces "no member found" for a member who exists. Asserting the
        // field is not flagged invalid is the cheap half of catching that; the interpreter's own
        // postcondition - the value reads back as written - is the other half.
        expect: {
          predicate: {
            kind: "node-state",
            where: { scope: searchForm, role: "textbox", name: token("member-id-field") },
            state: "invalid",
            equals: false,
          } as Predicate,
          delta: { mustChange: true },
          continuity: [],
        },
        outcomes: [],
        recoveries: [],
        extract: [],
        budgets: NO_BUDGETS,
        evidence: { captureOn: ["failure"] },
      },
      {
        id: "submit-search" as StepId,
        title: "Run the search",
        intent: "Submit the search form and wait for the results grid.",
        effect: "READ",
        instruction: { kind: "activate" },
        target: searchButton,
        precondition: {
          kind: "node-state",
          where: { scope: searchForm, role: "button", name: token("search-button") },
          state: "disabled",
          equals: false,
        } as Predicate,
        settle: { ...DEFAULT_SETTLE, maxWaitMs: 12_000 },
        expect: {
          predicate: {
            all: [
              settled,
              { kind: "count", where: { scope: resultsTable, role: "row" }, op: "gte", n: 1 },
            ],
          } as Predicate,
          delta: { mustChange: true },
          continuity: [],
        },
        outcomes: [
          {
            code: "MEMBER_NOT_FOUND",
            detect: {
              kind: "text-present",
              scope: { path: [CONTENT_FRAME] },
              text: token("not-found-banner"),
            } as Predicate,
            priority: 10,
            phase: "post",
            requiresSettled: true,
            origin: "hand-authored",
            capture: [],
          },
        ],
        recoveries: [
          {
            name: "DISMISS_KEEPALIVE_DIALOG",
            band: "interception",
            detect: { kind: "native-dialog", dialogType: "confirm" } as Predicate,
            priority: 10,
            phase: "both",
            remedy: { kind: "dismiss-native-dialog", accept: false },
            maxAttempts: 2,
            allowUnsettled: false,
            afterRemedy: "reverify",
            resume: "retry-step",
          },
        ],
        extract: [],
        budgets: {
          perRecoveryMaxAttempts: { DISMISS_KEEPALIVE_DIALOG: 2 },
          maxRemediationCycles: 3,
        },
        evidence: { captureOn: ["failure", "outcome"] },
      },
      {
        id: "open-member-row" as StepId,
        title: "Open the matching member's record",
        intent: "Follow the row whose member number is the one we were asked about.",
        effect: "READ",
        instruction: { kind: "activate" },
        target: selectRowLink,
        precondition: {
          kind: "count",
          where: { scope: resultsTable, role: "row" },
          op: "gte",
          n: 1,
        } as Predicate,
        settle: { ...DEFAULT_SETTLE, maxWaitMs: 12_000 },
        // Not "a member detail page loaded" but "THE member detail page for the member we were
        // asked about". This is what catches the app's own search silently correcting the id.
        expect: {
          predicate: {
            all: [
              settled,
              { kind: "route-matches", route: "member-detail" as RouteId },
              { kind: "continuity", ref: "subjectMember", scope: detailRegion },
            ],
          } as Predicate,
          delta: { mustChange: true, navigatedTo: "member-detail" as RouteId },
          continuity: ["subjectMember"],
        },
        outcomes: [
          {
            code: "MEMBER_RESTRICTED",
            detect: {
              all: [
                { kind: "text-present", scope: detailRegion, text: token("restricted-banner") },
                {
                  kind: "node-absent",
                  where: {
                    cell: {
                      table: sharesTable,
                      rowKey: {
                        columnHeader: token("share-type-column"),
                        value: { from: "literal", value: "Savings", sensitivity: "public" },
                      },
                      columnHeader: token("balance-column"),
                    },
                  },
                },
              ],
            } as Predicate,
            priority: 10,
            phase: "post",
            requiresSettled: true,
            // PROMOTED, not typed in. This is the fixture's one worked example of the whole
            // promotion path: the detector below was admitted by a discrimination proof, and the
            // receipt in `promotions` below records which observations it fired on, which it was
            // silent on, and at which tenants. Its sibling MEMBER_NOT_FOUND is deliberately left
            // `hand-authored` - unproven, legal, and printed as such - so that one document holds
            // both states and every check that tells them apart has something to tell apart.
            origin: "reviewer-authored",
            capture: [
              {
                output: "restrictionCode",
                from: "text@1",
                where: { scope: detailRegion, role: "status" },
                parse: "enum@1",
                normalize: "std.text@1",
                onMissing: "fail",
              },
            ],
          },
        ],
        recoveries: [],
        extract: [],
        budgets: NO_BUDGETS,
        evidence: { captureOn: ["failure", "outcome"] },
      },
      {
        id: "read-savings-balance" as StepId,
        title: "Read the savings share balance",
        intent: "Read the member's name, the savings row's current balance, and its status.",
        effect: "READ",
        instruction: { kind: "read" },
        target: null,
        precondition: { kind: "route-matches", route: "member-detail" as RouteId } as Predicate,
        settle: DEFAULT_SETTLE,
        expect: {
          predicate: {
            all: [
              settled,
              { kind: "continuity", ref: "subjectMember", scope: detailRegion },
              { kind: "count", where: { scope: sharesTable, role: "row" }, op: "gte", n: 1 },
            ],
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
          {
            output: "memberName",
            from: "value@1",
            where: { scope: detailRegion, role: "textbox", name: token("member-name-label") },
            parse: "string@1",
            normalize: "std.text@1",
            onMissing: "fail",
          },
          // Row-and-column addressing keyed by a VALUE. Without it this degrades to "some cell in
          // this grid", which is how a checking balance gets read out as a savings balance.
          {
            output: "savingsBalance",
            from: "cell@1",
            where: {
              cell: {
                table: sharesTable,
                rowKey: {
                  columnHeader: token("share-type-column"),
                  value: { from: "literal", value: "Savings", sensitivity: "public" },
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
            from: "value@1",
            where: { scope: detailRegion, role: "textbox", name: token("status-label") },
            parse: "enum@1",
            normalize: "std.text@1",
            onMissing: "fail",
          },
        ],
        budgets: NO_BUDGETS,
        evidence: { captureOn: ["failure"] },
      },
    ],

    ambient: [
      {
        name: "SESSION_EXPIRED",
        band: "environment",
        detect: {
          kind: "text-present",
          text: token("session-expired-banner"),
        } as Predicate,
        priority: 10,
        phase: "both",
        // Delegated to the session broker. The program never logs in, so there is no place in this
        // document where a credential could be written down even by accident.
        remedy: { kind: "reauthenticate" },
        maxAttempts: 1,
        // An expired-session banner is WHY the surface will never settle, so this detector has to
        // be allowed to fire against an unsettled screen. Only an environment band may say so.
        allowUnsettled: true,
        afterRemedy: "reverify",
        resume: "restart-program",
      },
      {
        name: "DISMISS_SYSTEM_NOTICE",
        band: "interception",
        detect: {
          kind: "node-exists",
          where: {
            scope: noticeDialog,
            role: "button",
            name: token("notice-dismiss-button"),
          },
        } as Predicate,
        priority: 20,
        phase: "both",
        remedy: {
          kind: "actions",
          instructions: [{ kind: "activate", target: noticeDismissButton }],
        },
        maxAttempts: 2,
        allowUnsettled: false,
        afterRemedy: "reverify",
        resume: "retry-step",
      },
    ],
  },

  continuity: [
    {
      id: "subjectMember",
      source: { from: "param", param: "memberId" },
      // Normalized, not identity: "10042" in the search box and "Member #10042" in the detail
      // heading are the same subject, and an equality check would say otherwise.
      compare: { via: "std.text@1", type: { kind: "string", charset: "digits" } },
    },
  ],

  provenance: {
    discoveryRunId: "run-2026-02-11-a1b2c3",
    goalTemplate:
      "look up member {memberId} in the back office and read their current savings share balance",
    model: {
      adapter: "anthropic",
      modelId: "claude-opus-5",
      promptVersion: "discovery/2026-02-01",
    },
    transcriptRef: {
      digest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      uri: "evidence/transcripts/run-2026-02-11-a1b2c3.jsonl",
    },
    recordedAt: "2026-02-11T14:03:22.000Z",
    recordedAgainst: {
      tenantId: "riverbend",
      appInstanceId: "riverbend-corebank-prod",
      fingerprint: {
        perStep: {
          "open-search": "fp:8f21c4",
          "enter-member-id": "fp:8f21c4",
          "submit-search": "fp:d0117a",
          "open-member-row": "fp:d0117a",
          "read-savings-balance": "fp:5b93e0",
        },
      },
    },
  },

  verification: {
    mode: "replay-full",
    status: "verified",
    coveredThroughStep: "read-savings-balance" as StepId,
    grade: "full",
    runId: "run-2026-02-11-a1b2c3-verify",
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
    routesTouched: ["member-search" as RouteId, "member-detail" as RouteId],
    reads: [
      { field: "memberName", sensitivity: "sensitive" },
      { field: "savingsBalance", sensitivity: "internal" },
      { field: "accountStatus", sensitivity: "internal" },
    ],
    requiresApproval: false,
    restartSafeUpToPc: 5,
  },

  budgets: {
    maxActions: 40,
    maxObservations: 200,
    maxTotalRemediations: 8,
    maxProgramAttempts: 2,
    deadlineMs: 120_000,
  },

  /**
   * ONE RECEIPT, FOR THE ONE PROMOTED OUTCOME.
   *
   * SYNTHETIC, LIKE EVERY OTHER FIELD IN THIS FILE. The digests below are `digestOf` over a label,
   * not over a screen anybody perceived, exactly as the approval above is a synthetic signature
   * rather than a real ed25519 one. What this fixture is FOR is the checks: linker check 29 needs
   * a document that satisfies it and a mutation of that document that does not, the artifact
   * schema needs a receipt whose code and step agree with a rule, and `crr approve` needs
   * something to make an approver tick. The genuine end-to-end proof is exercised by
   * `test/promotion.test.ts`, which runs `proveDiscrimination` over the real frozen screens in
   * `classifier-screens.ts` rather than asserting a literal.
   *
   * `provenAt` names both tenants because this artifact is linked at riverbend (bare) and at
   * summit (through `summitOverlay`) throughout the suite, and check 29 refuses in `replay` mode
   * at a tenant the proof does not name - which is the point of the field.
   */
  promotions: [
    {
      code: "MEMBER_RESTRICTED",
      atStep: "open-member-row",
      reviewDigest: digestOf("member-lookup fixture: the MEMBER_RESTRICTED review document"),
      reviewedBy: "ops-approver-4",
      supersedesArtifactVersion: 1,
      proof: {
        verdict: "discriminates",
        proverVersion: PROVER_VERSION,
        positives: [
          {
            observation: digestOf("member-lookup fixture: the restricted member detail screen"),
            atStep: "open-member-row",
          },
        ],
        negatives: {
          corpusDigest: digestOf("member-lookup fixture: the negative corpus"),
          total: 9,
          happyPathAtStep: 2,
          // Zero, and REPORTED rather than smoothed over. Nobody has shown this detector can tell
          // a restriction banner from any other banner that lands on the detail screen; an
          // approver reads that fact instead of a threshold's opinion of it.
          otherAbnormalAtStep: 0,
          otherSteps: 6,
          otherTenants: 1,
        },
        provenAt: ["riverbend", "summit"],
      },
      probeConfirmed: false,
    },
  ],
  signatures: [],
};

export const memberLookupDraft: CapabilityArtifact = sealArtifact(unsealedArtifact);

export const memberLookupArtifact: CapabilityArtifact = approveArtifact(memberLookupDraft, {
  // An identity handle, not a person's mailbox. "Who approved this" is an audit answer the identity
  // system resolves; a mailbox in a signed, widely-copied document is personal data the document
  // does not need.
  approvedBy: "ops-approver-4",
  approvedAt: "2026-02-11T15:20:04.000Z",
  signature: "ed25519:c3ludGhldGljLXNpZ25hdHVyZS1mb3ItdGhlLWV4YW1wbGU",
  keyId: "ops-approval-key-1",
  alg: "ed25519",
  acknowledgedEffects: ["READ"],
  acknowledgedGrade: "full",
  // The approver ticked the promoted code by hand. Refused on mismatch in both directions, exactly
  // as the grade and the effect classes are.
  acknowledgedPromotions: ["MEMBER_RESTRICTED"],
});

// ---------------------------------------------------------------------------------------------
// The overlay - one tenant of the same vendor product, nine lines of real difference
// ---------------------------------------------------------------------------------------------

const summitDescriptor: Descriptor = {
  id: "summit-search-by-position",
  kind: "ordinal-in-container",
  evidenceSource: "ordinal",
  container: searchForm,
  role: "button",
  index: 1,
};

export const summitOverlay: CapabilityOverlay = sealOverlay({
  schemaVersion: "capability.overlay/v1",
  appliesTo: { artifactId: memberLookupArtifact.artifactId, version: { min: 1 } },
  tenantId: "summit",
  appInstanceId: "summit-corebank-prod",

  originAliases: { corebank: "https://summit-cb.example.invalid" },
  routeBasePath: { "member-search": "/cb", "member-detail": "/cb" },

  // The whole tenant difference, in three entries. Every descriptor, detector, row key and
  // checkpoint that named these tokens follows along without being touched.
  vocabulary: {
    "member-id-field": ["Member #"],
    "search-button": ["Find"],
    "select-link": ["Open"],
  },
  stripTokens: ["Summit", "Summit Credit Union"],

  steps: {
    "submit-search": {
      // Summit's search bar carries an extra "Clear" button ahead of the submit, so the base
      // ordinal is permanently ambiguous here. Adding one and leaving the base to abstain keeps
      // the divergence visible in the fingerprint instead of erasing it.
      addDescriptors: [summitDescriptor],
      settle: { maxWaitMs: 20_000 },
    },
  },

  addRecoveries: {
    "submit-search": [
      {
        name: "DISMISS_TERMS_INTERSTITIAL",
        band: "interception",
        detect: {
          kind: "node-exists",
          where: {
            scope: noticeDialog,
            role: "button",
            name: token("notice-dismiss-button"),
          },
        } as Predicate,
        priority: 30,
        phase: "pre",
        remedy: {
          kind: "actions",
          instructions: [{ kind: "activate", target: noticeDismissButton }],
        },
        maxAttempts: 1,
        allowUnsettled: false,
        afterRemedy: "reverify",
        resume: "retry-step",
      },
    ],
  },
});
