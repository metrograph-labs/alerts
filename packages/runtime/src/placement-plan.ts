/**
 * This file gives the front of the placement of the copies from the live offers (AL-53, `placement.ts`). It reads the
 * plan list of each provider record of `@mark1russell7/market-sources` and the Azure prices of some sizes of virtual
 * machine. It also reads the incident history of the status page of each provider. It reads no other source and opens
 * no account.
 *
 * `node src/placement-plan.ts --min-memory-mib <n> --assume-provider <p> --assume-region <p> (--assume-host <p> | --host-own <copy>) [--fixed <copy,copy>] [--assume-site <p>] [--assume-country <p>] [--site-log <site=file,site=file>] [--log-window <site=from/to,site=from/to>] [--base <file>] [--joint <file>] [--causes <file>] [--copies <n>] [--spend <provider>] [--terms <kind,kind>] [--window-days <n>] [--azure-sizes <n>]`
 *
 * - `--min-memory-mib` is the least memory of a host of a copy, in MiB.
 * - The three `--assume-*` values are assumed chance inputs, from 0 to 1, for each provider, region and host. The script
 *   reads the incident history of the status page of each provider of `HISTORY_SOURCES` (`placement-chances.ts`). It
 *   gives a measured input to each provider and region with a history. Only the other fragments and the hosts get the
 *   assumed inputs. The output marks each input as measured or assumed.
 * - Each row of the front names its shared fragments with an assumed input. A second front, `measured`, uses only the
 *   candidates with measured inputs.
 * - `--window-days` is the length of the window of the history, in days. The default is `DEFAULT_WINDOW_DAYS` (365).
 * - `--fixed` names the live copies, with commas between them. A name `provider/region` is a copy at a provider. A
 *   name with no slash is a copy at a site, for example a home computer. Each is a fixed slot with no cost. The front
 *   then gives the gain of each next copy beside them. The names go only to the private front file.
 * - A name of `--fixed` can end with `@` and the code of its country (ISO 3166-1 alpha-2), for example `home@NL`. A
 *   copy at a provider with no code gets the country of the offers of its region.
 * - `--assume-site` is the assumed chance input of each site of a fixed copy. A fixed copy at a site needs it.
 * - `--assume-country` is the assumed chance input of each country. With it, each copy with a known country needs the
 *   shared fragment of its country. Thus two copies in one country share its grid, its network and its law. A copy
 *   with no known country has no such fragment. The output counts these copies. Without it, no copy has a country
 *   fragment.
 * - The country input is always assumed. Thus with it, the front of measured inputs has no row.
 * - `--site-log` names a copy of the runtime log of the live copy at each site, as `site=file` with commas between
 *   them. The gaps of its fetch events give a measured chance of the site (`measureSite` of `placement-chances.ts`).
 *   This input replaces `--assume-site` for that site. The calls of the channels in these logs also measure each chance
 *   of the base that names a channel (`measureBaseCalls` of `placement-chances.ts`).
 * - `--log-window` gives the window of a site log, as `site=from/to` with commas between them (AL-215). Each end is
 *   an ISO 8601 time, and each end can be empty. Only the fetches and the calls in the window count. Use the start to
 *   leave out a fault before its fix. Use the end of a copy of a log: else the time after the copy is a down time. The
 *   output tells when a log ends more than `FETCH_GAP_MS` before the end of its window.
 * - `--host-own` names a live copy of `--fixed`. Its own part in the fit of `--joint` is the host input of each new
 *   copy, in place of `--assume-host` (AL-215). A new copy has the deploys and the code of the live copies. The input
 *   is measured when the joint inputs of that copy are measured. The own part of a copy at a provider also holds the
 *   down time of its provider and region. Thus the input can be low, but it is not high.
 * - `--base` names a private JSON file with the function and the needs that all copies share (`readBase` of
 *   `placement.ts`). These needs limit the gain of each copy. The output names each of their inputs that is assumed or
 *   missing. A chance of the base can name the status page of its part (`status`). The script then measures the input
 *   from the history of that page (`measureBase` of `placement-chances.ts`), and prints one line for each input.
 * - `--joint` names a private JSON file with the joint measure of the live copies (`readJoint` of `placement.ts`), in the
 *   order of `--fixed`. The fit gives a common cause that each copy needs, thus a new copy is not an independent copy.
 * - `--causes` names a private JSON file with the shared causes of the copies (`readCauses` of `placement.ts`, AL-198).
 *   The file gives the DNS provider, the registrar and the power feed of each copy, and their chance inputs. Two copies
 *   with one cause share its fragment. A name of its field `fixed` is a name of `--fixed` with no country code.
 * - `--copies` is the count of new copies. The default is 2.
 * - `--spend` names the spend entry of `config.json` that gives the limit of cost of a month (`monthlyUsd`). Without
 *   it, or without that entry, the front has no limit of cost.
 * - `--terms` gives the price terms that fit. The default is `on-demand`.
 * - `--azure-sizes` is the count of Azure sizes to read (`azureSizesFor` of `placement.ts`). The default is
 *   `AZURE_SIZES` (8). The value 0 reads no Azure price. The script keeps only the Linux offers.
 *
 * It prints the front, and writes it to the file `placement-front.json` in the private folder with the mode 0o600.
 * The environment gives `ALERTS_HOME`, as for `main.ts`. The exit code is 0 for a front, 1 for a failed read and 2
 * for a wrong command.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MeteredObservation, PriceTerm } from "@mark1russell7/market";
import { AZURE_SOURCE, AZURE_VM_SIZE_TABLE, createAzureClient, createPlanClient, PLAN_PROVIDERS } from "@mark1russell7/market-sources";
import { countOf, errorMessage } from "@mark1russell7/text";
import { writeFileAtomic } from "@procedures/fs/files";
import { fetchTransport } from "polite-crawler/api";
import { HostScheduler, realClock } from "polite-crawler/politeness";
import { createPrinter } from "@mark1russell7/text/print";
import { alertsHome, configPath } from "./config.ts";
import {
  DEFAULT_WINDOW_DAYS,
  FETCH_GAP_MS,
  HISTORY_GAPS,
  inLogWindow,
  HISTORY_SOURCES,
  MEASURE_USER_AGENT,
  measureBase,
  measureBaseCalls,
  measureProvider,
  measureSite,
  readChannelCalls,
  readFetchTimes,
  readLogEnd,
  readPageHistory,
  withMeasures,
  type CallRead,
  type ChanceMeasure,
  type LogWindow,
} from "./placement-chances.ts";
import {
  assumedInputs,
  azureSizesFor,
  distinctRows,
  FRONT_FILE,
  FRONT_FORMAT,
  baseAssumed,
  frontLevels,
  measuredBuild,
  jointFit,
  readBase,
  readCauses,
  readJoint,
  withCauses,
  type PlacementBase,
  type FixedCopy,
  placementLayer,
  planCopies,
  spendLimitOf,
  windowsOffer,
  type ChanceInput,
  type JointMeasure,
  type PlacementBuild,
  type PlacementChances,
} from "./placement.ts";

// The output of this command for a person goes through one printer, which removes the shapes of tokens (no raw console).
const print = createPrinter({ out: process.stdout, err: process.stderr });

const USAGE =
  "The command is: node src/placement-plan.ts --min-memory-mib <n> --assume-provider <p> --assume-region <p> (--assume-host <p> | --host-own <copy>) [--fixed <copy,copy>] [--assume-site <p>] [--assume-country <p>] [--site-log <site=file,site=file>] [--log-window <site=from/to,site=from/to>] [--base <file>] [--joint <file>] [--causes <file>] [--copies <n>] [--spend <provider>] [--terms <kind,kind>] [--window-days <n>] [--azure-sizes <n>]";

/** The User-Agent of each request. It names no person and no project. */
const USER_AGENT = "alerts-placement";

