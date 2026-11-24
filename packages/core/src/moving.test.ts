import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import type { PlaceConfig } from "./config.ts";
import type { PlaceId, Position, RegionCode, SourceId } from "./contracts.ts";
import { matchPlaces } from "./assess.ts";
import { FIX_FUTURE_LIMIT_MS, fixAge, fixProblems, movingPlace, movingProblems, placeOfDevice, type PositionFix } from "./moving.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const MINUTE = 60_000;
const NOW = 1_800_000_000_000;
const here = "place-here" as PlaceId;
const STATE: RegionCode = { system: "state", code: "KS" };
const ZONE: RegionCode = { system: "ugc", code: "KSZ083" };
const MOVING: PlaceConfig = { id: here, label: "Here", codes: [STATE], bufferKm: 3, moving: { device: "ph", maxAgeMinutes: 30 } };
const AT: Position = [-97.3, 37.7];

function fix(fields: Partial<PositionFix> = {}): PositionFix {
  return { place: here, at: AT, accuracyKm: 0.5, observedAt: NOW - 5 * MINUTE, ...fields };
}

describe("movingPlace", () => {
  it("gives the place at a fresh fix, with the doubt of the fix added to the buffer", () => {
    expect(movingPlace(MOVING, fix(), NOW, [ZONE])).toEqual({ id: here, at: AT, codes: [ZONE], bufferKm: 3.5 });
  });

  it("gives no place with no fix, with a fix of another place, or for a fixed place", () => {
    expect(movingPlace(MOVING, undefined, NOW, [ZONE])).toBeUndefined();
    expect(movingPlace(MOVING, fix({ place: "place-other" as PlaceId }), NOW, [ZONE])).toBeUndefined();
    const { moving: _, ...fixed } = MOVING;
    expect(movingPlace(fixed, fix(), NOW, [ZONE])).toBeUndefined();
  });

  it("gives no place for a fix older than the age limit, and keeps a fix at the limit", () => {
    expect(movingPlace(MOVING, fix({ observedAt: NOW - 30 * MINUTE }), NOW, [])).toBeDefined();
    expect(movingPlace(MOVING, fix({ observedAt: NOW - 30 * MINUTE - 1 }), NOW, [])).toBeUndefined();
  });

  it("keeps a fix in the future by the drift limit, and refuses a fix after it", () => {
    expect(movingPlace(MOVING, fix({ observedAt: NOW + FIX_FUTURE_LIMIT_MS }), NOW, [])).toBeDefined();
    expect(movingPlace(MOVING, fix({ observedAt: NOW + FIX_FUTURE_LIMIT_MS + 1 }), NOW, [])).toBeUndefined();
    expect(fixAge(fix({ observedAt: NOW + MINUTE }), NOW)).toBe(0);
  });

  it("matches an incident near the fix, and no incident far from it", () => {
    const place = movingPlace(MOVING, fix(), NOW, [])!;
    const near = { areas: [{ type: "circle", center: [AT[0] + 0.03, AT[1]], radiusKm: 0.1 }] } as const;
    const far = { areas: [{ type: "circle", center: [AT[0] + 1, AT[1]], radiusKm: 0.1 }] } as const;
    expect(matchPlaces(near, [place]).map((match) => match.place)).toEqual([here]);
    expect(matchPlaces(far, [place])).toEqual([]);
  });

  it("gives a place exactly when the fix is fresh, with a buffer of the place buffer plus the doubt, over seeded fixes", () => {
    for (const seed of SEEDS) {
      const r = random(`moving-place:${seed}`);
      for (let index = 0; index < 50; index += 1) {
        const maxAgeMinutes = r.int(1, 120);
        const place: PlaceConfig = { ...MOVING, bufferKm: r.below(10), moving: { device: "ph", maxAgeMinutes } };
        const reading = fix({ accuracyKm: r.below(5), observedAt: NOW - r.range(-2 * MINUTE, 240 * MINUTE) });
        const result = movingPlace(place, reading, NOW, [ZONE]);
        const fresh = NOW - reading.observedAt <= maxAgeMinutes * MINUTE && reading.observedAt - NOW <= FIX_FUTURE_LIMIT_MS;
        expect(result !== undefined, `seed ${seed}`).toBe(fresh);
        if (result !== undefined) expect(result.bufferKm).toBeCloseTo(place.bufferKm + reading.accuracyKm, 12);
      }
    }
  });
});

describe("fixProblems", () => {
  it("refuses a position out of range, a bad doubt and a bad time, with no position in the text", () => {
    expect(fixProblems(fix())).toEqual([]);
    const problems = [fix({ at: [-200, 37.7] }), fix({ at: [-97.3, Number.NaN] }), fix({ accuracyKm: -1 }), fix({ observedAt: Number.POSITIVE_INFINITY })].map(fixProblems);
    expect(problems.map((list) => list.length)).toEqual([1, 1, 1, 1]);
    for (const text of problems.flat()) expect(text).not.toMatch(/\d+\.\d/);
  });
});

describe("movingProblems", () => {
  it("accepts a moving place with no position and a unique device", () => {
    expect(movingProblems(MOVING, [MOVING])).toEqual([]);
  });

  it("refuses a position, sharePosition, an age limit that is not positive, an empty device and a shared device", () => {
    const bad: PlaceConfig = { ...MOVING, at: AT, sharePosition: ["nws" as SourceId], moving: { device: " ", maxAgeMinutes: 0 } };
    expect(movingProblems(bad, [bad])).toHaveLength(4);
    const twin: PlaceConfig = { ...MOVING, id: "place-twin" as PlaceId };
    expect(movingProblems(twin, [MOVING, twin])).toEqual([`The moving places ${here} and place-twin have one device.`]);
    expect(movingProblems(MOVING, [MOVING, twin])).toEqual([]);
  });

  it("finds the place of a device", () => {
    expect(placeOfDevice([MOVING], "ph")?.id).toBe(here);
    expect(placeOfDevice([MOVING], "other")).toBeUndefined();
  });
});
