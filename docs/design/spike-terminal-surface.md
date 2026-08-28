# Spike: the terminal (green-screen) surface driver

**Status: spike complete. Everything below was run.** Every number, every error string and every
grid dump in this document came out of a command that executed in
`/private/tmp/term-spike` on the machine described in §0. Where something was *not* measured, it says
so. Nothing here is a recollection of how these libraries behave.

**Recommendation, up front:** build it, and build it **without a native module**. The terminal
Surface driver should be `@xterm/headless` (pure JS, zero dependencies, 1.9 MB) reading from a
**byte-stream transport port**, of which `child_process` pipes are the default implementation and
`node-pty` is an optional one the reviewer never has to install. `node-pty` is not merely
inconvenient here — on this exact platform, a fresh install of `node-pty@1.1.0` is **broken out of
the box** (§1.3), and that is reproducible with two commands.

---

## 0. What ran, and where

```text
darwin arm64, macOS 15.6 (24G84)
node v22.22.1   pnpm 10.33.0   npm 10.9.4
Xcode Command Line Tools present at /Library/Developer/CommandLineTools
python3 3.9.6, make/gcc/c++ on PATH
scratch: /private/tmp/term-spike   (nothing in this spike was run inside the repo)
```

> **Toolchain caveat that matters for the recommendation.** This machine has a *complete* native
> build toolchain. Every "node-gyp worked" result below is therefore a **best case** and says nothing
> about a reviewer who has never installed Xcode CLT. The pure-JS result does not have that caveat.

Artifacts produced by the spike, all still on disk:

| Path | What it is | Lines |
|---|---|---|
| `/private/tmp/term-spike/fixture/teller.mjs` | 80x24 green-screen teller fixture (two tenant variants) | 147 |
| `/private/tmp/term-spike/a-xterm/harness.mjs` | transport port + emulator + grid snapshot | 104 |
| `/private/tmp/term-spike/a-xterm/detect.mjs` | grid → typed UINodes (the heuristic) | 261 |
| `/private/tmp/term-spike/a-xterm/test-detect.mjs` | 31 assertions over frozen grids | 62 |
| | **total** | **574** |

All ten files are preserved in [`./spike-terminal-surface/`](./spike-terminal-surface/) with a
README saying how to re-run them; `/private/tmp` does not survive a reboot and these are the receipts
for everything below. They were re-run from that copy, standalone, before this document was
finished.

---

## 1. Library choice

### 1.1 The result

| | `@xterm/headless` 6.0.0 | `node-pty` 1.1.0 | `child_process` + `script(1)` |
|---|---|---|---|
| Role | VT parser + screen buffer | pty allocation | pty allocation, zero deps |
| Native build | **none** | yes (or prebuilt) | none |
| Runtime deps | **0** | 1 (`node-addon-api`) | 0 |
| Installed size | **1.9 MB** | **62 MB** (58 MB of it Windows prebuilds) | 0 |
| `pnpm add` wall time | **0.45 s** | 1.08 s (prebuild path) / 1.86 s (from source) | n/a |
| Prebuilt platforms | n/a | darwin-arm64, darwin-x64, win32-arm64, win32-x64 — **no linux** | n/a |
| Works after a plain `pnpm install` | **yes** | **no** (§1.3) | **no** (§1.4) |

Install timings, verbatim:

```console
$ cd /private/tmp/term-spike/a-xterm && /usr/bin/time -p pnpm add @xterm/headless
+ @xterm/headless 6.0.0
Done in 434ms using pnpm v10.33.0
real 0.45

$ cd /private/tmp/term-spike/b-nodepty && /usr/bin/time -p pnpm add node-pty
+ node-pty 1.1.0
╭ Warning ─────────────────────────────────────────────────────────────────────╮
│   Ignored build scripts: node-pty@1.1.0.                                     │
│   Run "pnpm approve-builds" to pick which dependencies should be allowed     │
│   to run scripts.                                                            │
╰──────────────────────────────────────────────────────────────────────────────╯
Done in 1s using pnpm v10.33.0
real 1.08
```

