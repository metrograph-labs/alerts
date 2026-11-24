/**
 * The store of the last full answer of each URL, for the replay of a 304 answer (AL-145). A 304 answer has no body, thus
 * a source gives the observations of the last full answer again. A store of those observations keeps each alert body in
 * memory until the next full answer. Thus the memory grows with the live alerts. This store keeps the body of the answer
 * as compressed bytes. At a 304, the source reads the answer again and gets the same observations.
 *
 * - The compression is `deflateRaw` of `node:zlib`. It operates in the thread pool, thus it does not block the event loop.
 * - The store keeps the extra values of each answer, as its time of fetch and its latency. Thus a new read gives the same observations.
 * - A reply with `bytes` keeps its bytes as they are. Only the text body gets the compression.
 * - A failed compression or expansion rejects the `get` of the URL. The source then has no earlier full answer.
 */
import { promisify } from "node:util";
import { deflateRaw, inflateRaw } from "node:zlib";
import type { Reply } from "polite-crawler/api";

const deflate = promisify(deflateRaw);
const inflate = promisify(inflateRaw);

/** One answer of the store: the reply with its body, and the values that the source kept with it. */
export interface KeptAnswer<Extra> {
  readonly reply: Reply;
  readonly extra: Extra;
}

/** The store of the last full answer of each URL. */
export interface AnswerStore<Extra> {
  /** This method keeps the full answer of a URL in place of the last one. */
  keep(url: string, reply: Reply, extra: Extra): void;
  /** This method gives the last full answer of a URL, or `undefined` when the store has no answer of the URL. */
  get(url: string): Promise<KeptAnswer<Extra> | undefined>;
  /** This method removes the answer of a URL. */
  delete(url: string): void;
}

// One answer in the store. The compression of the body is a promise, thus a 304 that comes first waits for it.
interface Entry<Extra> {
  readonly reply: Omit<Reply, "body">;
  readonly body: Promise<Buffer>;
  readonly extra: Extra;
}

/** This function makes a store of the last full answer of each URL (`AnswerStore`). */
export function answerStore<Extra>(): AnswerStore<Extra> {
  const entries = new Map<string, Entry<Extra>>();
  return {
    keep(url, reply, extra) {
      const { body, ...rest } = reply;
      const entry: Entry<Extra> = { reply: rest, body: deflate(body), extra };
      // A failed compression rejects only the next `get` of the URL. This handler stops an unhandled rejection before it.
      entry.body.catch(() => undefined);
      entries.set(url, entry);
    },
    async get(url) {
      const entry = entries.get(url);
      if (entry === undefined) return undefined;
      const body = (await inflate(await entry.body)).toString("utf8");
      return { reply: { ...entry.reply, body }, extra: entry.extra };
    },
    delete(url) {
      entries.delete(url);
    },
  };
}
