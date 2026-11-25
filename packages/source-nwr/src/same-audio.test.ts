import { describe, expect, it } from "vitest";
import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { parseSameHeader, sameIssuedAt } from "@mark1russell7/alerts-format-nws";
import { checkDecodedLines } from "./decode-check.test-helpers.ts";
import {
  encodeSameMessage,
  rawPcm,
  SAME_BAUD,
  SAME_MARK_HZ,
  SAME_PREAMBLE_BYTES,
  SAME_SPACE_HZ,
  sameBits,
  sameBurst,
  wavFile,
  weeklyTestHeader,
} from "./same-audio.test-helpers.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3]);
const RATE = 22_050;
const AT = Date.parse("2026-11-25T17:00:00Z");

/** This function gives the energy of one frequency in a window of samples (the Goertzel filter). */
function energy(samples: Int16Array, from: number, length: number, hz: number): number {
  const k = 2 * Math.cos((2 * Math.PI * hz) / RATE);
  let a = 0;
  let b = 0;
  for (let i = from; i < from + length; i += 1) {
    const next = (samples[i] ?? 0) / 32_767 + k * a - b;
    b = a;
    a = next;
  }
  return a * a + b * b - k * a * b;
}

/** This function reads the bytes of one burst that starts at the sample `from`, with the timing of the encoder. */
function readBurst(samples: Int16Array, from: number, bytes: number): string {
  let text = "";
  for (let byte = 0; byte < bytes; byte += 1) {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      const index = byte * 8 + bit;
      const start = from + Math.ceil((index * RATE) / SAME_BAUD);
      const end = from + Math.floor(((index + 1) * RATE) / SAME_BAUD);
      if (energy(samples, start, end - start, SAME_MARK_HZ) > energy(samples, start, end - start, SAME_SPACE_HZ)) value |= 1 << bit;
    }
    text += String.fromCharCode(value);
  }
  return text;
}

describe("the SAME encoder of the tests", () => {
  it("gives the preamble and the text with the least significant bit first", () => {
    expect([...sameBurst("Z").subarray(SAME_PREAMBLE_BYTES - 1)]).toEqual([0xab, 0x5a]);
    expect(sameBits(Uint8Array.of(0xab))).toEqual([1, 1, 0, 1, 0, 1, 0, 1]);
  });

  it("makes a weekly test header that the format reads, at the instant of the issue", () => {
    const header = weeklyTestHeader(AT);
    expect(header).toBe("ZCZC-WXR-RWT-029095-029037+0015-3291700-KXYZ/NWS-");
    const parsed = parseSameHeader(header);
    expect(parsed).toMatchObject({ originator: "WXR", event: "RWT", locations: ["029095", "029037"], sender: "KXYZ/NWS" });
    expect(parsed === undefined ? undefined : sameIssuedAt(parsed, AT + 60_000)).toBe(AT);
  });

  it.each(SEEDS)("encodes each burst so that a demodulator reads it back, with seeded noise (seed %i)", (seed) => {
    const header = weeklyTestHeader(AT);
    const samples = encodeSameMessage(header, { noise: { level: 0.2, next: random(seed).next } });
    const lead = Math.round(0.5 * RATE);
    const gap = RATE;
    const burst = (text: string): number => Math.ceil(((SAME_PREAMBLE_BYTES + text.length) * 8 * RATE) / SAME_BAUD);
    expect(samples.length).toBe(2 * lead + 3 * (burst(header) + gap) + 3 * (burst("NNNN") + gap));
    let at = lead;
    for (const text of [header, header, header, "NNNN", "NNNN", "NNNN"]) {
      const read = readBurst(samples, at, SAME_PREAMBLE_BYTES + text.length);
      expect(read).toBe(`${String.fromCharCode(0xab).repeat(SAME_PREAMBLE_BYTES)}${text}`);
      at += burst(text) + gap;
    }
    // The gaps are silence with noise only.
    expect(Math.max(...Array.from(samples.subarray(0, lead), Math.abs))).toBeLessThanOrEqual(Math.round(0.2 * 32_767));
  });

  it("gives the same audio for the same seed", () => {
    const one = encodeSameMessage("NNNN", { noise: { level: 0.1, next: random(7).next } });
    const two = encodeSameMessage("NNNN", { noise: { level: 0.1, next: random(7).next } });
    expect(Buffer.from(one.buffer).equals(Buffer.from(two.buffer))).toBe(true);
  });

  it("writes a WAV file of 16-bit mono PCM", () => {
    const samples = Int16Array.of(0, 1, -1, 32_767, -32_768);
    const wav = wavFile(samples);
    const view = new DataView(wav.buffer);
    const text = (from: number, length: number): string => String.fromCharCode(...wav.subarray(from, from + length));
    expect([text(0, 4), text(8, 4), text(12, 4), text(36, 4)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect([view.getUint32(4, true), view.getUint16(20, true), view.getUint16(22, true), view.getUint32(24, true), view.getUint16(34, true), view.getUint32(40, true)]).toEqual([46, 1, 1, RATE, 16, 10]);
    expect([...wav.subarray(44)]).toEqual([...rawPcm(samples)]);
    expect([...rawPcm(Int16Array.of(-2))]).toEqual([0xfe, 0xff]);
  });
});

describe("checkDecodedLines", () => {
  const header = weeklyTestHeader(AT);

  it("passes for the lines of multimon-ng with the header", async () => {
    const lines = ["multimon-ng 1.3.1", "Enabled demodulators: EAS", `EAS (part): ${header}`, `EAS (part): ${header}`, `EAS: ${header}`, `EAS (part): ${header}`, "EAS: NNNN", ""];
    expect(await checkDecodedLines(lines, { header, now: AT + 60_000 })).toEqual({ pass: true, failures: [], bodies: [header, header] });
  });

  it("fails with no header, or with another header", async () => {
    expect(await checkDecodedLines(["EAS: NNNN"], { header, now: AT + 60_000 })).toMatchObject({ pass: false, failures: [`no observation has the header ${header}`] });
    const other = header.replace("RWT", "TOR");
    const check = await checkDecodedLines([`EAS: ${other}`], { header, now: AT + 60_000 });
    expect(check.pass).toBe(false);
    expect(check.failures).toContain(`the fetch gave other headers: ${other}`);
  });
});
