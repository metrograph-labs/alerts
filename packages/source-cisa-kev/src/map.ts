/**
 * The map function of the CISA KEV source. The catalog of known exploited vulnerabilities of CISA lists each flaw that
 * attackers use. The fetch gives one observation for each entry whose due date has not ended, and one observation of
 * the head of the catalog. An entry gives one report of the kind `cyber.vulnerability.exploited`. The head gives no report.
 *
 * The id of the flaw (`CVE-2026-1234`) is the subject of the report and its correlation key. Thus a person who names
 * the flaw gets the report, and a second source of the same flaw joins its incident.
 */

import { categoryOf, kindLabel, Problems, reportId, type Instant, type MapResult, type Observation, type Report, type Severity, type SourceId } from "@mark1russell7/alerts";
import { isRecord, textOf, type Fields } from "@mark1russell7/optional/read";
import { errorMessage } from "@mark1russell7/text";

/** The id of this source. */
export const SOURCE_ID = "cisa-kev" as SourceId;

/** The id of the origin of the reports: CISA, the cyber defense agency of the United States. */
export const KEV_ORIGIN = "cisa";

/** The kind of each report. */
export const EXPLOITED_KIND = "cyber.vulnerability.exploited";

/** The kind codes of this source. */
export const KEV_KINDS: readonly string[] = [EXPLOITED_KIND];

/** The sender of each report. */
export const KEV_SENDER = "Cybersecurity and Infrastructure Security Agency (CISA)";

/** The license of the catalog: CC0 1.0. The terms forbid the use of the logo of CISA and the seal of DHS. */
export const KEV_LICENSE = "CC0 1.0";

/** The text of the license of the catalog. */
export const KEV_LICENSE_URL = "https://www.cisa.gov/sites/default/files/licenses/kev/license.txt";

/** The page of the catalog for a person. */
export const KEV_PAGE = "https://www.cisa.gov/known-exploited-vulnerabilities-catalog";

/** The system of the subject and of the correlation key of each report: the CVE id of the flaw. */
export const CVE_SYSTEM = "cve";

/**
 * The fields of the body of an entry, in this order. The fetch keeps only these fields of each entry. Thus a new field
 * of the catalog does not change the id of an observation.
 */
export const ENTRY_FIELDS = [
  "cveID",
  "vendorProject",
  "product",
  "vulnerabilityName",
  "dateAdded",
  "shortDescription",
  "requiredAction",
  "dueDate",
  "knownRansomwareCampaignUse",
  "forensicTriage",
  "notes",
  "cwes",
] as const;

/** The fields of the body of the head of the catalog, in this order. */
export const HEAD_FIELDS = ["title", "catalogVersion", "dateReleased", "count"] as const;

/** The length of one day, in milliseconds. */
const DAY_MS = 86_400_000;

/** This function tells if a value is a CVE id: `CVE-`, a year of 4 digits, `-` and 4 or more digits. */
export function isCveId(value: unknown): value is string {
  return typeof value === "string" && /^CVE-\d{4}-\d{4,}$/.test(value);
}

/**
 * This function gives the start of a date of the catalog, at 00:00 UTC. The value is `YYYY-MM-DD`. Each other value,
 * and a day that the calendar does not have, gives `undefined`.
 */
export function dateStart(value: unknown): Instant | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const time = Date.parse(`${value}T00:00:00Z`);
  // The round trip refuses a day that the calendar does not have, for example 31 November.
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : undefined;
}

/**
 * This function gives the end of the due date of an entry: 00:00 UTC of the next day. The catalog gives a date with no
 * time zone. The end of the day in UTC is the earliest end of that day in the time zones of the United States.
 */
export function dueEnd(value: unknown): Instant | undefined {
  const start = dateStart(value);
  return start === undefined ? undefined : start + DAY_MS;
}

/** This function tells if a body is the head of the catalog: a version, and only the fields of `HEAD_FIELDS`. */
export function isHead(fields: Fields): boolean {
  return typeof fields["catalogVersion"] === "string" && Object.keys(fields).every((field) => (HEAD_FIELDS as readonly string[]).includes(field));
}

/** This function tells if an entry has the structure of the catalog: a CVE id, a name, an added date and a due date. */
export function isKevEntry(entry: Fields): boolean {
  return isCveId(entry["cveID"]) && typeof entry["vulnerabilityName"] === "string" && dateStart(entry["dateAdded"]) !== undefined && dueEnd(entry["dueDate"]) !== undefined;
}

/**
 * This function gives the severity of an entry. A flaw that ransomware uses, or a flaw after which CISA asks for a
 * forensic triage, is a significant threat to property: `severe`. Each other flaw is `moderate`.
 */
