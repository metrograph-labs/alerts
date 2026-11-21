/**
 * The map function of the NWS API source: one observation (one alert of the API, a GeoJSON
 * feature) to reports in the one format of the system. The function is pure and total.
 */

import type {
  Area,
  Category,
  CorrelationKey,
  MapProblem,
  MapResult,
  Observation,
  Operation,
  Position,
  RegionCode,
  Report,
  ResponseType,
  Severity,
  SourceId,
  Status,
  Urgency,
} from "@mark1russell7/alerts";
import { capMessageKey, categoryOf, Problems, reportId } from "@mark1russell7/alerts";
import { isRecord, type Fields } from "@mark1russell7/optional/read";
import { errorMessage } from "@mark1russell7/text";

import {
  CAP_CATEGORIES,
  CAP_NOT_ALERTS,
  CAP_OPERATIONS,
  CAP_RESPONSES,
  CAP_SEVERITY,
  CAP_STATUS,
  CAP_URGENCY,
  capCertainty,
  capTime,
  capValue,
} from "@mark1russell7/alerts-format-cap";
import { hasVtec, isSameCode, isUgcCode, NWS_API_SOURCE, NWS_ORIGIN, parseVtec, resolveKind, ugcRegionCodes, vtecKey, type Vtec } from "@mark1russell7/alerts-format-nws";

/** The id of this source. */
export const SOURCE_ID: SourceId = NWS_API_SOURCE;

/** The fields of the properties of an NWS alert that the map function knows. A different field is a note. */
export const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  "@id",
  "@type",
  "id",
  "areaDesc",
  "geocode",
  "affectedZones",
  "references",
  "sent",
  "effective",
  "onset",
  "expires",
  "ends",
  "status",
  "messageType",
  "category",
  "severity",
  "certainty",
  "urgency",
  "event",
  "sender",
  "senderName",
  "headline",
  "description",
  "instruction",
  "response",
  "note",
  "parameters",
  "scope",
  "code",
  "language",
  "web",
  "eventCode",
  "replacedBy",
  "replacedAt",
]);

const textOf = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);
/** This function gives a list of the texts of a value: a text, or a list of texts. */
const textsOf = (value: unknown): string[] =>
  typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const typeOf = (value: unknown): string => (Array.isArray(value) ? "a list" : value === null ? "null" : `a ${typeof value}`);

/** This function reads a text field. An absent field, null and a blank text give `undefined`. Another value is a lossy problem. */
function textAt(value: unknown, path: string, problems: Problems): string | undefined {
  if (value !== undefined && value !== null && typeof value !== "string") problems.add(path, `the value is ${typeOf(value)}, not a text`);
  return textOf(value);
}

/** This function reads a text, or a list of texts. Each item that is not a text is a lossy problem. */
function textsAt(value: unknown, path: string, problems: Problems): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) {
    problems.add(path, `the value is ${typeOf(value)}, not a text or a list of texts`);
    return [];
  }
  const texts: string[] = [];
  value.forEach((item, index) => {
    if (typeof item === "string") texts.push(item);
    else problems.add(`${path}[${index}]`, `the item is ${typeOf(item)}, not a text`);
  });
  return texts;
}

/** This function reads an object field. An absent field and null give `undefined`. Another value is a lossy problem. */
function objectAt(value: unknown, path: string, problems: Problems): Fields | undefined {
  if (isRecord(value)) return value;
  if (value !== undefined && value !== null) problems.add(path, `the value is ${typeOf(value)}, not an object`);
  return undefined;
}

const isPosition = (value: unknown): value is [number, number] =>
  Array.isArray(value) &&
  value.length >= 2 &&
  typeof value[0] === "number" &&
  typeof value[1] === "number" &&
  Math.abs(value[0]) <= 180 &&
  Math.abs(value[1]) <= 90;

/**
 * This function reads the rings of one GeoJSON polygon. A ring that does not close is a note, and the
 * function closes it. A bad hole is a lossy problem, and the area does not have it. A bad outside ring
 * is a lossy problem, and the function gives no area.
 */
