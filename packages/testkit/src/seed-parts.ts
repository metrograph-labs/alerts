/** The parts that the seeded files share (AL-103): made-up text and the byte size of a SQLite file. */
import { statSync } from "node:fs";
import type { Random } from "@mark1russell7/rigor-generators";
import type { openDatabase } from "@mark1russell7/sqlite";

const WORDS = ["alpha", "bravo", "delta", "level", "value", "north", "south", "river", "ridge", "field", "line", "part", "item", "test", "seed", "wind", "rain", "road", "unit", "note"];

/** This function gives made-up words at a length in characters. */
export function textOf(r: Random, length: number): string {
  let text = "";
  while (text.length < length) text += `${r.pick(WORDS)} `;
  return text.slice(0, Math.max(0, length)).trimEnd();
}

/** This function gives one value of a list of values with weights. */
export function choose<T>(r: Random, entries: readonly (readonly [T, number])[]): T {
  return entries[r.weighted(entries.map(([, weight]) => weight))]![0];
}

/**
 * This function gives the bytes of a database from a connection to it. The bytes are the count of pages times the size
 * of a page. The count includes the pages of the write-ahead log. The sum of the file and the write-ahead log counts a
 * page two times when the log has a new copy of it.
 */
export function pagesOf(reader: ReturnType<typeof openDatabase>): number {
  const count = reader.prepare("PRAGMA page_count").get() as { readonly page_count: number };
  const size = reader.prepare("PRAGMA page_size").get() as { readonly page_size: number };
  return count.page_count * size.page_size;
}

/** This function gives the bytes of a file and its write-ahead log. A missing file has 0 bytes. */
export function fileBytes(path: string): number {
  const size = (file: string): number => {
    try {
      return statSync(file).size;
    } catch {
      return 0;
    }
  };
  return size(path) + size(`${path}-wal`);
}
