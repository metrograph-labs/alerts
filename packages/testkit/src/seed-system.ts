/**
 * AL-104: the system events of the seeded store. The view of the runtime (`systemView`) gives a `system` event at a step,
 * as at a pass of a live copy. Three causes open the lines of the view, as in the live log:
 *
 * - An outage of the cell: each fetch fails with `network` or `timeout`. The reads of the other copy fail too.
 * - A down source: each fetch of the source is refused, as at a source with no key.
 * - A gap in the reads of the other copy, as at a restart of that copy.
 *
 * Each fetch out of an outage fails at the chance `failure` too. The time from the end of an outage to the start of the
 * next outage is uniform from 0 to two times the mean time. The gaps of the reads have the same form.
 */
import type { CopyWatch, Duration, FetchFailure, Instant, LatenessFolds, SourceDescriptor, SourceId, WatchedPlace } from "@mark1russell7/alerts";
import { CLOCK_SKEW_LIMIT, COPY_MAX_AGE, DELAY_LIMITS, earliest, systemEvent, systemView, type RuntimeState, type SystemEvent, type ViewConfig } from "@mark1russell7/alerts-runtime";
import type { Random } from "@mark1russell7/rigor-generators";

/** The causes of the system lines of a mix. */
export interface SystemMix {
  /** The mean count of outages of the cell in a day. */
  readonly outages: number;
  /** The shortest and the longest time of an outage of the cell. */
  readonly outage: readonly [Duration, Duration];
  /** The count of sources that refuse each fetch. */
  readonly down: number;
  /** The chance that one fetch out of an outage fails. */
  readonly failure: number;
  /** The mean count of gaps in the reads of the other copy in a day. */
  readonly gaps: number;
  /** The shortest and the longest time of a gap in the reads of the other copy. */
  readonly gap: readonly [Duration, Duration];
}

/** The result of one fetch of a source. */
export interface SeedFetch {
  /** The failure of the fetch. It is absent when the fetch passes. */
  readonly failure?: FetchFailure;
  /** This value is `true` when the last fetch of the source had the other result. Then the health of the source can change. */
  readonly turned: boolean;
}

/** The system events of the view at one step, and the next time when the view changes with no fetch. */
export interface SeedView {
  readonly events: readonly SystemEvent[];
  readonly wakeAt?: Instant;
}

/** The system stage of `seedStore`. The times of the calls of its methods do not go back. */
export interface SeedSystem {
  /** This method gives the result of a fetch of `source` that starts at `at`. */
  fetch(source: SourceId, at: Instant): SeedFetch;
  /** This method starts the watch of the other copy and the folds of the view again at `at`, as a start of the runtime does. */
  restart(at: Instant): void;
  /** This method gives the system events of the view at `at`, for the places `places`. */
  step(at: Instant, places: readonly WatchedPlace[]): SeedView;
}

/** What the stage reads in `seedStore`. */
export interface SeedSystemContext {
  /** The time of the first event of the log. */
  readonly start: Instant;
  /** The id of this copy. */
  readonly self: string;
  /** The id of the other copy. */
  readonly peer: string;
  /** The descriptors of the sources. The fold of the log reads the same descriptors. */
  readonly sources: readonly SourceDescriptor[];
  /** The fold options of the configuration, as in the context of the fold. */
  readonly retention: ViewConfig["retention"];
  state(): RuntimeState;
}

const DAY = 86_400_000;

// The spans of one cause: an outage or a gap. Each span starts after the end of the span before it.
interface Spans {
  /** This method gives the span at `at`, or `undefined`. */
  at(at: Instant): { readonly from: Instant; readonly to: Instant } | undefined;
  /** This method gives the start of the next span after `at`, or `undefined` when a span is at `at`. */
  nextFrom(at: Instant): Instant | undefined;
}

// A mean count of 0 gives no span. The times of the calls do not go back.
function spansOf(r: Random, perDay: number, [shortest, longest]: readonly [Duration, Duration], start: Instant): Spans {
  if (perDay === 0) return { at: () => undefined, nextFrom: () => undefined };
  const mean = DAY / perDay;
  let from = start + r.range(0, 2 * mean);
  let to = from + r.range(shortest, longest);
  const advance = (at: Instant): void => {
    while (to <= at) {
      from = to + r.range(0, 2 * mean);
      to = from + r.range(shortest, longest);
    }
  };
  return {
    at(at) {
      advance(at);
      return at >= from ? { from, to } : undefined;
    },
    nextFrom(at) {
      advance(at);
      return at >= from ? undefined : from;
    },
  };
}

