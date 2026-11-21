/**
 * The map function of the dashboards of Google. The fetch gives one observation for each incident that has not ended.
 * An incident gives one report of the kind `infra.cloud.outage`.
 *
 * The id of the incident is the key of the report. The first subject of the report is the domain of the service. The
 * endpoint of each key of an affected product and each location (`provider-region:gcp/europe-west1`) follow it. Thus a
 * person who names the service, an endpoint or a region gets the report. The documentation gives the ids as stable and
 * the titles as unstable, so a title is only a label.
 */

import { categoryOf, kindLabel, Problems, reportId, type Instant, type MapResult, type Observation, type Report, type Severity, type Subject, type Urgency } from "@mark1russell7/alerts";
import { isRecord, textOf, timeOf, type Fields } from "@mark1russell7/optional/read";
import { errorMessage } from "@mark1russell7/text";

import { DOMAIN_SYSTEM, GCP_DASHBOARD, GCP_KIND, GCP_ORIGIN, REGION_SYSTEM, regionId, type GoogleDashboard, type ProductKey } from "./feed.ts";

/** The fields of the body of an incident, in this order. The fetch keeps only these fields. */
export const INCIDENT_FIELDS = [
  "id",
  "begin",
  "created",
  "end",
  "modified",
  "external_desc",
  "status_impact",
  "severity",
  "affected_products",
  "currently_affected_locations",
  "previously_affected_locations",
  "most_recent_update",
  "updates",
  "uri",
] as const;

/** The fields of the most recent update of an incident, in this order. */
export const UPDATE_FIELDS = ["created", "modified", "when", "text", "status", "affected_locations"] as const;

/** The fields of each earlier update, in this order. The text of each update is in the observation of its own time. */
export const HISTORY_FIELDS = ["when", "status"] as const;

/** The fields of each product and each location, in this order. */
export const ITEM_FIELDS = ["id", "title"] as const;

/** The severity of each severity of an incident. An outage of a cloud is a threat to property, not to life. */
export const SEVERITY_OF_INCIDENT: Readonly<Record<string, Severity>> = { high: "severe", medium: "moderate", low: "minor" };

/**
 * The urgency of each status of the most recent update. A disruption or an outage needs action at once. A notice needs
 * no action at this time. After the service is available again, the provider only watches it.
 */
export const URGENCY_OF_STATUS: Readonly<Record<string, Urgency>> = { SERVICE_OUTAGE: "immediate", SERVICE_DISRUPTION: "immediate", SERVICE_INFORMATION: "future", AVAILABLE: "past" };

/** This function gives the time of the last change of an incident: its field `modified`, else its field `created`. */
export function sentOf(incident: Fields): Instant | undefined {
  return timeOf(incident, "modified") ?? timeOf(incident, "created");
}

/** This function tells if an incident has the structure of the feed: an id, a summary and a time of its last change. */
export function isIncident(incident: Fields): boolean {
  return textOf(incident, "id") !== undefined && textOf(incident, "external_desc") !== undefined && sentOf(incident) !== undefined;
}

/** This function gives the items of a list field with an id: each product or location, with no id twice. */
export function itemsOf(fields: Fields, field: string): readonly { readonly id: string; readonly title?: string }[] {
  const items = Array.isArray(fields[field]) ? (fields[field] as unknown[]).filter(isRecord) : [];
  const seen = new Set<string>();
  const out: { id: string; title?: string }[] = [];
  for (const item of items) {
    const id = textOf(item, "id");
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const title = textOf(item, "title");
    out.push(title === undefined ? { id } : { id, title });
  }
  return out;
}

/**
 * This function gives the locations of an incident: the locations that it affects at this time, and then the locations
 * that it affected before. A person who uses a region gets the report while the incident lasts, also after the
 * recovery of that region.
 */
export function locationsOf(incident: Fields): readonly { readonly id: string; readonly title?: string }[] {
  const current = itemsOf(incident, "currently_affected_locations");
  const ids = new Set(current.map((item) => item.id));
  return [...current, ...itemsOf(incident, "previously_affected_locations").filter((item) => !ids.has(item.id))];
}

/**
 * This function gives the keys of a dashboard that an incident names: each key whose id is the id of an affected product.
 * The order is the order of the dashboard.
 */
export function keysOf(incident: Fields, dashboard: Pick<GoogleDashboard, "products">): readonly ProductKey[] {
  const ids = new Set(itemsOf(incident, "affected_products").map((product) => product.id));
  return dashboard.products.filter((key) => ids.has(key.id));
}

/**
 * This function maps one observation of a dashboard. The default is the dashboard of Google Cloud. It does not throw. A
 * body that it does not understand gives a fatal problem.
 */
export function mapObservation(observation: Observation, dashboard: GoogleDashboard = GCP_DASHBOARD): MapResult {
  try {
    return mapOrThrow(observation, dashboard);
  } catch (error) {
    return { reports: [], problems: [{ path: "", message: `the map function failed: ${errorMessage(error)}`, fatal: true }] };
  }
}

