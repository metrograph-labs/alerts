/**
 * This module holds one pass of the runtime. A pass fetches each source that is due and writes the
 * events of each fetch. Then it makes the view of the system, writes its system reports and tells the
 * time of the next pass. The loop of the service starts the passes. The runtime reads only the clock
 * that it gets.
 */
import { isFrameClock, type WallClock } from "@mark1russell7/algebra/clock";
import { bucketOf, channelDownPolicy, DEFAULT_SEND_LIMITS, downChannels, heldPersons, indicatorBreadth, indicatorSurprise, indicatorUnits, knowsReport, MIN_READS, limitShare, matchPlaces, observeConditions, ONLY_COPY, type PlaceId, type StalePlace, type StoreBound, type WatchedPlace, type ChannelQuota, type ChannelSnapshot, type CopyWatch, type DrillWatch, type Duration, type EntryTimes, type Exhaustion, type FetchOutcome, type HeldPerson, type Incident, type IndicatorBreadth, type IndicatorSurprise, type Instant, type LatenessFolds, type LoopBlock, type MergeState, type ObserveCondition, type Report, type ReportId, type SourceDescriptor, type SourceId, type StoreFill, type SourceProcedures, type Watch, type ZoneRegions, type JointDown, type DriftCheck } from "@mark1russell7/alerts";
import type { ChunkOptions, FoldMark, FoldSnapshot } from "@mark1russell7/sqlite";
import { errorMessage } from "@mark1russell7/text";
import { compareCodeUnits } from "@mark1russell7/text/order";
import type { BalanceWatch } from "./balance.ts";
import type { JointWatch } from "./joint.ts";
import type { DriftWatch } from "./drift.ts";
import type { LimitWatch } from "./use.ts";
import { channelWatch, lastFetchSuccess } from "./channel-watch.ts";
import { createDispatcher, type DeliveryOptions, type DeliveryStep } from "./delivery.ts";
import { drillStarts, drillStep, type CopyDrill } from "./drills.ts";
import { entryIndex } from "./entries.ts";
import { envelope, EVENT_TYPES, FOLD_TYPES, unknownEvents, type RuntimeEvent } from "./events.ts";
import { blockEvent } from "./loop-watch.ts";
import { importPage, sharePage, type ExchangePage, type ReceivedPage } from "./exchange.ts";
import { fetchStep } from "./fetch.ts";
import { openIncidents } from "./metrics.ts";
import { limited } from "./limit.ts";
import type { RuntimeLog } from "./log.ts";
import { cutIncidents, modeEvents, modeStatus, observeStep, type ModeStatus, type ObserveParts } from "./observe.ts";
import { READING_RETENTION, type ReadingStore } from "./readings.ts";
import { SNAPSHOT_MISSES, snapshotStep } from "./snapshot.ts";
import { FOLD_VERSION, readSnapshot, SNAPSHOT_UPGRADES, snapshotKey, snapshotRows, type StartRead, type StartSnapshot } from "./start-snapshot.ts";
import { retention, type RetentionOptions } from "./retention.ts";
import type { ReadWatch } from "./schedule.ts";
import { seriesReads } from "./series-reads.ts";
import { unitHistory } from "./unit-history.ts";
import { fold, foldScratch, rebuild, recordBatch, recordScratch, type ExchangeCursor, type RecordScratch, type RuntimeState } from "./state.ts";
import { earliest, nextFetch, systemEvent, systemView, type SystemView, type ViewConfig } from "./view.ts";

/** The parts of the worker of the exchange that a pass reads (AL-16). `exchangeWorker` gives them. */
export interface CopyChecks {
  /** This method gives the watch of each other copy at this time. Each stage of a watch is a line of system reports. */
  watches(): readonly CopyWatch[];
  /** This method moves the own times of the watches by the size of a step of the wall clock. */
  shift(size: Duration): void;
  /** This method resolves after the first read of each other copy, or after one time limit. The first view waits for it. */
  ready(): Promise<void>;
}

