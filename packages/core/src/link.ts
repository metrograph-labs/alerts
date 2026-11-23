/**
 * The link rule of the merge (rule 3) for the kinds of events with a point and a time, for example the
 * earthquakes. Two sources can report one real event with different ids. Then no reference and no
 * correlation key joins their reports, and the person gets two alerts for one event. This rule joins them
 * by their onsets, their points and their magnitudes.
 *
 * The rule is on the safe side. A false join can hide a second event after an acknowledgment, but a
 * false split gives only a second alert. Thus a report with no onset, no circle area or no magnitude
 * (when the family has a limit of the magnitude) links to no report. Two reports of one source do not
 * link: a source that gives two ids tells of two events.
 *
 * The rule compares two reports at a time, and the incidents are the connected components. So a chain
 * can join two real events: an event of one source between two events of another source joins the
 * three. This is a known limit (`docs/CONTRACTS.md`). A pairwise rule only joins incidents when a report
 * comes. It does not split an incident, so a sent alert stays with its incident.
 */

import { distanceKm, GeoError } from "@mark1russell7/geo";
import { hasKind } from "./assess.ts";
import type { Instant, Report } from "./contracts.ts";
import type { LinkRule } from "./merge.ts";

/** The link of one family of kinds: the largest differences of two reports of one real event. */
export interface LinkFamily {
  /** A taxonomy code or a prefix of codes. A report is in the family when the code of its kind has this prefix by parts. */
  readonly family: string;
  /** The largest time between the onsets of two reports, in milliseconds. It is more than 0. */
  readonly windowMs: number;
  /** The largest great-circle distance between the centers of the circle areas of two reports, in kilometers. */
  readonly distanceKm: number;
  /** The largest difference of the parameter `magnitude` of two reports. When it is absent, the rule does not read the magnitude. */
  readonly magnitude?: number;
}

/** The policy of the link rule: each family of kinds that links, with its limits. */
export interface LinkPolicy {
  readonly families: readonly LinkFamily[];
}

/**
 * The first policy, with two families.
 *
 * Two earthquake reports link when their onsets are 30 s apart or less, their epicenters 100 km apart or less, and
 * their magnitudes 1.0 apart or less. One capture of EMSC and USGS (2026-11-16) matched each of its 30 shared events
 * at 20 s and 100 km. The largest time difference was 6.3 s.
 *
 * Two reports of a geomagnetic storm link when their onsets are 6 hours apart or less. Each source of the family
 * gives the polar caps of one model of the poles. Thus the centers are 0 km apart. The limit of 100 km keeps a
 * different model.
 *
 * A replay of the years 2015 to 2025 measured the window (`scripts/measure-link.ts` of the GFZ source). At 6 hours,
 * 457 of the 460 runs of GFZ join the SWPC, and 447 join at 3 hours. Each of the 3 other runs has one interval, 6.3
 * to 9 hours from a storm report of the SWPC. A larger window puts more runs of GFZ in one incident, through the
 * chains of keys of the SWPC. There are 55 such pairs at 6 hours, and 24 at 5 hours. The gate `link.test.ts` of the
 * GFZ source holds two of these storms.
 */
export const DEFAULT_LINK_POLICY: LinkPolicy = {
  families: [
    { family: "geo.earthquake", windowMs: 30_000, distanceKm: 100, magnitude: 1 },
    { family: "geo.space-weather.geomagnetic-storm", windowMs: 6 * 3_600_000, distanceKm: 100 },
  ],
};

/** The name of the parameter of a report that holds its magnitude. */
export const MAGNITUDE_PARAMETER = "magnitude";

// The magnitudes have one or two decimals, so 3.1 - 2.1 is 1.0000000000000002. This margin keeps a difference of 1.0 in the limit.
const MAGNITUDE_MARGIN = 1e-9;

/** The facts of a report that the link of one family reads. */
interface Facts {
  readonly onset: Instant;
  readonly centers: readonly { readonly lat: number; readonly lon: number }[];
  readonly magnitude?: number;
}

