/**
 * The fetch of a GitHub repository of OSV records, for example the OpenSSF repository of malicious packages. The fetch
 * reads the commits through the GitHub API and the files through the raw host. It sends no token, so the API gives 60
 * requests in each hour to the address. The fetch sends one request to the API in each fetch, and a conditional one.
 *
 * - The cursor holds the last commit that the fetch read (`base`). With no cursor, the fetch reads the newest commit of
 *   the branch and no record. The data exports of OSV.dev give the older records.
 * - Each later fetch compares `base` with the branch. It reads each added, changed or moved record file of the folders
 *   of the feed at the newest commit. It reads at most `RECORDS_PER_FETCH` files.
 * - The cursor then holds that commit (`head`) and the count of the files that the fetch read (`offset`). Thus the next
 *   fetch reads the rest of the same files.
 * - The fetch keeps no name and no address of the authors of the commits: it reads only the ids and the times.
 * - A file that the raw host does not find (a 404 or a 410) is passed. Each other failure ends the fetch at that file.
 */

import type { Cursor, FetchFailure, Observation } from "@mark1russell7/alerts";
import { createRequester, type Requester } from "@mark1russell7/alerts-fetch";
import { arrayOf, isRecord, recordOf, textOf } from "@mark1russell7/optional/read";
import { keptReplies, type Condition, type KeptReplies } from "polite-crawler/api";

import { fileBody, type HeadBody } from "./body.ts";
import { observer, OSV_TIMEOUT_MS, RECORDS_PER_FETCH, type OsvFetch, type OsvFetchOptions } from "./options.ts";
import type { GithubFeed, OsvProvider } from "./providers.ts";

/** The most files of one answer of the compare API. A compare with this count of files can lack some files. */
export const MAX_COMPARE_FILES = 300;

/** The version of the GitHub REST API that the fetch asks for. */
export const GITHUB_API_VERSION = "2022-11-28";

/** The states of a file in a compare that give a record to read. A removed file gives no record. */
const READ_STATES: readonly string[] = ["added", "modified", "renamed", "changed", "copied"];

/** The pattern of the id of a commit. */
const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** The position of the fetch in the repository. */
export interface GithubPosition {
  /** The last commit that the fetch read in full. */
  readonly base: string;
  /** The commit whose files the fetch reads, when it read only a part of them. */
  readonly head?: string;
  /** The count of the files of `head` that the fetch read. */
  readonly offset: number;
}

/** One commit of an answer of the API: its id and its time. */
export interface CommitRef {
  readonly sha: string;
  readonly time: string;
}

/** The parts of an answer of the compare API that the fetch uses. */
export interface Comparison {
  /** The state of the head against the base: `ahead`, `identical`, `behind` or `diverged`. */
  readonly status: string;
  readonly baseTime?: string;
  /** The commits after the base, the oldest first. */
  readonly commits: readonly CommitRef[];
  readonly totalCommits: number;
  /** The paths and the states of the changed files. */
  readonly files: readonly { readonly filename: string; readonly status: string }[];
}

/** This function reads a cursor of the fetch. A cursor with no valid base gives `undefined`: the state of a first fetch. */
export function readGithubCursor(cursor: Cursor | undefined): GithubPosition | undefined {
  const base = cursor?.["base"];
  if (base === undefined || !SHA_PATTERN.test(base)) return undefined;
  const head = cursor?.["head"];
  const offset = Number(cursor?.["offset"] ?? "0");
  if (head === undefined || !SHA_PATTERN.test(head) || !Number.isSafeInteger(offset) || offset < 0) return { base, offset: 0 };
  return { base, head, offset };
}

/** This function gives the text of a position in a cursor. */
export function githubCursor(position: GithubPosition): Cursor {
  return position.head === undefined ? { base: position.base } : { base: position.base, head: position.head, offset: String(position.offset) };
}

