/**
 * This module makes the instance of the owner from the private configuration. The instance has the
 * sources, the Pushover channel, the Twilio call channel, the runtime and its loop. The entry `main.ts` reads the files, and it gives the
 * clocks and the transports. This module reads no file, no environment variable and no clock.
 */
import { delay, frameClock, wallClock, type Clock, type WallClock } from "@mark1russell7/algebra/clock";
import {
  balanceFloors,
  channelDownPolicy,
  CLOCK_STEP_ABOVE,
  configuredExpectations,
  DEFAULT_LINK_POLICY,
  expectationProblems,
  foreignIncidents,
  healthPayload,
  historyPayload,
  interestsPayload,
  linkRule,
  localPlaces,
  passPlaces,
  staleMovingPlaces,
  mapPayload,
  ONLY_COPY,
  optedIn,
  placeLabels,
  placeCodesWithContaining,
  policyWithPriors,
  sendLimitsOf,
  throttleOf,
  sourceCovers,
  sourcePlaces,
  STORE_FILL_WINDOW,
  type Address,
  type AlertConfig,
  type ChannelDescriptor,
  type ChannelId,
  type ChannelProcedures,
  type ChannelQuota,
  type LoopBlock,
  type ContactServices,
  type CopySettings,
  type Duration,
  type Expectation,
  type ExpectationConfig,
  type HealthPayload,
  type HistoryPayload,
  type InterestsPayload,
  type Instant,
  type PlaceConfig,
  type Position,
  type PositionFix,
  type RegionCode,
  type StalePlace,
  type WatchedPlace,
  type MapPayload,
  type NodeKey,
  type OptInRecord,
  type ParsedConfig,
  type Report,
  type ScorePriors,
  type SecretLookup,
  type SourceDescriptor,
  type SourceProcedures,
  type SpendConfig,
} from "@mark1russell7/alerts";
import { containingCodes } from "@mark1russell7/alerts-format-nws";
import {
  CHANNEL_ID as TWILIO_CHANNEL,
  createTwilioCallChannel,
  createTwilioTextChannel,
  readTwilioBalance,
  readTwilioReplies,
  readTwilioSpend,
  TEXT_CHANNEL_ID,
  TWILIO_CALL_COST_USD,
  TWILIO_CALL_TIMEOUT_MS,
  TWILIO_TEXT_COST_USD,
  twilioCallDescriptor,
  twilioCallServices,
  twilioSetupProblems,
  twilioTextDescriptor,
  twilioTextServices,
  type BundleStore,
  type TextOptIn,
  type TwilioCredentials,
  type TwilioFetch,
} from "@mark1russell7/alerts-channel-twilio";
import { createWebhookChannel, parseWebhookSecrets, WEBHOOK_CHANNEL, webhookDescriptor, type WebhookFetch, type WebhookSecret } from "@mark1russell7/alerts-channel-webhook";
import { commandSounder, createSounderChannel, SOUNDER_CHANNEL, sounderDescriptor, sounderProblems, type CommandRunner, type SounderChannelOptions } from "@mark1russell7/alerts-channel-sounder";
import { CHANNEL_ID, createPushoverChannel, isPushoverKey, pushoverDescriptor, PUSHOVER_REPEAT_MS, PUSHOVER_TIMEOUT_MS, type PushoverChannelOptions } from "@mark1russell7/alerts-channel-pushover";
import { createEmscSource, EMSC_DESCRIPTOR } from "@mark1russell7/alerts-source-emsc";
import { createIpawsSource, IPAWS_DESCRIPTOR, WEA_EXPECTATION } from "@mark1russell7/alerts-source-ipaws";
import { createShapeStore, type ShapeCache, type ShapeStore } from "@mark1russell7/alerts-shapes-nws";
import { createNwsSource, NWS_DESCRIPTOR } from "@mark1russell7/alerts-source-nws-api";
import { COPY_EXPECTATION, createNwwsSource, SOURCE_ID as NWWS_SOURCE, type NwwsAccount, type OpenSession } from "@mark1russell7/alerts-source-nwws";
import { createGfzSource, createIndexSource, GFZ_DESCRIPTOR, HP30_DESCRIPTOR, HP30_INDEX, type GfzFetchOptions } from "@mark1russell7/alerts-source-gfz";
import { createCatalogFetch, createGtfsSource, type CatalogCopy, type GtfsFeed, type GtfsFetchOptions } from "@mark1russell7/alerts-source-gtfs-alerts";
import { createEnergyChartsSource, ENERGY_CHARTS_DESCRIPTOR } from "@mark1russell7/alerts-source-energy-charts";
import { createEia930Source, type Eia930FetchOptions } from "@mark1russell7/alerts-source-eia-930";
import { createFaaSource, FAA_DESCRIPTOR } from "@mark1russell7/alerts-source-faa";
import { createNdwSource, NDW_DESCRIPTOR } from "@mark1russell7/alerts-source-ndw";
import { createRailSource, RAIL_DESCRIPTOR } from "@mark1russell7/alerts-source-digitraffic-rail";
import { createKevSource, KEV_DESCRIPTOR } from "@mark1russell7/alerts-source-cisa-kev";
import { CERT_PROVIDERS, certDescriptor, createCertSource, type CertFetchOptions } from "@mark1russell7/alerts-source-cert-feeds";
import { createCsafSource, CSAF_PROVIDERS, csafDescriptor, type CsafFetchOptions } from "@mark1russell7/alerts-source-csaf";
import { createGdeltSource, GDELT_DESCRIPTOR } from "@mark1russell7/alerts-source-gdelt";
import { createRadarAnomaliesSource, createRadarOutagesSource, type RadarSourceOptions } from "@mark1russell7/alerts-source-cloudflare-radar";
import { AWS_DOMAIN, AWS_KIND, createAwsSource } from "@mark1russell7/alerts-source-aws";
import { AZURE_DOMAIN, AZURE_KIND, createAzureSource } from "@mark1russell7/alerts-source-azure";
import { createBomSwsSource, type BomSwsFetchOptions } from "@mark1russell7/alerts-source-bom-sws";
import { createGcpSource, GCP_KIND, GOOGLE_DASHBOARDS, type GcpFetchOptions } from "@mark1russell7/alerts-source-gcp";
import { createStatusPageSource, endpointKey, pagesFor, watchReads, type StatusPage, type StatusPageFetchOptions } from "@mark1russell7/alerts-source-statuspage";
import { createSwpcSource, SWPC_DESCRIPTOR } from "@mark1russell7/alerts-source-swpc";
import { createTsunamiSource, descriptorOf as tsunamiDescriptor, TSUNAMI_CENTERS, type TsunamiCenter, type TsunamiFetchOptions } from "@mark1russell7/alerts-source-tsunami";
import { createUsgsSource, USGS_DESCRIPTOR } from "@mark1russell7/alerts-source-usgs";
import { err, ok, type Result } from "@mark1russell7/optional";
import type { WorkerLoop } from "@mark1russell7/service";
import type { Pace, QuotaStore, Transport } from "polite-crawler/api";
import { DEFAULT_POLICY, HostScheduler, type PolitenessPolicy } from "polite-crawler/politeness";
import type { RestTransport } from "@procedures/gh";
import type { Meter } from "@opentelemetry/api";
import type { UseRead } from "@mark1russell7/stack-spend";
import { limitProblems, limitWatches, type LimitWatch } from "./use.ts";
import { jointReader, jointWatch, type JointWatch } from "./joint.ts";
import { commandRunner, driftWatch, type DriftRunner, type DriftWatch } from "./drift.ts";
import { billingWatch, type BillingWatch } from "./billing.ts";
import { chainProblems, chainWatch, readChain } from "./chain.ts";
import { balanceWatch, SPEND_UNIT, spendEntryOf, spendGates, spendQuota, spendUnits, spendWatch, type BalanceWatch, type SpendGates, type SpendWatch } from "./balance.ts";
import { spendUseReads } from "./spend-use.ts";
import { replyWatch, type ReplyWatch } from "./replies.ts";
import { parseSecrets, requireKey, SECRETS_FILE, type FileText, type InstanceCheck } from "./config.ts";
import { CLOCK_SKEW_LIMIT, COPY_FILE, COPY_TOKEN_KEY, EXCHANGE_EVERY, EXCHANGE_LIMIT } from "./copy.ts";
import { overdueLimit, type DeliveryOptions } from "./delivery.ts";
import { copyDrills, watchedDrills } from "./drills.ts";
import type { RuntimeLog } from "./log.ts";
import { createLoop, loopTimes, shortestFetchLimit, type LoopTimes, type RuntimeLoop } from "./loop.ts";
import { runtimeMetrics } from "./metrics.ts";
import { outageDeploy, outageDeployWorker, outageSetup, type OutageDeployWorker } from "./outage.ts";
import { exchangeLoop, exchangeWorker, type EntriesSource, type ExchangeCall, type ExchangeRound, type ExchangeWorker } from "./peers.ts";
import { channelQuota } from "./quota.ts";
import { keptPass, openRuntime, type CopyChecks, type KeptPass, type Pass, type Runtime, type RuntimeOptions } from "./runtime.ts";
import { contextKey, START_SNAPSHOT_EVERY, START_SNAPSHOT_FLOOR } from "./start-snapshot.ts";
import { addZoneCodes, codesAtFix, keepShapes, placeCodesKey, refreshUntil, shapeSources, type InstanceShapes, type ShapeOutcome, type ZoneCodeCounts } from "./shapes.ts";
import { chooseFeeds, feedsKey, keepTransit, type ChosenFeeds, type InstanceTransit, type TransitCache, type TransitOutcome } from "./transit.ts";
import { fixReads, type PositionIntake } from "./position-intake.ts";
import { tellSource, type TellIntake } from "./tell-intake.ts";
import { DELAY_LIMITS, nextFetch } from "./view.ts";

/** The name of the secret that holds the API token of the Pushover application. */
export const PUSHOVER_TOKEN = "PUSHOVER_APP_TOKEN";

/** The name of the key of `secrets.env` that holds the address of the outside heartbeat. */
export const PING_URL_KEY = "HEALTHCHECKS_PING_URL";

/**
 * The name of the optional key of `secrets.env` that holds the address of a second check: the loud
 * check. Its integration makes a phone call to the person, and it shares no channel with the instance. The
 * heartbeat sends each ping to the first check of the copy, and only the success pings to the loud check (AL-100).
 * Thus the loud check goes down only when no copy can tell the person. Without the key, nothing changes.
 */
export const LOUD_PING_URL_KEY = "HEALTHCHECKS_LOUD_PING_URL";

/**
 * The steady run of a copy before its first success ping to the loud check: 5 minutes after its first pass (AL-100).
 * On 2026-11-21, the starts of a copy with too little memory stopped after one to three minutes of passes. Each of their
 * success pings ended the down of the loud check, and the next down called again. A copy that stops in this time sends
 * no success, thus one outage gives one call.
 */
export const LOUD_STEADY: Duration = 5 * 60_000;

/**
 * This function tells if a start is steady: its passes span `LOUD_STEADY` or more (AL-108). It is the rule of the first
 * success ping to the loud check. The answer of the exchange tells it to each other copy.
 */
export const steadyPasses = (first: Pick<Pass, "at"> | undefined, last: Pick<Pass, "at"> | undefined): boolean => first !== undefined && last !== undefined && last.at - first.at >= LOUD_STEADY;

/**
 * This function gives the key of `secrets.env` with the address of the first check of a copy. Each copy has its own
 * first check, thus a stop of one copy makes its own alert. The default key is `PING_URL_KEY`.
 */
export const pingKeyOf = (copy: CopySettings): string => copy.pingKey ?? PING_URL_KEY;

