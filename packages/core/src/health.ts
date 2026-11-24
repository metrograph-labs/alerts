/**
 * The health of one source. It is a pure fold over the fetch records of the source and the time.
 * It reads no clock and no network: the runtime gives each record when its fetch ends, and gives the
 * time again at `wakeAt`.
 *
 * `HEALTH_MACHINE` is the machine document of the health, in the format of `@mark1russell7/algebra`.
 * Each step gives its transitions, and a replay against the document finds a transition that the
 * document does not permit. Each transition is also a system report.
 */
import type { Machine, Transition } from "@mark1russell7/algebra";
import type { CanaryResult, Duration, FetchFailure, FetchRecord, HealthState, Instant, SourceDescriptor, SourceHealth, SourceId } from "./contracts.ts";

/**
 * The fields of a source descriptor that the health reads (AL-156). The health functions take only these fields. Thus a
 * change of another field of a descriptor, for example its kinds or its title, does not change a health.
 */
export type HealthSource = Pick<SourceDescriptor, "id" | "interval" | "slowAfter" | "maxQuiet">;

/** This function gives the fields of a descriptor that the health reads, with no other field (AL-156). */
export function healthSource(descriptor: HealthSource): HealthSource {
  return descriptor.maxQuiet === undefined
    ? { id: descriptor.id, interval: descriptor.interval, slowAfter: descriptor.slowAfter }
    : { id: descriptor.id, interval: descriptor.interval, slowAfter: descriptor.slowAfter, maxQuiet: descriptor.maxQuiet };
}

/** The events of the health machine. */
export const HEALTH_EVENTS: {
  readonly passed: "app.fetch-passed";
  readonly slow: "app.fetch-slow";
  readonly changed: "app.fetch-changed";
  readonly failed: "app.fetch-failed";
  readonly canaryPassed: "app.canary-passed";
  readonly canaryFailed: "app.canary-failed";
  readonly quiet: "timer.quiet";
  readonly stale: "timer.stale";
} = {
  passed: "app.fetch-passed",
  slow: "app.fetch-slow",
  changed: "app.fetch-changed",
  failed: "app.fetch-failed",
  canaryPassed: "app.canary-passed",
  canaryFailed: "app.canary-failed",
  quiet: "timer.quiet",
  stale: "timer.stale",
};

type HealthEvent = (typeof HEALTH_EVENTS)[keyof typeof HEALTH_EVENTS];

/** The count of fetches in a row that fail before the state is `failing`, when the options do not give it. */
export const DEFAULT_FAIL_AFTER = 2;

/** The count of fetch intervals with no passed fetch before the state is `failing`, when the options do not give a time. */
export const DEFAULT_STALE_INTERVALS = 3;

