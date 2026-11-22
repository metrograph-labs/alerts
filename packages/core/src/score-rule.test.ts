// The score rule of a person (AL-31): an incident gets `life-safety` when its expected deaths in one place reach the
// risk of the rule. The table stays the floor, and with no rule each assessment stays the same.
import { random, seedsFrom, type Random } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import { assess, assessWithShadow, DEFAULT_ASSESS_POLICY, LIFE_SAFETY_KINDS, policyWithPriors, scoreRuleResult, tableLevel } from "./assess.ts";
import type {
  Area,
  AssessedLevel,
  AssessPolicy,
  Certainty,
  Estimate,
  Incident,
  IncidentLine,
  LevelRule,
  PersonId,
  PersonWatch,
  PlaceId,
  ReportId,
  ScorePriors,
  ScoreRule,
  Severity,
  Significance,
  Urgency,
  WatchedPlace,
} from "./contracts.ts";
import { ASSESSED_LEVELS } from "./contracts.ts";
import { assessmentSchema, assessPolicySchema, personWatchSchema, scoreRuleSchema } from "./schemas.ts";
import { PRIORS_FORMAT, shadowScore } from "./score.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);

// Made-up values. They are not the public measures.
const estimate = (value: number, low: number, high: number): Estimate => ({ value, low, high });
const PRIORS: ScorePriors = {
  format: PRIORS_FORMAT,
  kinds: {
    "met.winter.blizzard": { under: { warning: { deaths: estimate(0.02, 0.01, 0.04), injuries: estimate(0.1, 0.05, 0.2), area: "zone" } } },
    "met.tornado": { under: { warning: { deaths: estimate(0.001, 0.0005, 0.002), injuries: estimate(0.01, 0.005, 0.02), area: "county" } } },
    "met.rip-current": { under: { statement: { deaths: estimate(0.05, 0.02, 0.09), injuries: estimate(0.05, 0.02, 0.09), area: "zone" } } },
  },
  certainty: { likely: estimate(0.75, 0.5, 1) },
};
const SCORED: AssessPolicy = { ...DEFAULT_ASSESS_POLICY, priors: PRIORS };
const RULE: ScoreRule = { risk: 0.01 };

const home = "place:home" as PlaceId;
const places: readonly WatchedPlace[] = [{ id: home, codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 0 }];
const atHome: readonly Area[] = [{ type: "code", system: "ugc", code: "KSZ083" }];
const elsewhere: readonly Area[] = [{ type: "code", system: "ugc", code: "TXZ205" }];

function person(score?: ScoreRule, rules: readonly LevelRule[] = []): PersonWatch {
  return { person: "person-1" as PersonId, places: [home], rules, ...(score === undefined ? {} : { score }) };
}

function incident(kind: string, significance: Significance | undefined, fields: Partial<Omit<Incident, "kind">> = {}): Incident {
  return {
    anchor: "b".repeat(64) as ReportId,
    reports: ["b".repeat(64) as ReportId],
    status: "actual",
    kind: significance === undefined ? { code: kind, label: kind } : { code: kind, significance, label: kind },
    severity: "severe",
    urgency: "expected",
    certainty: "likely",
    areas: atHome,
    about: [],
    live: true,
    corroboration: 1,
    ...fields,
  };
}

const blizzard = incident("met.winter.blizzard", "warning");