/** The count of choices of each level of the front that the output shows. The file has each choice. */
const SHOWN = 3;

/** The default count of Azure sizes that a placement reads. Each size is one read of 6 seconds or more. */
const AZURE_SIZES = 8;

const TERM_KINDS: readonly PriceTerm["kind"][] = ["on-demand", "spot", "committed"];

interface Command {
  readonly minMemoryMiB: number;
  readonly chances: Omit<PlacementChances, "host"> & { readonly host: ChanceInput | undefined };
  readonly copies: number;
  readonly fixed: readonly FixedCopy[];
  readonly base: string | undefined;
  readonly joint: string | undefined;
  readonly causes: string | undefined;
  readonly siteLogs: readonly { readonly site: string; readonly path: string; readonly window: LogWindow }[];
  /** The index in `fixed` of the live copy whose own part is the host input, or undefined for `--assume-host`. */
  readonly hostOwn: number | undefined;
  readonly spend: string | undefined;
  readonly terms: readonly PriceTerm["kind"][];
  readonly windowDays: number;
  readonly azureSizes: number;
}

// The command, or a problem of the command.
function command(args: readonly string[]): Command | string {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (name === undefined || !name.startsWith("--") || value === undefined || value.startsWith("--")) return `The argument ${String(name)} has no value.`;
    values.set(name.slice(2), value);
  }
  const known = new Set(["min-memory-mib", "assume-provider", "assume-region", "assume-host", "assume-site", "assume-country", "fixed", "site-log", "log-window", "host-own", "base", "joint", "causes", "copies", "spend", "terms", "window-days", "azure-sizes"]);
  const other = [...values.keys()].find((name) => !known.has(name));
  if (other !== undefined) return `The option --${other} is not known.`;
  const memory = Number(values.get("min-memory-mib"));
  if (!values.has("min-memory-mib") || !(memory >= 0)) return "The option --min-memory-mib needs a number of 0 or more.";
  const copies = Number(values.get("copies") ?? "2");
  if (!Number.isInteger(copies) || copies < 1) return "The option --copies needs a whole number of 1 or more.";
  const windowDays = Number(values.get("window-days") ?? String(DEFAULT_WINDOW_DAYS));
  if (!Number.isInteger(windowDays) || windowDays < 1) return "The option --window-days needs a whole number of 1 or more.";
  const azureSizes = Number(values.get("azure-sizes") ?? String(AZURE_SIZES));
  if (!Number.isInteger(azureSizes) || azureSizes < 0) return "The option --azure-sizes needs a whole number of 0 or more.";
  const assumed = (name: string): ChanceInput | string => {
    const text = values.get(`assume-${name}`);
    const works = Number(text);
    if (text === undefined || !(works >= 0 && works <= 1)) return `The option --assume-${name} needs a chance from 0 to 1.`;
    return { works, kind: "assumed", source: `the input parameter --assume-${name} of placement-plan.ts` };
  };
  const provider = assumed("provider");
  const region = assumed("region");
  if (values.has("host-own") === values.has("assume-host")) return "Name one of the options --assume-host and --host-own.";
  if (values.has("host-own") && !values.has("joint")) return "The option --host-own needs --joint.";
  const host = values.has("assume-host") ? assumed("host") : undefined;
  if (typeof provider === "string") return provider;
  if (typeof region === "string") return region;
  if (typeof host === "string") return host;
  const fixed: FixedCopy[] = [];
  for (const item of (values.get("fixed") ?? "").split(",").filter((each) => each !== "")) {
    const at = item.lastIndexOf("@");
    const name = at < 0 ? item : item.slice(0, at);
    const country = at < 0 ? undefined : item.slice(at + 1);
    if (country !== undefined && !/^[A-Z]{2}$/u.test(country)) return `The country of the fixed copy ${item} is not two capital letters.`;
    const placed = country === undefined ? {} : { country };
    const parts = name.split("/");
    if (parts.length === 1 && name !== "") fixed.push({ kind: "site", site: name, ...placed });
    else if (parts.length === 2 && parts[0] !== "" && parts[1] !== "") fixed.push({ kind: "cloud", provider: parts[0]!, region: parts[1]!, ...placed });
    else return `The fixed copy ${item} is not provider/region or a site.`;
  }
  const needsSite = fixed.some((copy) => copy.kind === "site");
  const site = values.has("assume-site") || needsSite ? assumed("site") : undefined;
  if (typeof site === "string") return site;
  const country = values.has("assume-country") ? assumed("country") : undefined;
  if (typeof country === "string") return country;
  const windows = new Map<string, LogWindow>();
  for (const item of (values.get("log-window") ?? "").split(",").filter((each) => each !== "")) {
    const window = logWindowOf(item);
    if (typeof window === "string") return window;
    windows.set(window.site, window.window);
  }
  const siteLogs: { site: string; path: string; window: LogWindow }[] = [];
  for (const item of (values.get("site-log") ?? "").split(",").filter((each) => each !== "")) {
    const cut = item.indexOf("=");
    if (cut < 1 || cut === item.length - 1) return `The site log ${item} is not site=file.`;
    const logSite = item.slice(0, cut);
    siteLogs.push({ site: logSite, path: item.slice(cut + 1), window: windows.get(logSite) ?? {} });
  }
  const unused = [...windows.keys()].find((name) => !siteLogs.some((log) => log.site === name));
  if (unused !== undefined) return `The log window of the site ${unused} has no site log.`;
  const ownName = values.get("host-own");
  const hostOwn = ownName === undefined ? undefined : fixed.findIndex((copy) => (copy.kind === "site" ? copy.site : `${copy.provider}/${copy.region}`) === ownName);
  if (hostOwn === -1) return "The option --host-own names no copy of --fixed.";
  const terms = (values.get("terms") ?? "on-demand").split(",");
  const bad = terms.find((term) => !TERM_KINDS.some((kind) => kind === term));
  if (bad !== undefined) return `The price term ${bad} is not on-demand, spot or committed.`;
  const chances = { provider, region, host, ...(site === undefined ? {} : { site }), ...(country === undefined ? {} : { country }) };
  return { minMemoryMiB: memory, chances, copies, fixed, base: values.get("base"), joint: values.get("joint"), causes: values.get("causes"), siteLogs, hostOwn, spend: values.get("spend"), terms: terms as PriceTerm["kind"][], windowDays, azureSizes };
}