/** The machine document of the health. The health steps make only the transitions of this document. */
export const HEALTH_MACHINE: Machine = {
  format: "mark1russell7.machine/1",
  id: "alerts.health",
  title: "The health of one source, from the records of its fetches",
  layer: "self",
  version: "1",
  sources: [{ ref: "docs/CONTRACTS.md of the alerts repository: health and coverage", rung: "derived" }],
  states: {
    unknown: { initial: true, note: "no fetch passed yet" },
    healthy: { note: "the last fetch passed in less than slowAfter" },
    slow: { note: "the last fetch passed in slowAfter or more" },
    failing: { note: "fail_after fetches in a row failed, no fetch passed for stale_after, or the canary failed" },
    silent: { note: "no fresh observation for max_quiet, for a source where quiet is not normal" },
    changed: { note: "the map gave fatal or lossy problems for the last passed fetch" },
  },
  events: {
    "app.fetch-passed": { kind: "app", note: "a fetch passed in less than slowAfter, with no fatal or lossy problem of the map" },
    "app.fetch-slow": { kind: "app", note: "a fetch passed in slowAfter or more, with no fatal or lossy problem of the map" },
    "app.fetch-changed": { kind: "app", note: "a fetch passed, and the map gave fatal or lossy problems" },
    "app.fetch-failed": { kind: "app", note: "a fetch failed" },
    "app.canary-passed": { kind: "app", note: "the canary check of a fetch passed" },
    "app.canary-failed": { kind: "app", note: "the canary check of a fetch failed" },
    "timer.quiet": { kind: "timer", note: "max_quiet passed with no fresh observation" },
    "timer.stale": { kind: "timer", note: "stale_after passed with no passed fetch" },
  },
  knobs: {
    interval: { key: "SourceDescriptor.interval", scope: "source", unit: "ms", default: null },
    slow_after: { key: "SourceDescriptor.slowAfter", scope: "source", unit: "ms", default: null },
    max_quiet: { key: "SourceDescriptor.maxQuiet", scope: "source", unit: "ms", default: null, note: "absent: a quiet source is normal, and the quiet timer is off" },
    fail_after: { key: "HealthOptions.failAfter", scope: "cell", unit: "count", default: DEFAULT_FAIL_AFTER },
    stale_after: { key: "HealthOptions.staleAfter", scope: "cell", unit: "ms", default: null, note: "absent: 3 times the interval" },
  },
  timers: {
    stale: {
      duration: { knob: "stale_after", unit: "ms" },
      arms: ["enter:unknown", "app.fetch-passed", "app.fetch-slow", "app.fetch-changed"],
      fires: "timer.stale",
      note: "the end of each passed fetch starts it again",
    },
    quiet: {
      duration: { knob: "max_quiet", unit: "ms" },
      arms: ["app.fetch-passed", "app.fetch-slow", "app.fetch-changed"],
      fires: "timer.quiet",
      note: "the first passed fetch and each passed fetch with a fresh observation start it again",
    },
  },
  transitions: [
    { id: "he.stale", from: ["unknown", "healthy", "slow", "silent", "changed"], to: "failing", on: "timer.stale", timer: "stale" },
    { id: "he.quiet", from: ["healthy", "slow"], to: "silent", on: "timer.quiet", timer: "quiet" },
    { id: "he.failed", from: ["unknown", "healthy", "slow", "silent", "changed"], to: "failing", on: "app.fetch-failed", guard: "fail_after fetches in a row failed" },
    { id: "he.passed", from: ["unknown", "failing", "slow", "silent", "changed"], to: "healthy", on: "app.fetch-passed", guard: "the last canary did not fail" },
    { id: "he.slow", from: ["unknown", "failing", "healthy", "silent", "changed"], to: "slow", on: "app.fetch-slow", guard: "the last canary did not fail" },
    { id: "he.changed", from: ["unknown", "failing", "healthy", "slow", "silent"], to: "changed", on: "app.fetch-changed", guard: "the last canary did not fail" },
    {
      id: "he.passed-quiet",
      from: ["failing", "changed"],
      to: "silent",
      on: ["app.fetch-passed", "app.fetch-slow"],
      guard: "no fresh observation for max_quiet",
      note: "the quiet timer fired in the state failing or changed, which hold it",
    },
    { id: "he.canary-failed", from: ["healthy", "slow", "silent", "changed"], to: "failing", on: "app.canary-failed" },
    { id: "he.canary-healthy", from: "failing", to: "healthy", on: "app.canary-passed" },
    { id: "he.canary-slow", from: "failing", to: "slow", on: "app.canary-passed" },
    { id: "he.canary-silent", from: "failing", to: "silent", on: "app.canary-passed" },
    { id: "he.canary-changed", from: "failing", to: "changed", on: "app.canary-passed" },
  ],
};

/** The options of the health. */
export interface HealthOptions {
  /** The count of fetches in a row that fail before the state is `failing`. */
  readonly failAfter?: number;
  /** The longest time with no passed fetch before the state is `failing`. */
  readonly staleAfter?: Duration;
}

/** The last passed fetch of a source. */
export interface PassedFetch {
  readonly at: Instant;
  readonly took: Duration;
  readonly fatal: number;
  /** The count of lossy problems. An absent count is 0. */
  readonly lossy?: number;
}

/** The state of the fold of the health. It is data, so the runtime can keep it in its log. */
export interface HealthTrack {
  readonly source: SourceId;
  readonly state: HealthState;
  /** The time of the last change of state. */
  readonly since: Instant;
  /** The time of the last step. Time does not go back. */
  readonly time: Instant;
  /** The count of the last fetches in a row that failed. */
  readonly failures: number;
  /** The end of the last passed fetch, or the start of the track. The stale timer starts at it. */
  readonly staleFrom: Instant;
  /** The end of the last passed fetch with a fresh observation, or of the first passed fetch. */
  readonly quietFrom?: Instant;
  readonly passed?: PassedFetch;
  readonly lastFailure?: { readonly at: Instant; readonly failure: FetchFailure };
  /** The result of the last canary check. */
  readonly canary?: CanaryResult;
}

