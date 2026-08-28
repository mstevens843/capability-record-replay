// A five-step flow whose fourth step OPENS A SUB-ACCOUNT, and that is the whole point of it.
//
// SPEC section 6.6's amendment to BRIEF section 3.4 only has teeth against a flow that really does
// something irreversible: a verification replay of a read capability can safely run twice, so a
// fixture made only of reads cannot demonstrate the thing being fixed. This one can. Replaying it
// end to end a second time opens a SECOND sub-account for the same member, which is precisely the
// harm the dry mode exists to prevent and precisely what `verify.test.ts` asserts does not happen.
//
// It is deliberately built on `mock-flow.ts`'s builders and its first four screens rather than
// being a second corpus: the interesting difference between the two artifacts should be the
// irreversible step and nothing else, so that a test which behaves differently against them is
// telling you about the effect class rather than about two unrelated fixtures.

import {
  type Allowlist,
  type CapabilityArtifact,
  type CapabilityContract,
  type EffectClass,
  type NodeId,
  type Observation,
  type Predicate,
  type RouteId,
  type StepId,
  type UINode,
  sealArtifact,
  sealContract,
} from "@crr/core";
import {
  IDS,
  QUORUM,
  SETTLE,
  formScope,
  node,
  screens as readScreens,
  screen,
  settled,
  targetOf,
  token,
} from "./mock-flow.js";

export const WRITE_IDS = {
  confirmButton: "button:confirm" as NodeId,
  newSubaccountBanner: "status:new-subaccount" as NodeId,
  openedBanner: "status:opened" as NodeId,
} as const;

/** The member the write flow is exercised against - the same obviously synthetic five digits the
 *  read fixture uses, so the two corpora describe one member and not two. */
export const WRITE_MEMBER_ID = "50001";

const newSubaccountNodes: readonly UINode[] = [
  node({
    id: WRITE_IDS.newSubaccountBanner,
    role: "status",
    name: `New sub-account for member ${WRITE_MEMBER_ID}`,
    text: `New sub-account for member ${WRITE_MEMBER_ID}`,
  }),
  node({ id: WRITE_IDS.confirmButton, role: "button", name: "Confirm", text: "Confirm" }),
];

const openedNodes: readonly UINode[] = [
  node({
    id: WRITE_IDS.openedBanner,
    role: "status",
    // The confirmation screen NAMES THE RECORD, which is the only reason save-time invariant 11 can
    // be satisfied at all: continuity turns "a confirmation page loaded" into "the confirmation page
    // for the member we were asked about". A vendor whose confirmation says only "Done" makes this
    // artifact unable to reach `draft`, and that refusal is the correct outcome, not a gap.
    name: `Sub-account SA-77120 opened for member ${WRITE_MEMBER_ID}`,
    text: `Sub-account SA-77120 opened for member ${WRITE_MEMBER_ID}`,
  }),
];

export const writeScreens: Readonly<Record<string, Observation>> = {
  blank: readScreens.blank as Observation,
  search: readScreens.search as Observation,
  "search-typed": readScreens["search-typed"] as Observation,
  results: readScreens.results as Observation,
  "new-subaccount": screen(20, { path: "/subaccount/new", nodes: newSubaccountNodes }),
  "subaccount-done": screen(21, { path: "/subaccount/done", nodes: openedNodes }),
};

/** The happy path, and nothing else. An unscripted action throws, so a run that clicks something
 *  this script does not describe fails loudly instead of quietly doing nothing. */
export const writeTransitions = [
  { from: "blank", on: { kind: "navigate", path: "/search" }, to: "search" },
  { from: "search", on: { kind: "type", target: IDS.memberIdField }, to: "search-typed" },
  { from: "search-typed", on: { kind: "click", target: IDS.searchButton }, to: "results" },
  { from: "results", on: { kind: "click", target: IDS.openLink }, to: "new-subaccount" },
  {
    from: "new-subaccount",
    on: { kind: "click", target: WRITE_IDS.confirmButton },
    to: "subaccount-done",
  },
  // Last, so the `from: "blank"` entry above still wins on the first navigate. This is the app's
  // real behaviour - the search screen is reachable from anywhere - and it is what lets a test run
  // the flow twice against ONE surface, which is the only way to assert "the write did not happen a
  // second time" rather than "the write did not happen".
  { on: { kind: "navigate", path: "/search" }, to: "search" },
] as const;

