// The loop's own contract: the chokepoint, the stopping conditions, and the refusals.
//
// Every test here drives the real loop over `MockSurface` with a scripted model. Nothing in this
// file can reach a provider, and that is not a comment - `createScriptedModel` holds an array.

import { type Allowlist, MockSurface } from "@crr/core";
import { describe, expect, it } from "vitest";
import {
  type DiscoveryEvent,
  type DiscoveryLoopOptions,
  type ScriptedTurn,
  createScriptedModel,
  defaultEffectOf,
  runDiscoveryLoop,
} from "../src/index.js";
import {
  ALLOWLIST,
  CONTROL,
  FROZEN_NOW,
  GOAL,
  frozenClockMs,
  screens,
  transitions,
} from "./fixtures/corebank.js";

const TARGET = {
  tenantId: "riverbend",
  originAlias: "corebank",
  entryRoute: "/members/search",
} as const;

async function run(
  script: readonly ScriptedTurn[],
  overrides: Partial<DiscoveryLoopOptions> = {},
  start = "searchForm",
) {
  const surface = new MockSurface({ screens, start, transitions });
  const result = await runDiscoveryLoop({
    goal: GOAL,
    target: TARGET,
    model: createScriptedModel(script),
    surface,
    allowlist: ALLOWLIST,
    control: CONTROL,
    now: () => FROZEN_NOW,
    nowMs: frozenClockMs(),
    ...overrides,
  });
  return { result, surface };
}

const observe: ScriptedTurn = { toolUses: [{ name: "observe", input: {} }] };
const act = (input: Record<string, unknown>): ScriptedTurn => ({
  toolUses: [{ name: "act", input: { value: null, key: null, ...input } }],
});
const finish = (status: "reached-goal" | "stuck", summary: string): ScriptedTurn => ({
  toolUses: [{ name: "finish", input: { status, summary, outcomeCandidates: null } }],
});

const typesOf = (events: readonly DiscoveryEvent[]): readonly string[] =>
  events.map((event) => event.type);

// ---------------------------------------------------------------------------------------------
// The chokepoint
// ---------------------------------------------------------------------------------------------

describe("every dispatched action passes the policy gate first", () => {
  it("emits a policy.decided immediately before every acted, with the same action kind", async () => {
    const { result } = await run([
      observe,
      act({ nodeRef: "n1", action: "fill", value: "50001", why: "the task names this member" }),
      act({ nodeRef: "n2", action: "activate", why: "submit the search" }),
      finish("reached-goal", "found the member"),
    ]);
    const events = result.events;
    const actedAt = events.flatMap((event, index) => (event.type === "acted" ? [index] : []));
    expect(actedAt.length).toBe(2);
    for (const index of actedAt) {
      const before = events[index - 1];
      const acted = events[index];
      expect(before?.type).toBe("policy.decided");
      if (before?.type !== "policy.decided" || acted?.type !== "acted") throw new Error("shape");
      expect(before.actionKind).toBe(acted.actionKind);
      expect(before.decision.allow).toBe(true);
    }
  });

  it("dispatches nothing when the gate refuses, and tells the model why", async () => {
    // A discovery run capped at READ may not click a button, because a click could be a submit and
    // no pure function can prove otherwise. SPEC 8.2's declared-not-proven limit, enforced.
    const readOnly: Allowlist = { ...ALLOWLIST, discoveryMaxEffect: "READ" };
    const { result, surface } = await run(
      [
        observe,
        act({ nodeRef: "n2", action: "activate", why: "submit the search" }),
        finish("stuck", "the safety allowlist would not let me submit"),
      ],
      { allowlist: readOnly },
    );
    expect(surface.dispatched).toHaveLength(0);
    expect(result.steps).toHaveLength(0);
    expect(result.status).toBe("stuck");
    const refusal = result.events.find((event) => event.type === "tool.refused");
    expect(refusal?.type === "tool.refused" && refusal.reason).toBe("policy-denied");
    expect(refusal?.type === "tool.refused" && refusal.detail).toContain(
      "effect-exceeds-allowlist",
    );
  });

  it("refuses a route that is not on the allowlist, before navigating", async () => {
    const { result, surface } = await run([
      observe,
      {
        toolUses: [
          { name: "go", input: { routeHint: "/admin/users", why: "look for the member" } },
        ],
      },
      finish("stuck", "that route is not permitted"),
    ]);
    expect(surface.dispatched).toHaveLength(0);
    const refusal = result.events.find((event) => event.type === "tool.refused");
    expect(refusal?.type === "tool.refused" && refusal.detail).toContain("route-not-allowed");
  });

  it("takes the origin from the target and never from the model", async () => {
    const { result } = await run([
      observe,
      {
        toolUses: [
          { name: "go", input: { routeHint: "/members/search", why: "back to the search form" } },
        ],
      },
      finish("reached-goal", "back at the search form"),
    ]);
    const step = result.steps.find((candidate) => candidate.tool === "go");
    expect(step?.route?.originAlias).toBe("corebank");
  });
});

