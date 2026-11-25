/**
 * This module holds the cache of the store: a port, a cache in memory for the tests, and a cache in a
 * SQLite file. The instance keeps the file in its home folder, outside each repository. The records
 * come again from the NWS API, thus a broken file goes into quarantine, and the store starts empty.
 */
import type { DatabaseSync } from "node:sqlite";
import type { MapShape } from "@mark1russell7/alerts";
import { migrate, openDatabase, openOrQuarantine, transaction, type Migration } from "@mark1russell7/sqlite";
import type { Condition } from "polite-crawler/api";
import { listKey, zoneKey, type CachedList, type CachedZone, type ZoneHead } from "./plan.ts";
import { ZONE_KINDS, type ZoneKey, type ZoneKind } from "./zones.ts";

/** The name of the file of the cache in the home folder of the instance. */
export const SHAPES_FILE = "shapes.sqlite";

/** The records of a cache. The zones are heads: their shapes stay in the cache until a read of `outline`. */
export interface ShapeRecords {
  readonly lists: readonly CachedList[];
  readonly zones: readonly ZoneHead[];
}

/**
 * The port of the cache of the store. The store reads the lists and the heads of the zones once at the start. It reads the
 * shapes of a zone at its first use (AL-115), and then it writes each change.
 */
export interface ShapeCache {
  /** This function reads each list and the head of each zone, with no shapes. */
  load(): ShapeRecords;
  /** This function reads the shapes of a zone. It gives `undefined` for a zone with no record, or with shapes that do not parse. */
  outline(key: ZoneKey): readonly MapShape[] | undefined;
  /** This function writes a list and removes the zones that the list removes, in one transaction. */
  putList(list: CachedList, drops: readonly ZoneKey[]): void;
  /** This function writes a zone. */
  putZone(zone: CachedZone): void;
  close(): void;
}

/** The records of a cache in memory: the zones have their shapes. */
export interface MemoryRecords {
  readonly lists: readonly CachedList[];
  readonly zones: readonly CachedZone[];
}

/** This function gives the head of a zone: the record with no shapes. */
const headOf = ({ shapes: _shapes, ...head }: CachedZone): ZoneHead => head;

/** This function makes a cache in memory. The records go when the process stops. */
export function memoryCache(records: MemoryRecords = { lists: [], zones: [] }): ShapeCache {
  const lists = new Map(records.lists.map((list) => [listKey(list.state, list.kind), list]));
  const zones = new Map(records.zones.map((zone) => [zoneKey(zone), zone]));
  return {
    load: () => ({ lists: [...lists.values()], zones: [...zones.values()].map(headOf) }),
    outline: (key) => zones.get(zoneKey(key))?.shapes,
    putList(list, drops) {
      lists.set(listKey(list.state, list.kind), list);
      for (const drop of drops) zones.delete(zoneKey(drop));
    },
    putZone: (zone) => void zones.set(zoneKey(zone), zone),
    close: () => undefined,
  };
}

/** The migrations of the file. The cache owns each table of the file. */
const MIGRATIONS: readonly Migration[] = [
  `CREATE TABLE lists (
     state TEXT NOT NULL, kind TEXT NOT NULL, fetched INTEGER NOT NULL, ids TEXT NOT NULL,
     etag TEXT, last_modified TEXT, digest TEXT,
     PRIMARY KEY (state, kind)
   ) STRICT;
   CREATE TABLE zones (
     kind TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL, name TEXT NOT NULL, fetched INTEGER NOT NULL, shapes TEXT NOT NULL,
     etag TEXT, last_modified TEXT, digest TEXT,
     PRIMARY KEY (kind, id)
   ) STRICT;`,
];

/** The cache in a SQLite file. */
export interface FileShapeCache extends ShapeCache {
  /** The folder of the quarantine when the file was broken at the open, or `undefined`. */
  readonly quarantined: string | undefined;
}

type Row = Readonly<Record<string, unknown>>;

const isKind = (value: unknown): value is ZoneKind => ZONE_KINDS.includes(value as ZoneKind);
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** This function reads the validators of a row. A row with no digest has no validators. */
function conditionOf(row: Row): { readonly condition?: Condition } {
  const digest = text(row["digest"]);
  if (digest === undefined) return {};
  const etag = text(row["etag"]);
  const lastModified = text(row["last_modified"]);
  return { condition: { digest, ...(etag === undefined ? {} : { etag }), ...(lastModified === undefined ? {} : { lastModified }) } };
}

/** This function parses a JSON text of the file. It gives `undefined` for a text that is not JSON. */
function parseStored(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // The load skips the row. The next refresh asks for it again.
    return undefined;
  }
}

