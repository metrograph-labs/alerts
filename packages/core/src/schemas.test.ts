import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { assess, COVERAGE_KIND, DEFAULT_ASSESS_POLICY } from "./assess.ts";
import { CONFIG_FORMAT, CONFIG_PART_FORMAT, configHash, COPY_FORMAT, copyProblems, loadConfig, ONLY_COPY, type AlertConfig, type CopySettings } from "./config.ts";
import type {
  Acknowledgment,
  EndMark,
  Address,
  Area,
  AssessedLevel,
  AssessPolicy,
  AssessReason,
  Assessment,
  CanaryResult,
  Category,
  CellResource,
  Certainty,
  ChannelDescriptor,
  ChannelId,
  CorrelationKey,
  Coverage,
  Cursor,
  Delivery,
  DeliveryState,
  DeliveryStatus,
  Duration,
  EscalationPolicy,
  EscalationStep,
  FetchFailure,
  FetchOutcome,
  FetchRecord,
  HealthState,
  Incident,
  Instant,
  Kind,
  KindClass,
  Level,
  LevelRule,
  LevelTable,
  LocateOutcome,
  MapProblem,
  MapResult,
  Message,
  Observation,
  ObservationId,
  Operation,
  PersonId,
  PersonWatch,
  PlaceId,
  Position,
  QuietWindow,
  Receipt,
  RegionCode,
  Report,
  ReportId,
  ResponseType,
  SendOutcome,
  Severity,
  Significance,
  SourceDescriptor,
  SourceHealth,
  SourceId,
  Status,
  Subject,
  SubjectWatch,
  Transport,
  Urgency,
  Watch,
  WatchedPlace,
  WhyLimit,
} from "./contracts.ts";
import { coverage } from "./coverage.ts";
import { escalate } from "./escalation.ts";
import { observeFetch, startHealth } from "./health.ts";
import { messageKey, observationId, reportId } from "./ids.ts";
import { lateness, limitRule, type Lateness, type LatenessLimit, type LatenessState } from "./lateness.ts";
import { DEFAULT_LINK_POLICY, type LinkFamily, type LinkPolicy } from "./link.ts";
import { incidents, normalize } from "./merge.ts";
import * as schemas from "./schemas.ts";
import {
  acknowledgmentSchema,
  endMarkSchema,
  addressSchema,
  addressValueSchema,
  alertConfigSchema,
  configPartSchema,
  driftCommandConfigSchema,
  driftConfigSchema,
  drillConfigSchema,
  expectationConfigSchema,
  limitConfigSchema,
  chainConfigSchema,
  chainSubjectSchema,
  outageConfigSchema,
  outagePersonConfigSchema,
  spendConfigSchema,
  tryChainSchema,
  areaSchema,
  assessedLevelSchema,
  assessmentSchema,
  assessPolicySchema,
  assessReasonSchema,
  canaryResultSchema,
  categorySchema,
  cellResourceSchema,
  certaintySchema,
  channelDescriptorSchema,
  channelIdSchema,
  checkWith,
  contactConfigSchema,
  copyListenSchema,
  copyBillingConfigSchema,
  copyPeerSchema,
  copySettingsSchema,
  correlationKeySchema,
  coverageSchema,
  cursorSchema,
  deliverySchema,
  deliveryStateSchema,
  deliveryStatusSchema,
  durationSchema,
  escalationPolicySchema,
  escalationStepSchema,
  fetchFailureSchema,
  fetchOutcomeSchema,
  fetchRecordSchema,
  healthStateSchema,
  incidentSchema,
  instantSchema,
  isContactUrl,
  kindClassSchema,
  kindCodeSchema,
  kindSchema,
  latenessLimitSchema,
  latenessSchema,
  latenessStateSchema,
  levelRuleSchema,
  levelSchema,
  levelTableSchema,
  linkFamilySchema,
  linkPolicySchema,
  locateOutcomeSchema,
  mapProblemSchema,
  mapResultSchema,
  messageSchema,
  observationIdSchema,
  observationSchema,
  operationSchema,
  parseConfig,
  parseCopySettings,
  personConfigSchema,
  personIdSchema,
  personWatchSchema,
  placeConfigSchema,
  placeIdSchema,
  positionSchema,
  quietWindowSchema,
  receiptSchema,
  regionCodeSchema,
  reportIdSchema,
  reportSchema,
  responseTypeSchema,
  schemaOf,
  secretRefSchema,
  sendOutcomeSchema,
  severitySchema,
  significanceSchema,
  sourceDescriptorSchema,
  sourceHealthSchema,
  sourceIdSchema,
  statusSchema,
  subjectSchema,
  subjectWatchSchema,
  transportSchema,
  urgencySchema,
  watchedPlaceSchema,
  watchSchema,
  whyLimitSchema,
} from "./schemas.ts";
import { DRILL_SUBJECT, NO_SYSTEM_LINES, SOURCE_SUBJECT, systemReports } from "./system-reports.ts";
import { categoryOf, TAXONOMY } from "./taxonomy.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const HOUR = 3_600_000;
const T0 = 1_763_157_600_000;
const API = "nws-api" as SourceId;
const PUSHOVER = "pushover" as ChannelId;
const PERSON = "person:a" as PersonId;

// A public place in Kansas: Sedgwick County KS, in the area of the NWS office KICT.
const KANSAS: WatchedPlace = {
  id: "place:a" as PlaceId,
  at: [-97.46, 37.68],
  codes: [
    { system: "ugc", code: "KSZ083" },
    { system: "ugc", code: "KSC173" },
    { system: "same", code: "020173" },
    { system: "state", code: "KS" },
  ],
  bufferKm: 5,
};

// A public place in Texas: Bexar County TX, in the area of the NWS office KEWX.
const TEXAS: WatchedPlace = { id: "place:b" as PlaceId, codes: [{ system: "ugc", code: "TXC029" }, { system: "same", code: "048029" }], bufferKm: 0 };

const DESCRIPTOR: SourceDescriptor = {
  id: API,
  title: "NWS API",
  origins: ["nws"],
  dependsOn: ["provider:nws-api", "cdn:akamai"],
  uses: ["internet", "dns", "power"],
  kinds: ["met"],
  coverage: [{ type: "code", system: "state", code: "KS" }],
  transport: "poll",
  interval: 60_000,
  slowAfter: 10_000,
  auth: "none",
  canary: "The national feed has one active alert or more.",
};

const CHANNEL: ChannelDescriptor = {
  id: PUSHOVER,
  title: "Pushover",
  dependsOn: ["provider:pushover", "provider:apns"],
  uses: ["internet", "dns", "power"],
  breaksThrough: true,
  repeats: true,
  ack: "poll",
  maxTitle: 250,
  maxBody: 1024,
};

const OBSERVATION: Observation = {
  id: observationId({ source: API, contentType: "application/geo+json", body: "{}", url: "https://api.weather.gov/alerts/active?area=KS" }),
  source: API,
  fetched: T0,
  contentType: "application/geo+json",
  body: "{}",
  transport: { url: "https://api.weather.gov/alerts/active?area=KS", status: 200, latency: 120, etag: "W/\"1\"" },
};

// A tornado warning of the NWS office KICT for Sedgwick County KS.
const WARNING: Report = {
  id: reportId({ source: API, key: "urn:oid:2.49.0.1.840.0.kict.1", sent: T0 }),
  source: API,
  origin: "nws",
  key: "urn:oid:2.49.0.1.840.0.kict.1",
  references: [],
  correlation: [{ system: "vtec", id: "KICT.TO.W.0012.2025" }],
  status: "actual",
  op: "alert",
  kind: { code: "met.tornado", significance: "warning", label: "Tornado Warning" },
  categories: ["met"],
  severity: "extreme",
  urgency: "immediate",
  certainty: "observed",
  response: ["shelter"],
  sent: T0,
  received: T0 + 1_000,
  effective: T0,
  onset: T0,
  expires: T0 + HOUR,
  areas: [
    { type: "polygon", rings: [[[-97.5, 37.6], [-97.3, 37.6], [-97.3, 37.8], [-97.5, 37.6]]] },
    { type: "code", system: "ugc", code: "KSC173" },
    { type: "code", system: "same", code: "020173" },
  ],
  areaText: "Sedgwick, KS",
  about: [],
  sender: "NWS Wichita KS",
  headline: "Tornado Warning issued for Sedgwick County KS",
  description: "A tornado is on the ground.",
  instruction: "Take shelter now.",
  web: "https://www.weather.gov/ict",
  observation: OBSERVATION.id,
  parameters: { VTEC: ["/O.NEW.KICT.TO.W.0012.2025/"], WEAHandling: ["Imminent Threat"] },
};

const OPERATOR: PersonWatch = {
  person: PERSON,
  places: [KANSAS.id, TEXAS.id],
  subjects: [{ system: SOURCE_SUBJECT }],
  rules: [{ places: [TEXAS.id], kinds: ["met"], max: "urgent" }],
  quiet: { zone: "America/Chicago", start: "22:00", end: "07:00" },
};

const ESCALATION: EscalationPolicy = { level: "life-safety", steps: [{ channel: PUSHOVER, at: 0 }], exhaustedAfter: 10 * 60_000 };

// The schema refuses the value.
function fails(schema: z.ZodType, value: unknown): void {
  expect(schema.safeParse(value).success).toBe(false);
}

// The schema accepts the value, also after a trip through JSON, and gives the same value.
function holds(schema: z.ZodType, value: unknown): void {
  expect(schema.parse(value)).toEqual(value);
  expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
}

