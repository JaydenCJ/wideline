#!/usr/bin/env bash
# Smoke test for wideline: exercises the real CLI end to end — demo
# generation, validation, aggregation, pretty rendering, offline
# re-sampling with tail-based error keeping, and the runnable job
# example. No network, idempotent, runs from a clean checkout (after
# `npm install`). Prints "SMOKE OK" on success.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

fail() {
  echo "SMOKE FAIL: $1" >&2
  exit 1
}

# 1. Build (idempotent).
npm run build >/dev/null 2>&1 || fail "npm run build failed"
CLI="node $ROOT/dist/cli.js"
echo "[smoke] build ok"

# 2. --version matches package.json; --help documents the surface.
PKG_VERSION="$(node -p "require('$ROOT/package.json').version")"
CLI_VERSION="$($CLI --version)"
[ "$CLI_VERSION" = "$PKG_VERSION" ] || fail "--version mismatch: $CLI_VERSION != $PKG_VERSION"
HELP="$($CLI --help)"
for word in demo check stats pretty sample --rate --slow-ms "Exit codes"; do
  echo "$HELP" | grep -q -- "$word" || fail "--help missing $word"
done
echo "[smoke] --help/--version ok ($CLI_VERSION)"

# 3. Usage errors exit 2 (distinct from findings' exit 1).
set +e
$CLI frobnicate >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "unknown command should exit 2"; }
$CLI stats --nope >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "unknown flag should exit 2"; }
$CLI demo --rate lots >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "garbage --rate should exit 2"; }
$CLI check "$WORKDIR/missing.ndjson" >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "missing file should exit 2"; }
echo sample-no-rate | $CLI sample >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "sample without --rate should exit 2"; }
set -e
echo "[smoke] usage errors ok (exit 2)"

# 4. demo is deterministic and its stream passes its own checker.
$CLI demo --requests 500 --seed 7 --rate 0.1 --slow-ms 250 > "$WORKDIR/a.ndjson" 2>/dev/null
$CLI demo --requests 500 --seed 7 --rate 0.1 --slow-ms 250 > "$WORKDIR/b.ndjson" 2>/dev/null
cmp -s "$WORKDIR/a.ndjson" "$WORKDIR/b.ndjson" || fail "demo is not deterministic for a fixed seed"
CHECK_OUT="$($CLI check "$WORKDIR/a.ndjson")"
echo "$CHECK_OUT" | grep -q "wideline check: OK" || fail "demo stream should check clean"
echo "[smoke] demo determinism + self-check ok ($(wc -l < "$WORKDIR/a.ndjson") events)"

# 5. Tail-based keeping is visible in the stream: errors and slow
#    requests survive the 10% head rate with weight 1.
grep -q '"sample.kept_by":"tail:error"' "$WORKDIR/a.ndjson" || fail "no tail:error keeps in demo stream"
grep -q '"sample.kept_by":"tail:slow"' "$WORKDIR/a.ndjson" || fail "no tail:slow keeps in demo stream"
grep -q '"sample.kept_by":"head"' "$WORKDIR/a.ndjson" || fail "no head keeps in demo stream"
grep '"error.message"' "$WORKDIR/a.ndjson" | grep -q '"sample.rate":1,' || fail "tail-kept errors should carry weight 1"
echo "[smoke] tail-based keeping ok"

# 6. check exits 1 on a corrupted stream and names the problem.
cp "$WORKDIR/a.ndjson" "$WORKDIR/bad.ndjson"
echo '{"time":"2026-07-01T00:00:00Z","event.id":"x","service":"svc","user":{"nested":true}}' >> "$WORKDIR/bad.ndjson"
set +e
BAD_OUT="$($CLI check "$WORKDIR/bad.ndjson")"; BAD_CODE=$?
set -e
[ "$BAD_CODE" -eq 1 ] || fail "corrupted stream should exit 1, got $BAD_CODE"
echo "$BAD_OUT" | grep -q "wideline check: FAIL" || fail "check verdict missing"
echo "$BAD_OUT" | grep -q "wide events are flat" || fail "nested-value problem not named"
echo "[smoke] check failure path ok (exit 1)"

# 7. stats aggregates with weighted estimates and latency quantiles.
STATS_OUT="$($CLI stats "$WORKDIR/a.ndjson")"
for needle in "http.route" "events" "est" "err%" "p95" "/checkout" "/products/:id" "estimated pre-sampling"; do
  echo "$STATS_OUT" | grep -q -- "$needle" || fail "stats output missing $needle"
done
$CLI stats --json --by user.plan "$WORKDIR/a.ndjson" | node -e "
  let s=''; process.stdin.on('data',(c)=>s+=c).on('end',()=>{
    const r=JSON.parse(s);
    if (r.by !== 'user.plan' || r.groups.length < 2) process.exit(1);
  });" || fail "stats --json --by user.plan is not sane"
echo "[smoke] stats ok"

# 8. pretty renders human blocks from the same stream.
PRETTY_OUT="$($CLI pretty "$WORKDIR/a.ndjson")"
echo "$PRETTY_OUT" | grep -q "\[shop-api\] GET /products" || fail "pretty summary line missing"
echo "$PRETTY_OUT" | grep -qE "user\.plan +\w+" || fail "pretty detail fields missing"
echo "[smoke] pretty ok"

# 9. sample re-samples offline, keeps every error, composes weights.
$CLI demo --requests 500 --seed 3 > "$WORKDIR/full.ndjson" 2>/dev/null
ERRS_IN="$(grep -c '"error.message"' "$WORKDIR/full.ndjson" || true)"
$CLI sample --rate 0.05 "$WORKDIR/full.ndjson" > "$WORKDIR/sampled.ndjson" 2>/dev/null
ERRS_OUT="$(grep -c '"error.message"' "$WORKDIR/sampled.ndjson" || true)"
[ "$ERRS_IN" -gt 0 ] || fail "seeded demo produced no errors to test with"
[ "$ERRS_IN" -eq "$ERRS_OUT" ] || fail "sample dropped errors: $ERRS_IN in, $ERRS_OUT out"
KEPT="$(wc -l < "$WORKDIR/sampled.ndjson")"
TOTAL="$(wc -l < "$WORKDIR/full.ndjson")"
[ "$KEPT" -lt "$((TOTAL / 3))" ] || fail "sample kept too much: $KEPT of $TOTAL"
$CLI check "$WORKDIR/sampled.ndjson" >/dev/null || fail "re-sampled stream should still check clean"
echo "[smoke] sample ok ($KEPT of $TOTAL kept, all $ERRS_OUT errors survived)"

# 10. The runnable job example emits valid events, including a recorded failure.
node examples/job.mjs > "$WORKDIR/jobs.ndjson" || fail "examples/job.mjs crashed"
[ "$(wc -l < "$WORKDIR/jobs.ndjson")" -eq 2 ] || fail "job example should emit exactly 2 events"
grep -q '"event.name":"rebuild-search-index"' "$WORKDIR/jobs.ndjson" || fail "job example missing success event"
grep -q '"error.message":"upstream unreachable' "$WORKDIR/jobs.ndjson" || fail "job example missing failure event"
$CLI check "$WORKDIR/jobs.ndjson" >/dev/null || fail "job example events should check clean"
echo "[smoke] job example ok"

echo "SMOKE OK"
