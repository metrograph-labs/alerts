/**
 * The reports of the system itself. Each source that is down or late becomes a line of reports with the
 * status `system`. Each gap of the coverage and each stage of the quota of a channel also becomes such a line.
 * Each recent step of the wall clock is also a line. So the merge, the assessment and the escalation carry them as they carry the reports of a source.
 *
 * The function is a fold over snapshots of the health and the coverage. A condition that starts
 * gives an alert. A change of its facts gives an update that references the last key of the line.
 * The end of the condition gives a cancel. The fold reads no clock.
 */
import { canonicalJson } from "@mark1russell7/rigor-generators";
import { countOf } from "@mark1russell7/text/english";
import { compareCodeUnits } from "@mark1russell7/text/order";
import { BALANCE_KIND, CHANNEL_KIND, CLOCK_KIND, CONTEXT_KINDS, COPY_KIND, COVERAGE_KIND, DRILL_KIND, ESCALATION_KIND, hasKind, HEALTH_KIND, LIMIT_KIND, LOG_KIND, matchPlaces, PERSON_SUBJECT, QUOTA_KIND, STORE_KIND } from "./assess.ts";
import { isPrivate } from "./audience.ts";
import type {
  Area,
  BalanceStage,
  ChannelId,
  ChannelQuota,
  CopyStage,
  CopyWatch,
  Coverage,
  Duration,
  HealthState,
  Incident,
  Instant,
  Kind,
  Observation,
  Operation,
  PersonId,
  PlaceId,
  ProviderBalance,
  QuotaStage,
  Report,
  ResponseType,
  Severity,
  Significance,
  SourceDescriptor,
  SourceHealth,
  SourceId,
  Subject,
  Urgency,
  WatchedPlace,
} from "./contracts.ts";
import { SYSTEM_SOURCE } from "./contracts.ts";
import { channelDownPolicy, runOpens, type ChannelDownConfig, type ChannelDownPolicy, type ChannelRun, type ChannelSnapshot } from "./channel-down.ts";
import { coverageShort } from "./coverage.ts";
import type { Exhaustion } from "./delivery.ts";
import { drillVerdict, watchedDrillMiss, watchedDrillReportAt, type DrillConfig, type DrillRun, type DrillWatch, type DrillWatchMiss } from "./drill.ts";
import { observationId, reportId } from "./ids.ts";
import type { Lateness } from "./lateness.ts";
import type { ObserveCondition } from "./observe.ts";
import type { HeldPerson } from "./send-limit.ts";
import { kindLabel } from "./taxonomy.ts";

/** The system of the subjects of the health reports. The id of a subject is the id of a source. */
export const SOURCE_SUBJECT = "alerts.source";

/** The system of the subjects of the quota reports. The id of a subject is the id of a channel. */
export const CHANNEL_SUBJECT = "alerts.channel";

/** The system of the subject of the clock reports. The id of the subject is `wall`: the wall clock of the computer. */
export const CLOCK_SUBJECT = "alerts.clock";

/** The system of the subject of the log reports. The id of the subject is `runtime`: the log file of the runtime. */
export const LOG_SUBJECT = "alerts.log";

/** The subject system of another copy of the system. The id of a subject is the id of the copy. */
export const COPY_SUBJECT = "alerts.copy";

/** The system of the subjects of the drill reports. The id of a subject is the id of a drill. */
export const DRILL_SUBJECT = "alerts.drill";

/** The system of the subjects of the store reports (AL-86). The id of a subject is the store and the family, as `shapes/fire`. */
export const STORE_SUBJECT = "alerts.store";

/** The subject system of an incident. The id of a subject is a report of the incident: an exhausted escalation links its warning. */
export const INCIDENT_SUBJECT = "alerts.incident";

/** The stages of a quota, from the first to the last. */
export const QUOTA_STAGES: readonly QuotaStage[] = ["low", "reserve", "spent"];

/** The stages of a balance. `empty` holds `low`. `unread` comes from the time of the last read. */
export const BALANCE_STAGES: readonly BalanceStage[] = ["low", "empty", "unread"];

/**
 * The stages of another copy. `skew` and `config` come from the last read that passed. `unread` comes from its time.
 * `unsteady` comes from the time of the first read that told that the copy is not steady.
 */
export const COPY_STAGES: readonly CopyStage[] = ["skew", "config", "unread", "unsteady"];

/**
 * The longest time that another copy is not steady with no stage `unsteady` (AL-108). The limit is longer than a normal
 * start. The longest ready window is 10 minutes, and a copy is steady 5 minutes after its first pass. The limit adds 5
 * minutes to the sum of the two.
 */
export const COPY_STEADY_LIMIT: Duration = 20 * 60_000;

/** The health states that start a line of health reports. */
export const DOWN_STATES: readonly HealthState[] = ["failing", "silent", "changed"];

/**
 * The policy of the end of the line of a down source (AL-75). The line ends only after the source is up for its clear
 * time: the larger of `floor` and `fetches` intervals of the source. A source that is down again in that time keeps its
 * line. Thus a source that flaps gives one incident, not one incident for each failure.
 */
export interface SourceClearPolicy {
  /** The shortest clear time. At 0 with `fetches` at 0, the line ends at the first state that is not down. */
  readonly floor: Duration;
  /** The count of intervals of the source in the clear time. */
  readonly fetches: number;
}

/** The default policy of the end of the line of a down source: 15 minutes, or 3 intervals of the source when that is longer. */
export const DEFAULT_SOURCE_CLEAR: SourceClearPolicy = { floor: 15 * 60_000, fetches: 3 };

/** The policy of the end of the line of a down source in the configuration. Each absent field has its value of `DEFAULT_SOURCE_CLEAR`. */
export interface SourceClearConfig {
  readonly floor?: Duration;
  readonly fetches?: number;
}

/** This function gives the policy of the end of the line of a down source, with the defaults for the absent fields. */
export function sourceClearPolicy(config?: SourceClearConfig): SourceClearPolicy {
  return { floor: config?.floor ?? DEFAULT_SOURCE_CLEAR.floor, fetches: config?.fetches ?? DEFAULT_SOURCE_CLEAR.fetches };
}

/** This function gives the clear time of a source under a policy: the larger of the floor and the intervals of the source. */
export function sourceClearTime(policy: SourceClearPolicy, source: SourceDescriptor | undefined): Duration {
  return Math.max(policy.floor, policy.fetches * (source?.interval ?? 0));
}

/**
 * This function gives the end times after `at` of the open lines of the sources that are up. Each end time is the start
 * of the state of the source plus its clear time. The runtime wakes at these times. Thus a line ends on time, also when
 * no fetch is due.
 */
export function sourceClearAt(lines: SystemLines, snapshot: Pick<SystemSnapshot, "sources" | "health" | "sourceClear">, at: Instant): Instant[] {
  const policy = sourceClearPolicy(snapshot.sourceClear);
  const descriptors = new Map(snapshot.sources.map((source) => [source.id, source]));
  return snapshot.health.flatMap((health) => {
    if (DOWN_STATES.includes(health.state) || lines.open[healthName(health.source)] === undefined) return [];
    const end = health.since + sourceClearTime(policy, descriptors.get(health.source));
    return end > at ? [end] : [];
  });
}

/** The stages of an incident that make a gap of the coverage more dangerous. An incident with no stage also counts. */
export const THREAT_STAGES: readonly Significance[] = ["warning", "watch"];

/** One step of the wall clock. */
export interface ClockStep {
  /** The time of the step on the wall clock after the step. A later step moves it. */
  readonly at: Instant;
  /** The size of the step in milliseconds: negative for a step back. */
  readonly size: Duration;
}

/**
 * One recovery of the log of the runtime from a broken file. The runtime moved the file into quarantine, and it wrote
 * each event that the salvage read into a new file.
 */
export interface LogRecovery {
  /** The time of the recovery. A later step of the wall clock moves it. */
  readonly at: Instant;
  /** The name of the quarantine folder, in the folder of the log. */
  readonly quarantine: string;
  /** The count of the events that the new file got. */
  readonly kept: number;
  /** The count of the positions of the broken file that the salvage could not read. */
  readonly lost: number;
  /** This value tells if the salvage read each part of the broken file with no problem. Then no event is lost. */
  readonly whole: boolean;
}

/** The time after a recovery of the log during which its system report stays open. Thus the digest of the day shows it. */
export const LOG_RECOVERY_WINDOW: Duration = 24 * 60 * 60 * 1000;

/** The time after a step during which its system report stays open. Thus the digest of the day shows the step. */
export const CLOCK_STEP_WINDOW: Duration = 24 * 60 * 60 * 1000;

/**
 * The fill of one family of a store of the runtime (AL-86), as the fire zones of the store of shapes. A store fills after each
 * start. A family with no entry at the end of its window is a condition.
 */
