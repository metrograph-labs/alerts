/**
 * The descriptor of the weather radio source: the facts that the core uses for the schedule, the health and the
 * coverage.
 */

import type { Area, RegionCode, SourceDescriptor } from "@mark1russell7/alerts";
import { KIND_PREFIXES } from "@mark1russell7/alerts-format-nws";
import { ORIGIN_OF, SOURCE_ID } from "./map.ts";

/**
 * This function gives the descriptor of the source for one transmitter. The coverage is the list of the counties that
 * the transmitter serves, as SAME codes. The list is input data of the owner, because each receiver hears other
 * transmitters.
 *
 * The source needs no internet and no provider. It needs the transmitter (`rf:nwr`), the receiver and the power.
 * Thus no fault of a network stops it.
 */
export function nwrDescriptor(coverage: readonly RegionCode[]): SourceDescriptor {
  return {
    id: SOURCE_ID,
    title: "NOAA Weather Radio: the SAME headers of a transmitter, from a receiver of this machine",
    origins: [...new Set(Object.values(ORIGIN_OF))],
    dependsOn: ["rf:nwr"],
    uses: ["receiver", "power"],
    kinds: KIND_PREFIXES,
    coverage: coverage.map((code): Area => ({ type: "code", ...code })),
    transport: "radio",
    // A fetch reads the feed of the decoder, so a short interval costs no request.
    interval: 15_000,
    slowAfter: 5_000,
    auth: "none",
    canary: "Each transmitter sends a weekly test. The check passes when the newest test is at most 8 days old.",
  };
}
