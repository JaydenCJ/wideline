#!/usr/bin/env node
/**
 * The wideline command-line interface. Thin by design: parse arguments,
 * read the input document, call the pure engine, render, pick an exit
 * code. Everything with logic in it lives in unit-tested modules.
 */

import * as fs from "node:fs";
import { checkStream, parseStream } from "./check.js";
import { HELP, numberFlag, parseArgs, UsageError, type ParsedArgs } from "./cliargs.js";
import { runDemo } from "./demo.js";
import { NdjsonEmitter, serializeEvent } from "./emitter.js";
import { prettyStream } from "./pretty.js";
import { Sampler } from "./sampler.js";
import { aggregate, plural, renderStats, renderStatsJson } from "./stats.js";
import type { SampleOptions } from "./types.js";
import { VERSION } from "./version.js";

async function readInput(positionals: string[]): Promise<string> {
  const source = positionals[0] ?? "-";
  if (source === "-") {
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of process.stdin) {
      text += decoder.decode(chunk, { stream: true });
    }
    return text + decoder.decode();
  }
  try {
    return fs.readFileSync(source, "utf8");
  } catch {
    throw new UsageError(`cannot read input file "${source}"`);
  }
}

function cmdDemo(args: ParsedArgs): number {
  if (args.positionals.length > 0) {
    throw new UsageError("demo generates its own stream and does not take an input file");
  }
  const requests = Math.floor(numberFlag(args.values, "requests", 50, 1, 1_000_000) ?? 50);
  const seed = Math.floor(numberFlag(args.values, "seed", 1, 0, 2 ** 31) ?? 1);
  const rate = numberFlag(args.values, "rate", 1, 0.0001, 1) ?? 1;
  const slowMs = numberFlag(args.values, "slow-ms", undefined, 0, 3_600_000);
  const result = runDemo({
    requests,
    seed,
    rate,
    ...(slowMs !== undefined ? { slowMs } : {}),
    emitter: new NdjsonEmitter(process.stdout),
  });
  process.stderr.write(
    `wideline demo: ${plural(requests, "request")} -> ${result.emitted} kept, ${result.sampledOut} sampled out\n`
  );
  return 0;
}

async function cmdCheck(args: ParsedArgs): Promise<number> {
  const text = await readInput(args.positionals);
  const result = checkStream(text);
  if (!args.booleans["quiet"]) {
    for (const p of result.problems) {
      const where = p.key !== undefined ? ` ${p.key}:` : "";
      process.stdout.write(`line ${p.line}:${where} ${p.message}\n`);
    }
  }
  const invalid = result.total - result.valid;
  const verdict = invalid === 0 ? "OK" : "FAIL";
  process.stdout.write(
    `wideline check: ${verdict} — ${plural(result.total, "event")}, ${invalid} invalid, ${plural(result.problems.length, "problem")}\n`
  );
  return invalid === 0 ? 0 : 1;
}

async function cmdStats(args: ParsedArgs): Promise<number> {
  const text = await readInput(args.positionals);
  const by = args.values["by"] ?? "http.route";
  const top = numberFlag(args.values, "top", undefined, 1, 10_000);
  const { records, skipped } = parseStream(text);
  const result = aggregate(records, by, skipped);
  const rendered = args.booleans["json"]
    ? renderStatsJson(result, top !== undefined ? Math.floor(top) : undefined)
    : renderStats(result, top !== undefined ? Math.floor(top) : undefined);
  process.stdout.write(rendered + "\n");
  return 0;
}

async function cmdPretty(args: ParsedArgs): Promise<number> {
  const text = await readInput(args.positionals);
  const { records } = parseStream(text);
  if (records.length > 0) process.stdout.write(prettyStream(records) + "\n");
  return 0;
}

async function cmdSample(args: ParsedArgs): Promise<number> {
  const rate = numberFlag(args.values, "rate", undefined, 0.0001, 1);
  if (rate === undefined) throw new UsageError("sample requires --rate <r>");
  const slowMs = numberFlag(args.values, "slow-ms", undefined, 0, 3_600_000);
  const sampleOptions: SampleOptions = {
    rate,
    byKey: args.values["by"] ?? "event.id",
    keepErrors: args.booleans["keep-errors"] !== false,
    ...(slowMs !== undefined ? { slowMs } : {}),
  };
  const sampler = new Sampler(sampleOptions);
  const text = await readInput(args.positionals);
  const { records } = parseStream(text);
  let kept = 0;
  for (const record of records) {
    const decision = sampler.decide(record);
    if (!decision.kept) continue;
    kept += 1;
    // Weights compose: a stream sampled twice multiplies its weights.
    const prior = record["sample.rate"];
    const priorWeight = typeof prior === "number" && prior >= 1 ? prior : 1;
    record["sample.rate"] = Math.round(priorWeight * decision.weight * 10000) / 10000;
    record["sample.kept_by"] = decision.keptBy;
    process.stdout.write(serializeEvent(record) + "\n");
  }
  process.stderr.write(`wideline sample: kept ${kept} of ${plural(records.length, "event")}\n`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`wideline: ${e.message}\n`);
      process.stderr.write("run `wideline --help` for usage\n");
      return 2;
    }
    throw e;
  }
  if (args.command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.command === "version") {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  try {
    const parsed = args as ParsedArgs;
    switch (parsed.command) {
      case "demo":
        return cmdDemo(parsed);
      case "check":
        return await cmdCheck(parsed);
      case "stats":
        return await cmdStats(parsed);
      case "pretty":
        return await cmdPretty(parsed);
      case "sample":
        return await cmdSample(parsed);
      default:
        throw new UsageError(`unknown command "${parsed.command}"`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`wideline: ${e.message}\n`);
      process.stderr.write("run `wideline --help` for usage\n");
      return 2;
    }
    throw e;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`wideline: unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 2;
  }
);