export interface StoreFill {
  /** The id of the store, as `shapes`. */
  readonly store: string;
  /** The family of the entries, as `fire`. */
  readonly family: string;
  /** The count of the entries of the family at the time of the snapshot. */
  readonly entries: number;
  /** The start of the instance that fills the store. */
  readonly since: Instant;
  /** The time after the start in which the family gets its first entry. */
  readonly within: Duration;
  /** The sources that feed the store. A person who watches one of them gets the report. */
  readonly sources: readonly SourceId[];
}

/** The time after a start in which each family of a store gets its first entry (AL-86). */
export const STORE_FILL_WINDOW: Duration = 60 * 60 * 1000;

/** This function gives the time when a family with no entry becomes a condition: the end of its window after the start. */
export function storeEmptyAt(fill: StoreFill): Instant {
  return fill.since + fill.within;
}

/**
 * This function gives the size of a step in a text: whole hours, whole minutes, or else whole seconds. A step of
 * 3600000 ms is `1 h`, a step of 600000 ms is `10 min`, and a step of 90000 ms is `90 s`.
 */
export function stepSizeText(size: Duration): string {
  const ms = Math.abs(size);
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${String(ms / 3_600_000)} h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${String(ms / 60_000)} min`;
  return `${String(Math.round(ms / 1000))} s`;
}

/** An open line of reports. The fold keeps it until the condition ends. */
export interface SystemLine {
  /** The key of the last report of the line. The next report references it. */
  readonly key: string;
  /** The canonical JSON of the facts of the last report. Only a change of the facts gives an update. */
  readonly facts: string;
  readonly kind: Kind;
  readonly areas: readonly Area[];
  readonly about: readonly Subject[];
  /** The persons of a private line (AL-81). Its cancel goes to the same persons. */
  readonly addresses?: readonly PersonId[];
}

/** The state of the fold. It is data, so the runtime can keep it in its log. */
export interface SystemLines {
  /** The count of the reports of the fold. Each key has it, so each key is new. */
  readonly count: number;
  /** The open lines, by the name of the condition. */
  readonly open: Readonly<Record<string, SystemLine>>;
}

/** The state of the fold before the first snapshot. */
export const NO_SYSTEM_LINES: SystemLines = { count: 0, open: {} };

/** A place and a kind with a live watch or warning. */
export interface Threat {
  readonly place: PlaceId;
  /** The taxonomy code of the incident. */
  readonly kind: string;
}

/** One drill of one copy in a snapshot. */
export interface DrillSnapshot {
  /** The id of the copy that starts the drill. */
  readonly copy: string;
  readonly drill: DrillConfig;
  /** The last run of the drill in the copy. A drill that is due has a run that starts at the time of the snapshot. */
  readonly run?: DrillRun;
  /**
   * This value tells that the drill has no next start: `nextDrillAt` gives `undefined`. Such a drill is a condition, a
   * failure with the reason `no-start`. Thus the path of the life-safety warnings does not lose its test with no report.
   */
  readonly noStart?: boolean;
  /**
   * The start that the drill missed (`missedDrillAt`). Such a drill is a condition, a failure with the reason `missed`.
   * The next run ends it.
   */
  readonly missed?: Instant;
}

/** One snapshot of the system. */
export interface SystemSnapshot {
  /** The descriptors of the sources. The reports take their titles. */
  readonly sources: readonly SourceDescriptor[];
  readonly health: readonly SourceHealth[];
  readonly coverage: readonly Coverage[];
  /** The places and the kinds with a live watch or warning. The function `threats` gives them. */
  readonly threats: readonly Threat[];
  /** The lateness of the sources that carry the reports of other sources. Each `late` entry is a condition. */
  readonly lateness?: readonly Lateness[];
  /**
   * The quotas of the channels. Each stage that `quotaStages` gives is a condition. With no quotas, each
   * open line of a quota stays open: a failed read of a count ends no line.
   */
  readonly quotas?: readonly ChannelQuota[];
  /**
   * The balances of the provider accounts. Each stage that `balanceStages` gives is a condition. With no
   * balances, each open line of a balance stays open. Only one copy reports the stages `low` and `empty` (`reportsShared`).
   */
  readonly balances?: readonly ProviderBalance[];
  /** The id of this copy. With the watches of the other copies, it chooses the copy that reports the facts of a shared account. */
  readonly copy?: string;
  /**
   * The watches of the other copies of the system. Each stage that `copyStages` gives is a condition. With no copies,
   * each open line of a copy stays open.
   */
  readonly copies?: readonly CopyWatch[];
  /** The steps of the wall clock. The latest step in `CLOCK_STEP_WINDOW` before the time of the snapshot is a condition. */
  readonly steps?: readonly ClockStep[];
  /** The recoveries of the log. The latest recovery in `LOG_RECOVERY_WINDOW` before the time of the snapshot is a condition. */
  readonly recoveries?: readonly LogRecovery[];
  /**
   * The fills of the families of the stores (AL-86). A family with no entry at `storeEmptyAt` is a condition. An open line
   * stays a condition while its family has no entry, also after a restart. With no list, each open line of a store stays open.
   */
  readonly stores?: readonly StoreFill[];
  /**
   * The drills of the copy. A run that waits for its acknowledgment is a condition, and a failed last run is a condition.
   * With no drills, each open line of a drill stays open.
   */
  readonly drills?: readonly DrillSnapshot[];
  /**
   * The drills that other copies start, in the watch of this copy (AL-43). The watch reads `copies`. A start that the
   * watch did not see is a condition (`watchedDrillMiss`). With no watches, each open line of a watch stays open.
   */
  readonly drillWatches?: readonly DrillWatch[];
  /**
   * The exhausted escalations of the real warnings (`exhaustions`, AL-21). Each one is a condition, for the people who
   * watch the person. Only one copy reports them (`reportsShared`). With no list, each open line of an exhaustion stays open.
   */
  readonly exhausted?: readonly Exhaustion[];
  /**
   * The persons with a hold of the send limit in its window (`heldPersons`, AL-81). Each one is a private condition for
   * that person. Only one copy reports them (`reportsShared`). With no list, each open line of a hold stays open.
   */
  readonly held?: readonly HeldPerson[];
  /**
   * The channels of this copy, with their runs of failed calls (AL-65). A run that `runOpens` under the policy is a
   * condition. An open line stays a condition until a good call at or after its onset, also with no run. With no list,
   * each open line of a channel stays open.
   */
  readonly channels?: readonly ChannelSnapshot[];
  /** The policy of a down channel. Each absent field has its value of `DEFAULT_CHANNEL_DOWN`. */
  readonly channelDown?: ChannelDownConfig;
  /**
   * The conditions of the observe mode of the new sources (`observeConditions`, AL-73). With no list, each open line
   * of the observe mode stays open.
   */
  readonly observing?: readonly ObserveCondition[];
  /** The policy of the end of the line of a down source (AL-75). Each absent field has its value of `DEFAULT_SOURCE_CLEAR`. */
  readonly sourceClear?: SourceClearConfig;
}

/** The result of one step of the fold. */
export interface SystemStep {
  readonly lines: SystemLines;
  /** The new reports, in the order of the names of their conditions. */
  readonly reports: readonly Report[];
  /** The observation of each new report. The log keeps them, as it keeps the observations of the sources. */
  readonly observations: readonly Observation[];
}

/**
 * This function gives the places and the kinds with a live threat. A threat is an incident with the
 * status `actual`, a stage in `THREAT_STAGES` or no stage, and an area that covers a watched place.
 */
export function threats(incidents: readonly Incident[], places: readonly WatchedPlace[]): Threat[] {
  return incidents.flatMap((incident) => {
    const stage = incident.kind.significance;
    if (isPrivate(incident) || !incident.live || incident.status !== "actual" || (stage !== undefined && !THREAT_STAGES.includes(stage))) return [];
    return matchPlaces(incident, places).map((match) => ({ place: match.place, kind: incident.kind.code }));
  });
}

/**
 * This function gives the stages that a quota reached, in the order of `QUOTA_STAGES`. Each later stage
 * holds the earlier stages. Thus each stage is one line, and the line of the entry into the reserve is
 * one alert in a window.
 */
export function quotaStages(quota: ChannelQuota): QuotaStage[] {
  const left = quota.limit - quota.used;
  const spent = quota.blockedUntil !== undefined || left <= 0;
  const reached: Readonly<Record<QuotaStage, boolean>> = { low: spent || left <= 2 * quota.reserve, reserve: spent || left <= quota.reserve, spent };
  return QUOTA_STAGES.filter((stage) => reached[stage]);
}

/**
 * This function gives the stages of a balance at the time `at`, in the order of `BALANCE_STAGES`.
 *
 * - `low` and `empty` come from the last read that passed, also when the read is old.
 * - `unread` starts at `balanceUnreadAt`. A read that passes ends it.
 */
export function balanceStages(balance: ProviderBalance, at: Instant): BalanceStage[] {
  const read = balance.read;
  const empty = read !== undefined && read.balance <= 0;
  const reached: Readonly<Record<BalanceStage, boolean>> = {
    low: balanceFloorsBelow(balance).length > 0,
    empty,
    unread: at >= balanceUnreadAt(balance),
  };
  return BALANCE_STAGES.filter((stage) => reached[stage]);
}

/** This function gives the time when a balance reaches `unread`: the maximum age after the last read, or after the start with no read. */
export function balanceUnreadAt(balance: ProviderBalance): Instant {
  return (balance.read?.at ?? balance.since) + balance.maxAge;
}

/**
 * This function gives the floors that the last read of a balance is below, from the highest to the lowest, each one time.
 * At 0 or less, the balance is below each floor. With no read, the list is empty.
 */
export function balanceFloorsBelow(balance: ProviderBalance): number[] {
  const read = balance.read;
  if (read === undefined) return [];
  return [...new Set(balance.floors)].filter((floor) => read.balance <= 0 || read.balance < floor).sort((a, b) => b - a);
}

/**
 * This function gives the stages of another copy at the time `at`, in the order of `COPY_STAGES`.
 *
 * - `skew` and `config` come from the last read that passed, also when the read is old.
 * - `unread` starts at `copyUnreadAt`. A read that passes ends it.
 * - `unsteady` starts at `copyUnsteadyAt`. A steady read ends it.
 */
export function copyStages(watch: CopyWatch, at: Instant): CopyStage[] {
  const read = watch.read;
  const reached: Readonly<Record<CopyStage, boolean>> = {
    skew: read !== undefined && Math.abs(read.skew) > watch.skewLimit,
    config: read !== undefined && !read.sameConfig,
    unread: at >= copyUnreadAt(watch),
    unsteady: watch.unsteadySince !== undefined && at >= watch.unsteadySince + COPY_STEADY_LIMIT,
  };
  return COPY_STAGES.filter((stage) => reached[stage]);
}

/** This function gives the time when a copy reaches `unread`: the maximum age after the last read, or after the start with no read. */
export function copyUnreadAt(watch: CopyWatch): Instant {
  return (watch.read?.at ?? watch.since) + watch.maxAge;
}

/** This function gives the time when a copy reaches `unsteady`, or `undefined` when the copy is steady or tells nothing. */
export function copyUnsteadyAt(watch: CopyWatch): Instant | undefined {
  return watch.unsteadySince === undefined ? undefined : watch.unsteadySince + COPY_STEADY_LIMIT;
}

/** The time with no read of another copy after which this copy also reports the facts of a shared account (AL-62). It is longer than a restart. */
export const SHARED_HANDOVER: Duration = 15 * 60_000;

/**
 * This function tells if this copy reports the facts of a shared account at the time `at` (AL-62). Each copy reads the
 * same account, thus each copy sees the same stages `low` and `empty` of a balance.
 *
 * - The copy with the smallest id of the copies that answer reports them. Thus the copies send one alert, not one alert each.
 * - Another copy answers until `SHARED_HANDOVER` after its last read that passed, or after the start of its watch.
 * - With no id of this copy, or with no watches of other copies, this copy reports them.
 */
export function reportsShared(copy: string | undefined, copies: readonly CopyWatch[] | undefined, at: Instant): boolean {
  const from = sharedHandoverAt(copy, copies);
  return from === undefined || from <= at;
}

/**
 * This function gives the time from which this copy reports the facts of a shared account. A copy with a smaller id
 * that answers before that time moves it. With no copy with a smaller id, it gives `undefined`.
 */
export function sharedHandoverAt(copy: string | undefined, copies: readonly CopyWatch[] | undefined): Instant | undefined {
  if (copy === undefined || copies === undefined) return undefined;
  const smaller = copies.filter((watch) => compareCodeUnits(watch.copy, copy) < 0);
  if (smaller.length === 0) return undefined;
  return Math.max(...smaller.map((watch) => (watch.read?.at ?? watch.since) + SHARED_HANDOVER));
}

/**
 * This function gives the latest item at `at` or before it, in `window` before `at`, or `undefined`. Of two items at
 * the same time, it gives the last in the list.
 */
export function latestIn<T extends { readonly at: Instant }>(items: readonly T[], at: Instant, window: Duration): T | undefined {
  let found: T | undefined;
  for (const item of items) if (item.at <= at && at - item.at < window && (found === undefined || item.at >= found.at)) found = item;
  return found;
}

/** This function gives the latest step at `at` or before it, in `CLOCK_STEP_WINDOW` before `at`, or `undefined`. */
export function recentStep(steps: readonly ClockStep[], at: Instant): ClockStep | undefined {
  return latestIn(steps, at, CLOCK_STEP_WINDOW);
}

/** This function gives the latest recovery of the log at `at` or before it, in `LOG_RECOVERY_WINDOW` before `at`, or `undefined`. */
export function recentRecovery(recoveries: readonly LogRecovery[], at: Instant): LogRecovery | undefined {
  return latestIn(recoveries, at, LOG_RECOVERY_WINDOW);
}

/**
 * This function gives the CAP severity and urgency of a gap of the coverage. The assessment policy
 * gives the level from them:
 *
 * - No independent source during a threat of the kind: `extreme` and `immediate`.
 * - Fewer independent sources than the policy needs: `severe` and `expected`.
 * - A count that the search did not prove: `moderate` and `expected`.
 */
export function gapGrade(entry: Coverage, threatened: boolean): { readonly severity: Severity; readonly urgency: Urgency } {
  if (entry.independent === 0 && threatened) return { severity: "extreme", urgency: "immediate" };
  if (entry.independent < entry.required) return { severity: "severe", urgency: "expected" };
  return { severity: "moderate", urgency: "expected" };
}

/**
 * This function adds one snapshot to the fold at the time `at`. Each of these is a condition:
 *
 * - Each source in `DOWN_STATES`, each late expectation and each coverage that is short. The open line of a source that is
 *   up stays a condition for the clear time of the source (`sourceClearTime`).
 * - Each stage of a quota, each stage of a balance and each stage of another copy. Only one copy reports the stages
 *   `low` and `empty` of a balance (`reportsShared`). The stage `unread` is a fact of each copy.
 * - The latest step of the wall clock in `CLOCK_STEP_WINDOW` before `at`.
 * - The latest recovery of the log in `LOG_RECOVERY_WINDOW` before `at`.
 * - Each run of a drill that waits for its acknowledgment, and each drill whose last run failed.
 * - Each start of a drill of another copy that the watch of this copy did not see (`watchedDrillMiss`).
 * - Each exhausted escalation of a real warning. Only one copy reports it (`reportsShared`).
 * - Each person with a hold of the send limit in its window. The report is private. Only one copy reports it (`reportsShared`).
 * - Each down channel of the copy: a run that opens a line, or an open line with no good call since its onset.
 * - Each family of a store with no entry at the end of its window after the start, or with an open line and no entry.
 *
 * An open line with no condition in the snapshot ends with a cancel. Equal snapshots give no new report.
 */
export function systemReports(lines: SystemLines, snapshot: SystemSnapshot, at: Instant): SystemStep {
  const conditions = new Map<string, Condition>();
  const titles = new Map(snapshot.sources.map((source) => [source.id, source.title]));
  const context = new Set(snapshot.sources.filter(contextSource).map((source) => source.id));
  const descriptors = new Map(snapshot.sources.map((source) => [source.id, source]));
  const clear = sourceClearPolicy(snapshot.sourceClear);
  for (const health of snapshot.health) {
    const name = healthName(health.source);
    // A source that is up keeps its open line for its clear time, with the facts of the line. Thus a source that flaps
    // gives no cancel and no new alert (AL-75). On 2026-11-18, a source that failed 2 fetches of 4 gave one incident for each flap.
    const state = DOWN_STATES.includes(health.state) ? health.state : heldState(lines.open[name], health, at, sourceClearTime(clear, descriptors.get(health.source)));
    if (state !== undefined) conditions.set(name, healthCondition({ ...health, state }, titles.get(health.source) ?? health.source, context.has(health.source)));
  }
  for (const entry of snapshot.lateness ?? []) {
    if (entry.state === "late") conditions.set(lateName(entry.expectation), lateCondition(entry, titles));
  }
  for (const entry of snapshot.coverage) {
    if (!coverageShort(entry)) continue;
    const threatened = snapshot.threats.some((threat) => threat.place === entry.place && hasKind([entry.kind], threat.kind));
    conditions.set(coverageName(entry.place, entry.kind), coverageCondition(entry, threatened));
  }
  for (const quota of snapshot.quotas ?? []) {
    for (const stage of quotaStages(quota)) conditions.set(quotaName(quota.channel, stage), quotaCondition(quota, stage));
  }
  // The stages low and empty are facts of the account, and one copy reports them. The stage unread is a fact of this copy.
  const shared = reportsShared(snapshot.copy, snapshot.copies, at);
  for (const balance of snapshot.balances ?? []) {
    for (const stage of balanceStages(balance, at)) {
      if (stage !== "unread" && !shared) continue;
      if (stage !== "low") conditions.set(balanceName(balance.provider, stage), balanceCondition(balance, stage, at));
      // Each floor that the balance is below is its own line. Thus each floor gives its own alert.
      else for (const floor of balanceFloorsBelow(balance)) conditions.set(balanceName(balance.provider, stage, floor), balanceCondition(balance, stage, at, floor));
    }
  }
  for (const watch of snapshot.copies ?? []) {
    for (const stage of copyStages(watch, at)) conditions.set(copyName(watch.copy, stage), copyCondition(watch, stage, at));
    // A copy that starts again and again answers in each try, and it stops after each try. Thus an open line of the copy
    // ends only at a steady read (AL-108). On 2026-11-21, a copy made 125 starts, and its line unread opened at each stop.
    // An open line unsteady also stays open over a restart of this copy, until the first steady read.
    const steadyRead = watch.read !== undefined && watch.unsteadySince === undefined;
    for (const stage of ["unread", "unsteady"] as const) {
      const name = copyName(watch.copy, stage);
      const held = stage === "unread" ? watch.unsteadySince !== undefined : !steadyRead;
      if (held && !conditions.has(name) && lines.open[name] !== undefined) conditions.set(name, copyCondition(watch, stage, at));
    }
  }
  const step = recentStep(snapshot.steps ?? [], at);
  if (step !== undefined) conditions.set(CLOCK_LINE, clockCondition(step));
  const recovery = recentRecovery(snapshot.recoveries ?? [], at);
  if (recovery !== undefined) conditions.set(LOG_LINE, logCondition(recovery));
  for (const entry of snapshot.drills ?? []) {
    const { copy, drill, run } = entry;
    if (entry.noStart === true) conditions.set(`${drillName(copy, drill.id)}/no-start`, drillNoStartCondition(copy, drill));
    if (run === undefined || run.drill !== drill.id) continue;
    if (entry.missed !== undefined) conditions.set(`${drillName(copy, drill.id)}/missed`, drillMissedCondition(copy, drill, run, entry.missed));
    const verdict = drillVerdict(drill, run, at);
    if (verdict.state === "pending") conditions.set(drillName(copy, drill.id), drillRunCondition(copy, drill, run));
    else if (verdict.state === "failed") conditions.set(`${drillName(copy, drill.id)}/failed`, drillFailedCondition(copy, drill, run, verdict.why));
  }
  // A copy that stops for the full window of a start tells nothing in that time. Thus each other copy tells of it.
  for (const watch of snapshot.drillWatches ?? []) {
    const name = drillWatchName(watch);
    const miss = watchedDrillMiss(watch, snapshot.copies ?? [], at, heldDue(lines.open[name]));
    if (miss !== undefined) conditions.set(name, drillWatchCondition(watch, miss));
  }
  // The two copies see the same exhaustion in the shared log. Thus one copy reports it, as with a shared balance.
  if (shared) for (const entry of snapshot.exhausted ?? []) conditions.set(exhaustionName(entry), exhaustionCondition(entry));
  // Each copy counts the deliveries of all the copies, thus each copy holds the same burst. One copy tells each person (AL-81).
  if (shared) for (const entry of snapshot.held ?? []) conditions.set(heldName(entry), heldCondition(entry));
  // Each copy reports its own down channels, because each copy has its own network path to the provider.
  const policy = channelDownPolicy(snapshot.channelDown);
  for (const entry of snapshot.channels ?? []) {
    const name = channelName(entry.copy, entry.channel);
    const condition = channelCondition(entry, lines.open[name], policy);
    if (condition !== undefined) conditions.set(name, condition);
  }
  for (const entry of snapshot.observing ?? []) conditions.set(observeName(entry), observeCondition(entry, titles.get(entry.source) ?? entry.source, context.has(entry.source)));
  // A restart gives a new start. Thus an open line of a family with no entry stays open, and it gives no new alert.
  for (const fill of snapshot.stores ?? []) {
    const name = storeName(fill);
    if (fill.entries === 0 && (at >= storeEmptyAt(fill) || lines.open[name] !== undefined)) conditions.set(name, storeCondition(fill, titles));
  }
  const names = [...new Set([...Object.keys(lines.open), ...conditions.keys()])].sort(compareCodeUnits);
  let count = lines.count;
  const open = new Map(Object.entries(lines.open));
  const reports: Report[] = [];
  const observations: Observation[] = [];
  for (const name of names) {
    const line = lines.open[name];
    const condition = conditions.get(name);
    if (condition === undefined && snapshot.quotas === undefined && name.startsWith(QUOTA_LINE)) continue;
    if (condition === undefined && snapshot.balances === undefined && name.startsWith(BALANCE_LINE)) continue;
    if (condition === undefined && snapshot.copies === undefined && name.startsWith(COPY_LINE)) continue;
    if (condition === undefined && snapshot.drills === undefined && name.startsWith(DRILL_LINE)) continue;
    if (condition === undefined && snapshot.drillWatches === undefined && name.startsWith(DRILL_WATCH_LINE)) continue;
    if (condition === undefined && snapshot.exhausted === undefined && name.startsWith(EXHAUSTION_LINE)) continue;
    if (condition === undefined && snapshot.held === undefined && name.startsWith(HELD_LINE)) continue;
    if (condition === undefined && snapshot.channels === undefined && name.startsWith(CHANNEL_LINE)) continue;
    if (condition === undefined && snapshot.observing === undefined && name.startsWith(OBSERVE_LINE)) continue;
    if (condition === undefined && snapshot.stores === undefined && name.startsWith(STORE_LINE)) continue;
    const draft = condition === undefined ? (line === undefined ? undefined : cancelOf(line)) : condition;
    if (draft === undefined) continue;
    const facts = canonicalJson(draft.facts, { form: "json" });
    if (line !== undefined && condition !== undefined && line.facts === facts) continue;
    const op: Operation = condition === undefined ? "cancel" : line === undefined ? "alert" : "update";
    count += 1;
    const key = `${name}#${count}`;
    const observation = observationOf(name, op, draft.facts, at);
    observations.push(observation);
    reports.push(reportOf(draft, { key, op, references: line === undefined ? [] : [line.key], at, observation: observation.id }));
    if (op === "cancel") open.delete(name);
    else open.set(name, { key, facts, kind: draft.kind, areas: draft.areas, about: draft.about, ...(draft.addresses === undefined ? {} : { addresses: draft.addresses }) });
  }
  const sorted = [...open.entries()].sort(([a], [b]) => compareCodeUnits(a, b));
  return { lines: { count, open: Object.fromEntries(sorted) }, reports, observations };
}

