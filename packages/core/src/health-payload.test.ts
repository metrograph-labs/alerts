import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import type { ChannelId, ChannelQuota, CopyWatch, Coverage, PlaceId, ProviderBalance, ReportId, SourceHealth, SourceId } from "./contracts.ts";
import { DEFAULT_CHANNEL_DOWN, type ChannelSnapshot } from "./channel-down.ts";
import { FAILURE_MESSAGE_LIMIT, failureMessage, HEALTH_FORMAT, healthPayload, sourceHealthView, type HealthPayloadInput } from "./health-payload.ts";
import type { Lateness } from "./lateness.ts";
import { healthPayloadSchema, sourceHealthViewSchema } from "./schemas.ts";
import { balanceStages, copyStages, quotaStages } from "./system-reports.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4]);
const START = 1_800_000_000_000;
const NOW = START + 120_000;
const API = "api" as SourceId;
const FEED = "feed" as SourceId;
const CALL = "call" as ChannelId;
const PUSH = "push" as ChannelId;
const TEXT = "text" as ChannelId;
// A made-up key in the message of a failure. The payload must not hold it.
const KEY = "key-5f1c9a";

const healthy: SourceHealth = { source: API, state: "healthy", since: START, lastSuccess: START + 60_000, reason: "The last fetch passed." };
const failing: SourceHealth = {
  source: FEED,
  state: "failing",
  since: START + 30_000,
  lastSuccess: START,
  lastFailure: { at: START + 90_000, failure: { kind: "server", message: `The fetch of /feed?key=${KEY} gave 503.` } },
  reason: "The last 3 fetches failed: server.",
};
const late: Lateness = { expectation: "feed after api", from: API, to: FEED, state: "late", limit: { delay: 600_000, misses: 1 }, missed: ["r1" as ReportId], since: START + 100_000 };
const covered: Coverage = { place: "place:a" as PlaceId, kind: "met", sources: [API], independent: 1, proven: true, faults: ["provider:a"], commonResources: [], required: 1 };
// One copy read 10 s ago with a clock skew past its limit, and one copy with no read past its maximum age.
const skewed: CopyWatch = { copy: "copy-b", skewLimit: 2_000, maxAge: 60_000, since: START, read: { at: NOW - 10_000, skew: 5_000, sameConfig: true } };
const unread: CopyWatch = { copy: "copy-c", skewLimit: 2_000, maxAge: 60_000, since: START };
const reserve: ChannelQuota = { channel: PUSH, limit: 100, reserve: 10, used: 95, resetAt: START + 86_400_000 };
const low: ProviderBalance = { provider: "provider:call", title: "Calls", channels: [CALL], floors: [5], maxAge: 3_600_000, since: START, read: { balance: 3, currency: "USD", at: START + 1_000 } };

// Three channels: one run that opens a line, one short run, and one channel with a good call and no run.
const channels: ChannelSnapshot[] = [
  { copy: "copy-a", channel: CALL, title: "Calls", api: ["domain:call.example.com"], run: { channel: CALL, failures: 3, first: START, last: START + 60_000, kind: "server", reached: true } },
  { copy: "copy-a", channel: PUSH, title: "Push", run: { channel: PUSH, failures: 3, first: START, last: START + 30_000, kind: "timeout", reached: true }, good: START - 1_000 },
  { copy: "copy-a", channel: TEXT, title: "Texts", good: START + 100_000 },
];

const input: HealthPayloadInput = {
  at: START + 110_000,
  now: NOW,
  sources: [healthy, failing],
  lateness: [late],
  coverage: [covered],
  copies: [skewed, unread],
  quotas: [reserve],
  balances: [low],
  reads: [{ what: "replies of the texts", at: START + 100_000, failed: true, next: NOW + 300_000 }],
  channels,
};

describe("sourceHealthView", () => {
  it("keeps the time, the kind and the redacted message of the last failure", () => {
    expect(sourceHealthView(failing)).toEqual({ ...failing, lastFailure: { at: START + 90_000, kind: "server", message: "The fetch of /feed?key=[secret] gave 503." } });
    expect(JSON.stringify(sourceHealthView(failing))).not.toContain(KEY);
    expect(sourceHealthViewSchema.safeParse(sourceHealthView(failing)).success).toBe(true);
  });

  it("gives no message for a failure with an empty message", () => {
    const empty: SourceHealth = { ...failing, lastFailure: { at: START, failure: { kind: "network", message: " \n " } } };
    expect(sourceHealthView(empty).lastFailure).toEqual({ at: START, kind: "network" });
  });

  it("keeps a health with no failure as it is", () => {
    expect(sourceHealthView(healthy)).toEqual(healthy);
    expect(sourceHealthViewSchema.safeParse(sourceHealthView(healthy)).success).toBe(true);
  });
});

