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
export const FOLD_VERSION = 3;

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
  const parts = {
    first: log.first,
    recoveries: log.recoveries,
    // Only the fields that the fold reads (AL-156). Thus a change of the kinds or of the text of a source keeps the snapshot.
    sources: context.sources.map(healthSource),
    health: context.health ?? null,
    // The retention with its defaults. Thus a change of a default of the core gives a new key.
    retention: context.retention === undefined ? null : retention(context.retention),
    link: context.link ?? DEFAULT_LINK_POLICY,
    expectations: context.expectations ?? [],
  };
  return { version: FOLD_VERSION, key: canonicalHash(parts, { form: "json" }) };
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

/** The name of the file of the snapshot of the start in the home folder, next to the log. */
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