/**
 * This function adds the reports of the fold to the lines, in their order. It gives the lines that
 * `systemReports` gave with these reports. Thus the runtime rebuilds the lines from its log, and the
 * log holds no copy of the state. A report of another source changes nothing.
 *
 * The observation of each report gives the facts of its line. The function throws when an observation
 * is not in `observations`, because then the log is not complete.
 */
export function addSystemReports(lines: SystemLines, reports: readonly Report[], observations: readonly Observation[]): SystemLines {
  const bodies = new Map(observations.map((observation) => [observation.id, observation.body]));
  let count = lines.count;
  const open = new Map(Object.entries(lines.open));
  for (const report of reports) {
    if (report.source !== SYSTEM_SOURCE) continue;
    const mark = report.key.lastIndexOf("#");
    const name = report.key.slice(0, mark);
    const body = bodies.get(report.observation);
    if (mark < 0 || body === undefined) throw new Error(`The system report ${report.key} has no observation ${report.observation}.`);
    const { facts } = JSON.parse(body) as { readonly facts: Condition["facts"] };
    count = Math.max(count, Number(report.key.slice(mark + 1)));
    if (report.op === "cancel") open.delete(name);
    else open.set(name, { key: report.key, facts: canonicalJson(facts, { form: "json" }), kind: report.kind, areas: report.areas, about: report.about, ...(report.addresses === undefined ? {} : { addresses: report.addresses }) });
  }
  const sorted = [...open.entries()].sort(([a], [b]) => compareCodeUnits(a, b));
  return { count, open: Object.fromEntries(sorted) };
}

