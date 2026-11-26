/**
 * The reader of the incident history of a status page of Atlassian Statuspage. The page documents two files for programs:
 * the list of the latest incidents (`/api/v2/incidents.json`) and the list of its components (`/api/v2/components.json`).
 * The list of incidents holds the resolved incidents too, so a caller can measure the down time of a past window.
 *
 * The list of incidents holds at most `HISTORY_LIMIT` incidents, in the order of their last change, the newest first.
 * Thus a full list does not tell of an incident with an older last change. The reader gives the time of the last change
 * of each incident, so the caller can make its window shorter.
 *
 * A page also gives the JSON of its public history page (`/history.json`). Some pages stop crawlers under `/api/` but
 * not on this path. The file holds the incidents of some months, with no components (`readHistoryFile`).
 *
 * This module only reads the bodies. It sends no request and holds no statistics.
 */

import { arrayOf, isRecord, numberOf, textOf, timeOf, type Fields } from "@mark1russell7/optional/read";
import { plainText } from "@mark1russell7/text/plain-text";

/** The path of the documented list of the latest incidents of a page. */
export const HISTORY_PATH = "/api/v2/incidents.json";

/** The path of the documented list of the components of a page. */
export const COMPONENTS_PATH = "/api/v2/components.json";

/** The most incidents that the list of a page holds. A list of this length can have older incidents that it does not show. */
export const HISTORY_LIMIT = 50;

/** One incident of the history of a page, with only the facts of a down time. */
export interface HistoryIncident {
  /** The id of the incident on the page. */
  readonly id: string;
  /** The impact of the incident: `none`, `minor`, `major`, `critical` or `maintenance`. */
  readonly impact: string;
  /** The time of the start of the incident: its field `started_at`, else its field `created_at`. */
  readonly start: number;
  /** The time of the end of the incident: its field `resolved_at`, or `undefined` when the incident is not resolved. */
  readonly end: number | undefined;
  /** The time of the last change of the incident: its field `updated_at`, else its field `created_at`, else the start. */
  readonly updated: number;
  /** True when the incident is a scheduled maintenance: it has a field `scheduled_for`. */
  readonly scheduled: boolean;
  /** The names of the components of the incident, with no name twice. */
  readonly components: readonly string[];
}

/** The incidents of one list, and the count of incidents that the reader skipped. */
export interface HistoryRead {
  /** The valid incidents, in the order of the list. */
  readonly incidents: readonly HistoryIncident[];
  /** The count of the items of the list. A count of `HISTORY_LIMIT` or more tells that older incidents can be missing. */
  readonly listed: number;
  /** The count of the items with no id, no impact or no time of start. The reader skips them. */
  readonly skipped: number;
}

/** This function gives the names of the components of one item, with no name twice. */
function namesOf(item: Fields): readonly string[] {
  const names = arrayOf(item, "components", (component) => (isRecord(component) ? textOf(component, "name") : undefined)) ?? [];
  return [...new Set(names)];
}

/** This function gives one incident of the history from one item of the list, or `undefined` when a fact is missing. */
function incidentOf(item: unknown): HistoryIncident | undefined {
  if (!isRecord(item)) return undefined;
  const id = textOf(item, "id");
  const impact = textOf(item, "impact");
  const created = timeOf(item, "created_at");
  const start = timeOf(item, "started_at") ?? created;
  if (id === undefined || impact === undefined || start === undefined) return undefined;
  return {
    id,
    impact,
    start,
    end: timeOf(item, "resolved_at"),
    updated: timeOf(item, "updated_at") ?? created ?? start,
    scheduled: item["scheduled_for"] !== undefined && item["scheduled_for"] !== null,
    components: namesOf(item),
  };
}

/**
 * This function reads the body of the list of incidents of a page. It gives `undefined` when the body is not JSON, or
 * when it has no list `incidents`.
 */
export function readHistory(body: string): HistoryRead | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const items = isRecord(parsed) ? parsed["incidents"] : undefined;
  if (!Array.isArray(items)) return undefined;
  const incidents = items.map(incidentOf).filter((incident): incident is HistoryIncident => incident !== undefined);
  return { incidents, listed: items.length, skipped: items.length - incidents.length };
}

/**
 * This function reads the body of the list of components of a page. It gives the name of each component that is not a
 * group, with no name twice. It gives `undefined` when the body is not JSON, or when it has no list `components`.
 */
export function readComponentNames(body: string): readonly string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const items = isRecord(parsed) ? parsed["components"] : undefined;
  if (!Array.isArray(items)) return undefined;
  const names = items.flatMap((item) => (isRecord(item) && item["group"] !== true && textOf(item, "name") !== undefined ? [textOf(item, "name")!] : []));
  return [...new Set(names)];
}

/**
 * The path of the JSON of the public history page of a page of Atlassian Statuspage. Some pages stop crawlers under
 * `/api/` in their `robots.txt` file, but not on this path.
 */
export const HISTORY_FILE_PATH = "/history.json";

/**
 * The offset from UTC of each abbreviation of a time zone that the reader of the history file knows, in minutes. The
 * abbreviation `CST` is the zone of North America. An item with a different abbreviation has no time, and the reader
 * skips it.
 */
