/**
 * The timed store of the snapshot of the start (AL-115). A measured start keeps each record in a list. The live entry
 * prints one line for each write (AL-123). Thus the log tells the cause of a block of the event loop at a write.
 */
import type { GcPause } from "@mark1russell7/lag/node";
import type { ChunkOptions, FoldKey, FoldMark, FoldRow, FoldSnapshot, MarkLog } from "@mark1russell7/sqlite";

/** The record of one write of the snapshot of the start. */
export interface SnapshotWriteTime {
  /** The value of `performance.now()` at the start of the write, in milliseconds. */
  readonly at: number;
  /** The count of rows. */
  readonly rows: number;
  /** The count of UTF-16 code units in the parts and the values of the rows. */
  readonly chars: number;
  /** The time of the build of the rows, in milliseconds. The build makes the JSON text of each row. */
  readonly rowsMs: number;
  /** The time of the store in the write apart from the build of the rows, in milliseconds, with no pause. Most of it is SQLite. */
  readonly writeMs: number;
  /** The CPU time of the process from the start to the end of the write, user plus system, in milliseconds. Other work in the pauses adds to it. */
  readonly cpuMs: number;
  /** The time from the start to the end of the write, with the pauses, in milliseconds. */
  readonly wallMs: number;
  /** The longest time between two pauses of the write, in milliseconds: the longest block of the event loop in the write. */
  readonly longestMs: number;
  /**
   * The most CPU time of the thread of the event loop in one part of the write, in milliseconds (AL-122). This is the work of
   * the part. A wait of the thread for the disk or for the computer does not add to it. Linux gives the time in microseconds.
   */
  readonly longestCpuMs: number;
  /** The wait of the longest part, in milliseconds: its time with no CPU time of the thread. The thread waits for the disk or for the computer. */
  readonly longestWaitMs: number;
  /** The count of the parts of the write between two pauses. */
  readonly chunks: number;
  /** Each part of the write between two pauses, in order (AL-174). A gate takes the pauses of the garbage collector out of each part. */
  readonly parts: readonly WritePart[];
}

/** One part of a snapshot write between two pauses (AL-174). */
export interface WritePart {
  /** The start of the part, on the clock of `performance.now()`. */
  readonly at: number;
  /** The time of the part, in milliseconds. */
  readonly ms: number;
  /** The CPU time of the thread of the event loop in the part, in milliseconds. */
  readonly cpuMs: number;
}

/**
 * This function gives the most work of the thread in one part of a write (AL-174). The work of a part is its CPU time apart
 * from the pauses of the garbage collector in it. One pause of the collector is not work of the write, and it is not the same in each
 * run. A pause across an edge of a part counts with its part inside. The work of a part is 0 or more.
 */
export function longestPartWork(parts: readonly WritePart[], pauses: readonly GcPause[]): { readonly workMs: number; readonly gcMs: number } {
  let workMs = 0;
  let gcMs = 0;
  for (const part of parts) {
    const end = part.at + part.ms;
    let inside = 0;
    for (const pause of pauses) inside += Math.max(0, Math.min(end, pause.startTime + pause.duration) - Math.max(part.at, pause.startTime));
    const work = Math.max(0, part.cpuMs - inside);
    if (work > workMs) workMs = work;
    if (inside > gcMs) gcMs = inside;
  }
  return { workMs, gcMs };
}

// The default pause of `writeInChunks`: one timer of 0 ms.
const oneTimer = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * This function gives the store with a record of each write (AL-115, AL-123). The rows come from a generator of the runtime.
 * The store times each step of the generator, and each part of the write between two pauses. `onWrite` gets the record
 * at the end of each write. The read and the clear do not change.
 */