// The parts of a report that a condition gives. The fold adds the key, the references, the times and the observation.
interface Condition {
  readonly facts: Readonly<Record<string, unknown>>;
  readonly kind: Kind;
  readonly severity: Severity;
  readonly urgency: Urgency;
  readonly response: readonly ResponseType[];
  readonly onset?: Instant;
  readonly areas: readonly Area[];
  readonly about: readonly Subject[];
  /** The persons of a private condition (AL-81). Only they get its report. */
  readonly addresses?: readonly PersonId[];
  readonly headline: string;
  readonly description?: string;
  readonly instruction?: string;
  readonly parameters: Readonly<Record<string, readonly string[]>>;
}

const HEADLINES: Readonly<Record<string, string>> = {
  failing: "the fetches fail",
  silent: "the source gives no new data",
  changed: "the format of the source changed",
};

function healthName(source: SourceId): string {
  return `health/${encodeURIComponent(source)}`;
}

function lateName(expectation: string): string {
  return `late/${encodeURIComponent(expectation)}`;
}

// The start of the name of each line of a quota.
const QUOTA_LINE = "quota/";

function quotaName(channel: string, stage: QuotaStage): string {
  return `${QUOTA_LINE}${encodeURIComponent(channel)}/${stage}`;
}

// The start of the name of each line of a balance.
const BALANCE_LINE = "balance/";

