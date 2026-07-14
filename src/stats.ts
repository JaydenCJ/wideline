/**
 * Offline aggregation over a wide-event stream — what `wideline stats`
 * prints. Counts are weighted by `sample.rate` so a head-sampled stream
 * still reports honest traffic estimates, while latency quantiles are
 * computed over the kept events only (and labelled as such: quantiles
 * over a tail-biased sample would otherwise overstate the tail).
 */

import { isErrorEvent } from "./sampler.js";
import type { EventRecord } from "./types.js";

export interface GroupStats {
  key: string;
  /** Kept events actually present in the stream. */
  events: number;
  /** Estimated original events (sum of sample.rate weights). */
  estimated: number;
  /** Estimated error events (weighted). */
  errors: number;
  /** errors / estimated, in [0, 1]. */
  errorRate: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export interface StatsResult {
  by: string;
  totalEvents: number;
  totalEstimated: number;
  skippedLines: number;
  groups: GroupStats[];
}

/** Nearest-rank quantile of a sorted array (deterministic, no interpolation). */
export function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(q * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx] ?? null;
}

function weightOf(record: EventRecord): number {
  const w = record["sample.rate"];
  return typeof w === "number" && w >= 1 ? w : 1;
}

/** Aggregate records grouped by the value of one field. */
export function aggregate(
  records: EventRecord[],
  by: string,
  skippedLines = 0
): StatsResult {
  const buckets = new Map<string, { events: number; estimated: number; errors: number; durations: number[] }>();
  let totalEstimated = 0;

  for (const record of records) {
    const groupValue = record[by];
    const key = groupValue === undefined || groupValue === null ? "(none)" : String(groupValue);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { events: 0, estimated: 0, errors: 0, durations: [] };
      buckets.set(key, bucket);
    }
    const weight = weightOf(record);
    bucket.events += 1;
    bucket.estimated += weight;
    totalEstimated += weight;
    if (isErrorEvent(record)) bucket.errors += weight;
    const duration = record["duration_ms"];
    if (typeof duration === "number" && Number.isFinite(duration)) {
      bucket.durations.push(duration);
    }
  }

  const groups: GroupStats[] = [];
  for (const [key, b] of buckets) {
    b.durations.sort((x, y) => x - y);
    groups.push({
      key,
      events: b.events,
      estimated: round2(b.estimated),
      errors: round2(b.errors),
      errorRate: b.estimated > 0 ? b.errors / b.estimated : 0,
      p50: quantile(b.durations, 0.5),
      p95: quantile(b.durations, 0.95),
      p99: quantile(b.durations, 0.99),
      max: b.durations.length > 0 ? (b.durations[b.durations.length - 1] ?? null) : null,
    });
  }
  // Busiest groups first; ties break alphabetically so output is stable.
  groups.sort((a, z) => z.estimated - a.estimated || (a.key < z.key ? -1 : 1));

  return {
    by,
    totalEvents: records.length,
    totalEstimated: round2(totalEstimated),
    skippedLines,
    groups,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** "1 event", "2 events" — count-aware noun for summary lines. */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function fmt(n: number | null): string {
  if (n === null) return "-";
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** Render the aggregate as an aligned text table. */
export function renderStats(result: StatsResult, top?: number): string {
  const rows = top !== undefined ? result.groups.slice(0, top) : result.groups;
  const header = [result.by, "events", "est", "err%", "p50", "p95", "p99", "max"];
  const table: string[][] = [header];
  for (const g of rows) {
    table.push([
      g.key,
      String(g.events),
      fmt(g.estimated),
      (g.errorRate * 100).toFixed(1),
      fmt(g.p50),
      fmt(g.p95),
      fmt(g.p99),
      fmt(g.max),
    ]);
  }
  const widths = header.map((_, col) => Math.max(...table.map((r) => (r[col] ?? "").length)));
  const lines = table.map((row) =>
    row
      .map((cell, col) =>
        col === 0 ? cell.padEnd(widths[col] ?? 0) : cell.padStart(widths[col] ?? 0)
      )
      .join("  ")
  );
  const summary = `${plural(result.totalEvents, "event")} (${fmt(result.totalEstimated)} estimated pre-sampling)` +
    (result.skippedLines > 0 ? `, ${plural(result.skippedLines, "unparseable line")} skipped` : "");
  return [lines[0], "-".repeat((lines[0] ?? "").length), ...lines.slice(1), "", summary].join("\n");
}

/** JSON rendering for machines. */
export function renderStatsJson(result: StatsResult, top?: number): string {
  const out = { ...result, groups: top !== undefined ? result.groups.slice(0, top) : result.groups };
  return JSON.stringify(out, null, 2);
}
