/**
 * The coverage of each kind at each place. It gives the sources that are up, the count of their
 * independent outside failure domains, and the resources of the cell that they share. It is a pure
 * calculation on the descriptors, the health and the places. It reads no clock.
 *
 * `independent` is the size of the smallest set of outside domains whose faults stop each of the
 * sources. That is a minimum hitting set, and `@mark1russell7/collections/graph` calculates it.
 */
import { minimumHittingSet, type HittingSetChoice } from "@mark1russell7/collections/graph";
import { CONTEXT_KINDS, hasKind, LIFE_SAFETY_KINDS, regionContains } from "./assess.ts";
import type { Coverage, HealthState, PlaceId, RegionCode, SourceDescriptor, SourceHealth, SourceId, WatchedPlace } from "./contracts.ts";
import { CELL_RESOURCES } from "./contracts.ts";
import { isShape, shapeDistanceKm } from "./shapes.ts";

/** The count of independent outside domains that a class of kinds needs. */
export interface CoverageNeed {
  /** The prefixes of the taxonomy codes of the class. */
  readonly kinds: readonly string[];
  readonly required: number;
}

/** The policy of the coverage. */
export interface CoveragePolicy {
  /** The health states in which a source counts for the coverage. */
  readonly up: readonly HealthState[];
  /** The needs of the classes of kinds. The first need whose prefixes have the kind applies. */
  readonly needs: readonly CoverageNeed[];
  /** The count for a kind that no need has. */
  readonly otherwise: number;
  /** The largest count of steps of the search of the hitting set. Absent: the default of the search. */
  readonly maxSteps?: number;
}

/**
 * The first policy. A source counts when it is `healthy` or `slow`. Each life-safety kind needs 2
 * independent domains, so no single outside fault stops it. A kind of context (`CONTEXT_KINDS`) needs none,
 * because its reports reach the digest at most. Each other kind needs 1.
 */
export const DEFAULT_COVERAGE_POLICY: CoveragePolicy = {
  up: ["healthy", "slow"],
  needs: [
    { kinds: LIFE_SAFETY_KINDS, required: 2 },
    { kinds: CONTEXT_KINDS, required: 0 },
  ],
  otherwise: 1,
};

/** What the coverage needs: the sources, their health, the places and the kinds to examine. */
export interface CoverageInput {
  readonly sources: readonly SourceDescriptor[];
  /** The health of the sources. A source with no health is `unknown`. */
  readonly health: readonly SourceHealth[];
  /**
   * The sources that are late against another source, from `lateSources`. A late source does not
   * count, also when its health state is up: its fetches pass, but it does not carry the reports.
   */
  readonly late?: readonly SourceId[];
  readonly places: readonly WatchedPlace[];
  /** The taxonomy codes or prefixes to examine at each place. */
  readonly kinds: readonly string[];
  /**
   * The codes of the regions that hold all of the region of a code, for example the state of a zone. The coverage adds them
   * to the codes of each place, and then the codes of those codes. Without it, a place has only its own codes. The core knows
   * no system of codes, so the package of a format gives this function.
   */
  readonly containing?: (code: RegionCode) => readonly RegionCode[];
}

/** The largest count of codes of one place, with the codes that `containing` adds. */
export const MAX_PLACE_CODES = 1000;

/**
 * This function gives the codes of a place and each code that `containing` gives for them, again and again, with no
 * code two times. The codes of the place stay first, in their order.
 *
 * @throws RangeError when the place gets more than `MAX_PLACE_CODES` codes, because the function gives codes with no end.
 */
export function placeCodesWithContaining(codes: readonly RegionCode[], containing: (code: RegionCode) => readonly RegionCode[]): RegionCode[] {
  const all: RegionCode[] = [];
  const seen = new Set<string>();
  const add = (code: RegionCode): void => {
    const key = JSON.stringify([code.system, code.code]);
    if (seen.has(key)) return;
    if (all.length >= MAX_PLACE_CODES) throw new RangeError(`A place has more than ${MAX_PLACE_CODES} codes with the codes that contain them.`);
    seen.add(key);
    all.push({ system: code.system, code: code.code });
  };
  codes.forEach(add);
  for (let at = 0; at < all.length; at += 1) {
    const code = all[at];
    if (code !== undefined) containing(code).forEach(add);
  }
  return all;
}

/**
 * This function tells if a source covers a kind at a place, when the source is up.
 *
 * - One prefix of the source must have the kind. A source of a part of the kind does not count: the
 *   prefix `met.tornado.warning` does not cover the kind `met.tornado`.
 * - The coverage of the source must be `global`, or an area of the coverage must hold the place. A
 *   code of the coverage must hold a code of the place (`regionContains`), or a shape must contain the
 *   position of the place.
 * - A shape covers no place with no position. A shape that `@mark1russell7/geo` refuses covers no
 *   place, so the coverage shows a gap.
 */
