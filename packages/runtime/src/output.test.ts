import { describe, expect, it } from "vitest";
import { fakeWallClock } from "@mark1russell7/algebra/clock";
import type { ConsoleTarget, LogLevel } from "@mark1russell7/service";
import { outputOf, timedLogger } from "./output.ts";

const T0 = Date.UTC(2026, 10, 22, 14, 30, 5, 250);

/** This function gives a console target that keeps each line with its level. */
function capture(): { readonly target: ConsoleTarget; readonly lines: [LogLevel, string][] } {
  const lines: [LogLevel, string][] = [];
  const keep = (level: LogLevel) => (...data: unknown[]) => lines.push([level, data.map(String).join(" ")]);
  return { target: { debug: keep("debug"), info: keep("info"), warn: keep("warn"), error: keep("error") }, lines };
}

describe("the output of the runtime and of the supervisor (AL-120)", () => {
  it("starts each line with the time of the wall clock, and each stream goes to its level", () => {
    const wall = fakeWallClock(T0);
    const { target, lines } = capture();
    const out = outputOf(timedLogger({ wall, console: target }));
    out.log("The API serves the local page at the path /.");
    wall.set(T0 + 61_000);
    out.warn("A warning.");
    out.error("A pass failed (2 in sequence): a reason\n- a second line");
    expect(lines).toEqual([
      ["info", "2026-11-22T14:30:05.250Z The API serves the local page at the path /."],
      ["warn", "2026-11-22T14:31:06.250Z A warning."],
      ["error", "2026-11-22T14:31:06.250Z A pass failed (2 in sequence): a reason\n- a second line"],
    ]);
  });

  it("writes the text of a line as it is, with no fields after it", () => {
    const { target, lines } = capture();
    const out = outputOf(timedLogger({ wall: fakeWallClock(T0), console: target }));
    out.log("50 % of the limit, {\"a\": 1}");
    expect(lines).toEqual([["info", "2026-11-22T14:30:05.250Z 50 % of the limit, {\"a\": 1}"]]);
  });

  it("uses the real wall clock when the options give no clock", () => {
    const { target, lines } = capture();
    const before = Date.now();
    outputOf(timedLogger({ console: target })).log("A line.");
    const after = Date.now();
    const [level, line] = lines[0] ?? ["debug", ""];
    expect(level).toBe("info");
    const time = Date.parse(line.slice(0, line.indexOf(" ")));
    expect(time).toBeGreaterThanOrEqual(before);
    expect(time).toBeLessThanOrEqual(after);
    expect(line.slice(line.indexOf(" ") + 1)).toBe("A line.");
  });
});
