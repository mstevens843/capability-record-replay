/* Assertions over frozen grids. No terminal, no child process: the detector is a
   pure function, so the whole taxonomy is testable from JSON. */
import fs from 'node:fs';
import { detect } from './detect.mjs';
const grids = JSON.parse(fs.readFileSync('./grids.json', 'utf8'));
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  PASS  ' + name); } else { fail++; console.log('  FAIL  ' + name + (extra ? '  <- ' + extra : '')); } };
const obs = Object.fromEntries(Object.entries(grids).map(([k, g]) => [k, detect(g)]));
const find = (o, id) => o.nodes.find((n) => n.id === id);
const byRole = (o, r) => o.nodes.filter((n) => n.role === r);

console.log('\n--- screen identity ---');
ok('inquiry screen id', obs.initial.screenId === 'MEMBER INQUIRY 01', obs.initial.screenId);
ok('detail screen id', obs.detail.screenId === 'ACCOUNT LIST 02', obs.detail.screenId);

console.log('\n--- fields, labels, capacity ---');
ok('two textboxes on inquiry', byRole(obs.initial, 'textbox').length === 2, String(byRole(obs.initial, 'textbox').length));
ok('account field labelled', find(obs.initial, 'textbox:account-number')?.name === 'Account Number');
ok('account field capacity 12', find(obs.initial, 'textbox:account-number')?.capacity === 12);
ok('name field labelled', find(obs.initial, 'textbox:name-search')?.name === 'Name Search');
ok('name field capacity 28', find(obs.initial, 'textbox:name-search')?.capacity === 28);

console.log('\n--- focus follows the hardware cursor ---');
ok('focus starts on account', find(obs.initial, 'textbox:account-number')?.state.focused === true);
ok('focus not on name', find(obs.initial, 'textbox:name-search')?.state.focused === false);
ok('after TAB focus is name', find(obs.tabbed, 'textbox:name-search')?.state.focused === true);
ok('after TAB focus left account', find(obs.tabbed, 'textbox:account-number')?.state.focused === false);
ok('typed value read back', find(obs.typed, 'textbox:account-number')?.value === '12345');

console.log('\n--- function-key legend -> controls ---');
ok('three controls on inquiry', byRole(obs.initial, 'button').length === 3);
ok('Exit is F3', find(obs.initial, 'button:exit')?.key === 'F3');
ok('Search is ENTER', find(obs.initial, 'button:search')?.key === 'ENTER');
ok('Open Suffix is ENTER', find(obs.detail, 'button:open-suffix')?.key === 'ENTER');

console.log('\n--- list, columns, selection ---');
const list = byRole(obs.detail, 'list')[0];
ok('exactly one list on detail', byRole(obs.detail, 'list').length === 1, String(byRole(obs.detail, 'list').length));
ok('three rows', list?.children.length === 3, String(list?.children.length));
ok('columns named from header', JSON.stringify(list?.columns) === '["SUFFIX","DESCRIPTION","BALANCE"]', JSON.stringify(list?.columns));
ok('row 0 selected initially', list?.children[0].state.selected === true);
ok('balance not truncated', list?.children[0].cells.BALANCE === '1,204.55', list?.children[0].cells.BALANCE);
const list2 = byRole(obs.arrowed, 'list')[0];
ok('after 2x DOWN row 2 selected', list2?.children[2].state.selected === true);
ok('selected row suffix D0001', list2?.children.find((c) => c.state.selected)?.cells.SUFFIX === 'D0001');

console.log('\n--- read-only values ---');
ok('member id read as text node', find(obs.detail, 'text:member')?.value === '12345');

console.log('\n--- status line is reported, NOT interpreted ---');
ok('not-found status text', byRole(obs.notfound, 'status')[0]?.value === '*** NO MEMBER ON FILE FOR 77777');
ok('denied status text', byRole(obs.denied, 'status')[0]?.value === '*** SECURITY VIOLATION - TELLER NOT AUTHORIZED');
ok('validation status text', byRole(obs.invalid, 'status')[0]?.value === '*** INVALID ACCOUNT NUMBER - NUMERIC ONLY');
ok('no status on happy path', byRole(obs.initial, 'status').length === 0);
ok('detector assigns no meaning', byRole(obs.notfound, 'status')[0]?.name === null);

console.log('\n--- ids are name-derived, not coordinate-derived ---');
ok('no id contains a row/col', obs.detail.nodes.every((n) => !/\d+[,x]\d+/.test(n.id)));
ok('ids stable across value change', find(obs.typed, 'textbox:account-number') && find(obs.notfound, 'textbox:account-number'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
