// The capability under test: one contract, one artifact, one allowlist.
//
// Seven steps over `fixtures/corebank-web`'s member-search flow, chosen so that every control in
// SPEC section 4.5 has exactly one step where it is the ONLY thing standing between the engine and
// a wrong answer:
//
//   · C1 (pre-act assertion, `rowKeyEquals`)  -> `open-member`
//   · C2 (continuity)                          -> `open-member`, `read-balance`
//   · C3 (scoped resolution)                   -> every target
//   · C4 (descriptor agreement)                -> `enter-member-id`, `open-member`
//   · C5 (effect delta)                        -> `open-share-position`
//
// `open-share-position` is the step that looks pointless and is not. Its checkpoint is satisfiable
// by the screen that was already there - a legacy tab panel that renders `0.00` until the tab it
// belongs to loads - so a dead control is indistinguishable from success by every control except
// the delta. That is SPEC section 4.5's W6, and it is the one sub-case neither rival proposal
// caught.

import {
  type Allowlist,
  type CapabilityArtifact,
  type CapabilityContract,
  type ContainerMatcher,
  type Descriptor,
  type ExtractSpec,
  type NodeQuery,
  type Predicate,
  type RouteId,
  type SettlePolicy,
  type StepId,
  type TargetRef,
  approveArtifact,
  sealArtifact,
  sealContract,
} from "@crr/core";
import { unverifiedTrust } from "@crr/runtime";
import {
  DETAIL_SCOPE,
  DIALOG_SCOPE,
  RESULTS_SCOPE,
  RESULTS_TABLE_SCOPE,
  SEARCH_SCOPE,
  token,
} from "./build.js";

const SEARCH = "search" as RouteId;
const RESULTS = "results" as RouteId;
const DETAIL = "detail" as RouteId;

const settled: Predicate = { kind: "settled" };
const onRoute = (route: RouteId): Predicate => ({ kind: "route-matches", route });
const exists = (where: NodeQuery): Predicate => ({ kind: "node-exists", where });
const textIn = (scope: ContainerMatcher, tok: string): Predicate =>
  ({ kind: "text-present", scope, text: token(tok) }) as Predicate;
/** The field the step just wrote into is not flagged by the application's own validator. */
const notFlagged = (fieldToken: string): Predicate =>
  ({
    kind: "node-state",
    where: { scope: SEARCH_SCOPE, role: "textbox", name: token(fieldToken) },
    state: "invalid",
    equals: false,
  }) as Predicate;

/**
 * Two agreeing descriptors, resting on two INDEPENDENT pieces of evidence.
 *
 * The floor is the pair, not the count. Three descriptors that all read the same label are a quorum
 * of one, and `distinctEvidenceSources` is the field that says so - which is why the correlated
 * scenario in this suite is a `target-underdetermined` refusal rather than a confident click.
 */
const QUORUM = {
  min: 2,
  distinctEvidenceSources: 2,
  requireIdentical: true,
  onUnderQuorum: "fail",
  expectUnique: true,
} as const;

// ---------------------------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------------------------

/**
 * A form field, described three ways.
 *
 * `role-name` and `label-anchored` are DELIBERATELY correlated here: the field's accessible name is
 * computed from the very label the second descriptor anchors on, so the resolver folds them into
 * one piece of evidence. The ordinal is what makes the quorum reachable at all - and the day the
 * vendor adds a second form to the page, it abstains and the target correctly refuses.
 */
const fieldTarget = (nameToken: string, recordedName: string, labelId: string): TargetRef => {
  const descriptors: readonly Descriptor[] = [
    {
      id: `${nameToken}-by-name`,
      kind: "role-name",
      evidenceSource: "accessibleName",
      role: "textbox",
      name: token(nameToken),
    },
    {
      id: `${nameToken}-by-label`,
      kind: "label-anchored",
      evidenceSource: "labelText",
      label: token(nameToken),
      role: "textbox",
      relation: "labelled-by",
      maxDistance: { unit: "px", value: 240 },
    },
    {
      id: `${nameToken}-by-ordinal`,
      kind: "ordinal-in-container",
      evidenceSource: "ordinal",
      container: SEARCH_SCOPE,
      role: "textbox",
      index: nameToken === "member-id-field" ? 0 : 1,
    },
  ] as readonly Descriptor[];
  return {
    scope: SEARCH_SCOPE,
    role: "textbox",
    descriptors,
    quorum: QUORUM,
    assert: { role: "textbox", name: token(nameToken), enabled: true, visible: true },
    recordedNode: {
      ariaRole: "textbox",
      name: recordedName,
      containerPath: [
        { kind: "frame", name: "content" },
        { kind: "landmark", role: "form", name: "Member Search" },
      ],
      tablePosition: null,
      boundsBucket: null,
    },
  } as unknown as TargetRef;
};

