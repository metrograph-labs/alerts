import { readFileSync } from "node:fs";
import { observationId, readingProblems, type Cursor, type FetchOutcome, type Instant, type PlaceId, type Watch } from "@mark1russell7/alerts";
import { redactSecrets } from "@mark1russell7/text/redact";
import fc from "fast-check";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { checkCanary } from "./check.ts";
import { EIA_930_DESCRIPTOR } from "./descriptor.ts";
import { BACKFILL_MS, coveredOf, createEia930Fetch, cursorOf, DATA_PATH, DATE_FORMAT, hoursOf, KEY_ERROR_CODES, LIVE_HOURS, MAX_PAGES, MAX_ROWS, PAGE_HOURS, queryPath, readPage } from "./fetch.ts";
import { AGGREGATE_RESPONDENTS, API_UNIT, hourBody, HOUR_MS, mapObservation, periodText, SOURCE_ID } from "./map.ts";

/** The real bytes of an answer for 10 respondents and 7 hours (`fixtures/README.md`). */
const LIVE = readFileSync(new URL("../fixtures/region-data-20261118T1851Z.json", import.meta.url), "utf8");
const LIVE_AT = Date.parse("2026-11-18T18:51:01.358Z");
const T18 = Date.parse("2026-11-18T18:00:00Z");
const LIVE_FROM = T18 - LIVE_HOURS * HOUR_MS;

/** A public place of the tests. The query holds only the types of the values and the hours, so the fetch reads no place. */
const WATCH: Watch = { places: [{ id: "a" as PlaceId, codes: [], at: [-95.69, 39.05], bufferKm: 0 }] };

const BASE = "https://api.eia.test";
/** A key of the tests. Its `+` has a different form in a URL, and the fetch removes the two forms. */
const KEY = "eia-test-key+0123";
const SERIES = `${BASE}${DATA_PATH}?frequency=hourly&facets[type][]=D&facets[type][]=DF`;
const keyed = (path: string): string => `${BASE}${path}&api_key=${encodeURIComponent(KEY)}`;
const windowUrl = (from: Instant, to: Instant, offset = 0): string => keyed(queryPath(from, to, offset));
const hidden = (url: string): string => redactSecrets(url, [KEY]);

const json = (body: string, status = 200): Reply => ({ status, statusText: status === 200 ? "OK" : "Error", headers: { "content-type": "application/json" }, body });
const page = (rows: readonly unknown[], total: number = rows.length): string => JSON.stringify({ response: { total: String(total), dateFormat: DATE_FORMAT, frequency: "hourly", data: rows }, apiVersion: "2.1.14" });
const EMPTY = json(page([]));
const liveRows = (): unknown[] => (JSON.parse(LIVE) as { response: { data: unknown[] } }).response.data;

/** This function makes a fetch at the time `start`, whose transport gives the replies in turn, and then the last reply again. */
const fetchWith = (replies: readonly Reply[], start: number, transportOf?: (exchange: Exchange) => Promise<Reply>) => {
  const sent: Exchange[] = [];
  let index = 0;
  const transport: Transport = async (exchange) => {
    sent.push(exchange);
    if (transportOf !== undefined) return transportOf(exchange);
    const reply = replies[Math.min(index++, replies.length - 1)];
    if (reply === undefined) throw new Error("no reply");
    return reply;
  };
  let time = start;
  const clock = { now: () => time, sleep: async (ms: number) => void (time += ms) };
  const fetch = createEia930Fetch({ pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport, userAgent: "alerts-tests", apiKey: KEY, baseUrl: `${BASE}/`, minIntervalMs: 0, timeoutMs: 1000 });
  return { fetch, sent, urls: () => sent.map((exchange) => exchange.url) };
};
const observationsOf = (outcome: FetchOutcome) => (outcome.ok ? outcome.observations : []);
const cursorOfOutcome = (outcome: FetchOutcome): Cursor | undefined => (outcome.ok ? outcome.cursor : undefined);
/** This function gives the cursor of a full history at the time `at`. With it, the fetch reads no older hour. */
const full = (at: Instant): Cursor => {
  const to = Math.floor(at / HOUR_MS) * HOUR_MS;
  return cursorOf({ from: to - BACKFILL_MS, to });
};

