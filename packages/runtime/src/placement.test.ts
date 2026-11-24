import type { MeteredObservation } from "@mark1russell7/market";
import { canonicalUnit } from "@mark1russell7/quantity";
import { checkPlacement } from "@mark1russell7/stack-placement";
import { describe, expect, it } from "vitest";
import {
  assumedInputs,
  choiceCount,
  distinctRows,
  fixedSlotId,
  fragmentInput,
  frontLevels,
  measuredBuild,
  memoryMiB,
  monthCost,
  placementLayer,
  planCopies,
  providerFragment,
  regionFragment,
  siteFragment,
  slotId,
  spendLimitOf,
  type FixedCopy,
  type PlacementChances,
  type PlacementInput,
} from "./placement.ts";

// Each provider, region, price and chance of this file is made up. The names are neutral.

const TODAY = "2026-11-23";

interface OfferSpec {
  readonly provider: string;
  readonly region: string;
  readonly plan: string;
  readonly hourly: number;
  readonly memory?: string;
  readonly term?: "on-demand" | "spot";
  readonly currency?: string;
}

function offer(spec: OfferSpec): MeteredObservation {
  const term = spec.term ?? "on-demand";
  const id = `${spec.provider}:${spec.plan}/${spec.region}/${term}`;
  const currency = spec.currency ?? "USD";
  return {
    offer: {
      id,
      source: spec.provider,
      sourceId: `${spec.plan}/${spec.region}/${term}`,
      title: `${spec.provider} ${spec.plan}`,
      location: { provider: spec.provider, region: spec.region },
      term: { kind: term },
      specs: [{ name: "memory", value: spec.memory ?? "2048 MiB" }],
    },
    reading: {
      offerId: id,
      at: "2026-11-23T00:00:00Z",
      period: { value: 1, unit: "mo" },
      meters: [{ name: "compute", tiers: [{ from: { value: 0, unit: "h" }, unitPrice: { value: spec.hourly, unit: canonicalUnit(`${currency}/h`) } }] }],
    },
  };
}

const CHANCES: PlacementChances = {
  provider: { works: 0.999, kind: "assumed", source: "a test input" },
  region: { works: 0.998, kind: "assumed", source: "a test input" },
  host: { works: 0.99, kind: "assumed", source: "a test input" },
};

function input(offers: readonly MeteredObservation[], extra: Partial<PlacementInput> = {}): PlacementInput {
  return { offers, needs: { minMemoryMiB: 1024, currency: "USD" }, chances: CHANCES, copies: 2, ...extra };
}

describe("the offers of a placement", () => {
  it("reads the memory of an offer in MiB", () => {
    expect(memoryMiB(offer({ provider: "provider-a", region: "europe-west1", plan: "p1", hourly: 0.01, memory: "2 GiB" }))).toBe(2048);
    expect(memoryMiB(offer({ provider: "provider-a", region: "europe-west1", plan: "p1", hourly: 0.01, memory: "a lot" }))).toBeUndefined();
  });

  it("gives the cost of a month of 730 hours", () => {
    const cost = monthCost(offer({ provider: "provider-a", region: "europe-west1", plan: "p1", hourly: 0.01 }));
    expect(cost?.currency).toBe("USD");
    expect(cost?.value).toBeCloseTo(7.3, 9);
  });

  it("keeps the cheapest offer of each provider and region, and counts each skip", () => {
    const build = placementLayer(
      input([
        offer({ provider: "provider-a", region: "europe-west1", plan: "small", hourly: 0.01 }),
        offer({ provider: "provider-a", region: "europe-west1", plan: "large", hourly: 0.03 }),
        offer({ provider: "provider-a", region: "europe-west1", plan: "tiny", hourly: 0.001, memory: "512 MiB" }),
        offer({ provider: "provider-a", region: "europe-west1", plan: "spot", hourly: 0.002, term: "spot" }),
        offer({ provider: "provider-a", region: "europe-west1", plan: "euro", hourly: 0.002, currency: "EUR" }),
        offer({ provider: "provider-b", region: "europe-west1", plan: "small", hourly: 0.02 }),
      ]),
    );
    expect(build.skipped).toEqual({ term: 1, currency: 1, memory: 1, meter: 0, dearer: 1 });
    const [first, second] = build.layer.slots;
    expect(first?.candidates.map((candidate) => [candidate.key, candidate.source])).toEqual([
      ["provider-a/europe-west1", "provider-a:small/europe-west1/on-demand"],
      ["provider-b/europe-west1", "provider-b:small/europe-west1/on-demand"],
    ]);
    expect(first?.optional).toBeUndefined();
    expect(second?.optional).toBe(true);
    expect(build.layer.shared?.map((item) => item.id)).toEqual([
      providerFragment("provider-a"),
      regionFragment("provider-a", "europe-west1"),
      providerFragment("provider-b"),
      regionFragment("provider-b", "europe-west1"),
    ]);
    expect(build.layer.limits).toBeUndefined();
    expect(choiceCount(build.layer)).toBe(6);
    expect(checkPlacement(build.layer, build.base).filter((fault) => fault.level === "error")).toEqual([]);
  });

  it("refuses a chance input with no source or out of range", () => {
    const bad = { ...CHANCES, host: { works: 1.2, kind: "assumed" as const, source: "a test input" } };
    expect(() => placementLayer(input([], { chances: bad }))).toThrow(RangeError);
    const blank = { ...CHANCES, region: { works: 0.9, kind: "assumed" as const, source: " " } };
    expect(() => placementLayer(input([], { chances: blank }))).toThrow(RangeError);
  });
});

