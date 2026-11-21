/**
 * This module plans the digest: one message each day for each person with a policy of the level `digest`. It is
 * pure. The runtime gives the time, and the runtime does each call of a channel.
 *
 * The digest tells two kinds of incidents:
 *
 * - Each live incident of the level `digest` for the person that no earlier digest told, and that no louder message told.
 * - Each incident that a quiet message of the level `notice` or `urgent` told in the quiet window since the digest time before.
 *   Thus the morning digest tells again what came in the night.
 * - Each incident that the send limit held or the throttle stopped since the digest time before, with no message to the person (AL-72).
 *
 * The record of a digest is one delivery for each incident in it (`digestDeliveries`). The merge state keeps each delivery, thus
 * a restart and each other copy of the system know which incidents a digest told. A send that failed makes no record, thus
 * the digest stays due.
 */
import { compareCodeUnits } from "@mark1russell7/text/order";
import { assess, DEFAULT_ASSESS_POLICY, foreignIncidents, reachedAssessment } from "./assess.ts";
import {
  LEVELS,
  type AssessPolicy,
  type ChannelDescriptor,
  type ChannelId,
  type Delivery,
  type Duration,
  type Incident,
  type Instant,
  type Level,
  type MergeState,
  type Message,
  type PersonId,
  type Receipt,
  type Report,
  type WatchedPlace,
} from "./contracts.ts";
import { incidentTitle, policyFor, type EscalationHold, type Recipient } from "./delivery.ts";
import { dailyInstant, digestTimeOf, inQuietWindow, rankDelayOf, rankFloors, type RankDelays } from "./escalation.ts";
import { digestEntryKey, digestKey } from "./ids.ts";

/** The input of `planDigests`. */
export interface DigestInput {
  readonly state: MergeState;
  /** The incidents of the merge state at `now`. */
  readonly incidents: readonly Incident[];
  readonly recipients: readonly Recipient[];
  readonly places: readonly WatchedPlace[];
  /** The policy of the assessment. The default is `DEFAULT_ASSESS_POLICY`. */
  readonly assess?: AssessPolicy | undefined;
  /** The ids of the sources of this copy, as `RouteInput.sources` tells (AL-76). Without the set, each source is a source of this copy. */
  readonly sources?: ReadonlySet<string> | undefined;
  /** The channels of the system. The rank floor applies to the exclusive channels. */
  readonly channels: readonly ChannelDescriptor[];
  /** The rank of this copy of the system, from 0. A copy waits `rank × max(rank delay, floor)` before each send. */
  readonly rank?: number | undefined;
  /** The default wait of one rank. */
  readonly rankDelay?: Duration | undefined;
  /** The wait of one rank for each level. The entry `digest` applies. */
  readonly rankDelays?: RankDelays | undefined;
  /** The least wait of one rank before a send on an exclusive channel. */
  readonly rankFloor?: Duration | undefined;
  /** The holds of the send limit (`limitRoutes`) and the suppressions of the throttle (`throttleRoutes`). The default is no hold. */
  readonly holds?: readonly EscalationHold[] | undefined;
  readonly now: Instant;
}

/** One incident in a digest. */
export interface DigestEntry {
  readonly incident: Incident;
  /** `digest`, or the highest level of a quiet message or a hold of the incident for the person since the digest before. */
  readonly level: Level;
}

/** One digest message of one person on one step of the digest policy. */
export interface DigestSend {
  readonly person: PersonId;
  readonly channel: ChannelId;
  /** The index of the step in the digest policy, from 0. */
  readonly step: number;
  /** The digest time: the last instant of the daily time at or before `now`. */
  readonly at: Instant;
  /** The time at which the send is due: the digest time, then the time of the step, then the wait of the rank. */
  readonly due: Instant;
  /** The key of the message, from `digestKey`. */
  readonly key: string;
  /** True when `now` is in the quiet window of the person. */
  readonly quiet: boolean;
  /** The incidents of the digest, from the highest level, then from the earliest receipt. */
  readonly entries: readonly DigestEntry[];
}

