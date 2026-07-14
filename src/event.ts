/**
 * The WideEvent: one accumulating record per unit of work. Handlers,
 * middleware and libraries all write into the same event; nothing is
 * emitted until `finish()`, which fires exactly once no matter how many
 * code paths race to call it. Every method is safe on the hot path —
 * no throws, no I/O, bounded work.
 */

import { flattenErrorInto, flattenInto, normalizeKey } from "./fields.js";
import type { Redactor } from "./redact.js";
import { REDACTED } from "./redact.js";
import type { Clock, EventRecord, FieldValue, Limits } from "./types.js";

export interface WideEventInit {
  clock: Clock;
  limits: Limits;
  redact: Redactor;
  /** Called exactly once with the finished record; returns true if emitted. */
  onFinish: (event: WideEvent) => boolean;
  /** Called when a mutation arrives after finish(). */
  onLateCall?: () => void;
  /** Called when a field is dropped by the maxFields cap. */
  onDroppedField?: (n: number) => void;
  /** Fields present from birth (service, host, event.id, …). */
  baseFields?: Record<string, FieldValue>;
}

export class WideEvent {
  private readonly fields = new Map<string, FieldValue>();
  private readonly init: WideEventInit;
  private readonly startedAt: number;
  private finished = false;
  private emitted = false;
  private dropped = 0;

  constructor(init: WideEventInit) {
    this.init = init;
    this.startedAt = init.clock.now();
    for (const [k, v] of Object.entries(init.baseFields ?? {})) {
      this.fields.set(k, v);
    }
  }

  /** ms timestamp the event was started at. */
  get startTime(): number {
    return this.startedAt;
  }

  /** True once finish() has run. */
  get isFinished(): boolean {
    return this.finished;
  }

  /**
   * Add fields. Accepts `set(key, value)` or `set({ ... })`; objects are
   * flattened to dot-keys, values normalized and capped, sensitive keys
   * redacted. Calls after finish() are ignored (and counted).
   */
  set(key: string | Record<string, unknown>, value?: unknown): this {
    if (this.guardLate()) return this;
    const staged = new Map<string, FieldValue>();
    if (typeof key === "string") {
      flattenInto(staged, key, value, this.init.limits);
    } else if (key !== null && typeof key === "object") {
      for (const [k, v] of Object.entries(key)) {
        flattenInto(staged, k, v, this.init.limits);
      }
    }
    for (const [k, v] of staged) {
      this.store(k, this.init.redact(k) ? REDACTED : v);
    }
    return this;
  }

  /** Accumulate a numeric counter field, e.g. `count("db.queries")`. */
  count(key: string, n = 1): this {
    if (this.guardLate()) return this;
    if (typeof n !== "number" || !Number.isFinite(n)) return this;
    const k = normalizeKey(key);
    const prev = this.fields.get(k);
    const base = typeof prev === "number" ? prev : 0;
    this.store(k, base + n);
    return this;
  }

  /** Keep the maximum seen for a gauge-style field, e.g. queue depth. */
  max(key: string, value: number): this {
    if (this.guardLate()) return this;
    if (typeof value !== "number" || !Number.isFinite(value)) return this;
    const k = normalizeKey(key);
    const prev = this.fields.get(k);
    if (typeof prev !== "number" || value > prev) this.store(k, value);
    return this;
  }

  /**
   * Start a named timer. The returned stop function accumulates elapsed
   * ms into `<key>.ms` and bumps `<key>.count`, so N database calls fold
   * into two fields instead of N log lines. Stop is idempotent.
   */
  time(key: string): () => number {
    const k = normalizeKey(key);
    const started = this.init.clock.now();
    let stopped = false;
    return (): number => {
      if (stopped) return 0;
      stopped = true;
      const elapsed = Math.max(0, this.init.clock.now() - started);
      if (!this.guardLate()) {
        this.count(`${k}.ms`, elapsed);
        this.count(`${k}.count`, 1);
      }
      return elapsed;
    };
  }

  /**
   * Record an error. The first error wins the `error.type` / `.message`
   * / `.stack` triple; every call bumps `error.count`, so the event
   * still says how many things went wrong.
   */
  error(err: unknown, key = "error"): this {
    if (this.guardLate()) return this;
    const k = normalizeKey(key);
    const first = !this.fields.has(`${k}.message`);
    if (first) {
      const staged = new Map<string, FieldValue>();
      if (err instanceof Error) {
        flattenErrorInto(staged, k, err, this.init.limits);
      } else {
        staged.set(`${k}.type`, "Thrown");
        flattenInto(staged, `${k}.message`, String(err), this.init.limits);
      }
      for (const [sk, sv] of staged) this.store(sk, sv);
    }
    this.count(`${k}.count`, 1);
    return this;
  }

  /** Read one field (post-normalization view; tests and keep-rules use this). */
  get(key: string): FieldValue | undefined {
    return this.fields.get(key);
  }

  /** A plain-object copy of the current fields. */
  snapshot(): EventRecord {
    return Object.fromEntries(this.fields);
  }

  /**
   * Finish the event: stamp `duration_ms` (unless already set by the
   * caller), merge `extra`, and hand the record to the sampler/emitter.
   * Exactly-once: the first call decides, every later call is a no-op
   * returning false. Returns true if the event was emitted (kept).
   */
  finish(extra?: Record<string, unknown>): boolean {
    if (this.finished) {
      this.init.onLateCall?.();
      return false;
    }
    if (extra) this.set(extra);
    this.finished = true; // set after the extra merge so it is not counted late
    if (!this.fields.has("duration_ms")) {
      this.fields.set("duration_ms", Math.max(0, this.init.clock.now() - this.startedAt));
    }
    if (this.dropped > 0) this.fields.set("event.dropped_fields", this.dropped);
    this.emitted = this.init.onFinish(this);
    return this.emitted;
  }

  /** True if finish() ran and the sampler kept the event. */
  get wasEmitted(): boolean {
    return this.emitted;
  }

  /** Internal: write one canonical (key, value), enforcing maxFields. */
  private store(key: string, value: FieldValue): void {
    if (!this.fields.has(key) && this.fields.size >= this.init.limits.maxFields) {
      this.dropped += 1;
      this.init.onDroppedField?.(1);
      return;
    }
    this.fields.set(key, value);
  }

  private guardLate(): boolean {
    if (this.finished) {
      this.init.onLateCall?.();
      return true;
    }
    return false;
  }
}
