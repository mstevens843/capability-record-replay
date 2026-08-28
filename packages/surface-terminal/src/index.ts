// `@crr/surface-terminal` - the second driver behind the `Surface` port, and the reason the port is
// a demonstrated boundary rather than a claim.
//
// An 80x24 character grid over a byte transport. No DOM, no accessibility tree, no selectors; focus
// is a cursor position and readiness is silence. It satisfies the same four methods
// `@crr/surface-browser` satisfies, and the interpreter, the classifier, the descriptors and the
// checkpoint above it cannot tell which one they are driving.
//
// Two dependency decisions are load-bearing and both were measured (docs/design/spike-terminal-
// surface.md):
//
//   `@xterm/headless` for VT parsing. Pure JavaScript, zero runtime dependencies, no native build,
//   so `pnpm install` works for a reviewer with no toolchain. `node-pty@1.1.0` is NOT a dependency
//   of this package at any version: it ships `spawn-helper` without the executable bit and is
//   broken out of the box on darwin-arm64, `pnpm approve-builds` does not fix it, a manual
//   `chmod +x` does not survive the next install, and it has no Linux prebuilds at all.
//
//   A `TerminalTransport` port underneath, with pipes as the shipping implementation. Real green
//   screens are reached over telnet/SSH/TN3270 - a socket, with no client-side pty anywhere - so a
//   pty-only driver models the demo and not the target. The spike measured pipe and pty producing
//   byte-identical grids, so the port costs nothing in fidelity.
//
// Exports are ordered the way perception runs: grid, emulator, transport, detection, mapping, keys,
// capture, then the driver that puts them together.

export * from "./grid.js";
export * from "./grid-codec.js";
export * from "./emulator.js";
export * from "./transport.js";
export * from "./detect.js";
export * from "./observe.js";
export * from "./keys.js";
export * from "./capture-sink.js";
export * from "./surface.js";
