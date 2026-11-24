import type { FetchOutcome, Observation, ObservationId, Report, SourceId, Watch } from "@mark1russell7/alerts";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";

import { checkCanary, newestOf } from "./check.ts";
import { csafDescriptor } from "./descriptor.ts";
import { productNames, readAdvisory, type AdvisoryBody, type RefusedBody } from "./document.ts";
import { readFeed, selectEntries } from "./feed.ts";
import { ADVISORIES_PER_FETCH, BACKFILL_MS, createCsafFetch, cursorOf, readCursor } from "./fetch.ts";
import { createCsafSource } from "./index.ts";
import { ADVISORY_LIFE_MS, createCsafMap, severityOfScore } from "./map.ts";
import { CSAF_PROVIDERS, DAY_MS, ICS_ADVISORY_KIND, type CsafProvider } from "./providers.ts";

const ORIGIN = "https://csaf.test";
const PROVIDER: CsafProvider = { ...CSAF_PROVIDERS[0]!, feed: `${ORIGIN}/csaf/feed-tlp-white.json` };
const NOW = Date.UTC(2026, 10, 24, 18, 0, 0);
const WATCH: Watch = { places: [] };
const iso = (time: number): string => new Date(time).toISOString();

/** A URL of an advisory document of the test provider. */
const docUrl = (id: string): string => `${ORIGIN}/csaf/2026/${id}.json`;

/** An entry of a ROLIE feed, in the form of the feed of CISA. */
const entry = (id: string, updated: number, url = docUrl(id)) => ({
  id,
  title: id,
  link: [{ rel: "self", href: url }],
  published: iso(updated),
  updated: iso(updated),
  content: { type: "application/json", src: url },
  format: { schema: "https://docs.oasis-open.org/csaf/csaf/v2.0/csaf_json_schema.json", version: "2.0" },
});
const feed = (entries: readonly unknown[]): string => JSON.stringify({ feed: { id: "test-feed", title: "Test advisories", updated: iso(NOW), entry: entries } });

interface DocumentOptions {
  readonly label?: string;
  readonly severity?: string;
  readonly scores?: readonly number[];
  readonly revisions?: number;
  readonly fix?: boolean;
}

