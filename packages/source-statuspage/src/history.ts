/**
 * The reader of the incident history of a status page of Atlassian Statuspage. The page documents two files for programs:
 * the list of the latest incidents (`/api/v2/incidents.json`) and the list of its components (`/api/v2/components.json`).
 * The list of incidents holds the resolved incidents too, so a caller can measure the down time of a past window.
 *
 * The list of incidents holds at most `HISTORY_LIMIT` incidents, in the order of their last change, the newest first.
 * Thus a full list does not tell of an incident with an older last change. The reader gives the time of the last change
 * of each incident, so the caller can make its window shorter.
 *
 * This module only reads the bodies. It sends no request and holds no statistics.
 */

import { arrayOf, isRecord, textOf, timeOf, type Fields } from "@mark1russell7/optional/read";

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
