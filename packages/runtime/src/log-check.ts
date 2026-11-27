/**
 * This module holds the integrity check of the log after the start (AL-223). A blocking `PRAGMA quick_check` at each
 * start took 8.6 s on a log of 566 MB. Thus the start opens the log with no check when the last check passed. Then this
 * check operates in a worker thread, at most one time in `LOG_CHECK_PERIOD`.
 *
 * The state file `<log>.check.json` holds the stage of the last check:
 *
 * - `running`: a check started, and no result came. The next start does the blocking check.
 * - `failed`: the check found problems. The next start does the blocking check, and it recovers the file.
 * - `passed`: the check found no problem. The next start opens the log with no check.
 *
 * A start with no state file, or with a bad state file, does the blocking check one time.
 */
import { readFileSync } from "node:fs";
import type { Duration, Instant, LogIntegrity } from "@mark1russell7/alerts";
import type { Integrity } from "@mark1russell7/sqlite";

/**
 * The shortest time from one integrity check of the log to the next check. The time starts at the `at` of the last
 * `passed`. A check reads the whole file. On a small host with a slow disk, a full read of the log starved the live
 * process, and its liveness check stopped it. Thus the check starts one time in a day, not at each start.
 */
export const LOG_CHECK_PERIOD: Duration = 24 * 60 * 60 * 1000;

/** The suffix of the name of the state file of the check. The file is next to the log. */
export const LOG_CHECK_SUFFIX = ".check.json";

/** The stages of a check of the log. */
export const LOG_CHECK_STAGES = ["running", "failed", "passed"] as const;

/** The stage of a check of the log. */
export type LogCheckStage = (typeof LOG_CHECK_STAGES)[number];

/** The content of the state file of the check. */
export interface LogCheckState {
  readonly state: LogCheckStage;
  /** The time of the start of the check. */
  readonly at: Instant;
  /** The first problems of a failed check. */
  readonly problems?: readonly string[];
}

/** This function gives the path of the state file of the check of a log file. */
export function logCheckPath(logPath: string): string {
  return `${logPath}${LOG_CHECK_SUFFIX}`;
}

/** This function gives the text of the state file. The time is an ISO 8601 text, for a person who reads the file. */
export function logCheckText(state: LogCheckState): string {
  return `${JSON.stringify({ state: state.state, at: new Date(state.at).toISOString(), ...(state.problems === undefined ? {} : { problems: state.problems }) }, null, 2)}\n`;
}

/** This function reads the text of a state file. A text that is not a state gives `undefined`. */
export function parseLogCheck(text: string): LogCheckState | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { state, at, problems } = value as Record<string, unknown>;
  if (!(LOG_CHECK_STAGES as readonly unknown[]).includes(state) || typeof at !== "string") return undefined;
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return undefined;
  const list = Array.isArray(problems) ? problems.filter((problem): problem is string => typeof problem === "string") : undefined;
  return { state: state as LogCheckStage, at: time, ...(list === undefined ? {} : { problems: list }) };
}

/** This function reads the state file at the start. A file that is not there, or that does not read, gives `undefined`. */
export function readLogCheckFile(path: string): LogCheckState | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  return parseLogCheck(text);
}

/** This function tells if the start does the blocking check: with no state, or with a state that is not `passed`. */
export function blockingCheckDue(state: LogCheckState | undefined): boolean {
  return state?.state !== "passed";
}

/** The ports of the check after the start. A test gives fakes. */
export interface LogCheckPorts {
  /** The wall clock. */
  readonly now: () => Instant;
  /** This function reads the state file. A file that is not there gives `undefined`. */
  readonly read: () => Promise<string | undefined>;
  /** This function writes the state file in one step, with `writeFileAtomic`. */
  readonly write: (text: string) => Promise<void>;
  /** This function does the integrity check of the log in a worker thread, with `checkIntegrityInBackground`. */
  readonly check: (signal: AbortSignal) => Promise<Integrity>;
  /** This function gets a failed check, after the write of `failed`. */
  readonly onFailed: (integrity: LogIntegrity) => void;
  /** This function gets the text of a fault of a read, a write or a check. */
  readonly onError: (message: string) => void;
}

/** The options of `logChecker`. */
export interface LogCheckerOptions {
  /** The time of the open of the log, when the open did the blocking check. Then the checker writes `passed` with this time. */
  readonly checkedAt: Instant | undefined;
  /** The stop of the runtime. An abort stops the check. */
  readonly signal: AbortSignal;
  /** The shortest time from one check to the next. The default is `LOG_CHECK_PERIOD`. */
  readonly period?: Duration;
}

