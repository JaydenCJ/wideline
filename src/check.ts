/**
 * Validation of a wide-event NDJSON stream — the contract `wideline
 * check` enforces in CI. A line passes only if it is one flat JSON
 * object with canonical keys, primitive values, the required identity
 * fields, and internally consistent metadata. Problems carry the line
 * number and key so a failing pipeline points at the exact byte range.
 */

import { isValidKey } from "./fields.js";
import type { EventRecord } from "./types.js";

export interface Problem {
  line: number;
  key?: string;
  message: string;
}

export interface CheckResult {
  /** Non-empty lines examined. */
  total: number;
  /** Lines that passed every check. */
  valid: number;
  problems: Problem[];
}

const REQUIRED_FIELDS = ["time", "event.id", "service"] as const;

function isPrimitive(v: unknown): boolean {
  return (
    v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean"
  );
}

/** Validate one parsed record; append problems for `lineNo`. */
export function checkEvent(record: unknown, lineNo: number, problems: Problem[]): boolean {
  const before = problems.length;
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    problems.push({ line: lineNo, message: "line is not a JSON object" });
    return false;
  }
  const rec = record as Record<string, unknown>;

  for (const field of REQUIRED_FIELDS) {
    const v = rec[field];
    if (typeof v !== "string" || v.length === 0) {
      problems.push({
        line: lineNo,
        key: field,
        message: `required field "${field}" is missing or not a non-empty string`,
      });
    }
  }

  const time = rec["time"];
  if (typeof time === "string" && time.length > 0 && Number.isNaN(Date.parse(time))) {
    problems.push({ line: lineNo, key: "time", message: "time is not a parseable timestamp" });
  }

  for (const [key, value] of Object.entries(rec)) {
    if (!isValidKey(key)) {
      problems.push({ line: lineNo, key, message: "key is not a canonical dot-key" });
    }
    if (Array.isArray(value)) {
      if (!value.every(isPrimitive)) {
        problems.push({
          line: lineNo,
          key,
          message: "array values must contain only primitives",
        });
      }
    } else if (!isPrimitive(value)) {
      problems.push({
        line: lineNo,
        key,
        message: "value is not a primitive — wide events are flat",
      });
    } else if (typeof value === "number" && !Number.isFinite(value)) {
      problems.push({ line: lineNo, key, message: "number is not finite" });
    }
  }

  const duration = rec["duration_ms"];
  if (duration !== undefined && (typeof duration !== "number" || duration < 0)) {
    problems.push({
      line: lineNo,
      key: "duration_ms",
      message: "duration_ms must be a non-negative number",
    });
  }
  const weight = rec["sample.rate"];
  if (weight !== undefined && (typeof weight !== "number" || weight < 1)) {
    problems.push({
      line: lineNo,
      key: "sample.rate",
      message: "sample.rate is a weight and must be a number >= 1",
    });
  }
  return problems.length === before;
}

/** Parse a line; undefined means unparseable (a problem was recorded). */
export function parseLine(
  line: string,
  lineNo: number,
  problems: Problem[]
): EventRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (e) {
    problems.push({
      line: lineNo,
      message: `invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
    });
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    problems.push({ line: lineNo, message: "line is not a JSON object" });
    return undefined;
  }
  return parsed as EventRecord;
}

/** Check a whole NDJSON document (blank lines are skipped, not errors). */
export function checkStream(text: string): CheckResult {
  const problems: Problem[] = [];
  let total = 0;
  let valid = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = raw.trim();
    if (line === "") continue;
    total += 1;
    const record = parseLine(line, i + 1, problems);
    if (record === undefined) continue;
    if (checkEvent(record, i + 1, problems)) valid += 1;
  }
  return { total, valid, problems };
}

/**
 * Parse every well-formed event out of an NDJSON document, tolerantly —
 * used by `stats`, `pretty` and `sample`, which should work on streams
 * that `check` would grade harshly.
 */
export function parseStream(text: string): { records: EventRecord[]; skipped: number } {
  const records: EventRecord[] = [];
  let skipped = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const problems: Problem[] = [];
    const rec = parseLine(line, 0, problems);
    if (rec === undefined) skipped += 1;
    else records.push(rec);
  }
  return { records, skipped };
}
