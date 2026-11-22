import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { incidents, normalize, type Observation, type ObservationId, type Report } from "@mark1russell7/alerts";
import { decodeFeed } from "@mark1russell7/alerts-source-gtfs-alerts";
import { CANARY_PATH, checkCanary, mapObservation, SOURCE_ID, WEA_PATH } from "@mark1russell7/alerts-source-nws-api";
import { describe, expect, it } from "vitest";
import { createFakeFeeds, emptyFeed, FEED_ALERT_LIFE_MS, readFeedWorkload, TRANSIT_HOST, WORKLOAD_FORMAT, type FakeFeeds } from "./fake-feeds.ts";
import { fakeReadyLine, type FakeReply, type FakeRequest } from "./fake-server.ts";

const MINUTE = 60_000;
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
// A fixed instant of the start of the load. The fake reads each instant from the request, not from the platform.
const START = Date.UTC(2026, 10, 1, 12);

/** This function gives a request of the runtime at the fake, as the listener gives it. */
const requestOf = (url: string, now: number): FakeRequest => {
  const target = new URL(url);
  return { method: "GET", host: target.host, path: target.pathname, query: target.searchParams, search: target.search, headers: {}, body: "", now };
};

/** This function gives the body of a reply as one text. */
const textOf = (reply: FakeReply): string =>
  typeof reply.body === "string" ? reply.body : reply.body instanceof Uint8Array ? new TextDecoder().decode(reply.body) : [...reply.body].join("");

interface Feature {
  readonly properties: {
    readonly id: string;
    readonly messageType: string;
    readonly description: string;
    readonly references: readonly { readonly identifier: string }[];
    readonly parameters: { readonly VTEC: readonly string[] };
  };
}

/** This function gives the features of the main answer of the NWS API at an instant. */
const mainAt = (feeds: FakeFeeds, now: number): readonly Feature[] => {
  const reply = feeds.handler(requestOf("https://api.weather.gov/alerts/active?area=TX", now));
  expect(reply.status).toBe(200);
  return (JSON.parse(textOf(reply)) as { readonly features: readonly Feature[] }).features;
};

/** This function maps the features of an answer with the mapper of the NWS source. Each feature gives one report. */
const reportsOf = (features: readonly Feature[], fetched: number): readonly Report[] =>
  features.flatMap((feature, index) => {
    const observation: Observation = {
      id: `observation-${String(index)}` as ObservationId,
      source: SOURCE_ID,
      fetched,
      contentType: "application/geo+json",
      body: JSON.stringify(feature),
      transport: { latency: 0 },
    };
    const result = mapObservation(observation);
    expect(result.problems.filter((problem) => problem.fatal)).toEqual([]);
    expect(result.reports).toHaveLength(1);
    return result.reports;
  });

const workload = (classes: readonly unknown[]): unknown => ({ format: WORKLOAD_FORMAT, id: "alerts/test", title: "A test point", classes, levels: {}, source: { kind: "plan", note: "A test." } });

describe("readFeedWorkload", () => {
  it("reads the rate and the bytes of each class, in the units of the fake", () => {
    const streams = readFeedWorkload(
      workload([
        { id: "event", rate: { value: 3, unit: "{event}/min" }, request: { eventBytes: { value: 2, unit: "kB" } } },
        { id: "large-updates", of: "update", rate: { value: 0.5, unit: "{event}/s" }, request: { eventBytes: { value: 900, unit: "B" } } },
        { id: "update", rate: { value: 0, unit: "{event}/s" }, request: {} },
      ]),
    );
    expect(streams).toEqual([
      { kind: "event", perSecond: 0.05, eventBytes: 2000 },
      { kind: "update", perSecond: 0.5, eventBytes: 900 },
      { kind: "update", perSecond: 0, eventBytes: 0 },
    ]);
  });

  it("refuses a workload that the fake cannot read", () => {
    expect(() => readFeedWorkload({ format: "other/1", classes: [] })).toThrow(RangeError);
    const refused = [
      { id: "duplicate", rate: { value: 1, unit: "{event}/s" }, request: { eventBytes: { value: 1, unit: "kB" } } },
      { id: "event", rate: { value: 1, unit: "B" }, request: { eventBytes: { value: 1, unit: "kB" } } },
      { id: "event", rate: { value: 1, unit: "{event}/s" }, request: {} },
      { id: "update", rate: { value: 1, unit: "{event}/s" }, request: { eventBytes: { value: 1, unit: "s" } } },
    ];
    for (const entry of refused) expect(() => readFeedWorkload(workload([entry])), JSON.stringify(entry)).toThrow(RangeError);
  });
});