/**
 * This function makes the system stage of `seedStore`. The draws of the spans, of the down sources and of the failures
 * come from `r`.
 *
 * @throws Error when a mean count or the count `down` is less than 0, or when a chance is not in [0, 1). It also throws when
 * a shortest time is not above 0, or more than its longest time.
 */
export function seedSystem(mix: SystemMix, r: Random, context: SeedSystemContext): SeedSystem {
  for (const [name, count] of [["outages", mix.outages], ["gaps", mix.gaps], ["down", mix.down]] as const) {
    if (!(Number.isFinite(count) && count >= 0)) throw new Error(`The system mix has ${name} ${String(count)}. It must be a finite number of 0 or more.`);
  }
  if (!Number.isInteger(mix.down)) throw new Error(`The system mix has down ${String(mix.down)}. It must be an integer.`);
  if (!(mix.failure >= 0 && mix.failure < 1)) throw new Error(`The system mix has the chance failure ${String(mix.failure)}. It must be 0 or more, and less than 1.`);
  for (const [name, [shortest, longest]] of [["outage", mix.outage], ["gap", mix.gap]] as const) {
    if (!(shortest > 0 && longest >= shortest)) throw new Error(`The system mix has the ${name} times ${String(shortest)} and ${String(longest)} ms. The shortest must be above 0, and not above the longest.`);
  }
  const outages = spansOf(r.fork("outages"), mix.outages, mix.outage, context.start);
  const gaps = spansOf(r.fork("gaps"), mix.gaps, mix.gap, context.start);
  const down = new Set(r.sample(context.sources.map((source) => source.id), Math.min(mix.down, context.sources.length)));
  const failures = r.fork("failures");
  const kinds = [...new Set(context.sources.flatMap((source) => source.kinds))].sort();
  const failed = new Set<SourceId>();
  let since = context.start;
  let folds: LatenessFolds | undefined;
  // The last read of the other copy that passed before `at`. A copy reads the other copy at each pass, thus a read
  // passes at `at` when no outage and no gap is at `at`.
  const lastRead = (at: Instant): Instant | undefined => {
    const blocked = [outages.at(at), gaps.at(at)].flatMap((span) => (span === undefined ? [] : [span.from]));
    const read = blocked.length === 0 ? at : Math.min(...blocked);
    return read >= since ? read : undefined;
  };
  return {
    fetch(source, at) {
      const outage = outages.at(at) !== undefined;
      const failure: FetchFailure | undefined = down.has(source)
        ? { kind: "refused", message: "The seeded source refused the fetch." }
        : outage
          ? { kind: failures.chance(0.5) ? "network" : "timeout", message: "The seeded cell had an outage." }
          : mix.failure > 0 && failures.chance(mix.failure)
            ? { kind: "network", message: "The seeded fetch failed." }
            : undefined;
      const turned = (failure !== undefined) !== failed.has(source);
      if (failure === undefined) failed.delete(source);
      else failed.add(source);
      return { ...(failure === undefined ? {} : { failure }), turned };
    },
    restart(at) {
      since = at;
      folds = undefined;
    },
    step(at, places) {
      const read = lastRead(at);
      const watch: CopyWatch = { copy: context.peer, skewLimit: CLOCK_SKEW_LIMIT, maxAge: COPY_MAX_AGE, since, ...(read === undefined ? {} : { read: { at: read, skew: 0, sameConfig: true } }) };
      const config: ViewConfig = { sources: context.sources, ...(context.retention === undefined ? {} : { retention: context.retention }), places, kinds, expectations: [], delay: DELAY_LIMITS };
      const view = systemView(context.state(), config, at, { copies: [watch], copy: context.self, ...(folds === undefined ? {} : { folds }) });
      folds = view.folds;
      const event = systemEvent(view);
      // The view does not know the next outage or gap. The stage steps when a read of the other copy reaches its
      // maximum age, and when the reads pass again.
      const blocked = [outages.at(at), gaps.at(at)].flatMap((span) => (span === undefined ? [] : [span.from + COPY_MAX_AGE + 1, span.to + 1]));
      const next = [outages.nextFrom(at), gaps.nextFrom(at)].flatMap((from) => (from === undefined ? [] : [from + COPY_MAX_AGE + 1]));
      const wakeAt = earliest([view.wakeAt, ...blocked.filter((time) => time > at), ...next]);
      return { events: event === undefined ? [] : [event], ...(wakeAt === undefined ? {} : { wakeAt }) };
    },
  };
}
