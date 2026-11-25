import { CONFIG_FORMAT, type AlertConfig, type Incident, type MapRegion, type PlaceConfig, type PlaceId, type Position, type RegionCode, type ReportId, type SourceDescriptor, type SourceId, type WatchedPlace } from "@mark1russell7/alerts";
import type { Refreshed, RefreshInput, ShapeStore } from "@mark1russell7/alerts-shapes-nws";
import { NWS_DESCRIPTOR, NWS_PROVIDER } from "@mark1russell7/alerts-source-nws-api";
import { describe, expect, it } from "vitest";
import { addZoneCodes, keepShapes, liveCodes, placeCodesKey, refreshUntil, shapeReport, wantedShapes, withZoneCodes, zoneCodesText, type ShapeOutcome } from "./shapes.ts";

const T0 = Date.UTC(2026, 10, 15, 18, 0, 0);
const RING = [
  [-97, 37],
  [-96, 37],
  [-96, 38],
  [-97, 37],
] as const;

// Public places in Kansas and Texas. The codes are public regions, not the places of a person.
const KANSAS: WatchedPlace = { id: "place-ks" as PlaceId, codes: [{ system: "state", code: "KS" }, { system: "ugc", code: "KSZ083" }, { system: "same", code: "020173" }, { system: "iso3166", code: "US" }], bufferKm: 0 };
const TEXAS: WatchedPlace = { id: "place-tx" as PlaceId, codes: [{ system: "ugc", code: "TXC029" }], bufferKm: 5 };

function incident(anchor: string, codes: readonly RegionCode[], live = true): Incident {
  return {
    anchor: anchor.padEnd(64, "0") as ReportId,
    reports: [anchor.padEnd(64, "0") as ReportId],
    status: "actual",
    kind: { code: "met.tornado", label: "Tornado Warning" },
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    areas: [...codes.map((code) => ({ type: "code" as const, ...code })), { type: "circle", center: [-97, 37], radiusKm: 5 }],
    about: [],
    live,
    corroboration: 1,
  };
}

const REFRESHED: Refreshed = { requests: 2, failures: [], problems: [], stop: "done" };

/**
 * A fake store. It has a region for each UGC code in `known`, and the regions of `states` for the basemap of each state.
 * Each refresh waits until the test ends it. A region keeps its array of shapes, as in the real store.
 */
function fakeStore(known: readonly string[], states: Readonly<Record<string, readonly MapRegion[]>> = {}) {
  const calls: RefreshInput[] = [];
  let end: ((value: Refreshed) => void) | undefined;
  let fail: ((error: unknown) => void) | undefined;
  const regions = new Map<string, MapRegion>();
  // An id `fire:<code>` is a fire zone, with the system ugc-fire (AL-33).
  const region = (id: string): MapRegion => {
    const code: RegionCode = id.startsWith("fire:") ? { system: "ugc-fire", code: id.slice(5) } : { system: "ugc", code: id };
    // A region of a state list keeps its record, thus a lookup gives the shapes of the basemap of the state.
    const listed = Object.values(states).flat().find((item) => item.code.system === code.system && item.code.code === code.code);
    const held = regions.get(id) ?? listed ?? { code, name: `Zone ${id}`, shapes: [{ type: "polygon", rings: [RING] }] };
    regions.set(id, held);
    return held;
  };
  const zoneOf = (code: RegionCode): string | undefined => {
    const text = code.code.toUpperCase();
    if (code.system === "ugc") return text;
    if (code.system === "ugc-fire") return `fire:${text}`;
    if (code.system === "same") return text === "020173" ? "KSC173" : undefined;
    return undefined;
  };
  const store: ShapeStore = {
    lookup: (code) => {
      const id = zoneOf(code);
      return id !== undefined && known.includes(id) ? region(id).shapes : undefined;
    },
    region: (code) => {
      const id = zoneOf(code);
      return id !== undefined && known.includes(id) ? region(id) : undefined;
    },
    basemap: (state) => states[state] ?? [],
    fireZones: () => [],
    nextDue: () => undefined,
    refresh: (input) => {
      calls.push(input);
      return new Promise<Refreshed>((resolve, reject) => {
        end = resolve;
        fail = reject;
        input.signal?.addEventListener("abort", () => reject(input.signal?.reason));
      });
    },
  };
  return { store, calls, end: (value: Refreshed = REFRESHED) => end?.(value), fail: (error: unknown) => fail?.(error) };
}

