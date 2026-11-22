/**
 * This module holds the private configuration of the people and the places. It has the format of
 * the owner, and the load that checks it and makes the recipients. The repository holds no
 * configuration. The functions are pure, and the caller gives the secrets.
 */
import { localTime } from "@mark1russell7/algebra/clock";
import { err, ok, type Result } from "@mark1russell7/optional";
import { canonicalHash } from "@mark1russell7/rigor-generators";
import { compareCodeUnits } from "@mark1russell7/text/order";
import type { Address, AssessPolicy, ChannelDescriptor, ChannelId, ContactServices, Duration, EscalationPolicy, Instant, InterestGraph, NodeKey, PersonId, PersonWatch, PlaceId, Position, RegionCode, SourceId, WatchedPlace } from "./contracts.ts";
import { assess, CHANNEL_KIND, DEFAULT_ASSESS_POLICY, DRILL_KIND, matchSubjects, reachedAssessment } from "./assess.ts";
import type { ChannelDownConfig } from "./channel-down.ts";
import { policyFor, recipientProblems, ruleSteps, type ChannelRule, type Recipient } from "./delivery.ts";
import { DRILL_PROBES, drillProblems, nextDrillAt, type DrillConfig } from "./drill.ts";
import { composeInterests, deliveryLayer, placesLayer, servicesLayer, workLayer, type InterestRow } from "./interest-defaults.ts";
import { incidents, normalize } from "./merge.ts";
import { optInFields, resolveOptIn, type OptInConfig, type OptInRecord } from "./opt-in.ts";
import { CHANNEL_SUBJECT, DRILL_SUBJECT, NO_SYSTEM_LINES, OPERATOR_SYSTEMS, REPORT_SYSTEMS, systemReports, type SourceClearConfig } from "./system-reports.ts";
import type { TryChain } from "./chain.ts";
import type { Expectation } from "./lateness.ts";
import { rankDelayProblems, rankFloorProblems, type RankDelays } from "./escalation.ts";
import { sendLimitProblems, type SendLimitConfig } from "./send-limit.ts";
import { throttleProblems, type ThrottleConfig } from "./throttle.ts";
import type { LinkPolicy } from "./link.ts";
import { kindOfNode, placeNode, placeOfNode, type WhyLabels } from "./why.ts";

/** The name of the format of a configuration. A change that breaks a configuration gets a new name. */
export const CONFIG_FORMAT = "alerts-config/1";

/** A reference to a secret: the name of a key in the secret store of the instance. */
export interface SecretRef {
  /** The name of the key, for example `PUSHOVER_USER_KEY`. */
  readonly secret: string;
}

/** A value of an address: the value itself, or a reference to a secret. */
export type AddressValue = string | SecretRef;

/** A place of the configuration. The label and the position stay on the machine of the instance. */
export interface PlaceConfig {
  readonly id: PlaceId;
  /** The name of the place for its people, for example `Home`. No source gets it. */
  readonly label: string;
  /** The position of the place. Only the sources of `sharePosition` get it. */
  readonly at?: Position;
  /** The codes of the regions that contain the place. The core matches an incident to a place by these codes. */
  readonly codes: readonly RegionCode[];
  /** The distance around the place that the system also watches. */
  readonly bufferKm: number;
  /** The sources that get the position of the place. When it is absent, no source gets it. */
  readonly sharePosition?: readonly SourceId[];
}

/**
 * The inputs of the default layers of the interest graph of a person (`interest-defaults.ts`). The load joins the
 * layers with the graph of the person in `PersonWatch.interests`.
 */
export interface InterestDefaultsConfig {
  /** The kinds of work of the person. Each one is a key of `WORK_DEFAULTS`, for example `software`. */
  readonly works?: readonly string[];
  /** The services that the person uses. Each one is the node key of an entity, for example `domain:example.com`. */
  readonly services?: readonly NodeKey[];
  /**
   * The switch of the layer `delivery`: the services of the channels of the contacts of the person
   * (`ChannelDescriptor.services`). The layer is on when the field is absent. The value `false` turns it off.
   */
  readonly delivery?: boolean;
}

/** A person of the configuration. */
export interface PersonConfig {
  /** The places, the subjects, the rules and the quiet window of the person. */
  readonly watch: PersonWatch;
  /**
   * The inputs of the default layers of the interest graph. When it is present, the recipient gets the join of the
   * layer `places`, the other layers and the graph of the person. When it is absent, the watch stays as it is.
   */
  readonly defaults?: InterestDefaultsConfig;
  /** The name of the person for the UI. */
  readonly label?: string;
  /**
   * The escalation policies of the person. When it is absent, the policies of the configuration apply. A person with
   * policies of their own gets no policy of the configuration, also no policy with a subject.
   */
  readonly policies?: readonly EscalationPolicy[];
}

/** The address of one person on one channel. */
export interface ContactConfig {
  readonly person: PersonId;
  readonly channel: ChannelId;
  /** The fields of the address that the channel reads, for example `user` for Pushover. */
  readonly address: Readonly<Record<string, AddressValue>>;
}

/**
 * The money rules of one paid provider account: the cap of the spend of its channels, and the floor of its balance.
 * The values are private. Only the configuration holds them.
 */
export interface SpendConfig {
  /** The provider, as an id in the `dependsOn` of its channels: for example `provider:twilio`. */
  readonly provider: string;
  /** The most that the channels of the account spend in one calendar month, in US dollars. */
  readonly monthlyUsd: number;
  /**
   * The fixed costs of the account in each month, for example the rent of each phone number. The sends of a month get
   * the monthly cap less these costs (`sendCapUsd`). The default is no fixed cost. Then the whole cap is for the sends,
   * and the rent is outside the cap. Give fixed costs only for a cap of the whole bill.
   */
  readonly fixed?: readonly FixedCost[];
  /** The last part of the cap of the sends that only `life-safety` messages use, in US dollars. The default is 0. */
  readonly reserveUsd?: number;
  /**
   * The floor of the balance of the account, in the currency of the account: one floor or a list of floors. Below each
   * floor, the system reports one line `low`. Thus the list `[10, 3]` gives one alert at 10 and one more alert at 3.
   */
  readonly floor: number | readonly number[];
  /** The time zone of the start of the month, as an IANA name: for example `America/New_York`. */
  readonly timeZone: string;
}

