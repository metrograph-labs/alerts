/**
 * The runtime schemas of the contracts, in zod 4. Each schema checks one data type of `contracts.ts`
 * or `lateness.ts` at a trust boundary. The boundaries are the output of a map function, the event
 * log, the private configuration and the procedure tools.
 *
 * - The TypeScript types stay the source of truth. `schemaOf` holds each schema to its type, so a
 *   drift fails the type check.
 * - Each object is strict, so an unknown key fails. The contract is closed, as the taxonomy is.
 * - Each schema has no transform, so `z.toJSONSchema` converts it. The MCP tools use the JSON Schema.
 * - The rules of the values that a type cannot hold are refinements. Each rule tells the line of the
 *   contract that states it.
 */
import { tryParseUnit } from "@mark1russell7/quantity";
import { z } from "zod";
import {
  ASSESSED_LEVELS,
  CELL_RESOURCES,
  DIMENSION_IDS,
  INDICATOR_AREA_KINDS,
  LEVELS,
  MOVES,
  OWN_BASELINES,
  type Acknowledgment,
  type Address,
  type AddressField,
  type Area,
  type AssessedLevel,
  type AssessPolicy,
  type AssessReason,
  type Assessment,
  type BalanceRead,
  type BalanceStage,
  type CanaryResult,
  type Category,
  type CellResource,
  type Certainty,
  type ChannelDescriptor,
  type ChannelFailureKind,
  type ChannelId,
  type ChannelQuota,
  type CopyRead,
  type CopyStage,
  type CorrelationKey,
  type Coverage,
  type Cursor,
  type Delivery,
  type DimensionId,
  type DeliveryState,
  type DeliveryStatus,
  type EndMark,
  type Estimate,
  type ExpectedHarm,
  type Duration,
  type EscalationPolicy,
  type EscalationStep,
  type FetchFailure,
  type FetchOutcome,
  type FetchRecord,
  type HealthState,
  type Id,
  type Incident,
  type IndicatorArea,
  type IndicatorAreaKind,
  type IncidentLine,
  type Instant,
  type Kind,
  type KindClass,
  type AlertArea,
  type KindPrior,
  type Level,
  type MeasureDeclaration,
  type Move,
  type LevelRule,
  type LevelTable,
  type LocateOutcome,
  type MandatoryRule,
  type MapProblem,
  type MapResult,
  type Message,
  type Observation,
  type ObservationId,
  type Operation,
  type PersonId,
  type PersonWatch,
  type PlaceId,
  type OwnBaseline,
  type Position,
  type Reading,
  type ProviderBalance,
  type QuietWindow,
  type QuotaStage,
  type Receipt,
  type RegionCode,
  type Report,
  type ReportId,
  type ResponseType,
  type ScoreFactor,
  type ScorePriors,
  type ScoreRule,
  type SendOutcome,
  type Severity,
  type ShadowScore,
  type Significance,
  type UnderPrior,
  type SourceDescriptor,
  type SourceHealth,
  type SourceId,
  type Status,
  type Subject,
  type SubjectWatch,
  type Transport,
  type Urgency,
  type Watch,
  SUBJECT_SYSTEMS,
  type EdgeKind,
  type EdgeOrigin,
  type InterestEdge,
  type InterestGraph,
  type Mute,
  type MuteEffect,
  type NodeKey,
  type Relevance,
  type RelevancePath,
  type RelevancePolicy,
  type SubjectEntry,
  type SubjectKind,
  type WhyLimit,
  type WhyRecord,
  type WatchedPlace,
  type ContactServices,
} from "./contracts.ts";
import { MEASURE_ID, SERIES_VERSION } from "./indicators.ts";
import { err, ok, tryCatch, type Result } from "@mark1russell7/optional";
import { compareCodeUnits } from "@mark1russell7/text/order";
import {
  CONFIG_FORMAT,
  CONFIG_PART_FORMAT,
  BILLING_FIELD,
  COPY_FORMAT,
  copyProblems,
  DRIFT_COMMAND_KINDS,
  DRIFT_NAME,
  LIMIT_ACCOUNT_KINDS,
  loadConfig,
  mergeParts,
  partLabel,
  type AddressValue,
  type AlertConfig,
  type ConfigPart,
  type ContactConfig,
  type NamedPart,
  type CopyBillingConfig,
  type CopyListen,
  type CopyPeer,
  type CopySettings,
  type DriftCommandConfig,
  type DriftConfig,
  type ExpectationConfig,
  type OutageConfig,
  type OutagePersonConfig,
  type PersonConfig,
  type InterestDefaultsConfig,
  type LimitConfig,
  type ChainConfig,
  type ChainSubject,
  type PlaceConfig,
  type SecretLookup,
  type SpendConfig,
  type SecretRef,
  type TellConfig,
  type TellSite,
} from "./config.ts";
import type { TryChain } from "./chain.ts";
import type { ChannelDownConfig, ChannelRun } from "./channel-down.ts";
import type { SourceClearConfig } from "./system-reports.ts";
import type { SendLimitConfig } from "./send-limit.ts";
import type { ThrottleConfig } from "./throttle.ts";
import type { EscalationEnd, Recipient } from "./delivery.ts";
import type { DrillConfig, DrillPath } from "./drill.ts";
import { OPT_IN_WAYS, type OptInConfig, type OptInRecord } from "./opt-in.ts";
import type { RankDelays } from "./escalation.ts";
import { HEALTH_FORMAT, type BalanceHealth, type ChannelHealth, type CopyHealth, type HealthPayload, type QuotaHealth, type ReadHealth, type SourceHealthView } from "./health-payload.ts";
import type { InterestRow } from "./interest-defaults.ts";
import { INTERESTS_FORMAT, type InterestsPayload, type InterestsPerson } from "./interests-payload.ts";
import { HISTORY_FORMAT, type HistoryChange, type HistoryIncident, type HistoryPayload, type HistoryPlace, type HistoryRegion } from "./history.ts";
import type { MapShape } from "./map.ts";
import type { Lateness, LatenessLimit, LatenessState } from "./lateness.ts";
import type { LinkFamily, LinkPolicy } from "./link.ts";
import { COVERAGE_KIND } from "./assess.ts";
import { canonicalKind, CATEGORIES, KIND_ALIASES, knownKind, TAXONOMY } from "./taxonomy.ts";

// =============================================================================
// The gate between a schema and its type
// =============================================================================

// This type removes the intersections and the names of the interfaces. It keeps the readonly keys and the optional keys.
type Plain<T> = T extends string | number | boolean | null | undefined ? T : { [K in keyof T]: Plain<T[K]> };

// This type is true when the two types are the same after `Plain`. The comparison of two generic functions finds each difference of a readonly key or an optional key.
type Same<A, B> = (<G>() => G extends Plain<A> ? 1 : 2) extends <G>() => G extends Plain<B> ? 1 : 2 ? true : false;

/** This type is the error of `schemaOf`. The type check shows its key when a schema does not match its type. */
export interface SchemaDrift<T> {
  readonly "The output or the input of this schema is not exactly its type.": T;
}

// This type is `unknown` when the output and the input of the schema are exactly the type. Else it is the error.
type Exact<S extends z.ZodType, T> = Same<z.output<S>, T> extends true ? (Same<z.input<S>, T> extends true ? unknown : SchemaDrift<T>) : SchemaDrift<T>;

/**
 * This function gives a schema the type of its contract. The type check fails when the output or the
 * input of the schema is not exactly the type `T`. The readonly keys and the optional keys must also
 * be the same. The function changes nothing at run time.
 *
 * The package checks its declarations in isolation. Thus each exported schema has the short type
 * `z.ZodType<T, T>`. This function compares the full type of the schema to `T` first.
 */
export function schemaOf<T>(): <S extends z.ZodType<T, T>>(schema: S & Exact<S, T>) => z.ZodType<T, T> {
  return (schema) => schema;
}

// The brand of `contracts.ts` is a `unique symbol` of the types only, and `.brand()` of zod has a different symbol.
// So this cast gives the non-empty string schema the branded type of the id. It is the one cast of this file.
function idSchema<T extends Id<string>>(): z.ZodType<T, T> {
  const nonEmpty: z.ZodType<string, string> = z.string().min(1, "An id is a non-empty string.");
  return nonEmpty as z.ZodType<T, T>;
}

// =============================================================================
// Time, ids and counts
// =============================================================================

/** This schema checks a time in milliseconds since the epoch. A zod number is finite, so it refuses `Infinity` and `NaN`. */
export const instantSchema: z.ZodType<Instant, Instant> = schemaOf<Instant>()(z.number());

/** This schema checks a length of time in milliseconds. A duration is finite, and it is 0 or more. */
export const durationSchema: z.ZodType<Duration, Duration> = schemaOf<Duration>()(z.number().nonnegative("A duration is 0 or more."));

/** This schema checks the id of a source adapter. */
export const sourceIdSchema: z.ZodType<SourceId, SourceId> = idSchema<SourceId>();
/** This schema checks the id of a delivery channel. */
export const channelIdSchema: z.ZodType<ChannelId, ChannelId> = idSchema<ChannelId>();
/** This schema checks the id of an observation. */
export const observationIdSchema: z.ZodType<ObservationId, ObservationId> = idSchema<ObservationId>();
/** This schema checks the id of a report. */
export const reportIdSchema: z.ZodType<ReportId, ReportId> = idSchema<ReportId>();
/** This schema checks the id of a person. */
export const personIdSchema: z.ZodType<PersonId, PersonId> = idSchema<PersonId>();
/** This schema checks the id of a place. */
export const placeIdSchema: z.ZodType<PlaceId, PlaceId> = idSchema<PlaceId>();

// A count and an index are integers, 0 or more. The fields that use it state a count or a position in words.
const count = (): z.ZodInt => z.int().nonnegative("A count is an integer, 0 or more.");

// =============================================================================
// The event
// =============================================================================

/** This schema checks a CAP status. */
export const statusSchema: z.ZodType<Status, Status> = schemaOf<Status>()(z.enum(["actual", "exercise", "system", "test", "draft"]));

/** This schema checks a CAP message type, without `ack` and `error`. */
export const operationSchema: z.ZodType<Operation, Operation> = schemaOf<Operation>()(z.enum(["alert", "update", "cancel"]));

/** This schema checks a CAP severity. */
export const severitySchema: z.ZodType<Severity, Severity> = schemaOf<Severity>()(z.enum(["extreme", "severe", "moderate", "minor", "unknown"]));

/** This schema checks a CAP urgency. */
export const urgencySchema: z.ZodType<Urgency, Urgency> = schemaOf<Urgency>()(z.enum(["immediate", "expected", "future", "past", "unknown"]));

/** This schema checks a CAP certainty. */
export const certaintySchema: z.ZodType<Certainty, Certainty> = schemaOf<Certainty>()(z.enum(["observed", "likely", "possible", "unlikely", "unknown"]));

/** This schema checks a CAP response type. */
export const responseTypeSchema: z.ZodType<ResponseType, ResponseType> = schemaOf<ResponseType>()(
  z.enum(["shelter", "evacuate", "prepare", "execute", "avoid", "monitor", "assess", "allclear", "none"]),
);

/** This schema checks a category. The values come from `CATEGORIES` of the taxonomy. */
export const categorySchema: z.ZodType<Category, Category> = schemaOf<Category>()(z.enum(CATEGORIES));

/** This schema checks the stage of a hazard message. */
export const significanceSchema: z.ZodType<Significance, Significance> = schemaOf<Significance>()(
  z.enum(["warning", "watch", "advisory", "statement", "outlook", "observation"]),
);

// Each code that `kindCodeSchema` takes, sorted: each code of `TAXONOMY`, each old code, and the coverage form of
// each, when the rule of the schema takes it. The rule is the one test, so the list and the parse agree. A test
// gives its own old codes with a mock of the taxonomy, so the list reads `KIND_ALIASES` here.
const kindCodes = (): string[] => {
  const codes = [...Object.keys(TAXONOMY), ...Object.keys(KIND_ALIASES)];
  const takes = (code: string): boolean => knownKind(canonicalKind(code));
  const all = new Set([...codes, ...codes.map((code) => `${COVERAGE_KIND}.${code}`)].filter(takes));
  return [...all].sort(compareCodeUnits);
};

