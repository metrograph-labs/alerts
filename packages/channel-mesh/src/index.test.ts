import { fakeWallClock, type FakeWallClock } from "@mark1russell7/algebra/clock";
import { addressProblems, channelDescriptorSchema, type Level, type Message, type PersonId, type ReportId } from "@mark1russell7/alerts";
import { afterEach, describe, expect, it } from "vitest";
import {
  alarmIdOf,
  decodeFrame,
  MESH_CHANNEL,
  MESH_ID_CHARS,
  meshChannel,
  meshDescriptor,
  meshProblems,
  meshReceiver,
  runMeshReceiver,
  type MeshChannelOptions,
  type MeshLink,
  type MeshReceiver,
} from "./index.ts";
import { simulatedMesh, type SimulatedMesh } from "./testing.ts";

const T0 = Date.UTC(2026, 3, 1, 18);
const KEY = "ab12".repeat(16);
const OTHER = "cd34".repeat(16);
const BEAT = 30_000;
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const message = (level: Level = "life-safety", extra: Partial<Message> = {}): Message => ({
  key: KEY,
  person: "person-1" as PersonId,
  level,
  title: "Tornado warning",
  body: "Take shelter now.",
  incident: "report-1" as ReportId,
  quiet: false,
  ...extra,
});

/** This function moves the clock in steps of one second, and it lets each started step end. */
const walk = async (clock: FakeWallClock, time: number): Promise<void> => {
  for (let moved = 0; moved < time; moved += 1_000) {
    await clock.advance(Math.min(1_000, time - moved));
    await settle();
  }
};

interface Rig {
  readonly clock: FakeWallClock;
  readonly mesh: SimulatedMesh;
  readonly receiver: MeshReceiver;
  readonly sent: string[];
  readonly channel: ReturnType<typeof meshChannel>;
}

const open: Array<{ stop: AbortController; mesh: SimulatedMesh }> = [];

afterEach(() => {
  for (const { stop, mesh } of open.splice(0)) {
    stop.abort();
    mesh.close();
  }
});

/** A channel on a simulated mesh with its receiver loop. Each text that the home writes goes to `sent`. */
const rig = (extra: Partial<MeshChannelOptions> = {}): Rig => {
  const clock = fakeWallClock(T0);
  const mesh = simulatedMesh({ clock, beatMs: BEAT });
  const receiver = meshReceiver({ clock });
  const sent: string[] = [];
  const link: MeshLink = {
    send: (text, signal) => {
      sent.push(text);
      return mesh.link.send(text, signal);
    },
    receive: (signal) => mesh.link.receive(signal),
  };
  const stop = new AbortController();
  open.push({ stop, mesh });
  void runMeshReceiver(receiver, mesh.link, stop.signal);
  const channel = meshChannel({ link, receiver, node: "bed-node", beatMs: BEAT, clock, random: () => 0, ...extra });
  return { clock, mesh, receiver, sent, channel };
};

const kinds = (texts: readonly string[]) => texts.map((text) => decodeFrame(text)).map((read) => (read.tag === "ok" ? read.value.kind : "bad"));

describe("meshDescriptor", () => {
  it("gives a channel that repeats, breaks through and has an ack to poll", () => {
    const descriptor = meshDescriptor();
    expect(channelDescriptorSchema.safeParse(descriptor).success).toBe(true);
    expect(descriptor).toMatchObject({ id: MESH_CHANNEL, dependsOn: [], uses: ["power"], breaksThrough: true, repeats: true, ack: "poll", maxTitle: 0, maxBody: 0 });
    expect(meshDescriptor({ dependsOn: ["link:lora"] }).dependsOn).toEqual(["link:lora"]);
  });

  it("takes an address with no node or with a node name", () => {
    const descriptor = meshDescriptor();
    for (const address of [{}, { node: "bed-node" }]) expect(addressProblems(address, descriptor)).toEqual([]);
    expect(addressProblems({ node: "Bed Node" }, descriptor)).toHaveLength(1);
  });
});

