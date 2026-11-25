/**
 * AL-103: a seeded store of the runtime at a size, for the CI gate on the start memory. `seedStore` writes the log
 * `runtime.sqlite` into a folder until the file has a byte size. The events have the mix of a live log: the counts and the
 * bytes of each source in `LIVE_MIX`.
 *
 * The events come from the steps of the runtime, thus their form is the form of a live log:
 *
 * - `fetchStep` gives the observation events and the fetch event of each fetch.
 * - `snapshotStep` gives the `ended` events of a snapshot source.
 * - `importPage` gives the imports of the shared events of a second copy, and the `exchange` events.
 * - The fold retires the old incidents on the cadence of the runtime (AL-109). Thus the log has no `retired` event, as a live log.
 * - `createDispatcher` gives the delivery path, with the made-up people and channels of `seed-delivery.ts` (AL-104).
 * - `systemView` gives the `system` events at the steps of the delivery path, with the causes of `seed-system.ts` (AL-104).
 *
 * The options `shapes` and `transit` also write the cache of the zone shapes and the copy of the transit catalog, from
 * `seed-files.ts`. The option `open` adds reports that stay live at the end of the log, at the areas that the caller gives (AL-126).
 * The option `observe` puts sources in observe mode at the start of the log, as the new sources of a live copy (AL-172).
 *
 * The function folds each event into a state, as a live copy does. Thus the retirements keep the state bounded, and the
 * log ends in the state of a copy that operated for the days of the log.
 *
 * The reports and the observations are made-up records. They have no real place, zone code, feed or person:
 *
 * - The zone codes are `ZZZ001` to `ZZZ120`, the forecast zones of the first state of `seedShapes`. No state has the code `ZZ`.
 * - The transit feeds are `gtfs-seed-1` to `gtfs-seed-4`, and the status pages are `status-seed-01` to `status-seed-37`.
 * - The text of each record is a list of made-up words, at the byte size of the mix.
 *
 * The draws come from one seed. The same seed and the same size give the same log.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_LINK_POLICY,
  normalize,
  observationId,
  reportId,
  type Area,
  type Category,
  type FetchFailure,
  type Instant,
  type Observation,
  type ObservationId,
  type Report,
  type ReportId,
  type Severity,
  type SourceDescriptor,
  type SourceId,
  type Subject,
} from "@mark1russell7/alerts";
import {
  EMPTY_RUNTIME,
  EXCHANGE_FORMAT,
  envelope,
  fetchStep,
  fold,
  importPage,
  openRuntimeLog,
  SNAPSHOT_MISSES,
  snapshotStep,
  type ExchangeCursor,
  type FetchEvent,
  type FoldContext,
  type ObservationEvent,
  type ReceivedPage,
  type RetentionOptions,
  type RuntimeEvent,
  type RuntimeState,
  type SharedFetchEvent,
  type SharedItem,
} from "@mark1russell7/alerts-runtime";
import { random, seedOf, type Random } from "@mark1russell7/rigor-generators";
import { openDatabase } from "@mark1russell7/sqlite";
import { seedDelivery, type DeliveryMix } from "./seed-delivery.ts";
import { seedSystem, type SystemMix } from "./seed-system.ts";
import { SEED_FORECAST_ZONES, seedShapes, seedTransit, type NearFeeds, type SeedShapesResult, type SeedTransitResult } from "./seed-files.ts";
import { fileBytes, pagesOf, textOf } from "./seed-parts.ts";

const DAY = 86_400_000;

/** The form of the areas of the reports of a source. */
export type SeedShape = "circle" | "zone" | "subject";

/**
 * The counts of one source, or of one group of sources, in the measure of a live log. Each count and each byte size is
 * for the whole measure and the whole group.
 */
export interface SourceMix {
  /** The id of the source, or the prefix of the ids of the group. */
  readonly source: string;
  /** A snapshot source lists all its messages that are in effect. A stream source gives only new messages. */
  readonly listing: "stream" | "snapshot";
  /** The count of sources in the group. Each source of a group gets an equal part of each count. */
  readonly copies: number;
  /** The count of fetches. */
  readonly fetches: number;
  /** The count of new observations. */
  readonly observations: number;
  /** The count of reports in the fetch events. */
  readonly reports: number;
  /** The bytes of the observation events. */
  readonly observationBytes: number;
  /** The bytes of the reports in the fetch events. */
  readonly reportBytes: number;
  /** The count of messages in the list of a snapshot source. The measure does not give it, thus it is a made-up count. */
  readonly window?: number;
  /** The kind codes of the reports, from the taxonomy. */
  readonly kinds: readonly string[];
  /** The form of the areas of the reports. */
  readonly shape: SeedShape;
}

