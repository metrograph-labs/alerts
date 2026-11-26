import { softwareMatches, type ObservationId, type SoftwareStack, type Subject } from "@mark1russell7/alerts";
import { createOsvMap, fileBody, OSV_PROVIDERS } from "@mark1russell7/alerts-source-osv";
import { describe, expect, it } from "vitest";
import { versRangeCheck } from "./software.ts";

// The gate of AL-197: advisories of six ecosystems, and a sample stack with known matches. The OSV map gives the
// subjects with their ranges. The match gives 0 misses and 0 false matches.

const NOW = Date.parse("2026-11-25T12:00:00Z");

const record = (id: string, ecosystem: string, name: string, affected: Record<string, unknown>): Record<string, unknown> => ({
  schema_version: "1.7.0",
  id,
  modified: "2026-11-20T00:00:00Z",
  published: "2026-11-20T00:00:00Z",
  aliases: [],
  summary: `A test advisory of ${name}`,
  affected: [{ package: { ecosystem, name }, ...affected }],
});
const semver = (...events: Record<string, string>[]): Record<string, unknown> => ({ ranges: [{ type: "SEMVER", events }] });
const ecosystem = (...events: Record<string, string>[]): Record<string, unknown> => ({ ranges: [{ type: "ECOSYSTEM", events }] });

const ADVISORIES = [
  record("TEST-1", "npm", "@scope/web", semver({ introduced: "0" }, { fixed: "2.4.1" })),
  record("TEST-2", "PyPI", "Django", ecosystem({ introduced: "4.2" }, { fixed: "4.2.17" }, { introduced: "5.0" }, { fixed: "5.0.10" })),
  record("TEST-3", "Go", "golang.org/x/net", semver({ introduced: "0" }, { fixed: "0.33.0" })),
  record("TEST-4", "crates.io", "hyper", semver({ introduced: "1.0.0" }, { last_affected: "1.4.1" })),
  record("TEST-5", "npm", "left-pad", { ranges: [{ type: "GIT", repo: "https://example.com/left-pad", events: [{ introduced: "0a1b2c" }, { fixed: "3d4e5f" }] }], versions: ["1.3.0"] }),
  record("TEST-6", "Maven", "org.example:lib", ecosystem({ introduced: "0" }, { fixed: "2.0" })),
  record("TEST-7", "npm", "absent", semver({ introduced: "0" })),
  record("TEST-8", "npm", "evil", { versions: ["1.0.0", "1.0.1"] }),
  record("TEST-9", "Debian:12", "openssl", ecosystem({ introduced: "0" }, { fixed: "3.0.15-1~deb12u1" })),
];

const STACK: SoftwareStack = {
  parts: [
    {
      part: "web",
      packages: [
        { purl: "pkg:npm/%40scope/web", version: "2.3.0" },
        { purl: "pkg:npm/left-pad", version: "1.3.0" },
        { purl: "pkg:npm/evil", version: "1.0.1" },
      ],
    },
    {
      part: "api",
      packages: [
        { purl: "pkg:npm/%40scope/web", version: "2.4.1" },
        { purl: "pkg:pypi/django", version: "4.2.9" },
        { purl: "pkg:golang/golang.org/x/net", version: "v0.33.0" },
        { purl: "pkg:maven/org.example/lib", version: "1.5" },
      ],
    },
    {
      part: "worker",
      packages: [
        { purl: "pkg:pypi/django", version: "5.1" },
        { purl: "pkg:golang/golang.org/x/net", version: "v0.30.0" },
        { purl: "pkg:cargo/hyper", version: "1.4.1" },
        { purl: "pkg:deb/debian/openssl", version: "3.0.15-1~deb12u1" },
      ],
    },
    {
      part: "tools",
      packages: [
        { purl: "pkg:pypi/django", version: "4.1" },
        { purl: "pkg:cargo/hyper", version: "0.14.30" },
        { purl: "pkg:npm/left-pad", version: "1.2.0" },
        { purl: "pkg:npm/evil", version: "1.0.2" },
        { purl: "pkg:deb/debian/openssl", version: "3.0.14-1~deb12u2" },
      ],
    },
  ],
};

// Each known match: the advisory, the part, the package, the verdict and the fixed version.
const KNOWN = [
  "TEST-1 web pkg:npm/%40scope/web affected 2.4.1",
  "TEST-2 api pkg:pypi/django affected 4.2.17",
  "TEST-3 worker pkg:golang/golang.org/x/net affected 0.33.0",
  "TEST-4 worker pkg:cargo/hyper affected -",
  "TEST-5 web pkg:npm/left-pad affected -",
  "TEST-6 api pkg:maven/org.example/lib unknown -",
  "TEST-8 web pkg:npm/evil affected -",
  "TEST-9 tools pkg:deb/debian/openssl affected 3.0.15-1~deb12u1",
];

const subjectsOf = (advisory: Record<string, unknown>): readonly Subject[] => {
  const provider = OSV_PROVIDERS[0]!;
  const body = fileBody(JSON.stringify(advisory), "https://example.com/record.json");
  const observation = {
    id: "obs-1" as ObservationId,
    source: provider.id,
    fetched: NOW,
    contentType: "application/json",
    body: JSON.stringify(body),
    transport: { url: "https://example.com/record.json", status: 200, latency: 10 },
  };
  const result = createOsvMap(provider)(observation);
  expect(result.problems.filter((problem) => problem.fatal === true)).toEqual([]);
  return result.reports.flatMap((report) => report.about);
};

describe("the gate of the match of advisories to a stack", () => {
  it("gives each known match, with 0 misses and 0 false matches", () => {
    const found = ADVISORIES.flatMap((advisory) =>
      softwareMatches(subjectsOf(advisory), STACK, versRangeCheck).map((m) => `${String(advisory["id"])} ${m.part} ${m.purl} ${m.verdict} ${m.fixed ?? "-"}`),
    );
    const misses = KNOWN.filter((match) => !found.includes(match));
    const falseMatches = found.filter((match) => !KNOWN.includes(match));
    expect({ misses, falseMatches }).toEqual({ misses: [], falseMatches: [] });
    expect(found).toHaveLength(KNOWN.length);
  });
});

describe("the check of a version against a range", () => {
  it("gives the verdict and the fixed version", () => {
    expect(versRangeCheck("vers:npm/<2.4.1", "2.3.0")).toEqual({ affected: true, fixed: "2.4.1" });
    expect(versRangeCheck("vers:npm/<2.4.1", "2.4.1")).toEqual({ affected: false });
    expect(versRangeCheck("vers:semver/<=1.4.1", "1.4.1")).toEqual({ affected: true });
  });

  it("gives undefined for a text that is not a range, or for an unknown order", () => {
    expect(versRangeCheck("npm/<1.0.0", "0.9.0")).toEqual({ affected: undefined });
    expect(versRangeCheck("vers:maven/<2.0", "1.5")).toEqual({ affected: undefined });
  });
});
