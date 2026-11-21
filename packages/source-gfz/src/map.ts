/**
 * The map function of the GFZ source. One observation is one 3-hour interval of the planetary index Kp of GFZ, and
 * the fetch gives its body. A value of the scale G1 or more gives one report. A lower value gives no report.
 *
 * GFZ is a second origin of the geomagnetic storms, apart from the NOAA. The reports of the intervals of one storm share
 * a correlation key, the start of their run, so they are one incident. The link rule of the merge (rule 3) joins
 * that incident with the reports of the SWPC.
 */

import { categoryOf, kindLabel, Problems, reportId, type Area, type Instant, type MapResult, type Observation, type Report, type SourceId } from "@mark1russell7/alerts";
import { GEOMAGNETIC_STORM_KIND, geomagneticLevel, kpText, POLEWARD_BY_LEVEL, polarCaps, SEVERITY_BY_LEVEL } from "@mark1russell7/alerts-space-weather";
import { isRecord } from "@mark1russell7/optional/read";
import { errorMessage } from "@mark1russell7/text";

/** The id of this source. */
export const SOURCE_ID = "gfz" as SourceId;

/** The id of the origin of the reports: GFZ, an authority apart from the NOAA. */
export const GFZ_ORIGIN = "gfz";

/** The kind codes of this source. */
export const GFZ_KINDS: readonly string[] = [GEOMAGNETIC_STORM_KIND];

/** The sender of each report. */
export const GFZ_SENDER = "GFZ German Research Centre for Geosciences";

/** The credit that the terms of GFZ ask for. The data is under the license `GFZ_LICENSE`. */
export const GFZ_CREDIT = "GFZ German Research Centre for Geosciences, https://kp.gfz.de";

/** The license of the data, as the field `meta.license` of each answer gives it. */
export const GFZ_LICENSE = "CC BY 4.0";

/** The page of the index Kp for a person. */
export const GFZ_PAGE = "https://kp.gfz.de/en/";

/** The system of the correlation key that joins the intervals of one storm. The id is the start of the run. */
export const RUN_SYSTEM = "gfz-kp-run";

/**
 * The system of the code of one interval. The code is the start of the interval. A later value of the interval names
 * the same code, so the rule of the copies of the merge replaces the earlier value at once.
 */
export const INTERVAL_SYSTEM = "gfz-kp-interval";

/** The length of one interval of the index Kp, in milliseconds. */
export const INTERVAL_MS: number = 3 * 3_600_000;

/**
 * The time that a report stays in effect after the start of its interval: the interval and one more. The value of the
 * next interval comes some time after its start, so a storm stays one incident across the change of the interval.
 */
export const REPORT_LIFE_MS: number = 2 * INTERVAL_MS;

/**
 * The fields of the body of an observation, in this order. The fields `datetime`, `Kp` and `status` are the values
 * of the answer for one interval. The fetch adds `run`, the start of the run of the interval, for a value of G1 or more.
 */
export const INTERVAL_FIELDS = ["datetime", "Kp", "status", "run"] as const;

/** The status of each value, as GFZ writes it. */
export const STATUSES: Readonly<Record<string, string>> = { pre: "preliminary", def: "definitive" };

/**
 * This function gives the time of the start of an interval. The value is a UTC time at an hour that is a multiple of
 * 3, for example `2026-11-16T03:00:00Z`. Each other value gives `undefined`.
 */
export function intervalStart(value: unknown): Instant | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/.test(value)) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time % INTERVAL_MS !== 0) return undefined;
  // The round trip refuses a day that the calendar does not have, for example 31 November.
  return new Date(time).toISOString() === value.replace("Z", ".000Z") ? time : undefined;
}

/** This function gives the text of a time as GFZ writes it: `2026-11-16T03:00:00Z`. */
export function intervalText(time: Instant): string {
  return `${new Date(time).toISOString().slice(0, 19)}Z`;
}

