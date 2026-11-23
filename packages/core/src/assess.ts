/**
 * The first assessment of the alert system: the level of an incident for a person.
 *
 * The level is a calculation on data. The policy gives a table for each class of kinds. The table
 * gives the highest level for the severity and the highest level for the urgency, and the lower of
 * the two applies. The level for a person is the highest level at the places of the person, after the rules
 * of the person. The assessment reads no clock: the field `live` of the incident holds the time.
 */
import { inAudience, isPrivate } from "./audience.ts";
import type {
  AssessedLevel,
  AssessPolicy,
  AssessReason,
  Assessment,
  Incident,
  IncidentLine,
  Instant,
  InterestGraph,
  KindClass,
  LevelTable,
  NodeKey,
  PersonWatch,
  PlaceId,
  Position,
  RegionCode,
  Relevance,
  RelevancePolicy,
  ReportId,
  ScorePriors,
  ScoreRule,
  SubjectEntry,
  SubjectKind,
  SubjectSystem,
  SubjectWatch,
  WatchedPlace,
} from "./contracts.ts";
import { ASSESSED_LEVELS, SUBJECT_SYSTEMS, SYSTEM_SOURCE } from "./contracts.ts";
import { hasKind } from "./kind-prefix.ts";
import type { MapShape } from "./map.ts";
import { DEFAULT_ENTRY_MAX, DEFAULT_RELEVANCE_POLICY, canReach, relevance, topicEntry } from "./relevance.ts";
import { shadowScore } from "./score.ts";
import { isShape, shapeDistanceKm } from "./shapes.ts";
import { STATE_POSTAL } from "./state-codes.ts";
import { kindOfNode, nodesOverlap, placeNode, subjectNode } from "./why.ts";

export { hasKind } from "./kind-prefix.ts";

/**
 * The kinds that can reach `life-safety` in the first policy: the list of `docs/CONTRACTS.md`, as
 * prefixes of the taxonomy codes. A kind is in the list when its warning tells the people at a place
 * to act at once to save their lives. They take shelter, leave, or go to high ground.
 */
export const LIFE_SAFETY_KINDS: readonly string[] = [
  "met.tornado",
  "met.flood.flash",
  "met.wind.extreme",
  "met.tropical.hurricane",
  "met.tropical.typhoon",
  "met.surge",
  "fire.wildfire",
  "geo.tsunami",
  "geo.earthquake",
  "geo.debris-flow",
  "geo.volcano.eruption",
  "safety.national-emergency",
  "safety.evacuation",
  "safety.shelter-in-place",
  "safety.civil-danger",
  "safety.civil-emergency",
  "cbrne",
];

/**
 * The table of the kinds that can reach `life-safety`. An `unknown` severity or urgency counts as
 * high, because a miss costs more than a false alarm for these kinds.
 */
const LIFE_SAFETY_TABLE: LevelTable = {
  severity: { extreme: "life-safety", severe: "life-safety", moderate: "urgent", minor: "notice", unknown: "life-safety" },
  urgency: { immediate: "life-safety", expected: "life-safety", future: "urgent", past: "digest", unknown: "life-safety" },
};

/** The kinds of the earthquake class: the reports of the shaking after a rupture. An early warning is in the life-safety class. */
export const EARTHQUAKE_KINDS: readonly string[] = ["geo.earthquake"];

/** The time after the onset of an earthquake in which its report counts as `immediate`: one hour. */
export const EARTHQUAKE_PAST_WITHIN = 3_600_000;

/**
 * The table of an earthquake. A report of the shaking has the urgency `past`, so it counts as `immediate` in
 * `EARTHQUAKE_PAST_WITHIN` after the onset. Then the severity of the band at the place decides. The severity
 * `extreme` (MMI VIII and more) wakes the person, and `severe` (MMI VII) is `urgent`. An unknown value counts as high.
 */
const EARTHQUAKE_TABLE: LevelTable = {
  severity: { extreme: "life-safety", severe: "urgent", moderate: "notice", minor: "digest", unknown: "life-safety" },
  urgency: { immediate: "life-safety", expected: "life-safety", future: "urgent", past: "digest", unknown: "life-safety" },
  pastWithin: EARTHQUAKE_PAST_WITHIN,
};

/**
 * The kinds of context. With the default policy, a report of such a kind reaches the digest at most. It starts no
 * escalation. A feed of the service alerts of public transit holds many alerts each day. Thus only a moderate or
 * higher severity reaches the digest, and a minor alert stays in the map and the log.
 *
 * The count of its alerts is an indicator reading. A policy of the configuration can give the kinds a different level.
 */
export const CONTEXT_KINDS: readonly string[] = ["transport.transit"];

/**
 * The table of the kinds of context. It gives `digest` at most. A minor or unknown severity, or the urgency
 * `past`, gives `none`.
 */
const CONTEXT_TABLE: LevelTable = {
  severity: { extreme: "digest", severe: "digest", moderate: "digest", minor: "none", unknown: "none" },
  urgency: { immediate: "digest", expected: "digest", future: "digest", past: "none", unknown: "digest" },
};

/**
 * The table of a kind with no class in an incident whose sources this copy does not run (AL-76). Such an incident came
 * from another copy, and that copy can run a newer build with a class for the kind. Thus the incident reaches the
 * digest at most. A minor severity or the urgency `past` gives `none`.
 */
export const FOREIGN_TABLE: LevelTable = {
  severity: { extreme: "digest", severe: "digest", moderate: "digest", minor: "none", unknown: "digest" },
  urgency: { immediate: "digest", expected: "digest", future: "digest", past: "none", unknown: "digest" },
};

/** The table of the other kinds. These kinds reach `urgent` at most. */
const OTHER_TABLE: LevelTable = {
  severity: { extreme: "urgent", severe: "urgent", moderate: "notice", minor: "digest", unknown: "digest" },
  urgency: { immediate: "urgent", expected: "urgent", future: "notice", past: "digest", unknown: "notice" },
};

