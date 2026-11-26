/** The constants, the options and the input of the fetch functions of the OSV providers. */

import { observationId, type Cursor, type FetchOutcome, type FetchSignal, type Instant, type Observation, type SourceId, type Watch } from "@mark1russell7/alerts";
import type { Pace, Transport } from "polite-crawler/api";

import { DAY_MS } from "./providers.ts";

/** The most records that one fetch reads. With one second between two requests to a host, a fetch ends in the limit of 60 seconds. */
export const RECORDS_PER_FETCH = 16;

/** The time before the fetch from which a fetch with no cursor reads the changes: 1 day. */
export const BACKFILL_MS: number = DAY_MS;

/** The longest time of one request when the source gives none, in milliseconds. */
export const OSV_TIMEOUT_MS = 30_000;

/** The content type of each observation. */
export const OSV_CONTENT_TYPE = "application/json";

/** The options of the fetch function of an OSV provider. */
export interface OsvFetchOptions {
  /** The pace of polite-crawler: the host scheduler and the clock. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /** The `User-Agent` header. The instance gives it from its settings. */
  readonly userAgent: string;
  /** The origin of the exports or of the GitHub API. The default comes from the provider. A test gives a different origin. */
  readonly baseUrl?: string;
  /** The origin of the raw files of a GitHub repository. The default comes from the provider. */
  readonly rawUrl?: string;
  /** The shortest time between two requests to a host, in milliseconds. The default is 1000. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is `OSV_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** The input of the fetch function, as the contract gives it. */
export interface OsvFetchInput {
  readonly watch: Watch;
  readonly cursor?: Cursor;
}

/** The fetch function of an OSV provider. */
export type OsvFetch = (input: OsvFetchInput, signal?: FetchSignal) => Promise<FetchOutcome>;

/** This function gives the function that makes the observations of a source. */
export function observer(source: SourceId): (url: string, body: unknown, status: number, latency: number, fetched: Instant) => Observation {
  return (url, body, status, latency, fetched) => {
    const text = JSON.stringify(body);
    return { id: observationId({ source, contentType: OSV_CONTENT_TYPE, url, body: text }), source, fetched, contentType: OSV_CONTENT_TYPE, body: text, transport: { url, status, latency } };
  };
}