// ---------------------------------------------------------------------------------------------
// The documents
// ---------------------------------------------------------------------------------------------

export const writeContract: CapabilityContract = sealContract({
  schemaVersion: "capability.contract/v1",
  name: "mock.member.open_subaccount",
  version: "1.0.0",
  title: "Open a sub-account for a member",
  summary: "Opens a new savings sub-account against an existing member record.",
  whenToUse: ["The member has asked for a new sub-account and you have their member number."],
  whenNotToUse: [
    "You are only reading a balance.",
    "You do not have the member's explicit instruction to open an account.",
  ],
  inputs: [
    {
      name: "memberId",
      type: { kind: "string", charset: "digits", minLength: 5, maxLength: 5 },
      required: true,
      description: "The member's member number, five digits.",
      sensitivity: "sensitive",
      constraints: { charset: "digits", minLength: 5, maxLength: 5 },
      discoveredFrom: { goalSpan: "member {memberId}" },
    },
  ],
  outputs: [
    {
      name: "confirmation",
      type: { kind: "string" },
      required: true,
      description: "What the confirmation screen said, verbatim.",
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
      stableUnderRetry: true,
      callerAction: "retry-different-input",
      retryable: "with_different_inputs",
      agentGuidance: "Tell the member that number is not on file and ask them to read it again.",
    },
  ],
  effect: "WRITE_IRREVERSIBLE",
  requiresApproval: true,
  // Opening an account twice opens two accounts. Saying so in the contract is what lets a caller's
  // retry policy be right rather than optimistic.
  idempotent: false,
});

const budgets = { perRecoveryMaxAttempts: {}, maxRemediationCycles: 1 } as const;

export interface WriteFlowOptions {
  /** Lets a test move the irreversible step to pc 0, which is the one shape a dry run cannot
   *  verify anything about. */
  readonly irreversibleAt?: "confirm" | "open";
}

/**
 * The artifact, as synthesis emits it: `proposed`, with an UNVERIFIED plan in `verification`.
 *
 * That is the state build unit 15 exists to move out of, so a fixture that started anywhere else
 * would be testing the second half of the lifecycle against a document that had skipped the first.
 */