// ---------------------------------------------------------------------------------------------
// Node references
// ---------------------------------------------------------------------------------------------

describe("a node reference is valid for exactly one turn", () => {
  it("refuses a reference that is not on the screen the model was last shown", async () => {
    const { result, surface } = await run([
      observe,
      act({ nodeRef: "n99", action: "activate", why: "click the thing" }),
      finish("stuck", "the reference was stale"),
    ]);
    expect(surface.dispatched).toHaveLength(0);
    const refusal = result.events.find((event) => event.type === "tool.refused");
    expect(refusal?.type === "tool.refused" && refusal.reason).toBe("stale-node-ref");
  });

  it("refuses an action before the first observe, rather than guessing at a screen", async () => {
    const { result } = await run([
      act({ nodeRef: "n1", action: "activate", why: "click the thing" }),
      finish("stuck", "I had not looked yet"),
    ]);
    const refusal = result.events.find((event) => event.type === "tool.refused");
    expect(refusal?.type === "tool.refused" && refusal.detail).toContain(
      "call observe before acting",
    );
  });

  it("renumbers after every action, so an old reference cannot survive", async () => {
    // n7 is the Select link on the results screen and does not exist on the search form.
    const { result, surface } = await run([
      observe,
      act({ nodeRef: "n7", action: "activate", why: "open the member" }),
      finish("stuck", "not there yet"),
    ]);
    expect(surface.dispatched).toHaveLength(0);
    expect(result.steps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// One action per turn
// ---------------------------------------------------------------------------------------------

describe("one action per turn is enforced on our side too", () => {
  it("refuses a second acting tool call in the same assistant message", async () => {
    // `disable_parallel_tool_use` is the provider-side half. This is the half that still holds if a
    // provider ignores the flag - and without it the recorded step order would be a lie.
    const { result, surface } = await run([
      observe,
      {
        toolUses: [
          {
            name: "act",
            input: {
              nodeRef: "n1",
              action: "fill",
              value: "50001",
              key: null,
              why: "enter the member number",
            },
          },
          {
            name: "act",
            input: {
              nodeRef: "n2",
              action: "activate",
              value: null,
              key: null,
              why: "and submit it",
            },
          },
        ],
      },
      finish("stuck", "only the first action was taken"),
    ]);
    expect(surface.dispatched).toHaveLength(1);
    expect(result.steps).toHaveLength(1);
    const refusal = result.events.find((event) => event.type === "tool.refused");
    expect(refusal?.type === "tool.refused" && refusal.detail).toContain("one action at a time");
  });
});

// ---------------------------------------------------------------------------------------------
// Stopping conditions
// ---------------------------------------------------------------------------------------------

describe("the loop stops for a stated reason", () => {
  it("reports budget-exhausted when the turn budget runs out", async () => {
    const { result } = await run([observe, observe, observe], { limits: { maxTurns: 2 } });
    expect(result.status).toBe("budget-exhausted");
    expect(result.turns).toBe(2);
    expect(result.summary).toContain("turn budget");
  });

  it("refuses further actions when the action budget runs out", async () => {
    const { result, surface } = await run(
      [
        observe,
        act({ nodeRef: "n1", action: "fill", value: "50001", why: "enter it" }),
        act({ nodeRef: "n2", action: "activate", why: "submit" }),
        finish("stuck", "out of actions"),
      ],
      { limits: { maxActions: 1 } },
    );
    expect(surface.dispatched).toHaveLength(1);
    const refusal = result.events.find((event) => event.type === "tool.refused");
    expect(refusal?.type === "tool.refused" && refusal.reason).toBe("budget");
  });

  it("stops after a run of refusals rather than paying for the same mistake", async () => {
    const stale = act({ nodeRef: "n99", action: "activate", why: "click" });
    const { result } = await run([observe, stale, stale, stale, stale, stale], {
      limits: { maxConsecutiveRefusals: 3 },
    });
    expect(result.status).toBe("budget-exhausted");
    expect(result.summary).toContain("in a row were refused");
  });

  it("reports model-stopped, not stuck, when the model just stops calling tools", async () => {
    // `stuck` is a claim the model makes deliberately. Attributing it here would put words in its
    // mouth in the evidence bundle.
    const { result } = await run([{ text: "I am not sure what to do here." }]);
    expect(result.status).toBe("model-stopped");
    expect(result.summary).toBe("I am not sure what to do here.");
  });

  it("carries an honest stuck with its outcome candidates", async () => {
    const { result } = await run(
      [
        observe,
        act({ nodeRef: "n2", action: "activate", why: "submit an empty search" }),
        {
          toolUses: [
            {
              name: "finish",
              input: {
                status: "stuck",
                summary: "The application reported that no member exists for that number.",
                outcomeCandidates: [
                  {
                    code: "MEMBER_NOT_FOUND",
                    title: "No such member",
                    why: "the screen showed: No member found for 99999",
                  },
                ],
              },
            },
          ],
        },
      ],
      {},
    );
    expect(result.status).toBe("stuck");
    expect(result.outcomeCandidates).toEqual([
      {
        code: "MEMBER_NOT_FOUND",
        title: "No such member",
        why: "the screen showed: No member found for 99999",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Effect classification
// ---------------------------------------------------------------------------------------------

describe("effect is declared, not proven", () => {
  it("classifies a navigation as READ and a click as WRITE_REVERSIBLE", () => {
    expect(
      defaultEffectOf({
        kind: "navigate",
        route: { originAlias: "corebank", path: "/x", query: {} },
      }),
    ).toBe("READ");
    expect(defaultEffectOf({ kind: "focus", target: "button:search" as never })).toBe("READ");
    expect(defaultEffectOf({ kind: "click", target: "button:search" as never })).toBe(
      "WRITE_REVERSIBLE",
    );
  });

  it("never derives WRITE_IRREVERSIBLE, so the strongest control is unreachable by heuristic", () => {
    const kinds = ["click", "type", "select", "setChecked", "pressKey", "acceptDialog"] as const;
    for (const kind of kinds) {
      const action = {
        kind,
        target: "button:x" as never,
        text: "",
        mode: "replace",
        sensitive: false,
        option: "",
        checked: false,
        key: "Enter",
      } as never;
      expect(defaultEffectOf(action)).not.toBe("WRITE_IRREVERSIBLE");
    }
  });

  it("requires an approval token once the caller declares one irreversible", async () => {
    const { result, surface } = await run(
      [
        observe,
        act({ nodeRef: "n2", action: "activate", why: "submit" }),
        finish("stuck", "needed approval"),
      ],
      {
        allowlist: {
          ...ALLOWLIST,
          maxEffect: "WRITE_IRREVERSIBLE",
          discoveryMaxEffect: "WRITE_IRREVERSIBLE",
          routes: ALLOWLIST.routes.map((route) => ({
            ...route,
            maxEffect: "WRITE_IRREVERSIBLE" as const,
          })),
        },
        effectOf: (action) =>
          action.kind === "click" ? "WRITE_IRREVERSIBLE" : defaultEffectOf(action),
      },
    );
    expect(surface.dispatched).toHaveLength(0);
    const refusal = result.events.find((event) => event.type === "tool.refused");
    expect(refusal?.type === "tool.refused" && refusal.detail).toContain(
      "irreversible-requires-approval",
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The journal
// ---------------------------------------------------------------------------------------------

describe("the journal is a complete, ordered account of the run", () => {
  it("opens with loop.started and closes with loop.finished", async () => {
    const { result } = await run([observe, finish("reached-goal", "done")]);
    const types = typesOf(result.events);
    expect(types[0]).toBe("loop.started");
    expect(types.at(-1)).toBe("loop.finished");
    expect(result.events.map((event) => event.seq)).toEqual(
      result.events.map((_event, index) => index),
    );
  });

  it("journals every tool call, including the ones it refused", async () => {
    const { result } = await run([
      observe,
      act({ nodeRef: "n99", action: "activate", why: "click" }),
      finish("stuck", "stale"),
    ]);
    const called = result.events.filter((event) => event.type === "tool.called");
    expect(called.map((event) => event.type === "tool.called" && event.name)).toEqual([
      "observe",
      "act",
      "finish",
    ]);
  });

  it("records how much of the observation the model was shown", async () => {
    const { result } = await run([observe, finish("reached-goal", "done")]);
    const observed = result.events.find((event) => event.type === "observed");
    if (observed?.type !== "observed") throw new Error("shape");
    expect(observed.nodeCount).toBe(4);
    expect(observed.projectedNodes).toBe(3);
  });

  it("passes every event to an external sink as well as keeping it", async () => {
    const seen: DiscoveryEvent[] = [];
    const { result } = await run([observe, finish("reached-goal", "done")], {
      journal: (event) => seen.push(event),
    });
    expect(seen).toEqual([...result.events]);
  });
});
