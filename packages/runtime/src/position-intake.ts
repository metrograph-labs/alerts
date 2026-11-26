/**
 * The intake of the fixes of the moving places (AL-40). A phone app sends its position to the procedure `alerts.position`
 * on the listener of the intake of the operator (`runtimeHost`, AL-95). The body is the JSON of the HTTP mode of OwnTracks.
 *
 * Give this URL to the phone: `http://<host>:<port>/tell/alerts/position`. The port is the field `port` of the entry `tell`.
 * The listener is on the loopback address, thus a proxy of the private network takes the calls of the phone to it.
 * The phone sends the token of the intake as the password of HTTP Basic auth. The user name has no effect.
 *
 * The fixes stay on this copy. No log line, no problem text, no exchange page and no payload of a route holds a position.
 * The file `fixes.json` in the home keeps the last fix of each moving place over a restart.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "@procedures/fs/files";
import { nextFix, placeOfDevice, staleMovingPlaces, type AlertConfig, type FixRefusal, type Instant, type PlaceId, type PositionFix, type ReadHealth } from "@mark1russell7/alerts";
import * as z from "zod";

/** The path of the procedure that takes a fix. */
export const POSITION_PATH: readonly string[] = Object.freeze(["alerts", "position"]);

/** The name of the procedure that takes a fix. */
export const POSITION_KEY = "alerts.position";

/** The file of the last fix of each moving place, in the home of the runtime. */
export const FIXES_FILE = "fixes.json";

/** The format of the file `fixes.json`. */
export const FIXES_FORMAT = "alerts-fixes/1";

/** The error of a refused body. The procedures host gives the code `BAD_REQUEST` and the message to the phone. The message holds no position. */
export class PositionRefusal extends Error {
  readonly code = "BAD_REQUEST";

  constructor(message: string) {
    super(message);
    this.name = "PositionRefusal";
  }
}

// Each message of OwnTracks has a type. Only a location gives a fix.
const messageSchema = z.looseObject({ _type: z.string() });

// The fields of a location of OwnTracks: degrees, the doubt in meters, the time in epoch seconds and the tracker id.
const locationSchema = z.looseObject({
  _type: z.literal("location"),
  lat: z.number(),
  lon: z.number(),
  acc: z.number(),
  tst: z.number(),
  tid: z.string(),
});

const fixSchema = z.strictObject({
  place: z.string(),
  at: z.tuple([z.number(), z.number()]),
  accuracyKm: z.number(),
  observedAt: z.number(),
});

const fileSchema = z.strictObject({ format: z.literal(FIXES_FORMAT), fixes: z.array(fixSchema) });

/** The options of `createPositionIntake`. */
export interface PositionIntakeOptions {
  /** The configuration. Only its moving places take fixes. */
  readonly config: AlertConfig;
  /** The fixes of the file `fixes.json` at the start (`readFixes`). */
  readonly fixes?: ReadonlyMap<PlaceId, PositionFix>;
  /** This function writes the fixes after each fix that the intake keeps. Without it, the fixes stay in memory. */
  readonly write?: (fixes: ReadonlyMap<PlaceId, PositionFix>) => Promise<void>;
  /** This function gets each failed write. Its error holds no position. */
  readonly onFault?: (error: unknown) => void;
}

/** The intake of the fixes: the last good fix of each moving place, and the cause of its last refused fix. */
export interface PositionIntake {
  /**
   * This function takes one message of the phone, and gives an empty list: OwnTracks reads the answer as a list of messages.
   * It keeps a location only when `nextFix` takes it. It ignores each other type of message.
   * @throws PositionRefusal for a body that is not a message, or for a location of an unknown device.
   */
  take(body: unknown): [];
  /** This function gives the last good fix of each moving place. */
  fixes(): ReadonlyMap<PlaceId, PositionFix>;
  /** This function gives the cause of the last refused fix of each moving place, since its last good fix. */
  refusals(): ReadonlyMap<PlaceId, FixRefusal>;
  /** This function gives a promise that ends after the last write. */
  flush(): Promise<void>;
}

