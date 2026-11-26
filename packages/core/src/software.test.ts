import { describe, expect, it } from "vitest";
import type { Subject } from "./contracts.ts";
import { alertConfigSchema, subjectSchema, softwareStackSchema } from "./schemas.ts";
import { modelOfSubject, modelSubjectId, softwareMatches, softwareMatchText, versRangeCheck, type RangeCheck, type SoftwareStack } from "./software.ts";

// A check for the tests: a range `vers:test/<N` holds each whole number below N, and gives N as the fixed version. A
// range `vers:test/?` has no known order.
const check: RangeCheck = (range, version) => {
  if (range === "vers:test/?") return { affected: undefined };
  const end = Number(range.slice("vers:test/<".length));
  return Number(version) < end ? { affected: true, fixed: String(end) } : { affected: false };
};

const stack: SoftwareStack = {
  parts: [
    { part: "web", label: "The web server", packages: [{ purl: "pkg:npm/a", version: "3" }, { purl: "pkg:npm/b", version: "1" }] },
    { part: "worker", packages: [{ purl: "pkg:npm/a", version: "7" }] },
  ],
};

const pkg = (id: string, ranges?: readonly string[]): Subject => ({ system: "purl", id, ...(ranges === undefined ? {} : { ranges }) });

describe("the match of an advisory to the software of a stack", () => {
  it("gives each part with an installed version in a range, with the fixed version", () => {
    expect(softwareMatches([pkg("pkg:npm/a", ["vers:test/<5"])], stack, check)).toEqual([
      { part: "web", label: "The web server", purl: "pkg:npm/a", installed: "3", verdict: "affected", fixed: "5" },
    ]);
  });

  it("gives no match for a version out of each range, or for a package that no part has", () => {
    expect(softwareMatches([pkg("pkg:npm/a", ["vers:test/<2"])], stack, check)).toEqual([]);
    expect(softwareMatches([pkg("pkg:npm/c", ["vers:test/<9"])], stack, check)).toEqual([]);
    expect(softwareMatches([{ system: "cve", id: "CVE-2026-0001" }], stack, check)).toEqual([]);
  });

  it("gives the verdict unknown for a package with no range or with no known order", () => {
    expect(softwareMatches([pkg("pkg:npm/b")], stack, check)).toEqual([{ part: "web", label: "The web server", purl: "pkg:npm/b", installed: "1", verdict: "unknown" }]);
    expect(softwareMatches([pkg("pkg:npm/b", ["vers:test/?"])], stack, check)[0]?.verdict).toBe("unknown");
  });

  it("takes an affected range of one subject over an unknown subject of the same package", () => {
    const matches = softwareMatches([pkg("pkg:npm/a"), pkg("pkg:npm/a", ["vers:test/<2", "vers:test/<9"])], stack, check);
    expect(matches.map((m) => [m.part, m.verdict, m.fixed])).toEqual([
      ["web", "affected", "9"],
      ["worker", "affected", "9"],
    ]);
  });
});

describe("the match of a part by its CPE name", () => {
  const plc = "cpe:2.3:o:example:panel_plc_firmware:*:*:*:*:*:*:*:*";
  const devices: SoftwareStack = {
    parts: [
      { part: "plant", packages: [{ purl: "pkg:generic/example/panel", version: "3.1.4", cpe: "cpe:2.3:o:Example:Panel_PLC_Firmware:3.1.4:*:*:*:*:*:*:*" }] },
      { part: "office", packages: [{ purl: "pkg:generic/example/panel", version: "3.1.5", cpe: "cpe:/o:example:panel_plc_firmware:3.1.5" }] },
      { part: "lab", packages: [{ purl: "pkg:generic/example/panel", version: "3.1.4" }] },
    ],
  };

  it("matches the product of the name, with the installed version, and needs the CPE of the part", () => {
    const about: Subject[] = [{ system: "cpe", id: plc, ranges: ["vers:generic/<3.1.5"] }];
    expect(softwareMatches(about, devices, versRangeCheck)).toEqual([{ part: "plant", purl: "pkg:generic/example/panel", installed: "3.1.4", verdict: "affected", fixed: "3.1.5" }]);
  });

  it("gives the verdict unknown for a CPE subject with no range, and no match for another product", () => {
    expect(softwareMatches([{ system: "cpe", id: plc }], devices, versRangeCheck).map((match) => `${match.part} ${match.verdict}`)).toEqual(["plant unknown", "office unknown"]);
    expect(softwareMatches([{ system: "cpe", id: "cpe:2.3:o:example:other_firmware:*:*:*:*:*:*:*:*" }], devices, versRangeCheck)).toEqual([]);
    expect(softwareMatches([{ system: "cpe", id: "not a cpe" }], devices, versRangeCheck)).toEqual([]);
  });

  it("keeps a CPE name in the schema, and refuses a name with no product", () => {
    expect(softwareStackSchema.parse(devices)).toEqual(devices);
    expect(softwareStackSchema.safeParse({ parts: [{ part: "x", packages: [{ purl: "pkg:generic/a/b", version: "1", cpe: "cpe:2.3:o:example:*" }] }] }).success).toBe(false);
  });
});