/** The result of one step of the health. */
export interface HealthStep {
  readonly track: HealthTrack;
  readonly health: SourceHealth;
  /** The changes of state of the step, in order. The instance is the source id. */
  readonly transitions: readonly Transition[];
  /** The time of the next timer. The runtime gives the time again then. Absent: only a record can change the state. */
  readonly wakeAt?: Instant;
}

/** This function starts the health of a source at a time, in the state `unknown`. */
export function startHealth(source: SourceId, at: Instant): HealthTrack {
  return { source, state: "unknown", since: at, time: at, failures: 0, staleFrom: at };
}

/**
 * This function adds the record of one fetch. The record is an event at the end of the fetch. The
 * timers that end before that time fire first.
 */
export function observeFetch(track: HealthTrack, record: FetchRecord, descriptor: HealthSource, options: HealthOptions = {}): HealthStep {
  const end = Math.max(track.time, record.at + record.took);
  const transitions: Transition[] = [];
  let next = fire(track, end, descriptor, options, transitions);
  if (record.failure !== undefined) {
    next = { ...next, failures: next.failures + 1, lastFailure: { at: record.at, failure: record.failure } };
    next = change(next, HEALTH_EVENTS.failed, end, descriptor, options, transitions);
  } else {
    const lossy = record.lossy ?? 0;
    const passed: PassedFetch = { at: record.at, took: record.took, fatal: record.fatal, ...(lossy > 0 ? { lossy } : {}) };
    const quietFrom = record.fresh > 0 || next.quietFrom === undefined ? end : next.quietFrom;
    next = { ...next, failures: 0, staleFrom: end, quietFrom, passed };
    const event = record.fatal + lossy > 0 ? HEALTH_EVENTS.changed : record.took >= descriptor.slowAfter ? HEALTH_EVENTS.slow : HEALTH_EVENTS.passed;
    next = change(next, event, end, descriptor, options, transitions);
    if (record.canary !== undefined) {
      next = { ...next, canary: record.canary };
      const canaryEvent = record.canary.pass ? HEALTH_EVENTS.canaryPassed : HEALTH_EVENTS.canaryFailed;
      next = change(next, canaryEvent, end, descriptor, options, transitions);
    }
  }
  return stepOf(next, descriptor, options, transitions);
}

/** This function moves the health to a time. The timers that end by that time fire. */
export function advanceHealth(track: HealthTrack, now: Instant, descriptor: HealthSource, options: HealthOptions = {}): HealthStep {
  const transitions: Transition[] = [];
  return stepOf(fire(track, now, descriptor, options, transitions), descriptor, options, transitions);
}

/**
 * This function gives the health of a source at the time `now`. It starts a track at `start`, and
 * adds the records in the order of their ends.
 */
export function health(
  descriptor: HealthSource,
  start: Instant,
  records: readonly FetchRecord[],
  now: Instant,
  options: HealthOptions = {},
): HealthStep {
  const transitions: Transition[] = [];
  let track = startHealth(descriptor.id, start);
  for (const record of records) {
    const step = observeFetch(track, record, descriptor, options);
    transitions.push(...step.transitions);
    track = step.track;
  }
  const last = advanceHealth(track, now, descriptor, options);
  return { ...last, transitions: [...transitions, ...last.transitions] };
}

// The timers that end after the last step and by `to` fire in the order of their ends.
function fire(track: HealthTrack, to: Instant, descriptor: HealthSource, options: HealthOptions, transitions: Transition[]): HealthTrack {
  let next = track;
  for (const timer of deadlines(track, descriptor, options).filter((t) => t.at > track.time && t.at <= to).sort((a, b) => a.at - b.at)) {
    next = change(next, timer.on, timer.at, descriptor, options, transitions);
  }
  return next.time >= to ? next : { ...next, time: to };
}

function deadlines(track: HealthTrack, descriptor: HealthSource, options: HealthOptions): { readonly at: Instant; readonly on: HealthEvent }[] {
  const found: { at: Instant; on: HealthEvent }[] = [{ at: track.staleFrom + staleAfter(descriptor, options), on: HEALTH_EVENTS.stale }];
  const quiet = maxQuiet(descriptor);
  if (quiet !== undefined && track.quietFrom !== undefined) {
    found.push({ at: track.quietFrom + quiet, on: HEALTH_EVENTS.quiet });
  }
  return found;
}