/** One fixed cost of a provider account in each month, for example the rent of one phone number. */
export interface FixedCost {
  /** The name of the cost, for example `toll-free number`. */
  readonly what: string;
  /** The cost in each month, in US dollars. */
  readonly usd: number;
}

/** The kinds of an account of a provider in a watch of a limit: the account of a user, or an organization. */
export const LIMIT_ACCOUNT_KINDS: readonly ["user", "organization"] = ["user", "organization"];

/** The kind of an account of a provider in a watch of a limit. */
export type LimitAccountKind = (typeof LIMIT_ACCOUNT_KINDS)[number];

/**
 * The watch of the use of one hard limit of a paid provider account (AL-111). The values are private. Only the
 * configuration holds them.
 */
export interface LimitConfig {
  /** The id of the limit. It is unique in the list: for example `github:<login>/actions`. */
  readonly id: string;
  /** The provider: for example `provider:github`. The runtime has a reader for each provider that it knows. */
  readonly provider: string;
  /** The name of the limit in a text: for example `GitHub Actions`. */
  readonly title: string;
  /** The kind of the account at the provider. */
  readonly accountKind: LimitAccountKind;
  /** The login of the account at the provider. */
  readonly account: string;
  /** The products of the use of the account that the limit counts, as the provider names them: for example `actions`. */
  readonly products: readonly string[];
  /**
   * The hard limit of a month, in US dollars. Without it, the budget of the organization that stops the paid use gives
   * the limit. An account of a user has no budget that the runtime can read, thus it needs this field.
   */
  readonly monthlyUsd?: number;
  /** The product of the budget of the organization that gives the limit. The default is the first product. */
  readonly budget?: string;
  /** The levels of the used share, each one above 0. The default is the levels of the runtime: 50, 80 and 100 %. */
  readonly levels?: readonly number[];
  /**
   * The key of the secret store that holds the token of the reads, in capital letters, digits and underscores. A token
   * of a provider can have one owner only, thus each account can need its own key. The reader of the provider gives the
   * default key.
   */
  readonly tokenKey?: string;
}

/**
 * This function gives the part of the monthly cap of a spend entry that the sends get, in US dollars. That part is the
 * cap less the fixed costs. The value is 0 or less when the fixed costs use all of the cap.
 */
export function sendCapUsd(spend: Pick<SpendConfig, "monthlyUsd" | "fixed">): number {
  return spend.monthlyUsd - (spend.fixed ?? []).reduce((sum, cost) => sum + cost.usd, 0);
}

/**
 * This function gives the floors of the balance of a spend entry, from the highest to the lowest, each one time. One
 * floor gives a list of one floor.
 */
export function balanceFloors(floor: SpendConfig["floor"]): number[] {
  return [...new Set(typeof floor === "number" ? [floor] : floor)].sort((a, b) => b - a);
}

/** One person of the outage call, with the chain of the tries of the person. */
export interface OutagePersonConfig {
  readonly person: PersonId;
  /** The channel of each try, in order. The address of a try is the contact of the person on its channel. */
  readonly chain: TryChain;
}

/**
 * The outage call: the calls to people when the outside check finds the instance down. The provider of
 * the calls makes them, so they work while the instance is down. A deploy copies the list to the provider.
 */
export interface OutageConfig {
  /** The people of the outage call, in the order of the first calls. */
  readonly people: readonly OutagePersonConfig[];
}

/**
 * The two forms of the links of a local site (AL-92). A link on the loopback address does not open on a phone. Thus the
 * intake changes the origin `local` of a link to the origin `phone`, and it keeps the path, the query and the fragment.
 */
export interface TellSite {
  /** The origin of the site on the loopback address: `http` or `https`, the host `127.0.0.1`, `localhost` or `[::1]`, and a port. */
  readonly local: string;
  /** The origin of the same site that a phone opens: `https` and a host of two labels or more, with no path. */
  readonly phone: string;
}

/**
 * The intake of the messages of the operator (AL-92). The runtime takes each message on a port of the loopback address,
 * with the token of the file `tell.token` in its home. Without this entry, the runtime has no intake.
 */
export interface TellConfig {
  /** The port of the intake on the loopback address. */
  readonly port: number;
  /** The most messages that the intake takes in one day. Without it, the cap is `DEFAULT_TELL_DAILY_CAP`. */
  readonly dailyCap?: number;
  /**
   * The local site of the links. The intake changes a link of this site, or a path that starts with `/`, to its phone form.
   * It refuses each other link on the loopback address. Without this entry, it refuses each such link and each path.
   */
  readonly site?: TellSite;
}

/** The daily cap of the intake of the messages of the operator when the configuration gives none. */
export const DEFAULT_TELL_DAILY_CAP = 20;

