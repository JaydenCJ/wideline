# Contributing to wideline

Issues, discussions and pull requests are all welcome — this project
aims to stay small, zero-dependency at runtime, and honest about what
its numbers mean.

## Getting started

Requirements: Node.js >= 22.13 (for the stable `node:test` runner used by the suite).

```bash
git clone https://github.com/JaydenCJ/wideline.git
cd wideline
npm install            # installs typescript, the only devDependency
npm run build          # compile TypeScript to dist/
npm test               # build + 88 node:test tests
bash scripts/smoke.sh  # end-to-end CLI check
```

`scripts/smoke.sh` exercises the real CLI (demo generation, check,
stats, pretty, offline re-sampling, exit codes, the runnable job
example) and must print `SMOKE OK`.

## Before you open a pull request

1. `npx tsc -p tsconfig.json --noEmit` — the tree must type-check clean (strict mode is enforced).
2. `npm test` — all tests must pass.
3. `bash scripts/smoke.sh` — must print `SMOKE OK`.
4. Add tests for behavior changes; keep logic in pure, unit-testable
   modules (fields, sampler, emitter, check, stats take plain values —
   only the CLI and middleware touch process or request state).
5. Changes to the event schema need a row in `docs/event-schema.md` and
   a corresponding rule in `check` — the schema is a contract.

## Ground rules

- **No runtime dependencies.** The zero-dependency install is a core
  feature; adding one needs justification in the PR and will usually be
  declined.
- No network calls, ever — wideline writes lines to a stream you hand
  it. That is the whole I/O surface.
- The hot path never throws: `set`/`count`/`time`/`error`/`finish` must
  stay safe on hostile input. A logging library that crashes the request
  it was recording has failed at its one job.
- Sampling weights must stay honest: any change to head/tail decisions
  has to keep `sample.rate` meaning "this event represents N originals".
- Determinism is load-bearing: hash-based decisions, seeded demo, no
  RNG or wall-clock in tests.
- Code comments and doc comments are written in English.

## Reporting bugs

Please include: `wideline --version` output, the exact command line or
a minimal code snippet, and — for engine bugs — one offending NDJSON
line plus what you expected `check`/`stats`/the sampler to do with it.
Events are self-contained, which makes repro cases pleasantly small.

## Security

Do not open public issues for security problems; use GitHub private
vulnerability reporting on this repository instead.
