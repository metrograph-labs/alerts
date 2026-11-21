/**
 * The format `statusiq`: the status page of Site24x7 StatusIQ. The page gives an RSS feed with one item for each component.
 * The title of an item is the name of the component, a hyphen and its status, for example `Dashboard - Operational`. The
 * `pubDate` of the item is the time of the last change of the status. The feed has no incident and no text of the provider.
 *
 * The fetch gives one observation for each component that has an outage, and one observation of the head of the feed.
 * The id of the component is the key of the report. Thus a change of the status gives a new report of the same incident.
 */

import { categoryOf, kindLabel, Problems, reportId, type Instant, type MapResult, type Observation, type Report, type Severity } from "@mark1russell7/alerts";
import { readFeed, type FeedEntry } from "@mark1russell7/alerts-format-cap";
import { isRecord, textOf, type Fields } from "@mark1russell7/optional/read";

import type { Summary } from "./fetch.ts";
import { subjectsOf, type StatusPage } from "./page.ts";

/**
 * This function gives the time of the RSS date of a field, or `undefined`. An RSS date is RFC 822, and `readTime` reads
 * only ISO 8601. `readHttpTime` of `@mark1russell7/optional/read` replaces this function at its release (AL-71).
 */
function rssTimeOf(fields: Fields, field: string): Instant | undefined {
  const text = textOf(fields, field);
  const time = text === undefined ? Number.NaN : Date.parse(text);
  return Number.isFinite(time) ? time : undefined;
}

/** The path of the RSS feed of a page. */
export const STATUSIQ_PATH = "/rss";

/** The status of a component with no problem. Such a component gives no observation. */
export const OPERATIONAL = "Operational";

/** The status of a component in a maintenance. Such a component gives no observation: the source makes no report of a maintenance. */
export const UNDER_MAINTENANCE = "Under Maintenance";

/**
 * The severity of each status of an outage of a component. The help of StatusIQ names these three levels. An outage of a
 * service is a threat to property, not to life, as for the impacts of Statuspage.
 */
export const SEVERITY_OF_STATUSIQ: Readonly<Record<string, Severity>> = { "Degraded Performance": "minor", "Partial Outage": "moderate", "Major Outage": "severe" };

/** The fields of the body of one component, in this order. */
export const COMPONENT_ITEM_FIELDS = ["id", "name", "status", "since", "link"] as const;

/** The status of one component, as one item of the feed gives it. A field that the item does not give is absent. */
export interface ComponentStatus {
  /** The id of the component: the text after `#/components/` in the link of the item. */
  readonly id?: string;
  /** The name of the component: the title of the item before its last hyphen. */
  readonly name?: string;
  /** The status of the component: the title of the item after its last hyphen. */
  readonly status?: string;
  /** The `pubDate` of the item: the time of the last change of the status. */
  readonly since?: string;
  /** The link of the item to the component on the page. */
  readonly link?: string;
}

/** The separator of the name and the status in the title of an item. */
const SEPARATOR = " - ";

/** This function gives the status of the component of one item of the feed. */
export function componentOf(entry: FeedEntry): ComponentStatus {
  const title = entry.title ?? "";
  const at = title.lastIndexOf(SEPARATOR);
  const name = at > 0 ? title.slice(0, at).trim() : "";
  const status = at > 0 ? title.slice(at + SEPARATOR.length).trim() : "";
  const id = /#\/components\/([A-Za-z0-9_-]+)$/.exec(entry.link ?? "")?.[1];
  const fields: Record<string, string | undefined> = { id, name: name === "" ? undefined : name, status: status === "" ? undefined : status, since: entry.updated, link: entry.link };
  return Object.fromEntries(COMPONENT_ITEM_FIELDS.flatMap((field) => (fields[field] === undefined ? [] : [[field, fields[field]]])));
}

/** This function tells if the status of a component gives an observation. An item with no status gives one, so the map tells of it. */
export function hasOutage(component: ComponentStatus): boolean {
  return component.status !== OPERATIONAL && component.status !== UNDER_MAINTENANCE;
}