/** The private configuration of the people and the places. Each copy of the system loads the same configuration. */
export interface AlertConfig {
  readonly format: typeof CONFIG_FORMAT;
  readonly places: readonly PlaceConfig[];
  readonly people: readonly PersonConfig[];
  readonly contacts: readonly ContactConfig[];
  /** The escalation policies of each person with no policies of their own. */
  readonly policies: readonly EscalationPolicy[];
  /**
   * The contact of the operator of the instance: an `https` URL or a `mailto` URL. Each request to the
   * server of another party gives it in the User-Agent. Without it, the User-Agent has no contact.
   */
  readonly contact?: string;
  /** The settings of the expectations of the instance. Each entry names an expectation by its id. */
  readonly expectations?: readonly ExpectationConfig[];
  /** The money rules of each paid provider account. A provider with no entry has no cap and no watch of its balance. */
  readonly spend?: readonly SpendConfig[];
  /** The watches of the use of the hard limits of the paid provider accounts (AL-111). */
  readonly limits?: readonly LimitConfig[];
  /** The policy of the link rule of the merge. Without it, the instance uses `DEFAULT_LINK_POLICY`. */
  readonly link?: LinkPolicy;
  /** The outage call. Without it, an outage of the instance calls no person. */
  readonly outage?: OutageConfig;
  /**
   * The wait of one rank of a copy, for each level. A level with no entry takes the default of the runtime. Each copy
   * loads the same table. With 0 for `life-safety`, each copy sends each life-safety step at once.
   * Two copies with different tables are safe. The copy of rank 0 sends at once in each case. A copy with no
   * entry for a level waits the default.
   */
  readonly rankDelay?: RankDelays;
  /**
   * The least wait of one rank before a step of an exclusive channel, as a call. Without it, the runtime gives its
   * default. A phone takes one call at a time. Thus a copy with rank 1 waits for the call of rank 0 in its ledger.
   */
  readonly rankFloor?: Duration;
  /**
   * The policy of the assessment: the statuses, the tables of the levels and the relevance policy. When it is absent,
   * the default policy of the core applies. A policy here replaces the full default policy.
   */
  readonly assess?: AssessPolicy;
  /** The drills of the live paths. Without them, the instance starts no drill. */
  readonly drills?: readonly DrillConfig[];
  /**
   * The private opt-in list of the texts. A channel with an address field of `optIn` sends only to a phone on this
   * list, and a STOP reply removes the number. The list holds phone numbers: keep it out of each public text.
   */
  readonly optIn?: readonly OptInConfig[];
  /**
   * The policy of a down channel (AL-65): the run of failed calls that opens its line. Without it, 3 failed calls in at
   * least 60 s open a line (`DEFAULT_CHANNEL_DOWN`).
   */
  readonly channelDown?: ChannelDownConfig;
  /**
   * The policy of the end of the line of a down source (AL-75): the time that a source stays up before its line ends.
   * Without it, the time is 15 minutes or 3 intervals of the source, the longer (`DEFAULT_SOURCE_CLEAR`).
   */
  readonly sourceClear?: SourceClearConfig;
  /**
   * The send limit of each person (AL-72): the most new escalations of each level below `life-safety` in one window,
   * over all the copies. Each field that is absent keeps its default (`DEFAULT_SEND_LIMITS`).
   */
  readonly sendLimit?: SendLimitConfig;
  /**
   * The rise-only throttle of each person, channel and stream (AL-72 part 4). In one window, a channel sends again to a
   * person only for a higher level of the stream. Each field that is absent keeps its default (`DEFAULT_THROTTLE`).
   */
  readonly throttle?: ThrottleConfig;
  /** The intake of the messages of the operator (AL-92). Without it, the runtime takes no message of the operator. */
  readonly tell?: TellConfig;
}

/** The name of the format of a part of the configuration. A change that breaks a part gets a new name. */
export const CONFIG_PART_FORMAT = "alerts-config-part/1";

/**
 * A part of the configuration from one writer: places, people and contacts. Each writer keeps its own file, so
 * two writers do not overwrite each other. The root configuration keeps the other fields: policies, drills and spend.
 */
export interface ConfigPart {
  readonly format: typeof CONFIG_PART_FORMAT;
  readonly places?: readonly PlaceConfig[];
  readonly people?: readonly PersonConfig[];
  readonly contacts?: readonly ContactConfig[];
}

/** A part with its name. The name of a part in a file is the name of the file with no `.json`. */
export interface NamedPart {
  readonly name: string;
  readonly part: ConfigPart;
}

/** The name of a part has small letters, digits and hyphens. It starts with a letter and has 40 characters or fewer. */
export const PART_NAME: RegExp = /^[a-z][a-z0-9-]{0,39}$/u;

/** This function gives the name of a part at the start of a problem. A bad name can hold any text, thus the label gives the index of the part. */
export function partLabel(name: string, index: number): string {
  return PART_NAME.test(name) ? `The part ${name}` : `Part ${String(index)}`;
}

/**
 * This function merges the parts into the root configuration. The entries of the root come first. The entries of
 * the parts come after them, in the order of the names. Thus the order of the reads does not change the merge or its hash.
 *
 * The merge finds a bad name and two parts with one name. It also finds an entry in two files: a place, a person, or
 * a contact of one person on one channel. Two entries with one id in one file are a problem of `loadConfig`. A problem
 * names ids and parts, and holds no other value.
 */
export function mergeParts(root: AlertConfig, parts: readonly NamedPart[]): Result<AlertConfig, readonly string[]> {
  const problems: string[] = [];
  const names = new Set<string>();
  const good: NamedPart[] = [];
  parts.forEach((named, index) => {
    if (!PART_NAME.test(named.name)) problems.push(`The name of part ${index} is not small letters, digits and hyphens with a letter first, up to 40 characters.`);
    else if (names.has(named.name)) problems.push(`Two parts have the name ${named.name}.`);
    else good.push(named);
    names.add(named.name);
  });
  good.sort((a, b) => compareCodeUnits(a.name, b.name));

  // The file of each key, the first time the merge sees it. A key twice in one file is a problem of the load.
  const fileOf = new Map<string, string>();
  const claim = (key: string, file: string, what: string): void => {
    const first = fileOf.get(key);
    if (first === undefined) fileOf.set(key, file);
    else if (first !== file) problems.push(`${what} is in ${first} and in ${file}.`);
  };
  const files: readonly { readonly file: string; readonly part: Omit<ConfigPart, "format"> }[] = [
    { file: "the root configuration", part: root },
    ...good.map(({ name, part }) => ({ file: `the part ${name}`, part })),
  ];
  for (const { file, part } of files) {
    for (const place of part.places ?? []) claim(`place\u0000${place.id}`, file, `The place ${place.id}`);
    for (const { watch } of part.people ?? []) claim(`person\u0000${watch.person}`, file, `The person ${watch.person}`);
    for (const { person, channel } of part.contacts ?? []) claim(`contact\u0000${person}\u0000${channel}`, file, `The contact of the person ${person} on the channel ${channel}`);
  }
  if (problems.length > 0) return err(problems);
  return ok({
    ...root,
    places: files.flatMap(({ part }) => part.places ?? []),
    people: files.flatMap(({ part }) => part.people ?? []),
    contacts: files.flatMap(({ part }) => part.contacts ?? []),
  });
}

