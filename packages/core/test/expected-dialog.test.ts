// `Checkpoint.dialog` - SPEC section 4.4's amendment, and the resolution of FINAL-STATUS section
// 7.3: a DECLARED dialog is a postcondition, and everything else is still an interception.
//
// The band order runs B2 (interception) before B5 (checkpoint). That ordering defends one sentence
// which is true - what is visible BEHIND a modal is stale by construction - and used to enforce a
// second which is not: that every dialog is an interruption. A confirmation dialog is the
// postcondition of the click that raised it, and the consequence of conflating the two was that
// `fixtures/corebank-web`'s modal confirmation, and therefore its only real write, could not be
// expressed at all.
//
// This file is the argument that the amendment costs nothing. Read the five describes in order:
//
//   1. B2 STANDS DOWN for the declared dialog - on both sides of the step boundary it spans, and
//      not at all for a step that declared nothing, which is every artifact written before this.
//   2. B2 STILL FAILS CLOSED on everything else: four screens that must remain
//      `undeclared-dialog`, one per way the stand-down could have been widened into a hole, plus
//      the ordering that keeps a declared interception RECOVERY in charge where one applies.
//   3. B5 HOLDS THE STEP TO IT - the obligation half. A step that told B2 to stand down has to say
//      what it expected, and is failed when the screen does not carry it.
//   4. B3 NEVER RUNS BEHIND A MODAL, declared or not. The true half of "B2 before B3", preserved:
//      a terminal business outcome is never read off the screen behind a panel.
//   5. THE LINKER charges for the licence at load time, before a browser is launched.
//
// No browser, no fixture server, no session. Every screen is a frozen `Observation`.

import { describe, expect, it } from "vitest";
import {
  type Checkpoint,
  type ExpectedDialog,
  type LinkRequest,
  type LinkResult,
  MOCK_SURFACE_CAPABILITIES,
  type NodeId,
  type NodeQuery,
  type Observation,
  type ResolvedStep,
  type UINode,
  type Verdict,
  artifactDigestOf,
  classify,
  link,
} from "../src/index.js";
import {
  inputFor,
  notFoundBanner,
  notFoundBehindModal,
  resolvedStep,
} from "./fixtures/classifier-screens.js";
import { results, resultsNotice, searchNativeConfirm } from "./fixtures/corebank-observations.js";
import {
  memberLookupArtifact,
  memberLookupContract,
  summitOverlay,
} from "./fixtures/member-lookup.js";
import type { JsonRecord } from "./fixtures/spec-10-rejections.js";

// ---------------------------------------------------------------------------------------------
// The declared dialog, and the screens that do or do not carry it
// ---------------------------------------------------------------------------------------------

const exact = (value: string) => ({ mode: "exact", value, normalize: "std.text@1" }) as const;

/** The content frame, spelled as a MATCHER. `corebank-observations.ts` exports the runtime
 *  `ContainerSegment` of the same name; a matcher carries a `TextMatcher` where that carries a
 *  string, and they are not interchangeable. */
const CONTENT_FRAME = { kind: "frame", name: exact("content") } as const;

const dialogNamed = (name: string) =>
  ({ scope: { path: [CONTENT_FRAME] }, role: "dialog", name: exact(name) }) as unknown as NodeQuery;

/** The confirmation panel, named the way an artifact would name it: a scope, the `dialog` role and
 *  the accessible name. Linker check 25 requires the role. */
const CONFIRM_QUERY = dialogNamed("Confirm Sub-Account");
const OTHER_QUERY = dialogNamed("Print Preview");

const declares = (where: NodeQuery, present: boolean): ExpectedDialog =>
  ({ where, present }) as ExpectedDialog;

/** A step from the frozen member-lookup flow, with a dialog declared on its checkpoint. */
function stepExpecting(
  id: string,
  dialog: ExpectedDialog | undefined,
  overrides: Partial<ResolvedStep> = {},
): ResolvedStep {
  const base = resolvedStep(id, overrides as never);
  const expect_: Checkpoint = { ...base.expect, ...(dialog === undefined ? {} : { dialog }) };
  return { ...base, expect: expect_ } as ResolvedStep;
}

/** The maintenance notice the frozen corpus already carries, and the one the member-lookup flow's
 *  own ambient rule is written to dismiss. Every panel below is a copy of it with a different
 *  accessible name - which is exactly what the fixture's interstitial and its confirmation panel
 *  are in the real application: ONE WIDGET RENDERED TWICE. If they were visually distinctive, none
 *  of this discipline would ever be tested. */
const noticeNode = resultsNotice.nodes.find(
  (node) => node.id === ("dialog:notice" as NodeId),
) as UINode;