/**
 * The prefix of the kinds of the health reports of the core. The state follows it:
 * `system.health.failing`. An adapter does not map a message to this prefix.
 */
export const HEALTH_KIND = "system.health";

/**
 * The prefix of the kinds of the coverage reports of the core. The covered kind follows it:
 * `system.coverage.met.tornado`. An adapter does not map a message to this prefix.
 */
export const COVERAGE_KIND = "system.coverage";

/**
 * The prefix of the kinds of the quota reports of the core. The stage follows it:
 * `system.quota.reserve`. An adapter does not map a message to this prefix.
 */
export const QUOTA_KIND = "system.quota";

/**
 * The prefix of the kinds of the balance reports of the core. The stage follows it:
 * `system.balance.low`. An adapter does not map a message to this prefix.
 */
export const BALANCE_KIND = "system.balance";

/**
 * The prefix of the kinds of the clock reports of the core: `system.clock.step`, a step of the wall clock
 * against the monotonic clock. An adapter does not map a message to this prefix.
 */
export const CLOCK_KIND = "system.clock";

/**
 * The prefix of the kinds of the log reports of the core: `system.log.recovered`, a broken log file that went into
 * quarantine. An adapter does not map a message to this prefix.
 */
export const LOG_KIND = "system.log";

/**
 * The prefix of the kinds of the copy reports of the core. The stage follows it: `system.copy.unread`. An adapter does
 * not map a message to this prefix.
 */
export const COPY_KIND = "system.copy";

/**
 * The prefix of the kinds of the event-loop reports of the core: `system.loop.block`, a block of the event loop of the
 * runtime (AL-88). An adapter does not map a message to this prefix.
 */
export const LOOP_KIND = "system.loop";

/**
 * The prefix of the kinds of the drill reports of the core. `system.drill.run` is a run that waits for its
 * acknowledgment, and `system.drill.failed` is a failed run. An adapter does not map a message to this prefix.
 */
export const DRILL_KIND = "system.drill";

/**
 * The prefix of the kinds of the escalation reports of the core (AL-21). `system.escalation.exhausted` tells that a
 * person did not acknowledge a real warning in the time of the policy. An adapter does not map a message to this prefix.
 */
export const ESCALATION_KIND = "system.escalation";

/**
 * The prefix of the kinds of the channel reports of the core (AL-65). `system.channel.down` tells that the calls of a
 * channel of this copy fail. An adapter does not map a message to this prefix.
 */
export const CHANNEL_KIND = "system.channel";

/**
 * The prefix of the kinds of the store reports of the core (AL-86). `system.store.empty` tells that a family of a store of
 * the runtime has no entry in the time after a start. An adapter does not map a message to this prefix.
 */
export const STORE_KIND = "system.store";

/**
 * The prefix of the kinds of the send-limit reports of the core (AL-81). `system.limit.held` tells a person that the send
 * limit holds new alerts for the person, and that the digest tells them. Such a report is private. An adapter does not map a message to this prefix.
 */
export const LIMIT_KIND = "system.limit";

/**
 * The prefix of the kinds of the use reports of the core (AL-111). `system.use.level` tells that the used share of a hard
 * limit of a provider account reached a level in the month. An adapter does not map a message to this prefix.
 */
export const USE_KIND = "system.use";

/**
 * The prefix of the kinds of the redundancy reports of the core (AL-90). `system.redundancy.single` tells that a function of
 * the alert chain has a new single point of failure. An adapter does not map a message to this prefix.
 */
export const REDUNDANCY_KIND = "system.redundancy";

/**
 * The prefix of the kinds of the messages of the operator (AL-92). The intake of the runtime maps each message to
 * `system.tell.<class>` with the status `system`. Each such message is private: its addresses name its persons.
 */
export const TELL_KIND = "system.tell";

/**
 * The classes of a message of the operator (AL-92). `needs-you`: the person must decide or act. `done-you-asked`: a
 * request of the person is done. `live`: a change is live.
 */
export const TELL_CLASSES = ["needs-you", "done-you-asked", "live"] as const;

/** The class of a message of the operator. */
export type TellClass = (typeof TELL_CLASSES)[number];

/**
 * The subject system of a person. The id of a subject is the id of a person. A person who watches the subject of another
 * person gets the escalation reports of that person. A subject of the person itself does not match the person.
 */
export const PERSON_SUBJECT = "alerts.person";

/**
 * The table of the system reports that can reach `life-safety`: the coverage of a life-safety kind, a drill run and an
 * exhausted escalation. The severity and the urgency of an exhausted escalation give back its level.
 */
const LOUD_SYSTEM_TABLE: LevelTable = {
  severity: { extreme: "life-safety", severe: "urgent", moderate: "notice", minor: "digest", unknown: "urgent" },
  urgency: { immediate: "life-safety", expected: "urgent", future: "notice", past: "digest", unknown: "urgent" },
};

/** The table of the other reports of the system. These reports reach `notice` at most. */
const SYSTEM_TABLE: LevelTable = {
  severity: { extreme: "notice", severe: "notice", moderate: "notice", minor: "digest", unknown: "notice" },
  urgency: { immediate: "notice", expected: "notice", future: "digest", past: "digest", unknown: "notice" },
};

/**
 * The table of the messages of the operator (AL-92). These messages reach `urgent` at most. The intake gives the
 * severity `severe` and the urgency `immediate` only to an urgent `needs-you`. Each other message gets `notice`.
 */
const TELL_TABLE: LevelTable = {
  severity: { extreme: "urgent", severe: "urgent", moderate: "notice", minor: "digest", unknown: "notice" },
  urgency: { immediate: "urgent", expected: "notice", future: "notice", past: "digest", unknown: "notice" },
};

