import { describe, expect, it } from "vitest";
import { watchProblems } from "./config.ts";
import type { PersonId, PersonWatch, SubjectWatch } from "./contracts.ts";
import * as core from "./index.ts";
import { CLOCK_SUBJECT, COPY_SUBJECT, LOG_SUBJECT, OPERATOR_SYSTEMS, REPORT_SYSTEMS } from "./system-reports.ts";

/** AL-121: each system of the reports about the system has a person who watches it. */

const watch = (person: string, subjects: readonly SubjectWatch[]): PersonWatch => ({ person: person as PersonId, places: [], rules: [], subjects });
const of = (...systems: readonly string[]): SubjectWatch[] => systems.map((system) => ({ system }));
const unwatched = (system: string): string =>
  `No person watches the system ${system}, thus its reports reach no person. Add { "system": "${system}" } to the subjects of the person who operates the system.`;

describe("watchProblems: the watches of the system subjects (AL-121)", () => {
  it("fails a watch of the copy alone, with one problem for each system that no person watches", () => {
    const problems = watchProblems([watch("person-1", of(COPY_SUBJECT))]);
    expect(problems).toEqual(OPERATOR_SYSTEMS.filter((system) => system !== COPY_SUBJECT).map(unwatched));
    expect(problems).toContain(unwatched(CLOCK_SUBJECT));
    expect(problems).toContain(unwatched(LOG_SUBJECT));
  });

  it("finds the clock and the log when each other system has a watch", () => {
    const others = OPERATOR_SYSTEMS.filter((system) => system !== CLOCK_SUBJECT && system !== LOG_SUBJECT);
    expect(watchProblems([watch("person-1", of(...others)), watch("person-2", [])])).toEqual([unwatched(CLOCK_SUBJECT), unwatched(LOG_SUBJECT)]);
  });

  it("names exactly the systems that no person watches, for each set of watched systems", () => {
    const count = OPERATOR_SYSTEMS.length;
    for (let mask = 0; mask < 2 ** count; mask += 1) {
      const watched = OPERATOR_SYSTEMS.filter((_, index) => (mask & (1 << index)) !== 0);
      // The watches go to two people, and a watch with an id counts too.
      const first = watched.filter((_, index) => index % 2 === 0).map((system) => ({ system, id: "one" }));
      const second = of(...watched.filter((_, index) => index % 2 === 1));
      const problems = watchProblems([watch("person-1", first), watch("person-2", second)]);
      expect(problems).toEqual(OPERATOR_SYSTEMS.filter((system) => !watched.includes(system)).map(unwatched));
    }
  });

  it("gives one problem for each system with no people", () => {
    expect(watchProblems([])).toEqual(OPERATOR_SYSTEMS.map(unwatched));
  });

  it("finds a watch of a system that no report has, one time, and keeps the other systems", () => {
    const subjects = [...of(...OPERATOR_SYSTEMS), ...of("alerts.clocks", "alerts.clocks", "alerts.drill", "alerts.person", "alerts.incident", "ugc")];
    expect(watchProblems([watch("person-1", subjects)])).toEqual([
      "The person person-1 watches the system alerts.clocks, and no report has it. The watch matches nothing.",
    ]);
  });

  it("knows each subject system of the core, thus a new system does not look like a wrong name", () => {
    const systems = Object.entries(core)
      .filter(([name, value]) => name.endsWith("_SUBJECT") && typeof value === "string" && value.startsWith("alerts."))
      .map(([, value]) => value as string);
    expect(systems.length).toBeGreaterThanOrEqual(REPORT_SYSTEMS.length);
    expect([...new Set(systems)].sort()).toEqual([...REPORT_SYSTEMS].sort());
  });
});
