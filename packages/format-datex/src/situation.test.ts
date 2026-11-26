import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { datexTime, isValidAt, readSituationPublication, RECORD_GROUPS, recordGroup, type SituationPublication, type SituationRecord } from "./index.ts";

const NAMESPACES =
  'xmlns:mc="http://datex2.eu/schema/3/messageContainer" xmlns:sit="http://datex2.eu/schema/3/situation" xmlns:com="http://datex2.eu/schema/3/common" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';

/** This function gives the XML text of one record of DATEX II version 3. */
const record = (id: string, type: string, fields: string, validity = "<com:validityStatus>active</com:validityStatus>"): string =>
  `<sit:situationRecord xsi:type="sit:${type}" id="${id}" version="2"><sit:situationRecordCreationTime>2026-11-20T10:00:00Z</sit:situationRecordCreationTime>` +
  `<sit:probabilityOfOccurrence>certain</sit:probabilityOfOccurrence><sit:validity>${validity}</sit:validity>${fields}` +
  `<sit:locationReference xsi:type="loc:PointLocation"><loc:pointByCoordinates><loc:latitude>1</loc:latitude></loc:pointByCoordinates></sit:locationReference></sit:situationRecord>`;

/** This function gives the XML text of one situation. */
const situation = (id: string, records: string, status = "real", severity = "medium"): string =>
  `<sit:situation id="${id}"><sit:overallSeverity>${severity}</sit:overallSeverity><sit:headerInformation><com:informationStatus>${status}</com:informationStatus></sit:headerInformation>${records}</sit:situation>`;

/** This function gives the XML text of a publication in a message container. */
const publication = (situations: string, time = "2026-11-25T01:12:00.002329901Z"): string =>
  `<?xml version="1.0" encoding="UTF-8"?><mc:messageContainer ${NAMESPACES} modelBaseVersion="3"><mc:payload xsi:type="sit:SituationPublication" lang="en" modelBaseVersion="3">` +
  `<com:publicationTime>${time}</com:publicationTime><com:publicationCreator><com:country>xx</com:country><com:nationalIdentifier>PUBLISHER</com:nationalIdentifier></com:publicationCreator>` +
  `${situations}</mc:payload></mc:messageContainer>`;

const span = (start: string, end?: string): string =>
  `<com:validityStatus>definedByValidityTimeSpec</com:validityStatus><com:validityTimeSpecification><com:overallStartTime>${start}</com:overallStartTime>` +
  `${end === undefined ? "" : `<com:overallEndTime>${end}</com:overallEndTime>`}</com:validityTimeSpecification>`;

const read = (xml: string): SituationPublication => {
  const result = readSituationPublication(xml);
  if (!result.ok) throw new Error(result.reason);
  return result.publication;
};

describe("datexTime", () => {
  it("reads a time with nine digits of a second, with no fraction, and with an offset, and keeps the milliseconds", () => {
    expect(datexTime("2026-11-25T01:12:00.002329901Z")).toBe(Date.parse("2026-11-25T01:12:00.002Z"));
    expect(datexTime("2026-11-25T01:12:00Z")).toBe(Date.parse("2026-11-25T01:12:00Z"));
    expect(datexTime("2026-11-25T02:12:00.5+01:00")).toBe(Date.parse("2026-11-25T01:12:00.500Z"));
  });

  it("gives undefined for a text that is not a time, and for a time with no zone", () => {
    for (const text of ["", "yesterday", "2026-11-25", "2026-11-25T01:12:00", "2026-13-45T01:12:00Z"]) expect(datexTime(text), text).toBeUndefined();
    expect(datexTime(undefined)).toBeUndefined();
    expect(datexTime(12)).toBeUndefined();
  });

  it("gives the time of Date.parse to the millisecond for each time of a whole millisecond", () => {
    fc.assert(
      fc.property(fc.date({ min: new Date("1990-01-01T00:00:00Z"), max: new Date("2100-01-01T00:00:00Z"), noInvalidDate: true }), fc.nat(999_999), (date, extra) => {
        const iso = date.toISOString();
        // Digits after the millisecond do not change the time.
        const nine = `${iso.slice(0, -1)}${String(extra).padStart(6, "0")}Z`;
        expect(datexTime(nine)).toBe(date.getTime());
      }),
    );
  });
});

