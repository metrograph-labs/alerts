/**
 * The map of one CAP message to reports in the one format of the system. This module is the one home of the map.
 * FEMA IPAWS and the tsunami warning centers of the NWS send CAP messages with VTEC, UGC and SAME codes. The other
 * alerting authorities send event codes of the OASIS list or the awareness types of MeteoAlarm.
 *
 * The map gives one report for each info block in the chosen language. A tsunami center puts a warning, an advisory
 * and a watch in three blocks of one message, each with its own areas. The reports of one message have the key of
 * the message, so a later reference to the message ends each of them. The merge puts them in one incident, with one
 * line for each block. When the language has two or more blocks, the path of each block is the part of its id.
 */

import {
  capMessageKey,
  categoryOf,
  reportId,
  type Area,
  type Category,
  type CorrelationKey,
  type Instant,
  type Kind,
  type Observation,
  type Operation,
  type ProblemSink,
  type Report,
  type ResponseType,
  type Severity,
  type SourceId,
  type Status,
  type Urgency,
} from "@mark1russell7/alerts";
import { parseVtec, resolveKind, ugcRegionCodes, vtecKey, type ResolvedKind, type Vtec } from "@mark1russell7/alerts-format-nws";

import { capCircle, capPolygon } from "./geometry.ts";
import { chooseInfo } from "./info.ts";
import { codedKind, type CodedKind } from "./kinds.ts";
import type { CapAlert, CapInfo, CapPair } from "./read.ts";
import { CAP_CATEGORIES, CAP_NOT_ALERTS, CAP_OPERATIONS, CAP_RESPONSES, CAP_SEVERITY, CAP_STATUS, CAP_URGENCY, capCertainty, capTime, capValue } from "./values.ts";

/** The names of the event codes of the NWS. IPAWS gives `NationalWeatherService`, and the NWS API also gives `NWS`. */
const NWS_CODE_NAMES: readonly string[] = ["NationalWeatherService", "NWS"];

/** The names of the geocodes that the map knows, and the system of the region code of each. */
const GEOCODES: Readonly<Record<string, string>> = { UGC: "ugc", SAME: "same" };

/** The options of the map of one CAP message. */
export interface CapReportOptions {
  /** The source of the reports. */
  readonly source: SourceId;
  /** The authority of the message, for example the NWS. The source finds it from the sender. */
  readonly origin: string;
  /**
   * The rule of the areas. With `true`, the shapes of an area element decide for it, and each area has the path of
   * its element as its key. With `false`, the area of an element is the union of its parts, as CAP tells.
   */
  readonly keyed: boolean;
  /** The languages in the order of choice. The reports have the info blocks of the first language that the message has. */
  readonly languages: readonly string[];
}

/** The fields of a message that each of its reports has. */
interface Message {
  readonly key: string;
  readonly sent: Instant;
  readonly status: Status;
  readonly op: Operation;
  readonly references: readonly string[];
}

/** One info block of a message, with its index in the message. */
interface Block {
  readonly info: CapInfo;
  readonly index: number;
}

/** This function gives the values of each pair with the name, in order. The case of the name is significant. */
const valuesOf = (pairs: readonly CapPair[], name: string): string[] => pairs.filter((pair) => pair.valueName === name).map((pair) => pair.value);

/** This function gives the name and value pairs as lists of values by name, in the order of the message. */
function grouped(pairs: readonly CapPair[], prefix = ""): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const pair of pairs) (result[`${prefix}${pair.valueName}`] ??= []).push(pair.value);
  return result;
}

/**
 * This function reads the areas of one info block: the polygons, the circles and the geocodes.
 *
 * With keyed areas, the key of each area is the path of its CAP `area` element, for example `info[0].area[1]`.
 * Then the shapes of an element decide for it. The NWS writes the warned area as the polygon, and the codes name each
 * region that the polygon touches. Another sender can mean the union of the parts, so its areas get no key.
 *
 * A UGC zone code of an alert with the VTEC phenomenon `FW` is a fire zone (`ugc-fire`, AL-33). `ugcRegionCodes` decides
 * from the phenomena. A UGC value of an unknown form stays a `ugc` code, as before.
 */
