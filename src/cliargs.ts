/**
 * A deliberately tiny argv parser: subcommand, positionals, long flags
 * with values, boolean flags, and hard errors on anything unknown —
 * an unrecognized flag exiting 2 beats one silently ignored in CI.
 */

export class UsageError extends Error {}

export interface FlagSpec {
  /** Flags taking a value, e.g. --by <field>. */
  value?: string[];
  /** Boolean flags, e.g. --json. `--no-<flag>` is accepted for each. */
  boolean?: string[];
}

export interface ParsedArgs {
  command: string;
  positionals: string[];
  values: Record<string, string>;
  booleans: Record<string, boolean>;
}

export const COMMANDS = ["demo", "check", "stats", "pretty", "sample"] as const;

export const HELP = `wideline — one wide, canonical log event per request

Usage:
  wideline <command> [file] [flags]     file defaults to - (stdin); demo takes no file

Commands:
  demo     emit a deterministic synthetic wide-event stream (offline)
  check    validate an NDJSON stream of wide events; exit 1 on problems
  stats    aggregate a stream: weighted counts, error rate, latency quantiles
  pretty   render events for humans, one block per event
  sample   re-sample a stream offline with the same head+tail engine

Flags:
  demo:    --requests <n>      events to generate (default 50)
           --seed <n>          deterministic seed (default 1)
           --rate <r>          head sample rate in (0,1] (default 1)
           --slow-ms <n>       tail-keep threshold for slow events
  check:   --quiet             summary line only
  stats:   --by <field>        group field (default http.route)
           --top <n>           only the busiest n groups
           --json              machine-readable output
  pretty:  (no flags)
  sample:  --rate <r>          head sample rate, required
           --by <field>        sample-key field (default event.id)
           --slow-ms <n>       tail-keep threshold for slow events
           --no-keep-errors    drop errored events like any other

  --help, --version work everywhere.

Exit codes: 0 success, 1 findings (check: invalid lines), 2 usage error.
`;

const FLAGS: Record<string, FlagSpec> = {
  demo: { value: ["requests", "seed", "rate", "slow-ms"] },
  check: { boolean: ["quiet"] },
  stats: { value: ["by", "top"], boolean: ["json"] },
  pretty: {},
  sample: { value: ["rate", "by", "slow-ms"], boolean: ["keep-errors"] },
};

export function parseArgs(argv: string[]): ParsedArgs | { command: "help" | "version" } {
  if (argv.includes("--help") || argv.includes("-h")) return { command: "help" };
  if (argv.includes("--version") || argv.includes("-V")) return { command: "version" };
  const [command, ...rest] = argv;
  if (command === undefined) return { command: "help" };
  if (!(COMMANDS as readonly string[]).includes(command)) {
    throw new UsageError(`unknown command "${command}"`);
  }
  const spec = FLAGS[command] ?? {};
  const values: Record<string, string> = {};
  const booleans: Record<string, boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? "";
    if (!arg.startsWith("--")) {
      if (arg.startsWith("-") && arg !== "-") throw new UsageError(`unknown flag "${arg}"`);
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = (eq === -1 ? arg : arg.slice(0, eq)).slice(2);
    if (spec.boolean?.includes(name)) {
      if (eq !== -1) throw new UsageError(`flag --${name} does not take a value (use --${name} or --no-${name})`);
      booleans[name] = true;
      continue;
    }
    if (name.startsWith("no-") && spec.boolean?.includes(name.slice(3))) {
      if (eq !== -1) throw new UsageError(`flag --${name} does not take a value`);
      booleans[name.slice(3)] = false;
      continue;
    }
    if (spec.value?.includes(name)) {
      const value = eq !== -1 ? arg.slice(eq + 1) : rest[++i];
      if (value === undefined) throw new UsageError(`flag --${name} needs a value`);
      values[name] = value;
      continue;
    }
    throw new UsageError(`unknown flag "--${name}" for ${command}`);
  }
  if (positionals.length > 1) {
    throw new UsageError(`too many arguments: expected at most one input file`);
  }
  return { command, positionals, values, booleans };
}

/** Parse a numeric flag with bounds; throws UsageError on garbage. */
export function numberFlag(
  values: Record<string, string>,
  name: string,
  fallback: number | undefined,
  min: number,
  max: number
): number | undefined {
  const raw = values[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new UsageError(`--${name} must be a number in [${min}, ${max}], got "${raw}"`);
  }
  return n;
}
