// A tiny flow and a frozen corpus, for exercising the INTERPRETER with no browser anywhere.
//
// The point of the pure/impure split is that everything which has to be RIGHT is a function over a
// frozen observation. This file is the other half of that bargain: the things that have to be TIMELY
// - the settle loop, the ledgers, the lease, the remediation cycle, the journal - are exercised
// against a scripted surface that runs in microseconds and cannot flake, so the browser suite is
// left to prove only the one thing it alone can prove.
//
// Deliberately NOT the corebank artifact. That one is realistic and therefore large; this one is
// three steps and is arranged so each test can put exactly one thing wrong.

import {
  type CapabilityArtifact,
  type CapabilityContract,
  type ContainerMatcher,
  type NodeId,
  type Observation,
  type Predicate,
  type RouteId,
  type StepId,
  type TargetRef,
  type TextMatcher,
  type UINode,
  approveArtifact,
  sealArtifact,
  sealContract,
  skeletonDigestOf,
} from "@crr/core";
import type { Allowlist } from "@crr/core";
import { unverifiedTrust } from "../../src/approval.js";

// ---------------------------------------------------------------------------------------------
// Node and observation builders
// ---------------------------------------------------------------------------------------------

const FRAME = { kind: "frame", name: "content" } as const;
const FORM = { kind: "landmark", role: "form", name: "Member Search" } as const;

export interface NodeSpec {
  readonly id: string;
  readonly role: UINode["ariaRole"];
  readonly name?: string;
  readonly value?: string | null;
  readonly text?: string | null;
  readonly inDialog?: boolean;
  readonly disabled?: boolean;
  readonly masked?: boolean;
  readonly checked?: boolean | null;
  readonly children?: readonly string[];
}

const DIALOG = { kind: "landmark", role: "dialog", name: "System Notice" } as const;

export function node(spec: NodeSpec): UINode {
  return {
    id: spec.id as NodeId,
    rawRole: spec.role ?? "generic",
    ariaRole: spec.role,
    name: spec.name ?? "",
    value: spec.value ?? null,
    text: spec.text ?? null,
    description: null,
    state: {
      disabled: spec.disabled ?? false,
      focused: false,
      visible: true,
      checked: spec.checked ?? null,
      expanded: null,
      selected: null,
      required: null,
      invalid: false,
      readonly: false,
    },
    bounds: null,
    containerPath: spec.inDialog === true ? [FRAME, DIALOG] : [FRAME, FORM],
    parent: null,
    children: (spec.children ?? []) as readonly NodeId[],
    labelledBy: [],
    tablePosition: null,
    capacity: null,
    confidence: 1,
    live: false,
    masked: spec.masked ?? false,
  } as UINode;
}

export interface ScreenSpec {
  readonly path: string;
  readonly nodes: readonly UINode[];
  readonly settled?: boolean;
  readonly intercepted?: boolean;
  readonly dialog?: Observation["nativeDialog"];
}

export function screen(seq: number, spec: ScreenSpec): Observation {
  return {
    seq,
    surface: { kind: "web-legacy", driver: "mock-surface@0.1.0" },
    route: { originAlias: "corebank", path: spec.path, query: {}, frame: "content" },
    nodes: spec.nodes,
    roots: [],
    skeletonDigest: skeletonDigestOf(spec.nodes),
    stability: {
      settled: spec.settled ?? true,
      generation: seq,
      pendingReason: (spec.settled ?? true) ? null : "network",
    },
    nativeDialog: spec.dialog ?? null,
    inputIntercepted: spec.intercepted ?? spec.dialog != null,
  } as Observation;
}

export const IDS = {
  memberIdField: "textbox:member-id" as NodeId,
  searchButton: "button:search" as NodeId,
  noticeOk: "button:notice-ok" as NodeId,
  openLink: "link:open" as NodeId,
} as const;

const searchNodes = (typed: string | null): readonly UINode[] => [
  node({ id: IDS.memberIdField, role: "textbox", name: "Member ID", value: typed }),
  node({ id: IDS.searchButton, role: "button", name: "Search", text: "Search" }),
];

const noticeNodes: readonly UINode[] = [
  node({ id: IDS.noticeOk, role: "button", name: "OK", text: "OK", inDialog: true }),
];

/** The frozen corpus. Every screen is validated against `ObservationSchema` by `MockSurface`'s own
 *  constructor, so a screen that could not really occur cannot hide in here. */