/** One check of the outside heartbeat: the key of `secrets.env`, its address, and the pings that it gets. */
export interface PingTarget {
  /** The key of the first check of the copy, or `LOUD_PING_URL_KEY`. */
  readonly key: string;
  readonly url: string;
  /** The value `true` gives only the success pings to the check: the option `successOnly` of the heartbeat. The loud check has it. */
  readonly successOnly: boolean;
  /** The wait before the first success ping: the option `steadyAfter` of the heartbeat. It is `LOUD_STEADY` for the loud check, else 0. */
  readonly steadyAfter: Duration;
}

/**
 * This function gives the checks of the outside heartbeat from the secrets: the first check of the copy, then the loud
 * check. A key with an empty value gives no check.
 *
 * - The first check of the copy gets each ping. Thus a fail of the copy goes at once to the owner.
 * - The copies share the loud check, thus it gets only the success pings. It goes down only when the success pings of all
 *   the copies stop for its grace: no copy can tell the person. Thus a fail of one copy makes no call while another copy
 *   works. Its first success ping waits for `LOUD_STEADY` after the first pass of the copy. Thus one outage gives one call.
 */
export function pingTargets(secret: (key: string) => string | undefined, copy: CopySettings = ONLY_COPY): readonly PingTarget[] {
  return [pingKeyOf(copy), LOUD_PING_URL_KEY].flatMap((key): PingTarget[] => {
    const url = secret(key) ?? "";
    const loud = key === LOUD_PING_URL_KEY;
    return url === "" ? [] : [{ key, url, successOnly: loud, steadyAfter: loud ? LOUD_STEADY : 0 }];
  });
}

/**
 * The name of the key of `secrets.env` that holds the key of the management API of Healthchecks.io. The status of
 * `install.ts` reads it. The runtime reads the joint down time of the copies with it (AL-148). With no key or no
 * `LOUD_PING_URL_KEY`, the runtime has no watch of the joint down time and no line of it.
 */
export const CHECKS_KEY = "HEALTHCHECKS_API_KEY";

/** The two keys of the status check of the heartbeat. */
export interface ChecksKeys {
  /** The key of the management API. */
  readonly key: string;
  /** The address of the outside heartbeat. */
  readonly url: string;
  /** The address of the loud check, when `secrets.env` has one. */
  readonly loudUrl?: string;
}

/**
 * This function gives the keys of the status check of the heartbeat from the text of `secrets.env`. The keys are
 * the key of the API, the first check of the copy and the loud check. It parses the text as the start does. A problem holds no value and no path.
 */
export function checksKeys(file: FileText, copy: CopySettings = ONLY_COPY): Result<ChecksKeys, readonly string[]> {
  const keys = parseSecrets(file);
  if (keys.tag === "err") return keys;
  const pingKey = pingKeyOf(copy);
  const key = keys.value[CHECKS_KEY] ?? "";
  const url = keys.value[pingKey] ?? "";
  const loudUrl = keys.value[LOUD_PING_URL_KEY] ?? "";
  if (key === "" || url === "") return err([`The file ${SECRETS_FILE} needs ${CHECKS_KEY} and ${pingKey} for this check.`]);
  return ok(loudUrl === "" ? { key, url } : { key, url, loudUrl });
}

/** The name of the application in the User-Agent of each request. The NWS asks for a name and a contact. */
export const USER_AGENT_NAME = "alerts-runtime";

/**
 * This function gives the User-Agent of each request of the instance: the name, and the contact of the
 * operator when the configuration has one. Without a contact, no request names a person or an account.
 */
export const userAgent = (contact: string | undefined): string => (contact === undefined ? USER_AGENT_NAME : `${USER_AGENT_NAME} (+${contact})`);

// The limits of the delays are in `view.ts`, because the measure of the IEM list reads them too.
export { DELAY_LIMITS };

/**
 * The descriptors of the channels of the instance. The loader of the configuration checks each
 * recipient against this list: the channel of each step, and the fields of each address. Thus the loader
 * and the instance agree on the channels.
 */
export const INSTANCE_CHANNELS: readonly ChannelDescriptor[] = [pushoverDescriptor(), twilioCallDescriptor(), twilioTextDescriptor(), webhookDescriptor(), sounderDescriptor()];

/**
 * The names of the keys of `secrets.env` for the Twilio call channel. The secret is the secret of an API key
 * of the account, not the auth token of the account.
 */
export const TWILIO_KEYS = { accountSid: "TWILIO_ACCOUNT_SID", keySid: "TWILIO_API_KEY_SID", secret: "TWILIO_API_KEY_SECRET", from: "TWILIO_FROM" } as const;

/**
 * The name of the key of `secrets.env` that holds the Twilio number of the texts. A text to a phone in the United States
 * needs a registered sender: the phone of a 10DLC campaign or a verified toll-free phone. Without the key, the instance sends no text.
 */
export const TWILIO_TEXT_FROM_KEY = "TWILIO_TEXT_FROM";

/**
 * The name of the key of `secrets.env` that holds the secrets of the webhook channel (AL-55), in the `whsec_` form of
 * Standard Webhooks. A space splits two secrets, thus a receiver can change its secret with no gap. Without the key, the
 * instance has no webhook channel.
 */
export const WEBHOOK_SECRET_KEY = "WEBHOOK_SECRET";

/** The User-Agent of each request of the webhook channel. A receiver gets no contact of the configuration. */
export const WEBHOOK_USER_AGENT = "alerts-runtime";

/**
 * This function gives the secrets of the webhook channel from the secret store. With no value of `WEBHOOK_SECRET_KEY`, it
 * gives `undefined`. A bad value gives a problem that names the key and no value.
 */
export function webhookSetup(secret: SecretLookup): Result<readonly WebhookSecret[] | undefined, readonly string[]> {
  const text = secret(WEBHOOK_SECRET_KEY) ?? "";
  if (text.trim() === "") return ok(undefined);
  const parsed = parseWebhookSecrets(text);
  return parsed.ok ? ok(parsed.secrets) : err([`The value of ${WEBHOOK_SECRET_KEY} is not a list of secrets of Standard Webhooks. ${parsed.problem}`]);
}

/** The setup of the Twilio channels: the credentials of the account, the number that calls and the number that texts. */
export interface TwilioSetup {
  readonly credentials: TwilioCredentials;
  readonly from: string;
  /** The number of the text channel and of the texts of the outage call, from the key `TWILIO_TEXT_FROM_KEY`. */
  readonly textFrom?: string;
}

/**
 * This function gives the setup of the Twilio channels from the secrets.
 *
 * - With none of the keys of `TWILIO_KEYS`, it gives `undefined`. The instance then has no call channel and no text channel.
 * - With some keys and not all, or with a value of a bad form, it gives the problems. A problem names keys, and no value.
 * - The key `TWILIO_TEXT_FROM_KEY` is optional. It needs the keys of `TWILIO_KEYS`.
 */
export function twilioSetup(secret: SecretLookup): Result<TwilioSetup | undefined, readonly string[]> {
  const value = (name: string): string => secret(name) ?? "";
  const names = Object.values(TWILIO_KEYS);
  const missing = names.filter((name) => value(name) === "");
  const textFrom = value(TWILIO_TEXT_FROM_KEY);
  if (missing.length === names.length) {
    return textFrom === "" ? ok(undefined) : err([`The secret store has a value for ${TWILIO_TEXT_FROM_KEY}, and no keys of Twilio. Give the keys of Twilio, or remove the value.`]);
  }
  if (missing.length > 0) return err([`The secret store has some keys of Twilio, and it has no value for ${missing.join(", ")}. Give all the keys, or none.`]);
  const setup: TwilioSetup = {
    credentials: { accountSid: value(TWILIO_KEYS.accountSid), keySid: value(TWILIO_KEYS.keySid), secret: value(TWILIO_KEYS.secret) },
    from: value(TWILIO_KEYS.from),
    ...(textFrom === "" ? {} : { textFrom }),
  };
  const problems = twilioSetupProblems(setup.credentials, setup.from, setup.textFrom);
  return problems.length === 0 ? ok(setup) : err(problems.map((problem) => `The keys of Twilio have a problem: ${problem}`));
}

/** The ids of the sources with an account. The field `accounts` of the settings of a copy names only these sources. */
export const ACCOUNT_SOURCES: readonly string[] = [NWWS_SOURCE];

/** This function gives the names of the keys of `secrets.env` for an account of NWWS-OI. The keys of account `n` end in `_n`. */
export function nwwsKeys(account: number): { readonly username: string; readonly password: string } {
  return { username: `NWWS_OI_USER_${String(account)}`, password: `NWWS_OI_PASSWORD_${String(account)}` };
}

/**
 * This function gives the account of the NWWS-OI source of a copy from the secrets. The field `accounts` of the copy gives
 * the number of the account. The default is account 1.
 *
 * - With no key of account 1, and no account in the copy, it gives `undefined`. The instance then has no NWWS-OI source.
 * - With one key of the pair and not the other, it gives a problem. A problem names keys, and no value.
 * - With an account in the copy and no key of that account, it gives a problem.
 */
export function nwwsSetup(secret: SecretLookup, copy: CopySettings = ONLY_COPY): Result<NwwsAccount | undefined, readonly string[]> {
  const account = copy.accounts?.[NWWS_SOURCE];
  const keys = nwwsKeys(account ?? 1);
  const username = secret(keys.username) ?? "";
  const password = secret(keys.password) ?? "";
  if (username !== "" && password !== "") return ok({ username, password });
  const missing = [keys.username, keys.password].filter((name) => (secret(name) ?? "") === "");
  if (missing.length === 1) return err([`The secret store has one key of the NWWS-OI account ${String(account ?? 1)}, and it has no value for ${missing.join(", ")}. Give the two keys, or none.`]);
  if (account === undefined) return ok(undefined);
  return err([`The file ${COPY_FILE} gives the NWWS-OI account ${String(account)} to this copy, and the secret store has no value for ${missing.join(", ")}.`]);
}

/** This function gives the problems of the field `accounts` of a copy: each id of a source with no account. */
function accountProblems(copy: CopySettings): string[] {
  return Object.keys(copy.accounts ?? {})
    .filter((id) => !ACCOUNT_SOURCES.includes(id))
    .map((id) => `The file ${COPY_FILE}: the field accounts names the source ${id}. Only these sources have an account: ${ACCOUNT_SOURCES.join(", ")}.`);
}

/** This function gives the problems of the field `leaveChannels` of a copy: each id that is not a channel of the instance. */
function leaveProblems(copy: CopySettings): string[] {
  const known = INSTANCE_CHANNELS.map((descriptor) => descriptor.id as string);
  return (copy.leaveChannels ?? [])
    .filter((id) => !known.includes(id))
    .map((id) => `The file ${COPY_FILE}: the field leaveChannels names the channel ${id}. The channels of the instance are ${known.join(", ")}.`);
}

/**
 * This function gives the options of the sounder channel of a copy (AL-41), or `undefined` when the copy has no field
 * `sounder`. Each device starts its programs with the runner `run`, with no shell.
 */
export function sounderOptions(copy: CopySettings, run: CommandRunner, now: () => Instant = Date.now): SounderChannelOptions | undefined {
  const sounder = copy.sounder;
  if (sounder === undefined) return undefined;
  const sounders = Object.fromEntries(
    Object.entries(sounder.devices).map(([name, device]) => [
      name,
      commandSounder({ sound: device.sound, run, ...(device.levels === undefined ? {} : { levels: device.levels }), ...(device.probe === undefined ? {} : { probe: device.probe }) }),
    ]),
  );
  return { sounders, now, ...(sounder.sounds === undefined ? {} : { sounds: sounder.sounds }), ...(sounder.gapMs === undefined ? {} : { gapMs: sounder.gapMs }) };
}

/**
 * This function gives the problems of the field `sounder` of a copy (AL-41). These are the problems of `sounderProblems`.
 * Also, a copy with a sounder does not leave the channel to the other copies. The problems name no program and no argument.
 */
