import { addressProblems, channelDescriptorSchema, type Level, type Message, type PersonId, type ReportId } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import {
  commandOutcome,
  commandSounder,
  createSounderChannel,
  SOUNDER_CHANNEL,
  SOUNDER_COMMAND_LIMIT_MS,
  SOUNDER_GAP_MS,
  SOUNDER_KEPT,
  SOUNDER_SOUNDS,
  sounderDescriptor,
  sounderProblems,
  type CommandOutput,
  type CommandRunner,
  type SoundOutcome,
  type Sounder,
} from "./index.ts";

const AT = Date.UTC(2026, 10, 24, 19, 0);
const KEY = "k".repeat(64);

const message = (level: Level, extra: Partial<Message> = {}): Message => ({
  key: KEY,
  person: "person-1" as PersonId,
  level,
  title: "Tornado warning",
  body: "Take shelter now.",
  incident: "report-1" as ReportId,
  quiet: false,
  ...extra,
});

/** This function lets each started step of the channel end. No timer is necessary, because each fake answers at once. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A gate: a promise that a test opens. */
const gate = () => {
  let open: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { closed, open };
};

/**
 * A fake device. It records the level of each sound and gives the next answer of the list, or a pass. With `hold`, each
 * sound ends only when the test opens its gate, or at the abort of its signal.
 */
const device = (options: { readonly answers?: SoundOutcome[]; readonly hold?: boolean } = {}) => {
  const sounds: Level[] = [];
  const gates: Array<() => void> = [];
  const answers = [...(options.answers ?? [])];
  let active = 0;
  let most = 0;
  const sounder: Sounder = {
    async sound({ level, signal }) {
      sounds.push(level);
      active += 1;
      most = Math.max(most, active);
      if (options.hold === true) {
        const held = gate();
        gates.push(held.open);
        signal.addEventListener("abort", held.open, { once: true });
        await held.closed;
      }
      active -= 1;
      return answers.shift() ?? { ok: true };
    },
  };
  return { sounder, sounds, gates, overlap: () => most };
};

/** A fake wait. It records each time and ends at once. */
const waits = () => {
  const times: number[] = [];
  const wait = (time: number): Promise<void> => {
    times.push(time);
    return Promise.resolve();
  };
  return { wait, times };
};

describe("sounderDescriptor", () => {
  it("passes the schema of a descriptor, and it repeats with no acknowledgment", () => {
    const descriptor = sounderDescriptor();
    expect(channelDescriptorSchema.safeParse(descriptor).success).toBe(true);
    expect(descriptor).toMatchObject({ id: SOUNDER_CHANNEL, dependsOn: [], uses: ["power"], breaksThrough: false, repeats: true, ack: "none" });
  });

  it("takes the facts of the sounders", () => {
    const descriptor = sounderDescriptor({ breaksThrough: true, dependsOn: ["link:radio"] });
    expect(channelDescriptorSchema.safeParse(descriptor).success).toBe(true);
    expect(descriptor).toMatchObject({ breaksThrough: true, dependsOn: ["link:radio"] });
  });

  it("takes an address with no field or with the name of a device, and refuses each other address", () => {
    const descriptor = sounderDescriptor();
    for (const address of [{}, { device: "bedroom" }, { device: "desk-2" }]) expect(addressProblems(address, descriptor), JSON.stringify(address)).toEqual([]);
    for (const address of [{ device: "Bed Room" }, { device: "" }, { device: "-desk" }, { device: "a".repeat(33) }, { url: "https://example.test/" }]) {
      expect(addressProblems(address, descriptor), JSON.stringify(address)).toHaveLength(1);
    }
  });
});

describe("sounderProblems", () => {
  const { sounder } = device();

  it("gives no problem for good options", () => {
    expect(sounderProblems({ sounders: { desk: sounder }, sounds: { urgent: 0, notice: 2 }, gapMs: 0 })).toEqual([]);
  });

  it("names each bad option, and no value", () => {
    expect(sounderProblems({ sounders: {} })).toHaveLength(1);
    const problems = sounderProblems({ sounders: { "My Desk": sounder, desk: sounder }, sounds: { urgent: 1.5, notice: -1 }, gapMs: Number.NaN });
    expect(problems).toHaveLength(4);
    expect(problems.join(" ")).not.toContain("My Desk");
  });

  it("stops the start of a channel with a problem", () => {
    expect(() => createSounderChannel({ sounders: {} })).toThrow("The channel has no sounder.");
  });
});

