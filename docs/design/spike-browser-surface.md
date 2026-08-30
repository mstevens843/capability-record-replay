# Spike: the browser (legacy web) surface driver

**Status: spike complete. Everything below was run.** Every number, every role histogram, every
error string and every coordinate in this document came out of a command that executed in
`/private/tmp/crr-browser-spike` on the machine described in §0, against a locally served frameset
fixture. Where something was *not* measured, it says so. Nothing here is a recollection of how
Playwright or CDP behave - the recollection I started with was wrong twice, and both times the
correction is the most useful paragraph in the section.

**Recommendation, up front.** Build the Observation from **raw CDP `Accessibility.getFullAXTree`,
called once per frame and stitched by us** - not from Playwright's accessibility helpers. Three
findings force that, all reproducible:

1. **`page.accessibility.snapshot()` no longer exists.** It was deprecated through 1.56.0 and is
   **absent from the public API in 1.57.0 onwards**; on 1.62.1 `typeof page.accessibility` is
   `undefined`. The internal `page._snapshotForAI()` is gone too. Their replacement,
   `page.ariaSnapshot({ mode: 'ai' })`, is public and good (§1.2).
2. **`getFullAXTree()` does not cross a frameset.** On our fixture it returns **7 nodes** - the
   frameset document and nothing else. Child frames are `Iframe` leaves with empty `childIds`. The
   whole tree is 205 nodes. This is the single biggest thing the spike was meant to find, and it is
   real. It is also fixable in about 20 lines (§2.2).
3. **`ariaSnapshot` folds layout tables into data tables, and CDP does not.** Chromium's AX tree
   distinguishes `LayoutTable` / `LayoutTableRow` / `LayoutTableCell` from `table` / `row` / `cell`
   via `AXValue.type === 'internalRole'` vs `'role'`. Playwright's ARIA computation collapses both to
   `table/row/cell`, because that is what HTML-AAM says. On a page of nested layout tables that
   collapse makes "the row whose Member ID is X" **ambiguous** - measured: two matching ancestor rows
   for one data cell, and Playwright strict mode refusing with *"resolved to 3 elements"* (§1.4).
   CDP keeps the distinction and the ambiguity disappears.

Point 3 is the load-bearing one. §3.7 of the assignment says "no clean DOM"; the specific way a
legacy back-office page is unclean is that it is **tables inside tables**, and the only API on this
machine that tells a layout table from a data grid is the raw CDP tree.

**But the honest caveat that belongs next to the recommendation:** this is a **Chromium-only**
design. `browserContext.newCDPSession()` is documented *"CDP sessions are only supported on
Chromium-based browsers."* Firefox and WebKit have no CDP at all. We are choosing depth of
perception over browser breadth, and for a fleet of internal bank apps that is the right trade - but
it is a trade, not a free lunch, and REPORT §4 should say so.

---

## 0. What ran, and where

```text
darwin arm64, macOS 15.6 (24G84)
node v22.22.1   npm 10.9.4   pnpm 10.33.0
playwright 1.62.1  (installed fresh; PLAYWRIGHT_BROWSERS_PATH=/Volumes/T7 Touch/dev-caches/playwright)
chromium: Chrome for Testing 151.0.7922.34  (playwright chromium v1234), downloaded by this spike
scratch: /private/tmp/crr-browser-spike   (nothing in this spike was run inside the repo)
```

The fixture is served by a 20-line static server on **two** ports so that cross-origin embedding
could be tested: `http://127.0.0.1:8731/` and `http://localhost:8732/` are different origins.

| Path | What it is | Lines |
|---|---|---|
| `fixture/index.html` + 7 pages | frameset, nested layout tables, `<font>`, generated ids, no test IDs | 129 |
| `perceive.mjs` | the reference `perceive()` this document recommends | 125 |
| `png.mjs` | ~30-line PNG decoder, used only to verify screenshot masking at the pixel | 31 |
| `exp1`…`exp18`, `bench.mjs`, `server.mjs` | the 20 experiments | 953 |
| | **total** | **1238** |

All of it is preserved in [`./spike-browser-surface/`](./spike-browser-surface/) with a README
mapping each script to the section it produced. It was re-installed and re-run standalone from that
copy before this document was finished; §6.2's timings are from that re-run.

The fixture deliberately mirrors `fixtures/corebank-web` from BRIEF §4:

```html
<frameset rows="64,*">
  <frame name="banner" src="banner.html">
  <frameset cols="176,*">
    <frame name="nav" src="nav.html">
    <frame name="content" src="members.html">   <!-- layout table > layout table > data grid -->
  </frameset>                                   <!-- and an <iframe name="detail"> inside that -->
</frameset>
```

Five documents, four levels deep, one `<iframe>` nested inside a `<frame>`. Member data is obviously
synthetic (`ALVAREZ, DANA (SYNTHETIC)`).

---

## 1. Which API - and why the obvious answer is the wrong one

### 1.1 `page.accessibility.snapshot()` is gone, not merely deprecated

`exp1-api-inventory.mjs`, verbatim:

```console
$ node exp1-api-inventory.mjs
playwright version: 1.62.1
chromium version : 151.0.7922.34

--- legacy APIs ---
typeof page.accessibility        : undefined
typeof page.accessibility?.snapshot: undefined
typeof page._snapshotForAI       : undefined
typeof page.ariaSnapshot         : function
typeof page.mainFrame().ariaSnapshot: undefined
```

Note the last line: `ariaSnapshot` is on **`Page` and `Locator`**, not on `Frame`. That matters in
§2.3.

Bisected across published tarballs (`npm pack playwright-core@X && grep types/types.d.ts`):

| playwright-core | `page.accessibility` | `ariaSnapshot({mode:"ai"})` | internal `_snapshotForAI` |
|---|---|---|---|
| 1.49.1, 1.53.0, 1.55.0, 1.56.0 | present (`@deprecated` in 1.56.0) | - | present (checked in 1.55.0) |
| **1.57.0** | **removed** | - | - |
| 1.58.0 | removed | - | - |
| **1.59.0** - 1.62.1 | removed | **present** | - |
| 1.63.0-alpha-2026-08-05 | removed | present | - |

