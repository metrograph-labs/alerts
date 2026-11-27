/**
 * The drift watch of the copy hosts (AL-139).
 *
 * A copy host comes from code: typed setup steps and OpenTofu files. Nothing examined the host again after its setup.
 * The drift watch starts the commands of the field `drift` of the private configuration, one time in each day.
 *
 * - A command of the kind `setup` is a setup check in check mode. Each line `check: <step>: <reason>` is a change.
 * - A command of the kind `tofu` is a plan with `-detailed-exitcode`. The exit code 2 tells one change or more.
 * - The runtime starts each program with no shell, through `runCommand` of `@procedures/shell`.
 * - A read keeps only the names of the changes that have letters, digits, `.`, `_` and `-`. It keeps no other output.
 * - The runtime starts `check` of the watch in each pass. The commands run after the check, one at a time, and the pass does not wait.
 * - A failed read keeps the last read that passed. The core gives the line `unread` when the last read is too old.
 * - The watch keeps no record. After a restart, the first check reads again.
 */
import type { DriftCheck, DriftCommandConfig, DriftCommandKind, DriftRead, Duration, Instant, ReadHealth } from "@mark1russell7/alerts";
import { runCommand, streamCommand } from "@procedures/shell/command";
import { compareCodeUnits } from "@mark1russell7/text/order";
import { readHealth, readSchedule, type ReadFailure, type ReadSchedule, type ReadWatch } from "./schedule.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The time between two reads of a command that pass: one day. */
export const DRIFT_EVERY: Duration = DAY;

/** The time after a failed read of a command before its next read. */
export const DRIFT_RETRY: Duration = HOUR;

/** The longest time of one command. A plan of OpenTofu reads the state of each resource from the provider, thus the limit is long. */
export const DRIFT_LIMIT: Duration = 5 * MINUTE;

/** The longest time with no read of a command that passed. After it, the core gives the line `unread`. Two days let one daily read fail. */
export const DRIFT_MAX_AGE: Duration = 2 * DAY;

/** The most names of changes in one read. The count of the changes holds the others. */
export const DRIFT_STEPS_KEPT = 50;

/** The most bytes of the output of one command that the runner keeps. A longer output gives a failed read. */
export const DRIFT_OUTPUT_BYTES: number = 4 * 1024 * 1024;

// The name of a change that a read keeps. Each other name stays out of the read, and only its count stays.
const STEP_NAME = /^[A-Za-z0-9._-]{1,128}$/u;

// A line of a setup check for a step that changes: `check: <step>: <reason>`.
const CHECK_LINE = /^\s*check:\s*(.*)$/u;

// A line of a plan for one resource that changes: `# <address> will be created`, or `must be replaced`.
const PLAN_LINE = /^\s*#\s+(\S+)\s+(?:will|must)\s+be\s/u;

// The summary line of a plan: `Plan: 1 to add, 2 to change, 0 to destroy.` A plan can also count imports.
const PLAN_SUMMARY = /^\s*Plan:\s+(.*)$/u;

// The color codes of a terminal. A plan without `-no-color` writes them.
const COLOR_CODE = /\u001b\[[0-9;]*m/gu;

/** The output of one command. A runner does not throw. */
export interface CommandOutput {
  readonly exitCode: number;
  readonly stdout: string;
  /** The value `true` tells that the time limit stopped the command. */
  readonly timedOut?: boolean;
  /** The value `true` tells that the program did not start. */
  readonly notStarted?: boolean;
  /** The value `true` tells that the output was longer than the runner keeps. */
  readonly truncated?: boolean;
}

/**
 * This function starts the program of `argv` with its arguments, with no shell. It stops the program at the abort of the
 * signal, or after the time `limit`. A test gives a fake.
 */
export type DriftRunner = (argv: readonly string[], signal: AbortSignal, limit: Duration) => Promise<CommandOutput>;

/** This runner starts each program through `runCommand` of `@procedures/shell`, with no shell. It keeps the first bytes of the output. */
export const commandRunner: DriftRunner = async (argv, signal, limit) => {
  const [program, ...args] = argv;
  if (program === undefined) return { exitCode: 1, stdout: "", notStarted: true };
  const result = await runCommand(program, { args, signal, timeout: limit, maxOutputBytes: DRIFT_OUTPUT_BYTES, keep: "head" });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    ...(result.timedOut === true ? { timedOut: true } : {}),
    ...(result.error === undefined ? {} : { notStarted: true }),
    ...(result.truncated?.stdout === true ? { truncated: true } : {}),
  };
};

