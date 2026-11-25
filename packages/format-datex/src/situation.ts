/**
 * The reader of a DATEX II situation publication, version 3. DATEX II is the European standard (CEN/TS 16157) for the
 * exchange of road data. A situation publication holds situations, and each situation holds situation records: an
 * accident, a closure, a speed limit or roadworks. The reader names no publisher and no country.
 *
 * The reader keeps only the facts of each record that a count or a report needs. These facts are the class, the type,
 * the validity and the cause. It does not read the location of a record. The parser keeps each location as text, and the
 * reader does not read it.
 */

import { parseXml, xmlFault } from "@mark1russell7/alerts-format-cap";
import { isRecord } from "@mark1russell7/optional/read";
import { ENTITY_ACTION, EntityDecoder } from "@nodable/entities";
import { XMLParser } from "fast-xml-parser";

/** A time in milliseconds since the epoch. */
export type Time = number;

/**
 * The validity status of a record. With `definedByValidityTimeSpec`, the start and the end of the record tell its
 * validity. Version 2 of DATEX II names it `definedByValidityTimeSpecification`, and the reader gives the name of
 * version 3.
 */
export type ValidityStatus = "active" | "suspended" | "definedByValidityTimeSpec";

/** The validity statuses, in their order in a report. */
export const VALIDITY_STATUSES: readonly ValidityStatus[] = ["active", "suspended", "definedByValidityTimeSpec"];

/** The facts of one situation record. */
export interface SituationRecord {
  /** The id of the situation of the record. */
  readonly situation: string;
  readonly id: string;
  readonly version: string;
  /** The class of the record, with no prefix of its namespace, for example `VehicleObstruction`. */
  readonly type: string;
  /**
   * The value of the type field of the class, for example `carriagewayClosures` for the class
   * `RoadOrCarriagewayOrLaneManagement`. Absent: the record has no such field.
   */
  readonly kind?: string;
  readonly status: ValidityStatus;
  /** The time of the start of the validity. Absent: the record has no start. */
  readonly start?: Time;
  /** The time of the end of the validity. Absent: the end is not known. */
  readonly end?: Time;
  /** The probability of the record, for example `certain` or `riskOf`. */
  readonly probability?: string;
  /** The type of the cause of the record, for example `roadMaintenance`. */
  readonly cause?: string;
  /** The severity of the situation of the record, for example `low` or `highest`. */
  readonly severity?: string;
}

/** The facts of one situation publication. */
export interface SituationPublication {
  /** The time of the publication. */
  readonly published: Time;
  /** The country of the publisher, as the publication gives it, for example `nl`. */
  readonly country?: string;
  /** The national identifier of the publisher, for example `NDWNL`. */
  readonly creator?: string;
  /** The records of the situations whose information status is `real`. */
  readonly records: readonly SituationRecord[];
  /** The count of the situations with another information status, for example `test` or `exercise`. */
  readonly unreal: number;
  /** The faults of the records that the reader does not give. Each fault names the record. */
  readonly faults: readonly string[];
}

/** The result of `readSituationPublication`: the publication, or the reason of a text that is not one. */
export type SituationRead = { readonly ok: true; readonly publication: SituationPublication } | { readonly ok: false; readonly reason: string };

/** The elements that can occur more than one time. Each of them is a list after the parse, also with one item. */
const LISTS = new Set(["payload", "situation", "situationRecord"]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  // Each value stays a text: an id such as 0012 is not a number.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => LISTS.has(name),
  // The reader does not read the locations, the sources and the comments. The parser keeps each of them as one text.
  stopNodes: ["*.locationReference", "*.source", "*.generalPublicComment"],
  // The decoder blocks each entity of a DOCTYPE: a second guard, after the refusal of a DOCTYPE.
  entityDecoder: new EntityDecoder({
    numericAllowed: true,
    onInputEntity: () => ENTITY_ACTION.BLOCK,
    onExternalEntity: () => ENTITY_ACTION.BLOCK,
  }),
});

type XmlObject = { readonly [name: string]: unknown };

