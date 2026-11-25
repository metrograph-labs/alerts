import type { MeteredObservation } from "@mark1russell7/market";
import { canonicalUnit } from "@mark1russell7/quantity";
import { checkPlacement } from "@mark1russell7/stack-placement";
import { describe, expect, it } from "vitest";
import {
  baseAssumed,
  COMMON_FRAGMENT,
  jointFit,
  readBase,
  readJoint,
  assumedInputs,
  azureSizesFor,
  choiceCount,
  computeMeter,
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
  type PlacementBase,
  type PlacementChances,
  type PlacementInput,
  windowsOffer,
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

// An offer in the form of the Azure parser: its one meter of hours has the name of its size, and the specs name the product.
function sized(product: string, size: string, hourly: number, meters: readonly string[] = [size]): MeteredObservation {
  const base = offer({ provider: "provider-c", region: "region-c", plan: size, hourly, memory: "1 GiB" });
  return {
    offer: { ...base.offer, specs: [...base.offer.specs, { name: "productName", value: product }] },
    reading: { ...base.reading, meters: meters.map((name) => ({ name, tiers: [{ from: { value: 0, unit: "h" }, unitPrice: { value: hourly, unit: canonicalUnit("USD/h") } }] })) },
  };
}

describe("the offers of virtual machines (AL-146)", () => {
  it("uses the one meter of hours of an offer with no compute meter", () => {
    const machine = sized("Machines Series X", "X1", 0.02);
    expect(computeMeter(machine)).toBe("X1");
    expect(monthCost(machine)?.value).toBeCloseTo(14.6, 9);
    expect(computeMeter(offer({ provider: "provider-a", region: "europe-west1", plan: "p1", hourly: 0.01 }))).toBe("compute");
  });

  it("gives no compute meter to an offer with two meters of hours", () => {
    const two = sized("Machines Series X", "X1", 0.02, ["X1", "X1 extra"]);
    expect(computeMeter(two)).toBeUndefined();
    expect(monthCost(two)).toBeUndefined();
  });

  it("puts an offer with one meter of hours into the layer", () => {
    const build = placementLayer(input([sized("Machines Series X", "X1", 0.02)]));
    expect(build.skipped.meter).toBe(0);
    expect(build.layer.slots[0]?.candidates.map((candidate) => candidate.key)).toEqual(["provider-c/region-c"]);
  });

  it("tells a Windows offer by its product name", () => {
    expect(windowsOffer(sized("Machines Series X Windows", "X1", 0.03))).toBe(true);
    expect(windowsOffer(sized("Machines Series X", "X1", 0.02))).toBe(false);
    expect(windowsOffer(offer({ provider: "provider-a", region: "europe-west1", plan: "p1", hourly: 0.01 }))).toBe(false);
  });

  it("gives the smallest sizes with enough memory, by vCPUs, then memory, then name", () => {
    const table = { Big: [4, 16], Small: [1, 1], Half: [1, 0.5], Wide: [2, 1], Tall: [1, 4], Also: [1, 4] } as const;
    expect(azureSizesFor(table, 1024, 3)).toEqual(["Small", "Also", "Tall"]);
    expect(azureSizesFor(table, 4096, 10)).toEqual(["Also", "Tall", "Big"]);
    expect(azureSizesFor(table, 1024, 0)).toEqual([]);
    expect(() => azureSizesFor(table, 1024, 1.5)).toThrow(RangeError);
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

describe("the common cause of the live copies (AL-147)", () => {
  const offers = [
    offer({ provider: "provider-a", region: "europe-west1", plan: "small", hourly: 0.005 }),
    offer({ provider: "provider-b", region: "europe-west1", plan: "small", hourly: 0.01 }),
  ];
  const fixed: readonly FixedCopy[] = [
    { kind: "site", site: "home" },
    { kind: "cloud", provider: "provider-c", region: "europe-west1" },
  ];
  const measured = { kind: "measured" as const, source: "made-up heartbeat flips" };
  // Two independent copies of 0.95 and 0.97 give 0.9985. The measure gives 0.985: the copies fail together more often.
  const chances: PlacementChances = {
    ...CHANCES,
    site: { works: 0.99, kind: "assumed", source: "a test input" },
    overrides: [
      { id: providerFragment("provider-c"), works: 0.9996, ...measured },
      { id: regionFragment("provider-c", "europe-west1"), works: 0.9994, ...measured },
    ],
    joint: { works: [{ works: 0.95, ...measured }, { works: 0.97, ...measured }], anyWorks: { works: 0.985, ...measured } },
  };

  it("gives the measured chance of the live copies to the front of no new copy", () => {
    const build = placementLayer(input(offers, { chances, fixed, copies: 1 }));
    const none = frontLevels(distinctRows(planCopies(build, TODAY).front))[0];
    expect(none?.cost).toBe(0);
    expect(none?.chance).toBeCloseTo(0.985, 9);
    expect(checkPlacement(build.layer, build.base).filter((fault) => fault.level === "error")).toEqual([]);
  });

  it("limits the gain of each new copy by the common cause", () => {
    const build = placementLayer(input(offers, { chances, fixed, copies: 2 }));
    const common = jointFit(chances)?.common.works ?? 0;
    expect(common).toBeCloseTo(0.9855615, 6);
    const levels = frontLevels(distinctRows(planCopies(build, TODAY).front));
    expect(levels.length).toBeGreaterThan(1);
    expect(levels.every((level) => level.chance < common)).toBe(true);
    // With no joint measure, the copies are independent, and a new copy gives more than the common cause allows.
    const free = frontLevels(distinctRows(planCopies(placementLayer(input(offers, { chances: { ...chances, joint: undefined }, fixed, copies: 2 })), TODAY).front));
    expect(Math.max(...free.map((level) => level.chance))).toBeGreaterThan(common);
  });

  it("puts the common fragment in each candidate, with a measured input", () => {
    const build = placementLayer(input(offers, { chances, fixed, copies: 1 }));
    expect(build.layer.slots.every((slot) => slot.candidates.every((candidate) => candidate.uses?.includes(COMMON_FRAGMENT) === true))).toBe(true);
    expect(fragmentInput(chances, COMMON_FRAGMENT).kind).toBe("measured");
    expect(() => fragmentInput(CHANCES, COMMON_FRAGMENT)).toThrow(RangeError);
  });

  it("reads a joint measure, and refuses a measure with no input for each fixed copy", () => {
    const value = { works: [{ works: 0.95, ...measured }, { works: 0.97, ...measured }], anyWorks: { works: 0.985, ...measured } };
    expect(readJoint(value)).toEqual(chances.joint);
    expect(readJoint({ works: [] })).toMatch(/no list works/u);
    expect(readJoint({ ...value, anyWorks: { works: 2, ...measured } })).toMatch(/anyWorks/u);
    expect(readJoint({ ...value, works: [{ works: 0.9, kind: "guess", source: "x" }] })).toMatch(/Each input/u);
    expect(() => placementLayer(input(offers, { chances, fixed: [fixed[0]!], copies: 1 }))).toThrow(RangeError);
  });
});

describe("the needs that all copies share", () => {
  // A made-up chain: the function needs a push path or a call path, and some copy. Each path needs one service.
  const base: PlacementBase = {
    stack: {
      schema: "stack/1",
      parts: [
        { id: "notify", kind: "function", needs: [{ any: ["push-path", "call-path"] }, { any: ["copy-x", "copy-y"] }] },
        { id: "push-path", kind: "path", needs: ["push-api"] },
        { id: "call-path", kind: "path", needs: ["call-api", "carrier"] },
        { id: "push-api", kind: "provider" },
        { id: "call-api", kind: "provider" },
        { id: "carrier", kind: "provider" },
        { id: "copy-x", kind: "copy", needs: ["power-x"] },
        { id: "power-x", kind: "power" },
        { id: "copy-y", kind: "copy" },
      ],
      layers: { "risk/1": { schema: "risk/1", goals: [{ part: "notify", survives: 1 }] } },
    },
    part: "notify",
    copies: ["copy-x", "copy-y"],
    chances: [
      { part: "push-api", works: 0.999, kind: "measured", source: "a made-up history" },
      { part: "call-api", works: 0.99, kind: "assumed", source: "a test input" },
    ],
  };
  const offers = [offer({ provider: "provider-a", region: "europe-west1", plan: "small", hourly: 0.005 })];
  const fixed: readonly FixedCopy[] = [{ kind: "cloud", provider: "provider-c", region: "europe-west1" }];
  const chances: PlacementChances = { ...CHANCES, overrides: [{ id: providerFragment("provider-c"), works: 0.9996, kind: "measured", source: "a made-up history" }] };

  it("replaces the copies of the function with some slot, and keeps the goals of the stack", () => {
    const build = placementLayer(input(offers, { chances, fixed, copies: 1, base }));
    expect(build.layer.part).toBe("notify");
    const notify = build.base.parts.find((part) => part.id === "notify");
    expect(notify?.needs).toEqual([{ any: ["push-path", "call-path"] }, { any: [fixedSlotId(0), slotId(0)] }]);
    expect(checkPlacement(build.layer, build.base).filter((fault) => fault.level === "error")).toEqual([]);
  });

  it("multiplies the chance of each row by the chance of the shared needs", () => {
    const build = placementLayer(input(offers, { chances, fixed, copies: 1, base }));
    const levels = frontLevels(distinctRows(planCopies(build, TODAY).front));
    const plain = frontLevels(distinctRows(planCopies(placementLayer(input(offers, { chances, fixed, copies: 1 })), TODAY).front));
    // The carrier has no input: it works at each time. The paths: 1 less the chance that both fail.
    const shared = 1 - (1 - 0.999) * (1 - 0.99);
    expect(levels.map((level) => level.cost)).toEqual(plain.map((level) => level.cost));
    levels.forEach((level, index) => expect(level.chance).toBeCloseTo((plain[index]?.chance ?? 0) * shared, 12));
    // No count of copies gets past the chance of the shared needs.
    expect(levels.every((level) => level.chance < shared)).toBe(true);
  });

  it("names the assumed and the missing inputs past the copies", () => {
    expect(baseAssumed(base)).toEqual({ assumed: ["call-api"], missing: ["carrier"] });
  });

  it("reads a base from JSON, and gives a problem for a bad field", () => {
    const json: unknown = JSON.parse(JSON.stringify(base));
    expect(readBase(json)).toEqual(base);
    expect(readBase({ ...base, part: 1 })).toBe("The base has no text part.");
    expect(readBase({ ...base, copies: [1] })).toBe("The copies of the base are not a list of texts.");
    expect(readBase({ ...base, chances: [{ part: "push-api", works: 0.9, kind: "guess", source: "x" }] })).toContain("Each chance of the base");
    expect(readBase({ ...base, stack: { parts: [] } })).toContain("The stack of the base has faults");
    expect(readBase([])).toBe("The base is not an object.");
  });

  it("reads the status page of a chance, with the read api as the default, and gives a problem for a bad status", () => {
    const chance = { part: "push-api", works: 0.999, kind: "assumed", source: "a test input" };
    const read = (status: unknown) => readBase({ ...base, chances: [{ ...chance, status }] });
    const plain = read({ host: "status.service-a.test" });
    expect(typeof plain !== "string" && plain.chances?.[0]?.status).toEqual({ host: "status.service-a.test", read: "api", components: [] });
    const file = read({ host: "status.service-a.test", read: "history", components: ["Component one"] });
    expect(typeof file !== "string" && file.chances?.[0]?.status).toEqual({ host: "status.service-a.test", read: "history", components: ["Component one"] });
    expect(read({ host: "https://status.service-a.test/" })).toContain("The status of the chance of push-api");
    expect(read({ host: "status.service-a.test", read: "rss" })).toContain("The status of the chance of push-api");
    expect(read({ host: "status.service-a.test", components: "Component one" })).toContain("The status of the chance of push-api");
    expect(read("status.service-a.test")).toContain("The status of the chance of push-api");
  });

  it("reads the channel id of a chance, and gives a problem for a channel that is not a text (AL-147)", () => {
    const chance = { part: "push-api", works: 0.999, kind: "assumed", source: "a test input" };
    const read = (channel: unknown) => readBase({ ...base, chances: [{ ...chance, channel }] });
    const named = read("push");
    expect(typeof named !== "string" && named.chances?.[0]?.channel).toBe("push");
    expect(read(7)).toBe("The channel of the chance of push-api is not a text.");
    expect(read("")).toBe("The channel of the chance of push-api is not a text.");
  });

  it("refuses an unknown part, two inputs of one part, and an id of a slot in the stack", () => {
    expect(() => placementLayer(input(offers, { base: { ...base, part: "other" } }))).toThrow(RangeError);
    expect(() => placementLayer(input(offers, { base: { ...base, copies: ["copy-z"] } }))).toThrow(RangeError);
    const twice = [...(base.chances ?? []), { part: "push-api", works: 0.9, kind: "assumed" as const, source: "a test input" }];
    expect(() => placementLayer(input(offers, { base: { ...base, chances: twice } }))).toThrow(RangeError);
    const clash: PlacementBase = { ...base, stack: { ...base.stack, parts: [...base.stack.parts, { id: slotId(0), kind: "host" }] } };
    expect(() => placementLayer(input(offers, { base: clash }))).toThrow(RangeError);
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
