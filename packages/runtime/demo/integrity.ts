// The two things that make `pnpm demo` produce the SAME bundle twice: a lock, and an audit.
//
// The bundle is a deliverable a reviewer runs, and the central claim of this repository is
// deterministic replay. A run that writes a different number of files each time contradicts the
// claim before anyone reads a line of it. Two defects were producing exactly that, and both were
// reproduced in this tree rather than reasoned about:
//
//   1. TWO DEMOS AT ONCE. `clearOwned()` runs at the start of a run and every blob is named by the
//      digest of its own contents, so a second process that starts while the first is running
//      deletes nothing of its own and adds a second, differently-named journal blob to every
//      scenario directory. Measured: two concurrent runs against one bundle left **2 journal blobs
//      in all five scenario directories**, 8 stray files in total - and BOTH processes printed
//      `DEMO OK`, an inflated file count, and exited 0. That is the whole failure: not a wrong
//      number, but a bundle that describes a run nobody performed, blessed by a self-check that
//      could not see it.
//
//   2. A RUN POINTED SOMEWHERE ELSE STILL WROTE HERE. `cliReplay()` invoked the shipped binary with
//      repo-relative `evidence/...` paths while every other writer honoured
//      `CRR_DEMO_EVIDENCE_DIR`, so a demo run against a scratch directory - the documented way to
//      exercise the `discovery-live` guard - wrote its journal blob into the COMMITTED bundle.
//      Measured the same way: two scratch runs left `evidence/cli-replay/observations/` holding
//      three journal blobs and the tracked bundle at 67 files. Fixed at the call site by deriving
//      those paths from the bundle directory; this module is what stops it coming back silently.
//
// THE INVARIANT THIS FILE ENFORCES. Every directory of content-addressed blobs in the bundle holds
// exactly the blobs the run that owns it says it wrote - no more, no fewer - and one replay writes
// exactly one journal blob. That is checkable against the run's own `result.json`, which lists
// every ref its evidence sink minted, so the audit compares the bundle against the document a
// reviewer would read rather than against a number somebody typed.
//
// WHY A LOCK AS WELL AS AN AUDIT. The audit detects; the lock prevents. Detecting after the fact
// still leaves a corrupt bundle on disk and two processes racing over the next one, and the
// standing mitigation before this change was a sentence in a design document telling the author to
// run the demo alone. This repository's own argument about the control lease applies to its build
// script too: enforcement, not convention.
//
// The lock does NOT live inside the bundle. A bundle whose file count depends on whether a lock
// file happened to be there is the bug this module exists to remove, so it lives in the system
// temporary directory under a name derived from the bundle's absolute path - one lock per bundle,
// and two demos writing two different bundles do not block each other.

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { sha256Bytes } from "@crr/core";

// ---------------------------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------------------------

/** `<kind>-<64 hex>.json`, which is what `FileEvidenceSink.pathOf` writes and nothing else. */
const BLOB_FILE = /^(journal|obs)-[0-9a-f]{64}\.json$/;

/** The file name an `EvidenceRef` is stored under. Mirrors `FileEvidenceSink.pathOf`. */
export function blobFileNameOf(ref: string): string {
  return `${ref.replace(":", "-")}.json`;
}

export interface BlobDirClaim {
  /** How this directory is named in a complaint - a bundle-relative path, not an absolute one. */
  readonly label: string;
  /** Absolute path of the directory holding the blobs. */
  readonly dir: string;
  /**
   * Every `EvidenceRef` the owning run declared, or `null` when the owner is a subprocess whose
   * result document this bundle does not keep. `null` weakens the check to the journal rule, which
   * is the half that catches a second run's leftovers.
   */
  readonly declared: readonly string[] | null;
}

/**
 * The pure half: given what is on disk and what the run declared, say what is wrong.
 *
 * Pure so that the interesting cases - a stray blob, two journals, a missing file the result
 * document promised - are unit-testable with no demo, no browser and no directory.
 */
export function auditBlobDir(input: {
  readonly label: string;
  readonly files: readonly string[];
  readonly declared: readonly string[] | null;
}): readonly string[] {
  const complaints: string[] = [];
  const files = [...input.files].sort();

  const foreign = files.filter((file) => !BLOB_FILE.test(file));
  for (const file of foreign) {
    complaints.push(
      `${input.label}/${file} is not a content-addressed blob and should not be here`,
    );
  }

  const journals = files.filter((file) => file.startsWith("journal-"));
  if (journals.length === 0) {
    complaints.push(`${input.label} holds no journal blob, so no run wrote it`);
  } else if (journals.length > 1) {
    complaints.push(
      `${input.label} holds ${journals.length} journal blobs and one replay writes exactly one - ${journals.join(", ")} - so more than one run has written into this directory`,
    );
  }

  if (input.declared !== null) {
    const expected = new Set(input.declared.map(blobFileNameOf));
    for (const file of files) {
      if (!expected.has(file) && !foreign.includes(file)) {
        complaints.push(
          `${input.label}/${file} is in the bundle but not in this run's result document`,
        );
      }
    }
    for (const want of [...expected].sort()) {
      if (!files.includes(want)) {
        complaints.push(
          `${input.label}/${want} is named by the result document but is not on disk`,
        );
      }
    }
  }
  return complaints;
}

