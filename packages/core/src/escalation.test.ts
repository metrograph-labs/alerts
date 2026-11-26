import { machineProblems, replay } from "@mark1russell7/algebra";
import { fakeClock } from "@mark1russell7/algebra/clock";
import { describe, expect, it } from "vitest";
import type { Acknowledgment, ChannelDescriptor, ChannelId, Delivery, EscalationPolicy, Level, PersonId, QuietWindow, ReportId } from "./contracts.ts";
import {
  ESCALATION_MACHINE,
  escalate,
  escalationProblems,
  inQuietWindow,
  quietWindowProblems,
  rankFloorProblems,
  rankFloors,
  soundsInQuiet,
  type EscalationInput,
  type EscalationPlan,
  type SoundDelivery,
} from "./escalation.ts";

const MINUTE = 60_000;
const T0 = 1_763_157_600_000;
const anchor = "a".repeat(64) as ReportId;
const merged = "b".repeat(64) as ReportId;
const other = "c".repeat(64) as ReportId;
const person = "person-1" as PersonId;
const pushover = "pushover" as ChannelId;
const sms = "sms" as ChannelId;
const voice = "voice" as ChannelId;

const policy: EscalationPolicy = {
  level: "life-safety",
  steps: [
    { channel: pushover, at: 0 },
    { channel: sms, at: 5 * MINUTE },
    { channel: voice, at: 10 * MINUTE },
  ],
  exhaustedAfter: 20 * MINUTE,
};

const input = (extra: Partial<EscalationInput> = {}): EscalationInput => ({
  policy,
  person,
  incident: { anchor, reports: [anchor, merged] },
  since: T0,
  deliveries: [],
  acknowledgments: [],
  now: T0,
  ...extra,
});

const delivery = (step: number, at: number, extra: Partial<Delivery> = {}): Delivery => ({
  key: `key-${step}`,
  incident: anchor,
  level: "life-safety",
  person,
  step,
  channel: policy.steps[step]?.channel ?? pushover,
  at,
  ...extra,
});

const ack = (at: number, extra: Partial<Acknowledgment> = {}): Acknowledgment => ({ incident: anchor, level: "life-safety", person, at, via: pushover, ...extra });

// The time of a step of a policy.
const nonNegativeAt = (each: EscalationPolicy, step: number): number => each.steps[step]?.at ?? 0;

describe("ESCALATION_MACHINE", () => {
  it("is a consistent machine document", () => {
    expect(machineProblems(ESCALATION_MACHINE)).toEqual([]);
  });
});

