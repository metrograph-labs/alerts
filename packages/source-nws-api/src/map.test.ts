import { readdirSync, readFileSync } from "node:fs";
import { capMessageKey, type MapProblem, type Observation, type ObservationId, type Report } from "@mark1russell7/alerts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { NWS_DESCRIPTOR } from "./descriptor.ts";
import { mapObservation, SOURCE_ID } from "./map.ts";
import { isSameCode, isUgcCode, mainVtec, NWS_ORIGIN, parseVtec, PHENOMENA, vtecKey, type Vtec } from "@mark1russell7/alerts-format-nws";
import { CAP_CATEGORIES, CAP_CERTAINTY, CAP_CERTAINTY_ALIASES, CAP_NOT_ALERTS, CAP_OPERATIONS, CAP_RESPONSES, CAP_SEVERITY, CAP_STATUS, CAP_URGENCY } from "@mark1russell7/alerts-format-cap";

const FIXTURES = new URL("../fixtures/", import.meta.url);
const NAMES = readdirSync(FIXTURES).filter((name) => name.endsWith(".json"));
const text = (name: string): string => readFileSync(new URL(name, FIXTURES), "utf8");
const feature = (name: string): any => JSON.parse(text(name));
const FETCHED = Date.parse("2026-11-15T00:00:00Z");

const observe = (body: string): Observation => ({
  id: `observation-${String(body.length)}` as ObservationId,
  source: SOURCE_ID,
  fetched: FETCHED,
  contentType: "application/geo+json",
  body,
  transport: { latency: 0 },
});

const mapOne = (body: unknown): { report: Report | undefined; problems: readonly MapProblem[] } => {
  const result = mapObservation(observe(typeof body === "string" ? body : JSON.stringify(body)));
  return { report: result.reports[0], problems: result.problems };
};

/** The kind code that each fixture has: its file name is the NWS event code. */
const EXPECTED_KIND: Readonly<Record<string, string>> = {
  "nws-bzw.json": "met.winter.blizzard",
  "nws-cfs.json": "met.flood.coastal",
  "nws-faa.json": "met.flood.areal",
  "nws-faw.json": "met.flood.areal",
  "nws-flw.json": "met.flood.river",
  "nws-fzw.json": "met.freeze",
  "nws-glw.json": "met.marine.gale",
  "nws-hwa.json": "met.wind.high",
  "nws-keepalive.json": "system.test",
  "nws-scy.json": "met.marine.small-craft",
  "nws-sps.json": "met.special",
  "nws-srw.json": "met.marine.storm",
  "nws-upw.json": "met.marine.freezing-spray.heavy",
  "nws-wwy.json": "met.winter.weather",
};

