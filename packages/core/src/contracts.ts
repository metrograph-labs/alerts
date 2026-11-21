/**
 * The contracts of the alert system: the event, the indicator, the source and the channel.
 *
 * The text of `docs/CONTRACTS.md` explains each part. All values are JSON values, so each type
 * crosses a procedure call, a log row and a copy of the system without a change.
 */

// =============================================================================
// Time, ids and references
// =============================================================================

/** This type is a time in milliseconds since the Unix epoch, in UTC. */
export type Instant = number;

/** This type is a length of time in milliseconds. */
export type Duration = number;

declare const brand: unique symbol;
/** This type gives a string a name, so that two kinds of id do not mix. */
export type Id<Name extends string> = string & { readonly [brand]: Name };

/** The id of a source adapter, for example `nws-api`. */
export type SourceId = Id<"SourceId">;
/** The source of each report of the core. No adapter has this id. Each copy makes its own system reports. */
export const SYSTEM_SOURCE = "system" as SourceId;
/** The id of a delivery channel, for example `pushover`. */
export type ChannelId = Id<"ChannelId">;
/** The id of one raw message from a source: the SHA-256 of its content, in hex. `observationId` makes it. */
export type ObservationId = Id<"ObservationId">;
/** The id of one report: the SHA-256 of the source id, the source key and the sent time, in hex. `reportId` makes it. */
export type ReportId = Id<"ReportId">;
/** The id of a person that the system watches over. The private configuration resolves it. */
export type PersonId = Id<"PersonId">;
/** The id of a place that the system watches. The private configuration resolves it. */
export type PlaceId = Id<"PlaceId">;

// =============================================================================
// The event: CAP 1.2 values, in lower case
// =============================================================================

/** The CAP status. Only `actual` can alert a person. */
export type Status = "actual" | "exercise" | "system" | "test" | "draft";

/** The CAP message type, without `ack` and `error`. */
export type Operation = "alert" | "update" | "cancel";

/** The CAP severity. */
export type Severity = "extreme" | "severe" | "moderate" | "minor" | "unknown";

/** The CAP urgency. */
export type Urgency = "immediate" | "expected" | "future" | "past" | "unknown";

/** The CAP certainty. */
export type Certainty = "observed" | "likely" | "possible" | "unlikely" | "unknown";

/** The CAP response type. */
export type ResponseType =
  | "shelter"
  | "evacuate"
  | "prepare"
  | "execute"
  | "avoid"
  | "monitor"
  | "assess"
  | "allclear"
  | "none";

/** The CAP categories, and five more: cyber, market, civic, personal and system. */
export type Category =
  | "geo"
  | "met"
  | "safety"
  | "security"
  | "rescue"
  | "fire"
  | "health"
  | "env"
  | "transport"
  | "infra"
  | "cbrne"
  | "other"
  | "cyber"
  | "market"
  | "civic"
  | "personal"
  | "system";

/** The stage of a hazard message. NWS VTEC gives it the name significance. */
export type Significance = "warning" | "watch" | "advisory" | "statement" | "outlook" | "observation";

/** The kind of an event in the taxonomy of the system. */
export interface Kind {
  /** A dotted code of the taxonomy, for example `met.tornado` or `infra.power.outage`. */
  readonly code: string;
  /** The stage, when the source gives one. */
  readonly significance?: Significance;
  /** The name that the source gives, for example `Tornado Warning`. */
  readonly label: string;
}

/** A position as in GeoJSON (RFC 7946): longitude, then latitude, in degrees (WGS 84). */
export type Position = readonly [lon: number, lat: number];

/**
 * The code of a region in one system of codes: `state`, `same`, `ugc`, `fips`, `iso3166` and others. The
 * system `ugc` holds the NWS forecast zones and counties (`KSZ083`, `KSC173`). The system `ugc-fire` holds the NWS fire
 * weather zones (`KSZ083` too). A fire zone and a forecast zone can have one code and different outlines. The system `same`
 * holds the SAME county codes (`020173`).
 */
export interface RegionCode {
  readonly system: string;
  readonly code: string;
}

/**
 * The key of the area block of a message, for example the path `info[0].area[1]` of a CAP `area` element. The
 * areas of one block tell one area together: the shapes of a block decide for that block. In a report,
 * the adapter writes a key that is unique in the report. In an incident, the merge puts the report id
 * before the key, so the blocks of two reports stay apart. An area with no key is in no block.
 */
export interface AreaBlock {
  readonly block?: string;
}

/** One area of an event. */
export type Area =
  /** A polygon. The first ring is the outside. Each ring closes on its first position. */
  | ({ readonly type: "polygon"; readonly rings: readonly (readonly Position[])[] } & AreaBlock)
  /** A circle on the ground. */
  | ({ readonly type: "circle"; readonly center: Position; readonly radiusKm: number } & AreaBlock)
  /** A region by its code. */
  | ({ readonly type: "code" } & RegionCode & AreaBlock)
  /**
   * A watched place of the configuration. Only the reports of the core use it, for example a gap of
   * the coverage at that place. An adapter does not know the places.
   */
  | { readonly type: "place"; readonly place: PlaceId };

/** A thing that an event is about, other than a place: a service, a cloud region, a market. */
export interface Subject {
  /** The system of the id, for example `cloud`, `service` or `market`. */
  readonly system: string;
  /** The id in that system, for example `aws/us-east-1`. */
  readonly id: string;
  readonly label?: string;
}

/**
 * A key that two sources share for one real event: an NWS VTEC event (office, phenomenon,
 * significance, event number and year), a USGS event id, and others. A shared key links two
 * reports into one incident with no doubt.
 */
export interface CorrelationKey {
  readonly system: string;
  readonly id: string;
}

/** One raw message as a source gave it. The log keeps each observation. */
export interface Observation {
  readonly id: ObservationId;
  readonly source: SourceId;
  /** The time at which the adapter got the message. */
  readonly fetched: Instant;
  readonly contentType: string;
  /** The body as text. A binary body is in base64, and `contentType` tells it. */
  readonly body: string;
  /** The facts of the transport. */
  readonly transport: {
    readonly url?: string;
    readonly status?: number;
    readonly latency: Duration;
    readonly etag?: string;
    readonly lastModified?: string;
  };
}

/**
 * One report: one message of one source, in the one format of the system. A report does not
 * change. An update or a cancel of the source is a new report.
 */
export interface Report {
  readonly id: ReportId;
  readonly source: SourceId;
  /**
   * The authority that issued the message: one of the `origins` of the source descriptor, for
   * example `nws` or `usgs`. The corroboration of an incident counts the different origins.
   */
  readonly origin: string;
  /** The id that the source gives to the message (the CAP identifier). */
  readonly key: string;
  /** The keys of the same source that this report updates or cancels (the CAP references). */
  readonly references: readonly string[];
  /** The keys that other sources also give for the same real event. */
  readonly correlation: readonly CorrelationKey[];
  readonly status: Status;
  readonly op: Operation;
  readonly kind: Kind;
  readonly categories: readonly Category[];
  readonly severity: Severity;
  readonly urgency: Urgency;
  readonly certainty: Certainty;
  readonly response: readonly ResponseType[];
  /** The time at which the source sent the message. */
  readonly sent: Instant;
  /** The time at which the adapter got the message. */
  readonly received: Instant;
  readonly effective?: Instant;
  readonly onset?: Instant;
  readonly expires?: Instant;
  /** The time at which the event ends, when the source tells it apart from `expires`. */
  readonly ends?: Instant;
  /** The areas of the event. An empty list: the event has no place. */
  readonly areas: readonly Area[];
  readonly areaText?: string;
  readonly about: readonly Subject[];
  /**
   * The persons of a private report: the CAP scope `Private` with its `addresses`. Each id is a person of the configuration.
   * A private report reaches only these persons. Absent means the CAP scope `Public`.
   */
  readonly addresses?: readonly PersonId[];
  /** The authority that sent the message, for example `NWS Topeka KS`. */
  readonly sender: string;
  readonly headline: string;
  readonly description?: string;
  readonly instruction?: string;
  readonly web?: string;
  /** The observation that the map function made this report from. */
  readonly observation: ObservationId;
  /** The name and value pairs of the source that the core does not know (the CAP parameters). */
  readonly parameters: Readonly<Record<string, readonly string[]>>;
}

// =============================================================================
// The indicator contract
// =============================================================================

/**
 * The dimensions of the indicators. A dimension is one kind of measure, for example rail delays or grid frequency. The
 * list is closed, as the taxonomy is. A new dimension is a change of the contract.
 */
