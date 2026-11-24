import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import { assess, DEFAULT_ASSESS_POLICY, reachedAssessment } from "./assess.ts";
import type { IndicatorBreadth } from "./breadth.ts";
import type { Area, AssessedLevel, Assessment, Coverage, Estimate, Incident, PersonId, PersonWatch, PlaceId, RegionCode, ReportId, ScorePriors, Severity } from "./contracts.ts";
import { MAP_FORMAT, mapPayload, mapView, regionRank, type MapInput, type MapPayloadInput, type MapPlaceInput, type MapRegion, type MapShape, type ShapeLookup } from "./map.ts";
import { PRIORS_FORMAT, shadowScore } from "./score.ts";
import { indicatorSurprise } from "./threat.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const PERSON_A = "person:a" as PersonId;
const PERSON_B = "person:b" as PersonId;
const PLACE_A = "place:a" as PlaceId;
const PLACE_B = "place:b" as PlaceId;

const zone: RegionCode = { system: "ugc", code: "KSZ083" };
const county: RegionCode = { system: "ugc", code: "KSC173" };
const state: RegionCode = { system: "state", code: "KS" };
const square = (lon: number, lat: number): MapShape => ({
  type: "polygon",
  rings: [[[lon, lat], [lon + 0.1, lat], [lon + 0.1, lat + 0.1], [lon, lat + 0.1], [lon, lat]]],
});

// A store of shapes with a zone, a county and the state of Kansas. Each other code has no shape.
const SHAPES = new Map<string, readonly MapShape[]>([
  ["ugc KSZ083", [square(-97.5, 37.6)]],
  ["ugc KSC173", [square(-97.6, 37.5), square(-97.2, 37.5)]],
  ["state KS", [square(-102, 37)]],
]);
const shape: ShapeLookup = (code) => SHAPES.get(`${code.system} ${code.code}`);

// Public places in Kansas and Texas, with made-up labels.
const kansas: MapPlaceInput = { id: PLACE_A, label: "Place A", codes: [state, county, zone], bufferKm: 0 };
const texas: MapPlaceInput = { id: PLACE_B, label: "Place B", at: [-98.49, 29.42], codes: [{ system: "same", code: "048029" }], bufferKm: 5 };

function incident(anchor: string, fields: Partial<Incident> = {}): Incident {
  return {
    anchor: anchor.padEnd(64, "0") as ReportId,
    reports: [anchor.padEnd(64, "0") as ReportId],
    status: "actual",
    kind: { code: "met.tornado", label: "Tornado Warning" },
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    areas: [{ type: "code", ...zone }],
    about: [],
    live: true,
    corroboration: 1,
    ...fields,
  };
}

function assessment(of: Incident, level: AssessedLevel, places: readonly PlaceId[] = [], person: PersonId = PERSON_A): Assessment {
  return { incident: of.anchor, person, level, places, reasons: [] };
}

function gap(place: PlaceId, kind: string, short: boolean): Coverage {
  return { place, kind, sources: [], independent: short ? 1 : 2, required: 2, proven: true, faults: [], commonResources: [] };
}

const input = (fields: Partial<MapInput>): MapInput => ({ incidents: [], assessments: [], places: [kansas, texas], coverage: [], shape, ...fields });

describe("regionRank", () => {
  it("puts a zone before a county, a county before a state, and a state before a country", () => {
    const codes: RegionCode[] = [{ system: "iso3166", code: "US" }, state, { system: "same", code: "020173" }, county, zone, { system: "other", code: "x" }];
    expect(codes.map(regionRank)).toEqual([3, 2, 1, 1, 0, 4]);
    expect(regionRank({ system: "ugc-fire", code: "KSZ083" })).toBe(0);
  });
});