The 1.56.0 deprecation text was:

```ts
/**
 * @deprecated This property is discouraged. Please use other libraries such as
 * [Axe](https://www.deque.com/axe/) if you need to test page accessibility. …
 */
accessibility: Accessibility;
```

That deprecation was written for *accessibility auditing*, which is not our use case, and the
replacement it points at (Axe) is irrelevant to us. The API is nonetheless gone. **Any design
document or code sample that reaches for `page.accessibility.snapshot()` is describing Playwright
1.56 or earlier.** Worth knowing before writing it into a REPORT.

### 1.2 `ariaSnapshot({ mode: 'ai' })` is real, public, and genuinely good

It is documented in `types.d.ts` and takes `{ mode: 'ai' | 'default', boxes, depth, timeout, signal }`.
`mode: "ai"` *"returns a snapshot optimized for AI consumption: including element references like
`[ref=e2]` and snapshots of `<iframe>`s."*

On the frameset it produces this (excerpt from `exp2-aria-snapshot.mjs`; 104 lines, 6704 bytes total):

```yaml
- generic [active] [ref=e1] [box=0,0,1200,800]:
  - iframe [ref=e2] [box=0,0,1200,64]:
    - table [ref=f1e2] [box=0,0,1200,29]:
      …
          - link "Sign Off" [ref=f1e9] [cursor=pointer] [box=1149,7,47,15]:
  - generic [ref=e3] [box=0,65,1200,735]:
    - iframe [ref=e4] [box=0,65,176,735]:
      …
    - iframe [ref=e5] [box=177,65,1023,735]:
      - table [ref=f3e2] [box=4,4,1015,441]:            # <- the OUTER LAYOUT TABLE, called a table
        …
              - table [ref=f3e18] [box=4,62,490,94]:    # <- the actual data grid
                  - row [ref=f3e31] [box=5,86,488,23]:
                    - cell "10041" [ref=f3e32] [box=5,86,74,23]
                    - cell "ALVAREZ, DANA (SYNTHETIC)" [ref=f3e33] [box=79,86,194,23]
                    …
              - iframe [ref=f3e63] [box=4,261,624,184]:
                - table [ref=f4e2] [box=8,8,229,67]:
                    …
                      - button "Open Sub-Account" [ref=f4e13] [box=10,52,129,21]
```

It **does** cross the frameset and the nested iframe, it **does** frame-qualify the refs
(`f1…`, `f3…`, `f4…`), and 6.7 KB of YAML for a five-document app is a very good token budget for a
discovery prompt. If the fixture were a modern app I would stop here and ship it.

### 1.3 The measured comparison

| | `page.accessibility.snapshot()` | `page.ariaSnapshot({mode:'ai'})` | CDP `Accessibility.getFullAXTree` |
|---|---|---|---|
| Exists in 1.62.1 | **no** | yes, public | yes |
| Crosses a frameset | n/a | **yes**, automatically | **no** - 7 nodes; one call per frame needed |
| Output form | object tree | **YAML text** | typed `AXNode[]` |
| Stable node handle | n/a | `ref=f3e32`, session-scoped | `nodeId` + `backendDOMNodeId` |
| Distinguishes layout tables | n/a | **no** | **yes** (`role.type`) |
| Per-node state (`disabled`, `checked`, …) | n/a | partial, as text tags | **yes**, structured (§5.4) |
| Geometry | n/a | `boxes:true`, **frame-local** | `DOM.getBoxModel`, **main-frame** |
| Geometry cost | n/a | **free** (same pass) | one round trip per node |
| Back to a Playwright `Locator` | n/a | **yes**, `aria-ref=` | no public bridge (§3.1) |
| Typed in TypeScript | n/a | `Promise<string>` | fully - `CDPSession.send` is typed against `Protocol.CommandParameters` |

The last CDP row matters for this repo's house style: `send<T extends keyof Protocol.CommandParameters>(method: T, params?: Protocol.CommandParameters[T]): Promise<Protocol.CommandReturnValues[T]>`.
The CDP path is not a stringly-typed escape hatch; it type-checks.

### 1.4 The decisive difference: layout tables

This is the finding that settles the API choice, and I did not expect it.

Chromium's accessibility tree has *internal* roles alongside ARIA roles. `Protocol.Accessibility.AXValueType`
literally includes both `"role"` and `"internalRole"`. Run over the `content` frame
(`exp9-tables.mjs`, `exp10-roles-and-state.mjs`):

```console
CDP getFullAXTree -> role histogram :
  {"LayoutTable":2,"LayoutTableRow":2,"LayoutTableCell":6,"table":2,"row":6,"cell":23}
```

```text
role=LayoutTable     type=internalRole chromeRole=105  name=""
role=LayoutTableCell type=internalRole chromeRole=106  name="Member ID Last Name Search Search Results   "
role=table           type=role         chromeRole=167  name=""
role=row             type=role         chromeRole=145  name=""
role=cell            type=role         chromeRole=13   name="10041"
role=columnheader    type=role         chromeRole=19   name="Member ID"
```

Playwright's snapshot of the same DOM calls **all** of them `table` / `row` / `cell`. That is not a
Playwright bug - HTML-AAM maps `<table>` to `role=table` and Playwright is implementing the spec.
It is simply the wrong resolution for our problem.

The consequence, measured (`exp8d-route-d.mjs`), doing exactly what a "row-anchored locator" would do:

```console
$ node exp8d-route-d.mjs
  memberId=10041: rows=2 openLinks=3
  memberId=10042: rows=2 openLinks=3
  memberId=10043: rows=2 openLinks=3
  memberId=10099: rows=0 openLinks=0

locator.click: Error: strict mode violation:
  getByRole('row').filter({ has: getByRole('cell', { name: '10043', exact: true }) })
    .getByRole('link', { name: 'Open' }) resolved to 3 elements:
    1) <a target="detail" href="detail.html?m=10041">…
    2) <a target="detail" href="detail.html?m=10042">…
    3) <a target="detail" href="detail.html?m=10043">…
```

