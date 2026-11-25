import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportId, type Expectation, type ObservationId, type Report, type ReportId, type SourceDescriptor, type SourceId } from "@mark1russell7/alerts";
import { canonicalHash, random } from "@mark1russell7/rigor-generators";
import { afterEach, describe, expect, it } from "vitest";
import { entryIndex } from "./entries.ts";
import { envelope, type RuntimeEvent } from "./events.ts";
import { importOf, sharedItem } from "./exchange.ts";
import type { FoldSnapshot } from "@mark1russell7/sqlite";
import { contextKey, FOLD_VERSION, openStartSnapshot, openStartSnapshots, readSnapshot, snapshotFileName, START_SNAPSHOT_FILE, START_SNAPSHOTS_FOLDER, SNAPSHOT_UPGRADES, snapshotKey, snapshotRows, startReadText, type StartSnapshot } from "./start-snapshot.ts";
import { EMPTY_RUNTIME, fold, rebuild, type FoldContext, type RuntimeState } from "./state.ts";

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

  it("reads only the fields of a source that the fold reads (AL-156)", () => {
    const source: SourceDescriptor = { id: API, title: "A feed", origins: ["https://feed.example"], dependsOn: [], uses: ["internet"], kinds: ["met"], coverage: "global", transport: "poll", interval: MINUTE, slowAfter: 10_000, auth: "none" };
    const key = snapshotKey({ sources: [source] }, LOG);
    // A change of a field that the fold does not read keeps the key.
    for (const other of [{ ...source, title: "Another title" }, { ...source, kinds: ["met", "geo"] }, { ...source, origins: [] }, { ...source, canary: "x" }]) {
      expect(snapshotKey({ sources: [other] }, LOG)).toEqual(key);
    }
    // A change of a field that the fold reads changes it.
    for (const other of [{ ...source, interval: 2 * MINUTE }, { ...source, slowAfter: 20_000 }, { ...source, maxQuiet: HOUR }]) {
      expect(snapshotKey({ sources: [other] }, LOG)).not.toEqual(key);
    }
  });
});

