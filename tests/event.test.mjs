// The WideEvent lifecycle: accumulate, count, time, error, then finish
// exactly once. The one-event-per-request guarantee lives here — these
// tests are the contract that racing code paths cannot double-emit or
// mutate after the line has left the building.
import test from "node:test";
import assert from "node:assert/strict";
import { makeWideline } from "./helpers.mjs";

test("finish emits exactly one record with the base identity fields", () => {
  const { wideline, emitter } = makeWideline({ version: "9.9.9", env: "test" });
  const event = wideline.startEvent();
  event.finish();
  assert.equal(emitter.events.length, 1);
  const record = emitter.events[0];
  assert.equal(record["service"], "test-svc");
  assert.equal(record["service.version"], "9.9.9");
  assert.equal(record["env"], "test");
  assert.equal(record["host"], "test-host");
  assert.equal(record["pid"], 4242);
  assert.equal(record["event.id"], "ev-000001");
  assert.equal(record["time"], new Date(1_000_000).toISOString());
});

test("finish() is exactly-once and later mutations are ignored and counted", () => {
  const { wideline, emitter } = makeWideline();
  const event = wideline.startEvent();
  assert.equal(event.finish(), true);
  assert.equal(event.finish(), false);
  assert.equal(event.finish({ late: true }), false);
  event.set("too", "late");
  event.count("db.queries");
  event.error(new Error("late"));
  assert.equal(emitter.events.length, 1);
  assert.equal(emitter.events[0]["too"], undefined);
  assert.equal(emitter.events[0]["db.queries"], undefined);
  assert.equal(wideline.diagnostics().lateCalls, 5);
});

test("duration_ms is measured via the clock unless the caller sets it explicitly", () => {
  const { wideline, emitter, clock } = makeWideline();
  const event = wideline.startEvent();
  clock.tick(123);
  event.finish();
  assert.equal(emitter.events[0]["duration_ms"], 123);
  const explicit = wideline.startEvent();
  clock.tick(500);
  explicit.set("duration_ms", 7);
  explicit.finish();
  assert.equal(emitter.events[1]["duration_ms"], 7);
});

test("set(key, value) and set(object) flatten into the same record, chainable", () => {
  const { wideline, emitter } = makeWideline();
  const event = wideline.startEvent();
  event.set("cart.items", 3).set({ user: { plan: "pro", id: 7 } });
  event.finish({ "http.status": 204 }); // finish(extra) merges before emitting
  const record = emitter.events[0];
  assert.equal(record["cart.items"], 3);
  assert.equal(record["user.plan"], "pro");
  assert.equal(record["user.id"], 7);
  assert.equal(record["http.status"], 204);
});

test("count accumulates across calls and ignores non-finite increments", () => {
  const { wideline, emitter } = makeWideline();
  const event = wideline.startEvent();
  event.count("db.queries");
  event.count("db.queries");
  event.count("db.queries", 3);
  event.count("db.queries", NaN); // must not poison the field
  event.count("db.queries", Infinity);
  // max keeps the largest value seen — a high-water-mark gauge.
  event.max("queue.depth", 3);
  event.max("queue.depth", 9);
  event.max("queue.depth", 5);
  event.finish();
  assert.equal(emitter.events[0]["db.queries"], 5);
  assert.equal(emitter.events[0]["queue.depth"], 9);
});

test("time() accumulates elapsed ms + call count; stop is idempotent", () => {
  const { wideline, emitter, clock } = makeWideline();
  const event = wideline.startEvent();
  const stop1 = event.time("db");
  clock.tick(30);
  assert.equal(stop1(), 30);
  clock.tick(50);
  assert.equal(stop1(), 0); // second stop reports nothing
  const stop2 = event.time("db");
  clock.tick(12);
  stop2();
  event.finish();
  assert.equal(emitter.events[0]["db.ms"], 42);
  assert.equal(emitter.events[0]["db.count"], 2);
});

test("error(): first error wins the triple, every call counts, non-Errors cope", () => {
  const { wideline, emitter } = makeWideline();
  const event = wideline.startEvent();
  event.error(new RangeError("first"));
  event.error(new Error("second"));
  event.finish();
  const record = emitter.events[0];
  assert.equal(record["error.type"], "RangeError");
  assert.equal(record["error.message"], "first");
  assert.equal(record["error.count"], 2);
  // Strings get thrown in the wild; they must still record.
  const event2 = wideline.startEvent();
  event2.error("something exploded");
  event2.finish();
  assert.equal(emitter.events[1]["error.type"], "Thrown");
  assert.equal(emitter.events[1]["error.message"], "something exploded");
});

test("maxFields caps the record and reports the overflow honestly", () => {
  const { wideline, emitter } = makeWideline({ limits: { maxFields: 10 } });
  const event = wideline.startEvent();
  for (let i = 0; i < 50; i++) event.set(`f${String(i).padStart(2, "0")}`, i);
  event.finish();
  const record = emitter.events[0];
  // 5 base + 5 custom fit at the cap; duration_ms, event.dropped_fields
  // and the two sample.* fields are stamped on top after the cap.
  assert.equal(Object.keys(record).length, 14);
  assert.equal(record["event.dropped_fields"], 45);
  assert.equal(wideline.diagnostics().droppedFields, 45);
  // Updating an existing field never counts against the cap.
  const { wideline: w2, emitter: e2 } = makeWideline({ limits: { maxFields: 8 } });
  const hot = w2.startEvent();
  for (let i = 0; i < 100; i++) hot.set("hot.key", i);
  hot.finish();
  assert.equal(e2.events[0]["hot.key"], 99);
  assert.equal(e2.events[0]["event.dropped_fields"], undefined);
});

test("snapshot() is a copy of the live fields; initial fields land on the record", () => {
  const { wideline, emitter } = makeWideline();
  const event = wideline.startEvent({ "event.name": "nightly-rebuild" });
  event.set("a", 1);
  const snap = event.snapshot();
  assert.equal(snap["a"], 1);
  assert.equal(snap["event.name"], "nightly-rebuild");
  assert.equal(event.isFinished, false);
  event.set("b", 2);
  assert.equal(snap["b"], undefined); // a copy, not a live view
  event.finish();
  assert.equal(emitter.events[0]["event.name"], "nightly-rebuild");
});
