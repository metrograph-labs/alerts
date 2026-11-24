/**
 * The reader of the incident history of a dashboard of Google (`/incidents.json`). The file holds the past incidents
 * too, so a caller can measure the down time of a past window. The file has no documented limit. Thus the reader gives
 * the start of the oldest incident, and the caller starts its window there at the earliest.
 *
 * This module only reads the body. It sends no request and holds no statistics.
 */

import { isRecord, textOf, timeOf, type Fields } from "@mark1russell7/optional/read";

import type { ProductKey } from "./feed.ts";
import { itemsOf, locationsOf } from "./map.ts";

/**
 * The products of Google Cloud that a plain virtual machine needs: Compute Engine, Persistent Disk, the VPC network and
 * Cloud NAT. The ids come from the incident history of the dashboard on 2026-11-24. The documentation of the dashboards
 * gives the ids as stable. The domain is the API of each product.
 */
export const VM_PRODUCTS: readonly ProductKey[] = [
  { id: "L3ggmi3Jy4xJmgodFA9K", name: "Google Compute Engine", domain: "compute.googleapis.com" },
  { id: "SzESm2Ux129pjDGKWD68", name: "Persistent Disk", domain: "compute.googleapis.com" },
  { id: "BSGtCUnz6ZmyajsjgTKv", name: "Virtual Private Cloud (VPC)", domain: "compute.googleapis.com" },
  { id: "hCNpnTQHkUCCGxJy35Yq", name: "Cloud NAT", domain: "compute.googleapis.com" },
];

/** The location id of an incident of all of the cloud. */
export const GLOBAL_LOCATION = "global";

/** One incident of the history of a dashboard, with only the facts of a down time. */
export interface PastIncident {
  /** The id of the incident. */
  readonly id: string;
  /** The severity of the incident: `low`, `medium` or `high`. */
  readonly severity: string;
  /** The impact of the incident, for example `SERVICE_OUTAGE`, `SERVICE_DISRUPTION` or `SERVICE_INFORMATION`. */
  readonly impact: string;
  /** The time of the start of the incident: its field `begin`, else its field `created`. */
  readonly start: number;
  /** The time of the end of the incident: its field `end`, or `undefined` when the incident has not ended. */
  readonly end: number | undefined;
  /** The ids of the affected products, with no id twice. */
  readonly products: readonly string[];
  /** The ids of the affected locations, current and past, with no id twice. The id `global` is all of the cloud. */
  readonly locations: readonly string[];
}

/** The history of a dashboard. */
export interface IncidentHistory {
  /** The incidents of the file with a start. */
  readonly incidents: readonly PastIncident[];
  /** The start of the oldest incident, or `undefined` when the file has no incident. */
  readonly since: number | undefined;
}

function incidentOf(fields: Fields): PastIncident | undefined {
  const id = textOf(fields, "id");
  const start = timeOf(fields, "begin") ?? timeOf(fields, "created");
  if (id === undefined || start === undefined) return undefined;
  return {
    id,
    severity: textOf(fields, "severity") ?? "",
    impact: textOf(fields, "status_impact") ?? "",
    start,
    end: timeOf(fields, "end"),
    products: itemsOf(fields, "affected_products").map((item) => item.id),
    locations: locationsOf(fields).map((item) => item.id),
  };
}

/**
 * This function reads the history of a dashboard from the body of `/incidents.json`. It skips an incident with no id or
 * no start. It gives `undefined` when the body is not a JSON list.
 */
export function readIncidentHistory(body: string): IncidentHistory | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const incidents = parsed.filter(isRecord).flatMap((fields) => {
    const incident = incidentOf(fields);
    return incident === undefined ? [] : [incident];
  });
  return { incidents, since: incidents.length === 0 ? undefined : Math.min(...incidents.map((incident) => incident.start)) };
}
