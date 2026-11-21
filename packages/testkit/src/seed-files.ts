/**
 * AL-103, part 2: the other files that a start of the runtime reads, at a byte size. `seedShapes` writes the cache of the
 * zone shapes `shapes.sqlite`, and `seedTransit` writes the copy of the transit catalog `transit-catalog.json`. Each file
 * goes through the writer of the runtime, thus its form is the form of a live file.
 *
 * The records are made up, at the rates of a live copy on 2026-11-21:
 *
 * - A zone has approximately 2,400 positions at 6 decimals, and 40 percent of the zones are county zones. The states are
 *   `ZZ`, `ZY` and the next codes. No state has a code that starts with `Z` or `Y`.
 * - The catalog has 27 columns, with rows of approximately 380 bytes. A quarter of the rows are realtime feeds, and a
 *   quarter of these have service alerts. The URLs are on `example.test`, and the contact column is empty.
 *
 * The draws come from one seed. The same seed and the same size give the same file.
 */
import { statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Instant, MapShape, Position } from "@mark1russell7/alerts";
import { openTransitCache, TRANSIT_FILE } from "@mark1russell7/alerts-runtime";
import { openShapeCache, SHAPES_FILE, type ZoneKind } from "@mark1russell7/alerts-shapes-nws";
import { random, seedOf, sha256Hex, type Random } from "@mark1russell7/rigor-generators";
import { openDatabase } from "@mark1russell7/sqlite";
import { stringifyCsv } from "@procedures/json/csv";
import { choose, fileBytes, pagesOf, textOf } from "./seed-parts.ts";

/** The byte sizes of the files of one live copy on 2026-11-21. */
export const LIVE_FILES = { shapes: 30_466_048, transit: 3_122_485 } as const;

/** The options of `seedShapes` and `seedTransit`. */
export interface SeedFileOptions {
  /** The byte size of the file. The function stops at the first record at this size or more. */
  readonly bytes: number;
  /** The seed of the draws: a number, or a name. */
  readonly seed: number | string;
  /** The time of the fetch of each record. The default is 2026-01-01T00:00:00Z. */
  readonly fetched?: Instant;
}

/** The result of `seedShapes`. */
export interface SeedShapesResult {
  /** The path of `shapes.sqlite`. */
  readonly path: string;
  /** The byte size of the file and its write-ahead log after the close. */
  readonly bytes: number;
  /** The count of zones. */
  readonly zones: number;
  /** The count of lists: one for each state and kind. */
  readonly lists: number;
}

/** The result of `seedTransit`. */
export interface SeedTransitResult {
  /** The path of `transit-catalog.json`. */
  readonly path: string;
  /** The byte size of the file. */
  readonly bytes: number;
  /** The count of rows of the catalog. */
  readonly rows: number;
  /** The count of rows of realtime feeds with service alerts. */
  readonly alerts: number;
}

/** The forecast zones of each state. The log of `seedStore` uses the codes of the first state, `ZZZ001` to `ZZZ120`. */
export const SEED_FORECAST_ZONES = 120;
/** The county zones of each state. */
export const SEED_COUNTY_ZONES = 80;
/** The columns of the live catalog, in their order. The reader of the catalog reads 14 of them. */
export const TRANSIT_COLUMNS: readonly string[] = [
  "id",
  "data_type",
  "entity_type",
  "location.country_code",
  "location.subdivision_name",
  "location.municipality",
  "provider",
  "is_official",
  "name",
  "note",
  "feed_contact_email",
  "static_reference",
  "urls.direct_download",
  "urls.authentication_type",
  "urls.authentication_info",
  "urls.api_key_parameter_name",
  "urls.latest",
  "urls.license",
  "location.bounding_box.minimum_latitude",
  "location.bounding_box.maximum_latitude",
  "location.bounding_box.minimum_longitude",
  "location.bounding_box.maximum_longitude",
  "location.bounding_box.extracted_on",
  "status",
  "features",
  "redirect.id",
  "redirect.comment",
];

const START = Date.UTC(2026, 0, 1);
const POSITIONS = 2_400;
const ROW_BYTES = 380;
const LETTERS = "ZYXWVUTSRQPONMLKJIHGFEDCBA";
// The states of the seeded shapes: `ZZ` to `ZA`, then `YZ` to `YA`. No state or marine area has such a code.
const STATES = [..."ZY"].flatMap((first) => [...LETTERS].map((second) => `${first}${second}`));