Two "rows" match every member ID: the real data row, **and the outer layout row that contains the
whole page**. `filter({ has })` matches any ancestor row, and under nested tables there is always a
second one. Asking for the "Open" link inside that outer row yields all three.

The same query against the CDP tree, restricted to `role.type === 'role'`, is unambiguous
(`exp15-edges.mjs`):

```console
  strict (ariaRole only)          key=10043 -> OK
  naive  (layout roles folded in) key=10043 -> {"matchingCells":1,"nearestRows":1,"ALL_ancestorRows":2}
```

Two things to carry into the design:

- **Only `role.type === 'role'` nodes are candidate targets.** `internalRole` nodes are structure, and
  our `UINode` should carry them as `ariaRole: null` so a locator strategy cannot accidentally select
  one. `perceive.mjs` does exactly that.
- **Playwright's strict mode is a free ambiguity detector.** It refused rather than clicking the wrong
  link. That is the behaviour BRIEF §3.2 specifies for our own descriptor comparison, arrived at
  independently by Playwright, and it is a good argument for keeping a Playwright-locator strategy in
  the ranked set as a *cross-check* even though it is not the primary one.

---

## 2. Framesets - the biggest risk. It is real, and it is bounded.

### 2.1 `getFullAXTree()` returns seven nodes

`exp5-cdp-axtree.mjs` / `exp6-cdp-frames.mjs`:

```console
Accessibility.getFullAXTree -> nodes: 7

  id=1  role=RootWebArea ignored=false name="CoreBank Servicing 4.2" children=[6]  frameId=E41C324C
  id=6  role=none        ignored=true                                 children=[9]
  id=9  role=none        ignored=true                                 children=[10,11]
  id=10 role=Iframe      ignored=false                                children=[]
  id=11 role=none        ignored=true                                 children=[12,13]
  id=12 role=Iframe      ignored=false                                children=[]
  id=13 role=Iframe      ignored=false                                children=[]

--- do frame contents appear in the single flat tree? ---
  "Sign Off"                     found=false
  "Member Search"                found=false
  "ALVAREZ, DANA (SYNTHETIC)"    found=false
  "Open Sub-Account"             found=false
```

Every `Iframe` node has `childIds: []`. Nothing from any child document is present. Same-origin,
same-process - it makes no difference. The CDP docstring says so if you read it closely:
*"Fetches the entire accessibility tree for the root Document."* **Root Document**, singular.

Also worth recording: **only frame root nodes carry `frameId`.** Six of the seven nodes have none. A
"walk up `parentId` until you find a `frameId`" strategy works *within* a document and tells you
nothing across documents, because the parent link does not cross the boundary either.

### 2.2 The fix: enumerate frames, one call per frame, stitch it yourself

Three routes were tested. Only one works for a same-origin frameset.

```console
=== OPTION 1: Accessibility.getFullAXTree({ frameId }) per frame, same page CDP session ===
  frame ""         http://127.0.0.1:8731/              nodes=   7
  frame "banner"   http://127.0.0.1:8731/banner.html   nodes=  15
  frame "nav"      http://127.0.0.1:8731/nav.html      nodes=  24
  frame "content"  http://127.0.0.1:8731/members.html  nodes= 134
  frame "detail"   http://127.0.0.1:8731/detail.html   nodes=  25
  TOTAL nodes across all frames: 205

=== OPTION 2: ctx.newCDPSession(frame) for a same-process child frame ===
  newCDPSession(frame "banner") THREW: Error: browserContext.newCDPSession:
    This frame does not have a separate CDP session, it is a part of the parent frame's …
  (same for "nav", "content", "detail")

=== OPTION 3: Accessibility.getRootAXNode({ frameId }) ===
  ""        rootNodeId=1 role=RootWebArea
  "banner"  rootNodeId=2 role=RootWebArea
  "nav"     rootNodeId=3 role=RootWebArea
```

So: **`Page.getFrameTree` → one `getFullAXTree({ frameId })` per frame → stitch.** The stitching edge
is `DOM.describeNode({ backendNodeId }).node.frameId`, which turns an `Iframe` AX leaf into the child
frame's id:

```console
  AX Iframe backend=10 -> <frame name="banner"> frameId=D4B4C3B7 (…/banner.html)
  AX Iframe backend=12 -> <frame name="nav">    frameId=AD2EA016 (…/nav.html)
  AX Iframe backend=13 -> <frame name="content">frameId=B50C4DBD (…/members.html)
```

Two facts that make the stitch safe, both measured on 205 nodes across 5 frames:

```console
  total nodes=205 distinct nodeIds=205             -> COLLIDE=false
  distinct backendDOMNodeIds=158 of 158            -> COLLIDE=false
  (root) nodeIds 1 .. 13 | banner 2 .. -1000000004 | content 3 .. -1000000035
```

`backendDOMNodeId` is **globally unique across the page** - that is the identity to key geometry and
actions on. AX `nodeId` happens not to collide either (Chromium hands out negative ids to non-main
frames), but that is an implementation detail; `perceive.mjs` namespaces ids as `f{frameIndex}:{nodeId}`
rather than relying on it.

`Accessibility.enable` turns out not to be required - `getFullAXTree` enables the domain implicitly
(`exp15-edges.mjs`). We send it anyway, because `getRootAXNode` *does* document a requirement and
being explicit costs nothing.

### 2.3 Which frame a node lives in

`containerPath` falls out of the frame walk for free - the chain of frame **names**, which in a
frameset are author-assigned and stable, with an ordinal fallback for unnamed frames:

```console
$ node exp14-perceive.mjs
  Sign Off           role=link     frame=["#0","banner"]            bounds={"x":1149,"y":7}
  Member Search      role=link     frame=["#0","nav"]               bounds={"x":11,"y":95}
  Search             role=button   frame=["#0","content"]           bounds={"x":562,"y":71}
  Open Sub-Account   role=button   frame=["#0","content","detail"]  bounds={"x":193,"y":380}
```

This is the right shape for BRIEF §3.1's `UINode.containerPath` and it is what a descriptor should
store: `frame: ['content','detail']` is a durable, human-reviewable, non-CSS container reference. It
survives a reload; a frame *ordinal* does not:

