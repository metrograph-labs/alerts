/**
 * The holds of the moving places (AL-40). A fix of a phone at the edge of an area goes out of the area and back in. Without
 * a hold, each exit ends the route, and each return starts a new episode with new message keys. Thus the phone alerts again.
 * A hold keeps the match of a moving place for an incident until the incident ends. It names no person and no place.
 */
import type { Incident, PlaceId, ReportId, WatchedPlace } from "./contracts.ts";
import { matchPlaces } from "./assess.ts";

/**
 * The places that the moving places hold for each live incident. The key is the anchor of the incident at the last pass.
 * Each held place is the moving place at its last fix in the areas of the incident. It stays in memory only.
 */
export type PlaceHolds = ReadonlyMap<ReportId, readonly WatchedPlace[]>;

/** The holds at the start: no hold. */
export const NO_HOLDS: PlaceHolds = new Map();

// The held places of an incident: the holds of its anchor and of each of its reports, with one place for each id.
function heldOf(incident: Pick<Incident, "anchor" | "reports">, holds: PlaceHolds): WatchedPlace[] {
  if (holds.size === 0) return [];
  const byId = new Map<PlaceId, WatchedPlace>();
  for (const id of [incident.anchor, ...incident.reports]) for (const place of holds.get(id) ?? []) if (!byId.has(place.id)) byId.set(place.id, place);
  return [...byId.values()];
}

/**
 * This function gives the holds after a pass. Use it one time for each pass, before `route`.
 *
 * - A moving place of `places` that the areas of a live incident cover (`matchPlaces`) holds that incident at its fix of this pass.
 * - A hold stays while its incident is live, also when the fix leaves the area or goes stale. A later match moves it to the new fix.
 * - An incident that is not live, or that is not in `incidents`, keeps no hold. Thus the end of the incident ends its holds.
 * - `moving` tells the moving places. A fixed place gets no hold, thus it keeps the rule with no hold.
 * - A hold of a place that is no longer moving goes away.
 */
export function holdPlaces(holds: PlaceHolds, incidents: readonly Incident[], places: readonly WatchedPlace[], moving: (place: PlaceId) => boolean): PlaceHolds {
  const movingNow = places.filter((place) => moving(place.id));
  if (movingNow.length === 0 && holds.size === 0) return holds;
  const byId = new Map(movingNow.map((place) => [place.id, place]));
  const next = new Map<ReportId, readonly WatchedPlace[]>();
  for (const incident of incidents) {
    if (!incident.live) continue;
    const kept = new Map<PlaceId, WatchedPlace>();
    for (const place of heldOf(incident, holds)) if (moving(place.id)) kept.set(place.id, place);
    for (const match of movingNow.length === 0 ? [] : matchPlaces(incident, movingNow)) kept.set(match.place, byId.get(match.place)!);
    if (kept.size > 0) next.set(incident.anchor, [...kept.values()]);
  }
  return next;
}

/**
 * This function gives the places of one incident with its holds. The `route` reads them for that incident.
 *
 * - A place with no hold stays as it is.
 * - A held place at a fix that the areas of the incident cover stays as it is. Otherwise its hold takes its position.
 * - A held place that is not in `places`, for example after a stale fix, comes after the places.
 */
export function heldPlaces(incident: Pick<Incident, "anchor" | "reports" | "areas">, places: readonly WatchedPlace[], holds: PlaceHolds): readonly WatchedPlace[] {
  const held = heldOf(incident, holds);
  if (held.length === 0) return places;
  const byId = new Map(held.map((place) => [place.id, place]));
  const present = new Set<PlaceId>();
  const result = places.map((place) => {
    present.add(place.id);
    const hold = byId.get(place.id);
    if (hold === undefined || hold === place || matchPlaces(incident, [place]).length > 0) return place;
    return hold;
  });
  return [...result, ...held.filter((place) => !present.has(place.id))];
}
