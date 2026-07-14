/**
 * `wideline demo`: a deterministic, fully offline traffic simulation
 * that drives the real pipeline — Wideline instance, middleware, fake
 * req/res pairs, sampler, NDJSON emitter — so the CLI can demonstrate
 * (and the smoke test can assert) end-to-end behavior without opening
 * a socket. Same seed, same stream, byte for byte.
 */

import { Wideline } from "./wideline.js";
import type { RequestLike, ResponseLike } from "./middleware.js";
import type { Clock, Emitter } from "./types.js";

/** Small, well-known deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DemoOptions {
  requests: number;
  seed: number;
  rate: number;
  slowMs?: number;
  emitter: Emitter;
}

interface RouteSpec {
  method: string;
  route: string;
  path: (rng: () => number) => string;
  baseMs: number;
  jitterMs: number;
  errorEvery: number; // 1-in-N requests fail with a 5xx
  weight: number;
}

const ROUTES: RouteSpec[] = [
  { method: "GET", route: "/products", path: () => "/products", baseMs: 18, jitterMs: 30, errorEvery: 200, weight: 5 },
  { method: "GET", route: "/products/:id", path: (rng) => `/products/${1 + Math.floor(rng() * 500)}`, baseMs: 12, jitterMs: 22, errorEvery: 150, weight: 6 },
  { method: "POST", route: "/checkout", path: () => "/checkout", baseMs: 55, jitterMs: 320, errorEvery: 12, weight: 2 },
  { method: "GET", route: "/health", path: () => "/health", baseMs: 1, jitterMs: 2, errorEvery: 0, weight: 3 },
];

class FakeResponse implements ResponseLike {
  statusCode = 200;
  writableEnded = false;
  headersSent = false;
  private bytes = 0;
  private listeners = new Map<string, (() => void)[]>();

  on(event: string, listener: () => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  getHeader(name: string): unknown {
    return name === "content-length" ? this.bytes : undefined;
  }

  end(body = ""): void {
    this.headersSent = true;
    this.writableEnded = true;
    this.bytes = body.length;
    for (const l of this.listeners.get("finish") ?? []) l();
    for (const l of this.listeners.get("close") ?? []) l();
  }
}

function pickRoute(rng: () => number): RouteSpec {
  const total = ROUTES.reduce((s, r) => s + r.weight, 0);
  let roll = rng() * total;
  for (const r of ROUTES) {
    roll -= r.weight;
    if (roll <= 0) return r;
  }
  return ROUTES[0] as RouteSpec;
}

const PLANS = ["free", "pro", "team"] as const;

/** Run the simulation; every emitted line goes through `options.emitter`. */
export function runDemo(options: DemoOptions): { emitted: number; sampledOut: number } {
  const rng = mulberry32(options.seed);
  let nowMs = Date.parse("2026-07-01T12:00:00.000Z");
  const clock: Clock = { now: () => nowMs };
  let requestNo = 0;

  const wideline = new Wideline({
    service: "shop-api",
    version: "1.4.2",
    env: "prod",
    host: "web-1",
    pid: 4242,
    clock,
    emitter: options.emitter,
    idGenerator: () => `req-${String(++requestNo).padStart(6, "0")}`,
    sample: {
      rate: options.rate,
      rules: [{ match: { "http.route": "/health" }, rate: Math.min(options.rate, 0.02) }],
      keepErrors: true,
      ...(options.slowMs !== undefined ? { slowMs: options.slowMs } : {}),
    },
  });
  const middleware = wideline.middleware();

  for (let i = 0; i < options.requests; i++) {
    const spec = pickRoute(rng);
    const req: RequestLike = {
      method: spec.method,
      url: spec.path(rng),
      headers: { "user-agent": "shop-web/3.2" },
      route: { path: spec.route },
    };
    const res = new FakeResponse();

    middleware(req, res, () => {
      const event = wideline.currentFor(req);
      if (!event) return;
      // Handler-side enrichment: business fields, counters, timers.
      event.set("user.plan", PLANS[Math.floor(rng() * PLANS.length)] ?? "free");
      if (spec.route !== "/health") {
        const queries = 1 + Math.floor(rng() * 4);
        const stopDb = event.time("db");
        nowMs += Math.round(2 + rng() * 9);
        stopDb();
        event.count("db.queries", queries);
      }
      if (spec.route === "/checkout") {
        event.set("cart.items", 1 + Math.floor(rng() * 6));
        event.set("payment.provider", "cardpay");
      }
      const failed = spec.errorEvery > 0 && Math.floor(rng() * spec.errorEvery) === 0;
      const handlerMs = Math.round(spec.baseMs + rng() * spec.jitterMs);
      nowMs += handlerMs;
      if (failed) {
        res.statusCode = 502;
        event.error(new UpstreamTimeout(`upstream timed out after ${handlerMs}ms`));
      }
      res.end(failed ? "bad gateway" : `ok:${spec.route}`);
    });
    nowMs += 40 + Math.round(rng() * 200); // gap until the next arrival
  }

  const d = wideline.diagnostics();
  return { emitted: d.emitted, sampledOut: d.sampledOut };
}

class UpstreamTimeout extends Error {
  override name = "UpstreamTimeout";
  constructor(message: string) {
    super(message);
    this.stack = `UpstreamTimeout: ${message}\n    at PaymentClient.charge (payments.ts:88:11)`;
  }
}
