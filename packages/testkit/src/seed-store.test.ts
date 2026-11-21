import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportSchema } from "@mark1russell7/alerts";
import { openRuntimeLog, rebuild, type RuntimeEvent } from "@mark1russell7/alerts-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIVE_MIX, LIVE_TYPES, seedStore, type SeedStoreResult } from "./seed-store.ts";

// A small log: approximately 1 hour of the live mix.
const SIZE = 2_000_000;
// A short retention, so that a small log has retirements. The quiet horizon is the horizon.
const RETENTION = { horizon: 5 * 60_000, life: 30 * 60_000, every: 5 * 60_000 };
// The context of the fold of the seeded copy.
const CONTEXT = { sources: [], retention: RETENTION };
// The types of the source path, which the store writes.
const SOURCE_TYPES = ["observation", "fetch", "import", "ended", "exchange"] as const;
// The types of the delivery path, which the dispatcher of the runtime writes (AL-104).
const DELIVERY_TYPES = ["escalation", "escalation-end", "hold", "delivery", "attempt", "cancelled", "refused", "settled"] as const;
// The types with a rate of 2 or more events in each hour of the live log: the frequent types of the delivery path, and
// the system events (AL-104).
const FREQUENT_TYPES = ["escalation", "delivery", "hold", "attempt", "cancelled", "system"] as const;
// The largest ratio between the hourly rate of a frequent type in the seeded log and in the live log. On 5 seeds of
// 36 hours, the worst ratio was 3.4 (2026-11-21). A log has approximately 3 outages of the cell, and most system lines
// and escalations come at an outage. Thus the rates of a log change much between the seeds, as the days of the live log do.
const RATE_FACTOR = 4;
// A mix with more refusals and stops, so that a log of a few hours has each rare type of the delivery path.
const STRESS_MIX = { ...LIVE_MIX, delivery: { ...LIVE_MIX.delivery!, refusal: 0.5, crash: 0.5 } };

let dir: string;
let first: SeedStoreResult;
let again: SeedStoreResult;
let other: SeedStoreResult;
// A log of 36 hours of the live mix, for the rates of the frequent types.
let steady: SeedStoreResult;
// A log of 4.4 hours of the stress mix, for the rare types of the delivery path.
let stress: SeedStoreResult;
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
  steady = await seedStore(join(dir, "e"), { log: 32 * SIZE, seed: "al-104-steady" });
  stress = await seedStore(join(dir, "f"), { log: 4 * SIZE, seed: "al-104-stress", mix: STRESS_MIX });
  events = eventsOf(first.path);
}, 300_000);

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

  it("has each type of the delivery path, from the steps of the dispatcher", () => {
    for (const type of DELIVERY_TYPES) expect(stress.types[type]?.count ?? 0, type).toBeGreaterThan(0);
    const state = rebuild(eventsOf(stress.path), { sources: [] });
    expect(state.starts.length).toBe(stress.types["escalation"]?.count);
    expect(Object.values(state.delivered).reduce((sum, count) => sum + count, 0)).toBe(stress.types["delivery"]?.count);
  });

  it("has the rates of the live log for the frequent types, within a factor of RATE_FACTOR", () => {
    const hours = (steady.end - steady.start) / 3_600_000;
    for (const type of FREQUENT_TYPES) {
      const ratio = (steady.types[type]?.count ?? 0) / hours / ((LIVE_TYPES[type]?.count ?? 0) / (LIVE_MIX.days * 24));
      expect(ratio, type).toBeGreaterThan(1 / RATE_FACTOR);
      expect(ratio, type).toBeLessThan(RATE_FACTOR);
    }
  });

  it("has each family of the system lines of the live log, from the view of the runtime", () => {
    const families = new Set<string>();
    for (const event of eventsOf(steady.path)) {
      if (event.type !== "system") continue;
      for (const report of event.reports) families.add(`${report.kind.code.startsWith("system.coverage.") ? "system.coverage" : report.kind.code}:${report.op}`);
    }
    for (const family of ["system.health.failing", "system.coverage", "system.copy.unread"]) {
      expect(families, family).toContain(`${family}:alert`);
      expect(families, family).toContain(`${family}:cancel`);
    }
  });

  it("refuses a system mix with no delivery mix", async () => {
    const { delivery, ...mix } = LIVE_MIX;
    expect(delivery).toBeDefined();
    await expect(seedStore(join(dir, "g"), { log: SIZE, seed: 1, mix })).rejects.toThrow(/system mix with no delivery mix/u);
  });

  it("writes the delivery path for made-up people only", () => {
    const text = events.map((event) => JSON.stringify(event)).join("\n");
    const people = [...text.matchAll(/"person":"([^"]*)"/gu)].map((match) => match[1]);
    expect(people.length).toBeGreaterThan(0);
    for (const person of people) expect(person).toMatch(/^seed-person-\d+$/u);
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