describe("the incidents of the map", () => {
  it("keep each polygon and circle, give the shapes of each code, and list each code with no shape", () => {
    const circle: Area = { type: "circle", center: [-97.3, 37.7], radiusKm: 10 };
    const unknown: RegionCode = { system: "ugc", code: "KSZ999" };
    const view = mapView(input({ incidents: [incident("a", { areas: [square(-97, 38), circle, { type: "code", ...county }, { type: "code", ...unknown }, { type: "place", place: PLACE_B }] })] }));
    const [only] = view.incidents;
    expect(only?.shapes).toEqual([square(-97, 38), circle, ...(SHAPES.get("ugc KSC173") ?? [])]);
    expect(only?.unshaped).toEqual([unknown]);
    expect(view.unshaped).toEqual([unknown]);
    // The county covers place A, and the area of place B names place B.
    expect(only?.places).toEqual([PLACE_A, PLACE_B]);
  });

  it("give each shape one time when a zone and its county give the same outline, in the order of the first", () => {
    const outline = square(-97.5, 37.6);
    const other = square(-97.2, 37.5);
    // The store gives the zone and the county one shape: the same object, and a copy with equal values.
    const store: ShapeLookup = (code) => (code.code === "KSZ083" ? [outline] : code.code === "KSC173" ? [outline, structuredClone(outline), other] : undefined);
    const areas: Area[] = [{ type: "code", ...zone }, { type: "code", ...county }, structuredClone(other)];
    const view = mapView(input({ incidents: [incident("a", { areas })], shape: store }));
    expect(view.incidents[0]?.shapes).toEqual([outline, other]);
    expect(view.incidents[0]?.shapes[0]).toBe(outline);
    // The flip: two different outlines both stay.
    const apart: ShapeLookup = (code) => (code.code === "KSZ083" ? [outline] : code.code === "KSC173" ? [other] : undefined);
    expect(mapView(input({ incidents: [incident("a", { areas: areas.slice(0, 2) })], shape: apart })).incidents[0]?.shapes).toEqual([outline, other]);
  });

  it("keep the status of each incident, thus a test does not look like a real alert", () => {
    const view = mapView(input({ incidents: [incident("a"), incident("b", { status: "test" }), incident("c", { status: "exercise" })] }));
    expect(view.incidents.map((entry) => [entry.anchor[0], entry.status])).toEqual([
      ["a", "actual"],
      ["b", "test"],
      ["c", "exercise"],
    ]);
  });

  it("drop each incident that ended", () => {
    const view = mapView(input({ incidents: [incident("a", { live: false }), incident("b")] }));
    expect(view.incidents.map((entry) => entry.anchor[0])).toEqual(["b"]);
  });

  it("take the highest level over each person, and none with no assessment", () => {
    const [a, b] = [incident("a"), incident("b")];
    const view = mapView(input({ incidents: [a, b], assessments: [assessment(a, "notice"), assessment(a, "urgent", [], PERSON_B), assessment(a, "none")] }));
    expect(view.incidents.map((entry) => [entry.anchor[0], entry.level])).toEqual([
      ["a", "urgent"],
      ["b", "none"],
    ]);
  });

  it("go from the highest level, then from the highest severity, then by the anchor", () => {
    const severities: Severity[] = ["minor", "extreme", "unknown", "severe"];
    const incidents = [...severities.map((severity, index) => incident(`s${"abcd"[index]}`, { severity })), incident("t"), incident("u")];
    const [top] = incidents.slice(-1);
    const view = mapView(input({ incidents, assessments: top === undefined ? [] : [assessment(top, "life-safety")] }));
    expect(view.incidents.map((entry) => entry.anchor.replace(/0+$/, ""))).toEqual(["u", "sb", "t", "sd", "sa", "sc"]);
  });

  it("list each code with no shape once, in the order of the system and the code", () => {
    const codes: RegionCode[] = [{ system: "ugc", code: "KSZ998" }, { system: "same", code: "020999" }, { system: "ugc", code: "KSZ997" }];
    const areas = codes.map((code): Area => ({ type: "code", ...code }));
    const view = mapView(input({ incidents: [incident("a", { areas }), incident("b", { areas: areas.slice(0, 1) })] }));
    expect(view.unshaped).toEqual([codes[1], codes[2], codes[0]]);
  });
});

