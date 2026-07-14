/**
 * Sampling with tail-based error keeping. The head decision is a
 * deterministic hash of a sample key (default: the event id) against the
 * configured rate — no RNG, so replays and tests agree with production.
 * The decision runs at finish() time, which is what makes it tail-based:
 * an event that turned out to contain an error, a 5xx, or a slow
 * duration is kept even when the head decision said drop, with its
 * weight reset to 1 so downstream math stays honest.
 */

import type { EventRecord, SampleDecision, SampleOptions, SampleRule } from "./types.js";

/** 32-bit FNV-1a hash of a string. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Map a string deterministically into [0, 1). FNV-1a alone clusters on
 * near-identical inputs (sequential request ids differ only in their
 * last characters), so a murmur3-style finalizer avalanches the bits —
 * without it, a 10% rate can keep 1.5% of one route and 30% of another.
 */
export function hashUnit(input: string): number {
  let h = fnv1a(input);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
}

/** Statuses at or above this are treated as error conditions for tail keeping. */
const ERROR_STATUS_MIN = 500;

/** True if the finished fields describe a failed unit of work. */
export function isErrorEvent(fields: EventRecord): boolean {
  if (fields["error.message"] !== undefined || fields["error.type"] !== undefined) return true;
  const count = fields["error.count"];
  if (typeof count === "number" && count > 0) return true;
  const status = fields["http.status"];
  return typeof status === "number" && status >= ERROR_STATUS_MIN;
}

/** First rule whose every match field strictly equals the event's value. */
export function matchRule(fields: EventRecord, rules: SampleRule[]): SampleRule | undefined {
  return rules.find((rule) =>
    Object.entries(rule.match).every(([k, v]) => fields[k] === v)
  );
}

function clampRate(rate: number): number {
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate >= 1) return 1;
  if (rate <= 0) return 0;
  return rate;
}

/** 1/rate rounded to 4 decimals, so weights serialize cleanly. */
function weightOf(rate: number): number {
  if (rate >= 1) return 1;
  if (rate <= 0) return 1;
  return Math.round((1 / rate) * 10000) / 10000;
}

export class Sampler {
  private readonly rate: number;
  private readonly byKey: string;
  private readonly rules: SampleRule[];
  private readonly keepErrors: boolean;
  private readonly slowMs: number | undefined;
  private readonly keep: ((fields: EventRecord) => boolean) | undefined;

  constructor(options: SampleOptions = {}) {
    this.rate = clampRate(options.rate ?? 1);
    this.byKey = options.byKey ?? "event.id";
    this.rules = options.rules ?? [];
    this.keepErrors = options.keepErrors !== false;
    this.slowMs = options.slowMs;
    this.keep = options.keep;
  }

  /**
   * Decide the fate of one finished event. Order matters:
   *   1. per-rule rate override (first match wins), else the base rate;
   *   2. deterministic head decision at that rate;
   *   3. if the head said drop — tail keeps: error, slow, custom rule.
   * Tail-kept events carry weight 1 (they represent only themselves).
   */
  decide(fields: EventRecord): SampleDecision {
    const rule = matchRule(fields, this.rules);
    const rate = rule ? clampRate(rule.rate) : this.rate;

    if (rate >= 1) return { kept: true, weight: 1, keptBy: "always" };

    const keyValue = fields[this.byKey];
    const seed = keyValue === undefined ? "" : String(keyValue);
    const headKept = rate > 0 && hashUnit(seed) < rate;
    if (headKept) return { kept: true, weight: weightOf(rate), keptBy: "head" };

    if (this.keepErrors && isErrorEvent(fields)) {
      return { kept: true, weight: 1, keptBy: "tail:error" };
    }
    const duration = fields["duration_ms"];
    if (
      this.slowMs !== undefined &&
      typeof duration === "number" &&
      duration >= this.slowMs
    ) {
      return { kept: true, weight: 1, keptBy: "tail:slow" };
    }
    if (this.keep && safeKeep(this.keep, fields)) {
      return { kept: true, weight: 1, keptBy: "tail:rule" };
    }
    return { kept: false, weight: weightOf(rate), keptBy: "" };
  }
}

/** A user keep-rule that throws must never take the request down with it. */
function safeKeep(keep: (fields: EventRecord) => boolean, fields: EventRecord): boolean {
  try {
    return keep(fields) === true;
  } catch {
    return false;
  }
}
