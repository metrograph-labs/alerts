import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { STATE_FIPS, STATE_POSTAL } from "@mark1russell7/alerts";
import { containingCodes, countyUgcOfSame, FIRE_ZONE_PHENOMENA, isSameCode, isUgcCode, parseSameLocation, sameOfCountyUgc, stateCode, stateOfCode, stateOfSame, stateOfUgc, ugcRegionCodes } from "./codes.ts";

describe("isUgcCode", () => {
  it.each(["KSZ001", "TXC123", "GMZ250", "PKZ414"])("accepts %s", (code) => {
    expect(isUgcCode(code)).toBe(true);
  });

  it.each(["", "ksz001", "KSX001", "KS-Z-001", "KSZ01", "KSZ0011", " KSZ001", "020001"])("refuses %j", (code) => {
    expect(isUgcCode(code)).toBe(false);
  });
});

describe("isSameCode", () => {
  it.each(["020001", "048019", "077250", "199001"])("accepts %s", (code) => {
    expect(isSameCode(code)).toBe(true);
  });

  it.each(["", "48019", "0480190", "04801A", " 048019", "KSZ001"])("refuses %j", (code) => {
    expect(isSameCode(code)).toBe(false);
  });
});

describe("parseSameLocation", () => {
  it("reads the part, the state and the county", () => {
    expect(parseSameLocation("048019")).toEqual({ part: "0", state: "48", county: "019" });
    expect(parseSameLocation(" 320173 ")).toEqual({ part: "3", state: "20", county: "173" });
  });

  it("refuses a text that is not six digits", () => {
    for (const text of ["", "48019", "0480190", "04801a", "TXC019"]) expect(parseSameLocation(text), text).toBeUndefined();
  });
});

describe("the state codes", () => {
  it("give one postal code for each FIPS code, both ways", () => {
    const codes = Object.values(STATE_FIPS);
    expect(new Set(codes).size).toBe(codes.length);
    for (const [postal, fips] of Object.entries(STATE_FIPS)) expect(STATE_POSTAL[fips]).toBe(postal);
  });

  it("have the 50 states, the District of Columbia and 6 territories", () => {
    expect(Object.keys(STATE_FIPS)).toHaveLength(57);
    expect(STATE_FIPS["TX"]).toBe("48");
    expect(STATE_FIPS["KS"]).toBe("20");
  });

  it("give the state of a UGC code, and no state for a marine zone", () => {
    expect(stateOfUgc("KSZ083")).toBe("KS");
    expect(stateOfUgc("txc019")).toBe("TX");
    expect(stateOfUgc("GMZ250")).toBeUndefined();
    expect(stateOfUgc("KS")).toBeUndefined();
  });

  it("give the state of a SAME code, and no state for an unknown FIPS code", () => {
    expect(stateOfSame("020173")).toBe("KS");
    expect(stateOfSame("048000")).toBe("TX");
    expect(stateOfSame("003001")).toBeUndefined();
  });
});

describe("countyUgcOfSame", () => {
  it("gives the county UGC code of a county and of a part of a county", () => {
    expect(countyUgcOfSame("020173")).toBe("KSC173");
    expect(countyUgcOfSame(" 148019 ")).toBe("TXC019");
  });

  it.each(["020000", "003001", "20173", "KSC173", ""])("gives no code for %j", (code) => {
    expect(countyUgcOfSame(code)).toBeUndefined();
  });

  it("is the reverse of sameOfCountyUgc for each county of each state", () => {
    const states = Object.keys(STATE_FIPS);
    const county = fc.integer({ min: 1, max: 999 }).map((value) => String(value).padStart(3, "0"));
    fc.assert(
      fc.property(fc.constantFrom(...states), county, (state, number) => {
        const ugc = `${state}C${number}`;
        expect(countyUgcOfSame(sameOfCountyUgc(ugc) ?? "")).toBe(ugc);
      }),
    );
  });
});

describe("sameOfCountyUgc", () => {
  it("gives the SAME code of the full county", () => {
    expect(sameOfCountyUgc("KSC173")).toBe("020173");
    expect(sameOfCountyUgc("txc019")).toBe("048019");
    expect(stateOfSame(sameOfCountyUgc("TXC463") ?? "")).toBe(stateOfUgc("TXC463"));
  });

  it.each(["KSZ083", "GMZ250", "TXC01", "", "XXC001"])("gives no code for %j", (code) => {
    expect(sameOfCountyUgc(code)).toBeUndefined();
  });
});

