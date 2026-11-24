/**
 * This file gives the front of the placement of the copies from the live offers (AL-53, `placement.ts`). It reads the
 * plan list of each provider record of `@mark1russell7/market-sources`, and the incident history of the status page of
 * each provider. It reads no other source and opens no account.
 *
 * `node src/placement-plan.ts --min-memory-mib <n> --assume-provider <p> --assume-region <p> --assume-host <p> [--fixed <copy,copy>] [--assume-site <p>] [--site-log <site=file,site=file>] [--base <file>] [--joint <file>] [--copies <n>] [--spend <provider>] [--terms <kind,kind>] [--window-days <n>]`
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
 * - `--assume-site` is the assumed chance input of each site of a fixed copy. A fixed copy at a site needs it.
 * - `--site-log` names a copy of the runtime log of the live copy at each site, as `site=file` with commas between
 *   them. The gaps of its fetch events give a measured chance of the site (`measureSite` of `placement-chances.ts`).
 *   This input replaces `--assume-site` for that site.
 * - `--base` names a private JSON file with the function and the needs that all copies share (`readBase` of
 *   `placement.ts`). These needs limit the gain of each copy. The output names each of their inputs that is assumed or
 *   missing.
 * - `--joint` names a private JSON file with the joint measure of the live copies (`readJoint` of `placement.ts`), in the
 *   order of `--fixed`. The fit gives a common cause that each copy needs, thus a new copy is not an independent copy.
 * - `--copies` is the count of new copies. The default is 2.
 * - `--spend` names the spend entry of `config.json` that gives the limit of cost of a month (`monthlyUsd`). Without
 *   it, or without that entry, the front has no limit of cost.
 * - `--terms` gives the price terms that fit. The default is `on-demand`.
 *
 * It prints the front, and writes it to the file `placement-front.json` in the private folder with the mode 0o600.
 * The environment gives `ALERTS_HOME`, as for `main.ts`. The exit code is 0 for a front, 1 for a failed read and 2
 * for a wrong command.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MeteredObservation, PriceTerm } from "@mark1russell7/market";
import { createPlanClient, PLAN_PROVIDERS } from "@mark1russell7/market-sources";
import { countOf, errorMessage } from "@mark1russell7/text";
import { writeFileAtomic } from "@procedures/fs/files";
import { fetchTransport } from "polite-crawler/api";
import { HostScheduler, realClock } from "polite-crawler/politeness";
import { alertsHome, configPath } from "./config.ts";
import {
  DEFAULT_WINDOW_DAYS,
  HISTORY_GAPS,
  HISTORY_SOURCES,
  MEASURE_USER_AGENT,
  measureProvider,
  measureSite,
  readFetchTimes,
  readPageHistory,
  withMeasures,
  type ChanceMeasure,
} from "./placement-chances.ts";
import {
  assumedInputs,
  distinctRows,
  FRONT_FILE,
  FRONT_FORMAT,
  baseAssumed,
  frontLevels,
  measuredBuild,
  jointFit,
  readBase,
  readJoint,
  type PlacementBase,
  type FixedCopy,
  placementLayer,
  planCopies,
  spendLimitOf,
  type ChanceInput,
  type PlacementBuild,
  type PlacementChances,
} from "./placement.ts";

const USAGE =
  "The command is: node src/placement-plan.ts --min-memory-mib <n> --assume-provider <p> --assume-region <p> --assume-host <p> [--fixed <copy,copy>] [--assume-site <p>] [--site-log <site=file,site=file>] [--base <file>] [--joint <file>] [--copies <n>] [--spend <provider>] [--terms <kind,kind>] [--window-days <n>]";

/** The User-Agent of each request. It names no person and no project. */
const USER_AGENT = "alerts-placement";

/** The count of choices of each level of the front that the output shows. The file has each choice. */
const SHOWN = 3;

const TERM_KINDS: readonly PriceTerm["kind"][] = ["on-demand", "spot", "committed"];

