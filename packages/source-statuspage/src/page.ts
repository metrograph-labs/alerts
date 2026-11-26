/**
 * The config of one status page: its base URL, its service, the kind of its reports and the facts of its source. The
 * register of this package names well-known pages. The config of an instance can name other pages.
 */

import { knownKind, SUBJECT_SYSTEMS, subjectNode, type Duration, type NodeKey, type SourceId, type Subject, type SubjectKey, type SubjectSystem } from "@mark1russell7/alerts";

/**
 * The key of one component of a service: the subject of the component. The subject is the domain of the endpoint that
 * the component serves (`endpointKey`), or the path of a region and a product (`regionKey`). A key names the endpoint or
 * the path, not the company. Thus an outage of the video of a service does not go to a person who watches only its calls.
 */
export interface ComponentKey {
  /** The id of a component, or of a group of components, on the page. A key of a group applies to each component of the group. */
  readonly id: string;
  /** The name of the component or of the group, for a person who reads the config, for example `Programmable Messaging`. */
  readonly name: string;
  /**
   * The subject of the component, for example `domain:api.twilio.com` or `provider-region:twilio/europe/sms`. Each report
   * of the component names it. Two keys can have one id and different subjects: then the component gives two subjects.
   */
  readonly subject: SubjectKey;
}

/**
 * The formats of a page. `statuspage` is the summary API of Atlassian Statuspage, and incident.io gives the same format.
 * `incident-list` is the list of the latest incidents of that API (`/api/v2/incidents.json`), for a page whose summary
 * has no list of incidents. `statusiq` is the RSS feed of the components of a page of Site24x7 StatusIQ.
 */
export const PAGE_FORMATS = ["statuspage", "incident-list", "statusiq"] as const;

/** The format of a page: one of `PAGE_FORMATS`. */
export type PageFormat = (typeof PAGE_FORMATS)[number];

/** The config of one status page. */
export interface StatusPage {
  /** The id of the source of the page, for example `statuspage-github`. */
  readonly id: SourceId;
  /** The plain name of the service, for example `GitHub`. */
  readonly title: string;
  /** The base URL of the page: `https:`, a host and no path, for example `https://www.githubstatus.com`. */
  readonly base: string;
  /** The company of the service: the origin of each report, for example `github`. */
  readonly origin: string;
  /** The main domain of the service, for example `github.com`. Each report names it as its subject. */
  readonly domain: string;
  /** The taxonomy code of each report of the page, for example `infra.saas.outage`. */
  readonly kind: string;
  /** The failure domains outside the cell, with their prefixes, for example `provider:atlassian-statuspage`. */
  readonly dependsOn: readonly string[];
  /** The time between two fetches. The default is `DEFAULT_INTERVAL`. */
  readonly interval?: Duration;
  /** The longest normal time of one fetch. The default is `DEFAULT_SLOW_AFTER`. */
  readonly slowAfter?: Duration;
  /** The keys of the components with a subject of their own. The default is no key: each report names only the domain of the service. */
  readonly components?: readonly ComponentKey[];
  /** The format of the page. The default is `statuspage`. */
  readonly format?: PageFormat;
}

/** The default time between two fetches of a page: two minutes. The pages of Statuspage keep an answer in a cache for 10 seconds. */
export const DEFAULT_INTERVAL: Duration = 120_000;

/** The default longest normal time of one fetch. The summary of a large page is 230 KB. */
export const DEFAULT_SLOW_AFTER: Duration = 15_000;

/**
 * The system of the subject of each report: `domain`, with the domain of the service as its id. The core gives the
 * subject the node `domain:<id>` of an interest graph. Thus a person who names the service gets the report.
 */
export const SUBJECT_SYSTEM: SubjectSystem = "domain";

/**
 * The system of the path of a region and a product of a service, for example `twilio/europe/sms`. In the core, a path
 * covers each path below it (`nodeCovers`). Thus a person who watches `twilio/europe` gets an outage of `twilio/europe/sms`.
 */
export const REGION_SYSTEM: SubjectSystem = "provider-region";

/** The form of a path: two or more parts of lower-case letters, digits and single hyphens, with a `/` between two parts. */
export const PATH_PATTERN: RegExp = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

/** This function gives the key of a component that serves the endpoint `domain`, for example `api.twilio.com`. */
export function endpointKey(id: string, name: string, domain: string): ComponentKey {
  return { id, name, subject: { system: SUBJECT_SYSTEM, id: domain } };
}

/** This function gives the key of a component of one region and one product, with its path, for example `twilio/europe/sms`. */
export function regionKey(id: string, name: string, path: string): ComponentKey {
  return { id, name, subject: { system: REGION_SYSTEM, id: path } };
}

/**
 * This function tells if a URL is a base URL of a page. A base URL has `https:` and a host. It has no user, port, path,
 * query or fragment.
 */
export function isPageBase(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" && parsed.port === "" && parsed.origin === url;
}

/** This function tells if a text is a domain name in lower case, with two or more labels, for example `github.com`. */
export function isDomain(text: string): boolean {
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(text);
}