export const DIMENSIONS = [
  { id: "road-traffic", title: "Road traffic flow" },
  { id: "road-events", title: "Road closures, incidents and work zones" },
  { id: "rail", title: "Rail punctuality and cancellations" },
  { id: "public-transit", title: "Bus, tram and metro service" },
  { id: "micromobility", title: "Bike and scooter share" },
  { id: "aviation-delays", title: "Airport delays and ground stops" },
  { id: "air-traffic", title: "Aircraft in the air" },
  { id: "air-passengers", title: "Air passengers and flights" },
  { id: "gnss-interference", title: "GNSS interference" },
  { id: "maritime-traffic", title: "Vessel traffic" },
  { id: "port-activity", title: "Port calls and chokepoint transits" },
  { id: "internet-connectivity", title: "Internet connectivity" },
  { id: "internet-routing", title: "Internet routing and latency" },
  { id: "online-service-status", title: "Online service status" },
  { id: "power-demand", title: "Electric load" },
  { id: "grid-frequency", title: "Grid frequency" },
  { id: "power-supply", title: "Power generation and prices" },
  { id: "fuel-prices", title: "Fuel prices and stock" },
  { id: "radiation", title: "Ambient radiation" },
  { id: "river-levels", title: "River levels and flow" },
  { id: "sea-level", title: "Sea level" },
  { id: "public-health", title: "Public health signals" },
  { id: "outbreak-reports", title: "Official outbreak reports" },
  { id: "online-attention", title: "Online attention" },
  { id: "news-volume", title: "News volume" },
  { id: "social-volume", title: "Social media volume" },
  { id: "active-fires", title: "Active fires" },
  { id: "night-lights", title: "Night lights" },
  { id: "air-quality", title: "Air quality" },
  { id: "felt-reports", title: "Felt reports" },
  { id: "food-prices", title: "Food prices" },
  { id: "ev-charging", title: "Electric vehicle charging" },
  { id: "emergency-calls", title: "Emergency and service calls" },
  { id: "border-crossings", title: "Border crossings" },
  { id: "financial-markets", title: "Financial markets" },
  { id: "disaster-mapping", title: "Satellite disaster mapping" },
] as const;

/** The id of a dimension of `DIMENSIONS`. */
export type DimensionId = (typeof DIMENSIONS)[number]["id"];

/** The ids of the dimensions, in the order of `DIMENSIONS`. */
export const DIMENSION_IDS: readonly DimensionId[] = DIMENSIONS.map((dimension) => dimension.id);

/**
 * The kind of the area of the readings of a measure. A country and a subdivision are region codes, for example
 * `iso3166-1` and `iso3166-2`. A grid cell and a box that the caller chose are polygons.
 */
export type IndicatorAreaKind = "code" | "point" | "line" | "polygon" | "zone" | "world";

/** The kinds of the area of a reading, in their order in a report. */
export const INDICATOR_AREA_KINDS: readonly IndicatorAreaKind[] = ["code", "point", "line", "polygon", "zone", "world"];

/** The area of one reading. Its `type` is the area kind of the measure. */
export type IndicatorArea =
  /** A region by its code, for example a country, a state or an NWS zone. */
  | ({ readonly type: "code" } & RegionCode)
  /** A station, a gauge, a sensor or a vehicle. */
  | { readonly type: "point"; readonly at: Position }
  /** A road link or a rail line: two positions or more. */
  | { readonly type: "line"; readonly path: readonly Position[] }
  /** A grid cell, or a box that the caller chose. The first ring is the outside, and each ring closes on its first position. */
  | { readonly type: "polygon"; readonly rings: readonly (readonly Position[])[] }
  /**
   * A zone of the domain of the source, for example an electricity bidding zone or a balancing authority. The
   * system names the codes, for example `eic`. A table of the atlas gives the regions of each zone.
   */
  | { readonly type: "zone"; readonly system: string; readonly code: string }
  /** No place: a market series, a subreddit or a service of the world. */
  | { readonly type: "world" };

/** The direction of a change that is a signal: `rise`, `drop` or `both`. */
export type Move = "rise" | "drop" | "both";

/** The directions of a change, in their order in a report. */
export const MOVES: readonly Move[] = ["rise", "drop", "both"];

/**
 * The baseline that a source gives with its values. With `none`, the core computes the normal level of each
 * series from its history. With `expected`, each reading holds the expected value of the source, for example a
 * load forecast or a timetable. With `flag`, each reading tells if the source marks it as an anomaly.
 */
export type OwnBaseline = "none" | "expected" | "flag";

/** The baselines that a source can give, in their order in a report. */
export const OWN_BASELINES: readonly OwnBaseline[] = ["none", "expected", "flag"];

/**
 * One measure that a source gives. A source can give measures of two dimensions or more. Each measure has one
 * dimension, one unit and one area kind.
 */
export interface MeasureDeclaration {
  /** The id of the measure in its source: small letters, digits and hyphens, with a letter first. */
  readonly id: string;
  readonly dimension: DimensionId;
  readonly title: string;
  /** The unit of each value, in the grammar of `@mark1russell7/quantity`, for example `{vehicle}/h`, `km/h` or `Hz`. */
  readonly unit: string;
  readonly area: IndicatorAreaKind;
  /** The direction of a change that is a signal. A cancelled train is a rise, and a station that goes offline is a drop. */
  readonly moves: Move;
  readonly baseline: OwnBaseline;
  /** The time between two values of one series. Absent: the cadence is not known. */
  readonly cadence?: Duration;
  /** The time from the time of a value to its publication. Absent: the delay is not known. */
  readonly delay?: Duration;
  /** The history that the source gives at once. Absent: the source gives only live values, so a baseline starts empty. */
  readonly backfill?: Duration;
}

/**
 * One value of one series of a measure at one time. A series is a station, a link or a zone of the source. A
 * reading does not change.
 */
export interface Reading {
  readonly source: SourceId;
  /** The id of the measure in the declaration of the source. The measure gives the dimension and the unit. */
  readonly measure: string;
  /** The id of the series in the measure, for example the id of a station. */
  readonly series: string;
  /**
   * The version of the method of the series. The source changes it when its method changes, for example a new
   * instrument. A baseline does not cross a version. Absent: the first version.
   */
  readonly version?: string;
  /** The time of the value, not the time of the fetch. */
  readonly at: Instant;
  readonly value: number;
  readonly area: IndicatorArea;
  /**
   * The cadence of the series, as the source states it, for example the ttl of a GBFS file. When it is present, it
   * replaces the cadence of the measure for this series. A general reader of many feeds gives it.
   */
  readonly cadence?: Duration;
  /** The expected value of the source. It is present only for a measure with the baseline `expected`. */
  readonly expected?: number;
  /** True when the source marks the value as an anomaly. It is present only for a measure with the baseline `flag`. */
  readonly flagged?: boolean;
  /** The raw message that gave the reading. */
  readonly observation: ObservationId;
}

// =============================================================================
// The source contract
// =============================================================================

/** How a source gives its data. */
export type Transport = "poll" | "stream" | "push" | "radio";

/**
 * A resource of the cell. The cell is the copy of the system on one machine. Each source of the
 * cell uses the same internet link, the same DNS resolver, the same power and the same receivers. So the fault of a
 * resource is a common fault of the cell, not the fault of one source.
 */
export type CellResource = "internet" | "dns" | "power" | "receiver";

/** The resources of the cell, in their order in a report. */
export const CELL_RESOURCES: readonly CellResource[] = ["internet", "dns", "power", "receiver"];

/** The facts of a source. The core uses them for the schedule, the health and the coverage. */
export interface SourceDescriptor {
  readonly id: SourceId;
  readonly title: string;
  /** The authorities whose messages the source carries, for example `nws` or `usgs`. */
  readonly origins: readonly string[];
  /**
   * The failure domains outside the cell that the source needs: providers, CDNs, carriers, transmitters
   * and regions. Examples: `provider:nws-api`, `cdn:akamai`, `carrier:noaaport`, `rf:nwr`. The kind of a
   * domain comes before the colon. The paths of the atlas use the same ids. Two sources with a shared
   * domain are not independent for coverage. Do not put the resources of the cell here.
   */
  readonly dependsOn: readonly string[];
  /**
   * The resources of the cell that the source uses. An internet source uses `internet`, `dns` and
   * `power`. A radio source uses `receiver` and `power`.
   */
  readonly uses: readonly CellResource[];
  /** The prefixes of the taxonomy codes that the source covers, for example `met` and `geo.earthquake`. */
  readonly kinds: readonly string[];
  /** The areas that the source covers, or `global`. */
  readonly coverage: readonly Area[] | "global";
  readonly transport: Transport;
  /** The time between two fetches in normal work. */
  readonly interval: Duration;
  /** The longest time that a fetch takes before the health is `slow`. */
  readonly slowAfter: Duration;
  /**
   * The longest normal time with no new message. Absent: a quiet source is normal, as an alert
   * feed with no alert.
   */
  readonly maxQuiet?: Duration;
  readonly auth: "none" | "key" | "oauth";
  /**
   * `snapshot`: each complete fetch gives all the messages that are in effect, and a message that ends
   * leaves the list with no cancel. Then the runtime ends a report that is absent from complete fetches.
   * Absent: a stream. A message stays until its cancel or its expiry.
   */
  readonly listing?: "snapshot";
  /** A plain sentence of the canary check, when the source has one. */
  readonly canary?: string;
  /** The measures of an indicator source. Absent: the source gives only events. */
  readonly measures?: readonly MeasureDeclaration[];
}

