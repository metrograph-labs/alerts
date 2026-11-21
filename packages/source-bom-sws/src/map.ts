/**
 * The map function of the BoM SWS source. One observation is one item of an answer of the space weather API of the
 * Australian Bureau of Meteorology (BoM). The item is a magnetic alert, a geophysical warning, or the newest K index of the
 * Australian region. The fetch gives its body.
 *
 * - A magnetic alert tells of a current geomagnetic storm at a level of the NOAA scale G. It gives one report.
 * - A geophysical warning tells of the activity of each day of its period. Each day of a storm level gives one report.
 * - The K index gives no report. The canary check reads it.
 *
 * BoM is an origin apart from the NOAA and GFZ. The link rule of the merge (rule 3) joins its reports with the reports
 * of the SWPC and GFZ for one storm.
 *
 * BoM permits personal use with no commercial use, under the license CC BY 4.0 with its attribution (`BOM_CREDIT`).
 * The reports hold only facts: the level, the times, the cause and the short forecast words. They hold no comments of the
 * forecaster. The repository holds no answer of the API: the tests use answers made from the documented schema.
 */

import { categoryOf, kindLabel, Problems, reportId, type Area, type Instant, type MapResult, type Observation, type Report, type SourceId } from "@mark1russell7/alerts";
import { GEOMAGNETIC_STORM_KIND, POLEWARD_BY_LEVEL, polarCaps, SEVERITY_BY_LEVEL } from "@mark1russell7/alerts-space-weather";
import { isRecord, type Fields } from "@mark1russell7/optional/read";
import { errorMessage } from "@mark1russell7/text";

/** The id of this source. */
export const SOURCE_ID = "bom-sws" as SourceId;

/** The id of the origin of the reports: the Bureau of Meteorology of Australia, an authority apart from the NOAA. */
export const BOM_ORIGIN = "bom";

/** The kind codes of this source. */
export const BOM_SWS_KINDS: readonly string[] = [GEOMAGNETIC_STORM_KIND];

/** The sender of each report. */
export const BOM_SENDER = "Bureau of Meteorology, Space Weather Services";

/**
 * The attribution that BoM gave for its data. BoM permits personal use with no commercial use under the license CC BY 4.0,
 * with these words.
 */
export const BOM_CREDIT = "Bureau of Meteorology, © Commonwealth of Australia. Licensed from the Commonwealth of Australia under a Creative Commons Attribution 4.0 International licence.";

/** The page of the space weather services of BoM for a person. */
export const BOM_PAGE = "https://www.sws.bom.gov.au/";

/** The region of the alerts, the warnings and the K index. */
export const REGION = "Australian region";

/** The methods of the API that the source asks, and the name of each in the body of an observation. */
export const METHODS = { alert: "get-mag-alert", warning: "get-mag-warning", kIndex: "get-k-index" } as const;

/** The name of one method of `METHODS`. */
export type Method = (typeof METHODS)[keyof typeof METHODS];

/**
 * The levels of the NOAA scale G for each description of a magnetic alert. The API documents the description with
 * the values `minor`, `major` and `severe`, and its example gives `minor` for the level 1. In the older NOAA categories,
 * a minor storm is K 5 and a major storm is K 6. A severe storm is K 7 or more. The map of each alert examines
 * the table, and a difference gives a note.
 */
export const DESCRIPTION_LEVELS: Readonly<Record<string, readonly [number, number]>> = { minor: [1, 1], major: [2, 2], severe: [3, 5] };

/**
 * The system of the correlation key and of the code of one magnetic alert. The id and the code are the start of the
 * alert. A changed alert with the same start names the same code at a later sent time. Thus the rule of the copies
 * replaces the earlier alert.
 */
export const ALERT_SYSTEM = "bom-sws-alert";

/** The system of the correlation key that joins the days of one warning. The id is the time of issue of the warning. */
export const WARNING_SYSTEM = "bom-sws-warning";

/**
 * The system of the correlation key and of the code of one day of the warnings. The id and the code are the date. A
 * later warning that names the day again names the same code, so the rule of the copies replaces the earlier forecast.
 */
