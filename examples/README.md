# wideline examples

Build the library once, then every example runs offline:

```bash
npm install && npm run build
```

## http-server.mjs — instrument a plain `node:http` server

```bash
node examples/http-server.mjs
# in another terminal:
curl http://127.0.0.1:8080/products/42
curl http://127.0.0.1:8080/boom
```

Each request prints one canonical NDJSON line on stdout. `/boom` throws
inside the handler: the error is captured onto the event (`error.type`,
`error.message`, `error.stack`), the client gets a 500, and — under any
sample rate — the event is kept because errored events always are.

## job.mjs — wide events for background work

```bash
node examples/job.mjs
```

Emits exactly two events via `wideline.run(name, fn)`: a successful
index rebuild (with a `scan.ms` timer and counters) and an intentional
failure whose error is recorded before the rejection propagates.

## The CLI pipeline, no server required

`wideline demo` generates a deterministic synthetic stream by driving
the real middleware over fake requests — ideal for exploring the CLI:

```bash
node dist/cli.js demo --requests 500 --seed 7 --rate 0.1 --slow-ms 250 \
  | node dist/cli.js stats --by http.route
node dist/cli.js demo --requests 50 --seed 7 | node dist/cli.js pretty | head -20
node dist/cli.js demo --requests 500 --seed 7 | node dist/cli.js sample --rate 0.05 \
  | node dist/cli.js check
```
