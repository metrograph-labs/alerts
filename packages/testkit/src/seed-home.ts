/**
 * AL-124: the home folder of a measure of the runtime. `seedHome` writes a seeded log, the cache files of a start and a
 * made-up configuration. A measure opens the home with `openMeasuredRuntime`, thus no request leaves it.
 *
 * The lab of the capacity models reads the file `capacity-app.json` at the root of the repository. Its seed is the
 * script `seed-home.ts`, and its run is the script `lab-runtime.ts`.
 *
 * AL-126: the levels of the configuration (`SeedLevels`) set the size of the home. They are the persons of the configuration,
 * the transit feeds near its place and the open incidents at its place. The seed record keeps them, thus the lab run reads
 * the levels from the home, not from its command line.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FORMAT, type AlertConfig, type Area, type ChannelId, type EscalationPolicy, type Instant, type PersonId, type PlaceConfig, type PlaceId, type Position } from "@mark1russell7/alerts";
import { CONFIG_FILE } from "@mark1russell7/alerts-runtime";
import { isRecord } from "@mark1russell7/optional/read";
import { LIVE_FILES } from "./seed-files.ts";
import { seedStore, type SeedStoreResult } from "./seed-store.ts";

const MINUTE = 60_000;
const pushover = "pushover" as ChannelId;
const place = "place-1" as PlaceId;
const point: Position = [-98.55, 28.3];
const policy = (level: EscalationPolicy["level"]): EscalationPolicy => ({ level, steps: [{ channel: pushover, at: 0 }], exhaustedAfter: 20 * MINUTE });

/** The one place of a measure: one public point in McMullen County TX. */
export const MEASURE_PLACE: PlaceConfig = {
  id: place,
  label: "Place",
  at: point,
  codes: [
    { system: "state", code: "TX" },
    { system: "ugc", code: "TXC311" },
    { system: "same", code: "048311" },
    { system: "iso3166", code: "US" },
  ],
  bufferKm: 5,
};

/** The areas of the open incidents of a measure: the county zone of `MEASURE_PLACE`. */
export const MEASURE_AREAS: readonly Area[] = [{ type: "code", system: "ugc", code: "TXC311" }];

/**
 * This function gives a made-up configuration with the place `MEASURE_PLACE` and `persons` persons. Each person watches the
 * place and has one Pushover contact. The keys are the fake keys of `MEASURE_KEYS`, and no request leaves a measure.
 *
 * @throws RangeError when `persons` is not a whole number above 0.
 */
export function measureConfig(persons: number): AlertConfig {
  if (!(Number.isInteger(persons) && persons >= 1)) throw new RangeError(`The count of the persons is ${String(persons)}, not a whole number above 0.`);
  const ids = Array.from({ length: persons }, (_, index) => `person-${String(index + 1)}` as PersonId);
  return {
    format: CONFIG_FORMAT,
    places: [MEASURE_PLACE],
    people: ids.map((person) => ({ watch: { person, places: [place], rules: [] } })),
    contacts: ids.map((person) => ({ person, channel: pushover, address: { user: { secret: "PUSHOVER_USER_KEY" } } })),
    policies: [policy("life-safety"), policy("urgent"), policy("notice")],
  };
}

/** The configuration of a measure with one person. */
export const MEASURE_CONFIG: AlertConfig = measureConfig(1);

/** The file of the seed record in the home folder. The lab run reads the time of the seeded state from it. */
export const SEED_RECORD_FILE = "seed-record.json";

/** The event of the line that the lab run writes when its runtime operates. The ready signal of `capacity-app.json` waits for it. */
export const LAB_READY = "lab-ready";

/** The event of the line of each pass of the lab run after the ready line. The line kind `pass` of `capacity-app.json` names it (CAP-65). */
export const LAB_PASS = "lab-pass";

/** The event of the line of each write of the snapshot of the start in the lab run. The line kind `write` of `capacity-app.json` names it (CAP-65). */
export const LAB_SNAPSHOT_WRITE = "lab-snapshot-write";

/**
 * The event of the line of the amounts of the lab run (AL-154): the routes, the holds of the send limit and the suppressions
 * of the throttle. The line kind `amounts` of `capacity-app.json` names it, and the start laws read each amount as a variable.
 */
export const LAB_AMOUNTS = "lab-amounts";

/**
 * The event of the line of the readings of the live metrics in the lab run (AL-132). The reader of `@mark1russell7/otel-ts/pull`
 * gives the readings, with one series for each metric (AL-135).
 */
export const LAB_READINGS = "lab-readings";

/** The levels of the configuration of a home (AL-126). They are the level variables of `capacity-app.json`. */
export interface SeedLevels {
  /**
   * The transit feeds near the place, in the copy of the catalog. Each feed is one polled source of the start. A live copy
   * reads `MAX_TRANSIT_FEEDS` feeds at most, thus the lab run gives this count as the limit of the start.
   */
  readonly feeds: number;
  /** The persons of the configuration, 1 or more. A route is one incident and one person. */
  readonly persons: number;
  /** The incidents that are open at the place at the end of the log. Each one reaches each person. */
  readonly incidents: number;
}

