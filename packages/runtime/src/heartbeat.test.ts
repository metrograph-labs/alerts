import type { ChannelId, PersonId, ReportId, SourceId } from "@mark1russell7/alerts";
import { fakeWallClock } from "@mark1russell7/algebra/clock";
import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import {
  checkOfPingUrl,
  checksRequest,
  checkTimesProblem,
  heartbeat,
  HEARTBEAT_EVERY,
  HEARTBEAT_LIMIT,
  HEARTBEAT_START,
  heartbeatGap,
  heartbeatStep,
  heldOf,
  holdStep,
  pingOf,
  pingUrl,
  REFUSAL_KINDS,
  shiftHeartbeat,
  UNREACHABLE,
  type HeartbeatFetch,
  type HeartbeatState,
  type PassSummary,
  type RefusalView,
} from "./heartbeat.ts";
import { envelope, type RuntimeEvent } from "./events.ts";
import { INSTANCE_TIMES } from "./instance.ts";
import { EMPTY_RUNTIME, fold, refusalKept } from "./state.ts";

const T0 = Date.UTC(2026, 10, 15, 12, 0);
const SECOND = 1000;
const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4]);
// A fake ping URL. No check has it.
const URL_OF_CHECK = "https://hc-ping.com/00000000-0000-4000-8000-000000000000";
const AGENT = "alerts-runtime (test)";
const NWS = "nws-api" as SourceId;
const IPAWS = "ipaws" as SourceId;

const healthy = (at: number): PassSummary => ({
  at,
  view: {
    health: [
      { source: NWS, state: "healthy" },
      { source: IPAWS, state: "failing" },
    ],
  },
});
/** A pass with a refused send on Pushover that goes again at `retryAt`, and a status call that failed on the network. */
const refused = (at: number, kind = "auth", retryAt = at + 10 * SECOND): PassSummary => ({
  ...healthy(at),
  delivery: {
    sent: [],
    failures: [
      { call: "send", channel: "pushover", kind, retryAt },
      { call: "status", channel: "pushover", kind: "network", retryAt },
    ],
  },
});
/** A pass with a send on Pushover. */
const sent = (at: number): PassSummary => ({ ...healthy(at), delivery: { sent: [{ channel: "pushover" }], failures: [] } });

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
};

/** A fake server of pings. Each call waits for `answer`, or ends at the abort of its signal. */
function pings(answer: () => Promise<number> = async () => 200) {
  const calls: { url: string; body: string; agent: string | undefined; method: string }[] = [];
  const fetch: HeartbeatFetch = (url, init) => {
    calls.push({ url, body: init.body, agent: init.headers["user-agent"], method: init.method });
    return new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error(`The request to ${url} was aborted.`)));
      answer().then((status) => resolve({ status }), reject);
    });
  };
  return { calls, fetch };
}

function open(answer?: () => Promise<number>, onError: (message: string) => void = () => undefined, held?: (at: number) => HeartbeatState["held"], successOnly?: boolean) {
  const clock = fakeWallClock(T0);
  const server = pings(answer);
  const errors: string[] = [];
  const hook = heartbeat({
    url: URL_OF_CHECK,
    fetch: server.fetch,
    clock,
    userAgent: AGENT,
    ...(held === undefined ? {} : { held }),
    ...(successOnly === undefined ? {} : { successOnly }),
    onError: (message) => {
      errors.push(message);
      onError(message);
    },
  });
  return { clock, server, errors, hook };
}

/** This function runs the steps of a list of passes, and gives the kind of each ping, or `-` for no ping. */
function kindsOf(passes: readonly PassSummary[], every = 60 * SECOND): string[] {
  let state: HeartbeatState = HEARTBEAT_START;
  return passes.map((pass) => {
    const step = heartbeatStep(state, pass, every);
    state = step.state;
    return step.ping?.kind ?? "-";
  });
}