export const screens: Readonly<Record<string, Observation>> = {
  blank: screen(0, { path: "/blank", nodes: [] }),
  search: screen(1, { path: "/search", nodes: searchNodes(null) }),
  "search-typed": screen(2, { path: "/search", nodes: searchNodes("50001") }),
  "search-typed-masked": screen(3, {
    path: "/search",
    nodes: [
      node({
        id: IDS.memberIdField,
        role: "textbox",
        name: "Member ID",
        value: null,
        masked: true,
      }),
      node({ id: IDS.searchButton, role: "button", name: "Search", text: "Search" }),
    ],
  }),
  "search-truncated": screen(4, { path: "/search", nodes: searchNodes("5000") }),
  results: screen(5, {
    path: "/results",
    nodes: [
      node({ id: IDS.openLink, role: "link", name: "Open", text: "Open" }),
      node({ id: "status:ok", role: "status", name: "1 record", text: "1 record" }),
    ],
  }),
  "results-empty": screen(6, {
    path: "/results",
    nodes: [node({ id: "status:none", role: "status", name: "", text: "No member found" })],
  }),
  "results-nolink": screen(11, {
    path: "/results",
    nodes: [node({ id: "status:two", role: "status", name: "2 records", text: "2 records" })],
  }),
  "search-notice": screen(7, {
    path: "/search",
    nodes: [...searchNodes("50001"), ...noticeNodes],
    intercepted: true,
  }),
  "results-notice": screen(8, {
    path: "/results",
    nodes: [node({ id: IDS.openLink, role: "link", name: "Open", text: "Open" }), ...noticeNodes],
    intercepted: true,
  }),
  "search-dialog": screen(9, {
    path: "/search",
    nodes: searchNodes("50001"),
    dialog: { type: "confirm", message: "Discard the interrupted batch?", defaultValue: null },
  }),
  "results-error": screen(10, {
    path: "/results",
    nodes: [
      node({ id: "status:err", role: "status", name: "", text: "Server Error in application" }),
    ],
  }),
};

// ---------------------------------------------------------------------------------------------
// The documents
// ---------------------------------------------------------------------------------------------

export const token = (t: string): TextMatcher =>
  ({ mode: "token", token: t, normalize: "std.label@1" }) as TextMatcher;
export const exact = (v: string): TextMatcher =>
  ({ mode: "exact", value: v, normalize: "std.text@1" }) as TextMatcher;

export const formScope: ContainerMatcher = {
  path: [
    { kind: "frame", name: exact("content") },
    { kind: "landmark", role: "form" },
  ],
};
export const dialogScope: ContainerMatcher = {
  path: [
    { kind: "frame", name: exact("content") },
    { kind: "landmark", role: "dialog", name: token("notice-dialog") },
  ],
};
export const settled: Predicate = { kind: "settled" };

export const QUORUM = {
  min: 2,
  distinctEvidenceSources: 2,
  requireIdentical: true,
  onUnderQuorum: "fail",
  expectUnique: true,
} as const;

export const targetOf = (
  role: "textbox" | "button" | "link",
  nameToken: string,
  scope: ContainerMatcher,
  recordedName: string,
): TargetRef =>
  ({
    scope,
    role,
    descriptors: [
      {
        id: `${nameToken}-by-name`,
        kind: "role-name",
        evidenceSource: "accessibleName",
        role,
        name: token(nameToken),
      },
      {
        id: `${nameToken}-by-position`,
        kind: "ordinal-in-container",
        evidenceSource: "ordinal",
        container: scope,
        role,
        index: 0,
      },
    ],
    quorum: QUORUM,
    assert: { role, enabled: true, visible: true },
    recordedNode: {
      ariaRole: role,
      name: recordedName,
      containerPath: [
        { kind: "frame", name: "content" },
        scope === dialogScope
          ? { kind: "landmark", role: "dialog", name: "System Notice" }
          : { kind: "landmark", role: "form", name: "Member Search" },
      ],
      tablePosition: null,
      boundsBucket: null,
    },
  }) as TargetRef;

