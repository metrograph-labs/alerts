/**
 * The placement of the copies of the alert system as a query (AL-53). The query reads the live offers of cloud plans
 * from `@mark1russell7/market-sources`. It gives the front of the expected cost of a month against the chance that
 * some copy works. `@mark1russell7/stack-placement` gives the layer `placement/1`, the search and the front.
 *
 * - Each copy is a slot. The first slot needs a candidate. Each other slot can stay empty.
 * - Each candidate is an offer: a provider, a region and a plan, with its cost of a month.
 * - Each provider and each region is a shared fragment. Thus two copies on one provider share one cause of failure.
 * - Nobody picks a provider or a price. Each offer that meets the needs is a candidate.
 *
 * The chances are inputs. Each input tells if it is measured or assumed, and its source. This module holds no chance
 * and no limit of cost. The caller reads the limit of cost from the private configuration at run time.
 */

import { meteredCost, type MeteredObservation, type PriceTerm } from "@mark1russell7/market";
import { arrayOf, numberOf, textOf } from "@mark1russell7/optional/read";
import { OBJECTIVE_STEPS, PLACEMENT_SCHEMA, planPlacement, type Candidate, type PlacementLayer, type PlacementPlan, type PlacementRow, type PlanOptions, type Shared } from "@mark1russell7/stack-placement";
import { RISK_SCHEMA, worksChance, type RiskLayer } from "@mark1russell7/stack-risk";
import { riskAddOn } from "@mark1russell7/stack-risk/add-on";
import { monthTotal, type SpendLayer } from "@mark1russell7/stack-spend";
import { spendAddOn } from "@mark1russell7/stack-spend/add-on";
import { readLayer, type Stack, type StackJoiner } from "@mark1russell7/system-stack";

/** The id of the function of the base stack: a message gets out of some copy. */
export const PLACEMENT_PART = "send";

/** The hours of a month of the cost of a candidate: 365 days of 24 hours, in 12 months. */
export const HOURS_OF_MONTH = 730;

/** The name of the meter of the hours of use of a plan offer, as in the plan parser of `@mark1russell7/market-sources`. */
export const COMPUTE_METER = "compute";

/** The price terms of a candidate when the needs give none. A copy operates all the time, thus a spot term does not fit. */
export const DEFAULT_TERMS: readonly PriceTerm["kind"][] = ["on-demand"];

/** The most choices that get a grid of each choice. A larger space gets the genetic search of `stack-placement`. */
export const GRID_LIMIT = 50_000;

/** The name of the format of the private front file. */
export const FRONT_FORMAT = "placement-front/1";

/** The name of the private front file in the private folder. */
export const FRONT_FILE = "placement-front.json";

/** The kinds of a chance input: a value from a measured period, or an assumed input parameter. */
export const CHANCE_KINDS: readonly ["measured", "assumed"] = ["measured", "assumed"];

/** A kind of a chance input. */
export type ChanceKind = (typeof CHANCE_KINDS)[number];

/** One chance input: the chance that a part works at a moment, its kind and its source. */
export interface ChanceInput {
  /** The chance that the part works, from 0 to 1. */
  readonly works: number;
  /** The kind of the value. An `assumed` value is an input parameter, not a fact. */
  readonly kind: ChanceKind;
  /** The source of the value, for example a measured period of a status page, or the name of the input parameter. */
  readonly source: string;
}

/** One chance input for one fragment, by the id of the fragment: for example `provider:provider-a`. */
export interface ChanceOverride extends ChanceInput {
  /** The id of the provider fragment or of the region fragment. */
  readonly id: string;
}

/**
 * The chance inputs of a placement. Each provider, each region and each host gets the input of its kind. An override
 * replaces the input of one provider or of one region.
 */
export interface PlacementChances {
  /** The chance that a provider works: its control plane, its network and its account. */
  readonly provider: ChanceInput;
  /** The chance that a region of a provider works: its power, its cooling and its links. */
  readonly region: ChanceInput;
  /** The chance that one host of a copy works, when its provider and its region work. */
  readonly host: ChanceInput;
  /** The inputs of single providers or regions. */
  readonly overrides?: readonly ChanceOverride[] | undefined;
}

