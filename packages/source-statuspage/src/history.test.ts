import { describe, expect, it } from "vitest";
import { HISTORY_LIMIT, readComponentNames, readHistory } from "./index.ts";

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
