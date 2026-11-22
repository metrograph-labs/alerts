/**
 * The transit feeds of the instance (AL-60). The instance reads each GTFS Realtime feed of service alerts whose box meets
 * a watched place. The feeds come from a copy of the feed catalog of the Mobility Database in the private folder.
 *
 * After a pass, the keeper reads the catalog again when the copy is one day old, with a conditional GET on the pace of the
 * sources. The host of the catalog has a place of its own in the pace, so the read does not stop a source. When the new
 * copy changes the chosen feeds, the keeper starts `onFeeds` one time. The daemon then stops, and
 * the supervisor starts it with the new feeds. The position of a place stays on this computer: only the choice of the
 * feeds reads it.
 */

import { readFileSync } from "node:fs";
import type { Duration, Instant, WatchedPlace } from "@mark1russell7/alerts";
import { catalogFeeds, feedsFor, type CatalogCopy, type CatalogFetch, type GtfsFeed } from "@mark1russell7/alerts-source-gtfs-alerts";
import { errorMessage } from "@mark1russell7/text";
import { writeFileAtomicSync } from "@procedures/fs/files";
import { z } from "zod";

/** The file of the copy of the catalog in the private folder. */
export const TRANSIT_FILE = "transit-catalog.json";

/** The format of the file of the copy. */
export const TRANSIT_FORMAT = "alerts-transit-catalog/1";

/** The age of the copy at which the keeper reads the catalog again: one day. The catalog changes once a day or less. */
export const CATALOG_REFRESH: Duration = 24 * 3_600_000;

/** The wait after a failed read of the catalog: one hour. */
export const CATALOG_RETRY: Duration = 3_600_000;

/**
 * The most feeds of one instance. A place in a large city meets many feeds. The smallest boxes come first, because a small
 * box is a local network. A national feed has a large box.
 */
export const MAX_TRANSIT_FEEDS = 40;

/** The cache of the copy of the catalog. */
export interface TransitCache {
  /** This function gives the copy, or `undefined` when there is no good copy. It does not throw. */
  read(): CatalogCopy | undefined;
  /** This function replaces the copy. It throws when the write fails. */
  write(copy: CatalogCopy): void;
}

const conditionSchema = z.object({ etag: z.string().optional(), lastModified: z.string().optional(), digest: z.string() });
const fileSchema = z.object({ format: z.literal(TRANSIT_FORMAT), fetched: z.number().int().nonnegative(), condition: conditionSchema.optional(), text: z.string() });

/**
 * This function opens the cache of the copy in a file. A missing file gives no copy. A bad file gives no copy and one
 * call of `onBad`, and the next good write replaces it. The text of `onBad` holds no path.
 */
export function openTransitCache(path: string, onBad?: (problem: string) => void): TransitCache {
  return {
    read() {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") onBad?.(`the file ${TRANSIT_FILE} cannot be read: ${(error as NodeJS.ErrnoException).code ?? "an error"}`);
        return undefined;
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        onBad?.(`the file ${TRANSIT_FILE} is not JSON`);
        return undefined;
      }
      const parsed = fileSchema.safeParse(value);
      if (!parsed.success) {
        onBad?.(`the file ${TRANSIT_FILE} is not a copy of the catalog`);
        return undefined;
      }
      const { fetched, condition, text: catalog } = parsed.data;
      const kept = condition === undefined ? undefined : { ...(condition.etag === undefined ? {} : { etag: condition.etag }), ...(condition.lastModified === undefined ? {} : { lastModified: condition.lastModified }), digest: condition.digest };
      return { text: catalog, fetched, ...(kept === undefined ? {} : { condition: kept }) };
    },
    write(copy) {
      writeFileAtomicSync(path, `${JSON.stringify({ format: TRANSIT_FORMAT, fetched: copy.fetched, ...(copy.condition === undefined ? {} : { condition: copy.condition }), text: copy.text })}\n`, { mode: 0o600 });
    },
  };
}

/** The feeds of the instance. */
export interface ChosenFeeds {
  /** The feeds that the instance reads, in the order of their ids. */
  readonly feeds: readonly GtfsFeed[];
  /** The feeds that meet a place but are past the limit of the choice (`MAX_TRANSIT_FEEDS` by default), in the order of their ids. */
  readonly cut: readonly GtfsFeed[];
  /** The problems of the catalog. A copy with a problem gives no feed. */
  readonly problems: readonly string[];
}

/** The area of a box in square degrees. It orders the boxes from the most local. */
function boxSize(feed: GtfsFeed): number {
  return (feed.box.east - feed.box.west) * (feed.box.north - feed.box.south);
}

const byId = (a: GtfsFeed, b: GtfsFeed): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * This function chooses the feeds of the instance: the feeds of the copy whose box meets a place (`feedsFor`). It keeps
 * `max` feeds at most, the smallest boxes first. No copy gives no feed.
 */
export function chooseFeeds(copy: CatalogCopy | undefined, places: readonly WatchedPlace[], max: number = MAX_TRANSIT_FEEDS): ChosenFeeds {
  if (copy === undefined) return { feeds: [], cut: [], problems: [] };
  const catalog = catalogFeeds(copy.text);
  if (catalog.problems.length > 0) return { feeds: [], cut: [], problems: catalog.problems };
  const near = [...feedsFor(catalog.feeds, places)].sort((a, b) => boxSize(a) - boxSize(b) || byId(a, b));
  return { feeds: near.slice(0, max).sort(byId), cut: near.slice(max).sort(byId), problems: [] };
}

/** This function gives the key of a set of feeds. Two sets with the same ids, URLs and boxes have the same key. */
export function feedsKey(feeds: readonly GtfsFeed[]): string {
  return JSON.stringify([...feeds].sort(byId).map((feed) => [feed.id, feed.url, feed.box.west, feed.box.south, feed.box.east, feed.box.north]));
}