describe("the codes of the outlines", () => {
  it("gives the codes of the live incidents, once each and in order", () => {
    const incidents = [
      incident("b", [{ system: "ugc", code: "TXC167" }, { system: "same", code: "020173" }]),
      incident("a", [{ system: "ugc", code: "txc167" }, { system: "ugc", code: "KSZ083" }]),
      incident("c", [{ system: "ugc", code: "KSC015" }], false),
    ];
    expect(liveCodes(incidents)).toEqual([
      { system: "same", code: "020173" },
      { system: "ugc", code: "KSZ083" },
      { system: "ugc", code: "TXC167" },
    ]);
  });

  it("wants the states of the places and the codes of the live incidents, and no code of a place", () => {
    const wanted = wantedShapes([TEXAS, KANSAS], [incident("a", [{ system: "ugc", code: "OKC001" }])]);
    expect(wanted).toEqual({ states: ["KS", "TX"], codes: [{ system: "ugc", code: "OKC001" }] });
  });

  it("wants no state for a place with only a country code", () => {
    const world: WatchedPlace = { id: "place-us" as PlaceId, codes: [{ system: "iso3166", code: "US" }], bufferKm: 0 };
    expect(wantedShapes([world], [])).toEqual({ states: [], codes: [] });
  });
});

// Two squares of one degree in Kansas with a shared edge at the longitude -97, and a square in Texas.
const square = (west: number, south: number): Position[] => [
  [west, south],
  [west + 1, south],
  [west + 1, south + 1],
  [west, south + 1],
  [west, south],
];
const zoneRegion = (id: string, west: number, south: number): MapRegion => ({ code: { system: "ugc", code: id }, name: `Zone ${id}`, shapes: [{ type: "polygon", rings: [square(west, south)] }] });
const OUTLINES: Readonly<Record<string, readonly MapRegion[]>> = {
  KS: [zoneRegion("KSC173", -98, 37), zoneRegion("KSZ083", -98, 37), zoneRegion("KSC015", -97, 37)],
  TX: [zoneRegion("TXC029", -99, 29)],
};
const outlines = (state: string): readonly MapRegion[] => OUTLINES[state] ?? [];

/** This function gives a configuration with these places and no person. */
const configOf = (...places: PlaceConfig[]): AlertConfig => ({ format: CONFIG_FORMAT, places, people: [], contacts: [], policies: [] });
const kansasPlace: PlaceConfig = { id: "place-ks" as PlaceId, label: "A place", at: [-97.5, 37.5], codes: [{ system: "same", code: "020173" }], bufferKm: 0 };

