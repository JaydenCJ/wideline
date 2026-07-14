/**
 * Shared types for the wideline engine. A wide event is a single flat
 * record of dot-separated keys and primitive values — one per unit of
 * work — so everything downstream (emitters, samplers, the CLI) speaks
 * the same shape.
 */

/** A single primitive cell in a wide event. */
export type Primitive = string | number | boolean | null;

/** The value space of a wide-event field: a primitive or a flat array of primitives. */
export type FieldValue = Primitive | Primitive[];

/** A finished wide event: flat dot-keys, primitive values, ready for NDJSON. */
export type EventRecord = Record<string, FieldValue>;

/** Caps applied while enriching an event, so one bad caller cannot bloat the line. */
export interface Limits {
  /** Maximum number of fields on one event; extra sets are dropped and counted. */
  maxFields: number;
  /** Maximum string length per value; longer strings are truncated with an ellipsis. */
  maxValueLength: number;
  /** Maximum object-nesting depth flattened into dot keys; deeper values are stringified. */
  maxDepth: number;
  /** Maximum array length kept per value; longer arrays are truncated. */
  maxArrayLength: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxFields: 200,
  maxValueLength: 1024,
  maxDepth: 8,
  maxArrayLength: 64,
};

/** A single sampling rule: if every `match` field equals, `rate` applies. */
export interface SampleRule {
  match: Record<string, Primitive>;
  rate: number;
}

/** Sampling configuration — head rate plus tail-based keep conditions. */
export interface SampleOptions {
  /** Head-sampling rate in (0, 1]. 1 keeps everything. Default 1. */
  rate?: number;
  /**
   * Field whose value seeds the deterministic head decision, e.g.
   * "trace.id" so an entire trace samples together. Defaults to
   * "event.id" (independent per event).
   */
  byKey?: string;
  /** Per-match rate overrides; the first matching rule wins. */
  rules?: SampleRule[];
  /** Keep every event with an error or a 5xx status, regardless of rate. Default true. */
  keepErrors?: boolean;
  /** Keep every event whose duration_ms is at or above this threshold. */
  slowMs?: number;
  /** Custom tail keep rule, called with the finished fields. */
  keep?: (fields: EventRecord) => boolean;
}

/** The outcome of a sampling decision for one finished event. */
export interface SampleDecision {
  kept: boolean;
  /** The weight this event represents downstream (1 / effective rate). */
  weight: number;
  /** Why it was kept: "always", "head", "tail:error", "tail:slow", "tail:rule". */
  keptBy: string;
}

/** Anything that can receive finished events. */
export interface Emitter {
  emit(record: EventRecord): void;
}

/** Injectable clock; ms since epoch. Tests pass a manual one. */
export interface Clock {
  now(): number;
}

/** Redaction configuration. */
export interface RedactOptions {
  /** Extra key patterns (matched against the last dot segment, case-insensitively). */
  keys?: (string | RegExp)[];
  /** Disable the built-in sensitive-key list (not recommended). */
  defaults?: boolean;
}

/** Options accepted by `new Wideline(...)`. */
export interface WidelineOptions {
  /** Logical service name, stamped on every event. Required. */
  service: string;
  /** Service version, stamped as `service.version`. */
  version?: string;
  /** Deployment environment, stamped as `env`. */
  env?: string;
  /** Where finished events go. Defaults to NDJSON on stdout. */
  emitter?: Emitter;
  /** Sampling configuration. Defaults to keep-everything. */
  sample?: SampleOptions;
  /** Redaction configuration. Defaults to the built-in sensitive-key list. */
  redact?: RedactOptions;
  /** Field caps. */
  limits?: Partial<Limits>;
  /** Injectable clock (tests). */
  clock?: Clock;
  /** Injectable event-id generator (tests). */
  idGenerator?: () => string;
  /** Host name stamped on events; defaults to os.hostname(). */
  host?: string;
  /** Process id stamped on events; defaults to process.pid. */
  pid?: number;
}

/** Counters describing what a Wideline instance has done so far. */
export interface Diagnostics {
  /** Events started. */
  started: number;
  /** Events emitted (kept by sampling). */
  emitted: number;
  /** Events finished but sampled out. */
  sampledOut: number;
  /** set()/count()/error() calls that arrived after finish() and were ignored. */
  lateCalls: number;
  /** Fields dropped because an event hit maxFields. */
  droppedFields: number;
}
