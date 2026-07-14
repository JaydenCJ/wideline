// Shared test helpers: a manual clock, a Wideline factory wired to an
// in-memory emitter and deterministic ids, and minimal fake req/res
// pairs that satisfy the structural types the middleware reads. Every
// test is hermetic: no network, no real time, no shared state.
import { CaptureEmitter, Wideline } from "../dist/index.js";

/** A clock the test advances by hand. */
export function manualClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    tick: (ms) => {
      t += ms;
      return t;
    },
  };
}

/** Sequential, deterministic event ids: ev-000001, ev-000002, ... */
export function sequentialIds(prefix = "ev") {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(6, "0")}`;
}

/**
 * A Wideline wired for tests: capture emitter, manual clock, fixed
 * host/pid, deterministic ids. Override anything via `options`.
 */
export function makeWideline(options = {}) {
  const emitter = new CaptureEmitter();
  const clock = manualClock();
  const wideline = new Wideline({
    service: "test-svc",
    host: "test-host",
    pid: 4242,
    clock,
    emitter,
    idGenerator: sequentialIds(),
    ...options,
  });
  return { wideline, emitter, clock };
}

/** The minimal request shape the middleware reads. */
export function fakeRequest(overrides = {}) {
  return {
    method: "GET",
    url: "/things/42?verbose=1",
    headers: { "user-agent": "test-agent/1.0" },
    ...overrides,
  };
}

/** A fake ServerResponse: fire res.end() to emit "finish" then "close". */
export function fakeResponse({ statusCode = 200 } = {}) {
  const listeners = new Map();
  return {
    statusCode,
    writableEnded: false,
    headersSent: false,
    _body: "",
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return this;
    },
    getHeader(name) {
      return name === "content-length" ? this._body.length : undefined;
    },
    end(body = "") {
      this.headersSent = true;
      this.writableEnded = true;
      this._body = body;
      for (const l of listeners.get("finish") ?? []) l();
      for (const l of listeners.get("close") ?? []) l();
    },
    /** Simulate the client disconnecting before the response finished. */
    abort() {
      for (const l of listeners.get("close") ?? []) l();
    },
  };
}
