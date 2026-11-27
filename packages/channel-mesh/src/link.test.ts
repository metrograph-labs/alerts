import { describe, expect, it } from "vitest";
import { commandLink, commandLinkProblems, LINK_SEND_LIMIT_MS, type LineReader, type LinkCommandOutput, type LinkRunner } from "./link.ts";
import { encodeFrame } from "./protocol.ts";

const SEND = ["mesh-send", "--channel", "1"];
const LISTEN = ["mesh-listen"];

const runner = (output: LinkCommandOutput | Error) => {
  const calls: { argv: readonly string[]; limit: number }[] = [];
  const run: LinkRunner = (argv, _signal, limit) => {
    calls.push({ argv, limit });
    return output instanceof Error ? Promise.reject(output) : Promise.resolve(output);
  };
  return { run, calls };
};

const reader = (lines: readonly string[]) => {
  const calls: (readonly string[])[] = [];
  const read: LineReader = async function* (argv) {
    calls.push(argv);
    yield* lines;
  };
  return { read, calls };
};

const collect = async (texts: AsyncIterable<string>): Promise<string[]> => {
  const all: string[] = [];
  for await (const text of texts) all.push(text);
  return all;
};

describe("commandLink", () => {
  const alarm = encodeFrame({ v: 1, kind: "alarm", id: "a1", level: "urgent", seq: 0 });

  it("gives the frame to the program send as one last argument, with the default time limit", async () => {
    const { run, calls } = runner({ exitCode: 0 });
    const link = commandLink({ send: SEND, listen: LISTEN, run, read: reader([]).read });
    expect(await link.send(alarm, new AbortController().signal)).toEqual({ ok: true });
    expect(calls).toEqual([{ argv: [...SEND, alarm], limit: LINK_SEND_LIMIT_MS }]);
  });

  it("fails a send on an exit code, a time limit, a program that does not start and a throw, and names no program", async () => {
    const outcomes = await Promise.all(
      [{ exitCode: 3 }, { exitCode: 1, timedOut: true }, { exitCode: 1, notStarted: true }, new Error("spawn mesh-send ENOENT")].map((output) =>
        commandLink({ send: SEND, listen: LISTEN, run: runner(output).run, read: reader([]).read }).send(alarm, new AbortController().signal),
      ),
    );
    expect(outcomes.map((outcome) => outcome.ok)).toEqual([false, false, false, false]);
    for (const outcome of outcomes) if (!outcome.ok) expect(outcome.message).not.toMatch(/mesh-send|ENOENT/u);
    expect(outcomes[0]).toEqual({ ok: false, message: "The program send of the mesh link exited with the code 3." });
  });

  it("gives each line of the program listen with no end \\r and no empty line", async () => {
    const beat = encodeFrame({ v: 1, kind: "beat", node: "bed-node", seq: 1, at: 5 });
    const { read, calls } = reader([`${beat}\r`, "", "\r", beat]);
    const link = commandLink({ send: SEND, listen: LISTEN, run: runner({ exitCode: 0 }).run, read, sendLimitMs: 2_000 });
    expect(await collect(link.receive(new AbortController().signal))).toEqual([beat, beat]);
    expect(calls).toEqual([LISTEN]);
  });

  it("refuses an empty program, an empty argument and a bad time limit", () => {
    expect(commandLinkProblems({ send: SEND, listen: LISTEN })).toEqual([]);
    expect(commandLinkProblems({ send: [], listen: ["x", ""], sendLimitMs: 0 })).toEqual([
      "The program send of the mesh link names no program.",
      "The program listen of the mesh link has an empty argument.",
      "The time limit of the program send of the mesh link is not a whole count of milliseconds above 0.",
    ]);
    expect(() => commandLink({ send: [], listen: LISTEN, run: runner({ exitCode: 0 }).run, read: reader([]).read })).toThrow(RangeError);
  });
});
