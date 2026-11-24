import { binomialTest } from "@mark1russell7/rigor-statistics";
import { describe, expect, it } from "vitest";
import type { Breadth } from "./breadth.ts";
import { breadthUnits, MIN_READS, signalRate, surpriseOf, type SignalHistory, type SignalUnit } from "./threat.ts";

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
