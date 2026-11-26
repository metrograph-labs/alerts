/**
 * This module routes each incident to the escalations of each person. It also makes the message of a
 * send and the acknowledgment of a status. It is pure. The runtime gives the time, and
 * the runtime does each call of a channel.
 */
import { compareCodeUnits } from "@mark1russell7/text/order";
import { assess, COVERAGE_KIND, DEFAULT_ASSESS_POLICY, foreignIncidents, hasKind, LIFE_SAFETY_KINDS, matchSubjects, PERSON_SUBJECT, QUOTA_KIND, reachedAssessment } from "./assess.ts";
import { isPrivate } from "./audience.ts";
import {
  ASSESSED_LEVELS,
  LEVELS,
  type Acknowledgment,
  type Address,
  type AssessedLevel,
  type AssessPolicy,
  type ChannelDescriptor,
  type ChannelId,
  type Delivery,
  type DeliveryStatus,
  type Duration,
  type EscalationPolicy,
  type Incident,
  type Instant,
  type Level,
  type MergeState,
  type Message,
  type PersonId,
  type PersonWatch,
  type Report,
  type ReportId,
  type Status,
  type SubjectWatch,
  type WatchedPlace,
  type WhyRecord,
} from "./contracts.ts";
import { dailyTimeProblems, digestTimeOf, escalate, escalationProblems, quietWindowProblems, rankDelayOf, rankFloors, type EscalationPlan, type EscalationSend, type RankDelays } from "./escalation.ts";
import { messageKey } from "./ids.ts";
import { heldPlaces, type PlaceHolds } from "./place-holds.ts";
import type { Suppression } from "./throttle.ts";
import { unknownKinds } from "./taxonomy.ts";
import { assessmentWhy } from "./why.ts";
import { softwareMatchText, type SoftwareMatch } from "./software.ts";

/** A person of the delivery. The private configuration gives each one. */
export interface Recipient {
  /** The places, the subjects, the rules and the quiet window of the person. */
  readonly watch: PersonWatch;
  /**
   * The escalation policies of the person (`policyFor`). A level with no policy starts no escalation for this person.
   */
  readonly policies: readonly EscalationPolicy[];
  /** The address of the person on each channel, by the channel id. */
  readonly addresses: Readonly<Record<string, Address>>;
  /** The channel rules of the person. `loadConfig` makes two rules for each drill of the person. */
  readonly channelRules?: readonly ChannelRule[];
}

/** The statuses of the incidents that a channel rule can change. A rule does not change the steps of a real warning. */
export const RULED_STATUSES: readonly Status[] = ["system", "test", "exercise"];

/**
 * A channel rule of a person: the channels of the steps for the incidents of some kinds. A rule applies only to an
 * incident with a status of `RULED_STATUSES`. A rule has no status field, thus no rule changes an incident `actual`.
 */
export interface ChannelRule {
  /** The kinds of the rule: prefixes of the taxonomy. */
  readonly kinds: readonly string[];
  /** The subject of the rule. Without it, the rule applies to each incident of its kinds. */
  readonly about?: SubjectWatch;
  /** With `only`, only the steps on the channels stay. With `except`, the steps on the channels go. */
  readonly keep: "only" | "except";
  readonly channels: readonly ChannelId[];
}

/** The policy of an incident after the channel rules of a person. */
export interface RuledPolicy {
  /** The policy with only the steps that stay. */
  readonly policy: EscalationPolicy;
  /** The indexes of the rules that apply to the incident. */
  readonly rules: readonly number[];
  /** The indexes of the steps of the policy that the rules remove. */
  readonly dropped: readonly number[];
}

/**
 * This function applies the channel rules of a person to the policy of an incident. Each rule that matches the kind and
 * the subject of the incident applies. A step stays only when each of these rules keeps it. An incident with a status
 * out of `RULED_STATUSES` keeps each step.
 */
export function ruleSteps(policy: EscalationPolicy, rules: readonly ChannelRule[] | undefined, incident: Pick<Incident, "status" | "kind" | "about">): RuledPolicy {
  if (rules === undefined || rules.length === 0 || !RULED_STATUSES.includes(incident.status)) return { policy, rules: [], dropped: [] };
  const matched = rules.flatMap((rule, index) => (hasKind(rule.kinds, incident.kind.code) && (rule.about === undefined || matchSubjects(incident, [rule.about]).length > 0) ? [index] : []));
  if (matched.length === 0) return { policy, rules: [], dropped: [] };
  const keeps = (channel: ChannelId): boolean => matched.every((index) => rules[index]!.channels.includes(channel) === (rules[index]!.keep === "only"));
  const dropped = policy.steps.flatMap((step, index) => (keeps(step.channel) ? [] : [index]));
  return { policy: dropped.length === 0 ? policy : { ...policy, steps: policy.steps.filter((step) => keeps(step.channel)) }, rules: matched, dropped };
}

/**
 * This function gives the policy of a level for an incident. An incident with a status of `RULED_STATUSES` gets the
 * first policy of the level whose subject matches a subject of the incident (`matchSubjects`). Each other incident,
 * and an incident with no such policy, gets the first policy of the level with no subject.
 */
