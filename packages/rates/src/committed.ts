/**
 * The committed priors of the shadow score. The core holds the file in `src/data/priors.json`, and its entry
 * `@mark1russell7/alerts/priors` gives them. The runtime reads them at its start. A test holds the file equal to the priors of `data/rates.json`.
 */
export { committedPriors } from "@mark1russell7/alerts/priors";

/** The URL of the file of the committed priors, in the folder of the core. */
export const PRIORS_URL: URL = new URL("../../core/src/data/priors.json", import.meta.url);
