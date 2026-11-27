import type { Observation, ObservationId } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { checkCanary, FEED_MAX_AGE_MS } from "./check.ts";
import { gtfsDescriptor } from "./descriptor.ts";
import { boxArea, DEFAULT_INTERVAL, feedProblems, isFeedUrl, sourceIdOf, type GtfsFeed } from "./feed.ts";
import { censusText, GTFS_KIND } from "./map.ts";

const FEED: GtfsFeed = { id: "mdb-1967", title: "ZDiTM Szczecin", url: "https://transit.example.test/alerts.pb", origin: "zditm-szczecin", box: { west: 14.4, south: 53.3, east: 14.8, north: 53.6 } };

describe("feedProblems", () => {
  it("gives no problem for a good feed", () => {
    expect(feedProblems(FEED)).toEqual([]);
    expect(feedProblems({ ...FEED, license: "https://creativecommons.org/publicdomain/zero/1.0/", interval: 60_000 })).toEqual([]);
  });

  it("gives one problem for each bad field, with no URL in a text", () => {
    const bad: GtfsFeed = {
      id: "MDB_1",
      title: " ",
      url: "https://user:secret@transit.example.test/alerts.pb",
      origin: "Agency",
      box: { west: 14.8, south: 53.3, east: 14.4, north: 53.6 },
      license: "ftp://x",
      interval: 1000,
    };
    const problems = feedProblems(bad);
    expect(problems).toHaveLength(7);
    expect(problems.join(" ")).not.toContain("secret");
    expect(problems.join(" ")).not.toContain("transit.example.test");
  });

  it("takes good places of stops and routes, and gives one problem for each bad stop or route", () => {
    const places = { stops: { s1: [14.5, 53.4] as const }, routes: { r1: { west: 14.5, south: 53.4, east: 14.6, north: 53.5 } } };
    expect(feedProblems({ ...FEED, places })).toEqual([]);
    const bad = { stops: { s1: [14.5, 95] as const, s2: [Number.NaN, 0] as const }, routes: { r1: { west: 14.6, south: 53.4, east: 14.5, north: 53.5 } } };
    const problems = feedProblems({ ...FEED, places: bad });
    expect(problems).toHaveLength(3);
    expect(problems.join(" ")).toContain("the route r1");
  });

  it("refuses a box outside the range, or with a value that is not a number", () => {
    expect(feedProblems({ ...FEED, box: { west: -190, south: 0, east: 0, north: 1 } })).toHaveLength(1);
    expect(feedProblems({ ...FEED, box: { west: 0, south: Number.NaN, east: 1, north: 1 } })).toHaveLength(1);
  });

  it("takes an http or https URL with a host and no user, password or fragment", () => {
    expect(isFeedUrl("http://transit.example.test/a?b=c")).toBe(true);
    for (const url of ["transit.example.test/a", "file:///a", "https://u@transit.example.test/a", "https://transit.example.test/a#b"]) expect(isFeedUrl(url)).toBe(false);
  });
});

describe("gtfsDescriptor", () => {
  it("gives one snapshot source for each feed, with the box as its coverage and the interval as its cadence", () => {
    const descriptor = gtfsDescriptor(FEED);
    expect(descriptor).toMatchObject({ id: sourceIdOf(FEED), origins: ["zditm-szczecin"], kinds: [GTFS_KIND], listing: "snapshot", interval: DEFAULT_INTERVAL, coverage: [boxArea(FEED.box!)] });
    expect(descriptor.measures?.map((measure) => measure.cadence)).toEqual([DEFAULT_INTERVAL, DEFAULT_INTERVAL]);
    expect(gtfsDescriptor({ ...FEED, interval: 120_000 })).toMatchObject({ interval: 120_000 });
  });
});

describe("checkCanary", () => {
  const census = (at: string, fetched: number): Observation => ({
    id: "o" as ObservationId,
    source: sourceIdOf(FEED),
    fetched,
    contentType: "application/json",
    body: censusText({ feed: FEED.id, at, entities: 0, alerts: 0, active: 0, noService: 0 }),
    transport: { latency: 0 },
  });
  const at = "2026-11-18T12:00:00.000Z";

  it("passes for a feed at most one hour old, and fails for an older feed", () => {
    expect(checkCanary([census(at, Date.parse(at) + FEED_MAX_AGE_MS)]).pass).toBe(true);
    expect(checkCanary([census(at, Date.parse(at) + FEED_MAX_AGE_MS + 1)])).toMatchObject({ pass: false, reason: expect.stringContaining("60 minutes"), late: true });
  });

  it("fails for a fetch with no census", () => {
    expect(checkCanary([])).toEqual({ pass: false, reason: "the fetch has no census of the feed" });
    expect(checkCanary([{ ...census(at, 0), body: "{" }]).pass).toBe(false);
  });
});
