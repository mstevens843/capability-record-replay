// The exceptional screens, and the scaffolding the classifier needs around one.
//
// `corebank-observations.ts` is the HAPPY PATH plus the two timing hazards (the torn read and the
// unsettled search). This file is the other half of SPEC section 4.2: the eight faults the fixture
// application can inject, frozen, plus the resolved steps, program facts and bindings that turn a
// screen into a complete `ClassifierInput`.
//
// It is a separate file rather than an addition to the corpus for one reason worth stating: the
// corpus is shared by units 4-19 and describes what the application looks like when it works. A
// screen that only exists to be misclassified belongs next to the test that would catch the
// misclassification.
//
// ALL DATA IS OBVIOUSLY SYNTHETIC. Member 50001, "AVERY SYNTHETIC".

import {
  type AttemptCounters,
  type ClassifierInput,
  type ContainerMatcher,
  type ContainerSegment,
  type LabelToken,
  type NodeId,
  type NodeState,
  type Observation,
  type ProgramFacts,
  type RecoveryRule,
  type ResolvedBinding,
  type ResolvedStep,
  type Role,
  type RouteLocation,
  type Step,
  type UINode,
  skeletonDigestOf,
} from "../../src/index.js";
import {
  CONTENT,
  DETAIL_REGION,
  RESULTS_TABLE,
  SEARCH_FORM,
  SHARES_TABLE,
  detail,
  results,
  searchForm,
} from "./corebank-observations.js";
import { memberLookupArtifact, memberLookupContract } from "./member-lookup.js";

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------

const DEFAULT_STATE: NodeState = {
  disabled: false,
  focused: false,
  visible: true,
  checked: null,
  expanded: null,
  selected: null,
  required: null,
  invalid: null,
  readonly: null,
};

interface NodeSpec {
  readonly id: string;
  readonly rawRole: string;
  readonly role?: Role | null;
  readonly name?: string;
  readonly value?: string | null;
  readonly text?: string | null;
  readonly state?: Partial<NodeState>;
  readonly path?: readonly ContainerSegment[];
  readonly parent?: string | null;
  readonly children?: readonly string[];
  readonly tablePosition?: UINode["tablePosition"];
}

const node = (spec: NodeSpec): UINode => ({
  id: spec.id as NodeId,
  rawRole: spec.rawRole,
  ariaRole: spec.role ?? null,
  name: spec.name ?? "",
  value: spec.value ?? null,
  text: spec.text ?? null,
  description: null,
  state: { ...DEFAULT_STATE, ...spec.state },
  bounds: null,
  containerPath: spec.path ?? [],
  parent: (spec.parent ?? null) as NodeId | null,
  children: (spec.children ?? []) as readonly NodeId[],
  labelledBy: [],
  tablePosition: spec.tablePosition ?? null,
  capacity: null,
  confidence: 1,
  live: false,
  masked: false,
});

const SEARCH_ROUTE: RouteLocation = {
  originAlias: "corebank",
  path: "/members/search",
  query: {},
  frame: "content",
};
const DETAIL_ROUTE: RouteLocation = {
  originAlias: "corebank",
  path: "/members/:memberId",
  query: { tab: "shares" },
  frame: "content",
};

interface ObservationSpec {
  readonly route: RouteLocation | null;
  readonly nodes: readonly UINode[];
  readonly settled?: boolean;
  readonly pendingReason?: Observation["stability"]["pendingReason"];
  readonly nativeDialog?: Observation["nativeDialog"];
  readonly inputIntercepted?: boolean;
}

const observation = (spec: ObservationSpec): Observation => ({
  seq: 0,
  surface: { kind: "web-legacy", driver: "mock-surface@0.1.0" },
  route: spec.route,
  nodes: spec.nodes,
  roots: ["document:content" as NodeId],
  skeletonDigest: skeletonDigestOf(spec.nodes),
  stability: {
    settled: spec.settled ?? true,
    generation: 0,
    pendingReason: spec.pendingReason ?? null,
  },
  nativeDialog: spec.nativeDialog ?? null,
  inputIntercepted: spec.inputIntercepted ?? false,
});

/** The same nested-layout-table chrome every screen in this application carries. */
const chrome = (title: string, children: readonly string[]): readonly UINode[] => [
  node({
    id: "document:content",
    rawRole: "RootWebArea",
    name: title,
    path: [CONTENT],
    children: ["layoutcell:page"],
  }),
  node({
    id: "layoutcell:page",
    rawRole: "LayoutTableCell",
    path: [CONTENT],
    parent: "document:content",
    children,
  }),
];