function polygonOf(rings: unknown, path: string, problems: Problems): Extract<Area, { readonly type: "polygon" }> | undefined {
  if (!Array.isArray(rings) || rings.length === 0) {
    problems.add(path, "the polygon has no rings");
    return undefined;
  }
  const good: Position[][] = [];
  for (const [index, ring] of rings.entries()) {
    if (!Array.isArray(ring) || ring.length < 3 || !ring.every(isPosition)) {
      problems.add(`${path}[${index}]`, "the ring has fewer than 3 positions, or a position that is not a longitude and a latitude");
      if (index === 0) return undefined;
      continue;
    }
    const positions: Position[] = ring.map(([lon, lat]) => [lon, lat] as const);
    const first = positions[0]!;
    const last = positions[positions.length - 1]!;
    if (first[0] !== last[0] || first[1] !== last[1]) {
      problems.add(`${path}[${index}]`, "the ring does not close: the map closes it", "note");
      positions.push(first);
    }
    good.push(positions);
  }
  return { type: "polygon", rings: good };
}

// The key of the one area block of an alert.
const BLOCK = "feature";

/**
 * This function reads the areas of an alert: its geometry and its region codes. A code of an unknown form
 * is a problem, and the function drops it, because it matches no watch. The alert is one area block with
 * the key `feature`: the geometry is the warned area, and the codes name the regions that it touches.
 *
 * A UGC zone code is a forecast zone (`ugc`) or a fire zone (`ugc-fire`). The list `affectedZones` names the kind of each
 * zone, for example `/zones/fire/TXZ205`, and decides first. For a code that the list does not name, the VTEC phenomena
 * decide (`ugcRegionCodes`, AL-33).
 */
function areasOf(feature: Fields, properties: Fields, phenomena: readonly string[], problems: Problems): Area[] {
  const areas: Area[] = [];
  const geometry = feature["geometry"];
  if (isRecord(geometry)) {
    const type = geometry["type"];
    if (type === "Polygon") {
      const polygon = polygonOf(geometry["coordinates"], "geometry.coordinates", problems);
      if (polygon !== undefined) areas.push({ ...polygon, block: BLOCK });
    } else if (type === "MultiPolygon" && Array.isArray(geometry["coordinates"])) {
      geometry["coordinates"].forEach((rings, index) => {
        const polygon = polygonOf(rings, `geometry.coordinates[${index}]`, problems);
        if (polygon !== undefined) areas.push({ ...polygon, block: BLOCK });
      });
    } else {
      problems.add("geometry.type", `the geometry ${JSON.stringify(type)} is not a Polygon or a MultiPolygon`);
    }
  } else if (geometry !== null && geometry !== undefined) {
    problems.add("geometry", "the geometry is not an object");
  }
  const geocode = properties["geocode"];
  if (!isRecord(geocode)) {
    problems.add("properties.geocode", geocode === undefined ? "the alert has no geocode" : "the geocode is not an object");
    return areas;
  }
  for (const field of Object.keys(geocode)) {
    if (!(field in REGION_CODES)) problems.add(`properties.geocode.${field}`, "the map function does not know this field", "note");
  }
  const kinds = zoneKindsOf(properties, problems);
  for (const [field, { system, normal, valid }] of Object.entries(REGION_CODES)) {
    const value = geocode[field];
    const items: readonly unknown[] | undefined = typeof value === "string" ? [value] : Array.isArray(value) ? value : undefined;
    if (items === undefined) {
      problems.add(`properties.geocode.${field}`, `the geocode has no ${field} list`);
      continue;
    }
    items.forEach((item, index) => {
      const code = typeof item === "string" ? normal(item) : undefined;
      if (code === undefined || !valid(code)) problems.add(`properties.geocode.${field}[${index}]`, `the value ${JSON.stringify(item)} is not a ${field} code`);
      else for (const one of system === "ugc" ? ugcCodesOf(code, kinds, phenomena) : [{ system, code }]) areas.push({ type: "code", ...one, block: BLOCK });
    });
  }
  return areas;
}

// The URL of a zone in `affectedZones`: `https://api.weather.gov/zones/<kind>/<code>`.
const ZONE_URL = /\/zones\/([a-z]+)\/([A-Za-z]{2}[CZcz]\d{3})$/;

/**
 * This function gives the kinds of the zones of the list `affectedZones`, by their UGC codes. The kind is `forecast`,
 * `fire`, `county` or another kind of the NWS API. A URL of another form names no kind.
 */
