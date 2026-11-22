import { join } from "node:path";
import type { WebhookFetch } from "@mark1russell7/alerts-channel-webhook";
import { superviseGroup } from "@mark1russell7/service/host";
import { fakeHost } from "@mark1russell7/service/testing";
import { describe, expect, it } from "vitest";
import { hostGroup, RUNTIME_PROGRAM } from "./host.ts";
import { WEBHOOK_SECRET_KEY } from "./instance.ts";
import {
  LOOP_RETRY,
  LOOP_START,
  LOOP_WINDOW,
  LAST_LIMIT,
  loopEvent,
  loopNotifier,
  loopReceiver,
  loopStep,
  READY_EVENT,
  RESTARTS_EVENT,
  SUPERVISOR_WEBHOOK_KEY,
  supervisorEntry,
  type LoopInput,
  type LoopNotifier,
  type LoopState,
  type LoopReceiver,
} from "./loop-notice.ts";

// Fake secrets: fixed bytes. No real secret is in this repository.
const SECRET = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const URL_OF = "https://hooks.example.test/supervisor";
const AT = Date.UTC(2026, 10, 22, 20, 0);
const MINUTE = 60_000;
const OPTIONS = { home: join("/var/lib", "alerts"), root: join("/srv/alerts", "packages", "runtime"), node: "/usr/bin/node" };

const stop = (at: number, last = "it exited with the code 1"): LoopInput => ({ kind: "stop", at, last });
const run = (inputs: readonly LoopInput[], state: LoopState = LOOP_START) => inputs.reduce<{ state: LoopState; tells: string[] }>(
  (acc, input) => {
    const outcome = loopStep(acc.state, input);
    return { state: outcome.state, tells: outcome.tell === undefined ? acc.tells : [...acc.tells, `${outcome.tell.kind}:${String(outcome.tell.loop.stops)}`] };
  },
  { state, tells: [] },
);

/** One request that the fake receiver got. */
interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** A fake receiver: it records each request and gives the next status. After the last status, it gives 204. */
const receiver = (...statuses: number[]) => {
  const calls: Call[] = [];
  const fetch: WebhookFetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body ?? "" });
    const status = statuses.shift() ?? 204;
    return { status, text: async () => "", headers: { get: () => null } };
  };
  return { fetch, calls };
};

const RECEIVER = (): LoopReceiver => {
  const read = loopReceiver((name) => ({ [SUPERVISOR_WEBHOOK_KEY]: URL_OF, [WEBHOOK_SECRET_KEY]: SECRET })[name]);
  if (read.tag === "err" || read.value === undefined) throw new Error("The fake receiver has no keys.");
  return read.value;
};