/**
 * This schema checks a code of the taxonomy, or a prefix of a code by its parts. `knownKind` is the one rule:
 * a prefix by parts is also a code, so `met` and `met.flood` pass and `met.fl` does not. A kind with a typo
 * matches no alert, so this rule holds for each kind that a person or an adapter names. The parse first
 * changes an old code to its new code (`canonicalKind`). This change is not a transform, so the JSON Schema stays.
 *
 * The JSON Schema is an enum of each code that the rule takes. zod puts it one time in `$defs`, with the id `KindCode`.
 * The schema stays a string schema and not `z.enum`, because zod makes a record with enum keys need each key.
 */
export const kindCodeSchema: z.ZodType<string, string> = z
  .string()
  .overwrite((code) => canonicalKind(code))
  .refine(knownKind, "The kind code is not in the taxonomy.")
  .meta({ id: "KindCode", description: "A code of the taxonomy, an old code, or the coverage form of one of them.", enum: kindCodes() });

// The prefix of a topic key, and the problem of a topic id that is not a code of the taxonomy.
const TOPIC_PREFIX = "topic:";
const TOPIC_PROBLEM = "The id of a topic is a code of the taxonomy, or a prefix of one by its parts.";
// A topic key with an old code changes to the key of its new code. Each other key stays.
const canonicalKey = (key: string): string => (key.startsWith(TOPIC_PREFIX) ? `${TOPIC_PREFIX}${canonicalKind(key.slice(TOPIC_PREFIX.length))}` : key);

/** This schema checks a kind. Its code must be in the taxonomy: `knownKind` gives true. This rule is the runtime gate of the closed taxonomy. */
export const kindSchema: z.ZodType<Kind, Kind> = schemaOf<Kind>()(
  z
    .strictObject({
      code: kindCodeSchema,
      significance: significanceSchema.exactOptional(),
      label: z.string(),
    })
    .readonly(),
);

/** This schema checks a position: the longitude in [-180, 180], then the latitude in [-90, 90]. */
export const positionSchema: z.ZodType<Position, Position> = schemaOf<Position>()(
  z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]).readonly(),
);

/** This schema checks the code of a region in one system of codes. */
export const regionCodeSchema: z.ZodType<RegionCode, RegionCode> = schemaOf<RegionCode>()(
  z.strictObject({ system: z.string(), code: z.string() }).readonly(),
);

// The polygon and the circle of an area. An area and a shape of the map share them.
const polygonObject = z.strictObject({
  type: z.literal("polygon"),
  rings: z.array(z.array(positionSchema).readonly()).readonly(),
  block: z.string().exactOptional(),
});
const circleObject = z.strictObject({ type: z.literal("circle"), center: positionSchema, radiusKm: z.number(), block: z.string().exactOptional() });

/** This schema checks one area of an event: a polygon, a circle, a region code or a watched place. */
export const areaSchema: z.ZodType<Area, Area> = schemaOf<Area>()(
  z
    .discriminatedUnion("type", [
      polygonObject,
      circleObject,
      z.strictObject({ type: z.literal("code"), system: z.string(), code: z.string(), block: z.string().exactOptional() }),
      z.strictObject({ type: z.literal("place"), place: placeIdSchema }),
    ])
    .readonly(),
);

/** This schema checks a thing that an event is about, other than a place. */
export const subjectSchema: z.ZodType<Subject, Subject> = schemaOf<Subject>()(
  z.strictObject({ system: z.string(), id: z.string(), label: z.string().exactOptional() }).readonly(),
);

/** This schema checks a key that two sources share for one real event. */
export const correlationKeySchema: z.ZodType<CorrelationKey, CorrelationKey> = schemaOf<CorrelationKey>()(
  z.strictObject({ system: z.string(), id: z.string() }).readonly(),
);

/** This schema checks one raw message as a source gave it. */
export const observationSchema: z.ZodType<Observation, Observation> = schemaOf<Observation>()(
  z
    .strictObject({
      id: observationIdSchema,
      source: sourceIdSchema,
      fetched: instantSchema,
      contentType: z.string(),
      body: z.string(),
      transport: z
        .strictObject({
          url: z.string().exactOptional(),
          status: z.number().exactOptional(),
          latency: durationSchema,
          etag: z.string().exactOptional(),
          lastModified: z.string().exactOptional(),
        })
        .readonly(),
    })
    .readonly(),
);

/**
 * This schema checks one report. A report has one area or more, or one subject or more. The merge
 * takes the areas of an incident from its heads. So a report with no area and no subject can empty
 * the places of a life-safety incident.
 */
export const reportSchema: z.ZodType<Report, Report> = schemaOf<Report>()(
  z
    .strictObject({
      id: reportIdSchema,
      source: sourceIdSchema,
      origin: z.string(),
      key: z.string(),
      references: z.array(z.string()).readonly(),
      correlation: z.array(correlationKeySchema).readonly(),
      status: statusSchema,
      op: operationSchema,
      kind: kindSchema,
      categories: z.array(categorySchema).readonly(),
      severity: severitySchema,
      urgency: urgencySchema,
      certainty: certaintySchema,
      response: z.array(responseTypeSchema).readonly(),
      sent: instantSchema,
      received: instantSchema,
      effective: instantSchema.exactOptional(),
      onset: instantSchema.exactOptional(),
      expires: instantSchema.exactOptional(),
      ends: instantSchema.exactOptional(),
      areas: z.array(areaSchema).readonly(),
      areaText: z.string().exactOptional(),
      about: z.array(subjectSchema).readonly(),
      addresses: z.array(personIdSchema).min(1, "A private report has one address or more.").readonly().exactOptional(),
      sender: z.string(),
      headline: z.string(),
      description: z.string().exactOptional(),
      instruction: z.string().exactOptional(),
      web: z.string().exactOptional(),
      observation: observationIdSchema,
      parameters: z.record(z.string(), z.array(z.string()).readonly()).readonly(),
    })
    // A report with no area, no subject and no address has no place: a cancel, or a space weather event of the whole
    // Earth. It reaches no person by a place. The map gives a fatal problem when it cannot read an area (AL-157).
    .readonly(),
);

// =============================================================================
// The indicator contract
// =============================================================================

/** This schema checks the id of a dimension. The values come from `DIMENSION_IDS`. */
export const dimensionIdSchema: z.ZodType<DimensionId, DimensionId> = schemaOf<DimensionId>()(z.enum(DIMENSION_IDS));

/** This schema checks the kind of the area of a measure. The values come from `INDICATOR_AREA_KINDS`. */
export const indicatorAreaKindSchema: z.ZodType<IndicatorAreaKind, IndicatorAreaKind> = schemaOf<IndicatorAreaKind>()(z.enum(INDICATOR_AREA_KINDS));

/** This schema checks the direction of a change that is a signal. The values come from `MOVES`. */
export const moveSchema: z.ZodType<Move, Move> = schemaOf<Move>()(z.enum(MOVES));

/** This schema checks the baseline that a source gives. The values come from `OWN_BASELINES`. */
export const ownBaselineSchema: z.ZodType<OwnBaseline, OwnBaseline> = schemaOf<OwnBaseline>()(z.enum(OWN_BASELINES));

/** This schema checks the area of one reading. A line has two positions or more. */
export const indicatorAreaSchema: z.ZodType<IndicatorArea, IndicatorArea> = schemaOf<IndicatorArea>()(
  z
    .discriminatedUnion("type", [
      z.strictObject({ type: z.literal("code"), system: z.string(), code: z.string() }),
      z.strictObject({ type: z.literal("point"), at: positionSchema }),
      z.strictObject({ type: z.literal("line"), path: z.array(positionSchema).min(2, "A line has two positions or more.").readonly() }),
      z.strictObject({ type: z.literal("polygon"), rings: z.array(z.array(positionSchema).readonly()).readonly() }),
      z.strictObject({ type: z.literal("zone"), system: z.string(), code: z.string() }),
      z.strictObject({ type: z.literal("world") }),
    ])
    .readonly(),
);

// A time that is more than 0. A cadence of 0 is not a cadence, and a backfill of 0 is no backfill.
const positiveDuration = z.number().positive("The time is more than 0.");

/** This schema checks one measure of a source. Its unit is in the grammar of `@mark1russell7/quantity`. */
export const measureDeclarationSchema: z.ZodType<MeasureDeclaration, MeasureDeclaration> = schemaOf<MeasureDeclaration>()(
  z
    .strictObject({
      id: z.string().regex(MEASURE_ID, "The id of a measure is small letters, digits and hyphens, with a letter first, up to 40 characters."),
      dimension: dimensionIdSchema,
      title: z.string(),
      unit: z.string().refine((unit) => tryParseUnit(unit) !== undefined, "The unit is not in the grammar of @mark1russell7/quantity."),
      area: indicatorAreaKindSchema,
      moves: moveSchema,
      baseline: ownBaselineSchema,
      cadence: positiveDuration.exactOptional(),
      delay: durationSchema.exactOptional(),
      backfill: positiveDuration.exactOptional(),
    })
    .readonly(),
);

// The measures of a source. Two measures of one source do not have one id, because a reading names its measure by the id.
const sourceMeasures = z
  .array(measureDeclarationSchema)
  .readonly()
  .refine((measures) => new Set(measures.map((measure) => measure.id)).size === measures.length, "Two measures of the source have one id.");

/** This schema checks one value of one series of a measure. The values are finite numbers. */
export const readingSchema: z.ZodType<Reading, Reading> = schemaOf<Reading>()(
  z
    .strictObject({
      source: sourceIdSchema,
      measure: z.string(),
      series: z.string().min(1, "The id of a series is not empty."),
      version: z.string().regex(SERIES_VERSION, "The version of a series is letters, digits, dots and hyphens, up to 40 characters.").exactOptional(),
      at: instantSchema,
      value: z.number(),
      area: indicatorAreaSchema,
      cadence: positiveDuration.exactOptional(),
      expected: z.number().exactOptional(),
      flagged: z.boolean().exactOptional(),
      observation: observationIdSchema,
    })
    .readonly(),
);

// =============================================================================
// The source contract
// =============================================================================

/** This schema checks how a source gives its data. */
export const transportSchema: z.ZodType<Transport, Transport> = schemaOf<Transport>()(z.enum(["poll", "stream", "push", "radio"]));

/** This schema checks a resource of the cell. The values come from `CELL_RESOURCES`. */
export const cellResourceSchema: z.ZodType<CellResource, CellResource> = schemaOf<CellResource>()(z.enum(CELL_RESOURCES));

// The failure domains outside the cell. contracts.ts, lines 240 and 476: "Do not put the resources of the cell here."
const outsideDomains = z
  .array(z.string().refine((domain) => !CELL_RESOURCES.some((resource) => resource === domain), "A resource of the cell is not a failure domain outside the cell."))
  .readonly();

// The internet link of the cell finds each host through the DNS resolver of the cell, so a use of `internet` needs `dns`.
const cellUses = z
  .array(cellResourceSchema)
  .readonly()
  .refine((uses) => !uses.includes("internet") || uses.includes("dns"), "A use of the internet needs the DNS resolver of the cell: add dns to uses.");

/** This schema checks the facts of a source. Its `dependsOn` holds no resource of the cell. */
export const sourceDescriptorSchema: z.ZodType<SourceDescriptor, SourceDescriptor> = schemaOf<SourceDescriptor>()(
  z
    .strictObject({
      id: sourceIdSchema,
      title: z.string(),
      origins: z.array(z.string()).readonly(),
      dependsOn: outsideDomains,
      uses: cellUses,
      kinds: z.array(kindCodeSchema).readonly(),
      coverage: z.union([z.array(areaSchema).readonly(), z.literal("global")]),
      transport: transportSchema,
      interval: durationSchema,
      slowAfter: durationSchema,
      maxQuiet: durationSchema.exactOptional(),
      auth: z.enum(["none", "key", "oauth"]),
      listing: z.literal("snapshot").exactOptional(),
      canary: z.string().exactOptional(),
      measures: sourceMeasures.exactOptional(),
    })
    .readonly(),
);