describe("readSituationPublication", () => {
  it("reads the time, the creator and the facts of each record of a real situation", () => {
    const xml = publication(
      situation("S1", record("R1", "RoadOrCarriagewayOrLaneManagement", "<sit:cause><sit:causeType>roadMaintenance</sit:causeType></sit:cause><sit:roadOrCarriagewayOrLaneManagementType>laneClosures</sit:roadOrCarriagewayOrLaneManagementType>")) +
        situation("S2", record("R2", "VehicleObstruction", "<sit:vehicleObstructionType>brokenDownVehicle</sit:vehicleObstructionType>", span("2026-11-25T01:09:33.450207147Z")), "real", "low"),
    );
    const read1 = read(xml);
    expect(read1).toEqual({
      published: Date.parse("2026-11-25T01:12:00.002Z"),
      country: "xx",
      creator: "PUBLISHER",
      records: [
        { situation: "S1", id: "R1", version: "2", type: "RoadOrCarriagewayOrLaneManagement", kind: "laneClosures", status: "active", probability: "certain", cause: "roadMaintenance", severity: "medium" },
        { situation: "S2", id: "R2", version: "2", type: "VehicleObstruction", kind: "brokenDownVehicle", status: "definedByValidityTimeSpec", start: Date.parse("2026-11-25T01:09:33.450Z"), probability: "certain", severity: "low" },
      ],
      unreal: 0,
      faults: [],
    } satisfies SituationPublication);
  });

  it("reads a payload at the root with no message container, and a situation with no information status as real", () => {
    const xml =
      `<sit:payload ${NAMESPACES} xsi:type="sit:SituationPublication"><com:publicationTime>2026-11-25T01:12:00Z</com:publicationTime>` +
      `<sit:situation id="S1">${record("R1", "Accident", "<sit:accidentType>collision</sit:accidentType>")}</sit:situation></sit:payload>`;
    const read1 = read(xml);
    expect(read1.records.map((item) => [item.id, item.type, item.kind])).toEqual([["R1", "Accident", "collision"]]);
    expect(read1.country).toBeUndefined();
  });

  it("counts a test or an exercise situation and gives none of its records", () => {
    const xml = publication(situation("S1", record("R1", "Accident", ""), "test") + situation("S2", record("R2", "Accident", ""), "exercise") + situation("S3", record("R3", "Accident", "")));
    const read1 = read(xml);
    expect(read1.unreal).toBe(2);
    expect(read1.records.map((item) => item.id)).toEqual(["R3"]);
  });

  it("gives a fault for each record that it cannot read, and keeps the other records", () => {
    const xml = publication(
      situation(
        "S1",
        record("R1", "Accident", "", "") +
          record("R2", "Accident", "", span("tomorrow")) +
          `<sit:situationRecord id="R3" version="1"><sit:validity><com:validityStatus>active</com:validityStatus></sit:validity></sit:situationRecord>` +
          record("R4", "Accident", ""),
      ),
    );
    const read1 = read(xml);
    expect(read1.records.map((item) => item.id)).toEqual(["R4"]);
    expect(read1.faults).toEqual(["the record R1 has no validity status", "the record R2 has a start that is not a time", "a record of the situation S1 has no id, no version or no type"]);
  });

  it("reads the validity status of version 2 as the status of version 3", () => {
    const xml = publication(situation("S1", record("R1", "Accident", "", "<com:validityStatus>definedByValidityTimeSpecification</com:validityStatus>")));
    expect(read(xml).records[0]?.status).toBe("definedByValidityTimeSpec");
  });

  it("refuses a DOCTYPE, a text that is not well formed, a text with no situation publication and a publication with no time", () => {
    const refused = (xml: string): string => {
      const result = readSituationPublication(xml);
      expect(result.ok, xml.slice(0, 80)).toBe(false);
      return result.ok ? "" : result.reason;
    };
    expect(refused(`<!DOCTYPE a [<!ENTITY b "c">]>${publication("")}`)).toMatch(/DOCTYPE/);
    expect(refused(publication("").replace("</mc:payload>", ""))).not.toBe("");
    expect(refused(`<mc:messageContainer ${NAMESPACES}><mc:payload xsi:type="sit:MeasuredDataPublication"/></mc:messageContainer>`)).toMatch(/no situation publication/);
    expect(refused(publication("").replace(/<com:publicationTime>[^<]+<\/com:publicationTime>/, ""))).toMatch(/no time/);
    expect(refused("")).not.toBe("");
  });

  it("does not throw for any text", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        expect(() => readSituationPublication(text)).not.toThrow();
        expect(() => readSituationPublication(publication(text))).not.toThrow();
      }),
    );
  });
});

