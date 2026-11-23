/**
 * The fetch of the GDELT source. GDELT adds one event file each 15 minutes, and the file `lastupdate.txt` names the
 * newest. Each fetch reads `lastupdate.txt`, then each new event file, at most `MAX_FILES_PER_FETCH`. The fetch sends
 * no place and no query. It filters the events on the computer of the user, with the places of the watch.
 *
 * A place gives its position to this source only when it shares the position with the source. A place with no position
 * gets no event: the event files have no code of a region that the matcher reads (AL-142).
 */

import { createHash } from "node:crypto";

import { matchPlaces, observationId, type FetchOutcome, type FetchSignal, type Instant, type Observation, type Watch, type WatchedPlace } from "@mark1russell7/alerts";
import { createRequester } from "@mark1russell7/alerts-fetch";
import { readZipEntries, type ArchiveLimits } from "@mark1russell7/files/archive";
import { isRecord } from "@mark1russell7/optional/read";
import type { Pace, Transport } from "polite-crawler/api";

import { eventAreas, SOURCE_ID } from "./map.ts";
import { addedTime, eventBody, eventOf, keepEvent, type GdeltEvent } from "./row.ts";

/** The base URL of the files of GDELT. */
export const GDELT_BASE_URL = "https://data.gdeltproject.org";

/** The path of the file that names the newest files of GDELT 2.0. */
export const LAST_UPDATE_PATH = "/gdeltv2/lastupdate.txt";

/** The time between two event files of GDELT: 15 minutes. */
export const FILE_STEP_MS = 900_000;

/**
 * The most event files of one fetch. After a gap, the fetch reads the newest 4 files: one hour of events. An older
 * file is lost, and the fetch tells it: the outcome is not complete.
 */
export const MAX_FILES_PER_FETCH = 4;

/** The longest time of one request, in milliseconds. */
export const GDELT_TIMEOUT_MS = 30_000;

/** The limits of the archive of an event file. A real file of 2026-11-23 was 65 KB compressed and 400 KB of text. */
export const EVENT_ARCHIVE_LIMITS: ArchiveLimits = { entryBytes: 64 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, entries: 4 };

/** The content type of each observation. */
export const BODY_TYPE = "application/json";

