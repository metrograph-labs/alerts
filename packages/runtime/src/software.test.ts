import { add, assess, EMPTY_STATE, incidents, policyWithSoftware, softwareMatches, versRangeCheck, type ObservationId, type PersonId, type PersonWatch, type Report, type SoftwareStack, type Subject } from "@mark1russell7/alerts";
import { entryBody, mapObservation as mapKevObservation, SOURCE_ID as KEV_SOURCE } from "@mark1russell7/alerts-source-cisa-kev";
import { createCsafMap, CSAF_PROVIDERS, readAdvisory } from "@mark1russell7/alerts-source-csaf";
import { createOsvMap, fileBody, OSV_PROVIDERS } from "@mark1russell7/alerts-source-osv";
import { describe, expect, it } from "vitest";

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

// The CSAF cases: synthetic advisories in the shape of the vendor advisories, with products of no purl. The products
// get purls of the type `generic`, and the ranges use the `generic` order of the versions of vendors.
const csafDocument = (id: string, branches: readonly unknown[], affected: readonly string[]): Record<string, unknown> => ({
  document: {
    category: "csaf_security_advisory",
    csaf_version: "2.0",
    title: `A test advisory ${id}`,
    publisher: { category: "vendor", name: "Example Controls", namespace: "https://example.org" },
    distribution: { tlp: { label: "CLEAR" } },
    tracking: { id, version: "1", status: "final", initial_release_date: "2026-11-20T00:00:00Z", current_release_date: "2026-11-20T00:00:00Z", revision_history: [] },
  },
  product_tree: { branches: [{ category: "vendor", name: "Example Controls", branches }] },
  vulnerabilities: [{ cve: "CVE-2026-3000", product_status: { known_affected: affected } }],
});
const version = (category: string, name: string, id: string) => ({ category, name, product: { name: `${name} (${id})`, product_id: id } });
const productName = (name: string, ...branches: readonly unknown[]) => ({ category: "product_name", name, branches });

const CSAF_ADVISORIES = [
  csafDocument("CSAF-1", [productName("Panel Studio", version("product_version_range", "<=V6.80", "A1"))], ["A1"]),
  csafDocument("CSAF-2", [productName("Edge Box", version("product_version", "5.6.0", "B1"), version("product_version", "5.6.2", "B2"))], ["B1", "B2"]),
  csafDocument("CSAF-3", [productName("Rapid Tool", version("product_version_range", "vers:generic/<=2.9.1.0_FR", "C1"))], ["C1"]),
  csafDocument("CSAF-4", [productName("Desk Server", version("product_version_range", "vers:all/*", "D1"))], ["D1"]),
  csafDocument("CSAF-5", [productName("Old Gateway", version("product_version_range", "all versions before the fix", "E1"))], ["E1"]),
];

const CSAF_STACK: SoftwareStack = {
  parts: [
    {
      part: "plant",
      packages: [
        { purl: "pkg:generic/example%20controls/panel%20studio", version: "V6.70" },
        { purl: "pkg:generic/example%20controls/edge%20box", version: "5.6.2" },
        { purl: "pkg:generic/example%20controls/rapid%20tool", version: "2.9.1.0_ESP" },
        { purl: "pkg:generic/example%20controls/desk%20server", version: "2.0" },
      ],
    },
    {
      part: "office",
      packages: [
        { purl: "pkg:generic/example%20controls/panel%20studio", version: "V6.81" },
        { purl: "pkg:generic/example%20controls/edge%20box", version: "5.6.1" },
        { purl: "pkg:generic/example%20controls/rapid%20tool", version: "2.8.5.0301_ESP" },
        { purl: "pkg:generic/example%20controls/old%20gateway", version: "1.0" },
      ],
    },
  ],
};

const CSAF_KNOWN = [
  "CSAF-1 plant pkg:generic/example%20controls/panel%20studio affected -",
  "CSAF-2 plant pkg:generic/example%20controls/edge%20box affected -",
  "CSAF-3 plant pkg:generic/example%20controls/rapid%20tool unknown -",
  "CSAF-3 office pkg:generic/example%20controls/rapid%20tool affected -",
  "CSAF-4 plant pkg:generic/example%20controls/desk%20server affected -",
  "CSAF-5 office pkg:generic/example%20controls/old%20gateway unknown -",
];

const csafSubjectsOf = (advisory: Record<string, unknown>): readonly Subject[] => {
  const provider = CSAF_PROVIDERS[0]!;
  const body = readAdvisory(JSON.stringify(advisory), "https://example.com/advisory.json");
  const observation = {
    id: "obs-2" as ObservationId,
    source: provider.id,
    fetched: NOW,
    contentType: "application/json",
    body: JSON.stringify(body),
    transport: { url: "https://example.com/advisory.json", status: 200, latency: 10 },
  };
  const result = createCsafMap(provider)(observation);
  expect(result.problems.filter((problem) => problem.fatal === true)).toEqual([]);
  return result.reports.flatMap((report) => report.about);
};

