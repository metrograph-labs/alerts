import { fakeWallClock, type WallClock } from "@mark1russell7/algebra/clock";
import { COPY_SUBJECT, copyStages, join, reportId, SYSTEM_SOURCE, type ChannelId, type CopyPeer, type Delivery, type Observation, type ObservationId, type PersonId, type PlaceId, type Report, type ReportId, type SourceId, type SourceProcedures, type WatchedPlace } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { envelope, type RuntimeEvent } from "./events.ts";
import { CLOCK_SKEW_LIMIT, COPY_MAX_AGE, EXCHANGE_LIMIT } from "./copy.ts";
import { EXCHANGE_CHECKPOINT, EXCHANGE_FORMAT, EXCHANGE_PAGE, importOf, importPage, itemProblem, parsePage, sharedItem, sharePage, type ExchangePage, type ImportInput, type ReceivedPage, type SharedItem } from "./exchange.ts";
import { LOUD_STEADY, steadyPasses } from "./instance.ts";
import { openRuntimeLog, type RuntimeLog } from "./log.ts";
import { exchangeWorker, serveEntries, TAKE_NOTE_ITEMS, takeNoteText, type ExchangeCall, type ExchangeRound, type ExchangeWorker, type ExchangeWorkerOptions, type TakeNote } from "./peers.ts";
import { openRuntime, type CopyChecks, type Pass, type Runtime, type RuntimeOptions } from "./runtime.ts";
import { EMPTY_RUNTIME, fold, rebuild, type FoldContext, type RuntimeState } from "./state.ts";

const T0 = Date.UTC(2026, 3, 1, 18, 0, 0);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const API = "api" as SourceId;
const PUSHOVER = "pushover" as ChannelId;
const PERSON = "person-1" as PersonId;
const CONTEXT: FoldContext = { sources: [] };

// A public place in Kansas: Sedgwick County KS.
const KANSAS: WatchedPlace = { id: "place:a" as PlaceId, codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 0 };
const VIEW: RuntimeOptions["view"] = { places: [KANSAS], kinds: ["met"], expectations: [], delay: { quantile: 0.9, level: 0.9 } };

// A value that a problem never shows. A problem of a page holds no value of an event.
const HIDDEN = "hidden-value-7";

/** One tornado warning for Sedgwick County, issued at T0, that a copy received at `received`. */
function report(key: string, received: number): Report {
  return {
    id: reportId({ source: API, key, sent: T0 }),
    source: API,
    origin: "nws",
    key,
    references: [],
    correlation: [],
    status: "actual",
    op: "alert",
    kind: { code: "met.tornado", label: "Tornado Warning" },
    categories: ["met"],
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    response: ["shelter"],
    sent: T0,
    received,
    expires: T0 + 10 * 60 * MINUTE,
    areas: [{ type: "code", system: "ugc", code: "KSZ083" }],
    about: [],
    sender: "w-nws.webmaster@noaa.gov",
    headline: "Tornado Warning",
    observation: `api:${key}` as ObservationId,
    parameters: {},
  };
}

const W1 = report("w1", T0).id;

function delivery(key: string, at: number): Delivery {
  return { key, incident: W1, level: "life-safety", person: PERSON, channel: PUSHOVER, step: 0, at };
}

const started = (run: string, time: number): RuntimeEvent => ({ ...envelope("started", `started:${run}`, time), run });
const fetched = (id: string, time: number, reports: readonly Report[]): RuntimeEvent => ({
  ...envelope("fetch", id, time),
  record: { source: API, at: time, took: 100, fresh: reports.length, fatal: 0 },
  reports,
  problems: [],
});
const delivered = (key: string, time: number, copy?: string): RuntimeEvent => ({ ...envelope("delivery", `delivery:${key}`, time), delivery: delivery(key, time), ...(copy === undefined ? {} : { copy }) });
const acknowledged = (time: number): RuntimeEvent => ({ ...envelope("acknowledgment", "ack:k1", time), acknowledgment: { incident: W1, level: "life-safety", person: PERSON, at: time, via: PUSHOVER } });
const ended = (time: number, reports: readonly ReportId[]): RuntimeEvent => ({ ...envelope("ended", `ended:${API}:${time}`, time), source: API, reports });
const back = (time: number, reports: readonly ReportId[]): RuntimeEvent => ({ ...envelope("back", `back:${API}:${time}`, time), source: API, reports });
const cancelled = (key: string, time: number): RuntimeEvent => ({ ...envelope("cancelled", `cancelled:${key}`, time), delivery: key });
const endOf = (incident: ReportId, time: number): RuntimeEvent => ({ ...envelope("escalation-end", `escalation-end:${incident}:${PERSON}:0`, time), end: { incident, person: PERSON, at: time } });
const stepped = (n: number, time: number, size: number): RuntimeEvent => ({ ...envelope("clock", `clock:${n}`, time), size });
const refused = (key: string, time: number): RuntimeEvent => ({ ...envelope("refused", `refused:${key}@${time}`, time), key, channel: PUSHOVER, kind: "refused", retryAt: time + MINUTE });

/** The shared item of an event of a copy. */
function itemOf(event: RuntimeEvent, copy: string): SharedItem {
  const item = sharedItem(event, copy);
  if (item === undefined) throw new Error(`The event ${event.id} is not a shared event.`);
  return item;
}

/** The import of an event of another copy. */
const imported = (event: RuntimeEvent, copy: string): RuntimeEvent => importOf(itemOf(event, copy));

/** A page of the copy `b`, with the fields of `fields`. */
function page(items: readonly unknown[], fields: Partial<Omit<ReceivedPage, "items">> = {}): ReceivedPage {
  return { format: EXCHANGE_FORMAT, copy: "b", log: "started:run-b", after: 0, next: 10, head: 10, ...fields, items };
}

const input = (fields: Partial<ImportInput> = {}): ImportInput => ({ self: "a", position: undefined, logged: undefined, now: T0 + MINUTE, ...fields });

const foldAll = (events: readonly RuntimeEvent[]): RuntimeState => events.reduce((state, event) => fold(state, event, CONTEXT), EMPTY_RUNTIME);

