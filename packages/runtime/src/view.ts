/**
 * This module holds the view of the system at one time: a pure function of the state, the
 * configuration and the time. It applies each fold of the core at the time that the runtime gives. It
 * reads no clock. The view tells the next time when a timer of a fold ends, and the runtime makes the
 * view again at that time.
 */
import {
  DEFAULT_LINK_POLICY,
  advanceHealth,
  balanceUnreadAt,
  carriages,
  CLOCK_STEP_WINDOW,
  copyUnreadAt,
  drillWatchAt,
  sharedHandoverAt,
  sourceClearAt,
  LOG_RECOVERY_WINDOW,
  coverage,
  incidents,
  latenessStep,
  lateSources,
  limitRule,
  linkRule,
  recentRecovery,
  recentStep,
  startHealth,
  storeEmptyAt,
  systemReports,
  threats,
  type Coverage,
  type ChannelDownConfig,
  type ChannelQuota,
  type ChannelSnapshot,
  type CopyWatch,
  type DrillSnapshot,
  type DrillWatch,
  type Exhaustion,
  type HeldPerson,
  type ProviderBalance,
  type CoveragePolicy,
  type DelayLimitOptions,
  type Expectation,
  type Incident,
  type Instant,
  type Lateness,
  type LatenessFolds,
  type LimitRule,
  type LinkPolicy,
  type ObserveCondition,
  type SourceDescriptor,
  type SourceClearConfig,
  type SourceHealth,
  type StoreFill,
  type SystemStep,
  type WatchedPlace,
} from "@mark1russell7/alerts";
import { containingCodes } from "@mark1russell7/alerts-format-nws";
import { envelope, type SystemEvent } from "./events.ts";
import type { FoldContext, RuntimeState } from "./state.ts";

/**
 * The quantile and the level of the two limits of each expectation. In normal work, 1 copy in 100 or
 * fewer comes after the limit of the delay. A run of misses makes a source late by chance in 1 case
 * in 20 or fewer. The count of misses of a snapshot source uses the same tolerance (`missesDecision`).
 */
export const DELAY_LIMITS: DelayLimitOptions = { quantile: 0.99, level: 0.95 };

/** The configuration of the views. The private configuration gives the places. */
export interface ViewConfig extends FoldContext {
  readonly places: readonly WatchedPlace[];
  /** The taxonomy codes or prefixes of the coverage at each place. */
  readonly kinds: readonly string[];
  /** The sources that carry the reports of other sources. */
  readonly expectations: readonly Expectation[];
  /** The quantile and the level of the two limits of each expectation: the delay and the count of misses. They come from the log. */
  readonly delay: DelayLimitOptions;
  readonly coverage?: CoveragePolicy;
  /** The policy of the link rule of the merge. The default is `DEFAULT_LINK_POLICY`. The delivery uses the same policy. */
  readonly link?: LinkPolicy;
  /** The policy of a down channel (AL-65). Each absent field has its default of the core. */
  readonly channelDown?: ChannelDownConfig;
  /** The policy of the end of the line of a down source (AL-75). Each absent field has its default of the core. */
  readonly sourceClear?: SourceClearConfig;
}

/** The view of the system at one time. */
export interface SystemView {
  readonly at: Instant;
  readonly health: readonly SourceHealth[];
  readonly incidents: readonly Incident[];
  readonly lateness: readonly Lateness[];
  readonly coverage: readonly Coverage[];
  /** The step of the system reports. Its reports are new when the state of the system changed. */
  readonly step: SystemStep;
  /** The next time when a timer of the health, of the lateness or of an incident ends. */
  readonly wakeAt?: Instant;
  /** The folds of the lateness at `at`. The next view continues them. They change only the cost of the next view. The lateness stays the same. */
  readonly folds: LatenessFolds;
}

// One rule for each policy of the limits. Thus the folds of one view continue in the next view, because their rule is the same function.
const RULES = new WeakMap<DelayLimitOptions, LimitRule>();

