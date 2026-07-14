// The check contract: what a valid wide-event NDJSON stream looks like.
// Every rule the CLI's `check` command enforces is pinned here against
// hand-built lines, including the guarantee that wideline's own output
// always passes its own checker.
import test from "node:test";
import assert from "node:assert/strict";
import { checkStream, parseStream, serializeEvent } from "../dist/index.js";
import { makeWideline } from "./helpers.mjs";

const VALID = {
  time: "2026-07-01T00:00:00.000Z",
  "event.id": "ev-1",
  service: "svc",
  duration_ms: 12,
};

const line = (obj) => JSON.stringify(obj);

test("a healthy stream checks clean; blank lines are skipped, not counted", () => {
  const text = `\n${line(VALID)}\n\n${line({ ...VALID, "event.id": "ev-2" })}\n\n`;
  const result = checkStream(text);
  assert.deepEqual(result, { total: 2, valid: 2, problems: [] });
});

test("malformed lines are reported with line numbers; the rest still check", () => {
  const text = [line(VALID), "{not json", "[1,2,3]", line({ ...VALID, "event.id": "e4" })].join("\n");
  const result = checkStream(text);
  assert.equal(result.total, 4);
  assert.equal(result.valid, 2);
  assert.equal(result.problems.length, 2);
  assert.equal(result.problems[0].line, 2);
  assert.match(result.problems[0].message, /invalid JSON/);
  assert.match(result.problems[1].message, /not a JSON object/);
});

test("each missing required field is its own problem; bad timestamps are flagged", () => {
  const missing = checkStream(line({ duration_ms: 1 }));
  assert.deepEqual(missing.problems.map((p) => p.key).sort(), ["event.id", "service", "time"]);
  const badTime = checkStream(line({ ...VALID, time: "yesterday-ish" }));
  assert.equal(badTime.valid, 0);
  assert.ok(badTime.problems.some((p) => p.key === "time"));
});

test("wide events are flat: nested objects and object-arrays are rejected", () => {
  const nested = checkStream(line({ ...VALID, user: { plan: "pro" } }));
  assert.ok(nested.problems.some((p) => p.key === "user" && p.message.includes("flat")));
  assert.equal(checkStream(line({ ...VALID, tags: ["a", 1, null] })).valid, 1);
  assert.equal(checkStream(line({ ...VALID, tags: [{ deep: true }] })).valid, 0);
});

test("non-canonical keys and inconsistent metadata are flagged", () => {
  const keys = checkStream(line({ ...VALID, "has space": 1, "a..b": 2 }));
  assert.deepEqual(keys.problems.map((p) => p.key).sort(), ["a..b", "has space"]);
  const meta = checkStream(line({ ...VALID, duration_ms: -5, "sample.rate": 0.5 }));
  assert.deepEqual(meta.problems.map((p) => p.key).sort(), ["duration_ms", "sample.rate"]);
});

test("wideline's own emitter output always passes its own checker", () => {
  const { wideline, emitter, clock } = makeWideline({ version: "1.0.0", env: "prod" });
  const event = wideline.startEvent();
  event.set("user", { plan: "pro", scores: [1, 2, 3] });
  event.error(new Error("boom"));
  clock.tick(42);
  event.finish({ "http.status": 500 });
  const result = checkStream(emitter.lines.join("\n"));
  assert.deepEqual(result, { total: 1, valid: 1, problems: [] });
});

test("parseStream is tolerant and round-trips serializeEvent output", () => {
  const text = ["not json", line(VALID), "{", line({ ...VALID, "event.id": "e2" })].join("\n");
  const { records, skipped } = parseStream(text);
  assert.equal(records.length, 2);
  assert.equal(skipped, 2);
  const record = { ...VALID, "user.plan": "pro" };
  assert.deepEqual(parseStream(serializeEvent(record)).records[0], record);
});
