/**
 * This module holds one pass of the runtime. A pass fetches each source that is due and writes the
 * events of each fetch. Then it makes the view of the system, writes its system reports and tells the
 * time of the next pass. The loop of the service starts the passes. The runtime reads only the clock
 * that it gets.
 */
import { isFrameClock, type WallClock } from "@mark1russell7/algebra/clock";
import { channelDownPolicy, DEFAULT_LINK_POLICY, DEFAULT_SEND_LIMITS, downChannels, heldPersons, indicatorBreadth, limitShare, linkRule, observeConditions, ONLY_COPY, type ChannelQuota, type ChannelSnapshot, type CopyWatch, type Duration, type EntryTimes, type Exhaustion, type FetchOutcome, type HeldPerson, type Incident, type IndicatorBreadth, type Instant, type LatenessFolds, type ObserveCondition, type ReportId, type SourceDescriptor, type SourceId, type StoreFill, type SourceProcedures, type Watch, type ZoneRegions } from "@mark1russell7/alerts";
import { errorMessage } from "@mark1russell7/text";
import type { BalanceWatch } from "./balance.ts";
import { channelWatch, lastFetchSuccess } from "./channel-watch.ts";
import { createDispatcher, type DeliveryOptions, type DeliveryStep } from "./delivery.ts";
import { drillStarts, drillStep, type CopyDrill } from "./drills.ts";
import { entryIndex } from "./entries.ts";
import { envelope, EVENT_TYPES, FOLD_TYPES, unknownEvents, type RuntimeEvent } from "./events.ts";
import { importPage, sharePage, type ExchangePage, type ReceivedPage } from "./exchange.ts";
import { fetchStep } from "./fetch.ts";
import { limited } from "./limit.ts";
import type { RuntimeLog } from "./log.ts";
import { cutIncidents, modeEvents, modeStatus, observeStep, type ModeStatus, type ObserveParts } from "./observe.ts";
import { READING_RETENTION, type ReadingStore } from "./readings.ts";
import { SNAPSHOT_MISSES, snapshotStep } from "./snapshot.ts";
import { retention, retiredEvent, type RetentionOptions } from "./retention.ts";
import type { ReadWatch } from "./schedule.ts";
import { seriesReads } from "./series-reads.ts";
import { fold, rebuild, type ExchangeCursor, type RuntimeState } from "./state.ts";
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
  /** The retention of old incidents (AL-47). The defaults come from the core. */
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
   * The watches of the balances of the paid provider accounts. Each pass starts `check` of each watch, next to
   * its fetches. Each stage of a balance is a line of system reports.
   */
  readonly balances?: readonly BalanceWatch[];
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
   * The regions of the zones of the indicator areas, from a table of the atlas. The breadth of a place reads them. Without
   * the table, a series with the area of a zone is in the list `unplaced` of the breadth.
   */
  readonly zones?: readonly ZoneRegions[];
}

