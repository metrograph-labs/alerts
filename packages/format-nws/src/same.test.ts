import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseSameHeader, SAME_MAX_LOCATIONS, sameIssuedAt, voteSameHeader } from "./same.ts";

// A header of a required weekly test for eight counties.
const EXAMPLE = "ZCZC-WXR-RWT-020103-020209-020091-020121-029047-029165-029095-029037+0030-1051700-KEAX/NWS-";

describe("parseSameHeader", () => {
  it("reads each part of a header", () => {
    expect(parseSameHeader(EXAMPLE)).toEqual({
      originator: "WXR",
      event: "RWT",
      locations: ["020103", "020209", "020091", "020121", "029047", "029165", "029095", "029037"],
      validMs: 30 * 60_000,
      day: 105,
      hour: 17,
      minute: 0,
      sender: "KEAX/NWS",
    });
  });

  it("reads a header with one location and removes the spaces at the ends", () => {
    expect(parseSameHeader("  ZCZC-CIV-EVI-148001+0145-3652359-WXYZ  FM-\n")).toEqual({
      originator: "CIV",
      event: "EVI",
      locations: ["148001"],
      validMs: 105 * 60_000,
      day: 365,
      hour: 23,
      minute: 59,
      sender: "WXYZ  FM",
    });
  });

  it("reads 31 locations, and refuses 32", () => {
    const header = (count: number): string => `ZCZC-WXR-TOR-${Array.from({ length: count }, () => "029095").join("-")}+0030-1051700-KEAX/NWS-`;
    expect(parseSameHeader(header(SAME_MAX_LOCATIONS))?.locations).toHaveLength(SAME_MAX_LOCATIONS);
    expect(parseSameHeader(header(SAME_MAX_LOCATIONS + 1))).toBeUndefined();
  });

  it.each([
    ["an unknown originator", "ZCZC-ABC-TOR-029095+0030-1051700-KEAX/NWS-"],
    ["a minute of validity of 60", "ZCZC-WXR-TOR-029095+0060-1051700-KEAX/NWS-"],
    ["the day 0", "ZCZC-WXR-TOR-029095+0030-0001700-KEAX/NWS-"],
    ["the day 367", "ZCZC-WXR-TOR-029095+0030-3671700-KEAX/NWS-"],
    ["the hour 24", "ZCZC-WXR-TOR-029095+0030-1052400-KEAX/NWS-"],
    ["no dash at the end", "ZCZC-WXR-TOR-029095+0030-1051700-KEAX/NWS"],
    ["a short location", "ZCZC-WXR-TOR-02909+0030-1051700-KEAX/NWS-"],
    ["no location", "ZCZC-WXR-TOR-+0030-1051700-KEAX/NWS-"],
    ["a short sender", "ZCZC-WXR-TOR-029095+0030-1051700-KEAX/NW-"],
    ["the end of a message", "NNNN"],
    ["an empty text", ""],
  ])("refuses %s", (_name, text) => {
    expect(parseSameHeader(text)).toBeUndefined();
  });
});

describe("sameIssuedAt", () => {
  it("takes the year of now", () => {
    expect(sameIssuedAt({ day: 105, hour: 17, minute: 0 }, Date.parse("2026-04-15T17:01:00Z"))).toBe(Date.parse("2026-04-15T17:00:00Z"));
  });

  it("takes the year before or after now at the end of a year", () => {
    expect(sameIssuedAt({ day: 365, hour: 23, minute: 58 }, Date.parse("2027-01-01T00:02:00Z"))).toBe(Date.parse("2026-12-31T23:58:00Z"));
    expect(sameIssuedAt({ day: 1, hour: 0, minute: 1 }, Date.parse("2026-12-31T23:59:00Z"))).toBe(Date.parse("2027-01-01T00:01:00Z"));
  });

  it("gives the day 366 only in a leap year", () => {
    expect(sameIssuedAt({ day: 366, hour: 12, minute: 0 }, Date.parse("2026-06-01T00:00:00Z"))).toBeUndefined();
    expect(sameIssuedAt({ day: 366, hour: 12, minute: 0 }, Date.parse("2028-12-31T12:05:00Z"))).toBe(Date.parse("2028-12-31T12:00:00Z"));
  });
});

describe("voteSameHeader", () => {
  const change = (text: string, at: number, char: string): string => text.slice(0, at) + char + text.slice(at + 1);

  it("corrects one error in each of two copies", () => {
    expect(voteSameHeader([change(EXAMPLE, 9, "X"), change(EXAMPLE, 40, "7"), EXAMPLE])).toBe(EXAMPLE);
  });

  it("keeps the text of a copy that ends early", () => {
    expect(voteSameHeader([EXAMPLE.slice(0, 30), EXAMPLE, EXAMPLE])).toBe(EXAMPLE);
  });

  it("needs two equal copies when it has two", () => {
    expect(voteSameHeader([EXAMPLE, EXAMPLE])).toBe(EXAMPLE);
    expect(voteSameHeader([EXAMPLE, change(EXAMPLE, 9, "X")])).toBeUndefined();
  });

  it("gives undefined with one copy, and with no majority at a position", () => {
    expect(voteSameHeader([EXAMPLE])).toBeUndefined();
    expect(voteSameHeader([change(EXAMPLE, 9, "X"), change(EXAMPLE, 9, "Y"), EXAMPLE.slice(0, 9) + "Z" + EXAMPLE.slice(10)])).toBeUndefined();
  });

  it("gives the header of three copies with errors at two different positions", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: EXAMPLE.length - 1 }), fc.integer({ min: 0, max: EXAMPLE.length - 1 }), fc.constantFrom("#", "0", "Z"), (first, second, char) => {
        fc.pre(first !== second);
        const copies = [change(EXAMPLE, first, char), change(EXAMPLE, second, char), EXAMPLE];
        expect(parseSameHeader(voteSameHeader(copies) ?? "")).toEqual(parseSameHeader(EXAMPLE));
      }),
    );
  });
});