/** The mix of a live log: the counts of the sources, and the counts of the events of the exchange and of the starts. */
export interface LogMix {
  /** The days of the measure. */
  readonly days: number;
  readonly sources: readonly SourceMix[];
  /** The count of `exchange` events. The function reads the second copy at this rate. */
  readonly exchanges: number;
  /**
   * The bytes of the `import` events. The second copy shares a fetch with reports at a chance that gives these bytes. The
   * reports of a shared fetch set the bytes of its import, thus the store matches the bytes of the imports, not their count.
   */
  readonly importBytes: number;
  /** The count of `started` events. */
  readonly starts: number;
  /** The delivery path. Without it, the log has no event of the delivery path. */
  readonly delivery?: DeliveryMix;
  /** The causes of the system lines. The view steps at the steps of the delivery path, thus `system` needs `delivery`. */
  readonly system?: SystemMix;
}

/** The count and the bytes of the events of one type. */
export interface TypeCount {
  readonly count: number;
  readonly bytes: number;
}

const NWS_KINDS = ["met.wind.high", "met.flood.flash", "met.thunderstorm.severe", "met.special", "met.fog", "met.heat", "met.flood.river", "met.marine.small-craft"];
// The observations of usgs, swpc, ipaws and the status pages: 1,034 observations and 1.7 MB in the measure. The measure
// does not give each source, thus each observation of these sources gets an equal part of the bytes.
const OTHER_OBSERVATION_BYTES = 1_700_000 / 1_034;

/**
 * The mix of the log of one live copy on 2026-11-21: 171,195 events and 181.6 MB in 5.8 days. The read of the log gave
 * only counts and byte sizes for each type and each source.
 *
 * - Approximately 40 status sources have 1,232 fetches each, with 0 to 65 reports each. The two power sources are in that count,
 *   thus the group of status pages has 37 sources. Their 492 reports and 0.5 MB are the rest of the totals of the measure.
 * - The measure does not give the observations of usgs, swpc, ipaws and the status pages. Each report of them gets one observation.
 * - A sweep on 2026-11-21 gave the delivery mix. Most live escalations came from system lines, and few from weather reports.
 *   Thus each place has only 2 zones. On 5 seeds of 36 hours, each frequent type had 0.29 to 2.0 times its live rate.
 * - Approximately 3 in 4 live deliveries were in a digest. The live digests went at one time of each day.
 * - The fetches of the live log gave the system mix: approximately 2 outages of the cell in a day, most of 5 minutes or less.
 *   One source refused each fetch. Out of the outages, approximately 3 fetches in 10,000 failed.
 * - The other copy had approximately 15 gaps in a day of its reads, out of the outages.
 */
