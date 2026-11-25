/**
 * The split of the output of the decoder into lines. The output comes in chunks, and a chunk can end in the middle of a
 * line. The splitter keeps that part until the end of its line comes. The splitter is pure state with no I/O.
 */

import { StringDecoder } from "node:string_decoder";

/** The splitter of a stream of text into lines. */
export interface LineSplitter {
  /** This method adds one chunk, and gives each complete line in it. A line has no line end. */
  push(chunk: string | Uint8Array): string[];
  /** This method gives the last part of the stream when it has no line end, at the end of the stream. */
  flush(): string[];
}

/**
 * This function makes a splitter. A line ends at `\n` or at `\r\n`. A chunk of bytes is UTF-8, and a character that a
 * chunk cuts waits for the next chunk. A part longer than `maxLength` characters with no line end comes out as one line.
 */
export function createLineSplitter(maxLength = 65_536): LineSplitter {
  const decoder = new StringDecoder("utf8");
  let partial = "";
  const cut = (text: string): string => (text.endsWith("\r") ? text.slice(0, -1) : text);
  return {
    push(chunk) {
      const text = partial + (typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
      const parts = text.split("\n");
      partial = parts.pop() ?? "";
      const lines = parts.map(cut);
      if (partial.length > maxLength) {
        lines.push(partial);
        partial = "";
      }
      return lines;
    },
    flush() {
      const rest = partial + decoder.end();
      partial = "";
      return rest.length === 0 ? [] : [cut(rest)];
    },
  };
}