describe("the places of the map", () => {
  it("give the shapes of the smallest region with a shape, and keep the position", () => {
    const view = mapView(input({}));
    expect(view.places.map((place) => place.shapes)).toEqual([SHAPES.get("ugc KSZ083"), []]);
    expect(view.places[1]?.at).toEqual(texas.at);
    // With no zone in the store, the county is the smallest region with a shape.
    const noZone: ShapeLookup = (code) => (code.code === "KSZ083" ? undefined : shape(code));
    expect(mapView(input({ shape: noZone })).places[0]?.shapes).toEqual(SHAPES.get("ugc KSC173"));
  });

  it("take the highest level of the assessments at the place, and list its live incidents in the order of the view", () => {
    const [a, b, c] = [incident("a"), incident("b"), incident("c", { live: false })];
    const view = mapView(input({ incidents: [a, b, c], assessments: [assessment(a, "notice", [PLACE_A]), assessment(b, "life-safety", [PLACE_A], PERSON_B)] }));
    const [first, second] = view.places;
    expect(first?.level).toBe("life-safety");
    expect(first?.incidents.map((anchor) => anchor[0])).toEqual(["b", "a"]);
    expect(second?.level).toBe("none");
    expect(second?.incidents).toEqual([]);
  });

  it("list each kind with a short coverage at the place, once", () => {
    const coverage = [gap(PLACE_A, "met.tornado", true), gap(PLACE_A, "geo.earthquake", true), gap(PLACE_A, "met.flood", false), gap(PLACE_B, "met.tornado", true), gap(PLACE_A, "met.tornado", true)];
    const view = mapView(input({ coverage }));
    expect(view.places.map((place) => place.gaps)).toEqual([["geo.earthquake", "met.tornado"], ["met.tornado"]]);
  });
});

describe("the order of the input", () => {
  it.each(SEEDS)("does not change the view (seed %i)", (seed) => {
    const r = random(seed);
    const levels: AssessedLevel[] = ["none", "digest", "notice", "urgent", "life-safety"];
    const severities: Severity[] = ["extreme", "severe", "moderate", "minor", "unknown"];
    const codes: RegionCode[] = [zone, county, state, { system: "ugc", code: "KSZ998" }];
    const incidents = Array.from({ length: 12 }, (_, index) =>
      incident(`i${index.toString(16)}`, {
        severity: r.pick(severities),
        live: r.int(0, 4) > 0,
        areas: r.sample(codes, r.int(1, codes.length)).map((code): Area => ({ type: "code", ...code })),
      }),
    );
    const assessments = incidents.flatMap((entry) => (r.int(0, 2) > 0 ? [assessment(entry, r.pick(levels), r.int(0, 1) > 0 ? [PLACE_A] : [], r.pick([PERSON_A, PERSON_B]))] : []));
    const view = mapView(input({ incidents, assessments }));
    const shuffled = mapView(input({ incidents: r.shuffle([...incidents]), assessments: r.shuffle([...assessments]) }));
    expect(shuffled).toEqual(view);
  });
});