Both packages were published 2025-12-22, so this repo's `minimumReleaseAge: 10080` (7 days) does not
block either — checked with `npm view <pkg> time --json`.

### 1.2 `@xterm/headless` is the right VT parser and has one packaging wart

It is the parser out of VS Code's terminal, it has **zero runtime dependencies**, and it needs no
DOM. It gave a correct 80x24 grid, cursor position, and per-cell `isInverse()` / `isBold()` /
`isUnderline()` / `getFgColor()` / `getBgColor()` on the first try.

The one wart, which cost ten minutes and would cost a reviewer the same:

```console
$ node -e "import('@xterm/headless').then(m=>m.Terminal)"
SyntaxError: Named export 'Terminal' not found. The requested module '@xterm/headless'
is a CommonJS module, which may not support all module.exports as named exports.
```

v6.0.0 ships **no `exports` map**, and its `module` field points at `lib/xterm.mjs`, which is not in
the tarball — the installed package root holds only `lib-headless/`, `package.json`, `README.md` and
`typings/`. So Node resolves the bare specifier through `main` to the CommonJS build and named ESM
imports fail. Two things work:

```ts
// (a) what the driver should use - resolves through `main`, survives the package
//     gaining an `exports` map later:
import xtermPkg from '@xterm/headless';
const { Terminal } = xtermPkg;

// (b) the real ESM build, verified to give a true named export, but a deep subpath
//     that an `exports` map would break:
//     import { Terminal } from '@xterm/headless/lib-headless/xterm-headless.mjs';  // OK Terminal: function
```

Use (a), with a one-line comment so nobody "fixes" it back.

### 1.3 `node-pty` 1.1.0 is broken out of the box on darwin-arm64 — verified

This is the finding that decides the spike.

```console
$ pnpm add node-pty        # or: npm install node-pty
$ node -e "import('node-pty').then(p=>p.spawn('/bin/echo',['hi'],{cols:80,rows:24}))"
Error: posix_spawnp failed.
    at new UnixTerminal (.../node-pty/lib/unixTerminal.js:92:24)
```

Root cause, and it is in the **published tarball**, not in pnpm:

```console
$ curl -sL "$(npm view node-pty@1.1.0 dist.tarball)" -o np.tgz && tar tvzf np.tgz | grep spawn-helper
-rw-r--r--  0 0 0  50480 Oct 26  1985 package/prebuilds/darwin-arm64/spawn-helper
-rw-r--r--  0 0 0   9248 Oct 26  1985 package/prebuilds/darwin-x64/spawn-helper
```

`spawn-helper` is an **executable that ships without the executable bit** (mode 0644), and nothing in
the install chain chmods it: `scripts/prebuild.js` only checks that `prebuilds/darwin-arm64/` exists
and exits 0, and `scripts/post-install.js` only cleans `build/Release` and copies conpty DLLs on
Windows. Confirmed by running the scripts in the foreground:

```console
$ npm rebuild node-pty --foreground-scripts
> node scripts/prebuild.js || node-gyp rebuild
> Checking prebuilds...
> node scripts/post-install.js
> Cleaning release folder...
> Moving conpty.dll...  SKIPPED (not Windows)
rebuilt dependencies successfully
$ ls -l node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
-rw-r--r--  1 devlegacy  wheel  50480 ... spawn-helper      # still not executable
```

`chmod +x` fixes it immediately (`SPAWN OK exit=0 data="hello-from-pty\r\n"`), which confirms the
diagnosis — but a fix a user has to apply by hand is not a fix.

Three further facts, each of which independently would have been enough:

1. **`pnpm approve-builds` does not help.** With `pnpm.onlyBuiltDependencies: ["node-pty"]` the
   install scripts *do* run, the prebuild path is taken, nothing is compiled, and `spawn-helper`
   stays 0644. Only `npm_config_build_from_source=true` — which deletes the prebuilds and invokes
   node-gyp — produces a working install (`-rwxr-xr-x`, `OK "built-from-source\r\n"`), and that
   requires the toolchain this machine happens to have.
