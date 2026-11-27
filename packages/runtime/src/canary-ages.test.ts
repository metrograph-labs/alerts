import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANARY_AGE_WINDOW, type SourceId } from "@mark1russell7/alerts";
import { afterEach, describe, expect, it } from "vitest";
import { CANARY_AGES_FILE, CANARY_AGES_FORMAT, CANARY_AGES_SAVE_EVERY, openCanaryAges } from "./canary-ages.ts";

const SOURCE = "feed" as SourceId;
const OTHER = "other" as SourceId;
const T0 = Date.UTC(2026, 10, 27, 12, 0, 0);

const folders: string[] = [];
const pathOf = (): string => {
  const folder = mkdtempSync(join(tmpdir(), "alerts-canary-ages-"));
  folders.push(folder);
  return join(folder, CANARY_AGES_FILE);
};
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe("the canary ages in memory (AL-207)", () => {
  it("keeps the ages of each source, the oldest first, up to the window", () => {
    const ages = openCanaryAges(undefined, { window: 3 });
    expect(ages.ages(SOURCE)).toEqual([]);
    for (const [index, age] of [1, 2, 3, 4].entries()) ages.note(SOURCE, age, T0 + index);
    ages.note(OTHER, 9, T0);
    expect(ages.ages(SOURCE)).toEqual([2, 3, 4]);
    expect(ages.ages(OTHER)).toEqual([9]);
  });

  it("ignores an age that is not a finite number of 0 or more", () => {
    const ages = openCanaryAges(undefined);
    for (const age of [Number.NaN, -1, Number.POSITIVE_INFINITY]) ages.note(SOURCE, age, T0);
    expect(ages.ages(SOURCE)).toEqual([]);
  });

  it("keeps the window of the core by default", () => {
    const ages = openCanaryAges(undefined);
    for (let index = 0; index < CANARY_AGE_WINDOW + 5; index += 1) ages.note(SOURCE, index, T0);
    expect(ages.ages(SOURCE)).toHaveLength(CANARY_AGE_WINDOW);
    expect(ages.ages(SOURCE)[0]).toBe(5);
  });
});

describe("the file of the canary ages (AL-207)", () => {
  it("writes at most once in each save time, and at the close", () => {
    const path = pathOf();
    const ages = openCanaryAges(path);
    ages.note(SOURCE, 1, T0);
    ages.note(SOURCE, 2, T0 + CANARY_AGES_SAVE_EVERY - 1);
    expect(() => statSync(path)).toThrow();
    ages.note(SOURCE, 3, T0 + CANARY_AGES_SAVE_EVERY);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ format: CANARY_AGES_FORMAT, ages: { [SOURCE]: [1, 2, 3] } });
    ages.note(SOURCE, 4, T0 + CANARY_AGES_SAVE_EVERY + 1);
    ages.close();
    expect(JSON.parse(readFileSync(path, "utf8")).ages[SOURCE]).toEqual([1, 2, 3, 4]);
  });

  it("reads the ages of the file at the open, and cuts them to the window", () => {
    const path = pathOf();
    writeFileSync(path, JSON.stringify({ format: CANARY_AGES_FORMAT, ages: { [SOURCE]: [1, 2, 3, 4] } }));
    expect(openCanaryAges(path).ages(SOURCE)).toEqual([1, 2, 3, 4]);
    expect(openCanaryAges(path, { window: 2 }).ages(SOURCE)).toEqual([3, 4]);
  });

  it("starts with no ages when the file is not there, and tells no problem", () => {
    const problems: string[] = [];
    const ages = openCanaryAges(pathOf(), { onBad: (problem) => problems.push(problem) });
    expect(ages.ages(SOURCE)).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("starts with no ages from a broken file, tells the problem, and replaces the file at the next write", () => {
    const path = pathOf();
    const problems: string[] = [];
    writeFileSync(path, "{ not json");
    expect(openCanaryAges(path, { onBad: (problem) => problems.push(problem) }).ages(SOURCE)).toEqual([]);
    writeFileSync(path, JSON.stringify({ format: CANARY_AGES_FORMAT, ages: { [SOURCE]: [-1] } }));
    const ages = openCanaryAges(path, { onBad: (problem) => problems.push(problem) });
    expect(ages.ages(SOURCE)).toEqual([]);
    expect(problems).toEqual([`the file ${CANARY_AGES_FILE} is not JSON`, `the file ${CANARY_AGES_FILE} is not a file of ages`]);
    ages.note(SOURCE, 7, T0);
    ages.close();
    expect(JSON.parse(readFileSync(path, "utf8")).ages[SOURCE]).toEqual([7]);
  });

  it("writes nothing at the close with no new age", () => {
    const path = pathOf();
    openCanaryAges(path).close();
    expect(() => statSync(path)).toThrow();
  });
});
