import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE, openMeasuredRuntime } from "@mark1russell7/alerts-runtime";
import { wallClock } from "@mark1russell7/algebra/clock";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_LEVELS, LAB_READY, MEASURE_CONFIG, measureConfig, readSeedRecord, SEED_RECORD_FILE, seededLine, seedHome } from "./seed-home.ts";
import type { SeedStoreResult } from "./seed-store.ts";

// A small home: approximately 1 hour of the live mix, with small cache files.
const LOG = 2_000_000;
const FILES = { shapes: 1_000_000, transit: 400_000 };
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// A home with levels: a smaller log, 3 feeds near the place, 2 persons and 2 open incidents (AL-126).
const LEVELS = { feeds: 3, persons: 2, incidents: 2 };

let dir: string;
let seeded: SeedStoreResult;
let leveled: SeedStoreResult;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "seed-home-"));
  seeded = await seedHome(join(dir, "home"), { log: LOG, seed: "al-124", files: FILES });
  leveled = await seedHome(join(dir, "levels"), { log: 300_000, seed: "al-126", files: FILES, levels: LEVELS });
}, 180_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// A measured start takes approximately 4 to 5 s in CI. Thus these tests get the limit of the tests of `openMeasuredRuntime`.
describe("seedHome", { timeout: 30_000 }, () => {
  it("writes the log, the configuration and the seed record", () => {
    const home = join(dir, "home");
    expect(JSON.parse(readFileSync(join(home, CONFIG_FILE), "utf8"))).toEqual(MEASURE_CONFIG);
    expect(readSeedRecord(home)).toEqual({ seed: "al-124", log: LOG, bytes: seeded.bytes, events: seeded.events, end: seeded.end, levels: DEFAULT_LEVELS });
    expect(seeded.bytes).toBeGreaterThanOrEqual(LOG);
  });

  it("gives a home that a measured runtime opens, at the time of the seeded state", async () => {
    const home = join(dir, "home");
    const record = readSeedRecord(home);
    const measured = await openMeasuredRuntime(home, { wall: wallClock({ start: record.end }), startSnapshot: true });
    try {
      expect(measured.first.at).toBeGreaterThanOrEqual(record.end);
      expect(measured.instance.loop.times.retryCap).toBeGreaterThan(0);
    } finally {
      await measured.close();
    }
  });

  it("refuses a seed record that is not one", async () => {
    const other = join(dir, "other");
    await mkdir(other);
    writeFileSync(join(other, SEED_RECORD_FILE), JSON.stringify({ seed: 7, log: LOG, bytes: "many", events: 1, end: 1 }));
    expect(() => readSeedRecord(other)).toThrow(/The field bytes/u);
    writeFileSync(join(other, SEED_RECORD_FILE), "7");
    expect(() => readSeedRecord(other)).toThrow(/not hold a JSON object/u);
    writeFileSync(join(other, SEED_RECORD_FILE), JSON.stringify({ seed: 7, log: LOG, bytes: 1, events: 1, end: 1 }));
    expect(() => readSeedRecord(other)).toThrow(/has no levels/u);
    writeFileSync(join(other, SEED_RECORD_FILE), JSON.stringify({ seed: 7, log: LOG, bytes: 1, events: 1, end: 1, levels: { ...DEFAULT_LEVELS, persons: 1.5 } }));
    expect(() => readSeedRecord(other)).toThrow(/The level persons/u);
  });
});

describe("seedHome with levels", { timeout: 30_000 }, () => {
  it("writes the levels in the seed record, and a person for each level of the persons", () => {
    const home = join(dir, "levels");
    expect(readSeedRecord(home).levels).toEqual(LEVELS);
    expect(JSON.parse(readFileSync(join(home, CONFIG_FILE), "utf8"))).toEqual(measureConfig(LEVELS.persons));
    expect(leveled.open).toBe(LEVELS.incidents);
    expect(leveled.transit?.near).toBe(LEVELS.feeds);
    expect(measureConfig(1)).toEqual(MEASURE_CONFIG);
    expect(() => measureConfig(0)).toThrow(RangeError);
  });

  it("gives a start with a polled source for each feed, and a route for each incident and person", async () => {
    const home = join(dir, "levels");
    const record = readSeedRecord(home);
    const measured = await openMeasuredRuntime(home, { wall: wallClock({ start: record.end }), startSnapshot: true, transitLimit: record.levels.feeds });
    try {
      expect(measured.instance.transit?.chosen.feeds).toHaveLength(LEVELS.feeds);
      // The start also has the incidents of the system, for example the health of the sources of a start with no network.
      // Each one reaches each person. Thus the routes of the hazards are persons times incidents.
      const routes = measured.first.delivery?.routes ?? [];
      const hazards = routes.filter((route) => !route.incident.kind.code.startsWith("system."));
      expect(hazards).toHaveLength(LEVELS.persons * LEVELS.incidents);
      expect(new Set(hazards.map((route) => route.person)).size).toBe(LEVELS.persons);
      expect(new Set(hazards.map((route) => route.incident.anchor)).size).toBe(LEVELS.incidents);
      const system = routes.filter((route) => route.incident.kind.code.startsWith("system."));
      const each = new Set(Array.from({ length: LEVELS.persons }, (_, index) => system.filter((route) => route.person === `person-${String(index + 1)}`).length));
      expect(each.size).toBe(1);
    } finally {
      await measured.close();
    }
  });
});

describe("capacity-app.json", () => {
  const app = JSON.parse(readFileSync(join(ROOT, "capacity-app.json"), "utf8")) as {
    readonly variables: readonly { readonly id: string; readonly kind: string }[];
    readonly start: Readonly<Record<"seed" | "run", { readonly argv: readonly string[]; readonly cwd: string; readonly ready?: { readonly text: string } }>>;
  };

  it("names the seed and the run scripts of this package", () => {
    for (const command of [app.start.seed, app.start.run]) {
      expect(existsSync(join(ROOT, command.cwd, command.argv[1] ?? ""))).toBe(true);
    }
  });

  it("gives the bytes that the seed wrote for each store variable in the field amounts of the seed line", () => {
    const line = seededLine(readSeedRecord(join(dir, "home")));
    expect(line).toMatchObject({ ev: "seeded", seed: "al-124", amounts: { log: seeded.bytes } });
    for (const variable of app.variables.filter((each) => each.kind === "store")) {
      expect(line.amounts, variable.id).toHaveProperty(variable.id);
    }
  });

  it("waits for the ready line of the lab run, and the seed sets each store variable", () => {
    expect(JSON.stringify({ ev: LAB_READY, opened: 1 })).toContain(app.start.run.ready?.text ?? "none");
    for (const variable of app.variables.filter((each) => each.kind === "store")) {
      expect(app.start.seed.argv).toContain(`{variable.${variable.id}}`);
    }
  });

  it("has a level variable for each level of a home, in the order of the arguments of the seed script", () => {
    const levels = app.variables.filter((each) => each.kind === "level").map((each) => each.id);
    expect(levels).toEqual(Object.keys(DEFAULT_LEVELS));
    expect(app.start.seed.argv.slice(4)).toEqual(levels.map((id) => `{variable.${id}}`));
    expect(app.start.run.argv.join(" ")).not.toContain("{variable.");
  });
});
