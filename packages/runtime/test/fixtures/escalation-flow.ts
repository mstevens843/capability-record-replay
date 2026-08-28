// A flow that gets STUCK on purpose, so the escalation protocol has something real to escalate.
//
// Deliberately a separate fixture rather than a flag on `mock-flow`: that one is the interpreter's
// and eight other test files depend on its exact shape. This one adds the three things SPEC section
// 7 needs and `mock-flow` has no reason to carry - a step recovery that ESCALATES rather than
// remedying, a declared PRECONDITION on the step it escalates at, and a CONTINUITY value naming the
// member the run is about.
//
// The last two are the point. A hand-back is only checkable against something the step declared,
// and the two ways a helpful human breaks a run are exactly the two those fields cover: they wander
// off somewhere else (the precondition no longer holds) or they investigate a different member (the
// continuity value no longer holds). Both are invisible without a declaration to check against, and
// both produce a run that reads the right numbers off the wrong screen.

import {
  type CapabilityArtifact,
  type CapabilityContract,
  type NodeId,
  type Observation,
  type Predicate,
  type RouteId,
  type StepId,
  type UINode,
  approveArtifact,
  sealArtifact,
  sealContract,
} from "@crr/core";
import { IDS, SETTLE, formScope, node, screen, settled, targetOf, token } from "./mock-flow.js";

// ---------------------------------------------------------------------------------------------
// Nodes and screens
// ---------------------------------------------------------------------------------------------

export const EIDS = {
  memberIdField: IDS.memberIdField,
  searchButton: IDS.searchButton,
  /** The supervisor override the hold screen offers. A human presses it; the automation never does. */
  authorizeButton: "button:authorize" as NodeId,
  /** The way a helpful operator wanders off. */
  menuLink: "link:menu" as NodeId,
} as const;

/**
 * Geometry, which `mock-flow`'s helper does not supply and which this fixture needs.
 *
 * `deriveMaskRegions` turns a sensitive node into a rectangle, and a node with NO bounds is reported
 * as `unmaskable` - at which point `safeCaptureRequest` refuses to take a capture at all. That
 * refusal is correct and is asserted elsewhere in the suite; this is the other half, so the console
 * can also be shown taking a capture whose sensitive region really was blanked before the bytes
 * existed.
 */
const at = (n: UINode, x: number, y: number, w = 120, h = 20): UINode =>
  ({ ...n, bounds: { x, y, w, h, unit: "px" } }) as UINode;

const field = (value: string | null): UINode =>
  at(node({ id: EIDS.memberIdField, role: "textbox", name: "Member ID", value }), 10, 40);
const searchButton = at(
  node({ id: EIDS.searchButton, role: "button", name: "Search", text: "Search" }),
  10,
  70,
);

export const MEMBER_ID = "50001";
export const OTHER_MEMBER_ID = "60002";

export const escalationScreens: Readonly<Record<string, Observation>> = {
  blank: screen(0, { path: "/blank", nodes: [] }),
  search: screen(1, { path: "/search", nodes: [field(null), searchButton] }),
  "search-typed": screen(2, { path: "/search", nodes: [field(MEMBER_ID), searchButton] }),

  /**
   * The stuck screen. The core has put a supervisor hold on this member and the automation has no
   * entitlement to clear it - but a person at a terminal does, which is precisely SPEC section 7.2's
   * test for whether something is escalatable at all.
   */
  "search-hold": screen(3, {
    path: "/search",
    nodes: [
      field(MEMBER_ID),
      searchButton,
      node({
        id: "status:hold",
        role: "status",
        name: "",
        text: "Manual review required before this member can be searched",
      }),
      node({
        id: EIDS.authorizeButton,
        role: "button",
        name: "Authorize",
        text: "Authorize",
      }),
      node({ id: EIDS.menuLink, role: "link", name: "Main Menu", text: "Main Menu" }),
    ],
  }),

  /** The same hold screen mid-repaint. A hand-back against this must not be turned into a failure:
   *  "not yet" is not "not so", one level up from where the classifier says it. */
  "search-hold-loading": screen(7, {
    path: "/search",
    nodes: [field(MEMBER_ID), searchButton],
    settled: false,
  }),

  /** Where the operator ends up when they go and look something up. A different route entirely. */
  menu: screen(4, {
    path: "/menu",
    nodes: [node({ id: "link:menu-search", role: "link", name: "Member Search" })],
  }),

  results: screen(5, {
    path: "/results",
    nodes: [
      node({ id: IDS.openLink, role: "link", name: "Open", text: "Open" }),
      // The continuity anchor: the record the results are ABOUT, which is what turns "a results page
      // loaded" into "the results page for the member we were asked about".
      node({ id: "heading:member", role: "heading", name: `Member ${MEMBER_ID}` }),
      node({ id: "status:ok", role: "status", name: "1 record", text: "1 record" }),
    ],
  }),

  "results-empty": screen(6, {
    path: "/results",
    nodes: [
      node({ id: "heading:member", role: "heading", name: `Member ${MEMBER_ID}` }),
      node({ id: "status:none", role: "status", name: "", text: "No member found" }),
    ],
  }),
};

// ---------------------------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------------------------

export const escalationContract: CapabilityContract = sealContract({
  schemaVersion: "capability.contract/v1",
  name: "mock.member.find.escalating",
  version: "1.0.0",
  title: "Find a member (supervisor hold possible)",
  summary: "Searches for a member by number where the core may require a supervisor override.",
  whenToUse: ["You have a member number and need to know whether the core holds that record."],
  whenNotToUse: ["You do not have a member number."],
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
      name: "resultCount",
      type: { kind: "string" },
      required: true,
      description: "What the results banner says.",
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
  effect: "READ",
  requiresApproval: false,
  idempotent: true,
});