/** The name of the format of the settings of one copy of the system. A change that breaks a file gets a new name. */
export const COPY_FORMAT = "alerts-copy/1";

/** The address and the port of the exchange of a copy. */
export interface CopyListen {
  /** The address of the computer on the tailnet. An address of all interfaces is a problem. */
  readonly host: string;
  readonly port: number;
}

/** Another copy of the system, as one copy sees it. */
export interface CopyPeer {
  /** The id of the other copy. */
  readonly id: string;
  /** The URL of the exchange of the other copy, with `http` or `https`. */
  readonly url: string;
}

/**
 * The settings of one copy of the system: the file `copy.json`. Each copy has its own file. The configuration and the
 * secrets are the same in each copy. A runtime with no file is the only copy, `ONLY_COPY`.
 */
export interface CopySettings {
  readonly format: typeof COPY_FORMAT;
  /** The name of the copy, for example `home` or `cloud`. Two copies do not have the same id. */
  readonly id: string;
  /** The order of the copy, from 0. A copy waits its rank times the rank delay before each send. */
  readonly rank: number;
  /** The address of the exchange of this copy. A copy with other copies needs it. */
  readonly listen?: CopyListen;
  /** The other copies. */
  readonly peers?: readonly CopyPeer[];
  /** The key of the secrets with the ping URL of the first check of this copy. The runtime gives a default key. */
  readonly pingKey?: string;
  /**
   * The number of the account of each source with an account, by the id of the source. The keys of account 2 end in
   * `_2`. The default is account 1. Two copies do not share an account, because an account has one session.
   */
  readonly accounts?: Readonly<Record<string, number>>;
  /**
   * The id of the copy that gives the configuration of this copy: `config.json` and the parts. Without it, this copy
   * keeps its own files. The id is the id of a copy of `peers`. Each copy keeps its own `secrets.env` and `copy.json`.
   */
  readonly configFrom?: string;
}

/** The settings of a runtime with no file `copy.json`: the only copy, with rank 0 and no exchange. */
export const ONLY_COPY: CopySettings = { format: COPY_FORMAT, id: "only", rank: 0 };

// The addresses of all the interfaces. The exchange does not listen on them: only the tailnet reaches it.
const ALL_INTERFACES: ReadonlySet<string> = new Set(["0.0.0.0", "::", "[::]", "*"]);

/**
 * This function gives the problems of the settings of a copy that a schema cannot find. Each problem names a field,
 * and it holds no address and no URL.
 *
 * - A rank is lower than the count of the copies, because the ranks of the copies are 0, 1, 2 and up.
 * - The other copies have different ids and URLs, and no other copy has the id of this copy.
 * - A copy with other copies has the address `listen`, and the address is not an address of all interfaces.
 * - The field `configFrom` names a copy of `peers`.
 */
/**
 * This function gives the problems of the watches of the system subjects (AL-121). Each system of `OPERATOR_SYSTEMS`
 * needs a person who watches it, because a report reaches a person only by a watch of its system. A watch with an id
 * counts too. A watch of a system `alerts.*` that no report has matches nothing, as a wrong name.
 *
 * The start of the runtime does not refuse these problems, because a start with no reader of one report is better than
 * no start. The check of a file (`check.ts`) refuses them. Thus a writer does not write a file with such a watch.
 */
export function watchProblems(watches: readonly PersonWatch[]): string[] {
  const watched = new Set(watches.flatMap((watch) => (watch.subjects ?? []).map((subject) => subject.system)));
  const problems = OPERATOR_SYSTEMS.filter((system) => !watched.has(system)).map(
    (system) => `No person watches the system ${system}, thus its reports reach no person. Add { "system": "${system}" } to the subjects of the person who operates the system.`,
  );
  const known = new Set(REPORT_SYSTEMS);
  const unknown = new Set<string>();
  for (const watch of watches) {
    for (const { system } of watch.subjects ?? []) {
      if (system.startsWith("alerts.") && !known.has(system)) unknown.add(`The person ${watch.person} watches the system ${system}, and no report has it. The watch matches nothing.`);
    }
  }
  return [...problems, ...unknown];
}

export function copyProblems(settings: CopySettings): string[] {
  const problems: string[] = [];
  const peers = settings.peers ?? [];
  if (settings.rank > peers.length) problems.push(`The rank is ${String(settings.rank)}, but the copies are ${String(peers.length + 1)}. A rank is lower than the count of the copies.`);
  const ids = new Set<string>([settings.id]);
  const urls = new Set<string>();
  peers.forEach((peer, at) => {
    if (ids.has(peer.id)) problems.push(`peers[${String(at)}]: the id ${peer.id} is the id of this copy or of an earlier copy.`);
    if (urls.has(peer.url)) problems.push(`peers[${String(at)}]: the URL is the URL of an earlier copy.`);
    ids.add(peer.id);
    urls.add(peer.url);
  });
  if (settings.configFrom !== undefined && !peers.some((peer) => peer.id === settings.configFrom)) problems.push("configFrom: the id is not the id of a copy in peers.");
  if (peers.length > 0 && settings.listen === undefined) problems.push("A copy with other copies needs the address listen of its exchange.");
  if (settings.listen !== undefined && ALL_INTERFACES.has(settings.listen.host)) problems.push("listen.host: the exchange does not listen on all the interfaces. Give the tailnet address of the computer.");
  return problems;
}

