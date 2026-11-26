/**
 * The receiver of the weather radio source: the entry `@mark1russell7/alerts-source-nwr/receiver`. It needs Node.js, so
 * the root of the package stays pure.
 *
 * The receiver starts two programs with no shell. `rtl_fm` tunes the SDR dongle and writes raw samples. A Node stream
 * sends them to `multimon-ng`, and each line of the decoder goes to the feed of the source. When the tuner stops, the
 * decoder reads the rest of the samples and stops. When the decoder stops, the receiver stops the tuner and the feed.
 * Then it starts again after a backoff.
 */

import type { Readable, Writable } from "node:stream";
import { wallClock, type Cancel, type WallClock } from "@mark1russell7/algebra/clock";
import { backoffDelay, type Backoff } from "@mark1russell7/service/backoff";
import { createLineSplitter, spawnProgram } from "@procedures/shell/command";
import { errorMessage } from "@mark1russell7/text";
import type { Instant } from "@mark1russell7/alerts";
import type { LineFeed } from "./feed.ts";
import { DECODER, decoderArgs, TUNER, tunerArgs, type TunerOptions } from "./programs.ts";

export { checkHost, findOnPath, type FindProgram, type HostCheck, type ProgramCheck } from "./host.ts";
export { DECODER, DECODER_SAMPLE_RATE, decoderArgs, NWR_FREQUENCIES, TUNER, tunerArgs, type TunerOptions } from "./programs.ts";

