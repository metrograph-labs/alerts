import type { Reply } from "polite-crawler/api";
import { describe, expect, it } from "vitest";
import { answerStore } from "./replay.ts";

const URL_A = "https://alerts.test/a";
const URL_B = "https://alerts.test/b";

const reply = (body: string, etag: string): Reply => ({ status: 200, statusText: "OK", headers: { "content-type": "application/geo+json", etag }, body });

describe("answerStore", () => {
  it("gives the kept reply and its extra values again, with the same body", async () => {
    const store = answerStore<{ readonly fetched: number }>();
    // The text has letters of 2, 3 and 4 bytes in UTF-8.
    const body = JSON.stringify({ features: Array.from({ length: 50 }, (_, index) => ({ id: index, text: "Café → \u{1F32A} take cover." })) });
    store.keep(URL_A, reply(body, '"v1"'), { fetched: 7 });
    expect(await store.get(URL_A)).toEqual({ reply: reply(body, '"v1"'), extra: { fetched: 7 } });
  });

  it("keeps only the last answer of a URL, and one answer for each URL", async () => {
    const store = answerStore<number>();
    store.keep(URL_A, reply("first", '"v1"'), 1);
    store.keep(URL_A, reply("second", '"v2"'), 2);
    store.keep(URL_B, reply("other", '"v9"'), 9);
    expect(await store.get(URL_A)).toEqual({ reply: reply("second", '"v2"'), extra: 2 });
    expect(await store.get(URL_B)).toEqual({ reply: reply("other", '"v9"'), extra: 9 });
  });

  it("gives undefined for a URL with no answer, and after the delete of its answer", async () => {
    const store = answerStore<number>();
    expect(await store.get(URL_A)).toBeUndefined();
    store.keep(URL_A, reply("first", '"v1"'), 1);
    store.delete(URL_A);
    expect(await store.get(URL_A)).toBeUndefined();
  });

  it("gives an empty body again", async () => {
    const store = answerStore<number>();
    store.keep(URL_A, reply("", '"v1"'), 1);
    expect((await store.get(URL_A))?.reply.body).toBe("");
  });
});