/** The needs of a copy. An offer that does not meet them is not a candidate. */
export interface CopyNeeds {
  /** The least memory of a host, in MiB. */
  readonly minMemoryMiB: number;
  /** The price terms that fit. The default is `DEFAULT_TERMS`. */
  readonly terms?: readonly PriceTerm["kind"][] | undefined;
  /** The currency of each cost, for example `USD`. An offer in a different currency is not a candidate. */
  readonly currency: string;
}

/** The inputs of a placement layer. */
export interface PlacementInput {
  /** The live offers, for example from the plan client of `@mark1russell7/market-sources`. */
  readonly offers: readonly MeteredObservation[];
  /** The needs of a copy. */
  readonly needs: CopyNeeds;
  /** The chance inputs. */
  readonly chances: PlacementChances;
  /** The count of copies, 1 or more. Each copy is one slot. */
  readonly copies: number;
  /** The largest expected cost of a month, from the private configuration. Without it, the layer has no limit of cost. */
  readonly costLimit?: number | undefined;
}

/** The reasons to skip an offer. */
export const SKIP_REASONS: readonly ["term", "currency", "memory", "meter", "dearer"] = ["term", "currency", "memory", "meter", "dearer"];

/**
 * A reason to skip an offer: a term that does not fit, a different currency, too little memory or no compute meter.
 * The reason `dearer` tells that a cheaper offer of the same provider and region is the candidate.
 */
export type SkipReason = (typeof SKIP_REASONS)[number];

/** A placement layer with its base stack, and the count of offers for each reason to skip. */
export interface PlacementBuild {
  /** The placement layer. */
  readonly layer: PlacementLayer;
  /** The base stack: the function `send` works when one of the slots works. */
  readonly base: Stack;
  /** The count of offers that the layer read. */
  readonly offers: number;
  /** The count of skipped offers for each reason. */
  readonly skipped: Readonly<Record<SkipReason, number>>;
}

/** This function gives the id of the slot of the copy `index`, from 0: `copy-1`, `copy-2` and so on. */
export function slotId(index: number): string {
  return `copy-${String(index + 1)}`;
}

/** This function gives the id of the shared fragment of a provider. */
export function providerFragment(provider: string): string {
  return `provider:${provider}`;
}

/** This function gives the id of the shared fragment of a region of a provider. */
export function regionFragment(provider: string, region: string): string {
  return `region:${provider}/${region}`;
}

/**
 * This function gives the memory of an offer in MiB from its spec `memory`, or `undefined`. The spec is a number and a
 * unit, for example `2048 MiB`. The units are MiB and GiB.
 */
export function memoryMiB(observation: MeteredObservation): number | undefined {
  const spec = observation.offer.specs.find((item) => item.name === "memory")?.value;
  const match = spec === undefined ? null : /^(\d+(?:\.\d+)?)\s*(MiB|GiB)$/u.exec(spec.trim());
  if (match === null) return undefined;
  const value = Number(match[1]);
  return match[2] === "GiB" ? value * 1024 : value;
}