/** This function maps one observation, and can throw. `mapObservation` catches each error. */
function mapOrThrow(observation: Observation, dashboard: GoogleDashboard): MapResult {
  let fields: unknown;
  try {
    fields = JSON.parse(observation.body);
  } catch {
    return { reports: [], problems: [{ path: "", message: "the body is not JSON", fatal: true }] };
  }
  // The fetch gives the whole answer as one observation when the answer is not a list of incidents.
  if (!isRecord(fields) || !Object.hasOwn(fields, "id")) {
    return { reports: [], problems: [{ path: "", message: `the observation is not one incident of ${dashboard.sender}: the format changed`, fatal: true }] };
  }
  const problems = new Problems();
  if (textOf(fields, "id") === undefined) problems.add("id", "the incident has no id: the map makes no report", "fatal");
  if (textOf(fields, "external_desc") === undefined) problems.add("external_desc", "the incident has no summary: the map makes no report", "fatal");
  if (sentOf(fields) === undefined) problems.add("modified", "the incident has no time of its last change: the map makes no report", "fatal");
  if (!isIncident(fields)) return { reports: [], problems: problems.list };
  const severity = typeof fields["severity"] === "string" ? fields["severity"] : undefined;
  if (severity === undefined || SEVERITY_OF_INCIDENT[severity] === undefined) problems.add("severity", `the severity ${JSON.stringify(fields["severity"])} is not a severity of the feed: the severity is unknown`);
  const latest = isRecord(fields["most_recent_update"]) ? fields["most_recent_update"] : undefined;
  const status = latest !== undefined && typeof latest["status"] === "string" ? latest["status"] : undefined;
  if (status === undefined || URGENCY_OF_STATUS[status] === undefined) problems.add("most_recent_update.status", `the status ${JSON.stringify(latest?.["status"])} is not a status of the feed: the urgency is unknown`);
  return { reports: [reportOf(observation, dashboard, fields, severity, latest, status)], problems: problems.list };
}

/** This function gives the report of one valid incident. */
function reportOf(observation: Observation, dashboard: GoogleDashboard, incident: Fields, severity: string | undefined, latest: Fields | undefined, status: string | undefined): Report {
  const key = textOf(incident, "id")!;
  const summary = textOf(incident, "external_desc")!;
  const sent = sentOf(incident)!;
  const updates = Array.isArray(incident["updates"]) ? incident["updates"].length : latest === undefined ? 0 : 1;
  const effective = timeOf(incident, "created");
  const onset = timeOf(incident, "begin");
  const locations = locationsOf(incident);
  const products = itemsOf(incident, "affected_products");
  const impact = textOf(incident, "status_impact");
  const uri = textOf(incident, "uri");
  const description = latest === undefined ? undefined : textOf(latest, "text");
  const keys = keysOf(incident, dashboard);
  const endpoints = [...new Set(keys.map((each) => each.domain))].filter((domain) => domain !== dashboard.domain);
  const about: Subject[] = [
    { system: DOMAIN_SYSTEM, id: dashboard.domain, label: dashboard.name },
    ...endpoints.map((domain) => ({ system: DOMAIN_SYSTEM, id: domain, label: `${dashboard.name}: ${keys.filter((each) => each.domain === domain).map((each) => each.name).join(", ")}` })),
    ...locations.map((location) => ({ system: REGION_SYSTEM, id: regionId(location.id), ...(location.title === undefined ? {} : { label: location.title }) })),
  ];
  return {
    id: reportId({ source: dashboard.id, key, sent }),
    source: dashboard.id,
    origin: GCP_ORIGIN,
    key,
    references: [],
    correlation: [],
    status: "actual",
    // The feed gives the first text of an incident as its first update.
    op: updates > 1 ? "update" : "alert",
    kind: { code: GCP_KIND, label: kindLabel(GCP_KIND) },
    categories: [categoryOf(GCP_KIND)],
    severity: severity === undefined ? "unknown" : (SEVERITY_OF_INCIDENT[severity] ?? "unknown"),
    urgency: status === undefined ? "unknown" : (URGENCY_OF_STATUS[status] ?? "unknown"),
    certainty: "observed",
    response: ["monitor"],
    sent,
    received: observation.fetched,
    ...(effective === undefined ? {} : { effective }),
    ...(onset === undefined ? {} : { onset }),
    areas: [],
    about,
    sender: dashboard.sender,
    headline: `${dashboard.name}: ${summary}`,
    ...(description === undefined ? {} : { description }),
    web: uri === undefined ? dashboard.base : `${dashboard.base}/${uri.replace(/^\/+/, "")}`,
    observation: observation.id,
    parameters: withValues({
      status: status === undefined ? [] : [status],
      impact: impact === undefined ? [] : [impact],
      severity: severity === undefined ? [] : [severity],
      product: products.map((product) => product.title ?? product.id),
      "product-id": products.map((product) => product.id),
      "location-now": itemsOf(incident, "currently_affected_locations").map((location) => location.id),
      updates: [String(updates)],
    }),
  };
}

/** This function removes each parameter with no value. */
function withValues(parameters: Readonly<Record<string, readonly string[]>>): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(Object.entries(parameters).filter(([, values]) => values.length > 0));
}
