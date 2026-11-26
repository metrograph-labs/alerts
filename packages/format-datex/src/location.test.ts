import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_LOCATION_POINTS, readLocation, readSituationPublication } from "./index.ts";

/** The text of a point location, as NDW gives it. */
const POINT =
  "<loc:externalReferencing><loc:externalLocationCode>CODE1</loc:externalLocationCode><loc:externalReferencingSystem>RIS-index</loc:externalReferencingSystem></loc:externalReferencing>" +
  "<loc:supplementaryPositionalDescription><loc:carriageway><loc:carriageway>mainCarriageway</loc:carriageway></loc:carriageway></loc:supplementaryPositionalDescription>" +
  "<loc:pointByCoordinates><loc:pointCoordinates><loc:latitude>51.449436</loc:latitude><loc:longitude>3.586062</loc:longitude></loc:pointCoordinates></loc:pointByCoordinates>";

/** The text of an itinerary with one line, as NDW gives it. */
const LINE =
  '<loc:locationContainedInItinerary index="0"><loc:location xsi:type="loc:LinearLocation"><loc:gmlLineString srsName="WGS 84">' +
  "<loc:posList>51.814385 4.609521 51.81435 4.610235 51.814266 4.610842</loc:posList></loc:gmlLineString></loc:location></loc:locationContainedInItinerary>";

describe("readLocation", () => {
  it("reads the point of a point location and ignores the external code", () => {
    expect(readLocation(POINT)).toEqual({ shape: "point", points: [{ latitude: 51.449436, longitude: 3.586062 }] });
  });

  it("reads the positions of a GML line as latitude and longitude pairs", () => {
    expect(readLocation(LINE)).toEqual({
      shape: "line",
      points: [
        { latitude: 51.814385, longitude: 4.609521 },
        { latitude: 51.81435, longitude: 4.610235 },
        { latitude: 51.814266, longitude: 4.610842 },
      ],
    });
  });

  it("reads the lines of an itinerary in their order and removes a repeated point at a join", () => {
    const second = LINE.replace('index="0"', 'index="1"').replace("51.814385 4.609521 51.81435 4.610235 51.814266 4.610842", "51.814266 4.610842 51.8142 4.6115");
    const location = readLocation(LINE + second);
    expect(location?.shape).toBe("line");
    expect(location?.points.map((point) => point.longitude)).toEqual([4.609521, 4.610235, 4.610842, 4.6115]);
  });

  it("gives a line for two points of a linear location by coordinates", () => {
    const two = `<loc:from>${POINT}</loc:from><loc:to>${POINT.replace("3.586062", "3.6")}</loc:to>`;
    expect(readLocation(two)).toEqual({ shape: "line", points: [{ latitude: 51.449436, longitude: 3.586062 }, { latitude: 51.449436, longitude: 3.6 }] });
  });

  it("gives undefined for a location with no coordinate, an ALERT-C location and a point out of its range", () => {
    expect(readLocation(undefined)).toBeUndefined();
    expect(readLocation("")).toBeUndefined();
    expect(readLocation("<loc:alertCPoint><loc:alertCLocationCountryCode>8</loc:alertCLocationCountryCode></loc:alertCPoint>")).toBeUndefined();
    expect(readLocation(POINT.replace("51.449436", "91"))).toBeUndefined();
    expect(readLocation(POINT.replace("<loc:longitude>3.586062</loc:longitude>", ""))).toBeUndefined();
  });

  it("gives no points of a position list with an odd count of numbers or with a number that is not a coordinate", () => {
    expect(readLocation(LINE.replace("51.814266 4.610842", "51.814266"))).toBeUndefined();
    expect(readLocation(LINE.replace("4.610842", "east"))).toBeUndefined();
    expect(readLocation(LINE.replace("4.610842", "181"))).toBeUndefined();
  });

  it("refuses a DOCTYPE and a text that is not well formed", () => {
    expect(readLocation(`<!DOCTYPE x>${POINT}`)).toBeUndefined();
    expect(readLocation("<loc:pointByCoordinates><loc:latitude>1</loc:pointByCoordinates>")).toBeUndefined();
  });

  it("keeps at most MAX_LOCATION_POINTS points, with the first and the last point", () => {
    const count = 3 * MAX_LOCATION_POINTS;
    const list = Array.from({ length: count }, (_, index) => `52 ${(index / 1000).toFixed(3)}`).join(" ");
    const location = readLocation(`<loc:gmlLineString><loc:posList>${list}</loc:posList></loc:gmlLineString>`);
    expect(location?.points).toHaveLength(MAX_LOCATION_POINTS);
    expect(location?.points[0]?.longitude).toBe(0);
    expect(location?.points.at(-1)?.longitude).toBe((count - 1) / 1000);
  });

  it("does not throw for any text, and each point is in its range", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const location = readLocation(text);
        for (const point of location?.points ?? []) {
          expect(Math.abs(point.latitude)).toBeLessThanOrEqual(90);
          expect(Math.abs(point.longitude)).toBeLessThanOrEqual(180);
        }
      }),
    );
  });
});

describe("the location of a record", () => {
  it("gives the location, the creation time and the version time of each record of a publication", () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><mc:messageContainer xmlns:mc="http://datex2.eu/schema/3/messageContainer" xmlns:sit="http://datex2.eu/schema/3/situation" ' +
      'xmlns:com="http://datex2.eu/schema/3/common" xmlns:loc="http://datex2.eu/schema/3/locationReferencing" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<mc:payload xsi:type="sit:SituationPublication"><com:publicationTime>2026-11-25T01:12:00Z</com:publicationTime><sit:situation id="S1">' +
      '<sit:situationRecord xsi:type="sit:Accident" id="R1" version="3"><sit:situationRecordCreationTime>2026-11-25T01:00:00Z</sit:situationRecordCreationTime>' +
      "<sit:situationRecordVersionTime>2026-11-25T01:10:00.123456789Z</sit:situationRecordVersionTime><sit:validity><com:validityStatus>active</com:validityStatus></sit:validity>" +
      `<sit:accidentType>collision</sit:accidentType><sit:locationReference xsi:type="loc:PointLocation">${POINT}</sit:locationReference></sit:situationRecord>` +
      '<sit:situationRecord xsi:type="sit:Accident" id="R2" version="1"><sit:situationRecordVersionTime>later</sit:situationRecordVersionTime><sit:validity><com:validityStatus>active</com:validityStatus></sit:validity>' +
      '<sit:locationReference xsi:type="loc:PointLocation"><loc:alertCPoint/></sit:locationReference></sit:situationRecord></sit:situation></mc:payload></mc:messageContainer>';
    const read = readSituationPublication(xml);
    if (!read.ok) throw new Error(read.reason);
    const [first, second] = read.publication.records;
    expect(first?.created).toBe(Date.parse("2026-11-25T01:00:00Z"));
    expect(first?.updated).toBe(Date.parse("2026-11-25T01:10:00.123Z"));
    expect(first?.location).toEqual({ shape: "point", points: [{ latitude: 51.449436, longitude: 3.586062 }] });
    // A version time that is not a time and a location with no coordinate give no field, and the record stays.
    expect(second).toBeDefined();
    expect(second?.updated).toBeUndefined();
    expect(second?.location).toBeUndefined();
    expect(read.publication.faults).toEqual([]);
  });
});