export function copySounderProblems(copy: CopySettings): string[] {
  const options = sounderOptions(copy, () => Promise.resolve({ exitCode: 0 }));
  if (options === undefined) return [];
  const left = (copy.leaveChannels ?? []).includes(SOUNDER_CHANNEL)
    ? [`The file ${COPY_FILE}: the copy has the field sounder, and its field leaveChannels names the channel ${SOUNDER_CHANNEL}. Remove one of the two.`]
    : [];
  return [...sounderProblems(options).map((problem) => `The file ${COPY_FILE}: the field sounder: ${problem}`), ...left];
}

/**
 * This function gives the channels that the instance sends on. Pushover is always one. The Twilio call channel needs the keys of
 * `TWILIO_KEYS`, and the text channel also needs `TWILIO_TEXT_FROM_KEY`. The webhook channel needs `WEBHOOK_SECRET_KEY`. The sounder channel
 * needs the field `sounder` of the copy (AL-41). A step on another channel of `INSTANCE_CHANNELS` stops the start.
 */
export function instanceSenders(secret: SecretLookup, copy: CopySettings = ONLY_COPY): readonly ChannelId[] {
  const webhook = webhookSetup(secret);
  const hooks = [...(webhook.tag === "ok" && webhook.value !== undefined ? [WEBHOOK_CHANNEL] : []), ...(copy.sounder === undefined ? [] : [SOUNDER_CHANNEL])];
  const twilio = twilioSetup(secret);
  if (twilio.tag === "err" || twilio.value === undefined) return [CHANNEL_ID, ...hooks];
  return twilio.value.textFrom === undefined ? [CHANNEL_ID, TWILIO_CHANNEL, ...hooks] : [CHANNEL_ID, TWILIO_CHANNEL, TEXT_CHANNEL_ID, ...hooks];
}

/** The tsunami warning centers of the NWS. Each center is a source of its own, with its own health. */
const TSUNAMI = [TSUNAMI_CENTERS.ntwc, TSUNAMI_CENTERS.ptwc] as const;

/** This function gives the factory of the source of one tsunami warning center. */
const tsunamiFactory =
  (center: TsunamiCenter) =>
  (options: Omit<TsunamiFetchOptions, "center">): SourceProcedures =>
    createTsunamiSource({ ...options, center });

/** This function gives the factory of the source of one transit feed. */
const transitFactory =
  (feed: GtfsFeed) =>
  (options: Omit<GtfsFetchOptions, "feed">): SourceProcedures =>
    createGtfsSource({ ...options, feed });

/** This function gives the factory of the source of one status page. */
const statusPageFactory =
  (page: StatusPage) =>
  (options: Omit<StatusPageFetchOptions, "page">): SourceProcedures =>
    createStatusPageSource({ ...options, page });

/**
 * The name of the key of `secrets.env` that holds the API key of the Space Weather Services of BoM. With the key, the
 * instance reads BoM: a third origin of the geomagnetic storm, apart from the SWPC and GFZ.
 */
export const BOM_SWS_KEY = "BOM_SWS_API_KEY";

/** This function gives the factory of the BoM source with the key of the secrets. The key goes only into the body of each POST. */
const bomFactory =
  (apiKey: string) =>
  (options: Omit<BomSwsFetchOptions, "apiKey">): SourceProcedures =>
    createBomSwsSource({ ...options, apiKey });

/**
 * The name of the key of `secrets.env` that holds the API key of EIA. With the key, the instance reads EIA-930: the hourly
 * demand of each balancing authority of the United States, with its day-ahead forecast.
 */
export const EIA_KEY = "EIA_API_KEY";

/**
 * This function gives the factory of the EIA-930 source with the key of the secrets. The API takes the key only in the
 * query of the URL. The source removes it from each URL and each message that it gives.
 */
const eiaFactory =
  (apiKey: string) =>
  (options: Omit<Eia930FetchOptions, "apiKey">): SourceProcedures =>
    createEia930Source({ ...options, apiKey });

/**
 * The name of the key of `secrets.env` that holds the API token of Cloudflare Radar. With the token, the instance reads
 * the confirmed internet outages and the traffic anomalies of Radar.
 */
export const CLOUDFLARE_RADAR_KEY = "CLOUDFLARE_RADAR_TOKEN";

/** This function gives the factories of the two Radar sources with the token of the secrets. The token goes only into the header `authorization`. */
const radarFactories = (token: string) =>
  [createRadarOutagesSource, createRadarAnomaliesSource].map(
    (create) =>
      (options: Omit<RadarSourceOptions, "token">): SourceProcedures =>
        create({ ...options, token }),
  );

/**
 * The feeds of the cloud providers: the dashboards of Google (Google Cloud and Firebase), AWS and Azure. A report of such
 * a feed has no area. Thus the instance reads a feed only when one of its persons can get its reports, with the rule of a
 * status page (`watchReads`). The keys of the products of a dashboard are its keys of components.
 */
const PROVIDER_FEEDS = [
  ...GOOGLE_DASHBOARDS.map((dashboard) => ({
    domain: dashboard.domain,
    kind: GCP_KIND,
    components: dashboard.products.map((product) => endpointKey(product.id, product.name, product.domain)),
    create: (options: Omit<GcpFetchOptions, "dashboard">) => createGcpSource({ ...options, dashboard }),
  })),
  { domain: AWS_DOMAIN, kind: AWS_KIND, create: createAwsSource },
  { domain: AZURE_DOMAIN, kind: AZURE_KIND, create: createAzureSource },
];

/**
 * The descriptors of the sources of the instance. The function `describe` of each source gives the same descriptor.
 * The USGS and EMSC give the earthquakes. Merge rule 3 (`linkRule` of the core) joins their reports of one event.
 * The two tsunami warning centers give the tsunami messages. The SWPC gives the space weather messages.
 *
 * GFZ gives the index Kp, a second origin of the geomagnetic storms. Merge rule 3 joins its storms to the storms of the SWPC.
 * GFZ also gives the index Hp30 of each 30 minutes, as the source `gfz-hp30`. It shows a storm before the end of its interval of Kp.
 *
 * Energy-Charts gives the grid frequency of Continental Europe as indicator readings, and no event. The store of the
 * readings keeps them.
 *
 * CISA KEV gives the known exploited flaws of software, with no area. The work `software` of `WORK_DEFAULTS` in the core
 * names their kind.
 *
 * The CSAF providers (`source-csaf`) give the security advisories of CISA and of vendors of control systems, with no
 * area. No work names their kinds: a person gets an advisory when the person names its CVE id or its kind.
 *
 * The CERT feeds (`source-cert-feeds`) give the alerts and reports of national CERTs, with no area. Only the work
 * `software` names one of their kinds: a flaw that attackers use at this time.
 *
 * The instance also reads the status pages that one of its persons can get (`pagesFor` of `source-statuspage`). They are
 * not in this list, because the persons choose them. The feeds of Google Cloud (`source-gcp`), AWS (`source-aws`)
 * and Azure (`source-azure`) have the same rule.
 *
 * BoM (`source-bom-sws`), EIA-930 (`source-eia-930`) and the two sources of Cloudflare Radar (`source-cloudflare-radar`)
 * are sources only when the secrets have their keys. Thus they are not in the list. Each page, each feed, BoM, EIA-930
 * and Radar have a longer interval than the shortest interval of the list. Thus the times of the loop stay the same.
 */
export const INSTANCE_SOURCES: readonly SourceDescriptor[] = [
  NWS_DESCRIPTOR,
  IPAWS_DESCRIPTOR,
  USGS_DESCRIPTOR,
  EMSC_DESCRIPTOR,
  ...TSUNAMI.map((center) => tsunamiDescriptor(center)),
  SWPC_DESCRIPTOR,
  GFZ_DESCRIPTOR,
  HP30_DESCRIPTOR,
  ENERGY_CHARTS_DESCRIPTOR,
  FAA_DESCRIPTOR,
  NDW_DESCRIPTOR,
  RAIL_DESCRIPTOR,
  KEV_DESCRIPTOR,
  ...CSAF_PROVIDERS.map((provider) => csafDescriptor(provider)),
  ...CERT_PROVIDERS.map((provider) => certDescriptor(provider)),
];

/**
 * The expectations of the instance. The field `expectations` of the configuration sets their `since`. An instance uses
 * only the expectations of its sources: a copy with no account of NWWS-OI has no check of NWWS-OI.
 */
export const INSTANCE_EXPECTATIONS: readonly Expectation[] = [WEA_EXPECTATION, COPY_EXPECTATION];

/**
 * This function gives the expectations of an instance with the sources `sources`. They are the expectations of
 * `INSTANCE_EXPECTATIONS` whose two sources are in the list, with the `since` of the settings.
 */
export function instanceExpectations(settings: readonly ExpectationConfig[] | undefined, sources: readonly SourceDescriptor[]): Expectation[] {
  const ids = new Set(sources.map((source) => source.id));
  return configuredExpectations(INSTANCE_EXPECTATIONS, settings).filter((expectation) => ids.has(expectation.from) && ids.has(expectation.to));
}

/**
 * The politeness policy of the sources. After 5 failures in a row, a host stops for the longest step of the backoff, not for
 * the hour of `DEFAULT_POLICY`. A stop of one hour hides each alert of that hour.
 *
 * - Each failure after the stop stops the host again. Thus a failed host gets one request in each 5 minutes, as at the end of the backoff.
 * - After an outage, the health of a source comes up in the stop and two intervals. One interval is the wait for the next pass.
 *   The other interval is the limit of a fetch.
 */
export const SOURCE_POLICY: PolitenessPolicy = { ...DEFAULT_POLICY, failureStopMs: DEFAULT_POLICY.backoffCapMs };

/**
 * This function gives the pace of the sources of an instance: one scheduler for `sources` hosts on the clocks of the
 * instance, and `SOURCE_POLICY`. The pace of the sources reads the clocks of the instance, not the clock of polite-crawler.
 */
export function sourcePace(clock: Clock, wall: WallClock, sources: number): Pace & { readonly scheduler: HostScheduler } {
  const scheduler = new HostScheduler({ now: () => wall.now(), sleep: (ms, signal) => delay(clock, ms, signal).catch(() => undefined) }, sources);
  return { scheduler, now: () => wall.now(), policy: SOURCE_POLICY };
}

/** Each channel stops its own call at its time limit. This limit is the longest of them. */
const CALL_LIMIT = Math.max(PUSHOVER_TIMEOUT_MS, TWILIO_CALL_TIMEOUT_MS);

/**
 * The longest time of one fetch of a source of the instance: its interval, up to the shortest interval of the sources.
 * Thus the fetch of GFZ, with an interval of 10 minutes, does not hold the messages of the NWS for 10 minutes.
 */
export const INSTANCE_FETCH_LIMIT: (source: SourceDescriptor) => Duration = shortestFetchLimit(INSTANCE_SOURCES);

/**
 * The times of the loop of the instance. They come from the fetch limits of the sources and the time
 * limit of the Pushover channel. The host reads them before a start: the stop grace holds one pass.
 *
 * The stream of NWWS-OI has a shorter interval. It makes only the cap of the retry of its instance shorter, thus these
 * times stay a bound of the times of each instance.
 */
export const INSTANCE_TIMES: LoopTimes = loopTimes(INSTANCE_SOURCES, { delivery: { callLimit: CALL_LIMIT, retry: CALL_LIMIT }, fetchLimit: INSTANCE_FETCH_LIMIT });

