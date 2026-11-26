/**
 * The affected packages of a CSAF document: the products of its product tree that a vulnerability gives as affected.
 * Each package is a purl with no version and the ranges of its affected versions, as `vers` texts. The map gives each
 * package as a subject of the system `purl`. Thus the match of the core finds the parts of a stack with an affected version.
 *
 * A product with a purl in its `product_identification_helper` gives that purl. The products of vendors often have no
 * purl: a vendor branch and a product name branch name them. Such a product gives a purl of the type `generic`. The
 * vendor is the namespace and the product name is the name, in lower case. For example, the product `ACF5000 LCS` of the
 * vendor `ABB` gives `pkg:generic/abb/acf5000%20lcs`.
 */

import { formatPurl, formatVers, packagePurlOf, parsePurl, parseVers } from "@mark1russell7/package-id";
import { isRecord, type Fields } from "@mark1russell7/optional/read";

/** The most packages of one advisory body. */
export const MAX_PACKAGES = 100;

/** The most ranges of one package. A package with more ranges has no range, so the verdict of a match is `unknown`. */
export const MAX_RANGES = 50;

/** The fields of `product_status` that give the affected products. */
export const AFFECTED_STATUS: readonly string[] = ["known_affected", "first_affected", "last_affected"];

/** One affected package of an advisory: the subject of the system `purl` that the map gives. */
export interface ProductPackage {
  /** The canonical purl with no version, qualifiers or subpath. */
  readonly purl: string;
  /** The ranges of the affected versions. A package with no field `ranges` has no known range. */
  readonly ranges?: readonly string[];
}

/** The affected packages of a document, and the count of the packages that the body leaves out. */
export interface AffectedPackages {
  readonly packages: readonly ProductPackage[];
  readonly cut: number;
}

/** One product of the tree: its purl with no version, and the range of its version, when it has one. */
interface Product {
  readonly purl: string;
  readonly range?: string;
}

const text = (fields: unknown, name: string): string | undefined => (isRecord(fields) && typeof fields[name] === "string" ? fields[name] : undefined);
const records = (fields: unknown, name: string): readonly Fields[] => (isRecord(fields) && Array.isArray(fields[name]) ? fields[name].filter(isRecord) : []);
const texts = (fields: unknown, name: string): readonly string[] => (isRecord(fields) && Array.isArray(fields[name]) ? fields[name].filter((value) => typeof value === "string") : []);

/**
 * This function gives the `vers` text of the version of a product. A `vers` text stays as it is, in its canonical form.
 * A range with no `vers:` prefix, for example `<=V6.80`, gets the scheme of the purl. A text that is not a range gives
 * `undefined`.
 */
export function rangeOf(scheme: string, version: string | undefined, range: string | undefined): string | undefined {
  if (range !== undefined) {
    const trimmed = range.trim();
    const vers = trimmed.startsWith("vers:") ? parseVers(trimmed) : /^[<>=!]/.test(trimmed) ? parseVers(`vers:${scheme}/${trimmed}`) : undefined;
    return vers === undefined ? undefined : formatVers(vers);
  }
  if (version === undefined || version.trim() === "") return undefined;
  return formatVers({ scheme, all: false, constraints: [{ comparator: "=", version: version.trim() }] });
}

/** The names of the branches above a product: the vendor, the product name, the version and the range. */
interface Chain {
  readonly vendor?: string;
  readonly name?: string;
  readonly version?: string;
  readonly range?: string;
}

/** This function gives the chain of a branch, from the chain of its parent. */
function chainOf(parent: Chain, branch: Fields): Chain {
  const name = text(branch, "name")?.trim();
  if (name === undefined || name === "") return parent;
  switch (branch["category"]) {
    case "vendor":
      return { ...parent, vendor: name };
    case "product_name":
      return { ...parent, name };
    case "product_version":
      return { ...parent, version: name };
    case "product_version_range":
      return { ...parent, range: name };
    default:
      return parent;
  }
}

