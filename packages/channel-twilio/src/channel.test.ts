import type { Level, Message, PersonId, ReportId } from "@mark1russell7/alerts";
import type { TwilioFetch } from "@procedures/notify/twilio";
import { memoryQuotaStore, quotaGate, type Quota, type QuotaGate } from "polite-crawler/api";
import { describe, expect, it } from "vitest";
import {
  CALL_LAST_SENTENCE,
  CALL_REPEATS,
  CALL_SAY_LIMIT,
  createTwilioCallChannel,
  readTwilioBalance,
  spokenTextOf,
  twilioCallDescriptor,
  twilioCallOf,
  twilioSetupProblems,
  type TwilioSpendGates,
} from "./index.ts";

// Fake credentials and fake numbers: the country code +999 has no country.
const ACCOUNT = `AC${"0".repeat(32)}`;
const CREDENTIALS = { accountSid: ACCOUNT, secret: "fake-secret" };
const FROM = "+99900000001";
const ADDRESS = { to: "+99900000002" };
const SID = `CA${"a".repeat(32)}`;
const AT = Date.UTC(2026, 3, 1, 18, 0);
const FORM = "a phone number in E.164 form: a plus sign, the country code and the number";

const message = (level: Level, extra: Partial<Message> = {}): Message => ({
  key: "k".repeat(64),
  person: "person-1" as PersonId,
  level,
  title: "Tornado warning",
  body: "Take shelter now.",
  incident: "report-1" as ReportId,
  quiet: false,
  ...extra,
});

type Answer = { status: number; body: unknown } | Error;

/** A fake Twilio server: it records each request and gives the next answer. */
const server = (...answers: Answer[]) => {
  const calls: Array<{ url: string; method: string; fields: Record<string, string> }> = [];
  const fetch: TwilioFetch = async (url, init) => {
    calls.push({ url, method: init.method, fields: Object.fromEntries(new URLSearchParams(init.body ?? "")) });
    const answer = answers.shift() ?? { status: 500, body: {} };
    if (answer instanceof Error) throw answer;
    return { status: answer.status, text: async () => JSON.stringify(answer.body), headers: { get: () => null } };
  };
  return { calls, fetch };
};

const channelOf = (fake: ReturnType<typeof server>, extra: Partial<Parameters<typeof createTwilioCallChannel>[0]> = {}) =>
  createTwilioCallChannel({ credentials: CREDENTIALS, from: FROM, fetch: fake.fetch, now: () => AT, ...extra });

const accepted: Answer = { status: 201, body: { sid: SID, status: "queued" } };

describe("the spoken text", () => {
  it("says the title, the why line and the body as sentences, then the last sentence", () => {
    const text = spokenTextOf(message("life-safety", { why: "Why: Place A is in the area", body: "  TAKE COVER\n\nNOW!  " }));
    expect(text).toBe(`Tornado warning. Why: Place A is in the area. TAKE COVER NOW! ${CALL_LAST_SENTENCE}`);
  });

  it("cuts a long text at the end of a word, and keeps the last sentence", () => {
    const text = spokenTextOf(message("life-safety", { body: "word ".repeat(400) }));
    expect(text.endsWith(CALL_LAST_SENTENCE)).toBe(true);
    const said = text.slice(0, -CALL_LAST_SENTENCE.length - 1);
    expect([...said].length).toBeLessThanOrEqual(CALL_SAY_LIMIT + 1);
    expect(said.endsWith("word.")).toBe(true);
  });
});