/** The options of `openRuntime`. */
export interface RuntimeOptions {
  readonly log: RuntimeLog;
  /**
   * The clock of the runtime, and the only clock that it reads. Its `now()` is the instant: the time in
   * milliseconds since the epoch. A test gives `fakeWallClock(start)` of `@mark1russell7/algebra/clock`.
   *
   * A clock of `frameClock` also gives each step of the wall clock against the monotonic clock. Then the start of each
   * pass writes the step to the log and moves each own instant by it. Thus each timer keeps its time on the monotonic clock.
   */
  readonly clock: WallClock;
  /** The adapters of the sources. Each adapter holds its transport, thus a test gives a transport with faults. */
  readonly sources: readonly SourceProcedures[];
  /**
   * This function gives the places and the kinds that each fetch of a source asks for. Give each source
   * only what it needs. The function `sourcePlaces` of the core gives a position only to a source that can have it.
   */
  readonly watch: (source: SourceDescriptor) => Watch;
  /** The configuration of the views, other than the descriptors of the sources. */
  readonly view: Omit<ViewConfig, "sources">;
  /**
   * This function gives the places of a pass at its start (AL-40): the fixed places, then each moving place at its last fix.
   * The default is the places of `view`. The coverage, the threats, the admission, the observe mode and the delivery of the
   * pass read them. The watch of each source and the log do not.
   */
  readonly places?: (at: Instant) => readonly WatchedPlace[];
  /** This function gives the stale moving places of this copy at the time of the view (AL-40). Each one is a private system report. */
  readonly stale?: (at: Instant) => readonly StalePlace[];
  /** The id of this run. Each start of the process has a new id. */
  readonly run: string;
  /** The id of this copy of the system (AL-16). The default is the id of `ONLY_COPY`. */
  readonly copy?: string;
  /** This function gives the longest time of one fetch of a source. The default is the interval of the source. */
  readonly fetchLimit?: (source: SourceDescriptor) => Duration;
  /**
   * The count of complete fetches in a row that miss a report of a snapshot source before its end. The
   * default is `SNAPSHOT_MISSES`.
   */
  readonly snapshotMisses?: number;
  /**
   * The bound of the count of the reports in the merge state (AL-145). The default is `REPORT_LIMIT`. At the bound, a fetch
   * keeps out each new observation of low priority (`keepsAtBound`), and the view has the line `system.store.full`.
   */
  readonly reportLimit?: number;
  /**
   * The retention of old incidents (AL-47). The fold retires on a cadence of the event time (AL-109), thus the retention goes
   * into the context of the fold, `config`. The defaults come from the core.
   */
  readonly retention?: RetentionOptions;
  /** The recipients and the channels. Without them, a pass sends nothing. */
  readonly delivery?: DeliveryOptions;
  /**
   * The runtime starts this function when work that ended after its pass needs a pass soon: a late send
   * with a delivery. The loop of the service gives its `wake()` here.
   */
  readonly wake?: () => void;
  /**
   * This function gives the quotas of the channels at the time of the view. Each stage of a quota is a
   * line of system reports. A throw keeps each open line of a quota as it is.
   */
  readonly quotas?: () => readonly ChannelQuota[];
  /**
   * This function gives the fills of the families of the stores at the time of the view (AL-86). Each family with no entry at
   * the end of its window is a line of system reports. A throw keeps each open line of a store as it is.
   */
  readonly stores?: () => readonly StoreFill[];
  /**
   * This function gives the blocks of the event loop of this runtime (AL-88). Each pass writes each new block into the log
   * before its view. The system report of the blocks reads the log. A throw writes no block.
   */
  readonly blocks?: () => readonly LoopBlock[];
  /**
   * The watches of the balances of the paid provider accounts. Each pass starts `check` of each watch, next to
   * its fetches. Each stage of a balance is a line of system reports.
   */
  readonly balances?: readonly BalanceWatch[];
  /**
   * The watches of the use of the hard limits of the paid provider accounts (AL-111). Each pass starts `check` of each
   * watch, next to its fetches. Each level of a use is a line of system reports.
   */
  readonly uses?: readonly LimitWatch[];
  /**
   * The watch of the joint down time of the copies (AL-148). Each pass starts its `check`, next to its fetches. Each stage
   * of the joint down time is a line of system reports. With no watch, each open line of the joint down time ends.
   */
  readonly joint?: JointWatch;
  /**
   * The drift watch of the copy hosts (AL-139). Each pass starts its `check`, and the check does not wait for the commands.
   * Each stage of a drift check is a line of system reports. With no watch, each open line of a drift ends.
   */
  readonly drift?: DriftWatch;
  /**
   * The other watches that read on a schedule: for example the watch of the replies of the texts. Each pass starts
   * `check` of each watch, next to its fetches. A step of the wall clock moves their times.
   */
  readonly reads?: readonly ReadWatch[];
  /**
   * The checks of the other copies. Each pass waits for `ready` before its view. Thus the first delivery step after a
   * start sees the sends of the other copies, and it does not repeat them.
   */
  readonly copies?: CopyChecks;
  /** The runtime starts this hook at the end of each pass with no error. The outside heartbeat goes here. */
  readonly onPass?: (pass: Pass) => void | Promise<void>;
  /**
   * The drills that this copy starts (`copyDrills`, AL-43). Each pass starts each due drill before its view. With no
   * drills, the view ends each open line of a drill of this copy.
   */
  readonly drills?: readonly CopyDrill[];
  /**
   * The drills that other copies start, in the watch of this copy (`watchedDrills`, AL-43). The watch reads the checks of
   * the copies. Without the checks, each open line of a watch stays open.
   */
  readonly drillWatches?: readonly DrillWatch[];
  /**
   * The store of the indicator readings. The runtime writes the readings of each fetch before its events. Without a store,
   * the runtime keeps no reading.
   */
  readonly readings?: ReadingStore;
  /** The age of the oldest reading that the store keeps. The default is `READING_RETENTION`. */
  readonly readingsKeep?: Duration;
  /**
   * The runtime gives each fault of the store of the readings to this hook. A fault does not stop the pass: the alerts do
   * not need the readings. The error can quote a value of a reading, thus the hook gives no value to an outside service.
   */
  readonly onReadingsFault?: (error: unknown, action: ReadingsAction) => void;
  /**
   * The runtime gives this hook the new reports of each fetch, after the write of the log (AL-132). The live metrics count
   * them. A failed write gives the hook nothing, thus the next fetch gives the reports again. A fault of the hook does not
   * stop the pass, because the alerts do not need the metrics.
   */
  readonly onReports?: (reports: readonly Report[]) => void;
  /**
   * The regions of the zones of the indicator areas, from a table of the atlas. The breadth of a place reads them. Without
   * the table, a series with the area of a zone is in the list `unplaced` of the breadth.
   */
  readonly zones?: readonly ZoneRegions[];
  /**
   * The store of the snapshot of the fold (AL-105). The open reads it. With a snapshot of the same key, the open folds only
   * the events after the mark of the snapshot. `writeStartSnapshot` writes it. Without the store, the open folds the whole log.
   */
  readonly startSnapshot?: FoldSnapshot;
}

/** The action of the store of the readings that gave a fault: a write, a delete or a read of the series. */
export type ReadingsAction = "add" | "prune" | "read";

/**
 * The default bound of the count of the reports in the merge state (AL-145). A report and its parts take approximately
 * 9 to 11 kB of the heap. The measure used the fake feeds of the testkit and 1 to 10 persons. A pass also makes one route of
 * approximately 1.2 kB for each live incident and each person. With 10 persons, 10,000 reports take approximately 230 MB
 * at the peak of a pass. That is less than half of the heap of a host with 1 GB of memory.
 */
export const REPORT_LIMIT = 10_000;

/** The store and the family of the bound of the reports in the line `system.store.full` (AL-145). */
export const STATE_STORE = "state";
export const REPORT_FAMILY = "reports";

/**
 * This function tells if a new report goes into a state at its bound (AL-145). An update or a cancel of an earlier report
 * goes in. A report for named persons goes in. A report with an area that covers a watched place (`matchPlaces`) goes in. Thus a
 * full state keeps out only the new reports of other areas: the reports that the delivery sends to no person.
 */
export function keepsAtBound(report: Report, places: readonly WatchedPlace[]): boolean {
  return report.references.length > 0 || (report.addresses?.length ?? 0) > 0 || matchPlaces(report, places).length > 0;
}