/** The settings of one expectation of the instance, for example the WEA check of a copy source. */
export interface ExpectationConfig {
  /** The id of the expectation. */
  readonly id: string;
  /** The start of a new record of the checks of the expectation. The value goes into `Expectation.since`. */
  readonly since: Instant;
}

/**
 * This function gives the expectations with the settings of the configuration. The `since` of each
 * entry goes into the expectation with its id. An expectation with no entry stays the same.
 */
export function configuredExpectations(expectations: readonly Expectation[], settings: readonly ExpectationConfig[] = []): Expectation[] {
  const byId = new Map(settings.map((entry) => [entry.id, entry]));
  return expectations.map((expectation) => {
    const entry = byId.get(expectation.id);
    return entry === undefined ? expectation : { ...expectation, since: entry.since };
  });
}

/**
 * This function checks the settings of expectations against the expectations of an instance. It finds
 * an entry with an unknown id, and a `since` after the time `at`. A `since` in the future stops the
 * record until that time, so the source cannot be late.
 */
export function expectationProblems(settings: readonly ExpectationConfig[] | undefined, expectations: readonly Expectation[], at: Instant): string[] {
  const known = new Set(expectations.map((expectation) => expectation.id));
  return (settings ?? []).flatMap((entry) => [
    ...(known.has(entry.id) ? [] : [`The configuration sets the expectation ${entry.id}, and the instance has no such expectation.`]),
    ...(entry.since > at ? [`The since of the expectation ${entry.id} is in the future. The check of the source then has no record until that time.`] : []),
  ]);
}

/** The secret store of the instance. It gives the value of a key, or `undefined` when it has no such key. */
export type SecretLookup = (name: string) => string | undefined;

/** The result of a load. */
export interface LoadedConfig {
  /** The recipient of each person, in the order of the configuration. */
  readonly recipients: readonly Recipient[];
  /**
   * The problems of the configuration. Each problem names ids, fields and the names of secrets, but
   * no value of a secret, no label and no position. The runtime does not start with a problem.
   */
  readonly problems: readonly string[];
  /** The opt-in list of the texts, with the value of each number. */
  readonly optIn: readonly OptInRecord[];
}

/**
 * This function checks a configuration and makes the recipient of each person. It finds:
 *
 * - two places or two people with one id, and a place with no region code
 * - a place of a person or of a rule that the configuration or the person does not have
 * - a contact of an unknown person, two contacts of a person on one channel, and a secret that the store does not have
 * - two settings of one expectation
 * - two spend entries of one provider, and a provider that no channel depends on
 * - a reserve of a spend entry that is not below its cap, and a time zone that is not an IANA name
 * - two watches of a limit with one id, and a watch of the account of a user with no monthly limit
 * - an unknown person of the outage call, a person two times in it, and a chain with no step
 * - a step of the outage call on a channel with no contact of the person
 * - a rank delay that is not a whole number of milliseconds up to `RANK_DELAY_LIMIT`
 * - a window of the send limit that is not one minute to one day, and a count of the send limit below 1
 * - two drills with one id, a drill of an unknown person, and a drill on a channel with no contact of the person
 * - a drill of a person who does not watch `DRILL_SUBJECT`
 * - a run or a failure of a drill that sends nothing to its person: no policy of its level, or no step after the rules
 * - each problem of `drillProblems` for each drill
 * - each problem of `recipientProblems` for each person.
 *
 * With `services`, the layer `delivery` of each person also takes the services of each contact of the person
 * (`contactChannels`). No problem holds them.
 */
