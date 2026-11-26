import { readFileSync } from "node:fs";

import { incidents, normalize, observeCut, type AssessPolicy, type FetchOutcome, type Observation, type ObservationId, type PersonId, type PersonWatch, type SourceId, type Watch } from "@mark1russell7/alerts";
import { osvPackagePurl, osvPurl } from "@mark1russell7/package-id";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";

import { fileBody, isRecordBody, type HeadBody, type RecordBody } from "./body.ts";
import { orderOf, positionText, readChanges, readPosition, selectChanges } from "./changes.ts";
import { checkCanary } from "./check.ts";
import { osvDescriptor } from "./descriptor.ts";
import { isCutRange, LARGE_LIST_BYTES, LIST_BYTES } from "./exports.ts";
import { createOsvFetch } from "./fetch.ts";
import { readComparison, readGithubCursor, recordFiles } from "./github.ts";
import { createOsvSource } from "./index.ts";
import { createOsvMap, CVE_SYSTEM, OSV_SYSTEM, PURL_SYSTEM, RECORD_LIFE_MS } from "./map.ts";
import { RECORDS_PER_FETCH } from "./options.ts";
import { cwesOf, isWithdrawn, readOsv, readOsvText } from "./osv.ts";
import { DAY_MS, MALICIOUS_KIND, OSV_PROVIDERS, type GithubFeed, type OsvProvider } from "./providers.ts";

const NOW = Date.UTC(2026, 10, 25, 17, 30, 0);
const WATCH: Watch = { places: [] };
const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const MALICIOUS = fixture("MAL-2026-20607.json");
const WITHDRAWN = fixture("MAL-2026-5587.json");
const ADVISORY = fixture("GHSA-crj3-q72p-ggqm.json");
const LIST = fixture("npm-modified_id.csv");
const providerOf = (id: string): OsvProvider => OSV_PROVIDERS.find((provider) => provider.id === id)!;
const EXPORTS = providerOf("osv-export-malicious");
const GITHUB = providerOf("ossf-malicious-packages");
const BUCKET = "https://bucket.test";
const API = "https://api.test";
const RAW = "https://raw.test";

const reply = (body: string, status = 200, headers: Record<string, string> = {}): Reply => ({ status, statusText: status < 300 ? "OK" : "Error", headers, body });

/** This function makes a fetch whose transport gives the reply of `answer` for each request. */
const fetchWith = (provider: OsvProvider, answer: (exchange: Exchange) => Reply) => {
  const sent: Exchange[] = [];
  const transport: Transport = async (exchange) => {
    sent.push(exchange);
    return answer(exchange);
  };
  const clock = { now: () => NOW, sleep: async () => undefined };
  const options = { pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport, userAgent: "alerts-tests", baseUrl: provider.feed.type === "exports" ? BUCKET : API, rawUrl: RAW, minIntervalMs: 0, timeoutMs: 1000 };
  return { fetch: createOsvFetch(provider, options), source: createOsvSource(provider, options), sent };
};
const observationsOf = (outcome: FetchOutcome): readonly Observation[] => (outcome.ok ? outcome.observations : []);
const bodiesOf = (outcome: FetchOutcome): readonly Record<string, unknown>[] => observationsOf(outcome).map((observation) => JSON.parse(observation.body) as Record<string, unknown>);
const cursorOf = (outcome: FetchOutcome): Readonly<Record<string, string>> => (outcome.ok ? (outcome.cursor ?? {}) : {});

const observation = (body: unknown, source: SourceId = EXPORTS.id): Observation => ({
  id: "obs-1" as ObservationId,
  source,
  fetched: NOW,
  contentType: "application/json",
  body: JSON.stringify(body),
  transport: { url: `${BUCKET}/npm/x.json`, status: 200, latency: 10 },
});
const bodyOf = (text: string): RecordBody => {
  const body = fileBody(text, `${BUCKET}/npm/record.json`);
  if (!isRecordBody(body)) throw new Error("the fixture is not a record");
  return body;
};

