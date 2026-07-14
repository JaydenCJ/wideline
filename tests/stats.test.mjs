// Aggregation math: weighted counts that undo head sampling, error
// rates, deterministic nearest-rank quantiles, and stable table output.
import test from "node:test";
import assert from "node:assert/strict";
import { aggregate, quantile, renderStats, renderStatsJson } from "../dist/index.js";

let n = 0;
const event = (route, extra = {}) => ({
  time: "2026-07-01T00:00:00.000Z",
  "event.id": `ev-${++n}`, // ids are irrelevant to aggregation
  service: "svc",
  "http.route": route,
  duration_ms: 10,
  ...extra,
});

test("quantile: nearest-rank on a sorted array, deterministic by construction", () => {
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(quantile(sorted, 0.5), 5);
  assert.equal(quantile(sorted, 0.95), 10);
  assert.equal(quantile(sorted, 0.99), 10);
  assert.equal(quantile([7], 0.5), 7);
  assert.equal(quantile([], 0.5), null);
});

test("groups form on the --by field, sort busiest-first, tie-break alphabetically", () => {
  const result = aggregate(
    [event("/a"), event("/b"), event("/b"), event("/b"), event("/a")],
    "http.route"
  );
  assert.deepEqual(result.groups.map((g) => g.key), ["/b", "/a"]);
  assert.equal(result.groups[0].events, 3);
  const tied = aggregate([event("/z"), event("/a")], "http.route");
  assert.deepEqual(tied.groups.map((g) => g.key), ["/a", "/z"]);
});

test("weighted counts undo head sampling: weight 10 counts as ten requests", () => {
  const records = [
    event("/a", { "sample.rate": 10 }),
    event("/a", { "sample.rate": 10 }),
    event("/a"), // tail-kept or unsampled, weight 1
  ];
  const result = aggregate(records, "http.route");
  assert.equal(result.groups[0].events, 3);
  assert.equal(result.groups[0].estimated, 21);
  assert.equal(result.totalEstimated, 21);
});

test("error rate is weighted errors over weighted total, matching the sampler's definition", () => {
  const result = aggregate(
    [
      event("/a", { "sample.rate": 9 }),
      event("/a", { "http.status": 500 }), // tail-kept error, weight 1
    ],
    "http.route"
  );
  assert.equal(result.groups[0].errors, 1);
  assert.equal(result.groups[0].errorRate, 0.1);
  const detect = aggregate(
    [
      event("/b", { "error.message": "boom" }),
      event("/b", { "http.status": 502 }),
      event("/b", { "http.status": 404 }), // caller's problem, not an error
    ],
    "http.route"
  );
  assert.equal(detect.groups[0].errors, 2);
});

test("duration quantiles come from the kept events; missing durations fabricate nothing", () => {
  const records = [10, 20, 30, 40, 50].map((d) => event("/a", { duration_ms: d }));
  const g = aggregate(records, "http.route").groups[0];
  assert.equal(g.p50, 30);
  assert.equal(g.p95, 50);
  assert.equal(g.max, 50);
  const noDuration = aggregate([{ ...event("/a"), duration_ms: undefined }], "http.route");
  assert.equal(noDuration.groups[0].p50, null);
  assert.equal(noDuration.groups[0].max, null);
});

test("grouping by an arbitrary field works; missing values fall into (none)", () => {
  const result = aggregate(
    [
      event("/a", { "user.plan": "pro" }),
      event("/b", { "user.plan": "pro" }),
      event("/c", { "user.plan": "free" }),
      event("/d"),
    ],
    "user.plan"
  );
  assert.deepEqual(result.groups.map((g) => g.key).sort(), ["(none)", "free", "pro"]);
  assert.equal(result.groups[0].key, "pro");
});

test("renderStats produces an aligned table, a summary line, and honors --top", () => {
  const records = [event("/api/items"), event("/api/items"), event("/health")];
  const out = renderStats(aggregate(records, "http.route", 3));
  const lines = out.split("\n");
  assert.match(lines[0], /^http\.route\s+events\s+est\s+err%/);
  assert.match(out, /\/api\/items/);
  assert.match(out, /3 events \(3 estimated pre-sampling\)/);
  assert.match(out, /3 unparseable lines skipped/);
  const one = renderStats(aggregate([event("/a")], "http.route", 1));
  assert.match(one, /1 event \(1 estimated pre-sampling\), 1 unparseable line skipped/);
  const topped = renderStats(aggregate(records, "http.route"), 1);
  assert.match(topped, /\/api\/items/);
  assert.doesNotMatch(topped, /\/health/);
  // The JSON rendering is parseable and carries the same numbers.
  const parsed = JSON.parse(
    renderStatsJson(aggregate([event("/a", { "sample.rate": 4 })], "http.route"))
  );
  assert.equal(parsed.by, "http.route");
  assert.equal(parsed.groups[0].estimated, 4);
});
