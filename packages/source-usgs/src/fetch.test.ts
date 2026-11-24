import { readFileSync } from "node:fs";
import type { FetchOutcome, PlaceId, Watch } from "@mark1russell7/alerts";
import fc from "fast-check";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { createUsgsFetch, eventBody, eventFields, FEED_PATH, isFeedEvent, readAnswer } from "./fetch.ts";
import { EVENT_FIELDS } from "./map.ts";

/** The real feed of the USGS: the 48 earthquakes of magnitude 2.5 or more of one day. */
const FEED = readFileSync(new URL("../fixtures/feed-2.5_day-20261116T0327Z.geojson", import.meta.url), "utf8");
interface Feed {
  readonly metadata: Record<string, unknown>;
  readonly features: Record<string, unknown>[];
}
const PARSED = JSON.parse(FEED) as Feed;
const FEATURES = PARSED.features;
const GENERATED = PARSED.metadata["generated"] as number;
/** This function gives a feed with the features, and the count of its metadata. */
const feedOf = (features: readonly unknown[], count: number = features.length): string => JSON.stringify({ ...PARSED, metadata: { ...PARSED.metadata, count }, features });
const first = (): Record<string, unknown> => {
  const [feature] = FEATURES;
  if (feature === undefined) throw new Error("the feed has no feature");
  return feature;
};
const withProperties = (feature: Record<string, unknown>, properties: Record<string, unknown>): Record<string, unknown> => ({
  ...feature,
  properties: { ...(feature["properties"] as object), ...properties },
});

/** A place of the tests. The feed is global, so the fetch reads no code and no position of a place. */
const WATCH: Watch = { places: [{ id: "a" as PlaceId, codes: [{ system: "iso3166", code: "US" }], bufferKm: 0 }] };

const BASE = "https://usgs.test";
const URL_OF_FEED = `${BASE}${FEED_PATH}`;
const START = Date.parse("2026-11-16T03:27:40Z");
const LAST_MODIFIED = "Mon, 16 Nov 2026 03:27:30 GMT";
const json = (body: string, status = 200, headers: Record<string, string> = {}): Reply => ({
  status,
  statusText: status === 200 ? "OK" : "Error",
  headers: { "content-type": "application/json", ...headers },
  body,
});
/** The answer 304 of a conditional GET: no body. */
const NOT_MODIFIED: Reply = { status: 304, statusText: "Not Modified", headers: { "last-modified": LAST_MODIFIED }, body: "" };

/** This function makes a fetch whose transport gives the replies in turn, and then the last reply again. */
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
  const fetch = createUsgsFetch({ pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport, userAgent: "alerts-tests", baseUrl: `${BASE}/`, minIntervalMs: 0, timeoutMs: 1000 });
  return { fetch, sent };
};
const failureOf = (outcome: FetchOutcome): unknown => (outcome.ok ? undefined : outcome.failure);

describe("eventFields and eventBody", () => {
  it("keeps the fields of EVENT_FIELDS in their order, and no other field", () => {
    for (const feature of FEATURES) expect(Object.keys(eventFields(feature) ?? {})).toEqual([...EVENT_FIELDS]);
    const fields = eventFields(first()) ?? {};
    expect(fields["id"]).toBe(first()["id"]);
    expect(fields["coordinates"]).toEqual((first()["geometry"] as { coordinates: unknown }).coordinates);
  });

  it("gives the same body when only the felt count, the intensity of the reports or the time of the change differ", () => {
    const changed = withProperties(first(), { felt: 120, cdi: 4.1, sig: 400, updated: GENERATED + 1, detail: "https://usgs.test/other" });
    expect(eventBody(changed)).toBe(eventBody(first()));
    expect(eventBody(withProperties(first(), { mag: 4.4 }))).not.toBe(eventBody(first()));
  });

  it("gives an absent field as absent, and a value that is not a feature as its own JSON", () => {
    expect(eventFields({ id: "us1" })).toEqual({ id: "us1" });
    expect(eventFields([1])).toBeUndefined();
    expect(eventBody([1])).toBe("[1]");
    expect(eventBody(null)).toBe("null");
  });
});