// ---------------------------------------------------------------------------------------------
// The fault screens
// ---------------------------------------------------------------------------------------------

/**
 * Row 6. The search ran, the core has no such member, and the app says so.
 *
 * The banner is a `status` node rather than an `alert`, because that is what the legacy app emits -
 * and because a detector that keyed on the role rather than the text would work here and fail at
 * the tenant whose template uses a `<font color=red>`.
 */
export const notFoundBanner: Observation = observation({
  route: SEARCH_ROUTE,
  nodes: [
    ...chrome("Search Results - CoreBank", ["heading:results", "status:not-found"]),
    node({
      id: "heading:results",
      rawRole: "heading",
      role: "heading",
      name: "Search Results",
      path: [CONTENT],
      parent: "layoutcell:page",
    }),
    node({
      id: "status:not-found",
      rawRole: "status",
      role: "status",
      name: "No member found for that member number.",
      text: "No member found for that member number.",
      path: [CONTENT],
      parent: "layoutcell:page",
    }),
  ],
});

/**
 * Rows 4 and 5. The offending value is flagged on the field itself AND described in a banner,
 * which is what a real validation error looks like - and it is the same screen whichever provenance
 * the rejected value had. That is the whole point: the SCREEN cannot tell you, and the binding can.
 */
export const validationError: Observation = observation({
  route: SEARCH_ROUTE,
  nodes: [
    ...chrome("Member Search - CoreBank", ["form:search", "status:validation"]),
    node({
      id: "form:search",
      rawRole: "form",
      role: "form",
      name: "Member Search",
      path: [CONTENT],
      parent: "layoutcell:page",
      children: ["textbox:member-id"],
    }),
    node({
      id: "textbox:member-id",
      rawRole: "textbox",
      role: "textbox",
      name: "Member ID",
      value: "5",
      path: [CONTENT, SEARCH_FORM],
      parent: "form:search",
      state: { readonly: false, required: true, invalid: true },
    }),
    node({
      id: "status:validation",
      rawRole: "status",
      role: "status",
      name: "Member ID must be at least 5 digits.",
      text: "Member ID must be at least 5 digits.",
      path: [CONTENT, SEARCH_FORM],
      parent: "form:search",
    }),
  ],
});

/**
 * Row 7. A permission denial scoped to THE RECORD, which is an answer: "this member's account is
 * flagged; a supervisor must service it". The share table is gone, which is what the declared
 * detector's second clause checks - a restriction that hid nothing would not be a restriction.
 */
export const restrictedDetail: Observation = observation({
  route: DETAIL_ROUTE,
  nodes: [
    ...chrome("Member Detail - CoreBank", ["region:member-detail"]),
    node({
      id: "region:member-detail",
      rawRole: "region",
      role: "region",
      name: "Member Detail",
      path: [CONTENT],
      parent: "layoutcell:page",
      children: ["heading:member-detail", "text:restricted", "status:restriction-code"],
    }),
    node({
      id: "heading:member-detail",
      rawRole: "heading",
      role: "heading",
      name: "Member Detail #50001",
      text: "Member Detail #50001",
      path: [CONTENT, DETAIL_REGION],
      parent: "region:member-detail",
    }),
    node({
      id: "text:restricted",
      rawRole: "StaticText",
      role: "text",
      name: "Restricted - contact branch",
      text: "Restricted - contact branch",
      path: [CONTENT, DETAIL_REGION],
      parent: "region:member-detail",
    }),
    node({
      id: "status:restriction-code",
      rawRole: "status",
      role: "status",
      name: "LEGAL_HOLD",
      text: "LEGAL_HOLD",
      path: [CONTENT, DETAIL_REGION],
      parent: "region:member-detail",
    }),
  ],
});

/** The same screen with the restriction code missing - row 26 for an OUTCOME's own payload. A
 *  MEMBER_RESTRICTED with a typed hole in it is not a complete answer. */
export const restrictedDetailNoCode: Observation = observation({
  route: DETAIL_ROUTE,
  nodes: restrictedDetail.nodes.filter((n) => n.id !== ("status:restriction-code" as NodeId)),
});

