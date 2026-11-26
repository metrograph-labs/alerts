import { readingProblems, type FetchOutcome, type Observation, type ObservationId, type PlaceId, type Watch, type WatchedPlace } from "@mark1russell7/alerts";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";

import { AIRPORT_POINTS, AIRPORT_STATES } from "./airports.ts";
import { censusOf, COUNTRY_REGION, type CensusBody } from "./census.ts";
import { checkCanary, STATUS_MAX_AGE_MS } from "./check.ts";
import { FAA_DESCRIPTOR } from "./descriptor.ts";
import { createFaaFetch, readAnswer, STATUS_PATH } from "./fetch.ts";
import { createFaaSource } from "./index.ts";
import { AIRPORT_RADIUS_KM, AIRPORT_SYSTEM, AIRPORTS_DELAYED_MEASURE, AIRPORTS_HELD_MEASURE, mapObservation, PROGRAM_KIND, SOURCE_ID } from "./map.ts";
import { programKey, programsOf, readProgram, type ProgramBody } from "./programs.ts";
import { readStatus, updateTime } from "./status.ts";

const UPDATE = "Tue Nov 24 17:13:45 2026 GMT";
const UPDATED = Date.UTC(2026, 10, 24, 17, 13, 45);

/** A block of the status with the list `list` and the airports `airports`. */
const block = (name: string, list: string, entry: string, airports: readonly string[]): string =>
  `<Delay_type><Name>${name}</Name><${list}>${airports.map((airport) => `<${entry}><ARPT>${airport}</ARPT><Reason>WX:Wind</Reason></${entry}>`).join("")}</${list}></Delay_type>`;

/**
 * A status in the format of the FAA. The delays and the closure have the form of an answer of 2026-11-24. The ground stop
 * and the ground delay program have the form of the program lists of the FAA.
 */
const status = (blocks: readonly string[], update = UPDATE): string =>
  `<AIRPORT_STATUS_INFORMATION><Update_Time>${update}</Update_Time><Dtd_File>http://www.fly.faa.gov/AirportStatus.dtd</Dtd_File>${blocks.join("")}</AIRPORT_STATUS_INFORMATION>`;

const DELAYS = block("General Arrival/Departure Delay Info", "Arrival_Departure_Delay_List", "Delay", ["IAH", "SFO", "DAL"]);
const STOPS = block("Ground Stop Programs", "Ground_Stop_List", "Program", ["IAH"]);
const PROGRAMS = block("Ground Delay Programs", "Ground_Delay_List", "Ground_Delay", ["SFO", "ZZZ"]);
const CLOSURES = block("Airport Closures", "Airport_Closure_List", "Airport", ["LAS", "HOU"]);
const FULL = status([DELAYS, STOPS, PROGRAMS, CLOSURES]);

const statePlace = (id: string, state: string): WatchedPlace => ({ id: id as PlaceId, codes: [{ system: "state", code: state }, { system: "iso3166", code: "US" }], bufferKm: 0 });
const WATCH: Watch = { places: [statePlace("b", "TX"), statePlace("a", "WY")] };

const xml = (body: string, status = 200): Reply => ({ status, statusText: status === 200 ? "OK" : "Error", headers: { "content-type": "application/xml" }, body });

/** This function makes a fetch at the time `start`, whose transport gives the reply `reply`. */
const fetchWith = (reply: Reply, start: number) => {
  const sent: Exchange[] = [];
  const transport: Transport = async (exchange) => {
    sent.push(exchange);
    return reply;
  };
  const clock = { now: () => start, sleep: async () => undefined };
  const options = { pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport, userAgent: "alerts-tests", baseUrl: "https://faa.test", minIntervalMs: 0, timeoutMs: 1000 };
  return { fetch: createFaaFetch(options), source: createFaaSource(options), sent };
};
const observationsOf = (outcome: FetchOutcome): readonly Observation[] => (outcome.ok ? outcome.observations : []);

