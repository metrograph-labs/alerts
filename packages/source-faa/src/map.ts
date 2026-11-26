/**
 * The map function of the FAA source. An observation is one census of the airport status of the FAA, or one program at an
 * airport. A census gives no report. It gives two indicator readings for each region: the count of the airports that hold
 * flights and the count of the airports with a delay. A program gives one report at the point of its airport.
 *
 * The area of a reading of a state is the code of the state, the system of the places. Thus the breadth of each place
 * of the state reads the series. The area of the reading of the whole country is the code `US` of ISO 3166-1.
 */

import { categoryOf, kindLabel, Problems, reportId, type IndicatorArea, type MapResult, type Observation, type Reading, type Report, type SourceId } from "@mark1russell7/alerts";
import { isRecord } from "@mark1russell7/optional/read";
import { errorMessage } from "@mark1russell7/text";

import { AIRPORT_POINTS } from "./airports.ts";
import { COUNTRY_REGION } from "./census.ts";
import { programKey, readProgram, type ProgramBody } from "./programs.ts";

/** The id of this source. */
export const SOURCE_ID = "faa-nas-status" as SourceId;

/** The origin of the status: the Air Traffic Control System Command Center of the FAA. */
export const FAA_ORIGIN = "faa";

/** The id of the measure of the count of the airports with a ground stop or a ground delay program. */
export const AIRPORTS_HELD_MEASURE = "airports-held";

/** The id of the measure of the count of the airports with a delay of each kind. */
export const AIRPORTS_DELAYED_MEASURE = "airports-delayed";

/** The kind of the report of a program. */
export const PROGRAM_KIND = "transport.air.disruption";

/** The system of the subject of a report: the FAA location id of the airport. */
export const AIRPORT_SYSTEM = "faa-airport";

/** The radius of the area of a report around the point of its airport: the ground of a large airport. */
export const AIRPORT_RADIUS_KM = 3;

/** The page of the airport status of the FAA for a person. */
export const STATUS_PAGE = "https://nasstatus.faa.gov/";

/** The sender of each report. */
export const FAA_SENDER = "FAA Air Traffic Control System Command Center";

/** The unit of each count. */
export const AIRPORT_UNIT = "{airport}";

/** This function gives the area of a region: a US state by its code, or the whole country. */
export function regionArea(region: string): IndicatorArea {
  return region === COUNTRY_REGION ? { type: "code", system: "iso3166", code: COUNTRY_REGION } : { type: "code", system: "state", code: region };
}

/** This function tells if a value is a count: a whole number, 0 or more. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** This function maps one observation. It does not throw. A body that it does not understand gives a fatal problem. */
export function mapObservation(observation: Observation): MapResult {
  try {
    return mapOrThrow(observation);
  } catch (error) {
    return { reports: [], problems: [{ path: "", message: `the map function failed: ${errorMessage(error)}`, fatal: true }] };
  }
}

/** This function maps one observation, and can throw. `mapObservation` catches each error. */
function mapOrThrow(observation: Observation): MapResult {
  let fields: unknown;
  try {
    fields = JSON.parse(observation.body);
  } catch {
    // The fetch gives the whole answer as one observation when the status has no valid time.
    return { reports: [], problems: [{ path: "", message: "the observation is not a census: the format of the status of the FAA changed", fatal: true }] };
  }
  if (isRecord(fields) && "program" in fields) return mapProgram(observation, fields);
  if (!isRecord(fields) || typeof fields["status"] !== "string" || !isRecord(fields["regions"])) {
    return { reports: [], problems: [{ path: "", message: "the observation is not a census of the status of the FAA", fatal: true }] };
  }
  const problems = new Problems();
  const at = Date.parse(fields["status"]);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(fields["status"]) || !Number.isFinite(at)) {
    problems.add("status", `the value ${JSON.stringify(fields["status"])} is not a time in UTC: the map gives no reading`, "fatal");
    return { reports: [], problems: problems.list, readings: [] };
  }
  const readings: Reading[] = [];
  for (const [region, counts] of Object.entries(fields["regions"])) {
    if (region !== COUNTRY_REGION && !/^[A-Z]{2}$/.test(region)) {
      problems.add(`regions.${region}`, `the region ${JSON.stringify(region)} is not a US state: the map gives no reading for it`);
      continue;
    }
    const held = isRecord(counts) ? counts["held"] : undefined;
    const delayed = isRecord(counts) ? counts["delayed"] : undefined;
    if (!isCount(held) || !isCount(delayed) || held > delayed) {
      problems.add(`regions.${region}`, `the counts ${JSON.stringify(counts)} are not two counts with held at most delayed: the map gives no reading for the region`);
      continue;
    }
    const reading = (measure: string, value: number): Reading => ({ source: SOURCE_ID, measure, series: region, at, value, area: regionArea(region), observation: observation.id });
    readings.push(reading(AIRPORTS_HELD_MEASURE, held), reading(AIRPORTS_DELAYED_MEASURE, delayed));
  }
  const unplaced = fields["unplaced"];
  if (Array.isArray(unplaced) && unplaced.length > 0) {
    problems.add("unplaced", `the table of the states does not have the airports ${unplaced.join(", ")}: only the count of the country has them`, "note");
  }
  const unknown = fields["unknown"];
  if (Array.isArray(unknown) && unknown.length > 0) {
    problems.add("unknown", `the status has the lists ${unknown.join(", ")}, which the census does not know: it does not count them`);
  }
  return { reports: [], problems: problems.list, readings };
}

