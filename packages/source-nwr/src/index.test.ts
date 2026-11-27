import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Observation } from "@mark1russell7/alerts";
import {
  areasOf,
  checkCanary,
  createHeaderAssembler,
  createLineFeed,
  createNwrSource,
  GROUP_GAP_MS,
  mapObservation,
  nwrDescriptor,
  observationOf,
  readDecoderLine,
  statusOf,
  TEST_MAX_AGE_MS,
} from "./index.ts";

// Made-up headers in the form of 47 CFR 11.31. The sender is a made-up station.
const TORNADO = "ZCZC-WXR-TOR-029095-129037+0045-3291815-KXYZ/NWS-";
const WEEKLY = "ZCZC-WXR-RWT-029095+0015-3241700-KXYZ/NWS-";
const AT = Date.parse("2026-11-25T18:15:02Z");
const change = (text: string, at: number, char: string): string => text.slice(0, at) + char + text.slice(at + 1);

describe("readDecoderLine", () => {
  it("reads a copy, a checked header and an end", () => {
    expect(readDecoderLine(`EAS (part): ${TORNADO}`)).toEqual({ kind: "header", text: TORNADO, checked: false });
    expect(readDecoderLine(`EAS: ${TORNADO}\r`)).toEqual({ kind: "header", text: TORNADO, checked: true });
    expect(readDecoderLine("EAS: NNNN")).toEqual({ kind: "end" });
    expect(readDecoderLine(TORNADO)).toEqual({ kind: "header", text: TORNADO, checked: false });
  });

  it.each(["", "multimon-ng 1.3.1", "Enabled demodulators: EAS", "EAS: noise"])("ignores %j", (line) => {
    expect(readDecoderLine(line)).toBeUndefined();
  });
});

describe("createHeaderAssembler", () => {
  it("votes over three copies, each with a different error", () => {
    const assembler = createHeaderAssembler();
    expect(assembler.push({ kind: "header", text: change(TORNADO, 10, "X"), checked: false }, AT)).toEqual([]);
    expect(assembler.push({ kind: "header", text: change(TORNADO, 20, "7"), checked: false }, AT + 1000)).toEqual([]);
    expect(assembler.push({ kind: "header", text: TORNADO, checked: false }, AT + 2000)).toEqual([{ text: TORNADO, at: AT }]);
  });

  it("closes a group of two equal copies at the end of the message, or after the gap", () => {
    const one = createHeaderAssembler();
    one.push({ kind: "header", text: TORNADO, checked: false }, AT);
    one.push({ kind: "header", text: TORNADO, checked: false }, AT + 1000);
    expect(one.push({ kind: "end" }, AT + 30_000)).toEqual([{ text: TORNADO, at: AT }]);
    const two = createHeaderAssembler();
    two.push({ kind: "header", text: TORNADO, checked: false }, AT);
    two.push({ kind: "header", text: TORNADO, checked: false }, AT + 1000);
    expect(two.close(AT + 1000 + GROUP_GAP_MS)).toEqual([]);
    expect(two.close(AT + 1001 + GROUP_GAP_MS)).toEqual([{ text: TORNADO, at: AT }]);
  });

  it("gives no header of one copy, or of copies with no majority", () => {
    const assembler = createHeaderAssembler();
    assembler.push({ kind: "header", text: TORNADO, checked: false }, AT);
    expect(assembler.push({ kind: "end" }, AT + 5000)).toEqual([]);
    assembler.push({ kind: "header", text: change(TORNADO, 10, "X"), checked: false }, AT);
    assembler.push({ kind: "header", text: change(TORNADO, 10, "Y"), checked: false }, AT + 1000);
    expect(assembler.push({ kind: "header", text: change(TORNADO, 10, "Z"), checked: false }, AT + 2000)).toEqual([]);
  });

  it("gives a checked header at once, and refuses a checked text that is not a header", () => {
    const assembler = createHeaderAssembler();
    expect(assembler.push({ kind: "header", text: TORNADO, checked: true }, AT)).toEqual([{ text: TORNADO, at: AT }]);
    expect(assembler.push({ kind: "header", text: "ZCZC-WXR-TOR-", checked: true }, AT)).toEqual([]);
  });

  it("gives the header of three copies with errors at two different places", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: TORNADO.length - 1 }), fc.integer({ min: 0, max: TORNADO.length - 1 }), (first, second) => {
        fc.pre(first !== second);
        const assembler = createHeaderAssembler();
        assembler.push({ kind: "header", text: change(TORNADO, first, "#"), checked: false }, AT);
        assembler.push({ kind: "header", text: change(TORNADO, second, "#"), checked: false }, AT + 1000);
        expect(assembler.push({ kind: "header", text: TORNADO, checked: false }, AT + 2000)).toEqual([{ text: TORNADO, at: AT }]);
      }),
    );
  });
});

