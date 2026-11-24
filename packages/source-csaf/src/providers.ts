/**
 * The providers of CSAF 2.0 advisories that the source reads, as data. Each row is one source of the runtime: one ROLIE
 * feed of `TLP:CLEAR` advisories, its origin, its pace and the limit of its canary. A new provider is a new row, not new code.
 *
 * The rows hold only public facts of each provider: the URL of its feed and its terms of use. The research of 2026-11-24
 * read each feed and each `robots.txt`. No row asks for a key.
 */

import type { SourceId } from "@mark1russell7/alerts";

/** The kind of an advisory on control systems or medical devices. CISA, Siemens and ABB give advisories of this kind. */
export const ICS_ADVISORY_KIND = "cyber.advisory.ics";

/** The kind of an advisory on other products, for a later provider of IT advisories. */
export const ADVISORY_KIND = "cyber.advisory";

/** The length of one day, in milliseconds. */
export const DAY_MS = 86_400_000;

/** One provider of CSAF advisories with a ROLIE feed. */
export interface CsafProvider {
  /** The source id of the provider in the runtime, for example `csaf-cisa-ics`. */
  readonly id: SourceId;
  /** The title of the source for a person. */
  readonly title: string;
  /** The origin of the reports: the authority that issues the advisories. */
  readonly origin: string;
  /** The name of the sender of each report. */
  readonly sender: string;
  /** The parts that the feed needs, as the descriptor names them. */
  readonly dependsOn: readonly string[];
  /** The URL of the ROLIE feed of the `TLP:CLEAR` advisories. Each advisory of the feed must have the same origin (scheme and host). */
  readonly feed: string;
  /** The kind of each report. */
  readonly kind: typeof ICS_ADVISORY_KIND | typeof ADVISORY_KIND;
  /** The time between two fetches, in milliseconds. */
  readonly interval: number;
  /** The largest age of the newest advisory of the feed at a fetch, in milliseconds. An older feed fails the canary. */
  readonly maxAge: number;
  /** The text of the canary check for a person. */
  readonly canary: string;
  /** The terms of use of the advisories, in a few words, and the URL of their text. */
  readonly terms: { readonly text: string; readonly url: string };
}

/**
 * The providers of the source. The research of 2026-11-24 gave the rates of the canary limits:
 * - CISA updated 62 advisories of the ICS feed from 2026-11-01 to 2026-11-24. The limit of 14 days permits a gap at a holiday.
 * - Siemens updated 32 advisories in 30 days, with the most on its monthly patch day. The limit is 45 days.
 * - ABB updated 14 advisories in 30 days, and 91 since 2025-01. The limit is 45 days.
 */
export const CSAF_PROVIDERS: readonly CsafProvider[] = [
  {
    id: "csaf-cisa-ics" as SourceId,
    title: "CISA ICS advisories (CSAF): the flaws in control systems and medical devices",
    origin: "cisa",
    sender: "Cybersecurity and Infrastructure Security Agency (CISA)",
    dependsOn: ["provider:cisa", "provider:github"],
    feed: "https://raw.githubusercontent.com/cisagov/CSAF/develop/csaf_files/OT/white/cisa-csaf-ot-feed-tlp-white.json",
    kind: ICS_ADVISORY_KIND,
    interval: 30 * 60_000,
    maxAge: 14 * DAY_MS,
    canary: "CISA publishes ICS advisories on most work days. The check passes when the newest advisory is at most 14 days older than the fetch.",
    terms: { text: "TLP:CLEAR, sharing with no limit, subject to copyright", url: "https://www.cisa.gov/notification" },
  },
  {
    id: "csaf-siemens" as SourceId,
    title: "Siemens ProductCERT advisories (CSAF): the flaws in Siemens products",
    origin: "siemens",
    sender: "Siemens ProductCERT",
    dependsOn: ["provider:siemens", "cdn:cloudfront"],
    feed: "https://cert-portal.siemens.com/productcert/csaf/ssa-feed-tlp-white.json",
    kind: ICS_ADVISORY_KIND,
    interval: 60 * 60_000,
    maxAge: 45 * DAY_MS,
    canary: "Siemens publishes advisories each month on its patch day. The check passes when the newest advisory is at most 45 days older than the fetch.",
    terms: { text: "use and redistribution with a link to the original advisory", url: "https://www.siemens.com/productcert/terms-of-use" },
  },
  {
    id: "csaf-abb" as SourceId,
    title: "ABB PSIRT advisories (CSAF): the flaws in ABB products",
    origin: "abb",
    sender: "ABB PSIRT",
    dependsOn: ["provider:abb", "cdn:azure-front-door"],
    feed: "https://psirt.abb.com/csaf/abb-csaf-feed-tlp-white.json",
    kind: ICS_ADVISORY_KIND,
    interval: 60 * 60_000,
    maxAge: 45 * DAY_MS,
    canary: "ABB publishes approximately 5 advisories each month. The check passes when the newest advisory is at most 45 days older than the fetch.",
    terms: { text: "TLP:CLEAR, no statement of a license", url: "https://psirt.abb.com/.well-known/csaf/provider-metadata.json" },
  },
];
