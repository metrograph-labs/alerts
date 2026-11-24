/**
 * This file gives the front of the placement of the copies from the live offers (AL-53, `placement.ts`). It reads the
 * plan list of each provider record of `@mark1russell7/market-sources`, and the incident history of the status page of
 * each provider. It reads no other source and opens no account.
 *
 * `node src/placement-plan.ts --min-memory-mib <n> --assume-provider <p> --assume-region <p> --assume-host <p> [--copies <n>] [--spend <provider>] [--terms <kind,kind>] [--window-days <n>]`
 *
 * - `--min-memory-mib` is the least memory of a host of a copy, in MiB.
 * - The three `--assume-*` values are assumed chance inputs, from 0 to 1, for each provider, region and host. The script
 *   reads the incident history of the status page of each provider of `HISTORY_SOURCES` (`placement-chances.ts`). It
 *   gives a measured input to each provider and region with a history. Only the other fragments and the hosts get the
 *   assumed inputs. The output marks each input as measured or assumed.
 * - Each row of the front names its shared fragments with an assumed input. A second front, `measured`, uses only the
 *   candidates with measured inputs.
 * - `--window-days` is the length of the window of the history, in days. The default is `DEFAULT_WINDOW_DAYS` (365).
 * - `--copies` is the count of copies. The default is 2.
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
import { DEFAULT_WINDOW_DAYS, HISTORY_GAPS, HISTORY_SOURCES, MEASURE_USER_AGENT, measureProvider, readPageHistory, withMeasures, type ChanceMeasure } from "./placement-chances.ts";
import {
  assumedInputs,
  distinctRows,
  FRONT_FILE,
  FRONT_FORMAT,
  frontLevels,
  measuredBuild,
  placementLayer,
  planCopies,
  spendLimitOf,
  type ChanceInput,
  type PlacementBuild,
  type PlacementChances,
} from "./placement.ts";

const USAGE =
  "The command is: node src/placement-plan.ts --min-memory-mib <n> --assume-provider <p> --assume-region <p> --assume-host <p> [--copies <n>] [--spend <provider>] [--terms <kind,kind>] [--window-days <n>]";

/** The User-Agent of each request. It names no person and no project. */
const USER_AGENT = "alerts-placement";

/** The count of choices of each level of the front that the output shows. The file has each choice. */
const SHOWN = 3;

const TERM_KINDS: readonly PriceTerm["kind"][] = ["on-demand", "spot", "committed"];

interface Command {
  readonly minMemoryMiB: number;
  readonly chances: PlacementChances;
  readonly copies: number;
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
  const known = new Set(["min-memory-mib", "assume-provider", "assume-region", "assume-host", "copies", "spend", "terms", "window-days"]);
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
  const terms = (values.get("terms") ?? "on-demand").split(",");
  const bad = terms.find((term) => !TERM_KINDS.some((kind) => kind === term));
  if (bad !== undefined) return `The price term ${bad} is not on-demand, spot or committed.`;
  return { minMemoryMiB: memory, chances: { provider, region, host }, copies, spend: values.get("spend"), terms: terms as PriceTerm["kind"][], windowDays };
}

// The front of a build: its search, its levels and the assumed fragments of each row. It prints each level.
function frontOf(build: PlacementBuild, chances: PlacementChances, today: string, title: string) {
  const plan = planCopies(build, today);
  const rows = distinctRows(plan.front);
  const levels = frontLevels(rows);
  const candidates = build.layer.slots[0]?.candidates.length ?? 0;
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
  const providers = new Set(offers.map((offer) => offer.offer.location.provider));
  const measureTransport = fetchTransport({ userAgent: MEASURE_USER_AGENT });
  const measures: ChanceMeasure[] = [];
  const gaps: { readonly provider: string; readonly reason: string }[] = HISTORY_GAPS.filter((gap) => providers.has(gap.provider)).map((gap) => ({ ...gap }));
  const readAt = Date.now();
  for (const source of HISTORY_SOURCES.filter((each) => providers.has(each.provider))) {
    const outcome = await readPageHistory(source, { scheduler, now: () => Date.now() }, measureTransport);
    const measured = outcome.ok ? measureProvider(source, outcome.history, readAt, parsed.windowDays) : { ok: false as const, reason: outcome.problem };
    if (measured.ok) measures.push(...measured.measures);
    else gaps.push({ provider: source.provider, reason: measured.reason });
  }
  const known = new Set([...HISTORY_SOURCES, ...HISTORY_GAPS].map((each) => each.provider));
  for (const provider of [...providers].filter((each) => !known.has(each)).sort()) gaps.push({ provider, reason: "No status page history of this provider is known." });
  const chances = withMeasures(parsed.chances, measures);
  console.log(`The status page histories gave ${countOf(measures.length, "measured input")}. The other fragments and the hosts use the assumed inputs.`);
  for (const gap of gaps) console.log(`The provider ${gap.provider} keeps the assumed inputs: ${gap.reason}`);
  if (offers.length === 0) {
    console.error("No source gave an offer. The script writes no front.");
    process.exitCode = 1;
  } else {
    const at = new Date();
    const today = at.toISOString().slice(0, 10);
    const build = placementLayer({ offers, needs: { minMemoryMiB: parsed.minMemoryMiB, terms: parsed.terms, currency: "USD" }, chances, copies: parsed.copies, costLimit });
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
      inputs: { needs: { minMemoryMiB: parsed.minMemoryMiB, terms: parsed.terms, currency: "USD" }, copies: parsed.copies, windowDays: parsed.windowDays, chances, spend: parsed.spend ?? null, costLimit: costLimit ?? null },
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
