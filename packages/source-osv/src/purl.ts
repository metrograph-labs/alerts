/**
 * The package URL (purl) of a package of a record: the id of the subject `purl` of a report. The purl has no version, no
 * qualifiers and no subpath, so a person who names a package gets each report of each version.
 *
 * The rules of each type come from the purl specification (`https://github.com/package-url/purl-spec`).
 *
 * The home of purl is the planned package `package-id` (`mark1russell7/package-id`). This file moves there in AL-200,
 * after the first release of that package. Until then, this file is a temporary copy.
 */

/** The purl type of each OSV ecosystem that has one. An ecosystem that is not in the table has no purl. */
export const PURL_TYPES: Readonly<Record<string, string>> = {
  npm: "npm",
  PyPI: "pypi",
  "crates.io": "cargo",
  RubyGems: "gem",
  NuGet: "nuget",
  Go: "golang",
  Maven: "maven",
  Packagist: "composer",
  Pub: "pub",
  Hex: "hex",
  Hackage: "hackage",
  CRAN: "cran",
};

/** This function encodes one part of a purl: each character other than a letter, a digit or `.-_~` is percent-encoded. */
function part(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** This function gives the namespace and the name of a package of a type, as the purl specification normalizes them. */
function namesOf(type: string, name: string): { readonly namespace?: string; readonly name: string } | undefined {
  const at = (slash: number): { readonly namespace: string; readonly name: string } => ({ namespace: name.slice(0, slash), name: name.slice(slash + 1) });
  switch (type) {
    case "npm": {
      const slash = name.indexOf("/");
      return name.startsWith("@") && slash > 1 ? at(slash) : { name };
    }
    case "pypi":
      return { name: name.toLowerCase().replace(/[-_.]+/g, "-") };
    case "golang": {
      const slash = name.lastIndexOf("/");
      return slash > 0 ? { namespace: name.slice(0, slash).toLowerCase(), name: name.slice(slash + 1).toLowerCase() } : { name: name.toLowerCase() };
    }
    case "maven": {
      const colon = name.indexOf(":");
      return colon > 0 ? { namespace: name.slice(0, colon), name: name.slice(colon + 1) } : undefined;
    }
    case "composer": {
      const slash = name.indexOf("/");
      return slash > 0 ? { namespace: name.slice(0, slash).toLowerCase(), name: name.slice(slash + 1).toLowerCase() } : { name: name.toLowerCase() };
    }
    case "pub":
    case "hex":
      return { name: name.toLowerCase() };
    default:
      return { name };
  }
}

/** This function gives the purl of a package with no version, or `undefined` for an ecosystem with no purl type. */
export function purlOf(ecosystem: string, name: string): string | undefined {
  const type = PURL_TYPES[ecosystem];
  if (type === undefined || name === "") return undefined;
  const names = namesOf(type, name);
  if (names === undefined) return undefined;
  const namespace = names.namespace === undefined ? "" : `${names.namespace.split("/").map(part).join("/")}/`;
  return `pkg:${type}/${namespace}${part(names.name)}`;
}

/**
 * This function gives the purl of a package with no version, no qualifiers and no subpath. A purl of the record wins
 * when it is a valid purl. Else the function builds the purl from the ecosystem and the name.
 */
export function packagePurl(pkg: { readonly ecosystem: string; readonly name: string; readonly purl?: string }): string | undefined {
  if (pkg.purl !== undefined && /^pkg:[a-z][a-z0-9.+-]*\/[^?#@]+/.test(pkg.purl)) {
    const bare = pkg.purl.replace(/[?#].*$/, "");
    // A version follows the last `@`, but an npm scope in a purl is `%40`, so each `@` starts the version.
    const at = bare.indexOf("@");
    return at < 0 ? bare : bare.slice(0, at);
  }
  return purlOf(pkg.ecosystem, pkg.name);
}
