// Synthetic member data. Every record here is invented.
//
// Names carry a literal "(SYNTHETIC)" suffix, member numbers are a contiguous 100xx block that
// matches no real institution's numbering, and balances are round-ish nonsense. This is a test
// fixture; nothing in it is, resembles, or is derived from a real person or a real account.
//
// Two shapes in this list exist to break weak automation rather than to look realistic:
//
//   1. TWO MEMBERS SHARE A NAME (10044 and 10045 are both "PARKER, JAMIE"). A search on the surname
//      returns both. An artifact that finds the row by the member's NAME is ambiguous by
//      construction, which is what SPEC section 4.8's duplicate-name mutant scenario needs.
//   2. THE MATCH IS NEVER ROW ONE for the surname searches, and the grid is ordered by surname
//      rather than by member number, so row index is not a stable identity either.
//
// The two special records - 10046 restricted, 10047 closed - give the classifier organic instances
// of SPEC section 4.2 rows 7 (record-scoped denial, an OUTCOME) and a closed-account outcome,
// without needing fault injection at all. Fault injection then forces the same screens for ANY
// member, which is what the conformance corpus needs.

/**
 * @typedef {object} SubAccount
 * @property {string} number
 * @property {string} type      Product code, e.g. "S1".
 * @property {string} typeName  Vendor-neutral product name; the tenant renames it at render time.
 * @property {string} balance
 * @property {string} opened
 */

/**
 * @typedef {object} Member
 * @property {string} memberId
 * @property {string} name
 * @property {string} status      ACTIVE | DORMANT | RESTRICTED | CLOSED
 * @property {string} balance
 * @property {string} branch
 * @property {string} joined
 * @property {SubAccount[]} subAccounts
 */

/** @type {readonly Member[]} */
const SEED = Object.freeze([
  {
    memberId: "10041",
    name: "ALVAREZ, DANA (SYNTHETIC)",
    status: "ACTIVE",
    balance: "1,204.55",
    branch: "004 - RIVER OAKS (SYNTHETIC)",
    joined: "2019-03-11",
    subAccounts: [
      {
        number: "0001",
        type: "S1",
        typeName: "Regular",
        balance: "1,204.55",
        opened: "2019-03-11",
      },
    ],
  },
  {
    memberId: "10042",
    name: "BOOKER, RAY (SYNTHETIC)",
    status: "DORMANT",
    balance: "88.10",
    branch: "004 - RIVER OAKS (SYNTHETIC)",
    joined: "2016-08-02",
    subAccounts: [
      { number: "0001", type: "S1", typeName: "Regular", balance: "88.10", opened: "2016-08-02" },
    ],
  },
  {
    memberId: "10043",
    name: "CHEN, MIN (SYNTHETIC)",
    status: "ACTIVE",
    balance: "15,900.00",
    branch: "011 - NORTHGATE (SYNTHETIC)",
    joined: "2012-01-19",
    subAccounts: [
      { number: "0001", type: "S1", typeName: "Regular", balance: "900.00", opened: "2012-01-19" },
      {
        number: "0002",
        type: "S9",
        typeName: "Holiday Club",
        balance: "15,000.00",
        opened: "2021-11-04",
      },
    ],
  },
  {
    memberId: "10044",
    name: "PARKER, JAMIE (SYNTHETIC)",
    status: "ACTIVE",
    balance: "312.00",
    branch: "011 - NORTHGATE (SYNTHETIC)",
    joined: "2020-06-30",
    subAccounts: [
      { number: "0001", type: "S1", typeName: "Regular", balance: "312.00", opened: "2020-06-30" },
    ],
  },
  {
    // Same displayed name as 10044. Finding "the Parker row" is ambiguous; finding "the row whose
    // Member ID cell is 10045" is not. That is the entire point of this record.
    memberId: "10045",
    name: "PARKER, JAMIE (SYNTHETIC)",
    status: "ACTIVE",
    balance: "7,415.28",
    branch: "004 - RIVER OAKS (SYNTHETIC)",
    joined: "2014-02-14",
    subAccounts: [
      {
        number: "0001",
        type: "S1",
        typeName: "Regular",
        balance: "7,415.28",
        opened: "2014-02-14",
      },
    ],
  },
  {
    memberId: "10046",
    name: "OKONKWO, ADAEZE (SYNTHETIC)",
    status: "RESTRICTED",
    balance: "2,040.00",
    branch: "011 - NORTHGATE (SYNTHETIC)",
    joined: "2018-09-27",
    subAccounts: [
      {
        number: "0001",
        type: "S1",
        typeName: "Regular",
        balance: "2,040.00",
        opened: "2018-09-27",
      },
    ],
  },
  {
    memberId: "10047",
    name: "QUINTANA, LEE (SYNTHETIC)",
    status: "CLOSED",
    balance: "0.00",
    branch: "004 - RIVER OAKS (SYNTHETIC)",
    joined: "2011-05-05",
    subAccounts: [],
  },
]);

