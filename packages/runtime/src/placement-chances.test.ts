import type { HistoryIncident, HistoryRead } from "@mark1russell7/alerts-source-statuspage";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import {
  codePlace,
  DAY_MS,
  downShare,
  downTime,
  historyWindow,
  HISTORY_GAPS,
  HISTORY_SOURCES,
  HOUR_MS,
  isDown,
  measureProvider,
  readPageHistory,
  withMeasures,
  type HistorySource,
} from "./placement-chances.ts";
import type { PlacementChances } from "./placement.ts";

// Each incident is made up: neutral names, made-up places and times. No text of a real page.
const NOW = Date.parse("2026-03-01T00:00:00.000Z");
const at = (text: string): number => Date.parse(text);
const SOURCE: HistorySource = { provider: "provider-a", host: "status.provider-a.test", placeOf: codePlace };

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

/** The 95% Wilson interval, written out here so the gate does not trust the code that it checks. */
function wilsonByHand(k: number, n: number): { low: number; high: number } {
  const z = 1.959963984540054;
  const p = k / n;
  const scale = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / scale;
  const half = (z / scale) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

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
      const expected = wilsonByHand(measure.down.downHours, measure.down.hours);
      expect(measure.down.share).toBe(measure.down.downHours / measure.down.hours);
      expect(measure.down.interval.low).toBeCloseTo(expected.low, 12);
      expect(measure.down.interval.high).toBeCloseTo(expected.high, 12);
      expect(measure.input.works).toBeCloseTo(1 - expected.high, 12);
      expect(measure.input.kind).toBe("measured");
      expect(measure.input.source).toContain("status.provider-a.test/api/v2/incidents.json from 2025-12-31 to 2026-03-01 (60 days)");
    }
    // A region with no outage in 1440 hours: the high end of the down share is z^2 / (n + z^2).
    expect(byId.get("region:provider-a/xx-north")!.down.interval.high).toBeCloseTo(0.0026606, 6);
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
