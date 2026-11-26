/**
 * The affected packages of a CSAF document: the products of its product tree that a vulnerability gives as affected.
 * Each package is a purl with no version and the ranges of its affected versions, as `vers` texts. The map gives each
 * package as a subject of the system `purl`. Thus the match of the core finds the parts of a stack with an affected version.
 *
 * A product with a purl in its `product_identification_helper` gives that purl. The products of vendors often have no
 * purl: a vendor branch and a product name branch name them. Such a product gives a purl of the type `generic`. The
 * vendor is the namespace and the product name is the name, in lower case. For example, the product `ACF5000 LCS` of the
 * vendor `ABB` gives `pkg:generic/abb/acf5000%20lcs`.
 *
 * A product with a CPE name in its helper also gives the product of that name, as a subject of the system `cpe`. The
 * version of the name, or else the version branch above it, gives the range.
 *
 * A product with model numbers in its helper and a vendor branch above it gives each pattern as a subject of the
 * system `model`. The version branch above it gives the range.
 */

import { cpeProductOf, cpeVersionOf, formatPurl, formatVers, packagePurlOf, parseCpe, parsePurl, parseVers } from "@mark1russell7/package-id";
import { modelSubjectId } from "@mark1russell7/alerts";
import { isRecord, type Fields } from "@mark1russell7/optional/read";

/** The most packages of one advisory body, the most CPE products and the most model numbers. */
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

/** One affected CPE product of an advisory: the subject of the system `cpe` that the map gives. */
export interface ProductCpe {
  /** The product of the CPE name, from `cpeProductOf`: each attribute after the product is `*`. */
  readonly cpe: string;
  /** The ranges of the affected versions. A product with no field `ranges` has no known range. */
  readonly ranges?: readonly string[];
}

/** One affected model number pattern of an advisory: the subject of the system `model` that the map gives. */
export interface ProductModel {
  /** The id of the subject, from `modelSubjectId`: the vendor, a slash and the pattern. */
  readonly model: string;
  /** The ranges of the affected versions. A pattern with no field `ranges` has no known range. */
  readonly ranges?: readonly string[];
}

/** The affected packages, CPE products and model numbers of a document, and the count of the items that the body leaves out. */
export interface AffectedPackages {
  readonly packages: readonly ProductPackage[];
  readonly cpes: readonly ProductCpe[];
  readonly models: readonly ProductModel[];
  readonly cut: number;
}

/** One identity of a product: a purl or a CPE product, and the range of its version, when it has one. */
export interface ProductIdentity {
  readonly id: string;
  readonly range?: string;
}

/** One product of the tree: its purl, its CPE product and its model number patterns, when it has them. */
export interface Product {
  readonly purl?: ProductIdentity;
  readonly cpe?: ProductIdentity;
  readonly models?: readonly ProductIdentity[];
}

const text = (fields: unknown, name: string): string | undefined => (isRecord(fields) && typeof fields[name] === "string" ? fields[name] : undefined);
const records = (fields: unknown, name: string): readonly Fields[] => (isRecord(fields) && Array.isArray(fields[name]) ? fields[name].filter(isRecord) : []);
const texts = (fields: unknown, name: string): readonly string[] => (isRecord(fields) && Array.isArray(fields[name]) ? fields[name].filter((value) => typeof value === "string") : []);
const identity = (id: string, range: string | undefined): ProductIdentity => ({ id, ...(range === undefined ? {} : { range }) });

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

/** This function gives the purl of a product: the purl of its helper, or else a generic purl from the chain. */
function purlOf(helper: unknown, chain: Chain): ProductIdentity | undefined {
  const given = text(helper, "purl");
  const parsed = given === undefined ? undefined : parsePurl(given);
  if (given !== undefined && parsed !== undefined) {
    const purl = packagePurlOf(given);
    if (purl === undefined) return undefined;
    return identity(purl, rangeOf(parsed.type, parsed.version ?? chain.version, parsed.version === undefined ? chain.range : undefined));
  }
  if (chain.vendor === undefined || chain.name === undefined) return undefined;
  const purl = formatPurl({ type: "generic", namespace: chain.vendor.toLowerCase(), name: chain.name.toLowerCase() });
  return purl === undefined ? undefined : identity(purl, rangeOf("generic", chain.version, chain.range));
}