describe("the providers", () => {
  it("gives two sources of one origin, with the kind of malicious packages", () => {
    expect(OSV_PROVIDERS.map((provider) => provider.id)).toEqual(["osv-export-malicious", "ossf-malicious-packages"]);
    for (const provider of OSV_PROVIDERS) {
      expect(provider.origin).toBe("ossf");
      expect(provider.kind).toBe(MALICIOUS_KIND);
      expect(provider.prefixes).toEqual(["MAL-"]);
      const descriptor = osvDescriptor(provider);
      expect(descriptor.kinds).toEqual([MALICIOUS_KIND]);
      expect(descriptor.auth).toBe("none");
      expect(descriptor.maxQuiet).toBe(provider.maxAge);
    }
  });

  it("keeps the GitHub source to one request of the API in each hour", () => {
    expect(GITHUB.interval).toBeGreaterThanOrEqual(60 * 60_000);
  });
});

describe("the OSV reader", () => {
  it("reads the three fixtures, and drops the credits", () => {
    for (const text of [MALICIOUS, WITHDRAWN, ADVISORY]) {
      const read = readOsvText(text);
      expect(read.ok).toBe(true);
      if (read.ok) expect(Object.keys(read.record)).not.toContain("credits");
    }
    const read = readOsvText(MALICIOUS);
    if (!read.ok) throw new Error(read.message);
    expect(read.record.id).toBe("MAL-2026-20607");
    expect(read.record.affected[0]!.package).toEqual({ ecosystem: "npm", name: "paystation-embed-app", purl: "pkg:npm/paystation-embed-app" });
    expect(read.record.modified).toBe(Date.parse("2026-11-25T16:30:05.761Z"));
    expect(cwesOf(read.record)).toEqual(["CWE-506"]);
  });

  it("reads the aliases, the ranges and the severity of an advisory", () => {
    const read = readOsvText(ADVISORY);
    if (!read.ok) throw new Error(read.message);
    expect(read.record.aliases).toEqual(["CVE-2026-64670"]);
    expect(read.record.affected[0]!.ranges[0]!.type).toBe("SEMVER");
    expect(read.record.affected[0]!.ranges[0]!.events).toEqual([{ name: "introduced", version: "0" }, { name: "last_affected", version: "3.16.2" }]);
    expect(read.record.severity.length).toBeGreaterThan(0);
  });

  it("refuses a record that breaks the schema, with the path of the bad field", () => {
    const record = JSON.parse(MALICIOUS) as Record<string, unknown>;
    expect(readOsv({ ...record, id: undefined })).toMatchObject({ ok: false, path: "id" });
    expect(readOsv({ ...record, modified: "yesterday" })).toMatchObject({ ok: false, path: "modified" });
    expect(readOsv({ ...record, affected: "npm" })).toMatchObject({ ok: false, path: "affected" });
    expect(readOsv([])).toMatchObject({ ok: false, path: "" });
    expect(readOsvText("{")).toMatchObject({ ok: false });
    expect(fileBody("{", `${BUCKET}/npm/x.json`)).toMatchObject({ refused: "format" });
  });

  it("tells a withdrawn record from its time", () => {
    const read = readOsvText(WITHDRAWN);
    if (!read.ok) throw new Error(read.message);
    expect(isWithdrawn(read.record, NOW)).toBe(true);
    expect(isWithdrawn(read.record, Date.UTC(2026, 6, 1))).toBe(false);
  });
});

