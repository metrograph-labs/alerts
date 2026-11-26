/**
 * This module keeps the outlines of the regions of the instance: the NWS zones and counties of the watched states and of
 * the live incidents. After each pass, the instance starts a refresh of the store of shapes. The refresh ends before the
 * next fetch of the alerts. Thus the alerts come first. The match by shape and the map route read the outlines here.
 *
 * The match by shape reads the outlines of the store. The map reads a simplified copy, because the outlines of one state are
 * many megabytes. The keeper simplifies the regions of the watched states again only when the store changes them. An
 * incident changes only the small copy of the regions outside those states.
 */
import { basemapToleranceKm, simplifyBasemap, type AlertConfig, type Duration, type Incident, type Instant, type MapRegion, type MapShape, type PlaceConfig, type Position, type RegionCode, type ShapeLookup, type SourceDescriptor, type SourceId, type StoreFill, type WatchedPlace } from "@mark1russell7/alerts";
import { stateOfCode } from "@mark1russell7/alerts-format-nws";
import { compareCodes, ZONE_KINDS, zoneCodesNear, zoneKindOf, type Refreshed, type ShapeStore, type Wanted, type ZoneKind } from "@mark1russell7/alerts-shapes-nws";
import { NWS_PROVIDER } from "@mark1russell7/alerts-source-nws-api";
import { countOf, errorMessage } from "@mark1russell7/text";

/**
 * The outcome of one refresh of the outlines: its result, or the error that it threw. The step `basemap` tells that the
 * simplification of the basemap threw. Then the map has the full outlines.
 */
export type ShapeOutcome = { readonly ok: true; readonly refreshed: Refreshed } | { readonly ok: false; readonly error: unknown; readonly step?: "basemap" };

/**
 * This function gives a text about a refresh with a failure, a problem or an error, or `undefined` for a refresh with none. The
 * entry writes the text to the output of the process.
 */
export function shapeReport(outcome: ShapeOutcome): string | undefined {
  if (!outcome.ok && outcome.step === "basemap") return `The simplification of the basemap threw, thus the map has the full outlines: ${errorMessage(outcome.error)}`;
  if (!outcome.ok) return `The refresh of the shapes threw: ${errorMessage(outcome.error)}`;
  const { requests, failures, problems, stop } = outcome.refreshed;
  if (failures.length === 0 && problems.length === 0) return undefined;
  const lines = [...failures.map(({ task, failure }) => `${task}: ${failure.kind}: ${failure.message}`), ...problems];
  return [`The refresh of the shapes made ${requests} requests and stopped at "${stop}". It has these failures and problems:`, ...lines.map((line) => `- ${line}`)].join("\n");
}

/** This function gives the key of a region code for a comparison. */
const codeKey = (code: RegionCode): string => `${code.system}:${code.code.trim().toUpperCase()}`;

/** This function compares two region codes: by the system, and then by the code. */
const byCode = (a: RegionCode, b: RegionCode): number => compareCodes(a.system, b.system) || compareCodes(a.code, b.code);

/** This function gives the regions in the order of their codes. */
const byRegion = (regions: Iterable<MapRegion>): MapRegion[] => [...regions].sort((a, b) => byCode(a.code, b.code));

/** A list of regions and its simplified copy. */
interface BasemapCopy {
  readonly raw: readonly MapRegion[];
  readonly simple: readonly MapRegion[];
}

/**
 * This function gives a tolerance rounded down to a power of 2. A small change of the fit then keeps the tolerance, and a copy
 * stays current. A smaller tolerance removes fewer positions, thus the rounded tolerance is on the safe side.
 */
const toleranceStep = (km: number): number => 2 ** Math.floor(Math.log2(km));

/** The simplified copy of one region and its tolerance. */
interface RegionCopy {
  readonly raw: MapRegion;
  readonly tolerance: number | undefined;
  readonly simple: MapRegion;
}

/** This function tells if two lists have the same regions, with the same arrays of shapes, in the same order. */
const sameRegions = (a: readonly MapRegion[], b: readonly MapRegion[]): boolean =>
  a.length === b.length && a.every((region, at) => region.shapes === b[at]!.shapes && region.name === b[at]!.name && codeKey(region.code) === codeKey(b[at]!.code));

