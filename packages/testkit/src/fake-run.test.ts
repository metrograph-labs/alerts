import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Incident } from "@mark1russell7/alerts";
import { openMeasuredRuntime, type MeasuredRuntime } from "@mark1russell7/alerts-runtime";
import { SOURCE_ID as NWS_ID } from "@mark1russell7/alerts-source-nws-api";
import { fakeWallClock } from "@mark1russell7/algebra/clock";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeChannels, type FakeChannels } from "./fake-channels.ts";
import { createFakeFeeds, type FakeFeeds } from "./fake-feeds.ts";
import { startFake, type FakeServer } from "./fake-server.ts";
import { MEASURE_PLACE, readSeedRecord, seedHome } from "./seed-home.ts";

const MINUTE = 60_000;
const LEVELS = { feeds: 2, persons: 2, incidents: 0 };
const UGC = MEASURE_PLACE.codes.find((code) => code.system === "ugc")!.code;

let dir: string;
let home: string;
let feeds: FakeFeeds;
let channels: FakeChannels;
const servers: FakeServer[] = [];
// The fetch of the platform reaches only the fakes. A request to another host fails, and the test counts it.
const realFetch = globalThis.fetch;
const outside: string[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "fake-run-"));
  home = join(dir, "home");
  await seedHome(home, { log: 300_000, seed: "al-131", files: { shapes: 1_000_000, transit: 400_000 }, levels: LEVELS });
  const { end } = readSeedRecord(home);
  // The load starts 10 minutes before the end of the seeded log. Thus the first fetch of the NWS source has alerts and updates.
  feeds = createFakeFeeds({
    streams: [
      { kind: "event", perSecond: 1 / 60, eventBytes: 400 },
      { kind: "update", perSecond: 1 / 23, eventBytes: 300 },
    ],
    start: end - 10 * MINUTE,
    seed: "al-131",
  });
  channels = createFakeChannels();
  servers.push(await startFake(feeds.handler), await startFake(channels.handler));
  vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const text = url instanceof Request ? url.url : String(url);
    if (servers.some((server) => text.startsWith(`${server.url}/`))) return realFetch(url, init);
    outside.push(text);
    return Promise.reject(new TypeError("This test reaches only the fakes."));
  });
}, 180_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const server of servers) await server.close();
  await rm(dir, { recursive: true, force: true });
});

/** The live incidents of the hazards at the place: the alerts of the fake. The incidents of the system are not hazards. */
const hazards = (incidents: readonly Incident[]): readonly Incident[] =>
  incidents.filter((incident) => incident.live && !incident.kind.code.startsWith("system.") && incident.areas.some((area) => area.type === "code" && area.code === UGC));

describe("a measured start with the fakes", { timeout: 120_000 }, () => {
  it("gets the alerts of the fake of the feeds, and sends their messages to the fake of the channels", async () => {
    const record = readSeedRecord(home);
    const [feedsServer, channelsServer] = servers;
    // The instance makes a frame clock on the wall clock and the monotonic clock. A set of the wall clock in a start is a step
    // of the clock, and the runtime moves its times by the step. Thus the time of the test goes on only between two starts.
    const start = (at: number): Promise<MeasuredRuntime> =>
      openMeasuredRuntime(home, {
        wall: fakeWallClock(at),
        startSnapshot: true,
        transitLimit: LEVELS.feeds,
        services: { feeds: feedsServer!.url, channels: channelsServer!.url },
      });
    let measured: MeasuredRuntime | undefined;
    try {
      // The last fetch of the NWS source in the seeded log is at the end of the log or before it. One minute after the end, it is due.
      measured = await start(record.end + MINUTE);
      const pass = measured.first;
      expect(pass.fetched).toContain(NWS_ID);
      const counts = feeds.counts();
      expect(counts.answers).toBeGreaterThan(0);
      expect(counts.updates).toBeGreaterThan(0);
      // Each alert is one incident: the updates join the incident of their alert.
      expect(hazards(pass.view.incidents)).toHaveLength(counts.events);
      const routes = (pass.delivery?.routes ?? []).filter((route) => !route.incident.kind.code.startsWith("system."));
      expect(new Set(routes.map((route) => route.person)).size).toBe(LEVELS.persons);
      // The transit feeds of the start read the empty feeds of the fake.
      expect(measured.instance.transit?.chosen.feeds).toHaveLength(LEVELS.feeds);
      await measured.close();
      // A later start has the alerts of the minutes after the first start. The fake gives one alert in each minute.
      measured = await start(record.end + 3 * MINUTE);
      const later = measured.first;
      expect(later.fetched).toContain(NWS_ID);
      expect(feeds.counts().events).toBeGreaterThan(counts.events);
      expect(hazards(later.view.incidents)).toHaveLength(feeds.counts().events);
      expect(channels.counts().messages).toBeGreaterThan(0);
      expect(outside).toEqual([]);
    } finally {
      await measured?.close();
    }
  });
});
