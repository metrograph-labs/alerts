/**
 * The providers of the OSV source, as data. Each row is one source of the runtime. It gives one feed of records in the OSV
 * format, its origin, its pace and the limit of its canary. A new feed of the same form is a new row, not new code.
 *
 * The two rows read the same data in two ways. The OpenSSF repository of malicious packages gives the `MAL-` records.
 * OSV.dev exports them with the other records of each ecosystem. The two rows have one origin, so the merge counts their
 * reports of one record as copies, not as two authorities.
 */

import type { Duration, SourceId } from "@mark1russell7/alerts";

/** One day, in milliseconds. */
export const DAY_MS = 86_400_000;

/** The kind of a package in a public registry that contains malware. */
export const MALICIOUS_KIND = "cyber.supply-chain.malicious-package";

/** The feed of the data exports of OSV.dev: one change list and one file for each record, for each ecosystem. */
export interface ExportsFeed {
  readonly type: "exports";
  /** The origin of the bucket of the exports. */
  readonly base: string;
  /** The ecosystems whose change lists the fetch reads, with the names of the exports. */
  readonly ecosystems: readonly string[];
}

/** The feed of a GitHub repository of OSV records: the commits through the GitHub API, the files through the raw host. */
export interface GithubFeed {
  readonly type: "github";
  /** The origin of the GitHub API. */
  readonly api: string;
  /** The origin of the raw files. */
  readonly raw: string;
  /** The repository, as `<owner>/<name>`. */
  readonly repo: string;
  readonly branch: string;
  /** The folders of the records. A file of another folder gives no observation. */
  readonly folders: readonly string[];
  /** The prefixes of the ids of the records that have no final id yet. Such a file gives no observation. */
  readonly skip: readonly string[];
}

/** One provider of OSV records. */
export interface OsvProvider {
  /** The source id of the provider in the runtime. */
  readonly id: SourceId;
  readonly title: string;
  /** The origin of the reports: the authority that issues the records. */
  readonly origin: string;
  /** The name of the sender of each report. */
  readonly sender: string;
  /** The parts that the feed needs, as the descriptor names them. */
  readonly dependsOn: readonly string[];
  readonly feed: ExportsFeed | GithubFeed;
  /** The prefixes of the ids that the source reads. A record with another id gives no observation. */
  readonly prefixes: readonly string[];
  /** The kind of each report. */
  readonly kind: string;
  readonly interval: Duration;
  /** The longest normal time of one fetch. A fetch reads many files, so the limit is above the default of 10 seconds. */
  readonly slowAfter: Duration;
  /** The longest normal age of the newest change of the feed. The canary fails above it. */
  readonly maxAge: Duration;
  /** The text of the canary check for a person. */
  readonly canary: string;
  /** The terms of use of the records, in a few words, and the URL of their text. */
  readonly terms: { readonly text: string; readonly url: string };
}

/** The terms of the data of the repository of malicious packages. */
const OSSF_TERMS = { text: "Apache-2.0, the license of the repository", url: "https://github.com/ossf/malicious-packages/blob/main/LICENSE" };

/**
 * The providers. The research of 2026-11-25 gave the rates of the canary limits:
 * - OSV.dev changes the npm change list each hour, with 120 to 1188 changes on each day from 2026-11-23 to 2026-11-25.
 * - The repository of malicious packages got 2 or more commits in each hour of 2026-11-25.
 */
export const OSV_PROVIDERS: readonly OsvProvider[] = [
  {
    id: "osv-export-malicious" as SourceId,
    title: "OSV.dev data exports: the malicious packages of npm, PyPI, crates.io, RubyGems and NuGet",
    origin: "ossf",
    sender: "OpenSSF malicious packages, through OSV.dev",
    dependsOn: ["provider:google-cloud"],
    feed: { type: "exports", base: "https://osv-vulnerabilities.storage.googleapis.com", ecosystems: ["npm", "PyPI", "crates.io", "RubyGems", "NuGet"] },
    prefixes: ["MAL-"],
    kind: MALICIOUS_KIND,
    interval: 15 * 60_000,
    slowAfter: 45_000,
    maxAge: 2 * DAY_MS,
    canary: "OSV.dev changes the npm change list each hour. The check passes when the newest change is at most 2 days older than the fetch.",
    terms: OSSF_TERMS,
  },
  {
    id: "ossf-malicious-packages" as SourceId,
    title: "OpenSSF malicious packages repository: the new and changed MAL records of each ecosystem",
    origin: "ossf",
    sender: "OpenSSF malicious packages",
    dependsOn: ["provider:github"],
    feed: { type: "github", api: "https://api.github.com", raw: "https://raw.githubusercontent.com", repo: "ossf/malicious-packages", branch: "main", folders: ["osv/malicious", "osv/withdrawn"], skip: ["MAL-0000-"] },
    prefixes: ["MAL-"],
    kind: MALICIOUS_KIND,
    // The GitHub API gives 60 requests in each hour to an address with no token, and other programs of the address share them.
    interval: 60 * 60_000,
    slowAfter: 30_000,
    maxAge: 2 * DAY_MS,
    canary: "The repository gets commits each hour. The check passes when the newest commit is at most 2 days older than the fetch.",
    terms: OSSF_TERMS,
  },
];