describe("the map of the recorded alerts", () => {
  it("has a fixture for each expected kind", () => {
    expect(NAMES.sort()).toEqual(Object.keys(EXPECTED_KIND).sort());
  });

  it.each(NAMES)("maps %s to one report with no problem", (name) => {
    const source = feature(name);
    const properties = source.properties;
    const { report, problems } = mapOne(source);
    expect(problems).toEqual([]);
    expect(report).toBeDefined();
    if (report === undefined) return;

    expect(report.kind.code).toBe(EXPECTED_KIND[name]);
    expect(report.kind.label).toBe(properties.event);
    expect(report.key).toBe(properties.id);
    expect(report.source).toBe(SOURCE_ID);
    expect(report.origin).toBe(NWS_ORIGIN);
    expect(NWS_DESCRIPTOR.origins).toContain(report.origin);
    expect(report.op).toBe(properties.messageType.toLowerCase());
    expect(report.status).toBe(properties.status.toLowerCase());
    expect(report.severity).toBe(properties.severity.toLowerCase());
    expect(report.sent).toBe(Date.parse(properties.sent));
    expect(report.received).toBe(FETCHED);
    expect(report.headline).toBe(properties.headline ?? properties.parameters.NWSheadline?.[0] ?? properties.event);
    expect(report.sender).toBe(properties.senderName);
    expect(report.areaText).toBe(properties.areaDesc);

    const references = (properties.references as { identifier: string }[]).map((reference) => reference.identifier);
    for (const reference of references) expect(report.references).toContain(reference);
    expect(report.references).not.toContain(report.key);

    for (const ugc of properties.geocode.UGC) expect(report.areas).toContainEqual({ type: "code", system: "ugc", code: ugc, block: "feature" });
    for (const same of properties.geocode.SAME) expect(report.areas).toContainEqual({ type: "code", system: "same", code: same, block: "feature" });
    expect(report.areas.some((area) => area.type === "polygon")).toBe(source.geometry !== null);
    expect(report.areas.every((area) => area.type !== "place" && area.block === "feature")).toBe(true);

    const vtec = ((properties.parameters.VTEC ?? []) as string[]).map((one) => parseVtec(one)).filter((one): one is Vtec => one !== undefined);
    const main = mainVtec(vtec);
    // Each alert has the key of its CAP message. An alert with no VTEC has only that key.
    const messageKey = capMessageKey({ sender: properties.sender, identifier: properties.id, sent: report.sent });
    expect(messageKey).toBeDefined();
    expect(report.correlation).toContainEqual(messageKey);
    if (main === undefined) {
      expect(report.correlation).toEqual([messageKey]);
    } else {
      expect(PHENOMENA[main.phenomenon]?.code).toBe(report.kind.code);
      expect(report.correlation).toContainEqual(vtecKey(main, report.sent));
    }
  });

  it.each(NAMES)("gives the same reports for %s each time", (name) => {
    expect(mapObservation(observe(text(name)))).toEqual(mapObservation(observe(text(name))));
  });

  it("marks the keepalive as a test", () => {
    const { report } = mapOne(feature("nws-keepalive.json"));
    expect(report?.status).toBe("test");
    expect(report?.categories).toEqual(["met"]);
  });

  it("maps each alert of a feature collection, with the path of each problem", () => {
    const good = feature("nws-flw.json");
    const bad = { ...feature("nws-glw.json"), properties: { ...feature("nws-glw.json").properties, id: undefined } };
    const result = mapObservation(observe(JSON.stringify({ type: "FeatureCollection", features: [good, bad] })));
    expect(result.reports.map((report) => report.key)).toEqual([good.properties.id]);
    expect(result.problems).toEqual([{ path: "features[1].properties.id", message: "the alert has no identifier", fatal: true }]);
  });
});