describe("the type of each schema", () => {
  it("is exactly its contract", () => {
    expectTypeOf<z.output<typeof instantSchema>>().toEqualTypeOf<Instant>();
    expectTypeOf<z.output<typeof durationSchema>>().toEqualTypeOf<Duration>();
    expectTypeOf<z.output<typeof sourceIdSchema>>().toEqualTypeOf<SourceId>();
    expectTypeOf<z.output<typeof channelIdSchema>>().toEqualTypeOf<ChannelId>();
    expectTypeOf<z.output<typeof observationIdSchema>>().toEqualTypeOf<ObservationId>();
    expectTypeOf<z.output<typeof reportIdSchema>>().toEqualTypeOf<ReportId>();
    expectTypeOf<z.output<typeof personIdSchema>>().toEqualTypeOf<PersonId>();
    expectTypeOf<z.output<typeof placeIdSchema>>().toEqualTypeOf<PlaceId>();
    expectTypeOf<z.output<typeof statusSchema>>().toEqualTypeOf<Status>();
    expectTypeOf<z.output<typeof operationSchema>>().toEqualTypeOf<Operation>();
    expectTypeOf<z.output<typeof severitySchema>>().toEqualTypeOf<Severity>();
    expectTypeOf<z.output<typeof urgencySchema>>().toEqualTypeOf<Urgency>();
    expectTypeOf<z.output<typeof certaintySchema>>().toEqualTypeOf<Certainty>();
    expectTypeOf<z.output<typeof responseTypeSchema>>().toEqualTypeOf<ResponseType>();
    expectTypeOf<z.output<typeof categorySchema>>().toEqualTypeOf<Category>();
    expectTypeOf<z.output<typeof significanceSchema>>().toEqualTypeOf<Significance>();
    expectTypeOf<z.output<typeof kindSchema>>().toEqualTypeOf<Kind>();
    expectTypeOf<z.output<typeof positionSchema>>().toEqualTypeOf<Position>();
    expectTypeOf<z.output<typeof regionCodeSchema>>().toEqualTypeOf<RegionCode>();
    expectTypeOf<z.output<typeof areaSchema>>().toEqualTypeOf<Area>();
    expectTypeOf<z.output<typeof subjectSchema>>().toEqualTypeOf<Subject>();
    expectTypeOf<z.output<typeof correlationKeySchema>>().toEqualTypeOf<CorrelationKey>();
    expectTypeOf<z.output<typeof observationSchema>>().toEqualTypeOf<Observation>();
    expectTypeOf<z.output<typeof reportSchema>>().toEqualTypeOf<Report>();
    expectTypeOf<z.output<typeof transportSchema>>().toEqualTypeOf<Transport>();
    expectTypeOf<z.output<typeof cellResourceSchema>>().toEqualTypeOf<CellResource>();
    expectTypeOf<z.output<typeof sourceDescriptorSchema>>().toEqualTypeOf<SourceDescriptor>();
    expectTypeOf<z.output<typeof watchedPlaceSchema>>().toEqualTypeOf<WatchedPlace>();
    expectTypeOf<z.output<typeof watchSchema>>().toEqualTypeOf<Watch>();
    expectTypeOf<z.output<typeof cursorSchema>>().toEqualTypeOf<Cursor>();
    expectTypeOf<z.output<typeof fetchFailureSchema>>().toEqualTypeOf<FetchFailure>();
    expectTypeOf<z.output<typeof fetchOutcomeSchema>>().toEqualTypeOf<FetchOutcome>();
    expectTypeOf<z.output<typeof mapProblemSchema>>().toEqualTypeOf<MapProblem>();
    expectTypeOf<z.output<typeof mapResultSchema>>().toEqualTypeOf<MapResult>();
    expectTypeOf<z.output<typeof canaryResultSchema>>().toEqualTypeOf<CanaryResult>();
    expectTypeOf<z.output<typeof fetchRecordSchema>>().toEqualTypeOf<FetchRecord>();
    expectTypeOf<z.output<typeof locateOutcomeSchema>>().toEqualTypeOf<LocateOutcome>();
    expectTypeOf<z.output<typeof healthStateSchema>>().toEqualTypeOf<HealthState>();
    expectTypeOf<z.output<typeof sourceHealthSchema>>().toEqualTypeOf<SourceHealth>();
    expectTypeOf<z.output<typeof coverageSchema>>().toEqualTypeOf<Coverage>();
    expectTypeOf<z.output<typeof incidentSchema>>().toEqualTypeOf<Incident>();
    expectTypeOf<z.output<typeof levelSchema>>().toEqualTypeOf<Level>();
    expectTypeOf<z.output<typeof channelDescriptorSchema>>().toEqualTypeOf<ChannelDescriptor>();
    expectTypeOf<z.output<typeof messageSchema>>().toEqualTypeOf<Message>();
    expectTypeOf<z.output<typeof whyLimitSchema>>().toEqualTypeOf<WhyLimit>();
    expectTypeOf<z.output<typeof addressSchema>>().toEqualTypeOf<Address>();
    expectTypeOf<z.output<typeof receiptSchema>>().toEqualTypeOf<Receipt>();
    expectTypeOf<z.output<typeof sendOutcomeSchema>>().toEqualTypeOf<SendOutcome>();
    expectTypeOf<z.output<typeof deliveryStateSchema>>().toEqualTypeOf<DeliveryState>();
    expectTypeOf<z.output<typeof deliveryStatusSchema>>().toEqualTypeOf<DeliveryStatus>();
    expectTypeOf<z.output<typeof escalationStepSchema>>().toEqualTypeOf<EscalationStep>();
    expectTypeOf<z.output<typeof escalationPolicySchema>>().toEqualTypeOf<EscalationPolicy>();
    expectTypeOf<z.output<typeof deliverySchema>>().toEqualTypeOf<Delivery>();
    expectTypeOf<z.output<typeof acknowledgmentSchema>>().toEqualTypeOf<Acknowledgment>();
    expectTypeOf<z.output<typeof endMarkSchema>>().toEqualTypeOf<EndMark>();
    expectTypeOf<z.output<typeof assessedLevelSchema>>().toEqualTypeOf<AssessedLevel>();
    expectTypeOf<z.output<typeof levelTableSchema>>().toEqualTypeOf<LevelTable>();
    expectTypeOf<z.output<typeof kindClassSchema>>().toEqualTypeOf<KindClass>();
    expectTypeOf<z.output<typeof assessPolicySchema>>().toEqualTypeOf<AssessPolicy>();
    expectTypeOf<z.output<typeof levelRuleSchema>>().toEqualTypeOf<LevelRule>();
    expectTypeOf<z.output<typeof quietWindowSchema>>().toEqualTypeOf<QuietWindow>();
    expectTypeOf<z.output<typeof subjectWatchSchema>>().toEqualTypeOf<SubjectWatch>();
    expectTypeOf<z.output<typeof personWatchSchema>>().toEqualTypeOf<PersonWatch>();
    expectTypeOf<z.output<typeof assessReasonSchema>>().toEqualTypeOf<AssessReason>();
    expectTypeOf<z.output<typeof assessmentSchema>>().toEqualTypeOf<Assessment>();
    expectTypeOf<z.output<typeof latenessStateSchema>>().toEqualTypeOf<LatenessState>();
    expectTypeOf<z.output<typeof latenessLimitSchema>>().toEqualTypeOf<LatenessLimit>();
    expectTypeOf<z.output<typeof latenessSchema>>().toEqualTypeOf<Lateness>();
    expectTypeOf<z.output<typeof linkFamilySchema>>().toEqualTypeOf<LinkFamily>();
    expectTypeOf<z.output<typeof linkPolicySchema>>().toEqualTypeOf<LinkPolicy>();
  });

  it("is the input type too", () => {
    expectTypeOf<z.input<typeof reportSchema>>().toEqualTypeOf<Report>();
    expectTypeOf<z.input<typeof personWatchSchema>>().toEqualTypeOf<PersonWatch>();
    expectTypeOf<z.input<typeof watchSchema>>().toEqualTypeOf<Watch>();
    expectTypeOf<z.input<typeof alertConfigSchema>>().toEqualTypeOf<AlertConfig>();
  });
});

describe("the gate of schemaOf", () => {
  interface Sample {
    readonly name: string;
    readonly size?: number;
  }

  it("accepts a schema that is exactly its type", () => {
    const sample = schemaOf<Sample>()(z.strictObject({ name: z.string(), size: z.number().exactOptional() }).readonly());
    expect(sample.parse({ name: "KSZ083" })).toEqual({ name: "KSZ083" });
  });

  it("refuses a plain optional key, a key that is not readonly, a missing key and a missing value", () => {
    // @ts-expect-error A plain optional key gives `size?: number | undefined`, not `size?: number`.
    schemaOf<Sample>()(z.strictObject({ name: z.string(), size: z.number().optional() }).readonly());
    // @ts-expect-error An object with no `.readonly()` has keys that are not readonly.
    schemaOf<Sample>()(z.strictObject({ name: z.string(), size: z.number().exactOptional() }));
    // @ts-expect-error The schema has no key `size`.
    schemaOf<Sample>()(z.strictObject({ name: z.string() }).readonly());
    // @ts-expect-error The enum has no value `test`.
    schemaOf<Status>()(z.enum(["actual", "exercise", "system", "draft"]));
  });
});