/**
 * This function writes the cache of the zone shapes `shapes.sqlite` into `dir`, at the byte size `bytes`. The zones of a
 * state have two county zones in each five, thus a small cache also has the live rate. Then each state gets one list for each kind.
 *
 * @throws Error when `bytes` is not a finite number above 0, or when the size needs more states than the seeded states.
 */
export async function seedShapes(dir: string, options: SeedFileOptions): Promise<SeedShapesResult> {
  checkBytes(options.bytes);
  await mkdir(dir, { recursive: true });
  const path = join(dir, SHAPES_FILE);
  const r = random(seedOf(`shapes:${String(options.seed)}`));
  const fetched = options.fetched ?? START;
  const cache = openShapeCache(path);
  const reader = openDatabase(path, { readOnly: true });
  let zones = 0;
  let lists = 0;
  try {
    let onDisk = pagesOf(reader);
    for (const state of STATES) {
      if (onDisk >= options.bytes) break;
      const center: Position = [r.range(-170, 170), r.range(-50, 60)];
      const ids: Record<ZoneKind, string[]> = { county: [], forecast: [], fire: [] };
      for (let step = 0; step < SEED_COUNTY_ZONES + SEED_FORECAST_ZONES && onDisk < options.bytes; step += 1) {
        const kind: ZoneKind = step % 5 === 0 || step % 5 === 2 ? "county" : "forecast";
        const id = `${state}${kind === "county" ? "C" : "Z"}${String(ids[kind].length + 1).padStart(3, "0")}`;
        const shapes = shapesOf(r, [center[0] + r.range(-4, 4), center[1] + r.range(-3, 3)]);
        cache.putZone({ kind, id, state, name: `Seed ${kind} ${id}`, fetched, shapes, condition: { digest: sha256Hex(JSON.stringify(shapes)), etag: `"seed-${id}"` } });
        ids[kind].push(id);
        zones += 1;
        onDisk = pagesOf(reader);
      }
      for (const [kind, list] of Object.entries(ids) as [ZoneKind, string[]][]) {
        if (list.length === 0) continue;
        cache.putList({ state, kind, fetched, ids: list, condition: { digest: sha256Hex(list.join(",")) } }, []);
        lists += 1;
      }
    }
    if (onDisk < options.bytes) throw new Error(`The seeded states give ${String(onDisk)} bytes, less than the size ${String(options.bytes)}.`);
  } finally {
    reader.close();
    cache.close();
  }
  return { path, bytes: fileBytes(path), zones, lists };
}

/**
 * This function writes the copy of the transit catalog `transit-catalog.json` into `dir`, at the byte size `bytes`. The
 * reader of the catalog takes approximately 70 percent of the feeds with service alerts. The others have a key, an
 * inactive status, no box or a redirect.
 *
 * @throws Error when `bytes` is not a finite number above 0.
 */
export async function seedTransit(dir: string, options: SeedFileOptions): Promise<SeedTransitResult> {
  checkBytes(options.bytes);
  await mkdir(dir, { recursive: true });
  const path = join(dir, TRANSIT_FILE);
  const r = random(seedOf(`transit:${String(options.seed)}`));
  const fetched = options.fetched ?? START;
  const lines = [stringifyCsv([TRANSIT_COLUMNS])];
  // The JSON text of the file holds the CSV text in a string: a line break gives 2 bytes, and the frame is approximately 150 bytes.
  let size = 200 + jsonBytes(lines[0]!);
  let rows = 0;
  let alerts = 0;
  while (size < options.bytes) {
    rows += 1;
    const row = rowOf(r, rows, fetched);
    if (row.alert) alerts += 1;
    const line = stringifyCsv([row.cells]);
    lines.push(line);
    size += jsonBytes(line);
  }
  const text = lines.join("");
  openTransitCache(path).write({ text, fetched, condition: { digest: sha256Hex(text) } });
  return { path, bytes: statSync(path).size, rows, alerts };
}

function checkBytes(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0) throw new Error(`The size of the file is ${String(bytes)}, not a finite number above 0.`);
}

