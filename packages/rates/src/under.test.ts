import { STATE_POSTAL } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";

import type { HarmRow, YearHarm } from "./ncei.ts";
import { HarmJoin, NCEI_TERRITORIES, NCEI_WATERS, nceiKindOf, nceiTime, nceiTypesOf, placeAll, placeHarm, UNDER_MARGIN_MS, underSection, zoneHours, type ActiveRow, type HarmEvent } from "./under.ts";
import { AlertTally, MARINE_PHENOMENA, NATIONAL_NUMBERS, WATCHWARN_PARAMS, type AlertRow } from "./watchwarn.ts";

const HOUR = 3_600_000;

/** A synthetic row with harm: a tornado in a county of Kansas, from 12:00 to 12:10 local standard time on 6 May 2024. */
const harmRow = (fields: Partial<HarmRow> = {}): HarmRow => ({
  id: "1",
  type: "Tornado",
  stateFips: "20",
  czType: "C",
  czFips: "173",
  timeZone: "CST-6",
  begin: { yearMonth: "202405", day: "6", time: "1200" },
  end: { yearMonth: "202405", day: "6", time: "1210" },
  deaths: 2,
  injuries: 5,
  ...fields,
});

/** The sums of one year with only the rows with harm. The join reads only those rows. */
const yearHarm = (year: number, harmed: readonly HarmRow[]): YearHarm => ({ year, rows: harmed.length, months: [], types: {}, harmed });

/** A placed event: its times are in UTC. */
const event = (fields: Partial<HarmEvent> = {}): HarmEvent => ({
  id: "1",
  year: 2024,
  type: "Tornado",
  ugc: "KSC173",
  begin: Date.UTC(2024, 4, 6, 18),
  end: Date.UTC(2024, 4, 6, 18, 10),
  deaths: 2,
  injuries: 5,
  ...fields,
});

/** An alert row of the reader. */
const alert = (fields: Partial<AlertRow & ActiveRow> = {}): AlertRow & ActiveRow => ({
  wfo: "ICT",
  phenomenon: "TO",
  significance: "W",
  eventId: 12,
  year: 2024,
  ugc: "KSC173",
  issue: Date.UTC(2024, 4, 6, 17, 50),
  expire: Date.UTC(2024, 4, 6, 18, 30),
  ...fields,
});

describe("the times of NCEI", () => {
  it("reads the time zones, with a number or with no number", () => {
    expect(zoneHours("CST-6")).toBe(-6);
    expect(zoneHours("AKST-9")).toBe(-9);
    expect(zoneHours("GST10")).toBe(10);
    expect(zoneHours("est")).toBe(-5);
    expect(zoneHours("HST")).toBe(-10);
    expect(zoneHours("CST-20")).toBeUndefined();
    expect(zoneHours("UNK")).toBeUndefined();
    expect(zoneHours("")).toBeUndefined();
  });

  it("gives a local time in UTC, and nothing for a bad time", () => {
    expect(nceiTime({ yearMonth: "202405", day: "6", time: "1200" }, -6)).toBe(Date.UTC(2024, 4, 6, 18));
    expect(nceiTime({ yearMonth: "202412", day: "31", time: "2330" }, -6)).toBe(Date.UTC(2025, 0, 1, 5, 30));
    expect(nceiTime({ yearMonth: "202405", day: "6", time: "5" }, 0)).toBe(Date.UTC(2024, 4, 6, 0, 5));
    expect(nceiTime({ yearMonth: "202402", day: "30", time: "1200" }, 0)).toBeUndefined();
    expect(nceiTime({ yearMonth: "202413", day: "1", time: "1200" }, 0)).toBeUndefined();
    expect(nceiTime({ yearMonth: "202405", day: "6", time: "1260" }, 0)).toBeUndefined();
    expect(nceiTime({ yearMonth: "2024", day: "6", time: "1200" }, 0)).toBeUndefined();
  });
});