describe("loopStep", () => {
  it("starts a loop at the third stop in the window, and counts a stop only in the window", () => {
    expect(run([stop(0), stop(MINUTE)]).tells).toEqual([]);
    expect(run([stop(0), stop(MINUTE), stop(2 * MINUTE)]).tells).toEqual(["start:3"]);
    // The first stop is out of the window at the third stop.
    expect(run([stop(0), stop(10 * MINUTE), stop(20 * MINUTE)]).tells).toEqual([]);
    const loop = run([stop(0), stop(MINUTE), stop(2 * MINUTE)]).state.loop;
    expect(loop).toEqual({ since: 0, stops: 3, last: "it exited with the code 1" });
  });

  it("counts each later stop in the loop, and gives one start for one loop", () => {
    const { state, tells } = run([stop(0), stop(MINUTE), stop(2 * MINUTE), stop(3 * MINUTE, "it ended with the signal SIGKILL"), stop(4 * MINUTE)]);
    expect(tells).toEqual(["start:3"]);
    expect(state.loop).toMatchObject({ stops: 5, last: "it exited with the code 1" });
  });

  it("counts a stop after a ready start, because a crash after each ready start is a loop too", () => {
    expect(run([stop(0), { kind: "ready", at: MINUTE }, stop(2 * MINUTE), { kind: "ready", at: 3 * MINUTE }, stop(4 * MINUTE)]).tells).toEqual(["start:3"]);
  });

  it("arms the steady check at a ready start in a loop, and ends the loop after one steady window", () => {
    const { state } = run([stop(0), stop(MINUTE), stop(2 * MINUTE)]);
    const ready = loopStep(state, { kind: "ready", at: 3 * MINUTE });
    expect(ready.check).toBe(3 * MINUTE + LOOP_WINDOW);
    const end = loopStep(ready.state, { kind: "steady", at: 3 * MINUTE + LOOP_WINDOW });
    expect(end.tell).toEqual({ kind: "end", loop: { since: 0, stops: 3, last: "it exited with the code 1" } });
    expect(end.state).toEqual(LOOP_START);
  });

  it("stops the steady check at a stop, and a late check after a stop ends no loop", () => {
    const { state } = run([stop(0), stop(MINUTE), stop(2 * MINUTE), { kind: "ready", at: 3 * MINUTE }]);
    const again = loopStep(state, stop(10 * MINUTE));
    expect(again.check).toBeNull();
    expect(loopStep(again.state, { kind: "steady", at: 18 * MINUTE }).tell).toBeUndefined();
    expect(loopStep(again.state, { kind: "steady", at: 10 * MINUTE + LOOP_WINDOW }).tell?.kind).toBe("end");
  });

  it("arms no check at a ready start with no loop", () => {
    expect(loopStep(LOOP_START, { kind: "ready", at: 0 })).toEqual({ state: LOOP_START });
  });
});

describe("supervisorEntry", () => {
  const end = { program: RUNTIME_PROGRAM, pid: 4, code: 1, signal: null };

  it("reads the end and the ready start of the runtime only", () => {
    expect(supervisorEntry("warn", "runtime stopped: it exited with the code 1", end, 5)).toEqual({ kind: "stop", at: 5, last: "it exited with the code 1" });
    const missed = "runtime stopped: it was not ready in 1000 ms (503), then it exited with the signal SIGTERM";
    expect(supervisorEntry("warn", missed, { ...end, code: null, signal: "SIGTERM" }, 5)).toMatchObject({ last: "it was not ready in 1000 ms (503), then it exited with the signal SIGTERM" });
    expect(supervisorEntry("info", `${RUNTIME_PROGRAM} is ready`, { program: RUNTIME_PROGRAM, pid: 4 }, 5)).toEqual({ kind: "ready", at: 5 });
    expect(supervisorEntry("warn", "runtime does not start: the process 9 holds the lock", { program: RUNTIME_PROGRAM, lock: "x" }, 5)).toBeUndefined();
    expect(supervisorEntry("warn", "other stopped: x", { program: "other", code: 1, signal: null }, 5)).toBeUndefined();
    expect(supervisorEntry("warn", "runtime is not ready in its time, thus it stops", { program: RUNTIME_PROGRAM, pid: 4 }, 5)).toBeUndefined();
    expect(supervisorEntry("info", `${RUNTIME_PROGRAM} started`, { program: RUNTIME_PROGRAM, pid: 4 }, 5)).toBeUndefined();
  });

  it("gives one line of the limit or fewer", () => {
    const entry = supervisorEntry("warn", `runtime stopped: one\ntwo\u0007${"x".repeat(400)}`, end, 5);
    expect(entry?.kind === "stop" && entry.last.startsWith("one two x")).toBe(true);
    expect(entry?.kind === "stop" && entry.last.length).toBe(LAST_LIMIT);
  });
});