/** The times of the delivery step of an instance. The fault cases of the channel use these times. */
export const DELIVERY_TIMES: Pick<DeliveryOptions, "pollEvery" | "retry" | "callLimit" | "flightLimit"> & { readonly overdueAfter: Duration } = {
  // A `life-safety` message repeats until the person acknowledges it. A poll at the pace of the repeats sees an acknowledgment in one repeat.
  pollEvery: PUSHOVER_REPEAT_MS,
  // A failed call goes again after the time limit of one call. Pushover asks for a wait of 5 seconds or more after a failure.
  retry: CALL_LIMIT,
  callLimit: CALL_LIMIT,
  // A send ends by the time limit of the channel. A second send of its key goes after its retry.
  flightLimit: CALL_LIMIT + CALL_LIMIT,
  // A send with no delivery two full tries after its due time makes the heartbeat fail: 140 s.
  overdueAfter: overdueLimit({ passLimit: INSTANCE_TIMES.passLimit, flightLimit: CALL_LIMIT + CALL_LIMIT, retry: CALL_LIMIT }),
};

/**
 * The default wait of each rank of a copy: 30 s. The table `rankDelay` of the configuration can give another wait for a level. A copy with rank 1 sends a step 30 s after the copy with rank 0. In that
 * time, the send of rank 0 ends, and its delivery comes to rank 1 by the exchange:
 *
 * - the flight limit of one send, 20 s
 * - one interval of the exchange, 5 s, and the time limit of one read, 3 s
 * - the largest difference of the clocks of the copies with no system line, 2 s.
 */
export const RANK_DELAY: Duration = DELIVERY_TIMES.flightLimit + EXCHANGE_EVERY + EXCHANGE_LIMIT + CLOCK_SKEW_LIMIT;

/**
 * The default least wait of each rank before a step of an exclusive channel, as a call: 31 s. A phone takes one call at
 * a time. Thus a copy with rank 1 calls only after the call of rank 0 is in its ledger. In the worst case:
 *
 * - rank 0 sees the incident one exchange after rank 1: one interval, 5 s, and one read, 3 s
 * - the send of rank 0 ends in the call limit, 10 s
 * - the delivery comes to rank 1 by the exchange: a read in progress misses it, thus two intervals and one read, 13 s.
 *
 * The field `rankFloor` of the configuration replaces it.
 */
export const RANK_FLOOR: Duration = DELIVERY_TIMES.callLimit + 3 * EXCHANGE_EVERY + 2 * EXCHANGE_LIMIT;

/**
 * This function gives the problems of a configuration that stop the start of the instance:
 *
 * - a missing token, or a token with a bad form
 * - some keys of Twilio and not all, or a key of Twilio with a bad form
 * - a value of `WEBHOOK_SECRET_KEY` that is not a list of secrets of Standard Webhooks
 * - one key of the NWWS-OI account of the copy and not the other, or an account of the copy with no keys
 * - an id of a source with no account in the field `accounts` of the copy
 * - an id in the field `leaveChannels` of the copy that is not a channel of `INSTANCE_CHANNELS`
 * - each problem of `copySounderProblems`: a bad field `sounder` of the copy (AL-41)
 * - a step of a policy on a channel with no sender, when the copy does not leave the channel to the other copies
 * - a step on a channel with a cost, when the configuration has no spend entry for its provider
 * - a place that no regional source covers. A source with the coverage `global` covers each place, with no code.
 * - an outage call with no keys of Twilio, no token `OUTAGE_TOKEN` or a bad list
 * - a setting of an unknown expectation, or a `since` after the time `at`
 * - each problem of `limitProblems`.
 * - each problem of `chainProblems`: a stack of the alert chain with a fault (AL-90).
 *
 * The message names ids, fields and the names of secrets, and no value.
 *
 * The function `parseConfig` checks the fields of each address with the descriptors of `INSTANCE_CHANNELS`.
 */
export function instanceProblems(parsed: ParsedConfig, secret: SecretLookup, descriptors: readonly SourceDescriptor[], at: Instant, copy: CopySettings = ONLY_COPY): string[] {
  const token = secret(PUSHOVER_TOKEN) ?? "";
  // A bad key fails each send. Thus it stops the start, before the first alert.
  const tokenProblems =
    token === ""
      ? [`The secret store has no value for ${PUSHOVER_TOKEN}, the API token of the Pushover application.`]
      : isPushoverKey(token)
        ? []
        : [`The value of ${PUSHOVER_TOKEN} is not a key of Pushover: 30 letters and digits.`];
  // Bad keys of Twilio fail each call. Thus they stop the start, before the first alert.
  const twilio = twilioSetup(secret);
  const twilioProblems = twilio.tag === "err" ? twilio.error : [];
  // A bad secret of the webhook channel fails each send. Thus it stops the start, before the first alert.
  const webhook = webhookSetup(secret);
  const webhookProblems = webhook.tag === "err" ? webhook.error : [];
  // A half of a key pair of NWWS-OI is a fault of the secret store, not a choice of no stream. Thus it stops the start.
  const nwws = nwwsSetup(secret, copy);
  const nwwsProblems = nwws.tag === "err" ? nwws.error : [];
  // A step on a channel with no sender fails each send of the step. Thus it stops the start. A copy sends nothing on a
  // channel that it leaves to the other copies (AL-55). Thus such a step needs no sender of this copy.
  const senders = instanceSenders(secret, copy);
  const left = new Set<string>(copy.leaveChannels ?? []);
  const senderProblems = parsed.recipients.flatMap((recipient) =>
    recipient.policies.flatMap((policy) =>
      policy.steps.flatMap((step, index) =>
        senders.includes(step.channel) || left.has(step.channel)
          ? []
          : [`Step ${index} of ${policy.level} of ${recipient.watch.person} uses the channel ${step.channel}, and the instance has no sender on it.`],
      ),
    ),
  );
  // A send on a channel with a cost needs a cap. Without it, a fault of a loop can spend all the money of the account.
  const used = new Set(parsed.recipients.flatMap((recipient) => recipient.policies.flatMap((policy) => policy.steps.map((step) => step.channel))));
  const spendProblems = INSTANCE_CHANNELS.flatMap((descriptor) =>
    senders.includes(descriptor.id) && !left.has(descriptor.id) && used.has(descriptor.id) && (descriptor.costUsd ?? 0) > 0 && spendEntryOf(descriptor, parsed.config.spend) === undefined
      ? [`The channel ${descriptor.id} costs money, and the configuration has no spend entry for its provider. Give an entry with a monthly cap.`]
      : [],
  );
  // A place that no regional source covers gets no alert of its area. The usual cause is a missing code or a wrong code.
  // A global source covers each place with no code, so it tells nothing about the codes of a place.
  // The check adds the codes that hold each code of the place, as the coverage of the view does.
  const regional = descriptors.filter((descriptor) => descriptor.coverage !== "global");
  const kinds = [...new Set(regional.flatMap((descriptor) => descriptor.kinds))];
  const placeProblems = localPlaces(parsed.config).flatMap((place) => {
    const widened = { ...place, codes: placeCodesWithContaining(place.codes, containingCodes) };
    return regional.some((descriptor) => kinds.some((kind) => sourceCovers(descriptor, widened, kind)))
      ? []
      : [`No regional source covers the place ${place.id}. Give the place a code that a source holds: an NWS zone or county, a SAME code, a state or a country (iso3166).`];
  });
  // The outage call deploys at the start. A bad list or a missing key fails the deploy, so it stops the start.
  const outage = outageSetup(parsed, secret, twilio.tag === "ok" ? twilio.value : undefined);
  const outageProblems = outage.tag === "err" ? outage.error : [];
  return [
    ...tokenProblems,
    ...twilioProblems,
    ...webhookProblems,
    ...nwwsProblems,
    ...accountProblems(copy),
    ...leaveProblems(copy),
    ...copySounderProblems(copy),
    ...senderProblems,
    ...spendProblems,
    ...placeProblems,
    ...outageProblems,
    ...expectationProblems(parsed.config.expectations, INSTANCE_EXPECTATIONS, at),
    ...limitProblems(parsed.config.limits ?? [], secret),
    ...chainProblems(parsed.config.chain),
  ];
}

/**
 * This function gives the services of the contacts of the instance (`ContactServices`). A contact of the call channel or the
 * text channel gets the carrier region of Twilio of its phone. The text channel adds the type of the number of
 * `TWILIO_TEXT_FROM_KEY`. Each other channel gives no services. No log and no problem holds the result.
 */
export function instanceServices(secret: SecretLookup): ContactServices {
  const textFrom = secret(TWILIO_TEXT_FROM_KEY);
  const byChannel = new Map<ChannelId, (address: Address) => readonly NodeKey[]>([
    [TWILIO_CHANNEL, twilioCallServices],
    [TEXT_CHANNEL_ID, (address) => twilioTextServices(address, textFrom)],
  ]);
  return (channel, address) => byChannel.get(channel)?.(address) ?? [];
}

// The system of the carrier regions, and the parts of its path that the route `GET /interests` shows: the provider, the
// region and the product.
const PROVIDER_REGION = "provider-region:";
const SHOWN_PARTS = 3;

/**
 * This function cuts a node of a carrier region to its provider, region and product. A deeper part, as the type of a text
 * sender, is a private fact. Each other node stays the same.
 */
export function shownNode(node: NodeKey): NodeKey {
  if (!node.startsWith(PROVIDER_REGION)) return node;
  return PROVIDER_REGION + node.slice(PROVIDER_REGION.length).split("/").slice(0, SHOWN_PARTS).join("/");
}

/**
 * This function gives the services of the contacts that the route `GET /interests` shows (`shownNode`). Thus a text shows
 * `.../north-america/sms` with no type of the sender. The load keeps the full node, thus the matching does not change.
 */
export function shownServices(secret: SecretLookup): ContactServices {
  const services = instanceServices(secret);
  return (channel, address) => [...new Set(services(channel, address).map(shownNode))];
}

/**
 * This function gives the check of a configuration file for the instance of a copy. The check has the channels, the
 * services of the contacts and the problems that stop the start.
 */
export function instanceCheck(copy: CopySettings = ONLY_COPY): InstanceCheck {
  return { channels: INSTANCE_CHANNELS, services: instanceServices, problems: (parsed, secret) => instanceProblems(parsed, secret, INSTANCE_SOURCES, wallClock().now(), copy) };
}

/** The check of a configuration file for the instance of the only copy: `instanceCheck(ONLY_COPY)`. */
export const INSTANCE_CHECK: InstanceCheck = instanceCheck(ONLY_COPY);

/**
 * This function gives the check of the live instance of a copy, the profile `daemon`. It adds the key of the first
 * check of the copy to `instanceCheck(copy)`, because the live instance does not start without its heartbeat. A copy with
 * other copies also needs the token of the exchange.
 */
export function daemonCheck(copy: CopySettings): InstanceCheck {
  const pingKey = pingKeyOf(copy);
  const ping = requireKey(instanceCheck(copy), pingKey, "The live instance needs its outside heartbeat.");
  const check = (copy.peers ?? []).length === 0 ? ping : requireKey(ping, COPY_TOKEN_KEY, "A copy with other copies needs the token of the exchange.");
  // The copies share the loud check. A copy that pings it as its first check hides the stop of the other copies.
  if (pingKey !== LOUD_PING_URL_KEY) return check;
  const shared = `The file ${COPY_FILE}: pingKey is ${LOUD_PING_URL_KEY}, the key of the shared loud check. Each copy has its own first check.`;
  return { ...check, problems: (parsed, secret) => [...check.problems(parsed, secret), shared] };
}

/** The check of the live instance of the only copy: `daemonCheck(ONLY_COPY)`. */
export const DAEMON_CHECK: InstanceCheck = daemonCheck(ONLY_COPY);