/** One child process of the receiver. A `ChildProcess` of Node.js is one. A test gives a fake. */
export interface ReceiverChild {
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

/** The function that starts one program with an argument list. */
export type StartProgram = (command: string, args: readonly string[]) => ReceiverChild;

/** This function starts a program with `spawnProgram` of `@procedures/shell`: an argument list, no shell, and pipes for the three streams. */
export const startProgram: StartProgram = (command, args) => spawnProgram(command, args, { stdio: ["pipe", "pipe", "pipe"] });

/** The default backoff: 5 seconds, then twice as long each time, to at most 5 minutes, with a jitter of half. */
export const DEFAULT_RECEIVER_BACKOFF: Backoff = { base: 5_000, factor: 2, cap: 300_000, jitter: { kind: "subtract", fraction: 0.5 } };

/** The time after which a run of the programs is steady. The stop of a steady run starts the backoff again from its first step. */
export const STEADY_AFTER_MS: number = 10 * 60_000;

/** The longest time that the decoder gets to read the rest of the samples after the end of the tuner. */
export const DRAIN_AFTER_MS = 5_000;

/** The input of the choice of a restart. */
export interface RestartInput {
  /** The count of the stops in a row before this stop, with no steady run between them. */
  readonly failures: number;
  /** The time from the start to the stop of the run, in milliseconds. */
  readonly ran: number;
  readonly steadyAfter: number;
  readonly backoff: Backoff;
  readonly random: () => number;
}

/** The choice of a restart: the new count of the stops in a row, and the delay before the next start. */
export interface RestartChoice {
  readonly failures: number;
  readonly delay: number;
}

/**
 * This function chooses the delay before the next start. A run that was steady counts as the first stop. Another stop
 * adds one to the count. The delay is `backoffDelay` of `@mark1russell7/service` for that count. The function is pure.
 */
export function chooseRestart(input: RestartInput): RestartChoice {
  const failures = input.ran >= input.steadyAfter ? 1 : input.failures + 1;
  return { failures, delay: backoffDelay(input.backoff, failures, input.random) };
}

/** One line that a program wrote to its standard error, for the log of the host. */
export interface ReceiverLog {
  readonly program: string;
  readonly line: string;
  readonly at: Instant;
}

/** The options of the receiver. */
export interface ReceiverOptions {
  /** The feed that gets each line of the decoder. */
  readonly feed: LineFeed;
  /** The channel and the settings of the dongle. */
  readonly tuner: TunerOptions;
  /** The clock of the receiver. The default is the wall clock of the platform. */
  readonly clock?: WallClock;
  /** The function that starts each program. The default is `startProgram`. A test gives a fake process. */
  readonly start?: StartProgram;
  /** The backoff before each start after a stop. The default is `DEFAULT_RECEIVER_BACKOFF`. */
  readonly backoff?: Backoff;
  /** The time after which a run is steady. The default is `STEADY_AFTER_MS`. */
  readonly steadyAfter?: number;
  /** The longest time that the decoder gets after the end of the tuner. The default is `DRAIN_AFTER_MS`. */
  readonly drainAfter?: number;
  /** The random numbers of the jitter, from 0 up to 1. The default is `Math.random`. */
  readonly random?: () => number;
  /** This function gets each line of the standard error of the two programs. */
  readonly onLog?: (log: ReceiverLog) => void;
}

/** The state of the receiver. */
export interface ReceiverState {
  /** `idle` before the start. `running` while the two programs work. `waiting` before the next start. */
  readonly status: "idle" | "running" | "waiting" | "closed";
  /** The count of the stops in a row with no steady run between them. */
  readonly failures: number;
  /** The time of the start of the current run. Only the state `running` has it. */
  readonly since?: Instant;
  /** The reason and the time of the last stop. */
  readonly ended?: { readonly reason: string; readonly at: Instant };
}

/** The receiver: the two programs and their restarts. */
export interface Receiver {
  /** This method starts the two programs. A second start does nothing. */
  start(): void;
  state(): ReceiverState;
  /** This method stops the two programs and each timer, and stops the feed. The promise resolves when both programs ended. */
  close(): Promise<void>;
}

/** One run of the two programs. */
interface Run {
  readonly children: readonly ReceiverChild[];
  readonly ended: Promise<void>;
}

/** This function gives the text of the end of a program. */
function exitText(program: string, code: number | null, signal: NodeJS.Signals | null): string {
  if (signal !== null) return `${program} stopped at the signal ${signal}`;
  return `${program} stopped with the code ${String(code)}`;
}

/**
 * This function makes a receiver. It starts no program until `start`. A wrong option of the tuner throws a
 * `RangeError` at once.
 */
export function createReceiver(options: ReceiverOptions): Receiver {
  const tuner = tunerArgs(options.tuner);
  const decoder = decoderArgs();
  const clock = options.clock ?? wallClock({ unref: true });
  const start = options.start ?? startProgram;
  const backoff = options.backoff ?? DEFAULT_RECEIVER_BACKOFF;
  const steadyAfter = options.steadyAfter ?? STEADY_AFTER_MS;
  const random = options.random ?? Math.random;
  const drainAfter = options.drainAfter ?? DRAIN_AFTER_MS;
  let state: ReceiverState = { status: "idle", failures: 0 };
  // Each run has a token. An event of a run that is not the active one does nothing.
  let active: object | undefined;
  let current: Run | undefined;
  let retry: Cancel | undefined;
  let drain: Cancel | undefined;

  const drainErrors = (program: string, stream: Readable | null, last: { line?: string }): void => {
    if (stream === null) return;
    // The standard error must be read, or the pipe fills and the program waits.
    const splitter = createLineSplitter();
    const log = (line: string): void => {
      if (line.trim().length === 0) return;
      last.line = line.trim();
      options.onLog?.({ program, line, at: clock.now() });
    };
    stream.on("data", (chunk: string | Uint8Array) => splitter.push(chunk).forEach(log));
    stream.on("end", () => splitter.flush().forEach(log));
    stream.on("error", () => undefined);
  };

  const stopChildren = (children: readonly ReceiverChild[]): void => {
    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch {
        // A program that ended has nothing to stop.
      }
    }
  };