describe("the purl of a package", () => {
  it("gives the purl of each ecosystem with a purl type", () => {
    expect(osvPurl("npm", "@waline/client")).toBe("pkg:npm/%40waline/client");
    expect(osvPurl("PyPI", "Mcp_Diag.Tool")).toBe("pkg:pypi/mcp-diag-tool");
    expect(osvPurl("crates.io", "besk")).toBe("pkg:cargo/besk");
    expect(osvPurl("RubyGems", "rails")).toBe("pkg:gem/rails");
    expect(osvPurl("Maven", "org.example:core")).toBe("pkg:maven/org.example/core");
    expect(osvPurl("Debian:12", "openssl")).toBe("pkg:deb/debian/openssl");
    expect(osvPurl("VSCode", "example.theme")).toBeUndefined();
  });

  it("takes the purl of the record first, with no version", () => {
    expect(osvPackagePurl({ ecosystem: "npm", name: "a", purl: "pkg:npm/a@1.0.0?arch=x#sub" })).toBe("pkg:npm/a");
    expect(osvPackagePurl({ ecosystem: "npm", name: "b" })).toBe("pkg:npm/b");
  });
});

describe("the change list", () => {
  it("reads the lines of a cut list, and drops the part of the last line", () => {
    const whole = readChanges(LIST, false);
    expect(whole.changes.length).toBe(40);
    expect(whole.invalid).toBe(0);
    const cut = readChanges(LIST.slice(0, LIST.length - 10), true);
    expect(cut.changes.length).toBe(39);
    expect(orderOf("2026-11-25T16:30:05.76169863Z")).toBe("2026-11-25T16:30:05.761698630");
    expect(orderOf("2026-11-25T16:30:05Z")).toBe("2026-11-25T16:30:05.000000000");
  });

  it("selects only the MAL changes after the position, the oldest first", () => {
    const list = readChanges(LIST, true);
    const tenth = list.changes[9]!;
    const selection = selectChanges(list, tenth, ["MAL-"], true);
    expect(selection.reached).toBe(true);
    const newer = list.changes.slice(0, 9).filter((change) => change.id.startsWith("MAL-"));
    expect(selection.fresh.map((change) => change.id)).toEqual(newer.map((change) => change.id).reverse());
    expect(selection.fresh.map((change) => change.id)).not.toContain("GHSA-crj3-q72p-ggqm");
    // A cut list whose oldest line is after the position does not reach it.
    expect(selectChanges(list, { order: "2026-11-01T00:00:00.000000000", id: "" }, ["MAL-"], true).reached).toBe(false);
  });

  it("writes and reads a position of the cursor", () => {
    const position = { order: "2026-11-25T16:30:05.761698630", id: "MAL-2026-20607" };
    expect(readPosition(positionText(position))).toEqual(position);
    expect(readPosition("yesterday MAL-1")).toBeUndefined();
    expect(readPosition(undefined)).toBeUndefined();
  });

  it("tells a cut part from a whole file", () => {
    expect(isCutRange("bytes 0-65535/8839046")).toBe(true);
    expect(isCutRange("bytes 0-99/100")).toBe(false);
    expect(isCutRange(undefined)).toBe(true);
  });
});