const panelNamed = (id: string, name: string): UINode =>
  ({ ...noticeNode, id: id as NodeId, name, children: [] }) as UINode;

const confirmPanel = panelNamed("dialog:confirm", "Confirm Sub-Account");
const printPanel = panelNamed("dialog:print", "Print Preview");

const withNodes = (base: Observation, nodes: readonly UINode[]): Observation =>
  ({ ...base, nodes, inputIntercepted: true }) as Observation;

/** The results grid under the confirmation panel: the declared dialog, and nothing else. */
const resultsUnderConfirm = withNodes(results, [...results.nodes, confirmPanel]);

/** The not-found banner under the confirmation panel. The banner is the screen BEFORE whatever
 *  raised the panel, which is the whole reason band B3 must not run here. */
const notFoundUnderConfirm = withNodes(notFoundBanner, [...notFoundBanner.nodes, confirmPanel]);

/** Two modals at once: the declared one, and one nobody declared. */
const twoDialogs = withNodes(results, [...results.nodes, confirmPanel, printPanel]);

/** The confirmation panel, hidden. `inputIntercepted` says something is blocking and no VISIBLE
 *  dialog node explains it - so a declaration that names a dialog does not cover it. */
const invisibleConfirm = withNodes(results, [
  ...results.nodes,
  { ...confirmPanel, state: { ...confirmPanel.state, visible: false } },
]);

/**
 * The flow's own ambient rules are switched OFF for most of the cases below, and one case switches
 * them back on. They are not what this file is about, and the member-lookup corpus's
 * `DISMISS_SYSTEM_NOTICE` rule fires on any screen carrying the notice panel - so leaving them in
 * would test the ambient band rather than the clause.
 */
const noAmbient = { ambient: [] as never } as const;

function expectFail(verdict: Verdict, failure: string): string {
  expect(verdict.kind, `expected fail(${failure}), got ${verdict.kind}`).toBe("fail");
  if (verdict.kind !== "fail") throw new Error("unreachable");
  expect(verdict.failure).toBe(failure);
  return verdict.detail.expected.rendered;
}

// ---------------------------------------------------------------------------------------------

describe("band B2 stands down for the dialog a step declared", () => {
  it("lets the checkpoint adjudicate the dialog that this step's own action raised", () => {
    const step = stepExpecting("submit-search", declares(CONFIRM_QUERY, true), { recoveries: [] });
    const verdict = classify(inputFor(step, resultsUnderConfirm, noAmbient));
    // Without the clause this screen is `undeclared-dialog`: the modal is up, and B2 answers first.
    expect(verdict.kind).toBe("advance");
  });

  it("lets the step that ANSWERS the dialog begin, because the dialog outlives the step boundary", () => {
    // The pre-act screen of the answering step IS the post-act screen of the raising step. A clause
    // that only covered the raising step would move the refusal one step to the right and change
    // nothing, which is why `present` is a field rather than an inference: the answering step
    // declares the same dialog and expects it GONE.
    const step = stepExpecting("open-member-row", declares(CONFIRM_QUERY, false), {
      recoveries: [],
    });
    const verdict = classify(inputFor(step, resultsUnderConfirm, { ...noAmbient, phase: "pre" }));
    expect(verdict.kind).toBe("advance");
  });

  it("changes nothing for a step that declares no dialog - which is every artifact written before this", () => {
    const step = stepExpecting("submit-search", undefined, { recoveries: [] });
    expectFail(classify(inputFor(step, resultsUnderConfirm, noAmbient)), "undeclared-dialog");
  });
});