/** This function gives an intake with the fixes of the start. */
export function createPositionIntake(options: PositionIntakeOptions): PositionIntake {
  const places = options.config.places;
  const fixes = new Map<PlaceId, PositionFix>(options.fixes ?? []);
  const refusals = new Map<PlaceId, FixRefusal>();
  let writing: Promise<void> = Promise.resolve();
  return {
    take(body) {
      const message = messageSchema.safeParse(body);
      if (!message.success) throw new PositionRefusal("The body is not a message of OwnTracks.");
      if (message.data._type !== "location") return [];
      const location = locationSchema.safeParse(body);
      if (!location.success) throw new PositionRefusal("The location has no valid lat, lon, acc, tst or tid.");
      const place = placeOfDevice(places, location.data.tid);
      if (place === undefined) throw new PositionRefusal("No moving place has this device.");
      const fix: PositionFix = { place: place.id, at: [location.data.lon, location.data.lat], accuracyKm: location.data.acc / 1000, observedAt: location.data.tst * 1000 };
      const step = nextFix(place, fixes.get(place.id), fix);
      if (step.refused !== undefined) {
        refusals.set(place.id, step.refused);
        return [];
      }
      if (step.fix !== undefined) fixes.set(place.id, step.fix);
      refusals.delete(place.id);
      const write = options.write;
      if (write !== undefined) {
        // The writes go one after the other. Each one writes the fixes of its time.
        const copy = new Map(fixes);
        writing = writing.then(() => write(copy)).catch((error: unknown) => options.onFault?.(error));
      }
      return [];
    },
    fixes: () => fixes,
    refusals: () => refusals,
    flush: () => writing,
  };
}

/** This function gives the text of the file `fixes.json`. */
export function fixesText(fixes: ReadonlyMap<PlaceId, PositionFix>): string {
  return `${JSON.stringify({ format: FIXES_FORMAT, fixes: [...fixes.values()] }, null, 2)}\n`;
}

/** This function writes the file `fixes.json` in the home atomically. Only the user of the file can read it. */
export async function writeFixes(home: string, fixes: ReadonlyMap<PlaceId, PositionFix>): Promise<void> {
  await writeFileAtomic(join(home, FIXES_FILE), fixesText(fixes), { mode: 0o600 });
}

/**
 * This function reads the file `fixes.json` in the home. It keeps only the fixes of the moving places of the configuration.
 * A missing file gives no fix. A broken file gives no fix and a problem with no position.
 */
export async function readFixes(home: string, config: AlertConfig): Promise<{ readonly fixes: ReadonlyMap<PlaceId, PositionFix>; readonly problem?: string }> {
  let text: string;
  try {
    text = await readFile(join(home, FIXES_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { fixes: new Map() };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { fixes: new Map(), problem: `The file ${FIXES_FILE} is not JSON. The runtime starts with no fix.` };
  }
  const file = fileSchema.safeParse(parsed);
  if (!file.success) return { fixes: new Map(), problem: `The file ${FIXES_FILE} is not of the format ${FIXES_FORMAT}. The runtime starts with no fix.` };
  const moving = new Set(config.places.filter((place) => place.moving !== undefined).map((place) => place.id));
  const fixes = new Map<PlaceId, PositionFix>();
  for (const fix of file.data.fixes) {
    const place = fix.place as PlaceId;
    if (moving.has(place)) fixes.set(place, { place, at: fix.at, accuracyKm: fix.accuracyKm, observedAt: fix.observedAt });
  }
  return { fixes };
}

/**
 * This function gives the identity of a call of the intake from its `Authorization` header. A Basic header gives its
 * password as the token. Thus a phone app with a user and a password calls the intake. Each other header gives no change,
 * and the host compares the Bearer token of the call.
 */
export function basicPrincipal(credentials: { readonly headers?: Readonly<Record<string, string>> | undefined }): { readonly bearer?: string } {
  const header = credentials.headers?.["authorization"];
  const match = header === undefined ? null : /^Basic\s+([A-Za-z0-9+/=]+)\s*$/iu.exec(header);
  if (match?.[1] === undefined) return {};
  const pair = Buffer.from(match[1], "base64").toString("utf8");
  const colon = pair.indexOf(":");
  // A Basic header with no colon has no password. An empty token matches no token of the intake.
  return { bearer: colon < 0 ? "" : pair.slice(colon + 1) };
}

/**
 * This function gives the read of the fixes of each moving place for the health route. It holds the time of the last good
 * fix and no position. The read fails when the place has no fresh fix. The next time is the end of the age limit of the fix.
 */
export function fixReads(config: AlertConfig, fixes: ReadonlyMap<PlaceId, PositionFix>, refusals: ReadonlyMap<PlaceId, FixRefusal>, now: Instant): ReadHealth[] {
  const stale = new Set(staleMovingPlaces(config, fixes, now));
  return config.places.flatMap((place): ReadHealth[] => {
    if (place.moving === undefined) return [];
    const fix = fixes.get(place.id);
    const limit = place.moving.maxAgeMinutes * 60_000;
    const refused = refusals.get(place.id);
    const what = `fixes of the moving place ${place.id}${refused === undefined ? "" : ` (last fix refused: ${refused})`}`;
    if (fix === undefined) return [{ what, at: null, failed: true, next: null }];
    return [{ what, at: fix.observedAt, failed: stale.has(place.id), next: fix.observedAt + limit }];
  });
}
