/**
 * The gate of the state at its plateau (AL-109). The test seeds one log of the live mix, and it folds the log as a start
 * does. It reads the JSON bytes of the state at each two hours of event time.
 *
 * A stream report expires 1 to 12 hours after its sent time, and a live report stays in the state. Thus the state grows
 * for approximately 13 hours of event time with the short retention of this test. After that time, the retirements
 * remove the reports at the rate of their arrival, and the state stops its growth.
 *
 * The seed fixes the log, thus the bytes are the same in each run. The limit is the bytes of the seed plus 10 percent, for a
 * small change of the format. A change that grows the state past the limit, or that grows it after the plateau, fails here.
 *
 * The log is 44 MB, thus the test starts only in CI, and not on a shared computer.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_RUNTIME, FOLD_TYPES, fold, openRuntimeLog, type FoldContext, type RuntimeState } from "@mark1russell7/alerts-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedStore, type SeedStoreResult } from "./seed-store.ts";

const HOUR = 3_600_000;
// The size of the log. The seeder writes approximately 1.8 MB of the live mix in each hour, thus the log has approximately 24 hours.
const SIZE = 44_000_000;
// A short retention: the horizon and the quiet horizon are 5 minutes.
const RETENTION = { horizon: 5 * 60_000, life: 30 * 60_000, every: 5 * 60_000 };
const CONTEXT: FoldContext = { sources: [], retention: RETENTION };
// The event times of the samples, in hours after the first event.
const SAMPLES = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22];
// The first sample after the plateau.
const PLATEAU_FROM = 16;
// The limit of the bytes of the state after the plateau: the most bytes of the seed after 16 hours (2,998,369 in CI on
// 2026-11-21) plus 10 percent. The seed fixes the log and the fold, thus each run gives the same bytes.
const PLATEAU_BYTES = 3_300_000;
// The limit of the growth of the state after the plateau.
const PLATEAU_GROWTH = 1.1;

// The JSON bytes of each top-level part of a state.
const partsOf = (state: RuntimeState): Record<string, number> =>
  Object.fromEntries(Object.entries(state).map(([key, value]) => [key, JSON.stringify(value ?? null).length]));

describe.runIf(process.env.CI !== undefined)("the state of a seeded log at its plateau (AL-109)", () => {
  let dir: string;
  let seeded: SeedStoreResult;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "plateau-"));
    seeded = await seedStore(dir, { log: SIZE, seed: "al-109", retention: RETENTION });
  }, 600_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("stops its growth after the plateau, under the fixed limit of the seed", () => {
    const log = openRuntimeLog(seeded.path);
    const bytes: number[] = [];
    let state = EMPTY_RUNTIME;
    let first: number | undefined;
    let last: RuntimeState = state;
    try {
      // The fold reads one event at a time, thus the test keeps no copy of the log.
      for (const event of log.read(FOLD_TYPES)) {
        first ??= event.time;
        while (bytes.length < SAMPLES.length && event.time >= first + (SAMPLES[bytes.length] as number) * HOUR) {
          bytes.push(JSON.stringify(state).length);
          last = state;
        }
        state = fold(state, event, CONTEXT);
      }
    } finally {
      log.close();
    }
    const record = JSON.stringify({ hours: SAMPLES.slice(0, bytes.length), bytes, parts: partsOf(last) });
    expect(bytes.length, record).toBe(SAMPLES.length);
    const after = bytes.slice(SAMPLES.indexOf(PLATEAU_FROM));
    for (const one of after) expect(one, record).toBeLessThanOrEqual(PLATEAU_BYTES);
    expect(Math.max(...after), record).toBeLessThanOrEqual((after[0] as number) * PLATEAU_GROWTH);
  }, 600_000);
});
