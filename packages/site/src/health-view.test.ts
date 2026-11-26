import type { ChannelId, HealthPayload, HealthState, SourceId } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { HEALTH_LOOKS, STATE_ORDER } from "./health-look.ts";
import { FIRST_FIXTURE, HEALTH_AT, HEALTH_FIXTURE, HEALTHY_FIXTURE } from "./health-view.fixture.ts";
import {
  ABSENT_TEXT,
  ageText,
  coversText,
  deliveryFacts,
  deliveryVerdict,
  healthPanel,
  keepHealth,
  MOST_KINDS,
  needsAttention,
  NO_HEALTH,
  NONE_TEXT,
  PART_WORDS,
  sourceRows,
  sourcesVerdict,
  type KeptHealth,
  type SourceRow,
} from "./health-view.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The clock time of a time in UTC, so the tests do not read the time zone of the computer. */
const clock = (at: number): string => new Date(at).toISOString().slice(11, 16);
const STATES: readonly HealthState[] = ["unknown", "healthy", "slow", "failing", "silent", "changed"];

const row = (state: HealthState, late = false, source = "one"): SourceRow => ({ source, state, late, read: "", readAt: undefined, why: [], covers: undefined });
const rows = (...states: HealthState[]): SourceRow[] => states.map((state, index) => row(state, false, `source-${String(index)}`));
const health = (parts: Partial<HealthPayload>): HealthPayload => ({ ...HEALTHY_FIXTURE, copies: [], quotas: [], balances: [], reads: [], channels: [], ...parts });
const quota = (used: number, stages: HealthPayload["quotas"][number]["stages"], more: object = {}): HealthPayload["quotas"][number] => ({
  quota: { channel: "text" as ChannelId, limit: 100, reserve: 10, used, ...more },
  stages,
});
const balance = (stages: HealthPayload["balances"][number]["stages"], amount: number | undefined, channels: string[] = ["voice"], title = "Voice Co"): HealthPayload["balances"][number] => ({
  balance: {
    provider: "provider:voice-co",
    title,
    channels: channels as ChannelId[],
    floors: [5],
    maxAge: DAY,
    since: HEALTH_AT - 30 * DAY,
    ...(amount === undefined ? {} : { read: { balance: amount, currency: "USD", at: HEALTH_AT - 26 * HOUR } }),
  },
  stages,
});

describe("the looks of the health states", () => {
  it("has a word and a tone for each state, and puts each state one time in the sequence from the worst", () => {
    expect(Object.keys(HEALTH_LOOKS).sort()).toEqual([...STATES].sort());
    expect(STATE_ORDER).toEqual(["failing", "silent", "changed", "unknown", "slow", "healthy"]);
    expect(STATES.map((state) => HEALTH_LOOKS[state].tone)).toEqual(["quiet", "good", "warn", "bad", "bad", "bad"]);
    // No two states have one word, because the word tells the state.
    expect(new Set(STATES.map((state) => HEALTH_LOOKS[state].word)).size).toBe(STATES.length);
  });
});

describe("the text of an age", () => {
  it("has one unit, and rounds down", () => {
    expect(ageText(0)).toBe("less than 1 minute");
    expect(ageText(MINUTE - 1)).toBe("less than 1 minute");
    expect(ageText(MINUTE)).toBe("1 minute");
    expect(ageText(2 * MINUTE - 1)).toBe("1 minute");
    expect(ageText(59 * MINUTE + 59_000)).toBe("59 minutes");
    expect(ageText(HOUR)).toBe("1 hour");
    expect(ageText(47 * HOUR + 59 * MINUTE)).toBe("47 hours");
    expect(ageText(2 * DAY)).toBe("2 days");
    expect(ageText(40 * DAY)).toBe("40 days");
  });

  it("gives the shortest text for a time after the present, and for a time that is not a number", () => {
    // The clock of the runtime can be a little before the time of a read.
    expect(ageText(-5000)).toBe("less than 1 minute");
    expect(ageText(Number.NaN)).toBe("less than 1 minute");
  });
});