/** This function gives the value of Kp of a field, from 0 to 9. Each other value gives `undefined`. */
export function kpOf(value: unknown): number | undefined {
  return typeof value === "number" && geomagneticLevel(value) !== undefined ? value : undefined;
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
  // The fetch gives the whole answer as one observation when the answer is not the series, or its license changed.
  if (!isRecord(fields) || typeof fields["datetime"] !== "string") {
    return { reports: [], problems: [{ path: "", message: "the observation is not one interval of the series of GFZ: the format or the license changed", fatal: true }] };
  }
  const problems = new Problems();
  const start = intervalStart(fields["datetime"]);
  if (start === undefined) problems.add("datetime", `the value ${JSON.stringify(fields["datetime"])} is not the start of a 3-hour interval: the map makes no report`, "fatal");
  const kp = kpOf(fields["Kp"]);
  if (kp === undefined) problems.add("Kp", `the value ${JSON.stringify(fields["Kp"])} is not a value of Kp from 0 to 9: the map makes no report`, "fatal");
  if (start === undefined || kp === undefined) return { reports: [], problems: problems.list };
  const level = geomagneticLevel(kp)!;
  const status = typeof fields["status"] === "string" && Object.hasOwn(STATUSES, fields["status"]) ? fields["status"] : undefined;
  if (status === undefined) problems.add("status", `the status ${JSON.stringify(fields["status"])} is not known: the report has no status`);
  if (level === 0) return { reports: [], problems: problems.list };

  let run = intervalStart(fields["run"]);
  if (run === undefined || run > start) {
    problems.add("run", `the value ${JSON.stringify(fields["run"])} is not the start of a run up to this interval: the run starts at the interval`);
    run = start;
  }
  return { reports: [reportOf(observation, { start, kp, level, status, run })], problems: problems.list };
}

/** This function gives the report of one interval of the scale G1 or more. */
function reportOf(observation: Observation, parts: { readonly start: Instant; readonly kp: number; readonly level: 1 | 2 | 3 | 4 | 5; readonly status: string | undefined; readonly run: Instant }): Report {
  const { start, kp, level, status, run } = parts;
  const datetime = intervalText(start);
  const text = kpText(kp)!;
  const latitude = POLEWARD_BY_LEVEL[level]!;
  const end = start + INTERVAL_MS;
  const key = `${datetime}@${observation.id}`;
  // The answer has no time of issue. The fetch time of the first answer with this value is the closest time, and a later value has a later one.
  const sent = observation.fetched;
  const code: Area = { type: "code", system: INTERVAL_SYSTEM, code: datetime, block: "caps" };
  const hours = (time: Instant): string => new Date(time).toISOString().slice(11, 16);
  return {
    id: reportId({ source: SOURCE_ID, key, sent }),
    source: SOURCE_ID,
    origin: GFZ_ORIGIN,
    key,
    references: [],
    correlation: [{ system: RUN_SYSTEM, id: intervalText(run) }],
    status: "actual",
    op: "alert",
    kind: { code: GEOMAGNETIC_STORM_KIND, label: kindLabel(GEOMAGNETIC_STORM_KIND) },
    categories: [categoryOf(GEOMAGNETIC_STORM_KIND)],
    severity: SEVERITY_BY_LEVEL[level]!,
    // The value of an interval that has not ended tells of a storm now.
    urgency: end > observation.fetched ? "immediate" : "past",
    certainty: "observed",
    response: [],
    sent,
    received: observation.fetched,
    onset: start,
    expires: start + REPORT_LIFE_MS,
    areas: [...polarCaps(latitude, "caps"), code],
    areaText: `Poleward of ${latitude} degrees geomagnetic latitude`,
    about: [],
    sender: GFZ_SENDER,
    headline: `Geomagnetic storm G${level}: Kp ${text} from ${hours(start)} to ${hours(end)} UTC on ${datetime.slice(0, 10)}`,
    web: GFZ_PAGE,
    observation: observation.id,
    parameters: {
      kp: [text],
      scale: [`G${level}`],
      interval: [datetime],
      run: [intervalText(run)],
      polewardOf: [String(latitude)],
      ...(status === undefined ? {} : { status: [STATUSES[status]!] }),
      credit: [GFZ_CREDIT],
      license: [GFZ_LICENSE],
    },
  };
}
