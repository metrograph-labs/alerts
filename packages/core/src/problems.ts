/**
 * The collector of the problems of a map function. Each adapter makes lists of `MapProblem`, so the
 * core is the home of the collector. A reader of a format takes a `ProblemSink`.
 */

import type { MapProblem } from "./contracts.ts";

/**
 * The effect of a problem on the report. `fatal`: no report. `lossy`: the report lacks a value of the
 * message, or holds a fallback in its place. `note`: the report is whole, and the message has more. `skip`: the map
 * skipped a good message by design, for example a CAP message with the scope Private (AL-94). A skip is no problem of the source.
 */
export type ProblemEffect = "note" | "lossy" | "fatal" | "skip";

/**
 * The place where a map function or a reader puts the problems of a message. The default effect is
 * `lossy`, because a loss that the health does not see changes the level of an alert silently.
 */
export interface ProblemSink {
  add(path: string, message: string, effect?: ProblemEffect): void;
}

/**
 * The problems of one message, in order. The collector puts its prefix before each path: the prefix
 * `features[3]` and the path `properties.onset` give `features[3].properties.onset`.
 */
export class Problems implements ProblemSink {
  readonly list: MapProblem[] = [];
  private readonly prefix: string;

  /** The prefix is the path of the message. The default is no prefix. */
  constructor(prefix = "") {
    this.prefix = prefix;
  }

  /** This method adds one problem. A problem is lossy if the caller does not give another effect. */
  add(path: string, message: string, effect: ProblemEffect = "lossy"): void {
    const full = this.prefix === "" ? path : path === "" ? this.prefix : `${this.prefix}.${path}`;
    this.list.push(
      effect === "lossy"
        ? { path: full, message, fatal: false, lossy: true }
        : effect === "skip"
          ? { path: full, message, fatal: false, skipped: true }
          : { path: full, message, fatal: effect === "fatal" },
    );
  }

  /** The count of the fatal problems. A `FetchRecord` holds this count for the observations of a fetch. */
  get fatal(): number {
    return this.list.filter((problem) => problem.fatal).length;
  }

  /** The count of the lossy problems. A `FetchRecord` holds this count for the observations of a fetch. */
  get lossy(): number {
    return this.list.filter((problem) => problem.lossy === true).length;
  }

  /** The count of the messages that the map skipped by design. A `FetchRecord` holds this count for the observations of a fetch. */
  get skipped(): number {
    return this.list.filter((problem) => problem.skipped === true).length;
  }
}
