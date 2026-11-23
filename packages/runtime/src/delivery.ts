/**
 * This module holds the delivery step of a pass. The step polls each open receipt for an
 * acknowledgment, and it writes the start of each new escalation. Then it sends each step that is due,
 * and it cancels the repeats of each escalation that is over. The core decides each of these. The step does the
 * calls of the channels, and it writes each result to the log after the call.
 */
import type { WallClock } from "@mark1russell7/algebra/clock";
import { backoffDelay, type Backoff } from "@mark1russell7/service/backoff";
import {
  COPY_ID,
  DEFAULT_LINK_POLICY,
  NO_LABELS,
  acknowledgmentOf,
  digestDeliveries,
  digestMessageOf,
  exhaustions,
  holdKey,
  limitRoutes,
  throttleRoutes,
  graphLabels,
  incidents,
  linkRule,
  messageKey,
  messageOf,
  planDigests,
  route,
  shadowScore,
  whyLine,
  type Acknowledgment,
  type AssessPolicy,
  type ChannelDescriptor,
  type ChannelId,
  type ChannelProcedures,
  type Delivery,
  type DeliveryStatus,
  type Duration,
  type EscalationEnd,
  type Exhaustion,
  type Incident,
  type Instant,
  type LinkPolicy,
  type RankDelays,
  type Recipient,
  type EscalationHold,
  type Route,
  type SendLimits,
  type Suppression,
  type Throttle,
  type ScorePriors,
  type SendOutcome,
  type WatchedPlace,
  type WhyLabels,
  type WhyLimit,
} from "@mark1russell7/alerts";
import { errorMessage } from "@mark1russell7/text";
import { compareCodeUnits } from "@mark1russell7/text/order";
import { envelope, frameTag, REFUSAL_FAULTS, type ChannelFailureKind, type RefusalKind, type RefusedEvent, type RuntimeEvent } from "./events.ts";
import { limited } from "./limit.ts";
import { cancelledKeys, REFUSAL_LIMIT, refusalStreak, refusalWait, type RuntimeState } from "./state.ts";
import { earliest } from "./view.ts";

/** The options of the delivery. The private configuration gives the recipients and the addresses. */
export interface DeliveryOptions {
  readonly recipients: readonly Recipient[];
  /** The procedures of each channel. A step of a channel that is not here fails, and the escalation goes on. */
  readonly channels: readonly ChannelProcedures[];
  /** The policy of the assessment. The default is the policy of the core. */
  readonly assess?: AssessPolicy;
  /**
   * The ids of the sources that this copy runs, also a source whose fetch fails at this time (AL-76). A kind with no class in an
   * incident of only other sources gets the quiet table of the core. Without the set, each source is a source of this copy.
   */
  readonly sources?: ReadonlySet<string>;
  /** The priors of the shadow score. With them, the start of each escalation in the log keeps the score. */
  readonly priors?: ScorePriors;
  /** The time between two polls of one receipt. */
  readonly pollEvery: Duration;
  /** The wait before a failed call goes again, when the channel tells no wait. */
  readonly retry: Duration;
  /** The longest time that a step waits for one call of a channel. */
  readonly callLimit: Duration;
  /**
   * The longest time that a send stays in flight. A send that passes `callLimit` goes on, and no second
   * send of its key starts until it ends or this time ends. A late send that the channel accepts gets
   * its delivery in the log. After this time, the step stops the copy of the send by its copy id, and a
   * new copy goes. It is not shorter than `callLimit`.
   */
  readonly flightLimit: Duration;
  /**
   * A due send with no delivery is overdue after this time, whatever the kind of its failures. The heartbeat
   * fails while a send is overdue. `overdueLimit` gives the time from the times of the loop and the delivery.
   * Without it, the step gives no overdue send.
   */
  readonly overdueAfter?: Duration;
  /** The rank of this copy of the system, and the wait of each rank. */
  readonly rank?: number;
  /** The default wait of one rank: the wait of each level with no entry in `rankDelays`. */
  readonly rankDelay?: Duration;
  /** The wait of one rank for each level, from the configuration. */
  readonly rankDelays?: RankDelays;
  /** The least wait of one rank before a step of an exclusive channel. Without it, the channels have no floor. */
  readonly rankFloor?: Duration;
  /**
   * The longest wait between two stop probes of a down channel. The wait starts at `retry` and doubles after each
   * failed probe, up to this time. The default is `PROBE_LIMIT` or `retry`, the longer one.
   */
  readonly probeLimit?: Duration;
  /**
   * The longest wait between two tries of a refused send. The wait starts at `retry` and doubles after each refusal of
   * the send in a row, up to this time. The default is `REFUSAL_LIMIT` or `retry`, the longer one.
   */
  readonly refusalLimit?: Duration;
  /** The send limit of each person (`limitRoutes` of the core, AL-72). The default is `DEFAULT_SEND_LIMITS`. */
  readonly sendLimits?: SendLimits;
  /**
   * The rise-only throttle of each person and channel (`throttleRoutes` of the core, AL-72 part 4). Without it, the
   * runtime has no throttle. The instance gives the throttle of the configuration (`throttleOf`).
   */
  readonly throttle?: Throttle;
  /**
   * The private labels of the nodes of the why records, for the why line of each message. The labels stay in the
   * runtime: no record and no log event holds them. Without them, each why line uses plain nouns.
   */
  readonly labels?: WhyLabels;
  /**
   * The channels that this copy leaves to the other copies (`CopySettings.leaveChannels`, AL-55). The plans keep their
   * steps on them, thus the keys stay the same in each copy. The step sends, cancels and polls nothing on them. Thus
   * they get no failure and no overdue send of this copy.
   */
  readonly leaveChannels?: readonly ChannelId[];
}

/** The default longest wait between two stop probes of a down channel: 60 seconds. */
export const PROBE_LIMIT: Duration = 60_000;

