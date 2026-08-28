// The session broker (SPEC section 7.6).
//
// THE PROGRAM NEVER LOGS IN. There is no auth step in the instruction set, no `secret` parameter in
// the contract schema, and no field in the artifact a credential could be written into even by
// accident. Establishing an authenticated session for `target.sessionProfile` is this port's job,
// and it happens BEFORE pc 0 and again on every program restart.
//
// That is not tidiness; it is the answer to a real failure. SPEC section 3.6 notes that a restart
// into the SAME expired session burns its budget and fails, which is what a design with a login
// preamble does: it replays the login into a session that is already dead. Because the broker owns
// the session, `restart-program` gets a fresh one and the `reauthenticate` remedy has somewhere to
// go that is not the program.
//
// The interface is deliberately small and the implementations here are deliberately thin. A real
// broker holds credentials in a secret manager, drives an SSO flow and pools sessions per tenant;
// none of that is in scope for this project and pretending otherwise would be the "scaling
// infrastructure" the brief explicitly does not reward. What matters is that the SEAM is real -
// the interpreter calls `refresh` on a `reauthenticate` remedy and cannot do anything else.

import type { Surface, TenantId } from "@crr/core";

export interface TenantRef {
  readonly tenantId: TenantId;
  readonly appInstanceId: string;
}

export interface BrokeredSession {
  readonly sessionId: string;
  readonly surface: Surface;
}

export interface SessionBroker {
  open(profile: string, tenant: TenantRef): Promise<BrokeredSession>;
  /** Re-establish authentication on the SAME surface where the app supports it, or open a fresh
   *  one. Called by the `reauthenticate` remedy and before every program restart. */
  refresh(sessionId: string): Promise<"refreshed" | "reopened" | "failed">;
  close(sessionId: string): Promise<void>;
}

export interface StaticSessionOptions {
  readonly sessionId?: string;
  /** What `refresh` should report. A broker that cannot actually re-authenticate must say `failed`
   *  rather than `refreshed`, or the classifier's `session-expired-unrecoverable` row becomes
   *  unreachable and a dead session looks like a recoverable one forever. */
  readonly onRefresh?: () => Promise<"refreshed" | "reopened" | "failed">;
  readonly onClose?: () => Promise<void>;
}

/**
 * A broker over a surface somebody else opened.
 *
 * This is what a test and the fixture demo use: the browser is already launched and pointed at the
 * fixture, so "establishing a session" is a no-op. It is honest about that - the default `refresh`
 * reports `failed`, because a broker that claims to have re-authenticated when it did nothing is
 * the single most misleading thing this port could do.
 */
export class StaticSessionBroker implements SessionBroker {
  readonly #surface: Surface;
  readonly #sessionId: string;
  readonly #onRefresh: () => Promise<"refreshed" | "reopened" | "failed">;
  readonly #onClose: () => Promise<void>;

  constructor(surface: Surface, options: StaticSessionOptions = {}) {
    this.#surface = surface;
    this.#sessionId = options.sessionId ?? "static-session";
    this.#onRefresh = options.onRefresh ?? (async () => "failed");
    this.#onClose = options.onClose ?? (async () => undefined);
  }

  async open(): Promise<BrokeredSession> {
    return { sessionId: this.#sessionId, surface: this.#surface };
  }

  async refresh(): Promise<"refreshed" | "reopened" | "failed"> {
    return this.#onRefresh();
  }

  async close(): Promise<void> {
    await this.#onClose();
  }
}