/**
 * A place that the system watches, as the adapters see it. It holds no name and no address. A source
 * fetches by the region codes, and the core matches the places on the machine of the instance.
 */
export interface WatchedPlace {
  readonly id: PlaceId;
  /** The position of the place. Absent unless the owner lets this source get positions. */
  readonly at?: Position;
  /**
   * The codes of the regions that contain the place: the NWS zones and county, SAME, the state
   * (`state`) and the country (`iso3166`). The coverage of a source can name a region at each level.
   */
  readonly codes: readonly RegionCode[];
  /** The distance around the place that the system also watches. */
  readonly bufferKm: number;
}

/** What a fetch asks for. */
export interface Watch {
  readonly places: readonly WatchedPlace[];
  /** The prefixes of the taxonomy codes. Absent: all kinds of the source. */
  readonly kinds?: readonly string[];
}

/** The state that a source keeps between two fetches: an ETag, a time, a sequence number. */
export type Cursor = Readonly<Record<string, string>>;

/** Why a fetch failed. */
export type FetchFailure =
  | { readonly kind: "network" | "timeout" | "server"; readonly message: string; readonly retryAfter?: Duration }
  | { readonly kind: "rate-limited"; readonly message: string; readonly retryAfter?: Duration }
  | { readonly kind: "auth" | "refused"; readonly message: string };

/** The result of one fetch. */
export type FetchOutcome =
  | {
      readonly ok: true;
      readonly observations: readonly Observation[];
      readonly cursor?: Cursor;
      /**
       * True: the source answered in full. An empty list with `complete` true means "no message",
       * not "no answer".
       */
      readonly complete: boolean;
      /**
       * The time of the data of a complete list of a snapshot source: the time of its newest product. A cache can give an
       * old list, and this time tells its age. The runtime reads a list with no time as current.
       */
      readonly asOf?: Instant;
    }
  | { readonly ok: false; readonly failure: FetchFailure };

/**
 * A part of a message that the map function did not understand. Problems tell of a format change. A
 * problem has one of three effects. A fatal problem gives no report. A lossy problem gives a report that
 * lacks a value of the message, or holds a fallback in its place. A note gives a whole report.
 */
export interface MapProblem {
  /** The path in the message, for example `features[3].properties.onset`. */
  readonly path: string;
  readonly message: string;
  /** True: the map function could not make a report from the message. */
  readonly fatal: boolean;
  /**
   * True: the report lacks a value of the message, or holds a fallback in its place. The field is
   * absent for a note and for a fatal problem.
   */
  readonly lossy?: true;
}

/** The result of the map function. */
export interface MapResult {
  readonly reports: readonly Report[];
  readonly problems: readonly MapProblem[];
  /**
   * The readings of the indicator measures in the message. The runtime checks each reading against the declaration of
   * its measure, and keeps it in the store of the readings, not in the event log. A source with no measures gives no field.
   */
  readonly readings?: readonly Reading[];
}

/** The result of the canary check of a source. */
export interface CanaryResult {
  readonly pass: boolean;
  readonly reason: string;
}

/**
 * The record of one fetch of a source. The runtime writes one record when each fetch ends, and the
 * core calculates the health of the source from the records.
 */
export interface FetchRecord {
  readonly source: SourceId;
  /** The time at which the fetch started. */
  readonly at: Instant;
  /** The time that the fetch took. */
  readonly took: Duration;
  /** The failure of the fetch. It is absent when the fetch passed. */
  readonly failure?: FetchFailure;
  /** The count of observations of the fetch that the log did not have before. */
  readonly fresh: number;
  /** The count of fatal problems that the map gave for the observations of the fetch. */
  readonly fatal: number;
  /** The count of lossy problems that the map gave for the observations of the fetch. An absent count is 0. */
  readonly lossy?: number;
  /** The result of the canary check of the observations of the fetch, when the source has a canary and the check decides. */
  readonly canary?: CanaryResult;
}

/**
 * The part of an `AbortSignal` that a fetch reads. The core has no platform, thus it does not name the
 * `AbortSignal` type of a platform. An `AbortSignal` of Node.js or of a browser has each member.
 */
export interface FetchSignal {
  /** This value is true after the abort. */
  readonly aborted: boolean;
  /** This value is the reason of the abort, after the abort. */
  readonly reason?: unknown;
  /** This function adds a listener of the abort. */
  addEventListener(type: "abort", listener: () => void, options?: { readonly once?: boolean }): void;
  /** This function removes a listener of the abort. */
  removeEventListener(type: "abort", listener: () => void): void;
}

/**
 * The procedures of one source. Each source package registers them under the path
 * `alerts.source.<id>.<name>`.
 *
 * - `describe`: no effects.
 * - `fetch`: it reads `network`, through polite-crawler. It is idempotent. For a failure of the
 *   source, it gives `{ ok: false }` and does not throw.
 * - The optional `signal` of `fetch` stops the fetch. The runtime aborts it at the time limit of
 *   the fetch and at the stop of the runtime. After the abort, the fetch sends no more requests.
 *   It can then throw the reason of the signal.
 * - `map`: a pure, total function. It does not throw, and the same observation gives the same
 *   reports with the same ids.
 * - `check`: it examines the observations of a fetch against the canary, and sends no request. It gives `undefined`
 *   when it cannot decide yet: no read. The health then gets no canary event. A stream gives no read until its session
 *   had one full period of its test message.
 * - `locate`: optional. It reads `network` and is idempotent. It gives the region codes of a
 *   position, for a source that has a lookup: the `/points` query of the NWS API.
 * - `close`: optional. It ends the resources of the source, for example the session of a stream. The runtime starts
 *   it one time, at the stop, after the last fetch. It does not throw.
 */
export interface SourceProcedures {
  describe(): SourceDescriptor;
  fetch(input: { readonly watch: Watch; readonly cursor?: Cursor }, signal?: FetchSignal): Promise<FetchOutcome>;
  map(input: { readonly observation: Observation }): MapResult;
  check?(input: { readonly observations: readonly Observation[] }): CanaryResult | undefined;
  locate?(input: { readonly at: Position }): Promise<LocateOutcome>;
  close?(): Promise<void>;
}

/** The result of a lookup of the region codes of a position. */
export type LocateOutcome =
  | { readonly ok: true; readonly codes: readonly RegionCode[] }
  | { readonly ok: false; readonly failure: FetchFailure };

// =============================================================================
// Health and coverage (the core calculates them, not the adapter)
// =============================================================================

/** The health of a source. */
export type HealthState = "unknown" | "healthy" | "slow" | "failing" | "silent" | "changed";

/** The health of one source at one time. */
export interface SourceHealth {
  readonly source: SourceId;
  readonly state: HealthState;
  readonly since: Instant;
  readonly lastSuccess?: Instant;
  readonly lastFailure?: { readonly at: Instant; readonly failure: FetchFailure };
  readonly reason: string;
}

/** The sources that cover one kind at one place at this time. */
export interface Coverage {
  readonly place: PlaceId;
  readonly kind: string;
  /** The sources that are up and cover the kind at the place. */
  readonly sources: readonly SourceId[];
  /**
   * The smallest count of outside failure domains whose faults stop each of these sources. At 2
   * or more, no single outside fault stops the coverage.
   */
  readonly independent: number;
  /**
   * The search of the smallest count ended. When it is false, the search passed its budget. Then
   * `independent` is the count of a set that the search found, and the true count can be smaller.
   */
  readonly proven: boolean;
  /** The outside failure domains of the smallest set: one fault of each stops each of these sources. */
  readonly faults: readonly string[];
  /**
   * The resources of the cell that each of these sources uses. One fault of one of them stops all
   * of these sources in this cell.
   */
  readonly commonResources: readonly CellResource[];
  /** The count that the policy needs. A smaller count is a coverage alert. */
  readonly required: number;
}

// =============================================================================
// Incidents (the core makes them from the reports)
// =============================================================================

/**
 * One real event, made from one or more reports. The core calculates each incident from the
 * merge state and a time, so each copy of the system gets the same incidents.
 */
