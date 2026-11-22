import { LOOP_BLOCK_WINDOW, type LoopBlock } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { blockEvent, blockLine, LOOP_READ_EVERY, startLoopWatch, type SpanWatch } from "./loop-watch.ts";

const T0 = Date.UTC(2026, 3, 1, 18, 0, 0);

// A watch with scripted spans, a monotonic clock, a wall clock and a timer that the test fires.
function fake() {
  let blocks: { startedAt: number; durationMs: number }[] = [];
  let mono = 1_000;
  let wall = T0;
  let stops = 0;
  let cancels = 0;
  let tick: (() => void) | undefined;
  let every: number | undefined;
  const watch: SpanWatch = {
    span: () => ({ blocks }),
    stop: () => {
      stops += 1;
    },
  };
  const found: LoopBlock[] = [];
  const loop = startLoopWatch({
    watch,
    mono: () => mono,
    wall: () => wall,
    onBlock: (block) => found.push(block),
    repeat: (handler, ms) => {
      tick = handler;
      every = ms;
      return () => {
        cancels += 1;
      };
    },
  });
  return {
    loop,
    found,
    tick: () => tick?.(),
    every: () => every,
    stops: () => stops,
    cancels: () => cancels,
    span: (next: { startedAt: number; durationMs: number }[]) => {
      blocks = next;
    },
    advance: (ms: number) => {
      mono += ms;
      wall += ms;
    },
    step: (ms: number) => {
      wall += ms;
    },
  };
}

describe("the watch of the event loop (AL-88)", () => {
  it("reads at each tick, changes each long block to the wall clock, and gives each block one time", () => {
    const watch = fake();
    expect(watch.every()).toBe(LOOP_READ_EVERY);
    watch.advance(10_000);
    // The span has a short block and a long block. Only the long block counts.
    watch.span([
      { startedAt: 2_000, durationMs: 400 },
      { startedAt: 5_000, durationMs: 2_400.4 },
    ]);
    watch.tick();
    const block = { at: T0 + 4_000, size: 2_400 };
    expect(watch.found).toEqual([block]);
    // The next span of the watch has no block. The watch keeps the block of its window.
    watch.span([]);
    watch.advance(LOOP_READ_EVERY);
    watch.tick();
    expect(watch.found).toEqual([block]);
    expect(watch.loop.blocks()).toEqual([block]);
  });

  it("drops each block at the end of its window, and gives no block of the future after a step back of the wall clock", () => {
    const watch = fake();
    watch.advance(10_000);
    watch.span([{ startedAt: 5_000, durationMs: 1_000 }]);
    expect(watch.loop.read()).toEqual([{ at: T0 + 4_000, size: 1_000 }]);
    watch.span([]);
    watch.step(-60_000);
    expect(watch.loop.blocks()).toEqual([]);
    watch.step(60_000 + LOOP_BLOCK_WINDOW - 6_001);
    expect(watch.loop.blocks()).toEqual([{ at: T0 + 4_000, size: 1_000 }]);
    watch.step(1);
    expect(watch.loop.blocks()).toEqual([]);
  });

  it("keeps the timer after a read that throws", () => {
    const failing: SpanWatch = {
      span: () => {
        throw new Error("The watch stopped.");
      },
      stop: () => undefined,
    };
    let tick: (() => void) | undefined;
    const repeat = (handler: () => void) => {
      tick = handler;
      return () => undefined;
    };
    startLoopWatch({ watch: failing, mono: () => 0, wall: () => T0, repeat });
    expect(() => tick?.()).not.toThrow();
  });

  it("stops the timer and the watch one time, and reads no block after the stop", () => {
    const watch = fake();
    watch.loop.stop();
    watch.loop.stop();
    expect([watch.stops(), watch.cancels()]).toEqual([1, 1]);
    watch.span([{ startedAt: 500, durationMs: 5_000 }]);
    expect(watch.loop.read()).toEqual([]);
    expect(watch.found).toEqual([]);
  });

  it("gives an event with the run, the start and the length of the block in its id, and a line with its time", () => {
    const block = { at: T0, size: 12_345 };
    expect(blockEvent(block, "run-1")).toEqual({ id: `loop:run-1:${String(T0)}:12345`, at: new Date(T0).toISOString(), type: "loop", time: T0, size: 12_345 });
    expect(blockLine(block)).toBe("The event loop of the runtime was blocked for 12 s from 2026-04-01T18:00:00.000Z.");
    expect(blockLine({ at: T0, size: 1_450 })).toBe("The event loop of the runtime was blocked for 1.5 s from 2026-04-01T18:00:00.000Z.");
  });
});