/** The title of each type of program. */
const PROGRAM_TITLES: Readonly<Record<ProgramBody["program"], string>> = { "ground-stop": "Ground stop", "ground-delay": "Ground delay program" };

/** This function maps the observation of one program. An airport with no point in the table gives a note and no report. */
function mapProgram(observation: Observation, fields: Record<string, unknown>): MapResult {
  const key = typeof fields["program"] === "string" && typeof fields["airport"] === "string" ? programKey(fields["program"] as ProgramBody["program"], fields["airport"]) : "";
  const body = readProgram(key, observation.body);
  if (body === undefined) return { reports: [], problems: [{ path: "", message: "the observation is not a program of the status of the FAA", fatal: true }] };
  const point = AIRPORT_POINTS.get(body.airport);
  if (point === undefined) {
    return { reports: [], problems: [{ path: "airport", message: `the table of the airports does not have ${body.airport}: the program gives no report`, fatal: false }] };
  }
  return { reports: [programReport(observation, body, point)], problems: [] };
}

/** This function gives the report of one program. */
function programReport(observation: Observation, body: ProgramBody, point: readonly [number, number]): Report {
  const sent = Date.parse(body.since);
  const key = `${programKey(body.program, body.airport)}:${body.since}`;
  const title = PROGRAM_TITLES[body.program];
  const facts = [
    body.reason === undefined ? undefined : `The reason is ${body.reason}.`,
    body.averageDelay === undefined ? undefined : `At the start, the average delay was ${body.averageDelay}.`,
    body.maximumDelay === undefined ? undefined : `At the start, the maximum delay was ${body.maximumDelay}.`,
    body.endTime === undefined ? undefined : `At the start, the planned end was ${body.endTime}.`,
  ].filter((fact) => fact !== undefined);
  return {
    id: reportId({ source: SOURCE_ID, key, sent }),
    source: SOURCE_ID,
    origin: FAA_ORIGIN,
    key,
    references: [],
    correlation: [],
    status: "actual",
    op: "alert",
    kind: { code: PROGRAM_KIND, label: kindLabel(PROGRAM_KIND) },
    categories: [categoryOf(PROGRAM_KIND)],
    severity: "moderate",
    // A ground stop holds the flights now. A ground delay program gives each flight a later departure time.
    urgency: body.program === "ground-stop" ? "immediate" : "expected",
    certainty: "observed",
    response: ["monitor"],
    sent,
    received: observation.fetched,
    effective: sent,
    onset: sent,
    areas: [{ type: "circle", center: point, radiusKm: AIRPORT_RADIUS_KM }],
    about: [{ system: AIRPORT_SYSTEM, id: body.airport }],
    sender: FAA_SENDER,
    headline: `${title} at the airport ${body.airport}`,
    ...(facts.length === 0 ? {} : { description: facts.join(" ") }),
    web: STATUS_PAGE,
    observation: observation.id,
    parameters: Object.fromEntries(
      [
        ["program", body.program],
        ["airport", body.airport],
        ["reason", body.reason],
        ["averageDelay", body.averageDelay],
        ["maximumDelay", body.maximumDelay],
        ["endTime", body.endTime],
      ].flatMap(([name, value]) => (value === undefined ? [] : [[name, [value]]])),
    ),
  };
}
