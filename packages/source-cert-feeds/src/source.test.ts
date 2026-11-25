import { categoryOf, type FetchOutcome, type Observation, type ObservationId, type SourceId, type Watch } from "@mark1russell7/alerts";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";

import { checkCanary, newestOf } from "./check.ts";
import { certDescriptor } from "./descriptor.ts";
import { createCertFetch, cvesOf, ENTRIES_PER_FETCH, ENTRY_WINDOW_MS, MAX_SUMMARY, plainText, type EntryBody, type HeadBody } from "./fetch.ts";
import { createCertSource } from "./index.ts";
import { createCertMap, ENTRY_LIFE_MS } from "./map.ts";
import { ADVISORY_KIND, CAMPAIGN_KIND, CERT_PROVIDERS, DAY_MS, EXPLOITED_KIND, ICS_KIND, INFRASTRUCTURE_KIND, kindOf, PUBLISHED_KIND, type CertProvider } from "./providers.ts";

const ORIGIN = "https://cert.test";
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
const WATCH: Watch = { places: [] };
const providerOf = (id: string): CertProvider => CERT_PROVIDERS.find((provider) => provider.id === id)!;
const CISA = providerOf("cisa-advisories-rss");
const CERT_SE = providerOf("cert-se-rss");
const JPCERT = providerOf("jpcert-rss-en");
const TEST: CertProvider = { ...CISA, feed: `${ORIGIN}/feeds/all.xml` };

