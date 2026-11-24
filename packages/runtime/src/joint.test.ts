import { fakeWallClock } from "@mark1russell7/algebra/clock";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { flipsOf, flipsRequest, JOINT_EVERY, JOINT_LIMIT, JOINT_MAX_AGE, JOINT_RETRY, JOINT_WINDOW, jointDownTime, jointReader, jointWatch, type Flip, type JointReading } from "./joint.ts";

const T0 = Date.UTC(2026, 10, 22, 12);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FROM = T0 - JOINT_WINDOW;
// Made-up values. No real key, ping URL or id of a check.
const KEY = "key-test-0000";
const ID = "00000000-0000-4000-8000-000000000001";
const LOUD = `https://hc-ping.com/${ID}`;
const AGENT = "alerts-runtime (test)";

const flip = (at: number, up: boolean): Flip => ({ at, up });
const sum = (flips: readonly Flip[], status = "up", lag = 0) => jointDownTime({ flips, status, lag, at: T0, window: JOINT_WINDOW });

describe("the request and the answer of the flips", () => {
  it("asks for the flips of the check in the window, with the key and the User-Agent", () => {
    expect(flipsRequest(KEY, ID, AGENT)).toEqual({
      method: "GET",
      url: `https://healthchecks.io/api/v3/checks/${ID}/flips/?seconds=604800`,
      headers: { accept: "application/json", "user-agent": AGENT, "x-api-key": KEY },
      body: null,
    });
    expect(flipsRequest(KEY, "a/b", AGENT, 90 * MINUTE + 1, "https://checks.example/api/v3/").url).toBe("https://checks.example/api/v3/checks/a%2Fb/flips/?seconds=5401");
  });

  it("reads a list or an object with a list, with 1 and 0 or true and false, from the earliest flip", () => {
    const list = [
      { timestamp: "2026-11-20T10:05:00+00:00", up: 1 },
      { timestamp: "2026-11-20T10:00:00+00:00", up: 0 },
      { timestamp: "2026-11-21T08:00:00+00:00", up: false },
      { timestamp: "2026-11-21T08:30:00Z", up: true },
    ];
    const expected = [flip(Date.UTC(2026, 10, 20, 10), false), flip(Date.UTC(2026, 10, 20, 10, 5), true), flip(Date.UTC(2026, 10, 21, 8), false), flip(Date.UTC(2026, 10, 21, 8, 30), true)];
    expect(flipsOf(JSON.stringify(list))).toEqual({ ok: true, flips: expected });
    expect(flipsOf(JSON.stringify({ flips: list }))).toEqual({ ok: true, flips: expected });
    expect(flipsOf("[]")).toEqual({ ok: true, flips: [] });
  });

  it("gives a problem with no value of the answer for a bad answer and for each bad flip", () => {
    const problems = ["{", "{}", "null", JSON.stringify([{ timestamp: "never", up: 1 }]), JSON.stringify([{ timestamp: "2026-11-20T10:00:00Z", up: 2 }]), JSON.stringify([7])].map((body) => {
      const result = flipsOf(body);
      return result.ok ? "ok" : result.problem;
    });
    expect(problems).toEqual([
      "The answer of the flips is not valid JSON.",
      "The answer of the flips has no list of flips.",
      "The answer of the flips has no list of flips.",
      "A flip of the answer has no valid time or no valid state.",
      "A flip of the answer has no valid time or no valid state.",
      "A flip of the answer has no valid time or no valid state.",
    ]);
  });
});

