# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-07-13

### Added

- `Wideline` core: one accumulating `WideEvent` per unit of work with
  `set` (dot-key flattening of nested objects, arrays, Dates, Errors),
  `count`, `max`, `time` timers that fold N sections into `key.ms` +
  `key.count`, and `error` with first-error-wins triples — all bounded
  by configurable caps (fields, value length, depth, array length) and
  guaranteed never to throw on the request path.
- Exactly-once emission: `finish()` races (double finish, res
  finish+close, late `set` calls) collapse into one canonical line;
  late mutations are counted in `diagnostics()` instead of honored.
- Key-based redaction: a built-in sensitive-key list (password, token,
  authorization, cookie, …) matched on the last dot segment, extensible
  with substrings and full-key RegExps; secrets emit as `[REDACTED]`.
- Sampling engine: deterministic hash-based head decisions (FNV-1a with
  a murmur-style finalizer, keyed by `event.id` or any field such as
  `trace.id`), per-match rate-override rules, and tail-based keeps —
  errors/5xx, `slowMs` latency threshold, custom keep predicates — with
  honest `sample.rate` weights (tail keeps carry weight 1).
- Framework-agnostic HTTP middleware (Express-compatible signature,
  structurally typed) plus `wrap()` for plain `node:http` handlers:
  request/response enrichment, Express route templates, request-id
  propagation, abort detection, thrown/rejected handler capture, and
  AsyncLocalStorage context so `wideline.current()` works anywhere.
- `wideline.run(name, fn)` for jobs and consumers: one named event per
  run, errors recorded and rethrown, always finished.
- Canonical NDJSON emitters (`NdjsonEmitter`, `CaptureEmitter`,
  `TeeEmitter`): core fields first in fixed order, the rest sorted —
  equal records serialize byte-identically.
- CLI: `demo` (deterministic seeded traffic through the real pipeline),
  `check` (schema validation with line-numbered problems, exit 1),
  `stats` (weighted estimates, error rates, p50/p95/p99 by any field),
  `pretty` (human blocks), and `sample` (offline re-sampling with the
  same head+tail engine and composing weights); exit codes 0/1/2.
- Public programmatic API with type declarations, two runnable
  examples (instrumented `node:http` server, job runner), and the event
  schema contract in `docs/event-schema.md`.
- Test suite: 88 node:test tests (unit + CLI integration against the
  compiled binary) and an end-to-end `scripts/smoke.sh`.

[0.1.0]: https://github.com/JaydenCJ/wideline/releases/tag/v0.1.0
