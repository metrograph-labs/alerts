import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { knownKind } from "@mark1russell7/alerts";

import { GEOMAGNETIC_STORM_KIND, geomagneticLevel, KP_MAX, kpText, RADIO_BLACKOUT_KIND, SEVERITY_BY_LEVEL, SOLAR_RADIATION_STORM_KIND, SPACE_WEATHER_KIND, thirdsText } from "./index.ts";

// Each value of Kp in thirds, as GFZ writes it, with its text and its level of the scale G from the NOAA table.
const TABLE: readonly (readonly [number, string, number])[] = [
  [0, "0", 0],
  [0.333, "0+", 0],
  [0.667, "1-", 0],
  [4, "4", 0],
  [4.333, "4+", 0],
  [4.667, "5-", 1],
  [5, "5", 1],
  [5.333, "5+", 1],
  [5.667, "6-", 2],
  [6.333, "6+", 2],
  [6.667, "7-", 3],
  [7.333, "7+", 3],
  [7.667, "8-", 4],
  [8, "8", 4],
  [8.333, "8+", 4],
  [8.667, "9-", 4],
  [9, "9", 5],
];

describe("the scale G from the index Kp", () => {
  it("gives the level of the NOAA table for each third", () => {
    for (const [kp, text, level] of TABLE) {
      expect(geomagneticLevel(kp), text).toBe(level);
      expect(kpText(kp), String(kp)).toBe(text);
    }
  });

  it("puts 9- in G4, as the table says", () => {
    expect(geomagneticLevel(26 / 3)).toBe(4);
    expect(geomagneticLevel(27 / 3)).toBe(5);
  });

  it("gives the text of each third with no upper limit for the indices Hp30 and Hp60", () => {
    for (const [kp, text] of TABLE) expect(thirdsText(kp), String(kp)).toBe(text);
    expect(thirdsText(9.333)).toBe("9+");
    expect(thirdsText(11.333)).toBe("11+");
    expect(thirdsText(11.667)).toBe("12-");
    for (const value of [-0.333, Number.NaN, Number.POSITIVE_INFINITY]) expect(thirdsText(value), String(value)).toBeUndefined();
  });

  it("gives no level for a value out of range", () => {
    for (const kp of [-0.333, 9.333, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(geomagneticLevel(kp), String(kp)).toBeUndefined();
      expect(kpText(kp), String(kp)).toBeUndefined();
    }
  });

  it("never gives a lower level for a higher value", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: KP_MAX, noNaN: true }), fc.double({ min: 0, max: KP_MAX, noNaN: true }), (a, b) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        expect(geomagneticLevel(low)!).toBeLessThanOrEqual(geomagneticLevel(high)!);
      }),
    );
  });
});

describe("the kinds and the severities", () => {
  it("names only kinds of the taxonomy", () => {
    for (const kind of [SPACE_WEATHER_KIND, GEOMAGNETIC_STORM_KIND, RADIO_BLACKOUT_KIND, SOLAR_RADIATION_STORM_KIND]) expect(knownKind(kind), kind).toBe(true);
  });

  it("gives a severity to each level from 0 to 5", () => {
    expect(SEVERITY_BY_LEVEL).toEqual(["minor", "minor", "moderate", "moderate", "severe", "extreme"]);
  });
});
