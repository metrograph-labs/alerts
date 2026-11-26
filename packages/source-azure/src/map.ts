/**
 * The map function of the feed of Azure Status. The fetch gives one observation for each item of the feed. An item gives
 * one report of `infra.cloud.outage`.
 *
 * The key of the report is the `guid` of the item: a slug of its title. The time of the report is the `pubDate` of the
 * item, the start of the impact. The item has no time of each update. Thus a new text of an item with the same `guid`
 * gives no new report. The subjects of the report are the domain of the service and each region of its categories
 * (`provider-region:azure/westeurope`).
 */

import { categoryOf, kindLabel, Problems, reportId, type MapResult, type Observation, type Report, type Subject } from "@mark1russell7/alerts";
import { isRecord, readHttpTime, textOf, type Fields } from "@mark1russell7/optional/read";
import { errorMessage } from "@mark1russell7/text";
import { plainText } from "@mark1russell7/text/references";

import { AZURE_DOMAIN, AZURE_KIND, AZURE_ORIGIN, AZURE_PAGE, AZURE_SOURCE, categoriesOf, DOMAIN_SYSTEM, REGION_SYSTEM, regionId } from "./feed.ts";

/**
 * The severity of each report. The status page of Azure tells only of widespread incidents, but an item gives no level.
 * Thus each report has the middle level.
 */
export const AZURE_SEVERITY = "moderate";

/** This function gives the texts of a list field. A value that is not a text gives no entry. */
function textsOf(fields: Fields, field: string): readonly string[] {
  const value = fields[field];
  return Array.isArray(value) ? value.filter((each): each is string => typeof each === "string" && each.trim() !== "").map((each) => each.trim()) : [];
}

// The plain text of the HTML of a description comes from its home. The package keeps the export for its users.
export { plainText };

/** This function maps one observation of the feed. It does not throw. A body that it does not understand gives a fatal problem. */
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
  // The fetch gives an item with no guid as its own observation, with no key.
  if (!isRecord(fields) || !Object.hasOwn(fields, "key")) {
    return { reports: [], problems: [{ path: "", message: "the observation is not one incident of Azure Status: the format changed", fatal: true }] };
  }
  const problems = new Problems();
  if (textOf(fields, "key") === undefined) problems.add("key", "the incident has no guid: the map makes no report", "fatal");
  if (readHttpTime(textOf(fields, "published")) === undefined) problems.add("published", "the incident has no time: the map makes no report", "fatal");
  if (textOf(fields, "title") === undefined) problems.add("title", "the incident has no title: the map makes no report", "fatal");
  if (problems.fatal > 0) return { reports: [], problems: problems.list };
  return { reports: [reportOf(observation, fields)], problems: problems.list };
}

/** This function gives the report of one valid incident. */
function reportOf(observation: Observation, incident: Fields): Report {
  const key = textOf(incident, "key")!;
  const title = textOf(incident, "title")!;
  const sent = readHttpTime(textOf(incident, "published"))!;
  const { regions, services } = categoriesOf(textsOf(incident, "categories"));
  const description = plainText(textOf(incident, "description"));
  const link = textOf(incident, "link");
  const about: Subject[] = [{ system: DOMAIN_SYSTEM, id: AZURE_DOMAIN, label: "Microsoft Azure" }, ...regions.map((region) => ({ system: REGION_SYSTEM, id: regionId(region), label: region }))];
  return {
    id: reportId({ source: AZURE_SOURCE, key, sent }),
    source: AZURE_SOURCE,
    origin: AZURE_ORIGIN,
    key,
    references: [],
    correlation: [],
    status: "actual",
    op: "alert",
    kind: { code: AZURE_KIND, label: kindLabel(AZURE_KIND) },
    categories: [categoryOf(AZURE_KIND)],
    severity: AZURE_SEVERITY,
    urgency: "immediate",
    certainty: "observed",
    response: ["monitor"],
    sent,
    received: observation.fetched,
    effective: sent,
    areas: [],
    about,
    sender: "Azure Status",
    headline: `Azure: ${title}`,
    ...(description === undefined ? {} : { description }),
    web: link !== undefined && link.startsWith("https://") ? link : AZURE_PAGE,
    observation: observation.id,
    parameters: withValues({ service: services, region: regions }),
  };
}

/** This function removes each parameter with no value. */
function withValues(parameters: Readonly<Record<string, readonly string[]>>): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(Object.entries(parameters).filter(([, values]) => values.length > 0));
}