describe("failureMessage", () => {
  it("keeps the cause of a time-out to a host, as on 11-25 for NWWS", () => {
    expect(failureMessage("the connection failed: connect ETIMEDOUT 192.0.2.10:5222")).toBe("the connection failed: connect ETIMEDOUT 192.0.2.10:5222");
  });

  it("removes a known secret in each of its forms", () => {
    const secret = "pa ss/word";
    const message = `bad answer from https://host.example/x?k=${encodeURIComponent(secret)} with ${secret}`;
    const text = failureMessage(message, [secret]) ?? "";
    expect(text).not.toContain(secret);
    expect(text).not.toContain(encodeURIComponent(secret));
    expect(text).toBe("bad answer from https://host.example/… with [secret]");
  });

  it("removes a token of a known shape and the value after the name of a secret, with no list of secrets", () => {
    const token = `ghp_${"a".repeat(36)}`;
    expect(failureMessage(`refused: ${token}`)).toBe("refused: [secret]");
    expect(failureMessage("the reply said api_key=abc123 is not valid")).toBe("the reply said api_key=[secret] is not valid");
  });

  it("keeps the scheme and the host of a URL, and removes its path, its query and its fragment", () => {
    expect(failureMessage("no answer in 30000 ms: https://api.example.gov/points/40.7128,-74.0060?units=si#top")).toBe("no answer in 30000 ms: https://api.example.gov/…");
    expect(failureMessage("GET https://host.example gave 503")).toBe("GET https://host.example gave 503");
  });

  it("removes the user part of a URL: a user with a password, and a user only", () => {
    const withPassword = failureMessage("Request cannot be constructed from a URL that includes credentials: https://user:p4ss@host.example/x");
    expect(withPassword).toBe("Request cannot be constructed from a URL that includes credentials: https://[secret]@host.example/…");
    expect(withPassword).not.toContain("p4ss");
    expect(withPassword).not.toContain("user:");
    const userOnly = failureMessage("no answer: https://t0ken9f@host.example/repo.git");
    expect(userOnly).toBe("no answer: https://[secret]@host.example/…");
    // An @ in the path is not a user part.
    expect(failureMessage("GET https://host.example/@me gave 404")).toBe("GET https://host.example/… gave 404");
  });

  it("joins the white space, and cuts a long message to the limit with no split of a surrogate pair", () => {
    expect(failureMessage("a\n\n  b\tc")).toBe("a b c");
    const long = failureMessage("x".repeat(FAILURE_MESSAGE_LIMIT + 50)) ?? "";
    expect(long).toHaveLength(FAILURE_MESSAGE_LIMIT);
    expect(long.endsWith("…")).toBe(true);
    const astral = failureMessage(`${"x".repeat(FAILURE_MESSAGE_LIMIT - 2)}😀😀😀`) ?? "";
    expect(astral.length).toBeLessThanOrEqual(FAILURE_MESSAGE_LIMIT);
    expect(astral).toBe(`${"x".repeat(FAILURE_MESSAGE_LIMIT - 2)}…`);
    expect(failureMessage("x".repeat(FAILURE_MESSAGE_LIMIT))).toHaveLength(FAILURE_MESSAGE_LIMIT);
  });

  it.each(SEEDS)("gives a message that the schema of the view accepts, for each message (seed %i)", (seed) => {
    const r = random(seed);
    // The parts of a message: any code unit (a lone surrogate too), white space, a pair, a URL and a secret.
    const parts = (): string =>
      r.pick([
        () => String.fromCharCode(r.int(0, 0xffff)),
        () => r.pick([" ", "\n", "\t"]),
        () => "😀",
        () => `https://h${String(r.int(0, 9))}.example/p?q=${String(r.int(0, 99))}`,
        () => `${KEY} token=${KEY}`,
      ])();
    for (let round = 0; round < 100; round += 1) {
      const message = Array.from({ length: r.int(0, 400) }, parts).join("");
      const view = sourceHealthView({ ...failing, lastFailure: { at: START, failure: { kind: "network", message } } }, [KEY]);
      expect(sourceHealthViewSchema.safeParse(view).success).toBe(true);
      expect(view.lastFailure?.message ?? "").not.toContain(KEY);
    }
  });
});