/** A call of a channel that failed. The decision stays, thus the call goes again at `retryAt` or later. */
export interface DeliveryFailure {
  /** The call. `copy` is the stop of one copy by its copy id. */
  readonly call: "send" | "status" | "cancel" | "copy";
  /** The delivery key of the call. */
  readonly key: string;
  /** The copy id of a `copy` call. */
  readonly copy?: string;
  readonly channel: ChannelId;
  readonly kind: string;
  readonly message: string;
  readonly retryAt: Instant;
}

/** The overdue sends of one channel. */
export interface OverdueSends {
  readonly channel: ChannelId;
  /** The count of the overdue sends on the channel. */
  readonly sends: number;
  /** The earliest due time of an overdue send on the channel. */
  readonly since: Instant;
}

/**
 * This function gives the time after which a due send with no delivery is overdue.
 *
 * - The first step after the due time starts within `passLimit`, because the loop starts each pass within that time.
 * - Each try of the send ends by its flight limit. A failed try goes again after its retry.
 * - Thus two full tries end within this time. An overdue send failed two times or more.
 */
export function overdueLimit(times: { readonly passLimit: Duration; readonly flightLimit: Duration; readonly retry: Duration }): Duration {
  return times.passLimit + 2 * (times.flightLimit + times.retry);
}

/** The result of one delivery step. */
export interface DeliveryStep {
  /** The escalations after the polls of the step. */
  readonly routes: readonly Route[];
  /** The deliveries that the step wrote: the sends of the step, and the late sends of earlier steps. */
  readonly sent: readonly Delivery[];
  /**
   * The keys of the sends that the channel accepted when the log already had a delivery of the key.
   * A late send on a channel that does not repeat can cause this, after a second send. Another copy
   * of the system can also cause it. The log keeps the first delivery. The cancel by tag of the
   * channel stops the repeats of each copy.
   */
  readonly duplicates: readonly string[];
  /**
   * The copy ids that the step stopped. Each is a copy that the channel can repeat and that no poll reads:
   *
   * - a copy past its flight limit, or a copy whose send failed with no answer
   * - a copy of a key that the log already has
   * - a copy of an earlier run with no end in the log
   */
  readonly stopped: readonly string[];
  readonly acknowledged: readonly Acknowledgment[];
  /** The delivery keys that the step cancelled. */
  readonly cancelled: readonly string[];
  readonly failures: readonly DeliveryFailure[];
  /** The ids of the events that are different from the events of the log with the same ids. */
  readonly conflicts: readonly string[];
  /**
   * The channels with overdue sends, in the order of their ids. An overdue send is due, and it has no delivery
   * `overdueAfter` after its due time. The due time comes from the log, thus a restart keeps it. A send
   * that the reserve of a quota holds (`reserved`) is not overdue, because the reserve holds it on purpose.
   */
  readonly overdue: readonly OverdueSends[];
  /**
   * The exhausted escalations of the real warnings after the step (`exhaustions`, AL-21). The view of the next pass
   * makes a report of each one for the people who watch the person.
   */
  readonly exhausted: readonly Exhaustion[];
  /** The next time of a step of an escalation, of a poll or of a call that goes again. */
  readonly wakeAt?: Instant;
}

/** What the delivery reads and writes in the runtime. */
export interface DeliveryContext {
  readonly clock: WallClock;
  /** The id of the run. Its characters match `COPY_ID`. Each copy id starts with it, thus two runs do not give the same copy id. */
  readonly run: string;
  readonly places: readonly WatchedPlace[];
  /** The policy of the link rule of the merge, the policy of the view. The default is `DEFAULT_LINK_POLICY`. */
  readonly link?: LinkPolicy | undefined;
  state(): RuntimeState;
  /**
   * This function writes events to the log and folds them. It gives the ids of the events that are
   * different from the events of the log with the same ids. It throws when the write fails.
   */
  append(events: readonly RuntimeEvent[]): readonly string[];
  /** The step starts this function when a late send ends with a delivery. The next pass then writes it soon. */
  readonly wake?: (() => void) | undefined;
  /**
   * This function gives the share of the send limit for this copy at a time (`limitShare` of the core). Without it,
   * the share is 1.
   */
  readonly share?: ((at: Instant) => number) | undefined;
  /**
   * This function cuts the incidents of a step before the route and the digest: the observe mode of the new sources
   * (AL-73). Without it, each incident goes on.
   */
  readonly cut?: ((found: readonly Incident[], at: Instant) => readonly Incident[]) | undefined;
}

/** The dispatcher of the deliveries: one step for each pass. */
export interface Dispatcher {
  step(at: Instant): Promise<DeliveryStep>;
  /**
   * This method moves the times in memory by the size of a step of the wall clock. They are the times of the polls,
   * the waits, the flights, the places and the probes. They are also the times of the deliveries that the next step
   * writes. Thus each timer keeps its distance on the monotonic clock.
   */
  shift(size: Duration): void;
}

/** A send in flight. A stale flight passed its flight limit on a channel that repeats. The log does not keep its copy. */
interface Flight {
  // A step of the wall clock moves this time in place. The object stays the same, thus a late end finds its flight.
  since: Instant;
  readonly copy: string;
  stale: boolean;
}

/** A delivery that the next step writes, and the copy id of its send. */
interface Landed {
  readonly delivery: Delivery;
  readonly copy: string;
}

/**
 * The kinds of a failed send after which the channel can have the message: the answer did not come,
 * or the server failed. A refusal, a bad key and a full quota tell that the channel has no message.
 */
const UNSURE: ReadonlySet<string> = new Set(["network", "timeout", "server"]);

// This function tells if the channel refused a send. Then the channel has no message.
const refusal = (kind: ChannelFailureKind): kind is RefusalKind => !UNSURE.has(kind);

/** The kind and the text of a failed cancel or stop. */
interface CallFailure {
  readonly kind: "timeout" | "network";
  readonly message: string;
}

/** One call of a channel with a limit of calls. It keeps its place until it ends or until its flight limit passes. */
interface Place {
  // A step of the wall clock moves this time in place. The object stays the same, thus the end of the call frees it.
  until: Instant;
}

