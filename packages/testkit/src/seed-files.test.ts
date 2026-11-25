import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTransitCache } from "@mark1russell7/alerts-runtime";
import { openShapeCache, type ShapeRecords, type ZoneHead } from "@mark1russell7/alerts-shapes-nws";
import type { MapShape, Position } from "@mark1russell7/alerts";
import { CATALOG_COLUMNS, catalogFeeds } from "@mark1russell7/alerts-source-gtfs-alerts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEED_FORECAST_ZONES, seedShapes, seedTransit, TRANSIT_COLUMNS, type SeedShapesResult, type SeedTransitResult } from "./seed-files.ts";
import { seedStore } from "./seed-store.ts";

const SHAPES = 3_000_000;
const TRANSIT = 400_000;

let dir: string;
let shapes: SeedShapesResult;
let transit: SeedTransitResult;

function load(path: string): ShapeRecords {
  const cache = openShapeCache(path);
  try {
    return cache.load();
  } finally {
    cache.close();
  }
}

/** This function reads the head and the shapes of each zone. The load of the cache reads no shapes (AL-115). */
function loadOutlines(path: string): { readonly zone: ZoneHead; readonly shapes: readonly MapShape[] | undefined }[] {
  const cache = openShapeCache(path);
  try {
    return cache.load().zones.map((zone) => ({ zone, shapes: cache.outline(zone) }));
  } finally {
    cache.close();
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "seed-files-"));
  shapes = await seedShapes(join(dir, "a"), { bytes: SHAPES, seed: "al-103" });
  transit = await seedTransit(join(dir, "a"), { bytes: TRANSIT, seed: "al-103" });
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("seedShapes", () => {
  it("writes the cache to its size, and the cache of the runtime reads each record", () => {
    expect(shapes.bytes).toBeGreaterThanOrEqual(SHAPES);
    expect(shapes.bytes).toBeLessThan(SHAPES * 1.1);
    const records = load(shapes.path);
    expect(records.zones).toHaveLength(shapes.zones);
    expect(records.lists).toHaveLength(shapes.lists);
    for (const list of records.lists) expect(list.ids.length).toBeGreaterThan(0);
  });

  it("has made-up states, and closed rings", () => {
    const records = load(shapes.path);
    for (const { zone, shapes: outline } of loadOutlines(shapes.path)) {
      expect(zone.state).toMatch(/^[YZ][A-Z]$/u);
      expect(zone.id.startsWith(zone.state)).toBe(true);
      expect(outline).toBeDefined();
      for (const shape of outline ?? []) {
        if (shape.type !== "polygon") throw new Error("A seeded shape is a polygon.");
        const ring = shape.rings[0]!;
        expect(ring.length).toBeGreaterThanOrEqual(5);
        expect(ring.at(-1)).toEqual(ring[0]);
      }
    }
    const forecast = records.zones.filter((zone) => zone.state === "ZZ" && zone.kind === "forecast").map((zone) => zone.id);
    expect(forecast.length).toBeGreaterThan(0);
    for (const id of forecast) expect(Number(id.slice(3))).toBeLessThanOrEqual(SEED_FORECAST_ZONES);
  });

  it("gives the same records for the same seed", async () => {
    const again = await seedShapes(join(dir, "b"), { bytes: 1_000_000, seed: "al-103" });
    const other = await seedShapes(join(dir, "c"), { bytes: 1_000_000, seed: "al-103-other" });
    // A smaller size writes the first zones of a larger size. The load orders the zones by kind and code.
    const first = new Map(load(shapes.path).zones.map((zone) => [zone.id, zone]));
    const zones = load(again.path).zones;
    expect(zones).toHaveLength(again.zones);
    for (const zone of zones) expect(zone).toEqual(first.get(zone.id));
    expect(load(other.path).zones.filter((zone) => JSON.stringify(zone) === JSON.stringify(first.get(zone.id)))).toEqual([]);
  });
});