describe("the rows of the sources", () => {
  const found = sourceRows(HEALTH_FIXTURE, HEALTH_AT, clock);

  it("puts the worst state first: down, late, no read, slow, healthy", () => {
    expect(found.map((one) => [one.source, one.state, one.late])).toEqual([
      ["river-gauge", "failing", false],
      ["air-sensor", "silent", false],
      ["county-page", "changed", false],
      ["weather-relay", "healthy", true],
      ["quake-feed", "unknown", false],
      ["road-notices", "slow", false],
      ["weather-feed", "healthy", false],
    ]);
    expect(found.filter(needsAttention).map((one) => one.source)).toEqual(["river-gauge", "air-sensor", "county-page", "weather-relay"]);
  });

  it("puts the sources of one state in the sequence of their ids", () => {
    const sources = ["zulu", "alpha", "mike"].map((source) => ({ source: source as SourceId, state: "healthy" as const, since: 0, lastSuccess: HEALTH_AT, reason: "The last fetch passed." }));
    expect(sourceRows(health({ sources, lateness: [], coverage: [] }), HEALTH_AT, clock).map((one) => one.source)).toEqual(["alpha", "mike", "zulu"]);
  });

  it("tells the time since the last good read, and the clock time of that read", () => {
    expect(found.map((one) => [one.read, one.readAt])).toEqual([
      ["Last good read 12 minutes ago.", "20:48"],
      ["Last good read 3 minutes ago.", "20:57"],
      ["Last good read 3 days ago.", "21:00"],
      ["Last good read 2 minutes ago.", "20:58"],
      ["No good read yet.", undefined],
      ["Last good read 1 minute ago.", "20:59"],
      ["Last good read less than 1 minute ago.", "20:59"],
    ]);
  });

  it("counts each age back from the time of the reader", () => {
    const later = sourceRows(HEALTH_FIXTURE, HEALTH_AT + 10 * MINUTE, clock);
    expect(later[0]?.read).toBe("Last good read 22 minutes ago.");
    expect(later[0]?.why[1]).toBe("The last failure was a time-out, 10 minutes ago.");
  });

  it("tells why a source needs attention: the reason of the core, the last failure and the lateness", () => {
    expect(found.map((one) => one.why)).toEqual([
      ["The last 3 fetches failed: timeout.", "The last failure was a time-out, less than 1 minute ago."],
      ["No fresh observation in 2 h, and the limit is 1 h."],
      ["The canary failed: the page has no table of notices.", "The last failure was a refused request, 9 minutes ago."],
      ["It did not carry the reports of weather-feed in time."],
      ["No fetch passed yet."],
      ["The last fetch took 12 s, and the limit is 8 s."],
      [],
    ]);
  });

  it("gives the redacted message of the last failure after its kind and its age", () => {
    const lastFailure = { at: HEALTH_AT - 2 * HOUR, kind: "network", message: "the connection failed: connect ETIMEDOUT 192.0.2.10:5222" } as const;
    const sources: HealthPayload["sources"] = [{ source: "one" as SourceId, state: "failing", since: 0, lastFailure, reason: "The last fetch failed." }];
    expect(sourceRows(health({ sources, lateness: [], coverage: [] }), HEALTH_AT, clock)[0]?.why).toEqual([
      "The last fetch failed.",
      "The last failure was a network failure, 2 hours ago.",
      "Its message: the connection failed: connect ETIMEDOUT 192.0.2.10:5222",
    ]);
  });

  it("has words for each kind of failure", () => {
    const kinds = ["network", "timeout", "server", "rate-limited", "auth", "refused"] as const;
    const texts = kinds.map((kind) => {
      const sources: HealthPayload["sources"] = [{ source: "one" as SourceId, state: "failing", since: 0, lastFailure: { at: HEALTH_AT - 2 * HOUR, kind }, reason: "The last fetch failed." }];
      return sourceRows(health({ sources, lateness: [], coverage: [] }), HEALTH_AT, clock)[0]?.why[1];
    });
    expect(texts).toEqual([
      "The last failure was a network failure, 2 hours ago.",
      "The last failure was a time-out, 2 hours ago.",
      "The last failure was a server failure, 2 hours ago.",
      "The last failure was a rate limit, 2 hours ago.",
      "The last failure was a refused key, 2 hours ago.",
      "The last failure was a refused request, 2 hours ago.",
    ]);
  });

  it("tells the last failure only for a source that is not healthy", () => {
    const sources: HealthPayload["sources"] = [{ source: "one" as SourceId, state: "healthy", since: 0, lastSuccess: HEALTH_AT, lastFailure: { at: HEALTH_AT - HOUR, kind: "server" }, reason: "The last fetch passed." }];
    expect(sourceRows(health({ sources, lateness: [], coverage: [] }), HEALTH_AT, clock)[0]?.why).toEqual([]);
  });

  it("counts a source as late only for an expectation in the state late, and names each first source one time", () => {
    const lateness = HEALTH_FIXTURE.lateness[0];
    if (lateness === undefined) throw new Error("The fixture has one expectation.");
    const quiet = sourceRows({ ...HEALTH_FIXTURE, lateness: (["no-limit", "no-data", "met"] as const).map((state) => ({ ...lateness, state })) }, HEALTH_AT, clock);
    expect(quiet.filter((one) => one.late)).toEqual([]);
    const twice = sourceRows({ ...HEALTH_FIXTURE, lateness: [lateness, { ...lateness, expectation: "relay-carries-watches" }] }, HEALTH_AT, clock);
    expect(twice.find((one) => one.source === "weather-relay")?.why).toEqual(["It did not carry the reports of weather-feed in time."]);
  });

  it("names the kinds that a source covers, and no kind for a source that is down", () => {
    expect(found.map((one) => one.covers)).toEqual([undefined, undefined, undefined, "Covers: Tornado", undefined, "Covers: Wind", "Covers: Flash flood, Tornado, Wind"]);
  });
});

