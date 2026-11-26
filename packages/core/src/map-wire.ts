/**
 * The wire form of the map payload (AL-214). Many incidents of one area have the same region shapes, and the basemap has
 * them too. The wire form keeps each distinct shape one time, in a table. Each incident, place and region gives the
 * positions of its shapes in that table. The page unpacks the wire form into the same `MapPayload` that the runtime packed.
 */
import { canonicalJson } from "@mark1russell7/rigor-generators";
import { isRecord } from "@mark1russell7/optional/read";
import type { RegionCode } from "./contracts.ts";
import { MAP_FORMAT, type MapIncident, type MapPayload, type MapPlace, type MapRegion, type MapShape } from "./map.ts";

/** The positions of shapes in the table of the wire form. */
export type ShapeRefs = readonly number[];

/** An incident of the wire form: the incident of the map, with the positions of its shapes. */
export interface MapWireIncident extends Omit<MapIncident, "shapes"> {
  readonly shapes: ShapeRefs;
}

/** A place of the wire form: the place of the map, with the positions of its shapes. */
export interface MapWirePlace extends Omit<MapPlace, "shapes"> {
  readonly shapes: ShapeRefs;
}

/** A region of the basemap in the wire form: the region, with the positions of its shapes. */
export interface MapWireRegion extends Omit<MapRegion, "shapes"> {
  readonly shapes: ShapeRefs;
}

/** The answer of the map route: the payload of the map, with one table of its distinct shapes. */
export interface MapWire extends Omit<MapPayload, "view" | "basemap"> {
  /** Each distinct shape of the payload one time: first the shapes of the basemap, then of the incidents, then of the places. */
  readonly shapes: readonly MapShape[];
  readonly view: {
    readonly incidents: readonly MapWireIncident[];
    readonly places: readonly MapWirePlace[];
    readonly unshaped: readonly RegionCode[];
  };
  readonly basemap: readonly MapWireRegion[];
}

/**
 * This function gives the wire form of a map payload. Two shapes are equal by reference or by value. Thus the store, the
 * keeper of the simplified shapes and two equal polygons of two messages each give one entry of the table.
 */
export function packMap(payload: MapPayload): MapWire {
  const shapes: MapShape[] = [];
  const byReference = new Map<MapShape, number>();
  const byText = new Map<string, number>();
  const refOf = (shape: MapShape): number => {
    const known = byReference.get(shape);
    if (known !== undefined) return known;
    const text = canonicalJson(shape, { form: "json" });
    let at = byText.get(text);
    if (at === undefined) {
      at = shapes.length;
      shapes.push(shape);
      byText.set(text, at);
    }
    byReference.set(shape, at);
    return at;
  };
  const refs = (list: readonly MapShape[]): number[] => list.map(refOf);
  const basemap = payload.basemap.map((region): MapWireRegion => ({ ...region, shapes: refs(region.shapes) }));
  const incidents = payload.view.incidents.map((incident): MapWireIncident => ({ ...incident, shapes: refs(incident.shapes) }));
  const places = payload.view.places.map((place): MapWirePlace => ({ ...place, shapes: refs(place.shapes) }));
  return { ...payload, shapes, view: { ...payload.view, incidents, places }, basemap };
}

/** The result of an unpack: the payload of the map, or the words of the problem. */
export type MapUnpack = { readonly ok: true; readonly payload: MapPayload } | { readonly ok: false; readonly problem: string };

/** The words of an answer that is not a map of the wire form. */
export const NOT_A_MAP = "The answer of the runtime is not a map.";

const isCode = (value: unknown): boolean => isRecord(value) && typeof value["system"] === "string" && typeof value["code"] === "string";
const isShape = (value: unknown): boolean => isRecord(value) && (value["type"] === "polygon" || value["type"] === "circle");
const hasRefs = (value: unknown, count: number): boolean =>
  isRecord(value) && Array.isArray(value["shapes"]) && value["shapes"].every((at: unknown) => Number.isInteger(at) && (at as number) >= 0 && (at as number) < count);

/**
 * This function gives the map payload of a wire form, or the problem. It examines the format, the lists, each region and
 * each position of a shape. The runtime of the same version writes the answer on the same computer, thus it does not examine
 * each point of a shape. Each shape of the payload is the object of the table, so the payload holds each shape one time.
 */
export function unpackMap(value: unknown): MapUnpack {
  if (!isRecord(value)) return { ok: false, problem: NOT_A_MAP };
  if (value["format"] !== MAP_FORMAT) {
    const format = typeof value["format"] === "string" ? value["format"] : "with no name";
    return { ok: false, problem: `The answer of the runtime has the format ${format}, and this page reads ${MAP_FORMAT}. Start the runtime of the version of this page.` };
  }
  const table = value["shapes"];
  const view = value["view"];
  const basemap = value["basemap"];
  if (!Array.isArray(table) || !table.every(isShape) || !isRecord(view) || !Array.isArray(basemap)) return { ok: false, problem: NOT_A_MAP };
  const incidents = view["incidents"];
  const places = view["places"];
  if (!Array.isArray(incidents) || !Array.isArray(places) || !Array.isArray(view["unshaped"])) return { ok: false, problem: NOT_A_MAP };
  const count = table.length;
  const regionsGood = basemap.every((region: unknown) => isRecord(region) && isCode(region["code"]) && typeof region["name"] === "string" && hasRefs(region, count));
  if (!regionsGood || !incidents.every((one: unknown) => hasRefs(one, count)) || !places.every((one: unknown) => hasRefs(one, count))) return { ok: false, problem: NOT_A_MAP };
  const shapes = table as readonly MapShape[];
  const wire = value as unknown as MapWire;
  const of = (refs: ShapeRefs): MapShape[] => refs.map((at) => shapes[at]!);
  const { shapes: _table, ...rest } = wire;
  const payload: MapPayload = {
    ...rest,
    view: {
      ...wire.view,
      incidents: wire.view.incidents.map((incident): MapIncident => ({ ...incident, shapes: of(incident.shapes) })),
      places: wire.view.places.map((place): MapPlace => ({ ...place, shapes: of(place.shapes) })),
    },
    basemap: wire.basemap.map((region): MapRegion => ({ ...region, shapes: of(region.shapes) })),
  };
  return { ok: true, payload };
}
