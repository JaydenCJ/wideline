/**
 * HTTP instrumentation. The middleware owns the event lifecycle for a
 * request: start on arrival, enrich from the request, run the handler
 * inside async context (so any code can reach the event without
 * plumbing), and finish exactly once when the response ends — whether
 * it finished cleanly, errored, or the client walked away.
 *
 * Everything is typed structurally against the small slice of
 * req/res that is actually read, so the same code instruments plain
 * `node:http`, Express, and anything Express-shaped, and tests can
 * drive it with tiny fakes.
 */

import type { WideEvent } from "./event.js";
import type { Wideline } from "./wideline.js";

/** The slice of IncomingMessage the middleware reads. */
export interface RequestLike {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  /** Express route info, when present. */
  route?: { path?: string };
  baseUrl?: string;
  socket?: { remoteAddress?: string };
}

/** The slice of ServerResponse the middleware reads and listens to. */
export interface ResponseLike {
  statusCode?: number;
  getHeader?(name: string): unknown;
  on(event: string, listener: () => void): unknown;
  writableEnded?: boolean;
  headersSent?: boolean;
  end?(body?: string): unknown;
  setHeader?(name: string, value: string): unknown;
}

export interface MiddlewareOptions {
  /** Header consulted for `http.request_id`. Default "x-request-id". */
  requestIdHeader?: string;
  /** Record the User-Agent header. Default true. */
  includeUserAgent?: boolean;
  /** Record the client address as `http.client_ip`. Default false. */
  includeClientIp?: boolean;
  /**
   * Resolve the route template for grouping (e.g. "/orders/:id").
   * Defaults to Express's `req.route.path` when available, else the
   * concrete path.
   */
  route?: (req: RequestLike) => string | undefined;
}

/** First value of a possibly-multi header. */
function headerValue(req: RequestLike, name: string): string | undefined {
  const raw = req.headers?.[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/** Path portion of a request URL (query string stripped, never logged). */
export function pathOf(url: string | undefined): string {
  if (!url) return "/";
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q) || "/";
}

/** Express route template when available: baseUrl + route.path. */
export function resolveRoute(req: RequestLike): string | undefined {
  const routePath = req.route?.path;
  if (typeof routePath !== "string") return undefined;
  const base = typeof req.baseUrl === "string" ? req.baseUrl : "";
  const joined = base + (routePath === "/" && base ? "" : routePath);
  return joined || "/";
}

/** Fill request-side fields on a freshly started event. */
export function enrichFromRequest(
  event: WideEvent,
  req: RequestLike,
  options: MiddlewareOptions
): void {
  event.set("http.method", (req.method ?? "GET").toUpperCase());
  event.set("http.path", pathOf(req.url));
  const idHeader = options.requestIdHeader ?? "x-request-id";
  const requestId = headerValue(req, idHeader) ?? event.get("event.id");
  event.set("http.request_id", requestId ?? null);
  if (options.includeUserAgent !== false) {
    const ua = headerValue(req, "user-agent");
    if (ua !== undefined) event.set("http.user_agent", ua);
  }
  if (options.includeClientIp === true) {
    const ip = req.socket?.remoteAddress;
    if (ip) event.set("http.client_ip", ip);
  }
}

/** Fill response-side fields just before finish. */
export function enrichFromResponse(
  event: WideEvent,
  req: RequestLike,
  res: ResponseLike,
  options: MiddlewareOptions
): void {
  event.set("http.status", typeof res.statusCode === "number" ? res.statusCode : 0);
  const route = options.route ? options.route(req) : resolveRoute(req);
  if (event.get("http.route") === undefined) {
    event.set("http.route", route ?? pathOf(req.url));
  }
  const len = res.getHeader?.("content-length");
  const bytes = typeof len === "string" ? Number(len) : typeof len === "number" ? len : NaN;
  if (Number.isFinite(bytes)) event.set("http.bytes_out", bytes);
}

export type ExpressMiddleware = (
  req: RequestLike,
  res: ResponseLike,
  next?: (err?: unknown) => void
) => void;

/**
 * Build the middleware bound to a Wideline instance. Usable as Express
 * `app.use(...)` or called manually around a plain `node:http` handler.
 */
export function createMiddleware(
  wideline: Wideline,
  options: MiddlewareOptions = {}
): ExpressMiddleware {
  return (req, res, next) => {
    const event = wideline.startEvent();
    wideline.register(req, event);
    enrichFromRequest(event, req, options);

    let settled = false;
    const settle = (aborted: boolean) => {
      if (settled) return;
      settled = true;
      if (aborted) event.set("http.aborted", true);
      enrichFromResponse(event, req, res, options);
      event.finish();
    };
    res.on("finish", () => settle(false));
    res.on("close", () => settle(res.writableEnded === false));

    if (next) {
      wideline.enter(event, () => next());
    } else {
      wideline.enter(event, () => undefined);
    }
  };
}

export type HttpHandler = (req: RequestLike, res: ResponseLike) => unknown;

/**
 * Wrap a plain `http.createServer` handler: instruments the request and
 * converts a synchronously-thrown or rejected handler into an error
 * field plus a 500 (when headers are still writable) instead of a
 * crashed connection with no event.
 */
export function wrapHandler(
  wideline: Wideline,
  handler: HttpHandler,
  options: MiddlewareOptions = {}
): HttpHandler {
  const middleware = createMiddleware(wideline, options);
  return (req, res) => {
    middleware(req, res, undefined);
    const event = wideline.currentFor(req);
    const fail = (err: unknown) => {
      event?.error(err);
      if (res.headersSent !== true) {
        res.statusCode = 500;
        res.end?.("internal error\n");
      } else {
        res.end?.();
      }
    };
    try {
      const out = wideline.enter(event, () => handler(req, res));
      const then = (out as { then?: unknown } | null)?.then;
      if (out !== null && typeof out === "object" && typeof then === "function") {
        (out as Promise<unknown>).then(undefined, fail);
      }
      return out;
    } catch (err) {
      fail(err);
      return undefined;
    }
  };
}
