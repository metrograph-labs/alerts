import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import type { Area, Incident, RegionCode, ReportId } from "./contracts.ts";
import { MAP_FORMAT, mapPayload, type MapPayload, type MapPlaceInput, type MapRegion, type MapShape, type ShapeLookup } from "./map.ts";
import { NOT_A_MAP, packMap, unpackMap } from "./map-wire.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const AT = Date.parse("2026-11-26T18:00:00Z");

const square = (lon: number, lat: number, points = 4): MapShape => ({
  type: "polygon",
  rings: [[...Array.from({ length: points }, (_, at) => [lon + 0.1 * Math.cos((at * 2 * Math.PI) / points), lat + 0.1 * Math.sin((at * 2 * Math.PI) / points)] as const), [lon + 0.1, lat]]],
});

// Ten neutral zones of Kansas, each with an outline of 200 points.
const ZONES: readonly RegionCode[] = Array.from({ length: 10 }, (_, at) => ({ system: "ugc", code: `KSZ${String(80 + at).padStart(3, "0")}` }));
const OUTLINES = new Map(ZONES.map((code, at) => [code.code, [square(-98 + 0.3 * at, 38, 200)]]));
const shape: ShapeLookup = (code) => OUTLINES.get(code.code);
const BASEMAP: readonly MapRegion[] = ZONES.map((code) => ({ code, name: `Zone ${code.code}`, shapes: shape(code) ?? [] }));
const PLACES: readonly MapPlaceInput[] = [{ id: "place:a" as MapPlaceInput["id"], label: "Place A", codes: [ZONES[2]!], bufferKm: 0 }];

function incident(anchor: string, areas: readonly Area[]): Incident {
  const id = anchor.padEnd(64, "0") as ReportId;
  return { anchor: id, reports: [id], status: "actual", kind: { code: "met.wind", label: "Wind Advisory" }, severity: "moderate", urgency: "expected", certainty: "likely", areas, about: [], live: true, corroboration: 1 };
}

function payloadOf(incidents: readonly Incident[]): MapPayload {
  return mapPayload({ at: AT, incidents, people: [], places: PLACES, coverage: [], shape, basemap: BASEMAP });
}

// Each seed gives incidents over a random part of the zones, and some polygons that two messages repeat by value.
function seeded(seed: number): MapPayload {
  const r = random(seed);
  const incidents = Array.from({ length: r.int(1, 30) }, (_, at) => {
    const codes = r.sample(ZONES, r.int(1, ZONES.length)).map((code): Area => ({ type: "code", ...code }));
    const own: Area[] = r.int(0, 2) === 0 ? [square(-97, 37 + r.int(0, 2) / 10)] : [];
    return incident(`i${String(at)}`, [...own, ...codes]);
  });
  return payloadOf(incidents);
}

const bytes = (value: unknown): number => JSON.stringify(value).length;

describe("the wire form of the map (AL-214)", () => {
  it("gives back the same payload after a pack and a JSON copy, for each seed", () => {
    for (const seed of SEEDS) {
      const payload = seeded(seed);
      const wire = JSON.parse(JSON.stringify(packMap(payload))) as unknown;
      expect(unpackMap(wire), `seed ${String(seed)}`).toEqual({ ok: true, payload });
    }
  });

  it("keeps each distinct shape one time, by reference and by value", () => {
    for (const seed of SEEDS) {
      const payload = seeded(seed);
      const wire = packMap(payload);
      const texts = wire.shapes.map((one) => JSON.stringify(one));
      expect(new Set(texts).size, `seed ${String(seed)}`).toBe(texts.length);
      const used = [...payload.basemap.flatMap((region) => region.shapes), ...payload.view.incidents.flatMap((one) => one.shapes), ...payload.view.places.flatMap((one) => one.shapes)];
      expect(new Set(used.map((one) => JSON.stringify(one)))).toEqual(new Set(texts));
    }
  });

  it("gives one object to each user of a shape after the unpack", () => {
    const payload = payloadOf([incident("a", [{ type: "code", ...ZONES[2]! }]), incident("b", [{ type: "code", ...ZONES[2]! }])]);
    const read = unpackMap(JSON.parse(JSON.stringify(packMap(payload))));
    if (!read.ok) throw new Error(read.problem);
    const [a, b] = read.payload.view.incidents;
    expect(a?.shapes[0]).toBe(b?.shapes[0]);
    expect(a?.shapes[0]).toBe(read.payload.basemap[2]?.shapes[0]);
    expect(a?.shapes[0]).toBe(read.payload.view.places[0]?.shapes[0]);
  });

  it("holds the size: 30 incidents over the 10 zones of the basemap add only their fields, not their outlines", () => {
    const incidents = Array.from({ length: 30 }, (_, at) => incident(`i${String(at)}`, ZONES.map((code): Area => ({ type: "code", ...code }))));
    const payload = payloadOf(incidents);
    const outlines = bytes([...OUTLINES.values()]);
    expect(bytes(payload)).toBeGreaterThan(30 * outlines);
    expect(bytes(packMap(payload))).toBeLessThan(1.2 * outlines);
  });

  it("tells a format of another version, with the step for the reader", () => {
    const wire = { ...packMap(payloadOf([])), format: "alerts-map/1" };
    expect(unpackMap(wire)).toEqual({ ok: false, problem: `The answer of the runtime has the format alerts-map/1, and this page reads ${MAP_FORMAT}. Start the runtime of the version of this page.` });
    expect(unpackMap({ view: {} })).toEqual({ ok: false, problem: `The answer of the runtime has the format with no name, and this page reads ${MAP_FORMAT}. Start the runtime of the version of this page.` });
  });

  it("refuses a bad table, a bad list, a bad region and each position outside the table", () => {
    const good = JSON.parse(JSON.stringify(packMap(payloadOf([incident("a", [{ type: "code", ...ZONES[0]! }])])))) as Record<string, unknown>;
    expect(unpackMap(good).ok).toBe(true);
    const view = good["view"] as Record<string, unknown>;
    const region = (good["basemap"] as Record<string, unknown>[])[0]!;
    const one = (view["incidents"] as Record<string, unknown>[])[0]!;
    const bad: unknown[] = [
      null,
      [],
      { ...good, shapes: {} },
      { ...good, shapes: [{ type: "code" }] },
      { ...good, view: { ...view, places: {} } },
      { ...good, view: { ...view, unshaped: null } },
      { ...good, basemap: [{ ...region, code: "KSZ080" }] },
      { ...good, basemap: [{ ...region, name: 1 }] },
      ...[[-1], [1.5], ["0"], [(good["shapes"] as unknown[]).length]].map((shapes) => ({ ...good, view: { ...view, incidents: [{ ...one, shapes }] } })),
      { ...good, basemap: [{ ...region, shapes: [99] }] },
    ];
    for (const value of bad) expect(unpackMap(value), JSON.stringify(value).slice(0, 120)).toEqual({ ok: false, problem: NOT_A_MAP });
  });
});