export function policyFor(policies: readonly EscalationPolicy[], level: Level, incident: Pick<Incident, "status" | "about">): EscalationPolicy | undefined {
  const ofLevel = policies.filter((policy) => policy.level === level);
  const ruled = RULED_STATUSES.includes(incident.status);
  const about = ruled ? ofLevel.find((policy) => policy.about !== undefined && matchSubjects(incident, [policy.about]).length > 0) : undefined;
  return about ?? ofLevel.find((policy) => policy.about === undefined);
}

/**
 * This function gives the name of a policy in a problem: its level, and its subject when it has one.
 */
export function policyName(policy: EscalationPolicy): string {
  const about = policy.about;
  return about === undefined ? policy.level : `${policy.level} about ${about.system}${about.id === undefined ? "" : ` ${about.id}`}`;
}

/**
 * The start of an escalation: the time at which the level of an incident first called for it. The
 * runtime keeps each start in its log, thus the start does not move after a restart.
 */
export interface EscalationStart {
  /** A report of the incident: its anchor at the start. */
  readonly incident: ReportId;
  readonly level: Level;
  readonly person: PersonId;
  readonly at: Instant;
  /**
   * True: the escalation is in the silent mode of a mute with the effect `silent`. Its episode sends one quiet message
   * at most: its step 0, when the person has no delivery of the incident.
   */
  readonly silent?: true;
}

/**
 * The reason of an end of a person.
 * - `ended`: the threat left the person, for example after a cancel of the area of the person.
 * - `muted`: a mute of the person changed. A mute with the effect `absent` started, or the mode of the escalation
 *   changed between loud and silent.
 *
 * The runtime sends no message for an end. An acknowledgment before an end `muted` still covers the next episode.
 */
export type EndReason = "ended" | "muted";

/**
 * The end of the escalations of a person in a live incident. The incident no longer reaches the person, for example
 * after a cancel of the area of the person, or a mute changed. The runtime keeps each end in its log. A later match of
 * the person starts a new episode, and the sends of the new episode get new message keys.
 */
export interface EscalationEnd {
  /** A report of the incident: its anchor at the end. */
  readonly incident: ReportId;
  readonly person: PersonId;
  readonly at: Instant;
  /** The reason of the end. An end with no reason is an end `ended`. */
  readonly reason?: EndReason;
}

/**
 * A hold of an escalation by the send limit of the person (`limitRoutes`, AL-72). The escalation sends nothing in its
 * episode, and the next digest tells its incident. The runtime keeps each hold in its own log.
 */
export interface EscalationHold {
  /** The report of the start of the escalation. */
  readonly incident: ReportId;
  readonly level: Level;
  readonly person: PersonId;
  /** The episode of the escalation. A later episode of the incident is a new escalation, and it needs a new place. */
  readonly episode: number;
  readonly at: Instant;
}

/** The input of `route`. */
export interface RouteInput {
  /** The merge state. Its deliveries and its acknowledgments go to each escalation. */
  readonly state: MergeState;
  /** The incidents of the merge state at `now`. */
  readonly incidents: readonly Incident[];
  readonly recipients: readonly Recipient[];
  readonly places: readonly WatchedPlace[];
  /**
   * The holds of the moving places (`holdPlaces`, AL-40). Each incident reads its places with its holds (`heldPlaces`). Without
   * them, each incident reads `places`.
   */
  readonly holds?: PlaceHolds | undefined;
  /** The policy of the assessment. The default is `DEFAULT_ASSESS_POLICY`. */
  readonly assess?: AssessPolicy | undefined;
  /**
   * The ids of the sources that this copy runs by its config, also a source whose fetch fails at this time (AL-76). A kind with
   * no class in an incident of only other sources gets `FOREIGN_TABLE`. Without the set, each source is a source of this copy.
   */
  readonly sources?: ReadonlySet<string> | undefined;
  /** The starts that the log has. They are the starts of this copy: the copies do not share their starts. */
  readonly starts: readonly EscalationStart[];
  /** The ends that the log has. The default is none. */
  readonly ends?: readonly EscalationEnd[] | undefined;
  /** The delivery keys with no more repeats. */
  readonly cancelled: ReadonlySet<string>;
  /** The descriptor of each channel. A delivery of a channel with the acknowledgment `poll` gets a poll. */
  readonly channels: readonly ChannelDescriptor[];
  /** The rank of this copy of the system, and the wait of each rank. `escalate` tells how they apply. */
  readonly rank?: number | undefined;
  /** The default wait of one rank: the wait of each level with no entry in `rankDelays`. */
  readonly rankDelay?: Duration | undefined;
  /** The wait of one rank for each level. With 0 for `life-safety`, each copy sends a life-safety step at once. */
  readonly rankDelays?: RankDelays | undefined;
  /**
   * The least wait of one rank before a step of an exclusive channel, as a call. A step of the channel waits
   * `rank × max(rankDelay, rankFloor)`. Without it, the channels have no floor.
   */
  readonly rankFloor?: Duration | undefined;
  readonly now: Instant;
}

