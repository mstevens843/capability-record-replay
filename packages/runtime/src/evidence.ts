// The evidence sink: content-addressed blobs, and the one place a frozen `Observation` is written
// down.
//
// SPEC section 2.6 puts an `observationRef` on the failed arm and calls it "the file that turns a
// production failure into a `classify()` unit test with no reproduction step". That is the whole
// point of this module and it is why the ref is content-addressed: two runs that failed on the same
// screen write one file, and a conformance corpus assembled from real failures deduplicates itself.
//
// REDACTION APPLIES HERE, and it is not optional. An observation off a member screen holds the
// member's name, their balance and - because a legacy app prints back what you typed - the member
// number the caller supplied. `redactObservation` substitutes every non-literal binding's value for
// its taint handle before a byte is written, exactly as `observedSummaryOf` does on the way into a
// journal. Two mechanisms rather than one because they cover different structures, and the redaction
// canary in the evidence bundle greps for both.
//
// EVERY page-derived string is scrubbed, not only the obvious ones. `name`, `value`, `text` and
// `description` are the fields a reviewer thinks of; `containerPath`, `tablePosition.rowHeader` and
// `route.query` are the three that actually leaked, and the last of them was found by the canary
// rather than by review. The list is: node text, container breadcrumbs, table row/column headers,
// the native dialog, and the route.
//
// What is NOT redacted: an artifact literal. It is typed `public` by construction and it is the
// artifact's own text; blanking it would remove the one thing that makes a SPEC row-5 failure -
// "the value baked into this step was rejected" - readable at all.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ContainerSegment,
  type EvidenceRef,
  type NativeDialog,
  type Observation,
  type ResolvedBindings,
  type RouteLocation,
  type UINode,
  digestOf,
  redactTaint,
} from "@crr/core";
import { evidenceRefOf } from "./ids.js";

export interface EvidenceSink {
  /** Freeze one observation. Returns the ref that goes on a `StepTrace` and on the failed arm. */
  putObservation(observation: Observation, bindings: ResolvedBindings): EvidenceRef;
  /** Any other JSON artefact of a run - the result document, an intervention brief. */
  putJson(kind: string, value: unknown): EvidenceRef;
  /** Every ref this sink minted, in order, for `RunEnvelope.evidence`. */
  refs(): readonly EvidenceRef[];
}

/**
 * Substitute every bound caller value in an observation for its taint handle.
 *
 * Node by node rather than by stringifying the whole document, so the count of substitutions is
 * real and a node that was already blanked by the driver (`masked: true`) stays blanked rather than
 * being re-serialized from a value that is no longer there.
 */