function balanceName(provider: string, stage: BalanceStage, floor?: number): string {
  const name = `${BALANCE_LINE}${encodeURIComponent(provider)}/${stage}`;
  return floor === undefined ? name : `${name}/${String(floor)}`;
}

// The start of the name of each line of another copy.
const COPY_LINE = "copy/";

function copyName(copy: string, stage: CopyStage): string {
  return `${COPY_LINE}${encodeURIComponent(copy)}/${stage}`;
}

// The start of the name of each line of a drill. The id of the copy is in the name, because each copy starts its own runs.
const DRILL_LINE = "drill/";

function drillName(copy: string, drill: string): string {
  return `${DRILL_LINE}${encodeURIComponent(copy)}/${encodeURIComponent(drill)}`;
}

// The start of the name of each line of the watch of a drill of another copy. A watch with no copy has an empty part.
const DRILL_WATCH_LINE = "drill-watch/";

function drillWatchName(watch: DrillWatch): string {
  return `${DRILL_WATCH_LINE}${encodeURIComponent(watch.copy ?? "")}/${encodeURIComponent(watch.drill.id)}`;
}

// The due start of an open line of a watch. The line keeps it over a restart of this copy, because the log rebuilds the lines.
function heldDue(line: SystemLine | undefined): Instant | undefined {
  if (line === undefined) return undefined;
  const { due } = JSON.parse(line.facts) as { readonly due?: unknown };
  return typeof due === "number" && Number.isFinite(due) ? due : undefined;
}

/**
 * This function gives the time when the watch of a drill of another copy tells of a miss. The open line of the watch in
 * `lines` keeps its due start. The function gives `undefined` when the watch waits for no start. A timer can wait for the time.
 */
export function drillWatchAt(lines: SystemLines, watch: DrillWatch, copies: readonly CopyWatch[]): Instant | undefined {
  return watchedDrillReportAt(watch, copies, heldDue(lines.open[drillWatchName(watch)]));
}

// The name of the line of the steps of the wall clock. A step in the window of an open line gives an update.
const CLOCK_LINE = "clock";

// The name of the line of the recoveries of the log. A second recovery in the window of an open line gives an update.
const LOG_LINE = "log";

// The start of the name of each line of a store. The store and the family follow it.
const STORE_LINE = "store/";

function storeName(fill: StoreFill): string {
  return `${STORE_LINE}${encodeURIComponent(fill.store)}/${encodeURIComponent(fill.family)}`;
}

function coverageName(place: PlaceId, kind: string): string {
  return `coverage/${encodeURIComponent(place)}/${encodeURIComponent(kind)}`;
}

// The start of the name of each line of an exhausted escalation. The copy is not in the name: one copy reports it.
const CHANNEL_LINE = "channel/";

function channelName(copy: string, channel: string): string {
  return `${CHANNEL_LINE}${copy}/${channel}`;
}

/** This function gives the channels of a copy with an open line of a down channel, in the order of their ids. The runtime probes them. */
export function downChannels(lines: SystemLines, copy: string): ChannelId[] {
  const prefix = channelName(copy, "");
  return Object.keys(lines.open)
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length) as ChannelId)
    .sort(compareCodeUnits);
}

// The facts of the line of a down channel. A new count is not a fact, so the line gives one alert. A new cause gives an update.
interface ChannelDownFacts {
  readonly copy: string;
  readonly channel: string;
  readonly onset: Instant;
  /** `key`: the provider refuses the key of the channel. `outage`: the calls get no answer, or a fault of the provider. */
  readonly cause: "key" | "outage";
}

function causeOf(run: ChannelRun): ChannelDownFacts["cause"] {
  return run.kind === "auth" ? "key" : "outage";
}

// The time of a run in a text: whole seconds under 2 min, else whole minutes.
function spanText(span: number): string {
  return stepSizeText(span < 120_000 ? Math.round(span / 1000) * 1000 : Math.round(span / 60_000) * 60_000);
}

const FAILURE_TEXT: Readonly<Record<string, string>> = {
  network: "the network to the provider failed",
  timeout: "the provider gave no answer in time",
  server: "the provider gave a server error",
  auth: "the provider refused the key",
};

// The condition of one channel of a copy. An open line stays until a good call at or after its onset. A restart
// empties the run, and an empty run does not end the line. A closed line opens only for a run that `runOpens`.
function channelCondition(entry: ChannelSnapshot, line: SystemLine | undefined, policy: ChannelDownPolicy): Condition | undefined {
  const { copy, channel, title, run, good } = entry;
  const open = line === undefined ? undefined : (JSON.parse(line.facts) as ChannelDownFacts);
  let facts: ChannelDownFacts;
  if (open !== undefined) {
    if (good !== undefined && good >= open.onset) return undefined;
    facts = run === undefined ? open : { ...open, cause: causeOf(run) };
  } else {
    if (run === undefined || !runOpens(run, policy) || (good !== undefined && good >= run.first)) return undefined;
    facts = { copy, channel, onset: run.first, cause: causeOf(run) };
  }
  const code = `${CHANNEL_KIND}.down`;
  const count = run === undefined ? "" : ` ${String(run.failures)} calls failed in ${spanText(run.last - run.first)}, and ${FAILURE_TEXT[run.kind] ?? run.kind} at the last call.`;
  const text =
    facts.cause === "key"
      ? {
          headline: `The provider of ${title} refuses the key of the channel. This is not an outage.`,
          description: `The copy ${copy} cannot send on ${title}.${count} The fault does not end by itself.`,
          instruction: "Replace the key of the channel in the secrets of the copy. Until then, the other channels carry the alerts.",
        }
      : {
          headline: `${title} is down for the copy ${copy}.`,
          description: `The calls of the copy ${copy} to the provider of ${title} fail.${count}`,
          instruction: "The other channels carry the alerts. The line ends at the next call that passes.",
        };
  return {
    facts: { ...facts },
    kind: { code, label: kindLabel(code) },
    severity: "severe",
    urgency: "expected",
    response: ["assess"],
    onset: facts.onset,
    areas: [],
    about: [{ system: CHANNEL_SUBJECT, id: channel, label: title }, ...(entry.api ?? []).flatMap(entitySubject)],
    ...text,
    parameters: { copy: [copy], channel: [channel], cause: [facts.cause], ...(run === undefined ? {} : { failures: [String(run.failures)], last: [run.kind] }) },
  };
}

// The subject of the key of an entity, as `domain:api.twilio.com`. The id is the text after the first colon.
// The schema refuses an endpoint key with no system or no id. A descriptor in code has no parse, thus such a key gives no subject.
function entitySubject(key: string): Subject[] {
  const colon = key.indexOf(":");
  if (colon <= 0 || colon === key.length - 1) return [];
  return [{ system: key.slice(0, colon), id: key.slice(colon + 1) }];
}

// The start of the name of each line of the observe mode.
const OBSERVE_LINE = "observe/";

function observeName(entry: ObserveCondition): string {
  return `${OBSERVE_LINE}${encodeURIComponent(entry.source)}/${entry.state}`;
}

function observeCondition(entry: ObserveCondition, title: string, context: boolean): Condition {
  // As with the health, a condition of a source of context reaches the digest at most.
  const terms = context ? ({ severity: "minor", urgency: "future" } as const) : ({ severity: "moderate", urgency: "expected" } as const);
  const about = [{ system: SOURCE_SUBJECT, id: entry.source, label: title }];
  if (entry.state === "held") {
    return {
      // The reason has counts, so it is not a fact: a new count gives no update.
      facts: { source: entry.source, state: entry.state },
      kind: { code: `${HEALTH_KIND}.observe`, label: "Source held in observe mode" },
      ...terms,
      response: ["assess"],
      onset: entry.since,
      areas: [],
      about,
      headline: `${title}: the source stays in the observe mode.`,
      ...(entry.reason === "" ? {} : { description: entry.reason }),
      instruction: "Examine the areas of the source. The source goes live after one day with no cap passed.",
      parameters: { state: [entry.state] },
    };
  }
  // Each new incident is a new fact, so it gives an update.
  const count = entry.incidents.length;
  return {
    facts: { source: entry.source, state: entry.state, incidents: entry.incidents },
    kind: { code: `${HEALTH_KIND}.observe-life-safety`, label: "Life-safety alert from a source in observe mode" },
    ...terms,
    response: ["assess"],
    ...(Number.isFinite(entry.since) ? { onset: entry.since } : {}),
    areas: [],
    about,
    headline: `${title}: a source in the observe mode gave ${String(count)} life-safety ${count === 1 ? "alert" : "alerts"}.`,
    description: "The observe mode sent each life-safety alert, because a missed real warning is worse than a wrong one.",
    instruction: "Examine the areas of the source and each alert. A wrong area makes alerts for a person away from the event.",
    parameters: { state: [entry.state], incident: entry.incidents },
  };
}

