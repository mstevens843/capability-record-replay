// The demo bundle is reproducible, or it is not evidence.
//
// `pnpm demo` is the command a reviewer runs, and the repository's whole claim is that a replay is
// deterministic. A bundle whose file count moves between runs on the same inputs contradicts that
// before anybody reads a line of the report - so the two ways it was moving are pinned here.
//
// Both were REPRODUCED before they were fixed, and both reproductions are cheap enough to keep:
//
//   * two `pnpm demo` processes writing one bundle left 2 journal blobs in all five scenario
//     directories, 8 stray files, and BOTH printed `DEMO OK` and exited 0. The hermetic version of
//     that is two `FileEvidenceSink`s over one directory, below - no browser, no fixture, 3ms.
//   * a demo pointed at a scratch bundle wrote its CLI journal blob into the COMMITTED one,
//     because `cliReplay()` passed repo-relative `evidence/...` paths to the subprocess while every
//     other writer honoured `CRR_DEMO_EVIDENCE_DIR`. That one is a source scan, in
//     `demo-contract.test.ts`, because the defect is a string literal.
//
// The audit's rule is not "the count is 65". It is that every blob directory holds exactly what the
// run that owns it says it wrote, checked against that run's own `result.json` - so it keeps
// working when a scenario is added, and it fails when a file appears that no run claims.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireBundleLock,
  auditBlobDir,
  auditBundleBlobs,
  blobFileNameOf,
  bundleLockPath,
  releaseBundleLock,
} from "../demo/integrity.js";
import { FileEvidenceSink } from "../src/evidence.js";

const scratch = (): string => mkdtempSync(join(tmpdir(), "crr-demo-integrity-"));

const REF_A = "journal:1111111111111111111111111111111111111111111111111111111111111111";
const REF_B = "journal:2222222222222222222222222222222222222222222222222222222222222222";
const OBS_A = "obs:3333333333333333333333333333333333333333333333333333333333333333";
const OBS_B = "obs:4444444444444444444444444444444444444444444444444444444444444444";

describe("the blob-directory audit", () => {
  it("passes a directory holding exactly what the run declared", () => {
    expect(
      auditBlobDir({
        label: "replay-04/observations",
        files: [blobFileNameOf(REF_A), blobFileNameOf(OBS_A)],
        declared: [OBS_A, REF_A],
      }),
    ).toEqual([]);
  });

  it("CATCHES THE SECOND RUN: two journal blobs in one directory", () => {
    // The exact shape two concurrent demos leave behind, and the reason the file count moved.
    const complaints = auditBlobDir({
      label: "replay-01-green/observations",
      files: [blobFileNameOf(REF_A), blobFileNameOf(REF_B)],
      declared: [REF_A],
    });
    expect(complaints.some((c) => c.includes("2 journal blobs"))).toBe(true);
    expect(complaints.some((c) => c.includes("more than one run"))).toBe(true);
    // And the one the result document does not name is reported by name, not just counted.
    expect(complaints.some((c) => c.includes(blobFileNameOf(REF_B)))).toBe(true);
  });

  it("catches a stray observation no result document names", () => {
    expect(
      auditBlobDir({
        label: "replay-02/observations",
        files: [blobFileNameOf(REF_A), blobFileNameOf(OBS_A), blobFileNameOf(OBS_B)],
        declared: [REF_A, OBS_A],
      }),
    ).toEqual([
      `replay-02/observations/${blobFileNameOf(OBS_B)} is in the bundle but not in this run's result document`,
    ]);
  });

  it("catches a blob the result document promised and the bundle does not have", () => {
    // The other direction, and the one that matters to a reviewer: `result.json` says the failed
    // arm has a frozen screen attached and the file is not there.
    expect(
      auditBlobDir({
        label: "replay-05/observations",
        files: [blobFileNameOf(REF_A)],
        declared: [REF_A, OBS_A],
      }),
    ).toEqual([
      `replay-05/observations/${blobFileNameOf(OBS_A)} is named by the result document but is not on disk`,
    ]);
  });

  it("catches a directory no run wrote at all", () => {
    expect(auditBlobDir({ label: "replay-01/observations", files: [], declared: [] })).toEqual([
      "replay-01/observations holds no journal blob, so no run wrote it",
    ]);
  });

  it("catches a file that is not a content-addressed blob, and does not report it twice", () => {
    const complaints = auditBlobDir({
      label: "cli-replay/observations",
      files: [blobFileNameOf(REF_A), "notes.txt"],
      declared: [REF_A],
    });
    expect(complaints).toEqual([
      "cli-replay/observations/notes.txt is not a content-addressed blob and should not be here",
    ]);
  });

  it("still applies the journal rule when no result document is available", () => {
    // `cli-replay/` is written by a subprocess whose result document this bundle does not keep, so
    // the ref list is unknown. The half that catches another run's leftovers still holds.
    expect(
      auditBlobDir({
        label: "cli-replay/observations",
        files: [blobFileNameOf(REF_A), blobFileNameOf(OBS_A)],
        declared: null,
      }),
    ).toEqual([]);
    expect(
      auditBlobDir({
        label: "cli-replay/observations",
        files: [blobFileNameOf(REF_A), blobFileNameOf(REF_B)],
        declared: null,
      }).length,
    ).toBe(1);
  });

  it("reports a claimed directory that is not there", () => {
    const dir = scratch();
    expect(
      auditBundleBlobs([{ label: "replay-09/observations", dir: join(dir, "nope"), declared: [] }]),
    ).toEqual([
      "replay-09/observations does not exist, and a run that happened would have made it",
    ]);
  });
});

