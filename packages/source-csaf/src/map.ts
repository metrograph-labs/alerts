/**
 * The map function of a CSAF provider. The fetch gives one observation of the head of the feed and one observation for
 * each advisory that it read. An advisory gives one report of the kind of the provider. The head gives no report.
 *
 * The CVE id of each flaw is a subject of the report and a correlation key. Thus a person who names the flaw gets the
 * report. The report also joins the incident of the same flaw from a second source, for example the KEV catalog of CISA.
 */

import { categoryOf, CPE_SYSTEM, kindLabel, PACKAGE_SYSTEM, Problems, reportId, type MapProblem, type MapResult, type Observation, type Report, type Severity, type Subject } from "@mark1russell7/alerts";
import { isRecord } from "@mark1russell7/optional/read";
import { errorMessage } from "@mark1russell7/text";

import type { AdvisoryBody, Flaw, RefusedBody } from "./document.ts";
import { DAY_MS, type CsafProvider } from "./providers.ts";

/** The system of the subjects and of the correlation keys of the reports: the CVE id of a flaw. */
export const CVE_SYSTEM = "cve";

/**
 * The time after the last update of an advisory at which its report ends: 30 days. An advisory has no end of its own.
 * A new version of the advisory gives a new report with a new end.
 */
export const ADVISORY_LIFE_MS: number = 30 * DAY_MS;

/** The pattern of a CVE id. */
const CVE_PATTERN = /^CVE-[0-9]{4}-[0-9]{4,}$/;

/**
 * The severity of each text of `aggregate_severity`, in lower case. The texts are free in CSAF. These are the texts of the
 * providers of the source and of the ratings of CVSS. Each other text gives the severity from the CVSS scores.
 */
export const AGGREGATE_SEVERITY: ReadonlyMap<string, Severity> = new Map([
  ["critical", "severe"],
  ["high", "moderate"],
  ["important", "moderate"],
  ["medium", "minor"],
  ["moderate", "minor"],
  ["low", "minor"],
]);

/**
 * This function gives the severity of the highest CVSS 3 base score of an advisory. A critical flaw (9.0 or more) is a
 * significant threat to property: `severe`. A high flaw (7.0 or more) is `moderate`. Each other score is `minor`.
 * An advisory with no score is `unknown`.
 */
export function severityOfScore(score: number | undefined): Severity {
  if (score === undefined) return "unknown";
  return score >= 9 ? "severe" : score >= 7 ? "moderate" : "minor";
}

/** This function gives the highest CVSS 3 base score of the flaws, or `undefined`. */
export function highestScore(flaws: readonly Flaw[]): number | undefined {
  const scores = flaws.flatMap((flaw) => (flaw.score === undefined ? [] : [flaw.score]));
  return scores.length === 0 ? undefined : Math.max(...scores);
}

/** This function tells if a body is the head of a feed. */
export function isHeadBody(fields: Record<string, unknown>): boolean {
  return typeof fields["feed"] === "string" && typeof fields["entries"] === "number";
}

/** This function tells if a body is the body of a refused document. */
function isRefused(fields: Record<string, unknown>): fields is Record<string, unknown> & RefusedBody {
  return (fields["refused"] === "label" || fields["refused"] === "format") && typeof fields["message"] === "string";
}

/** This function tells if a body is the body of an advisory. */
function isAdvisory(fields: Record<string, unknown>): fields is Record<string, unknown> & AdvisoryBody {
  return ["url", "id", "version", "initial", "current", "title", "tlp"].every((name) => typeof fields[name] === "string") && Array.isArray(fields["flaws"]) && Array.isArray(fields["products"]) && (fields["packages"] === undefined || Array.isArray(fields["packages"])) && (fields["cpes"] === undefined || Array.isArray(fields["cpes"]));
}

/** This function makes the map function of one provider. The function does not throw. */
export function createCsafMap(provider: CsafProvider): (observation: Observation) => MapResult {
  return (observation) => {
    try {
      return mapOrThrow(provider, observation);
    } catch (error) {
      return { reports: [], problems: [{ path: "", message: `the map function failed: ${errorMessage(error)}`, fatal: true }] };
    }
  };
}

