/**
 * The ranges of the affected versions of a package of a record, as `vers` texts: the field `ranges` of its subject.
 * The body keeps each range as a text (`rangeText`). This module reads the text again. Thus the body and the ids of
 * the observations stay the same, and the records of the log also get their ranges.
 */

import { formatVers, osvRangeVers, parsePurl, type OsvEvent } from "@mark1russell7/package-id";

import { MAX_VERSIONS, type PackageBody } from "./body.ts";

const EVENT_NAMES: ReadonlySet<string> = new Set(["introduced", "fixed", "last_affected", "limit"]);

/** One range as the text of the body gives it: the type and the events. */
export interface RangeOfText {
  readonly type: string;
  readonly events: readonly OsvEvent[];
}

/**
 * This function reads the text of a range, for example `SEMVER introduced 0, fixed 3.16.3`. A text that `rangeText`
 * did not write gives `undefined`.
 */
export function rangeOfText(text: string): RangeOfText | undefined {
  const space = text.indexOf(" ");
  if (space <= 0) return undefined;
  const events: OsvEvent[] = [];
  for (const part of text.slice(space + 1).split(", ")) {
    const [name, version, ...rest] = part.split(" ");
    if (name === undefined || version === undefined || version === "" || rest.length > 0 || !EVENT_NAMES.has(name)) return undefined;
    events.push({ [name]: version });
  }
  return { type: text.slice(0, space), events };
}

/**
 * This function gives the ranges of a package as `vers` texts, or `undefined` when they are not complete. Each range
 * of the type `SEMVER` or `ECOSYSTEM` gives one text. The list of versions gives one more text, with the comparator `=`.
 *
 * A `GIT` range has no versions. When the record has one, only a complete list of versions covers it. A list with
 * `MAX_VERSIONS` entries can be a cut list, and an empty list covers nothing. Then the ranges are not complete, and the
 * verdict of a match is `unknown`.
 */
export function packageRanges(pkg: PackageBody): readonly string[] | undefined {
  const type = pkg.purl === undefined ? undefined : parsePurl(pkg.purl)?.type;
  const ranges: string[] = [];
  let missing = false;
  for (const text of pkg.ranges) {
    const range = rangeOfText(text);
    const vers = range === undefined ? undefined : osvRangeVers(pkg.ecosystem, range);
    if (vers === undefined) missing = true;
    else ranges.push(formatVers(vers));
  }
  const complete = pkg.versions.length < MAX_VERSIONS;
  if (type !== undefined && complete && pkg.versions.length > 0) {
    ranges.push(formatVers({ scheme: type, all: false, constraints: pkg.versions.map((version) => ({ comparator: "=", version })) }));
  }
  if (missing && (!complete || pkg.versions.length === 0)) return undefined;
  return ranges.length === 0 ? undefined : [...new Set(ranges)];
}
