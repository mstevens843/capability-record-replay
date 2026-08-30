// The IRREVERSIBLE flow, written against the REAL `fixtures/corebank-web`.
//
// This is the document `docs/design/FINAL-STATUS.md` section 7.3 said could not be written. The
// fixture has a modal confirmation and a real sub-account commit, and no browser test touched
// either, because SPEC section 4.4 ran band B2 (interception) before band B5 (checkpoint) - so a
// confirmation dialog could not be a step's expected postcondition, and the only shape the language
// could express was an interception recovery whose remedy performed the write, which SPEC section
// 3.5 forbids and should.
//
// `Checkpoint.dialog` is the amendment. Step 4 raises the confirmation and DECLARES it; step 5
// answers it, declares the same dialog and expects it gone. Band B2 stands down for that dialog and
// for nothing else - an undeclared modal, a second modal alongside the declared one, and a native
// dialog on any step are all still `undeclared-dialog`.
//
// PROVENANCE, SAID FIRST. **Hand-authored. No model produced it.** `provenance.model.adapter` is
// `replay` with a `modelId` that names no model, because that is the least dishonest value in the
// enum for "a person wrote this". Nothing in `/evidence/` may present a run of this as a discovery
// run.
//
// ALL DATA IS SYNTHETIC, and no member number and no amount appears anywhere below: both are typed
// parameters and the artifact stores their SHAPE.
//
// Every matcher, bound and ordinal here was taken from a real `perceive()` over the fixture through
// `@crr/surface-browser` - the measurements are in the comments - and not from reading its HTML.

import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import {
  type Allowlist,
  type CapabilityArtifact,
  type CapabilityContract,
  type ContainerMatcher,
  type NodeQuery,
  type NormalizerId,
  type Predicate,
  type RouteId,
  type StepId,
  type TargetRef,
  type TextMatcher,
  PROVER_VERSION,
  approveArtifact,
  digestOf,
  sealArtifact,
  sealContract,
} from "@crr/core";

// ---------------------------------------------------------------------------------------------
// Small constructors
// ---------------------------------------------------------------------------------------------

const token = (t: string, normalize: NormalizerId = "std.label@1"): TextMatcher =>
  ({ mode: "token", token: t, normalize }) as TextMatcher;
const exact = (value: string, normalize: NormalizerId = "std.text@1"): TextMatcher =>
  ({ mode: "exact", value, normalize }) as TextMatcher;

const CONTENT = { kind: "frame", name: exact("content") } as const;

const contentPane: ContainerMatcher = { path: [CONTENT] };
/** The open-sub-account form. Its accessible name is EMPTY on this product - no `<legend>`, no
 *  `aria-label` - so the matcher names the role and nothing else. */
const contentForm: ContainerMatcher = { path: [CONTENT, { kind: "landmark", role: "form" }] };
/** The confirmation panel: `role="dialog" aria-modal="true" aria-label="Confirm Sub-Account"`.
 *  Measured containerPath of its buttons: [frame top, frame content, dialog, form]. */
const confirmDialog: ContainerMatcher = {
  path: [CONTENT, { kind: "landmark", role: "dialog", name: token("confirm-dialog") }],
};

const settled: Predicate = { kind: "settled" };

/**
 * The dialog this flow transacts with, as band B2 and band B5 both read it.
 *
 * Spelled ONCE and referenced by both steps, because the raising step and the answering step are
 * talking about the same widget and two copies of that fact is one copy too many. Linker check 25
 * requires `role: "dialog"`: band B2 stands down only for open dialog NODES this query selects, so
 * a query that cannot select one would leave a step declared on paper and undeclared in fact.
 */
const CONFIRMATION: NodeQuery = {
  scope: contentPane,
  role: "dialog",
  name: token("confirm-dialog"),
} as NodeQuery;

// ---------------------------------------------------------------------------------------------
// The contract - what the calling agent sees
// ---------------------------------------------------------------------------------------------

