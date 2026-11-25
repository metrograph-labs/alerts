/**
 * The reader of DATEX II situation publications, version 3, for the alert system. DATEX II is the European standard for
 * the exchange of road data. The package names no publisher and no country: a source adapter gives the text.
 */

export {
  datexTime,
  isValidAt,
  readSituationPublication,
  RECORD_GROUPS,
  recordGroup,
  VALIDITY_STATUSES,
  type RecordGroup,
  type SituationPublication,
  type SituationRead,
  type SituationRecord,
  type Time,
  type ValidityStatus,
} from "./situation.ts";