describe("the place of an event with harm", () => {
  it("gives the UGC code of a county or a zone, and the times in UTC", () => {
    expect(placeHarm(harmRow(), 2024)).toEqual(event());
    expect(placeHarm(harmRow({ stateFips: "48", czType: "Z", czFips: "205", type: "Excessive Heat" }), 2024)).toEqual(event({ ugc: "TXZ205", type: "Excessive Heat" }));
    expect(placeHarm(harmRow({ czFips: "1" }), 2024)).toMatchObject({ ugc: "KSC001" });
  });

  it("gives the UGC code of a territory and of a marine zone, with the state codes of NCEI", () => {
    expect(placeHarm(harmRow({ stateFips: "99", czType: "Z", czFips: "8", timeZone: "AST-4" }), 2024)).toMatchObject({ ugc: "PRZ008", begin: Date.UTC(2024, 4, 6, 16) });
    expect(placeHarm(harmRow({ stateFips: "98", czFips: "1", timeZone: "GST10" }), 2024)).toMatchObject({ ugc: "GUC001" });
    expect(placeHarm(harmRow({ stateFips: "85", czType: "Z", czFips: "335", type: "Marine Thunderstorm Wind" }), 2024)).toMatchObject({ ugc: "GMZ335" });
    expect(placeHarm(harmRow({ stateFips: "95", czType: "M", czFips: "147" }), 2024)).toMatchObject({ ugc: "LEZ147" });
    expect(placeHarm(harmRow({ stateFips: "85", czType: "C", czFips: "335" }), 2024)).toMatchObject({ reason: "area" });
  });

  it("keeps the state codes of NCEI apart from the FIPS codes and from each other", () => {
    for (const code of [...Object.keys(NCEI_TERRITORIES), ...Object.keys(NCEI_WATERS)]) expect(STATE_POSTAL[code], code).toBeUndefined();
    for (const code of Object.keys(NCEI_TERRITORIES)) expect(NCEI_WATERS[code], code).toBeUndefined();
    for (const prefix of [...Object.values(NCEI_TERRITORIES), ...Object.values(NCEI_WATERS)]) expect(prefix).toMatch(/^[A-Z]{2}$/);
  });

  it("gives the reason when it cannot place a row", () => {
    expect(placeHarm(harmRow({ czType: "M" }), 2024)).toEqual({ id: "1", year: 2024, type: "Tornado", reason: "marine", deaths: 2, injuries: 5 });
    expect(placeHarm(harmRow({ stateFips: "82" }), 2024)).toMatchObject({ reason: "area" });
    expect(placeHarm(harmRow({ stateFips: "X" }), 2024)).toMatchObject({ reason: "area" });
    expect(placeHarm(harmRow({ czType: "X" }), 2024)).toMatchObject({ reason: "area" });
    expect(placeHarm(harmRow({ czFips: "1234" }), 2024)).toMatchObject({ reason: "area" });
    expect(placeHarm(harmRow({ timeZone: "UNK" }), 2024)).toMatchObject({ reason: "time zone" });
    expect(placeHarm(harmRow({ end: { yearMonth: "202405", day: "6", time: "1100" } }), 2024)).toMatchObject({ reason: "time" });
  });

  it("places each row of the years, and throws an error for a year with no file", () => {
    const placed = placeAll([yearHarm(2023, [harmRow({ id: "0" })]), yearHarm(2024, [harmRow(), harmRow({ id: "2", czType: "M" })])], { first: 2024, last: 2024 });
    expect(placed.events).toEqual([event()]);
    expect(placed.unplaced).toEqual([{ id: "2", year: 2024, type: "Tornado", reason: "marine", deaths: 2, injuries: 5 }]);
    expect(() => placeAll([yearHarm(2024, [])], { first: 2024, last: 2025 })).toThrow(/no file of 2025/);
  });
});

