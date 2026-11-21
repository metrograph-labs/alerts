/**
 * The lateness of a source that carries the messages of another source. FEMA IPAWS carries each NWS
 * warning for Wireless Emergency Alerts. Its feed can be quiet for hours in normal work, so the quiet
 * timer of the health cannot show that it stopped. An expectation tells which reports of one source
 * the other source carries. When the copy of such a report does not come in time, the second source
 * is late.
 *
 * The functions are pure folds over the merge state and the time. They read no clock. The limit of
 * the delay comes from the measured delays as the upper bound of a quantile (`delayLimit`). The count
 * of misses that makes a source late comes from the measured rate of the misses (`missLimit`). No
 * person sets a time or a count.
 *
 * One record of decisions (`decide`) gives each check its deadline at its start. A copy that missed
 * its deadline enters the sample at its limit. So a lag does not teach the limit.
 */
import { clopperPearson, quantileInterval } from "@mark1russell7/rigor-statistics";
import { compareCodeUnits } from "@mark1russell7/text/order";
import { hasKind } from "./assess.ts";
import type { Duration, Incident, Instant, MergeState, Operation, Report, ReportId, SourceId, Status } from "./contracts.ts";

/** The reports of a source that start an expectation. Each field that is present must hold. */
export interface ReportFilter {
  readonly statuses?: readonly Status[];
  readonly ops?: readonly Operation[];
  /** The prefixes of the taxonomy codes. */
  readonly kinds?: readonly string[];
  /** The names of the parameters that the report must have, each with one value or more. */
  readonly parameters?: readonly string[];
  /**
   * The systems of the correlation keys that the report must have, each with one key or more. An expectation that
   * joins its copies by a key thus does not check a report of an older map with no such key.
   */
  readonly correlation?: readonly string[];
}

/**
 * A source that carries a copy of some reports of another source. The two copies must be in one
 * incident, so the second source must give a correlation key of the first, for example the VTEC key.
 */
export interface Expectation {
  readonly id: string;
  /** The source of the first copy. */
  readonly from: SourceId;
  /** The source that carries the second copy. */
  readonly to: SourceId;
  readonly when: ReportFilter;
  /**
   * The start of the record of the expectation. `lateness` reads only the checks that start at this
   * time or later. An operator sets it after a change of a source, so the old record does not teach the limit.
   */
  readonly since?: Instant;
}

/**
 * One check of an expectation for one message of the source `from`. A message is the reports of `from`
 * in one incident with one sent time that pass the filter.
 */
export interface Carriage {
  readonly expectation: string;
  /** The first report of the message. Its id is the key of the check. */
  readonly report: ReportId;
  /** The time when that report came. */
  readonly started: Instant;
  /**
   * The time when the copy came: the first report of the source `to` in the incident with the same sent
   * time. It is absent when no copy came.
   */
  readonly arrived?: Instant;
}

/** The quantile and the level of the limits of an expectation. The policy of the runtime gives them. */
export interface DelayLimitOptions {
  /** The quantile of the delays, for example `0.99`. In normal work, a smaller part than `1 - quantile` of the copies comes after the limit. */
  readonly quantile: number;
  /**
   * The level of confidence of the upper bounds, for example `0.95`. In normal work, a run of misses
   * that makes the source late comes with a chance of `1 - level` or less.
   */
  readonly level: number;
}

/** The limits of one expectation at one time. */
export interface LatenessLimit {
  /** The limit of the delay of a copy, in milliseconds. A check passes its limit at `started + delay`. */
  readonly delay: Duration;
  /** The count of misses after the last check that came that makes the source late. It is 1 or more. */
  readonly misses: number;
}

/**
 * The misses of the past of one expectation. A trial is a check that passed its limit, after a check
 * that met its limit. The first check is also a trial. A miss is a trial with no copy by its limit.
 */
export interface MissRecord {
  readonly trials: number;
  readonly misses: number;
}

/**
 * The state of an expectation at one time.
 *
 * - `no-limit`: the expectation has no limits yet. The check only measures.
 * - `no-data`: no check came, and the misses are fewer than the limit.
 * - `met`: a check came, and the misses after the last check that came are fewer than the limit.
 * - `late`: the count of misses after the last check that came is at the limit or more.
 */
export type LatenessState = "no-limit" | "no-data" | "met" | "late";

