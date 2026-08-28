// The redaction canary.
//
// BRIEF section 3.6 makes one claim twice: parameterization IS the privacy control, and a value
// bound to a sensitive parameter never reaches a log, an artifact or a screenshot. That claim is
// only worth making if something greps for it, because every individual mechanism - the taint
// handle, the driver's blanking, `observedSummaryOf`, `redactObservation` - looks correct in
// isolation and the interesting failure is the one place none of them covers.
//
// So this file takes the value the caller supplied and looks for it in everything a run writes
// down. It is deliberately a GREP and not a set of assertions about mechanisms: a mechanism test
// passes when the mechanism it knows about works, and this one fails when ANY path leaks.

import {
  MOCK_LEASE_TOKEN,
  MockSurface,
  type MockTransition,
  type Observation,
  type UINode,
} from "@crr/core";
import { describe, expect, it } from "vitest";
import { manualClock } from "../src/clock.js";
import { MemoryEvidenceSink, redactObservation } from "../src/evidence.js";
import { sequentialIds } from "../src/ids.js";
import { MemoryJournal } from "../src/journal.js";
import { replay } from "../src/replay.js";
import { StaticSessionBroker } from "../src/session.js";
import {
  FIXTURE_MEMBER_ID,
  sharePositionArtifact,
  sharePositionContract,
} from "./fixtures/corebank.js";
import {
  IDS,
  MOCK_MEMBER_ID,
  mockAllowlist,
  mockArtifact,
  mockContract,
  mockTrust,
  screens,
} from "./fixtures/mock-flow.js";

/**
 * A screen that prints the member number back at you in a heading.
 *
 * This is the case the driver's field-blanking cannot cover and the reason redaction happens twice.
 * The driver blanks a field it knows a sensitive value was typed into; a legacy app then echoes the
 * same number into a page heading the driver never associated with that field, and `heading` is
 * exactly the role a failure summary quotes first.
 */
const results = screens.results as Observation;
const echoHeading: UINode = {
  ...(results.nodes[1] as UINode),
  id: "heading:echo" as UINode["id"],
  rawRole: "heading",
  ariaRole: "heading",
  name: `Results for member ${MOCK_MEMBER_ID}`,
  text: `Results for member ${MOCK_MEMBER_ID}`,
};
const echoScreens: Readonly<Record<string, Observation>> = {
  ...screens,
  "results-echo": { ...results, nodes: [...results.nodes, echoHeading] } as Observation,
};

const TRANSITIONS: readonly MockTransition[] = [
  { from: "blank", on: { kind: "navigate", path: "/search" }, to: "search" },
  { from: "search", on: { kind: "type", target: IDS.memberIdField }, to: "search-typed" },
  { from: "search-typed", on: { kind: "click", target: IDS.searchButton }, to: "results-echo" },
];

describe("the artifact stores shapes, never values", () => {
  it("has no member number anywhere in the sealed corebank document", () => {
    // The whole multi-tenant + privacy argument in one assertion: a document that carried a value
    // would prove the opposite of what it exists to prove.
    expect(JSON.stringify(sharePositionArtifact)).not.toContain(FIXTURE_MEMBER_ID);
    expect(JSON.stringify(sharePositionContract)).not.toContain(FIXTURE_MEMBER_ID);
  });

  it("records the goal PARAMETERIZED, which is where a member number is most likely to end up", () => {
    expect(sharePositionArtifact.provenance.goalTemplate).toContain("{memberId}");
    expect(sharePositionArtifact.provenance.goalTemplate).not.toMatch(/\d{5}/);
  });

  it("names the routes it touches by pattern, never by a member's URL", () => {
    for (const route of sharePositionArtifact.flow.routes) {
      expect(route.path).not.toMatch(/\d{5}/);
    }
  });
});

describe("a run writes the value down nowhere", () => {
  it("keeps it out of the journal, the evidence, and every arm of the result", async () => {
    const surface = new MockSurface({
      screens: echoScreens,
      start: "blank",
      transitions: TRANSITIONS,
      lease: MOCK_LEASE_TOKEN,
    });
    const clock = manualClock();
    const evidence = new MemoryEvidenceSink();
    const { result, journal } = await replay({
      contract: mockContract,
      artifact: mockArtifact(),
      args: { memberId: MOCK_MEMBER_ID },
      tenant: { tenantId: "riverbend", appInstanceId: "riverbend-mock" },
      allowlist: mockAllowlist,
      broker: new StaticSessionBroker(surface),
      trust: mockTrust,
      clock,
      ids: sequentialIds("redact"),
      evidence,
      journal: (runId) => new MemoryJournal({ runId, clock }),
    });

    // The screen genuinely carried it - otherwise this test passes for the wrong reason.
    expect(JSON.stringify(echoScreens["results-echo"])).toContain(MOCK_MEMBER_ID);

    expect(JSON.stringify(journal.events)).not.toContain(MOCK_MEMBER_ID);
    expect(JSON.stringify(result)).not.toContain(MOCK_MEMBER_ID);
    for (const ref of evidence.refs()) {
      expect(JSON.stringify(evidence.get(ref))).not.toContain(MOCK_MEMBER_ID);
    }
  });

  it("still says WHICH value it was, by handle, so a postmortem is possible", async () => {
    const surface = new MockSurface({
      screens: echoScreens,
      start: "blank",
      transitions: TRANSITIONS,
      lease: MOCK_LEASE_TOKEN,
    });
    const clock = manualClock();
    const { journal } = await replay({
      contract: mockContract,
      artifact: mockArtifact(),
      args: { memberId: MOCK_MEMBER_ID },
      tenant: { tenantId: "riverbend", appInstanceId: "riverbend-mock" },
      allowlist: mockAllowlist,
      broker: new StaticSessionBroker(surface),
      trust: mockTrust,
      clock,
      ids: sequentialIds("redact"),
      journal: (runId) => new MemoryJournal({ runId, clock }),
    });
    // Redaction that erased the fact a value existed would make the audit trail useless; the handle
    // is the opaque stand-in that keeps it answerable.
    const started = journal.events.find((e) => e.type === "run.started") as unknown as {
      argsShape: Record<string, string>;
    };
    expect(started.argsShape).toEqual({ memberId: "digits(5)" });
    expect(JSON.stringify(journal.events)).toContain("taint:memberId");
  });
});