describe("the NCEI kind of an alert kind", () => {
  it("takes the longest prefix of the kind that an NCEI type has", () => {
    expect(nceiKindOf("met.tornado")).toBe("met.tornado");
    expect(nceiKindOf("met.flood.river")).toBe("met.flood");
    expect(nceiKindOf("met.flood.flash")).toBe("met.flood.flash");
    expect(nceiKindOf("met.tropical.typhoon")).toBe("met.tropical");
    expect(nceiKindOf("fire.weather")).toBeNull();
    expect(nceiTypesOf("met.winter.storm")).toEqual(["Heavy Snow", "Winter Storm"]);
    expect(nceiTypesOf("met.heat.extreme")).toEqual(["Excessive Heat", "Extreme Heat"]);
    expect(nceiTypesOf(null)).toEqual([]);
  });
});

describe("the join of the alerts and the events", () => {
  it("finds the alerts of the area of an event, active from the begin minus the margin to the end", () => {
    const join = new HarmJoin([event()]);
    expect([...join.ugcs]).toEqual(["KSC173"]);
    join.add(alert({ phenomenon: "SV", issue: Date.UTC(2024, 4, 6, 16), expire: Date.UTC(2024, 4, 6, 18) - UNDER_MARGIN_MS }));
    join.add(alert({ phenomenon: "TO", significance: "A" }));
    join.add(alert({ phenomenon: "FF", issue: Date.UTC(2024, 4, 6, 15), expire: Date.UTC(2024, 4, 6, 18) - UNDER_MARGIN_MS - 60_000 }));
    join.add(alert({ phenomenon: "FA", issue: Date.UTC(2024, 4, 6, 18, 11), expire: Date.UTC(2024, 4, 6, 20) }));
    join.add(alert({ phenomenon: "FL", ugc: "KSC177" }));
    join.add(alert({ phenomenon: "QQ", ugc: "KSC177" }));
    expect(join.matches()).toEqual([{ event: event(), under: ["met.thunderstorm.severe|W", "met.tornado|A"] }]);
    expect(() => join.add(alert({ phenomenon: "QQ" }))).toThrow(/no phenomenon QQ/);
  });
});