/** The result of one pass. */
export interface Pass {
  /** The time of the view. */
  readonly at: Instant;
  /** The sources that the pass fetched, in the order of the configuration. */
  readonly fetched: readonly SourceId[];
  readonly view: SystemView;
  /** The delivery step of the pass, when the runtime has a delivery. */
  readonly delivery?: DeliveryStep;
  /**
   * The time of the next pass: the next fetch of a source, the next timer of a fold or the next time of the delivery.
   * It is after `at`. A source that came due during the pass gives `at + 1`, thus the next pass starts at once and fetches it.
   */
  readonly wakeAt?: Instant;
  /** The ids of the events that are different from the events of the log with the same ids. The log kept its events. */
  readonly conflicts: readonly string[];
  /**
   * The size of the step of the wall clock that the start of the pass wrote. A hook with times in memory moves them by
   * this size, as the runtime moves its own times.
   */
  readonly stepped?: Duration;
  /**
   * The breadth of the indicator signals at `at`, in the world and in each watched place (AL-59). It is present when the
   * runtime has a store of the readings and the read of the store passed. It gives counts and no decision.
   */
  readonly breadth?: IndicatorBreadth;
  /**
   * The surprise of the indicator signals at `at`, in the world and in each watched place (AL-24). The base rate of each
   * unit comes from the hours before the hour of `at`. It is present when the breadth is present and the read of the
   * history passed. It gives no decision.
   */
  readonly surprise?: IndicatorSurprise;
  /** The mode of each source with a mode (AL-73), with the verdict of each source that observes. It has no person. */
  readonly modes?: readonly ModeStatus[];
}

/**
 * The part of a pass that a reader keeps after the pass ends (AL-145). It has the routes of the delivery step only as a
 * count: `open`. The routes are one for each live incident and each person, thus a kept list of them grows with the
 * product of the two. The next pass makes its routes again from the state.
 */
export interface KeptPass extends Omit<Pass, "delivery"> {
  /** The delivery step of the pass with no routes, when the runtime has a delivery. */
  readonly delivery?: Omit<DeliveryStep, "routes">;
  /** The count of the open incidents of the routes of the pass (`openIncidents`). It is 0 with no delivery. */
  readonly open: number;
}

/** This function gives the part of a pass that a reader keeps (`KeptPass`). It does not change the pass. */
export function keptPass(pass: Pass): KeptPass {
  const { delivery, ...rest } = pass;
  if (delivery === undefined) return { ...rest, open: 0 };
  const { routes, ...step } = delivery;
  return { ...rest, delivery: step, open: openIncidents(routes) };
}

/** The result of `take`: the import of one page of another copy. */
export interface PageTake {
  /** The count of the imports of the page. An import that the log has already changes nothing. */
  readonly imports: number;
  /** The position of the next read of the copy. */
  readonly next: number;
  /** The problems of the page, with no value of an event. */
  readonly problems: readonly string[];
  /**
   * The ids of the imports with the id of a different event of the log. The log kept its event: a step of the ledger
   * that this copy also did.
   */
  readonly conflicts: readonly string[];
}

/** The runtime: its state and its pass. */
export interface Runtime {
  /** The configuration of the views, with the descriptor of each source. */
  readonly config: ViewConfig;
  /** This function gives the state: the fold of the log. */
  state(): RuntimeState;
  /**
   * The count of the events of the log at the open with a type that this build does not know. The fold skips them.
   * A later build wrote them, thus a count above 0 tells of a rollback.
   */
  readonly skipped: number;
  /** The read of the log at the open: the snapshot that it read, and the count of the events that it folded (AL-105). */
  readonly start: StartRead;
  /**
   * This function writes the snapshot of the state and of the entry index at the last event of the log (AL-105). It gives
   * the count of the rows. It takes the state, the index and the mark in one turn of the event loop. Then it writes the rows
   * in short transactions with pauses (AL-115), thus a large snapshot does not block the loop. Events after the mark go to
   * the log in the pauses, and the snapshot does not have them. The options `chunks` set the size of each transaction and
   * the pause, as in `writeInChunks` of `@mark1russell7/sqlite`.
   *
   * The promise rejects when the runtime has no store, when the runtime is closed, when a write is in progress, or when
   * the write fails. Then the old snapshot stays. The close of the runtime waits for a write in progress.
   */
  writeStartSnapshot(chunks?: ChunkOptions): Promise<number>;
  /**
   * This function gives the count of the events of the log after the mark of the last snapshot that this runtime read or
   * wrote (AL-115). With no such snapshot, it gives the position of the last event of the log.
   */
  eventsAfterSnapshot(): number;
  /**
   * This function does one pass. It throws when a write to the log fails. Then the state is the state of
   * the log, and the next pass does the work again.
   *
   * The signal `stop` aborts each fetch of the pass. A fetch that fails after the abort writes nothing to the
   * log: the stop is not a fault of the source. The delivery step does not read the signal. Each of its calls
   * ends at its own time limit.
   */
  pass(stop?: AbortSignal): Promise<Pass>;
  /** This function gives the page of the shared events of the log after a position (AL-16). */
  share(after: number, limit?: number): ExchangePage;
  /** This function gives the position after which the next read of another copy starts. */
  position(copy: string): number;
  /**
   * This function adds the shared events of a page of another copy to the log, as events `import`. It throws when the
   * write fails. Then the position stays, and the next read gets the page again.
   */
  take(page: ReceivedPage): PageTake;
  /**
   * This function gives the times of entry of the parts of the state on this copy (AL-18). An import gets the time of the
   * read that brought it, not the time of the other copy. The history route reads them.
   */
  entered(): EntryTimes;
  /**
   * This function gives the channels of this copy at the time of the call (AL-65). Each channel has its run of failed calls
   * and its last good call. A runtime with no delivery has no channel. The health route reads them.
   */
  channels(): ChannelSnapshot[];
  /**
   * This function ends the resources of the sources: it starts `close` of each source that has one, one time. A second
   * call gives the same promise. It does not throw. A pass after the close throws.
   */
  close(): Promise<void>;
}

/**
 * This function opens the runtime on a log. It rebuilds the state from the events of the log, and then
 * it writes the start of this run.
 */