/** This function reads a row of the table `lists`, or gives `undefined` for a row with a problem. */
function listOf(row: Row): CachedList | undefined {
  const ids = parseStored(row["ids"]);
  const { state, kind, fetched } = row;
  if (typeof state !== "string" || !isKind(kind) || typeof fetched !== "number" || !Array.isArray(ids) || !ids.every((id) => typeof id === "string")) return undefined;
  return { state, kind, fetched, ids: ids as string[], ...conditionOf(row) };
}

/** This function reads the head of a row of the table `zones`, or gives `undefined` for a row with a problem. */
function headOfRow(row: Row): ZoneHead | undefined {
  const { kind, id, state, name, fetched } = row;
  if (!isKind(kind) || typeof id !== "string" || typeof state !== "string" || typeof name !== "string" || typeof fetched !== "number") return undefined;
  return { kind, id, state, name, fetched, ...conditionOf(row) };
}

/** This function gives the columns of the validators of a record. */
const validators = (condition: Condition | undefined) => ({
  etag: condition?.etag ?? null,
  last_modified: condition?.lastModified ?? null,
  digest: condition?.digest ?? null,
});

/**
 * This function opens the cache in a SQLite file, and makes its folder. A file that does not open goes
 * into quarantine, and the cache starts empty. The file is in WAL mode with `synchronous` at `NORMAL`.
 * A crash can lose the last writes, and the next refresh gets them again.
 */
export function openShapeCache(path: string): FileShapeCache {
  const open = (file: string): DatabaseSync => {
    const db = openDatabase(file, { wal: true, synchronous: "NORMAL", busyTimeoutMs: 5000, makeFolder: true });
    try {
      migrate(db, MIGRATIONS);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  };
  const { value: db, quarantined } = openOrQuarantine(path, open);
  const putList = db.prepare(
    `INSERT INTO lists (state, kind, fetched, ids, etag, last_modified, digest) VALUES ($state, $kind, $fetched, $ids, $etag, $last_modified, $digest)
     ON CONFLICT (state, kind) DO UPDATE SET fetched = excluded.fetched, ids = excluded.ids, etag = excluded.etag, last_modified = excluded.last_modified, digest = excluded.digest`,
  );
  const putZone = db.prepare(
    `INSERT INTO zones (kind, id, state, name, fetched, shapes, etag, last_modified, digest) VALUES ($kind, $id, $state, $name, $fetched, $shapes, $etag, $last_modified, $digest)
     ON CONFLICT (kind, id) DO UPDATE SET state = excluded.state, name = excluded.name, fetched = excluded.fetched, shapes = excluded.shapes,
       etag = excluded.etag, last_modified = excluded.last_modified, digest = excluded.digest`,
  );
  const dropZone = db.prepare("DELETE FROM zones WHERE kind = $kind AND id = $id");
  let closed = false;
  const getShapes = db.prepare("SELECT shapes FROM zones WHERE kind = $kind AND id = $id");
  return {
    quarantined: quarantined?.folder,
    load() {
      const lists = (db.prepare("SELECT * FROM lists ORDER BY state, kind").all() as Row[]).flatMap((row) => listOf(row) ?? []);
      // The load reads no shapes: the parsed shapes of each zone were 215 MB of the heap at the start (AL-115).
      const columns = "kind, id, state, name, fetched, etag, last_modified, digest";
      const zones = (db.prepare(`SELECT ${columns} FROM zones ORDER BY kind, id`).all() as Row[]).flatMap((row) => headOfRow(row) ?? []);
      return { lists, zones };
    },
    outline(key) {
      // A read after the close gives no shapes. Thus a late request of the map does not throw.
      if (closed) return undefined;
      const row = getShapes.get({ kind: key.kind, id: key.id }) as Row | undefined;
      const shapes = parseStored(row?.["shapes"]);
      return Array.isArray(shapes) ? (shapes as MapShape[]) : undefined;
    },
    putList(list, drops) {
      transaction(db, () => {
        putList.run({ state: list.state, kind: list.kind, fetched: list.fetched, ids: JSON.stringify(list.ids), ...validators(list.condition) });
        for (const drop of drops) dropZone.run({ kind: drop.kind, id: drop.id });
      });
    },
    putZone(zone) {
      putZone.run({ kind: zone.kind, id: zone.id, state: zone.state, name: zone.name, fetched: zone.fetched, shapes: JSON.stringify(zone.shapes), ...validators(zone.condition) });
    },
    close() {
      closed = true;
      db.close();
    },
  };
}
