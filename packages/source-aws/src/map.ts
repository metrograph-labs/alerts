/**
 * The map function of the feed of the AWS Health Dashboard. The fetch gives one observation for each event: the newest
 * update in full, and the time and the title of each earlier update. An event gives one report of `infra.cloud.outage`.
 *
 * The key of the report is the key of the service and the time of the first update. The subjects of the report are the
 * domain of the service and the region of the event (`provider-region:aws/eu-west-1`). The title of an update starts
 * with its status, for example `Service disruption: Increased Error Rates`.
 */

import { categoryOf, kindLabel, Problems, reportId, type MapResult, type Observation, type Report, type Severity, type Subject, type Urgency } from "@mark1russell7/alerts";
import { isRecord, textOf, timeOf, type Fields } from "@mark1russell7/optional/read";
import { errorMessage } from "@mark1russell7/text";

import { AWS_BASE, AWS_DOMAIN, AWS_KIND, AWS_ORIGIN, AWS_SOURCE, DOMAIN_SYSTEM, REGION_SYSTEM, regionId, serviceOf } from "./feed.ts";

/** The level of one status of the feed: the severity of the event, and the urgency when the status is the newest. */
export interface StatusLevel {
  /** The severity. The status of the recovery has no severity: the earlier updates give it. */
  readonly severity?: Severity;
  readonly urgency: Urgency;
}

/**
 * The level of each status of the feed, from the lowest to the highest. An outage of a cloud is a threat to property, not to
 * life. A message gives information only. After the recovery, the provider only watches the service.
 */
export const LEVEL_OF_STATUS: Readonly<Record<string, StatusLevel>> = {
  "Informational message": { severity: "minor", urgency: "future" },
  "Service impact": { severity: "minor", urgency: "immediate" },
  "Performance issues": { severity: "moderate", urgency: "immediate" },
  "Service degradation": { severity: "moderate", urgency: "immediate" },
  "Service disruption": { severity: "severe", urgency: "immediate" },
  "Service is operating normally": { urgency: "past" },
};

/** The rank of each severity that a status gives. */
const RANK: Readonly<Record<string, number>> = { minor: 1, moderate: 2, severe: 3 };

/** This function gives the status of a title: the text before the first colon. A title with no colon gives `undefined`. */
export function statusOf(title: string | undefined): string | undefined {
  const index = title === undefined ? -1 : title.indexOf(":");
  return index <= 0 ? undefined : title!.slice(0, index).trim();
}

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
  // The fetch gives an item with no key of a service as its own observation, with no key.
  if (!isRecord(fields) || !Object.hasOwn(fields, "key")) {
    return { reports: [], problems: [{ path: "", message: "the observation is not one event of the AWS Health Dashboard: the format changed", fatal: true }] };
  }
  const problems = new Problems();
  const latest = isRecord(fields["latest"]) ? fields["latest"] : {};
  if (textOf(fields, "key") === undefined || textOf(fields, "service") === undefined) problems.add("key", "the event has no key of a service: the map makes no report", "fatal");
  if (timeOf(latest, "time") === undefined) problems.add("latest.time", "the newest update has no time: the map makes no report", "fatal");
  if (textOf(latest, "title") === undefined) problems.add("latest.title", "the newest update has no title: the map makes no report", "fatal");
  if (problems.fatal > 0) return { reports: [], problems: problems.list };
  const earlier = Array.isArray(fields["earlier"]) ? fields["earlier"].filter(isRecord) : [];
  const updates = [latest, ...earlier];
  const levels: StatusLevel[] = [];
  updates.forEach((update, index) => {
    const status = statusOf(textOf(update, "title"));
    const level = status === undefined ? undefined : LEVEL_OF_STATUS[status];
    if (level !== undefined) levels.push(level);
    else problems.add(index === 0 ? "latest.title" : `earlier[${String(index - 1)}].title`, `the status ${JSON.stringify(status ?? null)} is not a status of the feed`);
  });
  const ranked = levels.map((level) => level.severity).filter((severity) => severity !== undefined);
  const severity = ranked.reduce<Severity | undefined>((top, each) => (top === undefined || RANK[each]! > RANK[top]! ? each : top), undefined);
  if (severity === undefined) problems.add("earlier", "no update has a status with a severity: the severity is unknown");
  const status = statusOf(textOf(latest, "title"));
  const urgency = status === undefined ? undefined : LEVEL_OF_STATUS[status]?.urgency;
  return { reports: [reportOf(observation, fields, latest, updates, severity, urgency, status)], problems: problems.list };
}

/** This function gives the report of one valid event. */
function reportOf(observation: Observation, event: Fields, latest: Fields, updates: readonly Fields[], severity: Severity | undefined, urgency: Urgency | undefined, status: string | undefined): Report {
  const key = textOf(event, "key")!;
  const { service, region } = serviceOf(textOf(event, "service")!);
  const title = textOf(latest, "title")!;
  const sent = timeOf(latest, "time")!;
  const times = updates.map((update) => timeOf(update, "time")).filter((time) => time !== undefined);
  const effective = Math.min(...times);
  const description = textOf(latest, "description");
  const link = textOf(event, "link");
  const about: Subject[] = [{ system: DOMAIN_SYSTEM, id: AWS_DOMAIN, label: "Amazon Web Services" }, ...(region === undefined ? [] : [{ system: REGION_SYSTEM, id: regionId(region) }])];
  return {
    id: reportId({ source: AWS_SOURCE, key, sent }),
    source: AWS_SOURCE,
    origin: AWS_ORIGIN,
    key,
    references: [],
    correlation: [],
    status: "actual",
    op: updates.length > 1 ? "update" : "alert",
    kind: { code: AWS_KIND, label: kindLabel(AWS_KIND) },
    categories: [categoryOf(AWS_KIND)],
    severity: severity ?? "unknown",
    urgency: urgency ?? "unknown",
    certainty: "observed",
    response: ["monitor"],
    sent,
    received: observation.fetched,
    effective,
    areas: [],
    about,
    sender: "AWS Health Dashboard",
    headline: `AWS (${region === undefined ? service : `${service}, ${region}`}): ${title}`,
    ...(description === undefined ? {} : { description }),
    web: link !== undefined && link.startsWith("https://") ? link : `${AWS_BASE}/`,
    observation: observation.id,
    parameters: withValues({
      status: status === undefined ? [] : [status],
      service: [service],
      region: region === undefined ? [] : [region],
      updates: [String(updates.length)],
    }),
  };
}

/** This function removes each parameter with no value. */
function withValues(parameters: Readonly<Record<string, readonly string[]>>): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(Object.entries(parameters).filter(([, values]) => values.length > 0));
}
