/**
 * The forms of the two region codes of the US warning system. A UGC code of the NWS has the letters of
 * a state, the letter C (a county) or Z (a zone), and three digits, for example `KSZ001`. A SAME code
 * has six digits, for example `020001`. The first digit is a part of the county, and 0 is all of it.
 *
 * A SAME location code (47 CFR 11.31) is `PSSCCC`. `P` is the part of the county. `SS` is the FIPS
 * code of the state, and `CCC` is the FIPS code of the county. `000` is the full state. A UGC code
 * starts with the postal code of its state. Thus a source finds the state of an area from its codes.
 */

import { STATE_FIPS, STATE_POSTAL, type RegionCode } from "@mark1russell7/alerts";

const UGC = /^[A-Z]{2}[CZ]\d{3}$/;
const SAME = /^\d{6}$/;

/** This function tells if a text has the form of a UGC code, for example `KSZ001`. The letters are capitals. */
export const isUgcCode = (text: string): boolean => UGC.test(text);

/** This function tells if a text has the form of a SAME code, for example `020001`. */
export const isSameCode = (text: string): boolean => SAME.test(text);


/** The parts of one SAME location code. */
export interface SameLocation {
  /** The part of the county: `0` is the full county, `1` to `9` are its parts. */
  readonly part: string;
  /** The FIPS code of the state, two digits. */
  readonly state: string;
  /** The FIPS code of the county, three digits. `000` is the full state. */
  readonly county: string;
}

/** This function reads a SAME location code. It removes the spaces at the ends. A text that is not six digits gives `undefined`. */
export function parseSameLocation(code: string): SameLocation | undefined {
  const text = code.trim();
  if (!isSameCode(text)) return undefined;
  return { part: text.slice(0, 1), state: text.slice(1, 3), county: text.slice(3) };
}

/**
 * This function gives the postal code of the state of a UGC code, in capitals or not. A marine zone
 * (`GMZ`, `ANZ`) has no state, and a text that is not a UGC code gives `undefined`.
 */
export function stateOfUgc(code: string): string | undefined {
  const text = code.trim().toUpperCase();
  if (!isUgcCode(text)) return undefined;
  const prefix = text.slice(0, 2);
  return prefix in STATE_FIPS ? prefix : undefined;
}

/**
 * This function gives the SAME code of a county UGC code, for example `020173` for `KSC173`. The number
 * of a county UGC code is the FIPS code of the county. A zone code, or a code with no state, gives `undefined`.
 */
export function sameOfCountyUgc(code: string): string | undefined {
  const text = code.trim().toUpperCase();
  if (!isUgcCode(text) || text[2] !== "C") return undefined;
  const state = STATE_FIPS[text.slice(0, 2)];
  return state === undefined ? undefined : `0${state}${text.slice(3)}`;
}

/**
 * This function gives the county UGC code of a SAME location code, for example `KSC173` for `020173`. It is the
 * reverse of `sameOfCountyUgc`. A part of a county (`120173`) gives the code of the full county. A code of a full
 * state (`020000`), a state with no postal code or a text that is not a SAME code gives `undefined`.
 */
export function countyUgcOfSame(code: string): string | undefined {
  const location = parseSameLocation(code);
  if (location === undefined || location.county === "000") return undefined;
  const state = STATE_POSTAL[location.state];
  return state === undefined ? undefined : `${state}C${location.county}`;
}

/** This function gives the postal code of the state of a SAME location code, or `undefined`. */
export function stateOfSame(code: string): string | undefined {
  const location = parseSameLocation(code);
  return location === undefined ? undefined : STATE_POSTAL[location.state];
}

/** This function gives the postal code of a state in capital letters, or `undefined` for a text that is not a state. */
export function stateCode(state: string): string | undefined {
  const code = state.trim().toUpperCase();
  return Object.hasOwn(STATE_FIPS, code) ? code : undefined;
}