describe("seedTransit", () => {
  it("writes the copy to its size, and the cache of the runtime reads it", () => {
    expect(transit.bytes).toBeGreaterThanOrEqual(TRANSIT);
    expect(transit.bytes).toBeLessThan(TRANSIT + 1_000);
    const copy = openTransitCache(transit.path, (problem) => {
      throw new Error(problem);
    }).read();
    expect(copy?.condition?.digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("gives a catalog that the reader takes, at the rates of the live catalog", () => {
    const copy = openTransitCache(transit.path).read()!;
    for (const column of CATALOG_COLUMNS) expect(TRANSIT_COLUMNS).toContain(column);
    const read = catalogFeeds(copy.text);
    expect(read.problems).toEqual([]);
    expect(read.feeds.length + read.skipped.length).toBe(transit.alerts);
    expect(transit.alerts / transit.rows).toBeGreaterThan(0.04);
    expect(transit.alerts / transit.rows).toBeLessThan(0.09);
    expect(read.feeds.length / transit.alerts).toBeGreaterThan(0.6);
    expect(read.feeds.length / transit.alerts).toBeLessThan(0.82);
  });

  it("has no address and no host other than example.test", async () => {
    const text = await readFile(transit.path, "utf8");
    expect(text).not.toContain("@");
    const hosts = new Set([...text.matchAll(/https:\/\/([^/"\\,]+)/gu)].map((match) => match[1]));
    for (const host of hosts) expect(host).toMatch(/\.example\.test$/u);
  });

  it("gives the same file for the same seed", async () => {
    const again = await seedTransit(join(dir, "d"), { bytes: TRANSIT, seed: "al-103" });
    expect(await readFile(again.path, "utf8")).toBe(await readFile(transit.path, "utf8"));
  });

  it("adds the feeds near a point, and keeps the draws of the other rows", async () => {
    const at: Position = [-98.55, 28.3];
    const near = await seedTransit(join(dir, "near"), { bytes: TRANSIT, seed: "al-103", near: { at, feeds: 6 } });
    expect(near.near).toBe(6);
    const read = catalogFeeds(openTransitCache(near.path).read()!.text);
    expect(read.problems).toEqual([]);
    const ids = Array.from({ length: 6 }, (_, index) => `seed-near-${String(index + 1)}`);
    const found = read.feeds.filter((feed) => ids.includes(feed.id));
    expect(found.map((feed) => feed.id).sort()).toEqual([...ids].sort());
    for (const feed of found) {
      expect(feed.box.west).toBeLessThan(at[0]);
      expect(feed.box.east).toBeGreaterThan(at[0]);
      expect(feed.box.south).toBeLessThan(at[1]);
      expect(feed.box.north).toBeGreaterThan(at[1]);
    }
    expect(new Set(found.map((feed) => new URL(feed.url).host)).size).toBe(6);
    // The rows near the point take bytes of the size. Thus the other rows are the first rows of the plain file.
    const others = read.feeds.filter((feed) => !ids.includes(feed.id)).map((feed) => feed.id);
    const plain = catalogFeeds(openTransitCache(transit.path).read()!.text).feeds.map((feed) => feed.id);
    expect(others.length).toBeGreaterThan(0);
    expect(plain.slice(0, others.length)).toEqual(others);
    const text = await readFile(near.path, "utf8");
    for (const host of new Set([...text.matchAll(/https:\/\/([^/"\\,]+)/gu)].map((match) => match[1]))) expect(host).toMatch(/\.example\.test$/u);
  });

  it("refuses a count of the feeds near a point that is not a whole number", async () => {
    await expect(seedTransit(join(dir, "bad"), { bytes: TRANSIT, seed: 1, near: { at: [0, 0], feeds: 1.5 } })).rejects.toThrow(RangeError);
  });
});

describe("seedStore with the files", () => {
  it("writes the files with the fetch time of the end of the log", async () => {
    const result = await seedStore(join(dir, "e"), { log: 300_000, seed: 7, shapes: 400_000, transit: 50_000 });
    expect(result.shapes?.bytes).toBeGreaterThanOrEqual(400_000);
    expect(result.transit?.bytes).toBeGreaterThanOrEqual(50_000);
    for (const zone of load(result.shapes!.path).zones) expect(zone.fetched).toBe(result.end);
    expect(openTransitCache(result.transit!.path).read()?.fetched).toBe(result.end);
  });

  it("refuses a size that is not above 0", async () => {
    await expect(seedShapes(join(dir, "f"), { bytes: Number.NaN, seed: 1 })).rejects.toThrow(/not a finite number above 0/u);
    await expect(seedTransit(join(dir, "f"), { bytes: -1, seed: 1 })).rejects.toThrow(/not a finite number above 0/u);
  });
});
