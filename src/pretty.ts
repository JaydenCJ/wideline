/**
 * Human rendering of wide events — `wideline pretty`. One block per
 * event: a summary line built from the well-known fields, then the
 * remaining fields grouped by namespace prefix and aligned. Plain text
 * only; deterministic output is worth more than colors here.
 */

import { canonicalKeys } from "./emitter.js";
import type { EventRecord, FieldValue } from "./types.js";

/** Fields consumed by the summary line and therefore not repeated below it. */
const SUMMARY_KEYS = new Set([
  "time",
  "service",
  "duration_ms",
  "http.method",
  "http.route",
  "http.status",
  "event.name",
]);

function clock(time: FieldValue | undefined): string {
  if (typeof time !== "string") return "--:--:--";
  const t = new Date(time);
  if (Number.isNaN(t.getTime())) return "--:--:--";
  return t.toISOString().slice(11, 23);
}

function fmtValue(v: FieldValue): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return JSON.stringify(v);
  return typeof v === "string" ? v : String(v);
}

/** The one-line summary: time, service, what happened, outcome, duration. */
export function summaryLine(record: EventRecord): string {
  const parts: string[] = [clock(record["time"])];
  const service = record["service"];
  if (service !== undefined) parts.push(`[${fmtValue(service)}]`);
  const method = record["http.method"];
  const route = record["http.route"];
  const name = record["event.name"];
  if (method !== undefined || route !== undefined) {
    parts.push([method, route].filter((x) => x !== undefined).map(fmtValue).join(" "));
  } else if (name !== undefined) {
    parts.push(fmtValue(name));
  }
  const status = record["http.status"];
  if (status !== undefined) parts.push(String(status));
  const duration = record["duration_ms"];
  if (typeof duration === "number") parts.push(`${duration}ms`);
  if (record["error.message"] !== undefined) parts.push("ERROR");
  return parts.join(" ");
}

/** Render one event as a summary line plus aligned detail fields. */
export function prettyEvent(record: EventRecord): string {
  const lines = [summaryLine(record)];
  const detailKeys = canonicalKeys(record).filter((k) => !SUMMARY_KEYS.has(k));
  const width = detailKeys.reduce((w, k) => Math.max(w, k.length), 0);
  for (const key of detailKeys) {
    lines.push(`  ${key.padEnd(width)}  ${fmtValue(record[key] as FieldValue)}`);
  }
  return lines.join("\n");
}

/** Render a whole stream, blocks separated by blank lines. */
export function prettyStream(records: EventRecord[]): string {
  return records.map(prettyEvent).join("\n\n");
}