/**
 * Row 8. A permission denial scoped to THE SESSION'S ROLE, which is an environment fault: it will
 * fail identically for every input forever, retrying is pointless, and the fix is a person changing
 * an entitlement.
 *
 * Note how close it renders to `restrictedDetail`. That similarity is the entire argument of SPEC
 * section 4.3: the author declares which detector means which, and an undeclared denial defaults to
 * the failure - never to the outcome.
 */
export const entitlementDenied: Observation = observation({
  route: DETAIL_ROUTE,
  nodes: [
    ...chrome("Member Detail - CoreBank", ["text:not-entitled"]),
    node({
      id: "text:not-entitled",
      rawRole: "StaticText",
      role: "text",
      name: "Your role does not permit VIEW_MEMBER_DETAIL",
      text: "Your role does not permit VIEW_MEMBER_DETAIL",
      path: [CONTENT],
      parent: "layoutcell:page",
    }),
  ],
});

/** Rows 11-13. The logged-out screen, whose empty content region looks exactly like "no results" -
 *  which is why B1 has to beat B3. */
export const sessionExpired: Observation = observation({
  route: SEARCH_ROUTE,
  nodes: [
    ...chrome("Sign in - CoreBank", ["status:session"]),
    node({
      id: "status:session",
      rawRole: "status",
      role: "status",
      name: "Your session has expired. Please sign in again.",
      text: "Your session has expired. Please sign in again.",
      path: [CONTENT],
      parent: "layoutcell:page",
    }),
  ],
});

/**
 * The screen that makes the B1-before-B3 ordering a measurable claim rather than an assertion: it
 * shows the session-expiry banner AND the not-found banner at once, which is exactly what a legacy
 * app renders when the session dies mid-search.
 *
 * A classifier that ran B3 first tells a member their account does not exist.
 */
export const sessionExpiredOverNotFound: Observation = observation({
  route: SEARCH_ROUTE,
  nodes: [
    ...chrome("Search Results - CoreBank", ["status:session", "status:not-found"]),
    node({
      id: "status:session",
      rawRole: "status",
      role: "status",
      name: "Your session has expired. Please sign in again.",
      text: "Your session has expired. Please sign in again.",
      path: [CONTENT],
      parent: "layoutcell:page",
    }),
    node({
      id: "status:not-found",
      rawRole: "status",
      role: "status",
      name: "No member found for that member number.",
      text: "No member found for that member number.",
      path: [CONTENT],
      parent: "layoutcell:page",
    }),
  ],
});

/** The unsettled session-expiry screen. An expired-session banner is WHY the surface will never
 *  settle, which is the whole reason `allowUnsettled` exists and why only B1 may have it. */
export const sessionExpiredUnsettled: Observation = {
  ...sessionExpired,
  stability: { settled: false, generation: 0, pendingReason: "navigating" },
};

/** Row 16. The application's own error page. */
export const appErrorPage: Observation = observation({
  route: SEARCH_ROUTE,
  nodes: [
    ...chrome("Server Error - CoreBank", ["heading:error"]),
    node({
      id: "heading:error",
      rawRole: "heading",
      role: "heading",
      name: "Server Error in '/CoreBank' Application.",
      text: "Server Error in '/CoreBank' Application.",
      path: [CONTENT],
      parent: "layoutcell:page",
    }),
  ],
});

/**
 * Row 25, control C2. Everything about this screen is right except WHICH member it is - the app's
 * own search silently corrected the number, the click was unambiguous, and the checkpoint predicate
 * about "a member detail page" would pass.
 */
export const wrongMemberDetail: Observation = observation({
  route: DETAIL_ROUTE,
  nodes: detail.nodes.map((n) =>
    n.id === ("heading:member-detail" as NodeId)
      ? { ...n, name: "Member Detail #50002", text: "Member Detail #50002" }
      : n,
  ),
});

/** Row 26. The savings row is there and its balance cell cannot be read as money. There is no
 *  partial success: returning `null` to an agent is how a member gets told their balance is
 *  nothing. */
export const detailUnreadableBalance: Observation = observation({
  route: DETAIL_ROUTE,
  nodes: detail.nodes.map((n) =>
    n.id === ("cell:shares-1-1" as NodeId) ? { ...n, name: "n/a", text: "n/a" } : n,
  ),
});

/**
 * The results page showing the final answer AND a keep-alive nudge - SPEC section 4.4's own
 * example of why B3 beats B4. The nudge is a real recovery for a step that has not finished; this
 * step has.
 */