describe("the front of a placement", () => {
  // Three offers of one cost: two regions of provider-a and one region of provider-b.
  const offers = [
    offer({ provider: "provider-a", region: "europe-west1", plan: "small", hourly: 0.01 }),
    offer({ provider: "provider-a", region: "europe-west2", plan: "small", hourly: 0.01 }),
    offer({ provider: "provider-b", region: "europe-west1", plan: "small", hourly: 0.01 }),
  ];

  it("gives two copies on two providers a larger chance than two copies on one provider at the same cost", () => {
    const build = placementLayer(input(offers));
    const plan = planCopies(build, TODAY);
    const rows = distinctRows(plan.front);
    const pair = (row: (typeof rows)[number]): string =>
      Object.values(row.choice)
        .filter((value) => value !== null)
        .map((value) => value?.split("/")[0])
        .sort()
        .join("+");
    const two = rows.filter((row) => Object.values(row.choice).every((value) => value !== null));
    expect(two.length).toBeGreaterThan(0);
    // Each front row with two copies uses two providers. Two copies on provider-a cost the same and give less.
    expect(two.every((row) => pair(row) === "provider-a+provider-b")).toBe(true);
    const one = rows.find((row) => Object.values(row.choice).some((value) => value === null));
    expect(one).toBeDefined();
    expect(two[0]?.chance).toBeGreaterThan(one?.chance ?? 1);
    expect(two[0]?.cost).toBeCloseTo(14.6, 9);
  });

  it("keeps the shared provider in the chance: one provider gives less than two", () => {
    const sameProvider = planCopies(placementLayer(input(offers.slice(0, 2))), TODAY).front.find((row) => Object.values(row.choice).every((value) => value !== null));
    const twoProviders = planCopies(placementLayer(input([offers[0], offers[2]].filter((item) => item !== undefined))), TODAY).front.find((row) =>
      Object.values(row.choice).every((value) => value !== null),
    );
    expect(sameProvider?.cost).toBeCloseTo(twoProviders?.cost ?? 0, 9);
    expect(twoProviders?.chance).toBeGreaterThan(sameProvider?.chance ?? 1);
  });

  it("puts the ties of a front into one level", () => {
    // Two regions of provider-a have one price and one chance. Thus one copy in each of them ties.
    const levels = frontLevels(distinctRows(planCopies(placementLayer(input(offers)), TODAY).front));
    expect(levels.length).toBe(2);
    expect(levels[0]?.rows.length).toBe(3);
    expect(levels[1]?.rows.length).toBe(2);
    expect((levels[0]?.cost ?? 0) < (levels[1]?.cost ?? 0)).toBe(true);
    expect((levels[0]?.chance ?? 1) < (levels[1]?.chance ?? 0)).toBe(true);
  });

  it("drops each choice above the limit of cost", () => {
    const plan = planCopies(placementLayer(input(offers, { costLimit: 10 })), TODAY);
    expect(plan.front.length).toBeGreaterThan(0);
    expect(plan.front.every((row) => row.cost <= 10)).toBe(true);
    expect(plan.breaks.cost ?? 0).toBeGreaterThan(0);
  });
});

