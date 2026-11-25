/**
 * The use reads of a cap of the spend (AL-91). A use read is the cost of the use of one service from the start of the
 * month, in the format `UseRead` of `@mark1russell7/stack-spend`. The spend gate of a stack examines these reads.
 *
 * The runtime writes the reads of its caps into the file `use.json` of its private folder. A step outside this
 * repository copies the file to the stack.
 */

import type { Instant } from "@mark1russell7/alerts";
import { localTime, monthOf } from "@mark1russell7/algebra/clock";
import type { UseRead } from "@mark1russell7/stack-spend";
import type { QuotaGate } from "polite-crawler/api";
import type { SpendRead } from "./balance.ts";
import { latestFile, type LatestFileOptions } from "./latest-file.ts";

/** The name of the file of the use reads in the private folder of the runtime. */
export const USE_FILE = "use.json";

/** The parts of one cap of the spend, for its use reads. */
export interface SpendUseOptions {
  /** The provider of the cap, as in its spend entry: for example `provider:twilio`. */
  readonly provider: string;
  /** The id of this copy of the system: for example `home`. */
  readonly copy: string;
  /** The IANA time zone of the month of the cap. The date of each read is a date of this zone. */
  readonly timeZone: string;
  /** The gate of the own count of the cap. Its units are cents. */
  readonly own: QuotaGate;
  /** This function gives the last read of the spend that the provider gave, when the watch has one. */
  readonly spend: () => SpendRead | undefined;
}

/**
 * This function gives the use reads of one cap of the spend at the instant `at`. The name of a part is the id of the
 * provider with no prefix `provider:`.
 *
 * - The count read has the part `meter:<name>-<copy>`. Its amount is the cost of the sends of this copy in the month.
 * - The provider read has the part `account:<name>`. Its amount is the spend of the whole account that the provider gave.
 *   The date of this read is the date of the last read of the watch. It is there only when that read is in the month of `at`.
 * - A fault of the store of the own gate gives no count read. A credit of the provider gives the amount 0.
 *
 * @throws Error when the time zone is not an IANA time zone.
 */
export function spendUseReads(options: SpendUseOptions, at: Instant): readonly UseRead[] {
  const zone = options.timeZone;
  if (localTime(0, zone) === undefined) throw new Error(`The time zone of the use reads of ${options.provider} is not an IANA time zone.`);
  const name = options.provider.replace(/^provider:/u, "");
  const reads: UseRead[] = [];
  const today = localDate(at, zone);
  const used = ownUsed(options.own);
  if (today !== undefined && used !== undefined) reads.push({ part: `meter:${name}-${options.copy}`, source: "count", amount: used / 100, date: today });
  const last = options.spend();
  const lastDate = last === undefined ? undefined : localDate(last.at, zone);
  if (last !== undefined && lastDate !== undefined && sameMonth(last.at, at, zone)) {
    reads.push({ part: `account:${name}`, source: "provider", amount: Math.max(0, last.usedUsd), date: lastDate });
  }
  return reads;
}

/** This function gives the units of the own gate in the window, or `undefined` when its store fails. */
function ownUsed(own: QuotaGate): number | undefined {
  try {
    return own.state().used;
  } catch {
    return undefined;
  }
}

/** This function gives the date of an instant in a time zone, as `YYYY-MM-DD`. */
function localDate(at: Instant, zone: string): string | undefined {
  const time = localTime(at, zone);
  if (time === undefined) return undefined;
  const two = (value: number): string => String(value).padStart(2, "0");
  return `${String(time.year).padStart(4, "0")}-${two(time.month)}-${two(time.day)}`;
}

function sameMonth(a: Instant, b: Instant, zone: string): boolean {
  const start = monthOf(a, zone)?.start;
  return start !== undefined && start === monthOf(b, zone)?.start;
}

/** The options of the writer of the file of the use reads. */
export type UseFileOptions = LatestFileOptions;

/** The writer of the file of the use reads. */
export interface UseFile {
  /** This method writes the reads when their text changed. It does not wait for the write, and it does not throw. */
  update(reads: readonly UseRead[]): void;
  /** This method gives a promise that ends when no write is in progress. */
  idle(): Promise<void>;
}

/** This function makes the writer of the file of the use reads. The file holds a JSON list of the reads, and the last list wins. */
export function useFile(options: UseFileOptions): UseFile {
  const file = latestFile(options);
  return { update: (reads) => file.update(`${JSON.stringify(reads, null, 2)}\n`), idle: () => file.idle() };
}
