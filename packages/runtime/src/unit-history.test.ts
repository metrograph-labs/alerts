import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bucketOf, HISTORY_BUCKET, MIN_READS, surpriseOf, type SignalUnit } from "@mark1russell7/alerts";
import { openDatabase } from "@mark1russell7/sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openReadingStore, READINGS_FILE, type FileReadingStore, type ReadingStore } from "./readings.ts";
import { unitHistory } from "./unit-history.ts";

const T0 = Date.UTC(2026, 3, 1, 18, 0, 0);
const HOUR = HISTORY_BUCKET;
const RAIL = "world/rail";
const units = (signal: boolean): SignalUnit[] => [
  { unit: RAIL, signal },
  { unit: "place/place:a/rail", signal: false },
];

let folders: string[] = [];
const stores: FileReadingStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const made of folders) rmSync(made, { recursive: true, force: true, maxRetries: 3 });
  folders = [];
});

/** This function opens a store in a new temporary folder, or in the folder of `path`. */
function openStore(path?: string): FileReadingStore {
  let file = path;
  if (file === undefined) {
    const made = mkdtempSync(join(tmpdir(), "alerts-units-"));
    folders.push(made);
    file = join(made, READINGS_FILE);
  }
  const store = openReadingStore(file);
  stores.push(store);
  return store;
}

describe("the history of the signal units (AL-24)", () => {
  it("counts one read for each hour, not one read for each pass", () => {
    const store = openStore();
    const history = unitHistory(store);
    // A pass every 10 seconds for one hour: one bucket. The first pass of the next hour has a signal.
    for (let at = T0; at < T0 + HOUR; at += 10_000) history.record(at, units(false));
    history.record(T0 + HOUR, units(true));
    history.record(T0 + HOUR + 10_000, units(false));
    expect(store.unitReads(Number.MIN_SAFE_INTEGER).map((item) => item.bucket)).toEqual([T0, T0 + HOUR]);
    expect(history.histories(T0 + 2 * HOUR)).toEqual([
      { unit: "place/place:a/rail", reads: 2, signals: 0 },
      { unit: RAIL, reads: 2, signals: 1 },
    ]);
    // The bucket of the bound is not in the history: the read of this hour is not in its own base rate.
    expect(history.histories(T0 + HOUR)).toEqual([
      { unit: "place/place:a/rail", reads: 1, signals: 0 },
      { unit: RAIL, reads: 1, signals: 0 },
    ]);
  });

  it("adds no read for an hour with no read of a unit", () => {
    const store = openStore();
    const history = unitHistory(store);
    history.record(T0, []);
    history.record(T0 + HOUR, [{ unit: RAIL, signal: false }]);
    history.record(T0 + 2 * HOUR, [{ unit: "world/road-traffic", signal: true }]);
    expect(history.histories(T0 + 3 * HOUR)).toEqual([
      { unit: RAIL, reads: 1, signals: 0 },
      { unit: "world/road-traffic", reads: 1, signals: 1 },
    ]);
  });

  it("gives no rate before MIN_READS hours, and a rate after them", () => {
    const store = openStore();
    const history = unitHistory(store);
    for (let hour = 0; hour < MIN_READS; hour += 1) history.record(T0 + hour * HOUR, units(false));
    const now = T0 + MIN_READS * HOUR;
    expect(surpriseOf([{ unit: RAIL, signal: true }], history.histories(now - HOUR)).noRate).toEqual([RAIL]);
    expect(surpriseOf([{ unit: RAIL, signal: true }], history.histories(now)).noRate).toEqual([]);
  });

  it("reads the store again after a restart: the same store and time give the same history", () => {
    const store = openStore();
    const first = unitHistory(store);
    for (let hour = 0; hour < 5; hour += 1) first.record(T0 + hour * HOUR + 1_000, units(hour % 2 === 0));
    const again = unitHistory(store);
    expect(again.histories(T0 + 5 * HOUR)).toEqual(first.histories(T0 + 5 * HOUR));
    // A restart in the same hour writes no second read of the hour.
    again.record(T0 + 4 * HOUR + 2_000, units(false));
    expect(store.unitReads(T0 + 4 * HOUR)).toEqual([{ bucket: T0 + 4 * HOUR, units: [{ unit: "place/place:a/rail", signal: false }, { unit: RAIL, signal: true }] }]);
  });

  it("changes nothing when the store throws, and writes the bucket at the next pass", () => {
    const store = openStore();
    let broken = true;
    const flaky: ReadingStore = {
      ...store,
      addUnitReads: (reads) => {
        if (broken) throw new Error("The disk is full.");
        return store.addUnitReads(reads);
      },
    };
    const history = unitHistory(flaky);
    expect(() => history.record(T0, units(true))).toThrow("The disk is full.");
    expect(history.histories(T0 + HOUR)).toEqual([]);
    broken = false;
    history.record(T0 + 10_000, units(true));
    expect(history.histories(T0 + HOUR)).toEqual([
      { unit: "place/place:a/rail", reads: 1, signals: 0 },
      { unit: RAIL, reads: 1, signals: 1 },
    ]);
  });

  it("drops the hours that the store deleted", () => {
    const store = openStore();
    const history = unitHistory(store);
    for (let hour = 0; hour < 4; hour += 1) history.record(T0 + hour * HOUR, units(false));
    store.prune(T0 + 2 * HOUR);
    history.pruned(T0 + 2 * HOUR);
    expect(store.unitReads(Number.MIN_SAFE_INTEGER).map((item) => item.bucket)).toEqual([T0 + 2 * HOUR, T0 + 3 * HOUR]);
    expect(history.histories(T0 + 4 * HOUR).find((item) => item.unit === RAIL)).toEqual({ unit: RAIL, reads: 2, signals: 0 });
    expect(unitHistory(store).histories(T0 + 4 * HOUR)).toEqual(history.histories(T0 + 4 * HOUR));
  });

  it("puts each time of one hour in one bucket", () => {
    expect(bucketOf(T0 + HOUR - 1)).toBe(T0);
    expect(() => unitHistory(openStore(), 0)).toThrow(RangeError);
  });

  it("keeps the table in its own part, thus the version of the readings stays 1 for an older build", () => {
    const made = mkdtempSync(join(tmpdir(), "alerts-units-"));
    folders.push(made);
    const path = join(made, READINGS_FILE);
    const store = openStore(path);
    store.addUnitReads({ bucket: T0, units: units(true) });
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const db = openDatabase(path);
    try {
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      expect(db.prepare("SELECT version FROM schema_versions WHERE part = 'unit-reads'").get()).toEqual({ version: 1 });
    } finally {
      db.close();
    }
    // A second open does no step, and the reads stay.
    expect(openStore(path).unitReads(T0)).toHaveLength(1);
  });
});