export interface Incident {
  /** The smallest report id of the incident. It changes when two incidents merge. */
  readonly anchor: ReportId;
  /** The report ids of the incident, from the smallest. */
  readonly reports: readonly ReportId[];
  /** The status of each report of the incident. Reports of two statuses are not in one incident. */
  readonly status: Status;
  readonly kind: Kind;
  readonly severity: Severity;
  readonly urgency: Urgency;
  readonly certainty: Certainty;
  readonly onset?: Instant;
  readonly expires?: Instant;
  readonly areas: readonly Area[];
  readonly about: readonly Subject[];
  /** The persons of a private incident: the `addresses` of its reports. Each report of an incident has the same audience. */
  readonly addresses?: readonly PersonId[];
  /** False when each line of reports is cancelled, expired or ended at the time of the calculation. */
  readonly live: boolean;
  /** The count of different origins that report the event. */
  readonly corroboration: number;
  /**
   * The lines of the incident: one for each report that gives its values, with the values and the areas of that
   * report. The merge gives them only when the values of two lines differ. The assessment gives each place the
   * level of the lines whose areas hold that place. Without lines, each place gets the level of the incident.
   */
  readonly lines?: readonly IncidentLine[];
}

/**
 * One line of an incident: a report that gives the values of the incident, with its own values and areas. For
 * example, each band of the shaking of an earthquake is one line, with its severity and its circle.
 */
export interface IncidentLine {
  readonly report: ReportId;
  readonly kind: Kind;
  readonly severity: Severity;
  readonly urgency: Urgency;
  readonly certainty: Certainty;
  readonly onset?: Instant;
  /** The live areas of the report, with the keys of the blocks of the incident. */
  readonly areas: readonly Area[];
}

// =============================================================================
// Delivery: the level, the message and the channel contract
// =============================================================================

/**
 * The level of an alert.
 * - `life-safety`: it wakes the person, sounds through silent mode and escalates until acknowledged.
 * - `urgent`: a push at once, without the break through Do Not Disturb.
 * - `notice`: a push in the day. In the quiet window of the person, a quiet push that the next digest tells again.
 * - `digest`: the next digest: one message each day for each person (`planDigests`).
 */
export type Level = "life-safety" | "urgent" | "notice" | "digest";

/** The order of the levels, from the lowest. */
export const LEVELS: readonly Level[] = ["digest", "notice", "urgent", "life-safety"];

/**
 * One field of the address of a person on a channel, for example the user key of Pushover. The load of the
 * configuration checks each address with the fields of its channel.
 */
export interface AddressField {
  /** The name of the field in the address, for example `user` or `to`. */
  readonly name: string;
  /** True: each address on the channel has the field. */
  readonly required: boolean;
  /**
   * The form of the whole value: the source of a regular expression with the flag `u`. The check adds the anchors
   * `^` and `$`. Write a pattern with no nested repeats, because the check runs it on each address.
   */
  readonly pattern: string;
  /** The form in words, for the text of a problem, for example `a phone number in E.164 form`. It tells no value. */
  readonly form: string;
  /**
   * True: each value of the field needs a record of the opt-in list of the configuration (`optIn`). A send to a value
   * with no opt-in fails with the kind `consent`. The default is false.
   */
  readonly optIn?: boolean;
}

/** The facts of a channel. The core uses them for the escalation and the coverage of delivery. */
export interface ChannelDescriptor {
  readonly id: ChannelId;
  readonly title: string;
  /**
   * The failure domains outside the cell that the channel needs, for example `provider:pushover` and
   * `provider:apns`. Do not put the resources of the cell here.
   */
  readonly dependsOn: readonly string[];
  /**
   * The online services that the channel needs, as the keys of entities, for example `domain:api.twilio.com`. Each person
   * with a contact on the channel gets each service in the layer `delivery` of the interest graph. Thus an outage of
   * the path of the alerts of a person reaches that person.
   */
  readonly services?: readonly NodeKey[];
  /**
   * The endpoints that the procedures of the channel call, as the keys of entities, for example `domain:api.twilio.com`.
   * Each one is also in `services`. A report of a down channel names them (AL-65). Thus the layer `delivery` of the
   * interest graph takes the report to each person with a contact on the channel. A service that the calls do not reach,
   * as the push service of a phone platform, is only in `services`.
   */
  readonly api?: readonly NodeKey[];
  /**
   * The resources of the cell that the channel uses. A push or a text through an API uses
   * `internet`, `dns` and `power`. Thus a fault of the internet link stops each source and each such
   * channel together.
   */
  readonly uses: readonly CellResource[];
  /** True: the channel can sound through silent mode and Do Not Disturb. */
  readonly breaksThrough: boolean;
  /** True: the channel repeats a message by itself until the person acknowledges it. */
  readonly repeats: boolean;
  /** How the channel tells of an acknowledgment: not at all, by a receipt to poll, or by a callback. */
  readonly ack: "none" | "poll" | "callback";
  readonly maxTitle: number;
  readonly maxBody: number;
  /** The cost of one message, when the channel costs money. */
  readonly costUsd?: number;
  /**
   * The most calls of the channel in progress at the same time, from the rules of its provider. The delivery
   * holds each other call for a later step. Without it, the delivery has no limit.
   */
  readonly maxInFlight?: number;
  /**
   * True: a person takes one message of the channel at a time, as with a phone call. A second phone call during the
   * first gets a busy line. Thus a copy with a rank above 0 waits at least the rank floor before a step of the channel.
   */
  readonly exclusive?: boolean;
  /**
   * The limit of the why line of the channel. `WHY_LIMITS` in `why.ts` holds the limit of each kind of channel.
   * When it is absent, the messages of the channel have no why line.
   */
  readonly why?: WhyLimit;
  /**
   * The fields of the address of a person on the channel. The load of the configuration refuses an address that
   * does not agree with this list. With no list, each address passes. The function `addressProblems` tells the rules.
   */
  readonly address?: readonly AddressField[];
  /**
   * The levels at which a message of the channel asks the person for an acknowledgment. With no list, a channel with an
   * `ack` other than `none` asks at each level. An exhausted escalation tells the watchers only after such a step (AL-21).
   */
  readonly ackLevels?: readonly Level[];
}

/** The limit of a why line: the most characters, the most words, or both. */
export interface WhyLimit {
  /** The most characters (code points). */
  readonly chars?: number;
  /** The most words. */
  readonly words?: number;
}

/** One message to one person on one channel. */
export interface Message {
  /**
   * The delivery key: the SHA-256 of the incident anchor, the level, the person and the step. `messageKey` makes it.
   * A channel that can drop a repeated key does so.
   */
  readonly key: string;
  readonly person: PersonId;
  readonly level: Level;
  readonly title: string;
  readonly body: string;
  readonly url?: string;
  /** A report of the incident: its anchor at the time of the send. */
  readonly incident: ReportId;
  /** The time after which the message has no use. */
  readonly expires?: Instant;
  /**
   * True: the channel sends the message in its silent mode, for example Pushover priority `-1`, or a
   * text and no call. The escalation sets it in the quiet window of the person. A `life-safety`
   * message is not quiet in the window. A mute with the effect `silent` makes each message quiet,
   * also at `life-safety`. The channel keeps no rule of its own about the time of day.
   */
  readonly quiet: boolean;
  /**
   * True: the message tells of the entry of a channel into the reserve of its quota. The channel can send
   * it from the reserve, one time in each window. `messageOf` sets it.
   */
  readonly useReserve?: boolean;
  /**
   * The why line: why the message reaches the person, in the limit of the channel. The runtime makes it from the
   * `WhyRecord` of the route and the private labels. It holds no address, point or region code.
   */
  readonly why?: string;
}

/** The address of a person on a channel, from the private configuration. The repo does not hold an address. */
export type Address = Readonly<Record<string, string>>;

/** The receipt of a sent message, as the channel gives it. */
export type Receipt = Readonly<Record<string, string>>;

/**
 * The stages of the quota of a channel. Each stage is a line of system reports:
 *
 * - `low`: the window has 2 reserves of units or fewer left.
 * - `reserve`: the window has the reserve or fewer left. The channel sends only `life-safety`.
 * - `spent`: the provider refuses each message, also a `life-safety` message.
 */
export type QuotaStage = "low" | "reserve" | "spent";

/** The state of the quota of a channel in its window, as the gate of the channel counts it. */
export interface ChannelQuota {
  readonly channel: ChannelId;
  /** The units of one window. */
  readonly limit: number;
  /** The last units of the window. The channel uses them only for `life-safety`. */
  readonly reserve: number;
  /** The units used in the window. */
  readonly used: number;
  /** The end of the window. */
  readonly resetAt?: Instant;
  /** The provider refuses each message until this time. */
  readonly blockedUntil?: Instant;
  /** The name of the units in a text, in the plural: for example `cents` for a cap of the spend. The default is `units`. */
  readonly unit?: string;
}

/**
 * The stages of the balance of a provider account. Each stage is a line of system reports:
 *
 * - `low`: the balance is below a floor. Each floor that the balance is below gives its own line `low`.
 * - `empty`: the balance is 0 or less. The provider then refuses each paid message.
 * - `unread`: no read passed for the maximum age or longer. Then the watch cannot see a low balance.
 */
export type BalanceStage = "low" | "empty" | "unread";

