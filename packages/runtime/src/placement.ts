/**
 * The placement of the copies of the alert system as a query (AL-53). The query reads the live offers of cloud plans
 * from `@mark1russell7/market-sources`. It gives the front of the expected cost of a month against the chance that
 * some copy works. `@mark1russell7/stack-placement` gives the layer `placement/1`, the search and the front.
 *
 * - Each copy is a slot. The first slot needs a candidate. Each other slot can stay empty.
 * - A live copy is a fixed slot with one candidate. With a fixed slot, each new slot can stay empty. Thus the
 *   front tells the gain of each next copy beside the live copies, and the gain of no new copy.
 * - Each candidate is an offer: a provider, a region and a plan, with its cost of a month.
 * - Each provider and each region is a shared fragment. Thus two copies on one provider share one cause of failure.
 * - Nobody picks a provider or a price. Each offer that meets the needs is a candidate.
 * - A base stack gives the needs that all copies share, for example the push services and the feeds. These needs limit
 *   the gain of each new copy, thus the front tells the true gain.
 * - A joint measure of the live copies gives their common cause of failure (AL-147). Each copy needs the common cause.
 *   Thus a new copy does not get the gain of an independent copy.
 *
 * The chances are inputs. Each input tells if it is measured or assumed, and its source. This module holds no chance
 * and no limit of cost. The caller reads the limit of cost from the private configuration at run time.
 */

import { meteredCost, type MeteredObservation, type PriceTerm } from "@mark1russell7/market";
import { arrayOf, isRecord, numberOf, textOf } from "@mark1russell7/optional/read";
import { OBJECTIVE_STEPS, PLACEMENT_SCHEMA, planPlacement, type Candidate, type PlacementLayer, type PlacementPlan, type PlacementRow, type PlanOptions, type Shared } from "@mark1russell7/stack-placement";
import { RISK_SCHEMA, sharedCauseFit, worksChance, type RiskLayer } from "@mark1russell7/stack-risk";
import { riskAddOn } from "@mark1russell7/stack-risk/add-on";
import { monthTotal, type SpendLayer } from "@mark1russell7/stack-spend";
import { spendAddOn } from "@mark1russell7/stack-spend/add-on";
import { readLayer, type Need, type Part, type Stack, type StackJoiner } from "@mark1russell7/system-stack";
import { parseStack } from "@mark1russell7/system-stack/schema";

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
 * The chance inputs of a placement. Each provider, each region, each site and each host gets the input of its kind. An
 * override replaces the input of one fragment.
 */
export interface PlacementChances {
  /** The chance that a provider works: its control plane, its network and its account. */
  readonly provider: ChanceInput;
  /** The chance that a region of a provider works: its power, its cooling and its links. */
  readonly region: ChanceInput;
  /** The chance that one host of a copy works, when its provider and its region work. */
  readonly host: ChanceInput;
  /** The chance that a site of a fixed copy works: its power and its internet. A fixed copy on a site needs it. */
  readonly site?: ChanceInput | undefined;
  /** The inputs of single providers or regions. */
  readonly overrides?: readonly ChanceOverride[] | undefined;
  /** The joint measure of the live copies (AL-147). With it, each copy needs the common cause of the live copies. */
  readonly joint?: JointMeasure | undefined;
}

/**
 * The measure of the live copies together, for example from the heartbeat flips of each copy and of the loud check
 * (AL-148). Two copies fail together more often than two independent copies: a release, a feed or a bug of a start
 * stops each copy. `sharedCauseFit` of `stack-risk` divides the measure into a common cause and a part of each copy.
 */
export interface JointMeasure {
  /** The chance that each live copy works, in the order of the fixed copies of the input. */
  readonly works: readonly ChanceInput[];
  /** The chance that some live copy works. */
  readonly anyWorks: ChanceInput;
}

