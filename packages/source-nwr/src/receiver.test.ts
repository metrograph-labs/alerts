import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { fakeWallClock, wallClock } from "@mark1russell7/algebra/clock";
import type { Backoff } from "@mark1russell7/service/backoff";
import { createLineFeed } from "./feed.ts";
import { createNwrSource } from "./index.ts";
import {
  checkHost,
  chooseRestart,
  createLineSplitter,
  createReceiver,
  DECODER,
  DECODER_SAMPLE_RATE,
  decoderArgs,
  NWR_FREQUENCIES,
  startProgram,
  TUNER,
  tunerArgs,
  type ReceiverChild,
  type StartProgram,
} from "./receiver.ts";

const AT = Date.parse("2026-11-25T17:00:30Z");
// A made-up header in the form of 47 CFR 11.31. The sender is a made-up station.
const WEEKLY = "ZCZC-WXR-RWT-029095-029037+0015-3291700-KXYZ/NWS-";
const NO_JITTER: Backoff = { base: 1_000, factor: 2, cap: 8_000, jitter: { kind: "none" } };

/** A fake process: three streams, and an exit at a stop. */
class FakeChild extends EventEmitter implements ReceiverChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  readonly command: string;
  readonly args: readonly string[];
  exited = false;
  constructor(command: string, args: readonly string[]) {
    super();
    this.command = command;
    this.args = args;
  }
  kill(signal?: NodeJS.Signals): boolean {
    if (this.exited) return false;
    this.signals.push(signal ?? "SIGTERM");
    queueMicrotask(() => this.exit(null, signal ?? "SIGTERM"));
    return true;
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, signal);
  }
}

/** This function gives a fake start of the programs and the list of each process that it started. */
function fakeStart(): { start: StartProgram; children: FakeChild[] } {
  const children: FakeChild[] = [];
  return {
    children,
    start: (command, args) => {
      const child = new FakeChild(command, args);
      children.push(child);
      return child;
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("tunerArgs and decoderArgs", () => {
  it("tunes rtl_fm to a channel, with raw samples that multimon-ng reads", () => {
    expect(tunerArgs({ frequency: 162_550_000 })).toEqual(["-f", "162550000", "-M", "fm", "-s", "22050", "-E", "dc", "-p", "0", "-"]);
    expect(tunerArgs({ frequency: 162_400_000, ppm: -3, gain: 42.1, device: 1 })).toEqual(["-f", "162400000", "-M", "fm", "-s", "22050", "-E", "dc", "-p", "-3", "-g", "42.1", "-d", "1", "-"]);
    expect(decoderArgs()).toEqual(["-t", "raw", "-a", "EAS", "-v", "1", "-"]);
    expect(DECODER_SAMPLE_RATE).toBe(22_050);
  });

  it("knows the seven channels, and refuses another frequency or a wrong setting", () => {
    expect(NWR_FREQUENCIES.map((hz) => hz / 1e6)).toEqual([162.4, 162.425, 162.45, 162.475, 162.5, 162.525, 162.55]);
    expect(() => tunerArgs({ frequency: 162_560_000 })).toThrow(RangeError);
    expect(() => tunerArgs({ frequency: 162.55 })).toThrow(/not a channel/);
    expect(() => tunerArgs({ frequency: 162_550_000, ppm: 0.5 })).toThrow(RangeError);
    expect(() => tunerArgs({ frequency: 162_550_000, gain: -1 })).toThrow(RangeError);
    expect(() => tunerArgs({ frequency: 162_550_000, device: -1 })).toThrow(RangeError);
  });
});

describe("createLineSplitter", () => {
  it("keeps a partial last line until its end comes", () => {
    const splitter = createLineSplitter();
    expect(splitter.push("EAS: ZCZC-WXR")).toEqual([]);
    expect(splitter.push("-RWT-\r\nEAS (part): NN")).toEqual(["EAS: ZCZC-WXR-RWT-"]);
    expect(splitter.push("NN\n\n")).toEqual(["EAS (part): NNNN", ""]);
    expect(splitter.push("tail")).toEqual([]);
    expect(splitter.flush()).toEqual(["tail"]);
    expect(splitter.flush()).toEqual([]);
  });

  it("joins a CR LF and a UTF-8 character that a chunk cuts", () => {
    const splitter = createLineSplitter();
    const bytes = new TextEncoder().encode("aéb\r\nc\n");
    expect(splitter.push(bytes.subarray(0, 2))).toEqual([]);
    expect(splitter.push(bytes.subarray(2, 5))).toEqual([]);
    expect(splitter.push(bytes.subarray(5))).toEqual(["aéb", "c"]);
  });

  it("gives a long part with no line end as one line", () => {
    const splitter = createLineSplitter(4);
    expect(splitter.push("abcdef")).toEqual(["abcdef"]);
    expect(splitter.push("g\n")).toEqual(["g"]);
  });

  it("gives the same lines for each cut of the stream", () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[A-Z: -]{0,12}$/), { maxLength: 6 }), fc.array(fc.nat(), { maxLength: 8 }), (lines, cuts) => {
        const text = lines.map((line) => `${line}\n`).join("");
        const points = [...new Set(cuts.map((cut) => cut % (text.length + 1)))].sort((a, b) => a - b);
        const splitter = createLineSplitter();
        const out: string[] = [];
        let from = 0;
        for (const point of [...points, text.length]) {
          out.push(...splitter.push(text.slice(from, point)));
          from = point;
        }
        out.push(...splitter.flush());
        expect(out).toEqual(lines);
      }),
    );
  });
});