describe("stateCode and stateOfCode", () => {
  it("gives the postal code of a state", () => {
    expect(stateCode(" ks ")).toBe("KS");
    expect(stateCode("XX")).toBeUndefined();
    expect(stateCode("toString")).toBeUndefined();
  });

  it("gives the state of a region code at each level, and none for a marine zone or a country", () => {
    expect(stateOfCode({ system: "state", code: "ks" })).toBe("KS");
    expect(stateOfCode({ system: "ugc", code: "KSZ083" })).toBe("KS");
    expect(stateOfCode({ system: "ugc-fire", code: "TXZ205" })).toBe("TX");
    expect(stateOfCode({ system: "same", code: "048029" })).toBe("TX");
    expect(stateOfCode({ system: "ugc", code: "GMZ250" })).toBeUndefined();
    expect(stateOfCode({ system: "iso3166", code: "US" })).toBeUndefined();
    expect(stateOfCode({ system: "state", code: "XX" })).toBeUndefined();
  });
});

describe("containingCodes", () => {
  const KS = [
    { system: "state", code: "KS" },
    { system: "iso3166", code: "US" },
    { system: "iso3166", code: "US-KS" },
  ];

  it("gives the state and the country of a zone, and the county of the other system for a county", () => {
    expect(containingCodes({ system: "ugc", code: "KSZ083" })).toEqual(KS);
    // A fire zone is a zone of one state, so it gives the codes of a forecast zone.
    expect(containingCodes({ system: "ugc-fire", code: "KSZ083" })).toEqual(KS);
    expect(containingCodes({ system: "ugc", code: "KSC173" })).toEqual([...KS, { system: "same", code: "020173" }]);
    expect(containingCodes({ system: "same", code: "020173" })).toEqual([...KS, { system: "ugc", code: "KSC173" }]);
    expect(containingCodes({ system: "same", code: "120173" })).toEqual([...KS, { system: "ugc", code: "KSC173" }, { system: "same", code: "020173" }]);
    expect(containingCodes({ system: "same", code: "020000" })).toEqual(KS);
    expect(containingCodes({ system: "state", code: "ks" })).toEqual(KS.slice(1));
  });

  it("gives a territory its own country code, not US", () => {
    expect(containingCodes({ system: "ugc", code: "PRZ001" })).toEqual([
      { system: "state", code: "PR" },
      { system: "iso3166", code: "PR" },
      { system: "iso3166", code: "US-PR" },
    ]);
    expect(containingCodes({ system: "same", code: "072001" })).toEqual([
      { system: "state", code: "PR" },
      { system: "iso3166", code: "PR" },
      { system: "iso3166", code: "US-PR" },
      { system: "ugc", code: "PRC001" },
    ]);
  });

  it("gives no code for a marine zone, a country, a bad code or a different system", () => {
    for (const code of [
      { system: "ugc", code: "GMZ550" },
      { system: "ugc", code: "ANZ335" },
      { system: "iso3166", code: "US" },
      { system: "state", code: "XX" },
      { system: "same", code: "999001" },
      { system: "eic", code: "10Y1001A1001A83F" },
    ]) {
      expect(containingCodes(code)).toEqual([]);
    }
  });

  it("gives each code of a region that holds the region, so a second step adds no code", () => {
    for (const code of [{ system: "ugc", code: "KSC173" }, { system: "same", code: "120173" }, { system: "ugc", code: "PRZ001" }]) {
      const first = containingCodes(code);
      const keys = new Set([code, ...first].map((one) => `${one.system}:${one.code}`));
      for (const next of first) for (const more of containingCodes(next)) expect(keys.has(`${more.system}:${more.code}`), `${next.code} gives ${more.code}`).toBe(true);
    }
  });
});

describe("ugcRegionCodes", () => {
  it("gives a fire zone code for a zone of a Red Flag Warning or a Fire Weather Watch, and a forecast zone code for the others", () => {
    expect([...FIRE_ZONE_PHENOMENA]).toEqual(["FW"]);
    expect(ugcRegionCodes(" txz205 ", ["FW"])).toEqual([{ system: "ugc-fire", code: "TXZ205" }]);
    expect(ugcRegionCodes("TXZ205", ["fw"])).toEqual([{ system: "ugc-fire", code: "TXZ205" }]);
    expect(ugcRegionCodes("KSZ083", ["WI"])).toEqual([{ system: "ugc", code: "KSZ083" }]);
    expect(ugcRegionCodes("KSZ083", [])).toEqual([{ system: "ugc", code: "KSZ083" }]);
  });

  it("gives the two codes for a mixed list, a county code for a county, and no code for a text that is not a UGC code", () => {
    expect(ugcRegionCodes("TXZ205", ["FW", "WI"])).toEqual([
      { system: "ugc", code: "TXZ205" },
      { system: "ugc-fire", code: "TXZ205" },
    ]);
    expect(ugcRegionCodes("KSC173", ["FW"])).toEqual([{ system: "ugc", code: "KSC173" }]);
    expect(ugcRegionCodes("KS083", ["FW"])).toEqual([]);
  });
});