export function redactObservation(
  observation: Observation,
  bindings: ResolvedBindings,
): { readonly observation: Observation; readonly redactions: number } {
  let redactions = 0;
  const scrub = (value: string | null): string | null => {
    if (value === null) return null;
    const out = redactTaint(value, bindings);
    redactions += out.redactions;
    return out.text;
  };
  /**
   * A container breadcrumb is page text too.
   *
   * Every arm of this union carries a string lifted off the screen - a frame name, a landmark's
   * accessible name, a heading, a table's column headers - and a legacy application that prints
   * "Member 10041" as an `<h2>` puts the caller's argument into `containerPath` on every node
   * underneath it. Scrubbing only `node.name` would leave one copy of the value per node.
   */
  const scrubSegment = (segment: ContainerSegment): ContainerSegment => {
    switch (segment.kind) {
      case "frame":
        return { ...segment, name: scrub(segment.name) ?? segment.name };
      case "landmark":
        return { ...segment, name: scrub(segment.name) };
      case "heading-section":
        return { ...segment, heading: scrub(segment.heading) ?? "" };
      case "table":
        return { ...segment, headers: segment.headers.map((h) => scrub(h) ?? "") };
      case "screen":
        return { ...segment, id: scrub(segment.id) ?? segment.id };
    }
  };

  const nodes: UINode[] = observation.nodes.map((node) => ({
    ...node,
    name: scrub(node.name) ?? "",
    value: scrub(node.value),
    text: scrub(node.text),
    description: scrub(node.description),
    containerPath: node.containerPath.map(scrubSegment),
    // A results grid's row header IS the key the row was found by, which on this product is the
    // member number. `tablePosition` is derived from the page, not from the artifact, so it is
    // subject to the taint model exactly as `name` is.
    tablePosition:
      node.tablePosition === null
        ? null
        : {
            ...node.tablePosition,
            rowHeader: scrub(node.tablePosition.rowHeader),
            colHeader: scrub(node.tablePosition.colHeader),
          },
  })) as UINode[];

  /**
   * THE ROUTE, AND WHY IT IS NOT ALREADY SAFE.
   *
   * `RouteLocationSchema`'s doc comment says a canonicalized path cannot carry a member number,
   * and for the PATH that is true - `/member/10041` canonicalizes to `/member/:memberId` before an
   * observation is built. It says nothing about the QUERY, and a frameset-era application submits
   * its search form by GET: the frozen observation of a results screen carried
   * `?ctl00$ctl32$g$9a1$txtMemberId=99999` verbatim.
   *
   * This was found by the evidence bundle's redaction canary on its first run over a real replay,
   * which is precisely the class of miss a canary exists for: every mechanism was correct and one
   * field was never passed through one. The path is scrubbed too, as defence in depth against a
   * driver that fails to canonicalize.
   */
  const route: RouteLocation | null =
    observation.route === null
      ? null
      : ({
          ...observation.route,
          path: scrub(observation.route.path) ?? observation.route.path,
          query: Object.fromEntries(
            Object.entries(observation.route.query).map(([key, value]) => [
              // The KEY as well: a generated field name is not usually interesting, but a legacy
              // app that names a parameter after its value costs nothing to defend against here.
              scrub(key) ?? key,
              scrub(value) ?? value,
            ]),
          ),
        } as RouteLocation);
  const nativeDialog: NativeDialog | null =
    observation.nativeDialog === null
      ? null
      : ({
          ...observation.nativeDialog,
          message: scrub(observation.nativeDialog.message) ?? "",
          defaultValue: scrub(observation.nativeDialog.defaultValue),
        } as NativeDialog);
  // `skeletonDigest` is deliberately NOT recomputed. It is the driver's statement about the screen
  // it saw, the settle window was keyed on it, and a digest that changed because we redacted a name
  // afterwards would make a saved observation disagree with the journal that recorded it.
  return { observation: { ...observation, route, nodes, nativeDialog } as Observation, redactions };
}

abstract class BaseEvidenceSink implements EvidenceSink {
  #refs: EvidenceRef[] = [];

  putObservation(observation: Observation, bindings: ResolvedBindings): EvidenceRef {
    const { observation: safe } = redactObservation(observation, bindings);
    return this.putJson("obs", safe);
  }

  putJson(kind: string, value: unknown): EvidenceRef {
    const ref = evidenceRefOf(kind, digestOf(value));
    this.store(ref, `${JSON.stringify(value, null, 2)}\n`);
    this.#refs.push(ref);
    return ref;
  }

  refs(): readonly EvidenceRef[] {
    // Deduplicated on the way out rather than on the way in: `putJson` returning the same ref twice
    // for the same bytes is the content-addressing working, and the run should still say it read
    // that screen twice.
    return [...new Set(this.#refs)];
  }

  protected abstract store(ref: EvidenceRef, body: string): void;
}

export class MemoryEvidenceSink extends BaseEvidenceSink {
  readonly #blobs = new Map<string, string>();

  protected override store(ref: EvidenceRef, body: string): void {
    this.#blobs.set(ref, body);
  }

  get(ref: EvidenceRef): unknown {
    const body = this.#blobs.get(ref);
    return body === undefined ? null : JSON.parse(body);
  }

  get size(): number {
    return this.#blobs.size;
  }
}

/** One file per ref under a directory. The ref IS the filename, so a journal line naming a ref is
 *  a path a person can open with no index in between. */
export class FileEvidenceSink extends BaseEvidenceSink {
  readonly #dir: string;

  constructor(dir: string) {
    super();
    this.#dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  get dir(): string {
    return this.#dir;
  }

  pathOf(ref: EvidenceRef): string {
    return join(this.#dir, `${ref.replace(":", "-")}.json`);
  }

  protected override store(ref: EvidenceRef, body: string): void {
    writeFileSync(this.pathOf(ref), body);
  }

  read(ref: EvidenceRef): unknown {
    return JSON.parse(readFileSync(this.pathOf(ref), "utf8"));
  }
}
