import { describe, expect, it } from "vitest";
import { HISTORY_LIMIT, readComponentNames, readHistory, readHistoryFile, spanOf, ZONE_OFFSETS } from "./index.ts";

// Each body is made up. It has the structure of the documented lists, not the text of a real page.
const LIST = {
  page: { id: "p1", name: "Provider A" },
  incidents: [
    {
      id: "i2",
      name: "Made-up outage",
      status: "resolved",
      impact: "major",
      created_at: "2026-03-01T10:05:00.000Z",
      started_at: "2026-03-01T10:00:00.000Z",
      resolved_at: "2026-03-01T12:00:00.000Z",
      updated_at: "2026-03-01T12:30:00.000Z",
      components: [{ id: "c1", name: "XX-AAA (Town A)" }, { id: "c1", name: "XX-AAA (Town A)" }, { id: "c2" }],
    },
    { id: "i1", name: "Made-up work", status: "completed", impact: "maintenance", created_at: "2026-02-01T00:00:00.000Z", scheduled_for: "2026-02-01T01:00:00.000Z", components: [] },
    { id: "bad", name: "No impact", status: "resolved", created_at: "2026-01-01T00:00:00.000Z" },
    "not a record",
  ],
};

describe("readHistory", () => {
  it("reads the facts of the down time of each incident, and counts the items that it skips", () => {
    const read = readHistory(JSON.stringify(LIST));
    expect(read).toEqual({
      listed: 4,
      skipped: 2,
      incidents: [
        {
          id: "i2",
          impact: "major",
          start: Date.parse("2026-03-01T10:00:00.000Z"),
          end: Date.parse("2026-03-01T12:00:00.000Z"),
          updated: Date.parse("2026-03-01T12:30:00.000Z"),
          scheduled: false,
          components: ["XX-AAA (Town A)"],
        },
        { id: "i1", impact: "maintenance", start: Date.parse("2026-02-01T00:00:00.000Z"), end: undefined, updated: Date.parse("2026-02-01T00:00:00.000Z"), scheduled: true, components: [] },
      ],
    });
  });

  it("gives undefined for a body that is not JSON or has no list of incidents", () => {
    expect(readHistory("<html>")).toBeUndefined();
    expect(readHistory(JSON.stringify({ page: {} }))).toBeUndefined();
  });

  it("names the length of a list that can hide older incidents", () => {
    expect(HISTORY_LIMIT).toBe(50);
  });
});

describe("readComponentNames", () => {
  it("gives the name of each component that is not a group, with no name twice", () => {
    const body = { components: [{ name: "Regions", group: true }, { name: "XX-AAA (Town A)", group: false }, { name: "XX-AAA (Town A)" }, { name: "Control API" }, { id: "x" }] };
    expect(readComponentNames(JSON.stringify(body))).toEqual(["XX-AAA (Town A)", "Control API"]);
    expect(readComponentNames("{}")).toBeUndefined();
    expect(readComponentNames("no")).toBeUndefined();
  });
});

// This body is made up. It has the structure of the history file of a page, not the text of a real page.
const span = (from: string, to?: string): string => `${from}${to === undefined ? "" : ` - ${to}`}`;
const FILE = {
  page_status: { page: { name: "Service A" } },
  components: [{ name: "Component one", group: false }],
  months: [
    {
      name: "January 2027",
      year: 2027,
      incidents: [
        { code: "f1", name: "Made-up outage", message: "Resolved.", impact: "major", timestamp: span("Jan <var data-var='date'>3</var>, <var data-var='time'>10:00</var>", "<var data-var='time'>12:30</var> PST") },
        { code: "f2", name: "Made-up slow", message: "Resolved.", impact: "minor", timestamp: span("Dec <var data-var='date'>31</var>, <var data-var='time'>23:00</var>", "Jan <var data-var='date'>1</var>, <var data-var='time'>01:00</var> UTC") },
        { code: "f3", name: "Made-up open", message: "Looking.", impact: "critical", timestamp: "Jan <var data-var='date'>9</var>, <var data-var='time'>08:15</var> EST" },
        { code: "f4", name: "Made-up work", message: "Done.", impact: "maintenance", timestamp: span("Jan 5, 01:00", "02:00 UTC") },
        { code: "f5", name: "Made-up zone", message: "Done.", impact: "major", timestamp: span("Jan 6, 01:00", "02:00 XYZ") },
        { code: "f6", name: "No impact", message: "Done.", timestamp: span("Jan 7, 01:00", "02:00 UTC") },
      ],
    },
    { name: "December 2026", year: 2026, incidents: [{ code: "f2", name: "Made-up slow", impact: "minor", timestamp: span("Dec 31, 23:00", "Jan 1, 01:00 UTC") }] },
  ],
  start_time: "2026-12-01T00:00:00-08:00",
  end_time: "2027-01-31T23:59:59-08:00",
};

describe("readHistoryFile", () => {
  it("reads the span and the impact of each item, with the year of its month, and skips an item with no time or impact", () => {
    const read = readHistoryFile(JSON.stringify(FILE));
    expect(read).toEqual({
      listed: 6,
      skipped: 2,
      since: Date.parse("2026-12-01T08:00:00.000Z"),
      incidents: [
        { id: "f1", impact: "major", start: Date.parse("2027-01-03T18:00:00Z"), end: Date.parse("2027-01-03T20:30:00Z"), updated: Date.parse("2027-01-03T20:30:00Z"), scheduled: false, components: [] },
        { id: "f2", impact: "minor", start: Date.parse("2026-12-31T23:00:00Z"), end: Date.parse("2027-01-01T01:00:00Z"), updated: Date.parse("2027-01-01T01:00:00Z"), scheduled: false, components: [] },
        { id: "f3", impact: "critical", start: Date.parse("2027-01-09T13:15:00Z"), end: undefined, updated: Date.parse("2027-01-09T13:15:00Z"), scheduled: false, components: [] },
        { id: "f4", impact: "maintenance", start: Date.parse("2027-01-05T01:00:00Z"), end: Date.parse("2027-01-05T02:00:00Z"), updated: Date.parse("2027-01-05T02:00:00Z"), scheduled: true, components: [] },
      ],
    });
  });

  it("gives undefined for a body that is not JSON or has no list of months", () => {
    expect(readHistoryFile("<html>")).toBeUndefined();
    expect(readHistoryFile(JSON.stringify({ incidents: [] }))).toBeUndefined();
  });
});

describe("spanOf", () => {
  it("gives the end in the next year for a span over the end of a year, and no span for a text it does not know", () => {
    expect(spanOf("Dec 31, 22:00 - Jan 1, 02:00 UTC", 11, 2026)).toEqual({ start: Date.parse("2026-12-31T22:00:00Z"), end: Date.parse("2027-01-01T02:00:00Z") });
    expect(spanOf("Mar 1, 10:00 - 11:00 CET", 2, 2027)).toEqual({ start: Date.parse("2027-03-01T09:00:00Z"), end: Date.parse("2027-03-01T10:00:00Z") });
    expect(spanOf("Mar 1, 10:00", 2, 2027)).toBeUndefined();
    expect(spanOf("Foo 1, 10:00 UTC", 2, 2027)).toBeUndefined();
    expect(ZONE_OFFSETS["UTC"]).toBe(0);
  });
});