const buttonTarget = (nameToken: string, recordedName: string): TargetRef =>
  ({
    scope: SEARCH_SCOPE,
    role: "button",
    descriptors: [
      {
        id: `${nameToken}-by-name`,
        kind: "role-name",
        evidenceSource: "accessibleName",
        role: "button",
        name: token(nameToken),
      },
      {
        id: `${nameToken}-by-ordinal`,
        kind: "ordinal-in-container",
        evidenceSource: "ordinal",
        container: SEARCH_SCOPE,
        role: "button",
        index: 0,
      },
    ],
    quorum: QUORUM,
    assert: { role: "button", name: token(nameToken), enabled: true, visible: true },
    recordedNode: {
      ariaRole: "button",
      name: recordedName,
      containerPath: [
        { kind: "frame", name: "content" },
        { kind: "landmark", role: "form", name: "Member Search" },
      ],
      tablePosition: null,
      boundsBucket: null,
    },
  }) as unknown as TargetRef;

/**
 * The row link, and the most dangerous target in the flow.
 *
 * `rowKeyEquals` binds the identity of the thing we click to the caller's OWN argument. You cannot
 * click the wrong member's row when the row is selected by the member id the caller asked about -
 * which converts SPEC section 4.5's W1 from a silent misclick into a loud pre-act refusal, and
 * costs one predicate evaluation.
 */
const rowLinkTarget: TargetRef = {
  scope: RESULTS_TABLE_SCOPE,
  role: "link",
  descriptors: [
    {
      id: "open-link-by-name",
      kind: "role-name",
      evidenceSource: "accessibleName",
      role: "link",
      name: token("open-link"),
    },
    {
      id: "open-link-by-row",
      kind: "table-cell",
      evidenceSource: "columnHeader",
      table: RESULTS_TABLE_SCOPE,
      rowKey: {
        columnHeader: token("member-id-column"),
        value: { from: "param", param: "memberId" },
      },
      columnHeader: token("action-column"),
      childRole: "link",
      headerProvenance: "columnheader-role",
    },
    {
      id: "open-link-by-ordinal",
      kind: "ordinal-in-container",
      evidenceSource: "ordinal",
      container: RESULTS_TABLE_SCOPE,
      role: "link",
      index: 0,
    },
  ],
  quorum: QUORUM,
  assert: {
    role: "link",
    name: token("open-link"),
    enabled: true,
    visible: true,
    rowKeyEquals: {
      columnHeader: token("member-id-column"),
      value: { from: "param", param: "memberId" },
    },
  },
  recordedNode: {
    ariaRole: "link",
    name: "Open",
    containerPath: [
      { kind: "frame", name: "content" },
      { kind: "landmark", role: "region", name: "Search Results" },
      { kind: "table", headers: ["Member ID", "Name", "Share Balance", "Status", "Action"] },
    ],
    tablePosition: { rowHeader: null, colHeader: "Action" },
    boundsBucket: null,
  },
} as unknown as TargetRef;

const sharesTabTarget: TargetRef = {
  scope: DETAIL_SCOPE,
  role: "tab",
  descriptors: [
    {
      id: "share-tab-by-name",
      kind: "role-name",
      evidenceSource: "accessibleName",
      role: "tab",
      name: token("share-tab"),
    },
    {
      id: "share-tab-by-ordinal",
      kind: "ordinal-in-container",
      evidenceSource: "ordinal",
      container: DETAIL_SCOPE,
      role: "tab",
      index: 0,
    },
  ],
  quorum: QUORUM,
  assert: { role: "tab", name: token("share-tab"), enabled: true, visible: true },
  recordedNode: {
    ariaRole: "tab",
    name: "Share Position",
    containerPath: [
      { kind: "frame", name: "content" },
      { kind: "landmark", role: "region", name: "Member Detail" },
    ],
    tablePosition: null,
    boundsBucket: null,
  },
} as unknown as TargetRef;

