/**
 * This file holds the NOAA Space Weather Scales for the alert system. It gives the kind code of each scale, the
 * severity of each level and the scale G of a value of the planetary index Kp. The table of the scales is on the page
 * `https://www.swpc.noaa.gov/noaa-scales-explanation`.
 */

import type { Severity } from "@mark1russell7/alerts";

/** The kind code of space weather with no NOAA scale: a K-index of 4, a sudden impulse, an electron flux or a radio emission. */
export const SPACE_WEATHER_KIND = "geo.space-weather";

/** The kind code of a geomagnetic storm: the NOAA scale G. */
export const GEOMAGNETIC_STORM_KIND = "geo.space-weather.geomagnetic-storm";

/** The kind code of a radio blackout from a solar flare: the NOAA scale R. */
export const RADIO_BLACKOUT_KIND = "geo.space-weather.radio-blackout";

/** The kind code of a solar radiation storm: the NOAA scale S, and the protons of 100 MeV. */
export const SOLAR_RADIATION_STORM_KIND = "geo.space-weather.solar-radiation-storm";

/** A level of a NOAA space weather scale: `G` (geomagnetic storms), `S` (solar radiation storms) or `R` (radio blackouts), 1 to 5. */
export interface ScaleLevel {
  readonly scale: "G" | "S" | "R";
  readonly level: 1 | 2 | 3 | 4 | 5;
}

/**
 * The severity of each level of a NOAA scale, from no level (index 0) to level 5. The NOAA names are minor, moderate,
 * strong, severe and extreme. CAP has no word for strong, so level 3 is `moderate`.
 */
export const SEVERITY_BY_LEVEL: readonly Severity[] = ["minor", "minor", "moderate", "moderate", "severe", "extreme"];

/**
 * The lowest value of Kp, in thirds, for each level of the scale G, from G1 to G5. The NOAA table gives G1 at Kp 5, G2
 * at Kp 6, G3 at Kp 7, G4 at "Kp = 8, including a 9-" and G5 at Kp 9. Thus a value with a minus is in the class of
 * its whole number: 5- (14 thirds, 4.667) is Kp 5. Only 9- is the exception, because the table puts it in G4.
 */
export const KP_THIRDS_BY_LEVEL: readonly number[] = [14, 17, 20, 23, 27];

/** The largest value of the index Kp. */
export const KP_MAX = 9;

/**
 * This function gives the level of the scale G of a value of the index Kp, from 0 (no storm) to 5. The value has
 * thirds, as GFZ writes them: `4.667` is 5-, and `5.333` is 5+. The function rounds the value to the nearest third
 * first. A value that is not a number from 0 to 9 gives `undefined`.
 */
export function geomagneticLevel(kp: number): 0 | ScaleLevel["level"] | undefined {
  if (!Number.isFinite(kp) || kp < 0 || kp > KP_MAX) return undefined;
  const thirds = Math.round(kp * 3);
  let level = 0;
  while (level < KP_THIRDS_BY_LEVEL.length && thirds >= KP_THIRDS_BY_LEVEL[level]!) level++;
  return level as 0 | ScaleLevel["level"];
}

/** This function gives the text of a value of the index Kp with its third, for example `5-`, `5` or `5+`. A value out of range gives `undefined`. */
export function kpText(kp: number): string | undefined {
  return kp > KP_MAX ? undefined : thirdsText(kp);
}

/**
 * This function gives the text of a value with its third, as `kpText` does, but with no upper limit. The indices Hp30
 * and Hp60 of GFZ have no upper limit: `11.333` is 11+. A value that is not a number of 0 or more gives `undefined`.
 */
export function thirdsText(value: number): string | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  const thirds = Math.round(value * 3);
  const whole = Math.round(thirds / 3);
  const rest = thirds - whole * 3;
  return `${whole}${rest < 0 ? "-" : rest > 0 ? "+" : ""}`;
}
