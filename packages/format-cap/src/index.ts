/**
 * The reader of CAP 1.2 messages (the Common Alerting Protocol of OASIS) for the sources of the alert
 * system: FEMA IPAWS, the NWS, NWWS-OI and other CAP feeds.
 *
 * `readCap` gives the elements of a message as texts. `splitAlerts` splits a feed into its alerts, and
 * `splitFeed` also finds a cut feed.
 *
 * `readFeed` reads a feed in RSS 2.0 or Atom 1.0: the id, the title, the link, the time and the text of each entry.
 * `readCapIndex` reads the index of a CAP feed with it: the link of each CAP message.
 * `chooseInfo` chooses one info block. `capPolygon` and `capCircle` give the areas in the order of the
 * core. The package also has the readers of the CAP values. The check of XML signatures comes later.
 *
 * `capReports` maps one message to one report for each info block in the chosen language. `codedKind` reads the kind of
 * a block from the event codes of the OASIS list and the awareness types of MeteoAlarm.
 */

export { capCircle, capPolygon, capPosition } from "./geometry.ts";
export { ATOM_NAMESPACE, readFeed, type FeedEntry, type FeedRead } from "./feed.ts";
export { parseXml, xmlFault, type XmlParse } from "./well-formed.ts";
export { CAP_MEDIA_TYPE, readCapIndex, type CapIndexEntry, type CapIndexRead } from "./feed-index.ts";
export { chooseInfo, DEFAULT_LANGUAGES, type ChosenInfo } from "./info.ts";
export { codedKind, meteoalarmTypeName, METEOALARM_KINDS, METEOALARM_TYPE, OET_KINDS, OET_VERSION, type CodedKind, type CodedKinds } from "./kinds.ts";
export {
  CAP_NAMESPACES,
  readCap,
  type CapAlert,
  type CapArea,
  type CapInfo,
  type CapPair,
  type CapRead,
  type CapReference,
  type CapResource,
  type CapVersion,
} from "./read.ts";
export { capReports, type CapReportOptions } from "./report.ts";
export { splitAlerts, splitFeed, type CapFeed } from "./split.ts";
export {
  CAP_CATEGORIES,
  CAP_CERTAINTY,
  CAP_CERTAINTY_ALIASES,
  CAP_CERTAINTY_BANDS,
  CAP_CERTAINTY_SOURCE,
  CAP_NOT_ALERTS,
  CAP_OPERATIONS,
  CAP_RESPONSES,
  CAP_SEVERITY,
  CAP_STATUS,
  CAP_URGENCY,
  capCertainty,
  capList,
  capTime,
  capValue,
  type CertaintyBand,
} from "./values.ts";