describe("the text of the coverage of a source", () => {
  it("names each kind one time, in the sequence of the names", () => {
    expect(coversText([])).toBeUndefined();
    expect(coversText(["met.wind", "met.tornado", "met.wind"])).toBe("Covers: Tornado, Wind");
  });

  it("gives the code of a kind that the taxonomy does not have", () => {
    expect(coversText(["x.made-up"])).toBe("Covers: x.made-up");
  });

  it("names the first kinds, and counts the others", () => {
    expect(MOST_KINDS).toBe(4);
    expect(coversText(["b", "a", "d", "c"])).toBe("Covers: a, b, c, d");
    expect(coversText(["b", "a", "d", "c", "e"])).toBe("Covers: a, b, c, d and 1 more kind");
    expect(coversText(["b", "a", "d", "c", "e", "f", "g"])).toBe("Covers: a, b, c, d and 3 more kinds");
  });
});

describe("the sentence of the sources", () => {
  it("counts the sources that need attention first", () => {
    expect(sourcesVerdict(sourceRows(HEALTH_FIXTURE, HEALTH_AT, clock), true)).toEqual({ tone: "bad", text: "4 of 7 sources need attention." });
    expect(sourcesVerdict(rows("healthy", "silent", "unknown", "slow"), true)).toEqual({ tone: "bad", text: "1 of 4 sources needs attention." });
    expect(sourcesVerdict([row("healthy", true), row("healthy")], true)).toEqual({ tone: "bad", text: "1 of 2 sources needs attention." });
  });

  it("then tells the sources with no good read", () => {
    expect(sourcesVerdict(rows("unknown", "healthy", "slow"), true)).toEqual({ tone: "quiet", text: "1 of 3 sources has no good read yet." });
    expect(sourcesVerdict(rows("unknown", "unknown", "healthy"), true)).toEqual({ tone: "quiet", text: "2 of 3 sources have no good read yet." });
    expect(sourcesVerdict(rows("unknown", "unknown"), false)).toEqual({ tone: "quiet", text: "The runtime made no pass yet." });
  });

  it("then tells the slow sources, and then that each source reads well", () => {
    expect(sourcesVerdict(rows("slow", "healthy", "healthy"), true)).toEqual({ tone: "warn", text: "Each source reads. 1 of 3 sources is slow." });
    expect(sourcesVerdict(rows("slow", "slow"), true)).toEqual({ tone: "warn", text: "Each source reads. 2 of 2 sources are slow." });
    expect(sourcesVerdict(rows("healthy", "healthy", "healthy"), true)).toEqual({ tone: "good", text: "Each of the 3 sources reads well." });
    expect(sourcesVerdict(sourceRows(HEALTHY_FIXTURE, HEALTH_AT, clock), true)).toEqual({ tone: "good", text: "Each of the 4 sources reads well." });
  });

  it("has words for one source and for no source", () => {
    expect(sourcesVerdict([], true)).toEqual({ tone: "quiet", text: "The runtime has no source." });
    expect(sourcesVerdict(rows("failing"), true)).toEqual({ tone: "bad", text: "The source needs attention." });
    expect(sourcesVerdict(rows("unknown"), true)).toEqual({ tone: "quiet", text: "The source has no good read yet." });
    expect(sourcesVerdict(rows("slow"), true)).toEqual({ tone: "warn", text: "The source reads, but it is slow." });
    expect(sourcesVerdict(rows("healthy"), true)).toEqual({ tone: "good", text: "The source reads well." });
  });
});