const noticeButtonTarget: TargetRef = {
  scope: DIALOG_SCOPE,
  role: "button",
  descriptors: [
    {
      id: "notice-ack-by-name",
      kind: "role-name",
      evidenceSource: "accessibleName",
      role: "button",
      name: token("notice-ack-button"),
    },
    {
      id: "notice-ack-by-ordinal",
      kind: "ordinal-in-container",
      evidenceSource: "ordinal",
      container: DIALOG_SCOPE,
      role: "button",
      index: 0,
    },
  ],
  quorum: QUORUM,
  assert: { role: "button", name: token("notice-ack-button"), enabled: true, visible: true },
  recordedNode: {
    ariaRole: "button",
    name: "Acknowledge",
    containerPath: [
      { kind: "frame", name: "content" },
      { kind: "landmark", role: "dialog", name: "System Notice" },
    ],
    tablePosition: null,
    boundsBucket: null,
  },
} as unknown as TargetRef;

// ---------------------------------------------------------------------------------------------
// The contract - what the calling agent sees. Zero surface detail.
// ---------------------------------------------------------------------------------------------

export const contract: CapabilityContract = sealContract({
  schemaVersion: "capability.contract/v1",
  name: "corebank.member.share_position",
  version: "1.0.0",
  title: "Look up a member's share position",
  summary:
    "Finds a member by member number in the core banking teller application and reports the share balance on their primary share account.",
  whenToUse: [
    "A member has given you their member number and is asking about the balance on their share account.",
  ],
  whenNotToUse: [
    "You do not have a member number - this capability cannot search by name or by tax id.",
    "The member is asking about a loan or a certificate; those are different capabilities.",
  ],
  inputs: [
    {
      name: "memberId",
      type: { kind: "string", charset: "digits", minLength: 5, maxLength: 5 },
      required: true,
      description: "The member's member number, exactly five digits.",
      sensitivity: "sensitive",
      constraints: { charset: "digits", minLength: 5, maxLength: 5 },
      discoveredFrom: { goalSpan: "member {memberId}" },
    },
  ],
  outputs: [
    {
      name: "shareBalance",
      type: { kind: "money", currency: "USD" },
      required: true,
      description: "The available balance on the member's primary share account.",
      sensitivity: "sensitive",
      agentDisclosure: "deliver",
    },
    {
      name: "memberName",
      type: { kind: "string" },
      required: true,
      description: "The member's name as the core holds it, for read-back confirmation.",
      sensitivity: "sensitive",
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
      stableUnderRetry: true,
      origin: "hand-authored",
      callerAction: "retry-different-input",
      retryable: "with_different_inputs",
      agentGuidance:
        "Tell the member that number is not on file and ask them to read it back to you.",
    },
    {
      code: "INVALID_MEMBER_ID",
      kind: "business_outcome",
      title: "The member number is not the right shape",
      summary: "The teller application rejected the member number before searching for it.",
      terminal: true,
      payload: [],
      stableUnderRetry: true,
      origin: "hand-authored",
      callerAction: "retry-different-input",
      retryable: "with_different_inputs",
      agentGuidance: "Ask the member for their five-digit member number and call this again.",
    },
    {
      code: "INVALID_BRANCH_CODE",
      kind: "business_outcome",
      title: "The branch code is not enabled here",
      summary: "The teller application rejected the branch this capability searches under.",
      terminal: true,
      payload: [],
      stableUnderRetry: true,
      origin: "hand-authored",
      callerAction: "refer-to-specialist",
      retryable: "never",
      agentGuidance: "Nothing the caller can supply changes this; raise it with the branch admin.",
    },
    {
      code: "MEMBER_RESTRICTED",
      kind: "business_outcome",
      title: "The member record is restricted",
      summary: "The record is flagged and only a member services specialist may service it.",
      terminal: true,
      payload: [],
      stableUnderRetry: true,
      origin: "hand-authored",
      callerAction: "refer-to-specialist",
      retryable: "never",
      agentGuidance: "Tell the member a specialist has to help with this account, and transfer.",
    },
  ],
  effect: "READ",
  requiresApproval: false,
  idempotent: true,
});

// ---------------------------------------------------------------------------------------------
// The artifact - what the interpreter runs
// ---------------------------------------------------------------------------------------------

