/**
 * The map function of the Digitraffic rail source. One observation holds the counts of the passenger trains of Finland at
 * one time. The counts are the running trains, the late running trains and the cancelled trains of the day. Fintraffic
 * publishes the data through Digitraffic. The fetch gives the counts. The map gives no report. It gives one indicator
 * reading for each measure and each series.
 *
 * The counts are for the whole country. Thus the area of each reading is the code of Finland. A drop of the running trains
 * or a rise of the late or cancelled trains tells of a disruption of the railways. A storm or a power cut can cause it.
 */

import { Problems, type IndicatorArea, type Instant, type MapResult, type Observation, type Reading, type SourceId } from "@mark1russell7/alerts";
import { isRecord } from "@mark1russell7/optional/read";
import { errorMessage } from "@mark1russell7/text";

/** The id of this source. */
export const SOURCE_ID = "digitraffic-rail" as SourceId;

/** The origin of the data: Fintraffic, the traffic control company of Finland, which runs Digitraffic. */
export const FINTRAFFIC_ORIGIN = "fintraffic";

/** The license of the rail data of Digitraffic. The credit is "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY". */
export const RAIL_LICENSE = "CC BY 4.0";

/** The area of each reading: Finland, by its ISO 3166-1 code. */
export const RAIL_AREA: IndicatorArea = { type: "code", system: "iso3166-1", code: "FI" };

/** The unit of each value: a count of trains. */
export const TRAIN_UNIT = "{train}";

/** The series of each measure: one for each passenger category of Digitraffic, with the category name of the API. */
export const SERIES_CATEGORIES = { commuter: "Commuter", "long-distance": "Long-distance" } as const;

/** The id of a series. */
export type SeriesId = keyof typeof SERIES_CATEGORIES;

/** The ids of the series, in their order in a body. */
export const SERIES_IDS: readonly SeriesId[] = ["commuter", "long-distance"];

/** The measures of each series, in their order. */
export const MEASURE_IDS = ["running", "late", "cancelled"] as const;

/** The id of a measure. */
export type MeasureId = (typeof MEASURE_IDS)[number];

/** The counts of one series. */
export type SeriesCounts = Readonly<Record<MeasureId, number>>;

/** The fields of the body of one observation, in their order. */
export const RAIL_FIELDS = ["newest", "date", "license", "trains", "series"] as const;

/** The body of one observation. */
export interface RailBody {
  /** The newest actual time of a running train, in ISO 8601 with milliseconds, or `null` when no running train has one. */
  readonly newest: string | null;
  /** The departure date of the counted cancellations in Finland, as `YYYY-MM-DD`. */
  readonly date: string;
  readonly license: string;
  /** The count of the running trains of all categories, with freight trains and shunting. */
  readonly trains: number;
  readonly series: Readonly<Record<SeriesId, SeriesCounts>>;
}

/** The pattern of a date of the body. */
const DATE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;

/** This function gives the body of one observation: the JSON text of the fields of `RAIL_FIELDS`, in that order. */
export function railBody(newest: Instant | undefined, date: string, trains: number, series: Readonly<Record<SeriesId, SeriesCounts>>): string {
  const ordered = Object.fromEntries(SERIES_IDS.map((id) => [id, Object.fromEntries(MEASURE_IDS.map((measure) => [measure, series[id][measure]]))])) as unknown as RailBody["series"];
  const body: RailBody = { newest: newest === undefined ? null : new Date(newest).toISOString(), date, license: RAIL_LICENSE, trains, series: ordered };
  return JSON.stringify(body);
}

/** This function gives the newest actual time of a body. It gives `undefined` for a body with no time, and for a body of a different source. */
export function newestOf(body: string): Instant | undefined {
  try {
    const fields: unknown = JSON.parse(body);
    if (!isRecord(fields) || typeof fields["newest"] !== "string") return undefined;
    const time = Date.parse(fields["newest"]);
    return Number.isFinite(time) && new Date(time).toISOString() === fields["newest"] ? time : undefined;
  } catch {
    return undefined;
  }
}

/** This function tells if a value is a count: a whole number of 0 or more. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
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
    return { reports: [], problems: [{ path: "", message: "the body is not JSON", fatal: true }] };
  }
  if (!isRecord(fields) || !isRecord(fields["series"])) {
    return { reports: [], problems: [{ path: "", message: "the observation is not the train counts of Digitraffic", fatal: true }] };
  }
  const problems = new Problems();
  const newest = newestOf(observation.body);
  if (fields["newest"] !== null && newest === undefined) problems.add("newest", `the value ${JSON.stringify(fields["newest"])} is not a time in ISO 8601: the map gives no reading`, "fatal");
  if (typeof fields["date"] !== "string" || !DATE_PATTERN.test(fields["date"])) problems.add("date", `the value ${JSON.stringify(fields["date"])} is not a date: the map gives no reading`, "fatal");
  if (fields["license"] !== RAIL_LICENSE) problems.add("license", "the license is not the license of Digitraffic: the map gives no reading", "fatal");
  if (!isCount(fields["trains"])) problems.add("trains", `the value ${JSON.stringify(fields["trains"])} is not a count: the map gives no reading`, "fatal");
  const series = fields["series"];
  let passengers = 0;
  for (const id of SERIES_IDS) {
    const counts = series[id];
    if (!isRecord(counts)) {
      problems.add(`series.${id}`, "the series has no counts: the map gives no reading", "fatal");
      continue;
    }
    for (const measure of MEASURE_IDS) {
      if (!isCount(counts[measure])) problems.add(`series.${id}.${measure}`, `the value ${JSON.stringify(counts[measure])} is not a count: the map gives no reading`, "fatal");
    }
    if (isCount(counts["running"]) && isCount(counts["late"]) && counts["late"] > counts["running"]) {
      problems.add(`series.${id}.late`, `the count of late trains ${String(counts["late"])} is more than the count of running trains ${String(counts["running"])}: the map gives no reading`, "fatal");
    }
    if (isCount(counts["running"])) passengers += counts["running"];
  }
  if (isCount(fields["trains"]) && passengers > fields["trains"]) problems.add("trains", `the count of all running trains ${String(fields["trains"])} is less than the count of the passenger trains ${String(passengers)}: the map gives no reading`, "fatal");
  if (problems.fatal > 0) return { reports: [], problems: problems.list };

  // With no running train, the body has no actual time. Then the time of the fetch is the time of the counts. An actual
  // time after the fetch is a difference of the two clocks: then the time of the fetch is the time of the counts.
  const at = Math.min(newest ?? observation.fetched, observation.fetched);
  const readings: Reading[] = [];
  for (const id of SERIES_IDS) {
    const counts = series[id] as Record<MeasureId, number>;
    for (const measure of MEASURE_IDS) readings.push({ source: SOURCE_ID, measure, series: id, at, value: counts[measure], area: RAIL_AREA, observation: observation.id });
  }
  return { reports: [], problems: problems.list, readings };
}