/** This schema checks a place that the system watches, as the adapters see it. */
export const watchedPlaceSchema: z.ZodType<WatchedPlace, WatchedPlace> = schemaOf<WatchedPlace>()(
  z
    .strictObject({
      id: placeIdSchema,
      at: positionSchema.exactOptional(),
      codes: z.array(regionCodeSchema).readonly(),
      bufferKm: z.number(),
    })
    .readonly(),
);

/** This schema checks what a fetch asks for. */
export const watchSchema: z.ZodType<Watch, Watch> = schemaOf<Watch>()(
  z.strictObject({ places: z.array(watchedPlaceSchema).readonly(), kinds: z.array(kindCodeSchema).readonly().exactOptional() }).readonly(),
);

/** This schema checks the state that a source keeps between two fetches. */
export const cursorSchema: z.ZodType<Cursor, Cursor> = schemaOf<Cursor>()(z.record(z.string(), z.string()).readonly());

/** This schema checks why a fetch failed. */
export const fetchFailureSchema: z.ZodType<FetchFailure, FetchFailure> = schemaOf<FetchFailure>()(
  z
    .discriminatedUnion("kind", [
      z.strictObject({ kind: z.enum(["network", "timeout", "server"]), message: z.string(), retryAfter: durationSchema.exactOptional() }),
      z.strictObject({ kind: z.literal("rate-limited"), message: z.string(), retryAfter: durationSchema.exactOptional() }),
      z.strictObject({ kind: z.enum(["auth", "refused"]), message: z.string() }),
    ])
    .readonly(),
);

/** This schema checks the result of one fetch. */
export const fetchOutcomeSchema: z.ZodType<FetchOutcome, FetchOutcome> = schemaOf<FetchOutcome>()(
  z
    .discriminatedUnion("ok", [
      z.strictObject({
        ok: z.literal(true),
        observations: z.array(observationSchema).readonly(),
        cursor: cursorSchema.exactOptional(),
        complete: z.boolean(),
        asOf: instantSchema.exactOptional(),
      }),
      z.strictObject({ ok: z.literal(false), failure: fetchFailureSchema }),
    ])
    .readonly(),
);

/** This schema checks a part of a message that the map function did not understand. The field `lossy` is absent or true. */
export const mapProblemSchema: z.ZodType<MapProblem, MapProblem> = schemaOf<MapProblem>()(
  z.strictObject({ path: z.string(), message: z.string(), fatal: z.boolean(), lossy: z.literal(true).exactOptional() }).readonly(),
);

/** This schema checks the result of the map function. */
export const mapResultSchema: z.ZodType<MapResult, MapResult> = schemaOf<MapResult>()(
  z
    .strictObject({
      reports: z.array(reportSchema).readonly(),
      problems: z.array(mapProblemSchema).readonly(),
      readings: z.array(readingSchema).readonly().exactOptional(),
    })
    .readonly(),
);

/** This schema checks the result of the canary check of a source. */
export const canaryResultSchema: z.ZodType<CanaryResult, CanaryResult> = schemaOf<CanaryResult>()(
  z.strictObject({ pass: z.boolean(), reason: z.string() }).readonly(),
);

/** This schema checks the record of one fetch. The three counts are integers, 0 or more (`contracts.ts`, lines 356, 358 and 360). */
export const fetchRecordSchema: z.ZodType<FetchRecord, FetchRecord> = schemaOf<FetchRecord>()(
  z
    .strictObject({
      source: sourceIdSchema,
      at: instantSchema,
      took: durationSchema,
      failure: fetchFailureSchema.exactOptional(),
      fresh: count(),
      fatal: count(),
      lossy: count().exactOptional(),
      canary: canaryResultSchema.exactOptional(),
    })
    .readonly(),
);

/** This schema checks the result of a lookup of the region codes of a position. */
export const locateOutcomeSchema: z.ZodType<LocateOutcome, LocateOutcome> = schemaOf<LocateOutcome>()(
  z
    .discriminatedUnion("ok", [
      z.strictObject({ ok: z.literal(true), codes: z.array(regionCodeSchema).readonly() }),
      z.strictObject({ ok: z.literal(false), failure: fetchFailureSchema }),
    ])
    .readonly(),
);

// =============================================================================
// Health and coverage
// =============================================================================

/** This schema checks the health of a source. */
export const healthStateSchema: z.ZodType<HealthState, HealthState> = schemaOf<HealthState>()(
  z.enum(["unknown", "healthy", "slow", "failing", "silent", "changed"]),
);

/** This schema checks the health of one source at one time. */
export const sourceHealthSchema: z.ZodType<SourceHealth, SourceHealth> = schemaOf<SourceHealth>()(
  z
    .strictObject({
      source: sourceIdSchema,
      state: healthStateSchema,
      since: instantSchema,
      lastSuccess: instantSchema.exactOptional(),
      lastFailure: z.strictObject({ at: instantSchema, failure: fetchFailureSchema }).readonly().exactOptional(),
      reason: z.string(),
    })
    .readonly(),
);

/** This schema checks the coverage of one kind at one place. The two counts are integers, 0 or more (`contracts.ts`, lines 416 and 432). */
export const coverageSchema: z.ZodType<Coverage, Coverage> = schemaOf<Coverage>()(
  z
    .strictObject({
      place: placeIdSchema,
      kind: z.string(),
      sources: z.array(sourceIdSchema).readonly(),
      independent: count(),
      proven: z.boolean(),
      faults: z.array(z.string()).readonly(),
      commonResources: z.array(cellResourceSchema).readonly(),
      required: count(),
    })
    .readonly(),
);

// =============================================================================
// Incidents
// =============================================================================

/**
 * This schema checks one incident. It has one report or more (`contracts.ts`, line 430). Its report ids
 * go from the smallest, each one time, and its anchor is the smallest (lines 434 and 436). The order
 * is the order of the code units, as in the merge. The corroboration is a count (line 450).
 */
/** This schema checks one line of an incident: a report that gives the values of the incident, with its areas. */
export const incidentLineSchema: z.ZodType<IncidentLine, IncidentLine> = schemaOf<IncidentLine>()(
  z
    .strictObject({
      report: reportIdSchema,
      kind: kindSchema,
      severity: severitySchema,
      urgency: urgencySchema,
      certainty: certaintySchema,
      onset: instantSchema.exactOptional(),
      areas: z.array(areaSchema).readonly(),
    })
    .readonly(),
);

export const incidentSchema: z.ZodType<Incident, Incident> = schemaOf<Incident>()(
  z
    .strictObject({
      anchor: reportIdSchema,
      reports: z.array(reportIdSchema).min(1, "An incident has one report or more.").readonly(),
      status: statusSchema,
      kind: kindSchema,
      severity: severitySchema,
      urgency: urgencySchema,
      certainty: certaintySchema,
      onset: instantSchema.exactOptional(),
      expires: instantSchema.exactOptional(),
      areas: z.array(areaSchema).readonly(),
      about: z.array(subjectSchema).readonly(),
      addresses: z.array(personIdSchema).min(1, "A private incident has one address or more.").readonly().exactOptional(),
      live: z.boolean(),
      corroboration: count(),
      lines: z.array(incidentLineSchema).min(2, "An incident with lines has two lines or more.").readonly().exactOptional(),
    })
    .readonly()
    .refine((incident) => (incident.lines ?? []).every((line) => incident.reports.includes(line.report)), {
      error: "The report of each line is a report of the incident.",
      path: ["lines"],
    })
    .refine((incident) => incident.reports[0] === incident.anchor, { error: "The anchor of an incident is its smallest report id.", path: ["anchor"] })
    .refine(
      (incident) =>
        incident.reports.every((id, index) => {
          const before = incident.reports[index - 1];
          return before === undefined || before < id;
        }),
      { error: "The report ids of an incident go from the smallest, each one time.", path: ["reports"] },
    ),
);

// =============================================================================
// Delivery
// =============================================================================

/** This schema checks the level of an alert. The values come from `LEVELS`. */
export const levelSchema: z.ZodType<Level, Level> = schemaOf<Level>()(z.enum(LEVELS));

/** This schema checks the limit of a why line: each limit is an integer of 1 or more. */
export const whyLimitSchema: z.ZodType<WhyLimit, WhyLimit> = schemaOf<WhyLimit>()(
  z
    .strictObject({
      chars: z.number().int().min(1).exactOptional(),
      words: z.number().int().min(1).exactOptional(),
    })
    .readonly(),
);

/** This schema checks the facts of a channel. Its `dependsOn` holds no resource of the cell. */
/** This function tells if a text is the source of a regular expression with the flag `u`. */
const isPattern = (source: string): boolean => {
  try {
    new RegExp(source, "u");
    return true;
  } catch {
    return false;
  }
};

/** This schema checks one field of the address of a channel. Its pattern is a regular expression with the flag `u`. */
export const addressFieldSchema: z.ZodType<AddressField, AddressField> = schemaOf<AddressField>()(
  z
    .strictObject({
      name: z.string().min(1, "The name of an address field is a non-empty string."),
      required: z.boolean(),
      pattern: z.string().refine(isPattern, "The pattern of an address field is a regular expression with the flag u."),
      form: z.string().min(1, "The form of an address field is a non-empty text."),
      optIn: z.boolean().exactOptional(),
    })
    .readonly(),
);

export const channelDescriptorSchema: z.ZodType<ChannelDescriptor, ChannelDescriptor> = schemaOf<ChannelDescriptor>()(
  z
    .strictObject({
      id: channelIdSchema,
      title: z.string(),
      dependsOn: outsideDomains,
      // A lazy schema: the schema of a node key comes later in this file.
      services: z.array(z.lazy(() => nodeKeySchema)).readonly().exactOptional(),
      api: z.array(z.lazy(() => nodeKeySchema)).min(1, "A list of endpoints is not empty.").readonly().exactOptional(),
      uses: cellUses,
      breaksThrough: z.boolean(),
      repeats: z.boolean(),
      ack: z.enum(["none", "poll", "callback"]),
      maxTitle: z.number(),
      maxBody: z.number(),
      costUsd: z.number().exactOptional(),
      maxInFlight: z.number().int().min(1).exactOptional(),
      exclusive: z.boolean().exactOptional(),
      why: whyLimitSchema.exactOptional(),
      address: z.array(addressFieldSchema).readonly().exactOptional(),
      ackLevels: z.array(levelSchema).readonly().exactOptional(),
    })
    .readonly()
    .refine((channel) => channel.ack !== "none" || (channel.ackLevels ?? []).length === 0, {
      error: "A channel with the ack none asks for no acknowledgment, thus it has no ackLevels.",
      path: ["ackLevels"],
    })
    // An endpoint is a service that the calls reach. Thus the delivery layer has an edge from it (AL-65).
    .refine((channel) => (channel.api ?? []).every((key) => (channel.services ?? []).includes(key)), {
      error: "Each endpoint in api is also in services.",
      path: ["api"],
    }),
);

/** This schema checks one message to one person on one channel. A `life-safety` message is not quiet (`contracts.ts`, line 516). */
export const messageSchema: z.ZodType<Message, Message> = schemaOf<Message>()(
  z
    .strictObject({
      key: z.string(),
      person: personIdSchema,
      level: levelSchema,
      title: z.string(),
      body: z.string(),
      url: z.string().exactOptional(),
      incident: reportIdSchema,
      expires: instantSchema.exactOptional(),
      quiet: z.boolean(),
      useReserve: z.boolean().exactOptional(),
      why: z.string().min(1).exactOptional(),
    })
    .readonly()
    .refine((message) => !(message.level === "life-safety" && message.quiet), {
      error: "A life-safety message is not quiet at any time.",
      path: ["quiet"],
    }),
);

/** This schema checks the address of a person on a channel. */
export const addressSchema: z.ZodType<Address, Address> = schemaOf<Address>()(z.record(z.string(), z.string()).readonly());

/** This schema checks the receipt of a sent message. */
export const receiptSchema: z.ZodType<Receipt, Receipt> = schemaOf<Receipt>()(z.record(z.string(), z.string()).readonly());

/** This schema checks the kind of a failed send (`ChannelFailureKind`). */
export const channelFailureKindSchema: z.ZodType<ChannelFailureKind, ChannelFailureKind> = schemaOf<ChannelFailureKind>()(
  z.enum(["network", "timeout", "server", "rate-limited", "reserved", "auth", "refused", "consent", "quiet", "expired"]),
);

