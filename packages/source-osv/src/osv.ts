/**
 * The reader of the OSV format: one record of a vulnerability or of a malicious package, as the schema of OSV 1.x gives
 * it (`https://ossf.github.io/osv-schema/`). The reader is general. It reads a `MAL-` record, a `GHSA-` record and each
 * other id in the same way.
 *
 * The reader checks the fields that the adapter uses against the schema, and keeps only these fields. Thus it drops the
 * `credits` of a record, with the names and the contacts of persons.
 */

import { arrayOf, fieldOf, isRecord, readText, readTime, type Fields } from "@mark1russell7/optional/read";

/** The types of a range of affected versions in the schema. */
export const RANGE_TYPES: readonly string[] = ["SEMVER", "ECOSYSTEM", "GIT"];

/** The names of the events of a range in the schema. Each event has exactly one of these fields. */
export const EVENT_NAMES: readonly string[] = ["introduced", "fixed", "last_affected", "limit"];

/** The pattern of an id of a record: a prefix of the database, a dash and the rest, for example `MAL-2026-20607`. */
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9._:-]+$/;

/** The longest id of a record, in characters. */
const MAX_ID = 128;

/** One event of a range: the version at which the flaw starts or ends. */
export interface OsvEvent {
  readonly name: "introduced" | "fixed" | "last_affected" | "limit";
  readonly version: string;
}

/** One range of affected versions. */
export interface OsvRange {
  readonly type: string;
  readonly events: readonly OsvEvent[];
}

/** One affected package, with its versions. */
export interface OsvAffected {
  /** The package. A record of a commit range of a repository has no package. */
  readonly package?: { readonly ecosystem: string; readonly name: string; readonly purl?: string };
  readonly ranges: readonly OsvRange[];
  readonly versions: readonly string[];
  /** The field `database_specific` of the package, for example the CWE ids of a malicious package. */
  readonly databaseSpecific?: Fields;
}

/** One severity of a record, for example a CVSS vector. */
export interface OsvSeverity {
  readonly type: string;
  readonly score: string;
}

/** One reference of a record: a type and a URL. */
export interface OsvReference {
  readonly type: string;
  readonly url: string;
}

/** One record of the OSV format, with the fields that the adapter uses. The times are in milliseconds. */
export interface OsvRecord {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly summary?: string;
  readonly details?: string;
  readonly affected: readonly OsvAffected[];
  readonly modified: number;
  readonly published?: number;
  /** The time at which the database withdrew the record. A withdrawn record tells of no real flaw or malware. */
  readonly withdrawn?: number;
  readonly severity: readonly OsvSeverity[];
  readonly references: readonly OsvReference[];
  /** The field `database_specific`: the free fields of the database. */
  readonly databaseSpecific?: Fields;
}

/** The result of a read: the record, or the path and the reason of the first break of the schema. */
export type OsvRead = { readonly ok: true; readonly record: OsvRecord } | { readonly ok: false; readonly path: string; readonly message: string };

/** The error of a read. The reader catches it and gives an `OsvRead` with `ok: false`. */
class SchemaError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.path = path;
  }
}

/** This function gives the text of a field that must be present. */
function required(value: unknown, path: string): string {
  const text = readText(value);
  if (text === undefined || text === "") throw new SchemaError(path, "the field must be a text that is not empty");
  return text;
}

/** This function gives the text of a field that can be absent. A present value of another type breaks the schema. */
function optionalText(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = readText(value);
  if (text === undefined) throw new SchemaError(path, "the field must be a text");
  return text;
}

/** This function gives the time of a field that can be absent, in milliseconds. */
function optionalTime(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const time = readTime(value);
  if (time === undefined) throw new SchemaError(path, "the field must be a time in the form of RFC 3339");
  return time;
}

/** This function gives the items of a list that can be absent. A present value that is no list breaks the schema. */
function list(value: unknown, path: string): readonly unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new SchemaError(path, "the field must be a list");
  return value;
}

/** This function gives the texts of a list of texts that can be absent. */
function texts(value: unknown, path: string): readonly string[] {
  return list(value, path).map((item, index) => required(item, `${path}[${String(index)}]`));
}

/** This function reads one event of a range. */
function eventOf(value: unknown, path: string): OsvEvent {
  if (!isRecord(value)) throw new SchemaError(path, "an event must be an object");
  const names = EVENT_NAMES.filter((name) => value[name] !== undefined);
  if (names.length !== 1) throw new SchemaError(path, `an event must have exactly one of the fields ${EVENT_NAMES.join(", ")}`);
  const name = names[0] as OsvEvent["name"];
  return { name, version: required(value[name], `${path}.${name}`) };
}

