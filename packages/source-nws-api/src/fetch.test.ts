import { readFileSync } from "node:fs";
import type { FetchOutcome, PlaceId, WatchedPlace } from "@mark1russell7/alerts";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { WEA_EVENT_CODES } from "@mark1russell7/alerts-format-nws";
import { CANARY_PATH, createNwsFetch, queriesOf, WEA_PATH } from "./fetch.ts";

const read = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
const BASE = "https://nws.test";

/** A place of the tests. The codes are public regions, not the places of an owner. */
const place = (id: string, codes: WatchedPlace["codes"]): WatchedPlace => ({ id: id as PlaceId, codes, bufferKm: 0 });
const TEXAS = place("a", [
  { system: "state", code: "TX" },
  { system: "ugc", code: "TXC311" },
]);
const ARIZONA = place("b", [{ system: "state", code: "az" }]);
const ZONE_ONLY = place("c", [{ system: "ugc", code: "WAC045" }]);
const NO_CODE = place("d", [{ system: "same", code: "053045" }]);

describe("queriesOf", () => {
  const paths = (places: WatchedPlace[]): string[] => queriesOf({ places }).map((query) => query.path);

  it("asks by state, in order and with no duplicate", () => {
    expect(paths([TEXAS, ARIZONA, TEXAS])).toEqual(["/alerts/active?area=AZ,TX", WEA_PATH, CANARY_PATH]);
  });

  it("asks by zone for a place with no state", () => {
    expect(paths([TEXAS, ZONE_ONLY])).toEqual(["/alerts/active?area=TX", "/alerts/active?zone=WAC045", WEA_PATH, CANARY_PATH]);
    // The query by zone also asks for the fire zones of a place (AL-33). A code of the two kinds is in the query one time.
    const fireZones = place("f", [{ system: "ugc", code: "TXZ205" }, { system: "ugc-fire", code: "TXZ205" }, { system: "ugc-fire", code: "TXZ206" }]);
    expect(paths([fireZones])).toEqual(["/alerts/active?zone=TXZ205,TXZ206", WEA_PATH, CANARY_PATH]);
  });

  it("asks for the whole country for a place with no state and no zone, and then not for the WEA messages", () => {
    expect(paths([TEXAS, NO_CODE])).toEqual(["/alerts/active", CANARY_PATH]);
  });

  it("asks only for the health queries with no place", () => {
    expect(queriesOf({ places: [] })).toEqual([
      { path: WEA_PATH, main: false },
      { path: CANARY_PATH, main: false },
    ]);
  });

  it("asks for the WEA messages only when the option is not false", () => {
    expect(queriesOf({ places: [TEXAS] }, { weaCopies: false }).map((query) => query.path)).toEqual(["/alerts/active?area=TX", CANARY_PATH]);
    expect(queriesOf({ places: [] }, { weaCopies: false })).toEqual([{ path: CANARY_PATH, main: false }]);
    expect(queriesOf({ places: [TEXAS] }, { weaCopies: true })).toEqual(queriesOf({ places: [TEXAS] }));
  });

  it("asks for the actual alerts of each WEA event code, with the parameters that the NWS API takes", () => {
    const url = new URL(`https://nws.test${WEA_PATH}`);
    expect(url.pathname).toBe("/alerts/active");
    expect(url.searchParams.get("status")).toBe("actual");
    const codes = url.searchParams.get("code")?.split(",") ?? [];
    expect(codes).toEqual([...WEA_EVENT_CODES]);
    // The NWS API refuses a code that is not three letters or digits (`^\w{3}$`)
    expect(codes.every((code) => /^\w{3}$/.test(code))).toBe(true);
    expect(codes).toContain("TOR");
    expect(codes).toContain("FFW");
  });
});