describe("the facts of the delivery", () => {
  const facts = (parts: Partial<HealthPayload>) => deliveryFacts(health(parts), HEALTH_AT, clock);

  it("gives no fact for a quota, a balance or a copy with no stage", () => {
    expect(deliveryFacts(HEALTHY_FIXTURE, HEALTH_AT, clock)).toEqual([]);
    expect(deliveryFacts(FIRST_FIXTURE, HEALTH_AT, clock)).toEqual([]);
  });

  it("puts the fact that stops a message first, then the quotas, the balances, the copies and the reads", () => {
    expect(deliveryFacts(HEALTH_FIXTURE, HEALTH_AT, clock)).toEqual([
      { part: "balance", name: "Voice Co", tone: "bad", word: "Empty", text: "The balance is 0.00 USD. The provider refuses each paid message on the channel voice.", stopped: ["voice"], limited: [] },
      { part: "quota", name: "text", tone: "warn", word: "Reserve", text: "7 of 100 messages are left. The channel sends only life-safety messages. The window ends at 00:00.", stopped: [], limited: ["text"] },
      { part: "copy", name: "cabin-copy", tone: "warn", word: "Not read", text: "The last read of the copy was 3 hours ago. The two copies can both send an alert.", stopped: [], limited: [] },
      { part: "read", name: "replies of the texts", tone: "warn", word: "Read failed", text: "The last read of the replies of the texts failed. The last read that passed was 40 minutes ago. The next read is at 21:05.", stopped: [], limited: [] },
    ]);
    expect(Object.keys(PART_WORDS)).toEqual(["quota", "balance", "copy", "read", "channel"]);
  });

  it("tells the worst stage of a quota", () => {
    expect(facts({ quotas: [quota(85, ["low"])] })).toMatchObject([{ tone: "warn", word: "Low", text: "15 of 100 units are left.", stopped: [], limited: [] }]);
    expect(facts({ quotas: [quota(99, ["low", "reserve"], { unit: "cents" })] })).toMatchObject([{ word: "Reserve", text: "1 of 100 cents is left. The channel sends only life-safety messages.", limited: ["text"] }]);
    expect(facts({ quotas: [quota(100, ["low", "reserve", "spent"], { resetAt: HEALTH_AT + HOUR })] })).toMatchObject([
      { tone: "bad", word: "Spent", text: "The provider refuses each message, also a life-safety message. The window ends at 22:00.", stopped: ["text"], limited: [] },
    ]);
    // The provider gives the end of a block. The page tells it in place of the end of the window.
    expect(facts({ quotas: [quota(40, ["low", "reserve", "spent"], { resetAt: HEALTH_AT + HOUR, blockedUntil: HEALTH_AT + 30 * MINUTE })] })).toMatchObject([
      { tone: "bad", word: "Spent", text: "The provider refuses each message until 21:30, also a life-safety message." },
    ]);
    // A quota that used more than its limit has no units left.
    expect(facts({ quotas: [quota(12_345, ["low", "reserve", "spent"], { limit: 12_000 })] })).toMatchObject([{ word: "Spent" }]);
    expect(facts({ quotas: [quota(11_000, ["low"], { limit: 12_000, reserve: 600 })] })).toMatchObject([{ text: "1,000 of 12,000 units are left." }]);
  });

  it("tells the worst stage of a balance, and that the runtime cannot read it", () => {
    expect(facts({ balances: [balance(["low"], 3.2)] })).toMatchObject([{ tone: "warn", word: "Low", text: "The balance is 3.20 USD, and the floor is 5.00 USD.", stopped: [] }]);
    // With two floors, the text gives the lowest floor that the balance is below.
    const two = balance(["low"], 1.5);
    expect(facts({ balances: [{ ...two, balance: { ...two.balance, floors: [5, 2] } }] })).toMatchObject([{ word: "Low", text: "The balance is 1.50 USD, and the floor is 2.00 USD." }]);
    expect(facts({ balances: [balance(["low", "empty"], -1.5, ["voice", "text"])] })).toMatchObject([
      { tone: "bad", word: "Empty", text: "The balance is -1.50 USD. The provider refuses each paid message on the channels voice and text.", stopped: ["voice", "text"] },
    ]);
    expect(facts({ balances: [balance(["low", "empty"], 0, [])] })).toMatchObject([{ word: "Empty", text: "The balance is 0.00 USD. The provider refuses each paid message.", stopped: [] }]);
    expect(facts({ balances: [balance(["unread"], 20)] })).toMatchObject([{ tone: "warn", word: "Not read", text: "The last read of the balance was 26 hours ago. The runtime cannot see a low balance." }]);
    expect(facts({ balances: [balance(["unread"], undefined)] })).toMatchObject([{ word: "Not read", text: "No read of the balance passed yet. The runtime cannot see a low balance." }]);
    expect(facts({ balances: [balance(["low", "unread"], 3.2)] })).toMatchObject([
      { word: "Low", text: "The balance is 3.20 USD, and the floor is 5.00 USD. The last read of the balance was 26 hours ago. The runtime cannot see a low balance." },
    ]);
  });

  it("tells a failed read on a schedule, the time of the last read that passed and the next read", () => {
    const read = (at: number | null, failed: boolean, next: number | null = HEALTH_AT + 5 * MINUTE): HealthPayload["reads"][number] => ({ what: "replies of the texts", at, failed, next });
    expect(facts({ reads: [read(HEALTH_AT - 2 * MINUTE, false)] })).toEqual([]);
    expect(facts({ reads: [read(null, false)] })).toEqual([]);
    expect(facts({ reads: [read(HEALTH_AT - 40 * MINUTE, true)] })).toEqual([
      { part: "read", name: "replies of the texts", tone: "warn", word: "Read failed", text: "The last read of the replies of the texts failed. The last read that passed was 40 minutes ago. The next read is at 21:05.", stopped: [], limited: [] },
    ]);
    expect(facts({ reads: [read(null, true, null)] })).toMatchObject([{ text: "No read of the replies of the texts passed yet." }]);
  });

  it("tells a channel with failed calls, and stops each message on a down channel", () => {
    const channel = (failures: number, down: boolean): HealthPayload["channels"][number] => ({
      copy: "home-copy",
      channel: "push" as ChannelId,
      title: "Push Co",
      run: { channel: "push" as ChannelId, failures, first: HEALTH_AT - 10 * MINUTE, last: HEALTH_AT - 2 * MINUTE, kind: "server", reached: true },
      good: HEALTH_AT - HOUR,
      down,
    });
    // A channel with no run gives no fact, also with no good call yet.
    expect(facts({ channels: [{ copy: "home-copy", channel: "push" as ChannelId, title: "Push Co", down: false }] })).toEqual([]);
    expect(facts({ channels: [channel(1, false)] })).toEqual([
      { part: "channel", name: "push", tone: "warn", word: "Failed calls", text: "1 call failed since 20:50. The last failure was at 20:58, of the kind server.", stopped: [], limited: [] },
    ]);
    expect(facts({ channels: [channel(4, true)] })).toEqual([
      { part: "channel", name: "push", tone: "bad", word: "Down", text: "4 calls failed since 20:50. The last failure was at 20:58, of the kind server. The run opens the line of a down channel.", stopped: ["push"], limited: [] },
    ]);
    expect(deliveryVerdict(health({ channels: [channel(4, true)] }), facts({ channels: [channel(4, true)] }))).toEqual({ tone: "bad", text: "The channel push cannot send a message." });
  });

  it("names a provider with no title by its id", () => {
    expect(facts({ balances: [balance(["low"], 1, ["voice"], "")] })).toMatchObject([{ name: "provider:voice-co" }]);
  });

  it("tells each stage of another copy", () => {
    const copy = (stages: HealthPayload["copies"][number]["stages"], read?: { skew: number; sameConfig: boolean }): HealthPayload["copies"][number] => ({
      copy: "cabin-copy",
      stages,
      ...(read === undefined ? {} : { read: { at: HEALTH_AT - 5 * MINUTE, ...read } }),
    });
    expect(facts({ copies: [copy(["unread"])] })).toMatchObject([{ tone: "warn", word: "Not read", text: "No read of the copy passed yet. The two copies can both send an alert." }]);
    expect(facts({ copies: [copy(["config"], { skew: 0, sameConfig: false })] })).toMatchObject([
      { word: "Different configuration", text: "The copy has a different configuration. The two copies can route an alert in two ways." },
    ]);
    expect(facts({ copies: [copy(["skew"], { skew: -42_400, sameConfig: true })] })).toMatchObject([{ word: "Clock skew", text: "The clock of the copy is 42 seconds behind." }]);
    expect(facts({ copies: [copy(["skew"], { skew: 5 * MINUTE, sameConfig: true })] })).toMatchObject([{ text: "The clock of the copy is 5 minutes ahead." }]);
    expect(facts({ copies: [copy(["unread", "unsteady"])] })).toMatchObject([
      { word: "Not steady", text: "The copy starts again and again, and it sends no alert. This copy is the only copy that sends. No read of the copy passed yet. The two copies can both send an alert." },
    ]);
    expect(facts({ copies: [copy(["skew", "config", "unread"], { skew: 1000, sameConfig: false })] })).toMatchObject([
      {
        word: "Not read",
        text: "The last read of the copy was 5 minutes ago. The two copies can both send an alert. The copy has a different configuration. The two copies can route an alert in two ways. The clock of the copy is 1 second ahead.",
      },
    ]);
  });
});