const EXHAUSTION_LINE = "exhausted/";

function exhaustionName(entry: Exhaustion): string {
  return `${EXHAUSTION_LINE}${encodeURIComponent(entry.person)}/${encodeURIComponent(entry.incident)}/${String(entry.episode)}/${entry.level}`;
}

// The severity and the urgency of an exhaustion at each level. The table of the class `system-escalation` gives back the level.
const EXHAUSTION_TERMS: Readonly<Record<Exhaustion["level"], { readonly severity: Severity; readonly urgency: Urgency }>> = {
  "life-safety": { severity: "extreme", urgency: "immediate" },
  urgent: { severity: "severe", urgency: "expected" },
  notice: { severity: "moderate", urgency: "future" },
  digest: { severity: "minor", urgency: "past" },
};

function exhaustionCondition(entry: Exhaustion): Condition {
  const code = `${ESCALATION_KIND}.exhausted`;
  return {
    // The facts do not change while the escalation stays exhausted. Thus it gives one alert, and an acknowledgment or the end gives its cancel.
    // The title is not a fact: a new text of the warning gives no new alert.
    facts: { person: entry.person, incident: entry.incident, episode: entry.episode, level: entry.level, at: entry.at },
    kind: { code, label: kindLabel(code) },
    ...EXHAUSTION_TERMS[entry.level],
    response: ["assess"],
    onset: entry.at,
    // The report has no area. Thus it reaches only the people who watch the person, and not the people at the place.
    areas: [],
    about: [
      { system: PERSON_SUBJECT, id: entry.person, label: `Person ${entry.person}` },
      { system: INCIDENT_SUBJECT, id: entry.incident, label: entry.title },
    ],
    // The headline tells what the person missed: the kind, the title and the level of the warning.
    headline: `${entry.person} did not acknowledge ${entry.kind.label} (${entry.level})${entry.title === entry.kind.label ? "" : `: ${entry.title}`}`,
    description: `The warning reached ${entry.person} at the level ${entry.level}. No acknowledgment came before ${new Date(entry.at).toISOString()}, the end of the escalation.`,
    instruction: `Speak to ${entry.person}. An acknowledgment of the warning by ${entry.person} ends this alert.`,
    parameters: { person: [entry.person], level: [entry.level], kind: [entry.kind.code], incident: [entry.incident] },
  };
}

const HELD_LINE = "held/";

/** The count of the held alerts that a notice of the send limit names (AL-98). The next digest tells each one. */
export const HELD_SHOWN = 3;

/**
 * This function gives the text of a notice of the send limit (AL-98). It names the held alerts from the highest level,
 * with their levels, and the count of the rest. The text is the text of the first report of the line. Thus a later hold
 * in the window does not change it.
 */
export function heldText(entry: Pick<HeldPerson, "alerts">): string {
  const end = "The limit does not hold a life-safety warning.";
  if (entry.alerts.length === 0) return `More new alerts came than your send limit lets through in one window. ${end}`;
  const shown = entry.alerts.slice(0, HELD_SHOWN).map((alert) => `- ${alert.headline} (${alert.level})`);
  const rest = entry.alerts.length - shown.length;
  return [`The send limit holds ${countOf(entry.alerts.length, "new alert")} for you:`, ...shown, ...(rest > 0 ? [`- ${countOf(rest, "other alert")}`] : []), end].join("\n");
}

function heldName(entry: HeldPerson): string {
  return `${HELD_LINE}${encodeURIComponent(entry.person)}`;
}

function heldCondition(entry: HeldPerson): Condition {
  const code = `${LIMIT_KIND}.held`;
  return {
    // The person is the only fact. Thus the first hold of a window gives one alert, and a later hold in the window gives no report.
    // The line ends one window after the last hold. A hold after that end opens a new line, thus a new message.
    facts: { person: entry.person },
    kind: { code, label: kindLabel(code) },
    // The table of the system reports gives the level `notice`.
    severity: "moderate",
    urgency: "expected",
    response: ["none"],
    onset: entry.first,
    // The report is private. Thus only the person with the holds gets it, and the people who watch the person do not.
    areas: [],
    about: [{ system: PERSON_SUBJECT, id: entry.person, label: `Person ${entry.person}` }],
    addresses: [entry.person],
    headline: "The send limit holds new alerts for you",
    description: heldText(entry),
    instruction: "Read the next digest. It tells each held alert.",
    parameters: { person: [entry.person] },
  };
}

function drillRunCondition(copy: string, drill: DrillConfig, run: DrillRun): Condition {
  const code = `${DRILL_KIND}.run`;
  return {
    // The start is the only fact. Thus a run gives one alert, and the end of the wait gives its cancel.
    facts: { copy, drill: drill.id, at: run.at },
    kind: { code, label: kindLabel(code) },
    severity: "extreme",
    urgency: "immediate",
    response: ["none"],
    onset: run.at,
    areas: [],
    about: [{ system: DRILL_SUBJECT, id: drill.id, label: `Drill ${drill.id}` }],
    headline: `Drill ${drill.id}: acknowledge this message. This is not a warning.`,
    description: `This message tests the path of the life-safety warnings from the copy ${copy}. An acknowledgment in ${String(Math.round(drill.ackWithin / 60_000))} minutes passes the drill.`,
    instruction: "Acknowledge the message.",
    parameters: { drill: [drill.id], copy: [copy] },
  };
}

function drillFailedCondition(copy: string, drill: DrillConfig, run: DrillRun, why: "no-ack" | "late-ack"): Condition {
  const code = `${DRILL_KIND}.failed`;
  const late = why === "late-ack";
  return {
    // Each run and each reason is a new fact. Thus a late acknowledgment after a failure gives an update.
    facts: { copy, drill: drill.id, at: run.at, why },
    kind: { code, label: kindLabel(code) },
    severity: "moderate",
    urgency: "expected",
    response: ["assess"],
    onset: run.at + drill.ackWithin,
    areas: [],
    about: [{ system: DRILL_SUBJECT, id: drill.id, label: `Drill ${drill.id}` }],
    headline: `The drill ${drill.id} failed: ${late ? "the acknowledgment came late" : "no acknowledgment came"}.`,
    description: `The drill started at ${new Date(run.at).toISOString()} on the channel ${drill.path.channel}, from the copy ${copy}. A real warning on this path can also go without an answer.`,
    instruction: "Examine the channel, the app and the settings of the phone. The next run of the drill tests the path again.",
    parameters: { drill: [drill.id], copy: [copy], why: [why] },
  };
}

function drillMissedCondition(copy: string, drill: DrillConfig, run: DrillRun, due: Instant): Condition {
  const code = `${DRILL_KIND}.failed`;
  return {
    // The missed start comes from the last run, thus it stays the same until the next run ends the line.
    facts: { copy, drill: drill.id, due, why: "missed" },
    kind: { code, label: kindLabel(code) },
    severity: "moderate",
    urgency: "expected",
    response: ["assess"],
    onset: due,
    areas: [],
    about: [{ system: DRILL_SUBJECT, id: drill.id, label: `Drill ${drill.id}` }],
    headline: `The drill ${drill.id} did not start at its time.`,
    description: `The drill was due at ${new Date(due).toISOString()} on the channel ${drill.path.channel}, from the copy ${copy}. No run started in its window. The last run started at ${new Date(run.at).toISOString()}.`,
    instruction: "Examine why the copy did not operate in the window of the drill. The next run of the drill tests the path again.",
    parameters: { drill: [drill.id], copy: [copy], why: ["missed"] },
  };
}

function drillNoStartCondition(copy: string, drill: DrillConfig): Condition {
  const code = `${DRILL_KIND}.failed`;
  return {
    // The drill and the reason are the only facts. Thus the line gives one alert, and a next start gives its cancel.
    facts: { copy, drill: drill.id, why: "no-start" },
    kind: { code, label: kindLabel(code) },
    severity: "moderate",
    urgency: "expected",
    response: ["assess"],
    areas: [],
    about: [{ system: DRILL_SUBJECT, id: drill.id, label: `Drill ${drill.id}` }],
    headline: `The drill ${drill.id} has no next start.`,
    description: `Each time of the window of the drill is in the quiet window of the person, or too near to it. The copy ${copy} does not test the path on the channel ${drill.path.channel}.`,
    instruction: "Change the window of the drill or the quiet window of the person in the configuration.",
    parameters: { drill: [drill.id], copy: [copy], why: ["no-start"] },
  };
}