describe("queryPath", () => {
  it("asks for the demand and the forecast of each respondent in the hours, in a fixed order, with no place and no key", () => {
    expect(queryPath(LIVE_FROM, T18, 0)).toBe(
      "/v2/electricity/rto/region-data/data/?frequency=hourly&data[0]=value&facets[type][]=D&facets[type][]=DF&start=2026-11-18T12&end=2026-11-18T18&sort[0][column]=period&sort[0][direction]=asc&sort[1][column]=respondent&sort[1][direction]=asc&sort[2][column]=type&sort[2][direction]=asc&offset=0&length=5000",
    );
    expect(queryPath(LIVE_FROM, T18, MAX_ROWS)).toContain("&offset=5000&length=5000");
  });
});

describe("createEia930Fetch", () => {
  it("asks for the past hours and the day before them, and gives each hour of a balancing authority of a real answer as one observation", async () => {
    const { fetch, sent, urls } = fetchWith([json(LIVE), EMPTY], LIVE_AT);
    const outcome = await fetch({ watch: WATCH });
    const history = LIVE_FROM - PAGE_HOURS * HOUR_MS;
    expect(urls()).toEqual([windowUrl(LIVE_FROM, T18), windowUrl(history, LIVE_FROM - HOUR_MS)]);
    expect(sent[0]?.headers).toMatchObject({ "user-agent": "alerts-tests", accept: "application/json" });
    expect(JSON.stringify(sent[0]?.headers)).not.toContain("eia-test-key");
    expect(outcome).toMatchObject({ ok: true, complete: true, cursor: { from: "2026-11-17T12", to: "2026-11-18T18" } });

    // 8 balancing authorities for 7 hours. The answer also has the sums TEX and US48, and the fetch gives no body of them.
    const observations = observationsOf(outcome);
    expect(observations).toHaveLength(56);
    expect([...new Set(observations.map((observation) => (JSON.parse(observation.body) as { respondent: string }).respondent))]).toEqual(["CISO", "ERCO", "LGEE", "MISO", "PJM", "PNM", "PSCO", "SCEG"]);
    expect(observations[0]).toMatchObject({
      id: observationId({ source: SOURCE_ID, contentType: "application/json", url: SERIES, body: observations[0]!.body }),
      source: SOURCE_ID,
      contentType: "application/json",
      transport: { url: hidden(windowUrl(LIVE_FROM, T18)), status: 200 },
    });
    expect(observations[0]?.body).toBe(hourBody("2026-11-18T12", "CISO", 22311, 20375));
    for (const observation of observations) expect(`${observation.transport.url ?? ""} ${observation.body}`).not.toContain("eia-test-key");

    // 6 hours have the demand 0, 3 hours have a demand that equals the forecast, and 7 hours have no forecast: they give no reading.
    const results = observations.map((observation) => mapObservation(observation));
    const readings = results.flatMap((result) => result.readings ?? []);
    expect(readings).toHaveLength(40);
    expect(results.flatMap((result) => result.problems).filter((problem) => problem.path === "demand")).toHaveLength(9);
    // The hours of SCEG have no forecast: they give no reading and a note (AL-158). Each reading passes its declaration.
    expect(results.flatMap((result) => result.problems).filter((problem) => problem.path === "forecast")).toHaveLength(7);
    expect(readings.filter((reading) => reading.series === "SCEG")).toEqual([]);
    expect(readings.flatMap((reading) => readingProblems(reading, EIA_930_DESCRIPTOR))).toEqual([]);
    expect(readings.filter((reading) => reading.series === "PJM").map((reading) => [periodText(reading.at), reading.value, reading.expected])).toEqual([
      ["2026-11-18T12", 102867, 104316],
      ["2026-11-18T13", 106151, 101667],
      ["2026-11-18T14", 102840, 96586],
      ["2026-11-18T15", 98138, 92580],
      ["2026-11-18T16", 95427, 89886],
      ["2026-11-18T17", 93360, 88483],
      ["2026-11-18T18", 91951, 88126],
    ]);
    expect(checkCanary(observations).pass).toBe(true);
  });

  it("gives one hour one id in two fetches, so the runtime keeps it one time", async () => {
    const first = await fetchWith([json(LIVE), EMPTY], LIVE_AT).fetch({ watch: WATCH });
    const cursor = cursorOfOutcome(first);
    const second = await fetchWith([json(LIVE), EMPTY], LIVE_AT + 5 * 60_000).fetch({ watch: WATCH, ...(cursor === undefined ? {} : { cursor }) });
    expect(observationsOf(second).map((observation) => observation.id)).toEqual(observationsOf(first).map((observation) => observation.id));
  });

  it("reads one more day of the history at each fetch until BACKFILL_MS, and starts again at the past hours after a gap", async () => {
    const day = PAGE_HOURS * HOUR_MS;
    const cases: readonly { readonly cursor: Cursor; readonly history: readonly [Instant, Instant] | undefined; readonly from: Instant }[] = [
      // The cursor meets the past hours: the fetch reads the day before its oldest hour.
      { cursor: { from: "2026-11-17T12", to: "2026-11-18T17" }, history: [LIVE_FROM - 2 * day, LIVE_FROM - day - HOUR_MS], from: LIVE_FROM - 2 * day },
      // A gap between the cursor and the past hours: the history starts again.
      { cursor: { from: "2026-11-10T00", to: "2026-11-18T10" }, history: [LIVE_FROM - day, LIVE_FROM - HOUR_MS], from: LIVE_FROM - day },
      // The last read of the history stops at BACKFILL_MS.
      { cursor: { from: periodText(T18 - BACKFILL_MS + 5 * HOUR_MS), to: "2026-11-18T18" }, history: [T18 - BACKFILL_MS, T18 - BACKFILL_MS + 4 * HOUR_MS], from: T18 - BACKFILL_MS },
      // A full history: the fetch reads only the past hours.
      { cursor: full(LIVE_AT), history: undefined, from: T18 - BACKFILL_MS },
    ];
    for (const { cursor, history, from } of cases) {
      const { fetch, urls } = fetchWith([json(LIVE), EMPTY], LIVE_AT);
      const outcome = await fetch({ watch: WATCH, cursor });
      expect(urls()).toEqual([windowUrl(LIVE_FROM, T18), ...(history === undefined ? [] : [windowUrl(...history)])]);
      expect(cursorOfOutcome(outcome)).toEqual(cursorOf({ from, to: T18 }));
    }
  });

  it("keeps the oldest hour of the cursor after a failed or an incomplete read of the history, and gives the past hours", async () => {
    const cursor: Cursor = { from: "2026-11-17T12", to: "2026-11-18T18" };
    const failed = await fetchWith([json(LIVE), json("{}", 503)], LIVE_AT).fetch({ watch: WATCH, cursor });
    expect(failed).toMatchObject({ ok: true, complete: true, cursor });
    expect(observationsOf(failed)).toHaveLength(56);
    const bad = { period: "soon", respondent: "PJM", type: "D", value: "1", "value-units": API_UNIT };
    const incomplete = await fetchWith([json(LIVE), json(page([bad]))], LIVE_AT).fetch({ watch: WATCH, cursor });
    expect(incomplete).toMatchObject({ ok: true, complete: true, cursor });
    expect(observationsOf(incomplete).map((observation) => observation.body).at(-1)).toBe(JSON.stringify(bad));
    // A failure of the past hours fails the fetch, and the runtime keeps its cursor.
    expect(await fetchWith([json("{}", 503)], LIVE_AT).fetch({ watch: WATCH, cursor })).toMatchObject({ ok: false, failure: { kind: "server" } });
  });

  it("reads the pages of a window by their offset, and stops at MAX_PAGES or at an empty page", async () => {
    const rowsOf = (count: number): unknown[] =>
      Array.from({ length: count }, (_, index) => ({ period: "2026-11-18T18", respondent: `R${String(Math.floor(index / 2)).padStart(4, "0")}`, type: index % 2 === 0 ? "D" : "DF", value: String(1000 + index), "value-units": API_UNIT }));
    const rows = rowsOf(MAX_ROWS + 2000);
    const two = fetchWith([json(page(rows.slice(0, MAX_ROWS), rows.length)), json(page(rows.slice(MAX_ROWS), rows.length))], LIVE_AT);
    const outcome = await two.fetch({ watch: WATCH, cursor: full(LIVE_AT) });
    expect(two.urls()).toEqual([windowUrl(LIVE_FROM, T18, 0), windowUrl(LIVE_FROM, T18, MAX_ROWS)]);
    expect(outcome).toMatchObject({ ok: true, complete: true });
    expect(observationsOf(outcome)).toHaveLength(rows.length / 2);
    expect(observationsOf(outcome)[0]?.transport).toMatchObject({ url: hidden(windowUrl(LIVE_FROM, T18, 0)) });

    const endless = fetchWith([json(page(rows.slice(0, MAX_ROWS), 100 * MAX_ROWS))], LIVE_AT);
    expect(await endless.fetch({ watch: WATCH, cursor: full(LIVE_AT) })).toMatchObject({ ok: true, complete: false });
    expect(endless.sent).toHaveLength(MAX_PAGES);
    const short = fetchWith([json(page([], 10))], LIVE_AT);
    expect(await short.fetch({ watch: WATCH, cursor: full(LIVE_AT) })).toMatchObject({ ok: true, complete: false });
    expect(short.sent).toHaveLength(1);
  });

  it("gives a 403 with a key error code as an auth failure, and removes the key from each message", async () => {
    // The real body of the answer to a bad key on 2026-11-18.
    const invalid = `{"error":{"code":"API_KEY_INVALID","message":"An invalid api_key was supplied. Get one at https://api.eia.gov:443"}}`;
    expect(await fetchWith([json(invalid, 403)], LIVE_AT).fetch({ watch: WATCH })).toMatchObject({ ok: false, failure: { kind: "auth" } });
    for (const code of KEY_ERROR_CODES) {
      const outcome = await fetchWith([json(JSON.stringify({ error: { code, message: "no" } }), 403)], LIVE_AT).fetch({ watch: WATCH });
      expect(outcome).toMatchObject({ ok: false, failure: { kind: "auth" } });
    }
    for (const body of [`{"error":{"code":"OTHER"}}`, "<html>Forbidden</html>", "null"]) {
      expect(await fetchWith([json(body, 403)], LIVE_AT).fetch({ watch: WATCH })).toMatchObject({ ok: false, failure: { kind: "refused" } });
    }
    expect(await fetchWith([json(`{"error":{"code":"OVER_RATE_LIMIT"}}`, 429)], LIVE_AT).fetch({ watch: WATCH })).toMatchObject({ ok: false, failure: { kind: "rate-limited" } });

    const thrown = await fetchWith([], LIVE_AT, async (exchange) => {
      throw new Error(`connect ECONNREFUSED ${exchange.url} (${KEY})`);
    }).fetch({ watch: WATCH });
    expect(thrown).toMatchObject({ ok: false, failure: { kind: "network" } });
    expect(JSON.stringify(thrown)).not.toContain("eia-test-key");
    const cut = await fetchWith([json(LIVE.slice(0, 4000))], LIVE_AT).fetch({ watch: WATCH });
    expect(cut).toEqual({ ok: false, failure: { kind: "network", message: `truncated or malformed body: ${hidden(windowUrl(LIVE_FROM, T18))}` } });
    expect(JSON.stringify(cut)).not.toContain("eia-test-key");
  });

  it("gives an answer that is not the hourly series as one observation of its body with no key, and the map tells of the change", async () => {
    const answers = [
      { request: { params: { api_key: KEY } }, response: { total: "0", dateFormat: DATE_FORMAT, frequency: "daily", data: [] } },
      { response: { total: "0", dateFormat: "YYYY-MM-DD", frequency: "hourly", data: [] } },
      { response: { total: "many", dateFormat: DATE_FORMAT, frequency: "hourly", data: [] } },
      { response: { total: 0, dateFormat: DATE_FORMAT, frequency: "hourly", data: {} } },
      { warnings: [], data: [] },
    ];
    for (const answer of answers) {
      const outcome = await fetchWith([json(JSON.stringify(answer))], LIVE_AT).fetch({ watch: WATCH, cursor: full(LIVE_AT) });
      expect(outcome).toMatchObject({ ok: true, complete: false });
      const [observation, ...rest] = observationsOf(outcome);
      expect(rest).toEqual([]);
      expect(observation?.body).toBe(hidden(JSON.stringify(answer)));
      expect(observation?.body).not.toContain("eia-test-key");
      expect(mapObservation(observation!).problems).toMatchObject([{ path: "", fatal: true }]);
    }
  });

  it("gives each row that is not valid as one observation, and the past hours are not complete", async () => {
    const valid = { period: "2026-11-18T18", respondent: "PJM", type: "D", value: "1", "value-units": API_UNIT };
    const invalid = [{ ...valid, period: "soon" }, { ...valid, type: "NG" }, { ...valid, value: "n/a" }, { ...valid, "value-units": "MWh" }, { ...valid, respondent: "" }, "row"];
    const outcome = await fetchWith([json(page([...liveRows(), ...invalid]))], LIVE_AT).fetch({ watch: WATCH, cursor: full(LIVE_AT) });
    expect(outcome).toMatchObject({ ok: true, complete: false });
    const observations = observationsOf(outcome);
    expect(observations).toHaveLength(56 + invalid.length);
    for (const observation of observations.slice(56)) expect(mapObservation(observation).problems.some((problem) => problem.fatal === true)).toBe(true);
  });
});