```console
  before: f0=#0 f1=#0/banner f2=#0/nav f3=#0/content f4=#0/content/detail
  after : f0=#0 f1=#0/banner f2=#0/nav f3=#0/content
```

Navigating the `content` frame away removed the nested iframe and shifted the ordinals. **Store the
name path, never the ordinal**, and treat every node id as valid only within one Observation.

One friction worth knowing before writing driver code: **`ariaSnapshot` is on `Page` and `Locator`,
not on `Frame`**, and **`locator.filter({ has })` requires the inner locator to be built from the
same `Frame` object** - `page.getByRole(...)` used as `has` on a frame locator throws
*"Inner \"has\" locator must belong to the same frame."* A cross-frame observation model has to
carry the owning `Frame` around, not just a path string.

### 2.4 Cross-origin iframes - where it actually breaks

Tested with `xorigin.html` on `127.0.0.1:8731` embedding `localhost:8732` (different origins).

**Default Chromium as Playwright launches it** - no OOPIF. Playwright passes no site-isolation flags
(grepped: no `--site-per-process`, no `IsolateOrigins`, no `--disable-site-isolation-trials` in
`playwright-core/lib`), and Chromium did not put this cross-origin iframe in its own process:

```console
 newCDPSession(childFrame): THREW -> same-process frame
 AX nodes for the cross-origin document: 25          # reachable via getFullAXTree({frameId})
 CDP border quad : x=185.1 y=62.0 w=128.6 h=21.0
 Playwright bbox : x=185.1 y=62.0 w=128.6 h=21.0     # identical
   click CDP border-quad centre at (249.4,72.5) -> hit button = true
```

**Forced with `--site-per-process`** - a genuine OOPIF, and three things change at once:

```console
 Page.getFrameTree (page session) sees: [ 'http://127.0.0.1:8731/xorigin.html' ]   # <- child missing
 page.frames() sees                   : [ …/xorigin.html, http://localhost:8732/detail.html ]
 newCDPSession(childFrame): OK  -> this IS a true OOPIF
 CDP border  quad : x=10.0  y=52.0     # frame-LOCAL
 frame-local rect : x=10.0  y=52.0     # identical to getBoundingClientRect() inside the frame
 Playwright bbox  : x=183.1 y=60.0     # main-frame, Playwright composed the offsets itself
   click CDP border-quad centre at (74.3,62.5) -> hit button = false
```

So for a real OOPIF: `Page.getFrameTree` from the page session **does not see it** (use
`page.frames()`), it needs its **own CDP session**, and `DOM.getBoxModel` from that session returns
**frame-local** coordinates, so a coordinate click computed from them **misses** - verified, not
inferred.

**Decision: handle OOPIFs by detection, not by composition.** `perceive()` enumerates frames from
`Page.getFrameTree` and silently skips what it cannot reach; that is wrong, so it should instead
compare against `page.frames()` and **raise a typed "unperceivable frame" condition** when the two
disagree. Composing OOPIF offsets is doable - get the owner element's box in the parent and add it -
but it is unnecessary for our fixture (same-origin frameset) and untested code in a safety-critical
path is worse than a loud limitation. This is a documented seam, listed in §8.

---

## 3. From an AX node to something you can click

### 3.1 Four routes, all measured

`DOM.resolveNode({ backendNodeId })` works and returns a CDP `RemoteObject`:

```console
DOM.resolveNode -> {"type":"object","subtype":"node","className":"HTMLAnchorElement",
                    "description":"a","objectId":"4023136078954799728.7.1"}
```

…and then it dead-ends: **Playwright exposes no public API to lift a CDP `RemoteObject` into an
`ElementHandle`.** That is the honest answer to "backendDOMNodeId → resolveNode → element handle": the
first two arrows work, the third does not exist. So `exp8-bridges.mjs` measured what does.

| | Route A: `Runtime.callFunctionOn` | Route B: box model + `page.mouse` | Route C: stamp an attribute | Route D: role + name re-resolve |
|---|---|---|---|---|
| Works cross-frame | yes | **yes** | yes | yes |
| Real trusted input events | **no** | **yes** | yes | yes |
| Playwright actionability / auto-wait | no | **no** | **yes** | **yes** |
| Mutates the page under test | no | **no** | **yes** | **no** |
| Needs coordinates | no | **yes** | no | no |
| Durable across sessions | n/a | no | n/a | **yes** |

Route A sets `this.value` directly. It works and it is a lie: no focus, no `keydown`/`keypress`, no
`change` ordering. A 2006-era ASP.NET page with `onchange` postbacks will not notice it. Not for acting.

Route B is the coordinate fallback, and it works well:

```console
  clicked (299.8,81.5) then typed -> input value = "…10043"
  clicking main-frame viewport point (641.6, 162.0)
  detail frame url after coordinate click: http://127.0.0.1:8731/detail.html?m=10041
```

Route C - `callFunctionOn` to `setAttribute`, `waitForSelector`, act, `removeAttribute` - gives a
genuine `ElementHandle` with actionability checks. It also **writes to the page under test**, which
on a legacy app with attribute-driven behaviour is a real if small risk, and it is philosophically
wrong for a system whose whole claim is that it perceives rather than injects. Available, not default.

Route D re-resolves by role + accessible name and is the one the artifact should describe, because it
is the only row in the table that is **durable across sessions** - which is exactly what BRIEF §3.2
means by a descriptor.

### 3.2 The recommendation

**Perceive with CDP. Act through descriptors, with the coordinate route as an explicitly-marked
fallback.**

```text
CDP AX node ──► UINode { backendDOMNodeId, ariaRole, name, state, containerPath, bounds }
                  │
                  ├─ descriptor: role + accessible name        ─┐
                  ├─ descriptor: row-anchored (§5.2)            ├─► resolved independently,
                  ├─ descriptor: ordinal within container       ─┘   results compared (BRIEF §3.2)
                  └─ fallback:   bounds → page.mouse            ◄── marked in the artifact as geometric
```