const census = (body: CensusBody): Observation => ({
  id: "obs-1" as ObservationId,
  source: SOURCE_ID,
  fetched: UPDATED + 60_000,
  contentType: "application/json",
  body: JSON.stringify(body),
  transport: { url: "https://faa.test/api/airport-status-information", status: 200, latency: 10 },
});

describe("the table of the states", () => {
  it("has the large and medium US airports by their FAA location ids", () => {
    expect(AIRPORT_STATES.size).toBeGreaterThan(800);
    expect([AIRPORT_STATES.get("IAH"), AIRPORT_STATES.get("SFO"), AIRPORT_STATES.get("DAL"), AIRPORT_STATES.get("HOU")]).toEqual(["TX", "CA", "TX", "TX"]);
    expect([...AIRPORT_STATES.values()].every((state) => /^[A-Z]{2}$/.test(state))).toBe(true);
  });
});

describe("updateTime", () => {
  it("reads the time of the update in GMT, and gives undefined for each other text", () => {
    expect(updateTime(UPDATE)).toBe(UPDATED);
    expect(updateTime("Sun Nov  1 03:04:05 2026 GMT")).toBe(Date.UTC(2026, 10, 1, 3, 4, 5));
    for (const bad of ["Tue Nov 31 17:13:45 2026 GMT", "Tue Nov 24 25:13:45 2026 GMT", "Tue Foo 24 17:13:45 2026 GMT", "Tue Nov 24 17:13:45 2026 EST", "2026-11-24T17:13:45Z", ""]) {
      expect(updateTime(bad)).toBeUndefined();
    }
  });
});

describe("readStatus", () => {
  it("gives the time and the airports of each list", () => {
    const read = readStatus(FULL);
    expect(read?.updated).toBe(UPDATED);
    expect(read?.lists.map((list) => [list.list, list.airports])).toEqual([
      ["Arrival_Departure_Delay_List", ["IAH", "SFO", "DAL"]],
      ["Ground_Stop_List", ["IAH"]],
      ["Ground_Delay_List", ["SFO", "ZZZ"]],
      ["Airport_Closure_List", ["LAS", "HOU"]],
    ]);
  });

  it("gives undefined for a cut answer or a body that is not a status, and no time for a bad time", () => {
    expect(readStatus(FULL.slice(0, FULL.length - 10))).toBeUndefined();
    expect(readStatus("<html></html>")).toBeUndefined();
    expect(readStatus(status([DELAYS], "soon"))?.updated).toBeUndefined();
  });
});

describe("censusOf", () => {
  it("counts each airport once in each region, gives 0 to a state with no airport, and leaves out the closures", () => {
    const read = readStatus(FULL);
    if (read?.updated === undefined) throw new Error("no status");
    expect(censusOf({ ...read, updated: read.updated }, ["WY", "TX"])).toEqual({
      status: "2026-11-24T17:13:45Z",
      regions: { TX: { held: 1, delayed: 2 }, US: { held: 3, delayed: 4 }, WY: { held: 0, delayed: 0 } },
      unplaced: ["ZZZ"],
      unknown: [],
    });
  });

  it("names a list that it does not know, and does not count it", () => {
    const read = readStatus(status([block("Deicing", "Deicing_List", "Deice", ["DEN"])]));
    if (read?.updated === undefined) throw new Error("no status");
    const body = censusOf({ ...read, updated: read.updated }, []);
    expect(body.unknown).toEqual(["Deicing_List"]);
    expect(body.regions[COUNTRY_REGION]).toEqual({ held: 0, delayed: 0 });
  });
});