// The log window of one site from `site=from/to`. Each end is an ISO 8601 time or empty.
function logWindowOf(item: string): { readonly site: string; readonly window: LogWindow } | string {
  const cut = item.indexOf("=");
  const slash = item.indexOf("/", cut + 1);
  if (cut < 1 || slash < 0) return `The log window ${item} is not site=from/to.`;
  const ends = [item.slice(cut + 1, slash), item.slice(slash + 1)].map((text) => (text === "" ? undefined : Date.parse(text)));
  const [from, to] = ends;
  if (ends.some((end) => end !== undefined && !Number.isFinite(end))) return `An end of the log window ${item} is not an ISO 8601 time.`;
  if (from !== undefined && to !== undefined && from >= to) return `The log window ${item} does not start before its end.`;
  return { site: item.slice(0, cut), window: { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) } };
}

// The front of a build: its search, its levels and the assumed fragments of each row. It prints each level.
function frontOf(build: PlacementBuild, chances: PlacementChances, today: string, title: string) {
  const plan = planCopies(build, today);
  const rows = distinctRows(plan.front);
  const levels = frontLevels(rows);
  const fixed = new Set(build.fixed);
  const candidates = build.layer.slots.find((slot) => !fixed.has(slot.id))?.candidates.length ?? 0;
  const keysOf = (row: (typeof rows)[number]): string => Object.values(row.choice).filter((value): value is string => value !== null).join(" + ");
  print.line(`${title}: ${countOf(candidates, "candidate")} for each slot. The search is ${plan.method}. The front has ${countOf(rows.length, "choice")} in ${countOf(levels.length, "level")}.`);
  for (const level of levels) {
    const shown = level.rows.slice(0, SHOWN).map(keysOf).join(", ");
    const more = level.rows.length > SHOWN ? ` and ${String(level.rows.length - SHOWN)} more` : "";
    const assumed = level.rows.filter((row) => assumedInputs(build.layer, chances, row).length > 0).length;
    print.line(`- ${level.cost.toFixed(2)} USD a month, chance ${level.chance.toFixed(9)}, ${countOf(level.rows.length, "choice")} (${String(assumed)} with an assumed input): ${shown}${more}`);
  }
  return {
    candidates,
    method: plan.method,
    breaks: plan.breaks,
    levels: levels.map((level) => ({
      cost: level.cost,
      chance: level.chance,
      choices: level.rows.map((row) => ({ choice: row.choice, sources: row.sources, bound: row.bound, importance: row.importance, assumed: row.assumed, assumedInputs: assumedInputs(build.layer, chances, row) })),
    })),
  };
}

