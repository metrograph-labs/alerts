/**
 * The shadow score of an incident: the probability of the event and the harm of one event, from public
 * measures. The score operates next to the table. It decides a level only for a person with a score rule
 * (`PersonWatch.score`, AL-31). Else the table decides each send, and the gate test of `score.test.ts` holds this.
 */

import { interval } from "@mark1russell7/interval";
import { compareCodeUnits } from "@mark1russell7/text/order";
import { hasKind } from "./kind-prefix.ts";
import {
  LEVELS,
  type Certainty,
  type Estimate,
  type ExpectedHarm,
  type Incident,
  type KindPrior,
  type ScoredIncident,
  type ScoreFactor,
  type ScoreGap,
  type ScorePriors,
  type ShadowDifference,
  type ShadowScore,
  type Significance,
  type UnderPrior,
} from "./contracts.ts";

/** The format of a file of priors. */
export const PRIORS_FORMAT: ScorePriors["format"] = "alerts-priors/2";

// The value of the longest prefix of the kind that gives a value. A prefix ends at a dot, as in `hasKind`.
function longestPrefix<T>(priors: ScorePriors, kind: string, pick: (prior: KindPrior) => T | undefined): { readonly value: T; readonly key: string } | undefined {
  let found: { readonly value: T; readonly key: string } | undefined;
  for (const [key, prior] of Object.entries(priors.kinds)) {
    const value = pick(prior);
    if (value === undefined || !hasKind([key], kind)) continue;
    if (found === undefined || key.length > found.key.length) found = { value, key };
  }
  return found;
}

// The field of the longest prefix of the kind that has the field.
function kindFactor(priors: ScorePriors, kind: string, field: "verified" | "deaths" | "injuries"): ScoreFactor | undefined {
  const found = longestPrefix(priors, kind, (prior) => prior[field]);
  return found === undefined ? undefined : { estimate: found.value, from: { table: "kinds", key: found.key } };
}

// The harm under one alert of the significance, from the longest prefix of the kind with that measure.
function underOf(priors: ScorePriors, kind: string, significance: Significance): { readonly prior: UnderPrior; readonly key: string } | undefined {
  const found = longestPrefix(priors, kind, (prior) => prior.under?.[significance]);
  return found === undefined ? undefined : { prior: found.value, key: found.key };
}

// The probability of a CAP certainty value.
function certaintyFactor(priors: ScorePriors, certainty: Certainty): ScoreFactor | undefined {
  const estimate = priors.certainty[certainty];
  return estimate === undefined ? undefined : { estimate, from: { table: "certainty", key: certainty } };
}

/**
 * This function gives the product of a probability and a count. `mul` of `@mark1russell7/interval` rounds the interval
 * outward. The two factors are 0 or more, thus the exact product is 0 or more. A low bound below 0 becomes 0, and the
 * interval still holds each product. An underflow to 0 gives such a bound.
 */
export function expectedOf(probability: Estimate, count: Estimate): Estimate {
  const bounds = interval.mul([probability.low, probability.high], [count.low, count.high]);
  if (bounds === null) throw new Error("The product of two intervals that are not empty is not empty.");
  return { value: probability.value * count.value, low: Math.max(0, bounds[0]), high: bounds[1] };
}

/**
 * This function calculates the shadow score of an incident from the priors.
 *
 * - An observed event has the basis `event`. The harm under an alert counts each alert, also the alerts with no event.
 *   Thus it is too low for an event that occurs.
 * - Else an incident with a significance has the basis `alert` when the priors give the harm under its alerts. The
 *   longest prefix of the kind with a measure of that significance decides.
 * - Else the basis is `event`. The probability of a warning is the verified share of the warnings of its kind. The
 *   measure of the warnings is data, so it decides over the certainty word of the sender.
 * - Else the probability is that of the certainty of the incident.
 * - The deaths and the injuries of one event come from the longest prefix of the kind with each field.
 * - The expected harm is the probability times the deaths and times the injuries (`expectedOf`).
 *
 * A factor that the priors do not give makes a score with no read. The score names each missing factor.
 */
export function shadowScore(incident: Pick<Incident, "kind" | "certainty">, priors: ScorePriors): ShadowScore {
  const code = incident.kind.code;
  const significance = incident.kind.significance;
  const under = incident.certainty === "observed" || significance === undefined ? undefined : underOf(priors, code, significance);
  if (under !== undefined && significance !== undefined) {
    const from = { table: "under", key: under.key, significance, area: under.prior.area } as const;
    const { deaths, injuries } = under.prior;
    return { read: true, basis: "alert", deaths: { estimate: deaths, from }, injuries: { estimate: injuries, from }, expected: { deaths, injuries } };
  }
  const verified = incident.certainty !== "observed" && incident.kind.significance === "warning" ? kindFactor(priors, code, "verified") : undefined;
  const probability = verified ?? certaintyFactor(priors, incident.certainty);
  const deaths = kindFactor(priors, code, "deaths");
  const injuries = kindFactor(priors, code, "injuries");
  if (probability !== undefined && deaths !== undefined && injuries !== undefined) {
    const expected = { deaths: expectedOf(probability.estimate, deaths.estimate), injuries: expectedOf(probability.estimate, injuries.estimate) };
    return { read: true, basis: "event", probability, deaths, injuries, expected };
  }
  const missing: ScoreGap[] = [];
  if (probability === undefined) missing.push("probability");
  if (deaths === undefined) missing.push("deaths");
  if (injuries === undefined) missing.push("injuries");
  return { read: false, missing };
}

// True when each expected measure of `a` is above that of `b`, and the intervals do not overlap.
function harmAbove(a: ExpectedHarm, b: ExpectedHarm): boolean {
  return a.deaths.low > b.deaths.high && a.injuries.low > b.injuries.high;
}

/**
 * This function gives each difference between the table and the shadow score. In a difference, the table gives
 * `above` the higher level, and the score of `below` is higher on each measure with no overlap. Thus the function
 * needs no weight between a death and an injury.
 *
 * - An incident with the level `none` or with a score with no read is in no difference.
 * - The differences are in the code-point order of `above`, then of `below`. Thus the order of the input does not change them.
 */
export function shadowDifferences(incidents: readonly ScoredIncident[]): ShadowDifference[] {
  const scored = incidents.flatMap((incident) =>
    incident.level === "none" || incident.shadow?.read !== true ? [] : [{ anchor: incident.anchor, rank: LEVELS.indexOf(incident.level), expected: incident.shadow.expected }],
  );
  const differences: ShadowDifference[] = [];
  for (const high of scored) {
    for (const low of scored) if (high.rank > low.rank && harmAbove(low.expected, high.expected)) differences.push({ above: high.anchor, below: low.anchor });
  }
  return differences.sort((a, b) => compareCodeUnits(a.above, b.above) || compareCodeUnits(a.below, b.below));
}
