# `fixtures/corebank-tui` — the green screen

An 80×24 teller application shaped like a Symitar Episys inquiry screen: a bold branding band, a
rule, reverse-video input fields, a column-headed account list with a reverse-video selected row, an
F-key legend, a status band on row 23 and a screen-name band on row 24. Two tenant variants of one
vendor product, and four injectable fault modes.

> **ALL DATA IS SYNTHETIC.** `AVERY SYNTHETIC`, `BRETT PLACEHOLDER`, `FROZEN TEST ACCT`. Every
> member, name, account number and balance here is invented. Nothing in this fixture is, resembles,
> or is derived from a real person, account or institution.

```bash
pnpm -F @crr/fixture-corebank-tui start                      # drive it by hand in a terminal
TENANT=summit pnpm -F @crr/fixture-corebank-tui start        # the other credit union
pnpm -F @crr/fixture-corebank-tui test                       # 36 tests, no child process, no clock
```

## Why it exists

`@crr/surface-terminal` needs something hostile to drive, and a green screen is hostile in a
*different* way from a frameset web app. There is no DOM, no accessibility tree, no markup at all —
only characters and five attribute bits. Focus is a single hardware cursor. And there is **no load
event**: the only readiness signal a transport offers is silence.

The one thing this fixture must never do is help. No sentinel characters, no invisible markers, no
out-of-band screen id. If it told the driver where the fields were, the terminal surface would prove
nothing about a surface with no clean DOM.

## The flow

```
MEMBER INQUIRY 01                              ACCOUNT LIST 02
  Account Number: [____________]   ENTER  ─→     SUFFIX  DESCRIPTION        BALANCE
  Name Search:    [____________________]          S0001   REGULAR SAVINGS       1,204.55   ← selected
  F3=Exit   TAB=Next Field   ENTER=Search         S0010   VACATION CLUB           310.00
                                                  D0001   FREE CHECKING         2,880.13
                                                F3=Back   UP/DN=Select   ENTER=Open Suffix
```

`12345` and `54321` are on file. Three other account numbers produce the three conditions a replay
engine has to tell apart — and **none of them is a fault**, because each is a fact about the
*request* rather than about the system:

| Input | Status band | Taxonomy |
|---|---|---|
| `77777` | `*** NO MEMBER ON FILE FOR 77777` | a declared business outcome |
| `99999` | `*** SECURITY VIOLATION - TELLER NOT AUTHORIZED` | a permission denial |
| `ABC` | `*** INVALID ACCOUNT NUMBER - NUMERIC ONLY` | a validation error |

Making those faults would have meant the fixture could only produce a business outcome when a test
asked it to, which is precisely backwards.

## The four faults

Armed by flag or environment variable, and scoped to a screen. The registry in
[`src/faults.js`](src/faults.js) carries the SPEC §4.2 row each one is built to produce, so nobody
has to reconstruct later what a scenario was meant to prove — and the test file is driven off that
registry, so **adding a fault without an assertion fails the suite**.

```bash
pnpm -F @crr/fixture-corebank-tui start -- --fault torn-repaint --delay-ms 600
FAULT=session-timeout pnpm -F @crr/fixture-corebank-tui start
```

They come in two families that attach at different points, which is not a detail:

**`delivery` — the bytes are wrong, the app's state is not.** This is the family a browser driver has
no analogue for.

- **`torn-repaint`** delivers the leading 55% of a frame and then falls silent for longer than the
  driver's quiet window. The grid looks settled and is half painted: `screenId: null`, three nodes
  instead of eight. This is the acceptance case for "quiescence proposes; the checkpoint disposes"
  (SPEC §3.3) and the reason the fixture exists at all.
- **`slow-repaint`** holds an entire frame back and then delivers it intact — recoverable inside the
  budget, `did-not-settle` outside it (rows 14/15).

**`transition` — the bytes are perfect, the app went somewhere else.** This family looks identical to
the happy path until something reads the screen-id band.

- **`session-timeout`** lands on the sign-on screen instead. **Sticky**: a session does not un-expire
  because you looked at it. Signing on clears it, so a declared `reauthenticate` recovery can
  actually succeed — a remedy that cannot succeed is worse than no declared remedy.
- **`app-error`** paints a vendor abend screen (`ABEND 0C7 - DATA EXCEPTION`, `TASK MBRINQ`), once.

Timing is **injectable**: `createTellerApp({ schedule, cancel })` takes its own scheduler, so the
tests drive the delivery faults through a manual clock and the timing assertions are exact rather
than flaky.

## The two tenants

Same vendor product, different everything else. Between `riverbend` and `summit` the bank name,
screen title, teller id, both field labels, both field widths, the field row and column, both screen
names and **the exit key** all change — F3 at one, F12 at the other.

That last one is the whole multi-tenant argument. The synthesized node is `button:exit` at both, so
an artifact that says *activate the control named "Exit"* replays unmodified at both credit unions
and needs no overlay; one that said `pressKey(F3)` would be correct at one and wrong at the next.

## Using it programmatically

The app knows nothing about processes. It takes bytes and emits complete ANSI frames, which is what
lets the same object be spawned as a child behind the pipe transport, driven entirely in memory by a
unit test, and used to capture the frozen grids the driver's detector asserts against — all three
producing the same bytes. `test/transport.test.ts` in `@crr/surface-terminal` asserts that
equivalence directly.

```js
import { createTellerApp } from "@crr/fixture-corebank-tui";

const app = createTellerApp({ tenant: "summit", fault: "torn-repaint" });
app.onOutput((chunk) => terminal.write(chunk));   // ANSI frames out
app.start();
app.write("12345\r");                             // keystrokes in
```

`src/main.js` is the only file that touches `process`, and a test asserts that.

It writes ANSI unconditionally and never asks whether stdout is a tty. That is deliberate: a pty
exists to convince a *third-party* binary that it is talking to a terminal so it will emit escape
sequences, and we wrote this one. It is also the more faithful arrangement — real green screens are
reached over telnet/SSH with no client-side pty either.
