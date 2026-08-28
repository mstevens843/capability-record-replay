# `@crr/surface-terminal` — the falsification test for the `Surface` port

An 80×24 character grid behind the same four methods a browser sits behind. No DOM, no accessibility
tree, no selectors; focus is a cursor position and readiness is silence.

This package exists to answer one question, and the answer is the deliverable:

> **Does the `Surface` port describe a surface, or does it describe a browser?**

A port that has only ever had a Playwright implementation behind it is a claim. This is the second
implementation, and everything below was measured against it rather than reasoned about.

```bash
pnpm -F @crr/surface-terminal test        # 119 tests, no browser, no credential
pnpm -F @crr/fixture-corebank-tui test    # 36 tests, the green screen it drives
```

---

## The verdict: the port holds, with three findings

**It fits.** The interpreter, the classifier, the descriptor kinds, the extractor, the checkpoint and
the result contract needed **no widening at all**. `test/observe.test.ts` runs `@crr/core`'s own
resolver, extractor and predicate evaluator against observations taken off a green screen and they
neither know nor care which surface produced them.

Four things had to hold. Each is asserted, and each is marked `[P1]`–`[P4]` in `src/observe.ts`:

| | What the port needed | How it was met |
|---|---|---|
| **P1** | A location that is not a URL | The screen-id band travels as a `screen` **container segment**, a `ContainerKind` SPEC §2.2 already had. `route` is `null` and `navigate` is not advertised, so linker check 17 refuses a program that needs a route *before anything is spawned*. |
| **P2** | An account list that a `table-cell` descriptor can address | The block is emitted as `table` + `row` + `cell` with a real `tablePosition`, not as `list`/`listitem`. `resolveCell` finds `D0001`'s balance, and `readTable` reads the whole grid through the contract's declared table type. `headerProvenance` is `first-row-heuristic`, honestly — the header is bold text above a block, and nothing declared it. |
| **P3** | A label a `label-anchored` descriptor can anchor on | A prompt is emitted as its own `text` node with its own extent, and the labelled control points at it through `labelledBy`. Without this the driver would advertise a descriptor kind it cannot honour. |
| **P4** | Per-node confidence | `detect.ts` scores every node on whether its identity was **read** off the screen or **inferred** from position. `confidenceFloor` is `0.6` and sits between the two clusters, so a descriptor resting on an unanchored reverse-video run abstains instead of voting. |

### Finding 1 — on a green screen, `role-name` and `label-anchored` are the *same* evidence

This is the most useful thing this package found, and it is a **finding, not a defect**.

In an accessibility tree a control's accessible name can come from an `aria-label` that is not the
visible prompt, so those two descriptors can genuinely be two independent readings. On a character
grid there is no name but the prompt: the detector *derived* the name from the label. So the two
descriptors read the same words off the same screen, and one relabelling kills both.

`@crr/core`'s quorum sees that — `evidenceKey` collapses them — and **refuses**:

```
underdetermined: 2 descriptors agreed but they rest on 1 independent piece(s) of evidence,
                 and 2 are required
```

Both descriptors resolved, both picked the same node, and the run still refuses. That is SPEC §0
decision 5 working exactly as designed on a surface it was not written for.