/** This schema checks the result of a send. */
export const sendOutcomeSchema: z.ZodType<SendOutcome, SendOutcome> = schemaOf<SendOutcome>()(
  z
    .discriminatedUnion("ok", [
      z.strictObject({ ok: z.literal(true), receipt: receiptSchema, accepted: instantSchema }),
      z.strictObject({
        ok: z.literal(false),
        kind: channelFailureKindSchema,
        message: z.string(),
        retryAfter: durationSchema.exactOptional(),
      }),
    ])
    .readonly(),
);

/** This schema checks the state of a sent message. */
export const deliveryStateSchema: z.ZodType<DeliveryState, DeliveryState> = schemaOf<DeliveryState>()(
  z.enum(["accepted", "delivered", "acknowledged", "expired", "failed"]),
);

/** This schema checks the state of a sent message, as the channel tells it. */
export const deliveryStatusSchema: z.ZodType<DeliveryStatus, DeliveryStatus> = schemaOf<DeliveryStatus>()(
  z
    .strictObject({
      state: deliveryStateSchema,
      at: instantSchema,
      by: z.string().exactOptional(),
      reason: z.string().exactOptional(),
    })
    .readonly(),
);

/** This schema checks one step of an escalation. */
export const escalationStepSchema: z.ZodType<EscalationStep, EscalationStep> = schemaOf<EscalationStep>()(
  z.strictObject({ channel: channelIdSchema, at: durationSchema }).readonly(),
);

/** This schema checks one accepted send. The step is an index from 0 (`contracts.ts`, line 593). */
export const deliverySchema: z.ZodType<Delivery, Delivery> = schemaOf<Delivery>()(
  z
    .strictObject({
      key: z.string(),
      incident: reportIdSchema,
      level: levelSchema,
      person: personIdSchema,
      channel: channelIdSchema,
      step: count(),
      at: instantSchema,
      receipt: receiptSchema.exactOptional(),
    })
    .readonly(),
);

/** This schema checks an acknowledgment from a person, by a channel or the UI. */
export const acknowledgmentSchema: z.ZodType<Acknowledgment, Acknowledgment> = schemaOf<Acknowledgment>()(
  z
    .strictObject({
      incident: reportIdSchema,
      level: levelSchema,
      person: personIdSchema,
      at: instantSchema,
      via: z.union([channelIdSchema, z.literal("ui")]),
    })
    .readonly(),
);

/** This schema checks the end of the escalations of a person in an incident. An end with no reason is an end `ended`. */
export const escalationEndSchema: z.ZodType<EscalationEnd, EscalationEnd> = schemaOf<EscalationEnd>()(
  z
    .strictObject({
      incident: reportIdSchema,
      person: personIdSchema,
      at: instantSchema,
      reason: z.enum(["ended", "muted"]).exactOptional(),
    })
    .readonly(),
);

/** This schema checks an end mark of a report of a snapshot source. */
export const endMarkSchema: z.ZodType<EndMark, EndMark> = schemaOf<EndMark>()(
  z
    .strictObject({
      report: reportIdSchema,
      at: instantSchema,
      ended: z.boolean(),
      asOf: instantSchema.exactOptional(),
    })
    .readonly(),
);

// =============================================================================
// The assessment
// =============================================================================

/** This schema checks the level of an incident for a person, or `none`. The values come from `ASSESSED_LEVELS`. */
export const assessedLevelSchema: z.ZodType<AssessedLevel, AssessedLevel> = schemaOf<AssessedLevel>()(z.enum(ASSESSED_LEVELS));

// The two lookups of a table. Each lookup has a level for each value.
const severityLookup = z.record(severitySchema, assessedLevelSchema).readonly();
const urgencyLookup = z.record(urgencySchema, assessedLevelSchema).readonly();

/** This schema checks the highest levels for the severity and the urgency. Each lookup has a level for each value. */
export const levelTableSchema: z.ZodType<LevelTable, LevelTable> = schemaOf<LevelTable>()(
  z.strictObject({ severity: severityLookup, urgency: urgencyLookup, pastWithin: z.number().min(0).exactOptional() }).readonly(),
);

/**
 * This schema checks a class of kinds with its own table. Each prefix of the class must be a code of
 * the taxonomy, because each policy names only known codes (`docs/CONTRACTS.md`, line 219).
 */
export const kindClassSchema: z.ZodType<KindClass, KindClass> = schemaOf<KindClass>()(
  z
    .strictObject({
      id: z.string(),
      kinds: z.array(kindCodeSchema).readonly(),
      statuses: z.array(statusSchema).readonly().exactOptional(),
      severity: severityLookup,
      urgency: urgencyLookup,
      pastWithin: z.number().min(0).exactOptional(),
    })
    .readonly(),
);

/** This schema checks the data of the first assessment. */
export const assessPolicySchema: z.ZodType<AssessPolicy, AssessPolicy> = schemaOf<AssessPolicy>()(
  z
    .strictObject({
      statuses: z.array(statusSchema).readonly(),
      classes: z.array(kindClassSchema).readonly(),
      otherwise: levelTableSchema,
      // The schema of the relevance policy comes later in this file.
      relevance: z.lazy(() => relevancePolicySchema).exactOptional(),
      // The schema of the priors comes later in this file.
      priors: z.lazy(() => scorePriorsSchema).exactOptional(),
    })
    .readonly(),
);

/** This schema checks the score rule of a person (AL-31). The risk is a number above 0, and each prefix is a code of the taxonomy. */
export const scoreRuleSchema: z.ZodType<ScoreRule, ScoreRule> = schemaOf<ScoreRule>()(
  z.strictObject({ risk: z.number().positive(), except: z.array(kindCodeSchema).readonly().exactOptional() }).readonly(),
);

/** This schema checks the kind of a subject. */
export const subjectKindSchema: z.ZodType<SubjectKind, SubjectKind> = schemaOf<SubjectKind>()(z.enum(["place", "topic", "entity"]));

/** This schema checks a rule of a person. */
export const levelRuleSchema: z.ZodType<LevelRule, LevelRule> = schemaOf<LevelRule>()(
  z
    .strictObject({
      places: z.array(placeIdSchema).readonly().exactOptional(),
      kinds: z.array(kindCodeSchema).readonly().exactOptional(),
      through: z.array(subjectKindSchema).readonly().exactOptional(),
      max: assessedLevelSchema,
    })
    .readonly(),
);

/**
 * This schema checks the quiet window of a person. It does not check the time zone or the local
 * times. The contract gives a bad window a meaning: it makes no quiet send (`docs/CONTRACTS.md`,
 * line 278). `quietWindowProblems` finds a bad window.
 */
export const quietWindowSchema: z.ZodType<QuietWindow, QuietWindow> = schemaOf<QuietWindow>()(
  z.strictObject({ zone: z.string(), start: z.string(), end: z.string() }).readonly(),
);

/**
 * This schema checks a subject that a person watches. The id of a subject of the system `topic` is a code of
 * the taxonomy. The parse changes an old code to its new code first.
 */
export const subjectWatchSchema: z.ZodType<SubjectWatch, SubjectWatch> = schemaOf<SubjectWatch>()(
  z
    .strictObject({ system: z.string(), id: z.string().exactOptional() })
    .overwrite((subject) => (subject.system === "topic" && subject.id !== undefined ? { ...subject, id: canonicalKind(subject.id) } : subject))
    .refine((subject) => subject.system !== "topic" || subject.id === undefined || knownKind(subject.id), TOPIC_PROBLEM)
    .readonly(),
);

/** This schema checks the escalation of one level, with its optional subject. */
export const escalationPolicySchema: z.ZodType<EscalationPolicy, EscalationPolicy> = schemaOf<EscalationPolicy>()(
  z
    .strictObject({
      level: levelSchema,
      daily: z.strictObject({ zone: z.string(), time: z.string() }).readonly().exactOptional(),
      about: subjectWatchSchema.exactOptional(),
      steps: z.array(escalationStepSchema).readonly(),
      exhaustedAfter: durationSchema,
    })
    .readonly(),
);

// The rule of the life-safety warnings at one place of a person. The range is 0 or more.
const mandatoryRuleSchema: z.ZodType<MandatoryRule, MandatoryRule> = schemaOf<MandatoryRule>()(
  z.strictObject({ place: placeIdSchema, on: z.boolean(), rangeKm: z.number().min(0, "The range of a rule is 0 km or more.") }).readonly(),
);

/**
 * This schema checks the places and the rules of one person. A place has one rule of the life-safety warnings at
 * most. The schema of the interest graph comes later in this file.
 */
export const personWatchSchema: z.ZodType<PersonWatch, PersonWatch> = schemaOf<PersonWatch>()(
  z
    .strictObject({
      person: personIdSchema,
      places: z.array(placeIdSchema).readonly(),
      subjects: z.array(subjectWatchSchema).readonly().exactOptional(),
      rules: z.array(levelRuleSchema).readonly(),
      quiet: quietWindowSchema.exactOptional(),
      interests: z.lazy(() => interestGraphSchema).exactOptional(),
      mandatory: z
        .array(mandatoryRuleSchema)
        .refine((rules) => new Set(rules.map((rule) => rule.place)).size === rules.length, "A place has one rule of the life-safety warnings at most.")
        .readonly()
        .exactOptional(),
      score: scoreRuleSchema.exactOptional(),
    })
    .readonly(),
);

// An estimate with each number from `min` to `max`, and an interval that holds the value.
function estimateIn(min: number, max: number): z.ZodType<Estimate, Estimate> {
  const part = z.number().min(min).max(max);
  return schemaOf<Estimate>()(
    z
      .strictObject({ value: part, low: part, high: part })
      .refine((estimate) => estimate.low <= estimate.value && estimate.value <= estimate.high, "The interval of an estimate holds its value: low <= value <= high.")
      .readonly(),
  );
}

/** This schema checks a probability with its interval: each number is from 0 to 1. */
export const probabilitySchema: z.ZodType<Estimate, Estimate> = estimateIn(0, 1);

/**
 * This schema checks a measured value with its interval. Each number is from 0 to `Number.MAX_SAFE_INTEGER`. Thus the
 * product of a probability and a count has a finite interval.
 */
export const estimateSchema: z.ZodType<Estimate, Estimate> = estimateIn(0, Number.MAX_SAFE_INTEGER);

/** This schema checks a kind of area of an alert. */
export const alertAreaSchema: z.ZodType<AlertArea, AlertArea> = schemaOf<AlertArea>()(z.enum(["county", "zone"]));

/** This schema checks the harm in one area under one active alert. */
export const underPriorSchema: z.ZodType<UnderPrior, UnderPrior> = schemaOf<UnderPrior>()(
  z.strictObject({ deaths: estimateSchema, injuries: estimateSchema, area: alertAreaSchema }).readonly(),
);

/** This schema checks the priors of one kind. */
export const kindPriorSchema: z.ZodType<KindPrior, KindPrior> = schemaOf<KindPrior>()(
  z
    .strictObject({
      verified: probabilitySchema.exactOptional(),
      deaths: estimateSchema.exactOptional(),
      injuries: estimateSchema.exactOptional(),
      under: z.partialRecord(significanceSchema, underPriorSchema).readonly().exactOptional(),
    })
    .readonly(),
);

/** This schema checks a file of priors, `alerts-priors/2`. */
export const scorePriorsSchema: z.ZodType<ScorePriors, ScorePriors> = schemaOf<ScorePriors>()(
  z
    .strictObject({
      format: z.literal("alerts-priors/2"),
      kinds: z.record(kindCodeSchema, kindPriorSchema).readonly(),
      certainty: z
        .strictObject({
          observed: probabilitySchema.exactOptional(),
          likely: probabilitySchema.exactOptional(),
          possible: probabilitySchema.exactOptional(),
          unlikely: probabilitySchema.exactOptional(),
          unknown: probabilitySchema.exactOptional(),
        })
        .readonly(),
    })
    .readonly(),
);

const priorKey = z.string().min(1, "A key of the priors is a non-empty string.");

