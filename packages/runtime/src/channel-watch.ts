// The runs of failed calls of the channels of this copy, and the probes of its down channels (AL-65, `docs/CONTRACTS.md`).

import type { WallClock } from "@mark1russell7/algebra/clock";
import { channelRuns, runOpens, type ChannelDownPolicy, type ChannelId, type ChannelProcedures, type ChannelRun, type ChannelSnapshot, type Duration, type HealthTrack, type Instant, type ProbeOutcome } from "@mark1russell7/alerts";
import { backoffDelay, type Backoff } from "@mark1russell7/service/backoff";
import { errorMessage } from "@mark1russell7/text";
import type { DeliveryStep } from "./delivery.ts";
import type { ChannelCall } from "./events.ts";
import { limited } from "./limit.ts";

/** The backoff of the probes after failed probes: 1 minute after the first failure, then 2, 4 and up to 30 minutes. */
export const PROBE_BACKOFF: Backoff = { base: 60_000, factor: 2, cap: 1_800_000 };

/** The time from the last good call of a channel to its next probe: 15 minutes. Thus a quiet channel gets a probe too. */
export const PROBE_IDLE: Duration = 900_000;

/** The options of the watch of the channels. */
export interface ChannelWatchOptions {
  /** The id of this copy. Each copy has its own runs and lines. */
  readonly copy: string;
  readonly channels: readonly ChannelProcedures[];
  /** The policy of the lines. The watch uses it only to wake the next pass when a run opens a line. */
  readonly policy: ChannelDownPolicy;
  readonly clock: WallClock;
  /** The longest time that one probe waits. A probe past it is a `timeout`. */
  readonly callLimit: Duration;
  /** The backoff of the probes after failed probes. The default is `PROBE_BACKOFF`. */
  readonly backoff?: Backoff;
  /** The time from the last good call of a channel to its next probe. The default is `PROBE_IDLE`. */
  readonly idle?: Duration;
}

/** The watch of the channels of this copy. It keeps its runs in memory, thus a restart empties them. */
export interface ChannelWatch {
  /** This function gives the channels for the system view: the run and the time of the last good call of each channel. */
  snapshots(): ChannelSnapshot[];
  /**
   * This function calls the probe of each channel with a probe when its time comes. It gives true when a probe passed.
   * A pass is a good call: it ends the run and the line. A failed probe counts in the run, thus a quiet outage opens a line.
   * The first probe comes 1 minute after the first use of this function.
   */
  probe(at: Instant, lastSuccess?: Instant): Promise<boolean>;
  /**
   * This function adds the calls of one delivery step to the runs. It gives true when a run starts to open a line, or when
   * a down channel got an accepted send. Then the next view changes a line, and the runtime wakes at once.
   */
  step(delivery: DeliveryStep, at: Instant, down: readonly ChannelId[], lastSuccess?: Instant): boolean;
  /** The time of the next probe. */
  wakeAt(): Instant | undefined;
  /** This function gives each call of the probes and of the steps since its last use, and empties the list (AL-147). */
  calls(): ChannelCall[];
}

/** This function gives the time of the last passed fetch of any source of this copy. It shows that the network of the copy works. */
export function lastFetchSuccess(health: Readonly<Record<string, HealthTrack>>): Instant | undefined {
  let last: Instant | undefined;
  for (const track of Object.values(health)) if (track.passed !== undefined && (last === undefined || track.passed.at > last)) last = track.passed.at;
  return last;
}

