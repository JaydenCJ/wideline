// The middleware lifecycle against fake req/res pairs: request-side
// enrichment, response-side enrichment, exactly-once finishing across
// finish/close races, aborts, async context, and the wrapped plain
// handler's error capture. No sockets anywhere.
import test from "node:test";
import assert from "node:assert/strict";
import { pathOf, resolveRoute } from "../dist/index.js";
import { fakeRequest, fakeResponse, makeWideline } from "./helpers.mjs";

test("request fields land and one request/response cycle emits exactly one event", () => {
  const { wideline, emitter } = makeWideline();
  const req = fakeRequest({ method: "post", url: "/checkout?promo=SUMMER" });
  const res = fakeResponse();
  // fakeResponse.end fires finish then close, mirroring node:http — the
  // settle guard must collapse the pair into a single emission.
  wideline.middleware()(req, res, () => res.end());
  assert.equal(emitter.events.length, 1);
  const record = emitter.events[0];
  assert.equal(record["http.method"], "POST");
  assert.equal(record["http.path"], "/checkout");
  assert.equal(record["http.user_agent"], "test-agent/1.0");
  assert.equal(record["http.request_id"], "ev-000001"); // no header -> event id
  assert.ok(!JSON.stringify(record).includes("SUMMER")); // queries carry secrets
  // Client ip is opt-in: absent by default, honored when enabled.
  const req2 = fakeRequest({ socket: { remoteAddress: "127.0.0.1" } });
  const res2 = fakeResponse();
  wideline.middleware()(req2, res2, () => res2.end());
  assert.equal(emitter.events[1]["http.client_ip"], undefined);
  const req3 = fakeRequest({ socket: { remoteAddress: "127.0.0.1" } });
  const res3 = fakeResponse();
  wideline.middleware({ includeClientIp: true })(req3, res3, () => res3.end());
  assert.equal(emitter.events[2]["http.client_ip"], "127.0.0.1");
});

test("request-id headers: x-request-id honored, custom header configurable", () => {
  const { wideline, emitter } = makeWideline();
  const req1 = fakeRequest({ headers: { "x-request-id": "upstream-77" } });
  const res1 = fakeResponse();
  wideline.middleware()(req1, res1, () => res1.end());
  assert.equal(emitter.events[0]["http.request_id"], "upstream-77");
  const req2 = fakeRequest({ headers: { "x-amzn-trace-id": "trace-1" } });
  const res2 = fakeResponse();
  wideline.middleware({ requestIdHeader: "x-amzn-trace-id" })(req2, res2, () => res2.end());
  assert.equal(emitter.events[1]["http.request_id"], "trace-1");
});

test("response fields land: status, bytes out, measured duration", () => {
  const { wideline, emitter, clock } = makeWideline();
  const req = fakeRequest();
  const res = fakeResponse();
  wideline.middleware()(req, res, () => {
    clock.tick(85);
    res.statusCode = 201;
    res.end("0123456789");
  });
  const record = emitter.events[0];
  assert.equal(record["http.status"], 201);
  assert.equal(record["http.bytes_out"], 10);
  assert.equal(record["duration_ms"], 85);
});

test("http.route resolution: Express template, concrete-path fallback, joins", () => {
  const { wideline, emitter } = makeWideline();
  const templated = fakeRequest({ url: "/things/42", route: { path: "/things/:id" } });
  const res1 = fakeResponse();
  wideline.middleware()(templated, res1, () => res1.end());
  assert.equal(emitter.events[0]["http.route"], "/things/:id");
  const bare = fakeRequest({ url: "/things/42?x=1" });
  const res2 = fakeResponse();
  wideline.middleware()(bare, res2, () => res2.end());
  assert.equal(emitter.events[1]["http.route"], "/things/42");
  // resolveRoute joins baseUrl + route.path like a mounted Express router.
  assert.equal(resolveRoute({ route: { path: "/:id" }, baseUrl: "/api/things" }), "/api/things/:id");
  assert.equal(resolveRoute({ route: { path: "/" }, baseUrl: "/api" }), "/api");
  assert.equal(resolveRoute({ route: { path: "/" } }), "/");
  assert.equal(resolveRoute({}), undefined);
  // pathOf strips queries and survives missing urls.
  assert.equal(pathOf("/a/b?c=d"), "/a/b");
  assert.equal(pathOf("/plain"), "/plain");
  assert.equal(pathOf("?only=query"), "/");
  assert.equal(pathOf(undefined), "/");
});

