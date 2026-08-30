// The GREEN SCREEN capability: one contract, one artifact, one overlay, one allowlist.
//
// This is SPEC section 11 unit 21's payload. Everything here is a document - data, not code - and
// the point of it is that the engine that runs it is byte-for-byte the engine that runs the browser
// program in `flow.ts`. Same `replay()`, same linker, same classifier, same resolver, same policy
// chokepoint, same journal. What changes is the driver underneath and nothing else.
//
// THREE THINGS TO READ FIRST, because each is a decision rather than a detail.
//
// 1. NO F-KEY APPEARS IN THIS DOCUMENT. `return-to-inquiry` says `activate` the control named
//    "Back". The terminal spike measured that control bound to F3 at riverbend and F12 at summit,
//    and `@crr/surface-terminal` reads the legend line at replay time to decide which byte to send.
//    Linker check 21 refuses an artifact that presses an F-key directly, and
//    `test/heterogeneity.test.ts` proves the refusal is live by asking for one.
//
// 2. THE ROUTE IS THE SCREEN NUMBER, NOT THE SCREEN NAME. riverbend paints `MEMBER INQUIRY 01` and
//    summit paints `MBR INQ 01`; both canonicalize to `/screen/01`, so `route-matches` and the
//    allowlist are tenant-independent while the container path is not. That is why the checkpoints
//    below anchor on the route and the scopes carry a vocabulary token.
//
// 3. THE OVERLAY CONTAINS THE LABELS AND NOT THE KEY, and that division is the whole multi-tenant
//    argument in nine lines. Three tokens move between these two credit unions - one field label
//    and two screen bands - and the F3-to-F12 difference, which is the largest behavioural
//    difference of the three, needs nothing at all because it lives at the port.

import {
  type Allowlist,
  type CapabilityArtifact,
  type CapabilityContract,
  type CapabilityOverlay,
  type ContainerMatcher,
  type Descriptor,
  type ExtractSpec,
  type NodeQuery,
  type Predicate,
  type RouteId,
  type StepId,
  type TargetRef,
  type TextMatcher,
  approveArtifact,
  sealArtifact,
  sealContract,
  sealOverlay,
} from "@crr/core";
import { unverifiedTrust } from "@crr/runtime";

// ---------------------------------------------------------------------------------------------
// Vocabulary, routes, scopes
// ---------------------------------------------------------------------------------------------

const token = (t: string): TextMatcher =>
  ({ mode: "token", token: t, normalize: "std.label@1" }) as TextMatcher;

/** The symbolic name of the system the transport is attached to. Bound to a real authority per
 *  tenant by the overlay; on this surface that authority is a telnet host, not a web origin. */
export const TERMINAL_ORIGIN = "corebank-green";

export const INQUIRY = "inquiry" as RouteId;
export const ACCOUNTS = "accounts" as RouteId;
export const SIGNON = "signon" as RouteId;
export const ABEND = "abend" as RouteId;

/**
 * A screen scope. One segment, and the segment is the screen-id band.
 *
 * `ContainerMatcher` requires at least one segment on purpose (control C3: resolution never searches
 * the whole observation), and on a character surface the screen band is the only container above the
 * table. It carries a TOKEN rather than a literal because the band is branded - which is exactly the
 * thing the overlay is for, and exactly the thing the route is not.
 */
const screenScope = (t: string): ContainerMatcher =>
  ({ path: [{ kind: "screen", id: token(t) }] }) as unknown as ContainerMatcher;

export const INQUIRY_SCOPE = screenScope("inquiry-screen");
export const ACCOUNTS_SCOPE = screenScope("accounts-screen");
export const SIGNON_SCOPE = screenScope("signon-screen");
export const ABEND_SCOPE = screenScope("abend-screen");

/** The account grid, identified by its column-header set - the same way the browser corpus
 *  identifies a table-soup grid, and for the same reason: the headers are what a human uses. */