/** The options of `openInstance`. */
export interface InstanceOptions {
  /** The private configuration and its recipients. The function `parseConfig` gives them with the channels `INSTANCE_CHANNELS`. */
  readonly config: ParsedConfig;
  /** The secret store of the instance. It gives the keys of the file `secrets.env`. */
  readonly secret: SecretLookup;
  readonly log: RuntimeLog;
  /** The monotonic clock of the service. The loop and the pace of the sources use it. */
  readonly clock: Clock;
  /**
   * The wall clock. It gives each instant. The instance makes a frame clock on it and `clock`, and each part of the
   * instance reads that frame clock. Thus the runtime follows each step of the wall clock.
   */
  readonly wall: WallClock;
  /** The transport of the requests of the sources. A test gives a transport with faults. */
  readonly transport: Transport;
  /**
   * The function that opens a session of the NWWS-OI source. The default is the XMPP session of the source. A test
   * gives a fake session. The instance has the source only when the secrets have the keys of the account of the copy.
   */
  readonly nwwsOpen?: OpenSession;
  /**
   * The intake of the messages of the operator (AL-92, `tell-intake.ts`). With it, the instance has the source `tell`.
   * Its fetch folds the messages of the intake into the lines of the reports of the merge state.
   */
  readonly tell?: TellIntake;
  /**
   * The intake of the fixes of the moving places (AL-40, `position-intake.ts`). With it, each pass has each moving place at
   * its last fresh fix, and the health route tells the age of each last fix. The fixes stay on this copy.
   */
  readonly position?: PositionIntake;
  /** The fetch of the Pushover channel. */
  readonly pushover: PushoverChannelOptions["fetch"];
  /**
   * The gate of the monthly messages of the Pushover application. The entry gives it a store in a file,
   * thus the count holds across a restart. With no gate, the channel counts nothing.
   */
  readonly pushoverQuota?: PushoverChannelOptions["quota"];
  /** The gate of the Pushover messages that tell of the entry into the reserve: one in each window. */
  readonly pushoverReserveNotices?: PushoverChannelOptions["reserveNotices"];
  /**
   * The fetch of the Twilio call channel and of the read of the balance of the account. The instance needs it when the
   * secrets have the keys of Twilio.
   */
  readonly twilio?: TwilioFetch;
  /** The fetch of the webhook channel (AL-55). The instance needs it when the secrets have the key `WEBHOOK_SECRET_KEY`. */
  readonly webhook?: WebhookFetch;
  /** The transport of the billing reads of GitHub (AL-111). The default is the transport of `@procedures/gh`. A test gives a fake. */
  readonly github?: RestTransport;
  /**
   * The transport of the reads of the management API of Healthchecks.io (AL-148). The default is `transport`. A test gives a
   * fake. The instance reads only when the secrets have `CHECKS_KEY` and `LOUD_PING_URL_KEY`.
   */
  readonly checks?: Transport;
  /**
   * The runner of the commands of the drift checks (AL-139). The default is `commandRunner` of `drift.ts`. A test gives a
   * fake. The instance starts the commands only when the settings of the copy have the field `drift`.
   */
  readonly driftRunner?: DriftRunner;
  /**
   * The runner of the billing reads of the hosts of the other copies (AL-70). The default is `commandRunner` of `drift.ts`.
   * A test gives a fake. The instance starts a read only for a peer with the field `billing`, when the copy is down.
   */
  readonly billingRunner?: DriftRunner;
  /**
   * The runner of the programs of the sounders of the copy (AL-41). The default is `commandRunner` of `drift.ts`. A test
   * gives a fake. The instance starts a program only when the copy has the field `sounder`.
   */
  readonly sounderRunner?: CommandRunner;
  /** The store of the file of the outage bundles. The entry gives the file of the slot. Without it, each deploy makes the bundles. */
  readonly outageBundles?: BundleStore;
  /**
   * The store of the counts of the caps of the spend. The entry gives the file `quotas.sqlite`, thus a count holds
   * across a restart. The instance needs it when a channel with a sender has a spend entry.
   */
  readonly spendStore?: QuotaStore;
  /** The id of this run. Each start of the process has a new id. */
  readonly run: string;
  /** The settings of this copy of the system. The default is `ONLY_COPY`, with rank 0. A copy waits its rank times `RANK_DELAY` before each send. */
  readonly copy?: CopySettings;
  /**
   * The exchange with the other copies: the call over HTTP (`exchangeCall`) and the hash of the configuration (`configHash`
   * of the core). Without it, the instance has no worker of the exchange. The entry refuses a copy with other copies and no token.
   */
  readonly exchange?: InstanceExchange;
  /** The instance gives each round of the worker of the exchange to this function. */
  readonly onExchange?: (round: ExchangeRound) => void;
  /** The runtime starts this hook at the end of each pass with no error. */
  readonly onPass?: (pass: Pass) => void | Promise<void>;
  /** The loop gives each failed pass to this function. */
  readonly onError?: (error: unknown, failures: number) => void;
  /**
   * This function gives the longest time of one fetch of a source. The default is `INSTANCE_FETCH_LIMIT`. A test with a
   * fake clock gives a long limit, because a slow runner moves the fake clock during a fetch.
   */
  readonly fetchLimit?: RuntimeOptions["fetchLimit"];
  /**
   * The cache of the store of shapes: the outlines of the NWS zones for the map. Without it, the instance gets no outline, and the
   * map has no region. The entry gives the file `shapes.sqlite` of the private folder. The instance closes it at `shapes.close()`.
   */
  readonly shapes?: ShapeCache;
  /** The instance gives each refresh of the outlines to this function. */
  readonly onShapes?: (outcome: ShapeOutcome) => void;
  /**
   * This function tells if the start is good: the service runs, and one pass ended. Until then, no refresh of the shapes starts,
   * and the keeper does not read the transit catalog. Thus this work does not run before the ready mark of the supervisor (AL-75).
   * A read of the catalog parses megabytes, and a new copy restarts the runtime. The default is a good start.
   */
  readonly startGood?: () => boolean;
  /**
   * The cache of the copy of the transit catalog (AL-60). The entry gives the file `TRANSIT_FILE` of the private folder. Without
   * it, the instance reads no transit feed and no catalog. The instance reads each feed of the copy whose box meets a place.
   */
  readonly transit?: TransitCache;
  /**
   * The most transit feeds of the instance. The default is `MAX_TRANSIT_FEEDS`. A measure of the capacity models gives a
   * higher limit. Thus it measures the cost of each polled source past the limit of a live copy (AL-126).
   */
  readonly transitLimit?: number;
  /** The instance gives each read of the transit catalog to this function. */
  readonly onTransit?: (outcome: TransitOutcome) => void;
  /**
   * The meter of the live metrics (AL-132): the counts of the new reports and the levels of the instance. The instruments
   * have the names of the series of `capacity-app.json`. Without a meter, the instance has no metrics. The lab gives a meter.
   */
  readonly meter?: Meter;
  /**
   * The instance starts this function one time, when a new copy of the transit catalog changes the feeds of the places. The
   * entry of the profile `daemon` stops the runtime, and the supervisor starts it again with the new feeds.
   */
  readonly onTransitFeeds?: () => void;
  /**
   * The store of the indicator readings. The entry gives the file `readings.sqlite` of the private folder, and the service
   * closes it. Without it, the instance keeps no reading.
   */
  readonly readings?: RuntimeOptions["readings"];
  /** The instance gives each fault of the store of the readings to this function. */
  readonly onReadingsFault?: RuntimeOptions["onReadingsFault"];
  /**
   * The store of the snapshot of the start (AL-105). The open of the runtime reads it. After the good start, a pass writes it
   * at most once in each `START_SNAPSHOT_EVERY` of the wall clock. The entry gives the folder `snapshots` next to the log, with one file for each key (AL-169).
   */
  readonly startSnapshot?: RuntimeOptions["startSnapshot"];
  /** The instance gives each fault of a write of the snapshot of the start to this function. The pass continues. */
  readonly onStartSnapshotFault?: (error: unknown) => void;
  /**
   * The least count of new events of the log since the last snapshot for a write of the snapshot (AL-115). Default:
   * `START_SNAPSHOT_FLOOR`. A measure or a test with a small log gives 1.
   */
  readonly startSnapshotFloor?: number;
  /**
   * The priors of the shadow score. With them, the map gives the score of each incident that reaches a person. The log
   * keeps the score at the start of each escalation. The score does not change a level.
   */
  readonly priors?: ScorePriors;
  /**
   * The instance starts this function one time, when new outlines change the codes of a place. The check is after a refresh
   * with requests, when no task is due. The entry of the profile `daemon` stops the runtime, and the supervisor starts it again.
   */
  readonly onPlaceCodes?: () => void;
  /** The worker of the deploy of the outage call gives each failed deploy to this function. */
  readonly onOutageError?: (error: unknown, failures: number) => void;
  /** The worker of the deploy of the outage call gives a line to this function for each deploy that changed the Functions. */
  readonly onOutageLog?: (line: string) => void;
  /** This function gives the blocks of the event loop of the runtime (AL-88). Each pass writes the new blocks into the log. */
  readonly loopBlocks?: () => readonly LoopBlock[];
}

/** The parts of the exchange that the entry gives to the instance. */
export interface InstanceExchange {
  /** The call of the procedure `alerts.log.entries` of another copy. */
  readonly call: ExchangeCall;
  /** The hash of the configuration of this copy. */
  readonly configHash: string;
}

/** The exchange of an instance with the other copies. */
export interface InstanceCopies {
  /** The parts of the runtime that serve the procedure `alerts.log.entries` to the other copies. */
  readonly source: EntriesSource;
  /** The worker that reads each other copy. A copy with no other copies has none. */
  readonly worker?: ExchangeWorker;
  /** The loop of the worker. The service operates it as the worker `EXCHANGE_WORKER` of `index.ts`. */
  readonly loop?: WorkerLoop;
}

/** The instance: the runtime, its loop and the outlines of the regions. */
export interface Instance {
  readonly runtime: Runtime;
  readonly loop: RuntimeLoop;
  /** The outlines of the regions. The match by shape and the map route read them here. */
  readonly shapes: InstanceShapes;
  /** The transit feeds and the keeper of the transit catalog, when the options give the cache. The service closes the keeper. */
  readonly transit?: InstanceTransit;
  /** The counts of the zone codes of the places at the start, from the outlines of the store. An instance with no store has none. */
  readonly zones?: ZoneCodeCounts;
  /** This function gives the state of each quota of the channels. Each call reads the stores of the gates. */
  readonly quotas: () => readonly ChannelQuota[];
  /** The watches of the balances of the paid provider accounts. */
  readonly balances: readonly BalanceWatch[];
  /** The watches of the use of the hard limits of the paid provider accounts (AL-111). */
  readonly uses: readonly LimitWatch[];
  /** The watch of the joint down time of the copies (AL-148), when the secrets have `CHECKS_KEY` and `LOUD_PING_URL_KEY`. */
  readonly joint?: JointWatch;
  /** The drift watch of the host of this copy (AL-139), when `copy.json` has the field `drift`. */
  readonly drift?: DriftWatch;
  /** The billing watch of the hosts of the other copies (AL-70), when a peer of `copy.json` has the field `billing`. */
  readonly billing?: BillingWatch;
  /** The watch of the STOP and START replies of the texts, when the instance has the text channel and an opt-in list. */
  readonly replies?: ReplyWatch;
  /** The watch of the spend that Twilio reports for the month of the cap, when the configuration has a spend entry for Twilio. */
  readonly spend?: SpendWatch;
  /**
   * This function gives the use reads of the cap of Twilio at the time of the call (AL-91). The reads are the cost of the
   * sends of this copy and the last spend of the account that Twilio gave. A configuration with no spend entry for Twilio has none.
   */
  readonly useReads?: () => readonly UseRead[];
  /**
   * This function gives the map payload of the last pass: the live incidents with the level of each person, the places and
   * the basemap. The first read after a change of the store simplifies the basemap of the watched states.
   */
  readonly map: () => MapPayload;
  /**
   * This function gives the health payload. The sources, the lateness and the coverage come from the last pass. The copies,
   * the quotas and the balances are at the time of the read.
   */
  readonly health: () => HealthPayload;
  /**
   * This function gives the history payload of the merge state: the changes of each incident at each time of entry on this
   * copy. The value `since` keeps only the incidents with a change at that time or later.
   */
  readonly history: (since: Instant | null) => HistoryPayload;
  /** This function gives the rows of the interest graph of each person, from the configuration at the start. */
  readonly interests: () => InterestsPayload;
  /** The worker of the deploy of the outage call, when the configuration has an outage call. The service declares it. */
  readonly outage?: OutageDeployWorker;
  /** The exchange with the other copies, when the options give it. */
  readonly copies?: InstanceCopies;
}

