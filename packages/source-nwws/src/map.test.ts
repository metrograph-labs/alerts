import { readFileSync } from "node:fs";
import { capMessageKey, type Observation } from "@mark1russell7/alerts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createProductBuffer } from "./buffer.ts";
import { observationOf } from "./fetch.ts";
import { mapObservation, SOURCE_ID } from "./map.ts";
import { readProduct } from "./product.ts";
import type { RoomProduct } from "./session.ts";

const PRODUCTS: readonly (RoomProduct & { readonly received: number })[] = JSON.parse(readFileSync(new URL("../fixtures/products-20261116T2002Z.json", import.meta.url), "utf8"));

/** The observations of the four CAP products of the fixture, by the AWIPS id of each product. */
function observations(): Record<string, Observation> {
  const buffer = createProductBuffer(10);
  for (const entry of PRODUCTS) {
    const read = readProduct(entry.attributes, entry.text);
    if (read.ok) buffer.add(read.product, entry.received);
  }
  const all: Record<string, Observation> = {};
  for (const entry of buffer.read().entries) {
    const observation = observationOf(entry, "xmpp:room@conference.example.org");
    if (observation !== undefined) all[entry.product.awipsid] = observation;
  }
  return all;
}

describe("mapObservation", () => {
  it("maps each real CAP message of the stream to one report of the NWS, with no problem", () => {
    const all = observations();
    expect(Object.keys(all)).toEqual(["CAPWBC", "CAPMTR", "CAPCYS", "CAPHNX"]);
    for (const observation of Object.values(all)) {
      const result = mapObservation(observation);
      expect(result.problems).toEqual([]);
      expect(result.reports).toHaveLength(1);
      expect(result.reports[0]).toMatchObject({ source: SOURCE_ID, origin: "nws", received: observation.fetched });
    }
  });

  it("keeps the CAP identifier as the key, so that the report of the stream and of the NWS API are one report", () => {
    const [marine] = mapObservation(observations()["CAPMTR"]!).reports;
    expect(marine).toMatchObject({
      key: "urn:oid:2.49.0.1.840.0.c31dd22fec111b7c33a334fbba5e7fa1b201caae.001.1",
      correlation: [
        { system: "vtec", id: "KMTR.MA.W.0016.2026" },
        capMessageKey({ sender: "w-nws.webmaster@noaa.gov", identifier: "urn:oid:2.49.0.1.840.0.c31dd22fec111b7c33a334fbba5e7fa1b201caae.001.1", sent: Date.parse("2026-11-16T12:06:00-08:00") }),
      ],
      op: "alert",
      status: "actual",
      kind: { code: "met.marine.special", significance: "warning" },
      severity: "severe",
      urgency: "immediate",
      sender: "NWS San Francisco CA",
      sent: Date.parse("2026-11-16T12:06:00-08:00"),
    });
    expect(marine?.areas.some((area) => area.type === "polygon")).toBe(true);
  });

  it("maps an update with its reference, and the zones of the watch", () => {
    const [watch] = mapObservation(observations()["CAPCYS"]!).reports;
    expect(watch).toMatchObject({
      op: "update",
      references: ["urn:oid:2.49.0.1.840.0.0a0708a9935ff792f702850ebf1a0d974128bb63.001.1"],
      kind: { code: "met.wind.high", significance: "watch" },
      onset: Date.parse("2026-11-18T06:00:00Z"),
      ends: Date.parse("2026-11-19T03:00:00Z"),
    });
    expect(watch?.areas).toContainEqual(expect.objectContaining({ type: "code", code: "WYZ104" }));
  });

  it("maps the keepalive to a test report", () => {
    const [keepalive] = mapObservation(observations()["CAPWBC"]!).reports;
    expect(keepalive).toMatchObject({ status: "test", kind: { code: "system.test" }, key: "urn:oid:2.49.0.1.840.0-KEEPALIVE-16989" });
  });

  it("gives a fatal problem for a body that is not CAP, and does not throw for any body", () => {
    const observation = observations()["CAPMTR"]!;
    const result = mapObservation({ ...observation, body: "<html></html>" });
    expect(result.reports).toEqual([]);
    expect(result.problems).toEqual([expect.objectContaining({ fatal: true })]);
    fc.assert(
      fc.property(fc.string(), (body) => {
        const mapped = mapObservation({ ...observation, body });
        expect(Array.isArray(mapped.reports)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
