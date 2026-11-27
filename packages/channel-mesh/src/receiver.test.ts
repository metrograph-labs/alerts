import { fakeClock, fakeWallClock } from "@mark1russell7/algebra/clock";
import { service } from "@mark1russell7/service";
import { detachedLifecycle } from "@mark1russell7/service/testing";
import { describe, expect, it } from "vitest";
import { encodeFrame } from "./protocol.ts";
import { meshReceiver, meshReceiverWorker, RECEIVER_KEPT, runMeshReceiver, type MeshLink } from "./receiver.ts";
import { simulatedMesh } from "./testing.ts";

const T0 = Date.UTC(2026, 3, 1, 18);
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const ack = (id: string, by = "bed-node", at = T0) => encodeFrame({ v: 1, kind: "ack", id, by, at });
const beat = (seq: number, at: number, node = "bed-node") => encodeFrame({ v: 1, kind: "beat", node, seq, at });

describe("meshReceiver", () => {
  it("keeps one ack for each node of an armed id, and counts a frame that comes again once", () => {
    const clock = fakeWallClock(T0);
    const receiver = meshReceiver({ clock });
    receiver.arm("a1");
    expect(receiver.take(ack("a1"))).toBe("ack");
    expect(receiver.take(ack("a1"))).toBe("duplicate");
    expect(receiver.take(ack("a1", "bed-node", T0 + 9))).toBe("duplicate");
    expect(receiver.take(ack("a1", "hall-node"))).toBe("ack");
    expect(receiver.acksOf("a1").map((one) => one.by)).toEqual(["bed-node", "hall-node"]);
    expect(receiver.counts()).toMatchObject({ ack: 2, duplicate: 2 });
  });

  it("gives an ack for an id that is not armed no effect", () => {
    const receiver = meshReceiver({ clock: fakeWallClock(T0) });
    expect(receiver.take(ack("old"))).toBe("stray");
    receiver.arm("new");
    expect(receiver.take(ack("old"))).toBe("stray");
    expect(receiver.acksOf("new")).toEqual([]);
    receiver.disarm("new");
    expect(receiver.take(ack("new"))).toBe("stray");
    expect(receiver.armed("new")).toBe(false);
  });

  it("keeps the acks of a disarmed id, and forgets the oldest after RECEIVER_KEPT ids", () => {
    const receiver = meshReceiver({ clock: fakeWallClock(T0) });
    for (let index = 0; index <= RECEIVER_KEPT; index += 1) {
      receiver.arm(`a${String(index)}`);
      receiver.take(ack(`a${String(index)}`));
      receiver.disarm(`a${String(index)}`);
    }
    expect(receiver.acksOf("a0")).toEqual([]);
    expect(receiver.acksOf("a1")).toHaveLength(1);
  });

  it("keeps the last beat of each node with the time of the home, and counts a beat that comes again once", async () => {
    const clock = fakeWallClock(T0);
    const receiver = meshReceiver({ clock });
    // The clock of the node is one hour late. The receiver keeps the time when it got the beat.
    expect(receiver.take(beat(0, T0 - 3_600_000))).toBe("beat");
    await clock.advance(5_000);
    expect(receiver.take(beat(0, T0 - 3_600_000))).toBe("duplicate");
    expect(receiver.beatOf("bed-node")).toEqual({ node: "bed-node", seq: 0, at: T0 - 3_600_000, heard: T0 });
    // A restart of the node starts its sequence at 0 again, with a new time.
    expect(receiver.take(beat(0, T0 + 5_000))).toBe("beat");
    expect(receiver.beatOf("bed-node")?.heard).toBe(T0 + 5_000);
    expect(receiver.beatOf("hall-node")).toBeUndefined();
  });

  it("ignores an alarm and a stop, and rejects a text that is not a frame", () => {
    const receiver = meshReceiver({ clock: fakeWallClock(T0) });
    expect(receiver.take(encodeFrame({ v: 1, kind: "stop", id: "a1" }))).toBe("ignored");
    expect(receiver.take(encodeFrame({ v: 1, kind: "alarm", id: "a1", level: "urgent", seq: 0 }))).toBe("ignored");
    expect(receiver.take("hello")).toBe("rejected");
    expect(receiver.take("M9 S a1")).toBe("rejected");
    expect(receiver.counts()).toEqual({ ack: 0, beat: 0, duplicate: 0, stray: 0, ignored: 2, rejected: 2 });
  });
});

describe("runMeshReceiver", () => {
  it("reads the texts of the link until the abort", async () => {
    const clock = fakeWallClock(T0);
    const mesh = simulatedMesh({ clock, beatMs: 30_000 });
    const receiver = meshReceiver({ clock });
    const stop = new AbortController();
    const loop = runMeshReceiver(receiver, mesh.link, stop.signal);
    await settle();
    await clock.advance(60_000);
    await settle();
    expect(receiver.counts().beat).toBe(3);
    stop.abort();
    await loop;
    mesh.close();
  });

  it("throws a failure of the link", async () => {
    const link: MeshLink = {
      send: () => Promise.resolve({ ok: true }),
      receive: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("The port closed.")) }),
      }),
    };
    await expect(runMeshReceiver(meshReceiver({ clock: fakeWallClock(T0) }), link, new AbortController().signal)).rejects.toThrow("The port closed.");
  });
});

describe("meshReceiverWorker", () => {
  it("reads the link in each iteration, and a service declares it as a worker", async () => {
    const mono = fakeClock(0);
    const clock = fakeWallClock(T0, mono);
    const mesh = simulatedMesh({ clock, beatMs: 30_000 });
    const receiver = meshReceiver({ clock });
    const worker = meshReceiverWorker({ receiver, link: mesh.link, clock: mono, readMs: 20_000 });
    expect(() => service("mesh-test").worker("mesh-receiver", worker.knobs, worker)).not.toThrow();
    await worker.start(new AbortController().signal, detachedLifecycle(mono));
    for (let step = 0; step < 10; step += 1) {
      await mono.advance(10_000);
      await settle();
    }
    // The beats at 0, 30, 60 and 90 seconds came through four reads.
    expect(receiver.counts().beat).toBe(4);
    worker.stopIntake();
    await worker.close();
    mesh.close();
  });

  it("waits its backoff after a link that ends its texts", async () => {
    const mono = fakeClock(0);
    let reads = 0;
    const errors: number[] = [];
    const link: MeshLink = {
      send: () => Promise.resolve({ ok: true }),
      receive: () => {
        reads += 1;
        return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) };
      },
    };
    const worker = meshReceiverWorker({ receiver: meshReceiver({ clock: fakeWallClock(T0, mono) }), link, clock: mono, retryBase: 5_000, retryCap: 5_000, random: () => 0, onError: (_error, failures) => errors.push(failures) });
    await worker.start(new AbortController().signal, detachedLifecycle(mono));
    for (let step = 0; step < 4; step += 1) {
      await mono.advance(1_000);
      await settle();
    }
    expect(reads).toBe(1);
    await mono.advance(5_000);
    await settle();
    expect(reads).toBe(2);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    worker.stopIntake();
    await worker.close();
  });

  it("refuses a time that is not a whole count of milliseconds above 0", () => {
    const options = { receiver: meshReceiver({ clock: fakeWallClock(T0) }), link: simulatedMesh({ clock: fakeWallClock(T0), beatMs: 30_000 }).link, clock: fakeClock(0) };
    expect(() => meshReceiverWorker({ ...options, readMs: 0 })).toThrow("readMs");
    expect(() => meshReceiverWorker({ ...options, retryBase: 10, retryCap: 5 })).toThrow("shorter");
  });
});
