/**
 * This module holds the snapshot of the fold for a start (AL-105). The log keeps each event, thus the fold of the whole log
 * grows with the age of the log. A snapshot keeps the state and the entry index at one position of the log. The next start
 * reads the snapshot, and it folds only the events after that position.
 *
 * A snapshot is valid only for the same fold of the same log. Thus its key has these parts:
 *
 * - `FOLD_VERSION`. A change of the fold raises it. A gate test pins the digest of the fold of a seeded log for each version.
 * - The id of the first event of the log, and the count of its recoveries. A new log and a salvage give a new key.
 * - The hash of the context of the fold: the sources, the health options, the retention, the link policy and the expectations.
 *
 * The store of `@mark1russell7/sqlite` also checks that the log has the event of the mark at the position of the mark.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LINK_POLICY, healthSource, type Duration } from "@mark1russell7/alerts";
import { isRecord } from "@mark1russell7/optional/read";
import { canonicalHash } from "@mark1russell7/rigor-generators";
import { openFoldSnapshot, openOrQuarantine, type FoldKey, type FoldMark, type FoldRow, type FoldSnapshotFile, type Quarantined } from "@mark1russell7/sqlite";
import type { EntrySnapshot } from "./entries.ts";
import type { RuntimeEvent } from "./events.ts";
import { retention } from "./retention.ts";
import { withJoins, type FoldContext, type RuntimeState } from "./state.ts";

/**
 * The version of the fold. Raise it at each change of the fold of an event, of the form of the state or of the entry
 * index. Then a start ignores each snapshot of the old fold, and it folds the whole log. The gate test of the digests fails
 * until the change raises the version.
 */
export const FOLD_VERSION = 4;

/**
 * The upgrade of a snapshot of an old fold to the fold of `FOLD_VERSION`, with no fold of the log (AL-153). The field `since`
 * holds the event types that only the new fold reads. The upgrade is exact only when the log has no event of these types at or
 * before the mark of the snapshot. Then the two folds read the same events, and the upgrade adds the new parts of the state.
 */
export interface SnapshotUpgrade {
  readonly since: readonly RuntimeEvent["type"][];
  readonly upgrade: (snapshot: StartSnapshot) => StartSnapshot;
}

/**
 * The upgrades of the snapshots of old folds, by the version of the old fold. A start with no snapshot of `FOLD_VERSION` reads
 * the snapshot of an old fold with an upgrade. Thus a deploy that raises the version does not fold the whole log at its start.
 * A gate test pins each upgrade to the digests of the two versions.
 */
export const SNAPSHOT_UPGRADES: Readonly<Record<number, SnapshotUpgrade>> = {
  // Version 3 (AL-172) changes the retirement of an incident that a person knows. Only a fold of the log gives that state,
  // thus version 2 has no upgrade. The upgrade of version 1 (AL-88: the blocks of the event loop) gave version 2, not 3.
  // Version 4 (AL-187) keeps the incident of the last run of a drill. A snapshot of version 3 can hold that incident already
  // retired, thus version 3 has no upgrade.
};

/** The content of a snapshot: the state and the entry index at the position of its mark. */
export interface StartSnapshot {
  readonly state: RuntimeState;
  readonly entries: EntrySnapshot;
}

/** The facts of the log in the key of a snapshot. */
export interface SnapshotLog {
  /** The id of the first event of the log. */
  readonly first: string;
  /** The count of the `recovered` events of the log. */
  readonly recoveries: number;
}

/** This function gives the key of the snapshots of a fold context on a log. */
export function snapshotKey(context: FoldContext, log: SnapshotLog): FoldKey {
  // The canonical hash does not read the order of the fields. Thus the key has the same value as before `contextParts` (AL-169).
  return { version: FOLD_VERSION, key: canonicalHash({ first: log.first, recoveries: log.recoveries, ...contextParts(context) }, { form: "json" }) };
}