describe("the line of the read of the log at a start (AL-105)", () => {
  it("tells the position of the snapshot, the fault of its read, or the fold of the whole log", () => {
    expect(startReadText({ events: 12, snapshot: { seq: 900, id: "e-900" } })).toBe("The start read the snapshot at the position 900 of the log, and it folded the 12 events after it.");
    expect(startReadText({ events: 12, snapshot: { seq: 900, id: "e-900" }, upgraded: 1 })).toBe("The start read the snapshot at the position 900 of the log, and it folded the 12 events after it. It upgraded the snapshot from the fold version 1.");
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

describe("the snapshots of the start, one for each key (AL-169)", () => {
  const log = { get: (id: string) => (id === "e-1" ? { seq: 1 } : undefined) };
  const mark = { seq: 1, id: "e-1" };
  const keyOf = (n: number) => ({ version: FOLD_VERSION, key: canonicalHash({ n }, { form: "json" }) });
  const readState = (store: FoldSnapshot, n: number) =>
    store.read(keyOf(n), log, (_mark, rows) => readSnapshot(rows).state);

  it("keeps the snapshot of one key when a start writes the snapshot of another key", () => {
    const home = mkdtempSync(join(tmpdir(), "alerts-snapshots-"));
    folders.push(home);
    const opened = openStartSnapshots(home);
    const store = opened.store;
    if (store === undefined) throw new Error("The store did not open.");
    try {
      // The good set has key 1, and a deploy gives key 2.
      store.write(keyOf(1), mark, snapshotRows(sample()));
      store.write(keyOf(2), mark, snapshotRows(sample()));
      expect(readState(store, 1)).toEqual(sample().state);
      expect(readState(store, 2)).toEqual(sample().state);
      expect(readState(store, 3)).toBeUndefined();
    } finally {
      store.close();
    }
    // A new open reads the two keys from their files.
    const again = openStartSnapshots(home).store;
    try {
      expect(again === undefined ? undefined : readState(again, 1)).toEqual(sample().state);
    } finally {
      again?.close();
    }
  });

  it("keeps the newest files of the keep count, and removes the oldest file", () => {
    const home = mkdtempSync(join(tmpdir(), "alerts-snapshots-"));
    folders.push(home);
    const store = openStartSnapshots(home, { keep: 2 }).store;
    if (store === undefined) throw new Error("The store did not open.");
    const folder = join(home, START_SNAPSHOTS_FOLDER);
    const age = (n: number, ms: number) => {
      const path = join(folder, snapshotFileName(keyOf(n)));
      const at = new Date(Date.now() - ms);
      for (const side of ["", "-wal"]) if (existsSync(path + side)) utimesSync(path + side, at, at);
    };
    try {
      store.write(keyOf(1), mark, snapshotRows(sample()));
      age(1, 3 * HOUR);
      store.write(keyOf(2), mark, snapshotRows(sample()));
      age(2, HOUR);
      // The write of key 3 keeps the newest other file, key 2, and removes the oldest file, key 1.
      store.write(keyOf(3), mark, snapshotRows(sample()));
      expect(readState(store, 1)).toBeUndefined();
      expect(readState(store, 2)).toEqual(sample().state);
      expect(readState(store, 3)).toEqual(sample().state);
      expect(readdirSync(folder).filter((name) => name.endsWith(".sqlite")).sort()).toEqual([snapshotFileName(keyOf(2)), snapshotFileName(keyOf(3))].sort());
    } finally {
      store.close();
    }
  });

  it("reads the file of an older runtime, and removes it after the keep count of new keys", () => {
    const home = mkdtempSync(join(tmpdir(), "alerts-snapshots-"));
    folders.push(home);
    const legacy = openStartSnapshot(join(home, START_SNAPSHOT_FILE)).store;
    legacy?.write(keyOf(1), mark, snapshotRows(sample()));
    legacy?.close();
    const old = new Date(Date.now() - 3 * HOUR);
    utimesSync(join(home, START_SNAPSHOT_FILE), old, old);
    for (const side of ["-wal"]) if (existsSync(join(home, START_SNAPSHOT_FILE + side))) utimesSync(join(home, START_SNAPSHOT_FILE + side), old, old);
    const store = openStartSnapshots(home, { keep: 2 }).store;
    if (store === undefined) throw new Error("The store did not open.");
    try {
      expect(readState(store, 1)).toEqual(sample().state);
      store.write(keyOf(2), mark, snapshotRows(sample()));
      // The keep of 2 counts the old file: it stays after one new key.
      expect(readState(store, 1)).toEqual(sample().state);
      store.write(keyOf(3), mark, snapshotRows(sample()));
      expect(readState(store, 1)).toBeUndefined();
      expect(existsSync(join(home, START_SNAPSHOT_FILE))).toBe(false);
    } finally {
      store.close();
    }
  });

  it("removes each snapshot at a clear, and writes again after it", () => {
    const home = mkdtempSync(join(tmpdir(), "alerts-snapshots-"));
    folders.push(home);
    const store = openStartSnapshots(home).store;
    if (store === undefined) throw new Error("The store did not open.");
    try {
      store.write(keyOf(1), mark, snapshotRows(sample()));
      store.write(keyOf(2), mark, snapshotRows(sample()));
      store.clear();
      expect(readState(store, 1)).toBeUndefined();
      expect(readState(store, 2)).toBeUndefined();
      store.write(keyOf(2), mark, snapshotRows(sample()));
      expect(readState(store, 2)).toEqual(sample().state);
    } finally {
      store.close();
    }
  });

  it("names the file of a key with the start of its hash, and hashes a key that is not a hash", () => {
    expect(snapshotFileName(keyOf(1))).toBe(`${keyOf(1).key.slice(0, 16)}.sqlite`);
    expect(snapshotFileName({ version: 1, key: "../not a hash" })).toMatch(/^[0-9a-f]{16}.sqlite$/u);
    // The version is not in the name: the read of an old fold for an upgrade finds the same file.
    expect(snapshotFileName({ ...keyOf(1), version: 1 })).toBe(snapshotFileName(keyOf(1)));
  });
});

/**
 * The gate of the version of the fold. The test folds seeded logs, and it pins the hash of the rows of each snapshot. A change of
 * the fold, of the form of the state or of the form of the rows changes a hash. Then the change raises `FOLD_VERSION` and pins the
 * new hashes, and each start ignores the snapshots of the old fold.
 */
const DIGESTS: Readonly<Record<number, readonly string[]>> = {
  1: [
    "eb8b5af3d14034645f27a9faadf3f723fc4def978157bb21de435c99ad34757e",
    "0e38293fc511add878f43d74ef3ae717322af6007a176ce77d06955e2a02a832",
    "a6af89a97795482aa68b68348c25e5763d165aa013ed9f8625bf031a2728443a",
    "3118de5c7fb0a2b2b8ca33898e4e62ec182b060fe53b132946148a2da3a1723a",
    "f0a775964463fb0e989ac5e14ea290205529a40dd7515c38926d1ebf1a32c23b",
    "09fb50e7c5ba249143897916722f8a4dd6e7aeb2651d94b42569ba5de44fe091",
    "d697353e33ce7d1c5f40927d74e75d67143fed88f7e6b124f3b6996a572ef67e",
    "ff62ec9f17935caa6c76a1b602e609aa4e00e419c42e6b9e1d0dd4c7eee1528f",
    "a433217afb26fe8b3380cc30154fe661ed2897d3dd4e77b26c12c1c0538805a2",
  ],
  2: [
    "d1a591b9261f7cd3bd1d6af2b4e2ab3c815812a9e73b442473570b443d12de1d",
    "ce9e3aa1a06a6c7b9157c1c132216efc1a3557de1e39496555f589207f1e4d4e",
    "75890383cfb4f381773541b34afca7c5eed12b6fb1e976551b594d29847116bb",
    "e664fc900fb57cbae22b938a87916db07f01573fd1ca5caf1ec91bce3830e1cf",
    "bfade8145362d938d08b31c4e7cbffda0c6c4232a4079e3b067d98dccf6181a7",
    "0a99d0eb9cf69a82ab8a21b4f06ea132e3611ff6560fb673d030b149cd754c50",
    "ccbee4225413f0ceefdf24aff8b27f2b8a9632b74179f1d6cc60f2912d212779",
    "19f892aac112680c4bf165f86f3e6b75410552fbacb20a80f142b1ca12154bab",
    "e929c3703c2d58fc5aa679c6d4401610af738a0de29fd99f51e23f4a9a8cab69",
  ],
  // Version 3 (AL-172) changes the retirement of an incident that a person knows. The seeded snapshots keep their rows.
  3: [
    "d1a591b9261f7cd3bd1d6af2b4e2ab3c815812a9e73b442473570b443d12de1d",
    "ce9e3aa1a06a6c7b9157c1c132216efc1a3557de1e39496555f589207f1e4d4e",
    "75890383cfb4f381773541b34afca7c5eed12b6fb1e976551b594d29847116bb",
    "e664fc900fb57cbae22b938a87916db07f01573fd1ca5caf1ec91bce3830e1cf",
    "bfade8145362d938d08b31c4e7cbffda0c6c4232a4079e3b067d98dccf6181a7",
    "0a99d0eb9cf69a82ab8a21b4f06ea132e3611ff6560fb673d030b149cd754c50",
    "ccbee4225413f0ceefdf24aff8b27f2b8a9632b74179f1d6cc60f2912d212779",
    "19f892aac112680c4bf165f86f3e6b75410552fbacb20a80f142b1ca12154bab",
    "e929c3703c2d58fc5aa679c6d4401610af738a0de29fd99f51e23f4a9a8cab69",
  ],
  // Version 4 (AL-187) changes only the retirement of a drill run. The seeded logs have no drill, thus the hashes stay.
  4: [
    "d1a591b9261f7cd3bd1d6af2b4e2ab3c815812a9e73b442473570b443d12de1d",
    "ce9e3aa1a06a6c7b9157c1c132216efc1a3557de1e39496555f589207f1e4d4e",
    "75890383cfb4f381773541b34afca7c5eed12b6fb1e976551b594d29847116bb",
    "e664fc900fb57cbae22b938a87916db07f01573fd1ca5caf1ec91bce3830e1cf",
    "bfade8145362d938d08b31c4e7cbffda0c6c4232a4079e3b067d98dccf6181a7",
    "0a99d0eb9cf69a82ab8a21b4f06ea132e3611ff6560fb673d030b149cd754c50",
    "ccbee4225413f0ceefdf24aff8b27f2b8a9632b74179f1d6cc60f2912d212779",
    "19f892aac112680c4bf165f86f3e6b75410552fbacb20a80f142b1ca12154bab",
    "e929c3703c2d58fc5aa679c6d4401610af738a0de29fd99f51e23f4a9a8cab69",
  ],
};
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

// The snapshot of the fold of each seeded log in each context of the gate.
function seededSnapshots(): StartSnapshot[] {
  const contexts: readonly FoldContext[] = [{ sources: [], retention: {} }, { sources: [], retention: { horizon: 24 * HOUR, quiet: 3 * HOUR, life: 48 * HOUR, every: HOUR } }, { sources: [] }];
  return ["a", "b", "c"].flatMap((seed) =>
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
        return { state, entries: entries.snapshot() };
      }),
  );
}

// True for a row of the blocks of the event loop, the part of the state that version 2 adds (AL-88).

describe("the version of the fold (AL-105)", () => {
  it("pins the hash of the snapshot of each seeded log", () => {
    const digests = seededSnapshots().map((snapshot) => canonicalHash([...snapshotRows(snapshot)], { form: "json" }));
    expect(digests, `The digests of FOLD_VERSION ${String(FOLD_VERSION)}: ${JSON.stringify(digests)}`).toEqual(DIGESTS[FOLD_VERSION]);
  });

  it("has no upgrade to version 3 or 4 of the fold (AL-153, AL-172, AL-187)", () => {
    expect(FOLD_VERSION, "A new version of the fold also changes SNAPSHOT_UPGRADES and this test.").toBe(4);
    // An upgrade gives a snapshot of FOLD_VERSION. A told incident of version 3 retires at another time, thus no upgrade gives its state.
    expect(Object.keys(SNAPSHOT_UPGRADES)).toEqual([]);
  });
});

describe("the fold under a write of the snapshot (AL-115)", () => {
  // The write of the snapshot reads the state over many pauses, and the passes fold new events in the pauses. Thus the
  // rows of the write are one cut of the state only when a fold gives a new state and does not change the state before it.
  it("does not change the state before it, for each event of each seeded log", () => {
    const contexts: readonly FoldContext[] = [{ sources: [], retention: {} }, { sources: [], retention: { horizon: 24 * HOUR, quiet: 3 * HOUR, life: 48 * HOUR, every: HOUR } }];
    const none = entryIndex().snapshot();
    const rowsOf = (state: RuntimeState): string => JSON.stringify([...snapshotRows({ state, entries: none })]);
    for (const seed of ["a", "b", "c"]) {
      for (const context of contexts) {
        let state = EMPTY_RUNTIME;
        for (const event of seededLog(seed, 300)) {
          const before = rowsOf(state);
          const next = fold(state, event, context);
          expect(rowsOf(state), `The fold of ${event.type} changed the state before it (seed ${seed}).`).toBe(before);
          state = next;
        }
      }
    }
  });
});

describe("the context key of a fold (AL-169)", () => {
  it("keeps the value of the snapshot key of AL-156: the snapshots of a live copy stay valid", () => {
    expect(snapshotKey({ sources: [], retention: {} }, { first: "event-1", recoveries: 2 }).key).toBe("b3d7dbe860c2cdfffe28ea9feb63778ece82eebae6d10fbef3f399af4e0aeeee");
  });

  it("reads no part of the log, and starts with the fold version", () => {
    const context = { sources: [], retention: {} };
    expect(contextKey(context)).toBe("3:7921159f7f68953ad57bbb40c564d533dd3118f51c812cd953fb82b4dd12c27b");
    expect(contextKey(context).startsWith(`${String(FOLD_VERSION)}:`)).toBe(true);
  });

  it("changes when the snapshot key changes on the same log", () => {
    const log = { first: "event-1", recoveries: 0 };
    const other = { sources: [], retention: { quiet: 6 * HOUR } };
    const base = { sources: [], retention: {} };
    expect(contextKey(other) === contextKey(base)).toBe(snapshotKey(other, log).key === snapshotKey(base, log).key);
    const linked = { ...base, link: { window: HOUR } as never };
    expect(contextKey(linked)).not.toBe(contextKey(base));
    expect(snapshotKey(linked, log).key).not.toBe(snapshotKey(base, log).key);
  });
});
