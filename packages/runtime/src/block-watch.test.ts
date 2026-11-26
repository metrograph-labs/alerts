import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fakeWallClock } from "@mark1russell7/algebra/clock";
import { describe, expect, it } from "vitest";
import { BLOCK_PHASES, BLOCK_WATCH_LIMITS, blockReader, blockWatchSource, blockStep, blockWatchLine, phaseLabel, startBlockWatch, type BlockWatchState } from "./block-watch.ts";
import { timedLogger } from "./output.ts";

const T0 = Date.UTC(2026, 10, 24, 9, 15, 0, 0);

/** This function runs the decision over a list of read times for one heartbeat at 0, and gives the sizes of the lines. */
function linesAt(times: readonly number[], limits?: readonly number[]): (number | undefined)[] {
  let state: BlockWatchState = { beat: 0, told: 0 };
  return times.map((now) => {
    const step = blockStep(state, 0, now, limits);
    state = step.state;
    return step.size;
  });
}

describe("the decision of the watch of long blocks (AL-119)", () => {
  it("gives one line at 10 s and one line at 20 s for one block", () => {
    expect(BLOCK_WATCH_LIMITS).toEqual([10_000, 20_000]);
    expect(linesAt([1_000, 9_999, 10_000, 11_000, 19_000, 20_500, 25_000, 40_000])).toEqual([undefined, undefined, 10_000, undefined, undefined, 20_500, undefined, undefined]);
  });

  it("gives one line for a read that passes two limits", () => {
    expect(linesAt([2_000, 25_000, 26_000])).toEqual([undefined, 25_000, undefined]);
  });

  it("gives no line when the heartbeat comes back, and a new block starts a new count", () => {
    let state: BlockWatchState = { beat: 0, told: 0 };
    const sizes: (number | undefined)[] = [];
    for (const [beat, now] of [[0, 12_000], [12_500, 13_000], [13_000, 14_000], [13_000, 23_000], [13_000, 33_500]] as const) {
      const step = blockStep(state, beat, now);
      state = step.state;
      sizes.push(step.size);
    }
    expect(sizes).toEqual([12_000, undefined, undefined, 10_000, 20_500]);
  });

  it("takes other limits", () => {
    expect(linesAt([100, 200, 300, 450], [200, 400])).toEqual([undefined, 200, undefined, 450]);
  });

  it("writes the line in the format of the log of the runtime", () => {
    const lines: string[] = [];
    const message = 'The event loop of the runtime is blocked for 10 s from 2026-11-24T09:14:50.000Z, in the phase "start: open and fold of the log". The block continues.';
    timedLogger({ wall: fakeWallClock(T0), console: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: (text: unknown) => lines.push(`${String(text)}\n`) } }).log("error", message, {});
    expect(blockWatchLine(T0, 10_000, 2)).toBe(lines[0]);
    expect(blockWatchLine(T0, 2_340, 0)).toContain("blocked for 2.3 s");
  });

  it("names each phase, and an unknown code by its number", () => {
    expect(BLOCK_PHASES.map((_, code) => phaseLabel(code))).toEqual([...BLOCK_PHASES]);
    expect(phaseLabel(9)).toBe("code 9");
  });

  it("reads the shared buffer with a fake clock", () => {
    const view = new BigInt64Array(new SharedArrayBuffer(16));
    let mono = 5_000;
    const lines: string[] = [];
    Atomics.store(view, 0, 5_000n);
    Atomics.store(view, 1, 4n);
    const read = blockReader({ view, write: (line) => lines.push(line), mono: () => mono, wall: () => T0 + mono, limits: [10_000, 20_000] });
    for (const step of [1_000, 9_000, 5_000, 5_000, 5_000]) {
      mono += step;
      read();
    }
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('blocked for 10 s from 2026-11-24T09:15:05.000Z, in the phase "run after the good start"');
    expect(lines[1]).toContain("blocked for 20 s");
    // The heartbeat comes back, and the next block gives its own lines.
    Atomics.store(view, 0, BigInt(mono));
    mono += 10_000;
    read();
    expect(lines).toHaveLength(3);
  });

  it("gives a worker source that imports only node:fs and node:worker_threads", () => {
    const source = blockWatchSource();
    expect([...source.matchAll(/^import .* from "([^"]+)";$/gmu)].map((match) => match[1])).toEqual(["node:fs", "node:worker_threads"]);
    expect(source).not.toMatch(/__vite|require\(/u);
  });
});

describe("the worker of the watch of long blocks (AL-119)", () => {
  it("writes a line while a block of the main thread continues, and nothing after its end", async () => {
    const dir = await mkdtemp(join(tmpdir(), "block-watch-"));
    const target = join(dir, "runtime.log");
    const watch = startBlockWatch({ target, limits: [200, 400], beatEvery: 20, readEvery: 20 });
    try {
      await watch.ready;
      watch.phase("start: open and fold of the log");
      // A busy loop blocks the main thread. Only the worker runs.
      const end = performance.now() + 800;
      while (performance.now() < end);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const lines = (await readFile(target, "utf8")).split("\n").filter((line) => line !== "");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z The event loop of the runtime is blocked for 0\.\d s from .*, in the phase "start: open and fold of the log"\. The block continues\.$/u);
    } finally {
      await watch.stop();
      await watch.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs in a fresh Node process that strips the types of this module, as the runtime does", { timeout: 30_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "block-watch-"));
    const target = join(dir, "runtime.log");
    const module = new URL("./block-watch.ts", import.meta.url).href;
    const script = [
      `const { startBlockWatch } = await import(${JSON.stringify(module)});`,
      `const watch = startBlockWatch({ target: ${JSON.stringify(target)}, limits: [200, 400], beatEvery: 20, readEvery: 20 });`,
      "await watch.ready;",
      'watch.phase("run after the good start");',
      "const end = performance.now() + 800;",
      "while (performance.now() < end);",
      "await new Promise((resolve) => setTimeout(resolve, 300));",
      "await watch.stop();",
    ].join("\n");
    try {
      await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", script], { timeout: 25_000 });
      const lines = (await readFile(target, "utf8")).split("\n").filter((line) => line !== "");
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('in the phase "run after the good start". The block continues.');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
