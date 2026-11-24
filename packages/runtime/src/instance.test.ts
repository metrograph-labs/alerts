import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fakeClock, type FakeClock, type WallClock } from "@mark1russell7/algebra/clock";
import {
  CONFIG_FORMAT,
  COPY_FORMAT,
  escalate,
  HEALTH_FORMAT,
  healthPayloadSchema,
  MAP_FORMAT,
  matchPlaces,
  ONLY_COPY,
  parseConfig,
  STORE_FILL_WINDOW,
  type AlertConfig,
  type Watch,
  type ChannelId,
  type Delivery,
  type EscalationPolicy,
  type PersonId,
  type PlaceId,
  type ReportId,
  type SecretLookup,
  type CopySettings,
  type SourceId,
  type SpendConfig,
  type TellConfig,
} from "@mark1russell7/alerts";
import type { TwilioFetch } from "@mark1russell7/alerts-channel-twilio";
import { WEBHOOK_CHANNEL, WEBHOOK_EVENT, type WebhookFetch } from "@mark1russell7/alerts-channel-webhook";
import { PUSHOVER_QUOTA, PUSHOVER_RESERVE_NOTICES, PUSHOVER_TIMEOUT_MS, type PushoverChannelOptions } from "@mark1russell7/alerts-channel-pushover";
import { memoryCache, type ShapeCache } from "@mark1russell7/alerts-shapes-nws";
import { CANARY_PATH, createNwsSource } from "@mark1russell7/alerts-source-nws-api";
import { fakeSessions, NWWS_DESCRIPTOR } from "@mark1russell7/alerts-source-nwws";
import { SWPC_KINDS } from "@mark1russell7/alerts-source-swpc";
import { CATALOG_URL, sourceIdOf, type CatalogCopy } from "@mark1russell7/alerts-source-gtfs-alerts";
import { KEV_KINDS } from "@mark1russell7/alerts-source-cisa-kev";
import { GDELT_DESCRIPTOR } from "@mark1russell7/alerts-source-gdelt";
import { AWS_DESCRIPTOR } from "@mark1russell7/alerts-source-aws";
import { AZURE_DESCRIPTOR } from "@mark1russell7/alerts-source-azure";
import { BOM_SWS_DESCRIPTOR, bomTimeText } from "@mark1russell7/alerts-source-bom-sws";
import { ANOMALIES_DESCRIPTOR as RADAR_ANOMALIES, OUTAGES_DESCRIPTOR as RADAR_OUTAGES } from "@mark1russell7/alerts-source-cloudflare-radar";
import { FIREBASE_DESCRIPTOR, GCP_DESCRIPTOR } from "@mark1russell7/alerts-source-gcp";
import { descriptorOf as statusPageDescriptor, pagePath, STATUS_PAGES, type StatusPage } from "@mark1russell7/alerts-source-statuspage";
import { ENERGY_CHARTS_MEASURES, SOURCE_ID as ENERGY_CHARTS_SOURCE, WINDOW_MINUTES } from "@mark1russell7/alerts-source-energy-charts";
import { DATE_FORMAT as EIA_DATE_FORMAT, EIA_930_DESCRIPTOR, HOUR_MS, periodEnd, periodText } from "@mark1russell7/alerts-source-eia-930";
import { memoryQuotaStore, quotaGate, type Exchange, type Transport } from "polite-crawler/api";
import { DEFAULT_POLICY } from "polite-crawler/politeness";
import { afterEach, describe, expect, it } from "vitest";
import { ACCOUNT_SOURCES, BOM_SWS_KEY, readsGdelt, CHECKS_KEY, EIA_KEY, CLOUDFLARE_RADAR_KEY, checksKeys, DAEMON_CHECK, daemonCheck, DELIVERY_TIMES, INSTANCE_CHANNELS, INSTANCE_CHECK, INSTANCE_EXPECTATIONS, instanceExpectations, INSTANCE_FETCH_LIMIT, INSTANCE_SOURCES, INSTANCE_TIMES, instanceCheck, instanceProblems, instanceServices, shownNode, shownServices, LOUD_PING_URL_KEY, LOUD_STEADY, nwwsKeys, nwwsSetup, openInstance, PING_URL_KEY, pingKeyOf, pingTargets, RANK_DELAY, RANK_FLOOR, SOURCE_POLICY, sourcePace, twilioSetup, USER_AGENT_NAME, instanceSenders, WEBHOOK_SECRET_KEY, WEBHOOK_USER_AGENT, webhookSetup, type Instance, type InstanceOptions } from "./instance.ts";
import { heartbeatGap } from "./heartbeat.ts";
import { spendGates, spendQuota } from "./balance.ts";
import { CLOCK_SKEW_LIMIT, COPY_TOKEN_KEY, EXCHANGE_EVERY, EXCHANGE_LIMIT } from "./copy.ts";
import { overdueLimit } from "./delivery.ts";
import type { ShapeOutcome } from "./shapes.ts";
import { CATALOG_REFRESH, type TransitCache, type TransitOutcome } from "./transit.ts";
import { nextFetch } from "./view.ts";
import { createTellIntake, TELL_DESCRIPTOR } from "./tell-intake.ts";
import type { TellEvent } from "./tell-message.ts";
import { openRuntimeLog, type RuntimeLog } from "./log.ts";
import { openReadingStore, READINGS_FILE } from "./readings.ts";

// The Flood Warning was sent at 14:54 UTC on 2026-11-14, and it expires at 06:00 UTC on 2026-11-15.
// The keepalive was sent at 22:44:55 UTC. Thus at T0 the warning is active, and the keepalive is recent.
const T0 = Date.UTC(2026, 10, 14, 22, 50);
/** The host of the NWS API. */
const HOST = "api.weather.gov";
const MINUTE = 60_000;
const pushover = "pushover" as ChannelId;
const person = "person-1" as PersonId;
const place = "place-1" as PlaceId;

// A public point in McMullen County TX, in the polygon of the recorded Flood Warning. The polygon decides the
// match, not the county code. No request of a source holds the point.
const LONGITUDE = -98.55;
const LATITUDE = 28.3;

const policy = (level: EscalationPolicy["level"]): EscalationPolicy => ({ level, steps: [{ channel: pushover, at: 0 }], exhaustedAfter: 20 * MINUTE });

// A copy with rank 1 and its own first check. The addresses are fake.
const CLOUD_KEY = "HEALTHCHECKS_PING_URL_CLOUD";
const CLOUD: CopySettings = { format: COPY_FORMAT, id: "cloud", rank: 1, listen: { host: "cloud.example", port: 4751 }, peers: [{ id: "home", url: "http://home.example:4751" }], pingKey: CLOUD_KEY };

