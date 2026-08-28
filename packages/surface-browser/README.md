# `@crr/surface-browser`

The `Surface` port over Chromium's accessibility tree, read through **raw CDP**. This is the only
package in the repo that may know what a frame or a pixel is; everything above it is written against
`perceive` / `act` / `capture` / `capabilities` and has never heard of a browser.

```ts
import { attachBrowserSurface } from "@crr/surface-browser";

const surface = await attachBrowserSurface({
  page,                                        // an existing Playwright Page
  origins: { corebank: "http://host:8731" },   // alias -> base url, per tenant (may include /cb)
  routes,                                      // the capability's RoutePatterns, for canonicalization
  primaryFrame: "content",                     // whose url becomes Observation.route
  lease,                                       // the token `act` will accept
});
```

## Why raw CDP and not Playwright's accessibility helpers

Three measured findings, all from `docs/design/spike-browser-surface.md`:

1. **`page.accessibility.snapshot()` no longer exists.** Removed from the public API in Playwright
   1.57; on 1.62.1 `typeof page.accessibility` is `undefined`.
2. **`Accessibility.getFullAXTree` does not cross a frameset.** It returns **7 nodes** on the fixture's
   entry page; the whole screen is **126**. Every `Iframe` node has `childIds: []`.
3. **`ariaSnapshot` folds layout tables into data tables and CDP does not.** On a page of nested
   layout tables that fold makes "the row whose Member ID is X" resolve to *three* elements. It is
   the decisive finding, because the specific way a legacy back-office page is unclean is that it is
   tables inside tables.

The cost is stated rather than hidden: **this driver is Chromium-only.** `newCDPSession` is
documented "only supported on Chromium-based browsers", and Firefox and WebKit have no CDP.
`attachBrowserSurface` says so if you point it at one.

## The driver rules, and where each one lives

| Rule | Where |
|---|---|
| D1 `Page.getFrameTree` → one `getFullAXTree({frameId})` per frame → stitch via `DOM.describeNode` | `surface.ts#collect`, `surface.ts#stitchEdges`, `normalize.ts` |
| D2 `ariaRole` is `null` unless `role.type === "role"` **and** the role is in the closed vocabulary | `roles.ts` |
| D3 `containerPath` is the frame **name** chain, never an ordinal | `frames.ts`, `normalize.ts#containerPathOf` |
| D4 `scrollIntoViewIfNeeded` → **re-read** `model.border` → validate → click | `surface.ts#actionability`, `geometry.ts` |
| D5 the driver owns `page.on('dialog')` and never auto-answers | `surface.ts#listen` |
| D6 `perceive` honours its deadline with its own timer | `surface.ts.perceive` |
| D7 a frame the page has and this session cannot see is `unperceivable-container` | `frames.ts#unperceivableFrameDetail` |

## Two things worth knowing before you edit

**`supportedRoles` is computed, not declared.** It is the image of `ARIA_ROLE_MAP`, so the linker's
load-time refusal is checked against what the driver can really emit. One consequence: this driver
never emits the role `text`, because a run of page text is Chromium's internal role `StaticText`.
Nothing is lost - such a node keeps its `name` and its `text`, and `text-present` scans both fields
on every node - except the ability to make a text run an action target, which is correct to lose.

**Masking decodes and re-encodes the PNG.** SPEC section 8.4 says regions are blanked "before the
bytes exist" and names `page.screenshot({ mask })` as the mechanism. `mask` takes `Locator[]` and has
no coordinate form, while what crosses this port is *rectangles* (the character-grid driver has no
locators at all), and the only node → `Locator` bridge is `aria-ref`, an undocumented selector engine
absent from `types.d.ts`. So this driver blanks the raster in process: the unmasked buffer is a local
that is never returned, never digested, never written and never logged. The invariant the rule exists
for holds; the literal words do not. `src/png.ts` carries the argument in full.

## Tests

```
pnpm -F @crr/surface-browser test
```

Two halves. The **hermetic** half (`normalize`, `frames`, `geometry`, `routes`, `png`, `roles`,
`capture-sink`) runs in milliseconds from frozen `AxNode` arrays with no browser and no server. The
**browser** half (`browser-*.test.ts`) boots `fixtures/corebank-web` on an **ephemeral port** and
drives a locally launched Chromium; it skips with a clear message if no Chromium is installed.
Nothing in either half reaches the public internet and nothing needs a credential.