/** This function gives the number of a decimal text, for example `4.5` or `-0.3`. Each other text gives `undefined`. */
function decimal(text: string | undefined): number | undefined {
  return text !== undefined && /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : undefined;
}

/** This function gives the facts of a report for one family. A report that is not in the family, or that has a missing fact, gives `undefined`. */
function factsOf(report: Report, family: LinkFamily): Facts | undefined {
  if (!hasKind([family.family], report.kind.code) || report.onset === undefined) return undefined;
  const centers = report.areas.flatMap((area) => (area.type === "circle" ? [{ lat: area.center[1], lon: area.center[0] }] : []));
  if (centers.length === 0) return undefined;
  if (family.magnitude === undefined) return { onset: report.onset, centers };
  const values = report.parameters[MAGNITUDE_PARAMETER];
  const magnitude = values?.length === 1 ? decimal(values[0]) : undefined;
  return magnitude === undefined ? undefined : { onset: report.onset, centers, magnitude };
}

/** This function tells if a center of one list and a center of the other are no farther apart than the limit. A point that is not valid is not near. */
function near(a: Facts["centers"], b: Facts["centers"], limitKm: number): boolean {
  return a.some((x) =>
    b.some((y) => {
      try {
        return distanceKm(x, y) <= limitKm;
      } catch (error) {
        if (error instanceof GeoError) return false;
        throw error;
      }
    }),
  );
}

/** This function tells if the facts of two reports of one family tell of one real event. */
function linked(x: Facts | undefined, y: Facts | undefined, family: LinkFamily): boolean {
  if (x === undefined || y === undefined) return false;
  if (Math.abs(x.onset - y.onset) > family.windowMs) return false;
  if (family.magnitude !== undefined && Math.abs(x.magnitude! - y.magnitude!) > family.magnitude + MAGNITUDE_MARGIN) return false;
  return near(x.centers, y.centers, family.distanceKm);
}

// The rule of each policy object. A policy does not change.
const rules = new WeakMap<LinkPolicy, LinkRule>();

/**
 * This function gives the link rule of a policy, for `incidents`.
 *
 * The blocks of a report are, for each family that has its facts, the slot of its onset and the slot
 * before it. A slot is as long as the window of the family. So two onsets in one window are in one slot
 * or in two slots next to each other, and their reports share a block.
 *
 * One policy object gives one rule object. Thus `incidents` keeps the groups of a list of reports for each pass.
 *
 * @throws RangeError when the window of a family is not more than 0
 */
export function linkRule(policy: LinkPolicy): LinkRule {
  const held = rules.get(policy);
  if (held !== undefined) return held;
  for (const family of policy.families) {
    if (!(family.windowMs > 0)) throw new RangeError(`The window of the family ${family.family} is not more than 0: ${family.windowMs}.`);
  }
  // The facts of each report for each family of the policy. A report does not change, so the rule reads its facts one
  // time (AL-116). The cache holds no entry for a report in no family: such a report has no block, so a build never
  // gives it to `matches`.
  const factCache = new WeakMap<Report, readonly (Facts | undefined)[]>();
  const noFacts: readonly undefined[] = policy.families.map(() => undefined);
  const factsFor = (report: Report): readonly (Facts | undefined)[] => {
    const held = factCache.get(report);
    if (held !== undefined) return held;
    const facts = policy.families.map((family) => factsOf(report, family));
    if (facts.every((fact) => fact === undefined)) return noFacts;
    factCache.set(report, facts);
    return facts;
  };
  const rule: LinkRule = {
    blocks: (report) =>
      factsFor(report).flatMap((facts, index) => {
        if (facts === undefined) return [];
        const slot = Math.floor(facts.onset / policy.families[index]!.windowMs);
        return [JSON.stringify(["link", index, slot]), JSON.stringify(["link", index, slot - 1])];
      }),
    matches: (a, b) => {
      if (a.source === b.source) return false;
      const x = factsFor(a);
      const y = factsFor(b);
      return policy.families.some((family, index) => linked(x[index], y[index], family));
    },
  };
  rules.set(policy, rule);
  return rule;
}