/**
 * This function gives the postal code of the state of a region code, or `undefined`. A `state` code gives
 * its state. A UGC code, a fire zone code and a SAME code give the state of their zone or county. A marine zone and a country
 * give `undefined`.
 */
export function stateOfCode(code: RegionCode): string | undefined {
  switch (code.system) {
    case "state":
      return stateCode(code.code);
    case "ugc":
    case "ugc-fire":
      return stateOfUgc(code.code);
    case "same":
      return stateOfSame(code.code);
    default:
      return undefined;
  }
}

/** The smallest FIPS code of a territory. The codes of the states and the District of Columbia are smaller. */
const FIRST_TERRITORY_FIPS = 60;

/**
 * This function gives the codes of the regions that hold all of the region of a code. The code itself is not in the result.
 * The coverage of the sources adds them to the codes of a place. Thus a source of a country covers a place with only a zone code.
 *
 * - A UGC code, a fire zone code and a SAME code give the `state` code of their state.
 * - A state or the District of Columbia gives the `iso3166` codes `US` and its subdivision, for example `US-KS`.
 * - A territory gives its own `iso3166` code (`PR`) and its subdivision (`US-PR`). The sources tell each territory apart from `US`.
 * - A county UGC code gives its SAME code. A SAME code of a county, or of a part of a county, gives its county UGC code.
 * - A SAME code of a part of a county also gives the SAME code of the full county.
 * - A marine zone, a country and a code of a different system give no code.
 */
export function containingCodes(code: RegionCode): RegionCode[] {
  const state = stateOfCode(code);
  if (state === undefined) return [];
  const territory = Number(STATE_FIPS[state]) >= FIRST_TERRITORY_FIPS;
  const codes: RegionCode[] = code.system === "state" ? [] : [{ system: "state", code: state }];
  codes.push({ system: "iso3166", code: territory ? state : "US" }, { system: "iso3166", code: `US-${state}` });
  const county = code.system === "ugc" ? sameOfCountyUgc(code.code) : code.system === "same" ? countyUgcOfSame(code.code) : undefined;
  if (county !== undefined) codes.push({ system: code.system === "ugc" ? "same" : "ugc", code: county });
  const location = code.system === "same" ? parseSameLocation(code.code) : undefined;
  if (location !== undefined && location.part !== "0" && location.county !== "000") codes.push({ system: "same", code: `0${location.state}${location.county}` });
  return codes;
}

/**
 * The VTEC phenomena of the products for the NWS fire weather zones: `FW`, the Fire Weather Watch (`FW.A`) and the Red
 * Flag Warning (`FW.W`). The UGC zone codes of these products are fire zone codes (AL-33).
 */
export const FIRE_ZONE_PHENOMENA: ReadonlySet<string> = new Set(["FW"]);

/**
 * This function gives the region codes of a UGC code of an alert from the VTEC phenomena of the alert. A fire zone and a
 * forecast zone can have one code and different outlines, thus the phenomena decide the system.
 *
 * - A county code gives `ugc`.
 * - A zone code gives `ugc-fire` when a phenomenon is in `FIRE_ZONE_PHENOMENA`.
 * - A zone code gives `ugc` when another phenomenon is in the list, or when the list is empty. Thus a mixed list gives the two codes.
 * - A text that is not a UGC code gives an empty list.
 */
export function ugcRegionCodes(code: string, phenomena: Iterable<string>): RegionCode[] {
  const text = code.trim().toUpperCase();
  if (!isUgcCode(text)) return [];
  if (text[2] === "C") return [{ system: "ugc", code: text }];
  let fire = false;
  let other = false;
  for (const phenomenon of phenomena) {
    if (FIRE_ZONE_PHENOMENA.has(phenomenon.trim().toUpperCase())) fire = true;
    else other = true;
  }
  return [...(other || !fire ? [{ system: "ugc", code: text }] : []), ...(fire ? [{ system: "ugc-fire", code: text }] : [])];
}
