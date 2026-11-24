import { describe, expect, it } from "vitest";
import { foldText, writeFold, type FoldEnd } from "./fold-mode.ts";

// A fake runtime of the fold: it records the write and the close in one list with the closes of the files.
function fakeEnd(write: () => Promise<number>): { end: FoldEnd; calls: string[] } {
  const calls: string[] = [];
  const end: FoldEnd = {
    runtime: {
      start: { events: 7 },
      writeStartSnapshot: async () => {
        calls.push("write");
        return write();
      },
      close: () => {
        calls.push("runtime");
        return Promise.resolve();
      },
    },
    closes: [() => void calls.push("snapshot"), () => void calls.push("log"), () => {
      calls.push("lock");
      return Promise.resolve();
    }],
  };
  return { end, calls };
}

describe("the mode fold (AL-153)", () => {
  it("writes the snapshot, then closes the runtime and each file in its sequence", async () => {
    const { end, calls } = fakeEnd(() => Promise.resolve(42));
    await expect(writeFold(end)).resolves.toBe(42);
    expect(calls).toEqual(["write", "runtime", "snapshot", "log", "lock"]);
  });

  it("closes each file and gives the lock back also when the write fails", async () => {
    const { end, calls } = fakeEnd(() => Promise.reject(new Error("disk full")));
    await expect(writeFold(end)).rejects.toThrow("disk full");
    expect(calls).toEqual(["write", "runtime", "snapshot", "log", "lock"]);
  });

  it("tells the counts of the fold and of the rows only", () => {
    expect(foldText(12, 3400)).toBe("The fold of 3400 events of the log is in the snapshot of the start, with 12 rows. The next start reads it.");
  });
});
