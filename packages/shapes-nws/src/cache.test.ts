import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { memoryCache, openShapeCache, SHAPES_FILE, type ShapeCache } from "./cache.ts";
import type { CachedList, CachedZone, ZoneHead } from "./plan.ts";

const T0 = Date.UTC(2026, 10, 15, 18, 0, 0);
const LIST: CachedList = { state: "KS", kind: "county", fetched: T0, ids: ["KSC015", "KSC173"], condition: { etag: 'W/"1"', lastModified: "Thu, 16 Apr 2026 16:22:32 GMT", digest: "ab" } };
const RING = [
  [-97, 37],
  [-96, 37],
  [-96, 38],
  [-97, 37],
] as const;
const zone = (id: string, extra: Partial<CachedZone> = {}): CachedZone => ({ kind: "county", id, state: "KS", name: id, fetched: T0, shapes: [{ type: "polygon", rings: [RING] }], ...extra });
const head = (id: string, extra: Partial<CachedZone> = {}): ZoneHead => {
  const { shapes: _shapes, ...rest } = zone(id, extra);
  return rest;
};

let folders: string[] = [];
afterEach(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  folders = [];
});
const filePath = (): string => {
  const folder = mkdtempSync(join(tmpdir(), "alerts-shapes-"));
  folders.push(folder);
  return join(folder, "home", SHAPES_FILE);
};

/** The same checks for each kind of cache. */
function roundTrip(cache: ShapeCache): void {
  cache.putList(LIST, []);
  cache.putZone(zone("KSC015"));
  cache.putZone(zone("KSC173", { condition: { digest: "cd" } }));
  cache.putZone(zone("KSC173", { name: "Sedgwick", condition: { digest: "ef" } }));
  expect(cache.load()).toEqual({ lists: [LIST], zones: [head("KSC015"), head("KSC173", { name: "Sedgwick", condition: { digest: "ef" } })] });
  expect(cache.outline({ kind: "county", id: "KSC173" })).toEqual(zone("KSC173").shapes);
  expect(cache.outline({ kind: "forecast", id: "KSC173" })).toBeUndefined();
  cache.putList({ ...LIST, ids: ["KSC173"], fetched: T0 + 1 }, [{ kind: "county", id: "KSC015" }]);
  const after = cache.load();
  expect(after.lists).toEqual([{ ...LIST, ids: ["KSC173"], fetched: T0 + 1 }]);
  expect(after.zones.map((item) => item.id)).toEqual(["KSC173"]);
  expect(cache.outline({ kind: "county", id: "KSC015" })).toBeUndefined();
}

describe("memoryCache", () => {
  it("writes, replaces and removes records", () => {
    roundTrip(memoryCache());
  });
});

describe("openShapeCache", () => {
  it("writes, replaces and removes records, and keeps them after a new open", () => {
    const path = filePath();
    const cache = openShapeCache(path);
    expect(cache.quarantined).toBeUndefined();
    roundTrip(cache);
    cache.close();
    const again = openShapeCache(path);
    expect(again.load().zones.map((item) => item.name)).toEqual(["Sedgwick"]);
    again.close();
  });

  // A copy before AL-33 knows no kind `fire`. It skips each fire row of a newer copy this way, thus a rollback works.
  it("skips a row of a kind that it does not know, and gives no outline for shapes that do not parse", () => {
    const path = filePath();
    const cache = openShapeCache(path);
    cache.putZone(zone("KSC015"));
    cache.putZone(zone("KSC173"));
    cache.close();
    const db = new DatabaseSync(path);
    db.prepare("UPDATE zones SET shapes = '[' WHERE id = 'KSC015'").run();
    db.prepare("INSERT INTO lists (state, kind, fetched, ids) VALUES ('KS', 'marine', 1, '[]')").run();
    db.close();
    const again = openShapeCache(path);
    // The load reads no shapes (AL-115). The store drops the head at the first read of the outline.
    expect(again.load()).toEqual({ lists: [], zones: [head("KSC015"), head("KSC173")] });
    expect(again.outline({ kind: "county", id: "KSC015" })).toBeUndefined();
    expect(again.outline({ kind: "county", id: "KSC173" })).toEqual(zone("KSC173").shapes);
    again.close();
  });

  it("keeps the fire zones next to a forecast zone with the same code (AL-33)", () => {
    const path = filePath();
    const cache = openShapeCache(path);
    const forecast = { ...zone("KSZ083"), kind: "forecast" as const };
    const fire = { ...zone("KSZ083"), kind: "fire" as const, name: "Fire zone 83" };
    cache.putList({ state: "KS", kind: "fire", fetched: 1, ids: ["KSZ083"] }, []);
    cache.putZone(forecast);
    cache.putZone(fire);
    cache.close();
    const again = openShapeCache(path);
    const loaded = again.load();
    expect(loaded.lists).toEqual([{ state: "KS", kind: "fire", fetched: 1, ids: ["KSZ083"] }]);
    expect(loaded.zones.map((item) => `${item.kind}:${item.id}:${item.name}`).sort()).toEqual(["fire:KSZ083:Fire zone 83", "forecast:KSZ083:KSZ083"]);
    again.close();
  });

  it("moves a broken file into quarantine and starts empty", () => {
    const path = filePath();
    openShapeCache(path).close();
    writeFileSync(path, "This text is not a SQLite file. ".repeat(200));
    const cache = openShapeCache(path);
    expect(cache.quarantined).toBeTypeOf("string");
    expect(cache.load()).toEqual({ lists: [], zones: [] });
    cache.close();
  });
});
