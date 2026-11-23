import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { FetchOutcome, PlaceId, Watch } from "@mark1russell7/alerts";
import { crc32 } from "@mark1russell7/files/archive";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";

import { checkCanary } from "./check.ts";
import { createGdeltFetch, eventFilePath, headBody, LAST_UPDATE_PATH, readEventFile, readLastUpdate, stampsToRead } from "./fetch.ts";
import { mapObservation } from "./map.ts";
import { addedTime } from "./row.ts";

/** The 5 real lines of the event file of 2026-11-23 20:00 UTC (`fixtures/README.md`). */
const TEXT = readFileSync(new URL("../fixtures/events-20261123200000.tsv", import.meta.url), "utf8");
const STAMP = "20261123200000";
const START = addedTime(STAMP)! + 5 * 60_000;
const BASE = "https://gdelt.test";
const MIN = 60_000;

/** A place of the tests. The requests hold no place. */
const WATCH: Watch = { places: [{ id: "a" as PlaceId, codes: [{ system: "iso3166", code: "HT" }], at: [-72.335, 18.539], bufferKm: 0 }] };

/** This function writes a ZIP archive whose entries are stored with no compression. It is only for the tests. */
function storedZip(entries: readonly { readonly name: string; readonly text: string }[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, text } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(text, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

/** This function gives the time `YYYYMMDDHHMMSS` that is `minutes` after the time of the fixture. */
const stampAfter = (minutes: number): string => new Date(addedTime(STAMP)! + minutes * MIN).toISOString().replace(/\D/g, "").slice(0, 14);

/** This function gives the archive of an event file of the time `stamp`, with the real lines and that time of addition. */
const archiveOf = (stamp: string): Uint8Array => storedZip([{ name: `${stamp}.export.CSV`, text: TEXT.replaceAll("\t20261123200000\t", `\t${stamp}\t`) }]);

/** This function gives the text of `lastupdate.txt` for an archive, in the real format. */
const lastUpdateOf = (stamp: string, archive: Uint8Array, md5 = createHash("md5").update(archive).digest("hex")): string =>
  [
    `${archive.byteLength} ${md5} http://data.gdeltproject.org/gdeltv2/${stamp}.export.CSV.zip`,
    `48251 0123456789abcdef0123456789abcdef http://data.gdeltproject.org/gdeltv2/${stamp}.mentions.CSV.zip`,
    `6876277 fedcba9876543210fedcba9876543210 http://data.gdeltproject.org/gdeltv2/${stamp}.gkg.csv.zip`,
  ].join("\n");

const text = (body: string, status = 200): Reply => ({ status, statusText: status === 200 ? "OK" : "Error", headers: { "content-type": "text/plain" }, body });
const bytes = (data: Uint8Array): Reply => ({ status: 200, statusText: "OK", headers: { "content-type": "application/zip" }, body: "", bytes: data });
const missing: Reply = { status: 404, statusText: "Not Found", headers: {}, body: "" };

/** This function makes a fetch whose transport answers from a map of paths. Each test changes the map between fetches. */
const fetchWith = (routes: Map<string, Reply>) => {
  const sent: Exchange[] = [];
  const transport: Transport = async (exchange) => {
    sent.push(exchange);
    const path = new URL(exchange.url).pathname;
    return routes.get(path) ?? missing;
  };
  let time = START;
  const clock = { now: () => time, sleep: async (ms: number) => void (time += ms) };
  const fetch = createGdeltFetch({ pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport, userAgent: "alerts-tests", baseUrl: BASE, minIntervalMs: 0, timeoutMs: 1000 });
  return { fetch: () => fetch({ watch: WATCH }), sent, move: (ms: number) => void (time += ms) };
};

/** This function puts the event file of `stamp` in the routes, and names it in `lastupdate.txt`. */
const publish = (routes: Map<string, Reply>, stamp: string): void => {
  const archive = archiveOf(stamp);
  routes.set(eventFilePath(stamp), bytes(archive));
  routes.set(LAST_UPDATE_PATH, text(lastUpdateOf(stamp, archive)));
};

const bodiesOf = (outcome: FetchOutcome): Record<string, unknown>[] => (outcome.ok ? outcome.observations.map((observation) => JSON.parse(observation.body) as Record<string, unknown>) : []);
const pathsOf = (sent: readonly Exchange[]): string[] => sent.map((exchange) => new URL(exchange.url).pathname);

describe("readLastUpdate", () => {
  it("reads the line of the event file in the real format", () => {
    const archive = archiveOf(STAMP);
    expect(readLastUpdate(lastUpdateOf(STAMP, archive))).toEqual({ stamp: STAMP, size: archive.byteLength, md5: createHash("md5").update(archive).digest("hex") });
  });

  it("gives undefined for a text with no event file", () => {
    expect(readLastUpdate("")).toBeUndefined();
    expect(readLastUpdate("<html>moved</html>")).toBeUndefined();
    expect(readLastUpdate("1 0123456789abcdef0123456789abcdef http://data.gdeltproject.org/gdeltv2/20261131000000.export.CSV.zip")).toBeUndefined();
  });
});

describe("stampsToRead", () => {
  it("reads only the newest file at the first fetch, and the files after the last one later", () => {
    expect(stampsToRead(undefined, STAMP)).toEqual({ stamps: [STAMP], dropped: 0 });
    expect(stampsToRead(STAMP, STAMP)).toEqual({ stamps: [], dropped: 0 });
    expect(stampsToRead(STAMP, stampAfter(30))).toEqual({ stamps: [stampAfter(15), stampAfter(30)], dropped: 0 });
  });

  it("reads at most the newest 4 files after a gap, and counts the files that it drops", () => {
    expect(stampsToRead(STAMP, stampAfter(120))).toEqual({ stamps: [stampAfter(75), stampAfter(90), stampAfter(105), stampAfter(120)], dropped: 4 });
  });
});

describe("readEventFile", () => {
  it("reads the kept events of a real file, and examines the size and the digest", () => {
    const archive = archiveOf(STAMP);
    const expected = readLastUpdate(lastUpdateOf(STAMP, archive))!;
    const file = readEventFile(archive, STAMP, expected);
    expect(typeof file).toBe("object");
    expect(file).toMatchObject({ lines: 5, parsed: 5 });
    expect(typeof file === "object" ? file.bodies.map((body) => (JSON.parse(body) as { id: string }).id) : []).toEqual(["1334657047", "1334657169", "1334657442"]);
    expect(readEventFile(archive, STAMP, { ...expected, size: expected.size + 1 })).toMatch(/bytes/);
    expect(readEventFile(archive, STAMP, { ...expected, md5: "0".repeat(32) })).toMatch(/MD5/);
  });

  it("gives the text of the fault for bytes that are not one event file", () => {
    expect(readEventFile(new Uint8Array([1, 2, 3]), STAMP)).toMatch(/not valid/);
    expect(readEventFile(archiveOf(STAMP), stampAfter(15))).toMatch(/no file/);
  });
});

describe("createGdeltFetch", () => {
  it("reads lastupdate.txt and the newest file, with no place, and gives the kept events and a head", async () => {
    const routes = new Map<string, Reply>();
    publish(routes, STAMP);
    const { fetch, sent } = fetchWith(routes);
    const outcome = await fetch();
    expect(outcome.ok && outcome.complete).toBe(true);
    expect(outcome.ok ? outcome.asOf : undefined).toBe(addedTime(STAMP));
    expect(pathsOf(sent)).toEqual([LAST_UPDATE_PATH, eventFilePath(STAMP)]);
    expect(sent.every((exchange) => !exchange.url.includes("?") && !/haiti|18\.5|-72/i.test(exchange.url))).toBe(true);
    expect(bodiesOf(outcome).map((body) => body["id"] ?? body["file"])).toEqual(["1334657047", "1334657169", "1334657442", STAMP]);
    expect(bodiesOf(outcome).at(-1)).toEqual({ file: STAMP, lines: 5, parsed: 5, kept: 3 });
  });

  it("gives the head again when no new file is there, and reads each new file after it", async () => {
    const routes = new Map<string, Reply>();
    publish(routes, STAMP);
    const { fetch, sent, move } = fetchWith(routes);
    const first = await fetch();
    move(10 * MIN);
    const again = await fetch();
    expect(pathsOf(sent).slice(2)).toEqual([LAST_UPDATE_PATH]);
    expect(again.ok ? again.observations.map((observation) => observation.id) : []).toEqual(first.ok ? first.observations.slice(-1).map((observation) => observation.id) : ["x"]);
    publish(routes, stampAfter(15));
    publish(routes, stampAfter(30));
    move(20 * MIN);
    const next = await fetch();
    expect(pathsOf(sent).slice(3)).toEqual([LAST_UPDATE_PATH, eventFilePath(stampAfter(15)), eventFilePath(stampAfter(30))]);
    expect(next.ok && next.complete).toBe(true);
    expect(bodiesOf(next).filter((body) => body["id"] !== undefined)).toHaveLength(6);
    expect(bodiesOf(next).at(-1)?.["file"]).toBe(stampAfter(30));
  });

  it("is not complete after a gap of more than 4 files", async () => {
    const routes = new Map<string, Reply>();
    publish(routes, STAMP);
    const { fetch, sent, move } = fetchWith(routes);
    await fetch();
    for (let minutes = 15; minutes <= 120; minutes += 15) publish(routes, stampAfter(minutes));
    move(120 * MIN);
    const outcome = await fetch();
    expect(outcome.ok && !outcome.complete).toBe(true);
    expect(pathsOf(sent).slice(2)).toEqual([LAST_UPDATE_PATH, ...[75, 90, 105, 120].map((minutes) => eventFilePath(stampAfter(minutes)))]);
  });

  it("passes a missing older file, and reads a missing newest file at the next fetch", async () => {
    const routes = new Map<string, Reply>();
    publish(routes, STAMP);
    const { fetch, sent, move } = fetchWith(routes);
    await fetch();
    publish(routes, stampAfter(30));
    routes.delete(eventFilePath(stampAfter(30)));
    move(30 * MIN);
    const early = await fetch();
    // The older file of +15 is not there: it is lost. The newest file of +30 is not there yet: the head stays.
    expect(early.ok && !early.complete).toBe(true);
    expect(bodiesOf(early).map((body) => body["file"])).toEqual([STAMP]);
    publish(routes, stampAfter(30));
    move(5 * MIN);
    const late = await fetch();
    expect(pathsOf(sent).slice(-2)).toEqual([LAST_UPDATE_PATH, eventFilePath(stampAfter(30))]);
    expect(late.ok && late.complete).toBe(true);
    expect(bodiesOf(late).at(-1)?.["file"]).toBe(stampAfter(30));
  });

  it("fails when the first newest file is missing, has a wrong digest, or lastupdate.txt names no file", async () => {
    const routes = new Map<string, Reply>();
    publish(routes, STAMP);
    routes.delete(eventFilePath(STAMP));
    expect((await fetchWith(routes).fetch()).ok).toBe(false);
    const archive = archiveOf(STAMP);
    routes.set(eventFilePath(STAMP), bytes(archive));
    routes.set(LAST_UPDATE_PATH, text(lastUpdateOf(STAMP, archive, "0".repeat(32))));
    const digest = await fetchWith(routes).fetch();
    expect(digest.ok ? "" : digest.failure.message).toMatch(/MD5/);
    routes.set(LAST_UPDATE_PATH, text("moved"));
    const named = await fetchWith(routes).fetch();
    expect(named.ok ? "" : named.failure.message).toMatch(/names no event file/);
  });
});

describe("checkCanary and the head", () => {
  it("passes when the newest file is at most one hour old, and fails after", async () => {
    const routes = new Map<string, Reply>();
    publish(routes, STAMP);
    const { fetch, move } = fetchWith(routes);
    const outcome = await fetch();
    expect(checkCanary(outcome.ok ? outcome.observations : []).pass).toBe(true);
    move(60 * MIN);
    const old = await fetch();
    const result = checkCanary(old.ok ? old.observations : []);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/limit is 60 minutes/);
    expect(checkCanary([]).pass).toBe(false);
  });

  it("maps a head to no report and no problem", () => {
    const body = headBody(STAMP, { lines: 5, parsed: 5, bodies: [] });
    const observation = { id: "o", source: "gdelt", fetched: START, contentType: "application/json", body, transport: { latency: 0 } };
    expect(mapObservation(observation as Parameters<typeof mapObservation>[0])).toEqual({ reports: [], problems: [] });
  });
});