/** This function starts a call, and it gives back its place when the call ends, also after the time limit of the step. */
function within<T>(release: () => void, call: () => T | Promise<T>): Promise<T> {
  const started = Promise.resolve().then(call);
  void started.then(release, release);
  return started;
}

/** A cancel or a stop that threw is a failure of the kind `network`. */
const thrownFailure = (thrown: unknown, otherwise: string): CallFailure => ({ kind: "network", message: thrown === undefined ? otherwise : errorMessage(thrown) });

/**
 * This function makes the dispatcher. Each call of a channel goes through a time limit. A failed call
 * changes nothing in the log, thus the next step decides it again.
 *
 * - A send that passes its time limit stays in flight, thus it does not get a second send.
 * - The channel can have a copy that the log does not keep. Such a copy passed its flight limit, or its
 *   send failed with no answer. A copy of a key that the log already has is such a copy too. On a channel that repeats,
 *   the step stops that copy by its copy id. The new copy goes in parallel. A stop by the delivery key here can also stop the new copy.
 * - A failed stop goes again at a later step. A stale copy that the channel accepts writes no delivery,
 *   and its stop goes again.
 * - After a step with a failed stop on a channel, each step sends only one stop on that channel: the probe.
 *   Thus an outage of the channel costs one stop at each retry, not one stop for each copy. After a good
 *   probe, the other stops go at the next step.
 * - The wait before the next probe starts at the retry, and it doubles after each failed probe, up to the probe
 *   limit. A good answer of the channel to a send, a poll or a cancel moves the next probe to the next step.
 * - A channel with \`maxInFlight\` gets no more calls in progress at the same time. Each other call waits for a later
 *   step, and the end of a call wakes the loop. A call keeps its place until it ends or its flight limit passes.
 *
 * The times of the polls and the flights are in memory only. A step of the wall clock moves them with `shift`. After
 * a restart, each receipt gets a poll at once.
 *
 * The log keeps each refused send, thus the wait of its retry holds after a restart. Before each send on a channel
 * that repeats, the log keeps its copy. The log also keeps the end of the copy: its delivery, a refusal or a stop.
 * Thus the first step after a restart stops each copy of an earlier run with no end.
 */
