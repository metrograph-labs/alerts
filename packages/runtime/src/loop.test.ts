import { fakeClock, type FakeClock, type WallClock } from "@mark1russell7/algebra/clock";
import type { Instant } from "@mark1russell7/alerts";
import { detachedLifecycle } from "@mark1russell7/service/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createLoop, loopTimes, shortestFetchLimit, type LoopTimes, type RuntimeLoop } from "./loop.ts";
import type { DeliveryStep } from "./delivery.ts";
import type { Pass } from "./runtime.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const T0 = Date.UTC(2026, 3, 1, 18);
const TIMES: LoopTimes = { passLimit: 20 * SECOND, retryBase: 15 * SECOND, retryCap: MINUTE };

// The microtasks and the callbacks of the promises end before this promise resolves.
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A pass of the test: only its time and its wake time count for the loop. */
const pass = (at: Instant, wakeAt?: Instant): Pass => ({ at, fetched: [], view: {} as Pass["view"], conflicts: [], ...(wakeAt === undefined ? {} : { wakeAt }) });

/** A script gives the pass of each start. It gets the clock, because the first pass starts before `start` ends. It also gets the signal of the pass. */
type Script = (at: Instant, count: number, clock: FakeClock, stop: AbortSignal) => Promise<Pass> | Pass;

const running: { loop: RuntimeLoop; stop: () => Promise<void> }[] = [];

async function start(script: Script, times = TIMES) {
  const clock = fakeClock(T0);
  // The fake clock starts at T0. Thus its time is also the instant of the test, and the two clocks move together.
  const wall: WallClock = { time: "wall", now: () => clock.now(), after: (ms, run) => clock.after(ms, run) };
  const starts: Instant[] = [];
  const errors: string[] = [];
  const loop = createLoop({
    clock,
    wall,
    times,
    random: () => 0,
    onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
    pass: async (stop) => {
      starts.push(clock.now());
      return script(clock.now(), starts.length, clock, stop);
    },
  });
  const signal = new AbortController().signal;
  await loop.worker.start(signal, detachedLifecycle(clock));
  const stop = async (): Promise<void> => {
    await loop.worker.stopIntake();
    await loop.worker.drain(clock.now() + times.passLimit, signal);
    await loop.worker.close();
  };
  running.push({ loop, stop });
  await clock.advance(0);
  await settle();
  return { clock, loop, starts, errors, stop };
}

/**
 * This function moves the clock in steps of one second, thus each timer and each pass ends in its step.
 * At the end, it starts each timer of zero time that the last step made: a sleep of zero after a pass.
 */
async function walk(clock: FakeClock, ms: number): Promise<void> {
  for (let done = 0; done < ms; done += SECOND) {
    await clock.advance(Math.min(SECOND, ms - done));
    await settle();
  }
  await clock.advance(0);
  await settle();
}

afterEach(async () => {
  for (const entry of running.splice(0)) await entry.stop();
});

describe("loopTimes", () => {
  it("gives the bound of a pass, the first wait and the longest wait from the limits of the runtime", () => {
    const sources = [{ interval: MINUTE }, { interval: 5 * MINUTE }];
    expect(loopTimes(sources, {})).toEqual({ passLimit: 5 * MINUTE, retryBase: MINUTE, retryCap: MINUTE });
    expect(loopTimes(sources, { fetchLimit: (source) => source.interval / 10, delivery: { callLimit: 10 * SECOND, retry: 15 * SECOND } })).toEqual({
      passLimit: 30 * SECOND + 20 * SECOND,
      retryBase: 15 * SECOND,
      retryCap: MINUTE,
    });
    // A retry of the delivery that is longer than the shortest interval does not make a failed pass wait longer.
    expect(loopTimes(sources, { delivery: { callLimit: SECOND, retry: 2 * MINUTE } }).retryBase).toBe(MINUTE);
    expect(() => loopTimes([], {})).toThrow("The loop needs a source.");
  });
});