describe("createSounderChannel", () => {
  it("makes the first sound before the answer, and the other sounds of the level after it", async () => {
    const { sounder, sounds } = device();
    const { wait, times } = waits();
    const channel = createSounderChannel({ sounders: { desk: sounder }, now: () => AT, wait });
    const outcome = await channel.send({ message: message("urgent"), address: {}, copy: "copy-a-1" });
    expect(outcome).toEqual({ ok: true, receipt: { key: KEY, device: "desk", play: "1" }, accepted: AT });
    expect(sounds.length).toBeGreaterThanOrEqual(1);
    await settle();
    expect(sounds).toEqual(Array.from({ length: SOUNDER_SOUNDS.urgent }, () => "urgent"));
    expect(times).toEqual(Array.from({ length: SOUNDER_SOUNDS.urgent - 1 }, () => SOUNDER_GAP_MS));
    if (!outcome.ok) throw new Error(outcome.message);
    expect(await channel.status({ receipt: outcome.receipt })).toEqual({ state: "delivered", at: AT, reason: "The sounds ended: 3 of 3 sounds." });
  });

  it("takes the count of the sounds and the wait from the options", async () => {
    const { sounder, sounds } = device();
    const { wait, times } = waits();
    const channel = createSounderChannel({ sounders: { desk: sounder }, sounds: { notice: 4 }, gapMs: 250, wait });
    expect(await channel.send({ message: message("notice"), address: {} })).toMatchObject({ ok: true });
    await settle();
    expect(sounds).toHaveLength(4);
    expect(times).toEqual([250, 250, 250]);
  });

  it("gives the failure of the first sound, and makes no more sounds", async () => {
    const { sounder, sounds } = device({ answers: [{ ok: false, kind: "timeout", message: "The program did not end in its time limit." }] });
    const channel = createSounderChannel({ sounders: { desk: sounder }, wait: waits().wait });
    expect(await channel.send({ message: message("life-safety"), address: {} })).toEqual({ ok: false, kind: "timeout", message: "The program did not end in its time limit." });
    await settle();
    expect(sounds).toHaveLength(1);
    expect(await channel.status({ receipt: { key: KEY, device: "desk", play: "1" } })).toMatchObject({ state: "accepted" });
  });

  it("continues after a failed sound, and its status tells the failure of the last sound", async () => {
    const failure: SoundOutcome = { ok: false, kind: "server", message: "The program ended with the exit code 1." };
    const { sounder, sounds } = device({ answers: [{ ok: true }, failure, failure] });
    const channel = createSounderChannel({ sounders: { desk: sounder }, now: () => AT, wait: waits().wait });
    const outcome = await channel.send({ message: message("urgent"), address: {} });
    await settle();
    expect(sounds).toHaveLength(3);
    if (!outcome.ok) throw new Error(outcome.message);
    expect(await channel.status({ receipt: outcome.receipt })).toEqual({ state: "failed", at: AT, reason: "The last sound failed after 1 of 3 sounds: The program ended with the exit code 1." });
  });

  it("guards against a sounder that throws", async () => {
    const sounder: Sounder = { sound: () => Promise.reject(new Error("a fault")) };
    const channel = createSounderChannel({ sounders: { desk: sounder } });
    expect(await channel.send({ message: message("notice"), address: {} })).toEqual({ ok: false, kind: "server", message: "The sounder threw." });
  });

  it("makes no sound for a quiet message, an expired message, a bad copy id or a level with no sound", async () => {
    const { sounder, sounds } = device();
    const channel = createSounderChannel({ sounders: { desk: sounder }, sounds: { digest: 0 }, now: () => AT, wait: waits().wait });
    expect(await channel.send({ message: message("urgent", { quiet: true }), address: {} })).toMatchObject({ ok: false, kind: "quiet" });
    expect(await channel.send({ message: message("urgent", { expires: AT }), address: {} })).toMatchObject({ ok: false, kind: "expired" });
    expect(await channel.send({ message: message("urgent"), address: {}, copy: "a copy" })).toMatchObject({ ok: false, kind: "refused" });
    expect(await channel.send({ message: message("digest"), address: {} })).toMatchObject({ ok: false, kind: "refused" });
    await settle();
    expect(sounds).toEqual([]);
  });

  it("sends to the device of the address, and refuses an address with no known device", async () => {
    const desk = device();
    const bedroom = device();
    const channel = createSounderChannel({ sounders: { desk: desk.sounder, bedroom: bedroom.sounder }, wait: waits().wait });
    expect(await channel.send({ message: message("notice"), address: { device: "bedroom" } })).toMatchObject({ ok: true, receipt: { device: "bedroom" } });
    const unknown = await channel.send({ message: message("notice"), address: { device: "attic" } });
    expect(unknown).toMatchObject({ ok: false, kind: "refused" });
    expect(JSON.stringify(unknown)).not.toContain("attic");
    expect(await channel.send({ message: message("notice"), address: {} })).toMatchObject({ ok: false, kind: "refused" });
    await settle();
    expect(bedroom.sounds).toEqual(["notice"]);
    expect(desk.sounds).toEqual([]);
  });

  it("stops the sounds at the time expires of the message", async () => {
    const { sounder, sounds } = device();
    let at = AT;
    const wait = (): Promise<void> => {
      at += 1000;
      return Promise.resolve();
    };
    const channel = createSounderChannel({ sounders: { desk: sounder }, now: () => at, wait });
    // The first sound is at the send. The waits end at 1 s and 2 s, and the message expires at 2 s.
    expect(await channel.send({ message: message("life-safety", { expires: AT + 2000 }), address: {} })).toMatchObject({ ok: true });
    await settle();
    expect(sounds).toHaveLength(2);
  });

  it("stops one copy by its copy id, and the other copy of the key continues", async () => {
    const { sounder, sounds, gates } = device({ hold: true });
    const channel = createSounderChannel({ sounders: { desk: sounder }, sounds: { urgent: 2 }, wait: waits().wait });
    const first = channel.send({ message: message("urgent"), address: {}, copy: "copy-a-1" });
    const second = channel.send({ message: message("urgent"), address: {}, copy: "copy-a-2" });
    await settle();
    // The first sound of the first copy is in progress. The stop ends it, and the copy makes no more sounds.
    expect(sounds).toHaveLength(1);
    await channel.cancel({ copy: "copy-a-1" });
    expect(await first).toMatchObject({ ok: true });
    await settle();
    expect(sounds).toHaveLength(2);
    gates[1]?.();
    expect(await second).toMatchObject({ ok: true });
    await settle();
    gates[2]?.();
    await settle();
    expect(sounds).toHaveLength(3);
    const outcome = await second;
    if (!outcome.ok) throw new Error(outcome.message);
    expect(await channel.status({ receipt: outcome.receipt })).toMatchObject({ state: "delivered", reason: "The sounds ended: 2 of 2 sounds." });
  });

  it("stops each copy of a key by a receipt, and a cancel is idempotent", async () => {
    const { sounder, sounds } = device();
    const pending: Array<() => void> = [];
    const wait = (_time: number, signal: AbortSignal): Promise<void> =>
      new Promise((resolve) => {
        pending.push(resolve);
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    const channel = createSounderChannel({ sounders: { desk: sounder }, wait });
    const one = await channel.send({ message: message("life-safety"), address: {}, copy: "copy-a-1" });
    const two = await channel.send({ message: message("life-safety"), address: {}, copy: "copy-a-2" });
    const other = await channel.send({ message: message("life-safety", { key: "o".repeat(64) }), address: {}, copy: "copy-a-3" });
    if (!one.ok || !two.ok || !other.ok) throw new Error("A send failed.");
    expect(sounds).toHaveLength(3);
    await channel.cancel({ receipt: one.receipt });
    await channel.cancel({ receipt: one.receipt });
    await channel.cancel({ copy: "copy-of-no-send" });
    await settle();
    expect(await channel.status({ receipt: two.receipt })).toMatchObject({ state: "delivered", reason: "The sounds ended: 1 of 60 sounds." });
    // The message of the other key continues.
    for (const open of pending.splice(0)) open();
    await settle();
    expect(sounds).toHaveLength(4);
    expect(await channel.status({ receipt: other.receipt })).toMatchObject({ state: "delivered", reason: "The device made 2 of 60 sounds." });
    await channel.cancel({ receipt: other.receipt });
  });

  it("makes one sound at a time on one device", async () => {
    const { sounder, sounds, gates, overlap } = device({ hold: true });
    const channel = createSounderChannel({ sounders: { desk: sounder }, wait: waits().wait });
    const sends = [channel.send({ message: message("notice"), address: {} }), channel.send({ message: message("notice", { key: "o".repeat(64) }), address: {} })];
    await settle();
    expect(sounds).toHaveLength(1);
    gates[0]?.();
    await settle();
    expect(sounds).toHaveLength(2);
    gates[1]?.();
    expect(await Promise.all(sends)).toMatchObject([{ ok: true }, { ok: true }]);
    expect(overlap()).toBe(1);
  });

  it("joins a second send of one message to one device into the play of the first", async () => {
    const { sounder, sounds, gates } = device({ hold: true });
    const channel = createSounderChannel({ sounders: { desk: sounder }, sounds: { notice: 1 }, wait: waits().wait });
    // An escalation sends one message to two persons near one device at the same time.
    const sends = [channel.send({ message: message("notice"), address: {} }), channel.send({ message: message("notice", { person: "p-2" as PersonId }), address: {} })];
    await settle();
    expect(sounds).toHaveLength(1);
    gates[0]?.();
    const [one, two] = await Promise.all(sends);
    expect(two).toEqual(one);
    expect(sounds).toHaveLength(1);
    // Another copy makes its own play.
    const other = channel.send({ message: message("notice"), address: {}, copy: "cloud" });
    await settle();
    expect(sounds).toHaveLength(2);
    gates[1]?.();
    expect(await other).toMatchObject({ ok: true });
  });

  it("gives no delivered state when a cancel stops the first sound", async () => {
    const { sounder, gates } = device({ hold: true });
    const channel = createSounderChannel({ sounders: { desk: sounder }, wait: waits().wait });
    const send = channel.send({ message: message("urgent"), address: {} });
    await settle();
    await channel.cancel({ receipt: { key: KEY } });
    gates[0]?.();
    const sent = await send;
    if (!sent.ok) throw new Error(sent.message);
    expect(await channel.status({ receipt: sent.receipt })).toMatchObject({ state: "accepted" });
  });

  it("keeps the last ended messages only, and a receipt of another key has no status", async () => {
    const { sounder } = device();
    const channel = createSounderChannel({ sounders: { desk: sounder }, wait: waits().wait });
    const first = await channel.send({ message: message("notice"), address: {} });
    if (!first.ok) throw new Error(first.message);
    expect(await channel.status({ receipt: { ...first.receipt, key: "o".repeat(64) } })).toMatchObject({ state: "accepted" });
    expect(await channel.status({ receipt: {} })).toMatchObject({ state: "accepted" });
    for (let index = 0; index < SOUNDER_KEPT; index += 1) await channel.send({ message: message("notice"), address: {} });
    await settle();
    expect(await channel.status({ receipt: first.receipt })).toMatchObject({ state: "accepted" });
  });

  it("has a probe only when a sounder has one, and a failed probe names the device", async () => {
    const { sounder } = device();
    expect(createSounderChannel({ sounders: { desk: sounder } }).probe).toBeUndefined();
    const good: Sounder = { ...sounder, probe: () => Promise.resolve({ ok: true }) };
    const bad: Sounder = { ...sounder, probe: () => Promise.resolve({ ok: false, kind: "refused", message: "The program did not start." }) };
    const thrower: Sounder = { ...sounder, probe: () => Promise.reject(new Error("a fault")) };
    expect(await createSounderChannel({ sounders: { desk: sounder, bedroom: good }, now: () => AT }).probe?.()).toEqual({ ok: true, at: AT });
    expect(await createSounderChannel({ sounders: { desk: good, bedroom: bad } }).probe?.()).toEqual({ ok: false, kind: "refused", message: "The sounder bedroom: The program did not start." });
    expect(await createSounderChannel({ sounders: { desk: thrower } }).probe?.()).toEqual({ ok: false, kind: "server", message: "The sounder desk: The probe threw." });
  });
});

describe("commandOutcome", () => {
  it("gives the kind of each output of a program", () => {
    expect(commandOutcome({ exitCode: 0 })).toEqual({ ok: true });
    expect(commandOutcome({ exitCode: 1, notStarted: true })).toMatchObject({ ok: false, kind: "refused" });
    expect(commandOutcome({ exitCode: 1, timedOut: true })).toMatchObject({ ok: false, kind: "timeout" });
    expect(commandOutcome({ exitCode: 3 })).toEqual({ ok: false, kind: "server", message: "The program ended with the exit code 3." });
  });
});

describe("commandSounder", () => {
  /** A fake runner. It records each call and gives the next output, or a pass. */
  const runner = (...outputs: Array<CommandOutput | Error>) => {
    const calls: Array<{ readonly argv: readonly string[]; readonly signal: AbortSignal; readonly limit: number }> = [];
    const run: CommandRunner = async (argv, signal, limit) => {
      calls.push({ argv, signal, limit });
      const output = outputs.shift() ?? { exitCode: 0 };
      if (output instanceof Error) throw output;
      return output;
    };
    return { run, calls };
  };
  const SOUND = ["play", "alarm.wav"];

  it("starts the program of the level with the signal and the time limit", async () => {
    const { run, calls } = runner();
    const sounder = commandSounder({ sound: SOUND, levels: { "life-safety": ["play", "siren.wav"] }, run });
    const stop = new AbortController();
    expect(await sounder.sound({ level: "urgent", signal: stop.signal })).toEqual({ ok: true });
    expect(await sounder.sound({ level: "life-safety", signal: stop.signal })).toEqual({ ok: true });
    expect(calls).toEqual([
      { argv: SOUND, signal: stop.signal, limit: SOUNDER_COMMAND_LIMIT_MS },
      { argv: ["play", "siren.wav"], signal: stop.signal, limit: SOUNDER_COMMAND_LIMIT_MS },
    ]);
    expect(sounder.probe).toBeUndefined();
  });

  it("gives the failure of a program, and its message holds no argument", async () => {
    const { run } = runner({ exitCode: 2 }, { exitCode: 1, timedOut: true }, new Error("spawn alarm.wav"));
    const sounder = commandSounder({ sound: SOUND, run, limitMs: 1500 });
    const signal = new AbortController().signal;
    const outcomes = [await sounder.sound({ level: "notice", signal }), await sounder.sound({ level: "notice", signal }), await sounder.sound({ level: "notice", signal })];
    expect(outcomes.map((outcome) => (outcome.ok ? "ok" : outcome.kind))).toEqual(["server", "timeout", "server"]);
    expect(JSON.stringify(outcomes)).not.toContain("alarm");
  });

  it("refuses an empty command, and starts no program", async () => {
    const { run, calls } = runner();
    expect(await commandSounder({ sound: [], run }).sound({ level: "notice", signal: new AbortController().signal })).toMatchObject({ ok: false, kind: "refused" });
    expect(calls).toEqual([]);
  });

  it("examines the device with the probe program", async () => {
    const { run, calls } = runner({ exitCode: 0 }, { exitCode: 1, notStarted: true });
    const sounder = commandSounder({ sound: SOUND, probe: ["play", "--check"], run, limitMs: 1500 });
    expect(await sounder.probe?.()).toEqual({ ok: true });
    expect(await sounder.probe?.()).toMatchObject({ ok: false, kind: "refused" });
    expect(calls.map((call) => [call.argv, call.limit])).toEqual([
      [["play", "--check"], 1500],
      [["play", "--check"], 1500],
    ]);
  });

  it("serves the channel: a stop of a message ends its program", async () => {
    const signals: AbortSignal[] = [];
    const run: CommandRunner = (_argv, signal) =>
      new Promise((resolve) => {
        signals.push(signal);
        signal.addEventListener("abort", () => resolve({ exitCode: 1 }), { once: true });
      });
    const channel = createSounderChannel({ sounders: { desk: commandSounder({ sound: SOUND, run }) }, wait: waits().wait });
    const sent = channel.send({ message: message("life-safety"), address: {}, copy: "copy-a-1" });
    await settle();
    await channel.cancel({ copy: "copy-a-1" });
    const outcome = await sent;
    expect(outcome).toMatchObject({ ok: true });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    if (!outcome.ok) throw new Error(outcome.message);
    // The cancel stopped the first sound before its end. Thus no sound is sure, and the state is not delivered.
    expect(await channel.status({ receipt: outcome.receipt })).toMatchObject({ state: "accepted", reason: "A cancel stopped the play before the end of the first sound." });
  });
});
