/**
 * The escalation of one level of one incident to one person. It is a pure calculation. Its input
 * is the policy, the deliveries and the acknowledgments of the merge state, and the time. Its
 * output is the state, the sends that are due, the cancels and the time of the next decision. It
 * reads no channel and no clock: the runtime gives `now`, and starts it again at `wakeAt` or when the
 * merge state changes.
 *
 * `ESCALATION_MACHINE` is the machine document of the escalation, in the format of
 * `@mark1russell7/algebra`. Each plan gives its transitions, and a replay against the document
 * finds a transition that the document does not permit.
 */

import type { Machine, Transition } from "@mark1russell7/algebra";
import { firstInstantOf, inWindow, localTime, nextBoundary, windowProblems } from "@mark1russell7/algebra/clock";
import { compareCodeUnits } from "@mark1russell7/text/order";
import { TELL_KIND } from "./assess.ts";
import { LEVELS } from "./contracts.ts";
import { hasKind } from "./kind-prefix.ts";
import type {
  Acknowledgment,
  ChannelDescriptor,
  DailyTime,
  ChannelId,
  Delivery,
  Duration,
  EscalationPolicy,
  Incident,
  Instant,
  Level,
  PersonId,
  QuietSound,
  QuietWindow,
  ReportId,
} from "./contracts.ts";
import type { MessageKeyInput } from "./ids.ts";

/**
 * The state of an escalation.
 * - `idle`: no step is due.
 * - `sent`: one or more steps are due, and one or more steps are not due.
 * - `last`: each step is due. The time to the exhaustion runs.
 * - `exhausted`: no acknowledgment came in the time of the policy. This is a system alert.
 * - `acknowledged`: the person acknowledged, by a channel or by the UI.
 * - `ended`: the incident is over, by its expiry or by its cancel.
 */
export type EscalationState = "idle" | "sent" | "last" | "exhausted" | "acknowledged" | "ended";

/** The events of the escalation machine. */
export const ESCALATION_EVENTS: {
  readonly step: "timer.step";
  readonly exhaust: "timer.exhaust";
  readonly ack: "app.ack";
  readonly end: "app.end";
} = { step: "timer.step", exhaust: "timer.exhaust", ack: "app.ack", end: "app.end" };

/** The machine document of the escalation. `escalate` makes only the transitions of this document. */
export const ESCALATION_MACHINE: Machine = {
  format: "mark1russell7.machine/1",
  id: "alerts.escalation",
  title: "The escalation of one level of one incident to one person, until an acknowledgment",
  layer: "self",
  version: "1",
  sources: [{ ref: "docs/CONTRACTS.md of the alerts repository: the channel contract and the delivery promise", rung: "derived" }],
  states: {
    idle: { initial: true, note: "no step is due" },
    sent: { note: "one or more steps are due, and one or more steps are not due" },
    last: { note: "each step is due, and the exhaust timer runs" },
    exhausted: { note: "no acknowledgment came in the time of the policy. An acknowledgment or the end still stops the repeats" },
    acknowledged: { final: true },
    ended: { final: true, note: "the incident is over, by its expiry or by its cancel" },
  },
  events: {
    "timer.step": { kind: "timer", note: "the time of the next step of the policy" },
    "timer.exhaust": { kind: "timer", note: "the end of the time after the last step" },
    "app.ack": { kind: "app", note: "an acknowledgment in the merge state, from a channel or from the UI" },
    "app.end": { kind: "app", note: "the expiry or the cancel of the incident" },
  },
  knobs: {
    step_at: { key: "EscalationStep.at", scope: "policy", unit: "ms", default: null, note: "the time from the start to the first step" },
    step_wait: { key: "the time from one step of the policy to the next", scope: "policy", unit: "ms", default: null, note: "the policy gives one for each step. At a rank above 0, the rank floor of a channel changes it" },
    rank_wait: {
      key: "rank × max(the rank delay of the level, the rank floor of the channel of the step)",
      scope: "cell",
      unit: "ms",
      default: null,
      note: "a copy waits for its rank before each send. The rank delay of a level can be 0, then each copy sends a step of a channel with no floor at once",
    },
    exhausted_after: { key: "EscalationPolicy.exhaustedAfter", scope: "policy", unit: "ms", default: null },
  },
  timers: {
    first: {
      duration: { expr: "step_at + rank_wait", unit: "ms" },
      arms: ["enter:idle"],
      cancels: ["app.ack", "app.end"],
      fires: "timer.step",
      note: "the time from the start to the first step",
    },
    next: {
      duration: { knob: "step_wait", unit: "ms" },
      arms: ["timer.step"],
      cancels: ["app.ack", "app.end", "enter:last"],
      fires: "timer.step",
      note: "the time from one step to the next",
    },
    exhaust: {
      duration: { knob: "exhausted_after", unit: "ms" },
      arms: ["enter:last"],
      cancels: ["app.ack", "app.end"],
      fires: "timer.exhaust",
      note: "it does not arm in the silent mode of a mute: a quiet message asks for no acknowledgment",
    },
  },
  transitions: [
    { id: "es.first", from: "idle", to: "sent", on: "timer.step", note: "the first step of a policy with two or more steps" },
    { id: "es.only", from: "idle", to: "last", on: "timer.step", note: "the step of a policy with one step" },
    { id: "es.next", from: "sent", to: "sent", on: "timer.step" },
    { id: "es.last", from: "sent", to: "last", on: "timer.step" },
    { id: "es.exhaust", from: "last", to: "exhausted", on: "timer.exhaust" },
    { id: "es.none", from: "idle", to: "exhausted", on: "timer.exhaust", note: "a policy with no step: nothing reaches the person" },
    { id: "es.ack", from: "*", to: "acknowledged", on: "app.ack" },
    { id: "es.end", from: "*", to: "ended", on: "app.end" },
  ],
};