describe("shortestFetchLimit", () => {
  it("bounds each fetch by its interval, up to the shortest interval, so a slow source does not make the pass long", () => {
    const sources = [{ interval: 15 * SECOND }, { interval: MINUTE }, { interval: 10 * MINUTE }];
    const limit = shortestFetchLimit(sources);
    expect(sources.map(limit)).toEqual([15 * SECOND, 15 * SECOND, 15 * SECOND]);
    const polled = shortestFetchLimit(sources.slice(1));
    expect(sources.map(polled)).toEqual([15 * SECOND, MINUTE, MINUTE]);
    expect(loopTimes(sources.slice(1), { fetchLimit: polled }).passLimit).toBe(MINUTE);
    expect(loopTimes(sources.slice(1), {}).passLimit).toBe(10 * MINUTE);
    expect(() => shortestFetchLimit([])).toThrow("The limit needs a source.");
  });
});

describe("createLoop", () => {
  it("starts each pass at the wake time of the pass before it, and not before", async () => {
    const { clock, starts, loop, errors } = await start((at) => pass(at, at + 30 * SECOND));
    expect(starts).toEqual([T0]);
    await walk(clock, 29 * SECOND);
    expect(starts).toEqual([T0]);
    await walk(clock, SECOND);
    expect(starts).toEqual([T0, T0 + 30 * SECOND]);
    await walk(clock, 30 * SECOND);
    expect(starts).toEqual([T0, T0 + 30 * SECOND, T0 + 60 * SECOND]);
    expect(loop.last()?.at).toBe(T0 + 60 * SECOND);
    expect(errors).toEqual([]);
  });

  it("keeps the last pass with a count of its open incidents and no routes (AL-145)", async () => {
    const kind = { code: "met.tornado", label: "Tornado" };
    // Two persons get the one incident, thus the step has two routes.
    const route = { incident: { anchor: "report-a", kind } } as unknown as DeliveryStep["routes"][number];
    const delivery = { routes: [route, route], sent: [], duplicates: [], stopped: [], acknowledged: [], cancelled: [], failures: [], conflicts: [], overdue: [], exhausted: [] } satisfies DeliveryStep;
    const { loop } = await start((at) => ({ ...pass(at, at + 30 * SECOND), delivery }));
    const last = loop.last();
    expect(last?.open).toBe(1);
    expect(last?.delivery).toEqual({ sent: [], duplicates: [], stopped: [], acknowledged: [], cancelled: [], failures: [], conflicts: [], overdue: [], exhausted: [] });
    expect(delivery.routes).toHaveLength(2);
  });

  it("starts a pass at a wake, and keeps a wake during a pass for the end of that pass", async () => {
    const clock0 = { release: (): void => undefined };
    const { clock, starts, loop, errors } = await start((at, count) =>
      count === 2 ? new Promise<Pass>((resolve) => (clock0.release = () => resolve(pass(at, at + MINUTE)))) : pass(at, at + MINUTE),
    );
    await walk(clock, 5 * SECOND);
    loop.wake();
    await settle();
    expect(starts).toEqual([T0, T0 + 5 * SECOND]);
    // The second pass is in flight. A wake now starts no second pass at the same time.
    loop.wake();
    await walk(clock, 2 * SECOND);
    expect(starts).toHaveLength(2);
    clock0.release();
    await walk(clock, SECOND);
    expect(starts).toEqual([T0, T0 + 5 * SECOND, T0 + 7 * SECOND]);
    // The timer of the first pass ended at the wake. Thus the next pass starts only at the wake time of the third pass.
    await walk(clock, MINUTE);
    expect(starts).toEqual([T0, T0 + 5 * SECOND, T0 + 7 * SECOND, T0 + 67 * SECOND]);
    expect(errors).toEqual([]);
  });

  it("starts the next pass at once when a pass ends after its own wake time", async () => {
    const { clock, starts, errors } = await start((at, count, time) =>
      count === 1 ? new Promise<Pass>((resolve) => time.after(10 * SECOND, () => resolve(pass(at, at + 5 * SECOND)))) : pass(at, at + MINUTE),
    );
    await walk(clock, 10 * SECOND);
    expect(starts).toEqual([T0, T0 + 10 * SECOND]);
    expect(errors).toEqual([]);
  });

  it("waits its retry after a failed pass, and the wait doubles up to its cap", async () => {
    const { clock, starts, errors } = await start((at, count) => {
      if (count <= 4) throw new Error(`The disk is full (${count}).`);
      return pass(at, at + MINUTE);
    });
    await walk(clock, 15 * SECOND + 30 * SECOND + MINUTE + MINUTE);
    expect(starts).toEqual([T0, T0 + 15 * SECOND, T0 + 45 * SECOND, T0 + 105 * SECOND, T0 + 165 * SECOND]);
    expect(errors).toEqual(["The disk is full (1).", "The disk is full (2).", "The disk is full (3).", "The disk is full (4)."]);
  });

  it("reports a wake time that is not after its pass, and waits its first retry", async () => {
    const { clock, starts, errors } = await start((at, count) => (count === 1 ? pass(at, at) : pass(at, at + MINUTE)));
    await walk(clock, 14 * SECOND);
    expect(starts).toEqual([T0]);
    expect(errors).toEqual([`The pass at ${T0} gave the wake time ${T0}, which is not after it.`]);
    await walk(clock, SECOND);
    expect(starts).toEqual([T0, T0 + 15 * SECOND]);
  });

  it("sleeps until a wake when a pass has no wake time, and stops its timer at the close", async () => {
    const { clock, starts, loop, stop } = await start((at, count) => (count === 1 ? pass(at) : pass(at, at + MINUTE)));
    await walk(clock, 10 * MINUTE);
    expect(starts).toEqual([T0]);
    loop.wake();
    await walk(clock, SECOND);
    expect(starts).toEqual([T0, T0 + 10 * MINUTE]);
    expect(clock.pending).toBe(1);
    running.splice(0);
    await stop();
    expect(clock.pending).toBe(0);
  });

  it("gives each pass the signal of its iteration, and the stop of the loop aborts it", async () => {
    let seen: AbortSignal | undefined;
    const { clock, stop } = await start(async (at, _count, _clock, signal) => {
      seen = signal;
      // The pass waits for a fetch that ends only at the abort of its signal.
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return pass(at, at + MINUTE);
    });
    expect(seen?.aborted).toBe(false);
    running.splice(0);
    const stopping = stop();
    await walk(clock, TIMES.passLimit);
    await stopping;
    expect(seen?.aborted).toBe(true);
  });
});