describe("band B2 still fails closed on everything else", () => {
  it("refuses a dialog whose identity is not the one declared, on the same widget", () => {
    const step = stepExpecting("submit-search", declares(OTHER_QUERY, true), { recoveries: [] });
    expectFail(classify(inputFor(step, resultsUnderConfirm, noAmbient)), "undeclared-dialog");
  });

  it("refuses TWO dialogs when only one of them was declared", () => {
    // The load-bearing case. `some` would have passed this; the rule is `every`, because a modal
    // nobody declared is undeclared whether it arrives alone or in company.
    const step = stepExpecting("submit-search", declares(CONFIRM_QUERY, true), { recoveries: [] });
    expectFail(classify(inputFor(step, twoDialogs, noAmbient)), "undeclared-dialog");
  });

  it("refuses a NATIVE dialog even when the step declares one, because that channel cannot carry a postcondition", () => {
    // A native dialog blocks the renderer: there is no post-act observation to check anything
    // against, so a `window.confirm` can never BE a postcondition. It stays what it is.
    const step = stepExpecting("open-member-row", declares(CONFIRM_QUERY, true), {
      recoveries: [],
    });
    expectFail(classify(inputFor(step, searchNativeConfirm, noAmbient)), "undeclared-dialog");
  });

  it("refuses an interception that no visible dialog node explains", () => {
    // `inputIntercepted` with nothing the driver could name as a dialog: an overlay the tree does
    // not describe. A declaration that names a dialog does not cover it.
    const step = stepExpecting("submit-search", declares(CONFIRM_QUERY, true), { recoveries: [] });
    expectFail(classify(inputFor(step, notFoundBehindModal, noAmbient)), "undeclared-dialog");
    expectFail(classify(inputFor(step, invisibleConfirm, noAmbient)), "undeclared-dialog");
  });

  it("leaves a declared interception RECOVERY in charge, so a notice on top of a confirmation is still dismissed", () => {
    // Ordering inside B2: recovery rules are matched FIRST and the stand-down is checked after, so
    // nothing an existing artifact declares changes meaning. Here the flow's own ambient
    // DISMISS_SYSTEM_NOTICE rule fires on the maintenance panel even though the step also declares
    // a confirmation panel of its own - which is the right answer: clear the interloper, re-verify,
    // and the declared dialog is then alone on screen.
    const step = stepExpecting("submit-search", declares(CONFIRM_QUERY, true), { recoveries: [] });
    const screen = withNodes(resultsNotice, [...resultsNotice.nodes, confirmPanel]);
    const verdict = classify(inputFor(step, screen));
    expect(verdict.kind).toBe("recover");
    if (verdict.kind !== "recover") throw new Error("unreachable");
    expect(verdict.recoveryName).toBe("DISMISS_SYSTEM_NOTICE");
  });
});

describe("band B5 holds a step to the dialog it declared", () => {
  it("fails the checkpoint when the dialog the step expected to raise never appeared", () => {
    const step = stepExpecting("submit-search", declares(CONFIRM_QUERY, true), { recoveries: [] });
    const rendered = expectFail(classify(inputFor(step, results, noAmbient)), "checkpoint-failed");
    expect(rendered.length).toBeGreaterThan(0);
  });

  it("fails the checkpoint when the dialog the step answered is still open", () => {
    const step = stepExpecting("submit-search", declares(CONFIRM_QUERY, false), { recoveries: [] });
    // B2 stands down (it is the declared dialog) and B5 says the answer did not take - which is a
    // far more useful sentence than `undeclared-dialog` about a dialog this step is answering.
    expectFail(classify(inputFor(step, resultsUnderConfirm, noAmbient)), "checkpoint-failed");
  });

  it("advances when the dialog the step answered is gone", () => {
    const step = stepExpecting("submit-search", declares(CONFIRM_QUERY, false), { recoveries: [] });
    expect(classify(inputFor(step, results, noAmbient)).kind).toBe("advance");
  });
});

describe("band B3 never runs behind a modal, declared or not", () => {
  // The half of "B2 before B3" that is TRUE, and the thing the amendment must not spend.
  const outcomeStep = (dialog: ExpectedDialog | undefined) =>
    stepExpecting("submit-search", dialog, { recoveries: [] });

  it("returns MEMBER_NOT_FOUND on the bare screen - the control case", () => {
    const verdict = classify(inputFor(outcomeStep(undefined), notFoundBanner, noAmbient));
    expect(verdict.kind).toBe("outcome");
    if (verdict.kind !== "outcome") throw new Error("unreachable");
    expect(verdict.code).toBe("MEMBER_NOT_FOUND");
  });

  it("refuses to return it off the same screen once a DECLARED modal is over it", () => {
    // The banner behind the panel is the state before whatever raised the panel. Reading a terminal
    // business outcome off it would be reading history - the exact hazard the band order defends,
    // and it survives the stand-down intact.
    const verdict = classify(
      inputFor(outcomeStep(declares(CONFIRM_QUERY, true)), notFoundUnderConfirm, noAmbient),
    );
    expect(verdict.kind).not.toBe("outcome");
    expectFail(verdict, "checkpoint-failed");
  });
});

// ---------------------------------------------------------------------------------------------
// The linker: the same obligations, refused before a browser is launched
// ---------------------------------------------------------------------------------------------

const clone = <T>(value: T): T => structuredClone(value) as T;

function resealArtifact(doc: JsonRecord): JsonRecord {
  const { digest: _stale, ...rest } = doc;
  void _stale;
  const digest = artifactDigestOf(rest);
  const lifecycle = rest.lifecycle as JsonRecord | undefined;
  const approval = lifecycle?.approval as JsonRecord | null | undefined;
  if (approval !== null && approval !== undefined) approval.over = digest;
  return { ...rest, digest };
}

