/**
 * Field normalization: everything a caller hands to `set()` is folded
 * into flat dot-keys and primitive values here, under hard caps, so a
 * finished event is always a bounded, JSON-safe, one-line record no
 * matter how hostile the input was.
 */

import type { FieldValue, Limits, Primitive } from "./types.js";

const MAX_KEY_LENGTH = 128;

/**
 * Normalize a field key: trim, collapse whitespace/control characters to
 * underscores, drop empty dot segments, cap the length. Never throws —
 * a hopeless key becomes "_" rather than crashing the request path.
 */
export function normalizeKey(key: string): string {
  let k = String(key).trim();
  k = k.replace(/[\s\u0000-\u001f\u007f]+/g, "_");
  k = k
    .split(".")
    .filter((seg) => seg.length > 0)
    .join(".");
  if (k.length === 0) return "_";
  if (k.length > MAX_KEY_LENGTH) k = k.slice(0, MAX_KEY_LENGTH);
  return k;
}

/** True if a key is already in canonical form (what `check` accepts). */
export function isValidKey(key: string): boolean {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) return false;
  if (/[\s\u0000-\u001f\u007f]/.test(key)) return false;
  const segs = key.split(".");
  return segs.every((seg) => seg.length > 0);
}

/** Truncate a string to `max` code units, marking the cut with an ellipsis. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return "…";
  return value.slice(0, max - 1) + "…";
}

/**
 * Coerce one value to a primitive. Returns `undefined` for values that
 * have no sensible wide-event representation (functions, symbols) so the
 * caller can drop them silently.
 */
function toPrimitive(value: unknown, limits: Limits): Primitive | undefined {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "string":
      return truncate(value, limits.maxValueLength);
    case "number":
      return Number.isFinite(value) ? value : null;
    case "boolean":
      return value;
    case "bigint":
      return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : truncate(value.toString(), limits.maxValueLength);
    case "function":
    case "symbol":
      return undefined;
    default:
      return undefined; // objects are handled by flatten()
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Flatten one (key, value) pair into `out`. Objects become dot-keys,
 * arrays of primitives stay arrays (capped), arrays of objects flatten
 * through numeric segments, Dates become ISO strings, Errors become
 * `.type` / `.message` / `.stack` triples, and anything past the depth
 * cap is stringified rather than descended into.
 */
export function flattenInto(
  out: Map<string, FieldValue>,
  key: string,
  value: unknown,
  limits: Limits,
  depth = 0
): void {
  const k = normalizeKey(key);

  if (value instanceof Date) {
    const t = value.getTime();
    out.set(k, Number.isFinite(t) ? value.toISOString() : null);
    return;
  }
  if (value instanceof Error) {
    flattenErrorInto(out, k, value, limits);
    return;
  }
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v !== "object" || v === null)) {
      const arr: Primitive[] = [];
      for (const v of value.slice(0, limits.maxArrayLength)) {
        const p = toPrimitive(v, limits);
        arr.push(p === undefined ? null : p);
      }
      out.set(k, arr);
    } else if (depth >= limits.maxDepth) {
      out.set(k, truncate(safeStringify(value), limits.maxValueLength));
    } else {
      value.slice(0, limits.maxArrayLength).forEach((v, i) => {
        flattenInto(out, `${k}.${i}`, v, limits, depth + 1);
      });
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    if (!isPlainObject(value)) {
      // Class instances (streams, sockets, ORM rows…) are stringified,
      // not walked: walking them risks cycles, getters and megabytes.
      out.set(k, truncate(stringTag(value), limits.maxValueLength));
      return;
    }
    if (depth >= limits.maxDepth) {
      out.set(k, truncate(safeStringify(value), limits.maxValueLength));
      return;
    }
    const entries = Object.entries(value);
    if (entries.length === 0) {
      out.set(k, null);
      return;
    }
    for (const [ck, cv] of entries) {
      flattenInto(out, `${k}.${ck}`, cv, limits, depth + 1);
    }
    return;
  }

  const p = toPrimitive(value, limits);
  if (p !== undefined) out.set(k, p);
}

/** Fold an Error into `<key>.type` / `<key>.message` / `<key>.stack`. */
export function flattenErrorInto(
  out: Map<string, FieldValue>,
  key: string,
  err: Error,
  limits: Limits
): void {
  out.set(`${key}.type`, err.name || "Error");
  out.set(`${key}.message`, truncate(String(err.message ?? ""), limits.maxValueLength));
  const stack = firstStackFrames(err.stack, 5);
  if (stack) out.set(`${key}.stack`, truncate(stack, limits.maxValueLength));
}

/** The first `n` call-site lines of a stack trace, newline-joined. */
export function firstStackFrames(stack: string | undefined, n: number): string {
  if (!stack) return "";
  return stack
    .split("\n")
    .slice(0, n + 1) // message line + n frames
    .map((l) => l.trim())
    .join("\n");
}

function stringTag(value: object): string {
  const name = value.constructor?.name;
  return name && name !== "Object" ? `[object ${name}]` : safeStringify(value);
}

/** JSON.stringify that never throws (cycles, bigints → best effort). */
export function safeStringify(value: unknown): string {
  const seen = new Set<unknown>();
  try {
    return (
      JSON.stringify(value, (_k, v) => {
        if (typeof v === "bigint") return v.toString();
        if (v !== null && typeof v === "object") {
          if (seen.has(v)) return "[circular]";
          seen.add(v);
        }
        return v;
      }) ?? "null"
    );
  } catch {
    return "[unserializable]";
  }
}
