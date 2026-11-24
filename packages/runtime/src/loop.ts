/**
 * This module holds the loop of the runtime: a worker loop of `@mark1russell7/service`. The loop
 * starts each pass at the wake time of the pass before it. The times of the loop come from the limits of the
 * runtime. No time of the loop is set by hand.
 *
 * Each pass is one span of OpenTelemetry with the name `pass` (AL-82). Thus each line of a pass has the trace id of the pass.
 * Without a registered tracer provider, the span does nothing.
 */
import type { Cancel, Clock, WallClock } from "@mark1russell7/algebra/clock";
import type { Duration, Instant } from "@mark1russell7/alerts";
import { workerLoop, type WorkerLoop } from "@mark1russell7/service";
import { SpanStatusCode, trace, type Tracer } from "@opentelemetry/api";
import { keptPass, type KeptPass, type Pass } from "./runtime.ts";
import { SERVICE_NAME } from "./telemetry.ts";

const ms = (value: number) => ({ value, unit: "ms" });

/** The times of the loop. `loopTimes` gives them from the limits of the runtime. */
export interface LoopTimes {
  /** The longest time of one pass: the longest fetch, then the polls and then the sends of the delivery step. */
  readonly passLimit: Duration;
  /** The wait after the first failed pass. The wait doubles after each failure in sequence, up to `retryCap`. */
  readonly retryBase: Duration;
  /** The longest wait after a failed pass: the shortest interval of a source. */
  readonly retryCap: Duration;
}

/** The limits of the runtime that set the times of the loop. They are the options of `openRuntime`. */
export interface LoopLimits<S extends { readonly interval: Duration }> {
  readonly fetchLimit?: ((source: S) => Duration) | undefined;
  readonly delivery?: { readonly callLimit: Duration; readonly retry: Duration } | undefined;
}

/**
 * This function gives the times of the loop from the limits of the runtime.
 *
 * - The fetches of a pass go at the same time, thus the longest fetch limit bounds them. The delivery
 *   step then has two calls in sequence at most: a poll, and then a send or a cancel.
 * - A failed pass goes again before the next fetch of each source is late. Thus the longest wait is the
 *   shortest interval of a source. The first wait is the retry time of the delivery when it is shorter.
 */
export function loopTimes<S extends { readonly interval: Duration }>(sources: readonly S[], limits: LoopLimits<S>): LoopTimes {
  if (sources.length === 0) throw new Error("The loop needs a source. Without one, no time sets its wait.");
  const fetches = sources.map((source) => limits.fetchLimit?.(source) ?? source.interval);
  const calls = limits.delivery === undefined ? 0 : 2 * limits.delivery.callLimit;
  const retryCap = Math.min(...sources.map((source) => source.interval));
  return { passLimit: Math.max(...fetches) + calls, retryBase: Math.min(limits.delivery?.retry ?? retryCap, retryCap), retryCap };
}

/**
 * This function gives the limit of each fetch: the interval of its source, up to the shortest interval of the sources.
 * A pass waits for each of its fetches. Thus a source with a long interval holds the other sources for one short
 * interval at most, and the pass limit of `loopTimes` stays short.
 */
export function shortestFetchLimit<S extends { readonly interval: Duration }>(sources: readonly S[]): (source: S) => Duration {
  if (sources.length === 0) throw new Error("The limit needs a source. Without one, no interval sets it.");
  const shortest = Math.min(...sources.map((source) => source.interval));
  return (source) => Math.min(source.interval, shortest);
}

/** The options of the loop. */
export interface LoopOptions {
  /** This function does one pass: `Runtime.pass`. The signal of the iteration aborts at the drain, at the bound of the pass and at the close. */
  readonly pass: (stop: AbortSignal) => Promise<Pass>;
  /**
   * The monotonic clock of the service. The worker, the waits and the bound of a pass use it. Give the
   * clock of the lifecycle, because the drain compares its deadline with this clock.
   */
  readonly clock: Clock;
  /** The clock of the runtime. The loop reads only its instant, to change the wake time of a pass into a wait. */
  readonly wall: WallClock;
  readonly times: LoopTimes;
  /** This function receives each failed pass, with the count of failures in sequence. */
  readonly onError?: (error: unknown, failures: number) => void;
  /** This function gives the random numbers of the jitter of a wait, from 0 up to 1. */
  readonly random?: () => number;
  /** The tracer of the span of each pass. The default is the tracer `alerts-runtime` of the global tracer provider. */
  readonly tracer?: Tracer;
}