`backendDOMNodeId` is the within-session identity that ties a resolved descriptor back to the node the
Observation showed - cheap to compare, and a disagreement between two descriptors is exactly
"they resolved to different `backendDOMNodeId`s", which is a one-line check rather than a heuristic.

There is one more bridge that turned out to be more useful than expected: **`page.locator('aria-ref=…')`**.
Refs minted by `ariaSnapshot({mode:'ai'})` resolve to real Playwright locators, from a page-level
locator, across frames, with no manual frame descent (`exp3-ariaref-act.mjs`):

```console
  Sign Off link (frame "banner")        ref=f1e9   count=1 box={"x":1149.3,"y":7,…}   text="Sign Off"
  Open link row 10041 (frame "content") ref=f3e37  count=1 box={"x":625.7,"y":153,…}  text="Open"
  Open Sub-Account (nested iframe)      ref=f4e13  count=1 box={"x":193,"y":380,…}
  nonexistent ref                       ref=f9e99  THREW: Invalid frame in aria-ref selector "aria-ref=f9e99"
```

It fills, clicks and selects across all four documents. Its lifecycle is in §7.2 and it is **not**
in `types.d.ts` - an undocumented selector engine - so it is not load-bearing here. But it is the
cheapest way to hand a Playwright `Locator` to `page.screenshot({ mask: [...] })`, which §4.4 needs.

---

## 4. Geometry

### 4.1 Two coordinate spaces, and only one is clickable

This cost me half an hour and would cost the build a day.

```text
ariaSnapshot({boxes:true})   link "Open" (row 10041)  ->  box = 449, 88        FRAME-LOCAL
getBoundingClientRect() inside the content frame      ->        448.7, 88.0    (identical)
CDP DOM.getBoxModel                                   ->        625.7, 153.0   MAIN-FRAME
Playwright locator.boundingBox()                      ->        625.7, 153.0   (identical)
```

`ariaSnapshot`'s boxes are `getBoundingClientRect()` **within the owning frame** - the doc says so,
and on a single-document page nobody notices. On a frameset the two spaces differ by the frame's
offset (here 177, 65) and a click at the frame-local point lands somewhere else entirely. Verified
directly in the OOPIF test: `click frame-LOCAL rect centre -> hit button = false`.

**`page.mouse` consumes main-frame viewport CSS pixels. Use `DOM.getBoxModel`.**

### 4.2 Use the `border` quad, not `content`

`DOM.getBoxModel` returns four quads. For an `<a>` they coincide; for a `<button>` they do not:

```console
 CDP content quad : x=193.1 y=65.0 w=112.6 h=15.0
 CDP border  quad : x=185.1 y=62.0 w=128.6 h=21.0
 Playwright bbox  : x=185.1 y=62.0 w=128.6 h=21.0
 border quad == Playwright bbox ? true
```

`model.border` is what `boundingBox()` returns. Both centres happened to hit the button here, but the
content quad excludes border and padding, and on a control that is mostly padding - a legacy toolbar
button - the difference is the difference between hitting it and hitting its container.

### 4.3 Hidden, zero-size and off-screen

`exp13-geometry.mjs`:

```console
  display:none            in-AX-tree=false ignored=- box={"error":"Protocol error (DOM.getBoxModel):
                                                                  Could not compute box model."}
  visibility:hidden       in-AX-tree=false ignored=- box={"x":181,"y":510,"w":1015,"h":18}
  zero-size <span>        in-AX-tree=true  ignored=false box={"x":181,"y":528,"w":0,"h":0}
  4000px below the fold   in-AX-tree=true  ignored=false box={"x":181,"y":4065,"w":114.2,"h":18}
```

Four separate behaviours, and three of them are traps:

- `display:none` - absent from the AX tree **and** `getBoxModel` throws. Clean, unambiguous.
- `visibility:hidden` - absent from the AX tree but **`getBoxModel` returns a perfectly ordinary
  box**. *Having a box is not evidence of being visible.* If we ever build a node list from the DOM
  rather than the AX tree, this is where a phantom target comes from.
- Zero-size - **present and not ignored** in the AX tree, `0×0`. A coordinate click is impossible.
  `perceive()` must record `bounds` as `{w:0,h:0}` and a geometric descriptor must refuse it.
- Off-screen - box `y=4065` against an 800px viewport. `DOM.scrollIntoViewIfNeeded({backendNodeId})`
  fixes it: `y=4065 → y=782`, one call, no evaluation in the page.

Scrolling a frame moves boxes and they can go **negative**, tracking exactly:

```console
  before scroll:              {"x":182,"y":197,"w":74.5,"h":23}
  after frame scrollTo(0,300):{"x":182,"y":-103,"w":74.5,"h":23}
  Playwright bbox after:      {"x":182,"y":-103,"w":74.5,"h":23}
```

So the rule for the coordinate fallback is: `scrollIntoViewIfNeeded` → **re-read** the box → validate
`w>0 && h>0` and that the centre is inside the viewport → click. Not: read the box once and click it.

### 4.4 Screenshot region masking works - verified at the pixel

BRIEF §3.7 requires masking screenshot regions bound to sensitive parameters. It works, and it was
verified by decoding the PNG rather than by eyeballing it (`png.mjs`, ~30 lines, `zlib` only):

```console
  sensitive field main-frame box: {"x":419.2,"y":71,"w":139,"h":21}
  pixel at field centre, unmasked = rgb(255,255,255)
  pixel at field centre, masked   = rgb(255,0,255)     # Playwright's default mask colour, #FF00FF
  masking took effect: true
  pixel far from the field unchanged: 0,51,102,255 vs 0,51,102,255
```

The masked field lives in the `content` frame, three levels into the frameset, and the mask was
applied with `page.screenshot({ mask: [page.locator('aria-ref=f3e14')] })` from a page-level locator.

Clipping to a CDP box also lands correctly in the deepest frame:

```console
  CDP box for "Open Sub-Account" in the nested iframe: {"x":193,"y":380,"w":128.6,"h":21}
  clipped PNG dimensions: 128x21
  centre pixel of clip: rgb(239,239,239)     # the button face, not the ivory page background
```