describe("the map of broken alerts", () => {
  const base = feature("nws-flw.json");
  const withProperties = (change: Record<string, unknown>): unknown => ({ ...base, properties: { ...base.properties, ...change } });

  it("gives a fatal problem for a body that is not JSON or not a feature", () => {
    expect(mapOne("<html>")).toEqual({ report: undefined, problems: [{ path: "", message: "the body is not JSON", fatal: true }] });
    expect((mapOne({ type: "Point" })).problems[0]?.fatal).toBe(true);
    expect((mapOne({ type: "Feature" })).problems[0]).toMatchObject({ path: "properties", fatal: true });
  });

  it("gives a fatal problem for an alert with no valid sent time", () => {
    const { report, problems } = mapOne(withProperties({ sent: "yesterday" }));
    expect(report).toBeUndefined();
    expect(problems.filter((problem) => problem.fatal)).toEqual([
      { path: "properties.sent", message: "the alert has no valid sent time", fatal: true },
    ]);
  });

  it("gives no report and no problem for an acknowledgment", () => {
    expect(mapOne(withProperties({ messageType: "Ack" }))).toEqual({ report: undefined, problems: [] });
  });

  it("keeps a report with a problem for an unknown value or field", () => {
    const { report, problems } = mapOne(withProperties({ severity: "Catastrophic", status: "Rehearsal", colour: "red" }));
    expect(report?.severity).toBe("unknown");
    expect(report?.status).toBe("actual");
    expect(problems.map((problem) => problem.path).sort()).toEqual(["properties.colour", "properties.severity", "properties.status"]);
    expect(problems.every((problem) => !problem.fatal)).toBe(true);
    // The fallbacks lose a value of the message. The unknown field is only a note: the report is whole.
    const lossy = problems.filter((problem) => problem.lossy === true).map((problem) => problem.path);
    expect(lossy.sort()).toEqual(["properties.severity", "properties.status"]);
  });

  it.each<[string, Record<string, unknown>, string, string]>([
    ["an absent severity", { severity: undefined }, "properties.severity", "the value is absent: the map uses unknown"],
    ["an absent urgency", { urgency: null }, "properties.urgency", "the value is absent: the map uses unknown"],
    ["an absent certainty", { certainty: " " }, "properties.certainty", "the value is absent: the map uses unknown"],
    ["an absent expiry time", { expires: undefined }, "properties.expires", "the alert has no expiry time"],
    ["an absent event name", { event: undefined }, "properties.event", "the alert has no event name"],
    ["a VTEC event with no VTEC", { parameters: {} }, "properties.parameters.VTEC", 'the alert has no P-VTEC string, and the event "FLW" has one'],
    ["parameters that are not an object", { parameters: "x" }, "properties.parameters", "the value is a string, not an object"],
    ["event codes that are not an object", { eventCode: ["FLW"] }, "properties.eventCode", "the value is a list, not an object"],
    ["references that are not a list", { references: "x" }, "properties.references", "the value is a string, not a list"],
    ["a reference with no identifier", { references: [{ sender: "w-nws.webmaster@noaa.gov" }] }, "properties.references[0]", "the reference has no identifier"],
    ["a description that is not a text", { description: 7 }, "properties.description", "the value is a number, not a text"],
    ["a category list with no CAP category", { category: [] }, "properties.category", "the alert has no CAP category: the map uses met"],
    ["a response that is not a text", { response: [true] }, "properties.response[0]", "the item is a boolean, not a text"],
  ])("gives a lossy problem for %s", (_name, change, path, message) => {
    const { report, problems } = mapOne(withProperties(change));
    expect(report).toBeDefined();
    expect(problems).toContainEqual({ path, message, fatal: false, lossy: true });
  });

  it("gives a lossy problem for an expired reference that is not sender, identifier and sent", () => {
    const parameters = { ...base.properties.parameters, expiredReferences: ["w-nws.webmaster@noaa.gov,urn:oid:2.49.0.1.840.0.1,2026-11-14T10:00:00-06:00 broken"] };
    const { report, problems } = mapOne(withProperties({ parameters }));
    expect(report?.references).toContain("urn:oid:2.49.0.1.840.0.1");
    expect(problems).toEqual([
      { path: "properties.parameters.expiredReferences", message: 'the reference "broken" is not "sender,identifier,sent"', fatal: false, lossy: true },
    ]);
  });

  it("gives no problem for the fields that the NWS leaves empty", () => {
    const { report, problems } = mapOne(withProperties({ onset: null, ends: null, headline: null, instruction: null, references: [], response: undefined }));
    expect(report).toBeDefined();
    expect(problems).toEqual([]);
  });

  it("keeps the label of an unknown event and says so", () => {
    const { report, problems } = mapOne(
      withProperties({ event: "Volcanic Haze Notice", eventCode: { SAME: ["NWS"], NationalWeatherService: ["VHN"] }, parameters: {} }),
    );
    expect(report?.kind).toEqual({ code: "other.unknown", label: "Volcanic Haze Notice" });
    expect(problems).toContainEqual({ path: "properties.event", message: 'the kind tables do not know the event "Volcanic Haze Notice"', fatal: false, lossy: true });
  });

  it("closes an open ring, and drops a polygon with a bad outside ring", () => {
    const open = { ...base, geometry: { type: "Polygon", coordinates: [[[-98, 28], [-97, 28], [-97, 29]]] } };
    const closed = mapOne(open);
    expect(closed.report?.areas).toContainEqual({ type: "polygon", rings: [[[-98, 28], [-97, 28], [-97, 29], [-98, 28]]], block: "feature" });
    expect(closed.problems.map((problem) => problem.path)).toEqual(["geometry.coordinates[0]"]);

    const broken = mapOne({ ...base, geometry: { type: "Polygon", coordinates: [[[-98, 28], [-97, 200], [-97, 29]]] } });
    expect(broken.report?.areas.some((area) => area.type === "polygon")).toBe(false);
    expect(broken.problems[0]?.fatal).toBe(false);
  });

  it("reads the expired references of the NWS", () => {
    const { report } = mapOne(
      withProperties({ parameters: { ...base.properties.parameters, expiredReferences: ["w-nws.webmaster@noaa.gov,urn:oid:old.1,2026-11-14T01:00:00-06:00 w-nws.webmaster@noaa.gov,urn:oid:old.2,2026-11-14T02:00:00-06:00"] } }),
    );
    expect(report?.references).toEqual(expect.arrayContaining(["urn:oid:old.1", "urn:oid:old.2"]));
    expect(report?.parameters["expiredReferences"]).toBeUndefined();
  });
});