interface Command {
  readonly minMemoryMiB: number;
  readonly chances: PlacementChances;
  readonly copies: number;
  readonly fixed: readonly FixedCopy[];
  readonly base: string | undefined;
  readonly joint: string | undefined;
  readonly siteLogs: readonly { readonly site: string; readonly path: string }[];
  readonly spend: string | undefined;
  readonly terms: readonly PriceTerm["kind"][];
  readonly windowDays: number;
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
  const known = new Set(["min-memory-mib", "assume-provider", "assume-region", "assume-host", "assume-site", "fixed", "site-log", "base", "joint", "copies", "spend", "terms", "window-days"]);
  const other = [...values.keys()].find((name) => !known.has(name));
  if (other !== undefined) return `The option --${other} is not known.`;
  const memory = Number(values.get("min-memory-mib"));
  if (!values.has("min-memory-mib") || !(memory >= 0)) return "The option --min-memory-mib needs a number of 0 or more.";
  const copies = Number(values.get("copies") ?? "2");
  if (!Number.isInteger(copies) || copies < 1) return "The option --copies needs a whole number of 1 or more.";
  const windowDays = Number(values.get("window-days") ?? String(DEFAULT_WINDOW_DAYS));
  if (!Number.isInteger(windowDays) || windowDays < 1) return "The option --window-days needs a whole number of 1 or more.";
  const assumed = (name: string): ChanceInput | string => {
    const text = values.get(`assume-${name}`);
    const works = Number(text);
    if (text === undefined || !(works >= 0 && works <= 1)) return `The option --assume-${name} needs a chance from 0 to 1.`;
    return { works, kind: "assumed", source: `the input parameter --assume-${name} of placement-plan.ts` };
  };
  const provider = assumed("provider");
  const region = assumed("region");
  const host = assumed("host");
  if (typeof provider === "string") return provider;
  if (typeof region === "string") return region;
  if (typeof host === "string") return host;
  const fixed: FixedCopy[] = [];
  for (const name of (values.get("fixed") ?? "").split(",").filter((each) => each !== "")) {
    const parts = name.split("/");
    if (parts.length === 1) fixed.push({ kind: "site", site: name });
    else if (parts.length === 2 && parts[0] !== "" && parts[1] !== "") fixed.push({ kind: "cloud", provider: parts[0]!, region: parts[1]! });
    else return `The fixed copy ${name} is not provider/region or a site.`;
  }
  const needsSite = fixed.some((copy) => copy.kind === "site");
  const site = values.has("assume-site") || needsSite ? assumed("site") : undefined;
  if (typeof site === "string") return site;
  const siteLogs: { site: string; path: string }[] = [];
  for (const item of (values.get("site-log") ?? "").split(",").filter((each) => each !== "")) {
    const cut = item.indexOf("=");
    if (cut < 1 || cut === item.length - 1) return `The site log ${item} is not site=file.`;
    siteLogs.push({ site: item.slice(0, cut), path: item.slice(cut + 1) });
  }
  const terms = (values.get("terms") ?? "on-demand").split(",");
  const bad = terms.find((term) => !TERM_KINDS.some((kind) => kind === term));
  if (bad !== undefined) return `The price term ${bad} is not on-demand, spot or committed.`;
  const chances: PlacementChances = { provider, region, host, ...(site === undefined ? {} : { site }) };
  return { minMemoryMiB: memory, chances, copies, fixed, base: values.get("base"), joint: values.get("joint"), siteLogs, spend: values.get("spend"), terms: terms as PriceTerm["kind"][], windowDays };
}