export function loadConfig(config: AlertConfig, channels: readonly ChannelDescriptor[], secret: SecretLookup, services?: ContactServices): LoadedConfig {
  const problems: string[] = [];
  const places = new Set<string>();
  for (const place of config.places) {
    if (places.has(place.id)) problems.push(`Two places have the id ${place.id}.`);
    places.add(place.id);
    // The core matches by the region codes only, until the home of geography has the tests of shapes.
    if (place.codes.length === 0) problems.push(`The place ${place.id} has no region code, so no incident matches it.`);
  }

  const people = new Set<string>();
  // The watch of each recipient, in the order of the people: the join of the default layers, or the watch as it is.
  const watches: PersonWatch[] = [];
  for (const entry of config.people) {
    const { watch } = entry;
    const person = watch.person;
    if (people.has(person)) problems.push(`Two people have the id ${person}.`);
    people.add(person);
    const own = new Set<string>(watch.places);
    for (const place of watch.places) if (!places.has(place)) problems.push(`The person ${person} watches the place ${place}, and the configuration has no such place.`);
    watch.rules.forEach((rule, index) => {
      for (const place of rule.places ?? []) {
        if (!own.has(place)) problems.push(`Rule ${index} of the person ${person} names the place ${place}, and the person does not watch it. The rule matches no incident there.`);
      }
    });
    const joined = personInterests(entry, contactChannels(config, person, channels, services === undefined ? undefined : { secret, services }));
    if (joined.problem !== undefined) problems.push(`The defaults of the person ${person}: ${joined.problem}`);
    watches.push(joined.watch);
    problems.push(...relevanceProblems(joined.watch, own));
  }

  const expectations = new Set<string>();
  for (const { id } of config.expectations ?? []) {
    if (expectations.has(id)) problems.push(`Two settings of expectations have the id ${id}.`);
    expectations.add(id);
  }

  // Maps, not objects: an id or a field such as `constructor` is then a plain key.
  const addresses = new Map<string, Map<string, Address>>();
  for (const contact of config.contacts) {
    const { person, channel } = contact;
    if (!people.has(person)) {
      problems.push(`A contact on the channel ${channel} is for the person ${person}, and the configuration has no such person.`);
      continue;
    }
    const ofPerson = addresses.get(person) ?? new Map<string, Address>();
    addresses.set(person, ofPerson);
    if (ofPerson.has(channel)) {
      problems.push(`The person ${person} has two contacts on the channel ${channel}.`);
      continue;
    }
    const { address, missing } = resolveAddress(contact, secret);
    for (const { field, name } of missing) problems.push(`The field ${field} of the contact of ${person} on ${channel} names the secret ${name}, and the secret store has no value for it.`);
    ofPerson.set(channel, address);
  }

  // Each value of an opt-in field needs a record. A channel of texts then sends only to a person who agreed.
  const { records: optIn, problems: optInFound } = resolveOptIn(config.optIn ?? [], secret);
  problems.push(...optInFound);
  const listed = new Set(optIn.map((record) => record.number));
  for (const channel of channels) {
    for (const field of optInFields(channel)) {
      for (const [person, ofPerson] of addresses) {
        const value = ofPerson.get(channel.id)?.[field.name];
        if (value !== undefined && !listed.has(value)) problems.push(`The field ${field.name} of the contact of ${person} on ${channel.id} is not on the opt-in list. The channel sends nothing to it.`);
      }
    }
  }

  const providers = new Set<string>();
  for (const spend of config.spend ?? []) {
    const { provider } = spend;
    if (providers.has(provider)) problems.push(`Two spend entries are for the provider ${provider}.`);
    providers.add(provider);
    // A typo of a provider gives a cap that no send takes from.
    if (!channels.some((channel) => channel.dependsOn.includes(provider))) problems.push(`The spend entry of ${provider} names a provider that no channel depends on.`);
    // The fixed costs come first. Thus the reserve is a part of the cap of the sends, and the sends get more than 0.
    const sends = sendCapUsd(spend);
    if (!(sends > 0)) problems.push(`The fixed costs of the spend of ${provider} use all of its monthly cap. No send can go.`);
    else if (!((spend.reserveUsd ?? 0) < sends)) problems.push(`The reserve of the spend of ${provider} is not below its monthly cap less its fixed costs.`);
    if (localTime(0, spend.timeZone) === undefined) problems.push(`The time zone of the spend of ${provider} is not an IANA name.`);
  }

  const limitIds = new Set<string>();
  for (const limit of config.limits ?? []) {
    if (limitIds.has(limit.id)) problems.push(`Two watches of a limit have the id ${limit.id}.`);
    limitIds.add(limit.id);
    // The runtime cannot read a budget of the account of a user. Thus the watch has no limit, and it gives no level.
    if (limit.accountKind === "user" && limit.monthlyUsd === undefined) problems.push(`The watch of the limit ${limit.id} is for the account of a user, and it has no monthly limit.`);
  }

  problems.push(...rankDelayProblems(config.rankDelay ?? {}));
  problems.push(...rankFloorProblems(config.rankFloor));
  problems.push(...sendLimitProblems(config.sendLimit ?? {}));
  problems.push(...throttleProblems(config.throttle ?? {}));

  const called = new Set<string>();
  for (const { person, chain } of config.outage?.people ?? []) {
    if (called.has(person)) problems.push(`The outage call has the person ${person} two times.`);
    called.add(person);
    if (!people.has(person)) {
      problems.push(`The outage call names the person ${person}, and the configuration has no such person.`);
      continue;
    }
    if (chain.steps.length === 0) problems.push(`The outage chain of the person ${person} has no step, so no outage call reaches the person.`);
    for (const channel of new Set(chain.steps)) {
      if (!channels.some((known) => known.id === channel)) problems.push(`The outage chain of the person ${person} uses the channel ${channel}, and the instance has no such channel.`);
      else if (addresses.get(person)?.has(channel) !== true) problems.push(`The outage chain of the person ${person} uses the channel ${channel}, and the person has no contact on it.`);
    }
  }

  const recipients = config.people.map((entry, index): Recipient => {
    const recipient: Recipient = {
      watch: watches[index] ?? entry.watch,
      policies: entry.policies ?? config.policies,
      addresses: Object.fromEntries(addresses.get(entry.watch.person) ?? []),
    };
    for (const problem of recipientProblems(recipient, channels)) problems.push(`The person ${entry.watch.person}: ${problem}`);
    return recipient;
  });

  const drills = new Set<string>();
  const recipientOf = new Map(recipients.map((recipient) => [recipient.watch.person as string, recipient]));
  const rulesOf = new Map<string, ChannelRule[]>();
  for (const drill of config.drills ?? []) {
    const { id, person, path } = drill;
    if (drills.has(id)) problems.push(`Two drills have the id ${id}.`);
    drills.add(id);
    const recipient = recipientOf.get(person);
    if (recipient === undefined) problems.push(`The drill ${id} is for the person ${person}, and the configuration has no such person.`);
    else {
      if (addresses.get(person)?.has(path.channel) !== true) problems.push(`The drill ${id} uses the channel ${path.channel}, and the person ${person} has no contact on it.`);
      // The route sends the drill report only to a person who watches its subject.
      const watched = (recipient.watch.subjects ?? []).some((watch) => watch.system === DRILL_SUBJECT && (watch.id === undefined || watch.id === id));
      if (!watched) problems.push(`The drill ${id} is for the person ${person}, and the person does not watch the subject ${DRILL_SUBJECT}. The drill does not reach the person.`);
      const rules = drillRules(drill);
      rulesOf.set(person, [...(rulesOf.get(person) ?? []), ...rules]);
      // A run goes only to the person of the drill. Another person who watches the drill gets no step of a run, and
      // still gets the failure.
      for (const other of recipients) {
        if (other.watch.person === person || matchSubjects({ about: [{ system: DRILL_SUBJECT, id }] }, other.watch.subjects ?? []).length === 0) continue;
        rulesOf.set(other.watch.person, [...(rulesOf.get(other.watch.person) ?? []), { kinds: [`${DRILL_KIND}.run`], about: { system: DRILL_SUBJECT, id }, keep: "only", channels: [] }]);
      }
      if (watched) problems.push(...drillPlanProblems(drill, { ...recipient, channelRules: [...(recipient.channelRules ?? []), ...rules] }, config.assess ?? DEFAULT_ASSESS_POLICY));
    }
    problems.push(...drillProblems(drill, channels, recipient?.watch.quiet));
  }
  // The report of a down channel goes on each other channel of the person, because the down channel does not carry it.
  const ruled = recipients.map((recipient) => {
    const own = [...(addresses.get(recipient.watch.person)?.keys() ?? [])].sort(compareCodeUnits) as ChannelId[];
    const rules = [...(rulesOf.get(recipient.watch.person) ?? []), ...channelDownRules(own)];
    return rules.length === 0 ? recipient : { ...recipient, channelRules: [...(recipient.channelRules ?? []), ...rules] };
  });
  return { recipients: ruled, problems, optIn };
}

