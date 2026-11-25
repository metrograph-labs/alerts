/**
 * The map function of a CERT feed. The fetch gives one observation of the head of the feed and one observation for each
 * recent entry. An entry gives one report of the kind that the rules of the provider give. The head gives no report.
 *
 * The CVE id of each flaw in the entry is a subject of the report and a correlation key. Thus a person who names the flaw
 * gets the report, and the report joins the incident of the same flaw from a second source, for example the KEV catalog.
 */

import { categoryOf, kindLabel, reportId, type MapResult, type Observation, type Report, type Subject, type Urgency } from "@mark1russell7/alerts";
import { isRecord } from "@mark1russell7/optional/read";
import { errorMessage } from "@mark1russell7/text";

import type { EntryBody } from "./fetch.ts";
import { DAY_MS, EXPLOITED_KIND, kindOf, type CertProvider } from "./providers.ts";

/** The system of the subjects and of the correlation keys of the reports: the CVE id of a flaw. */
export const CVE_SYSTEM = "cve";

/** The time after an entry at which its report ends: 30 days. An entry has no end of its own. */
export const ENTRY_LIFE_MS: number = 30 * DAY_MS;

/** This function tells if a body is the head of a feed. */
export function isHeadBody(fields: Record<string, unknown>): boolean {
  return typeof fields["feed"] === "string" && typeof fields["entries"] === "number";
}

/** This function tells if a body is the body of an entry. */
function isEntry(fields: Record<string, unknown>): fields is Record<string, unknown> & EntryBody {
  return ["key", "title", "time"].every((name) => typeof fields[name] === "string") && Array.isArray(fields["categories"]) && Array.isArray(fields["cves"]);
}

/**
 * This function gives the urgency of a kind. A flaw that attackers use now needs a step soon: `expected`. Each other
 * entry tells of a step in the next days or weeks: `future`.
 */
export function urgencyOf(kind: string): Urgency {
  return kind === EXPLOITED_KIND ? "expected" : "future";
}

/** This function makes the map function of one provider. The function does not throw. */
export function createCertMap(provider: CertProvider): (observation: Observation) => MapResult {
  return (observation) => {
    try {
      return mapOrThrow(provider, observation);
    } catch (error) {
      return { reports: [], problems: [{ path: "", message: `the map function failed: ${errorMessage(error)}`, fatal: true }] };
    }
  };
}

/** This function maps one observation, and can throw. The map function catches each error. */
function mapOrThrow(provider: CertProvider, observation: Observation): MapResult {
  let fields: unknown;
  try {
    fields = JSON.parse(observation.body);
  } catch {
    return { reports: [], problems: [{ path: "", message: "the body is not JSON", fatal: true }] };
  }
  if (!isRecord(fields)) return { reports: [], problems: [{ path: "", message: "the body is not an object", fatal: true }] };
  if (isHeadBody(fields)) return { reports: [], problems: [] };
  if (!isEntry(fields)) return { reports: [], problems: [{ path: "", message: "the observation is not an entry of the feed: the format changed", fatal: true }] };
  const kind = kindOf(provider, fields);
  // An entry that no rule matches is no alert, for example a weekly letter. The note tells of it, with no fault.
  if (kind === undefined) return { reports: [], problems: [{ path: "", message: `no rule of a kind matches the entry, so it gives no report: ${fields.key}`, fatal: false }] };
  return { reports: [reportOf(provider, observation, fields, kind)], problems: [] };
}

/** This function gives the report of one entry. */
function reportOf(provider: CertProvider, observation: Observation, entry: EntryBody, kind: string): Report {
  const sent = Date.parse(entry.time);
  const about: Subject[] = entry.cves.map((cve) => ({ system: CVE_SYSTEM, id: cve }));
  return {
    id: reportId({ source: provider.id, key: entry.key, sent }),
    source: provider.id,
    origin: provider.origin,
    key: entry.key,
    references: [],
    correlation: entry.cves.map((cve) => ({ system: CVE_SYSTEM, id: cve })),
    status: "actual",
    op: "alert",
    kind: { code: kind, label: kindLabel(kind) },
    categories: [categoryOf(kind)],
    // The feeds give no severity. The page of the entry gives the facts.
    severity: "unknown",
    urgency: urgencyOf(kind),
    certainty: "observed",
    response: ["assess"],
    sent,
    received: observation.fetched,
    effective: sent,
    expires: sent + ENTRY_LIFE_MS,
    areas: [],
    about,
    sender: provider.sender,
    headline: `${provider.short}: ${entry.title}`,
    ...(entry.summary === undefined ? {} : { description: entry.summary }),
    // The terms of the open licences ask for credit, and the link gives it.
    ...(entry.link === undefined ? {} : { web: entry.link }),
    observation: observation.id,
    parameters: withValues({
      language: [provider.language],
      category: entry.categories,
      terms: [provider.terms.text],
      termsUrl: provider.terms.url === null ? [] : [provider.terms.url],
    }),
  };
}

/** This function removes each parameter with no value. */
function withValues(parameters: Readonly<Record<string, readonly string[]>>): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(Object.entries(parameters).filter(([, values]) => values.length > 0));
}
