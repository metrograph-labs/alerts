import { readFileSync } from "node:fs";
import type { FetchOutcome, PlaceId, Watch } from "@mark1russell7/alerts";
import fc from "fast-check";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { createEmscFetch, eventBody, eventFields, isEmscEvent, pastDay, QUERY_LIMIT, QUERY_PATH, queryPath, readAnswer } from "./fetch.ts";
import { EVENT_FIELDS, REPORT_LIFE_MS } from "./map.ts";

/** The real answer of EMSC: 53 of the 183 earthquakes of magnitude 2.5 or more of one day (`fixtures/README.md`). */
const ANSWER = readFileSync(new URL("../fixtures/query-2.5_day-20261116T0528Z.json", import.meta.url), "utf8");
interface Collection {
  readonly metadata: Record<string, unknown>;
  readonly features: Record<string, unknown>[];
}
const PARSED = JSON.parse(ANSWER) as Collection;
const FEATURES = PARSED.features;
/** This function gives an answer with the features, and the count of its metadata. */
const answerOf = (features: readonly unknown[], count: number = features.length): string => JSON.stringify({ ...PARSED, metadata: { ...PARSED.metadata, count }, features });
const first = (): Record<string, unknown> => {
  const [feature] = FEATURES;
  if (feature === undefined) throw new Error("the answer has no feature");
  return feature;
};
const withProperties = (feature: Record<string, unknown>, properties: Record<string, unknown>): Record<string, unknown> => ({
  ...feature,
  properties: { ...(feature["properties"] as object), ...properties },
});
const timeOf = (feature: Record<string, unknown>): number => Date.parse((feature["properties"] as { time: string }).time);

/** A place of the tests. The service is global, so the fetch reads no code and no position of a place. */
const WATCH: Watch = { places: [{ id: "a" as PlaceId, codes: [{ system: "iso3166", code: "US" }], bufferKm: 0 }] };

const BASE = "https://emsc.test";
const START = Date.parse("2026-11-16T05:28:21Z");
const URL_OF_QUERY = `${BASE}${QUERY_PATH}?format=json&minmag=2.5&start=2026-11-15T05:00:00&orderby=time&limit=500`;
const ETAG = '"a5e1"';
const json = (body: string, status = 200, headers: Record<string, string> = {}): Reply => ({
  status,
  statusText: status === 200 ? "OK" : "Error",
  headers: { "content-type": "application/json", ...headers },
  body,
});
/** The answer 200 of the service, with an ETag and the cookie of its load balancer. */
const FULL = json(ANSWER, 200, { etag: ETAG, "set-cookie": "seismicportalLB=a1; path=/" });
/** The answer 304 of a conditional GET: no body. */
const NOT_MODIFIED: Reply = { status: 304, statusText: "Not Modified", headers: { etag: ETAG }, body: "" };

/** This function makes a fetch whose transport gives the replies in turn, and then the last reply again. The test can move the clock. */
const fetchWith = (replies: readonly Reply[]) => {
  const sent: Exchange[] = [];
  let index = 0;
  const transport: Transport = async (exchange) => {
    sent.push(exchange);
    const reply = replies[Math.min(index++, replies.length - 1)];
    if (reply === undefined) throw new Error("no reply");
    return reply;
  };
  let time = START;
  const clock = { now: () => time, sleep: async (ms: number) => void (time += ms) };
  const fetch = createEmscFetch({ pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport, userAgent: "alerts-tests", baseUrl: `${BASE}/`, minIntervalMs: 0, timeoutMs: 1000 });
  return { fetch, sent, now: clock.now, setTime: (at: number) => void (time = at) };
};
const failureOf = (outcome: FetchOutcome): unknown => (outcome.ok ? undefined : outcome.failure);
const observationsOf = (outcome: FetchOutcome): readonly unknown[] => (outcome.ok ? outcome.observations : []);
const conditionsOf = (sent: readonly Exchange[]): unknown[] => sent.map((exchange) => exchange.headers["if-none-match"]);

describe("queryPath", () => {
  it("asks for the events after the start of the hour one day before, so the path stays the same for one hour", () => {
    expect(`${BASE}${queryPath(START)}`).toBe(URL_OF_QUERY);
    expect(queryPath(Date.parse("2026-11-16T05:00:00Z"))).toBe(queryPath(START));
    expect(queryPath(Date.parse("2026-11-16T05:59:59.999Z"))).toBe(queryPath(START));
    expect(queryPath(Date.parse("2026-11-16T06:00:00Z"))).toContain("start=2026-11-15T06:00:00&");
    expect(queryPath(Date.parse("2026-01-01T00:30:00Z"))).toContain("start=2025-12-31T00:00:00&");
  });
});