// The names of the exported schemas, in the order of the code units. Two changes that each add a name merge into the
// correct list, or into a conflict of the text. Two changes that each add 1 to a count merge into a wrong count.
const SCHEMA_NAMES = [
  "acknowledgmentSchema",
  "addressFieldSchema",
  "addressSchema",
  "addressValueSchema",
  "alertAreaSchema",
  "alertConfigSchema",
  "areaSchema",
  "assessPolicySchema",
  "assessReasonSchema",
  "assessedLevelSchema",
  "assessmentSchema",
  "balanceHealthSchema",
  "balanceReadSchema",
  "balanceStageSchema",
  "canaryResultSchema",
  "categorySchema",
  "cellResourceSchema",
  "certaintySchema",
  "chainConfigSchema",
  "chainSubjectSchema",
  "channelDescriptorSchema",
  "channelDownConfigSchema",
  "channelFailureKindSchema",
  "channelHealthSchema",
  "channelIdSchema",
  "channelQuotaSchema",
  "channelRunSchema",
  "configPartSchema",
  "contactConfigSchema",
  "copyBillingConfigSchema",
  "copyHealthSchema",
  "copyIdSchema",
  "copyListenSchema",
  "copyPeerSchema",
  "copyReadSchema",
  "copySettingsSchema",
  "copySounderDeviceSchema",
  "copySounderSchema",
  "copyStageSchema",
  "correlationKeySchema",
  "coverageSchema",
  "cursorSchema",
  "deliverySchema",
  "deliveryStateSchema",
  "deliveryStatusSchema",
  "dimensionIdSchema",
  "driftCommandConfigSchema",
  "driftConfigSchema",
  "drillConfigSchema",
  "drillPathSchema",
  "drillWindowSchema",
  "durationSchema",
  "edgeKindSchema",
  "edgeOriginSchema",
  "endMarkSchema",
  "escalationEndSchema",
  "escalationPolicySchema",
  "escalationStepSchema",
  "estimateSchema",
  "expectationConfigSchema",
  "expectedHarmSchema",
  "fetchFailureSchema",
  "fetchOutcomeSchema",
  "fetchRecordSchema",
  "healthPayloadSchema",
  "healthStateSchema",
  "historyChangeSchema",
  "historyIncidentSchema",
  "historyPayloadSchema",
  "historyPlaceSchema",
  "historyRegionSchema",
  "incidentLineSchema",
  "incidentSchema",
  "indicatorAreaKindSchema",
  "indicatorAreaSchema",
  "installedPackageSchema",
  "instantSchema",
  "interestDefaultsConfigSchema",
  "interestEdgeSchema",
  "interestGraphSchema",
  "interestRowSchema",
  "interestsPayloadSchema",
  "interestsPersonSchema",
  "kindClassSchema",
  "kindCodeSchema",
  "kindPriorSchema",
  "kindSchema",
  "latenessLimitSchema",
  "latenessSchema",
  "latenessStateSchema",
  "levelRuleSchema",
  "levelSchema",
  "levelTableSchema",
  "limitConfigSchema",
  "linkFamilySchema",
  "linkPolicySchema",
  "locateOutcomeSchema",
  "mapProblemSchema",
  "mapResultSchema",
  "mapShapeSchema",
  "measureDeclarationSchema",
  "messageSchema",
  "moveSchema",
  "muteEffectSchema",
  "muteSchema",
  "nodeKeySchema",
  "observationIdSchema",
  "observationSchema",
  "operationSchema",
  "optInConfigSchema",
  "outageConfigSchema",
  "outagePersonConfigSchema",
  "ownBaselineSchema",
  "personConfigSchema",
  "personIdSchema",
  "personWatchSchema",
  "placeConfigSchema",
  "placeIdSchema",
  "positionSchema",
  "probabilitySchema",
  "providerBalanceSchema",
  "quietWindowSchema",
  "quotaHealthSchema",
  "quotaStageSchema",
  "rankDelaysSchema",
  "readHealthSchema",
  "readingSchema",
  "receiptSchema",
  "regionCodeSchema",
  "relevancePathSchema",
  "relevancePolicySchema",
  "relevanceSchema",
  "reportIdSchema",
  "reportSchema",
  "responseTypeSchema",
  "scoreFactorSchema",
  "scorePriorsSchema",
  "scoreRuleSchema",
  "secretRefSchema",
  "sendLimitConfigSchema",
  "sendOutcomeSchema",
  "severitySchema",
  "shadowScoreSchema",
  "significanceSchema",
  "softwareMatchSchema",
  "softwarePartSchema",
  "softwareStackSchema",
  "sourceClearConfigSchema",
  "sourceDescriptorSchema",
  "sourceHealthSchema",
  "sourceHealthViewSchema",
  "sourceIdSchema",
  "spendConfigSchema",
  "statusSchema",
  "subjectEntrySchema",
  "subjectKindSchema",
  "subjectSchema",
  "subjectWatchSchema",
  "tellConfigSchema",
  "tellSiteSchema",
  "throttleConfigSchema",
  "transportSchema",
  "tryChainSchema",
  "underPriorSchema",
  "urgencySchema",
  "watchSchema",
  "watchedPlaceSchema",
  "whyLimitSchema",
  "whyRecordSchema",
] as const;

describe("the JSON Schema of each schema", () => {
  const exported = Object.entries(schemas).filter(([name]) => name.endsWith("Schema"));

  it("has each exported schema", () => {
    expect(exported.map(([name]) => name).sort()).toEqual([...SCHEMA_NAMES]);
    for (const [name, schema] of exported) expect(schema instanceof z.ZodType, name).toBe(true);
  });

  it("converts each schema with no error", () => {
    for (const [name, schema] of exported) {
      if (!(schema instanceof z.ZodType)) throw new Error(`${name} is not a schema.`);
      expect(() => z.toJSONSchema(schema), name).not.toThrow();
    }
  });

  it("closes each object and keeps the bounds", () => {
    expect(z.toJSONSchema(regionCodeSchema)).toMatchObject({ type: "object", additionalProperties: false, required: ["system", "code"] });
    expect(z.toJSONSchema(reportIdSchema)).toMatchObject({ type: "string", minLength: 1 });
    expect(z.toJSONSchema(durationSchema)).toMatchObject({ type: "number", minimum: 0 });
    expect(z.toJSONSchema(kindSchema)).toMatchObject({ required: ["code", "label"] });
  });

  it("gives the closed list of the kind codes, and the parse takes exactly the codes of the list", () => {
    const codes = Object.keys(TAXONOMY);
    const covered = codes.filter((code) => categoryOf(code) !== "system").map((code) => `${COVERAGE_KIND}.${code}`);
    const json = z.toJSONSchema(kindCodeSchema) as { $ref?: string; $defs?: Record<string, { type?: string; enum?: string[] }> };
    expect(json.$ref).toBe("#/$defs/KindCode");
    expect(json.$defs?.["KindCode"]?.type).toBe("string");
    const list = json.$defs?.["KindCode"]?.enum ?? [];
    expect(list.length).toBe(codes.length + covered.length);
    expect(new Set(list)).toEqual(new Set([...codes, ...covered]));
    expect(list).toEqual([...list].sort());
    const inList = new Set(list);
    const near = list.flatMap((code) => [code, `${code}.x`, code.slice(0, -1), code.toUpperCase(), `${COVERAGE_KIND}.${code}`]);
    for (const code of [...near, "", "toString", "__proto__"]) expect(kindCodeSchema.safeParse(code).success, code).toBe(inList.has(code));
  });

  it("puts the list one time in $defs, and each kind field refers to it", () => {
    const list = (z.toJSONSchema(kindCodeSchema) as { $defs?: Record<string, { enum?: string[] }> }).$defs?.["KindCode"]?.enum ?? [];
    expect(list).toContain("met.tornado");
    const config = z.toJSONSchema(alertConfigSchema) as { $defs?: Record<string, { enum?: string[] }> };
    expect(config.$defs?.["KindCode"]?.enum).toEqual(list);
    const text = JSON.stringify(config);
    expect(text.split(JSON.stringify(list)).length - 1).toBe(1);
    expect(text).toContain('"$ref":"#/$defs/KindCode"');
    const priors = JSON.stringify(z.toJSONSchema(schemas.scorePriorsSchema));
    expect(priors).toContain('"propertyNames":{"$ref":"#/$defs/KindCode"}');
  });
});

