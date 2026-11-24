import { readFileSync } from "node:fs";
import { tryParseUnit } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { LEVELS } from "./contracts.ts";
import { isLifeline, isNeedCode, LIFELINE_LABELS, LIFELINES, NEED_ALERT_LEVELS, NEED_LEVELS, NEEDS, US_GALLON_L } from "./lifelines.ts";

// The lock holds each code that the lifelines and the needs have or had. A plan or a stored record can name each one.
const lock = JSON.parse(readFileSync(new URL("./lifelines.lock.json", import.meta.url), "utf8")) as { lifelines: string[]; needs: string[] };

describe("the FEMA Community Lifelines (AL-106)", () => {
  it("has the 8 lifelines of the toolkit 2.1, in the order of FEMA, with the names of FEMA", () => {
    expect(LIFELINES).toHaveLength(8);
    expect(LIFELINES.map((code) => LIFELINE_LABELS[code])).toEqual([
      "Safety and Security",
      "Food, Hydration, Shelter",
      "Health and Medical",
      "Energy",
      "Communications",
      "Transportation",
      "Hazardous Materials",
      "Water Systems",
    ]);
    expect(Object.keys(LIFELINE_LABELS).sort()).toEqual([...LIFELINES].sort());
  });

  it("tells the code of a lifeline from another text", () => {
    expect(LIFELINES.every(isLifeline)).toBe(true);
    for (const text of ["", "Water Systems", "food", "water.potable", "constructor"]) expect(isLifeline(text), text).toBe(false);
  });
});

describe("the needs of a person (AL-106)", () => {
  it("maps each level of a need to a level of an alert, from the most serious, with no digest", () => {
    const rank = (level: (typeof LEVELS)[number]): number => LEVELS.indexOf(level);
    const ranks = NEED_LEVELS.map((level) => rank(NEED_ALERT_LEVELS[level]));
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
    expect(new Set(ranks).size).toBe(NEED_LEVELS.length);
    expect(Object.values(NEED_ALERT_LEVELS)).not.toContain("digest");
  });

  it("gives each need a code, a lifeline, a level, a unit of the grammar, a positive amount and an official source", () => {
    expect(new Set(NEEDS.map((need) => need.code)).size).toBe(NEEDS.length);
    for (const need of NEEDS) {
      expect(isNeedCode(need.code), need.code).toBe(true);
      expect(isLifeline(need.lifeline), need.code).toBe(true);
      expect(NEED_LEVELS, need.code).toContain(need.level);
      expect(tryParseUnit(need.unit), need.code).toBeTruthy();
      expect(Number.isFinite(need.perPersonDay) && need.perPersonDay > 0, need.code).toBe(true);
      expect(new URL(need.source.url).protocol, need.code).toBe("https:");
      expect(need.source.date, need.code).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("gives the water to drink as one US gallon in litres, and the food as 2,000 kcal", () => {
    expect(US_GALLON_L).toBeCloseTo(231 * 2.54 ** 3 / 1000, 12);
    expect(NEEDS.find((need) => need.code === "hydration.drink")?.perPersonDay).toBe(US_GALLON_L);
    expect(NEEDS.find((need) => need.code === "food.energy")?.perPersonDay).toBe(2000);
  });

  it("gives the infant formula as the largest energy need of the infant rows below 6 months", () => {
    const formula = NEEDS.find((need) => need.code === "food.infant-formula");
    expect(formula?.unit).toBe("kcal");
    expect(formula?.perPersonDay).toBe(589);
    expect(formula?.source.url).toBe("https://nap.nationalacademies.org/26818");
  });

  it("tells the form of a code of a need", () => {
    for (const code of ["hydration.drink", "food.energy", "health.medicine-a"]) expect(isNeedCode(code), code).toBe(true);
    for (const code of ["", "water", "Hydration.drink", "food..energy", "food.", ".food", "food.energy kcal"]) expect(isNeedCode(code), code).toBe(false);
  });
});

describe("the lock of the lifelines and the needs", () => {
  it("holds the 8 lifelines in the order of FEMA", () => {
    expect(lock.lifelines).toEqual([...LIFELINES]);
  });

  it("holds each code of a need, sorted and each one time, so a new code comes into the lock in its pull request", () => {
    expect(lock.needs).toEqual([...new Set(NEEDS.map((need) => need.code))].sort());
  });
});