describe("eventFields and eventBody", () => {
  it("keeps the fields of EVENT_FIELDS in their order, and no other field", () => {
    for (const feature of FEATURES) expect(Object.keys(eventFields(feature) ?? {})).toEqual([...EVENT_FIELDS]);
    const fields = eventFields(first()) ?? {};
    expect(fields["id"]).toBe(first()["id"]);
    expect(fields["coordinates"]).toEqual((first()["geometry"] as { coordinates: unknown }).coordinates);
  });

  it("gives the same body when only the time of the change or the ids of the database differ", () => {
    const changed = withProperties(first(), { lastupdate: "2026-11-16T09:00:00.0Z", source_id: "1", unid: "other", lat: 0, lon: 0 });
    expect(eventBody(changed)).toBe(eventBody(first()));
    expect(eventBody(withProperties(first(), { mag: 4.4 }))).not.toBe(eventBody(first()));
    expect(eventBody(withProperties(first(), { auth: "EMSC" }))).not.toBe(eventBody(first()));
  });

  it("gives an absent field as absent, and a value that is not a feature as its own JSON", () => {
    expect(eventFields({ id: "20261116_0000069" })).toEqual({ id: "20261116_0000069" });
    expect(eventFields([1])).toBeUndefined();
    expect(eventBody([1])).toBe("[1]");
    expect(eventBody(null)).toBe("null");
  });
});

describe("isEmscEvent", () => {
  it("accepts each real feature, and refuses a feature with a field that is absent or of a different type", () => {
    for (const feature of FEATURES) expect(isEmscEvent(feature)).toBe(true);
    expect(isEmscEvent(withProperties(first(), { magtype: null, flynn_region: null, evtype: null, auth: null, source_catalog: null }))).toBe(true);
    for (const field of ["time", "mag", "magtype", "flynn_region", "evtype", "auth", "source_catalog", "depth"]) {
      const { [field]: _removed, ...rest } = first()["properties"] as Record<string, unknown>;
      expect(isEmscEvent({ ...first(), properties: rest })).toBe(false);
      expect(isEmscEvent(withProperties(first(), { [field]: ["mag", "depth"].includes(field) ? "1" : 1 }))).toBe(false);
    }
    expect(isEmscEvent(withProperties(first(), { time: "2026-11-31T00:00:00Z" }))).toBe(false);
    expect(isEmscEvent({ ...first(), id: 7 })).toBe(false);
    for (const coordinates of [[1], [1, 2, 3, 4], [1, "2"], null]) expect(isEmscEvent({ ...first(), geometry: { type: "Point", coordinates } })).toBe(false);
    expect(isEmscEvent({ ...first(), geometry: { type: "Point", coordinates: [1, 2] } })).toBe(true);
    expect(isEmscEvent({ ...first(), geometry: null })).toBe(false);
    expect(isEmscEvent(null)).toBe(false);
  });
});

