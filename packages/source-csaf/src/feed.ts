/**
 * The reader of a ROLIE feed of CSAF advisories (RFC 8322, in the JSON form of CSAF 2.0, requirement 15). The feed lists
 * each advisory with the URL of its document (the link `self`) and the time of its last update (`updated`).
 */

import { isRecord, type Fields } from "@mark1russell7/optional/read";

/** One entry of the feed. */
export interface FeedEntry {
  /** The URL of the CSAF document of the advisory. */
  readonly url: string;
  /** The time of the last update of the advisory, from the field `updated` of the entry. */
  readonly updated: number;
}

/** The parts of a feed that the source uses. */
export interface Feed {
  /** The entries, in the order of `updated`, then of `url`. */
  readonly entries: readonly FeedEntry[];
  /** The count of the entries with no URL or no valid time. The fetch gives them no advisory. */
  readonly invalid: number;
}

/** This function gives the URL of the document of one entry: its link `self`, else its `content.src`. */
function urlOf(entry: Fields): string | undefined {
  const links = Array.isArray(entry["link"]) ? entry["link"] : [];
  for (const link of links) if (isRecord(link) && link["rel"] === "self" && typeof link["href"] === "string") return link["href"];
  const content = entry["content"];
  return isRecord(content) && typeof content["src"] === "string" ? content["src"] : undefined;
}

/** This function compares two entries by `updated`, then by `url`. */
export function compareEntries(a: FeedEntry, b: FeedEntry): number {
  if (a.updated !== b.updated) return a.updated - b.updated;
  return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
}

/**
 * This function reads the text of a feed. A text that is not JSON, or JSON with no `feed.entry` list, gives `undefined`.
 * An entry with no URL or no valid time counts in `invalid`.
 */
export function readFeed(text: string): Feed | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const feed = isRecord(value) ? value["feed"] : undefined;
  if (!isRecord(feed) || !Array.isArray(feed["entry"])) return undefined;
  const entries: FeedEntry[] = [];
  let invalid = 0;
  for (const entry of feed["entry"]) {
    const url = isRecord(entry) ? urlOf(entry) : undefined;
    const updated = isRecord(entry) && typeof entry["updated"] === "string" ? Date.parse(entry["updated"]) : Number.NaN;
    if (url === undefined || !Number.isFinite(updated)) invalid += 1;
    else entries.push({ url, updated });
  }
  return { entries: entries.sort(compareEntries), invalid };
}

/** The selection of one fetch: the entries to read, and the count of the entries after them. */
export interface Selection {
  readonly read: readonly FeedEntry[];
  /** The count of the entries that come after the entries of `read`. The next fetches read them. */
  readonly later: number;
}

/**
 * This function selects the entries that a fetch reads. With a last entry `after`, it selects the entries that come
 * after it. With no last entry, it selects the entries updated at `since` or later. It gives at most `limit` entries,
 * the oldest first.
 */
export function selectEntries(entries: readonly FeedEntry[], after: FeedEntry | undefined, since: number, limit: number): Selection {
  const due = entries.filter((entry) => (after === undefined ? entry.updated >= since : compareEntries(entry, after) > 0));
  return { read: due.slice(0, limit), later: Math.max(0, due.length - limit) };
}