describe("the region codes of an alert", () => {
  // Each NWS alert has UGC and SAME codes. Until the home of geography matches shapes, only a code
  // area matches a watch. Thus an alert with no valid code reaches nobody.
  const base = feature("nws-flw.json");
  const withGeocode = (geocode: unknown): unknown => ({ ...base, properties: { ...base.properties, geocode } });
  const NO_CODE = { path: "properties.geocode", message: "the alert has no valid region code: no watch can match it", fatal: true };
  const codesOf = (report: Report | undefined): unknown[] => (report?.areas ?? []).filter((area) => area.type === "code");

  it("gives a fatal problem, and no report, for an alert with no geocode", () => {
    const { geocode: _geocode, ...properties } = base.properties;
    expect(mapOne({ ...base, properties })).toEqual({
      report: undefined,
      problems: [{ path: "properties.geocode", message: "the alert has no geocode", fatal: false, lossy: true }, NO_CODE],
    });
  });

  it.each([
    ["an empty geocode", {}, ["properties.geocode.UGC", "properties.geocode.SAME"]],
    ["lists with other names", { ugc: ["TXZ123"], same: ["048019"] }, ["properties.geocode.ugc", "properties.geocode.same", "properties.geocode.UGC", "properties.geocode.SAME"]],
    ["a geocode that is not an object", 5, ["properties.geocode"]],
    ["codes of an unknown form", { UGC: ["TX-Z-123"], SAME: ["48019"] }, ["properties.geocode.UGC[0]", "properties.geocode.SAME[0]"]],
    ["empty lists", { UGC: [], SAME: [] }, []],
  ])("gives a fatal problem, and no report, for %s", (_name, geocode, paths) => {
    const { report, problems } = mapOne(withGeocode(geocode));
    expect(report).toBeUndefined();
    expect(problems.filter((problem) => !problem.fatal).map((problem) => problem.path)).toEqual(paths);
    expect(problems.filter((problem) => problem.fatal)).toEqual([NO_CODE]);
  });

  it("keeps the valid codes of a report, and gives a problem for each code of an unknown form", () => {
    const { report, problems } = mapOne(withGeocode({ UGC: ["txz123", "TX-Z-124", 7], SAME: [" 048019 "] }));
    expect(codesOf(report)).toEqual([
      { type: "code", system: "ugc", code: "TXZ123", block: "feature" },
      { type: "code", system: "same", code: "048019", block: "feature" },
    ]);
    expect(problems).toEqual([
      { path: "properties.geocode.UGC[1]", message: 'the value "TX-Z-124" is not a UGC code', fatal: false, lossy: true },
      { path: "properties.geocode.UGC[2]", message: "the value 7 is not a UGC code", fatal: false, lossy: true },
    ]);
  });

  it("gives a report with a valid region code, or a fatal problem, when one field of a recorded alert changes", () => {
    const valid = (area: Report["areas"][number]): boolean =>
      area.type !== "code" || (area.system === "ugc" || area.system === "ugc-fire" ? isUgcCode(area.code) : area.system === "same" && isSameCode(area.code));
    const change = fc.constantFrom(...NAMES).chain((name) =>
      fc.tuple(
        fc.constant(name),
        fc.constantFrom(...Object.keys(feature(name).properties), "geocode.UGC", "geocode.SAME"),
        // An undefined value removes the field, because JSON.stringify drops it.
        fc.option(fc.jsonValue(), { nil: undefined }),
      ),
    );
    fc.assert(
      fc.property(change, ([name, field, value]) => {
        const source = feature(name);
        const [outer, inner] = field.split(".");
        const properties =
          inner === undefined
            ? { ...source.properties, [field]: value }
            : { ...source.properties, geocode: { ...source.properties.geocode, [inner]: value } };
        const result = mapObservation(observe(JSON.stringify({ ...source, properties })));
        const [report] = result.reports;
        if (report !== undefined) return report.areas.some((area) => area.type === "code") && report.areas.every(valid);
        // An acknowledgment or an error message of CAP is not an alert, and gives no report and no problem.
        const notAlert = outer === "messageType" && typeof value === "string" && ["ack", "error"].includes(value.trim().toLowerCase());
        return notAlert || result.problems.some((problem) => problem.fatal);
      }),
    );
  });
});