describe("the sum of the joint down time", () => {
  it("counts the whole window for a check that is down with no flip, and nothing for a check that is up", () => {
    expect(sum([], "up")).toEqual({ down: 0, spans: 0 });
    expect(sum([], "new")).toEqual({ down: 0, spans: 0 });
    expect(sum([], "paused")).toEqual({ down: 0, spans: 0 });
    expect(sum([], "down")).toEqual({ down: JOINT_WINDOW, spans: 1 });
  });

  it("starts a span at the down flip less the lag, and ends it at the next up flip or at the read", () => {
    const at = T0 - DAY;
    expect(sum([flip(at, false), flip(at + 5 * MINUTE, true)], "up", 2 * MINUTE)).toEqual({ down: 7 * MINUTE, spans: 1 });
    expect(sum([flip(T0 - 10 * MINUTE, false)], "down", MINUTE)).toEqual({ down: 11 * MINUTE, spans: 1 });
    // The order of the flips does not matter, and a second flip with the same state changes nothing.
    const twice = [flip(at + 5 * MINUTE, true), flip(at + 6 * MINUTE, true), flip(at, false), flip(at + MINUTE, false)];
    expect(sum(twice, "up", 2 * MINUTE)).toEqual({ down: 7 * MINUTE, spans: 1 });
    expect(sum([flip(at, false), flip(at + 5 * MINUTE, true), flip(at + HOUR, false), flip(at + HOUR + 3 * MINUTE, true)], "up", MINUTE)).toEqual({ down: 10 * MINUTE, spans: 2 });
  });

  it("does not start a span before the flip before it, or before the window", () => {
    const at = T0 - DAY;
    // The first span ends at the up flip. The check went down again one minute later. The lag of 5 minutes stops at the up flip.
    expect(sum([flip(at - HOUR, false), flip(at, true), flip(at + MINUTE, false), flip(at + 2 * MINUTE, true)], "up", 5 * MINUTE)).toEqual({ down: HOUR + 5 * MINUTE + 2 * MINUTE, spans: 2 });
    expect(sum([flip(FROM + MINUTE, false), flip(FROM + 2 * MINUTE, true)], "up", 5 * MINUTE)).toEqual({ down: 2 * MINUTE, spans: 1 });
  });

  it("takes the state at the start of the window from the flips before it, or from the first flip in it", () => {
    // The first flip in the window is up: the check was down at the start of the window.
    expect(sum([flip(FROM + HOUR, true)])).toEqual({ down: HOUR, spans: 1 });
    // A flip before the window tells the state. A down flip before the window counts from the start of the window.
    expect(sum([flip(FROM - DAY, false), flip(FROM + HOUR, true)], "up", 5 * MINUTE)).toEqual({ down: HOUR, spans: 1 });
    expect(sum([flip(FROM - DAY, true), flip(FROM - HOUR, false)], "down")).toEqual({ down: JOINT_WINDOW, spans: 1 });
    expect(sum([flip(FROM - DAY, false), flip(FROM - HOUR, true)], "up")).toEqual({ down: 0, spans: 0 });
  });

  it("ignores a flip after the read, and holds a sum in the window for any flips", () => {
    expect(sum([flip(T0 + MINUTE, false)], "up")).toEqual({ down: 0, spans: 0 });
    expect(sum([flip(T0 - HOUR, false), flip(T0 + MINUTE, true)], "down")).toEqual({ down: HOUR, spans: 1 });
    let seed = 7;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let run = 0; run < 200; run += 1) {
      const flips = Array.from({ length: Math.floor(next() * 12) }, () => flip(FROM - DAY + Math.floor(next() * 9 * DAY), next() < 0.5));
      const result = jointDownTime({ flips, status: next() < 0.5 ? "up" : "down", lag: Math.floor(next() * HOUR), at: T0, window: JOINT_WINDOW });
      expect(result.down).toBeGreaterThanOrEqual(0);
      expect(result.down).toBeLessThanOrEqual(JOINT_WINDOW);
      if (result.spans === 0) expect(result.down).toBe(0);
    }
  });
});

// A pace on a test clock: each wait moves the clock, and no wait takes real time.
function testPace() {
  let now = T0;
  const scheduler = new HostScheduler(
    {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    },
    1,
  );
  return { scheduler, now: () => now };
}