describe("isValidAt", () => {
  const base: SituationRecord = { situation: "S", id: "R", version: "1", type: "Accident", status: "active" };
  const start = Date.parse("2026-11-25T01:00:00Z");
  const end = Date.parse("2026-11-25T02:00:00Z");

  it("gives true for an active record and false for a suspended record, at each time", () => {
    expect(isValidAt({ ...base, start: end, end: start }, start)).toBe(true);
    expect(isValidAt({ ...base, status: "suspended", start, end }, start + 1)).toBe(false);
  });

  it("gives the time span for a record of definedByValidityTimeSpec: from the start, and before the end", () => {
    const spec: SituationRecord = { ...base, status: "definedByValidityTimeSpec", start, end };
    expect([start - 1, start, end - 1, end].map((at) => isValidAt(spec, at))).toEqual([false, true, true, false]);
    expect(isValidAt({ ...base, status: "definedByValidityTimeSpec", start }, end * 2)).toBe(true);
    expect(isValidAt({ ...base, status: "definedByValidityTimeSpec" }, 0)).toBe(true);
  });
});

describe("recordGroup", () => {
  it("gives the group of each class, and a closure only for a management record whose type is a closure", () => {
    const cases: [string, string | undefined, string][] = [
      ["Accident", "collision", "accident"],
      ["AbnormalTraffic", "stationaryTraffic", "congestion"],
      ["VehicleObstruction", "brokenDownVehicle", "obstruction"],
      ["AnimalPresenceObstruction", undefined, "obstruction"],
      ["RoadOrCarriagewayOrLaneManagement", "laneClosures", "closure"],
      ["RoadOrCarriagewayOrLaneManagement", "carriagewayClosures", "closure"],
      ["RoadOrCarriagewayOrLaneManagement", "roadClosed", "closure"],
      ["RoadOrCarriagewayOrLaneManagement", "useOfSpecifiedLanesOrCarriagewaysAllowed", "other"],
      ["RoadOrCarriagewayOrLaneManagement", undefined, "other"],
      ["MaintenanceWorks", "roadworks", "works"],
      ["ConstructionWorks", undefined, "works"],
      ["PoorEnvironmentConditions", "fog", "conditions"],
      ["NonWeatherRelatedRoadConditions", undefined, "conditions"],
      ["SpeedManagement", "speedRestrictionInOperation", "other"],
      ["GeneralNetworkManagement", "bridgeSwingInOperation", "other"],
    ];
    for (const [type, kind, group] of cases) expect(recordGroup({ type, ...(kind === undefined ? {} : { kind }) }), `${type} ${String(kind)}`).toBe(group);
  });

  it("gives one of RECORD_GROUPS for each class and type", () => {
    fc.assert(fc.property(fc.string(), fc.option(fc.string(), { nil: undefined }), (type, kind) => {
        expect(RECORD_GROUPS).toContain(recordGroup({ type, ...(kind === undefined ? {} : { kind }) }));
      }),
    );
  });
});