export const LIVE_MIX: LogMix = {
  days: 5.8,
  sources: [
    { source: "emsc", listing: "snapshot", copies: 1, fetches: 4_000, observations: 16_893, reports: 17_096, observationBytes: 12_000_000, reportBytes: 19_500_000, window: 60, kinds: ["geo.earthquake"], shape: "circle" },
    { source: "nwws", listing: "stream", copies: 1, fetches: 12_299, observations: 3_039, reports: 3_039, observationBytes: 14_400_000, reportBytes: 8_500_000, kinds: NWS_KINDS, shape: "zone" },
    { source: "gtfs-seed-", listing: "snapshot", copies: 4, fetches: 1_516, observations: 6_610, reports: 6_149, observationBytes: 12_400_000, reportBytes: 7_700_000, window: 30, kinds: ["transport.transit.service-alert"], shape: "subject" },
    { source: "nws-api", listing: "stream", copies: 1, fetches: 5_403, observations: 642, reports: 642, observationBytes: 1_400_000, reportBytes: 1_000_000, kinds: NWS_KINDS, shape: "zone" },
    { source: "usgs", listing: "snapshot", copies: 1, fetches: 4_000, observations: 396, reports: 396, observationBytes: 396 * OTHER_OBSERVATION_BYTES, reportBytes: 400_000, window: 20, kinds: ["geo.earthquake"], shape: "circle" },
    { source: "swpc", listing: "stream", copies: 1, fetches: 3_730, observations: 94, reports: 94, observationBytes: 94 * OTHER_OBSERVATION_BYTES, reportBytes: 100_000, kinds: ["geo.space-weather.geomagnetic-storm", "geo.space-weather.radio-blackout"], shape: "subject" },
    { source: "ipaws", listing: "stream", copies: 1, fetches: 5_403, observations: 52, reports: 52, observationBytes: 52 * OTHER_OBSERVATION_BYTES, reportBytes: 100_000, kinds: NWS_KINDS, shape: "zone" },
    { source: "eia-930", listing: "stream", copies: 1, fetches: 1_232, observations: 42_870, reports: 0, observationBytes: 33_600_000, reportBytes: 0, kinds: [], shape: "subject" },
    { source: "energy-charts", listing: "stream", copies: 1, fetches: 1_232, observations: 2_899, reports: 0, observationBytes: 3_600_000, reportBytes: 0, kinds: [], shape: "subject" },
    { source: "status-seed-", listing: "snapshot", copies: 37, fetches: 37 * 1_232, observations: 492, reports: 492, observationBytes: 492 * OTHER_OBSERVATION_BYTES, reportBytes: 500_000, window: 4, kinds: ["infra.cloud.outage", "infra.saas.outage"], shape: "subject" },
  ],
  exchanges: 2_508,
  importBytes: 37_200_000,
  starts: 119,
  delivery: { people: 4, zones: 2, refusal: 0.15, gap: 2 * 60_000, every: 15 * 60_000, limits: { window: 3_600_000, notice: 1, urgent: 3 }, crash: 0.06, digest: "13:00" },
  system: { outages: 2.1, outage: [2 * 60_000, 12 * 60_000], down: 1, failure: 3e-4, gaps: 15, gap: [90_000, 10 * 60_000] },
};

/**
 * The count and the JSON bytes of each type of event in the log of `LIVE_MIX`. A gate compares the types of a seeded log with
 * these values. The read rounded each byte size to 0.1 MB, thus a small type has 0 bytes. The log had no `retired` event: its
 * 5.8 days are less than the retention horizon of 7 days.
 */
export const LIVE_TYPES: Readonly<Record<string, TypeCount>> = {
  observation: { count: 73_987, bytes: 79_100_000 },
  fetch: { count: 84_755, bytes: 59_600_000 },
  import: { count: 4_969, bytes: 37_200_000 },
  system: { count: 331, bytes: 2_400_000 },
  ended: { count: 961, bytes: 1_500_000 },
  exchange: { count: 2_508, bytes: 500_000 },
  delivery: { count: 906, bytes: 400_000 },
  escalation: { count: 1_083, bytes: 400_000 },
  hold: { count: 648, bytes: 200_000 },
  attempt: { count: 339, bytes: 100_000 },
  cancelled: { count: 281, bytes: 100_000 },
  "escalation-end": { count: 168, bytes: 0 },
  refused: { count: 89, bytes: 0 },
  started: { count: 119, bytes: 0 },
  settled: { count: 46, bytes: 0 },
  back: { count: 2, bytes: 0 },
  clock: { count: 3, bytes: 0 },
};

/** The options of `seedStore`. */
export interface SeedStoreOptions {
  /** The byte size of the database `runtime.sqlite`. The function stops at the first write at this size or more. */
  readonly log: number;
  /** The seed of the draws: a number, or a name. */
  readonly seed: number | string;
  /** The mix of the log. The default is `LIVE_MIX`. */
  readonly mix?: LogMix;
  /** The time of the first event. The default is 2026-01-01T00:00:00Z. */
  readonly start?: Instant;
  /** The retention of the runtime, in the context of the fold. The defaults are the defaults of the runtime. */
  readonly retention?: RetentionOptions;
  /** The byte size of `shapes.sqlite`, from `seedShapes`. When it is absent, the function writes no cache of shapes. */
  readonly shapes?: number;
  /** The byte size of `transit-catalog.json`, from `seedTransit`. When it is absent, the function writes no copy of the catalog. */
  readonly transit?: number;
  /** The feeds of the copy of the catalog near one point, with the option `transit` (AL-126). */
  readonly near?: NearFeeds;
  /** The reports that stay live at the end of the log (AL-126). They come after the log of the byte size `log`. */
  readonly open?: OpenReports;
  /**
   * The starts of the ids of the sources in observe mode (AL-172). The log starts with a `mode` event for each source of
   * the mix with one of these starts. An example is `gtfs-seed-`. The default puts no source in observe mode.
   */
  readonly observe?: readonly string[];
}

