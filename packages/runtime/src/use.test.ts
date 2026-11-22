import { fakeWallClock } from "@mark1russell7/algebra/clock";
import type { LimitConfig } from "@mark1russell7/alerts";
import type { RestExchange, RestReply, RestTransport } from "@procedures/gh";
import { describe, expect, it } from "vitest";
import { GITHUB_BILLING_TOKEN, githubUse, limitProblems, limitWatch, limitWatches, type LimitWatchOptions, type UseReading } from "./use.ts";

const T0 = Date.UTC(2026, 10, 15, 12);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ID = "github:example/actions";

function watchOf(read: LimitWatchOptions["read"], extra: Partial<LimitWatchOptions> = {}) {
  return limitWatch({ id: ID, provider: "provider:github", title: "GitHub Actions", read, ...extra });
}

// A reader that gives the next answer of a list, and counts its reads.
function scripted(answers: readonly (UseReading | Error)[]) {
  let reads = 0;
  const read = async (): Promise<UseReading> => {
    const answer = answers[Math.min(reads, answers.length - 1)]!;
    reads += 1;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { read, reads: () => reads };
}

const reading = (used: number, level?: number): UseReading => ({ ok: true, month: "2026-11", used, limit: 10, currency: "USD", levels: [0.5, 0.8, 1], ...(level === undefined ? {} : { level }) });

describe("the watch of the use of a limit", () => {
  it("reads first after the delay, then once a day, and gives the watch as data of the core", async () => {
    const clock = fakeWallClock(T0);
    const reader = scripted([reading(5, 0.5), reading(9, 0.8)]);
    const watch = watchOf(reader.read);
    expect(watch.use()).toBeUndefined();
    expect(watch.nextReadAt()).toBeUndefined();
    await watch.check(clock);
    // A start does not read. The first read is due after the delay.
    expect(reader.reads()).toBe(0);
    expect(watch.nextReadAt()).toBe(T0 + 20 * MINUTE);
    expect(watch.use()).toEqual({ id: ID, provider: "provider:github", title: "GitHub Actions", levels: [], maxAge: 2 * DAY, since: T0 });
    await clock.advance(20 * MINUTE);
    await watch.check(clock);
    expect(reader.reads()).toBe(1);
    const first = T0 + 20 * MINUTE;
    expect(watch.use()).toEqual({ id: ID, provider: "provider:github", title: "GitHub Actions", levels: [0.5, 0.8, 1], maxAge: 2 * DAY, since: T0, read: { month: "2026-11", used: 5, limit: 10, currency: "USD", level: 0.5, at: first } });
    expect(watch.nextReadAt()).toBe(first + DAY);
    expect(watch.health()).toEqual({ what: `use of ${ID}`, at: first, failed: false, next: first + DAY });
    await clock.advance(DAY);
    await watch.check(clock);
    expect(reader.reads()).toBe(2);
    expect(watch.use()?.read).toEqual({ month: "2026-11", used: 9, limit: 10, currency: "USD", level: 0.8, at: first + DAY });
  });

  it("keeps the last read after a failure, a throw or a bad answer, and reads again after the retry", async () => {
    const clock = fakeWallClock(T0);
    const bad: UseReading = { ok: true, month: "2026-11", used: Number.NaN, limit: 10, currency: "USD", levels: [1] };
    const reader = scripted([reading(5, 0.5), { ok: false, message: "GitHub gave a usage report that the reader cannot read." }, new Error("The network is down."), bad, { ...reading(1), currency: "usd" }, { ...reading(1), month: "2026-1" }, reading(6, 0.5)]);
    const watch = watchOf(reader.read, { delay: 1 });
    await watch.check(clock);
    await clock.advance(1);
    await watch.check(clock);
    const failures: (string | undefined)[] = [];
    for (let step = 1; step <= 6; step += 1) {
      await clock.advance(step === 1 ? DAY : HOUR);
      await watch.check(clock);
      failures.push(watch.failure());
    }
    expect(failures.slice(0, 5)).toEqual([
      "GitHub gave a usage report that the reader cannot read.",
      "The read of the use failed: The network is down.",
      "The read of the use gave no finite amounts, no month or no currency code.",
      "The read of the use gave no finite amounts, no month or no currency code.",
      "The read of the use gave no finite amounts, no month or no currency code.",
    ]);
    expect(failures[5]).toBeUndefined();
    expect(watch.use()?.read?.used).toBe(6);
    // The health holds no message of a failure.
    expect(Object.keys(watch.health()).sort()).toEqual(["at", "failed", "next", "what"]);
  });

  it("keeps the levels of the configuration, moves its times at a step of the wall clock, and refuses bad options", async () => {
    const clock = fakeWallClock(T0);
    const watch = watchOf(scripted([reading(5, 0.5)]).read, { levels: [0.9], delay: 1 });
    await watch.check(clock);
    expect(watch.use()?.levels).toEqual([0.9]);
    await clock.advance(1);
    await watch.check(clock);
    expect(watch.use()?.levels).toEqual([0.9]);
    watch.shift(HOUR);
    expect(watch.use()).toMatchObject({ since: T0 + HOUR, read: { at: T0 + 1 + HOUR } });
    expect(watch.nextReadAt()).toBe(T0 + 1 + DAY + HOUR);
    expect(() => watchOf(async () => reading(1), { delay: 0 })).toThrow("The time delay of the watch of the limit github:example/actions is not a whole count of milliseconds above 0.");
    expect(() => watchOf(async () => reading(1), { levels: [0] })).toThrow("is not a finite share above 0.");
  });
});

// The fake GitHub: the answers of the usage report and of the budgets, with each request in a list.
function fakeGithub(answers: { readonly usage?: unknown; readonly budgets?: unknown }) {
  const sent: RestExchange[] = [];
  const transport: RestTransport = async (exchange): Promise<RestReply> => {
    sent.push(exchange);
    const body = exchange.url.includes("/settings/billing/usage") ? answers.usage : answers.budgets;
    return body === undefined ? { status: 404, headers: {}, body: { message: "Not Found" } } : { status: 200, headers: {}, body };
  };
  return { transport, sent };
}

const item = (product: string, netAmount: number) => ({ product, sku: `${product}_linux`, date: "2026-11-14T00:00:00Z", quantity: 1, grossAmount: netAmount + 1, discountAmount: 1, netAmount });
const budget = (product: string, amount: number, stops = true, entity = "example") => ({ budget_scope: "organization", budget_entity_name: entity, budget_product_sku: product, budget_amount: amount, prevent_further_usage: stops });
const budgets = (...list: readonly unknown[]) => ({ budgets: list, has_next_page: false, total_count: list.length });
const ORG: LimitConfig = { id: ID, provider: "provider:github", title: "GitHub Actions", accountKind: "organization", account: "example", products: ["actions"] };
const USER: LimitConfig = { ...ORG, id: "github:someone/actions", accountKind: "user", account: "someone", products: ["actions", "packages"], monthlyUsd: 10 };
const signal = new AbortController().signal;

describe("the reader of the use of GitHub", () => {
  it("sums the net amounts of the products of the month, and gives the level of the monthly limit of a user", async () => {
    const github = fakeGithub({ usage: { usageItems: [item("Actions", 3), item("packages", 2.5), item("actions", 3), item("copilot", 50)] } });
    const read = githubUse({ token: "test-token", transport: github.transport })(USER);
    expect(await read(signal, T0)).toEqual({ ok: true, month: "2026-11", used: 8.5, limit: 10, currency: "USD", levels: [0.5, 0.8, 1], level: 0.8 });
    expect(github.sent.map((exchange) => [exchange.method, exchange.url])).toEqual([["GET", expect.stringMatching(/\/users\/someone\/settings\/billing\/usage\?(?=.*year=2026)(?=.*month=11)/)]]);
    // The month of the read is in UTC: the last hour of the month in the United States is the next month.
    const december = await read(signal, Date.UTC(2026, 11, 1, 2));
    expect(december).toMatchObject({ ok: true, month: "2026-12" });
    expect(github.sent[1]?.url).toMatch(/month=12/);
  });

  it("takes the smallest budget of the organization that stops the paid use of its product", async () => {
    const github = fakeGithub({ usage: { usageItems: [item("actions", 4)] }, budgets: budgets(budget("actions", 40, false), budget("actions", 8), budget("actions", 6), budget("packages", 1), budget("actions", 1, true, "other")) });
    const reader = githubUse({ token: "test-token", transport: github.transport });
    expect(await reader(ORG)(signal, T0)).toEqual({ ok: true, month: "2026-11", used: 4, limit: 6, currency: "USD", levels: [0.5, 0.8, 1], level: 0.5 });
    expect(await reader({ ...ORG, budget: "packages", levels: [1] })(signal, T0)).toMatchObject({ ok: true, limit: 1, levels: [1], level: 1 });
    expect(github.sent.some((exchange) => exchange.url.includes("/organizations/example/settings/billing/budgets"))).toBe(true);
  });

  it("gives no level at a budget of 0 with no use, and the largest level for a use above it", async () => {
    const stopped = fakeGithub({ usage: { usageItems: [item("actions", 0)] }, budgets: budgets(budget("actions", 0)) });
    const none = await githubUse({ token: "test-token", transport: stopped.transport })(ORG)(signal, T0);
    expect(none).toEqual({ ok: true, month: "2026-11", used: 0, limit: 0, currency: "USD", levels: [0.5, 0.8, 1] });
    const over = fakeGithub({ usage: { usageItems: [item("actions", 0.25)] }, budgets: budgets(budget("actions", 0)) });
    expect(await githubUse({ token: "test-token", transport: over.transport })(ORG)(signal, T0)).toMatchObject({ ok: true, used: 0.25, limit: 0, level: 1 });
  });

  it("gives a failure with no amount for an answer that it cannot read, and for no budget that stops the use", async () => {
    const unread = fakeGithub({ usage: { items: [] } });
    expect(await githubUse({ token: "test-token", transport: unread.transport })(USER)(signal, T0)).toEqual({ ok: false, message: "GitHub gave a usage report that the reader cannot read." });
    const noBudgets = fakeGithub({ usage: { usageItems: [] } });
    expect(await githubUse({ token: "test-token", transport: noBudgets.transport })(ORG)(signal, T0)).toEqual({ ok: false, message: "GitHub gave budgets that the reader cannot read." });
    const alertOnly = fakeGithub({ usage: { usageItems: [] }, budgets: budgets(budget("actions", 5, false)) });
    expect(await githubUse({ token: "test-token", transport: alertOnly.transport })(ORG)(signal, T0)).toEqual({ ok: false, message: "The organization of the limit github:example/actions has no budget that stops the paid use of actions." });
  });

  it("loads the modules at the first read only, and loads again after a load that failed", async () => {
    let loads = 0;
    const github = fakeGithub({ usage: { usageItems: [item("actions", 1)] } });
    const reader = githubUse({
      token: "test-token",
      transport: github.transport,
      load: async () => {
        loads += 1;
        if (loads === 1) throw new Error("The module is missing.");
        const [gh, spend] = await Promise.all([import("@procedures/gh"), import("@mark1russell7/stack-spend")]);
        return { gh, spend };
      },
    });
    const read = reader(USER);
    expect(loads).toBe(0);
    await expect(read(signal, T0)).rejects.toThrow("The module is missing.");
    expect(await read(signal, T0)).toMatchObject({ ok: true, used: 1 });
    expect(await reader({ ...USER, id: "github:someone/packages" })(signal, T0)).toMatchObject({ ok: true });
    expect(loads).toBe(2);
  });
});

describe("the setup of the watches of the limits", () => {
  const secrets = (values: Record<string, string>) => (name: string) => values[name];

  it("gives a problem for a provider with no reader and for no token, with no value", () => {
    expect(limitProblems([], secrets({}))).toEqual([]);
    expect(limitProblems([ORG], secrets({ [GITHUB_BILLING_TOKEN]: "test-token" }))).toEqual([]);
    expect(limitProblems([ORG, { ...ORG, id: "other:x", provider: "provider:other" }], secrets({}))).toEqual([
      "The watch of the limit other:x names the provider provider:other, and the runtime has no reader of it.",
      `The configuration has watches of limits of GitHub, and the secret store has no value for ${GITHUB_BILLING_TOKEN}.`,
    ]);
  });

  it("makes one watch for each limit of GitHub, and none with no token", () => {
    expect(limitWatches([ORG, USER], secrets({}))).toEqual([]);
    expect(limitWatches([ORG, USER, { ...ORG, id: "other:x", provider: "provider:other" }], secrets({ [GITHUB_BILLING_TOKEN]: "test-token" })).map((watch) => watch.id)).toEqual([ID, "github:someone/actions"]);
  });
});