export const notFoundWithKeepAliveNudge: Observation = observation({
  route: SEARCH_ROUTE,
  nodes: [
    ...notFoundBanner.nodes.filter((n) => n.id !== ("layoutcell:page" as NodeId)),
    node({
      id: "layoutcell:page",
      rawRole: "LayoutTableCell",
      path: [CONTENT],
      parent: "document:content",
      children: ["heading:results", "status:not-found", "status:keepalive"],
    }),
    node({
      id: "status:keepalive",
      rawRole: "status",
      role: "status",
      name: "Your session will expire in 2 minutes.",
      text: "Your session will expire in 2 minutes.",
      path: [CONTENT],
      parent: "layoutcell:page",
    }),
  ],
});

/** The not-found banner behind an in-page modal - SPEC section 4.4's B2-before-B3 case. What is
 *  visible behind a modal is stale by construction; reading an outcome off it is reading history. */
export const notFoundBehindModal: Observation = {
  ...notFoundBanner,
  inputIntercepted: true,
};

/** The not-found banner on a surface that has not settled. This is rule 3 of SPEC section 0 in one
 *  file: against a half-painted page, "no member found" and "not painted yet" are the same picture,
 *  and one of those answers is a compliance incident. */
export const notFoundUnsettled: Observation = {
  ...notFoundBanner,
  stability: { settled: false, generation: 0, pendingReason: "network" },
};

// ---------------------------------------------------------------------------------------------
// The program facts the linker would have resolved
// ---------------------------------------------------------------------------------------------

const contractOutputs = Object.fromEntries(
  memberLookupContract.outputs.map((o) => [o.name, { type: o.type, sensitivity: o.sensitivity }]),
);

const outcomePayloads = Object.fromEntries(
  memberLookupContract.outcomes.flatMap((outcome) =>
    outcome.payload.map((field) => [
      field.name,
      { type: field.type, sensitivity: field.sensitivity },
    ]),
  ),
);

/** The tokens the base artifact declares, plus the three the exceptional steps below need. An
 *  overlay would add them the same way. */
export const VOCABULARY: Readonly<Record<string, readonly string[]>> = {
  ...memberLookupArtifact.flow.vocabulary,
  "entitlement-banner": ["Your role does not permit", "You are not authorized"],
  "app-error-banner": ["Server Error", "System error"],
  "validation-banner": ["must be at least", "is not a valid member number"],
  "keepalive-banner": ["Your session will expire"],
};

const token = (t: string) =>
  ({ mode: "token", token: t as LabelToken, normalize: "std.label@1" }) as const;

/** The content frame, spelled the way every matcher in the base artifact spells it. */
const CONTENT_FRAME = {
  kind: "frame",
  name: { mode: "exact", value: "content", normalize: "std.text@1" },
} as const;

/** The two data grids, as MATCHERS - the artifact's side of the table that
 *  `corebank-observations.ts` exports the observed side of. */
export const RESULTS_TABLE_MATCHER: ContainerMatcher = {
  path: [
    CONTENT_FRAME,
    {
      kind: "table",
      headers: [token("member-column"), token("name-column"), token("status-column")],
    },
  ],
} as unknown as ContainerMatcher;

export const SHARES_TABLE_MATCHER: ContainerMatcher = {
  path: [
    CONTENT_FRAME,
    {
      kind: "table",
      headers: [token("share-type-column"), token("balance-column"), token("status-column")],
    },
  ],
} as unknown as ContainerMatcher;

export const program: ProgramFacts = {
  routes: memberLookupArtifact.flow.routes,
  vocabulary: VOCABULARY,
  continuity: memberLookupArtifact.continuity,
  outputs: {
    ...contractOutputs,
    ...outcomePayloads,
    // `readTable` needs a representable output type; the base contract does not declare one
    // because the shipped flow reads a single cell. This is the type a `shares` output would have.
    shares: {
      type: {
        kind: "table",
        columns: [
          { name: "Share Type", type: { kind: "string" } },
          { name: "Current Balance", type: { kind: "money", currency: "USD" } },
          { name: "Status", type: { kind: "string" } },
        ],
      },
      sensitivity: "internal",
    },
  } as ProgramFacts["outputs"],
  brandingTokens: [],
  maxEffect: memberLookupArtifact.effects.maxEffect,
  restartSafeUpToPc: memberLookupArtifact.effects.restartSafeUpToPc,
  resumePoints: memberLookupArtifact.flow.resumePoints,
};