export const WARNING_DAY_SYSTEM = "bom-sws-warning-day";

/** The length of one day, in milliseconds. */
export const DAY_MS = 86_400_000;

/** The fields of the body of an observation: the method of the answer, and one item of its list `data`. */
export interface ItemBody {
  readonly method: Method;
  readonly item: Readonly<Record<string, unknown>>;
}

/**
 * This function gives the time of a text of the API: a UTC time `yyyy-mm-dd hh:mm:ss`, for example
 * `2026-11-17 18:00:00`. Each other value gives `undefined`.
 */
export function bomTime(value: unknown): Instant | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return undefined;
  const iso = `${value.replace(" ", "T")}.000Z`;
  const time = Date.parse(iso);
  // The round trip refuses a time that the calendar does not have, for example 31 November or 24:00.
  return Number.isFinite(time) && new Date(time).toISOString() === iso ? time : undefined;
}

/** This function gives the start of a date of the API: a UTC date `yyyy-mm-dd`. Each other value gives `undefined`. */
export function bomDate(value: unknown): Instant | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? bomTime(`${value} 00:00:00`) : undefined;
}

/** This function gives the text of a time as the API writes it: `2026-11-17 18:00:00`. */
export function bomTimeText(time: Instant): string {
  return new Date(time).toISOString().slice(0, 19).replace("T", " ");
}

/** This function gives the level of the NOAA scale G of an alert: an integer from 1 to 5. Each other value gives `undefined`. */
export function alertLevel(value: unknown): 1 | 2 | 3 | 4 | 5 | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5 ? (value as 1 | 2 | 3 | 4 | 5) : undefined;
}

/**
 * The level of the NOAA scale G of a forecast text of a warning, for example `Unsettled to minor storm`. The level is
 * the highest storm that the text names. Minor is G1, major is G2 and severe is G3, the lowest level of the word.
 */
export interface ForecastLevel {
  /** The level, from 0 to 3. The level 0 is a forecast with no storm. */
  readonly level: 0 | 1 | 2 | 3;
  /** True: the text has no word of the activity levels of BoM, or a storm with no level word. Then the format changed. */
  readonly unknown: boolean;
}

const STORM_WORDS: readonly (readonly [RegExp, 1 | 2 | 3])[] = [
  [/\bsevere\b/i, 3],
  [/\bmajor\b/i, 2],
  [/\bminor\b/i, 1],
];

/** This function gives the level of a forecast text of a warning (`ForecastLevel`). */
export function forecastLevel(text: string): ForecastLevel {
  if (/\bstorms?\b/i.test(text)) {
    const found = STORM_WORDS.find(([word]) => word.test(text));
    return found === undefined ? { level: 1, unknown: true } : { level: found[1], unknown: false };
  }
  return { level: 0, unknown: !/\b(quiet|unsettled|active)\b/i.test(text) };
}

/**
 * This function tells if an item of an answer has the facts that its map needs. An alert needs a level, and a warning
 * needs a time of issue and a list of days. The K index needs the start of its period. The fetch gives
 * `complete: false` for an answer with an item that is not valid, so the reports of the earlier fetches stay.
 */
export function isValidItem(method: Method, item: Fields): boolean {
  switch (method) {
    case METHODS.alert:
      return alertLevel(item["g_scale"]) !== undefined;
    case METHODS.warning:
      return bomTime(item["issue_time"]) !== undefined && Array.isArray(item["activity"]);
    case METHODS.kIndex:
      return bomTime(item["valid_time"]) !== undefined && typeof item["index"] === "number";
  }
}

