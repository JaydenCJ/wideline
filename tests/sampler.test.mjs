// The sampling engine: deterministic head decisions, per-rule rate
// overrides, and the tail-based keeps that make error data survive a
// 1% rate. Weights are asserted exactly — downstream math depends on
// them being honest.
import test from "node:test";
import assert from "node:assert/strict";
import { Sampler, fnv1a, hashUnit, isErrorEvent, matchRule } from "../dist/index.js";

const base = (extra = {}) => ({
  time: "2026-07-01T00:00:00.000Z",
  "event.id": "ev-1",
  service: "svc",
  duration_ms: 20,
  ...extra,
});

test("fnv1a matches known reference vectors", () => {
  // Standard FNV-1a 32-bit test vectors.
  assert.equal(fnv1a(""), 0x811c9dc5);
  assert.equal(fnv1a("a"), 0xe40c292c);
  assert.equal(fnv1a("foobar"), 0xbf9cf968);
});

test("hashUnit is deterministic, in [0,1), and spreads sequential ids evenly", () => {
  for (const s of ["a", "req-000001", "trace-xyz", ""]) {
    const u = hashUnit(s);
    assert.equal(u, hashUnit(s));
    assert.ok(u >= 0 && u < 1, `${s} -> ${u}`);
  }
  // Sequential ids are the common real-world key; raw FNV-1a clusters
  // badly on them (3 of the first 200 below 0.1 before the finalizer).
  let below = 0;
  for (let i = 1; i <= 2000; i++) {
    if (hashUnit(`req-${String(i).padStart(6, "0")}`) < 0.1) below++;
  }
  assert.ok(below > 140 && below < 260, `expected ~200, got ${below}`);
});

test("rate 1 (and the default config) keeps everything; garbage rates clamp", () => {
  assert.deepEqual(new Sampler({ rate: 1 }).decide(base()), {
    kept: true,
    weight: 1,
    keptBy: "always",
  });
  assert.equal(new Sampler().decide(base()).kept, true);
  assert.equal(new Sampler({ rate: 7 }).decide(base()).keptBy, "always");
  assert.equal(new Sampler({ rate: NaN }).decide(base()).keptBy, "always");
  assert.equal(new Sampler({ rate: -1, keepErrors: false }).decide(base()).kept, false);
});

test("head decisions are deterministic per key: same event, same fate", () => {
  const sampler = new Sampler({ rate: 0.3 });
  const record = base({ "event.id": "req-000042" });
  const first = sampler.decide(record);
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(sampler.decide(record), first);
  }
  // byKey samples whole groups together — every event of a trace shares its fate.
  const byTrace = new Sampler({ rate: 0.5, byKey: "trace.id", keepErrors: false });
  const fate = byTrace.decide(base({ "event.id": "e1", "trace.id": "t-1" })).kept;
  for (const id of ["e2", "e3", "e4"]) {
    assert.equal(byTrace.decide(base({ "event.id": id, "trace.id": "t-1" })).kept, fate);
  }
});

test("head keeps carry weight 1/rate (rounded to 4 decimals) and hit ~rate overall", () => {
  const tenth = new Sampler({ rate: 0.1, keepErrors: false });
  let kept = 0;
  let sawWeight = false;
  for (let i = 1; i <= 5000; i++) {
    const d = tenth.decide(base({ "event.id": `ev-${i}` }));
    if (d.kept) {
      kept++;
      assert.equal(d.weight, 10);
      assert.equal(d.keptBy, "head");
      sawWeight = true;
    }
  }
  assert.ok(sawWeight);
  assert.ok(kept > 400 && kept < 600, `expected ~500 of 5000, got ${kept}`);
  // Non-integer reciprocals round for clean serialization: 1/0.3 -> 3.3333.
  const third = new Sampler({ rate: 0.3, keepErrors: false });
  for (let i = 1; i <= 50; i++) {
    const d = third.decide(base({ "event.id": `ev-${i}` }));
    if (d.kept) return assert.equal(d.weight, 3.3333);
  }
  assert.fail("no keep at rate 0.3 in 50 tries");
});

test("tail keep: errors and 5xx survive any rate with weight 1; 4xx does not", () => {
  const sampler = new Sampler({ rate: 0.000001 });
  const errored = sampler.decide(base({ "error.message": "boom", "error.count": 1 }));
  assert.equal(errored.kept, true);
  assert.equal(errored.keptBy, "tail:error");
  assert.equal(errored.weight, 1); // tail-kept events represent only themselves
  assert.equal(sampler.decide(base({ "http.status": 503 })).keptBy, "tail:error");
  assert.equal(sampler.decide(base({ "http.status": 404 })).kept, false);
  // keepErrors:false really does let errors drop.
  const lax = new Sampler({ rate: 0.000001, keepErrors: false });
  assert.equal(lax.decide(base({ "error.message": "boom" })).kept, false);
});

test("tail keep: slowMs rescues slow requests, strictly at the threshold", () => {
  const sampler = new Sampler({ rate: 0.000001, slowMs: 1000 });
  assert.equal(sampler.decide(base({ duration_ms: 1500 })).keptBy, "tail:slow");
  assert.equal(sampler.decide(base({ duration_ms: 1000 })).keptBy, "tail:slow");
  assert.equal(sampler.decide(base({ duration_ms: 999 })).kept, false);
});

test("tail keep: a custom keep rule fires last; a throwing rule drops cleanly", () => {
  const sampler = new Sampler({
    rate: 0.000001,
    keep: (fields) => fields["user.plan"] === "enterprise",
  });
  assert.equal(sampler.decide(base({ "user.plan": "enterprise" })).keptBy, "tail:rule");
  assert.equal(sampler.decide(base({ "user.plan": "free" })).kept, false);
  const throwing = new Sampler({
    rate: 0.000001,
    keep: () => {
      throw new Error("bad rule");
    },
  });
  assert.equal(throwing.decide(base()).kept, false);
});

test("rules override the base rate; first match wins; every match field must equal", () => {
  const sampler = new Sampler({
    rate: 1,
    rules: [
      { match: { "http.route": "/health" }, rate: 0 },
      { match: { "http.route": "/health" }, rate: 1 }, // unreachable
    ],
    keepErrors: false,
  });
  assert.equal(sampler.decide(base({ "http.route": "/health" })).kept, false);
  assert.equal(sampler.decide(base({ "http.route": "/checkout" })).kept, true);
  const rules = [{ match: { "http.route": "/health", "http.method": "GET" }, rate: 0 }];
  assert.ok(matchRule(base({ "http.route": "/health", "http.method": "GET" }), rules));
  assert.equal(
    matchRule(base({ "http.route": "/health", "http.method": "POST" }), rules),
    undefined
  );
  // And even a rate-0 rule cannot drop errors while keepErrors is on.
  const strict = new Sampler({
    rate: 1,
    rules: [{ match: { "http.route": "/health" }, rate: 0 }],
  });
  const d = strict.decide(base({ "http.route": "/health", "http.status": 500 }));
  assert.equal(d.keptBy, "tail:error");
});

test("isErrorEvent recognizes each error signal independently", () => {
  assert.equal(isErrorEvent(base()), false);
  assert.equal(isErrorEvent(base({ "error.message": "x" })), true);
  assert.equal(isErrorEvent(base({ "error.type": "TypeError" })), true);
  assert.equal(isErrorEvent(base({ "error.count": 2 })), true);
  assert.equal(isErrorEvent(base({ "http.status": 500 })), true);
  assert.equal(isErrorEvent(base({ "http.status": 499 })), false);
});
