/**
 * The coverage report of the runtime (AL-196). For each watched place and each kind, the report gives the sources that
 * cover the kind and the health of each source. It also gives the coverage count and the count that the policy needs.
 *
 * The runtime writes the report into the file `coverage.json` of its private folder, only when the report changes.
 * Other programs on the same computer read the file. They do not write it.
 */

import { coverageShort, type HealthState, type Instant, type PlaceId, type SourceId } from "@mark1russell7/alerts";
import { latestFile, type LatestFileOptions } from "./latest-file.ts";
import type { SystemView } from "./view.ts";

/** The name of the file of the coverage report in the private folder of the runtime. */
export const COVERAGE_FILE = "coverage.json";

/** The format of the file. A change that a reader cannot read gets a new number. */
export const COVERAGE_FORMAT = "alerts-coverage/1";

/** One source that covers a kind at a place. */
export interface CoverageFileSource {
  readonly source: SourceId;
  /** The health state of the source. */
  readonly state: HealthState;
  /** The time of the start of the state, as an ISO 8601 text. */
  readonly since: string;
  /** The coverage counts the source: its state is up and it is not late against another source. */
  readonly counts: boolean;
}

/** The coverage of one kind at one place. */
export interface CoverageFileEntry {
  readonly place: PlaceId;
  readonly kind: string;
  /** The count of independent outside failure domains that the policy needs. */
  readonly required: number;
  /** The count of independent outside failure domains of the sources that count. */
  readonly independent: number;
  /** The search of the count ended. When it is false, the true count can be smaller. */
  readonly proven: boolean;
  /** The coverage is below its policy (`coverageShort`). */
  readonly short: boolean;
  /** Each source that covers the kind at the place, also when it is down, in the order of the configuration. */
  readonly sources: readonly CoverageFileSource[];
}

/** The text of the file. */
export interface CoverageFile {
  readonly format: typeof COVERAGE_FORMAT;
  /** The time of the view that changed the report last, as an ISO 8601 text. */
  readonly changed: string;
  readonly entries: readonly CoverageFileEntry[];
}

/**
 * This function gives the entries of the report of a view. A place and a kind with no candidate source still get an
 * entry, thus a gap shows. A source with no health has the state `unknown`.
 */
export function coverageEntries(view: Pick<SystemView, "at" | "coverage" | "candidates" | "health">): CoverageFileEntry[] {
  const health = new Map(view.health.map((entry) => [entry.source, entry]));
  const counted = new Map(view.coverage.map((entry) => [keyOf(entry.place, entry.kind), entry]));
  return view.candidates.map((candidate) => {
    const entry = counted.get(keyOf(candidate.place, candidate.kind));
    const counts = new Set(entry?.sources ?? []);
    return {
      place: candidate.place,
      kind: candidate.kind,
      required: entry?.required ?? 0,
      independent: entry?.independent ?? 0,
      proven: entry?.proven ?? true,
      short: entry === undefined ? false : coverageShort(entry),
      sources: candidate.sources.map((source) => {
        const known = health.get(source);
        return { source, state: known?.state ?? "unknown", since: iso(known?.since ?? view.at), counts: counts.has(source) };
      }),
    };
  });
}

/** The writer of the file of the coverage report. */
export interface CoverageFileWriter {
  /** This method writes the report of a view when its entries changed. It does not wait for the write, and it does not throw. */
  update(view: Pick<SystemView, "at" | "coverage" | "candidates" | "health">): void;
  /** This method gives a promise that ends when no write is in progress. */
  idle(): Promise<void>;
}

/** This function makes the writer of the file of the coverage report. The time of a view alone does not change the file. */
export function coverageFile(options: LatestFileOptions): CoverageFileWriter {
  const file = latestFile(options);
  let last: { readonly key: string; readonly text: string } | undefined;
  return {
    update(view) {
      const entries = coverageEntries(view);
      const key = JSON.stringify(entries);
      if (key !== last?.key) {
        const report: CoverageFile = { format: COVERAGE_FORMAT, changed: iso(view.at), entries };
        last = { key, text: `${JSON.stringify(report, null, 2)}\n` };
      }
      // The same text again writes nothing, but after a failed write it writes the file again.
      file.update(last.text);
    },
    idle: () => file.idle(),
  };
}

function keyOf(place: PlaceId, kind: string): string {
  return JSON.stringify([place, kind]);
}

function iso(at: Instant): string {
  return new Date(at).toISOString();
}
