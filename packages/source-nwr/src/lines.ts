/**
 * The lines of a SAME decoder. The decoder reads the audio of a receiver and writes one line for each header that it
 * hears. The format is the text format of the decoder `multimon-ng` with the demodulator `EAS`:
 *
 * - `EAS (part): ZCZC-...` is one copy of a header. The decoder writes it at the level of detail 1 (`-v 1`) or more.
 * - `EAS: ZCZC-...` is a header that two of its three copies agree on, letter for letter.
 * - `EAS: NNNN` is the end of a message.
 *
 * A line with no prefix is a copy, so a different decoder can write the bare text.
 */

import { SAME_END, SAME_START } from "@mark1russell7/alerts-format-nws";

/** One line of the decoder. */
export type DecoderLine =
  /** A header. `checked` is true when the decoder found two equal copies. */
  | { readonly kind: "header"; readonly text: string; readonly checked: boolean }
  /** The end of a message. */
  | { readonly kind: "end" };

const CHECKED = "EAS:";
const PART = "EAS (part):";

/** This function reads one line of the decoder. A line that is not a header and not an end gives `undefined`. */
export function readDecoderLine(line: string): DecoderLine | undefined {
  const text = line.trim();
  const [checked, rest] = text.startsWith(PART) ? [false, text.slice(PART.length)] : text.startsWith(CHECKED) ? [true, text.slice(CHECKED.length)] : [false, text];
  const body = rest.trim();
  if (body === SAME_END) return { kind: "end" };
  if (body.startsWith(SAME_START)) return { kind: "header", text: body, checked };
  return undefined;
}