/** One read of the balance of a provider account that passed. */
export interface BalanceRead {
  /** The balance in the currency of the account. It is below 0 when the account owes money. */
  readonly balance: number;
  /** The currency of the account, as a code of ISO 4217: for example `USD`. */
  readonly currency: string;
  readonly at: Instant;
}

/**
 * The stages of another copy of the system (AL-16), as this copy sees it. Each stage is a line of system reports:
 *
 * - `skew`: the clock of the other copy differs from the clock of this copy by more than the limit.
 * - `config`: the other copy has a different hash of the configuration. Then the copies can route an alert in two ways.
 * - `unread`: no read of the log of the other copy passed for the maximum age. Then the two copies can both send.
 * - `unsteady`: the other copy did not get steady for `COPY_STEADY_LIMIT` (AL-108). It starts again and again, and it sends nothing.
 */
export type CopyStage = "skew" | "config" | "unread" | "unsteady";

/** One read of the log of another copy that passed. */
export interface CopyRead {
  /** The middle of the call, on the clock of this copy. */
  readonly at: Instant;
  /** The time of the other copy minus `at`. It is below 0 when the clock of the other copy is behind. */
  readonly skew: Duration;
  /** This value tells if the other copy has the hash of the configuration of this copy. */
  readonly sameConfig: boolean;
}

/** The watch of another copy of the system, at one time. */
export interface CopyWatch {
  /** The id of the other copy. */
  readonly copy: string;
  /** The largest difference of the two clocks with no stage `skew`. */
  readonly skewLimit: Duration;
  /** The longest time with no read that passed. After it, the stage is `unread`. */
  readonly maxAge: Duration;
  /** The start of the watch. With no read, the time of `unread` counts from it. */
  readonly since: Instant;
  /** The last read that passed. */
  readonly read?: CopyRead;
  /**
   * The last start of each drill of the other copy, by the id of the drill, on the clock of that copy (AL-43). The last
   * read that passed gives them. A copy of an older build gives none.
   */
  readonly drills?: Readonly<Record<string, Instant>>;
  /**
   * The first read that passed and told that the other copy is not steady, after its last steady read (AL-108). A steady
   * read ends it. A failed read keeps it. A copy of an older build tells nothing, thus its watch has none.
   */
  readonly unsteadySince?: Instant;
}

/** The watch of the balance of one provider account, at one time. */
export interface ProviderBalance {
  /** The provider, as an id in the `dependsOn` of its channels: for example `provider:twilio`. */
  readonly provider: string;
  /** The name of the provider in a text: for example `Twilio`. */
  readonly title: string;
  /** The channels that the account pays for. The reports have their subjects. */
  readonly channels: readonly ChannelId[];
  /**
   * The floors of the balance in the currency of the account. The list has one floor or more. Below a floor, the stage is
   * `low`. Each floor that the balance is below gives its own line `low`.
   */
  readonly floors: readonly number[];
  /** The longest time with no read that passed. After it, the stage is `unread`. */
  readonly maxAge: Duration;
  /** The start of the watch. With no read, the time of `unread` counts from it. */
  readonly since: Instant;
  /** The last read that passed. */
  readonly read?: BalanceRead;
}

/**
 * The result of a send. A failed send has one of these kinds:
 *
 * - `network`, `timeout` and `server`: the channel can have the message.
 * - `rate-limited`: the provider refuses each message until the retry.
 * - `reserved`: the channel keeps the last units of its quota for a higher level. It still sends a message of that level.
 * - `auth` and `refused`: the provider refused the key or the message.
 * - `consent`: the address has no opt-in, or its person took the opt-in back with a STOP reply. The channel sent nothing.
 * - `quiet`: the message is quiet, and the channel has no silent mode, as a call. The step goes after the quiet window.
 * - `expired`: the message expired before the send. The channel sent nothing.
 */
export type SendOutcome =
  | { readonly ok: true; readonly receipt: Receipt; readonly accepted: Instant }
  | {
      readonly ok: false;
      readonly kind: "network" | "timeout" | "server" | "rate-limited" | "reserved" | "auth" | "refused" | "consent" | "quiet" | "expired";
      readonly message: string;
      readonly retryAfter?: Duration;
    };

/** The kind of a failed send. `SendOutcome` tells each kind. */
export type ChannelFailureKind = Extract<SendOutcome, { readonly ok: false }>["kind"];

/**
 * The outcome of a probe of a channel: a call to its provider that sends nothing and costs nothing. A success tells that
 * the provider takes the calls of the channel. A failure has a kind of `ChannelFailureKind`.
 */
export type ProbeOutcome =
  | { readonly ok: true; readonly at: Instant }
  | { readonly ok: false; readonly kind: ChannelFailureKind; readonly message: string };

/** The state of a sent message. */
export type DeliveryState = "accepted" | "delivered" | "acknowledged" | "expired" | "failed";

/** The state of a sent message, as the channel tells it. */
export interface DeliveryStatus {
  readonly state: DeliveryState;
  readonly at: Instant;
  /** The device or the person that acknowledged, when the channel tells it. */
  readonly by?: string;
  readonly reason?: string;
}

/**
 * The procedures of one channel. Each channel package registers them under the path
 * `alerts.channel.<id>.<name>`. The core does the escalation and the acknowledgment, not the channel.
 *
 * - `describe`: no effects.
 * - `send`: it writes `network`. It is not idempotent, unless the channel drops a repeated key.
 * - `status`: it reads `network`.
 * - `cancel`: it writes `network`. It stops the repeats of a message. It is idempotent.
 * - `probe`: it reads `network`. It is an authenticated read that sends nothing and costs nothing. The runtime calls it
 *   15 minutes after the last good call, and sooner after a failed probe (AL-65). A failed probe counts in the run of the
 *   channel, and a success ends the run and the line. A channel with no probe keeps its line until an accepted send.
 * - `services`: no effects. It reads only the address. The procedure is optional.
 */
export interface ChannelProcedures {
  describe(): ChannelDescriptor;
  send(input: SendInput): Promise<SendOutcome>;
  status(input: { readonly receipt: Receipt }): Promise<DeliveryStatus>;
  cancel(input: CancelTarget): Promise<void>;
  probe?(): Promise<ProbeOutcome>;
  /**
   * The services that carry the messages of the channel to one address, as node keys of entities. An example is the
   * region of the carrier network of a phone number. The procedure gives an empty list for an address that it cannot
   * read. It does not throw.
   */
  services?(input: { readonly address: Address }): readonly NodeKey[];
}

/**
 * The services of the contact of a person on one channel, as node keys of entities (`ChannelProcedures.services`).
 * The load adds them to the services of the channel for that person only. A result can tell a private fact of the
 * address, for example the region of a phone number. Thus no problem and no log holds it.
 */
export type ContactServices = (channel: ChannelId, address: Address) => readonly NodeKey[];

/** The input of a send. */
export interface SendInput {
  readonly message: Message;
  readonly address: Address;
  /**
   * The id of this send of the key. Its characters match `COPY_ID`. Each send of a key has a new id.
   * A channel that repeats a message keeps the id with the message. Then `cancel({ copy })` stops this copy only.
   */
  readonly copy?: string;
}

/**
 * The target of a cancel. A receipt stops each copy of its delivery key. A copy id stops one copy
 * whose send did not end, thus the cancel has no receipt of it. The new copy of the key continues.
 */
export type CancelTarget = { readonly receipt: Receipt } | { readonly copy: string };

/** One step of an escalation: a channel, and the wait after the step before it. */
export interface EscalationStep {
  readonly channel: ChannelId;
  /** The time from the start of the escalation to this step. */
  readonly at: Duration;
}

/**
 * The escalation of one level: the steps, until a person acknowledges. A policy with a subject (`about`) applies only
 * to the incidents about that subject with the status `system`, `test` or `exercise`. For them, it replaces the policy
 * of the level with no subject. Thus no policy with a subject changes the plan of a real warning.
 */
export interface EscalationPolicy {
  readonly level: Level;
  /**
   * The daily time of the digest. Only a policy of the level `digest` has it. Without it, the digest goes at the
   * end of the quiet window of the person.
   */
  readonly daily?: DailyTime;
  /** The subject of the policy, as a subject watch. A subject watch with no id matches each subject of its system. */
  readonly about?: SubjectWatch;
  readonly steps: readonly EscalationStep[];
  /** The time after the last step at which the escalation is exhausted. Exhausted is a system alert. */
  readonly exhaustedAfter: Duration;
}

/** A local time of each day in a time zone. The digest goes at this time. */
export interface DailyTime {
  /** The IANA name of the time zone, for example `Europe/Berlin`. */
  readonly zone: string;
  /** The local time `HH:MM`, from `00:00` to `23:59`. */
  readonly time: string;
}

/**
 * One accepted send of one step of an escalation. The merge state keeps each send, so each copy of
 * the system knows the level that a person already got. A send that failed makes no record, so its
 * step stays due.
 */
