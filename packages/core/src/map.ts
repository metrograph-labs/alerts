/**
 * This module gives the view of the map: the live incidents in the order of their level, with their
 * shapes. The view also gives each watched place with its highest level and its gaps of coverage. The view is a pure
 * calculation. A renderer draws it, and a store of shapes gives the outline of each region code.
 */
import { compareCodeUnits } from "@mark1russell7/text/order";
import { assess, higherLevel, matchPlaces, reachedAssessment } from "./assess.ts";
import { isPrivate } from "./audience.ts";
import type { IndicatorBreadth } from "./breadth.ts";
import type { IndicatorSurprise } from "./threat.ts";
import {
  ASSESSED_LEVELS,
  type Area,
  type AssessedLevel,
  type Assessment,
  type AssessPolicy,
  type Coverage,
  type Incident,
  type Kind,
  type PersonWatch,
  type PlaceId,
  type Position,
  type RegionCode,
  type ReportId,
  type ScorePriors,
  type Severity,
  type ShadowScore,
  type Instant,
  type Status,
} from "./contracts.ts";
import { coverageShort } from "./coverage.ts";
import { shadowScore } from "./score.ts";
import { areasWithoutBlocks, distinctShapes } from "./shapes.ts";

/** A shape of the map in WGS 84: a polygon or a circle. A region code gets its shapes from the store. */
export type MapShape = Extract<Area, { readonly type: "polygon" } | { readonly type: "circle" }>;

/**
 * This function gives the shapes of a region code, or `undefined` when the store has no shape for it.
 * A region with many parts, for example a county with islands, has many shapes.
 */
export type ShapeLookup = (code: RegionCode) => readonly MapShape[] | undefined;

/** A place of the map. The label and the position stay on the machine of the instance. */
export interface MapPlaceInput {
  readonly id: PlaceId;
  readonly label: string;
  readonly at?: Position;
  readonly codes: readonly RegionCode[];
  readonly bufferKm: number;
}

/** These are the inputs of the view of the map. */
export interface MapInput {
  /** The incidents of the merge. The view keeps only the live incidents. */
  readonly incidents: readonly Incident[];
  /** The assessments of each person for these incidents. */
  readonly assessments: readonly Assessment[];
  readonly places: readonly MapPlaceInput[];
  /** The coverage of each place and kind. A short entry is a gap at its place. */
  readonly coverage: readonly Coverage[];
  readonly shape: ShapeLookup;
}

/** An incident on the map. */
export interface MapIncident {
  readonly anchor: ReportId;
  /**
   * The status of the incident. A renderer shows each status other than `actual` with a look and a legend entry of its own.
   * Thus a test or an exercise does not look like a real alert.
   */
  readonly status: Status;
  readonly kind: Kind;
  /** The highest level of the incident over each person, or `none` when no person gets it. */
  readonly level: AssessedLevel;
  readonly severity: Severity;
  readonly onset?: Instant;
  readonly expires?: Instant;
  /** The shapes of the areas: each polygon, each circle and the shapes of each region code. Each shape comes one time. */
  readonly shapes: readonly MapShape[];
  /** The region codes of the areas with no shape in the store. The renderer lists them as text. */
  readonly unshaped: readonly RegionCode[];
  /** The watched places in the areas, for each person. */
  readonly places: readonly PlaceId[];
  /**
   * The shadow score of the incident, when the payload has the priors and the incident reaches a person. The score
   * does not change the level.
   */
  readonly shadow?: ShadowScore;
}

/** A watched place on the map. */
export interface MapPlace {
  readonly id: PlaceId;
  readonly label: string;
  readonly at?: Position;
  /**
   * The shapes of the smallest region of the place with a shape: a zone before a county, a county
   * before a state. The list is empty when no code of the place has a shape.
   */
  readonly shapes: readonly MapShape[];
  /**
   * The highest level of the live incidents at the place. An assessment keeps only the highest level
   * of its places. Thus this level is an upper bound when a rule lowers the level at one place.
   */
  readonly level: AssessedLevel;
  /** The anchors of the live incidents at the place, in the order of the view. */
  readonly incidents: readonly ReportId[];
  /** The kinds whose coverage at the place is short. */
  readonly gaps: readonly string[];
}

/** The view of the map. */
export interface MapView {
  /** The live incidents, from the highest level. In one level, the order is the severity, then the anchor. */
  readonly incidents: readonly MapIncident[];
  /** The places, in the order of the input. */
  readonly places: readonly MapPlace[];
  /** Each region code of a live incident with no shape, once, in the order of the system and the code. */
  readonly unshaped: readonly RegionCode[];
}

