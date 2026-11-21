/**
 * The map functions of Cloudflare Radar. The fetch gives one observation for each live record of a list. A record gives
 * one report.
 *
 * - An outage of the outage center gives a report of `infra.internet.outage`. An outage that an authority ordered gives
 *   `infra.internet.shutdown`, and an outage of a platform gives `infra.cloud.outage`. The scope of the outage gives the
 *   severity. The analysts confirm each outage, so its certainty is `observed`.
 * - A traffic anomaly gives a report of `infra.internet.outage`, or `infra.cloud.outage` for a cloud region. A model
 *   finds each anomaly, so its certainty is `likely` or `possible`.
 *
 * The key of a report is the id of its record, and its time is the start of the record. An outage gives the shared key
 * `cloudflare-radar-outage` with its id. An anomaly that names the outage gives the same key, so the two reports make one
 * incident. The areas are only the countries (ISO 3166) and the regions (GeoNames) that the record names as its places.
 * The country of a network is not an area: an outage of one network does not go to each person of its country. The
 * subjects are the networks (`asn`) and the cloud regions (`provider-region`) of the record.
 */

import { categoryOf, kindLabel, Problems, reportId, type Area, type Certainty, type CorrelationKey, type Instant, type MapResult, type Observation, type Report, type Severity, type Subject } from "@mark1russell7/alerts";
import { isRecord, numberOf, textOf, timeOf, type Fields } from "@mark1russell7/optional/read";
import { errorMessage } from "@mark1russell7/text";

import {
  ANOMALIES_PAGE,
  ANOMALIES_SOURCE,
  ASN_SYSTEM,
  CLOUD_KIND,
  COUNTRY_SYSTEM,
  DOMAIN_SYSTEM,
  GEONAMES_SYSTEM,
  OUTAGE_CENTER,
  OUTAGE_KEY_SYSTEM,
  OUTAGE_KIND,
  OUTAGES_SOURCE,
  originRegion,
  RADAR_ORIGIN,
  REGION_SYSTEM,
  SHUTDOWN_KIND,
} from "./feed.ts";

/** The name of the sender of each report. */
export const RADAR_SENDER = "Cloudflare Radar";

/** The credit of the data. The data of Cloudflare Radar is under the license CC BY-NC 4.0. Each report has the credit in its parameters. */
export const RADAR_CREDIT = "Cloudflare Radar, https://radar.cloudflare.com, CC BY-NC 4.0";

/** The severity of an outage for each scope. An outage of a whole country is severe. */
export const SEVERITY_OF_SCOPE: Readonly<Record<string, Severity>> = {
  NATIONWIDE: "severe",
  REGIONAL: "moderate",
  PLATFORM: "moderate",
  NETWORK: "minor",
};

/** The words of each scope of an outage in a headline. */
export const SCOPE_WORDS: Readonly<Record<string, string>> = {
  NATIONWIDE: "nationwide internet outage",
  REGIONAL: "regional internet outage",
  PLATFORM: "outage of a platform",
  NETWORK: "outage of a network",
};

/** The words of each cause of an outage in a headline. */
export const CAUSE_WORDS: Readonly<Record<string, string>> = {
  CABLE_CUT: "cable cut",
  CYBERATTACK: "cyberattack",
  GOVERNMENT_DIRECTED: "government order",
  MAINTENANCE: "maintenance",
  MILITARY_ACTION: "military action",
  NATURAL_DISASTER: "natural disaster",
  NETWORK_PROBLEM: "network problem",
  POWER_OUTAGE: "power outage",
  TECHNICAL_PROBLEM: "technical problem",
  UNKNOWN: "unknown cause",
};

/** The severity of an anomaly for each type. A drop of the traffic of a whole country is moderate. */
export const SEVERITY_OF_ANOMALY: Readonly<Record<string, Severity>> = {
  LOCATION: "moderate",
  AS: "minor",
  ORIGIN: "minor",
};