/** This function gives the codes of the areas of the live incidents in capitals, once each, in the order of the system and the code. */
export function liveCodes(incidents: readonly Incident[]): RegionCode[] {
  const codes = new Map<string, RegionCode>();
  for (const incident of incidents) {
    if (!incident.live) continue;
    for (const area of incident.areas) if (area.type === "code") codes.set(codeKey(area), { system: area.system, code: area.code.trim().toUpperCase() });
  }
  return [...codes.values()].sort(byCode);
}

/**
 * This function gives the regions that the store keeps: each state of a watched place, and the codes of the live incidents.
 * The store gets the zones of the codes first, and then the zones of each state.
 *
 * The codes of the places do not go into `codes`. Their zones come with the list of their state. Thus no request names the
 * zone of a place before the other zones of its state.
 */
export function wantedShapes(places: readonly WatchedPlace[], incidents: readonly Incident[]): Wanted {
  const states = new Set<string>();
  for (const place of places) {
    for (const code of place.codes) {
      const state = stateOfCode(code);
      if (state !== undefined) states.add(state);
    }
  }
  return { states: [...states].sort(compareCodes), codes: liveCodes(incidents) };
}

/**
 * This function gives the configuration with the codes of the zones near each place with a position. The zones come from
 * `regionsOf`, for each state of a code of the place. The codes are the codes of `zoneCodesNear`, with the buffer of the place.
 *
 * - The codes of the file stay first, in their order. The added codes follow, and a code of the file is not added again.
 * - A place with no position, or with no outline of its states, keeps its codes.
 * - A place near the line of a state gets only the zones of the states of its codes. A code of the next state adds its zones.
 */
export function withZoneCodes(config: AlertConfig, regionsOf: (state: string) => readonly MapRegion[]): AlertConfig {
  return addZoneCodes(config, regionsOf).config;
}

// The zones near a place with a position. A place with no outline of its states has no zone near it.
interface PlaceZones {
  readonly outlined: boolean;
  readonly near: readonly RegionCode[];
  readonly added: readonly RegionCode[];
}

// The zones near a place, or `undefined` for a place with no position.
function zonesOf(place: PlaceConfig, regionsOf: (state: string) => readonly MapRegion[]): PlaceZones | undefined {
  if (place.at === undefined) return undefined;
  const states = new Set<string>();
  for (const code of place.codes) {
    const state = stateOfCode(code);
    if (state !== undefined) states.add(state);
  }
  const regions = [...states].sort(compareCodes).flatMap((state) => regionsOf(state));
  if (regions.length === 0) return { outlined: false, near: [], added: [] };
  const known = new Set(place.codes.map(codeKey));
  const near = zoneCodesNear(regions, place.at, place.bufferKm);
  return { outlined: true, near, added: near.filter((code) => !known.has(codeKey(code))) };
}

/**
 * This function gives the region codes of a moving place at a fix (AL-40). The states come from the codes of the file.
 *
 * - A fix in or near an outline of these states gives the zone codes near it.
 * - The result also keeps the codes of the file that name no state.
 * - The buffer of the search is the buffer of the place plus the doubt of the fix.
 * - With no outline, or with a fix outside each outline, the place keeps the codes of the file.
 */
export function codesAtFix(place: PlaceConfig, at: Position, accuracyKm: number, regionsOf: (state: string) => readonly MapRegion[]): readonly RegionCode[] {
  const states = new Set<string>();
  for (const code of place.codes) {
    const state = stateOfCode(code);
    if (state !== undefined) states.add(state);
  }
  const regions = [...states].sort(compareCodes).flatMap((state) => regionsOf(state));
  if (regions.length === 0) return place.codes;
  const near = zoneCodesNear(regions, at, place.bufferKm + accuracyKm);
  if (near.length === 0) return place.codes;
  return [...place.codes.filter((code) => stateOfCode(code) === undefined), ...near];
}

/**
 * The counts of the zone codes of the places. They tell a store with no outlines from a file that already has
 * each code, because both add no code.
 */
export interface ZoneCodeCounts {
  /** The places with a position. */
  readonly placed: number;
  /** The places with a position and with outlines of their states. */
  readonly outlined: number;
  /** The codes of the zones near the outlined places. */
  readonly near: number;
  /** The codes near the outlined places that the file does not have. `withZoneCodes` adds them. */
  readonly added: number;
}