describe("the sentence of the delivery", () => {
  const verdict = (parts: Partial<HealthPayload>) => {
    const payload = health(parts);
    return deliveryVerdict(payload, deliveryFacts(payload, HEALTH_AT, clock));
  };

  it("names the channels that cannot send a message, each one time", () => {
    expect(deliveryVerdict(HEALTH_FIXTURE, deliveryFacts(HEALTH_FIXTURE, HEALTH_AT, clock))).toEqual({ tone: "bad", text: "The channel voice cannot send a message." });
    expect(verdict({ quotas: [quota(100, ["low", "reserve", "spent"])], balances: [balance(["low", "empty"], 0, ["voice", "text"])] })).toEqual({ tone: "bad", text: "The channels text and voice cannot send a message." });
    expect(verdict({ balances: [balance(["low", "empty"], 0, [])] })).toEqual({ tone: "bad", text: "A balance is empty. The provider refuses each paid message." });
  });

  it("then names the channels that send only life-safety messages", () => {
    expect(verdict({ quotas: [quota(95, ["low", "reserve"])], balances: [balance(["low"], 3)] })).toEqual({ tone: "warn", text: "The channel text sends only life-safety messages." });
    const push = { quota: { channel: "push" as ChannelId, limit: 50, reserve: 5, used: 48 }, stages: ["low", "reserve"] as const };
    expect(verdict({ quotas: [quota(95, ["low", "reserve"]), push] })).toEqual({ tone: "warn", text: "The channels push and text send only life-safety messages." });
  });

  it("then counts the other facts", () => {
    expect(verdict({ quotas: [quota(85, ["low"])] })).toEqual({ tone: "warn", text: "No quota and no balance stops a message. 1 fact below needs attention." });
    expect(verdict({ quotas: [quota(85, ["low"])], balances: [balance(["unread"], 20)] })).toEqual({ tone: "warn", text: "No quota and no balance stops a message. 2 facts below need attention." });
  });

  it("tells that nothing stops a message, or that the runtime watches no quota and no balance", () => {
    expect(deliveryVerdict(HEALTHY_FIXTURE, [])).toEqual({ tone: "good", text: "No quota and no balance stops a message." });
    expect(verdict({ quotas: [quota(1, [])] })).toEqual({ tone: "good", text: "No quota and no balance stops a message." });
    expect(verdict({})).toEqual({ tone: "quiet", text: "The runtime watches no quota and no balance." });
    // A failed read is a fact that needs attention. It stops no message.
    expect(verdict({ reads: [{ what: "spend of provider:voice-co", at: null, failed: true, next: null }] })).toEqual({ tone: "warn", text: "No quota and no balance stops a message. 1 fact below needs attention." });
    expect(deliveryVerdict(FIRST_FIXTURE, [])).toEqual({ tone: "quiet", text: "The runtime watches no quota and no balance." });
  });
});

