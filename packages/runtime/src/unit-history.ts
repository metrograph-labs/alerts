/**
 * This module keeps the history of the signal units between the passes (AL-24). The surprise of the signals reads it.
 *
 * - The first pass of each bucket of one hour writes the units of its breadth to the store. Later passes of the bucket
 *   write nothing. Thus the history counts one read of a unit in each bucket, not one read in each pass.
 * - A bucket with no pass, or with no read of a unit, adds no read of the unit.
 * - The store keeps the reads of the units as long as the readings. A restart reads them again.
 *
 * The history comes from the live reads, not from a read of the store at past times. The baseline of a past time needs
 * the readings of the 28 days before it, and the store keeps only one day more than that.
 *
 * Cost: a pass reads the store only at the first use. A new bucket or a delete calculates the histories again, in
 * O(buckets × units). Each other pass reuses them.
 */
import { bucketOf, HISTORY_BUCKET, signalHistories, type Duration, type Instant, type SignalHistory, type SignalUnit } from "@mark1russell7/alerts";
import type { ReadingStore } from "./readings.ts";

/** The history of the signal units between the passes. */
export interface UnitHistory {
  /**
   * This function gives the history of each unit from the buckets before `before`. It reads the store at its first use.
   * When the store throws, the function throws, and the next call reads the store again.
   */
  histories(before: Instant): SignalHistory[];
  /**
   * This function writes the units of the bucket of `at` to the store, one time for each bucket. A bucket that the
   * history holds, or an empty list, writes nothing. When the store throws, the history does not change.
   */
  record(at: Instant, units: readonly SignalUnit[]): void;
  /** This function tells that the store deleted each read of a bucket before `before`. */
  pruned(before: Instant): void;
}

/** This function makes the history of the signal units on a store of the readings. */
export function unitHistory(store: ReadingStore, size: Duration = HISTORY_BUCKET): UnitHistory {
  if (!Number.isFinite(size) || size <= 0) throw new RangeError(`The size of a bucket is ${size}, not a finite number above 0.`);
  let buckets: Map<Instant, readonly SignalUnit[]> | undefined;
  // The histories of the last call, and the bound of the buckets that they hold.
  let cached: { readonly before: Instant; readonly histories: SignalHistory[] } | undefined;
  const loaded = (): Map<Instant, readonly SignalUnit[]> => {
    if (buckets === undefined) buckets = new Map(store.unitReads(Number.MIN_SAFE_INTEGER).map((item) => [item.bucket, item.units] as const));
    return buckets;
  };
  return {
    histories(before) {
      const all = loaded();
      if (cached?.before !== before) {
        cached = { before, histories: signalHistories([...all].filter(([bucket]) => bucket < before).map(([bucket, units]) => ({ bucket, units }))) };
      }
      return cached.histories;
    },
    record(at, units) {
      const all = loaded();
      const bucket = bucketOf(at, size);
      if (units.length === 0 || all.has(bucket)) return;
      store.addUnitReads({ bucket, units });
      all.set(bucket, units);
      cached = undefined;
    },
    pruned(before) {
      if (buckets === undefined) return;
      for (const bucket of [...buckets.keys()]) if (bucket < before) buckets.delete(bucket);
      cached = undefined;
    },
  };
}