2. **The fix does not survive an unrelated install.** After `chmod +x`, running `pnpm add
   @xterm/headless` in the same project re-linked `node-pty` from the content-addressable store and
   the app broke again with `posix_spawnp failed`. A manual chmod is not a durable remedy in a pnpm
   workspace.
3. **There are no Linux prebuilds at all.** `prebuilds/` contains only `darwin-arm64`, `darwin-x64`,
   `win32-arm64`, `win32-x64`. Any Linux CI runner compiles from source, so `pnpm test` in CI would
   depend on python3 + a C++ toolchain being present.

Build-from-source timing on this machine, for completeness (best case, toolchain already installed):

```console
$ npm_config_build_from_source=true /usr/bin/time -p npm install node-pty --foreground-scripts
  CXX(target) Release/obj.target/pty/src/unix/pty.o
  SOLINK_MODULE(target) Release/pty.node
  LINK(target) Release/spawn-helper
gyp info ok
added 2 packages in 2s
real 1.86
```

Compilation itself is fast. That is not the problem. The problem is that it is one of several ways
this dependency can be in a state where `pnpm install && pnpm demo` does not work, and the assignment
is graded partly on the reviewer being able to run the thing.

### 1.4 `child_process` + `script(1)` as a zero-dependency pty: does not work from Node

The obvious trick — let the system's `script(1)` allocate the pty for you — works from a shell:

```console
$ /usr/bin/script -q /dev/null /bin/sh -c 'stty rows 24 cols 80 -echo; echo SCRIPT_WORKS; tty; stty size' < /dev/null
SCRIPT_WORKS
/dev/ttys026
24 80
```

and fails from Node, every way it was tried:

```console
$ node -e "spawn('/usr/bin/script',['-q','/dev/null','/bin/sh','-c','echo hi'],{stdio:['pipe','pipe','pipe']})"
script: tcgetattr/ioctl: Operation not supported on socket
```

Node's `stdio: 'pipe'` is a **socketpair** on POSIX, and BSD `script` calls `tcgetattr` on its own
stdin. Substituting a FIFO (`mkfifo` + `fs.openSync(..., 'r+')`) produced the *same* error; giving it
a regular file for stdout and a FIFO for stdin produced the same error; wiring FIFOs on both ends
hung. `/usr/bin/expect` exists on macOS 15 but is absent on most Linux base images and would mean
maintaining a Tcl bridge. **Verdict: dead end, documented so nobody spends an afternoon on it.**

### 1.5 The decision this actually forces: pty is a transport, not the architecture

The right question turned out not to be "which pty library" but **"why does the driver need a pty at
all?"**

A pty is only required when you must convince a *third-party binary* that it is talking to a
terminal, because it gates its ANSI output on `isatty()`. Two observations:

- **Real green screens are not local subprocesses.** Symitar Episys, AS/400 5250, mainframe 3270 —
  these are reached over **telnet / SSH / TN3270**, i.e. a **socket**. There is no pty on the client
  side at all. A driver whose only transport is a pty is modelling the *demo*, not the target.
- **Our fixture is ours.** `fixtures/corebank-tui` can emit ANSI unconditionally, because we write
  it. It does not need to be lied to about `isatty()`.

So the driver's lowest layer is a **`TerminalTransport` port** — "something that takes bytes and
emits bytes" — and the emulator sits above it, unaware:

```ts
interface TerminalTransport {
  write(bytes: string | Buffer): void;
  onData(cb: (chunk: Buffer) => void): void;
  close(): void;
}
```

Implementations: `pipe` (ships, zero deps), `socket` (the real-world one, trivial), `node-pty`
(**optional peer dependency**, present only for driving a hostile third-party local binary).

The claim that this is architecturally free rather than a compromise was measured, not asserted —
see §2.3.

---

## 2. End-to-end proof

### 2.1 The fixture

A 147-line 80x24 teller screen in the shape of an Episys inquiry: bold banner row, labelled fields
marked with **reverse video**, a column-headed account list with a **reverse-video selected row**, an
F-key legend, a status line at row 23 and a screen-name line at row 24. Two tenant variants of the
same vendor product, switched by `TENANT=riverbend|summit`. All data is obviously synthetic
(`AVERY SYNTHETIC`).