describe("the fire zones of an alert (AL-33)", () => {
  // A Red Flag Warning made from a recorded alert. The codes are codes of Texas, and the event is made up.
  const base = feature("nws-flw.json");
  const redFlag = (properties: Record<string, unknown>): unknown => ({
    ...base,
    geometry: null,
    properties: {
      ...base.properties,
      event: "Red Flag Warning",
      parameters: { ...base.properties.parameters, VTEC: ["/O.NEW.KEWX.FW.W.0003.261118T1800Z-261119T0300Z/"] },
      geocode: { UGC: ["TXZ205", "TXZ206"], SAME: ["048029"] },
      affectedZones: ["https://api.weather.gov/zones/fire/TXZ205", "https://api.weather.gov/zones/fire/TXZ206"],
      ...properties,
    },
  });
  const zonesOf = (body: unknown): unknown[] =>
    (mapOne(body).report?.areas ?? []).flatMap((area) => (area.type === "code" && area.system !== "same" ? [`${area.system}:${area.code}`] : []));

  it("gives a fire zone code for each zone that affectedZones names as a fire zone", () => {
    expect(zonesOf(redFlag({}))).toEqual(["ugc-fire:TXZ205", "ugc-fire:TXZ206"]);
    expect(mapOne(redFlag({})).problems).toEqual([]);
  });

  it("lets affectedZones decide first, and the VTEC phenomenon decide for a code that the list does not name", () => {
    const mixed = ["https://api.weather.gov/zones/forecast/TXZ205", "https://api.weather.gov/zones/fire/TXZ205"];
    expect(zonesOf(redFlag({ affectedZones: mixed }))).toEqual(["ugc:TXZ205", "ugc-fire:TXZ205", "ugc-fire:TXZ206"]);
    expect(zonesOf(redFlag({ affectedZones: ["https://api.weather.gov/zones/forecast/TXZ205"] }))).toEqual(["ugc:TXZ205", "ugc-fire:TXZ206"]);
    const { affectedZones: _zones, ...rest } = (redFlag({}) as { properties: Record<string, unknown> }).properties;
    expect(zonesOf({ ...base, geometry: null, properties: rest })).toEqual(["ugc-fire:TXZ205", "ugc-fire:TXZ206"]);
  });

  it("gives forecast zone codes for an alert of another phenomenon, and a problem for a list that is not texts", () => {
    const wind = { parameters: { ...base.properties.parameters, VTEC: ["/O.NEW.KEWX.WI.Y.0003.261118T1800Z-261119T0300Z/"] }, affectedZones: undefined };
    expect(zonesOf(redFlag(wind))).toEqual(["ugc:TXZ205", "ugc:TXZ206"]);
    const { report, problems } = mapOne(redFlag({ affectedZones: 5 }));
    expect(report?.areas.filter((area) => area.type === "code" && area.system === "ugc-fire")).toHaveLength(2);
    expect(problems.map((problem) => problem.path)).toEqual(["properties.affectedZones"]);
  });
});

