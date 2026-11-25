/**
 * The fetch of the data exports of OSV.dev. For each ecosystem of the provider, the fetch reads the first part of the
 * change list `<ecosystem>/modified_id.csv` with a `Range` header and a conditional GET. The full list of npm had 8.8 MB on
 * 2026-11-25, and the first 64 KiB held the changes of one day. The fetch then reads the file `<ecosystem>/<id>.json` of
 * each changed record with a prefix of the provider, the oldest change first.
 *
 * - The cursor holds one position for each ecosystem. With no position, the fetch reads the changes of the last `BACKFILL_MS`.
 * - When the first part of a list does not reach the position, the fetch reads a larger part. When the larger part also
 *   does not reach it, the fetch passes the older changes, and the head tells of the gap.
 * - A record file that the bucket does not find (a 404 or a 410) is passed. Each other failure ends the fetch at that
 *   change, and the next fetch reads that change again.
 */

import type { FetchFailure, Observation } from "@mark1russell7/alerts";
import { createRequester, type Requester } from "@mark1russell7/alerts-fetch";
import { keptReplies, type Condition, type KeptReplies } from "polite-crawler/api";

import { fileBody, type HeadBody, type ListHead } from "./body.ts";
import { comparePositions, orderOfInstant, positionText, readChanges, readPosition, selectChanges, type Change, type ChangeList, type Position } from "./changes.ts";
import { BACKFILL_MS, observer, OSV_TIMEOUT_MS, RECORDS_PER_FETCH, type OsvFetch, type OsvFetchOptions } from "./options.ts";
import type { ExportsFeed, OsvProvider } from "./providers.ts";

/** The size of the first part of a change list that a fetch reads, in bytes. */
export const LIST_BYTES = 65_536;

/** The size of the larger part of a change list, in bytes. It holds the changes of some weeks. */
export const LARGE_LIST_BYTES = 1_048_576;

/**
 * One reader of the change lists. It holds a requester with one `Range` header and its conditions. It also keeps the last
 * full answer of each URL as compressed bytes (`keptReplies`), for the replay of a 304 answer.
 */
interface ListReader {
  readonly requester: Requester;
  readonly conditions: Map<string, Condition>;
  readonly last: KeptReplies<{ readonly cut: boolean }>;
}

/** The read text of a change list. */
type ListRead = { readonly ok: true; readonly url: string; readonly text: string; readonly cut: boolean; readonly status: number; readonly latency: number } | { readonly ok: false; readonly failure: FetchFailure };

/**
 * This function tells if a `Content-Range` header names a part that ends before the end of the file. A header that is
 * absent or does not parse gives true, because the body can then be a part.
 */
export function isCutRange(header: string | undefined): boolean {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header?.trim() ?? "");
  if (match === null) return true;
  return match[3] === "*" || Number(match[2]) + 1 < Number(match[3]);
}

/** This function gives the newest change of a list, or `undefined` for an empty list. */
function newestOf(list: ChangeList): Change | undefined {
  let newest: Change | undefined;
  for (const change of list.changes) if (newest === undefined || comparePositions(change, newest) > 0) newest = change;
  return newest;
}

