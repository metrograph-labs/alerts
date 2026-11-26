import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import type { Area, HealthState, PlaceId, RegionCode, SourceDescriptor, SourceHealth, SourceId, WatchedPlace } from "./contracts.ts";
import { coverage, coverageCandidates, coverageShort, DEFAULT_COVERAGE_POLICY, failureDomains, MAX_PLACE_CODES, placeCodesWithContaining, requiredFor, sourceCovers } from "./coverage.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const TORNADO = "met.tornado";

const KANSAS: WatchedPlace = {
  id: "place:a" as PlaceId,
  codes: [
    { system: "ugc", code: "KSZ083" },
    { system: "same", code: "020173" },
    { system: "state", code: "KS" },
    { system: "iso3166", code: "US" },
  ],
  bufferKm: 0,
};
const TEXAS: WatchedPlace = {
  id: "place:b" as PlaceId,
  codes: [
    { system: "same", code: "048029" },
    { system: "state", code: "TX" },
    { system: "iso3166", code: "US" },
  ],
  bufferKm: 0,
};

const US: Area[] = [{ type: "code", system: "iso3166", code: "US" }];

function source(id: string, fields: Partial<SourceDescriptor> = {}): SourceDescriptor {
  return {
    id: id as SourceId,
    title: `The source ${id}`,
    origins: ["https://example.test"],
    dependsOn: [`provider:${id}`],
    uses: ["internet", "dns", "power"],
    kinds: ["met"],
    coverage: US,
    transport: "poll",
    interval: 60_000,
    slowAfter: 10_000,
    auth: "none",
    ...fields,
  };
}

function healthOf(id: string, state: HealthState): SourceHealth {
  return { source: id as SourceId, state, since: 0, reason: "" };
}

const API = source("api", { dependsOn: ["provider:api", "cdn:x"] });
const RADIO = source("radio", { dependsOn: ["rf:transmitter"], uses: ["receiver", "power"], transport: "radio" });
const MIRROR = source("mirror", { dependsOn: ["provider:mirror", "cdn:x"] });

describe("sourceCovers", () => {
  it("needs a prefix of the source that has the kind", () => {
    expect(sourceCovers(API, KANSAS, TORNADO)).toBe(true);
    expect(sourceCovers(source("part", { kinds: ["met.tornado.warning"] }), KANSAS, TORNADO)).toBe(false);
    expect(sourceCovers(source("water", { kinds: ["hydro"] }), KANSAS, TORNADO)).toBe(false);
  });

  it("matches a code of the coverage to a code of the place, at each level", () => {
    const state = source("state", { coverage: [{ type: "code", system: "state", code: "KS" }] });
    expect(sourceCovers(state, KANSAS, TORNADO)).toBe(true);
    expect(sourceCovers(state, TEXAS, TORNADO)).toBe(false);
    const county = source("county", { coverage: [{ type: "code", system: "same", code: "020173" }] });
    expect(sourceCovers(county, KANSAS, TORNADO)).toBe(true);
    expect(sourceCovers(source("world", { coverage: "global" }), TEXAS, TORNADO)).toBe(true);
  });

  it("counts a SAME code of the coverage only when it holds the code of the place", () => {
    const sameSource = (code: string) => source(code, { coverage: [{ type: "code", system: "same", code }] });
    expect(sourceCovers(sameSource("020000"), KANSAS, TORNADO)).toBe(true);
    expect(sourceCovers(sameSource("000000"), TEXAS, TORNADO)).toBe(true);
    // A part of the county does not hold the full county, so the coverage shows the gap.
    expect(sourceCovers(sameSource("120173"), KANSAS, TORNADO)).toBe(false);
    expect(sourceCovers(sameSource("020000"), TEXAS, TORNADO)).toBe(false);
  });

  // Made-up positions in the ocean near 0, 0. No position is a real place.
  it("matches a shape of the coverage only to a place with a position in the shape", () => {
    const circle = source("circle", { coverage: [{ type: "circle", center: [0, 0], radiusKm: 500 }] });
    expect(sourceCovers(circle, KANSAS, TORNADO)).toBe(false);
    expect(sourceCovers(circle, { ...KANSAS, at: [1, 1] }, TORNADO)).toBe(true);
    expect(sourceCovers(circle, { ...KANSAS, at: [10, 10] }, TORNADO)).toBe(false);
    const square = source("square", { coverage: [{ type: "polygon", rings: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] }] });
    expect(sourceCovers(square, { ...KANSAS, at: [0.5, 0.5] }, TORNADO)).toBe(true);
    expect(sourceCovers(square, { ...KANSAS, at: [1, 0.5] }, TORNADO)).toBe(true);
    // The buffer of the place does not count, as for the codes.
    expect(sourceCovers(square, { ...KANSAS, at: [1.5, 0.5], bufferKm: 100 }, TORNADO)).toBe(false);
  });

  it("shows a gap for a shape that geo refuses", () => {
    const broken = source("broken", { coverage: [{ type: "polygon", rings: [[[0, 0], [1, 0], [0, 0]]] }] });
    expect(sourceCovers(broken, { ...KANSAS, at: [0.5, 0] }, TORNADO)).toBe(false);
  });
});