/** This function maps one observation, and can throw. The map function catches each error. */
function mapOrThrow(provider: CsafProvider, observation: Observation): MapResult {
  let fields: unknown;
  try {
    fields = JSON.parse(observation.body);
  } catch {
    return { reports: [], problems: [{ path: "", message: "the body is not JSON", fatal: true }] };
  }
  if (!isRecord(fields)) return { reports: [], problems: [{ path: "", message: "the body is not an object", fatal: true }] };
  if (isHeadBody(fields)) return { reports: [], problems: [] };
  if (isRefused(fields)) {
    const problem: MapProblem = { path: "", message: `${fields.message} (${fields.url})`, fatal: fields.refused === "format" };
    return { reports: [], problems: [problem] };
  }
  if (!isAdvisory(fields)) return { reports: [], problems: [{ path: "", message: "the observation is not an advisory of the source: the format changed", fatal: true }] };
  const problems = new Problems();
  const flaws = fields.flaws.filter((flaw, index) => {
    if (flaw.cve === undefined || CVE_PATTERN.test(flaw.cve)) return true;
    problems.add(`flaws[${String(index)}].cve`, `the value ${JSON.stringify(flaw.cve)} is not a CVE id: the report leaves it out`);
    return false;
  });
  return { reports: [reportOf(provider, observation, fields, flaws)], problems: problems.list };
}

/** This function gives the report of one advisory. */
function reportOf(provider: CsafProvider, observation: Observation, advisory: AdvisoryBody, flaws: readonly Flaw[]): Report {
  const sent = Date.parse(advisory.current);
  const cves = [...new Set(flaws.flatMap((flaw) => (flaw.cve === undefined ? [] : [flaw.cve])))];
  const score = highestScore(flaws);
  const severity = (advisory.severity === undefined ? undefined : AGGREGATE_SEVERITY.get(advisory.severity.trim().toLowerCase())) ?? severityOfScore(score);
  const product = advisory.products.length === 0 ? undefined : advisory.products.slice(0, 3).join(", ");
  const about: Subject[] = cves.map((cve) => ({ system: CVE_SYSTEM, id: cve, ...(product === undefined ? {} : { label: product }) }));
  // Each affected package is a subject with the ranges of its versions. Thus the match of the core finds the parts of a stack.
  for (const pkg of advisory.packages ?? []) about.push({ system: PACKAGE_SYSTEM, id: pkg.purl, ...(pkg.ranges === undefined ? {} : { ranges: pkg.ranges }) });
  // Each affected CPE product is a subject too. Thus a part that names its CPE matches an advisory with no purl of it.
  for (const item of advisory.cpes ?? []) about.push({ system: CPE_SYSTEM, id: item.cpe, ...(item.ranges === undefined ? {} : { ranges: item.ranges }) });
  const key = advisory.id;
  return {
    id: reportId({ source: provider.id, key, sent }),
    source: provider.id,
    origin: provider.origin,
    key,
    references: [],
    correlation: cves.map((cve) => ({ system: CVE_SYSTEM, id: cve })),
    status: advisory.status === "draft" ? "draft" : "actual",
    op: advisory.revisions > 1 ? "update" : "alert",
    kind: { code: provider.kind, label: kindLabel(provider.kind) },
    categories: [categoryOf(provider.kind)],
    severity,
    // The provider tells of a flaw, not of an attack: the action comes in the next days or weeks.
    urgency: "future",
    certainty: "observed",
    response: [advisory.fix ? "execute" : "assess"],
    sent,
    received: observation.fetched,
    effective: Date.parse(advisory.initial),
    expires: sent + ADVISORY_LIFE_MS,
    areas: [],
    about,
    sender: advisory.publisher === "" ? provider.sender : advisory.publisher,
    headline: `${advisory.id}: ${advisory.title}`,
    ...(advisory.summary === undefined ? {} : { description: advisory.summary }),
    ...(advisory.fix ? { instruction: "The vendor has a fix. Read the advisory and apply the fix or the mitigations that it gives." } : {}),
    // The terms of some providers ask for a link to the original advisory with each use.
    web: advisory.page ?? advisory.url,
    observation: observation.id,
    parameters: withValues({
      advisory: [advisory.url],
      version: [advisory.version],
      tlp: [advisory.tlp],
      cvss: score === undefined ? [] : [String(score)],
      cwe: [...new Set(flaws.flatMap((flaw) => (flaw.cwe === undefined ? [] : [flaw.cwe])))],
      product: advisory.products,
      package: [...new Set((advisory.packages ?? []).map((pkg) => pkg.purl))],
      cpe: [...new Set((advisory.cpes ?? []).map((item) => item.cpe))],
      ...(advisory.packagesCut === undefined ? {} : { packagesCut: [String(advisory.packagesCut)] }),
      ...(advisory.severity === undefined ? {} : { aggregateSeverity: [advisory.severity] }),
      terms: [provider.terms.text],
      termsUrl: [provider.terms.url],
    }),
  };
}

/** This function removes each parameter with no value. */
function withValues(parameters: Readonly<Record<string, readonly string[]>>): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(Object.entries(parameters).filter(([, values]) => values.length > 0));
}