/** The digests at `now`. */
export interface DigestPlan {
  /** The digest messages that are due at `now`. */
  readonly sends: readonly DigestSend[];
  /** The earliest time after `now` at which a digest can come due. */
  readonly wakeAt?: Instant;
}

/**
 * This function gives the digests at `now`. A person gets a digest when the person has a policy of the level `digest`
 * with no subject, and a daily time (`digestTimeOf`). Each step of the policy sends one message on its channel.
 *
 * - The digest time is the last instant of the daily time at or before `now`. A digest tells only the incidents that
 *   the system got at or before the digest time. Thus a later incident waits for the next digest, also when the digest
 *   of today had nothing to tell.
 * - An incident of the level `digest` goes in one digest of each step. A delivery of a louder level to the person
 *   keeps it out, because the person already has its message.
 * - A quiet message of `notice` or `urgent` in the quiet window puts its incident in the digest again. The message is after
 *   the digest time before, and at or before the digest time. The entry has the highest such level. A digest of this
 *   digest time that told the incident keeps it out.
 * - A hold of the send limit or a suppression of the throttle puts its incident in the digest. This applies only when
 *   the person has no message of the incident. The hold is after the digest time before, and at or before the digest
 *   time. The entry has the highest level of such holds. A digest of this digest time that told the incident keeps it
 *   out.
 * - A digest with no incident sends nothing.
 * - Each step of a person sends one digest for each digest time, across the copies. A digest delivery of the step at or
 *   after the digest time keeps the step quiet. Thus the entries that only this copy knows wait for the next digest.
 * - A runtime that was down at the digest time sends the digest when it comes back, until the next digest time.
 */
export function planDigests(input: DigestInput): DigestPlan {
  const { state, now } = input;
  const policy = input.assess ?? DEFAULT_ASSESS_POLICY;
  const floors = rankFloors(input.channels, input.rankFloor);
  const rank = nonNegative(input.rank);
  const delay = nonNegative(rankDelayOf("digest", input.rankDelays, input.rankDelay));
  const isForeign = foreignIncidents(state.reports, input.sources);
  const received = new Map<string, Instant>();
  for (const report of state.reports) {
    const known = received.get(report.id);
    if (Number.isFinite(report.received) && (known === undefined || report.received < known)) received.set(report.id, report.received);
  }
  // The earliest receipt of a report of the incident. An incident with no time of receipt is not in a digest.
  const receiptOf = (incident: Incident): Instant => Math.min(...[incident.anchor, ...incident.reports].map((id) => received.get(id) ?? Number.POSITIVE_INFINITY));
  const sends: DigestSend[] = [];
  const wakes: Instant[] = [];
  for (const recipient of input.recipients) {
    const { watch } = recipient;
    const person = watch.person;
    const digest = policyFor(recipient.policies, "digest", { status: "actual", about: [] });
    const daily = digest === undefined ? undefined : digestTimeOf(digest, watch.quiet);
    if (digest === undefined || daily === undefined) continue;
    const waitOf = (channel: ChannelId): Duration => rank * Math.max(delay, floors.get(channel) ?? 0);
    const upcoming = dailyInstant(daily, now, true);
    if (upcoming !== undefined) for (const step of digest.steps) wakes.push(upcoming + nonNegative(step.at) + waitOf(step.channel));
    const at = dailyInstant(daily, now);
    if (at === undefined) continue;
    const before = dailyInstant(daily, at - 1);
    const mine = state.deliveries.filter((delivery) => delivery.person === person);
    const holds = (input.holds ?? []).filter((hold) => hold.person === person && hold.at <= at && (before === undefined || hold.at > before));
    digest.steps.forEach((step, index) => {
      // Another copy, or this copy before a restart, sent the digest of this time and step. Its record is in the shared ledger.
      if (mine.some((delivery) => delivery.level === "digest" && delivery.step === index && delivery.at >= at)) return;
      const entries: DigestEntry[] = [];
      for (const incident of input.incidents) {
        const reports = new Set<string>([incident.anchor, ...incident.reports]);
        const own = mine.filter((delivery) => reports.has(delivery.incident));
        const told = own.filter((delivery) => delivery.level === "digest" && delivery.step === index);
        const louder = own.filter((delivery) => delivery.level !== "digest");
        const night = louder.filter(
          (delivery) => delivery.level !== "life-safety" && delivery.at <= at && (before === undefined || delivery.at > before) && inQuietWindow(watch.quiet, delivery.at),
        );
        if (night.length > 0) {
          if (!told.some((delivery) => delivery.at >= at)) entries.push({ incident, level: highest(night.map((delivery) => delivery.level)) });
          continue;
        }
        const held = louder.length === 0 ? holds.filter((hold) => reports.has(hold.incident)) : [];
        if (held.length > 0) {
          if (!told.some((delivery) => delivery.at >= at)) entries.push({ incident, level: highest(held.map((hold) => hold.level)) });
          continue;
        }
        if (louder.length > 0 || told.length > 0 || !incident.live || !(receiptOf(incident) <= at)) continue;
        if (reachedAssessment(assess(incident, watch, input.places, policy, now, isForeign(incident))).level === "digest") entries.push({ incident, level: "digest" });
      }
      if (entries.length === 0) return;
      const due = at + nonNegative(step.at) + waitOf(step.channel);
      if (now < due) {
        wakes.push(due);
        return;
      }
      entries.sort(
        (a, b) => LEVELS.indexOf(b.level) - LEVELS.indexOf(a.level) || receiptOf(a.incident) - receiptOf(b.incident) || compareCodeUnits(a.incident.anchor, b.incident.anchor),
      );
      sends.push({ person, channel: step.channel, step: index, at, due, key: digestKey({ person, at, step: index }), quiet: inQuietWindow(watch.quiet, now), entries });
    });
  }
  const later = wakes.filter((time) => Number.isFinite(time) && time > now);
  return later.length === 0 ? { sends } : { sends, wakeAt: Math.min(...later) };
}