/** The action of the store of the readings that gave a fault: a write, a delete or a read of the series. */
export type ReadingsAction = "add" | "prune" | "read";

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
  /** The mode of each source with a mode (AL-73), with the verdict of each source that observes. It has no person. */
  readonly modes?: readonly ModeStatus[];
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
  const config: ViewConfig = { ...options.view, sources: options.sources.map((source) => source.describe()) };
  const ids = config.sources.map((source) => source.id);
  const repeated = ids.find((id, at) => ids.indexOf(id) !== at);
  if (repeated !== undefined) throw new Error(`Two sources have the id ${repeated}.`);

  // The index of the times of entry is a fold of the same events as the state. The start reads only the types of the fold
  // (AL-102): an observation changes neither. The counts of each type give the events of the types that this build does
  // not know, with no parse.
  const entries = entryIndex();
  let state = rebuild(
    counted(log.read(FOLD_TYPES), (event) => entries.add(event)),
    config,
  );
  entries.prune(state.merge);
  const skipped = unknownEvents(log.counts());

  // The fold runs on a draft before each write. The state changes only when the transaction commits.
  const append = (events: readonly RuntimeEvent[]): readonly string[] => {
    let draft = state;
    const accepted: RuntimeEvent[] = [];
    const conflicts = log.appendAll(events, (event) => {
      draft = fold(draft, event, config);
      accepted.push(event);
    });
    state = draft;
    // The index gets the events only after the write. Thus a failed write, and the write again, move no stamp two times.
    for (const event of accepted) entries.add(event);
    if (accepted.some((event) => event.type === "retired")) entries.prune(state.merge);
    return conflicts;
  };

  append([{ ...envelope("started", `started:${options.run}`, clock.now()), run: options.run }]);

  // The id of this copy and of its log: the id of the first event. A new log has a new first event. The salvage of a
  // broken file gives new positions, thus a recovered log has the id of its last recovery.
  const self = options.copy ?? ONLY_COPY.id;
  const recovery = state.recoveries.at(-1);
  const logId = recovery === undefined ? ([...log.entries({ after: 0, types: EVENT_TYPES, limit: 1 })][0]?.event.id ?? `started:${options.run}`) : `recovered:${recovery.quarantine}`;
  // The position of the next read of each other copy. It starts at the position of the log, and it moves at each page.
  const positions = new Map<string, ExchangeCursor>();

  const copies = options.copies;
  // The parts of the observe mode of the new sources (AL-73). With no delivery, no person watches. Thus each verdict passes after its window.
  const observeParts: ObserveParts = {
    people: options.delivery?.recipients.map((recipient) => recipient.watch) ?? [],
    places: config.places,
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
          places: config.places,
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
  // The time of the last search for retirements, in memory only. A restart searches again at its first pass.
  const kept = retention(options.retention);
  const link = linkRule(config.link ?? DEFAULT_LINK_POLICY);
  let searched: Instant | undefined;

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
  const zones = options.zones ?? [];

  const limit = options.snapshotMisses ?? SNAPSHOT_MISSES;
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`The count of snapshot misses is ${limit}, not an integer of 1 or more.`);

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
    const fetched = fetchStep({ source: descriptor.id, descriptor, procedures: source, started, ended, outcome, known: (id) => log.has(id), frame: state.steps.length });
    // The readings go first. A failed write of the log leaves the observations new, thus the next fetch gives their readings
    // again, and the store keeps each key once.
    if (fetched.readings.length > 0) {
      guarded("add", (readings) => readings.add(fetched.readings));
      indicatorReads?.note(fetched.readings);
    }
    const conflicts = append(fetched.events);
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
  const scheduled: readonly ReadWatch[] = [...watches, ...(options.reads ?? [])];

  // A fault of the store of a gate ends no line of a quota. The notes of the heartbeat tell of the fault.
  const readQuotas = (): readonly ChannelQuota[] | undefined => {
    if (options.quotas === undefined) return [];
    try {
      return options.quotas();
    } catch {
      return undefined;
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
  const close = (): Promise<void> =>
    (closed ??= Promise.allSettled(options.sources.map((source) => Promise.resolve().then(() => source.close?.()))).then(() => undefined));

  return {
    config,
    state: () => state,
    skipped,
    async pass(stop) {
      if (closed !== undefined) throw new Error("The runtime is closed: its sources have no session.");
      const stepped = followStep();
      const start = clock.now();
      const due = options.sources.flatMap((source, at) => {
        const descriptor = config.sources[at]!;
        return nextFetch(state, descriptor) <= start ? [{ source, descriptor }] : [];
      });
      // A watch reads only when it is due, and its check does not throw. It runs next to the fetches.
      const checks = Promise.all(scheduled.map((watch) => watch.check(clock, stop)));
      // The probes of the down channels run next to the fetches. A probe does not throw, and it ends at the call limit.
      const probes = channels?.probe(start, lastFetchSuccess(state.health));
      // Each fetch ends before the pass ends, also when one of them fails. Thus no fetch of a pass runs on in the next pass.
      const settled = await Promise.allSettled(due.map(({ source, descriptor }) => fetchOne(source, descriptor, stop)));
      await checks;
      await probes;
      await options.copies?.ready();
      const failed = settled.find((result) => result.status === "rejected");
      if (failed !== undefined) throw failed.reason;
      const conflicts = [...stepped.conflicts, ...settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []))];

      const at = clock.now();
      // The breadth of the indicator signals at the time of the view. A fault of the store gives no breadth, and the pass continues.
      const signals = indicatorReads === undefined ? undefined : guarded("read", () => indicatorReads.signals(at));
      const breadth = signals === undefined ? undefined : indicatorBreadth(signals, config.places, zones);
      // Each due drill starts before the view. Thus the system fold of the view gives its run, and the delivery step sends it.
      const drills = options.drills ?? [];
      const started = drillStarts(state, drills, self, at);
      if (started.length > 0) conflicts.push(...append(started));
      const drilled = drillStep(state, drills, self, at);
      // Each source with no mode gets its mode before the view (AL-73). The first start seeds the modes, and a later new source observes.
      const modes = modeEvents(state, config.sources, at);
      if (modes.length > 0) conflicts.push(...append(modes));
      const quotas = readQuotas();
      const stores = readStores();
      // The persons with a hold of the send limit (AL-81). With no delivery, no person has a hold, and each open line stays.
      const held = dispatcher === undefined ? undefined : heldOf(at);
      const view = systemView(state, config, at, { drills: drilled.snapshots, ...(quotas === undefined ? {} : { quotas }), ...(stores === undefined ? {} : { stores }), balances: watches.flatMap((watch) => watch.balance() ?? []), ...(options.copies === undefined ? {} : { copies: options.copies.watches(), copy: self }), ...(folds === undefined ? {} : { folds }), ...(exhausted === undefined ? {} : { exhausted }), ...(held === undefined ? {} : { held }), ...(channels === undefined ? {} : { channels: channels.snapshots() }), ...(observing === undefined ? {} : { observing }) });
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

      // The retirement comes after the delivery, at most once in each interval. A retired incident is not live, thus no send needs it.
      if (searched === undefined || at - searched >= kept.every) {
        searched = at;
        const retired = retiredEvent(state, at, link, kept);
        if (retired !== undefined) conflicts.push(...append([retired]));
      }
      // The old readings go at most once in each interval of the retirements.
      if (store !== undefined && (pruned === undefined || at - pruned >= kept.every)) {
        pruned = at;
        guarded("prune", (readings) => {
          readings.prune(at - keep);
          indicatorReads?.pruned(at - keep);
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