One API constraint to design around: **`mask` takes `Locator[]`, not rectangles.** There is no
coordinate-only masking. So the driver needs a `UINode → Locator` bridge purely for redaction, and
`aria-ref` is the cheapest one - at the cost of calling `ariaSnapshot()` alongside the CDP tree
whenever a masked screenshot is taken. The alternative is compositing the mask ourselves, which
means an image dependency for a problem Playwright already solved.

---

## 5. Table semantics

### 5.1 What the legacy grid actually gives us

The grid has **no `<th>`, no `scope=`, no `<caption>`, no `summary`, no test ids** - header cells are
`<td><font face="Arial" size="2"><b>Member ID</b></font></td>`. Chromium still classified it as a
**data table**:

```text
role=table        chromeRole=167
  role=row        chromeRole=145      x4  (header row + 3 data rows)
    role=cell     chromeRole=13       x5 per row
```

Better than expected. The structure survives. What does **not** survive is header semantics: every
cell in row 0 is `role=cell`, not `role=columnheader`. The semantic control table in the same
document, with `<th scope="col">`, does yield `columnheader`. So we get **structure for free and
headers only by heuristic** - and the heuristic (row 0 of the table) worked on this fixture.

### 5.2 "the cell in the row whose Member ID is X"

The strategy is a pure function over the Observation - no locators, no CSS, no Playwright:

1. find nodes with `ariaRole === 'cell'` and `name === keyValue`;
2. **0 matches → `NOT_FOUND`** (a business outcome), **>1 → `AMBIGUOUS`** (refuse, per BRIEF §3.2);
3. walk `parentId` to the **nearest** ancestor with `ariaRole === 'row'` - nearest, not any;
4. collect that row's cells in document order;
5. take row 0 of the enclosing `ariaRole === 'table'` as the header row, and record **how** the
   headers were obtained.

`exp14-perceive.mjs`, running that against the live frameset:

```console
  key=10042 col="Share Balance"      -> OK value="88.10" headers=first-row-heuristic
                                        row=["10042","BOOKER, RAY (SYNTHETIC)","88.10","DORMANT","Open"]
  key=10043 col="Status"             -> OK value="ACTIVE" headers=first-row-heuristic
  key=20001 col="Share Balance"      -> OK value="7.00"  headers=columnheader-role
  key=10099 col="Share Balance"      -> NOT_FOUND {"keyValue":"10099"}
  key=10042 col="Nonexistent Column" -> NO_SUCH_COLUMN
                {"columnLabel":"Nonexistent Column",
                 "available":["Member ID","Name","Share Balance","Status","Action"]}
```

and with a duplicate row injected (`exp15-edges.mjs`):

```console
  key=10042 -> {"kind":"AMBIGUOUS","keyValue":"10042","count":2}
```

Four outcomes, four different typed answers, none of them a click on the wrong row. `NOT_FOUND` is
`MEMBER_NOT_FOUND` arriving at exactly the layer BRIEF §3.3 wants it, and `NO_SUCH_COLUMN` carries
the available column names, which is what makes a hard failure debuggable.

`headerProvenance: 'columnheader-role' | 'first-row-heuristic'` is worth putting in the artifact.
It is the difference between "the app told us this column is Share Balance" and "we guessed from
row 0", and a per-tenant overlay (BRIEF §3.8) is exactly where a wrong guess gets corrected.

### 5.3 What we do not get

**No `colindex`, no `rowindex`, no `colcount`.** The complete set of AX property names present
anywhere in the content frame:

```console
  editable, focusable, invalid, multiline, readonly, required, settable, url
```

Column position is **positional only** - index within the row's cell list. Consequences:

- A `colspan`/`rowspan` in the header row would desynchronise header index from cell index. Our
  fixture has none; a real one might. **Untested, and a known gap** (§8).
- The nearest-ancestor-row walk is load-bearing. Using *any* ancestor row is the §1.4 bug.
- The key column is not privileged - `keyColumnIndex` came back `0` here, but the algorithm does not
  assume it, which matters for a grid where the account number is the third column.

### 5.4 State properties, which are complete enough

Everything `UINode.state` needs is present (`exp10-roles-and-state.mjs`, over a probe page):

```console
  role=textbox   disabled=true invalid="false" editable="plaintext" multiline=false readonly=false required=false
  role=checkbox  invalid="false" focusable=true checked="true"
  role=radio     checked="false"
  role=listbox   multiselectable=true orientation="vertical" required=false
  role=textbox   invalid="true" required=true settable=true
  role=button    hasPopup="menu" expanded=false
  role=tab       focusable=true selected=true
  role=textbox   readonly=true
  role=link      focusable=true focused=true url="…/states.html#"
  role=option    selected=true
```

`disabled`, `checked`, `selected`, `expanded`, `focused`, `readonly`, `required`, `invalid`,
`hasPopup` - all structured, all typed. Note `checked` is a **string** `"true"`/`"false"` (it is a
tristate), so it must be normalised rather than truth-tested.

One gap: **`aria-modal` is not surfaced.** A `<div role="dialog" aria-modal="true">` yields
`ariaRole: 'dialog'` with an **empty** property set (§7.1).

---

## 6. The reference `perceive()`

### 6.1 The code

Preserved at [`./spike-browser-surface/perceive.mjs`](./spike-browser-surface/perceive.mjs); this is
the shape `packages/surface-browser` should have. Abridged to the load-bearing parts:

```js
async function frameTree(cdp) {
  const { frameTree: ft } = await cdp.send('Page.getFrameTree');
  const out = [];
  (function walk(node, path) {
    const name = node.frame.name ?? '';
    const here = [...path, name || `#${out.length}`];        // name path, never a bare ordinal
    out.push({ id: node.frame.id, name, url: node.frame.url, path: here });
    for (const c of node.childFrames ?? []) walk(c, here);
  })(ft, []);
  return out;
}