describe("chooseRestart", () => {
  it("doubles the delay after each stop in a row, to the cap", () => {
    const delays: number[] = [];
    let failures = 0;
    for (let i = 0; i < 6; i += 1) {
      const choice = chooseRestart({ failures, ran: 1_000, steadyAfter: 60_000, backoff: NO_JITTER, random: () => 0.5 });
      failures = choice.failures;
      delays.push(choice.delay);
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
    expect(failures).toBe(6);
  });

  it("starts again from the first step after a steady run", () => {
    expect(chooseRestart({ failures: 5, ran: 60_000, steadyAfter: 60_000, backoff: NO_JITTER, random: () => 0 })).toEqual({ failures: 1, delay: 1_000 });
  });

  it("keeps the jitter in the band of the policy", () => {
    const backoff: Backoff = { base: 1_000, factor: 2, cap: 8_000, jitter: { kind: "subtract", fraction: 0.5 } };
    fc.assert(
      fc.property(fc.nat({ max: 20 }), fc.double({ min: 0, max: 0.999, noNaN: true }), (failures, r) => {
        const choice = chooseRestart({ failures, ran: 0, steadyAfter: 60_000, backoff, random: () => r });
        expect(choice.delay).toBeGreaterThanOrEqual(Math.min(8_000, 1_000 * 2 ** failures) / 2);
        expect(choice.delay).toBeLessThanOrEqual(8_000);
      }),
    );
  });
});

describe("checkHost", () => {
  it("finds both programs", async () => {
    const check = await checkHost((name) => Promise.resolve(`/usr/bin/${name}`));
    expect(check).toEqual({
      ready: true,
      programs: [
        { name: TUNER, found: true, path: "/usr/bin/rtl_fm" },
        { name: DECODER, found: true, path: "/usr/bin/multimon-ng" },
      ],
      missing: [],
    });
  });

  it("names a missing program, and a search that fails, with no throw", async () => {
    expect(await checkHost((name) => Promise.resolve(name === TUNER ? "/usr/bin/rtl_fm" : undefined))).toMatchObject({ ready: false, missing: [DECODER] });
    expect(await checkHost(() => Promise.reject(new Error("no PATH")))).toEqual({
      ready: false,
      programs: [
        { name: TUNER, found: false },
        { name: DECODER, found: false },
      ],
      missing: [TUNER, DECODER],
    });
  });
});

describe("createReceiver", () => {
  it("starts the two programs, joins them and sends each line of the decoder to the feed", async () => {
    const clock = fakeWallClock(AT);
    const feed = createLineFeed(100);
    const { start, children } = fakeStart();
    const logs: string[] = [];
    const receiver = createReceiver({ feed, clock, start, tuner: { frequency: 162_550_000 }, onLog: (log) => logs.push(`${log.program}: ${log.line}`) });
    expect(children).toEqual([]);
    expect(receiver.state()).toEqual({ status: "idle", failures: 0 });
    receiver.start();
    receiver.start();
    const [tuner, decoder] = children as [FakeChild, FakeChild];
    expect(children.map((child) => [child.command, child.args])).toEqual([
      [TUNER, tunerArgs({ frequency: 162_550_000 })],
      [DECODER, decoderArgs()],
    ]);
    expect(feed.started()).toBe(AT);
    expect(receiver.state()).toEqual({ status: "running", failures: 0, since: AT });

    const samples: Buffer[] = [];
    decoder.stdin.on("data", (chunk: Buffer) => samples.push(chunk));
    tuner.stdout.write(Buffer.from([1, 2, 3, 4]));
    tuner.stderr.write("Tuned to 162550000 Hz.\n");
    decoder.stdout.write(`EAS (part): ${WEEKLY}\nEAS: ${WEEKLY.slice(0, 10)}`);
    await tick();
    await clock.advance(1_000);
    decoder.stdout.write(`${WEEKLY.slice(10)}\nEAS: NNNN\n`);
    await tick();
    expect(Buffer.concat(samples)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(logs).toEqual(["rtl_fm: Tuned to 162550000 Hz."]);
    expect(feed.read(0).lines.map((line) => [line.text, line.at])).toEqual([
      [`EAS (part): ${WEEKLY}`, AT],
      [`EAS: ${WEEKLY}`, AT + 1_000],
      ["EAS: NNNN", AT + 1_000],
    ]);
    await receiver.close();
    expect(tuner.signals).toEqual(["SIGTERM"]);
    expect(decoder.signals).toEqual(["SIGTERM"]);
    expect(feed.started()).toBeUndefined();
    expect(receiver.state().status).toBe("closed");
  });

  it("stops the tuner and the feed when the decoder stops, and starts again after the backoff", async () => {
    const clock = fakeWallClock(AT);
    const feed = createLineFeed(100);
    const { start, children } = fakeStart();
    const receiver = createReceiver({ feed, clock, start, tuner: { frequency: 162_400_000 }, backoff: NO_JITTER });
    receiver.start();
    await clock.advance(5_000);
    const [tuner, decoder] = children as [FakeChild, FakeChild];
    decoder.stderr.write("multimon-ng: input ended\n");
    await tick();
    decoder.exit(1);
    await tick();
    expect(tuner.signals).toEqual(["SIGTERM"]);
    expect(feed.started()).toBeUndefined();
    expect(receiver.state()).toEqual({ status: "waiting", failures: 1, ended: { reason: "multimon-ng stopped with the code 1: multimon-ng: input ended", at: AT + 5_000 } });
    await clock.advance(999);
    expect(children).toHaveLength(2);
    await clock.advance(1);
    expect(children).toHaveLength(4);
    expect(feed.started()).toBe(AT + 6_000);
    expect(receiver.state()).toMatchObject({ status: "running", failures: 1, since: AT + 6_000 });

    // The second stop in a row waits twice as long.
    (children[3] as FakeChild).exit(0);
    await tick();
    expect(receiver.state()).toMatchObject({ status: "waiting", failures: 2 });
    await clock.advance(1_999);
    expect(children).toHaveLength(4);
    await clock.advance(1);
    expect(children).toHaveLength(6);
    await receiver.close();
    expect(clock.pending).toBe(0);
  });

  it("gives the decoder the drain time after the end of the tuner", async () => {
    const clock = fakeWallClock(AT);
    const feed = createLineFeed(100);
    const { start, children } = fakeStart();
    const receiver = createReceiver({ feed, clock, start, tuner: { frequency: 162_475_000 }, backoff: NO_JITTER, drainAfter: 3_000 });
    receiver.start();
    const [tuner, decoder] = children as [FakeChild, FakeChild];
    tuner.stdout.end();
    tuner.exit(null, "SIGPIPE");
    await tick();
    // The decoder reads the rest of its input. The run goes on until the decoder stops.
    expect(receiver.state().status).toBe("running");
    decoder.stdout.write(`EAS: ${WEEKLY}\n`);
    await tick();
    await clock.advance(2_999);
    expect(decoder.signals).toEqual([]);
    await clock.advance(1);
    await tick();
    expect(decoder.signals).toEqual(["SIGTERM"]);
    expect(receiver.state()).toMatchObject({ status: "waiting", failures: 1, ended: { reason: "rtl_fm stopped at the signal SIGPIPE" } });
    expect(feed.read(0).lines.map((line) => line.text)).toEqual([`EAS: ${WEEKLY}`]);
    await receiver.close();
  });

  it("starts again after a program that does not start", async () => {
    const clock = fakeWallClock(AT);
    const feed = createLineFeed(100);
    const { start, children } = fakeStart();
    const receiver = createReceiver({ feed, clock, start, tuner: { frequency: 162_500_000 }, backoff: NO_JITTER });
    receiver.start();
    const [tuner, decoder] = children as [FakeChild, FakeChild];
    decoder.emit("error", new Error("spawn multimon-ng ENOENT"));
    await tick();
    expect(tuner.signals).toEqual(["SIGTERM"]);
    expect(receiver.state()).toMatchObject({ status: "waiting", failures: 1, ended: { reason: "multimon-ng did not start or failed: spawn multimon-ng ENOENT" } });
    await clock.advance(1_000);
    expect(children).toHaveLength(4);
    await receiver.close();

    let calls = 0;
    const throwing = createReceiver({
      feed,
      clock,
      backoff: NO_JITTER,
      tuner: { frequency: 162_500_000 },
      start: () => {
        calls += 1;
        throw new Error("no such program");
      },
    });
    throwing.start();
    expect(throwing.state()).toMatchObject({ status: "waiting", failures: 1, ended: { reason: "a program did not start: no such program" } });
    await clock.advance(1_000);
    expect(calls).toBe(2);
    await throwing.close();
    expect(clock.pending).toBe(0);
  });

  it("refuses a wrong channel at once", () => {
    expect(() => createReceiver({ feed: createLineFeed(1), tuner: { frequency: 100_000_000 }, start: fakeStart().start })).toThrow(RangeError);
  });

  it("gives the observation of a header that the decoder heard to the source", async () => {
    const clock = fakeWallClock(AT);
    const feed = createLineFeed(100);
    const { start, children } = fakeStart();
    const receiver = createReceiver({ feed, clock, start, tuner: { frequency: 162_550_000 } });
    const source = createNwrSource({ feed, clock, coverage: [{ system: "same", code: "029095" }] });
    receiver.start();
    const decoder = children[1] as FakeChild;
    for (const line of [`EAS (part): ${WEEKLY}`, `EAS (part): ${WEEKLY}`, `EAS: ${WEEKLY}`, `EAS (part): ${WEEKLY}`, "EAS: NNNN"]) {
      decoder.stdout.write(`${line}\n`);
      await tick();
      await clock.advance(1_000);
    }
    const outcome = await source.fetch({ watch: { places: [] } });
    expect(outcome.ok ? [...new Set(outcome.observations.map((observation) => observation.body))] : []).toEqual([WEEKLY]);
    expect(source.check?.({ observations: outcome.ok ? outcome.observations : [] })).toMatchObject({ pass: true });
    await receiver.close();
  });

  it("joins two real processes with a pipe, with no shell", async () => {
    // Two Node.js scripts take the place of the programs: the tuner writes bytes, and the decoder writes a line with their count.
    const tunerScript = "process.stdout.write(Buffer.alloc(100000, 1)); process.stderr.write('tuned\\n');";
    const decoderScript = "let n = 0; process.stdin.on('data', (c) => { n += c.length; }); process.stdin.on('end', () => { process.stdout.write('EAS: NNNN\\nbytes ' + n + '\\n'); });";
    const feed = createLineFeed(100);
    const logs: string[] = [];
    let closed: Promise<void> | undefined;
    const done = new Promise<void>((resolve) => {
      const receiver = createReceiver({
        feed,
        clock: wallClock({ unref: true }),
        backoff: { base: 60_000 },
        tuner: { frequency: 162_550_000 },
        onLog: (log) => logs.push(`${log.program}: ${log.line}`),
        start: (command) => {
          const child = startProgram(process.execPath, ["-e", command === TUNER ? tunerScript : decoderScript]);
          if (command === DECODER) {
            child.on("exit", () => {
              setTimeout(() => {
                closed = receiver.close();
                resolve();
              }, 200);
            });
          }
          return child;
        },
      });
      receiver.start();
    });
    await done;
    await closed;
    expect(feed.read(0).lines.map((line) => line.text)).toEqual(["EAS: NNNN", "bytes 100000"]);
    expect(logs).toEqual(["rtl_fm: tuned"]);
  }, 20_000);
});
