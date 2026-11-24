import { describe, expect, it } from "vitest";
import { placeOf, profileSummary, type Profile } from "./cpu-profile.ts";

const frame = (functionName: string, url = "file:///work/repo/packages/core/src/a.ts", lineNumber = 9) => ({ functionName, url, lineNumber });

// The tree: root > program, gc, main > route > assess > assess (a nested call), and main > other.
const PROFILE: Profile = {
  nodes: [
    { id: 1, callFrame: frame("(root)", ""), children: [2, 3, 4] },
    { id: 2, callFrame: frame("(program)", ""), children: [] },
    { id: 3, callFrame: frame("(garbage collector)", ""), children: [] },
    { id: 4, callFrame: frame("main"), children: [5, 8] },
    { id: 5, callFrame: frame("route"), children: [6] },
    { id: 6, callFrame: frame("assess"), children: [7] },
    { id: 7, callFrame: frame("assess"), children: [] },
    { id: 8, callFrame: frame("other", "file:///work/repo/node_modules/lib/index.js", 0), children: [] },
  ],
  // The time before each sample, in microseconds.
  samples: [2, 3, 4, 5, 6, 7, 8],
  timeDeltas: [9_000, 1_000, 500, 1_500, 2_000, 3_000, 4_000],
};

describe("the summary of a CPU profile", () => {
  it("counts the work of the program, with no idle node, program node or garbage collector", () => {
    const summary = profileSummary(PROFILE, { steps: ["route", "assess", "absent"] });
    expect(summary.totalMs).toBe(11);
    expect(summary.gcMs).toBe(1);
    // A nested call of assess counts one time.
    expect(summary.step).toEqual({ route: 6.5, assess: 5, absent: 0 });
    // The two nodes of assess have one key.
    expect(summary.top.slice(0, 2)).toEqual([
      { fn: "assess packages/core/src/a.ts:10", selfMs: 5, share: 0.455, callers: [{ fn: "assess packages/core/src/a.ts:10", selfMs: 3 }, { fn: "route packages/core/src/a.ts:10", selfMs: 2 }] },
      { fn: "other node_modules/lib/index.js:1", selfMs: 4, share: 0.364, callers: [{ fn: "main packages/core/src/a.ts:10", selfMs: 4 }] },
    ]);
    expect(summary.top.map((item) => item.fn)).not.toContain("(program) (native)");
  });

  it("counts only the time under the root, and keeps the count of the list", () => {
    const summary = profileSummary(PROFILE, { root: "route", top: 1 });
    expect(summary.totalMs).toBe(6.5);
    expect(summary.top).toEqual([{ fn: "assess packages/core/src/a.ts:10", selfMs: 5, share: 0.769, callers: [{ fn: "assess packages/core/src/a.ts:10", selfMs: 3 }, { fn: "route packages/core/src/a.ts:10", selfMs: 2 }] }]);
    expect(summary.step).toEqual({});
  });

  it("gives a place with no path of the computer", () => {
    expect(placeOf(frame("f"))).toBe("packages/core/src/a.ts:10");
    expect(placeOf(frame("f", ""))).toBe("(native)");
    expect(placeOf(frame("f", "node:internal/x", 2))).toBe("node:internal/x:3");
  });
});
