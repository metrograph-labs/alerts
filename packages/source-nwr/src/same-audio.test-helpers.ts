/**
 * A SAME encoder for the tests and for the CI job of the decoder. The root of the package does not export it.
 *
 * The encoder makes the audio of one message of 47 CFR 11.31 as 16-bit mono PCM. The audio is AFSK at 520.83 bits each
 * second. The mark is at 2083.3 Hz, and the space is at 1562.5 Hz. Each burst is 16 bytes of the preamble `0xAB`, then the text.
 * Each byte goes with its least significant bit first.
 *
 * The header comes 3 times with a gap of 1 s, then `NNNN` 3 times. The message has no attention signal and no voice. The functions are pure: the noise comes from a function that the
 * caller gives, for example a seeded generator of `@mark1russell7/rigor-generators`.
 */

import type { Instant } from "@mark1russell7/alerts";

/** The bit rate of SAME, in bits each second. */
export const SAME_BAUD: number = 520 + 5 / 6;

/** The frequency of a 1 bit, in hertz. */
export const SAME_MARK_HZ: number = 2083 + 1 / 3;

/** The frequency of a 0 bit, in hertz. */
export const SAME_SPACE_HZ = 1562.5;

/** The byte of the preamble, and the count of preamble bytes before each burst. */
export const SAME_PREAMBLE = 0xab;
export const SAME_PREAMBLE_BYTES = 16;

/** The noise of the audio: its level as a fraction of the full scale, and the source of random numbers from 0 up to 1. */
export interface SameNoise {
  readonly level: number;
  readonly next: () => number;
}

/** The options of the encoder. Each option has a default. */
export interface SameAudioOptions {
  /** The sample rate, in samples each second. The default is 22050. */
  readonly sampleRate?: number;
  /** The level of the tone, as a fraction of the full scale. The default is 0.5. */
  readonly amplitude?: number;
  /** The silence before the first burst and after the last one, in seconds. The default is 0.5. */
  readonly lead?: number;
  /** The silence after each burst, in seconds. The default is 1. */
  readonly gap?: number;
  /** The noise of the audio. The default is no noise. */
  readonly noise?: SameNoise;
}

/** This function gives the bytes of one burst: the preamble, then the text as ASCII. */
export function sameBurst(text: string): Uint8Array {
  const bytes = new Uint8Array(SAME_PREAMBLE_BYTES + text.length);
  bytes.fill(SAME_PREAMBLE, 0, SAME_PREAMBLE_BYTES);
  for (let i = 0; i < text.length; i += 1) bytes[SAME_PREAMBLE_BYTES + i] = text.charCodeAt(i) & 0x7f;
  return bytes;
}

/** This function gives the bits of the bytes, with the least significant bit of each byte first. */
export function sameBits(bytes: Uint8Array): number[] {
  const bits: number[] = [];
  for (const byte of bytes) for (let bit = 0; bit < 8; bit += 1) bits.push((byte >> bit) & 1);
  return bits;
}

/** This function gives the audio of one message: the header 3 times, then the end of the message 3 times. */
export function encodeSameMessage(header: string, options: SameAudioOptions = {}): Int16Array {
  const rate = options.sampleRate ?? 22_050;
  const amplitude = options.amplitude ?? 0.5;
  const lead = Math.round((options.lead ?? 0.5) * rate);
  const gap = Math.round((options.gap ?? 1) * rate);
  const bursts = [header, header, header, "NNNN", "NNNN", "NNNN"].map((text) => sameBits(sameBurst(text)));
  const burstLength = (bits: readonly number[]): number => Math.ceil((bits.length * rate) / SAME_BAUD);
  const total = lead * 2 + bursts.reduce((sum, bits) => sum + burstLength(bits) + gap, 0);
  const samples = new Int16Array(total);
  const noise = options.noise;
  const write = (index: number, value: number): void => {
    const noisy = noise === undefined ? value : value + noise.level * (2 * noise.next() - 1);
    samples[index] = Math.round(Math.max(-1, Math.min(1, noisy)) * 32_767);
  };
  let at = 0;
  const silence = (count: number): void => {
    for (let i = 0; i < count; i += 1) write(at + i, 0);
    at += count;
  };
  silence(lead);
  for (const bits of bursts) {
    const length = burstLength(bits);
    let phase = 0;
    for (let i = 0; i < length; i += 1) {
      const bit = bits[Math.min(bits.length - 1, Math.floor((i * SAME_BAUD) / rate))];
      phase += (2 * Math.PI * (bit === 1 ? SAME_MARK_HZ : SAME_SPACE_HZ)) / rate;
      write(at + i, amplitude * Math.sin(phase));
    }
    at += length;
    silence(gap);
  }
  silence(lead);
  return samples;
}

/** This function gives the samples as raw bytes: 16-bit signed integers, little-endian, as `multimon-ng -t raw` reads them. */
export function rawPcm(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, i) => view.setInt16(i * 2, sample, true));
  return bytes;
}

/** This function gives a WAV file of the samples: PCM, one channel, 16 bits. */
export function wavFile(samples: Int16Array, sampleRate = 22_050): Uint8Array {
  const data = rawPcm(samples);
  const bytes = new Uint8Array(44 + data.length);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + data.length, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, data.length, true);
  bytes.set(data, 44);
  return bytes;
}

/** The made-up county codes of the fixtures, and the made-up sender. */
export const FIXTURE_LOCATIONS: readonly string[] = ["029095", "029037"];
export const FIXTURE_SENDER = "KXYZ/NWS";

/**
 * This function gives the header of a weekly test (`RWT`) that the NWS issues at the instant `at`, in the form of a real
 * test. The time in the header is in UTC, to the minute. The test is valid for 15 minutes.
 */
export function weeklyTestHeader(at: Instant, locations: readonly string[] = FIXTURE_LOCATIONS, sender: string = FIXTURE_SENDER): string {
  const date = new Date(at);
  const day = Math.floor((at - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  return `ZCZC-WXR-RWT-${locations.join("-")}+0015-${pad(day, 3)}${pad(date.getUTCHours(), 2)}${pad(date.getUTCMinutes(), 2)}-${sender}-`;
}