/** The input of `escalate`. */
export interface EscalationInput {
  readonly policy: EscalationPolicy;
  readonly person: PersonId;
  /** The incident. A delivery or an acknowledgment that points to one of its reports belongs to it. */
  readonly incident: Pick<Incident, "anchor" | "reports">;
  /** The time at which the level of the incident first called for this escalation. */
  readonly since: Instant;
  /** The time at which the incident is over: its expiry, or the time of its cancel. Without it, the incident is live. */
  readonly endsAt?: Instant | undefined;
  /** The deliveries of the merge state. The function keeps the deliveries of this incident, level and person. */
  readonly deliveries: readonly Delivery[];
  /**
   * The acknowledgments of the merge state. The function keeps the acknowledgments of the person for
   * this incident, at this level or above. An acknowledgment of a level also covers each lower level.
   */
  readonly acknowledgments: readonly Acknowledgment[];
  /** The delivery keys that this copy cancelled. A cancel is idempotent, so this set only prevents a second call. */
  readonly cancelled?: ReadonlySet<string> | undefined;
  /** The rank of this copy of the system, from 0. A copy waits `rank × rankDelay` before each send. */
  readonly rank?: number | undefined;
  /** The wait of one rank at the level of the policy. `rankDelayOf` gives it from the table of the levels. */
  readonly rankDelay?: Duration | undefined;
  /**
   * The least wait of one rank before a step of each channel: the rank floor. A channel with no entry has the floor 0.
   * `rankFloors` gives the floor of each exclusive channel.
   */
  readonly floors?: ReadonlyMap<ChannelId, Duration> | undefined;
  /** The quiet window of the person, from `PersonWatch.quiet`. A send below `life-safety` in the window is quiet. */
  readonly quiet?: QuietWindow | undefined;
  /**
   * True: a sound rule of the quiet window passes the incident at `now` (`soundsInQuiet`, AL-97). Thus its sends are not
   * quiet in the window. The silent mode of a mute still makes each send quiet.
   */
  readonly sounds?: boolean | undefined;
  /**
   * The episode of the escalation: the count of the earlier ends of the escalations of the person in the incident.
   * The default is 0. Each send has it, thus `messageKey` gives new keys after an end.
   */
  readonly episode?: number | undefined;
  /**
   * True: the escalation is in the silent mode of a mute. Each send is quiet, also at `life-safety`, and the exhaust
   * timer does not arm. The caller gives the steps of the mode: `route` gives step 0 at most.
   */
  readonly silent?: boolean | undefined;
  readonly now: Instant;
}

