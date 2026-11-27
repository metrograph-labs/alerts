/**
 * The priors of the shadow score (`ScorePriors`, format `alerts-priors/2`) from the file of the base rates. This is
 * step 2c of AL-31, and step 4a adds the harm under an active alert. The function is pure, so the same file of rates
 * gives the same priors, bit for bit.
 *
 * - The verified share of a kind comes from Cow (`ownShare`). It is the share of the warnings that a storm report of
 *   the same hazard verified. The interval is the gate interval of the share. A share with a reason of no read gives no
 *   prior.
 * - The deaths and the injuries of one event of a kind come from NCEI. Each is its count over its events, summed over
 *   the types of the kind. The interval is the hull of the exact Poisson interval and the percentile bootstrap over the
 *   years. A kind with no event gives no prior.
 * - The probability of each CAP certainty word is the middle of its band, and the interval is the band.
 * - The share of the deaths of a kind from one cause comes from the cited counts of `causes.ts` (`causeShareOf`).
 * - The harm under one active alert of a kind and a significance comes from the section `under`. It is the harm in one
 *   kind of area over the areas of that kind (`underOf`). The interval is that of the deaths of one event.
 *
 * A field with no prior is absent. Then the shadow score of a kind with that field has no read. It does not take 0.
 */

import { PRIORS_FORMAT, type AlertArea, type Certainty, type Estimate, type KindPrior, type ScorePriors, type Significance, type UnderPrior } from "@mark1russell7/alerts";
import { SIGNIFICANCE } from "@mark1russell7/alerts-format-nws";
import { bootstrap, poissonInterval } from "@mark1russell7/rigor-statistics";

import { CAUSE_READS, causeSharesOf } from "./causes.ts";
import { BOOTSTRAP_RUNS, LEVEL, type RatesFile, type Share } from "./rates.ts";
import type { AreaType, UnderKind, UnderRate } from "./under.ts";
import { ALERT_SIGNIFICANCES } from "./watchwarn.ts";
import { eachYear } from "./years.ts";

/** The CAP certainty words, in the order of the contract. */
const CERTAINTIES: readonly Certainty[] = ["observed", "likely", "possible", "unlikely", "unknown"];

/** The counts of one year: the units of the exposure (events or areas), and their deaths and injuries. */
interface YearCount {
  readonly units: number;
  readonly deaths: number;
  readonly injuries: number;
}

/** The kind of area of each area type of the base rates. */
const AREA_OF: Readonly<Record<AreaType, AlertArea>> = { counties: "county", zones: "zone" };

/** This function gives the prior of a verified share, or undefined when the gate cannot read the share. */
function verifiedOf(share: Share): Estimate | undefined {
  if (share.noRead !== null) return undefined;
  return { value: share.value, low: share.gate[0], high: share.gate[1] };
}

/**
 * This function gives the count of one unit (an event or an area), or undefined when the years have no unit.
 *
 * - The exact Poisson interval of the count over the units holds a small count. A count of 0 gets a wide interval, not
 *   a point at 0.
 * - The percentile bootstrap over the years holds the change from year to year. It applies only when each year has a
 *   unit. Otherwise a draw of the years can have no unit, and its share has no value.
 * - The interval is the hull of the two intervals and the value.
 */
function perUnitOf(years: readonly YearCount[], part: "deaths" | "injuries", seed: string): Estimate | undefined {
  const units = years.reduce((sum, year) => sum + year.units, 0);
  if (units === 0) return undefined;
  const count = years.reduce((sum, year) => sum + year[part], 0);
  const value = count / units;
  const exact = poissonInterval(count, units, LEVEL);
  let low = Math.min(exact.low, value);
  let high = Math.max(exact.high, value);
  if (years.every((year) => year.units > 0)) {
    const drawn = bootstrap(years, (sample) => sample.reduce((sum, year) => sum + year[part], 0) / sample.reduce((sum, year) => sum + year.units, 0), {
      runs: BOOTSTRAP_RUNS,
      level: LEVEL,
      seed,
    });
    low = Math.min(low, drawn.low);
    high = Math.max(high, drawn.high);
  }
  return { value, low, high };
}

/** This function gives the counts of each kind in each year of NCEI, summed over the event types of the kind. Each year of the file has a row. */
function nceiYears(rates: RatesFile): Map<string, YearCount[]> {
  const years: string[] = [];
  for (let year = rates.ncei.years.first; year <= rates.ncei.years.last; year += 1) years.push(String(year));
  const kinds = new Map<string, Map<string, { events: number; deaths: number; injuries: number }>>();
  for (const type of Object.keys(rates.ncei.types).sort()) {
    const rate = rates.ncei.types[type];
    if (rate === undefined || rate.kind === null) continue;
    let byYear = kinds.get(rate.kind);
    if (byYear === undefined) {
      byYear = new Map(years.map((year) => [year, { events: 0, deaths: 0, injuries: 0 }]));
      kinds.set(rate.kind, byYear);
    }
    for (const [year, count] of Object.entries(rate.byYear)) {
      const sum = byYear.get(year);
      if (sum === undefined) throw new Error(`The NCEI type ${type} has the year ${year}, out of the years of the file.`);
      sum.events += count.events;
      sum.deaths += count.deaths;
      sum.injuries += count.injuries;
    }
  }
  return new Map([...kinds].map(([kind, byYear]) => [kind, [...byYear.values()].map((year) => ({ units: year.events, deaths: year.deaths, injuries: year.injuries }))]));
}