describe("stuck", () => {
  it("tells a pass that runs longer than its bound", async () => {
    const hold = { release: (): void => undefined };
    const { clock, loop } = await start((at, count) => (count === 1 ? new Promise<Pass>((resolve) => (hold.release = () => resolve(pass(at, at + MINUTE)))) : pass(at, at + MINUTE)));
    clock.block(TIMES.passLimit);
    expect(loop.stuck()).toBeUndefined();
    clock.block(1);
    expect(loop.stuck()).toBe(`A pass runs for ${TIMES.passLimit + 1} ms. Its bound is ${TIMES.passLimit} ms.`);
    hold.release();
    await walk(clock, 0);
    expect(loop.stuck()).toBeUndefined();
  });

  it("tells a pass that did not start by its bound after its wake time", async () => {
    const { clock, loop } = await start((at) => pass(at, at + MINUTE));
    // A blocked event loop starts no timer.
    clock.block(MINUTE + TIMES.passLimit);
    expect(loop.stuck()).toBeUndefined();
    clock.block(1);
    expect(loop.stuck()).toBe(`The next pass is ${TIMES.passLimit + 1} ms late. The bound is ${TIMES.passLimit} ms.`);
    await walk(clock, 0);
    expect(loop.stuck()).toBeUndefined();
  });

  it("gives a failed pass the longest wait of its retry before it is stuck", async () => {
    const { clock, loop } = await start((at, count) => {
      if (count === 1) throw new Error("The disk is full.");
      return pass(at, at + MINUTE);
    });
    clock.block(TIMES.retryCap + TIMES.passLimit);
    expect(loop.stuck()).toBeUndefined();
    clock.block(1);
    expect(loop.stuck()).toBe(`The next pass is ${TIMES.passLimit + 1} ms late. The bound is ${TIMES.passLimit} ms.`);
  });

  it("is not stuck while it waits only for a wake, and not after the close", async () => {
    const { clock, loop, stop } = await start((at) => pass(at));
    clock.block(60 * MINUTE);
    expect(loop.stuck()).toBeUndefined();
    const other = await start((at) => pass(at, at + MINUTE));
    running.splice(0);
    await other.stop();
    other.clock.block(60 * MINUTE);
    expect(other.loop.stuck()).toBeUndefined();
    await stop();
    expect(clock.pending).toBe(0);
  });
});