describe("escalate", () => {
  it("sends the first step at the start, and wakes at the next step", () => {
    const plan = escalate(input());
    expect(plan.state).toBe("sent");
    expect(plan.due).toEqual([0]);
    expect(plan.sends).toEqual([{ incident: anchor, level: "life-safety", person, step: 0, channel: pushover, due: T0, wait: 0, quiet: false }]);
    expect(plan.cancels).toEqual([]);
    expect(plan.wakeAt).toBe(T0 + 5 * MINUTE);
  });

  it("sends nothing for a step that the ledger has, also from a merged report of the incident", () => {
    const plan = escalate(input({ deliveries: [delivery(0, T0 + 1000, { incident: merged })], now: T0 + 2 * MINUTE }));
    expect(plan.sends).toEqual([]);
    expect(plan.wakeAt).toBe(T0 + 5 * MINUTE);
  });

  it("ignores the deliveries and the acknowledgments of another incident, level or person", () => {
    const plan = escalate(
      input({
        deliveries: [delivery(0, T0, { incident: other }), delivery(0, T0, { level: "urgent" }), delivery(0, T0, { person: "person-2" as PersonId })],
        acknowledgments: [ack(T0, { incident: other }), ack(T0, { level: "urgent" as Level }), ack(T0, { person: "person-2" as PersonId })],
      }),
    );
    expect(plan.state).toBe("sent");
    expect(plan.sends.map((send) => send.step)).toEqual([0]);
  });

  it("sends each due step that the ledger does not have, also a late one", () => {
    const plan = escalate(input({ deliveries: [delivery(0, T0)], now: T0 + 12 * MINUTE }));
    expect(plan.state).toBe("last");
    expect(plan.due).toEqual([0, 1, 2]);
    expect(plan.sends.map((send) => [send.step, send.channel, send.due])).toEqual([
      [1, sms, T0 + 5 * MINUTE],
      [2, voice, T0 + 10 * MINUTE],
    ]);
    expect(plan.wakeAt).toBe(T0 + 30 * MINUTE);
  });

  it("is exhausted after the last step and exhaustedAfter, and the repeats continue", () => {
    const deliveries = [delivery(0, T0), delivery(1, T0 + 5 * MINUTE), delivery(2, T0 + 10 * MINUTE)];
    const plan = escalate(input({ deliveries, now: T0 + 30 * MINUTE }));
    expect(plan.state).toBe("exhausted");
    expect(plan.exhaustedAt).toBe(T0 + 30 * MINUTE);
    expect(plan.sends).toEqual([]);
    expect(plan.cancels).toEqual([]);
    expect(plan.wakeAt).toBeUndefined();
  });

  it("stops at an acknowledgment, and cancels each delivery one time", () => {
    const deliveries = [delivery(0, T0), delivery(0, T0 + 2000, { key: "key-0-copy-2", incident: merged })];
    const plan = escalate(input({ deliveries, acknowledgments: [ack(T0 + 3 * MINUTE)], now: T0 + 8 * MINUTE }));
    expect(plan.state).toBe("acknowledged");
    expect(plan.due).toEqual([0]);
    expect(plan.sends).toEqual([]);
    expect(plan.cancels.map((each) => each.key)).toEqual(["key-0", "key-0-copy-2"]);
    expect(plan.acknowledgment?.at).toBe(T0 + 3 * MINUTE);
    expect(plan.wakeAt).toBeUndefined();
    expect(plan.transitions.map((each) => `${each.from}>${each.to}`)).toEqual(["idle>sent", "sent>acknowledged"]);
    expect(escalate(input({ deliveries, acknowledgments: [ack(T0 + 3 * MINUTE)], cancelled: new Set(["key-0"]), now: T0 + 8 * MINUTE })).cancels).toHaveLength(1);
  });

  it("stops at an acknowledgment of a higher level, as the merge does", () => {
    const urgent: EscalationPolicy = { ...policy, level: "urgent" };
    const deliveries = [delivery(0, T0, { level: "urgent" })];
    expect(escalate(input({ policy: urgent, deliveries, acknowledgments: [ack(T0 + MINUTE)], now: T0 + 2 * MINUTE })).state).toBe("acknowledged");
    expect(escalate(input({ deliveries: [delivery(0, T0)], acknowledgments: [ack(T0 + MINUTE, { level: "urgent" })], now: T0 + 2 * MINUTE })).state).toBe("sent");
  });

  it("takes the first acknowledgment, and one from a copy with a clock ahead", () => {
    const plan = escalate(input({ acknowledgments: [ack(T0 + 9 * MINUTE, { via: "ui" }), ack(T0 + 4 * MINUTE)], now: T0 + 2 * MINUTE }));
    expect(plan.state).toBe("acknowledged");
    expect(plan.acknowledgment?.via).toBe(pushover);
    expect(plan.transitions.at(-1)?.at).toBe(T0 + 2 * MINUTE);
  });

  it("ends with the incident, and wakes at the end when the end comes first", () => {
    const ended = escalate(input({ deliveries: [delivery(0, T0)], endsAt: T0 + 4 * MINUTE, now: T0 + 6 * MINUTE }));
    expect(ended.state).toBe("ended");
    expect(ended.due).toEqual([0]);
    expect(ended.sends).toEqual([]);
    expect(ended.cancels.map((each) => each.key)).toEqual(["key-0"]);
    expect(escalate(input({ endsAt: T0 + 3 * MINUTE, now: T0 + MINUTE })).wakeAt).toBe(T0 + 3 * MINUTE);
  });

  it("makes a copy wait for its rank before each send", () => {
    const first = escalate(input({ rank: 1, rankDelay: 20_000 }));
    expect(first.state).toBe("idle");
    expect(first.sends).toEqual([]);
    expect(first.wakeAt).toBe(T0 + 20_000);
    // The copy of rank 0 sent the step, and the merge brought its delivery
    const later = escalate(input({ rank: 1, rankDelay: 20_000, deliveries: [delivery(0, T0 + 500)], now: T0 + 20_000 }));
    expect(later.state).toBe("sent");
    expect(later.sends).toEqual([]);
    // The copy of rank 0 did not send: the copy of rank 1 sends
    expect(escalate(input({ rank: 1, rankDelay: 20_000, now: T0 + 20_000 })).sends.map((send) => send.step)).toEqual([0]);
  });

  describe("the rank floor of an exclusive channel (AL-15)", () => {
    // A push and a call at once, at life-safety with a rank delay of 0.
    const both: EscalationPolicy = { level: "life-safety", steps: [{ channel: pushover, at: 0 }, { channel: voice, at: 0 }], exhaustedAfter: 20 * MINUTE };
    const floors = new Map([[voice, 31_000]]);
    const due = (plan: EscalationPlan) => plan.sends.map((send) => [send.channel, send.due, send.wait]);

    it("sends the push of rank 1 at once, and its call one floor later", () => {
      const first = escalate(input({ policy: both, rank: 1, rankDelay: 0, floors }));
      expect(due(first)).toEqual([[pushover, T0, 0]]);
      expect(first.state).toBe("sent");
      expect(first.wakeAt).toBe(T0 + 31_000);
      const later = escalate(input({ policy: both, rank: 1, rankDelay: 0, floors, deliveries: [delivery(0, T0, { channel: pushover })], now: T0 + 31_000 }));
      expect(due(later)).toEqual([[voice, T0 + 31_000, 31_000]]);
      expect(later.state).toBe("last");
      // The exhaustion comes after the latest due time of a step.
      expect(later.wakeAt).toBe(T0 + 31_000 + 20 * MINUTE);
    });

    it("sends the push and the call of rank 0 at once", () => {
      expect(due(escalate(input({ policy: both, rank: 0, rankDelay: 0, floors })))).toEqual([
        [pushover, T0, 0],
        [voice, T0, 0],
      ]);
    });

    it("waits the rank delay when it is above the floor, and the floor for each rank", () => {
      const slow = escalate(input({ policy: both, rank: 1, rankDelay: 40_000, floors, now: T0 + 40_000 }));
      expect(due(slow)).toEqual([
        [pushover, T0 + 40_000, 40_000],
        [voice, T0 + 40_000, 40_000],
      ]);
      expect(escalate(input({ policy: both, rank: 2, rankDelay: 0, floors })).wakeAt).toBe(T0 + 62_000);
    });

    it("gives no floor to a channel with no entry, and a floor that is not a number of 0 or more counts as 0", () => {
      expect(due(escalate(input({ policy: both, rank: 1, rankDelay: 0 })))).toEqual([
        [pushover, T0, 0],
        [voice, T0, 0],
      ]);
      expect(due(escalate(input({ policy: both, rank: 1, rankDelay: 0, floors: new Map([[voice, Number.NaN]]) })))).toEqual([
        [pushover, T0, 0],
        [voice, T0, 0],
      ]);
    });

    it("does not call from rank 1 when the call of rank 0 is in the ledger at the due time", () => {
      const called = delivery(1, T0 + 18_000, { channel: voice });
      const plan = escalate(input({ policy: both, rank: 1, rankDelay: 0, floors, deliveries: [delivery(0, T0, { channel: pushover }), called], now: T0 + 31_000 }));
      expect(plan.sends).toEqual([]);
      // The call of rank 0 came after the start of rank 1, thus the start stays.
      expect(plan.start).toBe(T0);
    });
  });

  it("takes the start of a copy that started first from its delivery", () => {
    const plan = escalate(input({ since: T0 + 2 * MINUTE, deliveries: [delivery(0, T0)], now: T0 + 5 * MINUTE }));
    expect(plan.start).toBe(T0);
    expect(plan.sends.map((send) => send.step)).toEqual([1]);
  });

  it("goes from idle to last with one step, and from idle to exhausted with no step", () => {
    const one: EscalationPolicy = { level: "life-safety", steps: [{ channel: pushover, at: 0 }], exhaustedAfter: MINUTE };
    expect(escalate(input({ policy: one })).transitions.map((each) => each.to)).toEqual(["last"]);
    const none: EscalationPolicy = { level: "life-safety", steps: [], exhaustedAfter: MINUTE };
    expect(escalate(input({ policy: none })).state).toBe("idle");
    expect(escalate(input({ policy: none, now: T0 + MINUTE })).state).toBe("exhausted");
  });

  it("is total over odd input, and its order does not depend on the order of the merge state", () => {
    const deliveries = [
      delivery(7, T0 - 60 * MINUTE, { key: "key-old-policy" }),
      delivery(1, Number.NaN, { key: "key-no-time" }),
      delivery(0, T0, { key: "key-b" }),
      delivery(0, T0, { key: "key-a" }),
      delivery(0, T0, { key: "key-a" }),
    ];
    const acknowledgments = [ack(T0 + MINUTE, { via: pushover }), ack(T0 + MINUTE, { via: "ui" })];
    const plan = escalate(input({ deliveries, acknowledgments, rank: -1, rankDelay: Number.NaN, now: T0 + 2 * MINUTE }));
    expect(plan.start).toBe(T0);
    expect(plan.acknowledgment?.via).toBe(pushover);
    expect(plan.cancels.map((each) => each.key)).toEqual(["key-old-policy", "key-a", "key-b", "key-no-time"]);
    const reversed = escalate(input({ deliveries: [...deliveries].reverse(), acknowledgments: [...acknowledgments].reverse(), now: T0 + 2 * MINUTE }));
    expect(reversed.cancels).toEqual(plan.cancels);
    expect(reversed.acknowledgment).toEqual(plan.acknowledgment);
  });

  it("puts the last step before the exhaustion at the same time", () => {
    const zero: EscalationPolicy = { ...policy, exhaustedAfter: 0 };
    const plan = escalate(input({ policy: zero, now: T0 + 10 * MINUTE }));
    expect(plan.transitions.map((each) => each.to)).toEqual(["sent", "sent", "last", "exhausted"]);
  });
});

