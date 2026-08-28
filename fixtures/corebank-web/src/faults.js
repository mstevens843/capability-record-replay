// Per-session fault injection.
//
// A public demo site cannot be made to time out a session or deny an entitlement on cue, which is
// why this fixture exists at all (BRIEF section 4). Every fault below is armed against ONE SESSION,
// identified by the `CBSESSIONID` cookie, so a conformance suite can run a dozen scenarios in
// parallel against one server without them interfering.
//
// Two design choices here are not arbitrary and are worth reading before changing them.
//
// ONE: the default `mode` follows the rule in docs/design/OPEN-QUESTIONS-RESOLVED.md Q1 -
//
//     An outcome is a fact about the request or the record that will still be true on the next
//     attempt. A failure is a fact about the system that might not be.
//
// so faults that stand for business outcomes (`not-found`, `permission-denied-record`) and faults
// that stand for stable environment truths (`permission-denied-role` - a role entitlement does not
// heal itself) default to STICKY, while faults that stand for this-attempt failures
// (`session-timeout`, `slow-load`, `app-error`, `torn-render`, the dialogs) default to ONCE. A
// replay engine that retries a sticky fault must keep getting the same answer, and one that retries
// a once fault must be able to succeed - both behaviours are needed to grade a recovery.
//
// TWO: `screen` scopes a fault to the point in the flow where it is meaningful, so arming
// `not-found` does not blank out the member detail page as a side effect. The default screen per
// fault is the natural one; `_faultAt` overrides it, and `any` fires on the next content screen of
// any kind.

/** Content screens a fault can be scoped to, in flow order. `any` matches all of them. */
export const SCREENS = Object.freeze([
  "search",
  "results",
  "detail",
  "subaccounts",
  "new",
  "confirm",
  "commit",
]);

/**
 * @typedef {object} FaultSpec
 * @property {string} id
 * @property {string} screen   Default screen the fault fires on.
 * @property {"once"|"sticky"} mode
 * @property {string} taxonomy The SPEC section 4.2 row this fault is built to produce.
 * @property {string} summary
 */

/** @type {Readonly<Record<string, FaultSpec>>} */
export const FAULTS = Object.freeze({
  "validation-error": {
    id: "validation-error",
    screen: "confirm",
    mode: "sticky",
    taxonomy: "row 5 - validation error on an ARTIFACT-LITERAL-bound value; hard failure",
    summary:
      "The open-sub-account form rejects the selected product code as not enabled for the branch.",
  },
  "not-found": {
    id: "not-found",
    screen: "results",
    mode: "sticky",
    taxonomy: "row 6 - MEMBER_NOT_FOUND; declared business outcome",
    summary: "The member search returns an empty grid and a 'no members matched' notice.",
  },
  "permission-denied-record": {
    id: "permission-denied-record",
    screen: "commit",
    mode: "sticky",
    taxonomy: "row 7 - denial scoped to the RECORD; declared business outcome",
    summary: "The write is refused because the member record is flagged as restricted.",
  },
  "permission-denied-role": {
    id: "permission-denied-role",
    screen: "commit",
    mode: "sticky",
    taxonomy: "row 8 - denial scoped to the SESSION ROLE; hard failure, entitlement-denied",
    summary: "The write is refused because the signed-in role lacks the OPEN_SUBACCOUNT function.",
  },
  interstitial: {
    id: "interstitial",
    screen: "detail",
    mode: "once",
    taxonomy:
      "rows 9/10 - an interstitial dialog; recoverable if declared, undeclared-dialog if not",
    summary:
      "A blocking in-page maintenance-notice modal covers the screen until Acknowledge is activated.",
  },
  "native-dialog": {
    id: "native-dialog",
    screen: "detail",
    mode: "once",
    taxonomy:
      "rows 10/21 - a NATIVE dialog; a distinct observation channel that also stalls perceive",
    summary:
      "A native window.confirm() fires on load and holds the page until the driver answers it.",
  },
  "session-timeout": {
    id: "session-timeout",
    screen: "detail",
    mode: "once",
    taxonomy: "rows 11-13 - session expiry; recoverable via reauthenticate, else unrecoverable",
    summary:
      "The session is marked expired; every content screen serves the sign-in screen until POST /signin.",
  },
  "slow-load": {
    id: "slow-load",
    screen: "results",
    mode: "once",
    taxonomy: "rows 14/15 - transient slowness, or did-not-settle if the delay exceeds the budget",
    summary:
      "Headers and a 'Please wait' shell are flushed immediately; the real body follows after a delay.",
  },
  "app-error": {
    id: "app-error",
    screen: "detail",
    mode: "once",
    taxonomy: "row 16 - app error page; hard failure",
    summary: "HTTP 500 with a vendor-style unhandled-exception page and a synthetic stack trace.",
  },
  "torn-render": {
    id: "torn-render",
    screen: "results",
    mode: "once",
    taxonomy: "SPEC section 4.4 B0 - the torn read the quiescence gate exists to catch",
    summary: "The response is truncated mid-row inside the results grid and then ended.",
  },
});

/** Aliases accepted on the wire, so the shorthand in the spec's prose resolves to a real fault. */
const ALIASES = Object.freeze({
  "permission-denied": "permission-denied-record",
  "member-not-found": "not-found",
  "app-500": "app-error",
  "partial-render": "torn-render",
});

/** Every fault id and alias, for error messages and the control endpoint. */
export const FAULT_IDS = Object.freeze(Object.keys(FAULTS));

/**
 * Resolve a wire-level fault name to a canonical id, or null if it is not one of ours.
 * @param {string | null | undefined} raw
 */
export const canonicalFaultId = (raw) => {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase();
  if (key === "" || key === "none" || key === "clear") return null;
  const resolved = ALIASES[key] ?? key;
  return Object.hasOwn(FAULTS, resolved) ? resolved : null;
};

/**
 * @typedef {object} ArmedFault
 * @property {string} id
 * @property {string} screen
 * @property {"once"|"sticky"} mode
 * @property {number} delayMs   Only meaningful for `slow-load`.
 */

/**
 * Build the armed-fault record from whatever the caller supplied, filling defaults from the
 * registry. Returns null for an unknown or cleared fault - an unknown fault name is NOT an error,
 * it is "no fault armed", because a typo that silently arms nothing is easier to debug than a 400
 * from a frame the driver never sees the body of.
 *
 * @param {string | null | undefined} rawId
 * @param {{ at?: string | null, mode?: string | null, delayMs?: string | number | null }} [opts]
 * @returns {ArmedFault | null}
 */
export const armFault = (rawId, opts = {}) => {
  const id = canonicalFaultId(rawId);
  if (id === null) return null;
  const spec = FAULTS[id];
  const at = typeof opts.at === "string" ? opts.at.trim().toLowerCase() : "";
  const screen = at === "any" || SCREENS.includes(at) ? at : spec.screen;
  const mode = opts.mode === "once" || opts.mode === "sticky" ? opts.mode : spec.mode;
  const parsedDelay = Number.parseInt(String(opts.delayMs ?? ""), 10);
  const delayMs = Number.isFinite(parsedDelay) && parsedDelay >= 0 ? parsedDelay : 1200;
  return { id, screen, mode, delayMs };
};

/**
 * Does the armed fault fire on this screen?
 * @param {ArmedFault | null} armed
 * @param {string} screen
 */
export const faultFiresOn = (armed, screen) =>
  armed !== null && (armed.screen === "any" || armed.screen === screen);
