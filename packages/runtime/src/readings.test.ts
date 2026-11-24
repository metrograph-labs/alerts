import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeWallClock } from "@mark1russell7/algebra/clock";
import { bucketOf, HISTORY_BUCKET, indicatorSurprise, MIN_READS, readSeries, type MapResult, type MeasureDeclaration, type Observation, type ObservationId, type PlaceId, type Reading, type SourceDescriptor, type SourceId, type SourceProcedures, type WatchedPlace } from "@mark1russell7/alerts";
import { afterEach, describe, expect, it } from "vitest";
import { fetchStep, type FetchInput } from "./fetch.ts";
import { openRuntimeLog } from "./log.ts";
import { openReadingStore, READING_RETENTION, READINGS_FILE, type FileReadingStore, type ReadingStore } from "./readings.ts";
import { openRuntime, type RuntimeOptions } from "./runtime.ts";

const T0 = Date.UTC(2026, 3, 1, 18, 0, 0);
const MINUTE = 60_000;
const SOURCE_ID = "test-gauges" as SourceId;
const LEVEL: MeasureDeclaration = { id: "level", dimension: "river-levels", title: "River level", unit: "m", area: "point", moves: "rise", baseline: "none", cadence: 15 * MINUTE };
const SOURCE: SourceDescriptor = {
  id: SOURCE_ID,
  title: "Test gauges",
  origins: ["test"],
  dependsOn: ["provider:test"],
  uses: ["internet", "dns", "power"],
  kinds: [],
  coverage: "global",
  transport: "poll",
  interval: MINUTE,
  slowAfter: 10_000,
  auth: "none",
  measures: [LEVEL],
};
const KANSAS: WatchedPlace = { id: "place:a" as PlaceId, codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 0 };
const VIEW: RuntimeOptions["view"] = { places: [KANSAS], kinds: ["met"], expectations: [], delay: { quantile: 0.9, level: 0.9 } };

const reading = (at: number, value: number, extra: Partial<Reading> = {}): Reading => ({
  source: SOURCE_ID,
  measure: LEVEL.id,
  series: "station-1",
  at,
  value,
  area: { type: "point", at: [-95.68, 39.05] },
  observation: "obs-1" as ObservationId,
  ...extra,
});

const observation = (id: string): Observation => ({ id: id as ObservationId, source: SOURCE_ID, fetched: T0, contentType: "application/json", body: "{}", transport: { latency: 1 } });

let folders: string[] = [];
const stores: FileReadingStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const made of folders) rmSync(made, { recursive: true, force: true, maxRetries: 3 });
  folders = [];
});

/** This function opens a store in a new temporary folder. */
function openStore(write?: (path: string) => void): FileReadingStore {
  const made = mkdtempSync(join(tmpdir(), "alerts-readings-"));
  folders.push(made);
  const path = join(made, READINGS_FILE);
  write?.(path);
  const store = openReadingStore(path);
  stores.push(store);
  return store;
}

