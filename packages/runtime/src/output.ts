/**
 * This module holds the output of the processes of the system: the runtime and the supervisor (AL-120). Each line starts
 * with the time of the wall clock. The supervisor writes the output of the runtime to the log file of the runtime, and
 * that file has no other time. Thus the order of a stop and its cause is on file.
 */
import { wallClock, type WallClock } from "@mark1russell7/algebra/clock";
import { consoleLogger, type ConsoleTarget, type Logger } from "@mark1russell7/service";

/** The output of a process: one method for each stream, as the console has. `log` goes to the standard output. */
export interface Output {
  log(text: string): void;
  warn(text: string): void;
  error(text: string): void;
}

/** These options change the clock and the target of the output, for a test. */
export interface OutputOptions {
  readonly wall?: Pick<WallClock, "time" | "now">;
  readonly console?: ConsoleTarget;
}

/** This function gives the logger of the console of `@mark1russell7/service` with the time of the wall clock on each line. */
export function timedLogger(options: OutputOptions = {}): Logger {
  return consoleLogger({ wall: options.wall ?? wallClock(), ...(options.console === undefined ? {} : { console: options.console }) });
}

/**
 * This function gives the output that writes each line to `logger`: `log` at the level `info`, `warn` at `warn` and
 * `error` at `error`. The console logger writes `info` to the standard output, and the other levels to the error output.
 */
export function outputOf(logger: Logger): Output {
  return {
    log: (text) => logger.log("info", text, {}),
    warn: (text) => logger.log("warn", text, {}),
    error: (text) => logger.log("error", text, {}),
  };
}