### 2.2 Driving it

`run-pipe.mjs` spawns the fixture, writes keystrokes, and dumps the grid after each. Real output,
including the attribute map (`R` = reverse video, `B` = bold), abridged to the non-blank rows:

```text
=== 1. initial screen   [transport=pipe] (t+77ms, 503 bytes total) ===
  0 |  RIVERBEND CU        MEMBER INQUIRY                       TELLER 04
  1 |================================================================================
  3 |  Enter an account number OR a name fragment, then press ENTER.
  5 |  Account Number:
  7 |  Name Search:
 10 |  F3=Exit   TAB=Next Field   ENTER=Search
 23 | MEMBER INQUIRY 01
    cursor = (row 5, col 21)
    attribute map (R = reverse video, B = bold):
  0 |BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB|
  5 |  ....... .......    RRRRRRRRRRRR|
  7 |  .... .......       RRRRRRRRRRRRRRRRRRRRRRRRRRRR|

=== 2. type "12345" into the focused field ===
  5 |  Account Number:    12345
    cursor = (row 5, col 26)

=== 3. TAB (focus moves to Name Search) ===
    cursor = (row 7, col 21)          <-- the ONLY signal that focus moved

=== 4. TAB back + ENTER -> member detail ===
  3 |  Member:  12345   AVERY SYNTHETIC
  5 |  SUFFIX  DESCRIPTION        BALANCE
  6 |   S0001   REGULAR SAVINGS       1,204.55
  7 |   S0010   VACATION CLUB           310.00
  8 |   D0001   FREE CHECKING         2,880.13
 23 | ACCOUNT LIST 02
    attribute map:
  5 |  BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB|    <- header, bold
  6 |  RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR|                   <- selection, reverse

=== 5. cursor-down x2 ===       selected row moves to D0001
=== 8. type 77777 + ENTER ===  22 | *** NO MEMBER ON FILE FOR 77777
=== 9. 99999 + ENTER ===       22 | *** SECURITY VIOLATION - TELLER NOT AUTHORIZED
=== 10. ABC + ENTER ===        22 | *** INVALID ACCOUNT NUMBER - NUMERIC ONLY
```

That is the full three-way error taxonomy (business outcome / permission denial / validation error)
visible on a character grid, which is what makes this surface worth having: it exercises the same
classifier code as the browser driver against a completely different perception mechanism.

### 2.3 The transports produce byte-identical observations

The same ten-step script was run through the `pipe` transport and through `node-pty` (after
`chmod +x`), serialising all nine grids — every cell, every attribute, the cursor — to JSON:

```console
$ shasum -a 256 grids-pipe.json grids-nodepty.json
75f98c32abe507c09e9c1c9becacb7f3b13995214bed77c70cc7ad89f0ab62c9  grids-pipe.json
75f98c32abe507c09e9c1c9becacb7f3b13995214bed77c70cc7ad89f0ab62c9  grids-nodepty.json
identical: true | bytes: 1278449 1278449
  initial SAME   typed SAME   tabbed SAME   detail SAME   arrowed SAME
  opened SAME    notfound SAME   denied SAME   invalid SAME
```

**The transport is not observable above the emulator.** Shipping the pipe transport and leaving
`node-pty` as an optional peer costs nothing in fidelity. That is the evidence for §1.5.

### 2.4 Two pty facts that a pipe hides, and that would have burned a day

Getting node-pty to parity required both of these, neither of which is in node-pty's README:

- **ECHO is on by default.** The first node-pty run put `12345` at row 0 col 0 — the pty line
  discipline echoed every keystroke back into the output stream, and it landed in the grid.
- **ICANON is on by default.** After `stty -echo` alone, keystrokes were *line-buffered* and the app
  received nothing until ENTER. `settle timeout (bytes=503 want>503)` — the app never repainted.

Both are cleared by spawning `sh -c 'stty raw -echo; exec <app>'`. On a socket transport to a real
Episys the equivalent is telnet option negotiation (`WILL SGA`, `WILL ECHO`), which is the same class
of problem in a different vocabulary — and another reason the transport deserves to be a port.