/**
 * The BASELINE settle policy. `stableSamples: 2` is SPEC section 13 Q6's placeholder, and this is
 * the constant the `settle-sweep` measurement varies to decide it - which is why `FlowOptions`
 * carries an override rather than the number being written into seven step literals.
 *
 * `pollIntervalMs: 50` is not a duration anybody waits: the harness runs on a manual clock, so a
 * poll interval is a unit of SAMPLING, and the sweep reads the poll COUNT rather than the wall
 * clock. That is the only honest thing to measure over a mock surface.
 */
const SETTLE = { stableSamples: 2, pollIntervalMs: 50, maxWaitMs: 2_000 } as const;

const shareBalanceExtract: ExtractSpec = {
  output: "shareBalance",
  from: "text@1",
  where: { scope: DETAIL_SCOPE, role: "status" },
  parse: "moneyUSD@1",
  normalize: "std.money@1",
  onMissing: "fail",
} as ExtractSpec;

const memberNameExtract: ExtractSpec = {
  output: "memberName",
  from: "text@1",
  where: { scope: DETAIL_SCOPE, role: "text" },
  parse: "string@1",
  // `std.identity@1` rather than `std.text@1`: a name read back to a member on the phone is the
  // one output in this contract where case and spacing are part of the answer.
  normalize: "std.identity@1",
  onMissing: "fail",
} as ExtractSpec;

export interface FlowOptions {
  /** `0` makes every ambient recovery inert - a real trap, and therefore reproducible. */
  readonly maxRemediationCycles?: number;
  /**
   * Field-wise override of the baseline settle policy, applied to EVERY step.
   *
   * Exists for one caller: `settle-sweep.ts`, which has to run the same flow at several values of
   * `stableSamples` to answer the question SPEC section 13 Q6 deliberately refused to answer from
   * a chair. Applied to every step rather than one because a quiescence policy that is only
   * measured on the step you suspected is a policy measured against your own prior.
   */
  readonly settle?: Partial<SettlePolicy>;
  readonly noticeMaxAttempts?: number;
  readonly maxProgramAttempts?: number;
  readonly deadlineMs?: number;
}