/** The lateness of the source `to` against the source `from` for one expectation. */
export interface Lateness {
  readonly expectation: string;
  readonly from: SourceId;
  readonly to: SourceId;
  readonly state: LatenessState;
  readonly limit?: LatenessLimit;
  /** The checks that passed their limit with no copy, after the last check that came, from the earliest. */
  readonly missed: readonly ReportId[];
  /** The time when the miss that made the source late passed its limit. */
  readonly since?: Instant;
  /** The next time when a check passes its limit. The runtime starts `lateness` again at that time. */
  readonly wakeAt?: Instant;
}

/** This function tells if a report passes a filter. */
export function reportPasses(filter: ReportFilter, report: Report): boolean {
  return (
    (filter.statuses === undefined || filter.statuses.includes(report.status)) &&
    (filter.ops === undefined || filter.ops.includes(report.op)) &&
    (filter.kinds === undefined || hasKind(filter.kinds, report.kind.code)) &&
    (filter.parameters ?? []).every((name) => (report.parameters[name]?.length ?? 0) > 0) &&
    (filter.correlation ?? []).every((system) => report.correlation.some((key) => key.system === system))
  );
}

/**
 * This function gives one check for each expectation and each message of `from`. The copy of a message
 * is the first report of `to` in the incident with the same sent time. Thus each message of an event,
 * for example an extension, has its own check, and a copy of a different message is not its copy.
 *
 * Two reports of `from` with one sent time in one incident are one message, and they give one check.
 * The result is a function of the set of reports, so the order of the reports does not change it. A
 * copy that came first gives a check with `arrived` before `started`.
 */
export function carriages(state: MergeState, found: readonly Incident[], expectations: readonly Expectation[]): Carriage[] {
  const byId = new Map(state.reports.map((report) => [report.id, report]));
  const checks: Carriage[] = [];
  for (const incident of found) {
    const reports = incident.reports.flatMap((id) => byId.get(id) ?? []);
    for (const expectation of expectations) {
      const copies = bySent(reports.filter((report) => report.source === expectation.to));
      for (const [sent, message] of bySent(reports.filter((report) => report.source === expectation.from && reportPasses(expectation.when, report)))) {
        const first = firstOf(message);
        if (first === undefined) continue;
        const copy = firstOf(copies.get(sent) ?? []);
        checks.push({ expectation: expectation.id, report: first.id, started: first.received, ...(copy === undefined ? {} : { arrived: copy.received }) });
      }
    }
  }
  return checks.sort((a, b) => compareCodeUnits(a.expectation, b.expectation) || a.started - b.started || compareCodeUnits(a.report, b.report));
}

/**
 * This function gives the limit of the delay: the distribution-free upper bound of the quantile of
 * the delays in a sample, from `quantileInterval` of `@mark1russell7/rigor-statistics`. A sample that is
 * too small has no upper bound, and the function gives `undefined`. Then the check only measures.
 *
 * The sample comes from `decide`. A copy that missed its deadline enters at the limit of its check, so
 * a lag of the copies does not raise the limit. The limit is not less than 0.
 */
export function delayLimit(delays: readonly Duration[], options: DelayLimitOptions): Duration | undefined {
  if (delays.length === 0) return undefined;
  const { high } = quantileInterval(delays, options.quantile, options.level);
  return Number.isFinite(high) ? Math.max(0, high) : undefined;
}

/**
 * The outcome of one check in the record of an expectation.
 *
 * - `met`: the copy came by the deadline of the check.
 * - `missed`: the deadline passed with no copy, or the copy came after the deadline.
 * - `open`: the deadline is after the time, and no copy came yet.
 * - `measured`: no limit was in force at the start of the check, and its copy came. The check has no deadline.
 * - `waiting`: no limit was in force at the start of the check, and no copy came yet.
 */
export type CheckOutcome = "met" | "missed" | "open" | "measured" | "waiting";

/** One check in the record of an expectation. */
export interface Decision {
  readonly check: Carriage;
  /** The limit of the delay in force at the start of the check. The deadline is `started + limit`. It is absent when no limit was in force. */
  readonly limit?: Duration;
  readonly outcome: CheckOutcome;
  /** The time of the decision: the copy, or the deadline. It is absent for an open or a waiting check. */
  readonly decided?: Instant;
  /** The value that the check gives to the sample of the delays. It is absent for an open or a waiting check. */
  readonly sample?: Duration;
}

/** The rule of the two limits: the limit of the delay from a sample, and the count of misses from a record of misses. */
export interface LimitRule {
  readonly delay: (sample: readonly Duration[]) => Duration | undefined;
  readonly misses: (record: MissRecord) => number | undefined;
}