/**
 * The wait of one rank of a copy, for each level. A level with no entry takes the default of the caller. With 0 at a
 * level, each copy sends each step of the level at once, thus a person gets one message from each copy.
 */
export type RankDelays = Readonly<Partial<Record<Level, Duration>>>;

/** The longest rank delay of a level in a configuration: one hour. The longest rank floor is the same. */
export const RANK_DELAY_LIMIT: Duration = 60 * 60_000;

/**
 * This function gives the rank floor of each exclusive channel: `floor`. A person takes one message of such a channel at a
 * time. Thus a copy with a rank above 0 waits for the delivery of rank 0 before its step of the channel.
 */
export function rankFloors(channels: readonly ChannelDescriptor[], floor: Duration | undefined): ReadonlyMap<ChannelId, Duration> {
  return new Map(floor === undefined ? [] : channels.filter((channel) => channel.exclusive === true).map((channel) => [channel.id, floor] as const));
}

/** This function gives the problems of a rank floor: it is a whole number of milliseconds up to `RANK_DELAY_LIMIT`. */
export function rankFloorProblems(floor: Duration | undefined): string[] {
  return floor === undefined || (Number.isInteger(floor) && floor >= 0 && floor <= RANK_DELAY_LIMIT)
    ? []
    : [`The rank floor is not a whole number of milliseconds from 0 to ${RANK_DELAY_LIMIT}.`];
}

/** This function gives the rank delay of a level: its entry in the table, or else the default. */
export function rankDelayOf(level: Level, delays: RankDelays | undefined, fallback: Duration | undefined): Duration | undefined {
  return delays?.[level] ?? fallback;
}

/** This function gives the problems of a table of rank delays. Each problem names a level, and each value is a whole number of milliseconds up to `RANK_DELAY_LIMIT`. */
export function rankDelayProblems(delays: RankDelays): string[] {
  return Object.entries(delays).flatMap(([level, delay]) =>
    delay !== undefined && Number.isInteger(delay) && delay >= 0 && delay <= RANK_DELAY_LIMIT ? [] : [`The rank delay of the level ${level} is not a whole number of milliseconds from 0 to ${RANK_DELAY_LIMIT}.`],
  );
}

/** A send that is due. The runtime makes the delivery key with `messageKey` of this value. */
export interface EscalationSend extends MessageKeyInput {
  readonly channel: ChannelId;
  /** The time at which the step became due. It holds `wait`. */
  readonly due: Instant;
  /** The wait of the rank of this copy before the send: `rank × max(rankDelay, floor)` for the channel. At 0, each copy sends the step at once. */
  readonly wait: Duration;
  /** True: the channel sends in its silent mode. The value is for a send at `now`. `Message.quiet` takes it. */
  readonly quiet: boolean;
}

/** The output of `escalate`. */
export interface EscalationPlan {
  readonly state: EscalationState;
  /** The start of the escalation: the earliest of `since` and the start that each delivery of the ledger shows. */
  readonly start: Instant;
  /** The indexes of the steps that are due, in the order of their times. */
  readonly due: readonly number[];
  /** The steps that are due and have no delivery in the ledger. Only `sent`, `last` and `exhausted` have sends. */
  readonly sends: readonly EscalationSend[];
  /** The deliveries to cancel, after an acknowledgment or the end. Each one has a different key. */
  readonly cancels: readonly Delivery[];
  /** The time of the next decision. It is absent when only an acknowledgment or the end can change the state. */
  readonly wakeAt?: Instant;
  /** The first acknowledgment of the person. */
  readonly acknowledgment?: Acknowledgment;
  /** The time of the exhaustion, when it occurred. */
  readonly exhaustedAt?: Instant;
  /** Each transition from the start to `now`. The instance is the anchor, the level and the person. */
  readonly transitions: readonly Transition[];
}