  const ended = (token: object, reason: string, startedAt: Instant): void => {
    if (active !== token || state.status === "closed") return;
    active = undefined;
    drain?.();
    drain = undefined;
    stopChildren(current?.children ?? []);
    options.feed.stop();
    const now = clock.now();
    const choice = chooseRestart({ failures: state.failures, ran: now - startedAt, steadyAfter, backoff, random });
    state = { status: "waiting", failures: choice.failures, ended: { reason, at: now } };
    retry = clock.after(choice.delay, () => {
      retry = undefined;
      launch();
    });
  };

  // Each program ends once: at its exit, or at an error of its start.
  const watch = (program: string, child: ReceiverChild, last: { line?: string }, onEnd: (reason: string) => void): Promise<void> =>
    new Promise((resolve) => {
      let done = false;
      const end = (reason: string): void => {
        if (done) return;
        done = true;
        onEnd(reason);
        resolve();
      };
      child.on("exit", (code, signal) => end(`${exitText(program, code, signal)}${last.line === undefined ? "" : `: ${last.line}`}`));
      child.on("error", (error) => end(`${program} did not start or failed: ${errorMessage(error)}`));
    });

  const launch = (): void => {
    if (state.status === "closed") return;
    const token = {};
    active = token;
    const startedAt = clock.now();
    const tunerLast: { line?: string } = {};
    const decoderLast: { line?: string } = {};
    let children: ReceiverChild[] = [];
    try {
      children = [start(TUNER, tuner)];
      children.push(start(DECODER, decoder));
    } catch (error) {
      current = { children, ended: Promise.resolve() };
      state = { status: "running", failures: state.failures, since: startedAt };
      ended(token, `a program did not start: ${errorMessage(error)}`, startedAt);
      return;
    }
    const [radio, demodulator] = children as [ReceiverChild, ReceiverChild];
    let tunerEnd: string | undefined;
    const exits = [
      watch(TUNER, radio, tunerLast, (reason) => {
        if (active !== token) return;
        tunerEnd = reason;
        // The pipe ends the input of the decoder after the rest of the samples, and the decoder stops at the end of its
        // input. A decoder that does not stop in the drain time gets a stop.
        drain = clock.after(drainAfter, () => {
          drain = undefined;
          stopChildren([demodulator]);
        });
      }),
      // The run ends at the end of the decoder. The reason is the end of the tuner when the tuner ended first.
      watch(DECODER, demodulator, decoderLast, (reason) => ended(token, tunerEnd ?? reason, startedAt)),
    ];
    current = { children, ended: Promise.all(exits).then(() => undefined) };
    drainErrors(TUNER, radio.stderr, tunerLast);
    drainErrors(DECODER, demodulator.stderr, decoderLast);
    // A Node stream joins the two programs. A stop of the decoder breaks the pipe: the end of the run handles it.
    demodulator.stdin?.on("error", () => undefined);
    radio.stdout?.on("error", () => undefined);
    if (radio.stdout !== null && demodulator.stdin !== null) radio.stdout.pipe(demodulator.stdin);
    const splitter = createLineSplitter();
    const add = (line: string): void => {
      if (line.trim().length > 0) options.feed.add(line, clock.now());
    };
    demodulator.stdout?.on("data", (chunk: string | Uint8Array) => splitter.push(chunk).forEach(add));
    demodulator.stdout?.on("end", () => splitter.flush().forEach(add));
    demodulator.stdout?.on("error", () => undefined);
    options.feed.start(startedAt);
    state = { status: "running", failures: state.failures, since: startedAt, ...(state.ended === undefined ? {} : { ended: state.ended }) };
  };

  return {
    start() {
      if (state.status !== "idle") return;
      launch();
    },
    state: () => state,
    async close() {
      if (state.status === "closed") return;
      state = { status: "closed", failures: state.failures, ...(state.ended === undefined ? {} : { ended: state.ended }) };
      active = undefined;
      retry?.();
      retry = undefined;
      drain?.();
      drain = undefined;
      stopChildren(current?.children ?? []);
      options.feed.stop();
      await current?.ended;
    },
  };
}
