/**
 * This package holds the facts of space weather that the sources of the alert system share. They are the NOAA Space
 * Weather Scales, the scale G of a value of Kp and the polar caps of a geomagnetic storm.
 */

export { GEOMAGNETIC_POLES, POLEWARD_BY_LEVEL, polarCaps } from "./caps.ts";
export {
  GEOMAGNETIC_STORM_KIND,
  geomagneticLevel,
  KP_MAX,
  KP_THIRDS_BY_LEVEL,
  kpText,
  RADIO_BLACKOUT_KIND,
  SEVERITY_BY_LEVEL,
  SOLAR_RADIATION_STORM_KIND,
  SPACE_WEATHER_KIND,
  thirdsText,
} from "./scales.ts";
export type { ScaleLevel } from "./scales.ts";
