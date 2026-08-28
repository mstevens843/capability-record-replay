// The control lease - "enforcement, not convention" (BRIEF section 3.5), on this side of the port.
//
// A session has exactly one controller. The authority here is the ONLY thing that mints a token,
// and it does so under a monotonically increasing epoch. That epoch is the part that matters and
// it is easy to leave out: without it, "the same token string" and "the same grant" are
// indistinguishable, so a run that lost the session to a human and got it back would act on a
// screen the human left somewhere else, using a token that still validates.
//
// Enforcement happens in three places on purpose, and they catch different things:
//
//   1. HERE, before a step runs: `state()` reports `lost` and the interpreter stops at band G.
//   2. At the POLICY chokepoint: `check` compares `ctx.lease.epoch` against `PolicyMoment.epoch`.
//      That catches a transfer between the step's lease read and its dispatch.
//   3. At the PORT: `Surface.act(action, lease)` refuses a token the driver was not granted. That
//      catches an executor that skipped 1 and 2 entirely, which is the only failure a gate
//      upstairs cannot see.
//
// Note what is NOT here: the operator console, the intervention lifecycle and the seven-step resume
// re-check are SPEC section 7 and build unit 16. This is the authority those are built on, and it
// carries exactly the transitions the interpreter needs - grant, hand to a human, take back - so
// unit 16 extends it rather than replacing it.

import {
  type ControlTransfer,
  type Controller,
  type InterventionId,
  type Lease,
  LeaseSchema,
  type LeaseSnapshot,
  type LeaseState,
  type LeaseToken,
} from "@crr/core";
import type { Clock } from "./clock.js";
import type { IdSource } from "./ids.js";

/**
 * The driver half of the control model.
 *
 * `Surface.act(action, lease)` refuses a token the driver was not granted, which means SOMETHING has
 * to tell the driver which token is current. This is that something, and it is deliberately a
 * structural interface rather than a method on the `Surface` port: a mock surface is handed its
 * token at construction and has nothing to grant, while a live browser session needs to be told
 * every time the epoch moves. `leaseSinkOf` duck-types it so the port stays four methods wide.
 */
export interface LeaseSink {
  grantLease(token: LeaseToken): void;
  revokeLease(): void;
}

/** The driver's lease sink, when it has one. A driver without one was given its token another way
 *  and needs no notification; a driver with one is kept in step with every epoch. */
export function leaseSinkOf(surface: unknown): LeaseSink | null {
  const candidate = surface as Partial<LeaseSink> | null;
  if (candidate === null || typeof candidate !== "object") return null;
  return typeof candidate.grantLease === "function" && typeof candidate.revokeLease === "function"
    ? (candidate as LeaseSink)
    : null;
}

export interface LeaseAuthorityOptions {
  readonly sessionId: string;
  readonly clock: Clock;
  readonly ids: IdSource;
  /** How long a grant is good for. A lease that never expires is a session a crashed run holds
   *  forever, and the human on the other end of an escalation cannot take it back. */
  readonly ttlMs?: number;
  /** The driver to keep in step. Every mint is pushed to it, so a token minted under an older epoch
   *  stops validating AT THE PORT and not only at the gate upstairs. */
  readonly sink?: LeaseSink | null;
}

const DEFAULT_TTL_MS = 300_000;

export class LeaseAuthority {
  readonly #clock: Clock;
  readonly #ids: IdSource;
  readonly #sessionId: string;
  readonly #ttlMs: number;
  readonly #sink: LeaseSink | null;
  #lease: Lease;
  #transfers: ControlTransfer[] = [];
  /** The epoch a hand-back created, or `null`. This is what tells "a human held this session and
   *  gave it back" from "the run re-granted itself", which look identical from the epoch alone and
   *  mean opposite things to the classifier. */
  #handbackEpoch: number | null = null;

  constructor(options: LeaseAuthorityOptions) {
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#sessionId = options.sessionId;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#sink = options.sink ?? null;
    // Minted but NOT granted to the driver. A freshly constructed authority holds a lease nobody
    // has claimed; `grantToAutomation` is the deliberate act, and until it happens the driver
    // refuses every action - which is the correct fail-closed default.
    this.#lease = this.#mint("automation", "unowned", 0);
    this.#sink?.revokeLease();
  }

