// `@crr/surface-browser` - the only package in this repo that may know what a frame or a pixel is.
//
// It implements `@crr/core`'s `Surface` port over Chromium's accessibility tree, read through raw
// CDP rather than through Playwright's accessibility helpers. Three measured findings force that
// choice and they are recorded next to the code that acts on them: `page.accessibility.snapshot()`
// no longer exists in Playwright 1.57+; `Accessibility.getFullAXTree` does not cross a frameset and
// returns seven nodes where the screen has a hundred and twenty-six; and `ariaSnapshot` folds layout
// tables into data tables, which on a page of nested layout tables makes "the row whose Member ID is
// X" resolve to three elements instead of one.
//
// Exports are ordered the way perception runs: roles, frames, normalization, geometry, routes,
// captures, then the driver that puts them together.

export * from "./errors.js";
export * from "./cdp.js";
export * from "./roles.js";
export * from "./frames.js";
export * from "./normalize.js";
export * from "./geometry.js";
export * from "./routes.js";
export * from "./png.js";
export * from "./capture-sink.js";
export * from "./surface.js";
