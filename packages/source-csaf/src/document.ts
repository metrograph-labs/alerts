/**
 * The reader of a CSAF 2.0 document. It keeps only the fields that the map uses, in a fixed order. Thus a new field of
 * a document does not change the id of its observation. A large product tree does not go into the log.
 */

import { isRecord, type Fields } from "@mark1russell7/optional/read";

import { affectedPackages, type ProductCpe, type ProductModel, type ProductPackage } from "./products.ts";

/** The TLP labels of a document that the source keeps: the labels for sharing with no limit. */
export const SHARED_LABELS: ReadonlySet<string> = new Set(["CLEAR", "WHITE"]);

/** The most product names of one advisory body. */
export const MAX_PRODUCTS = 12;

/** The most flaws of one advisory body. */
export const MAX_FLAWS = 50;

/** The most characters of the summary of one advisory body. */
export const MAX_SUMMARY = 1200;

/** One flaw of an advisory. */
export interface Flaw {
  /** The CVE id, when the advisory gives one. */
  readonly cve?: string;
  /** The highest CVSS 3 base score of the flaw. */
  readonly score?: number;
  /** The CWE id of the flaw, for example `CWE-787`. */
  readonly cwe?: string;
}

/** The body of the observation of one advisory. */
export interface AdvisoryBody {
  /** The URL of the document. */
  readonly url: string;
  /** The URL of the page of the advisory for a person: the first reference `self` that is not a JSON file. */
  readonly page?: string;
  readonly id: string;
  readonly version: string;
  /** The status of the document: `final`, `interim` or `draft`. */
  readonly status: string;
  /** The count of the entries of the revision history. */
  readonly revisions: number;
  readonly initial: string;
  readonly current: string;
  readonly title: string;
  readonly publisher: string;
  readonly tlp: string;
  /** The text of `aggregate_severity`, when the document gives it. */
  readonly severity?: string;
  readonly summary?: string;
  readonly flaws: readonly Flaw[];
  /** The names of the products, at most `MAX_PRODUCTS`. */
  readonly products: readonly string[];
  /** True: a remediation of the category `vendor_fix` is in the document. */
  readonly fix: boolean;
  /** The affected packages, with the ranges of their versions. The body has the field only when the list is not empty. */
  readonly packages?: readonly ProductPackage[];
  /** The affected CPE products, with the ranges of their versions. The body has the field only when the list is not empty. */
  readonly cpes?: readonly ProductCpe[];
  /** The affected model number patterns, with the ranges of their versions. The body has the field only when the list is not empty. */
  readonly models?: readonly ProductModel[];
  /** The count of the affected packages and CPE products above `MAX_PACKAGES` that the body leaves out. */
  readonly packagesCut?: number;
}

/**
 * The body of an observation of a document that the source does not keep. The reason `label` is a document that is not
 * for sharing: the map gives a note. The reason `format` is a document that the reader does not understand: the map gives a fatal problem.
 */
export interface RefusedBody {
  readonly url: string;
  readonly refused: "label" | "format";
  readonly message: string;
}

/** This function gives the text of a field, or `undefined`. */
const text = (fields: unknown, name: string): string | undefined => (isRecord(fields) && typeof fields[name] === "string" ? fields[name] : undefined);

/** This function gives the records of a list field. */
const records = (fields: unknown, name: string): readonly Fields[] => (isRecord(fields) && Array.isArray(fields[name]) ? fields[name].filter(isRecord) : []);

/** This function gives the names of the products of a product tree: the full product names, then the leaves of the branches. */
export function productNames(tree: unknown): readonly string[] {
  const names = new Set<string>();
  for (const product of records(tree, "full_product_names")) {
    const name = text(product, "name");
    if (name !== undefined) names.add(name);
  }
  // The walk keeps a stack, not a recursion: a deep tree does not exhaust the stack of the call.
  const stack = [...records(tree, "branches")];
  while (stack.length > 0 && names.size < MAX_PRODUCTS) {
    const branch = stack.shift()!;
    const name = text(branch["product"], "name");
    if (name !== undefined) names.add(name);
    stack.push(...records(branch, "branches"));
  }
  return [...names].slice(0, MAX_PRODUCTS);
}

