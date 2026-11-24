import { readingProblems, type FetchOutcome, type Observation, type ObservationId, type PlaceId, type Watch, type WatchedPlace } from "@mark1russell7/alerts";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";

import { AIRPORT_STATES } from "./airports.ts";
import { censusOf, COUNTRY_REGION, type CensusBody } from "./census.ts";
import { checkCanary, STATUS_MAX_AGE_MS } from "./check.ts";
import { FAA_DESCRIPTOR } from "./descriptor.ts";
import { createFaaFetch, readAnswer, STATUS_PATH } from "./fetch.ts";
import { createFaaSource } from "./index.ts";
import { AIRPORTS_DELAYED_MEASURE, AIRPORTS_HELD_MEASURE, mapObservation, SOURCE_ID } from "./map.ts";
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
    expect(read?.observations.map((observation) => Object.keys((JSON.parse(observation.body) as CensusBody).regions))).toEqual([[COUNTRY_REGION]]);
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
