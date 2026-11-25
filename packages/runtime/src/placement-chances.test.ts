import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VM_PRODUCTS, type PastIncident } from "@mark1russell7/alerts-source-gcp";
import { openDatabase } from "@mark1russell7/sqlite";
import type { HistoryIncident, HistoryRead } from "@mark1russell7/alerts-source-statuspage";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import {
  codePlace,
  DAY_MS,
  downShare,
  downTime,
  feedOf,
  FETCH_GAP_MS,
  fetchGapTime,
  googleHistory,
  historyWindow,
  HISTORY_GAPS,
  HISTORY_SOURCES,
  HOUR_MS,
  isDown,
  locationPlace,
  measureBase,
  measureBaseCalls,
  measureChannel,
  measurePart,
  measureProvider,
  measureSite,
  readChannelCalls,
  readFetchTimes,
  readPageHistory,
  withMeasures,
  type CallRead,
  type HistorySource,
} from "./placement-chances.ts";
import { callsEvent } from "./events.ts";
import { siteFragment, type PartChance, type PlacementBase, type PlacementChances, type StatusRef } from "./placement.ts";

// Each incident is made up: neutral names, made-up places and times. No text of a real page.
const NOW = Date.parse("2026-03-01T00:00:00.000Z");
const at = (text: string): number => Date.parse(text);
const SOURCE: HistorySource = { provider: "provider-a", host: "status.provider-a.test", kind: "statuspage", placeOf: codePlace };

function incident(id: string, impact: string, start: string, end: string | undefined, components: readonly string[], scheduled = false): HistoryIncident {
  return { id, impact, start: at(start), end: end === undefined ? undefined : at(end), updated: end === undefined ? at(start) : at(end), scheduled, components };
}

const INCIDENTS: readonly HistoryIncident[] = [
  incident("p1", "major", "2026-01-10T00:00:00Z", "2026-01-10T03:00:00Z", ["Control API"]),
  incident("p2", "critical", "2026-01-10T02:00:00Z", "2026-01-10T04:30:00Z", []),
  incident("r1", "critical", "2026-02-01T00:00:00Z", "2026-02-01T02:00:00Z", ["XX-East (Town A)"]),
  incident("r2", "major", "2026-02-01T01:00:00Z", "2026-02-01T03:00:00Z", ["XX-East (Town A)", "XX-West (Town B)"]),
  incident("m1", "major", "2026-02-05T00:00:00Z", "2026-02-05T08:00:00Z", ["XX-East (Town A)"], true),
  incident("n1", "minor", "2026-02-06T00:00:00Z", "2026-02-06T10:00:00Z", ["XX-West (Town B)"]),
  incident("k1", "major", "2026-02-07T00:00:00Z", "2026-02-07T05:00:00Z", ["XX-East (Town A) Kubernetes"]),
  incident("o1", "major", "2026-02-28T22:00:00Z", undefined, ["XX-South (Town C)"]),
  incident("old", "critical", "2025-12-01T00:00:00Z", "2025-12-02T00:00:00Z", ["Control API"]),
];

const COMPONENTS = ["XX-East (Town A)", "XX-West (Town B)", "XX-South (Town C)", "XX-North (Town D)", "Control API", "XX-East (Town A) Kubernetes"];

const READ: HistoryRead = { incidents: INCIDENTS, listed: INCIDENTS.length, skipped: 0 };

/**
 * The ends of the 95% Wilson interval of k down hours of 1440 hours. The values come from the formula of Wilson (1927),
 * computed one time outside of this repository. Thus the gate does not trust the code that it checks.
 */
const WILSON_OF_1440: Readonly<Record<number, readonly [number, number]>> = {
  0: [0, 0.002660582155],
  2: [0.0003809660951, 0.005050003332],
  3: [0.0007087687276, 0.006107394336],
  5: [0.001484009914, 0.008102540421],
};

describe("codePlace", () => {
  it("reads a region, a product of a region and a component of no region", () => {
    expect(codePlace("XX-East (Town A)")).toEqual({ kind: "region", region: "xx-east" });
    expect(codePlace("XX-AAA-2 (Town B 2)")).toEqual({ kind: "region", region: "xx-aaa-2" });
    expect(codePlace("XX-East (Town A) Kubernetes")).toEqual({ kind: "product" });
    expect(codePlace("Control API")).toEqual({ kind: "global" });
  });
});

