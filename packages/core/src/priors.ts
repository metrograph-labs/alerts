/**
 * The entry `@mark1russell7/alerts/priors` gives the committed priors of the shadow score, as data.
 * The priors come from the base rates of the package `rates` (`priorsOf`).
 * They hold the deaths and the injuries of one NCEI event of each kind, with intervals.
 * The file `data/priors.json` holds them. The build puts the file in the entry, so the entry reads no file at run time.
 * The entry imports the root entry by its package name. Thus the build gives it no second copy of the root.
 * A test of `rates` holds the file equal to the priors of its base rates.
 */
import data from "./data/priors.json" with { type: "json" };
import { scorePriorsSchema, type ScorePriors } from "@mark1russell7/alerts";

let priors: ScorePriors | undefined;

/**
 * This function gives the committed priors, checked with the schema of the core. The function examines the file at its first use only.
 *
 * @throws ZodError when the file does not pass the schema
 */
export function committedPriors(): ScorePriors {
  priors ??= scorePriorsSchema.parse(data);
  return priors;
}
