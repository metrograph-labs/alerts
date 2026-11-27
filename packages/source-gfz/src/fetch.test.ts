import { readFileSync } from "node:fs";
import { observationId, type FetchOutcome, type PlaceId, type Watch } from "@mark1russell7/alerts";
import fc from "fast-check";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { checkCanary } from "./check.ts";
import { createGfzFetch, entryBody, isGfzEntry, queryPath, readAnswer, RUN_GAP_MS, runsOf, type Entry } from "./fetch.ts";
import { INTERVAL_MS, intervalText, mapObservation, SOURCE_ID } from "./map.ts";

/** The real bytes of the answers (`fixtures/README.md`). */
const LIVE = readFileSync(new URL("../fixtures/kp-20261117T0233Z.json", import.meta.url), "utf8");
const STORM = readFileSync(new URL("../fixtures/kp-20240510-20240512.json", import.meta.url), "utf8");

interface Answer {
  Kp: unknown[];
  datetime: unknown[];
  meta: Record<string, unknown>;
  status: unknown[];
}

/** This function gives the answer of the storm as the site gives it at the start of an interval: the values up to that interval. */
const stormUntil = (last: string): string => {
  const answer = JSON.parse(STORM) as Answer;
  const count = answer.datetime.indexOf(last) + 1;
  return JSON.stringify({ Kp: answer.Kp.slice(0, count), datetime: answer.datetime.slice(0, count), meta: answer.meta, status: answer.status.slice(0, count) });
};

/** A place of the tests. The query holds only times, so the fetch reads no code and no position of a place. */
const WATCH: Watch = { places: [{ id: "a" as PlaceId, codes: [{ system: "iso3166", code: "NO" }], at: [18.96, 69.65], bufferKm: 0 }] };

const BASE = "https://kp.gfz.test";
const SERIES = `${BASE}/app/json/?index=Kp`;
const LIVE_AT = Date.parse("2026-11-17T02:33:04Z");

const json = (body: string, status = 200): Reply => ({ status, statusText: status === 200 ? "OK" : "Error", headers: { "content-type": "application/json" }, body });

/** This function makes a fetch at the time `start`, whose transport gives the replies in turn, and then the last reply again. */
const fetchWith = (replies: readonly Reply[], start: number) => {
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
  const fetch = createGfzFetch({ pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport, userAgent: "alerts-tests", baseUrl: `${BASE}/`, minIntervalMs: 0, timeoutMs: 1000 });
  return { fetch, sent, move: (ms: number) => void (time += ms) };
};
const observationsOf = (outcome: FetchOutcome) => (outcome.ok ? outcome.observations : []);
const bodiesOf = (outcome: FetchOutcome) => observationsOf(outcome).map((observation) => JSON.parse(observation.body) as Record<string, unknown>);

describe("queryPath", () => {
  it("asks for the current interval and the 24 intervals before it, with times only", () => {
    expect(queryPath(LIVE_AT)).toBe("/app/json/?start=2026-11-14T00:00:00Z&end=2026-11-17T02:59:59Z&index=Kp");
    expect(queryPath(Date.parse("2026-11-17T03:00:00Z"))).toBe("/app/json/?start=2026-11-14T03:00:00Z&end=2026-11-17T05:59:59Z&index=Kp");
  });
});

