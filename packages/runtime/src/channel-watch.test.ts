import { fakeWallClock } from "@mark1russell7/algebra/clock";
import { DEFAULT_CHANNEL_DOWN, runOpens, type ChannelId, type ChannelProcedures, type Delivery, type HealthTrack, type ProbeOutcome, type SourceId } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { channelWatch, lastFetchSuccess, PROBE_BACKOFF, PROBE_IDLE } from "./channel-watch.ts";
import type { DeliveryFailure, DeliveryStep } from "./delivery.ts";

// The watch of the channels of one copy (AL-65). Each name and endpoint is made up.

const T0 = Date.UTC(2026, 3, 1, 18, 0, 0);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const PUSH = "push" as ChannelId;
const TEXT = "text" as ChannelId;

function procedures(id: ChannelId, probe?: () => Promise<ProbeOutcome>): ChannelProcedures {
  return {
    describe: () => ({ id, title: `The ${id} channel`, dependsOn: [], services: [`domain:${id}.example.com`], api: [`domain:${id}.example.com`], uses: ["internet", "dns"], breaksThrough: true, repeats: false, ack: "none", maxTitle: 250, maxBody: 1024 }),
    send: async () => ({ ok: true, receipt: {}, accepted: T0 }),
    status: async () => ({ state: "delivered", at: T0 }),
    cancel: async () => undefined,
    ...(probe === undefined ? {} : { probe }),
  };
}

const EMPTY: DeliveryStep = { routes: [], sent: [], duplicates: [], stopped: [], acknowledged: [], cancelled: [], failures: [], conflicts: [], overdue: [], exhausted: [] };

function failed(channel: ChannelId, kind: string, call: DeliveryFailure["call"] = "send"): DeliveryFailure {
  return { call, key: "k", channel, kind, message: "The test channel failed.", retryAt: T0 };
}

function sent(channel: ChannelId, at: number): Delivery {
  return { key: "k", channel, at, receipt: {} } as unknown as Delivery;
}