describe("the audit against the real evidence sink", () => {
  it("names blobs exactly as `FileEvidenceSink` writes them", () => {
    // The audit compares file names to refs, so it is wrong the moment the sink's naming changes.
    // Checked against the sink itself rather than against a copy of its rule.
    const dir = scratch();
    const sink = new FileEvidenceSink(dir);
    const ref = sink.putJson("journal", [{ type: "run.finished", status: "ok" }]);
    expect(readdirSync(dir)).toEqual([blobFileNameOf(ref)]);
    expect(auditBlobDir({ label: "d", files: readdirSync(dir), declared: [ref] })).toEqual([]);
  });

  it("REPRODUCES the concurrent-demo corruption, hermetically, and fails on it", () => {
    // Two runs, one directory, different content - which is what two `pnpm demo` processes do to a
    // scenario directory, because a journal carries its own run's timestamps and is content
    // addressed. No browser and no fixture: the corruption is a property of the sink, not of the
    // surface.
    const dir = scratch();
    const first = new FileEvidenceSink(dir);
    const mine = first.putJson("journal", [{ at: "2026-08-28T00:00:00.000Z" }]);
    const second = new FileEvidenceSink(dir);
    second.putJson("journal", [{ at: "2026-08-28T00:00:01.000Z" }]);

    expect(readdirSync(dir)).toHaveLength(2);
    const complaints = auditBundleBlobs([
      { label: "replay-01-green/observations", dir, declared: [mine] },
    ]);
    expect(complaints.some((c) => c.includes("2 journal blobs"))).toBe(true);
    expect(complaints.length).toBeGreaterThan(0);
  });
});

describe("the bundle lock", () => {
  const dead = (): boolean => false;
  const alive = (): boolean => true;

  it("lives OUTSIDE the bundle, so it can never change the file count", () => {
    const dir = scratch();
    expect(bundleLockPath(dir).startsWith(dir)).toBe(false);
    acquireBundleLock(dir);
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
    releaseBundleLock(bundleLockPath(dir));
  });

  it("is one lock per bundle: same directory, same path; different directory, different path", () => {
    const a = scratch();
    const b = scratch();
    expect(bundleLockPath(a)).toBe(bundleLockPath(a));
    expect(bundleLockPath(a)).not.toBe(bundleLockPath(b));
  });

  it("REFUSES a second writer while the first is alive, and says who holds it", () => {
    const dir = scratch();
    const first = acquireBundleLock(dir, alive);
    expect(first.ok).toBe(true);
    const second = acquireBundleLock(dir, alive);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.holder.pid).toBe(process.pid);
      expect(second.holder.bundle).toBe(dir);
    }
    releaseBundleLock(bundleLockPath(dir));
  });

  it("lets the next run in once the lock is released", () => {
    const dir = scratch();
    expect(acquireBundleLock(dir, alive).ok).toBe(true);
    releaseBundleLock(bundleLockPath(dir));
    expect(existsSync(bundleLockPath(dir))).toBe(false);
    const again = acquireBundleLock(dir, alive);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.tookOver).toBeNull();
    releaseBundleLock(bundleLockPath(dir));
  });

  it("TAKES OVER a lock whose process is gone, and says whose it was", () => {
    // A Ctrl-C leaves the file behind. A build script that then requires a human to delete a file
    // is a build script people learn to work around, so the stale case is handled rather than
    // reported. `isAlive` is injected because this cannot be exercised by killing the test.
    const dir = scratch();
    writeFileSync(
      bundleLockPath(dir),
      `${JSON.stringify({ pid: 424242, at: "2026-08-27T21:00:00.000Z", bundle: dir })}\n`,
    );
    const taken = acquireBundleLock(dir, dead);
    expect(taken.ok).toBe(true);
    if (taken.ok) expect(taken.tookOver?.pid).toBe(424242);
    // And the file is now ours, not theirs.
    expect(JSON.parse(readFileSync(bundleLockPath(dir), "utf8")).pid).toBe(process.pid);
    releaseBundleLock(bundleLockPath(dir));
  });

  it("treats a half-written lock file as stale rather than as a holder", () => {
    const dir = scratch();
    writeFileSync(bundleLockPath(dir), "{ this is not json");
    const taken = acquireBundleLock(dir, alive);
    expect(taken.ok).toBe(true);
    releaseBundleLock(bundleLockPath(dir));
  });

  it("never removes a lock this process does not hold", () => {
    const dir = scratch();
    const path = bundleLockPath(dir);
    writeFileSync(path, `${JSON.stringify({ pid: 424242, at: "x", bundle: dir })}\n`);
    releaseBundleLock(path);
    expect(existsSync(path)).toBe(true);
    // Cleaned up through the takeover path, which is the only one entitled to it.
    acquireBundleLock(dir, dead);
    releaseBundleLock(path);
    expect(existsSync(path)).toBe(false);
  });

  it("does not block two demos writing two different bundles", () => {
    const a = scratch();
    const b = scratch();
    expect(acquireBundleLock(a, alive).ok).toBe(true);
    expect(acquireBundleLock(b, alive).ok).toBe(true);
    releaseBundleLock(bundleLockPath(a));
    releaseBundleLock(bundleLockPath(b));
  });

  it("makes the directory it locks if the bundle has never been produced", () => {
    // `pnpm demo` on a fresh clone: the lock is taken before `clearOwned()` creates the bundle.
    const dir = join(scratch(), "evidence");
    expect(existsSync(dir)).toBe(false);
    const taken = acquireBundleLock(dir, alive);
    expect(taken.ok).toBe(true);
    mkdirSync(dir, { recursive: true });
    releaseBundleLock(bundleLockPath(dir));
  });
});