/** One region of the basemap: its code, its name and its shapes, from the store of shapes. */
export interface MapRegion {
  readonly code: RegionCode;
  readonly name: string;
  readonly shapes: readonly MapShape[];
}

/**
 * The answer of the map route of the runtime: the view, and the regions of the basemap. The route is on the loopback
 * address only, because the view holds the labels and the positions of the places. The local page draws this answer.
 */
export interface MapPayload {
  /** The format of the payload. A page of another format tells the reader to start the runtime of its own version. */
  readonly format: typeof MAP_FORMAT;
  /** The time of the view: the time of the last pass, or `null` before the first pass. */
  readonly at: Instant | null;
  readonly view: MapView;
  /** The regions under the view: the zones and the counties of each watched state, from the store of shapes. */
  readonly basemap: readonly MapRegion[];
  /**
   * The breadth of the indicator signals at the time of the view, in the world and at each place. A runtime with no store
   * of the readings has no field. The breadth is of the last pass, thus a past map of the history has no breadth.
   */
  readonly breadth?: IndicatorBreadth;
  /**
   * The surprise of the indicator signals of the last pass, in the world and at each place (AL-24). A runtime with no
   * store of the readings has no field. A fault of the history of the units also gives no field.
   */
  readonly surprise?: IndicatorSurprise;
}

/** The name of the format of the map payload. A change that breaks a reader gets a new name. */
export const MAP_FORMAT = "alerts-map/1";

/** These are the inputs of the payload of the map route. */
export interface MapPayloadInput extends Omit<MapInput, "assessments"> {
  /** The time of the view: the time of the last pass, or `null` before the first pass. */
  readonly at: Instant | null;
  /** The watches of the people. The payload assesses each live incident for each person at `at`. */
  readonly people: readonly PersonWatch[];
  /** The policy of the assessment: the policy of the delivery. The default is the policy of the core. */
  readonly policy?: AssessPolicy;
  /** The regions under the view, from the store of shapes. */
  readonly basemap: readonly MapRegion[];
  /** The priors of the shadow score. Without them, no incident of the payload has a score. */
  readonly priors?: ScorePriors;
  /**
   * The test of an incident of only the sources of other copies (`foreignIncidents`, AL-76). Thus the level on the map
   * is the level of the route. Without the test, each incident is an incident of this copy.
   */
  readonly foreign?: ((incident: Pick<Incident, "anchor" | "reports">) => boolean) | undefined;
  /** The breadth of the indicator signals of the last pass. Without it, the payload has no field `breadth`. */
  readonly breadth?: IndicatorBreadth;
  /** The surprise of the indicator signals of the last pass. Without it, the payload has no field `surprise`. */
  readonly surprise?: IndicatorSurprise;
}

// The view with the shadow score of each incident that reaches a person. The score does not change the level.
function withShadow(view: MapView, live: readonly Incident[], priors: ScorePriors): MapView {
  const byAnchor = new Map(live.map((incident) => [incident.anchor, incident]));
  const incidents = view.incidents.map((shown) => {
    const incident = byAnchor.get(shown.anchor);
    return shown.level === "none" || incident === undefined ? shown : { ...shown, shadow: shadowScore(incident, priors) };
  });
  return { ...view, incidents };
}

/**
 * This function gives the payload of the map route. It assesses each live incident for each person with the policy of the
 * delivery. Thus the level on the map is the level that reaches the person. A mute with the effect `absent` gives `none`.
 * With the priors, each incident that reaches a person gets its shadow score.
 */
export function mapPayload(input: MapPayloadInput): MapPayload {
  const { at, people, policy, basemap, priors, breadth, surprise, foreign, ...given } = input;
  // Each viewer of the page sees the map, so it shows no private incident (AL-92, `audience.ts`).
  const view = { ...given, incidents: given.incidents.filter((incident) => !isPrivate(incident)) };
  const live = view.incidents.filter((incident) => incident.live);
  const assessments = live.flatMap((incident) => people.map((person) => reachedAssessment(assess(incident, person, view.places, policy, at ?? undefined, foreign?.(incident) ?? false))));
  const drawn = mapView({ ...view, assessments });
  return { format: MAP_FORMAT, at, view: priors === undefined ? drawn : withShadow(drawn, live, priors), basemap, ...(breadth === undefined ? {} : { breadth }), ...(surprise === undefined ? {} : { surprise }) };
}