export function openRuntime(options: RuntimeOptions): Runtime {
  const { clock, log } = options;
  const frame = isFrameClock(clock) ? clock : undefined;
  // The fold retires on a cadence of the event time (AL-109). Thus the retention is a part of the context of the fold.
  const config: ViewConfig = { ...options.view, sources: options.sources.map((source) => source.describe()), retention: options.retention ?? {} };
  const ids = config.sources.map((source) => source.id);
  // A set finds a repeated id in O(n) (AL-136).
  const known = new Set<string>();
  const repeated = ids.find((id) => {
    if (known.has(id)) return true;
    known.add(id);
    return false;
  });
  if (repeated !== undefined) throw new Error(`Two sources have the id ${repeated}.`);

  // The index of the times of entry is a fold of the same events as the state. The start reads only the types of the fold
  // (AL-102): an observation changes neither. The counts of each type give the events of the types that this build does
  // not know, with no parse. The index drops the stamps of the gone reports at each retirement, as the append does.
  // With a snapshot of the same key, the index and the state start at its mark, and the open folds only the events after it (AL-105).
  const counts = log.counts();
  const resumed = readStart(options.startSnapshot, log, config, counts);
  const entries = entryIndex(resumed.snapshot?.entries);
  let folded = 0;
  let state = rebuild(
    counted(resumed.mark === undefined ? log.read(FOLD_TYPES) : log.read(FOLD_TYPES, resumed.mark.seq), (event) => {
      folded += 1;
      entries.add(event);
    }),
    config,
    (merge) => entries.prune(merge),
    resumed.snapshot?.state,
  );
  const skipped = unknownEvents(counts);
  const start: StartRead = { events: folded, ...(resumed.mark === undefined ? {} : { snapshot: resumed.mark }), ...(resumed.fault === undefined ? {} : { fault: resumed.fault }), ...(resumed.upgraded === undefined ? {} : { upgraded: resumed.upgraded }) };

  // The fold runs on a draft before each write. The state changes only when the transaction commits.
  // The new reports of the fetch events that the log accepted go to the hook of the metrics. A report is new when the own
  // merge did not know its id before the write. A feed that gives a report again in a new observation adds no count.
  const reported = (accepted: readonly RuntimeEvent[], before: MergeState): void => {
    if (options.onReports === undefined) return;
    const seen = new Set<string>();
    const reports = accepted
      .flatMap((event) => (event.type === "fetch" ? event.reports : []))
      .filter((report) => !seen.has(report.id) && !knowsReport(before, report.id) && Boolean(seen.add(report.id)));
    if (reports.length === 0) return;
    try {
      options.onReports(reports);
    } catch {
      // A fault of the metrics does not stop the pass.
    }
  };
  // The record scratch of the fetches of the pass in progress (AL-136). Without a pass, each batch has its own record scratch.
  // RULE: a reader that keeps a state across a pause ends this scope first (`writeStartSnapshot`). Thus no fold changes a record of the kept state.
  let passRecords: RecordScratch | undefined;
  const append = (events: readonly RuntimeEvent[], kept?: (accepted: readonly RuntimeEvent[], before: MergeState) => void): readonly string[] => {
    const before = state.own.merge;
    let draft = state;
    // Only the last state of the batch becomes the state. Thus the folds of the batch grow its lists in place (AL-150).
    const scratch = foldScratch();
    const records = passRecords ?? recordScratch();
    const accepted: RuntimeEvent[] = [];
    // The merge state after each retirement of the fold, with the position of its event.
    const retirements: { readonly at: number; readonly merge: Pick<MergeState, "reports"> }[] = [];
    // A failed write puts back each record that the batch changed in place. Thus the state stays as it was.
    const conflicts = recordBatch(records, () =>
      log.appendAll(events, (event) => {
        draft = fold(draft, event, config, (merge) => retirements.push({ at: accepted.length, merge }), scratch, records);
        accepted.push(event);
      }),
    );
    state = draft;
    // The index gets the events only after the write. Thus a failed write, and the write again, move no stamp two times.
    // The rebuild gives the index each event before its fold, thus each prune comes after the event of its retirement.
    let next = 0;
    accepted.forEach((event, at) => {
      entries.add(event);
      for (; next < retirements.length && retirements[next]!.at === at; next += 1) entries.prune(retirements[next]!.merge);
    });
    kept?.(accepted, before);
    return conflicts;
  };

  append([{ ...envelope("started", `started:${options.run}`, clock.now()), run: options.run }]);

  // The id of this copy and of its log: the id of the first event. A new log has a new first event. The salvage of a
  // broken file gives new positions, thus a recovered log has the id of its last recovery.
  const self = options.copy ?? ONLY_COPY.id;
  const recovery = state.recoveries.at(-1);
  const logId = recovery === undefined ? (firstEventId(log) ?? `started:${options.run}`) : `recovered:${recovery.quarantine}`;
  // The position of the next read of each other copy. It starts at the position of the log, and it moves at each page.
  const positions = new Map<string, ExchangeCursor>();
  // The places of the pass in progress (AL-40). Each pass reads them at its start. Thus each part of one pass reads the same places.
  let places: readonly WatchedPlace[] = config.places;
  const fixedIds = new Set<PlaceId>(config.places.map((place) => place.id));

  const copies = options.copies;
  // The parts of the observe mode of the new sources (AL-73). With no delivery, no person watches. Thus each verdict passes after its window.
  const observeParts: ObserveParts = {
    people: options.delivery?.recipients.map((recipient) => recipient.watch) ?? [],
    get places() {
      return places;
    },
    assess: options.delivery?.assess,
    limits: options.delivery?.sendLimits,
    ...(copies === undefined ? {} : { share: (at: Instant) => limitShare(copies.watches(), at) }),
  };
  // The window of the send limit (AL-72). The holds in it give the notice of the send limit to each person (AL-81).
  const holdWindow = (options.delivery?.sendLimits ?? DEFAULT_SEND_LIMITS).window;
  const heldOf = (at: Instant): readonly HeldPerson[] => heldPersons(state.holds, state.merge.reports, holdWindow, at);
  const personsOf = (list: readonly HeldPerson[]): string => JSON.stringify(list.map((entry) => entry.person));
  // The life-safety incidents of observing sources only that the last cut sent, in memory only.
  let lifeSafety: readonly Incident[] = [];
  const dispatcher = options.delivery === undefined ? undefined : createDispatcher(options.delivery, {
          clock,
          run: options.run,
          get places() {
            return places;
          },
          // A place of the pass that is not a fixed place of the view is a moving place (AL-40). It gets the holds of the route.
          ...(options.places === undefined ? {} : { moving: (id: PlaceId) => !fixedIds.has(id) }),
          link: config.link,
          state: () => state,
          append,
          wake: options.wake,
          // The share of the send limit (AL-72): a copy that does not read another copy takes a part of the limit.
          ...(copies === undefined ? {} : { share: (at: Instant) => limitShare(copies.watches(), at) }),
          // The observe mode of the new sources (AL-73). The life-safety incidents that it sends go into the view of the next pass.
          cut: (found: readonly Incident[], at: Instant) => {
            const cut = cutIncidents(state, state.merge, found, observeParts, at);
            lifeSafety = cut.lifeSafety;
            return cut.sent;
          },
        });

  // The folds of the lateness of the last view, in memory only. A pass folds only the new checks. A restart folds each check again, with the same result.
  let folds: LatenessFolds | undefined;
  // The exhausted escalations of the last delivery step, in memory only (AL-21). A restart keeps each open line until its first delivery step.
  let exhausted: readonly Exhaustion[] | undefined;
  // The conditions of the observe mode of the last pass, in memory only (AL-73). A restart keeps each open line until its first pass.
  let observing: readonly ObserveCondition[] | undefined;
  // The runs of failed calls of the channels of this copy, and the probes of its down channels, in memory only (AL-65).
  // A restart empties the runs, and each open line stays until a good call.
  const channels = options.delivery === undefined ? undefined : channelWatch({ copy: self, channels: options.delivery.channels, policy: channelDownPolicy(config.channelDown), clock, callLimit: options.delivery.callLimit });

  // The misses of the reports of each snapshot source, in memory only. A restart starts them at 0.
  const misses = new Map<SourceId, ReadonlyMap<ReportId, number>>();
  // The interval of the retirements of the fold. The old readings go at most once in each interval.
  const kept = retention(options.retention);

  // The store of the readings. A fault goes to the hook, and the pass continues.
  const store = options.readings;
  const keep = options.readingsKeep ?? READING_RETENTION;
  if (!Number.isFinite(keep) || keep <= 0) throw new Error(`The age of the oldest reading is ${keep}, not a finite number above 0.`);
  let pruned: Instant | undefined;
  const guarded = <T>(action: ReadingsAction, work: (store: ReadingStore) => T): T | undefined => {
    if (store === undefined) return undefined;
    try {
      return work(store);
    } catch (error) {
      options.onReadingsFault?.(error, action);
      return undefined;
    }
  };
  // The reads of the indicator series between the passes. A pass reads from the store only the changed series.
  const indicatorReads = store === undefined ? undefined : seriesReads({ store, sources: config.sources });
  // The history of the signal units (AL-24): one read of each unit in each hour, in the store of the readings.
  const unitReads = store === undefined ? undefined : unitHistory(store);
  const zones = options.zones ?? [];

  const limit = options.snapshotMisses ?? SNAPSHOT_MISSES;
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`The count of snapshot misses is ${limit}, not an integer of 1 or more.`);
  const reportLimit = options.reportLimit ?? REPORT_LIMIT;
  if (!Number.isInteger(reportLimit) || reportLimit < 1) throw new Error(`The bound of the reports is ${reportLimit}, not an integer of 1 or more.`);
  // The count of the new observations of each source that wait outside the log at its last fetch that passed (AL-145).
  const waiting = new Map<SourceId, number>();
  // The admission of one fetch. It counts the reports of the state and the reports that the fetch took before. An
  // observation with no report adds no entry to the bound, thus it always goes in: its readings, its head and the cursor of
  // its source do not wait (AL-171).
  const admission = (): ((reports: readonly Report[]) => boolean) => {
    let count = state.merge.reports.length;
    return (reports) => {
      if (reports.length === 0) return true;
      if (count + reports.length > reportLimit && !reports.some((report) => keepsAtBound(report, places))) return false;
      count += reports.length;
      return true;
    };
  };
  const readBounds = (): StoreBound[] => {
    const sources = [...waiting].filter(([, count]) => count > 0).map(([source]) => source);
    const count = sources.reduce((sum, source) => sum + (waiting.get(source) ?? 0), 0);
    return [{ store: STATE_STORE, family: REPORT_FAMILY, entries: state.merge.reports.length, limit: reportLimit, waiting: count, sources: sources.sort(compareCodeUnits) }];
  };

  const fetchOne = async (source: SourceProcedures, descriptor: SourceDescriptor, stop: AbortSignal | undefined): Promise<readonly string[]> => {
    const started = clock.now();
    const cursor = state.cursors[descriptor.id];
    // Each fetch has its own signal. It aborts at the stop of the runtime, and at the end of the fetch: its
    // outcome or its time limit. Thus no request of a fetch waits behind the park of its host and goes later.
    const own = new AbortController();
    let stopped = false;
    const onStop = (): void => {
      stopped = true;
      own.abort(stop?.reason);
    };
    if (stop?.aborted === true) onStop();
    else stop?.addEventListener("abort", onStop, { once: true });
    // A fetch that throws at once is a failure of its source too, not a failure of the pass.
    const work = Promise.resolve().then(() => source.fetch({ watch: options.watch(descriptor), ...(cursor === undefined ? {} : { cursor }) }, own.signal));
    const outcome = await bounded(work, options.fetchLimit?.(descriptor) ?? descriptor.interval, clock);
    stop?.removeEventListener("abort", onStop);
    own.abort(new Error(`The fetch of ${descriptor.id} ended.`));
    // A failure after the stop is the stop, not a fault of the source. The log keeps no fetch, and the cursor stays.
    if (stopped && !outcome.ok) return [];
    const ended = clock.now();
    const fetched = fetchStep({ source: descriptor.id, descriptor, procedures: source, started, ended, outcome, known: (id) => log.has(id), frame: state.steps.length, admit: admission() });
    if (outcome.ok) waiting.set(descriptor.id, fetched.waiting);
    // The readings go first. A failed write of the log leaves the observations new, thus the next fetch gives their readings
    // again, and the store keeps each key once.
    if (fetched.readings.length > 0) {
      guarded("add", (readings) => readings.add(fetched.readings));
      indicatorReads?.note(fetched.readings);
    }
    const conflicts = append(fetched.events, reported);
    if (descriptor.listing !== "snapshot") return conflicts;
    // The step reads the merge state after the fetch, thus a new report of the fetch has no miss. It reads only the own
    // merge state: a report that only another copy sees does not end or come back in this copy.
    const step = snapshotStep({ source: descriptor.id, started, ended, outcome, merge: state.own.merge, misses: misses.get(descriptor.id) ?? new Map(), limit, frame: state.steps.length });
    const more = append(step.events);
    // The counts change only after the write. A failed write leaves the old counts, thus the end comes later.
    misses.set(descriptor.id, step.misses);
    return [...conflicts, ...more];
  };

  const watches = options.balances ?? [];
  const providers = watches.map((watch) => watch.provider);
  if (new Set(providers).size !== providers.length) throw new Error("Two balance watches have the same provider. Give one watch to each account.");
  // Each watch that reads on a schedule: the balance watches and the other reads.
  const uses = options.uses ?? [];
  if (new Set(uses.map((watch) => watch.id)).size !== uses.length) throw new Error("Two watches of a limit have the same id. Give one watch to each limit.");
  const scheduled: readonly ReadWatch[] = [...watches, ...uses, ...(options.joint === undefined ? [] : [options.joint]), ...(options.drift === undefined ? [] : [options.drift]), ...(options.reads ?? [])];

  // A fault of the store of a gate ends no line of a quota. The notes of the heartbeat tell of the fault.
  const readQuotas = (): readonly ChannelQuota[] | undefined => {
    if (options.quotas === undefined) return [];
    try {
      return options.quotas();
    } catch {
      return undefined;
    }
  };

  // A fault of the read of the blocks writes no block. The blocks of the log keep their line.
  const readBlocks = (): readonly LoopBlock[] => {
    if (options.blocks === undefined) return [];
    try {
      return options.blocks();
    } catch {
      return [];
    }
  };

  // A fault of the read of a store ends no line of a store.
  const readStores = (): readonly StoreFill[] | undefined => {
    if (options.stores === undefined) return [];
    try {
      return options.stores();
    } catch {
      return undefined;
    }
  };

  // A step of the wall clock since the last mark moves each own instant: the fold of the clock event moves the state,
  // and then the dispatcher, the balance watches and the copy watches move their times in memory. The mark comes after the write. Thus
  // a failed write leaves the step to the next pass, and the next pass writes it with the same id.
  const followStep = (): { readonly size: Duration; readonly conflicts: readonly string[] } => {
    if (frame === undefined) return { size: 0, conflicts: [] };
    const size = frame.step();
    if (size === 0) {
      frame.mark();
      return { size, conflicts: [] };
    }
    const conflicts = append([{ ...envelope("clock", `clock:${state.steps.length + 1}`, clock.now() + size), size }]);
    dispatcher?.shift(size);
    for (const watch of scheduled) watch.shift(size);
    options.copies?.shift(size);
    frame.mark();
    return { size, conflicts };
  };

  // The close of the sources, one time. A source that throws in its close does not stop the close of the other sources.
  let closed: Promise<void> | undefined;
  // The mark of the last snapshot that this runtime read or wrote, and the write of the snapshot in progress (AL-115).
  let snapshotMark: FoldMark | undefined = resumed.mark;
  let snapshotWrite: Promise<number> | undefined;
  // The close waits for a write of the snapshot in progress. Thus the entry closes the store of the snapshot after the write.
  const close = (): Promise<void> =>
    (closed ??= Promise.allSettled([...options.sources.map((source) => Promise.resolve().then(() => source.close?.())), snapshotWrite]).then(() => undefined));

  return {
    config,
    state: () => state,
    skipped,
    start,
    async writeStartSnapshot(chunks) {
      const store = options.startSnapshot;
      if (store === undefined) throw new Error("The runtime has no store of the snapshot.");
      // After the close, the entry closes the store of the snapshot. Thus a write that starts then has no store.
      if (closed !== undefined) throw new Error("The runtime is closed: it writes no snapshot.");
      if (snapshotWrite !== undefined) throw new Error("A write of the snapshot is in progress.");
      // The mark is the last event of the log. Each write of the log goes through `append`, thus the state has each event up to it.
      const head = log.head();
      const last = [...log.entries({ after: head - 1, types: EVENT_TYPES, limit: 1 })][0];
      const first = firstEventId(log);
      if (last === undefined || last.seq !== head || first === undefined) throw new Error("The last event of the log has a type that this build does not know.");
      const key = snapshotKey(config, { first, recoveries: log.counts().get("recovered") ?? 0 });
      // The cut: the mark, the state and a copy of the index, in this turn of the loop. A fold gives a new state and does not
      // change the state before it, thus the rows of the cut do not change in the pauses of the write. The folds of a pass
      // change the records of each source of the last state in place (AL-136). Thus the cut ends the record scratch of the
      // pass: the next fold copies each record one time, and the records of the cut do not change.
      if (passRecords !== undefined) passRecords = recordScratch();
      const mark: FoldMark = { seq: head, id: last.event.id };
      const cut = { state, entries: entries.snapshot() };
      const write = store.writeInChunks(key, mark, snapshotRows(cut), chunks);
      snapshotWrite = write;
      try {
        const count = await write;
        snapshotMark = mark;
        return count;
      } finally {
        snapshotWrite = undefined;
      }
    },
    eventsAfterSnapshot: () => log.head() - (snapshotMark?.seq ?? 0),
    async pass(stop) {
      if (closed !== undefined) throw new Error("The runtime is closed: its sources have no session.");
      const stepped = followStep();
      const start = clock.now();
      places = options.places?.(start) ?? config.places;
      const due = options.sources.flatMap((source, at) => {
        const descriptor = config.sources[at]!;
        return nextFetch(state, descriptor) <= start ? [{ source, descriptor }] : [];
      });
      // A watch reads only when it is due, and its check does not throw. It runs next to the fetches.
      const checks = Promise.all(scheduled.map((watch) => watch.check(clock, stop)));
      // The probes of the down channels run next to the fetches. A probe does not throw, and it ends at the call limit.
      const probes = channels?.probe(start, lastFetchSuccess(state.health));
      // Each fetch ends before the pass ends, also when one of them fails. Thus no fetch of a pass runs on in the next pass.
      // The fetches of the pass share one record scratch (AL-136). Thus n fetches of n sources copy each record of the sources one time, not n times.
      passRecords = recordScratch();
      let settled: PromiseSettledResult<readonly string[]>[];
      try {
        settled = await Promise.allSettled(due.map(({ source, descriptor }) => fetchOne(source, descriptor, stop)));
      } finally {
        passRecords = undefined;
      }
      await checks;
      await probes;
      await options.copies?.ready();
      const failed = settled.find((result) => result.status === "rejected");
      if (failed !== undefined) throw failed.reason;
      const conflicts = [...stepped.conflicts, ...settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []))];

      const at = clock.now();
      // The breadth of the indicator signals at the time of the view. A fault of the store gives no breadth, and the pass continues.
      const signals = indicatorReads === undefined ? undefined : guarded("read", () => indicatorReads.signals(at));
      const breadth = signals === undefined ? undefined : indicatorBreadth(signals, places, zones);
      // The surprise reads the history of the hours before this hour. Then the first pass of the hour writes its units.
      // A fault of the store gives no surprise or no write, and the pass continues.
      const surprise = breadth === undefined || unitReads === undefined ? undefined : guarded("read", () => indicatorSurprise(breadth, unitReads.histories(bucketOf(at)), MIN_READS, unitReads.pairs(bucketOf(at))));
      if (breadth !== undefined) guarded("add", () => unitReads?.record(at, indicatorUnits(breadth)));
      // Each due drill starts before the view. Thus the system fold of the view gives its run, and the delivery step sends it.
      const drills = options.drills ?? [];
      const started = drillStarts(state, drills, self, at);
      if (started.length > 0) conflicts.push(...append(started));
      const drilled = drillStep(state, drills, self, at);
      // Each source with no mode gets its mode before the view (AL-73). The first start seeds the modes, and a later new source observes.
      const modes = modeEvents(state, config.sources, at);
      if (modes.length > 0) conflicts.push(...append(modes));
      // Each new block of the event loop goes into the log before the view (AL-88). A block that the log has changes nothing.
      const blocks = readBlocks().map((block) => blockEvent(block, options.run)).filter((event) => !log.has(event.id));
      if (blocks.length > 0) conflicts.push(...append(blocks));
      const quotas = readQuotas();
      const stores = readStores();
      // The persons with a hold of the send limit (AL-81). With no delivery, no person has a hold, and each open line stays.
      const held = dispatcher === undefined ? undefined : heldOf(at);
      const stale = options.stale?.(at);
      const view = systemView(state, places === config.places ? config : { ...config, places }, at, { ...(stale === undefined ? {} : { stale }), drills: drilled.snapshots, ...(quotas === undefined ? {} : { quotas }), ...(stores === undefined ? {} : { stores }), bounds: readBounds(), balances: watches.flatMap((watch) => watch.balance() ?? []), uses: uses.flatMap((watch) => watch.use() ?? []), ...jointPart(options.joint), ...driftPart(options.drift), ...(options.copies === undefined ? {} : { copies: options.copies.watches(), copy: self, drillWatches: options.drillWatches ?? [] }), ...(folds === undefined ? {} : { folds }), ...(exhausted === undefined ? {} : { exhausted }), ...(held === undefined ? {} : { held }), ...(channels === undefined ? {} : { channels: channels.snapshots() }), ...(observing === undefined ? {} : { observing }) });
      folds = view.folds;
      const event = systemEvent(view);
      if (event !== undefined) conflicts.push(...append([event]));
      // The verdict of each source that observes. A source that passes goes live before the delivery step.
      const observed = observeStep(state, view.incidents, observeParts, at);
      if (observed.events.length > 0) conflicts.push(...append(observed.events));

      // The system reports of this pass are incidents too, thus the delivery comes after their write.
      const delivery = await dispatcher?.step(at);
      if (delivery !== undefined) conflicts.push(...delivery.conflicts);
      // A new or an ended exhaustion goes into the view of the next pass. Thus that pass comes at once, not at the next fetch.
      // A missing list is an empty list. After a restart, the second pass gives the list, and it can end an open line.
      const changed = delivery !== undefined && JSON.stringify(delivery.exhausted) !== JSON.stringify(exhausted ?? []);
      if (delivery !== undefined) exhausted = delivery.exhausted;
      // A new person with a hold goes into the view of the next pass. Thus that pass comes at once, and the person gets the notice.
      const heldChanged = held !== undefined && delivery !== undefined && personsOf(heldOf(clock.now())) !== personsOf(held);
      // A run that starts to open a line, or an accepted send on a down channel, changes a line in the view of the next pass.
      const down = delivery !== undefined && channels !== undefined && channels.step(delivery, clock.now(), downChannels(state.lines, self), lastFetchSuccess(state.health));
      // The conditions of the observe mode go into the view of the next pass. A new condition brings that pass at once. A new
      // reason with the same facts does not, because the system reports keep no reason as a fact.
      const since = new Map(Object.entries(state.modes).flatMap(([source, track]) => (track.since === undefined ? [] : [[source as SourceId, track.since] as const])));
      const conditions = observeConditions(observed.verdicts, delivery === undefined ? [] : lifeSafety, state.merge, since);
      const factsOf = (list: readonly ObserveCondition[] | undefined): string => JSON.stringify((list ?? []).map((entry) => [entry.source, entry.state, entry.incidents]));
      const observeChanged = factsOf(conditions) !== factsOf(observing);
      observing = conditions;
      // The end of the observed time of a source is a timer: its verdict can pass then.
      const observeEnds = observed.verdicts.map((verdict) => verdict.since + verdict.window).filter((time) => time > at);

      // The old readings go at most once in each interval of the retirements.
      if (store !== undefined && (pruned === undefined || at - pruned >= kept.every)) {
        pruned = at;
        guarded("prune", (readings) => {
          readings.prune(at - keep);
          indicatorReads?.pruned(at - keep);
          unitReads?.pruned(at - keep);
        });
      }

      // A source, a balance watch or a probe of a down channel can come due after `start`, while the fetches of the pass
      // run. A fetch that runs to its limit of one interval also ends at its next fetch. Such work is due, not a fault:
      // its wake is the first instant after the pass.
      const nextWork = earliest([...config.sources.map((descriptor) => nextFetch(state, descriptor)), ...scheduled.map((watch) => watch.nextReadAt()), channels?.wakeAt()]);
      const wakeAt = earliest([nextWork === undefined ? undefined : Math.max(nextWork, at + 1), view.wakeAt, delivery?.wakeAt, drilled.wakeAt, ...observeEnds, changed || down || observeChanged || heldChanged ? at + 1 : undefined]);
      const pass: Pass = {
        at,
        fetched: due.map(({ descriptor }) => descriptor.id),
        view,
        conflicts,
        ...(stepped.size === 0 ? {} : { stepped: stepped.size }),
        ...(delivery === undefined ? {} : { delivery }),
        ...(wakeAt === undefined ? {} : { wakeAt }),
        ...(breadth === undefined ? {} : { breadth }),
        ...(surprise === undefined ? {} : { surprise }),
        modes: modeStatus(state, observed.verdicts),
      };
      await options.onPass?.(pass);
      return pass;
    },
    share: (after, limit) => sharePage(log, { copy: self, log: logId }, after, limit),
    position: (copy) => (positions.get(copy) ?? state.exchanges[copy])?.next ?? 0,
    take(page) {
      const logged = state.exchanges[page.copy];
      const result = importPage(page, { self, position: positions.get(page.copy) ?? logged, logged, now: clock.now() });
      const conflicts = result.events.length === 0 ? [] : append(result.events);
      positions.set(page.copy, result.position);
      return { imports: result.imports, next: result.position.next, problems: result.problems, conflicts };
    },
    entered: () => entries.times(state.own.merge),
    channels: () => channels?.snapshots() ?? [],
    close,
  };
}

