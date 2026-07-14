// End-to-end CLI integration: the compiled dist/cli.js run as a child
// process — commands, flags, stdin piping, exit codes, and the
// usage-error path. This is the same surface scripts/smoke.sh exercises.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function run(args, stdin = "") {
  const res = spawnSync("node", [CLI, ...args], { encoding: "utf8", input: stdin });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

function demoStream(args = []) {
  const res = run(["demo", "--requests", "120", "--seed", "11", ...args]);
  assert.equal(res.code, 0);
  return res.stdout;
}

test("--version prints the manifest version; --help documents the surface", () => {
  const version = run(["--version"]);
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), "0.1.0");
  const help = run(["--help"]);
  assert.equal(help.code, 0);
  for (const word of ["demo", "check", "stats", "pretty", "sample", "Exit codes"]) {
    assert.ok(help.stdout.includes(word), `help missing ${word}`);
  }
  const bare = run([]);
  assert.equal(bare.code, 0);
  assert.ok(bare.stdout.includes("Usage:"));
});

test("usage errors exit 2: unknown command, unknown flag, garbage numbers, bad file", () => {
  const command = run(["frobnicate"]);
  assert.equal(command.code, 2);
  assert.match(command.stderr, /unknown command/);
  assert.match(command.stderr, /--help/);
  const flag = run(["stats", "--nope"]);
  assert.equal(flag.code, 2);
  assert.match(flag.stderr, /unknown flag/);
  const number = run(["demo", "--rate", "lots"]);
  assert.equal(number.code, 2);
  assert.match(number.stderr, /--rate/);
  assert.match(number.stderr, /"lots"/);
  const file = run(["check", "/does/not/exist.ndjson"]);
  assert.equal(file.code, 2);
  assert.match(file.stderr, /cannot read input file/);
  // demo generates its stream; a stray file argument is a usage error, not silence.
  const demoFile = run(["demo", "some.ndjson"]);
  assert.equal(demoFile.code, 2);
  assert.match(demoFile.stderr, /does not take an input file/);
  // Boolean flags reject `=value` instead of silently treating --json=false as true.
  const boolValue = run(["stats", "--json=false"], "");
  assert.equal(boolValue.code, 2);
  assert.match(boolValue.stderr, /does not take a value/);
});

test("demo is deterministic across processes and keeps stdout pure NDJSON", () => {
  assert.equal(demoStream(), demoStream());
  const res = run(["demo", "--requests", "30", "--seed", "5", "--rate", "0.5"]);
  assert.match(res.stderr, /30 requests -> \d+ kept, \d+ sampled out/);
  for (const line of res.stdout.trim().split("\n")) JSON.parse(line); // must all parse
  // --slow-ms threads through to tail:slow keeps.
  const slow = run(["demo", "--requests", "400", "--seed", "3", "--rate", "0.01", "--slow-ms", "250"]);
  assert.equal(slow.code, 0);
  assert.match(slow.stdout, /"sample.kept_by":"tail:slow"/);
});

test("demo | check passes clean and exits 0, from stdin or a file argument", () => {
  const res = run(["check"], demoStream());
  assert.equal(res.code, 0);
  assert.match(res.stdout, /wideline check: OK/);
  assert.match(res.stdout, /0 invalid/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wideline-"));
  const file = path.join(dir, "d.ndjson");
  fs.writeFileSync(file, demoStream());
  assert.equal(run(["check", file]).code, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("check exits 1 on a corrupted stream, names the line, honors --quiet", () => {
  const bad = demoStream() + '{"time":"nope"}\n';
  const res = run(["check"], bad);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /wideline check: FAIL/);
  assert.match(res.stdout, /required field "service"/);
  const quiet = run(["check", "--quiet"], '{"bad":1}\n');
  assert.equal(quiet.code, 1);
  assert.equal(quiet.stdout.trim().split("\n").length, 1);
});

test("stats groups by http.route by default and prints the aligned table", () => {
  const res = run(["stats"], demoStream());
  assert.equal(res.code, 0);
  assert.match(res.stdout, /http\.route\s+events\s+est\s+err%/);
  assert.match(res.stdout, /\/checkout/);
  assert.match(res.stdout, /estimated pre-sampling/);
});

test("stats honors --by, --json and --top", () => {
  const byPlan = run(["stats", "--by", "user.plan"], demoStream());
  assert.equal(byPlan.code, 0);
  assert.match(byPlan.stdout, /user\.plan/);
  assert.match(byPlan.stdout, /pro|free|team/);
  const json = JSON.parse(run(["stats", "--json"], demoStream()).stdout);
  assert.equal(json.by, "http.route");
  assert.ok(json.groups.length >= 2);
  const topped = JSON.parse(run(["stats", "--json", "--top", "1"], demoStream()).stdout);
  assert.equal(topped.groups.length, 1);
});

test("pretty renders one block per event with a summary line", () => {
  const res = run(["pretty"], demoStream());
  assert.equal(res.code, 0);
  assert.match(res.stdout, /\[shop-api\] GET \/products/);
  assert.match(res.stdout, /user\.plan/);
});

test("sample re-samples a stream, keeps every error, requires --rate", () => {
  const stream = demoStream(["--requests", "400"]);
  const res = run(["sample", "--rate", "0.05"], stream);
  assert.equal(res.code, 0);
  const kept = res.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const inputErrors = stream
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e["error.message"] !== undefined).length;
  const keptErrors = kept.filter((e) => e["error.message"] !== undefined).length;
  assert.ok(kept.length < 400 * 0.3, `sampled stream too large: ${kept.length}`);
  assert.equal(keptErrors, inputErrors);
  assert.match(res.stderr, /wideline sample: kept/);
  const missing = run(["sample"], "");
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /requires --rate/);
});

test("sample --no-keep-errors drops errors; weights compose across passes", () => {
  const errorLine = (extra = {}) =>
    JSON.stringify({
      time: "2026-07-01T00:00:00.000Z",
      "event.id": "ev-1",
      service: "svc",
      "error.message": "boom",
      ...extra,
    }) + "\n";
  // An error event whose id hashes above 0.0001 must drop without keep-errors.
  const withKeep = run(["sample", "--rate", "0.0001"], errorLine());
  const withoutKeep = run(["sample", "--rate", "0.0001", "--no-keep-errors"], errorLine());
  assert.equal(withKeep.stdout.trim().split("\n").filter(Boolean).length, 1);
  assert.equal(withoutKeep.stdout.trim(), "");
  // Tail-kept: decision weight 1, prior weight 5 -> composed weight 5.
  const composed = run(["sample", "--rate", "0.0001"], errorLine({ "sample.rate": 5 }));
  const kept = JSON.parse(composed.stdout.trim());
  assert.equal(kept["sample.rate"], 5);
  assert.equal(kept["sample.kept_by"], "tail:error");
});
