/**
 * This package holds four formats of the US warning system. The first is the Valid Time Event Code
 * (P-VTEC) of the NWS. The second is the kinds of the NWS and SAME event codes in the taxonomy of the
 * alert system. The third is the UGC and SAME region codes and the state codes. The fourth is the
 * event codes of the WEA messages.
 *
 * The package also holds the origin and the office ids of the NWS, and the rule of the keepalive of the NWS. The NWS API source, the CAP sources,
 * the IEM source and the weather radio source use these functions.
 */

export {
  EVENT_CODES,
  fromEventCode,
  fromEventName,
  fromPhenomenon,
  hasVtec,
  KIND_PREFIXES,
  NAME_ALIASES,
  PHENOMENA,
  resolveKind,
  SIGNIFICANCE,
  STAGE_WORDS,
  type EventCode,
  type Hazard,
  type KindFacts,
  type ResolvedKind,
  VTEC_KIND_PREFIXES,
} from "./kinds.ts";
export {
  containingCodes,
  countyUgcOfSame,
  FIRE_ZONE_PHENOMENA,
  isSameCode,
  isUgcCode,
  parseSameLocation,
  sameOfCountyUgc,
  stateCode,
  stateOfCode,
  stateOfSame,
  stateOfUgc,
  type SameLocation,
  ugcRegionCodes,
} from "./codes.ts";
export { isKeepalive, KEEPALIVE_AWIPS_ID, KEEPALIVE_MAX_AGE_MS, keepaliveCheck } from "./keepalive.ts";
export { NWS_API_SOURCE, NWS_ORIGIN, nwsEvent, US_COVERAGE, vtecOffice } from "./nws.ts";
export { statesOf } from "./watch.ts";
export { WEA_EVENT_CODES, WEA_PARAMETER } from "./wea.ts";
export {
  CLOSING_ACTIONS,
  formatVtec,
  formatVtecTime,
  mainVtec,
  NO_TIME,
  parseVtec,
  vtecEventKey,
  vtecKey,
  vtecTime,
  vtecYear,
  type Vtec,
  type VtecClass,
  type VtecEvent,
} from "./vtec.ts";
