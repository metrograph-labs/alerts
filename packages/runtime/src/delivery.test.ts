import { fakeWallClock } from "@mark1russell7/algebra/clock";
import {
  COPY_ID,
  DEFAULT_THROTTLE,
  ESCALATION_KIND,
  HELD_SHOWN,
  ONLY_COPY,
  PERSON_SUBJECT,
  PRIORS_FORMAT,
  WHY_LIMITS,
  messageKey,
  reportId,
  shadowScore,
  type ChannelDescriptor,
  type ChannelId,
  type ChannelProcedures,
  type DeliveryStatus,
  type EscalationPolicy,
  type LinkPolicy,
  type InterestGraph,
  type Message,
  type Observation,
  type ObservationId,
  type PersonId,
  type PlaceId,
  type Position,
  type ProbeOutcome,
  type Receipt,
  type Recipient,
  type Report,
  type ScorePriors,
  type SendOutcome,
  type SourceId,
  type SourceProcedures,
  type WatchedPlace,
} from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import type { DeliveryOptions } from "./delivery.ts";
import { envelope, type RuntimeEvent } from "./events.ts";
import { heldOf, holdStep } from "./heartbeat.ts";
import { openRuntimeLog, type RuntimeLog } from "./log.ts";
import { openRuntime, type RuntimeOptions } from "./runtime.ts";
import { rebuild, REFUSAL_LIMIT, refusalStreak, refusalWait } from "./state.ts";

const T0 = Date.UTC(2026, 3, 1, 18, 0, 0);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const API = "api" as SourceId;
const PUSHOVER = "pushover" as ChannelId;
const SMS = "sms" as ChannelId;
const PERSON = "person-1" as PersonId;

// A public place in Kansas: Sedgwick County KS.
const KANSAS: WatchedPlace = { id: "place:a" as PlaceId, codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 0 };
const VIEW: RuntimeOptions["view"] = { places: [KANSAS], kinds: ["met"], expectations: [], delay: { quantile: 0.9, level: 0.9 } };

const LIFE_SAFETY: EscalationPolicy = {
  level: "life-safety",
  steps: [
    { channel: PUSHOVER, at: 0 },
    { channel: SMS, at: 5 * MINUTE },
  ],
  exhaustedAfter: 20 * MINUTE,
};
const RECIPIENT: Recipient = {
  watch: { person: PERSON, places: [KANSAS.id], rules: [] },
  policies: [LIFE_SAFETY],
  addresses: { pushover: { user: "fake-user" }, sms: { to: "fake-number" } },
};

// One tornado warning for Sedgwick County, issued at T0, for 45 minutes.
function warning(seen: Observation): Report {
  return {
    id: reportId({ source: API, key: "w1", sent: T0 }),
    source: API,
    origin: "nws",
    key: "w1",
    references: [],
    correlation: [],
    status: "actual",
    op: "alert",
    kind: { code: "met.tornado", label: "Tornado Warning" },
    categories: ["met"],
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    response: ["shelter"],
    sent: T0,
    received: seen.fetched,
    expires: T0 + 45 * MINUTE,
    areas: [{ type: "code", system: "ugc", code: "KSZ083" }],
    about: [],
    sender: "w-nws.webmaster@noaa.gov",
    headline: "Tornado Warning issued April 1 at 1:00PM CDT by NWS Wichita KS",
    instruction: "TAKE COVER NOW!",
    observation: seen.id,
    parameters: {},
  };
}

const SOURCE: SourceProcedures = {
  describe: () => ({
    id: API,
    title: "The source api",
    origins: ["nws"],
    dependsOn: ["provider:api"],
    uses: ["internet", "dns", "power"],
    kinds: ["met"],
    coverage: [{ type: "code", system: "ugc", code: "KSZ083" }],
    transport: "poll",
    interval: MINUTE,
    slowAfter: 10 * SECOND,
    auth: "none",
  }),
  fetch: async () => ({
    ok: true,
    observations: [{ id: "api:w1" as ObservationId, source: API, fetched: T0, contentType: "application/json", body: "{}", transport: { latency: 0 } }],
    complete: true,
  }),
  map: ({ observation }) => ({ reports: [warning(observation)], problems: [] }),
};

interface Calls {
  readonly send: Message[];
  /** The copy id of each send. */
  readonly copies: (string | undefined)[];
  readonly status: Receipt[];
  /** The cancels by a receipt. */
  readonly cancel: Receipt[];
  /** The stops of one copy by its copy id. */
  readonly stops: string[];
}

interface Script {
  /** A send that gives `undefined` accepts the message. */
  send?: (message: Message, count: number) => SendOutcome | undefined | Promise<SendOutcome>;
  status?: (receipt: Receipt) => DeliveryStatus;
  cancel?: (receipt: Receipt) => void | Promise<void>;
  stop?: (copy: string) => void | Promise<void>;
  /** The fields that replace the fields of the default descriptor. */
  describe?: Partial<ChannelDescriptor>;
  /** The probe of the channel. Without it, the channel has no probe. */
  probe?: () => ProbeOutcome;
}

// A channel of the test. Its default send accepts each message with a new receipt.
function channel(id: ChannelId, ack: ChannelDescriptor["ack"], now: () => number, script: Script = {}): { readonly procedures: ChannelProcedures; readonly calls: Calls } {
  const calls: Calls = { send: [], copies: [], status: [], cancel: [], stops: [] };
  const procedures: ChannelProcedures = {
    describe: () => ({ id, title: id, dependsOn: [], uses: ["internet", "dns"], breaksThrough: true, repeats: ack === "poll", ack, maxTitle: 250, maxBody: 1024, ...script.describe }),
    send: async ({ message, copy }) => {
      calls.send.push(message);
      calls.copies.push(copy);
      return (await script.send?.(message, calls.send.length)) ?? { ok: true, receipt: { receipt: `${id}-${calls.send.length}` }, accepted: now() };
    },
    status: async ({ receipt }) => {
      calls.status.push(receipt);
      return script.status?.(receipt) ?? { state: "delivered", at: now() };
    },
    cancel: async (target) => {
      if ("copy" in target) {
        calls.stops.push(target.copy);
        await script.stop?.(target.copy);
        return;
      }
      calls.cancel.push(target.receipt);
      await script.cancel?.(target.receipt);
    },
    ...(script.probe === undefined ? {} : { probe: async () => script.probe!() }),
  };
  return { procedures, calls };
}

// Six people with the same place and the same policy.
const PEOPLE: readonly Recipient[] = [1, 2, 3, 4, 5, 6].map((n) => ({ ...RECIPIENT, watch: { ...RECIPIENT.watch, person: `person-${n}` as PersonId } }));

const DELIVERY = { recipients: [RECIPIENT], pollEvery: 30 * SECOND, retry: 15 * SECOND, callLimit: 10 * SECOND, flightLimit: 40 * SECOND } as const;

// The run id of a runtime that `open` starts at T0. Each copy id starts with it.
const RUN = `run-${T0}`;

// The microtasks and the callbacks of the promises end before this promise resolves.
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function open(scripts: { readonly pushover?: Script; readonly sms?: Script } = {}, log: RuntimeLog = openRuntimeLog(":memory:"), clock = fakeWallClock(T0), extra: Partial<DeliveryOptions> = {}, wake?: () => void) {
  const pushover = channel(PUSHOVER, "poll", () => clock.now(), scripts.pushover);
  const sms = channel(SMS, "none", () => clock.now(), scripts.sms);
  const runtime = openRuntime({
    log,
    clock,
    sources: [SOURCE],
    watch: () => ({ places: [KANSAS], kinds: ["met"] }),
    view: VIEW,
    run: `run-${clock.now()}`,
    delivery: { ...DELIVERY, channels: [pushover.procedures, sms.procedures], ...extra },
    ...(wake === undefined ? {} : { wake }),
  });
  return { clock, log, runtime, pushover: pushover.calls, sms: sms.calls };
}

// The events of the delivery. The first pass also seeds the mode of the source (AL-73), and `observe.test.ts` tests it.
const types = (log: RuntimeLog) => [...log.read()].map((event) => event.type).filter((type) => type !== "observation" && type !== "fetch" && type !== "system" && type !== "mode");

