/**
 * The fake of the event files of GDELT (AL-160). The fake gives `lastupdate.txt` and each event file of 15 minutes, as
 * the real service gives them. Each file has `rows` seeded lines of 61 fields in a deflated ZIP archive. Thus a measured
 * start reads, decodes and filters files of the real size, and the CPU profile gives the cost of the source.
 *
 * The share of the lines that `keepEvent` keeps is the share of a real file: a reported root code and the point of a city.
 * The kept lines are at seeded points in the whole world. `near` of them in each file are at the place of the measure, and
 * each one gives a report.
 */
import { createHash } from "node:crypto";
import { eventFilePath, FILE_STEP_MS, GDELT_BASE_URL, LAST_UPDATE_PATH, REPORTED_ROOTS, stampOf } from "@mark1russell7/alerts-source-gdelt";
import { random, seedOf, type Random } from "@mark1russell7/rigor-generators";
import type { FakeReply, FakeRequest } from "./fake-server.ts";
import { MEASURE_PLACE } from "./seed-home.ts";
import { zipArchive } from "./zip.ts";

/** The lines of one event file. A real file of 2026-11-23 had 400 KB of text, and a line has 340 bytes on average. */
export const GDELT_ROWS = 1_200;

/** The share of the lines with a reported root code. A real file has 10 to 15 percent. */
export const GDELT_REPORTED_SHARE = 0.12;

/** The share of the lines with the point of a city or a landmark. A real file has 55 to 65 percent. */
export const GDELT_CITY_SHARE = 0.6;

/** The load of the fake of GDELT. */
export interface GdeltLoad {
  /** The lines of each event file. Default: `GDELT_ROWS`. */
  readonly rows?: number;
  /** The kept lines at the place of the measure in each file. Default: 0, as for a quiet place. */
  readonly near?: number;
  /** The seed of the lines. Default: `lab`. */
  readonly seed?: string;
}

/** A fake of GDELT. */
export interface FakeGdelt {
  /** The host of the files: the host of `GDELT_BASE_URL`. */
  readonly host: string;
  /** This function gives the reply to a request at the host, or `undefined` for a request at another host. */
  handle(request: FakeRequest): FakeReply | undefined;
  /** The event files that the fake gave. */
  files(): number;
}

const OTHER_ROOTS = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13", "15", "16", "17"];
const WORDS = ["council", "minister", "talks", "border", "trade", "rally", "court", "market", "police", "election", "port", "visit"];

/** This function gives the time `YYYYMMDDHHMMSS` of the newest event file at an instant: the last step of 15 minutes. */
export function newestStamp(now: number): string {
  return stampOf(Math.floor(now / FILE_STEP_MS) * FILE_STEP_MS);
}

/** This function gives the text of the event file of the time `stamp`. The same stamp, load and seed give the same text. */
export function gdeltEventText(stamp: string, load: GdeltLoad = {}): string {
  const rows = load.rows ?? GDELT_ROWS;
  const near = Math.min(load.near ?? 0, rows);
  const draw = random(seedOf(`fake-gdelt:${load.seed ?? "lab"}:${stamp}`));
  const lines: string[] = [];
  for (let index = 0; index < rows; index += 1) lines.push(lineOf(draw, stamp, index, index < near));
  return `${lines.join("\n")}\n`;
}

/** This function gives one line of 61 fields. A line at the place has a reported root code and the point of a city. */
function lineOf(draw: Random, stamp: string, index: number, atPlace: boolean): string {
  const field: string[] = Array.from({ length: 61 }, () => "");
  const day = stamp.slice(0, 8);
  const reported = atPlace || draw.chance(GDELT_REPORTED_SHARE);
  const city = atPlace || draw.chance(GDELT_CITY_SHARE);
  const root = reported ? REPORTED_ROOTS[draw.below(REPORTED_ROOTS.length)]! : OTHER_ROOTS[draw.below(OTHER_ROOTS.length)]!;
  const [lon, lat] = atPlace ? (MEASURE_PLACE.at ?? [0, 0]) : [draw.range(-180, 180), draw.range(-60, 70)];
  const words = Array.from({ length: 6 }, () => WORDS[draw.below(WORDS.length)]!).join("-");
  field[0] = String(1_400_000_000 + Number(stamp.slice(8, 12)) * 10_000 + index);
  field[1] = day;
  field[2] = day.slice(0, 6);
  field[3] = day.slice(0, 4);
  field[4] = `${day.slice(0, 4)}.${String(draw.below(10_000)).padStart(4, "0")}`;
  field[5] = "GOV";
  field[6] = "GOVERNMENT";
  field[15] = "CVL";
  field[16] = "CIVILIAN";
  field[25] = "1";
  field[26] = `${root}${String(draw.below(10))}`;
  field[27] = field[26];
  field[28] = root;
  field[29] = String(1 + draw.below(4));
  field[30] = (draw.range(-10, 10)).toFixed(1);
  field[31] = String(1 + draw.below(20));
  field[32] = String(1 + draw.below(5));
  field[33] = String(1 + draw.below(20));
  field[34] = draw.range(-10, 5).toFixed(14);
  field[51] = city ? String(3 + draw.below(2)) : "1";
  field[52] = city ? `City ${String(index)}, Region, Country` : "Country";
  field[53] = "XX";
  field[54] = "XX01";
  field[56] = lat.toFixed(4);
  field[57] = lon.toFixed(4);
  field[58] = city ? String(-1_000_000 - index) : "XX";
  field[59] = stamp;
  field[60] = `https://news.example.test/${day}/${words}-${String(index)}/story.html`;
  return field.join("\t");
}

/** This function makes a fake of GDELT. */
export function createFakeGdelt(load: GdeltLoad = {}): FakeGdelt {
  const host = new URL(GDELT_BASE_URL).host;
  const archives = new Map<string, Uint8Array>();
  let given = 0;
  const archiveOf = (stamp: string): Uint8Array => {
    const found = archives.get(stamp);
    if (found !== undefined) return found;
    const made = zipArchive([{ name: `${stamp}.export.CSV`, text: gdeltEventText(stamp, load) }]);
    archives.set(stamp, made);
    return made;
  };
  const handle = (request: FakeRequest): FakeReply | undefined => {
    if (request.host !== host) return undefined;
    const newest = newestStamp(request.now);
    if (request.path === LAST_UPDATE_PATH) {
      const archive = archiveOf(newest);
      const md5 = createHash("md5").update(archive).digest("hex");
      return { status: 200, headers: { "content-type": "text/plain" }, body: `${String(archive.byteLength)} ${md5} ${GDELT_BASE_URL}${eventFilePath(newest)}\n` };
    }
    const match = /^\/gdeltv2\/([0-9]{14})\.export\.CSV\.zip$/.exec(request.path);
    if (match === null || match[1]! > newest) return { status: 404, headers: { "content-type": "text/plain" }, body: "No such file." };
    given += 1;
    // The archives of old files leave the cache. A start reads the newest 4 files at most.
    for (const stamp of archives.keys()) if (archives.size > 8 && stamp !== match[1]) archives.delete(stamp);
    return { status: 200, headers: { "content-type": "application/zip" }, body: archiveOf(match[1]!) };
  };
  return { host, handle, files: () => given };
}