// ---------------------------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------------------------

/** The caller's own argument, tainted. `value` is here for COMPARISON ONLY - the redaction canary
 *  in `classifier.test.ts` asserts it appears in no verdict this fixture can produce. */
export const CALLER_MEMBER_ID: ResolvedBinding = {
  name: "memberId",
  origin: "param",
  value: "50001",
  sensitivity: "sensitive",
  handle: "taint:memberId" as ResolvedBinding["handle"],
};

/** The same value, reached the way a badly-authored artifact would reach it: baked in. This one
 *  binding is the entire difference between SPEC section 4.2 row 4 and row 5. */
export const ARTIFACT_LITERAL_ID: ResolvedBinding = {
  name: "00000",
  origin: "literal",
  value: "00000",
  sensitivity: "public",
  handle: null,
};

export const bindings: readonly ResolvedBinding[] = [CALLER_MEMBER_ID];

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

const STEPS = memberLookupArtifact.flow.steps;

const indexOfStep = (id: string): number => STEPS.findIndex((s) => s.id === id);

/** A step from the artifact, resolved the way the linker would resolve it, with test-local
 *  overrides for the rules the base flow does not declare. */
export function resolvedStep(id: string, overrides: Partial<Step> = {}): ResolvedStep {
  const index = indexOfStep(id);
  const base = STEPS[index];
  if (base === undefined) throw new Error(`no step named ${id} in the member-lookup flow`);
  return {
    ...base,
    ...overrides,
    index,
    route: null,
  } as ResolvedStep;
}

// ---------------------------------------------------------------------------------------------
// The declared rules the base flow does not carry
// ---------------------------------------------------------------------------------------------

/** Row 8. Declared as an environment condition whose remedy is an escalation, which is how an
 *  artifact says "no remedy clears this and no restart fixes it; a person must change something
 *  outside this run". */
export const ROLE_NOT_ENTITLED: RecoveryRule = {
  name: "ROLE_NOT_ENTITLED",
  band: "environment",
  detect: { kind: "text-present", text: token("entitlement-banner") },
  priority: 5,
  phase: "both",
  remedy: {
    kind: "escalate",
    reason: "the automation's own role lacks the entitlement this screen needs",
    brief:
      "The service account this capability runs as cannot open a member detail screen at this tenant. A person must grant the entitlement; retrying will fail identically.",
  },
  maxAttempts: 1,
  allowUnsettled: true,
  afterRemedy: "reverify",
  resume: "escalate",
} as unknown as RecoveryRule;

/** Row 16. One restart, and only because the run is a READ. */
export const APP_ERROR: RecoveryRule = {
  name: "APP_ERROR",
  band: "environment",
  detect: { kind: "text-present", text: token("app-error-banner") },
  priority: 15,
  phase: "both",
  remedy: { kind: "actions", instructions: [{ kind: "navigate", route: "member-search" }] },
  maxAttempts: 1,
  allowUnsettled: true,
  afterRemedy: "reverify",
  resume: "restart-program",
} as unknown as RecoveryRule;

/** Row 11. A resume point exists and no irreversible step has been crossed. */
export const SESSION_EXPIRED_RESUME: RecoveryRule = {
  name: "SESSION_EXPIRED_RESUME",
  band: "environment",
  detect: { kind: "text-present", text: token("session-expired-banner") },
  priority: 5,
  phase: "both",
  remedy: { kind: "reauthenticate" },
  maxAttempts: 1,
  allowUnsettled: true,
  afterRemedy: "reverify",
  resume: "restart-from-checkpoint",
  resumeAt: "open-search",
} as unknown as RecoveryRule;

/** The keep-alive nudge, in the RECOVERABLE band - a real recovery for a step that has not
 *  finished, and the thing B3 must beat on a step that has. */
export const DISMISS_KEEPALIVE_NUDGE: RecoveryRule = {
  name: "DISMISS_KEEPALIVE_NUDGE",
  band: "recoverable",
  detect: { kind: "text-present", text: token("keepalive-banner") },
  priority: 40,
  phase: "post",
  remedy: { kind: "reauthenticate" },
  maxAttempts: 2,
  allowUnsettled: false,
  afterRemedy: "reverify",
  resume: "retry-step",
} as unknown as RecoveryRule;