/** One escalation: one incident, one level and one person. */
export interface Route {
  readonly incident: Incident;
  readonly person: PersonId;
  /** The policy of the plan: the policy of the person for the level, with only the steps that the channel rules keep. */
  readonly policy: EscalationPolicy;
  /**
   * The channel rules of the person that apply to the incident (`ruleSteps`), and the steps of the policy of the person
   * that they remove. Thus the explain and the map can tell why a step is absent.
   */
  readonly ruled?: { readonly rules: readonly number[]; readonly dropped: readonly number[] };
  /** The start of the escalation. When `fresh` is true, the log does not have it, and the runtime writes it. */
  readonly start: EscalationStart;
  readonly fresh: boolean;
  /** The deliveries of this escalation in the ledger. */
  readonly deliveries: readonly Delivery[];
  /** The deliveries that need a poll for an acknowledgment: each one with a receipt, no cancel and a channel that polls. */
  readonly polls: readonly Delivery[];
  readonly plan: EscalationPlan;
  /** The episode of the escalation: the count of the earlier ends of the person in the incident. Its sends have it. */
  readonly episode: number;
  /**
   * The end of the episode: the end in the log, or the end at `now` when the live incident no longer reaches the
   * person. When `freshEnd` is true, the log does not have the end, and the runtime writes it.
   */
  readonly end?: EscalationEnd;
  readonly freshEnd: boolean;
  /**
   * Why the incident reaches the person (`assessmentWhy`): the why of the interest graph, or else the watched place of
   * the match with the first id. A route of an incident that is not live has no why. A match by the subjects of
   * `PersonWatch.subjects` has no why.
   */
  readonly why?: WhyRecord;
  /** The matches of the advisory to the parts of the software that the person watches (AL-197). The message names each. */
  readonly software?: readonly SoftwareMatch[];
  /** The hold of the send limit (`limitRoutes`). A held route has no send in its plan. Its cancels stay. */
  readonly held?: EscalationHold;
  /**
   * This value is true when only the deliveries of another copy give the level, and the own assessment of the live
   * incident is lower (AL-76). This copy has no start at the level. The route sends nothing, writes no start and gives
   * no exhaustion. Its polls, its cancels and its end stay.
   */
  readonly imported?: true;
  /**
   * The first suppression of the throttle (`throttleRoutes`), when the escalation has no delivery. The person did not get
   * its message, thus such a route gives no exhaustion.
   */
  readonly suppressed?: Suppression;
}

/**
 * This function gives a reader of the items of a set of report ids. The reader gives the items in the order of the
 * list, so it gives the value of a filter of the list.
 */
function byReport<T extends { readonly incident: ReportId }>(items: readonly T[]): (reports: ReadonlySet<string>) => T[] {
  const index = new Map<string, number[]>();
  items.forEach((item, at) => {
    const held = index.get(item.incident);
    if (held === undefined) index.set(item.incident, [at]);
    else held.push(at);
  });
  return (reports) => {
    const found: number[] = [];
    for (const report of reports) for (const at of index.get(report) ?? []) found.push(at);
    return found.sort((a, b) => a - b).map((at) => items[at]!);
  };
}

/**
 * This function gives the escalations at `now`, in the order of the anchor, the person, the episode and the level.
 *
 * - The levels of an incident and a person are each level of a start or a delivery, and the assessed level.
 *   The assessed level counts only when it is higher than those levels and the person has a policy for it.
 *   An incident that is not live has no assessed level.
 * - Only the highest level continues. A lower level ends at the start of a higher level, thus its repeats stop.
 *   An acknowledgment of the higher level also covers each lower level.
 * - Thus the level does not go down. An escalation continues until an acknowledgment, the end of the incident or the end of the person.
 * - The end of the person: when a live incident no longer reaches a person (the assessed level is `none`), each
 *   escalation of the person ends at `now`. The route gives that end (`freshEnd`), and the runtime writes it to the log.
 * - Each end of the log closes an episode of the person. A later match starts a new episode with new message keys. Its starts,
 *   its deliveries and its acknowledgments come after the end. An acknowledgment between the end and the new start covers nothing.
 * - A mute of the assessment (`Assessment.muted`) with the effect `absent` gives the level `none`. Its end has the reason `muted`.
 * - A mute with the effect `silent` keeps the level and sets the silent mode. A change between loud and silent ends the
 *   episode at `now` with the reason `muted`. The next episode starts in the new mode at once.
 * - A silent episode sends one quiet step 0 at most, only when the person has no delivery of the incident. Thus a mute
 *   after a loud alert sends no copy, and a mute before the incident still gives one quiet message.
 * - An end `muted` keeps the acknowledgments of the episode before it. Thus a change of a mute does not alert again.
 * - An earlier episode gets an escalation only when one of its deliveries has no cancel. Its end is its end in the log.
 * - An incident that is not live gets an escalation only when one of its deliveries has no cancel. Its end is its expiry, or `now`.
 * - The start of an escalation is the start in the log. A new escalation starts at `now`, or earlier when the ledger shows an earlier start.
 * - The channel rules of the person (`ruleSteps`) remove steps of a system, test or exercise incident before the plan.
 * - The level `digest` has no escalation. The digest (`planDigests`) tells it, thus a route has no delivery and no start of it.
 * - Copies of two builds (AL-76). A level with no start of this copy, above the own assessment of the live incident,
 *   comes only from the deliveries of another copy. Its route sends nothing and writes no start (`Route.imported`).
 *   The level still holds the top, thus a lower own level starts nothing. A later own assessment at that level sends.
 * - A kind with no class in an incident of only the sources of other copies (`RouteInput.sources`) gets `FOREIGN_TABLE`.
 * - A hold of a moving place (`RouteInput.holds`) keeps its match after the fix leaves the area. Thus a flap at the edge starts no new episode.
 */