describe("the section of the harm under an active alert", () => {
  const years = { first: 2024, last: 2025 };
  const tally = new AlertTally(years);
  tally.add({
    rows: [
      alert(),
      alert({ wfo: "TOP", eventId: 30, ugc: "KSC177" }),
      alert({ wfo: "EWX", phenomenon: "EH", eventId: 2, ugc: "TXZ205", issue: Date.UTC(2024, 6, 1), expire: Date.UTC(2024, 6, 4) }),
      alert({ wfo: "EWX", phenomenon: "XH", eventId: 1, year: 2025, ugc: "TXZ205", issue: Date.UTC(2025, 6, 1), expire: Date.UTC(2025, 6, 4) }),
    ],
    faults: { expire: 1 },
  });
  const events = [
    event(),
    event({ id: "2", type: "Thunderstorm Wind", deaths: 0, injuries: 1 }),
    event({ id: "3", year: 2025, begin: Date.UTC(2025, 3, 1), end: Date.UTC(2025, 3, 1, 1), deaths: 1, injuries: 0 }),
    event({ id: "4", type: "Excessive Heat", ugc: "TXZ205", begin: Date.UTC(2024, 6, 2), end: Date.UTC(2024, 6, 3), deaths: 3, injuries: 0 }),
  ];
  const join = new HarmJoin(events);
  join.add(alert());
  join.add(alert({ phenomenon: "EH", ugc: "TXZ205", issue: Date.UTC(2024, 6, 1), expire: Date.UTC(2024, 6, 4) }));
  const unplaced = [{ id: "5", year: 2025, type: "Tornado", reason: "time zone" as const, deaths: 4, injuries: 1 }];
  const section = underSection({ years, windows: [{ start: Date.UTC(2023, 11, 1), end: Date.UTC(2024, 0, 1) }], counts: tally.counts(), matches: join.matches(), unplaced });

  it("gives the alerts and the harm under them for each kind and significance", () => {
    expect(Object.keys(section.kinds)).toEqual(["met.heat.extreme", "met.tornado"]);
    expect(section.kinds["met.tornado"]).toEqual({
      nceiKind: "met.tornado",
      nceiTypes: ["Tornado"],
      ncei: { "2024": { events: 1, deaths: 2, injuries: 5 }, "2025": { events: 2, deaths: 5, injuries: 1 } },
      placed: { counties: 2, zones: 0 },
      significances: {
        W: {
          alerts: { "2024": 2, "2025": 0 },
          phenomena: { TO: 2 },
          harm: { "2024": { events: 1, deaths: 2, injuries: 5 }, "2025": { events: 0, deaths: 0, injuries: 0 } },
          total: { alerts: 2, harm: { events: 1, deaths: 2, injuries: 5 } },
          byType: { "Thunderstorm Wind": { events: 1, deaths: 0, injuries: 1 }, Tornado: { events: 1, deaths: 2, injuries: 5 } },
          byArea: {
            counties: { areas: { "2024": 2, "2025": 0 }, harm: { "2024": { events: 1, deaths: 2, injuries: 5 }, "2025": { events: 0, deaths: 0, injuries: 0 } } },
            zones: { areas: { "2024": 0, "2025": 0 }, harm: { "2024": { events: 0, deaths: 0, injuries: 0 }, "2025": { events: 0, deaths: 0, injuries: 0 } } },
          },
        },
      },
    });
  });

  it("adds the alerts of two phenomena of one kind", () => {
    const heat = section.kinds["met.heat.extreme"]?.significances.W;
    expect(section.kinds["met.heat.extreme"]?.nceiTypes).toEqual(["Excessive Heat", "Extreme Heat"]);
    expect(heat?.alerts).toEqual({ "2024": 1, "2025": 1 });
    expect(heat?.phenomena).toEqual({ EH: 1, XH: 1 });
    expect(heat?.total).toEqual({ alerts: 2, harm: { events: 1, deaths: 3, injuries: 0 } });
    expect(heat?.byArea.zones).toEqual({ areas: { "2024": 1, "2025": 1 }, harm: { "2024": { events: 1, deaths: 3, injuries: 0 }, "2025": { events: 0, deaths: 0, injuries: 0 } } });
    expect(heat?.byArea.counties.areas).toEqual({ "2024": 0, "2025": 0 });
    expect(section.kinds["met.heat.extreme"]?.placed).toEqual({ counties: 0, zones: 1 });
  });

  it("keeps the method, the windows, the checks and the events that the join cannot place", () => {
    expect(section).toMatchObject({
      years,
      params: WATCHWARN_PARAMS,
      windows: ["2023-12-01T00:00Z/2024-01-01T00:00Z"],
      marginMs: UNDER_MARGIN_MS,
      significances: ["W", "A", "Y", "S"],
      marine: { phenomena: MARINE_PHENOMENA },
      national: NATIONAL_NUMBERS,
      rows: 4,
      faults: { expire: 1 },
      codes: { "2024": { counties: 2, zones: 1 }, "2025": { counties: 0, zones: 1 } },
      unplaced: { "time zone": { events: 1, deaths: 4, injuries: 1 } },
    });
    expect(section.numbering["TO.W"]).toEqual({ national: false, numbers: 2, shared: 0, together: 0 });
  });

  it("throws an error for a phenomenon that the NWS tables do not have", () => {
    const counts = { rows: 1, alerts: { "QQ.W": { "2024": 1, "2025": 0 } }, areas: {}, codes: {}, numbering: {}, faults: {} };
    expect(() => underSection({ years, windows: [], counts, matches: [], unplaced: [] })).toThrow(/no phenomenon QQ/);
  });
});

describe("the margin", () => {
  it("is one hour", () => {
    expect(UNDER_MARGIN_MS).toBe(HOUR);
  });
});