/**
 * The reports that stay live at the end of the log (AL-126). The lab of the capacity models reads them as the open incidents
 * of its configuration.
 */
export interface OpenReports {
  /** The count of the reports: a whole number, 0 or more. Each report is a new incident. */
  readonly incidents: number;
  /** The areas of each report. A place of the configuration in these areas gets each incident. */
  readonly areas: readonly Area[];
}

/** The result of `seedStore`. */
export interface SeedStoreResult {
  /** The path of `runtime.sqlite`. */
  readonly path: string;
  /** The byte size of the file and its write-ahead log after the close. */
  readonly bytes: number;
  /** The count of events. */
  readonly events: number;
  /** The time of the first event. */
  readonly start: Instant;
  /**
   * The time of the state after the last event. An import does not change it. A measure of the start starts its wall clock
   * at this time, with `wallClock({ start: end })`. With the clock of the system, the first pass retires the old incidents.
   */
  readonly end: Instant;
  /** The count and the JSON bytes of the events of each type. */
  readonly types: Readonly<Record<string, TypeCount>>;
  /** The cache of shapes, when the options give its size. Its records have the fetch time `end`. */
  readonly shapes?: SeedShapesResult;
  /** The copy of the catalog, when the options give its size. Its fetch time is `end`. */
  readonly transit?: SeedTransitResult;
  /** The count of the reports of the option `open`, when the options give it. */
  readonly open?: number;
}

/** The id of the second copy of the store, and the id of its log. */
export const SEED_PEER = "seed-b";
const SEED_SELF = "seed-a";
const PEER_LOG = "seed-b-log";
const START = Date.UTC(2026, 0, 1);
const SEVERITIES: readonly Severity[] = ["minor", "moderate", "severe", "unknown"];
// The bytes of an observation event other than its body: the envelope, the id, the source, the type and the transport.
const OBSERVATION_FRAME = 330;

/** The plan of one source: its counts for each fetch, and its state in the run. */
interface SourcePlan {
  readonly id: SourceId;
  readonly mix: SourceMix;
  readonly every: number;
  readonly observationsPerFetch: number;
  readonly reportsPerObservation: number;
  readonly observationBytes: number;
  readonly reportBytes: number;
  readonly r: Random;
  next: Instant;
  count: number;
  // A snapshot source: the observations of its list, the live reports of the list, and the misses of each report.
  listed: Observation[];
  live: Map<ReportId, Report>;
  misses: ReadonlyMap<ReportId, number>;
  // The keys of the recent reports, for the updates.
  keys: string[];
}

/**
 * This function writes the log `runtime.sqlite` of a runtime into `dir`, at the byte size `log`. Refer to the module comment.
 *
 * @throws Error when `log` is not a finite number above 0, or when an id of an event is not new.
 */