describe("the delivery step of a pass", () => {
  it("keeps the shadow score of the incident at the start of each escalation, and the score changes no send", async () => {
    // Made-up values. They are not the public measures.
    const priors: ScorePriors = {
      format: PRIORS_FORMAT,
      kinds: { "met.tornado": { deaths: { value: 0.04, low: 0.03, high: 0.06 }, injuries: { value: 0.6, low: 0.4, high: 0.9 } } },
      certainty: { observed: { value: 1, low: 1, high: 1 } },
    };
    const starts = (log: RuntimeLog) => [...log.read()].flatMap((event) => (event.type === "escalation" ? [event] : []));
    const scored = open({}, undefined, undefined, { priors });
    await scored.runtime.pass();
    const plain = open();
    await plain.runtime.pass();
    expect(starts(scored.log).map((event) => event.shadow)).toEqual([shadowScore({ kind: { code: "met.tornado", label: "Tornado Warning" }, certainty: "observed" }, priors)]);
    expect(starts(plain.log).some((event) => "shadow" in event)).toBe(false);
    expect(scored.pushover.send).toEqual(plain.pushover.send);
    expect(types(scored.log)).toEqual(types(plain.log));
    expect(scored.runtime.state()).toEqual(rebuild(scored.log.read(), scored.runtime.config));
    expect(scored.runtime.state().merge.deliveries).toEqual(plain.runtime.state().merge.deliveries);
    scored.log.close();
    plain.log.close();
  });

  it("puts the why line into each message of a channel with a why limit, with the label of the runtime and no label in the log", async () => {
    const labels = (node: string): string | undefined => (node === `place:${KANSAS.id}` ? "Lake cabin" : undefined);
    const named = open({ pushover: { describe: { why: WHY_LIMITS.push } } }, undefined, undefined, { labels });
    await named.runtime.pass();
    expect(named.pushover.send[0]?.why).toBe("Why: Lake cabin is in the area");
    expect(named.pushover.send[0]?.body).toBe("TAKE COVER NOW!");
    expect(JSON.stringify([...named.log.read()])).not.toContain("Lake cabin");
    named.log.close();
    // With no labels, the line uses a plain noun. A channel with no why limit gets no why line.
    const plain = open({ pushover: { describe: { why: WHY_LIMITS.text } } });
    await plain.runtime.pass();
    expect(plain.pushover.send[0]?.why).toBe("Why: your place is in the area");
    plain.log.close();
    const none = open(undefined, undefined, undefined, { labels });
    await none.runtime.pass();
    expect(none.pushover.send[0]).not.toHaveProperty("why");
    none.log.close();
  });

  it("names a node by the label of the interest graph of the person, and the rule of the life-safety warnings keeps the level", async () => {
    // The person turned the route of the place off and follows the topic. The rule of the place keeps the warning at life-safety.
    const interests: InterestGraph = {
      format: "alerts-interest/1",
      person: PERSON,
      edges: [
        { id: "e1", from: `place:${KANSAS.id}`, to: "person", kind: "geographic", weight: { value: 1, low: 1, high: 1 }, origin: "places", on: false },
        { id: "e2", from: "topic:met.tornado", to: "person", kind: "interest", weight: { value: 1, low: 1, high: 1 }, origin: "person", on: true },
      ],
      mutes: [],
      labels: { "topic:met.tornado": "Twisters" },
    };
    const follower: Recipient = { ...RECIPIENT, watch: { ...RECIPIENT.watch, interests, mandatory: [{ place: KANSAS.id, on: true, rangeKm: 0 }] } };
    const { runtime, log, pushover } = open({ pushover: { describe: { why: WHY_LIMITS.push } } }, undefined, undefined, { recipients: [follower] });
    await runtime.pass();
    expect(pushover.send).toHaveLength(1);
    expect(pushover.send[0]).toMatchObject({ person: PERSON, level: "life-safety", why: "Why: you follow Twisters" });
    expect(JSON.stringify([...log.read()])).not.toContain("Twisters");
    log.close();
  });

  it("starts the escalation of a warning at a watched place, and sends its first step", async () => {
    const { runtime, log, pushover, sms } = open();
    const pass = await runtime.pass();
    expect(pushover.send).toHaveLength(1);
    expect(pushover.send[0]).toMatchObject({ person: PERSON, level: "life-safety", title: "Tornado Warning issued April 1 at 1:00PM CDT by NWS Wichita KS", body: "TAKE COVER NOW!", quiet: false, expires: T0 + 45 * MINUTE });
    expect(sms.send).toEqual([]);
    expect(types(log)).toEqual(["started", "escalation", "attempt", "delivery"]);
    expect(pass.delivery?.sent.map((delivery) => [delivery.channel, delivery.step, delivery.receipt])).toEqual([[PUSHOVER, 0, { receipt: "pushover-1" }]]);
    // The next pass is the first poll of the receipt.
    expect(pass.wakeAt).toBe(T0 + 30 * SECOND);
    log.close();
  });

  it("gives a wake after the step when a due poll waits for the retry of its failed status, and polls at the retry (AL-75)", async () => {
    const clock = fakeWallClock(T0);
    // The first status fails. Its retry of 60 s is longer than the poll interval of 30 s, thus the poll at 60 s waits.
    const status = (): DeliveryStatus => {
      if (pushover.status.length === 1) throw new Error("The status service is down.");
      return { state: "delivered", at: clock.now() };
    };
    const { runtime, log, pushover } = open({ pushover: { status } }, openRuntimeLog(":memory:"), clock, { retry: 60 * SECOND });
    expect((await runtime.pass()).wakeAt).toBe(T0 + 30 * SECOND);
    await clock.advance(30 * SECOND);
    const failed = await runtime.pass();
    expect(failed.delivery?.failures.filter((failure) => failure.call === "status").map((failure) => failure.retryAt)).toEqual([T0 + 90 * SECOND]);
    await clock.advance(30 * SECOND);
    const waiting = await runtime.pass();
    expect(pushover.status).toHaveLength(1);
    expect(waiting.delivery?.wakeAt).toBeGreaterThan(clock.now());
    expect(waiting.wakeAt).toBeGreaterThan(waiting.at);
    await clock.advance(T0 + 90 * SECOND - clock.now());
    await runtime.pass();
    expect(pushover.status).toHaveLength(2);
    log.close();
  });

  it("polls the receipt, writes the acknowledgment, cancels the repeats and sends no later step", async () => {
    const { clock, runtime, log, pushover, sms } = open({ pushover: { status: () => ({ state: "acknowledged", at: T0 + 20 * SECOND, by: "phone" }) } });
    await runtime.pass();
    await clock.advance(30 * SECOND);
    const pass = await runtime.pass();
    expect(pushover.status).toEqual([{ receipt: "pushover-1" }]);
    expect(pass.delivery?.acknowledged).toEqual([{ incident: runtime.state().merge.deliveries[0]!.incident, level: "life-safety", person: PERSON, at: T0 + 20 * SECOND, via: PUSHOVER }]);
    expect(pushover.cancel).toEqual([{ receipt: "pushover-1" }]);
    expect(pass.delivery?.duplicates).toEqual([]);
    expect(types(log)).toEqual(["started", "escalation", "attempt", "delivery", "acknowledgment", "cancelled"]);
    await clock.advance(10 * MINUTE);
    await runtime.pass();
    expect(sms.send).toEqual([]);
    expect(pushover.status).toHaveLength(1);
    log.close();
  });

  it("ends the escalation of a person that the incident no longer reaches, and starts a new one with new keys when it comes back", async () => {
    const clock = fakeWallClock(T0);
    const log = openRuntimeLog(":memory:");
    const first = open({}, log, clock);
    await first.runtime.pass();
    const anchor = first.runtime.state().merge.deliveries[0]!.incident;
    const key = first.pushover.send[0]!.key;
    const ends = () => [...log.read()].flatMap((event) => (event.type === "escalation-end" ? [[event.id, event.end]] : []));
    const starts = () => [...log.read()].flatMap((event) => (event.type === "escalation" ? [event.id] : []));

    // The person no longer watches the place, thus the incident no longer reaches the person.
    await clock.advance(MINUTE);
    const gone = open({}, log, clock, { recipients: [{ ...RECIPIENT, watch: { ...RECIPIENT.watch, places: [] } }] });
    await gone.runtime.pass();
    expect(gone.pushover.send).toEqual([]);
    expect(gone.pushover.cancel).toEqual([{ receipt: "pushover-1" }]);
    expect(ends()).toEqual([[`escalation-end:${anchor}:${PERSON}:0`, { incident: anchor, person: PERSON, at: T0 + MINUTE }]]);
    expect(types(log)).toEqual(["started", "escalation", "attempt", "delivery", "started", "escalation-end", "cancelled"]);
    expect(gone.runtime.state().escalationEnds).toEqual([{ incident: anchor, person: PERSON, at: T0 + MINUTE }]);
    expect(gone.runtime.state()).toEqual(rebuild(log.read(), gone.runtime.config));

    // A later pass cancels nothing again and writes no second end.
    await clock.advance(MINUTE);
    await gone.runtime.pass();
    expect(gone.pushover.cancel).toHaveLength(1);
    expect(ends()).toHaveLength(1);

    // The person watches the place again: a new escalation with a new start and a new key.
    await clock.advance(MINUTE);
    const back = open({}, log, clock);
    await back.runtime.pass();
    expect(back.pushover.send.map((message) => message.key)).toEqual([messageKey({ incident: anchor, level: "life-safety", person: PERSON, step: 0, episode: 1 })]);
    expect(back.pushover.send[0]!.key).not.toBe(key);
    expect(starts()).toEqual([`escalation:${anchor}:life-safety:${PERSON}`, `escalation:${anchor}:life-safety:${PERSON}:1`]);
    log.close();
  });

  it("sends nothing on a channel that the copy leaves to the other copies, and gives no failure and no overdue send of it (AL-55)", async () => {
    const { clock, runtime, log, pushover, sms } = open({}, undefined, undefined, { leaveChannels: [SMS], overdueAfter: MINUTE });
    let pass = await runtime.pass();
    while (clock.now() < T0 + 8 * MINUTE) {
      await clock.advance(30 * SECOND);
      pass = await runtime.pass();
    }
    expect(pushover.send).toHaveLength(1);
    expect(sms.send).toEqual([]);
    // The plan keeps the step on the channel. Thus the keys and the numbers of the steps are the same in each copy.
    expect(pass.delivery?.routes.flatMap((entry) => entry.plan.sends).map((send) => [send.channel, send.step])).toEqual([[SMS, 1]]);
    expect(pass.delivery?.failures).toEqual([]);
    expect(pass.delivery?.overdue).toEqual([]);
    expect(new Set(types(log))).toEqual(new Set(["started", "escalation", "attempt", "delivery"]));
    log.close();
  });

  it("polls and cancels nothing on a channel that the copy leaves, also for a delivery of the log (AL-55)", async () => {
    const clock = fakeWallClock(T0);
    const log = openRuntimeLog(":memory:");
    const first = open({}, log, clock);
    await first.runtime.pass();
    expect(first.pushover.send).toHaveLength(1);
    // The copy starts again, and it leaves the channel to the other copies. The log keeps the delivery and its receipt.
    await clock.advance(MINUTE);
    const left = open({}, log, clock, { leaveChannels: [PUSHOVER] });
    const polled = await left.runtime.pass();
    expect(left.pushover.status).toEqual([]);
    expect(polled.delivery?.failures).toEqual([]);
    // The person no longer watches the place, thus the escalation ends. The copy that sent the message cancels it,
    // because the copies share each cancel. A cancel of this copy would end the cancel of that copy.
    await clock.advance(MINUTE);
    const gone = open({}, log, clock, { leaveChannels: [PUSHOVER], recipients: [{ ...RECIPIENT, watch: { ...RECIPIENT.watch, places: [] } }] });
    const ended = await gone.runtime.pass();
    expect(gone.pushover.cancel).toEqual([]);
    expect(ended.delivery?.cancelled).toEqual([]);
    expect(ended.delivery?.failures).toEqual([]);
    expect(types(log)).not.toContain("cancelled");
    log.close();
  });

  it("sends the next step at its time when no acknowledgment comes", async () => {
    const { clock, runtime, log, pushover, sms } = open();
    let pass = await runtime.pass();
    while ((pass.wakeAt ?? Infinity) <= T0 + 5 * MINUTE) {
      await clock.advance(Math.max(1, pass.wakeAt! - clock.now()));
      pass = await runtime.pass();
    }
    expect(sms.send.map((message) => message.level)).toEqual(["life-safety"]);
    expect(pushover.send).toHaveLength(1);
    // The receipt of each poll of the first step: one for each 30 seconds.
    expect(pushover.status.length).toBeGreaterThanOrEqual(9);
    log.close();
  });

  it("polls a receipt at most one time in each interval, also when the passes come more often", async () => {
    const { clock, runtime, log, pushover } = open();
    await runtime.pass();
    await clock.advance(30 * SECOND);
    await runtime.pass();
    await clock.advance(10 * SECOND);
    const early = await runtime.pass();
    expect(pushover.status).toHaveLength(1);
    expect(early.wakeAt).toBe(T0 + 60 * SECOND);
    await clock.advance(20 * SECOND);
    await runtime.pass();
    expect(pushover.status).toHaveLength(2);
    log.close();
  });

  it("waits for the time of the channel after a refusal of its quota, then sends again", async () => {
    const { clock, runtime, log, pushover } = open({ pushover: { send: (_, count) => (count === 1 ? { ok: false, kind: "rate-limited", message: "The quota is used.", retryAfter: 90 * SECOND } : undefined) } });
    const first = await runtime.pass();
    expect(first.delivery?.failures).toEqual([{ call: "send", key: pushover.send[0]!.key, channel: PUSHOVER, kind: "rate-limited", message: "The quota is used.", retryAt: T0 + 90 * SECOND }]);
    expect(types(log)).toEqual(["started", "escalation", "attempt", "refused"]);
    // The fetch of the source brings a pass before the end of the wait. The send waits, and the next pass comes at its end.
    await clock.advance(MINUTE);
    const second = await runtime.pass();
    expect(pushover.send).toHaveLength(1);
    expect(second.wakeAt).toBe(T0 + 90 * SECOND);
    await clock.advance(30 * SECOND);
    const third = await runtime.pass();
    expect(pushover.send).toHaveLength(2);
    expect(third.delivery?.sent).toHaveLength(1);
    expect(pushover.stops).toEqual([]);
    // The delivery of the key ends its refusal.
    expect(runtime.state().refusals).toEqual({});
    log.close();
  });

  it("keeps the wait of a refused send after a restart, thus the quota of the channel holds", async () => {
    const clock = fakeWallClock(T0);
    const log = openRuntimeLog(":memory:");
    const before = open({ pushover: { send: () => ({ ok: false, kind: "rate-limited", message: "The quota is used.", retryAfter: 90 * SECOND }) } }, log, clock);
    await before.runtime.pass();
    const key = before.pushover.send[0]!.key;
    expect(before.runtime.state().refusals).toEqual({ [key]: { channel: PUSHOVER, kind: "rate-limited", at: T0, retryAt: T0 + 90 * SECOND, deliveries: 0, streak: 1 } });
    // The refusal ends the copy, thus the restart does not stop it.
    expect(before.runtime.state().copies).toEqual({});

    // A new process on the same log, before the end of the wait.
    await clock.advance(30 * SECOND);
    const after = open({}, log, clock);
    expect(after.runtime.state()).toEqual(rebuild(log.read(), after.runtime.config));
    await after.runtime.pass();
    expect(after.pushover.send).toEqual([]);
    expect(after.pushover.stops).toEqual([]);
    await clock.advance(30 * SECOND);
    const early = await after.runtime.pass();
    expect(after.pushover.send).toEqual([]);
    expect(early.wakeAt).toBe(T0 + 90 * SECOND);
    await clock.advance(30 * SECOND);
    const late = await after.runtime.pass();
    expect(after.pushover.send.map((message) => message.key)).toEqual([key]);
    expect(late.delivery?.sent).toHaveLength(1);
    expect(after.runtime.state().refusals).toEqual({});
    log.close();
  });

  it("keeps the wait of a send in the reserve of a channel across a restart, and the heartbeat holds no fail for it", async () => {
    const reserved: Script = { send: () => ({ ok: false, kind: "reserved", message: "The quota keeps its last units for life-safety.", retryAfter: 600 * SECOND }) };
    const { runtime, log } = open({ pushover: reserved }, openRuntimeLog(":memory:"), fakeWallClock(T0));
    const pass = await runtime.pass();
    expect(pass.delivery?.failures.map((failure) => failure.kind)).toEqual(["reserved"]);
    const state = rebuild(log.read(), runtime.config);
    expect(Object.values(state.refusals).map((refusal) => [refusal.kind, refusal.retryAt])).toEqual([["reserved", T0 + 600 * SECOND]]);
    expect(holdStep({}, pass)).toEqual({});
    expect(heldOf(state, T0 + 30 * SECOND)).toEqual({});
    log.close();
  });

  it("writes the refusals of a step after its deliveries, thus the log keeps the hold of the pass also when the accept is later", async () => {
    const OTHER: Recipient = { ...RECIPIENT, watch: { ...RECIPIENT.watch, person: "person-2" as PersonId } };
    // The channel refuses the key of person-2 at once. It accepts the key of person-1 after the refusal, with a time after
    // the time of the refusal.
    const later: Script = {
      send: (message) =>
        message.person === OTHER.watch.person
          ? { ok: false, kind: "auth", message: "The user key is not valid.", retryAfter: 90 * SECOND }
          : settle().then(() => ({ ok: true, receipt: { receipt: "pushover-1" }, accepted: T0 + 5 * SECOND })),
    };
    const { runtime, log } = open({ pushover: later }, openRuntimeLog(":memory:"), fakeWallClock(T0), { recipients: [RECIPIENT, OTHER] });
    const pass = await runtime.pass();
    expect(pass.delivery?.sent.map((delivery) => delivery.person)).toEqual([PERSON]);
    expect(pass.delivery?.failures.map((failure) => failure.kind)).toEqual(["auth"]);
    const order = types(log);
    expect(order.lastIndexOf("delivery")).toBeLessThan(order.indexOf("refused"));
    // The state after a restart holds the channel as the pass does.
    const held = holdStep({}, pass);
    expect(held).toEqual({ pushover: { kinds: ["auth"], until: T0 + 90 * SECOND } });
    expect(heldOf(rebuild(log.read(), runtime.config), T0 + 30 * SECOND)).toEqual(held);
    log.close();
  });

  it("stops a copy whose send failed with no answer by its copy id, in parallel with the new copy", async () => {
    const { clock, runtime, log, pushover } = open({ pushover: { send: (_, count) => (count === 1 ? { ok: false, kind: "timeout", message: "Pushover did not answer." } : undefined) } });
    const first = await runtime.pass();
    expect(first.delivery?.failures.map((failure) => failure.kind)).toEqual(["timeout"]);
    expect(first.delivery?.stopped).toEqual([]);
    await clock.advance(15 * SECOND);
    const second = await runtime.pass();
    expect(pushover.copies).toEqual([`${RUN}-1`, `${RUN}-2`]);
    expect(pushover.copies.every((copy) => copy !== undefined && COPY_ID.test(copy))).toBe(true);
    expect(pushover.stops).toEqual([`${RUN}-1`]);
    expect(second.delivery?.stopped).toEqual([`${RUN}-1`]);
    expect(second.delivery?.sent.map((delivery) => delivery.receipt)).toEqual([{ receipt: "pushover-2" }]);
    // No cancel by the delivery key goes, thus the new copy repeats until the acknowledgment.
    expect(pushover.cancel).toEqual([]);
    log.close();
  });

  it("stops a copy again at a later pass when its stop fails", async () => {
    let refuse = true;
    const { clock, runtime, log, pushover } = open({
      pushover: {
        send: (_, count) => (count === 1 ? { ok: false, kind: "network", message: "The connection reset." } : undefined),
        stop: () => {
          if (refuse) {
            refuse = false;
            throw new Error("Pushover is down.");
          }
        },
      },
    });
    await runtime.pass();
    await clock.advance(15 * SECOND);
    const second = await runtime.pass();
    expect(second.delivery?.failures.map((failure) => [failure.call, failure.copy, failure.message])).toEqual([["copy", `${RUN}-1`, "Pushover is down."]]);
    expect(second.delivery?.sent).toHaveLength(1);
    expect(second.wakeAt).toBe(T0 + 30 * SECOND);
    await clock.advance(15 * SECOND);
    const third = await runtime.pass();
    expect(third.delivery?.stopped).toEqual([`${RUN}-1`]);
    expect(pushover.stops).toEqual([`${RUN}-1`, `${RUN}-1`]);
    log.close();
  });

  it("gives the kind timeout to a stop and to a cancel that pass their time limit", async () => {
    const hang = (): Promise<void> => new Promise<void>(() => undefined);
    let stops = 0;
    const { clock, runtime, log, pushover } = open({
      pushover: {
        send: (_, count) => (count === 1 ? { ok: false, kind: "timeout", message: "Pushover did not answer." } : undefined),
        status: () => ({ state: "acknowledged", at: T0 + 20 * SECOND }),
        // The first stop hangs, and the second stop ends.
        stop: () => {
          stops += 1;
          return stops === 1 ? hang() : undefined;
        },
        cancel: hang,
      },
    });
    await runtime.pass();
    await clock.advance(15 * SECOND);
    const second = runtime.pass();
    await clock.advance(10 * SECOND);
    expect((await second).delivery?.failures.map((failure) => [failure.call, failure.kind, failure.message])).toEqual([["copy", "timeout", "The stop of the copy took longer than 10000 ms."]]);
    // The poll of the new copy comes 30 s after its send, at T0 + 45 s. It reads the acknowledgment, and the cancel by receipt hangs.
    await clock.advance(20 * SECOND);
    const third = runtime.pass();
    await clock.advance(10 * SECOND);
    const last = await third;
    expect(last.delivery?.failures.map((failure) => [failure.call, failure.kind, failure.message])).toEqual([["cancel", "timeout", "The cancel took longer than 10000 ms."]]);
    expect(last.delivery?.stopped).toEqual([`${RUN}-1`]);
    expect(pushover.stops).toEqual([`${RUN}-1`, `${RUN}-1`]);
    log.close();
  });

  it("refuses a run id with a character that a copy id cannot have", () => {
    const clock = fakeWallClock(T0);
    const start = (run: string): void => {
      const log = openRuntimeLog(":memory:");
      try {
        const channels = [channel(PUSHOVER, "poll", () => clock.now()).procedures, channel(SMS, "none", () => clock.now()).procedures];
        openRuntime({ log, clock, sources: [SOURCE], watch: () => ({ places: [KANSAS], kinds: ["met"] }), view: VIEW, run, delivery: { ...DELIVERY, channels } });
      } finally {
        log.close();
      }
    };
    expect(() => start("run.1")).toThrow('The run id "run.1" has a character that a copy id cannot have. Use letters, digits, _ and -.');
    expect(() => start("0b6f3c1e-8f0a-4d1e-9a51-6c2f1d7e9b10")).not.toThrow();
  });

  it("stops no copy on a channel that does not repeat", async () => {
    const { clock, runtime, log, sms } = open({ sms: { send: () => ({ ok: false, kind: "timeout", message: "The gateway did not answer." }) } });
    let pass = await runtime.pass();
    while ((pass.wakeAt ?? Infinity) <= T0 + 6 * MINUTE) {
      await clock.advance(Math.max(1, pass.wakeAt! - clock.now()));
      pass = await runtime.pass();
    }
    expect(sms.send.length).toBeGreaterThanOrEqual(2);
    expect(sms.stops).toEqual([]);
    log.close();
  });

  it("keeps a send that hangs in flight until its flight limit, then stops its copy and sends a new copy in parallel", async () => {
    const { clock, runtime, log, pushover } = open({ pushover: { send: (_, count) => (count === 1 ? new Promise<SendOutcome>(() => undefined) : undefined) } });
    const running = runtime.pass();
    await clock.advance(10 * SECOND);
    const first = await running;
    expect(first.delivery?.failures.map((failure) => [failure.kind, failure.message])).toEqual([["timeout", "The send took longer than 10000 ms. It stays in flight for up to 40000 ms."]]);
    expect(types(log)).toEqual(["started", "escalation", "attempt"]);
    // The wait of the retry is over, but the first send is in flight. The next pass comes at the end of the flight.
    await clock.advance(5 * SECOND);
    const second = await runtime.pass();
    expect(pushover.send).toHaveLength(1);
    expect(second.wakeAt).toBe(T0 + 40 * SECOND);
    await clock.advance(25 * SECOND);
    const third = await runtime.pass();
    expect(pushover.send).toHaveLength(2);
    expect(third.delivery?.sent.map((delivery) => delivery.receipt)).toEqual([{ receipt: "pushover-2" }]);
    // The stop names the copy of the hung send. A cancel by the delivery key would also stop the new copy.
    expect(pushover.copies).toEqual([`${RUN}-1`, `${RUN}-2`]);
    expect(third.delivery?.stopped).toEqual([`${RUN}-1`]);
    expect(pushover.stops).toEqual([`${RUN}-1`]);
    expect(pushover.cancel).toEqual([]);
    log.close();
  });

  it("writes a send that the channel accepts after the time limit, and sends no second copy", async () => {
    const clock = fakeWallClock(T0);
    let woken = 0;
    const late = (): Promise<SendOutcome> => new Promise((resolve) => clock.after(15 * SECOND, () => resolve({ ok: true, receipt: { receipt: "late-1" }, accepted: clock.now() })));
    const { runtime, log, pushover } = open({ pushover: { send: (_, count) => (count === 1 ? late() : undefined) } }, openRuntimeLog(":memory:"), clock, {}, () => (woken += 1));
    const running = runtime.pass();
    await clock.advance(10 * SECOND);
    expect((await running).delivery?.failures.map((failure) => failure.kind)).toEqual(["timeout"]);
    await clock.advance(5 * SECOND);
    await settle();
    expect(woken).toBe(1);
    const second = await runtime.pass();
    expect(second.delivery?.sent.map((delivery) => [delivery.receipt, delivery.at])).toEqual([[{ receipt: "late-1" }, T0 + 15 * SECOND]]);
    expect(pushover.send).toHaveLength(1);
    expect(types(log)).toEqual(["started", "escalation", "attempt", "delivery"]);
    // The late delivery gets its polls, thus an acknowledgment and a cancel can reach it.
    await clock.advance(30 * SECOND);
    await runtime.pass();
    expect(pushover.status).toEqual([{ receipt: "late-1" }]);
    log.close();
  });

  it("stops a stale copy again when the channel accepts it after its stop, and writes no delivery of it", async () => {
    const clock = fakeWallClock(T0);
    let woken = 0;
    const late = (): Promise<SendOutcome> => new Promise((resolve) => clock.after(50 * SECOND, () => resolve({ ok: true, receipt: { receipt: "late-1" }, accepted: clock.now() })));
    const { runtime, log, pushover } = open({ pushover: { send: (_, count) => (count === 1 ? late() : undefined) } }, openRuntimeLog(":memory:"), clock, {}, () => (woken += 1));
    const running = runtime.pass();
    await clock.advance(10 * SECOND);
    await running;
    await clock.advance(30 * SECOND);
    const second = await runtime.pass();
    expect(pushover.send).toHaveLength(2);
    expect(second.delivery?.stopped).toEqual([`${RUN}-1`]);
    // The send of the copy did not end, thus its stop does not end it. A restart now stops it again.
    expect(types(log).filter((type) => type === "settled")).toEqual([]);
    expect(Object.keys(runtime.state().copies)).toContain(`${RUN}-1`);
    await clock.advance(10 * SECOND);
    await settle();
    expect(woken).toBe(1);
    const last = await runtime.pass();
    expect(last.delivery?.stopped).toEqual([`${RUN}-1`]);
    // The second stop comes after the end of the send. It ends the copy.
    expect(types(log).filter((type) => type === "settled")).toEqual(["settled"]);
    expect(Object.keys(runtime.state().copies)).not.toContain(`${RUN}-1`);
    expect(last.delivery?.sent).toEqual([]);
    expect(last.delivery?.duplicates).toEqual([]);
    expect(pushover.stops).toEqual([`${RUN}-1`, `${RUN}-1`]);
    expect(pushover.cancel).toEqual([]);
    expect(runtime.state().merge.deliveries.map((delivery) => delivery.receipt)).toEqual([{ receipt: "pushover-2" }]);
    log.close();
  });

  it("keeps the start after a restart, thus the next step comes at its time and no step goes twice", async () => {
    const clock = fakeWallClock(T0);
    const log = openRuntimeLog(":memory:");
    const before = open({}, log, clock);
    await before.runtime.pass();
    expect(before.pushover.send).toHaveLength(1);

    // A new process on the same log, six minutes later.
    await clock.advance(6 * MINUTE);
    const after = open({}, log, clock);
    expect(after.runtime.state()).toEqual(rebuild(log.read(), after.runtime.config));
    expect(after.runtime.state().starts).toHaveLength(1);
    await after.runtime.pass();
    expect(after.pushover.send).toEqual([]);
    expect(after.sms.send.map((message) => message.level)).toEqual(["life-safety"]);
    // The delivery of the copy ends it, thus the restart does not stop it.
    expect(after.pushover.stops).toEqual([]);
    expect(types(log)).toEqual(["started", "escalation", "attempt", "delivery", "started", "delivery"]);
    log.close();
  });

  it("stops a copy of an earlier run with no delivery after a restart, and a new copy goes in parallel", async () => {
    const clock = fakeWallClock(T0);
    const inner = openRuntimeLog(":memory:");
    // The process stops after the channel accepts the send and before the log writes its delivery.
    let crash = true;
    const crashing: RuntimeLog = {
      ...inner,
      appendAll: (events, accept) => {
        if (crash && events.some((event) => event.type === "delivery")) throw new Error("The process stops.");
        return inner.appendAll(events, accept);
      },
    };
    const before = open({}, crashing, clock);
    await expect(before.runtime.pass()).rejects.toThrow("The process stops.");
    expect(before.pushover.copies).toEqual([`${RUN}-1`]);
    expect(before.runtime.state().copies).toEqual({ [`${RUN}-1`]: { key: before.pushover.send[0]!.key, channel: PUSHOVER } });

    // A new process on the same log, one minute later. The log has the attempt of the copy and no delivery.
    crash = false;
    await clock.advance(MINUTE);
    const after = open({}, inner, clock);
    const pass = await after.runtime.pass();
    const run = `run-${T0 + MINUTE}`;
    expect(after.pushover.copies).toEqual([`${run}-1`]);
    expect(pass.delivery?.stopped).toEqual([`${RUN}-1`]);
    expect(after.pushover.stops).toEqual([`${RUN}-1`]);
    expect(after.pushover.cancel).toEqual([]);
    expect(after.runtime.state().copies).toEqual({});
    expect(after.runtime.state()).toEqual(rebuild(inner.read(), after.runtime.config));
    expect(types(inner)).toEqual(["started", "escalation", "attempt", "started", "attempt", "delivery", "settled"]);
    // The copy is over, thus the next pass stops nothing.
    await clock.advance(30 * SECOND);
    expect((await after.runtime.pass()).delivery?.stopped).toEqual([]);
    expect(after.pushover.stops).toHaveLength(1);
    inner.close();
  });

  it("keeps a copy of an earlier run open in the log until its stop goes, also after a failed stop", async () => {
    const clock = fakeWallClock(T0);
    const log = openRuntimeLog(":memory:");
    const before = open({ pushover: { send: () => new Promise<SendOutcome>(() => undefined) } }, log, clock);
    const running = before.runtime.pass();
    await clock.advance(10 * SECOND);
    await running;
    expect(types(log)).toEqual(["started", "escalation", "attempt"]);

    await clock.advance(MINUTE);
    let refuse = true;
    const stop = (): void => {
      if (refuse) {
        refuse = false;
        throw new Error("Pushover is down.");
      }
    };
    const after = open({ pushover: { stop } }, log, clock);
    const first = await after.runtime.pass();
    expect(first.delivery?.failures.map((failure) => [failure.call, failure.copy, failure.message])).toEqual([["copy", `${RUN}-1`, "Pushover is down."]]);
    expect(Object.keys(after.runtime.state().copies)).toEqual([`${RUN}-1`]);
    await clock.advance(15 * SECOND);
    const second = await after.runtime.pass();
    expect(second.delivery?.stopped).toEqual([`${RUN}-1`]);
    expect(after.pushover.stops).toEqual([`${RUN}-1`, `${RUN}-1`]);
    expect(after.runtime.state().copies).toEqual({});
    log.close();
  });

  it("does not stop a copy of an earlier run that the channel refused", async () => {
    const clock = fakeWallClock(T0);
    const log = openRuntimeLog(":memory:");
    const before = open({ pushover: { send: () => ({ ok: false, kind: "refused", message: "The user key is not valid." }) } }, log, clock);
    await before.runtime.pass();
    expect(before.runtime.state().copies).toEqual({});
    await clock.advance(MINUTE);
    const after = open({}, log, clock);
    await after.runtime.pass();
    expect(after.pushover.send).toHaveLength(1);
    expect(after.pushover.stops).toEqual([]);
    log.close();
  });

  it("writes a delivery whose write failed at the next pass, and sends no second copy", async () => {
    const clock = fakeWallClock(T0);
    const inner = openRuntimeLog(":memory:");
    let fail = true;
    const flaky: RuntimeLog = {
      ...inner,
      appendAll: (events, accept) => {
        if (fail && events.some((event) => event.type === "delivery")) {
          fail = false;
          throw new Error("The disk is full.");
        }
        return inner.appendAll(events, accept);
      },
    };
    let woken = 0;
    const { runtime, pushover } = open({}, flaky, clock, {}, () => (woken += 1));
    await expect(runtime.pass()).rejects.toThrow("The disk is full.");
    expect(runtime.state()).toEqual(rebuild(inner.read(), runtime.config));
    expect(runtime.state().merge.deliveries).toEqual([]);
    expect(woken).toBe(1);
    // The channel has the message. The next pass writes its delivery, and the send does not go again.
    const pass = await runtime.pass();
    expect(pushover.send).toHaveLength(1);
    expect(pass.delivery?.sent.map((delivery) => delivery.receipt)).toEqual([{ receipt: "pushover-1" }]);
    expect(runtime.state().merge.deliveries).toHaveLength(1);
    inner.close();
  });

  it("cancels again in a later pass when a cancel fails", async () => {
    let refuse = true;
    const { clock, runtime, log, pushover } = open({
      pushover: {
        status: () => ({ state: "acknowledged", at: T0 + 20 * SECOND }),
        cancel: () => {
          if (refuse) {
            refuse = false;
            throw new Error("Pushover is down.");
          }
        },
      },
    });
    await runtime.pass();
    await clock.advance(30 * SECOND);
    const second = await runtime.pass();
    expect(second.delivery?.failures.map((failure) => [failure.call, failure.message])).toEqual([["cancel", "Pushover is down."]]);
    expect(second.wakeAt).toBe(T0 + 45 * SECOND);
    await clock.advance(15 * SECOND);
    const third = await runtime.pass();
    expect(third.delivery?.cancelled).toHaveLength(1);
    expect(pushover.cancel).toHaveLength(2);
    expect(types(log)).toEqual(["started", "escalation", "attempt", "delivery", "acknowledgment", "cancelled"]);
    log.close();
  });

  it("tells an on-time send whose key the log already has as a duplicate, not as sent", async () => {
    const clock = fakeWallClock(T0);
    const inner = openRuntimeLog(":memory:");
    // Another writer puts a delivery with the same id and another receipt into the log first.
    const shared: RuntimeLog = {
      ...inner,
      appendAll: (events, accept) => {
        for (const event of events) if (event.type === "delivery") inner.appendAll([{ ...event, delivery: { ...event.delivery, receipt: { receipt: "other" } } }], accept);
        return inner.appendAll(events, accept);
      },
    };
    const { runtime, pushover } = open({}, shared, clock);
    const pass = await runtime.pass();
    expect(pushover.send).toHaveLength(1);
    expect(pass.delivery?.sent).toEqual([]);
    expect(pass.delivery?.duplicates).toEqual([pushover.send[0]!.key]);
    expect(pass.conflicts).toEqual([`delivery:${pushover.send[0]!.key}`]);
    // No poll reads the duplicate copy, thus the next pass stops it by its copy id.
    const next = await runtime.pass();
    expect(next.delivery?.stopped).toEqual([`${RUN}-1`]);
    expect(pushover.stops).toEqual([`${RUN}-1`]);
    expect(pushover.cancel).toEqual([]);
    inner.close();
  });

  it("writes the delivery of the new copy, and not of the stale copy, when both land before the same pass", async () => {
    const clock = fakeWallClock(T0);
    const late = (after: number, receipt: string): Promise<SendOutcome> => new Promise((resolve) => clock.after(after, () => resolve({ ok: true, receipt: { receipt }, accepted: clock.now() })));
    // The first send lands at 50 s. The second send starts at 40 s, after the flight limit, and lands at 52 s.
    const { runtime, log, pushover } = open({ pushover: { send: (_, count) => (count === 1 ? late(50 * SECOND, "late-1") : late(12 * SECOND, "late-2")) } }, openRuntimeLog(":memory:"), clock);
    const first = runtime.pass();
    await clock.advance(10 * SECOND);
    await first;
    await clock.advance(30 * SECOND);
    const second = runtime.pass();
    await clock.advance(10 * SECOND);
    await second;
    await clock.advance(5 * SECOND);
    await settle();
    const last = await runtime.pass();
    expect(pushover.send).toHaveLength(2);
    expect(last.delivery?.sent.map((delivery) => delivery.receipt)).toEqual([{ receipt: "late-2" }]);
    expect(last.delivery?.duplicates).toEqual([]);
    expect(last.delivery?.stopped).toEqual([`${RUN}-1`]);
    expect(last.conflicts).toEqual([]);
    log.close();
  });

  it("backs off the stop probe of a down channel, and a good poll of the channel moves the probe to the next step", async () => {
    let down = true;
    const clock = fakeWallClock(T0);
    const woken: number[] = [];
    const { runtime, log, pushover } = open(
      {
        pushover: {
          // Four sends fail with no answer, thus the channel can have four copies.
          send: (_, count) => (count <= 4 ? { ok: false, kind: "network", message: "The connection reset." } : undefined),
          stop: () => {
            if (down) throw new Error("Pushover is down.");
          },
        },
      },
      openRuntimeLog(":memory:"),
      clock,
      {},
      () => woken.push(clock.now()),
    );
    const counts: number[] = [];
    for (let pass = 0; pass < 6; pass += 1) {
      const before = pushover.stops.length;
      await runtime.pass();
      counts.push(pushover.stops.length - before);
      await clock.advance(15 * SECOND);
    }
    // With no probe, the stops grow with the copies: 0, 1, 2, 3, 4, 4. With a probe at each step: 0, 1, 1, 1, 1, 1. The
    // probes go at 15, 30 and 60 seconds. The good send at 60 seconds does not move the probe, because the probe of the same
    // step failed.
    expect(counts).toEqual([0, 1, 1, 0, 1, 0]);
    expect(woken).toEqual([]);
    down = false;
    // The next probe is at 120 seconds. The poll of the receipt at 90 seconds is a good answer, thus the probe goes at the next step.
    const poll = await runtime.pass();
    expect(pushover.status).toHaveLength(1);
    expect(poll.delivery?.stopped).toEqual([]);
    expect(woken).toEqual([T0 + 90 * SECOND]);
    expect(poll.wakeAt).toBeLessThanOrEqual(T0 + 105 * SECOND);
    await clock.advance(SECOND);
    const probe = await runtime.pass();
    expect(probe.delivery?.stopped).toHaveLength(1);
    expect(woken).toEqual([T0 + 90 * SECOND, T0 + 91 * SECOND]);
    await clock.advance(SECOND);
    const drain = await runtime.pass();
    expect(drain.delivery?.stopped).toHaveLength(3);
    expect(new Set([...probe.delivery!.stopped, ...drain.delivery!.stopped])).toEqual(new Set([1, 2, 3, 4].map((count) => `${RUN}-${count}`)));
    await clock.advance(SECOND);
    expect((await runtime.pass()).delivery?.stopped).toEqual([]);
    log.close();
  });

  it("probes another copy after a failed probe, thus one copy whose stop always fails does not hold the others", async () => {
    const clock = fakeWallClock(T0);
    const { runtime, log } = open(
      {
        pushover: {
          send: (_, count) => (count <= 3 ? { ok: false, kind: "network", message: "The connection reset." } : undefined),
          stop: (copy) => {
            if (copy === `${RUN}-1`) throw new Error("Pushover does not know the tag.");
          },
        },
      },
      openRuntimeLog(":memory:"),
      clock,
    );
    const stopped: string[] = [];
    for (let pass = 0; pass < 10; pass += 1) {
      stopped.push(...((await runtime.pass()).delivery?.stopped ?? []));
      await clock.advance(20 * SECOND);
    }
    expect(stopped.sort()).toEqual([`${RUN}-2`, `${RUN}-3`]);
    log.close();
  });

  // The times of the stops of a channel whose sends and stops always fail, in seconds from T0, with a pass each 15 seconds.
  async function probeTimes(extra: Partial<DeliveryOptions>): Promise<number[]> {
    const clock = fakeWallClock(T0);
    const times: number[] = [];
    const { runtime, log } = open(
      {
        pushover: {
          send: () => ({ ok: false, kind: "network", message: "The connection reset." }),
          stop: () => {
            times.push((clock.now() - T0) / SECOND);
            throw new Error("Pushover is down.");
          },
        },
      },
      openRuntimeLog(":memory:"),
      clock,
      extra,
    );
    for (let pass = 0; pass < 16; pass += 1) {
      await runtime.pass();
      await clock.advance(15 * SECOND);
    }
    log.close();
    return times;
  }

  it("doubles the wait before the next stop probe of a down channel after each failed probe, up to the probe limit", async () => {
    // A probe at each pass gives 15 probes from 15 to 225 seconds.
    expect(await probeTimes({})).toEqual([15, 30, 60, 120, 180]);
    expect(await probeTimes({ probeLimit: 30 * SECOND })).toEqual([15, 30, 60, 90, 120, 150, 180, 210]);
  });

  it("keeps at most maxInFlight calls of a channel in progress, and the end of a call wakes the loop for the held calls", async () => {
    const clock = fakeWallClock(T0);
    const woken: number[] = [];
    let busy = 0;
    let peak = 0;
    let free = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      free = resolve;
    });
    const { runtime, log, pushover } = open(
      {
        pushover: {
          describe: { maxInFlight: 2 },
          send: async (_, count): Promise<SendOutcome> => {
            busy += 1;
            peak = Math.max(peak, busy);
            await gate;
            busy -= 1;
            return { ok: true, receipt: { receipt: `pushover-${count}` }, accepted: clock.now() };
          },
        },
      },
      openRuntimeLog(":memory:"),
      clock,
      { recipients: PEOPLE },
      () => woken.push(clock.now()),
    );
    // Six people get a send. Two sends start, and the other four wait for a free place.
    const running = runtime.pass();
    await settle();
    expect(pushover.send).toHaveLength(2);
    expect(woken).toEqual([]);
    // The end of the two sends frees their places and wakes the loop one time.
    free();
    expect((await running).delivery?.sent).toHaveLength(2);
    expect(woken).toEqual([T0]);
    await clock.advance(SECOND);
    expect((await runtime.pass()).delivery?.sent).toHaveLength(2);
    expect(woken).toEqual([T0, T0 + SECOND]);
    // No call waits for a place after the last two sends, thus no wake comes.
    await clock.advance(SECOND);
    expect((await runtime.pass()).delivery?.sent).toHaveLength(2);
    expect(woken).toEqual([T0, T0 + SECOND]);
    expect(new Set(pushover.send.map((message) => message.person))).toEqual(new Set(PEOPLE.map((person) => person.watch.person)));
    expect(peak).toBe(2);
    log.close();
  });

  it("frees the place of a call that hangs when its flight limit passes", async () => {
    const clock = fakeWallClock(T0);
    const { runtime, log, pushover } = open(
      {
        pushover: {
          describe: { maxInFlight: 1 },
          // The first send hangs for all time.
          send: (_, count) => (count === 1 ? new Promise<SendOutcome>(() => undefined) : undefined),
        },
      },
      openRuntimeLog(":memory:"),
      clock,
      { recipients: PEOPLE.slice(0, 2) },
    );
    const running = runtime.pass();
    await clock.advance(10 * SECOND);
    expect((await running).wakeAt).toBeLessThanOrEqual(T0 + 40 * SECOND);
    expect(pushover.send).toHaveLength(1);
    // The hung send keeps its place until its flight limit at 40 seconds.
    await clock.advance(20 * SECOND);
    await runtime.pass();
    expect(pushover.send).toHaveLength(1);
    // At the flight limit, the place is free again. One call gets it, and the other calls wait.
    await clock.advance(10 * SECOND);
    await runtime.pass();
    expect(pushover.send).toHaveLength(2);
    log.close();
  });

  it("gives the count of the overdue sends of a channel and the earliest due time", async () => {
    const twice: EscalationPolicy = { level: "life-safety", steps: [{ channel: PUSHOVER, at: 0 }, { channel: PUSHOVER, at: MINUTE }], exhaustedAfter: 20 * MINUTE };
    const { clock, runtime, log } = open(
      { pushover: { send: () => ({ ok: false, kind: "server", message: "Pushover gave the status 503." }) } },
      openRuntimeLog(":memory:"),
      fakeWallClock(T0),
      { recipients: [{ ...RECIPIENT, policies: [twice] }], overdueAfter: MINUTE },
    );
    let last = await runtime.pass();
    while (clock.now() < T0 + 2 * MINUTE) {
      await clock.advance(15 * SECOND);
      last = await runtime.pass();
    }
    expect(last.delivery?.overdue).toEqual([{ channel: PUSHOVER, sends: 2, since: T0 }]);
    log.close();
  });

  it("gives a due send with no delivery as overdue after overdueAfter, whatever the kind of its failures", async () => {
    let up = false;
    const { clock, runtime, log } = open(
      { pushover: { send: () => (up ? undefined : { ok: false, kind: "server", message: "Pushover gave the status 503." }) } },
      openRuntimeLog(":memory:"),
      fakeWallClock(T0),
      { overdueAfter: 60 * SECOND },
    );
    expect((await runtime.pass()).delivery?.overdue).toEqual([]);
    await clock.advance(45 * SECOND);
    expect((await runtime.pass()).delivery?.overdue).toEqual([]);
    await clock.advance(15 * SECOND);
    expect((await runtime.pass()).delivery?.overdue).toEqual([{ channel: PUSHOVER, sends: 1, since: T0 }]);
    up = true;
    await clock.advance(15 * SECOND);
    const back = await runtime.pass();
    expect(back.delivery?.sent).toHaveLength(1);
    expect(back.delivery?.overdue).toEqual([]);
    log.close();
  });

  it("does not give a send that the reserve of a quota holds as overdue", async () => {
    const reserved: Script = { send: () => ({ ok: false, kind: "reserved", message: "The quota keeps its last units for life-safety.", retryAfter: 600 * SECOND }) };
    const { clock, runtime, log } = open({ pushover: reserved }, openRuntimeLog(":memory:"), fakeWallClock(T0), { overdueAfter: 60 * SECOND });
    await runtime.pass();
    await clock.advance(120 * SECOND);
    expect((await runtime.pass()).delivery?.overdue).toEqual([]);
    log.close();
  });

  it("does not give a quiet call at night or an expired message as overdue", async () => {
    for (const kind of ["quiet", "expired"] as const) {
      const night: Script = { send: () => ({ ok: false, kind, message: "A call has no silent mode, thus a quiet message gets no call." }) };
      const { clock, runtime, log } = open({ pushover: night }, openRuntimeLog(":memory:"), fakeWallClock(T0), { overdueAfter: 60 * SECOND });
      const first = await runtime.pass();
      expect(first.delivery?.failures.map((failure) => failure.kind)).toEqual([kind]);
      await clock.advance(120 * SECOND);
      expect((await runtime.pass()).delivery?.overdue).toEqual([]);
      log.close();
    }
  });

  it("does not give a send that the person refused with a STOP reply as overdue", async () => {
    const stopped: Script = { send: () => ({ ok: false, kind: "consent", message: "The number replied STOP." }) };
    const { clock, runtime, log } = open({ pushover: stopped }, openRuntimeLog(":memory:"), fakeWallClock(T0), { overdueAfter: 60 * SECOND });
    const first = await runtime.pass();
    expect(first.delivery?.failures.map((failure) => failure.kind)).toEqual(["consent"]);
    await clock.advance(120 * SECOND);
    expect((await runtime.pass()).delivery?.overdue).toEqual([]);
    log.close();
  });

  it("keeps the later flight of a key when an earlier flight fails after it started", async () => {
    const clock = fakeWallClock(T0);
    // The first send fails at 50 s. The second send starts at 40 s and hangs.
    const refused = (): Promise<SendOutcome> => new Promise((resolve) => clock.after(50 * SECOND, () => resolve({ ok: false, kind: "network", message: "The connection reset." })));
    const { runtime, log, pushover } = open({ pushover: { send: (_, count) => (count === 1 ? refused() : new Promise<SendOutcome>(() => undefined)) } }, openRuntimeLog(":memory:"), clock);
    const running = runtime.pass();
    await clock.advance(10 * SECOND);
    await running;
    await clock.advance(30 * SECOND);
    const second = runtime.pass();
    await clock.advance(10 * SECOND);
    await second;
    await settle();
    await clock.advance(5 * SECOND);
    await runtime.pass();
    expect(pushover.send).toHaveLength(2);
    log.close();
  });

  it("keeps a late delivery for the next pass when its write fails", async () => {
    const clock = fakeWallClock(T0);
    const inner = openRuntimeLog(":memory:");
    let fail = true;
    const flaky: RuntimeLog = {
      ...inner,
      appendAll: (events, accept) => {
        if (fail && events.some((event) => event.type === "delivery")) {
          fail = false;
          throw new Error("The disk is full.");
        }
        return inner.appendAll(events, accept);
      },
    };
    const late = (): Promise<SendOutcome> => new Promise((resolve) => clock.after(15 * SECOND, () => resolve({ ok: true, receipt: { receipt: "late-1" }, accepted: clock.now() })));
    const { runtime, pushover } = open({ pushover: { send: (_, count) => (count === 1 ? late() : undefined) } }, flaky, clock);
    const running = runtime.pass();
    await clock.advance(10 * SECOND);
    await running;
    await clock.advance(5 * SECOND);
    await settle();
    await expect(runtime.pass()).rejects.toThrow("The disk is full.");
    const pass = await runtime.pass();
    expect(pass.delivery?.sent.map((delivery) => delivery.receipt)).toEqual([{ receipt: "late-1" }]);
    expect(pushover.send).toHaveLength(1);
    inner.close();
  });

  it("refuses a flight limit that is shorter than the call limit", () => {
    expect(() => open({}, openRuntimeLog(":memory:"), fakeWallClock(T0), { flightLimit: 5 * SECOND })).toThrow("The flight limit (5000 ms) is shorter than the call limit (10000 ms).");
  });

  it("refuses a probe limit that is shorter than the retry", () => {
    expect(() => open({}, openRuntimeLog(":memory:"), fakeWallClock(T0), { probeLimit: 5 * SECOND })).toThrow("The probe limit (5000 ms) is shorter than the retry (15000 ms).");
  });

  it("refuses a channel whose maxInFlight is not an integer of 1 or more", () => {
    expect(() => open({ pushover: { describe: { maxInFlight: 0 } } })).toThrow("The channel pushover has maxInFlight 0. It must be an integer of 1 or more.");
  });

  it("refuses two channels with the same id", () => {
    const clock = fakeWallClock(T0);
    const twice = channel(PUSHOVER, "poll", () => clock.now()).procedures;
    expect(() => open({}, openRuntimeLog(":memory:"), clock, { channels: [twice, twice] })).toThrow("Two channels have the id pushover.");
  });
});

