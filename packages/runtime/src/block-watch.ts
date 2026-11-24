/**
 * This module holds the watch of a long block of the event loop (AL-119). The watch of AL-88 (`loop-watch.ts`) writes a block
 * after its end. A supervisor stops a child with a block of approximately 30 s before that end, thus the log has no cause of
 * the stop. This watch sees the block while it continues.
 *
 * - The main thread writes a heartbeat into a `SharedArrayBuffer` at each `BLOCK_BEAT_EVERY`. The heartbeat is the time of a
 *   monotonic clock of the process, and the buffer also holds the code of the phase of the runtime.
 * - A worker thread reads the buffer at each `BLOCK_READ_EVERY`. When the heartbeat is `BLOCK_WATCH_LIMITS[0]` old, and
 *   again at each other limit, the worker writes one line synchronously to the target.
 * - When the heartbeat comes back, the worker writes nothing more. The watch of AL-88 writes the end of the block.
 *
 * The worker holds no state of the runtime, and it imports only `node:fs` and `node:worker_threads`. Its source is the text of
 * the functions of this module (`blockWatchSource()`), as JavaScript in a `data:` URL. A worker that loads a `.ts` file also
 * loads the type stripper of Node into its isolate. That approximately doubles the memory of the worker.
 */
import { Worker } from "node:worker_threads";
import type { Duration } from "@mark1russell7/alerts";

/** The ages of the heartbeat that each give one line, in their order. The liveness stop comes after approximately 30 s. */
export const BLOCK_WATCH_LIMITS: readonly Duration[] = [10_000, 20_000];

/** The time between two heartbeats of the main thread. */
export const BLOCK_BEAT_EVERY: Duration = 1_000;

/** The time between two reads of the worker. */
export const BLOCK_READ_EVERY: Duration = 1_000;

/**
 * The limits of the heap of the worker. The young generation of 1 MiB keeps the resident memory of the worker approximately
 * 2 MiB lower. A worker with an old generation of 4 MiB stops in its start, thus the old generation has a margin.
 */
export const BLOCK_WORKER_LIMITS = { maxYoungGenerationSizeMb: 1, maxOldGenerationSizeMb: 16 } as const;

/** The phases of the runtime in the shared buffer. The code of a phase is its index. */
export const BLOCK_PHASES = ["none", "start: files", "start: open and fold of the log", "start: service and first pass", "run after the good start", "fold: write of the snapshot"] as const;

/** A phase of the runtime in the shared buffer. */
export type BlockPhase = (typeof BLOCK_PHASES)[number];

/** The index of the heartbeat in the shared buffer. */
const BEAT = 0;
/** The index of the code of the phase in the shared buffer. */
const PHASE = 1;

/** This function gives the time of the monotonic clock of the process in milliseconds. Each thread of the process reads the same clock. */
export const monoNow = (): number => Number(process.hrtime.bigint() / 1_000_000n);

/** The state of the worker between two reads: the last heartbeat that it read, and the count of the limits that it told for it. */
export interface BlockWatchState {
  readonly beat: number;
  readonly told: number;
}

/** The result of one read: the next state, and the age of the heartbeat when the read gives a line. */
export interface BlockStep {
  readonly state: BlockWatchState;
  readonly size?: Duration;
}

/**
 * This function decides one read of the worker. A new heartbeat starts a new count. A read gives a line when the age of the
 * heartbeat passes a limit that the worker did not tell for this heartbeat. A read that passes two limits gives one line.
 */
export function blockStep(state: BlockWatchState, beat: number, now: number, limits: readonly Duration[] = BLOCK_WATCH_LIMITS): BlockStep {
  const told = beat === state.beat ? state.told : 0;
  const size = now - beat;
  const reached = limits.filter((limit) => size >= limit).length;
  if (reached <= told) return { state: { beat, told } };
  return { state: { beat, told: reached }, size };
}

/** This function gives the label of the code of a phase. An unknown code gives its number. */
export function phaseLabel(code: number): string {
  return BLOCK_PHASES[code] ?? `code ${String(code)}`;
}

/** This function gives the size of a block as text. The text is the same as the text of `blockSizeText` of `@mark1russell7/alerts`. */
const sizeText = (size: Duration): string => (size < 10_000 ? `${(Math.round(size / 100) / 10).toFixed(1)} s` : `${String(Math.round(size / 1000))} s`);

/**
 * This function gives the line of a block that continues. The line has the format of `timedLogger()` in `output.ts`: the time of
 * the wall clock, a space and the message.
 */
export function blockWatchLine(wall: number, size: Duration, phase: number): string {
  const from = new Date(wall - size).toISOString();
  return `${new Date(wall).toISOString()} The event loop of the runtime is blocked for ${sizeText(size)} from ${from}, in the phase "${phaseLabel(phase)}". The block continues.\n`;
}

/** The ports of one read of the worker. */
export interface BlockReadPorts {
  readonly view: BigInt64Array;
  readonly write: (line: string) => void;
  readonly mono: () => number;
  readonly wall: () => number;
  readonly limits?: readonly Duration[];
}

/** This function gives the read of the worker. Each call reads the shared buffer, and it writes the line of a passed limit. */
export function blockReader(ports: BlockReadPorts): () => void {
  let state: BlockWatchState = { beat: Number(Atomics.load(ports.view, BEAT)), told: 0 };
  return () => {
    const step = blockStep(state, Number(Atomics.load(ports.view, BEAT)), ports.mono(), ports.limits);
    state = step.state;
    if (step.size !== undefined) ports.write(blockWatchLine(ports.wall(), step.size, Number(Atomics.load(ports.view, PHASE))));
  };
}

