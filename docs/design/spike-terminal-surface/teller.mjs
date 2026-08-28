#!/usr/bin/env node
/*
 * fixture: a Symitar-Episys-shaped 80x24 green-screen teller app.
 * Renders with plain ANSI/VT100. Reverse video marks input fields, which is how
 * real 3270/VT teller screens mark them. Reads keystrokes from stdin.
 *
 * SYNTHETIC DATA ONLY.
 */
const ESC = '\x1b';
const CSI = ESC + '[';
const COLS = 80, ROWS = 24;

const MEMBERS = {
  '12345': { name: 'AVERY SYNTHETIC', accounts: [
    ['S0001', 'REGULAR SAVINGS', '   1,204.55'],
    ['S0010', 'VACATION CLUB  ', '     310.00'],
    ['D0001', 'FREE CHECKING  ', '   2,880.13'],
  ]},
  '99999': { name: 'FROZEN TEST ACCT', accounts: [] , denied: true },
};

// Two tenants running the SAME vendor product, branded and laid out differently.
const TENANTS = {
  riverbend: { bank: 'RIVERBEND CU', title: 'MEMBER INQUIRY', teller: 'TELLER 04',
    labels: ['Account Number:', 'Name Search:'], labelCol: 3, fieldCol: 22,
    rows: [6, 8], widths: [12, 28], back: 'F3', legend: 'F3=Exit   TAB=Next Field   ENTER=Search' },
  summit: { bank: 'SUMMIT FCU', title: 'MBR INQ', teller: 'TLR 17',
    labels: ['Acct #:', 'Search Name:'], labelCol: 5, fieldCol: 20,
    rows: [7, 9], widths: [10, 24], back: 'F12', legend: 'F12=Exit  TAB=Next Field  ENTER=Search' },
};
const T = TENANTS[process.env.TENANT || 'riverbend'];

const state = {
  screen: 'INQUIRY',
  fields: [
    { name: 'accountNumber', row: T.rows[0], col: T.fieldCol, width: T.widths[0], value: '' },
    { name: 'nameSearch',    row: T.rows[1], col: T.fieldCol, width: T.widths[1], value: '' },
  ],
  focus: 0,
  status: '',
  statusKind: 'INFO',
  member: null,
  listSel: 0,
};

function pad(s, n) { return (s + ' '.repeat(n)).slice(0, n); }
function at(r, c) { return `${CSI}${r};${c}H`; }
const REV = CSI + '7m', BOLD = CSI + '1m', OFF = CSI + '0m';

function render() {
  let out = CSI + '2J' + CSI + 'H';
  out += at(1, 1) + BOLD + pad('  ' + T.bank + '        ' + T.title + '                       ' + T.teller, COLS) + OFF;
  out += at(2, 1) + '='.repeat(COLS);

  if (state.screen === 'INQUIRY') {
    out += at(4, 3) + 'Enter an account number OR a name fragment, then press ENTER.';
    out += at(T.rows[0], T.labelCol) + T.labels[0];
    out += at(T.rows[1], T.labelCol) + T.labels[1];
    for (const f of state.fields) {
      out += at(f.row, f.col) + REV + pad(f.value, f.width) + OFF;
    }
    out += at(T.rows[1] + 3, T.labelCol) + T.legend;
  } else if (state.screen === 'DETAIL') {
    const m = state.member;
    out += at(4, 3) + 'Member:  ' + BOLD + m.id + OFF + '   ' + m.name;
    out += at(6, 3) + BOLD + pad('SUFFIX  DESCRIPTION        BALANCE', 60) + OFF;
    m.accounts.forEach((a, i) => {
      const line = ` ${pad(a[0], 7)} ${pad(a[1], 18)} ${a[2]}`;
      out += at(7 + i, 3) + (i === state.listSel ? REV + pad(line, 45) + OFF : pad(line, 45));
    });
    out += at(13, 3) + 'F3=Back   ' + String.fromCharCode(0x18) + '/' + String.fromCharCode(0x19) + '=Select   ENTER=Open Suffix';
  }

  if (state.status) {
    const tag = state.statusKind === 'ERROR' ? '*** ' : '';
    out += at(23, 1) + pad(' ' + tag + state.status, COLS);
  }
  out += at(24, 1) + pad(' ' + (state.screen === 'INQUIRY' ? 'MEMBER INQUIRY 01' : 'ACCOUNT LIST 02'), COLS);

  // Park the hardware cursor in the focused field. This is the ONLY signal a real
  // green screen gives about focus.
  if (state.screen === 'INQUIRY') {
    const f = state.fields[state.focus];
    out += at(f.row, f.col + f.value.length);
  } else {
    out += at(7 + state.listSel, 3);
  }
  process.stdout.write(out);
}

