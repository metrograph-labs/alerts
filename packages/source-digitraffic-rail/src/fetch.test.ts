import { readFileSync } from "node:fs";
import type { FetchOutcome, PlaceId, Watch } from "@mark1russell7/alerts";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { checkCanary } from "./check.ts";
import { BODY_TYPE, createRailFetch, departureDate, GRAPHQL_PATH, railQuery, readAnswer } from "./fetch.ts";
import { mapObservation, type RailBody } from "./map.ts";

/** A real answer of the rail query, cut to 9 running trains and 6 cancelled trains (`fixtures/README.md`). */
const LIVE = readFileSync(new URL("../fixtures/rail-20261125T1331Z.json", import.meta.url), "utf8");
const LIVE_AT = Date.parse("2026-11-25T13:33:00Z");
const NEWEST = Date.parse("2026-11-25T13:32:43.000Z");
const SERIES = { commuter: { running: 3, late: 1, cancelled: 3 }, "long-distance": { running: 3, late: 2, cancelled: 1 } };

/** A place of the tests. The request holds no place, so the fetch reads no code and no position of a place. */
const WATCH: Watch = { places: [{ id: "a" as PlaceId, codes: [{ system: "iso3166", code: "FI" }], at: [24.94, 60.17], bufferKm: 0 }] };

const BASE = "https://rata.example.test";

const json = (body: string, status = 200): Reply => ({ status, statusText: status === 200 ? "OK" : "Error", headers: { "content-type": "application/json" }, body });

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
  const fetch = createRailFetch({ pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport, userAgent: "alerts-tests", baseUrl: `${BASE}/`, minIntervalMs: 0, timeoutMs: 1000 });
  return { fetch, sent };
};
const bodyOf = (outcome: FetchOutcome): RailBody | undefined => (outcome.ok && outcome.observations[0] !== undefined ? (JSON.parse(outcome.observations[0].body) as RailBody) : undefined);

describe("departureDate", () => {
  it("gives the date in Finland, in winter at UTC+2 and in summer at UTC+3", () => {
    expect(departureDate(Date.parse("2026-11-25T21:59:59Z"))).toBe("2026-11-25");
    expect(departureDate(Date.parse("2026-11-25T22:00:00Z"))).toBe("2026-11-26");
    expect(departureDate(Date.parse("2026-07-01T20:59:59Z"))).toBe("2026-07-01");
    expect(departureDate(Date.parse("2026-07-01T21:00:00Z"))).toBe("2026-07-02");
    expect(departureDate(Number.NaN)).toBeUndefined();
  });
});

describe("railQuery", () => {
  it("asks for the stop with the newest actual time of each running train, and for the cancelled trains of the date", () => {
    const query = railQuery("2026-11-25");
    expect(query).toContain("currentlyRunningTrains");
    expect(query).toContain("timeTableRows(orderBy: {actualTime: DESCENDING}, take: 1)");
    expect(query).toContain('trainsByDepartureDate(departureDate: "2026-11-25", where: {cancelled: {equals: true}})');
  });
});

