import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportId, type Expectation, type ObservationId, type Report, type ReportId, type SourceId } from "@mark1russell7/alerts";
import { canonicalHash, random } from "@mark1russell7/rigor-generators";
import { afterEach, describe, expect, it } from "vitest";
import { entryIndex } from "./entries.ts";
import { envelope, type RuntimeEvent } from "./events.ts";
import { importOf, sharedItem } from "./exchange.ts";
import { FOLD_VERSION, openStartSnapshot, readSnapshot, snapshotKey, snapshotRows, startReadText, type StartSnapshot } from "./start-snapshot.ts";
import { EMPTY_RUNTIME, rebuild, type FoldContext, type RuntimeState } from "./state.ts";

const T0 = Date.UTC(2026, 3, 1, 18, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const API = "api" as SourceId;
const OTHER = "other" as SourceId;

const folders: string[] = [];
afterEach(() => {
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true });
});

/** One tornado warning of a county of Kansas, with a made-up key. */
function report(key: string, at: number): Report {
  return {
    id: reportId({ source: API, key, sent: at }),
    source: API,
    origin: "nws",
    key,
    references: [],
    correlation: [],
    status: "actual",
    op: "alert",
    kind: { code: "met.tornado", label: "Tornado Warning" },
    categories: ["met"],
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    response: ["shelter"],
    sent: at,
    received: at,
    expires: at + HOUR,
    areas: [{ type: "code", system: "ugc", code: "KSZ083" }],
    about: [],
    sender: "w-nws.webmaster@noaa.gov",
    headline: "Tornado Warning",
    observation: `api:${key}` as ObservationId,
    parameters: {},
  };
}

const fetched = (id: string, at: number, keys: readonly string[]): RuntimeEvent => ({
  ...envelope("fetch", id, at),
  record: { source: API, at, took: 100, fresh: keys.length, fatal: 0 },
  reports: keys.map((key) => report(key, at)),
  problems: [],
});

// The import of an event of the copy `b`.
function imported(event: RuntimeEvent): RuntimeEvent {
  const item = sharedItem(event, "b");
  if (item === undefined) throw new Error(`The event ${event.id} is not a shared event.`);
  return importOf(item);
}

// The state and the entry index of a few events: own reports, an import with its exchange event, an end mark and a clock step.
function sample(): StartSnapshot {
  const events: RuntimeEvent[] = [
    fetched("fetch:1", T0, ["w1", "w2"]),
    imported(fetched("fetch:2", T0 + MINUTE, ["w3"])),
    { ...envelope("exchange", "exchange:3", T0 + 2 * MINUTE), peer: "b", log: "log-b", next: 3 },
    { ...envelope("ended", "end:4", T0 + 3 * MINUTE), source: API, reports: [report("w1", T0).id] },
    { ...envelope("clock", "clock:5", T0 + 4 * MINUTE), size: 5 * MINUTE },
  ];
  const entries = entryIndex();
  const state = rebuild(
    (function* () {
      for (const event of events) {
        entries.add(event);
        yield event;
      }
    })(),
    { sources: [] },
  );
  return { state, entries: entries.snapshot() };
}

const CONTEXT: FoldContext = { sources: [], retention: {} };
const LOG = { first: "started:1", recoveries: 0 };

