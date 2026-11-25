/**
 * The map function of the weather radio source. One observation is the text of one SAME header that the receiver
 * heard. The map gives one report of the header. The header has no severity, no urgency and no certainty, and no id
 * of a VTEC event. Thus the key of a report is the text of its header.
 */

import { categoryOf, Problems, reportId, UNKNOWN_KIND, type Area, type Kind, type MapResult, type Observation, type Report, type SourceId, type Status } from "@mark1russell7/alerts";
import { countyUgcOfSame, fromEventCode, NWS_ORIGIN, parseSameHeader, parseSameLocation, sameIssuedAt, stateOfSame, type SameHeader } from "@mark1russell7/alerts-format-nws";
import { errorMessage } from "@mark1russell7/text";

/** The id of this source. */
export const SOURCE_ID = "nwr" as SourceId;

/** The type of the body of an observation: the text of one header. */
export const CONTENT_TYPE = "text/plain";

/** The origin of each originator of a header. The NWS sends `WXR`. The other originators are other authorities. */
export const ORIGIN_OF: Readonly<Record<string, string>> = {
  WXR: NWS_ORIGIN,
  CIV: "same-civ",
  EAS: "same-eas",
  PEP: "same-pep",
};

/** The event codes of the tests. A demo (`DMO`) is an exercise. */
const TESTS = new Set(["RWT", "RMT", "NPT"]);

/** This function gives the status of a report of an event code. */
export function statusOf(event: string): Status {
  if (event === "DMO") return "exercise";
  return TESTS.has(event) ? "test" : "actual";
}

/**
 * This function gives the areas of the location codes of a header. A county also gives its county UGC code, and a
 * part of a county also gives its full county. A full state gives its state code. The code `000000` is the whole
 * United States.
 */
export function areasOf(locations: readonly string[]): Area[] {
  const areas: Area[] = [];
  const seen = new Set<string>();
  const add = (system: string, code: string): void => {
    if (seen.has(`${system}:${code}`)) return;
    seen.add(`${system}:${code}`);
    areas.push({ type: "code", system, code });
  };
  for (const code of locations) {
    if (code === "000000") {
      add("iso3166", "US");
      continue;
    }
    const location = parseSameLocation(code);
    if (location === undefined) continue;
    add("same", code);
    if (location.county === "000") {
      const state = stateOfSame(code);
      if (state !== undefined) add("state", state);
      continue;
    }
    // A place has the codes of full counties. Thus a part of a county also gives its full county, as a wider area.
    if (location.part !== "0") add("same", `0${location.state}${location.county}`);
    const ugc = countyUgcOfSame(code);
    if (ugc !== undefined) add("ugc", ugc);
  }
  return areas;
}

/** This function gives the kind of an event code. An unknown code is a lossy problem, and its kind is the unknown kind. */
function kindOf(header: SameHeader, problems: Problems): Kind {
  const found = fromEventCode(header.event);
  if (found === undefined) {
    problems.add("event", `the kind tables do not know the event code ${header.event}`);
    return { code: UNKNOWN_KIND, label: header.event };
  }
  return found.significance === undefined ? { code: found.code, label: found.label } : { code: found.code, significance: found.significance, label: found.label };
}

/** This function maps one observation, and can throw. `mapObservation` catches each error. */
function mapOrThrow(observation: Observation): MapResult {
  const text = observation.body.trim();
  const header = parseSameHeader(text);
  if (header === undefined) return { reports: [], problems: [{ path: "", message: "the body is not a SAME header", fatal: true }] };
  const sent = sameIssuedAt(header, observation.fetched);
  if (sent === undefined) return { reports: [], problems: [{ path: "day", message: `the day ${String(header.day)} is not in the year of the receipt`, fatal: true }] };
  const origin = ORIGIN_OF[header.originator];
  if (origin === undefined) return { reports: [], problems: [{ path: "originator", message: `the originator ${header.originator} is not known`, fatal: true }] };
  const problems = new Problems();
  const kind = kindOf(header, problems);
  const sender = header.sender.trim();
  const report: Report = {
    id: reportId({ source: SOURCE_ID, key: text, sent }),
    source: SOURCE_ID,
    origin,
    key: text,
    references: [],
    correlation: [],
    status: statusOf(header.event),
    op: "alert",
    kind,
    categories: [categoryOf(kind.code)],
    // A SAME header has no severity, urgency or certainty. The merge ranks unknown lowest.
    severity: "unknown",
    urgency: "unknown",
    certainty: "unknown",
    response: [],
    sent,
    received: observation.fetched,
    expires: sent + header.validMs,
    areas: areasOf(header.locations),
    about: [],
    sender,
    headline: `${kind.label} from ${sender}`,
    observation: observation.id,
    parameters: { SAME: [header.event], originator: [header.originator] },
  };
  return { reports: [report], problems: problems.list };
}

/**
 * This function maps one observation of the weather radio source to a report. The body is the text of one header. The
 * function does not throw: an error is a fatal problem.
 */
export function mapObservation(observation: Observation): MapResult {
  try {
    return mapOrThrow(observation);
  } catch (error) {
    return { reports: [], problems: [{ path: "", message: `the map function failed: ${errorMessage(error)}`, fatal: true }] };
  }
}