describe("sharedItem", () => {
  it("gives the reports of a fetch with no record, no cursor and no problems", () => {
    const r = report("w1", T0);
    expect(sharedItem(fetched("fetch:1", T0, [r]), "a")).toEqual({ from: "a", event: { ...envelope("fetch", "fetch:1", T0), reports: [r] } });
  });

  it("gives nothing for a fetch with no report and for each event that stays in its copy", () => {
    expect(sharedItem(fetched("fetch:1", T0, []), "a")).toBeUndefined();
    expect(sharedItem(started("run-a", T0), "a")).toBeUndefined();
    expect(sharedItem(stepped(1, T0, MINUTE), "a")).toBeUndefined();
    expect(sharedItem(refused("k1", T0), "a")).toBeUndefined();
  });

  it("gives a delivery with no copy id, because the copy id is an id of the channel steps of one copy", () => {
    const item = itemOf(delivered("k1", T0, "copy-1"), "a");
    expect(item.event).toEqual({ ...envelope("delivery", "delivery:k1", T0), delivery: delivery("k1", T0) });
    expect(Object.keys(item.event)).not.toContain("copy");
  });

  it("gives each event of the ledger and each end mark as it is", () => {
    for (const event of [acknowledged(T0), ended(T0, [W1]), back(T0, [W1]), cancelled("k1", T0), endOf(W1, T0)]) expect(itemOf(event, "a")).toEqual({ from: "a", event });
  });

  it("gives an import again with the copy that wrote its event", () => {
    const item = itemOf(fetched("fetch:1", T0, [report("w1", T0)]), "c");
    expect(sharedItem(importOf(item), "b")).toEqual(item);
  });
});

describe("itemProblem", () => {
  const good = itemOf(delivered("k1", T0), "b");

  it("gives no problem for a fetch with a report that has no place, as a cancel with no info block (AL-157)", () => {
    const cancel: Report = { ...report("c1", T0), op: "cancel", references: ["w1"], areas: [] };
    expect(itemProblem(itemOf(fetched("fetch:2", T0, [cancel]), "b"))).toBeUndefined();
  });

  it("gives no problem for each shared item", () => {
    const events = [fetched("fetch:1", T0, [report("w1", T0)]), delivered("k1", T0, "copy-1"), acknowledged(T0), ended(T0, [W1]), back(T0, [W1]), cancelled("k1", T0), endOf(W1, T0)];
    for (const event of events) expect(itemProblem(JSON.parse(JSON.stringify(itemOf(event, "b"))))).toBeUndefined();
    expect(itemProblem({ from: "b", event: { ...envelope("ended", "ended:1", T0), source: API, reports: [W1], asOf: T0 } })).toBeUndefined();
  });

  it.each<[string, unknown, string]>([
    ["a list", [HIDDEN], "the item is not an object."],
    ["no copy", { from: `${HIDDEN} B`, event: good.event }, "the item does not have the id of a copy."],
    ["no event", { from: "b" }, "the item does not have an event."],
    ["no time", { from: "b", event: { ...good.event, time: HIDDEN } }, "the envelope of the event is not complete."],
    ["a type of one copy", { from: "b", event: refused(HIDDEN, T0) }, "the event does not have the type of a shared event."],
    ["an unknown field", { from: "b", event: { ...good.event, copy: HIDDEN } }, "the event delivery has the unknown field copy."],
    ["a missing field", { from: "b", event: envelope("delivery", "delivery:k1", T0) }, "the event delivery does not have the field delivery."],
    ["a bad field", { from: "b", event: { ...good.event, delivery: { ...delivery("k1", T0), step: -1, key: HIDDEN } } }, "the field delivery of the event delivery is not valid."],
    ["a bad report", { from: "b", event: { ...envelope("fetch", "fetch:1", T0), reports: [{ ...report("w1", T0), severity: HIDDEN }] } }, "the field reports of the event fetch is not valid."],
    ["an extra field", { from: "b", event: good.event, note: HIDDEN }, "the item has a field other than from and event."],
  ])("gives a problem with no value for %s", (_name, value, problem) => {
    expect(itemProblem(value)).toBe(problem);
  });
});

describe("sharePage", () => {
  const self = { copy: "a", log: "started:run-a" };

  // A log of copy a: one event of each kind of the exchange, and events that stay in the copy.
  function logOf(): RuntimeLog {
    const log = openRuntimeLog(":memory:");
    const events = [
      started("run-a", T0),
      fetched("fetch:1", T0 + SECOND, [report("w1", T0 + SECOND)]),
      fetched("fetch:2", T0 + 2 * SECOND, []),
      stepped(1, T0 + 3 * SECOND, MINUTE),
      delivered("k1", T0 + 4 * SECOND),
      refused("k2", T0 + 5 * SECOND),
      imported(fetched("fetch:1", T0 + 6 * SECOND, [report("w2", T0 + 6 * SECOND)]), "c"),
      endOf(W1, T0 + 7 * SECOND),
    ];
    log.appendAll(events, () => undefined);
    return log;
  }

  it("gives the shared events after a position, and a next position at the head", () => {
    const log = logOf();
    const shared = sharePage(log, self, 0);
    expect(shared).toMatchObject({ format: EXCHANGE_FORMAT, copy: "a", log: "started:run-a", after: 0, next: log.head(), head: log.head() });
    expect(shared.items.map((item) => [item.from, item.event.type])).toEqual([
      ["a", "fetch"],
      ["a", "delivery"],
      ["c", "fetch"],
      ["a", "escalation-end"],
    ]);
  });

  it("gives the same items in pages of each size, and each page starts after the last entry of the page before", () => {
    const log = logOf();
    const whole = sharePage(log, self, 0).items;
    for (const limit of [1, 2, 3, 5]) {
      const items: SharedItem[] = [];
      let after = 0;
      for (let pages = 0; pages < 20; pages += 1) {
        const next = sharePage(log, self, after, limit);
        expect(next.after).toBe(after);
        expect(next.next).toBeGreaterThanOrEqual(after);
        items.push(...next.items);
        if (next.next === after) break;
        after = next.next;
      }
      expect(after).toBe(log.head());
      expect(items).toEqual(whole);
    }
  });

  it("gives an empty page at the position of a read after the head", () => {
    const log = logOf();
    expect(sharePage(log, self, log.head())).toMatchObject({ next: log.head(), items: [] });
    expect(sharePage(log, self, log.head() + 5)).toMatchObject({ next: log.head() + 5, head: log.head(), items: [] });
  });

  it("refuses a position or a limit that is not valid", () => {
    const log = logOf();
    expect(() => sharePage(log, self, -1)).toThrow(RangeError);
    expect(() => sharePage(log, self, 1.5)).toThrow(RangeError);
    expect(() => sharePage(log, self, 0, 0)).toThrow(RangeError);
  });
});