export async function seedStore(dir: string, options: SeedStoreOptions): Promise<SeedStoreResult> {
  if (!Number.isFinite(options.log) || options.log <= 0) throw new Error(`The size of the log is ${String(options.log)}, not a finite number above 0.`);
  if (options.open !== undefined && !(Number.isInteger(options.open.incidents) && options.open.incidents >= 0)) {
    throw new RangeError(`The count of the open reports is ${String(options.open.incidents)}, not a whole number, 0 or more.`);
  }
  await mkdir(dir, { recursive: true });
  const path = join(dir, "runtime.sqlite");
  const mix = options.mix ?? LIVE_MIX;
  if (mix.system !== undefined && mix.delivery === undefined) throw new Error("The mix has a system mix with no delivery mix. The view steps at the steps of the delivery path.");
  const root = random(seedOf(options.seed));
  const start = options.start ?? START;
  const span = mix.days * DAY;
  const plans = mix.sources.flatMap((source) => plansOf(source, span, root, start));
  const retention = options.retention ?? {};
  // The context of the fold of a live copy. With a system mix, the configuration has the sources of the plans. The fold
  // retires on the cadence of the event time.
  const sources = mix.system === undefined ? [] : plans.map(descriptorOf);
  const context: FoldContext = { sources, retention };
  const share = Math.min(1, mix.importBytes / mix.sources.reduce((sum, source) => sum + source.reportBytes, 0));
  const peer = root.fork("peer");
  const exchangeEvery = Math.round(span / mix.exchanges);
  const startEvery = Math.round(span / mix.starts);
  const peerAt = new Map<SourceId, Instant>();
  let nextExchange = start + exchangeEvery;
  let nextStart = start + startEvery;
  let position: ExchangeCursor | undefined;
  let shared: SharedItem[] = [];
  let peerNext = 0;
  let runs = 0;

  const log = openRuntimeLog(path);
  // A second connection reads the size of the database, with the pages in the write-ahead log.
  const reader = openDatabase(path, { readOnly: true });
  const types: Record<string, { count: number; bytes: number }> = {};
  let state: RuntimeState = EMPTY_RUNTIME;
  let pending: RuntimeEvent[] = [];
  let pendingBytes = 0;
  let written = 0;
  let onDisk = 0;
  const chunk = Math.min(4_000_000, Math.max(64_000, options.log / 100));
  const add = (events: readonly RuntimeEvent[]): void => {
    for (const event of events) {
      state = fold(state, event, context);
      const bytes = JSON.stringify(event).length;
      const held = (types[event.type] ??= { count: 0, bytes: 0 });
      held.count += 1;
      held.bytes += bytes;
      pending.push(event);
      pendingBytes += bytes;
    }
  };
  const flush = (): void => {
    if (pending.length === 0) return;
    let accepted = 0;
    log.appendAll(pending, () => {
      accepted += 1;
    });
    if (accepted !== pending.length) throw new Error(`The seeded log has an event with an id that the log has, in the ${String(pending.length)} events after ${String(written)}.`);
    written += pending.length;
    pending = [];
    pendingBytes = 0;
    onDisk = pagesOf(reader);
  };

  const delivery = mix.delivery === undefined ? undefined : seedDelivery(mix.delivery, root.fork("delivery"), { start, run: `seed-run-${String(runs)}`, state: () => state, append: add });
  const system = mix.system === undefined ? undefined : seedSystem(mix.system, root.fork("system"), { start, self: SEED_SELF, peer: SEED_PEER, sources, retention, state: () => state });

  try {
    add([{ ...envelope("started", `started:seed-run-${String(runs)}`, start), run: `seed-run-${String(runs)}` }]);
    const observed = plans.filter((plan) => (options.observe ?? []).some((prefix) => plan.id.startsWith(prefix)));
    add(observed.map((plan): RuntimeEvent => ({ ...envelope("mode", `mode:${plan.id}`, start), source: plan.id, mode: "observe", reason: "seed" })));
    while (onDisk + pendingBytes < options.log) {
      const plan = earliest(plans);
      const at = Math.min(plan.next, nextExchange, nextStart, delivery?.due ?? Number.POSITIVE_INFINITY);
      if (at === delivery?.due) {
        // The view comes before the delivery step, as in a pass of the runtime. Its system reports are incidents too.
        const view = system?.step(at, delivery.places);
        if (view !== undefined) add(view.events);
        const stopped = await delivery.step(at);
        if (view?.wakeAt !== undefined) delivery.wake(view.wakeAt);
        // After a stop of the runtime in the step, the next start comes at once.
        if (stopped) nextStart = at;
      } else if (at === nextStart) {
        nextStart += startEvery;
        runs += 1;
        const run = `seed-run-${String(runs)}`;
        add([{ ...envelope("started", `started:${run}`, at), run }]);
        // The counts of the misses and the times of the dispatcher are in memory only. After a start they begin again.
        for (const each of plans) each.misses = new Map();
        delivery?.restart(run);
        system?.restart(at);
      } else if (at === nextExchange) {
        nextExchange += exchangeEvery;
        peerNext += shared.length + peer.int(5, 40);
        const page: ReceivedPage = { format: EXCHANGE_FORMAT, copy: SEED_PEER, log: PEER_LOG, after: position?.next ?? 0, next: peerNext, head: peerNext, items: shared };
        const read = importPage(page, { self: SEED_SELF, position, logged: state.exchanges[SEED_PEER], now: at });
        if (read.problems.length > 0) throw new Error(`The seeded page of the second copy has a problem: ${read.problems[0] ?? ""}`);
        position = read.position;
        shared = [];
        add(read.events);
      } else {
        const result = system?.fetch(plan.id, at);
        const events = fetchOf(plan, at, result?.failure);
        add(events);
        const fetch = events.at(-1) as FetchEvent;
        if (fetch.reports.length > 0 && peer.chance(share)) shared.push({ from: SEED_PEER, event: peerCopy(fetch, peer, peerAt) });
        if (plan.mix.listing === "snapshot" && result?.failure === undefined) add(snapshotOf(plan, fetch));
        // Only the reports of the zones reach a made-up place. A fetch with other results than the last fetch of its source
        // can change the health. Thus these fetches bring the next step.
        if ((fetch.reports.length > 0 && plan.mix.shape === "zone") || result?.turned === true) delivery?.wake(at);
      }
      if (pendingBytes >= chunk) flush();
    }
    if (options.open !== undefined) add(openOf(options.open, state.time, root.fork("open")));
    flush();
  } finally {
    reader.close();
    log.close();
  }
  const end = state.time;
  const shapes = options.shapes === undefined ? undefined : await seedShapes(dir, { bytes: options.shapes, seed: options.seed, fetched: end });
  const near = options.near === undefined ? {} : { near: options.near };
  const transit = options.transit === undefined ? undefined : await seedTransit(dir, { bytes: options.transit, seed: options.seed, fetched: end, ...near });
  return {
    path,
    bytes: fileBytes(path),
    events: written,
    start,
    end,
    types,
    ...(shapes === undefined ? {} : { shapes }),
    ...(transit === undefined ? {} : { transit }),
    ...(options.open === undefined ? {} : { open: options.open.incidents }),
  };
}

