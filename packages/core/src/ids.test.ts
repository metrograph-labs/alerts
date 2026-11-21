import { describe, expect, it } from "vitest";
import type { PersonId, ReportId, SourceId } from "./contracts.ts";
import { CAP_MESSAGE_SYSTEM, capMessageKey, ID_SCHEME, messageKey, observationId, reportId } from "./ids.ts";

const source = "nws-api" as SourceId;
const hex = /^[0-9a-f]{64}$/;

// node:crypto calculated these values, apart from the home of the hash. A change of the id scheme changes them.
const GOLDEN = {
  observation: "f9688516bbc34b989ebea52300ec715d48a472b6865bfd7b1ad2f838541d554b",
  report: "578e21f72458d9724b0ddc9590d8d3a9543aa83ce22fbd28abc1947c119db53c",
  message: "da5ef4709e7f660d91513ce54b933c2c4c1e17e620235d603b07354f0a1fb716",
};

const observation = {
  source,
  contentType: "application/geo+json",
  url: "https://api.weather.gov/alerts/active?area=KS",
  body: '{"features":[]}',
};
const report = { source, key: "urn:oid:2.49.0.1.840.0.example", sent: 1763157600000 };
const message = { incident: "a".repeat(64) as ReportId, level: "life-safety", person: "person-1" as PersonId, step: 0 } as const;

describe("the id scheme", () => {
  it("has a version", () => {
    expect(ID_SCHEME).toBe("alerts-id/1");
  });

  it("gives the golden values", () => {
    expect(observationId(observation)).toBe(GOLDEN.observation);
    expect(reportId(report)).toBe(GOLDEN.report);
    expect(messageKey(message)).toBe(GOLDEN.message);
  });

  it("gives 64 lowercase hex digits", () => {
    expect(observationId(observation)).toMatch(hex);
    expect(reportId(report)).toMatch(hex);
    expect(messageKey(message)).toMatch(hex);
  });
});

describe("observationId", () => {
  it("gives the same id to the same content at a different fetch", () => {
    expect(observationId({ ...observation })).toBe(observationId(observation));
  });

  it("changes with each part of the content", () => {
    const base = observationId(observation);
    const others = [
      observationId({ ...observation, source: "nws-cap" as SourceId }),
      observationId({ ...observation, contentType: "application/json" }),
      observationId({ ...observation, url: "https://api.weather.gov/alerts/active?area=NE" }),
      observationId({ ...observation, body: '{"features":[{}]}' }),
      observationId({ source, contentType: observation.contentType, body: observation.body }),
    ];
    expect(new Set([base, ...others]).size).toBe(others.length + 1);
  });
});

describe("reportId", () => {
  it("changes with the source, the key and the sent time", () => {
    const ids = [
      reportId(report),
      reportId({ ...report, source: "nws-cap" as SourceId }),
      reportId({ ...report, key: `${report.key}.2` }),
      reportId({ ...report, sent: report.sent + 1 }),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives each part of a message its own id, and the id of a report of one part to no part", () => {
    const parts = ["info[0]", "info[1]", "info[2]"].map((part) => reportId({ ...report, part }));
    expect(new Set([reportId(report), ...parts]).size).toBe(4);
    expect(reportId({ ...report, part: undefined })).toBe(GOLDEN.report);
    // A part does not mix with the key: the key `k` with the part `1` is not the key `k1`.
    expect(reportId({ ...report, key: "k", part: "1" })).not.toBe(reportId({ ...report, key: "k1" }));
  });

  it("gives one id to one version with no sent time, a new id to a new version, and never the id of a sent time", () => {
    const { source, key } = report;
    const version = reportId({ source, key, version: "v1" });
    expect(reportId({ source, key, version: "v1" })).toBe(version);
    expect(reportId({ source, key, version: "v2" })).not.toBe(version);
    expect(reportId({ source, key: `${key}.2`, version: "v1" })).not.toBe(version);
    expect(reportId({ source, key, version: "0" })).not.toBe(reportId({ source, key, sent: 0 }));
    expect(reportId({ source, key, version: "v1", part: "info[1]" })).not.toBe(version);
  });

  it("does not mix fields that a separator character can join", () => {
    const a = reportId({ source: "a|b" as SourceId, key: "c", sent: 0 });
    const b = reportId({ source: "a" as SourceId, key: "b|c", sent: 0 });
    expect(a).not.toBe(b);
  });

  it("does not throw for a time that is not finite or a lone surrogate, because map is total", () => {
    expect(reportId({ ...report, sent: Number.NaN })).toMatch(hex);
    expect(reportId({ ...report, key: "�" })).toMatch(hex);
  });
});

describe("messageKey", () => {
  it("gives a new key to each step and to each level", () => {
    const keys = [
      messageKey(message),
      messageKey({ ...message, step: 1 }),
      messageKey({ ...message, level: "urgent" }),
      messageKey({ ...message, person: "person-2" as PersonId }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives new keys to each episode after the first one, and keeps the keys of the first episode", () => {
    expect(messageKey({ ...message, episode: 0 })).toBe(GOLDEN.message);
    expect(messageKey({ ...message, episode: undefined })).toBe(GOLDEN.message);
    const keys = [GOLDEN.message, messageKey({ ...message, episode: 1 }), messageKey({ ...message, episode: 2 }), messageKey({ ...message, step: 1, episode: 1 })];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps the kinds of id apart", () => {
    const asReport = reportId({ source: message.incident as unknown as SourceId, key: message.level, sent: 0 });
    expect(asReport).not.toBe(messageKey({ ...message, person: "0" as PersonId }));
  });
});

describe("capMessageKey", () => {
  const cap = { sender: "w-nws.webmaster@noaa.gov", identifier: "urn:oid:2.49.0.1.840.0.example", sent: 1763157600000 };

  it("gives the golden hash of the sender, the identifier and the sent time, and no text of the sender", () => {
    // node:crypto calculated this value from the canonical JSON of the hash input.
    const key = capMessageKey(cap);
    expect(key).toEqual({ system: CAP_MESSAGE_SYSTEM, id: "62ad37a2980f5fc1c68298ede998970924657fd0ccea63b2a50dfe0a1f075e84" });
    expect(key?.id).not.toContain("noaa");
  });

  it("gives one key to the copies of one message, and another key to each other message or part", () => {
    expect(capMessageKey({ ...cap, sender: ` ${cap.sender} `, identifier: `${cap.identifier}
` })).toEqual(capMessageKey(cap));
    const keys = [
      capMessageKey(cap)?.id,
      capMessageKey({ ...cap, sender: "other@example.org" })?.id,
      capMessageKey({ ...cap, identifier: `${cap.identifier}.IPAWS` })?.id,
      capMessageKey({ ...cap, sent: cap.sent + 1 })?.id,
      capMessageKey({ ...cap, part: "info[1]" })?.id,
      capMessageKey({ ...cap, part: "info[2]" })?.id,
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(capMessageKey({ ...cap, part: undefined })).toEqual(capMessageKey(cap));
  });

  it("gives no key with an empty sender or identifier", () => {
    expect(capMessageKey({ ...cap, sender: " " })).toBeUndefined();
    expect(capMessageKey({ ...cap, identifier: "" })).toBeUndefined();
  });
});