describe("readPage", () => {
  it("reads the rows and the count as a number or a text, gives another shape as other, and gives undefined for a body that is not JSON", () => {
    expect(readPage(page([1, 2], 7))).toEqual({ kind: "page", rows: [1, 2], total: 7 });
    expect(readPage(JSON.stringify({ response: { total: 3, dateFormat: DATE_FORMAT, frequency: "hourly", data: [] } }))).toEqual({ kind: "page", rows: [], total: 3 });
    expect(readPage(JSON.stringify({ response: { total: "-1", dateFormat: DATE_FORMAT, frequency: "hourly", data: [] } }))).toEqual({ kind: "other" });
    expect(readPage("[]")).toEqual({ kind: "other" });
    expect(readPage("{")).toBeUndefined();
  });
});

describe("coveredOf and cursorOf", () => {
  it("reads back each cursor that it writes, and gives undefined for a cursor that is not two whole hours in their order", () => {
    expect(coveredOf(cursorOf({ from: LIVE_FROM, to: T18 }))).toEqual({ from: LIVE_FROM, to: T18 });
    const bad: readonly (Cursor | undefined)[] = [undefined, {}, { from: "2026-11-18T12" }, { from: "soon", to: "2026-11-18T18" }, { from: "2026-11-18T19", to: "2026-11-18T18" }];
    for (const cursor of bad) expect(coveredOf(cursor)).toBeUndefined();
  });
});