/**
 * This reader starts a program through `streamCommand` of `@procedures/shell`, with no shell, and it gives each line of
 * its standard output. The lines end when the program ends. The abort stops the program. The mesh link uses it (AL-41-wire).
 */
export async function* commandLines(argv: readonly string[], signal: AbortSignal): AsyncGenerator<string, void, undefined> {
  const [program, ...args] = argv;
  if (program === undefined) throw new Error("The command names no program.");
  for await (const item of streamCommand(program, { args, signal })) if (item.type === "stdout") yield item.line;
}

/** A read of a drift check that passed: the count of the changes and their names. */
export type DriftFound = { readonly ok: true } & Omit<DriftRead, "at">;

/** The answer of a reader of a drift check. A reader does not throw. A throw is a failure too. */
export type DriftReading = DriftFound | ReadFailure;

/**
 * This function gives the changes in the output of a command of the kind `kind`. A message of a failure holds no output.
 *
 * - `setup`: the exit code must be 0. Each line `check: <step>: <reason>` is a change. Two lines of one step are one change.
 * - `tofu`: the exit code 0 tells no change, and 2 tells one change or more. Each other exit code is a failure.
 *   The count is the most of the resources in the lines `# <address> will be`, the sum of the line `Plan:`, and 1.
 */
export function driftOf(kind: DriftCommandKind, exitCode: number, stdout: string): DriftReading {
  const lines = stdout.replace(COLOR_CODE, "").split(/\r?\n/u);
  if (kind === "setup") {
    if (exitCode !== 0) return { ok: false, message: `The setup check gave the exit code ${String(exitCode)}.` };
    const changed = new Set<string>();
    for (const line of lines) {
      const match = CHECK_LINE.exec(line);
      if (match === null) continue;
      const rest = match[1] ?? "";
      const end = rest.indexOf(":");
      changed.add((end < 0 ? rest : rest.slice(0, end)).trim());
    }
    return found(changed, changed.size);
  }
  if (exitCode === 0) return { ok: true, changes: 0, steps: [] };
  if (exitCode !== 2) return { ok: false, message: `The plan gave the exit code ${String(exitCode)}.` };
  const changed = new Set<string>();
  let summed = 0;
  for (const line of lines) {
    const resource = PLAN_LINE.exec(line);
    if (resource !== null) changed.add(resource[1] ?? "");
    const summary = PLAN_SUMMARY.exec(line);
    if (summary !== null) summed = Math.max(summed, [...(summary[1] ?? "").matchAll(/(\d+)\s+to\s+(?:add|change|destroy|import)/gu)].reduce((sum, match) => sum + Number(match[1]), 0));
  }
  return found(changed, Math.max(changed.size, summed, 1));
}

// A read that passed: the names that the read can keep, sorted, and the count of all the changes.
function found(changed: ReadonlySet<string>, changes: number): DriftFound {
  const steps = [...changed].filter((name) => STEP_NAME.test(name)).sort(compareCodeUnits).slice(0, DRIFT_STEPS_KEPT);
  return { ok: true, changes, steps };
}

/**
 * This function makes the reader of one drift check. Each read starts the command through `run`. A message of a failure
 * names the check, and it holds no argument and no output of the command.
 */
export function driftReader(command: DriftCommandConfig, run: DriftRunner = commandRunner, limit: Duration = DRIFT_LIMIT): (signal: AbortSignal, at: Instant) => Promise<DriftReading> {
  return async (signal) => {
    try {
      const output = await run(command.argv, signal, limit);
      if (signal.aborted) throw signal.reason;
      if (output.notStarted === true) return { ok: false, message: `The program of the drift check ${command.name} did not start.` };
      if (output.timedOut === true) return { ok: false, message: `The drift check ${command.name} took longer than ${String(limit)} ms.` };
      if (output.truncated === true) return { ok: false, message: `The output of the drift check ${command.name} is longer than ${String(DRIFT_OUTPUT_BYTES)} bytes.` };
      const reading = driftOf(command.kind, output.exitCode, output.stdout);
      return reading.ok ? reading : { ok: false, message: `The drift check ${command.name} failed: ${reading.message}` };
    } catch (error) {
      // The schedule ignores a read that the stop ended.
      if (signal.aborted) throw error;
      return { ok: false, message: `The drift check ${command.name} failed to run.` };
    }
  };
}

/** The options of the drift watch. */
export interface DriftWatchOptions {
  /** The commands of the drift checks, each one with its own name. */
  readonly commands: readonly DriftCommandConfig[];
  /** The runner of the commands. The default is `commandRunner`. */
  readonly run?: DriftRunner;
  /** The time between two reads of a command that pass. The default is `DRIFT_EVERY`. */
  readonly every?: Duration;
  /** The time after a failed read before the next read of the command. The default is `DRIFT_RETRY`. */
  readonly retry?: Duration;
  /** The longest time with no read of a command that passed. The default is `DRIFT_MAX_AGE`. */
  readonly maxAge?: Duration;
  /** The longest time of one command. The default is `DRIFT_LIMIT`. */
  readonly limit?: Duration;
}

