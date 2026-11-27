/**
 * The descriptor of the CISA KEV source. The file has an `ETag`, so a poll with no change gets a 304 answer with no body.
 */

import type { SourceDescriptor } from "@mark1russell7/alerts";

import { KEV_KINDS, KEV_ORIGIN, SOURCE_ID } from "./map.ts";

/** The descriptor of the CISA KEV source. */
export const KEV_DESCRIPTOR: SourceDescriptor = {
  id: SOURCE_ID,
  title: "CISA KEV: the catalog of known exploited vulnerabilities, with a due date for each flaw",
  origins: [KEV_ORIGIN],
  dependsOn: ["provider:cisa", "cdn:akamai"],
  uses: ["internet", "dns", "power"],
  kinds: KEV_KINDS,
  coverage: "global",
  transport: "poll",
  interval: 900_000,
  slowAfter: 10_000,
  auth: "none",
  listing: "snapshot",
  canary: "CISA releases the catalog on most work days. The check passes when the release is at most 27 days before the fetch. The limit comes from the measured gaps between the releases.",
};