describe("the steps of the heartbeat", () => {
  it("pings at the first pass, then once in each 60 s", () => {
    expect(kindsOf([T0, T0 + 30 * SECOND, T0 + 60 * SECOND, T0 + 90 * SECOND, T0 + 121 * SECOND].map(healthy))).toEqual(["success", "-", "success", "-", "success"]);
  });

  it("pings fail at once when a channel refuses a send, and success at once after a send on it", () => {
    let state = heartbeatStep(HEARTBEAT_START, healthy(T0), 60 * SECOND).state;
    const fail = heartbeatStep(state, refused(T0 + SECOND), 60 * SECOND);
    expect(fail.ping).toEqual({ kind: "fail", body: "The channel pushover gave the kind auth to a send." });
    state = fail.state;
    const back = heartbeatStep(state, sent(T0 + 2 * SECOND), 60 * SECOND);
    expect(back.ping?.kind).toBe("success");
  });

  it("holds the fail through the passes before the retry: one fail ping and no success ping", () => {
    const passes = [healthy(T0), refused(T0 + SECOND, "auth", T0 + 11 * SECOND), healthy(T0 + 4 * SECOND), healthy(T0 + 8 * SECOND), refused(T0 + 11 * SECOND, "auth", T0 + 21 * SECOND)];
    expect(kindsOf(passes)).toEqual(["success", "fail", "-", "-", "-"]);
  });

  it("moves its times by a step of the wall clock: the fail holds to its retry, and the next ping comes at its time (AL-49)", () => {
    const HOUR = 3_600_000;
    const every = 60 * SECOND;
    // The channel refused a send at T0 + 1 s, with a retry at T0 + 11 s. Then the wall clock stepped back 1 h.
    let state = heartbeatStep(HEARTBEAT_START, healthy(T0), every).state;
    state = heartbeatStep(state, refused(T0 + SECOND, "auth", T0 + 11 * SECOND), every).state;
    expect(shiftHeartbeat(state, -HOUR)).toEqual({ last: { at: T0 + SECOND - HOUR, kind: "fail" }, held: { pushover: { kinds: ["auth"], until: T0 + 11 * SECOND - HOUR } } });
    const after = heartbeatStep(state, { ...healthy(T0 + 4 * SECOND - HOUR), stepped: -HOUR }, every);
    // No ping: the step back is not a change, and the fail holds to its retry on the monotonic clock.
    expect(after.ping).toBeUndefined();
    expect(after.state.held["pushover"]?.until).toBe(T0 + 11 * SECOND - HOUR);
    expect(heartbeatStep(after.state, healthy(T0 + 10 * SECOND - HOUR), every).ping).toBeUndefined();
    expect(heartbeatStep(after.state, healthy(T0 + 11 * SECOND - HOUR), every).ping?.kind).toBe("success");
    // With no size of the step, a time before the last ping gives a ping, as a clock with no frames needs.
    expect(heartbeatStep(state, healthy(T0 + 4 * SECOND - HOUR), every).ping?.kind).toBe("fail");
    expect(shiftHeartbeat(HEARTBEAT_START, HOUR)).toEqual(HEARTBEAT_START);
  });

  it("ends the fail at the first pass at or after the retry with no refusal on the channel", () => {
    const passes = [refused(T0, "auth", T0 + 10 * SECOND), healthy(T0 + 9 * SECOND), healthy(T0 + 10 * SECOND)];
    expect(kindsOf(passes)).toEqual(["fail", "-", "success"]);
  });

  it("keeps the fail when one pass has a send and a refusal on the channel", () => {
    const both: PassSummary = { ...healthy(T0 + SECOND), delivery: { sent: [{ channel: "pushover" }], failures: [{ call: "send", channel: "pushover", kind: "rate-limited", retryAt: T0 + 30 * SECOND }] } };
    expect(holdStep(holdStep({}, refused(T0)), both)).toEqual({ pushover: { kinds: ["rate-limited"], until: T0 + 30 * SECOND } });
  });

  it("adds the kinds and keeps the latest retry while the fail holds", () => {
    const held = holdStep(holdStep({}, refused(T0, "rate-limited", T0 + 30 * SECOND)), refused(T0 + SECOND, "auth", T0 + 11 * SECOND));
    expect(held).toEqual({ pushover: { kinds: ["auth", "rate-limited"], until: T0 + 30 * SECOND } });
    expect(pingOf(healthy(T0 + SECOND), held).body).toBe("The channel pushover gave the kind auth to a send.\nThe channel pushover gave the kind rate-limited to a send.");
  });

  it("gives success to a failure that can pass, and puts the state of each source in the body", () => {
    expect(pingOf({ ...healthy(T0), delivery: { sent: [], failures: [{ call: "send", channel: "pushover", kind: "network", retryAt: T0 }] } })).toEqual({
      kind: "success",
      body: "nws-api: healthy\nipaws: failing",
    });
    expect(pingOf(refused(T0, "rate-limited")).kind).toBe("fail");
    expect(pingOf(refused(T0, "refused")).kind).toBe("fail");
  });

  it("gives success to a send in the reserve of a quota, and holds no fail for it", () => {
    expect(UNREACHABLE).toEqual(["auth", "refused", "rate-limited"]);
    expect(REFUSAL_KINDS).toEqual([...UNREACHABLE, "reserved", "consent", "quiet", "expired"]);
    expect(holdStep({}, refused(T0, "reserved"))).toEqual({});
    expect(pingOf(refused(T0, "reserved")).kind).toBe("success");
    expect(heldOf({ refusals: { a: { channel: "pushover", kind: "reserved", retryAt: T0 + 60 * SECOND, deliveries: 0 } }, delivered: {} }, T0)).toEqual({});
  });

  it("gives success to a send that the person refused with a STOP reply, and holds no fail for it", () => {
    expect(holdStep({}, refused(T0, "consent"))).toEqual({});
    expect(pingOf(refused(T0, "consent")).kind).toBe("success");
    expect(heldOf({ refusals: { a: { channel: "twilio-text", kind: "consent", retryAt: T0 + 60 * SECOND, deliveries: 0 } }, delivered: {} }, T0)).toEqual({});
  });

  it("gives success to a quiet call at night and to an expired message, and holds no fail for them", () => {
    // A call has no silent mode. A notice at night is quiet, thus the call channel refuses it. That is not a fault.
    for (const kind of ["quiet", "expired"] as const) {
      expect(holdStep({}, refused(T0, kind))).toEqual({});
      expect(pingOf(refused(T0, kind)).kind).toBe("success");
      expect(heldOf({ refusals: { a: { channel: "twilio-call", kind, retryAt: T0 + 60 * SECOND, deliveries: 0 } }, delivered: {} }, T0)).toEqual({});
    }
  });

  it("pings again when the wall clock steps back", () => {
    expect(kindsOf([healthy(T0), healthy(T0 - 3600 * SECOND)])).toEqual(["success", "success"]);
  });

  it("starts no ping while a ping is in flight, keeps the last ping, and still holds a fail", () => {
    const first = heartbeatStep(HEARTBEAT_START, healthy(T0), 60 * SECOND);
    const busy = heartbeatStep(first.state, refused(T0 + SECOND), 60 * SECOND, true);
    expect(busy.ping).toBeUndefined();
    expect(busy.state.last).toEqual({ at: T0, kind: "success" });
    expect(Object.keys(busy.state.held)).toEqual(["pushover"]);
    expect(heartbeatStep(busy.state, healthy(T0 + 2 * SECOND), 60 * SECOND).ping?.kind).toBe("fail");
  });

  it("adds /fail to the path of the ping URL and keeps its query", () => {
    expect(pingUrl(URL_OF_CHECK, "success")).toBe(URL_OF_CHECK);
    expect(pingUrl(URL_OF_CHECK, "fail")).toBe(`${URL_OF_CHECK}/fail`);
    expect(pingUrl("https://hc-ping.com/key/alerts-runtime/?create=1", "fail")).toBe("https://hc-ping.com/key/alerts-runtime/fail?create=1");
  });
});

