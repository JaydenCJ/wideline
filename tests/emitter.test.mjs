// Canonical serialization and the emitters. The line format is a
// contract: identity fields first in fixed order, everything else
// sorted — two equal records must serialize byte-identically.
import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalKeys,
  CaptureEmitter,
  CORE_KEY_ORDER,
  NdjsonEmitter,
  serializeEvent,
  TeeEmitter,
} from "../dist/index.js";

test("canonicalKeys puts core fields first in documented order, the rest sorted", () => {
  const keys = canonicalKeys({
    "user.plan": "pro",
    duration_ms: 5,
    service: "svc",
    time: "t",
    "db.queries": 2,
  });
  assert.deepEqual(keys, ["time", "service", "duration_ms", "db.queries", "user.plan"]);
  assert.deepEqual(canonicalKeys({ zebra: 1, alpha: 2, "m.n": 3 }), ["alpha", "m.n", "zebra"]);
  assert.deepEqual(CORE_KEY_ORDER.slice(0, 2), ["time", "event.id"]);
  assert.ok(CORE_KEY_ORDER.includes("sample.rate"));
});

test("serialization is canonical: same fields, any insertion order, same bytes", () => {
  const a = { time: "t", service: "s", "b.x": 1, "a.y": 2 };
  const b = { "a.y": 2, "b.x": 1, service: "s", time: "t" };
  assert.equal(serializeEvent(a), serializeEvent(b));
});

test("the serialized line is valid single-line JSON; undefined becomes null", () => {
  const line = serializeEvent({
    time: "2026-07-01T00:00:00.000Z",
    service: "svc",
    note: 'quotes " and \n newlines',
    tags: ["a", "b"],
    oops: undefined,
  });
  assert.ok(!line.includes("\n"));
  const parsed = JSON.parse(line);
  assert.equal(parsed.note, 'quotes " and \n newlines');
  assert.deepEqual(parsed.tags, ["a", "b"]);
  assert.equal(parsed.oops, null);
});

test("NdjsonEmitter writes one newline-terminated line per event", () => {
  const chunks = [];
  const emitter = new NdjsonEmitter({ write: (c) => (chunks.push(c), true) });
  emitter.emit({ time: "t", service: "a" });
  emitter.emit({ time: "t", service: "b" });
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((c) => c.endsWith("}\n")));
  assert.equal(JSON.parse(chunks[1]).service, "b");
});

test("CaptureEmitter records events and their serialized lines, and clears", () => {
  const cap = new CaptureEmitter();
  cap.emit({ time: "t", service: "svc" });
  assert.equal(cap.events.length, 1);
  assert.equal(cap.lines[0], serializeEvent({ time: "t", service: "svc" }));
  cap.clear();
  assert.equal(cap.events.length, 0);
  assert.equal(cap.lines.length, 0);
});

test("TeeEmitter fans one event out to every target", () => {
  const a = new CaptureEmitter();
  const b = new CaptureEmitter();
  new TeeEmitter(a, b).emit({ time: "t", service: "svc" });
  assert.equal(a.events.length, 1);
  assert.equal(b.events.length, 1);
});