function areasOf({ info, index }: Block, keyed: boolean, phenomena: readonly string[], problems: ProblemSink): Area[] {
  const areas: Area[] = [];
  const codes = new Set<string>();
  info.areas.forEach((area, at) => {
    const path = `info[${String(index)}].area[${String(at)}]`;
    const block = keyed ? { block: path } : {};
    area.polygons.forEach((text, one) => {
      const polygon = capPolygon(text, `${path}.polygon[${String(one)}]`, problems);
      if (polygon !== undefined) areas.push({ ...polygon, ...block });
    });
    area.circles.forEach((text, one) => {
      const circle = capCircle(text, `${path}.circle[${String(one)}]`, problems);
      if (circle !== undefined) areas.push({ ...circle, ...block });
    });
    for (const geocode of area.geocodes) {
      const system = GEOCODES[geocode.valueName];
      if (system === undefined) {
        problems.add(`${path}.geocode`, `the map function does not know the geocode ${JSON.stringify(geocode.valueName)}`);
        continue;
      }
      const code = system === "ugc" ? geocode.value.trim().toUpperCase() : geocode.value.trim();
      if (code === "") continue;
      const systems = system === "ugc" ? ugcSystems(code, phenomena) : [system];
      for (const one of systems) {
        // Two area elements can name one region. The report has it one time in each element, or one time with no key.
        const once = keyed ? `${path} ${one}:${code}` : `${one}:${code}`;
        if (codes.has(once)) continue;
        codes.add(once);
        areas.push({ type: "code", system: one, code, ...block });
      }
    }
  });
  return areas;
}

// The region systems of a UGC value: `ugc`, `ugc-fire` or the two. A value of an unknown form stays `ugc`.
function ugcSystems(code: string, phenomena: readonly string[]): string[] {
  const codes = ugcRegionCodes(code, phenomena);
  return codes.length === 0 ? ["ugc"] : codes.map((one) => one.system);
}

/**
 * This function gives the name and value pairs that the report does not hold in a field of its own.
 * These are the parameters, the event codes and some elements of the message.
 */
function parametersOf(alert: CapAlert, info: CapInfo | undefined): Record<string, string[]> {
  const result: Record<string, string[]> = info === undefined ? {} : { ...grouped(info.parameters), ...grouped(info.eventCodes, "eventCode.") };
  const single = { note: alert.note, scope: alert.scope, source: alert.source, restriction: alert.restriction, language: info?.language, audience: info?.audience, contact: info?.contact };
  for (const [name, value] of Object.entries(single)) if (value !== undefined && value.trim() !== "") result[name] = [value];
  if (alert.codes.length > 0) result["code"] = [...alert.codes];
  if (alert.incidents.length > 0) result["incidents"] = [...alert.incidents];
  return result;
}

/** The fields of an object that have a value. A field with the value `undefined` is not in the result. */
type Present<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/** This function removes the fields with the value `undefined` from an object. */
function withoutAbsent<T extends object>(value: T): Present<T> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as Present<T>;
}

/** This function reads the values of a CAP list that the core knows, in lower case. A different value is a problem. */
function knownValues<T extends string>(values: readonly string[], allowed: ReadonlySet<string>, path: string, what: string, problems: ProblemSink): T[] {
  const known: T[] = [];
  for (const value of values) {
    const text = value.trim().toLowerCase();
    if (allowed.has(text)) known.push(text as T);
    else problems.add(path, `the ${what} ${JSON.stringify(value)} is not a CAP ${what}`);
  }
  return known;
}

/**
 * This function chooses the kind of one info block. The first choice is an event code of the OASIS list or an awareness
 * type of MeteoAlarm. The next choices are the NWS tables, then the first CAP category of the block. A category of `other` gives the unknown
 * kind of the NWS tables. The label is the event of the block, when the block has one.
 */
