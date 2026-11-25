/**
 * The providers of the CERT feed source: national computer emergency response teams (CERTs) that publish their alerts and
 * reports as an RSS feed. Each row is one source. A new feed of the same form is one more row, with no new code.
 */

import type { Duration, SourceId } from "@mark1russell7/alerts";

/** One day, in milliseconds. */
export const DAY_MS = 86_400_000;

/** The kind of a general security advisory. */
export const ADVISORY_KIND = "cyber.advisory";

/** The kind of an advisory on a flaw in control systems or medical devices. */
export const ICS_KIND = "cyber.advisory.ics";

/** The kind of an advisory on an active attacker group or campaign. */
export const CAMPAIGN_KIND = "cyber.campaign";

/** The kind of a flaw that attackers use at this time. */
export const EXPLOITED_KIND = "cyber.vulnerability.exploited";

/** The kind of a newly published flaw. */
export const PUBLISHED_KIND = "cyber.vulnerability.published";

/** The kind of an attack on the computer systems of a utility or another critical service. */
export const INFRASTRUCTURE_KIND = "cyber.infrastructure-attack";

/**
 * One rule that gives the kind of an entry. A rule matches when each of its patterns matches its field of the entry. The
 * first rule that matches wins.
 */
export interface KindRule {
  /** The pattern of the link of the entry. */
  readonly link?: RegExp;
  /** The pattern of the title of the entry. */
  readonly title?: RegExp;
  readonly kind: string;
}

/** One provider: a CERT and its feed. */
export interface CertProvider {
  readonly id: SourceId;
  readonly title: string;
  /** The short name of the provider, before the title of each headline. */
  readonly short: string;
  readonly origin: string;
  readonly sender: string;
  readonly dependsOn: readonly string[];
  /** The URL of the feed. The requester follows no redirect, so this is the final URL. */
  readonly feed: string;
  /** The language of the texts of the feed, as a BCP 47 code. */
  readonly language: string;
  /** The rules of the kind of an entry, in order. */
  readonly rules: readonly KindRule[];
  /** The kind of an entry that no rule matches. Absent: such an entry gives no report, and the map gives a note. */
  readonly fallback?: string;
  /** Each kind that the rules and the fallback give. The descriptor gives these kinds. */
  readonly kinds: readonly string[];
  readonly interval: Duration;
  /** The longest normal age of the newest entry of the feed. The canary fails above it. */
  readonly maxAge: Duration;
  /** The text of the canary check for a person. */
  readonly canary: string;
  /** The terms of use of the feed, in a few words, and the URL of their text, or `null` when no terms page is known. */
  readonly terms: { readonly text: string; readonly url: string | null };
}

const NO_TERMS = "No terms page was read. The report gives the title, a short text and the link to the original page.";

/**
 * The providers. The fetches of 2026-11-25 gave the rates of the canary limits:
 * - CISA published 30 items from 2026-11-10 to 2026-11-24, on most work days.
 * - CERT-SE published 10 items from 2026-11-09 to 2026-11-24, with a weekly letter.
 * - The CTI feed of CERT-FR had a gap of 79 days, from 2026-07-13 to 2026-09-30.
 * - The news feed of the NCSC published 20 items from 2026-04-22 to 2026-11-11.
 * - CERT-UA had gaps of up to 55 days in 2026. Its newest item had the date 2026-09-30.
 * - JPCERT/CC publishes a security alert at least on each monthly patch day of Microsoft.
 */