/** The drift watch of the copy hosts. */
export interface DriftWatch extends ReadWatch {
  /** This method gives each check as data of the core. Before the first check, it gives `undefined`. */
  drift(): readonly DriftCheck[] | undefined;
  /** This method gives the message of the last read of the check `name` when it failed. */
  failure(name: string): string | undefined;
  /** This method gives the health of the reads of each check. It holds no change and no message. */
  health(): readonly ReadHealth[];
  /** This method gives a promise that ends when the commands of the last check end. */
  settled(): Promise<void>;
}

// The schedule of one check, and its last read that passed.
interface DriftEntry {
  readonly command: DriftCommandConfig;
  readonly reads: ReadSchedule;
  read: DriftRead | undefined;
}

/**
 * This function makes the drift watch of the copy hosts.
 *
 * - The check starts the due commands in the background, one at a time, and it does not wait for them. A command can take
 *   minutes, and a pass must end within its limit.
 * - While the commands run, the time of the next read is the latest end of the commands.
 *
 * @throws Error when a time is not a whole count of milliseconds above 0, or when two commands have the same name.
 */
export function driftWatch(options: DriftWatchOptions): DriftWatch {
  const every = options.every ?? DRIFT_EVERY;
  const retry = options.retry ?? DRIFT_RETRY;
  const maxAge = options.maxAge ?? DRIFT_MAX_AGE;
  const limit = options.limit ?? DRIFT_LIMIT;
  const run = options.run ?? commandRunner;
  for (const [name, value] of Object.entries({ every, retry, maxAge, limit })) {
    if (!(Number.isInteger(value) && value > 0)) throw new Error(`The time ${name} of the drift watch is not a whole count of milliseconds above 0.`);
  }
  if (new Set(options.commands.map((command) => command.name)).size !== options.commands.length) throw new Error("Two drift checks have the same name. Give each check its own name.");
  const entries: DriftEntry[] = options.commands.map((command) => {
    const entry: DriftEntry = {
      command,
      read: undefined,
      reads: readSchedule<DriftFound>({
        what: `drift check ${command.name}`,
        every,
        retry,
        limit,
        read: driftReader(command, run, limit),
        use(reading, at) {
          if (!reading.ok) return reading.message;
          if (!(Number.isInteger(reading.changes) && reading.changes >= 0 && reading.steps.length <= reading.changes)) return `The read of the drift check ${command.name} gave no valid count.`;
          entry.read = { changes: reading.changes, steps: reading.steps, at };
          return undefined;
        },
      }),
    };
    return entry;
  });
  let since: Instant | undefined;
  let running: { readonly job: Promise<void>; startedAt: Instant } | undefined;
  return {
    // The commands run after the end of the pass. Thus they stop only at the end of `life`, not of the pass (AL-139).
    check(clock, _stop, life) {
      since ??= clock.now();
      const now = clock.now();
      const due = entries.some((entry) => (entry.reads.nextReadAt() ?? now) <= now);
      if (running === undefined && due) {
        const job = (async () => {
          for (const entry of entries) await entry.reads.check(clock, life);
        })().finally(() => {
          running = undefined;
        });
        running = { job, startedAt: now };
      }
      return Promise.resolve();
    },
    nextReadAt() {
      if (running !== undefined) return running.startedAt + entries.length * limit;
      const times = entries.flatMap((entry) => entry.reads.nextReadAt() ?? []);
      return times.length === 0 ? undefined : Math.min(...times);
    },
    drift() {
      if (since === undefined) return undefined;
      const start = since;
      return entries.map((entry) => ({ name: entry.command.name, maxAge, since: start, ...(entry.read === undefined ? {} : { read: entry.read }) }));
    },
    failure: (name) => entries.find((entry) => entry.command.name === name)?.reads.failure(),
    health: () => entries.map((entry) => readHealth(`drift of ${entry.command.name}`, entry.reads, entry.read?.at)),
    settled: () => running?.job ?? Promise.resolve(),
    shift(size) {
      if (since !== undefined) since += size;
      if (running !== undefined) running.startedAt += size;
      for (const entry of entries) {
        entry.reads.shift(size);
        if (entry.read !== undefined) entry.read = { ...entry.read, at: entry.read.at + size };
      }
    },
  };
}