// The source of the open reports: the NWS API, as in the mix. The kinds are the kinds of the NWS on land.
const OPEN_SOURCE = "nws-api" as SourceId;
const OPEN_KINDS = NWS_KINDS.filter((code) => code !== "met.marine.small-craft");

// The events of one fetch of the NWS API after the time `at`: one observation, with one report for each open incident.
// Each report expires 2 days after the fetch. Thus it is live at the end of the log and at the start of a measure.
function openOf(open: OpenReports, at: Instant, r: Random): RuntimeEvent[] {
  if (open.incidents === 0) return [];
  const started = at + 200;
  const fetched = at + 1_000;
  const contentType = "application/json";
  const body = JSON.stringify({ seed: "open", incidents: open.incidents });
  const url = `https://seed.example.test/${OPEN_SOURCE}/open`;
  const observation: Observation = {
    id: observationId({ source: OPEN_SOURCE, contentType, body, url }),
    source: OPEN_SOURCE,
    fetched,
    contentType,
    body,
    transport: { url, status: 200, latency: r.int(40, 900) },
  };
  const reports = Array.from({ length: open.incidents }, (_, index): Report => {
    const code = OPEN_KINDS[index % OPEN_KINDS.length]!;
    const key = `seed:open:${String(index + 1)}`;
    const sent = fetched - r.int(0, 600_000);
    return {
      id: reportId({ source: OPEN_SOURCE, key, sent }),
      source: OPEN_SOURCE,
      origin: "seed-origin-1",
      key,
      references: [],
      correlation: [],
      status: "actual",
      op: "alert",
      kind: { code, label: `Seed ${code}` },
      categories: ["met"],
      severity: "severe",
      urgency: "expected",
      certainty: "likely",
      response: ["monitor"],
      sent,
      received: fetched,
      expires: fetched + 2 * DAY,
      areas: open.areas,
      about: [],
      sender: "seed sender",
      headline: `Seed ${code} open ${String(index + 1)}`,
      observation: observation.id,
      parameters: {},
    };
  });
  const outcome = { ok: true as const, observations: [observation], complete: true };
  return [...fetchStep({ source: OPEN_SOURCE, procedures: { map: () => ({ reports, problems: [] }) }, started, ended: fetched, outcome, known: () => false }).events];
}

// The map of a fetch with a failure. The fetch has no observation, thus the step does not use it.
const NO_MAP = { map: () => ({ reports: [], problems: [] }) };

// The descriptor of the source of a plan, for the health and the coverage of the view. Each source has its own provider,
// thus the sources of a kind are independent. Each source covers each place. A fetch takes 1.5 seconds or less.
function descriptorOf(plan: SourcePlan): SourceDescriptor {
  return {
    id: plan.id,
    title: `Seeded source ${plan.id}`,
    origins: [plan.mix.source],
    dependsOn: [`provider:${plan.id}`],
    uses: ["internet", "dns", "power"],
    kinds: plan.mix.kinds,
    coverage: "global",
    transport: "poll",
    interval: Math.round(plan.every),
    slowAfter: 10_000,
    auth: "none",
    ...(plan.mix.listing === "snapshot" ? { listing: "snapshot" as const } : {}),
  };
}