export function route(input: RouteInput): Route[] {
  const { state, now } = input;
  const policy = input.assess ?? DEFAULT_ASSESS_POLICY;
  const polling = new Set(input.channels.filter((channel) => channel.ack === "poll").map((channel) => channel.id as string));
  const floors = rankFloors(input.channels, input.rankFloor);
  const routes: Route[] = [];
  // The parts of each report id. Thus each incident reads only its own parts, not each part of the state.
  const deliveriesOf = byReport(state.deliveries.filter((delivery) => delivery.level !== "digest"));
  const startsOf = byReport(input.starts);
  const acksOf = byReport(state.acks);
  const endsOf = byReport(input.ends ?? []);
  const isForeign = foreignIncidents(state.reports, input.sources);
  for (const incident of input.incidents) {
    const reports = new Set<string>([incident.anchor, ...incident.reports]);
    const foreign = isForeign(incident);
    // A delivery of a digest is not a step of an escalation. The digest plan reads it.
    const deliveries = deliveriesOf(reports);
    const open = deliveries.some((delivery) => !input.cancelled.has(delivery.key));
    if (!incident.live && !open) continue;
    const starts = startsOf(reports);
    const acks = acksOf(reports);
    const ends = endsOf(reports);
    const end = endOf(incident, now);
    // The places of the incident: a moving place with a hold keeps its match after its fix leaves the area (AL-40).
    const places = input.holds === undefined ? input.places : heldPlaces(incident, input.places, input.holds);
    // The parts of each person, one time for each incident. Thus each person reads only its own parts (AL-136).
    const endsBy = Map.groupBy(ends, (item) => item.person);
    const startsBy = Map.groupBy(starts, (item) => item.person);
    const deliveriesBy = Map.groupBy(deliveries, (item) => item.person);
    const acksBy = Map.groupBy(acks, (item) => item.person);
    for (const recipient of input.recipients) {
      const person = recipient.watch.person;
      const policyOf = (level: Level): EscalationPolicy | undefined => policyFor(recipient.policies, level, incident);
      const myEnds = endsBy.get(person) ?? [];
      const myStarts = startsBy.get(person) ?? [];
      const myDeliveries = deliveriesBy.get(person) ?? [];
      const myAcks = acksBy.get(person) ?? [];
      // The ends of the person in time order. Each one closes an episode. A change of the mode adds its end at `now`.
      const closes: EscalationEnd[] = myEnds
        .filter((item) => Number.isFinite(item.at))
        .sort((a, b) => a.at - b.at || compareCodeUnits(a.incident, b.incident));
      // The episode of a time: the count of the ends before it. A time that is not a number is in the first episode.
      const episodeOf = (at: Instant): number => closes.filter((close) => close.at < at).length;
      // The first time of an episode: its earliest start or delivery, or `now`.
      const firstOf = (episode: number): Instant =>
        Math.min(now, ...[...myStarts, ...myDeliveries].filter((item) => episodeOf(item.at) === episode).map((item) => item.at).filter(Number.isFinite));
      const assessment = incident.live ? assess(incident, recipient.watch, places, policy, now, foreign) : undefined;
      // A mute with the effect `absent` keeps the incident from the person. With `silent`, the level stays and the mode changes.
      const muted = assessment?.muted;
      const assessed: AssessedLevel | undefined = assessment === undefined ? undefined : reachedAssessment(assessment).level;
      const silentNow = muted?.effect === "silent";
      for (let episode = 0; episode <= closes.length; episode += 1) {
        const closed = closes[episode];
        const current = closed === undefined;
        const ownStarts = myStarts.filter((item) => episodeOf(item.at) === episode);
        const ownDeliveries = myDeliveries.filter((item) => episodeOf(item.at) === episode);
        // An earlier episode continues only to cancel its deliveries with no cancel.
        if (!current && ownDeliveries.every((delivery) => input.cancelled.has(delivery.key))) continue;
        const levels = new Set<Level>();
        for (const item of [...ownStarts, ...ownDeliveries]) levels.add(item.level);
        // The starts are the starts of this copy. A level with no start of this copy and above the own assessment of the
        // live incident comes only from the deliveries of another copy. This copy sends nothing at it (AL-76).
        const startedHere = new Set(ownStarts.map((item) => item.level));
        const lower = assessed === undefined ? undefined : ASSESSED_LEVELS.indexOf(assessed);
        const imported = (level: Level): boolean => current && lower !== undefined && !startedHere.has(level) && ASSESSED_LEVELS.indexOf(level) > lower;
        // The level does not go down: an assessed level below a level of the episode starts nothing.
        const top = Math.max(-1, ...[...levels].map((level) => LEVELS.indexOf(level)));
        // The mode of the episode: silent when each of its starts is silent. With no start, a delivery tells a loud
        // episode, and an episode with neither has the mode of now.
        const known = ownStarts.length > 0 ? ownStarts.every((item) => item.silent === true) : ownDeliveries.length > 0 ? false : undefined;
        const silent = known ?? (current && silentNow);
        // A change of the mode between loud and silent ends the episode now. The next episode starts in the new mode.
        const changed = current && assessed !== undefined && assessed !== "none" && known !== undefined && known !== silentNow;
        if (current && assessed !== undefined && !changed) {
          if (assessed !== "none" && assessed !== "digest" && LEVELS.indexOf(assessed) > top && policyOf(assessed) !== undefined) levels.add(assessed);
        }
        // The live incident no longer reaches the person, or the mode changed: the episode ends now, and the log keeps the end.
        const freshEnd = current && ((assessed === "none" && levels.size > 0) || changed);
        const reason: EndReason = changed || muted?.effect === "absent" ? "muted" : "ended";
        const closing = closed ?? (freshEnd ? { incident: incident.anchor, person, at: now, ...(reason === "ended" ? {} : { reason }) } : undefined);
        if (changed && closing !== undefined) closes.push(closing);
        const why = current && assessment !== undefined ? assessmentWhy(assessment) : undefined;
        const software = current ? (assessment?.reasons ?? []).flatMap((reason) => (reason.kind === "software" ? [reason.match] : [])) : [];
        // A later episode keeps only the acknowledgments from its first time. An end `muted` joins two episodes: the
        // acknowledgments of the episode before it still count, thus a change of a mute does not alert again.
        let from = episode;
        while (from > 0 && closes[from - 1]?.reason === "muted") from -= 1;
        const since = from === 0 ? undefined : firstOf(from);
        const ownAcks = myAcks.filter((ack) => {
          const at = episodeOf(ack.at);
          return at >= from && at <= episode && (since === undefined || ack.at >= since);
        });
        const ordered = LEVELS.filter((level) => levels.has(level));
        // The start in the log of each level, or `undefined`.
        const logged = ordered.map((level) => earliestStart(ownStarts, person, level));
        // A higher level that has no start starts at `now`. A start of a later episode comes after the end before it, also
        // when the clock has not moved past that end. Thus the start is in its own episode.
        const after = closes[episode - 1]?.at;
        const startAt = ordered.map((_, index) => logged[index]?.at ?? (after === undefined ? now : Math.max(now, after + 1)));
        ordered.forEach((level, index) => {
          const endsAt = earliest([end, closing?.at, ...startAt.slice(index + 1)]);
          // A level of the log with no policy now gets a policy with no step: it sends nothing, and its end still stops its repeats.
          // The channel rules of the person remove some steps of a system, test or exercise incident.
          const ruled = ruleSteps(policyOf(level) ?? { level, steps: [], exhaustedAfter: 0 }, recipient.channelRules, incident);
          const chosen = ruled.policy;
          // The silent mode sends step 0 only, and only when the person has no other delivery of the incident.
          const others = silent && myDeliveries.some((item) => item.level !== level || episodeOf(item.at) !== episode);
          const planned = escalate({
            policy: silent ? { ...chosen, steps: others ? [] : chosen.steps.slice(0, 1) } : chosen,
            person,
            incident,
            since: startAt[index]!,
            ...(endsAt === undefined ? {} : { endsAt }),
            deliveries: ownDeliveries,
            acknowledgments: ownAcks,
            cancelled: input.cancelled,
            rank: input.rank,
            rankDelay: rankDelayOf(level, input.rankDelays, input.rankDelay),
            floors,
            quiet: recipient.watch.quiet,
            episode,
            silent,
            now,
          });
          // A level of another copy only keeps its timers, polls and cancels. Its sends and its start are the other copy's.
          const shared = imported(level);
          const plan = shared ? { ...planned, sends: [] } : planned;
          const ours = ownDeliveries.filter((delivery) => delivery.level === level);
          const active = plan.state === "sent" || plan.state === "last" || plan.state === "exhausted";
          const polls = active ? ours.filter((delivery) => delivery.receipt !== undefined && !input.cancelled.has(delivery.key) && polling.has(delivery.channel)) : [];
          const found = logged[index];
          const fresh = found === undefined && !shared;
          const start: EscalationStart = { incident: found?.incident ?? incident.anchor, level, person, at: plan.start, ...(silent ? { silent: true } : {}) };
          routes.push({
            incident,
            person,
            policy: chosen,
            start,
            fresh,
            deliveries: ours,
            polls,
            plan,
            episode,
            ...(ruled.rules.length === 0 ? {} : { ruled: { rules: ruled.rules, dropped: ruled.dropped } }),
            ...(closing === undefined ? {} : { end: closing }),
            freshEnd,
            ...(why === undefined ? {} : { why }),
            ...(software.length === 0 ? {} : { software }),
            ...(shared ? { imported: true as const } : {}),
          });
        });
      }
    }
  }
  return routes.sort(
    (a, b) => compareCodeUnits(a.incident.anchor, b.incident.anchor) || compareCodeUnits(a.person, b.person) || a.episode - b.episode || LEVELS.indexOf(a.policy.level) - LEVELS.indexOf(b.policy.level),
  );
}

