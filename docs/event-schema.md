# The wideline event schema

A wide event is **one flat JSON object per unit of work**: dot-separated
keys, primitive values (string / number / boolean / null, or a flat
array of those), serialized as a single NDJSON line. `wideline check`
enforces everything on this page.

## Canonical line format

Two events with the same fields serialize byte-identically:

1. the **core fields** below appear first, in this fixed order;
2. every other field follows, sorted lexicographically;
3. the whole record is one line — no pretty-printing, no nesting.

## Core fields

Stamped by the library; `time`, `event.id` and `service` are required
on every valid event.

| Key | Type | Meaning |
|---|---|---|
| `time` | string | ISO 8601 timestamp of the event's start |
| `event.id` | string | unique id, also the default sampling key |
| `event.name` | string | job/task name for non-HTTP events (`wideline.run`) |
| `service` | string | logical service name (required) |
| `service.version` | string | service version, if configured |
| `env` | string | deployment environment, if configured |
| `host` / `pid` | string / number | where the event was produced |
| `duration_ms` | number | start-to-finish, measured unless set explicitly |
| `event.dropped_fields` | number | fields dropped by the `maxFields` cap, if any |

## HTTP fields (middleware)

| Key | Type | Meaning |
|---|---|---|
| `http.method` | string | uppercased request method |
| `http.route` | string | route template (`/orders/:id`) — the grouping key |
| `http.path` | string | concrete path, query string always stripped |
| `http.status` | number | response status code |
| `http.request_id` | string | inbound `x-request-id` (configurable) or the event id |
| `http.user_agent` | string | User-Agent header (on by default) |
| `http.bytes_out` | number | Content-Length of the response, when known |
| `http.aborted` | boolean | client disconnected before the response finished |
| `http.client_ip` | string | remote address (opt-in via `includeClientIp`) |

## Error fields

First error wins the triple; every call to `event.error()` bumps the count.

| Key | Type | Meaning |
|---|---|---|
| `error.type` | string | error class name, or `Thrown` for non-Error throwables |
| `error.message` | string | first error's message, truncated to the value cap |
| `error.stack` | string | message line plus the first 5 frames |
| `error.count` | number | how many errors this unit of work saw |

## Sampling fields

Stamped at emit time on every kept event.

| Key | Type | Meaning |
|---|---|---|
| `sample.rate` | number ≥ 1 | the **weight** this event represents (1/effective rate); tail-kept events carry 1 |
| `sample.kept_by` | string | `always`, `head`, `tail:error`, `tail:slow`, or `tail:rule` |

Weights compose: re-sampling a stream with `wideline sample` multiplies
the prior weight by the new decision's weight, so estimates stay honest
through any number of passes.

## Enrichment conventions

- `event.count(key)` accumulates a number under `key`.
- `event.time(key)` folds N timed sections into `key.ms` + `key.count`.
- `event.max(key, v)` keeps a high-water mark.
- Objects passed to `event.set()` flatten to dot-keys (depth-capped at 8);
  arrays of primitives stay arrays (length-capped at 64); strings are
  truncated at 1024 chars; keys matching the redaction list emit as
  `[REDACTED]`.
