import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Acknowledgment,
  Address,
  ChannelDescriptor,
  ChannelId,
  Delivery,
  EscalationPolicy,
  Incident,
  InterestGraph,
  Level,
  MergeState,
  MuteEffect,
  PersonId,
  PlaceId,
  Report,
  ReportId,
  WatchedPlace,
} from "./contracts.ts";
import { LEVELS } from "./contracts.ts";
import { acknowledgmentOf, addressProblems, exhaustions, messageOf, policyFor, policyName, recipientProblems, route, RULED_STATUSES, ruleSteps, type ChannelRule, type EscalationEnd, type EscalationStart, type Recipient, type Route, type RouteInput } from "./delivery.ts";
import { RANK_DELAY_LIMIT, rankDelayProblems } from "./escalation.ts";
import { messageKey } from "./ids.ts";
import { matchSubjects } from "./assess.ts";
import { DRILL_SUBJECT } from "./system-reports.ts";
import { placeWhy } from "./why.ts";

// The mute of each assessment. `assess` gives `Assessment.muted` from the graph of the person. The mock adds the mute
// of the test to the assessment, so a test sets the effect with no graph. With no mute, it gives the assessment as it is.
const mutes = vi.hoisted(() => ({ effect: undefined as MuteEffect | undefined }));
vi.mock("./assess.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./assess.ts")>();
  return {
    ...real,
    assess: (...args: Parameters<typeof real.assess>) => {
      const result = real.assess(...args);
      return mutes.effect === undefined ? result : { ...result, muted: { mute: "mute-1", effect: mutes.effect } };
    },
  };
});

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const MINUTE = 60_000;
const T0 = Date.UTC(2026, 3, 1, 18);
const anchor = "a".repeat(64) as ReportId;
const merged = "b".repeat(64) as ReportId;
const pushover = "pushover" as ChannelId;
const sms = "sms" as ChannelId;

// A public place in Kansas: Sedgwick County.
const home = "place-1" as PlaceId;
const places: readonly WatchedPlace[] = [{ id: home, codes: [{ system: "ugc", code: "KSC173" }], bufferKm: 5 }];
const atHome = [{ type: "code", system: "ugc", code: "KSC173" }] as const;

const LIFE_SAFETY: EscalationPolicy = {
  level: "life-safety",
  steps: [
    { channel: pushover, at: 0 },
    { channel: sms, at: 5 * MINUTE },
  ],
  exhaustedAfter: 20 * MINUTE,
};
const URGENT: EscalationPolicy = { level: "urgent", steps: [{ channel: pushover, at: 0 }], exhaustedAfter: 10 * MINUTE };

function recipient(person = "person-1", policies: readonly EscalationPolicy[] = [LIFE_SAFETY, URGENT], watched: readonly PlaceId[] = [home]): Recipient {
  return { watch: { person: person as PersonId, places: watched, rules: [] }, policies, addresses: { pushover: { user: "fake-user" }, sms: { to: "fake-number" } } };
}

function channel(id: ChannelId, ack: ChannelDescriptor["ack"]): ChannelDescriptor {
  return { id, title: id, dependsOn: [], uses: ["internet", "dns"], breaksThrough: true, repeats: ack === "poll", ack, maxTitle: 250, maxBody: 1024 };
}
const CHANNELS = [channel(pushover, "poll"), channel(sms, "none")];

// A tornado warning gives `life-safety`, and a tornado watch gives `urgent`.
const WARNING = { severity: "extreme", urgency: "immediate" } as const;
const WATCH = { severity: "extreme", urgency: "future" } as const;

function incident(fields: Partial<Incident> = {}): Incident {
  return {
    anchor,
    reports: [anchor, merged],
    status: "actual",
    kind: { code: "met.tornado", label: "Tornado" },
    ...WARNING,
    certainty: "observed",
    areas: atHome,
    about: [],
    live: true,
    corroboration: 1,
    ...fields,
  };
}

const person = "person-1" as PersonId;

function delivery(level: Level, step: number, at: number, extra: Partial<Delivery> = {}): Delivery {
  return { key: messageKey({ incident: anchor, level, person, step }), incident: anchor, level, person, channel: pushover, step, at, receipt: { receipt: `r-${level}-${step}` }, ...extra };
}

function start(level: Level, at: number, incidentId: ReportId = anchor): EscalationStart {
  return { incident: incidentId, level, person, at };
}

function input(extra: Partial<RouteInput> & { readonly merge?: Partial<MergeState> } = {}): RouteInput {
  const { merge, ...rest } = extra;
  return {
    state: { reports: [], deliveries: [], acks: [], ends: [], retired: [], ...merge },
    incidents: [incident()],
    recipients: [recipient()],
    places,
    starts: [],
    cancelled: new Set(),
    channels: CHANNELS,
    now: T0,
    ...rest,
  };
}

const summary = (routes: readonly Route[]) =>
  routes.map((entry) => ({ level: entry.policy.level, state: entry.plan.state, fresh: entry.fresh, sends: entry.plan.sends.map((send) => send.step), cancels: entry.plan.cancels.map((d) => d.key) }));

