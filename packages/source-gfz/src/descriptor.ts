/**
 * The descriptors of the GFZ sources: the facts that the core uses for the schedule, the health and the coverage.
 */

import type { SourceDescriptor } from "@mark1russell7/alerts";

import { GFZ_KINDS, GFZ_ORIGIN, HP30_INDEX, HP60_INDEX, KP_INDEX, SOURCE_ID, type GfzIndex } from "./map.ts";

/**
 * The descriptor of the GFZ source of Kp. A geomagnetic storm has effects on the whole Earth, so the coverage is
 * global. GFZ calculates Kp from 13 observatories, apart from the NOAA, so the source is a second origin of the storms
 * of the SWPC. The site answers with no CDN. The source is a snapshot, and the canary is the age of the newest interval.
 */
export const GFZ_DESCRIPTOR: SourceDescriptor = {
  id: SOURCE_ID,
  title: "GFZ: the planetary index Kp of each 3 hours, and the geomagnetic storms of the NOAA scale G",
  origins: [GFZ_ORIGIN],
  dependsOn: ["provider:gfz"],
  uses: ["internet", "dns", "power"],
  kinds: GFZ_KINDS,
  coverage: "global",
  transport: "poll",
  interval: KP_INDEX.pollMs,
  slowAfter: 10_000,
  auth: "none",
  listing: "snapshot",
  canary: "The series has a value for each 3-hour interval. The check passes when the newest interval started at most 6 hours before the fetch.",
};

/** This function gives the descriptor of the source of an index. The facts are those of `GFZ_DESCRIPTOR`, with the interval of the index. */
export function descriptorOf(index: GfzIndex): SourceDescriptor {
  if (index === KP_INDEX) return GFZ_DESCRIPTOR;
  const minutes = index.intervalMs / 60_000;
  return {
    ...GFZ_DESCRIPTOR,
    id: index.source,
    title: `GFZ: the index ${index.name} of each ${minutes} minutes, and the geomagnetic storms at the levels of the NOAA scale G`,
    interval: index.pollMs,
    canary: `The series has a value for each interval of ${minutes} minutes. The check passes when the newest interval started at most ${index.newestMaxAgeMs / 3_600_000} hours before the fetch.`,
  };
}

/** The descriptor of the GFZ source of Hp30. */
export const HP30_DESCRIPTOR: SourceDescriptor = descriptorOf(HP30_INDEX);

/** The descriptor of the GFZ source of Hp60. */
export const HP60_DESCRIPTOR: SourceDescriptor = descriptorOf(HP60_INDEX);
