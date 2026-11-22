/**
 * AL-124: the home folder of a measure of the runtime. `seedHome` writes a seeded log, the cache files of a start and a
 * made-up configuration. A measure opens the home with `openMeasuredRuntime`, thus no request leaves it.
 *
 * The lab of the capacity models reads the file `capacity-app.json` at the root of the repository. Its seed is the
 * script `seed-home.ts`, and its run is the script `lab-runtime.ts`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FORMAT, type AlertConfig, type ChannelId, type EscalationPolicy, type Instant, type PersonId, type PlaceId } from "@mark1russell7/alerts";
import { CONFIG_FILE } from "@mark1russell7/alerts-runtime";
import { isRecord } from "@mark1russell7/optional/read";
import { LIVE_FILES } from "./seed-files.ts";
import { seedStore, type SeedStoreResult } from "./seed-store.ts";

const MINUTE = 60_000;
const pushover = "pushover" as ChannelId;
const person = "person-1" as PersonId;
const place = "place-1" as PlaceId;
const policy = (level: EscalationPolicy["level"]): EscalationPolicy => ({ level, steps: [{ channel: pushover, at: 0 }], exhaustedAfter: 20 * MINUTE });

/**
 * A made-up configuration with one public point in McMullen County TX. Its keys are the fake keys of `MEASURE_KEYS`. No
 * request leaves a measure.
 */
export const MEASURE_CONFIG: AlertConfig = {
  format: CONFIG_FORMAT,
  places: [
    {
      id: place,
      label: "Place",
      at: [-98.55, 28.3],
      codes: [
        { system: "state", code: "TX" },
        { system: "ugc", code: "TXC311" },
        { system: "same", code: "048311" },
        { system: "iso3166", code: "US" },
      ],
      bufferKm: 5,
    },
  ],
  people: [{ watch: { person, places: [place], rules: [] } }],
  contacts: [{ person, channel: pushover, address: { user: { secret: "PUSHOVER_USER_KEY" } } }],
  policies: [policy("life-safety"), policy("urgent"), policy("notice")],
};

/** The file of the seed record in the home folder. The lab run reads the time of the seeded state from it. */
export const SEED_RECORD_FILE = "seed-record.json";

/** The event of the line that the lab run writes when its runtime operates. The ready signal of `capacity-app.json` waits for it. */
export const LAB_READY = "lab-ready";

/** The options of `seedHome`. */
export interface SeedHomeOptions {
  /** The byte size of the log `runtime.sqlite`. */
  readonly log: number;
  /** The seed of the draws: a number, or a name. */
  readonly seed: number | string;
  /** The byte sizes of the cache files. The default is `LIVE_FILES`: the sizes of one live copy. */
  readonly files?: { readonly shapes: number; readonly transit: number };
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
}

/**
 * This function writes a home folder for a measure: the log of `seedStore` at the byte size `log`, the cache files and
 * the configuration `MEASURE_CONFIG`. Give a new folder or an empty folder. The same seed and sizes give the same log.
 */
export async function seedHome(dir: string, options: SeedHomeOptions): Promise<SeedStoreResult> {
  const files = options.files ?? LIVE_FILES;
  await mkdir(dir, { recursive: true });
  const seeded = await seedStore(dir, { log: options.log, seed: options.seed, shapes: files.shapes, transit: files.transit });
  writeFileSync(join(dir, CONFIG_FILE), JSON.stringify(MEASURE_CONFIG));
  const record: SeedRecord = { seed: options.seed, log: options.log, bytes: seeded.bytes, events: seeded.events, end: seeded.end };
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
  const { seed, log, bytes, events, end } = value;
  if (typeof seed !== "number" && typeof seed !== "string") throw new Error(`The file ${SEED_RECORD_FILE} has no seed.`);
  for (const [name, amount] of Object.entries({ log, bytes, events, end })) {
    if (typeof amount !== "number" || !Number.isFinite(amount)) throw new Error(`The field ${name} of the file ${SEED_RECORD_FILE} is not a finite number.`);
  }
  return { seed, log: log as number, bytes: bytes as number, events: events as number, end: end as Instant };
}
