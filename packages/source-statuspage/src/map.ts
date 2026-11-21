/**
 * The map function of a status page of the format `statuspage`. The function also gives each page of another format to
 * the map of that format (`statusiq.ts`). The summary of a page lists each incident that is not resolved. The fetch gives
 * one observation for each incident and one observation of the head of the page. An incident gives one report of the
 * kind of the page. The head gives no report.
 *
 * The id of the incident is the key of the report. The report has no correlation key: two incidents of one service at
 * one time are two events. The first subject of the report is the domain of the service (`domain:github.com`). Thus a
 * person who names the service gets the report. Each key of a component of the incident adds the domain of its endpoint.
 */

import { categoryOf, kindLabel, Problems, reportId, type Instant, type MapResult, type Observation, type Report, type Severity, type Urgency } from "@mark1russell7/alerts";
import { isRecord, textOf, timeOf, type Fields } from "@mark1russell7/optional/read";
import { errorMessage } from "@mark1russell7/text";

import { subjectsOf, type ComponentKey, type StatusPage } from "./page.ts";
import { mapComponent } from "./statusiq.ts";

/** The fields of the body of an incident, in this order. The fetch keeps only these fields. */
export const INCIDENT_FIELDS = ["id", "name", "status", "impact", "created_at", "updated_at", "started_at", "monitoring_at", "resolved_at", "shortlink", "components", "incident_updates"] as const;

/** The fields of each update of an incident, in this order. */
export const UPDATE_FIELDS = ["id", "status", "body", "created_at", "updated_at", "display_at", "affected_components"] as const;

/**
 * The fields of each component of an incident, in this order. The status of a component changes with no update of the
 * incident, so the body of the incident does not keep it. The group of a component chooses the key of a group.
 */
export const COMPONENT_FIELDS = ["id", "name", "group_id"] as const;

/** The fields of the body of the head of a page, in this order. The head keeps no time, so a page with no change keeps its head. */
export const HEAD_FIELDS = ["page", "status"] as const;

/** The fields of the page in the body of the head, in this order. */
export const PAGE_FIELDS = ["id", "name", "url", "time_zone"] as const;

/** The severity of each impact of an incident. An outage of a service is a threat to property, not to life. */
export const SEVERITY_OF_IMPACT: Readonly<Record<string, Severity>> = { critical: "severe", major: "moderate", minor: "minor", none: "minor" };

/** The urgency of each status of an incident. After a fix, the provider only watches the service, so no action is necessary. */
export const URGENCY_OF_STATUS: Readonly<Record<string, Urgency>> = { investigating: "immediate", identified: "immediate", monitoring: "past", resolved: "past", postmortem: "past" };


/** This function tells if a body is the head of a page: a page with an id, and only the fields of `HEAD_FIELDS`. */
export function isHead(fields: Fields): boolean {
  return isRecord(fields["page"]) && typeof fields["page"]["id"] === "string" && Object.keys(fields).every((field) => (HEAD_FIELDS as readonly string[]).includes(field));
}

/** This function tells if an incident has the structure of Statuspage: an id, a name, a status and a time of its last change. */
export function isIncident(incident: Fields): boolean {
  return textOf(incident, "id") !== undefined && textOf(incident, "name") !== undefined && typeof incident["status"] === "string" && sentOf(incident) !== undefined;
}

/** This function gives the time of the last change of an incident: its field `updated_at`, else its field `created_at`. */
export function sentOf(incident: Fields): Instant | undefined {
  return timeOf(incident, "updated_at") ?? timeOf(incident, "created_at");
}

/** This function gives the updates of an incident with a body, the newest first. An update with no time of display goes last. */
export function updatesOf(incident: Fields): readonly Fields[] {
  const updates = Array.isArray(incident["incident_updates"]) ? incident["incident_updates"].filter(isRecord) : [];
  const shown = (update: Fields): number => timeOf(update, "display_at") ?? timeOf(update, "created_at") ?? Number.NEGATIVE_INFINITY;
  return [...updates].sort((a, b) => shown(b) - shown(a));
}

/** This function gives the names of the components of an incident, with no name twice. */
export function componentsOf(incident: Fields): readonly string[] {
  const components = Array.isArray(incident["components"]) ? incident["components"].filter(isRecord) : [];
  return [...new Set(components.flatMap((component) => (textOf(component, "name") === undefined ? [] : [textOf(component, "name")!])))];
}

/**
 * This function gives the keys of a page that an incident names. A component of the incident, or its group, has the id
 * of the key. Or an update gives the id of the key as the code of an affected component. The order is the order of the page.
 */
export function keysOf(incident: Fields, page: Pick<StatusPage, "components">): readonly ComponentKey[] {
  const components = Array.isArray(incident["components"]) ? incident["components"].filter(isRecord) : [];
  const affected = updatesOf(incident).flatMap((update) => (Array.isArray(update["affected_components"]) ? update["affected_components"].filter(isRecord) : []));
  const ids = new Set([...components.flatMap((component) => [textOf(component, "id"), textOf(component, "group_id")]), ...affected.map((component) => textOf(component, "code"))]);
  return (page.components ?? []).filter((key) => ids.has(key.id));
}