// The front of a build: its search, its levels and the assumed fragments of each row. It prints each level.
function frontOf(build: PlacementBuild, chances: PlacementChances, today: string, title: string) {
  const plan = planCopies(build, today);
  const rows = distinctRows(plan.front);
  const levels = frontLevels(rows);
  const fixed = new Set(build.fixed);
  const candidates = build.layer.slots.find((slot) => !fixed.has(slot.id))?.candidates.length ?? 0;
  const keysOf = (row: (typeof rows)[number]): string => Object.values(row.choice).filter((value): value is string => value !== null).join(" + ");
  console.log(`${title}: ${countOf(candidates, "candidate")} for each slot. The search is ${plan.method}. The front has ${countOf(rows.length, "choice")} in ${countOf(levels.length, "level")}.`);
  for (const level of levels) {
    const shown = level.rows.slice(0, SHOWN).map(keysOf).join(", ");
    const more = level.rows.length > SHOWN ? ` and ${String(level.rows.length - SHOWN)} more` : "";
    const assumed = level.rows.filter((row) => assumedInputs(build.layer, chances, row).length > 0).length;
    console.log(`- ${level.cost.toFixed(2)} USD a month, chance ${level.chance.toFixed(9)}, ${countOf(level.rows.length, "choice")} (${String(assumed)} with an assumed input): ${shown}${more}`);
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
  console.error(`${parsed}\n${USAGE}`);
  process.exitCode = 2;
} else {
  const home = alertsHome(process.env, process.cwd());
  const costLimit = parsed.spend === undefined ? undefined : spendLimitOf(await readConfig(configPath(process.env, process.cwd())), parsed.spend);
  const baseRead = parsed.base === undefined ? undefined : readBase(await readConfig(parsed.base));
  if (typeof baseRead === "string") {
    console.error(`The base file has a problem: ${baseRead}`);
    process.exit(2);
  }
  const base: PlacementBase | undefined = baseRead;
  const joint = parsed.joint === undefined ? undefined : readJoint(await readConfig(parsed.joint));
  if (typeof joint === "string") {
    console.error(`The joint file has a problem: ${joint}`);
    process.exit(2);
  }
  if (joint !== undefined && joint.works.length !== parsed.fixed.length) {
    console.error("The joint file needs one input for each copy of --fixed, in the same order.");
    process.exit(2);
  }
  if (base === undefined) console.log("No base is named. The front leaves out the needs that all copies share.");
  else {
    const open = baseAssumed(base);
    console.log(`The base has ${countOf(base.stack.parts.length, "part")} and ${countOf((base.chances ?? []).length, "chance input")}.`);
    console.log(`Shared needs with an assumed input: ${open.assumed.length === 0 ? "none" : open.assumed.join(", ")}.`);
    console.log(`Shared needs with no input, thus a chance of 1: ${open.missing.length === 0 ? "none" : open.missing.join(", ")}.`);
  }
  if (parsed.spend === undefined) console.log("No spend entry is named. The front has no limit of cost.");
  else if (costLimit === undefined) console.log(`The configuration has no valid spend entry ${parsed.spend}. The front has no limit of cost.`);
  const scheduler = new HostScheduler(realClock, PLAN_PROVIDERS.length);
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
  for (const read of reads) {
    const tail = read.problems.length === 0 ? `${countOf(read.offers, "offer")}, ${countOf(read.notes, "note")}` : `failed: ${read.problems.join(" ")}`;
    console.log(`The source ${read.source}: ${tail}.`);
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
  console.log(`The status page histories gave ${countOf(measures.length, "measured input")}. The other fragments and the hosts use the assumed inputs.`);
  for (const log of parsed.siteLogs) {
    let site: ReturnType<typeof measureSite>;
    try {
      site = measureSite(log.site, readFetchTimes(log.path), readAt);
    } catch (error) {
      site = { ok: false, reason: `The log of the site ${log.site} has no good read: ${errorMessage(error)}` };
    }
    if (site.ok) {
      measures.push(site.measure);
      console.log(`The site ${log.site} has a measured input: ${site.measure.input.source}.`);
    } else console.log(`The site ${log.site} keeps the assumed input: ${site.reason}`);
  }
  const chances = withMeasures({ ...parsed.chances, ...(joint === undefined ? {} : { joint }) }, measures);
  const fit = jointFit(chances);
  if (fit === undefined) console.log("No joint measure is named. The front counts the live copies as independent copies.");
  else console.log(`The common cause of the live copies works with the chance ${fit.common.works.toFixed(6)} (${fit.common.kind}). Each copy needs it.`);
  for (const gap of gaps) console.log(`The provider ${gap.provider} keeps the assumed inputs: ${gap.reason}`);
  if (offers.length === 0) {
    console.error("No source gave an offer. The script writes no front.");
    process.exitCode = 1;
  } else {
    const at = new Date();
    const today = at.toISOString().slice(0, 10);
    const build = placementLayer({ offers, needs: { minMemoryMiB: parsed.minMemoryMiB, terms: parsed.terms, currency: "USD" }, chances, copies: parsed.copies, fixed: parsed.fixed, costLimit, base });
    if (parsed.fixed.length > 0) console.log(`Fixed slots with no cost: ${countOf(parsed.fixed.length, "live copy", "live copies")}. The first level of the front with the cost 0 is no new copy.`);
    const measuredIds = new Set(measures.map((measure) => measure.input.id));
    const shared = build.layer.shared ?? [];
    const measuredShared = shared.filter((shared) => measuredIds.has(shared.id)).length;
    console.log(`The layer has ${countOf(shared.length, "shared fragment")}: ${String(measuredShared)} with a measured input, ${String(shared.length - measuredShared)} with an assumed input.`);
    console.log(`The host input is ${chances.host.kind} for each row.`);
    const full = frontOf(build, chances, today, "The full front");
    const onlyMeasured = measuredBuild(build, chances);
    const measured = onlyMeasured === undefined ? null : frontOf(onlyMeasured, chances, today, "The front of measured inputs");
    if (measured === null) console.log("No candidate has measured inputs only. The file has no front of measured inputs.");
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
      measures: measures.map((measure) => ({ id: measure.input.id, works: measure.input.works, window: { from: new Date(measure.window.from).toISOString(), to: new Date(measure.window.to).toISOString() }, down: measure.down })),
      gaps,
      offers: build.offers,
      skipped: build.skipped,
      host: chances.host.kind,
      ...full,
      measured,
    };
    const path = join(home, FRONT_FILE);
    await writeFileAtomic(path, `${JSON.stringify(front, null, 2)}\n`, { mode: 0o600 });
    console.log(`The front is in the file ${FRONT_FILE} of the private folder.`);
  }
}