describe("the method of the down share", () => {
  it("counts only the major and critical impacts that are not scheduled", () => {
    expect(INCIDENTS.filter(isDown).map((each) => each.id)).toEqual(["p1", "p2", "r1", "r2", "k1", "o1", "old"]);
  });

  it("counts the overlap of two incidents one time, cuts each incident to the window, and runs an open incident to the end", () => {
    const window = { from: NOW - 60 * DAY_MS, to: NOW };
    expect(downTime(INCIDENTS.filter((each) => each.id === "p1" || each.id === "p2"), window)).toBe(4.5 * HOUR_MS);
    expect(downTime(INCIDENTS.filter((each) => each.id === "o1"), window)).toBe(2 * HOUR_MS);
    expect(downTime(INCIDENTS.filter((each) => each.id === "old"), window)).toBe(0);
    expect(downTime([], window)).toBe(0);
  });

  it("counts a part of an hour as a whole hour, and refuses a window with no whole hour", () => {
    const window = { from: 0, to: 10 * HOUR_MS };
    expect(downShare(1, window)).toMatchObject({ hours: 10, downHours: 1, share: 0.1 });
    expect(() => downShare(0, { from: 0, to: HOUR_MS - 1 })).toThrow(RangeError);
  });
});

describe("the gate of the measured chances", () => {
  const measured = measureProvider(SOURCE, { read: READ, components: COMPONENTS }, NOW, 60);
  if (!measured.ok) throw new Error(measured.reason);
  const byId = new Map(measured.measures.map((measure) => [measure.input.id, measure]));

  it("gives one input for the provider and one for each region of the page", () => {
    expect([...byId.keys()]).toEqual([
      "provider:provider-a",
      "region:provider-a/xx-east",
      "region:provider-a/xx-north",
      "region:provider-a/xx-south",
      "region:provider-a/xx-west",
    ]);
  });

  it("gives the down hours of each fragment over the 1440 hours of the window", () => {
    const hours = Object.fromEntries([...byId].map(([id, measure]) => [id, [measure.down.downHours, measure.down.hours]]));
    expect(hours).toEqual({
      "provider:provider-a": [5, 1440],
      "region:provider-a/xx-east": [3, 1440],
      "region:provider-a/xx-north": [0, 1440],
      "region:provider-a/xx-south": [2, 1440],
      "region:provider-a/xx-west": [2, 1440],
    });
  });

  it("gives the 95% Wilson interval of each down share, and the low end of the chance that the part works", () => {
    for (const measure of byId.values()) {
      const [low, high] = WILSON_OF_1440[measure.down.downHours]!;
      expect(measure.down.share).toBe(measure.down.downHours / measure.down.hours);
      expect(measure.down.interval.low).toBeCloseTo(low, 11);
      expect(measure.down.interval.high).toBeCloseTo(high, 11);
      expect(measure.input.works).toBeCloseTo(1 - high, 11);
      expect(measure.input.kind).toBe("measured");
      expect(measure.input.source).toContain("status.provider-a.test/api/v2/incidents.json from 2025-12-31 to 2026-03-01 (60 days)");
    }
    expect(byId.get("region:provider-a/xx-north")!.input.works).toBeLessThan(1);
  });
});

describe("the window of a history", () => {
  it("starts at the oldest last change of a full list, and gives no value for a window of less than 30 days", () => {
    const recent = incident("x", "minor", "2026-02-10T00:00:00Z", "2026-02-10T01:00:00Z", []);
    const full: HistoryRead = { incidents: [recent], listed: 50, skipped: 49 };
    expect(historyWindow(full, NOW, 365)).toEqual({ from: at("2026-02-10T01:00:00Z"), to: NOW });
    expect(historyWindow({ ...full, listed: 49 }, NOW, 365)).toEqual({ from: NOW - 365 * DAY_MS, to: NOW });
    const short = measureProvider(SOURCE, { read: full, components: COMPONENTS }, NOW, 365);
    expect(short).toEqual({ ok: false, reason: "The list of status.provider-a.test covers only 19.0 days, less than 30." });
  });
});