describe("the watch of the channels", () => {
  it("gives each channel with its title and its endpoints, and a run after failed calls", () => {
    const clock = fakeWallClock(T0);
    const watch = channelWatch({ copy: "copy-a", channels: [procedures(PUSH), procedures(TEXT)], policy: DEFAULT_CHANNEL_DOWN, clock, callLimit: 10 * SECOND });
    expect(watch.snapshots()).toEqual([
      { copy: "copy-a", channel: PUSH, title: "The push channel", api: ["domain:push.example.com"] },
      { copy: "copy-a", channel: TEXT, title: "The text channel", api: ["domain:text.example.com"] },
    ]);
    watch.step({ ...EMPTY, failures: [failed(PUSH, "server"), failed(TEXT, "consent")] }, T0, []);
    expect(watch.snapshots()[0]?.run).toEqual({ channel: PUSH, failures: 1, first: T0, last: T0, kind: "server", reached: true });
    expect(watch.snapshots()[1]).not.toHaveProperty("run");
    expect(watch.wakeAt()).toBeUndefined();
  });

  it("wakes the next pass when a run starts to open a line, and when a down channel gets an accepted send", () => {
    const clock = fakeWallClock(T0);
    const watch = channelWatch({ copy: "copy-a", channels: [procedures(PUSH)], policy: DEFAULT_CHANNEL_DOWN, clock, callLimit: 10 * SECOND });
    expect(watch.step({ ...EMPTY, failures: [failed(PUSH, "timeout")] }, T0, [], T0 + 1)).toBe(false);
    expect(watch.step({ ...EMPTY, failures: [failed(PUSH, "timeout")] }, T0 + 30 * SECOND, [], T0 + 10 * SECOND)).toBe(false);
    // The third failure 60 s after the first opens the line in the next view.
    expect(watch.step({ ...EMPTY, failures: [failed(PUSH, "timeout")] }, T0 + MINUTE, [], T0 + 10 * SECOND)).toBe(true);
    // The line is open now. More failures change nothing.
    expect(watch.step({ ...EMPTY, failures: [failed(PUSH, "timeout")] }, T0 + 2 * MINUTE, [PUSH], T0 + 10 * SECOND)).toBe(false);
    // An accepted send ends the run, keeps its time, and ends the line in the next view.
    expect(watch.step({ ...EMPTY, sent: [sent(PUSH, T0 + 3 * MINUTE)] }, T0 + 3 * MINUTE, [PUSH])).toBe(true);
    expect(watch.snapshots()[0]).toMatchObject({ good: T0 + 3 * MINUTE });
    expect(watch.snapshots()[0]).not.toHaveProperty("run");
  });

  it("probes each channel 1 minute after the start, 15 minutes after a good call, and on a backoff after failed probes", async () => {
    const clock = fakeWallClock(T0);
    let up = true;
    const at: number[] = [];
    const probe = async (): Promise<ProbeOutcome> => {
      at.push(clock.now());
      return up ? { ok: true, at: clock.now() } : { ok: false, kind: "server", message: "The provider gave the status 503." };
    };
    const watch = channelWatch({ copy: "copy-a", channels: [procedures(PUSH, probe), procedures(TEXT)], policy: DEFAULT_CHANNEL_DOWN, clock, callLimit: 10 * SECOND });
    expect(await watch.probe(T0)).toBe(false);
    expect(at).toEqual([]);
    expect(watch.wakeAt()).toBe(T0 + MINUTE);
    await clock.advance(MINUTE);
    expect(await watch.probe(clock.now())).toBe(true);
    expect(watch.wakeAt()).toBe(T0 + MINUTE + PROBE_IDLE);
    // An accepted send is a good call too: the next probe waits 15 minutes after it.
    watch.step({ ...EMPTY, sent: [sent(PUSH, T0 + 10 * MINUTE)] }, T0 + 10 * MINUTE, []);
    expect(watch.wakeAt()).toBe(T0 + 10 * MINUTE + PROBE_IDLE);

    // The provider fails with no message to send. Each failed probe counts in the run, and the waits grow to 30 minutes.
    up = false;
    const first = at.length;
    for (let index = 0; index < 8; index += 1) {
      await clock.advance(watch.wakeAt()! - clock.now());
      expect(await watch.probe(clock.now())).toBe(false);
    }
    const failed = at.slice(first);
    expect(failed[0]).toBe(T0 + 10 * MINUTE + PROBE_IDLE);
    expect(failed.slice(1).map((time, index) => time - failed[index]!)).toEqual([1, 2, 4, 8, 16, 30, 30].map((minutes) => minutes * MINUTE));
    expect(PROBE_BACKOFF).toEqual({ base: MINUTE, factor: 2, cap: 30 * MINUTE });
    const run = watch.snapshots()[0]?.run;
    expect(run).toMatchObject({ failures: 8, first: failed[0], last: failed[7], kind: "server", reached: true });
    expect(runOpens(run!, DEFAULT_CHANNEL_DOWN)).toBe(true);

    // The provider comes back. The next probe passes and ends the run with no send.
    up = true;
    await clock.advance(watch.wakeAt()! - clock.now());
    expect(await watch.probe(clock.now())).toBe(true);
    expect(watch.snapshots()[0]).toEqual({ copy: "copy-a", channel: PUSH, title: "The push channel", api: ["domain:push.example.com"], good: clock.now() });
    expect(watch.wakeAt()).toBe(clock.now() + PROBE_IDLE);
  });

  it("gives a probe past the call limit as a time-out and a probe that throws as a network failure", async () => {
    const clock = fakeWallClock(T0);
    const CALL = "call" as ChannelId;
    const thrower = async (): Promise<ProbeOutcome> => {
      throw new Error("The socket closed.");
    };
    const watch = channelWatch({ copy: "copy-a", channels: [procedures(PUSH, () => new Promise<ProbeOutcome>(() => undefined)), procedures(TEXT), procedures(CALL, thrower)], policy: DEFAULT_CHANNEL_DOWN, clock, callLimit: 10 * SECOND });
    await watch.probe(T0);
    await clock.advance(MINUTE);
    const pending = watch.probe(clock.now());
    await clock.advance(10 * SECOND);
    expect(await pending).toBe(false);
    // With no source success during the run, a time-out and a network failure do not reach the provider: the copy can be offline.
    const runs = Object.fromEntries(watch.snapshots().map((snapshot) => [snapshot.channel, snapshot.run]));
    expect(runs).toEqual({
      push: { channel: PUSH, failures: 1, first: T0 + MINUTE + 10 * SECOND, last: T0 + MINUTE + 10 * SECOND, kind: "timeout", reached: false },
      text: undefined,
      call: { channel: CALL, failures: 1, first: T0 + MINUTE + 10 * SECOND, last: T0 + MINUTE + 10 * SECOND, kind: "network", reached: false },
    });
    // The text channel has no probe. It keeps a line until an accepted send.
    expect(watch.wakeAt()).toBe(T0 + 2 * MINUTE + 10 * SECOND);
  });

  it("gives each call of the probes and of the steps one time, for the log (AL-147)", async () => {
    const clock = fakeWallClock(T0);
    const watch = channelWatch({ copy: "copy-a", channels: [procedures(PUSH, async () => ({ ok: true, at: clock.now() })), procedures(TEXT)], policy: DEFAULT_CHANNEL_DOWN, clock, callLimit: 10 * SECOND });
    expect(watch.calls()).toEqual([]);
    await watch.probe(T0);
    await clock.advance(MINUTE);
    await watch.probe(clock.now());
    watch.step({ ...EMPTY, failures: [failed(TEXT, "server")], sent: [sent(PUSH, T0 + 2 * MINUTE)] }, T0 + 2 * MINUTE, []);
    expect(watch.calls()).toEqual([
      { channel: PUSH, call: "probe", time: T0 + MINUTE },
      { channel: TEXT, call: "send", kind: "server", time: T0 + 2 * MINUTE },
      { channel: PUSH, call: "send", time: T0 + 2 * MINUTE },
    ]);
    expect(watch.calls()).toEqual([]);
  });

  it("gives the time of the last passed fetch of any source", () => {
    const track = (source: string, passed?: number) => ({ source: source as SourceId, ...(passed === undefined ? {} : { passed: { at: passed, took: 1 } }) }) as unknown as HealthTrack;
    expect(lastFetchSuccess({})).toBeUndefined();
    expect(lastFetchSuccess({ a: track("a", T0), b: track("b"), c: track("c", T0 + 5) })).toBe(T0 + 5);
  });
});