describe("coverage", () => {
  it("counts two independent sources, and their common resource", () => {
    const [entry] = coverage({ sources: [API, RADIO], health: [healthOf("api", "healthy"), healthOf("radio", "slow")], places: [KANSAS], kinds: [TORNADO] });
    expect(entry).toEqual({
      place: KANSAS.id,
      kind: TORNADO,
      sources: ["api", "radio"],
      independent: 2,
      proven: true,
      faults: ["provider:api", "rf:transmitter"],
      commonResources: ["power"],
      required: 2,
    });
    expect(coverageShort(entry!)).toBe(false);
  });

  it("finds the one domain that stops two sources", () => {
    const [entry] = coverage({ sources: [API, MIRROR], health: [healthOf("api", "healthy"), healthOf("mirror", "healthy")], places: [KANSAS], kinds: [TORNADO] });
    expect(entry).toMatchObject({ independent: 1, faults: ["cdn:x"], commonResources: ["internet", "dns", "power"], required: 2 });
    expect(coverageShort(entry!)).toBe(true);
  });

  it("counts only the sources that are up", () => {
    const sources = [API, RADIO, MIRROR, source("new")];
    const health = [healthOf("api", "failing"), healthOf("radio", "silent"), healthOf("mirror", "changed")];
    const [entry] = coverage({ sources, health, places: [KANSAS], kinds: [TORNADO] });
    // A source with no health is unknown, so it does not count.
    expect(entry).toMatchObject({ sources: [], independent: 0, proven: true, faults: [], commonResources: [] });
    expect(coverageShort(entry!)).toBe(true);
  });

  it("gives a source with no domain its own domain", () => {
    expect(failureDomains(source("bare", { dependsOn: [] }))).toEqual(["source:bare"]);
    const sources = [source("one", { dependsOn: [] }), source("two", { dependsOn: [] })];
    const [entry] = coverage({ sources, health: [healthOf("one", "healthy"), healthOf("two", "healthy")], places: [KANSAS], kinds: [TORNADO] });
    expect(entry).toMatchObject({ independent: 2, faults: ["source:one", "source:two"] });
  });

  it("needs 2 for a life-safety kind and 1 for another kind", () => {
    expect(requiredFor(DEFAULT_COVERAGE_POLICY, TORNADO)).toBe(2);
    expect(requiredFor(DEFAULT_COVERAGE_POLICY, "met.flood.flash.emergency")).toBe(2);
    expect(requiredFor(DEFAULT_COVERAGE_POLICY, "met.winter")).toBe(1);
    const [entry] = coverage({ sources: [API], health: [healthOf("api", "healthy")], places: [KANSAS], kinds: ["met.winter"] });
    expect(entry).toMatchObject({ independent: 1, required: 1 });
    expect(coverageShort(entry!)).toBe(false);
  });

  it("needs no source for a kind of context, so a place with no transit feed has no gap", () => {
    expect(requiredFor(DEFAULT_COVERAGE_POLICY, "transport.transit")).toBe(0);
    expect(requiredFor(DEFAULT_COVERAGE_POLICY, "transport.rail")).toBe(1);
    const [entry] = coverage({ sources: [API], health: [healthOf("api", "healthy")], places: [KANSAS], kinds: ["transport.transit"] });
    expect(entry).toMatchObject({ sources: [], independent: 0, required: 0, proven: true });
    expect(coverageShort(entry!)).toBe(false);
  });

  it("gives no gap at a place out of the country of a source of road reports (AL-178)", () => {
    const roads = source("roads", { kinds: ["transport.road.incident"], coverage: [{ type: "code", system: "iso3166", code: "NL" }] });
    const [entry] = coverage({ sources: [roads], health: [healthOf("roads", "healthy")], places: [KANSAS], kinds: ["transport.road.incident"] });
    expect(entry).toMatchObject({ sources: [], independent: 0, required: 0 });
    expect(coverageShort(entry!)).toBe(false);
  });

  it("gives each place and kind in order", () => {
    const state = source("state", { coverage: [{ type: "code", system: "state", code: "KS" }] });
    const entries = coverage({ sources: [state, RADIO], health: [healthOf("state", "healthy"), healthOf("radio", "healthy")], places: [KANSAS, TEXAS], kinds: [TORNADO, "met.winter"] });
    expect(entries.map((entry) => [entry.place, entry.kind, entry.sources])).toEqual([
      [KANSAS.id, TORNADO, ["state", "radio"]],
      [KANSAS.id, "met.winter", ["state", "radio"]],
      [TEXAS.id, TORNADO, ["radio"]],
      [TEXAS.id, "met.winter", ["radio"]],
    ]);
  });

  it("marks a coverage that the search did not prove as short", () => {
    // Three sources with the domains of a triangle need a search. With no step, the search does not prove its count.
    const sources = [source("ab", { dependsOn: ["a", "b"] }), source("bc", { dependsOn: ["b", "c"] }), source("ac", { dependsOn: ["a", "c"] })];
    const health = sources.map((entry) => healthOf(entry.id, "healthy"));
    const [budget] = coverage({ sources, health, places: [KANSAS], kinds: [TORNADO] }, { ...DEFAULT_COVERAGE_POLICY, maxSteps: 0 });
    expect(budget).toMatchObject({ independent: 2, proven: false });
    expect(coverageShort(budget!)).toBe(true);
    const [full] = coverage({ sources, health, places: [KANSAS], kinds: [TORNADO] });
    expect(full).toMatchObject({ independent: 2, proven: true });
    expect(coverageShort(full!)).toBe(false);
  });

  it("gives no gap for a kind that needs no source, also when the search stops at its budget", () => {
    // Many transit feeds at one place can make the search stop. The policy needs no source, so it is not short.
    const transit = { kinds: ["transport.transit"] };
    const sources = [source("ab", { ...transit, dependsOn: ["a", "b"] }), source("bc", { ...transit, dependsOn: ["b", "c"] }), source("ac", { ...transit, dependsOn: ["a", "c"] })];
    const health = sources.map((entry) => healthOf(entry.id, "healthy"));
    const [budget] = coverage({ sources, health, places: [KANSAS], kinds: ["transport.transit"] }, { ...DEFAULT_COVERAGE_POLICY, maxSteps: 1 });
    expect(budget).toMatchObject({ required: 0, proven: false });
    expect(coverageShort(budget!)).toBe(false);
  });

  it.each(SEEDS)("gives the smallest set of domains that stops each source (seed %i)", (seed) => {
    const r = random(seed);
    const pool = ["provider:a", "provider:b", "cdn:x", "cdn:y", "rf:z", "dns:w"];
    const states: HealthState[] = ["healthy", "slow", "failing", "unknown", "silent", "changed"];
    for (let round = 0; round < 150; round += 1) {
      const sources = Array.from({ length: r.int(0, 6) }, (_, n) =>
        source(`s${n}`, { dependsOn: Array.from({ length: r.int(0, 3) }, () => pool[r.int(0, pool.length - 1)]!), uses: r.chance(0.5) ? ["internet", "dns", "power"] : ["receiver", "power"] }),
      );
      const health = sources.map((entry) => healthOf(entry.id, states[r.int(0, states.length - 1)]!));
      const [entry] = coverage({ sources, health, places: [KANSAS], kinds: [TORNADO] });
      const up = sources.filter((_, n) => ["healthy", "slow"].includes(health[n]!.state));
      const label = `seed ${seed} round ${round}`;
      expect(entry!.sources, label).toEqual(up.map((one) => one.id));
      // The faults stop each source that is up, and no smaller set of domains does.
      expect(up.every((one) => failureDomains(one).some((domain) => entry!.faults.includes(domain))), label).toBe(true);
      expect(entry!.independent, label).toBe(smallestCut(up.map(failureDomains)));
      expect(entry!.commonResources, label).toEqual(up.length === 0 ? [] : up.every((one) => one.uses.includes("internet")) ? ["internet", "dns", "power"] : up.every((one) => one.uses.includes("receiver")) ? ["power", "receiver"] : ["power"]);
    }
  });
});