/** The result of one step of the checker. */
export type LogCheckOutcome =
  /** The start did the blocking check, and the checker wrote `passed` with its time. */
  | { readonly kind: "start-check" }
  /** The last check is more recent than the period. */
  | { readonly kind: "not-due" }
  /** A check runs. */
  | { readonly kind: "busy" }
  | { readonly kind: "passed" }
  | { readonly kind: "failed"; readonly integrity: LogIntegrity }
  /** A read, a write or a check failed. The state file keeps `running`, thus the next start does the blocking check. */
  | { readonly kind: "error"; readonly message: string }
  /** The stop of the runtime stopped the check. The state file keeps `running`. */
  | { readonly kind: "aborted" };

/** The check of the log after the start. */
export interface LogChecker {
  /** This function gives the last failed check of this process, or `null`. A failed check is a system report. */
  failed(): LogIntegrity | null;
  /**
   * This function starts a check when the last check is older than the period, and no check runs. The runtime starts it
   * after the good start and at each pass. The promise does not reject.
   */
  step(): Promise<LogCheckOutcome>;
}

/**
 * This function makes the check of the log after the start. The first step reads the state of the last check. A start
 * that did the blocking check writes `passed` with the time of the open, thus the next check comes one period later.
 *
 * - Before the check, the checker writes `running`. A crash, a fault or a stop in the check then keeps `running`.
 * - A stop of the runtime aborts the check, and the state file keeps `running`. Thus the next start does the blocking
 *   check one time. SQLite does not stop in the middle of the pragma, thus the thread ends at the end of the pragma.
 * - A passed check writes `passed`. A failed check writes `failed` with its problems, and `failed()` gives it.
 * - A step in the period after the last check, or after a fault, starts no check.
 *
 * @param ports - The clock, the state file, the check and the reports.
 * @param options - The time of the blocking check of the start, the stop signal and the period.
 */
export function logChecker(ports: LogCheckPorts, options: LogCheckerOptions): LogChecker {
  const period = options.period ?? LOG_CHECK_PERIOD;
  // The time of the start of the last check, or of the last try. A check is due one period after it.
  let last: Instant | undefined;
  let failed: LogIntegrity | null = null;
  let running = false;

  const fault = (what: string, error: unknown): LogCheckOutcome => {
    const message = `${what}: ${error instanceof Error ? error.message : String(error)}`;
    ports.onError(message);
    return { kind: "error", message };
  };

  // The first step reads the state of the last check, or writes the blocking check of the start.
  const first = async (): Promise<LogCheckOutcome | undefined> => {
    if (options.checkedAt !== undefined) {
      last = options.checkedAt;
      try {
        await ports.write(logCheckText({ state: "passed", at: options.checkedAt }));
      } catch (error) {
        return fault("The write of the state of the check of the log failed", error);
      }
      return { kind: "start-check" };
    }
    let text: string | undefined;
    try {
      text = await ports.read();
    } catch (error) {
      text = undefined;
      fault("The read of the state of the check of the log failed", error);
    }
    const state = text === undefined ? undefined : parseLogCheck(text);
    // The start did no check, thus the state was `passed`. A changed or lost file gives a check at once.
    last = state?.state === "passed" ? state.at : Number.NEGATIVE_INFINITY;
    return undefined;
  };

  const run = async (): Promise<LogCheckOutcome> => {
    if (last === undefined) {
      const done = await first();
      if (done !== undefined) return done;
    }
    const at = ports.now();
    // A step of the wall clock back before the last check also gives a check. Then the new check sets the time again.
    if (last !== undefined && at >= last && at - last < period) return { kind: "not-due" };
    if (options.signal.aborted) return { kind: "aborted" };
    last = at;
    try {
      await ports.write(logCheckText({ state: "running", at }));
    } catch (error) {
      return fault("The write of the state of the check of the log failed", error);
    }
    let integrity: Integrity;
    try {
      integrity = await ports.check(options.signal);
    } catch (error) {
      if (options.signal.aborted) return { kind: "aborted" };
      return fault("The integrity check of the log failed", error);
    }
    if (integrity.ok) {
      failed = null;
      try {
        await ports.write(logCheckText({ state: "passed", at }));
      } catch (error) {
        return fault("The write of the state of the check of the log failed", error);
      }
      return { kind: "passed" };
    }
    const found: LogIntegrity = { at, problems: integrity.problems };
    failed = found;
    try {
      await ports.write(logCheckText({ state: "failed", at, problems: integrity.problems }));
    } catch (error) {
      fault("The write of the state of the check of the log failed", error);
    }
    ports.onFailed(found);
    return { kind: "failed", integrity: found };
  };

  return {
    failed: () => failed,
    async step() {
      if (running) return { kind: "busy" };
      running = true;
      try {
        return await run();
      } catch (error) {
        return fault("The check of the log failed", error);
      } finally {
        running = false;
      }
    },
  };
}