describe("loopEvent", () => {
  it("gives one id for one loop and type, and other ids for another loop, copy or type", () => {
    const tell = { kind: "start" as const, loop: { since: 0, stops: 3, last: "it exited with the code 1" } };
    const event = loopEvent(tell, "home", AT);
    expect(event).toEqual({ type: RESTARTS_EVENT, id: loopEvent(tell, "home", AT).id, data: { copy: "home", stops: 3, windowMs: LOOP_WINDOW, last: "it exited with the code 1", since: new Date(AT).toISOString() } });
    expect(event.id).toMatch(/^[0-9a-f]{32}$/u);
    expect(loopEvent(tell, "home", AT + 1).id).not.toBe(event.id);
    expect(loopEvent(tell, "cloud", AT).id).not.toBe(event.id);
    const end = loopEvent({ ...tell, kind: "end" }, "home", AT);
    expect(end.type).toBe(READY_EVENT);
    expect(end.id).not.toBe(event.id);
    expect(Object.keys(end.data)).toEqual(["copy", "stops", "since"]);
  });
});

describe("loopReceiver", () => {
  const keys = (values: Record<string, string>) => (name: string) => values[name];

  it("gives no receiver with no key, and a receiver with the URL and the secret", () => {
    expect(loopReceiver(keys({}))).toEqual({ tag: "ok", value: undefined });
    expect(loopReceiver(keys({ [SUPERVISOR_WEBHOOK_KEY]: "  " }))).toEqual({ tag: "ok", value: undefined });
    const read = loopReceiver(keys({ [SUPERVISOR_WEBHOOK_KEY]: URL_OF, [WEBHOOK_SECRET_KEY]: SECRET }));
    expect(read.tag === "ok" && read.value?.url).toBe(URL_OF);
    expect(read.tag === "ok" && read.value?.secrets).toHaveLength(1);
    expect(loopReceiver(keys({ [SUPERVISOR_WEBHOOK_KEY]: "http://127.0.0.1:4000/hooks", [WEBHOOK_SECRET_KEY]: SECRET })).tag).toBe("ok");
  });

  it("gives a problem that names the key and holds no value", () => {
    const plain = loopReceiver(keys({ [SUPERVISOR_WEBHOOK_KEY]: "http://hooks.example.test/x", [WEBHOOK_SECRET_KEY]: SECRET }));
    expect(plain.tag === "err" && plain.error.join(" ")).toContain(SUPERVISOR_WEBHOOK_KEY);
    expect(plain.tag === "err" && plain.error.join(" ")).not.toContain("hooks.example.test");
    const unsigned = loopReceiver(keys({ [SUPERVISOR_WEBHOOK_KEY]: URL_OF }));
    expect(unsigned.tag === "err" && unsigned.error.join(" ")).toContain(WEBHOOK_SECRET_KEY);
    const bad = loopReceiver(keys({ [SUPERVISOR_WEBHOOK_KEY]: URL_OF, [WEBHOOK_SECRET_KEY]: "whsec_not-a-secret-value" }));
    expect(bad.tag).toBe("err");
    expect(bad.tag === "err" && bad.error.join(" ")).not.toContain("not-a-secret-value");
  });
});