/** Product codes offered by the open-sub-account form, vendor-neutral. */
export const PRODUCT_CODES = Object.freeze([
  { code: "S1", name: "Regular" },
  { code: "S9", name: "Holiday Club" },
  { code: "S7", name: "Youth" },
]);

/**
 * The product code the `validation-error` fault rejects.
 *
 * Chosen so the injected validation error lands on a value an artifact would hold as a LITERAL
 * (the product code picked once at record time) rather than on a value bound to a caller argument.
 * That is SPEC section 4.2 row 5 - the same red banner that is an OUTCOME when the rejected value
 * came from the caller is a HARD FAILURE when it came from the artifact, and the fixture has to be
 * able to produce both or the distinction is untestable.
 */
export const DISABLED_PRODUCT_CODE = "S9";

/**
 * A fresh, deep, per-session copy of the member store.
 *
 * Per session, because opening a sub-account is a real mutation and two concurrent replay runs must
 * not see each other's writes.
 *
 * @returns {Map<string, Member>}
 */
export const freshMemberStore = () => {
  const store = new Map();
  for (const member of SEED) {
    store.set(member.memberId, {
      ...member,
      subAccounts: member.subAccounts.map((account) => ({ ...account })),
    });
  }
  return store;
};

/**
 * Search the store the way the legacy app does: exact match on member number, prefix match
 * (case-insensitive) on surname, and a criteria-free search lists everyone. Results are ordered by
 * name, NOT by member number, so the row a caller wants is rarely row one.
 *
 * @param {Map<string, Member>} store
 * @param {{ memberId?: string, lastName?: string }} query
 * @returns {Member[]}
 */
export const searchMembers = (store, query) => {
  const memberId = (query.memberId ?? "").trim();
  const lastName = (query.lastName ?? "").trim().toUpperCase();
  const all = [...store.values()];
  const matched = all.filter((member) => {
    if (memberId && member.memberId !== memberId) return false;
    if (lastName && !member.name.toUpperCase().startsWith(lastName)) return false;
    return true;
  });
  return matched.sort(
    (a, b) => a.name.localeCompare(b.name) || a.memberId.localeCompare(b.memberId),
  );
};

/**
 * Append a sub-account and return it.
 *
 * DELIBERATELY NOT IDEMPOTENT. Posting the commit twice opens two sub-accounts, exactly as the real
 * thing would. SPEC section 4.2 row 33 (`effect-in-doubt`) and section 3.5's restart rules only
 * mean anything against a fixture that will actually double-write, so this one does.
 *
 * @param {Member} member
 * @param {{ type: string, typeName: string, amount: string }} spec
 * @returns {SubAccount}
 */
export const appendSubAccount = (member, spec) => {
  const next = String(member.subAccounts.length + 1).padStart(4, "0");
  const account = {
    number: next,
    type: spec.type,
    typeName: spec.typeName,
    balance: spec.amount,
    opened: "2024-01-15",
  };
  member.subAccounts.push(account);
  return account;
};