function ruleOf(options: DelayLimitOptions): LimitRule {
  const known = RULES.get(options);
  if (known !== undefined) return known;
  const rule = limitRule(options);
  RULES.set(options, rule);
  return rule;
}

/** The parts of the view that do not come from the log: the counts and the watches at the time of the view. */
export interface SystemParts {
  /** The counts of the channels at the time of the view. With no quotas, each open line of a quota stays open. */
  readonly quotas?: readonly ChannelQuota[];
  /** The watches of the provider accounts. With no balances, each open line of a balance stays open. */
  readonly balances?: readonly ProviderBalance[];
  /** The watches of the other copies of the system. With no copies, each open line of a copy stays open. */
  readonly copies?: readonly CopyWatch[];
  /** The id of this copy. With the watches of the other copies, it chooses the copy that reports a low balance (`reportsShared`). */
  readonly copy?: string;
  /** The folds of the last view (`latenessStep`). With no folds, each fold starts again. The view is the same. */
  readonly folds?: LatenessFolds;
  /** The drills of this copy (`drillStep`). With no drills, each open line of a drill stays open. */
  readonly drills?: readonly DrillSnapshot[];
  /** The drills of other copies in the watch of this copy (`watchedDrills`). With no list, each open line of a watch stays open. */
  readonly drillWatches?: readonly DrillWatch[];
  /**
   * The exhausted escalations of the last delivery step (`DeliveryStep.exhausted`, AL-21). With no list, each open line
   * of an exhaustion stays open. Thus a restart does not cancel an alert before its first delivery step.
   */
  readonly exhausted?: readonly Exhaustion[];
  /**
   * The persons with a hold of the send limit in its window (`heldPersons`, AL-81). With no list, each open line of a
   * hold stays open.
   */
  readonly held?: readonly HeldPerson[];
  /**
   * The channels of this copy, with their runs of failed calls (`ChannelWatch.snapshots`, AL-65). With no list, each open
   * line of a down channel stays open.
   */
  readonly channels?: readonly ChannelSnapshot[];
  /**
   * The conditions of the observe mode of the last pass (`observeConditions`, AL-73). With no list, each open line of
   * the observe mode stays open.
   */
  readonly observing?: readonly ObserveCondition[];
  /** The fills of the families of the stores (AL-86). With no list, each open line of a store stays open. */
  readonly stores?: readonly StoreFill[];
}

/**
 * This function gives the view of the system at the time `at`.
 *
 * - The quotas are the counts of the channels at `at`. With no quotas, each open line of a quota stays open.
 * - The balances are the watches of the provider accounts. The time when a balance reaches `unread` is a timer too.
 * - The copies are the watches of the other copies. The time when a copy reaches `unread` is a timer too.
 * - The drill watches read the starts of the drills of the other copies. The time of a miss of a start is a timer too.
 * - The latest step of the wall clock in its window is a line. The end of the window is a timer too.
 * - The latest recovery of the log in its window is a line. The end of the window is a timer too.
 * - The stores are the fills of their families. The end of the window of a family with no entry is a timer too.
 * - The held persons are the holds of the send limit. The time when the last hold of a person leaves the window is a timer too.
 * - The folds are the folds of the last view (`latenessStep`). With no folds, each fold starts again. The view is the same.
 */