export function sourceCovers(source: SourceDescriptor, place: WatchedPlace, kind: string): boolean {
  if (!hasKind(source.kinds, kind)) return false;
  if (source.coverage === "global") return true;
  const at = place.at;
  return source.coverage.some((area) =>
    area.type === "code"
      ? place.codes.some((code) => regionContains(area, code))
      : isShape(area) && at !== undefined && shapeDistanceKm(area, at) === 0,
  );
}

/**
 * This function gives the outside failure domains of a source for the coverage. A source with no
 * domain gets its own domain `source:<id>`, so it is independent of each other source.
 */
export function failureDomains(source: SourceDescriptor): readonly string[] {
  return source.dependsOn.length > 0 ? source.dependsOn : [`source:${source.id}`];
}

/** This function gives the count of independent domains that the policy needs for a kind. */
export function requiredFor(policy: CoveragePolicy, kind: string): number {
  return policy.needs.find((need) => hasKind(need.kinds, kind))?.required ?? policy.otherwise;
}

/**
 * This function gives the coverage of each kind at each place, in the order of the places and then
 * of the kinds. The sources of each coverage are in the order of the input. With `containing`, a
 * source of a region that holds a code of a place covers that place.
 *
 * @throws RangeError when `containing` gives more than `MAX_PLACE_CODES` codes for one place.
 */
export function coverage(input: CoverageInput, policy: CoveragePolicy = DEFAULT_COVERAGE_POLICY): Coverage[] {
  const states = new Map<SourceId, HealthState>(input.health.map((entry) => [entry.source, entry.state]));
  const late = new Set(input.late ?? []);
  const up = input.sources.filter((source) => policy.up.includes(states.get(source.id) ?? "unknown") && !late.has(source.id));
  return expandedPlaces(input).flatMap((place) =>
    input.kinds.map((kind) => coverageOf(place.id, kind, up.filter((source) => sourceCovers(source, place, kind)), requiredFor(policy, kind), policy)),
  );
}

/** The sources that cover one kind at one place, whatever their health. */
export interface CoverageCandidates {
  readonly place: PlaceId;
  readonly kind: string;
  /** The sources that cover the kind at the place when they are up, in the order of the input. */
  readonly sources: readonly SourceId[];
}

/**
 * This function gives the sources that cover each kind at each place, whatever their health and lateness. The order is
 * the order of `coverage`. A source that is down is in this list, but not in the list of `coverage`. The list depends
 * only on the sources, the places and the kinds, thus a caller can keep it until they change.
 *
 * @throws RangeError when `containing` gives more than `MAX_PLACE_CODES` codes for one place.
 */
export function coverageCandidates(input: Pick<CoverageInput, "sources" | "places" | "kinds" | "containing">): CoverageCandidates[] {
  return expandedPlaces(input).flatMap((place) =>
    input.kinds.map((kind) => ({ place: place.id, kind, sources: input.sources.filter((source) => sourceCovers(source, place, kind)).map((source) => source.id) })),
  );
}

/** This function gives the places of an input, each with the codes that `containing` adds. */
function expandedPlaces(input: Pick<CoverageInput, "places" | "containing">): readonly WatchedPlace[] {
  const { containing } = input;
  return containing === undefined ? input.places : input.places.map((place) => ({ ...place, codes: placeCodesWithContaining(place.codes, containing) }));
}

/**
 * This function tells if a coverage is below its policy. A coverage that the search did not prove
 * is also below, because its true count can be smaller. A policy that needs no source has no gap, also
 * when the search of many sources stops at its budget.
 */
export function coverageShort(entry: Coverage): boolean {
  return entry.required > 0 && (!entry.proven || entry.independent < entry.required);
}

function coverageOf(place: Coverage["place"], kind: string, sources: readonly SourceDescriptor[], required: number, policy: CoveragePolicy): Coverage {
  const search = minimumHittingSet<string>(sources.map(failureDomains), policy.maxSteps === undefined ? {} : { maxSteps: policy.maxSteps });
  // Each set of domains has one or more domains, so the result is never none.
  const found: HittingSetChoice<string> = search.kind === "budget" ? search.best : search.kind === "exact" ? search : { elements: [], weight: 0 };
  const commonResources = CELL_RESOURCES.filter((resource) => sources.length > 0 && sources.every((source) => source.uses.includes(resource)));
  return {
    place,
    kind,
    sources: sources.map((source) => source.id),
    independent: found.elements.length,
    proven: search.kind === "exact",
    faults: found.elements,
    commonResources,
    required,
  };
}
