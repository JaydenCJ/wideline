/**
 * wideline public API.
 *
 * The intended entry point is `new Wideline({...})`: mount its
 * `.middleware()` (or `.wrap()` a plain handler), enrich the current
 * event anywhere via `.current()`, and every request leaves exactly one
 * canonical NDJSON line. The lower-level pieces (event, sampler,
 * emitters, checkers, aggregation) are exported for tests and tooling.
 */

export { Wideline } from "./wideline.js";
export { WideEvent } from "./event.js";
export type { WideEventInit } from "./event.js";
export {
  CaptureEmitter,
  NdjsonEmitter,
  TeeEmitter,
  canonicalKeys,
  serializeEvent,
  CORE_KEY_ORDER,
} from "./emitter.js";
export type { WritableLike } from "./emitter.js";
export { Sampler, fnv1a, hashUnit, isErrorEvent, matchRule } from "./sampler.js";
export { createRedactor, DEFAULT_REDACT_KEYS, REDACTED } from "./redact.js";
export type { Redactor } from "./redact.js";
export {
  flattenInto,
  normalizeKey,
  isValidKey,
  truncate,
  safeStringify,
  firstStackFrames,
} from "./fields.js";
export {
  createMiddleware,
  wrapHandler,
  enrichFromRequest,
  enrichFromResponse,
  resolveRoute,
  pathOf,
} from "./middleware.js";
export type {
  ExpressMiddleware,
  HttpHandler,
  MiddlewareOptions,
  RequestLike,
  ResponseLike,
} from "./middleware.js";
export { checkEvent, checkStream, parseLine, parseStream } from "./check.js";
export type { CheckResult, Problem } from "./check.js";
export { aggregate, quantile, renderStats, renderStatsJson } from "./stats.js";
export type { GroupStats, StatsResult } from "./stats.js";
export { prettyEvent, prettyStream, summaryLine } from "./pretty.js";
export { runDemo, mulberry32 } from "./demo.js";
export type { DemoOptions } from "./demo.js";
export { VERSION } from "./version.js";
export type {
  Clock,
  Diagnostics,
  Emitter,
  EventRecord,
  FieldValue,
  Limits,
  Primitive,
  RedactOptions,
  SampleDecision,
  SampleOptions,
  SampleRule,
  WidelineOptions,
} from "./types.js";
export { DEFAULT_LIMITS } from "./types.js";