describe("the overdue sends", () => {
  // A pass in which the send on Pushover failed on the network again, and the oldest due send is from `since`.
  const overdue = (at: number, since: number, sends = 1): PassSummary => ({
    ...healthy(at),
    delivery: { sent: [], failures: [{ call: "send", channel: "pushover", kind: "network", retryAt: at + 10 * SECOND }], overdue: [{ channel: "pushover", sends, since }] },
  });

  it("pings fail for an overdue send whatever the kind of its failures, and success after its delivery", () => {
    let state = heartbeatStep(HEARTBEAT_START, healthy(T0), 60 * SECOND).state;
    // A failure of the kind network alone holds no fail.
    const unsure = heartbeatStep(state, refused(T0 + SECOND, "network"), 60 * SECOND);
    expect(unsure.ping).toBeUndefined();
    state = unsure.state;
    const fail = heartbeatStep(state, overdue(T0 + 150 * SECOND, T0), 60 * SECOND);
    expect(fail.ping).toEqual({ kind: "fail", body: "The channel pushover has overdue sends: 1. The oldest is 150 s after its due time." });
    expect(heartbeatStep(fail.state, sent(T0 + 160 * SECOND), 60 * SECOND).ping?.kind).toBe("success");
  });

  it("gives the lines of the refusals first, then the overdue sends of each channel in the order of the ids", () => {
    const pass: PassSummary = {
      ...healthy(T0 + 200 * SECOND),
      delivery: {
        sent: [],
        failures: [{ call: "send", channel: "sms", kind: "auth", retryAt: T0 + 210 * SECOND }],
        overdue: [
          { channel: "sms", sends: 1, since: T0 + 50 * SECOND },
          { channel: "pushover", sends: 3, since: T0 },
        ],
      },
    };
    expect(pingOf(pass).body).toBe(
      ["The channel sms gave the kind auth to a send.", "The channel pushover has overdue sends: 3. The oldest is 200 s after its due time.", "The channel sms has overdue sends: 1. The oldest is 150 s after its due time."].join("\n"),
    );
  });

  it("pings success for an empty list of overdue sends", () => {
    expect(pingOf({ ...healthy(T0), delivery: { sent: [], failures: [], overdue: [] } }).kind).toBe("success");
  });
});