describe("createFakeFeeds", () => {
  it("makes the count of events of the rate over the time from the start, at each request", () => {
    const feeds = createFakeFeeds({ streams: [{ kind: "event", perSecond: 0.5, eventBytes: 300 }], start: START });
    expect(feeds.advance(START).events).toBe(0);
    expect(feeds.advance(START + MINUTE).events).toBe(30);
    // An earlier instant makes no event, and a later instant continues the count.
    expect(feeds.advance(START).events).toBe(30);
    expect(feeds.advance(START + 2 * MINUTE + 999).events).toBe(60);
    const features = mainAt(feeds, START + 2 * MINUTE + 999);
    expect(features).toHaveLength(60);
    expect(features.every((feature) => feature.properties.messageType === "Alert" && feature.properties.description.length === 300)).toBe(true);
    expect(feeds.counts()).toMatchObject({ events: 60, updates: 0, skipped: 0, live: 60, answers: 1 });
    // Each alert lives one hour. The main answer holds only the live alerts.
    expect(feeds.advance(START + FEED_ALERT_LIFE_MS + MINUTE).live).toBe(30 * 60);
  });

  it("gives updates that reference the last version of a live alert, and the merge keeps one incident for each alert", () => {
    const feeds = createFakeFeeds({
      streams: [
        { kind: "event", perSecond: 1 / 60, eventBytes: 400 },
        { kind: "update", perSecond: 1 / 23, eventBytes: 250 },
      ],
      start: START,
      seed: "al-131",
    });
    // An answer at the instant of each alert and of each update shows each version. In the first 10 minutes no alert and no
    // update have one instant. The two updates before the first alert have no live alert, thus the fake skips them.
    const seen = new Map<string, string>();
    const reports: Report[] = [];
    const instants = [...Array.from({ length: 10 }, (_, index) => (index + 1) * MINUTE), ...Array.from({ length: 26 }, (_, index) => (index + 1) * 23_000)];
    for (const at of instants.sort((a, b) => a - b).map((offset) => START + offset)) {
      const features = mainAt(feeds, at);
      for (const feature of features) {
        const vtec = feature.properties.parameters.VTEC[0]!;
        // The event number of the VTEC string names the alert of each version.
        const alert = vtec.split(".")[5]!;
        if (feature.properties.messageType === "Update") {
          expect(vtec).toMatch(/^\/O\.CON\./u);
          expect(feature.properties.description).toHaveLength(250);
          const [reference] = feature.properties.references;
          expect(feature.properties.references).toHaveLength(1);
          expect(seen.get(reference!.identifier)).toBe(alert);
        } else {
          expect(vtec).toMatch(/^\/O\.NEW\./u);
          expect(feature.properties.references).toEqual([]);
        }
        if (!seen.has(feature.properties.id)) reports.push(...reportsOf([feature], at));
        seen.set(feature.properties.id, alert);
      }
    }
    expect(feeds.counts()).toMatchObject({ events: 10, updates: 24, skipped: 2, live: 10 });
    expect(seen.size).toBe(10 + 24);
    // The merge of the 34 versions gives one live incident for each alert, not for each version.
    expect(incidents(normalize({ reports }), START + 10 * MINUTE).filter((incident) => incident.live)).toHaveLength(10);
  });

  it("gives the same alerts for the same seed and the same instants", () => {
    const make = (): FakeFeeds =>
      createFakeFeeds({ streams: [{ kind: "event", perSecond: 0.1, eventBytes: 500 }, { kind: "update", perSecond: 0.1, eventBytes: 500 }], start: START, seed: "same" });
    expect(mainAt(make(), START + 5 * MINUTE)).toEqual(mainAt(make(), START + 5 * MINUTE));
  });

  it("gives a fresh canary, an empty list of WEA copies, empty transit feeds and 503 for each other request", () => {
    const now = START + 3 * MINUTE;
    const feeds = createFakeFeeds({ streams: [{ kind: "event", perSecond: 1, eventBytes: 200 }] });
    const canary = feeds.handler(requestOf(`https://api.weather.gov${CANARY_PATH}`, now));
    expect(canary.status).toBe(200);
    const observations = (JSON.parse(textOf(canary)) as { readonly features: readonly unknown[] }).features.map(
      (feature, index): Observation => ({ id: `canary-${String(index)}` as ObservationId, source: SOURCE_ID, fetched: now, contentType: "application/geo+json", body: JSON.stringify(feature), transport: { latency: 0 } }),
    );
    expect(checkCanary(observations).pass).toBe(true);
    expect(JSON.parse(textOf(feeds.handler(requestOf(`https://api.weather.gov${WEA_PATH}`, now))))).toEqual({ type: "FeatureCollection", features: [] });
    for (const host of [TRANSIT_HOST, `near-3.${TRANSIT_HOST}`]) {
      const reply = feeds.handler(requestOf(`https://${host}/seed-near-3/alerts.pb`, now));
      expect(reply.status).toBe(200);
      const message = decodeFeed(reply.body as Uint8Array);
      expect(message.entity ?? []).toHaveLength(0);
      expect(message.header).toMatchObject({ gtfsRealtimeVersion: "2.0", timestamp: Math.floor(now / 1000) });
    }
    expect(decodeFeed(emptyFeed(2 ** 40)).header?.timestamp).toBe(Math.floor(2 ** 40 / 1000));
    expect(feeds.handler(requestOf("https://api.weather.gov/robots.txt", now)).status).toBe(404);
    for (const url of ["https://api.weather.gov/points/0,0", "https://earthquake.example.org/feed", "https://example.test.other/x"]) {
      expect(feeds.handler(requestOf(url, now)).status, url).toBe(503);
    }
    // The fake starts the load at its first request.
    expect(feeds.advance(now + 2000).events).toBe(2);
  });
});