describe("isFeedEvent", () => {
  it("accepts each real feature, and refuses a feature with a field that is absent or of a different type", () => {
    for (const feature of FEATURES) expect(isFeedEvent(feature)).toBe(true);
    expect(isFeedEvent(withProperties(first(), { mmi: 4.2, alert: "green", magType: null, place: null }))).toBe(true);
    for (const field of ["ids", "time", "mag", "magType", "place", "title", "url", "status", "type", "alert", "tsunami", "mmi", "net"]) {
      const { [field]: _removed, ...rest } = first()["properties"] as Record<string, unknown>;
      expect(isFeedEvent({ ...first(), properties: rest })).toBe(false);
      expect(isFeedEvent(withProperties(first(), { [field]: ["time", "mag", "tsunami", "mmi"].includes(field) ? "1" : 1 }))).toBe(false);
    }
    expect(isFeedEvent({ ...first(), id: 7 })).toBe(false);
    expect(isFeedEvent({ ...first(), geometry: { type: "Point", coordinates: [1, 2] } })).toBe(false);
    expect(isFeedEvent({ ...first(), geometry: null })).toBe(false);
    expect(isFeedEvent(null)).toBe(false);
  });
});

describe("readAnswer", () => {
  it("gives one observation for each event, a complete feed, and the time when the USGS made the feed", () => {
    const read = readAnswer(json(FEED), URL_OF_FEED, START, 40);
    expect(read?.complete).toBe(true);
    expect(read?.observations).toHaveLength(FEATURES.length);
    expect(read?.asOf).toBe(GENERATED);
    // The runtime counts a miss of a report only when its sent time is not after the time of the feed.
    for (const feature of FEATURES) expect((feature["properties"] as { time: number }).time).toBeLessThanOrEqual(GENERATED);
    expect(read?.observations[0]).toMatchObject({ source: "usgs", fetched: START, contentType: "application/json", transport: { url: URL_OF_FEED, status: 200, latency: 40 } });
    expect(readAnswer(json(FEED, 200, { "last-modified": LAST_MODIFIED }), URL_OF_FEED, START, 40)?.observations[0]?.transport.lastModified).toBe(LAST_MODIFIED);
  });

  it("gives the same observation for the same event in two answers, at two times", () => {
    const one = readAnswer(json(FEED), URL_OF_FEED, START, 40)?.observations ?? [];
    const felt = FEATURES.map((feature) => withProperties(feature, { felt: 9, updated: GENERATED + 60_000 }));
    const two = readAnswer(json(feedOf(felt)), URL_OF_FEED, START + 60_000, 55)?.observations ?? [];
    expect(two.map((observation) => observation.id)).toEqual(one.map((observation) => observation.id));
  });

  it("gives no complete feed for a feed with no event, a wrong count, no time or an event of a different structure", () => {
    expect(readAnswer(json(feedOf([])), URL_OF_FEED, START, 40)).toEqual({ observations: [], complete: false });
    expect(readAnswer(json(feedOf(FEATURES, FEATURES.length + 1)), URL_OF_FEED, START, 40)?.complete).toBe(false);
    const timeless = JSON.stringify({ ...PARSED, metadata: { ...PARSED.metadata, generated: "now" } });
    expect(readAnswer(json(timeless), URL_OF_FEED, START, 40)).toMatchObject({ complete: false });
    expect(readAnswer(json(timeless), URL_OF_FEED, START, 40)?.asOf).toBeUndefined();
    const renamed = FEATURES.map((feature, index) => (index === 5 ? withProperties(feature, { mag: String((feature["properties"] as { mag: number }).mag) }) : feature));
    const read = readAnswer(json(feedOf(renamed)), URL_OF_FEED, START, 40);
    expect(read?.complete).toBe(false);
    expect(read?.observations).toHaveLength(FEATURES.length);
  });

  it("gives one observation of the whole body, and no complete feed, for JSON that is not the feed", () => {
    const body = JSON.stringify({ error: "Service unavailable" });
    const read = readAnswer(json(body), URL_OF_FEED, START, 40);
    expect(read?.complete).toBe(false);
    expect(read?.observations.map((observation) => observation.body)).toEqual([body]);
  });

  it("gives no read for each cut of the body", () => {
    const body = FEED.trimEnd();
    fc.assert(
      fc.property(fc.integer({ min: 0, max: body.length - 1 }), (end) => {
        expect(readAnswer(json(body.slice(0, end)), URL_OF_FEED, START, 40)).toBeUndefined();
      }),
    );
  });
});