describe("readAnswer", () => {
  it("gives one observation for each event with its time, a complete answer, and no time of the data", () => {
    const read = readAnswer(json(ANSWER), URL_OF_QUERY, START, 40);
    expect(read?.complete).toBe(true);
    expect(read?.listed.map((listed) => listed.time)).toEqual(FEATURES.map(timeOf));
    expect(read).not.toHaveProperty("asOf");
    expect(read?.listed[0]?.observation).toMatchObject({ source: "emsc", fetched: START, contentType: "application/json", body: eventBody(first()), transport: { url: URL_OF_QUERY, status: 200, latency: 40 } });
  });

  it("gives the same observation for the same event in two answers, at two times", () => {
    const ids = (body: string, fetched: number): string[] => readAnswer(json(body), URL_OF_QUERY, fetched, 40)?.listed.map((listed) => listed.observation.id) ?? [];
    const later = FEATURES.map((feature) => withProperties(feature, { lastupdate: "2026-11-16T06:00:00.0Z" }));
    expect(ids(answerOf(later), START + 60_000)).toEqual(ids(ANSWER, START));
  });

  it("gives one observation for one event twice", () => {
    const read = readAnswer(json(answerOf([...FEATURES, first()])), URL_OF_QUERY, START, 40);
    expect(read?.listed).toHaveLength(FEATURES.length);
    expect(read?.complete).toBe(true);
  });

  it("gives no complete answer for an answer with no event, a wrong count, the limit of the query or an event of a different structure", () => {
    expect(readAnswer(json(answerOf([])), URL_OF_QUERY, START, 40)).toEqual({ listed: [], complete: false });
    expect(readAnswer(json(answerOf(FEATURES, FEATURES.length + 1)), URL_OF_QUERY, START, 40)?.complete).toBe(false);
    const noCount = JSON.stringify({ ...PARSED, metadata: {} });
    expect(readAnswer(json(noCount), URL_OF_QUERY, START, 40)?.complete).toBe(false);
    const full = Array.from({ length: QUERY_LIMIT }, (_, index) => ({ ...FEATURES[index % FEATURES.length], id: `20261115_${String(index).padStart(7, "0")}` }));
    const limited = readAnswer(json(answerOf(full)), URL_OF_QUERY, START, 40);
    expect(limited?.complete).toBe(false);
    expect(limited?.listed).toHaveLength(QUERY_LIMIT);
    expect(readAnswer(json(answerOf(full.slice(1))), URL_OF_QUERY, START, 40)?.complete).toBe(true);
    const renamed = FEATURES.map((feature, index) => (index === 5 ? withProperties(feature, { mag: String((feature["properties"] as { mag: number }).mag) }) : feature));
    const read = readAnswer(json(answerOf(renamed)), URL_OF_QUERY, START, 40);
    expect(read?.complete).toBe(false);
    expect(read?.listed).toHaveLength(FEATURES.length);
  });

  it("gives one observation of the whole body, and no complete answer, for JSON that is not a feature collection", () => {
    for (const body of [JSON.stringify({ error: "Service unavailable" }), "[]", "null", JSON.stringify({ type: "FeatureCollection", features: {} })]) {
      const read = readAnswer(json(body), URL_OF_QUERY, START, 40);
      expect(read?.complete).toBe(false);
      expect(read?.listed.map((listed) => [listed.time, listed.observation.body])).toEqual([[undefined, body]]);
    }
  });

  it("gives no read for each cut of the body", () => {
    const body = ANSWER.trimEnd();
    fc.assert(
      fc.property(fc.integer({ min: 0, max: body.length - 1 }), (end) => {
        expect(readAnswer(json(body.slice(0, end)), URL_OF_QUERY, START, 40)).toBeUndefined();
      }),
    );
  });
});

describe("pastDay", () => {
  const listed = readAnswer(json(ANSWER), URL_OF_QUERY, START, 40)?.listed ?? [];

  it("keeps the events of the past day, and an event with no time", () => {
    expect(pastDay(listed, START)).toHaveLength(FEATURES.length);
    const later = START + 3_600_000;
    const kept = FEATURES.filter((feature) => timeOf(feature) > later - REPORT_LIFE_MS);
    expect(kept.length).toBeLessThan(FEATURES.length);
    expect(pastDay(listed, later).map((observation) => observation.body)).toEqual(kept.map(eventBody));
    const [one] = listed;
    if (one === undefined) throw new Error("no observation");
    expect(pastDay([{ time: undefined, observation: one.observation }], later)).toEqual([one.observation]);
    expect(pastDay([{ time: later - REPORT_LIFE_MS, observation: one.observation }], later)).toEqual([]);
  });
});