describe("mapObservation", () => {
  it("maps a tornado warning", () => {
    const observation = observationOf({ text: TORNADO, at: AT });
    const result = mapObservation(observation);
    expect(result.problems).toEqual([]);
    const report = result.reports[0]!;
    expect(report).toMatchObject({
      source: "nwr",
      origin: "nws",
      key: TORNADO,
      status: "actual",
      kind: { code: "met.tornado", significance: "warning", label: "Tornado Warning" },
      sent: Date.parse("2026-11-25T18:15:00Z"),
      received: AT,
      expires: Date.parse("2026-11-25T19:00:00Z"),
      sender: "KXYZ/NWS",
      headline: "Tornado Warning from KXYZ/NWS",
      parameters: { SAME: ["TOR"], originator: ["WXR"] },
    });
    expect(mapObservation(observation)).toEqual(result);
  });

  it("gives the status of a test and of a demo", () => {
    expect(statusOf("RWT")).toBe("test");
    expect(statusOf("RMT")).toBe("test");
    expect(statusOf("DMO")).toBe("exercise");
    expect(statusOf("TOR")).toBe("actual");
  });

  it("gives a note for an unknown event code", () => {
    const result = mapObservation(observationOf({ text: "ZCZC-CIV-QQQ-029095+0015-3291815-KXYZ/NWS-", at: AT }));
    expect(result.reports[0]).toMatchObject({ origin: "same-civ", kind: { code: "other.unknown", label: "QQQ" } });
    expect(result.problems).toEqual([expect.objectContaining({ path: "event", message: "the kind tables do not know the event code QQQ", fatal: false })]);
  });

  it("gives a fatal problem for a body that is not a header", () => {
    expect(mapObservation(observationOf({ text: "NNNN", at: AT }))).toEqual({ reports: [], problems: [{ path: "", message: "the body is not a SAME header", fatal: true }] });
  });
});

describe("areasOf", () => {
  it("gives the codes of a county, a part of a county, a state and the whole country", () => {
    expect(areasOf(["029095", "129037", "029000", "000000"])).toEqual([
      { type: "code", system: "same", code: "029095" },
      { type: "code", system: "ugc", code: "MOC095" },
      { type: "code", system: "same", code: "129037" },
      { type: "code", system: "same", code: "029037" },
      { type: "code", system: "ugc", code: "MOC037" },
      { type: "code", system: "same", code: "029000" },
      { type: "code", system: "state", code: "MO" },
      { type: "code", system: "iso3166", code: "US" },
    ]);
  });
});

describe("checkCanary", () => {
  const weekly = (fetched: number): Observation => ({ ...observationOf({ text: WEEKLY, at: Date.parse("2026-11-20T17:00:05Z") }), fetched });

  it("passes when the newest weekly test is at most 8 days old", () => {
    expect(checkCanary([weekly(AT)])).toMatchObject({ pass: true });
    expect(checkCanary([weekly(Date.parse("2026-11-20T17:00:00Z") + TEST_MAX_AGE_MS + 60_000)])).toMatchObject({ pass: false, late: true });
  });

  it("gives no read with no test in the first 8 days of the decoder, and fails after them", () => {
    expect(checkCanary([], { started: AT, now: AT + 60_000 })).toBeUndefined();
    expect(checkCanary([], { started: AT, now: AT + TEST_MAX_AGE_MS })).toMatchObject({ pass: false });
    expect(checkCanary([])).toMatchObject({ pass: false });
    // No test is not old data: the receiver can be at fault (AL-207).
    expect(checkCanary([])?.late).toBeUndefined();
  });
});

describe("createNwrSource", () => {
  const coverage = [{ system: "same", code: "029095" }];

  it("describes a radio source with no internet", () => {
    expect(nwrDescriptor(coverage)).toMatchObject({ id: "nwr", transport: "radio", uses: ["receiver", "power"], dependsOn: ["rf:nwr"], coverage: [{ type: "code", system: "same", code: "029095" }] });
  });

  it("reads the lines of the feed, and gives the newest test again at each fetch", async () => {
    let now = AT;
    const feed = createLineFeed(100);
    const source = createNwrSource({ feed, clock: { now: () => now }, coverage });
    const watch = { places: [] } as never;
    expect(await source.fetch({ watch })).toEqual({ ok: false, failure: { kind: "network", message: "the decoder of the radio does not run" } });
    feed.start(AT);
    for (const [index, line] of [`EAS (part): ${WEEKLY}`, `EAS (part): ${WEEKLY}`, `EAS: ${WEEKLY}`, `EAS (part): ${WEEKLY}`, "EAS: NNNN"].entries()) feed.add(line, AT + index * 1000);
    now = AT + 10_000;
    const first = await source.fetch({ watch });
    expect(first).toMatchObject({ ok: true, complete: true });
    const bodies = first.ok ? first.observations.map((observation) => observation.body) : [];
    expect(bodies).toEqual([WEEKLY, WEEKLY]);
    now = AT + 20_000;
    const second = await source.fetch({ watch });
    expect(second.ok ? second.observations.map((observation) => [observation.body, observation.fetched]) : []).toEqual([[WEEKLY, now]]);
    expect(source.check?.({ observations: second.ok ? second.observations : [] })).toMatchObject({ pass: true });
  });

  it("tells a loss of lines of the feed", async () => {
    const feed = createLineFeed(2);
    feed.start(AT);
    const source = createNwrSource({ feed, clock: { now: () => AT }, coverage });
    for (const line of ["a", "b", "c"]) feed.add(line, AT);
    expect(await source.fetch({ watch: { places: [] } as never })).toMatchObject({ ok: true, complete: false });
  });
});