describe("parsePage", () => {
  it("gives a page after a trip through JSON", () => {
    const log = openRuntimeLog(":memory:");
    log.appendAll([started("run-a", T0), delivered("k1", T0)], () => undefined);
    const shared: ExchangePage = sharePage(log, { copy: "a", log: "started:run-a" }, 0);
    const parsed = parsePage(JSON.parse(JSON.stringify(shared)));
    expect(parsed.tag).toBe("ok");
    if (parsed.tag === "ok") expect(parsed.value).toEqual(shared);
  });

  it("gives each problem of the form, with no value", () => {
    expect(parsePage([HIDDEN])).toEqual({ tag: "err", error: ["The page is not an object."] });
    const parsed = parsePage({ format: HIDDEN, copy: `${HIDDEN} B`, log: "", after: -1, next: 1.5, head: HIDDEN, items: HIDDEN });
    expect(parsed.tag).toBe("err");
    if (parsed.tag !== "err") return;
    expect(parsed.error).toEqual([
      `The page does not have the format ${EXCHANGE_FORMAT}.`,
      "The page does not have the id of a copy.",
      "The page does not have the id of a log.",
      "The field after of the page is not an integer of 0 or more.",
      "The field next of the page is not an integer of 0 or more.",
      "The field head of the page is not an integer of 0 or more.",
      "The page does not have a list of items.",
    ]);
    expect(parsed.error.join(" ")).not.toContain(HIDDEN);
  });

  it("refuses a page with a next position below its start", () => {
    const parsed = parsePage(page([], { after: 8, next: 4 }));
    expect(parsed.tag === "err" ? parsed.error : []).toEqual(["The field next of the page is below its field after."]);
  });
});

describe("importOf", () => {
  it("gives the id of the copy before the id of an event of a source, because each copy gives its own ids to them", () => {
    for (const event of [fetched("fetch:1", T0, [report("w1", T0)]), ended(T0, [W1]), back(T0, [W1])]) expect(importOf(itemOf(event, "b")).id).toBe(`b/${event.id}`);
  });

  it("keeps the id of a step of the ledger, because two copies that do one step write one event", () => {
    for (const event of [delivered("k1", T0), acknowledged(T0), cancelled("k1", T0), endOf(W1, T0)]) expect(importOf(itemOf(event, "b")).id).toBe(event.id);
  });

  it("keeps the envelope of the event of the other copy", () => {
    const event = delivered("k1", T0 + 3 * SECOND);
    expect(importOf(itemOf(event, "b"))).toEqual({ id: event.id, at: event.at, type: "import", time: event.time, from: "b", event: itemOf(event, "b").event });
  });
});

describe("importPage", () => {
  const items = [itemOf(fetched("fetch:1", T0, [report("w1", T0)]), "b"), itemOf(delivered("k1", T0), "b")];
  const position = (next: number, log = "started:run-b") => ({ log, next });

  it("imports the items of another copy, and writes the position with them", () => {
    const result = importPage(page(items), input());
    expect(result.imports).toBe(2);
    expect(result.problems).toEqual([]);
    expect(result.position).toEqual(position(10));
    expect(result.events).toEqual([
      ...items.map((item) => importOf(item)),
      { ...envelope("exchange", "exchange:b:started:run-b:10", T0 + MINUTE), peer: "b", log: "started:run-b", next: 10 },
    ]);
  });

  it("skips each item that this copy wrote, because it came back from the other copy", () => {
    const result = importPage(page([itemOf(delivered("k1", T0), "a"), items[1]]), input());
    expect(result.imports).toBe(1);
    expect(result.events.flatMap((event) => (event.type === "import" ? [event.from] : []))).toEqual(["b"]);
  });

  it("refuses a page of its own copy with a problem", () => {
    const result = importPage(page(items, { copy: "a" }), input());
    expect(result.events).toEqual([]);
    expect(result.problems).toEqual(["The copy a reads its own log. Give the URL of another copy."]);
  });

  it("refuses a page that starts after the position, because it skips entries", () => {
    const result = importPage(page(items, { after: 7, next: 12 }), input({ position: position(5), logged: position(5) }));
    expect(result).toEqual({ events: [], imports: 0, position: position(5), problems: [] });
  });

  it("starts the read of a new log of the copy at 0", () => {
    const old = position(50, "started:run-old");
    expect(importPage(page(items, { after: 20, next: 30 }), input({ position: old, logged: old }))).toEqual({ events: [], imports: 0, position: position(0), problems: [] });
    const result = importPage(page(items, { after: 0, next: 30 }), input({ position: position(0), logged: old }));
    expect(result.imports).toBe(2);
    expect(result.events.at(-1)).toMatchObject({ type: "exchange", log: "started:run-b", next: 30 });
  });

  it("reads a page again with no new position, and never moves the position back", () => {
    const result = importPage(page(items, { after: 0, next: 8 }), input({ position: position(10), logged: position(10) }));
    expect(result.position).toEqual(position(10));
    expect(result.events.map((event) => event.type)).toEqual(["import", "import"]);
  });

  it("writes a position with no import only after a checkpoint of entries", () => {
    const logged = position(10);
    const near = importPage(page([], { after: 10, next: 10 + EXCHANGE_CHECKPOINT - 1 }), input({ position: logged, logged }));
    expect(near.events).toEqual([]);
    expect(near.position).toEqual(position(10 + EXCHANGE_CHECKPOINT - 1));
    const far = importPage(page([], { after: near.position.next, next: 10 + EXCHANGE_CHECKPOINT }), input({ position: near.position, logged }));
    expect(far.events).toEqual([{ ...envelope("exchange", `exchange:b:started:run-b:${10 + EXCHANGE_CHECKPOINT}`, T0 + MINUTE), peer: "b", log: "started:run-b", next: 10 + EXCHANGE_CHECKPOINT }]);
  });

  it("writes the first position in a log of the copy with no import", () => {
    expect(importPage(page([], { next: 4 }), input()).events).toMatchObject([{ type: "exchange", next: 4 }]);
  });

  it("gives a problem for each bad item, and imports the other items", () => {
    const result = importPage(page([items[0], { from: "b", event: { ...items[1]!.event, copy: HIDDEN } }, items[1]]), input());
    expect(result.imports).toBe(2);
    expect(result.problems).toEqual(["The item 1 of the page of b after 0: the event delivery has the unknown field copy."]);
  });
});