describe("the round trip of real values", () => {
  it("accepts the values of the source and the channel contracts", () => {
    holds(sourceDescriptorSchema, DESCRIPTOR);
    holds(sourceDescriptorSchema, { ...DESCRIPTOR, coverage: "global", maxQuiet: HOUR });
    holds(sourceDescriptorSchema, { ...DESCRIPTOR, listing: "snapshot" });
    fails(sourceDescriptorSchema, { ...DESCRIPTOR, listing: "stream" });
    holds(channelDescriptorSchema, CHANNEL);
    holds(channelDescriptorSchema, { ...CHANNEL, maxInFlight: 2 });
    fails(channelDescriptorSchema, { ...CHANNEL, maxInFlight: 0 });
    fails(channelDescriptorSchema, { ...CHANNEL, maxInFlight: 1.5 });
    holds(channelDescriptorSchema, { ...CHANNEL, why: { chars: 80 } });
    fails(channelDescriptorSchema, { ...CHANNEL, why: { chars: 0 } });
    // The levels of an acknowledgment need a channel that tells of one (AL-21).
    holds(channelDescriptorSchema, { ...CHANNEL, ack: "poll", ackLevels: ["life-safety"] });
    holds(channelDescriptorSchema, { ...CHANNEL, ack: "none", ackLevels: [] });
    fails(channelDescriptorSchema, { ...CHANNEL, ack: "none", ackLevels: ["life-safety"] });
    fails(channelDescriptorSchema, { ...CHANNEL, ack: "poll", ackLevels: ["loud"] });
    const user = { name: "user", required: true, pattern: "[A-Za-z0-9]{30}", form: "30 letters and digits" };
    holds(channelDescriptorSchema, { ...CHANNEL, address: [user, { ...user, name: "device", required: false }] });
    holds(channelDescriptorSchema, { ...CHANNEL, address: [] });
    fails(channelDescriptorSchema, { ...CHANNEL, address: [{ ...user, pattern: "[A-Z" }] });
    fails(channelDescriptorSchema, { ...CHANNEL, address: [{ ...user, name: "" }] });
    fails(channelDescriptorSchema, { ...CHANNEL, address: [{ ...user, form: "" }] });
    fails(channelDescriptorSchema, { ...CHANNEL, address: [{ ...user, extra: true }] });
    holds(whyLimitSchema, { chars: 40 });
    holds(whyLimitSchema, { words: 12 });
    holds(whyLimitSchema, { chars: 80, words: 12 });
    fails(whyLimitSchema, { chars: 1.5 });
    fails(whyLimitSchema, { words: 0 });
    fails(whyLimitSchema, { lines: 2 });
    holds(observationSchema, OBSERVATION);
    holds(reportSchema, WARNING);
    holds(mapResultSchema, { reports: [WARNING], problems: [{ path: "features[3].properties.onset", message: "The onset is not a date.", fatal: false }] });
    holds(watchSchema, { places: [KANSAS, TEXAS], kinds: ["met"] });
    holds(fetchOutcomeSchema, { ok: true, observations: [OBSERVATION], cursor: { etag: "W/\"1\"" }, complete: true });
    holds(fetchOutcomeSchema, { ok: true, observations: [], complete: true });
    holds(fetchOutcomeSchema, { ok: false, failure: { kind: "rate-limited", message: "429", retryAfter: 30_000 } });
    holds(fetchOutcomeSchema, { ok: false, failure: { kind: "auth", message: "401" } });
    holds(locateOutcomeSchema, { ok: true, codes: KANSAS.codes });
    holds(sendOutcomeSchema, { ok: true, receipt: { receipt: "r1" }, accepted: T0 });
    holds(sendOutcomeSchema, { ok: false, kind: "server", message: "500", retryAfter: 1_000 });
    holds(deliveryStatusSchema, { state: "acknowledged", at: T0, by: "iphone" });
    holds(personWatchSchema, OPERATOR);
    holds(escalationPolicySchema, ESCALATION);
  });

  it("accepts the reports, the observations and the incidents of the core", () => {
    const record: FetchRecord = { source: API, at: T0, took: 500, failure: { kind: "timeout", message: "No answer in 10 s." }, fresh: 0, fatal: 0 };
    holds(fetchRecordSchema, record);
    holds(fetchRecordSchema, { source: API, at: T0, took: 200, fresh: 3, fatal: 0, canary: { pass: true, reason: "The feed has 12 alerts." } });
    // A record can count the messages that the map skipped by design (AL-94). The count is a whole number of 0 or more.
    holds(fetchRecordSchema, { source: API, at: T0, took: 200, fresh: 1, fatal: 0, skipped: 2 });
    fails(fetchRecordSchema, { source: API, at: T0, took: 200, fresh: 1, fatal: 0, skipped: -1 });
    fails(fetchRecordSchema, { source: API, at: T0, took: 200, fresh: 1, fatal: 0, skipped: 1.5 });
    const first = observeFetch(startHealth(API, T0 - HOUR), record, DESCRIPTOR).track;
    const failing = observeFetch(first, { ...record, at: T0 + 60_000 }, DESCRIPTOR).health;
    expect(failing.state).toBe("failing");
    holds(sourceHealthSchema, failing);

    const gaps = coverage({ sources: [DESCRIPTOR], health: [failing], places: [KANSAS], kinds: ["met.tornado"] });
    expect(gaps).toHaveLength(1);
    for (const gap of gaps) holds(coverageSchema, gap);

    const step = systemReports(NO_SYSTEM_LINES, { sources: [DESCRIPTOR], health: [failing], coverage: gaps, threats: [{ place: KANSAS.id, kind: "met.tornado" }] }, T0 + 2 * 60_000);
    expect(step.reports.map((report) => report.kind.code)).toEqual(["system.coverage.met.tornado", "system.health.failing"]);
    for (const report of step.reports) holds(reportSchema, report);
    for (const observation of step.observations) holds(observationSchema, observation);

    const found = incidents(normalize({ reports: [WARNING, ...step.reports] }), T0 + 3 * 60_000);
    expect(found).toHaveLength(3);
    for (const incident of found) {
      holds(incidentSchema, incident);
      const assessment = assess(incident, OPERATOR, [KANSAS, TEXAS]);
      holds(assessmentSchema, assessment);
    }
  });

  it("accepts the sends, the deliveries and the acknowledgments of the escalation", () => {
    const incident = incidents(normalize({ reports: [WARNING] }), T0)[0]!;
    const plan = escalate({ policy: ESCALATION, person: PERSON, incident, since: T0, deliveries: [], acknowledgments: [], quiet: OPERATOR.quiet, now: T0 });
    expect(plan.sends).toHaveLength(1);
    for (const send of plan.sends) {
      const message: Message = {
        key: messageKey(send),
        person: send.person,
        level: send.level,
        title: WARNING.headline,
        body: WARNING.instruction ?? "",
        url: "https://www.weather.gov/ict",
        incident: send.incident,
        expires: T0 + HOUR,
        quiet: send.quiet,
      };
      holds(messageSchema, message);
      holds(messageSchema, { ...message, why: "Why: your place is in the area" });
      fails(messageSchema, { ...message, why: "" });
      const delivery: Delivery = { key: message.key, incident: send.incident, level: send.level, person: send.person, channel: send.channel, step: send.step, at: T0 + 500, receipt: { receipt: "r1" } };
      holds(deliverySchema, delivery);
    }
    const ack: Acknowledgment = { incident: incident.anchor, level: "life-safety", person: PERSON, at: T0 + 60_000, via: "ui" };
    holds(acknowledgmentSchema, ack);
    holds(acknowledgmentSchema, { ...ack, via: PUSHOVER });
    holds(endMarkSchema, { report: ack.incident, at: T0, ended: true });
    fails(endMarkSchema, { report: ack.incident, at: T0, ended: "yes" });
  });

  it("accepts the first policy and the lateness of the core", () => {
    holds(assessPolicySchema, DEFAULT_ASSESS_POLICY);
    const expectation = { id: "nws-to-wea", from: API, to: "ipaws" as SourceId, when: { statuses: ["actual" as const] } };
    const limit: LatenessLimit = { delay: 5 * 60_000, misses: 2 };
    holds(latenessLimitSchema, limit);
    const checks = [
      { expectation: expectation.id, report: WARNING.id, started: T0 },
      { expectation: expectation.id, report: reportId({ source: API, key: "k2", sent: T0 }), started: T0 + 60_000 },
    ];
    for (const at of [T0, T0 + HOUR]) {
      for (const entry of lateness(checks, [expectation], at, { delay: () => limit.delay, misses: () => limit.misses })) holds(latenessSchema, entry);
    }
    for (const entry of lateness(checks, [expectation], T0, limitRule({ quantile: 0.99, level: 0.95 }))) holds(latenessSchema, entry);
  });
});