export const mockContract: CapabilityContract = sealContract({
  schemaVersion: "capability.contract/v1",
  name: "mock.member.find",
  version: "1.0.0",
  title: "Find a member",
  summary: "Searches for a member by number and reports whether the record exists.",
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
      origin: "hand-authored",
      callerAction: "retry-different-input",
      retryable: "with_different_inputs",
      agentGuidance: "Tell the member that number is not on file and ask them to read it again.",
    },
  ],
  effect: "READ",
  requiresApproval: false,
  idempotent: true,
});

export const SETTLE = { stableSamples: 2, pollIntervalMs: 50, maxWaitMs: 2_000 } as const;

export interface MockFlowOptions {
  /** Per-step remediation budget. `0` makes every ambient recovery inert, which is a real trap and
   *  therefore a thing a test needs to be able to reproduce. */
  readonly maxRemediationCycles?: number;
  readonly maxActions?: number;
  readonly maxObservations?: number;
  readonly noticeResume?: "retry-step" | "restart-from-checkpoint" | "restart-program";
}

export function mockArtifact(options: MockFlowOptions = {}): CapabilityArtifact {
  const budgets = {
    perRecoveryMaxAttempts: {},
    maxRemediationCycles: options.maxRemediationCycles ?? 2,
  } as const;
  const resume = options.noticeResume ?? "retry-step";
  const draft = sealArtifact({
    schemaVersion: "capability.artifact/v1",
    artifactId: "mock-member-find",
    implements: {
      name: mockContract.name,
      version: mockContract.version,
      contractDigest: mockContract.digest,
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
        "open-link": ["Open"],
        "not-found-banner": ["No member found"],
        "app-error-banner": ["Server Error in"],
        "notice-dialog": ["System Notice"],
        "notice-dismiss-button": ["OK"],
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
            // SPEC section 3's table gives `navigate` the postcondition "location matches the
            // declared route", and pointedly not a delta - navigating to the route you are already
            // on is the flow's own entry condition and changes nothing.
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
          expect: {
            predicate: settled,
            delta: { mustChange: false },
            continuity: [],
          },
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
              origin: "hand-authored",
              capture: [],
            },
          ],
          recoveries: [],
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
      ambient: [
        {
          name: "APP_ERROR_PAGE",
          band: "environment",
          detect: {
            kind: "text-present",
            scope: formScope,
            text: token("app-error-banner"),
          } as Predicate,
          priority: 10,
          phase: "both",
          remedy: {
            kind: "actions",
            instructions: [{ kind: "navigate", route: "search" as RouteId }],
          },
          maxAttempts: 1,
          allowUnsettled: true,
          afterRemedy: "reverify",
          resume: "restart-program",
        },
        {
          name: "DISMISS_SYSTEM_NOTICE",
          band: "interception",
          detect: {
            kind: "node-exists",
            where: { scope: dialogScope, role: "button", name: token("notice-dismiss-button") },
          } as Predicate,
          priority: 20,
          phase: "both",
          remedy: {
            kind: "actions",
            instructions: [
              {
                kind: "activate",
                target: targetOf("button", "notice-dismiss-button", dialogScope, "OK"),
              },
            ],
          },
          maxAttempts: 2,
          allowUnsettled: false,
          afterRemedy: "reverify",
          ...(resume === "restart-from-checkpoint"
            ? { resume, resumeAt: "open-search" as StepId }
            : { resume }),
        },
      ],
    },
    continuity: [],
    provenance: {
      discoveryRunId: "run-mock",
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
      runId: "run-mock-verify",
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
      maxActions: options.maxActions ?? 20,
      maxObservations: options.maxObservations ?? 120,
      maxTotalRemediations: 4,
      maxProgramAttempts: 1,
      deadlineMs: 60_000,
    },
    promotions: [],
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
    acknowledgedPromotions: [],
  });
}

export const mockAllowlist: Allowlist = {
  originAliases: ["corebank"],
  routes: [
    { originAlias: "corebank", pathPattern: "/search", maxEffect: "READ" },
    { originAlias: "corebank", pathPattern: "/results", maxEffect: "READ" },
  ],
  actionKinds: ["click", "type", "navigate", "pressKey", "acceptDialog", "dismissDialog"],
  maxEffect: "READ",
  discoveryMaxEffect: "READ",
};

/** The signature is not verified here and the name says so - this corpus exists to exercise the
 *  interpreter, and `test/approval.test.ts` is where the crypto is put under test. */
export const mockTrust = unverifiedTrust(["mock-key-1"]);

export const MOCK_MEMBER_ID = "50001";