/**
 * The first policy. An incident is `life-safety` when its status is `actual` and its kind is in
 * `LIFE_SAFETY_KINDS`. Its severity must be `severe`, `extreme` or `unknown`, and its urgency must
 * be `immediate`, `expected` or `unknown`. A place of the person must be in its areas.
 *
 * The three system classes hold the reports of the core, and they admit only the status `system`. The
 * coverage of a life-safety kind, a drill run and an exhausted escalation can reach `life-safety`. Each other report of the core reaches
 * `notice` at most. The NWS kinds `system.test` and `system.admin` are not in these classes.
 *
 * The class `system-tell` holds the messages of the operator (`TELL_KIND`). It admits only the status `system`, and it
 * reaches `urgent` at most.
 *
 * The earthquake class has its own table. In one hour after the onset, its urgency `past` counts as
 * `immediate`. Then `extreme` is `life-safety`, and `severe` is `urgent`.
 *
 * The kinds of context (`CONTEXT_KINDS`) reach the digest at most. Thus a report of such a kind starts no escalation,
 * and the rule of the life-safety warnings does not apply to it.
 */
export const DEFAULT_ASSESS_POLICY: AssessPolicy = {
  statuses: ["actual"],
  classes: [
    // The first class with a prefix of the kind applies. Thus an early warning stays in the life-safety class.
    { id: "life-safety", kinds: [...LIFE_SAFETY_KINDS.filter((kind) => !EARTHQUAKE_KINDS.includes(kind)), "geo.earthquake.early-warning"], ...LIFE_SAFETY_TABLE },
    { id: "earthquake", kinds: EARTHQUAKE_KINDS, ...EARTHQUAKE_TABLE },
    { id: "system-coverage", kinds: LIFE_SAFETY_KINDS.map((kind) => `${COVERAGE_KIND}.${kind}`), statuses: ["system"], ...LOUD_SYSTEM_TABLE },
    // A drill run tests the path of the life-safety warnings, thus it reaches `life-safety`. A failed drill gets `notice` at most.
    { id: "system-drill", kinds: [`${DRILL_KIND}.run`], statuses: ["system"], ...LOUD_SYSTEM_TABLE },
    // An exhausted escalation of a person keeps its level for the people who watch that person (AL-21).
    { id: "system-escalation", kinds: [ESCALATION_KIND], statuses: ["system"], ...LOUD_SYSTEM_TABLE },
    // A message of the operator reaches only the persons of its addresses (AL-92). An urgent `needs-you` reaches `urgent`.
    { id: "system-tell", kinds: [TELL_KIND], statuses: ["system"], ...TELL_TABLE },
    { id: "system", kinds: [HEALTH_KIND, COVERAGE_KIND, QUOTA_KIND, BALANCE_KIND, CLOCK_KIND, LOG_KIND, COPY_KIND, LOOP_KIND, DRILL_KIND, CHANNEL_KIND, STORE_KIND, LIMIT_KIND, USE_KIND, REDUNDANCY_KIND], statuses: ["system"], ...SYSTEM_TABLE },
    // The service alerts of public transit are context. Their counts are indicator readings.
    { id: "context", kinds: CONTEXT_KINDS, ...CONTEXT_TABLE },
  ],
  otherwise: OTHER_TABLE,
};

/** This function gives the lower of two levels. */
export function lowerLevel(a: AssessedLevel, b: AssessedLevel): AssessedLevel {
  return rank(a) <= rank(b) ? a : b;
}

/** This function gives the higher of two levels. */
export function higherLevel(a: AssessedLevel, b: AssessedLevel): AssessedLevel {
  return rank(a) >= rank(b) ? a : b;
}

/** The result of the table for one incident. */
export interface TableResult {
  /** The id of the class of the kind. It is absent for the table `otherwise`. */
  readonly class?: string;
  readonly bySeverity: AssessedLevel;
  readonly byUrgency: AssessedLevel;
  /** The lower of the two levels. */
  readonly level: AssessedLevel;
  /** This value is true when the urgency `past` counted as `immediate` in the window `pastWithin` of the table. */
  readonly recentPast?: true;
  /** This value is true when the table is `FOREIGN_TABLE`: the kind has no class, and only other copies run the sources of the incident. */
  readonly foreign?: true;
}

/** This function gives the first class of the policy with a prefix of a kind, or `undefined`. */
export function classOf(policy: AssessPolicy, kind: string): KindClass | undefined {
  return policy.classes.find((candidate) => hasKind(candidate.kinds, kind));
}

/**
 * This function tells if the policy sends an incident of this status and kind. The class of the kind
 * gives the statuses, else the policy gives them.
 */
export function admits(policy: AssessPolicy, incident: Pick<Incident, "status" | "kind">): boolean {
  return (classOf(policy, incident.kind.code)?.statuses ?? policy.statuses).includes(incident.status);
}

/**
 * This function gives the level of the table for an incident or a line: the lower of its two lookups. In the
 * window `pastWithin` of the table after the onset, the urgency `past` counts as `immediate`. The time `at`
 * gives the age. With no time or no onset, the age is unknown, and `past` counts as `immediate`. With `foreign`, a kind
 * with no class gets `FOREIGN_TABLE`.
 */
export function tableLevel(
  policy: AssessPolicy,
  incident: Pick<Incident | IncidentLine, "kind" | "severity" | "urgency" | "onset">,
  at?: Instant,
  foreign = false,
): TableResult {
  const found = classOf(policy, incident.kind.code);
  // A kind with no class in an incident of the sources of other copies gets the quiet table (AL-76).
  const other = found === undefined && foreign;
  const table = found ?? (other ? FOREIGN_TABLE : policy.otherwise);
  const span = table.pastWithin;
  const recent = incident.urgency === "past" && span !== undefined && (at === undefined || incident.onset === undefined || at - incident.onset <= span);
  const bySeverity = table.severity[incident.severity];
  const byUrgency = table.urgency[recent ? "immediate" : incident.urgency];
  const level = lowerLevel(bySeverity, byUrgency);
  return {
    ...(found === undefined ? {} : { class: found.id }),
    bySeverity,
    byUrgency,
    level,
    ...(recent ? { recentPast: true as const } : {}),
    ...(other ? { foreign: true as const } : {}),
  };
}