/** The severities, from the highest. The map and the history sort by this order. */
export const SEVERITY_ORDER: readonly Severity[] = ["extreme", "severe", "moderate", "minor", "unknown"];

/**
 * This function gives the rank of the size of a region code, from the smallest. An NWS forecast zone or fire zone
 * (`KSZ083`) is before an NWS county (`KSC173`), a county before a state, and a state before a country.
 */
export function regionRank(code: RegionCode): number {
  switch (code.system) {
    case "ugc":
      return code.code[2] === "Z" ? 0 : 1;
    case "ugc-fire":
      return 0;
    case "same":
    case "fips":
      return 1;
    case "state":
      return 2;
    case "iso3166":
      return 3;
    default:
      return 4;
  }
}

/** This function gives the view of the map. The output does not depend on the order of the incidents or the assessments. */
export function mapView(input: MapInput): MapView {
  const levels = new Map<string, AssessedLevel>();
  const placeLevels = new Map<string, AssessedLevel>();
  for (const assessment of input.assessments) {
    levels.set(assessment.incident, higherLevel(levels.get(assessment.incident) ?? "none", assessment.level));
    for (const place of assessment.places) placeLevels.set(place, higherLevel(placeLevels.get(place) ?? "none", assessment.level));
  }

  const unshaped = new Map<string, RegionCode>();
  const incidents = input.incidents
    .filter((incident) => incident.live)
    .map((incident): MapIncident => {
      const shapes: MapShape[] = [];
      const missing: RegionCode[] = [];
      for (const area of areasWithoutBlocks(incident.areas)) {
        if (area.type === "polygon" || area.type === "circle") shapes.push(area);
        else if (area.type === "code") {
          const code = { system: area.system, code: area.code };
          const found = input.shape(code);
          if (found === undefined) {
            missing.push(code);
            unshaped.set(regionCodeKey(code), code);
          } else shapes.push(...found);
        }
      }
      return {
        anchor: incident.anchor,
        status: incident.status,
        kind: incident.kind,
        level: levels.get(incident.anchor) ?? "none",
        severity: incident.severity,
        ...(incident.onset === undefined ? {} : { onset: incident.onset }),
        ...(incident.expires === undefined ? {} : { expires: incident.expires }),
        // A zone and its county can give one outline from the store. The renderer draws each shape one time.
        shapes: distinctShapes(shapes),
        unshaped: missing,
        places: matchPlaces(incident, input.places).map((match) => match.place),
      };
    })
    .sort(compareMapIncidents);

  const places = input.places.map((place): MapPlace => {
    const gaps = input.coverage.filter((entry) => entry.place === place.id && coverageShort(entry)).map((entry) => entry.kind);
    return {
      id: place.id,
      label: place.label,
      ...(place.at === undefined ? {} : { at: place.at }),
      shapes: smallestShapes(place.codes, input.shape),
      level: placeLevels.get(place.id) ?? "none",
      incidents: incidents.filter((incident) => incident.places.includes(place.id)).map((incident) => incident.anchor),
      gaps: [...new Set(gaps)].sort(compareCodeUnits),
    };
  });

  return {
    incidents,
    places,
    unshaped: [...unshaped.values()].sort(compareRegionCodes),
  };
}

/** The shapes of the smallest region of the codes with a shape. In one rank, the first code of the place wins. */
function smallestShapes(codes: readonly RegionCode[], shape: ShapeLookup): readonly MapShape[] {
  const ranked = codes.map((code, index) => ({ code, index, rank: regionRank(code) })).sort((a, b) => a.rank - b.rank || a.index - b.index);
  for (const { code } of ranked) {
    const found = shape(code);
    if (found !== undefined && found.length > 0) return found;
  }
  return [];
}

/** This function compares two incidents of the map: the higher level first. In one level, the order is the severity, then the anchor. */
export function compareMapIncidents(a: MapIncident, b: MapIncident): number {
  return ASSESSED_LEVELS.indexOf(b.level) - ASSESSED_LEVELS.indexOf(a.level) || SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || compareCodeUnits(a.anchor, b.anchor);
}

/** This function gives the key of a region code: one text for each system and code. Two equal codes give one key. */
export function regionCodeKey(code: RegionCode): string {
  return `${code.system}\u0000${code.code}`;
}

/** This function compares two region codes by the system, then by the code. */
export function compareRegionCodes(a: RegionCode, b: RegionCode): number {
  return compareCodeUnits(a.system, b.system) || compareCodeUnits(a.code, b.code);
}
