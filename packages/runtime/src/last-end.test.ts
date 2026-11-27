import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAST_LINE_LIMIT } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { blockWatchLine, phaseLabel } from "./block-watch.ts";
import { hostFolder } from "./host.ts";
import { lastEndOf, lastEndOfTail, lastEndReport, lastEndText, programLogPath, readLogTail } from "./last-end.ts";
import { LAST_LIMIT } from "./loop-notice.ts";
import { blockLine } from "./loop-watch.ts";

const T0 = Date.UTC(2026, 10, 26, 14, 0, 0, 250);
const SECOND = 1000;

/** This function gives one line of the runtime in the format of `timedLogger()`: the time, a space and the message. */
const line = (at: number, message: string): string => `${new Date(at).toISOString()} ${message}\n`;

// The code 4 is the phase "run after the good start".
const RUN_PHASE = 4;
// A block that starts at T0, and the two lines of the watch at 10 s and at 20 s.
const BLOCK_10 = blockWatchLine(T0 + 10 * SECOND, 10 * SECOND, RUN_PHASE);
const BLOCK_20 = blockWatchLine(T0 + 20 * SECOND, 20 * SECOND, RUN_PHASE);
const BEFORE = line(T0 - SECOND, "A pass ended.");

describe("the end of the last run in the log of the program (AL-222)", () => {
  it("gives the block of a run that stopped in the block: the last line of the watch", () => {
    const end = lastEndOf(BEFORE + BLOCK_10 + BLOCK_20);
    expect(end).toEqual({ lastLineAt: T0 + 20 * SECOND, block: { at: T0, size: 20 * SECOND, phase: phaseLabel(RUN_PHASE) }, lastLine: BLOCK_20.trim() });
  });

  it("gives a block for a line of the watch with no later line: the probe of the class", () => {
    // A liveness stop comes approximately 30 s into a block. Thus the line of the watch is the last line of that run.
    expect(lastEndOf(BEFORE + BLOCK_10).block).toEqual({ at: T0, size: 10 * SECOND, phase: "run after the good start" });
    expect(lastEndOf(BLOCK_10).block).not.toBeNull();
  });

  it("gives no block when the end line of the block comes after the line of the watch", () => {
    const ended = line(T0 + 25 * SECOND, blockLine({ at: T0, size: 25 * SECOND }));
    const end = lastEndOf(BEFORE + BLOCK_10 + BLOCK_20 + ended);
    expect(end).toEqual({ lastLineAt: T0 + 25 * SECOND, block: null, lastLine: ended.trim() });
  });

  it("gives no block when another line of the runtime comes after the line of the watch, because the event loop ran again", () => {
    expect(lastEndOf(BLOCK_10 + line(T0 + 12 * SECOND, "The start is ready.")).block).toBeNull();
    // A line with no time, as the second line of a message, does not end the block.
    expect(lastEndOf(`${BLOCK_10}- a second line\n`).block).not.toBeNull();
  });

  it("gives no block for a run with no block, and the last line with a time", () => {
    const text = BEFORE + line(T0, "A pass failed (2 in sequence): a reason") + "- a second line\n";
    expect(lastEndOf(text)).toEqual({ lastLineAt: T0, block: null, lastLine: "- a second line" });
  });

  it("ignores a cut first line, also when the cut leaves a line of the watch with no time", () => {
    const cutBlock = BLOCK_20.slice(30);
    expect(lastEndOf(cutBlock, { cut: true })).toEqual({ lastLineAt: null, block: null, lastLine: null });
    // The part of the line of the watch after the cut has a time of the block, but it is not a line.
    const fromCut = BLOCK_20.slice(BLOCK_20.indexOf("from ") + 5);
    expect(lastEndOf(fromCut + BEFORE, { cut: true })).toEqual({ lastLineAt: T0 - SECOND, block: null, lastLine: BEFORE.trim() });
    // With no cut, the same text has its first line.
    expect(lastEndOf(BEFORE, { cut: false }).lastLineAt).toBe(T0 - SECOND);
  });

  it("gives no facts for an empty log", () => {
    expect(lastEndOf("")).toEqual({ lastLineAt: null, block: null, lastLine: null });
    expect(lastEndOf("\n\n")).toEqual({ lastLineAt: null, block: null, lastLine: null });
    expect(lastEndOfTail(null)).toEqual({ lastLineAt: null, block: null, lastLine: null });
  });

  it("ignores each line of the current run, from the time of its start", () => {
    const current = line(T0 + 60 * SECOND, "The inspector signal is not disabled: node v24.") + "- a second line\n";
    expect(lastEndOf(BEFORE + BLOCK_10 + current, { before: T0 + 60 * SECOND })).toEqual(lastEndOf(BEFORE + BLOCK_10));
  });

  it("cuts a long last line to the limit of the notices of the supervisor, and removes the control characters", () => {
    expect(LAST_LINE_LIMIT).toBe(LAST_LIMIT);
    const end = lastEndOf(line(T0, `A long line \u0007 ${"x".repeat(400)}`));
    expect(end.lastLine).toHaveLength(LAST_LINE_LIMIT);
    expect(end.lastLine?.endsWith("…")).toBe(true);
    expect(end.lastLine).toMatch(/^S+Z A long line {3}x+/u);
    expect(lastEndOf("A line with a CR\r\n").lastLine).toBe("A line with a CR");
  });

  it("gives one line of text with the facts", () => {
    expect(lastEndText(lastEndOf(BEFORE + BLOCK_20))).toBe(
      `The last run: its last line with a time came at ${new Date(T0 + 20 * SECOND).toISOString()}. A block of the event loop of 20 s or more from ${new Date(T0).toISOString()} continued at its end, in the phase "run after the good start". Its last line: ${BLOCK_20.trim()}`,
    );
    expect(lastEndText(lastEndOf(BEFORE))).toBe(`The last run: its last line with a time came at ${new Date(T0 - SECOND).toISOString()}. No block of the event loop continued at its end. Its last line: ${BEFORE.trim()}`);
    expect(lastEndText(lastEndOf(""))).toBe("The last run: its log has no line.");
    expect(lastEndReport(T0, lastEndOf(""))).toEqual({ startedAt: T0, lastLineAt: null, block: null, lastLine: null });
  });
});

describe("the read of the end of the log of the program (AL-222)", () => {
  it("names the default log of the program in the folder of the host", () => {
    expect(programLogPath(join("/var/lib", "alerts"))).toBe(join(hostFolder(join("/var/lib", "alerts")), "logs", "runtime.log"));
  });

  it("reads the last bytes of a file, tells a cut, and gives null for a missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "last-end-"));
    try {
      const path = join(dir, "runtime.log");
      expect(await readLogTail(path)).toBeNull();
      await writeFile(path, BEFORE + BLOCK_10);
      expect(await readLogTail(path)).toEqual({ text: BEFORE + BLOCK_10, cut: false });
      const tail = await readLogTail(path, BLOCK_10.length + 5);
      expect(tail).toEqual({ text: (BEFORE + BLOCK_10).slice(-(BLOCK_10.length + 5)), cut: true });
      expect(lastEndOfTail(tail).block).toEqual({ at: T0, size: 10 * SECOND, phase: "run after the good start" });
      await writeFile(path, "");
      expect(await readLogTail(path)).toEqual({ text: "", cut: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
