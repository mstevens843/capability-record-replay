// Four injectable fault modes, and the reason each one exists.
//
// The web fixture has eight. This one has four, and they are deliberately the four that a CHARACTER
// GRID makes different from a browser rather than the four that are easiest to write:
//
//   torn-repaint    A green screen has no load event. The ONLY readiness signal the transport
//                   offers is silence, and silence is not evidence: the spike delivered 55% of a
//                   repaint, waited past the quiet window, and got a perfectly plausible-looking
//                   observation with `screenId: null` and three nodes instead of eight. This fault
//                   reproduces that on demand. It is the acceptance case for "quiescence proposes;
//                   the checkpoint disposes" (SPEC section 3.3).
//   slow-repaint    The other half of the same problem: bytes that arrive, but late. Recoverable
//                   inside the budget, `did-not-settle` outside it (SPEC section 4.2 rows 14/15).
//   session-timeout The app drops to its sign-on screen mid-flow. On a browser this is a redirect;
//                   here the screen simply becomes a different screen with the same 80x24 shape,
//                   which is exactly why the checkpoint has to anchor on the screen-id band.
//   app-error       A vendor abend screen. A hard failure with a code an operator would quote.
//
// The three OTHER conditions a replay engine has to tell apart - not-found, permission denied,
// validation error - are not faults here at all. They are properties of the account number the
// caller passed, and the app reports them on its status band whether or not anything is armed
// (see `data.js`). Making them faults would have meant the fixture could only produce a business
// outcome when a test asked it to, which is precisely backwards.

/** The screens a fault can be scoped to. `any` fires on the next paint or transition of any kind. */
export const SCREENS = Object.freeze(["signon", "inquiry", "detail", "error"]);

/**
 * Two families, and they attach at different points, which is not a detail:
 *
 *   `delivery`   corrupts HOW a frame reaches the wire. The app's state is correct; the bytes are
 *                late or incomplete. This is the family a browser driver has no analogue for,
 *                because a browser has a load event and a green screen has only silence.
 *   `transition` changes WHICH screen the app moves to. The bytes are perfect. This is the family
 *                that looks identical to the happy path until something reads the screen-id band.
 *
 * @typedef {object} FaultSpec
 * @property {string} id
 * @property {"delivery"|"transition"} family
 * @property {string} screen    The paint (delivery) or the destination (transition) it fires on.
 * @property {"once"|"sticky"} mode
 * @property {string} taxonomy  The SPEC section 4.2 row this fault is built to produce.
 * @property {string} summary
 */

/** @type {Readonly<Record<string, FaultSpec>>} */
export const FAULTS = Object.freeze({
  "torn-repaint": {
    id: "torn-repaint",
    family: "delivery",
    screen: "inquiry",
    mode: "once",
    taxonomy: "SPEC section 4.4 band B0 - a torn read the quiescence gate cannot see",
    summary:
      "Delivers the leading fraction of a repaint, then falls silent for longer than the driver's " +
      "quiet window before sending the rest. The grid looks settled and is half painted.",
  },
  "slow-repaint": {
    id: "slow-repaint",
    family: "delivery",
    screen: "detail",
    mode: "once",
    taxonomy: "rows 14/15 - transient slowness inside the budget, did-not-settle outside it",
    summary: "Holds an entire repaint back for `delayMs` and then delivers it intact.",
  },
  "session-timeout": {
    id: "session-timeout",
    family: "transition",
    screen: "detail",
    mode: "sticky",
    taxonomy: "rows 11-13 - session expiry; recoverable by signing on again, else unrecoverable",
    summary:
      "The next screen transition lands on the sign-on screen instead. Sticky until an operator " +
      "signs on, because a session does not un-expire on its own.",
  },
  "app-error": {
    id: "app-error",
    family: "transition",
    screen: "detail",
    mode: "once",
    taxonomy: "row 16 - an application error page; hard failure",
    summary: "Paints a vendor-style abend screen (ABEND 0C7) instead of the requested screen.",
  },
});

export const FAULT_IDS = Object.freeze(Object.keys(FAULTS));

/** Shorthands accepted on the wire so the prose in the spec resolves to a real id. */
const ALIASES = Object.freeze({
  tear: "torn-repaint",
  "torn-render": "torn-repaint",
  slow: "slow-repaint",
  "slow-load": "slow-repaint",
  timeout: "session-timeout",
  abend: "app-error",
  "app-500": "app-error",
});

/**
 * Resolve a wire-level fault name to a canonical id, or null.
 *
 * An unknown name is "no fault armed" rather than an error, for the same reason the web fixture
 * made that choice: this process's only output channel is a repainted screen, so a 400 would arrive
 * as a driver that never perceives anything and a stack trace nobody sees.
 *
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
 * @property {"delivery"|"transition"} family
 * @property {string} screen
 * @property {"once"|"sticky"} mode
 * @property {number} delayMs   How long `slow-repaint` holds a frame, and how long `torn-repaint`
 *                              stays silent mid-frame. Both must exceed the driver's quiet window
 *                              or the fault is not observable.
 * @property {number} tearAt    Fraction of the frame delivered before `torn-repaint` goes quiet.
 */

/**
 * Build the armed-fault record, filling defaults from the registry.
 *
 * @param {string | null | undefined} rawId
 * @param {{ at?: string | null, mode?: string | null, delayMs?: string | number | null,
 *           tearAt?: string | number | null }} [opts]
 * @returns {ArmedFault | null}
 */
export const armFault = (rawId, opts = {}) => {
  const id = canonicalFaultId(rawId);
  if (id === null) return null;
  const spec = /** @type {FaultSpec} */ (FAULTS[id]);
  const at = typeof opts.at === "string" ? opts.at.trim().toLowerCase() : "";
  const screen = at === "any" || SCREENS.includes(at) ? at : spec.screen;
  const mode = opts.mode === "once" || opts.mode === "sticky" ? opts.mode : spec.mode;
  const delay = Number.parseInt(String(opts.delayMs ?? ""), 10);
  const delayMs = Number.isFinite(delay) && delay >= 0 ? delay : 400;
  const tear = Number.parseFloat(String(opts.tearAt ?? ""));
  const tearAt = Number.isFinite(tear) && tear > 0 && tear < 1 ? tear : 0.55;
  return { id, family: spec.family, screen, mode, delayMs, tearAt };
};

/**
 * Does the armed fault fire on this paint?
 * @param {ArmedFault | null} armed
 * @param {string} screen
 */
export const faultFiresOn = (armed, screen) =>
  armed !== null && (armed.screen === "any" || armed.screen === screen);