export function timedSnapshot(store: FoldSnapshot, onWrite: (write: SnapshotWriteTime) => void): FoldSnapshot {
  const timed = (rows: Iterable<FoldRow>, written: (record: Omit<SnapshotWriteTime, "at" | "cpuMs" | "wallMs">) => void, chunked: { readonly pause?: () => Promise<void> } = {}) => {
    const counts = { rows: 0, chars: 0, rowsMs: 0, busyMs: 0, longestMs: 0, longestCpuMs: 0, longestWaitMs: 0, chunks: 1 };
    const parts: WritePart[] = [];
    let segment = performance.now();
    let segmentCpu = process.threadCpuUsage();
    function* each(): Generator<FoldRow> {
      const iterator = rows[Symbol.iterator]();
      for (;;) {
        const before = performance.now();
        const step = iterator.next();
        counts.rowsMs += performance.now() - before;
        if (step.done === true) return;
        counts.rows += 1;
        counts.chars += step.value.part.length + step.value.value.length;
        yield step.value;
      }
    }
    const end = (): void => {
      const ms = performance.now() - segment;
      const used = process.threadCpuUsage(segmentCpu);
      const cpuMs = (used.user + used.system) / 1000;
      parts.push({ at: segment, ms, cpuMs });
      counts.busyMs += ms;
      if (ms > counts.longestMs) {
        counts.longestMs = ms;
        counts.longestWaitMs = Math.max(0, ms - cpuMs);
      }
      counts.longestCpuMs = Math.max(counts.longestCpuMs, cpuMs);
    };
    const pause = async (): Promise<void> => {
      end();
      await (chunked.pause ?? oneTimer)();
      counts.chunks += 1;
      segment = performance.now();
      segmentCpu = process.threadCpuUsage();
    };
    const done = (): void => {
      end();
      written({ rows: counts.rows, chars: counts.chars, rowsMs: counts.rowsMs, writeMs: counts.busyMs - counts.rowsMs, longestMs: counts.longestMs, longestCpuMs: counts.longestCpuMs, longestWaitMs: counts.longestWaitMs, chunks: counts.chunks, parts });
    };
    return { rows: each(), pause, done };
  };
  const record = (at: number, cpu: NodeJS.CpuUsage) => (part: Omit<SnapshotWriteTime, "at" | "cpuMs" | "wallMs">): void => {
    const used = process.cpuUsage(cpu);
    const write: SnapshotWriteTime = { at, ...part, cpuMs: (used.user + used.system) / 1000, wallMs: performance.now() - at };
    onWrite(write);
  };
  return {
    read<T>(key: FoldKey, log: MarkLog, work: (mark: FoldMark, rows: Iterable<FoldRow>) => T): T | undefined {
      return store.read(key, log, work);
    },
    clear: () => store.clear(),
    write(key, mark, rows) {
      const one = timed(rows, record(performance.now(), process.cpuUsage()));
      const count = store.write(key, mark, one.rows);
      one.done();
      return count;
    },
    async writeInChunks(key: FoldKey, mark: FoldMark, rows: Iterable<FoldRow>, options: ChunkOptions = {}): Promise<number> {
      const one = timed(rows, record(performance.now(), process.cpuUsage()), options);
      const count = await store.writeInChunks(key, mark, one.rows, { ...options, pause: one.pause });
      one.done();
      return count;
    },
  };
}

/**
 * This function gives the line of the output for one write of the snapshot (AL-123). The line has no value of the state.
 * A block of the event loop in the time of the write has the write as a cause. The wait of the longest part is its time with no CPU time of the thread.
 */
export function snapshotWriteLine(write: SnapshotWriteTime): string {
  const ms = (value: number): string => `${String(Math.round(value))} ms`;
  return (
    `A write of the snapshot of the start took ${ms(write.wallMs)} with its pauses, in ${String(write.chunks)} parts, for ${String(write.rows)} rows. ` +
    `Its longest part took ${ms(write.longestMs)}: ${ms(write.longestCpuMs)} of CPU time of the thread at most, and a wait of ${ms(write.longestWaitMs)} for the disk or the computer.`
  );
}