/** This function gives the measured rule of the limits: `delayLimit` and `missLimit` with the quantile and the level of the policy. */
export function limitRule(options: DelayLimitOptions): LimitRule {
  return { delay: (sample) => delayLimit(sample, options), misses: (record) => missLimit(record, options.level) };
}

/** A decision that has its time, before its value goes into the sample. */
interface Queued {
  readonly index: number;
  readonly time: Instant;
  readonly decision: Omit<Decision, "sample">;
  readonly value: Duration;
}

/**
 * This function gives the record of one expectation at the time `at`. The record has one decision for
 * each check that started by `at`, in the order of the start. It is a fold over the time. After each decision,
 * `limitOf` gives the limit in force from the sample.
 *
 * - The deadline of a check is fixed at its start: `started + limit`, with the limit in force at that time.
 *   A later change of the limit does not move it, so no step of the fold goes back in time.
 * - A met check gives its delay to the sample. A missed check gives its limit, because its delay is
 *   known only to be more than the limit (right-censored). Thus a lag or a backlog does not raise the limit.
 * - A check with no limit at its start gives its delay. When a limit is in force at the time of its copy,
 *   the value is clipped at that limit.
 * - A decision at the time of a start goes into the sample after that start.
 *
 * With the measured rule, each limit after the first limit is at most the first limit. Thus a lasting
 * rise of the normal delay shows as a lasting late state. A copy that came after `at` does not count.
 * The result is a function of the set of checks. Each decision calculates the limit again with `limitOf`.
 * `decideStep` continues an earlier fold at a lower cost.
 */
export function decide(checks: readonly Carriage[], expectation: string, at: Instant, limitOf: (sample: readonly Duration[]) => Duration | undefined): Decision[] {
  return [...decideStep(undefined, checks, expectation, at, limitOf).record];
}

/**
 * The state of the fold of one expectation at one time: the record, the sample and the limit after
 * each decision by that time. `decideStep` continues it at a later time.
 */
export interface DecideState {
  readonly expectation: string;
  readonly at: Instant;
  readonly limitOf: (sample: readonly Duration[]) => Duration | undefined;
  /** The record at `at`: one decision for each check that started by `at`, in the order of the start. */
  readonly record: readonly Decision[];
  /** The values of the sample, in the order of their decisions. */
  readonly sample: readonly Duration[];
  /** The limit in force after the last decision. */
  readonly limit: Duration | undefined;
}

/** The record of one expectation at one time, and the state of its fold. */
export interface DecideStep {
  readonly record: readonly Decision[];
  readonly state: DecideState;
}

/**
 * This function gives the record of `decide`, and continues the state `before` of an earlier fold when
 * the state agrees with the checks. The record is the same with or without the state. Only the cost changes.
 *
 * The state agrees with the checks on three conditions. Its expectation and its `limitOf` are the same.
 * Its time is not after `at`. The checks that started by its time are the same: each has the same report,
 * start and copy by that time. A check that starts after the time of the state is new.
 *
 * A decision by the time of the state does not change, because each of its inputs is the same. Thus
 * the fold decides again only the open and the waiting checks of the state, and then it folds the new
 * checks. Each new decision comes after the time of the state, thus after each decision of the state.
 * The cost is one call of `limitOf` for each new decision. When the state does not agree, the fold starts again.
 */