describe("the map of a message to a call", () => {
  it("says the text two times, with the machine detection, from the Twilio number", () => {
    const call = twilioCallOf(message("life-safety"), ADDRESS, AT, { from: FROM, ringMs: 45_000 });
    if ("refused" in call) throw new Error(call.refused);
    expect(call).toMatchObject({ to: ADDRESS.to, from: FROM, machineDetection: "Enable", ringMs: 45_000 });
    expect(call.twiml?.match(/<Say>/g)).toHaveLength(CALL_REPEATS);
  });

  it("refuses a quiet message, a message that expired and an address that the core refuses, with no value in the reason", () => {
    expect(twilioCallOf(message("notice", { quiet: true }), ADDRESS, AT, { from: FROM })).toEqual({ refused: "A call has no silent mode, thus a quiet message gets no call.", kind: "quiet" });
    expect(twilioCallOf(message("notice", { expires: AT }), ADDRESS, AT, { from: FROM })).toEqual({ refused: "The message expired before the send.", kind: "expired" });
    expect(twilioCallOf(message("notice"), {}, AT, { from: FROM })).toEqual({ refused: `The address on twilio-call has no field to. The channel needs ${FORM}.` });
    for (const to of ["999", "+0123", "+1555555012"]) {
      const refusal = twilioCallOf(message("notice"), { to }, AT, { from: FROM });
      expect(refusal).toEqual({ refused: `The field to of the address on twilio-call is not ${FORM}.` });
      expect(JSON.stringify(refusal)).not.toContain(to);
    }
    expect(twilioCallOf(message("notice"), { ...ADDRESS, user: "x" }, AT, { from: FROM })).toEqual({ refused: "The address on twilio-call has the field user, and the channel reads no such field." });
  });
});

describe("the send", () => {
  it("starts the call, keeps its SID in the receipt, and describes the channel", async () => {
    const fake = server(accepted);
    const channel = channelOf(fake);
    expect(channel.describe()).toEqual(twilioCallDescriptor());
    expect(await channel.send({ message: message("life-safety"), address: ADDRESS, copy: "run-1-1" })).toEqual({ ok: true, receipt: { call: SID }, accepted: AT });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ method: "POST", url: `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Calls.json` });
    expect(fake.calls[0]?.fields).toMatchObject({ To: ADDRESS.to, From: FROM, MachineDetection: "Enable" });
    expect(fake.calls[0]?.fields["Twiml"]).toContain("Tornado warning.");
  });

  it("makes no request for a quiet message, a bad copy id, a bad account SID and a bad Twilio number", async () => {
    const fake = server();
    // A quiet call is not a fault of the channel: the kind is quiet, and the step goes after the quiet window.
    expect(await channelOf(fake).send({ message: message("notice", { quiet: true }), address: ADDRESS })).toMatchObject({ ok: false, kind: "quiet" });
    expect(await channelOf(fake).send({ message: message("notice", { expires: AT }), address: ADDRESS })).toMatchObject({ ok: false, kind: "expired" });
    expect(await channelOf(fake).send({ message: message("notice"), address: ADDRESS, copy: "bad copy" })).toMatchObject({ ok: false, kind: "refused" });
    expect(await channelOf(fake, { credentials: { accountSid: "AC1", secret: "fake-secret" } }).send({ message: message("notice"), address: ADDRESS })).toMatchObject({ ok: false, kind: "auth" });
    expect(await channelOf(fake, { from: "999" }).send({ message: message("notice"), address: ADDRESS })).toMatchObject({ ok: false, kind: "refused" });
    expect(fake.calls).toEqual([]);
  });

  it("gives the failures of Twilio and of the network, with the error code of Twilio", async () => {
    const fake = server(
      { status: 401, body: { code: 20003, message: "Authenticate" } },
      { status: 429, body: { code: 20429, message: "Too Many Requests" } },
      { status: 400, body: { code: 21211, message: "The number is not valid." } },
      new TypeError("fetch failed"),
    );
    const channel = channelOf(fake);
    const send = () => channel.send({ message: message("life-safety"), address: ADDRESS });
    expect(await send()).toMatchObject({ ok: false, kind: "auth" });
    expect(await send()).toMatchObject({ ok: false, kind: "rate-limited" });
    const refused = await send();
    expect(refused).toMatchObject({ ok: false, kind: "refused" });
    if (!refused.ok) expect(refused.message).toContain("(Twilio error 21211)");
    expect(await send()).toMatchObject({ ok: false, kind: "network", retryAfter: 5_000 });
  });
});