// ---------------------------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------------------------

const budgets = { perRecoveryMaxAttempts: {}, maxRemediationCycles: 2 } as const;

/**
 * The precondition on the escalating step, and the reason it is worth declaring.
 *
 * It is not belt and braces. It is the thing a hand-back is checked against: a step that says "I
 * need to be on the search route with a Search button in front of me" is a step whose execution can
 * be INTERRUPTED and resumed safely, and a step that says nothing is one that resumes into whatever
 * the human left on screen.
 */
const submitPrecondition: Predicate = {
  all: [
    settled,
    { kind: "route-matches", route: "search" as RouteId },
    {
      kind: "node-exists",
      where: { scope: formScope, role: "button", name: token("search-button") },
    },
  ],
} as Predicate;

export function escalationArtifact(): CapabilityArtifact {
  const draft = sealArtifact({
    schemaVersion: "capability.artifact/v1",
    artifactId: "mock-member-find-escalating",
    implements: {
      name: escalationContract.name,
      version: escalationContract.version,
      contractDigest: escalationContract.digest,
    },
    version: 1,
    target: {
      product: "MockBank",
      productVersionRange: ">=1.0 <2.0",
      surfaceKind: "web-legacy",
      requires: ["accessibility-tree", "containers", "route"],
      sessionProfile: "mock-teller",
    },
    lifecycle: { status: "draft", supersedes: null, approval: null },
    flow: {
      entry: {
        route: "search" as RouteId,
        precondition: { kind: "route-matches", route: "search" as RouteId } as Predicate,
      },
      routes: [
        { id: "search" as RouteId, originAlias: "corebank", path: "/search", frame: "content" },
        { id: "results" as RouteId, originAlias: "corebank", path: "/results", frame: "content" },
      ],
      vocabulary: {
        "member-id-field": ["Member ID"],
        "search-button": ["Search"],
        "authorize-button": ["Authorize"],
        "open-link": ["Open"],
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
          precondition: submitPrecondition,
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
            // The results have to be about the member we were asked about, and the run says so at
            // the checkpoint AND again on every hand-back.
            continuity: ["member"],
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
          recoveries: [
            {
              /**
               * A supervisor hold is not something a remedy can clear. The automation's own role
               * lacks the entitlement, there is no sequence of clicks that would grant it, and the
               * only honest remedy is a person - which is what `escalate` means and why the band is
               * `recoverable` rather than `environment`: band B1 turns an escalating environment
               * rule into a terminal `entitlement-denied` by design, because an environment
               * condition is about the SESSION. This one is about the RECORD, and a human at this
               * terminal really can finish the job.
               */
              name: "SUPERVISOR_HOLD",
              band: "recoverable",
              detect: {
                kind: "node-exists",
                where: { scope: formScope, role: "button", name: token("authorize-button") },
              } as Predicate,
              priority: 10,
              phase: "pre",
              remedy: {
                kind: "escalate",
                reason: "the core has placed a manual review hold on this member",
                brief:
                  "Clear the supervisor hold with the Authorize control, then hand back. Do not search a different member.",
              },
              maxAttempts: 1,
              allowUnsettled: false,
              afterRemedy: "reverify",
              resume: "escalate",
            },
          ],
          extract: [
            {
              output: "resultCount",
              from: "text@1",
              where: { scope: formScope, role: "status" },
              parse: "string@1",
              normalize: "std.text@1",
              onMissing: "fail",
            },
          ],
          budgets,
          evidence: { captureOn: ["failure", "outcome"] },
        },
      ],
      ambient: [],
    },
    continuity: [
      {
        id: "member",
        source: { from: "param", param: "memberId" },
        compare: {
          via: "std.text@1",
          type: { kind: "string", charset: "digits", minLength: 5, maxLength: 5 },
        },
      },
    ],
    provenance: {
      discoveryRunId: "run-mock-escalation",
      goalTemplate: "find member {memberId}",
      model: { adapter: "replay", modelId: "none:hand-authored", promptVersion: "n/a" },
      transcriptRef: null,
      recordedAt: "2026-02-11T14:03:22.000Z",
      recordedAgainst: {
        tenantId: "riverbend",
        appInstanceId: "riverbend-mock",
        fingerprint: {
          perStep: { "open-search": "fp:a", "enter-member-id": "fp:a", "submit-search": "fp:b" },
        },
      },
    },
    verification: {
      mode: "replay-full",
      status: "verified",
      coveredThroughStep: "submit-search" as StepId,
      grade: "full",
      runId: "run-mock-escalation-verify",
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
      routesTouched: ["search" as RouteId, "results" as RouteId],
      reads: [{ field: "resultCount", sensitivity: "internal" }],
      requiresApproval: false,
      restartSafeUpToPc: 3,
    },
    budgets: {
      maxActions: 20,
      maxObservations: 120,
      maxTotalRemediations: 4,
      maxProgramAttempts: 1,
      deadlineMs: 60_000,
    },
    signatures: [],
  });

  return approveArtifact(draft, {
    approvedBy: "ops-approver-mock",
    approvedAt: "2026-02-11T15:20:04.000Z",
    signature: "ed25519:bW9jay1zaWduYXR1cmU",
    keyId: "mock-key-1",
    alg: "ed25519",
    acknowledgedEffects: ["READ"],
    acknowledgedGrade: "full",
  });
}