/**
 * This function gives the channel rules of the reports of down channels (AL-65), one for each channel. The report of a
 * down channel goes on each channel of the person except that channel. `loadConfig` adds them to each person.
 */
export function channelDownRules(channels: readonly ChannelId[]): ChannelRule[] {
  return channels.map((channel) => ({ kinds: [`${CHANNEL_KIND}.down`], about: { system: CHANNEL_SUBJECT, id: channel }, keep: "except", channels: [channel] }));
}

/**
 * This function gives the two channel rules of a drill. A run goes only on the channel of the path. A failure goes on
 * each other channel of the person, because the path can be the broken part. `loadConfig` adds them to the person.
 */
export function drillRules(drill: DrillConfig): ChannelRule[] {
  const about = { system: DRILL_SUBJECT, id: drill.id };
  return [
    { kinds: [`${DRILL_KIND}.run`], about, keep: "only", channels: [drill.path.channel] },
    { kinds: [`${DRILL_KIND}.failed`], about, keep: "except", channels: [drill.path.channel] },
  ];
}

// The plans of a drill for its person: the system fold makes the reports of a run and of its failure, the assessment
// gives their levels, and the channel rules keep the steps. Thus the check reads the same code as the runtime.
function drillPlanProblems(drill: DrillConfig, recipient: Recipient, policy: AssessPolicy): string[] {
  const at = DRILL_PROBES.map((from) => nextDrillAt(drill, [], from, recipient.watch.quiet)).find((start) => start !== undefined);
  // A drill with no start has a problem of `drillProblems`.
  if (at === undefined) return [];
  const snapshot = { sources: [], health: [], coverage: [], threats: [], drills: [{ copy: "probe", drill, run: { drill: drill.id, at } }] };
  const run = systemReports(NO_SYSTEM_LINES, snapshot, at);
  const end = at + drill.ackWithin;
  const failed = systemReports(run.lines, snapshot, end);
  const { id, person, path } = drill;
  const plans = [
    { name: "run", reports: run.reports, at },
    { name: "failure", reports: failed.reports.filter((report) => report.kind.code === `${DRILL_KIND}.failed`), at: end },
  ];
  const problems: string[] = [];
  for (const plan of plans) {
    for (const incident of incidents(normalize({ reports: plan.reports }), plan.at)) {
      const level = reachedAssessment(assess(incident, recipient.watch, [], policy, plan.at)).level;
      const found = level === "none" ? undefined : policyFor(recipient.policies, level, incident);
      if (found === undefined) {
        problems.push(`The ${plan.name} of the drill ${id} reaches the person ${person} at the level ${level}, and the person has no policy of it. It sends nothing.`);
        continue;
      }
      const kept = ruleSteps(found, recipient.channelRules, incident).policy;
      if (kept.steps.length > 0) continue;
      const which = plan.name === "run" ? `no step on the channel ${path.channel}` : `no step on a channel other than ${path.channel}`;
      problems.push(`The ${plan.name} of the drill ${id} reaches the person ${person} at the level ${level}, and its policy has ${which}. It sends nothing.`);
    }
  }
  return problems;
}

// The place ids of the place nodes of a graph, in the order of the edges and then of the mutes.
function graphPlaces(graph: InterestGraph): PlaceId[] {
  const nodes = [...graph.edges.flatMap((edge) => [edge.from, edge.to]), ...graph.mutes.flatMap((mute) => mute.subjects ?? [])];
  return [...new Set(nodes.flatMap((node) => placeOfNode(node) ?? []))];
}

/** The interests of one person after the load: the watch of the recipient, a row for each edge, and the problem of the join. */
export interface PersonInterests {
  readonly watch: PersonWatch;
  /** The rows of the graph of the watch. A person with no graph has no row. */
  readonly rows: readonly InterestRow[];
  /** The text of the refusal of the join. Then the person keeps the watch of the configuration. */
  readonly problem?: string;
}

/**
 * This function gives the watch of a recipient: the join of the default layers and the graph of the person
 * (`composeInterests`). A person with no defaults keeps the watch, and each edge of the graph is a row.
 *
 * The array `channels` holds the channels of the contacts of the person (`contactChannels`). The layer `delivery` takes
 * their services, unless the field `delivery` of the defaults is `false`.
 *
 * The layer `places` is always in the join. Without it, a graph of work topics alone stops the routing at the places.
 * A graph of another person also stays as it is: `relevanceProblems` reports it, and the places decide.
 */
export function personInterests(entry: PersonConfig, channels: readonly ChannelDescriptor[] = []): PersonInterests {
  const { watch, defaults } = entry;
  const own = watch.interests;
  const kept = (problem?: string): PersonInterests => ({ watch, rows: own?.edges.map((edge) => ({ edge })) ?? [], ...(problem === undefined ? {} : { problem }) });
  if (defaults === undefined || (own !== undefined && own.person !== watch.person)) return kept();
  try {
    const delivery = defaults.delivery === false ? [] : deliveryLayer(channels);
    const layers = [placesLayer(watch.places), workLayer(defaults.works ?? []), servicesLayer(defaults.services ?? []), delivery];
    const { graph, rows } = composeInterests(watch.person, layers, own);
    return { watch: { ...watch, interests: graph }, rows };
  } catch (error) {
    if (error instanceof RangeError) return kept(error.message);
    throw error;
  }
}