export function artifact(options: FlowOptions = {}): CapabilityArtifact {
  const settle = { ...SETTLE, ...(options.settle ?? {}) } as SettlePolicy;
  const budgets = {
    perRecoveryMaxAttempts: {},
    maxRemediationCycles: options.maxRemediationCycles ?? 3,
  } as const;
  const evidence = { captureOn: ["failure", "outcome"] } as const;

  const draft = sealArtifact({
    schemaVersion: "capability.artifact/v1",
    artifactId: "corebank-member-share-position",
    implements: {
      name: contract.name,
      version: contract.version,
      contractDigest: contract.digest,
    },
    version: 1,
    target: {
      product: "CoreBank Teller",
      productVersionRange: ">=8.0 <9.0",
      surfaceKind: "web-legacy",
      requires: ["accessibility-tree", "containers", "route", "table-position"],
      sessionProfile: "teller",
    },
    lifecycle: { status: "draft", supersedes: null, approval: null },
    flow: {
      entry: { route: SEARCH, precondition: onRoute(SEARCH) },
      routes: [
        { id: SEARCH, originAlias: "corebank", path: "/teller/search", frame: "content" },
        { id: RESULTS, originAlias: "corebank", path: "/teller/results", frame: "content" },
        { id: DETAIL, originAlias: "corebank", path: "/teller/detail", frame: "content" },
      ],
      // THE MULTI-TENANT HINGE. Every matcher below names a token; an overlay replaces the token's
      // synonym list, so the summit tenant that says "Member #" and "Find" needs nine lines rather
      // than an edit at forty matchers.
      vocabulary: {
        "member-id-field": ["Member ID"],
        "branch-field": ["Branch Code"],
        "search-button": ["Search"],
        "results-region": ["Search Results"],
        "detail-region": ["Member Detail"],
        "member-id-column": ["Member ID"],
        "name-column": ["Name"],
        "action-column": ["Action"],
        "open-link": ["Open"],
        "share-tab": ["Share Position"],
        // Both spellings are real: the grid says "0 records found" while it is still painting and
        // "No members matched" when the search really came back empty. Declaring both is honest
        // about what the app says - and it is precisely why the quiescence gate has to run first.
        "not-found-banner": ["No members matched", "0 records found"],
        "member-invalid-banner": ["Member ID must be"],
        "branch-invalid-banner": ["Branch code is not enabled"],
        "restricted-banner": ["This member record is restricted"],
        "entitlement-banner": ["not entitled to function"],
        "app-error-banner": ["Server Error in"],
        "signin-banner": ["Your session has expired"],
        "notice-dialog": ["System Notice"],
        "notice-ack-button": ["Acknowledge"],
      },
      resumePoints: ["open-search" as StepId],
      steps: [
        {
          id: "open-search" as StepId,
          title: "Open the member search screen",
          intent: "Get to the search form in the content frame.",
          effect: "READ",
          instruction: { kind: "navigate", route: SEARCH },
          target: null,
          precondition: null,
          settle,
          expect: {
            predicate: { all: [settled, onRoute(SEARCH)] } as Predicate,
            delta: { mustChange: false, navigatedTo: SEARCH },
            continuity: [],
          },
          outcomes: [],
          recoveries: [],
          extract: [],
          budgets,
          evidence,
        },
        {
          id: "enter-member-id" as StepId,
          title: "Type the member number",
          intent: "Put the caller's member number in the Member ID field.",
          effect: "READ",
          instruction: {
            kind: "fill",
            value: { from: "param", param: "memberId" },
            mode: "replace",
          },
          target: fieldTarget("member-id-field", "Member ID", "member-id-label"),
          precondition: null,
          settle,
          expect: {
            // The checkpoint on both fill steps is IDENTICAL, and that is the point: what separates
            // row 4 from row 5 is not the screen, not the detector and not the postcondition. It is
            // where the rejected value came from.
            predicate: { all: [settled, notFlagged("member-id-field")] } as Predicate,
            delta: { mustChange: false },
            continuity: [],
          },
          // ROW 4. The value the app rejected is the CALLER's, so this is an answer they can act on.
          outcomes: [
            {
              code: "INVALID_MEMBER_ID",
              detect: textIn(SEARCH_SCOPE, "member-invalid-banner"),
              priority: 10,
              phase: "post",
              requiresSettled: true,
              origin: "hand-authored",
              capture: [],
            },
          ],
          recoveries: [],
          extract: [],
          budgets,
          evidence,
        },
        {
          id: "enter-branch-code" as StepId,
          title: "Type the branch code the capability searches under",
          intent: "Scope the search to the branch this capability was recorded against.",
          effect: "READ",
          instruction: {
            kind: "fill",
            value: { from: "literal", value: "0042", sensitivity: "public" },
            mode: "replace",
          },
          target: fieldTarget("branch-field", "Branch Code", "branch-label"),
          precondition: null,
          settle,
          expect: {
            predicate: { all: [settled, notFlagged("branch-field")] } as Predicate,
            delta: { mustChange: false },
            continuity: [],
          },
          // ROW 5, and the detector is declared IDENTICALLY to row 4's on purpose. The classifier
          // must refuse to promote it, not because the detector is different, but because the
          // rejected value came from the artifact and no caller can fix it. Binding provenance is
          // the only input that can tell these two apart.
          outcomes: [
            {
              code: "INVALID_BRANCH_CODE",
              detect: textIn(SEARCH_SCOPE, "branch-invalid-banner"),
              priority: 10,
              phase: "post",
              requiresSettled: true,
              origin: "hand-authored",
              capture: [],
            },
          ],
          recoveries: [],
          extract: [],
          budgets,
          evidence,
        },
        {
          id: "submit-search" as StepId,
          title: "Run the search",
          intent: "Submit the form and wait for the results grid.",
          effect: "READ",
          instruction: { kind: "activate" },
          target: buttonTarget("search-button", "Search"),
          precondition: null,
          settle,
          expect: {
            predicate: {
              // A CELL, not the link. The grid arriving is this step's postcondition; whether the
              // row carries an action link is the NEXT step's target problem, and conflating them
              // reports a missing control as "the search did not finish".
              all: [
                settled,
                onRoute(RESULTS),
                exists({ scope: RESULTS_TABLE_SCOPE, role: "cell" }),
              ],
            } as Predicate,
            delta: { mustChange: true, navigatedTo: RESULTS },
            continuity: [],
          },
          outcomes: [
            {
              code: "MEMBER_NOT_FOUND",
              detect: textIn(RESULTS_SCOPE, "not-found-banner"),
              priority: 10,
              phase: "post",
              requiresSettled: true,
              origin: "hand-authored",
              capture: [],
            },
          ],
          recoveries: [],
          extract: [],
          budgets,
          evidence,
        },
        {
          id: "open-member" as StepId,
          title: "Open the member's record",
          intent: "Follow the action link on the row for the member we were asked about.",
          effect: "READ",
          instruction: { kind: "activate" },
          target: rowLinkTarget,
          precondition: null,
          settle,
          expect: {
            predicate: {
              all: [settled, onRoute(DETAIL), exists({ scope: DETAIL_SCOPE, role: "heading" })],
            } as Predicate,
            delta: { mustChange: true, navigatedTo: DETAIL },
            // C2. Not "a member detail page loaded" but THE member detail page for the member we
            // were asked about - which is what catches the core silently correcting the id.
            continuity: ["subjectMember"],
          },
          outcomes: [
            {
              code: "MEMBER_RESTRICTED",
              detect: textIn(DETAIL_SCOPE, "restricted-banner"),
              priority: 10,
              phase: "post",
              requiresSettled: true,
              origin: "hand-authored",
              capture: [],
            },
          ],
          recoveries: [],
          extract: [],
          budgets,
          evidence,
        },
        {
          id: "open-share-position" as StepId,
          title: "Open the share position tab",
          intent: "Reveal the share balance panel.",
          effect: "READ",
          instruction: { kind: "activate" },
          target: sharesTabTarget,
          precondition: null,
          settle,
          expect: {
            // Deliberately satisfiable by the screen that was already there. The panel exists before
            // the tab loads and reads `0.00`; only the delta knows the click did anything.
            predicate: {
              all: [settled, onRoute(DETAIL), exists({ scope: DETAIL_SCOPE, role: "status" })],
            } as Predicate,
            delta: { mustChange: true },
            continuity: [],
          },
          outcomes: [],
          recoveries: [],
          extract: [shareBalanceExtract],
          budgets,
          evidence,
        },
        {
          id: "read-balance" as StepId,
          title: "Read the member's name back",
          intent: "Confirm the record we read belongs to the member we were asked about.",
          effect: "READ",
          instruction: { kind: "read" },
          target: null,
          precondition: null,
          settle,
          expect: {
            predicate: { all: [settled, onRoute(DETAIL)] } as Predicate,
            delta: { mustChange: false },
            continuity: ["subjectMember"],
          },
          outcomes: [],
          recoveries: [],
          extract: [memberNameExtract],
          budgets,
          evidence,
        },
      ],
      ambient: [
        {
          name: "SESSION_EXPIRED",
          band: "environment",
          detect: textIn(DETAIL_SCOPE, "signin-banner"),
          priority: 10,
          // `post`, not `both`. In a straight-line program the PRE observation of step N is the POST
          // observation of step N-1 - nothing acts in between - so declaring an environment rule
          // `post` loses no detection and gains the thing that matters here: after a restart, pc 0
          // is not re-classified against the sign-in screen it is about to navigate away from.
          phase: "post",
          remedy: { kind: "reauthenticate" },
          maxAttempts: 1,
          // An expired-session screen is WHY the surface will never settle, so it is one of the two
          // conditions allowed to be classified against an unsettled screen.
          allowUnsettled: true,
          afterRemedy: "reverify",
          // ROW 12. Not `retry-step`: a step retried inside a session that has just been re-opened
          // is a step whose earlier screens never happened. The supervisor discards the machine and
          // runs the program again from pc 0 against a FRESH brokered session, which is the only
          // honest resumption for a flow whose first four steps typed the search back in.
          resume: "restart-program",
        },
        {
          name: "ROLE_NOT_ENTITLED",
          band: "environment",
          detect: textIn(DETAIL_SCOPE, "entitlement-banner"),
          priority: 20,
          phase: "both",
          // ROW 8. Escalate, because it is a property of the session's role: it will fail
          // identically for every input forever and the fix is a person changing an entitlement.
          // An UNDECLARED denial defaults to this too, which is fail-closed in its most
          // consequential instance.
          remedy: {
            kind: "escalate",
            reason: "entitlement",
            brief: "the teller role lacks VIEW_SHARE_POSITION",
          },
          maxAttempts: 1,
          allowUnsettled: true,
          afterRemedy: "reverify",
          resume: "escalate",
        },
        {
          name: "APP_ERROR_PAGE",
          band: "environment",
          detect: textIn(DETAIL_SCOPE, "app-error-banner"),
          priority: 30,
          phase: "both",
          remedy: { kind: "actions", instructions: [{ kind: "navigate", route: SEARCH }] },
          maxAttempts: 1,
          allowUnsettled: true,
          afterRemedy: "reverify",
          resume: "restart-program",
        },
        {
          name: "DISMISS_SYSTEM_NOTICE",
          band: "interception",
          detect: exists({
            scope: DIALOG_SCOPE,
            role: "button",
            name: token("notice-ack-button"),
          }),
          priority: 40,
          phase: "both",
          remedy: {
            kind: "actions",
            instructions: [{ kind: "activate", target: noticeButtonTarget }],
          },
          maxAttempts: options.noticeMaxAttempts ?? 2,
          allowUnsettled: false,
          afterRemedy: "reverify",
          // `retry-step` recovers an interstitial that is in the way BEFORE the step acts, and it
          // is the right resumption for that case: dismiss the modal, resolve the same field again,
          // carry on.
          //
          // It cannot recover one that appears AFTER the step acted. Re-running the step re-resolves
          // a target the action has already navigated away from, and the engine reports
          // `target-not-found` for a run that has in fact recovered. SPEC section 3 has no
          // `resume: "continue"` - re-verify without re-dispatching - and
          // docs/design/RUNTIME-STATUS.md section 7.2 already names its absence as the highest-value
          // open design question in the repo. Scenario 25 pins the gap so that the day the mode
          // exists, a test says so.
          resume: "retry-step",
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
      discoveryRunId: "run-conformance-corpus",
      goalTemplate: "look up the share balance for member {memberId}",
      model: { adapter: "replay", modelId: "none:hand-authored", promptVersion: "n/a" },
      transcriptRef: null,
      recordedAt: "2026-02-11T14:03:22.000Z",
      recordedAgainst: {
        tenantId: "riverbend",
        appInstanceId: "riverbend-teller",
        fingerprint: {
          perStep: {
            "open-search": "fp:s0",
            "enter-member-id": "fp:s1",
            "enter-branch-code": "fp:s2",
            "submit-search": "fp:s3",
            "open-member": "fp:s4",
            "open-share-position": "fp:s5",
            "read-balance": "fp:s6",
          },
        },
      },
    },
    verification: {
      mode: "replay-full",
      status: "verified",
      coveredThroughStep: "read-balance" as StepId,
      grade: "full",
      runId: "run-conformance-verify",
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
      routesTouched: [SEARCH, RESULTS, DETAIL],
      reads: [
        { field: "shareBalance", sensitivity: "sensitive" },
        { field: "memberName", sensitivity: "sensitive" },
      ],
      requiresApproval: false,
      restartSafeUpToPc: 7,
    },
    budgets: {
      maxActions: 40,
      maxObservations: 400,
      maxTotalRemediations: 6,
      maxProgramAttempts: options.maxProgramAttempts ?? 2,
      deadlineMs: options.deadlineMs ?? 60_000,
    },
    promotions: [],
    signatures: [],
  });

  return approveArtifact(draft, {
    approvedBy: "ops-approver-conformance",
    approvedAt: "2026-02-11T15:20:04.000Z",
    signature: "ed25519:Y29uZm9ybWFuY2Utc2lnbmF0dXJl",
    keyId: "conformance-key-1",
    alg: "ed25519",
    acknowledgedEffects: ["READ"],
    acknowledgedGrade: "full",
    acknowledgedPromotions: [],
  });
}

export const allowlist: Allowlist = {
  originAliases: ["corebank"],
  routes: [
    { originAlias: "corebank", pathPattern: "/teller/search", maxEffect: "READ" },
    { originAlias: "corebank", pathPattern: "/teller/results", maxEffect: "READ" },
    { originAlias: "corebank", pathPattern: "/teller/detail", maxEffect: "READ" },
  ],
  actionKinds: ["click", "type", "navigate", "pressKey", "acceptDialog", "dismissDialog"],
  maxEffect: "READ",
  discoveryMaxEffect: "READ",
};

/** The signature is not verified here and the name says so: this corpus grades the ENGINE, and
 *  `@crr/runtime`'s `approval.test.ts` is where the crypto is under test. */
export const trust = unverifiedTrust(["conformance-key-1"]);
