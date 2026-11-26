import { describe, expect, it } from "vitest";
import { MAX_VERSIONS, rangeText, type PackageBody } from "./body.ts";
import type { OsvRange } from "./osv.ts";
import { packageRanges, rangeOfText } from "./ranges.ts";

const pkg = (fields: Partial<PackageBody>): PackageBody => ({ ecosystem: "npm", name: "a", purl: "pkg:npm/a", versions: [], ranges: [], ...fields });

describe("the text of a range", () => {
  it("gives the same events after rangeText", () => {
    const ranges: OsvRange[] = [
      { type: "SEMVER", events: [{ name: "introduced", version: "0" }, { name: "fixed", version: "3.16.3" }] },
      { type: "ECOSYSTEM", events: [{ name: "introduced", version: "1.0" }, { name: "last_affected", version: "1.4" }, { name: "limit", version: "*" }] },
      { type: "GIT", events: [{ name: "introduced", version: "0a1b2c" }, { name: "fixed", version: "3d4e5f" }] },
    ];
    for (const range of ranges) {
      expect(rangeOfText(rangeText(range))).toEqual({ type: range.type, events: range.events.map((event) => ({ [event.name]: event.version })) });
    }
  });

  it("refuses a text that rangeText did not write", () => {
    for (const text of ["", "SEMVER", "SEMVER introduced", "SEMVER moved 1.0", "SEMVER introduced 1.0 2.0", "SEMVER introduced 0,fixed 1.0"]) {
      expect(rangeOfText(text)).toBeUndefined();
    }
  });
});

describe("the ranges of a package", () => {
  it("gives a vers text for each range of SEMVER or ECOSYSTEM, and one for the list of versions", () => {
    expect(packageRanges(pkg({ ranges: ["SEMVER introduced 0, fixed 3.16.3"] }))).toEqual(["vers:semver/<3.16.3"]);
    expect(packageRanges(pkg({ ecosystem: "PyPI", purl: "pkg:pypi/a", ranges: ["ECOSYSTEM introduced 1.0, fixed 1.2"], versions: ["1.0", "1.1"] }))).toEqual([
      "vers:pypi/>=1.0|<1.2",
      "vers:pypi/1.0|1.1",
    ]);
    expect(packageRanges(pkg({ ranges: ["SEMVER introduced 0"] }))).toEqual(["vers:semver/*"]);
  });

  it("covers a GIT range only with a complete list of versions", () => {
    expect(packageRanges(pkg({ ranges: ["GIT introduced 0a1b2c, fixed 3d4e5f"], versions: ["1.0.0", "1.0.1"] }))).toEqual(["vers:npm/1.0.0|1.0.1"]);
    expect(packageRanges(pkg({ ranges: ["GIT introduced 0a1b2c, fixed 3d4e5f", "SEMVER introduced 0, fixed 2.0.0"] }))).toBeUndefined();
    const cut = Array.from({ length: MAX_VERSIONS }, (_, index) => `1.0.${String(index)}`);
    expect(packageRanges(pkg({ ranges: ["GIT introduced 0a1b2c, fixed 3d4e5f"], versions: cut }))).toBeUndefined();
  });

  it("gives no ranges for a package with no range and no version", () => {
    expect(packageRanges(pkg({}))).toBeUndefined();
  });
});