/**
 * An exhausted escalation of a real warning (AL-21). The person did not acknowledge the warning in the time of the
 * policy. The function `systemReports` makes a report of it for the people who watch the person.
 */
export interface Exhaustion {
  /** The report of the start of the escalation. It stays the same after a merge of the incident. */
  readonly incident: ReportId;
  readonly person: PersonId;
  readonly level: Level;
  readonly episode: number;
  /** The time of the exhaustion. */
  readonly at: Instant;
  /** The kind of the warning. */
  readonly kind: Incident["kind"];
  /** The title of the warning (`incidentTitle`). Thus the people who watch the person know what the person missed. */
  readonly title: string;
}

/**
 * This function tells if a step of the policy asks the person for an acknowledgment. Such a step is on a channel with
 * an `ack` other than `none`, at a level of its `ackLevels`. A channel with no `ackLevels` asks at each level.
 */
export function asksForAck(policy: EscalationPolicy, channels: readonly ChannelDescriptor[]): boolean {
  const known = new Map(channels.map((channel) => [channel.id, channel]));
  return policy.steps.some((step) => {
    const channel = known.get(step.channel);
    return channel !== undefined && channel.ack !== "none" && (channel.ackLevels === undefined || channel.ackLevels.includes(policy.level));
  });
}

/**
 * This function gives the exhausted escalations of the routes (AL-21). A route gives an exhaustion when all of these
 * are true:
 *
 * - The status of its incident is `actual`. Thus a drill, a test and a report of the system give none, and an
 *   exhaustion does not give another exhaustion.
 * - The state of its plan is `exhausted`. An acknowledgment or the end of the incident ends the exhaustion.
 * - Its policy has a step after the channel rules. A plan that a channel rule empties sent nothing to the person.
 * - A step of its policy asks for an acknowledgment (`asksForAck`). Without such a step, no acknowledgment can come.
 * - The send limit did not hold it (`Route.held`). A held escalation sent nothing, and the digest tells it.
 * - The throttle did not stop it with no delivery (`Route.suppressed`). Such an escalation sent nothing, and the digest tells it.
 * - Its level is not a level of another copy only (`Route.imported`). That copy gives the exhaustion of its own escalation.
 *
 * The reports give the title of each warning (`incidentTitle`).
 */