interface Event {
  readonly at: Instant;
  readonly on: (typeof ESCALATION_EVENTS)[keyof typeof ESCALATION_EVENTS];
  /** At one time, an acknowledgment comes first, then the end, then the steps, then the exhaustion. */
  readonly order: number;
  readonly step: number;
}

const FINAL: ReadonlySet<EscalationState> = new Set(["acknowledged", "ended"]);
const ACTIVE: ReadonlySet<EscalationState> = new Set(["sent", "last", "exhausted"]);

/**
 * This function calculates the escalation at `now`. It is pure and total: the same input gives
 * the same plan, and it does not throw. Two copies of the system with the same merge state give the
 * same plan, apart from the wait of their rank.
 *
 * - A step is due at `start + step.at + wait`. The wait of a step is `rank × max(rankDelay, floor)`, with the floor of
 *   the channel of the step. Each due step without a delivery in the ledger is a send, also a late one. The system
 *   prefers a duplicate to a miss.
 * - An acknowledgment stops the sends, and each delivery becomes a cancel. The end does the same.
 * - The exhaustion comes `exhaustedAfter` after the latest due time of a step. The repeats continue after it.
 * - A failed send makes no delivery, so its step stays due and the next plan sends it again.
 * - The delivery is at least once, not exactly once. A crash after a send and before its record
 *   gives a second send with the same `messageKey`. A channel that drops a repeated key drops it.
 * - A send below `life-safety` at `now` in the quiet window of the person is quiet. A send of
 *   `life-safety` is not quiet in the window. A send that a sound rule passes (`sounds`) is not quiet (AL-97).
 * - In the silent mode of a mute, each send is quiet, also at `life-safety`, and the exhaustion does not come.
 */