/**
 * This function tells if the instance reads the events of GDELT: when a place shares its position with the source. The
 * fetch keeps only the events near a place with a position, and no request holds a place. With no such place, each
 * fetch gives no event, thus the instance does not read the source. A change of the configuration applies at the next start.
 */
export function readsGdelt(config: AlertConfig): boolean {
  return sourcePlaces(config, GDELT_DESCRIPTOR.id).some((place) => place.at !== undefined);
}

/** The options of the build of the sources of an instance (AL-169). The key mode of the start builds the same sources. */
export type SourceBuildOptions = Pick<InstanceOptions, "config" | "secret" | "transport" | "transit" | "transitLimit" | "copy" | "nwwsOpen" | "tell">;

/** The sources of an instance, and the parts of their build that the instance uses again (AL-169). */
export interface InstanceSourceBuild {
  readonly transitCopy: CatalogCopy | undefined;
  readonly chosen: ChosenFeeds;
  readonly pace: Pace & { readonly scheduler: HostScheduler };
  readonly agent: string;
  readonly copy: CopySettings;
  readonly sources: readonly SourceProcedures[];
  readonly descriptors: readonly SourceDescriptor[];
}

/**
 * This function builds the sources of an instance, and the parts of the build that the instance uses again (AL-169). The
 * function `reports` gives the merge reports to the source of the messages of the operator. The build sends no request.
 */
export function instanceSources(options: SourceBuildOptions, clock: Clock, wall: WallClock, reports: () => readonly Report[]): InstanceSourceBuild {
  // A report of a status page has no area. Thus the instance reads only the pages that one of its persons can get.
  // The stack of the alert chain reads the pages and the feeds of its subjects too (AL-90).
  const chainConfig = options.config.config.chain;
  const watches = [...options.config.recipients.map((recipient) => recipient.watch), ...(chainConfig === undefined ? [] : [chainWatch(chainConfig)])];
  const pages = pagesFor(watches);
  // The feeds of the cloud providers have no area either. Their domains and their kinds choose them with the same rule.
  const feeds = PROVIDER_FEEDS.filter((feed) => watches.some((watch) => watchReads(watch, feed)));
  // BoM gives its data only with a key of an account. With no key, the instance does not read BoM.
  const bomKey = options.secret(BOM_SWS_KEY) ?? "";
  // EIA gives its data only with a key. With no key, the instance does not read EIA-930.
  const eiaKey = options.secret(EIA_KEY) ?? "";
  // Radar gives its data only with a token of an account. With no token, the instance does not read Radar.
  const radarToken = options.secret(CLOUDFLARE_RADAR_KEY) ?? "";
  // The transit feeds come from the copy of the catalog. Only this choice reads the positions of the places, and no request holds them.
  const transitCopy = options.transit?.read();
  const chosen = chooseFeeds(transitCopy, localPlaces(options.config.config), options.transitLimit);
  const factories = [
    createNwsSource,
    createIpawsSource,
    createUsgsSource,
    createEmscSource,
    ...TSUNAMI.map((center) => tsunamiFactory(center)),
    createSwpcSource,
    createGfzSource,
    (fetchOptions: GfzFetchOptions) => createIndexSource(HP30_INDEX, fetchOptions),
    ...(bomKey === "" ? [] : [bomFactory(bomKey)]),
    createEnergyChartsSource,
    createFaaSource,
    createNdwSource,
    createRailSource,
    ...(eiaKey === "" ? [] : [eiaFactory(eiaKey)]),
    createKevSource,
    ...CSAF_PROVIDERS.map((provider) => (fetchOptions: CsafFetchOptions) => createCsafSource(provider, fetchOptions)),
    ...CERT_PROVIDERS.map((provider) => (fetchOptions: CertFetchOptions) => createCertSource(provider, fetchOptions)),
    ...(readsGdelt(options.config.config) ? [createGdeltSource] : []),
    ...(radarToken === "" ? [] : radarFactories(radarToken)),
    ...feeds.map((feed) => feed.create),
    ...pages.map((page) => statusPageFactory(page)),
    ...chosen.feeds.map((feed) => transitFactory(feed)),
  ];
  // The host of the transit catalog has a place of its own in the pace. Thus a read of the catalog does not stop a source.
  const pace = sourcePace(clock, wall, factories.length + (options.transit === undefined ? 0 : 1));
  // One User-Agent for each request of the instance: the sources and the store of shapes.
  const agent = userAgent(options.config.config.contact);
  const polled = factories.map((make) => make({ pace, transport: options.transport, userAgent: agent }));
  // The stream of NWWS-OI sends no request over HTTP, thus it has no pace. Its first fetch opens its session.
  const copy = options.copy ?? ONLY_COPY;
  const account = nwwsSetup(options.secret, copy);
  const stream =
    account.tag === "ok" && account.value !== undefined
      ? createNwwsSource({ account: account.value, clock: wall, ...(options.nwwsOpen === undefined ? {} : { open: options.nwwsOpen }) })
      : undefined;
  // The source of the messages of the operator reads the merge state of the runtime at each fetch. The first fetch is after the start.
  const intake = options.tell === undefined ? undefined : tellSource(options.tell, reports, () => wall.now());
  // A copy does not read a source that it leaves to the other copies (AL-160). The exchange gives it their reports. The
  // pace keeps a place for each made source, thus a left source only gives one more free place.
  const leftSources = new Set<string>(copy.leaveSources ?? []);
  const sources: readonly SourceProcedures[] = [...polled, ...(stream === undefined ? [] : [stream]), ...(intake === undefined ? [] : [intake])].filter(
    (source) => !leftSources.has(source.describe().id),
  );

  const descriptors = sources.map((source) => source.describe());
  return { transitCopy, chosen, pace, agent, copy, sources, descriptors };
}

/**
 * This function gives the context key of the fold of an instance with these options (AL-169). It builds the sources and the
 * fold fields of the view as `openInstance` does, with no log and no store. A gate test pins it to the key of the runtime.
 */
export function instanceContextKey(options: SourceBuildOptions, clock: Clock, wall: WallClock): string {
  const { descriptors } = instanceSources(options, clock, wall, () => []);
  const { config } = options.config;
  // The runtime adds the descriptors and the retention to the view (`openRuntime`). The instance gives no retention.
  return contextKey({ sources: descriptors, retention: {}, expectations: instanceExpectations(config.expectations, descriptors), ...(config.link === undefined ? {} : { link: config.link }) });
}

/**
 * This function makes the instance. It throws when the configuration or the secret store has a
 * problem. A problem is a missing token, a key with a bad form, or a place that no regional source covers.
 * The message names ids, fields and the names of secrets, and no value.
 *
 * - The sources are the NWS API, IPAWS, the USGS, EMSC, the two tsunami warning centers, the SWPC, GFZ (Kp and Hp30),
 *   Energy-Charts and CISA KEV. The stream of NWWS-OI is a source when the secrets have the keys of the account of the
 *   copy (`nwwsSetup`). The events of GDELT are a source when a place shares its position with it (`readsGdelt`). BoM is a source when the secrets have its key (`BOM_SWS_KEY`), and so is EIA-930 (`EIA_KEY`). The outages and the traffic
 *   anomalies of Cloudflare Radar are sources when the secrets have its token (`CLOUDFLARE_RADAR_KEY`). Each status page that one of the
 *   persons can get is a source (`pagesFor`). The feed of Google Cloud, AWS or Azure is a source when one of the persons
 *   can get its reports (`watchReads`). The stack of the alert chain reads the pages and the feeds of its subjects too (`chainWatch`). Each transit feed of the copy of the catalog whose box meets a place is a source.
 * - Each source gets the codes of the places. It gets the position of a place only when the place shares it with that
 *   source. The USGS, EMSC, the centers, the SWPC, GFZ, BoM, Energy-Charts, EIA-930, CISA KEV, GDELT, Radar, Google Cloud, AWS, Azure
 *   and the status pages ask for no place. GDELT keeps only the events near the places on the machine of the instance. The transit feeds also ask for no place.
 * - The channels are Pushover, and the Twilio call channel when the secrets have its keys. Each time of the delivery comes
 *   from a fact of the channels.
 * - A spend entry of a channel gives its cap and the watch of the balance of its account.
 * - The times of the loop come from the limits of the runtime.
 * - The copy does not read a source of the field `leaveSources` of its settings (AL-160).
 */