// A source that reports one earthquake. The code area puts it at the watched place, and the circle is its epicenter.
function quakeSource(id: SourceId, onset: number, center: Position, magnitude: string): SourceProcedures {
  return {
    describe: () => ({ ...SOURCE.describe(), id, title: `The source ${id}`, origins: [id], dependsOn: [`provider:${id}`], kinds: ["geo"] }),
    fetch: async () => ({
      ok: true,
      observations: [{ id: `${id}:q1` as ObservationId, source: id, fetched: T0, contentType: "application/json", body: "{}", transport: { latency: 0 } }],
      complete: true,
    }),
    map: ({ observation }) => ({
      reports: [
        {
          ...warning(observation),
          id: reportId({ source: id, key: "q1", sent: onset }),
          source: id,
          origin: id,
          key: "q1",
          kind: { code: "geo.earthquake", label: "Earthquake" },
          categories: ["geo"],
          sent: onset,
          onset,
          areas: [{ type: "code", system: "ugc", code: "KSZ083" }, { type: "circle", center, radiusKm: 30 }],
          headline: `Earthquake, from ${id}`,
          parameters: { magnitude: [magnitude] },
        },
      ],
      problems: [],
    }),
  };
}

describe("the link rule of the merge in the delivery", () => {
  // Two sources report one earthquake with their own ids: 6 s, 20 km and 0.2 of magnitude apart.
  function quakes(link?: LinkPolicy) {
    const clock = fakeWallClock(T0);
    const log = openRuntimeLog(":memory:");
    const pushover = channel(PUSHOVER, "poll", () => clock.now());
    const sms = channel(SMS, "none", () => clock.now());
    const runtime = openRuntime({
      log,
      clock,
      sources: [quakeSource("usgs" as SourceId, T0, [-97.4, 37.7], "4.5"), quakeSource("emsc" as SourceId, T0 + 6 * SECOND, [-97.3, 37.85], "4.3")],
      watch: () => ({ places: [KANSAS], kinds: ["geo"] }),
      view: { ...VIEW, kinds: ["geo"], ...(link === undefined ? {} : { link }) },
      run: RUN,
      delivery: { ...DELIVERY, channels: [pushover.procedures, sms.procedures] },
    });
    return { runtime, log, pushover: pushover.calls };
  }

  it("sends one alert for one earthquake of two sources, and an alert for each report with no family in the policy", async () => {
    const linked = quakes();
    const pass = await linked.runtime.pass();
    expect(pass.view.incidents.map((incident) => incident.reports.length)).toEqual([2]);
    expect(linked.pushover.send).toHaveLength(1);
    linked.log.close();
    const apart = quakes({ families: [] });
    const second = await apart.runtime.pass();
    expect(second.view.incidents.map((incident) => incident.reports.length)).toEqual([1, 1]);
    expect(apart.pushover.send).toHaveLength(2);
    apart.log.close();
  });
});

