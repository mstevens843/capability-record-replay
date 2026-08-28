// A three-step flow whose three outputs sit at the three disclosure levels, and whose contract
// declares two business outcomes.
//
// It exists for two acceptance tests that `mock-flow.ts` cannot serve, and it is built from that
// file's own node/screen/target builders so the two corpora cannot drift into describing different
// worlds:
//
//   1. `renderForAgent` must be shown a REAL `ok` result carrying a `deliver`, a `mask` and a
//      `withhold` output at once. A hand-assembled document would prove the projection filters a
//      literal it was handed; a real run proves it filters what the interpreter actually extracted,
//      which is the assertion that matters.
//   2. The exhaustive-switch mechanism is only interesting with MORE THAN ONE outcome. One outcome
//      makes `switch (r.outcome)` trivially exhaustive and would let a widened `string` discriminant
//      pass unnoticed.
//
// The member name is OBVIOUSLY SYNTHETIC and says so on the screen, per BRIEF section 4.

import type {
  CapabilityArtifact,
  CapabilityContract,
  MockTransition,
  NodeId,
  Observation,
  Predicate,
  RouteId,
  StepId,
  UINode,
} from "@crr/core";
import { approveArtifact, sealArtifact, sealContract } from "@crr/core";
import { QUORUM, SETTLE, formScope, node, screen, settled, targetOf, token } from "./mock-flow.js";

export const DISCLOSURE_IDS = {
  memberIdField: "textbox:member-id" as NodeId,
  searchButton: "button:search" as NodeId,
} as const;

const searchNodes = (typed: string | null): readonly UINode[] => [
  node({ id: DISCLOSURE_IDS.memberIdField, role: "textbox", name: "Member ID", value: typed }),
  node({ id: DISCLOSURE_IDS.searchButton, role: "button", name: "Search", text: "Search" }),
];

/** The three outputs, one per disclosure level, each on its own named status line so a query can
 *  address exactly one of them. */
const resultNodes: readonly UINode[] = [
  node({ id: "status:count", role: "status", name: "Result Count", text: "1 record" }),
  node({
    id: "status:name",
    role: "status",
    name: "Member Name",
    text: "ALVAREZ, DANA (SYNTHETIC)",
  }),
  node({ id: "status:ref", role: "status", name: "Internal Ref", text: "IR-77" }),
];

export const disclosureScreens: Readonly<Record<string, Observation>> = {
  blank: screen(0, { path: "/blank", nodes: [] }),
  search: screen(1, { path: "/search", nodes: searchNodes(null) }),
  "search-typed": screen(2, { path: "/search", nodes: searchNodes("50001") }),
  results: screen(3, { path: "/results", nodes: [...resultNodes] }),
  "results-empty": screen(4, {
    path: "/results",
    nodes: [node({ id: "status:none", role: "status", name: "", text: "No member found" })],
  }),
  "results-restricted": screen(5, {
    path: "/results",
    nodes: [
      node({ id: "status:restricted", role: "status", name: "", text: "Membership is restricted" }),
    ],
  }),
};

export const disclosureContract: CapabilityContract = sealContract({
  schemaVersion: "capability.contract/v1",
  name: "mock.member.disclose",
  version: "1.0.0",
  title: "Read a member's disclosure sample",
  summary: "Reads three values about a member, one at each agent-disclosure level.",
  whenToUse: ["You have a member number and need the sample values this capability reads."],
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
    {
      name: "memberName",
      type: { kind: "string" },
      required: true,
      description: "The member's name as the core system holds it.",
      sensitivity: "sensitive",
      agentDisclosure: "mask",
    },
    {
      name: "internalRef",
      type: { kind: "string" },
      required: true,
      description: "An internal servicing reference the calling program files against the case.",
      sensitivity: "internal",
      agentDisclosure: "withhold",
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
    {
      code: "MEMBER_RESTRICTED",
      kind: "business_outcome",
      title: "The membership is restricted",
      summary: "The record exists and the core system will not release its position.",
      terminal: true,
      payload: [],
      // OPEN-QUESTIONS-RESOLVED Q1: a restriction is a fact about the RECORD and is still true on
      // the next attempt, so it is an answer. A session timeout is a fact about this attempt and is
      // not.
      stableUnderRetry: true,
      callerAction: "refer-to-specialist",
      retryable: "never",
      agentGuidance:
        "Tell the member their account needs a person at the credit union to look at it, and offer to put them through.",
    },
  ],
  effect: "READ",
  requiresApproval: false,
  idempotent: true,
});