function zoneKindsOf(properties: Fields, problems: Problems): ReadonlyMap<string, ReadonlySet<string>> {
  const kinds = new Map<string, Set<string>>();
  for (const url of textsAt(properties["affectedZones"], "properties.affectedZones", problems)) {
    const match = ZONE_URL.exec(url.trim());
    if (match === null) continue;
    const [, kind = "", code = ""] = match;
    const key = code.toUpperCase();
    kinds.set(key, (kinds.get(key) ?? new Set()).add(kind));
  }
  return kinds;
}

/**
 * This function gives the region codes of a UGC code of an alert. The kinds of `affectedZones` decide first: `fire` gives
 * `ugc-fire`, and each other kind gives `ugc`. A code that the list does not name uses the VTEC phenomena.
 */
function ugcCodesOf(code: string, kinds: ReadonlyMap<string, ReadonlySet<string>>, phenomena: readonly string[]): RegionCode[] {
  const named = kinds.get(code);
  if (named === undefined) return ugcRegionCodes(code, phenomena);
  const fire = named.has("fire");
  const other = [...named].some((kind) => kind !== "fire");
  return [...(other ? [{ system: "ugc", code }] : []), ...(fire ? [{ system: "ugc-fire", code }] : [])];
}

/** The region code lists of the geocode of an NWS alert, with the system, the normal form and the check of each code. */
const REGION_CODES: Readonly<Record<string, { system: string; normal: (text: string) => string; valid: (code: string) => boolean }>> = {
  UGC: { system: "ugc", normal: (text) => text.trim().toUpperCase(), valid: isUgcCode },
  SAME: { system: "same", normal: (text) => text.trim(), valid: isSameCode },
};

/**
 * This function reads the CAP references: the current list and the expired list of the NWS. A reference
 * with no identifier is a lossy problem, because the core cannot link the report to it.
 */
function referencesOf(properties: Fields, key: string, parameters: Fields | undefined, problems: Problems): string[] {
  const keys = new Set<string>();
  const references = properties["references"];
  if (Array.isArray(references)) {
    references.forEach((reference, index) => {
      const identifier = isRecord(reference) ? textOf(reference["identifier"]) : undefined;
      if (identifier === undefined) problems.add(`properties.references[${index}]`, "the reference has no identifier");
      else keys.add(identifier);
    });
  } else if (references !== undefined && references !== null) {
    problems.add("properties.references", `the value is ${typeOf(references)}, not a list`);
  }
  // Each expired reference is "sender,identifier,sent", and the references are separated by spaces
  for (const text of textsAt(parameters?.["expiredReferences"], "properties.parameters.expiredReferences", problems)) {
    for (const reference of text.trim().split(/\s+/)) {
      if (reference === "") continue;
      const identifier = reference.split(",")[1];
      if (identifier !== undefined && identifier !== "") keys.add(identifier);
      else problems.add("properties.parameters.expiredReferences", `the reference ${JSON.stringify(reference)} is not "sender,identifier,sent"`);
    }
  }
  keys.delete(key);
  return [...keys];
}

/**
 * This function gives the name and value pairs of the message that the report does not hold in a field of
 * its own. A parameter keeps each value as a text. An event code or a field that is not a text is a lossy problem.
 *
 * The NWS API adds `replacedBy` and `replacedAt` to a message after a later message replaces it. The core ends the
 * message from the later message itself, so the two fields stay parameters.
 */
function parametersOf(properties: Fields, parameters: Fields | undefined, eventCode: Fields | undefined, problems: Problems): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(parameters ?? {})) {
    if (name === "expiredReferences") continue;
    result[name] = Array.isArray(value) ? value.map((item) => (typeof item === "string" ? item : JSON.stringify(item))) : [typeof value === "string" ? value : JSON.stringify(value)];
  }
  for (const [name, value] of Object.entries(eventCode ?? {})) result[`eventCode.${name}`] = textsAt(value, `properties.eventCode.${name}`, problems);
  for (const name of ["note", "scope", "code", "language", "@id", "replacedBy", "replacedAt"]) {
    const value = textAt(properties[name], `properties.${name}`, problems);
    if (value !== undefined) result[name] = [value];
  }
  return result;
}

/** The fields of an object that have a value. A field with the value `undefined` is not in the result. */
type Present<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/** This function removes the fields with the value `undefined` from an object. */
function withoutAbsent<T extends object>(value: T): Present<T> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as Present<T>;
}