export const CERT_PROVIDERS: readonly CertProvider[] = [
  {
    id: "cisa-advisories-rss" as SourceId,
    title: "CISA cybersecurity alerts and advisories (RSS)",
    short: "CISA",
    origin: "cisa",
    sender: "Cybersecurity and Infrastructure Security Agency (CISA)",
    dependsOn: ["provider:cisa", "cdn:akamai"],
    feed: "https://www.cisa.gov/cybersecurity-advisories/all.xml",
    language: "en",
    // A joint advisory (an "AA" id) on an attack on a utility or on control systems gives the kind of an attack on
    // critical infrastructure. Each other joint advisory tells of a campaign.
    rules: [
      { link: /\/ics(?:-medical)?-advisories\//, kind: ICS_KIND },
      { title: /known exploited vulnerabilit/i, kind: EXPLOITED_KIND },
      { link: /\/cybersecurity-advisories\/aa/, title: /water|utilit|energy|pipeline|critical infrastructure|operational technology|\bOT\b|\bPLCs?\b|control systems?|industrial/i, kind: INFRASTRUCTURE_KIND },
      { link: /\/cybersecurity-advisories\/aa/, kind: CAMPAIGN_KIND },
    ],
    fallback: ADVISORY_KIND,
    kinds: [ICS_KIND, EXPLOITED_KIND, INFRASTRUCTURE_KIND, CAMPAIGN_KIND, ADVISORY_KIND],
    interval: 30 * 60_000,
    maxAge: 10 * DAY_MS,
    canary: "CISA publishes alerts and advisories on most work days. The check passes when the newest item is at most 10 days older than the fetch.",
    terms: { text: NO_TERMS, url: null },
  },
  {
    id: "cert-se-rss" as SourceId,
    title: "CERT-SE warnings and news (RSS, in Swedish)",
    short: "CERT-SE",
    origin: "cert-se",
    sender: "CERT-SE",
    dependsOn: ["provider:cert-se"],
    feed: "https://www.cert.se/feed/rss.xml",
    language: "sv",
    // The words "sårbarhet" (flaw), "nätfiske" (phishing), "kampanj" (campaign), "attack" and "bedrägeri" (fraud).
    rules: [
      { title: /sårbarhet/i, kind: PUBLISHED_KIND },
      { title: /nätfiske|kampanj|attack|bedrägeri/i, kind: CAMPAIGN_KIND },
    ],
    kinds: [PUBLISHED_KIND, CAMPAIGN_KIND],
    interval: 60 * 60_000,
    maxAge: 21 * DAY_MS,
    canary: "CERT-SE publishes a weekly letter. The check passes when the newest item is at most 21 days older than the fetch.",
    terms: { text: NO_TERMS, url: null },
  },
  {
    id: "cert-fr-cti-rss" as SourceId,
    title: "CERT-FR threat reports (RSS, in French)",
    short: "CERT-FR",
    origin: "cert-fr",
    sender: "CERT-FR (ANSSI)",
    dependsOn: ["provider:cert-fr"],
    feed: "https://cert.cyber.gouv.fr/cti/feed/",
    language: "fr",
    rules: [],
    fallback: CAMPAIGN_KIND,
    kinds: [CAMPAIGN_KIND],
    interval: 60 * 60_000,
    maxAge: 120 * DAY_MS,
    canary: "CERT-FR publishes a threat report each few weeks. The check passes when the newest report is at most 120 days older than the fetch.",
    terms: { text: "Licence Ouverte (Etalab 2.0), with credit to the source", url: "https://cert.cyber.gouv.fr/" },
  },
  {
    id: "ncsc-uk-rss" as SourceId,
    title: "NCSC (UK) news (RSS)",
    short: "NCSC",
    origin: "ncsc-uk",
    sender: "National Cyber Security Centre (NCSC), United Kingdom",
    dependsOn: ["provider:ncsc-uk", "cdn:cloudflare"],
    feed: "https://www.ncsc.gov.uk/api/1/services/v1/news-rss-feed.xml",
    language: "en",
    rules: [
      { title: /exploit/i, kind: EXPLOITED_KIND },
      { title: /vulnerabilit|security issue/i, kind: PUBLISHED_KIND },
      { title: /actors?\b|campaign|targeting|spyware|malware|ransomware|attack/i, kind: CAMPAIGN_KIND },
    ],
    kinds: [EXPLOITED_KIND, PUBLISHED_KIND, CAMPAIGN_KIND],
    interval: 60 * 60_000,
    maxAge: 60 * DAY_MS,
    canary: "The NCSC publishes news each few weeks. The check passes when the newest item is at most 60 days older than the fetch.",
    terms: { text: "Open Government Licence v3.0, with credit to the NCSC", url: "https://www.ncsc.gov.uk/section/about-this-website/terms-and-conditions" },
  },
  {
    id: "cert-ua-rss" as SourceId,
    title: "CERT-UA reports (RSS, in Ukrainian)",
    short: "CERT-UA",
    origin: "cert-ua",
    sender: "CERT-UA",
    dependsOn: ["provider:cert-ua"],
    feed: "https://cert.gov.ua/api/articles/rss",
    language: "uk",
    rules: [],
    fallback: CAMPAIGN_KIND,
    kinds: [CAMPAIGN_KIND],
    interval: 60 * 60_000,
    maxAge: 120 * DAY_MS,
    canary: "CERT-UA publishes a report on an attacker group each few weeks. The check passes when the newest report is at most 120 days older than the fetch.",
    terms: { text: NO_TERMS, url: null },
  },
  {
    id: "jpcert-rss-en" as SourceId,
    title: "JPCERT/CC security alerts (RSS 1.0, in English)",
    short: "JPCERT/CC",
    origin: "jpcert-cc",
    sender: "JPCERT Coordination Center (JPCERT/CC)",
    dependsOn: ["provider:jpcert-cc", "cdn:cloudfront"],
    feed: "https://www.jpcert.or.jp/english/rss/jpcert-en.rdf",
    language: "en",
    rules: [],
    fallback: PUBLISHED_KIND,
    kinds: [PUBLISHED_KIND],
    interval: 60 * 60_000,
    maxAge: 60 * DAY_MS,
    canary: "JPCERT/CC publishes a security alert at least each month. The check passes when the newest alert is at most 60 days older than the fetch.",
    terms: { text: NO_TERMS, url: null },
  },
];

/**
 * This function gives the kind of an entry from the rules of the provider. It gives `undefined` when no rule matches and the
 * provider has no fallback.
 */
export function kindOf(provider: CertProvider, entry: { readonly link?: string; readonly title?: string }): string | undefined {
  const matches = (pattern: RegExp | undefined, value: string | undefined): boolean => pattern === undefined || (value !== undefined && pattern.test(value));
  for (const rule of provider.rules) if (matches(rule.link, entry.link) && matches(rule.title, entry.title)) return rule.kind;
  return provider.fallback;
}
