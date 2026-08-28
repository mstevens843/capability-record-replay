// Two credit unions running the SAME vendor green screen, branded and laid out differently.
//
// This is the terminal half of BRIEF section 3.8, and the spike measured why it is worth having:
// between these two variants NOT ONE COORDINATE MATCHES, the two field labels change, the field
// widths change, the screen names change - and the detector still recovers the same two textboxes,
// the same three controls, the same roles and the same capacities.
//
// The single most useful difference is the last one. `exitKey` is F3 at riverbend and F12 at
// summit, and the synthesized node is `button:exit` at BOTH. An artifact that said `pressKey(F3)`
// would be correct at one credit union and wrong at the next; an artifact that says "activate the
// control named Exit" is correct at both, because the driver reads the legend line at replay time
// and lowers the activation onto whichever key this tenant prints. That is a per-tenant difference
// that needs no overlay at all, and it is the argument SPEC section 2.2 makes for keeping F-keys at
// the port and out of the instruction set.
//
// Everything here is layout. Nothing here changes what the app DOES.

/**
 * @typedef {object} Tenant
 * @property {string} id
 * @property {string} bank        Branding band, left.
 * @property {string} title       Branding band, middle.
 * @property {string} teller      Branding band, right.
 * @property {readonly [string, string]} labels    Field labels, printed to the left of each field.
 * @property {number} labelCol    1-based column the labels start at.
 * @property {number} fieldCol    1-based column the reverse-video fields start at.
 * @property {readonly [number, number]} fieldRows 1-based rows the two fields sit on.
 * @property {readonly [number, number]} widths    Field capacities, in cells.
 * @property {string} exitKey     The key this tenant binds Exit/Back to.
 * @property {string} inquiryScreen  The screen-id band on the lookup screen.
 * @property {string} detailScreen   The screen-id band on the account-list screen.
 * @property {string} signonScreen   The screen-id band on the sign-on screen.
 * @property {string} errorScreen    The screen-id band on the abend screen.
 */

/** @type {Readonly<Record<string, Tenant>>} */
export const TENANTS = Object.freeze({
  riverbend: {
    id: "riverbend",
    bank: "RIVERBEND CU",
    title: "MEMBER INQUIRY",
    teller: "TELLER 04",
    labels: ["Account Number:", "Name Search:"],
    labelCol: 3,
    fieldCol: 22,
    fieldRows: [6, 8],
    widths: [12, 28],
    exitKey: "F3",
    inquiryScreen: "MEMBER INQUIRY 01",
    detailScreen: "ACCOUNT LIST 02",
    signonScreen: "SIGN ON 00",
    errorScreen: "SYSTEM ERROR 99",
  },
  summit: {
    id: "summit",
    bank: "SUMMIT FCU",
    title: "MBR INQ",
    teller: "TLR 17",
    labels: ["Acct #:", "Search Name:"],
    labelCol: 5,
    fieldCol: 20,
    fieldRows: [7, 9],
    widths: [10, 24],
    exitKey: "F12",
    inquiryScreen: "MBR INQ 01",
    detailScreen: "ACCT LIST 02",
    signonScreen: "SIGN ON 00",
    errorScreen: "SYSTEM ERROR 99",
  },
});

export const TENANT_IDS = Object.freeze(Object.keys(TENANTS));

/**
 * Resolve a tenant name to a variant. An unknown name is NOT an error: it falls back to the
 * default, because a typo that silently serves a working screen is easier to debug from a grid
 * dump than a child process that exited before it painted anything.
 *
 * @param {string | null | undefined} name
 * @returns {Tenant}
 */
export const resolveTenant = (name) => {
  const key = String(name ?? "")
    .trim()
    .toLowerCase();
  return TENANTS[key] ?? /** @type {Tenant} */ (TENANTS.riverbend);
};