function kindOf(coded: CodedKind | undefined, resolved: ResolvedKind, categories: readonly Category[], name: string | undefined): Kind {
  const label = name ?? resolved.kind.label;
  if (coded !== undefined) return { code: coded.code, label };
  if (resolved.known) return resolved.kind;
  const category = categories.find((one) => one !== "other");
  return category === undefined ? resolved.kind : { code: category, label };
}

/**
 * This function maps one info block to a report. With no block, the report has no kind and no area. The part names
 * the block in the id of the report when the message has two or more blocks in the language.
 */
function blockReport(alert: CapAlert, message: Message, block: Block | undefined, part: string | undefined, observation: Observation, options: CapReportOptions, problems: ProblemSink): Report {
  const info = block?.info;
  const at = block === undefined ? "info" : `info[${String(block.index)}]`;
  const parameters = info?.parameters ?? [];

  const vtec: Vtec[] = [];
  for (const text of valuesOf(parameters, "VTEC")) {
    const parsed = parseVtec(text);
    if (parsed === undefined) problems.add(`${at}.parameter.VTEC`, `the text ${JSON.stringify(text)} is not a P-VTEC string`);
    else vtec.push(parsed);
  }
  const eventCodes = info?.eventCodes ?? [];
  const nwsCode = NWS_CODE_NAMES.map((name) => valuesOf(eventCodes, name)[0]).find((value) => value !== undefined);
  const sameCode = valuesOf(eventCodes, "SAME")[0];
  const name = info?.event.trim() === "" ? undefined : info?.event.trim();
  const coded = info === undefined ? undefined : codedKind(info);
  for (const code of coded?.unknown ?? []) problems.add(`${at}.eventCode`, `the kind tables do not know the event code ${JSON.stringify(code)}`);
  const resolved = resolveKind({
    vtec,
    ...(nwsCode === undefined ? {} : { nwsCode }),
    ...(sameCode === undefined ? {} : { sameCode }),
    ...(name === undefined ? {} : { name }),
  });
  const categories = knownValues<Category>(info?.categories ?? [], CAP_CATEGORIES, `${at}.category`, "category", problems);
  const kind = kindOf(coded?.kind, resolved, categories, name);
  if (coded?.kind === undefined && !resolved.known && info !== undefined) {
    const event = JSON.stringify(name ?? nwsCode ?? sameCode);
    const fallback = kind.code === resolved.kind.code ? "" : `: the report has the kind of its category, ${kind.code}`;
    problems.add(`${at}.event`, `the kind tables do not know the event ${event}${fallback}`);
  }
  if (categories.length === 0) categories.push(categoryOf(kind.code));
  const response = knownValues<ResponseType>(info?.responseTypes ?? [], CAP_RESPONSES, `${at}.responseType`, "response", problems);

  // Only an operational VTEC (class O) names an event of the NWS. A test or an experiment does not join an incident.
  const correlation = new Map<string, CorrelationKey>();
  for (const one of vtec) {
    if (one.productClass !== "O") continue;
    const correlationKey = vtecKey(one, message.sent);
    correlation.set(correlationKey.id, correlationKey);
  }
  // The key of the message joins its copies from other sources, also with no VTEC (AL-8).
  const messageKey = capMessageKey({ sender: alert.sender, identifier: message.key, sent: message.sent, part });
  if (messageKey !== undefined) correlation.set(messageKey.id, messageKey);

  const areaText = [...new Set((info?.areas ?? []).map((area) => area.areaDesc.trim()).filter((text) => text !== ""))].join("; ");
  const expires = capTime(info?.expires, `${at}.expires`, problems);
  // A center of the NWS sent an information statement that expires before its sent time. The report keeps the value.
  if (expires !== undefined && expires < message.sent) problems.add(`${at}.expires`, "the expires time is before the sent time, so the report is not live", "note");

  // A field with no value is absent from the report, so two copies of one report are equal
  const optional = withoutAbsent({
    effective: capTime(info?.effective, `${at}.effective`, problems),
    onset: capTime(info?.onset, `${at}.onset`, problems),
    expires,
    ends: capTime(valuesOf(parameters, "eventEndingTime")[0], `${at}.parameter.eventEndingTime`, problems),
    areaText: areaText === "" ? undefined : areaText,
    description: info?.description,
    instruction: info?.instruction,
    web: info?.web,
  });
  return {
    id: reportId({ source: options.source, key: message.key, sent: message.sent, part }),
    source: options.source,
    origin: options.origin,
    key: message.key,
    references: [...message.references],
    correlation: [...correlation.values()],
    status: message.status,
    op: message.op,
    kind,
    categories,
    // The problem at `info` tells of a message with no info block, so its absent values give no more problems.
    severity: info === undefined ? "unknown" : capValue<Severity>(info.severity, CAP_SEVERITY, "unknown", `${at}.severity`, problems),
    urgency: info === undefined ? "unknown" : capValue<Urgency>(info.urgency, CAP_URGENCY, "unknown", `${at}.urgency`, problems),
    certainty: info === undefined ? "unknown" : capCertainty(info.certainty, `${at}.certainty`, problems),
    response,
    sent: message.sent,
    received: observation.fetched,
    areas: block === undefined ? [] : areasOf(block, options.keyed, vtec.map((one) => one.phenomenon), problems),
    about: [],
    sender: info?.senderName?.trim() || alert.sender,
    headline: info?.headline?.trim() || valuesOf(parameters, "NWSheadline")[0] || name || message.key,
    observation: observation.id,
    parameters: parametersOf(alert, info),
    ...optional,
  };
}