describe("the map function", () => {
  it("does not throw for any JSON body", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const result = mapObservation(observe(JSON.stringify(value) ?? "null"));
        return Array.isArray(result.reports) && Array.isArray(result.problems);
      }),
    );
  });

  it("does not throw when a field of a real alert has any value", () => {
    const source = feature("nws-faw.json");
    const fields = Object.keys(source.properties);
    fc.assert(
      fc.property(fc.constantFrom(...fields), fc.jsonValue(), (field, value) => {
        const changed = { ...source, properties: { ...source.properties, [field]: value } };
        const result = mapObservation(observe(JSON.stringify(changed)));
        return result.reports.length <= 1 && result.problems.every((problem) => typeof problem.path === "string");
      }),
    );
  });

  // The fields that the report holds. A field of the message that the map does not read is not here.
  const HELD = [
    "@id", "id", "areaDesc", "geocode", "references", "sent", "effective", "onset", "expires", "ends", "status", "messageType",
    "category", "severity", "certainty", "urgency", "event", "sender", "senderName", "headline", "description", "instruction",
    "response", "note", "parameters", "scope", "code", "language", "web", "eventCode", "replacedBy", "replacedAt",
  ];
  const OBJECTS = new Set(["geocode", "parameters", "eventCode"]);
  const loses = (problems: readonly MapProblem[], field: string): boolean =>
    problems.some((problem) => (problem.fatal || problem.lossy === true) && problem.path.startsWith(`properties.${field}`));
  const withField = (name: string, field: string, value: unknown): unknown => {
    const source = feature(name);
    return { ...source, properties: { ...source.properties, [field]: value } };
  };

  it("gives a fatal or a lossy problem when a field that the report holds has a value of the wrong JSON type", () => {
    // JSON has no NaN and no Infinity: JSON.stringify writes null, which is the value of an absent field.
    const scalar = fc.oneof(fc.integer(), fc.double({ noNaN: true, noDefaultInfinity: true }), fc.boolean());
    const wrong = (field: string): fc.Arbitrary<unknown> =>
      OBJECTS.has(field)
        ? fc.oneof(scalar, fc.string(), fc.array(fc.jsonValue(), { minLength: 1 }))
        : fc.oneof(scalar, fc.dictionary(fc.string(), fc.jsonValue()), fc.array(scalar, { minLength: 1 }));
    const change = fc.tuple(fc.constantFrom(...NAMES), fc.constantFrom(...HELD)).chain(([name, field]) => fc.tuple(fc.constant(name), fc.constant(field), wrong(field)));
    fc.assert(
      fc.property(change, ([name, field, value]) => {
        const { problems } = mapOne(withField(name, field, value));
        expect(loses(problems, field), `${name} ${field} ${JSON.stringify(value)}`).toBe(true);
      }),
    );
  });

  it("gives a lossy problem when a CAP value of a recorded alert is not a CAP value", () => {
    const sets: Record<string, ReadonlySet<string>> = {
      status: CAP_STATUS,
      messageType: new Set([...CAP_OPERATIONS, ...CAP_NOT_ALERTS]),
      severity: CAP_SEVERITY,
      urgency: CAP_URGENCY,
      // A deprecated certainty is not a problem: it reads as its equivalent.
      certainty: new Set([...CAP_CERTAINTY, ...CAP_CERTAINTY_ALIASES.keys()]),
      category: CAP_CATEGORIES,
      response: CAP_RESPONSES,
    };
    const change = fc
      .tuple(fc.constantFrom(...NAMES), fc.constantFrom(...Object.keys(sets)))
      .chain(([name, field]) => fc.tuple(fc.constant(name), fc.constant(field), fc.string().filter((value) => !sets[field]!.has(value.trim().toLowerCase()))));
    fc.assert(
      fc.property(change, ([name, field, value]) => {
        const { report, problems } = mapOne(withField(name, field, value));
        expect(report, `${name} ${field} ${JSON.stringify(value)}`).toBeDefined();
        expect(problems.some((problem) => problem.lossy === true && problem.path === `properties.${field}`), `${name} ${field} ${JSON.stringify(value)}`).toBe(true);
      }),
    );
  });

  it("gives the same report and only a note for a field that the map does not know", () => {
    const change = fc.tuple(fc.constantFrom(...NAMES), fc.string().map((name) => `x-${name}`), fc.jsonValue());
    fc.assert(
      fc.property(change, ([name, field, value]) => {
        const before = mapOne(feature(name)).report;
        const after = mapOne(withField(name, field, value));
        expect(after.problems).toEqual([{ path: `properties.${field}`, message: "the map function does not know this field", fatal: false }]);
        expect({ ...after.report, observation: undefined }).toEqual({ ...before, observation: undefined });
      }),
    );
  });

  it("does not throw for any geometry", () => {
    const source = feature("nws-sps.json");
    fc.assert(
      fc.property(fc.jsonValue(), (geometry) => {
        const result = mapObservation(observe(JSON.stringify({ ...source, geometry })));
        return result.reports.length === 1;
      }),
    );
  });
});

