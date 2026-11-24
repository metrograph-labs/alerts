import { binomialTest } from "@mark1russell7/rigor-statistics";
import { describe, expect, it } from "vitest";
import { random } from "@mark1russell7/rigor-generators";
import type { Breadth, IndicatorBreadth } from "./breadth.ts";
import type { PlaceId } from "./contracts.ts";
import { breadthUnits, bucketOf, HISTORY_BUCKET, indicatorSurprise, indicatorUnits, MIN_READS, placeScope, signalHistories, signalRate, surpriseOf, type BucketReads, type SignalHistory, type SignalUnit } from "./threat.ts";

const ids = Array.from({ length: 12 }, (_, index) => `place-1/unit-${String(index).padStart(2, "0")}`);
const history = (unit: string, reads = 1000, signals = 10): SignalHistory => ({ unit, reads, signals });
const units = (signals: number): SignalUnit[] => ids.map((unit, index) => ({ unit, signal: index < signals }));
const histories = ids.map((unit) => history(unit));

describe("the surprise of the signals (AL-24)", () => {
  it("gives no surprise with no signal, and a higher surprise for each more signal", () => {
    const none = surpriseOf(units(0), histories);
    expect(none).toMatchObject({ units: 12, signals: 0, p: 1, surprise: 0, rare: [], noRate: [] });
    let last = 0;
    for (let count = 1; count <= ids.length; count += 1) {
      const next = surpriseOf(units(count), histories).surprise;
      expect(next).toBeGreaterThan(last);
      last = next;
    }
  });

  it("gives the binomial test when each unit has the same rate", () => {
    const rate = signalRate(history("x"))!.rate;
    const found = surpriseOf(units(4), histories);
    expect(found.p).toBeCloseTo(binomialTest(4, ids.length, rate, "greater"), 12);
  });

  it("finds the rare units first, and weighs each unit the same in the count", () => {
    const mixed = [history(ids[0]!, 1000, 300), ...ids.slice(1).map((unit) => history(unit))];
    const common = surpriseOf([{ unit: ids[0]!, signal: true }, ...ids.slice(1).map((unit) => ({ unit, signal: false }))], mixed);
    const rare = surpriseOf([{ unit: ids[1]!, signal: true }, ...ids.filter((unit) => unit !== ids[1]).map((unit) => ({ unit, signal: false }))], mixed);
    // The count statistic weighs each unit the same. The weighted statistic is the next part of AL-24.
    expect(rare.surprise).toBe(common.surprise);
    expect(rare.rare[0]!.rate).toBeLessThan(common.rare[0]!.rate);
    const both = surpriseOf(units(2), mixed);
    expect(both.rare.map((item) => item.unit)).toEqual([ids[1], ids[0]]);
  });

  it("gives a unit with a short history no rate, and keeps it out of the count", () => {
    const short = [history(ids[0]!, MIN_READS - 1, 0), ...histories.slice(1)];
    const found = surpriseOf(units(3), short.slice(0, -1));
    expect(found.noRate).toEqual([ids[0], ids.at(-1)]);
    expect(found.units).toBe(10);
    expect(found.signals).toBe(2);
    // A short history gives a high rate: thus 30 reads with no signal is a weaker base than 1000.
    expect(signalRate(history("x", 30, 0))!.rate).toBeGreaterThan(signalRate(history("x", 1000, 0))!.rate);
  });

  it("is a function of the sets: the order and a duplicate do not change it", () => {
    const base = surpriseOf(units(5), histories);
    const turned = surpriseOf([...units(5)].reverse(), [...histories].reverse());
    expect(turned).toEqual(base);
    // A duplicate unit with a signal counts one time, and a signal wins over no signal.
    const doubled = surpriseOf([...units(5), { unit: ids[0]!, signal: false }, { unit: ids[0]!, signal: true }], [...histories, history(ids[0]!, 10, 10)]);
    expect(doubled).toEqual(base);
  });

  it("keeps the surprise finite when the p is below the smallest normal double", () => {
    const many = Array.from({ length: 400 }, (_, index) => `u-${String(index)}`);
    const found = surpriseOf(
      many.map((unit) => ({ unit, signal: true })),
      many.map((unit) => history(unit, 100_000, 0)),
    );
    expect(Number.isFinite(found.surprise)).toBe(true);
    expect(found.surprise).toBeCloseTo(1022 * Math.log10(2), 6);
  });

  it("refuses counts that are not whole, or more signals than reads", () => {
    expect(() => signalRate(history("x", 10, 11))).toThrow(RangeError);
    expect(() => signalRate(history("x", 10.5, 1))).toThrow(RangeError);
    expect(() => signalRate(history("x", -1, 0))).toThrow(RangeError);
  });

  it("gives one unit for each dimension of a breadth with a read", () => {
    const breadth: Breadth = {
      signals: ["rail"],
      read: ["rail", "road-traffic"],
      dimensions: [
        { dimension: "road-traffic", read: 3, signals: 0, noRead: 1 },
        { dimension: "rail", read: 2, signals: 1, noRead: 0 },
        { dimension: "air-traffic", read: 0, signals: 0, noRead: 4 },
      ],
    };
    expect(breadthUnits(breadth, "place-1")).toEqual([
      { unit: "place-1/road-traffic", signal: false },
      { unit: "place-1/rail", signal: true },
    ]);
  });
});

