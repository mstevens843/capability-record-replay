// The teller application: a byte-in, frame-out state machine with no idea what a process is.
//
// It takes keystrokes as bytes and hands complete ANSI frames to a sink. It never touches
// `process`, never reads a clock it was not given, and never opens anything. That is what lets the
// same object be (a) spawned as a child process behind a pipe transport by `main.js`, (b) driven
// entirely in memory by a unit test with a fake scheduler, and (c) used to capture the frozen grids
// the detector's assertions run against - with all three producing the same bytes.
//
// The spike proved the equivalent claim one layer down: a pipe transport and a real pty produced
// byte-identical grids (the same sha256 over 1.28 MB). Having the app be transport-agnostic too
// means the whole stack from keystroke to Observation can be exercised with no child process at
// all, which is why the terminal branch of this repo's test suite costs nothing in CI.

import { MEMBERS, STATUS } from "./data.js";
import { armFault } from "./faults.js";
import { renderFrame, screenIdOf } from "./render.js";
import { resolveTenant } from "./tenants.js";

const ESC = "\x1b";

/**
 * Byte stream -> logical keys.
 *
 * A green screen receives raw bytes, and a multi-byte escape sequence can arrive glued to an
 * ordinary character in the same chunk - or split across two chunks, which is why the tail of an
 * unfinished sequence is carried over rather than discarded.
 */
const KEY_SEQUENCES = Object.freeze({
  "\x1bOP": "F1",
  "\x1bOQ": "F2",
  "\x1bOR": "F3",
  "\x1bOS": "F4",
  "\x1b[11~": "F1",
  "\x1b[12~": "F2",
  "\x1b[13~": "F3",
  "\x1b[14~": "F4",
  "\x1b[15~": "F5",
  "\x1b[17~": "F6",
  "\x1b[18~": "F7",
  "\x1b[19~": "F8",
  "\x1b[20~": "F9",
  "\x1b[21~": "F10",
  "\x1b[23~": "F11",
  "\x1b[24~": "F12",
  "\x1b[A": "ArrowUp",
  "\x1b[B": "ArrowDown",
  "\x1b[C": "ArrowRight",
  "\x1b[D": "ArrowLeft",
  "\x1b[1~": "Home",
  "\x1b[4~": "End",
  "\x1b": "Escape",
  "\t": "Tab",
  "\r": "Enter",
  "\n": "Enter",
  "\x7f": "Backspace",
  "\b": "Backspace",
});

// Both patterns below are BUILT from `ESC` rather than written with a `\x1b` literal. Biome refuses
// a control character inside a regular expression, and the rule is right in general - a stray 0x1b
// in a pattern is nearly always a mistake. Here it is the subject: this is a VT escape-sequence
// tokenizer, and composing the pattern says so instead of suppressing the rule at four call sites.
/** A partial escape sequence at the end of a chunk: hold it, do not print it. */
const PARTIAL = new RegExp(`^${ESC}(\\[[0-9;]*|O)?$`);

/** A complete CSI or SS3 sequence at the start of the remaining input. */
const SEQUENCE = new RegExp(`^${ESC}(\\[[0-9;]*[A-Za-z~]|O[A-Za-z])`);

/**
 * @param {string} chunk
 * @returns {{ tokens: string[], carry: string }}
 */
export function tokenizeKeys(chunk) {
  /** @type {string[]} */
  const tokens = [];
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === ESC) {
      const rest = chunk.slice(i);
      const m = SEQUENCE.exec(rest);
      if (m) {
        tokens.push(m[0]);
        i += m[0].length;
        continue;
      }
      if (PARTIAL.test(rest)) return { tokens, carry: rest };
    }
    tokens.push(/** @type {string} */ (chunk[i]));
    i += 1;
  }
  return { tokens, carry: "" };
}

/**
 * @typedef {object} TellerAppOptions
 * @property {string} [tenant]
 * @property {string} [fault]
 * @property {string} [faultAt]
 * @property {string} [faultMode]
 * @property {number} [delayMs]
 * @property {number} [tearAt]
 * @property {(fn: () => void, ms: number) => unknown} [schedule]  Injected so a test owns time.
 * @property {(handle: unknown) => void} [cancel]
 */

/**
 * @param {TellerAppOptions} [options]
 */
