/**
 * This module holds the mode `fold` of the entry (AL-153): `node src/main.ts fold`. The mode opens the log as a start
 * does, folds it, and writes the snapshot of the start. It starts no service, no listener and no pass. Then it closes its
 * files and ends.
 *
 * A change of `FOLD_VERSION` makes the next start ignore the old snapshot and fold the whole log. On a small host, that
 * fold can take longer than the ready window of the supervisor, and the supervisor stops each start in its fold. The mode
 * has no window. Start it with the new code while the runtime is stopped. Then the next start reads the new snapshot.
 */
import type { Runtime } from "./runtime.ts";

/** The parts of the mode `fold`: the runtime of the fold, and the closes of the files, in their sequence. */
export interface FoldEnd {
  readonly runtime: Pick<Runtime, "writeStartSnapshot" | "close" | "start">;
  /** Each close runs after the write, also when the write fails. The lock of the home folder goes last. */
  readonly closes: readonly (() => void | Promise<void>)[];
}

/**
 * This function writes the snapshot of the fold of the runtime, and then it closes the runtime and each file. It gives the
 * count of the rows of the snapshot. A failed write throws after the closes.
 */
export async function writeFold(end: FoldEnd): Promise<number> {
  try {
    return await end.runtime.writeStartSnapshot();
  } finally {
    await end.runtime.close();
    for (const close of end.closes) await close();
  }
}

/** This function gives the line of the output for the end of the mode `fold`. The line has counts only. */
export function foldText(rows: number, events: number): string {
  return `The fold of ${String(events)} events of the log is in the snapshot of the start, with ${String(rows)} rows. The next start reads it.`;
}
