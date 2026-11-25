/**
 * The map function of an OSV provider. The fetch gives one observation of the head of the fetch and one observation for
 * each record that it read. A record gives one report of the kind of the provider. The head gives no report.
 *
 * - The subject of a report is each package of the record, as a purl with no version. Thus a person who names a package
 *   gets the report. A CVE alias of the record is also a subject.
 * - The id of the record and each alias are correlation keys. The two providers have one origin, so the merge counts
 *   their reports of one record as copies.
 * - A withdrawn record gives a cancel. A cancel is not live at any time. Thus it gives no alert. It ends the earlier
 *   report of the record from the same source.
 */

import { categoryOf, kindLabel, Problems, reportId, type MapResult, type Observation, type Report, type Subject } from "@mark1russell7/alerts";
import { errorMessage } from "@mark1russell7/text";

import { isHeadBody, isRecordBody, isRefusedBody, type RecordBody } from "./body.ts";
import { DAY_MS, type OsvProvider } from "./providers.ts";

/** The system of the subject of a package: its purl with no version. */
export const PURL_SYSTEM = "purl";

/** The system of the subject and of the correlation key of a CVE alias. */
export const CVE_SYSTEM = "cve";

/** The system of the correlation key of the id of an OSV record and of an alias that is no CVE id. */
export const OSV_SYSTEM = "osv";

/**
 * The time after the last change of a record at which its report ends: 30 days. A record has no end of its own. A change of
 * the record gives a new report with a new end.
 */
export const RECORD_LIFE_MS: number = 30 * DAY_MS;

/** The time after the publication of a record from which a change of the record gives an update, not an alert: 1 day. */
export const UPDATE_AFTER_MS: number = DAY_MS;

/** The page of a record on OSV.dev. */
export const OSV_PAGE = "https://osv.dev/vulnerability/";

/** The pattern of a CVE id. */
const CVE_PATTERN = /^CVE-[0-9]{4}-[0-9]{4,}$/;

/** The instruction of a report of a malicious package. */
const INSTRUCTION = "Do not install the versions that the report names. Remove them, and change each secret of each computer that installed them.";

/** This function makes the map function of one provider. The function does not throw. */
export function createOsvMap(provider: OsvProvider): (observation: Observation) => MapResult {
  return (observation) => {
    try {
      return mapOrThrow(provider, observation);
    } catch (error) {
      return { reports: [], problems: [{ path: "", message: `the map function failed: ${errorMessage(error)}`, fatal: true }] };
    }
  };
}

/** This function maps one observation, and can throw. The map function catches each error. */
function mapOrThrow(provider: OsvProvider, observation: Observation): MapResult {
  let fields: unknown;
  try {
    fields = JSON.parse(observation.body);
  } catch {
    return { reports: [], problems: [{ path: "", message: "the body is not JSON", fatal: true }] };
  }
  if (isHeadBody(fields)) return { reports: [], problems: [] };
  if (isRefusedBody(fields)) return { reports: [], problems: [{ path: "", message: `the record breaks the OSV schema: ${fields.message} (${fields.url})`, fatal: true }] };
  if (!isRecordBody(fields)) return { reports: [], problems: [{ path: "", message: "the observation is not a record of the source: the format changed", fatal: true }] };
  const problems = new Problems();
  const report = reportOf(provider, observation, fields, problems);
  return { reports: [report], problems: problems.list };
}

/** This function gives the report of one record. */
function reportOf(provider: OsvProvider, observation: Observation, record: RecordBody, problems: Problems): Report {
  const modified = Date.parse(record.modified);
  const published = record.published === undefined ? undefined : Date.parse(record.published);
  const withdrawn = record.withdrawn === undefined ? undefined : Date.parse(record.withdrawn);
  const cves = record.aliases.filter((alias) => CVE_PATTERN.test(alias));
  const about: Subject[] = [];
  record.packages.forEach((pkg, index) => {
    const label = `${pkg.name} (${pkg.ecosystem})`;
    if (pkg.purl === undefined) problems.add(`packages[${String(index)}]`, `the ecosystem ${pkg.ecosystem} has no purl type: the report has no subject for ${label}`, "note");
    else about.push({ system: PURL_SYSTEM, id: pkg.purl, label });
  });
  for (const cve of cves) about.push({ system: CVE_SYSTEM, id: cve });
  const names = record.packages.slice(0, 3).map((pkg) => `${pkg.name} (${pkg.ecosystem})`);
  const title = record.summary ?? (names.length === 0 ? "A malicious package" : `Malicious code in ${names.join(", ")}`);
  const key = record.id;
  // A cancel has a key of its own. A report that references its own key makes a cycle, and a cycle leaves no head.
  const cancel = withdrawn !== undefined && withdrawn <= observation.fetched;
  const own = cancel ? `${key}#withdrawn` : key;
  const common = {
    id: reportId({ source: provider.id, key: own, sent: modified }),
    source: provider.id,
    origin: provider.origin,
    key: own,
    correlation: [{ system: OSV_SYSTEM, id: record.id }, ...record.aliases.map((alias) => ({ system: CVE_PATTERN.test(alias) ? CVE_SYSTEM : OSV_SYSTEM, id: alias }))],
    status: "actual" as const,
    kind: { code: provider.kind, label: kindLabel(provider.kind) },
    categories: [categoryOf(provider.kind)],
    sent: modified,
    received: observation.fetched,
    areas: [],
    about,
    sender: provider.sender,
    web: `${OSV_PAGE}${encodeURIComponent(record.id)}`,
    observation: observation.id,
    parameters: withValues({
      record: [record.url],
      ecosystem: [...new Set(record.packages.map((pkg) => pkg.ecosystem))],
      package: record.packages.map((pkg) => pkg.name),
      version: record.packages.flatMap((pkg) => pkg.versions),
      range: record.packages.flatMap((pkg) => pkg.ranges),
      alias: record.aliases,
      cwe: record.cwes,
      score: record.scores,
      ...(record.severity === undefined ? {} : { databaseSeverity: [record.severity] }),
      terms: [provider.terms.text],
      termsUrl: [provider.terms.url],
    }),
  };
  if (cancel && withdrawn !== undefined) {
    // The database withdrew the record: the package is not malicious. The cancel ends the report at once.
    return {
      ...common,
      references: [key],
      op: "cancel",
      severity: "unknown",
      urgency: "past",
      certainty: "unlikely",
      response: ["allclear"],
      effective: withdrawn,
      expires: modified,
      headline: `${record.id} withdrawn: ${title}`,
      description: "The database withdrew the record. The package is not malicious.",
    };
  }
  return {
    ...common,
    references: [],
    op: published !== undefined && modified - published > UPDATE_AFTER_MS ? "update" : "alert",
    // Malware in a package takes the secrets of each computer that installs it: a significant threat to property.
    severity: "severe",
    urgency: "immediate",
    // A database withdraws some records as false positives.
    certainty: "likely",
    response: ["avoid"],
    effective: published ?? modified,
    expires: modified + RECORD_LIFE_MS,
    headline: `${record.id}: ${title}`,
    ...(record.details === undefined ? {} : { description: record.details }),
    instruction: INSTRUCTION,
  };
}

/** This function removes each parameter with no value. */
function withValues(parameters: Readonly<Record<string, readonly string[]>>): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(Object.entries(parameters).filter(([, values]) => values.length > 0));
}