export const openSubAccountContract: CapabilityContract = sealContract({
  schemaVersion: "capability.contract/v1",
  name: "corebank.member.open_sub_account",
  version: "1.0.0",
  title: "Open a share sub-account for a member",
  summary:
    "Opens a new share sub-account of the declared product type for an existing member, with the opening deposit the caller supplies. Performs an irreversible posting to the core system and returns only when the core has confirmed it.",
  whenToUse: [
    "A member has asked to open an additional share account and a teller has already agreed the product type and the opening deposit with them.",
  ],
  whenNotToUse: [
    "You have not confirmed the opening deposit with the member. This posts; there is no undo, and reversing it is a manual back-office correction.",
    "You only want to see the member's existing accounts - read their share position instead.",
    "The member number is not known. This capability will not search by name.",
  ],

  inputs: [
    {
      name: "memberId",
      type: { kind: "string", charset: "digits", minLength: 5, maxLength: 5 },
      required: true,
      description: "The member's member number, five digits, as printed on their card.",
      sensitivity: "sensitive",
      constraints: { charset: "digits", minLength: 5, maxLength: 5 },
      discoveredFrom: { goalSpan: "member {memberId}" },
    },
    {
      name: "openingDeposit",
      // A STRING, not `money`, and the reason is the surface rather than the type system: this is
      // typed into a legacy text field verbatim and the field's own validator is what accepts or
      // rejects it. Declaring `money` here would promise the caller a normalization this
      // capability does not perform.
      type: { kind: "string", charset: "any", minLength: 1, maxLength: 12 },
      required: true,
      description:
        "The opening deposit, as a plain decimal amount in US dollars with no currency symbol and no thousands separator - 25.00, or 1500.00.",
      sensitivity: "internal",
      constraints: { charset: "any", minLength: 1, maxLength: 12 },
      discoveredFrom: { operator: true },
    },
  ],

  // DELIBERATELY EMPTY, and this is a measured limitation rather than a shortcut. The core's
  // confirmation screen prints the new account number and the posting reference as unlabelled
  // `<font>` runs inside a LAYOUT table: measured through `@crr/surface-browser`, every one of
  // those nodes comes back `ariaRole: null` with no `tablePosition`, so there is no `NodeQuery`
  // that can name them - `role` cannot select a structural node and `cell` addressing needs a real
  // table with headers. Returning nothing is the honest answer; inventing an ordinal into a layout
  // table would be a locator, which is the one thing this design refuses.
  //
  // It is the SAME driver gap FINAL-STATUS section 7.6 records on the green screen, where the
  // member's name is an unlabelled prose run and `detect()` emits no node for it. Two surfaces, one
  // fix: an unlabelled run of body text should become a `text` node.
  outputs: [],

  outcomes: [
    {
      code: "MEMBER_RESTRICTED",
      kind: "business_outcome",
      title: "The member record is restricted",
      summary:
        "The core refused to open the sub-account because this member record is restricted and must be serviced by a member services supervisor.",
      terminal: true,
      payload: [],
      origin: "reviewer-authored",
      stableUnderRetry: true,
      callerAction: "refer-to-specialist",
      retryable: "never",
      agentGuidance:
        "Tell the member this record requires member services handling; do not retry the write with the same role.",
    },
  ],

  effect: "WRITE_IRREVERSIBLE",
  requiresApproval: true,
  // Opening an account twice opens two accounts. Saying so in the contract is what lets a caller's
  // retry policy be right rather than optimistic.
  idempotent: false,
});

// ---------------------------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------------------------

const QUORUM = {
  min: 2,
  distinctEvidenceSources: 2,
  requireIdentical: true,
  onUnderQuorum: "fail",
  expectUnique: true,
} as const;

/** The product list. NO accessible name on this product, so `role-name` - rank 1, the descriptor
 *  you would reach for first - is unusable and the quorum is a label anchor plus an ordinal.
 *  Measured: the label "Sub-Account Type" ends at x=297 and this control starts at x=309, a 12px
 *  gap, and the two overlap vertically (label y=182..197, control y=180..199). "Initial Deposit"
 *  sits at y=206..221 and therefore cannot anchor this one - `right-of` requires the overlap. */
const productList: TargetRef = {
  scope: contentForm,
  role: "combobox",
  descriptors: [
    {
      id: "product-right-of-type-label",
      kind: "label-anchored",
      evidenceSource: "labelText",
      label: token("subaccount-type-label"),
      role: "combobox",
      relation: "right-of",
      maxDistance: { unit: "px", value: 60 },
    },
    {
      id: "product-only-list-in-form",
      kind: "ordinal-in-container",
      evidenceSource: "ordinal",
      container: contentForm,
      role: "combobox",
      index: 0,
    },
  ],
  quorum: QUORUM,
  assert: { role: "combobox", enabled: true, visible: true },
  recordedNode: {
    ariaRole: "combobox",
    name: "",
    containerPath: [
      { kind: "frame", name: "top" },
      { kind: "frame", name: "content" },
      { kind: "landmark", role: "form", name: null },
    ],
    tablePosition: null,
    // 197x19 px, bucketed at 8px.
    boundsBucket: "px:24x2",
  },
};