describe("the digest step of a pass", () => {
  // The quiet window of the person ends at 07:00 in Kansas. T0 is 13:00 there, thus the next digest time is 2026-04-02 12:00 UTC.
  const DIGEST_AT = Date.UTC(2026, 3, 2, 12);
  const DIGEST_POLICY: EscalationPolicy = { level: "digest", steps: [{ channel: PUSHOVER, at: 0 }], exhaustedAfter: 0 };
  const READER: Recipient = { ...RECIPIENT, watch: { ...RECIPIENT.watch, quiet: { zone: "America/Chicago", start: "22:00", end: "07:00" } }, policies: [LIFE_SAFETY, DIGEST_POLICY] };
  // A flood advisory: the severity minor gives the level digest.
  const ADVISORY: SourceProcedures = {
    ...SOURCE,
    map: ({ observation }) => ({
      reports: [
        {
          ...warning(observation),
          kind: { code: "met.flood", label: "Flood Advisory" },
          severity: "minor",
          urgency: "expected",
          expires: T0 + 3 * 24 * 60 * MINUTE,
          headline: "Flood Advisory issued April 1 at 1:00PM CDT by NWS Wichita KS",
        },
      ],
      problems: [],
    }),
  };

  function openDigest(log: RuntimeLog, clock: ReturnType<typeof fakeWallClock>) {
    const pushover = channel(PUSHOVER, "none", () => clock.now());
    const sms = channel(SMS, "none", () => clock.now());
    const runtime = openRuntime({
      log,
      clock,
      sources: [ADVISORY],
      watch: () => ({ places: [KANSAS], kinds: ["met"] }),
      view: VIEW,
      run: `run-${clock.now()}`,
      delivery: { ...DELIVERY, recipients: [READER], channels: [pushover.procedures, sms.procedures] },
    });
    return { runtime, pushover: pushover.calls };
  }

  it("sends no message for the level digest at once, then one digest at the digest time, one time, also after a restart", async () => {
    const log = openRuntimeLog(":memory:");
    const clock = fakeWallClock(T0);
    const first = openDigest(log, clock);
    await first.runtime.pass();
    expect(first.pushover.send).toEqual([]);
    expect(first.runtime.state().merge.deliveries).toEqual([]);

    await clock.advance(DIGEST_AT - T0);
    await first.runtime.pass();
    expect(first.pushover.send).toHaveLength(1);
    const [incident] = first.runtime.state().merge.reports.map((report) => report.id);
    expect(first.pushover.send[0]).toMatchObject({
      person: PERSON,
      level: "digest",
      title: "The digest: 1 alert",
      body: "- Flood Advisory issued April 1 at 1:00PM CDT by NWS Wichita KS",
      incident,
      quiet: false,
    });
    const deliveries = first.runtime.state().merge.deliveries;
    expect(deliveries).toEqual([expect.objectContaining({ incident, level: "digest", person: PERSON, channel: PUSHOVER, step: 0, at: DIGEST_AT })]);

    // A later pass of the same day, a restart, and the next day send no second digest of the advisory.
    await clock.advance(MINUTE);
    await first.runtime.pass();
    expect(first.pushover.send).toHaveLength(1);
    const second = openDigest(log, clock);
    await second.runtime.pass();
    await clock.advance(24 * 60 * MINUTE);
    await second.runtime.pass();
    expect(second.pushover.send).toEqual([]);
    expect(second.runtime.state()).toEqual(rebuild(log.read(), second.runtime.config));
    log.close();
  });

  it("keeps the digest due after a failed send, and records it after the retry", async () => {
    const log = openRuntimeLog(":memory:");
    const clock = fakeWallClock(DIGEST_AT);
    const pushover = channel(PUSHOVER, "none", () => clock.now(), { send: (_message, count) => (count === 1 ? { ok: false, kind: "server", message: "The test channel failed." } : undefined) });
    const runtime = openRuntime({
      log,
      clock,
      sources: [ADVISORY],
      watch: () => ({ places: [KANSAS], kinds: ["met"] }),
      view: VIEW,
      run: `run-${clock.now()}`,
      delivery: { ...DELIVERY, recipients: [READER], channels: [pushover.procedures] },
    });
    // The report came at T0, before the digest time. The first send fails and makes no record.
    await runtime.pass();
    expect(pushover.calls.send).toHaveLength(1);
    expect(runtime.state().merge.deliveries).toEqual([]);
    await clock.advance(DELIVERY.retry);
    await runtime.pass();
    expect(pushover.calls.send).toHaveLength(2);
    expect(pushover.calls.send[1]?.key).toBe(pushover.calls.send[0]?.key);
    expect(runtime.state().merge.deliveries.map((delivery) => delivery.level)).toEqual(["digest"]);
    log.close();
  });
});

