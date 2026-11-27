/**
 * The FIRMS source of the alert system: the satellite hotspots of the VIIRS instruments near each watched place, from the
 * Fire Information for Resource Management System of NASA. Each hotspot of the nominal or the high confidence gives one
 * report. The data of NASA has no restriction (CC0). NASA asks for the credit `FIRMS_CREDIT` in each use of the data.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";

import { checkCanary } from "./check.ts";
import { FIRMS_DESCRIPTOR } from "./descriptor.ts";
import { createFirmsFetch, type FirmsFetchOptions } from "./fetch.ts";
import { mapObservation } from "./map.ts";

export { checkCanary, NEWEST_MAX_DAYS } from "./check.ts";
export { FETCH_INTERVAL_MS, FIRMS_DESCRIPTOR } from "./descriptor.ts";
export {
  AVAILABILITY_HEADER,
  BOX_MARGIN_KM,
  boxText,
  createFirmsFetch,
  DAY_RANGE,
  failureOfRequest,
  FIRMS_BASE_URL,
  INVALID_KEY_TEXT,
  LIMIT_TEXT,
  LIMIT_WAIT_MS,
  MAX_BOXES,
  MIN_INTERVAL_MS,
  placeBoxes,
  PRODUCTS,
  readAvailability,
  readProduct,
  scanTime,
  TIMEOUT_MS,
  VIIRS_HEADER,
  watchBoxes,
} from "./fetch.ts";
export type { Box, FirmsFetchInput, FirmsFetchOptions, ProductRows } from "./fetch.ts";
export {
  AVAILABILITY_TYPE,
  CELL_DEGREES,
  CELL_SYSTEM,
  cellOf,
  FIRMS_CREDIT,
  FIRMS_ORIGIN,
  FIRMS_SENDER,
  HOTSPOT_FIELDS,
  HOTSPOT_KIND,
  HOTSPOT_LIFE_MS,
  HOTSPOT_TYPE,
  hotspotArea,
  hotspotBody,
  hotspotReport,
  mapObservation,
  readHotspot,
  REPORT_CONFIDENCES,
  SATELLITES,
  SOURCE_ID,
} from "./map.ts";
export type { HotspotBody, ReportConfidence } from "./map.ts";

/**
 * This function makes the procedures of the FIRMS source. The source has a canary: the newest date of the data of the
 * VIIRS products. It has no `locate`: the fetch reads the positions of the places of the watch.
 */
export function createFirmsSource(options: FirmsFetchOptions): SourceProcedures {
  const fetch = createFirmsFetch(options);
  return {
    describe: () => FIRMS_DESCRIPTOR,
    // The signal of the caller stops the fetch at its limit, also in the wait of the pace.
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => mapObservation(observation),
    check: ({ observations }) => checkCanary(observations),
  };
}