export const ACCOUNTS_TABLE_SCOPE = {
  path: [
    { kind: "screen", id: token("accounts-screen") },
    { kind: "table", headers: [token("suffix-column"), token("balance-column")] },
  ],
} as unknown as ContainerMatcher;

const settled: Predicate = { kind: "settled" };
const onRoute = (route: RouteId): Predicate => ({ kind: "route-matches", route });
const exists = (where: NodeQuery): Predicate => ({ kind: "node-exists", where });
const textIn = (scope: ContainerMatcher, tok: string): Predicate =>
  ({ kind: "text-present", scope, text: token(tok) }) as Predicate;

/** Two agreeing descriptors resting on two INDEPENDENT pieces of evidence. Identical to the browser
 *  corpus's, because the quorum is a property of the engine and not of the surface. */
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
 * The account-number field.
 *
 * `role-name` and `label-anchored` are correlated here and the resolver knows it: on a green screen
 * a field has no accessible name of its own, so `@crr/surface-terminal` computes one from the prompt
 * text to its left and reports the prompt as a node the second descriptor anchors to. Reading the
 * same words twice is one piece of evidence, so the ordinal is what makes the quorum reachable - the
 * identical shape the browser corpus needed for the identical reason.
 */
const accountFieldTarget: TargetRef = {
  scope: INQUIRY_SCOPE,
  role: "textbox",
  descriptors: [
    {
      id: "account-field-by-name",
      kind: "role-name",
      evidenceSource: "accessibleName",
      role: "textbox",
      name: token("account-field"),
    },
    {
      id: "account-field-by-label",
      kind: "label-anchored",
      evidenceSource: "labelText",
      label: token("account-field"),
      role: "textbox",
      relation: "labelled-by",
      // CELLS, not pixels. `boundsUnit` is `cell` on this surface and the linker checks the two
      // agree, so a distance recorded on a browser cannot be replayed against a grid by accident.
      maxDistance: { unit: "cell", value: 24 },
    },
    {
      id: "account-field-by-ordinal",
      kind: "ordinal-in-container",
      evidenceSource: "ordinal",
      container: INQUIRY_SCOPE,
      role: "textbox",
      index: 0,
    },
  ] as readonly Descriptor[],
  quorum: QUORUM,
  assert: { role: "textbox", name: token("account-field"), enabled: true, visible: true },
  recordedNode: {
    ariaRole: "textbox",
    name: "Account Number",
    containerPath: [{ kind: "screen", id: "MEMBER INQUIRY 01" }],
    tablePosition: null,
    boundsBucket: null,
  },
} as unknown as TargetRef;

/**
 * A legend control, described exactly the way the browser corpus describes a `<button>`.
 *
 * THIS IS THE HETEROGENEITY CLAIM, and it is worth being precise about where it lives. The
 * descriptor is surface-neutral - a role and a name - and so is the instruction that uses it
 * (`{ kind: "activate" }`). The lowering is the driver's: `activate` becomes the port's `click`,
 * and `TerminalSurface` turns a click on a legend control into the keystroke that tenant's legend
 * printed. Nothing above the port knows a function key exists.
 */
const legendControlTarget = (
  nameToken: string,
  recordedName: string,
  scope: ContainerMatcher,
  screenId: string,
  index: number,
): TargetRef =>
  ({
    scope,
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
        container: scope,
        role: "button",
        index,
      },
    ],
    quorum: QUORUM,
    assert: { role: "button", name: token(nameToken), enabled: true, visible: true },
    recordedNode: {
      ariaRole: "button",
      name: recordedName,
      containerPath: [{ kind: "screen", id: screenId }],
      tablePosition: null,
      boundsBucket: null,
    },
  }) as unknown as TargetRef;

/** `ENTER=Search` on the inquiry screen: legend order is Exit, Next Field, Search. */
const searchControlTarget = legendControlTarget(
  "search-control",
  "Search",
  INQUIRY_SCOPE,
  "MEMBER INQUIRY 01",
  2,
);

