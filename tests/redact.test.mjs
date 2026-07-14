// Redaction: sensitive keys must never reach an emitter. These tests
// pin the built-in list, the last-segment matching rule, and the two
// extension points (extra substrings, full-key regexes).
import test from "node:test";
import assert from "node:assert/strict";
import { createRedactor, DEFAULT_REDACT_KEYS, REDACTED } from "../dist/index.js";
import { makeWideline } from "./helpers.mjs";

test("the default list catches classic credential keys, however namespaced or cased", () => {
  const redact = createRedactor();
  for (const key of ["password", "token", "authorization", "api_key", "cookie"]) {
    assert.equal(redact(key), true, key);
  }
  // Matching is on the last dot segment: namespacing does not hide secrets.
  assert.equal(redact("http.header.authorization"), true);
  assert.equal(redact("user.password_hash"), true);
  // And case-insensitive.
  assert.equal(redact("http.header.Authorization"), true);
  assert.equal(redact("API_KEY"), true);
  assert.ok(DEFAULT_REDACT_KEYS.length >= 10);
  assert.ok(DEFAULT_REDACT_KEYS.includes("password"));
});

test("telemetry keys survive — including sensitive words in parent segments", () => {
  const redact = createRedactor();
  for (const key of ["http.status", "duration_ms", "user.plan", "db.queries"]) {
    assert.equal(redact(key), false, key);
  }
  // `token_service.latency_ms` is telemetry about a service, not a secret.
  assert.equal(redact("token_service.latency_ms"), false);
});

test("extra string patterns extend the list; RegExp patterns test the full key", () => {
  const bySubstring = createRedactor({ keys: ["internal_id"] });
  assert.equal(bySubstring("user.internal_id"), true);
  assert.equal(bySubstring("user.id"), false);
  const byRegex = createRedactor({ keys: [/^payment\./] });
  assert.equal(byRegex("payment.card_holder"), true);
  assert.equal(byRegex("cart.total"), false);
  // defaults:false drops the built-in list entirely.
  const bare = createRedactor({ defaults: false, keys: ["only_this"] });
  assert.equal(bare("password"), false);
  assert.equal(bare("only_this"), true);
});

test("end to end: sensitive fields emit as [REDACTED], even via nested flattening", () => {
  const { wideline, emitter } = makeWideline();
  const event = wideline.startEvent();
  event.set("http.header.authorization", "Bearer abc123");
  event.set("user.plan", "pro");
  event.set("req", { headers: { cookie: "sid=xyz", accept: "text/html" } });
  event.finish();
  const record = emitter.events[0];
  assert.equal(record["http.header.authorization"], REDACTED);
  assert.equal(record["req.headers.cookie"], REDACTED);
  assert.equal(record["user.plan"], "pro");
  assert.equal(record["req.headers.accept"], "text/html");
  assert.ok(!emitter.lines[0].includes("abc123"));
  assert.ok(!emitter.lines[0].includes("sid=xyz"));
});