/** A CSAF 2.0 document in the form of a CISA ICS advisory. The names and the texts are synthetic. */
const csaf = (id: string, current: number, options: DocumentOptions = {}): string =>
  JSON.stringify({
    document: {
      category: "csaf_security_advisory",
      csaf_version: "2.0",
      title: ` Example Controls Gateway `,
      publisher: { category: "coordinator", name: "CISA", namespace: "https://www.cisa.gov/" },
      distribution: { tlp: { label: options.label ?? "WHITE", url: "https://www.first.org/tlp/" } },
      ...(options.severity === undefined ? {} : { aggregate_severity: { text: options.severity } }),
      notes: [
        { category: "legal_disclaimer", text: "The text of the disclaimer.", title: "Legal Notice" },
        { category: "summary", text: " Successful exploitation could let an attacker run code on the gateway. ", title: "Risk evaluation" },
      ],
      references: [
        { category: "self", summary: "The JSON file", url: docUrl(id) },
        { category: "self", summary: "The page", url: `https://www.example.org/advisories/${id}` },
      ],
      tracking: {
        id,
        version: String(options.revisions ?? 1),
        status: "final",
        initial_release_date: iso(current - 3 * DAY_MS),
        current_release_date: iso(current),
        revision_history: Array.from({ length: options.revisions ?? 1 }, (_, index) => ({ number: String(index + 1), date: iso(current), summary: "Release" })),
      },
    },
    product_tree: {
      branches: [{ category: "vendor", name: "Example", branches: [{ category: "product_name", name: "Gateway", branches: [{ category: "product_version_range", name: "<4.2", product: { name: "Example Gateway <4.2", product_id: "CSAFPID-0001" } }] }] }],
    },
    vulnerabilities: (options.scores ?? [9.8, 7.5]).map((score, index) => ({
      cve: `CVE-2026-${String(1000 + index)}`,
      cwe: { id: "CWE-787", name: "Out-of-bounds Write" },
      scores: [{ cvss_v3: { baseScore: score, baseSeverity: "CRITICAL", vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", version: "3.1" }, products: ["CSAFPID-0001"] }],
      remediations: options.fix === false ? [{ category: "mitigation", details: "Isolate the gateway.", product_ids: ["CSAFPID-0001"] }] : [{ category: "vendor_fix", details: "Update to 4.2.", product_ids: ["CSAFPID-0001"] }],
    })),
  });

const json = (body: string, status = 200, headers: Record<string, string> = {}): Reply => ({ status, statusText: status === 200 ? "OK" : "Error", headers: { "content-type": "application/json", ...headers }, body });

/** This function makes a fetch whose transport gives the reply of `routes` for each URL, and a 404 for each other URL. */
const fetchWith = (routes: Map<string, Reply>, start = NOW) => {
  const sent: Exchange[] = [];
  const transport: Transport = async (exchange) => {
    sent.push(exchange);
    return routes.get(exchange.url) ?? json("{}", 404);
  };
  const clock = { now: () => start, sleep: async () => undefined };
  const options = { pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport, userAgent: "alerts-tests", minIntervalMs: 0, timeoutMs: 1000 };
  return { fetch: createCsafFetch(PROVIDER, options), source: createCsafSource(PROVIDER, options), sent };
};
const observationsOf = (outcome: FetchOutcome): readonly Observation[] => (outcome.ok ? outcome.observations : []);
const bodiesOf = (outcome: FetchOutcome): readonly Record<string, unknown>[] => observationsOf(outcome).map((observation) => JSON.parse(observation.body) as Record<string, unknown>);

const observation = (body: unknown): Observation => ({
  id: "obs-1" as ObservationId,
  source: PROVIDER.id,
  fetched: NOW,
  contentType: "application/json",
  body: JSON.stringify(body),
  transport: { url: docUrl("x"), status: 200, latency: 10 },
});
const advisory = (id: string, options: DocumentOptions = {}): AdvisoryBody => readAdvisory(csaf(id, NOW - DAY_MS, options), docUrl(id)) as AdvisoryBody;
const map = createCsafMap(PROVIDER);
const reportOf = (body: unknown): Report => {
  const result = map(observation(body));
  expect(result.problems).toEqual([]);
  return result.reports[0]!;
};

describe("the feed", () => {
  it("reads each entry with its URL and time, in the order of the time, and counts the bad entries", () => {
    const read = readFeed(feed([entry("b", NOW - DAY_MS), entry("a", NOW - 2 * DAY_MS), { id: "c", updated: "never" }, { id: "d", updated: iso(NOW) }]));
    expect(read).toEqual({ entries: [{ url: docUrl("a"), updated: NOW - 2 * DAY_MS }, { url: docUrl("b"), updated: NOW - DAY_MS }], invalid: 2 });
  });

  it("takes the content source when an entry has no link self", () => {
    const { link: _, ...noLink } = entry("a", NOW);
    expect(readFeed(feed([noLink]))?.entries).toEqual([{ url: docUrl("a"), updated: NOW }]);
  });

  it("gives no feed for a text that is not a ROLIE feed", () => {
    expect(readFeed("<html>")).toBeUndefined();
    expect(readFeed(JSON.stringify({ feed: {} }))).toBeUndefined();
  });

  it("selects the entries after the cursor, or since a time with no cursor, at most the limit", () => {
    const entries = readFeed(feed([1, 2, 3, 4, 5].map((day) => entry(`e${String(day)}`, NOW - (10 - day) * DAY_MS))))!.entries;
    expect(selectEntries(entries, undefined, NOW - 7 * DAY_MS, 10).read.map((each) => each.url)).toEqual([docUrl("e3"), docUrl("e4"), docUrl("e5")]);
    expect(selectEntries(entries, entries[1], 0, 2)).toEqual({ read: [entries[2], entries[3]], later: 1 });
    expect(selectEntries(entries, entries[4], 0, 2)).toEqual({ read: [], later: 0 });
  });

  it("orders two entries with the same time by their URL, so the cursor passes each one once", () => {
    const entries = readFeed(feed([entry("b", NOW), entry("a", NOW)]))!.entries;
    expect(selectEntries(entries, entries[0], 0, 10).read).toEqual([entries[1]]);
  });
});

describe("the cursor", () => {
  it("keeps the time and the URL of the last entry", () => {
    const last = { url: docUrl("a"), updated: NOW };
    expect(readCursor(cursorOf(last))).toEqual(last);
  });

  it("reads a cursor with no valid time or URL as a first fetch", () => {
    expect(readCursor(undefined)).toBeUndefined();
    expect(readCursor({ updated: "never", url: docUrl("a") })).toBeUndefined();
    expect(readCursor({ updated: iso(NOW) })).toBeUndefined();
  });
});

describe("the document", () => {
  it("keeps the fields that the map uses", () => {
    expect(advisory("icsa-26-001-01")).toEqual({
      url: docUrl("icsa-26-001-01"),
      page: "https://www.example.org/advisories/icsa-26-001-01",
      id: "icsa-26-001-01",
      version: "1",
      status: "final",
      revisions: 1,
      initial: iso(NOW - 4 * DAY_MS),
      current: iso(NOW - DAY_MS),
      title: "Example Controls Gateway",
      publisher: "CISA",
      tlp: "WHITE",
      summary: "Successful exploitation could let an attacker run code on the gateway.",
      flaws: [
        { cve: "CVE-2026-1000", score: 9.8, cwe: "CWE-787" },
        { cve: "CVE-2026-1001", score: 7.5, cwe: "CWE-787" },
      ],
      products: ["Example Gateway <4.2"],
      fix: true,
    });
  });

  it("refuses a document that is not for sharing, and a text that is not a CSAF document", () => {
    expect(readAdvisory(csaf("a", NOW, { label: "AMBER" }), docUrl("a"))).toMatchObject({ refused: "label" });
    expect(readAdvisory(csaf("a", NOW, { label: "CLEAR" }), docUrl("a"))).toMatchObject({ tlp: "CLEAR" });
    expect(readAdvisory("{}", docUrl("a"))).toMatchObject({ refused: "format" });
    expect(readAdvisory("<html>", docUrl("a"))).toMatchObject({ refused: "format" });
  });

  it("keeps at most 12 product names of a large product tree", () => {
    const branches = Array.from({ length: 40 }, (_, index) => ({ name: `v${String(index)}`, product: { name: `Product ${String(index)}`, product_id: String(index) } }));
    expect(productNames({ full_product_names: [{ name: "Named" }], branches })).toHaveLength(12);
  });
});

describe("the fetch", () => {
  const recent = [1, 2, 3].map((hours) => entry(`icsa-26-${String(hours)}`, NOW - hours * 3_600_000));
  const old = entry("icsa-25-old", NOW - BACKFILL_MS - DAY_MS);

  it("reads only the advisories of the last 7 days with no cursor, and names the newest in the cursor", async () => {
    const routes = new Map([[PROVIDER.feed, json(feed([old, ...recent]))], ...recent.map((each) => [each.link[0]!.href, json(csaf(each.id, Date.parse(each.updated)))] as const)]);
    const { fetch, sent } = fetchWith(routes);
    const outcome = await fetch({ watch: WATCH });
    expect(outcome).toMatchObject({ ok: true, complete: true, cursor: cursorOf({ url: docUrl("icsa-26-1"), updated: NOW - 3_600_000 }) });
    expect(sent.map((exchange) => exchange.url)).toEqual([PROVIDER.feed, docUrl("icsa-26-3"), docUrl("icsa-26-2"), docUrl("icsa-26-1")]);
    expect(bodiesOf(outcome)[0]).toEqual({ feed: PROVIDER.feed, newest: iso(NOW - 3_600_000), entries: 4, invalid: 0 });
    expect(bodiesOf(outcome).slice(1).map((body) => body["id"])).toEqual(["icsa-26-3", "icsa-26-2", "icsa-26-1"]);
  });

  it("reads only the entries after the cursor", async () => {
    const routes = new Map([[PROVIDER.feed, json(feed([old, ...recent]))], [docUrl("icsa-26-1"), json(csaf("icsa-26-1", NOW))]]);
    const { fetch, sent } = fetchWith(routes);
    const outcome = await fetch({ watch: WATCH, cursor: cursorOf({ url: docUrl("icsa-26-2"), updated: NOW - 2 * 3_600_000 }) });
    expect(sent.map((exchange) => exchange.url)).toEqual([PROVIDER.feed, docUrl("icsa-26-1")]);
    expect(outcome).toMatchObject({ ok: true, cursor: cursorOf({ url: docUrl("icsa-26-1"), updated: NOW - 3_600_000 }) });
  });

  it("names the newest entry when a first fetch has nothing to read, so it does not read the old advisories later", async () => {
    const { fetch, sent } = fetchWith(new Map([[PROVIDER.feed, json(feed([old]))]]));
    const outcome = await fetch({ watch: WATCH });
    expect(sent).toHaveLength(1);
    expect(outcome).toMatchObject({ ok: true, complete: true, cursor: cursorOf({ url: docUrl("icsa-25-old"), updated: Date.parse(old.updated) }) });
  });

  it(`reads at most ${String(ADVISORIES_PER_FETCH)} documents, and the cursor names the last one`, async () => {
    const many = Array.from({ length: 25 }, (_, index) => entry(`m${String(100 + index)}`, NOW - (25 - index) * 60_000));
    const routes = new Map([[PROVIDER.feed, json(feed(many))], ...many.map((each) => [each.link[0]!.href, json(csaf(each.id, NOW))] as const)]);
    const { fetch } = fetchWith(routes);
    const outcome = await fetch({ watch: WATCH });
    expect(observationsOf(outcome)).toHaveLength(1 + ADVISORIES_PER_FETCH);
    expect(outcome).toMatchObject({ cursor: cursorOf({ url: docUrl("m109"), updated: Date.parse(many[9]!.updated) }) });
  });

  it("passes a document that is not found, and stops at a server failure, with the cursor before it", async () => {
    const routes = new Map([[PROVIDER.feed, json(feed(recent))], [docUrl("icsa-26-2"), json("{}", 503)]]);
    const { fetch } = fetchWith(routes);
    const outcome = await fetch({ watch: WATCH });
    // icsa-26-3 is not found: it is passed. icsa-26-2 has a server failure: the next fetch reads it again.
    expect(outcome).toMatchObject({ ok: true, complete: false, cursor: cursorOf({ url: docUrl("icsa-26-3"), updated: NOW - 3 * 3_600_000 }) });
    expect(observationsOf(outcome)).toHaveLength(1);
  });

  it("stops at a document that the host blocks", async () => {
    const routes = new Map([[PROVIDER.feed, json(feed(recent))], [docUrl("icsa-26-3"), json("{}", 403)]]);
    const outcome = await fetchWith(routes).fetch({ watch: WATCH });
    expect(outcome).toMatchObject({ ok: true, complete: false });
    expect(outcome.ok && outcome.cursor).toBeFalsy();
  });

  it("follows no link to another host", async () => {
    const away = entry("away", NOW - 60_000, "https://elsewhere.test/csaf/away.json");
    const { fetch, sent } = fetchWith(new Map([[PROVIDER.feed, json(feed([away]))]]));
    const outcome = await fetch({ watch: WATCH });
    expect(sent.map((exchange) => exchange.url)).toEqual([PROVIDER.feed]);
    expect(outcome).toMatchObject({ ok: true, cursor: cursorOf({ url: away.link[0]!.href, updated: NOW - 60_000 }) });
  });

  it("selects from the last feed after a 304, and fails a 304 with no earlier feed", async () => {
    const routes = new Map([[PROVIDER.feed, json(feed(recent), 200, { etag: '"v1"' })]]);
    const { fetch, sent } = fetchWith(routes);
    await fetch({ watch: WATCH, cursor: cursorOf({ url: docUrl("icsa-26-1"), updated: NOW - 3_600_000 }) });
    routes.set(PROVIDER.feed, json("", 304));
    const again = await fetch({ watch: WATCH, cursor: cursorOf({ url: docUrl("icsa-26-2"), updated: NOW - 2 * 3_600_000 }) });
    expect(sent[1]!.headers["if-none-match"]).toBe('"v1"');
    expect(observationsOf(again)).toHaveLength(1);
    expect(bodiesOf(again)[0]).toMatchObject({ entries: 3 });
    const cold = await fetchWith(new Map([[PROVIDER.feed, json("", 304)]])).fetch({ watch: WATCH });
    expect(cold).toMatchObject({ ok: false, failure: { kind: "network" } });
  });

  it("fails a feed that does not parse", async () => {
    const outcome = await fetchWith(new Map([[PROVIDER.feed, json('{"feed": ')]])).fetch({ watch: WATCH });
    expect(outcome).toMatchObject({ ok: false, failure: { kind: "network" } });
  });

  it("gives a failure of the feed", async () => {
    const outcome = await fetchWith(new Map([[PROVIDER.feed, json("{}", 503)]])).fetch({ watch: WATCH });
    expect(outcome).toMatchObject({ ok: false, failure: { kind: "server" } });
  });
});

describe("the map", () => {
  it("gives one report for each advisory, with each CVE as a subject and a correlation key", () => {
    const report = reportOf(advisory("icsa-26-001-01"));
    expect(report).toMatchObject({
      source: PROVIDER.id,
      origin: "cisa",
      key: "icsa-26-001-01",
      correlation: [
        { system: "cve", id: "CVE-2026-1000" },
        { system: "cve", id: "CVE-2026-1001" },
      ],
      status: "actual",
      op: "alert",
      kind: { code: ICS_ADVISORY_KIND },
      categories: ["cyber"],
      severity: "severe",
      urgency: "future",
      certainty: "observed",
      response: ["execute"],
      sent: NOW - DAY_MS,
      received: NOW,
      effective: NOW - 4 * DAY_MS,
      expires: NOW - DAY_MS + ADVISORY_LIFE_MS,
      areas: [],
      sender: "CISA",
      headline: "icsa-26-001-01: Example Controls Gateway",
      web: "https://www.example.org/advisories/icsa-26-001-01",
    });
    expect(report.about).toEqual([
      { system: "cve", id: "CVE-2026-1000", label: "Example Gateway <4.2" },
      { system: "cve", id: "CVE-2026-1001", label: "Example Gateway <4.2" },
    ]);
    expect(report.parameters).toMatchObject({ cvss: ["9.8"], cwe: ["CWE-787"], tlp: ["WHITE"], terms: [PROVIDER.terms.text] });
  });

  it("takes the severity from the aggregate severity, else from the highest CVSS score", () => {
    expect(reportOf(advisory("a", { severity: "Important", scores: [9.8] })).severity).toBe("moderate");
    expect(reportOf(advisory("a", { severity: "unrated", scores: [5.3] })).severity).toBe("minor");
    expect(reportOf(advisory("a", { scores: [] })).severity).toBe("unknown");
    expect([9, 8.9, 7, 6.9, undefined].map(severityOfScore)).toEqual(["severe", "moderate", "moderate", "minor", "unknown"]);
  });

  it("marks a new version as an update, and asks for an assessment when the vendor has no fix", () => {
    const report = reportOf(advisory("a", { revisions: 3, fix: false }));
    expect(report.op).toBe("update");
    expect(report.response).toEqual(["assess"]);
    expect(report.instruction).toBeUndefined();
  });

  it("links the JSON file when the advisory names no page", () => {
    const { page: _, ...body } = advisory("a");
    expect(reportOf(body).web).toBe(docUrl("a"));
  });

  it("gives no report for the head of the feed", () => {
    expect(map(observation({ feed: PROVIDER.feed, newest: iso(NOW), entries: 3, invalid: 0 }))).toEqual({ reports: [], problems: [] });
  });

  it("gives a note for a document that is not for sharing, and a fatal problem for a document that it does not understand", () => {
    const label: RefusedBody = { url: docUrl("a"), refused: "label", message: "the TLP label of a is AMBER" };
    const format: RefusedBody = { url: docUrl("a"), refused: "format", message: "the document is not JSON" };
    expect(map(observation(label)).problems).toEqual([{ path: "", message: `the TLP label of a is AMBER (${docUrl("a")})`, fatal: false }]);
    expect(map(observation(format)).problems[0]).toMatchObject({ fatal: true });
    expect(map(observation({ other: true })).problems[0]).toMatchObject({ fatal: true });
  });

  it("leaves out a flaw id that is not a CVE id, with a lossy problem", () => {
    const body = { ...advisory("a"), flaws: [{ cve: "not-a-cve", score: 9 }, { cve: "CVE-2026-1000", score: 5 }] };
    const result = map(observation(body));
    expect(result.reports[0]!.correlation).toEqual([{ system: "cve", id: "CVE-2026-1000" }]);
    expect(result.problems).toMatchObject([{ path: "flaws[0].cve", fatal: false, lossy: true }]);
  });
});

describe("the canary", () => {
  const head = (newest: number | null): Observation => observation({ feed: PROVIDER.feed, newest: newest === null ? null : iso(newest), entries: 1, invalid: 0 });

  it("passes when the newest advisory is in the limit of the provider", () => {
    expect(checkCanary(PROVIDER, [head(NOW - 13 * DAY_MS)]).pass).toBe(true);
    expect(checkCanary(PROVIDER, [head(NOW - 15 * DAY_MS)])).toEqual({ pass: false, reason: `the newest advisory has the time ${iso(NOW - 15 * DAY_MS)}, 15.0 days before the fetch: the limit is 14 days` });
  });

  it("fails with no head, or a feed with no entry", () => {
    expect(checkCanary(PROVIDER, []).pass).toBe(false);
    expect(checkCanary(PROVIDER, [head(null)]).pass).toBe(false);
    expect(newestOf("{}")).toBeUndefined();
  });
});

describe("the providers", () => {
  it("have unique ids, HTTPS feeds, and the kinds of the taxonomy", () => {
    expect(new Set(CSAF_PROVIDERS.map((provider) => provider.id)).size).toBe(CSAF_PROVIDERS.length);
    for (const provider of CSAF_PROVIDERS) {
      expect(new URL(provider.feed).protocol).toBe("https:");
      expect(csafDescriptor(provider)).toMatchObject({ id: provider.id, origins: [provider.origin], kinds: [provider.kind], auth: "none" });
      expect(provider.maxAge).toBeGreaterThan(provider.interval);
    }
  });

  it("make sources with a describe, a fetch, a map and a check", async () => {
    const { source } = fetchWith(new Map([[PROVIDER.feed, json(feed([]))]]));
    expect(source.describe().id).toBe("csaf-cisa-ics" as SourceId);
    const outcome = await source.fetch({ watch: WATCH });
    expect(outcome).toMatchObject({ ok: true, complete: true });
    expect(source.check?.({ observations: observationsOf(outcome) })).toMatchObject({ pass: false });
  });
});