describe("the history of the signal units (AL-24)", () => {
  const T0 = Date.UTC(2026, 3, 1, 18, 0, 0);
  const MINUTE = 60_000;
  const rail = (signal: boolean): SignalUnit => ({ unit: "world/rail", signal });
  // A pass every 10 seconds for one hour, each with the same read: one bucket.
  const passes = (start: number, count: number, signal: boolean): BucketReads[] => Array.from({ length: count }, (_, index) => ({ bucket: bucketOf(start + index * 10_000), units: [rail(signal)] }));

  it("counts one read for each bucket, not one read for each pass", () => {
    expect(signalHistories(passes(T0, 360, false))).toEqual([{ unit: "world/rail", reads: 1, signals: 0 }]);
    expect(signalHistories([...passes(T0, 360, false), ...passes(T0 + HISTORY_BUCKET, 360, true)])).toEqual([{ unit: "world/rail", reads: 2, signals: 1 }]);
    expect(bucketOf(T0 + 59 * MINUTE)).toBe(T0);
    expect(bucketOf(T0 + 60 * MINUTE)).toBe(T0 + HISTORY_BUCKET);
  });

  it("adds no read for a bucket with no read of a unit, and a signal adds to both counts", () => {
    const buckets: BucketReads[] = [
      { bucket: T0, units: [rail(false), { unit: "world/road-traffic", signal: true }] },
      { bucket: T0 + HISTORY_BUCKET, units: [{ unit: "world/road-traffic", signal: false }] },
      { bucket: T0 + 2 * HISTORY_BUCKET, units: [rail(true)] },
      { bucket: T0 + 3 * HISTORY_BUCKET, units: [] },
    ];
    expect(signalHistories(buckets)).toEqual([
      { unit: "world/rail", reads: 2, signals: 1 },
      { unit: "world/road-traffic", reads: 2, signals: 1 },
    ]);
    // Two reads of one unit in one bucket count one time, and a signal wins.
    expect(signalHistories([{ bucket: T0, units: [rail(false)] }, { bucket: T0, units: [rail(true)] }])).toEqual([{ unit: "world/rail", reads: 1, signals: 1 }]);
  });

  it("gives no rate for a window shorter than MIN_READS buckets", () => {
    const hours = (count: number): BucketReads[] => Array.from({ length: count }, (_, index) => ({ bucket: T0 + index * HISTORY_BUCKET, units: [rail(index === 0)] }));
    const short = surpriseOf([rail(true)], signalHistories(hours(MIN_READS - 1)));
    expect(short.noRate).toEqual(["world/rail"]);
    expect(short.units).toBe(0);
    const long = surpriseOf([rail(true)], signalHistories(hours(MIN_READS)));
    expect(long.noRate).toEqual([]);
    expect(long.units).toBe(1);
  });

  it("is a function of the set of the reads: the order and a duplicate do not change it (seeded)", () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const r = random(`unit-history:${seed}`);
      const buckets: BucketReads[] = Array.from({ length: 40 }, () => ({
        bucket: T0 + r.below(20) * HISTORY_BUCKET,
        units: Array.from({ length: r.below(4) }, () => ({ unit: `world/unit-${r.below(5)}`, signal: r.chance(0.3) })),
      }));
      const base = signalHistories(buckets);
      const turned = signalHistories(r.shuffle(buckets).map((item) => ({ ...item, units: r.shuffle(item.units) })));
      expect(turned, `seed ${r.seed}`).toEqual(base);
      expect(signalHistories([...buckets, ...r.sample(buckets, 10)]), `seed ${r.seed}`).toEqual(base);
      for (const item of base) expect(item.signals).toBeLessThanOrEqual(item.reads);
    }
  });

  it("refuses a bucket size that is not above 0", () => {
    expect(() => bucketOf(T0, 0)).toThrow(RangeError);
    expect(() => bucketOf(T0, Number.NaN)).toThrow(RangeError);
  });
});

describe("the surprise of the world and of each place (AL-24)", () => {
  const place = "place:a" as PlaceId;
  const breadth: IndicatorBreadth = {
    world: { signals: ["rail"], read: ["rail", "road-traffic"], dimensions: [{ dimension: "road-traffic", read: 2, signals: 0, noRead: 0 }, { dimension: "rail", read: 1, signals: 1, noRead: 0 }] },
    places: [{ place, signals: ["rail"], read: ["rail"], dimensions: [{ dimension: "rail", read: 1, signals: 1, noRead: 0 }] }],
    unplaced: [],
  };

  it("scopes the units of the world as world, and the units of a place by its id", () => {
    expect(indicatorUnits(breadth)).toEqual([
      { unit: "world/road-traffic", signal: false },
      { unit: "world/rail", signal: true },
      { unit: "place/place:a/rail", signal: true },
    ]);
    // A place with the id world does not share the units of the world.
    expect(placeScope("world" as PlaceId)).toBe("place/world");
  });

  it("gives the surprise of the world and of each place from one list of histories", () => {
    const histories = [history("world/rail", 1000, 10), history("world/road-traffic", 1000, 10), history("place/place:a/rail", 1000, 10)];
    const found = indicatorSurprise(breadth, histories);
    expect(found.world).toEqual(surpriseOf(breadthUnits(breadth.world, "world"), histories));
    expect(found.places).toEqual([{ place, ...surpriseOf(breadthUnits(breadth.places[0]!, "place/place:a"), histories) }]);
    expect(found.world.signals).toBe(1);
    expect(found.places[0]!.surprise).toBeGreaterThan(0);
  });
});