describe("mapObservation", () => {
  it("gives the two readings of each region, which the descriptor accepts", () => {
    const result = mapObservation(census({ status: "2026-11-24T17:13:45Z", regions: { TX: { held: 1, delayed: 2 }, US: { held: 3, delayed: 4 } }, unplaced: [], unknown: [] }));
    expect(result.reports).toEqual([]);
    expect(result.problems).toEqual([]);
    expect(result.readings?.map((reading) => [reading.measure, reading.series, reading.value, reading.area])).toEqual([
      [AIRPORTS_HELD_MEASURE, "TX", 1, { type: "code", system: "state", code: "TX" }],
      [AIRPORTS_DELAYED_MEASURE, "TX", 2, { type: "code", system: "state", code: "TX" }],
      [AIRPORTS_HELD_MEASURE, "US", 3, { type: "code", system: "iso3166", code: "US" }],
      [AIRPORTS_DELAYED_MEASURE, "US", 4, { type: "code", system: "iso3166", code: "US" }],
    ]);
    expect(result.readings?.every((reading) => reading.at === UPDATED && readingProblems(reading, FAA_DESCRIPTOR).length === 0)).toBe(true);
  });

  it("tells of a bad region, bad counts, unplaced airports and unknown lists, and keeps the good regions", () => {
    const result = mapObservation(
      census({ status: "2026-11-24T17:13:45Z", regions: { "US-WY": { held: 0, delayed: 0 }, CA: { held: 2, delayed: 1 }, NV: { held: -1, delayed: 0 }, TX: { held: 0, delayed: 1 } }, unplaced: ["ZZZ"], unknown: ["Deicing_List"] }),
    );
    expect(result.readings?.map((reading) => reading.series)).toEqual(["TX", "TX"]);
    expect(result.problems.map((problem) => [problem.path, problem.fatal])).toEqual([
      ["regions.US-WY", false],
      ["regions.CA", false],
      ["regions.NV", false],
      ["unplaced", false],
      ["unknown", false],
    ]);
  });

  it("gives a fatal problem for a body that is not a census or has a bad time", () => {
    for (const body of ["<AIRPORT_STATUS_INFORMATION/>", "{}", JSON.stringify({ status: "2026-11-24", regions: {} })]) {
      const result = mapObservation({ ...census({ status: "", regions: {}, unplaced: [], unknown: [] }), body });
      expect(result.readings ?? []).toEqual([]);
      expect(result.problems.some((problem) => problem.fatal)).toBe(true);
    }
  });
});

describe("createFaaFetch", () => {
  it("asks for the status with no place, and gives one census of the states of the places", async () => {
    const { fetch, sent } = fetchWith(xml(FULL), UPDATED + 30_000);
    const outcome = await fetch({ watch: WATCH });
    expect(sent.map((exchange) => exchange.url)).toEqual([`https://faa.test${STATUS_PATH}`]);
    expect(outcome.ok && outcome.complete).toBe(true);
    const [observation] = observationsOf(outcome);
    expect(JSON.parse(observation?.body ?? "{}")).toMatchObject({ regions: { TX: { held: 1, delayed: 2 }, WY: { held: 0, delayed: 0 } } });
  });

  it("gives one id to two fetches of one update", async () => {
    const first = observationsOf(await fetchWith(xml(FULL), UPDATED + 30_000).fetch({ watch: WATCH }));
    const second = observationsOf(await fetchWith(xml(FULL), UPDATED + 90_000).fetch({ watch: WATCH }));
    expect(first[0]?.id).toBe(second[0]?.id);
  });

  it("fails for a cut answer, and gives the whole body of a status with no time", async () => {
    expect((await fetchWith(xml(FULL.slice(0, 200)), UPDATED).fetch({ watch: WATCH })).ok).toBe(false);
    const outcome = await fetchWith(xml(status([DELAYS], "soon")), UPDATED).fetch({ watch: WATCH });
    expect(outcome.ok && !outcome.complete).toBe(true);
    const [observation] = observationsOf(outcome);
    expect(observation?.contentType).toBe("application/xml");
    expect(observation === undefined ? [] : mapObservation(observation).problems.map((problem) => problem.fatal)).toEqual([true]);
  });

  it("reads an answer with no watched state as the census of the country", () => {
    const read = readAnswer(xml(FULL), "https://faa.test/x", [], UPDATED, 5);
    expect(read?.observations.slice(0, 1).map((observation) => Object.keys((JSON.parse(observation.body) as CensusBody).regions))).toEqual([[COUNTRY_REGION]]);
  });
});