export interface Delivery {
  /** The key of the message, from `messageKey`. */
  readonly key: string;
  /** A report of the incident: its anchor at the time of the send. */
  readonly incident: ReportId;
  readonly level: Level;
  readonly person: PersonId;
  readonly channel: ChannelId;
  /** The index of the step in the escalation, from 0. */
  readonly step: number;
  /** The time at which the channel accepted the message. */
  readonly at: Instant;
  /** The receipt of the channel, when it gives one. The escalation uses it to cancel or to poll. */
  readonly receipt?: Receipt;
}

/** An acknowledgment from a person, by any channel or the UI. It stops the escalation of the level. */
export interface Acknowledgment {
  /** A report of the incident. The ack applies to the incident that holds this report, also after a merge. */
  readonly incident: ReportId;
  readonly level: Level;
  readonly person: PersonId;
  readonly at: Instant;
  readonly via: ChannelId | "ui";
}

// =============================================================================
// The merge state
// =============================================================================

/**
 * A mark of the runtime on a report of a snapshot source. The latest mark of a report at a time tells
 * if the report ended. At one time, a mark with `ended` false wins, so a tie keeps the report live.
 */
export interface EndMark {
  readonly report: ReportId;
  readonly at: Instant;
  /** True: the report left the list of its source. False: the report is in the list again. */
  readonly ended: boolean;
  /** The time of the data of the list that ended the report (`asOf` of the fetch), if the list has a time. */
  readonly asOf?: Instant;
}

/**
 * The mark of a report that left the merge state after the horizon of its incident (`retirements`). A copy
 * of the report that arrives later stays out until the time `until`. Then `pruneTombstones` drops the mark.
 */
export interface Tombstone {
  readonly report: ReportId;
  readonly until: Instant;
}

/**
 * The merge state: five grow-only sets. The join of two states is their union, so each copy of
 * the system that gets the same parts gets the same state. `normalize` gives the one form of a
 * state. It has one report for each id, in the order of the ids. It has each delivery, each
 * acknowledgment and each end mark one time, in the order of their canonical JSON.
 *
 * The tombstones remove parts: a state has no report with a tombstone, and no delivery,
 * acknowledgment or end mark of such a report. The removal reads only the union, so the join keeps its laws.
 */
export interface MergeState {
  readonly reports: readonly Report[];
  readonly deliveries: readonly Delivery[];
  readonly acks: readonly Acknowledgment[];
  /** The end marks of the reports of the snapshot sources. */
  readonly ends: readonly EndMark[];
  /** The tombstones of the retired reports: one for each report, with the latest `until`, in the order of the report ids. */
  readonly retired: readonly Tombstone[];
}

// =============================================================================
// The assessment
// =============================================================================

/** The level of an incident for a person, or `none`: no message. */
export type AssessedLevel = Level | "none";

/** The order of the assessed levels, from the lowest. */
export const ASSESSED_LEVELS: readonly AssessedLevel[] = ["none", ...LEVELS];

/**
 * The highest levels for the severity and for the urgency of an incident. The level of the table is the
 * lower of the two values.
 */
export interface LevelTable {
  readonly severity: Readonly<Record<Severity, AssessedLevel>>;
  readonly urgency: Readonly<Record<Urgency, AssessedLevel>>;
  /**
   * The time after the onset in which the urgency `past` counts as `immediate`. A report of an event that
   * occurred, for example an earthquake, has the urgency `past`. With no time of the assessment or no onset,
   * the age is unknown, and `past` counts as `immediate`. When it is absent, `past` keeps its lookup.
   */
  readonly pastWithin?: Duration;
}

/** A class of kinds with its own table, for example the kinds that can reach `life-safety`. */
export interface KindClass extends LevelTable {
  readonly id: string;
  /** The prefixes of the taxonomy codes of the class, for example `met.tornado`. */
  readonly kinds: readonly string[];
  /** The statuses that can make a message of this class. Absent: the statuses of the policy. */
  readonly statuses?: readonly Status[];
}

/** The data of the first assessment. A change of the policy is a change of data, not of code. */
export interface AssessPolicy {
  /** The statuses that can make a message, for each class with no statuses of its own. Another status gets `none`. */
  readonly statuses: readonly Status[];
  /** The classes, in order. The first class with a prefix of the kind applies. */
  readonly classes: readonly KindClass[];
  /** The table of each kind that no class has. */
  readonly otherwise: LevelTable;
  /** The policy of the relevance for a person with an interest graph. When it is absent, the assessment uses `DEFAULT_RELEVANCE_POLICY`. */
  readonly relevance?: RelevancePolicy;
}

/**
 * A rule of a person: the highest level of the incidents of some kinds at some places. At each
 * place, the first rule that matches the place and the kind applies. With no matching rule, the
 * table level stays.
 */
export interface LevelRule {
  /** The places of the rule. When it is absent, the rule applies at each place of the person. */
  readonly places?: readonly PlaceId[];
  /** The prefixes of the taxonomy codes of the rule. When it is absent, the rule applies to each kind. */
  readonly kinds?: readonly string[];
  /**
   * The kinds of the entries of the rule. The rule matches an incident only through an entry of one of these kinds. A
   * watched place is an entry of the kind `place`. A watched subject has the kind of its system, or `entity`. When it
   * is absent, the rule matches through each entry.
   *
   * An example is a rule with `through: ["topic"]` for the outages of online services. It lowers an outage that
   * reaches the person only through a topic of the work. An outage of a service that the person names keeps its level.
   */
  readonly through?: readonly SubjectKind[];
  readonly max: AssessedLevel;
}

/**
 * The quiet window of a person: a part of each day, in local times of a time zone. In the window,
 * each message below `life-safety` is quiet. A `life-safety` message ignores the window. The shape
 * is that of `TimeWindow` of `@mark1russell7/algebra/clock`, without the days of the week.
 */
export interface QuietWindow {
  /** The IANA name of the time zone, for example `Europe/Berlin`. */
  readonly zone: string;
  /** The start of the window, a local time `HH:MM` from `00:00` to `23:59`. The start is in the window. */
  readonly start: string;
  /** The end of the window, a local time `HH:MM`. The end is not in the window. An end before the start crosses midnight. An end equal to the start gives the full day. */
  readonly end: string;
}

/**
 * A subject that a person watches, other than a place: a source of the system, a service, a cloud
 * region. A watch with no id matches each subject of its system.
 */
export interface SubjectWatch {
  readonly system: string;
  readonly id?: string;
}

/** The places and the rules of one person. The private configuration gives them. */
export interface PersonWatch {
  readonly person: PersonId;
  /** The places that the person watches. */
  readonly places: readonly PlaceId[];
  /**
   * The subjects that the person watches. The health reports of the sources have the subjects of
   * the system `alerts.source`. The quota and balance reports have the subjects of the system `alerts.channel`. So the
   * person who operates the system watches `{ system: "alerts.source" }` and `{ system: "alerts.channel" }`.
   */
  readonly subjects?: readonly SubjectWatch[];
  /** The rules of the person, in order. */
  readonly rules: readonly LevelRule[];
  /** The quiet window of the person. When it is absent, no message is quiet. */
  readonly quiet?: QuietWindow;
  /**
   * The interest graph of the person (`docs/RELEVANCE.md`). With a graph, a place or another entry of an incident
   * counts only when the entry reaches the person. With no graph, each place in the areas counts.
   */
  readonly interests?: InterestGraph;
  /**
   * The rules of the life-safety warnings at the places of the person, one rule for each place at most. A place
   * with no rule has the rule on, and its range is the buffer of the place.
   */
  readonly mandatory?: readonly MandatoryRule[];
}

/**
 * The rule of the life-safety warnings at one place of a person. When the rule is on, a warning of the level
 * `life-safety` at the place in the range always counts. An edge that is off does not stop it, and a mute makes it
 * silent under the policy `silent` of the relevance.
 */
export interface MandatoryRule {
  readonly place: PlaceId;
  /** False when the person turned the rule off at this place. */
  readonly on: boolean;
  /**
   * The range in kilometers. A match by a shape at this distance from the place or nearer is in the range. A match by
   * the codes or by the id of the place is always in the range.
   */
  readonly rangeKm: number;
}

/** A measured value with its interval. The interval holds the value: `low <= value <= high`. */
export interface Estimate {
  readonly value: number;
  readonly low: number;
  readonly high: number;
}

/**
 * The priors of one kind of event, from public measures. A field that the measures do not give is
 * absent. Then the shadow score of the kind has no read.
 */
export interface KindPrior {
  /** The share of the warnings of the kind that an event verified, from 0 to 1. It applies to the significance `warning` only. */
  readonly verified?: Estimate;
  /** The deaths in one event of the kind. */
  readonly deaths?: Estimate;
  /** The injuries in one event of the kind. */
  readonly injuries?: Estimate;
  /** The harm in one area under one active alert of the kind, for each significance with a measure. */
  readonly under?: Readonly<Partial<Record<Significance, UnderPrior>>>;
}