describe("the exhausted escalations in the passes of the runtime (AL-21)", () => {
  it("alerts the watcher of the person one pass after the exhaustion, and cancels the alert after a late acknowledgment", async () => {
    const watcher: Recipient = { ...RECIPIENT, watch: { person: "person-2" as PersonId, places: [], rules: [], subjects: [{ system: PERSON_SUBJECT, id: PERSON }] } };
    const clock = fakeWallClock(T0);
    let acked: number | undefined;
    // The push asks for an acknowledgment at life-safety. The first person acknowledges the first push only when the test says so.
    const pushover = channel(PUSHOVER, "poll", () => clock.now(), {
      describe: { ackLevels: ["life-safety"] },
      status: (receipt) => (acked !== undefined && receipt["receipt"] === "pushover-1" ? { state: "acknowledged", at: acked } : { state: "delivered", at: clock.now() }),
    });
    const sms = channel(SMS, "none", () => clock.now());
    const log = openRuntimeLog(":memory:");
    const runtime = openRuntime({ log, clock, sources: [SOURCE], watch: () => ({ places: [KANSAS], kinds: ["met"] }), view: VIEW, run: RUN, delivery: { ...DELIVERY, recipients: [RECIPIENT, watcher], channels: [pushover.procedures, sms.procedures] } });
    const exhaustedLines = () => Object.keys(runtime.state().lines.open).filter((line) => line.startsWith("exhausted/"));
    const titles = (calls: Calls) => calls.send.map((message) => [message.person, message.title]);

    await runtime.pass();
    await clock.advance(5 * MINUTE);
    await runtime.pass();
    expect(titles(pushover.calls).map(([person]) => person)).toEqual([PERSON]);
    // The policy ends 20 minutes after its last step. The pass of the exhaustion wakes the next pass at once.
    await clock.advance(20 * MINUTE);
    const exhausted = await runtime.pass();
    expect(exhausted.delivery?.exhausted.map((entry) => [entry.person, entry.level])).toEqual([[PERSON, "life-safety"]]);
    expect(exhausted.wakeAt).toBe(clock.now() + 1);
    expect(exhaustedLines()).toEqual([]);
    await clock.advance(1);
    const next = await runtime.pass();
    expect(next.view.step.reports.map((report) => [report.op, report.kind.code])).toEqual([["alert", `${ESCALATION_KIND}.exhausted`]]);
    expect(exhaustedLines().length).toBe(1);
    // Only the watcher gets the alert, and its title tells what the first person missed.
    expect(titles(pushover.calls).slice(1)).toEqual([["person-2", "person-1 did not acknowledge Tornado Warning (life-safety): Tornado Warning issued April 1 at 1:00PM CDT by NWS Wichita KS"]]);

    // The first person acknowledges late. The line ends, and the push of the watcher is cancelled.
    acked = clock.now();
    await clock.advance(30 * SECOND);
    const late = await runtime.pass();
    expect(late.delivery?.exhausted).toEqual([]);
    expect(late.wakeAt).toBe(clock.now() + 1);
    await clock.advance(1);
    await runtime.pass();
    await clock.advance(SECOND);
    await runtime.pass();
    expect(exhaustedLines()).toEqual([]);
    expect(pushover.calls.cancel).toContainEqual({ receipt: "pushover-2" });
    log.close();
  });
});

