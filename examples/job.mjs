// Wide events are not only for HTTP: any unit of work deserves one
// canonical line. This job runner emits exactly two events — one
// success, one recorded failure — then exits 0. Fully offline.
//
//   node examples/job.mjs
//
// Build the library first: npm install && npm run build
import { Wideline } from "../dist/index.js";

const wideline = new Wideline({ service: "example-worker", env: "dev" });

// A successful job: enrich as you go, one line at the end.
await wideline.run("rebuild-search-index", async (event) => {
  const stop = event.time("scan");
  const documents = ["a", "b", "c"]; // pretend this walked a corpus
  stop();
  event.set("index.documents", documents.length);
  event.count("index.batches");
});

// A failing job: the error lands on the event, the event still emits,
// and the rejection propagates to the caller as usual.
await wideline
  .run("sync-upstream", () => {
    throw new Error("upstream unreachable (this failure is intentional)");
  })
  .catch(() => {
    /* handled: the wide event already recorded it */
  });