describe("the value rules", () => {
  it("a report with no area, no subject and no address has no place, and the schema accepts it (AL-157)", () => {
    holds(reportSchema, { ...WARNING, areas: [{ type: "code", system: "ugc", code: "KSZ083" }], about: [] });
    holds(reportSchema, { ...WARNING, areas: [], about: [{ system: SOURCE_SUBJECT, id: "nws-api" }] });
    holds(reportSchema, { ...WARNING, areas: [], about: [] });
    holds(reportSchema, { ...WARNING, areas: [], about: [], op: "cancel", references: ["KEY-1"] });
  });

  it("a private report has one address or more, and the addresses replace the area (AL-92)", () => {
    const person = "person-1" as PersonId;
    holds(reportSchema, { ...WARNING, areas: [], about: [], addresses: [person] });
    holds(reportSchema, { ...WARNING, addresses: [person] });
    fails(reportSchema, { ...WARNING, addresses: [] });
    fails(reportSchema, { ...WARNING, addresses: [""] });
    holds(incidentSchema, { ...incidents(normalize({ reports: [WARNING] }), T0)[0], addresses: [person] });
    fails(incidentSchema, { ...incidents(normalize({ reports: [WARNING] }), T0)[0], addresses: [] });
  });

  it("the code of a kind is in the taxonomy", () => {
    fails(kindSchema, { code: "met.tornadoo", label: "Tornado Warning" });
    fails(kindSchema, { code: "system.coverage.system.health", label: "Coverage" });
    fails(reportSchema, { ...WARNING, kind: { code: "met.tornadoo", label: "Tornado Warning" } });
    holds(kindSchema, { code: "other.unknown", label: "Unknown event" });
    holds(kindSchema, { code: "system.coverage.met.flood.flash", label: "Coverage" });
  });

  it("each kind that a person or an adapter names is a code of the taxonomy, or a prefix of one by its parts", () => {
    for (const code of ["met", "met.flood", "met.flood.flash", "system.coverage.met.tornado"]) holds(kindCodeSchema, code);
    for (const code of ["met.fl", "met.tornadoes", "hydro", "", "Met.Tornado", "toString"]) fails(kindCodeSchema, code);
    holds(watchSchema, { places: [KANSAS], kinds: ["met.flood"] });
    fails(watchSchema, { places: [KANSAS], kinds: ["met.fl"] });
    fails(sourceDescriptorSchema, { ...DESCRIPTOR, kinds: ["met", "hydro"] });
    holds(levelRuleSchema, { kinds: ["met.wind"], max: "notice" });
    fails(levelRuleSchema, { kinds: ["met.tornadoo"], max: "notice" });
    holds(subjectWatchSchema, { system: "topic", id: "infra.power.outage" });
    holds(subjectWatchSchema, { system: "topic" });
    holds(subjectWatchSchema, { system: "iptc", id: "medtop:20000137" });
    fails(subjectWatchSchema, { system: "topic", id: "infra.power.outages" });
  });

  it("each id is a non-empty string", () => {
    for (const schema of [sourceIdSchema, channelIdSchema, observationIdSchema, reportIdSchema, personIdSchema, placeIdSchema]) {
      fails(schema, "");
      fails(schema, 7);
      holds(schema, "id:1");
    }
    fails(reportSchema, { ...WARNING, source: "" });
  });

  it("an instant and a duration are finite, and a duration is 0 or more", () => {
    for (const bad of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN, "1"]) {
      fails(instantSchema, bad);
      fails(durationSchema, bad);
    }
    fails(durationSchema, -1);
    holds(durationSchema, 0);
    holds(instantSchema, -1);
    fails(sourceDescriptorSchema, { ...DESCRIPTOR, interval: -60_000 });
  });

  it("a position has the longitude in [-180, 180] and the latitude in [-90, 90]", () => {
    for (const seed of SEEDS) {
      const r = random(seed);
      for (let i = 0; i < 50; i += 1) {
        const lon = r.range(-180, 180);
        const lat = r.range(-90, 90);
        expect(positionSchema.safeParse([lon, lat]).success, `seed ${seed}`).toBe(true);
        expect(positionSchema.safeParse([lon + (r.chance(0.5) ? 360 : -360), lat]).success, `seed ${seed}`).toBe(false);
        expect(positionSchema.safeParse([lon, lat + (r.chance(0.5) ? 180 : -180)]).success, `seed ${seed}`).toBe(false);
      }
    }
    holds(positionSchema, [180, -90]);
    fails(positionSchema, [-97.46]);
    fails(positionSchema, [-97.46, 37.68, 400]);
    fails(watchedPlaceSchema, { ...KANSAS, at: [37.68, -197.46] });
  });

  it("a count is an integer, 0 or more, and the count of misses is 1 or more", () => {
    const record: FetchRecord = { source: API, at: T0, took: 200, fresh: 0, fatal: 0 };
    holds(fetchRecordSchema, record);
    fails(fetchRecordSchema, { ...record, fresh: -1 });
    fails(fetchRecordSchema, { ...record, fatal: 0.5 });
    fails(assessReasonSchema, { kind: "rule", index: -1, max: "urgent" });
    holds(assessReasonSchema, { kind: "rule", index: 0, max: "urgent" });
    fails(latenessLimitSchema, { delay: 60_000, misses: 0 });
    fails(latenessLimitSchema, { delay: 60_000, misses: 1.5 });
    holds(latenessLimitSchema, { delay: 60_000, misses: 1 });
  });

  it("a quiet window can have sound rules (AL-97)", () => {
    const window = { zone: "America/Chicago", start: "22:00", end: "07:00" };
    holds(quietWindowSchema, { ...window, sounds: [{ kinds: ["system.tell.needs-you"], level: "urgent", most: 2 }] });
    holds(quietWindowSchema, { ...window, sounds: [] });
    fails(quietWindowSchema, { ...window, sounds: [{ kinds: ["met.tornado"], level: "life-safety", most: 2 }] });
    fails(quietWindowSchema, { ...window, sounds: [{ kinds: ["met.tornado"], level: "urgent", most: -1 }] });
    fails(quietWindowSchema, { ...window, sounds: [{ kinds: ["met.tornado"], level: "urgent", most: 2, extra: true }] });
  });

  it("a life-safety message is not quiet", () => {
    const message: Message = { key: "k", person: PERSON, level: "life-safety", title: "Tornado Warning", body: "Take shelter now.", incident: WARNING.id, quiet: false };
    holds(messageSchema, message);
    fails(messageSchema, { ...message, quiet: true });
    holds(messageSchema, { ...message, level: "urgent", quiet: true });
  });

  it("an incident has one report or more, from the smallest, and its anchor is the smallest", () => {
    const [a, b] = [reportId({ source: API, key: "k1", sent: T0 }), reportId({ source: API, key: "k2", sent: T0 })].sort();
    if (a === undefined || b === undefined) throw new Error("Two ids are necessary.");
    const incident: Incident = {
      anchor: a,
      reports: [a, b],
      status: "actual",
      kind: WARNING.kind,
      severity: "extreme",
      urgency: "immediate",
      certainty: "observed",
      areas: WARNING.areas,
      about: [],
      live: true,
      corroboration: 1,
    };
    holds(incidentSchema, incident);
    fails(incidentSchema, { ...incident, reports: [] });
    fails(incidentSchema, { ...incident, anchor: b });
    fails(incidentSchema, { ...incident, reports: [b, a], anchor: b });
    fails(incidentSchema, { ...incident, reports: [a, a] });
    fails(incidentSchema, { ...incident, corroboration: -1 });
  });

  it("each prefix of a kind class is a known code", () => {
    const [first] = DEFAULT_ASSESS_POLICY.classes;
    if (first === undefined) throw new Error("The first policy has a class.");
    holds(kindClassSchema, first);
    fails(kindClassSchema, { ...first, kinds: ["met.tornadoo"] });
    fails(assessPolicySchema, { ...DEFAULT_ASSESS_POLICY, classes: [{ ...first, kinds: ["hydro"] }] });
  });

  it("the failure domains outside the cell hold no resource of the cell", () => {
    fails(sourceDescriptorSchema, { ...DESCRIPTOR, dependsOn: ["provider:nws-api", "internet"] });
    fails(channelDescriptorSchema, { ...CHANNEL, dependsOn: ["power"] });
    holds(sourceDescriptorSchema, { ...DESCRIPTOR, dependsOn: [] });
  });

  it("an unknown key fails, and an optional key is absent, not undefined", () => {
    fails(reportSchema, { ...WARNING, extra: 1 });
    fails(regionCodeSchema, { system: "ugc", code: "KSZ083", label: "Sedgwick" });
    fails(kindSchema, { code: "met.tornado", significance: undefined, label: "Tornado Warning" });
    fails(areaSchema, { type: "code", system: "ugc", code: "KSZ083", place: "place:a" });
    fails(fetchFailureSchema, { kind: "auth", message: "401", retryAfter: 1_000 });
    fails(levelTableSchema, { severity: { extreme: "urgent" }, urgency: DEFAULT_ASSESS_POLICY.otherwise.urgency });
  });
});