describe("the cap of the spend", () => {
  // A cap of 20 cents with a reserve of 8 cents: 3 calls below life-safety at 4 cents, then 2 more for life-safety only.
  const QUOTA: Quota = { name: "Twilio spend", limit: 20, reserve: 8, window: { kind: "calendar", unit: "month", timeZone: "UTC" } };
  const gatesOf = (store = memoryQuotaStore()): TwilioSpendGates => ({
    gate: quotaGate(QUOTA, { key: "twilio:account", store, now: () => AT }),
    lifeSafety: quotaGate({ ...QUOTA, reserve: 0 }, { key: "twilio:account", store, now: () => AT }),
    units: 4,
  });
  const used = (gate: QuotaGate): number => gate.state().used;

  it("counts the calls of both gates once, keeps the reserve for life-safety, and refuses each call at the full cap", async () => {
    const spend = gatesOf();
    const fake = server(...Array.from({ length: 6 }, () => accepted));
    const channel = channelOf(fake, { spend });
    const send = (level: Level) => channel.send({ message: message(level), address: ADDRESS });
    for (let call = 0; call < 3; call += 1) expect(await send("urgent")).toMatchObject({ ok: true });
    expect([used(spend.gate), used(spend.lifeSafety)]).toEqual([12, 12]);
    const reserved = await send("urgent");
    expect(reserved).toMatchObject({ ok: false, kind: "reserved" });
    if (!reserved.ok) expect(reserved.retryAfter).toBeGreaterThan(0);
    expect(await send("life-safety")).toMatchObject({ ok: true });
    expect(await send("life-safety")).toMatchObject({ ok: true });
    expect(used(spend.gate)).toBe(20);
    expect(await send("life-safety")).toMatchObject({ ok: false, kind: "rate-limited" });
    expect(await send("notice")).toMatchObject({ ok: false, kind: "rate-limited" });
    expect(fake.calls).toHaveLength(5);
  });

  it("gives back the units of a call that Twilio refused or limited, and keeps the units of a call with no answer", async () => {
    const spend = gatesOf();
    const fake = server(
      { status: 400, body: { code: 21211, message: "The number is not valid." } },
      { status: 401, body: { code: 20003, message: "Authenticate" } },
      { status: 429, body: { code: 20429, message: "Too Many Requests" } },
      new TypeError("fetch failed"),
      { status: 503, body: {} },
    );
    const channel = channelOf(fake, { spend });
    const send = () => channel.send({ message: message("urgent"), address: ADDRESS });
    await send();
    await send();
    await send();
    expect(used(spend.gate)).toBe(0);
    await send();
    await send();
    expect(used(spend.gate)).toBe(8);
  });

  it("counts each call in the own gate too, gives back its units with the cap, and makes the call when the own gate fails", async () => {
    const store = memoryQuotaStore();
    const own = quotaGate({ ...QUOTA, reserve: 0 }, { key: "twilio:account:own", store, now: () => AT });
    const spend = { ...gatesOf(store), own };
    const fake = server(accepted, { status: 429, body: { code: 20429, message: "Too Many Requests" } });
    const channel = channelOf(fake, { spend });
    const send = () => channel.send({ message: message("urgent"), address: ADDRESS });
    expect(await send()).toMatchObject({ ok: true });
    await send();
    expect([used(spend.gate), used(own)]).toEqual([4, 4]);
    const broken: QuotaGate = { ...own, take: () => {
      throw new Error("The disk is full.");
    } };
    expect(await channelOf(server(accepted), { spend: { ...spend, own: broken } }).send({ message: message("urgent"), address: ADDRESS })).toMatchObject({ ok: true });
    expect([used(spend.gate), used(own)]).toEqual([8, 4]);
  });

  it("makes the call with no count when the store of the gate fails", async () => {
    const broken: QuotaGate = { ...gatesOf().gate, take: () => {
      throw new Error("The disk is full.");
    } };
    const fake = server(accepted);
    expect(await channelOf(fake, { spend: { ...gatesOf(), gate: broken } }).send({ message: message("urgent"), address: ADDRESS })).toMatchObject({ ok: true });
  });

  it("refuses a cap whose call has no whole count of units above 0", () => {
    for (const units of [0, -4, 1.5, Number.NaN]) expect(() => channelOf(server(), { spend: { ...gatesOf(), units } }), String(units)).toThrow("whole count");
  });
});