describe("createGfzFetch", () => {
  it("asks for the query of the time with no place, and gives the intervals of the past 6 hours of a quiet answer", async () => {
    const { fetch, sent } = fetchWith([json(LIVE)], LIVE_AT);
    const outcome = await fetch({ watch: WATCH });
    expect(sent.map((exchange) => exchange.url)).toEqual([`${BASE}${queryPath(LIVE_AT)}`]);
    expect(sent[0]?.headers).toMatchObject({ "user-agent": "alerts-tests", accept: "application/json" });
    expect(sent[0]?.headers["if-none-match"]).toBeUndefined();
    expect(outcome).toMatchObject({ ok: true, complete: true });
    expect(outcome.ok && (outcome.cursor ?? outcome.asOf)).toBeUndefined();
    expect(bodiesOf(outcome)).toEqual([
      { datetime: "2026-11-16T21:00:00Z", Kp: 0.333, status: "pre" },
      { datetime: "2026-11-17T00:00:00Z", Kp: 0.333, status: "pre" },
    ]);
    const observations = observationsOf(outcome);
    expect(observations[0]).toMatchObject({
      id: observationId({ source: SOURCE_ID, contentType: "application/json", url: SERIES, body: observations[0]!.body }),
      source: SOURCE_ID,
      fetched: LIVE_AT,
      transport: { url: `${BASE}${queryPath(LIVE_AT)}`, status: 200 },
    });
    expect(observations.map((observation) => mapObservation(observation))).toEqual([
      { reports: [], problems: [] },
      { reports: [], problems: [] },
    ]);
    expect(checkCanary(observations)).toMatchObject({ pass: true, reason: "the newest interval of the index Kp starts at 2026-11-17T00:00:00Z, 2.6 hours before the fetch" });
  });

  it("gives the intervals of a storm with the start of their run, from the older intervals of the answer", async () => {
    const at = Date.parse("2024-05-11T01:30:00Z");
    const outcome = await fetchWith([json(stormUntil("2024-05-11T00:00:00Z"))], at).fetch({ watch: WATCH });
    expect(outcome).toMatchObject({ ok: true, complete: true });
    expect(bodiesOf(outcome)).toEqual([
      { datetime: "2024-05-10T21:00:00Z", Kp: 8.667, status: "def", run: "2024-05-10T15:00:00Z" },
      { datetime: "2024-05-11T00:00:00Z", Kp: 9, status: "def", run: "2024-05-10T15:00:00Z" },
    ]);
    const reports = observationsOf(outcome).flatMap((observation) => mapObservation(observation).reports);
    expect(reports.map((report) => [report.parameters["scale"]?.[0], report.urgency])).toEqual([
      ["G4", "past"],
      ["G5", "immediate"],
    ]);
  });

  it("keeps the id of the observation of an interval as the window of the query moves", async () => {
    const at = Date.parse("2024-05-11T05:59:00Z");
    const { fetch, sent, move } = fetchWith([json(stormUntil("2024-05-11T03:00:00Z")), json(stormUntil("2024-05-11T06:00:00Z"))], at);
    const before = observationsOf(await fetch({ watch: WATCH }));
    move(120_000);
    const after = observationsOf(await fetch({ watch: WATCH }));
    expect(new Set(sent.map((exchange) => exchange.url)).size).toBe(2);
    const shared = before.filter((observation) => after.some((other) => other.body === observation.body));
    expect(shared.map((observation) => JSON.parse(observation.body).datetime)).toEqual(["2024-05-11T03:00:00Z"]);
    expect(after.find((observation) => observation.body === shared[0]?.body)?.id).toBe(shared[0]?.id);
  });

  it("gives the whole body as one observation that is not complete when the answer is not the series or its license changed", async () => {
    const answer = JSON.parse(LIVE) as Answer;
    const changed = [
      JSON.stringify([1, 2]),
      JSON.stringify({ ...answer, meta: { ...answer.meta, license: "CC BY-NC 4.0" } }),
      JSON.stringify({ ...answer, meta: undefined }),
      JSON.stringify({ ...answer, Kp: answer.Kp.slice(1) }),
      JSON.stringify({ ...answer, status: undefined }),
    ];
    for (const body of changed) {
      const outcome = await fetchWith([json(body)], LIVE_AT).fetch({ watch: WATCH });
      expect(outcome, body.slice(0, 40)).toMatchObject({ ok: true, complete: false });
      const observations = observationsOf(outcome);
      expect(observations.map((observation) => observation.body)).toEqual([body]);
      expect(mapObservation(observations[0]!).problems.map((problem) => problem.fatal)).toEqual([true]);
      expect(checkCanary(observations).pass).toBe(false);
    }
  });

  it("gives an entry that is not valid as its own observation, and the answer is not complete", async () => {
    const answer = JSON.parse(LIVE) as Answer;
    const Kp = [...answer.Kp];
    Kp[3] = null;
    const outcome = await fetchWith([json(JSON.stringify({ ...answer, Kp }))], LIVE_AT).fetch({ watch: WATCH });
    expect(outcome).toMatchObject({ ok: true, complete: false });
    const bodies = bodiesOf(outcome);
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toEqual({ datetime: "2026-11-14T09:00:00Z", Kp: null, status: "pre" });
    expect(mapObservation(observationsOf(outcome)[2]!).problems.map((problem) => [problem.path, problem.fatal])).toEqual([["Kp", true]]);
  });

  it("fails for a body that does not parse, and for a failure of the server", async () => {
    const cut = await fetchWith([json(LIVE.slice(0, 200))], LIVE_AT).fetch({ watch: WATCH });
    expect(cut).toEqual({ ok: false, failure: { kind: "network", message: `truncated or malformed body: ${BASE}${queryPath(LIVE_AT)}` } });
    const down = await fetchWith([json("", 503)], LIVE_AT).fetch({ watch: WATCH });
    expect(down).toMatchObject({ ok: false, failure: { kind: "server" } });
  });
});