/** The data that the main thread gives to the worker. */
export interface BlockWatchData {
  readonly buffer: SharedArrayBuffer;
  /** The target of the lines: a file descriptor, or the path of a file. The worker appends each line synchronously. */
  readonly target: number | string;
  readonly limits: readonly Duration[];
  readonly every: Duration;
}

/** The synchronous append of `node:fs`: `appendFileSync`. */
export type AppendSync = (target: number | string, text: string) => void;

/** The count of the tries of one write. A full pipe with no wait gives `EAGAIN`, and the supervisor reads the pipe again soon. */
const WRITE_TRIES = 3;

/** This function gives the write of a line to a target. A failed write writes nothing, because the worker has no other output. */
export function targetWrite(target: number | string, append: AppendSync): (line: string) => void {
  return (line) => {
    for (let attempt = 0; attempt < WRITE_TRIES; attempt += 1) {
      try {
        append(target, line);
        return;
      } catch (error) {
        if ((error as { code?: unknown }).code !== "EAGAIN") return;
      }
    }
  };
}

/** The ports of the worker: the append of `node:fs`, and the message that tells the main thread that the reads run. */
export interface BlockWorkerPorts {
  readonly append: AppendSync;
  readonly ready: () => void;
}

/** This function is the body of the worker. It starts the timer of the reads, and then it tells the main thread. */
export function blockWatchWorker(data: BlockWatchData, ports: BlockWorkerPorts): void {
  const read = blockReader({ view: new BigInt64Array(data.buffer), write: targetWrite(data.target, ports.append), mono: monoNow, wall: () => Date.now(), limits: data.limits });
  setInterval(read, data.every);
  ports.ready();
}

/**
 * This function gives the source of the worker: the constants and the functions of this module that the worker uses, as one
 * JavaScript module. Each function refers only to its parameters, to the globals of JavaScript and to the names of this source.
 * Node strips the types of a `.ts` module, thus the text of each function is JavaScript.
 */
export function blockWatchSource(): string {
  return [
    'import { appendFileSync } from "node:fs";',
    'import { parentPort, workerData } from "node:worker_threads";',
    `const BEAT = ${String(BEAT)};`,
    `const PHASE = ${String(PHASE)};`,
    `const WRITE_TRIES = ${String(WRITE_TRIES)};`,
    `const BLOCK_WATCH_LIMITS = ${JSON.stringify(BLOCK_WATCH_LIMITS)};`,
    `const BLOCK_PHASES = ${JSON.stringify(BLOCK_PHASES)};`,
    `const monoNow = ${monoNow.toString()};`,
    `const sizeText = ${sizeText.toString()};`,
    ...[blockStep, phaseLabel, blockWatchLine, blockReader, targetWrite, blockWatchWorker].map((part) => part.toString()),
    'blockWatchWorker(workerData, { append: appendFileSync, ready: () => parentPort.postMessage("ready") });',
    "",
  ].join("\n");
}

/** The options of `startBlockWatch()`. */
export interface BlockWatchOptions {
  /**
   * The target of the lines: a file descriptor, or the path of a file. The runtime gives the descriptor 2. The supervisor
   * writes that output to the log file of the runtime, and it holds the rotation of that file.
   */
  readonly target: number | string;
  /** The ages of the heartbeat that each give one line. The default is `BLOCK_WATCH_LIMITS`. */
  readonly limits?: readonly Duration[];
  /** The time between two heartbeats. The default is `BLOCK_BEAT_EVERY`. */
  readonly beatEvery?: Duration;
  /** The time between two reads of the worker. The default is `BLOCK_READ_EVERY`. */
  readonly readEvery?: Duration;
  /** This function gets a fault of the worker. The watch stops after a fault. */
  readonly onError?: (error: unknown) => void;
}

/** A running watch of long blocks. */
export interface BlockWatch {
  /** This function sets the phase of the runtime in the shared buffer. */
  phase(phase: BlockPhase): void;
  /** This promise resolves when the worker reads the buffer on its timer. */
  readonly ready: Promise<void>;
  /** This function stops the heartbeat and the worker. A second call does nothing. */
  stop(): Promise<void>;
}

/**
 * This function starts the heartbeat and the worker of the watch. The timer of the heartbeat and the worker do not keep the
 * process alive. The worker gets no environment and no flag of the process.
 */
export function startBlockWatch(options: BlockWatchOptions): BlockWatch {
  const buffer = new SharedArrayBuffer(2 * BigInt64Array.BYTES_PER_ELEMENT);
  const view = new BigInt64Array(buffer);
  const beat = (): void => {
    Atomics.store(view, BEAT, BigInt(monoNow()));
  };
  beat();
  const timer = setInterval(beat, options.beatEvery ?? BLOCK_BEAT_EVERY);
  timer.unref();
  const data: BlockWatchData = { buffer, target: options.target, limits: options.limits ?? BLOCK_WATCH_LIMITS, every: options.readEvery ?? BLOCK_READ_EVERY };
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(blockWatchSource())}`), { workerData: data, env: {}, execArgv: [], stdout: true, stderr: true, resourceLimits: BLOCK_WORKER_LIMITS });
  worker.unref();
  let stopped = false;
  const ready = new Promise<void>((resolve, reject) => {
    worker.once("message", () => resolve());
    worker.once("error", reject);
  });
  // A rejected ready with no reader does not stop the process.
  ready.catch(() => undefined);
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await worker.terminate();
  };
  // A fault of the worker stops the watch. An `error` event with no listener stops the process.
  worker.on("error", (error) => {
    options.onError?.(error);
    void stop();
  });
  return {
    phase: (phase) => {
      Atomics.store(view, PHASE, BigInt(BLOCK_PHASES.indexOf(phase)));
    },
    ready,
    stop,
  };
}