describe("the down channels in the passes of the runtime (AL-65)", () => {
  const channelLines = (runtime: ReturnType<typeof open>["runtime"]) => Object.keys(runtime.state().lines.open).filter((line) => line.startsWith("channel/"));
  const down = (pass: { readonly view: { readonly step: { readonly reports: readonly Report[] } } }) =>
    pass.view.step.reports.filter((report) => report.kind.code === "system.channel.down").map((report) => report.op);

  it("opens the line after a run of failed sends, keeps it at a restart, and the first good send ends it", async () => {
    const clock = fakeWallClock(T0);
    let up = false;
    // This channel has no probe. Only an accepted send ends its line.
    const failing: Script = {
      send: () => (up ? undefined : { ok: false, kind: "server", message: "Pushover gave the status 503." }),
      describe: { services: ["domain:api.example.com"], api: ["domain:api.example.com"] },
    };
    const log = openRuntimeLog(":memory:");
    const { runtime } = open({ pushover: failing }, log, clock);
    // Failed sends at 0, 20, 40 and 60 s: the retry of the delivery is 15 s.
    let last = await runtime.pass();
    for (let index = 0; index < 3; index += 1) {
      await clock.advance(20 * SECOND);
      last = await runtime.pass();
    }
    expect(channelLines(runtime)).toEqual([]);
    // The fourth failure makes a run of 60 s, thus the next pass comes at once and opens the line.
    expect(last.wakeAt).toBe(clock.now() + 1);
    await clock.advance(1);
    const opened = await runtime.pass();
    expect(down(opened)).toEqual(["alert"]);
    expect(channelLines(runtime)).toEqual([`channel/${ONLY_COPY.id}/pushover`]);
    expect(opened.view.step.reports.find((report) => report.op === "alert")?.about).toEqual([
      { system: "alerts.channel", id: PUSHOVER, label: PUSHOVER },
      { system: "domain", id: "api.example.com" },
    ]);

    // A restart empties the run, and the line stays.
    const again = open({ pushover: failing }, log, clock);
    await clock.advance(20 * SECOND);
    expect(down(await again.runtime.pass())).toEqual([]);
    expect(channelLines(again.runtime)).toEqual([`channel/${ONLY_COPY.id}/pushover`]);

    // The provider takes the next retry. The accepted send wakes the next pass at once, and that view ends the line.
    up = true;
    await clock.advance(20 * SECOND);
    const accepted = await again.runtime.pass();
    expect(accepted.delivery?.sent.map((sent) => sent.channel)).toEqual([PUSHOVER]);
    expect(accepted.wakeAt).toBe(clock.now() + 1);
    await clock.advance(1);
    expect(down(await again.runtime.pass())).toEqual(["cancel"]);
    expect(channelLines(again.runtime)).toEqual([]);
    log.close();
  });

  it("finds a quiet outage by the probes alone, and a probe success ends the line with no send", async () => {
    const clock = fakeWallClock(T0);
    let up = false;
    const probes: number[] = [];
    const pushover = channel(PUSHOVER, "poll", () => clock.now(), {
      probe: () => {
        probes.push(clock.now());
        return up ? { ok: true, at: clock.now() } : { ok: false, kind: "server", message: "Pushover gave the status 503." };
      },
      describe: { services: ["domain:api.example.com"], api: ["domain:api.example.com"] },
    });
    const sms = channel(SMS, "none", () => clock.now());
    const log = openRuntimeLog(":memory:");
    // No source gives a report, thus the runtime sends nothing.
    const runtime = openRuntime({ log, clock, sources: [], watch: () => ({ places: [KANSAS], kinds: ["met"] }), view: VIEW, run: RUN, delivery: { ...DELIVERY, channels: [pushover.procedures, sms.procedures] } });
    const lines = () => Object.keys(runtime.state().lines.open).filter((line) => line.startsWith("channel/"));
    // The first probe comes 1 minute after the start. The failed probes come 1 and 2 minutes apart.
    let pass = await runtime.pass();
    for (let index = 0; index < 3; index += 1) {
      await clock.advance(pass.wakeAt! - clock.now());
      pass = await runtime.pass();
    }
    expect(probes).toEqual([T0 + MINUTE, T0 + 2 * MINUTE, T0 + 4 * MINUTE]);
    // The third failed probe over 3 minutes opens the line in the view of the same pass.
    expect(down(pass)).toEqual(["alert"]);
    expect(lines()).toEqual([`channel/${ONLY_COPY.id}/pushover`]);
    // The health route reads the same runs: the kind of each failure, and no message.
    expect(runtime.channels().map(({ channel, run, good }) => ({ channel, run, good }))).toEqual([
      { channel: PUSHOVER, run: { channel: PUSHOVER, failures: 3, first: T0 + MINUTE, last: T0 + 4 * MINUTE, kind: "server", reached: true }, good: undefined },
      { channel: SMS, run: undefined, good: undefined },
    ]);

    up = true;
    await clock.advance(pass.wakeAt! - clock.now());
    const ended = await runtime.pass();
    expect(probes.at(-1)).toBe(T0 + 8 * MINUTE);
    expect(down(ended)).toEqual(["cancel"]);
    expect(lines()).toEqual([]);
    expect(pushover.calls.send).toEqual([]);
    // The passed probe shows as the last good call of the channel, with no run.
    expect(runtime.channels()[0]).toEqual({ copy: ONLY_COPY.id, channel: PUSHOVER, title: expect.any(String), api: ["domain:api.example.com"], good: T0 + 8 * MINUTE });
    log.close();
  });

  it("opens no line for a burst of failed sends in one pass", async () => {
    const clock = fakeWallClock(T0);
    const failing: Script = { send: () => ({ ok: false, kind: "server", message: "Pushover gave the status 503." }) };
    const { runtime, log } = open({ pushover: failing }, openRuntimeLog(":memory:"), clock, { recipients: PEOPLE });
    const pass = await runtime.pass();
    expect(pass.delivery?.failures.filter((failure) => failure.channel === PUSHOVER).length).toBe(PEOPLE.length);
    await clock.advance(1);
    await runtime.pass();
    expect(channelLines(runtime)).toEqual([]);
    log.close();
  });
});

