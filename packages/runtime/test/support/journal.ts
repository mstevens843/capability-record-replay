// Reading a journal back, with the narrowing TypeScript will not give us.
//
// `@crr/core`'s `JournalEvent` is a `z.discriminatedUnion("type", …)` whose members are built by a
// helper taking `type: string` rather than a generic literal parameter, so `z.literal(type)` infers
// `ZodLiteral<string>` and every member's discriminant widens to `string`. The RUNTIME validation is
// unaffected - the schema still holds the real literal and `parse` still refuses a wrong `type` -
// but `event.type === "acted"` narrows nothing, so reading a journal back in a test is untyped.
//
// This is a one-line fix in `packages/core/src/journal.ts` (`<K extends string, T extends …>(type:
// K, shape: T)`), and it is REPORTED rather than made here: `@crr/core` is complete and verified,
// and unit 11 does not get to edit it on its way past. Until then, this file is where the
// unavoidable cast lives - once, named, with the reason attached - instead of thirty times across
// the suite.

import type { JournalEvent, JournalEventType } from "@crr/core";
import type { Journal } from "../../src/journal.js";

type Narrowed = { readonly type: JournalEventType } & Readonly<Record<string, unknown>>;

export function eventsOf(journal: Journal, type: JournalEventType): readonly Narrowed[] {
  return journal.events.filter((e) => e.type === type) as unknown as readonly Narrowed[];
}

export function countOf(journal: Journal, type: JournalEventType): number {
  return eventsOf(journal, type).length;
}

/** Every event, as one string, for the redaction canary: nothing a run writes down may contain a
 *  value the caller supplied. */
export function journalText(journal: Journal): string {
  return JSON.stringify(journal.events);
}

export type { JournalEvent };