/** `F3=Back` on the account list: legend order is Back, Open Suffix. F12 at summit, and this
 *  document does not know that. */
const backControlTarget = legendControlTarget(
  "back-control",
  "Back",
  ACCOUNTS_SCOPE,
  "ACCOUNT LIST 02",
  0,
);

/** `F3=Exit` on the abend screen, used by the APP_ERROR remedy. */
const abendExitTarget = legendControlTarget(
  "exit-control",
  "Exit",
  ABEND_SCOPE,
  "SYSTEM ERROR 99",
  0,
);

// ---------------------------------------------------------------------------------------------
// The contract - what the calling agent sees. Zero surface detail, and no green screen in it.
// ---------------------------------------------------------------------------------------------

/**
 * Why this is not `flow.ts`'s contract, said out loud.
 *
 * SPEC section 9.1's "one contract, two programs" is the shape this ought to have taken, and it does
 * not, for one measurable reason: `corebank.member.share_position` declares a REQUIRED `memberName`
 * output, and the green screen prints the member's name as an unlabelled plain run to the right of a
 * bold member number (`Member:  12345   AVERY SYNTHETIC`). `detect()` reports structure and refuses
 * to guess, so that run becomes no node at all and there is nothing for an `ExtractSpec` to name.
 * The honest options were to publish a contract this program cannot satisfy, to make the fixture
 * help by labelling the field, or to declare what the screen actually offers. This declares what the
 * screen offers, and says so here rather than dressing the gap up as a feature. What IS shared with
 * the browser program - the engine, the language, the taxonomy, the
 * instruction set and the descriptor kinds - is shared exactly, and `heterogeneity.test.ts` compares
 * the two `activate` steps field by field to show it.
 */