describe("loopNotifier", () => {
  it("sends one runtime.restarts when the group stops the runtime three times, with the cause of each stop", async () => {
    // The runtime never answers its readiness probe. The supervisor stops each start at its window.
    const { fetch, calls } = receiver();
    const warnings: string[] = [];
    // The fake host takes its logger before the notifier has the clock of the host.
    let hook: LoopNotifier["log"] | undefined;
    const host = fakeHost({ platform: "win32", logger: { log: (level, message, fields) => hook?.(level, message, fields) } });
    host.polite = true;
    const notifier = loopNotifier({ copy: "home", receiver: RECEIVER(), fetch, userAgent: "alerts-runtime-test", clock: host.clock, wall: () => AT, warn: (text) => warnings.push(text) });
    hook = notifier.log;
    const group = superviseGroup(hostGroup({ ...OPTIONS, readyWithin: { value: 1000, unit: "ms" } }), host.ports, { random: () => 0 });
    group.start();
    await host.settle();
    for (let steps = 0; steps < 4000 && calls.length < 1; steps += 1) {
      await host.clock.advance(100);
      await host.settle();
    }
    // More stops of the same loop send nothing more.
    for (let steps = 0; steps < 600; steps += 1) {
      await host.clock.advance(100);
      await host.settle();
    }
    await group.stop();
    notifier.stop();
    expect(warnings).toEqual([]);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(URL_OF);
    expect(call.headers).toMatchObject({ "user-agent": "alerts-runtime-test", "webhook-timestamp": String(AT / 1000) });
    expect(call.headers["webhook-signature"]).toMatch(/^v1,/u);
    const body = JSON.parse(call.body) as { type: string; data: Record<string, unknown> };
    expect(body.type).toBe(RESTARTS_EVENT);
    expect(body.data).toMatchObject({ copy: "home", stops: 3, windowMs: LOOP_WINDOW, since: new Date(AT).toISOString() });
    expect(String(body.data["last"])).toMatch(/^it was not ready in [0-9]+ ms .*, then it exited with /u);
    expect(call.headers["webhook-id"]).toBe(loopEvent({ kind: "start", loop: { since: 0, stops: 3, last: "" } }, "home", AT).id);
  });

  it("sends a failed notice again after the retry wait with the same id, then the end of the loop", async () => {
    const { fetch, calls } = receiver(500);
    const warnings: string[] = [];
    const host = fakeHost({ platform: "win32" });
    const notifier = loopNotifier({ copy: "cloud", receiver: RECEIVER(), fetch, userAgent: "alerts-runtime-test", clock: host.clock, wall: () => AT, warn: (text) => warnings.push(text) });
    const end = { program: RUNTIME_PROGRAM, pid: 4, code: 1, signal: null };
    for (let index = 0; index < 3; index += 1) {
      notifier.log("warn", "runtime stopped: it exited with the code 1", end);
      await host.clock.advance(MINUTE);
      await host.settle();
    }
    expect(calls).toHaveLength(1);
    expect(warnings).toEqual([`The notice ${RESTARTS_EVENT} of the supervisor was not sent (server). It goes again in ${String(LOOP_RETRY / 1000)} s.`]);
    await host.clock.advance(LOOP_RETRY);
    await host.settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers["webhook-id"]).toBe(calls[0]!.headers["webhook-id"]);
    // The runtime is ready, and it stays steady for one window: the loop ends.
    notifier.log("info", `${RUNTIME_PROGRAM} is ready`, { program: RUNTIME_PROGRAM, pid: 5 });
    await host.clock.advance(LOOP_WINDOW - MINUTE);
    await host.settle();
    expect(calls).toHaveLength(2);
    await host.clock.advance(MINUTE);
    await host.settle();
    expect(calls).toHaveLength(3);
    expect(JSON.parse(calls[2]!.body)).toMatchObject({ type: READY_EVENT, data: { copy: "cloud", stops: 3 } });
    notifier.stop();
  });

  it("sends nothing after its stop, and its stop ends the retry timer", async () => {
    const { fetch, calls } = receiver(500, 500);
    const host = fakeHost({ platform: "win32" });
    const notifier = loopNotifier({ copy: "home", receiver: RECEIVER(), fetch, userAgent: "alerts-runtime-test", clock: host.clock, wall: () => AT, warn: () => undefined });
    for (let index = 0; index < 3; index += 1) notifier.log("warn", "runtime stopped: it exited with the code 1", { program: RUNTIME_PROGRAM, pid: 4, code: 1, signal: null });
    await host.settle();
    expect(calls).toHaveLength(1);
    notifier.stop();
    await host.clock.advance(10 * LOOP_RETRY);
    await host.settle();
    notifier.log("warn", "runtime stopped: it exited with the code 1", { program: RUNTIME_PROGRAM, pid: 4, code: 1, signal: null });
    expect(calls).toHaveLength(1);
  });
});