describe("the fetch of the exports", () => {
  const records: Readonly<Record<string, string>> = { "MAL-2026-20607": MALICIOUS };
  const bucket =
    (etag: string) =>
    (exchange: Exchange): Reply => {
      const path = new URL(exchange.url).pathname;
      if (path.endsWith("/modified_id.csv")) {
        if (exchange.headers["if-none-match"] === etag) return reply("", 304, { etag });
        // Only npm has changes: the first part of its list. The other lists are whole and empty.
        if (!path.startsWith("/npm/")) return reply("", 200, { etag, "content-type": "text/csv" });
        return reply(LIST, 206, { etag, "content-range": `bytes 0-${String(LIST.length - 1)}/8839046`, "content-type": "text/csv" });
      }
      const id = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1, -".json".length));
      return records[id] === undefined ? reply("", 404) : reply(records[id], 200, { "content-type": "application/json" });
    };

  it("reads only the changed MAL records after the cursor, and moves the cursor", async () => {
    const list = readChanges(LIST, true);
    const tenth = list.changes[9]!;
    const { fetch, sent } = fetchWith(EXPORTS, bucket('"v1"'));
    const outcome = await fetch({ watch: WATCH, cursor: { npm: positionText(tenth), PyPI: positionText(tenth) } }, undefined);
    expect(outcome.ok).toBe(true);
    const lists = sent.filter((exchange) => exchange.url.endsWith("/modified_id.csv"));
    expect(lists[0]!.headers["range"]).toBe(`bytes=0-${String(LIST_BYTES - 1)}`);
    const files = sent.filter((exchange) => !exchange.url.endsWith("/modified_id.csv")).map((exchange) => decodeURIComponent(exchange.url.slice(exchange.url.lastIndexOf("/") + 1)));
    const fresh = list.changes.slice(0, 9).filter((change) => change.id.startsWith("MAL-")).map((change) => `${change.id}.json`).reverse();
    expect(files).toEqual(fresh);
    expect(sent.length).toBeLessThanOrEqual(30);
    const bodies = bodiesOf(outcome);
    const head = bodies[0] as unknown as HeadBody;
    expect(head.read).toBe(fresh.length);
    expect(head.pending).toBe(0);
    expect(head.newest).toBe(list.changes[0]!.time);
    // The bucket has one of the records. A record that it does not find gives no observation.
    expect(bodies.slice(1).map((body) => body["id"])).toEqual(["MAL-2026-20607"]);
    expect(readPosition(cursorOf(outcome)["npm"])).toEqual({ order: list.changes[0]!.order, id: list.changes[0]!.id });
  });

  it("reads no record and no list text again when the lists did not change", async () => {
    const tenth = positionText(readChanges(LIST, true).changes[9]!);
    const { fetch, sent } = fetchWith(EXPORTS, bucket('"v1"'));
    const first = await fetch({ watch: WATCH, cursor: { npm: tenth } }, undefined);
    expect((bodiesOf(first)[0] as unknown as HeadBody).pending).toBe(0);
    const count = sent.length;
    const second = await fetch({ watch: WATCH, cursor: cursorOf(first) }, undefined);
    const again = sent.slice(count);
    expect(again.length).toBeGreaterThan(0);
    expect(again.every((exchange) => exchange.url.endsWith("/modified_id.csv") && exchange.headers["if-none-match"] === '"v1"')).toBe(true);
    expect(observationsOf(second)).toHaveLength(1);
    expect(cursorOf(second)).toEqual(cursorOf(first));
  });

  it("reads at most RECORDS_PER_FETCH records with no cursor, and the rest in the next fetch", async () => {
    const { fetch, sent } = fetchWith(EXPORTS, bucket('"v1"'));
    const first = await fetch({ watch: WATCH }, undefined);
    const head = bodiesOf(first)[0] as unknown as HeadBody;
    expect(head.read).toBe(RECORDS_PER_FETCH);
    expect(head.pending).toBeGreaterThan(0);
    const count = sent.length;
    const second = await fetch({ watch: WATCH, cursor: cursorOf(first) }, undefined);
    const next = bodiesOf(second)[0] as unknown as HeadBody;
    expect(next.read).toBe(Math.min(RECORDS_PER_FETCH, head.pending));
    const firstIds = new Set(sent.slice(0, count).map((exchange) => exchange.url));
    expect(sent.slice(count).some((exchange) => !exchange.url.endsWith("/modified_id.csv") && firstIds.has(exchange.url))).toBe(false);
  });

  it("reads a larger part when the first part does not reach the position, and tells of a gap", async () => {
    const { fetch, sent } = fetchWith(EXPORTS, bucket('"v1"'));
    const outcome = await fetch({ watch: WATCH, cursor: { npm: "2026-11-01T00:00:00.000000000 MAL-2026-1" } }, undefined);
    const ranges = sent.filter((exchange) => exchange.url.includes("/npm/modified_id.csv")).map((exchange) => exchange.headers["range"]);
    expect(ranges).toEqual([`bytes=0-${String(LIST_BYTES - 1)}`, `bytes=0-${String(LARGE_LIST_BYTES - 1)}`]);
    expect((bodiesOf(outcome)[0] as unknown as HeadBody).gap).toBe(true);
  });

  it("stops at a refusal of the host, and keeps the cursor before the refused record", async () => {
    const answer = bucket('"v1"');
    const { fetch } = fetchWith(EXPORTS, (exchange) => (exchange.url.endsWith("/modified_id.csv") ? answer(exchange) : reply("", 403)));
    const list = readChanges(LIST, true);
    const tenth = positionText(list.changes[9]!);
    const outcome = await fetch({ watch: WATCH, cursor: { npm: tenth } }, undefined);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.complete).toBe(false);
    expect(cursorOf(outcome)["npm"]).toBe(tenth);
  });
});