export function systemView(state: RuntimeState, config: ViewConfig, at: Instant, parts: SystemParts = {}): SystemView {
  const { quotas, balances, copies, copy, folds, drills, drillWatches, exhausted, held, channels, observing, stores } = parts;
  const steps = config.sources.map((source) => advanceHealth(state.health[source.id] ?? startHealth(source.id, state.start ?? at), at, source, config.health));
  const health = steps.map((step) => step.health);
  const found = incidents(state.merge, at, { link: linkRule(config.link ?? DEFAULT_LINK_POLICY) });
  const checks = carriages(state.merge, found, config.expectations);
  const { lateness: late, folds: next } = latenessStep(checks, config.expectations, at, ruleOf(config.delay), folds);
  const covered = coverage({ sources: config.sources, health, late: lateSources(late), places: config.places, kinds: config.kinds, containing: containingCodes }, config.coverage);
  const step = systemReports(state.lines, { sources: config.sources, health, coverage: covered, threats: threats(found, config.places), lateness: late, ...(quotas === undefined ? {} : { quotas }), ...(balances === undefined ? {} : { balances }), ...(copies === undefined ? {} : { copies }), ...(copy === undefined ? {} : { copy }), ...(drills === undefined ? {} : { drills }), ...(drillWatches === undefined ? {} : { drillWatches }), ...(exhausted === undefined ? {} : { exhausted }), ...(held === undefined ? {} : { held }), ...(channels === undefined ? {} : { channels }), ...(observing === undefined ? {} : { observing }), ...(stores === undefined ? {} : { stores }), ...(config.channelDown === undefined ? {} : { channelDown: config.channelDown }), ...(config.sourceClear === undefined ? {} : { sourceClear: config.sourceClear }), steps: state.steps, recoveries: state.recoveries }, at);
  // An incident that expires changes the threats, thus its end is a timer too.
  const ends = found.flatMap((incident) => (incident.live && incident.expires !== undefined && incident.expires > at ? [incident.expires] : []));
  // The handover of the facts of a shared account is a timer too, because this copy then reports a low balance.
  const handover = sharedHandoverAt(copy, copies);
  const unread = [...(balances ?? []).map(balanceUnreadAt), ...(copies ?? []).map(copyUnreadAt), ...(stores ?? []).filter((fill) => fill.entries === 0).map(storeEmptyAt), ...(held ?? []).map((entry) => entry.until), ...(drillWatches ?? []).flatMap((watch) => drillWatchAt(step.lines, watch, copies ?? []) ?? []), ...(handover === undefined ? [] : [handover])].filter((time) => time > at);
  const stepped = recentStep(state.steps, at);
  const recovered = recentRecovery(state.recoveries, at);
  // The end of the clear time of each source that is up with an open line is a timer too (AL-75).
  const cleared = sourceClearAt(step.lines, { sources: config.sources, health, ...(config.sourceClear === undefined ? {} : { sourceClear: config.sourceClear }) }, at);
  const wakeAt = earliest([...steps.map((entry) => entry.wakeAt), ...late.map((entry) => entry.wakeAt), ...ends, ...unread, ...cleared, stepped === undefined ? undefined : stepped.at + CLOCK_STEP_WINDOW, recovered === undefined ? undefined : recovered.at + LOG_RECOVERY_WINDOW]);
  return { at, health, incidents: found, lateness: late, coverage: covered, step, ...(wakeAt === undefined ? {} : { wakeAt }), folds: next };
}

/** This function gives the event of the step of a view, or `undefined` when the step has no report. */
export function systemEvent(view: SystemView): SystemEvent | undefined {
  const { reports, observations } = view.step;
  const first = reports[0];
  if (first === undefined) return undefined;
  return { ...envelope("system", `system:${first.key}`, view.at), reports, observations };
}

/** This function gives the time of the next fetch of a source: one interval after the start of its last fetch. A source with no fetch is due at once. */
export function nextFetch(state: RuntimeState, source: SourceDescriptor): Instant {
  const last = state.fetched[source.id];
  return last === undefined ? Number.NEGATIVE_INFINITY : last + source.interval;
}

/** This function gives the earliest time of a list, or `undefined` for a list with no time. */
export function earliest(times: readonly (Instant | undefined)[]): Instant | undefined {
  let found: Instant | undefined;
  for (const time of times) if (time !== undefined && (found === undefined || time < found)) found = time;
  return found;
}