/**
 * This function does one pass in a span with the name `pass`, and ends the span. A pass that throws sets the status of the span
 * to error, with the name of the error only: its message can quote a value.
 */
const passInSpan = (tracer: Tracer, work: () => Promise<Pass>): Promise<Pass> =>
  tracer.startActiveSpan("pass", async (span) => {
    try {
      return await work();
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.name : typeof error });
      throw error;
    } finally {
      span.end();
    }
  });

/** The loop of the runtime. */
export interface RuntimeLoop {
  /** The worker loop. The service declares it: `svc.worker(name, loop.worker.knobs, loop.worker)`. */
  readonly worker: WorkerLoop;
  /** The times of the loop. The drain of the service holds `passLimit`. */
  readonly times: LoopTimes;
  /**
   * This method starts a pass soon. A wake during a pass starts the next pass at the end of that pass.
   * The runtime gets it as its option `wake`.
   */
  wake(): void;
  /** This method gives the kept part of the last pass that ended (`keptPass`), or `undefined` before the first pass. */
  last(): KeptPass | undefined;
  /**
   * This method tells why the loop is stuck, or it gives `undefined`. The liveness check of the
   * service reads it. The loop is stuck when a pass runs longer than `passLimit`, or when no pass
   * started by `passLimit` after its time. While the loop waits only for `wake()`, it is not stuck.
   */
  stuck(): string | undefined;
}

/**
 * This function makes the loop of the runtime. One pass goes at a time. After each pass, the loop
 * sleeps until the wake time of the pass, or until `wake()`. A wake time in the past starts the next
 * pass at once. A pass that throws waits its retry. A pass
 * whose wake time is not after its own time is a fault of the runtime. The loop reports it, and it
 * waits `retryBase`, thus it does not start a pass again at once without an end.
 */
export function createLoop(options: LoopOptions): RuntimeLoop {
  const { clock, times } = options;
  const tracer = options.tracer ?? trace.getTracer(SERVICE_NAME);
  let timer: Cancel | undefined;
  let last: KeptPass | undefined;
  // The start of the pass in flight, and the latest time for the next pass to start.
  let running: Instant | undefined;
  let due: Instant | undefined;
  const stop = (): void => {
    timer?.();
    timer = undefined;
    due = undefined;
  };
  const at = (wait: Duration): void => {
    due = clock.now() + wait;
    timer = clock.after(wait, () => {
      timer = undefined;
      worker.wake();
    });
  };
  const worker: WorkerLoop = workerLoop(
    {
      // The sleep has no bound: the timer of the wake time ends it.
      worker_sleep: { value: "infinite", unit: "s" },
      unit_processing_time: ms(times.passLimit),
      retry_base: ms(times.retryBase),
      retry_cap: ms(times.retryCap),
      // The drain of the service waits for the pass in flight, thus the close waits for no pass.
      // A pass that the drain cut does not end at the abort. The close reports it, and the process exits.
      close_bound: ms(0),
      concurrency: { value: 1, unit: "count" },
    },
    {
      clock,
      ...(options.random === undefined ? {} : { random: options.random }),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
      // The setup makes the teardown start at the close.
      setup: () => undefined,
      iteration: async ({ signal }) => {
        stop();
        running = clock.now();
        let pass: Pass;
        try {
          pass = await passInSpan(tracer, () => options.pass(signal));
        } catch (error) {
          // The backoff of the worker loop waits `retryCap` at most.
          due = clock.now() + times.retryCap;
          throw error;
        } finally {
          running = undefined;
        }
        last = keptPass(pass);
        if (pass.wakeAt === undefined) return undefined;
        if (!(pass.wakeAt > pass.at)) {
          options.onError?.(new Error(`The pass at ${pass.at} gave the wake time ${pass.wakeAt}, which is not after it.`), 0);
          at(times.retryBase);
          return undefined;
        }
        at(Math.max(0, pass.wakeAt - options.wall.now()));
        return undefined;
      },
      teardown: stop,
    },
  );
  return {
    worker,
    times,
    wake: () => {
      worker.wake();
    },
    last: () => last,
    stuck: () => {
      const now = clock.now();
      if (running !== undefined && now - running > times.passLimit) return `A pass runs for ${now - running} ms. Its bound is ${times.passLimit} ms.`;
      if (running === undefined && due !== undefined && now - due > times.passLimit) return `The next pass is ${now - due} ms late. The bound is ${times.passLimit} ms.`;
      return undefined;
    },
  };
}
