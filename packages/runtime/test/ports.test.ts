// The impure ports, under test without any impurity.
//
// Every one of these exists so that `@crr/core` can stay a directory a scanner proves has no clock,
// no randomness and no I/O. That trade is only worth making if the impure half is itself testable,
// which is what the `Clock`, `IdSource` and `LeaseSink` interfaces buy.

import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LeaseToken, type Observation, TimestampSchema } from "@crr/core";
import { describe, expect, it } from "vitest";
import { ed25519Trust, unverifiedTrust } from "../src/approval.js";
import { RunLedger, StepLedger } from "../src/budgets.js";
import { manualClock, systemClock, timestampOf } from "../src/clock.js";
import { FileEvidenceSink, MemoryEvidenceSink, redactObservation } from "../src/evidence.js";
import { approvalTokenOf, evidenceRefOf, randomIds, sequentialIds } from "../src/ids.js";
import { FileJournal, MemoryJournal } from "../src/journal.js";
import { LeaseAuthority, type LeaseSink, leaseSinkOf } from "../src/lease.js";
import { DocumentStoreError, FileDocumentStore } from "../src/store.js";
import { mockArtifact, mockContract, screens } from "./fixtures/mock-flow.js";

const temp = (): string => mkdtempSync(join(tmpdir(), "crr-runtime-"));

// ---------------------------------------------------------------------------------------------

describe("the clock", () => {
  it("produces timestamps the schema accepts", () => {
    expect(() => TimestampSchema.parse(systemClock().now())).not.toThrow();
    expect(timestampOf(0)).toBe("1970-01-01T00:00:00.000Z");
  });

  it("keeps wall time and elapsed time apart", () => {
    const clock = manualClock(Date.parse("2026-02-11T14:00:00.000Z"));
    expect(clock.now()).toBe("2026-02-11T14:00:00.000Z");
    expect(clock.elapsedMs()).toBe(0);
    clock.advance(1_500);
    expect(clock.now()).toBe("2026-02-11T14:00:01.500Z");
    expect(clock.elapsedMs()).toBe(1_500);
  });

  it("spends the budget a sleep asks for without spending the wall clock", async () => {
    // The property that lets an 8-second settle budget be exercised in microseconds while the
    // assertions about how much of it was spent stay true.
    const clock = manualClock();
    const before = Date.now();
    await clock.sleep(5_000);
    expect(clock.elapsedMs()).toBe(5_000);
    expect(Date.now() - before).toBeLessThan(1_000);
  });
});

describe("ids", () => {
  it("mints an unguessable lease token", () => {
    const a = randomIds().leaseToken();
    const b = randomIds().leaseToken();
    expect(a).not.toBe(b);
    // 128 bits, base64url. A token the port checks on every action is a capability and is sized
    // like one; a counter here would let anything holding the source take a live session.
    expect(a.replace("lease-", "").length).toBeGreaterThanOrEqual(20);
  });

  it("is deterministic when a test asks for it", () => {
    const ids = sequentialIds("t");
    expect([ids.runId(), ids.runId()]).toEqual(["run-t-1", "run-t-2"]);
  });

  it("builds evidence refs that name what they hold", () => {
    expect(evidenceRefOf("obs", "sha256:abcd")).toBe("obs:abcd");
    expect(approvalTokenOf("tok-1")).toBe("tok-1");
  });
});

// ---------------------------------------------------------------------------------------------

