/**
 * The fetch function of the NDW source. It reads the file of the current road situations of NDW
 * (`opendata.ndw.nu/actueel_beeld.xml.gz`) through polite-crawler. The file is a DATEX II situation publication, version
 * 3, in gzip. The request holds no place of the watch.
 *
 * The fetch counts the valid records of each group at the time of the publication, and it gives the counts as one
 * observation. The id of an observation has the URL of the file and the counts. Thus two fetches of one publication give
 * one observation, and the runtime keeps it one time. The log keeps the counts, not the file of approximately 3.5 MB.
 */

import { gunzipSync } from "node:zlib";
import { observationId, type FetchOutcome, type FetchSignal, type Instant, type Observation, type Watch } from "@mark1russell7/alerts";
import { createRequester } from "@mark1russell7/alerts-fetch";
import { isValidAt, readSituationPublication, RECORD_GROUPS, recordGroup, type RecordGroup, type SituationPublication } from "@mark1russell7/alerts-format-datex";
import { errorMessage } from "@mark1russell7/text";
import type { Condition, Pace, Transport } from "polite-crawler/api";

import { countBody, SOURCE_ID, type GroupCounts } from "./map.ts";

/** The base URL of the open data of NDW. */
export const NDW_BASE_URL = "https://opendata.ndw.nu";

/** The path of the file of the current road situations. */
export const SITUATIONS_PATH = "/actueel_beeld.xml.gz";

/** The content type of the body of each observation. */
export const BODY_TYPE = "application/json";

/** The shortest time between two requests to the host. NDW publishes no limit. */
export const MIN_INTERVAL_MS = 60_000;

/** The longest time of one request: the file is approximately 300 kB in gzip. */
export const TIMEOUT_MS = 30_000;

/**
 * The largest size of the file after gunzip. A read on 2026-11-25 gave 3.5 MB. A larger file is not the file of the
 * current situations, and the limit keeps a gzip bomb out of the memory of the runtime.
 */
export const MAX_XML_BYTES: number = 64 * 1024 * 1024;

/** The options of the fetch function of the NDW source. */
export interface NdwFetchOptions {
  /** The pace of polite-crawler: the host scheduler and the clock. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /** The `User-Agent` header. The instance gives it from its settings. */
  readonly userAgent: string;
  /** The base URL. The default is `NDW_BASE_URL`. A test gives a different URL. The fetch removes the slashes at its end. */
  readonly baseUrl?: string;
  /** The shortest time between two requests to the host, in milliseconds. The default is `MIN_INTERVAL_MS`. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is `TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** The input of the fetch function, as the contract gives it. */
export interface NdwFetchInput {
  readonly watch: Watch;
}

/** The counts of one publication. */
export interface PublicationCounts {
  readonly published: Instant;
  readonly country: string;
  readonly groups: GroupCounts;
  readonly unreal: number;
  readonly faults: number;
}

/** This function counts the records of each group that are valid at the time of the publication. The function is pure. */
export function countsOf(publication: SituationPublication): PublicationCounts {
  const groups = Object.fromEntries(RECORD_GROUPS.map((group) => [group, 0])) as Record<RecordGroup, number>;
  for (const record of publication.records) if (isValidAt(record, publication.published)) groups[recordGroup(record)] += 1;
  return { published: publication.published, country: publication.country ?? "", groups, unreal: publication.unreal, faults: publication.faults.length };
}

/** The result of `readFile`: the counts of the file, or the reason of a file that is not a situation publication. */
export type FileRead = { readonly ok: true; readonly counts: PublicationCounts } | { readonly ok: false; readonly reason: string };

/**
 * This function reads the bytes of the file: gzip, or XML when the transport removed the gzip. It does not throw. A gzip
 * that is cut, a text of more than `MAX_XML_BYTES` and a text that is not a situation publication give a reason.
 */
export function readFile(bytes: Uint8Array): FileRead {
  let xml: string;
  try {
    const zipped = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
    if (!zipped && bytes.length > MAX_XML_BYTES) return { ok: false, reason: `the file has more than ${String(MAX_XML_BYTES)} bytes` };
    xml = Buffer.from(zipped ? gunzipSync(bytes, { maxOutputLength: MAX_XML_BYTES }) : bytes).toString("utf8");
  } catch (error) {
    return { ok: false, reason: `the gzip of the file does not read: ${errorMessage(error)}` };
  }
  const read = readSituationPublication(xml);
  return read.ok ? { ok: true, counts: countsOf(read.publication) } : { ok: false, reason: read.reason };
}

/**
 * This function makes the fetch function of the NDW source. The fetch does not throw for a failure of the source: it gives
 * `{ ok: false }`. It throws only when the signal of the caller aborts.
 *
 * Each fetch is one conditional GET (`poll` of polite-crawler) of the file, with the `ETag` or `Last-Modified` of the last
 * full answer. A 304 answer has no body. Then the fetch gives the counts of the last full answer again, with the same id.
 */
export function createNdwFetch(options: NdwFetchOptions): (input: NdwFetchInput, signal?: FetchSignal) => Promise<FetchOutcome> {
  const requester = createRequester({
    source: SOURCE_ID,
    pace: options.pace,
    transport: options.transport,
    baseUrl: options.baseUrl ?? NDW_BASE_URL,
    headers: { accept: "application/gzip, application/xml;q=0.9", "user-agent": options.userAgent },
    minIntervalMs: options.minIntervalMs ?? MIN_INTERVAL_MS,
    timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
  });
  const now = options.pace.now;
  const file = `${requester.baseUrl}${SITUATIONS_PATH}`;
  const conditions = new Map<string, Condition>();
  let last: { readonly url: string; readonly body: string; readonly published: Instant } | undefined;

  const outcomeOf = (url: string, status: number, body: string, published: Instant, latency: number): FetchOutcome => {
    const observation: Observation = {
      id: observationId({ source: SOURCE_ID, contentType: BODY_TYPE, url: file, body }),
      source: SOURCE_ID,
      fetched: now(),
      contentType: BODY_TYPE,
      body,
      transport: { url, status, latency },
    };
    // The time of the publication is the time of the data: NDW writes the file each minute.
    return { ok: true, observations: [observation], complete: true, asOf: published };
  };

  return async (_input, signal) => {
    const requested = await requester.get({ path: SITUATIONS_PATH, what: "the current road situations", conditions, read: "bytes" }, signal);
    if (!requested.ok) return { ok: false, failure: requested.failure };
    const { url, answer, latency } = requested;
    if (answer.classified.outcome === "not-modified") {
      if (last === undefined || last.url !== url) {
        // A 304 with no earlier full answer: the next request sends no condition
        conditions.delete(url);
        return { ok: false, failure: { kind: "network", message: `a 304 answer with no earlier full answer: ${file}` } };
      }
      return outcomeOf(url, 304, last.body, last.published, latency);
    }
    const bytes = answer.reply.bytes;
    const read = bytes === undefined ? undefined : readFile(bytes);
    if (read === undefined || !read.ok) {
      // poll keeps the condition of each 2xx answer. A file that does not read must not be the base of a later 304.
      conditions.delete(url);
      last = undefined;
      return { ok: false, failure: { kind: "network", message: `the answer is not a DATEX II situation publication: ${read?.reason ?? "no body"}: ${file}` } };
    }
    const { counts } = read;
    // The body has the country of the file: the map refuses a country that is not the Netherlands.
    const body = countBody(counts.published, counts.country, counts.groups, counts.unreal, counts.faults);
    last = { url, body, published: counts.published };
    return outcomeOf(url, answer.reply.status, body, counts.published, latency);
  };
}