// True when the log has an event of one of the types at or before the position. The counts of the log skip the read of a type with no event.
function newEventsUpTo(log: RuntimeLog, counts: ReadonlyMap<string, number>, types: readonly RuntimeEvent["type"][], seq: number): boolean {
  const present = types.filter((type) => (counts.get(type) ?? 0) > 0);
  if (present.length === 0) return false;
  const first = [...log.entries({ after: 0, types: present, limit: 1 })][0];
  return first !== undefined && first.seq <= seq;
}

// The id of the first event of the log of a type that this build knows, or undefined for an empty log.
function firstEventId(log: RuntimeLog): string | undefined {
  return [...log.entries({ after: 0, types: EVENT_TYPES, limit: 1 })][0]?.event.id;
}

/** The snapshot of the start and its mark, or the fault of its read. With no snapshot, the open folds the whole log. */
interface StartResume {
  readonly snapshot?: StartSnapshot;
  readonly mark?: FoldMark;
  readonly fault?: string;
  readonly upgraded?: number;
}

// The snapshot of a store for the open of a log (AL-105). A snapshot of another key, of another log or of a broken file is not used.
// With no snapshot of the fold, a snapshot of an old fold with an upgrade is used (AL-153).
function readStart(store: FoldSnapshot | undefined, log: RuntimeLog, config: ViewConfig, counts: ReadonlyMap<string, number>): StartResume {
  if (store === undefined) return {};
  const first = firstEventId(log);
  if (first === undefined) return {};
  try {
    const snapshotLog = { first, recoveries: counts.get("recovered") ?? 0 };
    const key = snapshotKey(config, snapshotLog);
    const current = store.read(key, log, (mark, rows) => ({ mark, snapshot: readSnapshot(rows) }));
    if (current !== undefined) return current;
    for (const [version, upgrade] of Object.entries(SNAPSHOT_UPGRADES)) {
      const from = Number(version);
      if (from === FOLD_VERSION) continue;
      const old = store.read({ ...key, version: from }, log, (mark, rows) => ({ mark, snapshot: readSnapshot(rows) }));
      if (old !== undefined && !newEventsUpTo(log, counts, upgrade.since, old.mark.seq)) return { mark: old.mark, snapshot: upgrade.upgrade(old.snapshot), upgraded: from };
    }
    return {};
  } catch (error) {
    return { fault: error instanceof Error ? error.name : typeof error };
  }
}