/** The configuration with the zone codes of its places, and the counts of these codes. */
export interface ZonedConfig {
  readonly config: AlertConfig;
  readonly counts: ZoneCodeCounts;
}

/**
 * This function gives the result of `withZoneCodes` and the counts of the zone codes in one pass. Each search of the zones
 * near a place reads the outlines of whole states, thus the start does it one time.
 */
export function addZoneCodes(config: AlertConfig, regionsOf: (state: string) => readonly MapRegion[]): ZonedConfig {
  let placed = 0;
  let outlined = 0;
  let near = 0;
  let added = 0;
  const places = config.places.map((place) => {
    const zones = zonesOf(place, regionsOf);
    if (zones === undefined) return place;
    placed += 1;
    if (!zones.outlined) return place;
    outlined += 1;
    near += zones.near.length;
    added += zones.added.length;
    return zones.added.length === 0 ? place : { ...place, codes: [...place.codes, ...zones.added] };
  });
  return { config: { ...config, places }, counts: { placed, outlined, near, added } };
}

/** This function gives the line of the log about the zone codes at the start. */
export function zoneCodesText(counts: ZoneCodeCounts): string {
  if (counts.placed === 0) return "No place has a position. Thus the outlines of the zones add no code.";
  const lines: string[] = [];
  if (counts.outlined > 0) {
    lines.push(
      `The outlines of the zones give ${countOf(counts.near, "code")} near ${countOf(counts.outlined, "place")}. The file already has ${String(counts.near - counts.added)} of them, and the runtime adds ${String(counts.added)}.`,
    );
  }
  const waiting = counts.placed - counts.outlined;
  if (waiting > 0) {
    lines.push(`The store has no outlines of the states of ${countOf(waiting, "place")} yet. These places keep the codes of the file until a refresh gets the outlines.`);
  }
  return lines.join(" ");
}

/** This function gives a key of the codes of each place. Two configurations with one key have the same codes. */
export function placeCodesKey(config: AlertConfig): string {
  return JSON.stringify(config.places.map((place) => [place.id, place.codes.map(codeKey)]));
}

/** The outlines of the instance. */
export interface InstanceShapes {
  /** This function gives the shapes of a region code from the records of the store, with no simplification. */
  readonly lookup: ShapeLookup;
  /**
   * This function gives the shapes of a region code for the page. These are the simplified shapes of the last `basemap` while
   * the record of the region stays the same. Else it gives the shapes of `lookup`. The map and the history use it (AL-176).
   */
  readonly display: ShapeLookup;
  /**
   * This function gives the regions under the map, in the order of the code. These are the counties and forecast zones of the
   * watched states, and the regions of the places and the live incidents. A region is a zone or a county with a UGC code.
   * The outlines are simplified for the view box of the page with `simplifyBasemap`.
   */
  basemap(): readonly MapRegion[];
  /**
   * This function gives the fill of each family of the store (AL-86): the counties, the forecast zones and the fire zones of the
   * watched states. A fire zone counts only when the store has the outline of each fire zone of its state (`fireZones`).
   * With no store or no watched state, it gives no fill.
   */
  fill(since: Instant, within: Duration, sources: readonly SourceId[]): StoreFill[];
  /** This function waits for the end of the refresh in progress. It does not throw. */
  idle(): Promise<void>;
  /** This function stops the refresh in progress, waits for its end, and closes the cache of the store. */
  close(): Promise<void>;
}

/** This function gives the sources of the NWS API (`NWS_PROVIDER`). The store of shapes sends its requests to their host. */
export function shapeSources(sources: readonly SourceDescriptor[]): SourceDescriptor[] {
  return sources.filter((source) => source.dependsOn.includes(NWS_PROVIDER));
}

/**
 * This function gives the limit of a refresh of the shapes: the next fetch of a source of the NWS API (`NWS_PROVIDER`).
 * The store sends its requests to that host only. Thus a fetch of another host does not wait for the store, and it does not
 * limit the refresh. With no source of the NWS API, the function gives `undefined`, and no refresh starts.
 *
 * The limit of the earliest fetch of all the sources stopped each refresh: with 51 sources, a fetch is due each 2 seconds.
 */