/** The options of the fetch. */
export interface GdeltFetchOptions {
  /** The pace of polite-crawler: the host scheduler and the clock. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /** The `User-Agent` header. The instance gives it from its settings. */
  readonly userAgent: string;
  /** The base URL. The default is `GDELT_BASE_URL`. A test gives a different URL. */
  readonly baseUrl?: string;
  /** The shortest time between two requests to the host, in milliseconds. The default is 1000. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is `GDELT_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** The input of one fetch. */
export interface GdeltFetchInput {
  readonly watch: Watch;
}

/** The newest event file, as `lastupdate.txt` names it. */
export interface LastUpdate {
  /** The time of the file, `YYYYMMDDHHMMSS` in UTC. */
  readonly stamp: string;
  /** The size of the archive in bytes. */
  readonly size: number;
  /** The MD5 digest of the archive, in lowercase hexadecimal. */
  readonly md5: string;
}

/** The events of one event file. */
export interface EventFile {
  /** The count of the lines of the file. */
  readonly lines: number;
  /** The count of the lines with 61 fields. */
  readonly parsed: number;
  /** The count of the events of `keepEvent`: the protests and the fights at the point of a city, in the whole world. */
  readonly reported: number;
  /** The bodies of the events of `keepEvent` that are also near a watched place. */
  readonly bodies: readonly string[];
}

/** The pattern of the line of the event file in `lastupdate.txt`: the size, the MD5 digest and the URL. */
const EXPORT_LINE = /^(\d+)\s+([0-9a-f]{32})\s+\S*\/gdeltv2\/(\d{14})\.export\.CSV\.zip$/i;

/** This function reads the line of the newest event file in `lastupdate.txt`, or gives `undefined`. */
export function readLastUpdate(text: string): LastUpdate | undefined {
  for (const line of text.split("\n")) {
    const match = EXPORT_LINE.exec(line.trim());
    if (match !== null && addedTime(match[3]!) !== undefined) return { stamp: match[3]!, size: Number(match[1]), md5: match[2]!.toLowerCase() };
  }
  return undefined;
}

/** This function gives the path of the event file of a time `YYYYMMDDHHMMSS`. */
export function eventFilePath(stamp: string): string {
  return `/gdeltv2/${stamp}.export.CSV.zip`;
}

/** This function gives the time `YYYYMMDDHHMMSS` of an instant in UTC. */
export function stampOf(time: Instant): string {
  return new Date(time).toISOString().replace(/\D/g, "").slice(0, 14);
}

/**
 * This function gives the times of the files to read, from the oldest. These are the files after `last`, up to
 * `newest`, at most `MAX_FILES_PER_FETCH`. With no `last`, it gives only `newest`. The field `dropped` counts the
 * files that it leaves out.
 */
export function stampsToRead(last: string | undefined, newest: string): { readonly stamps: readonly string[]; readonly dropped: number } {
  const end = addedTime(newest);
  const start = last === undefined ? undefined : addedTime(last);
  if (end === undefined) return { stamps: [], dropped: 0 };
  if (start === undefined) return { stamps: [newest], dropped: 0 };
  if (start >= end) return { stamps: [], dropped: 0 };
  const count = Math.max(1, Math.floor((end - start) / FILE_STEP_MS));
  const kept = Math.min(count, MAX_FILES_PER_FETCH);
  const stamps = Array.from({ length: kept }, (_, index) => stampOf(end - (kept - 1 - index) * FILE_STEP_MS));
  return { stamps, dropped: count - kept };
}

/**
 * This function reads the events of one archive of an event file. It gives the text of the fault when the archive is
 * not one event file. With `expected` of the same time, it also examines the size and the MD5 digest. The function
 * `near` chooses the events of `keepEvent` that give a body. The default chooses each. The function does not throw.
 */
export function readEventFile(bytes: Uint8Array, stamp: string, expected?: LastUpdate, near: (event: GdeltEvent) => boolean = () => true): EventFile | string {
  if (expected !== undefined && expected.stamp === stamp) {
    if (bytes.byteLength !== expected.size) return `the archive has ${bytes.byteLength} bytes, and lastupdate.txt gives ${expected.size}`;
    const md5 = createHash("md5").update(bytes).digest("hex");
    if (md5 !== expected.md5) return "the MD5 digest of the archive is not the digest of lastupdate.txt";
  }
  const archive = readZipEntries(bytes, EVENT_ARCHIVE_LIMITS);
  if (!archive.ok) return `the archive is not valid (${archive.error.kind}): ${archive.error.message}`;
  const name = `${stamp}.export.CSV`.toLowerCase();
  const entry = archive.entries.find((candidate) => candidate.name.toLowerCase() === name);
  if (entry === undefined) return `the archive has no file ${stamp}.export.CSV`;
  const lines = new TextDecoder("utf-8").decode(entry.bytes).split("\n").filter((line) => line.trim() !== "");
  const events = lines.map(eventOf);
  const bodies: string[] = [];
  let parsed = 0;
  let reported = 0;
  for (const event of events) {
    if (event === undefined) continue;
    parsed += 1;
    if (!keepEvent(event)) continue;
    reported += 1;
    if (near(event)) bodies.push(eventBody(event));
  }
  return { lines: lines.length, parsed, reported, bodies };
}

/** This function gives the body of the head of a fetch: the newest file that the fetch read, and its counts. */
export function headBody(stamp: string, file: EventFile): string {
  return JSON.stringify({ file: stamp, lines: file.lines, parsed: file.parsed, reported: file.reported, near: file.bodies.length });
}

/**
 * This function gives the filter of the events for the places of a watch. An event passes when its area reaches a
 * place with a position, within the buffer of the place. The function `matchPlaces` of the core decides.
 */
export function nearPlaces(places: readonly WatchedPlace[]): (event: GdeltEvent) => boolean {
  const positioned = places.filter((place) => place.at !== undefined);
  if (positioned.length === 0) return () => false;
  return (event) => matchPlaces({ areas: eventAreas(event.lat, event.lon) }, positioned).length > 0;
}

/** This function gives the time of the file of a head body, or `undefined` for a body that is not a head. */
export function headTime(body: string): Instant | undefined {
  try {
    const fields: unknown = JSON.parse(body);
    return isRecord(fields) && typeof fields["file"] === "string" ? addedTime(fields["file"]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * This function makes the fetch function of the GDELT source. The fetch does not throw for a failure of the source:
 * it gives `{ ok: false }`. It throws only when the signal of the caller aborts.
 *
 * Each fetch gives one observation for each kept event of each new file, and one head: the newest file that it read.
 * A fetch with no new file gives the head again. The time of the data is the time of the newest file that it read.
 *
 * GDELT sometimes names a file in `lastupdate.txt` some minutes before the file is there. A missing newest file stops
 * the fetch, and the next fetch reads it again. A missing older file is lost, and the outcome is not complete.
 */
export function createGdeltFetch(options: GdeltFetchOptions): (input: GdeltFetchInput, signal?: FetchSignal) => Promise<FetchOutcome> {
  const requester = createRequester({
    source: SOURCE_ID,
    pace: options.pace,
    transport: options.transport,
    baseUrl: options.baseUrl ?? GDELT_BASE_URL,
    headers: { accept: "*/*", "user-agent": options.userAgent },
    timeoutMs: options.timeoutMs ?? GDELT_TIMEOUT_MS,
    ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
  });
  const now = options.pace.now;
  /** The time of the last file that the fetch read or passed. */
  let lastStamp: string | undefined;
  /** The head of the newest file that the fetch read, with its time. */
  let lastHead: { readonly stamp: string; readonly body: string } | undefined;

  const observe = (body: string, url: string, status: number, latency: number): Observation => ({
    id: observationId({ source: SOURCE_ID, contentType: BODY_TYPE, url, body }),
    source: SOURCE_ID,
    fetched: now(),
    contentType: BODY_TYPE,
    body,
    transport: { url, status, latency },
  });

  return async (input, signal) => {
    const near = nearPlaces(input.watch.places);
    const listed = await requester.get({ path: LAST_UPDATE_PATH, what: "the list of the newest files" }, signal);
    if (!listed.ok) return { ok: false, failure: listed.failure };
    const newest = readLastUpdate(listed.answer.reply.body);
    if (newest === undefined) return { ok: false, failure: { kind: "network", message: `lastupdate.txt names no event file: ${listed.url}` } };
    const { stamps, dropped } = stampsToRead(lastStamp, newest.stamp);
    const observations: Observation[] = [];
    let complete = dropped === 0;
    let read = 0;
    for (const stamp of stamps) {
      const path = eventFilePath(stamp);
      const url = `${requester.baseUrl}${path}`;
      const requested = await requester.get({ path, what: "an event file", read: "bytes" }, signal);
      if (!requested.ok) {
        complete = false;
        // GDELT does not have each file. A missing older file is lost. A missing newest file comes some minutes later.
        if (stamp !== newest.stamp && requested.answer?.reply.status === 404) {
          lastStamp = stamp;
          continue;
        }
        if (read === 0 && lastHead === undefined) return { ok: false, failure: requested.failure };
        break;
      }
      const file = readEventFile(requested.answer.reply.bytes ?? new Uint8Array(), stamp, newest, near);
      if (typeof file === "string") {
        if (read === 0 && lastHead === undefined) return { ok: false, failure: { kind: "network", message: `${file}: ${url}` } };
        complete = false;
        break;
      }
      read += 1;
      for (const body of file.bodies) observations.push(observe(body, url, requested.answer.reply.status, requested.latency));
      lastStamp = stamp;
      lastHead = { stamp, body: headBody(stamp, file) };
    }
    if (lastHead === undefined) return { ok: false, failure: { kind: "network", message: `no event file was read: ${listed.url}` } };
    observations.push(observe(lastHead.body, `${requester.baseUrl}${eventFilePath(lastHead.stamp)}`, 200, listed.latency));
    const asOf = addedTime(lastHead.stamp);
    return { ok: true, observations, complete, ...(asOf === undefined ? {} : { asOf }) };
  };
}