export function exhaustions(routes: readonly Route[], channels: readonly ChannelDescriptor[], reports: readonly Report[]): Exhaustion[] {
  const found: Exhaustion[] = [];
  for (const entry of routes) {
    const { incident, plan, policy } = entry;
    if (entry.held !== undefined || entry.suppressed !== undefined || entry.imported === true || incident.status !== "actual" || plan.state !== "exhausted" || plan.exhaustedAt === undefined) continue;
    if (policy.steps.length === 0 || !asksForAck(policy, channels)) continue;
    // The people who watch the person are not in the addresses of a private incident: its title stays out (AL-92).
    found.push({ incident: entry.start.incident, person: entry.person, level: policy.level, episode: entry.episode, at: plan.exhaustedAt, kind: incident.kind, title: isPrivate(incident) ? incident.kind.label : incidentTitle(incident, reports) });
  }
  return found;
}

/** The codes that can reach `life-safety`: the life-safety kinds, and the coverage of each of them. */
const LIFE_SAFETY_CODES: readonly string[] = [...LIFE_SAFETY_KINDS, ...LIFE_SAFETY_KINDS.map((kind) => `${COVERAGE_KIND}.${kind}`)];

/** This function tells if two prefixes of the taxonomy share a kind: one of them has the other. */
const overlap = (a: string, b: string): boolean => hasKind([a], b) || hasKind([b], a);

/** This function gives the regular expression of the whole value of a pattern, or `undefined` for a bad pattern. */
function patternOf(source: string): RegExp | undefined {
  try {
    return new RegExp(`^(?:${source})$`, "u");
  } catch {
    return undefined;
  }
}

/**
 * This function gives the problems of an address on a channel, from the fields of its descriptor. A problem
 * names the field and its form, and not its value, because a value can be a secret.
 *
 * - A channel with no list of fields accepts each address.
 * - The address has each necessary field, and each value has the form of its field.
 * - The address has no field that the channel does not read. Thus a typo of a field name is a problem, not a silent default.
 * - A pattern that is not a regular expression is a problem of the channel. The function does not throw.
 */