/** The time of RSS 2.0, in the form of the feed of CISA: a year of two digits. */
const rfc822 = (time: number): string => {
  const date = new Date(time);
  const two = (value: number) => String(value).padStart(2, "0");
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[date.getUTCDay()]!}, ${two(date.getUTCDate())} ${months[date.getUTCMonth()]!} ${two(date.getUTCFullYear() % 100)} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:00 +0000`;
};

interface Item {
  readonly title: string;
  readonly path: string;
  readonly time?: number;
  readonly text?: string;
  readonly guid?: boolean;
}

/** An RSS 2.0 feed in the form of the feed of CISA. The titles and the texts are synthetic. */
const rss = (items: readonly Item[]): string =>
  `<?xml version="1.0" encoding="utf-8"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Alerts</title><link>${ORIGIN}/</link>` +
  items
    .map(
      (item) =>
        `<item><title>${item.title}</title><link>${ORIGIN}${item.path}</link>` +
        (item.text === undefined ? "" : `<description>${item.text}</description>`) +
        (item.time === undefined ? "" : `<pubDate>${rfc822(item.time)}</pubDate>`) +
        (item.guid === false ? "" : `<guid isPermaLink="false">${item.path}</guid>`) +
        `</item>`,
    )
    .join("") +
  `</channel></rss>`;

const xml = (body: string, status = 200, headers: Record<string, string> = {}): Reply => ({ status, statusText: status === 200 ? "OK" : "Error", headers: { "content-type": "application/rss+xml", ...headers }, body });

/** This function makes a fetch whose transport gives the replies of `replies` in order, and a 404 after them. */
const fetchWith = (replies: readonly Reply[], provider: CertProvider = TEST) => {
  const sent: Exchange[] = [];
  const queue = [...replies];
  const transport: Transport = async (exchange) => {
    sent.push(exchange);
    return queue.shift() ?? xml("", 404);
  };
  const clock = { now: () => NOW, sleep: async () => undefined };
  const options = { pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport, userAgent: "alerts-tests", baseUrl: ORIGIN, minIntervalMs: 0, timeoutMs: 1000 };
  return { fetch: createCertFetch(provider, options), source: createCertSource(provider, options), sent };
};
const observationsOf = (outcome: FetchOutcome): readonly Observation[] => (outcome.ok ? outcome.observations : []);
const bodiesOf = (outcome: FetchOutcome): readonly Record<string, unknown>[] => observationsOf(outcome).map((observation) => JSON.parse(observation.body) as Record<string, unknown>);

const observation = (body: unknown): Observation => ({
  id: "obs-1" as ObservationId,
  source: TEST.id,
  fetched: NOW,
  contentType: "application/json",
  body: JSON.stringify(body),
  transport: { url: `${ORIGIN}/feeds/all.xml`, status: 200, latency: 10 },
});
const entry = (fields: Partial<EntryBody> = {}): EntryBody => ({ key: "/a", title: "A title", link: `${ORIGIN}/a`, time: new Date(NOW - DAY_MS).toISOString(), categories: [], cves: [], ...fields });

const ITEMS: readonly Item[] = [
  { title: "CISA Adds Two Known Exploited Vulnerabilities to Catalog", path: "/news-events/alerts/2026/11/24/kev", time: NOW - DAY_MS, text: "&lt;p&gt;CISA added &lt;b&gt;CVE-2026-1001&lt;/b&gt; and CVE-2026-1002, and CVE-2026-1001 again.&lt;/p&gt;" },
  { title: "Example Controls Gateway", path: "/news-events/ics-advisories/icsa-26-328-01", time: NOW - 2 * DAY_MS, text: "A flaw: CVE-2026-2001." },
  { title: "Old item", path: "/news-events/alerts/2026/09/01/old", time: NOW - ENTRY_WINDOW_MS - DAY_MS },
  { title: "No time", path: "/news-events/alerts/no-time" },
];

describe("the providers", () => {
  it("gives each provider a kind for each rule and fallback, and a feed of its own host", () => {
    for (const provider of CERT_PROVIDERS) {
      const given = [...provider.rules.map((rule) => rule.kind), ...(provider.fallback === undefined ? [] : [provider.fallback])];
      expect([...new Set(given)].sort(), provider.id).toEqual([...provider.kinds].sort());
      expect(new URL(provider.feed).protocol, provider.id).toBe("https:");
      for (const kind of provider.kinds) expect(categoryOf(kind), kind).toBe("cyber");
    }
    expect(new Set(CERT_PROVIDERS.map((provider) => provider.id)).size).toBe(CERT_PROVIDERS.length);
  });

  it("gives the kind of an entry from the first rule that matches, else the fallback, else no kind", () => {
    expect(kindOf(CISA, { title: "Example Gateway", link: "https://www.cisa.gov/news-events/ics-advisories/icsa-26-328-01" })).toBe(ICS_KIND);
    expect(kindOf(CISA, { title: "Example", link: "https://www.cisa.gov/news-events/ics-medical-advisories/icsma-26-1" })).toBe(ICS_KIND);
    expect(kindOf(CISA, { title: "CISA Adds One Known Exploited Vulnerability to Catalog", link: "https://www.cisa.gov/news-events/alerts/x" })).toBe(EXPLOITED_KIND);
    expect(kindOf(CISA, { title: "A joint advisory", link: "https://www.cisa.gov/news-events/cybersecurity-advisories/aa26-100a" })).toBe(CAMPAIGN_KIND);
    expect(kindOf(CISA, { title: "Actors Attack the Control Systems of Water Utilities", link: "https://www.cisa.gov/news-events/cybersecurity-advisories/aa26-101a" })).toBe(INFRASTRUCTURE_KIND);
    // A rule matches only when each of its patterns matches: an alert on control systems that is no joint advisory is general.
    expect(kindOf(CISA, { title: "CISA Releases Guidance for Industrial Control Systems", link: "https://www.cisa.gov/news-events/alerts/z" })).toBe(ADVISORY_KIND);
    expect(kindOf(CISA, { title: "CISA Releases Guidance", link: "https://www.cisa.gov/news-events/alerts/y" })).toBe(ADVISORY_KIND);
    expect(kindOf(CERT_SE, { title: "Kritisk sårbarhet i en produkt" })).toBe(PUBLISHED_KIND);
    expect(kindOf(CERT_SE, { title: "Ökad vaksamhet efter fall av nätfiske" })).toBe(CAMPAIGN_KIND);
    expect(kindOf(CERT_SE, { title: "Veckobrev v.47" })).toBeUndefined();
    expect(kindOf(JPCERT, { title: "Security Alert: Updates" })).toBe(PUBLISHED_KIND);
  });
});

describe("the texts", () => {
  it("gives the plain text of HTML, and the CVE ids of a text each one time", () => {
    expect(plainText("<p>A &amp; B</p>\n\n<p> C </p>")).toBe("A & B C");
    expect(plainText(" <br/> ")).toBeUndefined();
    expect(cvesOf("CVE-2026-1001, CVE-2026-12345 and CVE-2026-1001; not CVE-26-1")).toEqual(["CVE-2026-1001", "CVE-2026-12345"]);
  });
});

describe("the fetch", () => {
  it("gives the head and one body for each entry of the window, the newest first, and counts the entries with no time", async () => {
    const { fetch, sent } = fetchWith([xml(rss(ITEMS))]);
    const outcome = await fetch({ watch: WATCH });
    expect(outcome).toMatchObject({ ok: true, complete: true });
    expect(sent.map((exchange) => exchange.url)).toEqual([`${ORIGIN}/feeds/all.xml`]);
    expect(sent[0]!.headers["accept"]).toContain("application/rss+xml");
    const [head, ...entries] = bodiesOf(outcome);
    expect(head).toEqual({ feed: TEST.feed, newest: new Date(NOW - DAY_MS).toISOString(), entries: 4, invalid: 1 } satisfies HeadBody);
    expect(entries.map((body) => body["key"])).toEqual(["/news-events/alerts/2026/11/24/kev", "/news-events/ics-advisories/icsa-26-328-01"]);
    expect(entries[0]).toMatchObject({ title: ITEMS[0]!.title, summary: "CISA added CVE-2026-1001 and CVE-2026-1002, and CVE-2026-1001 again.", cves: ["CVE-2026-1001", "CVE-2026-1002"] });
  });

  it("gives one observation id for two fetches of one entry", async () => {
    const { fetch } = fetchWith([xml(rss(ITEMS)), xml(rss(ITEMS))]);
    const first = observationsOf(await fetch({ watch: WATCH })).map((item) => item.id);
    const second = observationsOf(await fetch({ watch: WATCH })).map((item) => item.id);
    expect(second).toEqual(first);
  });

  it("takes the link as the key of an item with no guid, and cuts a long text", async () => {
    const { fetch } = fetchWith([xml(rss([{ title: "T", path: "/x", time: NOW, guid: false, text: "w ".repeat(MAX_SUMMARY) }]))]);
    const body = bodiesOf(await fetch({ watch: WATCH }))[1]!;
    expect(body["key"]).toBe(`${ORIGIN}/x`);
    expect((body["summary"] as string).length).toBe(MAX_SUMMARY);
  });

  it("gives at most the limit of entries", async () => {
    const many = Array.from({ length: ENTRIES_PER_FETCH + 5 }, (_, index) => ({ title: `T${String(index)}`, path: `/i/${String(index)}`, time: NOW - index * 60_000 }));
    const { fetch } = fetchWith([xml(rss(many))]);
    expect(observationsOf(await fetch({ watch: WATCH }))).toHaveLength(1 + ENTRIES_PER_FETCH);
  });

  it("sends the condition of the last answer, and gives its entries again for a 304", async () => {
    const { fetch, sent } = fetchWith([xml(rss(ITEMS), 200, { etag: '"v1"' }), { status: 304, statusText: "Not Modified", headers: {}, body: "" }]);
    const first = await fetch({ watch: WATCH });
    const second = await fetch({ watch: WATCH });
    expect(sent[1]!.headers["if-none-match"]).toBe('"v1"');
    expect(observationsOf(second).map((item) => item.id)).toEqual(observationsOf(first).map((item) => item.id));
  });

  it("fails for a 304 with no earlier answer, for a cut feed and for a page that is not a feed", async () => {
    expect(await fetchWith([{ status: 304, statusText: "Not Modified", headers: {}, body: "" }]).fetch({ watch: WATCH })).toMatchObject({ ok: false, failure: { kind: "network" } });
    const cut = rss(ITEMS).slice(0, 200);
    expect(await fetchWith([xml(cut)]).fetch({ watch: WATCH })).toMatchObject({ ok: false, failure: { kind: "network", message: expect.stringContaining("malformed") } });
    expect(await fetchWith([xml("<html><body/></html>")]).fetch({ watch: WATCH })).toMatchObject({ ok: false, failure: { kind: "server" } });
  });

  it("reads an RSS 1.0 feed in the form of the feed of JPCERT/CC", async () => {
    const rdf = `<?xml version="1.0" encoding="UTF-8"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <channel rdf:about="${ORIGIN}/rss.rdf"><title>Alerts</title><items><rdf:Seq><rdf:li rdf:resource="${ORIGIN}/at/1.html"/></rdf:Seq></items></channel>
      <item rdf:about="${ORIGIN}/at/1.html"><title>Security Alert: Example Updates</title><link>${ORIGIN}/at/1.html</link><dc:date>2026-11-11T11:21+09:00</dc:date></item></rdf:RDF>`;
    const { fetch } = fetchWith([xml(rdf)], { ...JPCERT, feed: `${ORIGIN}/rss.rdf` });
    const [head, body] = bodiesOf(await fetch({ watch: WATCH }));
    expect(head).toMatchObject({ newest: "2026-11-11T02:21:00.000Z", entries: 1, invalid: 0 });
    expect(body).toMatchObject({ key: `${ORIGIN}/at/1.html`, title: "Security Alert: Example Updates" });
  });
});

describe("the map", () => {
  const map = createCertMap(TEST);

  it("gives one report for an entry, with the CVE ids as subjects and correlation keys", () => {
    const time = NOW - DAY_MS;
    const result = map(observation(entry({ key: "/kev", title: "CISA Adds Two Known Exploited Vulnerabilities to Catalog", summary: "The text.", cves: ["CVE-2026-1001", "CVE-2026-1002"], time: new Date(time).toISOString() })));
    expect(result.problems).toEqual([]);
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]).toMatchObject({
      source: TEST.id,
      origin: "cisa",
      key: "/kev",
      kind: { code: EXPLOITED_KIND },
      categories: ["cyber"],
      severity: "unknown",
      urgency: "expected",
      certainty: "observed",
      sent: time,
      expires: time + ENTRY_LIFE_MS,
      headline: "CISA: CISA Adds Two Known Exploited Vulnerabilities to Catalog",
      description: "The text.",
      web: `${ORIGIN}/a`,
      about: [
        { system: "cve", id: "CVE-2026-1001" },
        { system: "cve", id: "CVE-2026-1002" },
      ],
      correlation: [
        { system: "cve", id: "CVE-2026-1001" },
        { system: "cve", id: "CVE-2026-1002" },
      ],
      parameters: { language: ["en"], terms: [TEST.terms.text] },
    });
  });

  it("gives the same report id for the same entry", () => {
    expect(map(observation(entry())).reports[0]?.id).toBe(map(observation(entry())).reports[0]?.id);
  });

  it("gives no report for the head, and a note with no report for an entry that no rule matches", () => {
    expect(map(observation({ feed: TEST.feed, newest: null, entries: 0, invalid: 0 }))).toEqual({ reports: [], problems: [] });
    const result = createCertMap(CERT_SE)(observation(entry({ title: "Veckobrev v.47" })));
    expect(result.reports).toEqual([]);
    expect(result.problems).toMatchObject([{ fatal: false, message: expect.stringContaining("no rule") }]);
  });

  it("gives a fatal problem for a body that is not an entry", () => {
    expect(map({ ...observation({}), body: "{" }).problems).toMatchObject([{ fatal: true }]);
    expect(map(observation({ key: 1 })).problems).toMatchObject([{ fatal: true, message: expect.stringContaining("format changed") }]);
  });
});

describe("the canary and the descriptor", () => {
  const head = (newest: number | null): Observation => observation({ feed: TEST.feed, newest: newest === null ? null : new Date(newest).toISOString(), entries: 1, invalid: 0 });

  it("passes when the newest entry is at most the age limit of the provider", () => {
    expect(checkCanary(TEST, [head(NOW - DAY_MS)])).toMatchObject({ pass: true });
    expect(checkCanary(TEST, [head(NOW - TEST.maxAge - DAY_MS)])).toMatchObject({ pass: false, reason: expect.stringContaining("the limit is 10 days") });
    expect(checkCanary(TEST, [head(null)])).toMatchObject({ pass: false });
    expect(newestOf("not json")).toBeUndefined();
  });

  it("gives the facts of each provider in its descriptor", () => {
    for (const provider of CERT_PROVIDERS) {
      expect(certDescriptor(provider)).toMatchObject({ id: provider.id, origins: [provider.origin], kinds: provider.kinds, interval: provider.interval, maxQuiet: provider.maxAge, auth: "none", transport: "poll" });
    }
  });

  it("gives the procedures of a source", async () => {
    const { source } = fetchWith([xml(rss(ITEMS))]);
    expect(source.describe().id).toBe(TEST.id as SourceId);
    const outcome = await source.fetch({ watch: WATCH });
    const observations = observationsOf(outcome);
    expect(source.check?.({ observations })).toMatchObject({ pass: true });
    expect(source.map({ observation: observations[1]! }).reports[0]?.kind.code).toBe(EXPLOITED_KIND);
  });
});