/**
 * This function gives the area type of the measure of an alert kind and a significance. NCEI enters most events of a
 * kind in one area type, so the type with more placed events decides. On a tie, the type with more areas decides. On a
 * tie of the areas too, the counties decide.
 */
export function areaTypeOf(kind: UnderKind, rate: UnderRate): AreaType {
  const { counties, zones } = kind.placed;
  if (counties !== zones) return counties > zones ? "counties" : "zones";
  const areas = (type: AreaType): number => Object.values(rate.byArea[type].areas).reduce((sum, count) => sum + count, 0);
  return areas("zones") > areas("counties") ? "zones" : "counties";
}

/**
 * This function gives the harm in one area under one active alert of a kind, for each significance with one or more
 * areas. The harm is that of the NCEI kind in the areas of one type, over the areas of that type (`areaTypeOf`). A kind
 * with no NCEI kind gives no prior: NCEI does not measure its harm, and 0 is not a measure.
 */
function underOf(kind: string, under: UnderKind, years: readonly string[]): Partial<Record<Significance, UnderPrior>> | undefined {
  if (under.nceiKind === null) return undefined;
  const priors: Partial<Record<Significance, UnderPrior>> = {};
  for (const letter of ALERT_SIGNIFICANCES) {
    const rate = under.significances[letter];
    if (rate === undefined) continue;
    const word = SIGNIFICANCE[letter];
    if (word === undefined) throw new Error(`The significance ${letter} has no word.`);
    const type = areaTypeOf(under, rate);
    const area = rate.byArea[type];
    const counts = years.map((year) => ({ units: area.areas[year] ?? 0, deaths: area.harm[year]?.deaths ?? 0, injuries: area.harm[year]?.injuries ?? 0 }));
    const deaths = perUnitOf(counts, "deaths", `priors/${kind}/under/${word}/deaths`);
    const injuries = perUnitOf(counts, "injuries", `priors/${kind}/under/${word}/injuries`);
    if (deaths !== undefined && injuries !== undefined) priors[word] = { deaths, injuries, area: AREA_OF[type] };
  }
  return Object.keys(priors).length === 0 ? undefined : priors;
}

/**
 * This function gives the priors of the shadow score from a file of the base rates. The keys of `kinds` are in the
 * order of the codes, so the JSON text of the priors is stable. It throws an error when two Cow phenomena have the
 * same kind, or when the CAP bands do not have each certainty word.
 */
export function priorsOf(rates: RatesFile): ScorePriors {
  const kinds = new Map<string, { -readonly [K in keyof KindPrior]: KindPrior[K] }>();
  const entry = (kind: string): { -readonly [K in keyof KindPrior]: KindPrior[K] } => {
    let prior = kinds.get(kind);
    if (prior === undefined) {
      prior = {};
      kinds.set(kind, prior);
    }
    return prior;
  };

  const shareKinds = new Set<string>();
  for (const rate of Object.values(rates.cow.phenomena)) {
    if (shareKinds.has(rate.kind)) throw new Error(`Two Cow phenomena have the kind ${rate.kind}.`);
    shareKinds.add(rate.kind);
    const verified = verifiedOf(rate.ownShare);
    if (verified !== undefined) entry(rate.kind).verified = verified;
  }

  for (const [kind, years] of nceiYears(rates)) {
    const deaths = perUnitOf(years, "deaths", `priors/${kind}/deaths`);
    const injuries = perUnitOf(years, "injuries", `priors/${kind}/injuries`);
    if (deaths !== undefined) entry(kind).deaths = deaths;
    if (injuries !== undefined) entry(kind).injuries = injuries;
  }

  const underYears = eachYear(rates.under.years).map(String);
  for (const [kind, under] of Object.entries(rates.under.kinds)) {
    const priors = underOf(kind, under, underYears);
    if (priors !== undefined) entry(kind).under = priors;
  }

  for (const [kind, causes] of causeSharesOf(CAUSE_READS)) entry(kind).causes = causes;

  const certainty: Partial<Record<Certainty, Estimate>> = {};
  for (const word of CERTAINTIES) {
    const band = rates.cap.bands[word];
    if (band === undefined) throw new Error(`The CAP bands have no certainty ${word}.`);
    certainty[word] = { value: (band.low + band.high) / 2, low: band.low, high: band.high };
  }

  const sorted = [...kinds].filter(([, prior]) => Object.keys(prior).length > 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { format: PRIORS_FORMAT, kinds: Object.fromEntries(sorted), certainty };
}