  #mint(holder: Controller, actorId: string, epoch: number): Lease {
    const acquiredAt = this.#clock.now();
    return LeaseSchema.parse({
      sessionId: this.#sessionId,
      token: this.#ids.leaseToken(),
      holder,
      actorId,
      acquiredAt,
      expiresAt: new Date(Date.parse(acquiredAt) + this.#ttlMs).toISOString(),
      epoch,
    }) as Lease;
  }

  /** The current grant, token included. Only the executor and the driver see this. */
  get lease(): Lease {
    return this.#lease;
  }

  get token(): LeaseToken {
    return this.#lease.token;
  }

  get epoch(): number {
    return this.#lease.epoch;
  }

  /** What the policy engine is shown: no token, because a pure predicate has no business holding a
   *  credential and does not need one to answer "does this actor hold it". */
  snapshot(): LeaseSnapshot {
    const { holder, actorId, epoch, expiresAt } = this.#lease;
    return { holder, actorId, epoch, expiresAt };
  }

  readonly transfers = (): readonly ControlTransfer[] => this.#transfers;

  /** Give the automation the session. Epoch increments, so every previously minted token is dead. */
  grantToAutomation(actorId: string): Lease {
    this.#lease = this.#mint("automation", actorId, this.#lease.epoch + 1);
    this.#sink?.grantLease(this.#lease.token);
    return this.#lease;
  }

  /**
   * Hand control to a person. The automation's token stops validating at the port immediately -
   * that is what "release the lease" has to mean if the human is going to click safely.
   */
  handToHuman(actorId: string, interventionId: InterventionId | null): Lease {
    const from = this.#lease.holder;
    this.#lease = this.#mint("human", actorId, this.#lease.epoch + 1);
    this.#sink?.grantLease(this.#lease.token);
    this.#transfers.push({
      at: this.#lease.acquiredAt,
      from,
      to: "human",
      actorId,
      interventionId,
      actionsPerformed: [],
    });
    return this.#lease;
  }

  /**
   * Take the session back after a handoff.
   *
   * `actionsPerformed` is attribution, and it is TITLES ONLY: an operator console that recorded
   * what was typed would be a second copy of every member number a human ever keyed, in the audit
   * trail, forever.
   */
  resumeAutomation(
    actorId: string,
    actionsPerformed: ControlTransfer["actionsPerformed"] = [],
  ): Lease {
    const from = this.#lease.holder;
    const humanActor = this.#lease.actorId;
    this.#lease = this.#mint("automation", actorId, this.#lease.epoch + 1);
    this.#handbackEpoch = this.#lease.epoch;
    this.#sink?.grantLease(this.#lease.token);
    this.#transfers.push({
      at: this.#lease.acquiredAt,
      from,
      to: "automation",
      actorId: humanActor,
      interventionId: null,
      actionsPerformed,
    });
    return this.#lease;
  }

  /**
   * Take the session away from everybody.
   *
   * The terminal transition of SPEC section 7.1: an intervention that expired, a lease that went
   * orphaned, an operator who aborted. Not the same as handing it back - there is no controller
   * afterwards, and the driver refuses every action - which is exactly the fail-closed state a
   * freshly constructed authority starts in.
   *
   * The epoch still moves, because a token minted before a revoke must not start working again if
   * somebody later re-grants at the same number.
   */
  revoke(): Lease {
    this.#lease = this.#mint("automation", "unowned", this.#lease.epoch + 1);
    this.#sink?.revokeLease();
    return this.#lease;
  }

  /**
   * The classifier's band-G input.
   *
   * `handoff-resume` is the one case where the automation did NOT lose the session: it gave it up
   * deliberately and has just been given it back, and telling the classifier `lost` there would
   * fail a run that a human just finished helping.
   */
  state(expected: { readonly token: LeaseToken; readonly epoch: number }): LeaseState {
    if (this.#lease.holder !== "automation") return "lost";
    if (this.#lease.token !== expected.token) {
      // `handoff-resume` is the ONE case where the automation did not lose the session: it gave it
      // up deliberately and has just been handed it back. Every other epoch move - including the
      // run re-granting itself - is a loss, because a run acting on a token minted under an epoch
      // it does not know about is exactly the failure the epoch exists to catch.
      const handedBack =
        this.#handbackEpoch !== null &&
        this.#lease.epoch === this.#handbackEpoch &&
        expected.epoch < this.#handbackEpoch;
      return handedBack ? "handoff-resume" : "lost";
    }
    if (this.#lease.epoch !== expected.epoch) return "lost";
    if (Date.parse(this.#clock.now()) >= Date.parse(this.#lease.expiresAt)) return "lost";
    return "held";
  }
}