/** This function gives the CPE product of the helper of a product, with the range of the version of the name or of the chain. */
function cpeOf(helper: unknown, chain: Chain): ProductIdentity | undefined {
  const given = text(helper, "cpe");
  const name = given === undefined ? undefined : parseCpe(given);
  const product = given === undefined ? undefined : cpeProductOf(given);
  if (name === undefined || product === undefined) return undefined;
  const version = cpeVersionOf(name);
  return identity(product, rangeOf("generic", version ?? chain.version, version === undefined ? chain.range : undefined));
}

/** This function gives the model number patterns of the helper of a product, under the vendor of the chain. */
function modelsOf(helper: unknown, chain: Chain): readonly ProductIdentity[] {
  const vendor = chain.vendor;
  if (vendor === undefined) return [];
  const range = rangeOf("generic", chain.version, chain.range);
  const patterns = texts(helper, "model_numbers").filter((pattern) => pattern.trim() !== "");
  return [...new Set(patterns)].map((pattern) => identity(modelSubjectId(vendor, pattern), range));
}

/** This function gives the product of a leaf of the tree, or `undefined` when the leaf has no identity. */
function productOf(product: unknown, chain: Chain): Product | undefined {
  const helper = isRecord(product) ? product["product_identification_helper"] : undefined;
  const purl = purlOf(helper, chain);
  const cpe = cpeOf(helper, chain);
  const models = modelsOf(helper, chain);
  if (purl === undefined && cpe === undefined && models.length === 0) return undefined;
  return { ...(purl === undefined ? {} : { purl }), ...(cpe === undefined ? {} : { cpe }), ...(models.length === 0 ? {} : { models }) };
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

/** The ranges of each id, and the ids with a product of no known range. */
class RangeTable {
  private readonly ranges = new Map<string, Set<string>>();
  private readonly unranged = new Set<string>();

  add(item: ProductIdentity): void {
    if (item.range === undefined) this.unranged.add(item.id);
    else this.ranges.set(item.id, (this.ranges.get(item.id) ?? new Set()).add(item.range));
  }

  /**
   * This method gives the items in the order of their ids. An id with a product of no known range gives one more item
   * with no ranges. Thus the verdict of a version out of the known ranges is `unknown`, not "not affected".
   */
  list(): readonly { readonly id: string; readonly ranges?: readonly string[] }[] {
    const items: { readonly id: string; readonly ranges?: readonly string[] }[] = [];
    for (const id of [...new Set([...this.ranges.keys(), ...this.unranged])].sort()) {
      const list = [...(this.ranges.get(id) ?? [])].sort();
      if (list.length > 0 && list.length <= MAX_RANGES) items.push({ id, ranges: list });
      if (this.unranged.has(id) || list.length > MAX_RANGES) items.push({ id });
    }
    return items;
  }
}

/** This function gives the affected packages, CPE products and model numbers of a document: the products of the affected status of each vulnerability. */
export function affectedPackages(tree: unknown, vulnerabilities: readonly Fields[]): AffectedPackages {
  const products = productsOf(tree);
  const purls = new RangeTable();
  const cpes = new RangeTable();
  const models = new RangeTable();
  for (const vulnerability of vulnerabilities) {
    const status = vulnerability["product_status"];
    for (const field of AFFECTED_STATUS) {
      for (const id of texts(status, field)) {
        const product = products.get(id);
        if (product?.purl !== undefined) purls.add(product.purl);
        if (product?.cpe !== undefined) cpes.add(product.cpe);
        for (const model of product?.models ?? []) models.add(model);
      }
    }
  }
  const packages = purls.list().map(({ id, ranges }) => ({ purl: id, ...(ranges === undefined ? {} : { ranges }) }));
  const cpeList = cpes.list().map(({ id, ranges }) => ({ cpe: id, ...(ranges === undefined ? {} : { ranges }) }));
  const modelList = models.list().map(({ id, ranges }) => ({ model: id, ...(ranges === undefined ? {} : { ranges }) }));
  const cut = [packages, cpeList, modelList].reduce((sum, list) => sum + Math.max(0, list.length - MAX_PACKAGES), 0);
  return { packages: packages.slice(0, MAX_PACKAGES), cpes: cpeList.slice(0, MAX_PACKAGES), models: modelList.slice(0, MAX_PACKAGES), cut };
}