export function severityOf(entry: Fields): Severity {
  return entry["knownRansomwareCampaignUse"] === "Known" || entry["forensicTriage"] === "Yes" ? "severe" : "moderate";
}

/** This function maps one observation. It does not throw. A body that it does not understand gives a fatal problem. */
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
  if (isRecord(fields) && isHead(fields)) return { reports: [], problems: [] };
  // The fetch gives the whole answer as one observation when the answer is not the catalog.
  if (!isRecord(fields) || !Object.hasOwn(fields, "cveID")) {
    return { reports: [], problems: [{ path: "", message: "the observation is not one entry of the catalog of CISA: the format changed", fatal: true }] };
  }
  const problems = new Problems();
  if (!isCveId(fields["cveID"])) problems.add("cveID", `the value ${JSON.stringify(fields["cveID"])} is not a CVE id: the map makes no report`, "fatal");
  if (typeof fields["vulnerabilityName"] !== "string") problems.add("vulnerabilityName", "the entry has no name: the map makes no report", "fatal");
  if (dateStart(fields["dateAdded"]) === undefined) problems.add("dateAdded", `the value ${JSON.stringify(fields["dateAdded"])} is not a date: the map makes no report`, "fatal");
  if (dueEnd(fields["dueDate"]) === undefined) problems.add("dueDate", `the value ${JSON.stringify(fields["dueDate"])} is not a date: the map makes no report`, "fatal");
  if (!isKevEntry(fields)) return { reports: [], problems: problems.list };
  return { reports: [reportOf(observation, fields)], problems: problems.list };
}

/** This function gives the report of one valid entry. */
function reportOf(observation: Observation, entry: Fields): Report {
  const cve = entry["cveID"] as string;
  const added = dateStart(entry["dateAdded"])!;
  const expires = dueEnd(entry["dueDate"])!;
  const vendor = textOf(entry, "vendorProject");
  const product = textOf(entry, "product");
  const label = [vendor, product].filter((part) => part !== undefined).join(" ");
  const action = textOf(entry, "requiredAction");
  const cwes = Array.isArray(entry["cwes"]) ? entry["cwes"].filter((each): each is string => typeof each === "string") : [];
  const notes = (textOf(entry, "notes") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const parameter = (field: string): readonly string[] => {
    const text = textOf(entry, field);
    return text === undefined ? [] : [text];
  };
  // The catalog gives no time of the change of an entry. The fetch time of the first answer with this body is the closest time.
  const sent = observation.fetched;
  const key = cve;
  return {
    id: reportId({ source: SOURCE_ID, key, sent }),
    source: SOURCE_ID,
    origin: KEV_ORIGIN,
    key,
    references: [],
    correlation: [{ system: CVE_SYSTEM, id: cve }],
    status: "actual",
    op: "alert",
    kind: { code: EXPLOITED_KIND, label: kindLabel(EXPLOITED_KIND) },
    categories: [categoryOf(EXPLOITED_KIND)],
    severity: severityOf(entry),
    // Attackers use the flaw now. CISA asks for the action before the end of the due date.
    urgency: expires > observation.fetched ? "immediate" : "past",
    certainty: "observed",
    response: ["execute"],
    sent,
    received: observation.fetched,
    effective: added,
    expires,
    areas: [],
    about: [{ system: CVE_SYSTEM, id: cve, ...(label === "" ? {} : { label }) }],
    sender: KEV_SENDER,
    headline: `${cve}: ${(entry["vulnerabilityName"] as string).trim()}`,
    ...(textOf(entry, "shortDescription") === undefined ? {} : { description: textOf(entry, "shortDescription")! }),
    ...(action === undefined ? {} : { instruction: `${action} Due date: ${entry["dueDate"] as string}.` }),
    web: `https://nvd.nist.gov/vuln/detail/${cve}`,
    observation: observation.id,
    parameters: withValues({
      vendor: parameter("vendorProject"),
      product: parameter("product"),
      dateAdded: [entry["dateAdded"] as string],
      dueDate: [entry["dueDate"] as string],
      knownRansomwareCampaignUse: parameter("knownRansomwareCampaignUse"),
      forensicTriage: parameter("forensicTriage"),
      cwe: cwes,
      notes,
      catalog: [KEV_PAGE],
      license: [KEV_LICENSE],
    }),
  };
}

/** This function removes each parameter with no value. */
function withValues(parameters: Readonly<Record<string, readonly string[]>>): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(Object.entries(parameters).filter(([, values]) => values.length > 0));
}