/** This function gives the product of a leaf of the tree, or `undefined` when the leaf has no purl and no names. */
function productOf(product: unknown, chain: Chain): Product | undefined {
  const helper = isRecord(product) ? product["product_identification_helper"] : undefined;
  const given = text(helper, "purl");
  const parsed = given === undefined ? undefined : parsePurl(given);
  if (given !== undefined && parsed !== undefined) {
    const purl = packagePurlOf(given);
    if (purl === undefined) return undefined;
    const range = rangeOf(parsed.type, parsed.version ?? chain.version, parsed.version === undefined ? chain.range : undefined);
    return { purl, ...(range === undefined ? {} : { range }) };
  }
  if (chain.vendor === undefined || chain.name === undefined) return undefined;
  const purl = formatPurl({ type: "generic", namespace: chain.vendor.toLowerCase(), name: chain.name.toLowerCase() });
  if (purl === undefined) return undefined;
  const range = rangeOf("generic", chain.version, chain.range);
  return { purl, ...(range === undefined ? {} : { range }) };
}

/** This function gives the product of each product id of a product tree. */
export function productsOf(tree: unknown): ReadonlyMap<string, Product> {
  const products = new Map<string, Product>();
  // The walk keeps a stack, not a recursion: a deep tree does not exhaust the stack of the call.
  const stack: { readonly branch: Fields; readonly chain: Chain }[] = records(tree, "branches").map((branch) => ({ branch, chain: {} }));
  while (stack.length > 0) {
    const { branch, chain } = stack.pop()!;
    const next = chainOf(chain, branch);
    const id = text(branch["product"], "product_id");
    if (id !== undefined) {
      const product = productOf(branch["product"], next);
      if (product !== undefined) products.set(id, product);
    }
    for (const child of records(branch, "branches")) stack.push({ branch: child, chain: next });
  }
  for (const full of records(tree, "full_product_names")) {
    const id = text(full, "product_id");
    const product = productOf(full, {});
    if (id !== undefined && product !== undefined && !products.has(id)) products.set(id, product);
  }
  // A relationship gives a new product id, for example a component on a platform. Its package is the component.
  for (const relationship of records(tree, "relationships")) {
    const id = text(relationship["full_product_name"], "product_id");
    const component = products.get(text(relationship, "product_reference") ?? "");
    if (id !== undefined && component !== undefined && !products.has(id)) products.set(id, component);
  }
  return products;
}

/**
 * This function gives the affected packages of a document: the products of the affected status of each vulnerability.
 * The packages come in the order of their purls. A package with a product of no known range gives one more package
 * with no ranges. Thus the verdict of a version out of the known ranges is `unknown`, not "not affected".
 */
export function affectedPackages(tree: unknown, vulnerabilities: readonly Fields[]): AffectedPackages {
  const products = productsOf(tree);
  const ranges = new Map<string, Set<string>>();
  const unranged = new Set<string>();
  for (const vulnerability of vulnerabilities) {
    const status = vulnerability["product_status"];
    for (const field of AFFECTED_STATUS) {
      for (const id of texts(status, field)) {
        const product = products.get(id);
        if (product === undefined) continue;
        if (product.range === undefined) unranged.add(product.purl);
        else ranges.set(product.purl, (ranges.get(product.purl) ?? new Set()).add(product.range));
      }
    }
  }
  const packages: ProductPackage[] = [];
  for (const purl of [...new Set([...ranges.keys(), ...unranged])].sort()) {
    const list = [...(ranges.get(purl) ?? [])].sort();
    if (list.length > 0 && list.length <= MAX_RANGES) packages.push({ purl, ranges: list });
    if (unranged.has(purl) || list.length > MAX_RANGES) packages.push({ purl });
  }
  return { packages: packages.slice(0, MAX_PACKAGES), cut: Math.max(0, packages.length - MAX_PACKAGES) };
}