export function escalate(input: EscalationInput): EscalationPlan {
  const { policy, person, incident, now } = input;
  const level = policy.level;
  const reports = new Set<string>([incident.anchor, ...incident.reports]);
  const ours = (item: { readonly incident: ReportId; readonly level: Level; readonly person: PersonId }): boolean =>
    reports.has(item.incident) && item.level === level && item.person === person;
  const deliveries = input.deliveries.filter(ours);
  const least = LEVELS.indexOf(level);
  const covers = (ack: Acknowledgment): boolean => reports.has(ack.incident) && ack.person === person && LEVELS.indexOf(ack.level) >= least;
  const acknowledgment = input.acknowledgments.filter(covers).sort(byTimeThenVia)[0];
  const steps = policy.steps;
  const rank = nonNegative(input.rank);
  const delay = nonNegative(input.rankDelay);
  // Each step has its wait: a step of an exclusive channel waits at least the floor of the channel for each rank.
  const waits = steps.map((step) => rank * Math.max(delay, nonNegative(input.floors?.get(step.channel))));
  const silent = input.silent === true;
  const quiet = silent || (level !== "life-safety" && input.sounds !== true && inQuietWindow(input.quiet, now));

  // A step time that is not a number of 0 or more counts as 0: escalationProblems reports it, and a send comes early, not late.
  const offsets = steps.map((step) => nonNegative(step.at));

  // Another copy can have started first. Its deliveries show its start.
  let start = Number.isFinite(input.since) ? input.since : now;
  for (const delivery of deliveries) {
    const offset = offsets[delivery.step];
    if (offset !== undefined && Number.isFinite(delivery.at)) start = Math.min(start, delivery.at - offset);
  }

  const dueAt = offsets.map((offset, index) => offset + (waits[index] ?? 0));
  const events: Event[] = dueAt.map((at, index) => ({ at: start + at, on: ESCALATION_EVENTS.step, order: 2, step: index }));
  // The latest due time of a step. A policy with no step has the wait of the rank delay.
  const lastAt = Math.max(rank * delay, ...dueAt);
  // A quiet message asks for no acknowledgment, thus the silent mode has no exhaustion.
  if (!silent) events.push({ at: start + lastAt + nonNegative(policy.exhaustedAfter), on: ESCALATION_EVENTS.exhaust, order: 3, step: -1 });
  // An acknowledgment in the merge state occurred, also when the clock of its copy is ahead or broken.
  if (acknowledgment !== undefined) {
    events.push({ at: Number.isFinite(acknowledgment.at) ? Math.min(acknowledgment.at, now) : now, on: ESCALATION_EVENTS.ack, order: 0, step: -1 });
  }
  if (input.endsAt !== undefined && Number.isFinite(input.endsAt)) events.push({ at: input.endsAt, on: ESCALATION_EVENTS.end, order: 1, step: -1 });
  events.sort((a, b) => a.at - b.at || a.order - b.order || a.step - b.step);

  // An episode that is not a whole number above 0 counts as 0.
  const episode = input.episode !== undefined && Number.isSafeInteger(input.episode) && input.episode > 0 ? input.episode : 0;
  const instance = `${incident.anchor} ${level} ${person}${episode === 0 ? "" : ` ${episode}`}`;
  const transitions: Transition[] = [];
  const due: number[] = [];
  let state: EscalationState = "idle";
  let wakeAt: Instant | undefined;
  let exhaustedAt: Instant | undefined;
  const move = (event: Event, to: EscalationState): void => {
    transitions.push({ machine: ESCALATION_MACHINE.id, instance, from: state, on: event.on, to, at: event.at });
    state = to;
  };

  for (const event of events) {
    if (FINAL.has(state)) break;
    if (event.at > now) {
      wakeAt = event.at;
      break;
    }
    if (event.on === ESCALATION_EVENTS.step) {
      due.push(event.step);
      move(event, due.length === steps.length ? "last" : "sent");
    } else if (event.on === ESCALATION_EVENTS.exhaust) {
      exhaustedAt = event.at;
      move(event, "exhausted");
    } else {
      move(event, event.on === ESCALATION_EVENTS.ack ? "acknowledged" : "ended");
    }
  }

  const delivered = new Set(deliveries.map((delivery) => delivery.step));
  const sends: EscalationSend[] = ACTIVE.has(state)
    ? due.flatMap((index) => {
        const step = steps[index];
        const wait = waits[index] ?? 0;
        return step === undefined || delivered.has(index)
          ? []
          : [{ incident: incident.anchor, level, person, step: index, ...(episode === 0 ? {} : { episode }), channel: step.channel, due: start + (dueAt[index] ?? 0), wait, quiet }];
      })
    : [];

  const cancels: Delivery[] = [];
  if (FINAL.has(state)) {
    const seen = new Set<string>(input.cancelled ?? []);
    for (const delivery of [...deliveries].sort((a, b) => byTime(a.at, b.at) || compareCodeUnits(a.key, b.key))) {
      if (seen.has(delivery.key)) continue;
      seen.add(delivery.key);
      cancels.push(delivery);
    }
  }

  return {
    state,
    start,
    due,
    sends,
    cancels,
    ...(wakeAt === undefined ? {} : { wakeAt }),
    ...(acknowledgment === undefined ? {} : { acknowledgment }),
    ...(exhaustedAt === undefined ? {} : { exhaustedAt }),
    transitions,
  };
}

/**
 * This function gives the problems of a policy. `escalate` accepts each policy, but a policy with a
 * problem does not do what its author meant.
 */
export function escalationProblems(policy: EscalationPolicy): string[] {
  const problems: string[] = [];
  if (policy.steps.length === 0) problems.push(`The policy of ${policy.level} has no step, so nothing reaches the person.`);
  policy.steps.forEach((step, index) => {
    if (!Number.isFinite(step.at) || step.at < 0) problems.push(`Step ${index} has the time ${step.at}. A time is 0 or more.`);
    const before = policy.steps[index - 1];
    if (before !== undefined && step.at < before.at) problems.push(`Step ${index} comes before step ${index - 1}.`);
  });
  if (!Number.isFinite(policy.exhaustedAfter) || policy.exhaustedAfter < 0) problems.push(`exhaustedAfter is ${policy.exhaustedAfter}. It is 0 or more.`);
  return problems;
}