// The shapes of one zone: one polygon, or 2 to 4 for a zone with islands. Each ring is a closed ring with 6 decimals.
function shapesOf(r: Random, center: Position): MapShape[] {
  const parts = r.chance(0.15) ? r.int(2, 4) : 1;
  const positions = Math.round(POSITIONS * r.range(0.5, 1.5));
  return Array.from({ length: parts }, (_, part) => {
    const at: Position = part === 0 ? center : [center[0] + r.range(-0.5, 0.5), center[1] + r.range(-0.5, 0.5)];
    const count = Math.max(4, Math.round(positions / parts));
    const radius = r.range(0.05, 0.4);
    const ring: Position[] = Array.from({ length: count }, (_, index) => {
      const angle = (2 * Math.PI * index) / count;
      const reach = radius * r.range(0.8, 1.2);
      return [round6(at[0] + reach * Math.cos(angle)), round6(at[1] + reach * Math.sin(angle))];
    });
    return { type: "polygon", rings: [[...ring, ring[0]!]] };
  });
}

// One row of the catalog. The data types have the shares of the live catalog: 16 percent bikes, 59 percent schedules and
// 25 percent realtime feeds. A quarter of the realtime feeds have service alerts.
function rowOf(r: Random, index: number, fetched: Instant): { readonly cells: readonly string[]; readonly alert: boolean } {
  const type = choose(r, [["gbfs", 16], ["gtfs", 59], ["gtfs_rt", 25]]);
  const entity = type === "gtfs_rt" ? choose(r, [["sa", 9], ["tu|vp|sa", 17], ["tu", 30], ["vp", 30], ["tu|vp", 14]]) : "";
  const alert = entity.split("|").includes("sa");
  const skip = alert ? choose(r, [["none", 71], ["key", 10], ["inactive", 10], ["box", 5], ["redirect", 4]]) : "none";
  const id = `seed-${String(index)}`;
  const provider = `Seed Transit ${String(r.int(1, 2_000))}`;
  const west = r.range(-170, 168);
  const south = r.range(-50, 68);
  const box = skip === "box" ? ["", "", "", ""] : [south, south + r.range(0.05, 2), west, west + r.range(0.05, 2)].map((value) => value.toFixed(6));
  const cells: Record<string, string> = {
    id,
    data_type: type,
    entity_type: entity,
    "location.country_code": "ZZ",
    "location.subdivision_name": `Seed Region ${String(r.int(1, 99))}`,
    "location.municipality": `Seed City ${String(r.int(1, 999))}`,
    provider,
    is_official: r.chance(0.6) ? "True" : "False",
    name: r.chance(0.5) ? `${provider} ${type}` : "",
    note: "",
    feed_contact_email: "",
    static_reference: type === "gtfs_rt" ? `seed-${String(r.int(1, index))}` : "",
    "urls.direct_download": `https://transit.example.test/${id}/${type === "gtfs_rt" ? "alerts.pb" : "feed.zip"}`,
    "urls.authentication_type": skip === "key" ? "2" : "0",
    "urls.authentication_info": skip === "key" ? "https://transit.example.test/keys" : "",
    "urls.api_key_parameter_name": skip === "key" ? "key" : "",
    "urls.latest": type === "gtfs" ? `https://files.example.test/${id}/latest.zip` : "",
    "urls.license": r.chance(0.4) ? "https://transit.example.test/license" : "",
    "location.bounding_box.minimum_latitude": box[0]!,
    "location.bounding_box.maximum_latitude": box[1]!,
    "location.bounding_box.minimum_longitude": box[2]!,
    "location.bounding_box.maximum_longitude": box[3]!,
    "location.bounding_box.extracted_on": skip === "box" ? "" : new Date(fetched - r.int(0, 300) * 86_400_000).toISOString(),
    status: skip === "inactive" ? "inactive" : "active",
    features: "",
    "redirect.id": skip === "redirect" ? `seed-${String(r.int(1, index))}` : "",
    "redirect.comment": "",
  };
  // The note pads the row to the mean size of a live row.
  const room = Math.round(ROW_BYTES * r.range(0.6, 1.4)) - Object.values(cells).reduce((sum, cell) => sum + cell.length + 1, 0);
  if (room > 0) cells["note"] = textOf(r, room);
  return { cells: TRANSIT_COLUMNS.map((column) => cells[column] ?? ""), alert };
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

// The bytes of a text in a JSON string.
function jsonBytes(text: string): number {
  return JSON.stringify(text).length - 2;
}