describe("the kinds of the inputs of a front", () => {
  // provider-b has a measured history for its provider and its region. provider-a has none.
  const offers = [
    offer({ provider: "provider-a", region: "europe-west1", plan: "small", hourly: 0.005 }),
    offer({ provider: "provider-b", region: "europe-west1", plan: "small", hourly: 0.01 }),
  ];
  const measured = { kind: "measured" as const, source: "a made-up history" };
  const chances: PlacementChances = {
    ...CHANCES,
    overrides: [
      { id: providerFragment("provider-b"), works: 0.9995, ...measured },
      { id: regionFragment("provider-b", "europe-west1"), works: 0.9993, ...measured },
    ],
  };

  it("gives the override of a fragment, else the input of its kind", () => {
    expect(fragmentInput(chances, providerFragment("provider-b")).kind).toBe("measured");
    expect(fragmentInput(chances, providerFragment("provider-a"))).toBe(CHANCES.provider);
    expect(fragmentInput(chances, regionFragment("provider-a", "europe-west1"))).toBe(CHANCES.region);
  });

  it("names the assumed fragments of each row", () => {
    const build = placementLayer(input(offers, { chances }));
    const rows = distinctRows(planCopies(build, TODAY).front);
    const keys = (row: (typeof rows)[number]): string => Object.values(row.choice).filter((value) => value !== null).sort().join("+");
    const onlyA = rows.find((row) => keys(row) === "provider-a/europe-west1");
    const both = rows.find((row) => keys(row) === "provider-a/europe-west1+provider-b/europe-west1");
    expect(onlyA).toBeDefined();
    expect(both).toBeDefined();
    if (onlyA === undefined || both === undefined) return;
    expect(assumedInputs(build.layer, chances, onlyA)).toEqual([providerFragment("provider-a"), regionFragment("provider-a", "europe-west1")]);
    expect(assumedInputs(build.layer, chances, both)).toEqual([providerFragment("provider-a"), regionFragment("provider-a", "europe-west1")]);
    // The mark of stack-risk is empty for each row: each fragment has a chance. Thus it does not tell the kind.
    expect(both.assumed ?? []).toEqual([]);
  });

  it("keeps only the candidates of measured inputs, with their shared fragments", () => {
    const build = placementLayer(input(offers, { chances }));
    const only = measuredBuild(build, chances);
    expect(only).toBeDefined();
    if (only === undefined) return;
    expect(only.layer.slots.every((slot) => slot.candidates.map((candidate) => candidate.key).join() === "provider-b/europe-west1")).toBe(true);
    expect((only.layer.shared ?? []).map((each) => each.id).sort()).toEqual([providerFragment("provider-b"), regionFragment("provider-b", "europe-west1")]);
    expect(checkPlacement(only.layer, only.base).filter((fault) => fault.level === "error")).toEqual([]);
    const rows = distinctRows(planCopies(only, TODAY).front);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => assumedInputs(only.layer, chances, row).length === 0)).toBe(true);
    // One copy on provider-b is on this front. Two copies on provider-a cost the same and beat it on the full front.
    const full = distinctRows(planCopies(build, TODAY).front);
    const one = (row: (typeof rows)[number]): boolean => Object.values(row.choice).filter((value) => value !== null).join() === "provider-b/europe-west1";
    expect(rows.some(one)).toBe(true);
    expect(full.some(one)).toBe(false);
  });

  it("gives no build when no candidate has measured inputs only", () => {
    expect(measuredBuild(placementLayer(input(offers)), CHANCES)).toBeUndefined();
  });
});