/** The reason of the score rule of a person (AL-31). */
export type ScoreRuleReason = Extract<AssessReason, { readonly kind: "score" }>;

/**
 * This function gives the result of the score rule of a person for an incident or a line (AL-31). The result is
 * `undefined` when the rule does not examine the kind. Three conditions cause this:
 *
 * - The person has no rule.
 * - The table is the quiet table of other copies (AL-76).
 * - A prefix of `except` holds the kind.
 *
 * Else `raised` is true when two conditions are true. The expected deaths of the score (`shadowScore`) reach the risk of
 * the rule. The table gives a level below `life-safety`. A score with no read does not raise. With no priors in the
 * policy, the result has no score, and `raised` is false.
 */
export function scoreRuleResult(
  policy: AssessPolicy,
  rule: ScoreRule | undefined,
  incident: Pick<Incident | IncidentLine, "kind" | "certainty">,
  table: TableResult,
): ScoreRuleReason | undefined {
  if (rule === undefined || table.foreign === true || hasKind(rule.except ?? [], incident.kind.code)) return undefined;
  if (policy.priors === undefined) return { kind: "score", risk: rule.risk, raised: false };
  const score = shadowScore(incident, policy.priors);
  const raised = score.read && score.expected.deaths.value >= rule.risk && rank(table.level) < rank("life-safety");
  return { kind: "score", risk: rule.risk, raised, score };
}

/**
 * This function gives the policy of the assessment with the priors of the score rules (AL-31). The priors go in only
 * when a person has a score rule and the policy has no priors. Else the function gives the policy as it is. Thus with no
 * score rule, each assessment stays the same.
 */
export function policyWithPriors(
  policy: AssessPolicy | undefined,
  people: readonly Pick<PersonWatch, "score">[],
  priors: ScorePriors | undefined,
): AssessPolicy | undefined {
  if (priors === undefined || policy?.priors !== undefined || !people.some((person) => person.score !== undefined)) return policy;
  return { ...(policy ?? DEFAULT_ASSESS_POLICY), priors };
}

/**
 * This function gives the test of an incident of the sources of other copies (AL-76). The test is true when each report
 * of the incident comes from a source that is not in `sources`. Such an incident came from another copy only. A report
 * with no known source counts as a report of this copy. A report of `SYSTEM_SOURCE` also counts as a report of this
 * copy, because each copy makes its own system reports. Without `sources`, the test is always false.
 */
export function foreignIncidents(
  reports: readonly { readonly id: string; readonly source: string }[],
  sources: ReadonlySet<string> | undefined,
): (incident: Pick<Incident, "anchor" | "reports">) => boolean {
  if (sources === undefined) return () => false;
  const sourceOf = new Map<string, string>(reports.map((report) => [report.id, report.source]));
  return (incident) =>
    [incident.anchor, ...incident.reports].every((report) => {
      const source = sourceOf.get(report);
      return source !== undefined && source !== SYSTEM_SOURCE && !sources.has(source);
    });
}

/**
 * This function tells if a code of an area and a code of a place name regions that meet. The codes
 * must be of one system and equal, with one more rule for SAME (`sameScope`). Thus a SAME code of a
 * state meets each county of that state, and a part of a county meets the full county. The match of
 * the places uses this rule. It is on the safe side: an alert for a part of a region goes to the places
 * of that region.
 */
export function regionCovers(area: RegionCode, place: RegionCode): boolean {
  if (area.system !== place.system) return false;
  if (area.code === place.code) return true;
  return area.system === "same" && sameRelation(area.code, place.code, "meets");
}

/**
 * This function tells if the region of a code of an area holds all of the region of a code of a place.
 * The codes must be of one system and equal, with one more rule for SAME (`sameScope`). The coverage of
 * the sources uses this rule. It is on the safe side: a source of a part of a county does not hide a gap
 * of the full county.
 */
export function regionContains(area: RegionCode, place: RegionCode): boolean {
  if (area.system !== place.system) return false;
  if (area.code === place.code) return true;
  return area.system === "same" && sameRelation(area.code, place.code, "contains");
}

/** A place in the areas of an incident, with the codes or the distance that decided the match. */
export interface PlaceMatch {
  readonly place: PlaceId;
  /** The codes of the place that decided the match. The list is empty for a match by a shape only. */
  readonly codes: readonly RegionCode[];
  /**
   * The great-circle distance in kilometers from the place to the nearest shape that decided. It is 0 in
   * a shape. It is present only when that distance is in the buffer of the place.
   */
  readonly distanceKm?: number;
  /**
   * True when the codes of a block decided the match because `@mark1russell7/geo` refuses each shape of
   * that block. The view shows it, because the shape of that block did not decide.
   */
  readonly shapeRefused?: true;
  /**
   * True when a fire zone code of an area decided through the forecast zone code of the place with the same code
   * (AL-33). The place has no fire zone code of that state. The view shows it, because the two outlines can differ.
   */
  readonly zoneFallback?: true;
}

