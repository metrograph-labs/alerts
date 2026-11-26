import { describe, expect, it } from "vitest";
import { type ProblemEffect, Problems, type ProblemSink } from "./problems.ts";

describe("Problems", () => {
  it("puts the prefix before each path", () => {
    const problems = new Problems("features[3]");
    problems.add("properties.onset", "a bad time");
    problems.add("", "no report", "fatal");
    expect(problems.list).toEqual([
      { path: "features[3].properties.onset", message: "a bad time", fatal: false, lossy: true },
      { path: "features[3]", message: "no report", fatal: true },
    ]);
  });

  it("keeps each path as it is when it has no prefix", () => {
    const problems = new Problems();
    problems.add("alert.info[0].severity", "an unknown value");
    problems.add("", "an empty path");
    expect(problems.list.map((problem) => problem.path)).toEqual(["alert.info[0].severity", ""]);
  });

  it("gives each problem one effect: a lossy problem is not fatal, and a note is neither", () => {
    const problems = new Problems();
    problems.add("a", "lost");
    problems.add("b", "lost too", "lossy");
    problems.add("c", "more", "note");
    problems.add("d", "no report", "fatal");
    problems.add("e", "skipped by design", "skip");
    expect(problems.list).toEqual([
      { path: "a", message: "lost", fatal: false, lossy: true },
      { path: "b", message: "lost too", fatal: false, lossy: true },
      { path: "c", message: "more", fatal: false },
      { path: "d", message: "no report", fatal: true },
      { path: "e", message: "skipped by design", fatal: false, skipped: true },
    ]);
    expect(problems.list.every((problem) => !(problem.fatal && problem.lossy === true))).toBe(true);
  });

  it("keeps the order of the problems and counts the fatal and the lossy problems", () => {
    const problems = new Problems("m");
    const effects: ProblemEffect[] = ["note", "fatal", "lossy", "fatal", "skip", "fatal", "lossy", "note"];
    for (const [index, effect] of effects.entries()) problems.add(String(index), "p", effect);
    expect(problems.list.map((problem) => problem.path)).toEqual(["m.0", "m.1", "m.2", "m.3", "m.4", "m.5", "m.6", "m.7"]);
    expect([problems.fatal, problems.lossy, problems.skipped]).toEqual([3, 2, 1]);
  });

  it("is a problem sink for a reader", () => {
    const read = (sink: ProblemSink): void => sink.add("x", "from a reader", "note");
    const problems = new Problems("doc");
    read(problems);
    expect(problems.list).toEqual([{ path: "doc.x", message: "from a reader", fatal: false }]);
  });
});
