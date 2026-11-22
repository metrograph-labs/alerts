/**
 * The fake of the feeds in the lab of the capacity models (AL-131). The lab starts it in place of the feeds of the
 * runtime. It reads the classes `event` and `update` of a workload `capacity-workload/1`, and it gives the NWS alerts of
 * the classes at their rates.
 *
 * - Event `j` of a class with the rate `r` comes at `start + j / r`, to the millisecond. Thus the count of a class at an
 *   instant is the rate times the time from the start, rounded down. The events of all classes come in the order of their
 *   instants. At one instant, the classes come in the order of the workload.
 * - An event of the class `event` is a new alert, and an event of the class `update` is a new version of a live alert.
 *   The seeded random picks the alert of each update. An update with no live alert is skipped and counted.
 * - Each alert lives one hour. The main answer of the NWS API holds the last version of each live alert.
 * - The description of each version has `eventBytes` bytes of made-up words.
 * - The fake makes the events at each request, from the instant of the request. It keeps one small record of each live
 *   version, and it writes the body of the main answer in parts.
 *
 * The alerts are copies of the fixture of a flood warning of the NWS source. Their area is the area of `MEASURE_PLACE`.
 * The fake also gives the fresh canary of the NWS source and an empty list of WEA copies. Each seeded transit host gets an
 * empty feed.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { CANARY_PATH, NWS_BASE_URL, WEA_PATH } from "@mark1russell7/alerts-source-nws-api";
import { isRecord } from "@mark1russell7/optional/read";
import { isQuantity, valueIn } from "@mark1russell7/quantity";
import { random, seedOf, sha256Hex, type Random } from "@mark1russell7/rigor-generators";
import { UNKNOWN, type FakeHandler, type FakeReply } from "./fake-server.ts";
import { caseBodies } from "./nws.ts";
import { MEASURE_PLACE } from "./seed-home.ts";
import { canaryAnswer } from "./source-down.ts";

/** The format of a workload file of the capacity models. */
export const WORKLOAD_FORMAT = "capacity-workload/1";
/** The life of each alert of the fake, from its first version. */
export const FEED_ALERT_LIFE_MS: number = 60 * 60_000;
/** The unit of the rate of a class of the fake. */
export const FEED_RATE_UNIT = "{event}/s";
/** The host of the seeded transit feeds. Each feed host is this host or a host under it. */
export const TRANSIT_HOST = "transit.example.test";
/** The count of the event numbers of one office and one kind of VTEC event. */
const EVENT_NUMBERS = 9999;

/** One class of the workload, as the fake reads it. */
export interface FeedStream {
  readonly kind: "event" | "update";
  /** The rate of the class, in events in each second. */
  readonly perSecond: number;
  /** The bytes of the description of each version of the class. */
  readonly eventBytes: number;
}

/** This function reads one amount of a workload in a unit. It adds a problem when the amount is not in the unit. */
function amountIn(value: unknown, unit: string, path: string, problems: string[]): number | undefined {
  if (!isQuantity(value)) {
    problems.push(`The value at ${path} is not an amount with a unit.`);
    return undefined;
  }
  let amount: number;
  try {
    amount = valueIn(value, unit);
  } catch {
    problems.push(`The amount at ${path} is not in a unit of "${unit}".`);
    return undefined;
  }
  if (!Number.isFinite(amount) || amount < 0) {
    problems.push(`The amount at ${path} is not a finite amount of 0 or more.`);
    return undefined;
  }
  return amount;
}

/**
 * This function reads the classes of a workload for the fake of the feeds. A class is a point of the class `event` or
 * `update` of the contract, by its field `of` or by its id. The fake ignores the levels.
 *
 * @throws RangeError when the workload is not a workload of the fake: a fake that cannot read the rates gives no load.
 */