/** This schema checks one factor of a shadow score. */
export const scoreFactorSchema: z.ZodType<ScoreFactor, ScoreFactor> = schemaOf<ScoreFactor>()(
  z
    .strictObject({
      estimate: estimateSchema,
      from: z.union([
        z.strictObject({ table: z.enum(["kinds", "certainty"]), key: priorKey }).readonly(),
        z.strictObject({ table: z.literal("under"), key: priorKey, significance: significanceSchema, area: alertAreaSchema }).readonly(),
      ]),
    })
    .readonly(),
);

// A factor of the table `under`.
const underFactorSchema = scoreFactorSchema.refine((factor) => factor.from.table === "under", "A factor of the basis alert comes from the table under.");

/** This schema checks the expected harm of a shadow score. */
export const expectedHarmSchema: z.ZodType<ExpectedHarm, ExpectedHarm> = schemaOf<ExpectedHarm>()(
  z.strictObject({ deaths: estimateSchema, injuries: estimateSchema }).readonly(),
);

/**
 * This schema checks a shadow score. A score with no read names one or more factors that the priors do not give. A score
 * of the basis `alert` has its factors from the table `under`.
 */
export const shadowScoreSchema: z.ZodType<ShadowScore, ShadowScore> = schemaOf<ShadowScore>()(
  z
    .union([
      z.strictObject({
        read: z.literal(true),
        basis: z.literal("event").exactOptional(),
        probability: scoreFactorSchema,
        deaths: scoreFactorSchema,
        injuries: scoreFactorSchema,
        expected: expectedHarmSchema,
      }),
      z.strictObject({
        read: z.literal(true),
        basis: z.literal("alert"),
        deaths: underFactorSchema,
        injuries: underFactorSchema,
        expected: expectedHarmSchema,
      }),
      z.strictObject({
        read: z.literal(false),
        missing: z
          .array(z.enum(["probability", "deaths", "injuries"]))
          .min(1, "A score with no read names each factor that the priors do not give.")
          .readonly(),
      }),
    ])
    .readonly(),
);

// =============================================================================
// Relevance (AL-35, `docs/RELEVANCE.md`)
// =============================================================================

// The key `person`, or `<system>:<id>` with a system of SUBJECT_SYSTEMS and an id that is not empty.
const NODE_KEY = new RegExp(`^(?:person|(?:${Object.keys(SUBJECT_SYSTEMS).join("|")}):.+)$`);
const nodeKeyText = z
  .string()
  .regex(NODE_KEY, "A node key is `person`, or `<system>:<id>` with a system of SUBJECT_SYSTEMS and an id that is not empty.")
  .overwrite(canonicalKey)
  .refine((key) => !key.startsWith(TOPIC_PREFIX) || knownKind(key.slice(TOPIC_PREFIX.length)), TOPIC_PROBLEM);

/** This schema checks the key of a node of an interest graph (`contracts.ts`, `NodeKey`). */
export const nodeKeySchema: z.ZodType<NodeKey, NodeKey> = schemaOf<NodeKey>()(nodeKeyText);

// A day, `YYYY-MM-DD`.
const dayText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A day is `YYYY-MM-DD`.");

// A number from 0 to 1.
const unit = z.number().min(0).max(1);

/** This schema checks the kind of an edge. */
export const edgeKindSchema: z.ZodType<EdgeKind, EdgeKind> = schemaOf<EdgeKind>()(z.enum(["physical", "cyber", "geographic", "logical", "interest"]));

/** This schema checks the origin of the weight of an edge. */
export const edgeOriginSchema: z.ZodType<EdgeOrigin, EdgeOrigin> = schemaOf<EdgeOrigin>()(
  z.enum(["base", "places", "services", "delivery", "work", "data", "measured", "person"]),
);

/**
 * This schema checks one edge of an interest graph. An edge does not start at the person, and it joins two
 * different nodes. An edge goes into the person when its kind is `interest`, and only then.
 */
export const interestEdgeSchema: z.ZodType<InterestEdge, InterestEdge> = schemaOf<InterestEdge>()(
  z
    .strictObject({
      id: z.string().min(1, "The id of an edge is a non-empty string."),
      from: nodeKeySchema,
      to: nodeKeySchema,
      kind: edgeKindSchema,
      weight: probabilitySchema,
      origin: edgeOriginSchema,
      source: z.string().min(1, "The source of a weight is a non-empty string.").exactOptional(),
      date: dayText.exactOptional(),
      on: z.boolean(),
    })
    .refine((edge) => edge.from !== "person", "An edge does not start at the person.")
    .refine((edge) => edge.from !== edge.to, "An edge joins two different nodes.")
    .refine((edge) => (edge.kind === "interest") === (edge.to === "person"), "An edge goes into the person when its kind is interest, and only then.")
    .readonly(),
);

/** This schema checks a mute. A mute has a list of kinds, a list of subjects or both, and each list has one item or more. */
export const muteSchema: z.ZodType<Mute, Mute> = schemaOf<Mute>()(
  z
    .strictObject({
      id: z.string().min(1, "The id of a mute is a non-empty string."),
      kinds: z
        .array(kindCodeSchema)
        .min(1, "A list of a mute has one item or more.")
        .readonly()
        .exactOptional(),
      subjects: z.array(nodeKeySchema).min(1, "A list of a mute has one item or more.").readonly().exactOptional(),
      until: instantSchema.exactOptional(),
      date: dayText,
    })
    .refine((mute) => mute.kinds !== undefined || mute.subjects !== undefined, "A mute has a list of kinds, a list of subjects or both.")
    .readonly(),
);

/** This schema checks the interest graph of a person, `alerts-interest/1`. The ids of the edges are unique, and so are the ids of the mutes. */
export const interestGraphSchema: z.ZodType<InterestGraph, InterestGraph> = schemaOf<InterestGraph>()(
  z
    .strictObject({
      format: z.literal("alerts-interest/1"),
      person: personIdSchema,
      edges: z.array(interestEdgeSchema).readonly(),
      mutes: z.array(muteSchema).readonly(),
      labels: z.record(nodeKeyText, z.string().min(1, "A label is a non-empty string.")).readonly().exactOptional(),
    })
    .refine((graph) => new Set(graph.edges.map((edge) => edge.id)).size === graph.edges.length, "The ids of the edges of a graph are unique.")
    .refine((graph) => new Set(graph.mutes.map((mute) => mute.id)).size === graph.mutes.length, "The ids of the mutes of a graph are unique.")
    .readonly(),
);

/** This schema checks a subject of an incident that is a node of the graph of a person. */
export const subjectEntrySchema: z.ZodType<SubjectEntry, SubjectEntry> = schemaOf<SubjectEntry>()(
  z.strictObject({ node: nodeKeySchema, kind: subjectKindSchema, hit: probabilitySchema }).readonly(),
);

/** This schema checks one path of a relevance. A path has one edge or more. */
export const relevancePathSchema: z.ZodType<RelevancePath, RelevancePath> = schemaOf<RelevancePath>()(
  z
    .strictObject({
      subject: nodeKeySchema,
      edges: z.array(z.string().min(1, "The id of an edge is a non-empty string.")).min(1, "A path has one edge or more.").readonly(),
      chance: unit,
    })
    .readonly(),
);

/** This schema checks the why record of a relevance. */
export const whyRecordSchema: z.ZodType<WhyRecord, WhyRecord> = schemaOf<WhyRecord>()(
  z
    .strictObject({
      rule: z.string().min(1, "The rule of a why record is a non-empty string."),
      subject: nodeKeySchema,
      kind: subjectKindSchema,
      via: nodeKeySchema.exactOptional(),
      anchor: nodeKeySchema,
      origin: edgeOriginSchema,
      coverage: unit,
    })
    .readonly(),
);

/** This schema checks the effect of a mute. */
export const muteEffectSchema: z.ZodType<MuteEffect, MuteEffect> = schemaOf<MuteEffect>()(z.enum(["absent", "silent"]));

/** This schema checks the policy of the relevance. The hop cap and the count of paths are whole numbers, 1 or more. */
export const relevancePolicySchema: z.ZodType<RelevancePolicy, RelevancePolicy> = schemaOf<RelevancePolicy>()(
  z
    .strictObject({
      hopCap: z.number().int().min(1, "The hop cap is 1 or more."),
      topPaths: z.number().int().min(1, "The count of paths is 1 or more."),
      mandatory: muteEffectSchema,
      entryMax: assessedLevelSchema.exactOptional(),
    })
    .readonly(),
);

/**
 * This schema checks a relevance. A relevance has a why when it has a path, and only then. A mute with the
 * effect `absent` gives a reach of 0 and no path.
 */
export const relevanceSchema: z.ZodType<Relevance, Relevance> = schemaOf<Relevance>()(
  z
    .strictObject({
      reach: probabilitySchema,
      best: unit,
      noisyOr: unit,
      paths: z.array(relevancePathSchema).readonly(),
      why: whyRecordSchema.exactOptional(),
      weakest: z.strictObject({ edge: z.string().min(1, "The id of an edge is a non-empty string."), importance: unit }).readonly().exactOptional(),
      next: z.strictObject({ edge: z.string().min(1, "The id of an edge is a non-empty string."), gain: unit }).readonly().exactOptional(),
      muted: z.strictObject({ mute: z.string().min(1, "The id of a mute is a non-empty string."), effect: muteEffectSchema }).readonly().exactOptional(),
      bound: z.enum(["bounds", "partial"]).exactOptional(),
    })
    .refine((relevance) => (relevance.why === undefined) === (relevance.paths.length === 0), "A relevance has a why when it has a path, and only then.")
    .refine(
      (relevance) => relevance.muted?.effect !== "absent" || (relevance.reach.high === 0 && relevance.paths.length === 0),
      "A mute with the effect absent gives a reach of 0 and no path.",
    )
    .readonly(),
);

/** This schema checks a reason of an assessment. The index of a rule is its position, from 0 (`contracts.ts`, line 747). */
export const assessReasonSchema: z.ZodType<AssessReason, AssessReason> = schemaOf<AssessReason>()(
  z
    .discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("ended") }),
      z.strictObject({ kind: z.literal("status"), status: statusSchema }),
      z.strictObject({ kind: z.literal("no-place") }),
      z.strictObject({ kind: z.literal("no-subject") }),
      z.strictObject({ kind: z.literal("not-addressed") }),
      z.strictObject({ kind: z.literal("addressed") }),
      z.strictObject({ kind: z.literal("no-codes") }),
      z.strictObject({ kind: z.literal("unknown-place"), place: placeIdSchema }),
      z.strictObject({
        kind: z.literal("place"),
        place: placeIdSchema,
        codes: z.array(regionCodeSchema).readonly(),
        distanceKm: z.number().min(0).exactOptional(),
        shapeRefused: z.literal(true).exactOptional(),
        zoneFallback: z.literal(true).exactOptional(),
      }),
      z.strictObject({ kind: z.literal("subject"), subject: subjectWatchSchema }),
      z.strictObject({ kind: z.literal("place-table"), place: placeIdSchema, reports: z.array(reportIdSchema).min(1).readonly(), level: assessedLevelSchema }),
      z.strictObject({
        kind: z.literal("table"),
        class: z.string().exactOptional(),
        bySeverity: assessedLevelSchema,
        byUrgency: assessedLevelSchema,
        level: assessedLevelSchema,
        recentPast: z.literal(true).exactOptional(),
        foreign: z.literal(true).exactOptional(),
      }),
      z.strictObject({ kind: z.literal("rule"), place: placeIdSchema.exactOptional(), index: count(), max: assessedLevelSchema }),
      z.strictObject({ kind: z.literal("shadow"), score: shadowScoreSchema }),
      z.strictObject({ kind: z.literal("score"), risk: z.number().positive(), raised: z.boolean(), score: shadowScoreSchema.exactOptional() }),
      z.strictObject({
        kind: z.literal("reach"),
        reach: probabilitySchema,
        reached: z.array(nodeKeySchema).readonly(),
        mandatory: z.array(placeIdSchema).readonly(),
        entryLevel: assessedLevelSchema.exactOptional(),
        why: whyRecordSchema.exactOptional(),
      }),
      z.strictObject({ kind: z.literal("relevance-fault"), message: z.string().min(1, "The message of a fault is a non-empty string.") }),
    ])
    .readonly(),
);