// One event at one time: the state becomes the state of the conditions.
function change(track: HealthTrack, on: HealthEvent, at: Instant, descriptor: HealthSource, options: HealthOptions, transitions: Transition[]): HealthTrack {
  const time = Math.max(track.time, at);
  const to = classify({ ...track, time }, descriptor, options).state;
  if (to === track.state) return { ...track, time };
  transitions.push({ machine: HEALTH_MACHINE.id, instance: track.source, from: track.state, on, to, at: time });
  return { ...track, state: to, since: time, time };
}

// The reason of the state changed. A fetch with no lossy problem keeps the text of the fatal problems only.
function changedReason(passed: PassedFetch): string {
  const lossy = passed.lossy ?? 0;
  const counts =
    lossy === 0
      ? `${passed.fatal} fatal problems`
      : passed.fatal === 0
        ? `${lossy} lossy problems`
        : `${passed.fatal} fatal problems and ${lossy} lossy problems`;
  return `The map gave ${counts} for the last passed fetch.`;
}

/**
 * The conditions in the order of their weight. The first condition that holds gives the state:
 * failing, then unknown, then changed, then silent, then slow, then healthy.
 */
function classify(track: HealthTrack, descriptor: HealthSource, options: HealthOptions): { readonly state: HealthState; readonly reason: string } {
  const failAfter = Math.max(1, options.failAfter ?? DEFAULT_FAIL_AFTER);
  if (track.failures >= failAfter) {
    return { state: "failing", reason: `The last ${track.failures} fetches failed: ${track.lastFailure?.failure.kind ?? "unknown"}.` };
  }
  const stale = staleAfter(descriptor, options);
  if (track.time - track.staleFrom >= stale) {
    return { state: "failing", reason: `No fetch passed in ${seconds(track.time - track.staleFrom)}, and the limit is ${seconds(stale)}.` };
  }
  if (track.canary !== undefined && !track.canary.pass) {
    return { state: "failing", reason: `The canary failed: ${track.canary.reason}` };
  }
  if (track.passed === undefined) return { state: "unknown", reason: "No fetch passed yet." };
  if (track.passed.fatal + (track.passed.lossy ?? 0) > 0) return { state: "changed", reason: changedReason(track.passed) };
  const quiet = maxQuiet(descriptor);
  if (quiet !== undefined && track.quietFrom !== undefined && track.time - track.quietFrom >= quiet) {
    return { state: "silent", reason: `No fresh observation in ${seconds(track.time - track.quietFrom)}, and the limit is ${seconds(quiet)}.` };
  }
  if (track.passed.took >= descriptor.slowAfter) {
    return { state: "slow", reason: `The last fetch took ${seconds(track.passed.took)}, and the limit is ${seconds(descriptor.slowAfter)}.` };
  }
  return { state: "healthy", reason: "The last fetch passed." };
}

function stepOf(track: HealthTrack, descriptor: HealthSource, options: HealthOptions, transitions: readonly Transition[]): HealthStep {
  const { reason } = classify(track, descriptor, options);
  const health: SourceHealth = {
    source: track.source,
    state: track.state,
    since: track.since,
    ...(track.passed === undefined ? {} : { lastSuccess: track.passed.at }),
    ...(track.lastFailure === undefined ? {} : { lastFailure: track.lastFailure }),
    reason,
  };
  const wake = deadlines(track, descriptor, options).filter((t) => t.at > track.time).map((t) => t.at);
  return { track, health, transitions, ...(wake.length > 0 ? { wakeAt: Math.min(...wake) } : {}) };
}

// Each limit is 1 or more, so an event never meets a limit at the time that it sets the limit.
function staleAfter(descriptor: HealthSource, options: HealthOptions): Duration {
  return Math.max(1, options.staleAfter ?? DEFAULT_STALE_INTERVALS * descriptor.interval);
}

function maxQuiet(descriptor: HealthSource): Duration | undefined {
  return descriptor.maxQuiet === undefined ? undefined : Math.max(1, descriptor.maxQuiet);
}

function seconds(ms: Duration): string {
  return `${Math.round(ms / 1000)} s`;
}
