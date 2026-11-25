/**
 * The source adapter of the alert system for NOAA Weather Radio. A receiver of this machine hears a transmitter, and a
 * SAME decoder writes the headers that it hears. The source reads the lines of the decoder, so it needs no internet.
 * The package gives the procedures of the source contract of `@mark1russell7/alerts`.
 *
 * The process of the receiver and the decoder is not part of this package yet (AL-185). A host fills the feed.
 */

import type { RegionCode, SourceProcedures } from "@mark1russell7/alerts";
import { checkCanary } from "./check.ts";
import { nwrDescriptor } from "./descriptor.ts";
import type { DecoderFeed } from "./feed.ts";
import { createNwrFetch } from "./fetch.ts";
import { mapObservation } from "./map.ts";

export { createHeaderAssembler, GROUP_GAP_MS, type HeaderAssembler, type HeardHeader } from "./assembler.ts";
export { type CanaryDecoder, checkCanary, TEST_EVENTS, TEST_MAX_AGE_MS, testIssuedAt } from "./check.ts";
export { nwrDescriptor } from "./descriptor.ts";
export { createLineFeed, type DecoderFeed, type FeedLine, type FeedRead, type LineFeed } from "./feed.ts";
export { createNwrFetch, type NwrFetchOptions, observationOf } from "./fetch.ts";
export { type DecoderLine, readDecoderLine } from "./lines.ts";
export { areasOf, CONTENT_TYPE, mapObservation, ORIGIN_OF, SOURCE_ID, statusOf } from "./map.ts";

/** The options of the source. */
export interface NwrSourceOptions {
  /** The feed of the lines of the decoder. */
  readonly feed: DecoderFeed;
  /** The clock of the runtime. */
  readonly clock: { now(): number };
  /** The SAME codes of the counties that the transmitter serves. */
  readonly coverage: readonly RegionCode[];
}

/** This function makes the procedures of the weather radio source: `describe`, `fetch`, `map` and `check`. */
export function createNwrSource(options: NwrSourceOptions): SourceProcedures {
  const descriptor = nwrDescriptor(options.coverage);
  const fetch = createNwrFetch(options);
  return {
    describe: () => descriptor,
    fetch: () => fetch(),
    map: ({ observation }) => mapObservation(observation),
    check: ({ observations }) => {
      const started = options.feed.started();
      return checkCanary(observations, started === undefined ? undefined : { started, now: options.clock.now() });
    },
  };
}
