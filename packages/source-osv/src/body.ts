/**
 * The bodies of the observations of the OSV source. The fetch gives one head body for each fetch and one record body for
 * each record that it read. A record body holds the fields of the record that the map uses, in a short form. It holds no
 * person: the reader drops the `credits` of the record.
 */

import { isRecord, readText } from "@mark1russell7/optional/read";

import { cwesOf, readOsvText, type OsvRange, type OsvRecord } from "./osv.ts";
import { packagePurl } from "./purl.ts";

/** The longest text of the details of a record, in characters. A longer text is cut. */
export const MAX_DETAILS = 2000;

/** The most packages of one record body. */
export const MAX_PACKAGES = 20;

/** The most versions of one package of a record body. */
export const MAX_VERSIONS = 50;

/** The most references of one record body. */
export const MAX_REFERENCES = 5;

/** One change list of the head of a fetch of the exports. */
export interface ListHead {
  readonly ecosystem: string;
  /** The time of the newest change of the list, or `null` for an empty list. */
  readonly newest: string | null;
  /** The count of the lines that the fetch read. */
  readonly lines: number;
  /** True when the read part of the list does not reach the position of the cursor: the fetch passes some changes. */
  readonly gap: boolean;
}

/** The body of the head of a fetch: the observation of each fetch that the canary reads. */
export interface HeadBody {
  /** The id of the provider of the feed. */
  readonly feed: string;
  /** The time of the newest change of the feed, or `null` for a feed with no change. */
  readonly newest: string | null;
  /** The count of the changes that the fetch found and did not read. The next fetches read them. */
  readonly pending: number;
  /** The count of the records that the fetch read. */
  readonly read: number;
  /** True when the fetch passes some changes, because the feed did not give them. */
  readonly gap: boolean;
  /** The change lists of a fetch of the exports. */
  readonly lists?: readonly ListHead[];
  /** The commit of a fetch of a GitHub repository. */
  readonly commit?: string;
}

/** One package of a record body. */
export interface PackageBody {
  readonly ecosystem: string;
  readonly name: string;
  /** The purl of the package with no version, or absent for an ecosystem with no purl type. */
  readonly purl?: string;
  readonly versions: readonly string[];
  /** The ranges of affected versions as texts, for example `SEMVER introduced 0, last_affected 3.16.2`. */
  readonly ranges: readonly string[];
}

/** The body of one record. */
export interface RecordBody {
  /** The URL of the file of the record. */
  readonly url: string;
  readonly id: string;
  readonly aliases: readonly string[];
  readonly summary?: string;
  /** The details of the record, cut to `MAX_DETAILS` characters. */
  readonly details?: string;
  readonly packages: readonly PackageBody[];
  /** The times of the record, as ISO 8601. */
  readonly modified: string;
  readonly published?: string;
  readonly withdrawn?: string;
  /** The severity text of `database_specific`, for example `CRITICAL`. */
  readonly severity?: string;
  /** The scores of the field `severity`, for example a CVSS vector. */
  readonly scores: readonly string[];
  readonly cwes: readonly string[];
  /** The URLs of the references, at most `MAX_REFERENCES`. */
  readonly references: readonly string[];
}

/** The body of a file that the reader refused: the file breaks the schema. */
export interface RefusedBody {
  readonly refused: "format";
  readonly url: string;
  readonly message: string;
}

/** This function gives the text of a range of affected versions. */
export function rangeText(range: OsvRange): string {
  return `${range.type} ${range.events.map((event) => `${event.name} ${event.version}`).join(", ")}`;
}

/** This function cuts a text to a length, with an ellipsis at the end of a cut text. */
function cut(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/** This function gives the body of one record. */
export function recordBody(record: OsvRecord, url: string): RecordBody {
  const packages: PackageBody[] = [];
  for (const affected of record.affected) {
    if (affected.package === undefined || packages.length >= MAX_PACKAGES) continue;
    const purl = packagePurl(affected.package);
    packages.push({
      ecosystem: affected.package.ecosystem,
      name: affected.package.name,
      ...(purl === undefined ? {} : { purl }),
      versions: affected.versions.slice(0, MAX_VERSIONS),
      ranges: affected.ranges.map(rangeText),
    });
  }
  const details = record.details?.trim();
  const severity = readText(record.databaseSpecific?.["severity"]);
  return {
    url,
    id: record.id,
    aliases: record.aliases,
    ...(record.summary === undefined ? {} : { summary: record.summary }),
    ...(details === undefined || details === "" ? {} : { details: cut(details, MAX_DETAILS) }),
    packages,
    modified: new Date(record.modified).toISOString(),
    ...(record.published === undefined ? {} : { published: new Date(record.published).toISOString() }),
    ...(record.withdrawn === undefined ? {} : { withdrawn: new Date(record.withdrawn).toISOString() }),
    ...(severity === undefined ? {} : { severity }),
    scores: record.severity.map((entry) => entry.score),
    cwes: cwesOf(record),
    references: record.references.slice(0, MAX_REFERENCES).map((reference) => reference.url),
  };
}

/** This function gives the body of the text of one file: the body of its record, or the body of a refused file. */
export function fileBody(text: string, url: string): RecordBody | RefusedBody {
  const read = readOsvText(text);
  if (read.ok) return recordBody(read.record, url);
  return { refused: "format", url, message: read.path === "" ? read.message : `${read.path}: ${read.message}` };
}

/** This function tells if a body is the head of a fetch. */
export function isHeadBody(fields: unknown): fields is HeadBody {
  return isRecord(fields) && typeof fields["feed"] === "string" && typeof fields["pending"] === "number" && typeof fields["read"] === "number";
}

/** This function tells if a body is the body of a refused file. */
export function isRefusedBody(fields: unknown): fields is RefusedBody {
  return isRecord(fields) && fields["refused"] === "format" && typeof fields["url"] === "string" && typeof fields["message"] === "string";
}

/** This function tells if a body is the body of a record. */
export function isRecordBody(fields: unknown): fields is RecordBody {
  return (
    isRecord(fields) &&
    ["url", "id", "modified"].every((name) => typeof fields[name] === "string") &&
    ["aliases", "packages", "scores", "cwes", "references"].every((name) => Array.isArray(fields[name]))
  );
}