describe("the health that the page keeps", () => {
  const good: KeptHealth = { payload: HEALTH_FIXTURE, readAt: 1000, fresh: true, absent: false, text: undefined };

  it("keeps a good read with the time of the page", () => {
    expect(keepHealth(NO_HEALTH, { ok: true, payload: HEALTH_FIXTURE }, 1000)).toEqual(good);
    expect(keepHealth(good, { ok: true, payload: HEALTHY_FIXTURE }, 2000)).toEqual({ ...good, payload: HEALTHY_FIXTURE, readAt: 2000 });
  });

  it("keeps the last good health after a failed read, with the words of the failure", () => {
    expect(keepHealth(good, { ok: false, absent: false, text: "The runtime answers with the status 500." }, 2000)).toEqual({ ...good, fresh: false, text: "The runtime answers with the status 500." });
    expect(keepHealth(NO_HEALTH, { ok: false, absent: false, text: "No." }, 2000)).toEqual({ ...NO_HEALTH, text: "No." });
  });

  it("keeps the last good health with no words when the page did not ask for the health", () => {
    const failed = keepHealth(good, { ok: false, absent: false, text: "No." }, 2000);
    expect(keepHealth(failed, undefined, 3000)).toEqual({ ...good, fresh: false });
    expect(keepHealth(NO_HEALTH, undefined, 3000)).toEqual(NO_HEALTH);
  });

  it("drops the health when the runtime has no health route", () => {
    expect(keepHealth(good, { ok: false, absent: true }, 2000)).toEqual({ ...NO_HEALTH, absent: true });
    // A later good read ends the state.
    expect(keepHealth({ ...NO_HEALTH, absent: true }, { ok: true, payload: HEALTH_FIXTURE }, 1000)).toEqual(good);
  });
});

