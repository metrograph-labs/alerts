/**
 * The fetch of the weather radio source. It reads the new lines of the feed of the decoder, and gives one observation
 * for each complete header. It sends no request.
 */

import { observationId, type FetchOutcome, type Instant, type Observation } from "@mark1russell7/alerts";
import { createHeaderAssembler, type HeardHeader } from "./assembler.ts";
import { testIssuedAt } from "./check.ts";
import type { DecoderFeed } from "./feed.ts";
import { readDecoderLine } from "./lines.ts";
import { CONTENT_TYPE, SOURCE_ID } from "./map.ts";

/** The options of the fetch. */
export interface NwrFetchOptions {
  /** The feed of the lines of the decoder. */
  readonly feed: DecoderFeed;
  /** The clock of the runtime. */
  readonly clock: { now(): Instant };
}

/** This function gives the observation of one header. */
export function observationOf(header: HeardHeader): Observation {
  return {
    id: observationId({ source: SOURCE_ID, contentType: CONTENT_TYPE, body: header.text }),
    source: SOURCE_ID,
    fetched: header.at,
    contentType: CONTENT_TYPE,
    body: header.text,
    // The radio has no request. The receipt of a copy is the end of its transport.
    transport: { latency: 0 },
  };
}

/**
 * This function makes the fetch of the source. A fetch gives the headers of the new lines of the feed. It also gives
 * the newest test again, with the time of the fetch, for the canary check. When the decoder is stopped and the feed
 * has no new header, the fetch fails.
 */
export function createNwrFetch(options: NwrFetchOptions): () => Promise<FetchOutcome> {
  const assembler = createHeaderAssembler();
  let position = 0;
  let test: Observation | undefined;
  return () => {
    const now = options.clock.now();
    const read = options.feed.read(position);
    position = read.last;
    const heard = read.lines.flatMap((line) => {
      const decoded = readDecoderLine(line.text);
      return decoded === undefined ? [] : assembler.push(decoded, line.at);
    });
    const observations = [...heard, ...assembler.close(now)].map(observationOf);
    if (options.feed.started() === undefined && observations.length === 0) {
      return Promise.resolve({ ok: false, failure: { kind: "network", message: "the decoder of the radio does not run" } });
    }
    for (const observation of observations) if (testIssuedAt(observation) !== undefined) test = observation;
    const again = test !== undefined && !observations.some((observation) => observation.id === test?.id) ? [{ ...test, fetched: now }] : [];
    return Promise.resolve({ ok: true, observations: [...observations, ...again], complete: !read.lost });
  };
}
