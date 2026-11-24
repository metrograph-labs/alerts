/**
 * The surprise of the signals (AL-24). One signal out of its normal level is a weak sign. Many signals at one time are a
 * strong sign only when they are rare together. This module tells how rare the signals of one time are.
 *
 * - A unit is one source of evidence in one area, for example the rail delays near a place. At the time of the read, a
 *   unit has a signal or no signal.
 * - The history of a unit gives its base rate: the count of its reads with a signal over the count of its reads. The
 *   rate is the upper bound of the Wilson interval, thus a short history gives a high rate and a low surprise.
 * - The history counts one read of a unit in each bucket of one hour at most (`signalHistories`). Thus the passes a few
 *   seconds apart do not count one read many times.
 * - When the units are independent, the count of the units with a signal has the Poisson binomial law of their rates.
 *   The chance of the count of this time or more is the p of the signals.
 * - The surprise is `-log10(p)`. A surprise of 3 tells a count that independent units give one time in 1000 reads.
 *
 * The count weighs each unit the same: one rare signal and one common signal give the same surprise. The list `rare` tells
 * the rare units. A statistic that weighs each unit by its rate is the next part of AL-24.
 *
 * A high surprise tells that the independent model fails: a hidden common cause moves many units at one time. The
 * surprise gives no decision and no level. The calculation of the level (AL-31) reads it.
 */
import { poissonBinomialTest, wilson } from "@mark1russell7/rigor-statistics";
import { compareCodeUnits } from "@mark1russell7/text/order";
import type { Breadth, IndicatorBreadth } from "./breadth.ts";
import type { Duration, Instant, PlaceId } from "./contracts.ts";

/** One unit of evidence at the time of the read. */
export interface SignalUnit {
  /** The id of the unit. One id counts one time. */
  readonly unit: string;
  readonly signal: boolean;
}

/** The history of the reads of one unit: the count of its reads and the count of its reads with a signal. */
export interface SignalHistory {
  readonly unit: string;
  /** The count of the reads, a whole number of 0 or more. */
  readonly reads: number;
  /** The count of the reads with a signal, a whole number from 0 to `reads`. */
  readonly signals: number;
}

/** The base rate of one unit with a signal. */
export interface SignalRate {
  readonly unit: string;
  /** The upper bound of the Wilson interval of the history, from 0 to 1. */
  readonly rate: number;
  readonly reads: number;
}

/** The surprise of the signals of one group of units. */
export interface Surprise {
  /** The count of the units with a base rate. */
  readonly units: number;
  /** The count of the units with a base rate and a signal. */
  readonly signals: number;
  /** The chance of `signals` or more when the units are independent, from 0 to 1. */
  readonly p: number;
  /** The value `-log10(p)`, 0 or more. */
  readonly surprise: number;
  /** The units with a signal and a base rate, from the lowest rate. Equal rates keep the order of the code units of the ids. */
  readonly rare: readonly SignalRate[];
  /** The ids of the units with too short a history for a base rate, in the order of the code units. */
  readonly noRate: readonly string[];
}

/** The default count of reads before a unit gets a base rate. */
export const MIN_READS = 30;

/** The smallest p of a surprise: the smallest normal double, 2^-1022. A smaller p gives this p. */
const SMALLEST_P = 2 ** -1022;