/**
 * This function gives the places that the areas of an incident cover, in the order of the places. One
 * block that matches is enough.
 *
 * - An area of a watched place covers that place.
 * - A block with a shape decides by its shapes for a place with a position. The place matches when the
 *   great-circle distance to the nearest polygon or circle of the block is not more than its buffer. The
 *   codes of that block do not decide for that place.
 * - A block with no shape decides by its codes. So does each block for a place with no position.
 * - When `@mark1russell7/geo` refuses each shape of a block, the codes of the block decide. This is on the
 *   safe side, and the match tells it with `shapeRefused`.
 * - The areas with no block key keep the union rule. Their codes are the floor of the match, and a shape
 *   adds a place in its buffer. A shape that geo refuses adds no place.
 * - A fire zone code (`ugc-fire`) covers only a fire zone code of a place. A place with no fire zone code of
 *   a state uses the forecast zone code (`ugc`) with the same code. This is on the safe side, and the match
 *   tells it with `zoneFallback`.
 * - In a block with zone codes of a state, the county codes of that state do not widen the match (AL-69). The
 *   county codes are SAME, FIPS and UGC county codes. They decide only for a place with no zone code of that kind
 *   and that state. Thus a place with no zone code keeps the match of its county.
 */
export function matchPlaces(incident: Pick<Incident, "areas">, places: readonly WatchedPlace[]): PlaceMatch[] {
  const ids = new Set(incident.areas.flatMap((area) => (area.type === "place" ? [area.place] : [])));
  const groups = new Map<string | undefined, (MapShape | (RegionCode & { readonly type: "code" }))[]>();
  for (const area of incident.areas) {
    if (area.type === "place") continue;
    const group = groups.get(area.block) ?? [];
    group.push(area);
    groups.set(area.block, group);
  }
  return places.flatMap((place): PlaceMatch[] => {
    const covered = new Set<RegionCode>();
    let nearest = Number.POSITIVE_INFINITY;
    let shapeRefused = false;
    // The codes that an area code covers, and the codes that only the fallback of the fire zones covers.
    const direct = new Set<RegionCode>();
    const fallback = new Set<RegionCode>();
    const fireStates = new Set(place.codes.flatMap((code) => (code.system === "ugc-fire" ? [code.code.slice(0, 2)] : [])));
    const placeZones = zoneKeys(place.codes);
    for (const [block, areas] of groups) {
      const shapes = areas.filter(isShape);
      const distance = place.at === undefined || shapes.length === 0 ? undefined : nearestShape(shapes, place.at);
      if (distance !== undefined) nearest = Math.min(nearest, distance);
      // A block decides by its shapes when geo reads one of them. The areas with no block always give their codes.
      if (block !== undefined && distance !== undefined) continue;
      const codeAreas = areas.filter((area) => area.type === "code");
      const zoned = block === undefined ? new Set<string>() : zoneKeys(codeAreas);
      const byBlock: RegionCode[] = [];
      for (const code of place.codes) {
        if (zoned.size > 0 && zonedCounty(code, zoned, placeZones)) continue;
        if (codeAreas.some((area) => regionCovers(area, code))) {
          direct.add(code);
          byBlock.push(code);
        } else if (!fireStates.has(code.code.slice(0, 2)) && codeAreas.some((area) => zoneFallbackCovers(area, code))) {
          fallback.add(code);
          byBlock.push(code);
        }
      }
      for (const code of byBlock) covered.add(code);
      if (byBlock.length > 0 && block !== undefined && place.at !== undefined && shapes.length > 0) shapeRefused = true;
    }
    const codes = place.codes.filter((code) => covered.has(code));
    const near = nearest <= place.bufferKm;
    if (codes.length === 0 && !near && !ids.has(place.id)) return [];
    const zoneFallback = codes.some((code) => fallback.has(code) && !direct.has(code));
    return [
      {
        place: place.id,
        codes,
        ...(near ? { distanceKm: nearest } : {}),
        ...(shapeRefused ? { shapeRefused: true as const } : {}),
        ...(zoneFallback ? { zoneFallback: true as const } : {}),
      },
    ];
  });
}

// The fallback of the fire zones: a fire zone code of an area covers the forecast zone code of a place with the same code.
// The caller uses it only for a place with no fire zone code of the state of that code.
function zoneFallbackCovers(area: RegionCode, place: RegionCode): boolean {
  return area.system === "ugc-fire" && place.system === "ugc" && area.code === place.code;
}

// The kind and the state of each zone code, as `<system>:<state>`. A zone code is a fire zone code, or a UGC code with the
// letter Z (a forecast zone).
function zoneKeys(codes: readonly RegionCode[]): Set<string> {
  return new Set(codes.flatMap((code) => (isZoneCode(code) ? [`${code.system}:${code.code.slice(0, 2)}`] : [])));
}

function isZoneCode(code: RegionCode): boolean {
  return code.system === "ugc-fire" || (code.system === "ugc" && code.code.charAt(2) === "Z");
}

// The postal code of the state of a county code: a UGC code with the letter C, a SAME code or a FIPS code. A SAME code of the
// full state or of the full country, and each other code, give `undefined`.
function countyState(code: RegionCode): string | undefined {
  if (code.system === "ugc") return code.code.charAt(2) === "C" ? code.code.slice(0, 2) : undefined;
  if (code.system === "same") return SAME.test(code.code) && code.code.slice(3) !== "000" ? STATE_POSTAL[code.code.slice(1, 3)] : undefined;
  if (code.system === "fips") return /^\d{5}$/.test(code.code) && code.code.slice(2) !== "000" ? STATE_POSTAL[code.code.slice(0, 2)] : undefined;
  return undefined;
}

// A county code of a place that a block with zone codes does not use: the block and the place have a zone code of one kind
// in the state of the county code. Then the zone codes decide for that place.
function zonedCounty(code: RegionCode, zoned: ReadonlySet<string>, placeZones: ReadonlySet<string>): boolean {
  const state = countyState(code);
  if (state === undefined) return false;
  return ["ugc", "ugc-fire"].some((system) => zoned.has(`${system}:${state}`) && placeZones.has(`${system}:${state}`));
}

// The distance to the nearest shape that geo reads, or `undefined` when geo refuses each shape.
function nearestShape(shapes: readonly MapShape[], at: Position): number | undefined {
  let nearest: number | undefined;
  for (const shape of shapes) {
    const distance = shapeDistanceKm(shape, at);
    if (distance !== undefined) nearest = Math.min(nearest ?? distance, distance);
  }
  return nearest;
}