// A transport that answers each URL from a table, and keeps each exchange. The first path in the URL chooses the answer.
function server(routes: Readonly<Record<string, { readonly status: number; readonly body: string } | Error>>) {
  const exchanges: Exchange[] = [];
  const transport: Transport = async (exchange) => {
    exchanges.push(exchange);
    const route = Object.entries(routes).find(([path]) => exchange.url.includes(path))?.[1];
    if (route === undefined) return { status: 404, statusText: "Not Found", headers: {}, body: "" } satisfies Reply;
    if (route instanceof Error) throw route;
    return { status: route.status, statusText: route.status === 200 ? "OK" : "Unauthorized", headers: { "content-type": "application/json" }, body: route.body };
  };
  return { transport, exchanges };
}

const CHECKS = JSON.stringify({ checks: [{ name: "loud", ping_url: LOUD, status: "up", timeout: 300, grace: 60 }] });

describe("the reader of the joint down time", () => {
  const read = (routes: Parameters<typeof server>[0]) => {
    const net = server(routes);
    const reader = jointReader({ key: KEY, url: LOUD, pace: testPace(), transport: net.transport, userAgent: AGENT });
    return { net, run: () => reader(new AbortController().signal, T0) };
  };
  const secretsIn = (reading: JointReading): boolean => !reading.ok && [KEY, LOUD, ID].some((secret) => reading.message.includes(secret));

  it("lists the checks, reads the flips of the loud check by its id, and sums its down time with its lag", async () => {
    const flips = JSON.stringify([
      { timestamp: new Date(T0 - DAY).toISOString(), up: 0 },
      { timestamp: new Date(T0 - DAY + 4 * MINUTE).toISOString(), up: 1 },
    ]);
    const { net, run } = read({ [`/checks/${ID}/flips/`]: { status: 200, body: flips }, "checks/": { status: 200, body: CHECKS } });
    // The period of 300 s and the grace of 60 s come before the down flip.
    expect(await run()).toEqual({ ok: true, down: 10 * MINUTE, spans: 1 });
    expect(net.exchanges.map((exchange) => exchange.url)).toEqual(["https://healthchecks.io/api/v3/checks/", `https://healthchecks.io/api/v3/checks/${ID}/flips/?seconds=604800`]);
    expect(net.exchanges.every((exchange) => exchange.headers?.["x-api-key"] === KEY)).toBe(true);
  });

  it("takes the id from the field uuid when the answer has it", async () => {
    const other = "00000000-0000-4000-8000-000000000002";
    const checks = JSON.stringify({ checks: [{ ping_url: LOUD, uuid: other, status: "down", timeout: 300, grace: 60 }] });
    const { net, run } = read({ [`/checks/${other}/flips/`]: { status: 200, body: "[]" }, "checks/": { status: 200, body: checks } });
    expect(await run()).toEqual({ ok: true, down: JOINT_WINDOW, spans: 1 });
    expect(net.exchanges[1]?.url).toContain(other);
  });

  it("gives a failure with no key, no URL and no id for each bad answer", async () => {
    const readings = [
      await read({ "checks/": { status: 401, body: "" } }).run(),
      await read({ "checks/": { status: 200, body: JSON.stringify({ checks: [] }) } }).run(),
      await read({ [`/checks/${ID}/flips/`]: { status: 401, body: "" }, "checks/": { status: 200, body: CHECKS } }).run(),
      await read({ [`/checks/${ID}/flips/`]: { status: 200, body: "{" }, "checks/": { status: 200, body: CHECKS } }).run(),
      await read({ "checks/": new Error(`connect failed for ${LOUD} with ${KEY}`) }).run(),
    ];
    expect(readings.map((reading) => reading.ok)).toEqual([false, false, false, false, false]);
    expect(readings.some(secretsIn)).toBe(false);
    expect(readings.map((reading) => (reading.ok ? "" : reading.message)).slice(0, 4)).toEqual([
      expect.stringMatching(/^The management API gave .*401.* for the checks of the project\.$/),
      expect.stringMatching(/^No check of the key has the ping URL/),
      expect.stringMatching(/^The management API gave .*401.* for the flips of the loud check\.$/),
      "The answer of the flips is not valid JSON.",
    ]);
  });
});