describe("the private configuration", () => {
  // The places of the fixtures, with made-up labels. The secret holds a name, not a value.
  const CONFIG: AlertConfig = {
    format: CONFIG_FORMAT,
    places: [
      { id: KANSAS.id, label: "Place A", at: [-97.46, 37.68], codes: KANSAS.codes, bufferKm: 5, sharePosition: [API] },
      { id: TEXAS.id, label: "Place B", codes: TEXAS.codes, bufferKm: 0 },
    ],
    people: [{ watch: { person: PERSON, places: [KANSAS.id, TEXAS.id], rules: [] }, label: "Person A" }],
    contacts: [{ person: PERSON, channel: PUSHOVER, address: { user: { secret: "PUSHOVER_USER" }, device: "phone" } }],
    policies: [ESCALATION],
  };

  it("accepts a configuration, and the load takes the parsed value", () => {
    holds(alertConfigSchema, CONFIG);
    const parsed = alertConfigSchema.parse(JSON.parse(JSON.stringify(CONFIG)));
    const loaded = loadConfig(parsed, [CHANNEL], (name) => (name === "PUSHOVER_USER" ? "user-test" : undefined));
    expect(loaded.problems).toEqual([]);
    expect(loaded.recipients.map((recipient) => recipient.addresses)).toEqual([{ [PUSHOVER]: { user: "user-test", device: "phone" } }]);
  });

  it("accepts the drills, and refuses a bad day, a bad id and a path that is not a channel", () => {
    const drill = { id: "push-weekly", person: PERSON, path: { kind: "channel", channel: PUSHOVER }, every: 6 * 86_400_000, window: { zone: "America/Chicago", start: "11:00", end: "17:00", days: [6] }, ackWithin: 1_800_000 } as const;
    // The person watches the drills, thus the route sends each drill to the person.
    const watcher = { watch: { person: PERSON, places: [KANSAS.id], rules: [], subjects: [{ system: DRILL_SUBJECT }] }, label: "Person A" };
    // The failure of a drill goes at the level notice, on a channel other than the path of the drill.
    const second: ChannelDescriptor = { ...CHANNEL, id: "sms" as ChannelId, title: "SMS", ack: "none" };
    const notice = { level: "notice" as const, steps: [{ channel: second.id, at: 0 }], exhaustedAfter: 600_000 };
    const drilled = { ...CONFIG, people: [watcher], drills: [drill], policies: [ESCALATION, notice], contacts: [...CONFIG.contacts, { person: PERSON, channel: second.id, address: { to: { secret: "SMS_TO" } } }] };
    holds(alertConfigSchema, drilled);
    const parsed = alertConfigSchema.parse(JSON.parse(JSON.stringify(drilled)));
    expect(loadConfig(parsed, [CHANNEL, second], (name) => (name === "PUSHOVER_USER" || name === "SMS_TO" ? "value-test" : undefined)).problems).toEqual([]);
    holds(drillConfigSchema, { ...drill, window: { zone: "UTC", start: "09:00", end: "10:00" } });
    fails(drillConfigSchema, { ...drill, window: { ...drill.window, days: [7] } });
    fails(drillConfigSchema, { ...drill, window: { ...drill.window, days: [1.5] } });
    fails(drillConfigSchema, { ...drill, id: "Push Weekly" });
    fails(drillConfigSchema, { ...drill, path: { kind: "outage" } });
    fails(drillConfigSchema, { ...drill, every: -1 });
    holds(drillConfigSchema, { ...drill, copies: ["home", "cloud-2"] });
    fails(drillConfigSchema, { ...drill, copies: ["Home"] });
    // An empty list starts the drill in no copy. The flip is a list of one copy.
    fails(drillConfigSchema, { ...drill, copies: [] });
    holds(drillConfigSchema, { ...drill, copies: ["home"] });
  });

  it("accepts the drift checks in the settings of a copy, and refuses a bad name, an empty argv, an unknown kind and two checks with one name (AL-139)", () => {
    const command = { name: "host-a", kind: "setup", argv: ["check-host", "--check"] } as const;
    const copy: CopySettings = { format: COPY_FORMAT, id: "home", rank: 0 };
    holds(copySettingsSchema, { ...copy, drift: { commands: [command, { name: "plan.b", kind: "tofu", argv: ["plan-host"] }] } });
    // The checks are a setting of each copy. The shared configuration refuses them, because a mirror takes it from another host.
    fails(alertConfigSchema, { ...CONFIG, drift: { commands: [command] } });
    for (const drift of [{ commands: [] }, { commands: [command, { ...command, kind: "tofu" }] }, { commands: [{ ...command, argv: [] }] }, { commands: [{ ...command, name: "host a" }] }, { commands: [command], extra: 1 }]) fails(copySettingsSchema, { ...copy, drift });
    fails(driftCommandConfigSchema, { ...command, name: "host a" });
    fails(driftCommandConfigSchema, { ...command, name: "" });
    fails(driftCommandConfigSchema, { ...command, argv: [] });
    fails(driftCommandConfigSchema, { ...command, argv: [""] });
    fails(driftCommandConfigSchema, { ...command, kind: "shell" });
    fails(driftCommandConfigSchema, { ...command, shell: "check-host --check" });
    fails(driftConfigSchema, { commands: [] });
    fails(driftConfigSchema, { commands: [command, { ...command, kind: "tofu" }] });
  });

  it("checks the failure of a drill with the policy of a subject, and a real notice keeps its policy", () => {
    const drill = { id: "push-weekly", person: PERSON, path: { kind: "channel", channel: PUSHOVER }, every: 6 * 86_400_000, window: { zone: "America/Chicago", start: "11:00", end: "17:00", days: [6] }, ackWithin: 1_800_000 } as const;
    const watcher = { watch: { person: PERSON, places: [KANSAS.id], rules: [], subjects: [{ system: DRILL_SUBJECT }] }, label: "Person A" };
    const second: ChannelDescriptor = { ...CHANNEL, id: "sms" as ChannelId, title: "SMS", ack: "none" };
    // The notices of the person go only on the channel of the drill. Thus the failure of the drill sends nothing.
    const notice = { level: "notice" as const, steps: [{ channel: PUSHOVER, at: 0 }], exhaustedAfter: 600_000 };
    const contacts = [...CONFIG.contacts, { person: PERSON, channel: second.id, address: { to: { secret: "SMS_TO" } } }];
    const secret = (name: string): string | undefined => (name === "PUSHOVER_USER" || name === "SMS_TO" ? "value-test" : undefined);
    const load = (policies: readonly unknown[]) => loadConfig(alertConfigSchema.parse(JSON.parse(JSON.stringify({ ...CONFIG, people: [watcher], drills: [drill], policies, contacts }))), [CHANNEL, second], secret).problems;
    expect(load([ESCALATION, notice])).toEqual([
      `The failure of the drill push-weekly reaches the person ${PERSON} at the level notice, and its policy has no step on a channel other than pushover. It sends nothing.`,
    ]);
    // A policy of notice about the drills adds a step on the second channel for the drill reports only.
    const drills = { ...notice, about: { system: DRILL_SUBJECT }, steps: [...notice.steps, { channel: second.id, at: 0 }] };
    holds(escalationPolicySchema, drills);
    expect(load([ESCALATION, notice, drills])).toEqual([]);
    fails(escalationPolicySchema, { ...drills, about: { id: "push-weekly" } });
    fails(escalationPolicySchema, { ...drills, about: { system: DRILL_SUBJECT, extra: 1 } });
  });

  it("refuses a wrong form, and leaves the references to the load", () => {
    fails(alertConfigSchema, { ...CONFIG, format: "alerts-config/2" });
    fails(alertConfigSchema, { ...CONFIG, extra: 1 });
    fails(alertConfigSchema, { ...CONFIG, contacts: undefined });
    fails(secretRefSchema, { secret: "" });
    // A reference to a secret does not hold its value.
    fails(addressValueSchema, { secret: "PUSHOVER_USER", value: "user-test" });
    fails(addressValueSchema, 7);
    fails(contactConfigSchema, { person: PERSON, channel: PUSHOVER, address: { user: 7 } });
    fails(placeConfigSchema, { id: KANSAS.id, codes: KANSAS.codes, bufferKm: 0 });
    fails(personConfigSchema, { watch: { person: PERSON, places: [], rules: [] }, policies: [{ ...ESCALATION, level: "loud" }] });
    fails(alertConfigSchema, { ...CONFIG, expectations: [{ id: "api-to-wea", since: "2026-11-16" }] });
    fails(alertConfigSchema, { ...CONFIG, expectations: [{ id: "api-to-wea" }] });
    fails(expectationConfigSchema, { id: "api-to-wea", since: 0, extra: 1 });
    holds(alertConfigSchema, { ...CONFIG, expectations: [{ id: "api-to-wea", since: 1_794_700_000_000 }] });
    // A person who watches a place that the configuration does not have is a problem of the load, not of the form.
    holds(alertConfigSchema, { ...CONFIG, people: [{ watch: { person: PERSON, places: ["place:z"], rules: [] } }] });
  });

  it("checks the form of a spend entry, and leaves the provider, the reserve and the time zone to the load", () => {
    const spend = { provider: "provider:pushover", monthlyUsd: 10, reserveUsd: 3, floor: 5, timeZone: "America/Chicago" };
    holds(alertConfigSchema, { ...CONFIG, spend: [spend] });
    const { reserveUsd: _reserve, ...noReserve } = spend;
    holds(spendConfigSchema, { ...noReserve, floor: -1 });
    holds(spendConfigSchema, { ...spend, floor: [5, 2] });
    for (const floor of [[], ["5"], [5, Number.NaN]]) fails(spendConfigSchema, { ...spend, floor });
    fails(spendConfigSchema, { ...spend, reserveUsd: undefined });
    for (const bad of [{ monthlyUsd: 0 }, { monthlyUsd: -1 }, { reserveUsd: -1 }, { floor: "5" }, { timeZone: "" }, { provider: "" }, { currency: "USD" }]) fails(spendConfigSchema, { ...spend, ...bad });
    // A reserve above the cap and a bad zone are problems of the load, with the names of the fields.
    holds(spendConfigSchema, { ...spend, reserveUsd: 20, timeZone: "Mars/Olympus" });
    // The fixed costs: each one has a name and a cost of 0 or more. Fixed costs above the cap are a problem of the load.
    holds(spendConfigSchema, { ...spend, fixed: [{ what: "toll-free number", usd: 2.15 }, { what: "free", usd: 0 }] });
    holds(spendConfigSchema, { ...spend, fixed: [{ what: "rent", usd: 50 }] });
    for (const bad of [[{ what: "", usd: 1 }], [{ what: "rent", usd: -1 }], [{ what: "rent" }], [{ what: "rent", usd: 1, extra: 1 }], {}]) fails(spendConfigSchema, { ...spend, fixed: bad });
  });

  it("checks the form of a watch of a limit, and leaves the ids and the limit of a user to the load (AL-111)", () => {
    const limit = { id: "github:example/actions", provider: "provider:github", title: "GitHub Actions", accountKind: "organization", account: "example", products: ["actions"] };
    holds(alertConfigSchema, { ...CONFIG, limits: [limit] });
    holds(limitConfigSchema, { ...limit, accountKind: "user", monthlyUsd: 10, budget: "actions", levels: [0.5, 0.9], tokenKey: "GITHUB_BILLING_TOKEN_USER" });
    // An account of a user with no monthly limit is a problem of the load.
    holds(limitConfigSchema, { ...limit, accountKind: "user" });
    for (const bad of [{ products: [] }, { products: [""] }, { accountKind: "team" }, { monthlyUsd: 0 }, { levels: [] }, { levels: [0] }, { levels: [Number.POSITIVE_INFINITY] }, { id: "" }, { extra: 1 }, { tokenKey: "" }, { tokenKey: "github_token" }, { tokenKey: "1TOKEN" }, { tokenKey: "A-B" }]) fails(limitConfigSchema, { ...limit, ...bad });
  });

  it("checks the form of the stack of the alert chain, and leaves the stack document to the runtime (AL-90)", () => {
    const chain = { stack: { schema: "stack/1", parts: [] }, subjects: [{ system: "domain", id: "status.example.net", part: "texts" }] };
    holds(alertConfigSchema, { ...CONFIG, chain });
    holds(chainConfigSchema, { ...chain, subjects: [] });
    for (const bad of [{ system: "" }, { id: "" }, { part: "" }, { extra: 1 }]) fails(chainSubjectSchema, { ...chain.subjects[0], ...bad });
    for (const bad of [{ stack: [] }, { stack: "stack/1" }, { subjects: undefined }, { extra: 1 }]) fails(chainConfigSchema, { ...chain, ...bad });
  });

  it("checks the form of the outage call, and leaves the people and the channels to the load", () => {
    const outage = { people: [{ person: PERSON, chain: { steps: ["twilio-call", "twilio-call"] } }] };
    holds(alertConfigSchema, { ...CONFIG, outage });
    holds(outageConfigSchema, { people: [] });
    holds(tryChainSchema, { steps: [] });
    fails(alertConfigSchema, { ...CONFIG, outage: undefined });
    fails(outageConfigSchema, { people: [{ person: PERSON }] });
    fails(outageConfigSchema, { people: [{ person: PERSON, chain: { steps: ["twilio-call"] }, to: "x" }] });
    fails(outagePersonConfigSchema, { person: PERSON, chain: { steps: [7] } });
    fails(tryChainSchema, { steps: "twilio-call" });
  });

  it("checks the form of the settings of a copy", () => {
    const home: CopySettings = { format: COPY_FORMAT, id: "home", rank: 0, listen: { host: "100.64.0.1", port: 4751 }, peers: [{ id: "cloud", url: "http://cloud.example.ts.net:4751" }], pingKey: "HEALTHCHECKS_PING_URL_HOME" };
    holds(copySettingsSchema, home);
    holds(copySettingsSchema, ONLY_COPY);
    holds(copySettingsSchema, { ...home, accounts: { nwws: 2 } });
    holds(copySettingsSchema, { ...home, configFrom: "cloud" });
    for (const configFrom of ["Cloud", "", 2]) fails(copySettingsSchema, { ...home, configFrom });
    holds(copySettingsSchema, { ...home, leaveChannels: ["webhook"] });
    for (const leaveChannels of ["webhook", [""], [2]]) fails(copySettingsSchema, { ...home, leaveChannels });
    holds(copySettingsSchema, { ...home, leaveSources: ["gdelt"] });
    for (const leaveSources of ["gdelt", [""], [2]]) fails(copySettingsSchema, { ...home, leaveSources });
    // The sounder of a copy (AL-41): each device has a program, and each count is a whole number.
    const desk = { sound: ["beep-tool", "--short"] };
    holds(copySettingsSchema, { ...home, sounder: { devices: { desk } } });
    holds(copySettingsSchema, { ...home, sounder: { devices: { desk: { ...desk, levels: { "life-safety": ["beep-tool", "--long"] }, probe: ["beep-tool", "--check"] } }, sounds: { urgent: 0 }, gapMs: 500 } });
    for (const sounder of [{ devices: {} }, { devices: { desk: { sound: [] } } }, { devices: { desk: { sound: [""] } } }, { devices: { desk: { ...desk, levels: { loud: ["x"] } } } }, { devices: { desk }, sounds: { urgent: 1.5 } }, { devices: { desk }, gapMs: -1 }, { devices: { desk }, extra: 1 }])
      fails(copySettingsSchema, { ...home, sounder });
    for (const accounts of [{ nwws: 0 }, { nwws: 1.5 }, { nwws: "2" }, { "": 2 }, []]) fails(copySettingsSchema, { ...home, accounts });
    holds(copyListenSchema, { host: "home.example.ts.net", port: 65535 });
    holds(copyPeerSchema, { id: "c-2", url: "https://[fd7a:115c::1]:4751/exchange" });
    for (const bad of [{ format: "alerts-copy/2" }, { id: "Home" }, { id: "" }, { id: "-home" }, { id: "a".repeat(33) }, { rank: -1 }, { rank: 0.5 }, { pingKey: "lower" }, { pingKey: "" }, { extra: 1 }]) fails(copySettingsSchema, { ...home, ...bad });
    for (const bad of [{ port: 0 }, { port: 65536 }, { port: 1.5 }, { host: "" }]) fails(copyListenSchema, { host: "100.64.0.1", port: 4751, ...bad });
    for (const url of ["ftp://cloud.example:4751", "http://user@cloud.example:4751", "http://cloud.example:4751/?q=1", "http://cloud.example:4751/#f", "cloud.example:4751", "http://", "http://-cloud.example"]) fails(copyPeerSchema, { id: "cloud", url });
  });

  it("checks the billing read of the host of another copy (AL-70)", () => {
    const billing = { argv: ["cloudctl", "billing", "describe", "--format=json"], field: "billing.enabled", stoppedWhen: [false] };
    const peer = { id: "cloud", url: "http://cloud.example.ts.net:4751", billing };
    holds(copyPeerSchema, peer);
    holds(copySettingsSchema, { format: COPY_FORMAT, id: "home", rank: 0, peers: [peer] });
    holds(copyBillingConfigSchema, { ...billing, field: "state", stoppedWhen: ["CLOSED", "SUSPENDED", 0] });
    for (const bad of [{ argv: [] }, { argv: [""] }, { argv: "cloudctl" }, { field: "" }, { field: "a..b" }, { field: ".a" }, { field: "a b" }, { field: "a[0]" }, { stoppedWhen: [] }, { stoppedWhen: [null] }, { stoppedWhen: [{}] }, { stoppedWhen: false }, { extra: 1 }]) fails(copyBillingConfigSchema, { ...billing, ...bad });
    fails(copyPeerSchema, { ...peer, billing: { argv: ["cloudctl"] } });
  });

  it("finds the problems of the ranks, the ids and the address of a copy, and the problems hold no URL", () => {
    const listen = { host: "100.64.0.1", port: 4751 };
    const url = "http://cloud.example.ts.net:4751";
    const base: CopySettings = { format: COPY_FORMAT, id: "home", rank: 1, listen, peers: [{ id: "cloud", url }] };
    expect(copyProblems(base)).toEqual([]);
    expect(copyProblems(ONLY_COPY)).toEqual([]);
    // The copy configFrom is a copy of peers, not this copy and not an unknown copy.
    expect(copyProblems({ ...base, configFrom: "cloud" })).toEqual([]);
    expect(copyProblems({ ...base, configFrom: "home" })).toEqual(["configFrom: the id is not the id of a copy in peers."]);
    expect(copyProblems({ ...base, configFrom: "other" })).toHaveLength(1);
    // A copy leaves a channel only to other copies, and it names each channel one time (AL-55).
    const webhook = "webhook" as ChannelId;
    expect(copyProblems({ ...base, leaveChannels: [webhook] })).toEqual([]);
    expect(copyProblems({ ...base, leaveChannels: [webhook, PUSHOVER, webhook] })).toEqual(["leaveChannels[2]: the channel webhook is in the list already."]);
    expect(copyProblems({ format: COPY_FORMAT, id: "home", rank: 0, leaveChannels: [webhook] })).toEqual([
      "leaveChannels: a copy with no other copies sends on each channel. Thus it leaves no channel.",
    ]);
    // A copy leaves a source only to other copies, and it names each source one time (AL-160).
    const gdelt = "gdelt" as SourceId;
    expect(copyProblems({ ...base, leaveSources: [gdelt] })).toEqual([]);
    expect(copyProblems({ ...base, leaveSources: [gdelt, gdelt] })).toEqual(["leaveSources[1]: the source gdelt is in the list already."]);
    expect(copyProblems({ format: COPY_FORMAT, id: "home", rank: 0, leaveSources: [gdelt] })).toEqual([
      "leaveSources: a copy with no other copies reads each source. Thus it leaves no source.",
    ]);
    // A rank is lower than the count of the copies.
    expect(copyProblems({ ...base, rank: 2 })).toHaveLength(1);
    expect(copyProblems({ format: COPY_FORMAT, id: "home", rank: 1 })).toHaveLength(1);
    // A repeated id, the id of this copy, and a repeated URL.
    const repeated = copyProblems({ ...base, peers: [{ id: "cloud", url }, { id: "cloud", url: `${url}/b` }, { id: "home", url }] });
    expect(repeated).toHaveLength(3);
    // A copy with other copies listens, and not on all the interfaces.
    expect(copyProblems({ format: COPY_FORMAT, id: "home", rank: 0, peers: [{ id: "cloud", url }] })).toHaveLength(1);
    for (const host of ["0.0.0.0", "::", "[::]", "*"]) expect(copyProblems({ ...base, listen: { host, port: 4751 } })).toHaveLength(1);
    for (const problem of [...repeated, ...copyProblems({ ...base, listen: { host: "0.0.0.0", port: 4751 } })]) {
      expect(problem).not.toContain(url);
      expect(problem).not.toContain("example");
    }
  });

  it("reads the text of copy.json: the JSON, then the schema, then the problems", () => {
    const home: CopySettings = { format: COPY_FORMAT, id: "home", rank: 0, listen: { host: "100.64.0.1", port: 4751 }, peers: [{ id: "cloud", url: "http://cloud.example.ts.net:4751" }] };
    const read = parseCopySettings(JSON.stringify(home));
    expect(read.tag).toBe("ok");
    if (read.tag === "ok") expect(read.value).toEqual(home);
    const notJson = parseCopySettings("{ id: home");
    expect(notJson).toEqual({ tag: "err", error: ["The settings of the copy are not valid JSON."] });
    const badUrl = parseCopySettings(JSON.stringify({ ...home, peers: [{ id: "cloud", url: "http://user:pass@cloud.example.ts.net:4751" }] }));
    expect(badUrl.tag).toBe("err");
    if (badUrl.tag === "err") for (const problem of badUrl.error) expect(problem).not.toContain("pass@");
    const badRank = parseCopySettings(JSON.stringify({ ...home, rank: 3 }));
    expect(badRank.tag).toBe("err");
    if (badRank.tag === "err") expect(badRank.error).toHaveLength(1);
  });

  it("checks the form of the link policy of the merge", () => {
    holds(linkPolicySchema, DEFAULT_LINK_POLICY);
    holds(alertConfigSchema, { ...CONFIG, link: DEFAULT_LINK_POLICY });
    holds(alertConfigSchema, { ...CONFIG, link: { families: [] } });
    const family = DEFAULT_LINK_POLICY.families[0]!;
    const { magnitude: _magnitude, ...noMagnitude } = family;
    holds(linkFamilySchema, noMagnitude);
    holds(linkFamilySchema, { ...family, family: "geo" });
    fails(linkFamilySchema, { ...family, magnitude: undefined });
    for (const bad of [{ windowMs: 0 }, { windowMs: -1 }, { windowMs: 1.5 }, { distanceKm: -1 }, { magnitude: -1 }, { family: "not.a.kind" }, { family: "" }, { extra: 1 }]) fails(linkFamilySchema, { ...family, ...bad });
    fails(linkPolicySchema, { families: [family], extra: 1 });
    fails(alertConfigSchema, { ...CONFIG, link: { families: [{ ...family, windowMs: 0 }] } });
  });

  it("takes a policy of the assessment, and refuses a policy with a kind that the taxonomy does not have", () => {
    holds(alertConfigSchema, { ...CONFIG, assess: DEFAULT_ASSESS_POLICY });
    holds(alertConfigSchema, { ...CONFIG, assess: { ...DEFAULT_ASSESS_POLICY, relevance: { hopCap: 2, topPaths: 1, mandatory: "absent", entryMax: "notice" } } });
    const [first, ...others] = DEFAULT_ASSESS_POLICY.classes;
    fails(alertConfigSchema, { ...CONFIG, assess: { ...DEFAULT_ASSESS_POLICY, classes: [{ ...first!, kinds: ["met.no-such-kind"] }, ...others] } });
    fails(alertConfigSchema, { ...CONFIG, assess: { ...DEFAULT_ASSESS_POLICY, extra: 1 } });
  });

  const store = (name: string): string | undefined => (name === "PUSHOVER_USER" ? "user-test" : undefined);
  const problemsOf = (text: string, secret = store): readonly string[] => {
    const parsed = parseConfig(text, [CHANNEL], secret);
    return parsed.tag === "err" ? parsed.error : [];
  };

  it("parses the JSON text of a configuration, and gives the recipients", () => {
    const parsed = parseConfig(JSON.stringify(CONFIG), [CHANNEL], store);
    expect(parsed.tag).toBe("ok");
    if (parsed.tag === "ok") {
      expect(parsed.value.config).toEqual(CONFIG);
      expect(parsed.value.recipients.map((recipient) => recipient.addresses)).toEqual([{ [PUSHOVER]: { user: "user-test", device: "phone" } }]);
    }
  });

  it("gives the problems of the JSON, of the form and of the references, each with its path", () => {
    expect(problemsOf("{")).toEqual(["The configuration is not valid JSON."]);
    // The path of a problem is its text before the first colon.
    const pathsOf = (text: string): string[] => problemsOf(text).map((problem) => problem.slice(0, problem.indexOf(": ")));
    expect(pathsOf("7")).toEqual(["(root)"]);
    const wrong = { ...CONFIG, places: [{ ...CONFIG.places[0], bufferKm: "5" }, { ...CONFIG.places[1], codes: [{ system: "ugc", code: 7 }] }] };
    expect(pathsOf(JSON.stringify(wrong))).toEqual(["places[0].bufferKm", "places[1].codes[0].code"]);
    // The form holds, and the load finds the secret that the store does not have.
    expect(problemsOf(JSON.stringify(CONFIG), () => undefined)).toEqual([expect.stringContaining("names the secret PUSHOVER_USER")]);
  });

  it("merges the parts of a configuration, and gives the problems of each part with its name", () => {
    const { places, people, contacts, ...rest } = CONFIG;
    const root = JSON.stringify({ ...rest, places: [], people: [], contacts: [] });
    const directory = { name: "directory", text: JSON.stringify({ format: CONFIG_PART_FORMAT, places, people }) };
    const addresses = { name: "addresses", text: JSON.stringify({ format: CONFIG_PART_FORMAT, contacts }) };
    const parsed = parseConfig(root, [CHANNEL], store, [directory, addresses]);
    expect(parsed.tag).toBe("ok");
    if (parsed.tag === "ok") {
      expect(parsed.value.config).toEqual(CONFIG);
      expect(configHash(parsed.value.config)).toBe(configHash(CONFIG));
    }
    // The schema refuses a field of the root in a part.
    holds(configPartSchema, { format: CONFIG_PART_FORMAT });
    fails(configPartSchema, { format: CONFIG_PART_FORMAT, policies: [] });
    fails(configPartSchema, { format: CONFIG_FORMAT, places });
    const problemsWith = (parts: readonly { name: string; text: string }[], text = root): readonly string[] => {
      const result = parseConfig(text, [CHANNEL], store, parts);
      return result.tag === "err" ? result.error : [];
    };
    expect(problemsWith([directory, { name: "addresses", text: "{" }])).toEqual(["The part addresses is not valid JSON."]);
    expect(problemsWith([directory, { name: "Bad Name", text: "{" }])).toEqual(["Part 1 is not valid JSON."]);
    expect(problemsWith([directory, { name: "addresses", text: JSON.stringify({ format: CONFIG_PART_FORMAT, contacts, drills: [] }) }])).toEqual(["The part addresses: (root): Unrecognized key: \"drills\""]);
    // The problems of the root and of each part come together, before the merge.
    expect(problemsWith([{ name: "addresses", text: "[]" }], "{")).toEqual(["The configuration is not valid JSON.", "The part addresses: (root): Invalid input: expected object, received array"]);
    // An entry in two files is a problem of the merge. A missing contact is a problem of the load.
    expect(problemsWith([directory, addresses, { name: "copy", text: JSON.stringify({ format: CONFIG_PART_FORMAT, places: [places[0]] }) }])).toEqual([
      `The place ${places[0]!.id} is in the part copy and in the part directory.`,
    ]);
    expect(problemsWith([directory])).toEqual([expect.stringContaining(PERSON)]);
  });

  it("accepts only printable ASCII in a contact, with no space, no parenthesis and no backslash", () => {
    const breaks = ["https://example.org/\r\nX: y", "https://example.org/\na", "https://example.org/\ta", "https://example.org/ a", "https://example.org/\u0000", "https://example.org/\u007f", "https://example.org/a)", "https://example.org/(a"];
    // A header with a character after ASCII stops the fetch. A backslash escapes the parenthesis that ends the comment.
    const others = ["https://exämple.org/", "https://example.org/\\", "mailto:operator@example.org "];
    for (const text of [...breaks, ...others]) expect(isContactUrl(text)).toBe(false);
    for (const text of ["https://example.org", "https://example.org/operator?topic=alerts", "HTTPS://alerts.example.org:8443/#contact", "mailto:operator@example.org", "mailto:a+b@example.org?subject=alerts"]) {
      expect(isContactUrl(text)).toBe(true);
    }
  });

  it("refuses a contact with no host, no address or another scheme", () => {
    for (const text of ["https://", "https://localhost", "https://example.org@", "https:example.org", "http://example.org", "ftp://example.org", "mailto:operator", "mailto:@example.org", "example.org"]) {
      expect(isContactUrl(text)).toBe(false);
    }
  });

  it("accepts a contact of the operator as an https URL or a mailto URL, and refuses other forms with no quote of the value", () => {
    holds(alertConfigSchema, { ...CONFIG, contact: "https://example.org/operator" });
    holds(alertConfigSchema, { ...CONFIG, contact: "mailto:operator@example.org" });
    const headerBreaks = ["https://example.org/\r\nX-PRIVATE: 1", "https://example.org/\tPRIVATE", "https://example.org/ PRIVATE", "mailto:PRIVATE@example.org\u0000", "mailto:PRIVATE@example.org\u007f"];
    const comments = ["https://example.org/PRIVATE)", "https://example.org/(PRIVATE"];
    for (const contact of ["http://example.org/PRIVATE", "PRIVATE@example.org", "", 7, ...headerBreaks, ...comments]) {
      const problems = problemsOf(JSON.stringify({ ...CONFIG, contact }));
      expect(problems).toHaveLength(1);
      expect(problems[0]?.startsWith("contact: ")).toBe(true);
      expect(problems[0]).not.toContain("PRIVATE");
    }
  });

  it("gives no value of the configuration and no value of a secret in a problem", () => {
    // Each check looks for the start of the value, because the JSON parser quotes only a part of a text.
    const prefix = "PRIVATE";
    const value = `${prefix}-VALUE`;
    // The message of the JSON parser quotes this text.
    expect(problemsOf(`{"label": ${value}}`).join(" ")).not.toContain(prefix);
    const wrong = {
      ...CONFIG,
      format: `alerts-config/${value}`,
      places: [{ ...CONFIG.places[0], label: [value], bufferKm: value, at: [500, 37.68] }],
      contacts: [{ ...CONFIG.contacts[0], address: { user: { secret: "PUSHOVER_USER", value } } }],
    };
    const problems = problemsOf(JSON.stringify(wrong));
    expect(problems.length).toBeGreaterThanOrEqual(4);
    expect(problems.join(" ")).not.toContain(prefix);
    // The load: the store holds the value of one secret, and the problem names only the other secret.
    const twoSecrets = { ...CONFIG, contacts: [{ ...CONFIG.contacts[0], address: { user: { secret: "PUSHOVER_USER" }, device: { secret: "MISSING" } } }] };
    const loadProblems = problemsOf(JSON.stringify(twoSecrets), (name) => (name === "PUSHOVER_USER" ? value : undefined));
    expect(loadProblems).toEqual([expect.stringContaining("names the secret MISSING")]);
    expect(loadProblems.join(" ")).not.toContain(prefix);
  });

  it("gives each issue of a schema with its path, and a value that holds", () => {
    expect(checkWith(secretRefSchema, { secret: "NAME" })).toEqual({ tag: "ok", value: { secret: "NAME" } });
    expect(checkWith(secretRefSchema, { secret: "" })).toEqual({ tag: "err", error: ["secret: The name of a secret is a non-empty string."] });
  });

  it("gives a JSON Schema with the format as a constant", () => {
    expect(z.toJSONSchema(alertConfigSchema)).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["format", "places", "people", "contacts", "policies"],
      properties: { format: { const: CONFIG_FORMAT } },
    });
  });
});