/** This schema checks the level of one incident for one person, with its reasons. */
export const assessmentSchema: z.ZodType<Assessment, Assessment> = schemaOf<Assessment>()(
  z
    .strictObject({
      incident: reportIdSchema,
      person: personIdSchema,
      level: assessedLevelSchema,
      places: z.array(placeIdSchema).readonly(),
      reasons: z.array(assessReasonSchema).readonly(),
      muted: z.strictObject({ mute: z.string().min(1, "The id of a mute is a non-empty string."), effect: muteEffectSchema }).readonly().exactOptional(),
    })
    .readonly(),
);

// =============================================================================
// The lateness across sources
// =============================================================================

/** This schema checks the state of an expectation. */
export const latenessStateSchema: z.ZodType<LatenessState, LatenessState> = schemaOf<LatenessState>()(z.enum(["no-limit", "no-data", "met", "late"]));

/** This schema checks the limits of one expectation. The count of misses is an integer, 1 or more (`lateness.ts`, line 66). */
export const latenessLimitSchema: z.ZodType<LatenessLimit, LatenessLimit> = schemaOf<LatenessLimit>()(
  z.strictObject({ delay: durationSchema, misses: z.int().min(1, "The count of misses is an integer, 1 or more.") }).readonly(),
);

/** This schema checks the lateness of one source against another source for one expectation. */
export const latenessSchema: z.ZodType<Lateness, Lateness> = schemaOf<Lateness>()(
  z
    .strictObject({
      expectation: z.string(),
      from: sourceIdSchema,
      to: sourceIdSchema,
      state: latenessStateSchema,
      limit: latenessLimitSchema.exactOptional(),
      missed: z.array(reportIdSchema).readonly(),
      since: instantSchema.exactOptional(),
      wakeAt: instantSchema.exactOptional(),
    })
    .readonly(),
);

// =============================================================================
// The private configuration
// =============================================================================

/** This schema checks a reference to a secret. The name is not empty. The value stays in the secret store. */
export const secretRefSchema: z.ZodType<SecretRef, SecretRef> = schemaOf<SecretRef>()(
  z.strictObject({ secret: z.string().min(1, "The name of a secret is a non-empty string.") }).readonly(),
);

/** This schema checks one field of an address: a text, or a reference to a secret. */
export const addressValueSchema: z.ZodType<AddressValue, AddressValue> = schemaOf<AddressValue>()(z.union([z.string(), secretRefSchema]));

/** This schema checks a place of the configuration. */
export const placeConfigSchema: z.ZodType<PlaceConfig, PlaceConfig> = schemaOf<PlaceConfig>()(
  z
    .strictObject({
      id: placeIdSchema,
      label: z.string(),
      at: positionSchema.exactOptional(),
      codes: z.array(regionCodeSchema).readonly(),
      bufferKm: z.number(),
      sharePosition: z.array(sourceIdSchema).readonly().exactOptional(),
      moving: z.strictObject({ device: z.string(), maxAgeMinutes: z.number(), maxAccuracyKm: z.number().exactOptional() }).readonly().exactOptional(),
    })
    .readonly(),
);

// The printable ASCII characters, with no space, no parenthesis and no backslash.
const CONTACT_CHARACTERS = /^[\x21-\x27\x2a-\x5b\x5d-\x7e]+$/;
// An `https` URL with a host of two labels or more, or a `mailto` URL with one address.
const CONTACT_FORMS = [
  /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::[0-9]{1,5})?(?:[/?#].*)?$/i,
  /^mailto:[^@/?#]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?:\?.*)?$/i,
];

/**
 * This function tells if a text is a contact of an operator: an `https` URL with a host, or a `mailto` URL
 * with an address. The contact goes into the comment of the User-Agent. Thus it has only
 * printable ASCII characters, with no space, no parenthesis and no backslash. A header with other
 * characters stops the fetch. A parenthesis ends the comment, and a backslash escapes the next character.
 */
export function isContactUrl(text: string): boolean {
  return CONTACT_CHARACTERS.test(text) && CONTACT_FORMS.some((form) => form.test(text));
}

/**
 * This schema checks the inputs of the default layers of a person. The load checks each work against the table, and
 * checks that each service is an entity.
 */
export const interestDefaultsConfigSchema: z.ZodType<InterestDefaultsConfig, InterestDefaultsConfig> = schemaOf<InterestDefaultsConfig>()(
  z
    .strictObject({
      works: z.array(z.string().min(1)).readonly().exactOptional(),
      services: z.array(nodeKeySchema).readonly().exactOptional(),
      delivery: z.boolean().exactOptional(),
    })
    .readonly(),
);

/** This schema checks a person of the configuration: the watch, and the policies of the person when they are not the default. */
export const personConfigSchema: z.ZodType<PersonConfig, PersonConfig> = schemaOf<PersonConfig>()(
  z
    .strictObject({
      watch: personWatchSchema,
      defaults: interestDefaultsConfigSchema.exactOptional(),
      label: z.string().exactOptional(),
      policies: z.array(escalationPolicySchema).readonly().exactOptional(),
    })
    .readonly(),
);

/** This schema checks the settings of one expectation of the instance. */
export const expectationConfigSchema: z.ZodType<ExpectationConfig, ExpectationConfig> = schemaOf<ExpectationConfig>()(
  z.strictObject({ id: z.string(), since: instantSchema }).readonly(),
);

/** This schema checks one address of one person on one channel. */
export const contactConfigSchema: z.ZodType<ContactConfig, ContactConfig> = schemaOf<ContactConfig>()(
  z.strictObject({ person: personIdSchema, channel: channelIdSchema, address: z.record(z.string(), addressValueSchema).readonly() }).readonly(),
);

/** This schema checks the form of one record of the opt-in list. `loadConfig` checks the number, the time and the words. */
export const optInConfigSchema: z.ZodType<OptInConfig, OptInConfig> = schemaOf<OptInConfig>()(
  z.strictObject({ number: addressValueSchema, at: z.string().min(1), way: z.enum(OPT_IN_WAYS), words: z.string().min(1) }).readonly(),
);

/**
 * This schema checks the money rules of one paid provider account, with its fixed costs. `loadConfig` checks the
 * provider, the fixed costs against the cap, the reserve and the time zone.
 */
export const spendConfigSchema: z.ZodType<SpendConfig, SpendConfig> = schemaOf<SpendConfig>()(
  z
    .strictObject({
      provider: z.string().min(1),
      monthlyUsd: z.number().positive(),
      fixed: z
        .array(z.strictObject({ what: z.string().min(1), usd: z.number().nonnegative() }).readonly())
        .readonly()
        .exactOptional(),
      reserveUsd: z.number().nonnegative().exactOptional(),
      floor: z.union([z.number(), z.array(z.number()).min(1, "The list of floors has one floor or more.").readonly()]),
      timeZone: z.string().min(1),
    })
    .readonly(),
);

/**
 * This schema checks the watch of one hard limit of a provider account (AL-111). `loadConfig` checks the ids and the
 * monthly limit of the account of a user.
 */
/** This schema checks one subject of the stack of the alert chain (AL-90). */
export const chainSubjectSchema: z.ZodType<ChainSubject, ChainSubject> = schemaOf<ChainSubject>()(
  z.strictObject({ system: z.string().min(1), id: z.string().min(1), part: z.string().min(1) }).readonly(),
);

/** This schema checks the stack of the alert chain (AL-90). The runtime checks the stack document with its own schemas. */
export const chainConfigSchema: z.ZodType<ChainConfig, ChainConfig> = schemaOf<ChainConfig>()(
  z
    .strictObject({
      stack: z.record(z.string(), z.unknown()).readonly(),
      subjects: z.array(chainSubjectSchema).readonly(),
    })
    .readonly(),
);

export const limitConfigSchema: z.ZodType<LimitConfig, LimitConfig> = schemaOf<LimitConfig>()(
  z
    .strictObject({
      id: z.string().min(1),
      provider: z.string().min(1),
      title: z.string().min(1),
      accountKind: z.enum(LIMIT_ACCOUNT_KINDS),
      account: z.string().min(1),
      products: z.array(z.string().min(1)).min(1, "A watch of a limit counts one product or more.").readonly(),
      monthlyUsd: z.number().positive().exactOptional(),
      budget: z.string().min(1).exactOptional(),
      levels: z
        .array(z.number().positive("A level is a share above 0.").finite())
        .min(1, "A watch of a limit has one level or more.")
        .readonly()
        .exactOptional(),
      tokenKey: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]{0,63}$/u, "The key of a token is a capital letter, then capital letters, digits and underscores, up to 64 characters.")
        .exactOptional(),
    })
    .readonly(),
);

/** This schema checks the link of one family of kinds: its code, its window, its distance and its limit of the magnitude. */
export const linkFamilySchema: z.ZodType<LinkFamily, LinkFamily> = schemaOf<LinkFamily>()(
  z
    .strictObject({
      family: kindCodeSchema,
      windowMs: z.int().positive("The window is an integer count of milliseconds, 1 or more."),
      distanceKm: z.number().nonnegative("The distance is 0 km or more."),
      magnitude: z.number().nonnegative("The limit of the magnitude is 0 or more.").exactOptional(),
    })
    .readonly(),
);

/** This schema checks the policy of the link rule. The configuration can give it in place of `DEFAULT_LINK_POLICY`. */
export const linkPolicySchema: z.ZodType<LinkPolicy, LinkPolicy> = schemaOf<LinkPolicy>()(
  z.strictObject({ families: z.array(linkFamilySchema).readonly() }).readonly(),
);

/** This schema checks a chain of tries: the channel of each try, in order. */
export const tryChainSchema: z.ZodType<TryChain, TryChain> = schemaOf<TryChain>()(
  z.strictObject({ steps: z.array(channelIdSchema).readonly() }).readonly(),
);

/** This schema checks one person of the outage call. `loadConfig` checks the person and the channel of each step. */
export const outagePersonConfigSchema: z.ZodType<OutagePersonConfig, OutagePersonConfig> = schemaOf<OutagePersonConfig>()(
  z.strictObject({ person: personIdSchema, chain: tryChainSchema }).readonly(),
);

/** This schema checks the outage call: the people and their chains. */
export const outageConfigSchema: z.ZodType<OutageConfig, OutageConfig> = schemaOf<OutageConfig>()(
  z.strictObject({ people: z.array(outagePersonConfigSchema).readonly() }).readonly(),
);

// The id of a copy: a short name of lowercase letters, digits and hyphens, thus a log line and a file name can hold it.
/** This schema checks the id of a copy of the system: 1 to 32 lowercase letters, digits and hyphens. */
export const copyIdSchema: z.ZodType<string, string> = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/u, "The id of a copy is 1 to 32 lowercase letters, digits and hyphens.");

/**
 * This schema checks the window of the starts of a drill: the shape of `TimeWindow` of `@mark1russell7/algebra/clock`.
 * It does not check the time zone or the local times. `drillProblems` finds a bad window.
 */
export const drillWindowSchema: z.ZodType<DrillConfig["window"], DrillConfig["window"]> = schemaOf<DrillConfig["window"]>()(
  z
    .strictObject({
      zone: z.string(),
      start: z.string(),
      end: z.string(),
      days: z.array(z.int().min(0).max(6, "A day of the week is from 0 (Sunday) to 6 (Saturday).")).readonly().optional(),
    })
    .readonly(),
);

/** This schema checks the path of a drill: one channel. `loadConfig` checks the channel and the contact of the person on it. */
export const drillPathSchema: z.ZodType<DrillPath, DrillPath> = schemaOf<DrillPath>()(z.strictObject({ kind: z.literal("channel"), channel: channelIdSchema }).readonly());

/** This schema checks one drill of the configuration. `loadConfig` checks the person, the channel and the times. */
export const drillConfigSchema: z.ZodType<DrillConfig, DrillConfig> = schemaOf<DrillConfig>()(
  z
    .strictObject({
      id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/u, "The id of a drill is 1 to 32 lowercase letters, digits and hyphens."),
      person: personIdSchema,
      path: drillPathSchema,
      every: durationSchema,
      window: drillWindowSchema,
      ackWithin: durationSchema,
      copies: z.array(copyIdSchema).min(1).readonly().exactOptional(),
    })
    .readonly(),
);