describe("the fetch of the GitHub repository", () => {
  const COMPARE = fixture("compare.json");
  const COMMITS = fixture("commits.json");
  const BASE = "996f37a73e3ee08e7f0242d632b55b4a63879074";
  const HEAD = "aa96d1277b";
  const github = (exchange: Exchange): Reply => {
    const url = new URL(exchange.url);
    if (url.origin === API && url.pathname.endsWith("/commits")) return reply(COMMITS, 200, { etag: '"c1"' });
    if (url.origin === API && url.pathname.includes("/compare/")) return exchange.headers["if-none-match"] === '"k1"' ? reply("", 304, { etag: '"k1"' }) : reply(COMPARE, 200, { etag: '"k1"' });
    if (url.origin === RAW && url.pathname.endsWith("/MAL-2026-20612.json")) return reply(MALICIOUS, 200);
    return reply("", 404);
  };

  it("reads the newest commit and no record in the first fetch", async () => {
    const { fetch, sent } = fetchWith(GITHUB, github);
    const outcome = await fetch({ watch: WATCH }, undefined);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${API}/repos/ossf/malicious-packages/commits?sha=main&per_page=1`);
    expect(sent[0]!.headers["accept"]).toBe("application/vnd.github+json");
    expect(sent[0]!.headers["authorization"]).toBeUndefined();
    expect(readGithubCursor(cursorOf(outcome))?.base.startsWith(HEAD)).toBe(true);
    expect(observationsOf(outcome)).toHaveLength(1);
  });

  it("reads each new MAL file of the compare at the head commit, with one request to the API", async () => {
    const { fetch, sent } = fetchWith(GITHUB, github);
    const outcome = await fetch({ watch: WATCH, cursor: { base: BASE } }, undefined);
    expect(sent.filter((exchange) => new URL(exchange.url).origin === API)).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${API}/repos/ossf/malicious-packages/compare/${BASE}...main`);
    const raw = sent.filter((exchange) => new URL(exchange.url).origin === RAW).map((exchange) => exchange.url.slice(exchange.url.lastIndexOf("/") + 1));
    expect(raw).toEqual(["MAL-2026-20354.json", "MAL-2026-20612.json", "MAL-2026-20613.json", "MAL-2026-20614.json", "MAL-2026-20615.json", "MAL-2026-20611.json"]);
    expect(sent.filter((exchange) => new URL(exchange.url).origin === RAW).every((exchange) => exchange.url.includes(`/${HEAD}`))).toBe(true);
    const bodies = bodiesOf(outcome);
    expect(bodies).toHaveLength(2);
    expect((bodies[0] as unknown as HeadBody).newest).toBe("2026-11-25T17:19:29Z");
    expect(JSON.stringify(bodies[0])).not.toMatch(/author|email|name/);
    expect(readGithubCursor(cursorOf(outcome))).toMatchObject({ offset: 0 });
    expect(readGithubCursor(cursorOf(outcome))!.base.startsWith(HEAD)).toBe(true);
  });

  it("gives the files of the folders with a MAL id, in the order of their paths", () => {
    const comparison = readComparison(COMPARE)!;
    const feed = GITHUB.feed as GithubFeed;
    const files = recordFiles({ ...comparison, files: [...comparison.files, { filename: "osv/malicious/npm/x/MAL-0000-ab12.json", status: "added" }, { filename: "osv/malicious/npm/y/MAL-2026-1.json", status: "removed" }] }, feed, GITHUB.prefixes);
    expect(files).toHaveLength(6);
    expect(files.every((file) => /\/MAL-2026-\d+\.json$/.test(file))).toBe(true);
    expect(files).toEqual([...files].sort());
  });

  it("tells of a gap for a history that does not hold the base", async () => {
    const { fetch } = fetchWith(GITHUB, () => reply(JSON.stringify({ ...JSON.parse(COMPARE), status: "diverged" }), 200));
    const outcome = await fetch({ watch: WATCH, cursor: { base: BASE } }, undefined);
    const head = bodiesOf(outcome)[0] as unknown as HeadBody;
    expect(head.gap).toBe(true);
    expect(head.read).toBe(0);
  });

  it("gives a failure for a rate limit of the API, and sends no other request", async () => {
    const { fetch, sent } = fetchWith(GITHUB, () => reply("", 429, { "retry-after": "60" }));
    const outcome = await fetch({ watch: WATCH, cursor: { base: BASE } }, undefined);
    expect(outcome.ok).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("reads a bad cursor as the state of a first fetch", () => {
    expect(readGithubCursor({ base: "main" })).toBeUndefined();
    expect(readGithubCursor({ base: BASE, head: "x", offset: "2" })).toEqual({ base: BASE, offset: 0 });
  });
});

describe("the map", () => {
  const map = createOsvMap(EXPORTS);

  it("gives a report of a malicious package, with the package as its subject", () => {
    const result = map(observation(bodyOf(MALICIOUS)));
    expect(result.problems).toEqual([]);
    const report = result.reports[0]!;
    expect(report.op).toBe("alert");
    expect(report.kind.code).toBe(MALICIOUS_KIND);
    expect(report.categories).toEqual(["cyber"]);
    expect(report.severity).toBe("severe");
    expect(report.about).toEqual([{ system: PURL_SYSTEM, id: "pkg:npm/paystation-embed-app", label: "paystation-embed-app (npm)", ranges: ["vers:npm/1.0.0"] }]);
    expect(report.correlation).toEqual([{ system: OSV_SYSTEM, id: "MAL-2026-20607" }]);
    expect(report.origin).toBe("ossf");
    expect(report.expires).toBe(report.sent + RECORD_LIFE_MS);
    expect(report.web).toBe("https://osv.dev/vulnerability/MAL-2026-20607");
    expect(report.parameters["cwe"]).toEqual(["CWE-506"]);
    expect(report.parameters["version"]).toEqual(["1.0.0"]);
  });

  it("gives a CVE subject and key for a CVE alias", () => {
    const report = map(observation(bodyOf(ADVISORY))).reports[0]!;
    expect(report.about).toContainEqual({ system: CVE_SYSTEM, id: "CVE-2026-64670" });
    expect(report.about).toContainEqual({ system: PURL_SYSTEM, id: "pkg:npm/%40waline/client", label: "@waline/client (npm)", ranges: ["vers:semver/<=3.16.2"] });
    expect(report.correlation).toContainEqual({ system: CVE_SYSTEM, id: "CVE-2026-64670" });
  });

  it("gives an update for a change one day or more after the publication", () => {
    const record = JSON.parse(WITHDRAWN) as Record<string, unknown>;
    const { withdrawn: _withdrawn, ...kept } = record;
    const report = map(observation(bodyOf(JSON.stringify(kept)))).reports[0]!;
    expect(report.op).toBe("update");
  });

  it("gives a cancel for a withdrawn record, and the cancel ends the earlier report with no alert", () => {
    const record = JSON.parse(WITHDRAWN) as Record<string, unknown>;
    const { withdrawn: _withdrawn, ...kept } = record;
    // The earlier report of the record lives to 2026-08-09. The withdrawal comes on 2026-07-16.
    const earlier = map({ ...observation(bodyOf(JSON.stringify({ ...kept, modified: "2026-07-10T00:00:00Z" }))), fetched: Date.UTC(2026, 6, 10) }).reports[0]!;
    const cancel = map({ ...observation(bodyOf(WITHDRAWN)), fetched: Date.UTC(2026, 6, 18) }).reports[0]!;
    expect(cancel.op).toBe("cancel");
    expect(cancel.references).toEqual([earlier.key]);
    expect(cancel.key).not.toBe(earlier.key);
    const at = Date.UTC(2026, 6, 20);
    expect(incidents(normalize({ reports: [earlier] }), at).some((incident) => incident.live)).toBe(true);
    expect(incidents(normalize({ reports: [earlier, cancel] }), at).some((incident) => incident.live)).toBe(false);
    // A record that the database withdraws after the fetch is not yet a cancel.
    expect(map({ ...observation(bodyOf(WITHDRAWN)), fetched: Date.UTC(2026, 6, 1) }).reports[0]!.op).not.toBe("cancel");
  });

  it("gives no report for the head, and a fatal problem for a refused record or a strange body", () => {
    const head: HeadBody = { feed: EXPORTS.id, newest: "2026-11-25T16:30:05Z", pending: 0, read: 0, gap: false };
    expect(map(observation(head))).toEqual({ reports: [], problems: [] });
    expect(map(observation(fileBody("{", `${BUCKET}/npm/x.json`))).problems[0]!.fatal).toBe(true);
    expect(map(observation({ other: 1 })).problems[0]!.fatal).toBe(true);
    expect(map({ ...observation({}), body: "{" }).problems[0]!.fatal).toBe(true);
  });

  it("gives a note and no subject for a package with no purl type", () => {
    const record = JSON.parse(MALICIOUS) as { affected: { package: Record<string, unknown> }[] };
    record.affected[0]!.package = { ecosystem: "VSCode", name: "example.theme" };
    const result = map(observation(bodyOf(JSON.stringify(record))));
    expect(result.reports[0]!.about).toEqual([]);
    expect(result.problems[0]!.fatal).toBe(false);
  });
});

describe("the canary", () => {
  const head = (newest: string | null): Observation => observation({ feed: EXPORTS.id, newest, pending: 0, read: 0, gap: false } satisfies HeadBody);

  it("passes for a newest change of the last 2 days, and fails for an older one or no head", () => {
    expect(checkCanary(EXPORTS, [head(new Date(NOW - DAY_MS).toISOString())]).pass).toBe(true);
    expect(checkCanary(EXPORTS, [head(new Date(NOW - 3 * DAY_MS).toISOString())]).pass).toBe(false);
    expect(checkCanary(EXPORTS, [head(null)]).pass).toBe(false);
    expect(checkCanary(EXPORTS, []).pass).toBe(false);
  });
});

describe("the quiet start", () => {
  const person = "person-1" as PersonId;
  const watcher: PersonWatch = { person, places: [], subjects: [{ system: PURL_SYSTEM, id: "pkg:npm/paystation-embed-app" }], rules: [] };
  const policy: AssessPolicy = {
    statuses: ["actual"],
    classes: [],
    otherwise: {
      severity: { extreme: "life-safety", severe: "urgent", moderate: "notice", minor: "digest", unknown: "none" },
      urgency: { immediate: "life-safety", expected: "life-safety", future: "life-safety", past: "life-safety", unknown: "life-safety" },
    },
  };

  it("holds the reports of a source in the observe mode, and sends them after it", async () => {
    const { source } = fetchWith(EXPORTS, () => reply("", 404));
    const report = (await source.map({ observation: observation(bodyOf(MALICIOUS)) })).reports[0]!;
    const state = normalize({ reports: [report] });
    const live = incidents(state, NOW);
    const cut = (observing: readonly SourceId[]) => observeCut({ incidents: live, state, observing: new Set(observing), people: [watcher], places: [], assess: policy, at: NOW });
    expect(cut([EXPORTS.id]).held).toHaveLength(1);
    expect(cut([EXPORTS.id]).sent).toHaveLength(0);
    expect(cut([]).sent).toHaveLength(1);
  });
});