/** The lookup of the services of each contact: the store of the secrets, and the services of an address. */
export interface ContactLookup {
  readonly secret: SecretLookup;
  readonly services: ContactServices;
}

/**
 * This function gives the channels of the contacts of a person, in the order of `channels`. Each such descriptor has a
 * contact of the person in the configuration. The layer `delivery` takes the services of these channels.
 *
 * With a `lookup`, the descriptor of each channel also gets the services of the first contact of the person on it.
 * Only the keys of entities count. A missing secret, a lookup that throws and a key of another kind give no service.
 * The check of the contacts reports a missing secret. Thus no problem holds a value of an address or its services.
 */
export function contactChannels(
  config: Pick<AlertConfig, "contacts">,
  person: PersonId,
  channels: readonly ChannelDescriptor[],
  lookup?: ContactLookup,
): readonly ChannelDescriptor[] {
  const contacts = config.contacts.filter((contact) => contact.person === person);
  const ids = new Set<string>(contacts.map((contact) => contact.channel));
  const found = channels.filter((channel) => ids.has(channel.id));
  if (lookup === undefined) return found;
  return found.map((channel) => {
    const contact = contacts.find((one) => one.channel === channel.id);
    const resolved = contact === undefined ? undefined : resolveAddress(contact, lookup.secret);
    const added = resolved === undefined || resolved.missing.length > 0 ? [] : contactNodes(lookup.services, channel.id, resolved.address);
    return added.length === 0 ? channel : { ...channel, services: [...new Set([...(channel.services ?? []), ...added])] };
  });
}

// The address of a contact with the value of each secret, and each field whose secret the store does not have.
function resolveAddress(contact: ContactConfig, secret: SecretLookup): { readonly address: Address; readonly missing: readonly { readonly field: string; readonly name: string }[] } {
  const fields: [string, string][] = [];
  const missing: { field: string; name: string }[] = [];
  for (const [field, value] of Object.entries(contact.address)) {
    if (typeof value === "string") {
      fields.push([field, value]);
      continue;
    }
    const found = secret(value.secret);
    if (found === undefined || found === "") missing.push({ field, name: value.secret });
    else fields.push([field, found]);
  }
  return { address: Object.fromEntries(fields), missing };
}

// The services of an address that are entities. A lookup that throws gives none. By its contract it does not throw, and
// a problem with its error could hold a private fact of the address.
function contactNodes(services: ContactServices, channel: ChannelId, address: Address): readonly NodeKey[] {
  try {
    return services(channel, address).filter((node) => kindOfNode(node) === "entity");
  } catch {
    return [];
  }
}

/**
 * This function gives the problems of the interest graph and of the rule of the life-safety warnings of a person. The
 * set `own` holds the places of the person. A graph of another person makes the relevance fail at each incident. A
 * place node or a rule at a place that the person does not watch matches no incident.
 */
function relevanceProblems(watch: PersonWatch, own: ReadonlySet<string>): string[] {
  const person = watch.person;
  const problems: string[] = [];
  const graph = watch.interests;
  if (graph !== undefined) {
    if (graph.person !== person) problems.push(`The interest graph of the person ${person} is of the person ${graph.person}. The relevance fails, and the places decide.`);
    for (const place of graphPlaces(graph)) {
      if (!own.has(place)) problems.push(`The interest graph of the person ${person} names the place ${place}, and the person does not watch it.`);
    }
  }
  for (const rule of watch.mandatory ?? []) {
    if (!own.has(rule.place)) problems.push(`The rule of the life-safety warnings of the person ${person} names the place ${rule.place}, and the person does not watch it.`);
  }
  if (graph === undefined && (watch.mandatory?.length ?? 0) > 0) {
    problems.push(`The person ${person} has rules of the life-safety warnings and no interest graph. The rules have no effect without a graph.`);
  }
  return problems;
}

/**
 * This function gives the places of the configuration for the matching on the machine of the
 * instance, with each position. Do not give these places to a source: use `sourcePlaces`.
 */
export function localPlaces(config: AlertConfig): WatchedPlace[] {
  return config.places.map((place) => watchedPlace(place, true));
}

/** This function gives the places of the configuration for one source. A place has a position only when it shares it with that source. */
export function sourcePlaces(config: AlertConfig, source: SourceId): WatchedPlace[] {
  return config.places.map((place) => watchedPlace(place, place.sharePosition?.includes(source) === true));
}

/**
 * This function gives the labels of the places of the configuration, by their node keys `place:<id>`. The labels
 * stay on the machine of the instance: the runtime puts them only in the why line of a message.
 */
export function placeLabels(config: AlertConfig): WhyLabels {
  const labels = new Map<NodeKey, string>(config.places.map((place) => [placeNode(place.id), place.label]));
  return (node) => labels.get(node);
}

/** The scheme of the hash of a configuration. A new scheme gives a new hash to each configuration. */
export const CONFIG_HASH_SCHEME = "alerts-config-hash/1";

/**
 * This function gives the hash of a configuration: the SHA-256 of its canonical JSON (RFC 8785), as 64 hex characters.
 * The order of the keys does not change the hash. The copies of the system compare their hashes in the exchange.
 * A different hash tells that two copies can route an alert in two ways. The hash holds no value of the configuration.
 */
export function configHash(config: AlertConfig): string {
  return canonicalHash([CONFIG_HASH_SCHEME, config], { form: "json" });
}

// A watched place has no label. It has the position only when `withPosition` is true.
function watchedPlace(place: PlaceConfig, withPosition: boolean): WatchedPlace {
  return { id: place.id, codes: place.codes, bufferKm: place.bufferKm, ...(withPosition && place.at !== undefined ? { at: place.at } : {}) };
}