describe("route", () => {
  it("reads the parts of each person one time, not one time for each person (AL-136)", () => {
    // Each read of the field person of a delivery counts. A filter for each person reads the square of the persons.
    const count = 300;
    let reads = 0;
    const counted = (item: Delivery): Delivery =>
      new Proxy(item, {
        get(target, key, receiver) {
          if (key === "person") reads += 1;
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
    const people = Array.from({ length: count }, (_, index) => `person-${String(index + 1)}` as PersonId);
    const deliveries = people.map((one) => counted({ ...delivery("life-safety", 0, T0 - MINUTE), person: one, key: messageKey({ incident: anchor, level: "life-safety", person: one, step: 0 }) }));
    const routes = route(input({ recipients: people.map((one) => recipient(one)), merge: { deliveries } }));
    expect(routes).toHaveLength(count);
    expect(reads).toBeLessThanOrEqual(4 * count);
  });

  it("starts a new escalation at the assessed level, and sends its first step", () => {
    const routes = route(input());
    expect(summary(routes)).toEqual([{ level: "life-safety", state: "sent", fresh: true, sends: [0], cancels: [] }]);
    expect(routes[0]!.start).toEqual(start("life-safety", T0));
    expect(routes[0]!.plan.wakeAt).toBe(T0 + 5 * MINUTE);
  });

  it("gives the why of the matched place with the first id, whatever the order of the places of the person", () => {
    const lake = "place-0" as PlaceId;
    const both: readonly WatchedPlace[] = [...places, { id: lake, codes: [{ system: "ugc", code: "KSC173" }], bufferKm: 5 }];
    const routes = route(input({ places: both, recipients: [recipient("person-1", [LIFE_SAFETY, URGENT], [home, lake])] }));
    expect(routes[0]!.why).toEqual(placeWhy([lake]));
    expect(routes[0]!.why).toEqual({ rule: "reach.place.places", subject: "place:place-0", kind: "place", anchor: "place:place-0", origin: "places", coverage: 1 });
    expect(route(input())[0]!.why?.anchor).toBe("place:place-1");
  });

  it("gives no why to a match by subjects alone, and none to an incident that is over", () => {
    const operator = recipient("person-1", [LIFE_SAFETY, URGENT], []);
    const watching: Recipient = { ...operator, watch: { ...operator.watch, subjects: [{ system: "alerts.source" }] } };
    const about = incident({ areas: [], about: [{ system: "alerts.source", id: "source-1" }] });
    const routes = route(input({ incidents: [about], recipients: [watching] }));
    expect(routes).toHaveLength(1);
    expect(routes[0]!.why).toBeUndefined();
    const sent = [delivery("life-safety", 0, T0)];
    const over = incident({ live: false, expires: T0 + MINUTE });
    const ended = route(input({ incidents: [over], starts: [start("life-safety", T0)], merge: { deliveries: sent }, now: T0 + 3 * MINUTE }));
    expect(ended).toHaveLength(1);
    expect(ended[0]!.why).toBeUndefined();
  });

  it("routes an incident by a topic alone, with no area and no place of the person", () => {
    const base = recipient("person-1", [LIFE_SAFETY, URGENT], []);
    const follower: Recipient = { ...base, watch: { ...base.watch, subjects: [{ system: "topic", id: "infra.power.outage" }] } };
    // A power cut has no class of its own. Thus the table of the other kinds gives it `urgent` at most.
    const outage = incident({ kind: { code: "infra.power.outage", label: "Power outage" }, areas: [], about: [{ system: "topic", id: "infra.power.outage" }] });
    const routes = route(input({ incidents: [outage], recipients: [follower] }));
    expect(summary(routes)).toEqual([{ level: "urgent", state: "last", fresh: true, sends: [0], cancels: [] }]);
    expect(routes[0]!.start).toEqual(start("urgent", T0));
    // A match by the subjects of the watch has no why. The why of a topic comes from the interest graph.
    expect(routes[0]!.why).toBeUndefined();
    // A topic of a life-safety kind escalates as a place does: the first step at once, the second step after 5 minutes.
    const storm: Recipient = { ...base, watch: { ...base.watch, subjects: [{ system: "topic", id: "met.tornado" }] } };
    const tornado = incident({ areas: [], about: [{ system: "topic", id: "met.tornado" }] });
    const first = route(input({ incidents: [tornado], recipients: [storm] }));
    expect(summary(first)).toEqual([{ level: "life-safety", state: "sent", fresh: true, sends: [0], cancels: [] }]);
    expect(first[0]!.plan.wakeAt).toBe(T0 + 5 * MINUTE);
    const later = route(input({ incidents: [tornado], recipients: [storm], starts: [start("life-safety", T0)], now: T0 + 6 * MINUTE }));
    expect(summary(later)).toEqual([{ level: "life-safety", state: "last", fresh: false, sends: [0, 1], cancels: [] }]);
  });

  it("matches a topic by its system and its id, and a watch of a system with no id matches each topic", () => {
    const base = recipient("person-1", [LIFE_SAFETY, URGENT], []);
    const watching = (subjects: NonNullable<Recipient["watch"]["subjects"]>): Recipient => ({ ...base, watch: { ...base.watch, subjects } });
    const flood = incident({ areas: [], about: [{ system: "topic", id: "met.flood" }] });
    expect(route(input({ incidents: [flood], recipients: [watching([{ system: "topic", id: "met.tornado" }])] }))).toEqual([]);
    expect(route(input({ incidents: [flood], recipients: [watching([{ system: "iptc", id: "met.flood" }])] }))).toEqual([]);
    expect(route(input({ incidents: [flood], recipients: [watching([{ system: "topic" }])] }))).toHaveLength(1);
    expect(route(input({ incidents: [flood], recipients: [base] }))).toEqual([]);
  });

  it("reaches a person by a topic when no place of the person is in the area, and gives the why of a place in the area", () => {
    const base = recipient();
    const follower: Recipient = { ...base, watch: { ...base.watch, subjects: [{ system: "topic", id: "met.tornado" }] } };
    // Harvey County, Kansas: a county next to the place of the person.
    const elsewhere = incident({ areas: [{ type: "code", system: "ugc", code: "KSC079" }], about: [{ system: "topic", id: "met.tornado" }] });
    const far = route(input({ incidents: [elsewhere], recipients: [follower] }));
    expect(summary(far)).toEqual([{ level: "life-safety", state: "sent", fresh: true, sends: [0], cancels: [] }]);
    expect(far[0]!.why).toBeUndefined();
    // Without the topic, the incident does not reach the person.
    expect(route(input({ incidents: [elsewhere] }))).toEqual([]);
    const near = route(input({ incidents: [incident({ about: [{ system: "topic", id: "met.tornado" }] })], recipients: [follower] }));
    expect(near[0]!.why).toEqual(placeWhy([home]));
  });

  it("gives the why of the interest graph before the why of a watched place", () => {
    const base = recipient();
    const interests: InterestGraph = {
      format: "alerts-interest/1",
      person: base.watch.person,
      edges: [{ id: "e1", from: "topic:met.tornado", to: "person", kind: "interest", weight: { value: 1, low: 1, high: 1 }, origin: "person", on: true }],
      mutes: [],
    };
    const follower: Recipient = { ...base, watch: { ...base.watch, interests } };
    const tornado = incident({ about: [{ system: "topic", id: "met.tornado" }] });
    const routes = route(input({ incidents: [tornado], recipients: [follower] }));
    expect(routes).toHaveLength(1);
    expect(routes[0]!.why).toEqual({ rule: "reach.topic.person", subject: "topic:met.tornado", kind: "topic", anchor: "topic:met.tornado", origin: "person", coverage: 1 });
    // Without the graph, the watched place gives the why.
    expect(route(input({ incidents: [tornado] }))[0]!.why).toEqual(placeWhy([home]));
  });

  it("keeps the start of the log, thus a step comes at its time after a restart", () => {
    const routes = route(input({ starts: [start("life-safety", T0)], now: T0 + 6 * MINUTE }));
    expect(summary(routes)).toEqual([{ level: "life-safety", state: "last", fresh: false, sends: [0, 1], cancels: [] }]);
    expect(routes[0]!.start.at).toBe(T0);
  });

  it("finds a start of a merged report of the incident", () => {
    const routes = route(input({ starts: [start("life-safety", T0, merged)], now: T0 + MINUTE }));
    expect(routes[0]!.fresh).toBe(false);
    expect(routes[0]!.start).toEqual(start("life-safety", T0, merged));
  });

  it("starts nothing for a level with no policy of the person", () => {
    expect(route(input({ recipients: [recipient("person-1", [URGENT])] }))).toEqual([]);
  });

  it("starts nothing for a person who does not watch the place", () => {
    expect(route(input({ recipients: [recipient("person-1", [LIFE_SAFETY], [])] }))).toEqual([]);
  });

  it("ends a lower level at the start of a higher level, and cancels its deliveries", () => {
    const routes = route(input({ starts: [start("urgent", T0)], merge: { deliveries: [delivery("urgent", 0, T0)] }, now: T0 + 10 * MINUTE }));
    expect(summary(routes)).toEqual([
      { level: "urgent", state: "ended", fresh: false, sends: [], cancels: [delivery("urgent", 0, T0).key] },
      { level: "life-safety", state: "sent", fresh: true, sends: [0], cancels: [] },
    ]);
  });

  it("does not go down: a higher level of the log continues when the assessed level is lower", () => {
    const routes = route(input({ incidents: [incident(WATCH)], starts: [start("life-safety", T0)], merge: { deliveries: [delivery("life-safety", 0, T0)] }, now: T0 + 6 * MINUTE }));
    expect(summary(routes)).toEqual([{ level: "life-safety", state: "last", fresh: false, sends: [1], cancels: [] }]);
  });

  it("polls each open delivery of a channel that polls, until the acknowledgment", () => {
    const sent = [delivery("life-safety", 0, T0), delivery("life-safety", 1, T0 + 5 * MINUTE, { channel: sms })];
    const open = route(input({ starts: [start("life-safety", T0)], merge: { deliveries: sent }, now: T0 + 6 * MINUTE }));
    expect(open[0]!.polls).toEqual([sent[0]]);
    const cancelled = route(input({ starts: [start("life-safety", T0)], merge: { deliveries: sent }, cancelled: new Set([sent[0]!.key]), now: T0 + 6 * MINUTE }));
    expect(cancelled[0]!.polls).toEqual([]);

    const acknowledged: Acknowledgment = { incident: merged, level: "life-safety", person, at: T0 + 2 * MINUTE, via: pushover };
    const after = route(input({ starts: [start("life-safety", T0)], merge: { deliveries: sent, acks: [acknowledged] }, now: T0 + 6 * MINUTE }));
    expect(summary(after)).toEqual([{ level: "life-safety", state: "acknowledged", fresh: false, sends: [], cancels: sent.map((d) => d.key) }]);
    expect(after[0]!.polls).toEqual([]);
  });

  it("cancels the deliveries of an incident that is over, and then gives it no route", () => {
    const sent = [delivery("life-safety", 0, T0)];
    const over = incident({ live: false, expires: T0 + MINUTE });
    const routes = route(input({ incidents: [over], starts: [start("life-safety", T0)], merge: { deliveries: sent }, now: T0 + 3 * MINUTE }));
    expect(summary(routes)).toEqual([{ level: "life-safety", state: "ended", fresh: false, sends: [], cancels: [sent[0]!.key] }]);
    expect(route(input({ incidents: [over], starts: [start("life-safety", T0)], merge: { deliveries: sent }, cancelled: new Set([sent[0]!.key]), now: T0 + 3 * MINUTE }))).toEqual([]);
    expect(route(input({ incidents: [over] }))).toEqual([]);
  });

  it("gives the same routes for each order of the incidents and the recipients", () => {
    const second = incident({ anchor: "c".repeat(64) as ReportId, reports: ["c".repeat(64) as ReportId] });
    const people = [recipient("person-1"), recipient("person-2")];
    const a = route(input({ incidents: [incident(), second], recipients: people }));
    const b = route(input({ incidents: [second, incident()], recipients: [...people].reverse() }));
    expect(b).toEqual(a);
    expect(a.map((entry) => [entry.incident.anchor[0], entry.person])).toEqual([
      ["a", "person-1"],
      ["a", "person-2"],
      ["c", "person-1"],
      ["c", "person-2"],
    ]);
  });

  it("holds its laws over seeded histories of an incident", () => {
    for (const seed of SEEDS) {
      const r = random(`route:${seed}`);
      const starts: EscalationStart[] = [];
      const deliveries: Delivery[] = [];
      const acks: Acknowledgment[] = [];
      const cancelled = new Set<string>();
      let phase: "warning" | "watch" | "over" = "watch";
      let top = -1;
      let acknowledgedAt: number | undefined;
      for (let step = 0; step < 60; step += 1) {
        const now = T0 + step * MINUTE;
        if (r.chance(0.15)) phase = r.pick(["warning", "watch", "over"] as const);
        const current = phase === "over" ? incident({ live: false, expires: now }) : incident(phase === "warning" ? WARNING : WATCH);
        const routes = route(input({ incidents: [current], merge: { deliveries, acks }, starts, cancelled, now }));
        const context = `seed ${seed}, minute ${step}`;

        // Only the highest level continues, and the level does not go down.
        const open = routes.filter((entry) => entry.plan.state !== "acknowledged" && entry.plan.state !== "ended");
        expect(open.length, context).toBeLessThanOrEqual(1);
        const levels = routes.map((entry) => LEVELS.indexOf(entry.policy.level));
        const highest = Math.max(-1, ...levels);
        expect(highest, context).toBeGreaterThanOrEqual(phase === "over" ? -1 : top);
        if (routes.length > 0) top = Math.max(top, highest);
        for (const entry of routes) {
          if (LEVELS.indexOf(entry.policy.level) < highest) expect(entry.plan.sends, context).toEqual([]);
          // A new start is at the highest level only.
          if (entry.fresh) expect(LEVELS.indexOf(entry.policy.level), context).toBe(highest);
          // A start of the log does not move.
          const logged = starts.find((item) => item.level === entry.policy.level);
          if (logged !== undefined) expect(entry.start.at, context).toBe(logged.at);
          // An escalation that is over cancels each delivery with no cancel.
          if (entry.plan.state === "acknowledged" || entry.plan.state === "ended") {
            expect(new Set(entry.plan.cancels.map((d) => d.key)), context).toEqual(new Set(entry.deliveries.filter((d) => !cancelled.has(d.key)).map((d) => d.key)));
          }
        }
        // An acknowledgment of the highest level stops each send.
        if (acknowledgedAt !== undefined) expect(routes.flatMap((entry) => entry.plan.sends), context).toEqual([]);

        // The runtime: it writes the new starts, sends with some failures, cancels, and the person acknowledges at times.
        for (const entry of routes) {
          if (entry.fresh) starts.push(entry.start);
          for (const send of entry.plan.sends) {
            if (r.chance(0.2)) continue;
            deliveries.push({ key: messageKey(send), incident: send.incident, level: send.level, person: send.person, channel: send.channel, step: send.step, at: now, receipt: { receipt: `${send.level}:${send.step}` } });
          }
          for (const done of entry.plan.cancels) cancelled.add(done.key);
          const ours = entry.deliveries.length > 0 && LEVELS.indexOf(entry.policy.level) === LEVELS.length - 1;
          if (ours && acknowledgedAt === undefined && r.chance(0.1)) {
            acknowledgedAt = now;
            acks.push({ incident: anchor, level: entry.policy.level, person, at: now, via: pushover });
          }
        }
      }
      expect(starts.length, `seed ${seed}`).toBeGreaterThan(0);
    }
  });
});

describe("route: the rank delay of each level", () => {
  const DELAY = 30_000;
  // The routes of the copies of rank 0 and rank 1, with the same merge state and the table of the private configuration.
  const copies = (extra: Partial<RouteInput> = {}): Route[][] => [0, 1].map((rank) => route(input({ rank, rankDelay: DELAY, rankDelays: { "life-safety": 0 }, ...extra })));
  const sends = (routes: readonly Route[]) => routes.map((entry) => entry.plan.sends.map((send) => ({ step: send.step, due: send.due, wait: send.wait })));

  it("gives two sends at the same time from two copies for one life-safety incident", () => {
    const [first, second] = copies();
    expect(sends(first!)).toEqual([[{ step: 0, due: T0, wait: 0 }]]);
    expect(sends(second!)).toEqual(sends(first!));
  });

  it("gives one send at a lower level: the copy of rank 1 waits the default, and then the delivery of rank 0 holds it", () => {
    const [first, second] = copies({ incidents: [incident(WATCH)] });
    expect(sends(first!)).toEqual([[{ step: 0, due: T0, wait: 0 }]]);
    expect(sends(second!)).toEqual([[]]);
    expect(second![0]!.plan.wakeAt).toBe(T0 + DELAY);
    const later = route(input({ incidents: [incident(WATCH)], rank: 1, rankDelay: DELAY, rankDelays: { "life-safety": 0 }, starts: [start("urgent", T0)], merge: { deliveries: [delivery("urgent", 0, T0 + 500)] }, now: T0 + DELAY }));
    expect(sends(later)).toEqual([[]]);
  });

  it("gives the default to a level with no entry, and the entry to a level with one", () => {
    const table = { urgent: 5_000 };
    expect(route(input({ incidents: [incident(WATCH)], rank: 2, rankDelay: DELAY, rankDelays: table }))[0]!.plan.wakeAt).toBe(T0 + 10_000);
    const lifeSafety = route(input({ rank: 2, rankDelay: DELAY, rankDelays: table, now: T0 + 2 * DELAY, starts: [start("life-safety", T0)] }));
    expect(sends(lifeSafety)).toEqual([[{ step: 0, due: T0 + 2 * DELAY, wait: 2 * DELAY }]]);
  });

  it("gives the plain default to each level with no table", () => {
    const [, second] = copies({ rankDelays: undefined });
    expect(sends(second!)).toEqual([[]]);
    expect(second![0]!.plan.wakeAt).toBe(T0 + DELAY);
  });
});

describe("route: copies of two builds (AL-76)", () => {
  // The copy of the burst of 2026-11-18 ran an older build. Its deliveries of a level that the own assessment of this
  // copy does not give reach this copy through the exchange. This copy has no start of that level.
  const shared = delivery("life-safety", 0, T0);
  const imported = (routes: readonly Route[]) => routes.map((entry) => entry.imported === true);

  it("opens no send at a level that only a delivery of another copy gives, above the own assessment", () => {
    // The own assessment of the watch is `urgent`. The other copy sent step 0 at `life-safety`.
    const routes = route(input({ incidents: [incident(WATCH)], merge: { deliveries: [shared] }, now: T0 + 6 * MINUTE }));
    expect(summary(routes).map(({ level, fresh, sends }) => ({ level, fresh, sends }))).toEqual([{ level: "life-safety", fresh: false, sends: [] }]);
    expect(imported(routes)).toEqual([true]);
    // The shared level holds the top: the lower own level starts nothing. The poll of the receipt stays.
    expect(routes[0]!.polls).toEqual([shared]);
  });

  it("takes no level from another copy for a kind that the own policy keeps in the digest", () => {
    // The shape of the burst: a transit alert, which the own build gives the digest at most, and an urgent delivery of the other copy.
    const transit = incident({ kind: { code: "transport.transit", label: "Transit" }, severity: "moderate", urgency: "immediate" });
    const urgent = delivery("urgent", 0, T0);
    const routes = route(input({ incidents: [transit], merge: { deliveries: [urgent] }, now: T0 + MINUTE }));
    expect(summary(routes).map(({ level, fresh, sends }) => ({ level, fresh, sends }))).toEqual([{ level: "urgent", fresh: false, sends: [] }]);
    expect(imported(routes)).toEqual([true]);
    expect(exhaustions(routes.map((entry) => ({ ...entry, plan: { ...entry.plan, state: "exhausted" as const, exhaustedAt: T0 } })), CHANNELS, [])).toEqual([]);
  });

  it("follows a delivery of another copy at a level that the own assessment gives", () => {
    const routes = route(input({ merge: { deliveries: [shared] }, now: T0 + 6 * MINUTE }));
    expect(summary(routes).map(({ level, fresh, sends }) => ({ level, fresh, sends }))).toEqual([{ level: "life-safety", fresh: true, sends: [1] }]);
    expect(imported(routes)).toEqual([false]);
  });

  it("continues its own level when the assessment goes down: a start of this copy is its own decision", () => {
    const routes = route(input({ incidents: [incident(WATCH)], starts: [start("life-safety", T0)], merge: { deliveries: [shared] }, now: T0 + 6 * MINUTE }));
    expect(summary(routes).map(({ level, sends }) => ({ level, sends }))).toEqual([{ level: "life-safety", sends: [1] }]);
    expect(imported(routes)).toEqual([false]);
  });

  it("sends when a later own assessment is above the shared level", () => {
    const urgent = delivery("urgent", 0, T0);
    const routes = route(input({ merge: { deliveries: [urgent] }, now: T0 + MINUTE }));
    const top = routes.find((entry) => entry.policy.level === "life-safety");
    expect(top?.plan.sends.map((send) => send.step)).toEqual([0]);
    expect(imported(routes)).toEqual([false, false]);
  });

  it("still ends the shared level at the end of the incident, and when the live incident no longer reaches the person", () => {
    const over = incident({ live: false, expires: T0 + MINUTE });
    const ended = route(input({ incidents: [over], merge: { deliveries: [shared] }, now: T0 + 3 * MINUTE }));
    expect(summary(ended)).toEqual([{ level: "life-safety", state: "ended", fresh: true, sends: [], cancels: [shared.key] }]);
    // Harvey County, Kansas: the incident moved away from the place of the person. The route ends the episode at `now`.
    const away = incident({ areas: [{ type: "code", system: "ugc", code: "KSC079" }] });
    const gone = route(input({ incidents: [away], merge: { deliveries: [shared] }, now: T0 + 3 * MINUTE }));
    expect(summary(gone)).toEqual([{ level: "life-safety", state: "ended", fresh: false, sends: [], cancels: [shared.key] }]);
    expect(gone[0]!.freshEnd).toBe(true);
    expect(imported(gone)).toEqual([true]);
  });

  // A river flood has no class: the table of the other kinds gives it `urgent` at most.
  const flood = incident({ kind: { code: "met.flood.river", label: "River flood" }, severity: "severe", urgency: "expected" });
  const fromOther = [report(anchor, { source: "source-2" as Report["source"] }), report(merged, { source: "source-2" as Report["source"] })];
  const levelsOf = (extra: Partial<RouteInput> & { readonly merge?: Partial<MergeState> }) => route(input(extra)).map((entry) => entry.policy.level);

  it("gives the quiet table to a kind with no class when each report comes from a source of another copy", () => {
    expect(levelsOf({ incidents: [flood], merge: { reports: fromOther } })).toEqual(["urgent"]);
    expect(levelsOf({ incidents: [flood], merge: { reports: fromOther }, sources: new Set(["nws-api"]) })).toEqual([]);
    expect(levelsOf({ incidents: [flood], merge: { reports: fromOther }, sources: new Set(["nws-api", "source-2"]) })).toEqual(["urgent"]);
  });

  it("states the one worse case: the other copy shares a report of its own source and stops before its send", () => {
    // This copy runs no source of the flood, and the other copy sent nothing. Thus no escalation starts here, and the digest tells the flood.
    expect(route(input({ incidents: [flood], merge: { reports: fromOther, deliveries: [] }, sources: new Set(["nws-api"]), now: T0 + 60 * MINUTE }))).toEqual([]);
  });

  it("keeps the table of the other kinds when one report of the incident comes from a source of this copy", () => {
    const mixed = [report(anchor), report(merged, { source: "source-2" as Report["source"] })];
    expect(levelsOf({ incidents: [flood], merge: { reports: mixed }, sources: new Set(["nws-api"]) })).toEqual(["urgent"]);
    // A report with no known source counts as a report of this copy.
    expect(levelsOf({ incidents: [flood], merge: { reports: [] }, sources: new Set(["nws-api"]) })).toEqual(["urgent"]);
  });

  it("keeps the table of the class of a kind from a source of another copy", () => {
    const tornado = [report(anchor, { source: "source-2" as Report["source"] }), report(merged, { source: "source-2" as Report["source"] })];
    const routes = route(input({ merge: { reports: tornado }, sources: new Set(["nws-api"]) }));
    expect(summary(routes)).toEqual([{ level: "life-safety", state: "sent", fresh: true, sends: [0], cancels: [] }]);
  });
});

describe("rankDelayProblems", () => {
  it("accepts 0 and whole milliseconds up to the limit, and names each level with another value", () => {
    expect(rankDelayProblems({ "life-safety": 0, urgent: RANK_DELAY_LIMIT })).toEqual([]);
    expect(rankDelayProblems({ notice: 1.5, digest: RANK_DELAY_LIMIT + 1 })).toEqual([
      `The rank delay of the level notice is not a whole number of milliseconds from 0 to ${RANK_DELAY_LIMIT}.`,
      `The rank delay of the level digest is not a whole number of milliseconds from 0 to ${RANK_DELAY_LIMIT}.`,
    ]);
  });
});

describe("route: the end of a person and a new episode", () => {
  // A public county in Kansas that the person does not watch.
  const away = incident({ areas: [{ type: "code", system: "ugc", code: "KSC079" }] });
  const first = delivery("life-safety", 0, T0);
  const endAt = (at: number): EscalationEnd => ({ incident: anchor, person, at });
  const keyOf = (level: Level, step: number, episode: number): string => messageKey({ incident: anchor, level, person, step, episode });
  const ack = (at: number): Acknowledgment => ({ incident: anchor, level: "life-safety", person, at, via: pushover });

  it("ends the escalation when the live incident no longer reaches the person, and cancels its deliveries", () => {
    const routes = route(input({ incidents: [away], starts: [start("life-safety", T0)], merge: { deliveries: [first] }, now: T0 + 2 * MINUTE }));
    expect(summary(routes)).toEqual([{ level: "life-safety", state: "ended", fresh: false, sends: [], cancels: [first.key] }]);
    expect(routes[0]!.freshEnd).toBe(true);
    expect(routes[0]!.end).toEqual(endAt(T0 + 2 * MINUTE));
    expect(routes[0]!.episode).toBe(0);
  });

  it("gives no end to a person with no escalation, and none while a lower level still reaches the person", () => {
    expect(route(input({ incidents: [away] }))).toEqual([]);
    const kept = route(input({ incidents: [incident(WATCH)], starts: [start("life-safety", T0)], merge: { deliveries: [first] }, now: T0 + 2 * MINUTE }));
    expect(kept.map((entry) => [entry.policy.level, entry.plan.state, entry.freshEnd, entry.end])).toEqual([["life-safety", "sent", false, undefined]]);
  });

  it("cancels again the deliveries of an earlier episode with no cancel, and then routes nothing", () => {
    const ends = [endAt(T0 + 2 * MINUTE)];
    const retry = route(input({ incidents: [away], starts: [start("life-safety", T0)], ends, merge: { deliveries: [first] }, now: T0 + 3 * MINUTE }));
    expect(summary(retry)).toEqual([{ level: "life-safety", state: "ended", fresh: false, sends: [], cancels: [first.key] }]);
    expect([retry[0]!.freshEnd, retry[0]!.end]).toEqual([false, ends[0]]);
    const done = route(input({ incidents: [away], starts: [start("life-safety", T0)], ends, merge: { deliveries: [first] }, cancelled: new Set([first.key]), now: T0 + 4 * MINUTE }));
    expect(done).toEqual([]);
  });

  it("starts a new episode with new keys when the threat comes back, and an acknowledgment before its start covers nothing", () => {
    const ends = [endAt(T0 + 2 * MINUTE)];
    const cancelled = new Set([first.key]);
    // One acknowledgment of the first episode, and one between the end and the return.
    const acks = [ack(T0 + MINUTE), ack(T0 + 5 * MINUTE)];
    const back = route(input({ starts: [start("life-safety", T0)], ends, merge: { deliveries: [first], acks }, cancelled, now: T0 + 10 * MINUTE }));
    expect(summary(back)).toEqual([{ level: "life-safety", state: "sent", fresh: true, sends: [0], cancels: [] }]);
    expect([back[0]!.episode, back[0]!.start, back[0]!.end]).toEqual([1, start("life-safety", T0 + 10 * MINUTE), undefined]);
    const send = back[0]!.plan.sends[0]!;
    expect(send.episode).toBe(1);
    expect(messageKey(send)).toBe(keyOf("life-safety", 0, 1));
    expect(messageKey(send)).not.toBe(first.key);
  });

  it("starts a new episode at a lower level than the level of the earlier episode", () => {
    const back = route(input({ incidents: [incident(WATCH)], starts: [start("life-safety", T0)], ends: [endAt(T0 + 2 * MINUTE)], merge: { deliveries: [first] }, cancelled: new Set([first.key]), now: T0 + 10 * MINUTE }));
    expect(summary(back)).toEqual([{ level: "urgent", state: "last", fresh: true, sends: [0], cancels: [] }]);
    expect(back[0]!.episode).toBe(1);
  });

  it("ends a new episode by an acknowledgment after its start", () => {
    const again = delivery("life-safety", 0, T0 + 10 * MINUTE, { key: keyOf("life-safety", 0, 1) });
    const routes = route(
      input({
        starts: [start("life-safety", T0), start("life-safety", T0 + 10 * MINUTE)],
        ends: [endAt(T0 + 2 * MINUTE)],
        merge: { deliveries: [first, again], acks: [ack(T0 + 11 * MINUTE)] },
        cancelled: new Set([first.key]),
        now: T0 + 12 * MINUTE,
      }),
    );
    expect(routes.map((entry) => [entry.episode, entry.plan.state, entry.fresh, entry.plan.cancels.map((d) => d.key)])).toEqual([[1, "acknowledged", false, [again.key]]]);
  });

  it("starts a new episode after its end, also when the clock has not moved past the end", () => {
    const at = T0 + 2 * MINUTE;
    const routes = route(input({ starts: [start("life-safety", T0)], ends: [endAt(at)], merge: { deliveries: [first] }, cancelled: new Set([first.key]), now: at }));
    expect(routes.map((entry) => [entry.episode, entry.fresh, entry.start.at, entry.plan.sends.length, entry.plan.wakeAt])).toEqual([[1, true, at + 1, 0, at + 1]]);
  });

  it("holds its laws over seeded histories where the threat leaves and comes back", () => {
    let returns = 0;
    for (const seed of SEEDS) {
      const r = random(`route-episodes:${seed}`);
      const starts: EscalationStart[] = [];
      const ends: EscalationEnd[] = [];
      const deliveries: Delivery[] = [];
      const acks: Acknowledgment[] = [];
      const cancelled = new Set<string>();
      let phase: "warning" | "watch" | "away" = "warning";
      for (let step = 0; step < 90; step += 1) {
        const now = T0 + step * MINUTE;
        if (r.chance(0.15)) phase = r.pick(["warning", "watch", "away"] as const);
        const current = phase === "away" ? away : incident(phase === "warning" ? WARNING : WATCH);
        const routes = route(input({ incidents: [current], merge: { deliveries, acks }, starts, ends, cancelled, now }));
        const context = `seed ${seed}, minute ${step}`;

        for (const entry of routes) {
          // Each send has the episode of its escalation.
          for (const send of entry.plan.sends) expect(send.episode ?? 0, context).toBe(entry.episode);
          if (entry.episode < ends.length) {
            // An earlier episode sends nothing, and it cancels each of its deliveries with no cancel.
            expect(entry.plan.sends, context).toEqual([]);
            expect(["ended", "acknowledged"], context).toContain(entry.plan.state);
            expect(entry.end, context).toEqual(ends[entry.episode]);
          }
          // A new escalation sends its first step at once.
          if (entry.fresh) expect(entry.plan.sends.map((send) => send.step), context).toContain(0);
          if (entry.fresh && entry.episode > 0) returns += 1;
        }
        // While the threat is away, nothing sends, and each escalation of the current episode ends now.
        if (phase === "away") {
          expect(routes.flatMap((entry) => entry.plan.sends), context).toEqual([]);
          for (const entry of routes.filter((item) => item.episode === ends.length)) {
            expect([entry.freshEnd, entry.end?.at], context).toEqual([true, now]);
            expect(["ended", "acknowledged"], context).toContain(entry.plan.state);
          }
        } else {
          expect(routes.filter((entry) => entry.freshEnd), context).toEqual([]);
        }

        // The runtime: it writes the new starts and the new end, sends with some failures, cancels, and the person acknowledges at times.
        for (const entry of routes) {
          if (entry.fresh) starts.push(entry.start);
          for (const send of entry.plan.sends) {
            if (r.chance(0.2)) continue;
            deliveries.push({ key: messageKey(send), incident: send.incident, level: send.level, person: send.person, channel: send.channel, step: send.step, at: now, receipt: { receipt: `${send.level}:${send.step}` } });
          }
          for (const done of entry.plan.cancels) if (r.chance(0.8)) cancelled.add(done.key);
          if (entry.episode === ends.length && entry.deliveries.length > 0 && r.chance(0.05)) acks.push({ incident: anchor, level: entry.policy.level, person, at: now, via: pushover });
        }
        const ending = routes.find((entry) => entry.freshEnd)?.end;
        if (ending !== undefined) ends.push(ending);
      }
      // No key goes out two times: each episode gets new keys.
      expect(new Set(deliveries.map((item) => item.key)).size, `seed ${seed}`).toBe(deliveries.length);
    }
    expect(returns).toBeGreaterThan(0);
  });
});

describe("route: a mute of the person (AL-35)", () => {
  // A public county in Kansas that the person does not watch.
  const away = incident({ areas: [{ type: "code", system: "ugc", code: "KSC079" }] });
  const first = delivery("life-safety", 0, T0);
  const endAt = (at: number, reason?: "muted"): EscalationEnd => ({ incident: anchor, person, at, ...(reason === undefined ? {} : { reason }) });
  const silentStart = (level: Level, at: number): EscalationStart => ({ ...start(level, at), silent: true });
  const keyOf = (level: Level, step: number, episode: number): string => messageKey({ incident: anchor, level, person, step, episode });
  const ack = (at: number): Acknowledgment => ({ incident: anchor, level: "life-safety", person, at, via: pushover });
  const mute = (effect: MuteEffect | undefined): void => {
    mutes.effect = effect;
  };
  const sends = (routes: readonly Route[]) => routes.flatMap((entry) => entry.plan.sends.map((send) => ({ episode: entry.episode, level: send.level, step: send.step, quiet: send.quiet })));

  beforeEach(() => mute(undefined));

  it("gives one quiet step 0 under a mute that was there before the incident, also at life-safety, and no exhaustion", () => {
    mute("silent");
    const routes = route(input());
    expect(sends(routes)).toEqual([{ episode: 0, level: "life-safety", step: 0, quiet: true }]);
    expect([routes[0]!.fresh, routes[0]!.start]).toEqual([true, silentStart("life-safety", T0)]);
    // Later, the policy has a step at 5 minutes and an exhaustion at 25 minutes. The silent mode sends no more and does not exhaust.
    const later = route(input({ starts: [silentStart("life-safety", T0)], merge: { deliveries: [first] }, now: T0 + 40 * MINUTE }));
    expect(summary(later)).toEqual([{ level: "life-safety", state: "last", fresh: false, sends: [], cancels: [] }]);
    expect([later[0]!.plan.exhaustedAt, later[0]!.plan.wakeAt, later[0]!.freshEnd]).toEqual([undefined, undefined, false]);
  });

  it("ends a loud episode at a silent mute with the reason muted, cancels its repeats, and sends no copy", () => {
    mute("silent");
    const at = T0 + 2 * MINUTE;
    const routes = route(input({ starts: [start("life-safety", T0)], merge: { deliveries: [first] }, now: at }));
    expect(routes.map((entry) => [entry.episode, entry.plan.state, entry.freshEnd, entry.fresh, entry.plan.cancels.map((item) => item.key)])).toEqual([
      [0, "ended", true, false, [first.key]],
      [1, "idle", false, true, []],
    ]);
    expect(routes[0]!.end).toEqual(endAt(at, "muted"));
    // The next episode starts at once in the silent mode. The person has a delivery of the incident, thus it sends nothing.
    expect(routes[1]!.start).toEqual(silentStart("life-safety", at + 1));
    expect(sends(routes)).toEqual([]);
    const later = route(
      input({ starts: [start("life-safety", T0), silentStart("life-safety", at + 1)], ends: [endAt(at, "muted")], merge: { deliveries: [first] }, cancelled: new Set([first.key]), now: T0 + 30 * MINUTE }),
    );
    expect(summary(later)).toEqual([{ level: "life-safety", state: "idle", fresh: false, sends: [], cancels: [] }]);
  });

  it("starts a loud episode at once with new keys when a silent mute ends with no acknowledgment", () => {
    const at = T0 + 3 * MINUTE;
    const routes = route(input({ starts: [silentStart("life-safety", T0)], merge: { deliveries: [first] }, now: at }));
    expect(routes.map((entry) => [entry.episode, entry.plan.state, entry.freshEnd, entry.fresh, entry.plan.wakeAt])).toEqual([
      [0, "ended", true, false, undefined],
      [1, "idle", false, true, at + 1],
    ]);
    expect([routes[0]!.end, routes[1]!.start]).toEqual([endAt(at, "muted"), start("life-safety", at + 1)]);
    const loud = route(input({ starts: [silentStart("life-safety", T0), start("life-safety", at + 1)], ends: [endAt(at, "muted")], merge: { deliveries: [first] }, cancelled: new Set([first.key]), now: at + MINUTE }));
    expect(sends(loud)).toEqual([{ episode: 1, level: "life-safety", step: 0, quiet: false }]);
    expect(messageKey(loud[0]!.plan.sends[0]!)).toBe(keyOf("life-safety", 0, 1));
  });

  it("gives the loud episode after a mute the rules of the quiet window, as any new start", () => {
    // T0 is 13:00 in Chicago, in the quiet window of the person. A mute that expires and a mute that the person removes
    // are the same to route(): no mute at now. So one case holds both.
    const base = recipient();
    const night: Recipient = { ...base, watch: { ...base.watch, quiet: { zone: "America/Chicago", start: "12:00", end: "15:00" } } };
    const at = T0 + 3 * MINUTE;
    for (const [fields, level, quiet] of [
      [WATCH, "urgent", true],
      [WARNING, "life-safety", false],
    ] as const) {
      const muted = delivery(level, 0, T0);
      const ended = route(input({ incidents: [incident(fields)], recipients: [night], starts: [silentStart(level, T0)], merge: { deliveries: [muted] }, now: at }));
      expect(
        ended.map((entry) => [entry.policy.level, entry.episode, entry.freshEnd, entry.fresh, entry.end?.reason]),
        level,
      ).toEqual([
        [level, 0, true, false, "muted"],
        [level, 1, false, true, undefined],
      ]);
      const loud = route(
        input({ incidents: [incident(fields)], recipients: [night], starts: [silentStart(level, T0), start(level, at + 1)], ends: [endAt(at, "muted")], merge: { deliveries: [muted] }, cancelled: new Set([muted.key]), now: at + MINUTE }),
      );
      // Below life-safety, the new episode sends quiet in the window. At life-safety, it sends loud.
      expect(sends(loud), level).toEqual([{ episode: 1, level, step: 0, quiet }]);
    }
  });

  it("does not alert again after an acknowledgment when a mute starts and ends", () => {
    // The person acknowledged the loud alert, then muted it, then ended the mute.
    const muteAt = T0 + 2 * MINUTE;
    const routes = route(
      input({
        starts: [start("life-safety", T0), silentStart("life-safety", muteAt + 1)],
        ends: [endAt(muteAt, "muted")],
        merge: { deliveries: [first], acks: [ack(T0 + MINUTE)] },
        cancelled: new Set([first.key]),
        now: T0 + 5 * MINUTE,
      }),
    );
    expect(routes.map((entry) => [entry.episode, entry.plan.state, entry.fresh, entry.freshEnd])).toEqual([
      [1, "acknowledged", false, true],
      [2, "acknowledged", true, false],
    ]);
    expect(sends(routes)).toEqual([]);
  });

  it("ends the escalation at a mute with the effect absent, and alerts again with new keys when the mute ends", () => {
    mute("absent");
    const at = T0 + 2 * MINUTE;
    const routes = route(input({ starts: [start("life-safety", T0)], merge: { deliveries: [first] }, now: at }));
    expect(summary(routes)).toEqual([{ level: "life-safety", state: "ended", fresh: false, sends: [], cancels: [first.key] }]);
    expect([routes[0]!.freshEnd, routes[0]!.end]).toEqual([true, endAt(at, "muted")]);
    mute(undefined);
    const back = route(input({ starts: [start("life-safety", T0)], ends: [endAt(at, "muted")], merge: { deliveries: [first] }, cancelled: new Set([first.key]), now: T0 + 10 * MINUTE }));
    expect(sends(back)).toEqual([{ episode: 1, level: "life-safety", step: 0, quiet: false }]);
  });

  it("gives an end with no reason when the threat leaves, also under a silent mute", () => {
    mute("silent");
    const routes = route(input({ incidents: [away], starts: [silentStart("life-safety", T0)], merge: { deliveries: [first] }, now: T0 + 2 * MINUTE }));
    expect([routes[0]!.freshEnd, routes[0]!.end]).toEqual([true, endAt(T0 + 2 * MINUTE)]);
  });

  it("sends nothing for a higher level of a silent episode after the quiet message of a lower level", () => {
    mute("silent");
    const watch = delivery("urgent", 0, T0);
    const routes = route(input({ starts: [silentStart("urgent", T0)], merge: { deliveries: [watch] }, now: T0 + 5 * MINUTE }));
    expect(summary(routes)).toEqual([
      { level: "urgent", state: "ended", fresh: false, sends: [], cancels: [watch.key] },
      { level: "life-safety", state: "idle", fresh: true, sends: [], cancels: [] },
    ]);
    expect(routes[1]!.start).toEqual(silentStart("life-safety", T0 + 5 * MINUTE));
  });

  it("holds its laws over seeded histories of mutes, returns and acknowledgments", () => {
    const counts = { silentSends: 0, modeEnds: 0, quietAfterAck: 0 };
    for (const seed of SEEDS) {
      const r = random(`route-mutes:${seed}`);
      const starts: EscalationStart[] = [];
      const ends: EscalationEnd[] = [];
      const deliveries: Delivery[] = [];
      const acks: Acknowledgment[] = [];
      const cancelled = new Set<string>();
      let phase: "loud" | "silent" | "absent" | "away" = "loud";
      // The highest level that the person acknowledged since the last end `ended`, or -1.
      let acked = -1;
      for (let step = 0; step < 120; step += 1) {
        const now = T0 + step * MINUTE;
        if (r.chance(0.12)) phase = r.pick(["loud", "silent", "absent", "away"] as const);
        mute(phase === "silent" ? "silent" : phase === "absent" ? "absent" : undefined);
        const current = phase === "away" ? away : incident(r.chance(0.5) ? WARNING : WATCH);
        const routes = route(input({ incidents: [current], merge: { deliveries, acks }, starts, ends, cancelled, now }));
        const context = `seed ${seed}, minute ${step}, ${phase}`;
        const before = deliveries.length;
        for (const entry of routes) {
          for (const send of entry.plan.sends) {
            // A silent episode sends one quiet step 0, and only when the person has no delivery of the incident.
            if (entry.start.silent === true) {
              expect([send.step, send.quiet, before], context).toEqual([0, true, 0]);
              counts.silentSends += 1;
            }
            // An acknowledgment covers its level and each lower level until the threat leaves. A change of a mute does not alert again.
            expect(LEVELS.indexOf(send.level) > acked, context).toBe(true);
          }
          if (entry.freshEnd) {
            // An end of a mute has the reason muted. An end of a threat that left has no reason.
            expect(entry.end?.reason, context).toBe(phase === "away" ? undefined : "muted");
            if (entry.end?.reason === "muted") counts.modeEnds += 1;
          }
          // An escalation that starts at `now` in the loud mode sends its first step at once.
          if (entry.fresh && entry.start.silent !== true && entry.start.at <= now && entry.plan.state !== "acknowledged") {
            expect(entry.plan.sends.map((send) => send.step), context).toContain(0);
          }
        }
        // Nothing sends while the threat is away or under a mute with the effect absent.
        if (phase === "away" || phase === "absent") expect(routes.flatMap((entry) => entry.plan.sends), context).toEqual([]);

        // The runtime: it writes the new starts and the new ends, sends with some failures, cancels, and the person acknowledges at times.
        for (const entry of routes) {
          if (entry.fresh) starts.push(entry.start);
          for (const send of entry.plan.sends) {
            if (r.chance(0.2)) continue;
            deliveries.push({ key: messageKey(send), incident: send.incident, level: send.level, person: send.person, channel: send.channel, step: send.step, at: now, receipt: { receipt: `${send.level}:${send.step}` } });
          }
          for (const done of entry.plan.cancels) if (r.chance(0.8)) cancelled.add(done.key);
        }
        const ending = new Map<number, EscalationEnd>();
        for (const entry of routes) if (entry.freshEnd && entry.end !== undefined) ending.set(entry.episode, entry.end);
        for (const end of [...ending.values()]) {
          ends.push(end);
          if (end.reason === undefined) acked = -1;
        }
        const open = routes.find((entry) => entry.episode === ends.length && entry.deliveries.length > 0);
        if (open !== undefined && r.chance(0.08)) {
          acks.push({ incident: anchor, level: open.policy.level, person, at: now, via: pushover });
          acked = Math.max(acked, LEVELS.indexOf(open.policy.level));
          if (phase === "silent") counts.quietAfterAck += 1;
        }
      }
      // No key goes out two times: each episode gets new keys.
      expect(new Set(deliveries.map((item) => item.key)).size, `seed ${seed}`).toBe(deliveries.length);
    }
    // The histories reach each case of the laws.
    expect(counts.silentSends).toBeGreaterThan(0);
    expect(counts.modeEnds).toBeGreaterThan(0);
  });
});

describe("ruleSteps: the channel rules of a person (AL-43)", () => {
  const about = { system: DRILL_SUBJECT, id: "push-weekly" };
  const drillRun = incident({ status: "system", kind: { code: "system.drill.run", label: "Drill" }, about: [about], areas: [] });
  const only: ChannelRule = { kinds: ["system.drill.run"], about, keep: "only", channels: [pushover] };
  const except: ChannelRule = { kinds: ["system.drill"], about, keep: "except", channels: [pushover] };
  const none = { policy: LIFE_SAFETY, rules: [], dropped: [] };

  it("keeps only the steps on the channels of an only rule, and removes the steps of an except rule", () => {
    expect(ruleSteps(LIFE_SAFETY, [only], drillRun)).toEqual({ policy: { ...LIFE_SAFETY, steps: [LIFE_SAFETY.steps[0]] }, rules: [0], dropped: [1] });
    expect(ruleSteps(LIFE_SAFETY, [except], drillRun)).toEqual({ policy: { ...LIFE_SAFETY, steps: [LIFE_SAFETY.steps[1]] }, rules: [0], dropped: [0] });
    // Each rule that applies keeps a step. An only rule and an except rule on one channel keep no step.
    expect(ruleSteps(LIFE_SAFETY, [only, except], drillRun)).toEqual({ policy: { ...LIFE_SAFETY, steps: [] }, rules: [0, 1], dropped: [0, 1] });
  });

  it("applies a rule only to its kinds and its subject", () => {
    expect(ruleSteps(LIFE_SAFETY, [only], { ...drillRun, kind: { code: "system.drill.failed", label: "Failed drill" } })).toEqual(none);
    expect(ruleSteps(LIFE_SAFETY, [only], { ...drillRun, about: [{ system: DRILL_SUBJECT, id: "other" }] })).toEqual(none);
    // A rule with no subject applies to each incident of its kinds.
    const anyDrill: ChannelRule = { kinds: ["system.drill.run"], keep: "only", channels: [pushover] };
    expect(ruleSteps(LIFE_SAFETY, [anyDrill], { ...drillRun, about: [] }).dropped).toEqual([1]);
    expect(ruleSteps(LIFE_SAFETY, undefined, drillRun)).toEqual(none);
  });

  it("changes no step of an incident with the status actual, and applies to the statuses system, test and exercise", () => {
    const rule: ChannelRule = { kinds: ["met.tornado"], keep: "only", channels: [] };
    expect(ruleSteps(LIFE_SAFETY, [rule], incident())).toEqual(none);
    expect(RULED_STATUSES).toEqual(["system", "test", "exercise"]);
    for (const status of RULED_STATUSES) expect(ruleSteps(LIFE_SAFETY, [rule], incident({ status })).dropped).toEqual([0, 1]);
  });

  it("holds its laws over seeded rules and incidents", () => {
    const kinds = ["system.drill", "system.drill.run", "system.drill.failed", "met.tornado", "system"];
    const statuses = ["actual", "system", "test", "exercise"] as const;
    for (const seed of SEEDS) {
      const r = random(`rules:${seed}`);
      for (let round = 0; round < 50; round += 1) {
        const rules: ChannelRule[] = Array.from({ length: r.int(0, 3) }, () => ({
          kinds: r.sample(kinds, r.int(1, 2)),
          ...(r.chance(0.5) ? { about: { system: DRILL_SUBJECT, id: r.pick(["a", "b"]) } } : {}),
          keep: r.pick(["only", "except"] as const),
          channels: r.sample([pushover, sms], r.int(0, 2)),
        }));
        const code = r.pick(["system.drill.run", "system.drill.failed", "met.tornado", "system.health"]);
        const current = incident({ status: r.pick(statuses), kind: { code, label: code }, about: r.chance(0.5) ? [{ system: DRILL_SUBJECT, id: r.pick(["a", "b"]) }] : [] });
        const ruled = ruleSteps(LIFE_SAFETY, rules, current);
        const context = `seed ${seed}, round ${round}`;
        // A real warning keeps its policy as it is.
        if (current.status === "actual") expect(ruled, context).toEqual(none);
        // The kept steps and the dropped steps split the steps of the policy, in their order.
        expect(ruled.policy.steps, context).toEqual(LIFE_SAFETY.steps.filter((_, index) => !ruled.dropped.includes(index)));
        // Each rule that applies keeps each step that stays.
        for (const step of ruled.policy.steps) for (const index of ruled.rules) expect(rules[index]!.channels.includes(step.channel) === (rules[index]!.keep === "only"), context).toBe(true);
        // The order of the rules has no effect on the steps.
        expect(ruleSteps(LIFE_SAFETY, [...rules].reverse(), current).policy.steps, context).toEqual(ruled.policy.steps);
      }
    }
  });

  it("gives the plan with the kept steps, and tells the rules and the dropped steps in Route.ruled", () => {
    const watcher: Recipient = { ...recipient(), watch: { ...recipient().watch, subjects: [{ system: DRILL_SUBJECT }] }, channelRules: [only] };
    const view = (routes: readonly Route[]) => routes.map((entry) => ({ level: entry.policy.level, steps: entry.policy.steps, ruled: entry.ruled, sends: entry.plan.sends.map((send) => send.channel) }));
    expect(view(route(input({ incidents: [drillRun], recipients: [watcher] })))).toEqual([{ level: "life-safety", steps: [LIFE_SAFETY.steps[0]], ruled: { rules: [0], dropped: [1] }, sends: [pushover] }]);
    // With no rule that applies, the route has no field ruled.
    expect(route(input({ incidents: [drillRun], recipients: [{ ...watcher, channelRules: [except] }] }))[0]?.ruled).toEqual({ rules: [0], dropped: [0] });
    expect(route(input({ incidents: [drillRun], recipients: [{ ...watcher, channelRules: [] }] }))[0]?.ruled).toBeUndefined();
  });
});

describe("policyFor: the policy of a subject (AL-43)", () => {
  const about = { system: DRILL_SUBJECT, id: "push-weekly" };
  const drillRun = incident({ status: "system", kind: { code: "system.drill.run", label: "Drill" }, about: [about], areas: [] });
  const anyDrill: EscalationPolicy = { ...LIFE_SAFETY, about: { system: DRILL_SUBJECT }, steps: [{ channel: sms, at: 0 }] };
  const thisDrill: EscalationPolicy = { ...LIFE_SAFETY, about, steps: [{ channel: pushover, at: 0 }] };

  it("gives the first policy of the level whose subject matches, and else the policy with no subject", () => {
    expect(policyFor([LIFE_SAFETY, URGENT], "urgent", drillRun)).toBe(URGENT);
    expect(policyFor([LIFE_SAFETY, anyDrill], "life-safety", drillRun)).toBe(anyDrill);
    // When two policies of the level match the incident, the first one in the list applies.
    expect(policyFor([anyDrill, thisDrill, LIFE_SAFETY], "life-safety", drillRun)).toBe(anyDrill);
    expect(policyFor([thisDrill, anyDrill, LIFE_SAFETY], "life-safety", drillRun)).toBe(thisDrill);
    // A subject that does not match gives the policy with no subject. With no such policy, the level has no policy.
    expect(policyFor([thisDrill, LIFE_SAFETY], "life-safety", { ...drillRun, about: [{ system: DRILL_SUBJECT, id: "other" }] })).toBe(LIFE_SAFETY);
    expect(policyFor([thisDrill], "life-safety", { ...drillRun, about: [] })).toBeUndefined();
  });

  it("gives no policy with a subject to a real warning", () => {
    expect(policyFor([anyDrill, LIFE_SAFETY], "life-safety", { ...drillRun, status: "actual" })).toBe(LIFE_SAFETY);
    expect(policyFor([anyDrill], "life-safety", { ...drillRun, status: "actual" })).toBeUndefined();
    for (const status of RULED_STATUSES) expect(policyFor([LIFE_SAFETY, anyDrill], "life-safety", { ...drillRun, status })).toBe(anyDrill);
  });

  it("holds its laws over seeded lists of policies", () => {
    const statuses = ["actual", "system", "test", "exercise"] as const;
    for (const seed of SEEDS) {
      const r = random(`policies:${seed}`);
      for (let round = 0; round < 50; round += 1) {
        const policies: EscalationPolicy[] = Array.from({ length: r.int(0, 5) }, () => ({
          level: r.pick(["life-safety", "urgent", "notice"] as const),
          ...(r.chance(0.5) ? { about: { system: DRILL_SUBJECT, ...(r.chance(0.5) ? { id: r.pick(["a", "b"]) } : {}) } } : {}),
          steps: [{ channel: r.pick([pushover, sms]), at: 0 }],
          exhaustedAfter: MINUTE,
        }));
        const level = r.pick(["life-safety", "urgent", "notice"] as const);
        const current = incident({ status: r.pick(statuses), about: r.chance(0.5) ? [{ system: DRILL_SUBJECT, id: r.pick(["a", "b"]) }] : [] });
        const found = policyFor(policies, level, current);
        const context = `seed ${seed}, round ${round}`;
        const plain = policies.find((policy) => policy.level === level && policy.about === undefined);
        // The policy is of the level, and it is one of the list.
        if (found !== undefined) expect(found.level === level && policies.includes(found), context).toBe(true);
        // A real warning gets the first policy of the level with no subject.
        if (current.status === "actual") expect(found, context).toBe(plain);
        // A policy with a subject applies only when the subject matches the incident.
        if (found?.about !== undefined) expect(matchSubjects(current, [found.about]).length, context).toBeGreaterThan(0);
        // With no policy with a subject that matches, the policy with no subject applies.
        if (!policies.some((policy) => policy.level === level && policy.about !== undefined && matchSubjects(current, [policy.about]).length > 0)) expect(found, context).toBe(plain);
      }
    }
  });

  it("gives the route the policy of the subject, and the channel rules apply to it", () => {
    const watcher: Recipient = { ...recipient("person-1", [LIFE_SAFETY, anyDrill]), watch: { ...recipient().watch, subjects: [{ system: DRILL_SUBJECT }] } };
    const view = (routes: readonly Route[]) => routes.map((entry) => ({ about: entry.policy.about, sends: entry.plan.sends.map((send) => send.channel) }));
    expect(view(route(input({ incidents: [drillRun], recipients: [watcher] })))).toEqual([{ about: anyDrill.about, sends: [sms] }]);
    // A real warning at the place of the person gets the policy with no subject.
    expect(view(route(input({ incidents: [incident()], recipients: [watcher] })))).toEqual([{ about: undefined, sends: [pushover] }]);
    // A rule that keeps only the channel pushover removes the step of the policy of the subject.
    const only: ChannelRule = { kinds: ["system.drill.run"], about, keep: "only", channels: [pushover] };
    expect(route(input({ incidents: [drillRun], recipients: [{ ...watcher, channelRules: [only] }] }))[0]?.ruled).toEqual({ rules: [0], dropped: [0] });
  });

  it("finds two policies of one level and one subject, and a life-safety policy only with a subject", () => {
    expect(policyName(anyDrill)).toBe(`life-safety about ${DRILL_SUBJECT}`);
    expect(policyName(thisDrill)).toBe(`life-safety about ${DRILL_SUBJECT} push-weekly`);
    expect(recipientProblems(recipient("person-1", [LIFE_SAFETY, anyDrill, thisDrill]), CHANNELS)).toEqual([]);
    expect(recipientProblems(recipient("person-1", [LIFE_SAFETY, anyDrill, { ...anyDrill, steps: [{ channel: pushover, at: 0 }] }]), CHANNELS)).toEqual([
      `Two policies have the level life-safety about ${DRILL_SUBJECT}. Only the first one applies.`,
    ]);
    expect(recipientProblems(recipient("person-1", [anyDrill, URGENT]), CHANNELS)).toEqual([
      "The person watches a place or a subject, and has no policy of the level life-safety. A life-safety alert sends nothing to the person.",
    ]);
    const fax = "fax" as ChannelId;
    expect(recipientProblems(recipient("person-1", [LIFE_SAFETY, { ...thisDrill, steps: [{ channel: fax, at: 0 }] }]), CHANNELS)).toEqual([
      `Step 0 of life-safety about ${DRILL_SUBJECT} push-weekly uses the channel fax, and the system has no such channel.`,
      `Step 0 of life-safety about ${DRILL_SUBJECT} push-weekly uses the channel fax, and the person has no address on it.`,
    ]);
  });
});

describe("recipientProblems", () => {
  it("finds a repeated level, a channel that does not exist and a missing address", () => {
    const fax = "fax" as ChannelId;
    const broken: Recipient = {
      ...recipient("person-1", [LIFE_SAFETY, { level: "life-safety", steps: [{ channel: fax, at: 0 }], exhaustedAfter: 0 }]),
      addresses: { pushover: { user: "fake-user" } },
    };
    expect(recipientProblems(broken, CHANNELS)).toEqual([
      "Step 1 of life-safety uses the channel sms, and the person has no address on it.",
      "Two policies have the level life-safety. Only the first one applies.",
      "Step 0 of life-safety uses the channel fax, and the system has no such channel.",
      "Step 0 of life-safety uses the channel fax, and the person has no address on it.",
    ]);
    expect(recipientProblems(recipient(), CHANNELS)).toEqual([]);
  });

  it("finds a kind of a rule that the taxonomy does not have", () => {
    const base = recipient();
    const typo: Recipient = { ...base, watch: { ...base.watch, rules: [{ kinds: ["met", "met.tornado"], max: "life-safety" }, { kinds: ["met.tornadoo"], max: "urgent" }] } };
    expect(recipientProblems(typo, CHANNELS)).toEqual(["Rule 1 names the kind met.tornadoo, and the taxonomy has no such code. The rule matches no alert of it."]);
  });

  it("finds a person who watches a place or a subject and has no life-safety policy", () => {
    const missing = "The person watches a place or a subject, and has no policy of the level life-safety. A life-safety alert sends nothing to the person.";
    expect(recipientProblems(recipient("person-1", [URGENT]), CHANNELS)).toEqual([missing]);
    const operator = recipient("person-1", [URGENT], []);
    expect(recipientProblems({ ...operator, watch: { ...operator.watch, subjects: [{ system: "alerts.source" }] } }, CHANNELS)).toEqual([missing]);
    // A person who watches nothing gets no alert, thus no level is missing.
    expect(recipientProblems(recipient("person-1", [URGENT], []), CHANNELS)).toEqual([]);
  });

  it("finds a rule that keeps a life-safety kind below life-safety", () => {
    const base = recipient();
    const rules = (...list: Recipient["watch"]["rules"]): Recipient => ({ ...base, watch: { ...base.watch, rules: list } });
    const keeps = (index: number, kinds: string, max: string): string => `Rule ${index} keeps ${kinds} at ${max} or lower. A life-safety kind is in it, and a rule does not keep a life-safety kind below life-safety.`;
    expect(recipientProblems(rules({ max: "urgent" }), CHANNELS)).toEqual([keeps(0, "each kind", "urgent")]);
    // A prefix above a life-safety kind, a code below one, and the coverage of one overlap it.
    expect(recipientProblems(rules({ kinds: ["met.wind", "met.heat"], max: "notice" }, { kinds: ["cbrne.radiological"], max: "urgent" }, { kinds: ["system.coverage"], max: "digest" }), CHANNELS)).toEqual([
      keeps(0, "met.wind", "notice"),
      keeps(1, "cbrne.radiological", "urgent"),
      keeps(2, "system.coverage", "digest"),
    ]);
    // A rule at a place that the person watches keeps the kinds there.
    expect(recipientProblems(rules({ places: ["place-9" as PlaceId, home], kinds: ["met"], max: "urgent" }), CHANNELS)).toEqual([keeps(0, "met", "urgent")]);
    // A rule at life-safety, a rule of other kinds, and a rule with no watched place or no kind keep nothing.
    expect(
      recipientProblems(rules({ max: "life-safety" }, { kinds: ["met.heat", "system.health"], max: "notice" }, { places: [], max: "digest" }, { places: ["place-9" as PlaceId], max: "digest" }, { kinds: [], max: "digest" }), CHANNELS),
    ).toEqual([]);
  });

  it("finds a bad quiet window", () => {
    const base = recipient();
    const quiet = (zone: string, start: string, end: string): Recipient => ({ ...base, watch: { ...base.watch, quiet: { zone, start, end } } });
    expect(recipientProblems(quiet("America/Chicago", "22:00", "07:00"), CHANNELS)).toEqual([]);
    const problems = recipientProblems(quiet("America/Chicagoo", "22:00", "7:00"), CHANNELS);
    expect(problems.length).toBeGreaterThanOrEqual(2);
    for (const problem of problems) expect(problem).toMatch(/^The quiet window: /);
  });

  it("finds an address that does not have the fields of its channel, and names no value", () => {
    const to = { name: "to", required: true, pattern: "\\+[1-9][0-9]{7,14}", form: "a phone number in E.164 form" } as const;
    const label = { name: "label", required: false, pattern: "[a-z]{1,10}", form: "1 to 10 small letters" } as const;
    const texts: ChannelDescriptor = { ...channel(sms, "none"), address: [to, label] };
    const base = recipient();
    const at = (address: Address): string[] => recipientProblems({ ...base, addresses: { ...base.addresses, sms: address } }, [channel(pushover, "poll"), texts]);
    expect(at({ to: "+99900000002" })).toEqual([]);
    expect(at({ to: "+99900000002", label: "home" })).toEqual([]);
    expect(at({})).toEqual(["The address on sms has no field to. The channel needs a phone number in E.164 form."]);
    expect(at({ to: "99900000002" })).toEqual(["The field to of the address on sms is not a phone number in E.164 form."]);
    // The pattern holds the whole value, not a part of it.
    expect(at({ to: "+99900000002 and more" })).toEqual(["The field to of the address on sms is not a phone number in E.164 form."]);
    expect(at({ to: "+99900000002", label: "Home 2" })).toEqual(["The field label of the address on sms is not 1 to 10 small letters."]);
    expect(at({ to: "+99900000002", numbr: "+1" })).toEqual(["The address on sms has the field numbr, and the channel reads no such field."]);
    // Own fields only: the field constructor of a plain object is not a field of the address.
    expect(addressProblems({}, { ...texts, address: [{ name: "constructor", required: true, pattern: ".*", form: "any text" }] })).toEqual([
      "The address on sms has no field constructor. The channel needs any text.",
    ]);
    // A bad pattern of a channel is a problem, not a throw.
    expect(addressProblems({ to: "+99900000002" }, { ...texts, address: [{ ...to, pattern: "[0-9" }] })).toEqual([
      "The channel sms gives the field to a pattern that is not a regular expression.",
    ]);
    // A channel with no fields accepts each address. An address on a channel that the system does not know is not a problem.
    expect(addressProblems({ any: "value" }, channel(pushover, "poll"))).toEqual([]);
    expect(recipientProblems({ ...base, addresses: { ...base.addresses, fax: { to: "x" } } }, CHANNELS)).toEqual([]);
    for (const problem of [...at({ to: "bad-value-1" }), ...at({ numbr: "bad-value-2" })]) expect(problem).not.toMatch(/bad-value/);
  });
});

function report(id: ReportId, fields: Partial<Report> = {}): Report {
  return {
    id,
    source: "nws-api" as Report["source"],
    origin: "nws",
    key: id,
    references: [],
    correlation: [],
    status: "actual",
    op: "alert",
    kind: { code: "met.tornado", label: "Tornado" },
    categories: ["met"],
    ...WARNING,
    certainty: "observed",
    response: ["shelter"],
    sent: T0,
    received: T0,
    areas: atHome,
    about: [],
    sender: "w-nws.webmaster@noaa.gov",
    headline: "Tornado Warning issued April 1 at 1:00PM CDT by NWS Wichita KS",
    observation: "obs" as Report["observation"],
    parameters: {},
    ...fields,
  };
}

describe("messageOf", () => {
  const send = { incident: anchor, level: "life-safety", person, step: 0, channel: pushover, due: T0, wait: 0, quiet: false } as const;

  it("takes the text of the latest report at the severity and the urgency of the incident", () => {
    const reports = [
      report(anchor, { sent: T0, headline: "First" }),
      report(merged, { sent: T0 + MINUTE, headline: "Update", instruction: "TAKE COVER NOW!", areaText: "Sedgwick, KS", description: "A tornado was seen.", web: "https://www.weather.gov/" }),
      report("c".repeat(64) as ReportId, { sent: T0 + 2 * MINUTE, headline: "Not a member" }),
      report("d".repeat(64) as ReportId, { ...WATCH, sent: T0 + 3 * MINUTE, headline: "Lower" }),
    ];
    const members = incident({ reports: [anchor, merged, "d".repeat(64) as ReportId], expires: T0 + 30 * MINUTE });
    expect(messageOf(members, reports, send)).toEqual({
      key: messageKey(send),
      person,
      level: "life-safety",
      title: "Update",
      body: "TAKE COVER NOW!\n\nSedgwick, KS\n\nA tornado was seen.",
      url: "https://www.weather.gov/",
      incident: anchor,
      expires: T0 + 30 * MINUTE,
      quiet: false,
    });
    // The why line of the channel goes into its own field. An empty line gives no field.
    expect(messageOf(members, reports, send, "Why: your place is in the area").why).toBe("Why: your place is in the area");
    expect("why" in messageOf(members, reports, send, "")).toBe(false);
  });

  it("puts each match of the software and the severity at the top of the body (AL-197)", () => {
    const reports = [report(anchor, { sent: T0, headline: "An advisory", description: "A package is malicious." })];
    const software = [
      { part: "web", label: "The web server", purl: "pkg:npm/lib", installed: "2.3.0", verdict: "affected", fixed: "2.4.1" },
      { part: "api", purl: "pkg:npm/lib", installed: "1.0.0", verdict: "unknown" },
    ] as const;
    expect(messageOf(incident(), reports, send, undefined, software).body).toBe(
      "The part web (The web server) has pkg:npm/lib 2.3.0. The first fixed version is 2.4.1.\n" +
        "The part api has pkg:npm/lib 1.0.0. The advisory does not tell if this version is affected.\n" +
        `The severity of the advisory is ${incident().severity}.\n\nA package is malicious.`,
    );
    expect(messageOf(incident(), reports, send, undefined, []).body).toBe("A package is malicious.");
  });

  it("uses the label of the kind when no report of the incident is in the state", () => {
    const message = messageOf(incident(), [], { ...send, quiet: true });
    expect(message.title).toBe("Tornado");
    expect(message.body).toBe("");
    expect(message.quiet).toBe(true);
    expect(message).not.toHaveProperty("url");
  });
});

describe("acknowledgmentOf", () => {
  it("gives an acknowledgment only for the state acknowledged", () => {
    const sent = delivery("life-safety", 0, T0);
    expect(acknowledgmentOf(sent, { state: "acknowledged", at: T0 + MINUTE, by: "phone" })).toEqual({ incident: anchor, level: "life-safety", person, at: T0 + MINUTE, via: pushover });
    for (const state of ["accepted", "delivered", "expired", "failed"] as const) expect(acknowledgmentOf(sent, { state, at: T0 })).toBeUndefined();
  });
});
