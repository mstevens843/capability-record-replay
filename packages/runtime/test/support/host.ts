// Wiring one capability into a catalog over the scripted surface. NO BROWSER ANYWHERE.
//
// The point of this file is that the production door - `Catalog.invoke` and `Catalog.callTool` -
// runs against exactly the same `MockSurface` corpus the interpreter suite uses, so a test can put
// one thing wrong (a stale digest, a broker that throws, a repeated idempotency key) without
// needing a browser to be doing anything in particular at the time.

import {
  type CapabilityContract,
  MOCK_LEASE_TOKEN,
  MockSurface,
  type MockTransition,
  type Observation,
} from "@crr/core";
import { Catalog, type CatalogOptions } from "../../src/catalog.js";
import { manualClock } from "../../src/clock.js";
import { MemoryEvidenceSink } from "../../src/evidence.js";
import { sequentialIds } from "../../src/ids.js";
import type { IdempotencyStore } from "../../src/invoke.js";
import { MemoryJournal } from "../../src/journal.js";
import { StaticSessionBroker } from "../../src/session.js";
import type { SessionBroker } from "../../src/session.js";
import { mockAllowlist, mockTrust } from "../fixtures/mock-flow.js";

export interface HostOptions {
  readonly contract: CapabilityContract;
  readonly artifact: Parameters<Catalog["register"]>[0]["artifact"];
  readonly screens: Readonly<Record<string, Observation>>;
  readonly transitions: readonly MockTransition[];
  readonly start?: string;
  readonly broker?: SessionBroker;
  readonly idempotency?: IdempotencyStore | null;
}

export interface Host {
  readonly catalog: Catalog;
  readonly surface: MockSurface;
  readonly clock: ReturnType<typeof manualClock>;
  readonly evidence: MemoryEvidenceSink;
  /** How many times a session was opened. The idempotency tests are exactly the assertion that this
   *  does NOT go up on a repeat key, which is the difference between "cached" and "ran again". */
  readonly opens: () => number;
}

export function host(options: HostOptions): Host {
  const surface = new MockSurface({
    screens: options.screens,
    start: options.start ?? "blank",
    transitions: options.transitions,
    lease: MOCK_LEASE_TOKEN,
  });
  const clock = manualClock();
  const evidence = new MemoryEvidenceSink();
  let opens = 0;

  const inner = options.broker ?? new StaticSessionBroker(surface);
  const broker: SessionBroker = {
    async open(profile, tenant) {
      // `replay` opens once for `capabilities()` before the linker runs and once for the run; the
      // capabilities peek uses a reserved profile name, so counting only real opens keeps the
      // idempotency assertion honest.
      if (profile !== "__capabilities__") opens += 1;
      return inner.open(profile, tenant);
    },
    refresh: (sessionId) => inner.refresh(sessionId),
    close: (sessionId) => inner.close(sessionId),
  };

  const catalogOptions: CatalogOptions = {
    trust: mockTrust,
    clock,
    ids: sequentialIds("mock"),
    evidence,
    journal: (runId) => new MemoryJournal({ runId, clock }),
    idempotency: options.idempotency ?? null,
  };

  const catalog = new Catalog(catalogOptions).register({
    contract: options.contract,
    artifact: options.artifact,
    allowlist: mockAllowlist,
    broker,
  });

  return { catalog, surface, clock, evidence, opens: () => opens };
}

/**
 * A well-formed `Invocation` for a contract with no approval requirement.
 *
 * The branded ids are asserted here and nowhere else in the suite. Branding is a claim about
 * validation performed at a document boundary; a test fixture is not that boundary, and spreading
 * the casts across every call site would make it look like one.
 */
export function invocation(
  contract: CapabilityContract,
  args: Readonly<Record<string, unknown>>,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    capability: {
      name: contract.name,
      version: contract.version,
      contractDigest: contract.digest,
    },
    tenant: { tenantId: "riverbend", appInstanceId: "riverbend-mock" },
    args,
    onIntervention: "fail",
    correlation: { agentSessionId: "agent-turn-1", requestedBy: "agent" },
    ...overrides,
  } as never;
}