describe("escalate over a grid of inputs", () => {
  const policies: EscalationPolicy[] = [
    { level: "life-safety", steps: [], exhaustedAfter: 10 * MINUTE },
    { level: "life-safety", steps: [{ channel: pushover, at: 0 }], exhaustedAfter: 0 },
    policy,
    { ...policy, steps: [...policy.steps, { channel: pushover, at: 10 * MINUTE }], exhaustedAfter: 0 },
  ];
  const acks = [undefined, 0, 4 * MINUTE, 26 * MINUTE];
  const ends = [undefined, 6 * MINUTE, 35 * MINUTE];
  const ranks = [0, 2];
  // At rank 2, a floor of 7 minutes moves the voice step from 10 to 24 minutes: after the fourth step of the second policy.
  const floorsList = [undefined, new Map([[voice, 7 * MINUTE]])];
  const silents = [false, true];
  const times = Array.from({ length: 41 }, (_, minute) => minute * MINUTE);

  it("makes only the transitions of the machine document, and each later plan extends the earlier one", () => {
    let count = 0;
    for (const each of policies)
      for (const ackAt of acks)
        for (const endAt of ends)
          for (const [rank, silent, floors] of ranks.flatMap((item) => silents.flatMap((mode) => floorsList.map((each) => [item, mode, each] as const)))) {
            let before: EscalationPlan | undefined;
            for (const time of times) {
              const plan = escalate(
                input({
                  policy: each,
                  rank,
                  rankDelay: 15_000,
                  floors,
                  silent,
                  acknowledgments: ackAt === undefined || ackAt > time ? [] : [ack(T0 + ackAt)],
                  ...(endAt === undefined ? {} : { endsAt: T0 + endAt }),
                  now: T0 + time,
                }),
              );
              expect(replay(ESCALATION_MACHINE, plan.transitions)).toEqual([]);
              const final = plan.state === "acknowledged" || plan.state === "ended";
              if (final) expect(plan.sends).toEqual([]);
              else expect(plan.cancels).toEqual([]);
              if (plan.wakeAt !== undefined) expect(plan.wakeAt).toBeGreaterThan(T0 + time);
              // Each send was due at or before now, and its due time holds its wait.
              for (const send of plan.sends) expect([send.due <= T0 + time, send.due - send.wait]).toEqual([true, plan.start + nonNegativeAt(each, send.step)]);
              // The silent mode of a mute makes each send quiet, and it never exhausts.
              if (silent) expect([plan.sends.every((send) => send.quiet), plan.state === "exhausted"]).toEqual([true, false]);
              if (before !== undefined) expect(plan.transitions.slice(0, before.transitions.length)).toEqual(before.transitions);
              before = plan;
              count += 1;
            }
          }
    expect(count).toBe(policies.length * acks.length * ends.length * ranks.length * silents.length * floorsList.length * times.length);
  });
});