/** This function reads one range of affected versions. */
function rangeOf(value: unknown, path: string): OsvRange {
  if (!isRecord(value)) throw new SchemaError(path, "a range must be an object");
  const type = required(value["type"], `${path}.type`);
  if (!RANGE_TYPES.includes(type)) throw new SchemaError(`${path}.type`, `the type ${JSON.stringify(type)} is not a type of the schema`);
  const events = list(value["events"], `${path}.events`).map((event, index) => eventOf(event, `${path}.events[${String(index)}]`));
  if (events.length === 0) throw new SchemaError(`${path}.events`, "a range must have one or more events");
  return { type, events };
}

/** This function reads one affected package. */
function affectedOf(value: unknown, path: string): OsvAffected {
  if (!isRecord(value)) throw new SchemaError(path, "an affected entry must be an object");
  const ranges = list(value["ranges"], `${path}.ranges`).map((range, index) => rangeOf(range, `${path}.ranges[${String(index)}]`));
  const versions = texts(value["versions"], `${path}.versions`);
  const special = value["database_specific"];
  const common = { ranges, versions, ...(isRecord(special) ? { databaseSpecific: special } : {}) };
  const pkg = value["package"];
  if (pkg === undefined || pkg === null) return common;
  if (!isRecord(pkg)) throw new SchemaError(`${path}.package`, "the package must be an object");
  const purl = optionalText(pkg["purl"], `${path}.package.purl`);
  return {
    package: { ecosystem: required(pkg["ecosystem"], `${path}.package.ecosystem`), name: required(pkg["name"], `${path}.package.name`), ...(purl === undefined ? {} : { purl }) },
    ...common,
  };
}

/** This function reads one pair of a type and a value: a severity or a reference. */
function pairsOf<K extends string>(value: unknown, path: string, field: K): readonly ({ readonly type: string } & Readonly<Record<K, string>>)[] {
  return list(value, path).map((item, index) => {
    const at = `${path}[${String(index)}]`;
    if (!isRecord(item)) throw new SchemaError(at, "the entry must be an object");
    return { type: required(item["type"], `${at}.type`), [field]: required(item[field], `${at}.${field}`) } as { readonly type: string } & Readonly<Record<K, string>>;
  });
}

/** This function reads a record, and throws a `SchemaError` at the first break of the schema. */
function recordOf(value: unknown): OsvRecord {
  if (!isRecord(value)) throw new SchemaError("", "the record must be an object");
  const id = required(value["id"], "id");
  if (id.length > MAX_ID || !ID_PATTERN.test(id)) throw new SchemaError("id", `the id ${JSON.stringify(id.slice(0, MAX_ID))} is not an id of a database`);
  const modified = optionalTime(value["modified"], "modified");
  if (modified === undefined) throw new SchemaError("modified", "the field must be present");
  const summary = optionalText(value["summary"], "summary");
  const details = optionalText(value["details"], "details");
  const published = optionalTime(value["published"], "published");
  const withdrawn = optionalTime(value["withdrawn"], "withdrawn");
  const special = fieldOf(value, "database_specific");
  if (special !== undefined && special !== null && !isRecord(special)) throw new SchemaError("database_specific", "the field must be an object");
  return {
    id,
    aliases: texts(value["aliases"], "aliases"),
    ...(summary === undefined ? {} : { summary }),
    ...(details === undefined ? {} : { details }),
    affected: list(value["affected"], "affected").map((item, index) => affectedOf(item, `affected[${String(index)}]`)),
    modified,
    ...(published === undefined ? {} : { published }),
    ...(withdrawn === undefined ? {} : { withdrawn }),
    severity: pairsOf(value["severity"], "severity", "score"),
    references: pairsOf(value["references"], "references", "url"),
    ...(isRecord(special) ? { databaseSpecific: special } : {}),
  };
}

/** This function reads one record of the OSV format from a parsed JSON value. The function does not throw. */
export function readOsv(value: unknown): OsvRead {
  try {
    return { ok: true, record: recordOf(value) };
  } catch (error) {
    if (error instanceof SchemaError) return { ok: false, path: error.path, message: error.message };
    throw error;
  }
}

/** This function reads one record of the OSV format from the text of a JSON document. The function does not throw. */
export function readOsvText(text: string): OsvRead {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, path: "", message: "the document is not JSON" };
  }
  return readOsv(value);
}

/** This function tells if a record is withdrawn at a time: its `withdrawn` time is at or before that time. */
export function isWithdrawn(record: OsvRecord, at: number): boolean {
  return record.withdrawn !== undefined && record.withdrawn <= at;
}

/** This function gives the CWE ids of a record: the ids of `database_specific` of the record and of each package, each one time. */
export function cwesOf(record: OsvRecord): readonly string[] {
  const found = new Set<string>();
  const add = (value: unknown): void => {
    const text = readText(value);
    if (text !== undefined && /^CWE-[0-9]+$/.test(text)) found.add(text);
  };
  for (const id of arrayOf(record.databaseSpecific, "cwe_ids", readText) ?? []) add(id);
  for (const affected of record.affected) {
    for (const cwe of arrayOf(affected.databaseSpecific, "cwes", (item) => (isRecord(item) ? item : undefined)) ?? []) add(cwe["cweId"]);
  }
  return [...found];
}