/**
 * This function maps one CAP message to its reports: one report for each info block in the chosen language.
 *
 * - An acknowledgment or an error gives no report.
 * - A message with no identifier or no valid sent time gives no report and a fatal problem.
 * - A message with a scope other than `Public` gives no report and a note. The note does not change the health of the source.
 * - A message with no info block gives one report with no kind and no area, and a lossy problem.
 * - A value of the message that a report does not hold is a lossy problem.
 */
export function capReports(alert: CapAlert, observation: Observation, options: CapReportOptions, problems: ProblemSink): Report[] {
  const key = alert.identifier.trim();
  if (key === "") {
    problems.add("identifier", "the alert has no identifier", "fatal");
    return [];
  }
  const sent = capTime(alert.sent, "sent", problems);
  if (sent === undefined) {
    problems.add("sent", "the alert has no valid sent time", "fatal");
    return [];
  }
  const messageType = alert.msgType.trim().toLowerCase();
  if (CAP_NOT_ALERTS.has(messageType)) return [];
  // The addresses of a CAP message name no person of the configuration. A public report of a private or restricted
  // message would reach each person, so the map function maps only the scope Public (AL-92). The skip is a note, not a
  // fatal problem: the message is good, and the health of the source stays as it is.
  const scope = alert.scope.trim();
  if (scope.toLowerCase() !== "public") {
    problems.add("scope", `the alert has the scope ${JSON.stringify(scope)}, and the map function maps only the scope Public`, "note");
    return [];
  }

  const references = new Set(alert.references.map((reference) => reference.identifier.trim()).filter((identifier) => identifier !== ""));
  references.delete(key);
  const message: Message = {
    key,
    sent,
    status: capValue<Status>(alert.status, CAP_STATUS, "actual", "status", problems),
    op: capValue<Operation>(messageType, CAP_OPERATIONS, "alert", "msgType", problems),
    references: [...references],
  };
  const chosen = chooseInfo(alert.infos, options.languages);
  if (chosen === undefined) {
    problems.add("info", "the message has no info block: the report has no kind and no area");
    return [blockReport(alert, message, undefined, undefined, observation, options, problems)];
  }
  const language = chosen.info.language.toLowerCase();
  const blocks = alert.infos.flatMap((info, index): Block[] => (info.language.toLowerCase() === language ? [{ info, index }] : []));
  return blocks.map((block) => blockReport(alert, message, block, blocks.length > 1 ? `info[${String(block.index)}]` : undefined, observation, options, problems));
}
