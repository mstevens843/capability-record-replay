// A run envelope and one example of each of the four result arms.
//
// The envelope is carried IDENTICALLY by all four arms, including `ok`, and this fixture is written
// that way on purpose. The run you most want a trace for is the one that returned `ok` and should
// not have - a descriptor that has quietly started abstaining shows up in `steps[].resolution` on a
// green run months before it shows up as a failure - so a fixture where only the failure arm is
// interesting would be modelling the wrong system.

import { memberLookupArtifact, memberLookupContract } from "./member-lookup.js";

const observed = {
  route: { originAlias: "corebank", path: "/members/:memberId", query: {}, frame: "content" },
  settled: true,
  pendingReason: null,
  skeletonDigest: "sk:5b93e0",
  nodeCount: 205,
  nativeDialog: null,
  inputIntercepted: false,
  salient: [
    { role: "heading", name: "Member Detail", disabled: false, visible: true },
    { role: "status", name: "Account restricted", disabled: false, visible: true },
  ],
  redactionsApplied: 2,
};

const expectation = {
  rendered:
    "the member detail route is loaded, the subject member is still the one we were asked about, and the shares grid has at least one row",
  clauses: [
    { rendered: "the surface has settled", verdict: true },
    { rendered: "continuity subjectMember holds inside the Member Detail region", verdict: false },
    {
      rendered: "at least 1 row in the table with headers [Share Type, Current Balance, Status]",
      verdict: true,
    },
  ],
};

export const runEnvelope = {
  runId: "run-2026-02-12-7c1d",
  capability: { name: memberLookupContract.name, version: memberLookupContract.version },
  artifact: {
    artifactId: memberLookupArtifact.artifactId,
    version: memberLookupArtifact.version,
    digest: memberLookupArtifact.digest,
    overlayDigest: null,
    effectiveDigest: memberLookupArtifact.digest,
  },
  tenant: { tenantId: "riverbend", appInstanceId: "riverbend-corebank-prod" },
  surface: "web-legacy",
  engineVersion: "crr-engine@0.1.0",
  startedAt: "2026-02-12T09:14:02.000Z",
  endedAt: "2026-02-12T09:14:07.410Z",
  durationMs: 5410,
  stepsExecuted: 5,
  stepsTotal: 5,
  budgets: {
    actions: { used: 4, limit: 40 },
    observations: { used: 17, limit: 200 },
    remediations: { used: 1, limit: 8 },
    programAttempts: { used: 1, limit: 2 },
    wallClockMs: { used: 5410, limit: 120_000 },
  },
  // Recorded even though it helped. An interstitial that fires on 3% of runs today fires on 40%
  // next quarter, and nobody notices while the runs still pass.
  recoveriesApplied: [
    { stepId: "submit-search", name: "DISMISS_SYSTEM_NOTICE", attempts: 1, result: "cleared" },
  ],
  attribution: { by: "automation", transfers: [] },
  steps: [
    {
      stepId: "read-savings-balance",
      attempt: 1,
      verdict: {
        kind: "advance",
        outputs: [
          {
            output: "savingsBalance",
            value: { amount: "1284.55", currency: "USD" },
            sensitivity: "internal",
          },
          { output: "accountStatus", value: "OPEN", sensitivity: "internal" },
        ],
      },
      skeletonDigest: "sk:5b93e0",
      observationRef: "obs-run-2026-02-12-7c1d-05",
      elapsedMs: 812,
      // Present on a SUCCESSFUL step. `by-position` has started abstaining at this tenant; the run
      // is green because the other two still agree, and this line is the only warning anyone gets.
      resolution: [
        {
          descriptorId: "member-id-by-name",
          kind: "role-name",
          evidenceSource: "accessibleName",
          verdict: "resolved",
          resolvedNodeId: "textbox:member-id",
        },
        {
          descriptorId: "member-id-by-position",
          kind: "ordinal-in-container",
          evidenceSource: "ordinal",
          verdict: "abstained",
          resolvedNodeId: null,
        },
      ],
    },
  ],
  drift: {
    fingerprint: "fp:5b93e1",
    expected: "fp:5b93e0",
    divergence: 0.08,
    changed: [
      {
        stepId: "read-savings-balance",
        descriptorId: "member-id-by-position",
        was: "resolved",
        now: "abstained",
      },
    ],
    needsSpecialization: false,
  },
  evidence: ["obs-run-2026-02-12-7c1d-05"],
  journalRef: "journal-run-2026-02-12-7c1d",
  warnings: [
    {
      code: "descriptor-abstaining",
      stepId: "read-savings-balance",
      detail: "member-id-by-position has abstained on every run for 14 days",
    },
  ],
};

export const okResult = {
  status: "ok",
  outputs: {
    memberName: "SYNTHETIC TESTMEMBER",
    savingsBalance: { amount: "1284.55", currency: "USD" },
    accountStatus: "OPEN",
  },
  run: runEnvelope,
};

export const outcomeResult = {
  status: "outcome",
  outcome: "MEMBER_NOT_FOUND",
  data: {},
  terminal: true,
  callerAction: "retry-different-input",
  retryable: "with_different_inputs",
  // Copied verbatim from the reviewed declaration, not generated at render time.
  guidance: memberLookupContract.outcomes[0]?.agentGuidance ?? "",
  detectedAt: { stepId: "submit-search", stepIndex: 2, priority: 10 },
  alsoMatched: [],
  run: runEnvelope,
};

export const suspendedResult = {
  status: "suspended",
  intervention: {
    id: "int-2026-02-12-0031",
    reason: "unclassified-state",
    atStep: "open-member-row",
    summary: "The results grid rendered a layout this program has not seen before.",
    consoleUrl: "http://127.0.0.1:7717/interventions/int-2026-02-12-0031",
    expiresAt: "2026-02-12T09:24:07.410Z",
  },
  resume: { token: "lease-7c1d-2", pollAfterMs: 2000 },
  // Enough for the agent to say something TRUE while a human takes over.
  partialOutputs: { memberName: "SYNTHETIC TESTMEMBER" },
  run: runEnvelope,
};

export const failedResult = {
  status: "failed",
  failure: {
    class: "continuity-broken",
    atStep: "open-member-row",
    stepIndex: 3,
    sideEffects: "possible",
    expected: expectation,
    observed,
    attempts: [],
    retriable: "no",
    operatorAction:
      "The run was no longer on the record it started with; stop and investigate before retrying.",
    observationRef: "obs-run-2026-02-12-7c1d-04",
  },
  run: runEnvelope,
};
