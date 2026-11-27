import { readFileSync } from "node:fs";
import type { Cursor, FetchOutcome } from "@mark1russell7/alerts";
import { fakeWallClock } from "@mark1russell7/algebra/clock";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fakeSessions, type FakeSession } from "./fake.ts";
import { cursorOf, failureOf, markOf, positionOf } from "./fetch.ts";
import { createNwwsSource } from "./index.ts";
import type { RoomProduct } from "./session.ts";

const PRODUCTS: readonly (RoomProduct & { readonly received: number })[] = JSON.parse(readFileSync(new URL("../fixtures/products-20261116T2002Z.json", import.meta.url), "utf8"));
// The fixture holds a product of the history, a text product, the keepalive and three alerts, in this order.
const [HISTORY, TEXT, KEEPALIVE, MARINE, WIND, FREEZE] = PRODUCTS.map((entry) => ({ attributes: entry.attributes, text: entry.text, delayed: entry.delayed })) as [RoomProduct, RoomProduct, RoomProduct, RoomProduct, RoomProduct, RoomProduct];
const START = PRODUCTS[0]!.received;
const MINUTE = 60_000;
const watch = { places: [] };

function setup(options: { readonly epoch?: string; readonly onOpen?: (session: FakeSession) => void } = {}) {
  const clock = fakeWallClock(START);
  const fake = fakeSessions(options.onOpen ?? ((session) => session.join()));
  const source = createNwwsSource({
    account: { username: "operator", password: "a-password" },
    clock,
    open: fake.open,
    random: () => 0,
    nickname: () => "alerts-test",
    epoch: options.epoch ?? "a",
    // The products of a test come far apart: no session of a test stalls.
    stallAfter: 30 * MINUTE,
    room: "room@conference.example.org",
  });
  return { clock, fake, source };
}

/** This function gives a good outcome. Each good outcome of the source has a cursor. */
function ok(outcome: FetchOutcome): Extract<FetchOutcome, { ok: true }> & { readonly cursor: Cursor } {
  if (!outcome.ok) throw new Error(outcome.failure.message);
  const { cursor } = outcome;
  if (cursor === undefined) throw new Error("The outcome has no cursor.");
  return { ...outcome, cursor };
}

const events = (outcome: FetchOutcome) => ok(outcome).observations.map((observation) => /<event>([^<]+)<\/event>/.exec(observation.body)?.[1]);