describe("withZoneCodes", () => {
  it("adds the codes of the zones that contain the position, after the codes of the file", () => {
    const [place] = withZoneCodes(configOf(kansasPlace), outlines).places;
    expect(place?.codes).toEqual([
      { system: "same", code: "020173" },
      { system: "state", code: "KS" },
      { system: "ugc", code: "KSC173" },
      { system: "ugc", code: "KSZ083" },
    ]);
  });

  it("adds the codes of a zone in the buffer, and no code of the file again", () => {
    const near: PlaceConfig = { ...kansasPlace, codes: [{ system: "ugc", code: "ksc173" }, { system: "same", code: "020173" }], bufferKm: 50 };
    const [place] = withZoneCodes(configOf(near), outlines).places;
    expect(place?.codes.map((code) => `${code.system}:${code.code}`)).toEqual(["ugc:ksc173", "same:020173", "same:020015", "state:KS", "ugc:KSC015", "ugc:KSZ083"]);
  });

  it("keeps the codes of a place with no position, or with no outline of its states", () => {
    const noPosition: PlaceConfig = { id: "place-a" as PlaceId, label: "A", codes: [{ system: "state", code: "KS" }], bufferKm: 0 };
    const noOutline: PlaceConfig = { id: "place-b" as PlaceId, label: "B", at: [-100.5, 44.5], codes: [{ system: "state", code: "SD" }], bufferKm: 0 };
    const config = configOf(noPosition, noOutline);
    expect(withZoneCodes(config, outlines).places).toEqual(config.places);
  });

  it("reads only the outlines of the states of the codes of the place", () => {
    const asked: string[] = [];
    // The position is in the square of Texas, but the place has only a code of Kansas.
    const wrong: PlaceConfig = { ...kansasPlace, at: [-98.5, 29.5] };
    const [place] = withZoneCodes(configOf(wrong), (state) => {
      asked.push(state);
      return outlines(state);
    }).places;
    expect(asked).toEqual(["KS"]);
    expect(place?.codes).toEqual(wrong.codes);
  });

  it("gives one key for the same codes, and a new key for new codes", () => {
    const config = configOf(kansasPlace);
    const zoned = withZoneCodes(config, outlines);
    expect(placeCodesKey(config)).toBe(placeCodesKey(configOf({ ...kansasPlace, label: "Other", codes: [{ system: "same", code: "020173" }] })));
    expect(placeCodesKey(zoned)).not.toBe(placeCodesKey(config));
    expect(placeCodesKey(withZoneCodes(zoned, outlines))).toBe(placeCodesKey(zoned));
  });
});

describe("addZoneCodes", () => {
  const noPosition: PlaceConfig = { id: "place-a" as PlaceId, label: "A", codes: [{ system: "state", code: "KS" }], bufferKm: 0 };
  const noOutline: PlaceConfig = { id: "place-b" as PlaceId, label: "B", at: [-100.5, 44.5], codes: [{ system: "state", code: "SD" }], bufferKm: 0 };
  const known: PlaceConfig = {
    ...kansasPlace,
    id: "place-c" as PlaceId,
    codes: [
      { system: "ugc", code: "ksc173" },
      { system: "ugc", code: "KSZ083" },
      { system: "same", code: "020173" },
      { system: "state", code: "KS" },
    ],
  };

  it("gives the configuration of withZoneCodes", () => {
    const config = configOf(kansasPlace, noPosition, noOutline, known);
    expect(addZoneCodes(config, outlines).config).toEqual(withZoneCodes(config, outlines));
  });

  it("counts the placed and outlined places, and the near and added codes", () => {
    // Each Kansas place has 4 codes near it: KSC173, its SAME code, the state and KSZ083. The first place adds 3, and the other adds 0.
    const { counts } = addZoneCodes(configOf(kansasPlace, noPosition, noOutline, known), outlines);
    expect(counts).toEqual({ placed: 3, outlined: 2, near: 8, added: 3 });
  });

  it("tells a file that has each code from a store with no outlines", () => {
    expect(addZoneCodes(configOf(known), outlines).counts).toEqual({ placed: 1, outlined: 1, near: 4, added: 0 });
    expect(addZoneCodes(configOf(known), () => []).counts).toEqual({ placed: 1, outlined: 0, near: 0, added: 0 });
  });
});

describe("zoneCodesText", () => {
  it("tells the near codes, the codes of the file and the added codes", () => {
    expect(zoneCodesText({ placed: 4, outlined: 4, near: 23, added: 0 })).toBe(
      "The outlines of the zones give 23 codes near 4 places. The file already has 23 of them, and the runtime adds 0.",
    );
    expect(zoneCodesText({ placed: 1, outlined: 1, near: 1, added: 1 })).toBe("The outlines of the zones give 1 code near 1 place. The file already has 0 of them, and the runtime adds 1.");
  });

  it("tells the places that wait for outlines, and a configuration with no position", () => {
    expect(zoneCodesText({ placed: 2, outlined: 0, near: 0, added: 0 })).toBe(
      "The store has no outlines of the states of 2 places yet. These places keep the codes of the file until a refresh gets the outlines.",
    );
    expect(zoneCodesText({ placed: 3, outlined: 2, near: 5, added: 1 })).toBe(
      "The outlines of the zones give 5 codes near 2 places. The file already has 4 of them, and the runtime adds 1. The store has no outlines of the states of 1 place yet. These places keep the codes of the file until a refresh gets the outlines.",
    );
    expect(zoneCodesText({ placed: 0, outlined: 0, near: 0, added: 0 })).toBe("No place has a position. Thus the outlines of the zones add no code.");
  });
});