/**
 * This function tells if the time `at` is in the quiet window. It is `inWindow` of
 * `@mark1russell7/algebra/clock`. Thus the window follows the clock of the person when daylight
 * saving time starts or ends. The start is in the window, and the end is not. An end before the
 * start crosses midnight, and an end equal to the start gives the full day.
 *
 * The function does not throw. An absent window, a bad time zone, a bad local time or a bad `at`
 * gives `false`. A message that is not quiet is louder than the person wants, but it is not a miss.
 * `quietWindowProblems` finds a bad window.
 */
export function inQuietWindow(window: QuietWindow | undefined, at: Instant): boolean {
  return window !== undefined && inWindow(at, window);
}

/**
 * This function gives the problems of a quiet window: a bad time zone, a bad local time or a bad sound rule. With a problem
 * of the time, `inQuietWindow` gives `false`. A sound rule with a problem passes no incident.
 */
export function quietWindowProblems(window: QuietWindow): string[] {
  return [...windowProblems(window), ...(window.sounds ?? []).flatMap((rule, index) => soundProblems(rule).map((problem) => `The sound rule ${index + 1}: ${problem}`))];
}

/**
 * The first sound rules of a quiet window (AL-97). An urgent `needs-you` of the operator sounds in the window, at most
 * 2 of them in one window. Each other message below `life-safety` stays quiet. The person chose this rule.
 */
export const DEFAULT_QUIET_SOUNDS: readonly QuietSound[] = [{ kinds: [`${TELL_KIND}.needs-you`], level: "urgent", most: 2 }];

// The problems of one sound rule. A rule with a problem passes no incident.
function soundProblems(rule: QuietSound): string[] {
  const problems: string[] = [];
  if (rule.kinds.length === 0 || rule.kinds.some((kind) => kind.length === 0)) problems.push("Each kind is a prefix that is not empty, and the rule has one kind or more.");
  if (rule.level !== "notice" && rule.level !== "urgent") problems.push("The level is notice or urgent.");
  if (!Number.isInteger(rule.most) || rule.most < 0) problems.push("The most is a whole number, 0 or more.");
  return problems;
}

/** One delivery to the person, with the kind of its incident. `soundsInQuiet` counts these deliveries. */
export interface SoundDelivery {
  readonly incident: ReportId;
  readonly level: Level;
  readonly at: Instant;
  /** The kind code of the incident of the delivery, or `undefined` when the state does not hold that incident. */
  readonly kind: string | undefined;
}

/** The incident of `soundsInQuiet`: its anchor, each of its reports and its kind code. */
export interface SoundIncident {
  readonly anchor: ReportId;
  readonly reports: ReadonlySet<string>;
  readonly kind: string;
}

/**
 * This function tells if a sound rule of the quiet window passes the incident at `now` (AL-97). Then its sends at the
 * level are not quiet in the window.
 *
 * - Out of the window, or with no window, the function gives `false`. Out of the window, no send is quiet.
 * - The first rule (`QuietWindow.sounds`, else `DEFAULT_QUIET_SOUNDS`) with the kind and the level of the incident applies.
 *   With no such rule, or with a rule that has a problem, the function gives `false`.
 * - The deliveries of the person in this window give the incidents of the rule, in the order of their first delivery.
 *   The incident sounds when fewer than `most` other incidents of the rule came before it. Thus a repeat of a loud
 *   incident stays loud, and each copy with the same deliveries gives the same count.
 * - A delivery is in this window when it is in the window, and the window did not close after it. A window of the full
 *   day counts the last 24 hours.
 * - A delivery of an incident that the state does not hold has no kind. It does not count. Thus an error gives fewer sounds.
 */