/** This function maps one observation of a page. It does not throw. A body that it does not understand gives a fatal problem. */
export function mapObservation(observation: Observation, page: StatusPage): MapResult {
  try {
    return mapOrThrow(observation, page);
  } catch (error) {
    return { reports: [], problems: [{ path: "", message: `the map function failed: ${errorMessage(error)}`, fatal: true }] };
  }
}

/** This function maps one observation, and can throw. `mapObservation` catches each error. */
function mapOrThrow(observation: Observation, page: StatusPage): MapResult {
  let fields: unknown;
  try {
    fields = JSON.parse(observation.body);
  } catch {
    return { reports: [], problems: [{ path: "", message: "the body is not JSON", fatal: true }] };
  }
  if (page.format === "statusiq") {
    if (!isRecord(fields)) return { reports: [], problems: [{ path: "", message: "the observation is not one component of a feed of StatusIQ: the format changed", fatal: true }] };
    return mapComponent(observation, page, fields);
  }
  if (isRecord(fields) && isHead(fields)) return { reports: [], problems: [] };
  // The fetch gives the whole answer as one observation when the answer is not the summary of a page.
  if (!isRecord(fields) || !Object.hasOwn(fields, "id")) {
    return { reports: [], problems: [{ path: "", message: "the observation is not one incident of a status page: the format changed", fatal: true }] };
  }
  const problems = new Problems();
  if (textOf(fields, "id") === undefined) problems.add("id", "the incident has no id: the map makes no report", "fatal");
  if (textOf(fields, "name") === undefined) problems.add("name", "the incident has no name: the map makes no report", "fatal");
  if (typeof fields["status"] !== "string") problems.add("status", "the incident has no status: the map makes no report", "fatal");
  if (sentOf(fields) === undefined) problems.add("updated_at", "the incident has no time of its last change: the map makes no report", "fatal");
  if (!isIncident(fields)) return { reports: [], problems: problems.list };
  const status = fields["status"] as string;
  if (URGENCY_OF_STATUS[status] === undefined) problems.add("status", `the status ${JSON.stringify(status)} is not a status of Statuspage: the urgency is unknown`);
  const impact = typeof fields["impact"] === "string" ? fields["impact"] : undefined;
  if (impact === undefined || SEVERITY_OF_IMPACT[impact] === undefined) problems.add("impact", `the impact ${JSON.stringify(fields["impact"])} is not an impact of Statuspage: the severity is unknown`);
  return { reports: [reportOf(observation, page, fields, impact)], problems: problems.list };
}

/** This function gives the report of one valid incident. */
function reportOf(observation: Observation, page: StatusPage, incident: Fields, impact: string | undefined): Report {
  const key = textOf(incident, "id")!;
  const name = textOf(incident, "name")!;
  const status = incident["status"] as string;
  const sent = sentOf(incident)!;
  const updates = updatesOf(incident);
  const latest = updates.find((update) => textOf(update, "body") !== undefined);
  const components = componentsOf(incident);
  const effective = timeOf(incident, "created_at");
  const onset = timeOf(incident, "started_at");
  // A component has no id in a system of the core. The parameter `component` gives its name.
  const about = [...subjectsOf(page, keysOf(incident, page))];
  return {
    id: reportId({ source: page.id, key, sent }),
    source: page.id,
    origin: page.origin,
    key,
    references: [],
    correlation: [],
    status: "actual",
    // Statuspage gives the first text of an incident as its first update.
    op: updates.length > 1 ? "update" : "alert",
    kind: { code: page.kind, label: kindLabel(page.kind) },
    categories: [categoryOf(page.kind)],
    severity: impact === undefined ? "unknown" : (SEVERITY_OF_IMPACT[impact] ?? "unknown"),
    urgency: URGENCY_OF_STATUS[status] ?? "unknown",
    certainty: "observed",
    response: ["monitor"],
    sent,
    received: observation.fetched,
    ...(effective === undefined ? {} : { effective }),
    ...(onset === undefined ? {} : { onset }),
    areas: [],
    about,
    sender: `The status page of ${page.title}`,
    headline: `${page.title}: ${name}`,
    ...(latest === undefined ? {} : { description: textOf(latest, "body")! }),
    web: textOf(incident, "shortlink") ?? page.base,
    observation: observation.id,
    parameters: withValues({
      status: [status],
      impact: impact === undefined ? [] : [impact],
      component: components,
      updates: [String(updates.length)],
      page: [page.base],
    }),
  };
}

/** This function removes each parameter with no value. */
function withValues(parameters: Readonly<Record<string, readonly string[]>>): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(Object.entries(parameters).filter(([, values]) => values.length > 0));
}