/**
 * This function gives the outcome of a fetch, or a timeout when the fetch takes longer than its limit.
 * A fetch that throws is a fault of the adapter. Its outcome is a failure, and the health records it.
 * This function does not stop the fetch. The runtime aborts the signal of the fetch after this outcome.
 */
export function bounded(work: Promise<FetchOutcome>, limit: Duration, clock: WallClock): Promise<FetchOutcome> {
  return limited<FetchOutcome>(
    work,
    limit,
    clock,
    () => ({ ok: false, failure: { kind: "timeout", message: `The fetch took longer than ${limit} ms.` } }),
    (error) => ({ ok: false, failure: { kind: "network", message: `The fetch threw: ${errorMessage(error)}` } }),
  );
}

// The events of a log, with a call for each event.
function* counted<T>(events: Iterable<T>, each: (event: T) => void): Generator<T> {
  for (const event of events) {
    each(event);
    yield event;
  }
}

// The joint down time in the view: `null` with no watch, thus each open line ends. Before the first check, no field keeps each open line.
function jointPart(watch: JointWatch | undefined): { readonly joint?: JointDown | null } {
  if (watch === undefined) return { joint: null };
  const joint = watch.joint();
  return joint === undefined ? {} : { joint };
}

// The drift checks in the view: `null` with no watch, thus each open line ends. Before the first check, no field keeps each open line.
function driftPart(watch: DriftWatch | undefined): { readonly drift?: readonly DriftCheck[] | null } {
  if (watch === undefined) return { drift: null };
  const drift = watch.drift();
  return drift === undefined ? {} : { drift };
}
