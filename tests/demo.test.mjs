// The demo generator doubles as an integration test of the whole
// pipeline: middleware over fake req/res, enrichment, sampling with a
// per-route rule, tail keeping, canonical emission. Determinism is the
// headline property — same seed, same stream.
import test from "node:test";
import assert from "node:assert/strict";
import { CaptureEmitter, checkStream, mulberry32, runDemo } from "../dist/index.js";

function demo(options = {}) {
  const emitter = new CaptureEmitter();
  const result = runDemo({ requests: 100, seed: 7, rate: 1, emitter, ...options });
  return { emitter, result };
}

test("same seed produces a byte-identical stream; different seeds differ", () => {
  // The PRNG underneath is deterministic and confined to [0, 1).
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 100; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
  const { emitter: first } = demo();
  const { emitter: second } = demo();
  assert.deepEqual(first.lines, second.lines);
  assert.ok(first.lines.length > 0);
  const { emitter: other } = demo({ seed: 2 });
  assert.notDeepEqual(first.lines, other.lines);
});

test("every generated line passes wideline's own checker", () => {
  const { emitter } = demo({ requests: 300 });
  const result = checkStream(emitter.lines.join("\n"));
  assert.equal(result.problems.length, 0);
  assert.equal(result.valid, result.total);
});

test("the health route is downsampled by rule even at rate 1", () => {
  const { emitter, result } = demo({ requests: 400 });
  const health = emitter.events.filter((e) => e["http.route"] === "/health");
  const others = emitter.events.filter((e) => e["http.route"] !== "/health");
  // Roughly 3/16 of 400 requests are health checks; at 2% nearly all drop.
  assert.ok(health.length < 8, `health kept ${health.length}`);
  assert.ok(others.length > 200);
  assert.ok(result.sampledOut > 50);
});

test("errors survive head sampling; slow requests survive when slowMs is set", () => {
  const { emitter } = demo({ requests: 500, rate: 0.05 });
  const errors = emitter.events.filter((e) => e["error.message"] !== undefined);
  assert.ok(errors.length > 0, "the 500-request demo should contain failures");
  for (const e of errors) {
    assert.equal(e["http.status"], 502);
    assert.equal(e["error.type"], "UpstreamTimeout");
    assert.ok(e["sample.kept_by"] === "tail:error" || e["sample.kept_by"] === "head");
  }
  const { emitter: slowRun } = demo({ requests: 500, rate: 0.01, slowMs: 250 });
  const slow = slowRun.events.filter((e) => e["sample.kept_by"] === "tail:slow");
  assert.ok(slow.length > 0, "expected tail:slow keeps");
  for (const e of slow) {
    assert.ok(e["duration_ms"] >= 250);
    assert.equal(e["sample.rate"], 1);
  }
});

test("head-kept events carry the reciprocal of their route's effective rate", () => {
  const { emitter } = demo({ requests: 500, rate: 0.1 });
  const head = emitter.events.filter((e) => e["sample.kept_by"] === "head");
  assert.ok(head.length > 10);
  for (const e of head) {
    // /health runs under a 2% rule (weight 50); everything else at 10%.
    assert.equal(e["sample.rate"], e["http.route"] === "/health" ? 50 : 10);
  }
});

test("handler enrichment lands: db timers, user plan, checkout fields", () => {
  const { emitter } = demo({ requests: 200 });
  const checkout = emitter.events.find((e) => e["http.route"] === "/checkout");
  assert.ok(checkout);
  assert.ok(checkout["cart.items"] >= 1);
  assert.equal(checkout["payment.provider"], "cardpay");
  assert.ok(checkout["db.ms"] >= 0);
  assert.equal(checkout["db.count"], 1);
  assert.ok(["free", "pro", "team"].includes(checkout["user.plan"]));
});

test("event ids are sequential request ids and times are monotonic", () => {
  const { emitter } = demo({ requests: 50 });
  const times = emitter.events.map((e) => Date.parse(e["time"]));
  for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1]);
  assert.match(emitter.events[0]["event.id"], /^req-\d{6}$/);
});
