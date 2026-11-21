/**
 * The expectation of the NWWS-OI source: NWWS-OI carries each CAP message of the NWS that the NWS API gives.
 *
 * The NWS sends each CAP message to the room of NWWS-OI and to the service of the NWS API. The two copies have the
 * sender, the CAP identifier and the sent time of the message. The core joins them in one incident by the key of the
 * CAP message (`capMessageKey`), also with no VTEC. Then it finds the copy at the same sent time.
 */

import type { Expectation } from "@mark1russell7/alerts";
import { NWS_API_SOURCE } from "@mark1russell7/alerts-format-nws";
import { SOURCE_ID } from "./map.ts";

/**
 * The expectation: each actual report of the NWS API source has a copy in NWWS-OI. The runtime does not use it yet.
 * The measure of the copies over the log of a runtime gives the rate of the copies first. Then the runtime uses it.
 */
export const COPY_EXPECTATION: Expectation = {
  id: "nws-api.nwws",
  from: NWS_API_SOURCE,
  to: SOURCE_ID,
  when: { statuses: ["actual"] },
};
