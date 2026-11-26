import type { ChunkOptions, FoldKey, FoldMark, FoldRow, FoldSnapshot } from "@mark1russell7/sqlite";
import { describe, expect, it } from "vitest";
import { snapshotWriteLine, timedSnapshot, type SnapshotWriteTime } from "./timed-snapshot.ts";

// A store that keeps the rows of its last write. Its chunked write pauses after each two rows.
function keptStore(): FoldSnapshot & { readonly kept: FoldRow[] } {
  const kept: FoldRow[] = [];
  return {
    kept,
    read: () => undefined,
    clear: () => void kept.splice(0),
    write(_key: FoldKey, _mark: FoldMark, rows: Iterable<FoldRow>) {
      kept.splice(0, kept.length, ...rows);
      return kept.length;
    },
    async writeInChunks(_key: FoldKey, _mark: FoldMark, rows: Iterable<FoldRow>, options: ChunkOptions = {}) {
      kept.splice(0);
      for (const row of rows) {
        kept.push(row);
        if (kept.length % 2 === 0) await options.pause?.();
      }
      return kept.length;
    },
  } as FoldSnapshot & { readonly kept: FoldRow[] };
}

const key = { context: "test", log: "log-1" } as unknown as FoldKey;
const mark = { seq: 5, id: "event-5" } as unknown as FoldMark;
const rows: FoldRow[] = [1, 2, 3, 4, 5].map((n) => ({ part: "state.items[]", value: JSON.stringify({ n }) }) as FoldRow);

describe("the timed store of the snapshot (AL-123)", () => {
  it("writes each row to the store, and gives one record for each write", async () => {
    const store = keptStore();
    const heard: SnapshotWriteTime[] = [];
    const timed = timedSnapshot(store, (write) => heard.push(write));
    expect(await timed.writeInChunks(key, mark, rows)).toBe(5);
    expect(store.kept).toEqual(rows);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ rows: 5, chunks: 3 });
    expect(heard[0]?.parts).toHaveLength(3);
    expect(timed.write(key, mark, rows)).toBe(5);
    expect(heard).toHaveLength(2);
    expect(heard[1]).toMatchObject({ rows: 5, chunks: 1 });
  });

  it("gives a line with the times and the counts of a write, and no value of a row", async () => {
    let line = "";
    const timed = timedSnapshot(keptStore(), (write) => (line = snapshotWriteLine(write)));
    await timed.writeInChunks(key, mark, rows);
    expect(line).toMatch(/^A write of the snapshot of the start took [0-9]+ ms with its pauses, in 3 parts, for 5 rows\. /u);
    expect(line).toMatch(/a wait of [0-9]+ ms for the disk or the computer\.$/u);
    expect(line).not.toContain("items");
    const fixed: SnapshotWriteTime = { at: 0, rows: 9, chars: 90, rowsMs: 1, writeMs: 2, cpuMs: 3, wallMs: 812.4, longestMs: 95.6, longestCpuMs: 60.2, longestWaitMs: 35.4, chunks: 41, parts: [] };
    expect(snapshotWriteLine(fixed)).toBe(
      "A write of the snapshot of the start took 812 ms with its pauses, in 41 parts, for 9 rows. Its longest part took 96 ms: 60 ms of CPU time of the thread at most, and a wait of 35 ms for the disk or the computer.",
    );
  });
});
