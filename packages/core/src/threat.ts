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
 * the rare units. The field `weighted` weighs each unit by `-ln(rate)`, thus a rare signal counts more:
 *
 * - The statistic is the sum of the weights of the units with a signal. Its p is the upper bound of
 *   `weightedBernoulliTest`, thus the weighted surprise does not tell more than the data gives.
 * - When each unit has the same rate, the weighted p is the p of the count.
 *
 * The pairs of units of one scope give the links between the domains (`pairHistories`, `pairSurprises`):
 *
 * - The history of a pair counts the buckets with a read of the two units. It also counts the buckets with a signal of each and of both.
 * - A pair can have two signals at the time of the read. Then `rate` is the upper bound of the Wilson interval of its joint
 *   signals. Its surprise tells how rare the two signals are together.
 * - The value `together` is the chance of the joint count or more when the two units are independent. A low value tells
 *   that a common cause moves the two units. Thus their two signals are not two independent signs.
 *
 * A high surprise tells that the independent model fails: a hidden common cause moves many units at one time. The
 * surprise gives no decision and no level. The calculation of the level (AL-31) reads it.
 */
import { binomialTest, poissonBinomialTest, WEIGHTED_TAIL_CELLS, WEIGHTED_TAIL_MAX_WORK, weightedBernoulliTest, wilson } from "@mark1russell7/rigor-statistics";
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
  /** The surprise of the signals, with a weight for each unit from its rate. A group of more than `MAX_WEIGHTED_UNITS` units has none. */
  readonly weighted?: WeightedSurprise;
  /** The pairs of the units with two signals, from `pairSurprises`. Only a call with the histories of the pairs gives this field. */
  readonly pairs?: readonly PairSurprise[];
}

/** The joint history of two units of one scope. */
export interface PairHistory {
  /** The first unit of the pair. It comes before `b` in the order of the code units. */
  readonly a: string;
  readonly b: string;
  /** The count of the buckets with a read of the two units. */
  readonly reads: number;
  /** The count of these buckets with a signal of `a`. */
  readonly signalsA: number;
  /** The count of these buckets with a signal of `b`. */
  readonly signalsB: number;
  /** The count of these buckets with a signal of the two units. */
  readonly joint: number;
}

/** The surprise of two units of one scope with a signal at one time. */
export interface PairSurprise {
  readonly a: string;
  readonly b: string;
  /** The count of the buckets with a read of the two units. */
  readonly reads: number;
  /** The count of these buckets with a signal of the two units. */
  readonly joint: number;
  /** The upper bound of the Wilson interval of the joint signals, from 0 to 1. */
  readonly rate: number;
  /** The value `-log10(rate)`, 0 or more. */
  readonly surprise: number;
  /**
   * The chance of `joint` or more joint signals in `reads` buckets when the two units are independent, from 0 to 1. The
   * rate of each unit is the upper bound of its Wilson interval in these buckets. Thus a low value does not come from a short history.
   */
  readonly together: number;
}

/** The surprise of the sum of the weights of the units with a signal. The weight of a unit is `-ln(rate)`. */
export interface WeightedSurprise {
  /** The sum of the weights of the units with a signal, 0 or more. */
  readonly weight: number;
  /** The lower bound of the chance of `weight` or more when the units are independent, from 0 to `p`. */
  readonly low: number;
  /** The upper bound of the chance of `weight` or more when the units are independent, from 0 to 1. */
  readonly p: number;
  /** The value `-log10(p)`, 0 or more. */
  readonly surprise: number;
}

/**
 * The most units of a weighted surprise. The work of `weightedBernoulliTest` grows with the square of the count of the
 * units. Thus a larger group gets fewer cells, and this count gets one cell.
 */
export const MAX_WEIGHTED_UNITS: number = Math.floor(Math.sqrt(WEIGHTED_TAIL_MAX_WORK));

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
  const bounded = boundP(p);
  const found = { units: rates.length, signals: rare.length, p: bounded, surprise: Math.max(0, -Math.log10(bounded)), rare, noRate };
  const weighted = weightedSurprise(rates, new Set(rare.map((item) => item.unit)));
  return weighted === undefined ? found : { ...found, weighted };
}

/** This function gives the scope of a unit id: the part before the last `/`. An id with no `/` has the empty scope. */
export function scopeOf(unit: string): string {
  const at = unit.lastIndexOf("/");
  return at < 0 ? "" : unit.slice(0, at);
}

/**
 * This function gives the surprise of each pair of units with two signals, from the histories of the pairs. The result is
 * a function of the set of the units and of the set of the histories: the order does not change it.
 *
 * - A pair has two units of one scope. A unit id counts one time. When an id has two units, a signal counts.
 * - A pair with fewer than `minReads` joint reads gives no surprise.
 * - When a pair has two histories, the history with more reads counts. Equal reads keep the higher count of joint signals.
 * - The order is from the lowest rate. Equal rates keep the order of the code units of the ids.
 */