/** The kinds of area of an alert: a county, or a forecast zone. */
export type AlertArea = "county" | "zone";

/**
 * The harm in one area under one active alert of a kind and a significance. An area is one alert in one county or one
 * zone. The measure counts each event under an active alert. Thus it holds the probability of the event.
 */
export interface UnderPrior {
  /** The deaths in one area under one alert. */
  readonly deaths: Estimate;
  /** The injuries in one area under one alert. */
  readonly injuries: Estimate;
  /** The kind of area of the measure. The measure takes the kind of area that has most of the events of the kind. */
  readonly area: AlertArea;
}

/**
 * The priors of the shadow score. Each factor comes from a public measure, not from a guess. The
 * format of the file is `alerts-priors/2`. Format 2 adds the harm under an active alert (`KindPrior.under`).
 */
export interface ScorePriors {
  readonly format: "alerts-priors/2";
  /** The priors of the kinds, by prefixes of the taxonomy codes. For each field, the longest prefix of a kind with that field decides. */
  readonly kinds: Readonly<Record<string, KindPrior>>;
  /** The probability of each CAP certainty value, from 0 to 1. */
  readonly certainty: Readonly<Partial<Record<Certainty, Estimate>>>;
}

/**
 * The source of a factor of a shadow score in the priors.
 *
 * - The table `kinds` has a prefix of the kind as its key. The table `certainty` has a CAP certainty value.
 * - The table `under` has a prefix of the kind, the significance and the kind of area of the measure.
 */
export type ScoreSource =
  | { readonly table: "kinds" | "certainty"; readonly key: string }
  | { readonly table: "under"; readonly key: string; readonly significance: Significance; readonly area: AlertArea };

/** One factor of a shadow score, with the key of the priors that gave it. */
export interface ScoreFactor {
  readonly estimate: Estimate;
  /** The table of the priors and its key. */
  readonly from: ScoreSource;
}

/**
 * The expected harm of an incident in one area. The basis `event` gives the probability of the event times the
 * deaths and the injuries of one event. Then each interval holds each product of a point of the two intervals.
 */
export interface ExpectedHarm {
  readonly deaths: Estimate;
  readonly injuries: Estimate;
}

/** A factor of the shadow score that the priors do not give. */
export type ScoreGap = "probability" | "deaths" | "injuries";

/**
 * The shadow score of an incident. The score does not decide a level at this time. The table decides, and the
 * assessment shows the score next to it.
 *
 * - The basis `event` is the probability of the event times the harm of one event.
 * - The basis `alert` is the harm in one area under one active alert of the kind and the significance.
 * - A score with a gap has no read, and it shows each factor that the priors do not give.
 */
export type ShadowScore =
  | {
      readonly read: true;
      /**
       * The basis of the score. A score of a log line from before the basis `alert` has no field `basis`. Its basis is
       * `event`.
       */
      readonly basis?: "event";
      /** The probability that the event occurs. */
      readonly probability: ScoreFactor;
      /** The deaths in one event of the kind. */
      readonly deaths: ScoreFactor;
      /** The injuries in one event of the kind. */
      readonly injuries: ScoreFactor;
      /** The probability times the deaths and the injuries of one event. */
      readonly expected: ExpectedHarm;
    }
  | {
      readonly read: true;
      readonly basis: "alert";
      /** The deaths in one area under one alert, from the table `under`. */
      readonly deaths: ScoreFactor;
      /** The injuries in one area under one alert, from the table `under`. */
      readonly injuries: ScoreFactor;
      /** The expected harm. It is the estimate of each factor, because the measure holds the probability of the event. */
      readonly expected: ExpectedHarm;
    }
  | { readonly read: false; readonly missing: readonly ScoreGap[] };

/** An incident with its level from the table and its shadow score, as the map gives it. */
export interface ScoredIncident {
  readonly anchor: ReportId;
  readonly level: AssessedLevel;
  /** The shadow score of the incident. An incident with no score is in no difference. */
  readonly shadow?: ShadowScore;
}

/**
 * A difference between the table and the shadow score. The table gives `above` a higher level than `below`.
 * The score gives `below` more expected deaths and more expected injuries, and the intervals do not overlap.
 */
export interface ShadowDifference {
  /** The incident with the higher level of the table. */
  readonly above: ReportId;
  /** The incident with the higher shadow score. */
  readonly below: ReportId;
}

/** A reason of an assessment. The UI shows the reasons, so each level tells why. */
export type AssessReason =
  /** Each line of the incident is cancelled or expired. */
  | { readonly kind: "ended" }
  /** The policy does not send incidents of this status. */
  | { readonly kind: "status"; readonly status: Status }
  /** No place of the person is in the areas of the incident. */
  | { readonly kind: "no-place" }
  /** The incident has no area, and the person watches no subject of the incident. */
  | { readonly kind: "no-subject" }
  /** The incident is private (AL-92), and the person is not in its addresses. */
  | { readonly kind: "not-addressed" }
  /** The incident is private, and the person is in its addresses. The places and the subjects do not count. */
  | { readonly kind: "addressed" }
  /**
   * The areas of the incident have no code and no place, and no shape can match. Either the areas have
   * no shape, or no place of the person has a position.
   */
  | { readonly kind: "no-codes" }
  /** The configuration has no watched place for this id of the person. */
  | { readonly kind: "unknown-place"; readonly place: PlaceId }
  /**
   * An area of the incident covers this place. The codes are the codes of the place that decided the match.
   * `distanceKm` is the distance from the place to the nearest shape that decided, and it is 0 in a shape.
   * It is present when that distance is in the buffer of the place. For a match by a shape only, the codes
   * are empty. `shapeRefused` is true when the codes of a block decided because `@mark1russell7/geo`
   * refuses each shape of that block. `zoneFallback` is true when a fire zone code of an area decided through the
   * forecast zone code of the place with the same code. Then the place has no fire zone code of that state.
   */
  | {
      readonly kind: "place";
      readonly place: PlaceId;
      readonly codes: readonly RegionCode[];
      readonly distanceKm?: number;
      readonly shapeRefused?: true;
      readonly zoneFallback?: true;
    }
  /** The person watches a subject of the incident. */
  | { readonly kind: "subject"; readonly subject: SubjectWatch }
  /**
   * The level of the table at this place is not the level of the incident. The lines of these reports hold the
   * place, and the highest table of those lines gives the level.
   */
  | { readonly kind: "place-table"; readonly place: PlaceId; readonly reports: readonly ReportId[]; readonly level: AssessedLevel }
  /** The table gave this level. The class is absent for the table `otherwise`. */
  | {
      readonly kind: "table";
      readonly class?: string;
      readonly bySeverity: AssessedLevel;
      readonly byUrgency: AssessedLevel;
      readonly level: AssessedLevel;
      /** This value is true when the urgency `past` counted as `immediate` in the window `pastWithin` of the table. */
      readonly recentPast?: true;
      /**
       * This value is true when the table is the quiet table of the sources of other copies (AL-76). The kind has no
       * class, and this copy runs no source of the incident.
       */
      readonly foreign?: true;
    }
  /**
   * A rule of the person lowered the level at this place. The index is the position of the rule.
   * The place is absent for a subject.
   */
  | { readonly kind: "rule"; readonly place?: PlaceId; readonly index: number; readonly max: AssessedLevel }
  /** The shadow score of the incident. It does not change the level. */
  | { readonly kind: "shadow"; readonly score: ShadowScore }
  /**
   * The relevance of the incident over the interest graph of the person. `reached` holds the entries that reach the
   * person alone: the places, the areas, the subjects and the topic, in this order. `mandatory` holds the places
   * where the rule of the life-safety warnings keeps the level. `entryLevel` is present when an entry that is not a
   * watched place reaches the person. It is the level of the table, up to `entryMax` of the policy, before the rules. The why comes from the strongest path.
   */
  | {
      readonly kind: "reach";
      readonly reach: Estimate;
      readonly reached: readonly NodeKey[];
      readonly mandatory: readonly PlaceId[];
      readonly entryLevel?: AssessedLevel;
      readonly why?: WhyRecord;
    }
  /** The relevance failed, so the places in the areas decided, as for a person with no graph. The message tells the fault. */
  | { readonly kind: "relevance-fault"; readonly message: string };

/** The level of one incident for one person, with its reasons. */
export interface Assessment {
  /** The anchor of the incident at the time of the assessment. */
  readonly incident: ReportId;
  readonly person: PersonId;
  readonly level: AssessedLevel;
  /** The places of the person that the areas of the incident contain. */
  readonly places: readonly PlaceId[];
  readonly reasons: readonly AssessReason[];
  /**
   * The mute of the person that matches the incident, and its effect: the field `muted` of the relevance. With the
   * effect `absent`, the incident does not reach the person. With `silent`, the level stays, and `route` sends one quiet
   * message at most.
   */
  readonly muted?: { readonly mute: string; readonly effect: MuteEffect };
}