// The plans of the sources of a mix. A group gets one plan for each source, with an equal part of each count.
function plansOf(mix: SourceMix, span: number, root: Random, start: Instant): SourcePlan[] {
  return Array.from({ length: mix.copies }, (_, index) => {
    const id = (mix.copies === 1 ? mix.source : `${mix.source}${String(index + 1).padStart(mix.copies > 9 ? 2 : 1, "0")}`) as SourceId;
    const fetches = mix.fetches / mix.copies;
    const r = root.fork(`source:${id}`);
    const every = span / fetches;
    return {
      id,
      mix,
      every,
      observationsPerFetch: mix.observations / mix.fetches,
      reportsPerObservation: mix.observations === 0 ? 0 : mix.reports / mix.observations,
      observationBytes: mix.observations === 0 ? 0 : mix.observationBytes / mix.observations,
      reportBytes: mix.reports === 0 ? 0 : mix.reportBytes / mix.reports,
      r,
      next: Math.round(start + r.range(0, every)),
      count: 0,
      listed: [],
      live: new Map(),
      misses: new Map(),
      keys: [],
    };
  });
}

// The plan with the earliest next fetch. A tie goes to the first plan of the list.
function earliest(plans: readonly SourcePlan[]): SourcePlan {
  let best = plans[0]!;
  for (const plan of plans) if (plan.next < best.next) best = plan;
  return best;
}

// A count with the mean `mean`: the whole part, and 1 more with the chance of the rest.
function countOf(r: Random, mean: number): number {
  const whole = Math.floor(mean);
  return whole + (r.chance(mean - whole) ? 1 : 0);
}

// The events of one fetch of a source: its new observations, and the fetch event from `fetchStep`. A fetch with a failure
// gives only its fetch event.
function fetchOf(plan: SourcePlan, started: Instant, failure: FetchFailure | undefined): (ObservationEvent | FetchEvent)[] {
  const { r, mix } = plan;
  plan.next = Math.round(started + plan.every * r.range(0.9, 1.1));
  const ended = started + r.int(80, 1_500);
  if (failure !== undefined) return fetchStep({ source: plan.id, procedures: NO_MAP, started, ended, outcome: { ok: false, failure }, known: () => true }).events;
  const fresh: Observation[] = [];
  const reports = new Map<ObservationId, Report[]>();
  // The reports of an observation come after it, thus their keys have the number of the observation.
  for (let left = countOf(r, plan.observationsPerFetch); left > 0; left -= 1) {
    const observation = observationOf(plan, ended);
    fresh.push(observation);
    reports.set(observation.id, Array.from({ length: countOf(r, plan.reportsPerObservation) }, (_, part) => reportOf(plan, observation, part)));
  }
  let listed: readonly Observation[] = fresh;
  if (mix.listing === "snapshot") {
    // The list keeps its newest messages. A message that leaves the list ends after `SNAPSHOT_MISSES` complete fetches.
    plan.listed = [...plan.listed, ...fresh].slice(-(mix.window ?? 1));
    listed = plan.listed;
    for (const each of reports.values()) for (const report of each) plan.live.set(report.id, report);
  }
  const isFresh = new Set(fresh.map((observation) => observation.id));
  const step = fetchStep({
    source: plan.id,
    procedures: { map: ({ observation }) => ({ reports: reports.get(observation.id) ?? [], problems: [] }) },
    started,
    ended,
    outcome: { ok: true, observations: listed, complete: true },
    known: (id) => !isFresh.has(id),
  });
  return step.events;
}

// The `ended` events of a fetch of a snapshot source. The step gets only the live reports of the source: it reads only
// the reports of its source that did not end, thus its events are the events of the whole merge state.
function snapshotOf(plan: SourcePlan, fetch: FetchEvent): RuntimeEvent[] {
  const step = snapshotStep({
    source: plan.id,
    started: fetch.record.at,
    ended: fetch.time,
    outcome: { ok: true, observations: plan.listed, complete: true },
    merge: normalize({ reports: [...plan.live.values()] }),
    misses: plan.misses,
    limit: SNAPSHOT_MISSES,
  });
  plan.misses = step.misses;
  for (const event of step.events) if (event.type === "ended") for (const id of event.reports) plan.live.delete(id);
  return [...step.events];
}

