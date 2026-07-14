/**
 * Emitters and the canonical NDJSON serialization. The line format is
 * deliberately rigid: identity and outcome fields first in a fixed
 * order, then every remaining field sorted lexicographically — so two
 * events with the same fields always serialize identically, diffs stay
 * readable, and downstream parsers can rely on the shape.
 */

import type { EventRecord, Emitter, FieldValue } from "./types.js";

/** Fixed leading key order for the canonical line; the rest is sorted. */
export const CORE_KEY_ORDER: readonly string[] = [
  "time",
  "event.id",
  "event.name",
  "service",
  "service.version",
  "env",
  "host",
  "pid",
  "duration_ms",
  "http.method",
  "http.route",
  "http.path",
  "http.status",
  "http.request_id",
  "error.type",
  "error.message",
  "error.stack",
  "error.count",
  "sample.rate",
  "sample.kept_by",
];

const CORE_RANK = new Map(CORE_KEY_ORDER.map((k, i) => [k, i]));

/** Keys of a record in canonical order: core fields first, rest sorted. */
export function canonicalKeys(record: EventRecord): string[] {
  return Object.keys(record).sort((a, b) => {
    const ra = CORE_RANK.get(a);
    const rb = CORE_RANK.get(b);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** Serialize one finished event to its canonical single-line JSON form. */
export function serializeEvent(record: EventRecord): string {
  const parts: string[] = [];
  for (const key of canonicalKeys(record)) {
    const value = record[key] as FieldValue;
    parts.push(`${JSON.stringify(key)}:${JSON.stringify(value ?? null)}`);
  }
  return `{${parts.join(",")}}`;
}

/** Anything with a write(string) method — process.stdout, a file stream, a socket. */
export interface WritableLike {
  write(chunk: string): boolean;
}

/** The default emitter: one canonical JSON line per event, newline-delimited. */
export class NdjsonEmitter implements Emitter {
  private readonly stream: WritableLike;

  constructor(stream: WritableLike = process.stdout) {
    this.stream = stream;
  }

  emit(record: EventRecord): void {
    this.stream.write(serializeEvent(record) + "\n");
  }
}

/** Test/debug emitter: keeps every emitted record and line in memory. */
export class CaptureEmitter implements Emitter {
  readonly events: EventRecord[] = [];
  readonly lines: string[] = [];

  emit(record: EventRecord): void {
    this.events.push(record);
    this.lines.push(serializeEvent(record));
  }

  clear(): void {
    this.events.length = 0;
    this.lines.length = 0;
  }
}

/** Fan an event out to several emitters (e.g. stdout + an in-memory tap). */
export class TeeEmitter implements Emitter {
  private readonly targets: Emitter[];

  constructor(...targets: Emitter[]) {
    this.targets = targets;
  }

  emit(record: EventRecord): void {
    for (const t of this.targets) t.emit(record);
  }
}
