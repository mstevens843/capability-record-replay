// The transport port, and the claim it rests on: THE TRANSPORT IS NOT OBSERVABLE ABOVE THE EMULATOR.
//
// Everywhere else in this suite the fixture runs in this process behind an in-memory transport,
// which is fast, hermetic and free. That is only legitimate if driving the SAME fixture as a real
// child process over real pipes produces the same grid - otherwise the whole suite is testing a
// convenient fake.
//
// So this file spawns `fixtures/corebank-tui/src/main.js`, drives it over stdio pipes, and asserts
// the resulting grid is byte-identical to the committed one the in-memory harness produced. The
// spike made the same comparison one rung lower, between a pipe and a real pty, and got the same
// sha256 over 1.28 MB of serialized grids. Together those two results are the evidence for shipping
// `pipe` and leaving `node-pty` out of this package entirely.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { encodeGrid } from "../src/grid-codec.js";
import { TerminalSurface } from "../src/surface.js";
import { type PipeTransport, createPipeTransport } from "../src/transport.js";
import { RAW_CORPUS } from "./support/corpus.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_MAIN = resolve(here, "../../../fixtures/corebank-tui/src/main.js");

let open: { surface: TerminalSurface; transport: PipeTransport } | null = null;

afterEach(async () => {
  if (open !== null) await open.surface.close();
  open = null;
});

async function spawnTeller(env: Record<string, string> = {}) {
  const transport = createPipeTransport({
    command: process.execPath,
    args: [FIXTURE_MAIN],
    env,
  });
  const surface = new TerminalSurface({ transport, quietMs: 60 });
  open = { surface, transport };
  await quiet(surface, 0);
  return { surface, transport };
}

/**
 * Poll `perceive` until the surface has received NEW bytes and then gone quiet, bounded.
 *
 * `afterBytes` is not defensive padding. A surface that already settled on the previous frame is
 * still settled one millisecond after a keystroke goes out, so a settle loop that only asks "are
 * you quiet" answers yes about the screen it was already looking at. That is the same false
 * success the torn-read case makes with the opposite timing, and it is why the executor's real
 * settle loop compares skeleton digests across a window rather than trusting one `settled: true`.
 */
async function quiet(surface: TerminalSurface, afterBytes = -1, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await surface.perceive({ deadlineMs: 1_000 });
    if (result.ok && result.observation.stability.settled && surface.bytesReceived > afterBytes) {
      return;
    }
    if (Date.now() > deadline) throw new Error("the spawned fixture never settled");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("the pipe transport, against the fixture as a real child process", () => {
  it("produces the SAME grid the in-process harness committed to the corpus", async () => {
    const { surface } = await spawnTeller();
    await surface.drain();
    expect(encodeGrid(surface.snapshot())).toEqual(RAW_CORPUS.initial);
  });

  it("perceives the inquiry screen through the port", async () => {
    const { surface } = await spawnTeller();
    const result = await surface.perceive({ deadlineMs: 2_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observation.nodes.map((n) => n.id)).toContain("textbox:account-number");
    expect(result.observation.nodes[0]?.containerPath[0]).toEqual({
      kind: "screen",
      id: "MEMBER INQUIRY 01",
    });
  });

  it("carries keystrokes to the child and the repaint back", async () => {
    const { surface, transport } = await spawnTeller();
    const before = surface.bytesReceived;
    transport.write("12345\r");
    await quiet(surface, before);
    const result = await surface.perceive({ deadlineMs: 2_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observation.nodes[0]?.containerPath[0]).toEqual({
      kind: "screen",
      id: "ACCOUNT LIST 02",
    });
  });

  it("configures the tenant through the environment, and the exit key follows", async () => {
    const { surface } = await spawnTeller({ TENANT: "summit" });
    const result = await surface.perceive({ deadlineMs: 2_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Same node id as riverbend. The key behind it is not the same, and the artifact never says so.
    expect(result.observation.nodes.map((n) => n.id)).toContain("button:exit");
    expect(result.observation.nodes[0]?.containerPath[0]).toEqual({
      kind: "screen",
      id: "MBR INQ 01",
    });
  });

  it("shuts the child down when the surface closes", async () => {
    const { surface, transport } = await spawnTeller();
    await surface.close();
    open = null;
    expect(transport.child.killed || transport.child.exitCode !== null).toBe(true);
  });
});
