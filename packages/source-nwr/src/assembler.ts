/**
 * The assembler of the headers of the radio. Each header comes three times, approximately one second apart. The assembler
 * keeps the copies of one header as a group. When the group closes, it takes the text that most copies agree on
 * (`voteSameHeader` of format-nws).
 *
 * A group closes at its third copy, at the end of a message, or after a gap with no copy. A header that the decoder
 * checked is complete at once. Thus one message can give the same text two times. The log of the system keeps one
 * observation for one text, so the repeat adds nothing. The assembler is pure state with no clock and no I/O.
 */

import type { Instant } from "@mark1russell7/alerts";
import { parseSameHeader, voteSameHeader } from "@mark1russell7/alerts-format-nws";
import type { DecoderLine } from "./lines.ts";

/** The longest gap between two copies of one header. A longer header takes approximately 4 seconds at 520.83 bits per second. */
export const GROUP_GAP_MS = 10_000;

/** One complete header, with the time of its first copy. */
export interface HeardHeader {
  readonly text: string;
  readonly at: Instant;
}

/** The assembler of the copies of the headers. */
export interface HeaderAssembler {
  /** This method adds one line of the decoder, and gives the headers that are complete after it. */
  push(line: DecoderLine, at: Instant): readonly HeardHeader[];
  /** This method closes a group whose last copy is older than the gap, and gives its header. */
  close(now: Instant): readonly HeardHeader[];
}

/** This function makes an empty assembler. */
export function createHeaderAssembler(): HeaderAssembler {
  let copies: string[] = [];
  let first: Instant = 0;
  let last: Instant = 0;
  const finish = (): HeardHeader[] => {
    const text = copies.length === 0 ? undefined : voteSameHeader(copies);
    const header = text !== undefined && parseSameHeader(text) !== undefined ? [{ text, at: first }] : [];
    copies = [];
    return header;
  };
  const assembler: HeaderAssembler = {
    push(line, at) {
      const done = assembler.close(at);
      if (line.kind === "end") return [...done, ...finish()];
      if (line.checked) return parseSameHeader(line.text) === undefined ? done : [...done, { text: line.text, at }];
      if (copies.length === 0) first = at;
      copies.push(line.text);
      last = at;
      return copies.length === 3 ? [...done, ...finish()] : done;
    },
    close(now) {
      return copies.length > 0 && now - last > GROUP_GAP_MS ? finish() : [];
    },
  };
  return assembler;
}