export function createDispatcher(options: DeliveryOptions, context: DeliveryContext): Dispatcher {
  const { clock } = context;
  const link = linkRule(context.link ?? DEFAULT_LINK_POLICY);
  const byId = new Map<string, ChannelProcedures>();
  const descriptors: ChannelDescriptor[] = [];
  for (const channel of options.channels) {
    const descriptor = channel.describe();
    if (byId.has(descriptor.id)) throw new Error(`Two channels have the id ${descriptor.id}.`);
    byId.set(descriptor.id, channel);
    descriptors.push(descriptor);
  }
  const polling = new Set(descriptors.filter((descriptor) => descriptor.ack === "poll").map((descriptor) => descriptor.id as string));
  // The limit of the why line of each channel that has one.
  const whyLimits = new Map<string, WhyLimit>(descriptors.flatMap((descriptor) => (descriptor.why === undefined ? [] : [[descriptor.id as string, descriptor.why] as const])));
  const labels = options.labels ?? NO_LABELS;
  // Only a copy that the channel repeats needs a stop.
  const repeating = new Set(descriptors.filter((descriptor) => descriptor.repeats).map((descriptor) => descriptor.id as string));
  const recipients = new Map(options.recipients.map((recipient) => [recipient.watch.person as string, recipient]));
  // The channels of the other copies. A send, a cancel or a poll on them is not a call of this copy. The copies share
  // each cancel and each acknowledgment (`SHARED_TYPES`). Thus the copy that sends on the channel writes them.
  const left = new Set<string>(options.leaveChannels ?? []);
  const kept = (item: { readonly channel: ChannelId }): boolean => !left.has(item.channel);
  // The labels of each person: the labels of the instance, and then the labels of the interest graph of the person.
  const personLabels = new Map(options.recipients.map((recipient) => [recipient.watch.person as string, graphLabels(labels, recipient.watch.interests)]));
  const labelsOf = (person: string): WhyLabels => personLabels.get(person) ?? labels;
  if (!(options.flightLimit >= options.callLimit)) throw new Error(`The flight limit (${options.flightLimit} ms) is shorter than the call limit (${options.callLimit} ms).`);
  const probeLimit = options.probeLimit ?? Math.max(PROBE_LIMIT, options.retry);
  if (!(probeLimit >= options.retry)) throw new Error(`The probe limit (${probeLimit} ms) is shorter than the retry (${options.retry} ms).`);
  // The probes of a down channel back off. There is one client, thus the waits need no jitter.
  const probeWait: Backoff = { base: options.retry, factor: 2, cap: probeLimit };
  const refusalLimit = options.refusalLimit ?? Math.max(REFUSAL_LIMIT, options.retry);
  if (!(refusalLimit >= options.retry)) throw new Error(`The refusal limit (${refusalLimit} ms) is shorter than the retry (${options.retry} ms).`);
  // The most calls in progress of each channel with a limit, and the places of its calls in progress.
  const limits = new Map<ChannelId, number>();
  for (const descriptor of descriptors) {
    if (descriptor.maxInFlight === undefined) continue;
    if (!(Number.isInteger(descriptor.maxInFlight) && descriptor.maxInFlight >= 1)) throw new Error(`The channel ${descriptor.id} has maxInFlight ${descriptor.maxInFlight}. It must be an integer of 1 or more.`);
    limits.set(descriptor.id, descriptor.maxInFlight);
  }
  const places = new Map<ChannelId, Set<Place>>();
  // The channels with a call that waits for a place. The end of a call of such a channel wakes the loop.
  const starved = new Set<ChannelId>();
  // Each copy id starts with the run id. A channel can put it in the path of a URL.
  if (!COPY_ID.test(context.run)) throw new Error(`The run id "${context.run}" has a character that a copy id cannot have. Use letters, digits, _ and -.`);
  const polled = new Map<string, Instant>();
  const waits = new Map<string, Instant>();
  // The send in flight of each key. Each flight is an object, thus a late end does not remove a later flight of the same key.
  const flying = new Map<string, Flight>();
  // The stale copies that the channel can repeat, by copy id. Each step stops them.
  const stopping = new Map<string, { readonly key: string; readonly channel: ChannelId }>();
  // The channels whose last step of stops had a failed stop. Each step sends one stop on such a channel: the probe.
  const down = new Set<ChannelId>();
  // The failed probes in a row of each down channel, and the time of its next probe.
  const probes = new Map<ChannelId, { readonly failed: number; readonly at: Instant }>();
  let copies = 0;
  // The copies whose send did not end. A stop of such a copy does not end it, because the channel can accept it later.
  const pending = new Set<string>();
  // The copies that need no stop and that the log does not tell yet: a refused send, or a stop after the end of the send.
  const closed = new Set<string>();
  // The first step stops the open copies of the log. Each of them is a copy of an earlier run.
  let restarted = true;
  // The deliveries of the sends that ended after their step. The next step writes them.
  const landed: Landed[] = [];
  const later = (call: string, key: string): string => `${call} ${key}`;
  // The channel accepted a copy, and the log keeps another delivery of its key. No poll reads the copy, thus it gets a stop.
  const duplicate = (delivery: Delivery, copy: string): void => {
    if (repeating.has(delivery.channel)) stopping.set(copy, { key: delivery.key, channel: delivery.channel });
  };

  return {
    shift(size) {
      for (const [key, at] of polled) polled.set(key, at + size);
      for (const [call, until] of waits) waits.set(call, until + size);
      for (const flight of flying.values()) flight.since += size;
      for (const taken of places.values()) for (const call of taken) call.until += size;
      for (const [id, probe] of probes) probes.set(id, { ...probe, at: probe.at + size });
      for (let index = 0; index < landed.length; index += 1) {
        const entry = landed[index]!;
        landed[index] = { ...entry, delivery: { ...entry.delivery, at: entry.delivery.at + size } };
      }
    },
    async step(at) {
      if (restarted) {
        restarted = false;
        for (const [copy, target] of Object.entries(context.state().copies)) stopping.set(copy, target);
        // The wait of each refused send of the log holds, thus a quota of the channel holds across a restart.
        for (const [key, refused] of Object.entries(context.state().refusals)) if (refused.retryAt > at) waits.set(later("send", key), refused.retryAt);
      }
      // A wait that is over keeps nothing. Thus the map holds only the waits of the last retry time.
      for (const [call, until] of waits) if (until <= at) waits.delete(call);
      const merged = incidents(context.state().merge, at, { link });
      const found = context.cut === undefined ? merged : context.cut(merged, at);
      // The routes at the time of the step, after the send limit of each person and the throttle of each channel. The new
      // holds and suppressions go to the log in step 2.
      const routesNow = (): { readonly routes: readonly Route[]; readonly holds: readonly EscalationHold[]; readonly suppressions: readonly Suppression[] } => {
        const state = context.state();
        const routes = route({
          state: state.merge,
          incidents: found,
          recipients: options.recipients,
          places: context.places,
          assess: options.assess,
          sources: options.sources,
          starts: state.starts,
          ends: state.escalationEnds,
          cancelled: cancelledKeys(state),
          channels: descriptors,
          rank: options.rank,
          rankDelay: options.rankDelay,
          rankDelays: options.rankDelays,
          rankFloor: options.rankFloor,
          now: at,
        });
        // A send in flight, or an open copy of the log, can already be on the phone. Thus its route keeps its place.
        const started = new Set([...flying.keys(), ...Object.values(state.copies).map((copy) => copy.key)]);
        const limited = limitRoutes({ routes, deliveries: state.merge.deliveries, holds: state.holds, limits: options.sendLimits, share: context.share?.(at), started, reports: state.merge.reports, now: at });
        // The send limit counts new escalations, and the throttle counts messages on each channel. The send limit stays a
        // cap over all the channels.
        if (options.throttle === undefined) return { ...limited, suppressions: [] };
        const throttled = throttleRoutes({ routes: limited.routes, deliveries: state.merge.deliveries, suppressions: state.suppressions, reports: state.merge.reports, throttle: options.throttle, started, now: at });
        return { routes: throttled.routes, holds: limited.holds, suppressions: throttled.suppressions };
      };
      const failures: DeliveryFailure[] = [];
      const conflicts: string[] = [];
      const write = (events: readonly RuntimeEvent[]): void => {
        if (events.length > 0) conflicts.push(...context.append(events));
      };
      const fail = (call: DeliveryFailure["call"], target: { readonly key: string; readonly channel: ChannelId; readonly copy?: string }, kind: string, message: string, after?: Duration): Instant => {
        // A refused send backs off: its wait doubles after each refusal of its key in a row, up to the refusal limit.
        // The log keeps the count of the refusals in a row past the retry time (`refusalStreak`). Thus a refusal of
        // another key in a burst, or a restart, does not set the wait back to `retry`.
        const streak = call === "send" && refusal(kind as ChannelFailureKind) ? refusalStreak(context.state().refusals, target.key, at) : 0;
        const retryAt = at + Math.max(refusalWait(streak, options.retry, refusalLimit), after ?? 0);
        waits.set(later(call, target.copy ?? target.key), retryAt);
        failures.push({ call, key: target.key, ...(target.copy === undefined ? {} : { copy: target.copy }), channel: target.channel, kind, message, retryAt });
        return retryAt;
      };
      // The log keeps each refused send and its retry time. A refusal on a channel that repeats ends its copy. The step
      // writes its refusals after all of its deliveries, as `holdStep` of the heartbeat reads a pass.
      const refusing: Pick<RefusedEvent, "key" | "channel" | "kind" | "retryAt" | "copy">[] = [];
      const refuse = (target: { readonly key: string; readonly channel: ChannelId }, kind: RefusalKind, retryAt: Instant, copy?: string): void => {
        refusing.push({ key: target.key, channel: target.channel, kind, retryAt, ...(copy === undefined ? {} : { copy }) });
      };
      // The end of each wait that keeps a call from this step. The next pass comes at the earliest one.
      const waiting: Instant[] = [];
      const ready = (call: string, key: string): boolean => {
        const until = waits.get(later(call, key));
        if (until === undefined) return true;
        if (until <= at) {
          waits.delete(later(call, key));
          return true;
        }
        waiting.push(until);
        return false;
      };
      // The channels with a good answer in this step. A good answer of a down channel moves its next probe to the next step.
      const reached = new Set<ChannelId>();
      // A place for one call of a channel. With no free place, the call waits for a later step, and the function gives undefined.
      const place = (id: ChannelId): (() => void) | undefined => {
        const limit = limits.get(id);
        if (limit === undefined) return () => undefined;
        const taken = places.get(id) ?? new Set<Place>();
        places.set(id, taken);
        for (const call of taken) if (call.until <= at) taken.delete(call);
        if (taken.size >= limit) {
          starved.add(id);
          waiting.push(Math.min(...[...taken].map((call) => call.until)));
          return undefined;
        }
        const call: Place = { until: at + options.flightLimit };
        taken.add(call);
        return () => {
          if (taken.delete(call) && starved.delete(id)) context.wake?.();
        };
      };

      // 0. The late sends that ended with a delivery. They go to the log first, thus the routes see them and send no second copy.
      const sent: Delivery[] = [];
      const duplicates: string[] = [];
      const arrived = landed.splice(0);
      // A key of the log, or a key of an earlier delivery of this batch, makes a duplicate.
      const logged = new Set(context.state().merge.deliveries.map((delivery) => delivery.key));
      const fresh: Landed[] = [];
      for (const item of arrived) {
        if (logged.has(item.delivery.key)) {
          duplicates.push(item.delivery.key);
          duplicate(item.delivery, item.copy);
          continue;
        }
        logged.add(item.delivery.key);
        fresh.push(item);
      }
      try {
        write(fresh.map(({ delivery, copy }) => deliveryEvent(delivery, copy, at)));
      } catch (error) {
        // The deliveries stay for the next step. The log has none of them.
        landed.unshift(...arrived);
        throw error;
      }
      for (const { delivery } of fresh) polled.set(delivery.key, at);
      sent.push(...fresh.map(({ delivery }) => delivery));

      // 1. The polls. An acknowledgment changes the escalations, thus the routes come again after it.
      const first = routesNow();
      const due: { readonly delivery: Delivery; readonly release: () => void }[] = [];
      for (const delivery of first.routes.flatMap((entry) => entry.polls).filter(kept)) {
        if (!((polled.get(delivery.key) ?? Number.NEGATIVE_INFINITY) + options.pollEvery <= at && ready("status", delivery.key))) continue;
        const release = place(delivery.channel);
        if (release !== undefined) due.push({ delivery, release });
      }
      const statuses = await Promise.all(due.map(({ delivery, release }) => poll(delivery, release)));
      const acks = statuses.flatMap((status, index) => {
        const { delivery } = due[index]!;
        polled.set(delivery.key, at);
        if (!status.ok) {
          fail("status", delivery, status.kind, status.message);
          return [];
        }
        reached.add(delivery.channel);
        const acknowledgment = acknowledgmentOf(delivery, status.status);
        return acknowledgment === undefined ? [] : [{ ...envelope("acknowledgment", `ack:${delivery.key}`, at), acknowledgment }];
      });
      write(acks);
      const acknowledged = acks.map((event) => event.acknowledgment);
      const capped = acknowledged.length === 0 ? first : routesNow();
      const routes = capped.routes;

      // 2. The start of each new escalation, before its first send. The end of each person that the incident no longer
      // reaches, before its cancels: the routes of each level of the person give the same end, and the log keeps it once.
      const { priors } = options;
      write(
        routes
          .filter((entry) => entry.fresh)
          .map((entry) => ({ ...envelope("escalation", startId(entry), at), start: entry.start, ...(priors === undefined ? {} : { shadow: shadowScore(entry.incident, priors) }) })),
      );
      const ending = new Map<string, EscalationEnd>();
      for (const entry of routes) if (entry.freshEnd && entry.end !== undefined) ending.set(endId(entry), entry.end);
      write([...ending].map(([id, end]) => ({ ...envelope("escalation-end", id, at), end })));
      // The holds of the send limit, after the start of each escalation. A held escalation has no send in this step.
      write(capped.holds.map((hold) => ({ ...envelope("hold", `hold:${holdKey(hold)}`, at), hold })));
      // The suppressions of the throttle. A suppressed send does not go in this step or later.
      write(capped.suppressions.map((suppression) => ({ ...envelope("suppressed", `suppressed:${suppression.key}`, at), suppression })));

      // 3. The sends and the cancels. Each result goes to the log at once, thus a crash loses the fewest results.
      const cancelled: string[] = [];
      const work: Promise<void>[] = [];
      for (const entry of routes) {
        for (const send of entry.plan.sends.filter(kept)) {
          const key = messageKey(send);
          const flight = flying.get(key);
          if (flight !== undefined) {
            const ends = flight.since + options.flightLimit;
            if (at < ends) {
              waiting.push(ends);
              continue;
            }
            // The send hangs past its flight limit, and the channel can have its copy. The step stops that copy by its
            // copy id, and a new copy goes in parallel. A cancel by the delivery key here can also stop the new copy.
            flying.delete(key);
            if (repeating.has(send.channel)) {
              flight.stale = true;
              stopping.set(flight.copy, { key, channel: send.channel });
            }
          }
          if (!ready("send", key)) continue;
          work.push(
            (async () => {
              const target = { key, channel: send.channel };
              const channel = byId.get(send.channel);
              const address = recipients.get(send.person)?.addresses[send.channel];
              if (channel === undefined || address === undefined) {
                const retryAt = fail("send", target, "refused", channel === undefined ? `The system has no channel ${send.channel}.` : `The person has no address on the channel ${send.channel}.`);
                refuse(target, "refused", retryAt);
                return;
              }
              const limit = whyLimits.get(send.channel);
              const why = limit === undefined || entry.why === undefined ? undefined : whyLine(entry.why, labelsOf(send.person), limit);
              const message = messageOf(entry.incident, context.state().merge.reports, send, why);
              const deliveryOf = (accepted: Extract<SendOutcome, { ok: true }>): Delivery => ({ key: message.key, incident: send.incident, level: send.level, person: send.person, channel: send.channel, step: send.step, at: accepted.accepted, receipt: accepted.receipt });
              // A send with no free place on its channel goes at a later step. It has no copy yet.
              const release = place(send.channel);
              if (release === undefined) return;
              copies += 1;
              const copy = `${context.run}-${copies}`;
              // The log keeps the copy before the send. A write that fails throws, and no send goes.
              try {
                if (repeating.has(send.channel)) write([{ ...envelope("attempt", `attempt:${copy}`, clock.now()), key, channel: send.channel, copy }]);
              } catch (error) {
                release();
                throw error;
              }
              // The send stays in flight until it ends, also after the time limit of the step.
              const flight: Flight = { since: at, copy, stale: false };
              flying.set(key, flight);
              pending.add(copy);
              let late = false;
              const call = within(release, () => channel.send({ message, address, copy }))
                .then(
                  (result) => result,
                  (error): SendOutcome => ({ ok: false, kind: "network", message: `The send threw: ${errorMessage(error)}` }),
                );
              void call.then((result) => {
                if (flying.get(key) === flight) flying.delete(key);
                pending.delete(copy);
                // The channel can have this copy, and the log does not keep it: a stale copy, or a send with no answer. A stop
                // before the accept does not reach the copy, thus the stop of a stale copy goes again.
                const unkept = result.ok ? flight.stale : UNSURE.has(result.kind);
                if (repeating.has(send.channel)) {
                  if (unkept) {
                    stopping.set(copy, { key, channel: send.channel });
                    if (late) context.wake?.();
                  } else if (!result.ok && late) {
                    // The channel refused the send after its time limit, thus it has no copy to stop. The step writes an
                    // on-time refusal with its copy id.
                    closed.add(copy);
                  }
                }
                if (flight.stale || !late || !result.ok) return;
                landed.push({ delivery: deliveryOf(result), copy });
                context.wake?.();
              });
              const outcome = await limited<SendOutcome>(
                call,
                options.callLimit,
                clock,
                () => {
                  late = true;
                  return { ok: false, kind: "timeout", message: `The send took longer than ${options.callLimit} ms. It stays in flight for up to ${options.flightLimit} ms.` };
                },
                (error) => ({ ok: false, kind: "network", message: `The send threw: ${errorMessage(error)}` }),
              );
              if (!outcome.ok) {
                const retryAt = fail("send", target, outcome.kind, outcome.message, outcome.retryAfter);
                if (refusal(outcome.kind)) refuse(target, outcome.kind, retryAt, repeating.has(send.channel) ? copy : undefined);
                return;
              }
              reached.add(send.channel);
              const delivery = deliveryOf(outcome);
              let different: readonly string[];
              try {
                different = context.append([deliveryEvent(delivery, copy, clock.now())]);
              } catch (error) {
                // The channel has the message, and the log does not. The next step writes the delivery first, thus no second send goes.
                landed.push({ delivery, copy });
                context.wake?.();
                throw error;
              }
              conflicts.push(...different);
              if (different.length > 0) {
                duplicates.push(delivery.key);
                duplicate(delivery, copy);
                return;
              }
              // A new delivery gets its first poll after one interval.
              polled.set(delivery.key, at);
              sent.push(delivery);
            })(),
          );
        }
        for (const delivery of entry.plan.cancels.filter(kept)) {
          if (!ready("cancel", delivery.key)) continue;
          work.push(
            (async () => {
              const channel = byId.get(delivery.channel);
              if (delivery.receipt !== undefined) {
                if (channel === undefined) {
                  fail("cancel", delivery, "refused", `The system has no channel ${delivery.channel}.`);
                  return;
                }
                const receipt = delivery.receipt;
                // A cancel with no free place on its channel goes at a later step.
                const release = place(delivery.channel);
                if (release === undefined) return;
                const failure = await limited<CallFailure | undefined>(
                  within(release, () => channel.cancel({ receipt })).then(() => undefined),
                  options.callLimit,
                  clock,
                  () => ({ kind: "timeout", message: `The cancel took longer than ${options.callLimit} ms.` }),
                  (thrown) => thrownFailure(thrown, "The cancel failed."),
                );
                if (failure !== undefined) {
                  fail("cancel", delivery, failure.kind, failure.message);
                  return;
                }
                reached.add(delivery.channel);
              }
              write([{ ...envelope("cancelled", `cancelled:${delivery.key}`, clock.now()), delivery: delivery.key }]);
              cancelled.push(delivery.key);
            })(),
          );
        }
      }
      // 3b. The digests (`planDigests`): one message for each person each day. The log keeps one delivery for each incident
      // of a digest, thus the next plan does not tell the incident again. A digest does not repeat, thus it needs no stop.
      const digests = planDigests({
        state: context.state().merge,
        incidents: found,
        recipients: options.recipients,
        places: context.places,
        assess: options.assess,
        sources: options.sources,
        channels: descriptors,
        rank: options.rank,
        rankDelay: options.rankDelay,
        rankDelays: options.rankDelays,
        rankFloor: options.rankFloor,
        holds: [...context.state().holds, ...context.state().suppressions],
        now: at,
      });
      for (const send of digests.sends.filter(kept)) {
        const key = send.key;
        const flight = flying.get(key);
        if (flight !== undefined) {
          const ends = flight.since + options.flightLimit;
          if (at < ends) {
            waiting.push(ends);
            continue;
          }
          // The send hangs past its flight limit. A late accept of it records nothing, and a new copy goes.
          flight.stale = true;
          flying.delete(key);
        }
        if (!ready("send", key)) continue;
        work.push(
          (async () => {
            const target = { key, channel: send.channel };
            const channel = byId.get(send.channel);
            const address = recipients.get(send.person)?.addresses[send.channel];
            if (channel === undefined || address === undefined) {
              const retryAt = fail("send", target, "refused", channel === undefined ? `The system has no channel ${send.channel}.` : `The person has no address on the channel ${send.channel}.`);
              refuse(target, "refused", retryAt);
              return;
            }
            const message = digestMessageOf(send, context.state().merge.reports);
            const release = place(send.channel);
            if (release === undefined) return;
            copies += 1;
            const copy = `${context.run}-${copies}`;
            const flight: Flight = { since: at, copy, stale: false };
            flying.set(key, flight);
            pending.add(copy);
            let late = false;
            const call = within(release, () => channel.send({ message, address, copy })).then(
              (result) => result,
              (error): SendOutcome => ({ ok: false, kind: "network", message: `The send threw: ${errorMessage(error)}` }),
            );
            void call.then((result) => {
              if (flying.get(key) === flight) flying.delete(key);
              pending.delete(copy);
              // An accept after the time limit of the step goes to the log at the next step.
              if (flight.stale || !late || !result.ok) return;
              for (const delivery of digestDeliveries(send, result.accepted, result.receipt)) landed.push({ delivery, copy });
              context.wake?.();
            });
            const outcome = await limited<SendOutcome>(
              call,
              options.callLimit,
              clock,
              () => {
                late = true;
                return { ok: false, kind: "timeout", message: `The send took longer than ${options.callLimit} ms. It stays in flight for up to ${options.flightLimit} ms.` };
              },
              (error) => ({ ok: false, kind: "network", message: `The send threw: ${errorMessage(error)}` }),
            );
            if (!outcome.ok) {
              const retryAt = fail("send", target, outcome.kind, outcome.message, outcome.retryAfter);
              if (refusal(outcome.kind)) refuse(target, outcome.kind, retryAt);
              return;
            }
            reached.add(send.channel);
            const deliveries = digestDeliveries(send, outcome.accepted, outcome.receipt);
            let different: readonly string[];
            try {
              different = context.append(deliveries.map((delivery) => deliveryEvent(delivery, copy, clock.now())));
            } catch (error) {
              // The channel has the digest, and the log does not. The next step writes the deliveries first, thus no second digest goes.
              landed.push(...deliveries.map((delivery) => ({ delivery, copy })));
              context.wake?.();
              throw error;
            }
            conflicts.push(...different);
            const conflicting = new Set(different);
            for (const delivery of deliveries) {
              if (conflicting.has(`delivery:${delivery.key}`)) duplicates.push(delivery.key);
              else sent.push(delivery);
            }
          })(),
        );
      }

      // 4. The stops of the stale copies, in parallel with the sends. A failed stop goes again at a later step.
      // On a channel that is down, only the first ready stop goes: the probe, at the time of the probe. The other stops wait for
      // a step after a good probe.
      const stopped: string[] = [];
      const probed = new Set<ChannelId>();
      const held = new Set<ChannelId>();
      const failedStops = new Set<ChannelId>();
      const goodStops = new Set<ChannelId>();
      for (const [copy, target] of stopping) {
        if (!ready("copy", copy)) continue;
        const channel = byId.get(target.channel);
        if (channel === undefined) {
          stopping.delete(copy);
          continue;
        }
        if (down.has(target.channel)) {
          if (probed.has(target.channel)) {
            held.add(target.channel);
            continue;
          }
          const probeAt = probes.get(target.channel)?.at ?? at;
          if (probeAt > at) {
            waiting.push(probeAt);
            continue;
          }
        }
        // A stop with no free place on its channel goes at a later step.
        const release = place(target.channel);
        if (release === undefined) continue;
        if (down.has(target.channel)) probed.add(target.channel);
        work.push(
          (async () => {
            const failure = await limited<CallFailure | undefined>(
              within(release, () => channel.cancel({ copy })).then(() => undefined),
              options.callLimit,
              clock,
              () => ({ kind: "timeout", message: `The stop of the copy took longer than ${options.callLimit} ms.` }),
              (thrown) => thrownFailure(thrown, "The stop of the copy failed."),
            );
            if (failure !== undefined) {
              failedStops.add(target.channel);
              fail("copy", { ...target, copy }, failure.kind, failure.message);
              // The copy goes to the end of the order. Thus the next probe is another copy, and one bad copy does not hold the others.
              if (stopping.get(copy) === target) {
                stopping.delete(copy);
                stopping.set(copy, target);
              }
              return;
            }
            goodStops.add(target.channel);
            // A late accept during the stop puts a new entry, thus its stop goes again.
            if (stopping.get(copy) === target) stopping.delete(copy);
            stopped.push(copy);
            // A copy whose send did not end can still get an accept, thus the log does not end it yet.
            if (!pending.has(copy)) closed.add(copy);
          })(),
        );
      }

      // Each call ends before the step ends. A write that failed throws after all of them.
      const settled = await Promise.allSettled(work);
      // A channel is down after a step with a failed stop, and up after a step whose stops all ended well. Each failed
      // probe doubles the wait before the next probe, up to the probe limit.
      for (const id of failedStops) {
        down.add(id);
        const failed = (probes.get(id)?.failed ?? 0) + 1;
        probes.set(id, { failed, at: at + backoffDelay(probeWait, failed) });
      }
      for (const id of goodStops) {
        if (failedStops.has(id)) continue;
        down.delete(id);
        probes.delete(id);
      }
      // A good answer of a down channel to another call moves its next probe to the next step.
      const moved = [...reached].filter((id) => down.has(id) && !failedStops.has(id) && (probes.get(id)?.at ?? at) > at);
      for (const id of moved) probes.set(id, { failed: probes.get(id)?.failed ?? 0, at });
      // After a good probe, the held stops go at the next step. It comes soon, not at the next poll. The same holds
      // after a good answer of a down channel with stops to send.
      const stopsOf = new Set([...stopping.values()].map((target) => target.channel));
      if ([...held].some((id) => !down.has(id)) || moved.some((id) => stopsOf.has(id))) {
        waiting.push(at + options.retry);
        context.wake?.();
      }
      // The refusals of the step come after each delivery of the step in the log. Thus only a delivery of a later step
      // ends the hold of a refused channel after a restart, as in the pass. The order decides, not the times: a channel
      // can give a time of acceptance after the time of the refusal.
      write(refusing.map((refused) => ({ ...envelope("refused", `refused:${refused.key}@${at}${frameTag(context.state().steps.length)}`, clock.now()), ...refused })));
      const broken = settled.find((result) => result.status === "rejected");
      if (broken !== undefined) throw broken.reason;

      // 5. The ends of the open copies of the log. A copy with no entry in the state needs no event.
      const unended = context.state().copies;
      write([...closed].filter((copy) => Object.hasOwn(unended, copy)).map((copy) => ({ ...envelope("settled", `settled:${copy}`, clock.now()), copy })));
      closed.clear();

      const after = routesNow().routes;
      const open = after.flatMap((entry) => entry.polls).filter(kept);
      // Only an open receipt needs the time of its last poll. Each other entry goes, thus the map grows with the open receipts only.
      const keep = new Set(open.map((delivery) => delivery.key));
      for (const key of polled.keys()) if (!keep.has(key)) polled.delete(key);
      // A poll that came due and did not go in this step waits for its retry or for a place of its channel. The list
      // `waiting` has the end of that wait. Thus a poll time at or before the step is not a wake time: it is one poll
      // interval after the step, a bound for a poll that no wait holds. On 2026-11-18 such past times made 494 passes
      // in a burst end with a wake time before the pass (AL-75).
      const polls = open.map((delivery) => (polled.get(delivery.key) ?? at) + options.pollEvery).map((time) => (time > at ? time : at + options.pollEvery));
      const wakeAt = earliest([...after.map((entry) => entry.plan.wakeAt), digests.wakeAt, ...polls, ...failures.map((failure) => failure.retryAt), ...waiting]);
      const overdue = overdueSends(after, context.state().refusals, at, options.overdueAfter, left);
      const exhausted = exhaustions(after, descriptors, context.state().merge.reports);
      return { routes: after, sent, duplicates, stopped, acknowledged, cancelled, failures, conflicts, overdue, exhausted, ...(wakeAt === undefined ? {} : { wakeAt }) };
    },
  };

  async function poll(delivery: Delivery, release: () => void): Promise<{ readonly ok: true; readonly status: DeliveryStatus } | { readonly ok: false; readonly kind: string; readonly message: string }> {
    const channel = byId.get(delivery.channel);
    const receipt = delivery.receipt;
    if (channel === undefined || receipt === undefined || !polling.has(delivery.channel)) {
      release();
      return { ok: false, kind: "refused", message: `The channel ${delivery.channel} gives no status here.` };
    }
    return limited(
      within(release, () => channel.status({ receipt })).then((status) => ({ ok: true as const, status })),
      options.callLimit,
      clock,
      () => ({ ok: false as const, kind: "timeout", message: `The status took longer than ${options.callLimit} ms.` }),
      (error) => ({ ok: false as const, kind: "network", message: `The status threw: ${errorMessage(error)}` }),
    );
  }
}