const budgets = { perRecoveryMaxAttempts: {}, maxRemediationCycles: 1 } as const;

export function disclosureArtifact(): CapabilityArtifact {
  const draft = sealArtifact({
    schemaVersion: "capability.artifact/v1",
    artifactId: "mock-disclosure",
    implements: {
      name: disclosureContract.name,
      version: disclosureContract.version,
      contractDigest: disclosureContract.digest,
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
        "result-count": ["Result Count"],
        "member-name": ["Member Name"],
        "internal-ref": ["Internal Ref"],
        "not-found-banner": ["No member found"],
        "restricted-banner": ["Membership is restricted"],
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
          intent: "Submit and read the three values off the result banner.",
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
                {
                  kind: "node-exists",
                  where: { scope: formScope, role: "status", name: token("result-count") },
                },
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
            {
              code: "MEMBER_RESTRICTED",
              detect: {
                kind: "text-present",
                scope: formScope,
                text: token("restricted-banner"),
              } as Predicate,
              priority: 20,
              phase: "post",
              requiresSettled: true,
              capture: [],
            },
          ],
          recoveries: [],
          extract: [
            {
              output: "resultCount",
              from: "text@1",
              where: { scope: formScope, role: "status", name: token("result-count") },
              parse: "string@1",
              normalize: "std.text@1",
              onMissing: "fail",
            },
            {
              output: "memberName",
              from: "text@1",
              where: { scope: formScope, role: "status", name: token("member-name") },
              parse: "string@1",
              normalize: "std.text@1",
              onMissing: "fail",
            },
            {
              output: "internalRef",
              from: "text@1",
              where: { scope: formScope, role: "status", name: token("internal-ref") },
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
    continuity: [],
    provenance: {
      discoveryRunId: "run-disclosure",
      goalTemplate: "read the disclosure sample for member {memberId}",
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
          },
        },
      },
    },
    verification: {
      mode: "replay-full",
      status: "verified",
      coveredThroughStep: "submit-search" as StepId,
      grade: "full",
      runId: "run-disclosure-verify",
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
      reads: [
        { field: "resultCount", sensitivity: "internal" },
        { field: "memberName", sensitivity: "sensitive" },
        { field: "internalRef", sensitivity: "internal" },
      ],
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

/** The happy path, and the two that land on an outcome. */
export const DISCLOSURE_TRANSITIONS: readonly MockTransition[] = [
  { from: "blank", on: { kind: "navigate", path: "/search" }, to: "search" },
  {
    from: "search",
    on: { kind: "type", target: DISCLOSURE_IDS.memberIdField },
    to: "search-typed",
  },
  {
    from: "search-typed",
    on: { kind: "click", target: DISCLOSURE_IDS.searchButton },
    to: "results",
  },
];

export const DISCLOSURE_NOT_FOUND_TRANSITIONS: readonly MockTransition[] = [
  { from: "blank", on: { kind: "navigate", path: "/search" }, to: "search" },
  {
    from: "search",
    on: { kind: "type", target: DISCLOSURE_IDS.memberIdField },
    to: "search-typed",
  },
  {
    from: "search-typed",
    on: { kind: "click", target: DISCLOSURE_IDS.searchButton },
    to: "results-empty",
  },
];

export const DISCLOSURE_RESTRICTED_TRANSITIONS: readonly MockTransition[] = [
  { from: "blank", on: { kind: "navigate", path: "/search" }, to: "search" },
  {
    from: "search",
    on: { kind: "type", target: DISCLOSURE_IDS.memberIdField },
    to: "search-typed",
  },
  {
    from: "search-typed",
    on: { kind: "click", target: DISCLOSURE_IDS.searchButton },
    to: "results-restricted",
  },
];