export function decideStep(
  before: DecideState | undefined,
  checks: readonly Carriage[],
  expectation: string,
  at: Instant,
  limitOf: (sample: readonly Duration[]) => Duration | undefined,
): DecideStep {
  const own = checks
    .filter((check) => check.expectation === expectation && check.started <= at)
    .sort((a, b) => a.started - b.started || compareCodeUnits(a.report, b.report));
  const kept = before !== undefined && agrees(before, own, expectation, at, limitOf) ? before : undefined;
  // Each decision of the state takes the check of this fold, thus the record is the record of the fold from the start.
  const record: Decision[] = kept === undefined ? [] : kept.record.map((entry, index) => ({ ...entry, check: own[index]! }));
  const sample: Duration[] = kept === undefined ? [] : [...kept.sample];
  let limit = kept === undefined ? limitOf(sample) : kept.limit;
  const queue: Queued[] = [];
  const apply = ({ index, decision, value }: Queued): void => {
    const entry = decision.outcome === "measured" && limit !== undefined ? Math.min(value, limit) : value;
    record[index] = { ...decision, sample: entry };
    sample.push(entry);
    limit = limitOf(sample);
  };
  // The decision of one check with the limit in force at its start.
  const judge = (check: Carriage, index: number, start: Duration | undefined): void => {
    const came = check.arrived !== undefined && check.arrived <= at ? check.arrived : undefined;
    const base = { check, ...(start === undefined ? {} : { limit: start }) };
    if (start === undefined) {
      if (came === undefined) record[index] = { ...base, outcome: "waiting" };
      else {
        const time = Math.max(came, check.started);
        enqueue(queue, { index, time, decision: { ...base, outcome: "measured", decided: time }, value: came - check.started });
      }
      return;
    }
    const deadline = check.started + start;
    if (came !== undefined && came <= deadline) {
      const time = Math.max(came, check.started);
      enqueue(queue, { index, time, decision: { ...base, outcome: "met", decided: time }, value: came - check.started });
    } else if (deadline <= at) {
      enqueue(queue, { index, time: deadline, decision: { ...base, outcome: "missed", decided: deadline }, value: start });
    } else {
      record[index] = { ...base, outcome: "open" };
    }
  };
  // An open or a waiting check of the state keeps its limit. Its copy or its deadline can come after the time of the state.
  kept?.record.forEach((entry, index) => {
    if (entry.outcome === "open" || entry.outcome === "waiting") judge(own[index]!, index, entry.limit);
  });
  const first = record.length;
  for (let index = first; index < own.length; index += 1) {
    const check = own[index]!;
    while (queue[0] !== undefined && queue[0].time < check.started) apply(queue.shift()!);
    judge(check, index, limit);
  }
  while (queue[0] !== undefined) apply(queue.shift()!);
  return { record, state: { expectation, at, limitOf, record, sample, limit } };
}

/** This function tells if the state of a fold agrees with `own`, the sorted checks of the expectation at the time `at`. */
function agrees(state: DecideState, own: readonly Carriage[], expectation: string, at: Instant, limitOf: (sample: readonly Duration[]) => Duration | undefined): boolean {
  if (state.expectation !== expectation || state.limitOf !== limitOf || state.at > at || state.record.length > own.length) return false;
  const next = own[state.record.length];
  if (next !== undefined && next.started <= state.at) return false;
  // The copy of a check by the time of the state. A copy after that time is new.
  const came = (check: Carriage): Instant | undefined => (check.arrived !== undefined && check.arrived <= state.at ? check.arrived : undefined);
  return state.record.every(({ check }, index) => {
    const now = own[index]!;
    return now.report === check.report && now.started === check.started && came(now) === came(check);
  });
}

/** This function puts a decision in the queue, sorted by its time and then by the order of the start. */
function enqueue(queue: Queued[], item: Queued): void {
  let at = queue.length;
  while (at > 0 && (queue[at - 1]!.time > item.time || (queue[at - 1]!.time === item.time && queue[at - 1]!.index > item.index))) at -= 1;
  queue.splice(at, 0, item);
}

/**
 * This function gives the misses of the past from the record of an expectation. A trial is a decided
 * check after a check whose copy came. The first decided check is also a trial. A miss is a missed
 * check. Thus a long stop of the source counts as one miss, and does not raise the normal rate of the
 * misses. A copy after its deadline is a miss.
 */
export function missRecord(record: readonly Decision[]): MissRecord {
  let trials = 0;
  let misses = 0;
  let afterMet = true;
  for (const { outcome } of record) {
    if (outcome === "open" || outcome === "waiting") continue;
    const met = outcome !== "missed";
    if (afterMet) {
      trials += 1;
      if (!met) misses += 1;
    }
    afterMet = met;
  }
  return { trials, misses };
}

/**
 * This function gives the count of misses in a row that makes the source late. The count is the
 * smallest k with `high ** k <= 1 - level`. `high` is the upper bound of the rate of the misses, from
 * `clopperPearson` of `@mark1russell7/rigor-statistics`.
 *
 * Thus in normal work, k misses in a row come with a chance of `1 - level` or less. A source that
 * stops misses each check, so it is late after k checks. The function gives `undefined` when the
 * bound is 1, for example with no trials. Then `lateness` only measures.
 */
export function missLimit(record: MissRecord, level: number): number | undefined {
  const { high } = clopperPearson(record.misses, record.trials, level);
  if (!(high < 1)) return undefined;
  const alpha = 1 - level;
  if (high <= alpha) return 1;
  // The logarithms give the count, and the loop corrects an error of rounding at a whole number.
  let k = Math.max(1, Math.ceil(Math.log(alpha) / Math.log(high)));
  while (k > 1 && high ** (k - 1) <= alpha) k -= 1;
  while (high ** k > alpha) k += 1;
  return k;
}