function drillWatchCondition(watch: DrillWatch, miss: DrillWatchMiss): Condition {
  const code = `${DRILL_KIND}.failed`;
  const { drill } = watch;
  const copy = watch.copy === undefined ? "the copy of rank 0" : `the copy ${watch.copy}`;
  const Copy = `T${copy.slice(1)}`;
  const noRead = miss.why === "no-read";
  const due = `The drill was due at ${new Date(miss.due).toISOString()}, and its window ended at ${new Date(miss.end).toISOString()}.`;
  const read = miss.read === undefined ? `No read of ${copy} passed after the start of the watch.` : `The last read of ${copy} that passed was at ${new Date(miss.read).toISOString()}.`;
  const last = miss.last === undefined ? "No read gave a start of the drill." : `The last start of the drill in the reads was at ${new Date(miss.last).toISOString()}.`;
  return {
    // The due start and the reason are the only facts. Thus a new read and a restart of this copy give no update.
    facts: { watched: watch.copy ?? "", drill: drill.id, due: miss.due, why: miss.why },
    kind: { code, label: kindLabel(code) },
    severity: noRead ? "minor" : "moderate",
    urgency: "expected",
    response: ["assess"],
    onset: miss.end,
    areas: [],
    about: [{ system: DRILL_SUBJECT, id: drill.id, label: `Drill ${drill.id}` }],
    headline: noRead ? `This copy cannot tell if the drill ${drill.id} started.` : `No start of the drill ${drill.id} came from ${copy}.`,
    description: noRead
      ? `${due} ${Copy} answers, but its answers give no starts of drills. A copy of an older build gives none.`
      : `${due} ${read} ${last} The path of the life-safety warnings on the channel ${drill.path.channel} has no test from that copy.`,
    instruction: noRead
      ? `Update ${copy} to the build of this copy. The next start of the drill ends this message.`
      : `Examine ${copy}: its state, its log and the configuration of the drill. The next start of the drill ends this message.`,
    parameters: { drill: [drill.id], ...(watch.copy === undefined ? {} : { copy: [watch.copy] }), why: [miss.why] },
  };
}

/**
 * This function tells if each kind of a source is a kind of context (`CONTEXT_KINDS`). The reports of such a source reach the
 * digest at most, so its health also reaches the digest at most. A source with no kind is not a source of context.
 */
export function contextSource(source: SourceDescriptor): boolean {
  return source.kinds.length > 0 && source.kinds.every((kind) => hasKind(CONTEXT_KINDS, kind));
}

// The down state of the open line of a source that is up, while the source is up for less than its clear time. The state
// of the line comes from its facts. A source that is slow after it was up has a later start of its state, so its line
// stays open for longer: this error keeps a line, and it never ends a line early.
function heldState(line: SystemLine | undefined, health: SourceHealth, at: Instant, clear: Duration): HealthState | undefined {
  if (line === undefined || at - health.since >= clear) return undefined;
  const { state } = JSON.parse(line.facts) as { readonly state?: unknown };
  return DOWN_STATES.find((down) => down === state);
}

function healthCondition(health: SourceHealth, title: string, context: boolean): Condition {
  return {
    // The reason of the health has counts and times, so it is not a fact: a new count gives no update.
    facts: { source: health.source, state: health.state },
    kind: { code: `${HEALTH_KIND}.${health.state}`, label: `Source ${health.state}` },
    // With the default policy, the health of a source of context reaches the digest at most.
    severity: context ? "minor" : "moderate",
    urgency: context ? "future" : "expected",
    response: ["assess"],
    onset: health.since,
    areas: [],
    about: [{ system: SOURCE_SUBJECT, id: health.source, label: title }],
    headline: `${title}: ${HEADLINES[health.state] ?? health.state}.`,
    ...(health.reason === "" ? {} : { description: health.reason }),
    parameters: { state: [health.state] },
  };
}

function lateCondition(entry: Lateness, titles: ReadonlyMap<SourceId, string>): Condition {
  const to = titles.get(entry.to) ?? entry.to;
  const from = titles.get(entry.from) ?? entry.from;
  const delay = entry.limit?.delay ?? 0;
  const misses = entry.limit?.misses ?? 1;
  return {
    // Each new miss is a new fact, so it gives an update.
    facts: { expectation: entry.expectation, from: entry.from, to: entry.to, missed: entry.missed },
    kind: { code: `${HEALTH_KIND}.late`, label: "Source late" },
    severity: "moderate",
    urgency: "expected",
    response: ["assess"],
    ...(entry.since === undefined ? {} : { onset: entry.since }),
    areas: [],
    about: [{ system: SOURCE_SUBJECT, id: entry.to, label: to }],
    headline: `${to} is late: it did not carry the reports of ${from} in time.`,
    description: `Reports with no copy: ${entry.missed.length}. The limit of the delay is ${Math.round(delay / 1000)} seconds, and the limit of the misses is ${misses}, from the measured delays and misses.`,
    parameters: { expectation: [entry.expectation], missed: entry.missed, delay: [String(delay)], misses: [String(misses)] },
  };
}

function coverageCondition(entry: Coverage, threatened: boolean): Condition {
  const grade = gapGrade(entry, threatened);
  const lines = [
    entry.independent === 0
      ? `No source that is up covers ${entry.kind} at this place.`
      : `A fault of ${entry.faults.join(", ")} stops each source that covers ${entry.kind} at this place.`,
    ...(entry.proven ? [] : ["The search did not prove the count, so the true count can be smaller."]),
    ...(entry.commonResources.length === 0 ? [] : [`Each of these sources uses the ${entry.commonResources.join(", ")} of this place.`]),
  ];
  return {
    facts: { place: entry.place, kind: entry.kind, ...grade, independent: entry.independent, required: entry.required, proven: entry.proven, faults: entry.faults },
    kind: { code: `${COVERAGE_KIND}.${entry.kind}`, label: `Coverage of ${entry.kind}` },
    ...grade,
    response: entry.independent === 0 ? ["monitor"] : ["assess"],
    areas: [{ type: "place", place: entry.place }],
    about: [],
    headline: `Coverage of ${entry.kind}: ${entry.independent} of ${entry.required} independent sources.`,
    description: lines.join(" "),
    ...(entry.independent === 0 ? { instruction: "Use another source of warnings, for example a weather radio." } : {}),
    parameters: {
      independent: [String(entry.independent)],
      required: [String(entry.required)],
      proven: [String(entry.proven)],
      faults: entry.faults,
      sources: entry.sources,
    },
  };
}

function quotaCondition(quota: ChannelQuota, stage: QuotaStage): Condition {
  const { channel, limit, reserve, used } = quota;
  const unit = quota.unit ?? "units";
  const until = stage === "spent" ? (quota.blockedUntil ?? quota.resetAt) : quota.resetAt;
  const end = until === undefined ? "" : ` until ${new Date(until).toISOString()}`;
  const text: Readonly<Record<QuotaStage, { readonly headline: string; readonly description: string }>> = {
    low: {
      headline: `${channel}: ${Math.max(0, limit - used)} of ${limit} ${unit} of the window are left.`,
      description: `At ${reserve} ${unit} left, the channel sends only life-safety messages${end}. The other messages then wait for the reset.`,
    },
    reserve: {
      headline: `${channel} sends only life-safety messages${end}.`,
      description: `The channel keeps its last ${reserve} of ${limit} ${unit} for life-safety. The other messages wait for the reset.`,
    },
    spent: {
      headline: `${channel} sends no message${end}.`,
      description: "The provider refuses each message, also a life-safety message. Only the other channels carry the alerts.",
    },
  };
  const code = `${QUOTA_KIND}.${stage}`;
  return {
    // A new count is not a fact. Thus each stage gives one alert in a window, and no update.
    facts: { channel, stage, ...(until === undefined ? {} : { until }) },
    kind: { code, label: kindLabel(code) },
    severity: stage === "low" ? "moderate" : "severe",
    urgency: stage === "spent" ? "immediate" : "expected",
    response: ["assess"],
    areas: [],
    about: [{ system: CHANNEL_SUBJECT, id: channel, label: channel }],
    ...text[stage],
    parameters: { stage: [stage], used: [String(used)], limit: [String(limit)], reserve: [String(reserve)] },
  };
}