describe("healthPayload", () => {
  const payload = healthPayload(input);

  it("removes the secrets of its input from each message", () => {
    const withSecret = healthPayload({ ...input, secrets: ["503"] });
    expect(withSecret.sources[1]?.lastFailure?.message).toBe("The fetch of /feed?key=[secret] gave [secret].");
  });

  it("gives the format, the two times and each list in the order of its input", () => {
    expect(payload.format).toBe(HEALTH_FORMAT);
    expect(payload.at).toBe(START + 110_000);
    expect(payload.now).toBe(NOW);
    expect(payload.sources.map((entry) => entry.source)).toEqual([API, FEED]);
    expect(payload.lateness).toEqual([late]);
    expect(payload.coverage).toEqual([covered]);
    expect(payload.copies.map((entry) => entry.copy)).toEqual(["copy-b", "copy-c"]);
  });

  it("gives the stages of the core at the time of the read, thus the page and the system reports agree", () => {
    expect(payload.copies).toEqual([
      { copy: "copy-b", stages: copyStages(skewed, NOW), read: skewed.read },
      { copy: "copy-c", stages: copyStages(unread, NOW) },
    ]);
    expect(payload.copies.map((entry) => entry.stages)).toEqual([["skew"], ["unread"]]);
    expect(payload.quotas).toEqual([{ quota: reserve, stages: quotaStages(reserve) }]);
    expect(payload.quotas[0]?.stages).toEqual(["low", "reserve"]);
    expect(payload.balances).toEqual([{ balance: low, stages: balanceStages(low, NOW) }]);
    expect(payload.balances[0]?.stages).toEqual(["low"]);
  });

  it("gives each channel with the down flag of its run under the policy", () => {
    // The default policy opens a line after 3 failed calls over 60 s or more: the run of the push channel is too short.
    expect(DEFAULT_CHANNEL_DOWN).toEqual({ failures: 3, span: 60_000 });
    expect(payload.channels).toEqual(channels.map((channel, index) => ({ ...channel, down: index === 0 })));
    expect(healthPayload({ ...input, channelDown: { failures: 3, span: 30_000 } }).channels.map((entry) => entry.down)).toEqual([true, true, false]);
    expect(healthPayload({ ...input, channelDown: { failures: 4, span: 0 } }).channels.map((entry) => entry.down)).toEqual([false, false, false]);
  });

  it("passes its schema after a JSON round trip, and holds no secret of a failure", () => {
    const text = JSON.stringify(payload);
    expect(text).not.toContain(KEY);
    expect(healthPayloadSchema.safeParse(JSON.parse(text))).toMatchObject({ success: true });
  });

  it("gives a payload before the first pass, with empty lists", () => {
    // A runtime with no delivery gives no channel.
    const empty = healthPayload({ at: null, now: START, sources: [], lateness: [], coverage: [], copies: [], quotas: [], balances: [], reads: [] });
    expect(empty).toEqual({ format: HEALTH_FORMAT, at: null, now: START, sources: [], lateness: [], coverage: [], copies: [], quotas: [], balances: [], reads: [], channels: [] });
    expect(healthPayloadSchema.safeParse(empty).success).toBe(true);
  });

  it("refuses a payload with the raw failure of a source, of another format or with an unknown field", () => {
    const withMessage = { ...payload, sources: [failing] };
    expect(healthPayloadSchema.safeParse(withMessage).success).toBe(false);
    expect(healthPayloadSchema.safeParse({ ...payload, format: "alerts-health/0" }).success).toBe(false);
    expect(healthPayloadSchema.safeParse({ ...payload, extra: 1 }).success).toBe(false);
    // A channel with a message of a failure, or with no down flag, does not pass.
    const [call] = payload.channels;
    expect(healthPayloadSchema.safeParse({ ...payload, channels: [{ ...call, run: { ...call?.run, message: KEY } }] }).success).toBe(false);
    expect(healthPayloadSchema.safeParse({ ...payload, channels: [{ ...call, down: undefined }] }).success).toBe(false);
  });
});