/** This function gives the text of a value, or `undefined` for a value that is not a text with characters. */
function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value === "" ? undefined : value;
  if (isRecord(value)) return textOf(value["#text"]);
  return undefined;
}

/** This function gives a name with no prefix of its namespace, for example `VehicleObstruction` for `sit:VehicleObstruction`. */
function localName(value: string): string {
  const colon = value.lastIndexOf(":");
  return colon < 0 ? value : value.slice(colon + 1);
}

/** The pattern of a time of DATEX II: a date and a time with a zone. The fraction of a second can have nine digits. */
const TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

/** This function gives the time of a DATEX II time text, or `undefined` for a text that is not a time. */
export function datexTime(value: unknown): Time | undefined {
  const text = textOf(value);
  const match = text === undefined ? null : TIME.exec(text);
  if (match === null) return undefined;
  // The reader keeps the milliseconds: a date of JavaScript has no finer unit.
  const fraction = (match[2] ?? "").slice(0, 3).padEnd(3, "0");
  const time = Date.parse(`${match[1]!}.${fraction}${match[3]!}`);
  return Number.isFinite(time) ? time : undefined;
}

/** This function gives the validity status of a text. The status of version 2 gives the status of version 3. */
function statusOf(value: unknown): ValidityStatus | undefined {
  const text = textOf(value);
  if (text === "definedByValidityTimeSpecification") return "definedByValidityTimeSpec";
  return VALIDITY_STATUSES.find((status) => status === text);
}

/** This function gives the name of the type field of a class, for example `vehicleObstructionType` for `VehicleObstruction`. */
function kindField(type: string): string {
  return `${type.charAt(0).toLowerCase()}${type.slice(1)}Type`;
}

/** This function reads one record, or gives the fault of a record that it cannot read. */
function readRecord(value: unknown, situation: string, severity: string | undefined): SituationRecord | string {
  if (!isRecord(value)) return `a record of the situation ${situation} is not an element`;
  const id = textOf(value["@id"]);
  const version = textOf(value["@version"]);
  const typed = textOf(value["@type"]);
  if (id === undefined || version === undefined || typed === undefined) return `a record of the situation ${situation} has no id, no version or no type`;
  const type = localName(typed);
  const validity = isRecord(value["validity"]) ? value["validity"] : undefined;
  const status = statusOf(validity?.["validityStatus"]);
  if (status === undefined) return `the record ${id} has no validity status`;
  const span = isRecord(validity?.["validityTimeSpecification"]) ? (validity["validityTimeSpecification"] as XmlObject) : undefined;
  const start = datexTime(span?.["overallStartTime"]);
  const end = datexTime(span?.["overallEndTime"]);
  if (span?.["overallStartTime"] !== undefined && start === undefined) return `the record ${id} has a start that is not a time`;
  if (span?.["overallEndTime"] !== undefined && end === undefined) return `the record ${id} has an end that is not a time`;
  const kinds = value[kindField(type)];
  const kind = textOf(Array.isArray(kinds) ? kinds[0] : kinds);
  const probability = textOf(value["probabilityOfOccurrence"]);
  const cause = isRecord(value["cause"]) ? textOf(value["cause"]["causeType"]) : undefined;
  return {
    situation,
    id,
    version,
    type,
    ...(kind === undefined ? {} : { kind }),
    status,
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
    ...(probability === undefined ? {} : { probability }),
    ...(cause === undefined ? {} : { cause }),
    ...(severity === undefined ? {} : { severity }),
  };
}

/** This function gives the situation publication of a document: a payload at the root or in a message container. */
function payloadOf(document: unknown): XmlObject | undefined {
  if (!isRecord(document)) return undefined;
  const container = isRecord(document["messageContainer"]) ? document["messageContainer"] : undefined;
  const payloads: unknown = container === undefined ? document["payload"] : container["payload"];
  if (!Array.isArray(payloads)) return undefined;
  const found: unknown = payloads.find((payload) => isRecord(payload) && localName(textOf(payload["@type"]) ?? "") === "SituationPublication");
  return isRecord(found) ? found : undefined;
}