// The condition of one stage of a balance. A line `low` has its floor. The other stages have no floor.
function balanceCondition(balance: ProviderBalance, stage: BalanceStage, at: Instant, floor?: number): Condition {
  const { provider, title, floors, read } = balance;
  const amount = read === undefined ? "" : `${read.balance.toFixed(2)} ${read.currency}`;
  const last = read === undefined ? `the start of the watch at ${new Date(balance.since).toISOString()}` : new Date(read.at).toISOString();
  const text: Readonly<Record<BalanceStage, { readonly headline: string; readonly description: string }>> = {
    low: {
      headline: `${title}: the balance is ${amount}, below the floor of ${(floor ?? Math.max(...floors)).toFixed(2)}.`,
      description: "Add money to the account. At 0, the provider refuses each paid message, also a life-safety message.",
    },
    empty: {
      headline: `${title} refuses each paid message: the balance is ${amount}.`,
      description: "Add money to the account. Until then, only the other channels carry the alerts.",
    },
    unread: {
      headline: `The balance of ${title} has no read since ${last}.`,
      description: "The watch cannot see a low balance. Examine the key of the account and the network.",
    },
  };
  const code = `${BALANCE_KIND}.${stage}`;
  return {
    // A new balance is not a fact. Thus each stage, and each floor of `low`, gives one alert, and no update.
    facts: { provider, stage, ...(floor === undefined ? {} : { floor }) },
    kind: { code, label: kindLabel(code) },
    severity: stage === "empty" ? "severe" : "moderate",
    urgency: stage === "empty" ? "immediate" : "expected",
    response: ["assess"],
    areas: [],
    about: balance.channels.map((channel) => ({ system: CHANNEL_SUBJECT, id: channel, label: channel })),
    ...text[stage],
    parameters: {
      stage: [stage],
      floor: floor === undefined ? floors.map(String) : [String(floor)],
      ...(read === undefined ? {} : { balance: [String(read.balance)], currency: [read.currency] }),
      age: [String(at - (read?.at ?? balance.since))],
    },
  };
}

function copyCondition(watch: CopyWatch, stage: CopyStage, at: Instant): Condition {
  const { copy, read } = watch;
  const last = read === undefined ? `the start of the watch at ${new Date(watch.since).toISOString()}` : new Date(read.at).toISOString();
  const skew = read === undefined ? "" : `${(Math.abs(read.skew) / 1000).toFixed(1)} s`;
  const text: Readonly<Record<CopyStage, { readonly headline: string; readonly description: string; readonly instruction: string }>> = {
    skew: {
      headline: `The clock of the copy ${copy} differs from the clock of this copy by ${skew}.`,
      description: `The rank wait holds a difference of ${(watch.skewLimit / 1000).toFixed(1)} s or less. A larger difference can let two copies send the same alert.`,
      instruction: "Examine the time settings and the time server of each computer.",
    },
    config: {
      headline: `The copy ${copy} has a different configuration.`,
      description: "The copies can route one alert in two ways. Then a person can get an alert from each copy, or on a different channel.",
      instruction: "Give each copy the same file config.json. Then restart each copy.",
    },
    unread: {
      headline: `No read of the copy ${copy} passed since ${last}.`,
      description: "This copy cannot see the sends of the other copy. Thus the two copies can both send each alert.",
      instruction: "Examine the other computer and the network between the copies.",
    },
    unsteady: {
      headline: `The copy ${copy} is not steady since ${new Date(watch.unsteadySince ?? watch.since).toISOString()}.`,
      description: "The other copy starts again and again, and it stops before it is steady. It sends no alert. Thus this copy is the only copy that sends.",
      instruction: "Examine the memory and the start log of the other computer.",
    },
  };
  const code = `${COPY_KIND}.${stage}`;
  return {
    // A new difference or a new age is not a fact. Thus each stage gives one alert, and no update.
    facts: { copy, stage },
    kind: { code, label: kindLabel(code) },
    severity: "moderate",
    urgency: "expected",
    response: ["assess"],
    areas: [],
    about: [{ system: COPY_SUBJECT, id: copy, label: `Copy ${copy}` }],
    ...text[stage],
    parameters: {
      stage: [stage],
      ...(read === undefined ? {} : { skew: [String(read.skew)], sameConfig: [String(read.sameConfig)] }),
      age: [String(at - (read?.at ?? watch.since))],
    },
  };
}

function clockCondition(step: ClockStep): Condition {
  const code = `${CLOCK_KIND}.step`;
  return {
    // Each step is a new fact, thus a second step in the window gives an update.
    facts: { at: step.at, size: step.size },
    kind: { code, label: kindLabel(code) },
    severity: "minor",
    urgency: "past",
    response: ["assess"],
    onset: step.at,
    areas: [],
    about: [{ system: CLOCK_SUBJECT, id: "wall", label: "Wall clock" }],
    headline: `The wall clock stepped ${step.size < 0 ? "back" : "forward"} by ${stepSizeText(step.size)}.`,
    description: "The alert system moved its own times by the step, thus each timer keeps its time. The times of the sources and the channels did not move.",
    instruction: "Examine the time settings and the time server of the computer.",
    parameters: { size: [String(step.size)] },
  };
}

// A loss of events can repeat a send or lose an acknowledgment, thus it gets `notice`. A recovery with no loss gets `digest`.
function logCondition(recovery: LogRecovery): Condition {
  const code = `${LOG_KIND}.recovered`;
  const lossy = !recovery.whole || recovery.lost > 0;
  const positions = recovery.lost > 0 ? ` (${String(recovery.lost)} positions)` : "";
  const kept = lossy
    ? `It kept ${String(recovery.kept)} events, and it could not read each part of the file${positions}. A lost event can repeat a send or lose an acknowledgment.`
    : `It kept each of the ${String(recovery.kept)} events.`;
  return {
    facts: { at: recovery.at, quarantine: recovery.quarantine, kept: recovery.kept, lost: recovery.lost, whole: recovery.whole },
    kind: { code, label: kindLabel(code) },
    severity: lossy ? "moderate" : "minor",
    urgency: lossy ? "expected" : "past",
    response: ["assess"],
    onset: recovery.at,
    areas: [],
    about: [{ system: LOG_SUBJECT, id: "runtime", label: "Log of the runtime" }],
    headline: "The log file of the alert system was broken.",
    description: `The alert system moved the broken file into the quarantine folder ${recovery.quarantine}, and it started a new log. ${kept}`,
    instruction: "Examine the disk of the computer. Keep the quarantine folder until you know the cause.",
    parameters: { quarantine: [recovery.quarantine], kept: [String(recovery.kept)], lost: [String(recovery.lost)], whole: [String(recovery.whole)] },
  };
}

// A family with no entry stops a feature, not a send. Thus it gets `notice` at most.
function storeCondition(fill: StoreFill, titles: ReadonlyMap<SourceId, string>): Condition {
  const code = `${STORE_KIND}.empty`;
  const minutes = Math.round(fill.within / 60_000);
  return {
    // A new count or a new start is not a fact. Thus a restart gives no update and no new alert.
    facts: { store: fill.store, family: fill.family },
    kind: { code, label: kindLabel(code) },
    severity: "moderate",
    urgency: "expected",
    response: ["assess"],
    areas: [],
    about: [
      { system: STORE_SUBJECT, id: `${fill.store}/${fill.family}`, label: `Store ${fill.store}, family ${fill.family}` },
      ...fill.sources.map((source) => ({ system: SOURCE_SUBJECT, id: source, label: titles.get(source) ?? source })),
    ],
    headline: `The store ${fill.store} has no entry of the family ${fill.family} ${String(minutes)} minutes after the start.`,
    description: "The store did not fill in the time. Its sources can be down, or the store gets no turn to fetch. Each feature that reads the family works without it.",
    instruction: "Examine the health of the sources of the store and the log of its refreshes.",
    parameters: { entries: [String(fill.entries)], within: [String(fill.within)] },
  };
}

// The cancel of a line: an all clear of the same kind, areas and subjects.
function cancelOf(line: SystemLine): Condition {
  return {
    facts: { cancel: line.key },
    kind: line.kind,
    severity: "minor",
    urgency: "past",
    response: ["allclear"],
    areas: line.areas,
    about: line.about,
    ...(line.addresses === undefined ? {} : { addresses: line.addresses }),
    headline: `${line.kind.label}: the condition ended.`,
    parameters: {},
  };
}

function observationOf(name: string, op: Operation, facts: Condition["facts"], at: Instant): Observation {
  const contentType = "application/json";
  const body = canonicalJson({ name, op, facts }, { form: "json" });
  return { id: observationId({ source: SYSTEM_SOURCE, contentType, body }), source: SYSTEM_SOURCE, fetched: at, contentType, body, transport: { latency: 0 } };
}

interface Envelope {
  readonly key: string;
  readonly op: Operation;
  readonly references: readonly string[];
  readonly at: Instant;
  readonly observation: Observation["id"];
}

function reportOf(draft: Condition, envelope: Envelope): Report {
  const { key, op, references, at, observation } = envelope;
  return {
    id: reportId({ source: SYSTEM_SOURCE, key, sent: at }),
    source: SYSTEM_SOURCE,
    origin: SYSTEM_SOURCE,
    key,
    references,
    correlation: [],
    status: "system",
    op,
    kind: draft.kind,
    categories: ["system"],
    severity: draft.severity,
    urgency: draft.urgency,
    certainty: "observed",
    response: draft.response,
    sent: at,
    received: at,
    ...(draft.onset === undefined ? {} : { onset: draft.onset }),
    areas: draft.areas,
    about: draft.about,
    ...(draft.addresses === undefined ? {} : { addresses: draft.addresses }),
    sender: "alerts",
    headline: draft.headline,
    ...(draft.description === undefined ? {} : { description: draft.description }),
    ...(draft.instruction === undefined ? {} : { instruction: draft.instruction }),
    observation,
    parameters: draft.parameters,
  };
}