describe("the gate of the match of CSAF advisories to a stack", () => {
  it("gives each known match of the products of vendors, with 0 misses and 0 false matches", () => {
    const found = CSAF_ADVISORIES.flatMap((advisory) => {
      const id = String((advisory["document"] as { tracking: { id: string } }).tracking.id);
      return softwareMatches(csafSubjectsOf(advisory), CSAF_STACK, versRangeCheck).map((m) => `${id} ${m.part} ${m.purl} ${m.verdict} ${m.fixed ?? "-"}`);
    });
    const misses = CSAF_KNOWN.filter((match) => !found.includes(match));
    const falseMatches = found.filter((match) => !CSAF_KNOWN.includes(match));
    expect({ misses, falseMatches }).toEqual({ misses: [], falseMatches: [] });
    expect(found).toHaveLength(CSAF_KNOWN.length);
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
    expect(versRangeCheck("vers:generic/<=2.9.1.0_FR", "2.9.1.0_ESP")).toEqual({ affected: undefined });
  });
});

// The raise by the KEV catalog of CISA: the advisory of a vendor and the KEV entry of the same CVE join one incident.
// An affected part gets a higher level than with the advisory alone. A fixed part gets no level.
const KEV_CVE = "CVE-2026-3100";
const kevAdvisory = {
  ...csafDocument("CSAF-K", [productName("Panel Studio", version("product_version_range", "<=V6.80", "K1"))], ["K1"]),
  vulnerabilities: [{ cve: KEV_CVE, scores: [{ products: ["K1"], cvss_v3: { version: "3.1", baseScore: 7.5, baseSeverity: "HIGH" } }], product_status: { known_affected: ["K1"] } }],
};
const KEV_ENTRY = {
  cveID: KEV_CVE,
  vendorProject: "Example Controls",
  product: "Panel Studio",
  vulnerabilityName: "Example Controls Panel Studio Improper Authentication Vulnerability",
  dateAdded: "2026-11-24",
  shortDescription: "A test entry of the catalog.",
  requiredAction: "Apply mitigations per vendor instructions.",
  dueDate: "2026-12-15",
  knownRansomwareCampaignUse: "Unknown",
  notes: "",
  cwes: ["CWE-287"],
};

const csafReports = (advisory: Record<string, unknown>): readonly Report[] => {
  const provider = CSAF_PROVIDERS[0]!;
  const body = readAdvisory(JSON.stringify(advisory), "https://example.com/advisory.json");
  const observation = { id: "obs-3" as ObservationId, source: provider.id, fetched: NOW, contentType: "application/json", body: JSON.stringify(body), transport: { latency: 10 } };
  return createCsafMap(provider)(observation).reports;
};
const kevReports = (): readonly Report[] => {
  const result = mapKevObservation({ id: "obs-4" as ObservationId, source: KEV_SOURCE, fetched: NOW, contentType: "application/json", body: entryBody(KEV_ENTRY), transport: { latency: 10 } });
  expect(result.problems).toEqual([]);
  return result.reports;
};

describe("the raise of a match by the KEV catalog", () => {
  const plant: SoftwareStack = { parts: [{ part: "plant", packages: [{ purl: "pkg:generic/example%20controls/panel%20studio", version: "V6.70" }] }] };
  const office: SoftwareStack = { parts: [{ part: "office", packages: [{ purl: "pkg:generic/example%20controls/panel%20studio", version: "V6.81" }] }] };
  const watcher: PersonWatch = { person: "p1" as PersonId, places: [], rules: [], subjects: [{ system: "software.part" }] };
  const levelOf = (reports: readonly Report[], stack: SoftwareStack): string => {
    const found = incidents(add(EMPTY_STATE, { reports }), NOW);
    expect(found).toHaveLength(1);
    return assess(found[0]!, watcher, [], policyWithSoftware(undefined, stack), NOW).level;
  };

  it("joins the advisory and the KEV entry, and raises the affected part from notice to urgent", () => {
    const advisory = csafReports(kevAdvisory);
    expect(advisory.map((report) => report.severity)).toEqual(["moderate"]);
    expect(levelOf(advisory, plant)).toBe("notice");
    expect(levelOf([...advisory, ...kevReports()], plant)).toBe("urgent");
  });

  it("gives no level to a part with a fixed version, also when attackers use the flaw", () => {
    expect(levelOf([...csafReports(kevAdvisory), ...kevReports()], office)).toBe("none");
  });
});