/**
 * This function gives the part of the key of a fold context with no part of the log (AL-169). Two builds with the same
 * context key give the same snapshot key on each log. Thus a stage compares the context keys of the two slots, and it tells
 * when the next start folds the whole log.
 */
export function contextKey(context: FoldContext): string {
  return `${String(FOLD_VERSION)}:${canonicalHash(contextParts(context), { form: "json" })}`;
}

// The parts of the key that the fold context gives.
function contextParts(context: FoldContext): Record<string, unknown> {
  return {
    // Only the fields that the fold reads (AL-156). Thus a change of the kinds or of the text of a source keeps the snapshot.
    sources: context.sources.map(healthSource),
    health: context.health ?? null,
    // The retention with its defaults. Thus a change of a default of the core gives a new key.
    retention: context.retention === undefined ? null : retention(context.retention),
    link: context.link ?? DEFAULT_LINK_POLICY,
    expectations: context.expectations ?? [],
  };
}

// The paths of the objects that the rows split into their fields. The fields of each other object go into one row each.
const NESTED = new Set(["state", "state.own", "state.imported", "state.own.merge", "state.imported.merge", "entries"]);
// The views of the two sides. The snapshot does not keep them, because `withJoins` gives them again.
const VIEWS = new Set(["state.merge", "state.escalationEnds"]);
// The prefix of the part of a row with a number that JSON does not keep.
const TAGGED = "~";
// The key of the tag of a number that JSON does not keep.
const NUMBER_TAG = "~number";

/**
 * This function gives the rows of a snapshot, one at a time. A list gives one row for each item, and an object of records
 * gives one row for each entry. Thus no row holds the text of the whole state.
 */
export function* snapshotRows(snapshot: StartSnapshot): Generator<FoldRow> {
  yield* rowsOf("state", snapshot.state);
  yield* rowsOf("entries", snapshot.entries);
}

/** This function gives the snapshot of rows of `snapshotRows`. It throws when a row is not in the form of `snapshotRows`. */
export function readSnapshot(rows: Iterable<FoldRow>): StartSnapshot {
  const root: Record<string, unknown> = {};
  for (const row of rows) {
    const tagged = row.part.startsWith(TAGGED);
    const part = tagged ? row.part.slice(TAGGED.length) : row.part;
    const value: unknown = tagged ? JSON.parse(row.value, untag) : JSON.parse(row.value);
    if (part.endsWith("[]")) {
      const list = at(root, part.slice(0, -2));
      if (!Array.isArray(list)) throw new Error(`The snapshot has an item of ${part.slice(0, -2)} before its list.`);
      list.push(value);
    } else if (part.endsWith("{}")) {
      const record = at(root, part.slice(0, -2));
      const [key, item] = Array.isArray(value) && value.length === 2 ? (value as unknown[]) : [];
      if (!isObject(record) || typeof key !== "string") throw new Error(`The snapshot has a bad entry of ${part.slice(0, -2)}.`);
      record[key] = item;
    } else put(root, part, value);
  }
  const { state, entries } = root;
  if (!isRecord(state) || !isRecord(entries)) throw new Error("The snapshot has no state or no entry index.");
  // The rows keep the form of the state and of the index, thus the casts hold for rows of `snapshotRows`.
  return { state: withJoins(state as unknown as Omit<RuntimeState, "merge" | "escalationEnds">), entries: entries as unknown as EntrySnapshot };
}

// The rows of one value at a path.
function* rowsOf(path: string, value: unknown): Generator<FoldRow> {
  if (VIEWS.has(path) || value === undefined) return;
  if (Array.isArray(value)) {
    yield { part: path, value: "[]" };
    for (const item of value) yield rowOf(`${path}[]`, item);
  } else if (isPlain(value) && NESTED.has(path)) {
    yield { part: path, value: "{}" };
    for (const [key, field] of Object.entries(value)) yield* rowsOf(`${path}.${key}`, field);
  } else if (isPlain(value)) {
    yield { part: path, value: "{}" };
    for (const entry of Object.entries(value)) if (entry[1] !== undefined) yield rowOf(`${path}{}`, entry);
  } else yield rowOf(path, value);
}

