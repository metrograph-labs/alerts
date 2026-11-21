import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportSchema } from "@mark1russell7/alerts";
import { openRuntimeLog, rebuild, type RuntimeEvent } from "@mark1russell7/alerts-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIVE_TYPES, seedStore, type SeedStoreResult } from "./seed-store.ts";

// A small log: approximately 1 hour of the live mix.
const SIZE = 2_000_000;
// A short retention, so that a small log has retirements. The quiet horizon is the horizon.
const RETENTION = { horizon: 5 * 60_000, life: 30 * 60_000, every: 5 * 60_000 };
// The context of the fold of the seeded copy.
const CONTEXT = { sources: [], retention: RETENTION };
// The types of the source path, which the store writes.
const SOURCE_TYPES = ["observation", "fetch", "import", "ended", "exchange"] as const;

let dir: string;
let first: SeedStoreResult;
let again: SeedStoreResult;
let other: SeedStoreResult;
let events: readonly RuntimeEvent[];

function eventsOf(path: string): RuntimeEvent[] {
  const log = openRuntimeLog(path);
  try {
    return [...log.read()];
  } finally {
    log.close();
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "seed-store-"));
  first = await seedStore(join(dir, "a"), { log: SIZE, seed: "al-103", retention: RETENTION });
  again = await seedStore(join(dir, "b"), { log: SIZE, seed: "al-103", retention: RETENTION });
  other = await seedStore(join(dir, "c"), { log: SIZE, seed: "al-103-other", retention: RETENTION });
  events = eventsOf(first.path);
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("seedStore", () => {
  it("writes the log to its size", () => {
    expect(first.bytes).toBeGreaterThanOrEqual(SIZE);
    expect(first.bytes).toBeLessThan(SIZE * 1.15);
    expect(events).toHaveLength(first.events);
    expect(Object.values(first.types).reduce((sum, type) => sum + type.count, 0)).toBe(first.events);
  });

  it("gives the same log for the same seed and size, and another log for another seed", () => {
    expect(again.bytes).toBe(first.bytes);
    expect(eventsOf(again.path)).toEqual(events);
    expect(eventsOf(other.path)).not.toEqual(events);
  });

  it("writes a log that the fold of the runtime reads", () => {
    const state = rebuild(events, CONTEXT);
    expect(state.time).toBe(first.end);
    expect(state.merge.reports.length).toBeGreaterThan(0);
    expect(state.imported.merge.reports.length).toBeGreaterThan(0);
    expect(state.merge.retired.length).toBeGreaterThan(0);
  });

  it("has each type of the source path, and no retired event, because the fold retires (AL-109)", () => {
    for (const type of [...SOURCE_TYPES, "started"]) expect(first.types[type]?.count ?? 0, type).toBeGreaterThan(0);
    expect(first.types["retired"]).toBeUndefined();
  });

  it("has the byte mix of the live log, within a factor of 1.5 for each large type", () => {
    const share = (types: Readonly<Record<string, { readonly bytes: number }>>, type: string): number => {
      const total = SOURCE_TYPES.reduce((sum, each) => sum + (types[each]?.bytes ?? 0), 0);
      return (types[type]?.bytes ?? 0) / total;
    };
    for (const type of ["observation", "fetch", "import"]) {
      const ratio = share(first.types, type) / share(LIVE_TYPES, type);
      expect(ratio, type).toBeGreaterThan(1 / 1.5);
      expect(ratio, type).toBeLessThan(1.5);
    }
  });

  it("writes reports that pass the report schema of the core", () => {
    let count = 0;
    for (const event of events) {
      const reports = event.type === "fetch" ? event.reports : event.type === "import" && event.event.type === "fetch" ? event.event.reports : [];
      for (const report of reports) {
        count += 1;
        expect(reportSchema.safeParse(report).success).toBe(true);
      }
    }
    expect(count).toBeGreaterThan(0);
  });

  it("uses only made-up zone codes", () => {
    const text = events.map((event) => JSON.stringify(event)).join("\n");
    const codes = [...text.matchAll(/"system":"ugc","code":"([^"]*)"/gu)].map((match) => match[1]);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) expect(code).toMatch(/^ZZZ\d{3}$/u);
  });

  it("refuses a size that is not above 0", async () => {
    await expect(seedStore(join(dir, "d"), { log: 0, seed: 1 })).rejects.toThrow(/not a finite number above 0/u);
  });
});