describe("rankFloors", () => {
  const descriptor = (id: ChannelId, exclusive?: boolean): ChannelDescriptor => ({
    id,
    title: id,
    dependsOn: [],
    uses: ["internet"],
    breaksThrough: true,
    repeats: false,
    ack: "none",
    maxTitle: 250,
    maxBody: 1024,
    ...(exclusive === undefined ? {} : { exclusive }),
  });

  it("gives the floor to each exclusive channel only", () => {
    const channels = [descriptor(pushover), descriptor(voice, true), descriptor(sms, false)];
    expect([...rankFloors(channels, 31_000)]).toEqual([[voice, 31_000]]);
    expect([...rankFloors(channels, undefined)]).toEqual([]);
  });

  it("refuses a floor that is not a whole number of milliseconds from 0 to one hour", () => {
    expect(rankFloorProblems(undefined)).toEqual([]);
    expect(rankFloorProblems(0)).toEqual([]);
    expect(rankFloorProblems(60 * MINUTE)).toEqual([]);
    for (const bad of [-1, 1.5, 60 * MINUTE + 1, Number.NaN]) expect(rankFloorProblems(bad)).toEqual(["The rank floor is not a whole number of milliseconds from 0 to 3600000."]);
  });
});

describe("escalate on the test clock", () => {
  it("sends each step at its time, and stops at the acknowledgment", async () => {
    const clock = fakeClock(T0);
    const ledger: Delivery[] = [];
    const acknowledgments: Acknowledgment[] = [];
    const sent: Array<[number, number]> = [];
    // A small runtime: it sends the due steps, writes them to the ledger and waits for wakeAt.
    const tick = (): void => {
      const plan = escalate(input({ deliveries: ledger, acknowledgments, now: clock.now() }));
      for (const send of plan.sends) {
        sent.push([send.step, clock.now()]);
        ledger.push(delivery(send.step, clock.now()));
      }
      if (plan.wakeAt !== undefined) clock.after(plan.wakeAt - clock.now(), tick);
    };
    tick();
    await clock.advance(7 * MINUTE);
    acknowledgments.push(ack(clock.now()));
    tick();
    await clock.advance(60 * MINUTE);
    expect(sent).toEqual([
      [0, T0],
      [1, T0 + 5 * MINUTE],
    ]);
    expect(escalate(input({ deliveries: ledger, acknowledgments, now: clock.now() })).state).toBe("acknowledged");
  });
});