export function proposedWriteArtifact(options: WriteFlowOptions = {}): CapabilityArtifact {
  const writeAt = options.irreversibleAt ?? "confirm";
  const effectOf = (step: "open" | "confirm"): EffectClass =>
    step === writeAt ? "WRITE_IRREVERSIBLE" : "READ";
  const irreversibleStep = (writeAt === "open" ? "open-new-subaccount" : "confirm-open") as StepId;
  const irreversibleIndex = writeAt === "open" ? 3 : 4;

  return sealArtifact({
    schemaVersion: "capability.artifact/v1",
    artifactId: "mock-open-subaccount",
    implements: {
      name: writeContract.name,
      version: writeContract.version,
      contractDigest: writeContract.digest,
    },
    version: 1,
    target: {
      product: "MockBank",
      productVersionRange: ">=1.0 <2.0",
      surfaceKind: "web-legacy",
      requires: ["accessibility-tree", "containers", "route"],
      sessionProfile: "mock-teller",
    },
    lifecycle: { status: "proposed", supersedes: null, approval: null },
    flow: {
      entry: {
        route: "search" as RouteId,
        precondition: { kind: "route-matches", route: "search" as RouteId } as Predicate,
      },
      routes: [
        { id: "search" as RouteId, originAlias: "corebank", path: "/search", frame: "content" },
        { id: "results" as RouteId, originAlias: "corebank", path: "/results", frame: "content" },
        {
          id: "new-subaccount" as RouteId,
          originAlias: "corebank",
          path: "/subaccount/new",
          frame: "content",
        },
        {
          id: "done" as RouteId,
          originAlias: "corebank",
          path: "/subaccount/done",
          frame: "content",
        },
      ],
      vocabulary: {
        "member-id-field": ["Member ID"],
        "search-button": ["Search"],
        "open-link": ["Open"],
        "confirm-button": ["Confirm"],
        "not-found-banner": ["No member found"],
      },
      resumePoints: ["open-search" as StepId],
      steps: [
        {
          id: "open-search" as StepId,
          title: "Open the search screen",
          intent: "Get to the form.",
          effect: "READ",
          instruction: { kind: "navigate", route: "search" as RouteId },
          target: null,
          precondition: null,
          settle: SETTLE,
          expect: {
            predicate: {
              all: [settled, { kind: "route-matches", route: "search" as RouteId }],
            } as Predicate,
            delta: { mustChange: false, navigatedTo: "search" as RouteId },
            continuity: [],
          },
          outcomes: [],
          recoveries: [],
          extract: [],
          budgets,
          evidence: { captureOn: ["failure"] },
        },
        {
          id: "enter-member-id" as StepId,
          title: "Type the member number",
          intent: "Put the caller's number in the field.",
          effect: "READ",
          instruction: {
            kind: "fill",
            value: { from: "param", param: "memberId" },
            mode: "replace",
          },
          target: targetOf("textbox", "member-id-field", formScope, "Member ID"),
          precondition: null,
          settle: SETTLE,
          expect: { predicate: settled, delta: { mustChange: false }, continuity: [] },
          outcomes: [],
          recoveries: [],
          extract: [],
          budgets,
          evidence: { captureOn: ["failure"] },
        },
        {
          id: "submit-search" as StepId,
          title: "Run the search",
          intent: "Submit and wait for the grid.",
          effect: "READ",
          instruction: { kind: "activate" },
          target: targetOf("button", "search-button", formScope, "Search"),
          precondition: null,
          settle: SETTLE,
          expect: {
            predicate: {
              all: [
                settled,
                { kind: "route-matches", route: "results" as RouteId },
                { kind: "node-exists", where: { scope: formScope, role: "link" } },
              ],
            } as Predicate,
            delta: { mustChange: true, navigatedTo: "results" as RouteId },
            continuity: [],
          },
          outcomes: [
            {
              code: "MEMBER_NOT_FOUND",
              detect: {
                kind: "text-present",
                scope: formScope,
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
          budgets,
          evidence: { captureOn: ["failure", "outcome"] },
        },
        {
          id: "open-new-subaccount" as StepId,
          title: "Open the new sub-account form",
          intent: "Get to the confirmation form for a new sub-account.",
          effect: effectOf("open"),
          instruction: { kind: "activate" },
          target: targetOf("link", "open-link", formScope, "Open"),
          precondition: null,
          settle: SETTLE,
          expect: {
            predicate: {
              all: [
                settled,
                { kind: "route-matches", route: "new-subaccount" as RouteId },
                {
                  kind: "node-exists",
                  where: { scope: formScope, role: "button", name: token("confirm-button") },
                },
              ],
            } as Predicate,
            delta: { mustChange: true, navigatedTo: "new-subaccount" as RouteId },
            continuity: writeAt === "open" ? ["member"] : [],
          },
          outcomes: [],
          recoveries: [],
          extract: [],
          budgets,
          evidence: { captureOn: ["failure"] },
        },
        {
          id: "confirm-open" as StepId,
          title: "Confirm and open the sub-account",
          intent: "The irreversible one: this creates the account.",
          effect: effectOf("confirm"),
          instruction: { kind: "activate" },
          target: targetOf("button", "confirm-button", formScope, "Confirm"),
          // A real precondition, so that the "everything except dispatch" claim has something to
          // evaluate: the control the run is about to not press has to actually be there.
          precondition: {
            kind: "node-exists",
            where: { scope: formScope, role: "button", name: token("confirm-button") },
          } as Predicate,
          settle: SETTLE,
          expect: {
            predicate: {
              all: [settled, { kind: "route-matches", route: "done" as RouteId }],
            } as Predicate,
            delta: { mustChange: true, navigatedTo: "done" as RouteId },
            // Save-time invariant 11: the strongest control in the document is NOT optional on the
            // one step it exists to protect.
            continuity: ["member"],
          },
          outcomes: [],
          recoveries: [],
          extract: [
            {
              output: "confirmation",
              from: "text@1",
              where: { scope: formScope, role: "status" },
              parse: "string@1",
              normalize: "std.text@1",
              onMissing: "fail",
            },
          ],
          budgets,
          evidence: { captureOn: ["always"] },
        },
      ],
      ambient: [],
    },
    continuity: [
      {
        id: "member",
        source: { from: "param", param: "memberId" },
        compare: { via: "std.text@1", type: { kind: "string", charset: "digits" } },
      },
    ],
    provenance: {
      discoveryRunId: "run-mock-write",
      goalTemplate: "open a new sub-account for member {memberId}",
      model: { adapter: "replay", modelId: "none:hand-authored", promptVersion: "n/a" },
      transcriptRef: null,
      recordedAt: "2026-02-11T14:03:22.000Z",
      recordedAgainst: {
        tenantId: "riverbend",
        appInstanceId: "riverbend-mock",
        fingerprint: {
          perStep: {
            "open-search": "fp:a",
            "enter-member-id": "fp:a",
            "submit-search": "fp:b",
            "open-new-subaccount": "fp:c",
            "confirm-open": "fp:d",
          },
        },
      },
    },
    // The PLAN, exactly as `@crr/discovery`'s `emit.ts` writes it: a mode and a grade that nothing
    // has established yet. Build unit 15's job is to replace this with a record of a run.
    verification: {
      mode: "replay-dry",
      status: "unverified",
      coveredThroughStep: (writeAt === "open" ? "submit-search" : "open-new-subaccount") as StepId,
      grade: "partial-up-to-irreversible",
      runId: "run-mock-write",
      at: "2026-02-11T14:03:22.000Z",
    },
    policy: {
      originAliases: ["corebank"],
      maxEffect: "WRITE_IRREVERSIBLE",
      requiresApprovalToken: true,
      redaction: { taintedParams: ["memberId"], maskScreenshotRegions: true },
    },
    effects: {
      maxEffect: "WRITE_IRREVERSIBLE",
      irreversibleSteps: [irreversibleStep],
      routesTouched: [
        "search" as RouteId,
        "results" as RouteId,
        "new-subaccount" as RouteId,
        "done" as RouteId,
      ],
      reads: [{ field: "confirmation", sensitivity: "internal" }],
      requiresApproval: true,
      restartSafeUpToPc: irreversibleIndex,
    },
    budgets: {
      maxActions: 20,
      maxObservations: 120,
      maxTotalRemediations: 2,
      maxProgramAttempts: 1,
      deadlineMs: 60_000,
    },
    signatures: [],
  });
}

/**
 * The deployment's allowlist for the write flow.
 *
 * `discoveryMaxEffect` is a separate knob from `maxEffect` and it is the one that gates a
 * verification replay, because a verification run presents itself to the policy chokepoint as
 * `discovery` (see `replay.ts`). Left at `READ` by default, which is what makes a `replay-reset`
 * verification of this artifact something a deployment has to opt into rather than something that
 * happens because a reset hook was lying around.
 */
export function writeAllowlist(discoveryMaxEffect: EffectClass = "READ"): Allowlist {
  return {
    originAliases: ["corebank"],
    routes: [
      { originAlias: "corebank", pathPattern: "/search", maxEffect: "READ" },
      { originAlias: "corebank", pathPattern: "/results", maxEffect: "READ" },
      {
        originAlias: "corebank",
        pathPattern: "/subaccount/new",
        maxEffect: "WRITE_IRREVERSIBLE",
      },
      { originAlias: "corebank", pathPattern: "/subaccount/done", maxEffect: "READ" },
    ],
    actionKinds: ["click", "type", "navigate", "pressKey", "acceptDialog", "dismissDialog"],
    maxEffect: "WRITE_IRREVERSIBLE",
    discoveryMaxEffect,
  };
}

export { QUORUM };