/**
 * This function maps one alert (a GeoJSON feature) to a report, or to no report and its problems. A
 * value that the report lacks, or holds as a fallback, is a lossy problem, so the health shows the loss.
 */
function mapFeature(feature: unknown, observation: Observation, problems: Problems): Report | undefined {
  if (!isRecord(feature) || feature["type"] !== "Feature") {
    problems.add("", "the message is not a GeoJSON feature", "fatal");
    return undefined;
  }
  const properties = feature["properties"];
  if (!isRecord(properties)) {
    problems.add("properties", "the feature has no properties", "fatal");
    return undefined;
  }
  for (const field of Object.keys(properties)) {
    if (!KNOWN_FIELDS.has(field)) problems.add(`properties.${field}`, "the map function does not know this field", "note");
  }
  const key = textOf(properties["id"]);
  if (key === undefined) {
    problems.add("properties.id", "the alert has no identifier", "fatal");
    return undefined;
  }
  const sent = capTime(properties["sent"], "properties.sent", problems);
  if (sent === undefined) {
    problems.add("properties.sent", "the alert has no valid sent time", "fatal");
    return undefined;
  }
  const messageType = typeof properties["messageType"] === "string" ? properties["messageType"].trim().toLowerCase() : undefined;
  if (messageType !== undefined && CAP_NOT_ALERTS.has(messageType)) return undefined;

  const parameters = objectAt(properties["parameters"], "properties.parameters", problems);
  const eventCode = objectAt(properties["eventCode"], "properties.eventCode", problems);
  const vtecTexts = textsAt(parameters?.["VTEC"], "properties.parameters.VTEC", problems);
  const vtec: Vtec[] = [];
  for (const text of vtecTexts) {
    const parsed = parseVtec(text);
    if (parsed === undefined) problems.add("properties.parameters.VTEC", `the text ${JSON.stringify(text)} is not a P-VTEC string`);
    else vtec.push(parsed);
  }
  const nwsCode = textsOf(eventCode?.["NationalWeatherService"])[0];
  const sameCode = textsOf(eventCode?.["SAME"])[0];
  // An NWS alert of a VTEC event carries its P-VTEC string. With no string, the core cannot follow the event.
  if (vtecTexts.length === 0 && nwsCode !== undefined && hasVtec(nwsCode)) {
    problems.add("properties.parameters.VTEC", `the alert has no P-VTEC string, and the event ${JSON.stringify(nwsCode)} has one`);
  }
  const name = textAt(properties["event"], "properties.event", problems);
  // CAP requires the event name. With no name, the label of the report is the label of the kind
  if (name === undefined && (typeof properties["event"] === "string" || properties["event"] === undefined || properties["event"] === null)) {
    problems.add("properties.event", "the alert has no event name");
  }
  const resolved = resolveKind({
    vtec,
    ...(nwsCode === undefined ? {} : { nwsCode }),
    ...(sameCode === undefined ? {} : { sameCode }),
    ...(name === undefined ? {} : { name }),
  });
  if (!resolved.known) problems.add("properties.event", `the kind tables do not know the event ${JSON.stringify(name ?? nwsCode ?? sameCode)}`);

  const categories = textsAt(properties["category"], "properties.category", problems)
    .map((category) => category.trim().toLowerCase())
    .filter((category) => {
      if (CAP_CATEGORIES.has(category)) return true;
      problems.add("properties.category", `the category ${JSON.stringify(category)} is not a CAP category`);
      return false;
    }) as Category[];
  if (categories.length === 0) {
    const fallback = categoryOf(resolved.kind.code);
    problems.add("properties.category", `the alert has no CAP category: the map uses ${fallback}`);
    categories.push(fallback);
  }

  const response = textsAt(properties["response"], "properties.response", problems)
    .map((value) => value.trim().toLowerCase())
    .filter((value) => {
      if (CAP_RESPONSES.has(value)) return true;
      problems.add("properties.response", `the response ${JSON.stringify(value)} is not a CAP response`);
      return false;
    }) as ResponseType[];

  const correlation = new Map<string, CorrelationKey>();
  for (const one of vtec) {
    if (one.productClass !== "O") continue;
    const correlationKey = vtecKey(one, sent);
    correlation.set(correlationKey.id, correlationKey);
  }

  // A field with no value is absent from the report, so two copies of one report are equal
  const optional = withoutAbsent({
    effective: capTime(properties["effective"], "properties.effective", problems),
    onset: capTime(properties["onset"], "properties.onset", problems),
    expires: capTime(properties["expires"], "properties.expires", problems),
    ends: capTime(properties["ends"], "properties.ends", problems),
    areaText: textAt(properties["areaDesc"], "properties.areaDesc", problems),
    description: textAt(properties["description"], "properties.description", problems),
    instruction: textAt(properties["instruction"], "properties.instruction", problems),
    web: textAt(properties["web"], "properties.web", problems),
  });
  // The NWS gives an expiry time for each alert. With no expiry time, the incident does not end at a time.
  if (properties["expires"] === undefined || properties["expires"] === null) problems.add("properties.expires", "the alert has no expiry time");
  // Each NWS alert has region codes. Only a code matches a watch until the core can match shapes, so an
  // alert with no valid code reaches nobody. A changed format gives this case, and health must show it.
  const areas = areasOf(feature, properties, vtec.map((one) => one.phenomenon), problems);
  if (!areas.some((area) => area.type === "code")) {
    problems.add("properties.geocode", "the alert has no valid region code: no watch can match it", "fatal");
    return undefined;
  }
  const senderName = textAt(properties["senderName"], "properties.senderName", problems);
  const sender = textAt(properties["sender"], "properties.sender", problems);
  // The key of the CAP message joins the copy of NWWS-OI or of another CAP source, also with no VTEC (AL-8).
  const messageKey = sender === undefined ? undefined : capMessageKey({ sender, identifier: key, sent });
  if (messageKey !== undefined) correlation.set(messageKey.id, messageKey);
  const headline = textAt(properties["headline"], "properties.headline", problems);
  const report: Report = {
    id: reportId({ source: SOURCE_ID, key, sent }),
    source: SOURCE_ID,
    origin: NWS_ORIGIN,
    key,
    references: referencesOf(properties, key, parameters, problems),
    correlation: [...correlation.values()],
    status: capValue<Status>(properties["status"], CAP_STATUS, "actual", "properties.status", problems),
    op: capValue<Operation>(properties["messageType"], CAP_OPERATIONS, "alert", "properties.messageType", problems),
    kind: resolved.kind,
    categories,
    severity: capValue<Severity>(properties["severity"], CAP_SEVERITY, "unknown", "properties.severity", problems),
    urgency: capValue<Urgency>(properties["urgency"], CAP_URGENCY, "unknown", "properties.urgency", problems),
    certainty: capCertainty(properties["certainty"], "properties.certainty", problems),
    response,
    sent,
    received: observation.fetched,
    areas,
    about: [],
    sender: senderName ?? sender ?? "NWS",
    // The parameters keep the NWS headline as a text, so the headline loses no value when it uses it
    headline: headline ?? textsOf(parameters?.["NWSheadline"])[0] ?? name ?? key,
    observation: observation.id,
    parameters: parametersOf(properties, parameters, eventCode, problems),
    ...optional,
  };
  return report;
}