/** The disk-facing half. Reads each claimed directory and audits it. */
export function auditBundleBlobs(claims: readonly BlobDirClaim[]): readonly string[] {
  const complaints: string[] = [];
  for (const claim of claims) {
    if (!existsSync(claim.dir)) {
      complaints.push(`${claim.label} does not exist, and a run that happened would have made it`);
      continue;
    }
    complaints.push(
      ...auditBlobDir({
        label: claim.label,
        files: readdirSync(claim.dir),
        declared: claim.declared,
      }),
    );
  }
  return complaints;
}

// ---------------------------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------------------------

export interface LockHolder {
  readonly pid: number;
  readonly at: string;
  readonly bundle: string;
}

export type LockResult =
  /** The lock is ours. `tookOver` names a dead process whose lock file we removed, if there was one. */
  | { readonly ok: true; readonly path: string; readonly tookOver: LockHolder | null }
  /** Somebody else is writing this bundle right now. */
  | { readonly ok: false; readonly path: string; readonly holder: LockHolder };

/**
 * One lock per bundle, outside the bundle.
 *
 * The digest of the absolute path rather than the path itself: a bundle directory can be anywhere,
 * including somewhere with a separator or a space in it, and a lock file name is not a place to
 * find that out. The readable basename is kept in front of it so a person looking at their
 * temporary directory can tell what the file is.
 */
export function bundleLockPath(evidenceDir: string): string {
  const key = sha256Bytes(Buffer.from(evidenceDir, "utf8")).slice(0, 16);
  return join(tmpdir(), `crr-demo-${basename(evidenceDir)}-${key}.lock`);
}

/** Whether a pid is a process that still exists. `EPERM` means it exists and is not ours. */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readHolder(path: string): LockHolder | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockHolder>;
    if (typeof parsed.pid !== "number") return null;
    return {
      pid: parsed.pid,
      at: typeof parsed.at === "string" ? parsed.at : "an unrecorded time",
      bundle: typeof parsed.bundle === "string" ? parsed.bundle : "an unrecorded bundle",
    };
  } catch {
    // An unreadable or half-written lock file is not evidence that anybody is running; it is
    // evidence that somebody died while writing one. Treated as stale below.
    return null;
  }
}

/**
 * Take the lock, or report who holds it.
 *
 * `wx` is the whole mechanism: `open` with `O_CREAT | O_EXCL` is atomic on every filesystem this
 * runs on, so two processes cannot both believe they have it. A lock file left behind by a crashed
 * run is taken over - after checking the pid is really gone - because a build script that requires
 * a human to delete a file after a Ctrl-C is a build script people learn to work around.
 *
 * `isAlive` is injectable for the same reason every other seam in this repository is: the stale
 * path is the one that matters and it cannot be exercised by killing the test's own process.
 */
export function acquireBundleLock(
  evidenceDir: string,
  isAlive: (pid: number) => boolean = processIsAlive,
): LockResult {
  const path = bundleLockPath(evidenceDir);
  const body = `${JSON.stringify(
    { pid: process.pid, at: new Date().toISOString(), bundle: evidenceDir },
    null,
    2,
  )}\n`;
  let tookOver: LockHolder | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, body, { flag: "wx" });
      return { ok: true, path, tookOver };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readHolder(path);
      if (holder !== null && isAlive(holder.pid)) return { ok: false, path, holder };
      // Stale: whoever wrote it is gone, or never finished writing it. Remember them, remove it,
      // and go round once.
      tookOver = holder;
      rmSync(path, { force: true });
    }
  }
  // Two `EEXIST`s in a row means somebody took it during the takeover. We do not hold it, and
  // saying so is the only honest answer.
  const holder = readHolder(path);
  return {
    ok: false,
    path,
    holder: holder ?? { pid: 0, at: "an unrecorded time", bundle: evidenceDir },
  };
}

/** Release a lock this process holds. Idempotent, and it never removes somebody else's. */
export function releaseBundleLock(path: string): void {
  const holder = readHolder(path);
  if (holder !== null && holder.pid !== process.pid) return;
  rmSync(path, { force: true });
}