test("route overrides: handler-set route wins; custom resolver is consulted", () => {
  const { wideline, emitter } = makeWideline();
  const req = fakeRequest();
  const res = fakeResponse();
  wideline.middleware()(req, res, () => {
    wideline.currentFor(req).set("http.route", "/custom/:slug");
    res.end();
  });
  assert.equal(emitter.events[0]["http.route"], "/custom/:slug");
  const req2 = fakeRequest({ url: "/v2/orders/9" });
  const res2 = fakeResponse();
  wideline.middleware({ route: () => "/v2/orders/:id" })(req2, res2, () => res2.end());
  assert.equal(emitter.events[1]["http.route"], "/v2/orders/:id");
});

test("a client abort (close without finish) is recorded and still emits once", () => {
  const { wideline, emitter } = makeWideline();
  const req = fakeRequest();
  const res = fakeResponse();
  wideline.middleware()(req, res, () => {
    /* handler never responds */
  });
  res.abort();
  assert.equal(emitter.events.length, 1);
  assert.equal(emitter.events[0]["http.aborted"], true);
});

test("wideline.current() resolves inside the handler's async continuations", async () => {
  const { wideline, emitter } = makeWideline();
  const req = fakeRequest();
  const res = fakeResponse();
  await new Promise((resolve) => {
    wideline.middleware()(req, res, () => {
      queueMicrotask(() => {
        wideline.current()?.set("late.async", "yes");
        res.end();
        resolve();
      });
    });
  });
  assert.equal(emitter.events[0]["late.async"], "yes");
  // And outside any request context there is no current event.
  assert.equal(wideline.current(), undefined);
});

test("two interleaved requests keep separate events", () => {
  const { wideline, emitter } = makeWideline();
  const middleware = wideline.middleware();
  const reqA = fakeRequest({ url: "/a" });
  const resA = fakeResponse();
  const reqB = fakeRequest({ url: "/b" });
  const resB = fakeResponse();
  middleware(reqA, resA, () => wideline.currentFor(reqA).set("who", "a"));
  middleware(reqB, resB, () => wideline.currentFor(reqB).set("who", "b"));
  resB.end();
  resA.end();
  assert.equal(emitter.events.length, 2);
  assert.equal(emitter.events[0]["who"], "b");
  assert.equal(emitter.events[1]["who"], "a");
});

test("wrap(): throwing and rejecting handlers record the error and answer 500", async () => {
  const { wideline, emitter } = makeWideline();
  const throwing = wideline.wrap(() => {
    throw new Error("handler exploded");
  });
  const res1 = fakeResponse();
  throwing(fakeRequest(), res1);
  assert.equal(res1.statusCode, 500);
  assert.equal(emitter.events[0]["error.message"], "handler exploded");
  assert.equal(emitter.events[0]["http.status"], 500);
  const rejecting = wideline.wrap(async () => {
    throw new Error("async boom");
  });
  rejecting(fakeRequest(), fakeResponse());
  await new Promise((r) => setImmediate(r));
  assert.equal(emitter.events[1]["error.message"], "async boom");
  assert.equal(emitter.events[1]["http.status"], 500);
  // A healthy handler emits a normal event.
  const healthy = wideline.wrap((req, res) => res.end("ok"));
  healthy(fakeRequest(), fakeResponse());
  assert.equal(emitter.events[2]["http.status"], 200);
  assert.equal(emitter.events[2]["error.message"], undefined);
  // A return value with a non-function `then` is not mistaken for a promise.
  const oddReturn = wideline.wrap((req, res) => {
    res.end("ok");
    return { then: "not a function" };
  });
  oddReturn(fakeRequest(), fakeResponse());
  assert.equal(emitter.events[3]["http.status"], 200);
  assert.equal(emitter.events[3]["error.message"], undefined);
});

