# Spike code - browser surface

Working scratch code from `docs/design/spike-browser-surface.md`. **Not part of the build.** It is
kept because every number, role histogram and error string in that document came out of these files,
and `/private/tmp` does not survive a reboot.

Reproduce (no repo install needed; `playwright` is the only dependency):

```bash
mkdir -p /tmp/spike && cd /tmp/spike
cp -R <this dir>/. .
printf '{"name":"s","private":true,"type":"module","dependencies":{"playwright":"1.62.1"}}' > package.json
npm install && npx playwright install chromium
node server.mjs &                  # serves fixture/ on 127.0.0.1:8731 AND localhost:8732

node exp1-api-inventory.mjs        # §1.1  what exists on Page in 1.62.1
node exp2-aria-snapshot.mjs        # §1.2  ariaSnapshot({mode:'ai',boxes:true}) over the frameset
node exp3-ariaref-act.mjs          # §3.1  aria-ref resolution + action across frames
node exp4-ref-lifecycle.mjs        # §7.2  when an aria-ref goes stale
node exp5-cdp-axtree.mjs           # §2.1  getFullAXTree returns 7 nodes on a frameset
node exp6-cdp-frames.mjs           # §2.2  the three ways to reach child-frame trees
node exp7-node-to-action.mjs       # §3.1  backendDOMNodeId -> resolveNode / getBoxModel
node exp8-bridges.mjs              # §3.1  four AX-node-to-action routes, measured
node exp8d-route-d.mjs             # §1.4  Playwright strict mode catches the layout-table ambiguity
node exp9-tables.mjs               # §5.1  role histogram of the legacy grid
node exp10-roles-and-state.mjs     # §1.4  ariaSnapshot vs CDP, side by side; AX state properties
node exp11-oopif.mjs               # §2.4  cross-origin iframe, default Chromium
node exp12b-oopif.mjs              # §2.4  same, with --site-per-process (a real OOPIF)
node exp13-geometry.mjs            # §4    hidden/zero/off-screen boxes, scrolling, screenshot masking
node exp14-perceive.mjs            # §6    the reference perceive() end to end
node exp15-edges.mjs               # §5.3  ambiguity detection, layout-table folding, frame ordinals
node exp16-dialogs.mjs             # §7.1  a native dialog blocks perception
node exp17-modal-bounds.mjs        # §7.1  an in-page role=dialog modal is perceivable
node exp18-dialog-default.mjs      # §7.1  with NO handler, Playwright silently dismisses the dialog
node bench.mjs                     # §6.2  perception cost
```

**Three scripts exit non-zero on purpose**, because the failure *is* the finding:
`exp3-ariaref-act.mjs` (an `aria-ref` goes stale after its frame navigates),
`exp8-bridges.mjs` (`filter({has})` rejects a cross-frame inner locator) and
`exp8d-route-d.mjs` (Playwright strict mode refuses the layout-table ambiguity, §1.4).
The other fifteen exit 0. Verified from a clean copy of this directory on 2026-08-27.

`perceive.mjs` is the reference Surface-driver perception function the document recommends.
`png.mjs` is a ~30-line PNG decoder used only to verify screenshot masking at the pixel level.
`fixture/` is the hostile legacy fixture: frameset, nested layout tables, `<font>` tags, generated
ids, no test IDs. All data in it is obviously synthetic.