// The row of one value. A value with an infinite number, NaN or -0 gets a tag for each such number.
function rowOf(part: string, value: unknown): FoldRow {
  let odd = false;
  const text: string | undefined = JSON.stringify(value, function (this: unknown, _key: string, item: unknown): unknown {
    checkValue(this, item);
    if (isOdd(item)) odd = true;
    return item;
  });
  // JSON gives no text for an undefined value, a function or a symbol.
  if (text === undefined) throw new TypeError("A snapshot keeps only JSON data, and the state has a value with no JSON text.");
  if (!odd) return { part, value: text };
  return { part: `${TAGGED}${part}`, value: JSON.stringify(value, (_key, item: unknown) => (isOdd(item) ? { [NUMBER_TAG]: Object.is(item, -0) ? "-0" : String(item) } : item)) };
}

// A number that JSON does not keep: JSON writes `null` for an infinite number and NaN, and 0 for -0.
const isOdd = (item: unknown): item is number => typeof item === "number" && (!Number.isFinite(item) || Object.is(item, -0));

// JSON keeps no map, no set and no function, and it writes `null` for an undefined item of a list. A state has none of them.
function checkValue(holder: unknown, item: unknown): void {
  if (item instanceof Map || item instanceof Set || typeof item === "function" || typeof item === "symbol") throw new TypeError("A snapshot keeps only JSON data, and the state has a value of another kind.");
  if (item === undefined && Array.isArray(holder)) throw new TypeError("A snapshot keeps only JSON data, and the state has a list with an undefined item.");
}

// The number of a tag of `rowOf`.
function untag(_key: string, item: unknown): unknown {
  if (isRecord(item) && typeof item[NUMBER_TAG] === "string" && Object.keys(item).length === 1) return Number(item[NUMBER_TAG]);
  return item;
}

// A plain object: not a list, and not an instance of a class.
function isPlain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// The value at a path of field names.
function at(root: Record<string, unknown>, path: string): unknown {
  let value: unknown = root;
  for (const key of path.split(".")) value = isRecord(value) ? value[key] : undefined;
  return value;
}

// The rows come from JSON.parse, thus each object of the read is a plain object that the read can change.
const isObject = (value: unknown): value is Record<string, unknown> => isRecord(value);

// This function puts a value at a path of field names. The objects of the path come before it in the rows.
function put(root: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop() as string;
  const holder = keys.length === 0 ? root : at(root, keys.join("."));
  if (!isObject(holder)) throw new Error(`The snapshot has the part ${path} before its object.`);
  holder[last] = value;
}

/** The time between two writes of the snapshot of the start by the instance: 30 minutes of the wall clock. */
export const START_SNAPSHOT_EVERY: Duration = 30 * 60_000;

/**
 * The least count of new events of the log since the last snapshot for a write of the instance (AL-115). In CI, a start
 * folds 136924 events in 3.2 s to 4.8 s, thus it folds 500 events in less than 20 ms. The read of a snapshot takes 0.5 s to 0.8 s.
 */
export const START_SNAPSHOT_FLOOR = 500;

/** The name of the file of the snapshot of the start of an older runtime in the home folder, next to the log. The store reads it (AL-169). */
export const START_SNAPSHOT_FILE = "snapshot.sqlite";

/** The read of the log at the open of a runtime (AL-105). */
export interface StartRead {
  /** The mark of the snapshot that the open read. It is undefined when the open folded the whole log. */
  readonly snapshot?: FoldMark;
  /** The count of the events that the open folded. */
  readonly events: number;
  /** The name of the error of the read of the snapshot. Then the open folded the whole log. */
  readonly fault?: string;
  /** The version of the old fold of the snapshot that the open upgraded (AL-153). It is undefined for a snapshot of `FOLD_VERSION`. */
  readonly upgraded?: number;
}