describe("runsOf", () => {
  const entry = (start: number, Kp: number): Entry => ({ datetime: intervalText(start), Kp, status: "pre" });

  it("joins two intervals of G1 or more across one lower interval or one missing interval, and not across two", () => {
    const t = (slot: number) => slot * INTERVAL_MS;
    const runs = runsOf([entry(t(0), 5), entry(t(1), 4), entry(t(2), 5.333), entry(t(4), 6), entry(t(5), 3), entry(t(6), 2), entry(t(7), 7)]);
    expect(runs.map(({ start, run }) => [start / INTERVAL_MS, run === undefined ? null : run / INTERVAL_MS])).toEqual([
      [0, 0],
      [1, null],
      [2, 0],
      [4, 0],
      [5, null],
      [6, null],
      [7, 7],
    ]);
    expect(RUN_GAP_MS).toBe(2 * INTERVAL_MS);
  });

  it("gives the same runs for the entries in any order, and keeps the last entry of one start", () => {
    const entries = JSON.parse(STORM) as Answer;
    const list: Entry[] = entries.datetime.map((datetime, index) => ({ datetime, Kp: entries.Kp[index], status: entries.status[index] }));
    const expected = runsOf(list);
    fc.assert(
      fc.property(fc.shuffledSubarray(list, { minLength: list.length, maxLength: list.length }), (order) => {
        expect(runsOf(order)).toEqual(expected);
      }),
    );
    const twice = runsOf([...list, { ...list[0]!, Kp: 6 }]);
    expect(twice[0]).toMatchObject({ entry: { Kp: 6 }, run: Date.parse("2024-05-10T00:00:00Z") });
  });
});

describe("entryBody and isGfzEntry", () => {
  it("gives the fields in the order of the series, and the run only when there is one", () => {
    expect(entryBody({ status: "pre", Kp: 5, datetime: "2026-11-16T03:00:00Z" })).toBe('{"datetime":"2026-11-16T03:00:00Z","Kp":5,"status":"pre"}');
    expect(entryBody({ status: "pre", Kp: 5, datetime: "2026-11-16T03:00:00Z" }, Date.parse("2026-11-16T00:00:00Z"))).toBe('{"datetime":"2026-11-16T03:00:00Z","Kp":5,"status":"pre","run":"2026-11-16T00:00:00Z"}');
    expect(isGfzEntry({ datetime: "2026-11-16T03:00:00Z", Kp: 5, status: "def" })).toBe(true);
    expect(isGfzEntry({ datetime: "2026-11-16T03:00:00Z", Kp: 5, status: "est" })).toBe(false);
  });

  it("reads the real answers as valid", () => {
    for (const text of [LIVE, STORM]) {
      const answer = JSON.parse(text) as Answer;
      const read = readAnswer(json(text), "u", SERIES, 0, 1);
      expect(read?.complete).toBe(true);
      expect(answer.datetime.every((datetime, index) => isGfzEntry({ datetime, Kp: answer.Kp[index], status: answer.status[index] }))).toBe(true);
    }
  });
});