export function readFeedWorkload(value: unknown): readonly FeedStream[] {
  if (!isRecord(value) || value["format"] !== WORKLOAD_FORMAT || !Array.isArray(value["classes"])) {
    throw new RangeError(`The workload is not a record of the format "${WORKLOAD_FORMAT}" with a list of classes.`);
  }
  const problems: string[] = [];
  const streams: FeedStream[] = [];
  (value["classes"] as readonly unknown[]).forEach((entry, index) => {
    const path = `classes[${String(index)}]`;
    if (!isRecord(entry)) {
      problems.push(`The class at ${path} is not a record.`);
      return;
    }
    const kind = typeof entry["of"] === "string" ? entry["of"] : entry["id"];
    if (kind !== "event" && kind !== "update") {
      problems.push(`The class at ${path} is not a point of the class "event" or "update".`);
      return;
    }
    const perSecond = amountIn(entry["rate"], FEED_RATE_UNIT, `${path}.rate`, problems);
    const request = isRecord(entry["request"]) ? entry["request"] : {};
    const bytes = request["eventBytes"] === undefined ? undefined : amountIn(request["eventBytes"], "B", `${path}.request.eventBytes`, problems);
    if (perSecond === undefined) return;
    if (bytes === undefined && perSecond > 0) {
      problems.push(`The class at ${path} has a rate and no amount "eventBytes".`);
      return;
    }
    streams.push({ kind, perSecond, eventBytes: Math.round(bytes ?? 0) });
  });
  if (problems.length > 0) throw new RangeError(`The workload does not pass the check of the fake of the feeds. ${problems.join(" ")}`);
  return streams;
}

/** The options of the fake of the feeds. */
export interface FakeFeedsOptions {
  readonly streams: readonly FeedStream[];
  /** The seed of the picks of the updates and of the words. Default: `lab`. */
  readonly seed?: string;
  /** The instant of the start of the load. Default: the instant of the first request. */
  readonly start?: number;
}

/** The counts of the fake of the feeds. */
export interface FakeFeedsCounts {
  /** The alerts that the fake made. */
  readonly events: number;
  /** The new versions of live alerts. */
  readonly updates: number;
  /** The updates with no live alert. */
  readonly skipped: number;
  /** The live alerts at the last request. */
  readonly live: number;
  /** The main answers of the NWS API. */
  readonly answers: number;
}

/** A fake of the feeds. */
export interface FakeFeeds {
  readonly handler: FakeHandler;
  /** This function makes the events until the instant `now`, and it gives the counts. */
  readonly advance: (now: number) => FakeFeedsCounts;
  readonly counts: () => FakeFeedsCounts;
}

/** One version of an alert of the fake. */
interface Version {
  readonly alert: number;
  readonly version: number;
  readonly identifier: string;
  /** The sent time, in whole seconds. */
  readonly sent: number;
  /** The sent time of the first version. */
  readonly first: number;
  /** The start of the description in the text of made-up words. */
  readonly offset: number;
  readonly bytes: number;
  readonly prior?: { readonly identifier: string; readonly sent: number };
}

/** The flood warning of the fixtures of the NWS source. Each alert of the fake is a copy of it. */
interface Template {
  readonly properties: Readonly<Record<string, unknown>>;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly office: string;
  readonly sender: string;
  readonly headline: string;
}

function readTemplate(): Template {
  const root = dirname(createRequire(import.meta.url).resolve("@mark1russell7/alerts-source-nws-api/package.json"));
  const feature = JSON.parse(readFileSync(join(root, "fixtures", "nws-flw.json"), "utf8")) as { readonly properties: Readonly<Record<string, unknown>> };
  const { properties } = feature;
  // The made-up alerts have no expired references.
  const parameters = Object.fromEntries(Object.entries(properties["parameters"] as Readonly<Record<string, unknown>>).filter(([name]) => name !== "expiredReferences"));
  const [vtec] = parameters["VTEC"] as readonly string[];
  return {
    properties,
    parameters,
    office: vtec!.split(".")[2]!,
    sender: properties["sender"] as string,
    headline: `${properties["event"] as string} issued by ${properties["senderName"] as string}`,
  };
}

/** This function gives an instant in the form of CAP, in whole seconds in UTC. */
const capTime = (at: number): string => `${new Date(at).toISOString().slice(0, 19)}+00:00`;

