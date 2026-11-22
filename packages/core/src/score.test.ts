import { random, seedsFrom, type Random } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import { assess, assessWithShadow, LIFE_SAFETY_KINDS } from "./assess.ts";
import type {
  Area,
  AssessedLevel,
  Certainty,
  Estimate,
  Incident,
  KindPrior,
  LevelRule,
  PersonId,
  PersonWatch,
  PlaceId,
  ReportId,
  ScoredIncident,
  ScoreFactor,
  ScorePriors,
  ShadowScore,
  Severity,
  Significance,
  Status,
  Urgency,
  WatchedPlace,
} from "./contracts.ts";
import { ASSESSED_LEVELS } from "./contracts.ts";
import { assessmentSchema, scorePriorsSchema, shadowScoreSchema } from "./schemas.ts";
import { expectedOf, PRIORS_FORMAT, shadowDifferences, shadowScore } from "./score.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);

// Made-up values. They are not the public measures.
const estimate = (value: number, low: number, high: number): Estimate => ({ value, low, high });
const PRIORS: ScorePriors = {
  format: PRIORS_FORMAT,
  kinds: {
    met: { deaths: estimate(0.01, 0.005, 0.02), injuries: estimate(0.05, 0.03, 0.08) },
    "met.tornado": { verified: estimate(0.3, 0.28, 0.33), deaths: estimate(0.04, 0.03, 0.06), injuries: estimate(0.6, 0.4, 0.9) },
    "met.flood.flash": { deaths: estimate(0.02, 0.01, 0.03), injuries: estimate(0.01, 0.005, 0.02) },
  },
  certainty: {
    observed: estimate(1, 1, 1),
    likely: estimate(0.75, 0.5, 1),
    possible: estimate(0.25, 0, 0.5),
  },
};

// The priors of the tests with the harm under an alert. Made-up values.
const UNDER: ScorePriors = {
  ...PRIORS,
  kinds: {
    ...PRIORS.kinds,
    met: { ...PRIORS.kinds["met"], under: { watch: { deaths: estimate(0.0001, 0.00005, 0.0002), injuries: estimate(0.001, 0.0005, 0.002), area: "zone" } } },
    "met.tornado": { ...PRIORS.kinds["met.tornado"], under: { warning: { deaths: estimate(0.003, 0.002, 0.005), injuries: estimate(0.03, 0.02, 0.05), area: "county" } } },
  },
};

// The score of the basis event, or a failed test.
function eventOf(score: ShadowScore): Extract<ShadowScore, { readonly probability: ScoreFactor }> {
  if (!score.read || score.basis === "alert") throw new Error(`The score is not of the basis event: ${JSON.stringify(score)}.`);
  return score;
}

const home = "place:home" as PlaceId;
const places: readonly WatchedPlace[] = [{ id: home, codes: [{ system: "ugc", code: "KSC173" }], bufferKm: 0 }];
const atHome: readonly Area[] = [{ type: "code", system: "ugc", code: "KSC173" }];
const elsewhere: readonly Area[] = [{ type: "code", system: "ugc", code: "TXC029" }];

function person(rules: readonly LevelRule[] = []): PersonWatch {
  return { person: "person-1" as PersonId, places: [home], rules };
}

function incident(kind: string, fields: Partial<Omit<Incident, "kind">> = {}, significance?: Significance): Incident {
  return {
    anchor: "a".repeat(64) as ReportId,
    reports: ["a".repeat(64) as ReportId],
    status: "actual",
    kind: significance === undefined ? { code: kind, label: kind } : { code: kind, significance, label: kind },
    severity: "extreme",
    urgency: "immediate",
    certainty: "likely",
    areas: atHome,
    about: [],
    live: true,
    corroboration: 1,
    ...fields,
  };
}