export function refreshUntil(sources: readonly SourceDescriptor[], nextFetch: (source: SourceDescriptor) => Instant): Instant | undefined {
  let until: Instant | undefined;
  for (const source of shapeSources(sources)) {
    const next = nextFetch(source);
    if (until === undefined || next < until) until = next;
  }
  return until;
}

/** The outlines of the instance, with the step that the instance starts after each pass. */
export interface ShapeKeeper extends InstanceShapes {
  /**
   * This function keeps the live incidents of a pass and starts a refresh of the store, when no refresh is in progress. The
   * refresh starts no request that can end after `until`: the next fetch from the host of the store (`refreshUntil`). With no
   * `until`, no refresh starts. The next `basemap` simplifies the regions of the kept incidents (AL-176).
   */
  afterPass(incidents: readonly Incident[], until: Instant | undefined): void;
}

/** The options of `keepShapes`. */
export interface ShapeKeeperOptions {
  /** The store of shapes. Without a store, the instance has no outline, and the map has no region. */
  readonly store?: ShapeStore | undefined;
  /** The watched places. */
  readonly places: readonly WatchedPlace[];
  /** The keeper gives each refresh to this function. */
  readonly onShapes?: ((outcome: ShapeOutcome) => void) | undefined;
  /** The keeper starts this function at its close, after the end of the refresh. The instance closes the cache of the store here. */
  readonly close?: (() => void) | undefined;
}

// The count of the entries of each family of the store in the watched states. A fire zone counts only with each outline of its state.
function countFamilies(store: ShapeStore, states: readonly string[]): Record<ZoneKind, number> {
  const entries: Record<ZoneKind, number> = { county: 0, forecast: 0, fire: 0 };
  for (const state of states) {
    for (const region of store.basemap(state)) {
      const kind = zoneKindOf(region.code.code);
      if (kind !== undefined) entries[kind] += 1;
    }
    entries.fire += store.fireZones(state).length;
  }
  return entries;
}