/**
 * This function gives the watches of a person that a subject of an incident matches, in the order
 * of the watches. A watch with no id matches each subject of its system. A watch with an id matches each subject
 * whose node overlaps its node (`nodesOverlap`). Outside the systems of paths, that is the subject with the same id.
 */
export function matchSubjects(incident: Pick<Incident, "about">, watches: readonly SubjectWatch[]): SubjectWatch[] {
  return watches.filter((watch) =>
    incident.about.some(
      (subject) => subject.system === watch.system && (watch.id === undefined || nodesOverlap(subjectNode({ system: watch.system, id: watch.id }), subjectNode(subject))),
    ),
  );
}

/**
 * This function gives the assessment as it reaches the person. A mute with the effect `absent` keeps the incident from the
 * person, thus the level is `none`. A mute with the effect `silent` keeps the level. Each other assessment stays the same.
 */
export function reachedAssessment(assessment: Assessment): Assessment {
  return assessment.muted?.effect === "absent" ? { ...assessment, level: "none" } : assessment;
}

/**
 * This function gives the level of an incident for a person, with its reasons. The level is `none`
 * when the incident ended, or when the policy does not send its status for its kind. It is also
 * `none` when the incident has no place and no subject that the person watches.
 *
 * Else the level is the highest level at the matches of the person: each place in the areas, and
 * each watched subject. At each match, the first rule of the person that matches can lower the
 * level of the table. A rule with places does not match a subject.
 *
 * An incident with lines has a table level at each place: the highest level of the lines whose areas
 * hold that place. Thus a far place of an earthquake gets the level of its band of shaking, not the
 * level of the center. A subject gets the level of the incident.
 *
 * A person with an interest graph gets the routing by the relevance (`docs/RELEVANCE.md`). A place or another
 * entry counts only when it reaches the person alone. A place under the rule of the life-safety warnings always
 * counts. An entry that is not a watched place gives the level of the table, up to `entryMax` of the policy.
 * When the relevance fails, the places decide as with no graph, and the reason `relevance-fault` tells the fault.
 *
 * The value `foreign` tells that this copy runs no source of the incident (`foreignIncidents`). A kind with no class
 * then gets `FOREIGN_TABLE`, not the table `otherwise` (AL-76).
 *
 * A person with a score rule (`PersonWatch.score`, AL-31) gets `life-safety` when the expected deaths of the score reach
 * the risk of the rule (`scoreRuleResult`). The rule raises the table level of the incident and of each line, before the
 * rules of the person. The reason `score` follows the reason `table`.
 */
export function assess(
  incident: Incident,
  person: PersonWatch,
  places: readonly WatchedPlace[],
  policy: AssessPolicy = DEFAULT_ASSESS_POLICY,
  at?: Instant,
  foreign = false,
): Assessment {
  // A private incident reaches only the persons of its addresses (AL-92, `audience.ts`).
  if (!inAudience(incident, person.person)) {
    return { incident: incident.anchor, person: person.person, level: "none", places: [], reasons: [{ kind: "not-addressed" }] };
  }
  const byId = new Map(places.map((place) => [place.id, place]));
  const reasons: AssessReason[] = [];
  const watched: WatchedPlace[] = [];
  for (const id of person.places) {
    const place = byId.get(id);
    if (place === undefined) reasons.push({ kind: "unknown-place", place: id });
    else watched.push(place);
  }
  const matches = matchPlaces(incident, watched);
  // The escalation reports of a person go to the people who watch that person, and not to the person. Thus the subject
  // of the person itself matches no watch of the person, also a watch with no id.
  const others = incident.about.filter((subject) => !(subject.system === PERSON_SUBJECT && subject.id === person.person));
  const subjects = matchSubjects({ about: others }, person.subjects ?? []);
  let muted: Assessment["muted"];
  const result = (level: AssessedLevel): Assessment => ({
    incident: incident.anchor,
    person: person.person,
    level,
    places: matches.map((match) => match.place),
    reasons,
    ...(muted === undefined ? {} : { muted }),
  });
  if (!incident.live) {
    reasons.push({ kind: "ended" });
    return result("none");
  }
  if (!admits(policy, incident)) {
    reasons.push({ kind: "status", status: incident.status });
    return result("none");
  }
  const table = tableLevel(policy, incident, at, foreign);
  // The score rule of the person can raise the level of the table to `life-safety` (AL-31). It does not lower a level.
  const scored = scoreRuleResult(policy, person.score, incident, table);
  const incidentLevel: AssessedLevel = scored?.raised === true ? "life-safety" : table.level;
  const lineLevel = (line: IncidentLine): AssessedLevel => {
    const found = tableLevel(policy, line, at, foreign);
    return scoreRuleResult(policy, person.score, line, found)?.raised === true ? "life-safety" : found.level;
  };
  const tables = new Map<PlaceId, PlaceTable>();
  // The level of the table at one place: the highest table of the lines that hold the place.
  const placeTable = (id: PlaceId): PlaceTable => {
    const known = tables.get(id);
    if (known !== undefined) return known;
    const place = byId.get(id);
    const holding = place === undefined ? [] : linesAt(incident, place);
    const found: PlaceTable =
      holding.length === 0 ? { level: incidentLevel, reports: [] } : { level: holding.map(lineLevel).reduce(higherLevel), reports: holding.map((line) => line.report) };
    tables.set(id, found);
    return found;
  };
  const relevancePolicy = policy.relevance ?? DEFAULT_RELEVANCE_POLICY;
  let plan: RelevancePlan | undefined;
  // The sender of a private incident named the person, so the interest graph does not decide.
  if (person.interests !== undefined && !isPrivate(incident)) {
    try {
      plan = planOf(incident, person, person.interests, matches, byId, (id) => placeTable(id).level, relevancePolicy, at);
    } catch (error) {
      // The alert is not lost: the places decide, as for a person with no graph.
      reasons.push({ kind: "relevance-fault", message: error instanceof Error && error.message !== "" ? error.message : RELEVANCE_FAULT });
    }
  }
  // The result keeps the mute also when nothing reaches the person, because a mute that removes each entry is the cause.
  muted = plan?.relevance.muted;
  if (!isPrivate(incident) && matches.length === 0 && subjects.length === 0 && (plan === undefined || plan.reached.length === 0)) {
    reasons.push({ kind: noMatch(incident, watched) });
    return result("none");
  }
  reasons.push({ kind: "table", ...table });
  if (scored !== undefined) reasons.push(scored);
  const entryLevel = lowerLevel(incidentLevel, relevancePolicy.entryMax ?? DEFAULT_ENTRY_MAX);
  if (plan !== undefined) {
    const { reach, why } = plan.relevance;
    reasons.push({
      kind: "reach",
      reach,
      reached: plan.reached,
      mandatory: plan.mandatory,
      ...(plan.others.length > 0 ? { entryLevel } : {}),
      ...(why === undefined ? {} : { why }),
    });
  }
  let level: AssessedLevel = "none";
  // The level at one match through an entry of the kind `through`: the first rule that matches can lower the level of the table.
  const atMatch = (place: PlaceId | undefined, base: AssessedLevel, through: SubjectKind): AssessedLevel => {
    const index = person.rules.findIndex(
      (rule) =>
        (rule.places === undefined || (place !== undefined && rule.places.includes(place))) &&
        (rule.kinds === undefined || hasKind(rule.kinds, incident.kind.code)) &&
        (rule.through === undefined || rule.through.includes(through)),
    );
    const rule = person.rules[index];
    if (rule === undefined || rank(rule.max) >= rank(base)) return base;
    reasons.push(place === undefined ? { kind: "rule", index, max: rule.max } : { kind: "rule", place, index, max: rule.max });
    return rule.max;
  };
  if (isPrivate(incident)) {
    reasons.push({ kind: "addressed" });
    return result(atMatch(undefined, incidentLevel, "entity"));
  }
  for (const match of matches) {
    reasons.push({ kind: "place", ...match });
    if (plan !== undefined && !plan.places.has(match.place)) continue;
    const found = placeTable(match.place);
    if (found.reports.length > 0 && found.level !== incidentLevel) reasons.push({ kind: "place-table", place: match.place, reports: found.reports, level: found.level });
    level = higherLevel(level, atMatch(match.place, found.level, "place"));
  }
  // Each kind of the other entries that count gets its own rule. Thus a rule through topics does not lower an entity.
  for (const through of plan?.others ?? []) level = higherLevel(level, atMatch(undefined, entryLevel, through));
  for (const subject of subjects) {
    reasons.push({ kind: "subject", subject });
    level = higherLevel(level, atMatch(undefined, incidentLevel, kindOfNode(subjectNode({ system: subject.system, id: subject.id ?? "*" })) ?? "entity"));
  }
  return result(level);
}