---

## 3. From character grid to typed UINodes

### 3.1 The Observation type this surface produces

```ts
interface Cell { ch: string; inverse: boolean; bold: boolean; underline: boolean; fg: number; bg: number }
interface Grid { cols: number; rows: number; cells: Cell[][]; cursor: { x: number; y: number } }

// detect(grid) -> { screenId, cursor, nodes }
```

`detect()` is a **pure function of a frozen `Grid`** — no I/O, no clock, no terminal handle. This is
the same property the browser driver's AX-tree normaliser has, and it is what makes the whole error
taxonomy unit-testable from JSON fixtures with nothing running.

### 3.2 The heuristic, in order

1. **Run segmentation.** Scan each row left→right and group consecutive cells with an identical
   attribute signature (`inverse|bold|underline|fg|bg`) into maximal runs. A run is the atomic unit;
   nothing below ever looks at an individual cell.
2. **Derive "plain", never hardcode it.** The attribute covering the most cells on the screen is the
   background convention. Everything else is *marked*. An app that marks fields with underline or a
   colour instead of reverse video needs no code change to be segmented correctly.
3. **Attribute semantics — the one VT convention assumed, stated openly.**
   `reverse video` ⇒ an operator-writable field, or the selected row of a list.
   `bold`/`underline` ⇒ emphasis: a column header, a screen title, a read-only value.
   An app that breaks this gets a **per-tenant overlay hint**, not a detector rewrite.
4. **Label anchoring.** For each marked run, take the nearest text to its left on the same row within
   12 columns of whitespace; failing that, the text directly above spanning the same columns. Strip
   trailing `:`/`.`/`_`. That string becomes the node's accessible name.
5. **Field vs. list row — structure, not width.** A wide reverse run is ambiguous: a 28-column input
   field and a 45-column selected list row look the same. Discriminate structurally: **a list row has
   no label to its left and has at least one sibling row of data at the same column extent.** Width
   alone gets `Name Search` wrong; this rule does not.
6. **Focus = the hardware cursor.** A VT screen exposes exactly one focus signal, the cursor
   position. The focused field is the run whose column span contains `cursor.x` on `cursor.y`
   (inclusive of one past the end, because you type at the end of a field).
7. **Columns from the data, not the header.** Compute the columns that are blank in *every* row of
   the block (header included); runs of ≥2 such columns are gutters; the spans between them are the
   columns, named by the header text overlapping each span. Slicing by header width instead silently
   truncates right-aligned numerics — this exact bug produced `BALANCE: "1,2"` before the fix and
   `BALANCE: "1,204.55"` after it.
8. **F-key legend → activatable controls.** `F3=Exit`, `ENTER=Open Suffix` become
   `{ role: 'button', name: 'Exit', key: 'F3' }`. This is the whole reason the terminal surface can
   share an artifact schema with the browser: a step says *activate the control named "Open Suffix"*,
   and the driver — not the artifact — decides that means sending `\r`.
9. **Screen identity.** The bottom band carries the screen name/number (`MEMBER INQUIRY 01`). This is
   this surface's equivalent of a URL and is what a checkpoint anchors on.
10. **Status band is reported, never interpreted.** The detector emits
    `{ role: 'status', value: '*** NO MEMBER ON FILE FOR 77777', name: null }` and stops. Deciding
    that this means `MEMBER_NOT_FOUND` belongs to the artifact's **declared** outcome detector
    (BRIEF §3.3). A detector that classified business meaning would put the error taxonomy in the
    driver, where it cannot be reviewed, versioned or overlaid per tenant.
11. **Ids are name-derived, never coordinate-derived.** `textbox:account-number`, not `textbox:5,21`.
    A grid coordinate is this surface's CSS selector, and BRIEF §3.7 forbids storing one. Coordinates
    live in `bounds` and are only ever the lowest-ranked descriptor at resolve time.

### 3.3 It works — 31 assertions, 0 failures