describe("the match of a part by its model number", () => {
  const plant: SoftwareStack = {
    parts: [
      { part: "line-1", packages: [{ purl: "pkg:generic/example/plc", version: "4.2", model: { vendor: "Example Controls", number: "6ES7212-1BE40-0XB0" } }] },
      { part: "line-2", packages: [{ purl: "pkg:generic/example/plc", version: "4.2", model: { vendor: "Other Works", number: "6ES7212-1BE40-0XB0" } }] },
      { part: "line-3", packages: [{ purl: "pkg:generic/example/plc", version: "4.2", model: { vendor: "example controls", number: "6ES7215-1AG40-0XB0" } }] },
    ],
  };

  it("matches a pattern of the same vendor, with the range of the version", () => {
    const about: Subject[] = [{ system: "model", id: modelSubjectId("EXAMPLE CONTROLS", "6ES7212-1?E40-0XB0"), ranges: ["vers:generic/<4.5"] }];
    expect(softwareMatches(about, plant, versRangeCheck)).toEqual([{ part: "line-1", purl: "pkg:generic/example/plc", installed: "4.2", verdict: "affected", fixed: "4.5" }]);
  });

  it("matches each model of a star pattern, and refuses an id with no pattern", () => {
    const about: Subject[] = [{ system: "model", id: modelSubjectId("Example Controls", "6ES721*") }];
    expect(softwareMatches(about, plant, versRangeCheck).map((match) => `${match.part} ${match.verdict}`)).toEqual(["line-1 unknown", "line-3 unknown"]);
    expect(softwareMatches([{ system: "model", id: "example%20controls/" }], plant, versRangeCheck)).toEqual([]);
  });

  it("gives the vendor in percent codes, and reads it back", () => {
    expect(modelSubjectId(" A/B Works ", "X*")).toBe("a%2Fb%20works/X*");
    expect(modelOfSubject("a%2Fb%20works/X*")).toEqual({ vendor: "a/b works", pattern: "X*" });
    expect(modelOfSubject("%E0/X")).toBeUndefined();
  });

  it("keeps a model number in the schema, and refuses a blank vendor", () => {
    expect(softwareStackSchema.parse(plant)).toEqual(plant);
    expect(softwareStackSchema.safeParse({ parts: [{ part: "x", packages: [{ purl: "pkg:generic/a/b", version: "1", model: { vendor: " ", number: "1" } }] }] }).success).toBe(false);
  });
});

describe("the schema of a subject with ranges", () => {
  it("keeps the ranges and refuses a range that is not a text", () => {
    expect(subjectSchema.parse({ system: "purl", id: "pkg:npm/a", ranges: ["vers:npm/<1.0.0"] })).toEqual({ system: "purl", id: "pkg:npm/a", ranges: ["vers:npm/<1.0.0"] });
    expect(subjectSchema.safeParse({ system: "purl", id: "pkg:npm/a", ranges: [1] }).success).toBe(false);
  });
});

describe("the schema of the software of a stack", () => {
  it("keeps a stack, and refuses a purl with a version or two parts with one id", () => {
    expect(softwareStackSchema.parse(stack)).toEqual(stack);
    expect(softwareStackSchema.safeParse({ parts: [{ part: "web", packages: [{ purl: "pkg:npm/a@1.0.0", version: "1.0.0" }] }] }).success).toBe(false);
    expect(softwareStackSchema.safeParse({ parts: [{ part: "web", packages: [] }, { part: "web", packages: [] }] }).success).toBe(false);
  });

  it("takes the software as a field of the configuration", () => {
    const config = { format: "alerts-config/1", places: [], people: [], contacts: [], policies: [], software: stack };
    expect(alertConfigSchema.safeParse(config).success).toBe(true);
  });
});

describe("the text of a match", () => {
  it("names the part, the package, the installed version and the fixed version", () => {
    expect(softwareMatchText({ part: "web", purl: "pkg:npm/a", installed: "3", verdict: "affected" })).toBe("The part web has pkg:npm/a 3. The advisory gives no fixed version.");
  });
});

describe("the check of the ranges of the core", () => {
  it("gives the verdict and the fixed version with the order of package-id", () => {
    expect(versRangeCheck("vers:npm/<2.4.1", "2.3.0")).toEqual({ affected: true, fixed: "2.4.1" });
    expect(versRangeCheck("npm/<1.0.0", "0.9.0")).toEqual({ affected: undefined });
  });
});
