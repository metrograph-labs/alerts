import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FORMAT, type AlertConfig, type ChannelId, type EscalationPolicy, type PersonId, type PlaceId } from "@mark1russell7/alerts";
import { fakeWallClock, wallClock } from "@mark1russell7/algebra/clock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeHeld } from "./home-lock.ts";
import { openRuntimeLog } from "./log.ts";
import { fakeBase, fakeUrl, longestPartWork, MEASURE_NOW_HEADER, openMeasuredRuntime, type MeasuredRuntime, type SnapshotWriteTime } from "./measured-start.ts";
import { START_SNAPSHOT_EVERY, START_SNAPSHOT_FLOOR } from "./start-snapshot.ts";

const MINUTE = 60_000;
const pushover = "pushover" as ChannelId;
const person = "person-1" as PersonId;
const place = "place-1" as PlaceId;
const policy = (level: EscalationPolicy["level"]): EscalationPolicy => ({ level, steps: [{ channel: pushover, at: 0 }], exhaustedAfter: 20 * MINUTE });

// A public point in McMullen County TX. No request leaves the measure, thus no request holds the point.
const config = (userKey = "PUSHOVER_USER_KEY"): AlertConfig => ({
  format: CONFIG_FORMAT,
  places: [
    {
      id: place,
      label: "Place",
      at: [-98.55, 28.3],
      codes: [
        { system: "state", code: "TX" },
        { system: "ugc", code: "TXC311" },
        { system: "same", code: "048311" },
        { system: "iso3166", code: "US" },
      ],
      bufferKm: 5,
    },
  ],
  people: [{ watch: { person, places: [place], rules: [] } }],
  contacts: [{ person, channel: pushover, address: { user: { secret: userKey } } }],
  policies: [policy("life-safety"), policy("urgent"), policy("notice")],
});

let home: string;
const opened: MeasuredRuntime[] = [];
// The global fetch counts each request. A measured start makes none.
const requests = vi.fn((): Promise<Response> => Promise.reject(new TypeError("This test has no network.")));

const open = async (): Promise<MeasuredRuntime> => {
  const measured = await openMeasuredRuntime(home);
  opened.push(measured);
  return measured;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "alerts-measured-"));
  writeFileSync(join(home, "config.json"), JSON.stringify(config()));
  requests.mockClear();
  vi.stubGlobal("fetch", requests);
});