describe("the status", () => {
  it("gives delivered for an answer, failed for no answer, and accepted for a call that rings", async () => {
    const fake = server(
      { status: 200, body: { sid: SID, status: "completed", answered_by: "human" } },
      { status: 200, body: { sid: SID, status: "completed", answered_by: "machine_end_beep" } },
      { status: 200, body: { sid: SID, status: "no-answer" } },
      { status: 200, body: { sid: SID, status: "ringing" } },
    );
    const channel = channelOf(fake);
    const status = () => channel.status({ receipt: { call: SID } });
    expect(await status()).toMatchObject({ state: "delivered", reason: "A person answered the call." });
    expect(await status()).toMatchObject({ state: "delivered", reason: "A machine answered the call." });
    expect(await status()).toMatchObject({ state: "failed", reason: "Nobody answered the call (no-answer)." });
    expect(await status()).toEqual({ state: "accepted", at: AT });
    expect(fake.calls.map((call) => call.method)).toEqual(["GET", "GET", "GET", "GET"]);
  });

  it("keeps accepted for a receipt with no SID, a bad SID and a read that failed", async () => {
    const fake = server({ status: 500, body: {} });
    const channel = channelOf(fake);
    expect(await channel.status({ receipt: {} })).toMatchObject({ state: "accepted" });
    expect(await channel.status({ receipt: { call: "CA1" } })).toMatchObject({ state: "accepted" });
    expect(await channel.status({ receipt: { call: SID } })).toMatchObject({ state: "accepted" });
    expect(fake.calls).toHaveLength(1);
  });
});

describe("the check of the setup", () => {
  it("finds a bad account SID, a bad key SID, an empty secret and a bad number, and names no value", () => {
    expect(twilioSetupProblems(CREDENTIALS, FROM)).toEqual([]);
    const bad = twilioSetupProblems({ accountSid: "AC-bad-value", secret: "fake-secret" }, "+1-bad-value");
    expect(bad).toEqual(["The account SID is not AC and 32 hexadecimal digits.", "The number that calls is not a phone number in E.164 form."]);
    expect(twilioSetupProblems({ ...CREDENTIALS, keySid: "SK-bad-value" }, FROM)).toEqual(["The API key SID is not SK and 32 hexadecimal digits."]);
    expect(twilioSetupProblems({ ...CREDENTIALS, secret: "" }, FROM)).toHaveLength(1);
    // The number must match as a whole: a valid number with more text after it is not valid.
    expect(twilioSetupProblems(CREDENTIALS, `${FROM}x`)).toHaveLength(1);
    expect(JSON.stringify(bad)).not.toContain("bad-value");
  });
});