describe("the score rule of a person", () => {
  it("raises a level of the table to life-safety when the expected deaths reach the risk", () => {
    const plain = assess(blizzard, person(), places, SCORED);
    expect(plain.level).toBe("urgent");
    const ruled = assess(blizzard, person(RULE), places, SCORED);
    expect(ruled.level).toBe("life-safety");
    const at = ruled.reasons.findIndex((reason) => reason.kind === "score");
    expect(ruled.reasons[at - 1]).toMatchObject({ kind: "table", level: "urgent" });
    expect(ruled.reasons[at]).toEqual({ kind: "score", risk: 0.01, raised: true, score: shadowScore(blizzard, PRIORS) });
    expect(ruled.reasons.filter((reason) => reason.kind !== "score")).toEqual(plain.reasons);
    expect(assessmentSchema.safeParse(ruled).success).toBe(true);
  });

  it("keeps the level of the table when the expected deaths are below the risk", () => {
    const ruled = assess(blizzard, person({ risk: 0.03 }), places, SCORED);
    expect(ruled.level).toBe("urgent");
    expect(ruled.reasons).toContainEqual({ kind: "score", risk: 0.03, raised: false, score: shadowScore(blizzard, PRIORS) });
  });

  it("keeps the table as the floor: a life-safety warning below the risk stays life-safety", () => {
    const tornado = incident("met.tornado", "warning");
    const ruled = assess(tornado, person(RULE), places, SCORED);
    expect(ruled.level).toBe("life-safety");
    expect(ruled.reasons).toContainEqual({ kind: "score", risk: 0.01, raised: false, score: shadowScore(tornado, PRIORS) });
  });

  it("does not examine a kind of the list except", () => {
    const rip = incident("met.rip-current", "statement");
    expect(assess(rip, person(RULE), places, SCORED).level).toBe("life-safety");
    const beach = assess(rip, person({ risk: 0.01, except: ["met.rip-current", "met.surf"] }), places, SCORED);
    expect(beach).toEqual(assess(rip, person(), places, SCORED));
    expect(beach.level).toBe("urgent");
  });

  it("does not raise with a score that has no read", () => {
    const wind = incident("met.wind", "warning");
    const ruled = assess(wind, person(RULE), places, SCORED);
    expect(ruled.level).toBe(assess(wind, person(), places, SCORED).level);
    expect(ruled.reasons).toContainEqual({ kind: "score", risk: 0.01, raised: false, score: { read: false, missing: ["deaths", "injuries"] } });
  });

  it("gives a reason with no score and no raise when the policy has no priors", () => {
    const ruled = assess(blizzard, person(RULE), places);
    expect(ruled.level).toBe("urgent");
    expect(ruled.reasons).toContainEqual({ kind: "score", risk: 0.01, raised: false });
    expect(assessmentSchema.safeParse(ruled).success).toBe(true);
  });

  it("lets a rule of the person lower the raised level", () => {
    const ruled = assess(blizzard, person(RULE, [{ kinds: ["met.winter"], max: "notice" }]), places, SCORED);
    expect(ruled.level).toBe("notice");
  });

  it("does not raise the quiet table of the sources of other copies", () => {
    const table = tableLevel(SCORED, blizzard, undefined, true);
    expect(table.foreign).toBe(true);
    expect(scoreRuleResult(SCORED, RULE, blizzard, table)).toBeUndefined();
    expect(assess(blizzard, person(RULE), places, SCORED, undefined, true)).toEqual(assess(blizzard, person(), places, SCORED, undefined, true));
  });

  it("raises each line that holds a place", () => {
    const line = (areas: readonly Area[], severity: Severity, report: string): IncidentLine => ({
      report: report.repeat(64) as ReportId,
      kind: blizzard.kind,
      severity,
      urgency: "expected",
      certainty: "likely",
      areas,
    });
    // The line at home is minor, so its table gives `digest`. The score of its kind raises it.
    const lined: Incident = { ...blizzard, lines: [line(atHome, "minor", "c"), line(elsewhere, "severe", "d")] };
    expect(assess(lined, person(), places, SCORED).level).toBe("digest");
    expect(assess(lined, person(RULE), places, SCORED).level).toBe("life-safety");
  });

  it("gets no second score from assessWithShadow when the reason of the rule holds the score", () => {
    const ruled = assessWithShadow(blizzard, person(RULE), places, PRIORS, SCORED);
    expect(ruled).toEqual(assess(blizzard, person(RULE), places, SCORED));
    expect(ruled.reasons.some((reason) => reason.kind === "shadow")).toBe(false);
    // With no priors in the policy, the reason of the rule has no score. Thus the shadow score follows it.
    const unscored = assessWithShadow(blizzard, person(RULE), places, PRIORS);
    expect(unscored.reasons.at(-1)).toEqual({ kind: "shadow", score: shadowScore(blizzard, PRIORS) });
    expect(unscored.level).toBe("urgent");
  });

  it("gives no reason and no level of its own to an incident with no match", () => {
    const far = incident("met.winter.blizzard", "warning", { areas: elsewhere });
    expect(assess(far, person(RULE), places, SCORED)).toEqual(assess(far, person(), places, SCORED));
  });
});