describe("the send limit in the passes of the runtime (AL-72)", () => {
  const BURST = 20;
  const LIMITS = { window: 60 * MINUTE, notice: 2, urgent: 2 };
  const NOTICE: EscalationPolicy = { level: "notice", steps: [{ channel: SMS, at: 0 }], exhaustedAfter: 60 * MINUTE };
  const URGENT: EscalationPolicy = { level: "urgent", steps: [{ channel: SMS, at: 0 }], exhaustedAfter: 60 * MINUTE };
  const reader: Recipient = { ...RECIPIENT, policies: [LIFE_SAFETY, URGENT, NOTICE] };
  // A burst of made-up flood statements for the place: one observation with 20 reports of 20 incidents.
  const burst: SourceProcedures = {
    ...SOURCE,
    map: ({ observation }) => ({
      reports: Array.from({ length: BURST }, (_, index) => ({
        ...warning(observation),
        id: reportId({ source: API, key: `f${index}`, sent: T0 }),
        key: `f${index}`,
        kind: { code: "met.flood", label: "Flood Statement" },
        severity: "moderate" as const,
        urgency: "expected" as const,
        response: ["monitor" as const],
        expires: T0 + 6 * 60 * MINUTE,
        headline: `Flood Statement ${index}`,
      })),
      problems: [],
    }),
  };

  function openBurst(sms: Script = {}, extra: Partial<DeliveryOptions> = { sendLimits: LIMITS }, log = openRuntimeLog(":memory:"), clock = fakeWallClock(T0)) {
    const pushover = channel(PUSHOVER, "poll", () => clock.now());
    const text = channel(SMS, "none", () => clock.now(), sms);
    const runtime = openRuntime({
      log,
      clock,
      sources: [burst],
      watch: () => ({ places: [KANSAS], kinds: ["met"] }),
      view: VIEW,
      run: `run-${clock.now()}`,
      delivery: { ...DELIVERY, recipients: [reader], channels: [pushover.procedures, text.procedures], ...extra },
    });
    return { clock, log, runtime, sms: text.calls };
  }
  const holds = (log: RuntimeLog) => [...log.read()].flatMap((event) => (event.type === "hold" ? [event.hold] : []));

  it("sends a burst of new incidents up to the limit of the person, holds the rest once, and tells the person once", async () => {
    const { clock, log, runtime, sms } = openBurst();
    const first = await runtime.pass();
    expect(sms.send).toHaveLength(2);
    expect(new Set(sms.send.map((message) => message.level))).toEqual(new Set(["notice"]));
    expect(holds(log)).toHaveLength(BURST - 2);
    // The new holds bring the next pass at once. It gives the notice of the send limit (AL-81).
    expect(first.wakeAt).toBe(first.at + 1);
    for (let minute = 1; minute <= 5; minute += 1) {
      await clock.advance(MINUTE);
      await runtime.pass();
    }
    // The person gets one private notice that the limit holds alerts. No later pass sends a held alert or a second notice.
    expect(sms.send.map((message) => [message.level, message.person])).toEqual([...Array.from({ length: 3 }, () => ["notice", PERSON])]);
    expect(sms.send[2]?.title).toContain("The send limit holds new alerts for you");
    // The notice names the held alerts and the count of the rest (AL-98).
    expect(sms.send[2]?.body).toContain(`The send limit holds ${BURST - 2} new alerts for you:\n- Flood Statement`);
    expect(sms.send[2]?.body).toContain(`- ${BURST - 2 - HELD_SHOWN} other alerts`);
    expect(holds(log)).toHaveLength(BURST - 2);
    // The line of the notice ends one window after the last hold. The end is a cancel, not a send: the phone gets no second message.
    await clock.advance(LIMITS.window);
    await runtime.pass();
    // The view of a pass reads the merge state before the system reports of the pass. Thus the next pass shows the cancel.
    await clock.advance(MINUTE);
    const after = await runtime.pass();
    expect(after.view.incidents.filter((incident) => incident.kind.code === "system.limit.held").map((incident) => incident.live)).toEqual([false]);
    expect(sms.send).toHaveLength(3);
    // The fold of the log gives the same holds.
    expect(runtime.state()).toEqual(rebuild(log.read(), runtime.config));
    expect(runtime.state().holds).toHaveLength(BURST - 2);
    log.close();
  });

  const suppressed = (log: RuntimeLog) => [...log.read()].flatMap((event) => (event.type === "suppressed" ? [event.suppression] : []));

  it("(d) writes a suppressed event with its reason for each send under the bar of the throttle, and never sends it (AL-72 part 4)", async () => {
    // An urgent message went to the person on the text channel 1 minute before the burst.
    const log = openRuntimeLog(":memory:");
    const incident = reportId({ source: API, key: "earlier", sent: T0 - 2 * MINUTE });
    const delivery = { key: messageKey({ incident, level: "urgent", person: PERSON, step: 0 }), incident, level: "urgent" as const, person: PERSON, channel: SMS, step: 0, at: T0 - MINUTE, receipt: {} };
    // Its report is in the merge state, thus it is in the stream of the alerts. The person does not watch its kind: it has no route.
    const seen: Observation = { id: "api:earlier" as ObservationId, source: API, fetched: T0 - 2 * MINUTE, contentType: "application/json", body: "{}", transport: { latency: 0 } };
    const earlier: Report = { ...warning(seen), id: incident, key: "earlier", sent: T0 - 2 * MINUTE, kind: { code: "geo.landslide", label: "Landslide Warning" }, categories: ["geo"], areas: [{ type: "code", system: "ugc", code: "TXZ205" }] };
    const fetched: RuntimeEvent = { ...envelope("fetch", "fetch:earlier", T0 - 2 * MINUTE), record: { source: API, at: T0 - 2 * MINUTE, took: 100, fresh: 1, fatal: 0 }, reports: [earlier], problems: [] };
    log.appendAll([fetched, { ...envelope("delivery", `delivery:${delivery.key}`, T0 - MINUTE), delivery }], () => undefined);
    const { clock, runtime, sms } = openBurst({}, { sendLimits: LIMITS, throttle: DEFAULT_THROTTLE }, log);
    await runtime.pass();
    // The send limit admits 2 notices and holds the rest. The throttle stops the 2 notices: they are under the urgent message.
    expect(sms.send).toHaveLength(0);
    const first = suppressed(log);
    expect(first.map((one) => [one.level, one.reason, one.over, one.channel, one.person])).toEqual(Array.from({ length: LIMITS.notice }, () => ["notice", "lower-level", "urgent", SMS, PERSON]));
    expect(holds(log)).toHaveLength(BURST - LIMITS.notice);
    // After the window, the suppressed sends still do not go, and no pass writes them again.
    await clock.advance(DEFAULT_THROTTLE.window + MINUTE);
    await runtime.pass();
    // The only send is the notice of the send limit (AL-81). It is private, thus the urgent message does not stop it.
    expect(sms.send.map((message) => message.title)).toEqual([expect.stringContaining("The send limit holds new alerts for you")]);
    expect(suppressed(log)).toEqual(first);
    // The fold of the log gives the same suppressions.
    expect(runtime.state()).toEqual(rebuild(log.read(), runtime.config));
    expect(runtime.state().suppressions).toEqual(first);
    log.close();
  });

  it("gives the default limit with no limit in the options", async () => {
    const { log, runtime, sms } = openBurst({}, {});
    await runtime.pass();
    expect(sms.send).toHaveLength(6);
    log.close();
  });

  it("doubles the wait of a refused send after each refusal of its key in a row, up to the refusal limit", async () => {
    const refuse: Script = { send: () => ({ ok: false, kind: "refused", message: "The number is not valid." }) };
    const { clock, log, runtime } = openBurst(refuse, { sendLimits: { ...LIMITS, notice: 1 }, refusalLimit: 60 * SECOND });
    const waits: number[] = [];
    // The notice of the send limit (AL-81) has its own refused sends. The test follows the key of the first refused send.
    let key: string | undefined;
    for (let round = 0; round < 5; round += 1) {
      const pass = await runtime.pass();
      const failure = pass.delivery?.failures.find((entry) => key === undefined || entry.key === key);
      key ??= failure?.key;
      expect(failure?.kind).toBe("refused");
      const wait = (failure?.retryAt ?? clock.now()) - clock.now();
      waits.push(wait);
      await clock.advance(wait);
    }
    expect(waits).toEqual([15 * SECOND, 30 * SECOND, 60 * SECOND, 60 * SECOND, 60 * SECOND]);
    log.close();
  });

  it("doubles the wait of each key when two keys are refused in one pass, also with a restart between the rounds", async () => {
    const refuse: Script = { send: () => ({ ok: false, kind: "refused", message: "The number is not valid." }) };
    for (const restart of [false, true]) {
      const first = openBurst(refuse);
      const { clock, log } = first;
      let { runtime } = first;
      const waits: number[][] = [];
      // The notice of the send limit (AL-81) has its own refused sends from a later round. The test follows the keys of the first round.
      let keys: ReadonlySet<string> | undefined;
      for (let round = 0; round < 4; round += 1) {
        const pass = await runtime.pass();
        const sends = pass.delivery?.failures.filter((failure) => failure.call === "send") ?? [];
        keys ??= new Set(sends.map((failure) => failure.key));
        const failures = sends.filter((failure) => keys?.has(failure.key));
        expect(failures.map((failure) => failure.kind)).toEqual(["refused", "refused"]);
        const round_ = failures.map((failure) => failure.retryAt - clock.now());
        waits.push(round_);
        await clock.advance(Math.max(...round_));
        if (restart) {
          await runtime.close();
          ({ runtime } = openBurst(refuse, undefined, log, clock));
        }
      }
      expect(waits, restart ? "with a restart" : "in one process").toEqual([15, 30, 60, 120].map((wait) => [wait * SECOND, wait * SECOND]));
      log.close();
    }
  });

  it("doubles the wait of a refused send for each refusal in a row, up to the refusal limit", () => {
    expect(Array.from({ length: 8 }, (_, streak) => refusalWait(streak, 10 * SECOND))).toEqual([10, 20, 40, 80, 160, 320, 600, 600].map((wait) => wait * SECOND));
    expect(refusalWait(3, 10 * SECOND, 60 * SECOND)).toBe(60 * SECOND);
    // A limit under the retry keeps the retry.
    expect(refusalWait(2, 10 * SECOND, 5 * SECOND)).toBe(10 * SECOND);
  });

  it("keeps the count of the refusals of a key past its retry time, also after a refusal of another key", () => {
    const { log, runtime } = openBurst();
    const refusedAt = (key: string, time: number, wait: number): RuntimeEvent => ({ ...envelope("refused", `refused:${key}@${time}`, time), key, channel: SMS, kind: "refused", retryAt: time + wait });
    // Key a is refused 2 times. A refusal of key b after the retry time of a does not end the count of a.
    const events = [refusedAt("a", T0, 15 * SECOND), refusedAt("a", T0 + 15 * SECOND, 30 * SECOND), refusedAt("b", T0 + 50 * SECOND, 15 * SECOND)];
    const state = rebuild(events, runtime.config);
    expect(refusalStreak(state.refusals, "a", T0 + 50 * SECOND)).toBe(2);
    expect(refusalStreak(state.refusals, "b", T0 + 50 * SECOND)).toBe(1);
    // The count ends after the retry time plus the refusal limit.
    expect(refusalStreak(state.refusals, "a", T0 + 45 * SECOND + REFUSAL_LIMIT)).toBe(0);
    const late = rebuild([...events, refusedAt("b", T0 + 70 * SECOND + REFUSAL_LIMIT, 15 * SECOND)], runtime.config);
    expect(Object.keys(late.refusals)).toEqual(["b"]);
    expect(late.refusals["b"]?.streak).toBe(1);
    log.close();
  });
});