describe("the read of the balance", () => {
  it("gives the balance and the currency of the account", async () => {
    const fake = server({ status: 200, body: { account_sid: ACCOUNT, balance: "-1.83164", currency: "USD" } });
    expect(await readTwilioBalance({ credentials: CREDENTIALS, fetch: fake.fetch })).toEqual({ ok: true, balance: -1.83164, currency: "USD" });
    expect(fake.calls).toMatchObject([{ method: "GET", url: `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Balance.json` }]);
  });

  it("gives each failure as a value, and makes no request with a bad account SID", async () => {
    const fake = server({ status: 401, body: { code: 20003, message: "Authenticate" } }, new TypeError("fetch failed"), { status: 200, body: { balance: "a lot" } });
    const read = () => readTwilioBalance({ credentials: CREDENTIALS, fetch: fake.fetch });
    expect(await read()).toMatchObject({ ok: false, message: expect.stringContaining("(auth)") });
    expect(await read()).toMatchObject({ ok: false, message: expect.stringContaining("(network)") });
    expect(await read()).toMatchObject({ ok: false, message: expect.stringContaining("no balance") });
    expect(await readTwilioBalance({ credentials: { accountSid: "AC1", secret: "fake-secret" }, fetch: fake.fetch })).toMatchObject({ ok: false });
    expect(fake.calls).toHaveLength(3);
  });

  it("throws the reason of the signal at its abort", async () => {
    const stop = new AbortController();
    const fetch: TwilioFetch = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    const read = readTwilioBalance({ credentials: CREDENTIALS, fetch }, stop.signal);
    stop.abort(new Error("The runtime stops."));
    await expect(read).rejects.toThrow("The runtime stops.");
  });
});

describe("the cancel", () => {
  it("ends the call of a receipt, and ends with no error when Twilio does not know it", async () => {
    const fake = server({ status: 200, body: { sid: SID, status: "completed" } }, { status: 404, body: { code: 20404, message: "Not found" } });
    const channel = channelOf(fake);
    await channel.cancel({ receipt: { call: SID } });
    await channel.cancel({ receipt: { call: SID } });
    expect(fake.calls.map((call) => [call.method, call.fields["Status"]])).toEqual([
      ["POST", "completed"],
      ["POST", "completed"],
    ]);
  });

  it("does nothing for a copy, a receipt with no SID and a bad SID, and throws when Twilio fails", async () => {
    const fake = server({ status: 503, body: {} });
    const channel = channelOf(fake);
    await channel.cancel({ copy: "run-1-1" });
    await channel.cancel({ receipt: {} });
    await channel.cancel({ receipt: { call: "CA1" } });
    expect(fake.calls).toEqual([]);
    await expect(channel.cancel({ receipt: { call: SID } })).rejects.toThrow("Twilio did not end the call (server)");
  });
});

describe("the probe of the call channel", () => {
  const balance: Answer = { status: 200, body: { balance: "12.5", currency: "USD", account_sid: ACCOUNT } };

  it("reads the balance of the account, makes no call, and gives the time of the pass", async () => {
    const fake = server(balance);
    expect(await channelOf(fake).probe?.()).toEqual({ ok: true, at: AT });
    expect(fake.calls).toMatchObject([{ method: "GET", url: `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Balance.json` }]);
  });

  it("gives refused credentials, a server error and a network fault as failures", async () => {
    const fake = server({ status: 401, body: { code: 20003, message: "Authenticate" } }, { status: 503, body: {} }, new TypeError("fetch failed"));
    const channel = channelOf(fake);
    const kinds = [];
    for (let index = 0; index < 3; index += 1) {
      const outcome = await channel.probe?.();
      kinds.push(outcome?.ok === false ? outcome.kind : "ok");
    }
    expect(kinds).toEqual(["auth", "server", "network"]);
  });

  it("refuses an account SID of the wrong form with no request", async () => {
    const fake = server();
    expect(await channelOf(fake, { credentials: { accountSid: "AC1", secret: "fake-secret" } }).probe?.()).toMatchObject({ ok: false, kind: "auth" });
    expect(fake.calls).toEqual([]);
  });
});

describe("the services of a contact", () => {
  it("gives the voice node of the region of the phone, and an empty list for a phone that it cannot read, with no request", () => {
    const fake = server();
    const channel = channelOf(fake);
    // 202-555-0143 is a number for fiction.
    expect(channel.services?.({ address: { to: "+12025550143" } })).toEqual(["provider-region:twilio/north-america/voice"]);
    expect(channel.services?.({ address: ADDRESS })).toEqual([]);
    expect(fake.calls).toEqual([]);
  });
});