// ---------------------------------------------------------------------------------------------
// The three fields that actually leaked
// ---------------------------------------------------------------------------------------------
//
// `name`, `value`, `text` and `description` are the fields a reviewer thinks of. These three are
// the ones a real run put the caller's argument into, and the last of them was found by the
// evidence bundle's redaction canary rather than by anybody reading the code - which is the whole
// argument for having a canary. Each test below carries its own positive control, so it cannot pass
// because the fixture stopped holding the value.

describe("redaction covers every page-derived string in an observation", () => {
  const bindings = [
    {
      name: "memberId",
      origin: "param" as const,
      value: MOCK_MEMBER_ID,
      sensitivity: "sensitive" as const,
      handle: "taint:memberId-0" as never,
    },
  ];
  const base = screens.results as Observation;
  const node = base.nodes[0] as UINode;

  it("scrubs the ROUTE QUERY - a frameset-era app submits its search form by GET", () => {
    // The exact shape the canary caught in `evidence/replay-02.../observations/`: this product's
    // results screen is reached by GET and the member number rides in the query string, which
    // `RouteLocationSchema`'s canonicalization promise covers for the PATH and not for this.
    const observation = {
      ...base,
      route: {
        originAlias: "corebank",
        path: "/search/results",
        query: { ctl00$ctl32$g$9a1$txtMemberId: MOCK_MEMBER_ID, ctl00$g$btnGo: "Search" },
        frame: "content",
      },
    } as Observation;
    expect(JSON.stringify(observation)).toContain(MOCK_MEMBER_ID);
    const { observation: safe, redactions } = redactObservation(observation, bindings);
    expect(JSON.stringify(safe)).not.toContain(MOCK_MEMBER_ID);
    expect(redactions).toBe(1);
    expect(safe.route?.query.ctl00$ctl32$g$9a1$txtMemberId).toBe("<taint:memberId-0>");
    // The other parameter is untouched: redaction is a substitution, not a blanket.
    expect(safe.route?.query.ctl00$g$btnGo).toBe("Search");
  });

  it("scrubs the CONTAINER BREADCRUMB, which repeats on every node underneath it", () => {
    const observation = {
      ...base,
      nodes: [
        {
          ...node,
          containerPath: [
            { kind: "frame", name: "content" },
            { kind: "heading-section", heading: `Member ${MOCK_MEMBER_ID}`, level: 2 },
            { kind: "table", headers: ["Member", `Results for ${MOCK_MEMBER_ID}`] },
          ],
        },
      ],
    } as unknown as Observation;
    expect(JSON.stringify(observation)).toContain(MOCK_MEMBER_ID);
    const { observation: safe } = redactObservation(observation, bindings);
    expect(JSON.stringify(safe)).not.toContain(MOCK_MEMBER_ID);
    const path = safe.nodes[0]?.containerPath ?? [];
    expect(path[0]).toEqual({ kind: "frame", name: "content" });
    expect(path[1]).toMatchObject({ heading: "Member <taint:memberId-0>" });
  });

  it("scrubs a TABLE ROW HEADER, which on a results grid is the key the row was found by", () => {
    const observation = {
      ...base,
      nodes: [
        {
          ...node,
          tablePosition: {
            rowIndex: 1,
            colIndex: 2,
            rowHeader: MOCK_MEMBER_ID,
            colHeader: "Status",
            headerProvenance: "columnheader-role",
          },
        },
      ],
    } as unknown as Observation;
    expect(JSON.stringify(observation)).toContain(MOCK_MEMBER_ID);
    const { observation: safe } = redactObservation(observation, bindings);
    expect(JSON.stringify(safe)).not.toContain(MOCK_MEMBER_ID);
    expect(safe.nodes[0]?.tablePosition?.rowHeader).toBe("<taint:memberId-0>");
    expect(safe.nodes[0]?.tablePosition?.colHeader).toBe("Status");
  });
});