describe("the live copies", () => {
  // Two copies run: one at a site (a computer at a home) and one at provider-c, which has no offer in the plan lists.
  const offers = [
    offer({ provider: "provider-a", region: "europe-west1", plan: "small", hourly: 0.005 }),
    offer({ provider: "provider-b", region: "europe-west1", plan: "small", hourly: 0.01 }),
  ];
  const fixed: readonly FixedCopy[] = [
    { kind: "site", site: "home" },
    { kind: "cloud", provider: "provider-c", region: "europe-west1" },
  ];
  const measured = { kind: "measured" as const, source: "a made-up history" };
  const chances: PlacementChances = {
    ...CHANCES,
    site: { works: 0.99, kind: "assumed", source: "a test input" },
    overrides: [
      { id: providerFragment("provider-b"), works: 0.9995, ...measured },
      { id: regionFragment("provider-b", "europe-west1"), works: 0.9993, ...measured },
      { id: providerFragment("provider-c"), works: 0.9996, ...measured },
      { id: regionFragment("provider-c", "europe-west1"), works: 0.9994, ...measured },
    ],
  };

  it("puts each live copy in a fixed slot with one candidate and no cost", () => {
    const build = placementLayer(input(offers, { chances, fixed, copies: 1 }));
    expect(build.fixed).toEqual([fixedSlotId(0), fixedSlotId(1)]);
    expect(build.layer.slots.map((slot) => [slot.id, slot.optional === true, slot.candidates.length])).toEqual([
      [fixedSlotId(0), false, 1],
      [fixedSlotId(1), false, 1],
      [slotId(0), true, 2],
    ]);
    expect(build.layer.slots[1]?.candidates[0]).toMatchObject({ key: "provider-c/europe-west1", cost: 0 });
    expect((build.layer.shared ?? []).map((each) => each.id)).toContain(siteFragment("home"));
    expect(checkPlacement(build.layer, build.base).filter((fault) => fault.level === "error")).toEqual([]);
  });

  it("gives the chance of no new copy at no cost, and the gain of each next copy", () => {
    const build = placementLayer(input(offers, { chances, fixed, copies: 1 }));
    const levels = frontLevels(distinctRows(planCopies(build, TODAY).front));
    const none = levels[0];
    expect(none?.cost).toBe(0);
    // Either copy works: 1 less the chance that both fail. Each copy needs its host and each of its fragments.
    const home = 0.99 * CHANCES.host.works;
    const cloud = 0.9996 * 0.9994 * CHANCES.host.works;
    expect(none?.chance).toBeCloseTo(1 - (1 - home) * (1 - cloud), 9);
    expect(none?.rows.every((row) => row.choice[slotId(0)] === null)).toBe(true);
    // A third copy costs more and gives a higher chance.
    expect(levels.length).toBeGreaterThan(1);
    expect(levels.slice(1).every((level) => level.cost > 0 && level.chance > (none?.chance ?? 1))).toBe(true);
  });

  it("keeps the fixed slots in the build of measured inputs, and names their assumed fragments", () => {
    const build = placementLayer(input(offers, { chances, fixed, copies: 1 }));
    const only = measuredBuild(build, chances);
    expect(only?.layer.slots.map((slot) => slot.candidates.map((candidate) => candidate.key).join())).toEqual(["site/home", "provider-c/europe-west1", "provider-b/europe-west1"]);
    if (only === undefined) return;
    const rows = distinctRows(planCopies(only, TODAY).front);
    expect(rows.every((row) => assumedInputs(only.layer, chances, row).join() === siteFragment("home"))).toBe(true);
  });

  it("refuses a copy at a site with no site input, and two copies with one key", () => {
    expect(() => placementLayer(input(offers, { fixed }))).toThrow(RangeError);
    expect(() => placementLayer(input(offers, { chances, fixed: [fixed[1]!, fixed[1]!] }))).toThrow(RangeError);
    expect(() => fragmentInput(CHANCES, siteFragment("home"))).toThrow(RangeError);
  });
});

describe("the limit of cost from the configuration", () => {
  const config = { spend: [{ provider: "provider:example", monthlyUsd: 12, floor: 1, timeZone: "UTC" }] };

  it("reads the monthly cap of the named spend entry", () => {
    expect(spendLimitOf(config, "provider:example")).toBe(12);
  });

  it("gives no limit for a missing entry or a bad value", () => {
    expect(spendLimitOf(config, "provider:other")).toBeUndefined();
    expect(spendLimitOf({ spend: [{ provider: "provider:example", monthlyUsd: -1 }] }, "provider:example")).toBeUndefined();
    expect(spendLimitOf({}, "provider:example")).toBeUndefined();
  });
});