```console
$ node test-detect.mjs
--- screen identity ---            PASS inquiry screen id / detail screen id
--- fields, labels, capacity ---   PASS two textboxes / labelled / capacity 12 / capacity 28
--- focus follows the cursor ---   PASS focus starts on account, moves on TAB, value read back
--- function-key legend ---        PASS three controls, Exit is F3, Search is ENTER
--- list, columns, selection ---   PASS one list, three rows, columns ["SUFFIX","DESCRIPTION","BALANCE"],
                                        balance not truncated, selection tracks cursor-down
--- read-only values ---           PASS member id read as text node
--- status line ---                PASS three distinct status texts, none on happy path,
                                        detector assigns no meaning (name === null)
--- ids ---                        PASS no id contains a coordinate, ids stable across value change
31 passed, 0 failed
```

Sample output on the inquiry screen:

```json
{"id":"textbox:account-number","role":"textbox","name":"Account Number","value":"","capacity":12,
 "state":{"focused":true,"empty":true},
 "anchor":{"kind":"label","text":"Account Number","at":"left"},
 "bounds":{"row0":5,"row1":5,"col0":21,"col1":32}}
{"id":"button:search","role":"button","name":"Search","key":"ENTER",
 "bounds":{"row0":10,"row1":10,"col0":29,"col1":40}}
```

and on the detail screen:

```json
{"id":"list:suffix-description-balance","role":"list","columns":["SUFFIX","DESCRIPTION","BALANCE"],
 "children":[
   {"role":"listitem","index":0,"cells":{"SUFFIX":"S0001","DESCRIPTION":"REGULAR SAVINGS","BALANCE":"1,204.55"},
    "state":{"selected":true,"focused":true}}, ...]}
```

Note `capacity: 12` — the field's declared width falls straight out of the grid and becomes the
`maxLength` of the capability's typed parameter. The browser surface has to work to get that.

### 3.4 The multi-tenant result, which is better than expected

Same fixture, `TENANT=summit`: different bank name, different screen title, labels shortened
(`Account Number:` → `Acct #:`), fields moved two columns left and one row down, widths changed
12→10 and 28→24, and the exit key changed **F3 → F12**.

```text
riverbend: heading:riverbend-cu heading:member-inquiry heading:teller-04
           textbox:account-number textbox:name-search
           button:exit button:next-field button:search
summit:    heading:summit-fcu    heading:mbr-inq       heading:tlr-17
           textbox:acct          textbox:search-name
           button:exit button:next-field button:search

shared 3/8 -> divergence 63%      (all nodes, branding included)
interactive-only: shared 3/5 -> divergence 40%
control "Exit" keystroke: F3 (riverbend) vs F12 (summit)  -- same node id, different key
```

Three things fall out of this, all of them load-bearing for REPORT §4:

- **The structure survives a full relayout.** Not one coordinate matched, and the detector recovered
  the same two fields, the same three controls, the same roles and the same capacities.
- **`button:exit` is identical across tenants although the keystroke changed.** An artifact step that
  says *activate the control named "Exit"* replays unmodified on both tenants; the driver resolves
  `F3` vs `F12` from the legend at replay time. **That is a per-tenant difference that needs no
  overlay at all** — which is exactly the argument the assignment asks for in §3.7.
- **The two label changes are precisely what an overlay is for**, and the divergence number is a real
  signal, not a slogan. It also shows that *what you fingerprint matters*: 63% if you include the
  branding band, 40% over interactive nodes only. The fingerprint should cover interactive nodes and
  the screen id, and deliberately exclude the branding band. Writing that down is worth more than the
  number.

### 3.5 Where the heuristic is weak — stated plainly

- **Unlabelled plain-text values are invisible.** On `Member:  12345   AVERY SYNTHETIC`, the detector
  emits `text:member = "12345"` and does **not** emit the name, because nothing anchors it. The
  honest fix is not more heuristics; it is letting the artifact declare a positional read anchored to
  a label (*"the field two gutters right of the label `Member`"*), resolved with the same gutter
  primitive from step 7. Not built in this spike.
