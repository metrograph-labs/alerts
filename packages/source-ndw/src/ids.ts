/** The ids and the fixed facts of the NDW source. */

import type { SourceId } from "@mark1russell7/alerts";

/** The id of this source. */
export const SOURCE_ID = "ndw" as SourceId;

/** The origin of the records: NDW (Nationaal Dataportaal Wegverkeer), which collects the road data of the road authorities. */
export const NDW_ORIGIN = "ndw";

/** The license of the open data of NDW: CC0 1.0. NDW asks for no credit. */
export const NDW_LICENSE = "CC0 1.0";

/** The country of the publication, as the field `country` of the publication creator gives it. */
export const NDW_COUNTRY = "nl";