describe("the panel of a kept health", () => {
  const good: KeptHealth = { payload: HEALTH_FIXTURE, readAt: HEALTH_AT + 400, fresh: true, absent: false, text: undefined };

  it("sums a fresh health in two sentences: the sources, then the way out of a message", () => {
    const panel = healthPanel(good, HEALTH_AT + 400, clock);
    expect(panel.verdicts).toEqual([
      { tone: "bad", text: "4 of 7 sources need attention." },
      { tone: "bad", text: "The channel voice cannot send a message." },
    ]);
    expect(panel.problem).toBeUndefined();
    expect(panel.rows).toEqual(sourceRows(HEALTH_FIXTURE, HEALTH_AT, clock));
    expect(panel.facts).toEqual(deliveryFacts(HEALTH_FIXTURE, HEALTH_AT, clock));
    expect(healthPanel({ ...good, payload: HEALTHY_FIXTURE }, HEALTH_AT, clock).verdicts).toEqual([
      { tone: "good", text: "Each of the 4 sources reads well." },
      { tone: "good", text: "No quota and no balance stops a message." },
    ]);
    expect(healthPanel({ ...good, payload: FIRST_FIXTURE }, HEALTH_AT, clock).verdicts).toEqual([
      { tone: "quiet", text: "The runtime made no pass yet." },
      { tone: "quiet", text: "The runtime watches no quota and no balance." },
    ]);
  });

  it("counts the ages of a fresh health back from the time of the read, not from the clock of the page", () => {
    // The clock of the page is 5 minutes after the clock of the runtime here.
    const panel = healthPanel(good, HEALTH_AT + 5 * MINUTE, clock);
    expect(panel.rows[0]?.read).toBe("Last good read 12 minutes ago.");
  });

  it("does not tell an old state as the present state: it tells the time of the read, and keeps the rows", () => {
    const later = HEALTH_AT + 10 * MINUTE;
    const panel = healthPanel({ ...good, payload: HEALTHY_FIXTURE, fresh: false, text: "The runtime answers with the status 500." }, later, clock);
    expect(panel.verdicts).toEqual([{ tone: "warn", text: "The page has no new health. The panel shows the read of 21:00." }]);
    expect(panel.problem).toBe("The runtime answers with the status 500.");
    // The ages count back from the time of the page.
    expect(panel.rows).toEqual(sourceRows(HEALTHY_FIXTURE, later, clock));
    expect(panel.rows[0]).toMatchObject({ source: "river-gauge", read: "Last good read 14 minutes ago." });
  });

  it("tells in plain words that the page has no health", () => {
    expect(healthPanel(NO_HEALTH, HEALTH_AT, clock)).toEqual({ verdicts: [{ tone: "quiet", text: NONE_TEXT }], problem: undefined, rows: [], facts: [] });
    expect(healthPanel({ ...NO_HEALTH, absent: true }, HEALTH_AT, clock)).toEqual({ verdicts: [{ tone: "quiet", text: ABSENT_TEXT }], problem: undefined, rows: [], facts: [] });
    expect(healthPanel({ ...NO_HEALTH, text: "No." }, HEALTH_AT, clock).problem).toBe("No.");
    expect(NONE_TEXT).toBe("The page has no health of the sources yet.");
    expect(ABSENT_TEXT).toBe("This runtime gives no health of its sources.");
  });
});
