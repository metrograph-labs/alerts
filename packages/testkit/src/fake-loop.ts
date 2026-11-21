/**
 * This module holds the record of the passes in flight for the cases that drive the real loop of the runtime
 * (`createLoop`) on fake clocks. A case moves the fake time in steps. After each step, it waits until no pass is in
 * flight. Thus the fake time does not move while a pass is in flight, and each request of a pass has the time of its pass.
 */
import type { FakeClock } from "@mark1russell7/algebra/clock";
import type { RuntimeLoop } from "@mark1russell7/alerts-runtime";
import { detachedLifecycle } from "@mark1russell7/service/testing";

// The microtasks and the callbacks of the promises end before this promise resolves.
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The real time that a case waits for one pass in flight. A pass on loopback ends in milliseconds. */
export const PASS_GUARD_MS = 30_000;

/** The most passes in one wait of `quiet`. More passes with no step of the fake time are a loop with no end. */
export const QUIET_PASS_LIMIT = 1000;

/** This function waits for `work`, and it throws when the work takes longer than `PASS_GUARD_MS` of real time. */
async function guarded(work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`A pass did not end in ${String(PASS_GUARD_MS)} ms of real time.`)), PASS_GUARD_MS);
  });
  try {
    await Promise.race([work, guard]);
  } finally {
    clearTimeout(timer);
  }
}

/** The record of the pass in flight of one loop. */
export interface PassTracker {
  /** This function records `work` as the pass in flight, and it gives `work`. */
  track<T>(work: Promise<T>): Promise<T>;
  /**
   * This function waits until no pass is in flight, also for a pass that starts in the wait. It throws when a pass
   * takes longer than `PASS_GUARD_MS` of real time, or when the wait sees more than `QUIET_PASS_LIMIT` passes.
   */
  quiet(): Promise<void>;
}

/** This function makes the record of the pass in flight of one loop. The option `pass` of the loop gives each pass to `track`. */
export function passTracker(): PassTracker {
  let inflight: Promise<unknown> | undefined;
  return {
    track(work) {
      inflight = work.catch(() => undefined);
      return work;
    },
    async quiet() {
      await settle();
      let seen = 0;
      while (inflight !== undefined) {
        seen += 1;
        if (seen > QUIET_PASS_LIMIT) throw new Error(`The loop started more than ${String(QUIET_PASS_LIMIT)} passes with no step of the fake time.`);
        const work = inflight;
        await guarded(work);
        if (inflight === work) inflight = undefined;
        await settle();
      }
    },
  };
}

/** This function gives the earliest time of a list at `from` or later, or `undefined`. */
export function firstFrom(times: readonly (number | undefined)[], from: number): number | undefined {
  let found: number | undefined;
  for (const time of times) if (time !== undefined && time >= from && (found === undefined || time < found)) found = time;
  return found;
}

/** The parts of a drive of the loop on a fake clock. */
export interface FakeDrive {
  /** The loop, from `createLoop` on the fake clock `clock`. Its option `pass` gives each pass to `flight`. */
  readonly loop: RuntimeLoop;
  readonly clock: FakeClock;
  readonly flight: PassTracker;
  /** The fake time of each step. */
  readonly tickMs: number;
  /** The monotonic instant of the end of the drive. */
  readonly until: number;
  /** The drive starts this function before each step of the fake time. */
  readonly beforeTick?: () => void;
  /** The drive starts this function after each step, when no pass is in flight. */
  readonly afterTick?: () => void;
}

/**
 * This function starts the worker of the loop, and it moves the fake time in steps of `tickMs` to `until`. After each
 * step, it waits until no pass is in flight. At the end, the worker stops its intake, drains for one `passLimit`, and closes.
 */
export async function driveFakeLoop(drive: FakeDrive): Promise<void> {
  const { loop, clock, flight } = drive;
  const signal = new AbortController().signal;
  await loop.worker.start(signal, detachedLifecycle(clock));
  try {
    await clock.advance(0);
    await flight.quiet();
    while (clock.now() < drive.until) {
      drive.beforeTick?.();
      await clock.advance(drive.tickMs);
      await flight.quiet();
      drive.afterTick?.();
    }
  } finally {
    await loop.worker.stopIntake();
    await loop.worker.drain(clock.now() + loop.times.passLimit, signal);
    await loop.worker.close();
  }
}