afterEach(async () => {
  for (const measured of opened.splice(0)) await measured.close();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

// Each test does a full start of the runtime. On a loaded computer a start takes more than the default limit of 5 s.
describe("openMeasuredRuntime", { timeout: 30_000 }, () => {
  it("resolves after the first pass, and no fetch or send leaves the process", async () => {
    const before = performance.now();
    const measured = await open();
    const after = performance.now();
    // The open of the instance comes before the first pass, and both are in this start.
    expect(measured.opened).toBeGreaterThan(before);
    expect(measured.opened).toBeLessThan(after);
    expect(measured.first.fetched.length).toBeGreaterThan(0);
    expect(measured.instance.runtime.skipped).toBe(0);
    // A pass after the start also starts the work of the stores. It has no network either.
    await measured.pass();
    await measured.close();
    expect(requests).not.toHaveBeenCalled();
    // The failed fetches of the passes are events of the log, as in a live start.
    const log = openRuntimeLog(join(home, "runtime.sqlite"));
    expect(log.count()).toBeGreaterThan(0);
    log.close();
  });

  it("times each write of the snapshot with the option timeSnapshot, and keeps no record without it", async () => {
    const heard: SnapshotWriteTime[] = [];
    const timed = await openMeasuredRuntime(home, { startSnapshot: true, timeSnapshot: true, snapshotFloor: 1, onSnapshotWrite: (write) => heard.push(write) });
    opened.push(timed);
    // The first pass makes the start good. The next pass writes the snapshot, and the pass ends after the write.
    expect(timed.snapshotWrites).toEqual([]);
    const before = timed.instance.runtime.eventsAfterSnapshot();
    expect(before).toBeGreaterThan(0);
    await timed.pass();
    expect(timed.snapshotWrites).toHaveLength(1);
    // The function onSnapshotWrite gets the same record at the end of the write (CAP-65).
    expect(heard).toEqual(timed.snapshotWrites);
    const [write] = timed.snapshotWrites;
    expect(write!.rows).toBeGreaterThan(0);
    expect(write!.chars).toBeGreaterThan(0);
    expect(write!.rowsMs).toBeGreaterThanOrEqual(0);
    expect(write!.writeMs).toBeGreaterThanOrEqual(0);
    expect(write!.chunks).toBeGreaterThanOrEqual(1);
    expect(write!.longestMs).toBeGreaterThan(0);
    expect(write!.wallMs).toBeGreaterThanOrEqual(write!.longestMs);
    // The CPU time of a part is the work of the thread. Windows counts it in steps of approximately 16 ms, thus only the wait has a bound.
    expect(write!.longestCpuMs).toBeGreaterThanOrEqual(0);
    expect(write!.longestWaitMs).toBeGreaterThanOrEqual(0);
    expect(write!.longestWaitMs).toBeLessThanOrEqual(write!.longestMs);
    // The record has each part of the write, in order (AL-174).
    expect(write!.parts).toHaveLength(write!.chunks);
    expect(Math.max(...write!.parts.map((part) => part.ms))).toBeCloseTo(write!.longestMs, 6);
    expect(Math.max(...write!.parts.map((part) => part.cpuMs))).toBeCloseTo(write!.longestCpuMs, 6);
    // The mark of the write is the last event of the log at the cut.
    expect(timed.instance.runtime.eventsAfterSnapshot()).toBeLessThan(before);
    // A pass in the same period of the snapshot does not write again.
    await timed.pass();
    expect(timed.snapshotWrites).toHaveLength(1);
    await timed.close();
    // The next start reads the snapshot through the timed store. Without the option, it keeps no record.
    const plain = await openMeasuredRuntime(home, { startSnapshot: true });
    opened.push(plain);
    await plain.pass();
    expect(plain.snapshotWrites).toEqual([]);
  });

  it("writes no snapshot in the first period of a start that read a snapshot (AL-115)", async () => {
    const first = await openMeasuredRuntime(home, { startSnapshot: true, snapshotFloor: 1 });
    opened.push(first);
    await first.pass();
    await first.close();
    const start = Date.now();
    const wall = fakeWallClock(start);
    const again = await openMeasuredRuntime(home, { wall, startSnapshot: true, timeSnapshot: true, snapshotFloor: 1 });
    opened.push(again);
    expect(again.instance.runtime.start.snapshot).toBeDefined();
    // The start read a fresh snapshot, thus its next passes in the period write no copy of it.
    await again.pass();
    await again.pass();
    expect(again.snapshotWrites).toEqual([]);
    // After one period from the start, the next pass writes the snapshot.
    wall.set(start + START_SNAPSHOT_EVERY);
    await again.pass();
    expect(again.snapshotWrites).toHaveLength(1);
  });

  it("writes no snapshot before the log has the floor of new events (AL-115)", async () => {
    const measured = await openMeasuredRuntime(home, { startSnapshot: true, timeSnapshot: true });
    opened.push(measured);
    await measured.pass();
    await measured.pass();
    // A new home has fewer events than the default floor. The start of such a log takes no time, and it needs no snapshot.
    expect(measured.instance.runtime.eventsAfterSnapshot()).toBeLessThan(START_SNAPSHOT_FLOOR);
    expect(measured.snapshotWrites).toEqual([]);
  });

  it("stops when a runtime holds the home folder, and frees the lock at the close", async () => {
    const measured = await open();
    await expect(openMeasuredRuntime(home)).rejects.toBeInstanceOf(HomeHeld);
    await measured.close();
    // The second start rebuilds its state from the events of the first.
    const again = await open();
    expect(again.instance.runtime.skipped).toBe(0);
  });

  it("reads the instant of the wall clock of the caller", async () => {
    // A seeded log ends at a fixed instant. The measure starts its clock there.
    const start = Date.UTC(2020, 0, 1);
    const measured = await openMeasuredRuntime(home, { wall: wallClock({ start }) });
    opened.push(measured);
    const time = measured.instance.runtime.state().time;
    expect(time).toBeGreaterThanOrEqual(start);
    expect(time).toBeLessThan(start + MINUTE);
  });

  it("sends each fetch to the fake of the feeds, with the instant of the wall clock (AL-131)", async () => {
    const start = Date.UTC(2020, 0, 1);
    const measured = await openMeasuredRuntime(home, { wall: wallClock({ start }), services: { feeds: "http://127.0.0.1:9/", channels: "http://localhost:9" } });
    opened.push(measured);
    // The fake of the test refuses each request. The calls of the global fetch are the requests of the transport and of the
    // channel. A start with no feed has incidents of the system, thus the first pass also sends to the fake of the channels.
    const calls = requests.mock.calls as unknown as [string, { readonly headers: Readonly<Record<string, string>> }][];
    const feeds = calls.filter(([url]) => url.startsWith("http://127.0.0.1:9/"));
    const channels = calls.filter(([url]) => url.startsWith("http://localhost:9/"));
    expect(feeds.length).toBeGreaterThan(0);
    expect(feeds.length + channels.length).toBe(calls.length);
    for (const [url] of channels) expect(url.startsWith("http://localhost:9/api.pushover.net/")).toBe(true);
    for (const [, init] of calls) {
      const now = Number(init.headers[MEASURE_NOW_HEADER]);
      expect(now).toBeGreaterThanOrEqual(start);
      expect(now).toBeLessThan(start + MINUTE);
    }
    expect(feeds.some(([url]) => url.startsWith("http://127.0.0.1:9/api.weather.gov/alerts"))).toBe(true);
  });

  it("gives the URL of a request at a fake, and refuses a fake that is not on this computer", async () => {
    expect(fakeUrl(fakeBase("http://127.0.0.1:4100/", "feeds"), "https://api.weather.gov/alerts/active?area=KS")).toBe("http://127.0.0.1:4100/api.weather.gov/alerts/active?area=KS");
    expect(fakeUrl(fakeBase("http://localhost:4101/base", "channels"), "https://api.pushover.net/1/messages.json")).toBe("http://localhost:4101/base/api.pushover.net/1/messages.json");
    for (const text of ["https://127.0.0.1:4100", "http://example.org", "http://127.0.0.1:4100/?key=1", "not a URL"]) {
      expect(() => fakeBase(text, "feeds")).toThrow(RangeError);
    }
    await expect(openMeasuredRuntime(home, { services: { channels: "http://example.org" } })).rejects.toThrow(RangeError);
    // The refusal comes before the lock. Thus a start after it opens the folder.
    const measured = await open();
    expect(measured.first.fetched.length).toBeGreaterThan(0);
  });

  it("refuses private files that do not pass the check, and frees the lock", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify(config("NOT_A_MEASURE_KEY")));
    await expect(openMeasuredRuntime(home)).rejects.toThrow(/do not pass the check/);
    writeFileSync(join(home, "config.json"), JSON.stringify(config()));
    const measured = await open();
    expect(measured.first.fetched.length).toBeGreaterThan(0);
  });
});

describe("the work of the parts of a snapshot write (AL-174)", () => {
  it("takes the pauses of the garbage collector out of the CPU time of each part, with the part of a pause inside the part", () => {
    const parts = [
      { at: 0, ms: 60, cpuMs: 55 },
      { at: 100, ms: 20, cpuMs: 14 },
      { at: 200, ms: 30, cpuMs: 4 },
    ];
    // One pause of 45 ms inside the first part, one across the start of the second part, and one outside each part.
    const pauses = [
      { startTime: 10, duration: 45 },
      { startTime: 95, duration: 10 },
      { startTime: 150, duration: 30 },
    ];
    expect(longestPartWork(parts, pauses)).toEqual({ workMs: 10, gcMs: 45 });
    expect(longestPartWork(parts, [])).toEqual({ workMs: 55, gcMs: 0 });
    // A pause longer than the CPU time of its part gives no work below 0.
    expect(longestPartWork([{ at: 0, ms: 10, cpuMs: 2 }], [{ startTime: 0, duration: 9 }])).toEqual({ workMs: 0, gcMs: 9 });
    expect(longestPartWork([], pauses)).toEqual({ workMs: 0, gcMs: 0 });
  });
});