/** The levels of a home with no option `levels`: one person, no feed near the place and no open incident. */
export const DEFAULT_LEVELS: SeedLevels = { feeds: 0, persons: 1, incidents: 0 };

/** The options of `seedHome`. */
export interface SeedHomeOptions {
  /** The byte size of the log `runtime.sqlite`. */
  readonly log: number;
  /** The seed of the draws: a number, or a name. */
  readonly seed: number | string;
  /** The byte sizes of the cache files. The default is `LIVE_FILES`: the sizes of one live copy. */
  readonly files?: { readonly shapes: number; readonly transit: number };
  /** The levels of the configuration. Each level that is absent has its value in `DEFAULT_LEVELS`. */
  readonly levels?: Partial<SeedLevels>;
}

/** The record of a seeded home, in the file `SEED_RECORD_FILE`. */
export interface SeedRecord {
  /** The seed of the draws. */
  readonly seed: number | string;
  /** The byte size that the seed asked for the log. */
  readonly log: number;
  /** The byte size of the log and its write-ahead log after the seed. */
  readonly bytes: number;
  /** The count of events of the log. */
  readonly events: number;
  /** The time of the state after the last event. The wall clock of a measure starts at this time. */
  readonly end: Instant;
  /** The levels of the configuration of the home. */
  readonly levels: SeedLevels;
}

/**
 * This function writes the home folder of a measure: the log of `seedStore` at the size `log`, the cache files and
 * the configuration of `measureConfig`. Give a new folder or an empty folder. The same seed, sizes and levels give the same home.
 *
 * @throws RangeError when a level is not a whole number, or when the persons are fewer than 1.
 */
export async function seedHome(dir: string, options: SeedHomeOptions): Promise<SeedStoreResult> {
  const files = options.files ?? LIVE_FILES;
  const levels: SeedLevels = { ...DEFAULT_LEVELS, ...options.levels };
  const config = measureConfig(levels.persons);
  await mkdir(dir, { recursive: true });
  const seeded = await seedStore(dir, {
    log: options.log,
    seed: options.seed,
    shapes: files.shapes,
    transit: files.transit,
    near: { at: point, feeds: levels.feeds },
    open: { incidents: levels.incidents, areas: MEASURE_AREAS },
  });
  writeFileSync(join(dir, CONFIG_FILE), JSON.stringify(config));
  const record: SeedRecord = { seed: options.seed, log: options.log, bytes: seeded.bytes, events: seeded.events, end: seeded.end, levels };
  writeFileSync(join(dir, SEED_RECORD_FILE), `${JSON.stringify(record)}\n`);
  return seeded;
}

/** The last line of the seed script: the event, the seed record and the bytes of each store variable. */
export interface SeededLine extends SeedRecord {
  readonly ev: "seeded";
  /** The bytes that the seed wrote for each store variable of `capacity-app.json`. This is the seed protocol of `capacity-app/1`. */
  readonly amounts: { readonly log: number };
}

/** This function gives the last line of the seed script. The lab of the capacity models reads the size of a point from `amounts`. */
export function seededLine(record: SeedRecord): SeededLine {
  return { ev: "seeded", ...record, amounts: { log: record.bytes } };
}

/**
 * This function reads the seed record of a home folder.
 *
 * @throws {Error} when the file is not a seed record. A measure that cannot read the time of the seeded state stops.
 */
export function readSeedRecord(dir: string): SeedRecord {
  const value: unknown = JSON.parse(readFileSync(join(dir, SEED_RECORD_FILE), "utf8"));
  if (!isRecord(value)) throw new Error(`The file ${SEED_RECORD_FILE} does not hold a JSON object.`);
  const { seed, log, bytes, events, end, levels } = value;
  if (typeof seed !== "number" && typeof seed !== "string") throw new Error(`The file ${SEED_RECORD_FILE} has no seed.`);
  for (const [name, amount] of Object.entries({ log, bytes, events, end })) {
    if (typeof amount !== "number" || !Number.isFinite(amount)) throw new Error(`The field ${name} of the file ${SEED_RECORD_FILE} is not a finite number.`);
  }
  if (!isRecord(levels)) throw new Error(`The file ${SEED_RECORD_FILE} has no levels.`);
  const { feeds, persons, incidents } = levels;
  for (const [name, amount] of Object.entries({ feeds, persons, incidents })) {
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0) {
      throw new Error(`The level ${name} of the file ${SEED_RECORD_FILE} is not a whole number, 0 or more.`);
    }
  }
  return { seed, log: log as number, bytes: bytes as number, events: events as number, end: end as Instant, levels: { feeds: feeds as number, persons: persons as number, incidents: incidents as number } };
}