describe("meshProblems and alarmIdOf", () => {
  it("names each bad option", () => {
    const { channel: _channel, ...base } = rig();
    const options = { link: base.mesh.link, receiver: base.receiver, node: "Bed", ackNodes: [], beatMs: 0, stopCount: 0, levels: [], resend: { base: -1 } };
    expect(meshProblems(options).length).toBeGreaterThanOrEqual(6);
    expect(() => meshChannel(options)).toThrow("node");
  });

  it("gives the first characters of the key, and a round after a hyphen", () => {
    expect(alarmIdOf(KEY)).toBe(KEY.slice(0, MESH_ID_CHARS));
    expect(alarmIdOf(KEY, 2)).toBe(`${KEY.slice(0, MESH_ID_CHARS)}-2`);
    expect(alarmIdOf("a b")).toBeUndefined();
    expect(alarmIdOf(KEY, -1)).toBeUndefined();
  });
});

describe("send", () => {
  it("refuses a quiet message, a low level, an old message, a bad copy id and another node", async () => {
    const { channel, sent } = rig();
    expect(await channel.send({ message: message("urgent", { quiet: true }), address: {} })).toMatchObject({ ok: false, kind: "quiet" });
    expect(await channel.send({ message: message("notice"), address: {} })).toMatchObject({ ok: false, kind: "refused" });
    expect(await channel.send({ message: message("urgent", { expires: T0 }), address: {} })).toMatchObject({ ok: false, kind: "expired" });
    expect(await channel.send({ message: message(), address: {}, copy: "a b" })).toMatchObject({ ok: false, kind: "refused" });
    expect(await channel.send({ message: message(), address: { node: "hall-node" } })).toMatchObject({ ok: false, kind: "refused" });
    expect(await channel.send({ message: message("life-safety", { key: "k.1" }), address: {} })).toMatchObject({ ok: false, kind: "refused" });
    expect(sent).toEqual([]);
  });

  it("gives the kind network when the link does not take the first frame", async () => {
    const { channel, mesh, receiver } = rig();
    mesh.breakLink(true);
    const outcome = await channel.send({ message: message(), address: {} });
    expect(outcome).toMatchObject({ ok: false, kind: "network" });
    expect(receiver.armed(KEY.slice(0, MESH_ID_CHARS))).toBe(false);
  });

  it("gives the kind network with the text of the failure when the link throws", async () => {
    const clock = fakeWallClock(T0);
    const link: MeshLink = { send: () => Promise.reject(new Error("The port is gone.")), receive: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) }) };
    const channel = meshChannel({ link, receiver: meshReceiver({ clock }), node: "bed-node", clock });
    expect(await channel.send({ message: message(), address: {} })).toMatchObject({ ok: false, kind: "network", message: expect.stringContaining("The port is gone.") as string });
  });

  it("sounds the siren, writes the frame again on the backoff, and stops at the ack of the bed node", async () => {
    const { channel, clock, mesh, sent } = rig();
    const outcome = await channel.send({ message: message(), address: { node: "bed-node" } });
    expect(outcome).toMatchObject({ ok: true, receipt: { key: KEY, id: KEY.slice(0, MESH_ID_CHARS) }, accepted: T0 });
    if (!outcome.ok) return;
    expect(mesh.node.siren()).toBe(true);
    // The waits are 5, 10, 20 and 40 seconds with no jitter: frames at 0, 5, 15, 35 and 75 seconds.
    await walk(clock, 75_000);
    expect(kinds(sent)).toEqual(["alarm", "alarm", "alarm", "alarm", "alarm"]);
    expect(await channel.status({ receipt: outcome.receipt })).toMatchObject({ state: "accepted" });
    mesh.node.press();
    await settle();
    expect(mesh.node.siren()).toBe(false);
    expect(await channel.status({ receipt: outcome.receipt })).toEqual({ state: "acknowledged", at: T0 + 75_000, by: "bed-node", reason: "A person pushed the button of the node." });
    await walk(clock, 300_000);
    // No alarm frame after the ack, and no stop frame: the button stopped the siren.
    expect(kinds(sent)).toHaveLength(5);
  });

  it("joins the alarm of a live key, and a cancel of one copy leaves the other copy", async () => {
    const { channel, clock, mesh, sent } = rig();
    const first = await channel.send({ message: message(), address: {}, copy: "c1" });
    const second = await channel.send({ message: message(), address: {}, copy: "c2" });
    expect(second).toEqual(first);
    expect(kinds(sent)).toEqual(["alarm"]);
    await channel.cancel({ copy: "c1" });
    await walk(clock, 1_000);
    expect(mesh.node.siren()).toBe(true);
    await channel.cancel({ copy: "c2" });
    await walk(clock, 60_000);
    expect(mesh.node.siren()).toBe(false);
    expect(kinds(sent).filter((kind) => kind === "stop")).toHaveLength(3);
  });

  it("starts an alarm with a new id for a key after the end of its alarm", async () => {
    const { channel, clock, mesh } = rig();
    const first = await channel.send({ message: message(), address: {} });
    await channel.cancel({ receipt: first.ok ? first.receipt : {} });
    await walk(clock, 60_000);
    expect(mesh.node.siren()).toBe(false);
    const again = await channel.send({ message: message(), address: {} });
    expect(again).toMatchObject({ ok: true, receipt: { id: `${KEY.slice(0, MESH_ID_CHARS)}-1` } });
    expect(mesh.node.siren()).toBe(true);
  });
});