/** The opening-deposit field. Measured: "Initial Deposit" ends at x=297, the box starts at x=309,
 *  and they overlap vertically at y=206..221 / y=203..224. */
const depositField: TargetRef = {
  scope: contentForm,
  role: "textbox",
  descriptors: [
    {
      id: "deposit-right-of-label",
      kind: "label-anchored",
      evidenceSource: "labelText",
      label: token("initial-deposit-label"),
      role: "textbox",
      relation: "right-of",
      maxDistance: { unit: "px", value: 60 },
    },
    {
      id: "deposit-only-box-in-form",
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
    // 97x21 px.
    boundsBucket: "px:12x2",
  },
};

/** The form's submit button. This one DOES carry an accessible name, so rank 1 is available and the
 *  second opinion is independently sourced from the ordinal rather than from the same string. */
const submitButton: TargetRef = {
  scope: contentForm,
  role: "button",
  descriptors: [
    {
      id: "submit-by-name",
      kind: "role-name",
      evidenceSource: "accessibleName",
      role: "button",
      name: token("submit-subaccount-button"),
    },
    {
      id: "submit-only-button-in-form",
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
    name: "Open Account",
    containerPath: [
      { kind: "frame", name: "top" },
      { kind: "frame", name: "content" },
      { kind: "landmark", role: "form", name: null },
    ],
    tablePosition: null,
    // 100x21 px.
    boundsBucket: "px:12x2",
  },
};

/**
 * The button that performs the write, SCOPED INSIDE THE DIALOG.
 *
 * The scope is the control that matters here and it is not decoration. The page behind the panel
 * still carries its own "Open Account" button - measured, it is still in the tree and still
 * visible - and the ordinal descriptor would find it first if this were scoped to the content pane.
 * Scoping to the declared dialog is what makes "the button that commits" mean the button on the
 * thing the operator is actually looking at.
 */
const confirmButton: TargetRef = {
  scope: confirmDialog,
  role: "button",
  descriptors: [
    {
      id: "confirm-by-name",
      kind: "role-name",
      evidenceSource: "accessibleName",
      role: "button",
      name: token("confirm-button"),
    },
    {
      id: "confirm-first-in-dialog",
      kind: "ordinal-in-container",
      evidenceSource: "ordinal",
      container: confirmDialog,
      role: "button",
      index: 0,
    },
  ],
  quorum: QUORUM,
  assert: { role: "button", enabled: true, visible: true },
  recordedNode: {
    ariaRole: "button",
    name: "Confirm",
    containerPath: [
      { kind: "frame", name: "top" },
      { kind: "frame", name: "content" },
      { kind: "landmark", role: "dialog", name: "Confirm Sub-Account" },
      { kind: "landmark", role: "form", name: null },
    ],
    tablePosition: null,
    // 63x21 px.
    boundsBucket: "px:7x2",
  },
};

// ---------------------------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------------------------

const SETTLE = { stableSamples: 3, pollIntervalMs: 120, maxWaitMs: 10_000 } as const;
const BUDGETS = { perRecoveryMaxAttempts: {}, maxRemediationCycles: 1 } as const;

const ROUTES = {
  newSub: "subaccount-new" as RouteId,
  confirm: "subaccount-confirm" as RouteId,
  commit: "subaccount-commit" as RouteId,
};

const unsealed = {
  schemaVersion: "capability.artifact/v1",
  artifactId: "corebank-open-sub-account-web",
  implements: {
    name: openSubAccountContract.name,
    version: openSubAccountContract.version,
    contractDigest: openSubAccountContract.digest,
  },
  version: 1,

  target: {
    product: "CoreBank Servicing",
    productVersionRange: ">=8.0 <9.0",
    surfaceKind: "web-legacy",
    requires: ["accessibility-tree", "containers", "geometry", "route"],
    sessionProfile: "corebank-teller",
  },

  lifecycle: { status: "draft", supersedes: null, approval: null },

  flow: {
    entry: {
      route: ROUTES.newSub,
      precondition: { kind: "route-matches", route: ROUTES.newSub } as Predicate,
    },
    routes: [
      {
        id: ROUTES.newSub,
        originAlias: "corebank",
        path: "/member/:memberId/subaccount/new",
        frame: "content",
      },
      {
        id: ROUTES.confirm,
        originAlias: "corebank",
        path: "/member/:memberId/subaccount/confirm",
        frame: "content",
      },
      {
        id: ROUTES.commit,
        originAlias: "corebank",
        path: "/member/:memberId/subaccount/commit",
        frame: "content",
      },
    ],

    vocabulary: {
      "subaccount-type-label": ["Sub-Account Type"],
      "initial-deposit-label": ["Initial Deposit"],
      // The product the caller is opening. An artifact LITERAL rather than a parameter, and that is
      // the design rather than a shortcut: `select` names an option with a `TextMatcher`, so a
      // product this program does not name is a program that does not fit the tenant's catalogue -
      // which is a link-time or lower-time refusal rather than a wrong account type opened. A
      // second product is a second capability, or an overlay token.
      "share-product": ["Share Account - Regular"],
      "submit-subaccount-button": ["Open Account"],
      "confirm-dialog": ["Confirm Sub-Account"],
      "confirm-button": ["Confirm"],
      "confirmed-heading": ["Sub-Account Opened"],
      "posting-reference-label": ["Posting Reference"],
      "session-expired-banner": ["Your session has ended due to inactivity"],
      "record-denial-supervisor": ["member services supervisor must service this record"],
      "record-denial-reference": ["Reference CB-4417"],
      "role-denial-function": ["role TELLER1 is not authorized for function OPEN_SUBACCOUNT"],
      "role-denial-reference": ["Reference CB-2203"],
    },

    resumePoints: [],

    steps: [
      // ---- 1 -----------------------------------------------------------------------------------
      {
        id: "open-subaccount-form" as StepId,
        title: "Open the sub-account form for this member",
        intent: "Get to the form the new share account is opened from.",
        effect: "READ",
        instruction: { kind: "navigate", route: ROUTES.newSub },
        target: null,
        precondition: null,
        settle: SETTLE,
        expect: {
          predicate: {
            all: [
              settled,
              { kind: "route-matches", route: ROUTES.newSub },
              { kind: "node-exists", where: { scope: contentForm, role: "combobox" } },
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
      // ---- 2 -----------------------------------------------------------------------------------
      {
        id: "choose-subaccount-type" as StepId,
        title: "Choose the share product",
        intent: "Set the product the new sub-account is opened under.",
        // A form control. Nothing is posted and nothing is written; the POST is step 4.
        effect: "READ",
        instruction: { kind: "select", option: token("share-product") },
        target: productList,
        precondition: {
          kind: "node-state",
          where: { scope: contentForm, role: "combobox" },
          state: "disabled",
          equals: false,
        } as Predicate,
        settle: SETTLE,
        expect: {
          predicate: {
            all: [settled, { kind: "route-matches", route: ROUTES.newSub }],
          } as Predicate,
          // `skeletonDigest` is taken over role, name, container path and STATE, deliberately
          // excluding `value` - so a control's selection changing is invisible to it by design.
          // `select`'s real postcondition is the read-back in `src/postcondition.ts`, which
          // re-resolves this step's own target and compares the option that ended up selected.
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
        id: "enter-opening-deposit" as StepId,
        title: "Type the opening deposit",
        intent: "Put the caller's opening deposit into the amount field.",
        effect: "READ",
        instruction: {
          kind: "fill",
          value: { from: "param", param: "openingDeposit" },
          mode: "replace",
        },
        target: depositField,
        precondition: {
          kind: "node-state",
          where: { scope: contentForm, role: "textbox" },
          state: "readonly",
          equals: false,
        } as Predicate,
        settle: SETTLE,
        expect: {
          predicate: {
            all: [settled, { kind: "route-matches", route: ROUTES.newSub }],
          } as Predicate,
          delta: { mustChange: false },
          continuity: [],
        },
        outcomes: [],
        recoveries: [],
        extract: [],
        budgets: BUDGETS,
        evidence: { captureOn: ["failure"] },
      },
      // ---- 4 -----------------------------------------------------------------------------------
      {
        id: "submit-subaccount-form" as StepId,
        title: "Submit the form and raise the confirmation",
        intent:
          "Post the form so the core renders its confirmation panel, which is what a teller has to answer before anything is written.",
        // A POST that writes nothing: the core re-renders the same form under a confirmation panel
        // and the posting has not happened. Declared `WRITE_REVERSIBLE` rather than `READ` because
        // something DID happen on the far side and a reviewer should see the class change here
        // rather than at the step that commits.
        effect: "WRITE_REVERSIBLE",
        instruction: { kind: "activate" },
        target: submitButton,
        precondition: { kind: "route-matches", route: ROUTES.newSub } as Predicate,
        settle: SETTLE,
        expect: {
          predicate: {
            all: [
              settled,
              { kind: "route-matches", route: ROUTES.confirm },
              { kind: "continuity", ref: "subjectMember", scope: contentPane },
            ],
          } as Predicate,
          delta: { mustChange: true, navigatedTo: ROUTES.confirm },
          continuity: ["subjectMember"],
          // THE AMENDMENT. Before this clause existed, this screen was `undeclared-dialog` and this
          // flow could not be written: band B2 answered first and a confirmation dialog could not be
          // a postcondition. The declaration is what stands B2 down for THIS dialog - and for
          // nothing else, so the fixture's maintenance interstitial, which is the SAME widget with a
          // different accessible name, is still a hard failure here.
          dialog: { where: CONFIRMATION, present: true },
        },
        // NONE, and linker check 25 enforces both: a step whose postcondition is an OPEN dialog may
        // declare no outcome and read no value, because everything behind the panel is the state
        // before whatever raised it. That is the half of "B2 before B3" that is true, and it
        // survives the amendment intact.
        outcomes: [],
        recoveries: [],
        extract: [],
        budgets: BUDGETS,
        evidence: { captureOn: ["always"] },
      },
      // ---- 5 -----------------------------------------------------------------------------------
      {
        id: "commit-subaccount" as StepId,
        title: "Confirm, and open the account",
        intent: "The irreversible one: this posts the new sub-account to the core.",
        effect: "WRITE_IRREVERSIBLE",
        instruction: { kind: "activate" },
        target: confirmButton,
        // A real precondition, so the dry run's "everything except the dispatch" claim has
        // something to evaluate: the control this run is about to NOT press has to be there.
        precondition: {
          kind: "node-exists",
          where: { scope: confirmDialog, role: "button", name: token("confirm-button") },
        } as Predicate,
        settle: SETTLE,
        expect: {
          predicate: {
            all: [
              settled,
              { kind: "route-matches", route: ROUTES.commit },
              { kind: "text-present", scope: contentPane, text: token("confirmed-heading") },
              { kind: "text-present", scope: contentPane, text: token("posting-reference-label") },
              { kind: "continuity", ref: "subjectMember", scope: contentPane },
            ],
          } as Predicate,
          delta: { mustChange: true, navigatedTo: ROUTES.commit },
          // Save-time invariant 11: the strongest control in the document is NOT optional on the one
          // step it exists to protect. The core's confirmation screen names the record, which is the
          // only reason this artifact can reach `draft` at all.
          continuity: ["subjectMember"],
          // The other half of the amendment, and the reason `present` is a field rather than an
          // inference. The dialog OUTLIVES the step that raised it: it is step 4's postcondition and
          // it is on screen when step 5 begins. Without this declaration band B2 refuses step 5
          // before it starts, and the refusal simply moves one step to the right.
          dialog: { where: CONFIRMATION, present: false },
        },
        outcomes: [
          {
            code: "MEMBER_RESTRICTED",
            detect: {
              all: [
                {
                  kind: "text-present",
                  scope: contentPane,
                  text: token("record-denial-supervisor"),
                },
                {
                  kind: "text-present",
                  scope: contentPane,
                  text: token("record-denial-reference"),
                },
              ],
            } as Predicate,
            priority: 5,
            phase: "post",
            requiresSettled: true,
            origin: "reviewer-authored",
            capture: [],
          },
        ],
        // No recoveries here. A reviewer-authored record restriction is terminal because the core
        // says no write happened; everything else after dispatch stays effect-in-doubt unless a
        // declared environment rule gives a non-retryable operator/session answer.
        recoveries: [],
        extract: [],
        budgets: BUDGETS,
        evidence: { captureOn: ["always"] },
      },
    ],

    ambient: [
      {
        name: "ROLE_NOT_ENTITLED",
        band: "environment",
        detect: {
          all: [
            { kind: "text-present", scope: contentPane, text: token("role-denial-function") },
            { kind: "text-present", scope: contentPane, text: token("role-denial-reference") },
          ],
        } as Predicate,
        priority: 5,
        phase: "both",
        remedy: {
          kind: "escalate",
          reason: "the automation role lacks OPEN_SUBACCOUNT authority",
          brief:
            "The service account's teller role cannot open sub-accounts at this tenant. Grant the entitlement or route the work to an authorized operator; retrying this invocation with the same role will fail identically.",
        },
        maxAttempts: 1,
        allowUnsettled: true,
        afterRemedy: "reverify",
        resume: "escalate",
      },
      {
        // A session that dies mid-write is NOT re-authenticated and retried. `resume: "escalate"`
        // makes it terminal - `session-expired-unrecoverable` - because re-establishing the session
        // and re-walking the flow would re-post a form whose first POST may already have committed.
        name: "SESSION_EXPIRED",
        band: "environment",
        detect: {
          kind: "text-present",
          scope: contentPane,
          text: token("session-expired-banner"),
        } as Predicate,
        priority: 10,
        phase: "both",
        remedy: { kind: "reauthenticate" },
        maxAttempts: 1,
        allowUnsettled: true,
        afterRemedy: "reverify",
        resume: "escalate",
      },
    ],
  },

  continuity: [
    {
      id: "subjectMember",
      source: { from: "param", param: "memberId" },
      compare: { via: "std.text@1", type: { kind: "string", charset: "digits" } },
    },
  ],

  provenance: {
    discoveryRunId: "run-subaccount-hand-authored",
    goalTemplate:
      "open a share sub-account for member {memberId} with an opening deposit of {openingDeposit}",
    model: {
      adapter: "replay",
      modelId: "none:hand-authored-for-the-dialog-amendment",
      promptVersion: "n/a",
    },
    transcriptRef: null,
    recordedAt: "2026-08-27T09:14:02.000Z",
    recordedAgainst: {
      tenantId: "riverbend",
      appInstanceId: "riverbend-corebank-fixture",
      fingerprint: {
        perStep: {
          "open-subaccount-form": "fp:newsub",
          "choose-subaccount-type": "fp:newsub",
          "enter-opening-deposit": "fp:newsub",
          "submit-subaccount-form": "fp:confirm",
          "commit-subaccount": "fp:commit",
        },
      },
    },
  },

  // A dry run is the only mode this artifact can be verified in without a resettable environment,
  // and the grade says exactly what that establishes: every step through `submit-subaccount-form`
  // replayed, and at `commit-subaccount` the descriptors resolved under quorum and the instruction
  // lowered - and the action was deliberately not dispatched.
  verification: {
    mode: "replay-dry",
    status: "verified",
    coveredThroughStep: "submit-subaccount-form" as StepId,
    grade: "partial-up-to-irreversible",
    runId: "run-subaccount-verify",
    at: "2026-08-27T09:16:11.000Z",
  },

  policy: {
    originAliases: ["corebank"],
    maxEffect: "WRITE_IRREVERSIBLE",
    requiresApprovalToken: true,
    redaction: { taintedParams: ["memberId"], maskScreenshotRegions: true },
  },

  effects: {
    maxEffect: "WRITE_IRREVERSIBLE",
    irreversibleSteps: ["commit-subaccount" as StepId],
    routesTouched: [ROUTES.newSub, ROUTES.confirm, ROUTES.commit],
    reads: [],
    requiresApproval: true,
    // The index of the first irreversible step. A program that has already opened a sub-account
    // cannot be restarted, and this says which steps make that true before anything runs.
    restartSafeUpToPc: 4,
  },

  budgets: {
    maxActions: 12,
    maxObservations: 200,
    maxTotalRemediations: 1,
    // ONE attempt at the program, and no restart is reachable anyway: the only ambient rule
    // escalates. A write flow does not get a second go.
    maxProgramAttempts: 1,
    deadlineMs: 120_000,
  },

  promotions: [
    {
      code: "MEMBER_RESTRICTED",
      atStep: "commit-subaccount",
      reviewDigest: digestOf("corebank write fixture: the MEMBER_RESTRICTED review document"),
      reviewedBy: "ops-approver-4",
      supersedesArtifactVersion: 1,
      proof: {
        verdict: "discriminates",
        proverVersion: PROVER_VERSION,
        positives: [
          {
            observation: digestOf("corebank write fixture: permission-denied-record at commit"),
            atStep: "commit-subaccount",
          },
        ],
        negatives: {
          corpusDigest: digestOf("corebank write fixture: role-vs-record denial negative corpus"),
          total: 3,
          happyPathAtStep: 1,
          otherAbnormalAtStep: 1,
          otherSteps: 1,
          otherTenants: 0,
        },
        provenAt: ["riverbend"],
      },
      probeConfirmed: true,
    },
  ],
  signatures: [],
};

export const openSubAccountDraft: CapabilityArtifact = sealArtifact(unsealed);

// ---------------------------------------------------------------------------------------------
// A real ed25519 approval, over the real digest. Generated per process: a private key in a
// repository is a private key on the internet.
// ---------------------------------------------------------------------------------------------

const APPROVER = generateKeyPairSync("ed25519");

export const WRITE_APPROVER_KEY_ID = "ops-approval-key-write-1";

export const writeApproverPublicKey: Uint8Array = new Uint8Array(
  APPROVER.publicKey.export({ format: "der", type: "spki" }),
);

export const openSubAccountArtifact: CapabilityArtifact = approveArtifact(openSubAccountDraft, {
  approvedBy: "ops-approver-4",
  approvedAt: "2026-08-27T09:31:40.000Z",
  signature: signBytes(
    null,
    Buffer.from(openSubAccountDraft.digest, "utf8"),
    APPROVER.privateKey,
  ).toString("base64url"),
  keyId: WRITE_APPROVER_KEY_ID,
  alg: "ed25519",
  // The human ticked the irreversible one. "Who approved the irreversible one" is an audit answer.
  acknowledgedEffects: ["READ", "WRITE_REVERSIBLE", "WRITE_IRREVERSIBLE"],
  acknowledgedGrade: "partial-up-to-irreversible",
  acknowledgedPromotions: ["MEMBER_RESTRICTED"],
});

// ---------------------------------------------------------------------------------------------
// The deployment's allowlist
// ---------------------------------------------------------------------------------------------
//
// Per ROUTE, and the three ceilings are not uniform on purpose. The policy chokepoint checks the
// route the action LANDS on, so the form page may be posted from and only the confirmation page may
// commit. A deployment that wanted this capability disabled changes one line here and every step
// that could write is refused before a browser is launched.

export const openSubAccountAllowlist: Allowlist = {
  originAliases: ["corebank"],
  routes: [
    {
      originAlias: "corebank",
      pathPattern: "/member/:memberId/subaccount/new",
      maxEffect: "WRITE_REVERSIBLE",
    },
    {
      originAlias: "corebank",
      pathPattern: "/member/:memberId/subaccount/confirm",
      maxEffect: "WRITE_IRREVERSIBLE",
    },
    {
      originAlias: "corebank",
      pathPattern: "/member/:memberId/subaccount/commit",
      maxEffect: "READ",
    },
  ],
  actionKinds: ["click", "type", "select", "navigate"],
  maxEffect: "WRITE_IRREVERSIBLE",
  /**
   * The ceiling on a run in `discovery` mode - which SPEC section 6.6 makes the VERIFICATION REPLAY
   * too, because that replay is the tail of the discovery run and shares its session boundary.
   *
   * `WRITE_REVERSIBLE` and not `READ`, because a verification replay of this flow has to be able to
   * raise the confirmation panel: that is where the descriptors, the checkpoints and the parameter
   * binding are exercised, and a run that could not post the form would verify nothing and grade
   * nothing. It is also not `WRITE_IRREVERSIBLE`, and the difference is the point - the commit is
   * refused TWICE over during verification: once by the dry-run boundary (the interpreter stops
   * before dispatch) and once here (an unapproved run may not commit even if the boundary moved).
   */
  discoveryMaxEffect: "WRITE_REVERSIBLE",
};

/** The member this flow is exercised against, and the deposit. Both obviously synthetic, both
 *  caller arguments, and neither appears anywhere in the sealed documents above. */
export const WRITE_MEMBER_ID = "10041";
export const WRITE_DEPOSIT = "250.00";