// A made-up observation at the byte size of the mix. The count in the body makes each observation new.
function observationOf(plan: SourcePlan, fetched: Instant): Observation {
  plan.count += 1;
  const { r } = plan;
  const size = Math.max(16, plan.observationBytes * r.range(0.7, 1.3) - OBSERVATION_FRAME);
  const body = JSON.stringify({ seed: plan.count, text: textOf(r, size) });
  const contentType = "application/json";
  const url = `https://seed.example.test/${plan.id}`;
  return {
    id: observationId({ source: plan.id, contentType, body, url }),
    source: plan.id,
    fetched,
    contentType,
    body,
    transport: { url, status: 200, latency: r.int(40, 900) },
  };
}

// A made-up report of an observation, at the byte size of the mix. A part of the reports update an earlier key. The
// reports of the families of the link rule have an onset, and an earthquake has a magnitude, thus the rule reads them.
function reportOf(plan: SourcePlan, observation: Observation, part: number): Report {
  const { r, mix } = plan;
  const sent = observation.fetched - r.int(0, 600_000);
  const key = `seed:${plan.id}:${String(plan.count)}:${String(part)}`;
  const earlier = plan.keys.length > 0 && r.chance(0.3) ? r.pick(plan.keys) : undefined;
  plan.keys = [...plan.keys.slice(-40), key];
  const code = r.pick(mix.kinds);
  const linked = DEFAULT_LINK_POLICY.families.some((family) => code === family.family || code.startsWith(`${family.family}.`));
  const base: Report = {
    id: reportId({ source: plan.id, key, sent }),
    source: plan.id,
    origin: `seed-origin-${String(r.int(1, 9))}`,
    key,
    references: earlier === undefined ? [] : [earlier],
    correlation: [],
    status: "actual",
    op: earlier === undefined ? "alert" : "update",
    kind: { code, label: `Seed ${code}` },
    categories: [code.split(".")[0] as Category],
    severity: r.pick(SEVERITIES),
    urgency: "expected",
    certainty: "likely",
    response: ["monitor"],
    sent,
    received: observation.fetched,
    ...(linked ? { onset: sent - r.int(0, 120_000) } : {}),
    ...(mix.listing === "stream" ? { expires: sent + r.int(3_600_000, 12 * 3_600_000) } : {}),
    areas: areasOf(r, mix.shape),
    about: aboutOf(r, mix.shape, plan.id),
    sender: "seed sender",
    headline: `Seed ${code} ${String(plan.count)}`,
    observation: observation.id,
    parameters: code === "geo.earthquake" ? { magnitude: [r.range(1, 6).toFixed(1)] } : {},
  };
  const room = plan.reportBytes * r.range(0.7, 1.3) - JSON.stringify(base).length - 20;
  return room > 0 ? { ...base, description: textOf(r, room) } : base;
}

function areasOf(r: Random, shape: SeedShape): readonly Area[] {
  if (shape === "circle") return [{ type: "circle", center: [r.range(-179, 179), r.range(-60, 70)], radiusKm: r.range(5, 300) }];
  if (shape === "subject") return [];
  return Array.from({ length: r.int(1, 3) }, () => ({ type: "code" as const, system: "ugc", code: `ZZZ${String(r.int(1, SEED_FORECAST_ZONES)).padStart(3, "0")}` }));
}

function aboutOf(r: Random, shape: SeedShape, source: SourceId): readonly Subject[] {
  return shape === "subject" ? [{ system: "seed", id: `${source}:${String(r.int(1, 40))}` }] : [];
}

// The copy of a fetch with reports in the log of the second copy: its fetch of the same source a little later. The fetches
// of the second copy of one source keep their order, thus each has a new id.
function peerCopy(fetch: FetchEvent, r: Random, peerAt: Map<SourceId, Instant>): SharedFetchEvent {
  const { source } = fetch.record;
  const at = Math.max(fetch.record.at + r.int(1_000, 60_000), (peerAt.get(source) ?? 0) + 1);
  peerAt.set(source, at);
  const late = at - fetch.record.at;
  return {
    ...envelope("fetch", `fetch:${source}:${String(at)}`, fetch.time + late),
    reports: fetch.reports.map((report) => ({ ...report, received: report.received + late })),
  };
}