describe("the refused channels of the log", () => {
  const view = (refusals: RefusalView["refusals"], delivered: RefusalView["delivered"] = {}): RefusalView => ({ refusals, delivered });

  it("holds each channel with a waiting refusal and no later delivery, with the sorted kinds and the latest retry", () => {
    const state = view(
      {
        a: { channel: "pushover", kind: "rate-limited", retryAt: T0 + 120 * SECOND, deliveries: 3 },
        b: { channel: "pushover", kind: "auth", retryAt: T0 + 60 * SECOND, deliveries: 3 },
        // The retry of this refusal is before the time of the first pass, thus its kind is old.
        c: { channel: "pushover", kind: "refused", retryAt: T0 + 2 * SECOND, deliveries: 3 },
        // A delivery on the channel came after this refusal in the log, thus the channel works.
        d: { channel: "twilio", kind: "refused", retryAt: T0 + 30 * SECOND, deliveries: 0 },
      },
      { pushover: 3, twilio: 1 },
    );
    expect(heldOf(state, T0 + 2 * SECOND)).toEqual({ pushover: { kinds: ["auth", "rate-limited"], until: T0 + 120 * SECOND } });
  });

  it("holds nothing with no refusal, and holds a channel whose refusal has no later delivery", () => {
    expect(heldOf(view({}), T0)).toEqual({});
    const refused = view({ a: { channel: "pushover", kind: "auth", retryAt: T0 + 60 * SECOND, deliveries: 0 } });
    expect(heldOf(refused, T0 + SECOND)).toEqual({ pushover: { kinds: ["auth"], until: T0 + 60 * SECOND } });
  });

  const delivery = (key: string, channel: string, at: number): RuntimeEvent => ({
    ...envelope("delivery", `delivery:${key}`, at),
    delivery: { key, incident: "report-1" as ReportId, level: "urgent", person: "person-1" as PersonId, channel: channel as ChannelId, step: 0, at },
  });

  it("keeps the hold of each channel across a restart at each pass, also when a channel accepts after the time of the refusal", () => {
    const CHANNELS = ["pushover", "twilio"];
    for (const seed of SEEDS) {
      const r = random(seed).fork("restart");
      // Each pass writes its deliveries, then its refusals, as the step does. A late send of a pass lands in the next pass,
      // and each time of acceptance can be after the time of the refusals of its pass.
      const passes: PassSummary[] = [];
      const logs: RuntimeEvent[][] = [];
      let landing: string[] = [];
      let keys = 0;
      for (let index = 0; index < 40; index++) {
        const at = T0 + index * 30 * SECOND;
        const sent = [...landing, ...CHANNELS.filter(() => r.chance(0.25))];
        landing = CHANNELS.filter(() => r.chance(0.1));
        const failures = CHANNELS.filter(() => r.chance(0.3)).map((channel) => ({
          call: "send",
          channel,
          // Each kind of a refusal, also `reserved`, which neither way holds.
          kind: REFUSAL_KINDS[r.int(0, REFUSAL_KINDS.length - 1)]!,
          retryAt: at + r.int(0, 200) * SECOND,
        }));
        const refusedAt = at + r.int(0, 10) * SECOND;
        logs.push([
          ...sent.map((channel) => delivery(`k${keys++}`, channel, refusedAt + r.int(-10, 20) * SECOND)),
          ...failures.map((failure) => {
            const key = `k${keys++}`;
            return { ...envelope("refused", `refused:${key}@${at}`, refusedAt), key, channel: failure.channel as ChannelId, kind: failure.kind, retryAt: failure.retryAt };
          }),
        ]);
        passes.push({ ...healthy(at), delivery: { sent: sent.map((channel) => ({ channel })), failures } });
      }
      const straight: HeartbeatState["held"][] = [];
      passes.reduce<HeartbeatState["held"]>((held, pass) => {
        const next = holdStep(held, pass);
        straight.push(next);
        return next;
      }, {});
      for (let stop = 0; stop < passes.length - 1; stop++) {
        // The restart writes its start, then its first pass comes.
        const restart = passes[stop + 1]!.at;
        const events = [...logs.slice(0, stop + 1).flat(), { ...envelope("started", `started:run-${stop}`, restart), run: `run-${stop}` }];
        const state = events.reduce((before, event) => fold(before, event, { sources: [] }), EMPTY_RUNTIME);
        let held = heldOf(state, restart);
        for (let index = stop + 1; index < passes.length; index++) {
          held = holdStep(held, passes[index]!);
          const expected = straight[index]!;
          const label = `seed ${seed}, a restart after pass ${stop}, pass ${index}`;
          expect(Object.fromEntries(Object.entries(held).map(([channel, hold]) => [channel, hold.until])), label).toEqual(
            Object.fromEntries(Object.entries(expected).map(([channel, hold]) => [channel, hold.until])),
          );
          for (const [channel, hold] of Object.entries(held)) expect(expected[channel]!.kinds, label).toEqual(expect.arrayContaining([...hold.kinds]));
        }
        // The state keeps only the refusals that the log keeps at the start. The holds above read only the waits after it.
        for (const refusal of Object.values(state.refusals)) expect(refusalKept(refusal, restart), `seed ${seed}, a restart after pass ${stop}`).toBe(true);
      }
    }
  });
});

