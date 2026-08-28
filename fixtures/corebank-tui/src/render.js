// The 80x24 painter. A pure function of (state, tenant) -> one ANSI frame.
//
// It is written the way an AIX green screen actually paints: erase, absolute cursor addressing for
// every field, reverse video for anything the operator may type into, bold for anything the app is
// asserting, a status band on row 23 and a screen-id band on row 24. There is no scrolling, no line
// wrap and no cursor-relative motion, because a real inquiry screen has none of those and a driver
// that only ever saw well-behaved output would be tested against the wrong thing.
//
// Three conventions below are load-bearing for the driver, and the driver DERIVES all three rather
// than being told them - which is what lets it work on a green screen we did not write:
//
//   reverse video  marks an operator-writable field, or the selected row of a list;
//   bold           marks emphasis - a banner, a column header, a read-only value;
//   the last band  carries the screen name and number, which is this surface's URL.
//
// The one thing the painter must never do is help. No sentinel characters, no invisible markers, no
// out-of-band screen id. If the fixture told the driver where the fields were, the terminal surface
// would prove nothing about a surface with no clean DOM.

const ESC = "\x1b";
const CSI = `${ESC}[`;
export const COLS = 80;
export const ROWS = 24;

const REVERSE = `${CSI}7m`;
const BOLD = `${CSI}1m`;
const PLAIN = `${CSI}0m`;

/** @param {string} s @param {number} n */
const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
/** Absolute cursor address, 1-based, exactly as a VT terminal takes it. @param {number} r @param {number} c */
const at = (r, c) => `${CSI}${r};${c}H`;

/**
 * @typedef {object} Field
 * @property {string} name
 * @property {number} row     1-based.
 * @property {number} col     1-based.
 * @property {number} width
 * @property {string} value
 */

/**
 * @typedef {object} ScreenState
 * @property {"signon"|"inquiry"|"detail"|"error"} screen
 * @property {readonly Field[]} fields
 * @property {number} focus
 * @property {string} status
 * @property {"INFO"|"ERROR"} statusKind
 * @property {{ id: string, name: string, accounts: readonly {suffix: string, description: string,
 *              balance: string}[] } | null} member
 * @property {number} listSel
 * @property {string} abendCode
 */

/**
 * The branding band and the rule under it. Identical on every screen, which is what makes it the
 * part of the fingerprint worth EXCLUDING: it is the half that differs most between tenants and
 * means least (the spike measured 63% divergence with it and 40% without).
 *
 * @param {import("./tenants.js").Tenant} t
 * @param {string} title
 */
const banner = (t, title) =>
  at(1, 1) +
  BOLD +
  pad(`  ${t.bank}        ${title}                       ${t.teller}`, COLS) +
  PLAIN +
  at(2, 1) +
  "=".repeat(COLS);

/**
 * @param {ScreenState} s
 * @param {import("./tenants.js").Tenant} t
 */
function renderInquiry(s, t) {
  let out = banner(t, t.title);
  out += `${at(4, 3)}Enter an account number OR a name fragment, then press ENTER.`;
  out += at(t.fieldRows[0], t.labelCol) + t.labels[0];
  out += at(t.fieldRows[1], t.labelCol) + t.labels[1];
  for (const f of s.fields) out += at(f.row, f.col) + REVERSE + pad(f.value, f.width) + PLAIN;
  // Three spaces between legend entries, never one: the driver reads `KEY=Name` pairs and a single
  // space would let one control's name swallow the next control's key.
  out += `${at(t.fieldRows[1] + 3, t.labelCol) + t.exitKey}=Exit   TAB=Next Field   ENTER=Search`;
  return out;
}

/**
 * @param {ScreenState} s
 * @param {import("./tenants.js").Tenant} t
 */
function renderDetail(s, t) {
  const m = s.member;
  if (m === null) return renderInquiry(s, t);
  let out = banner(t, t.title);
  out += `${at(4, 3)}Member:  ${BOLD}${m.id}${PLAIN}   ${m.name}`;
  out += at(6, 3) + BOLD + pad("SUFFIX  DESCRIPTION        BALANCE", 60) + PLAIN;
  m.accounts.forEach((a, i) => {
    const line = ` ${pad(a.suffix, 7)} ${pad(a.description, 18)} ${a.balance}`;
    out += at(7 + i, 3) + (i === s.listSel ? REVERSE + pad(line, 45) + PLAIN : pad(line, 45));
  });
  out += `${at(13, 3) + t.exitKey}=Back   UP/DN=Select   ENTER=Open Suffix`;
  return out;
}

/**
 * @param {ScreenState} s
 * @param {import("./tenants.js").Tenant} t
 */
function renderSignon(s, t) {
  let out = banner(t, "SIGN ON");
  out += `${at(4, 3)}SESSION HAS ENDED. SIGN ON TO CONTINUE.`;
  out += `${at(t.fieldRows[0], t.labelCol)}Operator ID:`;
  const f = s.fields[0];
  out += at(f.row, f.col) + REVERSE + pad(f.value, f.width) + PLAIN;
  out += `${at(t.fieldRows[1] + 3, t.labelCol)}ENTER=Sign On   ${t.exitKey}=Exit`;
  return out;
}

/**
 * @param {ScreenState} s
 * @param {import("./tenants.js").Tenant} t
 */
function renderError(s, t) {
  let out = banner(t, "SYSTEM ERROR");
  out += `${at(4, 3)}*** ABEND ${s.abendCode} - DATA EXCEPTION`;
  out += `${at(6, 3)}TASK  MBRINQ   PROGRAM  MBR410   OFFSET  0004A8`;
  out += `${at(8, 3)}THE TRANSACTION WAS BACKED OUT. NOTHING WAS POSTED.`;
  out += `${at(13, 3) + t.exitKey}=Exit`;
  return out;
}

/** Which screen-id band this screen prints. @param {ScreenState} s @param {import("./tenants.js").Tenant} t */
export function screenIdOf(s, t) {
  switch (s.screen) {
    case "signon":
      return t.signonScreen;
    case "detail":
      return t.detailScreen;
    case "error":
      return t.errorScreen;
    default:
      return t.inquiryScreen;
  }
}

/**
 * One complete frame, ready to hand to a transport.
 *
 * @param {ScreenState} s
 * @param {import("./tenants.js").Tenant} t
 * @returns {string}
 */
export function renderFrame(s, t) {
  let out = `${CSI}2J${CSI}H`;
  switch (s.screen) {
    case "signon":
      out += renderSignon(s, t);
      break;
    case "detail":
      out += renderDetail(s, t);
      break;
    case "error":
      out += renderError(s, t);
      break;
    default:
      out += renderInquiry(s, t);
  }

  if (s.status) {
    const tag = s.statusKind === "ERROR" ? "*** " : "";
    out += at(23, 1) + pad(` ${tag}${s.status}`, COLS);
  }
  out += at(24, 1) + pad(` ${screenIdOf(s, t)}`, COLS);

  // Park the hardware cursor. On a character surface this is the ONLY focus signal there is: there
  // is no focused-node flag to read, so the driver's `state.focused` is computed from whether the
  // cursor lands inside a field's column span. Everything downstream - "the checkpoint says focus
  // moved into the search field" - rests on these two lines.
  if (s.screen === "detail" && s.member !== null) {
    out += at(7 + s.listSel, 3);
  } else if (s.screen === "error") {
    out += at(13, 3);
  } else {
    const f = s.fields[s.focus] ?? s.fields[0];
    out += at(f.row, f.col + f.value.length);
  }
  return out;
}