describe("shapeReport", () => {
  it("gives no text for a refresh with no failure and no problem", () => {
    expect(shapeReport({ ok: true, refreshed: REFRESHED })).toBeUndefined();
  });

  it("names each failure and each problem, and the stop", () => {
    const report = shapeReport({
      ok: true,
      refreshed: { requests: 3, failures: [{ task: "zone:county:KSC173", failure: { kind: "server", message: "HTTP 503." } }], problems: ["A row has no id."], stop: "host" },
    });
    expect(report).toBe('The refresh of the shapes made 3 requests and stopped at "host". It has these failures and problems:\n- zone:county:KSC173: server: HTTP 503.\n- A row has no id.');
  });

  it("gives the message of an error", () => {
    expect(shapeReport({ ok: false, error: new Error("The disk is full.") })).toBe("The refresh of the shapes threw: The disk is full.");
  });
});

describe("refreshUntil", () => {
  // A source of another host. It is due each 15 seconds, as the NWWS source of a live copy.
  const other: SourceDescriptor = { ...NWS_DESCRIPTOR, id: "other" as SourceId, dependsOn: ["provider:other"] };
  const second: SourceDescriptor = { ...NWS_DESCRIPTOR, id: "second" as SourceId };
  const due = (times: Record<string, number>) => (source: SourceDescriptor) => times[source.id] ?? T0;

  it("gives the next fetch of the sources of the NWS API, not the next fetch of another host (AL-33)", () => {
    expect(NWS_DESCRIPTOR.dependsOn).toContain(NWS_PROVIDER);
    const times = { [NWS_DESCRIPTOR.id]: T0 + 50_000, other: T0 + 2_000 };
    expect(refreshUntil([other, NWS_DESCRIPTOR], due(times))).toBe(T0 + 50_000);
    // The earliest source of the NWS API gives the limit.
    expect(refreshUntil([NWS_DESCRIPTOR, second, other], due({ ...times, second: T0 + 30_000 }))).toBe(T0 + 30_000);
  });

  it("gives undefined with no source of the NWS API, thus no refresh starts", () => {
    expect(refreshUntil([other], due({ other: T0 + 2_000 }))).toBeUndefined();
    expect(refreshUntil([], due({}))).toBeUndefined();
  });
});