/** This function reads the body of an observation. A body that is not one item of a method of `METHODS` gives `undefined`. */
export function readItemBody(body: string): ItemBody | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed["item"])) return undefined;
  const method = Object.values(METHODS).find((name) => name === parsed["method"]);
  return method === undefined ? undefined : { method, item: parsed["item"] };
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
  const body = readItemBody(observation.body);
  // The fetch gives the whole answer as one observation when the answer has no list `data`.
  if (body === undefined) {
    return { reports: [], problems: [{ path: "", message: "the observation is not one item of an answer of the BoM API: the format changed", fatal: true }] };
  }
  switch (body.method) {
    case METHODS.alert:
      return mapAlert(observation, body.item);
    case METHODS.warning:
      return mapWarning(observation, body.item);
    case METHODS.kIndex:
      return { reports: [], problems: [] };
  }
}

/** The facts of a report that the alerts and the days of the warnings share. */
interface Facts {
  readonly key: string;
  readonly sent: Instant;
  readonly level: 1 | 2 | 3 | 4 | 5;
  readonly correlation: Report["correlation"];
  readonly code: Area;
  readonly urgency: Report["urgency"];
  readonly certainty: Report["certainty"];
  readonly onset?: Instant;
  readonly expires?: Instant;
  readonly headline: string;
  readonly parameters: Report["parameters"];
}

/** This function gives the report of a geomagnetic storm from its facts. */
function reportOf(observation: Observation, facts: Facts): Report {
  const latitude = POLEWARD_BY_LEVEL[facts.level]!;
  return {
    id: reportId({ source: SOURCE_ID, key: facts.key, sent: facts.sent }),
    source: SOURCE_ID,
    origin: BOM_ORIGIN,
    key: facts.key,
    references: [],
    correlation: facts.correlation,
    status: "actual",
    op: "alert",
    kind: { code: GEOMAGNETIC_STORM_KIND, label: kindLabel(GEOMAGNETIC_STORM_KIND) },
    categories: [categoryOf(GEOMAGNETIC_STORM_KIND)],
    severity: SEVERITY_BY_LEVEL[facts.level]!,
    urgency: facts.urgency,
    certainty: facts.certainty,
    response: [],
    sent: facts.sent,
    received: observation.fetched,
    ...(facts.onset === undefined ? {} : { onset: facts.onset }),
    ...(facts.expires === undefined ? {} : { expires: facts.expires }),
    areas: [...polarCaps(latitude, "caps"), facts.code],
    areaText: `Poleward of ${latitude} degrees geomagnetic latitude`,
    about: [],
    sender: BOM_SENDER,
    headline: facts.headline,
    web: BOM_PAGE,
    observation: observation.id,
    parameters: { ...facts.parameters, polewardOf: [String(latitude)], region: [REGION], credit: [BOM_CREDIT] },
  };
}

const clock = (time: Instant): string => new Date(time).toISOString().slice(11, 16);

/**
 * This function maps one magnetic alert: a current storm at the level `g_scale`. The report starts at `start_time` and
 * ends at `valid_until`. The alert has no time of issue. The fetch time of the first answer with this body is the
 * closest time, and a changed alert has a later one. Thus the rule of the copies replaces the earlier alert: two reports
 * with one sent time state nothing. An alert with no valid start starts at the fetch.
 */