describe("the store of the readings", () => {
  it("keeps each key once, and gives the readings of one series of each version in the order of their times", () => {
    const store = openStore();
    const ref = { source: SOURCE_ID, measure: LEVEL.id, series: "station-1" };
    const first = [reading(T0 + 2 * MINUTE, 3), reading(T0, 1, { cadence: 15 * MINUTE }), reading(T0 + MINUTE, 2, { version: "v2" })];
    expect(store.add(first)).toBe(3);
    // The same keys again change nothing: a fetch that repeats after a failed write of the log adds no reading.
    expect(store.add([reading(T0, 99, { cadence: 15 * MINUTE }), ...first])).toBe(0);
    // A reading of another series, another measure or another observation at one time is another key.
    expect(store.add([reading(T0, 5, { series: "station-2" }), reading(T0, 6, { measure: "flow" }), reading(T0, 7, { observation: "obs-2" as ObservationId })])).toBe(3);
    expect(store.count()).toBe(6);
    const series = store.series(ref, T0);
    expect(series.map((value) => value.value)).toEqual([1, 7, 2, 3]);
    expect(series[0]).toEqual(reading(T0, 1, { cadence: 15 * MINUTE }));
    expect(series[2]).toEqual(reading(T0 + MINUTE, 2, { version: "v2" }));
    expect(store.series(ref, T0 + MINUTE).map((value) => value.at)).toEqual([T0 + MINUTE, T0 + 2 * MINUTE]);
    // The list of the store is the input of the read of a series. Four values are too few for a history.
    expect(readSeries(series, LEVEL, T0 + 3 * MINUTE)).toEqual({ kind: "no-read", cause: "few-samples" });
  });

  it("deletes each reading before a time, and keeps the other readings", () => {
    const store = openStore();
    store.add([reading(T0 - READING_RETENTION - 1, 1), reading(T0 - READING_RETENTION, 2), reading(T0, 3)]);
    expect(store.prune(T0 - READING_RETENTION)).toBe(1);
    expect(store.count()).toBe(2);
    expect(store.prune(T0 - READING_RETENTION)).toBe(0);
  });

  it("lists each series one time, with each version in one series", () => {
    const store = openStore();
    expect(store.refs()).toEqual([]);
    store.add([reading(T0, 1, { series: "station-2" }), reading(T0, 2), reading(T0 + MINUTE, 3, { version: "v2" }), reading(T0, 4, { measure: "flow" })]);
    expect(store.refs()).toEqual([
      { source: SOURCE_ID, measure: "flow", series: "station-1" },
      { source: SOURCE_ID, measure: LEVEL.id, series: "station-1" },
      { source: SOURCE_ID, measure: LEVEL.id, series: "station-2" },
    ]);
    store.prune(T0 + MINUTE);
    expect(store.refs()).toEqual([{ source: SOURCE_ID, measure: LEVEL.id, series: "station-1" }]);
  });

  it("puts a broken file into quarantine, and starts empty", () => {
    const store = openStore((path) => writeFileSync(path, "This text is not a SQLite file. ".repeat(200)));
    expect(store.quarantined).toBeDefined();
    expect(store.count()).toBe(0);
    expect(store.add([reading(T0, 1)])).toBe(1);
  });
});

describe("the readings of a fetch", () => {
  const input = (map: (seen: Observation) => MapResult, extra: Partial<FetchInput> = {}): FetchInput => ({
    source: SOURCE_ID,
    descriptor: SOURCE,
    procedures: { map: ({ observation: seen }) => map(seen) },
    started: T0,
    ended: T0 + 10,
    outcome: { ok: true, observations: [observation("obs-1"), observation("obs-2")], complete: true },
    known: (id) => id === "obs-2",
    ...extra,
  });
  const fetchRecord = (step: ReturnType<typeof fetchStep>) => step.events.flatMap((event) => (event.type === "fetch" ? [event] : []))[0];

  it("gives the readings of the new observations that pass their checks, and no reading of a known observation", () => {
    const step = fetchStep(input((seen) => ({ reports: [], problems: [], readings: [reading(T0, 1, { observation: seen.id })] })));
    expect(step.readings).toEqual([reading(T0, 1)]);
    expect(fetchRecord(step)?.problems).toEqual([]);
    expect(fetchRecord(step)?.record.lossy).toBeUndefined();
  });

  it("gives a lossy problem for each reading that fails a check, and keeps the other readings", () => {
    const step = fetchStep(
      input((seen) => ({
        reports: [],
        problems: [],
        readings: [
          reading(T0, 1, { observation: seen.id }),
          reading(T0, 2, { observation: seen.id, measure: "flow" }),
          reading(T0, Number.NaN, { observation: seen.id }),
          reading(T0, 4, { observation: "obs-9" as ObservationId }),
          reading(T0, 5, { observation: seen.id, expected: 5 }),
        ],
      })),
    );
    expect(step.readings.map((value) => value.value)).toEqual([1]);
    const problems = fetchRecord(step)?.problems ?? [];
    expect(problems.map((problem) => problem.path)).toEqual(["readings[1]", "readings[2]", "readings[3]", "readings[4]"]);
    expect(problems.every((problem) => problem.lossy === true && !problem.fatal)).toBe(true);
    // The known observation gives the same four problems to the count of the health, and none to the log.
    expect(fetchRecord(step)?.record.lossy).toBe(8);
  });

  it("gives a lossy problem when the map gives no list or the runtime has no declaration", () => {
    const notList = fetchStep(input(() => ({ reports: [], problems: [], readings: "level" as unknown as readonly Reading[] })));
    expect(notList.readings).toEqual([]);
    expect(fetchRecord(notList)?.problems.map((problem) => problem.path)).toEqual(["readings"]);
    const { descriptor, ...bare } = input((seen) => ({ reports: [], problems: [], readings: [reading(T0, 1, { observation: seen.id })] }));
    expect(descriptor).toBe(SOURCE);
    const undeclared = fetchStep(bare);
    expect(undeclared.readings).toEqual([]);
    expect(fetchRecord(undeclared)?.problems.map((problem) => problem.path)).toEqual(["readings[0]"]);
  });
});