// One chance input from a JSON value: works from 0 to 1, kind and source. It gives undefined for a value that is not one.
function chanceInputOf(value: unknown): ChanceInput | undefined {
  const works = numberOf(value, "works");
  const kind = textOf(value, "kind");
  const source = textOf(value, "source");
  if (works === undefined || !(works >= 0 && works <= 1) || (kind !== "measured" && kind !== "assumed") || source === undefined) return undefined;
  return { works, kind, source };
}

/**
 * This function reads a joint measure from a JSON value: `{ works, anyWorks }`. `works` is a list with one chance input
 * for each fixed copy, and `anyWorks` is one chance input. Each input has `works`, `kind` and `source`. It gives the
 * measure, or a problem as a text.
 */
export function readJoint(value: unknown): JointMeasure | string {
  const list: unknown = isRecord(value) ? value["works"] : undefined;
  if (!Array.isArray(list) || list.length === 0) return "The joint measure has no list works.";
  const works: ChanceInput[] = [];
  for (const item of list as readonly unknown[]) {
    const input = chanceInputOf(item);
    if (input === undefined) return "Each input of works needs works from 0 to 1, kind (measured or assumed) and source.";
    works.push(input);
  }
  const anyWorks = chanceInputOf(isRecord(value) ? value["anyWorks"] : undefined);
  if (anyWorks === undefined) return "The input anyWorks needs works from 0 to 1, kind (measured or assumed) and source.";
  return { works, anyWorks };
}

/** The id of the shared fragment of the common cause of the copies. */
export const COMMON_FRAGMENT = "common:copies";

/** The fit of a joint measure: the input of the common cause, and the chance of the own part of each live copy. */
export interface JointFit {
  readonly common: ChanceInput;
  /** The chance that the own part of each live copy works, in the order of the fixed copies. */
  readonly own: readonly number[];
}

/**
 * This function gives the fit of the joint measure of the chances, or `undefined` with no joint measure. The fit is
 * measured when each input of the measure is measured.
 */