describe("the fetch of the source", () => {
  it("starts the session at the first fetch, and gives the new CAP products after the cursor", async () => {
    const { clock, fake, source } = setup();
    expect(fake.sessions).toHaveLength(0);
    const first = ok(await source.fetch({ watch }));
    expect(fake.sessions).toHaveLength(1);
    expect(first).toEqual({ ok: true, observations: [], cursor: { epoch: "a", seq: "0", losses: "0" }, complete: true });
    for (const product of [HISTORY, TEXT, KEEPALIVE, MARINE]) fake.last().send(product);
    await clock.advance(1000);
    const second = ok(await source.fetch({ watch, cursor: first.cursor }));
    expect(events(second)).toEqual(["Test Message", "Special Marine Warning"]);
    expect(second.observations[0]).toMatchObject({ source: "nwws", contentType: "application/xml", fetched: START, transport: { url: "xmpp:room@conference.example.org" } });
    expect(second.observations[0]?.body.startsWith("<?xml")).toBe(true);
    // The fixture skips sequence numbers between its products: each skip is a loss.
    expect(second.cursor).toEqual({ epoch: "a", seq: "2", losses: "3", at: String(START), "serial:nwws_processor": "3268" });
    expect(second.complete).toBe(false);
  });

  it("gives the newest keepalive again in each fetch, with the time of the fetch, for the canary", async () => {
    const { clock, fake, source } = setup();
    const first = ok(await source.fetch({ watch }));
    fake.last().send(KEEPALIVE);
    const second = ok(await source.fetch({ watch, cursor: first.cursor }));
    await clock.advance(5 * MINUTE);
    fake.last().send(WIND);
    const third = ok(await source.fetch({ watch, cursor: second.cursor }));
    expect(events(third)).toEqual(["High Wind Watch", "Test Message"]);
    expect(third.observations[1]).toEqual({ ...second.observations[0], fetched: START + 5 * MINUTE });
    expect(source.check?.({ observations: third.observations })?.pass).toBe(true);
    await clock.advance(13 * MINUTE);
    fake.last().send(FREEZE);
    const late = ok(await source.fetch({ watch, cursor: third.cursor }));
    expect(source.check?.({ observations: late.observations })).toMatchObject({ pass: false, late: true });
  });

  it("gives no read of the canary in the first 15 minutes of each session with no keepalive, and fails after them", async () => {
    const { clock, fake, source } = setup();
    const first = ok(await source.fetch({ watch }));
    fake.last().send(WIND);
    const second = ok(await source.fetch({ watch, cursor: first.cursor }));
    expect(source.check?.({ observations: second.observations })).toBeUndefined();
    await clock.advance(15 * MINUTE);
    const third = ok(await source.fetch({ watch, cursor: second.cursor }));
    expect(source.check?.({ observations: third.observations })).toEqual({ pass: false, reason: "the fetch has no keepalive message of the NWS" });
    // A session that ends has no join time, so the check fails. The next session gives no read again.
    fake.last().end("the server closed the stream", "network");
    expect(source.check?.({ observations: [] })).toMatchObject({ pass: false });
    await clock.advance(5_000);
    expect(fake.sessions).toHaveLength(2);
    fake.last().send(FREEZE);
    const fourth = ok(await source.fetch({ watch, cursor: third.cursor }));
    expect(source.check?.({ observations: fourth.observations })).toBeUndefined();
  });

  it("tells a gap of the stream as an incomplete fetch, one time", async () => {
    const { fake, source } = setup();
    const first = ok(await source.fetch({ watch }));
    fake.last().send(MARINE);
    const second = ok(await source.fetch({ watch, cursor: first.cursor }));
    expect(second.complete).toBe(true);
    // The fixture skips sequence numbers after the marine warning.
    fake.last().send(WIND);
    const third = ok(await source.fetch({ watch, cursor: second.cursor }));
    expect(third.complete).toBe(false);
    expect(third.cursor?.["losses"]).toBe("1");
    expect(ok(await source.fetch({ watch, cursor: third.cursor })).complete).toBe(true);
  });

  it("fails with the reason of the end while the source has no session, and gives the buffer when it has products", async () => {
    const { clock, fake, source } = setup();
    const first = ok(await source.fetch({ watch }));
    fake.last().send(MARINE);
    fake.last().end("the login failed", "auth");
    const second = ok(await source.fetch({ watch, cursor: first.cursor }));
    expect(events(second)).toEqual(["Special Marine Warning"]);
    expect(await source.fetch({ watch, cursor: second.cursor })).toEqual({ ok: false, failure: { kind: "auth", message: "the session of NWWS-OI ended: the login failed" } });
    // The next session opens after the default backoff of 5 s. The random number 0 gives no jitter.
    await clock.advance(4999);
    expect(fake.sessions).toHaveLength(1);
    await clock.advance(1);
    expect(fake.sessions).toHaveLength(2);
    expect(ok(await source.fetch({ watch, cursor: second.cursor })).observations).toEqual([]);
  });

  it("waits for the join at most 20 s, and stops the wait at the abort of the signal", async () => {
    const { clock, source } = setup({ onOpen: () => undefined });
    let outcome: FetchOutcome | undefined;
    void source.fetch({ watch }).then((given) => (outcome = given));
    await clock.advance(20_000 - 1);
    expect(outcome).toBeUndefined();
    await clock.advance(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(outcome).toEqual({ ok: false, failure: { kind: "network", message: "the session of NWWS-OI is not in the room yet" } });
    const controller = new AbortController();
    const aborted = source.fetch({ watch }, controller.signal);
    controller.abort();
    expect(await aborted).toMatchObject({ ok: false });
    await source.close();
    expect(await source.fetch({ watch })).toEqual({ ok: false, failure: { kind: "network", message: "the source of NWWS-OI is closed" } });
  });

  it("starts a new process from the place in the cursor: the history after it, and no product twice", async () => {
    const before = setup({ epoch: "a" });
    const first = ok(await before.source.fetch({ watch }));
    before.fake.last().send(KEEPALIVE);
    const cursor = ok(await before.source.fetch({ watch, cursor: first.cursor })).cursor;
    await before.source.close();
    const after = setup({ epoch: "b" });
    await after.clock.advance(10 * MINUTE);
    const restart = ok(await after.source.fetch({ watch, cursor }));
    expect(after.fake.last().options.history).toEqual({ since: START - 2 * MINUTE, maxStanzas: 1000 });
    expect(restart.complete).toBe(true);
    // The room sends the keepalive again from its history. The new process saw it, from the cursor.
    after.fake.last().send({ ...KEEPALIVE, delayed: true });
    after.fake.last().send({ ...MARINE, delayed: true });
    const next = ok(await after.source.fetch({ watch, cursor: restart.cursor }));
    expect(events(next)).toEqual(["Special Marine Warning"]);
    expect(next.cursor?.["epoch"]).toBe("b");
  });
});

describe("the cursor", () => {
  it("holds the position in the buffer and the place in the stream", () => {
    const cursor = cursorOf("e", { seq: 4, losses: 1 }, { at: 1000, serials: { p: 7, q: 2 } });
    expect(cursor).toEqual({ epoch: "e", seq: "4", losses: "1", at: "1000", "serial:p": "7", "serial:q": "2" });
    expect(positionOf(cursor, "e")).toEqual({ seq: 4, losses: 1 });
    expect(positionOf(cursor, "f")).toBeUndefined();
    expect(markOf(cursor)).toEqual({ at: 1000, serials: { p: 7, q: 2 } });
    expect(markOf(undefined)).toBeUndefined();
    expect(markOf(cursorOf("e", { seq: 0, losses: 0 }, undefined))).toBeUndefined();
  });

  it("keeps the serial of a processor with the name of a property of objects", () => {
    // The counterexample of the property below: a processor named `__proto__` lost its serial.
    const serials = Object.fromEntries([["__proto__", 3], ["constructor", 5]]);
    const mark = markOf(cursorOf("e", { seq: 0, losses: 0 }, { at: 0, serials }));
    expect(Object.entries(mark?.serials ?? {})).toEqual([["__proto__", 3], ["constructor", 5]]);
  });

  it("gives back each position and each place, and reads any cursor with no error", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.record({ seq: fc.nat(), losses: fc.nat() }),
        fc.record({ at: fc.nat(), serials: fc.dictionary(fc.stringMatching(/^[a-z_.]{1,12}$/), fc.nat()) }),
        (epoch, position, mark) => {
          const cursor = cursorOf(epoch, position, mark);
          expect(positionOf(cursor, epoch)).toEqual(position);
          expect(markOf(cursor)).toEqual(mark);
        },
      ),
    );
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.string()), (cursor: Cursor) => {
        positionOf(cursor, "e");
        markOf(cursor);
      }),
    );
  });
});

describe("failureOf", () => {
  it("gives the kind of the end of the session as the kind of the failure", () => {
    expect(failureOf({ status: "waiting", failures: 1, ended: { reason: "the room sent no product in 300 s", kind: "timeout", at: 0 } })).toEqual({
      kind: "timeout",
      message: "the session of NWWS-OI ended: the room sent no product in 300 s",
    });
    expect(failureOf({ status: "joining", failures: 0 }).kind).toBe("network");
  });
});