describe("shadowScore", () => {
  it("gives a warning the verified share of its kind, and not the certainty word", () => {
    const score = shadowScore(incident("met.tornado", {}, "warning"), PRIORS);
    expect(score).toMatchObject({
      read: true,
      basis: "event",
      probability: { estimate: estimate(0.3, 0.28, 0.33), from: { table: "kinds", key: "met.tornado" } },
      deaths: { estimate: estimate(0.04, 0.03, 0.06), from: { table: "kinds", key: "met.tornado" } },
      injuries: { estimate: estimate(0.6, 0.4, 0.9), from: { table: "kinds", key: "met.tornado" } },
    });
    expect(shadowScoreSchema.safeParse(score).success).toBe(true);
  });

  it("gives an observed event the probability of the certainty observed", () => {
    const score = shadowScore(incident("met.tornado", { certainty: "observed" }, "warning"), PRIORS);
    expect(eventOf(score).probability).toEqual({ estimate: estimate(1, 1, 1), from: { table: "certainty", key: "observed" } });
  });

  it("gives the certainty to a watch, and to a warning of a kind with no verified share", () => {
    const watch = shadowScore(incident("met.tornado", { certainty: "possible" }, "watch"), PRIORS);
    expect(eventOf(watch).probability.from).toEqual({ table: "certainty", key: "possible" });
    const flood = shadowScore(incident("met.flood.flash", {}, "warning"), PRIORS);
    expect(eventOf(flood).probability.from).toEqual({ table: "certainty", key: "likely" });
    expect(flood.read && flood.deaths.from).toEqual({ table: "kinds", key: "met.flood.flash" });
  });

  it("takes each field from the longest prefix of the kind with that field", () => {
    const wind = shadowScore(incident("met.wind.high", {}, "warning"), PRIORS);
    const event = eventOf(wind);
    expect([event.probability.from.key, event.deaths.from.key, event.injuries.from.key]).toEqual(["likely", "met", "met"]);
    const tornado = shadowScore(incident("met.tornado.waterspout", {}, "warning"), PRIORS);
    expect(eventOf(tornado).probability.from.key).toBe("met.tornado");
  });

  it("multiplies the probability and each count, and an exact product gives exact bounds", () => {
    const dyadic: ScorePriors = {
      format: PRIORS_FORMAT,
      kinds: { "met.tornado": { verified: estimate(0.5, 0.25, 1), deaths: estimate(2, 1, 4), injuries: estimate(3, 2, 8) } },
      certainty: {},
    };
    const score = shadowScore(incident("met.tornado", {}, "warning"), dyadic);
    expect(score.read && score.expected).toEqual({ deaths: estimate(1, 0.25, 4), injuries: estimate(1.5, 0.5, 8) });
  });

  it("rounds an inexact product outward, so the interval holds the exact product", () => {
    const tenth = estimate(0.1, 0.1, 0.1);
    const product = expectedOf(tenth, tenth);
    // The float product of 0.1 and 0.1 is not exact. Thus each bound is one step out from it.
    expect(product.value).toBe(0.1 * 0.1);
    expect(product.low).toBeLessThan(product.value);
    expect(product.high).toBeGreaterThan(product.value);
    expect(product.high - product.low).toBeLessThan(1e-17);
  });

  it("keeps the low bound at 0 or more when a product underflows", () => {
    const tiny = estimate(Number.MIN_VALUE, Number.MIN_VALUE, Number.MIN_VALUE);
    const product = expectedOf(tiny, tiny);
    expect(product).toEqual({ value: 0, low: 0, high: Number.MIN_VALUE });
    expect(expectedOf(estimate(0, 0, 0), estimate(5, 1, 9))).toEqual(estimate(0, 0, 0));
  });

  it("gives a finite interval for the largest counts of the priors", () => {
    const largest = estimate(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const product = expectedOf(estimate(1, 1, 1), largest);
    expect(product).toEqual(largest);
    expect(Number.isFinite(expectedOf(estimate(0.7, 0.6, 1), largest).high)).toBe(true);
  });

  it("gives an alert the harm under the alerts of its kind and significance", () => {
    const score = shadowScore(incident("met.tornado", {}, "warning"), UNDER);
    const from = { table: "under", key: "met.tornado", significance: "warning", area: "county" } as const;
    expect(score).toEqual({
      read: true,
      basis: "alert",
      deaths: { estimate: estimate(0.003, 0.002, 0.005), from },
      injuries: { estimate: estimate(0.03, 0.02, 0.05), from },
      expected: { deaths: estimate(0.003, 0.002, 0.005), injuries: estimate(0.03, 0.02, 0.05) },
    });
    expect(shadowScoreSchema.safeParse(score).success).toBe(true);
  });

  it("takes the harm under an alert from the longest prefix of the kind with a measure of the significance", () => {
    const spout = shadowScore(incident("met.tornado.waterspout", {}, "warning"), UNDER);
    expect(spout.read && spout.deaths.from).toEqual({ table: "under", key: "met.tornado", significance: "warning", area: "county" });
    // The kind `met.tornado` has no measure of its watches. Thus the measure of `met` decides.
    const watch = shadowScore(incident("met.tornado", { certainty: "possible" }, "watch"), UNDER);
    expect(watch.read && watch.deaths.from).toEqual({ table: "under", key: "met", significance: "watch", area: "zone" });
  });

  it("gives the basis event to an observed event, to an incident with no significance and to a significance with no measure", () => {
    expect(eventOf(shadowScore(incident("met.tornado", { certainty: "observed" }, "warning"), UNDER)).probability.from).toEqual({ table: "certainty", key: "observed" });
    expect(eventOf(shadowScore(incident("met.tornado"), UNDER)).probability.from).toEqual({ table: "certainty", key: "likely" });
    expect(eventOf(shadowScore(incident("met.tornado", {}, "advisory"), UNDER)).probability.from).toEqual({ table: "certainty", key: "likely" });
  });

  it("has no read when the priors do not give a factor, and names each missing factor", () => {
    expect(shadowScore(incident("geo.earthquake", { certainty: "unknown" }), PRIORS)).toEqual({ read: false, missing: ["probability", "deaths", "injuries"] });
    expect(shadowScore(incident("geo.earthquake"), PRIORS)).toEqual({ read: false, missing: ["deaths", "injuries"] });
    // A prefix ends at a dot: `met` is not a prefix of `metro.transit`.
    expect(shadowScore(incident("metro.transit"), PRIORS)).toEqual({ read: false, missing: ["deaths", "injuries"] });
    const partial: ScorePriors = { ...PRIORS, kinds: { "met.tornado": { deaths: estimate(0.04, 0.03, 0.06) } } };
    expect(shadowScore(incident("met.tornado", {}, "warning"), partial)).toEqual({ read: false, missing: ["injuries"] });
  });
});

describe("scorePriorsSchema", () => {
  it("accepts the priors of the tests", () => {
    expect(scorePriorsSchema.safeParse(PRIORS).success).toBe(true);
  });

  it("refuses a key that is not a code of the taxonomy, because a typo matches no kind", () => {
    const prior: KindPrior = { deaths: estimate(0.01, 0.005, 0.02) };
    expect(scorePriorsSchema.safeParse({ ...PRIORS, kinds: { "met.tornadoes": prior } }).success).toBe(false);
    expect(scorePriorsSchema.safeParse({ ...PRIORS, kinds: { "met.fl": prior } }).success).toBe(false);
  });

  it("refuses an interval that does not hold its value, a probability above 1 and an unknown field", () => {
    const withKind = (prior: KindPrior): unknown => ({ ...PRIORS, kinds: { met: prior } });
    expect(scorePriorsSchema.safeParse(withKind({ deaths: estimate(0.5, 0.6, 0.7) })).success).toBe(false);
    expect(scorePriorsSchema.safeParse(withKind({ verified: estimate(1.2, 1, 1.4) })).success).toBe(false);
    expect(scorePriorsSchema.safeParse(withKind({ deaths: estimate(-1, -1, 0) })).success).toBe(false);
    expect(scorePriorsSchema.safeParse(withKind({ deaths: estimate(1, 0, Number.MAX_SAFE_INTEGER + 1) })).success).toBe(false);
    expect(scorePriorsSchema.safeParse({ ...PRIORS, certainty: { sure: estimate(1, 1, 1) } }).success).toBe(false);
    expect(scorePriorsSchema.safeParse({ ...PRIORS, format: "alerts-priors/1" }).success).toBe(false);
  });

  it("accepts the harm under an alert, and refuses a measure with no kind of area or an unknown significance", () => {
    expect(scorePriorsSchema.safeParse(UNDER).success).toBe(true);
    const harm = { deaths: estimate(0.003, 0.002, 0.005), injuries: estimate(0.03, 0.02, 0.05) };
    const withUnder = (under: unknown): unknown => ({ ...PRIORS, kinds: { met: { under } } });
    expect(scorePriorsSchema.safeParse(withUnder({ warning: harm })).success).toBe(false);
    expect(scorePriorsSchema.safeParse(withUnder({ warnings: { ...harm, area: "county" } })).success).toBe(false);
    expect(scorePriorsSchema.safeParse(withUnder({ warning: { ...harm, area: "state" } })).success).toBe(false);
  });
});

describe("shadowScoreSchema", () => {
  it("refuses a score of the basis alert with a factor of another table, or with a probability", () => {
    const score = shadowScore(incident("met.tornado", {}, "warning"), UNDER);
    if (!score.read || score.basis !== "alert") throw new Error("The score is not of the basis alert.");
    const kinds = { ...score.deaths, from: { table: "kinds", key: "met.tornado" } };
    expect(shadowScoreSchema.safeParse({ ...score, deaths: kinds }).success).toBe(false);
    expect(shadowScoreSchema.safeParse({ ...score, probability: score.deaths }).success).toBe(false);
    expect(shadowScoreSchema.safeParse({ ...score, basis: "event" }).success).toBe(false);
  });

  it("accepts a score of the basis event with no field basis, as a log line from before the basis alert has it", () => {
    const { basis, ...old } = eventOf(shadowScore(incident("met.tornado", {}, "warning"), PRIORS));
    expect(basis).toBe("event");
    expect(shadowScoreSchema.safeParse(old).success).toBe(true);
  });
});

describe("assessWithShadow", () => {
  it("adds the score as the last reason, and keeps the level and the reasons of the table", () => {
    const tornado = incident("met.tornado", {}, "warning");
    const plain = assess(tornado, person(), places);
    const shadow = assessWithShadow(tornado, person(), places, PRIORS);
    expect(shadow.level).toBe("life-safety");
    expect(shadow).toEqual({ ...plain, reasons: [...plain.reasons, { kind: "shadow", score: shadowScore(tornado, PRIORS) }] });
    expect(assessmentSchema.safeParse(shadow).success).toBe(true);
  });

  it("adds no score to an assessment with no reason of the table", () => {
    for (const draft of [incident("met.tornado", { areas: elsewhere }), incident("met.tornado", { live: false }), incident("met.tornado", { status: "test" })]) {
      expect(assessWithShadow(draft, person(), places, PRIORS)).toEqual(assess(draft, person(), places));
    }
  });
});

// The gate of the shadow: the table decides each send. A score of each shape keeps the level and the
// reasons of `assess`. A change that lets the score decide fails this test.
describe("the gate of the shadow score", () => {
  const KINDS = [...LIFE_SAFETY_KINDS, "met.wind.high", "met.tornado.waterspout", "infra.power.outage", "metro.transit"];
  const SEVERITIES: readonly Severity[] = ["minor", "moderate", "severe", "extreme", "unknown"];
  const URGENCIES: readonly Urgency[] = ["past", "future", "expected", "immediate", "unknown"];
  const CERTAINTIES: readonly Certainty[] = ["observed", "likely", "possible", "unlikely", "unknown"];
  const SIGNIFICANCES: readonly (Significance | undefined)[] = [undefined, "warning", "watch", "advisory", "statement"];
  const STATUSES: readonly Status[] = ["actual", "actual", "actual", "exercise", "test"];
  const pick = <T,>(r: Random, values: readonly T[]): T => values[r.int(0, values.length - 1)]!;
  const draw = (r: Random, max: number): Estimate => {
    const [a, b, c] = [r.int(0, 100), r.int(0, 100), r.int(0, 100)].sort((x, y) => x - y) as [number, number, number];
    return estimate((b / 100) * max, (a / 100) * max, (c / 100) * max);
  };
  const somePriors = (r: Random): ScorePriors => {
    const kinds: Record<string, KindPrior> = {};
    for (const key of ["met", "met.tornado", "met.flood", "geo", "safety.civil-danger"]) {
      if (r.chance(0.3)) continue;
      const under: Partial<Record<Significance, { deaths: Estimate; injuries: Estimate; area: "county" | "zone" }>> = {};
      for (const significance of ["warning", "watch", "advisory"] as const) {
        if (r.chance(0.25)) under[significance] = { deaths: draw(r, 0.01), injuries: draw(r, 0.1), area: r.chance(0.5) ? "county" : "zone" };
      }
      kinds[key] = {
        ...(r.chance(0.6) ? { verified: draw(r, 1) } : {}),
        ...(r.chance(0.7) ? { deaths: draw(r, 5) } : {}),
        ...(r.chance(0.7) ? { injuries: draw(r, 50) } : {}),
        ...(Object.keys(under).length > 0 ? { under } : {}),
      };
    }
    const certainty: Partial<Record<Certainty, Estimate>> = {};
    for (const value of CERTAINTIES) if (r.chance(0.7)) certainty[value] = draw(r, 1);
    return { format: PRIORS_FORMAT, kinds, certainty };
  };
  const someRules = (r: Random): LevelRule[] =>
    Array.from({ length: r.int(0, 2) }, () => ({ ...(r.chance(0.5) ? { kinds: [pick(r, KINDS)] } : {}), max: pick(r, ASSESSED_LEVELS) }));

  it.each(SEEDS)("keeps the level and the reasons of the table for each score (seed %i)", (seed) => {
    const r = random(seed);
    let scored = 0;
    const bases = new Set<string>();
    for (let n = 0; n < 200; n++) {
      const draft = incident(
        pick(r, KINDS),
        {
          status: pick(r, STATUSES),
          severity: pick(r, SEVERITIES),
          urgency: pick(r, URGENCIES),
          certainty: pick(r, CERTAINTIES),
          areas: r.chance(0.8) ? atHome : elsewhere,
          live: r.chance(0.9),
        },
        pick(r, SIGNIFICANCES),
      );
      const who = person(someRules(r));
      const priors = somePriors(r);
      expect(scorePriorsSchema.safeParse(priors).success).toBe(true);
      const plain = assess(draft, who, places);
      const shadow = assessWithShadow(draft, who, places, priors);
      expect(shadow.level).toBe(plain.level);
      expect(shadow.reasons.filter((reason) => reason.kind !== "shadow")).toEqual(plain.reasons);
      expect(shadow.reasons.filter((reason) => reason.kind === "shadow").length).toBeLessThanOrEqual(1);
      expect(assessmentSchema.safeParse(shadow).success).toBe(true);
      if (shadow.reasons.length > plain.reasons.length) scored++;
      for (const reason of shadow.reasons) {
        if (reason.kind !== "shadow" || !reason.score.read) continue;
        bases.add(reason.score.basis ?? "none");
        if (reason.score.basis === "alert") {
          // The measure under an alert holds the probability. Thus the expected harm is each factor.
          expect(reason.score.expected).toEqual({ deaths: reason.score.deaths.estimate, injuries: reason.score.injuries.estimate });
          continue;
        }
        // The interval of each expected count holds the float products of the bounds.
        const { probability, deaths, injuries, expected } = reason.score;
        for (const [count, harm] of [
          [deaths.estimate, expected.deaths],
          [injuries.estimate, expected.injuries],
        ] as const) {
          expect(harm.low).toBeGreaterThanOrEqual(0);
          expect(harm.low).toBeLessThanOrEqual(probability.estimate.low * count.low);
          expect(harm.high).toBeGreaterThanOrEqual(probability.estimate.high * count.high);
        }
      }
    }
    // The draws reach the score and each basis: a gate that sees no score cannot hold the rule.
    expect(scored).toBeGreaterThan(50);
    expect([...bases].sort()).toEqual(["alert", "event"]);
  });
});

describe("shadowDifferences", () => {
  // An incident with a level and an expected harm. Only the expected harm counts in a difference.
  const scored = (anchor: string, level: AssessedLevel, deaths: readonly [number, number], injuries: readonly [number, number]): ScoredIncident => {
    const of = ([low, high]: readonly [number, number]): Estimate => estimate((low + high) / 2, low, high);
    const one = { estimate: estimate(1, 1, 1), from: { table: "certainty", key: "observed" } } as const;
    const kind = { table: "kinds", key: "met" } as const;
    return {
      anchor: anchor.padEnd(64, "0") as ReportId,
      level,
      shadow: { read: true, probability: one, deaths: { estimate: of(deaths), from: kind }, injuries: { estimate: of(injuries), from: kind }, expected: { deaths: of(deaths), injuries: of(injuries) } },
    };
  };

  it("names a pair where the table puts one incident higher and the score puts the other higher on each measure", () => {
    const high = scored("a", "life-safety", [0.01, 0.02], [0.1, 0.2]);
    const low = scored("b", "urgent", [0.03, 0.05], [0.3, 0.4]);
    expect(shadowDifferences([high, low])).toEqual([{ above: high.anchor, below: low.anchor }]);
    expect(shadowDifferences([low, high])).toEqual([{ above: high.anchor, below: low.anchor }]);
  });

  it("names no pair when an interval overlaps, the levels are equal, the order agrees, or a score has no read", () => {
    const high = scored("a", "life-safety", [0.01, 0.02], [0.1, 0.2]);
    expect(shadowDifferences([high, scored("b", "urgent", [0.015, 0.05], [0.3, 0.4])])).toEqual([]);
    expect(shadowDifferences([high, scored("b", "urgent", [0.03, 0.05], [0.2, 0.4])])).toEqual([]);
    expect(shadowDifferences([high, scored("b", "life-safety", [0.03, 0.05], [0.3, 0.4])])).toEqual([]);
    expect(shadowDifferences([high, scored("b", "none", [0.03, 0.05], [0.3, 0.4])])).toEqual([]);
    expect(shadowDifferences([high, scored("b", "notice", [0.001, 0.002], [0.01, 0.02])])).toEqual([]);
    const unread: ScoredIncident = { anchor: "b".padEnd(64, "0") as ReportId, level: "urgent", shadow: { read: false, missing: ["deaths"] } };
    const unscored: ScoredIncident = { anchor: "c".padEnd(64, "0") as ReportId, level: "urgent" };
    expect(shadowDifferences([high, unread, unscored])).toEqual([]);
  });

  it.each(SEEDS)("gives each pair of the rule, in an order that the input order does not change (seed %i)", (seed) => {
    const r = random(seed);
    const span = (): readonly [number, number] => {
      const low = r.range(0, 0.1);
      return [low, low + r.range(0, 0.05)];
    };
    const incidents = Array.from({ length: 12 }, (_, index) => scored(index.toString(16), r.pick(ASSESSED_LEVELS), span(), span()));
    const differences = shadowDifferences(incidents);
    expect(shadowDifferences(r.shuffle(incidents))).toEqual(differences);
    const rank = (level: AssessedLevel): number => ASSESSED_LEVELS.indexOf(level);
    const harm = (incident: ScoredIncident) => (incident.shadow?.read === true ? incident.shadow.expected : undefined);
    const expected = incidents.flatMap((above) =>
      incidents.flatMap((below) => {
        const [a, b] = [harm(above), harm(below)];
        const differs =
          above.level !== "none" && below.level !== "none" && rank(above.level) > rank(below.level) && a !== undefined && b !== undefined && b.deaths.low > a.deaths.high && b.injuries.low > a.injuries.high;
        return differs ? [{ above: above.anchor, below: below.anchor }] : [];
      }),
    );
    const key = (pair: { readonly above: ReportId; readonly below: ReportId }): string => `${pair.above} ${pair.below}`;
    expect(new Set(differences.map(key))).toEqual(new Set(expected.map(key)));
    expect(differences).toHaveLength(expected.length);
  });
});
