// The teller file. OBVIOUSLY SYNTHETIC DATA ONLY - no real member, no real balance, no real name.
//
// Three account numbers are enough to exercise all three arms of the taxonomy, and they are chosen
// so that WHICH arm you get is a property of the ARGUMENT rather than of an injected fault:
//
//   12345  a member on file           -> the happy path
//   99999  a member the teller may not see -> a permission denial the app states on the status line
//   77777  no such member             -> the declared business outcome MEMBER_NOT_FOUND
//   ABC    not an account number      -> a validation error the app states on the status line
//
// That split matters. The four INJECTED faults in `faults.js` are all facts about the *system*
// (it is slow, it tore, it expired, it abended). The four above are facts about the *request*, and
// a green screen reports them the only way it can: as text on the status band. The detector reports
// that text and refuses to interpret it (driver rule D9); an artifact's declared outcome detector
// is what turns "NO MEMBER ON FILE" into MEMBER_NOT_FOUND.

/**
 * @typedef {object} Account
 * @property {string} suffix
 * @property {string} description
 * @property {string} balance   Right-aligned as the app prints it, gutters included.
 */

/**
 * @typedef {object} Member
 * @property {string} name
 * @property {readonly Account[]} accounts
 * @property {boolean} restricted  True when the teller role may not open this record.
 */

/** @type {Readonly<Record<string, Member>>} */
export const MEMBERS = Object.freeze({
  12345: {
    name: "AVERY SYNTHETIC",
    restricted: false,
    accounts: [
      { suffix: "S0001", description: "REGULAR SAVINGS", balance: "   1,204.55" },
      { suffix: "S0010", description: "VACATION CLUB  ", balance: "     310.00" },
      { suffix: "D0001", description: "FREE CHECKING  ", balance: "   2,880.13" },
    ],
  },
  54321: {
    name: "BRETT PLACEHOLDER",
    restricted: false,
    accounts: [
      { suffix: "S0001", description: "REGULAR SAVINGS", balance: "      12.00" },
      { suffix: "L0002", description: "AUTO LOAN      ", balance: "  -9,410.77" },
    ],
  },
  99999: { name: "FROZEN TEST ACCT", restricted: true, accounts: [] },
});

/** The status-band wordings. Held here so a test can assert on the same string the app prints. */
export const STATUS = Object.freeze({
  emptyQuery: "ENTER AN ACCOUNT NUMBER OR NAME",
  nonNumeric: "INVALID ACCOUNT NUMBER - NUMERIC ONLY",
  /** @param {string} key */
  notOnFile: (key) => `NO MEMBER ON FILE FOR ${key}`,
  restricted: "SECURITY VIOLATION - TELLER NOT AUTHORIZED",
  /** @param {string} suffix */
  opened: (suffix) => `SUFFIX ${suffix} OPENED`,
  signedOn: "SIGN ON ACCEPTED",
});