describe("the gap of two pings", () => {
  it("adds the period, two pass limits, the longest wait, the ping limit, and a pass and a wait for each failed pass", () => {
    const times = { passLimit: 80 * SECOND, retryCap: 60 * SECOND };
    expect(heartbeatGap(times, { failedPasses: 0 })).toBe(HEARTBEAT_EVERY + 160 * SECOND + 60 * SECOND + HEARTBEAT_LIMIT);
    expect(heartbeatGap(times, { failedPasses: 2 }) - heartbeatGap(times, { failedPasses: 0 })).toBe(280 * SECOND);
    // The instance: two sources with an interval of 60 s, and two calls of 10 s. One failed pass is let pass.
    expect(heartbeatGap(INSTANCE_TIMES)).toBe(430 * SECOND);
  });

  it.each(SEEDS)("bounds the gap of two success pings in runs of passes with random times (seed %s)", (seed) => {
    const r = random(seed).fork("gap");
    const times = { passLimit: 80 * SECOND, retryCap: 60 * SECOND };
    for (let run = 0; run < 200; run++) {
      let state: HeartbeatState = HEARTBEAT_START;
      let start = T0;
      let arrival: number | undefined;
      let failed = 0;
      for (let pass = 0; pass < 40; pass++) {
        const end = start + r.range(0, times.passLimit);
        if (r.chance(0.1)) failed += 1;
        else {
          // The time of a pass is in the pass. The ping starts at its end and arrives within the limit.
          const step = heartbeatStep(state, healthy(r.range(start, end)), HEARTBEAT_EVERY);
          state = step.state;
          if (step.ping !== undefined) {
            const next = end + r.range(0, HEARTBEAT_LIMIT);
            if (arrival !== undefined) {
              expect(next - arrival).toBeLessThanOrEqual(heartbeatGap(times, { failedPasses: failed }));
            }
            arrival = next;
            failed = 0;
          }
        }
        start = end + r.range(0, times.retryCap);
      }
    }
  });

  it("is reached by a run: the time of the first pass at its end, the time of the next pass at its start", () => {
    const times = { passLimit: 80 * SECOND, retryCap: 60 * SECOND };
    // Each pass takes the pass limit, and each wait is the longest wait. The first ping arrives at the end of its pass.
    const first = { at: T0 + 80 * SECOND, end: T0 + 80 * SECOND };
    const second = { at: first.at + HEARTBEAT_EVERY - 1, end: first.at + HEARTBEAT_EVERY - 1 + 80 * SECOND };
    const third = { at: second.end + 60 * SECOND, end: second.end + 140 * SECOND };
    expect(kindsOf([first, second, third].map((pass) => healthy(pass.at)))).toEqual(["success", "-", "success"]);
    expect(third.end + HEARTBEAT_LIMIT - first.end).toBe(heartbeatGap(times, { failedPasses: 0 }) - 1);
  });
});

