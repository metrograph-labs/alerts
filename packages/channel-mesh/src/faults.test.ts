/**
 * The fault test of the mesh channel. A seeded plan of `@mark1russell7/rigor-chaos` drops, delays, copies and reorders the
 * frames of both directions of the simulated mesh. Each gate runs for each fixed seed. Start one seed with `SEED=<n>`.
 */

import { fakeWallClock, type FakeWallClock } from "@mark1russell7/algebra/clock";
import type { Message, PersonId, ReportId } from "@mark1russell7/alerts";
import { seedsFrom } from "@mark1russell7/rigor-generators";
import { afterEach, describe, expect, it } from "vitest";
import { MESH_FAULT_HOLD_MS, meshFaultPlan, planFilters, type PlanFilters } from "./faults.test-helpers.ts";
import { alarmIdOf, decodeFrame, meshChannel, meshReceiver, runMeshReceiver, type MeshReceiver } from "./index.ts";
import { simulatedMesh, type MeshFilter, type SimulatedMesh } from "./testing.ts";

const SEEDS = seedsFrom(process.env["SEED"], [101, 202, 303, 404, 505, 606, 707, 808]);
const T0 = Date.UTC(2026, 3, 1, 18);
const BEAT = 30_000;
const LIMIT = 3 * BEAT;
/** The longest time from the push of the button to the ack: the longest wait of the backoff, two holds and a margin. */
const ACK_LIMIT_MS = 5 * 60_000;
const KEY = "ab12".repeat(16);
const OTHER = "cd34".repeat(16);
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const message = (key = KEY): Message => ({
  key,
  person: "person-1" as PersonId,
  level: "life-safety",
  title: "Smoke alarm",
  body: "Leave the house.",
  incident: "report-1" as ReportId,
  quiet: false,
});

interface Rig {
  readonly clock: FakeWallClock;
  readonly mesh: SimulatedMesh;
  readonly receiver: MeshReceiver;
  readonly channel: ReturnType<typeof meshChannel>;
  readonly faults: PlanFilters;
  /** The text that a failure shows: the seed, and the faults that the filters applied. */
  readonly why: () => string;
}

const open: Array<() => void> = [];
// The faults that each run applied, for the gate of the cover of the plans.
const seen: PlanFilters["applied"][] = [];

afterEach(() => {
  for (const close of open.splice(0)) close();
});

/** A channel on a simulated mesh with the faults of a seeded plan. A wrap of the down filter sees each text first. */
const rig = (seed: number, wrap?: (text: string, next: (text: string) => void) => void): Rig => {
  const clock = fakeWallClock(T0);
  const faults = planFilters(meshFaultPlan(seed), clock);
  seen.push(faults.applied);
  const down: MeshFilter = wrap === undefined ? faults.down : (text, deliver) => wrap(text, (copy) => faults.down(copy, deliver));
  const mesh = simulatedMesh({ clock, beatMs: BEAT, filters: { up: faults.up, down } });
  const receiver = meshReceiver({ clock });
  const stop = new AbortController();
  void runMeshReceiver(receiver, mesh.link, stop.signal);
  open.push(() => {
    stop.abort();
    mesh.close();
  });
  const channel = meshChannel({ link: mesh.link, receiver, node: "bed-node", beatMs: BEAT, clock, random: () => 0.5 });
  const why = (): string => `seed ${String(seed)} (SEED=${String(seed)}), faults ${JSON.stringify(faults.applied)}`;
  return { clock, mesh, receiver, channel, faults, why };
};

/** This function moves the clock in steps of one second until the test is true, or until the limit. It gives the time. */
const until = async (clock: FakeWallClock, limit: number, test: () => boolean | Promise<boolean>): Promise<number | undefined> => {
  const start = clock.now();
  for (;;) {
    if (await test()) return clock.now() - start;
    if (clock.now() - start >= limit) return undefined;
    await clock.advance(1_000);
    await settle();
  }
};

const acknowledged = async (rig: Rig, receipt: Readonly<Record<string, string>>): Promise<boolean> => (await rig.channel.status({ receipt })).state === "acknowledged";

const sendOk = async (rig: Rig, key = KEY): Promise<Readonly<Record<string, string>>> => {
  const outcome = await rig.channel.send({ message: message(key), address: {} });
  if (!outcome.ok) throw new Error(`The send failed: ${outcome.message}. ${rig.why()}`);
  return outcome.receipt;
};