export async function perceive(cdp, { geometry = 'actionable' } = {}) {
  const frames = await frameTree(cdp);
  const nodes = [];

  for (let fi = 0; fi < frames.length; fi++) {
    let axNodes;
    try { ({ nodes: axNodes } = await cdp.send('Accessibility.getFullAXTree', { frameId: frames[fi].id })); }
    catch { continue; }                          // OOPIF: unreachable from this session - see §2.4
    for (const n of axNodes) {
      if (!n.role?.value) continue;
      const isAria = n.role.type === 'role';     // <-- the §1.4 distinction, kept
      const state = {};
      for (const p of n.properties ?? []) if (STATE_PROPS.has(p.name)) state[p.name] = p.value?.value;
      nodes.push({
        id: `f${fi}:${n.nodeId}`,                // AX nodeIds are per-document; namespace them
        backendDOMNodeId: n.backendDOMNodeId,    // globally unique; the identity we act on
        role: n.role.value,
        ariaRole: isAria ? n.role.value : null,  // null => layout/presentational, never a target
        name: n.name?.value ?? '', value: n.value?.value ?? null,
        ignored: !!n.ignored, state,
        frameIndex: fi, containerPath: frames[fi].path,
        parentId: n.parentId ? `f${fi}:${n.parentId}` : null,
        childIds: (n.childIds ?? []).map(c => `f${fi}:${c}`),
        bounds: null,
      });
    }
  }

  // stitch: an AX `Iframe` leaf in one document is the parent of another document's root
  for (const n of nodes) {
    if (n.role !== 'Iframe') continue;
    const { node: dom } = await cdp.send('DOM.describeNode', { backendNodeId: n.backendDOMNodeId });
    const childIdx = frames.findIndex(f => f.id === dom.frameId);
    if (childIdx < 0) continue;
    const childRoot = nodes.find(x => x.frameIndex === childIdx && x.parentId === null);
    if (childRoot) { childRoot.parentId = n.id; n.childIds = [childRoot.id]; }
  }

  // geometry: one CDP round trip per node, so take it only for nodes we might act on
  const wants = geometry === 'none' ? []
    : geometry === 'all' ? nodes
    : nodes.filter(n => ACTIONABLE.has(n.ariaRole) ||
        ['cell','columnheader','row','dialog','alertdialog'].includes(n.ariaRole));
  for (const n of wants) {
    try {
      const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: n.backendDOMNodeId });
      n.bounds = { x: model.border[0], y: model.border[1],          // border quad, main-frame CSS px
                   w: model.border[2] - model.border[0], h: model.border[7] - model.border[1] };
    } catch { n.bounds = null; }                                     // display:none / detached
  }
  return { frames, nodes, byGlobalId: new Map(nodes.map(n => [n.id, n])) };
}
```

Not one CSS selector, and nothing above it knows what a browser is - which is the point of BRIEF §3.1.

### 6.2 Cost

`bench.mjs`, re-run from the preserved copy against the live 5-frame fixture, n=20:

```console
cold first perceive()                     : 22.3ms
perceive() geometry:"none" (AX tree only) : min 2.8ms  / median 3.1ms  / max 3.6ms
perceive() geometry:"actionable" (44 box) : min 9.4ms  / median 11.4ms / max 17.4ms
perceive() geometry:"all" (205 boxes)     : min 30.5ms / median 36.5ms / max 56.3ms
page.ariaSnapshot({mode:"ai"})            : min 3.5ms  / median 4.2ms  / max 46.7ms
page.ariaSnapshot({mode:"ai",boxes:true}) : min 3.5ms  / median 3.9ms  / max 4.5ms
page.screenshot()                         : min 17.3ms / median 28.6ms / max 48.9ms
```

Reading these:

- The AX tree across five documents costs **~3 ms**. Perception is not the bottleneck; a screenshot
  costs ten times more.
- Geometry is **one round trip per node, ~0.19 ms each**. `geometry:'actionable'` (44 of 205 nodes)
  is the right default; `'all'` triples the cost for nodes nothing will ever click.
- `ariaSnapshot` gets **all 205 boxes for free** in the same pass - 3.9 ms with boxes vs 4.2 ms
  without. If bulk geometry is ever needed, the cheap route is `ariaSnapshot(boxes:true)` **plus
  frame-offset composition** (§4.1), not 205 CDP calls. Not built; it needs an alignment between two
  node sets and the payoff is 25 ms.
- Observation size: 205 nodes serialise to **50 KB**; filtering to `ariaRole && !ignored` gives
  **14 KB**. The model gets the filtered view.

---

## 7. Things that will bite, stated plainly

### 7.1 An open native dialog blocks perception entirely

The worst finding in the spike, because it fails by hanging rather than by throwing.

```console
=== native confirm() held open: does perception still work? ===
  page.on("dialog") fired: {"type":"confirm","message":"Post this transaction?"}
  TIMEOUT after 4000ms: perceive
```

A `confirm()` blocks the renderer, so `Accessibility.getFullAXTree` **never returns** - no CDP error,
no timeout of its own. My first attempt at this experiment deadlocked and was killed at 2 minutes.

Two consequences for the driver, both non-negotiable:

- **The Surface driver must own `page.on('dialog')`.** With **no** handler registered Playwright
  dismisses the dialog for you, which silently cancels a confirmation the flow depended on -
  `exp18-dialog-default.mjs`:

  ```console
  no dialog handler registered at all:
    click resolved; #out = "idle"   => confirm() was DISMISSED (returned false), the branch never ran
  ```

  The click *succeeds*, the checkpoint fails later somewhere else, and the cause is three steps
  upstream. Registering a handler that does not act is worse: the dialog stays open forever.
- **`perceive()` needs its own deadline.** A CDP call with no timeout is a hang, not an error.

Native dialogs are also **invisible to the accessibility tree** - they are a separate channel and
must be modelled as a distinct `Observation` field, not as a node. With a handler that accepts:

```console
  dialog observed: [{"type":"confirm","message":"Post this transaction?"}]
  #out -> POSTED
  AX nodes after dismissal: 12 | any node named "Post this transaction?": false
