// A plain node:http server instrumented with wideline. Run it, hit it,
// and watch one canonical NDJSON line per request appear on stdout:
//
//   node examples/http-server.mjs
//   curl http://127.0.0.1:8080/products/42
//   curl http://127.0.0.1:8080/boom        # error -> always kept
//
// Build the library first: npm install && npm run build
import http from "node:http";
import { Wideline } from "../dist/index.js";

const wideline = new Wideline({
  service: "example-api",
  version: "0.1.0",
  env: "dev",
  sample: {
    rate: 1, // keep everything locally; drop to 0.1 to watch sampling work
    keepErrors: true,
    slowMs: 500,
  },
});

const server = http.createServer(
  wideline.wrap((req, res) => {
    const event = wideline.current();

    if (req.url.startsWith("/products/")) {
      event.set("http.route", "/products/:id");
      // Pretend to do database work; the timer folds into db.ms / db.count.
      const stop = event.time("db");
      const product = { id: req.url.split("/")[2], name: "widget" };
      stop();
      event.count("db.queries");
      event.set("product.id", product.id);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(product));
      return;
    }

    if (req.url.startsWith("/boom")) {
      // A thrown error is captured on the event and answered with a 500.
      throw new Error("intentional example failure");
    }

    res.statusCode = 404;
    res.end("not found\n");
  })
);

server.listen(8080, "127.0.0.1", () => {
  console.error("example-api listening on http://127.0.0.1:8080 (events on stdout)");
});