// The gates of the rule: with no rule, the priors in the policy change no assessment. With a rule, the level is never
// below the level with no rule, and it is the level of the replay of the table and the score (`replayOf` of `rates`).
describe("the gates of the score rule", () => {
  const KINDS = [...LIFE_SAFETY_KINDS, "met.winter.blizzard", "met.rip-current", "met.wind", "met.marine.gale"];
  const SEVERITIES: readonly Severity[] = ["minor", "moderate", "severe", "extreme", "unknown"];
  const URGENCIES: readonly Urgency[] = ["past", "future", "expected", "immediate", "unknown"];
  const CERTAINTIES: readonly Certainty[] = ["observed", "likely", "possible", "unlikely", "unknown"];
  const SIGNIFICANCES: readonly (Significance | undefined)[] = [undefined, "warning", "watch", "advisory", "statement"];
  const RISKS = [0.0001, 0.001, 0.01, 0.03, 0.1];
  const pick = <T,>(r: Random, values: readonly T[]): T => values[r.int(0, values.length - 1)]!;
  const rank = (level: AssessedLevel): number => ASSESSED_LEVELS.indexOf(level);
  // Half of the draws are of a kind and a significance with priors. Thus each seed has raised incidents.
  const SCORED_KINDS: readonly (readonly [string, Significance])[] = [
    ["met.winter.blizzard", "warning"],
    ["met.rip-current", "statement"],
    ["met.tornado", "warning"],
  ];
  const draw = (r: Random): Incident => {
    const [kind, significance] = r.chance(0.5) ? pick(r, SCORED_KINDS) : [pick(r, KINDS), pick(r, SIGNIFICANCES)];
    return incident(kind, significance, {
      severity: pick(r, SEVERITIES),
      urgency: pick(r, URGENCIES),
      certainty: pick(r, CERTAINTIES),
      areas: r.chance(0.85) ? atHome : elsewhere,
      live: r.chance(0.95),
    });
  };

  it.each(SEEDS)("changes no assessment of a person with no rule (seed %i)", (seed) => {
    const r = random(seed);
    for (let n = 0; n < 200; n++) {
      const draft = draw(r);
      const rules: LevelRule[] = r.chance(0.3) ? [{ max: pick(r, ASSESSED_LEVELS) }] : [];
      expect(assess(draft, person(undefined, rules), places, SCORED)).toEqual(assess(draft, person(undefined, rules), places));
    }
  });

  it.each(SEEDS)("keeps the table as the floor, and gives the level of the replay (seed %i)", (seed) => {
    const r = random(seed);
    let raised = 0;
    for (let n = 0; n < 200; n++) {
      const draft = draw(r);
      const rule: ScoreRule = { risk: pick(r, RISKS) };
      const plain = assess(draft, person(), places, SCORED);
      const ruled = assess(draft, person(rule), places, SCORED);
      expect(rank(ruled.level)).toBeGreaterThanOrEqual(rank(plain.level));
      expect(assessmentSchema.safeParse(ruled).success).toBe(true);
      if (plain.level === "none") {
        expect(ruled.level).toBe("none");
        continue;
      }
      // The rule of the replay: `life-safety` when the table gives it or the expected deaths reach the risk.
      const score = shadowScore(draft, PRIORS);
      const reaches = score.read && score.expected.deaths.value >= rule.risk;
      expect(ruled.level).toBe(reaches ? "life-safety" : plain.level);
      if (ruled.level !== plain.level) raised++;
    }
    // The draws hold raised incidents, so the gate tests the raise and not only the floor.
    expect(raised).toBeGreaterThan(0);
  });
});

describe("policyWithPriors", () => {
  it("gives the policy as it is when no person has a score rule", () => {
    expect(policyWithPriors(undefined, [person()], PRIORS)).toBeUndefined();
    expect(policyWithPriors(DEFAULT_ASSESS_POLICY, [person()], PRIORS)).toBe(DEFAULT_ASSESS_POLICY);
  });

  it("adds the priors to the policy, or to the default policy, when a person has a score rule", () => {
    expect(policyWithPriors(undefined, [person(), person(RULE)], PRIORS)).toEqual(SCORED);
    const own: AssessPolicy = { ...DEFAULT_ASSESS_POLICY, statuses: ["actual", "exercise"] };
    expect(policyWithPriors(own, [person(RULE)], PRIORS)).toEqual({ ...own, priors: PRIORS });
  });

  it("keeps the priors of the policy, and changes nothing with no priors", () => {
    const other: ScorePriors = { ...PRIORS, certainty: {} };
    const own: AssessPolicy = { ...DEFAULT_ASSESS_POLICY, priors: other };
    expect(policyWithPriors(own, [person(RULE)], PRIORS)).toBe(own);
    expect(policyWithPriors(DEFAULT_ASSESS_POLICY, [person(RULE)], undefined)).toBe(DEFAULT_ASSESS_POLICY);
  });
});

describe("the schemas of the score rule", () => {
  it("accepts a rule with a risk above 0 and the codes of the taxonomy", () => {
    expect(scoreRuleSchema.safeParse({ risk: 0.01 }).success).toBe(true);
    expect(scoreRuleSchema.safeParse({ risk: 0.01, except: ["met.rip-current", "met.surf", "met.beach-hazards"] }).success).toBe(true);
    expect(personWatchSchema.safeParse(person({ risk: 0.003, except: ["met.surf"] })).success).toBe(true);
    expect(assessPolicySchema.safeParse(SCORED).success).toBe(true);
  });

  it("refuses a risk of 0 or below, an unknown code and an extra field", () => {
    for (const bad of [{ risk: 0 }, { risk: -0.01 }, { risk: Number.POSITIVE_INFINITY }, { risk: 0.01, except: ["met.no-such-kind"] }, { risk: 0.01, extra: 1 }, {}]) {
      expect(scoreRuleSchema.safeParse(bad).success).toBe(false);
    }
  });
});