describe("checkCanary", () => {
  it("passes for a recent update and fails for an old update or no census", async () => {
    const { source } = fetchWith(xml(FULL), UPDATED + 60_000);
    const outcome = await source.fetch({ watch: WATCH });
    expect(source.check?.({ observations: observationsOf(outcome) })).toMatchObject({ pass: true });
    const old = observationsOf(outcome).map((observation) => ({ ...observation, fetched: UPDATED + STATUS_MAX_AGE_MS + 1 }));
    expect(checkCanary(old).pass).toBe(false);
    expect(checkCanary([]).pass).toBe(false);
  });
});

/** A status with a ground stop at IAH that ends at a planned time, and a ground delay program at SFO with its delays. */
const PROGRAM_STATUS = (reason: string, update = UPDATE): string =>
  status(
    [
      `<Delay_type><Name>Ground Stop Programs</Name><Ground_Stop_List><Program><ARPT>IAH</ARPT><Reason>${reason}</Reason><End_Time>7:30 pm CST</End_Time></Program></Ground_Stop_List></Delay_type>`,
      "<Delay_type><Name>Ground Delay Programs</Name><Ground_Delay_List><Ground_Delay><ARPT>SFO</ARPT><Reason>low ceilings</Reason><Avg>1 hour and 6 minutes</Avg><Max>2 hours and 9 minutes</Max></Ground_Delay></Ground_Delay_List></Delay_type>",
    ],
    update,
  );

const LATER = "Tue Nov 24 17:20:45 2026 GMT";