export function openInstance(options: InstanceOptions): Instance {
  const { clock } = options;
  // A change of the wall clock of CLOCK_STEP_ABOVE or less is a drift. A larger change is a step of the clock.
  const wall = frameClock(options.wall, clock, { driftLimit: CLOCK_STEP_ABOVE });
  const { transitCopy, chosen, pace, agent, copy, sources, descriptors } = instanceSources(options, clock, wall, () => runtime.state().merge.reports);
  const kinds = [...new Set(descriptors.flatMap((descriptor) => descriptor.kinds))];

  const { config, recipients } = options.config;
  const problems = instanceProblems(options.config, options.secret, descriptors, wall.now(), copy);
  if (problems.length > 0) throw new Error(`The instance does not start. The configuration has these problems:\n- ${problems.join("\n- ")}`);
  const token = options.secret(PUSHOVER_TOKEN) ?? "";
  // The configuration does not change in a process. Thus the rows of the interests are the same at each read.
  const interests = interestsPayload(config, INSTANCE_CHANNELS, { secret: options.secret, services: shownServices(options.secret) });

  // The store of shapes shares the pace of the sources. Thus its requests to the NWS API keep the rests of that host.
  const store = options.shapes === undefined ? undefined : createShapeStore({ pace, transport: options.transport, userAgent: agent, cache: options.shapes });
  const cache = options.shapes;
  // The places get the codes of the zones near their positions, from the outlines of the store at the start. The fire zones
  // give the fire zone codes (AL-33). The store gives them only when it has each fire zone of the state.
  const zoned = (from: ShapeStore) => addZoneCodes(config, (state) => [...from.basemap(state), ...from.fireZones(state)]);
  const start = store === undefined ? undefined : zoned(store);
  const placed = start?.config ?? config;
  const places = localPlaces(placed);
  // The moving places (AL-40). Each pass has each moving place at its last fresh fix, with the zone codes near the fix.
  // The store of shapes and the keeper of the transit catalog get only the fixed places. Thus a fix changes no fetch.
  const position = options.position;
  // The codes of each fix, until the store gets new outlines. Thus a pass does not search the outlines again for the same fix.
  let fixCodes = new WeakMap<PositionFix, readonly RegionCode[]>();
  const codesAt = (place: PlaceConfig, at: Position): readonly RegionCode[] => {
    const fix = position?.fixes().get(place.id);
    if (fix === undefined || store === undefined) return place.codes;
    const known = fixCodes.get(fix);
    if (known !== undefined) return known;
    const codes = codesAtFix(place, at, fix.accuracyKm, (state) => [...store.basemap(state), ...store.fireZones(state)]);
    fixCodes.set(fix, codes);
    return codes;
  };
  const passAt = position === undefined ? undefined : (at: Instant): readonly WatchedPlace[] => passPlaces(placed, position.fixes(), at, codesAt);
  // A stale moving place is a report only on a copy that took a fix of the place. Thus a copy with no phone tells nothing.
  const staleAt =
    position === undefined
      ? undefined
      : (at: Instant): readonly StalePlace[] => {
          const fixes = position.fixes();
          return staleMovingPlaces(placed, fixes, at)
            .filter((id) => fixes.has(id))
            .map((id) => ({
              place: id,
              label: placed.places.find((place) => place.id === id)?.label ?? id,
              persons: recipients.filter(({ watch }) => watch.places.includes(id) || (watch.mandatory ?? []).some((rule) => rule.place === id)).map(({ watch }) => watch.person),
            }));
        };
  // New outlines can change the codes of a place. The check is after a refresh with requests, when no task is due.
  const opened = placeCodesKey(placed);
  let fresh = false;
  let told = false;
  const checkCodes = (outcome: ShapeOutcome): void => {
    if (store === undefined || told || !outcome.ok) return;
    if (outcome.refreshed.requests > 0) fresh = true;
    if (!fresh || outcome.refreshed.stop !== "done") return;
    fresh = false;
    if (placeCodesKey(zoned(store).config) === opened) return;
    told = true;
    options.onPlaceCodes?.();
  };
  const onShapes = (outcome: ShapeOutcome): void => {
    // New outlines can change the codes of a fix.
    if (outcome.ok && outcome.refreshed.requests > 0) fixCodes = new WeakMap();
    try {
      checkCodes(outcome);
    } finally {
      options.onShapes?.(outcome);
    }
  };
  const shapes = keepShapes({ store, places, onShapes, close: () => cache?.close() });
  const transitCache = options.transit;
  const transit: InstanceTransit | undefined =
    transitCache === undefined
      ? undefined
      : {
          ...keepTransit({
            cache: transitCache,
            copy: transitCopy,
            fetch: createCatalogFetch({ pace, transport: options.transport, userAgent: agent }),
            now: () => wall.now(),
            places,
            opened: feedsKey(chosen.feeds),
            limit: options.transitLimit,
            onFeeds: options.onTransitFeeds,
            onTransit: options.onTransit,
          }),
          chosen,
          copied: transitCopy !== undefined,
        };

  const pushover = createPushoverChannel({
    token,
    fetch: options.pushover,
    now: () => wall.now(),
    ...(options.pushoverQuota === undefined ? {} : { quota: options.pushoverQuota }),
    ...(options.pushoverReserveNotices === undefined ? {} : { reserveNotices: options.pushoverReserveNotices }),
  });
  const twilio = twilioChannel(options, config.spend, options.config.optIn);
  const webhook = webhookChannel(options, () => wall.now());
  const sounding = sounderOptions(copy, options.sounderRunner ?? commandRunner, () => wall.now());
  const sounder = sounding === undefined ? undefined : createSounderChannel(sounding);
  // The worker of the exchange reads the runtime only in its rounds, after the start of the service. Thus it gets the runtime through a function.
  const peers = copy.peers ?? [];
  const worker =
    peers.length === 0 || options.exchange === undefined
      ? undefined
      : exchangeWorker({
          runtime: { position: (id) => runtime.position(id), take: (page) => runtime.take(page) },
          peers,
          call: options.exchange.call,
          clock: wall,
          configHash: options.exchange.configHash,
        });
  const quotas = (): readonly ChannelQuota[] => [
    ...(options.pushoverQuota === undefined ? [] : [channelQuota(CHANNEL_ID, options.pushoverQuota)]),
    ...(twilio?.gates === undefined ? [] : [channelQuota(TWILIO_CHANNEL, twilio.gates.gate, SPEND_UNIT)]),
  ];
  const balances = twilio?.watch === undefined ? [] : [twilio.watch];
  const uses = limitWatches(config.limits ?? [], options.secret, options.github);
  const joint = jointOf(options, clock, wall);
  // The drift checks are a setting of the copy (copy.json), not of the configuration: a mirror takes the configuration of another host.
  const drift = copy.drift === undefined ? undefined : driftWatch({ commands: copy.drift.commands, ...(options.driftRunner === undefined ? {} : { run: options.driftRunner }) });
  // The billing watch reads the host of a down copy (AL-70). The loop exists before the first read, and only a pass starts a read.
  const billing =
    worker === undefined || !peers.some((peer) => peer.billing !== undefined)
      ? undefined
      : billingWatch({ peers, copies: worker, ...(options.billingRunner === undefined ? {} : { run: options.billingRunner }), onRead: () => loop.wake() });
  // The watches of the copies in the view have the billing reads. The worker keeps its own times and its ready state.
  const copyChecks: CopyChecks | undefined =
    worker === undefined || billing === undefined ? worker : { watches: () => billing.watches(), shift: (size) => worker.shift(size), ready: () => worker.ready() };
  const replies = twilio?.replies;
  const spent = twilio?.spend;
  const reads = [...(replies === undefined ? [] : [replies]), ...(spent === undefined ? [] : [spent])];
  // The text channel takes its units from the gates of the call channel. Thus the quota of the call channel counts the texts too.
  const channels = [
    pushover,
    ...(twilio === undefined ? [] : [twilio.channel, ...(twilio.text === undefined ? [] : [twilio.text])]),
    ...(webhook === undefined ? [] : [webhook]),
    ...(sounder === undefined ? [] : [sounder]),
  ];
  // The labels of the places go only into the why line of each message. The policy of the configuration replaces the default policy of the core.
  // A person with a score rule needs the priors in the policy (AL-31). With no score rule, the policy stays the same.
  const assess = policyWithPriors(
    config.assess,
    recipients.map((recipient) => recipient.watch),
    options.priors,
  );
  const delivery: DeliveryOptions = {
    recipients,
    channels,
    labels: placeLabels(placed),
    ...(assess === undefined ? {} : { assess }),
    // The sources of this copy: a report of only other sources came from another copy, maybe of a newer build (AL-76).
    sources: new Set(descriptors.map((descriptor) => descriptor.id)),
    ...(options.priors === undefined ? {} : { priors: options.priors }),
    ...DELIVERY_TIMES,
    rank: copy.rank,
    rankDelay: RANK_DELAY,
    ...(copy.leaveChannels === undefined ? {} : { leaveChannels: copy.leaveChannels }),
    ...(config.rankDelay === undefined ? {} : { rankDelays: config.rankDelay }),
    rankFloor: config.rankFloor ?? RANK_FLOOR,
    sendLimits: sendLimitsOf(config.sendLimit),
    throttle: throttleOf(config.throttle),
  };

  // The kept part of the last pass of the runtime, from the loop or from a direct call of `pass`. The map reads it. It has
  // no routes: they grow with the live incidents and the persons (AL-145).
  let latest: KeptPass | undefined;
  // The time of the first pass of this start. The answer of the exchange tells that the copy is steady after `LOUD_STEADY` of passes (AL-108).
  let first: Pick<Pass, "at"> | undefined;
  // The live metrics (AL-132). Each collection reads the levels: the feeds of the start, the persons and the open incidents of the routes of the last pass.
  const metrics =
    options.meter === undefined
      ? undefined
      : runtimeMetrics(options.meter, () => ({
          feeds: chosen.feeds.length,
          persons: options.config.recipients.length,
          incidents: latest?.open ?? 0,
        }));
  // The start of this instance. Each family of a store gets its first entry in its window after this time (AL-86).
  const startedAt = wall.now();
  // The wall time of the last write of the snapshot of the start. A start that read a snapshot counts from its start, thus it
  // writes no copy of the snapshot that it read at its first passes, when the other work of the start is due (AL-115). Before
  // the first write of a start with no snapshot, it is undefined.
  let snapshotAt: Instant | undefined;
  // A write of the snapshot is in progress (AL-115). A pass in the write starts no second write.
  let snapshotting = false;
  const snapshotFloor = options.startSnapshotFloor ?? START_SNAPSHOT_FLOOR;
  // The stack of the alert chain (AL-90). `instanceProblems` refuses a stack with a fault, thus a read that fails gives no chain.
  const chainRead = config.chain === undefined ? undefined : readChain(config.chain);
  const chain = chainRead?.ok === true ? chainRead.chain : undefined;
  const runtime: Runtime = openRuntime({
    log: options.log,
    clock: wall,
    sources,
    watch: (source) => ({ places: sourcePlaces(placed, source.id) }),
    view: {
      places,
      kinds,
      expectations: instanceExpectations(config.expectations, descriptors),
      delay: DELAY_LIMITS,
      ...(config.link === undefined ? {} : { link: config.link }),
      ...(config.channelDown === undefined ? {} : { channelDown: config.channelDown }),
      ...(config.sourceClear === undefined ? {} : { sourceClear: config.sourceClear }),
      ...(chain === undefined ? {} : { chain }),
    },
    ...(passAt === undefined ? {} : { places: passAt }),
    ...(staleAt === undefined ? {} : { stale: staleAt }),
    run: options.run,
    copy: copy.id,
    delivery,
    // The bound of the reports of the state (AL-145). Without the field, the runtime gives `REPORT_LIMIT`.
    ...(config.reportLimit === undefined ? {} : { reportLimit: config.reportLimit }),
    // The drills of the live paths that this copy starts (AL-43). Each person keeps the quiet window of the configuration.
    drills: copyDrills(config.drills ?? [], recipients, copy.id, copy.rank),
    // The drills of the other copies, in the watch of this copy. A copy that stops for a full window tells nothing.
    drillWatches: watchedDrills(config.drills ?? [], recipients, copy.id, copy.rank),
    // The loop exists before the first pass, and only a pass starts a wake.
    wake: () => loop.wake(),
    // Each stage of a quota is a line of system reports, and so is each stage of a balance.
    quotas,
    balances,
    // Each level of the use of a hard limit is a line of system reports (AL-111).
    ...(uses.length === 0 ? {} : { uses }),
    // Each stage of the joint down time of the copies is a line of system reports (AL-148).
    ...(joint === undefined ? {} : { joint }),
    // Each stage of a drift check of a copy host is a line of system reports (AL-139).
    ...(drift === undefined ? {} : { drift }),
    // Each family of a store with no entry at the end of its window after the start is a line of system reports (AL-86).
    stores: () => shapes.fill(startedAt, STORE_FILL_WINDOW, shapeSources(runtime.config.sources).map((source) => source.id)),
    // Each block of the event loop of 1 s or more is a line of system reports (AL-88).
    ...(options.loopBlocks === undefined ? {} : { blocks: options.loopBlocks }),
    // Each pass reads the replies of the texts and the spend of Twilio when each read is due.
    // The billing watch reads the billing of a down copy (AL-70).
    ...(reads.length === 0 && billing === undefined ? {} : { reads: [...reads, ...(billing === undefined ? [] : [billing])] }),
    // Each pass waits for the first round of the exchange, and its view has a line for each fault of another copy.
    ...(copyChecks === undefined ? {} : { copies: copyChecks }),
    // The readings of each fetch go to their store, not to the log.
    ...(options.readings === undefined ? {} : { readings: options.readings }),
    ...(options.onReadingsFault === undefined ? {} : { onReadingsFault: options.onReadingsFault }),
    // The new reports of each fetch go to the counters of the live metrics.
    ...(metrics === undefined ? {} : { onReports: (reports) => metrics.reports(reports) }),
    ...(options.startSnapshot === undefined ? {} : { startSnapshot: options.startSnapshot }),
    // After each pass, the store of shapes gets the outlines that are due, and it ends before the next fetch from its host (AL-33).
    // The keeper of the transit catalog reads the catalog when its copy is due. The pass does not wait for the two.
    // The two start at a pass after the good start (AL-75). The entry marks the start after this function, thus the pass that
    // makes the start good starts neither of them.
    onPass: async (pass) => {
      latest = keptPass(pass);
      first ??= { at: pass.at };
      if (options.startGood?.() ?? true) {
        shapes.afterPass(pass.view.incidents, refreshUntil(runtime.config.sources, (descriptor) => nextFetch(runtime.state(), descriptor)));
        transit?.afterPass();
        // The snapshot of the start (AL-105). The first write is at the first pass after the good start, when the log has
        // `snapshotFloor` new events since the last snapshot. The write has short transactions with pauses, thus the loop
        // answers its probes in the write (AL-115). The period counts from the start of the write. A failed write tries again
        // at the next pass.
        if (options.startSnapshot !== undefined && !snapshotting && (snapshotAt === undefined || wall.now() >= snapshotAt + START_SNAPSHOT_EVERY) && runtime.eventsAfterSnapshot() >= snapshotFloor) {
          const before = snapshotAt;
          snapshotAt = wall.now();
          snapshotting = true;
          try {
            await runtime.writeStartSnapshot();
          } catch (error) {
            snapshotAt = before;
            options.onStartSnapshotFault?.(error);
          } finally {
            snapshotting = false;
          }
        }
      }
      await options.onPass?.(pass);
    },
    fetchLimit: options.fetchLimit ?? INSTANCE_FETCH_LIMIT,
  });
  if (runtime.start.snapshot !== undefined) snapshotAt = startedAt;
  const loop = createLoop({
    pass: (stop) => runtime.pass(stop),
    clock,
    wall,
    times: loopTimes(runtime.config.sources, { delivery, fetchLimit: INSTANCE_FETCH_LIMIT }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  // The map assesses each live incident with the policy of the delivery. Thus the level on the map is the level of the person.
  const people = recipients.map((recipient) => recipient.watch);
  const map = (): MapPayload => {
    return mapPayload({
      at: latest?.at ?? null,
      incidents: latest?.view.incidents ?? [],
      coverage: latest?.view.coverage ?? [],
      people,
      places: placed.places,
      ...(delivery.assess === undefined ? {} : { policy: delivery.assess }),
      ...(options.priors === undefined ? {} : { priors: options.priors }),
      foreign: foreignIncidents(runtime.state().merge.reports, delivery.sources),
      // The basemap comes first: the display lookup gives its simplified shapes (AL-176).
      basemap: shapes.basemap(),
      shape: shapes.display,
      // The breadth of the indicator signals of the last pass. A runtime with no store of the readings has none.
      ...(latest?.breadth === undefined ? {} : { breadth: latest.breadth }),
      // The surprise of the signals of the last pass (AL-24). A fault of the history of the units gives none.
      ...(latest?.surprise === undefined ? {} : { surprise: latest.surprise }),
    });
  };
  // The health reads the view of the last pass. The watches of the copies, the balances and the channels are at the time of the read.
  const health = (): HealthPayload =>
    healthPayload({
      at: latest?.at ?? null,
      now: wall.now(),
      sources: latest?.view.health ?? [],
      lateness: latest?.view.lateness ?? [],
      coverage: latest?.view.coverage ?? [],
      copies: worker?.watches() ?? [],
      quotas: quotas(),
      balances: balances.flatMap((watch) => watch.balance() ?? []),
      reads: [
        ...[...reads, ...uses, ...(joint === undefined ? [] : [joint])].map((watch) => watch.health()),
        ...(drift?.health() ?? []),
        ...(billing?.health() ?? []),
        // The age of the last fix of each moving place, with no position (AL-40).
        ...(position === undefined ? [] : fixReads(placed, position.fixes(), position.refusals(), wall.now())),
      ],
      channels: runtime.channels(),
      channelDown: channelDownPolicy(runtime.config.channelDown),
    });
  // The history reads the merge state at the time of the read, with the link rule of the view and the delivery.
  const link = linkRule(runtime.config.link ?? DEFAULT_LINK_POLICY);
  const history = (since: Instant | null): HistoryPayload =>
    historyPayload({
      at: latest?.at ?? null,
      since,
      merge: runtime.state().merge,
      entered: runtime.entered(),
      people,
      places: placed.places,
      ...(delivery.assess === undefined ? {} : { policy: delivery.assess }),
      sources: delivery.sources,
      shape: shapes.display,
      link,
    });
  // A round that imports an event or changes the stage of a copy starts a pass soon.
  const rounds =
    worker === undefined
      ? undefined
      : exchangeLoop({
          worker,
          clock,
          onRound: (round) => {
            if (round.changed) loop.wake();
            options.onExchange?.(round);
          },
        });
  const copies: InstanceCopies | undefined =
    options.exchange === undefined
      ? undefined
      : { source: { runtime, clock: wall, configHash: options.exchange.configHash, drills: () => runtime.state().drills, steady: () => steadyPasses(first, latest) }, ...(worker === undefined || rounds === undefined ? {} : { worker, loop: rounds }) };
  const outage = outageWorker(options, loop.times.passLimit);
  return {
    runtime,
    loop,
    shapes,
    ...(transit === undefined ? {} : { transit }),
    ...(start === undefined ? {} : { zones: start.counts }),
    quotas,
    balances,
    uses,
    ...(joint === undefined ? {} : { joint }),
    ...(drift === undefined ? {} : { drift }),
    ...(billing === undefined ? {} : { billing }),
    ...(replies === undefined ? {} : { replies }),
    ...(spent === undefined ? {} : { spend: spent }),
    ...(twilio?.useReads === undefined ? {} : { useReads: useReadsAt(twilio.useReads, options.wall) }),
    map,
    health,
    history,
    interests: () => interests,
    ...(outage === undefined ? {} : { outage }),
    ...(copies === undefined ? {} : { copies }),
  };
}

// The watch of the joint down time of the copies (AL-148). It needs the key of the management API and the loud check.
// The host of the API has a scheduler of its own, on the clocks of the instance.
function jointOf(options: InstanceOptions, clock: Clock, wall: WallClock): JointWatch | undefined {
  const key = options.secret(CHECKS_KEY) ?? "";
  const url = options.secret(LOUD_PING_URL_KEY) ?? "";
  if (key === "" || url === "") return undefined;
  const read = jointReader({ key, url, pace: sourcePace(clock, wall, 1), transport: options.checks ?? options.transport, userAgent: USER_AGENT_NAME });
  return jointWatch({ read });
}

/** This function gives the use reads of the cap at the time of each call. */
function useReadsAt(reads: (at: number) => readonly UseRead[], wall: WallClock): () => readonly UseRead[] {
  return () => reads(wall.now());
}

/**
 * This function makes the worker of the deploy of the outage call when the configuration has an outage call. The function
 * `instanceProblems` checked the setup before. The bound of one deploy is the pass limit, because the drain holds it.
 */
function outageWorker(options: InstanceOptions, limit: Duration): OutageDeployWorker | undefined {
  const twilio = twilioSetup(options.secret);
  const setup = outageSetup(options.config, options.secret, twilio.tag === "ok" ? twilio.value : undefined);
  if (setup.tag === "err" || setup.value === undefined) return undefined;
  const fetch = options.twilio;
  if (fetch === undefined) throw new Error("The configuration has an outage call, and the instance has no fetch for the requests of Twilio.");
  const log = options.onOutageLog;
  return outageDeployWorker({
    deploy: outageDeploy(setup.value, {
      fetch,
      clock: options.clock,
      ...(log === undefined ? {} : { log }),
      ...(options.outageBundles === undefined ? {} : { bundles: options.outageBundles }),
    }),
    clock: options.clock,
    wall: options.wall,
    limit,
    ...(log === undefined ? {} : { log }),
    ...(options.onOutageError === undefined ? {} : { onError: options.onOutageError }),
  });
}

/** The Twilio channels of an instance: the call channel and the text channel. Also the gates of the spend, the watch of the balance, the watch of the spend and the watch of the replies. */
interface TwilioParts {
  readonly channel: ChannelProcedures;
  /** The text channel, when the secrets have the number of the texts. */
  readonly text?: ChannelProcedures;
  readonly gates?: SpendGates;
  readonly watch?: BalanceWatch;
  readonly replies?: ReplyWatch;
  readonly spend?: SpendWatch;
  /** This function gives the use reads of the cap at an instant (AL-91). */
  readonly useReads?: (at: number) => readonly UseRead[];
}

/**
 * This function makes the webhook channel when the secrets have its key (AL-55). A bad value stops the start in
 * `instanceProblems`, thus this function makes no channel for it.
 */
function webhookChannel(options: InstanceOptions, now: () => Instant): ChannelProcedures | undefined {
  const setup = webhookSetup(options.secret);
  if (setup.tag === "err" || setup.value === undefined) return undefined;
  if (options.webhook === undefined) throw new Error("The secret store has the key of the webhook channel, and the instance has no fetch for it.");
  return createWebhookChannel({ secrets: setup.value, fetch: options.webhook, userAgent: WEBHOOK_USER_AGENT, now });
}

/**
 * This function makes the Twilio channels when the secrets have their keys. The function `instanceProblems` checked the keys before.
 * A spend entry gives one cap of the two channels and the watch of the balance. Its floor is in the currency of the account.
 */
function twilioChannel(options: InstanceOptions, spend: readonly SpendConfig[] | undefined, records: readonly OptInRecord[]): TwilioParts | undefined {
  const setup = twilioSetup(options.secret);
  if (setup.tag === "err" || setup.value === undefined) return undefined;
  const { credentials, from, textFrom } = setup.value;
  const fetch = options.twilio;
  if (fetch === undefined) throw new Error("The secret store has the keys of Twilio, and the instance has no fetch for the call channel.");
  const now = (): number => options.wall.now();
  const entry = spendEntryOf(twilioCallDescriptor(), spend);
  // The text channel sends only to a number of the opt-in list. The watch of the replies gives the STOP and START replies,
  // and the STOP blocks of Twilio until its next read. With no opt-in list, the channel sends no text.
  const replies =
    textFrom === undefined || records.length === 0
      ? undefined
      : replyWatch({ records, read: (since, signal) => readTwilioReplies({ credentials, fetch, to: textFrom, since }, signal) });
  const optIn: TextOptIn = replies?.optIn ?? { has: (number, at) => optedIn(records, [], number, at), stopped: () => undefined };
  const watched = replies === undefined ? {} : { replies };
  // The text channel takes the gates of the call channel, with the units of one text.
  const text = (gates?: SpendGates): { readonly text?: ChannelProcedures } =>
    textFrom === undefined
      ? {}
      : { text: createTwilioTextChannel({ credentials, from: textFrom, fetch, now, optIn, ...(gates === undefined ? {} : { spend: { ...gates, units: spendUnits(TWILIO_TEXT_COST_USD) } }) }) };
  if (entry === undefined) return { channel: createTwilioCallChannel({ credentials, from, fetch, now }), ...text(), ...watched };
  const store = options.spendStore;
  if (store === undefined) throw new Error(`The configuration has a spend entry for ${entry.provider}, and the instance has no store for its count.`);
  // The key names the provider, not the account SID.
  const gates = spendGates(spendQuota({ name: "Twilio spend", ...entry }), { key: `${entry.provider}:spend`, store, now });
  const watch = balanceWatch({
    provider: entry.provider,
    title: "Twilio",
    channels: textFrom === undefined ? [TWILIO_CHANNEL] : [TWILIO_CHANNEL, TEXT_CHANNEL_ID],
    floors: balanceFloors(entry.floor),
    read: (signal) => readTwilioBalance({ credentials, fetch }, signal),
  });
  // The watch of the spend adds the other usage of the account to the count of the gates (AL-57).
  const spent = spendWatch({ provider: entry.provider, gates, timeZone: entry.timeZone, read: (start, signal) => readTwilioSpend({ credentials, fetch, from: start, to: now() }, signal) });
  const channel = createTwilioCallChannel({ credentials, from, fetch, now, spend: { ...gates, units: spendUnits(TWILIO_CALL_COST_USD) } });
  // The gate of the own count gives the count read of this copy, and the watch of the spend gives the read of the account (AL-91).
  const uses = { provider: entry.provider, copy: (options.copy ?? ONLY_COPY).id, timeZone: entry.timeZone, own: gates.own, spend: () => spent.spend() };
  return { channel, gates, watch, spend: spent, useReads: (at) => spendUseReads(uses, at), ...text(gates), ...watched };
}