/** This function reads one commit of an answer of the API, or `undefined`. */
function commitOf(value: unknown): CommitRef | undefined {
  const sha = textOf(value, "sha");
  const time = textOf(recordOf(recordOf(value, "commit"), "committer"), "date");
  return sha !== undefined && SHA_PATTERN.test(sha) && time !== undefined ? { sha, time } : undefined;
}

/** This function reads the answer of the list of commits, or `undefined` for an answer of another form. */
export function readCommits(text: string): readonly CommitRef[] | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) return undefined;
    return value.flatMap((item) => commitOf(item) ?? []);
  } catch {
    return undefined;
  }
}

/** This function reads the answer of the compare API, or `undefined` for an answer of another form. */
export function readComparison(text: string): Comparison | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const status = textOf(value, "status");
  const commits = arrayOf(value, "commits", (item) => commitOf(item));
  if (!isRecord(value) || status === undefined || commits === undefined) return undefined;
  const baseTime = textOf(recordOf(recordOf(value["base_commit"], "commit"), "committer"), "date");
  const files = arrayOf(value, "files", (item: unknown) => {
    const filename = textOf(item, "filename");
    const state = textOf(item, "status");
    return filename === undefined || state === undefined ? undefined : { filename, status: state };
  });
  const total = value["total_commits"];
  return { status, ...(baseTime === undefined ? {} : { baseTime }), commits, totalCommits: typeof total === "number" ? total : commits.length, files: files ?? [] };
}

/**
 * This function gives the record files of a comparison. These are the added, changed or moved files of the folders of the feed.
 * The name of each file is an id with a prefix of the provider and with no prefix of `skip`. The files come in the order of their paths.
 */
