// The Wideline instance: construction, base-field stamping, the job
// runner, sampling wired end to end, and the diagnostics counters that
// make the instance auditable in production.
import test from "node:test";
import assert from "node:assert/strict";
import { CaptureEmitter, Wideline } from "../dist/index.js";
import { makeWideline, manualClock } from "./helpers.mjs";

test("constructing without a service name is a loud, early error", () => {
  assert.throws(() => new Wideline({}), TypeError);
  assert.throws(() => new Wideline({ service: "" }), TypeError);
});

test("default ids are unique within a process; host/pid overrides stamp events", () => {
  const emitter = new CaptureEmitter();
  const wideline = new Wideline({
    service: "svc",
    host: "edge-7",
    pid: 99,
    emitter,
    clock: manualClock(),
  });
  const ids = new Set();
  for (let i = 0; i < 1000; i++) {
    const event = wideline.startEvent();
    ids.add(event.get("event.id"));
    event.finish();
  }
  assert.equal(ids.size, 1000);
  assert.equal(emitter.events[0]["host"], "edge-7");
  assert.equal(emitter.events[0]["pid"], 99);
  // version/env are optional and absent when not configured.
  assert.equal(emitter.events[0]["service.version"], undefined);
  assert.equal(emitter.events[0]["env"], undefined);
});

test("run() emits one named event for a successful job", async () => {
  const { wideline, emitter, clock } = makeWideline();
  const result = await wideline.run("rebuild-index", (event) => {
    event.set("docs", 128);
    clock.tick(250);
    return "done";
  });
  assert.equal(result, "done");
  assert.equal(emitter.events.length, 1);
  const record = emitter.events[0];
  assert.equal(record["event.name"], "rebuild-index");
  assert.equal(record["docs"], 128);
  assert.equal(record["duration_ms"], 250);
});

test("run() records a thrown error, still emits, rethrows, and exposes current()", async () => {
  const { wideline, emitter } = makeWideline();
  await assert.rejects(
    wideline.run("flaky-job", async () => {
      await Promise.resolve();
      wideline.current()?.count("steps");
      throw new RangeError("job failed");
    }),
    RangeError
  );
  assert.equal(emitter.events.length, 1);
  assert.equal(emitter.events[0]["error.type"], "RangeError");
  assert.equal(emitter.events[0]["error.message"], "job failed");
  assert.equal(emitter.events[0]["steps"], 1);
});

test("sampling is wired: sampled-out events reach no emitter, diagnostics count them", () => {
  const { wideline, emitter } = makeWideline({
    sample: { rate: 0.0000001, keepErrors: false },
  });
  for (let i = 0; i < 50; i++) wideline.startEvent().finish();
  assert.equal(emitter.events.length, 0);
  const d = wideline.diagnostics();
  assert.equal(d.started, 50);
  assert.equal(d.sampledOut, 50);
  assert.equal(d.emitted, 0);
});

test("kept events carry sample.rate and sample.kept_by; errors survive end to end", () => {
  const { wideline, emitter } = makeWideline({ sample: { rate: 0.0000001 } });
  const event = wideline.startEvent();
  event.error(new Error("must survive"));
  event.finish();
  assert.equal(emitter.events.length, 1);
  assert.equal(emitter.events[0]["sample.kept_by"], "tail:error");
  assert.equal(emitter.events[0]["sample.rate"], 1);
  const { wideline: keepAll, emitter: cap2 } = makeWideline();
  keepAll.startEvent().finish();
  assert.equal(cap2.events[0]["sample.rate"], 1);
  assert.equal(cap2.events[0]["sample.kept_by"], "always");
  // finish() reports whether the event was actually emitted.
  const { wideline: dropper } = makeWideline({ sample: { rate: 0.0000001, keepErrors: false } });
  const dropped = dropper.startEvent();
  assert.equal(dropped.finish(), false);
  assert.equal(dropped.wasEmitted, false);
  const kept = keepAll.startEvent();
  assert.equal(kept.finish(), true);
  assert.equal(kept.wasEmitted, true);
});

test("diagnostics() returns copies; enter() with no event just runs the function", () => {
  const { wideline } = makeWideline();
  const before = wideline.diagnostics();
  wideline.startEvent().finish();
  assert.equal(before.started, 0);
  assert.equal(wideline.diagnostics().started, 1);
  assert.equal(wideline.enter(undefined, () => 42), 42);
});