describe("capacity-app.json services", () => {
  const app = JSON.parse(readFileSync(join(ROOT, "capacity-app.json"), "utf8")) as {
    readonly classes: readonly { readonly id: string; readonly entry: { readonly kind: string; readonly service?: string } }[];
    readonly services: readonly { readonly id: string; readonly fake: { readonly argv: readonly string[]; readonly cwd: string; readonly ready: { readonly text: string } } }[];
    readonly start: { readonly run: { readonly argv: readonly string[] } };
  };

  it("starts each fake with its port, and the fake of the feeds with the workload", () => {
    expect(app.services.map((service) => service.id)).toEqual(["feeds", "channels"]);
    for (const service of app.services) {
      expect(existsSync(join(ROOT, service.fake.cwd, service.fake.argv[1] ?? ""))).toBe(true);
      expect(service.fake.argv).toContain("{port}");
      expect(fakeReadyLine(service.id)).toContain(service.fake.ready.text);
      expect(app.start.run.argv).toContain(`{service.${service.id}}`);
    }
    expect(app.services.find((service) => service.id === "feeds")?.fake.argv).toContain("{workload}");
  });

  it("has the classes event and update from the fake of the feeds", () => {
    expect(app.classes.map((entry) => [entry.id, entry.entry.kind, entry.entry.service])).toEqual([
      ["event", "service", "feeds"],
      ["update", "service", "feeds"],
    ]);
  });
});
