import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import type { FetchOutcome, PlaceId, Watch } from "@mark1russell7/alerts";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { checkCanary } from "./check.ts";
import { BODY_TYPE, createNdwFetch, MAX_XML_BYTES, readFile, SITUATIONS_PATH } from "./fetch.ts";
import { mapObservation, type CountBody } from "./map.ts";

/** The real text of a situation publication of NDW, cut to six situations (`fixtures/README.md`). */
const LIVE = readFileSync(new URL("../fixtures/actueel-beeld-20261125T0112Z.xml", import.meta.url));
const LIVE_AT = Date.parse("2026-11-25T01:12:30Z");
const PUBLISHED = Date.parse("2026-11-25T01:12:00.002Z");
const COUNTS = { accident: 0, congestion: 0, obstruction: 1, closure: 2, works: 0, conditions: 0, other: 5 };

/** A place of the tests. The request holds no place, so the fetch reads no code and no position of a place. */
const WATCH: Watch = { places: [{ id: "a" as PlaceId, codes: [{ system: "iso3166", code: "NL" }], at: [4.9, 52.37], bufferKm: 0 }] };

const BASE = "https://ndw.example.test";

const gzip = (bytes: Uint8Array, headers: Record<string, string> = { etag: '"v1"' }): Reply => ({
  status: 200,
  statusText: "OK",
  headers: { "content-type": "application/x-gzip", ...headers },
  body: "",
  bytes: gzipSync(bytes),
});
const notModified: Reply = { status: 304, statusText: "Not Modified", headers: {}, body: "" };

/** This function makes a fetch at the time `start`, whose transport gives the replies in turn, and then the last reply again. */
const fetchWith = (replies: readonly Reply[], start = LIVE_AT) => {
  const sent: Exchange[] = [];
  let index = 0;
  const transport: Transport = async (exchange) => {
    sent.push(exchange);
    const reply = replies[Math.min(index++, replies.length - 1)];
    if (reply === undefined) throw new Error("no reply");
    return reply;
  };
  let time = start;
  const clock = { now: () => time, sleep: async (ms: number) => void (time += ms) };
  const fetch = createNdwFetch({ pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport, userAgent: "alerts-tests", baseUrl: `${BASE}/`, minIntervalMs: 0, timeoutMs: 1000 });
  return { fetch, sent };
};
const bodyOf = (outcome: FetchOutcome): CountBody | undefined => (outcome.ok && outcome.observations[0] !== undefined ? (JSON.parse(outcome.observations[0].body) as CountBody) : undefined);

describe("readFile", () => {
  it("counts the valid records of each group of the real publication, from gzip and from XML", () => {
    const expected = { published: PUBLISHED, country: "nl", groups: COUNTS, unreal: 0, faults: 0 };
    // The records of the file are in `record.test.ts`.
    expect(readFile(gzipSync(LIVE))).toMatchObject({ ok: true, counts: expected });
    expect(readFile(LIVE)).toMatchObject({ ok: true, counts: expected });
  });

  it("gives a reason for a cut gzip, for a gzip larger than the limit after gunzip, and for a text that is not a publication", () => {
    const zipped = gzipSync(LIVE);
    expect(readFile(zipped.subarray(0, zipped.length - 20)).ok).toBe(false);
    const bomb = readFile(gzipSync(Buffer.alloc(MAX_XML_BYTES + 1, 0x20)));
    expect(bomb.ok ? "" : bomb.reason).toMatch(/gzip/);
    const other = readFile(new TextEncoder().encode("<a/>"));
    expect(other.ok ? "" : other.reason).toMatch(/no situation publication/);
    expect(readFile(new Uint8Array()).ok).toBe(false);
  });
});

describe("createNdwFetch", () => {
  it("asks for the bytes of the file with no place, and gives one observation of the counts at the time of the publication", async () => {
    const { fetch, sent } = fetchWith([gzip(LIVE)]);
    const outcome = await fetch({ watch: WATCH });
    expect(sent.map((exchange) => [exchange.method, exchange.url, exchange.read])).toEqual([["GET", `${BASE}${SITUATIONS_PATH}`, "bytes"]]);
    expect(sent[0]?.headers["user-agent"]).toBe("alerts-tests");
    expect(outcome).toMatchObject({ ok: true, complete: true, asOf: PUBLISHED });
    const observations = outcome.ok ? outcome.observations : [];
    expect(observations.length).toBe(1);
    expect(observations[0]).toMatchObject({ source: "ndw", contentType: BODY_TYPE, fetched: LIVE_AT });
    expect(bodyOf(outcome)).toEqual({ published: "2026-11-25T01:12:00.002Z", country: "nl", license: "CC0 1.0", records: 8, groups: COUNTS, unreal: 0, faults: 0 });
    expect(checkCanary(observations).pass).toBe(true);
    // The body is small: the log keeps the counts, not the file.
    expect(observations[0]?.body.length).toBeLessThan(300);
  });

  it("gives one id for two fetches of one publication, and the counts of the last full answer for a 304", async () => {
    const { fetch, sent } = fetchWith([gzip(LIVE), gzip(LIVE, { etag: '"v2"' }), notModified]);
    const outcomes = [await fetch({ watch: WATCH }), await fetch({ watch: WATCH }), await fetch({ watch: WATCH })];
    expect(sent[1]?.headers["if-none-match"]).toBe('"v1"');
    expect(sent[2]?.headers["if-none-match"]).toBe('"v2"');
    const ids = outcomes.map((outcome) => (outcome.ok ? outcome.observations[0]?.id : undefined));
    expect(ids[0]).toBeTypeOf("string");
    expect(new Set(ids).size).toBe(1);
    expect(outcomes[2]).toMatchObject({ ok: true, asOf: PUBLISHED });
  });

  it("gives a failure for a 304 with no earlier full answer and for bytes that are not a publication, and then sends no condition", async () => {
    const lone = await fetchWith([notModified]).fetch({ watch: WATCH });
    expect(lone).toMatchObject({ ok: false, failure: { kind: "network" } });
    const { fetch, sent } = fetchWith([gzip(new TextEncoder().encode("<html/>")), gzip(LIVE)]);
    const garbage = await fetch({ watch: WATCH });
    expect(garbage.ok ? "" : garbage.failure.message).toContain(SITUATIONS_PATH);
    const outcome = await fetch({ watch: WATCH });
    expect(sent[1]?.headers["if-none-match"]).toBeUndefined();
    expect(outcome.ok).toBe(true);
  });

  it("gives the failure of the requester for a server error", async () => {
    const outcome = await fetchWith([{ status: 503, statusText: "Unavailable", headers: {}, body: "" }]).fetch({ watch: WATCH });
    expect(outcome.ok).toBe(false);
  });

  it("gives an observation whose map gives the readings of the counts", async () => {
    const outcome = await fetchWith([gzip(LIVE)]).fetch({ watch: WATCH });
    const observation = outcome.ok ? outcome.observations[0] : undefined;
    if (observation === undefined) throw new Error("no observation");
    const mapped = mapObservation(observation);
    expect(mapped.problems).toEqual([]);
    expect(mapped.readings?.map((reading) => [reading.measure, reading.value])).toEqual([
      ["records", 8],
      ["accidents", 0],
      ["congestion", 0],
      ["obstructions", 1],
      ["closures", 2],
      ["works", 0],
      ["conditions", 0],
    ]);
  });
});