function whole(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/**
 * This function gives the base rate of a history. It gives `undefined` for a history with fewer than `minReads` reads.
 * It throws a `RangeError` for counts that are not whole numbers, or for more signals than reads.
 */
export function signalRate(history: SignalHistory, minReads: number = MIN_READS): SignalRate | undefined {
  if (!whole(history.reads) || !whole(history.signals) || history.signals > history.reads) {
    throw new RangeError(`The history of ${history.unit} needs whole counts with signals not more than reads.`);
  }
  if (history.reads < Math.max(1, minReads)) return undefined;
  return { unit: history.unit, rate: wilson(history.signals, history.reads).high, reads: history.reads };
}

/**
 * This function gives the surprise of the signals of a group of units. The result is a function of the set of the
 * units and of the set of the histories: the order does not change it.
 *
 * - A unit id counts one time. When an id has two units, a signal counts.
 * - When an id has two histories, the history with more reads counts. Equal reads keep the higher count of signals.
 * - A unit with no history, or with fewer than `minReads` reads, is in `noRate` and is not in the count.
 */
export function surpriseOf(units: readonly SignalUnit[], histories: readonly SignalHistory[], minReads: number = MIN_READS): Surprise {
  const signal = new Map<string, boolean>();
  for (const item of units) signal.set(item.unit, (signal.get(item.unit) ?? false) || item.signal);
  const history = new Map<string, SignalHistory>();
  for (const item of histories) {
    const old = history.get(item.unit);
    if (old === undefined || item.reads > old.reads || (item.reads === old.reads && item.signals > old.signals)) history.set(item.unit, item);
  }
  const ids = [...signal.keys()].sort(compareCodeUnits);
  const rates: SignalRate[] = [];
  const noRate: string[] = [];
  for (const id of ids) {
    const found = history.get(id);
    const rate = found === undefined ? undefined : signalRate(found, minReads);
    if (rate === undefined) noRate.push(id);
    else rates.push(rate);
  }
  const rare = rates.filter((item) => signal.get(item.unit) === true).sort((a, b) => a.rate - b.rate || compareCodeUnits(a.unit, b.unit));
  const p = rates.length === 0 ? 1 : poissonBinomialTest(rare.length, rates.map((item) => item.rate), "greater");
  const bounded = Math.min(1, Math.max(SMALLEST_P, p));
  return { units: rates.length, signals: rare.length, p: bounded, surprise: Math.max(0, -Math.log10(bounded)), rare, noRate };
}

/**
 * This function gives the units of a breadth: one unit for each dimension with a read, with the id
 * `<scope>/<dimension>`. A dimension has a signal when one series of it has a signal. A dimension with no read gives no
 * unit, because no read is not a read with no signal.
 */
export function breadthUnits(breadth: Breadth, scope: string): SignalUnit[] {
  return breadth.dimensions.filter((count) => count.read > 0).map((count) => ({ unit: `${scope}/${count.dimension}`, signal: count.signals > 0 }));
}

/** The scope of the units of the world. */
export const WORLD_SCOPE = "world";

/** This function gives the scope of the units of a watched place: `place/<id>`. Thus no place id gives the scope `world`. */
export function placeScope(place: PlaceId): string {
  return `place/${place}`;
}

/** The surprise of the signals of one watched place. */
export interface PlaceSurprise extends Surprise {
  readonly place: PlaceId;
}

/** The surprise of the signals of the world and of each watched place. */
export interface IndicatorSurprise {
  readonly world: Surprise;
  /** The surprise of each place, in the order of the places of the breadth. */
  readonly places: readonly PlaceSurprise[];
}

/**
 * This function gives the units of the breadth of the world and of each place. The units of the world have the scope
 * `world`, and the units of a place have the scope of `placeScope`.
 */
export function indicatorUnits(breadth: IndicatorBreadth): SignalUnit[] {
  return [...breadthUnits(breadth.world, WORLD_SCOPE), ...breadth.places.flatMap((place) => breadthUnits(place, placeScope(place.place)))];
}

/** This function gives the surprise of the signals of the world and of each place, from the histories of the units. */
export function indicatorSurprise(breadth: IndicatorBreadth, histories: readonly SignalHistory[], minReads: number = MIN_READS): IndicatorSurprise {
  return {
    world: surpriseOf(breadthUnits(breadth.world, WORLD_SCOPE), histories, minReads),
    places: breadth.places.map((place) => ({ place: place.place, ...surpriseOf(breadthUnits(place, placeScope(place.place)), histories, minReads) })),
  };
}

/**
 * The size of a bucket of the history: one hour. The history of a unit holds one read in each bucket at most.
 *
 * Two passes a few seconds apart give the same read nearly always. A count of each pass thus counts one read many times,
 * and the times with many passes count more. A bucket of a fixed size gives each hour the same weight.
 */
export const HISTORY_BUCKET: Duration = 3_600_000;

/** The reads of the units in one bucket of the history. */
export interface BucketReads {
  /** The start of the bucket, from `bucketOf`. */
  readonly bucket: Instant;
  /** The units with a read in the bucket. A unit with no read in the bucket is not in the list. */
  readonly units: readonly SignalUnit[];
}

/** This function gives the start of the bucket of a time: the time rounded down to a whole count of buckets. */
export function bucketOf(at: Instant, size: Duration = HISTORY_BUCKET): Instant {
  if (!Number.isFinite(size) || size <= 0) throw new RangeError(`The size of a bucket is ${size}, not a finite number above 0.`);
  return Math.floor(at / size) * size;
}

/**
 * This function gives the history of each unit from the reads of the buckets, in the order of the code units of the ids.
 * The result is a function of the set of the reads: the order and a duplicate do not change it.
 *
 * - A unit gets one read for each bucket with a read of the unit. Two reads of a unit in one bucket count one time.
 * - A read with a signal adds to the reads and to the signals. When a unit has two reads in one bucket, a signal counts.
 * - A bucket with no read of a unit adds nothing to the history of the unit.
 */
export function signalHistories(buckets: readonly BucketReads[]): SignalHistory[] {
  const seen = new Map<Instant, Map<string, boolean>>();
  for (const item of buckets) {
    const units = seen.get(item.bucket) ?? new Map<string, boolean>();
    for (const one of item.units) units.set(one.unit, (units.get(one.unit) ?? false) || one.signal);
    seen.set(item.bucket, units);
  }
  const counts = new Map<string, { reads: number; signals: number }>();
  for (const units of seen.values()) {
    for (const [unit, signal] of units) {
      const count = counts.get(unit) ?? { reads: 0, signals: 0 };
      count.reads += 1;
      if (signal) count.signals += 1;
      counts.set(unit, count);
    }
  }
  return [...counts].sort(([a], [b]) => compareCodeUnits(a, b)).map(([unit, count]) => ({ unit, reads: count.reads, signals: count.signals }));
}