describe("withMeasures", () => {
  it("adds each measured input, and keeps the assumed inputs for each other fragment", () => {
    const assumed: PlacementChances = {
      provider: { works: 0.99, kind: "assumed", source: "a" },
      region: { works: 0.98, kind: "assumed", source: "b" },
      host: { works: 0.97, kind: "assumed", source: "c" },
      overrides: [{ id: "provider:provider-a", works: 0.5, kind: "assumed", source: "d" }],
    };
    const measured = measureProvider(SOURCE, { read: READ, components: COMPONENTS }, NOW, 60);
    if (!measured.ok) throw new Error(measured.reason);
    const chances = withMeasures(assumed, measured.measures);
    expect(chances.provider).toBe(assumed.provider);
    expect(chances.overrides?.map((item) => [item.id, item.kind])).toEqual([
      ["provider:provider-a", "assumed"],
      ["region:provider-a/xx-east", "measured"],
      ["region:provider-a/xx-north", "measured"],
      ["region:provider-a/xx-south", "measured"],
      ["region:provider-a/xx-west", "measured"],
    ]);
  });
});

describe("the records of the providers", () => {
  it("gives each provider a source or a gap, not both", () => {
    const sources = HISTORY_SOURCES.map((source) => source.provider);
    const gaps = HISTORY_GAPS.map((gap) => gap.provider);
    expect(sources.filter((provider) => gaps.includes(provider))).toEqual([]);
  });
});