/**
 * This function gives the assessment of `assess`, with the shadow score as its last reason. The score
 * does not change the level or the other reasons. An assessment with no reason of the table gets no
 * score. Examples are an ended incident, a status that the policy does not send and an incident with no match.
 *
 * The reason of the score rule of a person holds the score when the policy has priors (AL-31). Such an assessment
 * gets no second score.
 */
export function assessWithShadow(
  incident: Incident,
  person: PersonWatch,
  places: readonly WatchedPlace[],
  priors: ScorePriors,
  policy: AssessPolicy = DEFAULT_ASSESS_POLICY,
  at?: Instant,
): Assessment {
  const assessment = assess(incident, person, places, policy, at);
  if (!assessment.reasons.some((reason) => reason.kind === "table")) return assessment;
  if (assessment.reasons.some((reason) => reason.kind === "score" && reason.score !== undefined)) return assessment;
  return { ...assessment, reasons: [...assessment.reasons, { kind: "shadow", score: shadowScore(incident, priors) }] };
}

// The level of the table at one place, and the reports of the lines that hold the place.
interface PlaceTable {
  readonly level: AssessedLevel;
  readonly reports: readonly ReportId[];
}

// The routing by the relevance for one person.
interface RelevancePlan {
  // The matched places that count: each place of the rule of the life-safety warnings, and each place that reaches the person alone.
  readonly places: ReadonlySet<PlaceId>;
  // The kinds of the entries that are not matched places and that reach the person alone, in the order of SUBJECT_KINDS.
  readonly others: readonly SubjectKind[];
  // The entries that count, in the order of the entries.
  readonly reached: readonly NodeKey[];
  // The matched places of the rule of the life-safety warnings, in the order of the matches.
  readonly mandatory: readonly PlaceId[];
  readonly relevance: Relevance;
}

// The kinds of the entries, in the order of the reasons and the rules.
const SUBJECT_KINDS: readonly SubjectKind[] = ["place", "topic", "entity"];

// The message of a fault with no text of its own.
const RELEVANCE_FAULT = "The relevance failed with no message.";

// The hit of an entry that the incident names: a place in its areas, a code, a subject or the topic of its kind.
const FULL_HIT = { value: 1, low: 1, high: 1 } as const;