- **The `reverse = input` convention is an assumption.** It is correct for VT/Episys-shaped apps and
  wrong for some 3270 emulators that use colour. Step 2 makes the *segmentation* convention-free but
  step 3 does not make the *classification* convention-free. The mitigation is an overlay hint
  (`fieldAttr: "underline"`), which is the same mechanism as every other per-tenant override.
- **Multi-line fields and horizontally scrolled fields are not handled.** Neither appears in Episys
  inquiry screens; both would need a real design.
- **Double-width / CJK cells are not handled.** `getWidth()` is available and ignored.

---

## 4. The one thing that would go wrong in production: readiness

A character-cell surface has **no load event**. The only readiness signal the transport offers is
quiescence — "no bytes for N ms". That is not sound, and the spike shows it failing rather than
asserting that it might:

```console
$ node tear.mjs        # deliver 55% of a repaint, then wait 120ms (> the 60ms quiet window)
--- snapshot taken after 120ms of silence, mid-repaint ---
  0 |  RIVERBEND CU        MEMBER INQUIRY                       TELLER 04
  3 |  Enter an account number OR a name fragment, then press ENTER.
  5 |  Account Number:
  screenId: null
  nodes: heading:riverbend-cu, heading:member-inquiry, heading:teller-04

--- after the rest of the repaint arrives ---
  screenId: "MEMBER INQUIRY 01"
  nodes: heading:riverbend-cu, heading:member-inquiry, heading:teller-04,
         textbox:account-number, textbox:name-search,
         button:exit, button:next-field, button:search

VERDICT: quiescence alone yielded a DIFFERENT observation -> true
```

A torn read produced `screenId: null` and 3 nodes instead of 8. The design conclusion is clean and
it is the same one the browser driver reaches by a different road:

> **Quiescence proposes; the checkpoint disposes.** `settle()` is a *cheap trigger* for taking an
> observation, never evidence that the screen is ready. Readiness is `screenId === expected` plus the
> step's declared `expect` — and note that the torn snapshot **fails that test**, which is why it is
> a detected condition rather than a silent misread. A `settle` that times out with no bytes is a
> hard failure (`settle timeout (bytes=503 want>503)`), because a green screen that returns nothing
> is indistinguishable from a hung one.

This is a strictly *better* story than the browser's, and it should be said in REPORT §3: the
terminal surface has no `networkidle` to hide behind, so it forces the checkpoint to be the real
readiness gate. If the design works here, the browser case is the easy one.

---

## 5. Cost

### 5.1 Measured performance

```console
$ node bench.mjs
detect(grid)          275.0 us/call   (2000 iterations)
snapshot(term)         36.9 us/call   (2000 iterations)
term.write(1 repaint) 1328.1 us/call   (503 bytes x 500)
rss=107.0MB heapUsed=9.9MB (one 80x24 emulator, scrollback 0)
```

Two caveats, both honest. `term.write` is asynchronous and this figure includes draining xterm's
write queue, so it is a **latency per repaint**, not parser throughput. And these are single-run
figures on a laptop: a second run of the same file gave `detect 292.7us / snapshot 36.9us /
write 1299.1us`, so treat them as ~±10%, not as a benchmark. At roughly 1.3 ms per full-screen
repaint and 0.3 ms to build an Observation, perception is not a bottleneck for a surface that
repaints once per keystroke. Nothing about scaling to many concurrent sessions was measured.

### 5.2 Effort estimate

Honest, and calibrated against the 574 lines that already exist and run.

| Piece | Estimate | Confidence | Notes |
|---|---|---|---|
| `TerminalTransport` port + pipe impl | 0.5 day | high | 40 lines exist and work |
| Emulator + `Grid` snapshot | 0.5 day | high | 60 lines exist and work |
| `detect()` → `Observation` | **1.5 days** | medium | 261 lines exist at 31/31; port to TS, type it, handle the §3.5 gaps |
| `act(Action)`: key/type/activate-by-name + settle + checkpoint gate | 1 day | medium | key-name→byte-sequence table is fiddly and boring |
| `fixtures/corebank-tui` with fault injection | **1.5 days** | medium | 147 lines exist; needs session timeout, slow load, app error, unexpected dialog, second tenant |
| Frozen-grid fixtures + detector unit tests | 0.5 day | high | mechanical once grids are captured |
| Wiring into the Surface contract test + conformance suite | 0.5 day | medium | the point of the whole exercise |
| **Total** | **~6 days** | | plus ~1 day of integration friction that always shows up |