// The record of one measure in the front file.
function measureRecord(measure: ChanceMeasure) {
  return { id: measure.input.id, works: measure.input.works, window: { from: new Date(measure.window.from).toISOString(), to: new Date(measure.window.to).toISOString() }, down: measure.down };
}

// The host input from the own part of one live copy in the fit of the joint measure (AL-215). The command checks that
// both the joint file and the copy exist. The source names no copy, because the names go only to the private front file.
function ownHost(joint: JointMeasure | undefined, index: number | undefined): ChanceInput {
  const input = index === undefined ? undefined : joint?.works[index];
  const own = index === undefined || joint === undefined ? undefined : jointFit({ provider: joint.anyWorks, region: joint.anyWorks, host: joint.anyWorks, joint })?.own[index];
  if (joint === undefined || input === undefined || own === undefined) throw new Error("The host input needs a joint measure and a live copy.");
  const kind = input.kind === "measured" && joint.anyWorks.kind === "measured" ? "measured" : "assumed";
  return { works: own, kind, source: `the own part of a live copy in the joint measure, from ${input.source}` };
}

// The calls of one channel in one site log. A log with no good read gives no call, and its site line tells the fault.
function callsOrNone(path: string, channel: string): readonly CallRead[] {
  try {
    return readChannelCalls(path, channel);
  } catch {
    return [];
  }
}