describe("the check of Healthchecks.io", () => {
  const answer = (checks: unknown): string => JSON.stringify({ checks });
  const check = { name: "alerts", ping_url: URL_OF_CHECK, status: "up", timeout: 60, grace: 400 };

  it("asks the management API with the key and the User-Agent", () => {
    expect(checksRequest("key-test", AGENT)).toEqual({
      method: "GET",
      url: "https://healthchecks.io/api/v3/checks/",
      headers: { accept: "application/json", "user-agent": AGENT, "x-api-key": "key-test" },
      body: null,
    });
  });

  it("finds the check of the ping URL, and gives its times in milliseconds", () => {
    const other = { ...check, ping_url: "https://hc-ping.com/11111111-1111-4111-8111-111111111111", timeout: 86400 };
    expect(checkOfPingUrl(answer([other, { ...check, ping_url: `${URL_OF_CHECK}/` }]), URL_OF_CHECK)).toEqual({ ok: true, check: { status: "up", timeout: 60 * SECOND, grace: 400 * SECOND } });
  });

  it("compares the URLs in linear time, also for a long run of slashes from the server", { timeout: 2_000 }, () => {
    const slashes = "/".repeat(100_000);
    const hostile = { ...check, ping_url: `${slashes}x` };
    const found = checkOfPingUrl(answer([hostile, { ...check, ping_url: `${URL_OF_CHECK}${slashes}` }]), URL_OF_CHECK);
    expect(found).toEqual({ ok: true, check: { status: "up", timeout: 60 * SECOND, grace: 400 * SECOND } });
    expect(checkOfPingUrl(answer([hostile]), `${slashes}x${slashes}`)).toMatchObject({ ok: true });
    expect(checkOfPingUrl(answer([hostile]), `${slashes}y`)).toMatchObject({ ok: false });
  });

  it("gives a problem with no URL for no check, a key that only reads, a cron check and a bad answer", () => {
    const problems = [
      checkOfPingUrl(answer([]), URL_OF_CHECK),
      checkOfPingUrl(answer([{ name: "alerts", unique_key: "abc", timeout: 60, grace: 400 }]), URL_OF_CHECK),
      checkOfPingUrl(answer([{ ...check, timeout: undefined, schedule: "* * * * *" }]), URL_OF_CHECK),
      checkOfPingUrl("{", URL_OF_CHECK),
      checkOfPingUrl("{}", URL_OF_CHECK),
    ].map((result) => (result.ok ? "ok" : result.problem));
    expect(problems).toEqual([
      expect.stringMatching(/^No check of the key has the ping URL/),
      expect.stringMatching(/^No check of the key has the ping URL/),
      "The check has a cron schedule. The heartbeat needs a check with a period.",
      "The answer of the management API is not valid JSON.",
      "The answer of the management API has no list of checks.",
    ]);
    for (const problem of problems) expect(problem).not.toContain("00000000");
  });

  it("refuses a check whose period plus grace is shorter than the gap", () => {
    const gap = heartbeatGap(INSTANCE_TIMES);
    expect(checkTimesProblem({ status: "up", timeout: 60 * SECOND, grace: 370 * SECOND }, gap)).toBeUndefined();
    expect(checkTimesProblem({ status: "new", timeout: 86400 * SECOND, grace: 3600 * SECOND }, gap)).toBeUndefined();
    expect(checkTimesProblem({ status: "up", timeout: 60 * SECOND, grace: 60 * SECOND }, gap)).toBe("The period plus the grace of the check is 120 s. The heartbeat needs 430 s or more.");
  });
});