// =============================================================================
// Relevance: how much an incident touches one person (AL-35, `docs/RELEVANCE.md`)
// =============================================================================

/** The three kinds of the subjects of an incident. */
export type SubjectKind = "place" | "topic" | "entity";

/**
 * A system of the ids of subjects. The system `place` holds the watched places of a person. The system
 * `topic` holds the codes of the taxonomy and their prefixes.
 */
export type SubjectSystem =
  | "place"
  | "point"
  | "polygon"
  | "ugc"
  | "ugc-fire"
  | "same"
  | "fips"
  | "state"
  | "iso3166"
  | "geonames"
  | "icao"
  | "topic"
  | "iptc"
  | "cap-category"
  | "cve"
  | "wikidata"
  | "asn"
  | "domain"
  | "provider-region"
  | "ticker"
  | "lei"
  | "purl";

/**
 * The kind of the subjects of each system. The list is closed. A new system comes with the first source or
 * default that gives its ids.
 */
export const SUBJECT_SYSTEMS: Readonly<Record<SubjectSystem, SubjectKind>> = {
  place: "place",
  point: "place",
  polygon: "place",
  ugc: "place",
  "ugc-fire": "place",
  same: "place",
  fips: "place",
  state: "place",
  iso3166: "place",
  geonames: "place",
  icao: "place",
  topic: "topic",
  iptc: "topic",
  "cap-category": "topic",
  cve: "entity",
  wikidata: "entity",
  asn: "entity",
  domain: "entity",
  "provider-region": "entity",
  ticker: "entity",
  lei: "entity",
  purl: "entity",
};

/**
 * The key of a node of an interest graph: `person`, or `<system>:<id>` with a system of `SUBJECT_SYSTEMS`.
 * Examples are `place:home`, `ugc:KSC173`, `topic:infra.power.outage` and `domain:example.com`. The id is the
 * text after the first colon, thus an id can hold a colon, as in `purl:pkg:npm/example`.
 */
export type NodeKey = string;

/**
 * The kind of an edge. The first four are the kinds of dependency of Rinaldi, Peerenboom and Kelly (2001). An
 * edge of the kind `interest` goes into the person.
 */
export type EdgeKind = "physical" | "cyber" | "geographic" | "logical" | "interest";

/**
 * The origin of the weight of an edge. Each origin except `person` is one layer of the defaults.
 * - `base`: the human base, the same for each person.
 * - `places`: the watched places of the person.
 * - `services`: the services that the person names.
 * - `delivery`: the services of the channels of the person (`ChannelDescriptor.services`).
 * - `work`: the tools and the services of a kind of work.
 * - `data`: public data, for example the service area of a power utility.
 * - `measured`: a measure of the system, for example the DNS providers of a domain.
 * - `person`: the person set the value. No default replaces it.
 */
export type EdgeOrigin = "base" | "places" | "services" | "delivery" | "work" | "data" | "measured" | "person";

/** One edge of an interest graph: the cause at `from` can impair the node at `to`, with a chance. */
export interface InterestEdge {
  /** The id of the edge. The exact sum expands the edges in the order of their ids, thus the order of a file has no effect. */
  readonly id: string;
  /** The cause. It is not `person`. */
  readonly from: NodeKey;
  /** The node that the cause can impair, or `person`. */
  readonly to: NodeKey;
  readonly kind: EdgeKind;
  /**
   * The chance that an effect passes along the edge, from 0 to 1. The interval is the doubt of a default. An
   * unknown edge gets a wide interval, not 0. For a supply with a backup, the weight is the need times the
   * chance that an outage lasts longer than the backup.
   */
  readonly weight: Estimate;
  readonly origin: EdgeOrigin;
  /** The data or the measure that gave the weight, for example `eia-861/2025`. */
  readonly source?: string;
  /** The day of the source or of the choice of the person, `YYYY-MM-DD`. */
  readonly date?: string;
  /** False when the person turned the route off. The edge stays in the graph as a row, and the reach does not use it. */
  readonly on: boolean;
}

/**
 * A mute of a person. An incident matches when its kind has a prefix in `kinds`, and an entry of the incident
 * is in `subjects`. An absent list matches each incident. A mute has one list or both. A matched incident does
 * not reach the person on any path, except an incident of the mandatory class (`RelevancePolicy`).
 */
export interface Mute {
  readonly id: string;
  /** The prefixes of the taxonomy codes, as in `LevelRule`. */
  readonly kinds?: readonly string[];
  /** The subjects of the incidents that the mute matches. */
  readonly subjects?: readonly NodeKey[];
  /** The mute has effect until this time. With no end, it has effect until the person removes it. */
  readonly until?: Instant;
  /** The day that the person set the mute, `YYYY-MM-DD`. */
  readonly date: string;
}

/**
 * The interest graph of one person, the format `alerts-interest/1`. The file is private configuration. The
 * repository holds the model, the taxonomy and the defaults from public data, and no graph of a real person.
 */
export interface InterestGraph {
  readonly format: "alerts-interest/1";
  readonly person: PersonId;
  readonly edges: readonly InterestEdge[];
  readonly mutes: readonly Mute[];
  /** The private labels of the nodes, for the text of an alert. The why record holds only the keys. */
  readonly labels?: Readonly<Record<NodeKey, string>>;
}

/** A subject of an incident that is a node of the graph of a person. */
export interface SubjectEntry {
  readonly node: NodeKey;
  readonly kind: SubjectKind;
  /**
   * The chance that the incident hits the subject when the event is real. It is the share of the area near a
   * place for a place, and 1 for a topic or a named entity.
   */
  readonly hit: Estimate;
}

/** One path from a subject of an incident to the person. */
export interface RelevancePath {
  readonly subject: NodeKey;
  /** The ids of the edges of the path, in order from the subject. */
  readonly edges: readonly string[];
  /** The chance that each part of the path is on: the hit chance times the weight of each edge. */
  readonly chance: number;
}

/**
 * The record of why an incident reaches a person. The delivery puts it in the text of each channel. It holds
 * keys and no labels, and the runtime gives the private labels.
 */
export interface WhyRecord {
  /** A stable id of the reason, `reach.<subject kind>.<origin>`, for example `reach.place.base`. */
  readonly rule: string;
  readonly subject: NodeKey;
  readonly kind: SubjectKind;
  /** The first node after the subject, when the path has two nodes or more between the subject and the person. */
  readonly via?: NodeKey;
  /** The last node before the person: the place, the service or the topic of the interest. */
  readonly anchor: NodeKey;
  /** The origin of the last edge of the path, the interest edge. */
  readonly origin: EdgeOrigin;
  /** The reach of the shown paths alone, divided by the full reach, from 0 to 1. */
  readonly coverage: number;
}

/** The effect of a mute on an incident: it does not reach the person, or it reaches the person with no sound. */
export type MuteEffect = "absent" | "silent";

/** The policy of the relevance. */
export interface RelevancePolicy {
  /** The most edges of a path. A longer path does not count. */
  readonly hopCap: number;
  /** The most paths in a relevance, from the strongest. */
  readonly topPaths: number;
  /** The effect of a mute on an incident of the mandatory class. A mute removes each other incident that it matches. */
  readonly mandatory: MuteEffect;
  /**
   * The highest level of an incident that reaches the person only through entries that are not watched places. The
   * level `life-safety` needs a place of the person. When it is absent, the assessment uses `DEFAULT_ENTRY_MAX`.
   */
  readonly entryMax?: AssessedLevel;
}

/** The relevance of an incident for one person. */
export interface Relevance {
  /**
   * The reach: the chance that at least one path from a subject of the incident to the person is fully on.
   * The value comes from the point weights. The interval comes from the ends of the intervals of the weights.
   */
  readonly reach: Estimate;
  /** The lower bound at the point weights: the chance of the best path. */
  readonly best: number;
  /** The upper bound at the point weights: noisy-OR over the paths. */
  readonly noisyOr: number;
  /** The strongest paths, from the strongest. */
  readonly paths: readonly RelevancePath[];
  /** The why, from the strongest path. It is absent when no path reaches the person. */
  readonly why?: WhyRecord;
  /** The edge with the largest Birnbaum importance: the reach with the edge on, minus the reach with the edge off. */
  readonly weakest?: { readonly edge: string; readonly importance: number };
  /** The edge to ask the person about: the largest importance times the width of the weight interval, of the edges with a default weight. */
  readonly next?: { readonly edge: string; readonly gain: number };
  /** The mute that matched, and its effect. When the effect is `absent`, the reach is 0 and the relevance has no path. */
  readonly muted?: { readonly mute: string; readonly effect: MuteEffect };
  /**
   * The kind of the result when the budget of steps ended the exact sum. With `bounds`, the reach is noisy-OR, a
   * ceiling. With `partial`, the path search did not end, and the ceiling is 1. An exact result has no field.
   */
  readonly bound?: "bounds" | "partial";
}