export function createTellerApp(options = {}) {
  const tenant = resolveTenant(options.tenant);
  let armed = armFault(options.fault, {
    at: options.faultAt ?? null,
    mode: options.faultMode ?? null,
    delayMs: options.delayMs ?? null,
    tearAt: options.tearAt ?? null,
  });
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.cancel ?? ((h) => clearTimeout(/** @type {any} */ (h)));

  /** @type {Set<(chunk: string) => void>} */
  const sinks = new Set();
  /** @type {Set<unknown>} */
  const timers = new Set();
  let carry = "";
  let closed = false;
  let exitRequested = false;

  /** @type {import("./render.js").ScreenState} */
  const state = {
    screen: "inquiry",
    fields: inquiryFields(),
    focus: 0,
    status: "",
    statusKind: "INFO",
    member: null,
    listSel: 0,
    abendCode: "0C7",
  };

  function inquiryFields() {
    return [
      {
        name: "accountNumber",
        row: tenant.fieldRows[0],
        col: tenant.fieldCol,
        width: tenant.widths[0],
        value: "",
      },
      {
        name: "nameSearch",
        row: tenant.fieldRows[1],
        col: tenant.fieldCol,
        width: tenant.widths[1],
        value: "",
      },
    ];
  }

  const signonFields = () => [
    {
      name: "operatorId",
      row: tenant.fieldRows[0],
      col: tenant.fieldCol,
      width: 8,
      value: "",
    },
  ];

  /** @param {string} chunk */
  const emit = (chunk) => {
    if (closed) return;
    for (const sink of sinks) sink(chunk);
  };

  /** @param {() => void} fn @param {number} ms */
  const later = (fn, ms) => {
    const handle = schedule(() => {
      timers.delete(handle);
      fn();
    }, ms);
    timers.add(handle);
  };

  /** A `once` fault is spent the moment it fires; a `sticky` one is not. */
  const consume = () => {
    if (armed !== null && armed.mode === "once") armed = null;
  };

  /**
   * Delivery-family faults live here and NOWHERE else, so a reader can see in one place that the
   * app's state was always correct and only the bytes were wrong. That distinction is the whole
   * value of the torn-repaint case: it is not a bug in the app, and no amount of retrying the
   * app's logic would have caught it.
   */
  function deliver() {
    const frame = renderFrame(state, tenant);
    if (armed !== null && armed.family === "delivery" && firesOnCurrentScreen()) {
      if (armed.id === "slow-repaint") {
        const ms = armed.delayMs;
        consume();
        later(() => emit(frame), ms);
        return;
      }
      if (armed.id === "torn-repaint") {
        const cut = Math.max(
          1,
          Math.min(frame.length - 1, Math.floor(frame.length * armed.tearAt)),
        );
        const ms = armed.delayMs;
        consume();
        emit(frame.slice(0, cut));
        later(() => emit(frame.slice(cut)), ms);
        return;
      }
    }
    emit(frame);
  }

  const firesOnCurrentScreen = () =>
    armed !== null && (armed.screen === "any" || armed.screen === state.screen);

  /**
   * Transition-family faults live here. The app is asked to go to a screen and goes somewhere else.
   * Every byte it then paints is correct, which is exactly why a replay engine that trusts "the
   * bytes arrived and the stream went quiet" reports success for a run that never got there.
   *
   * @param {"signon"|"inquiry"|"detail"|"error"} screen
   */
  function goTo(screen) {
    if (
      armed !== null &&
      armed.family === "transition" &&
      (armed.screen === "any" || armed.screen === screen)
    ) {
      if (armed.id === "session-timeout") {
        // Deliberately NOT consumed: a session does not un-expire because you looked at it. It is
        // cleared by signing on, which is the remedy an artifact would declare for this condition.
        state.screen = "signon";
        state.fields = signonFields();
        state.focus = 0;
        state.member = null;
        state.status = "";
        state.statusKind = "INFO";
        return;
      }
      if (armed.id === "app-error") {
        consume();
        state.screen = "error";
        state.status = "";
        state.statusKind = "INFO";
        return;
      }
    }
    state.screen = screen;
    if (screen === "inquiry") state.fields = inquiryFields();
    if (screen === "signon") state.fields = signonFields();
    state.focus = 0;
  }

  /** @param {string} text */
  function fail(text) {
    state.status = text;
    state.statusKind = "ERROR";
  }

  function submitInquiry() {
    const account = (state.fields[0]?.value ?? "").trim();
    const name = (state.fields[1]?.value ?? "").trim();
    if (!account && !name) return fail(STATUS.emptyQuery);
    if (account && !/^\d+$/.test(account)) return fail(STATUS.nonNumeric);
    const member = MEMBERS[account];
    if (!member) return fail(STATUS.notOnFile(account || name));
    if (member.restricted) return fail(STATUS.restricted);
    state.member = { id: account, name: member.name, accounts: member.accounts };
    state.listSel = 0;
    state.status = "";
    state.statusKind = "INFO";
    goTo("detail");
  }

  function submitSignon() {
    const id = (state.fields[0]?.value ?? "").trim();
    if (!id) return fail("ENTER AN OPERATOR ID");
    // The remedy clears the condition. Anything less would make `reauthenticate` a recovery that
    // cannot succeed, which is worse than not declaring one.
    if (armed !== null && armed.id === "session-timeout") armed = null;
    goTo("inquiry");
    state.status = STATUS.signedOn;
    state.statusKind = "INFO";
  }

  /** @param {string} key */
  function onKey(key) {
    if (key === tenant.exitKey) {
      if (state.screen === "detail" || state.screen === "error" || state.screen === "signon") {
        goTo("inquiry");
        state.status = "";
        state.statusKind = "INFO";
      } else {
        exitRequested = true;
      }
      return;
    }
    if (state.screen === "detail") {
      const last = Math.max(0, (state.member?.accounts.length ?? 1) - 1);
      if (key === "ArrowUp") {
        state.listSel = Math.max(0, state.listSel - 1);
        return;
      }
      if (key === "ArrowDown") {
        state.listSel = Math.min(last, state.listSel + 1);
        return;
      }
      if (key === "Enter") {
        const account = state.member?.accounts[state.listSel];
        state.status = account ? STATUS.opened(account.suffix) : "";
        state.statusKind = "INFO";
      }
      return;
    }
    if (state.screen === "error") return;
    if (key === "Tab") {
      state.focus = (state.focus + 1) % state.fields.length;
      return;
    }
    if (key === "Enter") {
      if (state.screen === "signon") submitSignon();
      else submitInquiry();
      return;
    }
    if (key === "Backspace") {
      const field = state.fields[state.focus];
      if (field) field.value = field.value.slice(0, -1);
      return;
    }
    if (key.length === 1 && key >= " " && key <= "~") {
      const field = state.fields[state.focus];
      // Capacity is enforced HERE, and it is the same number the driver reads off the grid as the
      // field's `capacity`. A typed parameter's maxLength and the app's own limit are therefore the
      // same fact, discovered rather than declared.
      if (field && field.value.length < field.width) field.value += key.toUpperCase();
    }
  }

  return {
    tenant,
    /** The armed fault, for a test that wants to assert on what it armed. */
    get armedFault() {
      return armed;
    },
    get screen() {
      return state.screen;
    },
    get screenId() {
      return screenIdOf(state, tenant);
    },
    get statusText() {
      return state.status;
    },
    /** True once the operator pressed Exit on the top screen. `main.js` turns this into an exit. */
    get exitRequested() {
      return exitRequested;
    },

    /** @param {(chunk: string) => void} sink @returns {() => void} */
    onOutput(sink) {
      sinks.add(sink);
      return () => sinks.delete(sink);
    },

    /** Paint the first frame. Separate from construction so a sink can be attached first. */
    start() {
      deliver();
    },

    /** @param {string | Uint8Array} data */
    write(data) {
      if (closed) return;
      const text = typeof data === "string" ? data : Buffer.from(data).toString("latin1");
      const { tokens, carry: rest } = tokenizeKeys(carry + text);
      carry = rest;
      for (const token of tokens) onKey(KEY_SEQUENCES[token] ?? token);
      deliver();
    },

    close() {
      closed = true;
      for (const handle of timers) cancel(handle);
      timers.clear();
      sinks.clear();
    },
  };
}

/** @typedef {ReturnType<typeof createTellerApp>} TellerApp */
