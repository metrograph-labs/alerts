import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RegionCode } from "@mark1russell7/alerts";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { afterEach, describe, expect, it } from "vitest";
import { memoryCache, openShapeCache, SHAPES_FILE, type FileShapeCache, type ShapeCache } from "./cache.ts";
import { createShapeStore, HOST_RETRY_MS, RETRY_MS, type ShapeStoreOptions } from "./store.ts";

const BASE = "https://nws.test";
const T0 = Date.UTC(2026, 10, 15, 18, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const LATENCY = 200;
const KANSAS = { states: ["KS"] };
const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

/** This function gives the answer of a zone with a different code and name. The outline stays the outline of the fixture. */
function derived(name: string, id: string): string {
  const value = JSON.parse(fixture(name)) as { properties: Record<string, unknown> };
  value.properties["id"] = id;
  value.properties["name"] = `Zone ${id}`;
  return JSON.stringify(value);
}

/** This function gives the list of the forecast zones of the fixture as a list of fire zones, with these codes. */
function fireList(ids: readonly string[]): string {
  const value = JSON.parse(fixture("zones-KS-forecast.json")) as { features: { properties: Record<string, unknown> }[] };
  const [first] = value.features;
  value.features = ids.map((id) => ({ ...first!, properties: { ...first!.properties, id, type: "fire" } }));
  return JSON.stringify(value);
}

const reply = (body: string, status = 200, headers: Record<string, string> = {}): Reply => ({
  status,
  statusText: status === 200 ? "OK" : "Error",
  headers: { "content-type": "application/geo+json", ...headers },
  body,
});
const problem = (status: number, extra: Record<string, string> = {}): Reply => reply(JSON.stringify({ title: "Error", detail: `A fake error ${String(status)}.` }), status, { "content-type": "application/problem+json", ...extra });

type Route = Reply | ((exchange: Exchange) => Reply);

/** This function gives a route with an ETag. A request with the same ETag gets a 304 with no body. */
const tagged = (body: string, etag: string): Route => (exchange) =>
  exchange.headers["if-none-match"] === etag ? { status: 304, statusText: "Not Modified", headers: { etag }, body: "" } : reply(body, 200, { etag });

/**
 * The routes of a Kansas with three counties, three forecast zones and two fire zones. The fire zone `KSZ083` has the code
 * of a forecast zone. Its outline is a made-up change of the outline of the forecast zone.
 */
function kansas(): Record<string, Route> {
  return {
    "/zones?area=KS&type=county": tagged(fixture("zones-KS-county.json"), '"c1"'),
    "/zones?area=KS&type=forecast": tagged(fixture("zones-KS-forecast.json"), '"f1"'),
    "/zones?area=KS&type=fire": tagged(fireList(["KSZ083", "KSZ084"]), '"w1"'),
    "/zones/fire/KSZ083": reply(derived("zone-forecast-KSZ083.json", "KSZ083")),
    "/zones/fire/KSZ084": reply(derived("zone-forecast-KSZ083.json", "KSZ084")),
    "/zones/county/KSC173": tagged(fixture("zone-county-KSC173.json"), '"z173"'),
    "/zones/forecast/KSZ083": tagged(fixture("zone-forecast-KSZ083.json"), '"z083"'),
    "/zones/county/KSC015": reply(derived("zone-county-KSC173.json", "KSC015")),
    "/zones/county/KSC079": reply(derived("zone-county-KSC173.json", "KSC079")),
    "/zones/forecast/KSZ069": reply(derived("zone-forecast-KSZ083.json", "KSZ069")),
    "/zones/forecast/KSZ070": reply(derived("zone-forecast-KSZ083.json", "KSZ070")),
    "/zones/county/TXC167": reply(fixture("zone-county-TXC167-parts.json")),
  };
}

/** This function makes a store on a fake host. Each request takes `LATENCY` on the clock. A path with no route gets a 404. */
function setup(routes: Record<string, Route>, options: { cache?: ShapeCache } & Partial<ShapeStoreOptions> = {}) {
  let time = T0;
  const clock = { now: () => time, sleep: async (ms: number) => void (time += ms) };
  const sent: string[] = [];
  const transport: Transport = async (exchange) => {
    const path = exchange.url.slice(BASE.length);
    sent.push(path);
    time += LATENCY;
    const route = routes[path];
    if (route === undefined) return problem(404);
    return typeof route === "function" ? route(exchange) : route;
  };
  const cache = options.cache ?? memoryCache();
  const store = createShapeStore({ pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport, userAgent: "alerts-tests", baseUrl: BASE, ...options, cache });
  return { store, sent, cache, now: clock.now, advance: (ms: number) => void (time += ms) };
}

const FAR = T0 + 10 * DAY;
const codes = (store: ReturnType<typeof setup>["store"]): string[] => store.basemap("KS").map((region) => region.code.code);

describe("the store of the shapes", () => {
  it("gets the lists and then each zone of a state, and gives the basemap and the lookup", async () => {
    const { store, sent } = setup(kansas());
    expect(store.lookup({ system: "ugc", code: "KSC173" })).toBeUndefined();
    const result = await store.refresh({ wanted: KANSAS, until: FAR });
    expect(result).toMatchObject({ requests: 11, failures: [], problems: [], stop: "done" });
    expect(sent.slice(0, 3)).toEqual(["/zones?area=KS&type=county", "/zones?area=KS&type=forecast", "/zones?area=KS&type=fire"]);
    expect(codes(store)).toEqual(["KSC015", "KSC079", "KSC173", "KSZ069", "KSZ070", "KSZ083"]);
    expect(store.basemap("ks").find((region) => region.code.code === "KSC173")?.name).toBe("Sedgwick");
    expect(store.lookup({ system: "same", code: "020173" })).toBe(store.lookup({ system: "ugc", code: "ksc173" }));
    expect(store.lookup({ system: "ugc", code: "KSC173" })).toHaveLength(1);
    expect(store.basemap("XX")).toEqual([]);
    // A SAME code gives the region of its county, with the UGC code of the county.
    const sedgwick = store.region({ system: "same", code: "020173" });
    expect(sedgwick).toMatchObject({ code: { system: "ugc", code: "KSC173" }, name: "Sedgwick" });
    expect(sedgwick?.shapes).toBe(store.lookup({ system: "ugc", code: "KSC173" }));
    expect(store.region({ system: "ugc", code: "ksz083" })?.code).toEqual({ system: "ugc", code: "KSZ083" });
    expect(store.region({ system: "ugc", code: "TXC167" })).toBeUndefined();
    expect(store.region({ system: "state", code: "KS" })).toBeUndefined();
    // The fire zones are not in the basemap. They have their own regions, with the system ugc-fire (AL-33).
    expect(store.fireZones("ks").map((region) => region.code)).toEqual([
      { system: "ugc-fire", code: "KSZ083" },
      { system: "ugc-fire", code: "KSZ084" },
    ]);
    expect(store.region({ system: "ugc-fire", code: "ksz083" })).toMatchObject({ code: { system: "ugc-fire", code: "KSZ083" }, name: "Zone KSZ083" });
    expect(store.region({ system: "ugc", code: "KSZ083" })?.name).not.toBe("Zone KSZ083");
    expect(store.lookup({ system: "ugc-fire", code: "KSZ083" })).not.toBe(store.lookup({ system: "ugc", code: "KSZ083" }));
    expect(store.lookup({ system: "ugc-fire", code: "KSC173" })).toBeUndefined();
    expect(store.fireZones("XX")).toEqual([]);
    // The next task is the refresh of the first list, after 7 days.
    expect(result.next).toBe(store.nextDue(KANSAS));
    expect(result.next).toBeGreaterThan(T0 + 7 * DAY - 1);
  });

  it("gives no fire zone of a state until it has the outline of each fire zone of the list (AL-33)", async () => {
    const routes = kansas();
    delete routes["/zones/fire/KSZ084"];
    const { store } = setup(routes);
    await store.refresh({ wanted: KANSAS, until: FAR });
    expect(store.region({ system: "ugc-fire", code: "KSZ083" })?.code).toEqual({ system: "ugc-fire", code: "KSZ083" });
    // A place then gets no fire zone code of the state, and the match uses its forecast zone code.
    expect(store.fireZones("KS")).toEqual([]);
    expect(codes(store)).toHaveLength(6);
  });

  it("gets the zones of the wanted codes first, also in a state that is not wanted", async () => {
    const { store, sent } = setup(kansas());
    const wanted = { states: ["KS"], codes: [{ system: "ugc", code: "TXC167" }] satisfies RegionCode[] };
    await store.refresh({ wanted, until: FAR });
    expect(sent[0]).toBe("/zones/county/TXC167");
    expect(store.lookup({ system: "ugc", code: "TXC167" })).toHaveLength(3);
    expect(store.basemap("TX")).toEqual([]);
  });

  it("asks again after the refresh period with the validators, and keeps the shapes of a 304", async () => {
    const { store, sent, advance } = setup(kansas());
    await store.refresh({ wanted: KANSAS, until: FAR });
    const before = store.lookup({ system: "ugc", code: "KSC173" });
    expect(await store.refresh({ wanted: KANSAS, until: FAR })).toMatchObject({ requests: 0, stop: "done" });
    advance(7 * DAY);
    sent.length = 0;
    const again = await store.refresh({ wanted: KANSAS, until: FAR + 7 * DAY });
    expect(again).toMatchObject({ requests: 11, failures: [], stop: "done" });
    expect(store.lookup({ system: "ugc", code: "KSC173" })).toBe(before);
    expect(codes(store)).toHaveLength(6);
  });

  it("starts no request that can end after the time limit", async () => {
    const { store, now } = setup(kansas(), { minIntervalMs: 1000, timeoutMs: 15_000 });
    const tooSoon = await store.refresh({ wanted: KANSAS, until: T0 + 16_000 - 1 });
    expect(tooSoon).toMatchObject({ requests: 0, stop: "until", next: T0 });
    const until = T0 + 20_000;
    const some = await store.refresh({ wanted: KANSAS, until });
    expect(some.stop).toBe("until");
    expect(some.requests).toBeGreaterThan(0);
    expect(now()).toBeLessThanOrEqual(until);
  });

  it("stops at a failure of the host, and waits before its next request", async () => {
    const routes = { ...kansas(), "/zones?area=KS&type=forecast": problem(503) };
    const { store, now, advance } = setup(routes);
    const result = await store.refresh({ wanted: KANSAS, until: FAR });
    expect(result.stop).toBe("host");
    expect(result.failures).toEqual([{ task: "list:KS:forecast", failure: expect.objectContaining({ kind: "server" }) }]);
    expect(result.requests).toBe(2);
    expect(result.next).toBe(now() + HOST_RETRY_MS);
    expect(await store.refresh({ wanted: KANSAS, until: FAR })).toMatchObject({ requests: 0, stop: "done" });
    advance(HOST_RETRY_MS);
    expect(store.nextDue(KANSAS)).toBe(now());
  });

  it("waits longer when the host asks for it", async () => {
    const routes = { ...kansas(), "/zones?area=KS&type=county": problem(429, { "retry-after": "3600" }) };
    const { store, now } = setup(routes);
    const result = await store.refresh({ wanted: KANSAS, until: FAR });
    expect(result.stop).toBe("host");
    expect(result.next).toBeGreaterThanOrEqual(now() + 3_600_000);
  });

  it("skips a refused zone and a zone with a bad outline, and asks for them again after the retry wait", async () => {
    const bad = JSON.parse(fixture("zone-county-KSC173.json")) as { geometry: { coordinates: number[][][] } };
    bad.geometry.coordinates[0]!.pop();
    const routes: Record<string, Route> = { ...kansas(), "/zones/county/KSC173": reply(JSON.stringify(bad)) };
    delete routes["/zones/county/KSC015"];
    const { store, now } = setup(routes);
    const result = await store.refresh({ wanted: KANSAS, until: FAR });
    expect(result).toMatchObject({ requests: 11, stop: "done" });
    expect(result.failures).toEqual([{ task: "zone:county:KSC015", failure: expect.objectContaining({ kind: "refused", message: expect.stringContaining("A fake error 404.") }) }]);
    expect(result.problems).toEqual([expect.stringContaining("ring-not-closed")]);
    expect(codes(store)).toEqual(["KSC079", "KSZ069", "KSZ070", "KSZ083"]);
    expect(result.next).toBeLessThanOrEqual(now() + RETRY_MS);
    expect(result.next).toBeGreaterThan(now() + RETRY_MS - 10_000);
  });

  it("removes a zone that left a complete list, from the lookup, the basemap and the cache", async () => {
    const cache = memoryCache();
    const routes = kansas();
    const { store, advance } = setup(routes, { cache });
    await store.refresh({ wanted: KANSAS, until: FAR });
    const shorter = JSON.parse(fixture("zones-KS-county.json")) as { features: { properties: { id: string } }[] };
    shorter.features = shorter.features.filter((feature) => feature.properties.id !== "KSC015");
    routes["/zones?area=KS&type=county"] = reply(JSON.stringify(shorter));
    advance(7 * DAY);
    await store.refresh({ wanted: KANSAS, until: FAR + 7 * DAY });
    expect(store.lookup({ system: "ugc", code: "KSC015" })).toBeUndefined();
    expect(codes(store)).not.toContain("KSC015");
    expect(cache.load().zones.map((zone) => zone.id)).not.toContain("KSC015");
  });

  it("keeps the codes of the old list for a list that is not complete", async () => {
    const routes = kansas();
    const { store, advance } = setup(routes);
    await store.refresh({ wanted: KANSAS, until: FAR });
    const paged = JSON.parse(fixture("zones-KS-county.json")) as { features: { properties: { id: string } }[]; pagination?: unknown };
    paged.features = paged.features.filter((feature) => feature.properties.id === "KSC173");
    paged.pagination = { next: `${BASE}/zones?cursor=2` };
    routes["/zones?area=KS&type=county"] = reply(JSON.stringify(paged));
    advance(7 * DAY);
    const result = await store.refresh({ wanted: KANSAS, until: FAR + 7 * DAY });
    expect(result.problems).toEqual([expect.stringContaining("more pages")]);
    expect(codes(store)).toHaveLength(6);
  });

  it("starts from the records of its file after a restart, with no request", async () => {
    const folder = mkdtempSync(join(tmpdir(), "alerts-shapes-store-"));
    folders.push(folder);
    const path = join(folder, SHAPES_FILE);
    const first = setup(kansas(), { cache: openShapeCache(path) });
    await first.store.refresh({ wanted: KANSAS, until: FAR });
    const shape = first.store.lookup({ system: "ugc", code: "KSZ083" });
    first.cache.close();
    const second = setup(kansas(), { cache: openShapeCache(path) });
    expect(codes(second.store)).toHaveLength(6);
    expect(second.store.lookup({ system: "ugc", code: "KSZ083" })).toEqual(shape);
    expect(await second.store.refresh({ wanted: KANSAS, until: FAR })).toMatchObject({ requests: 0, stop: "done" });
    expect(second.sent).toEqual([]);
    second.cache.close();
  });

  describe("the shapes of the file (AL-115)", () => {
    /** This function gives a file cache with the records of one refresh of Kansas, and a count of its reads of shapes. */
    async function filled() {
      const folder = mkdtempSync(join(tmpdir(), "alerts-shapes-lazy-"));
      folders.push(folder);
      const path = join(folder, SHAPES_FILE);
      const first = setup(kansas(), { cache: openShapeCache(path) });
      await first.store.refresh({ wanted: KANSAS, until: FAR });
      first.cache.close();
      return path;
    }
    function counted(inner: FileShapeCache) {
      let reads = 0;
      const cache: ShapeCache = { ...inner, outline: (key) => ((reads += 1), inner.outline(key)) };
      return { cache, reads: () => reads, close: () => inner.close() };
    }

    it("reads no shapes at the start, reads the shapes of a zone at its first use, and keeps them", async () => {
      const file = counted(openShapeCache(await filled()));
      const { store } = setup(kansas(), { cache: file.cache });
      expect(file.reads()).toBe(0);
      const first = store.lookup({ system: "ugc", code: "KSZ083" });
      expect(first).toHaveLength(1);
      expect(file.reads()).toBe(1);
      expect(store.lookup({ system: "ugc", code: "KSZ083" })).toBe(first);
      expect(codes(store)).toHaveLength(6);
      expect(file.reads()).toBe(6);
      expect(store.region({ system: "ugc", code: "KSZ083" })?.shapes).toBe(first);
      expect(file.reads()).toBe(6);
      file.close();
    });

    it("does not keep the shapes of a zone that is not in use after a 304", async () => {
      const file = counted(openShapeCache(await filled()));
      const { store, advance } = setup(kansas(), { cache: file.cache });
      advance(8 * DAY);
      expect(await store.refresh({ wanted: KANSAS, until: FAR + 8 * DAY })).toMatchObject({ requests: 11, failures: [], stop: "done" });
      const after = file.reads();
      expect(store.lookup({ system: "ugc", code: "KSC173" })).toHaveLength(1);
      expect(file.reads()).toBe(after + 1);
      file.close();
    });

    it("asks again for a zone with shapes that do not parse in the file, with no validators", async () => {
      const path = await filled();
      const db = new DatabaseSync(path);
      db.prepare("UPDATE zones SET shapes = '[' WHERE id = 'KSC173'").run();
      db.close();
      const cache = openShapeCache(path);
      const { store, sent } = setup(kansas(), { cache });
      expect(store.lookup({ system: "ugc", code: "KSC173" })).toBeUndefined();
      expect(await store.refresh({ wanted: KANSAS, until: FAR })).toMatchObject({ requests: 1, failures: [], stop: "done" });
      expect(sent).toEqual(["/zones/county/KSC173"]);
      expect(store.lookup({ system: "ugc", code: "KSC173" })).toHaveLength(1);
      cache.close();
    });
  });

  it("refuses a second refresh during a refresh, and throws the reason of an abort", async () => {
    const { store } = setup(kansas());
    const running = store.refresh({ wanted: KANSAS, until: FAR });
    await expect(store.refresh({ wanted: KANSAS, until: FAR })).rejects.toThrow(/in progress/);
    await running;
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(store.refresh({ wanted: { states: ["TX"] }, until: FAR, signal: controller.signal })).rejects.toThrow("stop");
  });

  it("refuses a period that is not a positive number", () => {
    expect(() => setup(kansas(), { refreshMs: 0 })).toThrow(RangeError);
    expect(() => setup(kansas(), { retryMs: Number.NaN })).toThrow(/retryMs/);
  });
});

let folders: string[] = [];
afterEach(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  folders = [];
});