describe("createUsgsFetch", () => {
  it("asks for the whole feed with no place in the request", async () => {
    const { fetch, sent } = fetchWith([json(FEED, 200, { "last-modified": LAST_MODIFIED })]);
    const outcome = await fetch({ watch: WATCH });
    expect(sent.map((exchange) => exchange.url)).toEqual([URL_OF_FEED]);
    expect(sent[0]?.headers).toMatchObject({ accept: "application/geo+json, application/json", "user-agent": "alerts-tests" });
    expect(outcome).toMatchObject({ ok: true, complete: true, asOf: GENERATED });
    expect(outcome.ok && outcome.cursor).toBeUndefined();
    expect(outcome.ok ? outcome.observations : []).toHaveLength(FEATURES.length);
  });

  it("sends the date of the last full answer, and gives its observations again for a 304", async () => {
    const { fetch, sent } = fetchWith([json(FEED, 200, { "last-modified": LAST_MODIFIED }), NOT_MODIFIED]);
    const one = await fetch({ watch: WATCH });
    const two = await fetch({ watch: WATCH });
    expect(sent.map((exchange) => exchange.headers["if-modified-since"])).toEqual([undefined, LAST_MODIFIED]);
    expect(two).toEqual(one);
  });

  it("gives the newest full answer from the store for a 304, with its time of fetch", async () => {
    const older = json(feedOf(FEATURES.slice(0, 3)), 200, { "last-modified": "Mon, 16 Nov 2026 03:20:00 GMT" });
    const { fetch } = fetchWith([older, json(FEED, 200, { "last-modified": LAST_MODIFIED }), NOT_MODIFIED]);
    await fetch({ watch: WATCH });
    const full = await fetch({ watch: WATCH });
    const replay = await fetch({ watch: WATCH });
    expect(full.ok ? full.observations : []).toHaveLength(FEATURES.length);
    expect(replay).toEqual(full);
  });

  it("fails a 304 with no earlier full answer, and then sends no condition", async () => {
    const { fetch, sent } = fetchWith([NOT_MODIFIED]);
    expect(failureOf(await fetch({ watch: WATCH }))).toEqual({ kind: "network", message: `a 304 answer with no earlier full answer: ${URL_OF_FEED}` });
    await fetch({ watch: WATCH });
    expect(sent.map((exchange) => exchange.headers["if-modified-since"])).toEqual([undefined, undefined]);
  });

  it("fails for a cut body, sends no condition after it, and fails for an answer that is not 2xx", async () => {
    const { fetch, sent } = fetchWith([json(FEED.slice(0, 500), 200, { "last-modified": LAST_MODIFIED }), json(FEED)]);
    expect(failureOf(await fetch({ watch: WATCH }))).toMatchObject({ kind: "network", message: expect.stringContaining("truncated") as string });
    expect((await fetch({ watch: WATCH })).ok).toBe(true);
    expect(sent.map((exchange) => exchange.headers["if-modified-since"])).toEqual([undefined, undefined]);
    const down = await fetchWith([json("{}", 503)]).fetch({ watch: WATCH });
    expect(down.ok).toBe(false);
  });
});