/** This function makes the watch of the channels of this copy. */
export function channelWatch(options: ChannelWatchOptions): ChannelWatch {
  const { clock, policy } = options;
  const backoff = options.backoff ?? PROBE_BACKOFF;
  const idle = options.idle ?? PROBE_IDLE;
  const entries = options.channels.map((procedures) => ({ procedures, descriptor: procedures.describe() }));
  const probeOf = new Map<ChannelId, () => Promise<ProbeOutcome>>();
  for (const { procedures, descriptor } of entries) {
    const probe = procedures.probe?.bind(procedures);
    if (probe !== undefined) probeOf.set(descriptor.id, probe);
  }
  let runs: ChannelRun[] = [];
  const good = new Map<ChannelId, Instant>();
  // The next probe of each channel with a probe, and the count of its failed probes in a row. After a good call, the next
  // probe waits `idle`. After k failed probes, it waits `backoffDelay(backoff, k)`.
  const probes = new Map<ChannelId, { readonly failed: number; readonly next: Instant }>();
  // The calls since the last read of `calls`. The runtime writes them into the log after each pass.
  let calls: ChannelCall[] = [];

  const noteGood = (channel: ChannelId, at: Instant): void => {
    const last = good.get(channel);
    if (last === undefined || at > last) good.set(channel, at);
  };

  const schedule = (at: Instant): void => {
    for (const channel of probeOf.keys()) if (!probes.has(channel)) probes.set(channel, { failed: 0, next: at + backoffDelay(backoff, 1) });
  };

  const rest = (channel: ChannelId, at: Instant): void => {
    if (probeOf.has(channel)) probes.set(channel, { failed: 0, next: at + idle });
  };

  const timedOut = (): ProbeOutcome => ({ ok: false, kind: "timeout", message: `The probe did not end in ${options.callLimit} ms.` });
  const threw = (error: unknown): ProbeOutcome => ({ ok: false, kind: "network", message: errorMessage(error) });

  return {
    snapshots: () =>
      entries.map(({ descriptor }) => {
        const run = runs.find((entry) => entry.channel === descriptor.id);
        const last = good.get(descriptor.id);
        return {
          copy: options.copy,
          channel: descriptor.id,
          title: descriptor.title,
          ...(descriptor.api === undefined ? {} : { api: descriptor.api }),
          ...(run === undefined ? {} : { run }),
          ...(last === undefined ? {} : { good: last }),
        };
      }),

    async probe(at, lastSuccess) {
      schedule(at);
      const due = [...probes].filter(([, entry]) => entry.next <= at);
      const outcomes = await Promise.all(
        due.map(async ([channel, entry]) => {
          const probe = probeOf.get(channel);
          const outcome = probe === undefined ? timedOut() : await limited(probe(), options.callLimit, clock, timedOut, threw);
          return { channel, entry, outcome };
        }),
      );
      let passed = false;
      for (const { channel, entry, outcome } of outcomes) {
        const end = clock.now();
        calls.push({ channel, call: "probe", time: end, ...(outcome.ok ? {} : { kind: outcome.kind }) });
        if (outcome.ok) {
          noteGood(channel, outcome.at);
          runs = channelRuns(runs, { at: end, failures: [], good: [channel] });
          rest(channel, end);
          passed = true;
        } else {
          runs = channelRuns(runs, { at: end, failures: [{ channel, call: "probe", kind: outcome.kind }], good: [], ...(lastSuccess === undefined ? {} : { lastSuccess }) });
          probes.set(channel, { failed: entry.failed + 1, next: end + backoffDelay(backoff, entry.failed + 1) });
        }
      }
      return passed;
    },

    step(delivery, at, down, lastSuccess) {
      const accepted = [...new Set(delivery.sent.map((sent) => sent.channel))];
      const opening = new Set(runs.filter((run) => runOpens(run, policy)).map((run) => run.channel));
      const failures = delivery.failures.map((failure) => ({ channel: failure.channel, call: failure.call, kind: failure.kind }));
      runs = channelRuns(runs, { at, failures, good: accepted, ...(lastSuccess === undefined ? {} : { lastSuccess }) });
      calls.push(...failures.map((failure) => ({ ...failure, time: at })), ...delivery.sent.map((sent) => ({ channel: sent.channel, call: "send" as const, time: sent.at })));
      for (const sent of delivery.sent) noteGood(sent.channel, sent.at);
      for (const channel of accepted) rest(channel, at);
      const open = new Set<string>(down);
      const opened = runs.some((run) => runOpens(run, policy) && !opening.has(run.channel) && !open.has(run.channel));
      const ended = accepted.some((channel) => open.has(channel));
      return opened || ended;
    },

    wakeAt: () => {
      let next: Instant | undefined;
      for (const entry of probes.values()) if (next === undefined || entry.next < next) next = entry.next;
      return next;
    },

    calls: () => {
      const read = calls;
      calls = [];
      return read;
    },
  };
}