/** The certainty of an anomaly for each status. A person of Cloudflare checks an anomaly with the status `VERIFIED`. */
export const CERTAINTY_OF_STATUS: Readonly<Record<string, Certainty>> = {
  VERIFIED: "likely",
  TP: "likely",
  UNVERIFIED: "possible",
};

/** The count of names in the place of a headline. The headline counts the other names. */
export const HEADLINE_NAMES = 3;

/** This function gives the text of a field, or the text of its finite number. The API gives some ids as numbers, for example an ASN. */
function textOrNumberOf(fields: Fields, field: string): string | undefined {
  return textOf(fields, field) ?? numberOf(fields, field)?.toString();
}

/** This function gives the objects of a list field. A value that is not an object gives no entry. */
function listOf(fields: Fields, field: string): readonly Fields[] {
  const value = fields[field];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** This function gives the texts of a list field. A number gives its text, and each other value gives no entry. */
function textsOf(fields: Fields, field: string): readonly string[] {
  const value = fields[field];
  if (!Array.isArray(value)) return [];
  return value.flatMap((each: unknown) => (typeof each === "number" && Number.isFinite(each) ? [String(each)] : typeof each === "string" && each.trim() !== "" ? [each.trim()] : []));
}

/** This function removes the second and each later copy of each value. */
function unique<T>(values: readonly T[], keyOf: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = keyOf(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** This function gives the area of a country. */
const countryArea = (code: string): Area => ({ type: "code", system: COUNTRY_SYSTEM, code: code.toUpperCase() });

/** One network of a record: its number, its name and the name of its country. The country is not an area of the report. */
interface Network {
  readonly asn: string;
  readonly name?: string;
  readonly countryName?: string;
}

/** This function gives the network of the details of a network, or `undefined` for details with no number. */
function networkOf(details: Fields): Network | undefined {
  const asn = textOrNumberOf(details, "asn");
  if (asn === undefined) return undefined;
  const name = textOrNumberOf(details, "name");
  const location = details["location"];
  const countryName = isRecord(location) ? textOrNumberOf(location, "name") : undefined;
  return { asn, ...(name === undefined ? {} : { name }), ...(countryName === undefined ? {} : { countryName }) };
}

/** This function gives the subject of a network. */
const networkSubject = (network: Network): Subject => ({ system: ASN_SYSTEM, id: network.asn, label: network.name === undefined ? `AS${network.asn}` : `${network.name} (AS${network.asn})` });

/** This function gives the name of a network in a headline. */
const networkName = (network: Network): string => (network.name === undefined ? `AS${network.asn}` : `${network.name} (AS${network.asn})`);

/**
 * This function gives the subjects of the cloud origins of a record: the region of each origin and the domain of each
 * provider. An origin with an unknown prefix gives a problem of the kind `note` and no subject.
 */
function originSubjects(origins: readonly { readonly origin: string; readonly name?: string }[], problems: Problems): Subject[] {
  const regions: Subject[] = [];
  const domains: Subject[] = [];
  for (const { origin, name } of origins) {
    const region = originRegion(origin);
    if (region === undefined) {
      problems.add("origins", `the origin ${origin} has an unknown provider: the report has no subject for it`, "note");
      continue;
    }
    regions.push({ system: REGION_SYSTEM, id: region.id, label: name ?? origin });
    if (region.provider.domain !== undefined) domains.push({ system: DOMAIN_SYSTEM, id: region.provider.domain, label: region.provider.name });
  }
  return [...unique(domains, (subject) => subject.id), ...unique(regions, (subject) => subject.id)];
}

/** This function gives the place of a headline: the first names, and the count of the others. */
function placeOf(names: readonly string[]): string {
  if (names.length === 0) return "no place";
  const first = names.slice(0, HEADLINE_NAMES).join(", ");
  return names.length > HEADLINE_NAMES ? `${first} and ${names.length - HEADLINE_NAMES} more` : first;
}

/**
 * This function gives the names of the cloud origins in a headline. One origin gives its name. More origins give the name
 * of each provider with its count of regions.
 */
function originNames(origins: readonly { readonly origin: string; readonly name?: string }[]): string[] {
  if (origins.length === 1) return [origins[0]!.name ?? origins[0]!.origin];
  const counts = new Map<string, number>();
  for (const { origin } of origins) {
    const name = originRegion(origin)?.provider.name ?? origin;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => (count === 1 ? name : `${name} (${count} regions)`));
}

/** This function gives the URL of a record when it is an https URL. */
function httpsOf(fields: Fields, field: string): string | undefined {
  const url = textOrNumberOf(fields, field);
  return url !== undefined && url.startsWith("https://") ? url : undefined;
}

/** This function removes each parameter with no value. */
function withValues(parameters: Readonly<Record<string, readonly string[]>>): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(Object.entries(parameters).filter(([, values]) => values.length > 0));
}

/** The facts of a report that the two lists give in the same form. */
interface Common {
  readonly source: typeof OUTAGES_SOURCE | typeof ANOMALIES_SOURCE;
  readonly key: string;
  readonly sent: Instant;
  readonly ends: Instant | undefined;
  readonly kind: string;
  readonly severity: Severity;
  readonly certainty: Certainty;
  readonly correlation: readonly CorrelationKey[];
  readonly areas: readonly Area[];
  readonly areaText: string | undefined;
  readonly about: readonly Subject[];
  readonly headline: string;
  readonly description: string | undefined;
  readonly web: string;
  readonly parameters: Readonly<Record<string, readonly string[]>>;
}

/** This function gives the report of the common facts. */
function reportOf(observation: Observation, common: Common): Report {
  return {
    id: reportId({ source: common.source, key: common.key, sent: common.sent }),
    source: common.source,
    origin: RADAR_ORIGIN,
    key: common.key,
    references: [],
    correlation: common.correlation,
    status: "actual",
    op: "alert",
    kind: { code: common.kind, label: kindLabel(common.kind) },
    categories: [categoryOf(common.kind)],
    severity: common.severity,
    urgency: "immediate",
    certainty: common.certainty,
    response: ["monitor"],
    sent: common.sent,
    received: observation.fetched,
    effective: common.sent,
    ...(common.ends === undefined ? {} : { ends: common.ends }),
    areas: common.areas,
    ...(common.areaText === undefined ? {} : { areaText: common.areaText }),
    about: common.about,
    sender: RADAR_SENDER,
    headline: common.headline,
    ...(common.description === undefined ? {} : { description: common.description }),
    web: common.web,
    observation: observation.id,
    parameters: withValues({ ...common.parameters, credit: [RADAR_CREDIT] }),
  };
}

/** The record of an observation, or the result of a body that is not one record. */
type Parsed = { readonly ok: true; readonly record: Fields } | { readonly ok: false; readonly result: MapResult };

/** This function parses the body of an observation, or gives the fatal problem of a body that is not one record. */
function recordOf(observation: Observation, idField: string, what: string): Parsed {
  let fields: unknown;
  try {
    fields = JSON.parse(observation.body);
  } catch {
    return { ok: false, result: { reports: [], problems: [{ path: "", message: "the body is not JSON", fatal: true }] } };
  }
  // The fetch gives a record with no id as its own observation.
  if (!isRecord(fields) || textOrNumberOf(fields, idField) === undefined) {
    return { ok: false, result: { reports: [], problems: [{ path: "", message: `the observation is not one ${what} of Cloudflare Radar: the format changed`, fatal: true }] } };
  }
  return { ok: true, record: fields };
}

/** This function maps one observation of the outages. It does not throw. A body that it does not understand gives a fatal problem. */
export function mapOutage(observation: Observation): MapResult {
  try {
    const parsed = recordOf(observation, "id", "outage");
    return parsed.ok ? outageResult(observation, parsed.record) : parsed.result;
  } catch (error) {
    return { reports: [], problems: [{ path: "", message: `the map function failed: ${errorMessage(error)}`, fatal: true }] };
  }
}

/** This function gives the report of one outage, or the fatal problems of an outage with no start. */
function outageResult(observation: Observation, record: Fields): MapResult {
  const problems = new Problems();
  const sent = timeOf(record, "startDate");
  if (sent === undefined) {
    problems.add("startDate", "the outage has no start: the map makes no report", "fatal");
    return { reports: [], problems: problems.list };
  }
  const outage = isRecord(record["outage"]) ? record["outage"] : {};
  const cause = textOrNumberOf(outage, "outageCause");
  const scope = textOrNumberOf(outage, "outageType");
  const severity = scope !== undefined && Object.hasOwn(SEVERITY_OF_SCOPE, scope) ? SEVERITY_OF_SCOPE[scope]! : undefined;
  if (severity === undefined) problems.add("outage.outageType", `the scope ${scope ?? "(none)"} is unknown: the severity is unknown`);
  if (cause === undefined || !Object.hasOwn(CAUSE_WORDS, cause)) problems.add("outage.outageCause", `the cause ${cause ?? "(none)"} is unknown`, "note");
  const kind = scope === "PLATFORM" ? CLOUD_KIND : cause === "GOVERNMENT_DIRECTED" ? SHUTDOWN_KIND : OUTAGE_KIND;

  const locations = listOf(record, "locationsDetails");
  const countries = unique([...textsOf(record, "locations"), ...locations.flatMap((each) => textOrNumberOf(each, "code") ?? [])].map((code) => code.toUpperCase()), (code) => code);
  const regions = unique(textsOf(record, "geoIds"), (id) => id);
  const networks = unique(
    [...listOf(record, "asnsDetails").flatMap((each) => networkOf(each) ?? []), ...textsOf(record, "asns").map((asn): Network => ({ asn }))],
    (network) => network.asn,
  );
  // A region is not its country: a regional outage does not go to each person of the country. A GeoNames code matches
  // only a place with that code.
  const areas: Area[] = [...countries.map(countryArea), ...regions.map((id): Area => ({ type: "code", system: GEONAMES_SYSTEM, code: id }))];
  const regionNames = unique(
    listOf(record, "entities").flatMap((entity) => (textOrNumberOf(entity, "entityType") === "GEOLOCATION" && regions.includes(textOrNumberOf(entity, "entityValue") ?? "") ? (textOrNumberOf(entity, "entityName") ?? []) : [])),
    (name) => name,
  );

  const originsDetails = listOf(record, "originsDetails").flatMap((each) => {
    const origin = textOrNumberOf(each, "origin");
    const name = textOrNumberOf(each, "name");
    return origin === undefined ? [] : [{ origin, ...(name === undefined ? {} : { name }) }];
  });
  const origins = unique([...originsDetails, ...textsOf(record, "origins").map((origin) => ({ origin }))], (each) => each.origin);
  const about = [...networks.map(networkSubject), ...originSubjects(origins, problems)];

  const placeNames = [...locations.flatMap((each) => textOrNumberOf(each, "name") ?? []), ...regionNames];
  const names = placeNames.length > 0 ? placeNames : networks.length > 0 ? networks.map(networkName) : originNames(origins);
  const scopeWords = scope !== undefined && Object.hasOwn(SCOPE_WORDS, scope) ? SCOPE_WORDS[scope]! : "internet outage";
  const causeWords = cause !== undefined && Object.hasOwn(CAUSE_WORDS, cause) ? CAUSE_WORDS[cause]! : "unknown cause";
  const key = textOrNumberOf(record, "id")!;
  const report = reportOf(observation, {
    source: OUTAGES_SOURCE,
    key,
    sent,
    ends: timeOf(record, "endDate"),
    kind,
    severity: severity ?? "unknown",
    certainty: "observed",
    correlation: [{ system: OUTAGE_KEY_SYSTEM, id: key }],
    areas,
    areaText: placeNames.length > 0 ? placeNames.join(", ") : undefined,
    about,
    headline: `Cloudflare Radar: ${scopeWords} (${causeWords}): ${placeOf(names)}`,
    description: textOrNumberOf(record, "description"),
    web: httpsOf(record, "linkedUrl") ?? OUTAGE_CENTER,
    parameters: {
      cause: cause === undefined ? [] : [cause],
      scope: scope === undefined ? [] : [scope],
      dataSource: textOrNumberOf(record, "dataSource") === undefined ? [] : [textOrNumberOf(record, "dataSource")!],
      origin: origins.map((each) => each.origin),
    },
  });
  return { reports: [report], problems: problems.list };
}

/** This function maps one observation of the traffic anomalies. It does not throw. A body that it does not understand gives a fatal problem. */
export function mapAnomaly(observation: Observation): MapResult {
  try {
    const parsed = recordOf(observation, "uuid", "traffic anomaly");
    return parsed.ok ? anomalyResult(observation, parsed.record) : parsed.result;
  } catch (error) {
    return { reports: [], problems: [{ path: "", message: `the map function failed: ${errorMessage(error)}`, fatal: true }] };
  }
}

/** This function gives the report of one anomaly, or the fatal problems of an anomaly with no start. */
function anomalyResult(observation: Observation, record: Fields): MapResult {
  const problems = new Problems();
  const sent = timeOf(record, "startDate");
  if (sent === undefined) {
    problems.add("startDate", "the anomaly has no start: the map makes no report", "fatal");
    return { reports: [], problems: problems.list };
  }
  const type = textOrNumberOf(record, "type");
  const status = textOrNumberOf(record, "status");
  const severity = type !== undefined && Object.hasOwn(SEVERITY_OF_ANOMALY, type) ? SEVERITY_OF_ANOMALY[type]! : undefined;
  if (severity === undefined) problems.add("type", `the type ${type ?? "(none)"} is unknown: the severity is unknown`);
  const certainty = status !== undefined && Object.hasOwn(CERTAINTY_OF_STATUS, status) ? CERTAINTY_OF_STATUS[status]! : undefined;
  if (certainty === undefined) problems.add("status", `the status ${status ?? "(none)"} is unknown: the certainty is unknown`);

  const location = isRecord(record["locationDetails"]) ? record["locationDetails"] : undefined;
  const network = isRecord(record["asnDetails"]) ? networkOf(record["asnDetails"]) : undefined;
  const originDetails = isRecord(record["originDetails"]) ? record["originDetails"] : undefined;
  const origin = originDetails === undefined ? undefined : textOrNumberOf(originDetails, "origin");
  const originName = originDetails === undefined ? undefined : textOrNumberOf(originDetails, "name");
  // Only an anomaly of a country has an area. The country of a network or of a region is not an area.
  const country = location === undefined ? undefined : textOrNumberOf(location, "code");
  const countryName = location === undefined ? undefined : textOrNumberOf(location, "name");
  const about = [
    ...(network === undefined ? [] : [networkSubject(network)]),
    ...(origin === undefined ? [] : originSubjects([{ origin, ...(originName === undefined ? {} : { name: originName }) }], problems)),
  ];
  const where = network !== undefined ? `${networkName(network)}${network.countryName === undefined ? "" : `, ${network.countryName}`}` : (countryName ?? originName ?? origin ?? "no place");
  const outageId = textOrNumberOf(record, "outageId");
  const report = reportOf(observation, {
    source: ANOMALIES_SOURCE,
    key: textOrNumberOf(record, "uuid")!,
    sent,
    ends: timeOf(record, "endDate"),
    kind: type === "ORIGIN" ? CLOUD_KIND : OUTAGE_KIND,
    severity: severity ?? "unknown",
    certainty: certainty ?? "unknown",
    correlation: outageId === undefined ? [] : [{ system: OUTAGE_KEY_SYSTEM, id: outageId }],
    areas: country === undefined ? [] : [countryArea(country)],
    areaText: country === undefined ? undefined : countryName,
    about,
    headline: `Cloudflare Radar: a drop of traffic: ${where}`,
    description: undefined,
    web: ANOMALIES_PAGE,
    parameters: {
      type: type === undefined ? [] : [type],
      status: status === undefined ? [] : [status],
      dataSource: textsOf(record, "visibleInDataSources"),
      outage: outageId === undefined ? [] : [outageId],
    },
  });
  return { reports: [report], problems: problems.list };
}
