/**
 * The map function of the GFZ sources. One observation is one interval of an index of GFZ, and the fetch gives its
 * body. The index is Kp (3 hours), Hp60 (1 hour) or Hp30 (30 minutes). A value of G1 or more gives one report.
 *
 * GFZ is a second origin of the geomagnetic storms, apart from the NOAA. The reports of the intervals of one storm share
 * a correlation key, the start of their run, so they are one incident. The link rule of the merge (rule 3) joins
 * that incident with the reports of the SWPC.
 */

import { categoryOf, kindLabel, Problems, reportId, type Area, type Instant, type MapResult, type Observation, type Report, type SourceId } from "@mark1russell7/alerts";
import { GEOMAGNETIC_STORM_KIND, geomagneticLevel, KP_MAX, POLEWARD_BY_LEVEL, polarCaps, SEVERITY_BY_LEVEL, thirdsText } from "@mark1russell7/alerts-space-weather";
import { isRecord } from "@mark1russell7/optional/read";
import { errorMessage } from "@mark1russell7/text";

/** The id of the source of the index Kp. */
export const SOURCE_ID = "gfz" as SourceId;

/**
 * One index of the JSON service of GFZ, as data. Each index is one source with its own id. The functions of this
 * package that take an index work for each of them.
 */
export interface GfzIndex {
  /** The name of the index in the query and the name of its column in the answer, for example `Kp` or `Hp30`. */
  readonly name: string;
  /** The id of the source of the index. */
  readonly source: SourceId;
  /** The length of one interval, in milliseconds. */
  readonly intervalMs: number;
  /** True when the answer has the column `status`. The index Kp has it. Hp30 and Hp60 do not. */
  readonly status: boolean;
  /** True when the index has no upper limit. The indices Hp30 and Hp60 go above 9 in a large storm. */
  readonly open: boolean;
  /** The largest age of the start of the newest interval at its fetch, for the canary check. */
  readonly newestMaxAgeMs: number;
  /** The time that a report stays in effect after the start of its interval. */
  readonly reportLifeMs: number;
  /** The time between two fetches of the source, in milliseconds. */
  readonly pollMs: number;
}

const HOUR = 3_600_000;

/**
 * The planetary index Kp of each 3 hours. Its values go from 0 to 9, and each value has a status. A report stays in
 * effect for its interval and one more. The value of the next interval comes some time after its start, so a storm
 * stays one incident across the change of the interval.
 */
export const KP_INDEX: GfzIndex = { name: "Kp", source: SOURCE_ID, intervalMs: 3 * HOUR, status: true, open: false, newestMaxAgeMs: 6 * HOUR, reportLifeMs: 6 * HOUR, pollMs: 600_000 };

/**
 * The index Hp30 of each 30 minutes. It has the scale of Kp with no upper limit, so it shows a storm before the end
 * of its 3-hour interval of Kp. One read on 2026-11-25 had no value for the current interval. The limits of the age and
 * the life are a shortcut from that read. They end when the measure of the lag of each feed gives them (AL-14).
 */
export const HP30_INDEX: GfzIndex = { name: "Hp30", source: "gfz-hp30" as SourceId, intervalMs: HOUR / 2, status: false, open: true, newestMaxAgeMs: 2 * HOUR, reportLifeMs: 2.5 * HOUR, pollMs: 300_000 };

/** The index Hp60 of each hour. Its limits are those of Hp30 plus one interval, with the same shortcut (AL-14). */
export const HP60_INDEX: GfzIndex = { name: "Hp60", source: "gfz-hp60" as SourceId, intervalMs: HOUR, status: false, open: true, newestMaxAgeMs: 3 * HOUR, reportLifeMs: 4 * HOUR, pollMs: 300_000 };

/** The indices of GFZ that this package reads. */
export const GFZ_INDICES: readonly GfzIndex[] = [KP_INDEX, HP60_INDEX, HP30_INDEX];

/** This function gives the system of the correlation key of the runs of an index, for example `gfz-kp-run`. */
export function runSystemOf(index: GfzIndex): string {
  return `gfz-${index.name.toLowerCase()}-run`;
}

/** This function gives the system of the code of one interval of an index, for example `gfz-kp-interval`. */
export function intervalSystemOf(index: GfzIndex): string {
  return `gfz-${index.name.toLowerCase()}-interval`;
}

/**
 * This function gives the fields of the body of an observation of an index, in this order. The fields `datetime`, the
 * name of the index and `status` are the values of the answer for one interval. The index Hp30 has no `status`. The
 * fetch adds `run`, the start of the run of the interval, for a value of G1 or more.
 */
export function intervalFieldsOf(index: GfzIndex): readonly string[] {
  return ["datetime", index.name, ...(index.status ? ["status"] : []), "run"];
}

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

/** The system of the correlation key that joins the intervals of one storm of Kp. The id is the start of the run. */
export const RUN_SYSTEM: string = runSystemOf(KP_INDEX);

/**
 * The system of the code of one interval of Kp. The code is the start of the interval. A later value of the interval
 * names the same code, so the rule of the copies of the merge replaces the earlier value at once.
 */
export const INTERVAL_SYSTEM: string = intervalSystemOf(KP_INDEX);

/** The length of one interval of the index Kp, in milliseconds. */
export const INTERVAL_MS: number = KP_INDEX.intervalMs;

/** The time that a report of Kp stays in effect after the start of its interval: the interval and one more. */
export const REPORT_LIFE_MS: number = KP_INDEX.reportLifeMs;

/** The fields of the body of an observation of Kp, in this order: `intervalFieldsOf` of the index Kp. */
export const INTERVAL_FIELDS = ["datetime", "Kp", "status", "run"] as const;