describe("the mesh channel under the faults of a seeded plan", () => {
  it.each(SEEDS)("is acknowledged after one push of the button, before the limit (seed %i)", async (seed) => {
    const one = rig(seed);
    const receipt = await sendOk(one);
    expect(await until(one.clock, ACK_LIMIT_MS, () => one.mesh.node.siren()), `The siren did not sound. ${one.why()}`).toBeDefined();
    one.mesh.node.press();
    expect(one.mesh.node.siren()).toBe(false);
    const time = await until(one.clock, ACK_LIMIT_MS, () => acknowledged(one, receipt));
    expect(time, `No ack in ${String(ACK_LIMIT_MS)} ms. ${one.why()}`).toBeDefined();
    expect(one.mesh.node.counts().acks, one.why()).toBeGreaterThanOrEqual(1);
  });

  it.each(SEEDS)("counts an ack that comes again once (seed %i)", async (seed) => {
    const one = rig(seed);
    const receipt = await sendOk(one);
    await until(one.clock, ACK_LIMIT_MS, () => one.mesh.node.siren());
    one.mesh.node.press();
    await until(one.clock, ACK_LIMIT_MS, () => acknowledged(one, receipt));
    // The copies of the plan and the acks of the node for each later alarm frame come as duplicates.
    await until(one.clock, 10 * 60_000, () => false);
    const id = receipt["id"] ?? "";
    expect(one.receiver.acksOf(id), one.why()).toHaveLength(1);
    expect(one.receiver.counts().ack, one.why()).toBe(1);
    const status = await one.channel.status({ receipt });
    expect(status, one.why()).toMatchObject({ state: "acknowledged", by: "bed-node" });
  });

  it.each(SEEDS)("gives an old ack that comes late no effect on a new alarm (seed %i)", async (seed) => {
    // The wrap keeps a copy of each ack of the first alarm, to give them again during the second alarm.
    const firstId = alarmIdOf(KEY) ?? "";
    const old: string[] = [];
    let replay: ((text: string) => void) | undefined;
    const one = rig(seed, (text, next) => {
      const read = decodeFrame(text);
      if (read.tag === "ok" && read.value.kind === "ack" && read.value.id === firstId) old.push(text);
      if (replay === undefined) replay = next;
      next(text);
    });
    const first = await sendOk(one);
    await until(one.clock, ACK_LIMIT_MS, () => one.mesh.node.siren());
    one.mesh.node.press();
    expect(await until(one.clock, ACK_LIMIT_MS, () => acknowledged(one, first)), one.why()).toBeDefined();
    await until(one.clock, 2 * 60_000, () => false);
    // The second alarm of the same key has a new id, and the second alarm of another key too.
    const again = await sendOk(one);
    const other = await sendOk(one, OTHER);
    expect(again["id"]).not.toBe(first["id"]);
    expect(old.length, one.why()).toBeGreaterThanOrEqual(1);
    const before = one.receiver.counts();
    for (const text of old) replay?.(text);
    await until(one.clock, MESH_FAULT_HOLD_MS + 5_000, () => false);
    expect((await one.channel.status({ receipt: again })).state, one.why()).not.toBe("acknowledged");
    expect((await one.channel.status({ receipt: other })).state, one.why()).not.toBe("acknowledged");
    expect(one.receiver.acksOf(again["id"] ?? ""), one.why()).toEqual([]);
    // The receiver keeps the acks of the first alarm. Thus an old ack that comes late counts as a duplicate, and it acks nothing.
    const after = one.receiver.counts();
    expect(after.ack, one.why()).toBe(before.ack);
    expect(after.duplicate + after.stray, one.why()).toBeGreaterThan(before.duplicate + before.stray);
  });

  it.each(SEEDS)("fails the probe in the limit after the death of the node, and passes it after a restart (seed %i)", async (seed) => {
    const one = rig(seed);
    // The probe passes while the node lives, after the first beat that comes through.
    expect(await until(one.clock, 10 * BEAT, async () => (await one.channel.probe?.())?.ok === true), one.why()).toBeDefined();
    await until(one.clock, 5 * BEAT, () => false);
    one.mesh.node.kill();
    // A beat that a delay held comes at most MESH_FAULT_HOLD_MS late. Then the age of the last beat passes the limit.
    const down = await until(one.clock, LIMIT + MESH_FAULT_HOLD_MS + 1_000, async () => (await one.channel.probe?.())?.ok === false);
    expect(down, `The probe passed after the death of the node. ${one.why()}`).toBeDefined();
    const failed = await one.channel.probe?.();
    expect(failed, one.why()).toMatchObject({ ok: false, kind: "network", message: expect.stringContaining("no heartbeat of the bed node") as string });
    one.mesh.node.revive();
    const up = await until(one.clock, 10 * BEAT, async () => (await one.channel.probe?.())?.ok === true);
    expect(up, `The probe did not pass after the restart of the node. ${one.why()}`).toBeDefined();
  });

  it.each(SEEDS)("stops the siren at a cancel (seed %i)", async (seed) => {
    const one = rig(seed);
    const receipt = await sendOk(one);
    expect(await until(one.clock, ACK_LIMIT_MS, () => one.mesh.node.siren()), one.why()).toBeDefined();
    await one.channel.cancel({ receipt });
    const time = await until(one.clock, 2 * 60_000, () => !one.mesh.node.siren());
    expect(time, `The siren sounds after the cancel. ${one.why()}`).toBeDefined();
    // A late alarm frame of the plan does not start the siren again.
    await until(one.clock, 5 * 60_000, () => false);
    expect(one.mesh.node.siren(), one.why()).toBe(false);
  });

  it("applies each kind of fault in each direction in the runs of the gates", () => {
    if (process.env["SEED"] !== undefined) return;
    const cover = new Set(seen.flat().map((fault) => `${fault.direction}:${fault.kind}`));
    for (const direction of ["up", "down"]) {
      for (const kind of ["cut", "delay", "duplicate", "reorder"]) expect(cover.has(`${direction}:${kind}`), `${direction}:${kind} in ${[...cover].join(", ")}`).toBe(true);
    }
  });
});