/** This function maps one observation, and can throw. `mapObservation` catches each error. */
function mapOrThrow(observation: Observation): MapResult {
  let body: unknown;
  try {
    body = JSON.parse(observation.body);
  } catch {
    return { reports: [], problems: [{ path: "", message: "the body is not JSON", fatal: true }] };
  }
  const features = isRecord(body) && body["type"] === "FeatureCollection" && Array.isArray(body["features"]) ? body["features"] : undefined;
  const messages: { readonly feature: unknown; readonly path: string }[] =
    features === undefined ? [{ feature: body, path: "" }] : features.map((feature, index) => ({ feature, path: `features[${index}]` }));
  const reports: Report[] = [];
  const problems: MapProblem[] = [];
  for (const message of messages) {
    const own = new Problems(message.path);
    const report = mapFeature(message.feature, observation, own);
    if (report !== undefined) reports.push(report);
    problems.push(...own.list);
  }
  return { reports, problems };
}

/**
 * This function maps one observation of the NWS API to reports. The body is one alert (a GeoJSON
 * feature) or a list of alerts (a feature collection). The function does not throw: an error is a fatal problem.
 */
export function mapObservation(observation: Observation): MapResult {
  try {
    return mapOrThrow(observation);
  } catch (error) {
    return { reports: [], problems: [{ path: "", message: `the map function failed: ${errorMessage(error)}`, fatal: true }] };
  }
}