/** This function gives the line of the output for the read of the log at a start. The line has counts and positions only. */
export function startReadText(start: StartRead): string {
  const folded = `${String(start.events)} events`;
  const upgraded = start.upgraded === undefined ? "" : ` It upgraded the snapshot from the fold version ${String(start.upgraded)}.`;
  if (start.snapshot !== undefined) return `The start read the snapshot at the position ${String(start.snapshot.seq)} of the log, and it folded the ${folded} after it.${upgraded}`;
  if (start.fault !== undefined) return `The read of the snapshot failed (${start.fault}). The start folded the ${folded} of the whole log.`;
  return `The start had no snapshot of this log and of this configuration. It folded the ${folded} of the whole log.`;
}

/** The store of the snapshot of the start in its file. */
export interface OpenedStartSnapshot {
  /** The store. It is undefined when the file did not open. Then each start folds the whole log. */
  readonly store?: FoldSnapshotFile;
  /** The quarantine of a broken file. Then the store starts empty, and the next start folds the whole log. */
  readonly quarantined?: Quarantined;
  /** The name of the error of a file that did not open. */
  readonly fault?: string;
}

/**
 * This function opens the file of the snapshot of the start. A broken file goes into quarantine, and the store starts empty.
 * The file is a copy of a fold of the log, thus the loss of the file loses no event. The function does not throw.
 */
export function openStartSnapshot(path: string): OpenedStartSnapshot {
  try {
    const { value: store, quarantined } = openOrQuarantine(path, (file) => openFoldSnapshot(file, { wal: true, synchronous: "NORMAL", busyTimeoutMs: 5000, makeFolder: true }));
    return quarantined === undefined ? { store } : { store, quarantined };
  } catch (error) {
    return { fault: error instanceof Error ? error.name : typeof error };
  }
}

/**
 * The name of the folder of the snapshots of the start in the home folder (AL-169). The folder has one file for each key of
 * a fold. Thus the snapshot of one set of private files stays when a start uses another set.
 */
export const START_SNAPSHOTS_FOLDER = "snapshots";

/**
 * The count of the keys that the folder of the snapshots keeps (AL-169). A deploy gives a new key, and the last good set has
 * the key of the set before it. Thus three files keep the snapshot of each set that a start can use, and one more.
 */
export const START_SNAPSHOT_KEEP = 3;

/** The options of `openStartSnapshots`. */
export interface StartSnapshotsOptions {
  /** This value is the count of the keys that the folder keeps: a whole number of 1 or more. The default is `START_SNAPSHOT_KEEP`. */
  readonly keep?: number;
  /** The store calls this function for each broken file that goes into quarantine. */
  readonly onQuarantine?: (quarantined: Quarantined) => void;
}

/** This function gives the name of the file of the snapshots of a key in the folder of the snapshots. */
export function snapshotFileName(key: FoldKey): string {
  const text = /^[0-9a-f]{16,}$/u.test(key.key) ? key.key : canonicalHash({ key: key.key }, { form: "json" });
  return `${text.slice(0, 16)}.sqlite`;
}

const SNAPSHOT_OPTIONS = { wal: true, synchronous: "NORMAL", busyTimeoutMs: 5000, makeFolder: true } as const;
// The files of SQLite next to a database file.
const SIDE_FILES = ["", "-wal", "-shm", "-journal"];

/**
 * This function opens the snapshots of the start in the home folder (AL-169). The store keeps the newest snapshot of each key
 * in its own file of the folder `START_SNAPSHOTS_FOLDER`, and the newest `keep` files. The file of a key does not hold the
 * version of the fold in its name. Thus the read of an old fold for an upgrade (AL-153) finds it.
 *
 * The file `START_SNAPSHOT_FILE` of an older runtime is one more file for the reads. The keep counts it, thus the store
 * removes it after `keep` writes of other keys. A broken file goes into quarantine. The function does not throw.
 */