export const ZONE_OFFSETS: Readonly<Record<string, number>> = {
  UTC: 0,
  GMT: 0,
  WET: 0,
  WEST: 60,
  CET: 60,
  CEST: 120,
  EET: 120,
  EEST: 180,
  JST: 540,
  AEST: 600,
  AEDT: 660,
  HST: -600,
  AKST: -540,
  AKDT: -480,
  PST: -480,
  PDT: -420,
  MST: -420,
  MDT: -360,
  CST: -360,
  CDT: -300,
  EST: -300,
  EDT: -240,
};

/** The incidents of the history file, and the period of the file. */
export interface HistoryFileRead extends HistoryRead {
  /** The start of the period of the file: its field `start_time`. The file holds each incident that ends in the period. */
  readonly since: number | undefined;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The plain text puts one space for each tag, thus `<var>1</var>,` gives `1 ,`. The pattern permits that space before a comma.
const SPAN_PATTERN = /^([A-Z][a-z]{2}) (\d{1,2}) ?, (\d{2}):(\d{2})(?: - (?:([A-Z][a-z]{2}) (\d{1,2}) ?, )?(\d{2}):(\d{2}))? ([A-Z]{2,5})$/u;

/** This function gives the year of a month near a known month. A month more than half a year away is in the next or the last year. */
function yearNear(month: number, knownMonth: number, knownYear: number): number {
  if (month - knownMonth > 6) return knownYear - 1;
  if (knownMonth - month > 6) return knownYear + 1;
  return knownYear;
}

/**
 * This function reads the text `timestamp` of one item of the history file, for example `Mar <var>1</var>, <var>10:00</var>
 * - <var>12:00</var> XST`. It strips the markup. The text has no year, thus the year comes from the month of the list.
 * A text with one time is an incident that is not resolved. The text gives one zone for the two times, thus a span over
 * a change of the clock can be one hour wrong.
 */
export function spanOf(timestamp: string, listMonth: number, listYear: number): { readonly start: number; readonly end: number | undefined } | undefined {
  // The plain text of `@mark1russell7/text` is linear in the length of the text, and it decodes a reference such as `&nbsp;`
  const match = SPAN_PATTERN.exec(plainText(timestamp) ?? "");
  if (match === null) return undefined;
  const offset = ZONE_OFFSETS[match[9]!];
  const month = MONTHS.indexOf(match[1]!);
  if (offset === undefined || month < 0) return undefined;
  const year = yearNear(month, listMonth, listYear);
  const start = Date.UTC(year, month, Number(match[2]), Number(match[3]), Number(match[4])) - offset * 60_000;
  if (match[7] === undefined) return { start, end: undefined };
  const endMonth = match[5] === undefined ? month : MONTHS.indexOf(match[5]);
  if (endMonth < 0) return undefined;
  const endDay = match[6] === undefined ? Number(match[2]) : Number(match[6]);
  const end = Date.UTC(yearNear(endMonth, month, year), endMonth, endDay, Number(match[7]), Number(match[8])) - offset * 60_000;
  return { start, end };
}

/** This function gives one incident from one item of a month of the history file, or `undefined` when a fact is missing. */
function fileIncidentOf(item: unknown, listMonth: number, listYear: number): HistoryIncident | undefined {
  const id = textOf(item, "code");
  const impact = textOf(item, "impact");
  const timestamp = textOf(item, "timestamp");
  const span = timestamp === undefined ? undefined : spanOf(timestamp, listMonth, listYear);
  if (id === undefined || impact === undefined || span === undefined) return undefined;
  return { id, impact, start: span.start, end: span.end, updated: span.end ?? span.start, scheduled: impact === "maintenance", components: [] };
}

/**
 * This function reads the body of the history file of a page (`HISTORY_FILE_PATH`). The file has a list `months`, and
 * each month has a list `incidents`. It gives the same incidents as `readHistory`, with these differences:
 *
 * - The file names no component of an incident, thus each incident has no component.
 * - The file has no time of the last change, thus the last change is the end, else the start.
 * - The file has no field `scheduled_for`, thus an incident is a scheduled maintenance when its impact is `maintenance`.
 * - Each time has the precision of one minute.
 *
 * An item with an id that the reader read before counts one time. The reader gives `undefined` when the body is not
 * JSON, or when it has no list `months`.
 */
export function readHistoryFile(body: string): HistoryFileRead | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const months = isRecord(parsed) ? parsed["months"] : undefined;
  if (!Array.isArray(months)) return undefined;
  const incidents: HistoryIncident[] = [];
  const seen = new Set<string>();
  let listed = 0;
  for (const month of months as readonly unknown[]) {
    const items = isRecord(month) && Array.isArray(month["incidents"]) ? (month["incidents"] as readonly unknown[]) : [];
    const listMonth = MONTHS.indexOf((textOf(month, "name") ?? "").slice(0, 3));
    const listYear = numberOf(month, "year");
    for (const item of items) {
      const id = textOf(item, "code");
      if (id !== undefined && seen.has(id)) continue;
      if (id !== undefined) seen.add(id);
      listed += 1;
      const incident = listMonth < 0 || listYear === undefined ? undefined : fileIncidentOf(item, listMonth, listYear);
      if (incident !== undefined) incidents.push(incident);
    }
  }
  return { incidents, listed, skipped: listed - incidents.length, since: timeOf(parsed, "start_time") };
}