describe("the rows of the snapshot of a start (AL-105)", () => {
  it("give the state and the entry index again, with the views of the two sides", () => {
    const snapshot = sample();
    expect(snapshot.state.merge.reports.length).toBe(3);
    const again = readSnapshot([...snapshotRows(snapshot)]);
    expect(again.state).toEqual(snapshot.state);
    expect(again.entries).toEqual(snapshot.entries);
    // The index of the rows is the same index.
    expect(entryIndex(again.entries).snapshot()).toEqual(snapshot.entries);
    expect(entryIndex(again.entries).size).toBe(entryIndex(snapshot.entries).size);
  });

  it("give one row for each report, and keep no row of the views", () => {
    const rows = [...snapshotRows(sample())];
    expect(rows.filter((row) => row.part === "state.own.merge.reports[]")).toHaveLength(2);
    expect(rows.filter((row) => row.part === "state.imported.merge.reports[]")).toHaveLength(1);
    expect(rows.some((row) => row.part.startsWith("state.merge") || row.part.startsWith("state.escalationEnds"))).toBe(false);
  });

  it("keep the infinite time of an empty state, NaN and -0 with a tag", () => {
    const rows = [...snapshotRows({ state: EMPTY_RUNTIME, entries: entryIndex().snapshot() })];
    expect(rows.find((row) => row.part === "~state.time")?.value).toBe('{"~number":"-Infinity"}');
    expect(readSnapshot(rows).state).toEqual(EMPTY_RUNTIME);
    const odd = { ...EMPTY_RUNTIME, extra: { a: [Number.NaN, -0, Number.POSITIVE_INFINITY, 1] } } as unknown as RuntimeState;
    const again = readSnapshot([...snapshotRows({ state: odd, entries: entryIndex().snapshot() })]).state as unknown as { extra: { a: number[] } };
    expect(again.extra.a[0]).toBeNaN();
    expect(Object.is(again.extra.a[1], -0)).toBe(true);
    expect(again.extra.a.slice(2)).toEqual([Number.POSITIVE_INFINITY, 1]);
  });

  it("refuse a value that JSON does not keep", () => {
    const entries = entryIndex().snapshot();
    const rowsOf = (state: unknown): unknown => [...snapshotRows({ state: state as RuntimeState, entries })];
    expect(() => rowsOf({ ...EMPTY_RUNTIME, extra: new Map() })).toThrow(TypeError);
    expect(() => rowsOf({ ...EMPTY_RUNTIME, extra: [[1, undefined]] })).toThrow(TypeError);
    expect(() => rowsOf({ ...EMPTY_RUNTIME, extra: [undefined] })).toThrow(TypeError);
    expect(() => rowsOf({ ...EMPTY_RUNTIME, extra: { at: () => 1 } })).toThrow(TypeError);
  });

  it("refuse rows that are not in the form of the write", () => {
    expect(() => readSnapshot([{ part: "state.recoveries[]", value: "1" }])).toThrow("before its list");
    expect(() => readSnapshot([{ part: "state", value: "{}" }, { part: "state.lines{}", value: '"a"' }])).toThrow("bad entry");
    expect(() => readSnapshot([{ part: "state", value: "{}" }])).toThrow("no state or no entry index");
  });
});

describe("the key of the snapshot of a start (AL-105)", () => {
  it("is the same for the same fold, and has the version of the fold", () => {
    const key = snapshotKey(CONTEXT, LOG);
    expect(key.version).toBe(FOLD_VERSION);
    expect(snapshotKey({ sources: [], retention: {} }, { ...LOG })).toEqual(key);
    // The retention gets its defaults, thus the defaults written out give the same key.
    expect(snapshotKey({ sources: [], retention: { quiet: 6 * HOUR } }, LOG)).toEqual(key);
  });

  it("changes with the log and with each part of the context of the fold", () => {
    const key = snapshotKey(CONTEXT, LOG).key;
    const expectation: Expectation = { id: "e1", from: API, to: OTHER, when: { kinds: ["met.flood"] } };
    const others = [
      snapshotKey(CONTEXT, { ...LOG, first: "started:2" }),
      snapshotKey(CONTEXT, { ...LOG, recoveries: 1 }),
      snapshotKey({ sources: [] }, LOG),
      snapshotKey({ ...CONTEXT, retention: { quiet: 3 * HOUR } }, LOG),
      snapshotKey({ ...CONTEXT, expectations: [expectation] }, LOG),
    ].map((other) => other.key);
    for (const other of others) expect(other).not.toBe(key);
    expect(new Set(others).size).toBe(others.length);
  });
});

describe("the line of the read of the log at a start (AL-105)", () => {
  it("tells the position of the snapshot, the fault of its read, or the fold of the whole log", () => {
    expect(startReadText({ events: 12, snapshot: { seq: 900, id: "e-900" } })).toBe("The start read the snapshot at the position 900 of the log, and it folded the 12 events after it.");
    expect(startReadText({ events: 912, fault: "SyntaxError" })).toBe("The read of the snapshot failed (SyntaxError). The start folded the 912 events of the whole log.");
    expect(startReadText({ events: 912 })).toBe("The start had no snapshot of this log and of this configuration. It folded the 912 events of the whole log.");
  });
});