export function recordFiles(comparison: Comparison, feed: GithubFeed, prefixes: readonly string[]): readonly string[] {
  const found = new Set<string>();
  for (const file of comparison.files) {
    if (!READ_STATES.includes(file.status) || !feed.folders.some((folder) => file.filename.startsWith(`${folder}/`))) continue;
    const name = file.filename.slice(file.filename.lastIndexOf("/") + 1);
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (prefixes.some((prefix) => id.startsWith(prefix)) && !feed.skip.some((prefix) => id.startsWith(prefix))) found.add(file.filename);
  }
  return [...found].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** One requester of the API with its conditions and its last full answers, for the replay of a 304 answer. */
interface ApiReader {
  readonly requester: Requester;
  readonly conditions: Map<string, Condition>;
  readonly last: KeptReplies<null>;
}

/** This function makes the fetch function of a provider of a GitHub repository. */
export function createGithubFetch(provider: OsvProvider, feed: GithubFeed, options: OsvFetchOptions): OsvFetch {
  const common = {
    source: provider.id,
    pace: options.pace,
    transport: options.transport,
    timeoutMs: options.timeoutMs ?? OSV_TIMEOUT_MS,
    ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
  };
  const api: ApiReader = {
    requester: createRequester({ ...common, baseUrl: new URL(options.baseUrl ?? feed.api).origin, headers: { accept: "application/vnd.github+json", "x-github-api-version": GITHUB_API_VERSION, "user-agent": options.userAgent } }),
    conditions: new Map(),
    last: keptReplies<null>(),
  };
  const raw = createRequester({ ...common, baseUrl: new URL(options.rawUrl ?? feed.raw).origin, headers: { accept: "application/json, text/plain;q=0.9", "user-agent": options.userAgent } });
  const observation = observer(provider.id);
  const now = options.pace.now;
  const repo = feed.repo.split("/").map(encodeURIComponent).join("/");

  // One GET of the API, conditional. A 304 gives the body of the last full answer of the URL in this process.
  const ask = async (path: string, what: string, signal: Parameters<OsvFetch>[1]): Promise<{ readonly ok: true; readonly url: string; readonly body: string; readonly status: number; readonly latency: number } | { readonly ok: false; readonly failure: FetchFailure }> => {
    const requested = await api.requester.get({ path, what, conditions: api.conditions }, signal);
    if (!requested.ok) return { ok: false, failure: requested.failure };
    const { url, answer, latency } = requested;
    if (answer.classified.outcome === "not-modified") {
      const last = await api.last.get(url).catch(() => undefined);
      if (last === undefined) {
        api.conditions.delete(url);
        return { ok: false, failure: { kind: "network", message: `a 304 answer with no earlier full answer: ${url}` } };
      }
      return { ok: true, url, body: last.reply.body, status: 304, latency };
    }
    api.last.keep(url, answer.reply, null);
    return { ok: true, url, body: answer.reply.body, status: answer.reply.status, latency };
  };
  const malformed = (url: string): { readonly ok: false; readonly failure: FetchFailure } => {
    api.conditions.delete(url);
    api.last.delete(url);
    return { ok: false, failure: { kind: "server", message: `the answer of the GitHub API has an unknown form: ${url}` } };
  };

  return async (input, signal) => {
    const position = readGithubCursor(input.cursor);
    if (position === undefined) {
      const branch = await ask(`/repos/${repo}/commits?sha=${encodeURIComponent(feed.branch)}&per_page=1`, `the newest commit of ${feed.repo}`, signal);
      if (!branch.ok) return branch;
      const newest = readCommits(branch.body)?.[0];
      if (newest === undefined) return malformed(branch.url);
      const head: HeadBody = { feed: provider.id, newest: newest.time, pending: 0, read: 0, gap: false, commit: newest.sha };
      return { ok: true, observations: [observation(branch.url, head, branch.status, branch.latency, now())], cursor: githubCursor({ base: newest.sha, offset: 0 }), complete: true };
    }

    const target = position.head ?? feed.branch;
    const compared = await ask(`/repos/${repo}/compare/${position.base}...${encodeURIComponent(target)}`, `the new commits of ${feed.repo}`, signal);
    if (!compared.ok) return compared;
    const comparison = readComparison(compared.body);
    if (comparison === undefined) return malformed(compared.url);
    const top = comparison.commits.at(-1);
    const headSha = top?.sha ?? position.base;
    const newest = top?.time ?? comparison.baseTime ?? null;
    // A history that no longer holds the base (a force push) gives no record: the fetch starts again at the new head.
    const moved = comparison.status === "behind" || comparison.status === "diverged";
    const files = moved ? [] : recordFiles(comparison, feed, provider.prefixes);
    const offset = position.head === headSha ? Math.min(position.offset, files.length) : 0;

    const observations: Observation[] = [];
    let done = 0;
    let stopped = false;
    for (const filename of files.slice(offset, offset + RECORDS_PER_FETCH)) {
      const path = `/${repo}/${headSha}/${filename.split("/").map(encodeURIComponent).join("/")}`;
      const file = await raw.get({ path, what: `the OSV record ${filename.slice(filename.lastIndexOf("/") + 1)}` }, signal);
      // Only a file that is not found is passed. A 403 or a 429 tells of a block or a limit of the host, not of one file.
      if (!file.ok && file.answer?.classified.outcome !== "not-found") {
        stopped = true;
        break;
      }
      if (file.ok) observations.push(observation(file.url, fileBody(file.answer.reply.body, file.url), file.answer.reply.status, file.latency, now()));
      done += 1;
    }
    const reached = offset + done;
    const next: GithubPosition = reached >= files.length ? { base: headSha, offset: 0 } : { base: position.base, head: headSha, offset: reached };
    const gap = moved || comparison.files.length >= MAX_COMPARE_FILES || comparison.totalCommits > comparison.commits.length;
    const head: HeadBody = { feed: provider.id, newest, pending: files.length - reached, read: done, gap, commit: headSha };
    return { ok: true, observations: [observation(compared.url, head, compared.status, compared.latency, now()), ...observations], cursor: githubCursor(next), complete: !stopped };
  };
}