/** The outcome of one read of the catalog. */
export type TransitOutcome =
  | { readonly ok: true; readonly changed: boolean; readonly feeds: number; readonly cut: number }
  | { readonly ok: false; readonly error: unknown; readonly step: "fetch" | "write" };

/** The keeper of the copy of the catalog. */
export interface TransitKeeper {
  /** This function starts a read of the catalog when the copy is due and no read is in progress. It does not wait for the read. */
  afterPass(): void;
  /** This function waits for the end of the read in progress. It does not throw. */
  idle(): Promise<void>;
  /** This function stops the read in progress and waits for its end. */
  close(): Promise<void>;
}

/** The transit feeds of an instance: the keeper of the copy, and the feeds of the copy at the open. */
export interface InstanceTransit extends TransitKeeper {
  /** The feeds that the instance reads from its open to its close. */
  readonly chosen: ChosenFeeds;
  /** True when the private folder had a copy of the catalog at the open. */
  readonly copied: boolean;
}

/**
 * This function gives the line of the start about the transit feeds. It has counts and problems of the catalog, and no name
 * of a feed or a place.
 */
export function transitText(chosen: ChosenFeeds, copy: boolean, limit: number = MAX_TRANSIT_FEEDS): string {
  if (!copy) return "The private folder has no copy of the transit catalog. The runtime reads the catalog after its first pass.";
  if (chosen.problems.length > 0) return `The copy of the transit catalog has problems, and the runtime reads no transit feed: ${chosen.problems.join(", ")}.`;
  const cut = chosen.cut.length === 0 ? "" : ` ${String(chosen.cut.length)} more feeds meet a place, but the limit is ${String(limit)}.`;
  return `The runtime reads ${String(chosen.feeds.length)} transit feeds near the places.${cut}`;
}

/**
 * This function gives a text about a read of the catalog with a failure or a new text. A read that kept the text gives
 * `undefined`. The entry writes the text to the output of the process. The text has no name of a feed or a place.
 */
export function transitReport(outcome: TransitOutcome): string | undefined {
  if (!outcome.ok && outcome.step === "write") return `The copy of the transit catalog was not written: ${errorMessage(outcome.error)}`;
  if (!outcome.ok) return `The read of the transit catalog failed. The runtime tries again after ${String(CATALOG_RETRY / 60_000)} minutes: ${errorMessage(outcome.error)}`;
  if (!outcome.changed) return undefined;
  const cut = outcome.cut === 0 ? "" : `, and ${String(outcome.cut)} more past the limit`;
  return `The transit catalog has a new text. It gives ${String(outcome.feeds)} feeds near the places${cut}.`;
}

/** The options of `keepTransit`. */
export interface TransitKeeperOptions {
  readonly cache: TransitCache;
  /** The copy at the open of the instance. */
  readonly copy: CatalogCopy | undefined;
  readonly fetch: CatalogFetch;
  readonly now: () => Instant;
  readonly places: readonly WatchedPlace[];
  /** The key of the feeds at the open of the instance (`feedsKey`). */
  readonly opened: string;
  /** The most feeds of the choice. The default is `MAX_TRANSIT_FEEDS`. */
  readonly limit?: number | undefined;
  /** The keeper starts this function one time, when a new copy changes the chosen feeds. */
  readonly onFeeds?: (() => void) | undefined;
  /** The keeper gives the outcome of each read to this function. */
  readonly onTransit?: ((outcome: TransitOutcome) => void) | undefined;
}

/** This function makes the keeper of the copy of the catalog. */
export function keepTransit(options: TransitKeeperOptions): TransitKeeper {
  const stop = new AbortController();
  let copy = options.copy;
  let failedAt: Instant | undefined;
  let running: Promise<void> | undefined;
  let closed = false;
  let told = false;
  const report = (outcome: TransitOutcome): void => {
    try {
      options.onTransit?.(outcome);
    } catch {
      // The hook only reports. A fault of the hook does not stop the keeper.
    }
  };
  const due = (now: Instant): boolean => {
    if (failedAt !== undefined && now - failedAt < CATALOG_RETRY) return false;
    return copy === undefined || now - copy.fetched >= CATALOG_REFRESH;
  };
  const read = async (): Promise<void> => {
    let result: Awaited<ReturnType<CatalogFetch>>;
    try {
      result = await options.fetch(copy, stop.signal);
    } catch (error) {
      // The close aborts the read. That abort is not a fault.
      if (!stop.signal.aborted) {
        failedAt = options.now();
        report({ ok: false, error, step: "fetch" });
      }
      return;
    }
    if (!result.ok) {
      failedAt = options.now();
      report({ ok: false, error: new Error(result.failure.message), step: "fetch" });
      return;
    }
    try {
      options.cache.write(result.copy);
    } catch (error) {
      // The copy in memory stays current. The next start reads the catalog again.
      report({ ok: false, error, step: "write" });
    }
    copy = result.copy;
    failedAt = undefined;
    const chosen = chooseFeeds(copy, options.places, options.limit);
    report({ ok: true, changed: result.changed, feeds: chosen.feeds.length, cut: chosen.cut.length });
    if (told || feedsKey(chosen.feeds) === options.opened) return;
    told = true;
    options.onFeeds?.();
  };
  return {
    afterPass() {
      if (closed || running !== undefined || !due(options.now())) return;
      running = read().finally(() => {
        running = undefined;
      });
    },
    idle: async () => {
      await running;
    },
    async close() {
      if (closed) return;
      closed = true;
      stop.abort(new Error("The instance closed the keeper of the transit catalog."));
      await running;
    },
  };
}