export function openStartSnapshots(home: string, options: StartSnapshotsOptions = {}): OpenedStartSnapshot {
  const legacyPath = join(home, START_SNAPSHOT_FILE);
  const legacy = existsSync(legacyPath) ? openStartSnapshot(legacyPath) : {};
  if (legacy.quarantined !== undefined) options.onQuarantine?.(legacy.quarantined);
  try {
    const store = keyedSnapshots(join(home, START_SNAPSHOTS_FOLDER), legacy.store === undefined ? undefined : { path: legacyPath, store: legacy.store }, options);
    return legacy.quarantined === undefined ? { store } : { store, quarantined: legacy.quarantined };
  } catch (error) {
    legacy.store?.close();
    return { fault: error instanceof Error ? error.name : typeof error };
  }
}

interface OpenFile {
  readonly path: string;
  readonly store: FoldSnapshotFile;
}

function keyedSnapshots(folder: string, legacy: OpenFile | undefined, options: StartSnapshotsOptions): FoldSnapshotFile {
  const keep = options.keep ?? START_SNAPSHOT_KEEP;
  if (!Number.isInteger(keep) || keep < 1) throw new RangeError("The store keeps 1 or more keys.");
  mkdirSync(folder, { recursive: true });
  const files = new Map<string, OpenFile>();
  let old = legacy;
  const fileOf = (key: FoldKey, make: boolean): FoldSnapshotFile | undefined => {
    const path = join(folder, snapshotFileName(key));
    const known = files.get(path);
    if (known !== undefined) return known.store;
    if (!make && !existsSync(path)) return undefined;
    const { value: store, quarantined } = openOrQuarantine(path, (file) => openFoldSnapshot(file, SNAPSHOT_OPTIONS));
    if (quarantined !== undefined) options.onQuarantine?.(quarantined);
    files.set(path, { path, store });
    return store;
  };
  const drop = (file: OpenFile): void => {
    file.store.close();
    for (const side of SIDE_FILES) rmSync(`${file.path}${side}`, { force: true });
  };
  // The newest `keep` files stay: the file of the last write, and the files with the newest changes.
  const prune = (written: string): void => {
    const candidates = readdirSync(folder)
      .filter((name) => name.endsWith(".sqlite"))
      .map((name) => join(folder, name));
    if (old !== undefined) candidates.push(old.path);
    const others = candidates.filter((path) => path !== written).sort((left, right) => changedAt(right) - changedAt(left));
    for (const path of others.slice(keep - 1)) {
      if (old?.path === path) {
        drop(old);
        old = undefined;
        continue;
      }
      const open = files.get(path);
      files.delete(path);
      if (open !== undefined) drop(open);
      else for (const side of SIDE_FILES) rmSync(`${path}${side}`, { force: true });
    }
  };
  const closeAll = (): void => {
    for (const file of files.values()) file.store.close();
    files.clear();
    old?.store.close();
  };
  return {
    read(key, log, work) {
      const own = fileOf(key, false)?.read(key, log, work);
      return own !== undefined ? own : old?.store.read(key, log, work);
    },
    write(key, mark, rows) {
      const count = (fileOf(key, true) as FoldSnapshotFile).write(key, mark, rows);
      prune(join(folder, snapshotFileName(key)));
      return count;
    },
    async writeInChunks(key, mark, rows, chunks) {
      const count = await (fileOf(key, true) as FoldSnapshotFile).writeInChunks(key, mark, rows, chunks);
      prune(join(folder, snapshotFileName(key)));
      return count;
    },
    clear() {
      for (const file of files.values()) drop(file);
      files.clear();
      for (const name of readdirSync(folder)) rmSync(join(folder, name), { force: true });
      old?.store.clear();
    },
    close: closeAll,
  };
}

// The time of the last change of a database file: its own time or the time of its WAL file, the newest of the two.
function changedAt(path: string): number {
  let newest = 0;
  for (const side of ["", "-wal"]) {
    try {
      newest = Math.max(newest, statSync(`${path}${side}`).mtimeMs);
    } catch {
      // A missing file has no time.
    }
  }
  return newest;
}