const CONFIG: AlertConfig = {
  format: CONFIG_FORMAT,
  places: [
    {
      id: place,
      label: "Place",
      at: [LONGITUDE, LATITUDE],
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

// Fake keys: 30 letters and digits, as Pushover keys are. A test looks for them in each message.
const SECRETS = { PUSHOVER_APP_TOKEN: "t".repeat(30), PUSHOVER_USER_KEY: "u".repeat(30) };
const store =
  (values: Readonly<Record<string, string>>): SecretLookup =>
  (name) =>
    values[name];

/** This function reads a recorded answer of a source package. */
function fixture(source: string, name: string): string {
  const root = dirname(createRequire(import.meta.url).resolve(`@mark1russell7/${source}/package.json`));
  return readFileSync(join(root, "fixtures", name), "utf8");
}

/**
 * The answer of GFZ to a query. It has a quiet value (Kp 1) for each 3-hour interval of the query, and the license of
 * GFZ. The recorded answers of the package `source-gfz` are of later days than the time of the tests.
 */
function gfzAnswer(url: URL): string {
  const start = Date.parse(url.searchParams.get("start") ?? "");
  const end = Date.parse(url.searchParams.get("end") ?? "");
  const datetime: string[] = [];
  for (let at = start; at <= end; at += 3 * 3_600_000) datetime.push(new Date(at).toISOString().replace(".000Z", "Z"));
  return JSON.stringify({ Kp: datetime.map(() => 1), datetime, meta: { license: "CC BY 4.0", source: "GFZ Potsdam" }, status: datetime.map(() => "pre") });
}

/**
 * The answer of Energy-Charts to a query. It has the nominal frequency (50 Hz) for each second of the query, and the
 * license of Energy-Charts. The recorded answers of the package `source-energy-charts` are of later days than the time of the tests.
 */
function energyChartsAnswer(url: URL): string {
  const start = Number(url.searchParams.get("start")) * 1000;
  const end = Number(url.searchParams.get("end")) * 1000;
  const time = (at: number): string => new Date(at).toISOString().replace(".000Z", "+00:00");
  const data: { timestamp: string; values: { frequency: number } }[] = [];
  for (let at = start; at <= end; at += 1000) data.push({ timestamp: time(at), values: { frequency: 50 } });
  return JSON.stringify({
    schema_version: "2.0",
    endpoint: "frequency",
    timezone: "UTC",
    unit: "Hz",
    available_from: time(start),
    available_until: time(end),
    data,
    attributes: { region: "DE-Freiburg" },
    license: "CC BY 4.0 (creativecommons.org/licenses/by/4.0), attribution: energy-charts.info",
    deprecated: false,
  });
}

/**
 * The answer of EIA to a query of the hourly demand. Each hour of the query has the demand and the forecast of one
 * balancing authority, PJM, and of the sum US48. The demand of each hour is 1,000 MWh above its forecast.
 */
function eiaAnswer(url: URL): string {
  const start = periodEnd(url.searchParams.get("start"));
  const end = periodEnd(url.searchParams.get("end"));
  if (start === undefined || end === undefined) throw new Error("the query of EIA has no hours");
  const data: Record<string, string>[] = [];
  for (let at = start; at <= end; at += HOUR_MS) {
    for (const [respondent, forecast] of [["PJM", 90_000], ["US48", 430_000]] as const) {
      data.push({ period: periodText(at), respondent, type: "D", value: String(forecast + 1000), "value-units": "megawatthours" });
      data.push({ period: periodText(at), respondent, type: "DF", value: String(forecast), "value-units": "megawatthours" });
    }
  }
  return JSON.stringify({ response: { total: String(data.length), dateFormat: EIA_DATE_FORMAT, frequency: "hourly", data }, apiVersion: "2.1.14" });
}

/**
 * The answer of CISA to the request of the KEV catalog. It has one real entry of the recorded catalog of the package
 * `source-cisa-kev`, with its dates moved to the day of the tests. The entry is due 14 days after the tests.
 */
function kevAnswer(): string {
  const catalog = JSON.parse(fixture("alerts-source-cisa-kev", "kev-20261117.json")) as { vulnerabilities: Record<string, unknown>[] } & Record<string, unknown>;
  const day = (offset: number): string => new Date(T0 + offset * 86_400_000).toISOString().slice(0, 10);
  const entry = { ...catalog.vulnerabilities[0], dateAdded: day(0), dueDate: day(14) };
  return JSON.stringify({ ...catalog, catalogVersion: day(0).replaceAll("-", "."), dateReleased: new Date(T0 - 3_600_000).toISOString(), count: 1, vulnerabilities: [entry] });
}

/**
 * The answer of a status page to the request of its summary. It is the recorded summary of the page of OpenAI in the
 * package `source-statuspage`, with its times moved to the time of the tests. The page of GitHub gives its incident,
 * which the provider watches after a fix. Each other page gives no incident.
 *
 * A page of StatusIQ (Pushover) gives the recorded feed of Pushover. Its queue of outbound messages has a major outage
 * since 10 minutes before the time of the tests. Each other component of the feed is operational.
 */
function statusPageAnswer(page: StatusPage): string {
  if (page.format === "statusiq") {
    const feed = fixture("alerts-source-statuspage", "pushover-20261118.xml");
    const title = "<title>Outbound Message Queue - Operational</title>";
    if (feed.split(title).length !== 2) throw new Error("the feed of Pushover has no one item of its queue");
    const [before, after] = feed.split(title) as [string, string];
    const since = new Date(T0 - 10 * 60_000).toUTCString();
    return `${before}<title>Outbound Message Queue - Major Outage</title>${after.replace(/<pubDate>[^<]*<\/pubDate>/, () => `<pubDate>${since}</pubDate>`)}`;
  }
  const summary = JSON.parse(fixture("alerts-source-statuspage", "openai-20261118.json")) as { page: Record<string, unknown>; incidents: Record<string, unknown>[] } & Record<string, unknown>;
  const time = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
  const live = summary.incidents.map((incident) => ({
    ...incident,
    created_at: time(-60),
    updated_at: time(-10),
    monitoring_at: time(-10),
    incident_updates: (incident["incident_updates"] as Record<string, unknown>[]).map((update, index) => ({ ...update, created_at: time(-10 - 20 * index), updated_at: time(-10 - 20 * index), display_at: time(-10 - 20 * index) })),
  }));
  return JSON.stringify({ ...summary, page: { ...summary.page, updated_at: time(-10) }, incidents: page.id === "statuspage-github" ? live : [] });
}

/**
 * The answer of Google Cloud Service Health to the request of its history. It is the first recorded incident of the package
 * `source-gcp` as it was after its first update. Its times move to the time of the tests. The incident has no end.
 */
function gcpAnswer(): string {
  const [outage] = JSON.parse(fixture("alerts-source-gcp", "incidents-20261118.json")) as Record<string, unknown>[];
  const { end: _end, ...live } = outage!;
  const time = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
  const region = [{ title: "Delhi (asia-south2)", id: "asia-south2" }];
  const latest = { created: time(-10), modified: time(-10), when: time(-10), text: "We are investigating an issue in asia-south2.", status: "SERVICE_DISRUPTION", affected_locations: region };
  return JSON.stringify([{ ...live, begin: time(-30), created: time(-20), modified: time(-10), most_recent_update: latest, updates: [latest], currently_affected_locations: region, previously_affected_locations: [] }]);
}

/**
 * The answer of the Firebase Status Dashboard to the request of its history. It is the recorded incident of Cloud Messaging
 * of the package `source-gcp` as it was after its first update. Its times move to the time of the tests. It has no end.
 */
function firebaseAnswer(): string {
  const [messaging] = JSON.parse(fixture("alerts-source-gcp", "firebase-incidents-20261118.json")) as Record<string, unknown>[];
  const { end: _end, ...live } = messaging!;
  const time = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
  const first = (live["updates"] as Record<string, unknown>[]).at(-1)!;
  const latest = { ...first, created: time(-10), modified: time(-10), when: time(-10) };
  return JSON.stringify([{ ...live, begin: time(-30), created: time(-10), modified: time(-10), most_recent_update: latest, updates: [latest] }]);
}

/**
 * The answer of the AWS Health Dashboard to the request of its feed, in the shape of the recorded feed of the package
 * `source-aws`. It has one update of one live event in the region `eu-west-1`, 10 minutes before the time of the tests.
 */
function awsAnswer(): string {
  const seconds = Math.floor((T0 - 10 * MINUTE) / 1000);
  const item = [
    "<item>",
    "<title><![CDATA[Service disruption: Increased Error Rates]]></title>",
    "<link>https://status.aws.amazon.com/</link>",
    `<pubDate>${new Date(seconds * 1000).toUTCString()}</pubDate>`,
    `<guid isPermaLink="false">https://status.aws.amazon.com/#ec2-eu-west-1_${String(seconds)}</guid>`,
    "<description><![CDATA[We are investigating increased error rates in the eu-west-1 Region.]]></description>",
    "</item>",
  ].join("");
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title><![CDATA[Amazon Web Services Service Status]]></title><link>https://status.aws.amazon.com/</link><ttl>5</ttl>${item}</channel></rss>`;
}

/**
 * The answer of BoM to a POST of one method, made from the documented schema of the API. It holds no text of BoM. The
 * K index has one value of the hour before the time of the tests. The alerts and the warnings are empty.
 */
function bomAnswer(url: URL): string {
  if (!url.pathname.endsWith("/get-k-index")) return JSON.stringify({ data: [] });
  return JSON.stringify({ data: [{ index: 2, valid_time: bomTimeText(T0 - 60 * MINUTE), analysis_time: bomTimeText(T0 - 50 * MINUTE) }] });
}

/**
 * The answer of Cloudflare Radar to the request of one list. The outages are the real answer of 2026-11-18, with one
 * outage of a platform that started before the time of the tests. The anomalies are an empty list in the form of the real answer.
 */
function radarAnswer(url: URL): string {
  if (url.pathname.endsWith("/annotations/outages")) return fixture("alerts-source-cloudflare-radar", "outages-20261118.json");
  return JSON.stringify({ success: true, errors: [], result: { trafficAnomalies: [] } });
}

/**
 * The answer of Azure Status to the request of its feed, in the shape of the recorded feeds of the package `source-azure`.
 * It has one live incident of virtual machines in the region West Europe, 10 minutes before the time of the tests.
 */
function azureAnswer(): string {
  const published = new Date(T0 - 10 * MINUTE).toUTCString().replace(/GMT$/, "Z");
  const item = [
    "<item>",
    '<guid isPermaLink="false">active-virtual-machines-west-europe</guid>',
    "<link>https://status.azure.com/en-us/status/</link>",
    "<category>Virtual Machines</category><category>West Europe</category><category>Public Non-Regional</category>",
    "<title>Active - Virtual Machines in West Europe</title>",
    "<description>&lt;p&gt;We are investigating an issue in West Europe.&lt;/p&gt;</description>",
    `<pubDate>${published}</pubDate>`,
    "</item>",
  ].join("");
  return `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Azure Status</title><link>https://status.azure.com/en-us/status/</link>${item}</channel></rss>`;
}

/** The status page of each host. */
const STATUS_HOSTS: ReadonlyMap<string, StatusPage> = new Map(STATUS_PAGES.map((page) => [new URL(page.base).hostname, page]));

/**
 * A fake network with recorded answers. The NWS API gives the Flood Warning to the request of the
 * state, the keepalive to the canary, and no alert to the WEA request. The IPAWS feed has no alert.
 *
 * The USGS and EMSC give their recorded earthquakes of 2026-11-16. No disc of these earthquakes reaches the place.
 * Each tsunami warning center gives its recorded statement of 2026-11-13. Each statement expired before the time of the tests.
 * The SWPC gives its recorded list of 2026-11-16. Its caps are far from the place, and its other messages have no area.
 *
 * GFZ gives a quiet value of the index Kp for each interval of the window of the query (`gfzAnswer`). Energy-Charts gives
 * the nominal frequency for each second of the query (`energyChartsAnswer`). CISA gives a catalog with one live entry (`kevAnswer`).
 * BoM gives one K index, and no alert and no warning (`bomAnswer`). Cloudflare Radar gives one outage and no anomaly (`radarAnswer`).
 *
 * Each status page gives its summary or its feed (`statusPageAnswer`). Google Cloud gives one live incident (`gcpAnswer`). Firebase
 * gives one live incident of Cloud Messaging (`firebaseAnswer`). AWS gives one live event (`awsAnswer`). Azure gives one
 * live incident (`azureAnswer`).
 *
 * Each exchange takes `delay` milliseconds of real time, as on a busy runner. With `Infinity`, no exchange ends.
 */
function network(delay = 0) {
  const exchanges: Exchange[] = [];
  const collection = (...names: string[]): string => JSON.stringify({ type: "FeatureCollection", features: names.map((name) => JSON.parse(fixture("alerts-source-nws-api", name))) });
  const nws: Readonly<Record<string, string>> = { "/alerts/active?area=TX": collection("nws-flw.json"), [CANARY_PATH]: collection("nws-keepalive.json") };
  const transport: Transport = async (exchange) => {
    exchanges.push(exchange);
    if (delay === Infinity) await new Promise<never>(() => undefined);
    if (delay > 0) await pause(delay);
    const url = new URL(exchange.url);
    if (url.hostname === "apps.fema.gov") return { status: 200, statusText: "OK", headers: { "content-type": "application/xml" }, body: fixture("alerts-source-ipaws", "feed-empty.xml") };
    if (url.hostname === "earthquake.usgs.gov") return { status: 200, statusText: "OK", headers: { "content-type": "application/geo+json" }, body: fixture("alerts-source-usgs", "feed-2.5_day-20261116T0327Z.geojson") };
    if (url.hostname === "www.seismicportal.eu") return { status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: fixture("alerts-source-emsc", "query-2.5_day-20261116T0528Z.json") };
    if (url.hostname === "services.swpc.noaa.gov") return { status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: fixture("alerts-source-swpc", "alerts-20261116T1553Z.json") };
    if (url.hostname === "kp.gfz.de") return { status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: gfzAnswer(url) };
    const statusPage = STATUS_HOSTS.get(url.hostname);
    if (statusPage !== undefined) return { status: 200, statusText: "OK", headers: { "content-type": statusPage.format === "statusiq" ? "application/rss+xml;charset=utf-8" : "application/json; charset=utf-8" }, body: statusPageAnswer(statusPage) };
    if (url.hostname === "status.cloud.google.com") return { status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: gcpAnswer() };
    if (url.hostname === "status.firebase.google.com") return { status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: firebaseAnswer() };
    if (url.hostname === "status.aws.amazon.com") return { status: 200, statusText: "OK", headers: { "content-type": "application/rss+xml" }, body: awsAnswer() };
    if (url.hostname === "sws-data.sws.bom.gov.au") return { status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: bomAnswer(url) };
    if (url.hostname === "api.cloudflare.com") return { status: 200, statusText: "OK", headers: { "content-type": "application/json;charset=UTF-8" }, body: radarAnswer(url) };
    if (url.hostname === "rssfeed.azure.status.microsoft") return { status: 200, statusText: "OK", headers: { "content-type": "text/xml; charset=utf-8" }, body: azureAnswer() };
    if (url.hostname === "www.cisa.gov") return { status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: kevAnswer() };
    if (url.hostname === "api.energy-charts.info") return { status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: energyChartsAnswer(url) };
    if (url.hostname === "api.eia.gov") return { status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: eiaAnswer(url) };
    if (url.hostname === "www.tsunami.gov") {
      const name = url.pathname.endsWith("/PHEBCAP.xml") ? "PHEBCAP-20261116T1134Z.xml" : "PAAQCAP-20261116T1134Z.xml";
      return { status: 200, statusText: "OK", headers: { "content-type": "text/xml" }, body: fixture("alerts-source-tsunami", name) };
    }
    if (url.hostname !== "api.weather.gov") throw new Error(`The fake network has no route to ${url.hostname}.`);
    const body = nws[url.pathname + url.search] ?? collection();
    return { status: 200, statusText: "OK", headers: { "content-type": "application/geo+json" }, body };
  };
  return { transport, exchanges };
}

// The outlines of a county and a forecast zone that contain the place. TXZ230 is a code of these tests only.
const zoneSquare = (west: number, south: number, size: number): number[][] => [
  [west, south],
  [west + size, south],
  [west + size, south + size],
  [west, south + size],
  [west, south],
];
const ZONE_ANSWERS: Readonly<Record<string, string>> = {
  "/zones?area=TX&type=county": JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", geometry: null, properties: { id: "TXC311", type: "county", name: "County" } }] }),
  "/zones?area=TX&type=forecast": JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", geometry: null, properties: { id: "TXZ230", type: "public", name: "Zone" } }] }),
  "/zones/county/TXC311": JSON.stringify({ type: "Feature", geometry: { type: "Polygon", coordinates: [zoneSquare(-99, 28, 1)] }, properties: { id: "TXC311", name: "County" } }),
  "/zones/forecast/TXZ230": JSON.stringify({ type: "Feature", geometry: { type: "Polygon", coordinates: [zoneSquare(-98.6, 28.2, 0.2)] }, properties: { id: "TXZ230", name: "Zone" } }),
};

/** This function adds the answers of the zone service to a fake network. */
function withZones(net: ReturnType<typeof network>): Transport {
  return async (exchange, signal) => {
    const url = new URL(exchange.url);
    const body = url.hostname === "api.weather.gov" ? ZONE_ANSWERS[url.pathname + url.search] : undefined;
    if (body === undefined) return net.transport(exchange, signal);
    net.exchanges.push(exchange);
    return { status: 200, statusText: "OK", headers: { "content-type": "application/geo+json" }, body };
  };
}

/** This function adds the answers of the zone service with one fire zone of the state. It has the outline of the forecast zone. */
function withFire(net: ReturnType<typeof network>): Transport {
  const zones = withZones(net);
  const answers: Readonly<Record<string, string>> = {
    "/zones?area=TX&type=fire": JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", geometry: null, properties: { id: "TXZ230", type: "fire", name: "Fire zone" } }] }),
    "/zones/fire/TXZ230": ZONE_ANSWERS["/zones/forecast/TXZ230"]!,
  };
  return async (exchange, signal) => {
    const url = new URL(exchange.url);
    const body = url.hostname === "api.weather.gov" ? answers[url.pathname + url.search] : undefined;
    if (body === undefined) return zones(exchange, signal);
    net.exchanges.push(exchange);
    return { status: 200, statusText: "OK", headers: { "content-type": "application/geo+json" }, body };
  };
}

/** This function gives the subjects of the open lines of the empty families of the stores (AL-86), in their order. */
function emptyStores(instance: Instance) {
  return Object.values(instance.runtime.state().lines.open)
    .filter((line) => line.kind.code === "system.store.empty")
    .map((line) => line.about[0]?.id)
    .sort();
}

/** A fake Pushover server. It accepts each message. */
function pushoverServer() {
  const calls: Array<{ url: string; fields: Record<string, string> }> = [];
  const fetch: PushoverChannelOptions["fetch"] = async (url, init) => {
    calls.push({ url, fields: Object.fromEntries(new URLSearchParams(init.body ?? "")) });
    const body = { status: 1, request: `request-${calls.length}`, receipt: `receipt-${calls.length}` };
    return { status: 200, text: async () => JSON.stringify(body), headers: { get: () => null } };
  };
  return { fetch, calls };
}

// The limit of each fetch in these tests. With the interval of 60 s, a stall of 1.2 s of real time stops a fetch.
const TEST_FETCH_LIMIT = 60 * 60 * 1000;

// The real time between two steps of the fake clock. In this time, the microtasks, the callbacks and the real work of a step end.
const REAL_STEP_MS = 20;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * This function moves the clock in steps of one second until the work ends. The waits of the pace of the sources end in the steps.
 * Before each step, it waits `REAL_STEP_MS` of real time. Thus slow real work does not move the fake time. On a busy runner, a step
 * after each turn of the event loop moved the clock 60 seconds in one fetch.
 * Then the limit of the fetch stopped the NWS source.
 */
async function finish<T>(clock: FakeClock, work: Promise<T>): Promise<T> {
  let done = false;
  work.then(
    () => (done = true),
    () => (done = true),
  );
  for (let step = 0; !done && step < 10 * 60; step++) {
    await pause(REAL_STEP_MS);
    if (!done) await clock.advance(1000);
  }
  return work;
}

/** This function gives the message of the error of a start. */
function messageOf(start: () => unknown): string {
  try {
    start();
  } catch (error) {
    return String(error);
  }
  throw new Error("The start did not throw.");
}

let opened: { log: RuntimeLog; folder: string }[] = [];

afterEach(() => {
  for (const { log, folder } of opened) {
    log.close();
    rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  }
  opened = [];
});

/** The contact of an operator in the tests. The domain is the example domain of RFC 2606. */
const CONTACT = "mailto:operator@example.org";

/** This function opens an instance. The limit `"interval"` keeps the default limit of each fetch: the interval of the source. */
function open(secret: SecretLookup = store(SECRETS), config: AlertConfig = CONFIG, delay = 0, fetchLimit: number | "interval" = TEST_FETCH_LIMIT, more: Partial<InstanceOptions> = {}) {
  // The entry reads the configuration so: a refused parse stops the start before the instance.
  const parsed = parseConfig(JSON.stringify(config), INSTANCE_CHANNELS, secret);
  if (parsed.tag === "err") throw new Error(parsed.error.join("\n"));
  const folder = mkdtempSync(join(tmpdir(), "alerts-instance-"));
  const log = openRuntimeLog(join(folder, "runtime.sqlite"));
  opened.push({ log, folder });
  const clock = fakeClock(T0);
  // The fake clock starts at T0. Thus its time is also the instant of the test.
  const wall: WallClock = { time: "wall", now: () => clock.now(), after: (ms, run) => clock.after(ms, run) };
  const net = network(delay);
  const server = pushoverServer();
  const instance: Instance = openInstance({ config: parsed.value, secret, log, clock, wall, transport: net.transport, pushover: server.fetch, run: "run-1", ...(fetchLimit === "interval" ? {} : { fetchLimit: () => fetchLimit }), ...more });
  return { instance, clock, net, server };
}

describe("openInstance", () => {
  it("sends a recorded NWS warning for a watched county to the person on Pushover", async () => {
    const { instance, clock, net, server } = await open();
    const pass = await finish(clock, instance.runtime.pass());
    expect(pass.fetched).toEqual(["nws-api", "ipaws", "usgs", "emsc", "tsunami-ntwc", "tsunami-ptwc", "swpc", "gfz", "energy-charts", "cisa-kev"]);
    // A fetch that ran out of time names its cause here, before the checks of the send.
    expect(pass.view?.health.map((health) => [health.source, health.state])).toEqual([
      ["nws-api", "healthy"],
      ["ipaws", "healthy"],
      ["usgs", "healthy"],
      ["emsc", "healthy"],
      ["tsunami-ntwc", "healthy"],
      ["tsunami-ptwc", "healthy"],
      ["swpc", "healthy"],
      ["gfz", "healthy"],
      ["energy-charts", "healthy"],
      ["cisa-kev", "healthy"],
    ]);
    expect(server.calls).toHaveLength(1);
    const [call] = server.calls;
    expect(call?.url).toBe("https://api.pushover.net/1/messages.json");
    expect(call?.fields).toMatchObject({ token: SECRETS["PUSHOVER_APP_TOKEN"], user: SECRETS["PUSHOVER_USER_KEY"] });
    expect(call?.fields["title"]).toContain("Flood Warning");
    // The body starts with the why line, with the label of the place from the configuration.
    expect(call?.fields["message"]).toMatch(/^Why: Place is in the area\n\n\S/);
    expect(pass.delivery?.sent).toHaveLength(1);
    // The source asks for the alerts of the state. The match to the county is local.
    expect(net.exchanges.map((exchange) => exchange.url)).toContain("https://api.weather.gov/alerts/active?area=TX");
  });

  it("gives the map of the last pass, also of a pass that starts outside the loop, with the level of the person", async () => {
    const { instance, clock } = await open();
    const before = instance.map();
    expect(before.format).toBe(MAP_FORMAT);
    expect(before.at).toBeNull();
    expect(before.view.incidents).toEqual([]);
    const pass = await finish(clock, instance.runtime.pass());
    const after = instance.map();
    expect(after.at).toBe(pass.at);
    expect(after.view.places.map((place) => place.id)).toEqual(CONFIG.places.map((place) => place.id));
    // The warning of the county reaches the person, thus the map shows a level above `none`.
    expect(after.view.incidents.length).toBeGreaterThan(0);
    expect(after.view.incidents.some((incident) => incident.level !== "none")).toBe(true);
  });

  it("gives the health of the last pass with no message of a failure, and the quotas at the time of the read", async () => {
    const { instance, clock } = await open();
    const before = instance.health();
    expect(before.format).toBe(HEALTH_FORMAT);
    expect(before.at).toBeNull();
    expect(before.sources).toEqual([]);
    const pass = await finish(clock, instance.runtime.pass());
    const after = instance.health();
    expect(after.at).toBe(pass.at);
    expect(after.sources.map((entry) => [entry.source, entry.state])).toEqual(pass.view.health.map((entry) => [entry.source, entry.state]));
    expect(after.lateness).toEqual(pass.view.lateness);
    expect(after.coverage).toEqual(pass.view.coverage);
    expect(after.quotas.map((entry) => entry.quota)).toEqual(instance.quotas());
    // An instance with no other copy has no watch of a copy.
    expect(after.copies).toEqual([]);
    const text = JSON.stringify(after);
    expect(text).not.toContain('"message"');
    expect(healthPayloadSchema.safeParse(JSON.parse(text)).success).toBe(true);
  });

  it("gives the gate of the month to the Pushover channel: a send counts, and the reserve stops a send below life-safety", async () => {
    const gate = quotaGate(PUSHOVER_QUOTA, { key: "pushover:app", now: () => T0 });
    const counted = await open(undefined, undefined, undefined, undefined, { pushoverQuota: gate });
    await finish(counted.clock, counted.instance.runtime.pass());
    expect(counted.server.calls).toHaveLength(1);
    const priority = counted.server.calls[0]?.fields["priority"];
    expect(priority).not.toBe("2");
    expect(gate.state().used).toBe(1);

    const full = quotaGate(PUSHOVER_QUOTA, { key: "pushover:app", now: () => T0 });
    full.note({ remaining: 1_000 });
    const held = await open(undefined, undefined, undefined, undefined, { pushoverQuota: full });
    const pass = await finish(held.clock, held.instance.runtime.pass());
    expect(held.server.calls).toEqual([]);
    expect(pass.delivery?.failures.map((failure) => failure.kind)).toEqual(["reserved"]);
  });

  it("sends the line of the entry into the reserve from the reserve, one time, and holds the other messages", async () => {
    const gate = quotaGate(PUSHOVER_QUOTA, { key: "pushover:app", now: () => T0 });
    gate.note({ remaining: 1_000 });
    const notices = quotaGate(PUSHOVER_RESERVE_NOTICES, { key: "pushover:reserve-notices", now: () => T0 });
    const watching: AlertConfig = { ...CONFIG, people: CONFIG.people.map((entry) => ({ ...entry, watch: { ...entry.watch, subjects: [{ system: "alerts.channel" }] } })) };
    const { clock, instance, server } = await open(undefined, watching, undefined, undefined, { pushoverQuota: gate, pushoverReserveNotices: notices });
    const pass = await finish(clock, instance.runtime.pass());
    expect(pass.view.step.reports.map((report) => report.kind.code)).toEqual(["system.quota.low", "system.quota.reserve"]);
    expect(server.calls.map((call) => call.fields["title"])).toEqual([expect.stringContaining("sends only life-safety messages")]);
    // Pushover takes 2 calls at a time, thus the third message waits for the next pass. The reserve holds it there.
    expect(pass.delivery?.failures.map((failure) => failure.kind)).toEqual(["reserved"]);
    await clock.advance(1000);
    const next = await finish(clock, instance.runtime.pass());
    // In the next pass, the throttle (AL-72 part 4) stops the waiting quota line before the reserve. The line of the entry into
    // the reserve went in the window, and the two lines are in the stream of the system lines.
    expect(next.delivery?.failures ?? []).toEqual([]);
    expect(instance.runtime.state().suppressions.map((one) => [one.level, one.reason, one.over])).toEqual([["notice", "same-level", "notice"]]);
    expect(server.calls).toHaveLength(1);
    expect(notices.state().used).toBe(1);
  });

  it("lets the polygon of the warning decide for a place in the county but out of the polygon", async () => {
    // A public point in McMullen County TX, 8.9 km north of the polygon. The buffer of the place is 5 km. The NWS API copy
    // and the IPAWS copy each give the polygon and the county code in one area block, so the polygon decides.
    const outside = { ...CONFIG.places[0]!, at: [LONGITUDE, 28.46] as const };
    const { instance, clock, server } = open(store(SECRETS), { ...CONFIG, places: [outside] });
    const pass = await finish(clock, instance.runtime.pass());
    expect(pass.fetched).toEqual(["nws-api", "ipaws", "usgs", "emsc", "tsunami-ntwc", "tsunami-ptwc", "swpc", "gfz", "energy-charts", "cisa-kev"]);
    expect(server.calls).toHaveLength(0);
    // The USGS and EMSC give earthquake incidents too, the tsunami centers give expired statements, and the SWPC gives
    // space weather. The order of the incidents is the order of their anchors.
    const incident = pass.view.incidents.find((one) => !["geo.earthquake", "geo.tsunami", ...SWPC_KINDS, ...KEV_KINDS].includes(one.kind.code));
    expect(incident?.areas.some((area) => area.type === "polygon")).toBe(true);
    expect(matchPlaces(incident!, [outside])).toEqual([]);
    // With a buffer of 10 km, the polygon is in the buffer of the place, and the distance decides the match.
    const [near] = matchPlaces(incident!, [{ ...outside, bufferKm: 10 }]);
    expect(near?.codes).toEqual([]);
    expect(near?.distanceKm).toBeGreaterThan(8);
    expect(near?.distanceKm).toBeLessThan(10);
  });

  it("sends the warning when each exchange takes real time, as on a busy runner", async () => {
    // This test keeps the default limit, the interval. Before the fix of `finish`, a delay of 5 ms moved the fake clock past it.
    const { instance, clock, server } = open(store(SECRETS), CONFIG, 15, "interval");
    const pass = await finish(clock, instance.runtime.pass());
    expect(pass.view?.health.map((health) => [health.source, health.state])).toEqual([
      ["nws-api", "healthy"],
      ["ipaws", "healthy"],
      ["usgs", "healthy"],
      ["emsc", "healthy"],
      ["tsunami-ntwc", "healthy"],
      ["tsunami-ptwc", "healthy"],
      ["swpc", "healthy"],
      ["gfz", "healthy"],
      ["energy-charts", "healthy"],
      ["cisa-kev", "healthy"],
    ]);
    expect(server.calls.map((call) => call.fields["title"])).toEqual([expect.stringContaining("Flood Warning")]);
  });

  it("stops each fetch at the limit of the options", async () => {
    const { instance, clock } = open(store(SECRETS), CONFIG, Infinity, 5000);
    const pass = await finish(clock, instance.runtime.pass());
    expect(pass.view?.health.map((health) => [health.source, health.lastFailure?.failure.message])).toEqual([
      ["nws-api", "The fetch took longer than 5000 ms."],
      ["ipaws", "The fetch took longer than 5000 ms."],
      ["usgs", "The fetch took longer than 5000 ms."],
      ["emsc", "The fetch took longer than 5000 ms."],
      ["tsunami-ntwc", "The fetch took longer than 5000 ms."],
      ["tsunami-ptwc", "The fetch took longer than 5000 ms."],
      ["swpc", "The fetch took longer than 5000 ms."],
      ["gfz", "The fetch took longer than 5000 ms."],
      ["energy-charts", "The fetch took longer than 5000 ms."],
      ["cisa-kev", "The fetch took longer than 5000 ms."],
    ]);
  });

  it("keeps the grid frequency of Energy-Charts in the store of the readings, and gives the breadth of the signals", async () => {
    const folder = mkdtempSync(join(tmpdir(), "alerts-readings-"));
    const readings = openReadingStore(join(folder, READINGS_FILE));
    try {
      const { instance, clock } = open(store(SECRETS), CONFIG, 0, TEST_FETCH_LIMIT, { readings });
      const pass = await finish(clock, instance.runtime.pass());
      const refs = readings.refs().filter((ref) => ref.source === ENERGY_CHARTS_SOURCE);
      expect(refs.map((ref) => ref.measure)).toEqual(ENERGY_CHARTS_MEASURES.map((measure) => measure.id).sort());
      // The fake network gives 50 Hz for each second, thus the lowest and the highest value of each whole minute are 50 Hz.
      for (const ref of refs) expect(readings.series(ref, 0).map((reading) => reading.value)).toEqual(Array.from({ length: WINDOW_MINUTES }, () => 50));
      expect(pass.breadth).toBeDefined();
    } finally {
      readings.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("gives an incident with no area for the live entry of the KEV catalog, and no call to a person with no work", async () => {
    const { instance, clock, server } = open();
    const pass = await finish(clock, instance.runtime.pass());
    const flaws = pass.view.incidents.filter((incident) => KEV_KINDS.includes(incident.kind.code));
    expect(flaws.map((incident) => [incident.areas, incident.about.map((subject) => subject.system)])).toEqual([[[], ["cve"]]]);
    expect(flaws[0]?.expires).toBe(Date.parse(new Date(T0 + 15 * 86_400_000).toISOString().slice(0, 10)));
    expect(server.calls.map((call) => call.fields["title"])).toEqual([expect.stringContaining("Flood Warning")]);
  });

  it("reads the status pages and the feeds of Google Cloud, Firebase, AWS and Azure that a person with the work software can get, with the services, the endpoints and the regions as subjects", async () => {
    const software: AlertConfig = { ...CONFIG, people: CONFIG.people.map((entry) => ({ ...entry, defaults: { works: ["software"] } })) };
    const { instance, clock, net } = open(store(SECRETS), software);
    const pass = await finish(clock, instance.runtime.pass());
    const pages = STATUS_PAGES.filter((page) => ["infra.saas.outage", "infra.cloud.outage", "infra.internet.dns-cdn"].includes(page.kind));
    expect(pages.length).toBeGreaterThan(20);
    expect(pass.fetched).toEqual(["nws-api", "ipaws", "usgs", "emsc", "tsunami-ntwc", "tsunami-ptwc", "swpc", "gfz", "energy-charts", "cisa-kev", "gcp-status", "firebase-status", "aws-health", "azure-status", ...pages.map((page) => page.id)]);
    for (const source of ["gcp-status", "firebase-status", "aws-health", "azure-status"]) expect(pass.view.health.find((health) => health.source === source)?.state, source).toBe("healthy");
    expect(pass.view.health.filter((health) => health.source.startsWith("statuspage-")).map((health) => [health.source, health.state])).toEqual(pages.map((page) => [page.id, "healthy"]));
    const asked = new Set(net.exchanges.map((exchange) => new URL(exchange.url)).filter((url) => STATUS_HOSTS.has(url.hostname)).map((url) => url.origin + url.pathname));
    expect(asked).toEqual(new Set(pages.map((page) => `${page.base}${pagePath(page)}`)));
    expect(asked).toContain("https://status.pushover.net/rss");
    const outages = pass.view.incidents.filter((incident) => incident.kind.code === "infra.saas.outage").sort((a, b) => a.about[0]!.id.localeCompare(b.about[0]!.id));
    // The merge gives the subjects of an incident in the order of their canonical text.
    expect(outages.map((incident) => [incident.areas, incident.about])).toEqual([
      [
        [],
        [
          { system: "domain", id: "api.pushover.net", label: "Pushover: Outbound Message Queue" },
          { system: "domain", id: "pushover.net", label: "Pushover" },
        ],
      ],
      [[], [{ system: "domain", id: "github.com", label: "GitHub" }]],
    ]);
    const clouds = pass.view.incidents.filter((incident) => incident.kind.code === "infra.cloud.outage").sort((a, b) => a.about[0]!.id.localeCompare(b.about[0]!.id));
    expect(clouds.map((incident) => [incident.areas, incident.about])).toEqual([
      [
        [],
        [
          { system: "domain", id: "aws.amazon.com", label: "Amazon Web Services" },
          { system: "provider-region", id: "aws/eu-west-1" },
        ],
      ],
      [
        [],
        [
          { system: "domain", id: "azure.microsoft.com", label: "Microsoft Azure" },
          { system: "provider-region", id: "azure/westeurope", label: "West Europe" },
        ],
      ],
      [
        [],
        [
          { system: "domain", id: "cloud.google.com", label: "Google Cloud" },
          { system: "provider-region", id: "gcp/asia-south2", label: "Delhi (asia-south2)" },
        ],
      ],
      [
        [],
        [
          { system: "domain", id: "fcm.googleapis.com", label: "Firebase: Cloud Messaging" },
          { system: "domain", id: "firebase.google.com", label: "Firebase" },
        ],
      ],
    ]);
  });

  it("reads only the feed of Firebase and the page of Pushover for a person who names only the endpoint of its push messages", async () => {
    const push: AlertConfig = { ...CONFIG, people: CONFIG.people.map((entry) => ({ ...entry, defaults: { services: ["domain:fcm.googleapis.com"] } })) };
    const { instance, clock } = open(store(SECRETS), push);
    const pass = await finish(clock, instance.runtime.pass());
    // The layer delivery adds the API of Pushover, because the person has a contact on Pushover.
    expect(pass.fetched).toEqual(["nws-api", "ipaws", "usgs", "emsc", "tsunami-ntwc", "tsunami-ptwc", "swpc", "gfz", "energy-charts", "cisa-kev", "firebase-status", "statuspage-pushover"]);
    const clouds = pass.view.incidents.filter((incident) => incident.kind.code === "infra.cloud.outage");
    // The merge gives the subjects of an incident in the order of their canonical text.
    expect(clouds.map((incident) => incident.about.map((subject) => subject.id))).toEqual([["fcm.googleapis.com", "firebase.google.com"]]);
  });

  it("reads the page of Pushover for a person with a contact on Pushover by the layer delivery, and names its API in an outage of its queue", async () => {
    const delivery: AlertConfig = { ...CONFIG, people: CONFIG.people.map((entry) => ({ ...entry, defaults: {} })) };
    const { instance, clock, net } = open(store(SECRETS), delivery);
    const pass = await finish(clock, instance.runtime.pass());
    expect(pass.fetched).toEqual(["nws-api", "ipaws", "usgs", "emsc", "tsunami-ntwc", "tsunami-ptwc", "swpc", "gfz", "energy-charts", "cisa-kev", "statuspage-pushover"]);
    expect(net.exchanges.map((exchange) => exchange.url).filter((url) => STATUS_HOSTS.has(new URL(url).hostname))).toEqual(["https://status.pushover.net/rss"]);
    expect(pass.view.health.find((health) => health.source === "statuspage-pushover")?.state).toBe("healthy");
    const outages = pass.view.incidents.filter((incident) => incident.kind.code === "infra.saas.outage");
    expect(outages.map((incident) => [incident.severity, incident.about.map((subject) => subject.id)])).toEqual([["severe", ["api.pushover.net", "pushover.net"]]]);
  });

  it("reads no page of a channel for a person who turns off the layer delivery", async () => {
    const quiet: AlertConfig = { ...CONFIG, people: CONFIG.people.map((entry) => ({ ...entry, defaults: { delivery: false } })) };
    const { instance, clock } = open(store(SECRETS), quiet);
    const pass = await finish(clock, instance.runtime.pass());
    expect(pass.fetched.filter((source) => source.startsWith("statuspage-"))).toEqual([]);
  });

  it("reads no status page and no feed of a cloud provider for persons with no work, no service and no subject watch", async () => {
    const { instance, clock, net } = open();
    await finish(clock, instance.runtime.pass());
    expect(net.exchanges.filter((exchange) => STATUS_HOSTS.has(new URL(exchange.url).hostname) || ["status.cloud.google.com", "status.firebase.google.com", "status.aws.amazon.com", "rssfeed.azure.status.microsoft"].includes(new URL(exchange.url).hostname))).toEqual([]);
    expect(instance.runtime.config.sources.some((source) => source.id.startsWith("statuspage-") || ["gcp-status", "firebase-status", "aws-health", "azure-status"].includes(source.id))).toBe(false);
  });

  it("reads BoM only when the secrets have its key, and the key goes only into the body of each POST to BoM", async () => {
    const key = "bom-test-key-5d1f";
    const { instance, clock, net } = open(store({ ...SECRETS, [BOM_SWS_KEY]: key }));
    const pass = await finish(clock, instance.runtime.pass());
    expect(pass.fetched).toEqual(["nws-api", "ipaws", "usgs", "emsc", "tsunami-ntwc", "tsunami-ptwc", "swpc", "gfz", "bom-sws", "energy-charts", "cisa-kev"]);
    expect(instance.runtime.config.sources.map((source) => source.id)).toContain(BOM_SWS_DESCRIPTOR.id);
    expect(pass.view.health.find((health) => health.source === BOM_SWS_DESCRIPTOR.id)?.state).toBe("healthy");
    const bom = net.exchanges.filter((exchange) => new URL(exchange.url).hostname === "sws-data.sws.bom.gov.au");
    expect(bom.map((exchange) => [exchange.method, new URL(exchange.url).pathname])).toEqual([
      ["POST", "/api/v1/get-mag-alert"],
      ["POST", "/api/v1/get-mag-warning"],
      ["POST", "/api/v1/get-k-index"],
    ]);
    for (const exchange of bom) expect((JSON.parse(exchange.body ?? "{}") as { api_key?: unknown }).api_key).toBe(key);
    for (const exchange of net.exchanges.filter((exchange) => !bom.includes(exchange))) expect(JSON.stringify(exchange)).not.toContain(key);
    // The files of the runtime log hold no key: no observation, no failure and no record.
    const folder = opened.at(-1)!.folder;
    for (const name of readdirSync(folder)) expect(readFileSync(join(folder, name)).includes(key), name).toBe(false);
  });

  it("reads EIA-930 only when the secrets have its key, keeps its readings, and the key goes only into the query of each URL to EIA", async () => {
    const key = "eia-test-key-3b9a";
    const folder = mkdtempSync(join(tmpdir(), "alerts-readings-"));
    const readings = openReadingStore(join(folder, READINGS_FILE));
    try {
      const { instance, clock, net } = open(store({ ...SECRETS, [EIA_KEY]: key }), CONFIG, 0, TEST_FETCH_LIMIT, { readings });
      const pass = await finish(clock, instance.runtime.pass());
      expect(pass.fetched).toEqual(["nws-api", "ipaws", "usgs", "emsc", "tsunami-ntwc", "tsunami-ptwc", "swpc", "gfz", "energy-charts", EIA_930_DESCRIPTOR.id, "cisa-kev"]);
      expect(pass.view.health.find((health) => health.source === EIA_930_DESCRIPTOR.id)?.state).toBe("healthy");
      // The first fetch reads the past hours and one day of history.
      const eia = net.exchanges.filter((exchange) => new URL(exchange.url).hostname === "api.eia.gov");
      expect(eia).toHaveLength(2);
      for (const exchange of eia) expect(new URL(exchange.url).searchParams.get("api_key")).toBe(key);
      for (const exchange of eia) expect(JSON.stringify(exchange.headers)).not.toContain(key);
      for (const exchange of net.exchanges.filter((exchange) => !eia.includes(exchange))) expect(JSON.stringify(exchange)).not.toContain(key);
      // The store keeps the hours of PJM, with the forecast as the expected value. The sum US48 gives no reading.
      const refs = readings.refs().filter((ref) => ref.source === EIA_930_DESCRIPTOR.id);
      expect(refs.map((ref) => ref.series)).toEqual(["PJM"]);
      const series = readings.series(refs[0]!, 0);
      expect(series.length).toBeGreaterThan(24);
      for (const reading of series) expect(reading.value - (reading.expected ?? 0)).toBe(1000);
      // The files of the runtime log and of the readings hold no key.
      for (const where of [opened.at(-1)!.folder, folder]) for (const name of readdirSync(where)) expect(readFileSync(join(where, name)).includes(key), name).toBe(false);
    } finally {
      readings.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("reads Cloudflare Radar only when the secrets have its token, and the token goes only into the header authorization", async () => {
    const token = "radar-test-token-7c2e";
    const { instance, clock, net } = open(store({ ...SECRETS, [CLOUDFLARE_RADAR_KEY]: token }));
    const pass = await finish(clock, instance.runtime.pass());
    expect(pass.fetched).toEqual(["nws-api", "ipaws", "usgs", "emsc", "tsunami-ntwc", "tsunami-ptwc", "swpc", "gfz", "energy-charts", "cisa-kev", RADAR_OUTAGES.id, RADAR_ANOMALIES.id]);
    for (const descriptor of [RADAR_OUTAGES, RADAR_ANOMALIES]) expect(pass.view.health.find((health) => health.source === descriptor.id)?.state, descriptor.id).toBe("healthy");
    const radar = net.exchanges.filter((exchange) => new URL(exchange.url).hostname === "api.cloudflare.com");
    expect(radar.map((exchange) => new URL(exchange.url).pathname)).toEqual(["/client/v4/radar/annotations/outages", "/client/v4/radar/traffic_anomalies"]);
    for (const exchange of radar) expect(exchange.headers["authorization"]).toBe(`Bearer ${token}`);
    for (const exchange of radar) expect(exchange.url).not.toContain(token);
    for (const exchange of net.exchanges.filter((exchange) => !radar.includes(exchange))) expect(JSON.stringify(exchange)).not.toContain(token);
    // The files of the runtime log hold no token: no observation, no failure and no record.
    const folder = opened.at(-1)!.folder;
    for (const name of readdirSync(folder)) expect(readFileSync(join(folder, name)).includes(token), name).toBe(false);
  });

  it("keeps the times of the loop with each status page: each page has a longer interval than the shortest of the list", () => {
    const shortest = Math.min(...INSTANCE_SOURCES.map((source) => source.interval));
    for (const descriptor of [GCP_DESCRIPTOR, FIREBASE_DESCRIPTOR, AWS_DESCRIPTOR, AZURE_DESCRIPTOR, BOM_SWS_DESCRIPTOR, EIA_930_DESCRIPTOR, RADAR_OUTAGES, RADAR_ANOMALIES]) {
      expect(descriptor.interval, descriptor.id).toBeGreaterThanOrEqual(shortest);
      expect(INSTANCE_FETCH_LIMIT(descriptor), descriptor.id).toBe(shortest);
    }
    for (const page of STATUS_PAGES) {
      expect(statusPageDescriptor(page).interval, page.id).toBeGreaterThanOrEqual(shortest);
      expect(INSTANCE_FETCH_LIMIT(statusPageDescriptor(page)), page.id).toBe(shortest);
    }
  });

  it("gives no contact in the User-Agent without a contact in the configuration, and no request holds a position or an account", async () => {
    const { instance, clock, net } = await open();
    await finish(clock, instance.runtime.pass());
    const hosts = new Set(net.exchanges.map((exchange) => new URL(exchange.url).hostname));
    expect(hosts).toEqual(new Set(["api.weather.gov", "apps.fema.gov", "earthquake.usgs.gov", "www.seismicportal.eu", "www.tsunami.gov", "services.swpc.noaa.gov", "kp.gfz.de", "api.energy-charts.info", "www.cisa.gov"]));
    for (const exchange of net.exchanges) {
      expect(exchange.headers["user-agent"]).toBe(USER_AGENT_NAME);
      const text = JSON.stringify(exchange);
      expect(text).not.toContain(String(LONGITUDE));
      expect(text).not.toContain(String(LATITUDE));
      expect(text).not.toContain("github.com");
    }
  });

  it("gets the outlines of the state of the place after a pass, at the pace and with the User-Agent of the instance", async () => {
    const outcomes: ShapeOutcome[] = [];
    let closed = 0;
    const cache = memoryCache();
    const counted: ShapeCache = { ...cache, close: () => (closed += 1) };
    const { instance, clock, net } = open(store(SECRETS), { ...CONFIG, contact: CONTACT }, 0, TEST_FETCH_LIMIT, { shapes: counted, onShapes: (outcome) => outcomes.push(outcome) });
    const pass = await finish(clock, instance.runtime.pass());
    await finish(clock, instance.shapes.idle());
    const zones = net.exchanges.filter((exchange) => new URL(exchange.url).pathname.startsWith("/zones"));
    expect(zones.map((exchange) => exchange.url)).toContain("https://api.weather.gov/zones?area=TX&type=county");
    expect(new Set(net.exchanges.map((exchange) => exchange.headers["user-agent"]))).toEqual(new Set([`${USER_AGENT_NAME} (+${CONTACT})`]));
    // The refresh starts after the pass, and it starts no request that can end after the next fetch of a source.
    const next = Math.min(...instance.runtime.config.sources.map((source) => nextFetch(instance.runtime.state(), source)));
    expect(clock.now()).toBeLessThanOrEqual(next);
    expect(pass.fetched).toEqual(["nws-api", "ipaws", "usgs", "emsc", "tsunami-ntwc", "tsunami-ptwc", "swpc", "gfz", "energy-charts", "cisa-kev"]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.ok).toBe(true);
    await instance.shapes.close();
    expect(closed).toBe(1);
  });

  it("adds the codes of the zones near a place from the outlines of the cache, and asks the NWS API by state only", async () => {
    // The records are older than the period of the refresh. Thus the refresh asks again, and gets the same outlines.
    const old = T0 - 8 * 24 * 60 * 60 * 1000;
    const shapeOf = (path: string) => (JSON.parse(ZONE_ANSWERS[path]!) as { geometry: { coordinates: [number, number][][] } }).geometry.coordinates;
    const cache = memoryCache({
      lists: [
        { state: "TX", kind: "county", fetched: old, ids: ["TXC311"] },
        { state: "TX", kind: "forecast", fetched: old, ids: ["TXZ230"] },
      ],
      zones: [
        { kind: "county", id: "TXC311", state: "TX", name: "County", fetched: old, shapes: [{ type: "polygon", rings: shapeOf("/zones/county/TXC311") }] },
        { kind: "forecast", id: "TXZ230", state: "TX", name: "Zone", fetched: old, shapes: [{ type: "polygon", rings: shapeOf("/zones/forecast/TXZ230") }] },
      ],
    });
    const net = network();
    const outcomes: ShapeOutcome[] = [];
    let told = 0;
    const { instance, clock } = open(store(SECRETS), CONFIG, 0, TEST_FETCH_LIMIT, { transport: withZones(net), shapes: cache, onShapes: (outcome) => outcomes.push(outcome), onPlaceCodes: () => (told += 1) });
    // The 4 codes near the place are TXC311, its SAME code, the state and TXZ230. The file has each code but the forecast zone TXZ230.
    expect(instance.zones).toEqual({ placed: 1, outlined: 1, near: 4, added: 1 });
    expect(instance.runtime.config.places[0]?.codes.at(-1)).toEqual({ system: "ugc", code: "TXZ230" });
    await finish(clock, instance.runtime.pass());
    await finish(clock, instance.shapes.idle());
    // The refresh asked again, and the outlines did not change. Thus the codes of the place did not change.
    expect(outcomes).toEqual([{ ok: true, refreshed: expect.objectContaining({ stop: "done", failures: [] }) }]);
    expect(outcomes[0]?.ok === true && outcomes[0].refreshed.requests).toBeGreaterThan(0);
    expect(told).toBe(0);
    const alerts = net.exchanges.map((exchange) => new URL(exchange.url)).filter((url) => url.pathname === "/alerts/active");
    expect(alerts.map((url) => url.search)).toContain("?area=TX");
    expect(alerts.filter((url) => url.searchParams.has("zone"))).toEqual([]);
  });

  it("starts no refresh of the shapes before a pass after the good start (AL-75)", async () => {
    const net = network();
    const outcomes: ShapeOutcome[] = [];
    let good = false;
    const { instance, clock } = open(store(SECRETS), CONFIG, 0, TEST_FETCH_LIMIT, { transport: withZones(net), shapes: memoryCache(), onShapes: (outcome) => outcomes.push(outcome), startGood: () => good });
    const zones = () => net.exchanges.filter((exchange) => new URL(exchange.url).pathname.startsWith("/zones")).length;
    await finish(clock, instance.runtime.pass());
    await finish(clock, instance.shapes.idle());
    expect(outcomes).toEqual([]);
    expect(zones()).toBe(0);
    good = true;
    await finish(clock, instance.runtime.pass());
    await finish(clock, instance.shapes.idle());
    expect(outcomes).toEqual([{ ok: true, refreshed: expect.objectContaining({ stop: "done", failures: [] }) }]);
    expect(zones()).toBeGreaterThan(0);
  });

  it("gives a notice for each family of the store of shapes when the store gets no turn in its window after the start (AL-86)", async () => {
    const net = network();
    // The start does not become good, thus the store gets no turn to fetch.
    const { instance, clock } = open(store(SECRETS), CONFIG, 0, TEST_FETCH_LIMIT, { transport: withZones(net), shapes: memoryCache(), startGood: () => false });
    await finish(clock, instance.runtime.pass());
    expect(emptyStores(instance)).toEqual([]);
    await clock.advance(STORE_FILL_WINDOW);
    await finish(clock, instance.runtime.pass());
    expect(emptyStores(instance)).toEqual(["shapes/county", "shapes/fire", "shapes/forecast"]);
    expect(net.exchanges.filter((exchange) => new URL(exchange.url).pathname.startsWith("/zones"))).toEqual([]);
    // The sources of the NWS API feed the store. Thus a person who watches the source gets the notice.
    const line = Object.values(instance.runtime.state().lines.open).find((entry) => entry.kind.code === "system.store.empty");
    expect(line?.about.slice(1)).toEqual([{ system: "alerts.source", id: "nws-api", label: expect.any(String) }]);
  });

  it("gives no notice of the store of shapes when each family fills in its window (AL-86)", async () => {
    const net = network();
    const { instance, clock } = open(store(SECRETS), CONFIG, 0, TEST_FETCH_LIMIT, { transport: withFire(net), shapes: memoryCache() });
    const families = () => instance.shapes.fill(T0, STORE_FILL_WINDOW, []).map((fill) => [fill.family, fill.entries]);
    for (let pass = 0; pass < 4 && families().some(([, entries]) => entries === 0); pass++) {
      await finish(clock, instance.runtime.pass());
      await finish(clock, instance.shapes.idle());
    }
    expect(families()).toEqual([
      ["county", 1],
      ["forecast", 1],
      ["fire", 1],
    ]);
    await clock.advance(STORE_FILL_WINDOW);
    await finish(clock, instance.runtime.pass());
    expect(emptyStores(instance)).toEqual([]);
  });

  it("tells one time when new outlines change the codes of a place", async () => {
    const net = network();
    const outcomes: ShapeOutcome[] = [];
    let told = 0;
    const { instance, clock } = open(store(SECRETS), CONFIG, 0, TEST_FETCH_LIMIT, { transport: withZones(net), shapes: memoryCache(), onShapes: (outcome) => outcomes.push(outcome), onPlaceCodes: () => (told += 1) });
    expect(instance.zones).toEqual({ placed: 1, outlined: 0, near: 0, added: 0 });
    for (let pass = 0; pass < 4 && told === 0; pass++) {
      await finish(clock, instance.runtime.pass());
      await finish(clock, instance.shapes.idle());
    }
    expect(told).toBe(1);
    expect(outcomes.at(-1)).toEqual({ ok: true, refreshed: expect.objectContaining({ stop: "done", failures: [] }) });
    // The instance keeps the codes of its start. The supervisor starts a new instance with the new codes.
    expect(instance.runtime.config.places[0]?.codes).toEqual(CONFIG.places[0]?.codes);
    await finish(clock, instance.runtime.pass());
    await finish(clock, instance.shapes.idle());
    expect(told).toBe(1);
  });

  describe("the transit feeds (AL-60)", () => {
    // The header of the real catalog (CC0 1.0), and two feeds of service alerts of these tests. The box of the first holds the place.
    const HEADER = fixture("alerts-source-gtfs-alerts", "mobility-database-20261117.csv").split("\n")[0] ?? "";
    const row = (id: string, url: string, [west, south, east, north]: readonly number[]): string => {
      const cells: Record<string, string> = {
        id,
        data_type: "gtfs_rt",
        entity_type: "sa",
        provider: `Transit ${id}`,
        "urls.direct_download": url,
        "urls.authentication_type": "0",
        "location.bounding_box.minimum_longitude": String(west),
        "location.bounding_box.minimum_latitude": String(south),
        "location.bounding_box.maximum_longitude": String(east),
        "location.bounding_box.maximum_latitude": String(north),
        status: "active",
      };
      return HEADER.split(",").map((column) => cells[column] ?? "").join(",");
    };
    const NEAR = "https://transit.example.test/near.pb";
    const CATALOG = [HEADER, row("mdb-9001", NEAR, [-99, 28, -98, 29]), row("mdb-9002", "https://transit.example.test/far.pb", [14.4, 53.3, 14.8, 53.6]), ""].join("\n");
    // An empty feed with the header time T0. The census of the feed passes the canary.
    const varint = (value: number): number[] => {
      const out: number[] = [];
      let rest = value;
      while (rest >= 0x80) {
        out.push((rest % 0x80) | 0x80);
        rest = Math.floor(rest / 0x80);
      }
      return [...out, rest];
    };
    const header = [0x0a, 3, ...new TextEncoder().encode("2.0"), 0x18, ...varint(Math.floor(T0 / 1000))];
    const EMPTY_FEED = new Uint8Array([0x0a, header.length, ...header]);
    const withTransit = (net: ReturnType<typeof network>): Transport => async (exchange, signal) => {
      const url = new URL(exchange.url);
      if (url.hostname === "transit.example.test") {
        net.exchanges.push(exchange);
        return { status: 200, statusText: "OK", headers: { "content-type": "application/x-protobuf" }, body: "", bytes: EMPTY_FEED };
      }
      if (exchange.url === CATALOG_URL) {
        net.exchanges.push(exchange);
        return { status: 200, statusText: "OK", headers: { "content-type": "text/csv", etag: '"c1"' }, body: CATALOG };
      }
      return net.transport(exchange, signal);
    };
    const cacheOf = (copy: CatalogCopy | undefined) => {
      const written: CatalogCopy[] = [];
      const cache: TransitCache = { read: () => written.at(-1) ?? copy, write: (next) => void written.push(next) };
      return { cache, written };
    };

    it("reads each transit feed of the copy whose box meets a place, and no request holds a position", async () => {
      const net = network();
      const { cache, written } = cacheOf({ text: CATALOG, fetched: T0 });
      const { instance, clock } = open(store(SECRETS), CONFIG, 0, TEST_FETCH_LIMIT, { transport: withTransit(net), transit: cache });
      expect(instance.transit?.chosen.feeds.map((feed) => feed.id)).toEqual(["mdb-9001"]);
      expect(instance.transit?.copied).toBe(true);
      const id = sourceIdOf({ id: "mdb-9001" });
      expect(instance.runtime.config.sources.find((source) => source.id === id)?.kinds).toEqual(["transport.transit.service-alert"]);
      const pass = await finish(clock, instance.runtime.pass());
      expect(pass.fetched).toContain(id);
      expect(pass.view?.health.find((health) => health.source === id)?.state).toBe("healthy");
      // A kind of context needs no source, so the place has no gap of coverage for it.
      expect(pass.view?.coverage.filter((entry) => entry.kind === "transport.transit.service-alert")).toMatchObject([{ required: 0, sources: [id] }]);
      const transit = net.exchanges.filter((exchange) => new URL(exchange.url).hostname === "transit.example.test");
      expect(transit.map((exchange) => exchange.url)).toEqual([NEAR]);
      for (const exchange of transit) {
        expect(JSON.stringify(exchange)).not.toContain(String(LONGITUDE));
        expect(JSON.stringify(exchange)).not.toContain(String(LATITUDE));
      }
      // The copy is fresh, so the keeper does not read the catalog.
      await finish(clock, instance.transit!.idle());
      expect(written).toEqual([]);
      expect(net.exchanges.some((exchange) => exchange.url === CATALOG_URL)).toBe(false);
    });

    it("reads the catalog after the first pass with no copy, and tells one time that the feeds changed", async () => {
      const net = network();
      const { cache, written } = cacheOf(undefined);
      const outcomes: TransitOutcome[] = [];
      let told = 0;
      const { instance, clock } = open(store(SECRETS), CONFIG, 0, TEST_FETCH_LIMIT, { transport: withTransit(net), transit: cache, onTransit: (outcome) => outcomes.push(outcome), onTransitFeeds: () => (told += 1) });
      expect(instance.transit?.chosen.feeds).toEqual([]);
      expect(instance.transit?.copied).toBe(false);
      await finish(clock, instance.runtime.pass());
      await finish(clock, instance.transit!.idle());
      expect(outcomes).toEqual([{ ok: true, changed: true, feeds: 1, cut: 0 }]);
      expect(written.map((copy) => copy.text)).toEqual([CATALOG]);
      expect(told).toBe(1);
      const catalog = net.exchanges.filter((exchange) => exchange.url === CATALOG_URL);
      expect(catalog).toHaveLength(1);
      expect(catalog[0]?.headers["user-agent"]).toBe(USER_AGENT_NAME);
      // The instance keeps the feeds of its open. The supervisor starts a new instance with the new feeds.
      expect(instance.runtime.config.sources.some((source) => source.id === sourceIdOf({ id: "mdb-9001" }))).toBe(false);
      await instance.transit!.close();
    });

    it("reads no catalog before a pass after the good start, also with a copy that is one day old (AL-75)", async () => {
      const net = network();
      const { cache, written } = cacheOf({ text: CATALOG, fetched: T0 - CATALOG_REFRESH });
      const outcomes: TransitOutcome[] = [];
      let good = false;
      const { instance, clock } = open(store(SECRETS), CONFIG, 0, TEST_FETCH_LIMIT, { transport: withTransit(net), transit: cache, onTransit: (outcome) => outcomes.push(outcome), startGood: () => good });
      const reads = () => net.exchanges.filter((exchange) => exchange.url === CATALOG_URL).length;
      await finish(clock, instance.runtime.pass());
      await finish(clock, instance.transit!.idle());
      expect(reads()).toBe(0);
      expect(outcomes).toEqual([]);
      expect(written).toEqual([]);
      good = true;
      await finish(clock, instance.runtime.pass());
      await finish(clock, instance.transit!.idle());
      expect(reads()).toBe(1);
      expect(outcomes).toHaveLength(1);
      await instance.transit!.close();
    });
  });

  it("gets no outline without a cache of shapes", async () => {
    const { instance, clock, net } = open();
    await finish(clock, instance.runtime.pass());
    await instance.shapes.idle();
    expect(net.exchanges.filter((exchange) => new URL(exchange.url).pathname.startsWith("/zones"))).toEqual([]);
    expect(instance.shapes.basemap()).toEqual([]);
    expect(instance.shapes.lookup({ system: "ugc", code: "TXC311" })).toBeUndefined();
  });

  it("gives the contact of the configuration in the User-Agent of each request", async () => {
    const { instance, clock, net } = await open(store(SECRETS), { ...CONFIG, contact: CONTACT });
    await finish(clock, instance.runtime.pass());
    expect(net.exchanges.length).toBeGreaterThan(0);
    expect(new Set(net.exchanges.map((exchange) => exchange.headers["user-agent"]))).toEqual(new Set(["alerts-runtime (+mailto:operator@example.org)"]));
  });

  it("gives the loop the times of the sources and of the channel", async () => {
    const { instance } = await open();
    const intervals = instance.runtime.config.sources.map((source) => source.interval);
    expect(instance.runtime.config.sources.map((source) => source.id)).toEqual(["nws-api", "ipaws", "usgs", "emsc", "tsunami-ntwc", "tsunami-ptwc", "swpc", "gfz", "energy-charts", "cisa-kev"].map((id) => id as SourceId));
    // The limit of a fetch is its interval, up to the shortest interval. Thus the 10 minutes of GFZ do not make the pass long.
    expect(instance.runtime.config.sources.map(INSTANCE_FETCH_LIMIT)).toEqual(intervals.map(() => 60_000));
    expect(instance.loop.times).toEqual({
      passLimit: 60_000 + 2 * PUSHOVER_TIMEOUT_MS,
      retryBase: Math.min(PUSHOVER_TIMEOUT_MS, ...intervals),
      retryCap: Math.min(...intervals),
    });
    // The host reads the times before a start. They agree with the times of the loop.
    expect(instance.loop.times).toEqual(INSTANCE_TIMES);
  });

  it("does not start without the token of the application or the key of the person, and no message holds a value of a secret", () => {
    const { PUSHOVER_APP_TOKEN, PUSHOVER_USER_KEY } = SECRETS;
    const noToken = (): unknown => open(store({ PUSHOVER_USER_KEY }));
    expect(noToken).toThrow("The secret store has no value for PUSHOVER_APP_TOKEN");
    const noUser = (): unknown => open(store({ PUSHOVER_APP_TOKEN }));
    expect(noUser).toThrow("PUSHOVER_USER_KEY");
    for (const start of [noToken, noUser]) expect(messageOf(start)).not.toMatch(/t{30}|u{30}/);
  });

  it("does not start when no regional source covers a place", () => {
    // A marine zone is in no state and no country, so no code of a country holds it. The coverage of each regional source is a list of countries.
    // The SWPC and GFZ cover the whole Earth, so they cover the place with no code. The check does not count them.
    const place = CONFIG.places[0]!;
    const config: AlertConfig = { ...CONFIG, places: [{ ...place, codes: [{ system: "ugc", code: "GMZ550" }] }] };
    expect(messageOf(() => open(store(SECRETS), config))).toContain("No regional source covers the place place-1.");
  });

  it("does not start with a key that is not a key of Pushover, and no message holds the bad value", () => {
    // The load of the configuration checks the user key with the address fields of the channel. The instance checks the token.
    const badUser = messageOf(() => open(store({ ...SECRETS, PUSHOVER_USER_KEY: "bad-user-value" })));
    expect(badUser).toContain("The person person-1: The field user of the address on pushover is not a key of Pushover: 30 letters and digits.");
    const badToken = messageOf(() => open(store({ ...SECRETS, PUSHOVER_APP_TOKEN: "bad-token-value" })));
    expect(badToken).toContain("The value of PUSHOVER_APP_TOKEN is not a key of Pushover");
    for (const message of [badUser, badToken]) expect(message).not.toMatch(/bad-token-value|bad-user-value/);
  });

  it("does not start with a phone number with a missing digit, or a step on the call channel before its sender", () => {
    const call = "twilio-call" as ChannelId;
    const withPhone = (steps: EscalationPolicy["steps"]): AlertConfig => ({
      ...CONFIG,
      contacts: [...CONFIG.contacts, { person, channel: call, address: { to: { secret: "PHONE" } } }],
      policies: [{ ...policy("life-safety"), steps }, policy("urgent"), policy("notice")],
    });
    // Fake numbers: the area code 555 of the plan has no phones.
    const phone = (to: string): SecretLookup => store({ ...SECRETS, PHONE: to });
    const pushOnly = [{ channel: pushover, at: 0 }];
    const missing = messageOf(() => open(phone("+1555555012"), withPhone(pushOnly)));
    expect(missing).toContain("The person person-1: The field to of the address on twilio-call is not a phone number in E.164 form");
    expect(missing).not.toContain("+1555555012");
    // A good number on a step loads. Without the keys of Twilio, the instance has no sender on the channel, thus it does not start.
    const steps = [...pushOnly, { channel: call, at: 5 * MINUTE }];
    expect(parseConfig(JSON.stringify(withPhone(steps)), INSTANCE_CHANNELS, phone("+15555550123")).tag).toBe("ok");
    expect(messageOf(() => open(phone("+15555550123"), withPhone(steps)))).toContain("Step 1 of life-safety of person-1 uses the channel twilio-call, and the instance has no sender on it.");
    // A number with no step only waits for its sender. The instance starts.
    expect(() => open(phone("+15555550123"), withPhone(pushOnly))).not.toThrow();
  });
});

describe("the GDELT source of the instance (AL-19)", () => {
  // The recorded file of 2026-11-23 20:00 UTC holds 5 real events. Each is far from the place of the tests.
  const STAMP = "20261123200000";
  const zip = new Uint8Array(readFileSync(join(dirname(createRequire(import.meta.url).resolve("@mark1russell7/alerts-source-gdelt/package.json")), "fixtures", `${STAMP}.export.CSV.zip`)));
  const md5 = createHash("md5").update(zip).digest("hex");
  const withGdelt = (net: ReturnType<typeof network>): Transport => async (exchange, signal) => {
    const url = new URL(exchange.url);
    if (url.hostname !== "data.gdeltproject.org") return net.transport(exchange, signal);
    net.exchanges.push(exchange);
    if (url.pathname === "/gdeltv2/lastupdate.txt") return { status: 200, statusText: "OK", headers: { "content-type": "text/plain" }, body: `${zip.length} ${md5} http://data.gdeltproject.org/gdeltv2/${STAMP}.export.CSV.zip
` };
    if (url.pathname === `/gdeltv2/${STAMP}.export.CSV.zip`) return { status: 200, statusText: "OK", headers: { "content-type": "application/zip" }, body: "", bytes: zip };
    return { status: 404, statusText: "Not Found", headers: {}, body: "" };
  };
  const sharing: AlertConfig = { ...CONFIG, places: CONFIG.places.map((one) => ({ ...one, sharePosition: [GDELT_DESCRIPTOR.id] })) };

  it("reads GDELT only when a place shares its position with it", () => {
    expect(readsGdelt(CONFIG)).toBe(false);
    expect(readsGdelt(sharing)).toBe(true);
    expect(readsGdelt({ ...CONFIG, places: CONFIG.places.map((one) => ({ ...one, sharePosition: ["nws-api" as SourceId] })) })).toBe(false);
  });

  it("reads the newest file of GDELT, gives no report far from the places, and no request holds a position", async () => {
    const net = network();
    const { instance, clock } = open(store(SECRETS), sharing, 0, TEST_FETCH_LIMIT, { transport: withGdelt(net) });
    expect(instance.runtime.config.sources.map((source) => source.id)).toContain(GDELT_DESCRIPTOR.id);
    const pass = await finish(clock, instance.runtime.pass());
    expect(pass.fetched).toContain(GDELT_DESCRIPTOR.id);
    expect(pass.view?.health.find((health) => health.source === GDELT_DESCRIPTOR.id)?.state).toBe("healthy");
    const gdelt = net.exchanges.filter((exchange) => new URL(exchange.url).hostname === "data.gdeltproject.org");
    expect(gdelt.map((exchange) => new URL(exchange.url).pathname)).toEqual(["/gdeltv2/lastupdate.txt", `/gdeltv2/${STAMP}.export.CSV.zip`]);
    for (const exchange of gdelt) for (const value of [LONGITUDE, LATITUDE]) expect(JSON.stringify(exchange)).not.toContain(String(value));
    expect(pass.view?.incidents.filter((incident) => incident.kind.code.startsWith("security.")) ?? []).toEqual([]);
  });
});

describe("the webhook channel of the instance (AL-55)", () => {
  // Fake secrets: fixed bytes in the whsec_ form of Standard Webhooks. A test looks for them in each problem.
  const SECRET = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
  const NEXT = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
  const HOOK_URL = "https://hooks.example.test/alerts";
  // Each policy sends the alert to the receiver at once, next to the Pushover message. Without steps, the contact only waits.
  const hooked = (steps = true): AlertConfig => ({
    ...CONFIG,
    contacts: [...CONFIG.contacts, { person, channel: WEBHOOK_CHANNEL, address: { url: HOOK_URL } }],
    policies: steps ? CONFIG.policies.map((entry) => ({ ...entry, steps: [...entry.steps, { channel: WEBHOOK_CHANNEL, at: 0 }] })) : CONFIG.policies,
  });

  /** A fake receiver. It takes each request with the status 204. */
  function receiver() {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fetch: WebhookFetch = async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body ?? "" });
      return { status: 204, text: async () => "", headers: { get: () => null } };
    };
    return { fetch, calls };
  }

  it("sends the alert to the URL of the contact as one request with a signature of each secret", async () => {
    const hooks = receiver();
    const { instance, clock, server } = open(store({ ...SECRETS, [WEBHOOK_SECRET_KEY]: `${SECRET} ${NEXT}` }), hooked(), undefined, undefined, { webhook: hooks.fetch });
    const pass = await finish(clock, instance.runtime.pass());
    expect(pass.delivery?.sent).toHaveLength(2);
    expect(server.calls).toHaveLength(1);
    expect(hooks.calls).toHaveLength(1);
    const [call] = hooks.calls;
    expect(call?.url).toBe(HOOK_URL);
    // The receiver gets the name of the runtime, and no contact of the configuration.
    expect(call?.headers["user-agent"]).toBe(WEBHOOK_USER_AGENT);
    expect(call?.headers["webhook-signature"]?.split(" ")).toHaveLength(2);
    const event = JSON.parse(call?.body ?? "{}") as { type: string; data: { key: string; person: string; title: string; quiet: boolean } };
    expect(event).toMatchObject({ type: WEBHOOK_EVENT, data: { person: "person-1", quiet: false } });
    expect(event.data.title).toContain("Flood Warning");
    // The id of the request is the key of the delivery. Thus the requests of two copies have one id.
    expect(call?.headers["webhook-id"]).toBe(event.data.key);
  });

  it("has a sender on the channel only with a good value of the key", () => {
    expect(instanceSenders(store({ ...SECRETS, [WEBHOOK_SECRET_KEY]: SECRET }))).toContain(WEBHOOK_CHANNEL);
    expect(instanceSenders(store(SECRETS))).not.toContain(WEBHOOK_CHANNEL);
    expect(instanceSenders(store({ ...SECRETS, [WEBHOOK_SECRET_KEY]: "whsec_bad-secret-value!" }))).not.toContain(WEBHOOK_CHANNEL);
    expect(webhookSetup(store({ ...SECRETS, [WEBHOOK_SECRET_KEY]: "  " }))).toEqual({ tag: "ok", value: undefined });
  });

  it("does not start with a bad secret, and no message holds its value", () => {
    const bad = messageOf(() => open(store({ ...SECRETS, [WEBHOOK_SECRET_KEY]: `${SECRET} whsec_bad-secret-value!` }), hooked(false), undefined, undefined, { webhook: receiver().fetch }));
    expect(bad).toContain(`The value of ${WEBHOOK_SECRET_KEY} is not a list of secrets of Standard Webhooks. Secret 2 of 2:`);
    expect(bad).not.toContain("bad-secret-value");
    expect(bad).not.toContain(SECRET);
  });

  it("does not start with a step on the channel before its sender, and starts with a contact that has no step", () => {
    expect(messageOf(() => open(store(SECRETS), hooked()))).toContain("Step 1 of life-safety of person-1 uses the channel webhook, and the instance has no sender on it.");
    expect(() => open(store(SECRETS), hooked(false))).not.toThrow();
  });

  it("starts with a step on the channel and no secret when the copy leaves the channel to the other copies", async () => {
    const noDelay: AlertConfig = { ...hooked(), rankDelay: { digest: 0, notice: 0, urgent: 0, "life-safety": 0 } };
    const leaves: CopySettings = { ...CLOUD, leaveChannels: [WEBHOOK_CHANNEL] };
    expect(() => open(store(SECRETS), noDelay, undefined, undefined, { copy: leaves })).not.toThrow();
    // With the secret, the copy has a sender on the channel, and it still sends nothing on it. The other copy sends to the receiver.
    const hooks = receiver();
    const { instance, clock, server } = open(store({ ...SECRETS, [WEBHOOK_SECRET_KEY]: SECRET }), noDelay, undefined, undefined, { webhook: hooks.fetch, copy: leaves });
    const pass = await finish(clock, instance.runtime.pass());
    expect(server.calls).toHaveLength(1);
    expect(hooks.calls).toEqual([]);
    expect(pass.delivery?.failures).toEqual([]);
  });

  it("does not start with a name in the field leaveChannels that is not a channel of the instance", () => {
    const copy: CopySettings = { ...CLOUD, leaveChannels: ["web-hook" as ChannelId] };
    expect(messageOf(() => open(store(SECRETS), hooked(false), undefined, undefined, { copy }))).toContain("the field leaveChannels names the channel web-hook.");
  });

  it("does not start with the key and no fetch of the channel", () => {
    expect(messageOf(() => open(store({ ...SECRETS, [WEBHOOK_SECRET_KEY]: SECRET }), hooked()))).toContain("the instance has no fetch for it");
  });
});

describe("the Twilio call channel of the instance", () => {
  const call = "twilio-call" as ChannelId;
  // Fake keys and fake numbers: the country code +999 has no country. A test looks for the values in each problem.
  const TWILIO = {
    TWILIO_ACCOUNT_SID: `AC${"0".repeat(32)}`,
    TWILIO_API_KEY_SID: `SK${"1".repeat(32)}`,
    TWILIO_API_KEY_SECRET: "s".repeat(32),
    TWILIO_FROM: "+99900000001",
    PHONE: "+99900000002",
  };
  const SPEND: SpendConfig = { provider: "provider:twilio", monthlyUsd: 10, reserveUsd: 3, floor: 5, timeZone: "America/Chicago" };
  // Each policy calls the person at once, next to the Pushover message.
  const calling = (spend?: readonly SpendConfig[]): AlertConfig => ({
    ...CONFIG,
    contacts: [...CONFIG.contacts, { person, channel: call, address: { to: { secret: "PHONE" } } }],
    policies: CONFIG.policies.map((entry) => ({ ...entry, steps: [...entry.steps, { channel: call, at: 0 }] })),
    ...(spend === undefined ? {} : { spend }),
  });

  /** A fake Twilio server. It accepts each call and each text, and it gives a balance of 12.50 US dollars. */
  function twilioServer() {
    const calls: Array<{ url: string; method: string; authorization: string | undefined; fields: Record<string, string> }> = [];
    const fetch: TwilioFetch = async (url, init) => {
      calls.push({ url, method: init.method, authorization: init.headers["authorization"], fields: Object.fromEntries(new URLSearchParams(init.body ?? "")) });
      const body = url.endsWith("/Balance.json")
        ? { balance: "12.50", currency: "USD" }
        : url.endsWith("/Messages.json")
          ? { sid: `SM${"b".repeat(32)}`, status: "queued" }
          : { sid: `CA${"a".repeat(32)}`, status: "queued" };
      return { status: url.endsWith("/Calls.json") || url.endsWith("/Messages.json") ? 201 : 200, text: async () => JSON.stringify(body), headers: { get: () => null } };
    };
    const posts = (resource: string) => calls.filter((entry) => entry.method === "POST" && entry.url.endsWith(resource));
    return { fetch, calls, made: () => posts("/Calls.json"), texts: () => posts("/Messages.json") };
  }

  it("calls the person with the keys of the secrets, counts the call in the cap, and reads the balance", async () => {
    const twilio = twilioServer();
    const { instance, clock, server } = open(store({ ...SECRETS, ...TWILIO }), calling([SPEND]), undefined, undefined, { twilio: twilio.fetch, spendStore: memoryQuotaStore() });
    const pass = await finish(clock, instance.runtime.pass());
    expect(pass.delivery?.sent).toHaveLength(2);
    expect(server.calls).toHaveLength(1);
    const [made] = twilio.made();
    expect(twilio.made()).toHaveLength(1);
    expect(made?.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO.TWILIO_ACCOUNT_SID}/Calls.json`);
    expect(made?.fields).toMatchObject({ To: TWILIO.PHONE, From: TWILIO.TWILIO_FROM, MachineDetection: "Enable" });
    expect(made?.fields["Twiml"]).toContain("Flood Warning");
    // The API key signs each request, not the account SID.
    expect(made?.authorization).toBe(`Basic ${btoa(`${TWILIO.TWILIO_API_KEY_SID}:${TWILIO.TWILIO_API_KEY_SECRET}`)}`);
    // The cap is 10 US dollars with a reserve of 3, in cents. One call takes 4 cents.
    expect(instance.quotas()).toContainEqual({ channel: call, limit: 1_000, reserve: 300, used: 4, unit: "cents", resetAt: expect.any(Number) });
    expect(twilio.calls.filter((entry) => entry.method === "GET" && entry.url.endsWith("/Balance.json"))).toHaveLength(1);
    expect(instance.balances.map((watch) => [watch.provider, watch.balance()?.read?.balance, watch.balance()?.floors])).toEqual([["provider:twilio", 12.5, [5]]]);
    // The use reads have the cost of the call of this copy (AL-91). The fake server gives no usage, thus the account has no read.
    expect(instance.useReads?.()).toEqual([{ part: "meter:twilio-only", source: "count", amount: 0.04, date: "2026-11-14" }]);
  });

  it("calls from a copy with rank 1 one rank floor after its push, also with no rank delay at the level (AL-15)", async () => {
    const twilio = twilioServer();
    const noDelay: AlertConfig = { ...calling([SPEND]), rankDelay: { digest: 0, notice: 0, urgent: 0, "life-safety": 0 } };
    const { instance, clock, server } = open(store({ ...SECRETS, ...TWILIO }), noDelay, undefined, undefined, { twilio: twilio.fetch, spendStore: memoryQuotaStore(), copy: CLOUD });
    const first = await finish(clock, instance.runtime.pass());
    // The push goes at once. The call waits for the call of rank 0.
    expect(server.calls).toHaveLength(1);
    expect(twilio.made()).toEqual([]);
    const route = first.delivery?.routes[0];
    expect(route?.plan.wakeAt).toBe((route?.plan.start ?? 0) + RANK_FLOOR);
    await clock.advance(RANK_FLOOR);
    await finish(clock, instance.runtime.pass());
    expect(twilio.made()).toHaveLength(1);
    expect(server.calls).toHaveLength(1);
  });

  it("takes the rank floor of the configuration", async () => {
    const twilio = twilioServer();
    const floor: AlertConfig = { ...calling([SPEND]), rankDelay: { digest: 0, notice: 0, urgent: 0, "life-safety": 0 }, rankFloor: 45_000 };
    const { instance, clock } = open(store({ ...SECRETS, ...TWILIO }), floor, undefined, undefined, { twilio: twilio.fetch, spendStore: memoryQuotaStore(), copy: CLOUD });
    const first = await finish(clock, instance.runtime.pass());
    const route = first.delivery?.routes[0];
    expect(route?.plan.wakeAt).toBe((route?.plan.start ?? 0) + 45_000);
    expect(twilio.made()).toEqual([]);
  });

  it("keeps the reserve of the cap for life-safety: a call below life-safety in the reserve does not go", async () => {
    const twilio = twilioServer();
    const spendStore = memoryQuotaStore();
    // An earlier run used 700 of the 1000 cents. The last 300 cents are the reserve.
    spendGates(spendQuota({ name: "Twilio spend", ...SPEND }), { key: "provider:twilio:spend", store: spendStore, now: () => T0 }).gate.take(700);
    const { instance, clock, server } = open(store({ ...SECRETS, ...TWILIO }), calling([SPEND]), undefined, undefined, { twilio: twilio.fetch, spendStore });
    const pass = await finish(clock, instance.runtime.pass());
    expect(server.calls).toHaveLength(1);
    expect(twilio.made()).toEqual([]);
    expect(pass.delivery?.failures.map((failure) => [failure.channel, failure.kind])).toEqual([[call, "reserved"]]);
    expect(instance.quotas().find((quota) => quota.channel === call)?.used).toBe(700);
  });

  describe("the text channel", () => {
    const text = "twilio-text" as ChannelId;
    // A fake number of the texts. The number of a real sender needs a registration at Twilio.
    const TEXTS = { ...TWILIO, TWILIO_TEXT_FROM: "+99900000003" };
    // Each policy texts the person at once, next to the Pushover message.
    const texting = (spend?: readonly SpendConfig[]): AlertConfig => ({
      ...CONFIG,
      contacts: [...CONFIG.contacts, { person, channel: text, address: { to: { secret: "PHONE" } } }],
      // The person agreed to the texts before the start of the test.
      optIn: [{ number: { secret: "PHONE" }, at: "2026-11-01T00:00:00Z", way: "written", words: "texts-consent/1" }],
      policies: CONFIG.policies.map((entry) => ({ ...entry, steps: [...entry.steps, { channel: text, at: 0 }] })),
      ...(spend === undefined ? {} : { spend }),
    });

    it("texts the person from the number of the texts, counts the text in the cap of the calls, and watches one balance", async () => {
      const twilio = twilioServer();
      const { instance, clock, server } = open(store({ ...SECRETS, ...TEXTS }), texting([SPEND]), undefined, undefined, { twilio: twilio.fetch, spendStore: memoryQuotaStore() });
      const pass = await finish(clock, instance.runtime.pass());
      expect(pass.delivery?.sent).toHaveLength(2);
      expect(server.calls).toHaveLength(1);
      expect(twilio.made()).toEqual([]);
      const [sent] = twilio.texts();
      expect(twilio.texts()).toHaveLength(1);
      expect(sent?.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO.TWILIO_ACCOUNT_SID}/Messages.json`);
      expect(sent?.fields).toMatchObject({ To: TWILIO.PHONE, From: TEXTS.TWILIO_TEXT_FROM });
      expect(sent?.fields["Body"]).toContain("Flood Warning");
      expect([...(sent?.fields["Body"] ?? "")].length).toBeLessThanOrEqual(160);
      expect(sent?.authorization).toBe(`Basic ${btoa(`${TWILIO.TWILIO_API_KEY_SID}:${TWILIO.TWILIO_API_KEY_SECRET}`)}`);
      // The text takes 4 cents from the one cap of the account. The quota of the text is the quota of the calls.
      expect(instance.quotas()).toContainEqual({ channel: call, limit: 1_000, reserve: 300, used: 4, unit: "cents", resetAt: expect.any(Number) });
      expect(instance.quotas().map((quota) => quota.channel)).not.toContain(text);
      expect(instance.balances.map((watch) => watch.provider)).toEqual(["provider:twilio"]);
      // The own count of the copy has the text too (AL-91).
      expect(instance.useReads?.().map((read) => [read.part, read.amount])).toEqual([["meter:twilio-only", 0.04]]);
    });

    it("does not start with a text step and no number of the texts, a number of a bad form, a number with no keys, no cap, or no opt-in", () => {
      const more = () => ({ twilio: twilioServer().fetch, spendStore: memoryQuotaStore() });
      const noFrom = messageOf(() => open(store({ ...SECRETS, ...TWILIO }), texting([SPEND]), undefined, undefined, more()));
      expect(noFrom).toContain("uses the channel twilio-text, and the instance has no sender on it.");
      const badFrom = messageOf(() => open(store({ ...SECRETS, ...TWILIO, TWILIO_TEXT_FROM: "+1-bad-value" }), texting([SPEND]), undefined, undefined, more()));
      expect(badFrom).toContain("The keys of Twilio have a problem: The number that texts is not a phone number in E.164 form.");
      const alone = messageOf(() => open(store({ ...SECRETS, TWILIO_TEXT_FROM: TEXTS.TWILIO_TEXT_FROM })));
      expect(alone).toContain("The secret store has a value for TWILIO_TEXT_FROM, and no keys of Twilio.");
      const noCap = messageOf(() => open(store({ ...SECRETS, ...TEXTS }), texting(), undefined, undefined, more()));
      expect(noCap).toContain("The channel twilio-text costs money, and the configuration has no spend entry for its provider.");
      const noOptIn = messageOf(() => open(store({ ...SECRETS, ...TEXTS }), { ...texting([SPEND]), optIn: [] }, undefined, undefined, more()));
      expect(noOptIn).toContain(`The field to of the contact of ${person} on twilio-text is not on the opt-in list. The channel sends nothing to it.`);
      for (const problem of [noFrom, badFrom, alone, noCap, noOptIn]) expect(problem).not.toMatch(/bad-value|s{32}|0{32}|1{32}|\+999/u);
      // With the number of the texts and no step on the channel, the instance starts.
      expect(() => open(store({ ...SECRETS, ...TEXTS }), CONFIG, undefined, undefined, more())).not.toThrow();
    });

    it("gives the number of the texts in the setup of Twilio, so the outage call gets it too", () => {
      const setup = twilioSetup(store({ ...SECRETS, ...TEXTS }));
      expect(setup).toEqual({ tag: "ok", value: expect.objectContaining({ from: TWILIO.TWILIO_FROM, textFrom: TEXTS.TWILIO_TEXT_FROM }) });
      expect(twilioSetup(store({ ...SECRETS, ...TWILIO }))).toEqual({ tag: "ok", value: expect.not.objectContaining({ textFrom: expect.anything() }) });
    });
  });

  it("makes no call channel without the keys, and the heartbeat has only the Pushover quota", () => {
    const gate = quotaGate(PUSHOVER_QUOTA, { key: "pushover:app", now: () => T0 });
    const { instance } = open(undefined, undefined, undefined, undefined, { pushoverQuota: gate });
    expect(instance.quotas().map((quota) => quota.channel)).toEqual([pushover]);
    expect(instance.balances).toEqual([]);
  });

  it("makes one watch for each limit of GitHub with the token, and does not start without the token (AL-111)", () => {
    const limit = { id: "github:example/actions", provider: "provider:github", title: "GitHub Actions", accountKind: "organization", account: "example", products: ["actions"] } as const;
    const config: AlertConfig = { ...CONFIG, limits: [limit] };
    const { instance } = open(store({ ...SECRETS, GITHUB_BILLING_TOKEN: "test-token" }), config);
    expect(instance.uses.map((watch) => watch.id)).toEqual([limit.id]);
    // The health has the state of the reads of each limit, with no amount and no message.
    expect(instance.health().reads).toContainEqual({ what: `use of ${limit.id}`, at: null, failed: false, next: null });
    const problem = messageOf(() => open(store(SECRETS), config));
    expect(problem).toContain(`The watch of the limit ${limit.id} needs a token in the key GITHUB_BILLING_TOKEN, and the secret store has no value for it.`);
    expect(open().instance.uses).toEqual([]);
  });

  it("does not start with some keys of Twilio, a key of a bad form, or a call with no cap, and no problem holds a value", () => {
    const keys = (extra: Readonly<Record<string, string>>): SecretLookup => store({ ...SECRETS, ...TWILIO, ...extra });
    const partial = messageOf(() => open(keys({ TWILIO_API_KEY_SECRET: "" }), calling([SPEND])));
    expect(partial).toContain("it has no value for TWILIO_API_KEY_SECRET. Give all the keys, or none.");
    const badAccount = messageOf(() => open(keys({ TWILIO_ACCOUNT_SID: "AC-bad-value" }), calling([SPEND])));
    expect(badAccount).toContain("The keys of Twilio have a problem: The account SID is not AC and 32 hexadecimal digits.");
    const badKey = messageOf(() => open(keys({ TWILIO_API_KEY_SID: "SK-bad-value" }), calling([SPEND])));
    expect(badKey).toContain("The API key SID is not SK and 32 hexadecimal digits.");
    const badFrom = messageOf(() => open(keys({ TWILIO_FROM: "+1-bad-value" }), calling([SPEND])));
    expect(badFrom).toContain("The number that calls is not a phone number in E.164 form.");
    const noCap = messageOf(() => open(keys({}), calling()));
    expect(noCap).toContain("The channel twilio-call costs money, and the configuration has no spend entry for its provider.");
    for (const problem of [partial, badAccount, badKey, badFrom, noCap]) expect(problem).not.toMatch(/bad-value|s{32}|0{32}|1{32}|\+999/);
    // With the keys and no step on the channel, no cap is needed.
    expect(() => open(keys({}), CONFIG, undefined, undefined, { twilio: twilioServer().fetch })).not.toThrow();
  });

  it("needs the fetch of the channel and the store of the cap from the entry", () => {
    const keys = store({ ...SECRETS, ...TWILIO });
    expect(messageOf(() => open(keys, calling([SPEND]), undefined, undefined, { spendStore: memoryQuotaStore() }))).toContain("no fetch for the call channel");
    expect(messageOf(() => open(keys, calling([SPEND]), undefined, undefined, { twilio: twilioServer().fetch }))).toContain("no store for its count");
  });

  it("makes the worker of the deploy of the outage call, bound by the pass limit, and its problems hold no value", () => {
    const config: AlertConfig = { ...calling([SPEND]), outage: { people: [{ person, chain: { steps: [call, call] } }] } };
    const keys = (extra: Readonly<Record<string, string>> = {}): SecretLookup => store({ ...SECRETS, ...TWILIO, OUTAGE_TOKEN: "o".repeat(40), ...extra });
    const more = () => ({ twilio: twilioServer().fetch, spendStore: memoryQuotaStore() });
    const { instance } = open(keys(), config, undefined, undefined, more());
    expect(instance.outage?.state()).toEqual({ state: "pending" });
    expect(instance.outage?.worker.knobs.unit_processing_time).toEqual({ value: instance.loop.times.passLimit, unit: "ms" });
    // Without an outage call, the instance has no worker of the deploy.
    expect(open(keys(), calling([SPEND]), undefined, undefined, more()).instance.outage).toBeUndefined();
    const noToken = messageOf(() => open(keys({ OUTAGE_TOKEN: "" }), config, undefined, undefined, more()));
    expect(noToken).toContain("the secret store has no value for OUTAGE_TOKEN");
    const badToken = messageOf(() => open(keys({ OUTAGE_TOKEN: "bad-value" }), config, undefined, undefined, more()));
    expect(badToken).toContain("The value of OUTAGE_TOKEN is not 32 to 128");
    const noKeys = messageOf(() => open(store({ ...SECRETS, OUTAGE_TOKEN: "o".repeat(40), PHONE: TWILIO.PHONE }), config));
    expect(noKeys).toContain("the secret store has no keys of Twilio that pass the check");
    for (const problem of [noToken, badToken, noKeys]) expect(problem).not.toMatch(/bad-value|o{40}|s{32}|\+999/u);
  });
});

describe("the NWWS-OI source of the instance", () => {
  // Fake keys of two accounts. A test looks for them in each message.
  const ACCOUNT_1 = { NWWS_OI_USER_1: "operator-one", NWWS_OI_PASSWORD_1: "password-one" };
  const ACCOUNT_2 = { NWWS_OI_USER_2: "operator-two", NWWS_OI_PASSWORD_2: "password-two" };
  const VALUES = [...Object.values(ACCOUNT_1), ...Object.values(ACCOUNT_2)];
  const SECOND: CopySettings = { ...ONLY_COPY, accounts: { nwws: 2 } };

  it("names the keys of each account, and only the stream has an account", () => {
    expect(nwwsKeys(1)).toEqual({ username: "NWWS_OI_USER_1", password: "NWWS_OI_PASSWORD_1" });
    expect(nwwsKeys(2)).toEqual({ username: "NWWS_OI_USER_2", password: "NWWS_OI_PASSWORD_2" });
    expect(ACCOUNT_SOURCES).toEqual([NWWS_DESCRIPTOR.id]);
  });

  it("adds the stream with the keys of account 1, fetches it in a pass, and ends its session at the close of the runtime", async () => {
    const fake = fakeSessions((session) => session.join());
    const { instance, clock } = open(store({ ...SECRETS, ...ACCOUNT_1 }), CONFIG, 0, TEST_FETCH_LIMIT, { nwwsOpen: fake.open });
    expect(instance.runtime.config.sources.map((source) => source.id)).toEqual([...INSTANCE_SOURCES.map((source) => source.id), NWWS_DESCRIPTOR.id]);
    // The first fetch opens the session, not the start.
    expect(fake.sessions).toHaveLength(0);
    const pass = await finish(clock, instance.runtime.pass());
    expect(pass.fetched).toContain(NWWS_DESCRIPTOR.id);
    expect(fake.sessions).toHaveLength(1);
    expect(fake.last().options).toMatchObject({ username: "operator-one", password: "password-one" });
    expect(fake.last().closed).toBe(false);
    await instance.runtime.close();
    expect(fake.last().closed).toBe(true);
    await expect(instance.runtime.pass()).rejects.toThrow("The runtime is closed");
    expect(fake.sessions).toHaveLength(1);
  });

  it("uses the keys of the account of the copy", async () => {
    const fake = fakeSessions((session) => session.join());
    const { instance, clock } = open(store({ ...SECRETS, ...ACCOUNT_1, ...ACCOUNT_2 }), CONFIG, 0, TEST_FETCH_LIMIT, { nwwsOpen: fake.open, copy: SECOND });
    await finish(clock, instance.runtime.pass());
    expect(fake.last().options).toMatchObject({ username: "operator-two", password: "password-two" });
    await instance.runtime.close();
  });

  it("has no stream without the keys of account 1 and with no account in the copy", () => {
    const { instance } = open();
    expect(instance.runtime.config.sources.map((source) => source.id)).not.toContain(NWWS_DESCRIPTOR.id);
    expect(nwwsSetup(store(SECRETS))).toEqual({ tag: "ok", value: undefined });
    // The keys of account 2 alone give no stream to a copy with the default account.
    expect(nwwsSetup(store({ ...SECRETS, ...ACCOUNT_2 }))).toEqual({ tag: "ok", value: undefined });
  });

  it("does not start with one key of a pair, an account of the copy with no keys, or an account of a source with no account, and no problem holds a value", () => {
    const half = messageOf(() => open(store({ ...SECRETS, NWWS_OI_USER_1: "operator-one" })));
    expect(half).toContain("The secret store has one key of the NWWS-OI account 1, and it has no value for NWWS_OI_PASSWORD_1. Give the two keys, or none.");
    const noKeys = messageOf(() => open(store({ ...SECRETS, ...ACCOUNT_1 }), CONFIG, 0, TEST_FETCH_LIMIT, { copy: SECOND }));
    expect(noKeys).toContain("The file copy.json gives the NWWS-OI account 2 to this copy, and the secret store has no value for NWWS_OI_USER_2, NWWS_OI_PASSWORD_2.");
    const unknown = messageOf(() => open(store(SECRETS), CONFIG, 0, TEST_FETCH_LIMIT, { copy: { ...ONLY_COPY, accounts: { usgs: 1 } } }));
    expect(unknown).toContain("The file copy.json: the field accounts names the source usgs. Only these sources have an account: nwws.");
    for (const message of [half, noKeys, unknown]) for (const value of VALUES) expect(message).not.toContain(value);
  });

  it("checks the account of the copy before the start, as the start does", () => {
    const secret = store({ ...SECRETS, ...ACCOUNT_1 });
    const parsed = parseConfig(JSON.stringify(CONFIG), INSTANCE_CHANNELS, secret);
    if (parsed.tag === "err") throw new Error(parsed.error.join("\n"));
    const problem = "The file copy.json gives the NWWS-OI account 2 to this copy, and the secret store has no value for NWWS_OI_USER_2, NWWS_OI_PASSWORD_2.";
    expect(INSTANCE_CHECK.problems(parsed.value, secret)).toEqual([]);
    expect(instanceCheck(SECOND).problems(parsed.value, secret)).toEqual([problem]);
    expect(daemonCheck(SECOND).problems(parsed.value, secret)).toContain(problem);
    expect(instanceProblems(parsed.value, secret, INSTANCE_SOURCES, T0, SECOND)).toEqual([problem]);
  });

  it("keeps the times of the host: the stream makes only the cap of the retry shorter, thus the gap of the heartbeat stays a bound", () => {
    const { instance } = open(store({ ...SECRETS, ...ACCOUNT_1 }), CONFIG, 0, TEST_FETCH_LIMIT, { nwwsOpen: fakeSessions().open });
    expect(instance.loop.times).toEqual({ ...INSTANCE_TIMES, retryCap: NWWS_DESCRIPTOR.interval });
    expect(heartbeatGap(instance.loop.times)).toBeLessThan(heartbeatGap(INSTANCE_TIMES));
  });
});

describe("the keys of the status check", () => {
  // Fake values only. The test looks for them in each problem.
  const KEY = "k".repeat(32);
  const URL_OF_CHECK = "https://hc-ping.com/00000000-0000-4000-8000-000000000000";

  it("gives the key of the management API and the ping URL of secrets.env", () => {
    expect(checksKeys({ text: `${CHECKS_KEY}=${KEY}\n${PING_URL_KEY}=${URL_OF_CHECK}\n` })).toEqual({ tag: "ok", value: { key: KEY, url: URL_OF_CHECK } });
  });

  it("gives the URL of the loud check when secrets.env has one, and no field for an empty value", () => {
    const loud = `${URL_OF_CHECK}-loud`;
    expect(checksKeys({ text: `${CHECKS_KEY}=${KEY}\n${PING_URL_KEY}=${URL_OF_CHECK}\n${LOUD_PING_URL_KEY}=${loud}\n` })).toEqual({
      tag: "ok",
      value: { key: KEY, url: URL_OF_CHECK, loudUrl: loud },
    });
    expect(checksKeys({ text: `${CHECKS_KEY}=${KEY}\n${PING_URL_KEY}=${URL_OF_CHECK}\n${LOUD_PING_URL_KEY}=\n` })).toEqual({ tag: "ok", value: { key: KEY, url: URL_OF_CHECK } });
  });

  it("gives the checks of the heartbeat: the check with each ping, then the loud check with only the success pings, and none for a missing or empty key", () => {
    const loud = `${URL_OF_CHECK}-loud`;
    const lookup = (values: Record<string, string>) => (key: string) => values[key];
    expect(pingTargets(lookup({ [LOUD_PING_URL_KEY]: loud, [PING_URL_KEY]: URL_OF_CHECK }))).toEqual([
      { key: PING_URL_KEY, url: URL_OF_CHECK, successOnly: false, steadyAfter: 0 },
      { key: LOUD_PING_URL_KEY, url: loud, successOnly: true, steadyAfter: LOUD_STEADY },
    ]);
    expect(pingTargets(lookup({ [PING_URL_KEY]: URL_OF_CHECK }))).toEqual([{ key: PING_URL_KEY, url: URL_OF_CHECK, successOnly: false, steadyAfter: 0 }]);
    expect(pingTargets(lookup({ [PING_URL_KEY]: URL_OF_CHECK, [LOUD_PING_URL_KEY]: "" }))).toEqual([{ key: PING_URL_KEY, url: URL_OF_CHECK, successOnly: false, steadyAfter: 0 }]);
    expect(pingTargets(lookup({ [LOUD_PING_URL_KEY]: loud }))).toEqual([{ key: LOUD_PING_URL_KEY, url: loud, successOnly: true, steadyAfter: LOUD_STEADY }]);
    expect(pingTargets(lookup({}))).toEqual([]);
  });

  it("gives a problem with no value and no path for a missing key, a bad line and a failed read", () => {
    const problems = [
      checksKeys({ text: `${CHECKS_KEY}=${KEY}\n` }),
      checksKeys({ text: `${CHECKS_KEY}=${KEY}\n${PING_URL_KEY}=\n` }),
      checksKeys({ text: `${CHECKS_KEY}=${KEY}\n${PING_URL_KEY}=${URL_OF_CHECK}\nnot a line\n` }),
      checksKeys({ code: "ENOENT" }),
    ].map((result) => (result.tag === "err" ? result.error.join(" ") : "ok"));
    expect(problems[0]).toBe(`The file secrets.env needs ${CHECKS_KEY} and ${PING_URL_KEY} for this check.`);
    expect(problems[1]).toBe(problems[0]);
    expect(problems[2]).toMatch(/^The file secrets\.env: /);
    expect(problems[3]).toBe("The file secrets.env cannot be read (ENOENT).");
    for (const problem of problems) {
      expect(problem).not.toContain(KEY);
      expect(problem).not.toContain(URL_OF_CHECK);
    }
  });
});

describe("the check of the instance", () => {
  const parse = (config: AlertConfig, secret: SecretLookup) => {
    const parsed = parseConfig(JSON.stringify(config), INSTANCE_CHECK.channels, secret);
    if (parsed.tag === "err") throw new Error(parsed.error.join("\n"));
    return parsed.value;
  };

  it("has the descriptors that the sources of the instance give", () => {
    const { instance } = open();
    expect(instance.runtime.config.sources).toEqual(INSTANCE_SOURCES);
  });

  it("finds each problem that stops the start, and no message holds a value of a secret", () => {
    const place = CONFIG.places[0]!;
    const uncovered: AlertConfig = { ...CONFIG, places: [{ ...place, codes: [{ system: "ugc", code: "GMZ550" }] }] };
    const bad = store({ ...SECRETS, PUSHOVER_APP_TOKEN: "bad-token-value" });
    const problems = INSTANCE_CHECK.problems(parse(uncovered, bad), bad);
    expect(problems).toEqual([expect.stringContaining("The value of PUSHOVER_APP_TOKEN is not a key of Pushover"), expect.stringContaining("No regional source covers the place place-1.")]);
    expect(problems.join("\n")).not.toMatch(/bad-token-value|bad-user-value/);
    expect(messageOf(() => open(bad, uncovered))).toContain(problems.join("\n- "));
  });

  it("finds no problem in a configuration that starts", () => {
    expect(instanceProblems(parse(CONFIG, store(SECRETS)), store(SECRETS), INSTANCE_SOURCES, 0)).toEqual([]);
  });

  it("finds no problem in a place that has only its county code, because the county is in a state of the country", () => {
    const place = CONFIG.places[0]!;
    for (const codes of [[{ system: "ugc", code: "TXC311" }], [{ system: "same", code: "048311" }], [{ system: "state", code: "TX" }]]) {
      const config: AlertConfig = { ...CONFIG, places: [{ ...place, codes }] };
      expect(instanceProblems(parse(config, store(SECRETS)), store(SECRETS), INSTANCE_SOURCES, 0)).toEqual([]);
    }
  });

  it("does not count a global source as the cover of a place", () => {
    const global = INSTANCE_SOURCES.filter((descriptor) => descriptor.coverage === "global");
    expect(global.map((descriptor) => descriptor.id)).toEqual(["swpc", "gfz", "cisa-kev"]);
    expect(instanceProblems(parse(CONFIG, store(SECRETS)), store(SECRETS), global, 0)).toEqual([expect.stringContaining("No regional source covers the place place-1.")]);
  });

  it("checks the settings of the expectations against the expectations of the instance", () => {
    const wea = INSTANCE_EXPECTATIONS[0]!.id;
    const parsed = parse({ ...CONFIG, expectations: [{ id: "other", since: 1_000 }, { id: wea, since: 9_000 }] }, store(SECRETS));
    const unknown = "The configuration sets the expectation other, and the instance has no such expectation.";
    expect(instanceProblems(parsed, store(SECRETS), INSTANCE_SOURCES, 5_000)).toEqual([unknown, `The since of the expectation ${wea} is in the future. The check of the source then has no record until that time.`]);
    expect(instanceProblems(parsed, store(SECRETS), INSTANCE_SOURCES, 9_000)).toEqual([unknown]);
  });

  it("uses only the expectations of its sources, with the since of the settings", () => {
    const ids = (list: readonly { readonly id: string }[]): string[] => list.map((entry) => entry.id);
    expect(ids(INSTANCE_EXPECTATIONS)).toEqual(["nws-api.ipaws", "nws-api.nwws"]);
    // A copy with an account of NWWS-OI checks the copies of NWWS-OI. A copy with no account does not.
    expect(ids(instanceExpectations(undefined, [...INSTANCE_SOURCES, NWWS_DESCRIPTOR]))).toEqual(["nws-api.ipaws", "nws-api.nwws"]);
    expect(ids(instanceExpectations(undefined, INSTANCE_SOURCES))).toEqual(["nws-api.ipaws"]);
    const set = instanceExpectations([{ id: "nws-api.nwws", since: 7_000 }], [...INSTANCE_SOURCES, NWWS_DESCRIPTOR]);
    expect(set.map((expectation) => expectation.since)).toEqual([undefined, 7_000]);
    // The check of NWWS-OI takes only the reports with the key of the CAP message.
    expect(set[1]?.when).toEqual({ statuses: ["actual"], correlation: ["cap"] });
  });

  it("needs the key of the outside heartbeat only for the live instance", () => {
    const parsed = parse(CONFIG, store(SECRETS));
    expect(DAEMON_CHECK.channels).toBe(INSTANCE_CHECK.channels);
    expect(DAEMON_CHECK.problems(parsed, store(SECRETS))).toEqual([`The file secrets.env has no ${PING_URL_KEY}. The live instance needs its outside heartbeat.`]);
    expect(DAEMON_CHECK.problems(parsed, store({ ...SECRETS, [PING_URL_KEY]: "https://hc-ping.example/test" }))).toEqual([]);
  });
});

describe("the copies of the system", () => {
  const URL_OF_CHECK = "https://hc-ping.com/00000000-0000-4000-8000-000000000000";
  const lookup = (values: Record<string, string>) => (key: string) => values[key];

  it("waits 30 s for each rank: the flight limit, one exchange with its time limit, and the clock difference", () => {
    expect(RANK_DELAY).toBe(DELIVERY_TIMES.flightLimit + EXCHANGE_EVERY + EXCHANGE_LIMIT + CLOCK_SKEW_LIMIT);
    expect(RANK_DELAY).toBe(30_000);
    // The delivery of rank 0 comes to rank 1 before its wait ends, also after the longest send and one failed read.
    expect(RANK_DELAY).toBeGreaterThan(DELIVERY_TIMES.flightLimit + 2 * EXCHANGE_EVERY - EXCHANGE_EVERY + EXCHANGE_LIMIT);
  });

  it("waits 31 s for each rank before a call: the delivery of rank 0 comes to rank 1 in the worst case before its due time", () => {
    expect(RANK_FLOOR).toBe(DELIVERY_TIMES.callLimit + 3 * EXCHANGE_EVERY + 2 * EXCHANGE_LIMIT);
    expect(RANK_FLOOR).toBe(31_000);
    const call = "twilio-call" as ChannelId;
    const anchor = "a".repeat(64) as ReportId;
    const steps = [
      { channel: pushover, at: 0 },
      { channel: call, at: 0 },
    ];
    const plan = (rank: number, since: number, deliveries: readonly Delivery[], now: number) =>
      escalate({
        policy: { level: "life-safety", steps, exhaustedAfter: 20 * MINUTE },
        person,
        incident: { anchor, reports: [anchor] },
        since,
        deliveries,
        acknowledgments: [],
        rank,
        rankDelay: 0,
        floors: new Map([[call, RANK_FLOOR]]),
        now,
      });
    const calls = (each: ReturnType<typeof plan>) => each.sends.filter((send) => send.channel === call);
    // Rank 1 sees the incident first, at s1. Rank 0 sees it one exchange later: one interval and one read.
    const s1 = T0;
    const seen = s1 + EXCHANGE_EVERY + EXCHANGE_LIMIT;
    // Rank 0 calls at once, and the send ends in the call limit.
    expect(calls(plan(0, seen, [], seen)).map((send) => send.due)).toEqual([seen]);
    const sent = seen + DELIVERY_TIMES.callLimit;
    // A read in progress misses the delivery. Two intervals and one read bring it to rank 1.
    const merged = sent + 2 * EXCHANGE_EVERY + EXCHANGE_LIMIT;
    const first = plan(1, s1, [], s1);
    expect(first.sends.map((send) => send.channel)).toEqual([pushover]);
    expect(first.wakeAt).toBe(s1 + RANK_FLOOR);
    expect(first.wakeAt).toBeGreaterThanOrEqual(merged);
    // At its due time, rank 1 has the call of rank 0 in its ledger, thus it does not call.
    const delivered: Delivery = { key: "k-call", incident: anchor, level: "life-safety", person, channel: call, step: 1, at: sent };
    expect(calls(plan(1, s1, [delivered], s1 + RANK_FLOOR))).toEqual([]);
    // With no delivery, rank 1 calls at its due time: the system prefers a second call to a missed call.
    expect(calls(plan(1, s1, [], s1 + RANK_FLOOR)).map((send) => send.due)).toEqual([s1 + RANK_FLOOR]);
  });

  it("sends a step of a copy with rank 1 one rank delay after the start of the escalation", async () => {
    const { instance, clock, server } = await open(undefined, undefined, undefined, undefined, { copy: CLOUD });
    const first = await finish(clock, instance.runtime.pass());
    const route = first.delivery?.routes[0];
    expect(route).toBeDefined();
    expect(server.calls).toEqual([]);
    expect(route?.plan.sends).toEqual([]);
    expect(route?.plan.wakeAt).toBe((route?.plan.start ?? 0) + RANK_DELAY);
    await clock.advance(RANK_DELAY);
    const second = await finish(clock, instance.runtime.pass());
    expect(server.calls).toHaveLength(1);
    expect(second.delivery?.sent[0]?.at).toBeGreaterThanOrEqual((route?.plan.start ?? 0) + RANK_DELAY);
  });

  it("sends a step of the only copy at once", async () => {
    const { instance, clock, server } = await open(undefined, undefined, undefined, undefined, { copy: ONLY_COPY });
    await finish(clock, instance.runtime.pass());
    expect(server.calls).toHaveLength(1);
  });

  it("pings the first check of the copy with each ping, and the shared loud check with only the success pings (AL-100)", () => {
    const loud = `${URL_OF_CHECK}-loud`;
    const own = `${URL_OF_CHECK}-cloud`;
    const secrets = lookup({ [PING_URL_KEY]: URL_OF_CHECK, [CLOUD_KEY]: own, [LOUD_PING_URL_KEY]: loud });
    expect(pingKeyOf(ONLY_COPY)).toBe(PING_URL_KEY);
    expect(pingKeyOf(CLOUD)).toBe(CLOUD_KEY);
    expect(pingTargets(secrets, CLOUD)).toEqual([
      { key: CLOUD_KEY, url: own, successOnly: false, steadyAfter: 0 },
      { key: LOUD_PING_URL_KEY, url: loud, successOnly: true, steadyAfter: LOUD_STEADY },
    ]);
    expect(pingTargets(secrets)).toEqual(pingTargets(secrets, ONLY_COPY));
    expect(checksKeys({ text: `${CHECKS_KEY}=${"k".repeat(32)}
${CLOUD_KEY}=${own}
` }, CLOUD)).toEqual({ tag: "ok", value: { key: "k".repeat(32), url: own } });
    const missing = checksKeys({ text: `${CHECKS_KEY}=${"k".repeat(32)}
${PING_URL_KEY}=${URL_OF_CHECK}
` }, CLOUD);
    expect(missing).toEqual({ tag: "err", error: [`The file secrets.env needs ${CHECKS_KEY} and ${CLOUD_KEY} for this check.`] });
  });

  it("needs the first check of the copy, the token of the exchange with other copies, and its own first check", () => {
    const parsed = parseConfig(JSON.stringify(CONFIG), INSTANCE_CHECK.channels, store(SECRETS));
    if (parsed.tag === "err") throw new Error(parsed.error.join("\n"));
    const check = daemonCheck(CLOUD);
    expect(check.channels).toBe(INSTANCE_CHECK.channels);
    expect(check.problems(parsed.value, store({ ...SECRETS, [PING_URL_KEY]: URL_OF_CHECK }))).toEqual([
      `The file secrets.env has no ${CLOUD_KEY}. The live instance needs its outside heartbeat.`,
      `The file secrets.env has no ${COPY_TOKEN_KEY}. A copy with other copies needs the token of the exchange.`,
    ]);
    expect(check.problems(parsed.value, store({ ...SECRETS, [CLOUD_KEY]: URL_OF_CHECK, [COPY_TOKEN_KEY]: "t".repeat(32) }))).toEqual([]);
    // The only copy has no exchange, thus it needs no token.
    expect(daemonCheck(ONLY_COPY).problems(parsed.value, store({ ...SECRETS, [PING_URL_KEY]: URL_OF_CHECK }))).toEqual([]);
    expect(DAEMON_CHECK.problems(parsed.value, store(SECRETS))).toEqual(daemonCheck(ONLY_COPY).problems(parsed.value, store(SECRETS)));
    // The copies share the loud check. It is not the first check of a copy.
    const shared = daemonCheck({ ...ONLY_COPY, pingKey: LOUD_PING_URL_KEY }).problems(parsed.value, store({ ...SECRETS, [LOUD_PING_URL_KEY]: URL_OF_CHECK }));
    expect(shared).toEqual([`The file copy.json: pingKey is ${LOUD_PING_URL_KEY}, the key of the shared loud check. Each copy has its own first check.`]);
  });
});

describe("the delivery times of the instance", () => {
  it("gives a send as overdue after one pass limit and two full tries: 140 s, well inside an outage of 10 minutes", () => {
    expect(DELIVERY_TIMES.overdueAfter).toBe(overdueLimit({ passLimit: INSTANCE_TIMES.passLimit, flightLimit: DELIVERY_TIMES.flightLimit, retry: DELIVERY_TIMES.retry }));
    expect(DELIVERY_TIMES.overdueAfter).toBe(140_000);
    // A send of a healthy channel ends within one pass limit and one flight. It is not overdue.
    expect(DELIVERY_TIMES.overdueAfter).toBeGreaterThan(INSTANCE_TIMES.passLimit + DELIVERY_TIMES.flightLimit + DELIVERY_TIMES.retry);
  });
});

describe("sourcePace", () => {
  it("stops a host after 5 failures for the longest step of the backoff, not for one hour", async () => {
    const clock = fakeClock(T0);
    const wall: WallClock = { time: "wall", now: () => clock.now(), after: (ms, run) => clock.after(ms, run) };
    const pace = sourcePace(clock, wall, 1);
    expect(pace.policy).toBe(SOURCE_POLICY);
    expect(SOURCE_POLICY.failureStopMs).toBe(SOURCE_POLICY.backoffCapMs);
    expect(SOURCE_POLICY.failureStopMs).toBeLessThan(DEFAULT_POLICY.failureStopMs);
    const transport: Transport = async () => ({ status: 500, statusText: "Internal Server Error", headers: {}, body: "" });
    const source = createNwsSource({ pace, transport, userAgent: USER_AGENT_NAME });
    const watch: Watch = { places: [{ id: place, codes: [{ system: "state", code: "TX" }], bufferKm: 0 }] };
    // Each fetch asks for the alerts of the state and for the canary. Each answer of HTTP 500 is one failure.
    for (let fetch = 0; fetch < SOURCE_POLICY.maxFailures && pace.scheduler.stopOf(HOST) === undefined; fetch++) {
      await finish(clock, source.fetch({ watch }));
    }
    const stop = pace.scheduler.stopOf(HOST);
    expect(stop).toBeDefined();
    expect((stop?.until ?? 0) - clock.now()).toBeGreaterThan(0);
    expect((stop?.until ?? Number.POSITIVE_INFINITY) - clock.now()).toBeLessThanOrEqual(SOURCE_POLICY.backoffCapMs);
  });
});

describe("the services of the contacts of the instance", () => {
  const call = "twilio-call" as ChannelId;
  const text = "twilio-text" as ChannelId;
  // The numbers 202-555-0143 and 800-555-0100 are numbers for fiction.
  const US = "+12025550143";
  // Fake keys of Twilio. A number of the texts needs the keys.
  const KEYS = { TWILIO_ACCOUNT_SID: `AC${"0".repeat(32)}`, TWILIO_API_KEY_SID: `SK${"1".repeat(32)}`, TWILIO_API_KEY_SECRET: "s".repeat(32), TWILIO_FROM: "+99900000001" };
  const noCall: NonNullable<InstanceOptions["twilio"]> = async () => {
    throw new Error("The test makes no call.");
  };

  it("gives the carrier region of the phone of a call or a text, with the type of the text sender, and nothing for another channel", () => {
    const services = instanceServices((name) => (name === "TWILIO_TEXT_FROM" ? "+18005550100" : undefined));
    expect(services(call, { to: US })).toEqual(["provider-region:twilio/north-america/voice"]);
    expect(services(text, { to: US })).toEqual(["provider-region:twilio/north-america/sms/toll-free"]);
    expect(services(pushover, { user: "u".repeat(30) })).toEqual([]);
    expect(instanceServices(() => undefined)(text, { to: US })).toEqual(["provider-region:twilio/north-america/sms"]);
    expect([INSTANCE_CHECK.services, DAEMON_CHECK.services]).toEqual([instanceServices, instanceServices]);
  });

  it("shows a text with no type of the sender, because the type of the real sender is private", () => {
    for (const from of ["12345", "+18005550100", US]) {
      const shown = shownServices((name) => (name === "TWILIO_TEXT_FROM" ? from : undefined));
      expect(shown(text, { to: US })).toEqual(["provider-region:twilio/north-america/sms"]);
    }
    const shown = shownServices(() => undefined);
    expect(shown(call, { to: US })).toEqual(["provider-region:twilio/north-america/voice"]);
    expect(["provider-region:example/region-1/sms/long-code", "provider-region:example/region-1", "domain:api.example.com"].map(shownNode)).toEqual([
      "provider-region:example/region-1/sms",
      "provider-region:example/region-1",
      "domain:api.example.com",
    ]);
  });

  it("adds the carrier nodes of the call and text contacts to the rows of the interests, with no type of the sender", () => {
    // The layer delivery needs the defaults of the person.
    const people = CONFIG.people.map((entry) => ({ ...entry, defaults: {} }));
    const config: AlertConfig = { ...CONFIG, people, contacts: [...CONFIG.contacts, { person, channel: call, address: { to: { secret: "PHONE" } } }, { person, channel: text, address: { to: { secret: "PHONE" } } }],
      optIn: [{ number: { secret: "PHONE" }, at: "2026-11-01T00:00:00Z", way: "written", words: "texts-consent/1" }],
    };
    const { instance } = open(store({ ...SECRETS, ...KEYS, PHONE: US, TWILIO_TEXT_FROM: "+18005550100" }), config, undefined, undefined, { twilio: noCall });
    const rows = instance.interests().people[0]?.rows.map((row) => row.edge.id) ?? [];
    expect(rows).toContain("delivery/provider-region:twilio/north-america/voice>person");
    expect(rows).toContain("delivery/provider-region:twilio/north-america/sms>person");
    expect(rows.filter((id) => /long-code|short-code|toll-free/u.test(id))).toEqual([]);
    // A phone with no country gives no node.
    const unknown = open(store({ ...SECRETS, PHONE: "+15555550123" }), config).instance.interests().people[0]?.rows ?? [];
    expect(unknown.map((row) => row.edge.id).filter((id) => id.includes("provider-region:twilio"))).toEqual([]);
  });
});

describe("the messages of the operator (AL-92)", () => {
  // A made-up site: a local origin and a phone origin under a name for examples. The test opens no port.
  const PHONE = "https://site.example.net:10000";
  const TELL: TellConfig = { port: 4799, site: { local: "http://127.0.0.1:4000", phone: PHONE } };
  // The person watches each source and no place. Thus no recorded warning reaches the person, and only the messages do.
  const TELLING: AlertConfig = { ...CONFIG, people: [{ watch: { person, places: [], rules: [], subjects: [{ system: "alerts.source" }] } }], tell: TELL };
  const ASK: TellEvent = { class: "needs-you", item: "AL-92", text: "The deploy waits for your restart.", url: "http://127.0.0.1:4000/a/alerts/" };

  function openTelling() {
    const parsed = parseConfig(JSON.stringify(TELLING), INSTANCE_CHANNELS, store(SECRETS));
    if (parsed.tag === "err") throw new Error(parsed.error.join("\n"));
    let now = (): number => T0;
    const intake = createTellIntake({ config: TELL, recipients: parsed.value.recipients, now: () => now() });
    const opened = open(store(SECRETS), TELLING, undefined, undefined, { tell: intake });
    now = () => opened.clock.now();
    // Each pass after the first waits for the interval of the source tell.
    const pass = async (first = false) => {
      if (!first) await opened.clock.advance(TELL_DESCRIPTOR.interval);
      return finish(opened.clock, opened.instance.runtime.pass());
    };
    const told = () => opened.server.calls.filter((call) => (call.fields["title"] ?? "").includes("AL-92"));
    // The step of the view has only the system reports. The incidents of the view show each report of the source tell.
    const tells = (result: Awaited<ReturnType<typeof pass>>) =>
      result.view.incidents.filter((incident) => incident.kind.code.startsWith("system.tell.")).map((incident) => [incident.kind.code, incident.live, incident.reports.length]);
    return { ...opened, intake, pass, told, tells };
  }

  it("sends a new class once, and a repeat of the same class is no send: the same facts give no report, and new facts update the incident", async () => {
    const { intake, pass, told, tells } = openTelling();
    intake.take(ASK);
    const first = await pass(true);
    expect(first.fetched).toContain("tell");
    expect(tells(first)).toEqual([["system.tell.needs-you", true, 1]]);
    expect(told().map((call) => call.fields["title"])).toEqual([expect.stringContaining("Needs you: AL-92")]);
    intake.take(ASK);
    const same = await pass();
    expect(same.fetched).toContain("tell");
    expect(tells(same)).toEqual([["system.tell.needs-you", true, 1]]);
    intake.take({ ...ASK, text: "The deploy still waits for your restart." });
    const changed = await pass();
    // The update joins the incident of the first report. The throttle sends no second message at the same level.
    expect(tells(changed)).toEqual([["system.tell.needs-you", true, 2]]);
    expect(told()).toHaveLength(1);
    // A new class is a new incident. It sends once.
    intake.take({ class: "live", item: "AL-92", text: "The swap is live." });
    await pass();
    await pass();
    expect(told().map((call) => call.fields["title"])).toEqual([expect.stringContaining("Needs you: AL-92"), expect.stringContaining("Live: AL-92")]);
  });

  it("ends a live needs-you at a message done-you-asked, and sends the done message", async () => {
    const { intake, pass, told, tells } = openTelling();
    intake.take(ASK);
    await pass(true);
    intake.take({ class: "done-you-asked", item: "AL-92", text: "The restart is done." });
    const done = await pass();
    // The cancel joins the incident of the request and ends it. The done message is a new incident.
    expect(tells(done)).toHaveLength(2);
    expect(tells(done)).toContainEqual(["system.tell.done-you-asked", true, 1]);
    expect(tells(done)).toContainEqual(["system.tell.needs-you", false, 2]);
    await pass();
    expect(told().map((call) => call.fields["title"])).toEqual([expect.stringContaining("Needs you: AL-92"), expect.stringContaining("Done: AL-92")]);
  });

  it("never gives a loopback link to Pushover: a link of the local site goes in its phone form, and the intake refuses each other one", async () => {
    const { intake, pass, told, server } = openTelling();
    intake.take(ASK);
    expect(() => intake.take({ ...ASK, item: "AL-93", url: "http://127.0.0.1:9999/a/" })).toThrow(/loopback/u);
    expect(() => intake.take({ ...ASK, item: "AL-94", url: "http://[::ffff:127.0.0.1]:9999/a/" })).toThrow(/loopback/u);
    await pass(true);
    expect(told().map((call) => call.fields["url"])).toEqual([`${PHONE}/a/alerts/`]);
    const loopback = /127\.|localhost|\[::|0\.0\.0\.0/u;
    expect(server.calls.filter((call) => loopback.test(`${call.fields["url"] ?? ""} ${call.fields["message"] ?? ""}`))).toEqual([]);
  });
});