/** A clock of the tests: each wait moves the time at once. */
const testClock = (): { now: () => number; sleep: (ms: number) => Promise<void> } => {
  let time = Date.parse("2026-11-15T00:00:00Z");
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Reply => ({
  status,
  statusText: status === 200 ? "OK" : "Error",
  headers: { "content-type": "application/geo+json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const collection = (...names: string[]): unknown => ({ type: "FeatureCollection", features: names.map(read) });

/** The answer 304 of a conditional GET: no body. */
const NOT_MODIFIED: Reply = { status: 304, statusText: "Not Modified", headers: { etag: '"v1"' }, body: "" };

/** This function gives each reply in turn, and then the last reply again. */
const inTurn = (...replies: Reply[]): (() => Promise<Reply>) => {
  let index = 0;
  return async () => replies[Math.min(index++, replies.length - 1)] as Reply;
};

/** This function makes a fetch whose transport gives one reply for each path. */
const fetchWith = (replies: Record<string, Reply | ((exchange: Exchange, signal: AbortSignal | undefined) => Promise<Reply>)>, timeoutMs = 1000, baseUrl = BASE) => {
  const sent: Exchange[] = [];
  const transport: Transport = async (exchange, signal) => {
    sent.push(exchange);
    const path = exchange.url.slice(BASE.length);
    const reply = replies[path];
    if (reply === undefined) throw new Error(`no reply for ${path}`);
    return typeof reply === "function" ? reply(exchange, signal) : reply;
  };
  const clock = testClock();
  const fetch = createNwsFetch({
    pace: { scheduler: new HostScheduler(clock, 1), now: clock.now },
    transport,
    userAgent: "alerts-tests",
    baseUrl,
    minIntervalMs: 0,
    timeoutMs,
  });
  return { fetch, sent };
};

const watch = { places: [TEXAS] };
const MAIN = "/alerts/active?area=TX";
const canary = json(collection("nws-keepalive.json"));
const failureOf = (outcome: FetchOutcome): unknown => (outcome.ok ? undefined : outcome.failure);

describe("createNwsFetch", () => {
  it("gives one observation for each alert, and the keepalive", async () => {
    const { fetch, sent } = fetchWith({ [MAIN]: json(collection("nws-flw.json", "nws-faw.json"), 200, { etag: '"abc"' }), [CANARY_PATH]: canary });
    const outcome = await fetch({ watch });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.complete).toBe(true);
    expect(outcome.observations).toHaveLength(3);
    expect(new Set(outcome.observations.map((observation) => observation.id)).size).toBe(3);
    expect(outcome.observations[0]?.body).toBe(JSON.stringify(read("nws-flw.json")));
    expect(outcome.observations[0]?.transport).toMatchObject({ url: `${BASE}${MAIN}`, status: 200, etag: '"abc"' });
    expect(sent[0]?.headers).toEqual({ accept: "application/geo+json", "user-agent": "alerts-tests" });
  });

  it("removes the slashes at the end of the base URL", async () => {
    const { fetch, sent } = fetchWith({ [MAIN]: json(collection()), [CANARY_PATH]: canary }, 1000, `${BASE}///`);
    expect((await fetch({ watch })).ok).toBe(true);
    expect(sent.map((exchange) => exchange.url)).toContain(`${BASE}${MAIN}`);
  });

  it("gives the same observation ids for the same answer", async () => {
    const replies = { [MAIN]: json(collection("nws-flw.json")), [CANARY_PATH]: canary };
    const ids = async (): Promise<string[]> => {
      const outcome = await fetchWith(replies).fetch({ watch });
      return outcome.ok ? outcome.observations.map((observation) => observation.id) : [];
    };
    expect(await ids()).toEqual(await ids());
  });

  describe("conditional requests", () => {
    const mainUrl = `${BASE}${MAIN}`;
    const mainSent = (sent: Exchange[]): Exchange[] => sent.filter((exchange) => exchange.url === mainUrl);
    const mainOf = (outcome: FetchOutcome): unknown[] =>
      outcome.ok ? outcome.observations.filter((observation) => observation.transport.url === mainUrl) : [];

    it("sends the ETag of the last full answer, and gives its observations again for a 304", async () => {
      const full = json(collection("nws-flw.json"), 200, { etag: '"v1"' });
      const { fetch, sent } = fetchWith({ [MAIN]: inTurn(full, NOT_MODIFIED), [CANARY_PATH]: canary });
      const first = await fetch({ watch });
      const second = await fetch({ watch });
      expect(mainSent(sent).map((exchange) => exchange.headers["if-none-match"])).toEqual([undefined, '"v1"']);
      expect(second).toMatchObject({ ok: true, complete: true });
      expect(mainOf(first)).toHaveLength(1);
      expect(mainOf(second)).toEqual(mainOf(first));
    });

    it("gives the observations of the newest full answer for a 304, with its time of fetch (AL-145)", async () => {
      const older = json(collection(), 200, { etag: '"v1"' });
      const newer = json(collection("nws-flw.json"), 200, { etag: '"v2"' });
      const { fetch } = fetchWith({ [MAIN]: inTurn(older, newer, NOT_MODIFIED), [CANARY_PATH]: canary });
      await fetch({ watch });
      const full = await fetch({ watch });
      const replay = await fetch({ watch });
      expect(mainOf(full)).toHaveLength(1);
      expect(mainOf(replay)).toEqual(mainOf(full));
    });

    it("sends no condition after a body that does not parse", async () => {
      const cut = json('{"type":"FeatureCollection","features":[', 200, { etag: '"v1"' });
      const { fetch, sent } = fetchWith({ [MAIN]: inTurn(cut, NOT_MODIFIED), [CANARY_PATH]: canary });
      expect((await fetch({ watch })).ok).toBe(false);
      await fetch({ watch });
      expect(mainSent(sent).map((exchange) => exchange.headers["if-none-match"])).toEqual([undefined, undefined]);
    });

    it("fails a 304 with no earlier full answer, and then sends no condition", async () => {
      const { fetch, sent } = fetchWith({ [MAIN]: inTurn(NOT_MODIFIED), [CANARY_PATH]: canary });
      const outcome = await fetch({ watch });
      expect(failureOf(outcome)).toEqual({ kind: "network", message: `a 304 answer with no earlier full answer: ${mainUrl}` });
      await fetch({ watch });
      expect(mainSent(sent).map((exchange) => exchange.headers["if-none-match"])).toEqual([undefined, undefined]);
    });
  });

  it("gives an empty, complete answer when no alert is active", async () => {
    const outcome = await fetchWith({ [MAIN]: json(collection()), [CANARY_PATH]: canary }).fetch({ watch });
    expect(outcome).toMatchObject({ ok: true, complete: true });
    expect(outcome.ok && outcome.observations).toHaveLength(1);
  });

  it("marks a JSON answer that is not a feature collection as not complete", async () => {
    const body = JSON.stringify({ type: "Feature" });
    const outcome = await fetchWith({ [MAIN]: json(body), [CANARY_PATH]: canary }).fetch({ watch });
    expect(outcome).toMatchObject({ ok: true, complete: false });
    expect(outcome.ok && outcome.observations[0]?.body).toBe(body);
  });

  it("fails with a network failure for a page that is not JSON", async () => {
    const page = json("<html>maintenance</html>", 200, { "content-type": "text/html; charset=utf-8" });
    const outcome = await fetchWith({ [MAIN]: page, [CANARY_PATH]: canary }).fetch({ watch });
    expect(failureOf(outcome)).toEqual({ kind: "network", message: `truncated or malformed body: ${BASE}${MAIN}` });
  });

  it("fails with a network failure for a JSON body that stops early, and never says no alert", async () => {
    const whole = JSON.stringify(collection("nws-flw.json"));
    for (const end of [0, 1, 40, whole.length - 1]) {
      const outcome = await fetchWith({ [MAIN]: json(whole.slice(0, end)), [CANARY_PATH]: canary }).fetch({ watch });
      expect(outcome.ok, `a body of ${String(end)} characters`).toBe(false);
      expect(failureOf(outcome)).toMatchObject({ kind: "network" });
    }
  });

  it("adds the WEA messages of the country, and gives one observation for an alert in two answers", async () => {
    const { fetch, sent } = fetchWith({
      [MAIN]: json(collection("nws-flw.json")),
      [WEA_PATH]: json(collection("nws-faw.json", "nws-flw.json")),
      [CANARY_PATH]: canary,
    });
    const outcome = await fetch({ watch });
    expect(sent.map((exchange) => exchange.url)).toEqual([`${BASE}${MAIN}`, `${BASE}${WEA_PATH}`, `${BASE}${CANARY_PATH}`]);
    expect(outcome).toMatchObject({ ok: true, complete: true });
    if (!outcome.ok) return;
    expect(outcome.observations.map((observation) => observation.body)).toEqual(
      ["nws-flw.json", "nws-faw.json", "nws-keepalive.json"].map((name) => JSON.stringify(read(name))),
    );
    expect(outcome.observations[0]?.transport.url).toBe(`${BASE}${MAIN}`);
  });

  it("does not fail, and stays complete, when the WEA query fails or gives a different document", async () => {
    for (const reply of [json("", 503), json({ title: "not a list" }), json("{")]) {
      const outcome = await fetchWith({ [MAIN]: json(collection("nws-flw.json")), [WEA_PATH]: reply, [CANARY_PATH]: canary }).fetch({ watch });
      expect(outcome).toMatchObject({ ok: true, complete: true });
    }
  });

  it("does not fail when only the canary query fails", async () => {
    const outcome = await fetchWith({ [MAIN]: json(collection("nws-flw.json")), [CANARY_PATH]: json("", 500) }).fetch({ watch });
    expect(outcome).toMatchObject({ ok: true, complete: true });
    expect(outcome.ok && outcome.observations).toHaveLength(1);
  });

  it.each([
    [429, { "retry-after": "120" }, { kind: "rate-limited", retryAfter: 120_000 }],
    [503, { "retry-after": "60" }, { kind: "server", retryAfter: 60_000 }],
    [500, {}, { kind: "server" }],
    [401, {}, { kind: "auth" }],
    [403, {}, { kind: "refused" }],
    [404, {}, { kind: "refused" }],
    [400, {}, { kind: "refused" }],
    [301, { location: "https://elsewhere.test/" }, { kind: "refused" }],
  ])("maps the status %i to a failure", async (status, headers, failure) => {
    const outcome = await fetchWith({ [MAIN]: json("", status, headers), [CANARY_PATH]: canary }).fetch({ watch });
    expect(outcome.ok).toBe(false);
    expect(failureOf(outcome)).toMatchObject(failure);
  });

  it("tells the problem text of the NWS in the failure", async () => {
    const problem = { title: "Bad Request", detail: "Parameter \"area\" is invalid" };
    const outcome = await fetchWith({ [MAIN]: json(problem, 400), [CANARY_PATH]: canary }).fetch({ watch });
    expect(failureOf(outcome)).toEqual({ kind: "refused", message: '400 Error: Parameter "area" is invalid' });
  });

  it("gives a network failure when the transport fails", async () => {
    const outcome = await fetchWith({
      [MAIN]: async () => {
        throw new Error("ECONNRESET");
      },
      [CANARY_PATH]: canary,
    }).fetch({ watch });
    expect(failureOf(outcome)).toMatchObject({ kind: "network" });
    expect((failureOf(outcome) as { message: string }).message).toContain("ECONNRESET");
  });

  it("gives a timeout failure when the answer is too slow", async () => {
    const hang = (_exchange: Exchange, signal: AbortSignal | undefined): Promise<Reply> =>
      new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
    const outcome = await fetchWith({ [MAIN]: hang, [CANARY_PATH]: canary }, 20).fetch({ watch });
    expect(failureOf(outcome)).toMatchObject({ kind: "timeout" });
  });

  it("throws when the caller stops the fetch", async () => {
    const stop = new AbortController();
    const hang = (_exchange: Exchange, signal: AbortSignal | undefined): Promise<Reply> =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        stop.abort(new Error("shutdown"));
      });
    await expect(fetchWith({ [MAIN]: hang, [CANARY_PATH]: canary }).fetch({ watch }, stop.signal)).rejects.toThrow("shutdown");
  });
});
