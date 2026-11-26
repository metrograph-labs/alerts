import { describe, expect, it } from "vitest";
import type { Subject } from "./contracts.ts";
import { subjectSchema } from "./schemas.ts";
import { softwareMatches, type RangeCheck, type SoftwareStack } from "./software.ts";

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

describe("the schema of a subject with ranges", () => {
  it("keeps the ranges and refuses a range that is not a text", () => {
    expect(subjectSchema.parse({ system: "purl", id: "pkg:npm/a", ranges: ["vers:npm/<1.0.0"] })).toEqual({ system: "purl", id: "pkg:npm/a", ranges: ["vers:npm/<1.0.0"] });
    expect(subjectSchema.safeParse({ system: "purl", id: "pkg:npm/a", ranges: [1] }).success).toBe(false);
  });
});