/**
 * This function gives the overdue sends of each channel at `at`. An overdue send is a send of the routes after the
 * step, due for `after` or more. With no `after`, no send is overdue. A send whose last refusal is not a fault of the
 * channel is not overdue (`REFUSAL_FAULTS`). Examples are `consent`, a STOP reply, and `quiet`, a call in the quiet window.
 * A send on a channel of `left` is not overdue, because another copy sends it.
 */
function overdueSends(routes: readonly Route[], refusals: RuntimeState["refusals"], at: Instant, after: Duration | undefined, left: ReadonlySet<string>): OverdueSends[] {
  if (after === undefined) return [];
  const byChannel = new Map<ChannelId, { readonly sends: number; readonly since: Instant }>();
  for (const send of routes.flatMap((entry) => entry.plan.sends)) {
    if (left.has(send.channel)) continue;
    const last = refusals[messageKey(send)]?.kind;
    if (at - send.due < after || (last !== undefined && !REFUSAL_FAULTS[last])) continue;
    const before = byChannel.get(send.channel);
    byChannel.set(send.channel, { sends: (before?.sends ?? 0) + 1, since: Math.min(before?.since ?? send.due, send.due) });
  }
  return [...byChannel].sort(([a], [b]) => compareCodeUnits(a, b)).map(([channel, sends]) => ({ channel, ...sends }));
}

// The event of a delivery, with the copy id of its send.
function deliveryEvent(delivery: Delivery, copy: string, time: Instant): RuntimeEvent {
  return { ...envelope("delivery", `delivery:${delivery.key}`, time), delivery, copy };
}

// The id of the event of a start: one start for each anchor, level and person.
// The id of the start of an escalation. An episode after the first one is in the id, thus its start is a new event of the log.
function startId(entry: Route): string {
  const id = `escalation:${entry.start.incident}:${entry.start.level}:${entry.start.person}`;
  return entry.episode === 0 ? id : `${id}:${String(entry.episode)}`;
}

// The id of the end of an episode of a person in an incident.
function endId(entry: Route): string {
  return `escalation-end:${entry.end?.incident ?? entry.incident.anchor}:${entry.person}:${String(entry.episode)}`;
}