/** This function makes the keeper of the outlines of the instance. */
export function keepShapes(options: ShapeKeeperOptions): ShapeKeeper {
  const { store, places } = options;
  const states = wantedShapes(places, []).states;
  const stop = new AbortController();
  let incidents: readonly Incident[] = [];
  let running: Promise<void> | undefined;
  let closed = false;
  // The counts of the families. Only a refresh changes the store, thus the keeper counts again after the end of each refresh.
  let counts: Record<ZoneKind, number> | undefined;
  const report = (outcome: ShapeOutcome): void => {
    try {
      options.onShapes?.(outcome);
    } catch {
      // The hook only reports. A fault of the hook does not stop the keeper.
    }
  };
  // The simplified copies. A record of the store keeps its array of shapes until the record changes. Thus the same arrays tell
  // that a copy is current. The copy of the watched states changes only at a refresh of the store.
  //
  // The other regions change with the incidents, and they can be many: 1,530 zones of the incidents of all states on 2026-11-24
  // (AL-176). A simplification of that set took 22 s. Thus the keeper simplifies each other region alone, one time for each
  // record and tolerance. A border of two other regions can then be two lines, at one unit of the view box or less.
  let watched: BasemapCopy | undefined;
  let others: (BasemapCopy & { readonly with: BasemapCopy }) | undefined;
  let copies = new Map<string, RegionCopy>();
  let last: { readonly watched: readonly MapRegion[]; readonly others: readonly MapRegion[]; readonly regions: readonly MapRegion[] } | undefined;
  // The simplified shapes of the last basemap, by the key of the code, with the shapes of the record that they come from.
  let shown = new Map<string, { readonly raw: readonly MapShape[]; readonly simple: readonly MapShape[] }>();
  const copyOf = (raw: readonly MapRegion[], tolerance: number | undefined): BasemapCopy => {
    if (tolerance === undefined) return { raw, simple: raw };
    try {
      return { raw, simple: simplifyBasemap(raw, tolerance) };
    } catch (error) {
      // The full outlines are correct, only larger. The keeper reports the error one time for each change of the regions.
      report({ ok: false, error, step: "basemap" });
      return { raw, simple: raw };
    }
  };

  const copyOne = (region: MapRegion, tolerance: number | undefined): MapRegion => {
    if (tolerance === undefined) return region;
    try {
      return simplifyBasemap([region], tolerance)[0]!;
    } catch (error) {
      // The copy of the region keeps its full outlines. The keeper reports the error one time for each record.
      report({ ok: false, error, step: "basemap" });
      return region;
    }
  };

  return {
    lookup: (code) => store?.lookup(code),
    display(code) {
      const shapes = store?.lookup(code);
      if (shapes === undefined || store === undefined) return shapes;
      const region = store.region(code);
      const copy = region === undefined ? undefined : shown.get(codeKey(region.code));
      return copy !== undefined && copy.raw === shapes ? copy.simple : shapes;
    },
    basemap() {
      if (store === undefined) return [];
      // The key is the system and the code: a fire zone and a forecast zone can have one code (AL-33).
      const own = new Map<string, MapRegion>();
      for (const state of states) for (const region of store.basemap(state)) own.set(codeKey(region.code), region);
      const ownList = byRegion(own.values());
      if (watched === undefined || !sameRegions(watched.raw, ownList)) watched = copyOf(ownList, basemapToleranceKm(ownList));
      // A region of a place or of an incident can be outside the watched states, or not yet in the list of its state.
      const other = new Map<string, MapRegion>();
      for (const code of [...places.flatMap((place) => place.codes), ...liveCodes(incidents)]) {
        const region = store.region(code);
        if (region !== undefined && !own.has(codeKey(region.code))) other.set(codeKey(region.code), region);
      }
      const otherList = byRegion(other.values());
      if (others === undefined || others.with !== watched || !sameRegions(others.raw, otherList)) {
        // The tolerance comes from the fit of all the regions. The page fits them all, thus it is on the safe side.
        const fit = otherList.length === 0 ? undefined : basemapToleranceKm([...ownList, ...otherList]);
        const tolerance = fit === undefined ? undefined : toleranceStep(fit);
        const next = new Map<string, RegionCopy>();
        const simple = otherList.map((region) => {
          const key = codeKey(region.code);
          const old = copies.get(key);
          const copy = old !== undefined && old.raw.shapes === region.shapes && old.raw.name === region.name && old.tolerance === tolerance ? old : { raw: region, tolerance, simple: copyOne(region, tolerance) };
          next.set(key, copy);
          return copy.simple;
        });
        // A region that is not in the list loses its copy.
        copies = next;
        others = { raw: otherList, simple, with: watched };
      }
      if (last === undefined || last.watched !== watched.simple || last.others !== others.simple) {
        last = { watched: watched.simple, others: others.simple, regions: byRegion([...watched.simple, ...others.simple]) };
        const index = new Map<string, { readonly raw: readonly MapShape[]; readonly simple: readonly MapShape[] }>();
        for (const [at, region] of watched.raw.entries()) index.set(codeKey(region.code), { raw: region.shapes, simple: watched.simple[at]!.shapes });
        for (const [at, region] of others.raw.entries()) index.set(codeKey(region.code), { raw: region.shapes, simple: others.simple[at]!.shapes });
        shown = index;
      }
      return last.regions;
    },
    fill(since, within, sources) {
      if (store === undefined || states.length === 0) return [];
      const entries = (counts ??= countFamilies(store, states));
      return ZONE_KINDS.map((family) => ({ store: "shapes", family, entries: entries[family], since, within, sources }));
    },
    afterPass(live, until) {
      incidents = live;
      if (store === undefined || until === undefined || closed || running !== undefined) return;
      const work = store.refresh({ wanted: wantedShapes(places, live), until, signal: stop.signal }).then(
        (refreshed) => report({ ok: true, refreshed }),
        // The close aborts the refresh. That abort is not a fault.
        (error: unknown) => (stop.signal.aborted ? undefined : report({ ok: false, error })),
      );
      running = work.finally(() => {
        running = undefined;
        counts = undefined;
      });
    },
    idle: async () => {
      await running;
    },
    async close() {
      if (closed) return;
      closed = true;
      stop.abort(new Error("The instance closed the store of shapes."));
      await running;
      options.close?.();
    },
  };
}
