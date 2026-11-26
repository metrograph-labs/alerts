import type { ObservationId } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";

import { readAdvisory, type AdvisoryBody } from "./document.ts";
import { createCsafMap } from "./map.ts";
import { affectedPackages, MAX_RANGES, productsOf, rangeOf } from "./products.ts";
import { CSAF_PROVIDERS } from "./providers.ts";

// The trees are synthetic. Their shapes are the shapes of the trees of the CISA ICS, Siemens and ABB advisories.

const leaf = (category: string, name: string, id: string, purl?: string) => ({
  category,
  name,
  product: { name: `${name} (${id})`, product_id: id, ...(purl === undefined ? {} : { product_identification_helper: { purl } }) },
});
const product = (name: string, ...branches: readonly unknown[]) => ({ category: "product_name", name, branches });
const vendor = (name: string, ...branches: readonly unknown[]) => ({ category: "vendor", name, branches });

const TREE = {
  branches: [
    vendor(
      "Example Controls",
      product("Gateway Studio", leaf("product_version_range", "<=V6.80", "P1")),
      product("Edge Box", leaf("product_version", "5.6.0", "P2"), leaf("product_version", "5.6.2", "P3"), leaf("product_version_range", "vers:all/*", "P4")),
      product("Rapid Tool", leaf("product_version_range", "vers:generic/<=2.9.1.0_FR", "P5"), leaf("product_version_range", "all versions before the fix", "P6")),
    ),
    vendor("Example Libraries", product("web", leaf("product_version", "2.3.0", "P7", "pkg:npm/%40example/web@2.3.0"))),
  ],
  relationships: [{ category: "installed_on", product_reference: "P2", relates_to_product_reference: "P7", full_product_name: { name: "Edge Box on web", product_id: "P8" } }],
};

const vulnerability = (status: Record<string, readonly string[]>) => ({ cve: "CVE-2026-2000", product_status: status });

describe("the products of a tree", () => {
  it("gives a generic purl from the vendor and the product name, and the range from the version branch", () => {
    const products = productsOf(TREE);
    expect(products.get("P1")).toEqual({ purl: "pkg:generic/example%20controls/gateway%20studio", range: "vers:generic/<=V6.80" });
    expect(products.get("P2")).toEqual({ purl: "pkg:generic/example%20controls/edge%20box", range: "vers:generic/5.6.0" });
    expect(products.get("P4")).toEqual({ purl: "pkg:generic/example%20controls/edge%20box", range: "vers:all/*" });
    expect(products.get("P5")).toEqual({ purl: "pkg:generic/example%20controls/rapid%20tool", range: "vers:generic/<=2.9.1.0_FR" });
    expect(products.get("P6")).toEqual({ purl: "pkg:generic/example%20controls/rapid%20tool" });
  });

  it("prefers the purl of the identification helper, and takes the version of the purl", () => {
    expect(productsOf(TREE).get("P7")).toEqual({ purl: "pkg:npm/%40example/web", range: "vers:npm/2.3.0" });
  });

  it("gives a relationship the package of its component", () => {
    expect(productsOf(TREE).get("P8")).toEqual(productsOf(TREE).get("P2"));
  });

  it("gives no product for a leaf with no purl and no vendor", () => {
    expect(productsOf({ branches: [product("Lone", leaf("product_version", "1.0", "Q1"))] }).size).toBe(0);
    expect(productsOf(undefined).size).toBe(0);
  });
});

describe("the range of a product", () => {
  it("keeps a vers text, gives a bare range the scheme of the purl, and refuses a text that is not a range", () => {
    expect(rangeOf("generic", undefined, " vers:generic/<=2.9.1.0_FR ")).toBe("vers:generic/<=2.9.1.0_FR");
    expect(rangeOf("generic", undefined, "<=V6.80")).toBe("vers:generic/<=V6.80");
    expect(rangeOf("generic", undefined, "all versions")).toBeUndefined();
    expect(rangeOf("generic", "3.2.0.7", undefined)).toBe("vers:generic/3.2.0.7");
    expect(rangeOf("generic", " ", undefined)).toBeUndefined();
  });
});

describe("the affected packages", () => {
  it("gives the packages of the affected status only, in the order of their purls", () => {
    const { packages, cut } = affectedPackages(TREE, [vulnerability({ known_affected: ["P2", "P3", "P1"], fixed: ["P5"], known_not_affected: ["P7"] })]);
    expect(cut).toBe(0);
    expect(packages).toEqual([
      { purl: "pkg:generic/example%20controls/edge%20box", ranges: ["vers:generic/5.6.0", "vers:generic/5.6.2"] },
      { purl: "pkg:generic/example%20controls/gateway%20studio", ranges: ["vers:generic/<=V6.80"] },
    ]);
  });

  it("gives one more package with no ranges for a product with no known range", () => {
    const { packages } = affectedPackages(TREE, [vulnerability({ first_affected: ["P5"] }), vulnerability({ last_affected: ["P6"] })]);
    expect(packages).toEqual([
      { purl: "pkg:generic/example%20controls/rapid%20tool", ranges: ["vers:generic/<=2.9.1.0_FR"] },
      { purl: "pkg:generic/example%20controls/rapid%20tool" },
    ]);
  });

  it("gives a package with too many ranges no ranges", () => {
    const leaves = Array.from({ length: MAX_RANGES + 1 }, (_, index) => leaf("product_version", `1.${String(index)}`, `R${String(index)}`));
    const tree = { branches: [vendor("Example", product("Many", ...leaves))] };
    const { packages } = affectedPackages(tree, [vulnerability({ known_affected: leaves.map((item) => item.product.product_id) })]);
    expect(packages).toEqual([{ purl: "pkg:generic/example/many" }]);
  });
});

describe("the subjects of the map", () => {
  it("gives each affected package as a subject of the system purl, with its ranges", () => {
    const document = {
      document: {
        category: "csaf_security_advisory",
        csaf_version: "2.0",
        title: "Example Edge Box",
        publisher: { category: "vendor", name: "Example Controls", namespace: "https://example.org" },
        distribution: { tlp: { label: "CLEAR" } },
        tracking: { id: "EX-1", version: "1", status: "final", initial_release_date: "2026-11-20T00:00:00Z", current_release_date: "2026-11-20T00:00:00Z", revision_history: [] },
      },
      product_tree: TREE,
      vulnerabilities: [vulnerability({ known_affected: ["P2", "P6"] })],
    };
    const body = readAdvisory(JSON.stringify(document), "https://example.org/ex-1.json") as AdvisoryBody;
    const provider = CSAF_PROVIDERS[0]!;
    const observation = { id: "obs-1" as ObservationId, source: provider.id, fetched: Date.parse("2026-11-21T00:00:00Z"), contentType: "application/json", body: JSON.stringify(body), transport: { url: "https://example.org/ex-1.json", status: 200, latency: 10 } };
    const report = createCsafMap(provider)(observation).reports[0]!;
    expect(report.about.filter((subject) => subject.system === "purl")).toEqual([
      { system: "purl", id: "pkg:generic/example%20controls/edge%20box", ranges: ["vers:generic/5.6.0"] },
      { system: "purl", id: "pkg:generic/example%20controls/rapid%20tool" },
    ]);
    expect(report.parameters["package"]).toEqual(["pkg:generic/example%20controls/edge%20box", "pkg:generic/example%20controls/rapid%20tool"]);
  });
});