/**
 * This function gives the subjects of a page: the domain of the service, then the subject of each key of a component.
 * No subject is in the list twice. A person who watches one of these subjects gets the reports of the page that name it.
 */
export function pageSubjects(page: Pick<StatusPage, "domain" | "components">): readonly SubjectKey[] {
  const all = [{ system: SUBJECT_SYSTEM, id: page.domain }, ...(page.components ?? []).map((key) => key.subject)];
  const nodes = all.map(subjectNode);
  return all.filter((_subject, index) => nodes.indexOf(nodes[index]!) === index);
}

/**
 * This function gives the subjects of a report of a page. The first subject is the domain of the service. Then each
 * other subject of the keys of the report is one subject, in the order of the keys. Its label names its components.
 */
export function subjectsOf(page: Pick<StatusPage, "title" | "domain">, keys: readonly ComponentKey[]): readonly Subject[] {
  const service = subjectNode({ system: SUBJECT_SYSTEM, id: page.domain });
  const groups = new Map<NodeKey, { readonly subject: SubjectKey; readonly names: string[] }>();
  for (const key of keys) {
    const node = subjectNode(key.subject);
    if (node === service) continue;
    const group = groups.get(node) ?? { subject: key.subject, names: [] };
    if (!group.names.includes(key.name)) group.names.push(key.name);
    groups.set(node, group);
  }
  return [
    { system: SUBJECT_SYSTEM, id: page.domain, label: page.title },
    ...[...groups.values()].map(({ subject, names }) => ({ system: subject.system, id: subject.id, label: `${page.title}: ${names.join(", ")}` })),
  ];
}

/** This function gives the problem of the subject of a key, or `undefined` for a good subject. */
function subjectProblem(key: ComponentKey, page: Pick<StatusPage, "domain">): string | undefined {
  const { system, id } = key.subject;
  if (!Object.hasOwn(SUBJECT_SYSTEMS, system) || SUBJECT_SYSTEMS[system as SubjectSystem] !== "entity") {
    return `the subject system ${JSON.stringify(system)} of the component ${JSON.stringify(key.id)} is not a system of entities`;
  }
  if (system === SUBJECT_SYSTEM) {
    if (!isDomain(id)) return `the domain ${JSON.stringify(id)} of a component is not a domain name in lower case`;
    // The domain of the service is the subject of each report already. A key with it changes nothing.
    if (id === page.domain) return `the key of the component ${JSON.stringify(key.id)} gives the domain of the service`;
    return undefined;
  }
  if (system === REGION_SYSTEM) return PATH_PATTERN.test(id) ? undefined : `the path ${JSON.stringify(id)} of a component is not two or more lower-case parts with a / between two parts`;
  return id.trim() === "" || id.trim() !== id ? `the subject of the component ${JSON.stringify(key.id)} has an empty id, or spaces at an end of its id` : undefined;
}

/** This function examines the config of a page. It gives one text for each problem, and an empty list for a good config. A text holds no URL. */
export function pageProblems(page: StatusPage): readonly string[] {
  const problems: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]*$/.test(page.id)) problems.push("the id is not lower-case letters, digits and hyphens");
  if (page.title.trim() === "") problems.push("the title is empty");
  // A problem text holds no URL of the config: a URL can hold a password.
  if (!isPageBase(page.base)) problems.push("the base is not an https URL with only a host, for example https://status.example.com");
  if (page.origin.trim() === "") problems.push("the origin is empty");
  if (page.format !== undefined && !(PAGE_FORMATS as readonly string[]).includes(page.format)) problems.push(`the format ${JSON.stringify(page.format)} is not a format of a page`);
  if (!isDomain(page.domain)) problems.push(`the domain ${JSON.stringify(page.domain)} is not a domain name in lower case`);
  if (!knownKind(page.kind)) problems.push(`the kind ${JSON.stringify(page.kind)} is not a code of the taxonomy`);
  if (page.dependsOn.length === 0) problems.push("the list of failure domains is empty");
  for (const domain of page.dependsOn) if (!/^[a-z]+:[a-z0-9.-]+$/.test(domain)) problems.push(`the failure domain ${JSON.stringify(domain)} is not a kind, a colon and an id`);
  // One id with two subjects is correct: the component gives two subjects. One id with the same subject twice is an error.
  const seen = new Set<string>();
  for (const key of page.components ?? []) {
    const pair = `${key.id} ${subjectNode(key.subject)}`;
    if (key.id.trim() === "") problems.push("a key of a component has no id");
    else if (seen.has(pair)) problems.push(`the component ${JSON.stringify(key.id)} has two keys with one subject`);
    seen.add(pair);
    if (key.name.trim() === "") problems.push(`the key of the component ${JSON.stringify(key.id)} has no name`);
    const problem = subjectProblem(key, page);
    if (problem !== undefined) problems.push(problem);
  }
  for (const [name, value] of [
    ["interval", page.interval],
    ["slowAfter", page.slowAfter],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1000)) problems.push(`the ${name} is not an integer of 1000 or more milliseconds: ${String(value)}`);
  }
  return problems;
}