The estimate assumes the `Surface` port, the artifact schema and the replay engine already exist. If
the terminal driver is built *first*, it will be slower and the port will be better for it.

### 5.3 The cheapest viable version — and it is genuinely cheap

If time runs short, cut in this order and stop wherever the budget runs out. Each rung is honest on
its own.

**Rung 1 — ~1.5 days, and this is the one I would defend.**
- Keep `fixtures/corebank-tui` at the two screens that already work (inquiry → account list), with
  the three status outcomes already implemented (`NO MEMBER ON FILE`, `SECURITY VIOLATION`,
  `INVALID ACCOUNT NUMBER`), plus a `--slow` flag and a `--session-timeout` flag. That is four fault
  modes for about twenty lines, because the fixture is ours.
- Keep the `pipe` transport only. Document `node-pty` as an optional peer, with §1.3 as the reason.
- Ship `detect()` as-is, ported to TypeScript.
- Support exactly four actions: `type`, `key`, `activateControlNamed`, `readValueOf`.
- Ship **one** recorded artifact that replays on the terminal surface, and run it through the same
  replay engine and the same conformance scenarios as the browser artifact.

That yields the sentence the assignment is really asking for, and yields it as a *demonstrated* fact:
**the same replay engine, the same artifact schema and the same error taxonomy drive a browser and a
character grid, and the engine cannot tell which.**

**Rung 2 — +1 day.** Frozen-grid fixtures committed as JSON, so the terminal branch of the
conformance suite runs with no child process at all. Cheap, and it makes the terminal surface *free*
in CI.

**Rung 3 — +1 day.** Second tenant variant (`TENANT=summit` already works) and a cross-tenant replay
with an overlay carrying the two label aliases. This is the strongest single piece of evidence for
REPORT §4, and it costs a day because the fixture variant already exists.

**Cut without regret:** cursor-key list navigation beyond what exists, multi-line fields, colour-based
field detection, a TN3270/telnet transport, terminal resize handling, and any attempt to make
`node-pty` a first-class dependency.

---

## 6. Recommendation

**Build the terminal surface. Do not take a native dependency to do it.**

1. `@xterm/headless` for VT parsing and the screen buffer. Pure JS, zero deps, 1.9 MB, installs in
   0.45 s, and needed no workaround beyond the CJS default-import in §1.2.
2. A `TerminalTransport` port, with `child_process` pipes as the shipping implementation. `node-pty`
   stays an **optional peer dependency**, documented with §1.3 so the choice reads as a decision
   rather than an omission. §2.3 shows the two transports produce byte-identical observations, so
   this costs nothing.
3. `detect()` as specified in §3, kept a pure function of a frozen `Grid`, reporting structure and
   never business meaning.
4. Readiness is the checkpoint, not quiescence (§4).

The strongest reason to build it is not that it is cheap, although at ~1.5 days for rung 1 it is. It
is that **the terminal surface is the falsification test for the `Surface` port.** A port that only
ever had a Playwright implementation behind it is a claim; a port that has an 80x24 character grid
behind it — no DOM, no accessibility tree, no selectors, focus expressed solely as a cursor position,
readiness expressed solely as silence — is a demonstrated boundary. That is precisely the difference
the assignment is grading when it says "judgment and integration", and it is the difference between
answering §3.7 with a paragraph and answering it with a running second driver.

The one thing that would change this recommendation: if the terminal driver cannot be made to fit the
`Surface` port **without widening the port**, the port is wrong and the finding is more valuable than
the driver. That did not happen in this spike — `perceive()` returns the same `Observation` shape and
`act()` needs no new action kinds beyond a `key` action the browser surface also wants — but it is
the thing to watch for during the build.