/**
 * This function gives the state of each expectation at the time `at`. The record of each expectation
 * (`decide`) and the rule give its limits: the delay from the whole sample, and the count of misses
 * from `missRecord`. Each check is judged by its own deadline.
 *
 * A copy after its deadline is a miss, so a lag of the copies keeps the source late. The first met
 * check after the misses ends them, because it shows that the source carries the reports in time again.
 * A check that starts before the `since` of its expectation is not in the record.
 */
export function lateness(checks: readonly Carriage[], expectations: readonly Expectation[], at: Instant, rule: LimitRule): Lateness[] {
  return latenessStep(checks, expectations, at, rule).lateness;
}

/** The states of the folds of `lateness` at one time, by the id of the expectation. */
export type LatenessFolds = ReadonlyMap<string, DecideState>;

/** The state of each expectation at one time, and the folds that the next step continues. */
export interface LatenessStep {
  readonly lateness: Lateness[];
  readonly folds: LatenessFolds;
}

/**
 * This function gives the states of `lateness`, and the fold of each expectation continues its fold in
 * `before` (`decideStep`). The states are the same with or without `before`. Only the cost changes.
 * Thus a runtime keeps the folds of each pass for the next pass, and a pass folds only the new checks.
 * The `delay` function of the rule must be the same in each step, or each fold starts again.
 */
export function latenessStep(checks: readonly Carriage[], expectations: readonly Expectation[], at: Instant, rule: LimitRule, before?: LatenessFolds): LatenessStep {
  const folds = new Map<string, DecideState>();
  const states = expectations.map((expectation): Lateness => {
    const base = { expectation: expectation.id, from: expectation.from, to: expectation.to };
    const start = expectation.since;
    const { record, state: fold } = decideStep(before?.get(expectation.id), start === undefined ? checks : checks.filter((check) => check.started >= start), expectation.id, at, rule.delay);
    folds.set(expectation.id, fold);
    const deadlines = record.flatMap((entry) => (entry.outcome === "open" && entry.limit !== undefined ? [entry.check.started + entry.limit] : []));
    const wake = deadlines.length === 0 ? {} : { wakeAt: deadlines.reduce((a, b) => Math.min(a, b)) };
    const delay = rule.delay(record.flatMap((entry) => (entry.sample === undefined ? [] : [entry.sample])));
    const misses = delay === undefined ? undefined : rule.misses(missRecord(record));
    if (delay === undefined || misses === undefined) return { ...base, state: "no-limit", missed: [], ...wake };
    const lastMet = record.reduce((last, entry) => (entry.outcome === "met" || entry.outcome === "measured" ? Math.max(last, entry.check.started) : last), Number.NEGATIVE_INFINITY);
    const missed = record.filter((entry) => entry.outcome === "missed" && entry.check.started > lastMet);
    // A count below 1 is not valid, and 1 is the safe side: the first miss makes the source late.
    const needed = Math.max(1, Math.ceil(misses));
    const late = missed.length >= needed;
    const state: LatenessState = late ? "late" : lastMet > Number.NEGATIVE_INFINITY ? "met" : "no-data";
    const since = late ? missed.map((entry) => entry.decided!).sort((a, b) => a - b)[needed - 1] : undefined;
    return {
      ...base,
      state,
      limit: { delay, misses },
      missed: missed.map((entry) => entry.check.report),
      ...(since === undefined ? {} : { since }),
      ...wake,
    };
  });
  return { lateness: states, folds };
}

/** This function gives the sources that are late, sorted. The coverage does not count them. */
export function lateSources(states: readonly Lateness[]): SourceId[] {
  return [...new Set(states.filter((entry) => entry.state === "late").map((entry) => entry.to))].sort(compareCodeUnits);
}

// The reports by their sent time.
function bySent(reports: readonly Report[]): Map<Instant, Report[]> {
  const groups = new Map<Instant, Report[]>();
  for (const report of reports) groups.set(report.sent, [...(groups.get(report.sent) ?? []), report]);
  return groups;
}

// The first report: the earlier time first, then the smaller id.
function firstOf(reports: readonly Report[]): Report | undefined {
  let first: Report | undefined;
  for (const report of reports) {
    if (first === undefined || report.received < first.received || (report.received === first.received && compareCodeUnits(report.id, first.id) < 0)) first = report;
  }
  return first;
}