**The consequence for unit 14:** a target derived on a terminal recording needs a third descriptor
whose evidence is *not* the label — `ordinal-in-container` or `geometric`. With one added, the same
target resolves (`test/observe.test.ts`, "resolves once a STRUCTURALLY independent descriptor is
added"). That is a real constraint on `deriveDescriptors`, and it fell out of the port rather than
out of a rule somebody remembered to write down.

### Finding 2 — `ActFault.not-actionable.why` is browser-shaped

There is no addressable focus on a character surface. A browser focuses a node by naming it; a green
screen has one cursor and one portable way to move it, which is Tab. So `focus` here is a **bounded
walk** — press Tab, look, press Tab — and it can fail.

The port anticipated the *shape* of this ("making a node actionable is the SURFACE's obligation
before it acts") and the failure is genuinely `not-actionable`. But the closest `why` member is
`off-screen-unscrollable`, which is a browser word for "the Tab cycle does not visit this field".
**Right arm, wrong noun.** The honest fix is a `why: "unreachable"` member; the driver uses the
nearest existing one and says so at the call site rather than pretending the fit is exact.

### Finding 3 — `click` means "press this tenant's key", and that is the port working

`activate` lowers to `click` at the port (the linker's `actionKindsFor`). This driver reads a click
on a control as "press the key its legend binds" and a click on a row as "walk the selection onto
it". The action's *name* is browser-flavoured where its semantics are not — but the mechanism is
exactly what SPEC §2.2 argued for when it put F1–F12 at the port and kept them out of the artifact,
and it buys the multi-tenant result below.

**Two absences, reported rather than faked:** there is no native dialog channel (an interstitial on
this surface is a message painted into the grid, so it arrives as an ordinary node and a declared
recovery handles it) and no route. Both become load-time refusals instead of runtime surprises.

---

## The two results worth quoting

### Quiescence proposes; the checkpoint disposes

A character surface has **no load event**. The only readiness signal the transport offers is
silence, and silence is not evidence: an application that stalls halfway through a repaint is silent
in exactly the way one that has finished is silent.

`test/torn-read.test.ts` reproduces that on demand through the fixture's `torn-repaint` fault:

```
torn read     screenId: null              3 nodes    settled: true    checkpoint: FAILS
whole frame   screenId: "MEMBER INQUIRY 01"  8 nodes    settled: true    checkpoint: PASSES
```

Both observations claim `settled: true`. Only one of them is the screen the step was waiting for,
and the step's declared checkpoint is what separates them. **Raising the quiet window is not the
fix** — no window is sound, because the application can always pause for longer than it. This is a
strictly better story than the browser's, which has a `networkidle` to hide behind.

### One artifact, two credit unions, no overlay for the key

Between `riverbend` and `summit` the branding, screen names, field labels, field widths, field
positions and exit key all change, and **not one coordinate matches**. The detector recovers the
same two fields, the same three controls, the same roles and the same capacities
(`test/tenants.test.ts`):

```
riverbend: heading:riverbend-cu heading:member-inquiry heading:teller-04
           textbox:account-number textbox:name-search
           button:exit button:next-field button:search      Exit -> F3
summit:    heading:summit-fcu    heading:mbr-inq       heading:tlr-17
           textbox:acct          textbox:search-name
           button:exit button:next-field button:search      Exit -> F12

divergence, all nodes:         63%
divergence, interactive only:  40%
```

`button:exit` is the **same node id on both** and the key behind it is not. A step that says
*activate the control named "Exit"* replays unmodified at both; a step that said `pressKey(F3)`
would be correct at one and wrong at the next. That is a per-tenant difference that needs **no
overlay at all**. The two label changes are what an overlay *is* for.

Both divergence numbers are reproduced from the spike, and the pair is the point: what you
fingerprint decides what you conclude. Include the branding band and these look like two
applications; cover interactive nodes plus the screen id and they look like one application with a
vocabulary overlay, which is what they are.

---

## The two dependency decisions

Both were measured in `docs/design/spike-terminal-surface.md` and both are asserted in
`test/barrel.test.ts` so they cannot drift back.

**`@xterm/headless`, and no native module.** Pure JavaScript, zero runtime dependencies, 1.9 MB, no
build step — `pnpm install` works for a reviewer with no toolchain. `node-pty@1.1.0` is **not a
dependency of this package at any version**: it ships `spawn-helper` without the executable bit and
is broken out of the box on darwin-arm64, `pnpm approve-builds` does not fix it, a manual `chmod +x`
does not survive the next unrelated install, and it has no Linux prebuilds at all.

One packaging wart, asserted because the fix looks like a mistake and gets "corrected":

```ts
import xtermPkg from "@xterm/headless";   // v6.0.0 ships NO exports map;
const { Terminal } = xtermPkg;            // a named ESM import throws at load.
```

**A `TerminalTransport` port underneath.** Real green screens — Symitar Episys, 5250, 3270 — are
reached over telnet/SSH/TN3270, which is a **socket with no client-side pty anywhere**. A pty-only
driver models the demo, not the target. `pipe` ships; `memory` is what the tests use; `socket` is a
documented seam (~20 lines over `net.Socket` plus telnet option negotiation, which is the
socket-shaped version of the `stty raw -echo` a pty needs).

That the port costs nothing in fidelity is measured twice.  The spike serialized nine grids through
a pipe and through a real `node-pty` and got the same sha256 over 1.28 MB. Here,
`test/transport.test.ts` spawns the fixture as a real child process and asserts the resulting grid
is **byte-identical to the committed one the in-memory harness produced**.

---

## How it works

```
transport (bytes)  →  @xterm/headless  →  Grid  →  detect()  →  DetectedScreen  →  observationOf()  →  Observation
   pipe | memory        emulator.ts      grid.ts   detect.ts      (pure)             observe.ts        (core's type)
```

`detect()` and `observationOf()` are **pure functions of frozen data**. That is why 15 committed
grids in `test/fixtures/grids.json` carry the whole perception layer's test suite with nothing
running, and why a production misread becomes a unit test by saving one file.

The heuristic, in order, is documented at the top of `src/detect.ts`. Two steps are the ones that
are easy to get wrong:

- **Step 5 — field versus list row is decided STRUCTURALLY, never by width.** A 28-column input
  field and a 45-column selected list row are both "wide reverse video". A list row has no label to
  its left and has at least one sibling row at the same column extent. Width alone gets
  `Name Search` wrong.
- **Step 7 — column boundaries come from the DATA's blank gutters, never from the header's width.**
  A right-aligned numeric column overflows its header: slicing by header width produced
  `BALANCE: "1,2"` and gutter detection produces `"1,204.55"`. On an account list a truncated
  balance is a wrong number read to a member.

And one rule that is not a heuristic — **driver rule D9**: this driver reports structure and never
business meaning. `*** NO MEMBER ON FILE FOR 77777` becomes `{ role: "status", value: "…", name:
null }` and stops. Deciding that it means `MEMBER_NOT_FOUND` belongs to the artifact's declared
outcome detector, where it can be reviewed, versioned, diffed and overridden per tenant.

### Regenerating the frozen grids

```bash
pnpm -F @crr/surface-terminal exec tsx test/support/capture-grids.ts
```

The corpus is committed rather than generated at test time, so a change to the fixture that changes
what the driver sees shows up as a reviewable diff instead of a green test. The compact encoding is
asserted **lossless** cell for cell over every grid (`test/grid-codec.test.ts`), because a fixture
format that quietly dropped an attribute would corrupt every assertion built on it while staying
green.

## Known gaps, stated

- **Unlabelled plain-text values are invisible.** On `Member:  12345   AVERY SYNTHETIC` the detector
  emits `text:member = "12345"` and does not emit the name, because nothing anchors it. The honest
  fix is a declared positional read anchored to a label, using the same gutter primitive as step 7.
  Not built.
- **`reverse video ⇒ input` is a convention**, correct for VT/Episys-shaped apps and wrong for some
  3270 emulators that use colour. Segmentation is convention-free (step 2 *derives* what "plain"
  means); classification is not. The mitigation is an overlay hint, the same mechanism as every
  other per-tenant override.
- **Multi-line fields, horizontally scrolled fields and double-width/CJK cells are not handled.**
  `getWidth()` is available and ignored.
- **Unit 21 is not in this package.** Recording an artifact on this surface and running it through
  the replay engine and the conformance scenarios is SPEC §11 unit 21. `act()` is implemented and
  tested here, but no terminal artifact has yet been through `@crr/runtime`.