describe("the measured chance of a site from its log", () => {
  const MINUTE = 60_000;
  // A fetch each minute for 48 hours, with one gap of 3 hours after hour 10.
  const start = NOW - 48 * HOUR_MS;
  const times = Array.from({ length: 48 * 60 }, (_, index) => start + index * MINUTE).filter((time) => time < start + 10 * HOUR_MS || time >= start + 13 * HOUR_MS);

  it("counts each gap past the limit, and the gap to the end", () => {
    expect(fetchGapTime(times, NOW - MINUTE)).toBe(3 * HOUR_MS + MINUTE);
    expect(fetchGapTime([0, 4 * MINUTE, 10 * MINUTE], 10 * MINUTE)).toBe(6 * MINUTE);
    expect(fetchGapTime([0], 4 * MINUTE)).toBe(0);
    expect(fetchGapTime([0], 4 * MINUTE, 3 * MINUTE)).toBe(4 * MINUTE);
    expect(FETCH_GAP_MS).toBe(5 * MINUTE);
  });

  it("gives the low end of the Wilson interval as the input of the site fragment", () => {
    const measured = measureSite("site-a", times, NOW);
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    expect(measured.measure.input.id).toBe(siteFragment("site-a"));
    expect(measured.measure.down.hours).toBe(48);
    expect(measured.measure.down.downHours).toBe(4);
    expect(measured.measure.input.works).toBeCloseTo(1 - measured.measure.down.interval.high, 12);
    expect(measured.measure.input.source).toContain("4 of 48 hours down");
    expect(measureSite("site-a", times.slice(-60), NOW).ok).toBe(false);
    expect(measureSite("site-a", [], NOW).ok).toBe(false);
  });

  it("reads the fetch times of a log file, and no other event", () => {
    const folder = mkdtempSync(join(tmpdir(), "alerts-site-log-"));
    try {
      const path = join(folder, "runtime.sqlite");
      const db = openDatabase(path);
      db.exec("CREATE TABLE events (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, at TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL) STRICT");
      const add = db.prepare("INSERT INTO events (id, at, type, body) VALUES (?, ?, ?, '{}')");
      add.run("a", "2026-01-01T00:00:00.000Z", "fetch");
      add.run("b", "2026-01-01T00:01:00.000Z", "delivery");
      add.run("c", "2026-01-01T00:02:00.000Z", "fetch");
      db.close();
      expect(readFetchTimes(path)).toEqual([at("2026-01-01T00:00:00.000Z"), at("2026-01-01T00:02:00.000Z")]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("the measure of a shared channel from its calls (AL-147)", () => {
  const START = at("2026-02-01T00:00:00.000Z");
  const CHANCE: PartChance = { part: "push-a", works: 0.99, kind: "assumed", source: "an assumed input", channel: "push" };
  // One answered call in each of 48 hours, from two copies.
  const answered: CallRead[] = Array.from({ length: 48 }, (_, hour) => ({ time: START + hour * HOUR_MS + 60_000, answered: true, network: true }));

  it("counts an hour as down only when a call failed with a working network and no call had an answer", () => {
    const calls: CallRead[] = [
      ...answered.filter((_, hour) => hour !== 3 && hour !== 7),
      // Hour 3: the service did not answer, and the network of the copy worked. A down hour.
      { time: START + 3 * HOUR_MS + 60_000, answered: false, network: true },
      // Hour 7: one copy failed, and the other copy got an answer. The path of one copy failed, not the service.
      { time: START + 7 * HOUR_MS + 60_000, answered: false, network: true },
      { time: START + 7 * HOUR_MS + 120_000, answered: true, network: true },
      // Hour 48: the call failed while the network of its copy did not work. It is no trial.
      { time: START + 48 * HOUR_MS + 60_000, answered: false, network: false },
    ];
    const measured = measureChannel(CHANCE, calls, NOW);
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    expect(measured.measure.down.hours).toBe(48);
    expect(measured.measure.down.downHours).toBe(1);
    expect(measured.measure.input.id).toBe("push-a");
    expect(measured.chance.kind).toBe("measured");
    expect(measured.chance.works).toBeCloseTo(1 - measured.measure.down.interval.high, 12);
    expect(measured.chance.source).toContain("1 of 48 hours with calls down");
    expect(measured.measure.window).toEqual({ from: START, to: START + 48 * HOUR_MS });
  });

  it("keeps the input with fewer than 24 hours of calls, or with no channel", () => {
    expect(measureChannel(CHANCE, answered.slice(0, 23), NOW).ok).toBe(false);
    expect(measureChannel({ ...CHANCE, channel: undefined }, answered, NOW).ok).toBe(false);
  });

  it("measures each chance of a base that names a channel, and keeps the others", () => {
    const base: PlacementBase = { stack: { format: "system-stack/1", parts: [] } as unknown as PlacementBase["stack"], part: "send", chances: [CHANCE, { part: "feed-a", works: 0.9, kind: "assumed", source: "an assumed input" }] };
    const measured = measureBaseCalls(base, (channel) => (channel === "push" ? answered : []), NOW);
    expect(measured.base.chances?.map((chance) => chance.kind)).toEqual(["measured", "assumed"]);
    expect(measured.measures.map((measure) => measure.input.id)).toEqual(["push-a"]);
    expect(measured.lines).toHaveLength(1);
    const short = measureBaseCalls(base, () => [], NOW);
    expect(short.base.chances?.[0]).toEqual(CHANCE);
    expect(short.lines[0]).toContain("keeps its assumed input");
  });

  it("reads the calls of one channel from the calls events of a log file", () => {
    const folder = mkdtempSync(join(tmpdir(), "alerts-call-log-"));
    try {
      const path = join(folder, "runtime.sqlite");
      const db = openDatabase(path);
      db.exec("CREATE TABLE events (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, at TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL) STRICT");
      const add = db.prepare("INSERT INTO events (id, at, type, body) VALUES (?, ?, ?, ?)");
      const first = callsEvent("copy-a", [
        { channel: "push", call: "probe", time: START },
        { channel: "voice", call: "probe", time: START, kind: "network" },
        { channel: "push", call: "send", time: START + 1000, kind: "timeout" },
      ], START + 2000, START - 60_000);
      // A refusal is an answer of the service. With no passed fetch, a failed call has no working network.
      const second = callsEvent("copy-a", [{ channel: "push", call: "probe", time: START + HOUR_MS, kind: "refused" }, { channel: "push", call: "probe", time: START + HOUR_MS + 1, kind: "server" }], START + HOUR_MS + 2);
      add.run(first.id, first.at, "calls", JSON.stringify(first));
      add.run("b", "2026-02-01T00:00:00.000Z", "delivery", "{}");
      add.run(second.id, second.at, "calls", JSON.stringify(second));
      add.run("c", "2026-02-01T02:00:00.000Z", "calls", "[");
      db.close();
      expect(readChannelCalls(path, "push")).toEqual([
        { time: START, answered: true, network: true },
        { time: START + 1000, answered: false, network: true },
        { time: START + HOUR_MS, answered: true, network: false },
        { time: START + HOUR_MS + 1, answered: false, network: false },
      ]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("the history of a dashboard of Google", () => {
  const GOOGLE: HistorySource = { provider: "provider-g", host: "status.provider-g.test", kind: "google", placeOf: locationPlace };
  const vm = VM_PRODUCTS[0]!.id;
  const past = (id: string, severity: string, impact: string, start: string, end: string | undefined, products: readonly string[], locations: readonly string[]): PastIncident => ({
    id,
    severity,
    impact,
    start: at(start),
    end: end === undefined ? undefined : at(end),
    products,
    locations,
  });
  const PAST: readonly PastIncident[] = [
    past("g1", "high", "SERVICE_OUTAGE", "2026-01-10T00:00:00Z", "2026-01-10T03:30:00Z", [vm], ["global", "europe-west1"]),
    past("g2", "medium", "SERVICE_DISRUPTION", "2026-01-20T00:00:00Z", "2026-01-20T05:00:00Z", [vm], ["europe-west2"]),
    past("g3", "medium", "SERVICE_OUTAGE", "2026-02-01T00:00:00Z", "2026-02-01T02:00:00Z", [vm], ["europe-west2"]),
    past("x1", "high", "SERVICE_OUTAGE", "2026-02-10T00:00:00Z", "2026-02-10T09:00:00Z", ["product-x"], ["europe-west3"]),
  ];
  const since = at("2025-12-01T00:00:00Z");

  it("keeps the incidents of a virtual machine, and marks an outage or a high severity as a down time", () => {
    const history = googleHistory(PAST, since);
    expect(history.read.incidents.map((each) => [each.id, each.impact])).toEqual([
      ["g1", "major"],
      ["g2", "minor"],
      ["g3", "major"],
    ]);
    expect(history.components).toEqual(["europe-west1", "europe-west2", "global"]);
    expect(locationPlace("global")).toEqual({ kind: "global" });
    expect(feedOf(GOOGLE)).toBe("status.provider-g.test/incidents.json");
  });

  it("starts the window at the oldest incident, and measures each region of the offers", () => {
    const measured = measureProvider(GOOGLE, googleHistory(PAST, since), NOW, 365, ["europe-west4"]);
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    const byId = new Map(measured.measures.map((measure) => [measure.input.id, measure]));
    expect([...byId.keys()]).toEqual(["provider:provider-g", "region:provider-g/europe-west1", "region:provider-g/europe-west2", "region:provider-g/europe-west4"]);
    expect(byId.get("provider:provider-g")?.window).toEqual({ from: since, to: NOW });
    // g1 is 3.5 hours: 4 whole hours. g3 counts for its region. g2 is not a down time. A region with no incident has 0 hours.
    expect(byId.get("provider:provider-g")?.down.downHours).toBe(4);
    expect(byId.get("region:provider-g/europe-west1")?.down.downHours).toBe(4);
    expect(byId.get("region:provider-g/europe-west2")?.down.downHours).toBe(2);
    expect(byId.get("region:provider-g/europe-west4")?.down.downHours).toBe(0);
    expect(byId.get("region:provider-g/europe-west4")?.input.source).toContain("status.provider-g.test/incidents.json");
  });

  it("gives no value when the file starts less than 30 days before the read", () => {
    expect(measureProvider(GOOGLE, googleHistory(PAST, NOW - 10 * DAY_MS), NOW).ok).toBe(false);
  });

  it("reads the one incident file of the dashboard", async () => {
    const clock = { now: () => 0, sleep: async () => {} };
    const urls: string[] = [];
    const body = JSON.stringify([
      { id: "g1", begin: "2026-01-10T00:00:00+00:00", end: "2026-01-10T03:30:00+00:00", severity: "high", status_impact: "SERVICE_OUTAGE", affected_products: [{ id: vm, title: "x" }], previously_affected_locations: [{ id: "global", title: "Global" }] },
    ]);
    const outcome = await readPageHistory(GOOGLE, { scheduler: new HostScheduler(clock, 1), now: clock.now }, async (exchange) => {
      urls.push(exchange.url);
      return { status: 200, statusText: "OK", headers: {}, body };
    });
    expect(urls).toEqual(["https://status.provider-g.test/incidents.json"]);
    expect(outcome.ok && outcome.history.since).toBe(at("2026-01-10T00:00:00Z"));
    expect(outcome.ok && outcome.history.read.incidents.map((each) => each.impact)).toEqual(["major"]);
    const wrong = await readPageHistory(GOOGLE, { scheduler: new HostScheduler(clock, 1), now: clock.now }, async () => ({ status: 200, statusText: "OK", headers: {}, body: "{}" }));
    expect(wrong).toEqual({ ok: false, problem: "The incident file is not a list of incidents." });
  });
});

describe("readPageHistory", () => {
  const clock = { now: () => 0, sleep: async () => {} };
  const pace = () => ({ scheduler: new HostScheduler(clock, 1), now: clock.now });

  it("reads the list of incidents and the list of components, with two documented requests", async () => {
    const urls: string[] = [];
    const bodies: Record<string, string> = {
      "/api/v2/incidents.json": JSON.stringify({ incidents: [{ id: "i", impact: "major", created_at: "2026-01-01T00:00:00Z" }] }),
      "/api/v2/components.json": JSON.stringify({ components: [{ name: "Control API" }] }),
    };
    const outcome = await readPageHistory(SOURCE, pace(), async (exchange) => {
      urls.push(exchange.url);
      return { status: 200, statusText: "OK", headers: {}, body: bodies[new URL(exchange.url).pathname] ?? "" };
    });
    expect(urls).toEqual(["https://status.provider-a.test/api/v2/incidents.json", "https://status.provider-a.test/api/v2/components.json"]);
    expect(outcome.ok && outcome.history.components).toEqual(["Control API"]);
    expect(outcome.ok && outcome.history.read.incidents.map((each) => each.id)).toEqual(["i"]);
  });

  it("gives the problem of a refused or wrong answer, and does not throw", async () => {
    const refused = await readPageHistory(SOURCE, pace(), async () => ({ status: 404, statusText: "Not Found", headers: {}, body: "" }));
    expect(refused).toEqual({ ok: false, problem: "the list of incidents gave 404 Not Found." });
    const wrong = await readPageHistory(SOURCE, pace(), async () => ({ status: 200, statusText: "OK", headers: {}, body: "<html>" }));
    expect(wrong).toEqual({ ok: false, problem: "The list of incidents is not a list of Statuspage." });
  });
});

describe("the measured chances of the shared needs of a base", () => {
  const clock = { now: () => 0, sleep: async () => {} };
  const pace = () => ({ scheduler: new HostScheduler(clock, 1), now: clock.now });
  const status = (host: string, read: "api" | "history", components: readonly string[] = []): StatusRef => ({ host, read, components });
  const chance = (part: string, ref?: StatusRef): PartChance => ({ part, works: 0.99, kind: "assumed", source: "a test input", ...(ref === undefined ? {} : { status: ref }) });
  // This history file is made up. It has the structure of the history file of a page, with neutral names.
  const FILE = {
    page_status: { page: { name: "Service A" } },
    months: [
      {
        name: "February 2026",
        year: 2026,
        incidents: [
          { code: "h1", name: "Made-up outage", impact: "critical", timestamp: "Feb <var data-var='date'>2</var>, <var data-var='time'>10:00</var> - <var data-var='time'>12:30</var> UTC" },
          { code: "h2", name: "Made-up slow", impact: "minor", timestamp: "Feb 3, 10:00 - 20:00 UTC" },
          { code: "h3", name: "Made-up work", impact: "maintenance", timestamp: "Feb 4, 10:00 - 20:00 UTC" },
        ],
      },
    ],
    start_time: "2026-01-01T00:00:00Z",
    end_time: "2026-02-28T23:59:59Z",
  };
  const BASE: PlacementBase = {
    stack: { schema: "stack/1", parts: [{ id: "notify", kind: "function", needs: ["push-api"] }, { id: "push-api", kind: "provider" }] },
    part: "notify",
    chances: [
      chance("push-api", status("status.service-a.test", "api", ["XX-West (Town B)"])),
      chance("push-api-2", status("status.service-a.test", "api")),
      chance("call-api", status("status.service-b.test", "history")),
      chance("call-region", status("status.service-b.test", "history", ["Component one"])),
      chance("carrier"),
      chance("mail-api", status("status.service-c.test", "api")),
    ],
  };

  it("measures a part from the components that it names, with the method of the providers", () => {
    const measured = measurePart(chance("push-api", status("status.provider-a.test", "api", ["XX-West (Town B)"])), { read: READ, components: [] }, NOW, 60);
    if (!measured.ok) throw new Error(measured.reason);
    expect(measured.measure.down).toMatchObject({ hours: 1440, downHours: 2 });
    expect(measured.chance.kind).toBe("measured");
    expect(measured.chance.works).toBeCloseTo(1 - WILSON_OF_1440[2]![1], 9);
    expect(measured.chance.source).toContain("status.provider-a.test/api/v2/incidents.json from 2025-12-31 to 2026-03-01 (60 days): 2 of 1440 hours down (impact major or critical, of the components XX-West (Town B))");
    expect(measured.chance.status?.host).toBe("status.provider-a.test");
  });

  it("keeps the input of a part with no status page, with components on a history file, or with a short window", () => {
    expect(measurePart(chance("carrier"), { read: READ, components: [] }, NOW)).toEqual({ ok: false, reason: "The chance names no status page." });
    const named = measurePart(chance("x", status("status.service-b.test", "history", ["Component one"])), { read: READ, components: [] }, NOW);
    expect(named).toEqual({ ok: false, reason: "The history file of status.service-b.test names no component of an incident, thus it cannot give the down time of Component one." });
    const short = measurePart(chance("x", status("status.service-b.test", "history")), { read: READ, components: [], since: NOW - 10 * DAY_MS }, NOW);
    expect(short).toEqual({ ok: false, reason: "The list of status.service-b.test covers only 10.0 days, less than 30." });
  });

  it("reads each feed one time, measures each part with a status page, and gives one line for each input", async () => {
    const urls: string[] = [];
    const bodies: Record<string, { status: number; body: string }> = {
      "https://status.service-a.test/api/v2/incidents.json": { status: 200, body: JSON.stringify({ incidents: INCIDENTS.map((each) => ({ id: each.id, impact: each.impact, created_at: new Date(each.start).toISOString(), resolved_at: each.end === undefined ? null : new Date(each.end).toISOString(), scheduled_for: each.scheduled ? "2026-01-01T00:00:00Z" : null, components: each.components.map((name) => ({ name })) })) }) },
      "https://status.service-b.test/history.json": { status: 200, body: JSON.stringify(FILE) },
      "https://status.service-c.test/api/v2/incidents.json": { status: 403, body: "" },
    };
    const outcome = await measureBase(BASE, pace(), async (exchange) => {
      urls.push(exchange.url);
      const answer = bodies[exchange.url] ?? { status: 404, body: "" };
      return { status: answer.status, statusText: answer.status === 200 ? "OK" : "Forbidden", headers: {}, body: answer.body };
    }, NOW, 60);
    expect(urls).toEqual(["https://status.service-a.test/api/v2/incidents.json", "https://status.service-b.test/history.json", "https://status.service-c.test/api/v2/incidents.json"]);
    expect(outcome.base.chances?.map((each) => [each.part, each.kind])).toEqual([
      ["push-api", "measured"],
      ["push-api-2", "measured"],
      ["call-api", "measured"],
      ["call-region", "assumed"],
      ["carrier", "assumed"],
      ["mail-api", "assumed"],
    ]);
    expect(outcome.measures.map((each) => [each.input.id, each.down.downHours])).toEqual([
      ["push-api", 2],
      ["push-api-2", 15],
      ["call-api", 3],
    ]);
    expect(outcome.measures[2]?.window.from).toBe(at("2026-01-01T00:00:00Z"));
    expect(outcome.lines).toHaveLength(6);
    expect(outcome.lines[2]).toMatch(/^The base input call-api is measured: status\.service-b\.test\/history\.json from 2026-01-01 /u);
    expect(outcome.lines[3]).toBe("The base input call-region keeps its assumed input: The history file of status.service-b.test names no component of an incident, thus it cannot give the down time of Component one.");
    expect(outcome.lines[4]).toBe("The base input carrier keeps its assumed input: it names no status page.");
    expect(outcome.lines[5]).toBe("The base input mail-api keeps its assumed input: the list of incidents gave 403 Forbidden.");
  });
});