/** This function gives the flaws of the vulnerabilities of a document. */
export function flawsOf(vulnerabilities: readonly Fields[]): readonly Flaw[] {
  return vulnerabilities.slice(0, MAX_FLAWS).map((vulnerability) => {
    const scores = records(vulnerability, "scores").flatMap((score) => {
      const cvss = score["cvss_v3"];
      return isRecord(cvss) && typeof cvss["baseScore"] === "number" ? [cvss["baseScore"]] : [];
    });
    const cve = text(vulnerability, "cve");
    const cwe = text(vulnerability["cwe"], "id");
    return { ...(cve === undefined ? {} : { cve }), ...(scores.length === 0 ? {} : { score: Math.max(...scores) }), ...(cwe === undefined ? {} : { cwe }) };
  });
}

/**
 * This function reads the text of a CSAF document at the URL `url`. A document with the fields of tracking and a title
 * gives its body. A document whose TLP label is not `CLEAR` or `WHITE` gives a refused body: the source does not share it.
 * A text that is not a CSAF document gives a refused body too.
 */
export function readAdvisory(source: string, url: string): AdvisoryBody | RefusedBody {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return { url, refused: "format", message: "the document is not JSON" };
  }
  const document = isRecord(value) ? value["document"] : undefined;
  const tracking = isRecord(document) ? document["tracking"] : undefined;
  const id = text(tracking, "id");
  const version = text(tracking, "version");
  const initial = text(tracking, "initial_release_date");
  const current = text(tracking, "current_release_date");
  const title = text(document, "title");
  if (id === undefined || version === undefined || initial === undefined || current === undefined || title === undefined) {
    return { url, refused: "format", message: "the document has no tracking id, version, release dates or title: it is not a CSAF document" };
  }
  if (!Number.isFinite(Date.parse(initial)) || !Number.isFinite(Date.parse(current))) return { url, refused: "format", message: `the release dates of ${id} are not valid times` };
  const distribution = isRecord(document) ? document["distribution"] : undefined;
  const tlp = (text(isRecord(distribution) ? distribution["tlp"] : undefined, "label") ?? "").toUpperCase();
  if (!SHARED_LABELS.has(tlp)) return { url, refused: "label", message: `the TLP label of ${id} is ${tlp === "" ? "absent" : tlp}: the source keeps only TLP:CLEAR` };
  const severity = text(isRecord(document) ? document["aggregate_severity"] : undefined, "text");
  const notes = records(document, "notes");
  const summary = notes.find((note) => note["category"] === "summary") ?? notes.find((note) => note["category"] === "description");
  const summaryText = text(summary, "text")?.trim();
  const vulnerabilities = isRecord(value) ? records(value, "vulnerabilities") : [];
  const isPage = (url: string | undefined): url is string => url !== undefined && url.startsWith("https://") && !url.toLowerCase().endsWith(".json");
  const pageUrl = records(document, "references")
    .filter((reference) => reference["category"] === "self")
    .map((reference) => text(reference, "url"))
    .find(isPage);
  const affected = affectedPackages(isRecord(value) ? value["product_tree"] : undefined, vulnerabilities);
  const fix = vulnerabilities.some((vulnerability) => records(vulnerability, "remediations").some((remediation) => remediation["category"] === "vendor_fix"));
  return {
    url,
    ...(pageUrl === undefined ? {} : { page: pageUrl }),
    id,
    version,
    status: text(tracking, "status") ?? "",
    revisions: records(tracking, "revision_history").length,
    initial,
    current,
    title: title.trim(),
    publisher: text(isRecord(document) ? document["publisher"] : undefined, "name") ?? "",
    tlp,
    ...(severity === undefined ? {} : { severity }),
    ...(summaryText === undefined || summaryText === "" ? {} : { summary: summaryText.slice(0, MAX_SUMMARY) }),
    flaws: flawsOf(vulnerabilities),
    products: productNames(isRecord(value) ? value["product_tree"] : undefined),
    fix,
    ...(affected.packages.length === 0 ? {} : { packages: affected.packages }),
    ...(affected.cpes.length === 0 ? {} : { cpes: affected.cpes }),
    ...(affected.models.length === 0 ? {} : { models: affected.models }),
    ...(affected.cut === 0 ? {} : { packagesCut: affected.cut }),
  };
}