export function pairSurprises(units: readonly SignalUnit[], pairs: readonly PairHistory[], minReads: number = MIN_READS): PairSurprise[] {
  const signal = new Map<string, boolean>();
  for (const item of units) signal.set(item.unit, (signal.get(item.unit) ?? false) || item.signal);
  const history = new Map<string, PairHistory>();
  for (const item of pairs) {
    checkPair(item);
    const key = `${item.a}\n${item.b}`;
    const old = history.get(key);
    if (old === undefined || item.reads > old.reads || (item.reads === old.reads && item.joint > old.joint)) history.set(key, item);
  }
  const found: PairSurprise[] = [];
  for (const item of history.values()) {
    if (signal.get(item.a) !== true || signal.get(item.b) !== true || item.reads < Math.max(1, minReads)) continue;
    const rate = wilson(item.joint, item.reads).high;
    const expected = wilson(item.signalsA, item.reads).high * wilson(item.signalsB, item.reads).high;
    const together = boundP(binomialTest(item.joint, item.reads, Math.min(1, expected), "greater"));
    found.push({ a: item.a, b: item.b, reads: item.reads, joint: item.joint, rate, surprise: Math.max(0, -Math.log10(boundP(rate))), together });
  }
  return found.sort((x, y) => x.rate - y.rate || compareCodeUnits(x.a, y.a) || compareCodeUnits(x.b, y.b));
}

function checkPair(item: PairHistory): void {
  const counts = [item.reads, item.signalsA, item.signalsB, item.joint];
  const fits = counts.every(whole) && item.signalsA <= item.reads && item.signalsB <= item.reads && item.joint <= Math.min(item.signalsA, item.signalsB);
  if (!fits || compareCodeUnits(item.a, item.b) >= 0 || scopeOf(item.a) !== scopeOf(item.b)) {
    throw new RangeError(`The pair ${item.a} and ${item.b} needs two ids of one scope in order, and whole counts that fit.`);
  }
}

function boundP(p: number): number {
  return Math.min(1, Math.max(SMALLEST_P, p));
}

// The weight of a unit: -ln(rate). A rate of 1 gives 0, thus a unit that has a signal in each read adds nothing.
function weightOf(rate: number): number {
  return Math.max(0, -Math.log(rate));
}

// The weighted surprise of the units with a rate, or undefined for a group of more than MAX_WEIGHTED_UNITS units.
function weightedSurprise(rates: readonly SignalRate[], signals: ReadonlySet<string>): WeightedSurprise | undefined {
  const count = rates.length;
  if (count > MAX_WEIGHTED_UNITS) return undefined;
  const weights = rates.map((item) => weightOf(item.rate));
  const weight = rates.reduce((sum, item, index) => (signals.has(item.unit) ? sum + weights[index]! : sum), 0);
  // The work is approximately count * count * cells. Thus a large group gets fewer cells, and the bounds are wider.
  const cells = Math.max(1, Math.min(WEIGHTED_TAIL_CELLS, Math.floor(WEIGHTED_TAIL_MAX_WORK / Math.max(1, count * count))));
  const tail = count === 0 ? { low: 1, high: 1 } : weightedBernoulliTest(weight, rates.map((item) => item.rate), weights, { cells });
  const p = boundP(tail.high);
  return { weight, low: Math.min(p, Math.max(0, tail.low)), p, surprise: Math.max(0, -Math.log10(p)) };
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

/**
 * This function gives the surprise of the signals of the world and of each place, from the histories of the units. With
 * the histories of the pairs, each surprise also has its field `pairs`.
 */
export function indicatorSurprise(breadth: IndicatorBreadth, histories: readonly SignalHistory[], minReads: number = MIN_READS, pairs?: readonly PairHistory[]): IndicatorSurprise {
  const of = (units: readonly SignalUnit[]): Surprise => {
    const found = surpriseOf(units, histories, minReads);
    return pairs === undefined ? found : { ...found, pairs: pairSurprises(units, pairs, minReads) };
  };
  return {
    world: of(breadthUnits(breadth.world, WORLD_SCOPE)),
    places: breadth.places.map((place) => ({ place: place.place, ...of(breadthUnits(place, placeScope(place.place))) })),
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

/**
 * This function gives the joint history of each pair of units of one scope from the reads of the buckets. The order is the
 * order of the code units of `a` and then `b`. The result is a function of the set of the reads: the order and a duplicate do not
 * change it. The rules of a bucket are the rules of `signalHistories`.
 *
 * Cost: O(buckets × k²), with k the count of the units of one scope in one bucket.
 */
export function pairHistories(buckets: readonly BucketReads[]): PairHistory[] {
  const seen = new Map<Instant, Map<string, boolean>>();
  for (const item of buckets) {
    const units = seen.get(item.bucket) ?? new Map<string, boolean>();
    for (const one of item.units) units.set(one.unit, (units.get(one.unit) ?? false) || one.signal);
    seen.set(item.bucket, units);
  }
  const counts = new Map<string, { a: string; b: string; reads: number; signalsA: number; signalsB: number; joint: number }>();
  for (const units of seen.values()) {
    const scopes = new Map<string, [string, boolean][]>();
    for (const entry of units) scopes.set(scopeOf(entry[0]), [...(scopes.get(scopeOf(entry[0])) ?? []), entry]);
    for (const members of scopes.values()) {
      members.sort(([x], [y]) => compareCodeUnits(x, y));
      for (let i = 0; i < members.length; i += 1) {
        for (let j = i + 1; j < members.length; j += 1) {
          const [a, signalA] = members[i]!;
          const [b, signalB] = members[j]!;
          const key = `${a}\n${b}`;
          const count = counts.get(key) ?? { a, b, reads: 0, signalsA: 0, signalsB: 0, joint: 0 };
          count.reads += 1;
          if (signalA) count.signalsA += 1;
          if (signalB) count.signalsB += 1;
          if (signalA && signalB) count.joint += 1;
          counts.set(key, count);
        }
      }
    }
  }
  return [...counts.values()].sort((x, y) => compareCodeUnits(x.a, y.a) || compareCodeUnits(x.b, y.b));
}