/** This function gives the cost of a month of an offer with `HOURS_OF_MONTH` hours of use, or `undefined` when the offer has no compute meter. */
export function monthCost(observation: MeteredObservation): { readonly value: number; readonly currency: string } | undefined {
  if (!observation.reading.meters.some((meter) => meter.name === COMPUTE_METER)) return undefined;
  try {
    const total = meteredCost(observation, { [COMPUTE_METER]: { value: HOURS_OF_MONTH, unit: "h" } }).total;
    return { value: total.value, currency: total.unit };
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}

function checkChance(name: string, input: ChanceInput): void {
  if (!(input.works >= 0 && input.works <= 1)) throw new RangeError(`The chance input ${name} is not from 0 to 1.`);
  if (!CHANCE_KINDS.includes(input.kind)) throw new RangeError(`The chance input ${name} is not measured or assumed.`);
  if (input.source.trim() === "") throw new RangeError(`The chance input ${name} has no source.`);
}

/** This function gives the source text of a chance input in a risk record: its kind, then its source. */
function sourceOf(input: ChanceInput): string {
  return `${input.kind}: ${input.source}`;
}

/** The cheapest offer of one provider and region that meets the needs. */
interface OfferPick {
  readonly provider: string;
  readonly region: string;
  readonly offer: string;
  readonly cost: number;
}

function riskOf(part: string, input: ChanceInput): RiskLayer {
  return { schema: RISK_SCHEMA, goals: [], chances: [{ part, works: input.works, source: sourceOf(input) }] };
}

function candidateOf(slot: string, pick: OfferPick, chances: PlacementChances, currency: string): Candidate {
  const provider = providerFragment(pick.provider);
  const region = regionFragment(pick.provider, pick.region);
  const spend: SpendLayer = { schema: "spend/1", currency, kinds: [], proofDays: 30, services: [{ part: slot, billing: "fixed", price: pick.cost }] };
  return {
    key: `${pick.provider}/${pick.region}`,
    cost: pick.cost,
    uses: [provider, region],
    source: pick.offer,
    stack: { schema: "stack/1", parts: [{ id: slot, kind: "host", needs: [provider, region] }], layers: { "risk/1": riskOf(slot, chances.host), "spend/1": spend } },
  };
}

function sharedOf(id: string, kind: string, input: ChanceInput): Shared {
  return { id, stack: { schema: "stack/1", parts: [{ id, kind }], layers: { "risk/1": riskOf(id, input) } } };
}

/**
 * This function gives the placement layer of the copies from the live offers.
 *
 * - An offer is a candidate when its term fits and its currency is the currency of the needs. It also needs enough
 *   memory and a compute meter.
 * - For each provider and region, only the cheapest such offer is a candidate. Each offer of one provider and region
 *   has the same chances. Thus a dearer offer is not on the front at any time, and the skip does not change the front.
 * - The layer has the limit of cost of the input, when it has one.
 *
 * @throws RangeError when the count of copies is not a whole number of 1 or more. It also throws when the least memory
 * or the limit of cost is less than 0, or when a chance input is not valid.
 */
export function placementLayer(input: PlacementInput): PlacementBuild {
  const { needs, chances } = input;
  if (!Number.isInteger(input.copies) || input.copies < 1) throw new RangeError("The count of copies is not a whole number of 1 or more.");
  if (!(needs.minMemoryMiB >= 0)) throw new RangeError("The least memory is not a number of 0 or more.");
  if (input.costLimit !== undefined && !(input.costLimit >= 0)) throw new RangeError("The limit of cost is not a number of 0 or more.");
  checkChance("provider", chances.provider);
  checkChance("region", chances.region);
  checkChance("host", chances.host);
  for (const item of chances.overrides ?? []) checkChance(item.id, item);
  const terms = needs.terms ?? DEFAULT_TERMS;
  const skipped: Record<SkipReason, number> = { term: 0, currency: 0, memory: 0, meter: 0, dearer: 0 };
  const best = new Map<string, OfferPick>();
  for (const observation of input.offers) {
    const { offer } = observation;
    if (!terms.includes(offer.term.kind)) {
      skipped.term += 1;
      continue;
    }
    const memory = memoryMiB(observation);
    if (memory === undefined || memory < needs.minMemoryMiB) {
      skipped.memory += 1;
      continue;
    }
    const cost = monthCost(observation);
    if (cost === undefined) {
      skipped.meter += 1;
      continue;
    }
    if (cost.currency !== needs.currency) {
      skipped.currency += 1;
      continue;
    }
    const region = offer.location.region ?? "any";
    const key = `${offer.location.provider}/${region}`;
    const found = best.get(key);
    const pick: OfferPick = { provider: offer.location.provider, region, offer: offer.id, cost: cost.value };
    if (found === undefined) best.set(key, pick);
    else {
      skipped.dearer += 1;
      // The cheaper offer wins. The id of the offer breaks a tie, thus the layer does not hang on the order of the offers.
      if (pick.cost < found.cost || (pick.cost === found.cost && pick.offer < found.offer)) best.set(key, pick);
    }
  }
  const picks = [...best.values()].sort((a, b) => (a.provider === b.provider ? (a.region < b.region ? -1 : 1) : a.provider < b.provider ? -1 : 1));
  const overrides = new Map((chances.overrides ?? []).map((item) => [item.id, item]));
  const shared: Shared[] = [];
  const seen = new Set<string>();
  for (const pick of picks) {
    const provider = providerFragment(pick.provider);
    if (!seen.has(provider)) {
      seen.add(provider);
      shared.push(sharedOf(provider, "provider", overrides.get(provider) ?? chances.provider));
    }
    const region = regionFragment(pick.provider, pick.region);
    shared.push(sharedOf(region, "region", overrides.get(region) ?? chances.region));
  }
  const slots = Array.from({ length: input.copies }, (_, index) => ({
    id: slotId(index),
    ...(index === 0 ? {} : { optional: true }),
    candidates: picks.map((pick) => candidateOf(slotId(index), pick, chances, needs.currency)),
  }));
  const layer: PlacementLayer = {
    schema: PLACEMENT_SCHEMA,
    part: PLACEMENT_PART,
    currency: needs.currency,
    slots,
    shared,
    ...(input.costLimit === undefined ? {} : { limits: { cost: input.costLimit, bound: input.costLimit } }),
  };
  const base: Stack = {
    schema: "stack/1",
    parts: [{ id: PLACEMENT_PART, kind: "function", name: "A message gets out of some copy", needs: [{ any: slots.map((slot) => slot.id) }] }],
  };
  return { layer, base, offers: input.offers.length, skipped };
}

function layerOf<Layer>(stack: Stack, addOn: StackJoiner<Layer>): Layer | undefined {
  const read = readLayer(stack, addOn);
  if (read !== undefined && !read.ok) throw new RangeError(read.errors.join(" "));
  return read?.layer;
}

/**
 * This function gives the joiners and the measures of a plan: the chance from `worksChance` of `stack-risk`, and the
 * bound from `monthTotal` of `stack-spend`. `today` is the date of the add-ons, as `YYYY-MM-DD`.
 */
export function placementMeasures(today: string): Pick<PlanOptions, "joiners" | "chance" | "bound"> {
  const risk = riskAddOn({ today });
  const spend = spendAddOn({ today });
  return {
    joiners: [risk, spend] as PlanOptions["joiners"],
    chance: (stack, part) => {
      const works = worksChance(layerOf(stack, risk) ?? { schema: RISK_SCHEMA, goals: [] }, stack, part);
      return works.kind === "exact" ? { value: works.value, importance: works.importance, assumed: works.assumed } : { value: Number.NaN };
    },
    bound: (stack) => {
      const layer = layerOf(stack, spend);
      return layer === undefined ? { bounded: 0, open: [] } : monthTotal(layer);
    },
  };
}

/** This function gives the count of choices of a layer. Each slot gives its count of candidates, plus one when it is optional. */
export function choiceCount(layer: PlacementLayer): number {
  return layer.slots.reduce((count, slot) => count * (slot.candidates.length + (slot.optional === true ? 1 : 0)), 1);
}

/**
 * This function gives the plan of a placement build. A space of `GRID_LIMIT` choices or less gets a grid of each
 * choice. A larger space gets the genetic search of `stack-placement` with `GRID_LIMIT` evaluations.
 */
export function planCopies(build: PlacementBuild, today: string): PlacementPlan {
  const evaluations = Math.max(2000, Math.min(choiceCount(build.layer), GRID_LIMIT));
  return planPlacement(build.layer, build.base, { ...placementMeasures(today), evaluations });
}

/**
 * This function gives the rows of a front with one row for each set of candidates. Two copies are alike, thus a swap of
 * the candidates of two slots gives the same placement. The first row of each set stays.
 */
export function distinctRows(front: readonly PlacementRow[]): readonly PlacementRow[] {
  const seen = new Set<string>();
  const rows: PlacementRow[] = [];
  for (const row of front) {
    const key = Object.values(row.choice)
      .filter((value): value is string => value !== null)
      .sort()
      .join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return rows;
}

/** One level of a front: the rows with one cost and one chance. */
export interface FrontLevel {
  /** The expected cost of a month of each row of the level. */
  readonly cost: number;
  /** The chance that some copy works, for each row of the level. */
  readonly chance: number;
  /** The rows of the level. Each row is a different choice with equal measures. */
  readonly rows: readonly PlacementRow[];
}

/**
 * This function gives the levels of a front, from the lowest cost. Rows tie when their costs and their chances are equal
 * to the steps of `OBJECTIVE_STEPS` of `stack-placement`. Many regions of a provider can have one price and one chance.
 * Then each of them is a row of one level.
 */
export function frontLevels(front: readonly PlacementRow[]): readonly FrontLevel[] {
  const levels = new Map<string, { cost: number; chance: number; rows: PlacementRow[] }>();
  for (const row of front) {
    const key = `${String(Math.round(row.cost / OBJECTIVE_STEPS.cost))}|${String(Math.round(row.chance / OBJECTIVE_STEPS.chance))}`;
    const level = levels.get(key);
    if (level === undefined) levels.set(key, { cost: row.cost, chance: row.chance, rows: [row] });
    else level.rows.push(row);
  }
  return [...levels.values()].sort((a, b) => a.cost - b.cost || b.chance - a.chance);
}

/**
 * This function gives the chance input of one shared fragment: the override of the fragment, or the input of its kind.
 * A fragment `provider:...` gets the provider input, and each other fragment gets the region input.
 */
export function fragmentInput(chances: PlacementChances, fragment: string): ChanceInput {
  const override = (chances.overrides ?? []).find((item) => item.id === fragment);
  if (override !== undefined) return override;
  return fragment.startsWith("provider:") ? chances.provider : chances.region;
}

function usesOf(layer: PlacementLayer, slot: string, key: string): readonly string[] {
  return layer.slots.find((each) => each.id === slot)?.candidates.find((candidate) => candidate.key === key)?.uses ?? [];
}

/**
 * This function gives the shared fragments of a row whose chance input is of the kind `assumed`, sorted. The host input
 * is not a fragment: the caller tells its kind one time. A row with no such fragment uses measured inputs only.
 *
 * `worksChance` of `stack-risk` marks only the parts with no chance in a layer. Each fragment of a placement layer
 * has a chance, thus that mark does not tell the kind of an input. This function tells it.
 */
export function assumedInputs(layer: PlacementLayer, chances: PlacementChances, row: PlacementRow): readonly string[] {
  const found = new Set<string>();
  for (const [slot, key] of Object.entries(row.choice)) {
    if (key === null) continue;
    for (const fragment of usesOf(layer, slot, key)) if (fragmentInput(chances, fragment).kind === "assumed") found.add(fragment);
  }
  return [...found].sort();
}

/**
 * This function gives the build with the candidates whose shared fragments all have a measured input. It keeps the
 * shared fragments of these candidates only. It gives `undefined` when no candidate stays.
 *
 * The front of this build is not a filter of the full front. A row with an assumed input can beat a row of measured
 * inputs. Then that row of measured inputs is not on the full front, but it can be on this one.
 */
export function measuredBuild(build: PlacementBuild, chances: PlacementChances): PlacementBuild | undefined {
  const measured = (candidate: Candidate): boolean => (candidate.uses ?? []).every((fragment) => fragmentInput(chances, fragment).kind === "measured");
  const slots = build.layer.slots.map((slot) => ({ ...slot, candidates: slot.candidates.filter(measured) }));
  if (slots.every((slot) => slot.candidates.length === 0)) return undefined;
  const used = new Set(slots.flatMap((slot) => slot.candidates.flatMap((candidate) => candidate.uses ?? [])));
  const shared = (build.layer.shared ?? []).filter((each) => used.has(each.id));
  return { ...build, layer: { ...build.layer, slots, shared } };
}

/**
 * This function gives the limit of cost of a month of the copies from the private configuration. The limit is the field
 * `monthlyUsd` of the spend entry of `provider`. It gives `undefined` when the configuration has no such entry, or when the entry
 * has no valid value.
 */
export function spendLimitOf(config: unknown, provider: string): number | undefined {
  const entries = arrayOf(config, "spend", (value) => value) ?? [];
  const entry = entries.find((item) => textOf(item, "provider") === provider);
  const limit = numberOf(entry, "monthlyUsd");
  return limit !== undefined && Number.isFinite(limit) && limit > 0 ? limit : undefined;
}