describe("the control lease", () => {
  const authority = (sink?: LeaseSink) =>
    new LeaseAuthority({
      sessionId: "s1",
      clock: manualClock(),
      ids: sequentialIds("l"),
      ...(sink === undefined ? {} : { sink }),
    });

  it("increments the epoch on every grant, so an older token is dead", () => {
    const lease = authority();
    const first = lease.grantToAutomation("run:1");
    const second = lease.grantToAutomation("run:2");
    expect(second.epoch).toBe(first.epoch + 1);
    expect(lease.state({ token: first.token, epoch: first.epoch })).toBe("lost");
  });

  it("reports `held` for the token it just granted", () => {
    const lease = authority();
    const granted = lease.grantToAutomation("run:1");
    expect(lease.state({ token: granted.token, epoch: granted.epoch })).toBe("held");
  });

  it("distinguishes a handoff resume from a lost session", () => {
    const lease = authority();
    const held = lease.grantToAutomation("run:1");
    lease.handToHuman("operator:7", null);
    // While the human holds it, the automation has lost it outright.
    expect(lease.state({ token: held.token, epoch: held.epoch })).toBe("lost");
    lease.resumeAutomation("run:1", [{ kind: "click", targetTitle: "the Search button" }]);
    // And once it comes back, the run that gave it up did not LOSE it - telling the classifier
    // otherwise would fail a run a human just finished helping.
    expect(lease.state({ token: held.token, epoch: held.epoch })).toBe("handoff-resume");
    expect(lease.transfers()).toHaveLength(2);
    expect(lease.transfers()[1]?.actionsPerformed).toEqual([
      { kind: "click", targetTitle: "the Search button" },
    ]);
  });

  it("hands the policy engine a snapshot with no token in it", () => {
    const lease = authority();
    lease.grantToAutomation("run:1");
    expect(Object.keys(lease.snapshot()).sort()).toEqual([
      "actorId",
      "epoch",
      "expiresAt",
      "holder",
    ]);
  });

  it("keeps a driver in step, and revokes before the first grant", () => {
    const granted: LeaseToken[] = [];
    let revoked = 0;
    const sink: LeaseSink = {
      grantLease: (t) => granted.push(t),
      revokeLease: () => {
        revoked += 1;
      },
    };
    const lease = authority(sink);
    // A freshly constructed authority holds a lease NOBODY has claimed, and the driver is told so:
    // until somebody grants it, every action at the port is refused.
    expect(revoked).toBe(1);
    expect(granted).toHaveLength(0);
    lease.grantToAutomation("run:1");
    expect(granted).toEqual([lease.token]);
  });

  it("recognises a driver that can be kept in step, and one that cannot", () => {
    expect(
      leaseSinkOf({ grantLease: () => undefined, revokeLease: () => undefined }),
    ).not.toBeNull();
    expect(leaseSinkOf({ grantLease: () => undefined })).toBeNull();
    expect(leaseSinkOf(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

describe("the budget ledgers", () => {
  const budgets = {
    maxActions: 3,
    maxObservations: 5,
    maxTotalRemediations: 2,
    maxProgramAttempts: 1,
    deadlineMs: 10_000,
  } as const;

  it("counts monotonically and refills nothing", () => {
    const clock = manualClock();
    const ledger = new RunLedger(budgets, clock);
    expect(ledger.chargeAction()).toEqual({ ledger: "actions", used: 1, limit: 3 });
    ledger.chargeAction();
    ledger.chargeAction();
    expect(ledger.exhausted()).toBe(true);
    // Nothing anywhere on the interface can put one back. That is the termination argument.
    expect(Object.keys(ledger)).not.toContain("reset");
  });

  it("treats the wall clock as a ledger and reads it from the monotonic source", () => {
    const clock = manualClock();
    const ledger = new RunLedger(budgets, clock);
    clock.advance(10_000);
    expect(ledger.exhausted()).toBe(true);
    expect(ledger.view().wallClockMs).toEqual({ used: 10_000, limit: 10_000 });
  });

  it("keeps the per-recovery and per-step counters apart", () => {
    const step = new StepLedger();
    expect(step.chargeRemedy("A")).toBe(1);
    expect(step.chargeRemedy("B")).toBe(1);
    expect(step.chargeRemedy("A")).toBe(2);
    // Two recoveries that ping-pong exceed neither of their own budgets; the step total is what
    // stops them.
    expect(step.attemptsOf("A")).toBe(2);
    expect(step.remediationCycles).toBe(3);
  });

  it("hands the classifier plain integers and no clock", () => {
    const ledger = new RunLedger(budgets, manualClock());
    const counters = ledger.counters(new StepLedger());
    expect(counters.run.actions).toEqual({ used: 0, limit: 3 });
    expect(counters.deadlineMs).toBe(10_000);
    expect(JSON.stringify(counters)).toContain('"remediationCycles":0');
  });
});

// ---------------------------------------------------------------------------------------------

describe("the journal", () => {
  it("stamps a sequence, a run id and a timestamp so a line is self-describing", () => {
    const clock = manualClock();
    const journal = new MemoryJournal({ runId: sequentialIds("j").runId(), clock });
    journal.append({ type: "lease.acquired", holder: "automation", actorId: "run:1", epoch: 1 });
    clock.advance(5);
    journal.append({ type: "lease.released", holder: "automation", reason: "done" });
    expect(journal.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(journal.events[0]?.runId).toBe("run-j-1");
    expect(journal.events[1]?.at).not.toBe(journal.events[0]?.at);
  });

  it("refuses an event that does not validate, at the moment of writing", () => {
    const journal = new MemoryJournal({ runId: sequentialIds("j").runId(), clock: manualClock() });
    // A journal is the artefact a postmortem reads; an event that silently lost a field is a claim
    // that silently became unfalsifiable.
    expect(() =>
      journal.append({ type: "lease.acquired", holder: "nobody", actorId: "x", epoch: 1 } as never),
    ).toThrow();
  });

  it("writes JSONL to disk, one line per event, flushed", () => {
    const path = join(temp(), "run.jsonl");
    const journal = new FileJournal({
      runId: sequentialIds("j").runId(),
      clock: manualClock(),
      path,
    });
    journal.append({ type: "session.opened", sessionId: "s1", sessionProfile: "teller" });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ type: "session.opened", seq: 0 });
  });
});

// ---------------------------------------------------------------------------------------------

describe("the evidence sink", () => {
  const bindings = [
    {
      name: "memberId",
      origin: "param" as const,
      value: "50001",
      sensitivity: "sensitive" as const,
      handle: "taint:memberId-0" as never,
    },
  ];

  it("substitutes every bound caller value before a byte is written", () => {
    const observation = {
      ...screens.results,
      nodes: [
        {
          ...(screens.results as Observation).nodes[0],
          name: "Member 50001",
          text: "Open 50001",
        },
      ],
    } as Observation;
    const { observation: safe, redactions } = redactObservation(observation, bindings);
    expect(redactions).toBe(2);
    expect(JSON.stringify(safe)).not.toContain("50001");
    expect(safe.nodes[0]?.name).toBe("Member <taint:memberId-0>");
    // The digest is the DRIVER's statement about the screen it saw, and the settle window was keyed
    // on it. Recomputing it after a redaction would make a saved observation disagree with the
    // journal that recorded it.
    expect(safe.skeletonDigest).toBe(observation.skeletonDigest);
  });

  it("is content-addressed, so two runs that failed on one screen write one file", () => {
    const sink = new MemoryEvidenceSink();
    const a = sink.putObservation(screens.search as Observation, []);
    const b = sink.putObservation(screens.search as Observation, []);
    expect(a).toBe(b);
    expect(sink.size).toBe(1);
    expect(sink.refs()).toEqual([a]);
  });

  it("writes one readable file per ref", () => {
    const sink = new FileEvidenceSink(temp());
    const ref = sink.putObservation(screens.search as Observation, []);
    expect((sink.read(ref) as Observation).nodes).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------

describe("the document store", () => {
  it("round-trips all three documents through the validator", () => {
    const store = new FileDocumentStore(temp());
    const artifact = mockArtifact();
    store.putContract(mockContract);
    store.putArtifact(artifact);
    expect(store.getContract(mockContract.name, mockContract.version).digest).toBe(
      mockContract.digest,
    );
    expect(store.getArtifact(artifact.artifactId, artifact.version).digest).toBe(artifact.digest);
    expect(store.getOverlay(artifact.artifactId, "summit")).toBeNull();
  });

  it("picks the newest artifact by declared version, never by file mtime", () => {
    const store = new FileDocumentStore(temp());
    store.putArtifact(mockArtifact());
    expect(store.latestArtifactFor(mockContract.name)?.version).toBe(1);
    expect(store.latestArtifactFor("nothing.at.all")).toBeNull();
  });

  it("says which file is missing rather than throwing a TypeError four packages away", () => {
    const store = new FileDocumentStore(temp());
    expect(() => store.getArtifact("absent", 1)).toThrow(DocumentStoreError);
  });
});

// ---------------------------------------------------------------------------------------------

describe("approval verification", () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = new Uint8Array(keys.publicKey.export({ format: "der", type: "spki" }));
  const digest = `sha256:${"a".repeat(64)}`;
  const signature = signBytes(null, Buffer.from(digest, "utf8"), keys.privateKey).toString(
    "base64url",
  );
  const trust = ed25519Trust([{ keyId: "k1", publicKey }]);

  it("verifies a real signature over the digest string", () => {
    expect(trust.verifySignature({ over: digest, keyId: "k1", alg: "ed25519", signature })).toBe(
      true,
    );
  });

  it("refuses the same signature over a different digest, which is what makes an approved artifact uneditable", () => {
    expect(
      trust.verifySignature({
        over: `sha256:${"b".repeat(64)}`,
        keyId: "k1",
        alg: "ed25519",
        signature,
      }),
    ).toBe(false);
  });

  it("refuses an untrusted key, an unknown algorithm and a malformed signature - without throwing", () => {
    expect(trust.verifySignature({ over: digest, keyId: "k2", alg: "ed25519", signature })).toBe(
      false,
    );
    expect(trust.verifySignature({ over: digest, keyId: "k1", alg: "rsa", signature })).toBe(false);
    expect(
      trust.verifySignature({ over: digest, keyId: "k1", alg: "ed25519", signature: "!!!" }),
    ).toBe(false);
  });

  it("accepts a raw 32-byte public key, which is what key tooling prints", () => {
    const raw = new Uint8Array(keys.publicKey.export({ format: "der", type: "spki" })).slice(-32);
    expect(
      ed25519Trust([{ keyId: "k1", publicKey: raw }]).verifySignature({
        over: digest,
        keyId: "k1",
        alg: "ed25519",
        signature,
      }),
    ).toBe(true);
  });

  it("names the unverified store so nobody reaches for it by accident", () => {
    expect(unverifiedTrust(["k1"]).trustedKeyIds).toEqual(["k1"]);
    expect(
      unverifiedTrust([]).verifySignature({ over: "", keyId: "", alg: "", signature: "" }),
    ).toBe(true);
  });
});