/** The status of each value, as GFZ writes it. */
export const STATUSES: Readonly<Record<string, string>> = { pre: "preliminary", def: "definitive" };

/**
 * This function gives the time of the start of an interval of Kp. The value is a UTC time at an hour that is a
 * multiple of 3, for example `2026-11-16T03:00:00Z`. Each other value gives `undefined`.
 */
export function intervalStart(value: unknown): Instant | undefined {
  return intervalStartOf(KP_INDEX, value);
}

/**
 * This function gives the time of the start of an interval of an index. The value is a UTC time that is a multiple
 * of the interval, for example `2026-11-16T03:30:00Z` for Hp30. Each other value gives `undefined`.
 */
export function intervalStartOf(index: GfzIndex, value: unknown): Instant | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/.test(value)) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time % index.intervalMs !== 0) return undefined;
  // The round trip refuses a day that the calendar does not have, for example 31 November.
  return new Date(time).toISOString() === value.replace("Z", ".000Z") ? time : undefined;
}

/** This function gives the text of a time as GFZ writes it: `2026-11-16T03:00:00Z`. */
export function intervalText(time: Instant): string {
  return `${new Date(time).toISOString().slice(0, 19)}Z`;
}

/** This function gives the value of Kp of a field, from 0 to 9. Each other value gives `undefined`. */
export function kpOf(value: unknown): number | undefined {
  return valueOf(KP_INDEX, value);
}

/** This function gives the value of an index of a field: a number of 0 or more, and 9 or less for a closed index. */
export function valueOf(index: GfzIndex, value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return index.open || value <= KP_MAX ? value : undefined;
}

/** This function gives the level of the scale G of a value. A value above 9 of an open index has the level of 9. */
export function levelOf(value: number): 0 | 1 | 2 | 3 | 4 | 5 {
  return geomagneticLevel(Math.min(value, KP_MAX)) ?? 0;
}

/** This function maps one observation of the index Kp. It does not throw. A body that it does not understand gives a fatal problem. */
export function mapObservation(observation: Observation): MapResult {
  return mapIndexObservation(KP_INDEX, observation);
}

/** This function maps one observation of an index. It does not throw. A body that it does not understand gives a fatal problem. */
export function mapIndexObservation(index: GfzIndex, observation: Observation): MapResult {
  try {
    return mapOrThrow(index, observation);
  } catch (error) {
    return { reports: [], problems: [{ path: "", message: `the map function failed: ${errorMessage(error)}`, fatal: true }] };
  }
}

/** This function maps one observation, and can throw. `mapIndexObservation` catches each error. */
function mapOrThrow(index: GfzIndex, observation: Observation): MapResult {
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
  const start = intervalStartOf(index, fields["datetime"]);
  if (start === undefined) problems.add("datetime", `the value ${JSON.stringify(fields["datetime"])} is not the start of an interval of ${index.name}: the map makes no report`, "fatal");
  const value = valueOf(index, fields[index.name]);
  const range = index.open ? "of 0 or more" : "from 0 to 9";
  if (value === undefined) problems.add(index.name, `the value ${JSON.stringify(fields[index.name])} is not a value of ${index.name} ${range}: the map makes no report`, "fatal");
  if (start === undefined || value === undefined) return { reports: [], problems: problems.list };
  const level = levelOf(value);
  const status = typeof fields["status"] === "string" && Object.hasOwn(STATUSES, fields["status"]) ? fields["status"] : undefined;
  if (index.status && status === undefined) problems.add("status", `the status ${JSON.stringify(fields["status"])} is not known: the report has no status`);
  if (level === 0) return { reports: [], problems: problems.list };

  let run = intervalStartOf(index, fields["run"]);
  if (run === undefined || run > start) {
    problems.add("run", `the value ${JSON.stringify(fields["run"])} is not the start of a run up to this interval: the run starts at the interval`);
    run = start;
  }
  return { reports: [reportOf(index, observation, { start, value, level, status, run })], problems: problems.list };
}

/** This function gives the report of one interval of the scale G1 or more. */
function reportOf(index: GfzIndex, observation: Observation, parts: { readonly start: Instant; readonly value: number; readonly level: 1 | 2 | 3 | 4 | 5; readonly status: string | undefined; readonly run: Instant }): Report {
  const { start, value, level, status, run } = parts;
  const datetime = intervalText(start);
  const text = thirdsText(value)!;
  const latitude = POLEWARD_BY_LEVEL[level]!;
  const end = start + index.intervalMs;
  const key = `${datetime}@${observation.id}`;
  // The answer has no time of issue. The fetch time of the first answer with this value is the closest time, and a later value has a later one.
  const sent = observation.fetched;
  const code: Area = { type: "code", system: intervalSystemOf(index), code: datetime, block: "caps" };
  const hours = (time: Instant): string => new Date(time).toISOString().slice(11, 16);
  return {
    id: reportId({ source: index.source, key, sent }),
    source: index.source,
    origin: GFZ_ORIGIN,
    key,
    references: [],
    correlation: [{ system: runSystemOf(index), id: intervalText(run) }],
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
    expires: start + index.reportLifeMs,
    areas: [...polarCaps(latitude, "caps"), code],
    areaText: `Poleward of ${latitude} degrees geomagnetic latitude`,
    about: [],
    sender: GFZ_SENDER,
    headline: `Geomagnetic storm G${level}: ${index.name} ${text} from ${hours(start)} to ${hours(end)} UTC on ${datetime.slice(0, 10)}`,
    web: GFZ_PAGE,
    observation: observation.id,
    parameters: {
      [index.name.toLowerCase()]: [text],
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
