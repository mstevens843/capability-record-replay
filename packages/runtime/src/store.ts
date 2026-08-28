// A file-backed document store, and deliberately nothing more.
//
// BRIEF section 8 rules out a database, and SPEC section 1.2 rules out a `@crr/store` package on the
// grounds that "a package for `readFile` is the definition of theatre". So this is one class in the
// package that already owns the disk.
//
// The layout is content-addressed with a name index on top:
//
//   <root>/contracts/<name>@<version>.json      one file per contract version
//   <root>/artifacts/<artifactId>@<version>.json
//   <root>/overlays/<artifactId>@<tenantId>.json
//
// Digest-addressing would be purer and is wrong here: a human has to be able to open the directory
// and see which artifact is which, and `sha256-9f3c….json` does not survive contact with a person
// debugging at 2am. The digest is still the identity - `parseArtifact` re-derives it on load and
// refuses a document whose bytes have been edited under an approval - so the filename is a label,
// never a trust boundary.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CapabilityArtifact,
  type CapabilityContract,
  type CapabilityOverlay,
  parseArtifact,
  parseContract,
  parseOverlay,
} from "@crr/core";

export class DocumentStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentStoreError";
  }
}

const CONTRACTS = "contracts";
const ARTIFACTS = "artifacts";
const OVERLAYS = "overlays";

export class FileDocumentStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
    for (const dir of [CONTRACTS, ARTIFACTS, OVERLAYS]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
  }

  get root(): string {
    return this.#root;
  }

  // -- writes ---------------------------------------------------------------------------------

  putContract(contract: CapabilityContract): string {
    const path = join(this.#root, CONTRACTS, `${contract.name}@${contract.version}.json`);
    writeFileSync(path, `${JSON.stringify(contract, null, 2)}\n`);
    return path;
  }

  putArtifact(artifact: CapabilityArtifact): string {
    const path = join(this.#root, ARTIFACTS, `${artifact.artifactId}@${artifact.version}.json`);
    writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
    return path;
  }

  putOverlay(overlay: CapabilityOverlay): string {
    const path = join(
      this.#root,
      OVERLAYS,
      `${overlay.appliesTo.artifactId}@${overlay.tenantId}.json`,
    );
    writeFileSync(path, `${JSON.stringify(overlay, null, 2)}\n`);
    return path;
  }

  // -- reads ----------------------------------------------------------------------------------
  //
  // Every read validates. A store that hands back `JSON.parse` output typed as a document is a
  // store that turns a bad file into a crash four packages away, and the linker's own refusal
  // ("this is not the kind of document this engine runs") is a better message than a TypeError.

  getContract(name: string, version: string): CapabilityContract {
    return parseContract(this.#read(join(CONTRACTS, `${name}@${version}.json`)));
  }

  getArtifact(artifactId: string, version: number): CapabilityArtifact {
    return parseArtifact(this.#read(join(ARTIFACTS, `${artifactId}@${version}.json`)));
  }

  getOverlay(artifactId: string, tenantId: string): CapabilityOverlay | null {
    const relative = join(OVERLAYS, `${artifactId}@${tenantId}.json`);
    if (!existsSync(join(this.#root, relative))) return null;
    return parseOverlay(this.#read(relative));
  }

  /**
   * The newest artifact implementing a contract, or `null`.
   *
   * "Newest" is the highest `version` integer, not the newest mtime: a file copied into place by a
   * deploy has whatever mtime the copy gave it, and picking a program to run on a production
   * banking surface by filesystem metadata is not a thing this should do.
   */
  latestArtifactFor(contractName: string): CapabilityArtifact | null {
    let best: CapabilityArtifact | null = null;
    for (const file of readdirSync(join(this.#root, ARTIFACTS))) {
      if (!file.endsWith(".json")) continue;
      const artifact = parseArtifact(this.#read(join(ARTIFACTS, file)));
      if (artifact.implements.name !== contractName) continue;
      if (best === null || artifact.version > best.version) best = artifact;
    }
    return best;
  }

  #read(relative: string): unknown {
    const path = join(this.#root, relative);
    if (!existsSync(path)) throw new DocumentStoreError(`no document at ${path}`);
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new DocumentStoreError(
        `${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