/** This function gives an instant in the form of a VTEC time: `yymmddThhmmZ`. */
function vtecTime(at: number): string {
  const iso = new Date(at).toISOString();
  return `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z`;
}

/**
 * This function gives the office of an alert. The first 9999 alerts have the office of the fixture. Each next block of
 * 9999 alerts has a made-up office. Thus no two alerts of a run have one correlation key.
 */
const officeOf = (template: Template, alert: number): string => {
  const block = Math.floor(alert / EVENT_NUMBERS);
  return block === 0 ? template.office : `Z${block.toString(36).toUpperCase().padStart(3, "0")}`;
};

const SYLLABLES = ["ba", "do", "ke", "lu", "mi", "no", "pa", "re", "si", "tu", "va", "zo"];

/** This function gives a text of made-up words with `length` lower-case letters and spaces. */
function wordsOf(r: Random, length: number): string {
  const words: string[] = [];
  let size = 0;
  while (size < length) {
    const word = Array.from({ length: r.int(2, 4) }, () => r.pick(SYLLABLES)).join("");
    words.push(word);
    size += word.length + 1;
  }
  return words.join(" ").slice(0, length);
}

/** This function encodes a GTFS-RT feed message with no entity: version `2.0`, a full feed, and the instant `at`. */
export function emptyFeed(at: number): Uint8Array {
  const varint = (value: number): number[] => {
    const bytes: number[] = [];
    let rest = Math.floor(value);
    while (rest >= 0x80) {
      bytes.push((rest % 0x80) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    bytes.push(rest);
    return bytes;
  };
  const version = [...new TextEncoder().encode("2.0")];
  // The fields of the header: 1 gtfs_realtime_version, 2 incrementality (0 is a full feed), 3 timestamp in seconds.
  const header = [0x0a, version.length, ...version, 0x10, 0x00, 0x18, ...varint(at / 1000)];
  return Uint8Array.from([0x0a, header.length, ...header]);
}

const GEO_JSON = { "content-type": "application/geo+json" };
const NOT_FOUND: FakeReply = { status: 404, headers: { "content-type": "text/plain" }, body: "No robots.txt." };
const EMPTY_LIST: FakeReply = { status: 200, headers: GEO_JSON, body: JSON.stringify({ type: "FeatureCollection", features: [] }) };

/** This function makes a fake of the feeds. */
export function createFakeFeeds(options: FakeFeedsOptions): FakeFeeds {
  const seed = options.seed ?? "lab";
  const template = readTemplate();
  const picks = random(seedOf(`fake-feeds:${seed}:picks`));
  const longest = Math.max(1, ...options.streams.map((stream) => stream.eventBytes));
  const text = wordsOf(random(seedOf(`fake-feeds:${seed}:words`)), 2 * longest);
  const canary = canaryAnswer(caseBodies());
  const ugc = MEASURE_PLACE.codes.find((code) => code.system === "ugc")!.code;
  const same = MEASURE_PLACE.codes.find((code) => code.system === "same")!.code;
  const nwsHost = new URL(NWS_BASE_URL).host;
  const streams = options.streams.filter((stream) => stream.perSecond > 0);
  const done = streams.map(() => 0);
  const live = new Map<number, Version>();
  let start = options.start;
  let lowest = 0;
  let events = 0;
  let updates = 0;
  let skipped = 0;
  let answers = 0;

  const identifierOf = (alert: number, version: number): string => `urn:oid:2.49.0.1.840.0.${sha256Hex(`fake-feeds:${seed}:${String(alert)}:${String(version)}`).slice(0, 40)}.001.1`;
  const offsetOf = (bytes: number): number => picks.int(0, text.length - bytes);
  const expire = (at: number): void => {
    while (lowest < events && live.get(lowest)!.first + FEED_ALERT_LIFE_MS <= at) live.delete(lowest++);
  };
  const occur = (stream: FeedStream, at: number): void => {
    expire(at);
    const second = Math.floor(at / 1000) * 1000;
    if (stream.kind === "event") {
      const alert = events++;
      live.set(alert, { alert, version: 0, identifier: identifierOf(alert, 0), sent: second, first: second, offset: offsetOf(stream.eventBytes), bytes: stream.eventBytes });
      return;
    }
    if (lowest === events) {
      skipped += 1;
      return;
    }
    const prior = live.get(lowest + picks.below(events - lowest))!;
    const version = prior.version + 1;
    live.set(prior.alert, {
      alert: prior.alert,
      version,
      identifier: identifierOf(prior.alert, version),
      sent: Math.max(second, prior.sent + 1000),
      first: prior.first,
      offset: offsetOf(stream.eventBytes),
      bytes: stream.eventBytes,
      prior: { identifier: prior.identifier, sent: prior.sent },
    });
    updates += 1;
  };
  const counts = (): FakeFeedsCounts => ({ events, updates, skipped, live: live.size, answers });
  const advance = (now: number): FakeFeedsCounts => {
    start ??= now;
    const from = start;
    const nextOf = (index: number): number => from + Math.round(((done[index]! + 1) * 1000) / streams[index]!.perSecond);
    for (;;) {
      let next = -1;
      for (let index = 0; index < streams.length; index += 1) {
        if (nextOf(index) <= now && (next === -1 || nextOf(index) < nextOf(next))) next = index;
      }
      if (next === -1) break;
      occur(streams[next]!, nextOf(next));
      done[next] = done[next]! + 1;
    }
    expire(now);
    return counts();
  };

  const featureOf = (version: Version): unknown => {
    const ends = version.first + FEED_ALERT_LIFE_MS;
    const id = `${NWS_BASE_URL}/alerts/${version.identifier}`;
    const office = officeOf(template, version.alert);
    const number = String((version.alert % EVENT_NUMBERS) + 1).padStart(4, "0");
    const vtec =
      version.prior === undefined
        ? `/O.NEW.${office}.FL.W.${number}.${vtecTime(version.first)}-${vtecTime(ends)}/`
        : `/O.CON.${office}.FL.W.${number}.000000T0000Z-${vtecTime(ends)}/`;
    const { prior } = version;
    return {
      id,
      type: "Feature",
      geometry: null,
      properties: {
        ...template.properties,
        "@id": id,
        id: version.identifier,
        geocode: { SAME: [same], UGC: [ugc] },
        affectedZones: [`${NWS_BASE_URL}/zones/county/${ugc}`],
        references: prior === undefined ? [] : [{ "@id": `${NWS_BASE_URL}/alerts/${prior.identifier}`, identifier: prior.identifier, sender: template.sender, sent: capTime(prior.sent) }],
        sent: capTime(version.sent),
        effective: capTime(version.sent),
        onset: capTime(version.first),
        expires: capTime(ends),
        ends: capTime(ends),
        messageType: prior === undefined ? "Alert" : "Update",
        headline: template.headline,
        description: text.slice(version.offset, version.offset + version.bytes),
        parameters: { ...template.parameters, VTEC: [vtec], eventEndingTime: [capTime(ends)] },
      },
    };
  };
  function* mainBody(versions: readonly Version[]): Iterable<string> {
    yield '{"type":"FeatureCollection","features":[';
    for (let index = 0; index < versions.length; index += 1) yield `${index === 0 ? "" : ","}${JSON.stringify(featureOf(versions[index]!))}`;
    yield "]}";
  }

  const handler: FakeHandler = (request) => {
    advance(request.now);
    if (request.path === "/robots.txt") return NOT_FOUND;
    if (request.host === TRANSIT_HOST || request.host.endsWith(`.${TRANSIT_HOST}`)) {
      return { status: 200, headers: { "content-type": "application/x-protobuf" }, body: emptyFeed(request.now) };
    }
    if (request.host !== nwsHost) return UNKNOWN;
    const query = `${request.path}${request.search}`;
    if (query === CANARY_PATH) {
      const reply = canary(request.now);
      return { status: reply.status, headers: reply.headers, body: reply.body };
    }
    if (query === WEA_PATH) return EMPTY_LIST;
    if (request.path !== "/alerts/active") return UNKNOWN;
    answers += 1;
    return { status: 200, headers: GEO_JSON, body: mainBody([...live.values()]) };
  };
  return { handler, advance, counts };
}
