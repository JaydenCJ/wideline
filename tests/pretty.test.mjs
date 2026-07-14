// Human rendering: the summary line composes from whatever well-known
// fields exist, details align, and output is plain deterministic text.
import test from "node:test";
import assert from "node:assert/strict";
import { prettyEvent, prettyStream, summaryLine } from "../dist/index.js";

const record = {
  time: "2026-07-01T12:34:56.789Z",
  "event.id": "ev-1",
  service: "shop-api",
  duration_ms: 42,
  "http.method": "GET",
  "http.route": "/products/:id",
  "http.status": 200,
  "user.plan": "pro",
};

test("the summary line reads time [service] METHOD route status duration", () => {
  assert.equal(summaryLine(record), "12:34:56.789 [shop-api] GET /products/:id 200 42ms");
  assert.ok(summaryLine({ ...record, "error.message": "boom" }).endsWith("ERROR"));
});

test("a job event summarizes with its name; garbage timestamps never throw", () => {
  const line = summaryLine({
    time: "2026-07-01T00:00:00.000Z",
    service: "worker",
    "event.name": "rebuild-index",
    duration_ms: 250,
  });
  assert.equal(line, "00:00:00.000 [worker] rebuild-index 250ms");
  assert.ok(summaryLine({ service: "s" }).startsWith("--:--:--"));
  assert.ok(summaryLine({ time: "garbage", service: "s" }).startsWith("--:--:--"));
});

test("detail fields align, exclude what the summary said, render arrays as JSON", () => {
  const out = prettyEvent({ ...record, tags: ["a", "b"] });
  const lines = out.split("\n");
  assert.equal(lines.length, 4); // summary + event.id, tags, user.plan
  assert.match(lines[1], /^ {2}event\.id {2,}ev-1$/);
  assert.match(out, /tags\s+\["a","b"\]/);
  assert.match(out, /user\.plan\s+pro/);
  assert.ok(!out.includes("http.method")); // consumed by the summary line
  // prettyStream separates events with blank lines.
  assert.equal(prettyStream([record, record]).split("\n\n").length, 2);
});