export function soundsInQuiet(window: QuietWindow | undefined, incident: SoundIncident, level: Level, deliveries: readonly SoundDelivery[], now: Instant): boolean {
  if (window === undefined || !inQuietWindow(window, now)) return false;
  const passes = (rule: QuietSound, kind: string | undefined, at: Level): boolean =>
    kind !== undefined && hasKind(rule.kinds, kind) && LEVELS.indexOf(at) >= LEVELS.indexOf(rule.level);
  const rule = (window.sounds ?? DEFAULT_QUIET_SOUNDS).find((item) => passes(item, incident.kind, level));
  if (rule === undefined || soundProblems(rule).length > 0) return false;
  const tonight = (at: Instant): boolean => {
    if (!Number.isFinite(at) || at > now || !inQuietWindow(window, at)) return false;
    const close = nextBoundary(at, window);
    return close === undefined ? now - at < WALL_DAY : close.at > now;
  };
  // The first delivery of each incident of the rule in this window. The own incident has the key of its anchor.
  const firsts = new Map<string, Instant>();
  for (const delivery of deliveries) {
    if (!tonight(delivery.at) || !passes(rule, delivery.kind, delivery.level)) continue;
    const key = incident.reports.has(delivery.incident) ? incident.anchor : delivery.incident;
    firsts.set(key, Math.min(firsts.get(key) ?? Number.POSITIVE_INFINITY, delivery.at));
  }
  const own = firsts.get(incident.anchor);
  let before = 0;
  for (const [key, at] of firsts) {
    if (key === incident.anchor) continue;
    if (own === undefined || at < own || (at === own && compareCodeUnits(key, incident.anchor) < 0)) before += 1;
  }
  return before < rule.most;
}

/** The form of a local time of each day: `HH:MM`, from `00:00` to `23:59`. */
const DAILY_FORM = /^([01][0-9]|2[0-3]):([0-5][0-9])$/u;

/** One day of 24 hours on the wall clock, in milliseconds. */
const WALL_DAY = 86_400_000;

/** This function gives the problems of a daily time: a bad time zone or a bad local time. */
export function dailyTimeProblems(daily: DailyTime): string[] {
  const problems: string[] = [];
  if (localTime(0, daily.zone) === undefined) problems.push(`The time zone ${daily.zone} is not an IANA time zone.`);
  if (!DAILY_FORM.test(daily.time)) problems.push(`The time ${daily.time} is not a local time HH:MM from 00:00 to 23:59.`);
  return problems;
}

/**
 * This function gives the instant of a daily time near `at`. It is the last one at or before `at`. With `next`, it is
 * the first one after `at`. A bad daily time or a bad `at` gives `undefined`, and `dailyTimeProblems` finds the bad time.
 *
 * - A local time in the gap of a change forward gives the end of the gap. Thus each day has its instant.
 * - A local time in the hour of a change back occurs two times. Only the first instant counts.
 */
export function dailyInstant(daily: DailyTime, at: Instant, next = false): Instant | undefined {
  const form = DAILY_FORM.exec(daily.time);
  const local = form === null || !Number.isFinite(at) ? undefined : localTime(at, daily.zone);
  if (form === null || local === undefined) return undefined;
  const wall = Date.UTC(local.year, local.month - 1, local.day, Number(form[1]), Number(form[2]));
  // The wall clock of today, then of the day before or after. A day of 23 or 25 hours moves the instant by one hour at most.
  for (let days = 0; days <= 2; days += 1) {
    const instant = firstInstantOf(wall + (next ? days : -days) * WALL_DAY, daily.zone);
    if (instant !== undefined && (next ? instant > at : instant <= at)) return instant;
  }
  return undefined;
}

/**
 * This function gives the daily time of the digest of a person. It is the time of the digest policy, or else the end
 * of the quiet window of the person. With neither, it gives `undefined`, and the person gets no digest.
 */
export function digestTimeOf(policy: EscalationPolicy, quiet: QuietWindow | undefined): DailyTime | undefined {
  return policy.daily ?? (quiet === undefined ? undefined : { zone: quiet.zone, time: quiet.end });
}

const nonNegative = (value: number | undefined): number => (value !== undefined && Number.isFinite(value) && value > 0 ? value : 0);

/** This order puts a time that is not a number last, so the order of the input has no effect. */
const byTime = (a: number, b: number): number => {
  const x = Number.isFinite(a) ? a : Number.POSITIVE_INFINITY;
  const y = Number.isFinite(b) ? b : Number.POSITIVE_INFINITY;
  return x < y ? -1 : x > y ? 1 : 0;
};

function byTimeThenVia(a: Acknowledgment, b: Acknowledgment): number {
  return byTime(a.at, b.at) || compareCodeUnits(a.via, b.via);
}