export function addressProblems(address: Address, channel: ChannelDescriptor): string[] {
  if (channel.address === undefined) return [];
  const problems: string[] = [];
  // Own fields only: a field such as `constructor` is not a field of a plain object.
  const valueOf = (name: string): string | undefined => (Object.hasOwn(address, name) ? address[name] : undefined);
  for (const field of channel.address) {
    const value = valueOf(field.name);
    if (value === undefined) {
      if (field.required) problems.push(`The address on ${channel.id} has no field ${field.name}. The channel needs ${field.form}.`);
      continue;
    }
    const form = patternOf(field.pattern);
    if (form === undefined) problems.push(`The channel ${channel.id} gives the field ${field.name} a pattern that is not a regular expression.`);
    else if (!form.test(value)) problems.push(`The field ${field.name} of the address on ${channel.id} is not ${field.form}.`);
  }
  const names = new Set(channel.address.map((field) => field.name));
  for (const name of Object.keys(address)) if (!names.has(name)) problems.push(`The address on ${channel.id} has the field ${name}, and the channel reads no such field.`);
  return problems;
}

/**
 * This function gives the problems of a recipient. `route` accepts each recipient, but a recipient with
 * a problem does not get what its author meant. A kind with a typo matches no alert, so it can stop a wake.
 *
 * A life-safety alert always gets its escalation. Thus a person who watches a place or a subject has a
 * `life-safety` policy, and no rule keeps a life-safety kind below `life-safety`.
 *
 * Each address on a known channel has the fields of its channel (`addressProblems`). An address on a channel that the
 * system does not know is not a problem: no step can use it.
 */
export function recipientProblems(recipient: Recipient, channels: readonly ChannelDescriptor[]): string[] {
  const problems: string[] = [];
  const known = new Map(channels.map((channel) => [channel.id as string, channel]));
  for (const [id, address] of Object.entries(recipient.addresses)) {
    const channel = known.get(id);
    if (channel !== undefined) problems.push(...addressProblems(address, channel));
  }
  // The level and the subject of each policy. Two policies with the same name: only the first one applies.
  const seen = new Set<string>();
  for (const policy of recipient.policies) {
    const name = policyName(policy);
    if (seen.has(name)) problems.push(`Two policies have the level ${name}. Only the first one applies.`);
    seen.add(name);
    for (const problem of escalationProblems(policy)) problems.push(`The policy of ${name}: ${problem}`);
    policy.steps.forEach((step, index) => {
      if (!known.has(step.channel)) problems.push(`Step ${index} of ${name} uses the channel ${step.channel}, and the system has no such channel.`);
      if (recipient.addresses[step.channel] === undefined) problems.push(`Step ${index} of ${name} uses the channel ${step.channel}, and the person has no address on it.`);
    });
  }
  // A policy with a subject does not apply to a real warning. Thus only a policy with no subject covers life-safety.
  const watches = recipient.watch.places.length > 0 || (recipient.watch.subjects ?? []).length > 0;
  if (watches && !seen.has("life-safety")) problems.push("The person watches a place or a subject, and has no policy of the level life-safety. A life-safety alert sends nothing to the person.");
  // The exhausted escalations of a person go to the other people who watch the person (AL-21), never to the person.
  if ((recipient.watch.subjects ?? []).some((subject) => subject.system === PERSON_SUBJECT && subject.id === recipient.watch.person)) {
    problems.push(`The person watches the subject ${PERSON_SUBJECT} of the person itself. The exhausted escalations of a person never reach that person.`);
  }
  recipient.watch.rules.forEach((rule, index) => {
    for (const code of unknownKinds(rule.kinds ?? [])) problems.push(`Rule ${index} names the kind ${code}, and the taxonomy has no such code. The rule matches no alert of it.`);
    // A rule only at places that the person does not watch matches no alert. A rule with an empty list of kinds also matches none.
    if (rule.max === "life-safety" || (rule.places !== undefined && !rule.places.some((place) => recipient.watch.places.includes(place)))) return;
    const capped = rule.kinds === undefined ? ["each kind"] : rule.kinds.filter((kind) => LIFE_SAFETY_CODES.some((code) => overlap(kind, code)));
    if (capped.length > 0) problems.push(`Rule ${index} keeps ${capped.join(", ")} at ${rule.max} or lower. A life-safety kind is in it, and a rule does not keep a life-safety kind below life-safety.`);
  });
  (recipient.channelRules ?? []).forEach((rule, index) => {
    for (const code of unknownKinds(rule.kinds)) problems.push(`Channel rule ${index} names the kind ${code}, and the taxonomy has no such code.`);
    if (rule.kinds.length === 0) problems.push(`Channel rule ${index} has no kind. It applies to no incident.`);
    for (const channel of rule.channels) if (!known.has(channel)) problems.push(`Channel rule ${index} names the channel ${channel}, and the system has no such channel.`);
  });
  if (recipient.watch.quiet !== undefined) for (const problem of quietWindowProblems(recipient.watch.quiet)) problems.push(`The quiet window: ${problem}`);
  // The time of the digest: the daily time of the policy, or the end of the quiet window. Neither is a problem, not a silent default.
  for (const policy of recipient.policies) {
    const name = policyName(policy);
    if (policy.daily !== undefined && policy.level !== "digest") problems.push(`The policy of ${name} has a daily time. Only a policy of the level digest uses it.`);
    if (policy.daily !== undefined) for (const problem of dailyTimeProblems(policy.daily)) problems.push(`The daily time of the policy of ${name}: ${problem}`);
    if (policy.level === "digest" && digestTimeOf(policy, recipient.watch.quiet) === undefined) {
      problems.push(`The policy of ${name} has no daily time, and the person has no quiet window. The person gets no digest.`);
    }
  }
  return problems;
}