export function jointFit(chances: PlacementChances): JointFit | undefined {
  const { joint } = chances;
  if (joint === undefined) return undefined;
  const fit = sharedCauseFit({ works: joint.works.map((item) => item.works), anyWorks: joint.anyWorks.works });
  const inputs = [...joint.works, joint.anyWorks];
  const kind: ChanceKind = inputs.every((item) => item.kind === "measured") ? "measured" : "assumed";
  return { common: { works: fit.shared, kind, source: `the common cause of the live copies, from ${joint.anyWorks.source}` }, own: fit.own };
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

/**
 * A live copy. It is a fixed slot with one candidate. A copy at a provider uses the provider and region fragments
 * of an offer. A copy at a site, for example a home computer, uses the one fragment of its site.
 */
export type FixedCopy =
  | { readonly kind: "cloud"; readonly provider: string; readonly region: string }
  | { readonly kind: "site"; readonly site: string };

/** One chance input of one part of a base stack. */
export interface PartChance extends ChanceInput {
  /** The id of the part. */
  readonly part: string;
}

/**
 * The function of the system and the needs that all copies share. Each copy of the alert system needs the same push
 * services, call services and feeds. The front of a placement with a base tells the gain of each copy past these needs.
 */
export interface PlacementBase {
  /** The stack of the function and of its shared needs. A layer `risk/1` of the stack keeps its goals. */
  readonly stack: Stack;
  /** The id of the function to keep in work. Its needs get one more need: some slot works. */
  readonly part: string;
  /** The ids of the parts of the stack that are copies. The placement replaces each need of the function that names only these parts. */
  readonly copies?: readonly string[] | undefined;
  /** The chance input of each part of the stack. A part with needs and no input works when its needs hold. */
  readonly chances?: readonly PartChance[] | undefined;
}

/**
 * This function reads a base input from a JSON value: `{ stack, part, copies?, chances? }`. Each chance has `part`,
 * `works`, `kind` (`measured` or `assumed`) and `source`. It gives the base, or a problem as a text.
 */
export function readBase(value: unknown): PlacementBase | string {
  if (!isRecord(value)) return "The base is not an object.";
  const stack = parseStack(value["stack"]);
  if (!stack.ok) return `The stack of the base has faults: ${stack.errors.join(" ")}`;
  const part = textOf(value, "part");
  if (part === undefined) return "The base has no text part.";
  const copyList: unknown = value["copies"] ?? [];
  if (!Array.isArray(copyList) || !copyList.every((each) => typeof each === "string")) return "The copies of the base are not a list of texts.";
  const chanceList: unknown = value["chances"] ?? [];
  if (!Array.isArray(chanceList)) return "The chances of the base are not a list.";
  const chances: PartChance[] = [];
  for (const item of chanceList as readonly unknown[]) {
    const id = textOf(item, "part");
    const works = numberOf(item, "works");
    const kind = textOf(item, "kind");
    const source = textOf(item, "source");
    if (id === undefined || works === undefined || (kind !== "measured" && kind !== "assumed") || source === undefined) {
      return "Each chance of the base needs part, works, kind (measured or assumed) and source.";
    }
    chances.push({ part: id, works, kind, source });
  }
  return { stack: stack.stack, part, copies: copyList as readonly string[], chances };
}

/** The inputs of a placement layer. */
export interface PlacementInput {
  /** The live offers, for example from the plan client of `@mark1russell7/market-sources`. */
  readonly offers: readonly MeteredObservation[];
  /** The needs of a copy. */
  readonly needs: CopyNeeds;
  /** The chance inputs. */
  readonly chances: PlacementChances;
  /** The count of new copies, 1 or more. Each copy is one slot. */
  readonly copies: number;
  /**
   * The live copies. Each is a fixed slot before the new slots, with a cost of 0: the front gives the cost of the
   * new copies only. A fixed copy has no offer, thus the plan lists of the providers do not limit it.
   */
  readonly fixed?: readonly FixedCopy[] | undefined;
  /** The largest expected cost of a month, from the private configuration. Without it, the layer has no limit of cost. */
  readonly costLimit?: number | undefined;
  /** The function and the needs that all copies share. Without it, the function needs only some slot. */
  readonly base?: PlacementBase | undefined;
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
  /** The ids of the fixed slots: the live copies. */
  readonly fixed: readonly string[];
}

/** This function gives the id of the slot of the copy `index`, from 0: `copy-1`, `copy-2` and so on. */
export function slotId(index: number): string {
  return `copy-${String(index + 1)}`;
}

/** This function gives the id of the fixed slot of the live copy `index`, from 0: `live-1`, `live-2` and so on. */
export function fixedSlotId(index: number): string {
  return `live-${String(index + 1)}`;
}

/** This function gives the id of the shared fragment of a site of a fixed copy. */
export function siteFragment(site: string): string {
  return `site:${site}`;
}

/** This function gives the key of a fixed copy: `provider/region`, or `site/<site>`. */
export function fixedKey(copy: FixedCopy): string {
  return copy.kind === "cloud" ? `${copy.provider}/${copy.region}` : `site/${copy.site}`;
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
  const uses = [provider, region, ...(chances.joint === undefined ? [] : [COMMON_FRAGMENT])];
  const spend: SpendLayer = { schema: "spend/1", currency, kinds: [], proofDays: 30, services: [{ part: slot, billing: "fixed", price: pick.cost }] };
  return {
    key: `${pick.provider}/${pick.region}`,
    cost: pick.cost,
    uses,
    source: pick.offer,
    stack: { schema: "stack/1", parts: [{ id: slot, kind: "host", needs: [...uses] }], layers: { "risk/1": riskOf(slot, chances.host), "spend/1": spend } },
  };
}

function sharedOf(id: string, kind: string, input: ChanceInput): Shared {
  return { id, stack: { schema: "stack/1", parts: [{ id, kind }], layers: { "risk/1": riskOf(id, input) } } };
}

function fixedUses(copy: FixedCopy): readonly string[] {
  return copy.kind === "cloud" ? [providerFragment(copy.provider), regionFragment(copy.provider, copy.region)] : [siteFragment(copy.site)];
}

/**
 * The input of the host of a fixed copy. With a joint measure, the measure of the copy holds each of its causes. Thus the
 * host gets the rest of its own part: the own part over the chance of its fragments, at most 1.
 */
function fixedHost(copy: FixedCopy, index: number, chances: PlacementChances, fit: JointFit | undefined): ChanceInput {
  const measure = chances.joint?.works[index];
  const own = fit?.own[index];
  if (measure === undefined || own === undefined) return chances.host;
  const fragments = fixedUses(copy).reduce((product, fragment) => product * fragmentInput(chances, fragment).works, 1);
  return { works: fragments > 0 ? Math.min(1, own / fragments) : 1, kind: measure.kind, source: `the own part of ${measure.source}` };
}

function fixedCandidate(slot: string, copy: FixedCopy, host: ChanceInput, common: boolean, currency: string): Candidate {
  const uses = [...fixedUses(copy), ...(common ? [COMMON_FRAGMENT] : [])];
  const spend: SpendLayer = { schema: "spend/1", currency, kinds: [], proofDays: 30, services: [{ part: slot, billing: "fixed", price: 0 }] };
  return {
    key: fixedKey(copy),
    cost: 0,
    uses,
    source: "a live copy",
    stack: { schema: "stack/1", parts: [{ id: slot, kind: "host", needs: [...uses] }], layers: { "risk/1": riskOf(slot, host), "spend/1": spend } },
  };
}

/**
 * This function gives the placement layer of the copies from the live offers.
 *
 * - An offer is a candidate when its term fits and its currency is the currency of the needs. It also needs enough
 *   memory and a compute meter.
 * - For each provider and region, only the cheapest such offer is a candidate. Each offer of one provider and region
 *   has the same chances. Thus a dearer offer is not on the front at any time, and the skip does not change the front.
 * - The layer has the limit of cost of the input, when it has one.
 * - Each fixed copy is a slot before the new slots. With a fixed copy, each new slot is optional.
 *
 * @throws RangeError when the count of copies is not a whole number of 1 or more. It also throws when the least memory
 * or the limit of cost is less than 0, or when a chance input is not valid. It also throws when two fixed copies have
 * one key, or when a fixed copy at a site has no site input and no override. It also throws when a joint measure does not
 * have one input for each fixed copy.
 */
export function placementLayer(input: PlacementInput): PlacementBuild {
  const { needs, chances } = input;
  if (!Number.isInteger(input.copies) || input.copies < 1) throw new RangeError("The count of copies is not a whole number of 1 or more.");
  if (!(needs.minMemoryMiB >= 0)) throw new RangeError("The least memory is not a number of 0 or more.");
  if (input.costLimit !== undefined && !(input.costLimit >= 0)) throw new RangeError("The limit of cost is not a number of 0 or more.");
  checkChance("provider", chances.provider);
  checkChance("region", chances.region);
  checkChance("host", chances.host);
  if (chances.site !== undefined) checkChance("site", chances.site);
  for (const item of chances.overrides ?? []) checkChance(item.id, item);
  const fixed = input.fixed ?? [];
  if (chances.joint !== undefined) {
    if (chances.joint.works.length !== fixed.length || fixed.length === 0) throw new RangeError("The joint measure does not have one input for each fixed copy.");
    chances.joint.works.forEach((item, index) => checkChance(`joint ${String(index + 1)}`, item));
    checkChance("joint any", chances.joint.anyWorks);
  }
  const keys = new Set<string>();
  for (const copy of fixed) {
    const key = fixedKey(copy);
    if (keys.has(key)) throw new RangeError(`Two fixed copies have the key ${key}.`);
    keys.add(key);
    const fragment = copy.kind === "site" ? siteFragment(copy.site) : undefined;
    if (fragment !== undefined && chances.site === undefined && !(chances.overrides ?? []).some((item) => item.id === fragment)) {
      throw new RangeError(`The fixed copy ${key} has no site input.`);
    }
  }
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
  const shared: Shared[] = [];
  const seen = new Set<string>();
  const baseIds = new Set((input.base?.stack.parts ?? []).map((part) => part.id));
  const taken = (id: string): void => {
    if (baseIds.has(id)) throw new RangeError(`The part ${id} of the base stack is also a slot or a shared fragment.`);
  };
  const add = (id: string, kind: string): void => {
    if (seen.has(id)) return;
    taken(id);
    seen.add(id);
    shared.push(sharedOf(id, kind, fragmentInput(chances, id)));
  };
  for (const copy of fixed) {
    if (copy.kind === "site") add(siteFragment(copy.site), "site");
    else {
      add(providerFragment(copy.provider), "provider");
      add(regionFragment(copy.provider, copy.region), "region");
    }
  }
  for (const pick of picks) {
    add(providerFragment(pick.provider), "provider");
    add(regionFragment(pick.provider, pick.region), "region");
  }
  const fit = jointFit(chances);
  if (fit !== undefined) add(COMMON_FRAGMENT, "common");
  const fixedSlots = fixed.map((copy, index) => ({
    id: fixedSlotId(index),
    candidates: [fixedCandidate(fixedSlotId(index), copy, fixedHost(copy, index, chances, fit), fit !== undefined, needs.currency)],
  }));
  const newSlots = Array.from({ length: input.copies }, (_, index) => ({
    id: slotId(index),
    ...(index === 0 && fixed.length === 0 ? {} : { optional: true }),
    candidates: picks.map((pick) => candidateOf(slotId(index), pick, chances, needs.currency)),
  }));
  const slots = [...fixedSlots, ...newSlots];
  for (const slot of slots) taken(slot.id);
  const some: Need = { any: slots.map((slot) => slot.id) };
  const base = input.base === undefined ? sendStack(some) : baseStack(input.base, some);
  const layer: PlacementLayer = {
    schema: PLACEMENT_SCHEMA,
    part: input.base?.part ?? PLACEMENT_PART,
    currency: needs.currency,
    slots,
    shared,
    ...(input.costLimit === undefined ? {} : { limits: { cost: input.costLimit, bound: input.costLimit } }),
  };
  return { layer, base, offers: input.offers.length, skipped, fixed: fixedSlots.map((slot) => slot.id) };
}

/** The base stack with no base input: the function `send` works when some slot works. */
function sendStack(some: Need): Stack {
  return { schema: "stack/1", parts: [{ id: PLACEMENT_PART, kind: "function", name: "A message gets out of some copy", needs: [some] }] };
}

/** This function tells if a need names only the parts of `ids`. */
function namesOnly(need: Need, ids: ReadonlySet<string>): boolean {
  if (typeof need === "string") return ids.has(need);
  const list = "all" in need ? need.all : need.any;
  return list.length > 0 && list.every((each) => namesOnly(each, ids));
}

/**
 * This function gives the base stack of a base input. The function loses each need that names only copies, and gets
 * the need of some slot. The layer `risk/1` keeps its goals and its chances, and gets the chance input of each part.
 */
function baseStack(base: PlacementBase, some: Need): Stack {
  const found = base.stack.parts.find((part) => part.id === base.part);
  if (found === undefined) throw new RangeError(`The base stack has no part ${base.part}.`);
  const ids = new Set(base.stack.parts.map((part) => part.id));
  const copies = new Set(base.copies ?? []);
  for (const id of copies) if (!ids.has(id)) throw new RangeError(`The base stack has no copy ${id}.`);
  const chances = base.chances ?? [];
  const given = new Set<string>();
  for (const item of chances) {
    if (!ids.has(item.part)) throw new RangeError(`The base stack has no part ${item.part} for a chance input.`);
    if (given.has(item.part)) throw new RangeError(`The part ${item.part} has two chance inputs.`);
    given.add(item.part);
    checkChance(item.part, item);
  }
  const needs = (found.needs ?? []).filter((need) => !namesOnly(need, copies));
  const parts: Part[] = base.stack.parts.map((part) => (part.id === base.part ? { ...part, needs: [...needs, some] } : part));
  // The gate of the plan reads the layer with the date of the plan. This step only adds the chance inputs to it.
  const prior = base.stack.layers?.["risk/1"] as RiskLayer | undefined;
  for (const item of prior?.chances ?? []) {
    if (given.has(item.part)) throw new RangeError(`The part ${item.part} has two chance inputs.`);
  }
  const added = chances.map((item) => ({ part: item.part, works: item.works, source: sourceOf(item) }));
  const layer: RiskLayer = { schema: RISK_SCHEMA, goals: prior?.goals ?? [], ...prior, chances: [...(prior?.chances ?? []), ...added] };
  return { ...base.stack, parts, layers: { ...(base.stack.layers ?? {}), "risk/1": layer } };
}

function namesOf(need: Need): readonly string[] {
  if (typeof need === "string") return [need];
  return ("all" in need ? need.all : need.any).flatMap(namesOf);
}

/**
 * This function gives the parts that the function of a base input needs, past its copies, whose chance input is
 * assumed. It also gives such leaf parts with no input. Both lists are sorted. A leaf part with no input works at each
 * time, thus the front is too high when one exists.
 */
export function baseAssumed(base: PlacementBase): { readonly assumed: readonly string[]; readonly missing: readonly string[] } {
  const chances = new Map((base.chances ?? []).map((item) => [item.part, item]));
  const byId = new Map(base.stack.parts.map((part) => [part.id, part]));
  const copies = new Set(base.copies ?? []);
  const reached = new Set<string>();
  const visit = (id: string): void => {
    if (reached.has(id) || copies.has(id)) return;
    reached.add(id);
    const needs = byId.get(id)?.needs ?? [];
    const kept = id === base.part ? needs.filter((need) => !namesOnly(need, copies)) : needs;
    for (const name of kept.flatMap(namesOf)) visit(name);
  };
  visit(base.part);
  const parts = [...reached].filter((id) => id !== base.part).sort();
  return {
    assumed: parts.filter((id) => chances.get(id)?.kind === "assumed"),
    missing: parts.filter((id) => (byId.get(id)?.needs ?? []).length === 0 && !chances.has(id)),
  };
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
 * A fragment `provider:...` gets the provider input, and a fragment `site:...` gets the site input. Each other
 * fragment gets the region input.
 *
 * @throws RangeError when a site fragment has no override and the chances have no site input.
 */
export function fragmentInput(chances: PlacementChances, fragment: string): ChanceInput {
  const override = (chances.overrides ?? []).find((item) => item.id === fragment);
  if (override !== undefined) return override;
  if (fragment === COMMON_FRAGMENT) {
    const fit = jointFit(chances);
    if (fit === undefined) throw new RangeError(`The fragment ${fragment} has no joint measure.`);
    return fit.common;
  }
  if (fragment.startsWith("site:")) {
    if (chances.site === undefined) throw new RangeError(`The site fragment ${fragment} has no input.`);
    return chances.site;
  }
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
 *
 * A fixed slot stays as it is: a live copy is a fact, not a choice. Thus a row can name the assumed fragments of a
 * fixed copy. It gives `undefined` when no new slot keeps a candidate.
 */
export function measuredBuild(build: PlacementBuild, chances: PlacementChances): PlacementBuild | undefined {
  const measured = (candidate: Candidate): boolean => (candidate.uses ?? []).every((fragment) => fragmentInput(chances, fragment).kind === "measured");
  const fixed = new Set(build.fixed);
  const slots = build.layer.slots.map((slot) => (fixed.has(slot.id) ? slot : { ...slot, candidates: slot.candidates.filter(measured) }));
  if (slots.every((slot) => fixed.has(slot.id) || slot.candidates.length === 0)) return undefined;
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