describe("the readings in a pass of the runtime", () => {
  const gauges = (): SourceProcedures => ({
    describe: () => SOURCE,
    fetch: async () => ({ ok: true, observations: [observation("obs-1")], complete: true }),
    map: ({ observation: seen }) => ({ reports: [], problems: [], readings: [reading(T0, 4, { observation: seen.id })] }),
  });

  it("writes the readings of each fetch to the store, and deletes the old readings", async () => {
    const store = openStore();
    store.add([reading(T0 - READING_RETENTION - 1, 1, { observation: "obs-0" as ObservationId })]);
    const log = openRuntimeLog(":memory:");
    try {
      const runtime = openRuntime({ log, clock: fakeWallClock(T0), sources: [gauges()], watch: () => ({ places: [KANSAS], kinds: ["met"] }), view: VIEW, run: "run-0", readings: store });
      await runtime.pass();
      expect(store.series({ source: SOURCE_ID, measure: LEVEL.id, series: "station-1" }, 0)).toEqual([reading(T0, 4)]);
    } finally {
      log.close();
    }
  });

  it("gives a fault of the store to the hook, and the pass writes its events", async () => {
    const faults: string[] = [];
    const broken: ReadingStore = {
      add: () => {
        throw new Error("The disk is full.");
      },
      series: () => [],
      refs: () => {
        throw new Error("The disk is full.");
      },
      addUnitReads: () => {
        throw new Error("The disk is full.");
      },
      unitReads: () => {
        throw new Error("The disk is full.");
      },
      prune: () => {
        throw new Error("The disk is full.");
      },
      count: () => 0,
      close: () => undefined,
    };
    const log = openRuntimeLog(":memory:");
    try {
      const runtime = openRuntime({ log, clock: fakeWallClock(T0), sources: [gauges()], watch: () => ({ places: [KANSAS], kinds: ["met"] }), view: VIEW, run: "run-0", readings: broken, onReadingsFault: (_error, action) => faults.push(action) });
      const pass = await runtime.pass();
      expect(pass.fetched).toEqual([SOURCE_ID]);
      expect(faults).toEqual(["add", "read", "prune"]);
      expect(pass.breadth).toBeUndefined();
      expect(pass.surprise).toBeUndefined();
      expect(log.has("obs-1")).toBe(true);
    } finally {
      log.close();
    }
  });

  it("gives the breadth of the signals in the world and in each place", async () => {
    const store = openStore();
    // Three weeks of a calm station in the zone of the place, at the same time of the week, and a high value at T0.
    const inZone = { type: "code", system: "ugc", code: "KSZ083" } as const;
    const weeks = [1, 2, 3].flatMap((week) =>
      [-2, -1, 0, 1, 2].map((slot) => reading(T0 - week * 7 * 24 * 60 * MINUTE + slot * 15 * MINUTE, 1 + slot / 100, { series: "station-2", area: inZone, observation: `obs-w${week}-${slot}` as ObservationId })),
    );
    store.add([...weeks, reading(T0, 50, { series: "station-2", area: inZone, observation: "obs-high" as ObservationId })]);
    const log = openRuntimeLog(":memory:");
    try {
      const runtime = openRuntime({ log, clock: fakeWallClock(T0), sources: [gauges()], watch: () => ({ places: [KANSAS], kinds: ["met"] }), view: VIEW, run: "run-0", readings: store });
      const pass = await runtime.pass();
      // The fetched station has one reading: no read. The station in the zone has a signal.
      const counts = [{ dimension: "river-levels", read: 1, signals: 1, noRead: 1 }];
      expect(pass.breadth?.world).toEqual({ signals: ["river-levels"], read: ["river-levels"], dimensions: counts });
      expect(pass.breadth?.places).toEqual([{ place: KANSAS.id, signals: ["river-levels"], read: ["river-levels"], dimensions: [{ dimension: "river-levels", read: 1, signals: 1, noRead: 0 }] }]);
      expect(pass.breadth?.unplaced).toEqual([]);
    } finally {
      log.close();
    }
  });

  // The store of the breadth test, with a signal of the station in the zone at T0, and 40 hours of calm units before T0.
  const surpriseStore = (): FileReadingStore => {
    const store = openStore();
    const inZone = { type: "code", system: "ugc", code: "KSZ083" } as const;
    const weeks = [1, 2, 3].flatMap((week) =>
      [-2, -1, 0, 1, 2].map((slot) => reading(T0 - week * 7 * 24 * 60 * MINUTE + slot * 15 * MINUTE, 1 + slot / 100, { series: "station-2", area: inZone, observation: `obs-w${week}-${slot}` as ObservationId })),
    );
    store.add([...weeks, reading(T0, 50, { series: "station-2", area: inZone, observation: "obs-high" as ObservationId })]);
    for (let hour = 1; hour <= 40; hour += 1) {
      store.addUnitReads({ bucket: bucketOf(T0) - hour * HISTORY_BUCKET, units: [{ unit: "world/river-levels", signal: false }, { unit: "place/place:a/river-levels", signal: false }] });
    }
    return store;
  };

  it("gives the surprise of the signals from one read of each unit in each hour (AL-24)", async () => {
    const store = surpriseStore();
    const clock = fakeWallClock(T0);
    const log = openRuntimeLog(":memory:");
    try {
      const runtime = openRuntime({ log, clock, sources: [gauges()], watch: () => ({ places: [KANSAS], kinds: ["met"] }), view: VIEW, run: "run-0", readings: store });
      const first = await runtime.pass();
      const calm = [
        { unit: "place/place:a/river-levels", reads: 40, signals: 0 },
        { unit: "world/river-levels", reads: 40, signals: 0 },
      ];
      expect(first.breadth).toBeDefined();
      // The two units are of two scopes, thus the store has no pair, and each scope has an empty list of pairs.
      expect(first.surprise).toEqual(indicatorSurprise(first.breadth!, calm, MIN_READS, []));
      expect(first.surprise?.world.pairs).toEqual([]);
      expect(first.surprise?.world).toMatchObject({ units: 1, signals: 1, noRate: [] });
      expect(first.surprise?.places.map((place) => [place.place, place.signals])).toEqual([[KANSAS.id, 1]]);
      expect(first.surprise!.world.surprise).toBeGreaterThan(0);
      // The first pass of the hour writes its units. The later passes of the hour write nothing, and see the same history.
      await clock.advance(10_000);
      const second = await runtime.pass();
      await clock.advance(10_000);
      await runtime.pass();
      expect(store.unitReads(bucketOf(T0))).toEqual([
        { bucket: bucketOf(T0), units: [{ unit: "place/place:a/river-levels", signal: true }, { unit: "world/river-levels", signal: true }] },
      ]);
      expect(store.unitReads(Number.MIN_SAFE_INTEGER)).toHaveLength(41);
      expect(second.surprise).toEqual(first.surprise);
    } finally {
      log.close();
    }
  });

  it("gives no surprise when the history of the units fails, and the pass continues (AL-24)", async () => {
    const store = surpriseStore();
    let broken = true;
    const fail = (): never => {
      throw new Error("The disk is full.");
    };
    const flaky: ReadingStore = {
      ...store,
      unitReads: (since) => (broken ? fail() : store.unitReads(since)),
      addUnitReads: (reads) => (broken ? fail() : store.addUnitReads(reads)),
    };
    const faults: string[] = [];
    const clock = fakeWallClock(T0);
    const log = openRuntimeLog(":memory:");
    try {
      const runtime = openRuntime({ log, clock, sources: [gauges()], watch: () => ({ places: [KANSAS], kinds: ["met"] }), view: VIEW, run: "run-0", readings: flaky, onReadingsFault: (_error, action) => faults.push(action) });
      const pass = await runtime.pass();
      expect(pass.fetched).toEqual([SOURCE_ID]);
      expect(pass.breadth?.world.signals).toEqual(["river-levels"]);
      expect(pass.surprise).toBeUndefined();
      expect(faults).toEqual(["read", "add"]);
      expect(log.has("obs-1")).toBe(true);
      // The next pass reads the store again.
      broken = false;
      await clock.advance(10_000);
      const next = await runtime.pass();
      expect(next.surprise?.world).toMatchObject({ units: 1, signals: 1, noRate: [] });
      expect(store.unitReads(bucketOf(T0))).toHaveLength(1);
    } finally {
      log.close();
    }
  });

  it("refuses an age of the oldest reading that is not above 0", () => {
    const log = openRuntimeLog(":memory:");
    try {
      expect(() => openRuntime({ log, clock: fakeWallClock(T0), sources: [], watch: () => ({ places: [], kinds: [] }), view: VIEW, run: "run-0", readingsKeep: 0 })).toThrow("not a finite number above 0");
    } finally {
      log.close();
    }
  });
});