/** This schema checks a table of rank delays: a duration for some levels. `loadConfig` checks the bounds of each value. */
export const rankDelaysSchema: z.ZodType<RankDelays, RankDelays> = schemaOf<RankDelays>()(
  z.strictObject({ digest: durationSchema.exactOptional(), notice: durationSchema.exactOptional(), urgent: durationSchema.exactOptional(), "life-safety": durationSchema.exactOptional() }).readonly(),
);

/** This schema checks the send limit of each person (AL-72). `loadConfig` checks the bounds of each value. */
export const sendLimitConfigSchema: z.ZodType<SendLimitConfig, SendLimitConfig> = schemaOf<SendLimitConfig>()(
  z.strictObject({ window: durationSchema.exactOptional(), notice: z.number().int().exactOptional(), urgent: z.number().int().exactOptional() }).readonly(),
);

/** This schema checks the throttle of each person and channel (AL-72 part 4). `loadConfig` checks the bounds of the window. */
export const throttleConfigSchema: z.ZodType<ThrottleConfig, ThrottleConfig> = schemaOf<ThrottleConfig>()(
  z.strictObject({ window: durationSchema.exactOptional(), key: z.enum(["channel", "incident"]).exactOptional(), streams: z.enum(["system", "family"]).exactOptional(), exempt: z.array(levelSchema).readonly().exactOptional() }).readonly(),
);

// The origin of a site on the loopback address, with a port and no path.
const LOOPBACK_ORIGIN = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}$/iu;
// The origin of a site that a phone opens: `https`, a host of two labels or more and an optional port, with no path.
const PHONE_ORIGIN = /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::[0-9]{1,5})?$/iu;
// An IPv4 address. A phone does not open the loopback form of the site, thus the phone origin has no such host.
const IPV4_HOST = /^https:\/\/[0-9.]+(?::[0-9]{1,5})?$/u;

/** This schema checks the two forms of the links of a local site (AL-92): a loopback origin and a phone origin. */
export const tellSiteSchema: z.ZodType<TellSite, TellSite> = schemaOf<TellSite>()(
  z
    .strictObject({
      local: z.string().regex(LOOPBACK_ORIGIN, "The local origin is http or https, a loopback host and a port, with no path."),
      phone: z
        .string()
        .regex(PHONE_ORIGIN, "The phone origin is https and a host of two labels or more, with no path.")
        .refine((text) => !IPV4_HOST.test(text), "The phone origin has a name, not an IPv4 address."),
    })
    .readonly(),
);

/** This schema checks the intake of the messages of the operator (AL-92): a port, a daily cap of 1 or more, and the local site. */
export const tellConfigSchema: z.ZodType<TellConfig, TellConfig> = schemaOf<TellConfig>()(
  z
    .strictObject({
      port: z.int().min(1).max(65535, "The port is 1 to 65535."),
      dailyCap: z.int().min(1).exactOptional(),
      site: tellSiteSchema.exactOptional(),
    })
    .readonly(),
);

/** This schema checks one command of the drift checks (AL-139): a name for the reports, a kind, and the program with its arguments. */
export const driftCommandConfigSchema: z.ZodType<DriftCommandConfig, DriftCommandConfig> = schemaOf<DriftCommandConfig>()(
  z
    .strictObject({
      name: z.string().regex(DRIFT_NAME, "The name of a drift check is letters, digits, dots, underscores and hyphens, up to 64 characters."),
      kind: z.enum(DRIFT_COMMAND_KINDS),
      argv: z.array(z.string().min(1, "An argument of a drift check is a non-empty text.")).min(1, "A drift check names its program.").readonly(),
    })
    .readonly(),
);

/** This schema checks the drift checks of the host of one copy (AL-139): one command or more, each with its own name. */
export const driftConfigSchema: z.ZodType<DriftConfig, DriftConfig> = schemaOf<DriftConfig>()(
  z
    .strictObject({
      commands: z
        .array(driftCommandConfigSchema)
        .min(1, "The drift checks have one command or more.")
        .readonly()
        .refine((commands) => new Set(commands.map((command) => command.name)).size === commands.length, "Two drift checks have the same name."),
    })
    .readonly(),
);

/** This schema checks the policy of a down channel (AL-65). A run opens a line at 1 failed call or more. */
export const channelDownConfigSchema: z.ZodType<ChannelDownConfig, ChannelDownConfig> = schemaOf<ChannelDownConfig>()(
  z.strictObject({ failures: z.number().int().min(1).exactOptional(), span: durationSchema.exactOptional() }).readonly(),
);

/** This schema checks the policy of the end of the line of a down source (AL-75). At 0 and 0, a line ends at the first state that is up. */
export const sourceClearConfigSchema: z.ZodType<SourceClearConfig, SourceClearConfig> = schemaOf<SourceClearConfig>()(
  z.strictObject({ floor: durationSchema.exactOptional(), fetches: z.number().int().min(0).exactOptional() }).readonly(),
);

/**
 * This schema checks the JSON of the private configuration at the load. It checks the form of each
 * value. Then `loadConfig` checks the references: the ids, the places of each person, the contacts,
 * the secrets, the outage call and the drills.
 */
export const alertConfigSchema: z.ZodType<AlertConfig, AlertConfig> = schemaOf<AlertConfig>()(
  z
    .strictObject({
      format: z.literal(CONFIG_FORMAT),
      places: z.array(placeConfigSchema).readonly(),
      people: z.array(personConfigSchema).readonly(),
      contacts: z.array(contactConfigSchema).readonly(),
      policies: z.array(escalationPolicySchema).readonly(),
      contact: z.string().refine(isContactUrl, "The contact is not an https URL or a mailto URL.").exactOptional(),
      expectations: z.array(expectationConfigSchema).readonly().exactOptional(),
      spend: z.array(spendConfigSchema).readonly().exactOptional(),
      limits: z.array(limitConfigSchema).readonly().exactOptional(),
      chain: chainConfigSchema.exactOptional(),
      link: linkPolicySchema.exactOptional(),
      outage: outageConfigSchema.exactOptional(),
      rankDelay: rankDelaysSchema.exactOptional(),
      rankFloor: durationSchema.exactOptional(),
      reportLimit: z.number().int().min(1, "The bound of the reports is 1 or more.").exactOptional(),
      assess: assessPolicySchema.exactOptional(),
      drills: z.array(drillConfigSchema).readonly().exactOptional(),
      optIn: z.array(optInConfigSchema).readonly().exactOptional(),
      channelDown: channelDownConfigSchema.exactOptional(),
      sourceClear: sourceClearConfigSchema.exactOptional(),
      sendLimit: sendLimitConfigSchema.exactOptional(),
      throttle: throttleConfigSchema.exactOptional(),
      tell: tellConfigSchema.exactOptional(),
    })
    .readonly(),
);

/** This schema checks the JSON of one part of the private configuration. Then the merge and `loadConfig` check the references. */
export const configPartSchema: z.ZodType<ConfigPart, ConfigPart> = schemaOf<ConfigPart>()(
  z
    .strictObject({
      format: z.literal(CONFIG_PART_FORMAT),
      places: z.array(placeConfigSchema).readonly().exactOptional(),
      people: z.array(personConfigSchema).readonly().exactOptional(),
      contacts: z.array(contactConfigSchema).readonly().exactOptional(),
    })
    .readonly(),
);

// The URL of the exchange of another copy. The tailnet carries it, thus `http` is also a valid protocol. The host is a
// name with one label or more, an IPv4 address or an IPv6 address in brackets. The URL has no user, no query and no fragment.
const EXCHANGE_URL = /^https?:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::[0-9]{1,5})?(?:\/[^\s?#]*)?$/iu;
const isExchangeUrl = (text: string): boolean => EXCHANGE_URL.test(text);

/** This schema checks the address of the exchange of a copy. */
export const copyListenSchema: z.ZodType<CopyListen, CopyListen> = schemaOf<CopyListen>()(
  z.strictObject({ host: z.string().min(1, "The address is a non-empty text."), port: z.int().min(1).max(65535, "The port is 1 to 65535.") }).readonly(),
);

/** This schema checks the billing read of the host of another copy (AL-70): the program with its arguments, the field and the stop values. */
export const copyBillingConfigSchema: z.ZodType<CopyBillingConfig, CopyBillingConfig> = schemaOf<CopyBillingConfig>()(
  z
    .strictObject({
      argv: z.array(z.string().min(1, "An argument of a billing read is a non-empty text.")).min(1, "A billing read names its program.").readonly(),
      field: z.string().regex(BILLING_FIELD, "The field of a billing read is names with dots between them, each of letters, digits, underscores and hyphens."),
      stoppedWhen: z
        .array(z.union([z.string(), z.number(), z.boolean()]))
        .min(1, "A billing read has one value of a stop or more.")
        .readonly(),
    })
    .readonly(),
);

/** This schema checks another copy of the system: its id, the URL of its exchange and the billing read of its host. */
export const copyPeerSchema: z.ZodType<CopyPeer, CopyPeer> = schemaOf<CopyPeer>()(
  z
    .strictObject({
      id: copyIdSchema,
      url: z.string().refine(isExchangeUrl, "The URL of a copy is an http or https URL with no user, no query and no fragment."),
      billing: copyBillingConfigSchema.exactOptional(),
    })
    .readonly(),
);

/** This schema checks the JSON of the settings of one copy, the file `copy.json`. Then `copyProblems` checks the ranks and the ids. */
export const copySettingsSchema: z.ZodType<CopySettings, CopySettings> = schemaOf<CopySettings>()(
  z
    .strictObject({
      format: z.literal(COPY_FORMAT),
      id: copyIdSchema,
      rank: z.int().nonnegative("The rank is an integer, 0 or more."),
      listen: copyListenSchema.exactOptional(),
      peers: z.array(copyPeerSchema).readonly().exactOptional(),
      pingKey: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]*$/u, "The key is a name of the secrets: capital letters, digits and underscores.")
        .exactOptional(),
      accounts: z
        .record(z.string().min(1, "The id of a source is a non-empty text."), z.int().min(1, "The number of an account is an integer, 1 or more."))
        .readonly()
        .exactOptional(),
      configFrom: copyIdSchema.exactOptional(),
      leaveChannels: z.array(channelIdSchema).readonly().exactOptional(),
      leaveSources: z.array(sourceIdSchema).readonly().exactOptional(),
      drift: driftConfigSchema.exactOptional(),
    })
    .readonly(),
);

// =============================================================================
// The health payload
// =============================================================================

/** This schema checks the health of one source in the health payload: the kind of its last failure, with no message. */
export const sourceHealthViewSchema: z.ZodType<SourceHealthView, SourceHealthView> = schemaOf<SourceHealthView>()(
  z
    .strictObject({
      source: sourceIdSchema,
      state: healthStateSchema,
      since: instantSchema,
      lastSuccess: instantSchema.exactOptional(),
      lastFailure: z.strictObject({ at: instantSchema, kind: z.enum(["network", "timeout", "server", "rate-limited", "auth", "refused"]) }).readonly().exactOptional(),
      reason: z.string(),
    })
    .readonly(),
);

/** This schema checks a stage of another copy. */
export const copyStageSchema: z.ZodType<CopyStage, CopyStage> = schemaOf<CopyStage>()(z.enum(["skew", "config", "unread", "unsteady"]));

/** This schema checks one read of the log of another copy that passed. */
export const copyReadSchema: z.ZodType<CopyRead, CopyRead> = schemaOf<CopyRead>()(
  z.strictObject({ at: instantSchema, skew: z.number(), sameConfig: z.boolean() }).readonly(),
);

/** This schema checks the health of another copy: its stages and its last read that passed. */
export const copyHealthSchema: z.ZodType<CopyHealth, CopyHealth> = schemaOf<CopyHealth>()(
  z.strictObject({ copy: copyIdSchema, stages: z.array(copyStageSchema).readonly(), read: copyReadSchema.exactOptional() }).readonly(),
);

/** This schema checks a stage of the quota of a channel. */
export const quotaStageSchema: z.ZodType<QuotaStage, QuotaStage> = schemaOf<QuotaStage>()(z.enum(["low", "reserve", "spent"]));