/**
 * This function makes the message of a send. The text comes from one report of the incident. That
 * report has the severity and the urgency of the incident, and it is the latest one by its time of
 * sending. The channel cuts the text to its limits.
 *
 * A message of the line `system.quota.reserve` can use the reserve of the quota. Else the reserve
 * stops the message that tells of it.
 *
 * The `why` is the why line of the channel, from `whyLine`. An empty line gives no field.
 *
 * Each match of the advisory to a part of the software (`Route.software`, AL-197) gives one line at the top of the body.
 * The line names the part, the package, the installed version and the fixed version. A last line gives the severity.
 */
export function messageOf(incident: Incident, reports: readonly Report[], send: EscalationSend, why?: string, software: readonly SoftwareMatch[] = []): Message {
  const report = textReport(incident, reports);
  const title = titleOf(incident, report);
  const matches = software.length === 0 ? [] : [[...software.map(softwareMatchText), `The severity of the advisory is ${incident.severity}.`].join("\n")];
  const body = [...matches, report?.instruction, report?.areaText, report?.description].flatMap((part) => (part === undefined || part.trim() === "" ? [] : [part.trim()])).join("\n\n");
  return {
    key: messageKey(send),
    person: send.person,
    level: send.level,
    title,
    body,
    ...(report?.web === undefined ? {} : { url: report.web }),
    incident: send.incident,
    ...(incident.expires === undefined ? {} : { expires: incident.expires }),
    quiet: send.quiet,
    ...(incident.kind.code === `${QUOTA_KIND}.reserve` ? { useReserve: true } : {}),
    ...(why === undefined || why === "" ? {} : { why }),
  };
}

/**
 * This function gives the title of an incident in a message. The title is the headline of the report of the text
 * (`messageOf`). With no headline, it is the label of the kind of the incident.
 */
export function incidentTitle(incident: Incident, reports: readonly Report[]): string {
  return titleOf(incident, textReport(incident, reports));
}

const titleOf = (incident: Incident, report: Report | undefined): string => report?.headline.trim() || incident.kind.label;

/** This function gives the acknowledgment that a status of a delivery tells, or `undefined`. */
export function acknowledgmentOf(delivery: Delivery, status: DeliveryStatus): Acknowledgment | undefined {
  if (status.state !== "acknowledged") return undefined;
  return { incident: delivery.incident, level: delivery.level, person: delivery.person, at: status.at, via: delivery.channel };
}

// The end of an incident: its expiry, or `now` when it is not live and its expiry is not earlier.
function endOf(incident: Incident, now: Instant): Instant | undefined {
  const expires = incident.expires !== undefined && Number.isFinite(incident.expires) ? incident.expires : undefined;
  if (incident.live) return expires;
  return expires !== undefined && expires <= now ? expires : now;
}

function earliest(times: readonly (Instant | undefined)[]): Instant | undefined {
  let found: Instant | undefined;
  for (const time of times) if (time !== undefined && Number.isFinite(time) && (found === undefined || time < found)) found = time;
  return found;
}

// The earliest start in the log of a person and a level. A tie goes to the smallest report id.
function earliestStart(starts: readonly EscalationStart[], person: PersonId, level: Level): EscalationStart | undefined {
  let found: EscalationStart | undefined;
  for (const start of starts) {
    if (start.person !== person || start.level !== level || !Number.isFinite(start.at)) continue;
    if (found === undefined || start.at < found.at || (start.at === found.at && compareCodeUnits(start.incident, found.incident) < 0)) found = start;
  }
  return found;
}

// The report of the text of a message. The reports come from the merge state, in the order of their ids.
function textReport(incident: Incident, reports: readonly Report[]): Report | undefined {
  const members = new Set<string>(incident.reports);
  let found: Report | undefined;
  for (const report of reports) {
    if (!members.has(report.id)) continue;
    const matches = report.severity === incident.severity && report.urgency === incident.urgency;
    const foundMatches = found !== undefined && found.severity === incident.severity && found.urgency === incident.urgency;
    if (found === undefined || (matches && !foundMatches) || (matches === foundMatches && report.sent > found.sent)) found = report;
  }
  return found;
}