// The configuration as JSON, or undefined when the file is missing or is not JSON. Only its spend entries count.
async function readConfig(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

const parsed = command(process.argv.slice(2));

if (typeof parsed === "string") {
  print.error(`${parsed}\n${USAGE}`);
  process.exitCode = 2;
} else {
  const home = alertsHome(process.env, process.cwd());
  const costLimit = parsed.spend === undefined ? undefined : spendLimitOf(await readConfig(configPath(process.env, process.cwd())), parsed.spend);
  const baseRead = parsed.base === undefined ? undefined : readBase(await readConfig(parsed.base));
  if (typeof baseRead === "string") {
    print.error(`The base file has a problem: ${baseRead}`);
    process.exit(2);
  }
  const joint = parsed.joint === undefined ? undefined : readJoint(await readConfig(parsed.joint));
  if (typeof joint === "string") {
    print.error(`The joint file has a problem: ${joint}`);
    process.exit(2);
  }
  if (joint !== undefined && joint.works.length !== parsed.fixed.length) {
    print.error("The joint file needs one input for each copy of --fixed, in the same order.");
    process.exit(2);
  }
  const causeRead = parsed.causes === undefined ? undefined : readCauses(await readConfig(parsed.causes));
  if (typeof causeRead === "string") {
    print.error(`The causes file has a problem: ${causeRead}`);
    process.exit(2);
  }
  const fixedCopies = causeRead === undefined ? parsed.fixed : withCauses(parsed.fixed, causeRead);
  if (typeof fixedCopies === "string") {
    print.error(`The causes file has a problem: ${fixedCopies}`);
    process.exit(2);
  }
  if (parsed.spend === undefined) print.line("No spend entry is named. The front has no limit of cost.");
  else if (costLimit === undefined) print.line(`The configuration has no valid spend entry ${parsed.spend}. The front has no limit of cost.`);
  const scheduler = new HostScheduler(realClock, PLAN_PROVIDERS.length + 1);
  const client = createPlanClient({ transport: fetchTransport({ userAgent: USER_AGENT }), pace: { scheduler, now: () => Date.now() } });
  const offers: MeteredObservation[] = [];
  const reads: { readonly source: string; readonly offers: number; readonly notes: number; readonly problems: readonly string[] }[] = [];
  for (const provider of PLAN_PROVIDERS) {
    try {
      const result = await client.plans(provider);
      if (result.ok) {
        offers.push(...result.observations);
        reads.push({ source: provider.source, offers: result.observations.length, notes: result.notes.length, problems: [] });
      } else reads.push({ source: provider.source, offers: 0, notes: 0, problems: result.problems });
    } catch (error) {
      reads.push({ source: provider.source, offers: 0, notes: 0, problems: [errorMessage(error)] });
    }
  }
  // The Azure prices of the smallest sizes that meet the memory need, one read for each size. Only the Linux offers count.
  const azure = createAzureClient({ transport: fetchTransport({ userAgent: USER_AGENT }), pace: { scheduler, now: () => Date.now() } });
  const sizes = azureSizesFor(AZURE_VM_SIZE_TABLE, parsed.minMemoryMiB, parsed.azureSizes);
  if (sizes.length > 0) print.line(`The Azure sizes: ${sizes.join(", ")}.`);
  for (const size of sizes) {
    const source = `${AZURE_SOURCE} ${size}`;
    try {
      const result = await azure.prices({ serviceName: "Virtual Machines", priceType: "Consumption", armSkuName: size });
      if (result.ok) {
        const linux = result.observations.filter((observation) => !windowsOffer(observation));
        offers.push(...linux);
        reads.push({ source, offers: linux.length, notes: result.notes.length, problems: [] });
      } else reads.push({ source, offers: 0, notes: 0, problems: result.problems });
    } catch (error) {
      reads.push({ source, offers: 0, notes: 0, problems: [errorMessage(error)] });
    }
  }
  for (const read of reads) {
    const tail = read.problems.length === 0 ? `${countOf(read.offers, "offer")}, ${countOf(read.notes, "note")}` : `failed: ${read.problems.join(" ")}`;
    print.line(`The source ${read.source}: ${tail}.`);
  }
  const clouds = parsed.fixed.flatMap((copy) => (copy.kind === "cloud" ? [copy] : []));
  const providers = new Set([...offers.map((offer) => offer.offer.location.provider), ...clouds.map((copy) => copy.provider)]);
  // The regions of each provider: of its offers and of its fixed copies. A dashboard of Google measures each of them.
  const regionsOf = (provider: string): readonly string[] => [
    ...new Set([
      ...offers.flatMap((offer) => (offer.offer.location.provider === provider && offer.offer.location.region !== undefined ? [offer.offer.location.region] : [])),
      ...clouds.filter((copy) => copy.provider === provider).map((copy) => copy.region),
    ]),
  ];
  const measureTransport = fetchTransport({ userAgent: MEASURE_USER_AGENT });
  const measures: ChanceMeasure[] = [];
  const gaps: { readonly provider: string; readonly reason: string }[] = HISTORY_GAPS.filter((gap) => providers.has(gap.provider)).map((gap) => ({ ...gap }));
  const readAt = Date.now();
  for (const source of HISTORY_SOURCES.filter((each) => providers.has(each.provider))) {
    const outcome = await readPageHistory(source, { scheduler, now: () => Date.now() }, measureTransport);
    const measured = outcome.ok ? measureProvider(source, outcome.history, readAt, parsed.windowDays, regionsOf(source.provider)) : { ok: false as const, reason: outcome.problem };
    if (measured.ok) measures.push(...measured.measures);
    else gaps.push({ provider: source.provider, reason: measured.reason });
  }
  const known = new Set([...HISTORY_SOURCES, ...HISTORY_GAPS].map((each) => each.provider));
  for (const provider of [...providers].filter((each) => !known.has(each)).sort()) gaps.push({ provider, reason: "No status page history of this provider is known." });
  print.line(`The status page histories gave ${countOf(measures.length, "measured input")}. The other fragments and the hosts use the assumed inputs.`);
  // Each chance of the base that names a status page gets a measured input, with the same pace as the providers.
  const baseMeasure = baseRead === undefined ? undefined : await measureBase(baseRead, { scheduler, now: () => Date.now() }, measureTransport, readAt, parsed.windowDays);
  // Each chance of the base that names a channel gets a measured input from the calls in the site logs (AL-147).
  const callMeasure = baseMeasure === undefined ? undefined : measureBaseCalls(baseMeasure.base, (channel) => parsed.siteLogs.flatMap((log) => callsOrNone(log.path, channel).filter((call) => inLogWindow(call.time, log.window))), readAt);
  const base: PlacementBase | undefined = callMeasure?.base;
  if (base === undefined) print.line("No base is named. The front leaves out the needs that all copies share.");
  else {
    for (const line of [...(baseMeasure?.lines ?? []), ...(callMeasure?.lines ?? [])]) print.line(line);
    const open = baseAssumed(base);
    print.line(`The base has ${countOf(base.stack.parts.length, "part")} and ${countOf((base.chances ?? []).length, "chance input")}.`);
    print.line(`Shared needs with an assumed input: ${open.assumed.length === 0 ? "none" : open.assumed.join(", ")}.`);
    print.line(`Shared needs with no input, thus a chance of 1: ${open.missing.length === 0 ? "none" : open.missing.join(", ")}.`);
  }
  for (const log of parsed.siteLogs) {
    let site: ReturnType<typeof measureSite>;
    try {
      site = measureSite(log.site, readFetchTimes(log.path), readAt, FETCH_GAP_MS, log.window);
      const end = readLogEnd(log.path);
      const late = end === undefined ? 0 : (log.window.to ?? readAt) - end;
      if (late > FETCH_GAP_MS) print.line(`The log of the site ${log.site} ends ${String(Math.round(late / 60_000))} minutes before the end of its window. For a copy of a log, give the time of the copy as the end of the window (--log-window): else that time is a down time.`);
    } catch (error) {
      site = { ok: false, reason: `The log of the site ${log.site} has no good read: ${errorMessage(error)}` };
    }
    if (site.ok) {
      measures.push(site.measure);
      print.line(`The site ${log.site} has a measured input: ${site.measure.input.source}.`);
    } else print.line(`The site ${log.site} keeps the assumed input: ${site.reason}`);
  }
  const causeChances: Pick<PlacementChances, "causes" | "overrides"> = causeRead === undefined ? {} : { causes: causeRead.chances, overrides: [...(parsed.chances.overrides ?? []), ...causeRead.overrides] };
  const host = parsed.chances.host ?? ownHost(joint, parsed.hostOwn);
  const chances = withMeasures({ ...parsed.chances, host, ...causeChances, ...(joint === undefined ? {} : { joint }) }, measures);
  const fit = jointFit(chances);
  if (fit === undefined) print.line("No joint measure is named. The front counts the live copies as independent copies.");
  else print.line(`The common cause of the live copies works with the chance ${fit.common.works.toFixed(6)} (${fit.common.kind}). Each copy needs it.`);
  for (const gap of gaps) print.line(`The provider ${gap.provider} keeps the assumed inputs: ${gap.reason}`);
  if (offers.length === 0) {
    print.error("No source gave an offer. The script writes no front.");
    process.exitCode = 1;
  } else {
    const at = new Date();
    const today = at.toISOString().slice(0, 10);
    const build = placementLayer({ offers, needs: { minMemoryMiB: parsed.minMemoryMiB, terms: parsed.terms, currency: "USD" }, chances, copies: parsed.copies, fixed: fixedCopies, costLimit, base, causes: causeRead?.fresh ?? [] });
    if (causeRead === undefined) print.line("No causes file is named. The copies share only their providers, regions, sites and countries.");
    else print.line(`The causes file gives ${countOf(Object.values(causeRead.fixed).flat().length + causeRead.fresh.length, "shared cause")} of ${countOf(Object.keys(causeRead.chances).length, "kind")}.`);
    if (parsed.fixed.length > 0) print.line(`Fixed slots with no cost: ${countOf(parsed.fixed.length, "live copy", "live copies")}. The first level of the front with the cost 0 is no new copy.`);
    const measuredIds = new Set(measures.map((measure) => measure.input.id));
    const shared = build.layer.shared ?? [];
    const measuredShared = shared.filter((shared) => measuredIds.has(shared.id)).length;
    print.line(`The layer has ${countOf(shared.length, "shared fragment")}: ${String(measuredShared)} with a measured input, ${String(shared.length - measuredShared)} with an assumed input.`);
    print.line(`The host input is ${chances.host.kind} for each row.`);
    if (chances.country === undefined) print.line("No copy has a country fragment: the command has no --assume-country.");
    else print.line(`${countOf(build.unplaced.length, "copy or candidate", "copies or candidates")} with no known country ${build.unplaced.length === 1 ? "has" : "have"} no country fragment.`);
    const full = frontOf(build, chances, today, "The full front");
    const onlyMeasured = measuredBuild(build, chances);
    const measured = onlyMeasured === undefined ? null : frontOf(onlyMeasured, chances, today, "The front of measured inputs");
    if (measured === null) print.line("No candidate has measured inputs only. The file has no front of measured inputs.");
    const front = {
      format: FRONT_FORMAT,
      at: at.toISOString(),
      inputs: {
        needs: { minMemoryMiB: parsed.minMemoryMiB, terms: parsed.terms, currency: "USD" },
        copies: parsed.copies,
        fixed: parsed.fixed,
        base: base === undefined ? null : { part: base.part, copies: base.copies ?? [], chances: base.chances ?? [], ...baseAssumed(base) },
        windowDays: parsed.windowDays,
        chances,
        spend: parsed.spend ?? null,
        costLimit: costLimit ?? null,
      },
      reads,
      measures: measures.map(measureRecord),
      baseMeasures: (baseMeasure?.measures ?? []).map(measureRecord),
      gaps,
      offers: build.offers,
      skipped: build.skipped,
      unplaced: build.unplaced,
      host: chances.host.kind,
      ...full,
      measured,
    };
    const path = join(home, FRONT_FILE);
    await writeFileAtomic(path, `${JSON.stringify(front, null, 2)}\n`, { mode: 0o600 });
    print.line(`The front is in the file ${FRONT_FILE} of the private folder.`);
  }
}