describe("hoursOf", () => {
  it("joins the demand and the forecast of each hour, keeps the last of two equal rows, and gives no body for a sum or an hour with no demand", () => {
    const row = (respondent: string, type: string, value: string | null, period = "2026-11-18T18") => ({ period, respondent, type, value, "value-units": API_UNIT });
    const hours = hoursOf([row("PJM", "DF", "88126"), row("PJM", "D", "1"), row("PJM", "D", "91951"), row("US48", "D", "432936"), row("SCEG", "DF", "2400"), row("LGEE", "D", null), row("CISO", "D", "22311", "2026-11-18T12")]);
    expect(hours.invalid).toEqual([]);
    expect(hours.bodies).toEqual([hourBody("2026-11-18T12", "CISO", 22311, null), hourBody("2026-11-18T18", "LGEE", null, null), hourBody("2026-11-18T18", "PJM", 91951, 88126)]);
  });

  it("gives at most one body for each hour of a balancing authority with a demand, in the order of the hour and the respondent, for each set of rows", () => {
    const respondent = fc.constantFrom("CISO", "PJM", "PJMX", "SCEG", "TEX", "US48", "NY");
    const period = fc.constantFrom("2026-11-18T12", "2026-11-18T13", "2026-11-19T00");
    const value = fc.oneof(fc.constant(null), fc.integer({ min: -10, max: 200_000 }).map(String));
    const row = fc.record({ period, respondent, type: fc.constantFrom("D", "DF"), value, "value-units": fc.constant(API_UNIT) });
    fc.assert(
      fc.property(fc.array(row, { maxLength: 60 }), (rows) => {
        const { bodies, invalid } = hoursOf(rows);
        expect(invalid).toEqual([]);
        const keys = bodies.map((body) => {
          const parsed = JSON.parse(body) as { hour: string; respondent: string };
          return [parsed.hour, parsed.respondent] as const;
        });
        expect(new Set(keys.map((key) => key.join(" "))).size).toBe(keys.length);
        for (const [hour, name] of keys) {
          expect(AGGREGATE_RESPONDENTS).not.toContain(name);
          expect(rows.some((r) => r.period === hour && r.respondent === name && r.type === "D")).toBe(true);
        }
        const sorted = [...keys].sort(([a, b], [c, d]) => (a < c ? -1 : a > c ? 1 : b < d ? -1 : b > d ? 1 : 0));
        expect(keys).toEqual(sorted);
      }),
    );
  });
});
