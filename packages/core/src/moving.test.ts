import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import type { PlaceConfig } from "./config.ts";
import type { PlaceId, Position, RegionCode, SourceId } from "./contracts.ts";
import { matchPlaces } from "./assess.ts";
import { DEFAULT_MAX_ACCURACY_KM, FIX_FUTURE_LIMIT_MS, fixAge, fixProblems, movingPlace, movingProblems, nextFix, passPlaces, placeOfDevice, type PositionFix, staleMovingPlaces } from "./moving.ts";
import type { AlertConfig } from "./config.ts";

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

describe("nextFix", () => {
  it("keeps a good newer fix, and keeps the last fix for a problem, a doubt over the limit and an older time", () => {
    const last = fix();
    expect(nextFix(MOVING, last, fix({ observedAt: NOW }))).toEqual({ fix: fix({ observedAt: NOW }) });
    expect(nextFix(MOVING, undefined, fix())).toEqual({ fix: fix() });
    expect(nextFix(MOVING, last, fix({ observedAt: NOW, at: [0, 99] }))).toEqual({ fix: last, refused: "problems" });
    expect(nextFix(MOVING, last, fix({ observedAt: NOW, accuracyKm: DEFAULT_MAX_ACCURACY_KM + 0.1 }))).toEqual({ fix: last, refused: "accuracy" });
    expect(nextFix(MOVING, last, fix({ observedAt: last.observedAt }))).toEqual({ fix: last, refused: "older" });
  });

  it("uses the accuracy limit of the place before the default", () => {
    const wide: PlaceConfig = { ...MOVING, moving: { device: "ph", maxAgeMinutes: 30, maxAccuracyKm: 10 } };
    expect(nextFix(wide, undefined, fix({ accuracyKm: 8 })).refused).toBeUndefined();
    expect(nextFix(wide, undefined, fix({ accuracyKm: 11 })).refused).toBe("accuracy");
    expect(movingProblems({ ...wide, moving: { device: "ph", maxAgeMinutes: 30, maxAccuracyKm: 0 } }, [wide])).toEqual([`The moving place ${here} has no positive accuracy limit.`]);
  });
});

describe("passPlaces", () => {
  const fixed: PlaceConfig = { id: "place-home" as PlaceId, label: "Home", at: [-95.7, 39.0], codes: [ZONE], bufferKm: 2 };
  const config = { places: [fixed, MOVING] } as unknown as AlertConfig;

  it("gives the fixed places, then each moving place at a fresh fix with the codes at the fix", () => {
    const codesAt = (_place: PlaceConfig, at: Position): readonly RegionCode[] => (at === AT ? [ZONE] : []);
    expect(passPlaces(config, new Map([[here, fix()]]), NOW, codesAt).map((place) => [place.id, place.codes])).toEqual([
      [fixed.id, [ZONE]],
      [here, [ZONE]],
    ]);
  });

  it("leaves out a moving place with a stale, future or missing fix, and tells it as stale", () => {
    const none = (): readonly RegionCode[] => [];
    for (const fixes of [new Map(), new Map([[here, fix({ observedAt: NOW - 31 * MINUTE })]]), new Map([[here, fix({ observedAt: NOW + 2 * MINUTE })]])]) {
      expect(passPlaces(config, fixes, NOW, none).map((place) => place.id)).toEqual([fixed.id]);
      expect(staleMovingPlaces(config, fixes, NOW)).toEqual([here]);
    }
    expect(staleMovingPlaces(config, new Map([[here, fix()]]), NOW)).toEqual([]);
  });
});
