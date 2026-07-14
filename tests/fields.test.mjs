// Field normalization: the funnel every caller-supplied value passes
// through. These tests pin down the flattening rules, the caps, and the
// promise that no input — cyclic, deep, huge, or weird — ever throws.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LIMITS,
  flattenInto,
  isValidKey,
  normalizeKey,
  safeStringify,
  truncate,
  firstStackFrames,
} from "../dist/index.js";

function flat(key, value, limits = DEFAULT_LIMITS) {
  const out = new Map();
  flattenInto(out, key, value, limits);
  return Object.fromEntries(out);
}

test("normalizeKey: canonical keys pass through, garbage is repaired, never empty", () => {
  assert.equal(normalizeKey("http.status"), "http.status");
  assert.equal(normalizeKey("user name"), "user_name");
  assert.equal(normalizeKey("a\tb\nc"), "a_b_c");
  assert.equal(normalizeKey("a..b"), "a.b"); // empty segments dropped
  assert.equal(normalizeKey(".leading.trailing."), "leading.trailing");
  assert.equal(normalizeKey(""), "_");
  assert.equal(normalizeKey("..."), "_");
  assert.equal(normalizeKey("x".repeat(500)).length, 128); // length cap
});

test("isValidKey matches what check accepts; truncate marks cuts with an ellipsis", () => {
  assert.equal(isValidKey("http.status"), true);
  assert.equal(isValidKey("duration_ms"), true);
  assert.equal(isValidKey("a..b"), false);
  assert.equal(isValidKey("has space"), false);
  assert.equal(isValidKey(""), false);
  assert.equal(truncate("hello", 10), "hello");
  assert.equal(truncate("hello world", 8), "hello w…");
  assert.equal(truncate("ab", 1), "…");
});

test("primitives pass through; undefined, NaN and Infinity normalize to null", () => {
  assert.deepEqual(flat("s", "x"), { s: "x" });
  assert.deepEqual(flat("n", 3.5), { n: 3.5 });
  assert.deepEqual(flat("b", true), { b: true });
  assert.deepEqual(flat("z", null), { z: null });
  // JSON has no word for these three; null beats a crashed serializer.
  assert.deepEqual(flat("u", undefined), { u: null });
  assert.deepEqual(flat("nan", NaN), { nan: null });
  assert.deepEqual(flat("inf", Infinity), { inf: null });
});

test("odd scalars: long strings truncate, bigints degrade gracefully, functions drop", () => {
  const long = flat("s", "a".repeat(5000));
  assert.equal(long.s.length, DEFAULT_LIMITS.maxValueLength);
  assert.ok(long.s.endsWith("…"));
  assert.deepEqual(flat("small", 42n), { small: 42 });
  assert.deepEqual(flat("big", 2n ** 80n), { big: (2n ** 80n).toString() });
  assert.deepEqual(flat("fn", () => 1), {});
  assert.deepEqual(flat("sym", Symbol("x")), {});
});

test("Dates become ISO strings; an invalid Date becomes null, not 'Invalid Date'", () => {
  assert.deepEqual(flat("t", new Date("2026-07-01T00:00:00Z")), {
    t: "2026-07-01T00:00:00.000Z",
  });
  assert.deepEqual(flat("t", new Date("nope")), { t: null });
});

test("nested objects flatten into dot-keys; an empty object records null", () => {
  assert.deepEqual(flat("user", { id: 7, name: "amy", meta: { plan: "pro" } }), {
    "user.id": 7,
    "user.name": "amy",
    "user.meta.plan": "pro",
  });
  assert.deepEqual(flat("empty", {}), { empty: null });
});

test("arrays: primitives kept (capped), objects flatten through numeric segments", () => {
  assert.deepEqual(flat("tags", ["a", "b", 3, null]), { tags: ["a", "b", 3, null] });
  const capped = flat("a", Array.from({ length: 100 }, (_, i) => i));
  assert.equal(capped.a.length, DEFAULT_LIMITS.maxArrayLength);
  assert.deepEqual(flat("items", [{ sku: "a" }, { sku: "b" }]), {
    "items.0.sku": "a",
    "items.1.sku": "b",
  });
});

test("depth cap stringifies; class instances become tags — never walked", () => {
  const limits = { ...DEFAULT_LIMITS, maxDepth: 2 };
  assert.deepEqual(flat("a", { b: { c: { d: 1 } } }, limits), { "a.b.c": '{"d":1}' });
  // Walking instances (streams, sockets, ORM rows) risks cycles and getters.
  class Connection {}
  assert.deepEqual(flat("conn", new Connection()), { conn: "[object Connection]" });
});

test("Errors flatten to a type/message/stack triple with bounded frames", () => {
  const err = new TypeError("boom");
  const out = flat("error", err);
  assert.equal(out["error.type"], "TypeError");
  assert.equal(out["error.message"], "boom");
  assert.ok(String(out["error.stack"]).startsWith("TypeError: boom"));
  const stack = "Error: x\n  at a()\n  at b()\n  at c()\n  at d()";
  assert.equal(firstStackFrames(stack, 2), "Error: x\nat a()\nat b()");
  assert.equal(firstStackFrames(undefined, 3), "");
  // safeStringify (the depth-cap fallback) survives cycles and bigints.
  const a = { n: 1n };
  a.self = a;
  assert.equal(safeStringify(a), '{"n":"1","self":"[circular]"}');
});