describe("the file of the snapshot of a start (AL-105)", () => {
  it("goes into quarantine when it is broken, and the store starts empty", () => {
    const place = mkdtempSync(join(tmpdir(), "alerts-snapshot-"));
    folders.push(place);
    const path = join(place, "snapshot.sqlite");
    writeFileSync(path, "This text is not a database file. ".repeat(200));
    const opened = openStartSnapshot(path);
    try {
      expect(opened.quarantined).toBeDefined();
      expect(opened.fault).toBeUndefined();
      const store = opened.store;
      if (store === undefined) throw new Error("The store did not open.");
      const log = { get: (id: string) => (id === "e-1" ? { seq: 1 } : undefined) };
      const key = snapshotKey(CONTEXT, LOG);
      expect(store.write(key, { seq: 1, id: "e-1" }, snapshotRows(sample()))).toBeGreaterThan(0);
      expect(store.read(key, log, (_mark, rows) => readSnapshot(rows).state)).toEqual(sample().state);
    } finally {
      opened.store?.close();
    }
  });
});

/**
 * The gate of the version of the fold. The test folds seeded logs, and it pins the hash of the rows of each snapshot. A change of
 * the fold, of the form of the state or of the form of the rows changes a hash. Then the change raises `FOLD_VERSION` and pins the
 * new hashes, and each start ignores the snapshots of the old fold.
 */
const DIGESTS: Readonly<Record<number, readonly string[]>> = {};
const POOL = ["w0", "w1", "w2", "w3"];
const AFTER = [0, MINUTE, 10 * MINUTE, HOUR, 3 * HOUR, 7 * HOUR, 24 * HOUR];

// A seeded log of fetches, imports with their exchange events, end marks and clock steps.
function seededLog(seed: string, length: number): RuntimeEvent[] {
  const r = random(seed);
  const events: RuntimeEvent[] = [];
  // The ids of the own reports of the log. An end mark names one of them.
  const own: ReportId[] = [];
  let at = T0;
  for (let index = 1; index <= length; index += 1) {
    at += r.pick(AFTER);
    const key = r.pick(POOL);
    switch (r.below(5)) {
      case 0:
        events.push(fetched(`fetch:${index}`, at, [key]));
        own.push(report(key, at).id);
        break;
      case 1:
        events.push(imported(fetched(`fetch:${index}`, at, [`b${key}`])));
        break;
      case 2:
        events.push({ ...envelope("exchange", `exchange:${index}`, at), peer: "b", log: "log-b", next: index });
        break;
      case 3:
        events.push({ ...envelope(r.chance(0.5) ? "ended" : "back", `end:${index}`, at), source: API, reports: [own.length === 0 ? report(key, T0).id : r.pick(own)] });
        break;
      default:
        events.push({ ...envelope("clock", `clock:${index}`, at), size: r.pick([-5 * MINUTE, 5 * MINUTE, HOUR]) });
    }
  }
  return events;
}

describe("the version of the fold (AL-105)", () => {
  it("pins the hash of the snapshot of each seeded log", () => {
    const contexts: readonly FoldContext[] = [{ sources: [], retention: {} }, { sources: [], retention: { horizon: 24 * HOUR, quiet: 3 * HOUR, life: 48 * HOUR, every: HOUR } }, { sources: [] }];
    const digests = ["a", "b", "c"].flatMap((seed) =>
      contexts.map((context) => {
        const entries = entryIndex();
        const events = seededLog(seed, 300);
        const state = rebuild(
          (function* () {
            for (const event of events) {
              entries.add(event);
              yield event;
            }
          })(),
          context,
          (merge) => entries.prune(merge),
        );
        return canonicalHash([...snapshotRows({ state, entries: entries.snapshot() })], { form: "json" });
      }),
    );
    expect(digests, `The digests of FOLD_VERSION ${String(FOLD_VERSION)}: ${JSON.stringify(digests)}`).toEqual(DIGESTS[FOLD_VERSION]);
  });
});