describe("readAnswer", () => {
  it("counts the running, late and cancelled trains of each passenger category of the real answer", () => {
    expect(readAnswer(LIVE)).toEqual({ ok: true, counts: { newest: NEWEST, trains: 9, series: SERIES } });
  });

  it("counts a train with no actual time at its stop, or with no stop, as a running train with no known delay", () => {
    const answer = {
      data: {
        running: [
          { trainType: { trainCategory: { name: "Commuter" } }, timeTableRows: [{ differenceInMinutes: 12, actualTime: null }] },
          { trainType: { trainCategory: { name: "Commuter" } }, timeTableRows: [] },
        ],
        cancelled: [],
      },
    };
    expect(readAnswer(JSON.stringify(answer))).toEqual({ ok: true, counts: { newest: undefined, trains: 2, series: { commuter: { running: 2, late: 0, cancelled: 0 }, "long-distance": { running: 0, late: 0, cancelled: 0 } } } });
  });

  it("gives a reason for a text that is not JSON, a GraphQL error, no lists, a train with no category and a bad stop", () => {
    const train = (row: unknown) => JSON.stringify({ data: { running: [{ trainType: { trainCategory: { name: "Commuter" } }, timeTableRows: [row] }], cancelled: [] } });
    const answers: Record<string, string> = {
      "not JSON": "<html>",
      "an object": "[]",
      "GraphQL errors": JSON.stringify({ errors: [{ message: "Validation error" }] }),
      "no lists": JSON.stringify({ data: { running: [] } }),
      "the running train 0 has no category": JSON.stringify({ data: { running: [{ trainType: {} }], cancelled: [] } }),
      "the running train 0 has no list of stops": JSON.stringify({ data: { running: [{ trainType: { trainCategory: { name: "Cargo" } } }], cancelled: [] } }),
      "the cancelled train 0 has no category": JSON.stringify({ data: { running: [], cancelled: [{}] } }),
      "no actual time or no delay": train({ differenceInMinutes: 3, actualTime: "soon" }),
      "or no delay": train({ actualTime: "2026-11-25T13:00:00.000Z" }),
    };
    for (const [reason, text] of Object.entries(answers)) {
      const read = readAnswer(text);
      expect(read.ok, reason).toBe(false);
      expect(read.ok ? "" : read.reason, reason).toContain(reason);
    }
  });
});

describe("createRailFetch", () => {
  it("sends one POST of the query with the date in Finland and no place, and gives the counts as one observation", async () => {
    const { fetch, sent } = fetchWith([json(LIVE)]);
    const outcome = await fetch({ watch: WATCH });
    expect(sent).toHaveLength(1);
    const exchange = sent[0];
    expect(exchange).toMatchObject({ method: "POST", url: `${BASE}${GRAPHQL_PATH}` });
    expect(exchange?.headers).toMatchObject({ "content-type": "application/json", "user-agent": "alerts-tests", "digitraffic-user": "alerts-tests" });
    expect(JSON.parse(String(exchange?.body))).toEqual({ query: railQuery("2026-11-25") });
    expect(`${exchange?.url ?? ""} ${String(exchange?.body)}`).not.toMatch(/24\.9|60\.1|FI"/);
    expect(outcome).toMatchObject({ ok: true, complete: true, asOf: NEWEST });
    expect(outcome.ok ? outcome.observations[0]?.contentType : undefined).toBe(BODY_TYPE);
    expect(bodyOf(outcome)).toEqual({ newest: "2026-11-25T13:32:43.000Z", date: "2026-11-25", license: "CC BY 4.0", trains: 9, series: SERIES });
  });

  it("gives one observation id for two fetches with the same counts, and readings and a passed canary for the observation", async () => {
    const { fetch } = fetchWith([json(LIVE)]);
    const first = await fetch({ watch: WATCH });
    const second = await fetch({ watch: WATCH });
    const observation = first.ok ? first.observations[0] : undefined;
    expect(observation?.id).toBeDefined();
    expect(second.ok ? second.observations[0]?.id : undefined).toBe(observation?.id);
    if (observation === undefined) return;
    expect(mapObservation(observation).readings).toHaveLength(6);
    expect(checkCanary([observation]).pass).toBe(true);
  });

  it("gives the time of the fetch as the time of the data when the actual time is after the fetch", async () => {
    const { fetch } = fetchWith([json(LIVE)], Date.parse("2026-11-25T13:31:19Z"));
    expect(await fetch({ watch: WATCH })).toMatchObject({ ok: true, asOf: Date.parse("2026-11-25T13:31:19Z") });
  });

  it("gives a failure for an error status, a GraphQL error and an answer that is not JSON", async () => {
    for (const reply of [json("{}", 503), json(JSON.stringify({ errors: [{ message: "bad" }] })), json("<html></html>")]) {
      const { fetch } = fetchWith([reply]);
      expect((await fetch({ watch: WATCH })).ok, reply.body).toBe(false);
    }
    const { fetch } = fetchWith([json(JSON.stringify({ errors: [{ message: "Validation error" }] }))]);
    const outcome = await fetch({ watch: WATCH });
    expect(outcome.ok ? undefined : outcome.failure).toMatchObject({ kind: "server" });
    expect(outcome.ok ? "" : outcome.failure.message).toContain("Validation error");
  });
});
