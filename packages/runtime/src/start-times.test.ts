import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import {
  addMissedStart,
  addStartTime,
  BOOTSTRAP_WINDOW_MS,
  hostFileText,
  MEASURED_STARTS,
  parseStartTimes,
  readyWindow,
  readyWindowText,
  READY_GROWTH_FACTOR,
  START_TIMES_FORMAT,
  START_TIMES_KEPT,
  type StartTime,
  WINDOW_CAP_MS,
} from "./start-times.ts";

const SEEDS = seedsFrom(process.env["SEED"], Array.from({ length: 50 }, (_, index) => index + 1));
const FLOOR = 35_000;
const start = (ms: number, index = 0): StartTime => ({ at: `2026-11-18T21:${String(10 + index).padStart(2, "0")}:00.000Z`, ms });
const fileOf = (starts: readonly StartTime[]): string | undefined => starts.reduce<string | undefined>((text, item) => addStartTime(text, item), undefined);

describe("the file of the start times", () => {
  it("adds each start, and keeps the last ones", () => {
    const starts = Array.from({ length: START_TIMES_KEPT + 3 }, (_, index) => start(1000 + index, index));
    const text = fileOf(starts);
    expect(JSON.parse(text!)).toMatchObject({ format: START_TIMES_FORMAT });
    expect(parseStartTimes(text)).toEqual(starts.slice(-START_TIMES_KEPT));
  });

  it("gives no start for a missing file, a text that is not JSON, a different format and a wrong item", () => {
    expect(parseStartTimes(undefined)).toEqual([]);
    expect(parseStartTimes("{")).toEqual([]);
    expect(parseStartTimes("null")).toEqual([]);
    expect(parseStartTimes(JSON.stringify({ format: "other/1", starts: [start(1000)] }))).toEqual([]);
    const mixed = { format: START_TIMES_FORMAT, starts: [start(1000), { at: 5, ms: 1 }, { at: "x", ms: -1 }, { at: "x", ms: Number.NaN }, null, "x", start(2000, 1)] };
    expect(parseStartTimes(JSON.stringify(mixed))).toEqual([start(1000), start(2000, 1)]);
  });

  it("starts a new file from a broken file", () => {
    expect(parseStartTimes(addStartTime("not json", start(1000)))).toEqual([start(1000)]);
  });

  it("reads the text of a file, and gives no text for a missing file", () => {
    const folder = mkdtempSync(join(tmpdir(), "start-times-"));
    try {
      writeFileSync(join(folder, "a.json"), "text");
      expect(hostFileText(join(folder, "a.json"))).toBe("text");
      expect(hostFileText(join(folder, "missing.json"))).toBeUndefined();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("the missed starts", () => {
  const good = [44_000, 40_000, 52_000, 41_000, 47_000].map((ms, index) => start(ms, index));
  const missed = (ms: number, index: number): StartTime => ({ ...start(ms, index), missed: true });

  it("keeps a missed start in the file, and refuses a missed flag that is not true", () => {
    const text = addMissedStart(fileOf(good), "2026-11-18T22:00:00.000Z", 64_000);
    expect(parseStartTimes(text).at(-1)).toEqual({ at: "2026-11-18T22:00:00.000Z", ms: 64_000, missed: true });
    const wrong = JSON.stringify({ format: START_TIMES_FORMAT, starts: [{ ...start(1000), missed: false }] });
    expect(parseStartTimes(wrong)).toEqual([]);
  });

  it("makes the window longer than the last missed window, and does not count a missed start as a measured start", () => {
    // The measured window is 64 s. Two starts missed it, the second in a window of 128 s.
    const window = readyWindow([...good, missed(64_000, 5), missed(128_000, 6)], FLOOR);
    expect(window).toEqual({ ms: 128_000 * READY_GROWTH_FACTOR, starts: MEASURED_STARTS, measured: true, missed: 2 });
    expect(readyWindow([missed(BOOTSTRAP_WINDOW_MS, 0)], FLOOR)).toEqual({ ms: BOOTSTRAP_WINDOW_MS * READY_GROWTH_FACTOR, starts: 0, measured: false, missed: 1 });
    expect(readyWindow([...good, missed(400_000, 5)], FLOOR).ms).toBe(WINDOW_CAP_MS);
  });

  it("forgets the missed starts before a good start, as the supervisor does at a ready start", () => {
    const window = readyWindow([missed(64_000, 0), missed(128_000, 1), ...good.map((each, index) => start(each.ms, index + 2))], FLOOR);
    expect(window).toEqual({ ms: 64_000, starts: MEASURED_STARTS, measured: true, missed: 0 });
  });

  it("tells the missed starts in the line of the window", () => {
    expect(readyWindowText({ ms: 256_000, starts: 5, measured: true, missed: 2 })).toBe(
      "The ready window of the runtime is 256 s, from 5 measured starts. 2 starts after the last good start were not ready in their window.",
    );
  });
});

describe("readyWindow", () => {
  it("gives the bootstrap window before the host has its measured starts", () => {
    const few = [start(40_000), start(41_000, 1)];
    expect(readyWindow([], FLOOR)).toEqual({ ms: BOOTSTRAP_WINDOW_MS, starts: 0, measured: false, missed: 0 });
    expect(readyWindow(few, FLOOR)).toEqual({ ms: BOOTSTRAP_WINDOW_MS, starts: 2, measured: false, missed: 0 });
    expect(BOOTSTRAP_WINDOW_MS).toBeGreaterThan(3 * FLOOR);
  });

  it("gives the worst start plus the spread of the starts", () => {
    const starts = [44_000, 40_000, 52_000, 41_000, 47_000].map((ms, index) => start(ms, index));
    expect(readyWindow(starts, FLOOR)).toEqual({ ms: 64_000, starts: MEASURED_STARTS, measured: true, missed: 0 });
  });

  it("keeps the floor for a fast host, and the cap for a very slow host", () => {
    const fast = [8000, 9000, 8500, 9500, 8800].map((ms, index) => start(ms, index));
    const slow = [400_000, 500_000, 420_000, 480_000, 450_000].map((ms, index) => start(ms, index));
    expect(readyWindow(fast, FLOOR).ms).toBe(FLOOR);
    expect(readyWindow(slow, FLOOR).ms).toBe(WINDOW_CAP_MS);
  });

  it("gives a window that holds each measured start, between the floor and the cap", () => {
    for (const seed of SEEDS) {
      const r = random(`ready-window:${String(seed)}`);
      const times = Array.from({ length: r.int(MEASURED_STARTS, START_TIMES_KEPT) }, () => r.int(1, 900_000));
      const window = readyWindow(
        times.map((ms, index) => start(ms, index)),
        FLOOR,
      );
      expect(window.measured, String(seed)).toBe(true);
      expect(window.ms, String(seed)).toBeGreaterThanOrEqual(FLOOR);
      expect(window.ms, String(seed)).toBeLessThanOrEqual(WINDOW_CAP_MS);
      expect(window.ms, String(seed)).toBeGreaterThanOrEqual(Math.min(WINDOW_CAP_MS, Math.max(...times)));
    }
  });

  it("tells the window in one line", () => {
    expect(readyWindowText({ ms: 64_000, starts: 5, measured: true, missed: 0 })).toBe("The ready window of the runtime is 64 s, from 5 measured starts.");
    expect(readyWindowText({ ms: BOOTSTRAP_WINDOW_MS, starts: 2, measured: false, missed: 0 })).toBe(
      `The ready window of the runtime is ${String(BOOTSTRAP_WINDOW_MS / 1000)} s. The host has 2 of the ${String(MEASURED_STARTS)} measured starts that the window needs.`,
    );
  });
});
