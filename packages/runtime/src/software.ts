/**
 * The check of an installed version against the range of an advisory, with the version order of
 * `@mark1russell7/package-id`. The core match `softwareMatches` takes it as a parameter, so the core names no scheme.
 */

import type { RangeCheck, RangeResult } from "@mark1russell7/alerts";
import { parseVers, versContains, versEnd } from "@mark1russell7/package-id";

/**
 * This function tells if a version is in a `vers` range, and gives the first fixed version above it. A text that is
 * not a range, or a scheme with no known order, gives the result `undefined`.
 */
export const versRangeCheck: RangeCheck = (range, version): RangeResult => {
  const vers = parseVers(range);
  if (vers === undefined) return { affected: undefined };
  const affected = versContains(vers, version);
  if (affected !== true) return { affected };
  const fixed = versEnd(vers, version);
  return fixed === undefined ? { affected } : { affected, fixed };
};