describe("the hook of the heartbeat", () => {
  it("posts the ping with the User-Agent and the body, and ends before the answer", async () => {
    let answer: (status: number) => void = () => undefined;
    const { server, hook, errors } = open(() => new Promise((resolve) => (answer = resolve)));
    expect(hook(healthy(T0))).toBeUndefined();
    await settle();
    expect(server.calls).toEqual([{ url: URL_OF_CHECK, body: "nws-api: healthy\nipaws: failing", agent: AGENT, method: "POST" }]);
    answer(200);
    await settle();
    expect(errors).toEqual([]);
  });

  it("posts a fail to /fail", async () => {
    const { server, hook } = open();
    hook(refused(T0));
    await settle();
    expect(server.calls.map((call) => [call.url, call.body])).toEqual([[`${URL_OF_CHECK}/fail`, "The channel pushover gave the kind auth to a send."]]);
  });

  it("sends only the success pings to a shared check: a fail sends nothing, and the next success pings at once (AL-100)", async () => {
    const { server, hook } = open(undefined, undefined, undefined, true);
    hook(healthy(T0));
    await settle();
    // The fail starts, and it holds past the period of the pings. A hook with each ping sends /fail two times here.
    hook(refused(T0 + SECOND, "auth", T0 + 70 * SECOND));
    await settle();
    hook(refused(T0 + 61 * SECOND, "auth", T0 + 70 * SECOND));
    await settle();
    // A send on the channel ends the fail. The kind changes, thus the success ping goes at once.
    hook(sent(T0 + 62 * SECOND));
    await settle();
    expect(server.calls.map((call) => [call.url, call.body])).toEqual([
      [URL_OF_CHECK, "nws-api: healthy
ipaws: failing"],
      [URL_OF_CHECK, "nws-api: healthy
ipaws: failing"],
    ]);
  });

  it("gives the shared check no fail of one copy while another copy works: only the success pings of the working copy (AL-100)", async () => {
    const server = pings();
    const copy = () => heartbeat({ url: URL_OF_CHECK, fetch: server.fetch, clock: fakeWallClock(T0), userAgent: AGENT, successOnly: true, onError: () => undefined });
    const home = copy();
    const cloud = copy();
    for (let minute = 0; minute < 3; minute++) {
      const at = T0 + minute * 60 * SECOND;
      home(refused(at, "auth", at + 90 * SECOND));
      cloud(healthy(at));
      await settle();
    }
    expect(server.calls.map((call) => call.url)).toEqual([URL_OF_CHECK, URL_OF_CHECK, URL_OF_CHECK]);
  });

  it("starts from the refused channels of the log at its first pass, and reads them one time", async () => {
    const reads: number[] = [];
    const held = (at: number): HeartbeatState["held"] => {
      reads.push(at);
      return { pushover: { kinds: ["auth"], until: T0 + 90 * SECOND } };
    };
    const { server, hook } = open(undefined, undefined, held);
    // A restart: the first pass has no refusal, but the retry of the refused send is later.
    hook(healthy(T0));
    await settle();
    hook(healthy(T0 + 60 * SECOND));
    await settle();
    // The pass at the retry has no refusal, thus the fail ends.
    hook(healthy(T0 + 90 * SECOND));
    await settle();
    expect(reads).toEqual([T0]);
    expect(server.calls.map((call) => [call.url, call.body])).toEqual([
      [`${URL_OF_CHECK}/fail`, "The channel pushover gave the kind auth to a send."],
      [`${URL_OF_CHECK}/fail`, "The channel pushover gave the kind auth to a send."],
      [URL_OF_CHECK, "nws-api: healthy\nipaws: failing"],
    ]);
  });

  it("stops a ping at its limit, keeps one ping in flight, and gives no URL in the error", async () => {
    const { clock, server, hook, errors } = open(() => new Promise<number>(() => undefined));
    hook(healthy(T0));
    await settle();
    // The ping is in flight, thus a new kind starts no second ping.
    hook(refused(T0 + SECOND, "auth", T0 + 60 * SECOND));
    await settle();
    expect(server.calls).toHaveLength(1);
    await clock.advance(10 * SECOND);
    await settle();
    expect(errors).toEqual(["The success ping of the heartbeat failed. It took longer than 10000 ms."]);
    // The fail of the pass in flight holds, thus the next pass pings it.
    hook(healthy(T0 + 11 * SECOND));
    await settle();
    expect(server.calls.map((call) => call.url)).toEqual([URL_OF_CHECK, `${URL_OF_CHECK}/fail`]);
  });

  it("pings again at the next pass after a lost ping", async () => {
    let status = 503;
    const { server, hook, errors } = open(async () => status);
    hook(healthy(T0));
    await settle();
    status = 200;
    hook(healthy(T0 + SECOND));
    await settle();
    hook(healthy(T0 + 2 * SECOND));
    await settle();
    expect(server.calls).toHaveLength(2);
    expect(errors).toEqual(["The success ping of the heartbeat got the status 503."]);
  });

  it("removes the ping URL from the text of a failed fetch", async () => {
    const { hook, errors } = open(async () => {
      throw new Error(`The connection to ${URL_OF_CHECK} failed.`);
    });
    hook(healthy(T0));
    await settle();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^The success ping of the heartbeat failed\. /);
    expect(errors[0]).not.toContain("00000000-0000-4000-8000-000000000000");
  });

  it("gives a status that is not 2xx to onError, and survives an error of onError", async () => {
    const { hook, errors } = open(
      async () => 404,
      () => {
        throw new Error("The log is closed.");
      },
    );
    hook(healthy(T0));
    await settle();
    expect(errors).toEqual(["The success ping of the heartbeat got the status 404."]);
  });

  it("adds the notes to the body of each ping, and a fault of the notes gives an error with no URL and no note", async () => {
    const clock = fakeWallClock(T0);
    const server = pings();
    const errors: string[] = [];
    let fault = false;
    const notes = (at: number): readonly string[] => {
      if (fault) throw new Error(`The store of ${URL_OF_CHECK} failed.`);
      return [`pushover: a note at ${at}`];
    };
    const hook = heartbeat({ url: URL_OF_CHECK, fetch: server.fetch, clock, userAgent: AGENT, notes, onError: (message) => errors.push(message) });
    hook(healthy(T0));
    await settle();
    fault = true;
    hook(refused(T0 + SECOND));
    await settle();
    expect(server.calls.map((call) => call.body)).toEqual([`nws-api: healthy\nipaws: failing\npushover: a note at ${T0}`, "The channel pushover gave the kind auth to a send."]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("The notes of the ping failed.");
    expect(errors[0]).not.toContain(URL_OF_CHECK);
  });

  it("refuses a ping URL that is not a URL or has no https, and names no URL", () => {
    const options = { fetch: pings().fetch, clock: fakeWallClock(T0), userAgent: AGENT, onError: () => undefined };
    expect(() => heartbeat({ ...options, url: "hc-ping.com/secret-key" })).toThrow("The ping URL of the heartbeat is not a URL.");
    expect(() => heartbeat({ ...options, url: "http://hc-ping.com/secret-key" })).toThrow("The ping URL of the heartbeat does not start with https.");
  });
});