/** The collision that row 30 exists for: an ambient rule that lands in the same band at the same
 *  priority as the step's own. The linker cannot see this one, because neither document is wrong
 *  by itself. */
export const AMBIENT_NATIVE_DIALOG: RecoveryRule = {
  name: "AMBIENT_NATIVE_DIALOG",
  band: "interception",
  detect: { kind: "native-dialog" },
  priority: 10,
  phase: "both",
  remedy: { kind: "dismiss-native-dialog", accept: false },
  maxAttempts: 2,
  allowUnsettled: false,
  afterRemedy: "reverify",
  resume: "retry-step",
} as unknown as RecoveryRule;

/** The declared validation-error detector. It is an OUTCOME, and it is the caller's to fix -
 *  provided the value the app rejected was theirs. */
export const INVALID_MEMBER_ID = {
  code: "INVALID_MEMBER_ID",
  detect: {
    kind: "node-state",
    where: {
      scope: {
        path: [
          { kind: "frame", name: { mode: "exact", value: "content", normalize: "std.text@1" } },
        ],
      },
      role: "textbox",
      name: token("member-id-field"),
    },
    state: "invalid",
    equals: true,
  },
  priority: 10,
  phase: "post",
  requiresSettled: true,
  capture: [],
} as unknown as Step["outcomes"][number];

// ---------------------------------------------------------------------------------------------
// Counters and a whole input
// ---------------------------------------------------------------------------------------------

export const FRESH_COUNTERS: AttemptCounters = {
  recoveryAttempts: {},
  remediationCycles: 0,
  run: {
    actions: { used: 3, limit: 40 },
    observations: { used: 9, limit: 200 },
    remediations: { used: 0, limit: 8 },
    programAttempts: { used: 0, limit: 2 },
  },
  deadlineMs: 120_000,
};

export interface InputOverrides extends Partial<Omit<ClassifierInput, "step">> {
  readonly step?: ResolvedStep;
}

/**
 * A complete `ClassifierInput` from a screen and a step, with everything else defaulted to the
 * boring case - which is exactly what makes each test below say only what it is about.
 */
export function inputFor(
  step: ResolvedStep,
  obs: Observation,
  overrides: InputOverrides = {},
): ClassifierInput {
  return {
    observation: obs,
    // A settled two-sample poll window: the screen looked the same on the last two polls. Tests
    // that care about a MOVING window override it.
    recentDigests: [obs.skeletonDigest, obs.skeletonDigest],
    // "The screen before this step was the search form", which makes `mustChange` true for every
    // screen that is not the search form - the common case.
    preActDigest: searchForm.skeletonDigest,
    step,
    ambient: memberLookupArtifact.flow.ambient,
    phase: "post",
    bindings,
    counters: FRESH_COUNTERS,
    program,
    elapsedMs: 4_000,
    settleElapsedMs: 400,
    irreversibleDispatched: false,
    ...overrides,
  };
}

export { detail, results, searchForm, RESULTS_TABLE, SHARES_TABLE };

/** Row 26's third form: a bounded table read whose bounds the screen exceeds. `onTruncate` has one
 *  legal value, because reading nine of a member's ten shares and reporting them as ten is a wrong
 *  answer that looks like a right one. */
export function readSharesStep(maxRows: number): ResolvedStep {
  return resolvedStep("read-savings-balance", {
    instruction: { kind: "readTable" },
    extract: [
      {
        output: "shares",
        from: "cell@1",
        where: { scope: SHARES_TABLE_MATCHER, role: "cell" },
        parse: "string@1",
        normalize: "std.text@1",
        onMissing: "fail",
        rows: { minRows: 1, maxRows, onTruncate: "fail" },
      },
    ] as never,
  });
}

/** A second detector that also fires on the not-found screen, at a HIGHER priority number. It
 *  loses, and the fact that it matched is reported rather than dropped - a quiet signal that this
 *  step's taxonomy is getting muddy. */
export const SEARCH_RETURNED_NOTHING = {
  code: "SEARCH_RETURNED_NOTHING",
  detect: { kind: "count", where: { scope: RESULTS_TABLE_MATCHER, role: "row" }, op: "eq", n: 0 },
  priority: 20,
  phase: "post",
  requiresSettled: true,
  capture: [],
} as unknown as Step["outcomes"][number];
