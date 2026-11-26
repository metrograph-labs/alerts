/**
 * The map function of the NDW source. NDW is the national road data portal of the Netherlands. The fetch gives two kinds
 * of body. The body of the counts holds the count of the valid records of each group in one situation publication. The
 * map gives one indicator reading for each measure of it: the count of a group, and the count of all valid records. The
 * body of one record gives one report: the module `record.ts` maps it.
 *
 * The counts are for the whole country. Thus the area of each reading is the code of the Netherlands. A rise of the
 * accidents, the obstructions or the closures tells of a disruption of the roads, for example in a storm.
 */

import { Problems, type IndicatorArea, type Instant, type MapResult, type Observation, type Reading } from "@mark1russell7/alerts";
import { RECORD_GROUPS, type RecordGroup } from "@mark1russell7/alerts-format-datex";
import { isRecord } from "@mark1russell7/optional/read";
import { errorMessage } from "@mark1russell7/text";

import { NDW_COUNTRY, NDW_LICENSE, SOURCE_ID } from "./ids.ts";
import { isRecordBody, mapRecord } from "./record.ts";

export { NDW_COUNTRY, NDW_LICENSE, NDW_ORIGIN, SOURCE_ID } from "./ids.ts";

/** The id of the one series of each measure: the whole country. */
export const SERIES = "nl";

/** The area of each reading: the Netherlands, by its ISO 3166-1 code. */
export const NDW_AREA: IndicatorArea = { type: "code", system: "iso3166-1", code: "NL" };

/** The unit of each value: a count of situation records. */
export const RECORD_UNIT = "{record}";

/** The id of the measure of all valid records. */
export const ALL_RECORDS = "records";

/** The id of the measure of each group. The group `other` has no measure of its own: the measure of all records counts it. */
export const GROUP_MEASURES: Readonly<Record<Exclude<RecordGroup, "other">, string>> = {
  accident: "accidents",
  congestion: "congestion",
  obstruction: "obstructions",
  closure: "closures",
  works: "works",
  conditions: "conditions",
};

/** The count of the valid records of each group, with `other`. */
export type GroupCounts = Readonly<Record<RecordGroup, number>>;

/** The fields of the body of one publication, in their order. */
export const COUNT_FIELDS = ["published", "country", "license", "records", "groups", "unreal", "faults"] as const;

/** The body of one publication. */
export interface CountBody {
  /** The time of the publication, in ISO 8601 with milliseconds. */
  readonly published: string;
  readonly country: string;
  readonly license: string;
  /** The count of all valid records. */
  readonly records: number;
  readonly groups: GroupCounts;
  /** The count of the situations with an information status that is not `real`. */
  readonly unreal: number;
  /** The count of the records that the reader cannot read. */
  readonly faults: number;
}

/** This function gives the body of one publication: the JSON text of the fields of `COUNT_FIELDS`, in that order. The groups keep the order of `RECORD_GROUPS`. */
export function countBody(published: Instant, country: string, groups: GroupCounts, unreal: number, faults: number): string {
  const ordered = Object.fromEntries(RECORD_GROUPS.map((group) => [group, groups[group]])) as unknown as GroupCounts;
  const records = RECORD_GROUPS.reduce((total, group) => total + groups[group], 0);
  const body: CountBody = { published: new Date(published).toISOString(), country, license: NDW_LICENSE, records, groups: ordered, unreal, faults };
  return JSON.stringify(body);
}

/** This function gives the time of the publication of a body, or `undefined` for a body that is not one publication. */
export function publishedOf(body: string): Instant | undefined {
  try {
    const fields: unknown = JSON.parse(body);
    if (!isRecord(fields) || typeof fields["published"] !== "string") return undefined;
    const time = Date.parse(fields["published"]);
    return Number.isFinite(time) && new Date(time).toISOString() === fields["published"] ? time : undefined;
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
  if (isRecordBody(fields)) return mapRecord(observation, fields);
  if (!isRecord(fields) || !isRecord(fields["groups"])) {
    return { reports: [], problems: [{ path: "", message: "the observation is not the counts of one publication of NDW", fatal: true }] };
  }
  const problems = new Problems();
  const at = publishedOf(observation.body);
  if (at === undefined) problems.add("published", `the value ${JSON.stringify(fields["published"])} is not a time in ISO 8601: the map gives no reading`, "fatal");
  if (fields["country"] !== NDW_COUNTRY) problems.add("country", `the country ${JSON.stringify(fields["country"])} is not ${NDW_COUNTRY}: the map gives no reading`, "fatal");
  if (fields["license"] !== NDW_LICENSE) problems.add("license", "the license is not the license of NDW: the map gives no reading", "fatal");
  const groups = fields["groups"];
  for (const group of RECORD_GROUPS) {
    if (!isCount(groups[group])) problems.add(`groups.${group}`, `the value ${JSON.stringify(groups[group])} is not a count: the map gives no reading`, "fatal");
  }
  const records = fields["records"];
  const sum = RECORD_GROUPS.reduce((total, group) => total + (isCount(groups[group]) ? groups[group] : 0), 0);
  if (!isCount(records) || records !== sum) problems.add("records", `the count of all records ${JSON.stringify(records)} is not the sum of the groups ${String(sum)}: the map gives no reading`, "fatal");
  if (problems.fatal > 0 || at === undefined || !isCount(records)) return { reports: [], problems: problems.list };
  // A record that the reader cannot read is not in a count. Thus a count is low by the count of the faults.
  if (isCount(fields["faults"]) && fields["faults"] > 0) problems.add("faults", `${String(fields["faults"])} records of the publication have a fault: the counts do not hold them`);

  const reading = (measure: string, value: number): Reading => ({ source: SOURCE_ID, measure, series: SERIES, at, value, area: NDW_AREA, observation: observation.id });
  const readings = [
    reading(ALL_RECORDS, records),
    ...Object.entries(GROUP_MEASURES).map(([group, measure]) => reading(measure, groups[group] as number)),
  ];
  return { reports: [], problems: problems.list, readings };
}