describe("the programs", () => {
  it("reads the fields of each entry of a list", () => {
    const lists = readStatus(PROGRAM_STATUS("WX:Thunderstorms"))?.lists ?? [];
    expect(lists.map((list) => list.entries)).toEqual([
      [{ airport: "IAH", fields: { Reason: "WX:Thunderstorms", End_Time: "7:30 pm CST" } }],
      [{ airport: "SFO", fields: { Reason: "low ceilings", Avg: "1 hour and 6 minutes", Max: "2 hours and 9 minutes" } }],
    ]);
  });

  it("gives a new program the time of the status, and keeps the body of a program of the cursor", () => {
    const first = readStatus(PROGRAM_STATUS("WX:Thunderstorms"));
    const later = readStatus(PROGRAM_STATUS("WX:Wind", LATER));
    if (first?.updated === undefined || later?.updated === undefined) throw new Error("the status has no time");
    const one = programsOf({ ...first, updated: first.updated }, undefined);
    expect(one.bodies).toEqual([
      { program: "ground-delay", airport: "SFO", since: "2026-11-24T17:13:45Z", reason: "low ceilings", averageDelay: "1 hour and 6 minutes", maximumDelay: "2 hours and 9 minutes" },
      { program: "ground-stop", airport: "IAH", since: "2026-11-24T17:13:45Z", reason: "WX:Thunderstorms", endTime: "7:30 pm CST" },
    ]);
    // A later status with a different reason gives the same bodies: the observation ids stay.
    expect(programsOf({ ...later, updated: later.updated }, one.cursor)).toEqual(one);
    // A program that left the status leaves the cursor. The same program after that is new.
    const none = programsOf({ updated: later.updated, lists: [] }, one.cursor);
    expect(none).toEqual({ bodies: [], cursor: {} });
    expect(programsOf({ ...later, updated: later.updated }, none.cursor).bodies.map((body) => body.since)).toEqual(["2026-11-24T17:20:45Z", "2026-11-24T17:20:45Z"]);
  });

  it("reads no cursor value that is not the body of its key", () => {
    const body: ProgramBody = { program: "ground-stop", airport: "IAH", since: "2026-11-24T17:13:45Z" };
    expect(readProgram(programKey("ground-stop", "IAH"), JSON.stringify(body))).toEqual(body);
    expect(readProgram(programKey("ground-stop", "SFO"), JSON.stringify(body))).toBeUndefined();
    expect(readProgram(programKey("ground-stop", "IAH"), JSON.stringify({ ...body, since: "soon" }))).toBeUndefined();
    expect(readProgram(programKey("ground-stop", "IAH"), "{")).toBeUndefined();
  });

  it("gives the census, one observation for each program, the cursor and the time of the status", async () => {
    const first = await fetchWith(xml(PROGRAM_STATUS("WX:Thunderstorms")), UPDATED + 30_000).fetch({ watch: WATCH });
    if (!first.ok) throw new Error("the fetch failed");
    expect(first).toMatchObject({ complete: true, asOf: UPDATED });
    expect(Object.keys(first.cursor ?? {})).toEqual(["ground-delay:SFO", "ground-stop:IAH"]);
    expect(first.observations).toHaveLength(3);
    const cursor = first.cursor ?? {};
    const later = await fetchWith(xml(PROGRAM_STATUS("WX:Wind", LATER)), UPDATED + 450_000).fetch({ watch: WATCH, cursor });
    // The census is new. The two programs keep their observation ids, so their reports stay live.
    const ids = (observations: readonly Observation[]): readonly string[] => observations.map((observation) => observation.id);
    expect(ids(observationsOf(later)).slice(1)).toEqual(ids(first.observations).slice(1));
    expect(ids(observationsOf(later))[0]).not.toBe(ids(first.observations)[0]);
  });

  it("gives a status with no time no cursor, so the cursor stays", async () => {
    const outcome = await fetchWith(xml(PROGRAM_STATUS("WX:Wind", "soon")), UPDATED).fetch({ watch: WATCH, cursor: { "ground-stop:IAH": "{}" } });
    expect(outcome.ok && outcome.cursor).toBeUndefined();
  });

  it("maps a program to one report at the point of its airport", async () => {
    const outcome = await fetchWith(xml(PROGRAM_STATUS("WX:Thunderstorms")), UPDATED + 30_000).fetch({ watch: WATCH });
    const reports = observationsOf(outcome).flatMap((observation) => mapObservation(observation).reports);
    expect(reports.map((report) => [report.key, report.urgency, report.severity])).toEqual([
      ["ground-delay:SFO:2026-11-24T17:13:45Z", "expected", "moderate"],
      ["ground-stop:IAH:2026-11-24T17:13:45Z", "immediate", "moderate"],
    ]);
    const stop = reports[1];
    expect(stop).toMatchObject({
      source: SOURCE_ID,
      kind: { code: PROGRAM_KIND },
      sent: UPDATED,
      op: "alert",
      areas: [{ type: "circle", center: AIRPORT_POINTS.get("IAH"), radiusKm: AIRPORT_RADIUS_KM }],
      about: [{ system: AIRPORT_SYSTEM, id: "IAH" }],
      headline: "Ground stop at the airport IAH",
      description: "The reason is WX:Thunderstorms. At the start, the planned end was 7:30 pm CST.",
      parameters: { program: ["ground-stop"], airport: ["IAH"], reason: ["WX:Thunderstorms"], endTime: ["7:30 pm CST"] },
    });
    expect(stop?.observation).toBe(observationsOf(outcome)[2]?.id);
  });

  it("gives a note and no report for an airport with no point, and a fatal problem for a bad program", () => {
    const observation = (body: string): Observation => ({ id: "o" as ObservationId, source: SOURCE_ID, fetched: UPDATED, contentType: "application/json", body, transport: { url: "https://faa.test/x", status: 200, latency: 1 } });
    const unknown = mapObservation(observation(JSON.stringify({ program: "ground-delay", airport: "ZZZ", since: "2026-11-24T17:13:45Z" })));
    expect(unknown.reports).toEqual([]);
    expect(unknown.problems.map((problem) => problem.fatal)).toEqual([false]);
    const bad = mapObservation(observation(JSON.stringify({ program: "ground-hold", airport: "IAH", since: "2026-11-24T17:13:45Z" })));
    expect(bad.problems.map((problem) => problem.fatal)).toEqual([true]);
  });

  it("is a snapshot source of the kind of the programs", () => {
    expect(FAA_DESCRIPTOR).toMatchObject({ kinds: [PROGRAM_KIND], listing: "snapshot" });
  });
});