// The plan of the routing by the relevance. A matched place is under the rule of the life-safety warnings when the
// rule of the person is on there, the match is in its range and the table gives `life-safety` at the place. Each other
// entry counts when it reaches the person alone, with the cut of the mutes. The function throws when the relevance
// throws, and the caller records the fault.
function planOf(
  incident: Incident,
  person: PersonWatch,
  graph: InterestGraph,
  matches: readonly PlaceMatch[],
  byId: ReadonlyMap<PlaceId, WatchedPlace>,
  levelAt: (place: PlaceId) => AssessedLevel,
  policy: RelevancePolicy,
  at: Instant | undefined,
): RelevancePlan {
  if (graph.person !== person.person) throw new RangeError("The interest graph is of another person.");
  const mandatory = matches
    .filter((match) => {
      const rule = person.mandatory?.find((candidate) => candidate.place === match.place);
      const rangeKm = rule?.rangeKm ?? byId.get(match.place)?.bufferKm ?? 0;
      const inRange = match.codes.length > 0 || match.distanceKm === undefined || match.distanceKm <= rangeKm;
      return (rule?.on ?? true) && inRange && levelAt(match.place) === "life-safety";
    })
    .map((match) => match.place);
  const entries = entriesOf(incident, matches, graph);
  const kind = incident.kind.code;
  // With no time, a mute with an end has no effect, so the alert is not lost.
  const time = at ?? Number.POSITIVE_INFINITY;
  const found = relevance({ kind, entries, at: time, mandatory: mandatory.length > 0 }, graph, policy);
  const kept = new Set(mandatory.map(placeNode));
  // Only a node that starts an edge can reach the person. Each entry counts alone, with the cut of the mutes.
  const starts = new Set(graph.edges.map((edge) => edge.from));
  const reached = entries
    .filter((entry) => kept.has(entry.node) || (starts.has(entry.node) && canReach({ kind, entries: [entry], at: time, mandatory: false }, graph, policy)))
    .map((entry) => entry.node);
  const counted = new Set(reached);
  const places = new Set(matches.filter((match) => counted.has(placeNode(match.place))).map((match) => match.place));
  const matched = new Set(matches.map((match) => placeNode(match.place)));
  const otherKinds = new Set(entries.filter((entry) => counted.has(entry.node) && !matched.has(entry.node)).map((entry) => entry.kind));
  return { places, others: SUBJECT_KINDS.filter((kind) => otherKinds.has(kind)), reached, mandatory, relevance: found };
}

// The entries of an incident for a graph, one for each node: the matched places, the areas, the subjects and the topic,
// in this order. A code or a subject gives an entry when its system is in `SUBJECT_SYSTEMS`.
function entriesOf(incident: Incident, matches: readonly PlaceMatch[], graph: InterestGraph): SubjectEntry[] {
  const found = new Map<NodeKey, SubjectEntry>();
  const add = (system: string, id: string): void => {
    if (!Object.hasOwn(SUBJECT_SYSTEMS, system)) return;
    const node = subjectNode({ system, id });
    if (!found.has(node)) found.set(node, { node, kind: SUBJECT_SYSTEMS[system as SubjectSystem], hit: FULL_HIT });
  };
  for (const match of matches) add("place", match.place);
  for (const area of incident.areas) {
    if (area.type === "code") add(area.system, area.code);
    else if (area.type === "place") add("place", area.place);
  }
  for (const subject of incident.about) add(subject.system, subject.id);
  // A node of the graph that overlaps a subject in a system of paths is also an entry (`nodesOverlap`).
  const subjects = [...found.keys()];
  for (const node of new Set(graph.edges.flatMap((edge) => [edge.from, edge.to]))) {
    const kind = kindOfNode(node);
    if (kind !== undefined && !found.has(node) && subjects.some((subject) => nodesOverlap(subject, node))) found.set(node, { node, kind, hit: FULL_HIT });
  }
  const topic = topicEntry(incident.kind.code, graph);
  if (topic !== undefined && !found.has(topic.node)) found.set(topic.node, topic);
  return [...found.values()];
}

/**
 * This function gives the lines of an incident whose areas hold a place, in the order of the lines. Each line
 * decides by the rules of `matchPlaces`. An incident with no lines gives an empty list.
 */
export function linesAt(incident: Pick<Incident, "lines">, place: WatchedPlace): IncidentLine[] {
  return (incident.lines ?? []).filter((line) => matchPlaces(line, [place]).length > 0);
}

// The reason when the incident has no place and no subject of the person. A shape can match only a
// place with a position.
function noMatch(incident: Pick<Incident, "areas" | "about">, places: readonly WatchedPlace[]): "no-place" | "no-subject" | "no-codes" {
  if (incident.areas.some((area) => area.type === "code" || area.type === "place")) return "no-place";
  if (incident.areas.some(isShape) && places.some((place) => place.at !== undefined)) return "no-place";
  if (incident.areas.length === 0 && incident.about.length > 0) return "no-subject";
  return "no-codes";
}

// A SAME code: a part digit, two digits of the state and three digits of the county.
const SAME = /^\d{6}$/;

/**
 * This function gives the levels of a SAME code `PSSCCC`: the state `SS`, the county `CCC` and the part
 * `P`. `undefined` is all of a level. The part `0` is the full county, the county `000` is the full
 * state, and `000000` is the full country (47 CFR 11.31). A code that is not 6 digits gives `undefined`.
 */
function sameScope(code: string): readonly (string | undefined)[] | undefined {
  if (!SAME.test(code)) return undefined;
  const [part, state, county] = [code.slice(0, 1), code.slice(1, 3), code.slice(3)];
  if (county === "000") return state === "00" ? [undefined, undefined, undefined] : [state, undefined, undefined];
  return [state, county, part === "0" ? undefined : part];
}

/**
 * This function compares the levels of two SAME codes. The first contains the second when each of its
 * levels is all of the level or equal. The two meet when each level is all of the level in one of them,
 * or equal.
 */
function sameRelation(first: string, second: string, relation: "meets" | "contains"): boolean {
  const [outer, inner] = [sameScope(first), sameScope(second)];
  if (outer === undefined || inner === undefined) return false;
  return outer.every((level, at) => level === undefined || level === inner[at] || (relation === "meets" && inner[at] === undefined));
}

function rank(level: AssessedLevel): number {
  return ASSESSED_LEVELS.indexOf(level);
}