describe("the payload of the map route", () => {
  const AT = Date.parse("2026-11-16T12:00:00Z");
  const people: PersonWatch[] = [
    { person: PERSON_A, places: [PLACE_A], rules: [] },
    { person: PERSON_B, places: [PLACE_B], rules: [] },
  ];
  const basemap: MapRegion[] = [{ code: zone, name: "Zone", shapes: SHAPES.get("ugc KSZ083") ?? [] }];
  const payloadInput = (fields: Partial<MapPayloadInput> = {}): MapPayloadInput => ({ at: AT, incidents: [], places: [kansas, texas], coverage: [], shape, people, basemap, ...fields });
  // The assessments of the delivery: each live incident for each person, at the time of the view.
  const assessed = (incidents: readonly Incident[]): Assessment[] =>
    incidents.filter((entry) => entry.live).flatMap((entry) => people.map((person) => reachedAssessment(assess(entry, person, [kansas, texas], DEFAULT_ASSESS_POLICY, AT))));

  it("carries the format, the time of the view and the basemap", () => {
    const payload = mapPayload(payloadInput());
    expect([payload.format, payload.at, payload.basemap]).toEqual([MAP_FORMAT, AT, basemap]);
    expect(mapPayload(payloadInput({ at: null })).at).toBeNull();
  });

  it("carries the breadth of the indicator signals, and has no field without it", () => {
    const breadth: IndicatorBreadth = {
      world: { signals: ["grid-frequency"], read: ["grid-frequency"], dimensions: [{ dimension: "grid-frequency", read: 1, signals: 1, noRead: 0 }] },
      places: [
        { place: PLACE_A, signals: [], read: [], dimensions: [] },
        { place: PLACE_B, signals: [], read: [], dimensions: [] },
      ],
      unplaced: [],
    };
    expect(mapPayload(payloadInput({ breadth })).breadth).toEqual(breadth);
    expect("breadth" in mapPayload(payloadInput())).toBe(false);
    // The surprise of the signals (AL-24) goes next to the breadth. Without it, the payload has no field.
    const surprise = indicatorSurprise(breadth, [{ unit: "world/grid-frequency", reads: 100, signals: 1 }]);
    expect(mapPayload(payloadInput({ breadth, surprise })).surprise).toEqual(surprise);
    expect("surprise" in mapPayload(payloadInput({ breadth }))).toBe(false);
  });

  it("shows no private incident, also to a person of its addresses (AL-92)", () => {
    const shown = incident("a");
    const hidden = incident("b", { addresses: [PERSON_A] });
    const payload = mapPayload(payloadInput({ incidents: [shown, hidden] }));
    expect(payload.view.incidents.map((one) => one.anchor)).toEqual([shown.anchor]);
    expect(mapPayload(payloadInput({ incidents: [hidden] })).view.incidents).toEqual([]);
  });

  it("gives the level that the delivery gives the person", () => {
    const tornado = incident("a");
    const payload = mapPayload(payloadInput({ incidents: [tornado] }));
    const [only] = payload.view.incidents;
    // The zone covers place A of person A. Place B of person B is in Texas.
    expect(only?.level).toBe(assess(tornado, people[0]!, [kansas, texas], DEFAULT_ASSESS_POLICY, AT).level);
    expect(only?.level).not.toBe("none");
    expect(payload.view.places.map((place) => [place.id, place.level === "none"])).toEqual([
      [PLACE_A, false],
      [PLACE_B, true],
    ]);
  });

  it.each(SEEDS)("gives the view of the assessments of each person (seed %i)", (seed) => {
    const r = random(seed);
    const severities: Severity[] = ["extreme", "severe", "moderate", "minor", "unknown"];
    const codes: RegionCode[] = [zone, county, state, { system: "same", code: "048029" }, { system: "ugc", code: "KSZ998" }];
    const incidents = Array.from({ length: 10 }, (_, index) =>
      incident(`p${index.toString(16)}`, {
        severity: r.pick(severities),
        live: r.int(0, 3) > 0,
        areas: r.sample(codes, r.int(1, codes.length)).map((code): Area => ({ type: "code", ...code })),
      }),
    );
    const payload = mapPayload(payloadInput({ incidents }));
    expect(payload.view).toEqual(mapView(input({ incidents, assessments: assessed(incidents) })));
  });

  it("gives the shadow score of each incident that reaches a person, and the score changes nothing else", () => {
    // Made-up values. They are not the public measures.
    const estimate = (value: number, low: number, high: number): Estimate => ({ value, low, high });
    const priors: ScorePriors = {
      format: PRIORS_FORMAT,
      kinds: { "met.tornado": { deaths: estimate(0.04, 0.03, 0.06), injuries: estimate(0.6, 0.4, 0.9) } },
      certainty: { observed: estimate(1, 1, 1) },
    };
    const near = incident("a");
    const far = incident("b", { areas: [{ type: "code", system: "ugc", code: "OKZ001" }] });
    const ended = incident("c", { live: false });
    const payload = mapPayload(payloadInput({ incidents: [near, far, ended], priors }));
    const byAnchor = new Map(payload.view.incidents.map((entry) => [entry.anchor, entry]));
    expect(byAnchor.get(near.anchor)?.shadow).toEqual(shadowScore(near, priors));
    expect(byAnchor.get(far.anchor)?.level).toBe("none");
    expect(byAnchor.get(far.anchor)).not.toHaveProperty("shadow");
    expect(byAnchor.has(ended.anchor)).toBe(false);
    const plain = mapPayload(payloadInput({ incidents: [near, far, ended] }));
    expect(plain.view.incidents.some((entry) => "shadow" in entry)).toBe(false);
    // `toEqual` reads a field with the value `undefined` as a field that is not there.
    expect({ ...payload, view: { ...payload.view, incidents: payload.view.incidents.map((entry) => ({ ...entry, shadow: undefined })) } }).toEqual(plain);
  });
});

describe("the level that reaches a person", () => {
  const base: Assessment = { incident: "a".padEnd(64, "0") as ReportId, person: PERSON_A, level: "urgent", places: [PLACE_A], reasons: [] };

  it("is none for a mute with the effect absent, and the level for each other assessment", () => {
    expect(reachedAssessment({ ...base, muted: { mute: "m1", effect: "absent" } }).level).toBe("none");
    expect(reachedAssessment({ ...base, muted: { mute: "m1", effect: "silent" } })).toEqual({ ...base, muted: { mute: "m1", effect: "silent" } });
    expect(reachedAssessment(base)).toBe(base);
  });
});
