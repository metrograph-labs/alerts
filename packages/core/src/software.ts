/**
 * The match of the advisories to the software of a stack. An advisory gives its packages as subjects of the system
 * `purl`, each with the ranges of its affected versions. A stack gives the installed packages of each part. A match is a
 * part with an installed version in a range. Thus the match is a query over the live data, not a list by hand.
 *
 * The core names no version scheme. The caller gives the check of a version against a range (`RangeCheck`), for
 * example from the version order of `@mark1russell7/package-id`.
 */

import type { Subject } from "./contracts.ts";

/** The system of the subject of a package: its purl with no version. */
export const PACKAGE_SYSTEM = "purl";

/** One installed package of a part: its purl with no version, in the canonical form, and its version. */
export interface InstalledPackage {
  /** The purl of the package with no version, qualifiers or subpath, for example `pkg:npm/lodash`. */
  readonly purl: string;
  readonly version: string;
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
 */
export function softwareMatches(about: readonly Subject[], stack: SoftwareStack, check: RangeCheck): SoftwareMatch[] {
  // The ranges of each package. `undefined` in the list: a subject of the package with no range.
  const named = new Map<string, (readonly string[] | undefined)[]>();
  for (const subject of about) {
    if (subject.system !== PACKAGE_SYSTEM) continue;
    const list = named.get(subject.id) ?? [];
    list.push(subject.ranges);
    named.set(subject.id, list);
  }
  if (named.size === 0) return [];
  const matches: SoftwareMatch[] = [];
  for (const part of stack.parts) {
    for (const pkg of part.packages) {
      const lists = named.get(pkg.purl);
      if (lists === undefined) continue;
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