describe("the watch of the joint down time", () => {
  const ok = (down: number, spans = 1): JointReading => ({ ok: true, down, spans });
  // A reader that gives the next answer of a list, and counts its reads.
  function scripted(answers: readonly (JointReading | Error)[]) {
    let reads = 0;
    const read = async (): Promise<JointReading> => {
      const answer = answers[Math.min(reads, answers.length - 1)]!;
      reads += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    };
    return { read, reads: () => reads };
  }

  it("reads at the first check, then once in each hour, and gives the watch as data of the core", async () => {
    const clock = fakeWallClock(T0);
    const reader = scripted([ok(20 * MINUTE, 2), ok(5 * MINUTE)]);
    const watch = jointWatch({ read: reader.read });
    expect(watch.joint()).toBeUndefined();
    await watch.check(clock);
    expect(reader.reads()).toBe(1);
    expect(watch.joint()).toEqual({ window: JOINT_WINDOW, limit: JOINT_LIMIT, maxAge: JOINT_MAX_AGE, since: T0, read: { down: 20 * MINUTE, spans: 2, at: T0 } });
    expect(watch.nextReadAt()).toBe(T0 + JOINT_EVERY);
    clock.set(T0 + JOINT_EVERY - 1);
    await watch.check(clock);
    expect(reader.reads()).toBe(1);
    clock.set(T0 + JOINT_EVERY);
    await watch.check(clock);
    expect(watch.joint()?.read).toEqual({ down: 5 * MINUTE, spans: 1, at: T0 + JOINT_EVERY });
    expect(watch.health()).toEqual({ what: "joint down time", at: T0 + JOINT_EVERY, failed: false, next: T0 + 2 * JOINT_EVERY });
  });

  it("keeps the last read after a failure, tells the failure, and reads again after the retry", async () => {
    const clock = fakeWallClock(T0);
    const reader = scripted([ok(HOUR), { ok: false, message: "The management API gave 503." }, new Error("socket closed"), ok(0, 0)]);
    const watch = jointWatch({ read: reader.read });
    await watch.check(clock);
    clock.set(T0 + JOINT_EVERY);
    await watch.check(clock);
    expect(watch.failure()).toBe("The management API gave 503.");
    expect(watch.joint()?.read).toEqual({ down: HOUR, spans: 1, at: T0 });
    expect(watch.health()).toMatchObject({ at: T0, failed: true, next: T0 + JOINT_EVERY + JOINT_RETRY });
    clock.set(T0 + JOINT_EVERY + JOINT_RETRY);
    await watch.check(clock);
    expect(watch.failure()).toMatch(/socket closed/);
    clock.set(T0 + JOINT_EVERY + 2 * JOINT_RETRY);
    await watch.check(clock);
    expect(watch.failure()).toBeUndefined();
    expect(watch.joint()?.read).toEqual({ down: 0, spans: 0, at: T0 + JOINT_EVERY + 2 * JOINT_RETRY });
  });

  it("refuses a sum that is not valid, and moves its times at a step of the clock", async () => {
    const clock = fakeWallClock(T0);
    const watch = jointWatch({ read: scripted([ok(-1)]).read });
    await watch.check(clock);
    expect(watch.failure()).toBe("The read of the joint down time gave no valid sum.");
    expect(watch.joint()).toEqual({ window: JOINT_WINDOW, limit: JOINT_LIMIT, maxAge: JOINT_MAX_AGE, since: T0 });
    const moved = jointWatch({ read: scripted([ok(MINUTE)]).read });
    await moved.check(clock);
    moved.shift(HOUR);
    expect(moved.joint()).toMatchObject({ since: T0 + HOUR, read: { at: T0 + HOUR } });
    expect(moved.nextReadAt()).toBe(T0 + HOUR + JOINT_EVERY);
  });

  it("refuses a time that is not a whole count of milliseconds above 0", () => {
    const read = scripted([ok(0)]).read;
    expect(() => jointWatch({ read, every: 0 })).toThrow(/every/);
    expect(() => jointWatch({ read, maxAge: 1.5 })).toThrow(/maxAge/);
    expect(() => jointWatch({ read, downLimit: -1 })).toThrow(/downLimit/);
  });
});