/**
 * This function reads the components of one answer. A document that is not a feed gives one head with the whole body
 * in the field `document`. It gives no component, and `complete` is false. Then the map tells of the change. A cut or bad
 * document gives `undefined`.
 */
export function readComponents(body: string): Summary | undefined {
  const read = readFeed(body);
  if (!read.ok) return read.malformed ? undefined : { head: JSON.stringify({ document: body }), incidents: [], complete: false };
  const components = read.entries.map(componentOf);
  const valid = (component: ComponentStatus): boolean =>
    component.id !== undefined && component.name !== undefined && component.status !== undefined && Number.isFinite(Date.parse(component.since ?? ""));
  const times = components.map((component) => Date.parse(component.since ?? "")).filter(Number.isFinite);
  return {
    head: JSON.stringify({ feed: read.title === undefined ? {} : { title: read.title } }),
    incidents: [...new Set(components.filter(hasOutage).map((component) => JSON.stringify(component)))],
    complete: components.every(valid) && !read.problems.some((problem) => problem.lossy === true),
    ...(times.length > 0 ? { asOf: Math.max(...times) } : {}),
  };
}

/** This function tells if a body is the head of a feed: only the field `feed`, with an object. */
export function isFeedHead(fields: Fields): boolean {
  return isRecord(fields["feed"]) && Object.keys(fields).length === 1;
}

/** This function maps one parsed body of a page of the format `statusiq`. It can throw. `mapObservation` catches each error. */
export function mapComponent(observation: Observation, page: StatusPage, fields: Fields): MapResult {
  if (isFeedHead(fields)) return { reports: [], problems: [] };
  // The fetch gives the whole answer in the field `document` when the answer is not a feed.
  if (!COMPONENT_ITEM_FIELDS.some((field) => Object.hasOwn(fields, field))) {
    return { reports: [], problems: [{ path: "", message: "the observation is not one component of a feed of StatusIQ: the format changed", fatal: true }] };
  }
  const problems = new Problems();
  if (textOf(fields, "id") === undefined) problems.add("id", "the item has no id of a component in its link: the map makes no report", "fatal");
  if (textOf(fields, "name") === undefined) problems.add("name", "the item has no name of a component in its title: the map makes no report", "fatal");
  if (textOf(fields, "status") === undefined) problems.add("status", "the item has no status in its title: the map makes no report", "fatal");
  if (rssTimeOf(fields, "since") === undefined) problems.add("since", "the item has no time of its last change: the map makes no report", "fatal");
  if (problems.fatal > 0) return { reports: [], problems: problems.list };
  const status = textOf(fields, "status")!;
  if (SEVERITY_OF_STATUSIQ[status] === undefined) problems.add("status", `the status ${JSON.stringify(status)} is not a status of StatusIQ: the severity is unknown`);
  return { reports: [reportOf(observation, page, fields)], problems: problems.list };
}

/** This function gives the report of one valid component. */
function reportOf(observation: Observation, page: StatusPage, component: Fields): Report {
  const key = textOf(component, "id")!;
  const name = textOf(component, "name")!;
  const status = textOf(component, "status")!;
  const sent = rssTimeOf(component, "since")!;
  const link = textOf(component, "link");
  const keys = (page.components ?? []).filter((each) => each.id === key);
  return {
    id: reportId({ source: page.id, key, sent }),
    source: page.id,
    origin: page.origin,
    key,
    references: [],
    correlation: [],
    status: "actual",
    op: "alert",
    kind: { code: page.kind, label: kindLabel(page.kind) },
    categories: [categoryOf(page.kind)],
    severity: SEVERITY_OF_STATUSIQ[status] ?? "unknown",
    // The status is the status of the component at the time of the fetch.
    urgency: "immediate",
    certainty: "observed",
    response: ["monitor"],
    sent,
    received: observation.fetched,
    effective: sent,
    areas: [],
    about: [...subjectsOf(page, keys)],
    sender: `The status page of ${page.title}`,
    headline: `${page.title}: ${name}: ${status}`,
    web: link !== undefined && link.startsWith("https://") ? link : page.base,
    observation: observation.id,
    parameters: { status: [status], component: [name], page: [page.base] },
  };
}
