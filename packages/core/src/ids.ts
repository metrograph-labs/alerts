/**
 * The id functions of the alert system. Each id is the SHA-256 of a content, in lowercase hex.
 * So each adapter and each copy of the system gives the same id to the same content, and a
 * duplicate changes nothing.
 *
 * The hash input is the canonical JSON of an array: the scheme, the kind of id, then the fields.
 * JSON escapes each string, so two different lists of fields do not give the same input. The kind
 * keeps the ids of two kinds apart. The hash comes from `@mark1russell7/rigor-generators`, the home
 * of content hashes. It is pure JavaScript, so the ids are synchronous in Node and in browsers.
 */
import { canonicalHash } from "@mark1russell7/rigor-generators";
import type { CorrelationKey, Instant, Level, ObservationId, PersonId, ReportId, SourceId } from "./contracts.ts";

/** The version of the id scheme. A change of the input of an id function raises it. */
export const ID_SCHEME = "alerts-id/1";

/** The input of `observationId`: the parts of an observation that tell its content. */
export interface ObservationIdInput {
  readonly source: SourceId;
  readonly contentType: string;
  readonly body: string;
  /**
   * The part of the URL of the request that the `map` function of the adapter reads. The `map` function
   * can read the URL, so it is part of the content. A part that `map` does not read, for example the time
   * of a poll, is not in it. Then a poll with no change gives the same id.
   */
  readonly url?: string;
}

/** The fields of each input of `reportId`: the source, the key that the source gives and the part. */
interface ReportIdFields {
  readonly source: SourceId;
  readonly key: string;
  /**
   * The part of a message that gives two or more reports, for example `info[1]`, the second info block of a CAP
   * message. The reports of one message keep its key, so a reference to the message ends each of them. A report
   * with no part keeps the id of a report of one part.
   */
  readonly part?: string | undefined;
}

/**
 * The input of `reportId`. A report gives its sent time, or a version when its source gives no time of its own.
 * The version is the id of the observation that holds the text of the report. Thus each copy and each start of the
 * runtime give one id to one text. A new text gets a new id with the same key.
 */
export type ReportIdInput = ReportIdFields & ({ readonly sent: Instant; readonly version?: undefined } | { readonly version: string; readonly sent?: undefined });

/** The input of `messageKey`: one step of the escalation of one level of one incident to one person. */
export interface MessageKeyInput {
  readonly incident: ReportId;
  readonly level: Level;
  readonly person: PersonId;
  /** The index of the step in the escalation of the person, from 0. */
  readonly step: number;
  /**
   * The count of the ends of the escalations of the person in the incident before this escalation (`EscalationEnd`).
   * When the threat comes back to the person after an end, the new escalation gets new keys.
   */
  readonly episode?: number | undefined;
}

/**
 * This function gives the id of an observation. A poll that gets the same body from the same
 * request gives the same id, so the log keeps the observation one time. The fetch time and the
 * other facts of the transport are not part of the id.
 */
export function observationId(input: ObservationIdInput): ObservationId {
  return digest(["observation", input.source, input.contentType, input.url ?? null, input.body]) as ObservationId;
}

/**
 * This function gives the id of a report. An update of the source has a new key, a new sent
 * time or a new version, so it gets a new id. The merge uses the smallest report id of an incident
 * as its anchor. A version is a text in the hash input, and a sent time is a number. Thus a version
 * and a sent time do not give the same id.
 */
export function reportId(input: ReportIdInput): ReportId {
  const fields = ["report", input.source, input.key, input.version ?? input.sent];
  return digest(input.part === undefined ? fields : [...fields, input.part]) as ReportId;
}

/** The system of the correlation key of one CAP message (`capMessageKey`). */
export const CAP_MESSAGE_SYSTEM = "cap";

/** The input of `capMessageKey`: the values that name one CAP message, as in the field `references` of CAP 1.2. */
export interface CapMessageKeyInput {
  readonly sender: string;
  readonly identifier: string;
  readonly sent: Instant;
  /**
   * The part of a message that gives two or more reports, for example `info[1]`. Each part gets its own key, because
   * two info blocks of one message can tell of two events.
   */
  readonly part?: string | undefined;
}

/**
 * This function gives the correlation key of one CAP message. Two sources that carry one message give it the same
 * sender, identifier and sent time. Thus the key joins the copies of a message in one incident, also with no VTEC
 * key. A special weather statement of the NWS is an example (AL-8).
 *
 * - The id is a hash, because the sender of a local authority can be the address of a person.
 * - The sent time is a number in the hash input. Thus two forms of one time give one key.
 * - An empty sender or identifier gives no key, because the two values do not name a message then.
 */
export function capMessageKey(input: CapMessageKeyInput): CorrelationKey | undefined {
  const sender = input.sender.trim();
  const identifier = input.identifier.trim();
  if (sender === "" || identifier === "") return undefined;
  const fields = ["cap-message", sender, identifier, input.sent];
  return { system: CAP_MESSAGE_SYSTEM, id: digest(input.part === undefined ? fields : [...fields, input.part]) };
}

/**
 * The characters of a copy id: letters, digits, `_` and `-`. A channel can put a copy id in the path
 * of a URL, thus a `.` or a `/` is not in it.
 */
export const COPY_ID: RegExp = /^[A-Za-z0-9_-]+$/;

/** The input of `digestKey`: one digest of one person at one time, on one step of the digest policy. */
export interface DigestKeyInput {
  readonly person: PersonId;
  /** The time of the digest: the instant of the daily time. */
  readonly at: Instant;
  /** The index of the step in the digest policy, from 0. */
  readonly step: number;
}

/** This function gives the key of a digest message. The same digest after a restart gets the same key. */
export function digestKey(input: DigestKeyInput): string {
  return digest(["digest", input.person, input.at, input.step]);
}

/**
 * This function gives the key of the delivery of one incident in a digest message. Each incident of a digest has its
 * own delivery, thus each copy of the system knows which incidents a digest told.
 */
export function digestEntryKey(key: string, incident: ReportId): string {
  return digest(["digest-entry", key, incident]);
}

/**
 * This function gives the key of a message. A channel that can drop a repeated key does so. A
 * repeat of the same step gets the same key, and the next step gets a new key.
 *
 * - An episode after the first one is in the key. Thus a new escalation after an end gets new keys.
 * - The key of the first episode has no episode field. Thus the keys of a log from before the episodes do not change.
 */
export function messageKey(input: MessageKeyInput): string {
  const episode = input.episode ?? 0;
  const fields = ["message", input.incident, input.level, input.person, input.step];
  return digest(episode === 0 ? fields : [...fields, episode]);
}

// The form "json" writes NaN and an infinite number as null, and escapes a lone surrogate. So the
// id functions do not throw, and `map` stays total.
function digest(fields: readonly (string | number | null)[]): string {
  return canonicalHash([ID_SCHEME, ...fields], { form: "json" });
}