describe("escalationProblems", () => {
  it("finds a policy with no step, a step out of order, a negative time and a negative exhaustion", () => {
    expect(escalationProblems(policy)).toEqual([]);
    expect(escalationProblems({ level: "urgent", steps: [], exhaustedAfter: -1 })).toHaveLength(2);
    expect(
      escalationProblems({
        level: "urgent",
        steps: [
          { channel: sms, at: 5 * MINUTE },
          { channel: pushover, at: -1 },
        ],
        exhaustedAfter: 0,
      }),
    ).toHaveLength(2);
  });
});

describe("inQuietWindow", () => {
  const night: QuietWindow = { zone: "Europe/Berlin", start: "22:00", end: "07:00" };
  const utc = (month: number, day: number, hour: number, minute = 0): number => Date.UTC(2026, month - 1, day, hour, minute);

  it("holds a window across midnight on a day with no change of the clock", () => {
    // In January, Berlin is at UTC+1.
    expect(inQuietWindow(night, utc(1, 15, 20, 59))).toBe(false);
    expect(inQuietWindow(night, utc(1, 15, 21, 0))).toBe(true);
    expect(inQuietWindow(night, utc(1, 15, 23, 0))).toBe(true);
    expect(inQuietWindow(night, utc(1, 16, 5, 59))).toBe(true);
    expect(inQuietWindow(night, utc(1, 16, 6, 0))).toBe(false);
  });

  it("moves the end with the clock on the day of the change to summer time", () => {
    // 2026-03-29 01:00Z: 02:00 CET becomes 03:00 CEST.
    expect(inQuietWindow(night, utc(3, 29, 0, 59))).toBe(true);
    expect(inQuietWindow(night, utc(3, 29, 1, 0))).toBe(true);
    expect(inQuietWindow(night, utc(3, 29, 4, 59))).toBe(true);
    // 05:00Z is 07:00 CEST. A fixed offset of UTC+1 gives 06:00, in the window.
    expect(inQuietWindow(night, utc(3, 29, 5, 0))).toBe(false);
  });

  it("moves the end with the clock on the day of the change to winter time", () => {
    // 2026-10-25 01:00Z: 03:00 CEST becomes 02:00 CET.
    expect(inQuietWindow(night, utc(10, 24, 19, 59))).toBe(false);
    expect(inQuietWindow(night, utc(10, 24, 20, 0))).toBe(true);
    // 05:00Z is 06:00 CET. A fixed offset of UTC+2 gives 07:00, out of the window.
    expect(inQuietWindow(night, utc(10, 25, 5, 0))).toBe(true);
    expect(inQuietWindow(night, utc(10, 25, 5, 59))).toBe(true);
    expect(inQuietWindow(night, utc(10, 25, 6, 0))).toBe(false);
  });

  it("holds an hour that occurs two times, and an hour that does not occur", () => {
    const two: QuietWindow = { zone: "Europe/Berlin", start: "02:00", end: "03:00" };
    // 02:30 occurs at 00:30Z (CEST) and at 01:30Z (CET).
    expect(inQuietWindow(two, utc(10, 25, 0, 30))).toBe(true);
    expect(inQuietWindow(two, utc(10, 25, 1, 30))).toBe(true);
    expect(inQuietWindow(two, utc(10, 25, 2, 0))).toBe(false);
    // On 2026-03-29 the local clock goes from 01:59 to 03:00, so the window is empty on that day.
    expect(inQuietWindow(two, utc(3, 29, 0, 59))).toBe(false);
    expect(inQuietWindow(two, utc(3, 29, 1, 0))).toBe(false);
  });

  it("agrees with the offsets of the zone at each 5 minutes around the two changes", () => {
    const summerFrom = utc(3, 29, 1);
    const winterFrom = utc(10, 25, 1);
    const offset = (at: number): number => (at >= summerFrom && at < winterFrom ? 120 : 60);
    const minutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    const windows: QuietWindow[] = [
      night,
      { zone: "Europe/Berlin", start: "02:00", end: "03:00" },
      { zone: "Europe/Berlin", start: "09:00", end: "17:00" },
      { zone: "Europe/Berlin", start: "23:30", end: "00:30" },
    ];
    let checked = 0;
    for (const change of [summerFrom, winterFrom]) {
      for (let at = change - 36 * 60 * MINUTE; at <= change + 36 * 60 * MINUTE; at += 5 * MINUTE) {
        const local = (((Math.floor(at / MINUTE) + offset(at)) % 1440) + 1440) % 1440;
        for (const window of windows) {
          const start = minutes(window.start);
          const end = minutes(window.end);
          const expected = start < end ? start <= local && local < end : local >= start || local < end;
          expect(inQuietWindow(window, at), `${new Date(at).toISOString()} ${window.start}-${window.end}`).toBe(expected);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(2 * 865 * 4);
  });

  it("gives the full day for an end equal to the start", () => {
    expect(inQuietWindow({ ...night, end: "22:00" }, utc(1, 15, 12, 0))).toBe(true);
    expect(inQuietWindow({ ...night, end: "22:00" }, utc(1, 15, 21, 59))).toBe(true);
  });

  it("gives false for an absent or bad window and for a bad time", () => {
    const at = utc(1, 15, 23, 0);
    expect(inQuietWindow(undefined, at)).toBe(false);
    expect(inQuietWindow({ ...night, zone: "Mars/Olympus" }, at)).toBe(false);
    expect(inQuietWindow({ ...night, start: "7:00" }, at)).toBe(false);
    expect(inQuietWindow({ ...night, end: "24:00" }, at)).toBe(false);
    expect(inQuietWindow(night, Number.NaN)).toBe(false);
    expect(inQuietWindow(night, 1e20)).toBe(false);
  });
});

describe("quietWindowProblems", () => {
  it("finds a bad time zone and a bad local time", () => {
    expect(quietWindowProblems({ zone: "Europe/Berlin", start: "22:00", end: "07:00" })).toEqual([]);
    expect(quietWindowProblems({ zone: "Mars/Olympus", start: "22:60", end: "7:00" })).toEqual([
      '"Mars/Olympus" is not the IANA name of a time zone.',
      'The start "22:60" is not a local time HH:MM from 00:00 to 23:59.',
      'The end "7:00" is not a local time HH:MM from 00:00 to 23:59.',
    ]);
    expect(quietWindowProblems({ zone: "UTC", start: "06:00", end: "06:00" })).toEqual([]);
  });

  it("finds a bad sound rule (AL-97)", () => {
    expect(quietWindowProblems({ zone: "UTC", start: "22:00", end: "07:00", sounds: [{ kinds: ["met.tornado"], level: "urgent", most: 2 }] })).toEqual([]);
    expect(quietWindowProblems({ zone: "UTC", start: "22:00", end: "07:00", sounds: [{ kinds: [], level: "urgent", most: 1.5 }] })).toEqual([
      "The sound rule 1: Each kind is a prefix that is not empty, and the rule has one kind or more.",
      "The sound rule 1: The most is a whole number, 0 or more.",
    ]);
  });
});

describe("escalate with a quiet window", () => {
  const quiet: QuietWindow = { zone: "UTC", start: "22:00", end: "07:00" };
  const atNight = Date.UTC(2026, 0, 15, 23, 0);
  const atDay = Date.UTC(2026, 0, 15, 12, 0);
  const notice: EscalationPolicy = { level: "notice", steps: [{ channel: pushover, at: 0 }], exhaustedAfter: 0 };

  it("makes each send below life-safety quiet in the window", () => {
    const plan = escalate(input({ policy: notice, quiet, since: atNight, now: atNight }));
    expect(plan.sends.map((send) => send.quiet)).toEqual([true]);
  });

  it("never makes a life-safety send quiet", () => {
    const plan = escalate(input({ quiet, since: atNight, now: atNight + 10 * MINUTE }));
    expect(plan.sends.map((send) => send.quiet)).toEqual([false, false, false]);
  });

  it("takes the time of now, not the time at which the step became due", () => {
    // The step became due at 06:55 and goes out at 07:05, out of the window.
    const due = Date.UTC(2026, 0, 16, 6, 55);
    expect(escalate(input({ policy: notice, quiet, since: due, now: due })).sends[0]?.quiet).toBe(true);
    expect(escalate(input({ policy: notice, quiet, since: due, now: due + 10 * MINUTE })).sends[0]?.quiet).toBe(false);
  });

  it("makes no send quiet out of the window or with no window", () => {
    expect(escalate(input({ policy: notice, quiet, since: atDay, now: atDay })).sends[0]?.quiet).toBe(false);
    expect(escalate(input({ policy: notice, since: atNight, now: atNight })).sends[0]?.quiet).toBe(false);
  });

  it("makes a send loud in the window when a sound rule passes it, but not in the silent mode of a mute (AL-97)", () => {
    expect(escalate(input({ policy: notice, quiet, sounds: true, since: atNight, now: atNight })).sends[0]?.quiet).toBe(false);
    expect(escalate(input({ policy: notice, quiet, sounds: true, silent: true, since: atNight, now: atNight })).sends[0]?.quiet).toBe(true);
  });
});

describe("soundsInQuiet (AL-97)", () => {
  // A test clock: each time is a fixed instant. The window is 22:00 to 07:00 UTC, and now is 23:00 on 15 January.
  const quiet: QuietWindow = { zone: "UTC", start: "22:00", end: "07:00" };
  const night = Date.UTC(2026, 0, 15, 23, 0);
  const TELL = "system.tell.needs-you";
  const own = { anchor, reports: new Set<string>([anchor, merged]), kind: TELL };
  const other = (digit: number): ReportId => String(digit).repeat(64) as ReportId;
  const sent = (incident: ReportId, at: number, kind: string | undefined = TELL, level: Level = "urgent"): SoundDelivery => ({ incident, level, at, kind });

  it("lets an urgent needs-you of the operator sound by default, and keeps each other kind and level quiet", () => {
    expect(soundsInQuiet(quiet, own, "urgent", [], night)).toBe(true);
    expect(soundsInQuiet(quiet, own, "notice", [], night)).toBe(false);
    expect(soundsInQuiet(quiet, { ...own, kind: "system.tell.live" }, "urgent", [], night)).toBe(false);
    expect(soundsInQuiet(quiet, { ...own, kind: "met.tornado" }, "urgent", [], night)).toBe(false);
  });

  it("gives false out of the window and with no window, because then no send is quiet", () => {
    expect(soundsInQuiet(quiet, own, "urgent", [], Date.UTC(2026, 0, 15, 12, 0))).toBe(false);
    expect(soundsInQuiet(undefined, own, "urgent", [], night)).toBe(false);
  });

  it("lets at most 2 incidents sound in one window, and a repeat of a loud incident stays loud", () => {
    const first = sent(other(1), night - 30 * MINUTE);
    const second = sent(other(2), night - 20 * MINUTE);
    expect(soundsInQuiet(quiet, own, "urgent", [first], night)).toBe(true);
    expect(soundsInQuiet(quiet, own, "urgent", [first, second], night)).toBe(false);
    // The own incident sounded before the second one, thus its repeat stays loud. A delivery to a merged report counts as own.
    expect(soundsInQuiet(quiet, own, "urgent", [first, sent(merged, night - 25 * MINUTE), second], night)).toBe(true);
    // The quiet third incident also counts after the first two. It does not move them.
    expect(soundsInQuiet(quiet, { ...own, anchor: other(1), reports: new Set([other(1)]) }, "urgent", [first, second, sent(anchor, night - 10 * MINUTE)], night)).toBe(true);
  });

  it("counts only the deliveries of this window, of the rule and of a known incident", () => {
    // A delivery of the last window and a delivery before the window of tonight do not count.
    const lastNight = sent(other(1), night - 24 * 60 * MINUTE);
    const evening = sent(other(2), Date.UTC(2026, 0, 15, 21, 0));
    expect(soundsInQuiet(quiet, own, "urgent", [lastNight, evening, sent(other(3), night - MINUTE)], night)).toBe(true);
    // A delivery of another kind, of a lower level or of an incident with no kind does not count.
    const others = [sent(other(1), night - 3 * MINUTE, "met.tornado"), sent(other(2), night - 2 * MINUTE, TELL, "notice"), sent(other(4), night - MINUTE, undefined)];
    expect(soundsInQuiet(quiet, own, "urgent", [...others, sent(other(3), night - MINUTE)], night)).toBe(true);
    // The next window is a new window: at 22:30 on 16 January, the deliveries of the night before do not count.
    expect(soundsInQuiet(quiet, own, "urgent", [sent(other(1), night), sent(other(2), night + MINUTE)], Date.UTC(2026, 0, 16, 22, 30))).toBe(true);
  });

  it("lets only one of two incidents with the same first time sound when the most is 1", () => {
    const one: QuietWindow = { ...quiet, sounds: [{ kinds: [TELL], level: "urgent", most: 1 }] };
    const at = night - MINUTE;
    const mine = soundsInQuiet(one, own, "urgent", [sent(anchor, at), sent(other(1), at)], night);
    const theirs = soundsInQuiet(one, { ...own, anchor: other(1), reports: new Set([other(1)]) }, "urgent", [sent(anchor, at), sent(other(1), at)], night);
    expect([mine, theirs].filter(Boolean)).toHaveLength(1);
  });

  it("takes the rules of the window in place of the first rules, and an empty list or a bad rule keeps each message quiet", () => {
    const tornado: QuietWindow = { ...quiet, sounds: [{ kinds: ["met.tornado"], level: "notice", most: 1 }] };
    expect(soundsInQuiet(tornado, { ...own, kind: "met.tornado" }, "notice", [], night)).toBe(true);
    expect(soundsInQuiet(tornado, own, "urgent", [], night)).toBe(false);
    expect(soundsInQuiet(tornado, { ...own, kind: "met.tornado" }, "notice", [sent(other(1), night - MINUTE, "met.tornado", "notice")], night)).toBe(false);
    expect(soundsInQuiet({ ...quiet, sounds: [] }, own, "urgent", [], night)).toBe(false);
    expect(soundsInQuiet({ ...quiet, sounds: [{ kinds: [TELL], level: "urgent", most: -1 }] }, own, "urgent", [], night)).toBe(false);
  });
});

describe("escalate in the silent mode of a mute", () => {
  it("makes each send quiet, also at life-safety and out of a quiet window", () => {
    const plan = escalate(input({ silent: true, now: T0 + 10 * MINUTE }));
    expect(plan.sends.map((send) => [send.step, send.quiet])).toEqual([
      [0, true],
      [1, true],
      [2, true],
    ]);
  });

  it("does not exhaust after the last step, and an acknowledgment or an end still stops it", () => {
    const deliveries = [delivery(0, T0), delivery(1, T0 + 5 * MINUTE), delivery(2, T0 + 10 * MINUTE)];
    const plan = escalate(input({ silent: true, deliveries, now: T0 + 60 * MINUTE }));
    expect([plan.state, plan.exhaustedAt, plan.wakeAt]).toEqual(["last", undefined, undefined]);
    expect(escalate(input({ silent: true, deliveries, acknowledgments: [ack(T0 + 40 * MINUTE)], now: T0 + 60 * MINUTE })).state).toBe("acknowledged");
    expect(escalate(input({ silent: true, deliveries, endsAt: T0 + 50 * MINUTE, now: T0 + 60 * MINUTE })).state).toBe("ended");
  });
});
