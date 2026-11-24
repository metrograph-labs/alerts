import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { addedTime, countEvent, dayStart, eventBody, eventOf, EVENT_FIELDS, keepEvent, stateOf } from "./row.ts";

const lines = readFileSync(new URL("../fixtures/events-20261123200000.tsv", import.meta.url), "utf8").trim().split("\n");

describe("eventOf", () => {
  it("reads the fields of each real line", () => {
    const events = lines.map(eventOf);
    expect(events.every((event) => event !== undefined)).toBe(true);
    expect(events.map((event) => [event!.id, event!.code, event!.root, event!.geoType, event!.country])).toEqual([
      ["1334656907", "036", "03", 4, "IN"],
      ["1334656993", "195", "19", 1, "VM"],
      ["1334657047", "145", "14", 4, "BG"],
      ["1334657169", "190", "19", 4, "HA"],
      ["1334657442", "193", "19", 4, "IS"],
    ]);
    expect(events[2]).toMatchObject({ place: "Dhaka, Dhaka, Bangladesh", actor1: "DHAKA", added: "20261123200000", day: "20261123" });
    expect(events[2]!.url).toMatch(/^https:\/\/www\.thedailystar\.net\//);
  });

  it("gives undefined for a line with a wrong count of fields", () => {
    expect(eventOf("")).toBeUndefined();
    expect(eventOf(lines[0]!.split("\t").slice(0, 60).join("\t"))).toBeUndefined();
    expect(eventOf(`${lines[0]!}\textra`)).toBeUndefined();
  });

  it("reads a line that ends with a carriage return", () => {
    expect(eventOf(`${lines[2]!}\r`)?.url).toBe(eventOf(lines[2]!)?.url);
  });
});

describe("keepEvent", () => {
  it("keeps the protests and the fights at the point of a city", () => {
    expect(lines.map((line) => keepEvent(eventOf(line)!))).toEqual([false, false, true, true, true]);
  });

  it("drops an article about an event of an older day", () => {
    const event = eventOf(lines[3]!)!;
    expect(keepEvent({ ...event, day: "20261122" })).toBe(true);
    expect(keepEvent({ ...event, day: "20261121" })).toBe(false);
    expect(keepEvent({ ...event, day: "20251123" })).toBe(false);
  });

  it("drops an event with no point, or with the point 0, 0", () => {
    const event = eventOf(lines[3]!)!;
    expect(keepEvent({ ...event, lat: Number.NaN })).toBe(false);
    expect(keepEvent({ ...event, lat: 0, lon: 0 })).toBe(false);
    expect(keepEvent({ ...event, lat: 91 })).toBe(false);
  });
});

describe("countEvent and stateOf (AL-142)", () => {
  it("counts a reported root at the place of a city or of a country, and not another root or an old event", () => {
    expect(lines.map((line) => countEvent(eventOf(line)!))).toEqual([false, true, true, true, true]);
    expect(countEvent({ ...eventOf(lines[1]!)!, day: "20261121" })).toBe(false);
  });

  it("gives the state code of a US state, and nothing for another country or a region that is not a state", () => {
    const event = eventOf(lines[1]!)!;
    expect(stateOf({ ...event, country: "US", adm1: "USTX", geoType: 2 })).toBe("TX");
    expect(stateOf({ ...event, country: "US", adm1: "US", geoType: 1 })).toBeUndefined();
    expect(stateOf({ ...event, country: "MX", adm1: "MX07" })).toBeUndefined();
    expect(stateOf(event)).toBeUndefined();
  });
});

describe("the times", () => {
  it("reads the times of GDELT in UTC, and refuses a time that the calendar does not have", () => {
    expect(addedTime("20261123200000")).toBe(Date.UTC(2026, 10, 23, 20, 0, 0));
    expect(addedTime("20261131000000")).toBeUndefined();
    expect(addedTime("20261123240000")).toBeUndefined();
    expect(addedTime("2026112320000")).toBeUndefined();
    expect(dayStart("20261123")).toBe(Date.UTC(2026, 10, 23));
    expect(dayStart("2026-11-23")).toBeUndefined();
  });
});

describe("eventBody", () => {
  it("gives the fields in the order of EVENT_FIELDS", () => {
    const body = JSON.parse(eventBody(eventOf(lines[2]!)!)) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(EVENT_FIELDS);
  });
});