describe("createEmscFetch", () => {
  it("asks for the events of the past day with no place in the request, and sends no cookie", async () => {
    const { fetch, sent } = fetchWith([FULL]);
    const outcome = await fetch({ watch: WATCH });
    await fetch({ watch: WATCH });
    expect(sent.map((exchange) => exchange.url)).toEqual([URL_OF_QUERY, URL_OF_QUERY]);
    expect(sent[0]?.headers).toMatchObject({ accept: "application/json", "user-agent": "alerts-tests" });
    for (const exchange of sent) expect(Object.keys(exchange.headers).map((name) => name.toLowerCase())).not.toContain("cookie");
    expect(outcome).toMatchObject({ ok: true, complete: true });
    expect(outcome.ok && outcome.cursor).toBeUndefined();
    expect(outcome.ok && outcome.asOf).toBeUndefined();
    expect(observationsOf(outcome)).toHaveLength(FEATURES.length);
  });

  it("sends the ETag of the last full answer, and gives its observations again for a 304", async () => {
    const { fetch, sent } = fetchWith([FULL, NOT_MODIFIED]);
    const one = await fetch({ watch: WATCH });
    const two = await fetch({ watch: WATCH });
    expect(conditionsOf(sent)).toEqual([undefined, ETAG]);
    expect(two).toEqual(one);
  });

  it("gives the newest full answer from the store for a 304, with its time of fetch", async () => {
    const older = json(JSON.stringify({ type: "FeatureCollection", metadata: { count: 1 }, features: [first()] }), 200, { etag: '"a5e0"' });
    const { fetch, sent, now, setTime } = fetchWith([older, FULL, NOT_MODIFIED]);
    await fetch({ watch: WATCH });
    setTime(START + 1000);
    const full = await fetch({ watch: WATCH });
    const fetched = now();
    setTime(START + 2000);
    const replay = await fetch({ watch: WATCH });
    expect(conditionsOf(sent)).toEqual([undefined, '"a5e0"', ETAG]);
    expect(observationsOf(full)).toHaveLength(FEATURES.length);
    expect(replay).toEqual(full);
    expect(replay.ok && replay.observations.every((observation) => observation.fetched === fetched)).toBe(true);
  });

  it("gives only the events of the past day for a 304 later in the hour", async () => {
    const { fetch, sent, now, setTime } = fetchWith([FULL, NOT_MODIFIED]);
    await fetch({ watch: WATCH });
    setTime(START + 30 * 60_000);
    const later = await fetch({ watch: WATCH });
    expect(sent.map((exchange) => exchange.url)).toEqual([URL_OF_QUERY, URL_OF_QUERY]);
    const kept = FEATURES.filter((feature) => timeOf(feature) > now() - REPORT_LIFE_MS);
    expect(kept.length).toBeLessThan(FEATURES.length);
    expect(observationsOf(later)).toHaveLength(kept.length);
    expect(later).toMatchObject({ ok: true, complete: true });
  });

  it("asks for a new path in the next hour, with no condition", async () => {
    const { fetch, sent, now, setTime } = fetchWith([FULL, NOT_MODIFIED]);
    await fetch({ watch: WATCH });
    setTime(Date.parse("2026-11-16T06:00:00Z"));
    const next = await fetch({ watch: WATCH });
    expect(sent.map((exchange) => exchange.url)).toEqual([URL_OF_QUERY, `${BASE}${queryPath(now())}`]);
    expect(conditionsOf(sent)).toEqual([undefined, undefined]);
    // A 304 for a path with no full answer is a failure.
    expect(failureOf(next)).toEqual({ kind: "network", message: `a 304 answer with no earlier full answer: ${BASE}${queryPath(now())}` });
  });

  it("fails a 304 with no earlier full answer, and then sends no condition", async () => {
    const { fetch, sent } = fetchWith([NOT_MODIFIED]);
    expect(failureOf(await fetch({ watch: WATCH }))).toEqual({ kind: "network", message: `a 304 answer with no earlier full answer: ${URL_OF_QUERY}` });
    await fetch({ watch: WATCH });
    expect(conditionsOf(sent)).toEqual([undefined, undefined]);
  });

  it("fails for a cut body, sends no condition after it, and fails for an answer that is not 2xx", async () => {
    const { fetch, sent } = fetchWith([json(ANSWER.slice(0, 500), 200, { etag: ETAG }), NOT_MODIFIED]);
    expect(failureOf(await fetch({ watch: WATCH }))).toEqual({ kind: "network", message: `truncated or malformed body: ${URL_OF_QUERY}` });
    expect((await fetch({ watch: WATCH })).ok).toBe(false);
    expect(conditionsOf(sent)).toEqual([undefined, undefined]);
    const down = await fetchWith([json("{}", 503)]).fetch({ watch: WATCH });
    expect(down.ok).toBe(false);
  });

  it("gives an answer that is not a feature collection as one observation, with no complete answer", async () => {
    const body = JSON.stringify({ error: "Service unavailable" });
    const outcome = await fetchWith([json(body)]).fetch({ watch: WATCH });
    expect(outcome).toMatchObject({ ok: true, complete: false });
    expect(observationsOf(outcome)).toHaveLength(1);
  });
});