function mapAlert(observation: Observation, item: Fields): MapResult {
  const problems = new Problems();
  const level = alertLevel(item["g_scale"]);
  if (level === undefined) {
    problems.add("g_scale", `the value ${JSON.stringify(item["g_scale"])} is not a level of the scale G from 1 to 5: the map makes no report`, "fatal");
    return { reports: [], problems: problems.list };
  }
  const start = bomTime(item["start_time"]);
  if (start === undefined) problems.add("start_time", `the value ${JSON.stringify(item["start_time"])} is not a time: the report starts at the fetch`);
  const end = bomTime(item["valid_until"]);
  if (end === undefined) problems.add("valid_until", `the value ${JSON.stringify(item["valid_until"])} is not a time: the report has no end`);
  const description = typeof item["description"] === "string" ? item["description"] : undefined;
  const span = description === undefined ? undefined : DESCRIPTION_LEVELS[description];
  if (span === undefined || level < span[0] || level > span[1]) {
    problems.add("description", `the description ${JSON.stringify(item["description"])} does not agree with the level G${level} by DESCRIPTION_LEVELS: the report has the level`, "note");
  }
  const sent = observation.fetched;
  const onset = start ?? sent;
  const startText = start === undefined ? undefined : bomTimeText(start);
  const id = startText ?? `fetched ${bomTimeText(observation.fetched)}`;
  const facts: Facts = {
    key: `alert ${id}@${observation.id}`,
    sent,
    level,
    correlation: [{ system: ALERT_SYSTEM, id }],
    code: { type: "code", system: ALERT_SYSTEM, code: id, block: "caps" },
    urgency: end === undefined || end > observation.fetched ? "immediate" : "past",
    certainty: "observed",
    onset,
    ...(end === undefined ? {} : { expires: end }),
    headline: `Geomagnetic storm G${level}: the magnetic alert of the ${REGION} since ${clock(onset)} UTC on ${bomTimeText(onset).slice(0, 10)}`,
    parameters: {
      scale: [`G${level}`],
      ...(description === undefined ? {} : { description: [description] }),
      ...(startText === undefined ? {} : { start: [startText] }),
      ...(end === undefined ? {} : { validUntil: [bomTimeText(end)] }),
    },
  };
  return { reports: [reportOf(observation, facts)], problems: problems.list };
}

/**
 * This function maps one geophysical warning. Each day of its list `activity` with a storm in its forecast gives one
 * report, with the level of `forecastLevel`. A day with no storm gives no report. The report of a day ends at the end
 * of the day. A later warning that has the day again replaces it by the rule of the copies.
 */
function mapWarning(observation: Observation, item: Fields): MapResult {
  const problems = new Problems();
  const issued = bomTime(item["issue_time"]);
  const activity = item["activity"];
  if (issued === undefined || !Array.isArray(activity)) {
    if (issued === undefined) problems.add("issue_time", `the value ${JSON.stringify(item["issue_time"])} is not a time: the map makes no report`, "fatal");
    if (!Array.isArray(activity)) problems.add("activity", "the warning has no list of days: the map makes no report", "fatal");
    return { reports: [], problems: problems.list };
  }
  const issuedText = bomTimeText(issued);
  const cause = typeof item["cause"] === "string" && item["cause"] !== "" ? item["cause"] : undefined;
  const reports: Report[] = [];
  activity.forEach((day: unknown, index) => {
    const path = `activity[${index}]`;
    const date = isRecord(day) ? day["date"] : undefined;
    const forecast = isRecord(day) ? day["forecast"] : undefined;
    const start = bomDate(date);
    if (start === undefined || typeof forecast !== "string") {
      problems.add(path, `the day ${JSON.stringify(day)} has no date or no forecast: the map makes no report for it`);
      return;
    }
    const { level, unknown } = forecastLevel(forecast);
    if (unknown) {
      const effect = level === 0 ? "the map makes no report for the day" : "names a storm with no level word: the report has the level G1";
      problems.add(`${path}.forecast`, level === 0 ? `the forecast ${JSON.stringify(forecast)} has no word of the activity levels: ${effect}` : `the forecast ${JSON.stringify(forecast)} ${effect}`);
    }
    if (level === 0) return;
    const dateText = date as string;
    reports.push(
      reportOf(observation, {
        key: `warning ${issuedText} ${dateText}@${observation.id}`,
        sent: issued,
        level,
        correlation: [
          { system: WARNING_SYSTEM, id: issuedText },
          { system: WARNING_DAY_SYSTEM, id: dateText },
        ],
        code: { type: "code", system: WARNING_DAY_SYSTEM, code: dateText, block: "caps" },
        urgency: start > observation.fetched ? "future" : "expected",
        certainty: "likely",
        onset: start,
        expires: start + DAY_MS,
        headline: `Geomagnetic storm G${level} likely on ${dateText} in the ${REGION}: ${forecast}`,
        parameters: {
          scale: [`G${level}`],
          forecast: [forecast],
          day: [dateText],
          warning: [issuedText],
          ...(cause === undefined ? {} : { cause: [cause] }),
        },
      }),
    );
  });
  return { reports, problems: problems.list };
}