describe("the VTEC key at the new year", () => {
  // Two messages of one event, made from a recorded alert. The first message starts the event on
  // 31 December. The second one continues it on 1 January, with the start 000000T0000Z.
  const base = feature("nws-bzw.json");
  const message = (id: string, sent: string, messageType: string, vtec: string, references: unknown[]): unknown => ({
    ...base,
    properties: { ...base.properties, id, sent, messageType, references, parameters: { ...base.properties.parameters, VTEC: [vtec] } },
  });
  const first = message("urn:oid:test.year.1", "2026-12-31T20:00:00+00:00", "Alert", "/O.NEW.PAFG.BZ.W.0099.261231T2100Z-270101T1600Z/", []);
  const second = message("urn:oid:test.year.2", "2027-01-01T03:00:00+00:00", "Update", "/O.CON.PAFG.BZ.W.0099.000000T0000Z-270101T1600Z/", [
    { "@id": "x", identifier: "urn:oid:test.year.1", sender: "w-nws.webmaster@noaa.gov", sent: "2026-12-31T20:00:00+00:00" },
  ]);

  it("gives two keys, and the CAP reference still links the two reports", () => {
    const one = (mapOne(first)).report;
    const two = (mapOne(second)).report;
    const vtecOf = (report: Report | undefined) => report?.correlation.filter((key) => key.system === "vtec");
    expect(vtecOf(one)).toEqual([{ system: "vtec", id: "PAFG.BZ.W.0099.2026" }]);
    expect(vtecOf(two)).toEqual([{ system: "vtec", id: "PAFG.BZ.W.0099.2027" }]);
    expect(two?.references).toContain(one?.key);
  });
});

describe("a message that a later message replaced", () => {
  // The real first message of a Texas flash flood warning (KEWX 0108), fetched after a later message replaced it.
  // Its one home is the package `format-cap`.
  const replaced = readFileSync(new URL("../../format-cap/fixtures/pairs/kewx-ff-w-0108-new.nws-api.json", import.meta.url), "utf8");

  it("keeps the link to the later message as parameters, with no problem", () => {
    const { report, problems } = mapOne(replaced);
    expect(problems).toEqual([]);
    expect(report?.parameters["replacedBy"]).toEqual(["https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.c20308989378c74bdd6d3b88ef94d5a3b9891350.001.1"]);
    expect(report?.parameters["replacedAt"]).toEqual(["2026-11-08T23:54:00-06:00"]);
    expect(report?.parameters["WEAHandling"]).toEqual(["Imminent Threat"]);
  });
});