describe("status and the end of an alarm", () => {
  it("gives expired after the time expires, and the node stops by itself", async () => {
    const { channel, clock, mesh, sent } = rig();
    const outcome = await channel.send({ message: message("urgent", { expires: T0 + 60_000 }), address: {} });
    if (!outcome.ok) throw new Error("The send failed.");
    await walk(clock, 61_000);
    expect(mesh.node.siren()).toBe(false);
    expect(await channel.status({ receipt: outcome.receipt })).toMatchObject({ state: "expired", at: T0 + 60_000 });
    await walk(clock, 60_000);
    expect(kinds(sent).filter((kind) => kind === "stop")).toHaveLength(3);
  });

  it("gives failed after the time of the sends with no ack", async () => {
    const { channel, clock } = rig({ resendForMs: 120_000 });
    const outcome = await channel.send({ message: message(), address: {} });
    if (!outcome.ok) throw new Error("The send failed.");
    await walk(clock, 121_000);
    expect(await channel.status({ receipt: outcome.receipt })).toMatchObject({ state: "failed" });
  });

  it("gives accepted for a receipt that the channel does not keep, and after a cancel with no ack", async () => {
    const { channel } = rig();
    expect(await channel.status({ receipt: { key: OTHER, id: "nothing" } })).toMatchObject({ state: "accepted" });
    const outcome = await channel.send({ message: message(), address: {} });
    if (!outcome.ok) throw new Error("The send failed.");
    await channel.cancel({ receipt: outcome.receipt });
    await channel.cancel({ receipt: outcome.receipt });
    expect(await channel.status({ receipt: outcome.receipt })).toMatchObject({ state: "accepted", reason: expect.stringContaining("cancel") as string });
  });

  it("takes the ack of another ack node, and stops the siren of the bed node with stop frames", async () => {
    const { channel, clock, mesh, receiver, sent } = rig({ ackNodes: ["bed-node", "hall-node"] });
    const outcome = await channel.send({ message: message(), address: {} });
    if (!outcome.ok) throw new Error("The send failed.");
    receiver.take(`M1 K ${KEY.slice(0, MESH_ID_CHARS)} hall-node ${String(T0)}`);
    expect(await channel.status({ receipt: outcome.receipt })).toMatchObject({ state: "acknowledged", by: "hall-node" });
    await walk(clock, 60_000);
    expect(mesh.node.siren()).toBe(false);
    expect(kinds(sent).filter((kind) => kind === "stop")).toHaveLength(3);
  });
});

describe("probe", () => {
  it("fails before the first beat, passes with a young beat, and fails after the limit with no beat", async () => {
    const clock = fakeWallClock(T0);
    const mesh = simulatedMesh({ clock, beatMs: BEAT, firstBeatMs: 10_000 });
    const receiver = meshReceiver({ clock });
    const stop = new AbortController();
    open.push({ stop, mesh });
    void runMeshReceiver(receiver, mesh.link, stop.signal);
    const channel = meshChannel({ link: mesh.link, receiver, node: "bed-node", beatMs: BEAT, clock });
    expect(await channel.probe?.()).toMatchObject({ ok: false, kind: "network", message: expect.stringContaining("bed node") as string });
    await walk(clock, 10_000);
    expect(await channel.probe?.()).toEqual({ ok: true, at: T0 + 10_000 });
    mesh.node.kill();
    await walk(clock, 3 * BEAT);
    expect(await channel.probe?.()).toMatchObject({ ok: true });
    await walk(clock, 1_000);
    expect(await channel.probe?.()).toMatchObject({ ok: false, kind: "network", message: expect.stringContaining("no heartbeat of the bed node") as string });
    mesh.node.revive();
    await walk(clock, 1_000);
    expect(await channel.probe?.()).toMatchObject({ ok: true });
  });
});