describe("the fold of the imports", () => {
  const own = report("w1", T0 + SECOND);
  // The other copy received the same report later, and a second report that only it sees.
  const theirs = [report("w1", T0 + 2 * SECOND), report("w2", T0 + 2 * SECOND)];
  const W2 = theirs[1]!.id;
  const events: RuntimeEvent[] = [
    started("run-a", T0),
    fetched("fetch:1", T0 + SECOND, [own]),
    imported(fetched("fetch:1", T0 + 2 * SECOND, theirs), "b"),
    delivered("k1", T0 + 3 * SECOND),
    refused("k2", T0 + 4 * SECOND),
    stepped(1, T0 + 5 * SECOND + 5 * MINUTE, 5 * MINUTE),
    imported(delivered("k2", T0 + 6 * SECOND), "b"),
    imported(acknowledged(T0 + 7 * SECOND), "b"),
    imported(ended(T0 + 8 * SECOND, [W2]), "b"),
    imported(endOf(W2, T0 + 9 * SECOND), "b"),
    endOf(W1, T0 + 10 * SECOND + 5 * MINUTE),
    imported(cancelled("k2", T0 + 11 * SECOND), "b"),
    { ...envelope("exchange", "exchange:b:started:run-b:12", T0 + 12 * SECOND + 5 * MINUTE), peer: "b", log: "started:run-b", next: 12 },
  ];

  it("gives the state of the rebuild after each event", () => {
    for (let count = 1; count <= events.length; count += 1) expect(foldAll(events.slice(0, count))).toEqual(rebuild(events.slice(0, count), CONTEXT));
  });

  it("joins the merge of the two sides", () => {
    const state = foldAll(events);
    expect(state.merge).toEqual(join(state.own.merge, state.imported.merge));
    expect(state.merge.reports.map((report) => report.id).sort()).toEqual([W1, W2].sort());
    expect(state.merge.deliveries.map((one) => one.key).sort()).toEqual(["k1", "k2"]);
    expect(state.own.merge.deliveries.map((one) => one.key)).toEqual(["k1"]);
  });

  it("moves the own parts at a step of the clock, and never the imported parts", () => {
    const state = foldAll(events);
    expect(state.own.merge.reports.map((report) => report.received)).toEqual([T0 + SECOND + 5 * MINUTE]);
    expect(state.own.merge.deliveries.map((one) => one.at)).toEqual([T0 + 3 * SECOND + 5 * MINUTE]);
    expect(state.imported.merge.reports.map((report) => report.received)).toEqual([T0 + 2 * SECOND, T0 + 2 * SECOND]);
    expect(state.imported.merge.deliveries.map((one) => one.at)).toEqual([T0 + 6 * SECOND]);
    expect(state.escalationEnds).toEqual([
      { incident: W1, person: PERSON, at: T0 + 10 * SECOND + 5 * MINUTE },
      { incident: W2, person: PERSON, at: T0 + 9 * SECOND },
    ]);
  });

  it("keeps the time of the state, because an import has the time of another clock", () => {
    const late = imported(delivered("k9", T0 + 60 * MINUTE), "b");
    expect(foldAll([...events, late]).time).toBe(foldAll(events).time);
  });

  it("ends the refusal of a key that the other copy delivered, and adds its cancel", () => {
    const before = foldAll(events.slice(0, 6));
    expect(Object.keys(before.refusals)).toEqual(["k2"]);
    const state = foldAll(events);
    expect(state.refusals).toEqual({});
    expect(state.cancelled).toEqual(["k2"]);
    expect(state.exchanges).toEqual({ b: { log: "started:run-b", next: 12 } });
  });

  it("keeps one end of an episode when the two copies end it, because the log keeps the first event of an id", () => {
    const log = openRuntimeLog(":memory:");
    let state = EMPTY_RUNTIME;
    const append = (list: readonly RuntimeEvent[]) => log.appendAll(list, (event) => (state = fold(state, event, CONTEXT)));
    append([started("run-a", T0), imported(endOf(W1, T0 + SECOND), "b")]);
    expect(append([endOf(W1, T0 + 2 * SECOND)])).toEqual([`escalation-end:${W1}:${PERSON}:0`]);
    expect(state.escalationEnds).toEqual([{ incident: W1, person: PERSON, at: T0 + SECOND }]);
    expect(rebuild(log.read(), CONTEXT)).toEqual(state);
  });
});