/**
 * This function reads a DATEX II situation publication, version 3. It does not throw. A text with a DOCTYPE, a text that
 * is not well formed and a text with no situation publication give a reason. A record that the reader cannot read gives a
 * fault, and the other records stay.
 */
export function readSituationPublication(xml: string): SituationRead {
  if (xml.includes("<!DOCTYPE")) return { ok: false, reason: "the text has a DOCTYPE: a DATEX II publication has no DTD" };
  const fault = xmlFault(xml);
  if (fault !== undefined) return { ok: false, reason: fault };
  const parsed = parseXml(parser, xml);
  if (!parsed.ok) return { ok: false, reason: parsed.fault };
  const payload = payloadOf(parsed.document);
  if (payload === undefined) return { ok: false, reason: "the text has no situation publication of DATEX II version 3" };
  const published = datexTime(payload["publicationTime"]);
  if (published === undefined) return { ok: false, reason: "the publication has no time" };
  const creator = isRecord(payload["publicationCreator"]) ? payload["publicationCreator"] : undefined;
  const country = textOf(creator?.["country"]);
  const national = textOf(creator?.["nationalIdentifier"]);
  const records: SituationRecord[] = [];
  const faults: string[] = [];
  let unreal = 0;
  const situations: unknown = payload["situation"];
  for (const situation of Array.isArray(situations) ? situations : []) {
    const id = isRecord(situation) ? textOf(situation["@id"]) : undefined;
    if (!isRecord(situation) || id === undefined) {
      faults.push("a situation has no id");
      continue;
    }
    const header = isRecord(situation["headerInformation"]) ? situation["headerInformation"] : undefined;
    // A situation with no information status is real: the status is optional in version 3.
    const status = textOf(header?.["informationStatus"]) ?? "real";
    if (status !== "real") {
      unreal += 1;
      continue;
    }
    const severity = textOf(situation["overallSeverity"]);
    const items: unknown = situation["situationRecord"];
    for (const item of Array.isArray(items) ? items : []) {
      const record = readRecord(item, id, severity);
      if (typeof record === "string") faults.push(record);
      else records.push(record);
    }
  }
  return {
    ok: true,
    publication: { published, ...(country === undefined ? {} : { country }), ...(national === undefined ? {} : { creator: national }), records, unreal, faults },
  };
}

/**
 * This function tells if a record is valid at the time `at`. An `active` record is valid, and a `suspended` record is not.
 * A record of `definedByValidityTimeSpec` is valid from its start, and until its end when it has one.
 */
export function isValidAt(record: SituationRecord, at: Time): boolean {
  if (record.status === "active") return true;
  if (record.status === "suspended") return false;
  if (record.start !== undefined && at < record.start) return false;
  return record.end === undefined || at < record.end;
}

/**
 * The groups of the records, by the class of each record. A count of a group is a measure of the road events of an
 * area. A closure is a lane or road management record whose type is a closure.
 */
export type RecordGroup = "accident" | "congestion" | "obstruction" | "closure" | "works" | "conditions" | "other";

/** The groups, in their order in a report. */
export const RECORD_GROUPS: readonly RecordGroup[] = ["accident", "congestion", "obstruction", "closure", "works", "conditions", "other"];

/** This function gives the group of a record. The group is a function of the class and the type of the record. */
export function recordGroup(record: Pick<SituationRecord, "type" | "kind">): RecordGroup {
  const { type, kind } = record;
  if (type === "Accident") return "accident";
  if (type === "AbnormalTraffic") return "congestion";
  if (type.endsWith("Obstruction")) return "obstruction";
  if (type === "RoadOrCarriagewayOrLaneManagement" && kind !== undefined && /clos/i.test(kind)) return "closure";
  if (type === "MaintenanceWorks" || type === "ConstructionWorks" || type === "Roadworks") return "works";
  if (type.endsWith("Conditions")) return "conditions";
  return "other";
}