/** This function makes the fetch function of a provider of the exports. */
export function createExportsFetch(provider: OsvProvider, feed: ExportsFeed, options: OsvFetchOptions): OsvFetch {
  const origin = new URL(options.baseUrl ?? feed.base).origin;
  const make = (bytes?: number): Requester =>
    createRequester({
      source: provider.id,
      pace: options.pace,
      transport: options.transport,
      baseUrl: origin,
      headers: { accept: bytes === undefined ? "application/json" : "text/csv, text/plain;q=0.9", "user-agent": options.userAgent, ...(bytes === undefined ? {} : { range: `bytes=0-${String(bytes - 1)}` }) },
      timeoutMs: options.timeoutMs ?? OSV_TIMEOUT_MS,
      ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
    });
  const readers: readonly ListReader[] = [LIST_BYTES, LARGE_LIST_BYTES].map((bytes) => ({ requester: make(bytes), conditions: new Map(), last: keptReplies<{ readonly cut: boolean }>() }));
  const files = make();
  const observation = observer(provider.id);
  const now = options.pace.now;

  const readList = async (reader: ListReader, ecosystem: string, signal: Parameters<OsvFetch>[1]): Promise<ListRead> => {
    const requested = await reader.requester.get({ path: `/${encodeURIComponent(ecosystem)}/modified_id.csv`, what: `the change list of ${ecosystem}`, conditions: reader.conditions }, signal);
    if (!requested.ok) return { ok: false, failure: requested.failure };
    const { url, answer, latency } = requested;
    if (answer.classified.outcome === "not-modified") {
      const last = await reader.last.get(url).catch(() => undefined);
      if (last === undefined) {
        // A 304 with no earlier full answer: the next request sends no condition.
        reader.conditions.delete(url);
        return { ok: false, failure: { kind: "network", message: `a 304 answer with no earlier full answer: ${url}` } };
      }
      return { ok: true, url, text: last.reply.body, cut: last.extra.cut, status: 304, latency };
    }
    const cut = answer.reply.status === 206 && isCutRange(answer.reply.headers["content-range"]);
    reader.last.keep(url, answer.reply, { cut });
    return { ok: true, url, text: answer.reply.body, cut, status: answer.reply.status, latency };
  };

  return async (input, signal) => {
    const backfill: Position = { order: orderOfInstant(now() - BACKFILL_MS), id: "" };
    const lists: ListHead[] = [];
    const pending: { readonly ecosystem: string; readonly change: Change }[] = [];
    const starts = new Map<string, Position>();
    const newest = new Map<string, Change>();
    let first: { readonly url: string; readonly status: number; readonly latency: number } | undefined;
    for (const ecosystem of feed.ecosystems) {
      const known = readPosition(input.cursor?.[ecosystem]);
      const start = known ?? backfill;
      let read: ListRead | undefined;
      let list: ChangeList | undefined;
      let selection: ReturnType<typeof selectChanges> | undefined;
      for (const reader of readers) {
        read = await readList(reader, ecosystem, signal);
        if (!read.ok) return { ok: false, failure: read.failure };
        list = readChanges(read.text, read.cut);
        selection = selectChanges(list, start, provider.prefixes, read.cut);
        if (selection.reached) break;
      }
      if (read === undefined || !read.ok || list === undefined || selection === undefined) continue;
      first ??= { url: read.url, status: read.status, latency: read.latency };
      // With no position, a list that does not reach the backfill time is no gap: the fetch reads no older change.
      const gap = !selection.reached && known !== undefined;
      const top = newestOf(list);
      starts.set(ecosystem, start);
      if (top !== undefined) newest.set(ecosystem, top);
      lists.push({ ecosystem, newest: top === undefined ? null : top.time, lines: list.changes.length, gap });
      for (const change of selection.fresh) pending.push({ ecosystem, change });
    }
    pending.sort((a, b) => comparePositions(a.change, b.change) || (a.ecosystem < b.ecosystem ? -1 : a.ecosystem > b.ecosystem ? 1 : 0));

    const observations: Observation[] = [];
    const reached = new Map<string, Position>();
    let done = 0;
    let stopped = false;
    for (const { ecosystem, change } of pending.slice(0, RECORDS_PER_FETCH)) {
      const file = await files.get({ path: `/${encodeURIComponent(ecosystem)}/${encodeURIComponent(change.id)}.json`, what: `the OSV record ${change.id}` }, signal);
      // Only a file that is not found is passed. A 403 or a 401 tells of a block of the host, not of one file.
      if (!file.ok && file.answer?.classified.outcome !== "not-found") {
        stopped = true;
        break;
      }
      if (file.ok) observations.push(observation(file.url, fileBody(file.answer.reply.body, file.url), file.answer.reply.status, file.latency, now()));
      reached.set(ecosystem, change);
      done += 1;
    }

    const cursor: Record<string, string> = { ...input.cursor };
    for (const [ecosystem, start] of starts) {
      const left = pending.slice(done).some((item) => item.ecosystem === ecosystem);
      const last = reached.get(ecosystem) ?? start;
      const top = newest.get(ecosystem);
      // A list with no change left to read moves to its newest line, so the next fetch reads only the later lines.
      const position = !left && top !== undefined && comparePositions(top, last) > 0 ? top : last;
      cursor[ecosystem] = positionText(position);
    }
    const tops = lists.flatMap((list) => (list.newest === null ? [] : [list.newest]));
    const head: HeadBody = {
      feed: provider.id,
      newest: tops.length === 0 ? null : tops.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)),
      pending: pending.length - done,
      read: done,
      gap: lists.some((list) => list.gap),
      lists,
    };
    const fetched = now();
    const at = first ?? { url: `${origin}/`, status: 200, latency: 0 };
    return { ok: true, observations: [observation(at.url, head, at.status, at.latency, fetched), ...observations], cursor, complete: !stopped };
  };
}
