// The journal writer.
//
// Append-only, sequenced, and VALIDATED on the way out: every event is parsed against
// `JournalEventSchema` before it is written. That looks like belt and braces on a value we
// constructed ourselves two lines earlier, and it is not - the journal is the artifact a
// postmortem reads and the thing REPORT section 3's claims are checked against, so an event that
// silently lost a field is a claim that silently became unfalsifiable. The parse costs microseconds
// and turns that into a loud failure at the moment of writing.
//
// The envelope (`seq`, `runId`, `at`) is stamped here rather than by each call site. A caller that
// had to remember to stamp a sequence number is a caller that eventually writes two events with the
// same one, and the ordering of a journal is the only reason it can be read at all.
//
// WHAT IS NOT IN A JOURNAL LINE, by construction of the schema and re-checked by the redaction
// canary: a bound parameter value, a node id, a cell's contents, a coordinate, a credential. What
// goes in is names, shapes, counts, digests and classes.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type JournalEvent, JournalEventSchema, type RunId } from "@crr/core";
import type { Clock } from "./clock.js";

/** An event minus the envelope this writer stamps. */
export type JournalEventInput = {
  [E in JournalEvent as E["type"]]: Omit<E, "seq" | "runId" | "at">;
}[JournalEvent["type"]];

export interface Journal {
  append(event: JournalEventInput): JournalEvent;
  readonly events: readonly JournalEvent[];
  /** Flush and return where the journal lives, for `RunEnvelope.journalRef`. */
  close(): void;
}

export interface JournalOptions {
  readonly runId: RunId;
  readonly clock: Clock;
}

abstract class BaseJournal implements Journal {
  protected readonly runId: RunId;
  protected readonly clock: Clock;
  #seq = 0;
  #events: JournalEvent[] = [];

  constructor(options: JournalOptions) {
    this.runId = options.runId;
    this.clock = options.clock;
  }

  append(event: JournalEventInput): JournalEvent {
    const parsed = JournalEventSchema.parse({
      ...event,
      seq: this.#seq,
      runId: this.runId,
      at: this.clock.now(),
    }) as JournalEvent;
    this.#seq += 1;
    this.#events.push(parsed);
    this.write(parsed);
    return parsed;
  }

  get events(): readonly JournalEvent[] {
    return this.#events;
  }

  protected abstract write(event: JournalEvent): void;

  close(): void {
    /* nothing to flush by default */
  }
}

/** For tests and for a run whose journal is uploaded rather than written to disk. */
export class MemoryJournal extends BaseJournal {
  protected override write(): void {
    /* the base class already keeps the array */
  }
}

/**
 * JSONL on disk, one event per line, flushed on every append.
 *
 * Synchronous writes on purpose. A journal that is buffered when the process dies is a journal that
 * is missing exactly the events explaining why it died, and this file is small enough that the cost
 * is irrelevant next to a browser round trip.
 */
export class FileJournal extends BaseJournal {
  readonly #path: string;

  constructor(options: JournalOptions & { readonly path: string }) {
    super(options);
    this.#path = options.path;
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, "");
  }

  get path(): string {
    return this.#path;
  }

  protected override write(event: JournalEvent): void {
    appendFileSync(this.#path, `${JSON.stringify(event)}\n`);
  }
}