describe("keepShapes", () => {
  it("has no outline and starts no refresh without a store", async () => {
    const keeper = keepShapes({ places: [KANSAS] });
    keeper.afterPass([], T0);
    expect(keeper.lookup({ system: "ugc", code: "KSZ083" })).toBeUndefined();
    expect(keeper.basemap()).toEqual([]);
    await keeper.idle();
    await keeper.close();
  });

  it("starts one refresh at a time with the time limit of the pass, and none with no time limit", async () => {
    const fake = fakeStore([]);
    const outcomes: unknown[] = [];
    const keeper = keepShapes({ store: fake.store, places: [KANSAS], onShapes: (outcome) => outcomes.push(outcome) });
    keeper.afterPass([], undefined);
    expect(fake.calls).toEqual([]);
    const live = [incident("a", [{ system: "ugc", code: "TXC167" }])];
    keeper.afterPass(live, T0);
    keeper.afterPass(live, T0 + 1);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ wanted: { states: ["KS"], codes: [{ system: "ugc", code: "TXC167" }] }, until: T0 });
    fake.end();
    await keeper.idle();
    expect(outcomes).toEqual([{ ok: true, refreshed: REFRESHED }]);
    keeper.afterPass(live, T0 + 2);
    expect(fake.calls).toHaveLength(2);
    fake.end();
    await keeper.idle();
  });

  it("gives an error of a refresh to the hook, and a fault of the hook stops nothing", async () => {
    const fake = fakeStore([]);
    const keeper = keepShapes({
      store: fake.store,
      places: [KANSAS],
      onShapes: () => {
        throw new Error("The hook failed.");
      },
    });
    keeper.afterPass([], T0);
    fake.fail(new Error("The cache is closed."));
    await keeper.idle();
    keeper.afterPass([], T0);
    fake.end();
    await keeper.idle();
    expect(fake.calls).toHaveLength(2);
  });

  it("gives the regions of the places and of the live incidents, once each, and the lookup of the store", async () => {
    const fake = fakeStore(["KSZ083", "KSC173", "TXC167", "KSC015"]);
    const keeper = keepShapes({ store: fake.store, places: [KANSAS, TEXAS] });
    expect(keeper.basemap().map((region) => region.code.code)).toEqual(["KSC173", "KSZ083"]);
    keeper.afterPass([incident("a", [{ system: "ugc", code: "TXC167" }, { system: "ugc", code: "KSC173" }]), incident("b", [{ system: "ugc", code: "KSC015" }], false)], undefined);
    expect(keeper.basemap().map((region) => region.code.code)).toEqual(["KSC173", "KSZ083", "TXC167"]);
    expect(keeper.lookup({ system: "same", code: "020173" })).toHaveLength(1);
    expect(keeper.lookup({ system: "ugc", code: "TXC029" })).toBeUndefined();
    await keeper.close();
  });

  it("keeps the fire zone of an incident next to the forecast zone with the same code (AL-33)", async () => {
    const forecast: MapRegion = { code: { system: "ugc", code: "KSZ083" }, name: "Forecast zone", shapes: [{ type: "polygon", rings: [RING] }] };
    const fake = fakeStore(["fire:KSZ083"], { KS: [forecast] });
    const keeper = keepShapes({ store: fake.store, places: [KANSAS] });
    const keys = (): string[] => keeper.basemap().map((region) => `${region.code.system}:${region.code.code}`);
    expect(keys()).toEqual(["ugc:KSZ083"]);
    keeper.afterPass([incident("a", [{ system: "ugc-fire", code: "KSZ083" }])], undefined);
    expect(keys().sort()).toEqual(["ugc-fire:KSZ083", "ugc:KSZ083"]);
    await keeper.close();
  });

  it("gives each region of each watched state, simplified, and simplifies the states again only after a change of the store", async () => {
    // A public county of Kansas. Its south edge has 3 positions that are 1 m from the line, thus the simplification removes them.
    const harvey: MapRegion = { code: { system: "ugc", code: "KSC079" }, name: "Harvey", shapes: [{ type: "polygon", rings: [[[-98, 37], [-97.75, 37.00001], [-97.5, 37], [-97.25, 37.00001], [-97, 37], [-97, 38], [-98, 38], [-98, 37]]] }] };
    const lists: Record<string, readonly MapRegion[]> = { KS: [harvey] };
    const fake = fakeStore(["KSZ083", "KSC173", "TXC167"], lists);
    const outcomes: ShapeOutcome[] = [];
    const keeper = keepShapes({ store: fake.store, places: [KANSAS], onShapes: (outcome) => outcomes.push(outcome) });
    const first = keeper.basemap();
    expect(first.map((region) => region.code.code)).toEqual(["KSC079", "KSC173", "KSZ083"]);
    const ring = first[0]!.shapes[0]!.type === "polygon" ? first[0]!.shapes[0]!.rings[0]! : [];
    expect(ring).toHaveLength(5);
    expect(new Set(ring.map(([lon, lat]) => `${String(lon)},${String(lat)}`))).toEqual(new Set(["-98,37", "-97,37", "-97,38", "-98,38"]));
    // The same regions give the same simplified copy.
    expect(keeper.basemap()).toBe(first);
    keeper.afterPass([incident("a", [{ system: "ugc", code: "TXC167" }])], undefined);
    const second = keeper.basemap();
    expect(second).not.toBe(first);
    expect(second.map((region) => region.code.code)).toEqual(["KSC079", "KSC173", "KSZ083", "TXC167"]);
    // An incident outside the watched states does not simplify the states again.
    expect(second[0]).toBe(first[0]);
    // A new record of the store gives a new copy of the states.
    lists["KS"] = [{ ...harvey, shapes: [...harvey.shapes] }];
    const third = keeper.basemap();
    expect(third[0]).not.toBe(first[0]);
    expect(third[0]).toEqual(first[0]);
    expect(outcomes).toEqual([]);
    await keeper.close();
  });

  it("gives the simplified shapes of the basemap to the incidents, and the full shapes of a region that is not on it (AL-176)", async () => {
    // A public county of Kansas. Its south edge has a position that is 1 m from the line, thus the simplification removes it.
    const harvey: MapRegion = { code: { system: "ugc", code: "KSC079" }, name: "Harvey", shapes: [{ type: "polygon", rings: [[[-98, 37], [-97.5, 37.00001], [-97, 37], [-97, 38], [-98, 38], [-98, 37]]] }] };
    const fake = fakeStore(["KSC079", "KSZ083", "KSC173", "TXC167"], { KS: [harvey] });
    const keeper = keepShapes({ store: fake.store, places: [KANSAS] });
    const harveyCode: RegionCode = { system: "ugc", code: "KSC079" };
    // Before the first basemap, the display gives the full shapes.
    expect(keeper.display(harveyCode)).toBe(harvey.shapes);
    const first = keeper.basemap();
    const shapesOf = (map: readonly MapRegion[], code: string) => map.find((region) => region.code.code === code)!.shapes;
    expect(keeper.display(harveyCode)).toBe(shapesOf(first, "KSC079"));
    expect(keeper.display(harveyCode)).not.toBe(harvey.shapes);
    // A SAME code gives the simplified shapes of its county.
    expect(keeper.display({ system: "same", code: "020173" })).toBe(shapesOf(first, "KSC173"));
    // A region that is not on the basemap gives the shapes of the store.
    expect(keeper.display({ system: "ugc", code: "TXC167" })).toBe(keeper.lookup({ system: "ugc", code: "TXC167" }));
    expect(keeper.display({ system: "ugc", code: "TXC029" })).toBeUndefined();
    keeper.afterPass([incident("a", [{ system: "ugc", code: "TXC167" }])], undefined);
    const second = keeper.basemap();
    expect(keeper.display({ system: "ugc", code: "TXC167" })).toBe(shapesOf(second, "TXC167"));
    // A new region of an incident simplifies only that region: the copy of each other region stays.
    expect(second.find((region) => region.code.code === "KSC173")).toBe(first.find((region) => region.code.code === "KSC173"));
    await keeper.close();
  });

  it("simplifies the regions of an incident on the two sides of the antimeridian (AL-176)", async () => {
    // Public zones of Alaska and Guam, with a position 1 m from the line on each south edge.
    const ring = (west: number): [number, number][] => [[west, 51], [west + 0.5, 51.00001], [west + 1, 51], [west + 1, 52], [west, 52], [west, 51]];
    const fake = fakeStore([]);
    const zones: Record<string, MapRegion> = {
      AKZ191: { code: { system: "ugc", code: "AKZ191" }, name: "Aleutians", shapes: [{ type: "polygon", rings: [ring(-179)] }] },
      GUZ001: { code: { system: "ugc", code: "GUZ001" }, name: "Guam", shapes: [{ type: "polygon", rings: [ring(144)] }] },
    };
    const store: ShapeStore = { ...fake.store, lookup: (code) => zones[code.code]?.shapes, region: (code) => zones[code.code] };
    const keeper = keepShapes({ store, places: [TEXAS] });
    keeper.afterPass([incident("a", [{ system: "ugc", code: "AKZ191" }, { system: "ugc", code: "GUZ001" }])], undefined);
    const map = keeper.basemap();
    expect(map.map((region) => region.code.code)).toEqual(["AKZ191", "GUZ001"]);
    for (const region of map) {
      const shape = region.shapes[0]!;
      expect(shape.type === "polygon" ? shape.rings[0] : []).toHaveLength(5);
    }
    await keeper.close();
  });

  // The gate of the size of the map (AL-176). Synthetic zones with dense outlines, as the outlines of the NWS API, from Guam
  // to Maine. The full outlines are 300 zones of 1,441 positions each.
  it("gives a basemap of dense zones on the two sides of the antimeridian at less than 1/20 of the full outlines (AL-176)", async () => {
    const zones = new Map<string, MapRegion>();
    for (let at = 0; at < 300; at += 1) {
      const lon = at < 5 ? 144 + at : -170 + (at - 5) * 0.35;
      const lat = 30 + (at % 15);
      const ring: [number, number][] = [];
      for (let step = 0; step <= 1440; step += 1) {
        const angle = (step / 1440) * 2 * Math.PI;
        ring.push([lon + 0.15 * Math.cos(angle), lat + 0.1 * Math.sin(angle)]);
      }
      ring[1440] = ring[0]!;
      const id = `KSZ${String(at).padStart(3, "0")}`;
      zones.set(id, { code: { system: "ugc", code: id }, name: `Zone ${String(at)}`, shapes: [{ type: "polygon", rings: [ring] }] });
    }
    const fake = fakeStore([]);
    const store: ShapeStore = { ...fake.store, lookup: (code) => zones.get(code.code)?.shapes, region: (code) => zones.get(code.code) };
    const keeper = keepShapes({ store, places: [TEXAS] });
    keeper.afterPass([incident("a", [...zones.keys()].map((code) => ({ system: "ugc", code })))], undefined);
    const map = keeper.basemap();
    expect(map).toHaveLength(300);
    const full = JSON.stringify([...zones.values()]).length;
    expect(JSON.stringify(map).length).toBeLessThan(full / 20);
    // Each incident on the map draws the simplified zone.
    for (const region of map) expect(keeper.display(region.code)).toBe(region.shapes);
    await keeper.close();
  });

  it("gives the full outlines and reports the error one time when the simplification throws", async () => {
    // The ring is not closed, thus geo refuses it.
    const open: MapRegion = { code: { system: "ugc", code: "KSC079" }, name: "Harvey", shapes: [{ type: "polygon", rings: [[[-98, 37], [-97, 37], [-97, 38], [-98, 38]]] }] };
    const fake = fakeStore([], { KS: [open] });
    const outcomes: ShapeOutcome[] = [];
    const keeper = keepShapes({ store: fake.store, places: [KANSAS], onShapes: (outcome) => outcomes.push(outcome) });
    expect(keeper.basemap()).toEqual([open]);
    expect(keeper.basemap()[0]).toBe(open);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ ok: false, step: "basemap" });
    expect(shapeReport(outcomes[0]!)).toMatch(/^The simplification of the basemap threw, thus the map has the full outlines: .*linear ring/);
    await keeper.close();
  });

  it("stops the refresh at the close, closes the cache after its end, and starts no refresh after the close", async () => {
    const fake = fakeStore([]);
    const outcomes: unknown[] = [];
    const order: string[] = [];
    const keeper = keepShapes({ store: fake.store, places: [KANSAS], onShapes: (outcome) => outcomes.push(outcome), close: () => order.push("cache") });
    keeper.afterPass([], T0);
    const closed = keeper.close().then(() => order.push("closed"));
    await closed;
    expect(fake.calls[0]?.signal?.aborted).toBe(true);
    expect(order).toEqual(["cache", "closed"]);
    // The abort of the close is not a fault.
    expect(outcomes).toEqual([]);
    keeper.afterPass([], T0);
    expect(fake.calls).toHaveLength(1);
    await keeper.close();
    expect(order).toEqual(["cache", "closed"]);
  });
});
