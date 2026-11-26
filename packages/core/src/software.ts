/**
 * The match of the advisories to the software of a stack. An advisory gives its packages as subjects of the system
 * `purl`, each with the ranges of its affected versions. A stack gives the installed packages of each part. A match is a
 * part with an installed version in a range. Thus the match is a query over the live data, not a list by hand.
 *
 * The match takes the check of a version against a range (`RangeCheck`). The assessment uses `versRangeCheck`, with
 * the version order of `@mark1russell7/package-id`.
 */

import { cpeProductOf, parseVers, versContains, versEnd } from "@mark1russell7/package-id";
import type { Subject } from "./contracts.ts";

/** The system of the subject of a package: its purl with no version. */
export const PACKAGE_SYSTEM = "purl";

/**
 * The system of the subject of a product of a vendor: its CPE name. A match compares the products of two names, with
 * `cpeProductOf`: the part, the vendor and the product. The version of the name is not part of the match.
 */
export const CPE_SYSTEM = "cpe";

/** One installed package of a part: its purl with no version, in the canonical form, and its version. */
export interface InstalledPackage {
  /** The purl of the package with no version, qualifiers or subpath, for example `pkg:npm/lodash`. */
  readonly purl: string;
  readonly version: string;
  /** The CPE name of the package, for a product of a vendor that its advisories name by CPE. The match uses its product. */
  readonly cpe?: string;
}

/** The software of one part of a stack. */
export interface SoftwarePart {
  /** The id of the part in the stack, for example `web-1`. */
  readonly part: string;
  readonly label?: string;
  readonly packages: readonly InstalledPackage[];
}

/** The software of a stack: the installed packages of each part. The private configuration gives it. */
export interface SoftwareStack {
  readonly parts: readonly SoftwarePart[];
}

/** The result of the check of a version against one range. */
export interface RangeResult {
  /** True: the version is in the range. `undefined`: the order of the scheme or of the version is not known. */
  readonly affected: boolean | undefined;
  /** The first fixed version above the version, when the range gives it. */
  readonly fixed?: string;
}

/** The check of a version against a range, as a `vers` text. */
export type RangeCheck = (range: string, version: string) => RangeResult;

/**
 * This function checks a version against a `vers` range with the version order of `@mark1russell7/package-id`. A text
 * that is not a range, or a scheme with no known order, gives `affected: undefined`.
 */
export const versRangeCheck: RangeCheck = (range, version) => {
  const vers = parseVers(range);
  if (vers === undefined) return { affected: undefined };
  const affected = versContains(vers, version);
  if (affected !== true) return { affected };
  const fixed = versEnd(vers, version);
  return fixed === undefined ? { affected } : { affected, fixed };
};

/**
 * The verdict of a match. `affected`: a range holds the installed version. `unknown`: no range gives a decision, because
 * the advisory gives no range or the order of a version is not known.
 */
export type MatchVerdict = "affected" | "unknown";

/** One match of an advisory: a part with an installed package that the advisory names. */
export interface SoftwareMatch {
  readonly part: string;
  readonly label?: string;
  /** The purl of the package with no version. */
  readonly purl: string;
  /** The installed version. */
  readonly installed: string;
  readonly verdict: MatchVerdict;
  /** The first fixed version above the installed version, when a range gives it. */
  readonly fixed?: string;
}

/**
 * This function gives the matches of the subjects of an advisory to the software of a stack. The matches come in the
 * order of the parts and of their packages. A package whose installed version is in no range of the advisory gives no
 * match. A package with an unknown verdict gives a match `unknown`, so a person sees it.
 *
 * A subject of the system `purl` with no field `ranges` is a package with no known range: its verdict is `unknown`. A
 * package with two subjects is affected when one range of one subject holds its version.
 *
 * A package with a CPE name also matches each subject of the system `cpe` with the same product. Thus a device of a
 * vendor matches an advisory that names it only by CPE.
 */
export function softwareMatches(about: readonly Subject[], stack: SoftwareStack, check: RangeCheck): SoftwareMatch[] {
  // The ranges of each package. `undefined` in the list: a subject of the package with no range.
  // The key of a purl is the purl, and the key of a CPE name is its product.
  const named = new Map<string, (readonly string[] | undefined)[]>();
  for (const subject of about) {
    const key = subjectKey(subject.system, subject.id);
    if (key === undefined) continue;
    const list = named.get(key) ?? [];
    list.push(subject.ranges);
    named.set(key, list);
  }
  if (named.size === 0) return [];
  const matches: SoftwareMatch[] = [];
  for (const part of stack.parts) {
    for (const pkg of part.packages) {
      const cpe = pkg.cpe === undefined ? undefined : subjectKey(CPE_SYSTEM, pkg.cpe);
      const lists = [...(named.get(`${PACKAGE_SYSTEM} ${pkg.purl}`) ?? []), ...(cpe === undefined ? [] : (named.get(cpe) ?? []))];
      if (lists.length === 0) continue;
      const result = verdictOf(lists, pkg.version, check);
      if (result === undefined) continue;
      matches.push({
        part: part.part,
        ...(part.label === undefined ? {} : { label: part.label }),
        purl: pkg.purl,
        installed: pkg.version,
        verdict: result.verdict,
        ...(result.fixed === undefined ? {} : { fixed: result.fixed }),
      });
    }
  }
  return matches;
}

// The key of a subject in the map of the named packages, or `undefined` for a subject that is not a package.
function subjectKey(system: string, id: string): string | undefined {
  if (system === PACKAGE_SYSTEM) return `${PACKAGE_SYSTEM} ${id}`;
  if (system !== CPE_SYSTEM) return undefined;
  const product = cpeProductOf(id);
  return product === undefined ? undefined : `${CPE_SYSTEM} ${product}`;
}

// The verdict of one installed version against the range lists of the subjects of its package, or `undefined` for
// no match. An affected range wins over an unknown one.
function verdictOf(
  lists: readonly (readonly string[] | undefined)[],
  version: string,
  check: RangeCheck,
): { readonly verdict: MatchVerdict; readonly fixed?: string } | undefined {
  let unknown = false;
  for (const ranges of lists) {
    if (ranges === undefined || ranges.length === 0) {
      unknown = true;
      continue;
    }
    for (const range of ranges) {
      const result = check(range, version);
      if (result.affected === true) return { verdict: "affected", ...(result.fixed === undefined ? {} : { fixed: result.fixed }) };
      if (result.affected === undefined) unknown = true;
    }
  }
  return unknown ? { verdict: "unknown" } : undefined;
}

/** The system of the subject of a part of the stack, for example `{ system: "software.part", id: "web" }`. */
export const SOFTWARE_PART_SYSTEM = "software.part";

/**
 * This function gives the text of one match for a message, for example `The part web has pkg:npm/a 2.3.0. The first
 * fixed version is 2.4.1.` A match `unknown` tells that the affected versions are not known.
 */
export function softwareMatchText(match: SoftwareMatch): string {
  const part = match.label === undefined ? `The part ${match.part}` : `The part ${match.part} (${match.label})`;
  const has = `${part} has ${match.purl} ${match.installed}.`;
  if (match.verdict === "unknown") return `${has} The advisory does not tell if this version is affected.`;
  return match.fixed === undefined ? `${has} The advisory gives no fixed version.` : `${has} The first fixed version is ${match.fixed}.`;
}