describe("the codes that contain the codes of a place", () => {
  // A table of two levels: a zone is in a state, and a state is in a country. The marine zone is in no state.
  const PARENTS: Readonly<Record<string, readonly RegionCode[]>> = {
    "ugc:KSZ083": [{ system: "state", code: "KS" }],
    "state:KS": [{ system: "iso3166", code: "US" }],
  };
  const containing = (code: RegionCode): readonly RegionCode[] => PARENTS[`${code.system}:${code.code}`] ?? [];
  const ZONE_ONLY: WatchedPlace = { id: "place:z" as PlaceId, codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 0 };
  const MARINE: WatchedPlace = { id: "place:m" as PlaceId, codes: [{ system: "ugc", code: "GMZ550" }], bufferKm: 0 };
  const health = [healthOf("api", "healthy")];

  it("adds the codes of the regions that hold each code, and their codes, with no code two times", () => {
    expect(placeCodesWithContaining(ZONE_ONLY.codes, containing)).toEqual([
      { system: "ugc", code: "KSZ083" },
      { system: "state", code: "KS" },
      { system: "iso3166", code: "US" },
    ]);
    expect(placeCodesWithContaining([{ system: "state", code: "KS" }, { system: "iso3166", code: "US" }], containing)).toEqual([
      { system: "state", code: "KS" },
      { system: "iso3166", code: "US" },
    ]);
    expect(placeCodesWithContaining(MARINE.codes, containing)).toEqual(MARINE.codes);
  });

  it("covers a place with only a zone code by a source of its country, and shows the gap without the function", () => {
    const [without] = coverage({ sources: [API], health, places: [ZONE_ONLY], kinds: [TORNADO] });
    expect(without!.sources).toEqual([]);
    const [withCodes, marine] = coverage({ sources: [API], health, places: [ZONE_ONLY, MARINE], kinds: [TORNADO], containing });
    expect(withCodes!.sources).toEqual(["api"]);
    expect(marine!.sources).toEqual([]);
  });

  it("gives the candidates of each place and kind, with the sources that are down, and the codes that contain a code", () => {
    const water = source("water", { kinds: ["hydro"] });
    expect(coverageCandidates({ sources: [API, RADIO, water], places: [ZONE_ONLY, MARINE], kinds: [TORNADO, "hydro"], containing })).toEqual([
      { place: "place:z", kind: TORNADO, sources: ["api", "radio"] },
      { place: "place:z", kind: "hydro", sources: ["water"] },
      { place: "place:m", kind: TORNADO, sources: [] },
      { place: "place:m", kind: "hydro", sources: [] },
    ]);
  });

  it.each(SEEDS)("gives in coverage exactly the candidates that are up and not late (seed %i)", (seed) => {
    const r = random(seed);
    const states: HealthState[] = ["healthy", "slow", "failing", "unknown", "silent", "changed"];
    const areas: Area[][] = [US, [{ type: "code", system: "state", code: "KS" }], [{ type: "code", system: "state", code: "TX" }], [{ type: "code", system: "ugc", code: "KSZ083" }]];
    const kinds = ["met", TORNADO, "hydro", "met.tornado.warning"];
    for (let round = 0; round < 100; round += 1) {
      const sources = Array.from({ length: r.int(0, 6) }, (_, n) => source(`s${n}`, { kinds: [kinds[r.int(0, kinds.length - 1)]!], coverage: areas[r.int(0, areas.length - 1)]! }));
      const health = sources.map((entry) => healthOf(entry.id, states[r.int(0, states.length - 1)]!));
      const late = sources.filter(() => r.chance(0.2)).map((entry) => entry.id);
      const input = { sources, health, late, places: [KANSAS, TEXAS, ZONE_ONLY], kinds: [TORNADO, "hydro"], containing };
      const candidates = coverageCandidates(input);
      const up = new Set(sources.filter((_, n) => ["healthy", "slow"].includes(health[n]!.state) && !late.includes(sources[n]!.id)).map((entry) => entry.id));
      const label = `seed ${seed} round ${round}`;
      expect(coverage(input).map((entry) => [entry.place, entry.kind, entry.sources]), label).toEqual(candidates.map((entry) => [entry.place, entry.kind, entry.sources.filter((id) => up.has(id))]));
    }
  });

  it("refuses a function that gives codes with no end", () => {
    const endless = (code: RegionCode): readonly RegionCode[] => [{ system: "n", code: `${code.code}1` }];
    expect(() => placeCodesWithContaining([{ system: "n", code: "1" }], endless)).toThrow(`A place has more than ${MAX_PLACE_CODES} codes with the codes that contain them.`);
  });
});

/** This function gives the size of the smallest set of domains that hits each set, by a test of each subset. */
function smallestCut(sets: readonly (readonly string[])[]): number {
  const domains = [...new Set(sets.flat())];
  let best = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 1 << domains.length; mask += 1) {
    const chosen = domains.filter((_, n) => (mask & (1 << n)) !== 0);
    if (sets.every((set) => set.some((domain) => chosen.includes(domain)))) best = Math.min(best, chosen.length);
  }
  return best;
}