/** This schema checks the state of the quota of a channel in its window. Each count is an integer, 0 or more. */
export const channelQuotaSchema: z.ZodType<ChannelQuota, ChannelQuota> = schemaOf<ChannelQuota>()(
  z
    .strictObject({
      channel: channelIdSchema,
      limit: z.int().min(0, "The limit of a quota is an integer, 0 or more."),
      reserve: z.int().min(0, "The reserve of a quota is an integer, 0 or more."),
      used: z.int().min(0, "The used units of a quota are an integer, 0 or more."),
      resetAt: instantSchema.exactOptional(),
      blockedUntil: instantSchema.exactOptional(),
      unit: z.string().min(1, "The name of the units is a non-empty string.").exactOptional(),
    })
    .readonly(),
);

/** This schema checks the health of the quota of one channel: the quota and its stages. */
export const quotaHealthSchema: z.ZodType<QuotaHealth, QuotaHealth> = schemaOf<QuotaHealth>()(
  z.strictObject({ quota: channelQuotaSchema, stages: z.array(quotaStageSchema).readonly() }).readonly(),
);

/** This schema checks a stage of the balance of a provider account. */
export const balanceStageSchema: z.ZodType<BalanceStage, BalanceStage> = schemaOf<BalanceStage>()(z.enum(["low", "empty", "unread"]));

/** This schema checks one read of a balance that passed. The currency is a code of ISO 4217: three capital letters. */
export const balanceReadSchema: z.ZodType<BalanceRead, BalanceRead> = schemaOf<BalanceRead>()(
  z.strictObject({ balance: z.number(), currency: z.string().regex(/^[A-Z]{3}$/u, "A currency is a code of ISO 4217."), at: instantSchema }).readonly(),
);

/** This schema checks the watch of the balance of one provider account. */
export const providerBalanceSchema: z.ZodType<ProviderBalance, ProviderBalance> = schemaOf<ProviderBalance>()(
  z
    .strictObject({
      provider: z.string().min(1, "The provider is a non-empty string."),
      title: z.string(),
      channels: z.array(channelIdSchema).readonly(),
      floors: z.array(z.number()).min(1, "The list of floors has one floor or more.").readonly(),
      maxAge: durationSchema,
      since: instantSchema,
      read: balanceReadSchema.exactOptional(),
    })
    .readonly(),
);

/** This schema checks the health of the balance of one provider account: the balance and its stages. */
export const balanceHealthSchema: z.ZodType<BalanceHealth, BalanceHealth> = schemaOf<BalanceHealth>()(
  z.strictObject({ balance: providerBalanceSchema, stages: z.array(balanceStageSchema).readonly() }).readonly(),
);

/** This schema checks the health of one read on a schedule of the runtime. */
export const readHealthSchema: z.ZodType<ReadHealth, ReadHealth> = schemaOf<ReadHealth>()(
  z
    .strictObject({
      what: z.string().min(1, "The words of a read are a non-empty string."),
      at: instantSchema.nullable(),
      failed: z.boolean(),
      next: instantSchema.nullable(),
    })
    .readonly(),
);

/** This schema checks the run of failed calls of one channel of a copy (AL-65). */
export const channelRunSchema: z.ZodType<ChannelRun, ChannelRun> = schemaOf<ChannelRun>()(
  z
    .strictObject({
      channel: channelIdSchema,
      failures: z.number().int().min(1, "A run has one failed call or more."),
      first: instantSchema,
      last: instantSchema,
      kind: channelFailureKindSchema,
      reached: z.boolean(),
    })
    .readonly(),
);

/** This schema checks the health of one channel of this copy: its endpoints, its last good call, its run and the down flag. */
export const channelHealthSchema: z.ZodType<ChannelHealth, ChannelHealth> = schemaOf<ChannelHealth>()(
  z
    .strictObject({
      copy: z.string().min(1, "The id of a copy is a non-empty string."),
      channel: channelIdSchema,
      title: z.string(),
      api: z.array(z.lazy(() => nodeKeySchema)).readonly().exactOptional(),
      run: channelRunSchema.exactOptional(),
      good: instantSchema.exactOptional(),
      down: z.boolean(),
    })
    .readonly(),
);

/** This schema checks the answer of the health route of the runtime. */
export const healthPayloadSchema: z.ZodType<HealthPayload, HealthPayload> = schemaOf<HealthPayload>()(
  z
    .strictObject({
      format: z.literal(HEALTH_FORMAT),
      at: instantSchema.nullable(),
      now: instantSchema,
      sources: z.array(sourceHealthViewSchema).readonly(),
      lateness: z.array(latenessSchema).readonly(),
      coverage: z.array(coverageSchema).readonly(),
      copies: z.array(copyHealthSchema).readonly(),
      quotas: z.array(quotaHealthSchema).readonly(),
      balances: z.array(balanceHealthSchema).readonly(),
      reads: z.array(readHealthSchema).readonly(),
      channels: z.array(channelHealthSchema).readonly(),
    })
    .readonly(),
);

/** This schema checks a shape of the map: a polygon or a circle. */
export const mapShapeSchema: z.ZodType<MapShape, MapShape> = schemaOf<MapShape>()(z.discriminatedUnion("type", [polygonObject, circleObject]).readonly());

/** This schema checks one watched place of a change of the history. */
export const historyPlaceSchema: z.ZodType<HistoryPlace, HistoryPlace> = schemaOf<HistoryPlace>()(
  z.strictObject({ id: placeIdSchema, level: assessedLevelSchema }).readonly(),
);

/** This schema checks one change of the history of an incident. */
export const historyChangeSchema: z.ZodType<HistoryChange, HistoryChange> = schemaOf<HistoryChange>()(
  z
    .strictObject({
      at: instantSchema,
      reports: z.array(reportIdSchema).readonly(),
      level: assessedLevelSchema,
      severity: severitySchema,
      live: z.boolean(),
      onset: instantSchema.exactOptional(),
      expires: instantSchema.exactOptional(),
      codes: z.array(regionCodeSchema).readonly(),
      shapes: z.array(mapShapeSchema).readonly(),
      unshaped: z.array(regionCodeSchema).readonly(),
      places: z.array(historyPlaceSchema).readonly(),
    })
    .readonly(),
);

/** This schema checks the history of one incident. */
export const historyIncidentSchema: z.ZodType<HistoryIncident, HistoryIncident> = schemaOf<HistoryIncident>()(
  z
    .strictObject({
      anchor: reportIdSchema,
      reports: z.array(reportIdSchema).min(1, "An incident has one report or more.").readonly(),
      status: statusSchema,
      kind: kindSchema,
      changes: z.array(historyChangeSchema).readonly(),
    })
    .readonly(),
);

/** This schema checks the shapes of one region code of the history. */
export const historyRegionSchema: z.ZodType<HistoryRegion, HistoryRegion> = schemaOf<HistoryRegion>()(
  z.strictObject({ code: regionCodeSchema, shapes: z.array(mapShapeSchema).readonly() }).readonly(),
);

/** This schema checks the answer of the history route of the runtime. */
export const historyPayloadSchema: z.ZodType<HistoryPayload, HistoryPayload> = schemaOf<HistoryPayload>()(
  z
    .strictObject({
      format: z.literal(HISTORY_FORMAT),
      at: instantSchema.nullable(),
      since: instantSchema.nullable(),
      next: instantSchema.nullable(),
      incidents: z.array(historyIncidentSchema).readonly(),
      regions: z.array(historyRegionSchema).readonly(),
    })
    .readonly(),
);

/** This schema checks one row of the interests of a person: an edge, and the id of the edge that replaced it. */
export const interestRowSchema: z.ZodType<InterestRow, InterestRow> = schemaOf<InterestRow>()(
  z.strictObject({ edge: interestEdgeSchema, replacedBy: z.string().min(1).exactOptional() }).readonly(),
);

/** This schema checks the interests of one person in the answer of the interests route of the runtime. */
export const interestsPersonSchema: z.ZodType<InterestsPerson, InterestsPerson> = schemaOf<InterestsPerson>()(
  z
    .strictObject({
      person: personIdSchema,
      label: z.string().exactOptional(),
      routing: z.enum(["graph", "places"]),
      rows: z.array(interestRowSchema).readonly(),
      mutes: z.array(muteSchema).readonly(),
      labels: z.record(z.string(), z.string()).readonly(),
      problem: z.string().exactOptional(),
    })
    .readonly(),
);

/** This schema checks the answer of the interests route of the runtime. */
export const interestsPayloadSchema: z.ZodType<InterestsPayload, InterestsPayload> = schemaOf<InterestsPayload>()(
  z.strictObject({ format: z.literal(INTERESTS_FORMAT), people: z.array(interestsPersonSchema).readonly() }).readonly(),
);

/**
 * This function reads the JSON text of the settings of one copy. It checks the JSON, then the schema, then
 * `copyProblems`. The problems hold no address and no URL.
 */
export function parseCopySettings(text: string): Result<CopySettings, readonly string[]> {
  const json = tryCatch((): unknown => JSON.parse(text), () => ["The settings of the copy are not valid JSON."]);
  if (json.tag === "err") return json;
  const checked = checkWith(copySettingsSchema, json.value);
  if (checked.tag === "err") return checked;
  const problems = copyProblems(checked.value);
  return problems.length > 0 ? err(problems) : checked;
}

/**
 * This function checks a value at a trust boundary. The result is the value, or one problem for each
 * issue of the schema. A problem names the path and the rule. It does not hold the value, because the
 * value can be private.
 */
export function checkWith<T>(schema: z.ZodType<T, T>, value: unknown): Result<T, readonly string[]> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return ok(parsed.data);
  return err(parsed.error.issues.map((issue) => `${pathText(issue.path)}: ${issue.message}`));
}

/** The text of the path of an issue, for example `places[0].codes[1]`. The root is `(root)`. */
function pathText(path: readonly PropertyKey[]): string {
  const text = path.map((part, index) => (typeof part === "number" ? `[${part}]` : `${index === 0 ? "" : "."}${String(part)}`)).join("");
  return text === "" ? "(root)" : text;
}

/** A configuration that passed the schema and the load, with the recipient of each person. The configuration is the merge of the root and its parts. */
export interface ParsedConfig {
  readonly config: AlertConfig;
  readonly recipients: readonly Recipient[];
  /** The opt-in list of the texts, with the value of each number. */
  readonly optIn: readonly OptInRecord[];
}

/** The JSON text of one part of the private configuration, with the name of the part. */
export interface PartText {
  readonly name: string;
  readonly text: string;
}

/**
 * This function reads the JSON text of the private configuration and the texts of its parts. It checks the JSON and
 * the schema of each text. Then it merges the parts with `mergeParts` and checks the references of the merge with
 * `loadConfig`. The runtime starts only with an `ok` result. The problems hold no value of the configuration and no
 * value of a secret. A problem of a part starts with the name of the part.
 */
export function parseConfig(
  text: string,
  channels: readonly ChannelDescriptor[],
  secret: SecretLookup,
  parts: readonly PartText[] = [],
  services?: ContactServices,
): Result<ParsedConfig, readonly string[]> {
  const problems: string[] = [];
  // The message of the JSON parser can quote the text, so the problem does not use it.
  const json = tryCatch((): unknown => JSON.parse(text), () => ["The configuration is not valid JSON."]);
  const checked = json.tag === "err" ? json : checkWith(alertConfigSchema, json.value);
  if (checked.tag === "err") problems.push(...checked.error);
  const named: NamedPart[] = [];
  parts.forEach(({ name, text: partText }, index) => {
    // The merge refuses a bad name.
    const label = partLabel(name, index);
    const partJson = tryCatch((): unknown => JSON.parse(partText), () => [`${label} is not valid JSON.`]);
    const part = partJson.tag === "err" ? partJson : checkWith(configPartSchema, partJson.value);
    if (part.tag === "err") problems.push(...part.error.map((problem) => (partJson.tag === "err" ? problem : `${label}: ${problem}`)));
    else named.push({ name, part: part.value });
  });
  if (checked.tag === "err" || problems.length > 0) return err(problems);
  const merged = mergeParts(checked.value, named);
  if (merged.tag === "err") return merged;
  const loaded = loadConfig(merged.value, channels, secret, services);
  return loaded.problems.length > 0 ? err(loaded.problems) : ok({ config: merged.value, recipients: loaded.recipients, optIn: loaded.optIn });
}
