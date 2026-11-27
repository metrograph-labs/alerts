import { LEVELS } from "@mark1russell7/alerts";
import { seedsFrom } from "@mark1russell7/rigor-generators";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame, frameBytes, frameProblems, MESH_BELL, MESH_FRAME_BYTES, MESH_SEQ_MAX, type MeshFrame } from "./protocol.ts";

const SEEDS = seedsFrom(process.env["SEED"], [11, 12, 13]);
const INSTANT_MAX = 8.64e15;

const idChars = fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-".split(""));
const nodeChars = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-".split(""));
const nodeHead = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split(""));
const id = fc.string({ unit: idChars, minLength: 1, maxLength: 64 });
const node = fc.tuple(nodeHead, fc.string({ unit: nodeChars, maxLength: 31 })).map(([head, tail]) => head + tail);
const seq = fc.integer({ min: 0, max: MESH_SEQ_MAX });
const instant = fc.integer({ min: 0, max: INSTANT_MAX });

const frame: fc.Arbitrary<MeshFrame> = fc.oneof(
  fc.record({ v: fc.constant(1 as const), kind: fc.constant("alarm" as const), id, level: fc.constantFrom(...LEVELS), seq }).chain((alarm) =>
    fc.option(instant, { nil: undefined }).map((expires) => (expires === undefined ? alarm : { ...alarm, expires })),
  ),
  fc.record({ v: fc.constant(1 as const), kind: fc.constant("stop" as const), id }),
  fc.record({ v: fc.constant(1 as const), kind: fc.constant("ack" as const), id, by: node, at: instant }),
  fc.record({ v: fc.constant(1 as const), kind: fc.constant("beat" as const), node, seq, at: instant }),
);

describe("encodeFrame and decodeFrame", () => {
  it("give each frame again after a round trip, and the text again after a decode", () => {
    for (const seed of SEEDS) {
      fc.assert(
        fc.property(frame, (value) => {
          const text = encodeFrame(value);
          const read = decodeFrame(text);
          expect(read, `seed ${String(seed)}`).toEqual({ tag: "ok", value });
          expect(frameBytes(text)).toBeLessThanOrEqual(MESH_FRAME_BYTES);
        }),
        { seed, numRuns: 300 },
      );
    }
  });

  it("keep the largest frame of each kind under the limit of bytes", () => {
    const long = "a".repeat(64);
    const name = `a${"b".repeat(31)}`;
    const largest: MeshFrame[] = [
      { v: 1, kind: "alarm", id: long, level: "life-safety", seq: MESH_SEQ_MAX, expires: INSTANT_MAX },
      { v: 1, kind: "stop", id: long },
      { v: 1, kind: "ack", id: long, by: name, at: INSTANT_MAX },
      { v: 1, kind: "beat", node: name, seq: MESH_SEQ_MAX, at: INSTANT_MAX },
    ];
    const sizes = largest.map((value) => frameBytes(encodeFrame(value)));
    expect(sizes).toEqual([101, 69, 119, 65]);
    expect(Math.max(...sizes)).toBeLessThan(MESH_FRAME_BYTES);
  });

  it("put the bell character only at the end of an alarm frame", () => {
    expect(encodeFrame({ v: 1, kind: "alarm", id: "a1", level: "urgent", seq: 0 })).toBe(`M1 A a1 U 0 - ${MESH_BELL}`);
    expect(encodeFrame({ v: 1, kind: "beat", node: "bed-node", seq: 3, at: 1000 })).toBe("M1 B bed-node 3 1000");
    expect(encodeFrame({ v: 1, kind: "ack", id: "a1", by: "bed-node", at: 5 })).toBe("M1 K a1 bed-node 5");
    expect(encodeFrame({ v: 1, kind: "stop", id: "a1" })).toBe("M1 S a1");
  });

  it("refuse to encode a frame with a problem", () => {
    const bad = { v: 1, kind: "stop", id: "a b" } as const;
    expect(frameProblems(bad)).toHaveLength(1);
    expect(() => encodeFrame(bad)).toThrow(RangeError);
    expect(frameProblems({ v: 1, kind: "beat", node: "Bed", seq: -1, at: 1.5 })).toHaveLength(3);
  });

  it("never throw, for each text", () => {
    for (const seed of SEEDS) {
      fc.assert(
        fc.property(fc.string({ maxLength: 260 }), (text) => {
          const read = decodeFrame(text);
          expect(["ok", "err"]).toContain(read.tag);
        }),
        { seed, numRuns: 500 },
      );
    }
  });

  it("refuse an oversized text, an unknown version, an unknown kind and a bad field", () => {
    const kindOf = (text: string) => {
      const read = decodeFrame(text);
      return read.tag === "err" ? read.error.kind : "ok";
    };
    expect(kindOf(`M1 S ${"a".repeat(MESH_FRAME_BYTES)}`)).toBe("size");
    expect(kindOf("hello")).toBe("form");
    expect(kindOf("")).toBe("form");
    expect(kindOf("M2 S a1")).toBe("version");
    expect(kindOf("M1 X a1")).toBe("kind");
    expect(kindOf("M1")).toBe("kind");
    expect(kindOf("M1 S a1 a2")).toBe("field");
    expect(kindOf("M1 S a.1")).toBe("field");
    expect(kindOf("M1 A a1 U 0 -")).toBe("field");
    expect(kindOf("M1 A a1 Q 0 - \u0007")).toBe("field");
    expect(kindOf("M1 A a1 U 01 - \u0007")).toBe("field");
    expect(kindOf("M1 A a1 U 0 1e3 \u0007")).toBe("field");
    expect(kindOf(`M1 A a1 U ${String(MESH_SEQ_MAX + 1)} - \u0007`)).toBe("field");
    expect(kindOf("M1 K a1 Bed-Node 5")).toBe("field");
    expect(kindOf("M1 K a1 bed-node -5")).toBe("field");
    expect(kindOf("M1 B bed-node 3")).toBe("field");
    expect(kindOf("M1 B bed-node 3 99999999999999999")).toBe("field");
    expect(kindOf("M1  S a1")).toBe("kind");
    expect(kindOf("M1 S a1 ")).toBe("field");
    expect(kindOf("M1 S a1")).toBe("ok");
  });

  it("give a problem with no part of the text", () => {
    const read = decodeFrame("M1 K secret-id-123 Bad 5");
    expect(read.tag).toBe("err");
    if (read.tag === "err") expect(read.error.message).not.toContain("secret");
  });
});