describe("two runtimes", () => {
  const observation = (key: string, fetchedAt: number): Observation => ({
    id: `api:${key}` as ObservationId,
    source: API,
    fetched: fetchedAt,
    contentType: "application/json",
    body: JSON.stringify({ key }),
    transport: { latency: 0 },
  });

  // A source that gives the same warnings at each fetch.
  function source(keys: readonly string[], clock: WallClock): SourceProcedures {
    return {
      describe: () => ({
        id: API,
        title: "The source api",
        origins: ["nws"],
        dependsOn: ["provider:api"],
        uses: ["internet", "dns", "power"],
        kinds: ["met"],
        coverage: [{ type: "code", system: "ugc", code: "KSZ083" }],
        transport: "poll",
        interval: MINUTE,
        slowAfter: 10_000,
        auth: "none",
      }),
      fetch: async () => ({ ok: true, observations: keys.map((key) => observation(key, clock.now())), complete: true }),
      map: ({ observation: seen }) => ({ reports: [report((JSON.parse(seen.body) as { readonly key: string }).key, seen.fetched)], problems: [] }),
    };
  }

  function open(copy: string, keys: readonly string[], clock: WallClock, log: RuntimeLog = openRuntimeLog(":memory:"), run = `run-${copy}`): { readonly runtime: Runtime; readonly log: RuntimeLog } {
    const runtime = openRuntime({ log, clock, sources: [source(keys, clock)], watch: () => ({ places: [KANSAS], kinds: ["met"] }), view: VIEW, run, copy });
    return { runtime, log };
  }

  // The shared part of the merge state. The system reports of a copy tell its own health, thus they stay in the copy.
  const shared = (state: RuntimeState): RuntimeState["merge"] => ({ ...state.merge, reports: state.merge.reports.filter((one) => one.source !== SYSTEM_SOURCE) });

  // The read of one page of a copy by another copy, through JSON as on the wire.
  function read(reader: Runtime, writer: Runtime, copy: string) {
    const parsed = parsePage(JSON.parse(JSON.stringify(writer.share(reader.position(copy)))));
    if (parsed.tag !== "ok") throw new Error(parsed.error.join(" "));
    return { page: parsed.value, take: reader.take(parsed.value) };
  }

  it("reach the same merge state after each copy reads the other", async () => {
    const clock = fakeWallClock(T0);
    const a = open("a", ["w1"], clock);
    const b = open("b", ["w1", "w2"], clock);
    await a.runtime.pass();
    await b.runtime.pass();
    expect(shared(a.runtime.state())).not.toEqual(shared(b.runtime.state()));

    const first = read(a.runtime, b.runtime, "b");
    expect(first.take.imports).toBeGreaterThan(0);
    expect(first.take.problems).toEqual([]);
    // A second take of one page adds no event and changes nothing.
    const state = a.runtime.state();
    const head = a.log.head();
    expect(a.runtime.take(first.page)).toEqual({ ...first.take, conflicts: [] });
    expect(a.log.head()).toBe(head);
    expect(a.runtime.state()).toEqual(state);

    read(b.runtime, a.runtime, "a");
    // The page of b now holds the imports of a. The read skips them, because a wrote them.
    expect(read(a.runtime, b.runtime, "b").take.imports).toBe(0);

    expect(shared(a.runtime.state())).toEqual(shared(b.runtime.state()));
    expect(shared(a.runtime.state()).reports.map((one) => one.key).sort()).toEqual(["w1", "w2"]);
    expect(rebuild(a.log.read(), a.runtime.config)).toEqual(a.runtime.state());
    expect(rebuild(b.log.read(), b.runtime.config)).toEqual(b.runtime.state());
  });

  it("reads on after a restart from the position in the log", async () => {
    const clock = fakeWallClock(T0);
    const a = open("a", ["w1"], clock);
    const b = open("b", ["w2"], clock);
    await b.runtime.pass();
    const { take } = read(a.runtime, b.runtime, "b");
    expect(take.next).toBe(b.log.head());

    const restarted = open("a", ["w1"], clock, a.log, "run-a2");
    expect(restarted.runtime.position("b")).toBe(take.next);
    expect(read(restarted.runtime, b.runtime, "b").take).toEqual({ imports: 0, next: take.next, problems: [], conflicts: [] });
    expect(restarted.runtime.state().imported.merge.reports.map((one) => one.key)).toEqual(["w2"]);
  });

  // The salvage of a broken file: a new file gets the events of the old file, with new positions, and then one recovery.
  function salvage(old: RuntimeLog, quarantine: string): RuntimeLog {
    const recovered: RuntimeEvent = { ...envelope("recovered", `recovered:${quarantine}`, T0), quarantine, fault: "corrupt", read: 0, added: 0, lost: 0, whole: true, problems: [] };
    const salvaged = openRuntimeLog(":memory:");
    salvaged.appendAll([...old.read(), recovered], () => undefined);
    return salvaged;
  }

  it("reads a recovered log of another copy again from the start, because the salvage gives new positions", async () => {
    const clock = fakeWallClock(T0);
    const a = open("a", ["w1"], clock);
    const b = open("b", ["w2"], clock);
    await b.runtime.pass();
    const before = read(a.runtime, b.runtime, "b");
    const merged = shared(a.runtime.state());

    const recovered = open("b", ["w2"], clock, salvage(b.log, "events.db.broken-1"), "run-b2");
    const refused = read(a.runtime, recovered.runtime, "b");
    expect(refused.page.log).toBe("recovered:events.db.broken-1");
    expect(refused.page.log).not.toBe(before.page.log);
    expect(refused.take).toEqual({ imports: 0, next: 0, problems: [], conflicts: [] });

    const again = read(a.runtime, recovered.runtime, "b");
    expect(again.page.after).toBe(0);
    expect(again.take).toEqual({ imports: before.take.imports, next: recovered.log.head(), problems: [], conflicts: [] });
    expect(shared(a.runtime.state())).toEqual(merged);
    expect(rebuild(a.log.read(), a.runtime.config)).toEqual(a.runtime.state());
  });

  it("reads each other copy again from the start after a recovery of its own log, because the salvage can lose an import", async () => {
    const clock = fakeWallClock(T0);
    const a = open("a", ["w1"], clock);
    const b = open("b", ["w2"], clock);
    await b.runtime.pass();
    const { take } = read(a.runtime, b.runtime, "b");
    expect(take.next).toBeGreaterThan(0);

    const recovered = open("a", ["w1"], clock, salvage(a.log, "events.db.broken-2"), "run-a2");
    expect(recovered.runtime.position("b")).toBe(0);
    expect(read(recovered.runtime, b.runtime, "b").take).toEqual({ imports: take.imports, next: take.next, problems: [], conflicts: [] });
    expect(recovered.runtime.state().imported.merge.reports.map((one) => one.key)).toEqual(["w2"]);
  });
  describe("the exchange worker", () => {
    const HASH = "config-hash-1";
    const B: CopyPeer = { id: "b", url: "http://copy-b.example.test:4751" };
    // The answer of a call, through JSON as on the wire.
    const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
    const serve =
      (writer: Runtime, clock: WallClock): ExchangeCall =>
      async (_peer, input) =>
        wire(serveEntries({ runtime: writer, clock, configHash: HASH }, input));
    const hanging: ExchangeCall = (_peer, _input, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const workerOf = (reader: Runtime, call: ExchangeCall, clock: WallClock, extra: Partial<Pick<ExchangeWorkerOptions, "pages" | "entries">> = {}): ExchangeWorker =>
      exchangeWorker({ runtime: reader, peers: [B], call, clock, configHash: HASH, ...extra });
    const stagesOf = (worker: ExchangeWorker, at: number) => copyStages(worker.watches()[0]!, at);
    const quiet: ExchangeRound = { imports: 0, more: false, changed: false, problems: [], conflicts: [] };
    // A turn of the event loop: each promise that is ready runs.
    const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

    it("brings two copies to the same shared state, and a second round imports nothing", async () => {
      const clock = fakeWallClock(T0);
      const a = open("a", ["w1"], clock);
      const b = open("b", ["w1", "w2"], clock);
      await a.runtime.pass();
      await b.runtime.pass();
      const readsB = workerOf(a.runtime, serve(b.runtime, clock), clock);
      const readsA = exchangeWorker({ runtime: b.runtime, peers: [{ id: "a", url: "http://copy-a.example.test:4751" }], call: serve(a.runtime, clock), clock, configHash: HASH });

      const first = await readsB.round();
      expect(first).toMatchObject({ more: false, changed: true, problems: [], conflicts: [] });
      expect(first.imports).toBeGreaterThan(0);
      await readsA.round();
      expect(shared(a.runtime.state())).toEqual(shared(b.runtime.state()));

      expect(await readsB.round()).toEqual(quiet);
      expect(readsB.watches()).toEqual([{ copy: "b", skewLimit: CLOCK_SKEW_LIMIT, maxAge: COPY_MAX_AGE, since: T0, read: { at: T0, skew: 0, sameConfig: true } }]);
      expect(stagesOf(readsB, clock.now())).toEqual([]);
      expect(readsB.failure("b")).toBeUndefined();
    });

    it("gives a note at the end of a slow import of a page, and no note for a small fast page (AL-222)", async () => {
      const clock = fakeWallClock(T0);
      const a = open("a", [], clock);
      const b = open("b", ["w1"], clock);
      await b.runtime.pass();
      const notes: TakeNote[] = [];
      // Each read of the clock of the imports is 2 s after the read before it. Thus each import takes 2 s.
      let mono = 0;
      const slow = exchangeWorker({ runtime: a.runtime, peers: [B], call: serve(b.runtime, clock), clock, configHash: HASH, onTake: (note) => notes.push(note), mono: () => (mono += 2_000) });
      await slow.round();
      expect(notes).toEqual([{ phase: "end", copy: "b", after: 0, items: expect.any(Number), imports: expect.any(Number), next: a.runtime.position("b"), ms: 2_000 }]);
      expect(notes[0]!.items).toBeLessThan(TAKE_NOTE_ITEMS);
      const fast: TakeNote[] = [];
      const c = open("c", [], clock);
      await exchangeWorker({ runtime: c.runtime, peers: [B], call: serve(b.runtime, clock), clock, configHash: HASH, onTake: (note) => fast.push(note), mono: () => 0 }).round();
      expect(fast).toEqual([]);
    });

    it("gives the lines of the notes with ids, positions and counts only (AL-222)", () => {
      expect(takeNoteText({ phase: "start", copy: "b", after: 10, items: 500, head: 9_000 })).toBe("The exchange imports a page of the copy b: 500 items after the position 10, of the head 9000.");
      expect(takeNoteText({ phase: "end", copy: "b", after: 10, items: 500, imports: 480, next: 510, ms: 1_234.6 })).toBe(
        "The import of the page of the copy b after the position 10 took 1235 ms: 480 imports of 500 items, the next position is 510.",
      );
    });

    it("reads a copy that is far behind over many pages, and tells that the next round goes on at once", async () => {
      const clock = fakeWallClock(T0);
      const a = open("a", [], clock);
      const b = open("b", ["w1", "w2", "w3", "w4"], clock);
      // Each pass writes one shared event of its fetch. Thus four passes give four pages of one entry.
      for (let pass = 0; pass < 4; pass += 1) {
        await b.runtime.pass();
        // Two intervals of the source, thus each pass fetches.
        await clock.advance(2 * MINUTE);
      }
      const worker = workerOf(a.runtime, serve(b.runtime, clock), clock, { entries: 1, pages: 2 });
      const rounds: ExchangeRound[] = [];
      do rounds.push(await worker.round());
      while (rounds.at(-1)!.more && rounds.length < 100);
      expect(rounds.length).toBeGreaterThan(1);
      expect(rounds[0]!.more).toBe(true);
      expect(rounds.at(-1)!.more).toBe(false);
      expect(a.runtime.position("b")).toBe(b.log.head());
      expect([...new Set(shared(a.runtime.state()).reports.map((one) => one.key))].sort()).toEqual(["w1", "w2", "w3", "w4"]);
      expect(shared(a.runtime.state())).toEqual(shared(b.runtime.state()));
    });

    it("gives the stages skew and config, and a read with the same clock and configuration ends them", async () => {
      const clock = fakeWallClock(T0);
      const a = open("a", [], clock);
      const b = open("b", [], clock);
      let offset = 5 * SECOND;
      let configHash = "config-hash-2";
      const worker = workerOf(
        a.runtime,
        async (_peer, input) => {
          const output = serveEntries({ runtime: b.runtime, clock, configHash }, input);
          return wire({ ...output, time: output.time + offset });
        },
        clock,
      );
      expect(await worker.round()).toMatchObject({ imports: 0, changed: true });
      expect(worker.watches()[0]!.read).toEqual({ at: T0, skew: 5 * SECOND, sameConfig: false });
      expect(stagesOf(worker, clock.now())).toEqual(["skew", "config"]);

      // A difference of the limit is not above the limit.
      offset = -CLOCK_SKEW_LIMIT;
      configHash = HASH;
      expect((await worker.round()).changed).toBe(true);
      expect(stagesOf(worker, clock.now())).toEqual([]);
    });

    it("gives the stage unread when no read passes for the maximum age, and a read ends it", async () => {
      const clock = fakeWallClock(T0);
      const a = open("a", [], clock);
      const b = open("b", ["w1"], clock);
      await b.runtime.pass();
      let down = true;
      const serving = serve(b.runtime, clock);
      const worker = workerOf(
        a.runtime,
        async (peer, input, signal) => {
          if (down) throw new Error("The copy refused the connection.");
          return serving(peer, input, signal);
        },
        clock,
      );
      expect(await worker.round()).toEqual(quiet);
      expect(worker.failure("b")).toBe("The read of the copy b failed: The copy refused the connection.");
      expect(worker.watches()[0]!.read).toBeUndefined();
      expect(stagesOf(worker, T0 + COPY_MAX_AGE - 1)).toEqual([]);
      expect(stagesOf(worker, T0 + COPY_MAX_AGE)).toEqual(["unread"]);

      await clock.advance(COPY_MAX_AGE);
      down = false;
      const back = await worker.round();
      expect(back.changed).toBe(true);
      expect(back.imports).toBeGreaterThan(0);
      expect(worker.failure("b")).toBeUndefined();
      expect(stagesOf(worker, clock.now())).toEqual([]);
    });

    it("fails a read past its time limit, a bad answer and a page of another copy, with no value in a message", async () => {
      const clock = fakeWallClock(T0);
      const a = open("a", [], clock);
      const b = open("b", ["w1"], clock);
      const c = open("c", ["w1"], clock);
      await b.runtime.pass();
      await c.runtime.pass();
      const head = a.log.head();

      const slow = workerOf(a.runtime, hanging, clock);
      const running = slow.round();
      await clock.advance(EXCHANGE_LIMIT);
      expect(await running).toEqual(quiet);
      expect(slow.failure("b")).toBe(`The read of the copy b took longer than ${EXCHANGE_LIMIT} ms.`);

      const bad = workerOf(a.runtime, async (_peer, input) => wire({ ...serveEntries({ runtime: b.runtime, clock, configHash: HASH }, input), time: HIDDEN, configHash: "" }), clock);
      await bad.round();
      expect(bad.failure("b")).toBe("The answer of the copy b is not valid: The time of the answer is not a finite number. The hash of the configuration is not a text of 1 to 200 characters.");

      const other = workerOf(a.runtime, serve(c.runtime, clock), clock);
      await other.round();
      expect(other.failure("b")).toBe("The page of the copy b names another copy.");
      expect(a.log.head()).toBe(head);
      expect(a.runtime.position("b")).toBe(0);
    });

    it("aborts its reads at the stop, and keeps no failure of them", async () => {
      const clock = fakeWallClock(T0);
      const a = open("a", [], clock);
      const worker = workerOf(a.runtime, hanging, clock);
      const stop = new AbortController();
      const running = worker.round(stop.signal);
      stop.abort(new Error("shutdown"));
      expect(await running).toEqual(quiet);
      expect(worker.failure("b")).toBeUndefined();
      expect(worker.watches()[0]!.read).toBeUndefined();
    });

    it("ends a read at the stop also when the transport misses the abort of its signal", async () => {
      const clock = fakeWallClock(T0);
      const a = open("a", [], clock);
      // This transport never ends, and it reads no signal.
      const deaf: ExchangeCall = () => new Promise(() => undefined);
      const worker = workerOf(a.runtime, deaf, clock);
      const stop = new AbortController();
      const running = worker.round(stop.signal);
      await settle();
      stop.abort(new Error("shutdown"));
      expect(await running).toEqual(quiet);
      expect(worker.failure("b")).toBeUndefined();
    });

    it("moves its times at a step of the wall clock, and a read across a step keeps its imports and gives no times", async () => {
      const clock = fakeWallClock(T0);
      const a = open("a", [], clock);
      const b = open("b", ["w1"], clock);
      await b.runtime.pass();
      const serving = serve(b.runtime, clock);
      // The step of the wall clock comes during the first call.
      let steps = 1;
      const worker = workerOf(
        a.runtime,
        async (peer, input, signal) => {
          if (steps > 0) {
            steps -= 1;
            worker.shift(10 * SECOND);
          }
          return serving(peer, input, signal);
        },
        clock,
      );
      expect((await worker.round()).imports).toBeGreaterThan(0);
      expect(worker.watches()).toEqual([{ copy: "b", skewLimit: CLOCK_SKEW_LIMIT, maxAge: COPY_MAX_AGE, since: T0 + 10 * SECOND }]);
      expect(worker.failure("b")).toBeUndefined();

      await worker.round();
      expect(worker.watches()[0]!.read).toEqual({ at: T0, skew: 0, sameConfig: true });
      worker.shift(-4 * SECOND);
      expect(worker.watches()[0]).toMatchObject({ since: T0 + 6 * SECOND, read: { at: T0 - 4 * SECOND, skew: 4 * SECOND } });
    });

    it("is ready after its first round, or after one time limit when no round ends", async () => {
      const clock = fakeWallClock(T0);
      const a = open("a", [], clock);
      const b = open("b", [], clock);
      await exchangeWorker({ runtime: a.runtime, peers: [], call: hanging, clock, configHash: HASH }).ready();

      const quick = workerOf(a.runtime, serve(b.runtime, clock), clock);
      await quick.round();
      await quick.ready();

      const idle = workerOf(a.runtime, hanging, clock);
      let ready = false;
      void idle.ready().then(() => {
        ready = true;
      });
      await clock.advance(EXCHANGE_LIMIT - 1);
      await settle();
      expect(ready).toBe(false);
      await clock.advance(1);
      await settle();
      expect(ready).toBe(true);
    });

    it("carries the last starts of the drills of the other copy into its watch (AL-43)", async () => {
      const clock = fakeWallClock(T0);
      const a = open("a", [], clock);
      const b = open("b", [], clock);
      let starts: Readonly<Record<string, number>> | undefined = { "push-weekly": T0 - MINUTE };
      const call: ExchangeCall = async (_peer, input) => wire(serveEntries({ runtime: b.runtime, clock, configHash: HASH, ...(starts === undefined ? {} : { drills: () => starts ?? {} }) }, input));
      const worker = workerOf(a.runtime, call, clock);
      expect((await worker.round()).changed).toBe(true);
      expect(worker.watches()[0]).toMatchObject({ read: { at: T0 }, drills: { "push-weekly": T0 - MINUTE } });
      // A new start changes the round, and the same starts do not.
      starts = { "push-weekly": T0 };
      expect((await worker.round()).changed).toBe(true);
      expect(worker.watches()[0]!.drills).toEqual({ "push-weekly": T0 });
      expect((await worker.round()).changed).toBe(false);
      // An answer of an older build gives no starts. The read still passes.
      starts = undefined;
      expect((await worker.round()).changed).toBe(true);
      expect(worker.watches()[0]).not.toHaveProperty("drills");
      expect(worker.watches()[0]!.read).toMatchObject({ at: T0, sameConfig: true });
      // Starts that are not valid give none, and the read still passes.
      for (const drills of [{ "push-weekly": "soon" }, { "": T0 }, [T0], { "push-weekly": null }]) {
        const bad = workerOf(a.runtime, async (_peer, input) => ({ ...(wire(serveEntries({ runtime: b.runtime, clock, configHash: HASH }, input)) as object), drills }), clock);
        expect((await bad.round()).problems).toEqual([]);
        expect(bad.watches()[0]).not.toHaveProperty("drills");
        expect(bad.watches()[0]!.read).toMatchObject({ at: T0 });
      }
    });

    it("keeps the time of the first read of a copy that is not steady until a steady read (AL-108)", async () => {
      const clock = fakeWallClock(T0);
      const a = open("a", [], clock);
      const b = open("b", [], clock);
      let steady: boolean | undefined = false;
      let fail = false;
      const call: ExchangeCall = async (_peer, input) => {
        if (fail) throw new Error("The copy stopped.");
        return wire(serveEntries({ runtime: b.runtime, clock, configHash: HASH, ...(steady === undefined ? {} : { steady: () => steady ?? false }) }, input));
      };
      const worker = workerOf(a.runtime, call, clock);
      await worker.round();
      expect(worker.watches()[0]).toMatchObject({ read: { at: T0 }, unsteadySince: T0 });
      // A later read that is not steady, and a failed read, keep the first time.
      await clock.advance(MINUTE);
      await worker.round();
      fail = true;
      await clock.advance(MINUTE);
      await worker.round();
      expect(worker.watches()[0]).toMatchObject({ read: { at: T0 + MINUTE }, unsteadySince: T0 });
      // A shift of the clock moves the time, as it moves the read.
      worker.shift(-4 * SECOND);
      expect(worker.watches()[0]).toMatchObject({ read: { at: T0 + MINUTE - 4 * SECOND }, unsteadySince: T0 - 4 * SECOND });
      // A steady read ends it. A read of an older build, with no value, also ends it.
      fail = false;
      steady = true;
      await worker.round();
      expect(worker.watches()[0]).not.toHaveProperty("unsteadySince");
      steady = false;
      await worker.round();
      expect(worker.watches()[0]).toHaveProperty("unsteadySince");
      steady = undefined;
      await worker.round();
      expect(worker.watches()[0]).not.toHaveProperty("unsteadySince");
      // A value that is not a boolean gives none, and the read still passes.
      const bad = workerOf(a.runtime, async (_peer, input) => ({ ...(wire(serveEntries({ runtime: b.runtime, clock, configHash: HASH }, input)) as object), steady: "no" }), clock);
      expect((await bad.round()).problems).toEqual([]);
      expect(bad.watches()[0]).not.toHaveProperty("unsteadySince");
      expect(bad.watches()[0]!.read).toBeDefined();
    });

    it("keeps the end of the deploy mark of a copy on the clock of the reader (AL-208)", async () => {
      const clock = fakeWallClock(T0);
      const a = open("a", [], clock);
      const b = open("b", [], clock);
      let until: number | undefined = T0 + MINUTE;
      let fail = false;
      // The copy b is 2 s ahead of a. Thus its end is 2 s later on its own clock.
      const call: ExchangeCall = async (_peer, input) => {
        if (fail) throw new Error("The copy stopped.");
        const answer = wire(serveEntries({ runtime: b.runtime, clock, configHash: HASH, deployUntil: () => until }, input)) as Record<string, unknown>;
        return { ...answer, time: (answer["time"] as number) + 2 * SECOND, ...(until === undefined ? {} : { deployUntil: until + 2 * SECOND }) };
      };
      const worker = workerOf(a.runtime, call, clock);
      await worker.round();
      expect(worker.watches()[0]).toMatchObject({ read: { at: T0 }, deployUntil: T0 + MINUTE });
      // A failed read keeps the end. A shift moves it.
      fail = true;
      await clock.advance(SECOND * 10);
      await worker.round();
      expect(worker.watches()[0]).toMatchObject({ deployUntil: T0 + MINUTE });
      worker.shift(-4 * SECOND);
      expect(worker.watches()[0]).toMatchObject({ deployUntil: T0 + MINUTE - 4 * SECOND });
      // A read with no mark ends it.
      fail = false;
      until = undefined;
      await worker.round();
      expect(worker.watches()[0]).not.toHaveProperty("deployUntil");
      // An end that is not a finite number gives none, and the read still passes.
      const bad = workerOf(a.runtime, async (_peer, input) => ({ ...(wire(serveEntries({ runtime: b.runtime, clock, configHash: HASH }, input)) as object), deployUntil: "soon" }), clock);
      expect((await bad.round()).problems).toEqual([]);
      expect(bad.watches()[0]).not.toHaveProperty("deployUntil");
      expect(bad.watches()[0]!.read).toBeDefined();
      // The source with no mark gives no field.
      expect(serveEntries({ runtime: b.runtime, clock, configHash: HASH, deployUntil: () => undefined }, { after: 0 })).not.toHaveProperty("deployUntil");
    });

    it("tells that a start is steady after LOUD_STEADY of passes", () => {
      const pass = (at: number) => ({ at }) as Pass;
      expect(steadyPasses(undefined, undefined)).toBe(false);
      expect(steadyPasses(pass(T0), pass(T0 + LOUD_STEADY - 1))).toBe(false);
      expect(steadyPasses(pass(T0), pass(T0 + LOUD_STEADY))).toBe(true);
    });

    it("checks the input of the procedure and the options of the worker", () => {
      const clock = fakeWallClock(T0);
      const b = open("b", [], clock);
      const served = { runtime: b.runtime, clock, configHash: HASH };
      expect(serveEntries(served, { after: 0 })).toMatchObject({ time: T0, configHash: HASH, page: { format: EXCHANGE_FORMAT, copy: "b", after: 0 } });
      for (const after of [-1, 0.5]) expect(() => serveEntries(served, { after })).toThrow("The position after is not a whole number of 0 or more.");
      for (const limit of [0, EXCHANGE_PAGE + 1]) expect(() => serveEntries(served, { after: 0, limit })).toThrow(`The limit is not a whole number from 1 to ${EXCHANGE_PAGE}.`);
      expect(() => exchangeWorker({ runtime: b.runtime, peers: [B, { ...B, url: "http://copy-c.example.test:4751" }], call: hanging, clock, configHash: HASH })).toThrow("Two peers of the exchange worker have the same id.");
      expect(() => workerOf(b.runtime, hanging, clock, { pages: 0 })).toThrow("The value pages of the exchange worker is not a whole number above 0.");
    });

    it("gives a pass the line unread of a copy, and the time of the line as a wake", async () => {
      const clock = fakeWallClock(T0);
      const checks: CopyChecks = { watches: () => worker.watches(), shift: (size) => worker.shift(size), ready: () => worker.ready() };
      const runtime = openRuntime({ log: openRuntimeLog(":memory:"), clock, sources: [source(["w1"], clock)], watch: () => ({ places: [KANSAS], kinds: ["met"] }), view: VIEW, run: "run-a", copy: "a", copies: checks });
      const worker = workerOf(
        runtime,
        async () => {
          throw new Error("The copy refused the connection.");
        },
        clock,
      );
      await worker.round();
      const first = await runtime.pass();
      expect(first.view.step.reports.map((one) => one.kind.code)).not.toContain("system.copy.unread");
      expect(first.wakeAt).toBeLessThanOrEqual(T0 + COPY_MAX_AGE);

      await clock.advance(COPY_MAX_AGE);
      const late = (await runtime.pass()).view.step.reports.filter((one) => one.kind.code === "system.copy.unread");
      expect(late).toHaveLength(1);
      expect(late[0]!.about).toEqual([{ system: COPY_SUBJECT, id: "b", label: "Copy b" }]);
    });
  });
});