```

In-page modals are the opposite - fully perceivable, which is what BRIEF §3.3's "unexpected
interstitial" recovery needs:

```console
role=dialog bounds (geometry:"all"): {"x":8,"y":47,"w":884,"h":91}
buttons geometrically inside it: ["OK","Cancel"]
descendants of it by AX parentage: ["OK","Cancel"]
NOTE: aria-modal is NOT surfaced as an AX property. Present properties: []
```

Both containment tests agree, so a detector can use AX parentage and does not need geometry. But
because `aria-modal` is absent, "is this modal" has to be inferred from `role=dialog` plus focus
containment, not read off a property.

### 7.2 `aria-ref` lifecycle - better than expected, still not storable

Refs are keyed to **element identity within a document**, not to position (`exp4-ref-lifecycle.mjs`):

```console
B) DOM mutation without navigation - old refs survive
   f3e32 (was "10041") -> 10041
C) RE-SNAPSHOT after inserting a row at index 1 - no renumbering
      - cell "99999" [ref=f3e67]      <- the new row got a NEW ref
      - cell "10041" [ref=f3e32]      <- existing refs unchanged
D) after a frame NAVIGATION
   f3e32 -> ERR: TimeoutError                 <- that frame's refs are dead
E) refs in OTHER frames still valid
   f1e9 (banner "Sign Off") -> Sign Off
```

So a ref is **never silently reassigned to a different element** - the failure mode is a clean
timeout, not a wrong click. That is much safer than I assumed, and it makes `aria-ref` fine as a
within-turn handle for the discovery loop and for `screenshot({mask})`. It remains useless as a
stored locator: it dies on navigation, dies with the session, and is **absent from `types.d.ts`**
(present only in `lib/coreBundle.js`) - an undocumented selector engine with no stability guarantee.

This lines up with BRIEF §3.2 rather than fighting it: the model picks a node id from the Observation
it was shown, deterministic code derives durable descriptors, and **no ref ever reaches the artifact**.

### 7.3 Smaller ones

- **`page.mainFrame().ariaSnapshot` is `undefined`** - `ariaSnapshot` is on `Page` and `Locator` only.
- **`filter({ has })` is frame-scoped**: *"Inner \"has\" locator must belong to the same frame."*
- **`checked` is `"true"` / `"false"` as strings** (tristate), not booleans.
- **`page.screenshot({ clip })` takes `{x,y,width,height}`**, not `{x,y,w,h}`; a wrong key gives
  `clip.width: expected float, got undefined`. Trivial, but it cost a run.
- **A bad ref throws a good error**: `Invalid frame in aria-ref selector "aria-ref=f9e99"`.
- **`Accessibility.enable` is not required** for `getFullAXTree`; it is for `getRootAXNode`.

---

## 8. What was not tested

Listed so nobody mistakes silence for coverage.

- **OOPIF coordinate composition.** Measured that it is broken (§2.4); did not implement the fix.
- **`colspan` / `rowspan` in a header row.** §5.2's column mapping is positional and would
  desynchronise. Our fixture has none. This is the most likely place §5 breaks on a real app.
- **Shadow DOM.** `getFullAXTree` should pierce it - one document - but it was not exercised. No
  legacy frameset has it; a modern-web tenant might.
- **A frameset with cross-origin frames.** Our frameset is same-origin; the cross-origin test used a
  separate `<iframe>` page.
- **Scale.** 205 nodes. Nothing says how a 5,000-node screen behaves, and §6.2's per-node geometry
  cost is linear.
- **Mid-load races.** Every measurement took a settled snapshot after an explicit wait. Perceiving
  during a navigation is where readiness bugs live, and it is untouched here - the terminal spike's
  §4 conclusion ("readiness is the checkpoint, not quiescence") probably transfers, but that is an
  expectation, not a result.
- **Windows and Linux.** darwin/arm64 only, one Chromium build (151.0.7922.34).
- **Firefox and WebKit.** Architecturally excluded: no CDP.
- **Any live model call.** Nothing in this spike contacted a provider (BRIEF §11).

---

## 9. Recommendation

**Build `surface-browser` on CDP, Chromium-only, with these five decisions.**

1. **`Page.getFrameTree` → `Accessibility.getFullAXTree({ frameId })` per frame → stitch via
   `DOM.describeNode`.** ~3 ms for five documents. The single-call convenience of `ariaSnapshot`
   is not worth losing §1.4.
2. **`role.type === 'role'` is the target filter.** Carry internal roles as structure with
   `ariaRole: null`. This is the one decision that makes a table-anchored locator work on a
   table-based layout, and it is the difference between "resolved to 3 elements" and `OK`.
3. **`backendDOMNodeId` is the within-session node identity; `containerPath` (frame *name* chain) is
   the durable container reference.** Node ids and frame ordinals are valid only within one
   Observation.
4. **Act through descriptors; coordinates are an explicitly-marked fallback**, always as
   `scrollIntoViewIfNeeded` → re-read `model.border` → validate non-zero and on-screen → `page.mouse`.
   Never the `content` quad, never a frame-local box.
5. **The Surface driver owns `page.on('dialog')` and puts a deadline on every CDP call.** An open
   native dialog is a hang, not an error, and it is the one failure in this spike that no amount of
   careful perception code would have caught.

Two things to watch during the build. First, §2.4: `perceive()` currently *skips* frames it cannot
reach, which would silently under-report an OOPIF - that must become a typed condition before the
driver is trusted. Second, §5.3: column mapping is positional, so the first real grid with a
`colspan` header will break it, and the fix belongs in the per-tenant overlay (BRIEF §3.8) rather
than in the locator.

The strongest reason to be confident in this approach is not that the accessibility tree is elegant.
It is that the fixture was built to be hostile - frameset, four documents deep, layout tables inside
layout tables, `<font>` tags, `ctl00_ctl32_g_9a1` ids, no test IDs, no `<th>` - and after routing
around three concrete traps, `perceive()` returns 205 typed nodes in 3 ms and
`"the Share Balance cell in the row whose Member ID is 10042"` resolves to `88.10`, with
`NOT_FOUND`, `AMBIGUOUS` and `NO_SUCH_COLUMN` as distinct typed answers rather than as exceptions.
That is the §3.7 claim demonstrated rather than asserted.