function artifactWith(mutate: (doc: JsonRecord) => void): JsonRecord {
  const doc = clone(memberLookupArtifact) as unknown as JsonRecord;
  mutate(doc);
  return resealArtifact(doc);
}

const stepIn = (doc: JsonRecord, id: string): JsonRecord =>
  ((doc.flow as JsonRecord).steps as JsonRecord[]).find((s) => s.id === id) as JsonRecord;

function requestWith(mutate: (doc: JsonRecord) => void): LinkRequest {
  return {
    contract: memberLookupContract,
    artifact: artifactWith(mutate) as never,
    overlay: summitOverlay,
    capabilities: MOCK_SURFACE_CAPABILITIES,
    args: { memberId: "400123" },
    invocation: {
      name: memberLookupContract.name,
      version: memberLookupContract.version,
      contractDigest: memberLookupContract.digest,
    },
    mode: "replay",
    allowlist: {
      originAliases: ["corebank"],
      routes: [
        { originAlias: "corebank", pathPattern: "/members/search", maxEffect: "READ" },
        { originAlias: "corebank", pathPattern: "/members/:memberId", maxEffect: "READ" },
        { originAlias: "corebank", pathPattern: "/cb/members/search", maxEffect: "READ" },
        { originAlias: "corebank", pathPattern: "/cb/members/:memberId", maxEffect: "READ" },
      ],
      actionKinds: ["click", "type", "navigate", "pressKey", "acceptDialog", "dismissDialog"],
      maxEffect: "READ",
      discoveryMaxEffect: "READ",
    },
    trust: { trustedKeyIds: ["ops-approval-key-1"], verifySignature: () => true },
  } as LinkRequest;
}

const explain = (result: LinkResult): string =>
  result.ok ? "linked with no errors" : result.errors.map((e) => `${e.check}/${e.code}`).join(", ");

function expectRefusedWith(result: LinkResult, code: string): void {
  expect(result.ok, explain(result)).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(
    result.errors.map((e) => e.code),
    explain(result),
  ).toContain(code);
  expect(result.errors.filter((e) => e.code === code).every((e) => e.check === 25)).toBe(true);
}

describe("linker check 25 makes the licence cost something at load time", () => {
  const declaredOn = (id: string, dialog: Record<string, unknown>) => (doc: JsonRecord) => {
    (stepIn(doc, id).expect as JsonRecord).dialog = dialog;
  };
  const notice = { where: { role: "dialog", name: exact("System Notice") }, present: true };

  it("accepts a well-formed declaration on a step that reads nothing and concludes nothing", () => {
    const result = link(requestWith(declaredOn("enter-member-id", notice)));
    expect(result.ok ? null : explain(result)).toBeNull();
  });

  it("refuses a query that cannot select a dialog, because it would stand down for nothing", () => {
    expectRefusedWith(
      link(
        requestWith(
          declaredOn("enter-member-id", {
            where: { role: "button", name: exact("Confirm") },
            present: true,
          }),
        ),
      ),
      "checkpoint-dialog-not-a-dialog",
    );
  });

  it("refuses a step that declares an OPEN dialog and a business outcome on the same checkpoint", () => {
    // `submit-search` carries MEMBER_NOT_FOUND. Behind a modal that outcome is history, and the
    // classifier already refuses to return it; this makes the document itself refuse to load.
    expectRefusedWith(
      link(requestWith(declaredOn("submit-search", notice))),
      "checkpoint-dialog-shadows-declarations",
    );
  });

  it("refuses a step that declares an OPEN dialog and reads a value from behind it", () => {
    expectRefusedWith(
      link(requestWith(declaredOn("read-savings-balance", notice))),
      "checkpoint-dialog-shadows-declarations",
    );
  });

  it("refuses a program whose LAST step ends with a dialog open", () => {
    // The last step's postcondition is the state the automation hands back, to a caller or to a
    // human at the operator console. A blocked screen is not a state anybody can be handed.
    expectRefusedWith(
      link(requestWith(declaredOn("read-savings-balance", notice))),
      "checkpoint-dialog-left-open",
    );
  });

  it("permits `present: false` on the last step - answering a dialog is a fine way to finish", () => {
    const result = link(
      requestWith(
        declaredOn("read-savings-balance", {
          where: { role: "dialog", name: exact("System Notice") },
          present: false,
        }),
      ),
    );
    expect(result.ok ? null : explain(result)).toBeNull();
  });
});