describe("the intake of the messages of the operator (AL-92)", () => {
  it("takes a port and a daily cap, and refuses a port out of range, a cap of 0 and a field that it does not know", () => {
    const { tellConfigSchema } = schemas;
    expect(tellConfigSchema.safeParse({ port: 4790 }).success).toBe(true);
    expect(tellConfigSchema.safeParse({ port: 4790, dailyCap: 20 }).success).toBe(true);
    expect(tellConfigSchema.safeParse({ port: 0 }).success).toBe(false);
    expect(tellConfigSchema.safeParse({ port: 65536 }).success).toBe(false);
    expect(tellConfigSchema.safeParse({ port: 4790, dailyCap: 0 }).success).toBe(false);
    expect(tellConfigSchema.safeParse({ port: 4790, host: "0.0.0.0" }).success).toBe(false);
  });

  it("takes a site with a loopback origin and a phone origin, and refuses a path, another host or an address for the phone", () => {
    const { tellConfigSchema } = schemas;
    const site = (local: string, phone: string) => tellConfigSchema.safeParse({ port: 4790, site: { local, phone } }).success;
    expect(site("http://127.0.0.1:4000", "https://site.example.net")).toBe(true);
    expect(site("http://localhost:4000", "https://site.example.net:10000")).toBe(true);
    expect(site("http://[::1]:4000", "https://site.example.net")).toBe(true);
    // The local origin is on the loopback address, with a port and no path.
    expect(site("http://site.example.net:4000", "https://site.example.net")).toBe(false);
    expect(site("http://127.0.0.1", "https://site.example.net")).toBe(false);
    expect(site("http://127.0.0.1:4000/a/", "https://site.example.net")).toBe(false);
    // The phone origin is https with a name of two labels or more, and no path.
    expect(site("http://127.0.0.1:4000", "http://site.example.net")).toBe(false);
    expect(site("http://127.0.0.1:4000", "https://localhost:4000")).toBe(false);
    expect(site("http://127.0.0.1:4000", "https://127.0.0.1:4000")).toBe(false);
    expect(site("http://127.0.0.1:4000", "https://site.example.net/a/")).toBe(false);
  });

  it("reads each dot and each bracket of an origin as itself, not as a pattern", () => {
    const { tellConfigSchema } = schemas;
    const site = (local: string, phone: string) => tellConfigSchema.safeParse({ port: 4790, site: { local, phone } }).success;
    // A dot of the phone origin is a dot, not each character.
    expect(site("http://127.0.0.1:4000", "https://exampleXnet")).toBe(false);
    expect(site("http://127.0.0.1:4000", "https://a.example.net:8443")).toBe(true);
    // The brackets of [::1] are part of the host, not a set of characters.
    expect(site("http://[::1]:8080", "https://site.example.net")).toBe(true);
    expect(site("http://:1:8080", "https://site.example.net")).toBe(false);
    expect(site("http://127x0x0x1:8080", "https://site.example.net")).toBe(false);
  });
});