/**
 * This function makes the message of a digest. The title has the count of the incidents. The body has one line for
 * each incident: its title (`incidentTitle`), after its level when the level is not `digest`. The channel cuts the text
 * to its limits. The incident of the message is the first incident of the digest.
 */
export function digestMessageOf(send: DigestSend, reports: readonly Report[]): Message {
  const count = send.entries.length;
  const lines = send.entries.map((entry) => `- ${entry.level === "digest" ? "" : `${entry.level}: `}${incidentTitle(entry.incident, reports)}`);
  return {
    key: send.key,
    person: send.person,
    level: "digest",
    title: count === 1 ? "The digest: 1 alert" : `The digest: ${String(count)} alerts`,
    body: lines.join("\n"),
    // A send of `planDigests` has one incident or more.
    incident: send.entries[0]!.incident.anchor,
    quiet: send.quiet,
  };
}

/**
 * This function gives the record of a digest that a channel accepted. The record is one delivery of the level `digest`
 * for each incident of the digest. Each delivery has the time of the accept and the receipt of the channel.
 */
export function digestDeliveries(send: DigestSend, accepted: Instant, receipt?: Receipt): Delivery[] {
  return send.entries.map((entry) => ({
    key: digestEntryKey(send.key, entry.incident.anchor),
    incident: entry.incident.anchor,
    level: "digest",
    person: send.person,
    channel: send.channel,
    step: send.step,
    at: accepted,
    ...(receipt === undefined ? {} : { receipt }),
  }));
}

const nonNegative = (value: number | undefined): number => (value !== undefined && Number.isFinite(value) && value > 0 ? value : 0);

// The highest of some levels. An empty list gives `digest`.
const highest = (levels: readonly Level[]): Level => LEVELS[Math.max(0, ...levels.map((level) => LEVELS.indexOf(level)))]!;
