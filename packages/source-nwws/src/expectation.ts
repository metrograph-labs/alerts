/**
 * The expectation of the NWWS-OI source: NWWS-OI carries each CAP message of the NWS that the NWS API gives.
 *
 * The NWS sends each CAP message to the room of NWWS-OI and to the service of the NWS API. The two copies have the
 * sender, the CAP identifier and the sent time of the message. The core joins them in one incident by the key of the
 * CAP message (`capMessageKey`), also with no VTEC. Then it finds the copy at the same sent time.
 */

import { CAP_MESSAGE_SYSTEM, type Expectation } from "@mark1russell7/alerts";
import { NWS_API_SOURCE } from "@mark1russell7/alerts-format-nws";
import { SOURCE_ID } from "./map.ts";

/**
 * The expectation: each actual report of the NWS API source with the key of its CAP message has a copy in NWWS-OI.
 * A report of an older map has no such key, so it is not a check (AL-8).
 *
 * The measure of a live log of 24 hours found the copy of each message outside the gaps of the stream.
 * In a gap, the stream loses the products, so a miss there is a true miss.
 */
export const COPY_EXPECTATION: Expectation = {
  id: "nws-api.nwws",
  from: NWS_API_SOURCE,
  to: SOURCE_ID,
  when: { statuses: ["actual"], correlation: [CAP_MESSAGE_SYSTEM] },
};