export const terminalContract: CapabilityContract = sealContract({
  schemaVersion: "capability.contract/v1",
  name: "corebank.member.account_list",
  version: "1.0.0",
  title: "List a member's accounts",
  summary:
    "Looks a member up by account number in the core banking teller application and reports the accounts on file with their balances.",
  whenToUse: [
    "A member has given you their account number and is asking what accounts they hold or what the balance on one of them is.",
  ],
  whenNotToUse: [
    "You do not have an account number - this capability cannot search by name.",
    "The member wants a transaction history; that is a different capability.",
  ],
  inputs: [
    {
      name: "memberNumber",
      type: { kind: "string", charset: "digits", minLength: 5, maxLength: 5 },
      required: true,
      description: "The member's account number, exactly five digits.",
      sensitivity: "sensitive",
      constraints: { charset: "digits", minLength: 5, maxLength: 5 },
      discoveredFrom: { goalSpan: "account {memberNumber}" },
    },
  ],
  outputs: [
    {
      name: "shareBalance",
      type: { kind: "money", currency: "USD" },
      required: true,
      description: "The balance on the member's regular savings account.",
      sensitivity: "sensitive",
      agentDisclosure: "deliver",
    },
    {
      name: "accounts",
      type: {
        kind: "table",
        columns: [
          { name: "suffix", type: { kind: "string" } },
          { name: "description", type: { kind: "string" } },
          { name: "balance", type: { kind: "money", currency: "USD" } },
        ],
      },
      required: true,
      description: "Every account on file for this member, as the core lists them.",
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
      code: "MEMBER_RESTRICTED",
      kind: "business_outcome",
      title: "The member record is restricted",
      summary: "The record is flagged and only a member services specialist may open it.",
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

const SETTLE = { stableSamples: 2, pollIntervalMs: 20, maxWaitMs: 3_000 } as const;

/**
 * The regular-savings balance, addressed by ROW KEY rather than by position.
 *
 * `S0001` is the suffix the vendor assigns to a member's first share account; the row it lands on
 * moves the moment a member opens a second one. Keying on the value is the same control the browser
 * corpus applies to a results grid, and it reads identically here because `observe.ts` lowers the
 * account block to `table` + `row` + `cell` with a real `tablePosition`.
 */
const shareBalanceExtract: ExtractSpec = {
  output: "shareBalance",
  from: "cell@1",
  where: {
    cell: {
      table: ACCOUNTS_TABLE_SCOPE,
      rowKey: {
        columnHeader: token("suffix-column"),
        value: { from: "literal", value: "S0001", sensitivity: "public" },
      },
      columnHeader: token("balance-column"),
    },
  },
  parse: "moneyUSD@1",
  normalize: "std.money@1",
  onMissing: "fail",
} as ExtractSpec;

/**
 * The whole grid.
 *
 * `columnHeaders` maps the CONTRACT's column names onto what this surface prints. Without it the
 * contract would have to declare a column called `SUFFIX`, which is a green screen's vocabulary
 * leaking into the document a calling agent reads - the exact failure SPEC section 0 decision 4
 * exists to prevent. It is a `token`, so an overlay can reach it.
 */
const accountsExtract: ExtractSpec = {
  output: "accounts",
  from: "cell@1",
  where: { scope: ACCOUNTS_TABLE_SCOPE, role: "cell" },
  parse: "string@1",
  // `std.identity@1`, not `std.text@1`. An account DESCRIPTION is read back to a member on the
  // phone, and lowercasing `REGULAR SAVINGS` would be the engine editing the core's own words.
  normalize: "std.identity@1",
  onMissing: "fail",
  columnHeaders: {
    suffix: token("suffix-column"),
    description: token("description-column"),
    balance: token("balance-column"),
  },
  rows: { minRows: 1, maxRows: 24, onTruncate: "fail" },
} as ExtractSpec;

export interface TerminalFlowOptions {
  readonly maxRemediationCycles?: number;
  readonly maxProgramAttempts?: number;
  readonly deadlineMs?: number;
  /** Raised by the slow-repaint scenario, which is the only one measuring the settle ceiling. */
  readonly maxWaitMs?: number;
  /**
   * A deliberately damaged TARGET, for the wrong-target sub-cases of SPEC section 4.5.
   *
   * The browser corpus produces these by scripting a screen, because it drives `MockSurface` and can
   * manufacture a results grid with two plausible rows. A live green screen cannot be asked for one,
   * so the mirror-image move is used here: the SCREEN is real and the ARTIFACT is the thing that has
   * drifted. That is the same failure in production - a recording taken before a vendor release,
   * replayed after it - and it reaches the same two refusals.
   *
   *   `disagree`   the ordinal names the Exit control and the name names Search  -> target-ambiguous
   *   `correlated` the ordinal is gone and what is left reads one label twice     -> target-underdetermined
   */
  readonly targetVariant?: "disagree" | "correlated" | null;
}

/** The account field with its ordinal removed: `role-name` and `label-anchored` are left, and both
 *  read the same prompt off the same screen. Two descriptors, ONE piece of evidence. */
const correlatedAccountFieldTarget: TargetRef = {
  ...(accountFieldTarget as unknown as Record<string, unknown>),
  descriptors: (
    accountFieldTarget as unknown as { descriptors: readonly Descriptor[] }
  ).descriptors.filter((d) => d.kind !== "ordinal-in-container"),
} as unknown as TargetRef;

/** The Search control described by name AND by an ordinal that lands on Exit. A ranking would pick
 *  one and press it; the resolver refuses. */
const disagreeingSearchTarget: TargetRef = legendControlTarget(
  "search-control",
  "Search",
  INQUIRY_SCOPE,
  "MEMBER INQUIRY 01",
  0,
);

export function terminalArtifact(options: TerminalFlowOptions = {}): CapabilityArtifact {
  const budgets = {
    perRecoveryMaxAttempts: {},
    maxRemediationCycles: options.maxRemediationCycles ?? 3,
  } as const;
  const evidence = { captureOn: ["failure", "outcome"] } as const;
  const settle =
    options.maxWaitMs === undefined ? SETTLE : { ...SETTLE, maxWaitMs: options.maxWaitMs };

  const draft = sealArtifact({
    schemaVersion: "capability.artifact/v1",
    artifactId: "corebank-member-account-list-tui",
    implements: {
      name: terminalContract.name,
      version: terminalContract.version,
      contractDigest: terminalContract.digest,
    },
    version: 1,
    target: {
      product: "CoreBank Teller Green Screen",
      productVersionRange: ">=4.0 <5.0",
      surfaceKind: "terminal",
      // No `route` feature: this surface reports where it is and cannot be told to go somewhere.
      // No `accessibility-tree`: there is no tree, there are characters.
      requires: ["character-grid", "containers", "table-position"],
      sessionProfile: "teller",
    },
    lifecycle: { status: "draft", supersedes: null, approval: null },
    flow: {
      // No `navigate` step, so the program cannot put itself on the entry screen: the session
      // broker hands over a session that is already there and the precondition checks it. That is
      // the honest arrangement for a green screen and it is what SPEC section 7.6 already asks for.
      entry: { route: INQUIRY, precondition: onRoute(INQUIRY) },
      routes: [
        { id: INQUIRY, originAlias: TERMINAL_ORIGIN, path: "/screen/01" },
        { id: ACCOUNTS, originAlias: TERMINAL_ORIGIN, path: "/screen/02" },
        { id: SIGNON, originAlias: TERMINAL_ORIGIN, path: "/screen/00" },
        { id: ABEND, originAlias: TERMINAL_ORIGIN, path: "/screen/99" },
      ],
      vocabulary: {
        // Moved by the summit overlay ------------------------------------------------------
        "account-field": ["Account Number"],
        "inquiry-screen": ["MEMBER INQUIRY 01"],
        "accounts-screen": ["ACCOUNT LIST 02"],
        // The same at both credit unions ---------------------------------------------------
        "signon-screen": ["SIGN ON 00"],
        "abend-screen": ["SYSTEM ERROR 99"],
        "signon-heading": ["SIGN ON"],
        "abend-heading": ["SYSTEM ERROR"],
        "operator-field": ["Operator ID"],
        "search-control": ["Search"],
        "back-control": ["Back"],
        "exit-control": ["Exit"],
        "member-label": ["Member"],
        "suffix-column": ["SUFFIX"],
        "description-column": ["DESCRIPTION"],
        "balance-column": ["BALANCE"],
        "not-on-file-banner": ["NO MEMBER ON FILE"],
        "restricted-banner": ["SECURITY VIOLATION"],
      },
      resumePoints: ["enter-member-number" as StepId],
      steps: [
        {
          id: "enter-member-number" as StepId,
          title: "Type the member's account number",
          intent: "Put the caller's account number in the inquiry screen's first field.",
          effect: "READ",
          instruction: {
            kind: "fill",
            value: { from: "param", param: "memberNumber" },
            mode: "replace",
          },
          target:
            options.targetVariant === "correlated"
              ? correlatedAccountFieldTarget
              : accountFieldTarget,
          precondition: null,
          settle,
          expect: {
            // Typing does not repaint anything but the field, so the screen must still be the
            // inquiry screen. The value read-back is the interpreter's own postcondition for
            // `fill` and is not restated here.
            predicate: { all: [settled, onRoute(INQUIRY)] } as Predicate,
            delta: { mustChange: false },
            continuity: [],
          },
          outcomes: [],
          recoveries: [],
          extract: [],
          budgets,
          evidence,
        },
        {
          id: "run-inquiry" as StepId,
          title: "Run the inquiry",
          intent: "Submit the screen and wait for the account list.",
          effect: "READ",
          // THE STEP THE ACCEPTANCE TEST IS ABOUT, half one. `ENTER=Search` here; a browser's
          // `<input type=submit>` there; the same three words in the artifact.
          instruction: { kind: "activate" },
          target:
            options.targetVariant === "disagree" ? disagreeingSearchTarget : searchControlTarget,
          precondition: null,
          settle,
          expect: {
            predicate: {
              all: [
                settled,
                onRoute(ACCOUNTS),
                exists({ scope: ACCOUNTS_TABLE_SCOPE, role: "cell" }),
              ],
            } as Predicate,
            delta: { mustChange: true, navigatedTo: ACCOUNTS },
            // Not "an account list appeared" but THE account list for the member we were asked
            // about. On this surface the member number is echoed in bold next to the `Member:`
            // prompt, which is the visible identifying value SPEC section 12.3 item 5 requires.
            continuity: ["subjectMember"],
          },
          // All three detectors read the INQUIRY screen's status band, because the app stays where
          // it is and states the condition there. Band B3 runs before the checkpoint (B5), so a
          // declared outcome wins over "you are not on the account list" - which is what makes
          // MEMBER_NOT_FOUND an answer rather than a failure.
          outcomes: [
            {
              code: "MEMBER_NOT_FOUND",
              detect: textIn(INQUIRY_SCOPE, "not-on-file-banner"),
              priority: 10,
              phase: "post",
              requiresSettled: true,
              origin: "hand-authored",
              capture: [],
            },
            {
              code: "MEMBER_RESTRICTED",
              detect: textIn(INQUIRY_SCOPE, "restricted-banner"),
              priority: 20,
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
          id: "read-accounts" as StepId,
          title: "Read the account grid",
          intent: "Take every account on file with its suffix, description and balance.",
          effect: "READ",
          instruction: { kind: "readTable" },
          target: null,
          precondition: null,
          settle,
          expect: {
            predicate: { all: [settled, onRoute(ACCOUNTS)] } as Predicate,
            delta: { mustChange: false },
            continuity: ["subjectMember"],
          },
          outcomes: [],
          recoveries: [],
          extract: [accountsExtract],
          budgets,
          evidence,
        },
        {
          id: "read-share-balance" as StepId,
          title: "Read the regular savings balance",
          intent: "Pick the share account out of the grid by its suffix.",
          effect: "READ",
          instruction: { kind: "read" },
          target: null,
          precondition: null,
          settle,
          expect: {
            predicate: { all: [settled, onRoute(ACCOUNTS)] } as Predicate,
            delta: { mustChange: false },
            continuity: ["subjectMember"],
          },
          outcomes: [],
          recoveries: [],
          extract: [shareBalanceExtract],
          budgets,
          evidence,
        },
        {
          id: "return-to-inquiry" as StepId,
          title: "Put the terminal back on the inquiry screen",
          intent:
            "Leave the session where the next invocation expects to find it, rather than parked on a member's record.",
          effect: "READ",
          // THE STEP THE ACCEPTANCE TEST IS ABOUT, half two, and the reason F-keys are not in this
          // language. `Back` is F3 at riverbend and F12 at summit. This document says neither.
          instruction: { kind: "activate" },
          target: backControlTarget,
          precondition: null,
          settle,
          expect: {
            predicate: { all: [settled, onRoute(INQUIRY)] } as Predicate,
            delta: { mustChange: true, navigatedTo: INQUIRY },
            continuity: [],
          },
          outcomes: [],
          recoveries: [],
          extract: [],
          budgets,
          evidence,
        },
      ],
      ambient: [
        {
          name: "SESSION_EXPIRED",
          band: "environment",
          // TWO INDEPENDENT FACTS, and not the obvious one. The sign-on screen prints
          // `SESSION HAS ENDED. SIGN ON TO CONTINUE.` as an unlabelled prose line, and `detect()`
          // does not emit a node for prose - it emits headings, labelled fields, legend controls,
          // status bands and tables, and refuses to guess at the rest. So the detector reads what
          // IS structure: the screen-id band (which is also the route) and the operator-id prompt
          // that only this screen has. A REAL GAP, stated here rather than worked around silently:
          // a taxonomy that cannot see the sentence explaining a failure is weaker than one that
          // can, and the fix belongs in `detect()` - unlabelled prose lines in the body of a screen
          // should become `text` nodes - not in this document.
          detect: {
            all: [
              onRoute(SIGNON),
              exists({ scope: SIGNON_SCOPE, role: "textbox", name: token("operator-field") }),
            ],
          } as Predicate,
          priority: 10,
          phase: "post",
          // The program never signs on. The broker owns the operator credential and re-establishes
          // the session on the same transport; SPEC section 7.6. A green screen makes that division
          // unusually visible, because signing on IS a screen and the temptation to make it a step
          // is right there.
          remedy: { kind: "reauthenticate" },
          maxAttempts: 1,
          allowUnsettled: true,
          afterRemedy: "reverify",
          resume: "restart-program",
        },
        {
          name: "APP_ERROR_SCREEN",
          band: "environment",
          // Same reasoning as SESSION_EXPIRED: `*** ABEND 0C7 - DATA EXCEPTION` is prose and is not
          // a node, so the detector reads the screen-id band and the vendor's own banner heading.
          detect: {
            all: [
              onRoute(ABEND),
              exists({ scope: ABEND_SCOPE, role: "heading", name: token("abend-heading") }),
            ],
          } as Predicate,
          priority: 20,
          phase: "both",
          // `F3=Exit` on the abend screen, expressed the only way this language allows: activate
          // the control named Exit. The remedy is subject to the same check 21 as a step.
          remedy: {
            kind: "actions",
            instructions: [{ kind: "activate", target: abendExitTarget }],
          },
          maxAttempts: 1,
          allowUnsettled: true,
          afterRemedy: "reverify",
          resume: "restart-program",
        },
      ],
    },
    continuity: [
      {
        id: "subjectMember",
        source: { from: "param", param: "memberNumber" },
        compare: { via: "std.text@1", type: { kind: "string", charset: "digits" } },
      },
    ],
    provenance: {
      discoveryRunId: "run-terminal-corpus",
      goalTemplate: "list the accounts on file for member {memberNumber}",
      model: { adapter: "replay", modelId: "none:hand-authored", promptVersion: "n/a" },
      transcriptRef: null,
      recordedAt: "2026-02-18T09:14:07.000Z",
      recordedAgainst: {
        tenantId: "riverbend",
        appInstanceId: "riverbend-green",
        fingerprint: {
          perStep: {
            "enter-member-number": "fp:t0",
            "run-inquiry": "fp:t1",
            "read-accounts": "fp:t2",
            "read-share-balance": "fp:t3",
            "return-to-inquiry": "fp:t4",
          },
        },
      },
    },
    verification: {
      mode: "replay-full",
      status: "verified",
      coveredThroughStep: "return-to-inquiry" as StepId,
      grade: "full",
      runId: "run-terminal-verify",
      at: "2026-02-18T09:16:55.000Z",
    },
    policy: {
      originAliases: [TERMINAL_ORIGIN],
      maxEffect: "READ",
      requiresApprovalToken: false,
      redaction: { taintedParams: ["memberNumber"], maskScreenshotRegions: true },
    },
    effects: {
      maxEffect: "READ",
      irreversibleSteps: [],
      routesTouched: [INQUIRY, ACCOUNTS],
      // In STEP ORDER: check 13 re-derives this list from the steps and compares it, so the order
      // is a fact about the program rather than a preference.
      reads: [
        { field: "accounts", sensitivity: "sensitive" },
        { field: "shareBalance", sensitivity: "sensitive" },
      ],
      requiresApproval: false,
      restartSafeUpToPc: 5,
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
    approvedBy: "ops-approver-terminal",
    approvedAt: "2026-02-18T10:02:11.000Z",
    signature: "ed25519:dGVybWluYWwtc2lnbmF0dXJl",
    keyId: "terminal-key-1",
    alg: "ed25519",
    acknowledgedEffects: ["READ"],
    acknowledgedGrade: "full",
    acknowledgedPromotions: [],
  });
}

// ---------------------------------------------------------------------------------------------
// The second credit union
// ---------------------------------------------------------------------------------------------

/**
 * Summit, in nine lines.
 *
 * COUNT WHAT IS NOT HERE. Between these two tenants the bank name, the screen title, the teller id,
 * both field labels, both field widths, the field row, the field column, both screen names and the
 * exit key all change - the terminal spike measured not one shared coordinate. Three tokens fix it,
 * and the exit key is not one of them, because the key is chosen by the driver from the legend the
 * application itself printed. That division is the argument for keeping F-keys at the port, and it
 * is visible here as an absence.
 */
export const summitOverlay: CapabilityOverlay = sealOverlay({
  schemaVersion: "capability.overlay/v1",
  appliesTo: { artifactId: "corebank-member-account-list-tui", version: { min: 1 } },
  tenantId: "summit",
  appInstanceId: "summit-green",
  // A telnet authority, not a web one. `OriginSchema` accepted only http(s) until this document
  // needed to exist; writing `https://` here would have been a lie about how the session is opened.
  originAliases: { [TERMINAL_ORIGIN]: "telnet://green.summit.example.invalid:23" },
  vocabulary: {
    "account-field": ["Acct #"],
    "inquiry-screen": ["MBR INQ 01"],
    "accounts-screen": ["ACCT LIST 02"],
  },
});

/** The base tenant's binding, so both tenants run through the same code path and neither is a
 *  special case. It changes no vocabulary at all - which is the measurement, not an omission. */
export const riverbendOverlay: CapabilityOverlay = sealOverlay({
  schemaVersion: "capability.overlay/v1",
  appliesTo: { artifactId: "corebank-member-account-list-tui", version: { min: 1 } },
  tenantId: "riverbend",
  appInstanceId: "riverbend-green",
  originAliases: { [TERMINAL_ORIGIN]: "telnet://green.riverbend.example.invalid:23" },
});

// ---------------------------------------------------------------------------------------------
// Deployment policy
// ---------------------------------------------------------------------------------------------

/**
 * What this automation may touch on this system.
 *
 * `pressKey` is on the list and `navigate` is not, which is the allowlist telling the same truth the
 * driver's `capabilities()` tells: a green screen is driven by keystrokes and cannot be sent
 * anywhere by name. Note that the two paths are the SCREEN NUMBERS - one allowlist serves both
 * credit unions, because the branding is in the screen NAME and the name is not in the path.
 */
export const terminalAllowlist: Allowlist = {
  originAliases: [TERMINAL_ORIGIN],
  routes: [
    { originAlias: TERMINAL_ORIGIN, pathPattern: "/screen/01", maxEffect: "READ" },
    { originAlias: TERMINAL_ORIGIN, pathPattern: "/screen/02", maxEffect: "READ" },
    { originAlias: TERMINAL_ORIGIN, pathPattern: "/screen/00", maxEffect: "READ" },
    { originAlias: TERMINAL_ORIGIN, pathPattern: "/screen/99", maxEffect: "READ" },
  ],
  actionKinds: ["click", "type", "pressKey", "focus"],
  maxEffect: "READ",
  discoveryMaxEffect: "READ",
};

/** As in the browser corpus: this suite grades the ENGINE, and the crypto is under test in
 *  `@crr/runtime`'s `approval.test.ts`. */
export const terminalTrust = unverifiedTrust(["terminal-key-1"]);
