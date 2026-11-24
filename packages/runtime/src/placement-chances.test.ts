import { VM_PRODUCTS, type PastIncident } from "@mark1russell7/alerts-source-gcp";
import type { HistoryIncident, HistoryRead } from "@mark1russell7/alerts-source-statuspage";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import {
  codePlace,
  DAY_MS,
  downShare,
  downTime,
  feedOf,
  googleHistory,
  historyWindow,
  HISTORY_GAPS,
  HISTORY_SOURCES,
  HOUR_MS,
  isDown,
  locationPlace,
  measureProvider,
  readPageHistory,
  withMeasures,
  type HistorySource,
} from "./placement-chances.ts";
import type { PlacementChances } from "./placement.ts";

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