function submitInquiry() {
  const acct = state.fields[0].value.trim();
  const nm = state.fields[1].value.trim();
  if (!acct && !nm) { state.status = 'ENTER AN ACCOUNT NUMBER OR NAME'; state.statusKind = 'ERROR'; return; }
  if (acct && !/^\d+$/.test(acct)) { state.status = 'INVALID ACCOUNT NUMBER - NUMERIC ONLY'; state.statusKind = 'ERROR'; return; }
  const m = MEMBERS[acct];
  if (!m) { state.status = 'NO MEMBER ON FILE FOR ' + (acct || nm); state.statusKind = 'ERROR'; return; }
  if (m.denied) { state.status = 'SECURITY VIOLATION - TELLER NOT AUTHORIZED'; state.statusKind = 'ERROR'; return; }
  state.member = { id: acct, name: m.name, accounts: m.accounts };
  state.screen = 'DETAIL'; state.listSel = 0; state.status = ''; state.statusKind = 'INFO';
}

// Tokenize the byte stream into keys. A green screen receives raw bytes, so
// multi-byte escape sequences can arrive glued to ordinary characters.
function tokenize(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ESC) {
      const m = /^\x1b(\[[0-9;]*[A-Za-z~]|O[A-Za-z])/.exec(s.slice(i));
      if (m) { out.push(m[0]); i += m[0].length - 1; continue; }
    }
    out.push(s[i]);
  }
  return out;
}

const KEYNAME = { '\x1b[24~': 'F3', '\x1bOR': 'F3', '\x1b[13~': 'F3', '\x1b[A': 'UP', '\x1b[B': 'DOWN', '\t': 'TAB', '\r': 'ENTER', '\n': 'ENTER', '\x7f': 'BACKSPACE', '\b': 'BACKSPACE' };

function onKey(raw) {
  for (const tok of tokenize(raw)) {
    const key = KEYNAME[tok];
    if (key === 'F3') {
      if (state.screen === 'DETAIL') { state.screen = 'INQUIRY'; state.status = ''; }
      else process.exit(0);
      for (const f of state.fields) f.value = '';
      state.focus = 0;
      continue;
    }
    if (key === 'UP') { state.listSel = Math.max(0, state.listSel - 1); continue; }
    if (key === 'DOWN') { state.listSel = Math.min((state.member?.accounts.length || 1) - 1, state.listSel + 1); continue; }
    if (key === 'TAB') { state.focus = (state.focus + 1) % state.fields.length; continue; }
    if (key === 'ENTER') {
      if (state.screen === 'INQUIRY') submitInquiry();
      else { state.status = 'SUFFIX ' + state.member.accounts[state.listSel][0] + ' OPENED'; state.statusKind = 'INFO'; }
      continue;
    }
    if (key === 'BACKSPACE') { const f = state.fields[state.focus]; f.value = f.value.slice(0, -1); continue; }
    if (tok.length === 1 && tok >= ' ' && tok <= '~') {
      const f = state.fields[state.focus];
      if (f.value.length < f.width) f.value += tok.toUpperCase();
    }
  }
}

process.stdin.on('data', (b) => { onKey(b.toString('latin1')); render(); });
process.stdin.on('end', () => process.exit(0));
render();
