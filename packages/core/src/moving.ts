/**
 * The moving places (AL-40). A moving place gets its position from the fixes of a phone. This module gives the fix, the
 * place at a fix and the checks of the configuration. It names no person and no place: the places are input data.
 */
import type { Instant, PlaceId, Position, RegionCode, WatchedPlace } from "./contracts.ts";
import type { PlaceConfig } from "./config.ts";

/** A fix in the future by more than this time gives no place. It is the drift of the clock of a phone. */
export const FIX_FUTURE_LIMIT_MS = 60_000;

/** One reading of the position of a moving place. It stays on the copy that takes it. */
export interface PositionFix {
  readonly place: PlaceId;
  /** The position of the phone at the fix. */
  readonly at: Position;
  /** The radius of the doubt of the fix, in kilometers. */
  readonly accuracyKm: number;
  /** The time of the reading on the phone. */
  readonly observedAt: Instant;
}

/**
 * This function gives the watched place at a fix, or `undefined`. The buffer is the buffer of the place plus the doubt
 * of the fix. Thus an imprecise fix widens the match, on the safe side.
 *
 * - It gives `undefined` for a place with no rule `moving`, with no fix, or with a fix of another place.
 * - It gives `undefined` for a fix older than `maxAgeMinutes`, and for a fix in the future by more than one minute.
 * - The `codes` are the codes of the regions at the fix. The caller gives them from its outlines. With no outline, it gives none.
 */
export function movingPlace(place: PlaceConfig, fix: PositionFix | undefined, now: Instant, codes: readonly RegionCode[]): WatchedPlace | undefined {
  if (place.moving === undefined || fix === undefined || fix.place !== place.id) return undefined;
  if (fixAge(fix, now) > place.moving.maxAgeMinutes * 60_000) return undefined;
  if (fix.observedAt - now > FIX_FUTURE_LIMIT_MS) return undefined;
  return { id: place.id, at: fix.at, codes, bufferKm: place.bufferKm + fix.accuracyKm };
}

/** This function gives the age of a fix in milliseconds. A fix in the future has the age zero. */
export function fixAge(fix: PositionFix, now: Instant): number {
  return Math.max(0, now - fix.observedAt);
}

/**
 * This function gives the problems of a fix before the runtime keeps it: a position out of range, a doubt that is not a
 * finite number of zero or more, and a time that is not finite. The texts hold no position.
 */
export function fixProblems(fix: PositionFix): string[] {
  const problems: string[] = [];
  const [lon, lat] = fix.at;
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) problems.push(`The fix of the place ${fix.place} has a position out of range.`);
  if (!Number.isFinite(fix.accuracyKm) || fix.accuracyKm < 0) problems.push(`The fix of the place ${fix.place} has no valid accuracy.`);
  if (!Number.isFinite(fix.observedAt)) problems.push(`The fix of the place ${fix.place} has no valid time.`);
  return problems;
}

/**
 * This function gives the problems of the rule `moving` of a place. A moving place has no `at` and no `sharePosition`. Its
 * age limit is a positive finite number. Its device has a text, and no other moving place has the same device.
 */
export function movingProblems(place: PlaceConfig, places: readonly PlaceConfig[]): string[] {
  const rule = place.moving;
  if (rule === undefined) return [];
  const problems: string[] = [];
  if (place.at !== undefined) problems.push(`The moving place ${place.id} has a position. A moving place gets its position only from its fixes.`);
  if (place.sharePosition !== undefined) problems.push(`The moving place ${place.id} has sharePosition. No source gets the position of a moving place.`);
  if (!Number.isFinite(rule.maxAgeMinutes) || rule.maxAgeMinutes <= 0) problems.push(`The moving place ${place.id} has no positive age limit.`);
  if (rule.device.trim() === "") problems.push(`The moving place ${place.id} has no device.`);
  const first = places.find((other) => other.moving?.device === rule.device);
  if (first !== undefined && first.id !== place.id) problems.push(`The moving places ${first.id} and ${place.id} have one device.`);
  return problems;
}

/** This function gives the moving place of a device, or `undefined`. */
export function placeOfDevice(places: readonly PlaceConfig[], device: string): PlaceConfig | undefined {
  return places.find((place) => place.moving?.device === device);
}
